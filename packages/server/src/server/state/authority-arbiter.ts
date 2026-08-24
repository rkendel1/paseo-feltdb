/**
 * Authority Arbiter - Durable Authority Arbitration (Phase 4.4)
 *
 * Implements deterministic arbitration when multiple handoffs compete for authority
 * over the same resource. Decisions are recorded in FeltDB and survive restart.
 *
 * Critical invariant: At any point in durable state, exactly ONE deterministic
 * answer exists to "who has authority?" — not memory state, not last-write-wins,
 * but explicit durable decisions.
 */

import type { Logger } from "pino";
import type { Repositories } from "./feltdb/repositories.js";
import type { Handoff, AuthorityDecision } from "./feltdb/schema.js";

export interface AuthorityArbiterOptions {
  repos: Repositories;
  logger: Logger;
}

/**
 * Result of attempting to accept a handoff.
 * Either success or explicit rejection with reasoning.
 */
export interface AcceptanceResult {
  success: boolean;
  handoffId: string;
  decision?: AuthorityDecision;
  rejection?: {
    reason: string;
    winnerId?: string;
  };
}

/**
 * Authority Arbiter - Durable arbitration of competing handoff authorities.
 *
 * Phase 4.4.1: Authority conflict model + invariants
 * Phase 4.4.2: Implement atomic acceptance logic
 */
export class AuthorityArbiter {
  private readonly repos: Repositories;
  private readonly logger: Logger;

  constructor(options: AuthorityArbiterOptions) {
    this.repos = options.repos;
    this.logger = options.logger.child({ module: "authority-arbiter" });
  }

  /**
   * Atomically attempt to accept a handoff.
   *
   * Checks for competing handoffs on the same resource and enforces
   * deterministic precedence rules. Creates a durable AuthorityDecision.
   *
   * Phase 4.4.2 Deliverable: Atomic acceptance implementation
   *
   * Flow:
   * 1. Fetch the handoff to be accepted
   * 2. Validate it's in pending state
   * 3. Check for existing authority on the subject (task/workspace/project)
   * 4. Apply precedence rules:
   *    - If no existing authority: accept and record "first_accepted" decision
   *    - If explicit supersession: revoke existing, accept new with "explicit_supersession"
   *    - If existing authority active: reject with "existing_authority" decision
   * 5. Create immutable AuthorityDecision in FeltDB
   * 6. If accepted: update handoff status to "accepted"
   * 7. If rejected: keep handoff in "pending" (or optionally "rejected")
   *
   * @param handoffId - The handoff to accept
   * @returns AcceptanceResult with success flag and durable decision
   * @throws Error only for unrecoverable problems (not found, etc.)
   */
  async atomicAccept(handoffId: string): Promise<AcceptanceResult> {
    // 1. Fetch handoff to accept
    const handoff = await this.repos.handoffs.getById(handoffId);
    if (!handoff) {
      this.logger.error({ handoffId }, "Cannot accept: Handoff not found");
      throw new Error(`Handoff ${handoffId} not found`);
    }

    // 2. Handle already-accepted case (reject: authority already held)
    if (handoff.status === "accepted") {
      // Handoff already accepted - fetch current decision
      const subjectType = handoff.taskId ? ("task" as const) :
                          handoff.workspaceId ? ("workspace" as const) :
                          ("project" as const);
      const subjectId = handoff.taskId || handoff.workspaceId || handoff.projectId;

      const decision = await this.repos.authorityDecisions.getBySubject(
        subjectType,
        subjectId
      );

      // Duplicate acceptance is rejected: authority already held (by this or another handoff)
      this.logger.debug(
        { handoffId, currentWinner: decision?.winnerId },
        "Handoff already accepted: duplicate acceptance rejected"
      );
      return {
        success: false,
        handoffId,
        decision: decision || undefined,
        rejection: {
          reason: "existing_authority",
          winnerId: decision?.winnerId,
        },
      };
    }

    // 3. Validate pending state
    if (handoff.status !== "pending") {
      this.logger.warn(
        { handoffId, status: handoff.status },
        "Cannot accept: Handoff not in pending state"
      );
      return {
        success: false,
        handoffId,
        rejection: {
          reason: "invalid_state",
        },
      };
    }

    // 3. Determine subject (task is most specific, then workspace, then project)
    const subjectType = handoff.taskId ? ("task" as const) :
                        handoff.workspaceId ? ("workspace" as const) :
                        ("project" as const);
    const subjectId = handoff.taskId || handoff.workspaceId || handoff.projectId;

    this.logger.debug(
      { handoffId, subjectType, subjectId },
      "Checking for competing authority"
    );

    // 4. Check for existing authority on this subject
    const existingDecision = await this.repos.authorityDecisions.getBySubject(
      subjectType,
      subjectId
    );

    if (existingDecision && existingDecision.winnerId) {
      const existingWinner = await this.repos.handoffs.getById(
        existingDecision.winnerId
      );
      const isExistingActive =
        existingWinner && ["accepted", "in_progress"].includes(existingWinner.status);

      if (isExistingActive) {
        // Existing active authority exists - check for explicit supersession
        if (handoff.metadata?.supersedes === existingDecision.winnerId) {
          // Explicit supersession: revoke existing, accept new
          this.logger.info(
            { handoffId, existingId: existingDecision.winnerId },
            "Explicit supersession: accepting new handoff, revoking existing"
          );

          const newDecision = await this.repos.authorityDecisions.create({
            subjectType,
            subjectId,
            competingHandoffIds: [existingDecision.winnerId, handoffId],
            winnerId: handoffId,
            loserIds: [existingDecision.winnerId],
            arbitrationReason: "explicit_supersession",
            decidedAt: new Date().toISOString(),
            decidedBy: "system",
            version: 1,
          });

          // Revoke existing handoff
          if (existingWinner) {
            await this.repos.handoffs.update(existingWinner.id, {
              status: "revoked",
            });
            this.logger.info(
              { handoffId: existingWinner.id },
              "Existing handoff revoked"
            );
          }

          // Try to atomically accept new handoff
          // If it fails (conditional update), another concurrent request beat us
          try {
            await this.repos.handoffs.accept(handoffId);
            this.logger.info({ handoffId }, "Handoff accepted (supersession)");

            return {
              success: true,
              handoffId,
              decision: newDecision,
            };
          } catch (err) {
            // Conditional update failed - another handoff already won
            // Revert revocation of existing handoff since supersession failed
            if (existingWinner) {
              await this.repos.handoffs.update(existingWinner.id, {
                status: "accepted",
              });
              this.logger.warn(
                { handoffId: existingWinner.id },
                "Revocation reverted: supersession lost race"
              );
            }

            // Record rejection decision
            const rejectionDecision = await this.repos.authorityDecisions.create({
              subjectType,
              subjectId,
              competingHandoffIds: [existingDecision.winnerId, handoffId],
              winnerId: existingDecision.winnerId,
              loserIds: [handoffId],
              arbitrationReason: "existing_authority",
              decidedAt: new Date().toISOString(),
              decidedBy: "system",
              version: 1,
            });

            return {
              success: false,
              handoffId,
              decision: rejectionDecision,
              rejection: {
                reason: "existing_authority",
                winnerId: existingDecision.winnerId,
              },
            };
          }
        } else {
          // No supersession: existing authority wins
          this.logger.warn(
            { handoffId, existingId: existingDecision.winnerId },
            "Existing authority active: rejection"
          );

          const rejectionDecision = await this.repos.authorityDecisions.create({
            subjectType,
            subjectId,
            competingHandoffIds: [existingDecision.winnerId, handoffId],
            winnerId: existingDecision.winnerId,
            loserIds: [handoffId],
            arbitrationReason: "existing_authority",
            decidedAt: new Date().toISOString(),
            decidedBy: "system",
            version: 1,
          });

          return {
            success: false,
            handoffId,
            decision: rejectionDecision,
            rejection: {
              reason: "existing_authority",
              winnerId: existingDecision.winnerId,
            },
          };
        }
      }
    }

    // 5. No competing authority: this handoff is first
    // Try to atomically accept via conditional update
    // If it fails, another concurrent request beat us - record rejection
    try {
      await this.repos.handoffs.accept(handoffId);

      const decision = await this.repos.authorityDecisions.create({
        subjectType,
        subjectId,
        competingHandoffIds: [handoffId],
        winnerId: handoffId,
        loserIds: [],
        arbitrationReason: "first_accepted",
        decidedAt: new Date().toISOString(),
        decidedBy: "system",
        version: 1,
      });

      this.logger.info({ handoffId }, "Handoff accepted (first_accepted)");

      return {
        success: true,
        handoffId,
        decision,
      };
    } catch (err) {
      // Conditional update failed: another handoff already accepted
      // Fetch the new authority and record rejection
      const newAuthority = await this.repos.authorityDecisions.getBySubject(
        subjectType,
        subjectId
      );

      this.logger.warn(
        { handoffId, winnerId: newAuthority?.winnerId },
        "Handoff acceptance failed: lost race to concurrent handoff"
      );

      const rejectionDecision = await this.repos.authorityDecisions.create({
        subjectType,
        subjectId,
        competingHandoffIds: [handoffId, newAuthority?.winnerId || "unknown"].filter(Boolean),
        winnerId: newAuthority?.winnerId || handoffId,
        loserIds: [handoffId],
        arbitrationReason: "existing_authority",
        decidedAt: new Date().toISOString(),
        decidedBy: "system",
        version: 1,
      });

      return {
        success: false,
        handoffId,
        decision: rejectionDecision,
        rejection: {
          reason: "existing_authority",
          winnerId: newAuthority?.winnerId,
        },
      };
    }
  }

  /**
   * Get the current authority holder for a subject.
   *
   * Reconstructs authority from FeltDB, ensuring deterministic state
   * regardless of in-memory cache. Used by AuthorityGuard to validate
   * agent permissions.
   *
   * @param subjectType - "task", "workspace", or "project"
   * @param subjectId - The specific resource ID
   * @returns Active handoff holding authority, or null if no authority
   */
  async getCurrentAuthority(
    subjectType: "task" | "workspace" | "project",
    subjectId: string
  ): Promise<Handoff | null> {
    const decision = await this.repos.authorityDecisions.getBySubject(
      subjectType,
      subjectId
    );

    if (!decision || !decision.winnerId) {
      return null;
    }

    const handoff = await this.repos.handoffs.getById(decision.winnerId);
    if (!handoff) {
      this.logger.warn(
        { handoffId: decision.winnerId, subjectType, subjectId },
        "Decision references missing handoff (data corruption)"
      );
      return null;
    }

    // Only "accepted" or "in_progress" handoffs hold authority
    if (!["accepted", "in_progress"].includes(handoff.status)) {
      return null;
    }

    return handoff;
  }

  /**
   * Query all decisions for a handoff.
   *
   * Returns all arbitration decisions where this handoff competed,
   * won, or lost. Useful for debugging and audit trails.
   */
  async getDecisionsForHandoff(handoffId: string): Promise<AuthorityDecision[]> {
    return await this.repos.authorityDecisions.listByHandoff(handoffId);
  }
}

export function createAuthorityArbiter(options: AuthorityArbiterOptions): AuthorityArbiter {
  return new AuthorityArbiter(options);
}

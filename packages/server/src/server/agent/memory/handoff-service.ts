/**
 * HandoffService - Durable agent-to-agent work transfer
 *
 * Phase 4: Enables Agent A to create durable handoffs to Agent B without
 * directly invoking another agent. The handoff captures context, observations,
 * and decisions. The daemon decides later whether Agent B runs immediately,
 * queues it, or requires approval.
 *
 * Key properties:
 * - Idempotent: createHandoff(requestId) always returns same logical handoff
 * - Durable: survives daemon restart
 * - Authorization: respects workspace/project boundaries
 * - Fire-and-forget: doesn't block agent execution
 */

import type { Logger } from "pino";
import type { PaseoState } from "../../state/paseo-state.js";
import type { Handoff } from "../../state/feltdb/schema.js";
import { createAuthorityGuard } from "../../state/handoff-authority-guard.js";
import { createAuthorityArbiter } from "../../state/authority-arbiter.js";

export interface HandoffServiceOptions {
  paseoState: PaseoState;
  logger: Logger;
  agentId: string;
  workspaceId: string;
  projectId: string;
}

export interface CreateHandoffInput {
  taskId?: string;
  targetAgentId?: string; // Optional: if known
  requestedAction: string; // What should the target agent do?
  summary: string; // What did Agent A learn/discover?
  unresolvedQuestions?: string[]; // Questions for Agent B
}

export class HandoffService {
  private paseoState: PaseoState;
  private logger: Logger;
  private agentId: string;
  private workspaceId: string;
  private projectId: string;
  private authorityGuard: ReturnType<typeof createAuthorityGuard>;
  private arbiter: ReturnType<typeof createAuthorityArbiter>;

  constructor(options: HandoffServiceOptions) {
    this.paseoState = options.paseoState;
    this.logger = options.logger;
    this.agentId = options.agentId;
    this.workspaceId = options.workspaceId;
    this.projectId = options.projectId;
    this.authorityGuard = createAuthorityGuard(options.paseoState, options.logger);
    this.arbiter = createAuthorityArbiter({
      repos: options.paseoState.repos,
      logger: options.logger,
    });
  }

  /**
   * Create a handoff from this agent to another.
   * Idempotent via requestId: repeated calls return the same logical handoff.
   * Fire-and-forget: never blocks agent execution.
   */
  async createHandoff(
    requestId: string,
    input: CreateHandoffInput,
    sourceRunId: string
  ): Promise<Handoff | null> {
    try {
      const handoff = await this.paseoState.handoffs?.createIdempotent(
        requestId,
        {
          projectId: this.projectId,
          workspaceId: this.workspaceId,
          taskId: input.taskId,
          sourceAgentId: this.agentId,
          sourceRunId,
          targetAgentId: input.targetAgentId,
          targetRunId: null,
          requestedAction: input.requestedAction,
          summary: input.summary,
          unresolvedQuestions: input.unresolvedQuestions,
          status: "pending",
        }
      );

      if (handoff) {
        this.logger.debug(
          {
            handoffId: handoff.id,
            taskId: input.taskId,
            targetAgent: input.targetAgentId,
          },
          `Handoff created: Agent ${this.agentId} → ${input.targetAgentId || "unassigned"}`
        );
      }

      return handoff || null;
    } catch (err) {
      this.logger.debug(
        { err: err instanceof Error ? err.message : String(err) },
        `Failed to create handoff`
      );
      // Return null on failure, don't throw - never block agent execution
      return null;
    }
  }

  /**
   * Retrieve a handoff by its ID.
   */
  async getHandoff(handoffId: string): Promise<Handoff | null> {
    try {
      return await this.paseoState.handoffs?.getById(handoffId) || null;
    } catch (err) {
      this.logger.debug(
        { err: err instanceof Error ? err.message : String(err) },
        `Failed to retrieve handoff`
      );
      return null;
    }
  }

  /**
   * Retrieve a handoff by its request ID.
   */
  async getHandoffByRequestId(requestId: string): Promise<Handoff | null> {
    try {
      return await this.paseoState.handoffs?.getByRequestId(requestId) || null;
    } catch (err) {
      this.logger.debug(
        { err: err instanceof Error ? err.message : String(err) },
        `Failed to retrieve handoff by request ID`
      );
      return null;
    }
  }

  /**
   * Accept a handoff (called by target agent).
   * Phase 4.4.2: Acceptance now goes through AuthorityArbiter.atomicAccept()
   *
   * This is the ONLY acceptance path. All competing handoffs are arbitrated
   * by the durable authority system, which records decisions and survives restart.
   *
   * Returns:
   * - null if acceptance fails (arbitration rejected, already accepted, etc.)
   * - Handoff if acceptance succeeds
   */
  async acceptHandoff(
    handoffId: string
  ): Promise<Handoff | null> {
    try {
      // AUTHORITY CHECK: Verify agent has authority to accept handoff
      await this.authorityGuard.authorize({
        agentId: this.agentId,
        operation: "update",
        entityType: "handoff",
        entityId: handoffId,
        workspaceId: this.workspaceId,
        projectId: this.projectId,
        context: { status: "accepted" },
      });

      // Phase 4.4.2: Use AuthorityArbiter.atomicAccept() as SOLE acceptance path
      // This ensures all competing handoffs go through deterministic arbitration
      const result = await this.arbiter.atomicAccept(handoffId);

      if (!result.success) {
        // Acceptance rejected by arbiter (competing handoff has authority)
        this.logger.debug(
          {
            handoffId,
            rejection: result.rejection?.reason,
            winnerId: result.rejection?.winnerId,
          },
          "Handoff acceptance rejected by authority arbiter"
        );
        return null;
      }

      // Acceptance succeeded - fetch and return the handoff
      const handoff = await this.paseoState.handoffs?.getById(handoffId) || null;
      if (handoff) {
        this.logger.debug(
          {
            handoffId,
            status: handoff.status,
            decision: result.decision?.arbitrationReason,
          },
          "Handoff accepted via authority arbiter"
        );
      }
      return handoff;
    } catch (err) {
      this.logger.debug(
        { err: err instanceof Error ? err.message : String(err) },
        `Failed to accept handoff`
      );
      return null;
    }
  }

  /**
   * Reject a handoff (called by target agent).
   * CONTROL-PLANE EXCEPTION: Delegated agent can reject their own handoff.
   */
  async rejectHandoff(
    handoffId: string,
    reason: string
  ): Promise<Handoff | null> {
    try {
      // AUTHORITY CHECK: Verify agent has authority to reject handoff
      await this.authorityGuard.authorize({
        agentId: this.agentId,
        operation: "update",
        entityType: "handoff",
        entityId: handoffId,
        workspaceId: this.workspaceId,
        projectId: this.projectId,
        context: { status: "rejected" },
      });

      return (
        (await this.paseoState.handoffs?.reject(handoffId, reason)) || null
      );
    } catch (err) {
      this.logger.debug(
        { err: err instanceof Error ? err.message : String(err) },
        `Failed to reject handoff`
      );
      return null;
    }
  }

  /**
   * Complete a handoff (called by target agent after execution).
   * CONTROL-PLANE EXCEPTION: Delegated agent can complete their own handoff.
   */
  async completeHandoff(
    handoffId: string,
    targetRunId: string
  ): Promise<Handoff | null> {
    try {
      // AUTHORITY CHECK: Verify agent has authority to complete handoff
      // This is a control-plane exception: delegated agents can complete their own handoff
      await this.authorityGuard.authorize({
        agentId: this.agentId,
        operation: "update",
        entityType: "handoff",
        entityId: handoffId,
        workspaceId: this.workspaceId,
        projectId: this.projectId,
        context: { status: "completed" },
      });

      return (
        (await this.paseoState.handoffs?.complete(
          handoffId,
          targetRunId
        )) || null
      );
    } catch (err) {
      this.logger.debug(
        { err: err instanceof Error ? err.message : String(err) },
        `Failed to complete handoff`
      );
      return null;
    }
  }

  /**
   * Fail a handoff (called by target agent if execution fails).
   * CONTROL-PLANE EXCEPTION: Delegated agent can fail their own handoff.
   */
  async failHandoff(
    handoffId: string,
    reason: string
  ): Promise<Handoff | null> {
    try {
      // AUTHORITY CHECK: Verify agent has authority to fail handoff
      // This is a control-plane exception: delegated agents can fail their own handoff
      await this.authorityGuard.authorize({
        agentId: this.agentId,
        operation: "update",
        entityType: "handoff",
        entityId: handoffId,
        workspaceId: this.workspaceId,
        projectId: this.projectId,
        context: { status: "failed" },
      });

      return (
        (await this.paseoState.handoffs?.fail(handoffId, reason)) || null
      );
    } catch (err) {
      this.logger.debug(
        { err: err instanceof Error ? err.message : String(err) },
        `Failed to mark handoff as failed`
      );
      return null;
    }
  }

  /**
   * List handoffs sent by this agent.
   */
  async listOutgoingHandoffs(): Promise<Handoff[]> {
    try {
      return await this.paseoState.handoffs?.listBySourceAgent(this.agentId) ||
        [];
    } catch (err) {
      this.logger.debug(
        { err: err instanceof Error ? err.message : String(err) },
        `Failed to list outgoing handoffs`
      );
      return [];
    }
  }

  /**
   * List handoffs sent to this agent.
   */
  async listIncomingHandoffs(): Promise<Handoff[]> {
    try {
      return await this.paseoState.handoffs?.listByTargetAgent(this.agentId) ||
        [];
    } catch (err) {
      this.logger.debug(
        { err: err instanceof Error ? err.message : String(err) },
        `Failed to list incoming handoffs`
      );
      return [];
    }
  }
}

export function createHandoffService(
  options: HandoffServiceOptions
): HandoffService {
  return new HandoffService(options);
}

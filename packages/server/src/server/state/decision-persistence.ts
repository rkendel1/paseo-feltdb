/**
 * DecisionPersistence - Durable Explicit Decisions
 *
 * Phase 3.5.3: Persist explicitly recorded decisions to FeltDB.
 *
 * Key principle: A decision exists only because someone explicitly recorded it.
 * We never infer decisions from model output.
 *
 * Design principles:
 * - Explicit lifecycle: proposed → approved/rejected/superseded
 * - Complete provenance (Project → Repository → Workspace → Agent → Run)
 * - User approval tracking (approvedBy, approvedAt)
 * - Non-blocking persistence
 * - Visible failure handling
 */

import type { Logger } from "pino";
import type { PaseoState } from "./paseo-state.js";
import { createAuthorityGuard } from "./handoff-authority-guard.js";

export interface RecordDecisionInput {
  content: string;
  rationale?: string;
}

export interface DecisionPersistenceOptions {
  paseoState: PaseoState;
  logger: Logger;
}

/**
 * DecisionPersistence records explicitly made decisions to durable state.
 */
export class DecisionPersistence {
  private readonly paseoState: PaseoState;
  private readonly logger: Logger;
  private readonly authorityGuard: ReturnType<typeof createAuthorityGuard>;

  constructor(options: DecisionPersistenceOptions) {
    this.paseoState = options.paseoState;
    this.logger = options.logger.child({ module: "decision-persistence" });
    this.authorityGuard = createAuthorityGuard(options.paseoState, this.logger);
  }

  /**
   * Record an explicit decision made by an agent or user.
   *
   * The decision starts in "proposed" state. User approval transitions it
   * to "approved". This ensures model output cannot auto-approve decisions.
   */
  async recordAgentDecision(
    agentId: string,
    runId: string,
    input: RecordDecisionInput,
  ): Promise<string> {
    try {
      // Fetch the Run to get complete graph context
      const run = await this.paseoState.runs.getById(runId);
      if (!run) {
        this.logger.warn(
          { agentId, runId },
          "Cannot record decision: Run not found",
        );
        throw new Error(`Run ${runId} not found`);
      }

      // Fetch the Agent to get workspace context
      const agent = await this.paseoState.repos.agents.getById(agentId);
      if (!agent) {
        this.logger.warn(
          { agentId, runId },
          "Cannot record decision: Agent not found",
        );
        throw new Error(`Agent ${agentId} not found`);
      }

      // Fetch the Workspace to get repository context
      const workspace = await this.paseoState.workspaces.getById(agent.workspaceId);
      if (!workspace) {
        this.logger.warn(
          { agentId, workspaceId: agent.workspaceId, runId },
          "Cannot record decision: Workspace not found",
        );
        throw new Error(`Workspace ${agent.workspaceId} not found`);
      }

      // AUTHORITY CHECK: Verify agent has authority to create decision
      await this.authorityGuard.authorize({
        agentId,
        operation: "create",
        entityType: "decision",
        entityId: `decision-${runId}`,
        taskId: run.taskId,
        workspaceId: workspace.id,
        projectId: run.projectId,
        runId,
        context: { status: "proposed" },
      });

      // Create the decision with complete provenance
      const decision = await this.paseoState.decisions.create({
        projectId: run.projectId,
        repositoryId: workspace.repositoryId,
        workspaceId: workspace.id,
        runId: run.id,
        authorType: "agent",
        authorId: agentId,
        content: input.content,
        rationale: input.rationale,
        status: "proposed", // Explicit lifecycle: never auto-approve
        metadata: {
          agentProvider: agent.provider,
          recordedAt: new Date().toISOString(),
        },
      });

      this.logger.info(
        {
          decisionId: decision.id,
          agentId,
          runId,
          projectId: run.projectId,
        },
        "Agent decision recorded (proposed, authorized)",
      );

      return decision.id;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.logger.error(
        { agentId, runId, err: error },
        `Failed to record agent decision: ${errorMsg}`,
      );
      throw error;
    }
  }

  /**
   * Record a user decision (approval of an agent's proposal).
   */
  async approveDecision(
    decisionId: string,
    userId: string,
  ): Promise<void> {
    try {
      const decision = await this.paseoState.decisions.getById(decisionId);
      if (!decision) {
        this.logger.warn(
          { decisionId },
          "Cannot approve decision: Decision not found",
        );
        throw new Error(`Decision ${decisionId} not found`);
      }

      if (decision.status !== "proposed") {
        this.logger.warn(
          { decisionId, currentStatus: decision.status },
          "Cannot approve decision: Only proposed decisions can be approved",
        );
        throw new Error(
          `Cannot approve decision in ${decision.status} state`,
        );
      }

      await this.paseoState.decisions.approve(decisionId, userId);

      this.logger.info(
        {
          decisionId,
          approvedBy: userId,
          projectId: decision.projectId,
        },
        "Decision approved by user",
      );
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.logger.error(
        { decisionId, userId, err: error },
        `Failed to approve decision: ${errorMsg}`,
      );
      throw error;
    }
  }

  /**
   * Reject a proposed decision.
   */
  async rejectDecision(decisionId: string): Promise<void> {
    try {
      const decision = await this.paseoState.decisions.getById(decisionId);
      if (!decision) {
        this.logger.warn(
          { decisionId },
          "Cannot reject decision: Decision not found",
        );
        throw new Error(`Decision ${decisionId} not found`);
      }

      if (decision.status !== "proposed") {
        this.logger.warn(
          { decisionId, currentStatus: decision.status },
          "Cannot reject decision: Only proposed decisions can be rejected",
        );
        throw new Error(
          `Cannot reject decision in ${decision.status} state`,
        );
      }

      await this.paseoState.decisions.reject(decisionId);

      this.logger.info(
        { decisionId, projectId: decision.projectId },
        "Decision rejected",
      );
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.logger.error(
        { decisionId, err: error },
        `Failed to reject decision: ${errorMsg}`,
      );
      throw error;
    }
  }
}

export function createDecisionPersistence(
  options: DecisionPersistenceOptions,
): DecisionPersistence {
  return new DecisionPersistence(options);
}

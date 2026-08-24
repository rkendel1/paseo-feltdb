/**
 * ObservationPersistence - Durable Execution Observations + Authorization
 *
 * Phase 3.5.2: Convert ExecutionFeedbackEvent into durable FeltDB Observation
 * entities. Routes different event types to appropriate persistence paths:
 *
 * - tool.executed → Observation (type: discovery)
 * - timeline.message → Message (delegated to message persistence)
 * - run.terminal → Run (already handled)
 *
 * Phase 2 Addition: Authorization checks for observation mutations
 * - Agent can only update/delete observations in their project
 * - Validates agent.workspace.projectId === observation.projectId
 *
 * Design principles:
 * - Complete graph association (resolve Project/Repo/Workspace/Agent from Run)
 * - Safe deduplication (stable keys, not timestamps)
 * - Visible failure handling (don't silently fail)
 * - Non-blocking (enqueue, don't wait for persistence)
 * - Authorization at domain layer (not FeltDB, not provider)
 */

import { createHash } from "node:crypto";
import type { Logger } from "pino";
import type {
  ToolExecutedEvent,
  ExecutionFeedbackEvent,
} from "./execution-feedback-normalizer.js";
import type { PaseoState } from "./paseo-state.js";
import type { Run, Observation } from "./feltdb/schema.js";
import { createAuthorityGuard } from "./handoff-authority-guard.js";

export interface ObservationPersistenceOptions {
  paseoState: PaseoState;
  logger: Logger;
}

/**
 * Deduplication strategy for tool execution observations.
 *
 * Generate a stable key from runId + toolName + input hash.
 * This prevents duplicate observations from:
 * - Event stream reconnects
 * - Daemon restarts
 * - Event replay
 * - Retries
 *
 * The dedup key is stored in metadata and queried before insertion.
 */
function computeDedupKey(event: ToolExecutedEvent): string {
  const hash = createHash("sha256");

  // Include stable components
  hash.update(event.runId);
  hash.update(event.toolName);

  // Hash input to handle complex objects
  if (event.input !== undefined && event.input !== null) {
    hash.update(JSON.stringify(event.input));
  }

  // Include status in key to allow multiple records per tool call
  // (running, completed, failed are separate observations)
  hash.update(event.status);

  return hash.digest("hex").slice(0, 16); // 16-char hex
}

/**
 * ObservationPersistence routes ExecutionFeedbackEvent to appropriate
 * durable storage.
 */
export class ObservationPersistence {
  private readonly paseoState: PaseoState;
  private readonly logger: Logger;
  private readonly authorityGuard: ReturnType<typeof createAuthorityGuard>;
  private readonly failureQueue: Array<{
    event: ExecutionFeedbackEvent;
    run: Run;
    error: string;
    timestamp: string;
  }> = [];

  constructor(options: ObservationPersistenceOptions) {
    this.paseoState = options.paseoState;
    this.logger = options.logger.child({ module: "observation-persistence" });
    this.authorityGuard = createAuthorityGuard(options.paseoState, this.logger);
  }

  /**
   * Persist an execution feedback event to durable state.
   *
   * Routes based on event type:
   * - tool.executed → Observation
   * - timeline.message → Message (delegated)
   * - run.terminal → Run (already handled)
   *
   * Does NOT block the agent stream. Failures are logged and queued
   * for visibility and diagnostics.
   */
  async persistEvent(event: ExecutionFeedbackEvent, run: Run): Promise<void> {
    try {
      if (event.type === "tool.executed") {
        await this.persistToolExecution(event, run);
      } else if (event.type === "timeline.message") {
        // Route to message persistence (existing from Phase 2B Part 5)
        // This would be integrated with message persistence layer
        this.logger.trace(
          { runId: run.id, role: (event as any).role },
          "Timeline message routed to message persistence (Phase 2B)",
        );
      } else if (event.type === "run.terminal") {
        // Terminal state already captured in Run entity
        this.logger.trace(
          { runId: run.id, status: (event as any).status },
          "Terminal event already captured in Run entity",
        );
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.logger.error(
        { runId: run.id, eventType: event.type, err: error },
        `Failed to persist execution event: ${errorMsg}`,
      );

      // Queue failure for diagnostics
      this.failureQueue.push({
        event,
        run,
        error: errorMsg,
        timestamp: new Date().toISOString(),
      });

      // Important: Don't throw. The agent stream is not blocked by observation
      // persistence failures. But the failure is visible in logs and queue.
    }
  }

  /**
   * Persist a tool execution fact.
   *
   * Creates an Observation with:
   * - Complete graph association (resolved from Run)
   * - Tool metadata (name, input, result/error)
   * - Stable dedup key (prevent duplicates on retry/replay)
   * - Full provenance (runId, timestamp)
   */
  private async persistToolExecution(
    event: ToolExecutedEvent,
    run: Run,
  ): Promise<void> {
    // Compute dedup key to prevent duplicates
    const dedupKey = computeDedupKey(event);

    // Check if this observation already exists
    const existing = await this.paseoState.observations.listByProject(run.projectId);
    const isDuplicate = existing.some(
      (obs) =>
        obs.runId === run.id &&
        obs.metadata?.dedupKey === dedupKey,
    );

    if (isDuplicate) {
      this.logger.debug(
        { runId: run.id, toolName: event.toolName, dedupKey },
        "Tool execution observation already persisted (dedup)",
      );
      return;
    }

    // Resolve complete graph from Run
    const workspace = await this.paseoState.workspaces.getById(run.workspaceId);
    if (!workspace) {
      this.logger.warn(
        { runId: run.id, workspaceId: run.workspaceId },
        "Cannot persist observation: workspace not found",
      );
      return;
    }

    // AUTHORITY CHECK: Verify agent has authority to create observation
    try {
      await this.authorityGuard.authorize({
        agentId: run.agentId,
        operation: "create",
        entityType: "observation",
        entityId: `observation-${dedupKey}`,
        taskId: run.taskId,
        workspaceId: run.workspaceId,
        projectId: run.projectId,
        runId: run.id,
        context: { toolName: event.toolName },
      });
    } catch (err) {
      this.logger.warn(
        {
          agentId: run.agentId,
          runId: run.id,
          toolName: event.toolName,
          err: err instanceof Error ? err.message : String(err),
        },
        "Observation creation denied by AuthorityGuard",
      );
      return;
    }

    // Build observation content
    let content = `Tool executed: ${event.toolName}`;
    if (event.status === "completed" && event.result) {
      content += `\n\nResult: ${String(event.result).slice(0, 500)}`;
    } else if (event.status === "failed" && event.error) {
      content += `\n\nError: ${event.error}`;
    }

    // Persist observation
    const observation = await this.paseoState.observations.create({
      projectId: run.projectId,
      repositoryId: workspace.repositoryId ?? undefined,
      workspaceId: run.workspaceId,
      agentId: run.agentId,
      runId: run.id,
      type: "discovery", // Tool execution is a discovery/fact
      source: "system",
      content,
      confidence: event.status === "completed" ? 1.0 : 0.8, // Completed is certain
      metadata: {
        dedupKey, // Deduplication key
        toolName: event.toolName,
        input: event.input,
        status: event.status,
        result: event.result,
        error: event.error,
      },
    });

    this.logger.debug(
      {
        runId: run.id,
        observationId: observation.id,
        toolName: event.toolName,
        status: event.status,
      },
      "Tool execution observation persisted (authorized)",
    );
  }

  /**
   * Get pending failures that need diagnostics.
   *
   * Use this to monitor persistence health and identify retry candidates.
   */
  getFailureQueue(): Array<{
    event: ExecutionFeedbackEvent;
    run: Run;
    error: string;
    timestamp: string;
  }> {
    return [...this.failureQueue];
  }

  /**
   * Clear failure queue after diagnostics/remediation.
   */
  clearFailureQueue(): void {
    this.failureQueue.length = 0;
  }

  /**
   * Clear a specific failure after successful retry.
   */
  removeFailure(timestamp: string): void {
    const index = this.failureQueue.findIndex((f) => f.timestamp === timestamp);
    if (index >= 0) {
      this.failureQueue.splice(index, 1);
    }
  }

  /**
   * Update observation with authorization check.
   *
   * Authorization: Agent must be in the same project as the observation.
   * This prevents cross-project mutation (SCENARIO-3 from audit).
   *
   * @throws Error if agent is not authorized to modify observation
   */
  async authorizedUpdate(
    observationId: string,
    agentId: string,
    data: Partial<Observation>,
  ): Promise<Observation> {
    // 1. Fetch the observation
    const observation = await this.paseoState.observations.getById(observationId);
    if (!observation) {
      this.logger.warn({ observationId, agentId }, "Cannot update observation: Observation not found");
      throw new Error(`Observation ${observationId} not found`);
    }

    // 2. Fetch agent to validate project membership
    const agent = await this.paseoState.repos.agents.getById(agentId);
    if (!agent) {
      this.logger.warn({ agentId, observationId }, "Cannot update observation: Agent not found");
      throw new Error(`Agent ${agentId} not found`);
    }

    // 3. Fetch workspace to establish project authority
    const workspace = await this.paseoState.repos.workspaces.getById(agent.workspaceId);
    if (!workspace) {
      this.logger.warn(
        { agentId, workspaceId: agent.workspaceId, observationId },
        "Cannot update observation: Workspace not found",
      );
      throw new Error(`Workspace ${agent.workspaceId} not found`);
    }

    // 4. Authorization check: Agent's project must match observation's project
    if (workspace.projectId !== observation.projectId) {
      this.logger.warn(
        {
          agentId,
          agentProject: workspace.projectId,
          observationProject: observation.projectId,
          observationId,
        },
        "Cannot update observation: Agent not authorized (different project)",
      );
      throw new Error(
        `Agent ${agentId} cannot update observation in project ${observation.projectId} ` +
          `(agent is in project ${workspace.projectId})`,
      );
    }

    // 5. Perform authorized update
    const updated = await this.paseoState.observations.update(observationId, data);
    this.logger.debug(
      { observationId, agentId, projectId: observation.projectId },
      "Observation updated (authorized)",
    );
    return updated;
  }

  /**
   * Delete observation with authorization check.
   *
   * Authorization: Agent must be in the same project as the observation.
   *
   * @throws Error if agent is not authorized to delete observation
   */
  async authorizedDelete(observationId: string, agentId: string): Promise<void> {
    // 1. Fetch the observation
    const observation = await this.paseoState.observations.getById(observationId);
    if (!observation) {
      this.logger.warn({ observationId, agentId }, "Cannot delete observation: Observation not found");
      throw new Error(`Observation ${observationId} not found`);
    }

    // 2. Fetch agent to validate project membership
    const agent = await this.paseoState.repos.agents.getById(agentId);
    if (!agent) {
      this.logger.warn({ agentId, observationId }, "Cannot delete observation: Agent not found");
      throw new Error(`Agent ${agentId} not found`);
    }

    // 3. Fetch workspace to establish project authority
    const workspace = await this.paseoState.repos.workspaces.getById(agent.workspaceId);
    if (!workspace) {
      this.logger.warn(
        { agentId, workspaceId: agent.workspaceId, observationId },
        "Cannot delete observation: Workspace not found",
      );
      throw new Error(`Workspace ${agent.workspaceId} not found`);
    }

    // 4. Authorization check: Agent's project must match observation's project
    if (workspace.projectId !== observation.projectId) {
      this.logger.warn(
        {
          agentId,
          agentProject: workspace.projectId,
          observationProject: observation.projectId,
          observationId,
        },
        "Cannot delete observation: Agent not authorized (different project)",
      );
      throw new Error(
        `Agent ${agentId} cannot delete observation in project ${observation.projectId} ` +
          `(agent is in project ${workspace.projectId})`,
      );
    }

    // 5. Perform authorized delete
    await this.paseoState.observations.delete(observationId);
    this.logger.debug(
      { observationId, agentId, projectId: observation.projectId },
      "Observation deleted (authorized)",
    );
  }
}

export function createObservationPersistence(
  options: ObservationPersistenceOptions,
): ObservationPersistence {
  return new ObservationPersistence(options);
}

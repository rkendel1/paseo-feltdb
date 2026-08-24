/**
 * Run Manager - Integrates durable Run lifecycle with agent execution
 *
 * Responsibilities:
 * - Create durable Run entities when agents start
 * - Update Run status during execution
 * - Persist final result/error/timing on completion
 * - Query project/workspace context from durable state
 *
 * Phase 2 Addition: Authorization checks for Run creation
 * - Agent can only create Runs in their own project
 * - Project is derived from agent → workspace → project chain
 * - Prevents cross-project Run creation (SCENARIO-6 from audit)
 * - Preserves Run as provenance bridge for observations/decisions
 */

import type { Logger } from "pino";
import type { PaseoState } from "./paseo-state.js";
import type { Run } from "./feltdb/schema.js";
import { createAuthorityGuard } from "./handoff-authority-guard.js";

export interface RunManagerOptions {
  paseoState: PaseoState;
  logger: Logger;
}

export type RunContext = {
  agentId: string;
  projectId: string;
  workspaceId: string;
};

/**
 * Manages durable Run lifecycle for agent execution.
 * Designed to be called from AgentManager at key lifecycle points.
 */
export class RunManager {
  private readonly paseoState: PaseoState;
  private readonly logger: Logger;
  private readonly authorityGuard: ReturnType<typeof createAuthorityGuard>;
  private readonly activeRuns = new Map<string, { run: Run; startedAt: number }>();

  constructor(options: RunManagerOptions) {
    this.paseoState = options.paseoState;
    this.logger = options.logger.child({ module: "run-manager" });
    this.authorityGuard = createAuthorityGuard(options.paseoState, this.logger);
  }

  /**
   * Create a new Run entity when an agent execution begins.
   *
   * Called when streamAgent starts (after agent session startTurn succeeds).
   * Determines project/workspace context from agent's cwd and creates durable Run.
   */
  async createRun(input: {
    agentId: string;
    provider: "claude" | "codex" | "opencode";
    cwd: string;
    prompt: string;
  }): Promise<Run | null> {
    try {
      // Find workspace by cwd
      const workspace = await this.paseoState.workspaces.getByCwd(input.cwd);
      if (!workspace) {
        this.logger.warn(
          { agentId: input.agentId, cwd: input.cwd },
          "Could not find workspace for cwd; skipping Run creation",
        );
        return null;
      }

      // AUTHORITY CHECK: Verify agent has authority to create run in this workspace
      try {
        await this.authorityGuard.authorize({
          agentId: input.agentId,
          operation: "create",
          entityType: "run",
          entityId: `run-${input.agentId}-${Date.now()}`,
          workspaceId: workspace.id,
          projectId: workspace.projectId,
          context: { provider: input.provider, cwd: input.cwd },
        });
      } catch (err) {
        this.logger.warn(
          {
            agentId: input.agentId,
            workspaceId: workspace.id,
            projectId: workspace.projectId,
            err: err instanceof Error ? err.message : String(err),
          },
          "Run creation denied by AuthorityGuard",
        );
        return null;
      }

      // Create durable Run entity
      const run = await this.paseoState.runs.create({
        projectId: workspace.projectId,
        workspaceId: workspace.id,
        agentId: input.agentId,
        provider: input.provider,
        prompt: input.prompt,
      });

      // Track active run for completion handling
      this.activeRuns.set(input.agentId, {
        run,
        startedAt: Date.now(),
      });

      this.logger.debug(
        { agentId: input.agentId, runId: run.id, workspaceId: workspace.id },
        "Run created (authorized)",
      );

      return run;
    } catch (error) {
      this.logger.error(
        { agentId: input.agentId, err: error },
        "Failed to create Run entity",
      );
      return null;
    }
  }

  /**
   * Update Run status when agent execution starts.
   *
   * Called after agent session successfully starts (after startTurn returns).
   */
  async markRunStarted(agentId: string): Promise<void> {
    try {
      const tracked = this.activeRuns.get(agentId);
      if (!tracked) {
        return;
      }

      await this.paseoState.runs.update(tracked.run.id, {
        status: "running",
        startedAt: new Date().toISOString(),
      });

      this.logger.trace({ agentId, runId: tracked.run.id }, "Run marked as started");
    } catch (error) {
      this.logger.error({ agentId, err: error }, "Failed to mark Run as started");
    }
  }

  /**
   * Record context resolution outcome for this Run.
   *
   * Called after AgentContextService.resolveForTurn() to track whether
   * context was successfully resolved, failed, or fell back to empty context.
   */
  async recordContextResolution(
    agentId: string,
    outcome: {
      status: "resolved" | "failed" | "fallback";
      policy: "block" | "fallback";
      summary?: string;
    },
  ): Promise<void> {
    try {
      const tracked = this.activeRuns.get(agentId);
      if (!tracked) {
        return;
      }

      await this.paseoState.runs.update(tracked.run.id, {
        contextResolution: outcome,
      });

      this.logger.debug(
        { agentId, runId: tracked.run.id, ...outcome },
        "Context resolution recorded",
      );
    } catch (error) {
      this.logger.error(
        { agentId, err: error },
        "Failed to record context resolution",
      );
    }
  }

  /**
   * Update Run when agent execution completes with success.
   *
   * Called when agent finishes normally.
   */
  async markRunCompleted(
    agentId: string,
    result?: { text: string; usage?: any },
  ): Promise<void> {
    try {
      const tracked = this.activeRuns.get(agentId);
      if (!tracked) {
        return;
      }

      const duration = Math.round((Date.now() - tracked.startedAt) / 1000); // seconds

      await this.paseoState.runs.update(tracked.run.id, {
        status: "completed",
        completedAt: new Date().toISOString(),
        result: result?.text,
        metadata: {
          durationSeconds: duration,
          usage: result?.usage,
        },
      });

      this.logger.debug(
        { agentId, runId: tracked.run.id, durationSeconds: duration },
        "Run completed",
      );

      this.activeRuns.delete(agentId);
    } catch (error) {
      this.logger.error({ agentId, err: error }, "Failed to mark Run as completed");
    }
  }

  /**
   * Update Run when agent execution fails.
   *
   * Called when agent throws an error or turn fails.
   */
  async markRunFailed(agentId: string, error: string): Promise<void> {
    try {
      const tracked = this.activeRuns.get(agentId);
      if (!tracked) {
        return;
      }

      const duration = Math.round((Date.now() - tracked.startedAt) / 1000); // seconds

      await this.paseoState.runs.update(tracked.run.id, {
        status: "failed",
        completedAt: new Date().toISOString(),
        error,
        metadata: {
          durationSeconds: duration,
        },
      });

      this.logger.warn(
        { agentId, runId: tracked.run.id, error, durationSeconds: duration },
        "Run failed",
      );

      this.activeRuns.delete(agentId);
    } catch (error) {
      this.logger.error({ agentId, err: error }, "Failed to mark Run as failed");
    }
  }

  /**
   * Update Run when agent execution is interrupted.
   *
   * Called when a pending run is cancelled/replaced before completion.
   */
  async markRunInterrupted(agentId: string): Promise<void> {
    try {
      const tracked = this.activeRuns.get(agentId);
      if (!tracked) {
        return;
      }

      const duration = Math.round((Date.now() - tracked.startedAt) / 1000); // seconds

      await this.paseoState.runs.update(tracked.run.id, {
        status: "interrupted",
        completedAt: new Date().toISOString(),
        metadata: {
          durationSeconds: duration,
        },
      });

      this.logger.debug(
        { agentId, runId: tracked.run.id, durationSeconds: duration },
        "Run interrupted",
      );

      this.activeRuns.delete(agentId);
    } catch (error) {
      this.logger.error({ agentId, err: error }, "Failed to mark Run as interrupted");
    }
  }

  /**
   * Forget about a pending run (e.g., if it never actually started).
   */
  forgetRun(agentId: string): void {
    this.activeRuns.delete(agentId);
  }

  /**
   * Get currently tracked active runs (for testing/debugging).
   */
  getActiveRuns(): Map<string, Run> {
    const result = new Map<string, Run>();
    for (const [agentId, tracked] of this.activeRuns) {
      result.set(agentId, tracked.run);
    }
    return result;
  }

  /**
   * Create a Run with authorization check.
   *
   * Validates that the run's project is derived from agent's workspace,
   * not from caller-supplied input. This ensures run.projectId is always
   * consistent with the agent's actual authorization context.
   *
   * Authorization flow:
   * 1. Fetch agent
   * 2. Fetch workspace for that agent
   * 3. Derive projectId from workspace.projectId
   * 4. Create run with derived projectId
   *
   * This prevents cross-project run creation (SCENARIO-6 from audit).
   *
   * @throws Error if agent is not authorized to create run in supplied project
   */
  async authorizedCreateRun(
    agentId: string,
    requestedProjectId: string,
    provider: "claude" | "codex" | "opencode",
    prompt: string,
  ): Promise<Run> {
    // 1. Fetch the agent
    const agent = await this.paseoState.repos.agents.getById(agentId);
    if (!agent) {
      this.logger.warn({ agentId, requestedProjectId }, "Cannot create run: Agent not found");
      throw new Error(`Agent ${agentId} not found`);
    }

    // 2. Fetch the agent's workspace
    const workspace = await this.paseoState.repos.workspaces.getById(agent.workspaceId);
    if (!workspace) {
      this.logger.warn(
        { agentId, workspaceId: agent.workspaceId, requestedProjectId },
        "Cannot create run: Workspace not found",
      );
      throw new Error(`Workspace ${agent.workspaceId} not found`);
    }

    // 3. Derive the agent's actual project (authority comes from workspace)
    const derivedProjectId = workspace.projectId;

    // 4. Authorization check: requested project must match derived project
    if (derivedProjectId !== requestedProjectId) {
      this.logger.warn(
        {
          agentId,
          requestedProjectId,
          derivedProjectId,
          workspaceId: agent.workspaceId,
        },
        "Cannot create run: Agent not authorized for requested project",
      );
      throw new Error(
        `Agent ${agentId} cannot create run in project ${requestedProjectId} ` +
          `(agent is in project ${derivedProjectId})`,
      );
    }

    // 5. Perform authorized create with derived projectId
    const run = await this.paseoState.runs.create({
      projectId: derivedProjectId,
      workspaceId: workspace.id,
      agentId,
      provider,
      prompt,
    });

    // Track active run for completion handling
    this.activeRuns.set(agentId, {
      run,
      startedAt: Date.now(),
    });

    this.logger.debug(
      { agentId, runId: run.id, projectId: derivedProjectId },
      "Run created (authorized)",
    );

    return run;
  }
}

/**
 * Run Manager - Integrates durable Run lifecycle with agent execution
 *
 * Responsibilities:
 * - Create durable Run entities when agents start
 * - Update Run status during execution
 * - Persist final result/error/timing on completion
 * - Query project/workspace context from durable state
 */

import type { Logger } from "pino";
import type { PaseoState } from "./paseo-state.js";
import type { Run, AgentProvider } from "./feltdb/schema.js";

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
  private readonly activeRuns = new Map<string, { run: Run; startedAt: number }>();

  constructor(options: RunManagerOptions) {
    this.paseoState = options.paseoState;
    this.logger = options.logger.child({ module: "run-manager" });
  }

  /**
   * Create a new Run entity when an agent execution begins.
   *
   * Called when streamAgent starts (after agent session startTurn succeeds).
   * Determines project/workspace context from agent's cwd and creates durable Run.
   */
  async createRun(input: {
    agentId: string;
    provider: AgentProvider;
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
        "Run created",
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
}

/**
 * Run Recovery Manager - Crash recovery for durable Run lifecycle
 *
 * At daemon startup, reconciles durable Runs against the runtime to ensure
 * the FeltDB Run graph accurately represents reality after unexpected process death.
 *
 * Conservative model: only mark a Run orphaned when definitively gone.
 * Defers to provider/normal lifecycle for ambiguous cases.
 *
 * Guarantees:
 * - Idempotent: running recovery twice produces same result
 * - Conservative: never prematurely marks active executions as orphaned
 * - Non-blocking: failures are isolated and logged, don't stop daemon startup
 */

import type { Logger } from "pino";
import type { AgentStorage } from "../agent/agent-storage.js";
import type { PaseoState } from "./paseo-state.js";

export interface RunRecoveryOptions {
  paseoState: PaseoState;
  agentStorage: AgentStorage;
  logger: Logger;
}

export interface RunRecoverySummary {
  totalRunsProcessed: number;
  runningRunsFound: number;
  orphanedRunsMarked: number;
  recoveryErrors: Array<{ runId: string; error: string }>;
}

/**
 * Reconciles durable Runs with actual runtime state after daemon restart.
 *
 * Entry point: runRecoveryManager.reconcileAll() during daemon bootstrap,
 * after FeltDB initialization but before normal agent services start.
 */
export class RunRecoveryManager {
  private readonly paseoState: PaseoState;
  private readonly agentStorage: AgentStorage;
  private readonly logger: Logger;

  constructor(options: RunRecoveryOptions) {
    this.paseoState = options.paseoState;
    this.agentStorage = options.agentStorage;
    this.logger = options.logger.child({ module: "run-recovery" });
  }

  /**
   * Reconcile all durable Runs: discover orphaned executions and mark them.
   *
   * Called during daemon startup, before normal agent execution services start.
   * This ensures the durable Run graph is consistent with reality after restart.
   */
  async reconcileAll(): Promise<RunRecoverySummary> {
    const summary: RunRecoverySummary = {
      totalRunsProcessed: 0,
      runningRunsFound: 0,
      orphanedRunsMarked: 0,
      recoveryErrors: [],
    };

    try {
      // Query for all Runs with status="running"
      const runningRuns = await this.findRunningRuns();
      summary.runningRunsFound = runningRuns.length;

      if (runningRuns.length === 0) {
        this.logger.info("Run recovery: no running runs found, nothing to reconcile");
        return summary;
      }

      this.logger.info({ count: runningRuns.length }, "Run recovery: found running runs to reconcile");

      // Process each running Run
      for (const run of runningRuns) {
        summary.totalRunsProcessed++;
        try {
          const isOrphaned = await this.isRunOrphaned(run);
          if (isOrphaned) {
            await this.markRunInterrupted(run);
            summary.orphanedRunsMarked++;

            this.logger.info(
              {
                runId: run.id,
                agentId: run.agentId,
                workspaceId: run.workspaceId,
              },
              "Recovered orphaned run: marked as interrupted",
            );
          }
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          summary.recoveryErrors.push({ runId: run.id, error: errorMsg });
          this.logger.error(
            { runId: run.id, agentId: run.agentId, err: error },
            "Failed to reconcile run",
          );
        }
      }

      // Log summary
      this.logger.info(
        {
          totalProcessed: summary.totalRunsProcessed,
          orphaned: summary.orphanedRunsMarked,
          errors: summary.recoveryErrors.length,
        },
        "Run recovery completed",
      );

      return summary;
    } catch (error) {
      this.logger.error({ err: error }, "Fatal error during run recovery");
      throw error;
    }
  }

  /**
   * Query for all Runs with status="running".
   *
   * Uses FeltDB's repository interface.
   * Assumes an efficient query (indexed on status field).
   */
  private async findRunningRuns(): Promise<any[]> {
    try {
      // Query FeltDB for all runs with status="running"
      // This uses the underlying FeltDB collection and should be indexed
      const runs = await this.paseoState.repos.runs.listByStatus("running");
      return runs;
    } catch (error) {
      this.logger.error({ err: error }, "Failed to query for running runs");
      throw error;
    }
  }

  /**
   * Determine whether a Run is orphaned (its execution definitively no longer exists).
   *
   * Conservative logic:
   * - If the agent doesn't exist in AgentStorage, the Run is orphaned
   * - If the agent exists with a persistence handle, defer (it might be recoverable)
   * - If the agent exists but has no persistence, mark as orphaned
   *
   * This ensures we never prematurely mark an execution as dead when the provider
   * session might still be valid.
   */
  private async isRunOrphaned(run: any): Promise<boolean> {
    const { agentId } = run;

    try {
      // Check if the agent still exists in AgentStorage
      const agent = await this.agentStorage.get(agentId);

      if (!agent) {
        // Agent was deleted or never stored - Run is definitely orphaned
        this.logger.debug(
          { agentId, runId: run.id },
          "Agent not found in storage: Run is orphaned",
        );
        return true;
      }

      // Agent exists. Check if it has a valid persistence handle.
      if (!agent.persistence || !agent.persistence.sessionId) {
        // Agent has no session information - cannot resume, Run is orphaned
        this.logger.debug(
          { agentId, runId: run.id },
          "Agent has no persistence handle: Run is orphaned",
        );
        return true;
      }

      // Agent exists with a persistence handle - it might be recoverable
      // Defer to normal agent lifecycle to attempt resumption
      this.logger.trace(
        { agentId, runId: run.id },
        "Agent has valid persistence handle: not orphaned (deferred to normal lifecycle)",
      );
      return false;
    } catch (error) {
      this.logger.error(
        { agentId, runId: run.id, err: error },
        "Error checking if run is orphaned; assuming not orphaned (conservative)",
      );
      // On any error, assume the Run is NOT orphaned (conservative)
      // Better to leave a potentially orphaned run than to falsely kill an active one
      return false;
    }
  }

  /**
   * Mark a Run as "interrupted" with recovery metadata.
   *
   * Sets:
   * - status → "interrupted"
   * - completedAt → current time
   * - metadata.recoveredAt → current time
   * - metadata.recoveryReason → "daemon_restart_orphaned_process"
   *
   * Preserves:
   * - startedAt, prompt, agentId, provider (original execution context)
   * - Does NOT delete provider persistence handle (kept for inspection/debugging)
   */
  private async markRunInterrupted(run: any): Promise<void> {
    const now = new Date().toISOString();
    const durationSeconds = run.startedAt
      ? Math.round((Date.parse(now) - Date.parse(run.startedAt)) / 1000)
      : undefined;

    const updatedMetadata = {
      ...(run.metadata || {}),
      recoveredAt: now,
      recoveryReason: "daemon_restart_orphaned_process",
    };

    await this.paseoState.runs.update(run.id, {
      status: "interrupted",
      completedAt: now,
      metadata: updatedMetadata,
      ...(durationSeconds !== undefined && { metadata: { ...updatedMetadata, durationSeconds } }),
    });
  }
}

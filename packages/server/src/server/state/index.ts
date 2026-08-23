/**
 * Paseo State Initialization
 *
 * Unified entry point for FeltDB initialization, migration, and state access.
 */

import type { Logger } from "pino";
import {
  PaseoDB,
  resolveFeltDBPath,
  createRepositories,
} from "./feltdb/index.js";
import { createPaseoState, type PaseoState } from "./paseo-state.js";
import { runMigration, detectLegacyState, hasMigrationCompleted } from "./migration-manager.js";
import { AgentStorage } from "../agent/agent-storage.js";

export interface StateInitOptions {
  paseoHome: string;
  logger: Logger;
}

export interface InitializedState {
  state: PaseoState;
  feeldbHealthy: boolean;
  migrationCompleted: boolean;
  close: () => Promise<void>;
}

/**
 * Initialize Paseo's durable state substrate.
 *
 * This must run during daemon startup before services that depend on
 * durable application state.
 *
 * Steps:
 * 1. Initialize FeltDB
 * 2. Run migrations if needed
 * 3. Create state service
 * 4. Verify health
 */
export async function initializeState(options: StateInitOptions): Promise<InitializedState> {
  const { paseoHome, logger } = options;
  const log = logger.child({ module: "state-init" });

  try {
    // 1. Resolve FeltDB path and initialize database
    const feltdbPath = resolveFeltDBPath(paseoHome);
    log.info({ feltdbPath }, "Initializing FeltDB");

    const paseoDB = new PaseoDB({
      dataPath: feltdbPath,
      logger,
    });

    await paseoDB.initialize();
    log.info("FeltDB initialized");

    // 2. Create typed repositories
    const db = paseoDB.getDatabase();
    const repositories = createRepositories(db);

    // 3. Create state service early (needed for migration)
    const state = createPaseoState(repositories, logger);

    // 4. Initialize AgentStorage (needed for migration)
    const agentStoragePath = `${paseoHome}/agents`;
    const agentStorage = new AgentStorage(agentStoragePath, logger);
    await agentStorage.initialize();

    // 5. Check for legacy state and run migration if needed
    const legacy = detectLegacyState(paseoHome);
    const alreadyMigrated = await hasMigrationCompleted(repositories);

    if ((legacy.hasProjects || legacy.hasWorkspaces || legacy.hasAgents) && !alreadyMigrated) {
      log.info("Legacy state detected, running migration");
      const migrationResult = await runMigration(paseoHome, repositories, logger, agentStorage, state);

      if (!migrationResult.success) {
        log.warn(
          { errors: migrationResult.errors },
          "Migration completed with errors (non-blocking)",
        );
      } else {
        log.info("Migration completed successfully");
      }
    }

    // 5. Verify health
    const health = await paseoDB.health();
    if (!health.healthy) {
      throw new Error(`FeltDB health check failed: ${health.message}`);
    }

    log.info("Paseo state initialized and healthy");

    return {
      state,
      feeldbHealthy: true,
      migrationCompleted: alreadyMigrated || (legacy.hasProjects || legacy.hasWorkspaces),
      close: async () => {
        await state.close();
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error({ err: error }, `Failed to initialize state: ${message}`);
    throw new Error(`Paseo state initialization failed: ${message}`);
  }
}

export type { PaseoState } from "./paseo-state.js";
export { detectLegacyState } from "./migration-manager.js";
export {
  createContextResolver,
  type ContextResolver,
  type ContextResolverInput,
  type AgentContext,
} from "./context-resolver.js";
export {
  createContextPolicyEngine,
  type ContextPolicy,
  type BoundedAgentContext,
  type ContextSelection,
  type BoundedContextSelection,
  DEFAULT_CONTEXT_POLICY,
} from "./context-policy.js";
export {
  createRequestRelevanceScorer,
  type RelevanceScore,
  RequestRelevanceScorer,
} from "./request-relevance-scorer.js";
export {
  createContextPresenter,
  type ContextProjection,
  type AgentTurnContext,
  ContextPresenter,
} from "./context-presenter.js";
export {
  createAgentContextService,
  type AgentContextServiceOptions,
  type ContextResolutionResult,
  type ContextResolutionError,
  type ContextResolutionOutcome,
  ContextResolutionFailurePolicy,
  AgentContextService,
} from "./agent-context-service.js";
export {
  createExecutionFeedbackNormalizer,
  type ExecutionFeedbackEvent,
  type RunTerminalEvent,
  type ToolExecutedEvent,
  type TimelineMessageEvent,
  ExecutionFeedbackNormalizer,
} from "./execution-feedback-normalizer.js";
export {
  createObservationPersistence,
  type ObservationPersistenceOptions,
  ObservationPersistence,
} from "./observation-persistence.js";
export {
  createDecisionPersistence,
  type DecisionPersistenceOptions,
  type RecordDecisionInput,
  DecisionPersistence,
} from "./decision-persistence.js";
export {
  createTaskPersistence,
  type TaskPersistenceOptions,
  type UpdateTaskInput,
  TaskPersistence,
} from "./task-persistence.js";

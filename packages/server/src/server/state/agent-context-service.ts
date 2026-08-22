/**
 * AgentContextService - Unified Context Resolution & Injection
 *
 * Phase 3.3: Orchestrates the complete context resolution pipeline
 * for agent turn injection.
 *
 * Combines:
 * 1. ContextResolver (3.1) - Durable graph traversal
 * 2. ContextPolicyEngine (3.2) - Deterministic selection
 * 3. ContextPresenter (3.3) - Canonical projection
 *
 * Provides a single contract for AgentManager to:
 * - Resolve per-turn context
 * - Get canonical presentation
 * - Handle failures with explicit policy
 */

import type { Logger } from "pino";
import { ContextResolver } from "./context-resolver.js";
import {
  ContextPolicyEngine,
  DEFAULT_CONTEXT_POLICY,
  type ContextPolicy,
} from "./context-policy.js";
import { ContextPresenter, type AgentTurnContext } from "./context-presenter.js";
import type { PaseoState } from "./paseo-state.js";

export interface AgentContextServiceOptions {
  paseoState: PaseoState;
  contextPolicy?: ContextPolicy;
  logger: Logger;
}

export interface ContextResolutionResult {
  success: true;
  turnContext: AgentTurnContext;
}

export interface ContextResolutionError {
  success: false;
  error: string;
  agentId: string;
  reason: "agent_not_found" | "graph_broken" | "unknown";
}

export type ContextResolutionOutcome =
  | ContextResolutionResult
  | ContextResolutionError;

/**
 * Failure isolation policy for 3.3.
 *
 * Controls what happens when context resolution fails.
 */
export enum ContextResolutionFailurePolicy {
  /**
   * BLOCK: Stop execution, return error to user.
   * Production-safe: Agent always knows context state.
   */
  BLOCK = "block",

  /**
   * FALLBACK: Attempt execution with empty context.
   * Development-friendly: Agent runs but may lack awareness.
   */
  FALLBACK = "fallback",
}

export class AgentContextService {
  private resolver: ContextResolver;
  private policyEngine: ContextPolicyEngine;
  private presenter: ContextPresenter;
  private logger: Logger;
  private failurePolicy: ContextResolutionFailurePolicy;

  constructor(
    options: AgentContextServiceOptions,
    failurePolicy: ContextResolutionFailurePolicy = ContextResolutionFailurePolicy.BLOCK
  ) {
    this.logger = options.logger.child({ module: "agent-context-service" });
    this.resolver = new ContextResolver({
      paseoState: options.paseoState,
      logger: this.logger,
    });
    this.policyEngine = new ContextPolicyEngine(
      options.contextPolicy || DEFAULT_CONTEXT_POLICY
    );
    this.presenter = new ContextPresenter();
    this.failurePolicy = failurePolicy;
  }

  /**
   * Resolve complete agent turn context.
   *
   * Process:
   * 1. Resolve complete graph (ContextResolver - 3.1)
   * 2. Apply policy for bounded selection (ContextPolicyEngine - 3.2)
   * 3. Project to canonical format (ContextPresenter - 3.3)
   *
   * Failure handling:
   * - BLOCK policy: Errors are surfaced, execution blocked
   * - FALLBACK policy: Errors are logged, execution continues with empty context
   *
   * For production, BLOCK is recommended.
   */
  async resolveForTurn(
    agentId: string,
    request: string,
    runId: string
  ): Promise<ContextResolutionOutcome> {
    try {
      this.logger.debug(
        { agentId, runId },
        "AgentContextService.resolveForTurn: starting"
      );

      // 1. Resolve complete graph
      const agentContext = await this.resolver.resolve({
        agentId,
        request,
        runId,
      });

      // 2. Apply policy
      const boundedContext = this.policyEngine.apply(agentContext, runId);

      // 3. Project to canonical format
      const projection = this.presenter.project(boundedContext);

      // 4. Construct turn context
      const turnContext: AgentTurnContext = {
        request,
        context: boundedContext,
        projection,
      };

      this.logger.debug(
        {
          agentId,
          runId,
          summary: projection.summary,
        },
        "AgentContextService.resolveForTurn: completed successfully"
      );

      return {
        success: true,
        turnContext,
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      this.logger.warn(
        { agentId, runId, err: error },
        `Context resolution failed: ${errorMessage}`
      );

      // Determine failure reason
      let reason: "agent_not_found" | "graph_broken" | "unknown" =
        "unknown";
      if (errorMessage.includes("Agent not found")) {
        reason = "agent_not_found";
      } else if (errorMessage.includes("not found")) {
        reason = "graph_broken";
      }

      // Apply failure policy
      if (this.failurePolicy === ContextResolutionFailurePolicy.BLOCK) {
        this.logger.error(
          { agentId, reason },
          "Context resolution failed (BLOCK policy applied)"
        );

        return {
          success: false,
          error: errorMessage,
          agentId,
          reason,
        };
      }

      // FALLBACK: Log but allow execution
      this.logger.warn(
        { agentId, reason },
        "Context resolution failed (FALLBACK policy: executing with empty context)"
      );

      // Return error for caller awareness (caller can choose to ignore for fallback)
      return {
        success: false,
        error: errorMessage,
        agentId,
        reason,
      };
    }
  }

  /**
   * Get failure policy currently in effect.
   */
  getFailurePolicy(): ContextResolutionFailurePolicy {
    return this.failurePolicy;
  }

  /**
   * Set failure policy (for testing or runtime configuration).
   */
  setFailurePolicy(policy: ContextResolutionFailurePolicy): void {
    this.failurePolicy = policy;
    this.logger.info(
      { policy },
      "Context resolution failure policy changed"
    );
  }
}

export function createAgentContextService(
  options: AgentContextServiceOptions,
  failurePolicy?: ContextResolutionFailurePolicy
): AgentContextService {
  return new AgentContextService(options, failurePolicy);
}

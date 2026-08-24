/**
 * AgentExecutionContext - Bounded Context for Provider Execution
 *
 * Phase 2 integration: Wire ContextResolver into agent execution path.
 *
 * This type wraps the resolved, bounded, and authorized context that
 * providers receive at execution time. It's the boundary between:
 * - FeltDB (server, durable, graph-aware)
 * - Provider (Claude SDK, Codex, OpenCode, agnostic)
 *
 * Key invariants:
 * 1. Provider never sees FeltDB directly
 * 2. Authorization enforced before provider receives context
 * 3. Budget enforced deterministically
 * 4. Agent A's private conversation never visible to Agent B (same workspace)
 */

import type { BoundedAgentContext } from "../state/context-policy.js";
import type { ContextProjection } from "../state/context-presenter.js";

/**
 * JSON-serializable carrier for bounded context.
 * Safe to log, pass between processes, persist.
 *
 * This is what providers receive—not the complete durable graph,
 * but a bounded, authorized, and policy-constrained view.
 */
export interface ContextEnvelope {
  /**
   * Original user request/prompt for this turn.
   */
  request: string;

  /**
   * Bounded context selected by policy.
   * No sensitive data, no authorization leaks.
   */
  context: BoundedAgentContext;

  /**
   * Canonical text projection ready for inclusion in provider input.
   * This is what gets prepended to the user's prompt.
   */
  projection: ContextProjection;

  /**
   * Authorization scope for this execution.
   * Proves context was selected within proper boundaries.
   */
  authorization: {
    agentId: string;
    workspaceId: string;
    projectId: string | null;
  };

  /**
   * Budget tracking for this context.
   */
  budget: {
    maxCharacters: number;
    usedCharacters: number;
    exceeded: boolean;
  };

  /**
   * Timestamp of context resolution.
   */
  resolvedAt: string;
}

/**
 * Complete execution context for an agent turn.
 *
 * This is the internal representation that AgentManager uses.
 * It wraps the provider-neutral ContextEnvelope with execution metadata.
 */
export interface AgentExecutionContext {
  /**
   * Agent ID for this execution.
   */
  agentId: string;

  /**
   * Workspace ID where this agent runs.
   */
  workspaceId: string;

  /**
   * Project ID if available.
   */
  projectId: string | null;

  /**
   * Run ID for this execution (for message provenance).
   */
  runId: string;

  /**
   * The bounded context to pass to provider.
   */
  envelope: ContextEnvelope;

  /**
   * User's original request/prompt.
   */
  request: string;

  /**
   * When this context was resolved.
   */
  resolvedAt: Date;
}

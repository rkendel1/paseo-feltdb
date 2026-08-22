/**
 * ContextPolicy - Deterministic Context Selection & Relevance
 *
 * Phase 3.2: Transform complete AgentContext (3.1) into bounded context
 * by applying deterministic selection policy based on relevance signals.
 *
 * Key principles:
 * - Deterministic: Same state + same policy → same selection (no embeddings, no LLM judge)
 * - Inspectable: Selection metadata explains WHY each item was included
 * - Precedence-based: Explicit hierarchy of relevance signals
 * - Conservative: Explicit relationships only (no text inference for tasks)
 * - Separated: Policy applied independently of provider injection (3.3)
 *
 * Relevance precedence (highest to lowest):
 * 1. Current run
 * 2. Current task
 * 3. Same conversation
 * 4. Recent agent activity
 * 5. Repository/project activity
 */

import type { Message, Run } from "./feltdb/schema.js";
import type { AgentContext } from "./context-resolver.js";

// ============================================================================
// Policy Configuration
// ============================================================================

export interface ContextPolicy {
  /**
   * Maximum number of runs to include in bounded context.
   * Current run is always included if present.
   */
  maxRuns: number;

  /**
   * Maximum number of messages to include.
   * Recent messages (by sequence) are prioritized.
   */
  maxMessages: number;

  /**
   * Maximum number of decisions to include.
   * Active decisions prioritized, then by recency.
   */
  maxDecisions: number;

  /**
   * Maximum number of observations to include.
   * By relevance signal, then recency.
   */
  maxObservations: number;

  /**
   * Maximum number of handoffs to include.
   * By recency and status.
   */
  maxHandoffs: number;
}

export const DEFAULT_CONTEXT_POLICY: ContextPolicy = {
  maxRuns: 10,
  maxMessages: 50,
  maxDecisions: 10,
  maxObservations: 20,
  maxHandoffs: 5,
};

// ============================================================================
// Selection Metadata
// ============================================================================

export interface ContextSelection {
  /**
   * IDs of selected items (in selection order).
   * Empty if no items matched criteria.
   */
  selected: string[];

  /**
   * Total available items before filtering.
   * Allows client to see filtering impact.
   */
  total: number;

  /**
   * Why these items were selected.
   * For debugging and understanding context decisions.
   */
  reason: string;
}

export interface BoundedContextSelection {
  runs: ContextSelection;
  messages: ContextSelection;
  decisions: ContextSelection;
  observations: ContextSelection;
  handoffs: ContextSelection;
}

// ============================================================================
// Bounded Context Output
// ============================================================================

export interface BoundedAgentContext extends AgentContext {
  /**
   * Selection metadata explaining which items were included and why.
   * Enables "why was this in context?" queries.
   */
  selection: BoundedContextSelection;
}

// ============================================================================
// Relevance Scoring
// ============================================================================

interface RelevanceScore {
  itemId: string;
  score: number;
  signals: string[];
}

// ============================================================================
// Context Policy Engine
// ============================================================================

export class ContextPolicyEngine {
  private policy: ContextPolicy;

  constructor(policy: ContextPolicy = DEFAULT_CONTEXT_POLICY) {
    this.policy = policy;
  }

  /**
   * Apply policy to AgentContext to produce BoundedAgentContext.
   *
   * Process:
   * 1. Score all available items by relevance signals
   * 2. Select top N by score (respecting policy limits)
   * 3. Track selection metadata (why each item was included)
   * 4. Return bounded context with selection
   */
  apply(
    context: AgentContext,
    _currentRunId?: string
  ): BoundedAgentContext {
    // Apply selection policies to each category
    const runSelection = this.selectRuns(
      context.recentRuns,
      _currentRunId
    );
    const messageSelection = this.selectMessages(
      context.recentMessages,
      context.conversation?.id,
      _currentRunId
    );
    const decisionSelection = this.selectDecisions(
      context.project.id
    );
    const observationSelection = this.selectObservations(
      context.project.id
    );
    const handoffSelection = this.selectHandoffs(
      context.project.id,
      context.identity.id
    );

    // Filter actual items based on selection
    const boundedRuns = context.recentRuns.filter((r) =>
      runSelection.selected.includes(r.id)
    );
    const boundedMessages = context.recentMessages.filter((m) =>
      messageSelection.selected.includes(m.id)
    );

    return {
      ...context,
      recentRuns: boundedRuns,
      recentMessages: boundedMessages,
      selection: {
        runs: runSelection,
        messages: messageSelection,
        decisions: decisionSelection,
        observations: observationSelection,
        handoffs: handoffSelection,
      },
    };
  }

  // ========================================================================
  // Selection Methods
  // ========================================================================

  private selectRuns(
    runs: Run[],
    currentRunId?: string
  ): ContextSelection {
    if (runs.length === 0) {
      return {
        selected: [],
        total: 0,
        reason: "No runs available",
      };
    }

    const scored: RelevanceScore[] = runs.map((run) => {
      const signals: string[] = [];
      let score = 0;

      // Signal 1: Current run (highest priority)
      if (currentRunId && run.id === currentRunId) {
        score += 1000;
        signals.push("current-run");
      }

      // Signal 2: Recently completed
      if (run.status === "completed") {
        score += 100;
        signals.push("completed");
      }

      // Signal 3: Recent by creation time
      const ageMs = Date.now() - new Date(run.createdAt).getTime();
      const ageHours = ageMs / (1000 * 60 * 60);
      const recencyScore = Math.max(0, 50 - ageHours);
      score += recencyScore;
      if (recencyScore > 0) {
        signals.push(`recency:${Math.round(ageHours)}h-old`);
      }

      return { itemId: run.id, score, signals };
    });

    // Sort by score descending
    scored.sort((a, b) => b.score - a.score);

    // Take top N according to policy
    const selected = scored
      .slice(0, this.policy.maxRuns)
      .map((s) => s.itemId);

    return {
      selected,
      total: runs.length,
      reason: `Selected ${selected.length}/${runs.length} runs by relevance (current, completed, recency)`,
    };
  }

  private selectMessages(
    messages: Message[],
    conversationId?: string,
    currentRunId?: string
  ): ContextSelection {
    if (messages.length === 0) {
      return {
        selected: [],
        total: 0,
        reason: "No messages available",
      };
    }

    const scored: RelevanceScore[] = messages.map((msg) => {
      const signals: string[] = [];
      let score = 0;

      // Signal 1: From current run (highest priority)
      if (currentRunId && msg.runId === currentRunId) {
        score += 500;
        signals.push("current-run");
      }

      // Signal 2: From same conversation
      if (conversationId && msg.conversationId === conversationId) {
        score += 100;
        signals.push("same-conversation");
      }

      // Signal 3: Recent by sequence (assumes sequence = recency)
      const sequenceScore = (msg.sequence || 0) * 10;
      score += sequenceScore;
      if (sequenceScore > 0) {
        signals.push(`sequence:${msg.sequence}`);
      }

      return { itemId: msg.id, score, signals };
    });

    // Sort by score descending (recent messages have higher sequence)
    scored.sort((a, b) => b.score - a.score);

    // Take top N according to policy
    const selected = scored
      .slice(0, this.policy.maxMessages)
      .map((s) => s.itemId);

    return {
      selected,
      total: messages.length,
      reason: `Selected ${selected.length}/${messages.length} messages by relevance (current-run, conversation, recency)`,
    };
  }

  /**
   * Decision selection - stub for Phase 3.3.
   * In 3.2, decisions are not yet populated from FeltDB.
   * Returning empty for now; will integrate with Observation/Decision entities.
   */
  private selectDecisions(_projectId: string): ContextSelection {
    return {
      selected: [],
      total: 0,
      reason: "Decisions not yet integrated (Phase 3.3+)",
    };
  }

  /**
   * Observation selection - stub for Phase 3.4.
   * In 3.2, observations are not yet populated from FeltDB.
   * Returning empty for now; will integrate with Observation entities.
   */
  private selectObservations(_projectId: string): ContextSelection {
    return {
      selected: [],
      total: 0,
      reason: "Observations not yet integrated (Phase 3.4+)",
    };
  }

  /**
   * Handoff selection - stub for Phase 3.5.
   * In 3.2, handoffs are not yet populated from FeltDB.
   * Returning empty for now; will integrate with Handoff entities.
   */
  private selectHandoffs(
    _projectId: string,
    _agentId: string
  ): ContextSelection {
    return {
      selected: [],
      total: 0,
      reason: "Handoffs not yet integrated (Phase 3.5+)",
    };
  }
}

export function createContextPolicyEngine(
  policy?: ContextPolicy
): ContextPolicyEngine {
  return new ContextPolicyEngine(policy || DEFAULT_CONTEXT_POLICY);
}

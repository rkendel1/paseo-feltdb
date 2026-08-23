/**
 * ContextPolicy - Deterministic Context Selection & Relevance
 *
 * Phase 3.6: Transform complete AgentContext into bounded context by applying
 * deterministic, request-aware selection policy.
 *
 * Key principles:
 * - Deterministic: Same input + same policy → same selection (no randomness)
 * - Request-driven: Request text determines which entities are relevant
 * - Inspectable: Selection metadata explains WHY each item was included
 * - Hierarchical: Explicit state outranks conversation
 * - Bounded: Character/token budgets enforced
 *
 * Selection hierarchy:
 * Tier 1 — Current work (current run, current task, current conversation)
 * Tier 2 — Direct history (recent runs, observations from those runs)
 * Tier 3 — Project knowledge (approved decisions, open/blocked tasks)
 * Tier 4 — Broader context (older messages, observations, runs)
 *
 * Truth hierarchy:
 * 1. Approved Decisions (explicit, user-approved state)
 * 2. Verified Observations (from execution)
 * 3. Recent Runs (execution history)
 * 4. Conversation (model and user communication)
 * 5. Inference (derived or inferred state)
 */

import type {
  Decision,
  Message,
  Observation,
  Run,
  Task,
} from "./feltdb/schema.js";
import type { AgentContext } from "./context-resolver.js";
import {
  RequestRelevanceScorer,
  createRequestRelevanceScorer,
} from "./request-relevance-scorer.js";

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
   * Approved decisions prioritized, then by recency.
   */
  maxDecisions: number;

  /**
   * Maximum number of observations to include.
   * By request relevance and recency.
   */
  maxObservations: number;

  /**
   * Maximum number of tasks to include.
   * Open/in_progress tasks prioritized by request relevance.
   */
  maxTasks: number;

  /**
   * Maximum number of handoffs to include.
   * By recency and status.
   */
  maxHandoffs: number;

  /**
   * Maximum character budget for entire context.
   * Enforced after selection, items trimmed if needed.
   */
  maxCharacters: number;
}

export const DEFAULT_CONTEXT_POLICY: ContextPolicy = {
  maxRuns: 10,
  maxMessages: 50,
  maxDecisions: 10,
  maxObservations: 20,
  maxTasks: 10,
  maxHandoffs: 5,
  maxCharacters: 50000,
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
  tasks: ContextSelection;
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

// Type alias for request signals
type RequestSignals = ReturnType<RequestRelevanceScorer["extractSignals"]>;

// ============================================================================
// Context Policy Engine
// ============================================================================

export class ContextPolicyEngine {
  private policy: ContextPolicy;
  private scorer: RequestRelevanceScorer;

  constructor(policy: ContextPolicy = DEFAULT_CONTEXT_POLICY) {
    this.policy = policy;
    this.scorer = createRequestRelevanceScorer();
  }

  /**
   * Apply policy to AgentContext to produce BoundedAgentContext.
   *
   * Process:
   * 1. Extract request signals
   * 2. Score all available items by relevance, authority, recency
   * 3. Select top N by score (respecting policy limits)
   * 4. Enforce character budget
   * 5. Track selection metadata (why each item was included)
   * 6. Return bounded context with selection
   *
   * Request is now the primary driver of context selection.
   * For backward compatibility, currentRunId is second parameter.
   */
  apply(
    context: AgentContext,
    currentRunId?: string,
    request: string = ""
  ): BoundedAgentContext {
    // Extract request signals
    const signals = this.scorer.extractSignals(request);

    // Apply selection policies to each category
    const runSelection = this.selectRuns(
      context.recentRuns,
      currentRunId
    );
    const messageSelection = this.selectMessages(
      context.recentMessages,
      context.conversation?.id,
      currentRunId
    );
    const decisionSelection = this.selectDecisions(
      context.projectDecisions,
      signals
    );
    const observationSelection = this.selectObservations(
      context.projectObservations,
      signals
    );
    const taskSelection = this.selectTasks(
      context.projectTasks,
      signals
    );
    const handoffSelection = this.selectHandoffs(
      context.project.id,
      context.identity.id
    );

    // Reorder to maintain relevance ranking (from selectRuns/selectMessages/etc.)
    const reorderBySelection = <T extends { id: string }>(
      items: T[],
      selectedIds: string[]
    ): T[] => {
      return selectedIds
        .map((id) => items.find((item) => item.id === id))
        .filter((item) => item !== undefined) as T[];
    };

    // Filter and reorder by relevance (selection order reflects scoring)
    let boundedRuns = reorderBySelection(context.recentRuns, runSelection.selected);
    let boundedMessages = context.recentMessages.filter((m) =>
      messageSelection.selected.includes(m.id)
    );
    let boundedDecisions = context.projectDecisions.filter((d) =>
      decisionSelection.selected.includes(d.id)
    );
    let boundedObservations = context.projectObservations.filter((o) =>
      observationSelection.selected.includes(o.id)
    );
    let boundedTasks = context.projectTasks.filter((t) =>
      taskSelection.selected.includes(t.id)
    );

    // Enforce character budget by truncating low-relevance items
    const enforceCharacterBudget = (): void => {
      let totalChars = 0;

      // Count characters in selected items
      boundedRuns.forEach((r) => {
        totalChars += (r.prompt?.length ?? 0) + r.id.length;
      });
      boundedMessages.forEach((m) => {
        totalChars += (m.content?.length ?? 0) + m.id.length;
      });
      boundedDecisions.forEach((d) => {
        totalChars += (d.content?.length ?? 0) + d.id.length;
      });
      boundedObservations.forEach((o) => {
        totalChars += (o.content?.length ?? 0) + o.id.length;
      });
      boundedTasks.forEach((t) => {
        totalChars +=
          (t.title?.length ?? 0) + (t.description?.length ?? 0) + t.id.length;
      });

      // If over budget, start dropping low-priority items
      if (totalChars > this.policy.maxCharacters) {
        // Drop non-current runs first
        boundedRuns = boundedRuns.filter((r) => r.id === context.recentRuns[0]?.id);

        // Recalculate
        totalChars = 0;
        boundedRuns.forEach((r) => {
          totalChars += (r.prompt?.length ?? 0) + r.id.length;
        });
        boundedMessages.forEach((m) => {
          totalChars += (m.content?.length ?? 0) + m.id.length;
        });
        boundedDecisions.forEach((d) => {
          totalChars += (d.content?.length ?? 0) + d.id.length;
        });
        boundedObservations.forEach((o) => {
          totalChars += (o.content?.length ?? 0) + o.id.length;
        });
        boundedTasks.forEach((t) => {
          totalChars +=
            (t.title?.length ?? 0) + (t.description?.length ?? 0) + t.id.length;
        });

        // Still over? Drop messages and observations
        if (totalChars > this.policy.maxCharacters) {
          boundedMessages = boundedMessages.slice(0, Math.max(1, Math.floor(boundedMessages.length / 2)));
          boundedObservations = boundedObservations.slice(0, Math.max(1, Math.floor(boundedObservations.length / 2)));
        }
      }
    };

    enforceCharacterBudget();

    return {
      ...context,
      recentRuns: boundedRuns,
      recentMessages: boundedMessages,
      projectDecisions: boundedDecisions,
      projectObservations: boundedObservations,
      projectTasks: boundedTasks,
      selection: {
        runs: runSelection,
        messages: messageSelection,
        decisions: decisionSelection,
        observations: observationSelection,
        tasks: taskSelection,
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

    // Hard filter: only include messages from the agent's conversation
    // This prevents Agent B's private messages from leaking into Agent A's context
    const conversationMessages = conversationId
      ? messages.filter((m) => m.conversationId === conversationId)
      : messages;

    if (conversationMessages.length === 0) {
      return {
        selected: [],
        total: messages.length,
        reason: "No messages from current conversation",
      };
    }

    const scored: RelevanceScore[] = conversationMessages.map((msg) => {
      const signals: string[] = [];
      let score = 0;

      // Signal 1: From current run (highest priority)
      if (currentRunId && msg.runId === currentRunId) {
        score += 500;
        signals.push("current-run");
      }

      // Signal 2: From same conversation (already filtered, so add smaller bonus)
      if (conversationId && msg.conversationId === conversationId) {
        score += 50;
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
      reason: `Selected ${selected.length}/${conversationMessages.length} messages by relevance (same-conversation, current-run, recency)`,
    };
  }

  /**
   * Decision selection - Phase 3.6.
   * Approved decisions are authoritative and score highest.
   * Request relevance determines which decisions to include.
   * This implements "explicit state outranks conversation".
   */
  private selectDecisions(
    decisions: Decision[],
    signals: RequestSignals
  ): ContextSelection {
    if (decisions.length === 0) {
      return {
        selected: [],
        total: 0,
        reason: "No decisions available",
      };
    }

    interface DecisionScore {
      itemId: string;
      score: number;
      signals: string[];
    }

    const scored: DecisionScore[] = decisions.map((dec) => {
      const baseScore = this.scorer.scoreDecision(
        dec.id,
        dec.content,
        dec.status,
        signals
      );

      let totalScore = baseScore.score;
      const allSignals = [...baseScore.reasons];

      // Recency bonus
      const recency = this.scorer.scoreRecency(dec.createdAt);
      totalScore += recency;

      if (recency > 0) {
        allSignals.push(`recency:${recency}`);
      }

      return {
        itemId: dec.id,
        score: totalScore,
        signals: allSignals,
      };
    });

    scored.sort((a, b) => b.score - a.score);

    const selected = scored
      .slice(0, this.policy.maxDecisions)
      .map((s) => s.itemId);

    return {
      selected,
      total: decisions.length,
      reason: `Selected ${selected.length}/${decisions.length} decisions (approved decisions prioritized by request relevance)`,
    };
  }

  /**
   * Observation selection - Phase 3.6.
   * Observations are verified facts from execution.
   * Request relevance determines which observations matter for this request.
   */
  private selectObservations(
    observations: Observation[],
    signals: RequestSignals
  ): ContextSelection {
    if (observations.length === 0) {
      return {
        selected: [],
        total: 0,
        reason: "No observations available",
      };
    }

    interface ObservationScore {
      itemId: string;
      score: number;
      signals: string[];
    }

    const scored: ObservationScore[] = observations.map((obs) => {
      const baseScore = this.scorer.scoreObservation(
        obs.id,
        obs.content,
        obs.type,
        signals
      );

      let totalScore = baseScore.score;
      const allSignals = [...baseScore.reasons];

      // Recency bonus
      const recency = this.scorer.scoreRecency(obs.createdAt);
      totalScore += recency;

      if (recency > 0) {
        allSignals.push(`recency:${recency}`);
      }

      return {
        itemId: obs.id,
        score: totalScore,
        signals: allSignals,
      };
    });

    scored.sort((a, b) => b.score - a.score);

    const selected = scored
      .slice(0, this.policy.maxObservations)
      .map((s) => s.itemId);

    return {
      selected,
      total: observations.length,
      reason: `Selected ${selected.length}/${observations.length} observations (by request relevance and recency)`,
    };
  }

  /**
   * Task selection - Phase 3.6.
   * Open and in_progress tasks are prioritized.
   * Request relevance determines which tasks matter for this request.
   * This is Tier 1 context: current work.
   */
  private selectTasks(
    tasks: Task[],
    signals: RequestSignals
  ): ContextSelection {
    if (tasks.length === 0) {
      return {
        selected: [],
        total: 0,
        reason: "No tasks available",
      };
    }

    interface TaskScore {
      itemId: string;
      score: number;
      signals: string[];
    }

    const scored: TaskScore[] = tasks.map((task) => {
      const baseScore = this.scorer.scoreTask(
        task.id,
        task.title,
        task.description,
        task.status,
        signals
      );

      let totalScore = baseScore.score;
      const allSignals = [...baseScore.reasons];

      // Recency bonus
      const recency = this.scorer.scoreRecency(task.updatedAt);
      totalScore += recency;

      if (recency > 0) {
        allSignals.push(`recency:${recency}`);
      }

      return {
        itemId: task.id,
        score: totalScore,
        signals: allSignals,
      };
    });

    scored.sort((a, b) => b.score - a.score);

    const selected = scored
      .slice(0, this.policy.maxTasks)
      .map((s) => s.itemId);

    return {
      selected,
      total: tasks.length,
      reason: `Selected ${selected.length}/${tasks.length} tasks (active tasks by request relevance)`,
    };
  }

  /**
   * Handoff selection - stub for future phases.
   * Handoffs represent agent-to-agent transitions.
   * To be integrated when multi-agent coordination is added.
   */
  private selectHandoffs(
    _projectId: string,
    _agentId: string
  ): ContextSelection {
    return {
      selected: [],
      total: 0,
      reason: "Handoffs not yet integrated (future phases)",
    };
  }
}

export function createContextPolicyEngine(
  policy?: ContextPolicy
): ContextPolicyEngine {
  return new ContextPolicyEngine(policy || DEFAULT_CONTEXT_POLICY);
}

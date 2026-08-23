/**
 * RequestRelevanceScorer - Deterministic Request-Entity Matching
 *
 * Phase 3.6: Extract signals from request text and score entities based on
 * lexical and structural alignment.
 *
 * Key principles:
 * - No embeddings or semantic models
 * - Deterministic and reproducible
 * - Transparent scoring (each score has reasons)
 * - Conservative (only explicit matches count)
 *
 * Scoring hierarchy:
 * 1. Direct text match in title/description
 * 2. Repository name match
 * 3. Entity type match (Task, Decision, Observation, Run, Message)
 * 4. Recency (newer entities score higher)
 * 5. Status (active tasks/decisions score higher)
 */

export interface RelevanceScore {
  entityId: string;
  entityType: string;
  score: number;
  reasons: string[];
}

interface RequestSignals {
  terms: string[];
  hasAuthority: boolean;
  hasTask: boolean;
  hasError: boolean;
  hasDecision: boolean;
}

export class RequestRelevanceScorer {
  /**
   * Extract signals from request text.
   *
   * Returns:
   * - terms: Significant words from request (excluding stop words)
   * - hasAuthority: Keywords like "auth", "permission", "access"
   * - hasTask: Keywords like "task", "work", "implement", "complete"
   * - hasError: Keywords like "error", "fail", "bug", "fix"
   * - hasDecision: Keywords like "decide", "choice", "approach"
   */
  extractSignals(request: string): RequestSignals {
    const normalized = request.toLowerCase();

    // Extract non-stop-word terms
    const stopWords = new Set([
      "the",
      "a",
      "an",
      "and",
      "or",
      "but",
      "in",
      "on",
      "at",
      "to",
      "for",
      "of",
      "is",
      "was",
      "be",
      "been",
      "are",
      "this",
      "that",
      "with",
      "from",
      "by",
      "as",
      "can",
      "do",
      "did",
      "does",
      "i",
      "you",
      "he",
      "she",
      "it",
      "we",
      "they",
      "what",
      "which",
      "who",
      "why",
      "how",
      "should",
      "could",
      "would",
      "will",
      "must",
      "may",
      "might",
    ]);

    const terms = normalized
      .split(/[\s\-_.,;:!?()[\]{}]+/)
      .filter((term) => term.length > 2 && !stopWords.has(term))
      .slice(0, 20); // Limit to top 20 terms

    return {
      terms: [...new Set(terms)], // Remove duplicates
      hasAuthority:
        /\b(auth|permission|access|credential|login|session|token)\b/.test(
          normalized
        ),
      hasTask:
        /\b(task|work|implement|complete|finish|build|create|fix|update)\b/.test(
          normalized
        ),
      hasError:
        /\b(error|fail|bug|crash|exception|issue|problem|wrong|broken)\b/.test(
          normalized
        ),
      hasDecision:
        /\b(decide|decision|choice|approach|strategy|plan|architecture)\b/.test(
          normalized
        ),
    };
  }

  /**
   * Score a task based on request signals.
   */
  scoreTask(
    taskId: string,
    title: string,
    description: string | undefined,
    status: string,
    signals: RequestSignals
  ): RelevanceScore {
    let score = 0;
    const reasons: string[] = [];

    const text = `${title} ${description || ""}`.toLowerCase();

    // 1. Title/description match (highest signal)
    for (const term of signals.terms) {
      if (text.includes(term)) {
        score += 50;
        reasons.push(`matches term "${term}"`);
        break; // Count once per term
      }
    }

    // 2. Task-related keywords
    if (signals.hasTask) {
      score += 30;
      reasons.push("request is task-related");
    }

    // 3. Status signal
    if (status === "open" || status === "in_progress") {
      score += 20;
      reasons.push("active status");
    } else if (status === "completed") {
      score -= 10;
      reasons.push("completed status");
    }

    return { entityId: taskId, entityType: "Task", score, reasons };
  }

  /**
   * Score a decision based on request signals.
   */
  scoreDecision(
    decisionId: string,
    content: string,
    status: string,
    signals: RequestSignals
  ): RelevanceScore {
    let score = 0;
    const reasons: string[] = [];

    const text = content.toLowerCase();

    // 1. Content match
    for (const term of signals.terms) {
      if (text.includes(term)) {
        score += 40;
        reasons.push(`matches term "${term}"`);
        break;
      }
    }

    // 2. Decision-related keywords
    if (signals.hasDecision) {
      score += 30;
      reasons.push("request is decision-related");
    }

    // 3. Approval status (explicit decisions score high)
    if (status === "approved") {
      score += 50;
      reasons.push("approved (authoritative)");
    } else if (status === "proposed") {
      score += 20;
      reasons.push("proposed status");
    }

    return { entityId: decisionId, entityType: "Decision", score, reasons };
  }

  /**
   * Score an observation based on request signals.
   */
  scoreObservation(
    observationId: string,
    content: string,
    type: string,
    signals: RequestSignals
  ): RelevanceScore {
    let score = 0;
    const reasons: string[] = [];

    const text = content.toLowerCase();

    // 1. Content match
    for (const term of signals.terms) {
      if (text.includes(term)) {
        score += 30;
        reasons.push(`matches term "${term}"`);
        break;
      }
    }

    // 2. Error-related observations
    if (signals.hasError && type === "bug") {
      score += 40;
      reasons.push("bug observation for error request");
    }

    // 3. Architecture/implementation details
    if (signals.hasTask && type === "implementation_detail") {
      score += 25;
      reasons.push("implementation detail for task request");
    }

    return {
      entityId: observationId,
      entityType: "Observation",
      score,
      reasons,
    };
  }

  /**
   * Score recency (newer is better).
   */
  scoreRecency(createdAtIso: string): number {
    const createdMs = new Date(createdAtIso).getTime();
    const nowMs = Date.now();
    const ageHours = (nowMs - createdMs) / (1000 * 60 * 60);

    // Decay over time: -1 point per hour, minimum 0
    return Math.max(0, 20 - Math.floor(ageHours));
  }
}

export function createRequestRelevanceScorer(): RequestRelevanceScorer {
  return new RequestRelevanceScorer();
}

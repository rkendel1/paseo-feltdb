/**
 * DecisionRecorder - Record explicit decisions and human approvals
 *
 * Phase 3: Decisions are more important than observations because they represent
 * intent and commitment. Two sources:
 *
 * 1. Explicit decision signals from agent (structured decision output)
 * 2. Human approval events (user explicitly approves an approach)
 *
 * Human approvals are especially authoritative because they represent human judgment
 * that future agents should respect and learn from.
 *
 * Decision structure:
 * - content: the decision itself (what was decided)
 * - rationale: why (user's explanation)
 * - status: "approved" (human) or "agent_proposed" (for later human review)
 * - scope: what it applies to (project, task, agent, etc.)
 * - relatedTaskId: links to originating task (if from task work)
 * - relatedRunId: links to originating execution
 *
 * Conflicting decisions are represented rather than silently overwritten.
 */

import type { Decision } from "../../state/feltdb/schema.js";
import type { ApprovalGrantedEvent } from "./extraction-events.js";

export interface RecordedDecision {
  /**
   * The decision content - what was decided.
   */
  content: string;

  /**
   * Why this decision was made.
   * Rationale is valuable for future agents to understand context.
   */
  rationale?: string;

  /**
   * Current status of the decision.
   */
  status: Decision["status"];

  /**
   * Who/what made this decision.
   */
  authorType: "user" | "agent" | "system";
  authorId: string;

  /**
   * What scope this decision applies to.
   */
  scope?: string;

  /**
   * Links to related entities for traceability.
   */
  relatedTaskId?: string;
  relatedRunId?: string;
}

export class DecisionRecorder {
  /**
   * Record a decision from a human approval event.
   *
   * Human approvals are the most authoritative decisions because they represent
   * explicit human judgment. These should be given high priority in context selection.
   */
  recordFromApproval(
    event: ApprovalGrantedEvent,
    context: { agentId: string; workspaceId: string; projectId: string }
  ): RecordedDecision | null {
    try {
      // Ensure we have minimal required fields
      if (!event.subject) {
        return null;
      }

      return {
        content: `${event.scope}: ${event.subject}`,
        rationale: event.rationale,
        status: "approved",
        authorType: "user",
        authorId: event.actor,
        scope: context.projectId,
        relatedTaskId: event.relatedTaskId,
        relatedRunId: event.runId,
      };
    } catch {
      // Never block on recording errors
      return null;
    }
  }

  /**
   * Record an agent-proposed decision.
   *
   * Agent-proposed decisions are less authoritative than human approvals.
   * They represent what the agent thinks should happen, but need human validation.
   * Use status: "pending_review" or "agent_proposed" for these.
   */
  recordAgentProposal(
    content: string,
    options: {
      rationale?: string;
      scope?: string;
      agentId: string;
      runId: string;
      relatedTaskId?: string;
    }
  ): RecordedDecision {
    return {
      content,
      rationale: options.rationale,
      status: "proposed",
      authorType: "agent",
      authorId: options.agentId,
      scope: options.scope,
      relatedTaskId: options.relatedTaskId,
      relatedRunId: options.runId,
    };
  }

  /**
   * Detect conflicting decisions and mark accordingly.
   *
   * When two decisions conflict (contradictory intent), represent both rather than
   * silently overwriting. This gives future agents visibility into the conflict.
   */
  detectConflict(
    decisions: Decision[]
  ): { conflictingIds: string[] | null; advice: string | null } {
    if (decisions.length < 2) {
      return { conflictingIds: null, advice: null };
    }

    // Simple conflict detection: look for opposite signals on same scope
    const byScope = new Map<string, Decision[]>();
    for (const d of decisions) {
      const scope = d.content.split(":")[0] || "general";
      if (!byScope.has(scope)) {
        byScope.set(scope, []);
      }
      byScope.get(scope)!.push(d);
    }

    for (const [, scopeDecisions] of byScope.entries()) {
      if (scopeDecisions.length >= 2) {
        const statuses = new Set(scopeDecisions.map((d) => d.status));
        if (statuses.size > 1 && statuses.has("approved") && statuses.has("rejected")) {
          return {
            conflictingIds: scopeDecisions.map((d) => d.id),
            advice: `Conflicting decisions on ${scopeDecisions[0]?.content || "subject"}: some approved, some rejected. Human review needed.`,
          };
        }
      }
    }

    return { conflictingIds: null, advice: null };
  }
}

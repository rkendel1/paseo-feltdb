/**
 * ExecutionFeedbackNormalizer - Normalize Agent Execution Events
 *
 * Phase 3.5.1: Convert provider-specific AgentStreamEvent into provider-neutral
 * ExecutionFeedbackEvent stream. Preserves only observed facts, not inferences.
 *
 * Design principle: If the runtime has it, normalize it. If you'd infer it,
 * don't include it. This becomes the clean seam between provider execution
 * and durable state.
 */

import type { AgentStreamEvent } from "../agent/agent-sdk-types.js";

/**
 * Normalized execution feedback events.
 *
 * Each event represents an OBSERVED FACT from the runtime, not inferred
 * or extracted from model output.
 *
 * Provenance is preserved via runId + timestamp. No event should be
 * persisted as durable state without runId.
 */
export type ExecutionFeedbackEvent =
  | RunTerminalEvent
  | ToolExecutedEvent
  | TimelineMessageEvent;

/**
 * Run completed or failed (terminal state).
 * Provenance: AgentStreamEvent turn_completed | turn_failed
 */
export interface RunTerminalEvent {
  type: "run.terminal";
  runId: string;
  status: "completed" | "failed" | "canceled";
  timestamp: string;

  // From turn_completed
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };

  // From turn_failed or turn_canceled
  error?: string;
  code?: string;
  diagnostic?: string;
  reason?: string; // from turn_canceled
}

/**
 * Tool execution (from timeline tool_call* events).
 * Provenance: AgentStreamEvent timeline item with ToolCallTimelineItem
 *
 * Represents: What tool ran, what input it received, what happened.
 * Does NOT include: inferences about what the tool "means" or success.
 *
 * The tool actually executed and either:
 * - Completed with a result
 * - Failed with an error
 * - Was canceled
 * - Is still running (streaming case)
 */
export interface ToolExecutedEvent {
  type: "tool.executed";
  runId: string;
  timestamp: string;

  toolName: string;
  input: unknown; // exact input passed to tool

  status: "running" | "completed" | "failed" | "canceled";
  result?: unknown; // output if completed
  error?: string; // error message if failed
}

/**
 * Timeline message (user or assistant text).
 * Provenance: AgentStreamEvent timeline item with user_message | assistant_message
 *
 * The exact text that was said, in order.
 * No summarization, no extraction, no semantic interpretation.
 */
export interface TimelineMessageEvent {
  type: "timeline.message";
  runId: string;
  timestamp: string;

  role: "user" | "assistant";
  text: string;

  // Preserved from timeline if available
  messageId?: string;
}

/**
 * ExecutionFeedbackNormalizer
 *
 * Converts AgentStreamEvent sequence into ExecutionFeedbackEvent sequence.
 *
 * Contract:
 * - Provider-neutral (no provider-specific logic)
 * - Fact-preserving (includes only observed events)
 * - Provenance-complete (every event has runId + timestamp)
 * - Ordering-preserving (events in original sequence)
 */
export class ExecutionFeedbackNormalizer {
  /**
   * Normalize an array of AgentStreamEvent into ExecutionFeedbackEvent.
   *
   * This is called after a Run completes, with the full timeline of events.
   * It extracts only the facts Paseo can establish with certainty.
   */
  normalize(
    events: AgentStreamEvent[],
    runId: string,
  ): ExecutionFeedbackEvent[] {
    const result: ExecutionFeedbackEvent[] = [];

    for (const event of events) {
      // Terminal events
      if (event.type === "turn_completed") {
        result.push({
          type: "run.terminal",
          runId,
          status: "completed",
          timestamp: new Date().toISOString(),
          usage: event.usage,
        });
        continue;
      }

      if (event.type === "turn_failed") {
        result.push({
          type: "run.terminal",
          runId,
          status: "failed",
          timestamp: new Date().toISOString(),
          error: event.error,
          code: event.code,
          diagnostic: event.diagnostic,
        });
        continue;
      }

      if (event.type === "turn_canceled") {
        result.push({
          type: "run.terminal",
          runId,
          status: "canceled",
          timestamp: new Date().toISOString(),
          reason: event.reason,
        });
        continue;
      }

      // Timeline events
      if (event.type === "timeline" && event.item) {
        const item = event.item;

        // Tool calls: extract tool execution facts
        if ("toolName" in item && item.toolName) {
          const toolEvent: ToolExecutedEvent = {
            type: "tool.executed",
            runId,
            timestamp: new Date().toISOString(),
            toolName: item.toolName,
            input: "input" in item ? item.input : undefined,
            status: "status" in item ? item.status : "running",
          };

          if ("result" in item && item.result !== undefined && item.result !== null) {
            toolEvent.result = item.result;
          }
          if ("error" in item && item.error !== undefined) {
            toolEvent.error = item.error;
          }

          result.push(toolEvent);
          continue;
        }

        // User/assistant messages: preserve exact text
        if (item.type === "user_message") {
          result.push({
            type: "timeline.message",
            runId,
            timestamp: new Date().toISOString(),
            role: "user",
            text: item.text,
            messageId: item.messageId,
          });
          continue;
        }

        if (item.type === "assistant_message") {
          result.push({
            type: "timeline.message",
            runId,
            timestamp: new Date().toISOString(),
            role: "assistant",
            text: item.text,
          });
          continue;
        }

        // Other timeline items (reasoning, todos, errors) are not normalized yet
        // They can be added in future if needed
      }
    }

    return result;
  }

  /**
   * Stream version: normalize events as they arrive.
   *
   * Returns an async generator that yields ExecutionFeedbackEvent
   * for each observed event. Useful for real-time processing.
   */
  async *normalizeStream(
    events: AsyncIterable<AgentStreamEvent>,
    runId: string,
  ): AsyncGenerator<ExecutionFeedbackEvent> {
    for await (const event of events) {
      const normalized = this.normalize([event], runId);
      for (const feedbackEvent of normalized) {
        yield feedbackEvent;
      }
    }
  }
}

export function createExecutionFeedbackNormalizer(): ExecutionFeedbackNormalizer {
  return new ExecutionFeedbackNormalizer();
}

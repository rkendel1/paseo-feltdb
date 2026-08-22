/**
 * ExecutionFeedbackNormalizer Tests
 *
 * Test realistic execution event sequences to verify:
 * 1. Observed facts are normalized correctly
 * 2. Inferred claims are NOT included
 * 3. Ordering and provenance are preserved
 */

import { describe, it, expect } from "vitest";
import {
  createExecutionFeedbackNormalizer,
  type ExecutionFeedbackEvent,
} from "./execution-feedback-normalizer.js";
import type { AgentStreamEvent } from "../agent/agent-sdk-types.js";

describe("ExecutionFeedbackNormalizer", () => {
  // ========================================================================
  // Test Scenario 1: Simple successful run with tool execution
  // ========================================================================

  describe("1. Tool Execution Events", () => {
    it("should normalize tool execution: started → completed", () => {
      const runId = "run-123";
      const normalizer = createExecutionFeedbackNormalizer();

      const events: AgentStreamEvent[] = [
        {
          type: "timeline",
          item: {
            type: "user_message",
            text: "Check the git log",
          },
          provider: "claude",
        },
        {
          type: "timeline",
          item: {
            toolName: "git",
            status: "running",
          } as any, // tool_call_running
          provider: "claude",
        },
        {
          type: "timeline",
          item: {
            toolName: "git",
            input: { command: "log", limit: 3 },
            result: "commit 1234... Author: ...",
            status: "completed",
          } as any, // tool_call_completed
          provider: "claude",
        },
        {
          type: "timeline",
          item: {
            type: "assistant_message",
            text: "I found 3 recent commits",
          },
          provider: "claude",
        },
        {
          type: "turn_completed",
          provider: "claude",
          usage: { totalTokens: 500 },
        },
      ];

      const normalized = normalizer.normalize(events, runId);

      // Should include:
      // 1. User message
      expect(normalized).toContainEqual(
        expect.objectContaining({
          type: "timeline.message",
          role: "user",
          text: "Check the git log",
          runId,
        }),
      );

      // 2. Tool execution (starting is not explicit, but completed is)
      expect(normalized).toContainEqual(
        expect.objectContaining({
          type: "tool.executed",
          toolName: "git",
          status: "completed",
          result: "commit 1234... Author: ...",
          runId,
        }),
      );

      // 3. Assistant message
      expect(normalized).toContainEqual(
        expect.objectContaining({
          type: "timeline.message",
          role: "assistant",
          text: "I found 3 recent commits",
          runId,
        }),
      );

      // 4. Terminal event
      expect(normalized).toContainEqual(
        expect.objectContaining({
          type: "run.terminal",
          status: "completed",
          runId,
        }),
      );
    });

    it("should normalize failed tool execution", () => {
      const runId = "run-456";
      const normalizer = createExecutionFeedbackNormalizer();

      const events: AgentStreamEvent[] = [
        {
          type: "timeline",
          item: {
            toolName: "curl",
            input: { url: "https://api.example.com/data" },
            error: "HTTP 404 Not Found",
            status: "failed",
          } as any,
          provider: "claude",
        },
        {
          type: "turn_failed",
          provider: "claude",
          error: "Tool execution failed",
        },
      ];

      const normalized = normalizer.normalize(events, runId);

      // Tool failure should be preserved
      expect(normalized).toContainEqual(
        expect.objectContaining({
          type: "tool.executed",
          toolName: "curl",
          status: "failed",
          error: "HTTP 404 Not Found",
          runId,
        }),
      );

      // Terminal failure should be preserved
      expect(normalized).toContainEqual(
        expect.objectContaining({
          type: "run.terminal",
          status: "failed",
          runId,
        }),
      );
    });

    it("should normalize canceled tool execution", () => {
      const runId = "run-789";
      const normalizer = createExecutionFeedbackNormalizer();

      const events: AgentStreamEvent[] = [
        {
          type: "timeline",
          item: {
            toolName: "long-running-task",
            status: "canceled",
          } as any,
          provider: "claude",
        },
        {
          type: "turn_canceled",
          provider: "claude",
          reason: "User requested cancellation",
        },
      ];

      const normalized = normalizer.normalize(events, runId);

      expect(normalized).toContainEqual(
        expect.objectContaining({
          type: "tool.executed",
          toolName: "long-running-task",
          status: "canceled",
          runId,
        }),
      );

      expect(normalized).toContainEqual(
        expect.objectContaining({
          type: "run.terminal",
          status: "canceled",
          reason: "User requested cancellation",
          runId,
        }),
      );
    });
  });

  // ========================================================================
  // Test Scenario 2: Multiple tool calls in sequence
  // ========================================================================

  describe("2. Multiple Tool Calls", () => {
    it("should preserve order of multiple tool executions", () => {
      const runId = "run-multi";
      const normalizer = createExecutionFeedbackNormalizer();

      const events: AgentStreamEvent[] = [
        {
          type: "timeline",
          item: {
            type: "user_message",
            text: "Check git status and git diff",
          },
          provider: "claude",
        },
        // First tool: git status
        {
          type: "timeline",
          item: {
            toolName: "git",
            input: { command: "status" },
            result: "On branch main. Modified: src/auth.ts",
            status: "completed",
          } as any,
          provider: "claude",
        },
        // Second tool: git diff
        {
          type: "timeline",
          item: {
            toolName: "git",
            input: { command: "diff", file: "src/auth.ts" },
            result: "--- a/src/auth.ts\n+++ b/src/auth.ts\n@@ ...",
            status: "completed",
          } as any,
          provider: "claude",
        },
        {
          type: "timeline",
          item: {
            type: "assistant_message",
            text: "I see the authentication changes",
          },
          provider: "claude",
        },
        {
          type: "turn_completed",
          provider: "claude",
        },
      ];

      const normalized = normalizer.normalize(events, runId);

      // Filter to tool events only
      const toolEvents = normalized.filter((e) => e.type === "tool.executed");

      expect(toolEvents).toHaveLength(2);
      expect(toolEvents[0]).toMatchObject({
        toolName: "git",
        input: { command: "status" },
      });
      expect(toolEvents[1]).toMatchObject({
        toolName: "git",
        input: { command: "diff", file: "src/auth.ts" },
      });
    });
  });

  // ========================================================================
  // Critical: Don't infer repository changes from model output
  // ========================================================================

  describe("3. No Inference from Model Output", () => {
    it("should NOT create repository.changed event from assistant prose", () => {
      const runId = "run-inference";
      const normalizer = createExecutionFeedbackNormalizer();

      const events: AgentStreamEvent[] = [
        {
          type: "timeline",
          item: {
            type: "assistant_message",
            text: "I have modified src/auth.ts to add JWT support",
          },
          provider: "claude",
        },
        {
          type: "turn_completed",
          provider: "claude",
        },
      ];

      const normalized = normalizer.normalize(events, runId);

      // Should have message event
      expect(normalized).toContainEqual(
        expect.objectContaining({
          type: "timeline.message",
          role: "assistant",
          text: "I have modified src/auth.ts to add JWT support",
        }),
      );

      // Should NOT have repository.changed event
      const repositoryChangeEvents = normalized.filter(
        (e) => (e as any).type === "repository.changed",
      );
      expect(repositoryChangeEvents).toHaveLength(0);

      // The only way to know about file changes is:
      // 1. A tool (git diff, ls, etc.) executed and returned data
      // 2. Some future filesystem monitoring event (not implemented yet)
      // NOT: parsing model output
    });

    it("should NOT create decision event from assistant prose", () => {
      const runId = "run-decision";
      const normalizer = createExecutionFeedbackNormalizer();

      const events: AgentStreamEvent[] = [
        {
          type: "timeline",
          item: {
            type: "assistant_message",
            text: "I have decided to refactor the authentication module to use OAuth2",
          },
          provider: "claude",
        },
        {
          type: "turn_completed",
          provider: "claude",
        },
      ];

      const normalized = normalizer.normalize(events, runId);

      // Should have message, not decision
      const messageEvents = normalized.filter((e) => e.type === "timeline.message");
      expect(messageEvents).toHaveLength(1);

      const decisionEvents = normalized.filter((e) => (e as any).type === "decision.recorded");
      expect(decisionEvents).toHaveLength(0);

      // Decisions are only recorded via explicit API: agent.recordDecision(...)
    });

    it("should NOT infer task completion from model output", () => {
      const runId = "run-task";
      const normalizer = createExecutionFeedbackNormalizer();

      const events: AgentStreamEvent[] = [
        {
          type: "timeline",
          item: {
            type: "user_message",
            text: "Fix the bug in src/service.ts",
          },
          provider: "claude",
        },
        {
          type: "timeline",
          item: {
            type: "assistant_message",
            text: "I have fixed the bug. The issue was a null pointer exception in line 42.",
          },
          provider: "claude",
        },
        {
          type: "turn_completed",
          provider: "claude",
        },
      ];

      const normalized = normalizer.normalize(events, runId);

      // Should have messages only
      const messageEvents = normalized.filter((e) => e.type === "timeline.message");
      expect(messageEvents).toHaveLength(2);

      // Should NOT have task update
      const taskUpdateEvents = normalized.filter((e) => (e as any).type === "task.updated");
      expect(taskUpdateEvents).toHaveLength(0);

      // Task state is only updated via explicit API: agent.updateTask(...)
    });
  });

  // ========================================================================
  // Test Scenario 4: Provenance preservation
  // ========================================================================

  describe("4. Provenance Preservation", () => {
    it("should include runId on every event capable of durable persistence", () => {
      const runId = "run-provenance";
      const normalizer = createExecutionFeedbackNormalizer();

      const events: AgentStreamEvent[] = [
        {
          type: "timeline",
          item: {
            type: "user_message",
            text: "Execute a test",
          },
          provider: "claude",
        },
        {
          type: "timeline",
          item: {
            toolName: "npm",
            input: { command: "test" },
            result: "PASS",
            status: "completed",
          } as any,
          provider: "claude",
        },
        {
          type: "turn_completed",
          provider: "claude",
          usage: { totalTokens: 300 },
        },
      ];

      const normalized = normalizer.normalize(events, runId);

      // Every event should have runId
      for (const event of normalized) {
        expect(event.runId).toBe(runId);
      }
    });

    it("should preserve timestamp on every event", () => {
      const runId = "run-timestamp";
      const normalizer = createExecutionFeedbackNormalizer();

      const events: AgentStreamEvent[] = [
        {
          type: "timeline",
          item: {
            toolName: "test-tool",
            result: "ok",
            status: "completed",
          } as any,
          provider: "claude",
        },
        {
          type: "turn_completed",
          provider: "claude",
        },
      ];

      const normalized = normalizer.normalize(events, runId);

      for (const event of normalized) {
        expect(event.timestamp).toBeDefined();
        // Should be ISO 8601 format
        expect(() => new Date(event.timestamp)).not.toThrow();
      }
    });
  });

  // ========================================================================
  // Test Scenario 5: Edge cases
  // ========================================================================

  describe("5. Edge Cases", () => {
    it("should handle empty event stream", () => {
      const runId = "run-empty";
      const normalizer = createExecutionFeedbackNormalizer();

      const normalized = normalizer.normalize([], runId);

      expect(normalized).toEqual([]);
    });

    it("should ignore unknown timeline item types", () => {
      const runId = "run-unknown";
      const normalizer = createExecutionFeedbackNormalizer();

      const events: AgentStreamEvent[] = [
        {
          type: "timeline",
          item: {
            type: "reasoning", // We don't normalize reasoning yet
            text: "Let me think about this...",
          } as any,
          provider: "claude",
        },
        {
          type: "timeline",
          item: {
            type: "todo", // We don't normalize todos yet
            items: [
              { text: "Fix bug", completed: false },
              { text: "Test it", completed: true },
            ],
          } as any,
          provider: "claude",
        },
        {
          type: "turn_completed",
          provider: "claude",
        },
      ];

      const normalized = normalizer.normalize(events, runId);

      // Should only have the terminal event
      expect(normalized).toHaveLength(1);
      expect(normalized[0]).toMatchObject({
        type: "run.terminal",
        status: "completed",
      });
    });

    it("should handle tool execution with missing optional fields", () => {
      const runId = "run-minimal";
      const normalizer = createExecutionFeedbackNormalizer();

      const events: AgentStreamEvent[] = [
        {
          type: "timeline",
          item: {
            toolName: "minimal-tool",
            status: "completed",
            // No input, no result
          } as any,
          provider: "claude",
        },
        {
          type: "turn_completed",
          provider: "claude",
        },
      ];

      const normalized = normalizer.normalize(events, runId);

      const toolEvent = normalized.find((e) => e.type === "tool.executed");
      expect(toolEvent).toMatchObject({
        type: "tool.executed",
        toolName: "minimal-tool",
        status: "completed",
        runId,
      });
      expect((toolEvent as any).input).toBeUndefined();
      expect((toolEvent as any).result).toBeUndefined();
    });
  });

  // ========================================================================
  // Provider agnosticism
  // ========================================================================

  describe("6. Provider Agnosticism", () => {
    it("should normalize events regardless of provider", () => {
      const runId = "run-providers";
      const normalizer = createExecutionFeedbackNormalizer();

      const eventsFromClaude: AgentStreamEvent[] = [
        {
          type: "timeline",
          item: {
            toolName: "git",
            result: "ok",
            status: "completed",
          } as any,
          provider: "claude",
        },
        {
          type: "turn_completed",
          provider: "claude",
        },
      ];

      const eventsFromCodex: AgentStreamEvent[] = [
        {
          type: "timeline",
          item: {
            toolName: "git",
            result: "ok",
            status: "completed",
          } as any,
          provider: "codex",
        },
        {
          type: "turn_completed",
          provider: "codex",
        },
      ];

      const normalizedClaude = normalizer.normalize(eventsFromClaude, runId);
      const normalizedCodex = normalizer.normalize(eventsFromCodex, runId);

      // Should produce identical feedback events (provider field removed)
      expect(normalizedClaude).toEqual(normalizedCodex);
    });
  });
});

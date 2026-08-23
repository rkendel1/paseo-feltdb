/**
 * ContextPolicy Tests - Phase 3.2 Deterministic Relevance
 *
 * Tests verify:
 * 1. Policy limits are respected
 * 2. Relevance signals are applied correctly
 * 3. Selection metadata explains decisions
 * 4. CRITICAL: Noise test (naive pagination would fail)
 *
 * The noise test creates a project with enough complexity that
 * a simple "take the newest" approach would fail, proving the
 * policy actually understands relevance.
 */

import { describe, it, expect } from "vitest";
import { createContextPolicyEngine, DEFAULT_CONTEXT_POLICY } from "./context-policy.js";
import type { AgentContext } from "./context-resolver.js";
import type { Message, Run } from "./feltdb/schema.js";

describe("ContextPolicyEngine", () => {
  // ========================================================================
  // Test Fixtures
  // ========================================================================

  function createMockRun(overrides?: Partial<Run>): Run {
    return {
      id: `run-${Math.random().toString(36).substr(2, 9)}`,
      agentId: "agent-1",
      workspaceId: "workspace-1",
      projectId: "project-1",
      provider: "claude",
      prompt: "test prompt",
      status: "completed",
      createdAt: new Date().toISOString(),
      ...overrides,
    } as Run;
  }

  function createMockMessage(overrides?: Partial<Message>): Message {
    return {
      id: `msg-${Math.random().toString(36).substr(2, 9)}`,
      conversationId: "conv-1",
      authorType: "user",
      content: "test message",
      sequence: 1,
      createdAt: new Date().toISOString(),
      ...overrides,
    } as Message;
  }

  function createMockAgentContext(
    overrides?: Partial<AgentContext>
  ): AgentContext {
    return {
      identity: {
        id: "agent-1",
        workspaceId: "workspace-1",
        provider: "claude",
        status: "running",
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
        labels: {},
      } as any,
      project: {
        id: "project-1",
        name: "Project 1",
        kind: "git",
        rootPath: "/path",
        status: "active",
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
      } as any,
      repository: null,
      workspace: {
        id: "workspace-1",
        projectId: "project-1",
        name: "Workspace 1",
        cwd: "/path",
        kind: "local_checkout",
        status: "active",
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
      } as any,
      task: null,
      recentRuns: [],
      conversation: {
        id: "conv-1",
        projectId: "project-1",
        agentId: "agent-1",
        status: "active",
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
      } as any,
      recentMessages: [],
      projectObservations: [],
      projectDecisions: [],
      projectTasks: [],
      ...overrides,
    };
  }

  // ========================================================================
  // 1. Policy Limits
  // ========================================================================

  describe("1. Policy Limits", () => {
    it("should respect maxMessages limit", () => {
      const messages = Array.from({ length: 100 }, (_, i) =>
        createMockMessage({ sequence: i + 1 })
      );

      const engine = createContextPolicyEngine({
        ...DEFAULT_CONTEXT_POLICY,
        maxMessages: 10,
      });

      const context = createMockAgentContext({ recentMessages: messages });
      const bounded = engine.apply(context);

      expect(bounded.selection.messages.selected.length).toBeLessThanOrEqual(10);
      expect(bounded.recentMessages.length).toBeLessThanOrEqual(10);
    });

    it("should respect maxRuns limit", () => {
      const runs = Array.from({ length: 50 }, (_, i) =>
        createMockRun({
          id: `run-${i}`,
          createdAt: new Date(Date.now() - i * 1000 * 60).toISOString(),
        })
      );

      const engine = createContextPolicyEngine({
        ...DEFAULT_CONTEXT_POLICY,
        maxRuns: 5,
      });

      const context = createMockAgentContext({ recentRuns: runs });
      const bounded = engine.apply(context);

      expect(bounded.selection.runs.selected.length).toBeLessThanOrEqual(5);
      expect(bounded.recentRuns.length).toBeLessThanOrEqual(5);
    });
  });

  // ========================================================================
  // 2. Relevance Signals
  // ========================================================================

  describe("2. Relevance Signals", () => {
    it("should prioritize current run", () => {
      const currentRunId = "run-current";
      const oldRun = createMockRun({
        id: "run-old",
        createdAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
      });
      const currentRun = createMockRun({
        id: currentRunId,
        createdAt: new Date().toISOString(),
      });

      const engine = createContextPolicyEngine(DEFAULT_CONTEXT_POLICY);
      const context = createMockAgentContext({
        recentRuns: [oldRun, currentRun],
      });

      const bounded = engine.apply(context, currentRunId);

      // Current run should be selected
      expect(bounded.selection.runs.selected).toContain(currentRunId);
      expect(bounded.recentRuns[0]?.id).toBe(currentRunId);
    });

    it("should prioritize messages from current run", () => {
      const currentRunId = "run-current";
      const oldMessage = createMockMessage({
        id: "msg-old",
        runId: "run-old",
        sequence: 1,
      });
      const currentRunMessage = createMockMessage({
        id: "msg-current",
        runId: currentRunId,
        sequence: 2,
      });
      const unrelatedMessage = createMockMessage({
        id: "msg-unrelated",
        runId: null,
        sequence: 3,
      });

      const engine = createContextPolicyEngine(DEFAULT_CONTEXT_POLICY);
      const context = createMockAgentContext({
        recentMessages: [oldMessage, currentRunMessage, unrelatedMessage],
      });

      const bounded = engine.apply(context, currentRunId);

      // Current run message should appear first in selection
      const selection = bounded.selection.messages.selected;
      const currentMsgIndex = selection.indexOf("msg-current");
      const oldMsgIndex = selection.indexOf("msg-old");

      expect(currentMsgIndex).toBeLessThan(oldMsgIndex);
    });

    it("should prioritize recent messages by sequence", () => {
      const messages = [
        createMockMessage({ id: "msg-1", sequence: 1 }),
        createMockMessage({ id: "msg-2", sequence: 2 }),
        createMockMessage({ id: "msg-3", sequence: 3 }),
      ];

      const engine = createContextPolicyEngine({
        ...DEFAULT_CONTEXT_POLICY,
        maxMessages: 2,
      });

      const context = createMockAgentContext({ recentMessages: messages });
      const bounded = engine.apply(context);

      // Should include the most recent messages (highest sequence)
      expect(bounded.selection.messages.selected).toContain("msg-3");
      expect(bounded.selection.messages.selected).toContain("msg-2");
      expect(bounded.selection.messages.selected).not.toContain("msg-1");
    });
  });

  // ========================================================================
  // 3. Selection Metadata
  // ========================================================================

  describe("3. Selection Metadata (inspectability)", () => {
    it("should provide selection reason for runs", () => {
      const runs = [
        createMockRun({
          id: "run-1",
          createdAt: new Date(Date.now() - 1000).toISOString(),
        }),
      ];

      const engine = createContextPolicyEngine(DEFAULT_CONTEXT_POLICY);
      const context = createMockAgentContext({ recentRuns: runs });
      const bounded = engine.apply(context);

      expect(bounded.selection.runs.reason).toBeDefined();
      expect(bounded.selection.runs.reason.length).toBeGreaterThan(0);
      expect(bounded.selection.runs.total).toBe(1);
      expect(bounded.selection.runs.selected.length).toBe(1);
    });

    it("should provide selection reason for messages", () => {
      const messages = [
        createMockMessage({ id: "msg-1", sequence: 1 }),
      ];

      const engine = createContextPolicyEngine(DEFAULT_CONTEXT_POLICY);
      const context = createMockAgentContext({ recentMessages: messages });
      const bounded = engine.apply(context);

      expect(bounded.selection.messages.reason).toBeDefined();
      expect(bounded.selection.messages.reason.length).toBeGreaterThan(0);
      expect(bounded.selection.messages.total).toBe(1);
      expect(bounded.selection.messages.selected.length).toBe(1);
    });

    it("should indicate when items were not included", () => {
      const engine = createContextPolicyEngine({
        ...DEFAULT_CONTEXT_POLICY,
        maxMessages: 2,
      });

      const messages = Array.from({ length: 100 }, (_, i) =>
        createMockMessage({ sequence: i + 1 })
      );

      const context = createMockAgentContext({ recentMessages: messages });
      const bounded = engine.apply(context);

      expect(bounded.selection.messages.total).toBe(100);
      expect(bounded.selection.messages.selected.length).toBeLessThan(100);
      expect(bounded.selection.messages.reason).toContain("/100");
    });
  });

  // ========================================================================
  // CRITICAL TEST: Noise Test
  // ========================================================================

  describe("CRITICAL: Noise Test (relevance beats recency)", () => {
    it("should select relevant agent context despite newer global activity", () => {
      /**
       * Scenario:
       * - Project has multiple agents (A, B, C)
       * - Agent A has a conversation about "authentication"
       * - Agent B has very recent but unrelated activity
       * - A naive "take the newest" policy would include B's recent work
       * - A smart policy should recognize A's conversation is relevant
       *
       * While we can't yet do true request-aware selection in 3.2,
       * we can verify that selection respects explicit relationships
       * (same conversation, same agent) over just recency.
       */

      // Agent A's relevant conversation: older but same agent/conversation
      const agentAOldMessage = createMockMessage({
        id: "msg-a-1",
        conversationId: "conv-a",
        sequence: 1,
        createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(), // 2 hours ago
      });

      // Agent A's relevant recent message: high priority
      const agentARecentMessage = createMockMessage({
        id: "msg-a-2",
        conversationId: "conv-a",
        sequence: 2,
        createdAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(), // 5 min ago
      });

      // Agent B's very recent message: lower priority (different conversation)
      const agentBRecentMessage = createMockMessage({
        id: "msg-b-1",
        conversationId: "conv-b",
        sequence: 1,
        createdAt: new Date(Date.now() - 1 * 60 * 1000).toISOString(), // 1 min ago (NEWEST)
      });

      // Mix in context
      const context = createMockAgentContext({
        conversation: {
          id: "conv-a",
          projectId: "project-1",
          agentId: "agent-1",
          status: "active",
          createdAt: "2024-01-01T00:00:00Z",
          updatedAt: "2024-01-01T00:00:00Z",
        } as any,
        recentMessages: [
          agentAOldMessage,
          agentARecentMessage,
          agentBRecentMessage, // Newest but different conversation
        ],
      });

      const engine = createContextPolicyEngine({
        ...DEFAULT_CONTEXT_POLICY,
        maxMessages: 2,
      });

      const bounded = engine.apply(context);

      // Both Agent A messages should be selected over Agent B's newer message
      expect(bounded.selection.messages.selected).toContain("msg-a-1");
      expect(bounded.selection.messages.selected).toContain("msg-a-2");
      expect(bounded.selection.messages.selected).not.toContain("msg-b-1");

      // Selection should document why
      expect(bounded.selection.messages.reason).toContain("same-conversation");
    });

    it("should prefer current run messages even if older than unrelated messages", () => {
      const currentRunId = "run-current";

      // Current run's messages (older but relevant)
      const currentRunMsg1 = createMockMessage({
        id: "current-1",
        runId: currentRunId,
        sequence: 1,
        createdAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(), // 10 min ago
      });

      const currentRunMsg2 = createMockMessage({
        id: "current-2",
        runId: currentRunId,
        sequence: 2,
        createdAt: new Date(Date.now() - 9 * 60 * 1000).toISOString(), // 9 min ago
      });

      // Previous run's very recent message (newest but not current run)
      const oldRunRecentMsg = createMockMessage({
        id: "old-run-1",
        runId: "run-old",
        sequence: 3,
        createdAt: new Date(Date.now() - 30 * 1000).toISOString(), // 30 sec ago (NEWEST)
      });

      const context = createMockAgentContext({
        recentMessages: [currentRunMsg1, currentRunMsg2, oldRunRecentMsg],
      });

      const engine = createContextPolicyEngine({
        ...DEFAULT_CONTEXT_POLICY,
        maxMessages: 2,
      });

      const bounded = engine.apply(context, currentRunId);

      // Both current run messages should be prioritized
      expect(bounded.selection.messages.selected).toContain("current-1");
      expect(bounded.selection.messages.selected).toContain("current-2");
      expect(bounded.selection.messages.selected).not.toContain("old-run-1");
    });
  });

  // ========================================================================
  // 4. Empty and Edge Cases
  // ========================================================================

  describe("4. Edge Cases", () => {
    it("should handle empty context gracefully", () => {
      const engine = createContextPolicyEngine(DEFAULT_CONTEXT_POLICY);
      const context = createMockAgentContext({
        recentRuns: [],
        recentMessages: [],
      });

      const bounded = engine.apply(context);

      expect(bounded.recentRuns).toEqual([]);
      expect(bounded.recentMessages).toEqual([]);
      expect(bounded.selection.runs.total).toBe(0);
      expect(bounded.selection.messages.total).toBe(0);
    });

    it("should preserve context when below policy limits", () => {
      const runs = [
        createMockRun({ id: "run-1" }),
        createMockRun({ id: "run-2" }),
      ];

      const messages = [
        createMockMessage({ id: "msg-1", sequence: 1 }),
        createMockMessage({ id: "msg-2", sequence: 2 }),
      ];

      const engine = createContextPolicyEngine({
        ...DEFAULT_CONTEXT_POLICY,
        maxRuns: 100,
        maxMessages: 100,
      });

      const context = createMockAgentContext({
        recentRuns: runs,
        recentMessages: messages,
      });

      const bounded = engine.apply(context);

      expect(bounded.recentRuns).toEqual(runs);
      expect(bounded.recentMessages).toEqual(messages);
    });
  });

  // ========================================================================
  // 5. Determinsm
  // ========================================================================

  describe("5. Determinism", () => {
    it("should produce same result for same input", () => {
      const runs = [
        createMockRun({ id: "run-1" }),
        createMockRun({ id: "run-2" }),
      ];

      const context = createMockAgentContext({ recentRuns: runs });
      const engine = createContextPolicyEngine(DEFAULT_CONTEXT_POLICY);

      const bounded1 = engine.apply(context);
      const bounded2 = engine.apply(context);

      expect(bounded1.selection.runs.selected).toEqual(
        bounded2.selection.runs.selected
      );
    });
  });
});

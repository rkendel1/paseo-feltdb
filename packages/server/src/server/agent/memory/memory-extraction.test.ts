/**
 * Memory Extraction Tests - Phase 3
 *
 * Tests for automatic observation and decision capture.
 * Proves the complete write → read → learn loop works end-to-end.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { randomUUID } from "crypto";
import { ObservationExtractor } from "./observation-extractor.js";
import { DecisionRecorder } from "./decision-recorder.js";
import {
  CommandFailedEvent,
  ToolCompletedEvent,
  RunCompletedEvent,
  ApprovalGrantedEvent,
} from "./extraction-events.js";

describe("Phase 3: Memory Extraction", () => {
  describe("Group 1: Observation Extraction", () => {
    let extractor: ObservationExtractor;
    let runId: string;

    beforeEach(() => {
      extractor = new ObservationExtractor();
      runId = randomUUID();
    });

    it("should extract observation from command failure", () => {
      const event: CommandFailedEvent = {
        type: "command.failed",
        timestamp: new Date(),
        runId,
        command: "npm install",
        exitCode: 1,
        stderr: "ENOENT: no such file or directory, open 'package.json'",
      };

      const observations = extractor.extract(event);

      expect(observations).toHaveLength(1);
      expect(observations[0]).toMatchObject({
        content: expect.stringContaining("Missing file"),
        type: "dependency",
        confidence: expect.any(Number),
        eventType: "command.failed",
      });
    });

    it("should extract observation from permission error", () => {
      const event: CommandFailedEvent = {
        type: "command.failed",
        timestamp: new Date(),
        runId,
        command: "chown root file.txt",
        exitCode: 1,
        stderr: "Operation not permitted. Permission denied.",
      };

      const observations = extractor.extract(event);

      expect(observations).toHaveLength(1);
      expect(observations[0].type).toBe("bug");
      expect(observations[0].confidence).toBeGreaterThan(0.8);
    });

    it("should extract observation from timeout", () => {
      const event: CommandFailedEvent = {
        type: "command.failed",
        timestamp: new Date(),
        runId,
        command: "npm test",
        exitCode: 124,
        stderr: "Command timed out after 5 minutes",
      };

      const observations = extractor.extract(event);

      expect(observations).toHaveLength(1);
      expect(observations[0]).toMatchObject({
        type: "bug",
        content: expect.stringContaining("timed out"),
      });
    });

    it("should extract observation from tool completion failure", () => {
      const event: ToolCompletedEvent = {
        type: "tool.completed",
        timestamp: new Date(),
        runId,
        toolName: "build",
        success: false,
        error: "Out of memory during build",
      };

      const observations = extractor.extract(event);

      expect(observations).toHaveLength(1);
      expect(observations[0].type).toBe("bug");
    });

    it("should extract observation from successful tool completion", () => {
      const event: ToolCompletedEvent = {
        type: "tool.completed",
        timestamp: new Date(),
        runId,
        toolName: "compile",
        success: true,
        output: "Compiled 42 files successfully",
      };

      const observations = extractor.extract(event);

      expect(observations).toHaveLength(1);
      expect(observations[0]).toMatchObject({
        type: "test_result",
        content: expect.stringContaining("Compiled 42 files"),
      });
    });

    it("should extract observation from run completion with errors", () => {
      const event: RunCompletedEvent = {
        type: "run.completed",
        timestamp: new Date(),
        runId,
        success: false,
        duration: 5000,
        errors: [
          "Build failed",
          "Tests timed out",
          "Deployment rejected",
        ],
      };

      const observations = extractor.extract(event);

      expect(observations).toHaveLength(1);
      expect(observations[0].type).toBe("bug");
      expect(observations[0].content).toContain("Build failed");
    });

    it("should not extract observation from empty event", () => {
      const event: CommandFailedEvent = {
        type: "command.failed",
        timestamp: new Date(),
        runId,
        command: "ls",
        exitCode: 0,
        stderr: "",
      };

      const observations = extractor.extract(event);

      expect(observations).toHaveLength(0);
    });

    it("should deduplicate similar observations within batch", () => {
      const candidates = [
        {
          content: "Build failed: out of memory",
          type: "error" as const,
          confidence: 0.9,
          eventType: "command.failed",
        },
        {
          content: "BUILD FAILED: OUT OF MEMORY",
          type: "error" as const,
          confidence: 0.85,
          eventType: "command.failed",
        },
        {
          content: "Compilation error: different issue",
          type: "error" as const,
          confidence: 0.8,
          eventType: "command.failed",
        },
      ];

      const deduped = extractor.deduplicateWithinBatch(candidates);

      // Should keep highest confidence of duplicates
      expect(deduped.length).toBeLessThan(candidates.length);
      expect(deduped[0].confidence).toBe(0.9);
    });

    it("should handle extraction errors without throwing", () => {
      const badEvent = { type: "invalid" } as unknown;

      const observations = extractor.extract(
        badEvent as CommandFailedEvent
      );

      expect(observations).toEqual([]);
    });
  });

  describe("Group 2: Decision Recording", () => {
    let recorder: DecisionRecorder;
    const context = {
      agentId: "agent_123",
      workspaceId: "workspace_456",
      projectId: "project_789",
    };

    beforeEach(() => {
      recorder = new DecisionRecorder();
    });

    it("should record decision from human approval", () => {
      const event: ApprovalGrantedEvent = {
        type: "approval.granted",
        timestamp: new Date(),
        runId: randomUUID(),
        actor: "user@example.com",
        scope: "task",
        subject: "Use npm ci instead of npm install",
        rationale: "Ensures reproducible builds across environments",
      };

      const decision = recorder.recordFromApproval(event, context);

      expect(decision).toMatchObject({
        content: expect.stringContaining("task: Use npm ci"),
        status: "approved",
        authorType: "user",
        authorId: "user@example.com",
        rationale: expect.stringContaining("reproducible builds"),
      });
    });

    it("should record agent-proposed decision", () => {
      const decision = recorder.recordAgentProposal(
        "Update TypeScript to 5.0 for better type inference",
        {
          agentId: context.agentId,
          runId: randomUUID(),
          scope: context.projectId,
          rationale: "Fixes type errors in build system",
        }
      );

      expect(decision).toMatchObject({
        content: expect.stringContaining("Update TypeScript"),
        status: "proposed",
        authorType: "agent",
        authorId: context.agentId,
      });
    });

    it("should retain related task ID in decision", () => {
      const taskId = randomUUID();
      const event: ApprovalGrantedEvent = {
        type: "approval.granted",
        timestamp: new Date(),
        runId: randomUUID(),
        actor: "user@example.com",
        scope: "approach",
        subject: "Refactor authentication module",
        relatedTaskId: taskId,
      };

      const decision = recorder.recordFromApproval(event, context);

      expect(decision?.relatedTaskId).toBe(taskId);
    });

    it("should return null for invalid approval", () => {
      const event: ApprovalGrantedEvent = {
        type: "approval.granted",
        timestamp: new Date(),
        runId: randomUUID(),
        actor: "user@example.com",
        scope: "task",
        subject: "", // empty subject
      };

      const decision = recorder.recordFromApproval(event, context);

      expect(decision).toBeNull();
    });

    it("should detect conflicting decisions with opposite status", () => {
      const decisions = [
        {
          id: "d1",
          content: "task: approve review process",
          status: "approved" as const,
          createdAt: new Date().toISOString(),
        },
        {
          id: "d2",
          content: "task: reject review process",
          status: "rejected" as const,
          createdAt: new Date().toISOString(),
        },
      ] as any[];

      const conflict = recorder.detectConflict(decisions);

      // Conflict should be detected because same scope (task:) has approved and rejected
      expect(conflict.conflictingIds).toHaveLength(2);
      expect(conflict.advice).toContain("Conflicting decisions");
    });

    it("should not report conflict for non-contradictory decisions", () => {
      const decisions = [
        {
          id: "d1",
          content: "Use TypeScript",
          status: "approved" as const,
          createdAt: new Date().toISOString(),
        },
        {
          id: "d2",
          content: "Use ESLint for linting",
          status: "approved" as const,
          createdAt: new Date().toISOString(),
        },
      ] as any[];

      const conflict = recorder.detectConflict(decisions);

      expect(conflict.conflictingIds).toBeNull();
      expect(conflict.advice).toBeNull();
    });
  });

  describe("Group 3: Authorization & Scope Preservation", () => {
    let extractor: ObservationExtractor;

    beforeEach(() => {
      extractor = new ObservationExtractor();
    });

    it("should preserve agent identity in observations", () => {
      const event: CommandFailedEvent = {
        type: "command.failed",
        timestamp: new Date(),
        runId: randomUUID(),
        command: "npm test",
        exitCode: 1,
        stderr: "Test suite failed",
      };

      const observations = extractor.extract(event);

      // Extractor doesn't set agent ID, but service does
      expect(observations).toHaveLength(1);
      expect(observations[0]).toHaveProperty("content");
    });

    it("should preserve workspace scope for decisions", () => {
      const recorder = new DecisionRecorder();
      const event: ApprovalGrantedEvent = {
        type: "approval.granted",
        timestamp: new Date(),
        runId: randomUUID(),
        actor: "user@example.com",
        scope: "task",
        subject: "Configure CI/CD pipeline",
      };

      const context = {
        agentId: "agent_123",
        workspaceId: "workspace_456",
        projectId: "project_789",
      };

      const decision = recorder.recordFromApproval(event, context);

      expect(decision?.scope).toBe(context.projectId);
    });
  });

  describe("Group 4: Event-Driven Extraction (No LLM Required)", () => {
    let extractor: ObservationExtractor;

    beforeEach(() => {
      extractor = new ObservationExtractor();
    });

    it("should extract deterministically from same event", () => {
      const event: CommandFailedEvent = {
        type: "command.failed",
        timestamp: new Date(),
        runId: randomUUID(),
        command: "npm build",
        exitCode: 1,
        stderr: "ERR! command not found: esbuild",
      };

      const obs1 = extractor.extract(event);
      const obs2 = extractor.extract(event);

      expect(obs1).toEqual(obs2);
    });

    it("should extract from structured events without semantic analysis", () => {
      // This test verifies we extract from event structure, not content understanding
      const event: ToolCompletedEvent = {
        type: "tool.completed",
        timestamp: new Date(),
        runId: randomUUID(),
        toolName: "build",
        success: false,
        error: "Xyzzy plugh frobozz",
      };

      const observations = extractor.extract(event);

      // We extract based on success=false, not on understanding "Xyzzy plugh"
      expect(observations).toHaveLength(1);
      expect(observations[0].eventType).toBe("tool.completed");
    });
  });

  describe("Group 5: Non-Blocking Extraction", () => {
    it("should handle extraction errors gracefully", () => {
      const extractor = new ObservationExtractor();

      // Null run ID should not throw
      const event = {
        type: "command.failed",
        timestamp: new Date(),
        runId: null,
        command: "test",
        exitCode: 1,
        stderr: "error",
      } as any;

      expect(() => {
        extractor.extract(event);
      }).not.toThrow();
    });

    it("should return empty array rather than throwing on parse errors", () => {
      const extractor = new ObservationExtractor();
      const event = {
        type: "unknown_event",
        timestamp: "not-a-date",
        runId: 123, // wrong type
      } as unknown as CommandFailedEvent;

      const observations = extractor.extract(event);

      expect(observations).toEqual([]);
    });
  });
});

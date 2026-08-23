/**
 * AgentContextService Tests - Phase 3.3 Injection & Failure Isolation
 *
 * Tests verify:
 * 1. Actual injection (complete pipeline)
 * 2. Provider isolation (semantic context, no FeltDB knowledge)
 * 3. Context observability (logs/summary)
 * 4. Failure isolation (BLOCK vs FALLBACK policies)
 * 5. Empty context (new agent works)
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Logger } from "pino";
import {
  createAgentContextService,
  ContextResolutionFailurePolicy,
  type AgentContextService,
} from "./agent-context-service.js";
import type { PaseoState } from "./paseo-state.js";
import type { Agent, Conversation, Message, Project, Run, Workspace } from "./feltdb/schema.js";

// Mock logger
const mockLogger: Logger = {
  child: vi.fn().mockReturnThis(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as any;

describe("AgentContextService", () => {
  let mockPaseoState: Partial<PaseoState>;
  let service: AgentContextService;

  beforeEach(() => {
    vi.clearAllMocks();

    // Initialize mock PaseoState
    mockPaseoState = {
      agents: { getById: vi.fn() },
      workspaces: { getById: vi.fn() },
      projects: { getById: vi.fn() },
      repositories: { getById: vi.fn() },
      runs: { listByAgent: vi.fn() },
      conversations: { listByAgent: vi.fn() },
      messages: { listByConversation: vi.fn() },
      observations: { listByProject: vi.fn().mockResolvedValue([]) },
      decisions: { listByProject: vi.fn().mockResolvedValue([]) },
      tasks: { listByProject: vi.fn().mockResolvedValue([]) },
    } as any;

    service = createAgentContextService({
      paseoState: mockPaseoState as PaseoState,
      logger: mockLogger,
    });
  });

  // ========================================================================
  // 1. Actual Injection (Complete Pipeline)
  // ========================================================================

  describe("1. Actual Injection", () => {
    it("should resolve complete turn context through full pipeline", async () => {
      const agent: Agent = {
        id: "agent-1",
        workspaceId: "workspace-1",
        provider: "claude",
        status: "running",
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
        labels: {},
      } as Agent;

      const workspace: Workspace = {
        id: "workspace-1",
        projectId: "project-1",
        name: "Workspace 1",
        cwd: "/path/to/workspace",
        kind: "local_checkout",
        status: "active",
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
      } as Workspace;

      const project: Project = {
        id: "project-1",
        name: "Project 1",
        kind: "git",
        rootPath: "/path/to/project",
        status: "active",
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
      } as Project;

      const conversation: Conversation = {
        id: "conv-1",
        projectId: "project-1",
        agentId: "agent-1",
        status: "active",
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
      } as Conversation;

      const message: Message = {
        id: "msg-1",
        conversationId: "conv-1",
        authorType: "user",
        content: "Hello",
        sequence: 1,
        createdAt: "2024-01-01T00:00:00Z",
      } as Message;

      const run: Run = {
        id: "run-1",
        agentId: "agent-1",
        workspaceId: "workspace-1",
        projectId: "project-1",
        provider: "claude",
        prompt: "test",
        status: "completed",
        createdAt: "2024-01-01T00:00:00Z",
      } as Run;

      vi.mocked(mockPaseoState.agents!.getById).mockResolvedValue(agent);
      vi.mocked(mockPaseoState.workspaces!.getById).mockResolvedValue(
        workspace
      );
      vi.mocked(mockPaseoState.projects!.getById).mockResolvedValue(project);
      vi.mocked(mockPaseoState.repositories!.getById).mockResolvedValue(null);
      vi.mocked(mockPaseoState.runs!.listByAgent).mockResolvedValue([run]);
      vi.mocked(mockPaseoState.conversations!.listByAgent).mockResolvedValue([
        conversation,
      ]);
      vi.mocked(mockPaseoState.messages!.listByConversation).mockResolvedValue(
        [message]
      );

      const result = await service.resolveForTurn(
        "agent-1",
        "do something",
        "run-1"
      );

      expect(result.success).toBe(true);
      if (!result.success) throw new Error("Expected success");

      const { turnContext } = result;

      // Verify complete pipeline output
      expect(turnContext.request).toBe("do something");
      expect(turnContext.context.identity.id).toBe("agent-1");
      expect(turnContext.context.project.id).toBe("project-1");
      expect(turnContext.context.workspace.id).toBe("workspace-1");
      expect(turnContext.context.conversation).toEqual(conversation);
      expect(turnContext.context.recentMessages).toContain(message);
      expect(turnContext.context.recentRuns).toContain(run);

      // Verify projection was created
      expect(turnContext.projection.text).toBeDefined();
      expect(turnContext.projection.summary).toBeDefined();
      expect(turnContext.projection.text.length).toBeGreaterThan(0);
    });
  });

  // ========================================================================
  // 2. Provider Isolation (Semantic Context, No FeltDB Knowledge)
  // ========================================================================

  describe("2. Provider Isolation", () => {
    it("should return provider-neutral AgentTurnContext", async () => {
      const agent: Agent = {
        id: "agent-1",
        workspaceId: "workspace-1",
        provider: "claude",
        status: "running",
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
        labels: {},
      } as Agent;

      const workspace: Workspace = {
        id: "workspace-1",
        projectId: "project-1",
        name: "Workspace 1",
        cwd: "/path",
        kind: "local_checkout",
        status: "active",
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
      } as Workspace;

      const project: Project = {
        id: "project-1",
        name: "Project 1",
        kind: "git",
        rootPath: "/path",
        status: "active",
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
      } as Project;

      vi.mocked(mockPaseoState.agents!.getById).mockResolvedValue(agent);
      vi.mocked(mockPaseoState.workspaces!.getById).mockResolvedValue(
        workspace
      );
      vi.mocked(mockPaseoState.projects!.getById).mockResolvedValue(project);
      vi.mocked(mockPaseoState.repositories!.getById).mockResolvedValue(null);
      vi.mocked(mockPaseoState.runs!.listByAgent).mockResolvedValue([]);
      vi.mocked(mockPaseoState.conversations!.listByAgent).mockResolvedValue(
        []
      );

      const result = await service.resolveForTurn(
        "agent-1",
        "request",
        "run-1"
      );

      expect(result.success).toBe(true);
      if (!result.success) throw new Error("Expected success");

      // AgentTurnContext should have no FeltDB-specific fields
      const { turnContext } = result;
      const turnContextKeys = Object.keys(turnContext);
      expect(turnContextKeys).toEqual(
        expect.arrayContaining(["request", "context", "projection"])
      );

      // Projection is provider-neutral (plain text, not JSON)
      expect(typeof turnContext.projection.text).toBe("string");
      expect(typeof turnContext.projection.summary).toBe("object");

      // Context is semantic, not FeltDB-specific
      expect(turnContext.context.identity.provider).toBe("claude");
      expect(turnContext.context.project.name).toBe("Project 1");
    });

    it("should create canonical text projection (readable, non-technical)", async () => {
      const agent: Agent = {
        id: "agent-1",
        workspaceId: "workspace-1",
        provider: "claude",
        status: "running",
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
        labels: {},
      } as Agent;

      const workspace: Workspace = {
        id: "workspace-1",
        projectId: "project-1",
        name: "Workspace 1",
        cwd: "/path",
        kind: "local_checkout",
        status: "active",
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
      } as Workspace;

      const project: Project = {
        id: "project-1",
        name: "Project 1",
        kind: "git",
        rootPath: "/path",
        status: "active",
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
      } as Project;

      vi.mocked(mockPaseoState.agents!.getById).mockResolvedValue(agent);
      vi.mocked(mockPaseoState.workspaces!.getById).mockResolvedValue(
        workspace
      );
      vi.mocked(mockPaseoState.projects!.getById).mockResolvedValue(project);
      vi.mocked(mockPaseoState.repositories!.getById).mockResolvedValue(null);
      vi.mocked(mockPaseoState.runs!.listByAgent).mockResolvedValue([]);
      vi.mocked(mockPaseoState.conversations!.listByAgent).mockResolvedValue(
        []
      );

      const result = await service.resolveForTurn(
        "agent-1",
        "request",
        "run-1"
      );

      expect(result.success).toBe(true);
      if (!result.success) throw new Error("Expected success");

      const text = result.turnContext.projection.text;

      // Should contain readable sections
      expect(text).toContain("# Paseo Context");
      expect(text).toContain("## Project");
      expect(text).toContain("## Workspace");
      expect(text).toContain("Project 1");
      expect(text).toContain("Workspace 1");

      // Should NOT contain FeltDB internals
      expect(text).not.toContain("projectId");
      expect(text).not.toContain("workspaceId");
      expect(text).not.toContain("FeltDB");
    });
  });

  // ========================================================================
  // 3. Context Observability
  // ========================================================================

  describe("3. Context Observability", () => {
    it("should provide summary for logging/debugging", async () => {
      const agent: Agent = {
        id: "agent-1",
        workspaceId: "workspace-1",
        provider: "claude",
        status: "running",
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
        labels: {},
      } as Agent;

      const workspace: Workspace = {
        id: "workspace-1",
        projectId: "project-1",
        name: "Workspace 1",
        cwd: "/path",
        kind: "local_checkout",
        status: "active",
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
      } as Workspace;

      const project: Project = {
        id: "project-1",
        name: "Project 1",
        kind: "git",
        rootPath: "/path",
        status: "active",
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
      } as Project;

      const run: Run = {
        id: "run-1",
        agentId: "agent-1",
        workspaceId: "workspace-1",
        projectId: "project-1",
        provider: "claude",
        prompt: "test",
        status: "completed",
        createdAt: "2024-01-01T00:00:00Z",
      } as Run;

      const message: Message = {
        id: "msg-1",
        conversationId: "conv-1",
        authorType: "user",
        content: "test",
        sequence: 1,
        createdAt: "2024-01-01T00:00:00Z",
      } as Message;

      const conversation: Conversation = {
        id: "conv-1",
        projectId: "project-1",
        agentId: "agent-1",
        status: "active",
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
      } as Conversation;

      vi.mocked(mockPaseoState.agents!.getById).mockResolvedValue(agent);
      vi.mocked(mockPaseoState.workspaces!.getById).mockResolvedValue(
        workspace
      );
      vi.mocked(mockPaseoState.projects!.getById).mockResolvedValue(project);
      vi.mocked(mockPaseoState.repositories!.getById).mockResolvedValue(null);
      vi.mocked(mockPaseoState.runs!.listByAgent).mockResolvedValue([run]);
      vi.mocked(mockPaseoState.conversations!.listByAgent).mockResolvedValue([
        conversation,
      ]);
      vi.mocked(mockPaseoState.messages!.listByConversation).mockResolvedValue(
        [message]
      );

      const result = await service.resolveForTurn(
        "agent-1",
        "request",
        "run-1"
      );

      expect(result.success).toBe(true);
      if (!result.success) throw new Error("Expected success");

      const summary = result.turnContext.projection.summary;

      // Summary should contain all key observability fields
      expect(summary.project).toBe("Project 1");
      expect(summary.workspace).toBe("Workspace 1");
      expect(summary.conversationActive).toBe(true);
      expect(summary.runsCount).toBe(1);
      expect(summary.messagesCount).toBe(1);

      // Logger should have been called with summary
      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.objectContaining({
          summary: expect.objectContaining({
            project: "Project 1",
          }),
        }),
        expect.any(String)
      );
    });
  });

  // ========================================================================
  // 4. Failure Isolation (BLOCK vs FALLBACK)
  // ========================================================================

  describe("4. Failure Isolation", () => {
    it("should return error with BLOCK policy (default)", async () => {
      vi.mocked(mockPaseoState.agents!.getById).mockResolvedValue(null);

      const result = await service.resolveForTurn(
        "missing-agent",
        "request",
        "run-1"
      );

      expect(result.success).toBe(false);
      if (result.success) throw new Error("Expected failure");

      expect(result.error).toContain("Agent not found");
      expect(result.reason).toBe("agent_not_found");

      // Logger should record the error
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.any(Object),
        expect.stringContaining("BLOCK")
      );
    });

    it("should allow caller to handle BLOCK failure gracefully", async () => {
      vi.mocked(mockPaseoState.agents!.getById).mockResolvedValue(null);

      const result = await service.resolveForTurn(
        "missing-agent",
        "request",
        "run-1"
      );

      // Caller can check result and decide how to proceed
      if (!result.success) {
        expect(result.reason).toBe("agent_not_found");
        // Caller could:
        // - Show error to user
        // - Return explicit error response
        // - Log and alert
      } else {
        throw new Error("Expected failure");
      }
    });

    it("should allow runtime configuration of failure policy", async () => {
      // Change policy to FALLBACK
      service.setFailurePolicy(ContextResolutionFailurePolicy.FALLBACK);
      expect(service.getFailurePolicy()).toBe(
        ContextResolutionFailurePolicy.FALLBACK
      );

      // Logger should record the policy change
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          policy: ContextResolutionFailurePolicy.FALLBACK,
        }),
        expect.any(String)
      );
    });
  });

  // ========================================================================
  // 5. Empty Context (New Agent)
  // ========================================================================

  describe("5. Empty Context (New Agent)", () => {
    it("should handle brand-new agent with no history", async () => {
      const agent: Agent = {
        id: "agent-1",
        workspaceId: "workspace-1",
        provider: "claude",
        status: "running",
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
        labels: {},
      } as Agent;

      const workspace: Workspace = {
        id: "workspace-1",
        projectId: "project-1",
        name: "New Workspace",
        cwd: "/path",
        kind: "local_checkout",
        status: "active",
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
      } as Workspace;

      const project: Project = {
        id: "project-1",
        name: "New Project",
        kind: "git",
        rootPath: "/path",
        status: "active",
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
      } as Project;

      // Empty history
      vi.mocked(mockPaseoState.agents!.getById).mockResolvedValue(agent);
      vi.mocked(mockPaseoState.workspaces!.getById).mockResolvedValue(
        workspace
      );
      vi.mocked(mockPaseoState.projects!.getById).mockResolvedValue(project);
      vi.mocked(mockPaseoState.repositories!.getById).mockResolvedValue(null);
      vi.mocked(mockPaseoState.runs!.listByAgent).mockResolvedValue([]); // No runs
      vi.mocked(mockPaseoState.conversations!.listByAgent).mockResolvedValue(
        []
      ); // No conversation
      vi.mocked(mockPaseoState.messages!.listByConversation).mockResolvedValue(
        []
      ); // No messages

      const result = await service.resolveForTurn(
        "agent-1",
        "start new task",
        "run-1"
      );

      expect(result.success).toBe(true);
      if (!result.success) throw new Error("Expected success");

      const { turnContext } = result;

      // Should have valid minimal context
      expect(turnContext.context.identity).toBeDefined();
      expect(turnContext.context.project).toBeDefined();
      expect(turnContext.context.workspace).toBeDefined();
      expect(turnContext.context.conversation).toBeNull();
      expect(turnContext.context.recentMessages).toEqual([]);
      expect(turnContext.context.recentRuns).toEqual([]);

      // Projection should still be valid
      expect(turnContext.projection.text).toBeDefined();
      expect(turnContext.projection.text).toContain("# Paseo Context");
      expect(turnContext.projection.text).toContain("No conversation history");
    });

    it("should provide valid context even with empty history", async () => {
      const agent: Agent = {
        id: "agent-1",
        workspaceId: "workspace-1",
        provider: "claude",
        status: "running",
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
        labels: {},
      } as Agent;

      const workspace: Workspace = {
        id: "workspace-1",
        projectId: "project-1",
        name: "Workspace",
        cwd: "/path",
        kind: "local_checkout",
        status: "active",
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
      } as Workspace;

      const project: Project = {
        id: "project-1",
        name: "Project",
        kind: "git",
        rootPath: "/path",
        status: "active",
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
      } as Project;

      vi.mocked(mockPaseoState.agents!.getById).mockResolvedValue(agent);
      vi.mocked(mockPaseoState.workspaces!.getById).mockResolvedValue(
        workspace
      );
      vi.mocked(mockPaseoState.projects!.getById).mockResolvedValue(project);
      vi.mocked(mockPaseoState.repositories!.getById).mockResolvedValue(null);
      vi.mocked(mockPaseoState.runs!.listByAgent).mockResolvedValue([]);
      vi.mocked(mockPaseoState.conversations!.listByAgent).mockResolvedValue(
        []
      );

      const result = await service.resolveForTurn(
        "agent-1",
        "new request",
        "run-1"
      );

      expect(result.success).toBe(true);
      if (!result.success) throw new Error("Expected success");

      const summary = result.turnContext.projection.summary;

      // Summary should show 0 items
      expect(summary.runsCount).toBe(0);
      expect(summary.messagesCount).toBe(0);
      expect(summary.conversationActive).toBe(false);

      // But should still provide project/workspace context
      expect(summary.project).toBeDefined();
      expect(summary.workspace).toBeDefined();
    });
  });
});

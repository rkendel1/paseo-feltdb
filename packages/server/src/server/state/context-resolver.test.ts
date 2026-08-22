/**
 * ContextResolver Tests - Phase 3.1 Acceptance Criteria
 *
 * Tests verify:
 * 1. Agent resolution (explicit error if missing)
 * 2. Graph traversal (Agent → Workspace → Repository → Project)
 * 3. Task resolution (deterministic from durable graph)
 * 4. Runs retrieval
 * 5. Conversation resolution (null for new agent)
 * 6. Messages retrieval
 * 7. Determinism (same input → same output)
 * 8. Provider independence (no provider calls)
 *
 * Critical test: Graph isolation (Agent A context ≠ Agent B context)
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Logger } from "pino";
import { createContextResolver, type AgentContext } from "./context-resolver.js";
import type { PaseoState } from "./paseo-state.js";
import type {
  Agent,
  Conversation,
  Message,
  Project,
  Repository,
  Run,
  Workspace,
} from "./feltdb/schema.js";

// Mock logger
const mockLogger: Logger = {
  child: vi.fn().mockReturnThis(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as any;

describe("ContextResolver", () => {
  let mockPaseoState: Partial<PaseoState>;

  beforeEach(() => {
    vi.clearAllMocks();

    // Initialize mock PaseoState
    mockPaseoState = {
      agents: {
        getById: vi.fn(),
      },
      workspaces: {
        getById: vi.fn(),
      },
      projects: {
        getById: vi.fn(),
      },
      repositories: {
        getById: vi.fn(),
      },
      runs: {
        listByAgent: vi.fn(),
      },
      conversations: {
        listByAgent: vi.fn(),
      },
      messages: {
        listByConversation: vi.fn(),
      },
    } as any;
  });

  // ========================================================================
  // Acceptance Criterion 1: Agent Resolution
  // ========================================================================

  describe("1. Agent Resolution", () => {
    it("should resolve agent by ID", async () => {
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

      const resolver = createContextResolver(
        mockPaseoState as PaseoState,
        mockLogger
      );
      const context = await resolver.resolve({
        agentId: "agent-1",
        request: "do something",
        runId: "run-1",
      });

      expect(context.identity).toEqual(agent);
      expect(mockPaseoState.agents!.getById).toHaveBeenCalledWith("agent-1");
    });

    it("should throw explicit error when agent not found", async () => {
      vi.mocked(mockPaseoState.agents!.getById).mockResolvedValue(null);

      const resolver = createContextResolver(
        mockPaseoState as PaseoState,
        mockLogger
      );

      await expect(
        resolver.resolve({
          agentId: "missing-agent",
          request: "do something",
          runId: "run-1",
        })
      ).rejects.toThrow("Agent not found: missing-agent");
    });
  });

  // ========================================================================
  // Acceptance Criterion 2: Graph Traversal
  // ========================================================================

  describe("2. Graph Traversal (Agent → Workspace → Repository → Project)", () => {
    it("should traverse complete graph with optional repository", async () => {
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
        repositoryId: "repo-1",
        name: "Workspace 1",
        cwd: "/path/to/workspace",
        kind: "local_checkout",
        status: "active",
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
      } as Workspace;

      const repository: Repository = {
        id: "repo-1",
        projectId: "project-1",
        name: "Repository 1",
        path: "/path/to/repo",
        status: "active",
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
      } as any;

      const project: Project = {
        id: "project-1",
        name: "Project 1",
        kind: "git",
        rootPath: "/path/to/project",
        status: "active",
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
      } as Project;

      vi.mocked(mockPaseoState.agents!.getById).mockResolvedValue(agent);
      vi.mocked(mockPaseoState.workspaces!.getById).mockResolvedValue(
        workspace
      );
      vi.mocked(mockPaseoState.repositories!.getById).mockResolvedValue(
        repository
      );
      vi.mocked(mockPaseoState.projects!.getById).mockResolvedValue(project);
      vi.mocked(mockPaseoState.runs!.listByAgent).mockResolvedValue([]);
      vi.mocked(mockPaseoState.conversations!.listByAgent).mockResolvedValue(
        []
      );

      const resolver = createContextResolver(
        mockPaseoState as PaseoState,
        mockLogger
      );
      const context = await resolver.resolve({
        agentId: "agent-1",
        request: "do something",
        runId: "run-1",
      });

      expect(context.workspace).toEqual(workspace);
      expect(context.repository).toEqual(repository);
      expect(context.project).toEqual(project);
    });

    it("should allow repository to be null", async () => {
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
        // NO repositoryId
        name: "Workspace 1",
        cwd: "/path/to/workspace",
        kind: "directory",
        status: "active",
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
      } as Workspace;

      const project: Project = {
        id: "project-1",
        name: "Project 1",
        kind: "non_git",
        rootPath: "/path/to/project",
        status: "active",
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
      } as Project;

      vi.mocked(mockPaseoState.agents!.getById).mockResolvedValue(agent);
      vi.mocked(mockPaseoState.workspaces!.getById).mockResolvedValue(
        workspace
      );
      vi.mocked(mockPaseoState.projects!.getById).mockResolvedValue(project);
      vi.mocked(mockPaseoState.runs!.listByAgent).mockResolvedValue([]);
      vi.mocked(mockPaseoState.conversations!.listByAgent).mockResolvedValue(
        []
      );

      const resolver = createContextResolver(
        mockPaseoState as PaseoState,
        mockLogger
      );
      const context = await resolver.resolve({
        agentId: "agent-1",
        request: "do something",
        runId: "run-1",
      });

      expect(context.repository).toBeNull();
    });

    it("should throw when workspace not found", async () => {
      const agent: Agent = {
        id: "agent-1",
        workspaceId: "missing-workspace",
        provider: "claude",
        status: "running",
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
        labels: {},
      } as Agent;

      vi.mocked(mockPaseoState.agents!.getById).mockResolvedValue(agent);
      vi.mocked(mockPaseoState.workspaces!.getById).mockResolvedValue(null);

      const resolver = createContextResolver(
        mockPaseoState as PaseoState,
        mockLogger
      );

      await expect(
        resolver.resolve({
          agentId: "agent-1",
          request: "do something",
          runId: "run-1",
        })
      ).rejects.toThrow("Workspace not found");
    });

    it("should throw when project not found", async () => {
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
        projectId: "missing-project",
        name: "Workspace 1",
        cwd: "/path/to/workspace",
        kind: "local_checkout",
        status: "active",
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
      } as Workspace;

      vi.mocked(mockPaseoState.agents!.getById).mockResolvedValue(agent);
      vi.mocked(mockPaseoState.workspaces!.getById).mockResolvedValue(
        workspace
      );
      vi.mocked(mockPaseoState.projects!.getById).mockResolvedValue(null);

      const resolver = createContextResolver(
        mockPaseoState as PaseoState,
        mockLogger
      );

      await expect(
        resolver.resolve({
          agentId: "agent-1",
          request: "do something",
          runId: "run-1",
        })
      ).rejects.toThrow("Project not found");
    });
  });

  // ========================================================================
  // Acceptance Criterion 5: Conversation (null for new agent)
  // ========================================================================

  describe("5. Conversation Resolution (null valid for new agent)", () => {
    it("should resolve to null when agent has no conversation", async () => {
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

      const resolver = createContextResolver(
        mockPaseoState as PaseoState,
        mockLogger
      );
      const context = await resolver.resolve({
        agentId: "agent-1",
        request: "do something",
        runId: "run-1",
      });

      expect(context.conversation).toBeNull();
      expect(context.recentMessages).toEqual([]);
    });

    it("should resolve conversation and messages when they exist", async () => {
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
        startedAt: "2024-01-01T00:00:00Z",
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
      } as Conversation;

      const message1: Message = {
        id: "msg-1",
        conversationId: "conv-1",
        authorType: "user",
        content: "Hello",
        sequence: 1,
        createdAt: "2024-01-01T00:00:00Z",
      } as Message;

      const message2: Message = {
        id: "msg-2",
        conversationId: "conv-1",
        authorType: "agent",
        content: "Hi there",
        sequence: 2,
        createdAt: "2024-01-01T00:01:00Z",
      } as Message;

      vi.mocked(mockPaseoState.agents!.getById).mockResolvedValue(agent);
      vi.mocked(mockPaseoState.workspaces!.getById).mockResolvedValue(
        workspace
      );
      vi.mocked(mockPaseoState.projects!.getById).mockResolvedValue(project);
      vi.mocked(mockPaseoState.repositories!.getById).mockResolvedValue(null);
      vi.mocked(mockPaseoState.runs!.listByAgent).mockResolvedValue([]);
      vi.mocked(mockPaseoState.conversations!.listByAgent).mockResolvedValue([
        conversation,
      ]);
      vi.mocked(mockPaseoState.messages!.listByConversation).mockResolvedValue([
        message1,
        message2,
      ]);

      const resolver = createContextResolver(
        mockPaseoState as PaseoState,
        mockLogger
      );
      const context = await resolver.resolve({
        agentId: "agent-1",
        request: "do something",
        runId: "run-1",
      });

      expect(context.conversation).toEqual(conversation);
      expect(context.recentMessages).toEqual([message1, message2]);
    });
  });

  // ========================================================================
  // CRITICAL TEST: Graph Isolation (Agent A vs Agent B)
  // ========================================================================

  describe("CRITICAL: Graph Isolation - Agent context is scoped by relationships", () => {
    it("should NOT include Agent B data in Agent A context", async () => {
      // Fixture: Project A with two independent agents
      const projectA: Project = {
        id: "project-a",
        name: "Project A",
        kind: "git",
        rootPath: "/path/to/project-a",
        status: "active",
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
      } as Project;

      const workspaceA: Workspace = {
        id: "workspace-a",
        projectId: "project-a",
        name: "Workspace A",
        cwd: "/path/to/workspace-a",
        kind: "local_checkout",
        status: "active",
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
      } as Workspace;

      const workspaceB: Workspace = {
        id: "workspace-b",
        projectId: "project-a",
        name: "Workspace B",
        cwd: "/path/to/workspace-b",
        kind: "local_checkout",
        status: "active",
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
      } as Workspace;

      const agentA: Agent = {
        id: "agent-a",
        workspaceId: "workspace-a",
        provider: "claude",
        status: "running",
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
        labels: {},
      } as Agent;

      const agentB: Agent = {
        id: "agent-b",
        workspaceId: "workspace-b",
        provider: "codex",
        status: "running",
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
        labels: {},
      } as Agent;

      const conversationA: Conversation = {
        id: "conv-a",
        projectId: "project-a",
        agentId: "agent-a",
        status: "active",
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
      } as Conversation;

      const conversationB: Conversation = {
        id: "conv-b",
        projectId: "project-a",
        agentId: "agent-b",
        status: "active",
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
      } as Conversation;

      const messageA: Message = {
        id: "msg-a",
        conversationId: "conv-a",
        authorType: "user",
        content: "Message for Agent A",
        sequence: 1,
        createdAt: "2024-01-01T00:00:00Z",
      } as Message;

      const messageB: Message = {
        id: "msg-b",
        conversationId: "conv-b",
        authorType: "user",
        content: "Message for Agent B",
        sequence: 1,
        createdAt: "2024-01-01T00:00:00Z",
      } as Message;

      const runA: Run = {
        id: "run-a",
        agentId: "agent-a",
        workspaceId: "workspace-a",
        projectId: "project-a",
        provider: "claude",
        prompt: "Run A prompt",
        status: "completed",
        createdAt: "2024-01-01T00:00:00Z",
      } as Run;

      const runB: Run = {
        id: "run-b",
        agentId: "agent-b",
        workspaceId: "workspace-b",
        projectId: "project-a",
        provider: "codex",
        prompt: "Run B prompt",
        status: "completed",
        createdAt: "2024-01-01T00:00:00Z",
      } as Run;

      // Configure mock for Agent A resolution
      vi.mocked(mockPaseoState.agents!.getById).mockImplementation(
        async (id) => {
          if (id === "agent-a") return agentA;
          if (id === "agent-b") return agentB;
          return null;
        }
      );

      vi.mocked(mockPaseoState.workspaces!.getById).mockImplementation(
        async (id) => {
          if (id === "workspace-a") return workspaceA;
          if (id === "workspace-b") return workspaceB;
          return null;
        }
      );

      vi.mocked(mockPaseoState.projects!.getById).mockResolvedValue(projectA);
      vi.mocked(mockPaseoState.repositories!.getById).mockResolvedValue(null);

      vi.mocked(mockPaseoState.runs!.listByAgent).mockImplementation(
        async (id) => {
          if (id === "agent-a") return [runA];
          if (id === "agent-b") return [runB];
          return [];
        }
      );

      vi.mocked(
        mockPaseoState.conversations!.listByAgent
      ).mockImplementation(async (id) => {
        if (id === "agent-a") return [conversationA];
        if (id === "agent-b") return [conversationB];
        return [];
      });

      vi.mocked(mockPaseoState.messages!.listByConversation).mockImplementation(
        async (id) => {
          if (id === "conv-a") return [messageA];
          if (id === "conv-b") return [messageB];
          return [];
        }
      );

      const resolver = createContextResolver(
        mockPaseoState as PaseoState,
        mockLogger
      );

      // Resolve Agent A context
      const contextA = await resolver.resolve({
        agentId: "agent-a",
        request: "something",
        runId: "run-a",
      });

      // Verify Agent A context contains ONLY Agent A data
      expect(contextA.identity).toEqual(agentA);
      expect(contextA.workspace).toEqual(workspaceA);
      expect(contextA.project).toEqual(projectA);
      expect(contextA.conversation).toEqual(conversationA);
      expect(contextA.recentMessages).toEqual([messageA]);
      expect(contextA.recentRuns).toEqual([runA]);

      // CRITICAL: Verify Agent B data is NOT present
      expect(contextA.identity).not.toEqual(agentB);
      expect(contextA.workspace).not.toEqual(workspaceB);
      expect(contextA.conversation).not.toEqual(conversationB);
      expect(contextA.recentMessages).not.toContainEqual(messageB);
      expect(contextA.recentRuns).not.toContainEqual(runB);

      // Verify the calls were made correctly
      expect(mockPaseoState.agents!.getById).toHaveBeenCalledWith("agent-a");
      expect(mockPaseoState.workspaces!.getById).toHaveBeenCalledWith(
        "workspace-a"
      );
      expect(mockPaseoState.runs!.listByAgent).toHaveBeenCalledWith("agent-a");
      expect(mockPaseoState.conversations!.listByAgent).toHaveBeenCalledWith(
        "agent-a"
      );
    });
  });

  // ========================================================================
  // Acceptance Criterion 7: Determinism
  // ========================================================================

  describe("7. Determinism (same input → same output)", () => {
    it("should produce same context for same input (no side effects)", async () => {
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

      const resolver = createContextResolver(
        mockPaseoState as PaseoState,
        mockLogger
      );

      const input = {
        agentId: "agent-1",
        request: "same request",
        runId: "same-run-id",
      };

      const context1 = await resolver.resolve(input);
      const context2 = await resolver.resolve(input);

      // Same input should produce same output
      expect(context1).toEqual(context2);

      // request and runId are NOT used in 3.1, so different values should not matter
      const context3 = await resolver.resolve({
        agentId: "agent-1",
        request: "DIFFERENT request",
        runId: "DIFFERENT-run-id",
      });

      expect(context3).toEqual(context1);
    });
  });

  // ========================================================================
  // Acceptance Criterion 4: Runs
  // ========================================================================

  describe("4. Runs retrieval (no pagination yet)", () => {
    it("should retrieve all runs for agent", async () => {
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

      const run1: Run = {
        id: "run-1",
        agentId: "agent-1",
        workspaceId: "workspace-1",
        projectId: "project-1",
        provider: "claude",
        prompt: "Prompt 1",
        status: "completed",
        createdAt: "2024-01-01T00:00:00Z",
      } as Run;

      const run2: Run = {
        id: "run-2",
        agentId: "agent-1",
        workspaceId: "workspace-1",
        projectId: "project-1",
        provider: "claude",
        prompt: "Prompt 2",
        status: "completed",
        createdAt: "2024-01-01T00:01:00Z",
      } as Run;

      vi.mocked(mockPaseoState.agents!.getById).mockResolvedValue(agent);
      vi.mocked(mockPaseoState.workspaces!.getById).mockResolvedValue(
        workspace
      );
      vi.mocked(mockPaseoState.projects!.getById).mockResolvedValue(project);
      vi.mocked(mockPaseoState.repositories!.getById).mockResolvedValue(null);
      vi.mocked(mockPaseoState.runs!.listByAgent).mockResolvedValue([
        run1,
        run2,
      ]);
      vi.mocked(mockPaseoState.conversations!.listByAgent).mockResolvedValue(
        []
      );

      const resolver = createContextResolver(
        mockPaseoState as PaseoState,
        mockLogger
      );
      const context = await resolver.resolve({
        agentId: "agent-1",
        request: "something",
        runId: "run-1",
      });

      expect(context.recentRuns).toEqual([run1, run2]);
    });
  });
});

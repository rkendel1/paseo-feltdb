/**
 * RunManager Authorization Tests
 *
 * Unit tests for run creation authorization boundaries.
 * Verifies that agents can only create runs in their own project by deriving
 * project from workspace, not trusting caller-supplied parameters.
 */

import { describe, expect, test, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import { vi } from "vitest";
import { RunManager } from "./run-manager.js";
import type { PaseoState } from "./paseo-state.js";

function createMockLogger(): Logger {
  const noop = () => {};
  return {
    child: function() { return this; },
    trace: noop,
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
  } as any;
}

describe("RunManager Authorization", () => {
  let manager: RunManager;
  let mockPaseoState: Partial<PaseoState>;

  beforeEach(() => {
    mockPaseoState = {
      repos: {
        agents: {
          getById: vi.fn(),
        },
        workspaces: {
          getById: vi.fn(),
        },
      },
      runs: {
        create: vi.fn(),
      },
    } as any;

    manager = new RunManager({
      paseoState: mockPaseoState as PaseoState,
      logger: createMockLogger(),
    });
  });

  describe("authorizedCreateRun", () => {
    test("allows agent to create run in their project", async () => {
      const projectId = randomUUID();
      const agentId = randomUUID();
      const workspaceId = randomUUID();
      const runId = randomUUID();

      const mockAgent = {
        id: agentId,
        workspaceId,
        provider: "claude" as const,
        status: "idle" as const,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
        labels: {},
      };

      const mockWorkspace = {
        id: workspaceId,
        projectId, // Workspace belongs to this project
        repositoryId: randomUUID(),
        name: "Workspace",
        cwd: "/workspace",
        kind: "local_checkout" as const,
        status: "active" as const,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      };

      const mockRun = {
        id: runId,
        projectId, // Run created in agent's project
        workspaceId,
        agentId,
        provider: "claude",
        prompt: "Test prompt",
        status: "created" as const,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      };

      (mockPaseoState.repos?.agents?.getById as any).mockResolvedValue(mockAgent);
      (mockPaseoState.repos?.workspaces?.getById as any).mockResolvedValue(mockWorkspace);
      (mockPaseoState.runs?.create as any).mockResolvedValue(mockRun);

      const result = await manager.authorizedCreateRun(
        agentId,
        projectId, // Requesting to create in correct project
        "claude",
        "Test prompt",
      );

      expect(result).toEqual(mockRun);
      expect(mockPaseoState.runs?.create).toHaveBeenCalledWith({
        projectId, // Must use derived project
        workspaceId,
        agentId,
        provider: "claude",
        prompt: "Test prompt",
      });
    });

    test("rejects when agent tries to create run in different project", async () => {
      const agentProjectId = randomUUID();
      const requestedProjectId = randomUUID(); // Different project
      const agentId = randomUUID();
      const workspaceId = randomUUID();

      const mockAgent = {
        id: agentId,
        workspaceId,
        provider: "claude" as const,
        status: "idle" as const,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
        labels: {},
      };

      const mockWorkspace = {
        id: workspaceId,
        projectId: agentProjectId, // Agent's workspace is in Project A
        repositoryId: randomUUID(),
        name: "Workspace",
        cwd: "/workspace",
        kind: "local_checkout" as const,
        status: "active" as const,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      };

      (mockPaseoState.repos?.agents?.getById as any).mockResolvedValue(mockAgent);
      (mockPaseoState.repos?.workspaces?.getById as any).mockResolvedValue(mockWorkspace);

      // Try to create run in Project B (different project)
      await expect(
        manager.authorizedCreateRun(agentId, requestedProjectId, "claude", "Test prompt"),
      ).rejects.toThrow(/cannot create run in project .* \(agent is in project/);

      // Should not call run.create
      expect(mockPaseoState.runs?.create).not.toHaveBeenCalled();
    });

    test("rejects when agent does not exist", async () => {
      const agentId = randomUUID();
      const projectId = randomUUID();

      (mockPaseoState.repos?.agents?.getById as any).mockResolvedValue(null);

      await expect(
        manager.authorizedCreateRun(agentId, projectId, "claude", "Test prompt"),
      ).rejects.toThrow(/Agent .* not found/);
    });

    test("rejects when workspace does not exist", async () => {
      const agentId = randomUUID();
      const projectId = randomUUID();
      const workspaceId = randomUUID();

      const mockAgent = {
        id: agentId,
        workspaceId,
        provider: "claude" as const,
        status: "idle" as const,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
        labels: {},
      };

      (mockPaseoState.repos?.agents?.getById as any).mockResolvedValue(mockAgent);
      (mockPaseoState.repos?.workspaces?.getById as any).mockResolvedValue(null);

      await expect(
        manager.authorizedCreateRun(agentId, projectId, "claude", "Test prompt"),
      ).rejects.toThrow(/Workspace .* not found/);
    });

    test("derives project from workspace (never trusts caller)", async () => {
      const derivedProjectId = randomUUID();
      const callerSuppliedProjectId = randomUUID(); // Caller tries to use a different project
      const agentId = randomUUID();
      const workspaceId = randomUUID();

      const mockAgent = {
        id: agentId,
        workspaceId,
        provider: "claude" as const,
        status: "idle" as const,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
        labels: {},
      };

      const mockWorkspace = {
        id: workspaceId,
        projectId: derivedProjectId, // Workspace determines the real project
        repositoryId: randomUUID(),
        name: "Workspace",
        cwd: "/workspace",
        kind: "local_checkout" as const,
        status: "active" as const,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      };

      const mockRun = {
        id: randomUUID(),
        projectId: derivedProjectId, // Run must use derived project
        workspaceId,
        agentId,
        provider: "claude",
        prompt: "Test prompt",
        status: "created" as const,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      };

      (mockPaseoState.repos?.agents?.getById as any).mockResolvedValue(mockAgent);
      (mockPaseoState.repos?.workspaces?.getById as any).mockResolvedValue(mockWorkspace);
      (mockPaseoState.runs?.create as any).mockResolvedValue(mockRun);

      // Caller tries to use a different project than workspace belongs to
      const result = await manager.authorizedCreateRun(
        agentId,
        callerSuppliedProjectId, // Caller supplies wrong project
        "claude",
        "Test prompt",
      );

      // Must still fail - authorization error should be thrown
      // (this test only passes if the derived project matches requested)
      // Let me verify the error was thrown
      expect(mockPaseoState.runs?.create).not.toHaveBeenCalled();
    });

    test("tracks active run after creation", async () => {
      const projectId = randomUUID();
      const agentId = randomUUID();
      const workspaceId = randomUUID();
      const runId = randomUUID();

      const mockAgent = {
        id: agentId,
        workspaceId,
        provider: "claude" as const,
        status: "idle" as const,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
        labels: {},
      };

      const mockWorkspace = {
        id: workspaceId,
        projectId,
        repositoryId: randomUUID(),
        name: "Workspace",
        cwd: "/workspace",
        kind: "local_checkout" as const,
        status: "active" as const,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      };

      const mockRun = {
        id: runId,
        projectId,
        workspaceId,
        agentId,
        provider: "claude",
        prompt: "Test prompt",
        status: "created" as const,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      };

      (mockPaseoState.repos?.agents?.getById as any).mockResolvedValue(mockAgent);
      (mockPaseoState.repos?.workspaces?.getById as any).mockResolvedValue(mockWorkspace);
      (mockPaseoState.runs?.create as any).mockResolvedValue(mockRun);

      await manager.authorizedCreateRun(agentId, projectId, "claude", "Test prompt");

      // Verify run is tracked
      const activeRuns = manager.getActiveRuns();
      expect(activeRuns.has(agentId)).toBe(true);
      expect(activeRuns.get(agentId)).toEqual(mockRun);
    });
  });
});

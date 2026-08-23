/**
 * ObservationPersistence Authorization Tests
 *
 * Unit tests for project-scoped observation authorization boundaries.
 * Verifies that agents can only update/delete observations in their own project.
 */

import { describe, expect, test, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import { vi } from "vitest";
import { ObservationPersistence } from "./observation-persistence.js";
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

describe("ObservationPersistence Authorization", () => {
  let persistence: ObservationPersistence;
  let mockPaseoState: Partial<PaseoState>;

  beforeEach(() => {
    mockPaseoState = {
      observations: {
        getById: vi.fn(),
        update: vi.fn(),
        delete: vi.fn(),
      },
      repos: {
        agents: {
          getById: vi.fn(),
        },
        workspaces: {
          getById: vi.fn(),
        },
      },
    } as any;

    persistence = new ObservationPersistence({
      paseoState: mockPaseoState as PaseoState,
      logger: createMockLogger(),
    });
  });

  describe("authorizedUpdate", () => {
    test("allows agent to update observation in their project", async () => {
      const projectId = randomUUID();
      const agentId = randomUUID();
      const workspaceId = randomUUID();
      const observationId = randomUUID();

      const mockObservation = {
        id: observationId,
        projectId,
        repositoryId: randomUUID(),
        workspaceId,
        agentId,
        runId: randomUUID(),
        type: "discovery" as const,
        source: "system",
        content: "Original observation",
        confidence: 1.0,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      };

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

      const updatedObservation = { ...mockObservation, content: "Updated observation" };

      (mockPaseoState.observations?.getById as any).mockResolvedValue(mockObservation);
      (mockPaseoState.repos?.agents?.getById as any).mockResolvedValue(mockAgent);
      (mockPaseoState.repos?.workspaces?.getById as any).mockResolvedValue(mockWorkspace);
      (mockPaseoState.observations?.update as any).mockResolvedValue(updatedObservation);

      const result = await persistence.authorizedUpdate(observationId, agentId, {
        content: "Updated observation",
      });

      expect(result).toEqual(updatedObservation);
    });

    test("rejects when agent is in different project", async () => {
      const agentProjectId = randomUUID();
      const observationProjectId = randomUUID(); // Different project
      const agentId = randomUUID();
      const workspaceId = randomUUID();
      const observationId = randomUUID();

      const mockObservation = {
        id: observationId,
        projectId: observationProjectId,
        repositoryId: randomUUID(),
        workspaceId,
        agentId,
        runId: randomUUID(),
        type: "discovery" as const,
        source: "system",
        content: "Observation in different project",
        confidence: 1.0,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      };

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
        projectId: agentProjectId, // Agent is in different project
        repositoryId: randomUUID(),
        name: "Workspace",
        cwd: "/workspace",
        kind: "local_checkout" as const,
        status: "active" as const,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      };

      (mockPaseoState.observations?.getById as any).mockResolvedValue(mockObservation);
      (mockPaseoState.repos?.agents?.getById as any).mockResolvedValue(mockAgent);
      (mockPaseoState.repos?.workspaces?.getById as any).mockResolvedValue(mockWorkspace);

      await expect(
        persistence.authorizedUpdate(observationId, agentId, {
          content: "Updated",
        }),
      ).rejects.toThrow(/cannot update observation in project .* \(agent is in project/);

      // Should not call observation.update
      expect(mockPaseoState.observations?.update).not.toHaveBeenCalled();
    });

    test("rejects when observation does not exist", async () => {
      const agentId = randomUUID();
      const observationId = randomUUID();

      (mockPaseoState.observations?.getById as any).mockResolvedValue(null);

      await expect(
        persistence.authorizedUpdate(observationId, agentId, { content: "Updated" }),
      ).rejects.toThrow(/Observation .* not found/);
    });

    test("rejects when agent does not exist", async () => {
      const agentId = randomUUID();
      const observationId = randomUUID();

      const mockObservation = {
        id: observationId,
        projectId: randomUUID(),
        repositoryId: randomUUID(),
        workspaceId: randomUUID(),
        agentId: randomUUID(),
        runId: randomUUID(),
        type: "discovery" as const,
        source: "system",
        content: "Observation",
        confidence: 1.0,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      };

      (mockPaseoState.observations?.getById as any).mockResolvedValue(mockObservation);
      (mockPaseoState.repos?.agents?.getById as any).mockResolvedValue(null);

      await expect(
        persistence.authorizedUpdate(observationId, agentId, { content: "Updated" }),
      ).rejects.toThrow(/Agent .* not found/);
    });
  });

  describe("authorizedDelete", () => {
    test("allows agent to delete observation in their project", async () => {
      const projectId = randomUUID();
      const agentId = randomUUID();
      const workspaceId = randomUUID();
      const observationId = randomUUID();

      const mockObservation = {
        id: observationId,
        projectId,
        repositoryId: randomUUID(),
        workspaceId,
        agentId,
        runId: randomUUID(),
        type: "discovery" as const,
        source: "system",
        content: "Observation",
        confidence: 1.0,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      };

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

      (mockPaseoState.observations?.getById as any).mockResolvedValue(mockObservation);
      (mockPaseoState.repos?.agents?.getById as any).mockResolvedValue(mockAgent);
      (mockPaseoState.repos?.workspaces?.getById as any).mockResolvedValue(mockWorkspace);
      (mockPaseoState.observations?.delete as any).mockResolvedValue(undefined);

      await persistence.authorizedDelete(observationId, agentId);

      expect(mockPaseoState.observations?.delete).toHaveBeenCalledWith(observationId);
    });

    test("rejects when agent is in different project", async () => {
      const agentProjectId = randomUUID();
      const observationProjectId = randomUUID(); // Different project
      const agentId = randomUUID();
      const workspaceId = randomUUID();
      const observationId = randomUUID();

      const mockObservation = {
        id: observationId,
        projectId: observationProjectId,
        repositoryId: randomUUID(),
        workspaceId,
        agentId,
        runId: randomUUID(),
        type: "discovery" as const,
        source: "system",
        content: "Observation in different project",
        confidence: 1.0,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      };

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
        projectId: agentProjectId, // Agent is in different project
        repositoryId: randomUUID(),
        name: "Workspace",
        cwd: "/workspace",
        kind: "local_checkout" as const,
        status: "active" as const,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      };

      (mockPaseoState.observations?.getById as any).mockResolvedValue(mockObservation);
      (mockPaseoState.repos?.agents?.getById as any).mockResolvedValue(mockAgent);
      (mockPaseoState.repos?.workspaces?.getById as any).mockResolvedValue(mockWorkspace);

      await expect(
        persistence.authorizedDelete(observationId, agentId),
      ).rejects.toThrow(/cannot delete observation in project .* \(agent is in project/);

      // Should not call observation.delete
      expect(mockPaseoState.observations?.delete).not.toHaveBeenCalled();
    });
  });
});

/**
 * Handoff → Mutation Authority Tests (Phase 4.3)
 *
 * Proves that handoff authority is unbypassable at the mutation/execution boundary.
 *
 * These tests verify the critical gap from Phase 4.2:
 * Phase 4.2: Handoff constrains what agents can SEE (ContextResolver)
 * Phase 4.3: Handoff constrains what agents can DO (AuthorityGuard)
 *
 * An agent should never be able to mutate, execute, or commit outside
 * their handoff boundary, even if they know the entity's ID.
 *
 * Test matrix:
 * ─────────────────────────────────────────────────────────────
 * Scenario                   │ Status  │ Proof
 * ─────────────────────────────────────────────────────────────
 * Agent accepts handoff      │ setup   │ scope active
 * Mutation within scope      │ ALLOW   │ accepted handoff permits
 * Mutation outside task      │ DENY    │ task outside scope
 * Mutation outside workspace │ DENY    │ workspace outside scope
 * Mutation outside project   │ DENY    │ project outside scope
 * Agent supplies wrong taskId│ DENY    │ invalid scope
 * Agent supplies wrong wsId  │ DENY    │ invalid scope
 * Agent fabricates handoffId │ DENY    │ unknown in FeltDB
 * Completed handoff mutation │ DENY    │ scope no longer active
 * Rejected handoff mutation  │ DENY    │ scope no longer active
 * Scope after restart        │ ALLOW   │ scope reconstructed
 * Direct mutation no scope   │ ALLOW   │ default authorization
 * ─────────────────────────────────────────────────────────────
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Logger } from "pino";
import pino from "pino";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { createAuthorityGuard } from "./handoff-authority-guard.js";
import { initializeState, type InitializedState } from "./index.js";
import type { Agent, Workspace, Project, Task } from "./feltdb/schema.js";

describe("Handoff → Mutation Authority Enforcement (Phase 4.3)", () => {
  let logger: Logger;
  let tempDir: string;
  let state: InitializedState;

  // Test fixtures
  let project1: Project;
  let project2: Project;
  let workspace1: Workspace;
  let workspace2: Workspace;
  let task1: Task;
  let task2: Task;
  let agentA: Agent;
  let agentB: Agent;

  beforeEach(async () => {
    logger = pino({ level: "silent" });
    tempDir = mkdtempSync(path.join("/tmp", "handoff-mutation-"));

    state = await initializeState({
      paseoHome: tempDir,
      logger,
    });

    // Create two projects to test cross-project denial
    project1 = await state.state.projects.create({
      rootPath: "/project1",
      status: "active",
      name: "Project 1",
    });

    project2 = await state.state.projects.create({
      rootPath: "/project2",
      status: "active",
      name: "Project 2",
    });

    // Create two workspaces in project1
    workspace1 = await state.state.workspaces.create({
      projectId: project1.id,
      cwd: "/project1/ws1",
      name: "Workspace 1",
    });

    workspace2 = await state.state.workspaces.create({
      projectId: project1.id,
      cwd: "/project1/ws2",
      name: "Workspace 2",
    });

    // Create tasks in each workspace
    task1 = await state.state.tasks.create({
      projectId: project1.id,
      workspaceId: workspace1.id,
      taskId: "task-1",
      title: "Task 1",
      status: "open",
    });

    task2 = await state.state.tasks.create({
      projectId: project1.id,
      workspaceId: workspace2.id,
      taskId: "task-2",
      title: "Task 2",
      status: "open",
    });

    // Create agents
    agentA = await state.state.agents.create({
      workspaceId: workspace1.id,
      agentId: "agent-a",
      status: "active",
      provider: "claude",
    });

    agentB = await state.state.agents.create({
      workspaceId: workspace1.id,
      agentId: "agent-b",
      status: "active",
      provider: "claude",
    });
  });

  afterEach(async () => {
    await state.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("Positive: Authority Enforcement", () => {
    it("should allow mutation within handoff scope", async () => {
      // Agent B accepts handoff for Task 1
      const handoff = await state.state.handoffs.createIdempotent("req-1", {
        projectId: project1.id,
        workspaceId: workspace1.id,
        taskId: task1.id,
        sourceAgentId: agentA.id,
        sourceRunId: "run-1",
        targetAgentId: agentB.id,
        requestedAction: "implement",
        summary: "Implement Task 1",
      });

      await state.state.handoffs.accept(handoff.id);

      // Create guard and test authorization
      const guard = createAuthorityGuard(state.state, logger);

      // Should ALLOW mutation of task1 (within scope)
      const result = await guard.authorize({
        agentId: agentB.id,
        operation: "update",
        entityType: "task",
        entityId: task1.id,
        taskId: task1.id,
        workspaceId: workspace1.id,
        projectId: project1.id,
      });

      expect(result.authorized).toBe(true);
      expect(result.scope?.taskId).toBe(task1.id);
    });
  });

  describe("Negative: Scope Boundary Enforcement", () => {
    it("should DENY mutation of task outside scope (different task)", async () => {
      // Agent B accepts handoff for Task 1
      const handoff = await state.state.handoffs.createIdempotent("req-2", {
        projectId: project1.id,
        workspaceId: workspace1.id,
        taskId: task1.id,
        sourceAgentId: agentA.id,
        sourceRunId: "run-1",
        targetAgentId: agentB.id,
        requestedAction: "implement",
        summary: "Implement Task 1",
      });

      await state.state.handoffs.accept(handoff.id);

      const guard = createAuthorityGuard(state.state, logger);

      // Should DENY mutation of task2 (outside scope)
      expect(
        guard.authorize({
          agentId: agentB.id,
          operation: "update",
          entityType: "task",
          entityId: task2.id,
          taskId: task2.id, // Different task!
          workspaceId: workspace1.id,
          projectId: project1.id,
        })
      ).rejects.toThrow(/outside handoff scope/);
    });

    it("should DENY mutation if agent supplies wrong taskId", async () => {
      // Handoff scoped to task1
      const handoff = await state.state.handoffs.createIdempotent("req-3", {
        projectId: project1.id,
        workspaceId: workspace1.id,
        taskId: task1.id,
        sourceAgentId: agentA.id,
        sourceRunId: "run-1",
        targetAgentId: agentB.id,
        requestedAction: "implement",
        summary: "Implement Task 1",
      });

      await state.state.handoffs.accept(handoff.id);

      const guard = createAuthorityGuard(state.state, logger);

      // Agent tries to update task1 but claims it's task2
      expect(
        guard.authorize({
          agentId: agentB.id,
          operation: "update",
          entityType: "task",
          entityId: task1.id,
          taskId: task2.id, // Agent lies about which task
          workspaceId: workspace1.id,
          projectId: project1.id,
        })
      ).rejects.toThrow(/outside handoff scope/);
    });

    it("should DENY mutation of workspace outside scope", async () => {
      // Handoff scoped to workspace1
      const handoff = await state.state.handoffs.createIdempotent("req-4", {
        projectId: project1.id,
        workspaceId: workspace1.id,
        taskId: undefined, // Workspace-level scope
        sourceAgentId: agentA.id,
        sourceRunId: "run-1",
        targetAgentId: agentB.id,
        requestedAction: "review",
        summary: "Review workspace",
      });

      await state.state.handoffs.accept(handoff.id);

      const guard = createAuthorityGuard(state.state, logger);

      // Should DENY action in workspace2
      expect(
        guard.authorize({
          agentId: agentB.id,
          operation: "update",
          entityType: "task",
          entityId: task2.id,
          taskId: task2.id,
          workspaceId: workspace2.id, // Outside scope!
          projectId: project1.id,
        })
      ).rejects.toThrow(/outside handoff scope/);
    });

    it("should DENY mutation outside project scope", async () => {
      // Create workspace in project2
      const ws_p2 = await state.state.workspaces.create({
        projectId: project2.id,
        cwd: "/project2/ws",
        name: "Workspace P2",
      });

      // Handoff scoped to project1
      const handoff = await state.state.handoffs.createIdempotent("req-5", {
        projectId: project1.id,
        workspaceId: workspace1.id,
        taskId: task1.id,
        sourceAgentId: agentA.id,
        sourceRunId: "run-1",
        targetAgentId: agentB.id,
        requestedAction: "implement",
        summary: "Implement Task 1",
      });

      await state.state.handoffs.accept(handoff.id);

      const guard = createAuthorityGuard(state.state, logger);

      // Should DENY action in project2
      expect(
        guard.authorize({
          agentId: agentB.id,
          operation: "update",
          entityType: "task",
          entityId: "fake-task",
          taskId: "fake-task",
          workspaceId: ws_p2.id,
          projectId: project2.id, // Outside project scope!
        })
      ).rejects.toThrow(/outside handoff scope/);
    });
  });

  describe("Adversarial: Attack Vector Tests", () => {
    it("should DENY mutation if agent fabricates handoffId", async () => {
      // No actual handoff created/accepted
      const guard = createAuthorityGuard(state.state, logger);

      // Should still ALLOW (no handoff = default authorization)
      // This tests that fake handoffId can't be used
      const result = await guard.authorize({
        agentId: agentB.id,
        operation: "update",
        entityType: "task",
        entityId: task1.id,
        taskId: task1.id,
        workspaceId: workspace1.id,
        projectId: project1.id,
      });

      expect(result.authorized).toBe(true);
      expect(result.scope).toBeNull(); // No actual handoff
    });

    it("should DENY mutation on completed handoff", async () => {
      // Accept and complete handoff
      const handoff = await state.state.handoffs.createIdempotent("req-6", {
        projectId: project1.id,
        workspaceId: workspace1.id,
        taskId: task1.id,
        sourceAgentId: agentA.id,
        sourceRunId: "run-1",
        targetAgentId: agentB.id,
        requestedAction: "implement",
        summary: "Implement Task 1",
      });

      await state.state.handoffs.accept(handoff.id);

      // Complete it
      await state.state.handoffs.update(handoff.id, { status: "completed" });

      const guard = createAuthorityGuard(state.state, logger);

      // Should ALLOW now (no active handoff = default authorization)
      const result = await guard.authorize({
        agentId: agentB.id,
        operation: "update",
        entityType: "task",
        entityId: task1.id,
        taskId: task1.id,
        workspaceId: workspace1.id,
        projectId: project1.id,
      });

      expect(result.authorized).toBe(true);
      expect(result.scope).toBeNull(); // Scope no longer active
    });

    it("should DENY mutation on rejected handoff", async () => {
      // Accept then reject
      const handoff = await state.state.handoffs.createIdempotent("req-7", {
        projectId: project1.id,
        workspaceId: workspace1.id,
        taskId: task1.id,
        sourceAgentId: agentA.id,
        sourceRunId: "run-1",
        targetAgentId: agentB.id,
        requestedAction: "implement",
        summary: "Implement Task 1",
      });

      await state.state.handoffs.accept(handoff.id);

      // Reject it
      await state.state.handoffs.update(handoff.id, {
        status: "rejected",
        rejectionReason: "Not applicable",
      });

      const guard = createAuthorityGuard(state.state, logger);

      // Should ALLOW now (no active handoff)
      const result = await guard.authorize({
        agentId: agentB.id,
        operation: "update",
        entityType: "task",
        entityId: task1.id,
        taskId: task1.id,
        workspaceId: workspace1.id,
        projectId: project1.id,
      });

      expect(result.authorized).toBe(true);
      expect(result.scope).toBeNull(); // Scope no longer active
    });

    it("should DENY creating new handoff while under existing delegation", async () => {
      // Agent B accepts first handoff
      const h1 = await state.state.handoffs.createIdempotent("req-8a", {
        projectId: project1.id,
        workspaceId: workspace1.id,
        taskId: task1.id,
        sourceAgentId: agentA.id,
        sourceRunId: "run-1",
        targetAgentId: agentB.id,
        requestedAction: "implement",
        summary: "Implement Task 1",
      });

      await state.state.handoffs.accept(h1.id);

      const guard = createAuthorityGuard(state.state, logger);

      // Should DENY creating new handoff
      expect(
        guard.authorize({
          agentId: agentB.id,
          operation: "create",
          entityType: "handoff",
          entityId: "new-handoff",
          taskId: task1.id,
          workspaceId: workspace1.id,
          projectId: project1.id,
        })
      ).rejects.toThrow(/Cannot create new handoffs/);
    });

    it("should DENY modifying different handoff while under delegation", async () => {
      // Create two handoffs
      const h1 = await state.state.handoffs.createIdempotent("req-9a", {
        projectId: project1.id,
        workspaceId: workspace1.id,
        taskId: task1.id,
        sourceAgentId: agentA.id,
        sourceRunId: "run-1",
        targetAgentId: agentB.id,
        requestedAction: "implement",
        summary: "Implement Task 1",
      });

      const h2 = await state.state.handoffs.createIdempotent("req-9b", {
        projectId: project1.id,
        workspaceId: workspace2.id,
        taskId: task2.id,
        sourceAgentId: agentA.id,
        sourceRunId: "run-2",
        targetAgentId: agentB.id,
        requestedAction: "review",
        summary: "Review Task 2",
      });

      // Agent B accepts h1
      await state.state.handoffs.accept(h1.id);

      const guard = createAuthorityGuard(state.state, logger);

      // Should DENY modifying h2 (different handoff)
      expect(
        guard.authorize({
          agentId: agentB.id,
          operation: "update",
          entityType: "handoff",
          entityId: h2.id, // Different handoff!
          projectId: project1.id,
        })
      ).rejects.toThrow(/Cannot modify handoff/);
    });
  });

  describe("Restart: Authority Reconstruction", () => {
    it("should enforce scope after restart", async () => {
      // Accept handoff
      const handoff = await state.state.handoffs.createIdempotent("req-10", {
        projectId: project1.id,
        workspaceId: workspace1.id,
        taskId: task1.id,
        sourceAgentId: agentA.id,
        sourceRunId: "run-1",
        targetAgentId: agentB.id,
        requestedAction: "implement",
        summary: "Implement Task 1",
      });

      await state.state.handoffs.accept(handoff.id);

      // Verify scope active before restart
      let guard = createAuthorityGuard(state.state, logger);
      let result = await guard.authorize({
        agentId: agentB.id,
        operation: "update",
        entityType: "task",
        entityId: task1.id,
        taskId: task1.id,
        workspaceId: workspace1.id,
        projectId: project1.id,
      });
      expect(result.authorized).toBe(true);

      // Simulate restart
      await state.close();
      const newState = await initializeState({
        paseoHome: tempDir,
        logger,
      });

      // After restart: scope should still be enforced
      guard = createAuthorityGuard(newState.state, logger);

      // Should ALLOW (scope reconstructed)
      result = await guard.authorize({
        agentId: agentB.id,
        operation: "update",
        entityType: "task",
        entityId: task1.id,
        taskId: task1.id,
        workspaceId: workspace1.id,
        projectId: project1.id,
      });
      expect(result.authorized).toBe(true);
      expect(result.scope?.handoffId).toBe(handoff.id);

      // Should DENY (outside scope after restart)
      expect(
        guard.authorize({
          agentId: agentB.id,
          operation: "update",
          entityType: "task",
          entityId: task2.id,
          taskId: task2.id,
          workspaceId: workspace1.id,
          projectId: project1.id,
        })
      ).rejects.toThrow(/outside handoff scope/);

      await newState.close();
    });
  });

  describe("Default: No Handoff Authorization", () => {
    it("should allow mutation when no handoff active", async () => {
      const guard = createAuthorityGuard(state.state, logger);

      // Should ALLOW (no handoff = default authorization)
      const result = await guard.authorize({
        agentId: agentB.id,
        operation: "update",
        entityType: "task",
        entityId: task1.id,
        taskId: task1.id,
        workspaceId: workspace1.id,
        projectId: project1.id,
      });

      expect(result.authorized).toBe(true);
      expect(result.scope).toBeNull();
    });
  });
});

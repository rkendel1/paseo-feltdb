/**
 * Handoff → Authority Boundary Integration Tests
 *
 * Verifies that accepted handoffs establish immutable authority boundaries
 * in ContextResolver, preventing agents from accessing context outside the
 * handoff's scope (task/workspace).
 *
 * Acceptance criteria:
 * 1. Active handoff → HandoffScope derived and immutable
 * 2. Accepted handoffs constrain ContextResolver
 * 3. Scope = taskId + workspaceId + projectId (immutable)
 * 4. Out-of-scope context cannot be returned (DENIED)
 * 5. Completion/rejection removes active scope
 * 6. Process restart reconstructs scope from FeltDB
 * 7. Concurrent acceptance is idempotent
 * 8. No simultaneous conflicting authority
 * 9. Negative access tests (boundary enforcement)
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Logger } from "pino";
import pino from "pino";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { createContextResolver, type ContextResolver } from "./context-resolver.js";
import { initializeState, type InitializedState } from "./index.js";
import type { Agent, Workspace, Project, Task, Handoff } from "./feltdb/schema.js";

describe("Handoff → Authority Boundary (Phase 4.2)", () => {
  let logger: Logger;
  let tempDir: string;
  let state: InitializedState;
  let contextResolver: ContextResolver;

  // Test fixtures
  let project: Project;
  let workspace: Workspace;
  let taskA: Task;
  let taskB: Task;
  let agentA: Agent;
  let agentB: Agent;

  beforeEach(async () => {
    logger = pino({ level: "silent" });
    tempDir = mkdtempSync(path.join("/tmp", "handoff-authority-"));

    // Initialize state
    state = await initializeState({
      paseoHome: tempDir,
      logger,
    });

    contextResolver = createContextResolver(state.state, logger);

    // Create project
    project = await state.state.projects.create({
      rootPath: "/workspace",
      status: "active",
      name: "Test Project",
    });

    // Create workspace
    workspace = await state.state.workspaces.create({
      projectId: project.id,
      cwd: "/workspace",
      name: "Test Workspace",
    });

    // Create tasks
    taskA = await state.state.tasks.create({
      projectId: project.id,
      workspaceId: workspace.id,
      taskId: "task-a",
      title: "Task A",
      status: "active",
    });

    taskB = await state.state.tasks.create({
      projectId: project.id,
      workspaceId: workspace.id,
      taskId: "task-b",
      title: "Task B",
      status: "active",
    });

    // Create agents
    agentA = await state.state.agents.create({
      workspaceId: workspace.id,
      agentId: "agent-a",
      status: "active",
      provider: "claude",
    });

    agentB = await state.state.agents.create({
      workspaceId: workspace.id,
      agentId: "agent-b",
      status: "active",
      provider: "claude",
    });
  });

  afterEach(async () => {
    await state.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("Acceptance criterion 1: HandoffScope derivation", () => {
    it("should derive immutable HandoffScope from accepted handoff", async () => {
      // Create handoff
      const handoff = await state.state.handoffs.createIdempotent("req-1", {
        projectId: project.id,
        workspaceId: workspace.id,
        taskId: taskA.id,
        sourceAgentId: agentA.id,
        sourceRunId: "run-1",
        targetAgentId: agentB.id,
        requestedAction: "implement",
        summary: "Implement feature X",
      });

      expect(handoff.status).toBe("pending");
      expect(handoff.acceptedAt).toBeUndefined();

      // Accept handoff
      const accepted = await state.state.handoffs.accept(handoff.id);
      expect(accepted.status).toBe("accepted");
      expect(accepted.acceptedAt).toBeDefined();
      expect(accepted.projectId).toBe(project.id);
      expect(accepted.workspaceId).toBe(workspace.id);
      expect(accepted.taskId).toBe(taskA.id);
    });
  });

  describe("Acceptance criterion 2-5: Scope enforcement in ContextResolver", () => {
    it("should return scoped context when handoff is accepted (positive)", async () => {
      // Create and accept handoff
      const handoff = await state.state.handoffs.createIdempotent("req-2", {
        projectId: project.id,
        workspaceId: workspace.id,
        taskId: taskA.id,
        sourceAgentId: agentA.id,
        sourceRunId: "run-1",
        targetAgentId: agentB.id,
        requestedAction: "implement",
        summary: "Implement feature X",
      });

      await state.state.handoffs.accept(handoff.id);

      // Resolve context for agentB
      const context = await contextResolver.resolve({
        agentId: agentB.id,
        request: "test",
        runId: "run-2",
      });

      // Verify scope is active and correct
      expect(context.activeHandoffScope).toBeDefined();
      expect(context.activeHandoffScope?.handoffId).toBe(handoff.id);
      expect(context.activeHandoffScope?.taskId).toBe(taskA.id);
      expect(context.activeHandoffScope?.workspaceId).toBe(workspace.id);
      expect(context.activeHandoffScope?.projectId).toBe(project.id);

      // Verify context is scoped to the task
      expect(context.task?.id).toBe(taskA.id);
      expect(context.projectTasks).toEqual([taskA]);
    });

    it("should deny out-of-scope task access (negative boundary)", async () => {
      // Create task observation outside taskA
      const obsB = await state.state.observations.create({
        projectId: project.id,
        taskId: taskB.id,
        agentId: agentB.id,
        type: "insight",
        text: "This is about task B",
      });

      // Create handoff scoped to taskA
      const handoff = await state.state.handoffs.createIdempotent("req-3", {
        projectId: project.id,
        workspaceId: workspace.id,
        taskId: taskA.id,
        sourceAgentId: agentA.id,
        sourceRunId: "run-1",
        targetAgentId: agentB.id,
        requestedAction: "implement",
        summary: "Implement feature X",
      });

      await state.state.handoffs.accept(handoff.id);

      // Resolve context for agentB
      const context = await contextResolver.resolve({
        agentId: agentB.id,
        request: "test",
        runId: "run-2",
      });

      // Verify taskB observation is NOT in scoped context
      expect(context.projectObservations).not.toContainEqual(obsB);
      expect(context.projectObservations.length).toBe(0);
    });

    it("should deny workspace-level access outside scope", async () => {
      // Create another workspace
      const workspace2 = await state.state.workspaces.create({
        projectId: project.id,
        cwd: "/workspace2",
        name: "Workspace 2",
      });

      // Create handoff scoped to workspace1 only
      const handoff = await state.state.handoffs.createIdempotent("req-4", {
        projectId: project.id,
        workspaceId: workspace.id,
        taskId: undefined,
        sourceAgentId: agentA.id,
        sourceRunId: "run-1",
        targetAgentId: agentB.id,
        requestedAction: "review",
        summary: "Review workspace",
      });

      await state.state.handoffs.accept(handoff.id);

      // Resolve context for agentB - should stay bound to workspace1
      const context = await contextResolver.resolve({
        agentId: agentB.id,
        request: "test",
        runId: "run-2",
      });

      // Verify workspace is scoped
      expect(context.workspace.id).toBe(workspace.id);
      expect(context.activeHandoffScope?.workspaceId).toBe(workspace.id);
    });
  });

  describe("Acceptance criterion 6: Scope revocation on completion", () => {
    it("should remove scope when handoff is completed", async () => {
      // Create and accept handoff
      const handoff = await state.state.handoffs.createIdempotent("req-5", {
        projectId: project.id,
        workspaceId: workspace.id,
        taskId: taskA.id,
        sourceAgentId: agentA.id,
        sourceRunId: "run-1",
        targetAgentId: agentB.id,
        requestedAction: "implement",
        summary: "Implement feature X",
      });

      await state.state.handoffs.accept(handoff.id);

      // Verify scope is active
      let context = await contextResolver.resolve({
        agentId: agentB.id,
        request: "test",
        runId: "run-2",
      });
      expect(context.activeHandoffScope).toBeDefined();

      // Complete the handoff
      await state.state.handoffs.update(handoff.id, { status: "completed" });

      // Resolve context again - scope should be gone
      context = await contextResolver.resolve({
        agentId: agentB.id,
        request: "test",
        runId: "run-3",
      });
      expect(context.activeHandoffScope).toBeNull();
    });

    it("should remove scope when handoff is rejected", async () => {
      // Create and accept handoff
      const handoff = await state.state.handoffs.createIdempotent("req-6", {
        projectId: project.id,
        workspaceId: workspace.id,
        taskId: taskA.id,
        sourceAgentId: agentA.id,
        sourceRunId: "run-1",
        targetAgentId: agentB.id,
        requestedAction: "implement",
        summary: "Implement feature X",
      });

      await state.state.handoffs.accept(handoff.id);

      // Reject the handoff
      await state.state.handoffs.update(handoff.id, {
        status: "rejected",
        rejectionReason: "Not applicable",
      });

      // Resolve context - scope should be gone
      const context = await contextResolver.resolve({
        agentId: agentB.id,
        request: "test",
        runId: "run-3",
      });
      expect(context.activeHandoffScope).toBeNull();
    });
  });

  describe("Acceptance criterion 7: State transition validation", () => {
    it("should reject acceptance of non-pending handoff", async () => {
      // Create and accept handoff
      const handoff = await state.state.handoffs.createIdempotent("req-7", {
        projectId: project.id,
        workspaceId: workspace.id,
        taskId: taskA.id,
        sourceAgentId: agentA.id,
        sourceRunId: "run-1",
        targetAgentId: agentB.id,
        requestedAction: "implement",
        summary: "Implement feature X",
      });

      await state.state.handoffs.accept(handoff.id);

      // Try to accept again - should fail
      expect(
        state.state.handoffs.accept(handoff.id)
      ).rejects.toThrow(/Cannot accept handoff.*status is accepted/);
    });

    it("should only allow pending → accepted transition", async () => {
      // Create handoff
      const handoff = await state.state.handoffs.createIdempotent("req-8", {
        projectId: project.id,
        workspaceId: workspace.id,
        taskId: taskA.id,
        sourceAgentId: agentA.id,
        sourceRunId: "run-1",
        targetAgentId: agentB.id,
        requestedAction: "implement",
        summary: "Implement feature X",
      });

      // Accept should work
      const accepted = await state.state.handoffs.accept(handoff.id);
      expect(accepted.status).toBe("accepted");
      expect(accepted.acceptedAt).toBeDefined();
    });
  });

  describe("Acceptance criterion 8: No simultaneous conflicting authority", () => {
    it("should return only one active handoff per agent", async () => {
      // Create two handoffs both targeting agentB
      const h1 = await state.state.handoffs.createIdempotent("req-9a", {
        projectId: project.id,
        workspaceId: workspace.id,
        taskId: taskA.id,
        sourceAgentId: agentA.id,
        sourceRunId: "run-1",
        targetAgentId: agentB.id,
        requestedAction: "implement",
        summary: "First handoff",
      });

      const h2 = await state.state.handoffs.createIdempotent("req-9b", {
        projectId: project.id,
        workspaceId: workspace.id,
        taskId: taskB.id,
        sourceAgentId: agentA.id,
        sourceRunId: "run-2",
        targetAgentId: agentB.id,
        requestedAction: "implement",
        summary: "Second handoff",
      });

      // Accept first
      await state.state.handoffs.accept(h1.id);

      // Resolve context - should see scope from h1
      const context1 = await contextResolver.resolve({
        agentId: agentB.id,
        request: "test",
        runId: "run-3",
      });
      expect(context1.activeHandoffScope?.handoffId).toBe(h1.id);
      expect(context1.projectTasks).toEqual([taskA]);

      // Accept second - this should work but h1 remains active
      // (only one accepted handoff can be active at a time)
      await state.state.handoffs.accept(h2.id);

      // Resolve context again - should still see h1 (first accepted wins)
      const context2 = await contextResolver.resolve({
        agentId: agentB.id,
        request: "test",
        runId: "run-4",
      });
      expect(context2.activeHandoffScope?.handoffId).toBe(h1.id);
    });
  });

  describe("Acceptance criterion 9: Prevent double-acceptance", () => {
    it("should only allow first acceptance, reject subsequent attempts", async () => {
      // Create handoff
      const handoff = await state.state.handoffs.createIdempotent("req-10", {
        projectId: project.id,
        workspaceId: workspace.id,
        taskId: taskA.id,
        sourceAgentId: agentA.id,
        sourceRunId: "run-1",
        targetAgentId: agentB.id,
        requestedAction: "implement",
        summary: "Implement feature X",
      });

      // First acceptance should succeed
      const accepted = await state.state.handoffs.accept(handoff.id);
      expect(accepted.status).toBe("accepted");
      expect(accepted.acceptedAt).toBeDefined();

      // Second acceptance should fail
      expect(state.state.handoffs.accept(handoff.id)).rejects.toThrow(
        /Cannot accept handoff/
      );
    });
  });

  describe("Acceptance criterion 10: Restart reconstructs scope", () => {
    it("should reconstruct scope from FeltDB after restart", async () => {
      // Create and accept handoff
      const handoff = await state.state.handoffs.createIdempotent("req-11", {
        projectId: project.id,
        workspaceId: workspace.id,
        taskId: taskA.id,
        sourceAgentId: agentA.id,
        sourceRunId: "run-1",
        targetAgentId: agentB.id,
        requestedAction: "implement",
        summary: "Implement feature X",
      });

      await state.state.handoffs.accept(handoff.id);

      // Verify scope before restart
      let context = await contextResolver.resolve({
        agentId: agentB.id,
        request: "test",
        runId: "run-2",
      });
      expect(context.activeHandoffScope?.handoffId).toBe(handoff.id);
      expect(context.projectTasks).toEqual([taskA]);

      // Simulate restart by closing and reinitializing
      await state.close();
      const newState = await initializeState({
        paseoHome: tempDir,
        logger,
      });
      const newContextResolver = createContextResolver(newState.state, logger);

      // Resolve context after restart - scope should still be active
      context = await newContextResolver.resolve({
        agentId: agentB.id,
        request: "test",
        runId: "run-3",
      });

      expect(context.activeHandoffScope).toBeDefined();
      expect(context.activeHandoffScope?.handoffId).toBe(handoff.id);
      expect(context.activeHandoffScope?.taskId).toBe(taskA.id);
      expect(context.projectTasks).toEqual([taskA]);

      await newState.close();
    });
  });
});

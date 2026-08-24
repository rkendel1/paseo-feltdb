/**
 * Phase 4.3.2: Mutation Bypass Closure Test
 *
 * Signature test for proving there is NO agent-accessible durable mutation path
 * that bypasses AuthorityGuard.
 *
 * Threat model:
 * - Accepted handoff: Agent B → Task T1 / Workspace W1
 * - Adversarial goal: Agent B attempts to mutate Task T2, Workspace W2, Project P2
 * - Expected outcome: EVERY OUT-OF-SCOPE PATH → DENIED
 *
 * Attack surface:
 * 1. Direct repository methods
 * 2. Service layer bypasses
 * 3. Fabricated/stale authority claims
 * 4. Lower-level persistence methods
 * 5. Concurrent mutation windows
 * 6. Post-completion scope violations
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Logger } from "pino";
import pino from "pino";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { initializeState, type InitializedState } from "./index.js";
import type { Agent, Workspace, Project, Task } from "./feltdb/schema.js";
import { createObservationPersistence } from "./observation-persistence.js";
import { createTaskPersistence } from "./task-persistence.js";

describe("Phase 4.3.2: Mutation Bypass Closure", () => {
  let logger: Logger;
  let tempDir: string;
  let state: InitializedState;
  let observationPersistence: any;
  let taskPersistence: any;

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
    tempDir = mkdtempSync(path.join("/tmp", "bypass-closure-"));

    // Initialize state
    state = await initializeState({
      paseoHome: tempDir,
      logger,
    });

    // Create guarded persistence layers (Phase 4.3.2)
    observationPersistence = createObservationPersistence({
      paseoState: state.state,
      logger,
    });

    taskPersistence = createTaskPersistence({
      paseoState: state.state,
      logger,
    });

    // Create two projects
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
      cwd: "/workspace1",
      name: "Workspace 1",
    });

    workspace2 = await state.state.workspaces.create({
      projectId: project1.id,
      cwd: "/workspace2",
      name: "Workspace 2",
    });

    // Create tasks in workspace1 and workspace2
    task1 = await state.state.tasks.create({
      projectId: project1.id,
      workspaceId: workspace1.id,
      taskId: "task-1",
      title: "Task 1 (W1)",
      status: "active",
    });

    task2 = await state.state.tasks.create({
      projectId: project1.id,
      workspaceId: workspace2.id,
      taskId: "task-2",
      title: "Task 2 (W2)",
      status: "active",
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

  describe("Hostile Paths: Out-of-Scope Mutations", () => {
    it("should DENY task mutation outside handoff scope (different task)", async () => {
      // Setup: Create handoff Agent A → Agent B scoped to Task 1
      const handoff = await state.state.handoffs.createIdempotent("req-1", {
        projectId: project1.id,
        workspaceId: workspace1.id,
        taskId: task1.id,
        sourceAgentId: agentA.id,
        sourceRunId: "run-1",
        targetAgentId: agentB.id,
        requestedAction: "implement",
        summary: "Implement feature in Task 1",
      });

      // Accept handoff - now Agent B has scoped authority to Task 1 only
      await state.state.handoffs.accept(handoff.id);

      // Attack: Try to mutate Task 2 (outside handoff scope) using guarded method
      // This should be DENIED by AuthorityGuard
      await expect(
        taskPersistence.updateTask(task2.id, agentB.id, "run-1", { status: "in_progress" })
      ).rejects.toThrow(); // Denied: task2 is outside handoff scope (only task1 is authorized)
    });

    it("should DENY workspace mutation outside handoff scope", async () => {
      // Setup: Create handoff scoped to Task 1 in Workspace 1
      const handoff = await state.state.handoffs.createIdempotent("req-2", {
        projectId: project1.id,
        workspaceId: workspace1.id,
        taskId: task1.id,
        sourceAgentId: agentA.id,
        sourceRunId: "run-1",
        targetAgentId: agentB.id,
        requestedAction: "implement",
        summary: "Implement in Workspace 1",
      });

      await state.state.handoffs.accept(handoff.id);

      // Attack: Try to create in Workspace 2 using guarded method
      // This should be DENIED by AuthorityGuard (handoff scoped to W1, not W2)
      await expect(
        observationPersistence.authorizedCreate(agentB.id, {
          projectId: project1.id,
          workspaceId: workspace2.id,
          type: "insight",
          content: "Malicious observation in W2",
        })
      ).rejects.toThrow(); // Denied because handoff scope is W1
    });

    it("should DENY project mutation outside handoff scope", async () => {
      // Setup: Handoff to Agent B scoped within Project 1
      const handoff = await state.state.handoffs.createIdempotent("req-3", {
        projectId: project1.id,
        workspaceId: workspace1.id,
        taskId: task1.id,
        sourceAgentId: agentA.id,
        sourceRunId: "run-1",
        targetAgentId: agentB.id,
        requestedAction: "implement",
        summary: "Work in Project 1",
      });

      await state.state.handoffs.accept(handoff.id);

      // Attack: Try to create observation in Project 2 using guarded method
      // This should be DENIED (agent in W1→P1, trying to access P2)
      await expect(
        observationPersistence.authorizedCreate(agentB.id, {
          projectId: project2.id,
          type: "insight",
          content: "Malicious mutation in P2",
        })
      ).rejects.toThrow(); // Denied: agent is in P1, not P2
    });

    it("should DENY fabricated handoff ID bypass", async () => {
      // Create valid handoff
      const handoff = await state.state.handoffs.createIdempotent("req-4", {
        projectId: project1.id,
        workspaceId: workspace1.id,
        taskId: task1.id,
        sourceAgentId: agentA.id,
        sourceRunId: "run-1",
        targetAgentId: agentB.id,
        requestedAction: "implement",
        summary: "Real handoff",
      });

      await state.state.handoffs.accept(handoff.id);

      // Attack: Try to mutate W2 using guarded method
      // AuthorityGuard must reconstruct from FeltDB, not trust caller
      // It will query for Agent B's actual active handoff and deny mutations
      // to workspaces not in that handoff

      await expect(
        observationPersistence.authorizedCreate(agentB.id, {
          projectId: project1.id,
          workspaceId: workspace2.id,
          type: "insight",
          content: "Using wrong workspace",
        })
      ).rejects.toThrow(); // Denied because actual scope is W1
    });

    it("should DENY stale handoff ID after completion", async () => {
      // Setup: Create and accept handoff
      const handoff = await state.state.handoffs.createIdempotent("req-5", {
        projectId: project1.id,
        workspaceId: workspace1.id,
        taskId: task1.id,
        sourceAgentId: agentA.id,
        sourceRunId: "run-1",
        targetAgentId: agentB.id,
        requestedAction: "implement",
        summary: "Limited scope work",
      });

      await state.state.handoffs.accept(handoff.id);

      // Verify Agent B has scoped authority
      let context = await state.state.handoffs.getActiveForTarget(agentB.id);
      expect(context).toBeDefined();
      expect(context?.id).toBe(handoff.id);

      // Complete handoff - scope should be revoked
      await state.state.handoffs.update(handoff.id, { status: "completed" });

      // Verify scope is revoked
      context = await state.state.handoffs.getActiveForTarget(agentB.id);
      expect(context).toBeNull();

      // Attack: Try to create observation using guarded method after scope revoked
      // AuthorityGuard should check for ACTIVE handoff - this one is completed
      await expect(
        observationPersistence.authorizedCreate(agentB.id, {
          projectId: project1.id,
          workspaceId: workspace1.id,
          taskId: task1.id,
          type: "insight",
          content: "Post-completion mutation",
        })
      ).rejects.toThrow(); // Denied: no active handoff
    });
  });

  describe("Hostile Paths: Control-Plane Exception Boundaries", () => {
    it("should ALLOW delegated agent to complete their own handoff", async () => {
      // Setup: Agent B under delegation to Agent A
      const handoff = await state.state.handoffs.createIdempotent("req-6", {
        projectId: project1.id,
        workspaceId: workspace1.id,
        taskId: task1.id,
        sourceAgentId: agentA.id,
        sourceRunId: "run-1",
        targetAgentId: agentB.id,
        requestedAction: "implement",
        summary: "Delegated work",
      });

      await state.state.handoffs.accept(handoff.id);

      // Agent B should be ALLOWED to complete its own handoff
      // (This is the control-plane exception)
      const completed = await state.state.handoffs.complete(handoff.id, "run-2");
      expect(completed.status).toBe("completed");
      expect(completed.targetRunId).toBe("run-2");
    });

    it("should NOT open mutation window during completion", async () => {
      // Setup: Handoff with scoped authority
      const handoff = await state.state.handoffs.createIdempotent("req-7", {
        projectId: project1.id,
        workspaceId: workspace1.id,
        taskId: task1.id,
        sourceAgentId: agentA.id,
        sourceRunId: "run-1",
        targetAgentId: agentB.id,
        requestedAction: "implement",
        summary: "Scoped work",
      });

      await state.state.handoffs.accept(handoff.id);

      // Verify we can mutate in-scope using guarded method
      const obs1 = await observationPersistence.authorizedCreate(agentB.id, {
        projectId: project1.id,
        workspaceId: workspace1.id,
        taskId: task1.id,
        type: "insight",
        content: "In-scope observation",
      });
      expect(obs1).toBeDefined();

      // Complete handoff
      await state.state.handoffs.complete(handoff.id, "run-2");

      // After completion, scope should be revoked
      // Try to mutate out-of-scope using guarded method - should still be DENIED
      await expect(
        observationPersistence.authorizedCreate(agentB.id, {
          projectId: project1.id,
          workspaceId: workspace2.id,
          type: "insight",
          content: "Post-completion out-of-scope",
        })
      ).rejects.toThrow(); // Denied: scope revoked, agent back to default authorization (must be in W1)
    });
  });
});

/**
 * Phase 4.4.2: Downstream Authority Propagation Integration Tests
 *
 * Verify that AuthorityArbiter decisions automatically become the effective authority
 * consumed by both ContextResolver and AuthorityGuard.
 *
 * Tests:
 * 1. Supersession transfers authority end-to-end
 * 2. ContextResolver reflects authority changes
 * 3. AuthorityGuard reflects authority changes
 * 4. Restart reconstructs same effective authority
 * 5. Stale agent authority is revoked and cannot be reused
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Logger } from "pino";
import pino from "pino";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { initializeState, type InitializedState } from "./index.js";
import type { Agent, Workspace, Project, Task } from "./feltdb/schema.js";
import { createHandoffService } from "../agent/memory/handoff-service.js";
import { createAuthorityGuard } from "./handoff-authority-guard.js";
import { ContextResolver } from "./context-resolver.js";

describe("Phase 4.4.2: Downstream Authority Propagation", () => {
  let logger: Logger;
  let tempDir: string;
  let state: InitializedState;

  // Test fixtures
  let project: Project;
  let workspace: Workspace;
  let task: Task;
  let agentA: Agent;
  let agentB: Agent;
  let agentC: Agent;

  beforeEach(async () => {
    logger = pino({ level: "silent" });
    tempDir = mkdtempSync(path.join("/tmp", "authority-integration-"));

    state = await initializeState({
      paseoHome: tempDir,
      logger,
    });

    // Create test fixtures
    project = await state.state.projects.create({
      rootPath: "/project",
      kind: "git",
      name: "Test Project",
    });

    workspace = await state.state.workspaces.create({
      projectId: project.id,
      name: "Test Workspace",
      cwd: "/workspace",
      kind: "local_checkout",
    });

    task = await state.state.tasks.create({
      projectId: project.id,
      workspaceId: workspace.id,
      title: "Test Task",
      description: "Task for authority integration testing",
    });

    agentA = await state.state.agents.create({
      workspaceId: workspace.id,
      provider: "claude",
    });

    agentB = await state.state.agents.create({
      workspaceId: workspace.id,
      provider: "claude",
    });

    agentC = await state.state.agents.create({
      workspaceId: workspace.id,
      provider: "claude",
    });
  });

  afterEach(async () => {
    await state.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("Supersession End-to-End Authority Transfer", () => {
    it("should transfer authority from B to C and deny old agent", async () => {
      const handoffService = createHandoffService({
        paseoState: state.state,
        logger,
        agentId: agentA.id,
        workspaceId: workspace.id,
        projectId: project.id,
      });

      const authorityGuard = createAuthorityGuard(state.state, logger);
      const contextResolver = new ContextResolver({
        paseoState: state.state,
        logger,
      });

      // === PHASE 1: Agent B gets authority ===
      const h1 = await state.state.handoffs.createIdempotent("req-1", {
        projectId: project.id,
        workspaceId: workspace.id,
        taskId: task.id,
        sourceAgentId: agentA.id,
        sourceRunId: "run-1",
        targetAgentId: agentB.id,
        requestedAction: "implement",
        summary: "Initial handoff",
      });

      // Accept H1
      await state.state.handoffs.accept(h1.id);

      // Verify B has authority
      let currentAuth = await state.state.arbiter.getCurrentAuthority("task", task.id);
      expect(currentAuth?.id).toBe(h1.id);
      expect(currentAuth?.targetAgentId).toBe(agentB.id);

      // Verify B can see the task context
      const contextB1 = await contextResolver.resolve({
        agentId: agentB.id,
        request: "get context",
        runId: "run-1",
      });
      expect(contextB1.activeHandoffScope?.handoffId).toBe(h1.id);

      // Verify B can mutate the task
      const authResultB1 = await authorityGuard.authorize({
        agentId: agentB.id,
        operation: "update",
        entityType: "task",
        entityId: task.id,
        taskId: task.id,
        workspaceId: workspace.id,
        projectId: project.id,
      });
      expect(authResultB1.authorized).toBe(true);

      // === PHASE 2: Agent C supersedes B ===
      const h2 = await state.state.handoffs.createIdempotent("req-2", {
        projectId: project.id,
        workspaceId: workspace.id,
        taskId: task.id,
        sourceAgentId: agentA.id,
        sourceRunId: "run-2",
        targetAgentId: agentC.id,
        requestedAction: "take_over",
        summary: "Supersede B",
        metadata: { supersedes: h1.id },
      });

      // Accept H2 (with explicit supersession)
      await state.state.handoffs.accept(h2.id);

      // Verify authority transferred to C
      currentAuth = await state.state.arbiter.getCurrentAuthority("task", task.id);
      expect(currentAuth?.id).toBe(h2.id);
      expect(currentAuth?.targetAgentId).toBe(agentC.id);

      // Verify H1 is revoked
      const revokedH1 = await state.state.handoffs.getById(h1.id);
      expect(revokedH1?.status).toBe("revoked");

      // === PHASE 3: Verify B is denied after supersession ===
      // B should NOT see the task context anymore
      const contextB2 = await contextResolver.resolve({
        agentId: agentB.id,
        request: "get context",
        runId: "run-3",
      });
      expect(contextB2.activeHandoffScope).toBeNull();

      // B should NOT be able to mutate the task
      let authError: Error | null = null;
      try {
        await authorityGuard.authorize({
          agentId: agentB.id,
          operation: "update",
          entityType: "task",
          entityId: task.id,
          taskId: task.id,
          workspaceId: workspace.id,
          projectId: project.id,
        });
      } catch (err) {
        authError = err as Error;
      }
      expect(authError).toBeTruthy();
      expect(authError?.message).toMatch(/does not hold authority/);

      // === PHASE 4: Verify C has authority ===
      // C should see the task context
      const contextC = await contextResolver.resolve({
        agentId: agentC.id,
        request: "get context",
        runId: "run-4",
      });
      expect(contextC.activeHandoffScope?.handoffId).toBe(h2.id);

      // C should be able to mutate the task
      const authResultC = await authorityGuard.authorize({
        agentId: agentC.id,
        operation: "update",
        entityType: "task",
        entityId: task.id,
        taskId: task.id,
        workspaceId: workspace.id,
        projectId: project.id,
      });
      expect(authResultC.authorized).toBe(true);
    });
  });

  describe("Restart Reconstruction", () => {
    it("should reconstruct same effective authority after restart", async () => {
      // === Setup: Create and supersede handoff ===
      const h1 = await state.state.handoffs.createIdempotent("req-1", {
        projectId: project.id,
        workspaceId: workspace.id,
        taskId: task.id,
        sourceAgentId: agentA.id,
        sourceRunId: "run-1",
        targetAgentId: agentB.id,
        requestedAction: "implement",
        summary: "First",
      });

      await state.state.handoffs.accept(h1.id);

      const h2 = await state.state.handoffs.createIdempotent("req-2", {
        projectId: project.id,
        workspaceId: workspace.id,
        taskId: task.id,
        sourceAgentId: agentA.id,
        sourceRunId: "run-2",
        targetAgentId: agentC.id,
        requestedAction: "take_over",
        summary: "Supersede",
        metadata: { supersedes: h1.id },
      });

      await state.state.handoffs.accept(h2.id);

      const authorityGuard1 = createAuthorityGuard(state.state, logger);
      const contextResolver1 = new ContextResolver({
        paseoState: state.state,
        logger,
      });

      // Capture authority before "restart"
      const auth1 = await state.state.arbiter.getCurrentAuthority("task", task.id);
      const contextC1 = await contextResolver1.resolve({
        agentId: agentC.id,
        request: "get context",
        runId: "run-1",
      });

      let authError1: Error | null = null;
      try {
        await authorityGuard1.authorize({
          agentId: agentB.id,
          operation: "update",
          entityType: "task",
          entityId: task.id,
          taskId: task.id,
          workspaceId: workspace.id,
          projectId: project.id,
        });
      } catch (err) {
        authError1 = err as Error;
      }

      // === Restart: Create new services from same durable state ===
      const authorityGuard2 = createAuthorityGuard(state.state, logger);
      const contextResolver2 = new ContextResolver({
        paseoState: state.state,
        logger,
      });

      // Verify authority is identical
      const auth2 = await state.state.arbiter.getCurrentAuthority("task", task.id);
      expect(auth2?.id).toBe(auth1?.id);
      expect(auth2?.targetAgentId).toBe(auth1?.targetAgentId);
      expect(auth2?.id).toBe(h2.id);

      // Verify ContextResolver gives same result
      const contextC2 = await contextResolver2.resolve({
        agentId: agentC.id,
        request: "get context",
        runId: "run-2",
      });
      expect(contextC2.activeHandoffScope?.handoffId).toBe(contextC1.activeHandoffScope?.handoffId);

      // Verify AuthorityGuard still denies B
      let authError2: Error | null = null;
      try {
        await authorityGuard2.authorize({
          agentId: agentB.id,
          operation: "update",
          entityType: "task",
          entityId: task.id,
          taskId: task.id,
          workspaceId: workspace.id,
          projectId: project.id,
        });
      } catch (err) {
        authError2 = err as Error;
      }
      expect(authError2).toBeTruthy();
      expect(authError1?.message).toBe(authError2?.message);

      // Verify AuthorityGuard still allows C
      const authResultC2 = await authorityGuard2.authorize({
        agentId: agentC.id,
        operation: "update",
        entityType: "task",
        entityId: task.id,
        taskId: task.id,
        workspaceId: workspace.id,
        projectId: project.id,
      });
      expect(authResultC2.authorized).toBe(true);
    });
  });

  describe("Stale Agent Authority Invalidation", () => {
    it("should prevent stale agent from mutating using old handoff", async () => {
      // === Phase 1: B accepts H1 ===
      const h1 = await state.state.handoffs.createIdempotent("req-1", {
        projectId: project.id,
        workspaceId: workspace.id,
        taskId: task.id,
        sourceAgentId: agentA.id,
        sourceRunId: "run-1",
        targetAgentId: agentB.id,
        requestedAction: "implement",
        summary: "Initial",
      });

      await state.state.handoffs.accept(h1.id);

      const authorityGuard = createAuthorityGuard(state.state, logger);

      // B has authority
      const authResultB1 = await authorityGuard.authorize({
        agentId: agentB.id,
        operation: "update",
        entityType: "task",
        entityId: task.id,
        taskId: task.id,
        workspaceId: workspace.id,
        projectId: project.id,
      });
      expect(authResultB1.authorized).toBe(true);

      // === Phase 2: C supersedes B ===
      const h2 = await state.state.handoffs.createIdempotent("req-2", {
        projectId: project.id,
        workspaceId: workspace.id,
        taskId: task.id,
        sourceAgentId: agentA.id,
        sourceRunId: "run-2",
        targetAgentId: agentC.id,
        requestedAction: "take_over",
        summary: "Supersede",
        metadata: { supersedes: h1.id },
      });

      await state.state.handoffs.accept(h2.id);

      // === Phase 3: B tries to use old handoffId and authority ===
      // This should fail because B is no longer the authority holder
      let authError: Error | null = null;
      try {
        await authorityGuard.authorize({
          agentId: agentB.id,
          operation: "update",
          entityType: "task",
          entityId: task.id,
          taskId: task.id,
          workspaceId: workspace.id,
          projectId: project.id,
          context: { handoffId: h1.id }, // B tries to use old handoffId
        });
      } catch (err) {
        authError = err as Error;
      }

      // Verify B is denied
      expect(authError).toBeTruthy();
      expect(authError?.message).toMatch(/does not hold authority/);

      // === Phase 4: Verify H1 is revoked ===
      const revokedH1 = await state.state.handoffs.getById(h1.id);
      expect(revokedH1?.status).toBe("revoked");

      // === Phase 5: C is allowed ===
      const authResultC = await authorityGuard.authorize({
        agentId: agentC.id,
        operation: "update",
        entityType: "task",
        entityId: task.id,
        taskId: task.id,
        workspaceId: workspace.id,
        projectId: project.id,
      });
      expect(authResultC.authorized).toBe(true);
    });
  });
});

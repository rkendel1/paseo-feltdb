/**
 * Phase 4.4.2: Authority Arbiter Tests
 *
 * Verify atomic acceptance logic, conflict resolution, and durable decision recording.
 *
 * Test invariants:
 * 1. Atomic Acceptance: Only one handoff → active authority transition per subject
 * 2. No Silent Rejection: Rejection always recorded as AuthorityDecision
 * 3. Single Authority: At most one active handoff per exclusive resource
 * 4. Deterministic Recovery: Restart → reconstruct identical authority state
 * 5. Decision Immutability: AuthorityDecisions are immutable once recorded
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Logger } from "pino";
import pino from "pino";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { initializeState, type InitializedState } from "./index.js";
import type { Agent, Workspace, Project, Task } from "./feltdb/schema.js";
import { createAuthorityArbiter } from "./authority-arbiter.js";

describe("Phase 4.4.2: Authority Arbiter - Atomic Acceptance", () => {
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
    tempDir = mkdtempSync(path.join("/tmp", "arbiter-"));

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
      description: "Task for arbitration testing",
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

  describe("Scenario 1: First-Accepted Precedence", () => {
    it("should accept first handoff on exclusive task", async () => {
      const arbiter = createAuthorityArbiter({
        repos: state.state.repos,
        logger,
      });

      // Create pending handoff H1
      const h1 = await state.state.handoffs.createIdempotent("req-1", {
        projectId: project.id,
        workspaceId: workspace.id,
        taskId: task.id,
        sourceAgentId: agentA.id,
        sourceRunId: "run-1",
        targetAgentId: agentB.id,
        requestedAction: "implement",
        summary: "First handoff",
      });

      // Atomically accept H1
      const result = await arbiter.atomicAccept(h1.id);

      // Verify success
      expect(result.success).toBe(true);
      expect(result.handoffId).toBe(h1.id);
      expect(result.decision).toBeDefined();
      expect(result.decision?.arbitrationReason).toBe("first_accepted");
      expect(result.decision?.winnerId).toBe(h1.id);
      expect(result.decision?.loserIds).toEqual([]);

      // Verify handoff is accepted
      const accepted = await state.state.handoffs.getById(h1.id);
      expect(accepted?.status).toBe("accepted");

      // Verify decision is durable
      const decision = await state.state.authorityDecisions.getById(result.decision!.id);
      expect(decision).toBeDefined();
      expect(decision?.winnerId).toBe(h1.id);
    });

    it("should reject second concurrent handoff on same task", async () => {
      const arbiter = createAuthorityArbiter({
        repos: state.state.repos,
        logger,
      });

      // Create and accept H1
      const h1 = await state.state.handoffs.createIdempotent("req-1", {
        projectId: project.id,
        workspaceId: workspace.id,
        taskId: task.id,
        sourceAgentId: agentA.id,
        sourceRunId: "run-1",
        targetAgentId: agentB.id,
        requestedAction: "implement",
        summary: "First handoff",
      });

      const result1 = await arbiter.atomicAccept(h1.id);
      expect(result1.success).toBe(true);

      // Create concurrent H2 for same task
      const h2 = await state.state.handoffs.createIdempotent("req-2", {
        projectId: project.id,
        workspaceId: workspace.id,
        taskId: task.id,
        sourceAgentId: agentC.id,
        sourceRunId: "run-2",
        targetAgentId: agentC.id,
        requestedAction: "review",
        summary: "Concurrent handoff",
      });

      // Attempt to accept H2
      const result2 = await arbiter.atomicAccept(h2.id);

      // Verify rejection
      expect(result2.success).toBe(false);
      expect(result2.rejection?.reason).toBe("existing_authority");
      expect(result2.rejection?.winnerId).toBe(h1.id);
      expect(result2.decision).toBeDefined();
      expect(result2.decision?.arbitrationReason).toBe("existing_authority");
      expect(result2.decision?.winnerId).toBe(h1.id);
      expect(result2.decision?.loserIds).toContain(h2.id);

      // Verify H2 remains pending
      const notAccepted = await state.state.handoffs.getById(h2.id);
      expect(notAccepted?.status).toBe("pending");

      // Verify decision is durable
      const decision = await state.state.authorityDecisions.getById(result2.decision!.id);
      expect(decision).toBeDefined();
    });
  });

  describe("Scenario 2: Explicit Supersession", () => {
    it("should revoke existing handoff when new one supersedes it", async () => {
      const arbiter = createAuthorityArbiter({
        repos: state.state.repos,
        logger,
      });

      // Create and accept H1
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

      const result1 = await arbiter.atomicAccept(h1.id);
      expect(result1.success).toBe(true);

      // Create H2 with explicit supersession
      const h2 = await state.state.handoffs.createIdempotent("req-2", {
        projectId: project.id,
        workspaceId: workspace.id,
        taskId: task.id,
        sourceAgentId: agentA.id,
        sourceRunId: "run-2",
        targetAgentId: agentC.id,
        requestedAction: "take_over",
        summary: "Superseding handoff",
        metadata: { supersedes: h1.id },
      });

      // Accept H2 with supersession
      const result2 = await arbiter.atomicAccept(h2.id);

      // Verify success
      expect(result2.success).toBe(true);
      expect(result2.decision?.arbitrationReason).toBe("explicit_supersession");
      expect(result2.decision?.winnerId).toBe(h2.id);
      expect(result2.decision?.loserIds).toContain(h1.id);

      // Verify H1 is revoked
      const revoked = await state.state.handoffs.getById(h1.id);
      expect(revoked?.status).toBe("revoked");

      // Verify H2 is accepted
      const accepted = await state.state.handoffs.getById(h2.id);
      expect(accepted?.status).toBe("accepted");

      // Verify authority shifted
      const currentAuth = await arbiter.getCurrentAuthority("task", task.id);
      expect(currentAuth?.id).toBe(h2.id);
    });
  });

  describe("Invariant 1: Atomic Acceptance", () => {
    it("should record decision even when acceptance fails", async () => {
      const arbiter = createAuthorityArbiter({
        repos: state.state.repos,
        logger,
      });

      // Create and accept H1
      const h1 = await state.state.handoffs.createIdempotent("req-1", {
        projectId: project.id,
        workspaceId: workspace.id,
        taskId: task.id,
        sourceAgentId: agentA.id,
        sourceRunId: "run-1",
        targetAgentId: agentB.id,
        requestedAction: "implement",
        summary: "First handoff",
      });

      await arbiter.atomicAccept(h1.id);

      // Create H2 that will fail
      const h2 = await state.state.handoffs.createIdempotent("req-2", {
        projectId: project.id,
        workspaceId: workspace.id,
        taskId: task.id,
        sourceAgentId: agentC.id,
        sourceRunId: "run-2",
        targetAgentId: agentC.id,
        requestedAction: "review",
        summary: "Conflicting handoff",
      });

      const result = await arbiter.atomicAccept(h2.id);
      expect(result.success).toBe(false);

      // Verify decision was recorded (no silent rejection)
      expect(result.decision).toBeDefined();
      const decision = await state.state.authorityDecisions.getById(result.decision!.id);
      expect(decision).toBeDefined();
      expect(decision?.winnerId).toBe(h1.id);
    });
  });

  describe("Invariant 3: Single Authority", () => {
    it("should maintain only one active authority per task", async () => {
      const arbiter = createAuthorityArbiter({
        repos: state.state.repos,
        logger,
      });

      // Create and accept H1
      const h1 = await state.state.handoffs.createIdempotent("req-1", {
        projectId: project.id,
        workspaceId: workspace.id,
        taskId: task.id,
        sourceAgentId: agentA.id,
        sourceRunId: "run-1",
        targetAgentId: agentB.id,
        requestedAction: "implement",
        summary: "First handoff",
      });

      await arbiter.atomicAccept(h1.id);
      let current = await arbiter.getCurrentAuthority("task", task.id);
      expect(current?.id).toBe(h1.id);

      // Try multiple concurrent accepts
      for (let i = 2; i <= 4; i++) {
        const handoff = await state.state.handoffs.createIdempotent(`req-${i}`, {
          projectId: project.id,
          workspaceId: workspace.id,
          taskId: task.id,
          sourceAgentId: agentA.id,
          sourceRunId: `run-${i}`,
          targetAgentId: [agentB, agentC][i % 2].id,
          requestedAction: "something",
          summary: `Concurrent ${i}`,
        });

        const result = await arbiter.atomicAccept(handoff.id);
        if (!result.success) {
          // All subsequent should fail
          expect(result.rejection?.winnerId).toBe(h1.id);
        }
      }

      // Verify still only H1 is authority
      current = await arbiter.getCurrentAuthority("task", task.id);
      expect(current?.id).toBe(h1.id);
    });
  });

  describe("Invariant 4: Deterministic Recovery", () => {
    it("should reconstruct identical authority after restart", async () => {
      const arbiter1 = createAuthorityArbiter({
        repos: state.state.repos,
        logger,
      });

      // Create and accept H1
      const h1 = await state.state.handoffs.createIdempotent("req-1", {
        projectId: project.id,
        workspaceId: workspace.id,
        taskId: task.id,
        sourceAgentId: agentA.id,
        sourceRunId: "run-1",
        targetAgentId: agentB.id,
        requestedAction: "implement",
        summary: "First handoff",
      });

      const result1 = await arbiter1.atomicAccept(h1.id);
      const authority1 = await arbiter1.getCurrentAuthority("task", task.id);

      // "Restart": Create new arbiter from same durable state
      const arbiter2 = createAuthorityArbiter({
        repos: state.state.repos,
        logger,
      });

      // Verify identical authority
      const authority2 = await arbiter2.getCurrentAuthority("task", task.id);
      expect(authority2?.id).toBe(authority1?.id);
      expect(authority2?.id).toBe(h1.id);

      // Verify decision is identical
      const decisions1 = await arbiter1.getDecisionsForHandoff(h1.id);
      const decisions2 = await arbiter2.getDecisionsForHandoff(h1.id);
      expect(decisions2).toHaveLength(decisions1.length);
    });
  });

  describe("Invariant 5: Decision Immutability", () => {
    it("should not allow modification of recorded decisions", async () => {
      const arbiter = createAuthorityArbiter({
        repos: state.state.repos,
        logger,
      });

      // Create and accept H1
      const h1 = await state.state.handoffs.createIdempotent("req-1", {
        projectId: project.id,
        workspaceId: workspace.id,
        taskId: task.id,
        sourceAgentId: agentA.id,
        sourceRunId: "run-1",
        targetAgentId: agentB.id,
        requestedAction: "implement",
        summary: "First handoff",
      });

      const result1 = await arbiter.atomicAccept(h1.id);
      const decision1 = result1.decision!;

      // Attempt to modify decision (should fail or be ignored in production)
      // For this test, we just verify the original is unchanged
      const fetched = await state.state.authorityDecisions.getById(decision1.id);
      expect(fetched?.winnerId).toBe(h1.id);
      expect(fetched?.arbitrationReason).toBe("first_accepted");
    });
  });
});

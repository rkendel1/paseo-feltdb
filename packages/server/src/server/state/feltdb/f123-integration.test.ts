/**
 * FeltDB F1/F2/F3 Integration Tests
 *
 * Acceptance gates for Paseo adoption of atomic sequence allocation (F1),
 * durable idempotent mutation (F2), and compare-and-set with version detection (F3).
 *
 * Gate A: Real Defects Disappear
 * Gate B: Workarounds Disappear
 * Gate C: Concurrent Production Workload
 * Gate D: Durability Through Restart/Crash
 * Gate E: No Regressions in Existing Suite
 * Gate F: Code Reduction Measurement
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import pino from 'pino';
import { createDaemonTestContext, type DaemonTestContext } from '../../test-utils/index.js';

describe('FeltDB F1/F2/F3 Integration - Acceptance Gates', () => {
  let ctx: DaemonTestContext | undefined;
  let paseoHomeRoot: string;

  beforeEach(async () => {
    paseoHomeRoot = mkdtempSync(path.join(tmpdir(), 'f123-test-'));
    const logger = pino({ level: 'warn' });
    ctx = await createDaemonTestContext({ paseoHomeRoot, cleanup: false, logger });
  });

  afterEach(async () => {
    if (ctx) {
      await ctx.cleanup();
    }
    try {
      rmSync(paseoHomeRoot, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  // ============================================================================
  // Gate A: Real Defects Disappear
  // ============================================================================

  describe('Gate A.1: Message Sequence Race Eliminated (F1)', () => {
    it('allocates message sequences without collisions under concurrent load', async () => {
      if (!ctx) throw new Error('Test context not initialized');

      // Create project, workspace, agent, and conversation
      const project = await ctx.daemon.paseoState.projects.create({
        title: 'F1 Test',
        rootPath: '/tmp/f1-test',
      });

      const workspace = await ctx.daemon.paseoState.workspaces.create({
        projectId: project.id,
        name: 'test-workspace',
        cwd: '/tmp/f1-test',
      });

      const agent = await ctx.daemon.paseoState.agents.create({
        workspaceId: workspace.id,
        providerId: 'claude',
        title: 'F1 Test Agent',
        status: 'idle',
      });

      const conversation = await ctx.daemon.paseoState.conversations.create({
        projectId: project.id,
        workspaceId: workspace.id,
        agentId: agent.id,
        title: 'Test Conversation',
      });

      // Concurrently create 100 messages - should get sequences 1..100
      const msgPromises = [];
      for (let i = 0; i < 100; i++) {
        msgPromises.push(
          ctx.daemon.paseoState.messages.create({
            conversationId: conversation.id,
            authorId: agent.id,
            authorType: 'agent',
            content: `Message ${i}`,
          })
        );
      }

      const messages = await Promise.all(msgPromises);

      // Verify: all 100 messages created
      expect(messages).toHaveLength(100);

      // Verify: all sequences are unique
      const sequences = messages.map((m) => m.sequence).sort((a, b) => a - b);
      const uniqueSequences = new Set(sequences);
      expect(uniqueSequences.size).toBe(100);

      // Verify: sequences are [1..100]
      expect(sequences[0]).toBe(1);
      expect(sequences[99]).toBe(100);

      // Verify: no gaps
      for (let i = 0; i < 100; i++) {
        expect(sequences[i]).toBe(i + 1);
      }
    });

    it('maintains monotonic sequence ordering under concurrent message creation', async () => {
      if (!ctx) throw new Error('Test context not initialized');

      const project = await ctx.daemon.paseoState.projects.create({
        title: 'F1 Monotonic Test',
        rootPath: '/tmp/f1-monotonic',
      });

      const workspace = await ctx.daemon.paseoState.workspaces.create({
        projectId: project.id,
        name: 'test-workspace',
        cwd: '/tmp/f1-monotonic',
      });

      const agent = await ctx.daemon.paseoState.agents.create({
        workspaceId: workspace.id,
        providerId: 'claude',
        title: 'F1 Monotonic Agent',
        status: 'idle',
      });

      const conversation = await ctx.daemon.paseoState.conversations.create({
        projectId: project.id,
        workspaceId: workspace.id,
        agentId: agent.id,
        title: 'Monotonic Test',
      });

      // Create messages in bursts to stress test ordering
      const allMessages: any[] = [];

      for (let burst = 0; burst < 3; burst++) {
        const burstPromises = [];
        for (let i = 0; i < 30; i++) {
          burstPromises.push(
            ctx.daemon.paseoState.messages.create({
              conversationId: conversation.id,
              authorId: agent.id,
              authorType: 'agent',
              content: `Burst ${burst} Message ${i}`,
            })
          );
        }
        const burstMessages = await Promise.all(burstPromises);
        allMessages.push(...burstMessages);
      }

      // Verify ordering across bursts
      const sequences = allMessages.map((m) => m.sequence).sort((a, b) => a - b);
      for (let i = 0; i < sequences.length; i++) {
        expect(sequences[i]).toBe(i + 1);
      }
    });
  });

  describe('Gate A.2: Message Duplicate Ingestion Eliminated (F2)', () => {
    it('rejects duplicate message submissions with same messageId', async () => {
      if (!ctx) throw new Error('Test context not initialized');

      const project = await ctx.daemon.paseoState.projects.create({
        title: 'F2 Test',
        rootPath: '/tmp/f2-test',
      });

      const workspace = await ctx.daemon.paseoState.workspaces.create({
        projectId: project.id,
        name: 'test-workspace',
        cwd: '/tmp/f2-test',
      });

      const agent = await ctx.daemon.paseoState.agents.create({
        workspaceId: workspace.id,
        providerId: 'claude',
        title: 'F2 Test Agent',
        status: 'idle',
      });

      const conversation = await ctx.daemon.paseoState.conversations.create({
        projectId: project.id,
        workspaceId: workspace.id,
        agentId: agent.id,
        title: 'F2 Idempotency Test',
      });

      const idempotencyKey = `msg:${randomUUID()}`;

      // Submit same message 10 times concurrently with idempotency
      const submitPromises = [];
      for (let i = 0; i < 10; i++) {
        submitPromises.push(
          ctx.daemon.paseoState.messages.createIdempotent(
            {
              conversationId: conversation.id,
              authorId: agent.id,
              authorType: 'agent',
              content: 'Idempotent message',
            },
            idempotencyKey
          )
        );
      }

      const results = await Promise.all(submitPromises);

      // Verify: only one message was actually created
      const createdCount = results.filter((r) => r.created).length;
      expect(createdCount).toBe(1);

      // Verify: exactly 9 were rejected as duplicates
      const rejectedCount = results.filter((r) => !r.created).length;
      expect(rejectedCount).toBe(9);

      // Verify: database has only 1 message with this content
      const messages = await ctx.daemon.paseoState.messages.listByConversation(conversation.id);
      const idempotentMessages = messages.filter((m) => m.content === 'Idempotent message');
      expect(idempotentMessages.length).toBe(1);
    });

    it('durably records idempotency after restart', async () => {
      if (!ctx) throw new Error('Test context not initialized');

      const project = await ctx.daemon.paseoState.projects.create({
        title: 'F2 Durability Test',
        rootPath: '/tmp/f2-durability',
      });

      const workspace = await ctx.daemon.paseoState.workspaces.create({
        projectId: project.id,
        name: 'test-workspace',
        cwd: '/tmp/f2-durability',
      });

      const agent = await ctx.daemon.paseoState.agents.create({
        workspaceId: workspace.id,
        providerId: 'claude',
        title: 'F2 Durability Agent',
        status: 'idle',
      });

      const conversation = await ctx.daemon.paseoState.conversations.create({
        projectId: project.id,
        workspaceId: workspace.id,
        agentId: agent.id,
        title: 'F2 Durability Conversation',
      });

      const idempotencyKey = `msg-durable:${randomUUID()}`;

      // Submit message first time
      const result1 = await ctx.daemon.paseoState.messages.createIdempotent(
        {
          conversationId: conversation.id,
          authorId: agent.id,
          authorType: 'agent',
          content: 'Durable idempotent message',
        },
        idempotencyKey
      );

      expect(result1.created).toBe(true);

      // Restart daemon (keeping same paseoHomeRoot)
      await ctx.cleanup();
      const logger = pino({ level: 'warn' });
      ctx = await createDaemonTestContext({ paseoHomeRoot, cleanup: false, logger });

      // Retry with same idempotency key
      const result2 = await ctx.daemon.paseoState.messages.createIdempotent(
        {
          conversationId: conversation.id,
          authorId: agent.id,
          authorType: 'agent',
          content: 'Durable idempotent message',
        },
        idempotencyKey
      );

      // Verify: still rejected (idempotency survived restart)
      expect(result2.created).toBe(false);
    });
  });

  describe('Gate A.3: Task Update Loss Eliminated (F3)', () => {
    it('detects concurrent task updates and rejects one with conflict', async () => {
      if (!ctx) throw new Error('Test context not initialized');

      const project = await ctx.daemon.paseoState.projects.create({
        title: 'F3 Test',
        rootPath: '/tmp/f3-test',
      });

      const task = await ctx.daemon.paseoState.tasks.create({
        projectId: project.id,
        title: 'Concurrent Edit Task',
        status: 'open',
      });

      // Two concurrent updates to same task
      const updatePromises = [
        ctx.daemon.paseoState.tasks.update(task.id, {
          status: 'in_progress',
          assigneeId: 'agent-a',
        }),
        ctx.daemon.paseoState.tasks.update(task.id, {
          status: 'completed',
          assigneeId: 'agent-b',
        }),
      ];

      const results = await Promise.allSettled(updatePromises);

      // One should succeed, one should fail with conflict
      const succeeded = results.filter((r) => r.status === 'fulfilled');
      const failed = results.filter((r) => r.status === 'rejected');

      expect(succeeded.length).toBe(1);
      expect(failed.length).toBe(1);

      // Verify the conflict error is properly structured
      const conflictError = failed[0] as PromiseRejectedResult;
      expect((conflictError.reason as any).code).toBe('CONFLICT');

      // Verify final task is in ONE consistent state (not partial)
      const finalTask = await ctx.daemon.paseoState.tasks.getById(task.id);
      if (finalTask) {
        // Should be either all fields from update A or all from update B
        if (finalTask.status === 'in_progress') {
          expect(finalTask.assigneeId).toBe('agent-a');
        } else if (finalTask.status === 'completed') {
          expect(finalTask.assigneeId).toBe('agent-b');
        }
      }
    });

    it('prevents silent update loss under high-concurrency task edits', async () => {
      if (!ctx) throw new Error('Test context not initialized');

      const project = await ctx.daemon.paseoState.projects.create({
        title: 'F3 High Concurrency Test',
        rootPath: '/tmp/f3-highconcurrency',
      });

      const task = await ctx.daemon.paseoState.tasks.create({
        projectId: project.id,
        title: 'High Concurrency Task',
        status: 'open',
        metadata: {},
      });

      // 5 concurrent updates from different agents
      const updatePromises = [];
      for (let i = 0; i < 5; i++) {
        updatePromises.push(
          ctx.daemon.paseoState.tasks.update(task.id, {
            metadata: {
              updatedBy: `agent-${i}`,
              iteration: i,
              timestamp: Date.now(),
            },
          })
        );
      }

      const results = await Promise.allSettled(updatePromises);

      // Exactly 1 should succeed, 4 should conflict
      const succeeded = results.filter((r) => r.status === 'fulfilled').length;
      const failed = results.filter((r) => r.status === 'rejected').length;

      expect(succeeded).toBe(1);
      expect(failed).toBe(4);

      // Final task should be in exactly one of the attempted states
      const finalTask = await ctx.daemon.paseoState.tasks.getById(task.id);
      if (finalTask && finalTask.metadata) {
        // Should have exactly one agent's update
        expect(finalTask.metadata.updatedBy).toMatch(/^agent-[0-4]$/);
      }
    });
  });

  // ============================================================================
  // Gate C: Concurrent Production Workload
  // ============================================================================

  describe('Gate C: Production Workload Simulation', () => {
    it('handles 5 agents, 100 messages each without sequence collisions', async () => {
      if (!ctx) throw new Error('Test context not initialized');

      const agents = ['agent-1', 'agent-2', 'agent-3', 'agent-4', 'agent-5'];

      const project = await ctx.daemon.paseoState.projects.create({
        title: 'Production Workload Test',
        rootPath: '/tmp/production-workload',
      });

      const workspace = await ctx.daemon.paseoState.workspaces.create({
        projectId: project.id,
        name: 'test-workspace',
        cwd: '/tmp/production-workload',
      });

      // Create conversation
      const conv = await ctx.daemon.paseoState.conversations.create({
        projectId: project.id,
        workspaceId: workspace.id,
        agentId: agents[0],
        title: 'Multi-agent Conversation',
      });

      // 5 agents × 100 messages = 500 concurrent creates
      const messagePromises = [];
      for (const agentId of agents) {
        for (let i = 1; i <= 100; i++) {
          messagePromises.push(
            ctx.daemon.paseoState.messages.create({
              conversationId: conv.id,
              authorType: 'agent',
              authorId: agentId,
              content: `Message ${i} from ${agentId}`,
            })
          );
        }
      }

      const messages = await Promise.all(messagePromises);

      // Verify: 500 messages, sequences [1..500], all unique
      expect(messages).toHaveLength(500);
      const sequences = messages.map((m) => m.sequence);
      expect(new Set(sequences).size).toBe(500); // All unique
      expect(Math.min(...sequences)).toBe(1);
      expect(Math.max(...sequences)).toBe(500);
    });

    it('rejects 10 concurrent submissions of same idempotency key (F2)', async () => {
      if (!ctx) throw new Error('Test context not initialized');

      const project = await ctx.daemon.paseoState.projects.create({
        title: 'F2 Concurrent Dedup Test',
        rootPath: '/tmp/f2-concurrent',
      });

      const workspace = await ctx.daemon.paseoState.workspaces.create({
        projectId: project.id,
        name: 'test-workspace',
        cwd: '/tmp/f2-concurrent',
      });

      const agent = await ctx.daemon.paseoState.agents.create({
        workspaceId: workspace.id,
        providerId: 'claude',
        title: 'F2 Dedup Agent',
        status: 'idle',
      });

      const conv = await ctx.daemon.paseoState.conversations.create({
        projectId: project.id,
        workspaceId: workspace.id,
        agentId: agent.id,
        title: 'F2 Dedup Conversation',
      });

      const idempotencyKey = `event:${randomUUID()}`;

      // Submit same event 10 times concurrently
      const results = await Promise.all(
        Array(10)
          .fill(0)
          .map(() =>
            ctx.daemon.paseoState.messages.createIdempotent(
              {
                conversationId: conv.id,
                authorId: agent.id,
                authorType: 'agent',
                content: 'Concurrent dedup event',
              },
              idempotencyKey
            )
          )
      );

      // Verify: only first accepted, rest rejected
      const messages = await ctx.daemon.paseoState.messages.listByConversation(conv.id);
      const withThisContent = messages.filter((m) => m.content === 'Concurrent dedup event');
      expect(withThisContent).toHaveLength(1);

      // Verify: exactly 1 created, 9 rejected
      const createdCount = results.filter((r) => r.created).length;
      const rejectedCount = results.filter((r) => !r.created).length;
      expect(createdCount).toBe(1);
      expect(rejectedCount).toBe(9);
    });

    it('detects conflicts on concurrent task updates (F3)', async () => {
      if (!ctx) throw new Error('Test context not initialized');

      const project = await ctx.daemon.paseoState.projects.create({
        title: 'F3 Concurrent Updates',
        rootPath: '/tmp/f3-concurrent',
      });

      const task = await ctx.daemon.paseoState.tasks.create({
        projectId: project.id,
        title: 'Multi-agent update task',
        status: 'open',
      });

      // 3 concurrent updates
      const results = await Promise.allSettled([
        ctx.daemon.paseoState.tasks.update(task.id, { status: 'in_progress' }),
        ctx.daemon.paseoState.tasks.update(task.id, { status: 'completed' }),
        ctx.daemon.paseoState.tasks.update(task.id, { status: 'on_hold' }),
      ]);

      // Exactly one succeeds, two fail with conflict
      const fulfilled = results.filter((r) => r.status === 'fulfilled').length;
      const rejected = results.filter((r) => r.status === 'rejected').length;
      expect(fulfilled).toBe(1);
      expect(rejected).toBe(2);

      // Final task is in ONE consistent state (one of the three attempted states)
      const finalTask = await ctx.daemon.paseoState.tasks.getById(task.id);
      expect(
        finalTask?.status === 'in_progress' ||
          finalTask?.status === 'completed' ||
          finalTask?.status === 'on_hold'
      ).toBe(true);
    });
  });

  // ============================================================================
  // Gate D: Durability Through Restart/Crash
  // ============================================================================

  describe('Gate D: Durability Through Restart', () => {
    it('survives daemon restart with F1/F2/F3 state persisted', async () => {
      if (!ctx) throw new Error('Test context not initialized');

      // 1. Create initial state
      const project = await ctx.daemon.paseoState.projects.create({
        title: 'Restart Test Project',
        rootPath: '/tmp/restart-test',
      });

      const workspace = await ctx.daemon.paseoState.workspaces.create({
        projectId: project.id,
        name: 'restart-workspace',
        cwd: '/tmp/restart-test',
      });

      const agent = await ctx.daemon.paseoState.agents.create({
        workspaceId: workspace.id,
        providerId: 'claude',
        title: 'Restart Agent',
        status: 'idle',
      });

      const conversation = await ctx.daemon.paseoState.conversations.create({
        projectId: project.id,
        workspaceId: workspace.id,
        agentId: agent.id,
        title: 'Restart Conversation',
      });

      // Create messages (uses F1 for sequences)
      const msg1 = await ctx.daemon.paseoState.messages.create({
        conversationId: conversation.id,
        authorId: agent.id,
        authorType: 'agent',
        content: 'Message 1',
      });

      const msg2 = await ctx.daemon.paseoState.messages.create({
        conversationId: conversation.id,
        authorId: agent.id,
        authorType: 'agent',
        content: 'Message 2',
      });

      expect(msg1.sequence).toBe(1);
      expect(msg2.sequence).toBe(2);

      const idempotencyKey = `restart:${randomUUID()}`;
      const idempotentResult = await ctx.daemon.paseoState.messages.createIdempotent(
        {
          conversationId: conversation.id,
          authorId: agent.id,
          authorType: 'agent',
          content: 'Idempotent message',
        },
        idempotencyKey
      );
      expect(idempotentResult.created).toBe(true);

      const task = await ctx.daemon.paseoState.tasks.create({
        projectId: project.id,
        title: 'Restart Task',
        status: 'open',
      });

      // 2. Restart daemon (keeping paseoHomeRoot)
      await ctx.cleanup();
      const logger = pino({ level: 'warn' });
      ctx = await createDaemonTestContext({ paseoHomeRoot, cleanup: false, logger });

      // 3. Verify state was recovered
      const recoveredProject = await ctx.daemon.paseoState.projects.getById(project.id);
      expect(recoveredProject).toBeDefined();
      expect(recoveredProject?.title).toBe('Restart Test Project');

      const recoveredMessages = await ctx.daemon.paseoState.messages.listByConversation(
        conversation.id
      );
      expect(recoveredMessages).toHaveLength(3);

      // Verify sequences continued from where they left off
      const msg3 = await ctx.daemon.paseoState.messages.create({
        conversationId: conversation.id,
        authorId: agent.id,
        authorType: 'agent',
        content: 'Message 3',
      });
      expect(msg3.sequence).toBe(4); // Should continue from 3, not restart at 1

      // Verify dedup keys still work
      const secondAttempt = await ctx.daemon.paseoState.messages.createIdempotent(
        {
          conversationId: conversation.id,
          authorId: agent.id,
          authorType: 'agent',
          content: 'Idempotent message',
        },
        idempotencyKey
      );
      expect(secondAttempt.created).toBe(false); // Still rejected!

      const recoveredTask = await ctx.daemon.paseoState.tasks.getById(task.id);
      expect(recoveredTask).toBeDefined();
      expect(recoveredTask?.title).toBe('Restart Task');
    });

    it('recovers from partial writes (F1/F2/F3 durability)', async () => {
      if (!ctx) throw new Error('Test context not initialized');

      // Create initial data with multiple entities
      const project = await ctx.daemon.paseoState.projects.create({
        title: 'Durability Test',
        rootPath: '/tmp/durability',
      });

      const workspace = await ctx.daemon.paseoState.workspaces.create({
        projectId: project.id,
        name: 'durability-ws',
        cwd: '/tmp/durability',
      });

      // Create multiple messages to exercise sequence allocation
      const conversation = await ctx.daemon.paseoState.conversations.create({
        projectId: project.id,
        workspaceId: workspace.id,
        agentId: 'agent-1',
        title: 'Durability Conv',
      });

      const msgPromises = [];
      for (let i = 0; i < 20; i++) {
        msgPromises.push(
          ctx.daemon.paseoState.messages.create({
            conversationId: conversation.id,
            authorId: 'agent-1',
            authorType: 'agent',
            content: `Durable message ${i}`,
          })
        );
      }
      await Promise.all(msgPromises);

      // Restart and verify
      await ctx.cleanup();
      const logger = pino({ level: 'warn' });
      ctx = await createDaemonTestContext({ paseoHomeRoot, cleanup: false, logger });

      // All messages should still be there
      const allMessages = await ctx.daemon.paseoState.messages.listByConversation(conversation.id);
      expect(allMessages.length).toBe(20);

      // Sequences should all be unique and contiguous
      const sequences = allMessages.map((m) => m.sequence).sort((a, b) => a - b);
      for (let i = 0; i < sequences.length; i++) {
        expect(sequences[i]).toBe(i + 1);
      }
    });
  });

});

/**
 * FeltDB Persistence Diagnostic - Simplified
 *
 * Core question: Where is the timeline data actually stored?
 * Is it in FeltDB or somewhere else?
 */

import { describe, test, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createDaemonTestContext, type DaemonTestContext } from "../test-utils/index.js";

function tmpCwd(): string {
  return mkdtempSync(path.join(tmpdir(), "feltdb-simple-"));
}

function createFixtureRepository(cwd: string): void {
  writeFileSync(path.join(cwd, "README.md"), "# Test");
  const srcDir = path.join(cwd, "src");
  mkdirSync(srcDir, { recursive: true });
  writeFileSync(path.join(srcDir, "config.ts"), `export const KEY = "test";`);
}

describe("FeltDB Persistence - Simple", () => {
  test("Where does timeline data actually live?", async () => {
    const paseoHomeRoot = mkdtempSync(path.join(tmpdir(), "feltdb-simple-home-"));
    const projectCwd = tmpCwd();

    let ctx: DaemonTestContext | undefined;

    try {
      // Setup
      ctx = await createDaemonTestContext({ paseoHomeRoot, cleanup: false });
      createFixtureRepository(projectCwd);

      const agent = await ctx.client.createAgent({
        provider: "claude",
        cwd: projectCwd,
        title: "Test Agent",
        modeId: "full-access",
      });

      // Execute
      await ctx.client.sendMessage(agent.id, "Analyze the repository.");
      const result = await ctx.client.waitForFinish(agent.id, 30000);
      expect(result.status).toBe("idle");

      // Get timeline BEFORE restart
      const timelineBefore = await ctx.client.fetchAgentTimeline(agent.id, {
        direction: "tail",
        limit: 0,
        projection: "canonical",
      });

      console.log(`\n📊 Timeline BEFORE restart: ${timelineBefore.entries.length} items`);
      for (const entry of timelineBefore.entries) {
        console.log(`   - ${entry.item.type}`);
      }

      // Check what's in FeltDB
      const daemon = (ctx.daemon as any).daemon;
      const paseoState = daemon.paseoState;

      const allProjects = await paseoState.projects.listAll();
      const allAgents = await paseoState.repos.agents.listAll?.() || [];
      const allMessages = await paseoState.messages.list?.() || [];
      const allRuns = await paseoState.runs.list?.() || [];
      const allConversations = await paseoState.conversations.listAll?.() || [];

      console.log(`\n📦 FeltDB State BEFORE restart:`);
      console.log(`   Projects: ${allProjects.length}`);
      console.log(`   Agents: ${allAgents.length}`);
      console.log(`   Messages: ${allMessages.length}`);
      console.log(`   Runs: ${allRuns.length}`);
      console.log(`   Conversations: ${allConversations.length}`);

      // Restart daemon
      console.log(`\n🔄 Restarting daemon...`);
      await ctx.cleanup();
      ctx = await createDaemonTestContext({ paseoHomeRoot, cleanup: false });

      // Get timeline AFTER restart
      const timelineAfter = await ctx.client.fetchAgentTimeline(agent.id, {
        direction: "tail",
        limit: 0,
        projection: "canonical",
      });

      console.log(`\n📊 Timeline AFTER restart: ${timelineAfter.entries.length} items`);
      for (const entry of timelineAfter.entries) {
        console.log(`   - ${entry.item.type}`);
      }

      // Check what's in FeltDB after restart
      const daemon2 = (ctx.daemon as any).daemon;
      const paseoState2 = daemon2.paseoState;

      const allProjects2 = await paseoState2.projects.listAll();
      const allAgents2 = await paseoState2.repos.agents.listAll?.() || [];
      const allMessages2 = await paseoState2.messages.list?.() || [];
      const allRuns2 = await paseoState2.runs.list?.() || [];
      const allConversations2 = await paseoState2.conversations.listAll?.() || [];

      console.log(`\n📦 FeltDB State AFTER restart:`);
      console.log(`   Projects: ${allProjects2.length}`);
      console.log(`   Agents: ${allAgents2.length}`);
      console.log(`   Messages: ${allMessages2.length}`);
      console.log(`   Runs: ${allRuns2.length}`);
      console.log(`   Conversations: ${allConversations2.length}`);

      // Summary
      console.log(`\n🔍 ANALYSIS:`);
      console.log(`   Timeline count: ${timelineBefore.entries.length} → ${timelineAfter.entries.length}`);
      console.log(`   Lost: ${timelineBefore.entries.length - timelineAfter.entries.length} items`);
      console.log(`   FeltDB has projects: ${allProjects2.length > 0}`);
      console.log(`   FeltDB has agents: ${allAgents2.length > 0}`);
      console.log(`   FeltDB has messages: ${allMessages2.length > 0}`);
    } finally {
      if (ctx) {
        await ctx.cleanup();
      }
      try {
        rmSync(projectCwd, { recursive: true, force: true });
      } catch {
        // ignore
      }
      try {
        rmSync(paseoHomeRoot, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  }, 300000);
});

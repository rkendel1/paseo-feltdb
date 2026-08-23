/**
 * FeltDB Persistence Diagnostic
 * Directly inspects what's persisted to FeltDB during 3.7.2 test execution
 */

import { describe, test } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createDaemonTestContext, type DaemonTestContext } from "../test-utils/index.js";

function tmpCwd(): string {
  return mkdtempSync(path.join(tmpdir(), "feltdb-inspect-"));
}

function createFixtureRepository(cwd: string): void {
  writeFileSync(
    path.join(cwd, "README.md"),
    `# Test Repository

This is a fixture repository for FeltDB inspection.
`,
  );

  const srcDir = path.join(cwd, "src");
  mkdirSync(srcDir, { recursive: true });
  writeFileSync(path.join(srcDir, "config.ts"), `export const API_KEY = "test-key-12345";`);
}

async function inspectFeltDB(ctx: DaemonTestContext, label: string): Promise<void> {
  const paseoState = (ctx.daemon as any).daemon.paseoState;

  // Query all state
  const allProjects = await paseoState.projects.listAll();
  const allWorkspaces = await paseoState.workspaces.listByProject(allProjects[0]?.id ?? "");
  const allAgents = allProjects.length > 0 ? await Promise.all(
    allProjects.map((p) =>
      paseoState.repos.agents.listByProject(p.id).catch(() => [])
    )
  ) : [];

  console.log(`\n📊 FeltDB Inspection: ${label}`);
  console.log(`   Projects: ${allProjects.length}`);

  for (const project of allProjects) {
    console.log(`   Project: ${project.id} (${project.name})`);

    // Get all agents in this project
    const projectAgents = await paseoState.repos.agents.listByProject(project.id);
    console.log(`     Agents: ${projectAgents.length}`);

    for (const agent of projectAgents) {
      console.log(`       Agent: ${agent.id}`);

      // Get runs for this agent
      const runs = await paseoState.runs.listByAgent(agent.id);
      console.log(`         Runs: ${runs.length}`);

      for (const run of runs) {
        console.log(`           Run: ${run.id} (status: ${run.status})`);

        // Get messages in conversations for this run
        const conversations = await paseoState.conversations.listByAgent(agent.id);
        console.log(`           Conversations: ${conversations.length}`);

        for (const conv of conversations) {
          const messages = await paseoState.messages.listByConversation(conv.id);
          console.log(`             Conversation ${conv.id}: ${messages.length} messages`);

          for (const msg of messages) {
            console.log(
              `               Message: ${msg.id} (type: ${msg.authorType}, seq: ${msg.sequence})`,
            );
            if (msg.content && msg.content.length < 100) {
              console.log(`                 Content: "${msg.content}"`);
            }
          }
        }
      }

      // Get observations for this agent
      const observations = await paseoState.observations.listByAgent(agent.id);
      console.log(`         Observations: ${observations.length}`);

      for (const obs of observations) {
        console.log(`           Observation: ${obs.id} (type: ${obs.type})`);
        if (obs.content && obs.content.length < 100) {
          console.log(`             Content: "${obs.content}"`);
        }
      }
    }
  }
}

describe("FeltDB Persistence Diagnostic", () => {
  test("Inspect FeltDB state before and after daemon restart", async () => {
    const paseoHomeRoot = mkdtempSync(path.join(tmpdir(), "feltdb-inspect-home-"));
    const projectACwd = tmpCwd();

    let ctx: DaemonTestContext | undefined;

    try {
    // ===== PHASE 1: Create daemon with stable home
    ctx = await createDaemonTestContext({ paseoHomeRoot, cleanup: false });
    console.log("✅ Daemon started");

    // ===== PHASE 2: Create fixture and agent
    createFixtureRepository(projectACwd);

    const agent1 = await ctx.client.createAgent({
      provider: "claude",
      cwd: projectACwd,
      title: "Agent 1",
      modeId: "full-access",
    });
    console.log(`✅ Agent created: ${agent1.id}`);

    // ===== PHASE 3: Execute agent
    await ctx.client.sendMessage(agent1.id, "Analyze the repository. What do you find?");
    const result = await ctx.client.waitForFinish(agent1.id, 30000);
    console.log(`✅ Agent execution complete (status: ${result.status})`);

    // ===== PHASE 4: Inspect FeltDB BEFORE restart
    await inspectFeltDB(ctx, "BEFORE RESTART");

    // Fetch and log timeline
    const timeline = await ctx.client.fetchAgentTimeline(agent1.id, {
      direction: "tail",
      limit: 0,
      projection: "canonical",
    });
    console.log(`\n📋 Timeline (API): ${timeline.entries.length} items`);
    for (let i = 0; i < timeline.entries.length; i++) {
      const entry = timeline.entries[i];
      console.log(`   [${i}] ${entry.item.type}`);
      if (entry.item.type === "assistant_message" && entry.item.text) {
        console.log(`       "${entry.item.text.substring(0, 80)}..."`);
      }
    }

    // ===== PHASE 5: RESTART DAEMON
    console.log("\n🔄 Restarting daemon...");
    await ctx.cleanup();
    ctx = await createDaemonTestContext({ paseoHomeRoot, cleanup: false });
    console.log("✅ Daemon restarted");

    // ===== PHASE 6: Inspect FeltDB AFTER restart
    await inspectFeltDB(ctx, "AFTER RESTART");

    // Fetch and log timeline again
    const timelineAfter = await ctx.client.fetchAgentTimeline(agent1.id, {
      direction: "tail",
      limit: 0,
      projection: "canonical",
    });
    console.log(`\n📋 Timeline (API) after restart: ${timelineAfter.entries.length} items`);
    for (let i = 0; i < timelineAfter.entries.length; i++) {
      const entry = timelineAfter.entries[i];
      console.log(`   [${i}] ${entry.item.type}`);
      if (entry.item.type === "assistant_message" && entry.item.text) {
        console.log(`       "${entry.item.text.substring(0, 80)}..."`);
      }
    }

    // ===== PHASE 7: Compare
    console.log("\n🔍 COMPARISON");
    console.log(`   Timeline count: ${timeline.entries.length} → ${timelineAfter.entries.length}`);
    console.log(`   Lost: ${timeline.entries.length - timelineAfter.entries.length} items`);
    } finally {
      if (ctx) {
        await ctx.cleanup();
      }
      try {
        rmSync(projectACwd, { recursive: true, force: true });
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

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { createTestLogger } from "../../../../test-utils/test-logger.js";
import { ClaudeAgentClient } from "./agent.js";
import { claudeProjectDirSync } from "./project-dir.js";
import type { AgentSession, AgentStreamEvent } from "../../agent-sdk-types.js";

const SESSION_CWD = "/tmp/paseo-claude-native-titles";
const LAST_ACTIVITY = new Date("2026-07-28T08:00:00.000Z");

interface ClaudeTranscriptRecord {
  [key: string]: unknown;
}

let configDir: string;
let previousConfigDir: string | undefined;

function userRecord(sessionId: string, content: string): ClaudeTranscriptRecord {
  return {
    isSidechain: false,
    type: "user",
    message: { role: "user", content },
    cwd: SESSION_CWD,
    sessionId,
  };
}

function assistantRecord(sessionId: string, text: string): ClaudeTranscriptRecord {
  return {
    isSidechain: false,
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text }] },
    cwd: SESSION_CWD,
    sessionId,
  };
}

async function writeSession(sessionId: string, records: ClaudeTranscriptRecord[]): Promise<void> {
  const projectDir = claudeProjectDirSync(SESSION_CWD, { configDir });
  await fs.mkdir(projectDir, { recursive: true });
  const file = path.join(projectDir, `${sessionId}.jsonl`);
  await fs.writeFile(file, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
  await fs.utimes(file, LAST_ACTIVITY, LAST_ACTIVITY);
}

function createClient(): ClaudeAgentClient {
  return new ClaudeAgentClient({
    logger: createTestLogger(),
    resolveBinary: async () => "/test/claude/bin",
  });
}

async function listTitle(sessionId: string): Promise<string | null> {
  const sessions = await createClient().listImportableSessions({ limit: 5, cwd: SESSION_CWD });
  return sessions.find((session) => session.providerHandleId === sessionId)?.title ?? null;
}

beforeEach(async () => {
  configDir = await fs.mkdtemp(path.join(os.tmpdir(), "paseo-claude-titles-"));
  previousConfigDir = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = configDir;
});

afterEach(async () => {
  if (previousConfigDir === undefined) {
    delete process.env.CLAUDE_CONFIG_DIR;
  } else {
    process.env.CLAUDE_CONFIG_DIR = previousConfigDir;
  }
  await fs.rm(configDir, { recursive: true, force: true });
});

describe("Claude import session titles", () => {
  test("prefers a /rename custom-title over the first user prompt", async () => {
    const sessionId = "renamed-session";
    await writeSession(sessionId, [
      userRecord(sessionId, "Review this project"),
      { type: "custom-title", customTitle: "My research session", sessionId },
    ]);

    await expect(listTitle(sessionId)).resolves.toBe("My research session");
  });

  test("keeps the first user prompt as the prompt preview when a title record wins", async () => {
    const sessionId = "renamed-session-preview";
    await writeSession(sessionId, [
      userRecord(sessionId, "Review this project"),
      { type: "custom-title", customTitle: "My research session", sessionId },
    ]);

    const sessions = await createClient().listImportableSessions({ limit: 5, cwd: SESSION_CWD });

    expect(sessions).toEqual([
      {
        providerHandleId: sessionId,
        cwd: SESSION_CWD,
        title: "My research session",
        firstPromptPreview: "Review this project",
        lastPromptPreview: "Review this project",
        lastActivityAt: LAST_ACTIVITY,
      },
    ]);
  });

  test("uses the last custom-title when the session was renamed more than once", async () => {
    const sessionId = "renamed-twice";
    await writeSession(sessionId, [
      userRecord(sessionId, "Review this project"),
      { type: "custom-title", customTitle: "First name", sessionId },
      assistantRecord(sessionId, "Done."),
      { type: "custom-title", customTitle: "Second name", sessionId },
    ]);

    await expect(listTitle(sessionId)).resolves.toBe("Second name");
  });

  test("prefers a custom-title over a later ai-title", async () => {
    const sessionId = "renamed-then-auto-titled";
    await writeSession(sessionId, [
      userRecord(sessionId, "Review this project"),
      { type: "custom-title", customTitle: "My research session", sessionId },
      { type: "ai-title", aiTitle: "Project review", sessionId },
    ]);

    await expect(listTitle(sessionId)).resolves.toBe("My research session");
  });

  test("falls back to the generated ai-title when the session was never renamed", async () => {
    const sessionId = "auto-titled";
    await writeSession(sessionId, [
      userRecord(sessionId, "Review this project"),
      { type: "ai-title", aiTitle: "Project review", sessionId },
    ]);

    await expect(listTitle(sessionId)).resolves.toBe("Project review");
  });

  test("falls back to the first user prompt when the session has no title record", async () => {
    const sessionId = "untitled-session";
    await writeSession(sessionId, [
      userRecord(sessionId, "Review this project"),
      assistantRecord(sessionId, "Done."),
    ]);

    await expect(listTitle(sessionId)).resolves.toBe("Review this project");
  });

  test("keeps the renamed title when a later record carries no usable name", async () => {
    const sessionId = "malformed-later-record";
    await writeSession(sessionId, [
      userRecord(sessionId, "Review this project"),
      { type: "custom-title", customTitle: "My research session", sessionId },
      { type: "custom-title", sessionId },
    ]);

    await expect(listTitle(sessionId)).resolves.toBe("My research session");
  });

  test("strips control bytes that /rename stored inside the title", async () => {
    const sessionId = "control-bytes";
    await writeSession(sessionId, [
      userRecord(sessionId, "Review this project"),
      { type: "custom-title", customTitle: "(feedback\u001d) price filter input", sessionId },
    ]);

    await expect(listTitle(sessionId)).resolves.toBe("(feedback ) price filter input");
  });

  test("ignores title records from sidechain transcripts", async () => {
    const sessionId = "sidechain-titles";
    await writeSession(sessionId, [
      userRecord(sessionId, "Review this project"),
      { type: "custom-title", customTitle: "Subagent title", sessionId, isSidechain: true },
    ]);

    await expect(listTitle(sessionId)).resolves.toBe("Review this project");
  });

  test("carries the renamed title onto the imported agent config", async () => {
    const sessionId = "imported-session";
    await writeSession(sessionId, [
      userRecord(sessionId, "Review this project"),
      { type: "custom-title", customTitle: "My research session", sessionId },
    ]);

    const imported = await importSessionWithStubbedResume(sessionId);

    expect(imported.config.title).toBe("My research session");
  });

  test("does not name the imported agent after a generated ai-title", async () => {
    const sessionId = "imported-auto-titled";
    await writeSession(sessionId, [
      userRecord(sessionId, "Review this project"),
      { type: "ai-title", aiTitle: "Project review", sessionId },
    ]);

    const imported = await importSessionWithStubbedResume(sessionId);

    // The listing shows it, but agents are named from their first prompt line.
    expect(imported.config.title).toBeUndefined();
  });

  test("leaves the imported agent config untitled when the session was never renamed", async () => {
    const sessionId = "imported-untitled-session";
    await writeSession(sessionId, [userRecord(sessionId, "Review this project")]);

    const imported = await importSessionWithStubbedResume(sessionId);

    expect(imported.config.title).toBeUndefined();
  });
});

async function importSessionWithStubbedResume(sessionId: string) {
  const client = createClient();
  // Resuming would spawn Claude Code; the import path only reads history from the
  // session it gets back, so an empty history is enough to observe the config.
  client.resumeSession = async () =>
    ({
      async *streamHistory(): AsyncGenerator<AgentStreamEvent> {},
    }) as unknown as AgentSession;

  return client.importSession(
    { providerHandleId: sessionId, cwd: SESSION_CWD },
    {
      config: { provider: "claude", cwd: SESSION_CWD },
      storedConfig: { provider: "claude", cwd: SESSION_CWD },
    },
  );
}

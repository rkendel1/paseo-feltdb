/**
 * ContextPresenter - Canonical Context Projection
 *
 * Phase 3.3: Convert structured BoundedAgentContext into provider-neutral
 * canonical presentation for injection into agent runtime.
 *
 * Key principle: Resolver produces structured data. Runtime owns presentation.
 *
 * This layer is responsible for:
 * - Formatting context for readability
 * - Limiting sensitive data exposure in logs
 * - Creating consistent structure across providers
 * - Enabling context inspection/debugging
 *
 * NOT responsible for:
 * - Provider-specific formatting (that's the adapter)
 * - Relevance decisions (that's ContextPolicy)
 */

import type { BoundedAgentContext } from "./context-policy.js";

/**
 * Canonical text projection of bounded context.
 * Suitable for inclusion in agent turn or logging.
 */
export interface ContextProjection {
  /**
   * Full formatted text for inclusion in agent context.
   * Safe to include in prompts (no sensitive data).
   */
  text: string;

  /**
   * Observability summary (for logging/debugging).
   * Shows what was included without full content.
   */
  summary: {
    project: string;
    repository: string | null;
    workspace: string;
    runsCount: number;
    runsSelected: number;
    messagesCount: number;
    messagesSelected: number;
    conversationActive: boolean;
  };
}

/**
 * Agent turn context wrapper.
 * Passed to provider runtime (provider-neutral, no FeltDB knowledge).
 */
export interface AgentTurnContext {
  /**
   * User's original request/prompt for this turn.
   */
  request: string;

  /**
   * Resolved and bounded context for this turn.
   */
  context: BoundedAgentContext;

  /**
   * Canonical text projection of context.
   * Ready to include in provider input.
   */
  projection: ContextProjection;
}

export class ContextPresenter {
  /**
   * Project BoundedAgentContext into canonical text format.
   *
   * Structure (always in this order):
   * 1. Project
   * 2. Repository (if present)
   * 3. Workspace
   * 4. Current Work (task if present)
   * 5. Recent Execution (runs)
   * 6. Conversation (if present)
   * 7. Decisions (if present, Phase 3.4+)
   * 8. Observations (if present, Phase 3.4+)
   */
  project(context: BoundedAgentContext): ContextProjection {
    const parts: string[] = [];

    // Header
    parts.push("# Paseo Context\n");

    // 1. Project
    parts.push("## Project\n");
    parts.push(`**Name:** ${context.project.name}`);
    if (context.project.description) {
      parts.push(`**Description:** ${context.project.description}`);
    }
    parts.push(`**Type:** ${context.project.kind}`);
    parts.push(`**Root:** \`${context.project.rootPath}\``);
    parts.push("");

    // 2. Repository (optional)
    if (context.repository) {
      parts.push("## Repository\n");
      parts.push(`**Name:** ${context.repository.name}`);
      parts.push(`**Path:** \`${context.repository.path}\``);
      if (context.repository.remoteUrl) {
        parts.push(`**Remote:** \`${context.repository.remoteUrl}\``);
      }
      parts.push(`**Default Branch:** ${context.repository.defaultBranch || "main"}`);
      parts.push("");
    }

    // 3. Workspace
    parts.push("## Workspace\n");
    parts.push(`**Name:** ${context.workspace.name}`);
    parts.push(`**Path:** \`${context.workspace.cwd}\``);
    parts.push(`**Kind:** ${context.workspace.kind}`);
    if (context.workspace.branch) {
      parts.push(`**Branch:** ${context.workspace.branch}`);
    }
    parts.push("");

    // 4. Current Work (task if present)
    if (context.task) {
      parts.push("## Current Task\n");
      parts.push(`**Title:** ${context.task.title}`);
      if (context.task.description) {
        parts.push(`**Description:** ${context.task.description}`);
      }
      parts.push(`**Status:** ${context.task.status}`);
      if (context.task.priority) {
        parts.push(`**Priority:** ${context.task.priority}`);
      }
      parts.push("");
    }

    // 5. Recent Execution (runs)
    if (context.recentRuns.length > 0) {
      parts.push("## Recent Execution\n");
      parts.push(
        `**Total runs:** ${context.selection.runs.total} (showing ${context.selection.runs.selected.length})`
      );
      parts.push(`**Selection:** ${context.selection.runs.reason}`);
      parts.push("");

      for (const run of context.recentRuns) {
        const createdAt = new Date(run.createdAt).toLocaleString();
        parts.push(`- **Run ${run.id.slice(0, 8)}** (${createdAt})`);
        parts.push(`  - Status: ${run.status}`);
        parts.push(`  - Provider: ${run.provider}`);
        if (run.model) {
          parts.push(`  - Model: ${run.model}`);
        }
        if (run.usage) {
          const tokens = (run.usage.totalTokens || 0).toLocaleString();
          parts.push(`  - Tokens: ${tokens}`);
        }
      }
      parts.push("");
    }

    // 6. Conversation (if present)
    if (context.conversation) {
      parts.push("## Conversation\n");
      parts.push(
        `**Total messages:** ${context.selection.messages.total} (showing ${context.selection.messages.selected.length})`
      );
      parts.push(`**Selection:** ${context.selection.messages.reason}`);
      parts.push("");

      if (context.recentMessages.length > 0) {
        parts.push("### Recent Messages\n");
        for (const msg of context.recentMessages) {
          const role = msg.role || msg.authorType;
          const createdAt = new Date(msg.createdAt).toLocaleString();

          // Truncate long messages
          let content = msg.content;
          if (content.length > 200) {
            content = content.slice(0, 200) + "...";
          }

          parts.push(
            `**[${role.toUpperCase()} #${msg.sequence}]** ${createdAt}`
          );
          parts.push(`${content}`);
          parts.push("");
        }
      } else {
        parts.push("(No messages in this conversation yet)\n");
      }
    } else {
      parts.push("## Conversation\n");
      parts.push("(No conversation history yet)\n");
    }

    // 7. Decisions (stub for Phase 3.4+)
    if (context.selection.decisions.total > 0) {
      parts.push("## Decisions\n");
      parts.push(
        `**Total:** ${context.selection.decisions.total} (integration planned for Phase 3.4+)`
      );
      parts.push("");
    }

    // 8. Observations (stub for Phase 3.4+)
    if (context.selection.observations.total > 0) {
      parts.push("## Observations\n");
      parts.push(
        `**Total:** ${context.selection.observations.total} (integration planned for Phase 3.4+)`
      );
      parts.push("");
    }

    const text = parts.join("\n").trim();

    const summary = {
      project: context.project.name,
      repository: context.repository?.name || null,
      workspace: context.workspace.name,
      runsCount: context.selection.runs.total,
      runsSelected: context.selection.runs.selected.length,
      messagesCount: context.selection.messages.total,
      messagesSelected: context.selection.messages.selected.length,
      conversationActive: context.conversation !== null,
    };

    return { text, summary };
  }
}

export function createContextPresenter(): ContextPresenter {
  return new ContextPresenter();
}

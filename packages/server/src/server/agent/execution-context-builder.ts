/**
 * AgentExecutionContextBuilder - Construct execution context from resolution results
 *
 * Bridges AgentContextService output to AgentExecutionContext.
 */

import type { AgentExecutionContext, ContextEnvelope } from "./execution-context.js";
import type { AgentTurnContext } from "../state/context-presenter.js";

export function buildExecutionContext(options: {
  agentId: string;
  workspaceId: string;
  projectId: string | null;
  runId: string;
  request: string;
  turnContext: AgentTurnContext;
}): AgentExecutionContext {
  const { agentId, workspaceId, projectId, runId, request, turnContext } = options;
  const now = new Date();

  const envelope: ContextEnvelope = {
    request: turnContext.request,
    context: turnContext.context,
    projection: turnContext.projection,
    authorization: {
      agentId,
      workspaceId,
      projectId,
    },
    budget: {
      maxCharacters: turnContext.context.budget.maxCharacters,
      usedCharacters: turnContext.context.budget.usedCharacters,
      exceeded: turnContext.context.budget.exceeded,
    },
    resolvedAt: now.toISOString(),
  };

  return {
    agentId,
    workspaceId,
    projectId,
    runId,
    envelope,
    request,
    resolvedAt: now,
  };
}

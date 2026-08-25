/**
 * HandoffOrchestrator - Multi-agent coordination through FeltDB handoffs
 *
 * Enables Agent A to delegate work to Agent B by:
 * 1. Creating a durable Handoff record in FeltDB
 * 2. Resolving Agent A's context (observations, decisions, conversations)
 * 3. Storing that context for Agent B to retrieve
 *
 * Handoffs are idempotent: multiple requests with same requestId create exactly one handoff.
 */

import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import type { PaseoState } from "../state/paseo-state.js";
import type { AgentContextService } from "../state/agent-context-service.js";

export interface HandoffRequest {
  requestId: string; // Idempotent key
  sourceAgentId: string;
  sourceRunId: string;
  targetAgentId: string;
  requestedAction: string; // What the source agent wants the target to do
  projectId: string;
  workspaceId?: string;
  taskId?: string;
}

export interface HandoffResult {
  handoffId: string;
  success: boolean;
  error?: string;
}

export interface HandoffOrchestratorOptions {
  paseoState: PaseoState;
  contextService: AgentContextService;
  logger: Logger;
}

export class HandoffOrchestrator {
  private paseoState: PaseoState;
  private contextService: AgentContextService;
  private logger: Logger;

  constructor(options: HandoffOrchestratorOptions) {
    this.paseoState = options.paseoState;
    this.contextService = options.contextService;
    this.logger = options.logger.child({ module: "handoff-orchestrator" });
  }

  /**
   * Initiate a handoff from source agent to target agent.
   * Idempotent: same requestId always produces same result.
   */
  async initiateHandoff(request: HandoffRequest): Promise<HandoffResult> {
    this.logger.info(
      {
        requestId: request.requestId,
        sourceAgentId: request.sourceAgentId,
        targetAgentId: request.targetAgentId,
      },
      "Initiating handoff"
    );

    try {
      // 1. Get or create handoff record (idempotent)
      let handoff = await this.paseoState.handoffs.getByRequestId(request.requestId);

      if (!handoff) {
        // Resolve source agent's context for storage in handoff
        let contextText = "";
        let summary = "Agent delegation";

        try {
          const sourceContext = await this.contextService.resolveForTurn(
            request.sourceAgentId,
            request.requestedAction,
            request.sourceRunId
          );

          if (sourceContext.success && sourceContext.turnContext?.projection?.text) {
            contextText = sourceContext.turnContext.projection.text;
            summary = sourceContext.turnContext.projection.summary?.project ?? summary;
            this.logger.debug(
              { requestId: request.requestId, contextLength: contextText.length },
              "Source context resolved"
            );
          }
        } catch (err) {
          this.logger.debug(
            { requestId: request.requestId, err },
            "Could not resolve source context (non-blocking)"
          );
        }

        // Create new handoff record
        handoff = await this.paseoState.handoffs.createIdempotent(request.requestId, {
          projectId: request.projectId,
          workspaceId: request.workspaceId,
          taskId: request.taskId,
          sourceAgentId: request.sourceAgentId,
          sourceRunId: request.sourceRunId,
          targetAgentId: request.targetAgentId,
          requestedAction: request.requestedAction,
          summary: summary,
          context: contextText,
          status: "pending",
        });

        this.logger.info(
          { handoffId: handoff.id, requestId: request.requestId },
          "Handoff record created"
        );
      } else {
        this.logger.info(
          { handoffId: handoff.id, requestId: request.requestId },
          "Handoff already exists (idempotent)"
        );
      }

      return {
        handoffId: handoff.id,
        success: true,
      };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.logger.error(
        { requestId: request.requestId, err },
        "Handoff initiation failed"
      );

      return {
        handoffId: randomUUID(),
        success: false,
        error,
      };
    }
  }
}

/**
 * Factory for creating HandoffOrchestrator instances.
 */
export function createHandoffOrchestrator(
  options: HandoffOrchestratorOptions
): HandoffOrchestrator {
  return new HandoffOrchestrator(options);
}

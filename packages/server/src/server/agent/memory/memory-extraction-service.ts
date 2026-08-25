/**
 * MemoryExtractionService - Coordinate observation and decision extraction
 *
 * Phase 3: Non-blocking memory extraction pipeline.
 *
 * Architecture:
 * Agent execution produces events
 *     ↓
 * MemoryExtractionService (async, never blocks)
 *     ↓
 * ObservationExtractor + DecisionRecorder
 *     ↓
 * Validation + Authorization
 *     ↓
 * FeltDB persistence (async, fire-and-forget)
 *
 * Critical invariant: Agent execution continues even if extraction fails.
 * If extraction fails, the run is still valid. Extraction can be retried asynchronously.
 */

import type { Logger } from "pino";
import type { PaseoState } from "../../state/paseo-state.js";
import type { ExtractionEvent } from "./extraction-events.js";
import { ObservationExtractor } from "./observation-extractor.js";
import { DecisionRecorder } from "./decision-recorder.js";

export interface MemoryExtractionOptions {
  paseoState: PaseoState;
  logger: Logger;
  agentId: string;
  workspaceId: string;
  projectId: string;
}

export class MemoryExtractionService {
  private paseoState: PaseoState;
  private logger: Logger;
  private observationExtractor: ObservationExtractor;
  private decisionRecorder: DecisionRecorder;
  private agentId: string;
  private workspaceId: string;
  private projectId: string;

  constructor(options: MemoryExtractionOptions) {
    this.paseoState = options.paseoState;
    this.logger = options.logger;
    this.agentId = options.agentId;
    this.workspaceId = options.workspaceId;
    this.projectId = options.projectId;
    this.observationExtractor = new ObservationExtractor();
    this.decisionRecorder = new DecisionRecorder();
  }

  /**
   * Process an event and extract observations/decisions.
   * Fire-and-forget: never blocks agent execution.
   * Errors are logged but not propagated.
   */
  processEvent(event: ExtractionEvent): void {
    // Fire extraction async, never wait for it
    this.extractAndPersist(event).catch((err) => {
      this.logger.error(
        { eventType: event.type, runId: event.runId },
        `Memory extraction failed: ${err instanceof Error ? err.message : String(err)}`
      );
    });
  }

  /**
   * Internal: extract and persist observations/decisions.
   * Runs async, called fire-and-forget from processEvent.
   */
  private async extractAndPersist(event: ExtractionEvent): Promise<void> {
    try {
      // Extract observations from the event
      const candidates = this.observationExtractor.extract(event);
      if (candidates.length > 0) {
        // Deduplicate within this batch
        const observations = this.observationExtractor.deduplicateWithinBatch(
          candidates
        );

        // Persist each observation
        for (const obs of observations) {
          if (obs.confidence < 0.65) {
            // Skip very low confidence
            continue;
          }

          await this.persistObservation(obs, event);
        }
      }

      // Also record an agent proposal decision for run completion events
      // This marks that the agent executed and made progress on its turn
      if (event.type === "run.completed") {
        await this.recordTurnDecision(event);
      }
    } catch (err) {
      this.logger.debug(
        {},
        `Error during extraction: ${err instanceof Error ? err.message : String(err)}`
      );
      // Never propagate extraction errors
    }
  }

  /**
   * Record a decision for agent turn completion.
   * Marks that the agent completed a turn and made progress.
   */
  private async recordTurnDecision(event: ExtractionEvent): Promise<void> {
    if (!this.paseoState.decisions) {
      return;
    }

    try {
      const decision = this.decisionRecorder.recordAgentProposal(
        `Agent turn completed: analyzed task and made progress`,
        {
          agentId: this.agentId,
          runId: event.runId,
          scope: this.projectId,
          rationale: "Agent completed a turn and analyzed the task",
        }
      );

      await this.paseoState.decisions.create({
        projectId: this.projectId,
        workspaceId: this.workspaceId,
        runId: event.runId,
        content: decision.content,
        rationale: decision.rationale,
        status: decision.status,
        authorType: decision.authorType,
        authorId: decision.authorId,
        taskId: decision.relatedTaskId,
      });

      this.logger.debug(
        { runId: event.runId, agentId: this.agentId },
        "Turn decision recorded"
      );
    } catch (err) {
      this.logger.debug(
        { runId: event.runId, err },
        "Failed to record turn decision (non-blocking)"
      );
    }
  }

  /**
   * Persist a single extracted observation to FeltDB.
   */
  private async persistObservation(
    extracted: Awaited<ReturnType<ObservationExtractor["extract"]>>[number],
    event: ExtractionEvent
  ): Promise<void> {
    if (!this.paseoState.observations) {
      return;
    }

    try {
      await this.paseoState.observations!.create({
        projectId: this.projectId,
        workspaceId: this.workspaceId,
        agentId: this.agentId,
        runId: event.runId,
        type: extracted.type,
        content: extracted.content,
        source: "agent",
        confidence: extracted.confidence,
      });
    } catch (err) {
      // Log but don't propagate
      this.logger.debug(
        { eventType: event.type },
        `Failed to persist observation: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  /**
   * Record a human approval as a decision.
   * Fire-and-forget, like processEvent.
   */
  recordApproval(
    event: ExtractionEvent & { type: "approval.granted" }
  ): void {
    this.recordApprovalAsync(event).catch((err) => {
      this.logger.error(
        { runId: event.runId },
        `Failed to record approval: ${err instanceof Error ? err.message : String(err)}`
      );
    });
  }

  /**
   * Internal: record approval as decision.
   */
  private async recordApprovalAsync(
    event: ExtractionEvent & { type: "approval.granted" }
  ): Promise<void> {
    if (!this.paseoState.decisions) {
      return;
    }

    const decision = this.decisionRecorder.recordFromApproval(event, {
      agentId: this.agentId,
      workspaceId: this.workspaceId,
      projectId: this.projectId,
    });

    if (!decision) {
      return;
    }

    try {
      await this.paseoState.decisions!.create({
        projectId: this.projectId,
        workspaceId: this.workspaceId,
        runId: event.runId,
        content: decision.content,
        rationale: decision.rationale,
        status: decision.status,
        authorType: decision.authorType,
        authorId: decision.authorId,
        taskId: decision.relatedTaskId,
      });
    } catch (err) {
      this.logger.debug(
        {},
        `Failed to record approval as decision: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
}

export function createMemoryExtractionService(
  options: MemoryExtractionOptions
): MemoryExtractionService {
  return new MemoryExtractionService(options);
}

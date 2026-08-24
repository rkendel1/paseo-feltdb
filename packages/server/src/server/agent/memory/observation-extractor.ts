/**
 * ObservationExtractor - Identify durable semantic units from execution events
 *
 * Phase 3: Extract observations from agent execution without blocking.
 *
 * An observation is a durable semantic unit that future agents should know about:
 * - Discoveries: "X library requires Y permission"
 * - Failures: "Build failed because provisioning profile X missing capability Y"
 * - Successful approaches: "Using `npm ci` with --force flag resolves peer dependency conflicts"
 * - Environmental facts: "Node 18 on macOS 13 has issue with native modules"
 * - Implementation findings: "File X needs UTF-8 encoding, not ASCII"
 * - Unresolved problems: "Token refresh still broken after 3 attempts"
 *
 * What NOT to extract:
 * - Transient steps: "I'm going to check the provisioning profile"
 * - Temporary states: "Running tests..."
 * - Action descriptions: "Installing dependencies"
 *
 * Observations are advisory, not authoritative. Decisions are for commitment.
 */

import type { Observation } from "../../state/feltdb/schema.js";
import type { ExtractionEvent } from "./extraction-events.js";
import {
  CommandFailedEvent,
  ToolCompletedEvent,
  RunCompletedEvent,
} from "./extraction-events.js";

export interface ExtractedObservation {
  /**
   * The semantic unit to persist.
   * Usually a sentence or short paragraph.
   */
  content: string;

  /**
   * Type of observation.
   */
  type: Observation["type"];

  /**
   * Confidence (0-1) that this is a durable semantic unit.
   * Low confidence observations can be deduplicated or filtered.
   */
  confidence: number;

  /**
   * Origin event that triggered extraction.
   * For tracing and debugging.
   */
  eventType: string;
}

export class ObservationExtractor {
  /**
   * Extract candidate observations from an event.
   * Returns empty array if no observation is identified.
   * Errors do not propagate; empty array returned instead.
   */
  extract(event: ExtractionEvent): ExtractedObservation[] {
    try {
      if (event.type === "command.failed") {
        return this.extractFromCommandFailure(event as CommandFailedEvent);
      }
      if (event.type === "tool.completed") {
        return this.extractFromToolCompletion(event as ToolCompletedEvent);
      }
      if (event.type === "run.completed") {
        return this.extractFromRunCompletion(event as RunCompletedEvent);
      }
      return [];
    } catch {
      // Never block on extraction errors
      return [];
    }
  }

  private extractFromCommandFailure(
    event: CommandFailedEvent
  ): ExtractedObservation[] {
    const observations: ExtractedObservation[] = [];

    if (!event.stderr) return observations;

    // Look for specific error patterns
    const stderr = event.stderr.toLowerCase();

    // Pattern: Permission denied
    if (stderr.includes("permission denied")) {
      observations.push({
        content: `Command failed: ${event.command} exited with code ${event.exitCode}. Error: ${event.stderr}`,
        type: "bug",
        confidence: 0.9,
        eventType: "command.failed",
      });
      return observations;
    }

    // Pattern: File not found / missing dependency
    if (
      stderr.includes("not found") ||
      stderr.includes("no such file") ||
      stderr.includes("enoent")
    ) {
      observations.push({
        content: `Missing file or resource: ${event.command}. ${event.stderr}`,
        type: "dependency",
        confidence: 0.85,
        eventType: "command.failed",
      });
      return observations;
    }

    // Pattern: Timeout
    if (stderr.includes("timeout") || stderr.includes("timed out")) {
      observations.push({
        content: `Command timed out: ${event.command}`,
        type: "bug",
        confidence: 0.8,
        eventType: "command.failed",
      });
      return observations;
    }

    // Generic failure
    if (event.exitCode !== 0) {
      observations.push({
        content: `Command failed: ${event.command} (exit code ${event.exitCode}). ${event.stderr}`,
        type: "bug",
        confidence: 0.7,
        eventType: "command.failed",
      });
    }

    return observations;
  }

  private extractFromToolCompletion(
    event: ToolCompletedEvent
  ): ExtractedObservation[] {
    const observations: ExtractedObservation[] = [];

    if (event.success && event.output) {
      // Successfully completed tools with interesting output
      if (
        event.toolName.includes("build") ||
        event.toolName.includes("compile")
      ) {
        observations.push({
          content: `Successfully compiled with ${event.toolName}. ${event.output.substring(0, 200)}`,
          type: "test_result",
          confidence: 0.75,
          eventType: "tool.completed",
        });
      }
      return observations;
    }

    if (!event.success && event.error) {
      observations.push({
        content: `Tool ${event.toolName} failed: ${event.error}`,
        type: "bug",
        confidence: 0.8,
        eventType: "tool.completed",
      });
    }

    return observations;
  }

  private extractFromRunCompletion(
    event: RunCompletedEvent
  ): ExtractedObservation[] {
    const observations: ExtractedObservation[] = [];

    if (!event.success && event.errors && event.errors.length > 0) {
      // Summarize all errors that occurred during run
      const errorSummary = event.errors.slice(0, 3).join("; ");
      observations.push({
        content: `Run failed with errors: ${errorSummary}`,
        type: "bug",
        confidence: 0.85,
        eventType: "run.completed",
      });
      return observations;
    }

    if (event.success && event.outputSummary) {
      observations.push({
        content: `Run completed successfully. ${event.outputSummary}`,
        type: "test_result",
        confidence: 0.8,
        eventType: "run.completed",
      });
    }

    return observations;
  }

  /**
   * Deduplicate observations by content similarity.
   * Simple string containment for Phase 3 (no LLM).
   */
  deduplicateWithinBatch(
    observations: ExtractedObservation[]
  ): ExtractedObservation[] {
    const seen = new Set<string>();
    const deduped: ExtractedObservation[] = [];

    // Sort by confidence descending to keep highest confidence
    const sorted = [...observations].sort(
      (a, b) => b.confidence - a.confidence
    );

    for (const obs of sorted) {
      // Normalize for comparison
      const key = obs.content.toLowerCase().trim();

      // Skip if we've already included similar content
      const isDuplicate = Array.from(seen).some(
        (existing) =>
          key.includes(existing.substring(0, 50)) ||
          existing.includes(key.substring(0, 50))
      );

      if (!isDuplicate) {
        seen.add(key);
        deduped.push(obs);
      }
    }

    return deduped;
  }
}

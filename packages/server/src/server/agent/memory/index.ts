/**
 * Memory Extraction Module - Phase 3
 *
 * Automatic observation and decision capture from agent execution.
 * Closes the write → read → learn loop by persisting durable semantic units.
 */

export type { ExtractionEvent } from "./extraction-events.js";
export {
  TaskStartedEvent,
  ToolCalledEvent,
  ToolCompletedEvent,
  CommandFailedEvent,
  ArtifactCreatedEvent,
  ApprovalGrantedEvent,
  RunCompletedEvent,
} from "./extraction-events.js";
export { ObservationExtractor } from "./observation-extractor.js";
export type { ExtractedObservation } from "./observation-extractor.js";
export { DecisionRecorder } from "./decision-recorder.ts";
export type { RecordedDecision } from "./decision-recorder.js";
export {
  MemoryExtractionService,
  createMemoryExtractionService,
} from "./memory-extraction-service.js";
export type { MemoryExtractionOptions } from "./memory-extraction-service.js";

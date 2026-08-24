/**
 * Memory Extraction Module - Phase 3 & 4
 *
 * Automatic observation and decision capture from agent execution.
 * Closes the write → read → learn → handoff → execute loop.
 */

export type { ExtractionEvent } from "./extraction-events.js";
export type {
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
export { DecisionRecorder } from "./decision-recorder.js";
export type { RecordedDecision } from "./decision-recorder.js";
export {
  MemoryExtractionService,
  createMemoryExtractionService,
} from "./memory-extraction-service.js";
export type { MemoryExtractionOptions } from "./memory-extraction-service.js";
export { HandoffService, createHandoffService } from "./handoff-service.js";
export type {
  HandoffServiceOptions,
  CreateHandoffInput,
} from "./handoff-service.js";

/**
 * Extraction Events - Structured events from agent execution
 *
 * Phase 3: Memory extraction from agent execution relies on structured events
 * to identify observations and decisions. This avoids LLM overhead and provides
 * deterministic, reproducible memory capture.
 *
 * Events flow from agent execution → extraction pipeline → FeltDB persistence.
 * Never blocks agent execution if extraction fails.
 */

/**
 * Structured event from agent execution.
 * Events are the input to observation and decision extractors.
 */
export type ExtractionEvent =
  | TaskStartedEvent
  | ToolCalledEvent
  | ToolCompletedEvent
  | CommandFailedEvent
  | ArtifactCreatedEvent
  | ApprovalGrantedEvent
  | RunCompletedEvent;

export interface BaseEvent {
  type: string;
  timestamp: Date;
  runId: string;
}

export interface TaskStartedEvent extends BaseEvent {
  type: "task.started";
  taskId: string;
  title: string;
  description: string;
}

export interface ToolCalledEvent extends BaseEvent {
  type: "tool.called";
  toolName: string;
  toolVersion?: string;
}

export interface ToolCompletedEvent extends BaseEvent {
  type: "tool.completed";
  toolName: string;
  success: boolean;
  output?: string;
  error?: string;
}

export interface CommandFailedEvent extends BaseEvent {
  type: "command.failed";
  command: string;
  exitCode: number;
  stderr: string;
  stdout?: string;
}

export interface ArtifactCreatedEvent extends BaseEvent {
  type: "artifact.created";
  artifactType: string; // "file", "directory", "script", etc.
  path: string;
  size?: number;
}

export interface ApprovalGrantedEvent extends BaseEvent {
  type: "approval.granted";
  actor: string; // human actor ID or email
  scope: "task" | "decision" | "approach"; // what was approved
  subject: string; // what was approved (task/decision ID or description)
  rationale?: string; // why it was approved
  relatedTaskId?: string;
  relatedDecisionId?: string;
}

export interface RunCompletedEvent extends BaseEvent {
  type: "run.completed";
  success: boolean;
  duration: number; // milliseconds
  outputSummary?: string;
  errors?: string[];
}

export function isExtractionEvent(value: unknown): value is ExtractionEvent {
  if (typeof value !== "object" || value === null) return false;
  const event = value as Record<string, unknown>;
  return (
    typeof event.type === "string" &&
    event.timestamp instanceof Date &&
    typeof event.runId === "string"
  );
}

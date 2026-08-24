import { z } from "zod";

/**
 * FeltDB Schema for Paseo
 *
 * Defines all durable entities and their structure.
 * This is the authoritative data model for Paseo's application/work state.
 */

// ============================================================================
// Core Project & Repository Entities
// ============================================================================

export const ProjectSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  kind: z.enum(["git", "non_git"]),
  rootPath: z.string(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  archivedAt: z.string().datetime().nullable().optional(),
  status: z.enum(["active", "archived"]).default("active"),
  metadata: z.record(z.any()).optional(),
});

export type Project = z.infer<typeof ProjectSchema>;

export const RepositorySchema = z.object({
  id: z.string(),
  projectId: z.string(),
  name: z.string(),
  path: z.string(),
  remoteUrl: z.string().optional(),
  defaultBranch: z.string().default("main"),
  gitMetadata: z
    .object({
      repoId: z.string().optional(),
      isShallow: z.boolean().default(false),
    })
    .optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  archivedAt: z.string().datetime().nullable().optional(),
});

export type Repository = z.infer<typeof RepositorySchema>;

// ============================================================================
// Workspace & Agent Entities
// ============================================================================

export const WorkspaceSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  repositoryId: z.string().optional(),
  name: z.string(),
  cwd: z.string(),
  worktreeRoot: z.string().optional(),
  branch: z.string().optional(),
  baseBranch: z.string().optional(),
  kind: z.enum(["local_checkout", "worktree", "directory"]),
  status: z.enum(["active", "archived"]).default("active"),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  archivedAt: z.string().datetime().nullable().optional(),
  metadata: z.record(z.any()).optional(),
});

export type Workspace = z.infer<typeof WorkspaceSchema>;

export const AgentSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  provider: z.enum(["claude", "codex", "opencode"]),
  model: z.string().optional(),
  status: z.enum(["running", "closed", "paused", "archived"]).default("closed"),
  config: z
    .object({
      title: z.string().nullable().optional(),
      modeId: z.string().nullable().optional(),
      thinkingOptionId: z.string().nullable().optional(),
      systemPrompt: z.string().nullable().optional(),
      mcpServers: z.record(z.any()).nullable().optional(),
      extra: z.record(z.any()).nullable().optional(),
    })
    .optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  lastActivityAt: z.string().datetime().optional(),
  lastUserMessageAt: z.string().datetime().nullable().optional(),
  persistenceHandle: z
    .object({
      provider: z.string(),
      sessionId: z.string(),
      nativeHandle: z.any().optional(),
      metadata: z.record(z.any()).optional(),
    })
    .nullable()
    .optional(),
  labels: z.record(z.string()).default({}),
  attention: z
    .object({
      required: z.boolean(),
      reason: z.enum(["finished", "error", "permission"]).optional(),
      timestamp: z.string().datetime().optional(),
    })
    .optional(),
  internal: z.boolean().default(false),
  archivedAt: z.string().datetime().nullable().optional(),
});

export type Agent = z.infer<typeof AgentSchema>;

// ============================================================================
// Work & Task Entities
// ============================================================================

export const TaskSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  workspaceId: z.string().optional(),
  repositoryId: z.string().optional(),
  title: z.string(),
  description: z.string().optional(),
  status: z
    .enum(["open", "in_progress", "blocked", "completed", "cancelled"])
    .default("open"),
  priority: z.enum(["low", "medium", "high", "critical"]).optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  createdBy: z.string().optional(), // user ID or agent ID
  assignedTo: z.string().optional(),
  parentTaskId: z.string().optional(),
  lastUpdatedRunId: z.string().optional(), // Provenance: which run caused last update
  lastUpdatedBy: z.string().optional(), // Agent or user ID who last updated
  metadata: z.record(z.any()).optional(),
});

export type Task = z.infer<typeof TaskSchema>;

// ============================================================================
// Conversation & Message Entities
// ============================================================================

export const ConversationSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  workspaceId: z.string().optional(),
  taskId: z.string().optional(),
  agentId: z.string(), // Required: conversations belong to agents
  title: z.string().optional(),
  startedAt: z.string().datetime().optional(), // Explicit conversation start
  closedAt: z.string().datetime().nullable().optional(), // Explicit conversation end
  status: z.enum(["active", "closed", "archived"]).default("active"),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  metadata: z.record(z.any()).optional(),
});

export type Conversation = z.infer<typeof ConversationSchema>;

export const MessageSchema = z.object({
  id: z.string(),
  conversationId: z.string(),
  authorType: z.enum(["user", "agent", "system", "tool"]),
  authorId: z.string().optional(),
  content: z.string(),
  runId: z.string().nullable().optional(), // Provenance: which run produced this message
  sequence: z.number(), // Ordering within conversation
  role: z.enum(["user", "assistant", "tool_output", "system"]).optional(), // Message role for API compatibility
  createdAt: z.string().datetime(),
  metadata: z.record(z.any()).optional(),
});

export type Message = z.infer<typeof MessageSchema>;

// ============================================================================
// Run & Execution Entities
// ============================================================================

export const RunSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  workspaceId: z.string(),
  taskId: z.string().optional(),
  projectId: z.string(),
  provider: z.enum(["claude", "codex", "opencode"]),
  model: z.string().optional(),
  prompt: z.string(),
  status: z
    .enum(["pending", "running", "completed", "failed", "cancelled", "interrupted"])
    .default("pending"),
  startedAt: z.string().datetime().optional(),
  completedAt: z.string().datetime().optional(),
  exitCode: z.number().optional(),
  result: z.string().optional(),
  error: z.string().optional(),
  usage: z
    .object({
      inputTokens: z.number().optional(),
      outputTokens: z.number().optional(),
      totalTokens: z.number().optional(),
    })
    .optional(),
  contextResolution: z
    .object({
      status: z.enum(["resolved", "failed", "fallback"]),
      policy: z.enum(["block", "fallback"]),
      summary: z.string().optional(),
    })
    .optional(),
  createdAt: z.string().datetime(),
  metadata: z.record(z.any()).optional(),
});

export type Run = z.infer<typeof RunSchema>;

// ============================================================================
// Knowledge & Decision Entities
// ============================================================================

export const ObservationSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  repositoryId: z.string().optional(),
  workspaceId: z.string().optional(),
  taskId: z.string().optional(),
  agentId: z.string().optional(),
  runId: z.string().optional(),
  type: z.enum([
    "architecture",
    "bug",
    "dependency",
    "constraint",
    "implementation_detail",
    "test_result",
    "deployment_fact",
    "user_requirement",
    "risk",
    "discovery",
    "other",
  ]),
  content: z.string(),
  confidence: z.number().min(0).max(1).optional(),
  source: z.enum(["agent", "user", "system"]).optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  metadata: z.record(z.any()).optional(),
});

export type Observation = z.infer<typeof ObservationSchema>;

export const DecisionSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  repositoryId: z.string().optional(),
  workspaceId: z.string().optional(),
  taskId: z.string().optional(),
  runId: z.string().optional(), // Run where decision was recorded
  authorType: z.enum(["user", "agent", "system"]),
  authorId: z.string().optional(),
  content: z.string(), // The decision statement
  rationale: z.string().optional(),
  status: z.enum(["proposed", "approved", "rejected", "superseded"]).default("proposed"),
  approvedBy: z.string().optional(), // userId who approved
  approvedAt: z.string().datetime().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  metadata: z.record(z.any()).optional(),
});

export type Decision = z.infer<typeof DecisionSchema>;

// ============================================================================
// Orchestration Entities
// ============================================================================

export const HandoffSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  workspaceId: z.string().optional(),
  taskId: z.string().optional(),
  sourceAgentId: z.string(),
  sourceRunId: z.string(),
  targetAgentId: z.string().optional(),
  targetRunId: z.string().nullable().optional(),
  requestId: z.string(), // For idempotent creation via F1/F2
  requestedAction: z.string(), // What Agent B should do
  summary: z.string(), // What Agent A learned/discovered
  context: z.string().optional(), // Serialized bounded context
  unresolvedQuestions: z.array(z.string()).optional(), // Questions for Agent B
  status: z
    .enum([
      "pending",
      "accepted",
      "in_progress",
      "completed",
      "rejected",
      "cancelled",
      "failed",
    ])
    .default("pending"),
  rejectionReason: z.string().optional(), // Why Agent B rejected
  failureReason: z.string().optional(), // Why execution failed
  createdAt: z.string().datetime(),
  acceptedAt: z.string().datetime().nullable().optional(),
  completedAt: z.string().datetime().nullable().optional(),
  metadata: z.record(z.any()).optional(),
});

export type Handoff = z.infer<typeof HandoffSchema>;

// ============================================================================
// Relationships / Edges
// ============================================================================

export const RelationshipSchema = z.object({
  id: z.string(),
  fromId: z.string(),
  fromType: z.enum([
    "project",
    "repository",
    "workspace",
    "agent",
    "task",
    "conversation",
    "message",
    "run",
    "observation",
    "decision",
    "handoff",
  ]),
  toId: z.string(),
  toType: z.enum([
    "project",
    "repository",
    "workspace",
    "agent",
    "task",
    "conversation",
    "message",
    "run",
    "observation",
    "decision",
    "handoff",
  ]),
  relationshipType: z.enum([
    "contains",
    "references",
    "blocks",
    "depends_on",
    "related_to",
    "informed_by",
    "derived_from",
    "based_on",
    "handed_off_to",
    "produced",
    "modified",
    "generated",
  ]),
  metadata: z.record(z.any()).optional(),
  createdAt: z.string().datetime(),
});

export type Relationship = z.infer<typeof RelationshipSchema>;

// ============================================================================
// System / Metadata Entities
// ============================================================================

export const MigrationMarkerSchema = z.object({
  id: z.string(),
  name: z.string(),
  version: z.number(),
  status: z.enum(["pending", "in_progress", "completed", "failed"]),
  startedAt: z.string().datetime().optional(),
  completedAt: z.string().datetime().optional(),
  summary: z
    .object({
      projectsMigrated: z.number().optional(),
      repositoriesMigrated: z.number().optional(),
      workspacesMigrated: z.number().optional(),
      agentsMigrated: z.number().optional(),
      conversationsMigrated: z.number().optional(),
      messagesMigrated: z.number().optional(),
      runsMigrated: z.number().optional(),
      observationsMigrated: z.number().optional(),
      decisionsMigrated: z.number().optional(),
      handoffsMigrated: z.number().optional(),
      errors: z.array(z.string()).optional(),
    })
    .optional(),
  metadata: z.record(z.any()).optional(),
});

export type MigrationMarker = z.infer<typeof MigrationMarkerSchema>;

// ============================================================================
// Union Type for All Entities
// ============================================================================

export type AnyEntity =
  | Project
  | Repository
  | Workspace
  | Agent
  | Task
  | Conversation
  | Message
  | Run
  | Observation
  | Decision
  | Handoff
  | Relationship
  | MigrationMarker;

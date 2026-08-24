/**
 * ContextResolver - Durable Graph-Aware Agent Context
 *
 * Deterministically constructs bounded AgentContext from the durable FeltDB graph.
 * Input: agentId, request, runId
 * Output: Complete graph context traversal (Agent → Workspace → Repository → Project)
 *
 * This is the foundation layer (3.1):
 * - No intelligent filtering (request/runId accepted but unused)
 * - No pagination or relevance policy
 * - Complete graph traversal along established relationships
 * - Provider-agnostic (zero knowledge of Claude/Codex/OpenCode)
 * - Deterministic and testable
 */

import type { Logger } from "pino";
import type { PaseoState } from "./paseo-state.js";
import type {
  Agent,
  Conversation,
  Decision,
  Message,
  Observation,
  Project,
  Repository,
  Run,
  Task,
  Workspace,
  HandoffScope,
} from "./feltdb/schema.js";
import { deriveHandoffScope } from "./feltdb/schema.js";

export interface ContextResolverInput {
  agentId: string;
  request: string;
  runId: string;
}

export interface AgentContext {
  identity: Agent;
  project: Project;
  repository: Repository | null;
  workspace: Workspace;
  task: Task | null;
  recentRuns: Run[];
  conversation: Conversation | null;
  recentMessages: Message[];
  projectObservations: Observation[];
  projectDecisions: Decision[];
  projectTasks: Task[];
  activeHandoffScope: HandoffScope | null;
}

export interface ContextResolverOptions {
  paseoState: PaseoState;
  logger: Logger;
}

export class ContextResolver {
  private paseoState: PaseoState;
  private logger: Logger;

  constructor(options: ContextResolverOptions) {
    this.paseoState = options.paseoState;
    this.logger = options.logger.child({ module: "context-resolver" });
  }

  /**
   * Resolve complete AgentContext from durable graph.
   *
   * Acceptance criteria for 3.1:
   * 1. Agent resolution - agentId → Agent (explicit error if missing)
   * 2. Graph traversal - Agent → Workspace → Repository → Project
   * 3. Task resolution - Resolve from durable graph only, return null if not found
   * 4. Runs - Retrieve agent's runs (no pagination yet)
   * 5. Conversation - Resolve agent's conversation (null valid for new agent)
   * 6. Messages - Retrieve conversation messages (no filtering)
   * 7. Determinism - Same input → same output, no I/O, no inference
   * 8. Provider independence - Zero knowledge of Claude/Codex/OpenCode
   *
   * request and runId are accepted but NOT USED in 3.1.
   * That policy lives in 3.2 Context Policy.
   */
  async resolve(input: ContextResolverInput): Promise<AgentContext> {
    this.logger.debug(
      { agentId: input.agentId, runId: input.runId },
      "ContextResolver.resolve: starting"
    );

    // 1. AGENT RESOLUTION
    const agent = await this.paseoState.agents.getById(input.agentId);
    if (!agent) {
      const error = new Error(`Agent not found: ${input.agentId}`);
      this.logger.error({ agentId: input.agentId }, error.message);
      throw error;
    }

    // 2. CHECK FOR ACTIVE HANDOFF SCOPE
    // Active accepted handoff establishes immutable authority boundary
    const activeHandoff = await this.paseoState.handoffs.getActiveForTarget(
      input.agentId
    );
    const activeHandoffScope = activeHandoff ? deriveHandoffScope(activeHandoff) : null;

    // 3. GRAPH TRAVERSAL: Agent → Workspace → Repository → Project
    const workspace = await this.paseoState.workspaces.getById(agent.workspaceId);
    if (!workspace) {
      const error = new Error(
        `Workspace not found for agent: ${agent.workspaceId}`
      );
      this.logger.error(
        { agentId: input.agentId, workspaceId: agent.workspaceId },
        error.message
      );
      throw error;
    }

    const project = await this.paseoState.projects.getById(workspace.projectId);
    if (!project) {
      const error = new Error(
        `Project not found for workspace: ${workspace.projectId}`
      );
      this.logger.error(
        { agentId: input.agentId, projectId: workspace.projectId },
        error.message
      );
      throw error;
    }

    // SCOPE ENFORCEMENT: If active handoff exists, verify scope matches
    if (activeHandoffScope) {
      if (activeHandoffScope.projectId !== project.id) {
        this.logger.warn(
          {
            agentId: input.agentId,
            handoffId: activeHandoffScope.handoffId,
            handoffProject: activeHandoffScope.projectId,
            agentProject: project.id,
          },
          "Agent workspace does not match handoff scope project"
        );
      }
      if (activeHandoffScope.workspaceId && activeHandoffScope.workspaceId !== workspace.id) {
        this.logger.warn(
          {
            agentId: input.agentId,
            handoffWorkspace: activeHandoffScope.workspaceId,
            agentWorkspace: workspace.id,
          },
          "Agent workspace does not match handoff scope workspace"
        );
      }
    }

    // Repository is optional
    let repository: Repository | null = null;
    if (workspace.repositoryId) {
      repository = await this.paseoState.repositories.getById(
        workspace.repositoryId
      );
      if (!repository) {
        this.logger.warn(
          { workspaceId: workspace.id, repositoryId: workspace.repositoryId },
          "Repository reference broken but not critical"
        );
      }
    }

    // 4. TASK RESOLUTION
    // If active handoff specifies taskId, use that; otherwise null
    let task: Task | null = null;
    if (activeHandoffScope?.taskId) {
      task = await this.paseoState.tasks.getById(activeHandoffScope.taskId);
    }

    // 5. RUNS - Retrieve agent's runs
    // If scoped: only runs related to the handoff's task
    let recentRuns = await this.paseoState.runs.listByAgent(input.agentId);
    if (activeHandoffScope?.taskId) {
      recentRuns = recentRuns.filter((run) => run.taskId === activeHandoffScope.taskId);
    }

    // 6. CONVERSATION - Resolve agent's conversation
    let conversation: Conversation | null = null;
    const conversations = await this.paseoState.conversations.listByAgent(
      input.agentId
    );
    if (conversations.length > 0) {
      // For now, take the most recent conversation
      // Filter by task if scoped
      if (activeHandoffScope?.taskId) {
        const scopedConversation = conversations.find(
          (c) => c.taskId === activeHandoffScope.taskId
        );
        conversation = scopedConversation || conversations[0]!;
      } else {
        conversation = conversations[0]!;
      }
    }

    // 7. MESSAGES - Retrieve messages from conversation
    let recentMessages: Message[] = [];
    if (conversation) {
      recentMessages = await this.paseoState.messages.listByConversation(
        conversation.id
      );
    }

    // 8. OBSERVATIONS - Retrieve observations
    // If scoped: only observations related to the handoff's task
    let projectObservations = await this.paseoState.observations.listByProject(
      project.id
    );
    if (activeHandoffScope?.taskId) {
      projectObservations = projectObservations.filter(
        (obs) => obs.taskId === activeHandoffScope.taskId
      );
    }

    // 9. DECISIONS - Retrieve decisions
    // If scoped: only decisions related to the handoff's task
    let projectDecisions = await this.paseoState.decisions.listByProject(
      project.id
    );
    if (activeHandoffScope?.taskId) {
      projectDecisions = projectDecisions.filter(
        (dec) => dec.taskId === activeHandoffScope.taskId
      );
    }

    // 10. TASKS - Retrieve project-level tasks for context
    // If scoped: only the handoff's task (if specified)
    let projectTasks = await this.paseoState.tasks.listByProject(project.id);
    if (activeHandoffScope?.taskId) {
      projectTasks = projectTasks.filter(
        (t) => t.id === activeHandoffScope.taskId
      );
    }

    const context: AgentContext = {
      identity: agent,
      project,
      repository,
      workspace,
      task,
      recentRuns,
      conversation,
      recentMessages,
      projectObservations,
      projectDecisions,
      projectTasks,
      activeHandoffScope,
    };

    this.logger.debug(
      {
        agentId: input.agentId,
        projectId: project.id,
        repositoryId: repository?.id ?? null,
        handoffId: activeHandoffScope?.handoffId ?? null,
        handoffTaskId: activeHandoffScope?.taskId ?? null,
        runsCount: recentRuns.length,
        messagesCount: recentMessages.length,
        observationsCount: projectObservations.length,
        decisionsCount: projectDecisions.length,
        tasksCount: projectTasks.length,
      },
      "ContextResolver.resolve: completed"
    );

    return context;
  }
}

export function createContextResolver(
  paseoState: PaseoState,
  logger: Logger
): ContextResolver {
  return new ContextResolver({
    paseoState,
    logger,
  });
}

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
} from "./feltdb/schema.js";

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

    // 2. GRAPH TRAVERSAL: Agent → Workspace → Repository → Project
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

    // 3. TASK RESOLUTION - Deterministic durable relationship
    // Task is not automatically resolved; policy determines which task is relevant.
    // For now, return null; 3.6 policy will intelligently select based on request.
    const task = null;

    // 4. RUNS - Retrieve agent's runs
    const recentRuns = await this.paseoState.runs.listByAgent(input.agentId);

    // 5. CONVERSATION - Resolve agent's conversation
    let conversation: Conversation | null = null;
    const conversations = await this.paseoState.conversations.listByAgent(
      input.agentId
    );
    if (conversations.length > 0) {
      // For now, take the most recent conversation
      // 3.6 will add policy to select based on request/context
      conversation = conversations[0]!;
    }

    // 6. MESSAGES - Retrieve messages from conversation
    let recentMessages: Message[] = [];
    if (conversation) {
      recentMessages = await this.paseoState.messages.listByConversation(
        conversation.id
      );
    }

    // 7. OBSERVATIONS - Retrieve project-level observations for context
    const projectObservations = await this.paseoState.observations.listByProject(
      project.id
    );

    // 8. DECISIONS - Retrieve project-level decisions for context
    const projectDecisions = await this.paseoState.decisions.listByProject(
      project.id
    );

    // 9. TASKS - Retrieve project-level tasks for context
    const projectTasks = await this.paseoState.tasks.listByProject(project.id);

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
    };

    this.logger.debug(
      {
        agentId: input.agentId,
        projectId: project.id,
        repositoryId: repository?.id ?? null,
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

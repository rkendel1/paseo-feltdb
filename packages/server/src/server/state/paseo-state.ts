/**
 * PaseoState - Domain-level state service
 *
 * Single access point for all durable Paseo application/work state.
 * All state operations go through this layer; direct database access is discouraged.
 *
 * This establishes the boundary: FeltDB is the substrate, PaseoState owns the semantics.
 */

import type { Logger } from "pino";
import type { Repositories } from "./feltdb/repositories.js";
import type { Project, Workspace, Agent, Task, Conversation, Message, Run, Observation, Decision, Handoff, AuthorityDecision } from "./feltdb/schema.js";
import { createAuthorityArbiter } from "./authority-arbiter.js";

export interface PaseoState {
  // Project operations
  projects: {
    create(data: { name: string; rootPath: string; kind: "git" | "non_git" }): Promise<Project>;
    getById(id: string): Promise<Project | null>;
    listAll(): Promise<Project[]>;
    update(id: string, data: Partial<Project>): Promise<Project>;
    delete(id: string): Promise<void>;
  };

  // Repository operations
  repositories: {
    create(data: {
      projectId: string;
      name: string;
      path: string;
      remoteUrl?: string;
      defaultBranch?: string;
    }): Promise<any>;
    getById(id: string): Promise<any | null>;
    listByProject(projectId: string): Promise<any[]>;
    update(id: string, data: Partial<any>): Promise<any>;
    delete(id: string): Promise<void>;
  };

  workspaces: {
    create(data: {
      projectId: string;
      repositoryId?: string;
      name: string;
      cwd: string;
      kind: "local_checkout" | "worktree" | "directory";
    }): Promise<Workspace>;
    getById(id: string): Promise<Workspace | null>;
    listByProject(projectId: string): Promise<Workspace[]>;
    getByCwd(cwd: string): Promise<Workspace | null>;
    update(id: string, data: Partial<Workspace>): Promise<Workspace>;
    delete(id: string): Promise<void>;
  };

  // Agent operations
  agents: {
    create(data: {
      workspaceId: string;
      provider: "claude" | "codex" | "opencode";
      config?: any;
    }): Promise<Agent>;
    getById(id: string): Promise<Agent | null>;
    listByWorkspace(workspaceId: string): Promise<Agent[]>;
    update(id: string, data: Partial<Agent>): Promise<Agent>;
    delete(id: string): Promise<void>;
  };

  // Task operations
  tasks: {
    create(data: {
      projectId: string;
      workspaceId?: string;
      title: string;
      description?: string;
    }): Promise<Task>;
    getById(id: string): Promise<Task | null>;
    listByProject(projectId: string): Promise<Task[]>;
    listByWorkspace(workspaceId: string): Promise<Task[]>;
    update(id: string, data: Partial<Task>): Promise<Task>;
    delete(id: string): Promise<void>;
  };

  // Conversation/Message operations
  conversations: {
    create(data: {
      projectId: string;
      workspaceId?: string;
      taskId?: string;
      agentId: string; // Required: conversations belong to agents
      title?: string;
      startedAt?: string;
    }): Promise<Conversation>;
    getById(id: string): Promise<Conversation | null>;
    listByProject(projectId: string): Promise<Conversation[]>;
    listByAgent(agentId: string): Promise<Conversation[]>;
    update(id: string, data: Partial<Conversation>): Promise<Conversation>;
    delete(id: string): Promise<void>;
  };

  messages: {
    create(data: {
      conversationId: string;
      authorType: "user" | "agent" | "system" | "tool";
      authorId?: string;
      content: string;
      runId?: string;
      sequence: number;
      role?: "user" | "assistant" | "tool_output" | "system";
    }): Promise<Message>;
    getById(id: string): Promise<Message | null>;
    listByConversation(
      conversationId: string,
      options?: { limit?: number; offset?: number }
    ): Promise<Message[]>;
    getMaxSequenceInConversation(conversationId: string): Promise<number>;
    update(id: string, data: Partial<Message>): Promise<Message>;
    delete(id: string): Promise<void>;
  };

  // Run operations
  runs: {
    create(data: {
      projectId: string;
      workspaceId: string;
      agentId: string;
      taskId?: string;
      provider: "claude" | "codex" | "opencode";
      prompt: string;
    }): Promise<Run>;
    getById(id: string): Promise<Run | null>;
    listByAgent(agentId: string): Promise<Run[]>;
    listByTask(taskId: string): Promise<Run[]>;
    update(id: string, data: Partial<Run>): Promise<Run>;
    delete(id: string): Promise<void>;
  };

  // Observation operations (Phase 3.5.2: Durable execution feedback)
  observations: {
    create(data: Omit<Observation, "id" | "createdAt" | "updatedAt">): Promise<Observation>;
    getById(id: string): Promise<Observation | null>;
    listByProject(projectId: string): Promise<Observation[]>;
    listByTask(taskId: string): Promise<Observation[]>;
    listByAgent(agentId: string): Promise<Observation[]>;
    update(id: string, data: Partial<Observation>): Promise<Observation>;
    delete(id: string): Promise<void>;
  };

  // Decision operations (Phase 3.5.3: Explicit durable decisions)
  decisions: {
    create(data: Omit<Decision, "id" | "createdAt" | "updatedAt">): Promise<Decision>;
    getById(id: string): Promise<Decision | null>;
    listByProject(projectId: string): Promise<Decision[]>;
    listByTask(taskId: string): Promise<Decision[]>;
    approve(id: string, approvedBy: string): Promise<Decision>;
    reject(id: string): Promise<Decision>;
    update(id: string, data: Partial<Decision>): Promise<Decision>;
    delete(id: string): Promise<void>;
  };

  // Handoff operations (Phase 4: Handoff & Orchestration)
  handoffs: {
    create(data: Omit<Handoff, "id" | "createdAt">): Promise<Handoff>;
    createIdempotent(
      requestId: string,
      data: Omit<Handoff, "id" | "createdAt" | "requestId">
    ): Promise<Handoff>;
    getById(id: string): Promise<Handoff | null>;
    getByRequestId(requestId: string): Promise<Handoff | null>;
    listBySourceAgent(sourceAgentId: string): Promise<Handoff[]>;
    listByTargetAgent(targetAgentId: string): Promise<Handoff[]>;
    listByProject(projectId: string): Promise<Handoff[]>;
    listByStatus(status: Handoff["status"]): Promise<Handoff[]>;
    /**
     * Get active accepted handoff for target agent.
     * Returns the first accepted handoff where agent is the target.
     */
    getActiveForTarget(targetAgentId: string): Promise<Handoff | null>;
    accept(id: string): Promise<Handoff>;
    reject(id: string, reason: string): Promise<Handoff>;
    updateStatus(id: string, status: Handoff["status"]): Promise<Handoff>;
    complete(id: string, targetRunId: string): Promise<Handoff>;
    fail(id: string, reason: string): Promise<Handoff>;
    update(id: string, data: Partial<Handoff>): Promise<Handoff>;
    delete(id: string): Promise<void>;
  };

  // Authority arbitration operations (Phase 4.4: Durable Authority Arbitration)
  authorityDecisions: {
    create(data: Omit<AuthorityDecision, "id" | "createdAt">): Promise<AuthorityDecision>;
    getById(id: string): Promise<AuthorityDecision | null>;
    listBySubject(
      subjectType: AuthorityDecision["subjectType"],
      subjectId: string
    ): Promise<AuthorityDecision[]>;
    listByHandoff(handoffId: string): Promise<AuthorityDecision[]>;
    getBySubject(
      subjectType: AuthorityDecision["subjectType"],
      subjectId: string
    ): Promise<AuthorityDecision | null>;
    update(id: string, data: Partial<AuthorityDecision>): Promise<AuthorityDecision>;
    delete(id: string): Promise<void>;
  };

  // Underlying repository access (for advanced use)
  repos: Repositories;

  // Authority arbitration (Phase 4.4: Durable arbitration of competing handoffs)
  arbiter: ReturnType<typeof createAuthorityArbiter>;

  // Lifecycle
  close(): Promise<void>;
}

/**
 * Create a PaseoState instance from typed repositories.
 * Phase 4.4.2: Integrates AuthorityArbiter for deterministic handoff acceptance.
 */
export function createPaseoState(repos: Repositories, logger: Logger): PaseoState {
  const log = logger.child({ module: "paseo-state" });

  // Create arbiter - Phase 4.4.2: makes atomicAccept() the ONLY acceptance path
  const arbiter = createAuthorityArbiter({
    repos,
    logger,
  });

  return {
    projects: {
      async create(data) {
        return repos.projects.create({
          ...data,
          status: "active",
        });
      },
      async getById(id) {
        return repos.projects.getById(id);
      },
      async listAll() {
        return repos.projects.listAll();
      },
      async update(id, data) {
        return repos.projects.update(id, data);
      },
      async delete(id) {
        return repos.projects.delete(id);
      },
    },

    repositories: {
      async create(data) {
        return repos.repositories.create({
          ...data,
          defaultBranch: data.defaultBranch || "main",
        });
      },
      async getById(id) {
        return repos.repositories.getById(id);
      },
      async listByProject(projectId) {
        return repos.repositories.listByProject(projectId);
      },
      async update(id, data) {
        return repos.repositories.update(id, data);
      },
      async delete(id) {
        return repos.repositories.delete(id);
      },
    },

    workspaces: {
      async create(data) {
        return repos.workspaces.create({
          ...data,
          status: "active",
          kind: data.kind,
        });
      },
      async getById(id) {
        return repos.workspaces.getById(id);
      },
      async listByProject(projectId) {
        return repos.workspaces.listByProject(projectId);
      },
      async getByCwd(cwd) {
        return repos.workspaces.getByCwd(cwd);
      },
      async update(id, data) {
        return repos.workspaces.update(id, data);
      },
      async delete(id) {
        return repos.workspaces.delete(id);
      },
    },

    agents: {
      async create(data) {
        const result = await repos.agents.create({
          ...data,
          status: "closed",
          labels: {},
          internal: false,
        });
        return result;
      },
      async getById(id) {
        return repos.agents.getById(id);
      },
      async listByWorkspace(workspaceId) {
        return repos.agents.listByWorkspace(workspaceId);
      },
      async update(id, data) {
        return repos.agents.update(id, data);
      },
      async delete(id) {
        return repos.agents.delete(id);
      },
    },

    tasks: {
      async create(data) {
        return repos.tasks.create({
          ...data,
          status: "open",
        });
      },
      async getById(id) {
        return repos.tasks.getById(id);
      },
      async listByProject(projectId) {
        return repos.tasks.listByProject(projectId);
      },
      async listByWorkspace(workspaceId) {
        return repos.tasks.listByWorkspace(workspaceId);
      },
      async update(id, data) {
        return repos.tasks.update(id, data);
      },
      async delete(id) {
        return repos.tasks.delete(id);
      },
    },

    conversations: {
      async create(data) {
        return repos.conversations.create({
          ...data,
          status: "active",
          startedAt: data.startedAt ?? new Date().toISOString(),
        });
      },
      async getById(id) {
        return repos.conversations.getById(id);
      },
      async listByProject(projectId) {
        return repos.conversations.listByProject(projectId);
      },
      async listByAgent(agentId) {
        return repos.conversations.listByAgent(agentId);
      },
      async update(id, data) {
        return repos.conversations.update(id, data);
      },
      async delete(id) {
        return repos.conversations.delete(id);
      },
    },

    messages: {
      async create(data) {
        return repos.messages.create({
          ...data,
        });
      },
      async getById(id) {
        return repos.messages.getById(id);
      },
      async listByConversation(conversationId, options) {
        return repos.messages.listByConversation(conversationId, options);
      },
      async getMaxSequenceInConversation(conversationId) {
        return repos.messages.getMaxSequenceInConversation(conversationId);
      },
      async update(id, data) {
        return repos.messages.update(id, data);
      },
      async delete(id) {
        return repos.messages.delete(id);
      },
    },

    runs: {
      async create(data) {
        return repos.runs.create({
          ...data,
          status: "pending",
        });
      },
      async getById(id) {
        return repos.runs.getById(id);
      },
      async listByAgent(agentId) {
        return repos.runs.listByAgent(agentId);
      },
      async listByTask(taskId) {
        return repos.runs.listByTask(taskId);
      },
      async update(id, data) {
        return repos.runs.update(id, data);
      },
      async delete(id) {
        return repos.runs.delete(id);
      },
    },

    observations: {
      async create(data) {
        return repos.observations.create(data);
      },
      async getById(id) {
        return repos.observations.getById(id);
      },
      async listByProject(projectId) {
        return repos.observations.listByProject(projectId);
      },
      async listByTask(taskId) {
        return repos.observations.listByTask(taskId);
      },
      async listByAgent(agentId) {
        return repos.observations.listByAgent(agentId);
      },
      async update(id, data) {
        return repos.observations.update(id, data);
      },
      async delete(id) {
        return repos.observations.delete(id);
      },
    },

    decisions: {
      async create(data) {
        return repos.decisions.create(data);
      },
      async getById(id) {
        return repos.decisions.getById(id);
      },
      async listByProject(projectId) {
        return repos.decisions.listByProject(projectId);
      },
      async listByTask(taskId) {
        return repos.decisions.listByTask(taskId);
      },
      async approve(id, approvedBy) {
        const decision = await repos.decisions.getById(id);
        if (!decision) {
          throw new Error(`Decision ${id} not found`);
        }
        return repos.decisions.update(id, {
          status: "approved",
          approvedBy,
          approvedAt: new Date().toISOString(),
        });
      },
      async reject(id) {
        const decision = await repos.decisions.getById(id);
        if (!decision) {
          throw new Error(`Decision ${id} not found`);
        }
        return repos.decisions.update(id, {
          status: "rejected",
        });
      },
      async update(id, data) {
        return repos.decisions.update(id, data);
      },
      async delete(id) {
        return repos.decisions.delete(id);
      },
    },

    handoffs: {
      async create(data) {
        return repos.handoffs.create({
          ...data,
          status: data.status || "pending",
        });
      },
      async createIdempotent(requestId, data) {
        // F2: Delegate to repository's atomic idempotent operation
        // Ensures concurrent requests with same requestId create exactly one handoff
        return repos.handoffs.createIdempotent(requestId, {
          ...data,
          status: data.status || "pending",
        });
      },
      async getById(id) {
        return repos.handoffs.getById(id);
      },
      async getByRequestId(requestId) {
        return repos.handoffs.getByRequestId(requestId);
      },
      async listBySourceAgent(sourceAgentId) {
        return repos.handoffs.listBySourceAgent(sourceAgentId);
      },
      async listByTargetAgent(targetAgentId) {
        return repos.handoffs.listByTargetAgent(targetAgentId);
      },
      async listByProject(projectId) {
        return repos.handoffs.listByProject(projectId);
      },
      async listByStatus(status) {
        return repos.handoffs.listByStatus(status);
      },
      async getActiveForTarget(targetAgentId) {
        return repos.handoffs.getActiveForTarget(targetAgentId);
      },
      async accept(id) {
        // Phase 4.4.2: All acceptance goes through AuthorityArbiter.atomicAccept()
        // This is the ONLY acceptance path - guarantees deterministic arbitration
        const result = await arbiter.atomicAccept(id);
        if (result.success) {
          const handoff = await repos.handoffs.getById(id);
          if (!handoff) {
            throw new Error(`Handoff ${id} not found after acceptance`);
          }
          return handoff;
        }
        throw new Error(
          `Handoff ${id} acceptance rejected: ${result.rejection?.reason}${
            result.rejection?.winnerId ? ` (winner: ${result.rejection.winnerId})` : ""
          }`
        );
      },
      async reject(id, reason) {
        const handoff = await repos.handoffs.getById(id);
        if (!handoff) {
          throw new Error(`Handoff ${id} not found`);
        }
        if (handoff.status !== "pending") {
          throw new Error(
            `Cannot reject handoff with status ${handoff.status}`
          );
        }
        return repos.handoffs.update(id, {
          status: "rejected",
          rejectionReason: reason,
        });
      },
      async updateStatus(id, status) {
        const handoff = await repos.handoffs.getById(id);
        if (!handoff) {
          throw new Error(`Handoff ${id} not found`);
        }
        return repos.handoffs.update(id, { status });
      },
      async complete(id, targetRunId) {
        const handoff = await repos.handoffs.getById(id);
        if (!handoff) {
          throw new Error(`Handoff ${id} not found`);
        }
        if (!["in_progress", "accepted"].includes(handoff.status)) {
          throw new Error(
            `Cannot complete handoff with status ${handoff.status}`
          );
        }
        return repos.handoffs.update(id, {
          status: "completed",
          targetRunId,
          completedAt: new Date().toISOString(),
        });
      },
      async fail(id, reason) {
        const handoff = await repos.handoffs.getById(id);
        if (!handoff) {
          throw new Error(`Handoff ${id} not found`);
        }
        return repos.handoffs.update(id, {
          status: "failed",
          failureReason: reason,
        });
      },
      async update(id, data) {
        return repos.handoffs.update(id, data);
      },
      async delete(id) {
        return repos.handoffs.delete(id);
      },
    },

    authorityDecisions: {
      async create(data) {
        return repos.authorityDecisions.create(data);
      },
      async getById(id) {
        return repos.authorityDecisions.getById(id);
      },
      async listBySubject(subjectType, subjectId) {
        return repos.authorityDecisions.listBySubject(subjectType, subjectId);
      },
      async listByHandoff(handoffId) {
        return repos.authorityDecisions.listByHandoff(handoffId);
      },
      async getBySubject(subjectType, subjectId) {
        return repos.authorityDecisions.getBySubject(subjectType, subjectId);
      },
      async update(id, data) {
        return repos.authorityDecisions.update(id, data);
      },
      async delete(id) {
        return repos.authorityDecisions.delete(id);
      },
    },

    repos,

    arbiter,

    async close() {
      log.info("Closing Paseo state");
      // Future: cleanup, flush, etc.
    },
  };
}

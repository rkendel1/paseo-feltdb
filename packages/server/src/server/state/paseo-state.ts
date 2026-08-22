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
import type { Project, Workspace, Agent, Task, Conversation, Run } from "./feltdb/schema.js";

export interface PaseoState {
  // Project/Repository operations
  projects: {
    create(data: { name: string; rootPath: string; kind: "git" | "non_git" }): Promise<Project>;
    getById(id: string): Promise<Project | null>;
    listAll(): Promise<Project[]>;
    update(id: string, data: Partial<Project>): Promise<Project>;
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
      agentId?: string;
    }): Promise<Conversation>;
    getById(id: string): Promise<Conversation | null>;
    listByProject(projectId: string): Promise<Conversation[]>;
    update(id: string, data: Partial<Conversation>): Promise<Conversation>;
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

  // Underlying repository access (for advanced use)
  repos: Repositories;

  // Lifecycle
  close(): Promise<void>;
}

/**
 * Create a PaseoState instance from typed repositories.
 */
export function createPaseoState(repos: Repositories, logger: Logger): PaseoState {
  const log = logger.child({ module: "paseo-state" });

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
        return repos.agents.create({
          ...data,
          status: "closed",
        });
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
        });
      },
      async getById(id) {
        return repos.conversations.getById(id);
      },
      async listByProject(projectId) {
        return repos.conversations.listByProject(projectId);
      },
      async update(id, data) {
        return repos.conversations.update(id, data);
      },
      async delete(id) {
        return repos.conversations.delete(id);
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

    repos,

    async close() {
      log.info("Closing Paseo state");
      // Future: cleanup, flush, etc.
    },
  };
}

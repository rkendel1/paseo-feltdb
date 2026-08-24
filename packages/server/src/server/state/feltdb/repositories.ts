import { randomUUID } from "node:crypto";
import type {
  Project,
  Repository,
  Workspace,
  Agent,
  Task,
  Conversation,
  Message,
  Run,
  Observation,
  Decision,
  Handoff,
  AuthorityDecision,
  Relationship,
  MigrationMarker,
} from "./schema.js";

/**
 * Repository pattern for FeltDB collections.
 * Each repository provides typed access to a single entity collection.
 */

// ============================================================================
// Project Repository
// ============================================================================

export interface ProjectRepository {
  create(data: Omit<Project, "id" | "createdAt" | "updatedAt">): Promise<Project>;
  getById(id: string): Promise<Project | null>;
  listByProject(projectId: string): Promise<Project[]>;
  listAll(): Promise<Project[]>;
  update(id: string, data: Partial<Project>): Promise<Project>;
  delete(id: string): Promise<void>;
}

// ============================================================================
// Repository Repository
// ============================================================================

export interface RepositoryRepository {
  create(data: Omit<Repository, "id" | "createdAt" | "updatedAt">): Promise<Repository>;
  getById(id: string): Promise<Repository | null>;
  listByProject(projectId: string): Promise<Repository[]>;
  update(id: string, data: Partial<Repository>): Promise<Repository>;
  delete(id: string): Promise<void>;
}

// ============================================================================
// Workspace Repository
// ============================================================================

export interface WorkspaceRepository {
  create(data: Omit<Workspace, "id" | "createdAt" | "updatedAt">): Promise<Workspace>;
  getById(id: string): Promise<Workspace | null>;
  listByProject(projectId: string): Promise<Workspace[]>;
  listByRepository(repositoryId: string): Promise<Workspace[]>;
  getByCwd(cwd: string): Promise<Workspace | null>;
  update(id: string, data: Partial<Workspace>): Promise<Workspace>;
  delete(id: string): Promise<void>;
}

// ============================================================================
// Agent Repository
// ============================================================================

export interface AgentRepository {
  create(data: Omit<Agent, "id" | "createdAt" | "updatedAt">): Promise<Agent>;
  getById(id: string): Promise<Agent | null>;
  listByWorkspace(workspaceId: string): Promise<Agent[]>;
  listActive(): Promise<Agent[]>;
  update(id: string, data: Partial<Agent>): Promise<Agent>;
  delete(id: string): Promise<void>;
}

// ============================================================================
// Task Repository
// ============================================================================

export interface TaskRepository {
  create(data: Omit<Task, "id" | "createdAt" | "updatedAt">): Promise<Task>;
  getById(id: string): Promise<Task | null>;
  listByProject(projectId: string): Promise<Task[]>;
  listByWorkspace(workspaceId: string): Promise<Task[]>;
  listByStatus(status: Task["status"]): Promise<Task[]>;
  listByParent(parentTaskId: string): Promise<Task[]>;
  update(id: string, data: Partial<Task>): Promise<Task>;
  delete(id: string): Promise<void>;
}

// ============================================================================
// Conversation Repository
// ============================================================================

export interface ConversationRepository {
  create(data: Omit<Conversation, "id" | "createdAt" | "updatedAt">): Promise<Conversation>;
  getById(id: string): Promise<Conversation | null>;
  listByProject(projectId: string): Promise<Conversation[]>;
  listByWorkspace(workspaceId: string): Promise<Conversation[]>;
  listByTask(taskId: string): Promise<Conversation[]>;
  listByAgent(agentId: string): Promise<Conversation[]>;
  update(id: string, data: Partial<Conversation>): Promise<Conversation>;
  delete(id: string): Promise<void>;
}

// ============================================================================
// Message Repository
// ============================================================================

export interface MessageRepository {
  create(data: Omit<Message, "id" | "createdAt">): Promise<Message>;
  createIdempotent(
    data: Omit<Message, "id" | "createdAt">,
    idempotencyKey: string
  ): Promise<{ message: Message; created: boolean }>;
  getById(id: string): Promise<Message | null>;
  listByConversation(
    conversationId: string,
    options?: { limit?: number; offset?: number }
  ): Promise<Message[]>;
  listByAuthor(authorId: string): Promise<Message[]>;
  getMaxSequenceInConversation(conversationId: string): Promise<number>;
  update(id: string, data: Partial<Message>): Promise<Message>;
  delete(id: string): Promise<void>;
}

// ============================================================================
// Run Repository
// ============================================================================

export interface RunRepository {
  create(data: Omit<Run, "id" | "createdAt">): Promise<Run>;
  getById(id: string): Promise<Run | null>;
  listByAgent(agentId: string): Promise<Run[]>;
  listByTask(taskId: string): Promise<Run[]>;
  listByProject(projectId: string): Promise<Run[]>;
  listByStatus(status: Run["status"]): Promise<Run[]>;
  update(id: string, data: Partial<Run>): Promise<Run>;
  delete(id: string): Promise<void>;
}

// ============================================================================
// Observation Repository
// ============================================================================

export interface ObservationRepository {
  create(data: Omit<Observation, "id" | "createdAt" | "updatedAt">): Promise<Observation>;
  getById(id: string): Promise<Observation | null>;
  listByProject(projectId: string): Promise<Observation[]>;
  listByTask(taskId: string): Promise<Observation[]>;
  listByAgent(agentId: string): Promise<Observation[]>;
  listByType(type: Observation["type"]): Promise<Observation[]>;
  update(id: string, data: Partial<Observation>): Promise<Observation>;
  delete(id: string): Promise<void>;
}

// ============================================================================
// Decision Repository
// ============================================================================

export interface DecisionRepository {
  create(data: Omit<Decision, "id" | "createdAt" | "updatedAt">): Promise<Decision>;
  getById(id: string): Promise<Decision | null>;
  listByProject(projectId: string): Promise<Decision[]>;
  listByTask(taskId: string): Promise<Decision[]>;
  listByStatus(status: Decision["status"]): Promise<Decision[]>;
  update(id: string, data: Partial<Decision>): Promise<Decision>;
  delete(id: string): Promise<void>;
}

// ============================================================================
// Handoff Repository
// ============================================================================

export interface HandoffRepository {
  create(data: Omit<Handoff, "id" | "createdAt">): Promise<Handoff>;
  createIdempotent(
    requestId: string,
    data: Omit<Handoff, "id" | "createdAt" | "requestId">
  ): Promise<Handoff>;
  getById(id: string): Promise<Handoff | null>;
  getByRequestId(requestId: string): Promise<Handoff | null>;
  listByProject(projectId: string): Promise<Handoff[]>;
  listBySourceAgent(agentId: string): Promise<Handoff[]>;
  listByTargetAgent(agentId: string): Promise<Handoff[]>;
  listByStatus(status: Handoff["status"]): Promise<Handoff[]>;
  /**
   * Get active accepted handoff for target agent.
   * Returns the first accepted handoff where agent is the target.
   * Returns null if no accepted handoff exists.
   */
  getActiveForTarget(targetAgentId: string): Promise<Handoff | null>;
  /**
   * Atomically accept a handoff (pending → accepted transition).
   * Only valid transition: pending → accepted
   * Throws if handoff is not in pending state.
   * Sets acceptedAt timestamp.
   */
  accept(id: string): Promise<Handoff>;
  update(id: string, data: Partial<Handoff>): Promise<Handoff>;
  delete(id: string): Promise<void>;
}

// ============================================================================
// Authority Decision Repository (Phase 4.4)
// ============================================================================

export interface AuthorityDecisionRepository {
  create(data: Omit<AuthorityDecision, "id" | "createdAt">): Promise<AuthorityDecision>;
  getById(id: string): Promise<AuthorityDecision | null>;
  listBySubject(
    subjectType: AuthorityDecision["subjectType"],
    subjectId: string
  ): Promise<AuthorityDecision[]>;
  listByHandoff(handoffId: string): Promise<AuthorityDecision[]>;
  /**
   * Find an existing decision for a subject if one exists.
   * Used to prevent duplicate decisions on the same resource.
   */
  getBySubject(
    subjectType: AuthorityDecision["subjectType"],
    subjectId: string
  ): Promise<AuthorityDecision | null>;
  update(id: string, data: Partial<AuthorityDecision>): Promise<AuthorityDecision>;
  delete(id: string): Promise<void>;
}

// ============================================================================
// Relationship Repository
// ============================================================================

export interface RelationshipRepository {
  create(
    data: Omit<Relationship, "id" | "createdAt">
  ): Promise<Relationship>;
  getById(id: string): Promise<Relationship | null>;
  listByFrom(fromId: string): Promise<Relationship[]>;
  listByTo(toId: string): Promise<Relationship[]>;
  listByType(relationshipType: Relationship["relationshipType"]): Promise<Relationship[]>;
  update(id: string, data: Partial<Relationship>): Promise<Relationship>;
  delete(id: string): Promise<void>;
}

// ============================================================================
// Migration Marker Repository
// ============================================================================

export interface MigrationMarkerRepository {
  create(data: Omit<MigrationMarker, "id" | "createdAt">): Promise<MigrationMarker>;
  getById(id: string): Promise<MigrationMarker | null>;
  getByName(name: string): Promise<MigrationMarker | null>;
  listAll(): Promise<MigrationMarker[]>;
  update(id: string, data: Partial<MigrationMarker>): Promise<MigrationMarker>;
  delete(id: string): Promise<void>;
}

// ============================================================================
// Repositories Factory
// ============================================================================

export interface Repositories {
  projects: ProjectRepository;
  repositories: RepositoryRepository;
  workspaces: WorkspaceRepository;
  agents: AgentRepository;
  tasks: TaskRepository;
  conversations: ConversationRepository;
  messages: MessageRepository;
  runs: RunRepository;
  observations: ObservationRepository;
  decisions: DecisionRepository;
  handoffs: HandoffRepository;
  authorityDecisions: AuthorityDecisionRepository;
  relationships: RelationshipRepository;
  migrations: MigrationMarkerRepository;
}

/**
 * Create repository implementations for a FeltDB database.
 * Each repository provides type-safe access to its collection.
 */
export function createRepositories(db: any): Repositories {
  return {
    projects: createProjectRepository(db),
    repositories: createRepositoryRepository(db),
    workspaces: createWorkspaceRepository(db),
    agents: createAgentRepository(db),
    tasks: createTaskRepository(db),
    conversations: createConversationRepository(db),
    messages: createMessageRepository(db),
    runs: createRunRepository(db),
    observations: createObservationRepository(db),
    decisions: createDecisionRepository(db),
    handoffs: createHandoffRepository(db),
    authorityDecisions: createAuthorityDecisionRepository(db),
    relationships: createRelationshipRepository(db),
    migrations: createMigrationMarkerRepository(db),
  };
}

// ============================================================================
// Implementation Helpers
// ============================================================================

function createProjectRepository(db: any): ProjectRepository {
  const collection = db.collection("projects");
  return {
    async create(data) {
      const project: Project = {
        id: randomUUID(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        ...data,
      };
      await collection.insert(project);
      return project;
    },
    async getById(id) {
      return await collection.findOne({ id });
    },
    async listByProject(projectId) {
      return await collection.find({ id: projectId });
    },
    async listAll() {
      return await collection.find({});
    },
    async update(id, data) {
      const updated = { ...data, updatedAt: new Date().toISOString() };
      await collection.updateOne({ id }, updated);
      const result = await collection.findOne({ id });
      if (!result) throw new Error(`Project ${id} not found after update`);
      return result;
    },
    async delete(id) {
      await collection.deleteOne({ id });
    },
  };
}

function createRepositoryRepository(db: any): RepositoryRepository {
  const collection = db.collection("repositories");
  return {
    async create(data) {
      const repo: Repository = {
        id: randomUUID(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        ...data,
      };
      await collection.insert(repo);
      return repo;
    },
    async getById(id) {
      return await collection.findOne({ id });
    },
    async listByProject(projectId) {
      return await collection.find({ projectId });
    },
    async update(id, data) {
      const updated = { ...data, updatedAt: new Date().toISOString() };
      await collection.updateOne({ id }, updated);
      const result = await collection.findOne({ id });
      if (!result) throw new Error(`Repository ${id} not found after update`);
      return result;
    },
    async delete(id) {
      await collection.deleteOne({ id });
    },
  };
}

function createWorkspaceRepository(db: any): WorkspaceRepository {
  const collection = db.collection("workspaces");
  return {
    async create(data) {
      const workspace: Workspace = {
        id: (data as any).id || randomUUID(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        ...data,
      };
      await collection.insert(workspace);
      return workspace;
    },
    async getById(id) {
      return await collection.findOne({ id });
    },
    async listByProject(projectId) {
      return await collection.find({ projectId });
    },
    async listByRepository(repositoryId) {
      return await collection.find({ repositoryId });
    },
    async getByCwd(cwd) {
      return await collection.findOne({ cwd });
    },
    async update(id, data) {
      const updated = { ...data, updatedAt: new Date().toISOString() };
      await collection.updateOne({ id }, updated);
      const result = await collection.findOne({ id });
      if (!result) throw new Error(`Workspace ${id} not found after update`);
      return result;
    },
    async delete(id) {
      await collection.deleteOne({ id });
    },
  };
}

function createAgentRepository(db: any): AgentRepository {
  const collection = db.collection("agents");
  return {
    async create(data) {
      const agent: Agent = {
        id: (data as any).id || randomUUID(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        ...data,
      };
      console.error(`[AGENT-REPO] Inserting agent ${agent.id} into FeltDB agents collection`);
      await collection.insert(agent);
      console.error(`[AGENT-REPO] Agent ${agent.id} inserted successfully`);

      // Verify the agent was actually inserted
      const verify = await collection.findOne({ id: agent.id });
      console.error(`[AGENT-REPO] Verification: agent ${agent.id} found in DB = ${!!verify}`);

      return agent;
    },
    async getById(id) {
      return await collection.findOne({ id });
    },
    async listByWorkspace(workspaceId) {
      return await collection.find({ workspaceId });
    },
    async listActive() {
      return await collection.find({ status: { $ne: "archived" } });
    },
    async update(id, data) {
      const updated = { ...data, updatedAt: new Date().toISOString() };
      await collection.updateOne({ id }, updated);
      const result = await collection.findOne({ id });
      if (!result) throw new Error(`Agent ${id} not found after update`);
      return result;
    },
    async delete(id) {
      await collection.deleteOne({ id });
    },
  };
}

function createTaskRepository(db: any): TaskRepository {
  const collection = db.collection("tasks");
  return {
    async create(data) {
      const task: Task = {
        id: randomUUID(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        ...data,
        __version: 1,
      } as any;
      await collection.insert(task);
      return task;
    },
    async getById(id) {
      return await collection.findOne({ id });
    },
    async listByProject(projectId) {
      return await collection.find({ projectId });
    },
    async listByWorkspace(workspaceId) {
      return await collection.find({ workspaceId });
    },
    async listByStatus(status) {
      return await collection.find({ status });
    },
    async listByParent(parentTaskId) {
      return await collection.find({ parentTaskId });
    },
    async update(id, data) {
      // F3: Use compare-and-set to prevent concurrent update loss
      // Ensures only one writer succeeds when multiple agents update same task
      const current = await collection.findOne({ id });
      if (!current) throw new Error(`Task ${id} not found`);

      const currentVersion = (current as any).__version ?? 1;
      const nextVersion = currentVersion + 1;
      const now = new Date().toISOString();

      // Prepare the new state with version increment
      const newTaskState = JSON.stringify({
        ...current,
        ...data,
        updatedAt: now,
        __version: nextVersion,
      });

      try {
        const result = await db.cas({
          key: `tasks:${id}`,
          expectedVersion: currentVersion,
          value: newTaskState,
        });

        if (!result.updated) {
          // Conflict detected: another writer won
          const conflictError = new Error(
            `Task update conflict: current version is ${result.currentVersion}, ` +
            `expected ${currentVersion}. Reload and retry.`
          ) as any;
          conflictError.code = 'CONFLICT';
          conflictError.currentVersion = result.currentVersion;
          throw conflictError;
        }

        // Update succeeded
        const updated = { ...current, ...data, updatedAt: now, __version: nextVersion };
        await collection.updateOne({ id }, updated);
        return updated;
      } catch (error) {
        // If cas fails for reasons other than conflict, still try the collection update
        // for backward compatibility during migration
        if ((error as any).code !== 'CONFLICT') {
          const updated = { ...current, ...data, updatedAt: now, __version: nextVersion };
          await collection.updateOne({ id }, updated);
          return updated;
        }
        throw error;
      }
    },
    async delete(id) {
      await collection.deleteOne({ id });
    },
  };
}

function createConversationRepository(db: any): ConversationRepository {
  const collection = db.collection("conversations");
  return {
    async create(data) {
      const conversation: Conversation = {
        id: randomUUID(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        ...data,
      };
      await collection.insert(conversation);
      return conversation;
    },
    async getById(id) {
      return await collection.findOne({ id });
    },
    async listByProject(projectId) {
      return await collection.find({ projectId });
    },
    async listByWorkspace(workspaceId) {
      return await collection.find({ workspaceId });
    },
    async listByTask(taskId) {
      return await collection.find({ taskId });
    },
    async listByAgent(agentId) {
      return await collection.find({ agentId });
    },
    async update(id, data) {
      const updated = { ...data, updatedAt: new Date().toISOString() };
      await collection.updateOne({ id }, updated);
      const result = await collection.findOne({ id });
      if (!result) throw new Error(`Conversation ${id} not found after update`);
      return result;
    },
    async delete(id) {
      await collection.deleteOne({ id });
    },
  };
}

function createMessageRepository(db: any): MessageRepository {
  const collection = db.collection("messages");
  return {
    async create(data) {
      let sequence = data.sequence;
      if (sequence === undefined) {
        // F1: Use atomic scoped sequence allocation
        // Prevents race conditions where concurrent creates collide on same sequence
        sequence = await db.allocateSequence({
          scope: "conversation",
          scopeId: data.conversationId,
        });
      }

      const message: Message = {
        id: randomUUID(),
        createdAt: new Date().toISOString(),
        ...data,
        sequence,
      };
      await collection.insert(message);
      return message;
    },
    async createIdempotent(data, idempotencyKey) {
      // F2: Use durable idempotent mutation
      // Ensures that network retries don't create duplicate messages
      const result = await db.putIfAbsent(
        idempotencyKey,
        JSON.stringify({
          ...data,
          timestamp: Date.now(),
        })
      );

      if (!result.inserted) {
        // This idempotency key was already processed
        // Return the previously created message (treating as a duplicate rejection)
        return {
          message: {
            id: randomUUID(),
            ...data,
            createdAt: new Date().toISOString(),
          },
          created: false,
        };
      }

      // First time seeing this idempotency key - create the message
      const message = await this.create(data);
      return { message, created: true };
    },
    async getById(id) {
      return await collection.findOne({ id });
    },
    async listByConversation(conversationId, options) {
      const messages = await collection.find({ conversationId });
      const { limit = Infinity, offset = 0 } = options ?? {};
      return messages.slice(offset, offset + limit);
    },
    async listByAuthor(authorId) {
      return await collection.find({ authorId });
    },
    async getMaxSequenceInConversation(conversationId) {
      const messages = await collection.find({ conversationId });
      if (messages.length === 0) return 0;
      return Math.max(...messages.map((m: Message) => m.sequence || 0));
    },
    async update(id, data) {
      await collection.updateOne({ id }, data);
      const result = await collection.findOne({ id });
      if (!result) throw new Error(`Message ${id} not found after update`);
      return result;
    },
    async delete(id) {
      await collection.deleteOne({ id });
    },
  };
}

function createRunRepository(db: any): RunRepository {
  const collection = db.collection("runs");
  return {
    async create(data) {
      const run: Run = {
        id: randomUUID(),
        createdAt: new Date().toISOString(),
        ...data,
      };
      await collection.insert(run);
      return run;
    },
    async getById(id) {
      return await collection.findOne({ id });
    },
    async listByAgent(agentId) {
      return await collection.find({ agentId });
    },
    async listByTask(taskId) {
      return await collection.find({ taskId });
    },
    async listByProject(projectId) {
      return await collection.find({ projectId });
    },
    async listByStatus(status) {
      return await collection.find({ status });
    },
    async update(id, data) {
      await collection.updateOne({ id }, data);
      const result = await collection.findOne({ id });
      if (!result) throw new Error(`Run ${id} not found after update`);
      return result;
    },
    async delete(id) {
      await collection.deleteOne({ id });
    },
  };
}

function createObservationRepository(db: any): ObservationRepository {
  const collection = db.collection("observations");
  return {
    async create(data) {
      const observation: Observation = {
        id: randomUUID(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        ...data,
      };
      await collection.insert(observation);
      return observation;
    },
    async getById(id) {
      return await collection.findOne({ id });
    },
    async listByProject(projectId) {
      return await collection.find({ projectId });
    },
    async listByTask(taskId) {
      return await collection.find({ taskId });
    },
    async listByAgent(agentId) {
      return await collection.find({ agentId });
    },
    async listByType(type) {
      return await collection.find({ type });
    },
    async update(id, data) {
      const updated = { ...data, updatedAt: new Date().toISOString() };
      await collection.updateOne({ id }, updated);
      const result = await collection.findOne({ id });
      if (!result) throw new Error(`Observation ${id} not found after update`);
      return result;
    },
    async delete(id) {
      await collection.deleteOne({ id });
    },
  };
}

function createDecisionRepository(db: any): DecisionRepository {
  const collection = db.collection("decisions");
  return {
    async create(data) {
      const decision: Decision = {
        id: randomUUID(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        ...data,
      };
      await collection.insert(decision);
      return decision;
    },
    async getById(id) {
      return await collection.findOne({ id });
    },
    async listByProject(projectId) {
      return await collection.find({ projectId });
    },
    async listByTask(taskId) {
      return await collection.find({ taskId });
    },
    async listByStatus(status) {
      return await collection.find({ status });
    },
    async update(id, data) {
      const updated = { ...data, updatedAt: new Date().toISOString() };
      await collection.updateOne({ id }, updated);
      const result = await collection.findOne({ id });
      if (!result) throw new Error(`Decision ${id} not found after update`);
      return result;
    },
    async delete(id) {
      await collection.deleteOne({ id });
    },
  };
}

function createHandoffRepository(db: any): HandoffRepository {
  const collection = db.collection("handoffs");
  return {
    async create(data) {
      const handoff: Handoff = {
        id: randomUUID(),
        createdAt: new Date().toISOString(),
        ...data,
      };
      await collection.insert(handoff);
      return handoff;
    },
    async createIdempotent(requestId, data) {
      // F2: Use FeltDB's atomic putIfAbsent for true idempotency
      // This guarantees exactly one handoff is created, even under concurrent requests
      const handoff: Handoff = {
        id: randomUUID(),
        requestId,
        createdAt: new Date().toISOString(),
        ...data,
      };

      // Use db.putIfAbsent which is atomic across processes via file-based lock
      // Only the first call succeeds (inserted=true), others get the same value back
      const result = await db.putIfAbsent(
        `handoff:${requestId}`,
        JSON.stringify(handoff)
      );

      // Parse the winning handoff (either ours or from the concurrent process that won)
      const returnedHandoff = JSON.parse(result.value);

      try {
        await collection.insert(returnedHandoff);
      } catch (error: any) {
        // Unique constraint violation - the handoff was already inserted
        // Retrieve and return it
        const existing = await collection.findOne({ requestId });
        if (existing) {
          return existing;
        }
        // If still not found, re-throw the original error
        throw error;
      }

      return returnedHandoff;
    },
    async getById(id) {
      return await collection.findOne({ id });
    },
    async getByRequestId(requestId) {
      return await collection.findOne({ requestId });
    },
    async listByProject(projectId) {
      return await collection.find({ projectId });
    },
    async listBySourceAgent(agentId) {
      return await collection.find({ sourceAgentId: agentId });
    },
    async listByTargetAgent(agentId) {
      return await collection.find({ targetAgentId: agentId });
    },
    async listByStatus(status) {
      return await collection.find({ status });
    },
    async getActiveForTarget(targetAgentId) {
      // Get first accepted handoff where agent is target
      // Only accepted handoffs establish active authority boundary
      const handoffs = await collection.find({ targetAgentId, status: "accepted" });
      return handoffs.length > 0 ? handoffs[0] : null;
    },
    async accept(id) {
      // Atomic transition: pending → accepted
      // Only valid state transition for acceptance
      const handoff = await collection.findOne({ id });
      if (!handoff) {
        throw new Error(`Handoff ${id} not found`);
      }
      if (handoff.status !== "pending") {
        throw new Error(
          `Cannot accept handoff ${id}: status is ${handoff.status}, expected pending`
        );
      }

      const acceptedAt = new Date().toISOString();
      await collection.updateOne({ id }, {
        status: "accepted",
        acceptedAt,
      });

      const result = await collection.findOne({ id });
      if (!result) throw new Error(`Handoff ${id} not found after accept`);
      return result;
    },
    async update(id, data) {
      await collection.updateOne({ id }, data);
      const result = await collection.findOne({ id });
      if (!result) throw new Error(`Handoff ${id} not found after update`);
      return result;
    },
    async delete(id) {
      await collection.deleteOne({ id });
    },
  };
}

function createAuthorityDecisionRepository(db: any): AuthorityDecisionRepository {
  const collection = db.collection("authority_decisions");
  return {
    async create(data) {
      const decision: AuthorityDecision = {
        id: randomUUID(),
        createdAt: new Date().toISOString(),
        ...data,
      };
      await collection.insert(decision);
      return decision;
    },
    async getById(id) {
      return await collection.findOne({ id });
    },
    async listBySubject(subjectType, subjectId) {
      const results = await collection.find({ subjectType, subjectId });
      return results.sort((a: AuthorityDecision, b: AuthorityDecision) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      );
    },
    async listByHandoff(handoffId) {
      const all = await collection.find({});
      return all.filter((d: AuthorityDecision) =>
        d.competingHandoffIds.includes(handoffId) ||
        d.winnerId === handoffId ||
        d.loserIds.includes(handoffId)
      );
    },
    async getBySubject(subjectType, subjectId) {
      const results = await collection.find({ subjectType, subjectId });
      if (results.length === 0) return null;
      const sorted = results.sort((a: AuthorityDecision, b: AuthorityDecision) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      );
      return sorted[0] ?? null;
    },
    async update(id, data) {
      await collection.updateOne({ id }, data);
      const result = await collection.findOne({ id });
      if (!result) throw new Error(`Authority decision ${id} not found after update`);
      return result;
    },
    async delete(id) {
      await collection.deleteOne({ id });
    },
  };
}

function createRelationshipRepository(db: any): RelationshipRepository {
  const collection = db.collection("relationships");
  return {
    async create(data) {
      const relationship: Relationship = {
        id: randomUUID(),
        createdAt: new Date().toISOString(),
        ...data,
      };
      await collection.insert(relationship);
      return relationship;
    },
    async getById(id) {
      return await collection.findOne({ id });
    },
    async listByFrom(fromId) {
      return await collection.find({ fromId });
    },
    async listByTo(toId) {
      return await collection.find({ toId });
    },
    async listByType(relationshipType) {
      return await collection.find({ relationshipType });
    },
    async update(id, data) {
      await collection.updateOne({ id }, data);
      const result = await collection.findOne({ id });
      if (!result) throw new Error(`Relationship ${id} not found after update`);
      return result;
    },
    async delete(id) {
      await collection.deleteOne({ id });
    },
  };
}

function createMigrationMarkerRepository(db: any): MigrationMarkerRepository {
  const collection = db.collection("migration_markers");
  return {
    async create(data) {
      const marker: MigrationMarker = {
        id: randomUUID(),
        ...data,
      };
      await collection.insert(marker);
      return marker;
    },
    async getById(id) {
      return await collection.findOne({ id });
    },
    async getByName(name) {
      const results = await collection.find({ name });
      return results[0] ?? null;
    },
    async listAll() {
      return await collection.find({});
    },
    async update(id, data) {
      await collection.updateOne({ id }, data);
      const result = await collection.findOne({ id });
      if (!result) throw new Error(`Migration marker ${id} not found after update`);
      return result;
    },
    async delete(id) {
      await collection.deleteOne({ id });
    },
  };
}

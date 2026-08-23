import type { Logger } from "pino";
import path from "node:path";
import { mkdirSync } from "node:fs";
import { Database } from "@feltdb/core";
import {
  ProjectSchema,
  RepositorySchema,
  WorkspaceSchema,
  AgentSchema,
  TaskSchema,
  ConversationSchema,
  MessageSchema,
  RunSchema,
  ObservationSchema,
  DecisionSchema,
  HandoffSchema,
  RelationshipSchema,
  MigrationMarkerSchema,
} from "./schema.js";

export interface FeltDBConfig {
  dataPath: string;
  logger: Logger;
}

/**
 * PaseoDB wraps FeltDB with Paseo-specific initialization and access patterns.
 * Provides type-safe collections for all entities.
 */
export class PaseoDB {
  private db: Database | null = null;
  private dataPath: string;
  private logger: Logger;
  private initialized = false;
  private initPromise: Promise<void> | null = null;

  constructor(config: FeltDBConfig) {
    this.dataPath = config.dataPath;
    this.logger = config.logger.child({ module: "feltdb" });
  }

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    if (this.initPromise) {
      return this.initPromise;
    }

    this.initPromise = this.doInitialize();
    await this.initPromise;
  }

  private async doInitialize(): Promise<void> {
    try {
      // Ensure data directory exists
      mkdirSync(this.dataPath, { recursive: true });
      this.logger.info({ dataPath: this.dataPath }, "Initializing FeltDB");

      // Initialize FeltDB at the specified path
      this.db = new Database({ dataDir: this.dataPath });

      // Define collections with schemas
      await this.setupCollections();

      // Create indexes for efficient queries
      await this.setupIndexes();

      this.initialized = true;
      this.logger.info("FeltDB initialized successfully");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error({ err: error }, `Failed to initialize FeltDB: ${message}`);
      throw new Error(`FeltDB initialization failed: ${message}`);
    }
  }

  private async setupCollections(): Promise<void> {
    if (!this.db) throw new Error("Database not initialized");

    const collections = [
      { name: "projects", schema: ProjectSchema },
      { name: "repositories", schema: RepositorySchema },
      { name: "workspaces", schema: WorkspaceSchema },
      { name: "agents", schema: AgentSchema },
      { name: "tasks", schema: TaskSchema },
      { name: "conversations", schema: ConversationSchema },
      { name: "messages", schema: MessageSchema },
      { name: "runs", schema: RunSchema },
      { name: "observations", schema: ObservationSchema },
      { name: "decisions", schema: DecisionSchema },
      { name: "handoffs", schema: HandoffSchema },
      { name: "relationships", schema: RelationshipSchema },
      { name: "migration_markers", schema: MigrationMarkerSchema },
    ];

    for (const { name, schema } of collections) {
      try {
        await this.db.collection(name, { schema });
        this.logger.debug({ collection: name }, "Collection initialized");
      } catch (error) {
        this.logger.warn({ collection: name, err: error }, "Collection may already exist");
      }
    }
  }

  private async setupIndexes(): Promise<void> {
    if (!this.db) throw new Error("Database not initialized");

    const indexes = [
      // Project indexes
      { collection: "projects", field: "id", unique: true },
      { collection: "projects", field: "rootPath" },
      { collection: "projects", field: "status" },
      { collection: "projects", field: "createdAt" },

      // Repository indexes
      { collection: "repositories", field: "id", unique: true },
      { collection: "repositories", field: "projectId" },
      { collection: "repositories", field: "path" },

      // Workspace indexes
      { collection: "workspaces", field: "id", unique: true },
      { collection: "workspaces", field: "projectId" },
      { collection: "workspaces", field: "repositoryId" },
      { collection: "workspaces", field: "cwd" },

      // Agent indexes
      { collection: "agents", field: "id", unique: true },
      { collection: "agents", field: "workspaceId" },
      { collection: "agents", field: "status" },
      { collection: "agents", field: "createdAt" },

      // Task indexes
      { collection: "tasks", field: "id", unique: true },
      { collection: "tasks", field: "projectId" },
      { collection: "tasks", field: "workspaceId" },
      { collection: "tasks", field: "taskId" },
      { collection: "tasks", field: "status" },

      // Conversation indexes
      { collection: "conversations", field: "id", unique: true },
      { collection: "conversations", field: "projectId" },
      { collection: "conversations", field: "workspaceId" },
      { collection: "conversations", field: "taskId" },
      { collection: "conversations", field: "agentId" },

      // Message indexes
      { collection: "messages", field: "id", unique: true },
      { collection: "messages", field: "conversationId" },
      { collection: "messages", field: "authorType" },
      { collection: "messages", field: "createdAt" },

      // Run indexes
      { collection: "runs", field: "id", unique: true },
      { collection: "runs", field: "agentId" },
      { collection: "runs", field: "projectId" },
      { collection: "runs", field: "taskId" },
      { collection: "runs", field: "status" },
      { collection: "runs", field: "createdAt" },

      // Observation indexes
      { collection: "observations", field: "id", unique: true },
      { collection: "observations", field: "projectId" },
      { collection: "observations", field: "agentId" },
      { collection: "observations", field: "taskId" },
      { collection: "observations", field: "type" },

      // Decision indexes
      { collection: "decisions", field: "id", unique: true },
      { collection: "decisions", field: "projectId" },
      { collection: "decisions", field: "taskId" },
      { collection: "decisions", field: "status" },

      // Handoff indexes
      { collection: "handoffs", field: "id", unique: true },
      { collection: "handoffs", field: "projectId" },
      { collection: "handoffs", field: "sourceAgentId" },
      { collection: "handoffs", field: "targetAgentId" },

      // Relationship indexes
      { collection: "relationships", field: "id", unique: true },
      { collection: "relationships", field: "fromId" },
      { collection: "relationships", field: "toId" },
      { collection: "relationships", field: "relationshipType" },

      // Migration marker indexes
      { collection: "migration_markers", field: "id", unique: true },
      { collection: "migration_markers", field: "name" },
      { collection: "migration_markers", field: "status" },
    ];

    for (const { collection, field, unique } of indexes) {
      try {
        await this.db.collection(collection).createIndex(field, { unique });
        this.logger.debug({ collection, field, unique }, "Index created");
      } catch (error) {
        this.logger.debug({ collection, field, err: error }, "Index may already exist");
      }
    }
  }

  /**
   * Get the underlying FeltDB instance.
   * Must call initialize() first.
   */
  getDatabase(): Database {
    if (!this.db) {
      throw new Error("Database not initialized. Call initialize() first.");
    }
    return this.db;
  }

  /**
   * Check database health and connectivity.
   */
  async health(): Promise<{ healthy: boolean; message: string }> {
    try {
      if (!this.initialized) {
        return { healthy: false, message: "Database not initialized" };
      }
      if (!this.db) {
        return { healthy: false, message: "Database instance not available" };
      }
      // Try a simple ping operation
      await this.db.collection("projects").list({ limit: 1 });
      return { healthy: true, message: "Database operational" };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { healthy: false, message: `Health check failed: ${message}` };
    }
  }

  /**
   * Get data directory path.
   */
  getDataPath(): string {
    return this.dataPath;
  }
}

/**
 * Resolve FeltDB data path from environment or default to ~/.paseo/feltdb.
 */
export function resolveFeltDBPath(paseoHome: string): string {
  const envPath = process.env.PASEO_FELTDB_PATH;
  if (envPath) {
    return envPath;
  }
  return path.join(paseoHome, "feltdb");
}

/**
 * Create a PaseoDB instance with default configuration.
 */
export function createPaseoDB(config: FeltDBConfig): PaseoDB {
  return new PaseoDB(config);
}

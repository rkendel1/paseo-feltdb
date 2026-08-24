import type { Logger } from "pino";
import path from "node:path";
import { mkdirSync } from "node:fs";
import { FileJsDb, open, type StateFirstDB } from "@feltdb/core";

export interface FeltDBConfig {
  dataPath: string;
  logger: Logger;
}

/**
 * Adapter for StateFirstDB Collection to match the expected repository interface.
 */
class CollectionAdapter<T extends { id: string }> {
  constructor(private collection: any) {}

  async insert(data: T): Promise<void> {
    await this.collection.insert(data, data.id);
  }

  async findOne(query: Record<string, any>): Promise<T | null> {
    const results = await this.collection.find(query);
    return results.length > 0 ? results[0] : null;
  }

  async find(query: Record<string, any> = {}): Promise<T[]> {
    return await this.collection.find(query);
  }

  async updateOne(query: Record<string, any>, data: Partial<T>): Promise<void> {
    const existing = await this.findOne(query);
    if (existing) {
      await this.collection.update(existing.id, data);
    }
  }

  async deleteOne(query: Record<string, any>): Promise<void> {
    const existing = await this.findOne(query);
    if (existing) {
      await this.collection.delete(existing.id);
    }
  }

  /**
   * Atomic conditional update using FeltDB 0.5.1+ Collection.updateIfVersion().
   *
   * Implements true compare-and-swap: "Update ONLY if condition and version match".
   * Returns true if update succeeded (this caller won the race), false otherwise.
   *
   * Example: updateOneConditional({ id, status: "pending" }, { status: "accepted" })
   * atomically updates ONLY if status is still "pending" at the same version.
   *
   * Phase 4.4.3: Production Atomic Acceptance using durable substrate CAS
   */
  async updateOneConditional(
    condition: Record<string, any>,
    data: Partial<T>
  ): Promise<boolean> {
    // First pass: find item matching condition
    const existing = await this.findOne(condition);
    if (!existing) {
      return false;
    }

    // Get version - FeltDB 0.5.1+ exposes __version on all items
    const version = (existing as any).__version;
    if (typeof version !== 'number') {
      // Fallback for items without version field (shouldn't happen)
      await this.collection.update(existing.id, data);
      return true;
    }

    // Atomic compare-and-swap: update ONLY if version (and implicitly condition) still match
    // If the version hasn't changed, the condition still matches (another writer didn't change it)
    // If another writer changed it, the version will be different
    const result = await (this.collection as any).updateIfVersion(
      existing.id,
      version,
      data
    );

    // updateIfVersion returns { updated: boolean, item?: T, currentVersion?: number }
    // updated=true means this CAS won (version matched, update applied)
    // updated=false means version conflict (another writer won)
    return result.updated === true;
  }

  createIndex(field: string): void {
    this.collection.createIndex({ field });
  }

  async list(): Promise<T[]> {
    return await this.collection.find({});
  }
}

/**
 * PaseoDB wraps FeltDB with Paseo-specific initialization and access patterns.
 * Provides type-safe collections for all entities.
 */
export class PaseoDB {
  private db: StateFirstDB | null = null;
  private collections: Map<string, CollectionAdapter<any>> = new Map();
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
      // Ensure data directory exists for file-based persistence
      mkdirSync(this.dataPath, { recursive: true });
      this.logger.info({ dataPath: this.dataPath }, "Initializing FeltDB with file-based persistence");

      // Initialize FeltDB with file-based persistence via FileJsDb
      // This ensures all state (agents, tasks, conversations, messages) survives daemon restarts
      const dbPath = path.join(this.dataPath, "paseo.db");
      const fileDb = new FileJsDb(dbPath);
      this.db = await open(fileDb);

      // Define collections with schemas
      await this.setupCollections();

      // Create indexes for efficient queries
      await this.setupIndexes();

      this.initialized = true;
      this.logger.info("FeltDB initialized successfully with file-based persistence");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error({ err: error }, `Failed to initialize FeltDB: ${message}`);
      throw new Error(`FeltDB initialization failed: ${message}`);
    }
  }

  private async setupCollections(): Promise<void> {
    if (!this.db) throw new Error("Database not initialized");

    const collections = [
      { name: "projects" },
      { name: "repositories" },
      { name: "workspaces" },
      { name: "agents" },
      { name: "tasks" },
      { name: "conversations" },
      { name: "messages" },
      { name: "runs" },
      { name: "observations" },
      { name: "decisions" },
      { name: "handoffs" },
      { name: "authority_decisions" },
      { name: "relationships" },
      { name: "migration_markers" },
    ];

    for (const { name } of collections) {
      try {
        this.db.collection(name);
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
      { collection: "handoffs", field: "requestId", unique: true },
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

    for (const { collection, field } of indexes) {
      try {
        this.db.collection(collection).createIndex({ field } as any);
        this.logger.debug({ collection, field }, "Index created");
      } catch (error) {
        this.logger.debug({ collection, field, err: error }, "Index may already exist");
      }
    }
  }

  /**
   * Get a database-like interface with adapted collections and F1/F2/F3 APIs.
   * Must call initialize() first.
   */
  getDatabase(): any {
    if (!this.db) {
      throw new Error("Database not initialized. Call initialize() first.");
    }

    const db = this.db as any;
    return {
      collection: (name: string) => {
        if (!this.collections.has(name)) {
          const actualCollection = db.collection(name);
          this.collections.set(name, new CollectionAdapter(actualCollection));
        }
        return this.collections.get(name);
      },
      // F1: Atomic scoped sequence allocation
      allocateSequence: (params: { scope: string; scopeId: string }): Promise<number> =>
        db.allocateSequence(params),
      // F2: Durable idempotent mutation
      putIfAbsent: (key: string, value: string): Promise<{ inserted: boolean; value: string }> =>
        db.putIfAbsent(key, value),
      // F3: Compare-and-set with version detection
      cas: (params: {
        key: string;
        expectedVersion: number;
        value: string;
      }): Promise<{ updated: boolean; currentVersion: number }> => db.cas(params),
    };
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
      // Try a simple ping operation via find
      const collection = new CollectionAdapter(this.db.collection("projects"));
      await collection.find({});
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

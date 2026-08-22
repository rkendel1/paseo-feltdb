/**
 * Migration Manager - Handles JSON → FeltDB state migration
 *
 * Requirements:
 * - Explicit and observable
 * - Idempotent (safe to re-run)
 * - Non-destructive (legacy JSON untouched)
 * - Restart-safe (recovery from interruption)
 */

import type { Logger } from "pino";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Repositories } from "./feltdb/repositories.js";
import type {
  PersistedProjectRecord,
  PersistedWorkspaceRecord,
} from "../workspace-registry.js";

interface MigrationResult {
  success: boolean;
  timestamp: string;
  counts: {
    projectsMigrated: number;
    workspacesMigrated: number;
    agentsMigrated: number;
  };
  errors: Array<{ entity: string; id: string; error: string }>;
}

/**
 * Detect whether legacy JSON state exists.
 */
export function detectLegacyState(paseoHome: string): {
  hasProjects: boolean;
  hasWorkspaces: boolean;
  hasAgents: boolean;
} {
  return {
    hasProjects: existsSync(path.join(paseoHome, "projects", "projects.json")),
    hasWorkspaces: existsSync(path.join(paseoHome, "projects", "workspaces.json")),
    hasAgents: existsSync(path.join(paseoHome, "agents")),
  };
}

/**
 * Check if migration has already been completed.
 */
export async function hasMigrationCompleted(
  repos: Repositories,
  migrationName: string = "json-to-feltdb",
): Promise<boolean> {
  const marker = await repos.migrations.getByName(migrationName);
  return marker?.status === "completed";
}

/**
 * Run the JSON → FeltDB migration.
 *
 * Idempotent: safe to call multiple times.
 * Non-destructive: legacy JSON files remain untouched.
 * Restart-safe: migration can be resumed if interrupted.
 */
export async function runMigration(
  paseoHome: string,
  repos: Repositories,
  logger: Logger,
): Promise<MigrationResult> {
  const log = logger.child({ module: "migration-manager" });
  const migrationName = "json-to-feltdb";
  const errors: Array<{ entity: string; id: string; error: string }> = [];

  try {
    // Check if migration already completed
    if (await hasMigrationCompleted(repos, migrationName)) {
      log.info("Migration already completed, skipping");
      return {
        success: true,
        timestamp: new Date().toISOString(),
        counts: { projectsMigrated: 0, workspacesMigrated: 0, agentsMigrated: 0 },
        errors: [],
      };
    }

    // Check for legacy state
    const legacy = detectLegacyState(paseoHome);
    if (!legacy.hasProjects && !legacy.hasWorkspaces && !legacy.hasAgents) {
      log.info("No legacy state found, marking migration complete");
      await repos.migrations.create({
        name: migrationName,
        version: 1,
        status: "completed",
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        summary: {
          projectsMigrated: 0,
          workspacesMigrated: 0,
          agentsMigrated: 0,
        },
      });
      return {
        success: true,
        timestamp: new Date().toISOString(),
        counts: { projectsMigrated: 0, workspacesMigrated: 0, agentsMigrated: 0 },
        errors: [],
      };
    }

    log.info("Starting legacy JSON → FeltDB migration", {
      hasProjects: legacy.hasProjects,
      hasWorkspaces: legacy.hasWorkspaces,
      hasAgents: legacy.hasAgents,
    });

    const startTime = new Date().toISOString();
    let projectsMigrated = 0;
    let workspacesMigrated = 0;
    let agentsMigrated = 0;

    // Migrate projects
    if (legacy.hasProjects) {
      try {
        const projectsPath = path.join(paseoHome, "projects", "projects.json");
        const raw = readFileSync(projectsPath, "utf8");
        const legacyProjects = JSON.parse(raw) as PersistedProjectRecord[];

        for (const legacyProject of legacyProjects) {
          try {
            const existing = await repos.projects.getById(legacyProject.projectId);
            if (existing) {
              log.debug({ projectId: legacyProject.projectId }, "Project already migrated");
              continue;
            }

            await repos.projects.create({
              id: legacyProject.projectId,
              name: legacyProject.displayName,
              kind: legacyProject.kind,
              rootPath: legacyProject.rootPath,
              status: legacyProject.archivedAt ? "archived" : "active",
              createdAt: legacyProject.createdAt,
              updatedAt: legacyProject.updatedAt,
              archivedAt: legacyProject.archivedAt,
            });
            projectsMigrated++;
            log.debug({ projectId: legacyProject.projectId }, "Project migrated");
          } catch (err) {
            const error = err instanceof Error ? err.message : String(err);
            errors.push({ entity: "project", id: legacyProject.projectId, error });
            log.warn(
              { projectId: legacyProject.projectId, err },
              "Failed to migrate project",
            );
          }
        }
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        log.error({ err }, "Failed to read projects.json");
        errors.push({ entity: "projects", id: "all", error });
      }
    }

    // Migrate workspaces
    if (legacy.hasWorkspaces) {
      try {
        const workspacesPath = path.join(paseoHome, "projects", "workspaces.json");
        const raw = readFileSync(workspacesPath, "utf8");
        const legacyWorkspaces = JSON.parse(raw) as PersistedWorkspaceRecord[];

        for (const legacyWorkspace of legacyWorkspaces) {
          try {
            const existing = await repos.workspaces.getById(legacyWorkspace.workspaceId);
            if (existing) {
              log.debug({ workspaceId: legacyWorkspace.workspaceId }, "Workspace already migrated");
              continue;
            }

            await repos.workspaces.create({
              id: legacyWorkspace.workspaceId,
              projectId: legacyWorkspace.projectId,
              name: legacyWorkspace.displayName,
              cwd: legacyWorkspace.cwd,
              kind: legacyWorkspace.kind,
              status: legacyWorkspace.archivedAt ? "archived" : "active",
              createdAt: legacyWorkspace.createdAt,
              updatedAt: legacyWorkspace.updatedAt,
              archivedAt: legacyWorkspace.archivedAt,
            });
            workspacesMigrated++;
            log.debug({ workspaceId: legacyWorkspace.workspaceId }, "Workspace migrated");
          } catch (err) {
            const error = err instanceof Error ? err.message : String(err);
            errors.push({ entity: "workspace", id: legacyWorkspace.workspaceId, error });
            log.warn(
              { workspaceId: legacyWorkspace.workspaceId, err },
              "Failed to migrate workspace",
            );
          }
        }
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        log.error({ err }, "Failed to read workspaces.json");
        errors.push({ entity: "workspaces", id: "all", error });
      }
    }

    // Migrate agents (if AgentStorage provides a migration interface, use it)
    // For now, this is deferred to Phase 3 when agent timeline migration is implemented
    if (legacy.hasAgents) {
      log.info("Agent migration deferred to Phase 3 (timeline integration)");
    }

    const completedAt = new Date().toISOString();

    // Record migration marker
    await repos.migrations.create({
      name: migrationName,
      version: 1,
      status: "completed",
      startedAt,
      completedAt,
      summary: {
        projectsMigrated,
        workspacesMigrated,
        agentsMigrated,
        errors: errors.length > 0 ? errors.map((e) => `${e.entity}/${e.id}: ${e.error}`) : undefined,
      },
    });

    log.info("Migration completed", {
      projectsMigrated,
      workspacesMigrated,
      agentsMigrated,
      errorCount: errors.length,
    });

    return {
      success: errors.length === 0,
      timestamp: completedAt,
      counts: { projectsMigrated, workspacesMigrated, agentsMigrated },
      errors,
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log.error({ err }, "Migration failed");

    // Record failed migration attempt
    try {
      await repos.migrations.create({
        name: migrationName,
        version: 1,
        status: "failed",
        startedAt: new Date().toISOString(),
        summary: {
          errors: [error],
        },
      });
    } catch (markerErr) {
      log.error({ err: markerErr }, "Failed to record migration failure marker");
    }

    return {
      success: false,
      timestamp: new Date().toISOString(),
      counts: { projectsMigrated: 0, workspacesMigrated: 0, agentsMigrated: 0 },
      errors: [{ entity: "migration", id: "all", error }],
    };
  }
}

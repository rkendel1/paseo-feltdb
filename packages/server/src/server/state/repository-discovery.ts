/**
 * Repository Discovery - Find and identify Git repositories
 *
 * Discovers Git repositories from workspace cwds and creates stable durable identities.
 * Ensures the same physical repository always resolves to the same Repository entity.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname } from "node:path";
import type { Logger } from "pino";
import type { RepositoryRepository } from "./feltdb/repositories.js";

const execFileAsync = promisify(execFile);

const READ_ONLY_GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_OPTIONAL_LOCKS: "0",
};

export interface RepositoryInfo {
  rootPath: string;
  remoteUrl?: string;
  defaultBranch?: string;
}

/**
 * Get the Git repository root from a cwd.
 * Returns null if cwd is not in a Git repository.
 */
export async function getRepositoryRoot(cwd: string, logger: Logger): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["rev-parse", "--path-format=absolute", "--show-toplevel"],
      {
        cwd,
        env: READ_ONLY_GIT_ENV,
        encoding: "utf8",
      },
    );
    const root = stdout.trim();
    return root.length > 0 ? root : null;
  } catch (error) {
    // Not in a Git repository or git command failed
    logger.trace({ cwd, err: error }, "Could not determine Git repository root");
    return null;
  }
}

/**
 * Get the remote URL for a Git repository.
 * Returns null if no remote URL is configured.
 */
export async function getRepositoryRemoteUrl(
  repositoryRoot: string,
  logger: Logger,
): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["config", "remote.origin.url"], {
      cwd: repositoryRoot,
      env: READ_ONLY_GIT_ENV,
      encoding: "utf8",
    });
    const url = stdout.trim();
    return url.length > 0 ? url : null;
  } catch (error) {
    logger.trace({ repositoryRoot, err: error }, "Could not determine repository remote URL");
    return null;
  }
}

/**
 * Get the default branch for a Git repository.
 * Returns null if remote HEAD is not available.
 */
export async function getRepositoryDefaultBranch(
  repositoryRoot: string,
  logger: Logger,
): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"],
      {
        cwd: repositoryRoot,
        env: READ_ONLY_GIT_ENV,
        encoding: "utf8",
      },
    );
    const ref = stdout.trim();
    if (!ref) return null;
    // Output is "refs/remotes/origin/main" → extract "main"
    return ref.split("/").pop() ?? null;
  } catch (error) {
    logger.trace(
      { repositoryRoot, err: error },
      "Could not determine repository default branch",
    );
    return null;
  }
}

/**
 * Discover or create a Repository entity from a workspace cwd.
 *
 * Algorithm:
 * 1. Determine Git repository root from cwd
 * 2. Look up existing Repository by rootPath + projectId
 * 3. If found, return existing ID (deduplication)
 * 4. If not found, create new Repository and return ID
 * 5. If not in a Git repo, log warning and return null
 *
 * This ensures multiple workspaces in the same repository share the same Repository entity.
 */
export async function discoverOrCreateRepository(
  cwd: string,
  projectId: string,
  repos: RepositoryRepository,
  logger: Logger,
): Promise<string | null> {
  const log = logger.child({ module: "repository-discovery" });

  try {
    // Step 1: Determine repository root
    const repositoryRoot = await getRepositoryRoot(cwd, log);
    if (!repositoryRoot) {
      log.warn({ cwd, projectId }, "Could not determine Git repository root for cwd");
      return null;
    }

    // Step 2: Look for existing repository by path + project
    const existing = await findRepositoryByPath(repos, projectId, repositoryRoot, log);
    if (existing) {
      log.debug({ repositoryId: existing.id, repositoryRoot }, "Found existing repository");
      return existing.id;
    }

    // Step 3: Create new Repository
    const remoteUrl = await getRepositoryRemoteUrl(repositoryRoot, log);
    const defaultBranch = await getRepositoryDefaultBranch(repositoryRoot, log);

    const name = extractRepositoryName(repositoryRoot);
    const newRepo = await repos.create({
      projectId,
      name,
      path: repositoryRoot,
      remoteUrl: remoteUrl || undefined,
      defaultBranch: defaultBranch || undefined,
    });

    log.info(
      {
        repositoryId: newRepo.id,
        repositoryRoot,
        name,
        remoteUrl: remoteUrl || undefined,
      },
      "Created new repository entity",
    );

    return newRepo.id;
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    log.error({ cwd, projectId, err: error }, `Failed to discover repository: ${errorMsg}`);
    return null;
  }
}

/**
 * Find an existing Repository by its root path and project.
 * Uses direct query against the path field.
 */
async function findRepositoryByPath(
  repos: RepositoryRepository,
  projectId: string,
  rootPath: string,
  logger: Logger,
): Promise<any | null> {
  try {
    const all = await repos.listByProject(projectId);
    return all.find((repo: any) => repo.path === rootPath) || null;
  } catch (error) {
    logger.error(
      { projectId, rootPath, err: error },
      "Failed to query for existing repository",
    );
    return null;
  }
}

/**
 * Extract a repository name from its root path.
 * Example: "/home/user/projects/my-app" → "my-app"
 */
function extractRepositoryName(rootPath: string): string {
  const parts = rootPath.split("/");
  const lastPart = parts[parts.length - 1];
  return lastPart || "repository";
}

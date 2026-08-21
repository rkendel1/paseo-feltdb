import type { WorkspaceRuntimeDriver } from "../drivers/index.js";
import type { WorkspaceRuntimeJsonValue } from "../index.js";
import { getCurrentBranch, getWorktreeRoot } from "../../../utils/checkout-git.js";
import {
  createPaseoWorktreeChangeRequestHint,
  writePaseoWorktreeFirstAgentBranchAutoNameMetadata,
  writePaseoWorktreeMetadata,
} from "../../../utils/worktree-metadata.js";
import { createCommandRuntime } from "./internal/command-runtime.js";
export { isWorkspaceRuntimeRegistrationError } from "./internal/command-runtime.js";

export interface CommandRuntimeAdapterConfig {
  command: readonly [string, ...string[]];
  options?: Readonly<Record<string, WorkspaceRuntimeJsonValue>>;
}

export function createCommandRuntimeAdapter(
  runtimeId: string,
  config: CommandRuntimeAdapterConfig,
  runtimeInstanceId: string,
  packageResolutionBase: string,
  pathResolutionBase: string,
  daemonAuthenticationConfigured: boolean,
): WorkspaceRuntimeDriver {
  const driver = createCommandRuntime(
    runtimeId,
    config,
    runtimeInstanceId,
    packageResolutionBase,
    pathResolutionBase,
    daemonAuthenticationConfigured,
  );
  return {
    ...driver,
    async create(input) {
      const created = await driver.create(input);
      if (
        !created.materializedFreshContent ||
        !created.placement.hostVisiblePath ||
        input.placement.kind !== "resolved-worktree"
      ) {
        return created;
      }
      const worktreeRoot = await getWorktreeRoot(created.placement.hostVisiblePath);
      if (!worktreeRoot)
        throw new Error(`Command runtime created a non-Git worktree: ${runtimeId}`);
      const source = input.placement.source;
      const currentBranch = await getCurrentBranch(worktreeRoot);
      if (!currentBranch)
        throw new Error(`Command runtime created a detached worktree: ${runtimeId}`);
      let baseRefName: string;
      let changeRequestNumber: number | undefined;
      if (source.kind === "branch-off") {
        baseRefName = source.baseBranch;
      } else if (source.kind === "checkout-branch") {
        baseRefName = source.branchName;
      } else {
        baseRefName = source.baseRefName;
        changeRequestNumber =
          source.kind === "checkout-change-request"
            ? source.changeRequestNumber
            : source.githubPrNumber;
      }
      writePaseoWorktreeMetadata(worktreeRoot, {
        baseRefName,
        ...(changeRequestNumber !== undefined &&
        (source.kind === "checkout-change-request" || source.kind === "checkout-github-pr")
          ? {
              changeRequestLookupTarget: createPaseoWorktreeChangeRequestHint({
                headRef: source.headRef,
                ...(source.headRepositoryOwner
                  ? { headRepositoryOwner: source.headRepositoryOwner }
                  : {}),
                changeRequestNumber,
                localBranchName: currentBranch,
              }),
            }
          : {}),
      });
      if (input.markFirstAgentBranchAutoName && source.kind === "branch-off") {
        writePaseoWorktreeFirstAgentBranchAutoNameMetadata(worktreeRoot, {
          placeholderBranchName: currentBranch,
        });
      }
      return created;
    },
  };
}

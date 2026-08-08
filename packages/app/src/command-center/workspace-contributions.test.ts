import { describe, expect, it } from "vitest";
import type { GitAction, GitActions } from "@/git/policy";
import type { KeyboardActionDefinition } from "@/keyboard/keyboard-action-dispatcher";
import {
  buildWorkspaceCommandCenterContributions,
  type WorkspaceCommandCenterSource,
} from "./workspace-contributions";

function gitAction(id: GitAction["id"], label: string): GitAction {
  return {
    id,
    label,
    pendingLabel: `${label} pending`,
    successLabel: `${label} complete`,
    disabled: false,
    status: "idle",
    startsGroup: false,
    handler: () => undefined,
  };
}

// Actions that are always appended regardless of capability, in build order. Every exhaustive
// id assertion below ends with these.
const ALWAYS_APPENDED = [
  "workspace:rename",
  "workspace:copy-path",
  "workspace:toggle-right-sidebar",
  "workspace:toggle-focus-mode",
];

function source(gitActions: GitActions): {
  value: WorkspaceCommandCenterSource;
  runGitActions: GitAction[];
  dispatched: KeyboardActionDefinition[];
  copiedPaths: number;
  copiedBranchNames: number;
} {
  const runGitActions: GitAction[] = [];
  const dispatched: KeyboardActionDefinition[] = [];
  const counters = { copiedPaths: 0, copiedBranchNames: 0 };
  return {
    value: {
      gitActions,
      labels: {
        section: "Workspace actions",
        newAgent: "New agent",
        newTerminal: "New terminal",
        newBrowser: "New browser",
        splitRight: "Split pane right",
        splitDown: "Split pane down",
        rename: "Rename workspace",
        copyPath: "Copy workspace path",
        copyBranchName: "Copy branch name",
        pin: "Pin to top",
        unpin: "Unpin",
        showSetup: "Show setup",
        toggleRightSidebar: "Toggle right sidebar",
        toggleFocusMode: "Toggle focus mode",
      },
      icons: {},
      shortcuts: {},
      capabilities: {
        canSplitPanes: true,
        canOpenBrowserTabs: true,
        canPin: false,
        canShowSetup: false,
      },
      currentBranch: null,
      isPinned: false,
      dispatch: (action) => dispatched.push(action),
      runGitAction: (action) => runGitActions.push(action),
      copyPath: () => {
        counters.copiedPaths += 1;
      },
      copyBranchName: () => {
        counters.copiedBranchNames += 1;
      },
    },
    runGitActions,
    dispatched,
    get copiedPaths() {
      return counters.copiedPaths;
    },
    get copiedBranchNames() {
      return counters.copiedBranchNames;
    },
  };
}

describe("workspace command center contributions", () => {
  it("makes only the policy-selected primary Git action default-visible and runs it", () => {
    const primary = gitAction("commit", "Commit");
    const fixture = source({
      primary,
      secondary: [gitAction("push", "Push")],
      menu: [],
    });

    const contributions = buildWorkspaceCommandCenterContributions(fixture.value);
    const gitContributions = contributions.filter((item) => item.id.startsWith("git:"));
    const defaultGitContributions = gitContributions.filter((item) => item.visibility === "always");

    expect(defaultGitContributions.map((item) => item.id)).toEqual(["git:commit"]);
    defaultGitContributions[0].run();
    expect(fixture.runGitActions).toEqual([primary]);
  });

  it("does not duplicate a primary action retained in the secondary policy list", () => {
    const primary = gitAction("pull", "Pull");
    const fixture = source({
      primary,
      secondary: [primary, gitAction("push", "Push")],
      menu: [],
    });

    const contributions = buildWorkspaceCommandCenterContributions(fixture.value);

    expect(contributions.filter((item) => item.id === "git:pull")).toHaveLength(1);
  });

  it("orders New agent before Git and keeps terminal, browser, and splits search-only", () => {
    const fixture = source({
      primary: gitAction("commit", "Commit"),
      secondary: [],
      menu: [],
    });

    const contributions = buildWorkspaceCommandCenterContributions(fixture.value);

    expect(
      contributions
        .filter((item) => !ALWAYS_APPENDED.includes(item.id))
        .map(({ id, rank, visibility }) => ({ id, rank, visibility })),
    ).toEqual([
      { id: "tab:new-agent", rank: 0, visibility: "always" },
      { id: "git:commit", rank: 1, visibility: "always" },
      { id: "tab:new-terminal", rank: 2, visibility: "query" },
      { id: "tab:new-browser", rank: 3, visibility: "query" },
      { id: "pane:split-right", rank: 4, visibility: "query" },
      { id: "pane:split-down", rank: 5, visibility: "query" },
    ]);
  });

  it("omits browser and split actions when their existing capabilities are unavailable", () => {
    const fixture = source({ primary: null, secondary: [], menu: [] });
    fixture.value.capabilities = {
      canSplitPanes: false,
      canOpenBrowserTabs: false,
      canPin: false,
      canShowSetup: false,
    };

    const contributions = buildWorkspaceCommandCenterContributions(fixture.value);

    expect(contributions.map((item) => item.id)).toEqual([
      "tab:new-agent",
      "tab:new-terminal",
      ...ALWAYS_APPENDED,
    ]);
  });

  it("dispatches every tab and pane command to the workspace scope", () => {
    const fixture = source({ primary: null, secondary: [], menu: [] });
    const contributions = buildWorkspaceCommandCenterContributions(fixture.value);

    for (const contribution of contributions) contribution.run();

    expect(fixture.dispatched).toEqual([
      { id: "workspace.tab.new", scope: "workspace" },
      { id: "workspace.terminal.new", scope: "workspace" },
      { id: "workspace.browser.new", scope: "workspace" },
      { id: "workspace.pane.split.right", scope: "workspace" },
      { id: "workspace.pane.split.down", scope: "workspace" },
      { id: "workspace.rename", scope: "workspace" },
      { id: "sidebar.toggle.right", scope: "sidebar" },
      { id: "workspace.focus.toggle", scope: "workspace" },
    ]);
  });

  it("keeps workspace creation commands available outside Git", () => {
    const fixture = source({ primary: null, secondary: [], menu: [] });

    const contributions = buildWorkspaceCommandCenterContributions(fixture.value);

    expect(contributions.map((item) => item.id)).toEqual([
      "tab:new-agent",
      "tab:new-terminal",
      "tab:new-browser",
      "pane:split-right",
      "pane:split-down",
      ...ALWAYS_APPENDED,
    ]);
    expect(contributions.some((item) => item.id.startsWith("git:"))).toBe(false);
  });

  it("dispatches rename to the workspace scope", () => {
    const fixture = source({ primary: null, secondary: [], menu: [] });
    const contributions = buildWorkspaceCommandCenterContributions(fixture.value);

    const rename = contributions.find((item) => item.id === "workspace:rename");
    expect(rename?.presentation).toMatchObject({ title: "Rename workspace" });
    rename?.run();

    expect(fixture.dispatched).toEqual([{ id: "workspace.rename", scope: "workspace" }]);
  });

  it("copies the workspace path without going through the dispatcher", () => {
    const fixture = source({ primary: null, secondary: [], menu: [] });
    const contributions = buildWorkspaceCommandCenterContributions(fixture.value);

    contributions.find((item) => item.id === "workspace:copy-path")?.run();

    expect(fixture.copiedPaths).toBe(1);
    expect(fixture.dispatched).toEqual([]);
  });

  it("omits Copy branch name when the workspace has no branch, and copies when it does", () => {
    const withoutBranch = source({ primary: null, secondary: [], menu: [] });
    expect(
      buildWorkspaceCommandCenterContributions(withoutBranch.value).some(
        (item) => item.id === "workspace:copy-branch-name",
      ),
    ).toBe(false);

    const withBranch = source({ primary: null, secondary: [], menu: [] });
    withBranch.value.currentBranch = "feature/login";
    const contribution = buildWorkspaceCommandCenterContributions(withBranch.value).find(
      (item) => item.id === "workspace:copy-branch-name",
    );

    expect(contribution?.keywords).toContain("feature/login");
    contribution?.run();
    expect(withBranch.copiedBranchNames).toBe(1);
  });

  it("flips the pin label on pinned state and omits the entry when the host cannot pin", () => {
    const unpinned = source({ primary: null, secondary: [], menu: [] });
    unpinned.value.capabilities.canPin = true;
    const pinContribution = buildWorkspaceCommandCenterContributions(unpinned.value).find(
      (item) => item.id === "workspace:pin",
    );
    expect(pinContribution?.presentation).toMatchObject({ title: "Pin to top" });
    expect(pinContribution?.visibility).toBe("always");
    pinContribution?.run();
    expect(unpinned.dispatched).toEqual([{ id: "workspace.pin", scope: "sidebar" }]);

    const pinned = source({ primary: null, secondary: [], menu: [] });
    pinned.value.capabilities.canPin = true;
    pinned.value.isPinned = true;
    expect(
      buildWorkspaceCommandCenterContributions(pinned.value).find(
        (item) => item.id === "workspace:pin",
      )?.presentation,
    ).toMatchObject({ title: "Unpin" });

    const unsupported = source({ primary: null, secondary: [], menu: [] });
    expect(
      buildWorkspaceCommandCenterContributions(unsupported.value).some(
        (item) => item.id === "workspace:pin",
      ),
    ).toBe(false);
  });

  it("lists Show setup only when the workspace has setup to show", () => {
    const withoutSetup = source({ primary: null, secondary: [], menu: [] });
    expect(
      buildWorkspaceCommandCenterContributions(withoutSetup.value).some(
        (item) => item.id === "workspace:show-setup",
      ),
    ).toBe(false);

    const withSetup = source({ primary: null, secondary: [], menu: [] });
    withSetup.value.capabilities.canShowSetup = true;
    buildWorkspaceCommandCenterContributions(withSetup.value)
      .find((item) => item.id === "workspace:show-setup")
      ?.run();

    expect(withSetup.dispatched).toEqual([{ id: "workspace.setup.show", scope: "workspace" }]);
  });

  // Regression guard for the registration split: these two are handled only by workspace-screen.tsx
  // behind `enabled: isRouteFocused && ...`, so they must be built here rather than in the global
  // root set, where they would silently no-op off a workspace route.
  it("builds the right sidebar and focus toggles in the workspace set", () => {
    const fixture = source({ primary: null, secondary: [], menu: [] });
    const contributions = buildWorkspaceCommandCenterContributions(fixture.value);

    contributions.find((item) => item.id === "workspace:toggle-right-sidebar")?.run();
    contributions.find((item) => item.id === "workspace:toggle-focus-mode")?.run();

    expect(fixture.dispatched).toEqual([
      { id: "sidebar.toggle.right", scope: "sidebar" },
      { id: "workspace.focus.toggle", scope: "workspace" },
    ]);
    for (const contribution of contributions) {
      expect(contribution.group).toBe("workspace");
    }
  });
});

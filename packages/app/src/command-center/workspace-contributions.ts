import type { GitAction, GitActions } from "@/git/policy";
import type { KeyboardActionDefinition } from "@/keyboard/keyboard-action-dispatcher";
import type { ShortcutKey } from "@/utils/format-shortcut";
import type { CommandCenterContribution, CommandCenterIcon } from "./contributions";

export interface WorkspaceCommandCenterLabels {
  section: string;
  newAgent: string;
  newTerminal: string;
  newBrowser: string;
  splitRight: string;
  splitDown: string;
  rename: string;
  copyPath: string;
  copyBranchName: string;
  pin: string;
  unpin: string;
  showSetup: string;
  toggleRightSidebar: string;
  toggleFocusMode: string;
}

export interface WorkspaceCommandCenterIcons {
  newAgent?: CommandCenterIcon;
  newTerminal?: CommandCenterIcon;
  newBrowser?: CommandCenterIcon;
  splitRight?: CommandCenterIcon;
  splitDown?: CommandCenterIcon;
  rename?: CommandCenterIcon;
  copyPath?: CommandCenterIcon;
  copyBranchName?: CommandCenterIcon;
  pin?: CommandCenterIcon;
  unpin?: CommandCenterIcon;
  showSetup?: CommandCenterIcon;
  toggleRightSidebar?: CommandCenterIcon;
  toggleFocusMode?: CommandCenterIcon;
  git?(action: GitAction): CommandCenterIcon | undefined;
}

export interface WorkspaceCommandCenterShortcuts {
  newAgent?: ShortcutKey[][];
  newTerminal?: ShortcutKey[][];
  splitRight?: ShortcutKey[][];
  splitDown?: ShortcutKey[][];
  archiveWorkspace?: ShortcutKey[][];
  pinWorkspace?: ShortcutKey[][];
  toggleRightSidebar?: ShortcutKey[][];
  toggleFocusMode?: ShortcutKey[][];
}

export interface WorkspaceCommandCenterSource {
  gitActions: GitActions;
  labels: WorkspaceCommandCenterLabels;
  icons: WorkspaceCommandCenterIcons;
  shortcuts: WorkspaceCommandCenterShortcuts;
  capabilities: {
    canSplitPanes: boolean;
    canOpenBrowserTabs: boolean;
    /** Host supports the `workspacePinning` feature. */
    canPin: boolean;
    /** The workspace has setup commands or a setup error — same gate as the header menu. */
    canShowSetup: boolean;
  };
  /** Null on a non-git workspace, or before gitRuntime resolves. Omits Copy branch name. */
  currentBranch: string | null;
  isPinned: boolean;
  dispatch(action: KeyboardActionDefinition): void;
  runGitAction(action: GitAction): void;
  copyPath(): void;
  copyBranchName(): void;
}

function buildGitContribution(
  source: WorkspaceCommandCenterSource,
  action: GitAction,
  rank: number,
  visibility: "always" | "query",
): CommandCenterContribution {
  return {
    id: `git:${action.id}`,
    group: "workspace",
    groupRank: -1,
    rank,
    keywords: [action.id, "git"],
    visibility,
    run: () => source.runGitAction(action),
    presentation: {
      kind: "action",
      title: action.label,
      sectionTitle: source.labels.section,
      icon: source.icons.git?.(action),
      shortcutKeys:
        action.id === "archive-workspace" ? source.shortcuts.archiveWorkspace : undefined,
    },
  };
}

function buildWorkspaceAction(input: {
  source: WorkspaceCommandCenterSource;
  id: string;
  rank: number;
  title: string;
  keywords: readonly string[];
  icon?: CommandCenterIcon;
  shortcutKeys?: ShortcutKey[][];
  action: KeyboardActionDefinition;
  visibility: "always" | "query";
}): CommandCenterContribution {
  return {
    id: input.id,
    group: "workspace",
    groupRank: -1,
    rank: input.rank,
    keywords: input.keywords,
    visibility: input.visibility,
    run: () => input.source.dispatch(input.action),
    presentation: {
      kind: "action",
      title: input.title,
      sectionTitle: input.source.labels.section,
      icon: input.icon,
      shortcutKeys: input.shortcutKeys,
    },
  };
}

function buildWorkspaceCallback(input: {
  source: WorkspaceCommandCenterSource;
  id: string;
  rank: number;
  title: string;
  keywords: readonly string[];
  icon?: CommandCenterIcon;
  shortcutKeys?: ShortcutKey[][];
  run: () => void;
  visibility: "always" | "query";
}): CommandCenterContribution {
  return {
    id: input.id,
    group: "workspace",
    groupRank: -1,
    rank: input.rank,
    keywords: input.keywords,
    visibility: input.visibility,
    run: input.run,
    presentation: {
      kind: "action",
      title: input.title,
      sectionTitle: input.source.labels.section,
      icon: input.icon,
      shortcutKeys: input.shortcutKeys,
    },
  };
}

export function buildWorkspaceCommandCenterContributions(
  source: WorkspaceCommandCenterSource,
): CommandCenterContribution[] {
  const contributions: CommandCenterContribution[] = [
    buildWorkspaceAction({
      source,
      id: "tab:new-agent",
      rank: 0,
      title: source.labels.newAgent,
      keywords: ["tab", "new", "agent", "chat"],
      icon: source.icons.newAgent,
      shortcutKeys: source.shortcuts.newAgent,
      action: { id: "workspace.tab.new", scope: "workspace" },
      visibility: "always",
    }),
  ];
  const primary = source.gitActions.primary;
  if (primary) contributions.push(buildGitContribution(source, primary, 1, "always"));
  contributions.push(
    buildWorkspaceAction({
      source,
      id: "tab:new-terminal",
      rank: 2,
      title: source.labels.newTerminal,
      keywords: ["terminal", "shell", "console"],
      icon: source.icons.newTerminal,
      shortcutKeys: source.shortcuts.newTerminal,
      action: { id: "workspace.terminal.new", scope: "workspace" },
      visibility: "query",
    }),
  );
  if (source.capabilities.canOpenBrowserTabs) {
    contributions.push(
      buildWorkspaceAction({
        source,
        id: "tab:new-browser",
        rank: 3,
        title: source.labels.newBrowser,
        keywords: ["browser", "web", "preview"],
        icon: source.icons.newBrowser,
        action: { id: "workspace.browser.new", scope: "workspace" },
        visibility: "query",
      }),
    );
  }
  if (source.capabilities.canSplitPanes) {
    contributions.push(
      buildWorkspaceAction({
        source,
        id: "pane:split-right",
        rank: 4,
        title: source.labels.splitRight,
        keywords: ["split", "pane", "vertical"],
        icon: source.icons.splitRight,
        shortcutKeys: source.shortcuts.splitRight,
        action: { id: "workspace.pane.split.right", scope: "workspace" },
        visibility: "query",
      }),
      buildWorkspaceAction({
        source,
        id: "pane:split-down",
        rank: 5,
        title: source.labels.splitDown,
        keywords: ["split", "pane", "horizontal"],
        icon: source.icons.splitDown,
        shortcutKeys: source.shortcuts.splitDown,
        action: { id: "workspace.pane.split.down", scope: "workspace" },
        visibility: "query",
      }),
    );
  }
  for (const [index, action] of source.gitActions.secondary.entries()) {
    if (action.id === primary?.id) continue;
    contributions.push(buildGitContribution(source, action, 10 + index, "query"));
  }

  if (source.capabilities.canPin) {
    contributions.push(
      buildWorkspaceAction({
        source,
        id: "workspace:pin",
        rank: 20,
        title: source.isPinned ? source.labels.unpin : source.labels.pin,
        keywords: ["pin", "unpin", "favorite", "sticky"],
        icon: source.isPinned ? source.icons.unpin : source.icons.pin,
        shortcutKeys: source.shortcuts.pinWorkspace,
        action: { id: "workspace.pin", scope: "sidebar" },
        visibility: "always",
      }),
    );
  }

  contributions.push(
    buildWorkspaceAction({
      source,
      id: "workspace:rename",
      rank: 21,
      title: source.labels.rename,
      keywords: ["rename", "title", "name", "label"],
      icon: source.icons.rename,
      action: { id: "workspace.rename", scope: "workspace" },
      visibility: "query",
    }),
    buildWorkspaceCallback({
      source,
      id: "workspace:copy-path",
      rank: 22,
      title: source.labels.copyPath,
      keywords: ["copy", "path", "directory", "folder", "cwd"],
      icon: source.icons.copyPath,
      run: source.copyPath,
      visibility: "query",
    }),
  );

  // Omitted rather than present-and-failing: a non-git workspace has nothing to copy.
  if (source.currentBranch) {
    contributions.push(
      buildWorkspaceCallback({
        source,
        id: "workspace:copy-branch-name",
        rank: 23,
        title: source.labels.copyBranchName,
        keywords: ["copy", "branch", "git", source.currentBranch],
        icon: source.icons.copyBranchName,
        run: source.copyBranchName,
        visibility: "query",
      }),
    );
  }

  if (source.capabilities.canShowSetup) {
    contributions.push(
      buildWorkspaceAction({
        source,
        id: "workspace:show-setup",
        rank: 24,
        title: source.labels.showSetup,
        keywords: ["setup", "provision", "install", "bootstrap"],
        icon: source.icons.showSetup,
        action: { id: "workspace.setup.show", scope: "workspace" },
        visibility: "query",
      }),
    );
  }

  // Toggle right sidebar and Toggle focus mode belong here, NOT in root-registration.tsx: their
  // handlers live in workspace-screen.tsx behind `enabled: isRouteFocused && ...`, so a global
  // registration would list two entries that silently no-op on /settings, /sessions, /schedules
  // and Home. Toggle left sidebar is global and stays in the root set — that is why the three
  // toggles render in two non-adjacent sections. Don't "tidy" them back together.
  contributions.push(
    buildWorkspaceAction({
      source,
      id: "workspace:toggle-right-sidebar",
      rank: 25,
      title: source.labels.toggleRightSidebar,
      keywords: ["toggle", "sidebar", "right", "panel", "inspector"],
      icon: source.icons.toggleRightSidebar,
      shortcutKeys: source.shortcuts.toggleRightSidebar,
      action: { id: "sidebar.toggle.right", scope: "sidebar" },
      visibility: "query",
    }),
    buildWorkspaceAction({
      source,
      id: "workspace:toggle-focus-mode",
      rank: 26,
      title: source.labels.toggleFocusMode,
      keywords: ["toggle", "focus", "zen", "distraction", "fullscreen"],
      icon: source.icons.toggleFocusMode,
      shortcutKeys: source.shortcuts.toggleFocusMode,
      action: { id: "workspace.focus.toggle", scope: "workspace" },
      visibility: "query",
    }),
  );

  return contributions;
}

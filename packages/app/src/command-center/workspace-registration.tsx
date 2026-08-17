import { useCallback, useMemo, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import {
  Columns2,
  Copy,
  Focus,
  GitBranch,
  Globe,
  ListChecks,
  PanelRight,
  Pencil,
  Pin,
  PinOff,
  Rows2,
  SquarePen,
  SquareTerminal,
} from "lucide-react-native";
import { getIsElectron } from "@/constants/platform";
import { supportsDesktopPaneSplits, useIsCompactFormFactor } from "@/constants/layout";
import { GIT_ACTION_ICONS } from "@/git/action-icons";
import { useGitActionRunner, useGitActions } from "@/git/use-actions";
import { useKeyboardShortcutOverrides } from "@/hooks/use-keyboard-shortcut-overrides";
import { useWorkspaceClipboardActions } from "@/hooks/use-workspace-clipboard-actions";
import {
  resolveShortcutKeysForAction,
  type ShortcutOverrides,
} from "@/keyboard/keyboard-shortcuts";
import { keyboardActionDispatcher } from "@/keyboard/keyboard-action-dispatcher";
import { useHostFeature } from "@/runtime/host-features";
import { useActiveWorkspaceSelection } from "@/stores/navigation-active-workspace-store";
import { useWorkspaceFields } from "@/stores/session-store-hooks";
import { shouldShowWorkspaceSetup, useWorkspaceSetupStore } from "@/stores/workspace-setup-store";
import { clearCommandCenterFocusRestoreElement } from "@/utils/command-center-focus-restore";
import { getShortcutOs } from "@/utils/shortcut-platform";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";
import { getCommandCenterIcon } from "./icon";
import type { CommandCenterIcon } from "./contributions";
import { useCommandCenterActions } from "./provider";
import {
  buildWorkspaceCommandCenterContributions,
  type WorkspaceCommandCenterShortcuts,
} from "./workspace-contributions";

const WORKSPACE_COMMAND_CENTER_ICONS = {
  newAgent: getCommandCenterIcon(SquarePen),
  newTerminal: getCommandCenterIcon(SquareTerminal),
  newBrowser: getCommandCenterIcon(Globe),
  splitRight: getCommandCenterIcon(Columns2),
  splitDown: getCommandCenterIcon(Rows2),
  rename: getCommandCenterIcon(Pencil),
  copyPath: getCommandCenterIcon(Copy),
  copyBranchName: getCommandCenterIcon(GitBranch),
  pin: getCommandCenterIcon(Pin),
  unpin: getCommandCenterIcon(PinOff),
  showSetup: getCommandCenterIcon(ListChecks),
  toggleRightSidebar: getCommandCenterIcon(PanelRight),
  toggleFocusMode: getCommandCenterIcon(Focus),
};

function staticIcon(element: ReactElement | undefined): CommandCenterIcon | undefined {
  if (!element) return undefined;
  function StaticIcon() {
    return element;
  }
  return StaticIcon;
}

function resolveWorkspaceShortcuts(overrides: ShortcutOverrides): WorkspaceCommandCenterShortcuts {
  const platform = { isMac: getShortcutOs() === "mac", isDesktop: getIsElectron() };
  return {
    newAgent: resolveShortcutKeysForAction("workspace-tab-new", overrides, platform) ?? undefined,
    newTerminal:
      resolveShortcutKeysForAction("workspace-terminal-new", overrides, platform) ?? undefined,
    splitRight:
      resolveShortcutKeysForAction("workspace-pane-split-right", overrides, platform) ?? undefined,
    splitDown:
      resolveShortcutKeysForAction("workspace-pane-split-down", overrides, platform) ?? undefined,
    archiveWorkspace:
      resolveShortcutKeysForAction("archive-workspace", overrides, platform) ?? undefined,
    pinWorkspace: resolveShortcutKeysForAction("pin-workspace", overrides, platform) ?? undefined,
    toggleRightSidebar:
      resolveShortcutKeysForAction("toggle-right-sidebar", overrides, platform) ?? undefined,
    toggleFocusMode: resolveShortcutKeysForAction("toggle-focus", overrides, platform) ?? undefined,
  };
}

export function useWorkspaceCommandCenterActions(): void {
  const { t } = useTranslation();
  const selection = useActiveWorkspaceSelection();
  const serverId = selection?.serverId ?? null;
  const workspaceId = selection?.workspaceId ?? null;
  // One narrow projection for the whole contribution set. The registry's snapshot dedup is
  // unreachable (registry.ts spreads a fresh object per contribution, then compares by reference),
  // so the array-identity guard in registry.replace() is the only thing stopping a re-render —
  // a churny subscription here rebuilds the list while the user is looking at it.
  const fields = useWorkspaceFields(serverId, workspaceId, (workspace) => ({
    id: workspace.id,
    workspaceDirectory: workspace.workspaceDirectory ?? null,
    currentBranch: workspace.gitRuntime?.currentBranch ?? null,
    pinnedAt: workspace.pinnedAt ?? null,
  }));
  const cwd = fields?.workspaceDirectory ?? null;
  const currentBranch = fields?.currentBranch ?? null;
  const isPinned = fields?.pinnedAt != null;
  const isCompact = useIsCompactFormFactor();
  const canPin = useHostFeature(serverId, "workspacePinning");
  const persistenceKey =
    serverId && fields
      ? buildWorkspaceTabPersistenceKey({ serverId, workspaceId: fields.id })
      : null;
  const canShowSetup = useWorkspaceSetupStore((state) =>
    shouldShowWorkspaceSetup(persistenceKey ? (state.snapshots[persistenceKey] ?? null) : null),
  );
  const { overrides } = useKeyboardShortcutOverrides();
  const { gitActions } = useGitActions({
    serverId: serverId ?? "",
    cwd: cwd ?? "",
    icons: GIT_ACTION_ICONS,
  });
  const runGitAction = useGitActionRunner();
  const clipboard = useWorkspaceClipboardActions();

  const copyPath = useCallback(() => {
    if (!fields) return;
    clipboard.copyPath({
      workspaceId: fields.id,
      workspaceDirectory: fields.workspaceDirectory,
      currentBranch: fields.currentBranch,
    });
  }, [clipboard, fields]);

  const copyBranchName = useCallback(() => {
    if (!fields) return;
    clipboard.copyBranchName({
      workspaceId: fields.id,
      workspaceDirectory: fields.workspaceDirectory,
      currentBranch: fields.currentBranch,
    });
  }, [clipboard, fields]);

  const actions = useMemo(
    () =>
      buildWorkspaceCommandCenterContributions({
        gitActions,
        labels: {
          section: t("workspace.header.actions.workspaceActions"),
          newAgent: t("workspace.tabs.actions.newAgent"),
          newTerminal: t("workspace.tabs.actions.newTerminal"),
          newBrowser: t("workspace.tabs.actions.newBrowser"),
          splitRight: t("workspace.tabs.actions.splitRight"),
          splitDown: t("workspace.tabs.actions.splitDown"),
          rename: t("sidebar.workspace.actions.rename"),
          copyPath: t("workspace.header.actions.copyPath"),
          copyBranchName: t("workspace.header.actions.copyBranchName"),
          pin: t("sidebar.workspace.actions.pin"),
          unpin: t("sidebar.workspace.actions.unpin"),
          showSetup: t("workspace.header.actions.showSetup"),
          toggleRightSidebar: t("settings.shortcuts.help.toggleRightSidebar"),
          toggleFocusMode: t("settings.shortcuts.help.toggleFocusMode"),
        },
        icons: {
          ...WORKSPACE_COMMAND_CENTER_ICONS,
          git: (action) => staticIcon(action.icon),
        },
        shortcuts: resolveWorkspaceShortcuts(overrides),
        capabilities: {
          canSplitPanes: supportsDesktopPaneSplits() && !isCompact,
          canOpenBrowserTabs: getIsElectron(),
          canPin,
          canShowSetup,
        },
        currentBranch,
        isPinned,
        dispatch: (action) => {
          clearCommandCenterFocusRestoreElement();
          keyboardActionDispatcher.dispatch(action);
        },
        runGitAction,
        copyPath,
        copyBranchName,
      }),
    [
      canPin,
      canShowSetup,
      copyBranchName,
      copyPath,
      currentBranch,
      gitActions,
      isCompact,
      isPinned,
      overrides,
      runGitAction,
      t,
    ],
  );

  useCommandCenterActions({
    sourceId: "workspace",
    enabled: Boolean(serverId && cwd),
    actions,
  });
}

export function CommandCenterWorkspaceActions() {
  useWorkspaceCommandCenterActions();
  return null;
}

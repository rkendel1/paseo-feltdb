import { describe, expect, test, vi } from "vitest";
import { openWorkspaceFileFromExplorer } from "./workspace-file-open-command";
import { FOCUSED_PANE_PLACEMENT } from "@/stores/workspace-layout-store";

describe("openWorkspaceFileFromExplorer", () => {
  test("opens a search match with its target line", () => {
    const showMobileAgent = vi.fn();
    const openWorkspaceTabInFocusedPane = vi.fn(() => "tab-file");
    const focusWorkspaceTab = vi.fn();

    openWorkspaceFileFromExplorer({
      filePath: "src/search.ts",
      lineStart: 42,
      lineEnd: 42,
      persistenceKey: "server:workspace",
      showMobileAgent,
      openWorkspaceTabInFocusedPane,
      focusWorkspaceTab,
    });

    expect(showMobileAgent).toHaveBeenCalledTimes(1);
    expect(openWorkspaceTabInFocusedPane).toHaveBeenCalledWith(
      "server:workspace",
      {
        kind: "file",
        path: "src/search.ts",
        lineStart: 42,
        lineEnd: 42,
      },
      FOCUSED_PANE_PLACEMENT,
    );
    expect(focusWorkspaceTab).toHaveBeenCalledWith("server:workspace", "tab-file");
  });
});

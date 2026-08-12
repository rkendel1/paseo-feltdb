/**
 * Does the Changes explorer hand diffs to the workspace tab instead of rendering them inline?
 *
 * Single source of truth for two decisions that must never disagree:
 *   1. a changed-file press focuses/opens the Changes tab instead of expanding inline
 *   2. the sidebar hides its inline-expansion controls (expand-all, unified/split)
 *
 * Deliberately NOT used by the review-attachment publish in diff-pane.tsx. That one stays
 * keyed on `changesTabOpen` alone, because the tab panel only publishes while it is mounted
 * and active (panels/diff-panel.tsx). Keying it here would leave "preference on, tab closed"
 * with no publisher at all, and the composer would silently lose the changes attachment.
 *
 *   isMobile / !canOpenTab / !layoutHydrated / !preferencesLoaded
 *                       │
 *                       ▼
 *              inline expansion (today's behavior)
 *                       │
 *   changesTabOpen ─────┴──── alwaysOpenInTab
 *                       │
 *                       ▼
 *                  Changes tab
 */
export function shouldRouteDiffsToChangesTab(input: {
  /** Compact layouts keep #2298's sidebar-only behavior. */
  isMobile: boolean;
  /** False when the workspace has no tab persistence key, so no tab can ever open. */
  canOpenTab: boolean;
  /** Opening a tab before the layout store rehydrates loses it to the rehydrated state. */
  layoutHydrated: boolean;
  /** Deciding from a default that is about to change would retract a diff the user just opened. */
  preferencesLoaded: boolean;
  changesTabOpen: boolean;
  alwaysOpenInTab: boolean;
}): boolean {
  if (!input.canOpenTab || input.isMobile || !input.layoutHydrated || !input.preferencesLoaded) {
    return false;
  }
  return input.changesTabOpen || input.alwaysOpenInTab;
}

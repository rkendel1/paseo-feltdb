import { describe, expect, it } from "vitest";
import { shouldRouteDiffsToChangesTab } from "./changes-tab-navigation";

const READY = {
  isMobile: false,
  canOpenTab: true,
  layoutHydrated: true,
  preferencesLoaded: true,
  changesTabOpen: false,
  alwaysOpenInTab: false,
} as const;

describe("shouldRouteDiffsToChangesTab", () => {
  it("expands inline when neither the tab nor the preference asks for it", () => {
    expect(shouldRouteDiffsToChangesTab(READY)).toBe(false);
  });

  it("routes to the tab while a Changes tab is open", () => {
    expect(shouldRouteDiffsToChangesTab({ ...READY, changesTabOpen: true })).toBe(true);
  });

  it("routes to the tab with the preference on and no tab open yet", () => {
    expect(shouldRouteDiffsToChangesTab({ ...READY, alwaysOpenInTab: true })).toBe(true);
  });

  it("keeps compact layouts on inline expansion", () => {
    expect(shouldRouteDiffsToChangesTab({ ...READY, isMobile: true, alwaysOpenInTab: true })).toBe(
      false,
    );
  });

  it("keeps inline expansion when no tab can be opened", () => {
    expect(
      shouldRouteDiffsToChangesTab({ ...READY, canOpenTab: false, alwaysOpenInTab: true }),
    ).toBe(false);
  });

  it("keeps inline expansion until the layout store has hydrated", () => {
    expect(
      shouldRouteDiffsToChangesTab({ ...READY, layoutHydrated: false, alwaysOpenInTab: true }),
    ).toBe(false);
  });

  it("keeps inline expansion until preferences have loaded", () => {
    expect(
      shouldRouteDiffsToChangesTab({ ...READY, preferencesLoaded: false, alwaysOpenInTab: true }),
    ).toBe(false);
  });

  it("ignores an already-open tab while the guards are unmet", () => {
    expect(
      shouldRouteDiffsToChangesTab({ ...READY, layoutHydrated: false, changesTabOpen: true }),
    ).toBe(false);
  });
});

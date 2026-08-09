/**
 * @vitest-environment jsdom
 */
import React, { act, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatTimeAgo } from "@/utils/time";

vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

const MINUTE = 60_000;
let appVisible = true;
const visibilityListeners = new Set<() => void>();

vi.mock("@/hooks/use-app-visible", () => ({
  useAppVisible: () =>
    useSyncExternalStore(
      (listener) => {
        visibilityListeners.add(listener);
        return () => visibilityListeners.delete(listener);
      },
      () => appVisible,
      () => appVisible,
    ),
}));

function setAppVisible(visible: boolean): void {
  appVisible = visible;
  for (const listener of visibilityListeners) listener();
}

// Every case re-imports the module so the shared interval and cached minute
// start clean; the tick state is module-level by design.
async function loadHook(): Promise<() => number> {
  vi.resetModules();
  const module = await import("./use-minute-tick");
  return module.useMinuteTick;
}

interface Probe {
  mount(): void;
  unmount(): void;
  readonly minute: number | null;
  readonly text: string;
}

function createProbe(useMinuteTick: () => number, timestamp?: Date): Probe {
  const container = document.createElement("div");
  document.body.appendChild(container);
  let root: Root | null = null;
  let minute: number | null = null;

  function Probe() {
    minute = useMinuteTick();
    return timestamp ? <span>{formatTimeAgo(timestamp)}</span> : null;
  }

  return {
    mount() {
      root = createRoot(container);
      act(() => root?.render(<Probe />));
    },
    unmount() {
      act(() => root?.unmount());
      root = null;
      container.remove();
    },
    get minute() {
      return minute;
    },
    get text() {
      return container.textContent ?? "";
    },
  };
}

describe("useMinuteTick", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-16T12:00:00.000Z"));
    appVisible = true;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("updates a visible relative timestamp when the minute rolls over", async () => {
    const useMinuteTick = await loadHook();
    const probe = createProbe(useMinuteTick, new Date("2026-07-16T11:59:00.000Z"));
    probe.mount();
    expect(probe.text).toBe("1m ago");

    act(() => void vi.advanceTimersByTime(MINUTE));
    expect(probe.text).toBe("2m ago");

    probe.unmount();
  });

  it("keeps one interval for many subscribers and stops it when the last unmounts", async () => {
    const useMinuteTick = await loadHook();
    const first = createProbe(useMinuteTick);
    const second = createProbe(useMinuteTick);

    first.mount();
    const withOne = vi.getTimerCount();
    second.mount();
    expect(vi.getTimerCount()).toBe(withOne);

    first.unmount();
    expect(vi.getTimerCount()).toBe(withOne);

    second.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops ticking while hidden and catches the timestamp up when visible again", async () => {
    const useMinuteTick = await loadHook();
    const probe = createProbe(useMinuteTick, new Date("2026-07-16T11:59:00.000Z"));
    probe.mount();
    expect(probe.text).toBe("1m ago");

    act(() => setAppVisible(false));
    expect(vi.getTimerCount()).toBe(0);

    act(() => void vi.advanceTimersByTime(5 * MINUTE));
    expect(probe.text).toBe("1m ago");

    act(() => setAppVisible(true));
    expect(probe.text).toBe("6m ago");

    probe.unmount();
  });

  it("serves a fresh minute to a subscriber that arrives after the ticker stopped", async () => {
    const useMinuteTick = await loadHook();
    const first = createProbe(useMinuteTick);
    first.mount();
    const startMinute = first.minute;
    first.unmount();

    // Nothing is subscribed here, so the cached minute goes stale.
    act(() => void vi.advanceTimersByTime(5 * MINUTE));

    const second = createProbe(useMinuteTick);
    second.mount();
    expect(second.minute).toBe((startMinute ?? 0) + 5);

    second.unmount();
  });
});

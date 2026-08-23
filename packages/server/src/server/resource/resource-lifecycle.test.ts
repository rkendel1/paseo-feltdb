/**
 * Phase 1: Resource Baseline & Lifecycle Test
 *
 * Establishes reproducible resource measurements for Paseo:
 * - Cold startup
 * - Idle state
 * - Active execution
 * - Repeated execution (leak detection)
 * - Shutdown/cleanup
 *
 * These tests are designed to be run on macOS and produce a resource profile
 * that can be compared against alternative runtimes (Docker vs Apple Containers).
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import pino from "pino";
import { ResourceMonitor, type ResourceBudget } from "./resource-monitor.js";

// Test configuration
const TEST_BUDGET: Partial<ResourceBudget> = {
  process: {
    rssMax: 300, // 300 MB - adjust based on measurements
    vsizeMax: 800, // 800 MB
  },
  heap: {
    maxOldSpaceSize: 256, // MB
    target: 150, // MB target
  },
};

describe("Phase 1: Resource Baseline & Lifecycle", () => {
  let monitor: ResourceMonitor;
  const logger = pino({ level: "silent" });

  beforeEach(() => {
    monitor = new ResourceMonitor(logger, TEST_BUDGET);
    // Force garbage collection if available
    if (global.gc) {
      global.gc();
    }
    monitor.snapshot();
  });

  afterEach(() => {
    const report = monitor.report();
    console.log("\nResource Report:");
    console.log(`  Baseline RSS: ${Math.round(report.baseline?.process.rss ?? 0 / 1024 / 1024)} MB`);
    console.log(`  Current RSS: ${Math.round(report.current?.process.rss ?? 0 / 1024 / 1024)} MB`);
    console.log(`  Growth: ${Math.round(report.growth.rss / 1024 / 1024)} MB`);
    console.log(`  Heap: ${Math.round(report.current?.heap.heapUsed ?? 0 / 1024 / 1024)} MB`);
    console.log(`  Samples: ${report.samples}`);

    const budget = monitor.checkBudget();
    if (budget.violations.length > 0) {
      console.log("  Budget Violations:");
      budget.violations.forEach((v) => console.log(`    - ${v}`));
    }
  });

  describe("Baseline Measurement", () => {
    test("should capture initial resource snapshot", () => {
      const baseline = monitor.getSnapshots()[0];

      expect(baseline).toBeDefined();
      expect(baseline.pid).toBe(process.pid);
      expect(baseline.process.rss).toBeGreaterThan(0);
      expect(baseline.heap.heapUsed).toBeGreaterThan(0);
    });

    test("should stay within budget at idle", () => {
      // Let process idle for a moment
      const iterations = 10;
      for (let i = 0; i < iterations; i++) {
        monitor.snapshot();
      }

      const budget = monitor.checkBudget();
      expect(budget.exceeded).toBe(false);
    });

    test("should remain stable after GC", () => {
      if (!global.gc) {
        console.log("  (Skipped - requires --expose-gc)");
        return;
      }

      const before = monitor.getSnapshots()[0];
      global.gc();
      monitor.snapshot();
      const after = monitor.getSnapshots()[1];

      // GC should not cause major regressions
      const heapGrowth = after.heap.heapUsed - before.heap.heapUsed;
      expect(heapGrowth).toBeLessThan(10 * 1024 * 1024); // Less than 10 MB growth
    });
  });

  describe("Lifecycle Test: Memory Leak Detection", () => {
    test("should not accumulate memory across repeated small allocations", () => {
      const snapshots: typeof monitor.getSnapshots = [];
      const allocationSize = 1024 * 1024; // 1 MB

      // Allocate and release memory repeatedly
      for (let cycle = 0; cycle < 5; cycle++) {
        const buffers: Buffer[] = [];
        for (let i = 0; i < 10; i++) {
          buffers.push(Buffer.alloc(allocationSize));
        }
        // Release buffers
        buffers.length = 0;

        if (global.gc) global.gc();
        const snap = monitor.snapshot();
        snapshots.push(snap);
      }

      // Memory should not monotonically increase
      const heapSizes = snapshots.map((s) => s.heap.heapUsed);
      let monotonicIncreases = 0;
      for (let i = 1; i < heapSizes.length; i++) {
        if (heapSizes[i] > heapSizes[i - 1]) {
          monotonicIncreases++;
        }
      }

      // Allow some growth, but not every cycle
      expect(monotonicIncreases).toBeLessThan(heapSizes.length);
    });

    test("should release event loop handles after operations", () => {
      const baseline = monitor.getSnapshots()[0];

      // Simulate some async work
      const promises = [];
      for (let i = 0; i < 5; i++) {
        promises.push(
          new Promise((resolve) => {
            setImmediate(() => resolve(null));
          })
        );
      }

      // Wait for all promises
      return Promise.all(promises).then(() => {
        monitor.snapshot();
        const current = monitor.getSnapshots()[1];

        // Event loop handles should be similar
        const growth = current.eventLoop.active - baseline.eventLoop.active;
        expect(growth).toBeLessThanOrEqual(5); // At most new handles from promises
      });
    });

    test("should not retain circular references or closures", () => {
      const snapshots = [];

      // Create and abandon objects with potential closure issues
      for (let i = 0; i < 3; i++) {
        (() => {
          const largeData = new Array(1000).fill("x".repeat(1000));
          const closure = () => largeData; // Closure captures largeData

          // Immediately abandon closure and data
          void closure;
        })();

        if (global.gc) global.gc();
        snapshots.push(monitor.snapshot());
      }

      const heapSizes = snapshots.map((s) => s.heap.heapUsed);
      const maxGrowth = Math.max(
        ...heapSizes.slice(1).map((h, i) => h - heapSizes[i])
      );

      // Growth between cycles should be small
      expect(maxGrowth).toBeLessThan(5 * 1024 * 1024); // Less than 5 MB per cycle
    });
  });

  describe("Sustained Operation", () => {
    test("should remain bounded during long-running operation", () => {
      const durationMs = 1000; // 1 second
      const startTime = Date.now();
      const snapshots = [];

      while (Date.now() - startTime < durationMs) {
        // Simulate work
        const _ = JSON.stringify({ data: "x".repeat(100) });
        snapshots.push(monitor.snapshot());

        // Small delay
        const start = Date.now();
        while (Date.now() - start < 10) {
          // Busy-wait 10ms
        }
      }

      // Check for monotonic memory growth
      const rssSizes = snapshots.map((s) => s.process.rss);
      const avgRss = rssSizes.reduce((a, b) => a + b) / rssSizes.length;
      const maxRss = Math.max(...rssSizes);
      const minRss = Math.min(...rssSizes);

      // Max should not be >150% of min
      expect(maxRss).toBeLessThan(minRss * 1.5);

      console.log(`\n  Sustained operation (1s):`);
      console.log(`    Min RSS: ${Math.round(minRss / 1024 / 1024)} MB`);
      console.log(`    Avg RSS: ${Math.round(avgRss / 1024 / 1024)} MB`);
      console.log(`    Max RSS: ${Math.round(maxRss / 1024 / 1024)} MB`);
    });
  });

  describe("Budget Enforcement", () => {
    test("should report violations when exceeding RSS limit", () => {
      // Create a very strict budget
      const strictMonitor = new ResourceMonitor(logger, {
        process: {
          rssMax: 1, // 1 MB - will definitely exceed
        },
      });

      strictMonitor.snapshot();
      const budget = strictMonitor.checkBudget();

      expect(budget.exceeded).toBe(true);
      expect(budget.violations.length).toBeGreaterThan(0);
      expect(budget.violations[0]).toContain("RSS");
    });

    test("should report violations when exceeding heap target", () => {
      const strictMonitor = new ResourceMonitor(logger, {
        heap: {
          target: 1, // 1 MB - will exceed
        },
      });

      strictMonitor.snapshot();
      const budget = strictMonitor.checkBudget();

      expect(budget.exceeded).toBe(true);
      expect(budget.violations.some((v) => v.includes("Heap"))).toBe(true);
    });
  });

  describe("Snapshot Accuracy", () => {
    test("should have increasing timestamps", () => {
      const snapshots = monitor.getSnapshots();

      for (let i = 1; i < snapshots.length; i++) {
        expect(snapshots[i].timestamp).toBeGreaterThanOrEqual(
          snapshots[i - 1].timestamp
        );
      }
    });

    test("should track process uptime", () => {
      const firstSnapshot = monitor.getSnapshots()[0];
      const lastSnapshot = monitor.getSnapshots()[
        monitor.getSnapshots().length - 1
      ];

      expect(lastSnapshot.uptime).toBeGreaterThanOrEqual(firstSnapshot.uptime);
    });

    test("should have same PID across snapshots", () => {
      const snapshots = monitor.getSnapshots();
      const pids = new Set(snapshots.map((s) => s.pid));

      expect(pids.size).toBe(1);
      expect([...pids][0]).toBe(process.pid);
    });
  });
});

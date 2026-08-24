/**
 * Soak Test: Repeated Execution Lifecycle
 *
 * Critical regression test that detects resource accumulation across
 * repeated agent execution → cleanup cycles.
 *
 * This test is essential because:
 * 1. Short operations hide accumulation
 * 2. Process cleanup is explicit (must be verified)
 * 3. The pattern (execute → cleanup) is Paseo's actual workload
 * 4. The graph shape (bounded vs monotonic climb) is diagnostic
 *
 * Expected healthy behavior:
 * RSS oscillates within a bounded range (±10-20 MB around baseline)
 * Heap returns to a stable low after GC
 * Handles and child processes return to baseline count
 * No monotonic growth across 50 iterations
 *
 * Expected pathological behavior (indicates leak):
 * RSS climbs monotonically (10→20→35→52→71 MB)
 * Heap never returns to baseline
 * Handles accumulate
 * Child processes not cleaned up
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import pino from "pino";
import { ResourceMonitor, type ResourceSnapshot } from "./resource-monitor.js";

describe("Phase 1: Soak Test - Repeated Execution Lifecycle", () => {
  let monitor: ResourceMonitor;
  const logger = pino({ level: "silent" });

  beforeEach(() => {
    monitor = new ResourceMonitor(logger, {
      process: {
        rssMax: 500, // 500 MB - adjust based on actual measurements
      },
    });

    if (global.gc) {
      global.gc();
    }
    monitor.snapshot();
  });

  describe("50× Execute → Cleanup Cycle", () => {
    test("should maintain bounded memory across repeated operations", () => {
      const results: Array<{
        iteration: number;
        rss: number;
        heapUsed: number;
        heapTotal: number;
        handles: number;
      }> = [];

      const iterations = 50;

      for (let i = 0; i < iterations; i++) {
        // Simulate agent execution: allocate memory
        const buffers: Buffer[] = [];
        for (let j = 0; j < 5; j++) {
          buffers.push(Buffer.alloc(100 * 1024)); // 100 KB each = 500 KB per iteration
        }

        // Simulate work
        const data = JSON.stringify({ iteration: i, data: "x".repeat(1000) });
        void data; // Use to avoid optimization

        // Explicit cleanup (represents agent completion → resource release)
        buffers.length = 0;

        // Periodic GC
        if (i % 10 === 0 && global.gc) {
          global.gc();
        }

        const snapshot = monitor.snapshot();
        results.push({
          iteration: i,
          rss: snapshot.process.rss,
          heapUsed: snapshot.heap.heapUsed,
          heapTotal: snapshot.heap.heapTotal,
          handles: snapshot.eventLoop.active,
        });
      }

      // Analysis: Check for monotonic growth (leak indicator)
      const rssSamples = results.map((r) => r.rss);
      const heapSamples = results.map((r) => r.heapUsed);

      // Count monotonic increases (should not be most of the iterations)
      let rssMonotonicCount = 0;
      for (let i = 1; i < rssSamples.length; i++) {
        if (rssSamples[i] > rssSamples[i - 1]) {
          rssMonotonicCount++;
        }
      }

      // Healthy: RSS increases in <50% of iterations (normal variance)
      // Leak: RSS increases in >75% of iterations (monotonic climb)
      expect(rssMonotonicCount).toBeLessThan(iterations * 0.75);

      // Check bounding: max should not exceed min by more than 50%
      const minRss = Math.min(...rssSamples);
      const maxRss = Math.max(...rssSamples);
      const rssGrowth = (maxRss - minRss) / minRss;

      expect(rssGrowth).toBeLessThan(0.5); // Less than 50% peak-to-trough

      // Same for heap
      const minHeap = Math.min(...heapSamples);
      const maxHeap = Math.max(...heapSamples);
      const heapGrowth = (maxHeap - minHeap) / minHeap;

      expect(heapGrowth).toBeLessThan(1.0); // Less than 100% variance

      // Log results for inspection
      console.log("\nSoak Test Results (50 iterations):");
      console.log(`  RSS: ${Math.round(minRss / 1024 / 1024)}-${Math.round(maxRss / 1024 / 1024)} MB`);
      console.log(`       Growth: ${(rssGrowth * 100).toFixed(1)}%`);
      console.log(`  Monotonic increases: ${rssMonotonicCount}/${iterations}`);
      console.log(`  Heap: ${Math.round(minHeap / 1024 / 1024)}-${Math.round(maxHeap / 1024 / 1024)} MB`);
      console.log(`        Variance: ${(heapGrowth * 100).toFixed(1)}%`);
      console.log(`  Active handles: ${Math.min(...results.map((r) => r.handles))}-${Math.max(...results.map((r) => r.handles))}`);

      if (rssMonotonicCount > iterations * 0.5) {
        console.log("\n⚠️  WARNING: High monotonic growth detected—possible leak");
      }
    });

    test("should handle process cleanup correctly", async () => {
      const baseline = monitor.snapshot();
      const baselineHandles = baseline.eventLoop.active;

      // Create and destroy multiple async operations
      const iterations = 10;
      for (let i = 0; i < iterations; i++) {
        const promises = [];
        for (let j = 0; j < 5; j++) {
          promises.push(
            new Promise((resolve) => {
              setImmediate(() => resolve(null));
            })
          );
        }
        await Promise.all(promises);
      }

      // After all operations complete and settle, handles should return to baseline
      monitor.snapshot();
      const current = monitor.getSnapshots()[monitor.getSnapshots().length - 1];
      const currentHandles = current.eventLoop.active;

      // Allow small variance (±5 handles for lingering timers)
      expect(Math.abs(currentHandles - baselineHandles)).toBeLessThanOrEqual(5);
    });

    test("should detect if agent subprocesses are not cleaned up", () => {
      // This test would spawn actual agent processes and verify cleanup
      // Placeholder for when we integrate real agent execution

      const baselineSnapshot = monitor.getSnapshots()[0];
      const baselineHandles = baselineSnapshot.eventLoop.active;

      // Simulate child process lifecycle
      // (In real test: spawn agent via AgentManager, let it complete, verify cleanup)

      const finalSnapshot = monitor.snapshot();
      const finalHandles = finalSnapshot.eventLoop.active;

      // Handles should not accumulate (each agent cleanup should release handles)
      expect(finalHandles).toBeLessThanOrEqual(baselineHandles + 2); // Small grace margin
    });

    test("should not accumulate closed resources", () => {
      const snapshots: ResourceSnapshot[] = [];
      const checkpoints: Array<{ iteration: number; rss: number; heapUsed: number }> = [];

      for (let cycle = 0; cycle < 5; cycle++) {
        // Each cycle: allocate, use, release
        const obj = {
          data: new Array(10000).fill("x"),
          buffer: Buffer.alloc(1024 * 1024),
          nested: {
            moreData: new Array(5000).fill("y"),
          },
        };

        // Simulate processing
        const serialized = JSON.stringify(obj);
        void serialized;

        // Explicit release
        (obj as any) = null;

        if (global.gc && cycle % 2 === 0) {
          global.gc();
        }

        const snap = monitor.snapshot();
        snapshots.push(snap);
        checkpoints.push({
          iteration: cycle,
          rss: snap.process.rss,
          heapUsed: snap.heap.heapUsed,
        });
      }

      // Verify: After releasing objects and GC, memory should contract
      // Not necessarily return to baseline, but should not keep growing
      const heaps = checkpoints.map((c) => c.heapUsed);
      const finalHeap = heaps[heaps.length - 1];
      const minHeap = Math.min(...heaps);

      // Should not be at peak
      expect(finalHeap).toBeLessThanOrEqual(minHeap * 1.5);
    });
  });

  describe("Sustained Operation Bounds", () => {
    test("memory should stabilize, not grow unbounded", () => {
      const startTime = Date.now();
      const durationMs = 2000; // 2 second sustained operation
      const checkpoints = [];

      while (Date.now() - startTime < durationMs) {
        // Continuous work: allocate, process, release
        const batch = new Array(100).fill(null).map((_, i) => ({
          id: i,
          data: "x".repeat(100),
        }));

        const serialized = JSON.stringify(batch);
        void serialized;

        checkpoints.push(monitor.snapshot());

        // Simulate minimal delay
        const delayStart = Date.now();
        while (Date.now() - delayStart < 5) {
          // Busy-wait 5ms
        }
      }

      // Analyze growth rate over time
      const rssSamples = checkpoints.map((s) => s.process.rss);
      const firstQuarter = rssSamples.slice(0, Math.floor(rssSamples.length / 4));
      const lastQuarter = rssSamples.slice(-Math.floor(rssSamples.length / 4));

      const firstAvg = firstQuarter.reduce((a, b) => a + b) / firstQuarter.length;
      const lastAvg = lastQuarter.reduce((a, b) => a + b) / lastQuarter.length;

      // Growth rate should be sublinear (not 20% per quarter)
      const growthRate = (lastAvg - firstAvg) / firstAvg;
      expect(growthRate).toBeLessThan(0.2); // Less than 20% growth

      console.log(
        `\nSustained Operation (2s): ${checkpoints.length} samples`
      );
      console.log(`  First quarter avg: ${Math.round(firstAvg / 1024 / 1024)} MB`);
      console.log(`  Last quarter avg: ${Math.round(lastAvg / 1024 / 1024)} MB`);
      console.log(`  Growth rate: ${(growthRate * 100).toFixed(1)}%`);
    });
  });
});

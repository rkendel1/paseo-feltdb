/**
 * Resource Monitor - Measure Paseo resource footprint
 *
 * Captures process, memory, CPU, and container metrics across standardized workloads.
 * Used to establish baselines and track resource behavior under various conditions.
 *
 * Metrics captured:
 * - Resident memory (RSS)
 * - Virtual memory (VSIZE)
 * - CPU usage
 * - Process count
 * - Heap usage
 * - File descriptor count
 * - GC pause times
 */

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import os from "node:os";
import type { Logger } from "pino";

export interface ProcessMetrics {
  pid: number;
  ppid: number;
  rss: number; // Resident set size in bytes
  vsize: number; // Virtual memory size in bytes
  cpu: number; // CPU usage percentage
  uptime: number; // Seconds
  commandLine: string;
}

export interface HeapMetrics {
  heapUsed: number;
  heapTotal: number;
  external: number;
  arrayBuffers: number;
}

export interface GCMetrics {
  gcCount: number;
  gcDuration: number; // milliseconds
  pauses: number[]; // Individual pause durations
}

export interface ResourceSnapshot {
  timestamp: number;
  pid: number;
  process: ProcessMetrics;
  heap: HeapMetrics;
  uptime: number; // Process uptime in seconds
  eventLoop: {
    lag: number; // milliseconds
    active: number; // active handles
  };
}

export interface ContainerMetrics {
  containerId: string;
  name: string;
  memory: {
    used: number; // bytes
    limit: number; // bytes
  };
  cpu: {
    usage: number; // nanoseconds
    throttled: number; // count
  };
  pids: number;
}

export interface ResourceBudget {
  process: {
    rssMax: number; // bytes
    vsizeMax: number; // bytes
  };
  heap: {
    maxOldSpaceSize: number; // MB
    target: number; // MB
  };
  container: {
    memoryLimit: number; // bytes
    cpuLimit: number; // cores
  };
}

/**
 * ResourceMonitor tracks Paseo resource consumption
 */
export class ResourceMonitor {
  private snapshots: ResourceSnapshot[] = [];
  private baseline: ResourceSnapshot | null = null;
  private budget: ResourceBudget;

  constructor(_logger: Logger, budget?: Partial<ResourceBudget>) {
    this.budget = {
      process: {
        rssMax: (budget?.process?.rssMax ?? 500) * 1024 * 1024, // 500 MB default
        vsizeMax: (budget?.process?.vsizeMax ?? 1500) * 1024 * 1024, // 1.5 GB default
      },
      heap: {
        maxOldSpaceSize: budget?.heap?.maxOldSpaceSize ?? 512, // MB
        target: (budget?.heap?.target ?? 256) * 1024 * 1024, // bytes
      },
      container: {
        memoryLimit: (budget?.container?.memoryLimit ?? 1024) * 1024 * 1024, // 1 GB default
        cpuLimit: budget?.container?.cpuLimit ?? 2, // cores
      },
    };

    this.setupGCTracking();
  }

  private setupGCTracking(): void {
    if (global.gc) {
      // GC tracking requires --expose-gc flag
      const originalGc = global.gc;
      let gcCount = 0;
      const pauses: number[] = [];

      (global as any).gc = function (...args: any[]): void {
        const start = performance.now();
        originalGc(...args);
        const duration = performance.now() - start;
        gcCount++;
        pauses.push(duration);
      };
    }
  }

  /**
   * Capture current resource snapshot
   */
  snapshot(): ResourceSnapshot {
    const memUsage = process.memoryUsage();
    const processUptime = process.uptime();

    const snapshot: ResourceSnapshot = {
      timestamp: Date.now(),
      pid: process.pid,
      process: this.captureProcessMetrics(),
      heap: {
        heapUsed: memUsage.heapUsed,
        heapTotal: memUsage.heapTotal,
        external: memUsage.external,
        arrayBuffers: memUsage.arrayBuffers,
      },
      uptime: processUptime,
      eventLoop: {
        lag: 0, // Measured separately if needed
        active: (process as any)._getActiveHandles?.()?.length ?? 0,
      },
    };

    this.snapshots.push(snapshot);

    if (!this.baseline) {
      this.baseline = snapshot;
    }

    return snapshot;
  }

  /**
   * Capture Linux process metrics from /proc
   */
  private captureProcessMetrics(): ProcessMetrics {
    const pid = process.pid;

    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf-8").split(" ");
      const status = readFileSync(`/proc/${pid}/status`, "utf-8");

      const rss = parseInt(status.match(/VmRSS:\s+(\d+)/)?.[1] ?? "0") * 1024;
      const vsize = parseInt(stat[22] ?? "0");
      const uptime = parseFloat(stat[21] ?? "0") / 100; // Clock ticks to seconds

      // CPU usage: (utime + stime) / uptime / nprocs * 100
      const utime = parseInt(stat[13] ?? "0");
      const stime = parseInt(stat[14] ?? "0");
      const cpu =
        ((utime + stime) / uptime / os.cpus().length) * 100;

      return {
        pid,
        ppid: parseInt(stat[3] ?? "-1"),
        rss,
        vsize,
        cpu: Math.min(cpu, 100), // Cap at 100%
        uptime,
        commandLine: this.readCommandLine(pid),
      };
    } catch {
      // Fallback if /proc not available (macOS, Windows)
      return {
        pid,
        ppid: -1,
        rss: 0,
        vsize: 0,
        cpu: 0,
        uptime: process.uptime(),
        commandLine: process.argv.join(" "),
      };
    }
  }

  private readCommandLine(pid: number): string {
    try {
      return readFileSync(`/proc/${pid}/cmdline`, "utf-8")
        .replace(/\0/g, " ")
        .trim();
    } catch {
      return process.argv.join(" ");
    }
  }

  /**
   * Check if current metrics exceed budget
   */
  checkBudget(): { exceeded: boolean; violations: string[] } {
    const current = this.snapshots[this.snapshots.length - 1];
    if (!current) {
      return { exceeded: false, violations: [] };
    }

    const violations: string[] = [];

    if (
      current.process.rss > this.budget.process.rssMax
    ) {
      violations.push(
        `RSS ${this.formatBytes(current.process.rss)} exceeds limit ${this.formatBytes(
          this.budget.process.rssMax
        )}`
      );
    }

    if (
      current.process.vsize > this.budget.process.vsizeMax
    ) {
      violations.push(
        `VSIZE ${this.formatBytes(current.process.vsize)} exceeds limit ${this.formatBytes(
          this.budget.process.vsizeMax
        )}`
      );
    }

    if (
      current.heap.heapUsed > this.budget.heap.target
    ) {
      violations.push(
        `Heap ${this.formatBytes(current.heap.heapUsed)} exceeds target ${this.formatBytes(
          this.budget.heap.target
        )}`
      );
    }

    return {
      exceeded: violations.length > 0,
      violations,
    };
  }

  /**
   * Capture container metrics if running in Docker/container
   */
  async captureContainerMetrics(): Promise<ContainerMetrics | null> {
    try {
      const containerId = this.getContainerId();
      if (!containerId) return null;

      const statsFile = `/sys/fs/cgroup/docker/${containerId}/memory.stat`;
      const stats = readFileSync(statsFile, "utf-8");

      // Parse cgroup memory stats
      const match = stats.match(/rss\s+(\d+)/);
      const used = parseInt(match?.[1] ?? "0");

      const limitMatch = stats.match(/limit_in_bytes\s+(\d+)/);
      const limit = parseInt(limitMatch?.[1] ?? "0");

      return {
        containerId,
        name: this.getContainerName(),
        memory: { used, limit },
        cpu: { usage: 0, throttled: 0 },
        pids: this.getContainerPidCount(),
      };
    } catch {
      return null;
    }
  }

  private getContainerId(): string | null {
    try {
      const cgroup = readFileSync("/proc/self/cgroup", "utf-8");
      const match = cgroup.match(/docker\/([a-f0-9]+)/);
      return match?.[1] ?? null;
    } catch {
      return null;
    }
  }

  private getContainerName(): string {
    try {
      return execSync("docker inspect --format='{{.Name}}' $(cat /etc/hostname)")
        .toString()
        .trim();
    } catch {
      return "unknown";
    }
  }

  private getContainerPidCount(): number {
    try {
      const pids = execSync("ps aux | wc -l").toString().trim();
      return parseInt(pids);
    } catch {
      return 0;
    }
  }

  /**
   * Generate resource report
   */
  report(): {
    baseline: ResourceSnapshot | null;
    current: ResourceSnapshot | null;
    samples: number;
    growth: { rss: number; heap: number };
    budget: ResourceBudget;
  } {
    const current = this.snapshots[this.snapshots.length - 1];

    return {
      baseline: this.baseline,
      current,
      samples: this.snapshots.length,
      growth: {
        rss: current && this.baseline
          ? current.process.rss - this.baseline.process.rss
          : 0,
        heap: current && this.baseline
          ? current.heap.heapUsed - this.baseline.heap.heapUsed
          : 0,
      },
      budget: this.budget,
    };
  }

  /**
   * Format bytes as human-readable
   */
  private formatBytes(bytes: number): string {
    const units = ["B", "KB", "MB", "GB"];
    let size = bytes;
    let unitIndex = 0;

    while (size >= 1024 && unitIndex < units.length - 1) {
      size /= 1024;
      unitIndex++;
    }

    return `${size.toFixed(2)} ${units[unitIndex]}`;
  }

  /**
   * Reset snapshots for new measurement cycle
   */
  reset(): void {
    this.snapshots = [];
    this.baseline = null;
  }

  /**
   * Get all snapshots
   */
  getSnapshots(): ResourceSnapshot[] {
    return this.snapshots;
  }
}

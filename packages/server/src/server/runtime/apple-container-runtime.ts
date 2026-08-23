/**
 * AppleContainerRuntime - Apple Container implementation of ContainerRuntime
 *
 * Uses Apple's native container runtime (OCI-compatible) as an alternative to Docker.
 * This is an experimental implementation designed to reduce memory footprint on macOS.
 *
 * Apple Container Runtime:
 * - Uses lightweight Linux VMs optimized for Apple silicon
 * - Supports OCI container images
 * - Explicit CPU and memory limits (4 CPUs, 1 GiB RAM by default)
 * - Persistent container machines for long-lived services
 *
 * Status: EXPERIMENTAL - Not yet integrated into Paseo
 * This implementation is a placeholder for Phase 3 (Apple Container evaluation).
 */

import { execSync } from "node:child_process";
import type { Logger } from "pino";
import type {
  IContainerRuntime,
  ContainerConfig,
  ContainerStats,
  ExecutionResult,
} from "./container-runtime.js";

export class AppleContainerRuntime implements IContainerRuntime {
  private logger: Logger;
  private isAvailable: boolean = false;

  constructor(logger: Logger) {
    this.logger = logger.child({ module: "apple-container-runtime" });
  }

  name(): string {
    return "apple-container";
  }

  async isAvailable(): Promise<boolean> {
    if (this.isAvailable) return true;

    try {
      execSync("which container", { stdio: "ignore" });
      this.isAvailable = true;
      return true;
    } catch {
      this.logger.debug("Apple Container runtime not found");
      return false;
    }
  }

  async version(): Promise<string> {
    try {
      const output = execSync("container --version").toString();
      return output.trim();
    } catch {
      return "unknown";
    }
  }

  async create(name: string, config: ContainerConfig): Promise<string> {
    this.logger.warn(
      { name },
      "AppleContainerRuntime.create() not yet implemented - this is a placeholder for Phase 3"
    );
    throw new Error("AppleContainerRuntime not yet implemented");
  }

  async start(containerId: string): Promise<void> {
    throw new Error("AppleContainerRuntime not yet implemented");
  }

  async stop(containerId: string, timeout?: number): Promise<void> {
    throw new Error("AppleContainerRuntime not yet implemented");
  }

  async remove(containerId: string, force?: boolean): Promise<void> {
    throw new Error("AppleContainerRuntime not yet implemented");
  }

  async exec(
    containerId: string,
    cmd: string[],
    options?: { env?: Record<string, string>; workdir?: string }
  ): Promise<ExecutionResult> {
    throw new Error("AppleContainerRuntime not yet implemented");
  }

  async stats(containerId: string): Promise<ContainerStats> {
    throw new Error("AppleContainerRuntime not yet implemented");
  }

  async logs(
    containerId: string,
    options?: { tail?: number; follow?: boolean }
  ): Promise<string> {
    throw new Error("AppleContainerRuntime not yet implemented");
  }

  async health(
    containerId: string
  ): Promise<"healthy" | "unhealthy" | "starting" | "unknown"> {
    throw new Error("AppleContainerRuntime not yet implemented");
  }

  async list(): Promise<Array<{ id: string; name: string; status: string }>> {
    throw new Error("AppleContainerRuntime not yet implemented");
  }

  async mount(
    containerId: string,
    src: string,
    dst: string,
    readonly?: boolean
  ): Promise<void> {
    throw new Error("AppleContainerRuntime not yet implemented");
  }

  async exposePort(
    containerId: string,
    hostPort: number,
    containerPort: number
  ): Promise<void> {
    throw new Error("AppleContainerRuntime not yet implemented");
  }

  getSupportedBudgets(): {
    minMemory: number;
    maxMemory: number;
    minCpus: number;
    maxCpus: number;
  } {
    // Apple Container defaults: 4 CPUs, 1 GiB RAM
    // See: https://github.com/apple/container
    return {
      minMemory: 64 * 1024 * 1024, // 64 MB minimum
      maxMemory: 0, // No hard max, but VM limit applies
      minCpus: 0.25,
      maxCpus: 4, // Default VM limit
    };
  }
}

/**
 * PHASE 3: Apple Container Evaluation
 *
 * Once this implementation is complete, run the same benchmark suite
 * used for Docker and compare:
 * - Baseline memory
 * - Idle memory
 * - Active memory
 * - Peak memory
 * - Startup time
 * - Shutdown time
 * - Disk usage
 * - Filesystem performance
 *
 * Success criteria:
 * - Apple Container uses materially less memory than Docker on macOS
 * - All OCI images work without modification
 * - Networking, volumes, health checks, port exposure work
 * - Container machine provides better long-lived runtime experience
 *
 * If metrics justify adoption:
 * - Set PASEO_RUNTIME=apple-container as default on macOS
 * - Retain Docker for CI and non-macOS platforms
 * - Document runtime selection in README
 */

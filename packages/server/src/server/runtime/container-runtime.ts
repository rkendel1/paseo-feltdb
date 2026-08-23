/**
 * ContainerRuntime - Abstract interface for agent execution environments
 *
 * Decouples Paseo from Docker-specific commands. Allows multiple implementations:
 * - DockerRuntime: Uses Docker CLI (current)
 * - AppleContainerRuntime: Uses Apple's native container runtime (future)
 *
 * This abstraction is designed to support benchmarking and runtime selection
 * based on platform-specific measurements, not assumptions.
 */

import type { Logger } from "pino";

export interface ContainerImage {
  name: string;
  tag: string;
}

export interface ContainerConfig {
  image: ContainerImage;
  env: Record<string, string>;
  mounts: Array<{ src: string; dst: string; readonly?: boolean }>;
  ports: Array<{ host: number; container: number }>;
  memory: number; // bytes
  cpus: number;
  healthCheck?: {
    cmd: string[];
    interval: number; // seconds
    timeout: number; // seconds
    retries: number;
  };
  workdir?: string;
  command?: string[];
}

export interface ContainerStats {
  memoryUsed: number; // bytes
  memoryLimit: number; // bytes
  cpuUsage: number; // 0-1
  pids: number;
  uptime: number; // seconds
}

export interface ExecutionResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  duration: number; // milliseconds
}

/**
 * ContainerRuntime interface - all implementations must satisfy this
 */
export interface IContainerRuntime {
  /**
   * Identify the runtime implementation
   */
  name(): string;

  /**
   * Check if runtime is available on this system
   */
  isAvailable(): Promise<boolean>;

  /**
   * Get runtime version
   */
  version(): Promise<string>;

  /**
   * Create a container from image
   */
  create(name: string, config: ContainerConfig): Promise<string>; // Returns container ID

  /**
   * Start a container
   */
  start(containerId: string): Promise<void>;

  /**
   * Stop a container
   */
  stop(containerId: string, timeout?: number): Promise<void>;

  /**
   * Remove a container
   */
  remove(containerId: string, force?: boolean): Promise<void>;

  /**
   * Execute command in running container
   */
  exec(
    containerId: string,
    cmd: string[],
    options?: { env?: Record<string, string>; workdir?: string }
  ): Promise<ExecutionResult>;

  /**
   * Get container statistics
   */
  stats(containerId: string): Promise<ContainerStats>;

  /**
   * Get container logs
   */
  logs(
    containerId: string,
    options?: { tail?: number; follow?: boolean }
  ): Promise<string>;

  /**
   * Get container health status
   */
  health(containerId: string): Promise<"healthy" | "unhealthy" | "starting" | "unknown">;

  /**
   * List running containers
   */
  list(): Promise<Array<{ id: string; name: string; status: string }>>;

  /**
   * Mount volume into container (implementation-specific)
   */
  mount(
    containerId: string,
    src: string,
    dst: string,
    readonly?: boolean
  ): Promise<void>;

  /**
   * Expose port from container
   */
  exposePort(
    containerId: string,
    hostPort: number,
    containerPort: number
  ): Promise<void>;

  /**
   * Get resource budgets supported by this runtime
   */
  getSupportedBudgets(): {
    minMemory: number; // bytes
    maxMemory: number; // bytes
    minCpus: number;
    maxCpus: number;
  };
}

/**
 * RuntimeConfig - Select which runtime to use
 */
export interface RuntimeConfig {
  type: "docker" | "apple-container" | "auto";
  logger: Logger;
  preferences?: {
    preferMacOSNative?: boolean; // On macOS, try native container runtime first
    fallbackToDocker?: boolean; // If native unavailable, fallback to Docker
    requireExplicitSelection?: boolean; // Fail if exact type unavailable
  };
}

/**
 * Create runtime instance based on platform and configuration
 */
export async function createContainerRuntime(
  config: RuntimeConfig
): Promise<IContainerRuntime> {
  const { type, logger, preferences } = config;

  // Lazy imports to avoid circular dependencies
  const { DockerRuntime } = await import("./docker-runtime.js");

  if (type === "docker") {
    return new DockerRuntime(logger);
  }

  if (type === "apple-container") {
    try {
      const { AppleContainerRuntime } = await import("./apple-container-runtime.js");
      return new AppleContainerRuntime(logger);
    } catch {
      if (preferences?.requireExplicitSelection) {
        throw new Error("Apple Container runtime not available");
      }
      if (preferences?.fallbackToDocker) {
        logger.warn("Apple Container runtime unavailable, falling back to Docker");
        return new DockerRuntime(logger);
      }
      throw new Error("Apple Container runtime not available and no fallback configured");
    }
  }

  if (type === "auto") {
    const isMacOS = process.platform === "darwin";
    const preferNative = preferences?.preferMacOSNative ?? isMacOS;

    if (preferNative) {
      try {
        const { AppleContainerRuntime } = await import("./apple-container-runtime.js");
        const runtime = new AppleContainerRuntime(logger);
        if (await runtime.isAvailable()) {
          logger.info("Using native Apple Container runtime");
          return runtime;
        }
      } catch {
        logger.debug("Apple Container runtime not available, trying Docker");
      }
    }

    logger.info("Using Docker runtime");
    return new DockerRuntime(logger);
  }

  throw new Error(`Unknown runtime type: ${type}`);
}

/**
 * Helper to get runtime name from type
 */
export function getRuntimeName(type: string): string {
  switch (type) {
    case "docker":
      return "Docker";
    case "apple-container":
      return "Apple Container";
    default:
      return type;
  }
}

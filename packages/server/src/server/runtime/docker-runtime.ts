/**
 * DockerRuntime - Docker implementation of ContainerRuntime
 *
 * Uses Docker CLI commands via execSync/exec to manage containers.
 * This is the current backend for Paseo agent execution.
 */

import { execSync, exec } from "node:child_process";
import { promisify } from "node:util";
import type { Logger } from "pino";
import type {
  IContainerRuntime,
  ContainerConfig,
  ContainerStats,
  ExecutionResult,
} from "./container-runtime.js";

const execAsync = promisify(exec);

export class DockerRuntime implements IContainerRuntime {
  private logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger.child({ module: "docker-runtime" });
  }

  name(): string {
    return "docker";
  }

  async isAvailable(): Promise<boolean> {
    try {
      execSync("docker --version", { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  }

  async version(): Promise<string> {
    try {
      const output = execSync("docker --version").toString();
      return output.trim();
    } catch {
      return "unknown";
    }
  }

  async create(name: string, config: ContainerConfig): Promise<string> {
    const imageStr = `${config.image.name}:${config.image.tag}`;

    // Build docker run command
    const args: string[] = [
      "docker", "create",
      "--name", name,
      `--memory=${Math.floor(config.memory / 1024 / 1024)}m`,
      `--cpus=${config.cpus}`,
    ];

    // Add environment variables
    for (const [key, value] of Object.entries(config.env)) {
      args.push("-e", `${key}=${value}`);
    }

    // Add mounts
    for (const mount of config.mounts) {
      const roFlag = mount.readonly ? ":ro" : "";
      args.push("-v", `${mount.src}:${mount.dst}${roFlag}`);
    }

    // Add port mappings
    for (const port of config.ports) {
      args.push("-p", `${port.host}:${port.container}`);
    }

    // Add health check if configured
    if (config.healthCheck) {
      args.push(
        "--health-cmd", config.healthCheck.cmd.join(" "),
        "--health-interval", `${config.healthCheck.interval}s`,
        "--health-timeout", `${config.healthCheck.timeout}s`,
        "--health-retries", String(config.healthCheck.retries)
      );
    }

    // Add workdir if specified
    if (config.workdir) {
      args.push("-w", config.workdir);
    }

    // Add image
    args.push(imageStr);

    // Add command if specified
    if (config.command) {
      args.push(...config.command);
    }

    const cmd = args.join(" ");
    this.logger.debug({ cmd }, "Creating container");

    try {
      const output = execSync(cmd).toString().trim();
      this.logger.info({ containerId: output, name }, "Container created");
      return output;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error({ error: msg }, "Failed to create container");
      throw new Error(`Failed to create container: ${msg}`);
    }
  }

  async start(containerId: string): Promise<void> {
    const cmd = `docker start ${containerId}`;
    this.logger.debug({ containerId }, "Starting container");

    try {
      execSync(cmd);
      this.logger.info({ containerId }, "Container started");
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to start container: ${msg}`);
    }
  }

  async stop(containerId: string, timeout = 10): Promise<void> {
    const cmd = `docker stop --time=${timeout} ${containerId}`;
    this.logger.debug({ containerId, timeout }, "Stopping container");

    try {
      execSync(cmd);
      this.logger.info({ containerId }, "Container stopped");
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to stop container: ${msg}`);
    }
  }

  async remove(containerId: string, force = false): Promise<void> {
    const forceFlag = force ? "-f" : "";
    const cmd = `docker rm ${forceFlag} ${containerId}`.trim();
    this.logger.debug({ containerId, force }, "Removing container");

    try {
      execSync(cmd);
      this.logger.info({ containerId }, "Container removed");
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to remove container: ${msg}`);
    }
  }

  async exec(
    containerId: string,
    cmd: string[],
    options?: { env?: Record<string, string>; workdir?: string }
  ): Promise<ExecutionResult> {
    const args: string[] = ["docker", "exec"];

    // Add environment variables
    if (options?.env) {
      for (const [key, value] of Object.entries(options.env)) {
        args.push("-e", `${key}=${value}`);
      }
    }

    // Add workdir if specified
    if (options?.workdir) {
      args.push("-w", options.workdir);
    }

    args.push(containerId, ...cmd);
    const fullCmd = args.join(" ");

    this.logger.debug({ containerId, cmd: fullCmd }, "Executing in container");

    const startTime = Date.now();
    try {
      const { stdout, stderr } = await execAsync(fullCmd);
      const duration = Date.now() - startTime;

      return {
        exitCode: 0,
        stdout: stdout.toString(),
        stderr: stderr.toString(),
        duration,
      };
    } catch (error: any) {
      const duration = Date.now() - startTime;
      return {
        exitCode: error.code ?? 1,
        stdout: error.stdout?.toString() ?? "",
        stderr: error.stderr?.toString() ?? "",
        duration,
      };
    }
  }

  async stats(containerId: string): Promise<ContainerStats> {
    const cmd = `docker stats --no-stream --format "{{json .}}" ${containerId}`;

    try {
      const output = execSync(cmd).toString();
      const statsData = JSON.parse(output);

      // Parse memory (e.g., "512MiB")
      const memMatch = statsData.MemUsage.match(/(\d+\.?\d*)/);
      const memUsed = memMatch ? parseFloat(memMatch[1]) * 1024 * 1024 : 0;

      const limitMatch = statsData.MemUsage.match(/\/\s*(\d+\.?\d*)/);
      const memLimit = limitMatch ? parseFloat(limitMatch[1]) * 1024 * 1024 : 0;

      // Parse CPU (e.g., "0.12%")
      const cpuMatch = statsData.CPUPerc.match(/(\d+\.?\d*)/);
      const cpu = cpuMatch ? parseFloat(cpuMatch[1]) / 100 : 0;

      // Parse PIDs
      const pids = parseInt(statsData.PIDs ?? "0");

      return {
        memoryUsed: Math.floor(memUsed),
        memoryLimit: Math.floor(memLimit),
        cpuUsage: Math.min(cpu, 1), // Cap at 1.0
        pids,
        uptime: 0, // Would need to derive from container creation time
      };
    } catch (error) {
      this.logger.warn({ containerId, error }, "Failed to get container stats");
      return {
        memoryUsed: 0,
        memoryLimit: 0,
        cpuUsage: 0,
        pids: 0,
        uptime: 0,
      };
    }
  }

  async logs(
    containerId: string,
    options?: { tail?: number; follow?: boolean }
  ): Promise<string> {
    const args: string[] = ["docker", "logs"];

    if (options?.tail) {
      args.push(`--tail=${options.tail}`);
    }

    if (options?.follow) {
      args.push("-f");
    }

    args.push(containerId);
    const cmd = args.join(" ");

    try {
      const output = execSync(cmd, { stdio: "pipe" }).toString();
      return output;
    } catch (error) {
      this.logger.warn({ containerId, error }, "Failed to get logs");
      return "";
    }
  }

  async health(
    containerId: string
  ): Promise<"healthy" | "unhealthy" | "starting" | "unknown"> {
    const cmd = `docker inspect --format='{{.State.Health.Status}}' ${containerId}`;

    try {
      const output = execSync(cmd).toString().trim().toLowerCase();
      if (
        output === "healthy" ||
        output === "unhealthy" ||
        output === "starting"
      ) {
        return output;
      }
      return "unknown";
    } catch {
      return "unknown";
    }
  }

  async list(): Promise<Array<{ id: string; name: string; status: string }>> {
    const cmd =
      'docker ps -a --format "{{json .}}"';

    try {
      const output = execSync(cmd).toString();
      const lines = output.trim().split("\n").filter(Boolean);
      return lines.map((line) => {
        const data = JSON.parse(line);
        return {
          id: data.ID,
          name: data.Names,
          status: data.Status,
        };
      });
    } catch (error) {
      this.logger.warn({ error }, "Failed to list containers");
      return [];
    }
  }

  async mount(
    containerId: string,
    src: string,
    dst: string,
    _readonly = false
  ): Promise<void> {
    // Docker doesn't support dynamic mount after creation
    // This would require recreating the container
    this.logger.warn(
      { containerId, src, dst },
      "Docker does not support dynamic mounts"
    );
    throw new Error("Docker runtime does not support dynamic mounts");
  }

  async exposePort(
    containerId: string,
    hostPort: number,
    containerPort: number
  ): Promise<void> {
    // Docker doesn't support dynamic port exposure after creation
    this.logger.warn(
      { containerId, hostPort, containerPort },
      "Docker does not support dynamic port exposure"
    );
    throw new Error("Docker runtime does not support dynamic port exposure");
  }

  getSupportedBudgets(): {
    minMemory: number;
    maxMemory: number;
    minCpus: number;
    maxCpus: number;
  } {
    return {
      minMemory: 11 * 1024 * 1024, // 11 MB
      maxMemory: 0, // Unlimited (limited by host)
      minCpus: 0.001,
      maxCpus: 0, // Unlimited
    };
  }
}

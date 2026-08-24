/**
 * TaskPersistence - Durable Work State Management
 *
 * Phase 3.5.4: Update task state with explicit authorization and state transition validation.
 *
 * Key principle: Tasks change state ONLY through explicit API calls. We never infer
 * task status from model output or execution events.
 *
 * Design principles:
 * - Explicit updates only: await agent.updateTask(...)
 * - Authorization: Agent must be within same project graph as task
 * - State transitions: Only valid transitions allowed (pending→in_progress→completed/failed)
 * - Provenance: Track which run caused the state change
 * - Non-blocking persistence
 */

import type { Logger } from "pino";
import type { PaseoState } from "./paseo-state.js";
import { createAuthorityGuard, type AuthorizedAction } from "./handoff-authority-guard.js";

export interface UpdateTaskInput {
  status: "open" | "in_progress" | "blocked" | "completed" | "cancelled";
}

// Valid status values from schema
type TaskStatus = "open" | "in_progress" | "blocked" | "completed" | "cancelled";

export interface TaskPersistenceOptions {
  paseoState: PaseoState;
  logger: Logger;
}

/**
 * Valid state transitions for tasks.
 * Maps current status to allowed next statuses.
 */
const VALID_TRANSITIONS: Record<TaskStatus, Set<TaskStatus>> = {
  open: new Set(["in_progress", "blocked", "cancelled"]),
  in_progress: new Set(["completed", "blocked"]),
  blocked: new Set(["in_progress", "cancelled"]),
  completed: new Set([]), // Terminal state
  cancelled: new Set([]), // Terminal state
};

/**
 * TaskPersistence manages explicit, provenance-tracked task updates.
 */
export class TaskPersistence {
  private readonly paseoState: PaseoState;
  private readonly logger: Logger;
  private readonly authorityGuard: ReturnType<typeof createAuthorityGuard>;

  constructor(options: TaskPersistenceOptions) {
    this.paseoState = options.paseoState;
    this.logger = options.logger.child({ module: "task-persistence" });
    this.authorityGuard = createAuthorityGuard(options.paseoState, this.logger);
  }

  /**
   * Update task status with authorization and state transition validation.
   *
   * Authorization:
   * - Agent must be within the task's project graph
   * - Workspace → Project authority established through repository
   *
   * State transitions:
   * - Only explicitly allowed transitions are permitted
   * - Invalid transitions are rejected with clear error
   *
   * Provenance:
   * - Records which run caused the update
   * - Records which agent performed the update
   */
  async updateTask(
    taskId: string,
    agentId: string,
    runId: string,
    input: UpdateTaskInput,
  ): Promise<void> {
    try {
      // 1. Fetch the task
      const task = await this.paseoState.tasks.getById(taskId);
      if (!task) {
        this.logger.warn({ taskId, agentId, runId }, "Cannot update task: Task not found");
        throw new Error(`Task ${taskId} not found`);
      }

      // 2. Fetch the agent to validate workspace membership
      const agent = await this.paseoState.repos.agents.getById(agentId);
      if (!agent) {
        this.logger.warn({ agentId, taskId, runId }, "Cannot update task: Agent not found");
        throw new Error(`Agent ${agentId} not found`);
      }

      // 3. Fetch the workspace to establish project authority
      const workspace = await this.paseoState.repos.workspaces.getById(agent.workspaceId);
      if (!workspace) {
        this.logger.warn(
          { agentId, workspaceId: agent.workspaceId, taskId, runId },
          "Cannot update task: Workspace not found",
        );
        throw new Error(`Workspace ${agent.workspaceId} not found`);
      }

      // 4. AUTHORITY CHECK: Use AuthorityGuard for handoff-aware enforcement
      // This replaces simple project-level checks with scope-aware authorization
      // If agent has active handoff, this will enforce strict boundaries
      await this.authorityGuard.authorize({
        agentId,
        operation: "update",
        entityType: "task",
        entityId: taskId,
        taskId,
        workspaceId: workspace.id,
        projectId: workspace.projectId,
        runId,
        context: { currentStatus: task.status, nextStatus: input.status },
      });

      // 5. State transition validation
      const currentStatus = task.status;
      const nextStatus = input.status;
      const allowedTransitions = VALID_TRANSITIONS[currentStatus];

      if (!allowedTransitions) {
        this.logger.warn(
          { taskId, currentStatus, nextStatus, runId },
          "Cannot update task: Unknown current status",
        );
        throw new Error(`Task ${taskId} has unknown status "${currentStatus}"`);
      }

      if (!allowedTransitions.has(nextStatus)) {
        this.logger.warn(
          { taskId, currentStatus, nextStatus, runId },
          "Cannot update task: Invalid state transition",
        );
        throw new Error(
          `Invalid state transition for task ${taskId}: ` +
            `"${currentStatus}" → "${nextStatus}" not allowed. ` +
            `Valid transitions: ${Array.from(allowedTransitions).join(", ") || "none (terminal state)"}`,
        );
      }

      // 6. Update task with provenance
      await this.paseoState.tasks.update(taskId, {
        status: nextStatus,
        lastUpdatedRunId: runId,
        lastUpdatedBy: agentId,
      });

      this.logger.info(
        {
          taskId,
          agentId,
          runId,
          projectId: task.projectId,
          transition: `${currentStatus} → ${nextStatus}`,
        },
        "Task state updated",
      );
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.logger.error(
        { taskId, agentId, runId, err: error },
        `Failed to update task: ${errorMsg}`,
      );
      throw error;
    }
  }
}

export function createTaskPersistence(options: TaskPersistenceOptions): TaskPersistence {
  return new TaskPersistence(options);
}

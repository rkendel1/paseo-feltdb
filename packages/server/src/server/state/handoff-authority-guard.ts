/**
 * AuthorityGuard - Enforce Handoff Authority at Mutation Boundary
 *
 * Phase 4.3: Handoff → Execution/Mutation Authority Enforcement
 *
 * The critical gap between ContextResolver and actual autonomy:
 * ContextResolver filters what agents can SEE.
 * AuthorityGuard prevents what agents can DO.
 *
 * An agent should NEVER be able to mutate, execute, or commit outside
 * their handoff boundary, even if they learn about entities through
 * other means.
 *
 * Design principles:
 * - Reconstruct authority from FeltDB (never trust caller)
 * - Deny by default if handoff active and action outside scope
 * - Fail fast with clear error messages
 * - No silent filtering or degradation
 *
 * Authority resolution flow:
 * 1. Query active handoff for agent from FeltDB
 * 2. If no handoff: use default project-level authorization
 * 3. If handoff active: enforce strict scope boundaries
 * 4. Validate action taskId/workspaceId against scope
 * 5. ALLOW or DENY with provenance
 */

import type { Logger } from "pino";
import type { PaseoState } from "./paseo-state.js";
import { deriveHandoffScope, type HandoffScope } from "./feltdb/schema.js";

/**
 * Action being authorized - the caller specifies what they want to do
 * and the guard validates it against active authority.
 */
export interface AuthorizedAction {
  /** Agent performing the action */
  agentId: string;
  /** Operation type (update, create, delete, execute, etc.) */
  operation: "create" | "update" | "delete" | "execute" | "commit" | "publish";
  /** Entity type being acted upon */
  entityType:
    | "task"
    | "workspace"
    | "repository"
    | "run"
    | "handoff"
    | "observation"
    | "decision"
    | "message";
  /** Entity ID being acted upon */
  entityId: string;
  /** Optional: entity's task scope (may be undefined for workspace-level entities) */
  taskId?: string;
  /** Optional: entity's workspace scope */
  workspaceId?: string;
  /** Optional: entity's project scope */
  projectId?: string;
  /** Optional: run ID for provenance */
  runId?: string;
  /** Optional: context for error messages */
  context?: Record<string, unknown>;
}

/**
 * Authorization result - the decision and reasoning
 */
export interface AuthorizationResult {
  authorized: boolean;
  reason: string;
  scope?: HandoffScope | null;
}

/**
 * AuthorityGuard - Durable enforcement of handoff scopes at mutation boundary
 */
export class AuthorityGuard {
  private paseoState: PaseoState;
  private logger: Logger;

  constructor(paseoState: PaseoState, logger: Logger) {
    this.paseoState = paseoState;
    this.logger = logger.child({ module: "authority-guard" });
  }

  /**
   * Authorize an action against current agent authority.
   *
   * Flow:
   * 1. Reconstruct active handoff scope from FeltDB
   * 2. If no handoff: allow (default authorization)
   * 3. If handoff active: enforce strict scope
   * 4. Return authorization result with reasoning
   *
   * @throws Error if authorization denied
   */
  async authorize(action: AuthorizedAction): Promise<AuthorizationResult> {
    this.logger.debug(
      {
        agentId: action.agentId,
        operation: action.operation,
        entityType: action.entityType,
        entityId: action.entityId,
        taskId: action.taskId,
        workspaceId: action.workspaceId,
      },
      "AuthorityGuard.authorize: checking action"
    );

    // 1. RECONSTRUCT ACTIVE AUTHORITY FROM FELTDB
    // Do not trust caller's claims about handoffId
    // Query durable state to derive current scope
    const activeHandoff = await this.paseoState.handoffs.getActiveForTarget(
      action.agentId
    );
    const scope = activeHandoff ? deriveHandoffScope(activeHandoff) : null;

    // 2. IF NO HANDOFF: ALLOW (default authorization via project membership)
    if (!scope) {
      this.logger.debug(
        { agentId: action.agentId },
        "AuthorityGuard: No active handoff - default authorization"
      );
      return {
        authorized: true,
        reason: "No active handoff - default project-level authorization",
        scope: null,
      };
    }

    // 3. IF HANDOFF ACTIVE: ENFORCE STRICT SCOPE
    // Every action must be within the handoff boundary
    const result = this.checkScopeBoundary(action, scope);

    if (!result.authorized) {
      this.logger.warn(
        {
          agentId: action.agentId,
          handoffId: scope.handoffId,
          operation: action.operation,
          entityType: action.entityType,
          actionTaskId: action.taskId,
          scopeTaskId: scope.taskId,
          actionWorkspaceId: action.workspaceId,
          scopeWorkspaceId: scope.workspaceId,
        },
        `AuthorityGuard: Action DENIED - outside handoff scope`
      );

      throw new Error(
        `Authority denied: ${action.operation} on ${action.entityType} ` +
          `outside handoff scope. ${result.reason}`
      );
    }

    this.logger.debug(
      {
        agentId: action.agentId,
        handoffId: scope.handoffId,
        operation: action.operation,
      },
      "AuthorityGuard: Action ALLOWED - within handoff scope"
    );

    return {
      authorized: true,
      reason: `Action within active handoff scope (${scope.handoffId})`,
      scope,
    };
  }

  /**
   * Check if action respects handoff scope boundaries.
   *
   * Rules:
   * - If handoff specifies taskId: action taskId must match (or be creation within task)
   * - If handoff specifies workspaceId: action workspaceId must match
   * - If handoff specifies projectId: action projectId must match
   *
   * @private
   */
  private checkScopeBoundary(
    action: AuthorizedAction,
    scope: HandoffScope
  ): { authorized: boolean; reason: string } {
    // Rule 1: Project scope
    // All actions must be within the handoff's project
    if (action.projectId && action.projectId !== scope.projectId) {
      return {
        authorized: false,
        reason: `Project ${action.projectId} outside handoff scope (${scope.projectId})`,
      };
    }

    // Rule 2: Workspace scope (if specified in handoff)
    // If handoff binds to a specific workspace, action must be within it
    if (scope.workspaceId && action.workspaceId && action.workspaceId !== scope.workspaceId) {
      return {
        authorized: false,
        reason: `Workspace ${action.workspaceId} outside handoff scope (${scope.workspaceId})`,
      };
    }

    // Rule 3: Task scope (if specified in handoff)
    // If handoff binds to a specific task, action must be within it
    if (scope.taskId && action.taskId && action.taskId !== scope.taskId) {
      return {
        authorized: false,
        reason: `Task ${action.taskId} outside handoff scope (${scope.taskId})`,
      };
    }

    // Special case: Handoff operations require explicit authorization
    if (action.entityType === "handoff") {
      // Cannot create new handoffs while under delegation
      if (action.operation === "create") {
        return {
          authorized: false,
          reason: "Cannot create new handoffs while under existing handoff delegation",
        };
      }
      // Cannot modify handoffs outside of completing/rejecting current one
      if (action.operation === "update" && action.entityId !== scope.handoffId) {
        return {
          authorized: false,
          reason: `Cannot modify handoff ${action.entityId} while under different handoff delegation`,
        };
      }
    }

    return { authorized: true, reason: "" };
  }
}

/**
 * Create an AuthorityGuard instance
 */
export function createAuthorityGuard(
  paseoState: PaseoState,
  logger: Logger
): AuthorityGuard {
  return new AuthorityGuard(paseoState, logger);
}

import type { AgentGoal, AgentGoalStatus } from "@getpaseo/protocol/agent-types";

export type GoalAction = "pause" | "resume" | "clear";

export function goalStatusKey(status: AgentGoalStatus): `goals.status.${AgentGoalStatus}` {
  return `goals.status.${status}`;
}

export function goalActions(goal: AgentGoal): GoalAction[] {
  if (goal.status === "complete") return ["clear"];
  return goal.status === "paused" ? ["resume", "clear"] : ["pause", "clear"];
}

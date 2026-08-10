import { describe, expect, test } from "vitest";
import type { AgentGoal } from "@getpaseo/protocol/agent-types";
import { goalActions, goalStatusKey } from "./presentation";

const goal: AgentGoal = {
  objective: "Ship persistent goal controls",
  status: "active",
  tokenBudget: null,
  tokensUsed: 0,
  timeUsedSeconds: 0,
};

describe("goal presentation", () => {
  test("offers pause for active goals and resume for paused goals", () => {
    expect(goalActions(goal)).toEqual(["pause", "clear"]);
    expect(goalActions({ ...goal, status: "paused" })).toEqual(["resume", "clear"]);
    expect(goalActions({ ...goal, status: "complete" })).toEqual(["clear"]);
  });

  test("maps limit states to stable translation keys", () => {
    expect(goalStatusKey("usageLimited")).toBe("goals.status.usageLimited");
    expect(goalStatusKey("budgetLimited")).toBe("goals.status.budgetLimited");
  });
});

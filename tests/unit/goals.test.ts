import { describe, expect, it } from "vitest";
import { createGoalRegistry } from "../../pi/extensions/agentdev/goals";

// AC-TOGGLE-5: any message while ON is treated as a goal entering the workflow.
// AC-TOGGLE-6: a second goal creates a second sub-tree (multi-goal).

describe("goal registry (AC-TOGGLE-5/6)", () => {
  it("records a goal with its text and a sequence id", () => {
    const g = createGoalRegistry();
    const goal = g.add("build a todo app");
    expect(goal.goalId).toBe("goal-1");
    expect(goal.text).toBe("build a todo app");
    expect(goal.status).toBe("in-flight");
    expect(g.count()).toBe(1);
  });

  it("every goal gets its own sub-tree id — second goal = second sub-tree (AC-TOGGLE-6)", () => {
    const g = createGoalRegistry();
    const g1 = g.add("first goal");
    const g2 = g.add("second goal");
    expect(g1.subtreeId).not.toBe(g2.subtreeId);
    expect(g.all().map((x) => x.subtreeId)).toEqual(["t1", "t2"]);
  });

  it("multiple goals coexist (multi-goal fleet)", () => {
    const g = createGoalRegistry();
    g.add("goal a");
    g.add("goal b");
    g.add("goal c");
    expect(g.count()).toBe(3);
    expect(g.inFlight()).toHaveLength(3);
  });

  it("completing a goal moves it out of in-flight; unknown id throws", () => {
    const g = createGoalRegistry();
    const goal = g.add("one-off task");
    const done = g.complete(goal.goalId);
    expect(done.status).toBe("completed");
    expect(g.inFlight()).toHaveLength(0);
    expect(() => g.complete("goal-999")).toThrow();
  });

  it("blank messages are not goals", () => {
    const g = createGoalRegistry();
    expect(() => g.add("   ")).toThrow();
    expect(() => g.add("")).toThrow();
  });

  it("ids are stable per registry instance", () => {
    const a = createGoalRegistry();
    const b = createGoalRegistry();
    expect(a.add("x").goalId).toBe("goal-1");
    expect(b.add("y").goalId).toBe("goal-1"); // fresh registry restarts ids
  });
});

/**
 * goals — goal entry + multi-goal registry (AC-TOGGLE-5/6).
 *
 * AC-TOGGLE-5: any message while agentdev is ON is treated as a goal entering
 * the workflow (manual phase). AC-TOGGLE-6: a second goal while one is in
 * flight creates a SECOND sub-tree in the fleet (multi-goal). Deterministic —
 * unit-tested; wired to the `before_agent_start` hook in index.ts.
 */

export type GoalStatus = "in-flight" | "completed";

export interface Goal {
  /** "goal-1", "goal-2", … — stable per registry. */
  goalId: string;
  text: string;
  status: GoalStatus;
  /** One fleet sub-tree per goal: "t1", "t2", … (AC-TOGGLE-6). */
  subtreeId: string;
}

export interface GoalRegistry {
  add(text: string): Goal;
  complete(goalId: string): Goal;
  get(goalId: string): Goal | undefined;
  all(): Goal[];
  inFlight(): Goal[];
  count(): number;
}

export function createGoalRegistry(): GoalRegistry {
  let seq = 0;
  const goals = new Map<string, Goal>();

  const add = (text: string): Goal => {
    if (!text.trim()) throw new Error("a goal must be non-empty text");
    seq += 1;
    const goal: Goal = {
      goalId: `goal-${seq}`,
      text: text.trim(),
      status: "in-flight",
      subtreeId: `t${seq}`,
    };
    goals.set(goal.goalId, goal);
    return goal;
  };

  const complete = (goalId: string): Goal => {
    const goal = goals.get(goalId);
    if (!goal) throw new Error(`unknown goal: ${goalId}`);
    goal.status = "completed";
    return goal;
  };

  return {
    add,
    complete,
    get: (goalId) => goals.get(goalId),
    all: () => [...goals.values()],
    inFlight: () => [...goals.values()].filter((g) => g.status === "in-flight"),
    count: () => goals.size,
  };
}

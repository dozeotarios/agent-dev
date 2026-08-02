import { describe, expect, it } from "vitest";
import {
  dispatchPlan,
  completeWorker,
  type Plan,
} from "../../pi/extensions/agentdev/dispatch";
import { createWorktreePool } from "../../pi/extensions/agentdev/worktree";

// AC-DISPATCH-1/2: 1 plan -> exactly 1 Subleader; 1 story -> exactly 1 Subworker
// with its own worktree; no two Subworkers share a worktree (AC-DISPATCH-3).
describe("autopilot dispatch (AC-DISPATCH-1/2/3)", () => {
  function pool(maxSize = 10) {
    let n = 0;
    return createWorktreePool({ maxSize, create: () => `wt-${n++}` });
  }

  it("1 plan -> exactly 1 Subleader", () => {
    const plan: Plan = { planId: "plan-a", stories: [{ storyId: "s1" }] };
    const res = dispatchPlan(plan, pool());
    expect(res.subleader).toEqual({ role: "subleader", planId: "plan-a" });
  });

  it("1 story -> exactly 1 Subworker with its own worktree (1:1)", () => {
    const plan: Plan = { planId: "plan-a", stories: [{ storyId: "s1" }] };
    const res = dispatchPlan(plan, pool());
    expect(res.workers).toHaveLength(1);
    expect(res.workers[0]).toMatchObject({ role: "subworker", storyId: "s1" });
    expect(res.workers[0].worktreePath).toBeTruthy();
  });

  it("N stories -> N Subworkers, each with a DISTINCT worktree", () => {
    const plan: Plan = {
      planId: "plan-a",
      stories: [{ storyId: "s1" }, { storyId: "s2" }, { storyId: "s3" }],
    };
    const res = dispatchPlan(plan, pool());
    expect(res.workers).toHaveLength(3);
    const paths = res.workers.map((w) => w.worktreePath);
    expect(new Set(paths).size).toBe(3); // never shared (AC-DISPATCH-3)
    expect(res.workers.map((w) => w.storyId)).toEqual(["s1", "s2", "s3"]);
  });

  it("rejects a plan with no stories", () => {
    expect(() => dispatchPlan({ planId: "p", stories: [] }, pool())).toThrow(/at least one story/);
  });

  it("rejects duplicate story ids", () => {
    const plan: Plan = { planId: "p", stories: [{ storyId: "s1" }, { storyId: "s1" }] };
    expect(() => dispatchPlan(plan, pool())).toThrow(/duplicate/);
  });

  it("completeWorker releases the worktree back to the pool (reusable)", () => {
    const p = pool();
    const plan: Plan = { planId: "p", stories: [{ storyId: "s1" }] };
    const res = dispatchPlan(plan, p);
    expect(p.inUse()).toHaveLength(1);
    completeWorker(res.workers[0], p);
    expect(p.inUse()).toHaveLength(0);
    expect(p.acquire()).toBe(res.workers[0].worktreePath); // reused for the next story
  });

  it("dispatch consumes one worktree per story from the pool", () => {
    const p = pool(2);
    const plan: Plan = { planId: "p", stories: [{ storyId: "s1" }, { storyId: "s2" }] };
    dispatchPlan(plan, p);
    expect(() => p.acquire()).toThrow(/exhausted/);
  });
});

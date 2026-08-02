import { describe, expect, it } from "vitest";
import {
  LENSES,
  evaluateRound,
  createReviewLoop,
  routeToWorkers,
  type Finding,
} from "../../pi/extensions/agentdev/review";
import { dispatchPlan } from "../../pi/extensions/agentdev/dispatch";
import { createWorktreePool } from "../../pi/extensions/agentdev/worktree";

// AC-REVIEW-1: exactly the 6 lenses.
describe("6 lenses (AC-REVIEW-1)", () => {
  it("has exactly the 6 lenses in order", () => {
    expect(LENSES).toEqual([
      "senior-swe",
      "efficiency",
      "security",
      "api-contract",
      "reliability",
      "domain",
    ]);
    expect(LENSES.length).toBe(6);
  });
});

// AC-REVIEW-3/4: findings evaluated per round; nits never block.
describe("evaluateRound (AC-REVIEW-3/4)", () => {
  it("no findings → clean", () => {
    expect(evaluateRound([]).status).toBe("clean");
  });

  it("informational nits do NOT block (AC-REVIEW-4)", () => {
    const nits: Finding[] = [
      { lens: "senior-swe", severity: "nit", text: "rename this var", storyId: "s1" },
      { lens: "efficiency", severity: "nit", text: "could be faster", storyId: null },
    ];
    const r = evaluateRound(nits);
    expect(r.status).toBe("clean");
    expect(r.nits).toHaveLength(2);
  });

  it("any blocking finding → rework; blocking separated from nits", () => {
    const findings: Finding[] = [
      { lens: "security", severity: "blocking", text: "SQL injection", storyId: "s1" },
      { lens: "senior-swe", severity: "nit", text: "style", storyId: null },
    ];
    const r = evaluateRound(findings);
    expect(r.status).toBe("rework");
    expect(r.blocking).toHaveLength(1);
    expect(r.blocking[0].text).toBe("SQL injection");
    expect(r.nits).toHaveLength(1);
  });

  it("routes to the unique story ids that own the findings", () => {
    const r = evaluateRound([
      { lens: "security", severity: "blocking", text: "x", storyId: "s1" },
      { lens: "reliability", severity: "blocking", text: "y", storyId: "s3" },
      { lens: "reliability", severity: "blocking", text: "z", storyId: "s3" },
    ]);
    expect(r.storyIds).toEqual(["s1", "s3"]);
  });

  it("rejects findings with an unknown severity", () => {
    expect(() =>
      evaluateRound([{ lens: "domain", severity: "maybe" as never, text: "?", storyId: null }]),
    ).toThrow();
  });
});

// AC-REVIEW-3: loop terminates at "no actionable findings".
describe("review loop (AC-REVIEW-3)", () => {
  it("clean round 1 → complete", () => {
    const loop = createReviewLoop();
    const r = loop.submitRound([]);
    expect(r.status).toBe("clean");
    expect(loop.round()).toBe(1);
    expect(loop.isComplete()).toBe(true);
  });

  it("rework round → re-review → clean → complete", () => {
    const loop = createReviewLoop();
    const r1 = loop.submitRound([
      { lens: "security", severity: "blocking", text: "x", storyId: "s1" },
    ]);
    expect(r1.status).toBe("rework");
    expect(loop.round()).toBe(1);
    expect(loop.isComplete()).toBe(false);
    const r2 = loop.submitRound([]); // fixed
    expect(r2.status).toBe("clean");
    expect(loop.round()).toBe(2);
    expect(loop.isComplete()).toBe(true);
  });

  it("caps at max rounds → complete with remaining blocking (escalation: retries exhausted)", () => {
    const loop = createReviewLoop(3);
    const blocking: Finding[] = [
      { lens: "security", severity: "blocking", text: "still broken", storyId: "s1" },
    ];
    for (let i = 0; i < 3; i++) {
      const r = loop.submitRound(blocking);
      if (i < 2) expect(r.status).toBe("rework");
    }
    expect(loop.isComplete()).toBe(true);
    expect(loop.remainingBlocking()).toHaveLength(1);
    expect(loop.remainingBlocking()[0].text).toBe("still broken");
  });

  it("nits across every round never trigger rework", () => {
    const loop = createReviewLoop(5);
    const nits: Finding[] = [{ lens: "efficiency", severity: "nit", text: "n", storyId: "s1" }];
    const r = loop.submitRound(nits);
    expect(r.status).toBe("clean");
    expect(loop.isComplete()).toBe(true);
  });

  it("rejects submissions after completion", () => {
    const loop = createReviewLoop();
    loop.submitRound([]);
    expect(() => loop.submitRound([])).toThrow(/finished/);
  });
});

// Routing: blocking findings go back to the workers that own those stories.
describe("routeToWorkers", () => {
  function workersFor(storyIds: string[]) {
    let n = 0;
    const pool = createWorktreePool({ maxSize: 10, create: () => `wt-${n++}` });
    return dispatchPlan({ planId: "p", stories: storyIds.map((storyId) => ({ storyId })) }, pool).workers;
  }

  it("routes blocking findings to the correct Subworkers (AC-REVIEW-3)", () => {
    const workers = workersFor(["s1", "s2", "s3"]);
    const routed = routeToWorkers(
      [
        { lens: "security", severity: "blocking", text: "x", storyId: "s1" },
        { lens: "reliability", severity: "blocking", text: "y", storyId: "s3" },
      ],
      workers,
    );
    expect(routed.map((w) => w.storyId)).toEqual(["s1", "s3"]);
  });

  it("no blocking findings → no workers routed", () => {
    const workers = workersFor(["s1"]);
    expect(routeToWorkers([], workers)).toEqual([]);
  });
});

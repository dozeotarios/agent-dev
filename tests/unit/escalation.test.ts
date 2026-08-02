import { describe, expect, it } from "vitest";
import {
  createEscalationPolicy,
  type EscalationEvent,
} from "../../pi/extensions/agentdev/escalation";

// AC-ESCAL-1: self-handles recoverable failures up to per-kind budgets.
// AC-ESCAL-2: escalates only on the 3 triggers.
// AC-ESCAL-3: pauses only the blocked branch; others keep running.

describe("escalation policy — self-healable failures (AC-ESCAL-1)", () => {
  it("flaky-test: self-handles attempts 1..maxRetries, escalates on exhaustion", () => {
    const p = createEscalationPolicy({ maxRetries: 3, maxReviewRounds: 5 });
    for (let attempt = 1; attempt <= 3; attempt++) {
      const d = p.handle({ branchId: "b1", kind: "flaky-test", attempt });
      expect(d.escalate).toBe(false);
      expect(d.reason).toBeNull();
      expect(d.notifyOperator).toBe(false);
      expect(d.pauseBranch).toBeNull();
    }
    const d = p.handle({ branchId: "b1", kind: "flaky-test", attempt: 4 });
    expect(d.escalate).toBe(true);
    expect(d.reason).toBe("retries-exhausted");
    expect(d.notifyOperator).toBe(true);
  });

  it("transient-error: same self-heal budget as flaky-test", () => {
    const p = createEscalationPolicy({ maxRetries: 2, maxReviewRounds: 5 });
    expect(p.handle({ branchId: "b2", kind: "transient-error", attempt: 1 }).escalate).toBe(false);
    expect(p.handle({ branchId: "b2", kind: "transient-error", attempt: 2 }).escalate).toBe(false);
    expect(p.handle({ branchId: "b2", kind: "transient-error", attempt: 3 }).escalate).toBe(true);
  });

  it("review-loop: self-heals up to maxReviewRounds (mirrors createReviewLoop)", () => {
    const p = createEscalationPolicy({ maxRetries: 3, maxReviewRounds: 5 });
    for (let attempt = 1; attempt <= 5; attempt++) {
      expect(p.handle({ branchId: "b3", kind: "review-loop", attempt }).escalate).toBe(false);
    }
    expect(p.handle({ branchId: "b3", kind: "review-loop", attempt: 6 }).escalate).toBe(true);
  });

  it("build-failure: rebuilds up to maxRetries, then escalates", () => {
    const p = createEscalationPolicy({ maxRetries: 3, maxReviewRounds: 5 });
    p.handle({ branchId: "b4", kind: "build-failure", attempt: 1 });
    p.handle({ branchId: "b4", kind: "build-failure", attempt: 2 });
    p.handle({ branchId: "b4", kind: "build-failure", attempt: 3 });
    const d = p.handle({ branchId: "b4", kind: "build-failure", attempt: 4 });
    expect(d.escalate).toBe(true);
    expect(d.reason).toBe("retries-exhausted");
  });

  it("budgets are independent per kind — a flaky-test exhaustion never escalates a fresh build-failure", () => {
    const p = createEscalationPolicy({ maxRetries: 2, maxReviewRounds: 5 });
    expect(p.handle({ branchId: "b5", kind: "flaky-test", attempt: 3 }).escalate).toBe(true);
    // build budget untouched: attempt 1..2 still self-heal
    expect(p.handle({ branchId: "b5", kind: "build-failure", attempt: 1 }).escalate).toBe(false);
    expect(p.handle({ branchId: "b5", kind: "build-failure", attempt: 2 }).escalate).toBe(false);
  });

  it("no cross-branch state — one branch's exhaustion never affects another branch (AC-ESCAL-3)", () => {
    const p = createEscalationPolicy({ maxRetries: 1, maxReviewRounds: 5 });
    expect(p.handle({ branchId: "branch-a", kind: "flaky-test", attempt: 2 }).escalate).toBe(true);
    // branch-b's FIRST failure still self-heals despite branch-a's exhaustion
    expect(p.handle({ branchId: "branch-b", kind: "flaky-test", attempt: 1 }).escalate).toBe(false);
  });
});

describe("escalation policy — only the 3 triggers escalate (AC-ESCAL-2)", () => {
  it("unsettled product/architecture decision → immediate escalation", () => {
    const p = createEscalationPolicy();
    const d = p.handle({ branchId: "b6", kind: "unsettled-decision", attempt: 1 });
    expect(d.escalate).toBe(true);
    expect(d.reason).toBe("unsettled-decision");
    expect(d.notifyOperator).toBe(true);
  });

  it("explicit needs-human → immediate escalation", () => {
    const p = createEscalationPolicy();
    const d = p.handle({ branchId: "b7", kind: "needs-human", attempt: 1 });
    expect(d.escalate).toBe(true);
    expect(d.reason).toBe("needs-human");
    expect(d.notifyOperator).toBe(true);
  });

  it("escalation is immediate even on attempt 1 for the human triggers", () => {
    const p = createEscalationPolicy({ maxRetries: 100, maxReviewRounds: 100 });
    expect(p.handle({ branchId: "b8", kind: "unsettled-decision", attempt: 1 }).escalate).toBe(true);
    expect(p.handle({ branchId: "b9", kind: "needs-human", attempt: 1 }).escalate).toBe(true);
  });

  it("unknown failure kind → throws (no silent mis-classification)", () => {
    const p = createEscalationPolicy();
    expect(() =>
      p.handle({ branchId: "b10", kind: "alien-invasion" as never, attempt: 1 }),
    ).toThrow();
  });
});

describe("escalation policy — pauses only the blocked branch (AC-ESCAL-3)", () => {
  it("pauseBranch is exactly the escalated branch, never the whole crew", () => {
    const p = createEscalationPolicy({ maxRetries: 1, maxReviewRounds: 5 });
    const d = p.handle({ branchId: "branch-alpha", kind: "build-failure", attempt: 2 });
    expect(d.pauseBranch).toBe("branch-alpha");
    // other branches are untouched: a fresh event on another branch still self-heals
    expect(p.handle({ branchId: "branch-beta", kind: "flaky-test", attempt: 1 }).escalate).toBe(false);
  });

  it("recoverable handling never touches any branch", () => {
    const p = createEscalationPolicy();
    const d = p.handle({ branchId: "branch-gamma", kind: "transient-error", attempt: 1 });
    expect(d.pauseBranch).toBeNull();
  });
});

// (moved from tests/evals/escalation.eval.ts — this is DETERMINISTIC policy
// coverage, not an agentic eval; the agentic layer is the 3 real-model evals)
describe("escalation fixture replay (was mislabeled an 'agentic eval')", () => {
  it("recorded failure logs fire ONLY the 3 triggers and pause only the blocked branch", () => {
    const policy = createEscalationPolicy({ maxRetries: 3, maxReviewRounds: 5 });
    const logs = {
      "story-a": [
        { branchId: "story-a", kind: "flaky-test" as const, attempt: 1 },
        { branchId: "story-a", kind: "flaky-test" as const, attempt: 2 },
        { branchId: "story-a", kind: "build-failure" as const, attempt: 1 },
        { branchId: "story-a", kind: "build-failure" as const, attempt: 2 },
        { branchId: "story-a", kind: "build-failure" as const, attempt: 3 },
        { branchId: "story-a", kind: "build-failure" as const, attempt: 4 },
      ],
      "story-b": [
        { branchId: "story-b", kind: "review-loop" as const, attempt: 1 },
        { branchId: "story-b", kind: "review-loop" as const, attempt: 5 },
        { branchId: "story-b", kind: "review-loop" as const, attempt: 6 },
      ],
      "story-c": [{ branchId: "story-c", kind: "unsettled-decision" as const, attempt: 1 }],
      "story-d": [{ branchId: "story-d", kind: "needs-human" as const, attempt: 1 }],
      "story-e": [
        { branchId: "story-e", kind: "transient-error" as const, attempt: 1 },
        { branchId: "story-e", kind: "transient-error" as const, attempt: 2 },
        { branchId: "story-e", kind: "transient-error" as const, attempt: 3 },
        { branchId: "story-e", kind: "transient-error" as const, attempt: 4 },
      ],
    };
    const decisions = Object.values(logs).flat().map((e) => policy.handle(e));
    const escalated = decisions.filter((d) => d.escalate);
    expect(escalated.filter((d) => d.reason === "retries-exhausted")).toHaveLength(3);
    expect(new Set(escalated.map((d) => d.reason))).toEqual(
      new Set(["retries-exhausted", "unsettled-decision", "needs-human"]),
    );
    for (const d of decisions.filter((x) => !x.escalate)) {
      expect(d.notifyOperator).toBe(false);
      expect(d.pauseBranch).toBeNull();
    }
    expect(new Set(escalated.map((d) => d.pauseBranch)).size).toBe(escalated.length);
  });
});

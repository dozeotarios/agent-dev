import { describe, expect, it } from "vitest";
import { createConsensusLoop, pickBest, isHighRisk } from "../../pi/extensions/agentdev/ralplan";
import { createEscalationPolicy, createEscalationTracker } from "../../pi/extensions/agentdev/escalation";
import { autocloseDecision, UNATTENDED_TIMEOUT_MS } from "../../pi/extensions/agentdev/autoclose";
import { createCommitGate, type GateState } from "../../pi/extensions/agentdev/git-gate";
import { parsePorcelain, unquoteGitPath } from "../../pi/extensions/agentdev/git-state";
import { dispatchPlan, type Story } from "../../pi/extensions/agentdev/dispatch";
import { createWorktreePool, pruneStaleLeases } from "../../pi/extensions/agentdev/worktree";
import { constraintsToChecklist, createReviewLoop } from "../../pi/extensions/agentdev/review";

// Review-closure tests: every policy fix from the 27-pass harsh review.

describe("ralplan: best-plan honesty (AC-RALPLAN-5)", () => {
  it("exhaustion after all-REJECT verdicts yields NO bestPlan (never dispatch a rejected plan)", () => {
    const loop = createConsensusLoop(3);
    for (let r = 1; r <= 3; r++) {
      loop.submit({ role: "planner", content: `plan v${r}` });
      loop.submit({ role: "architect", content: "SOUND" });
      loop.submit({ role: "developer", content: "FEASIBLE" });
      loop.submit({ role: "critic", content: "REJECT", verdict: "reject" });
    }
    const s = loop.state();
    expect(s.exhausted).toBe(true);
    expect(s.approved).toBe(false);
    expect(s.bestPlan).toBeNull();
  });

  it("exhaustion after ITERATE rounds yields the fewest-findings version", () => {
    const loop = createConsensusLoop(2);
    loop.submit({ role: "planner", content: "plan A" });
    loop.submit({ role: "architect", content: "SOUND" });
    loop.submit({ role: "developer", content: "FEASIBLE" });
    loop.submit({ role: "critic", content: "ITERATE 3 findings", verdict: "iterate", findings: ["a", "b", "c"] });
    loop.submit({ role: "planner", content: "plan B" });
    loop.submit({ role: "architect", content: "SOUND" });
    loop.submit({ role: "developer", content: "FEASIBLE" });
    loop.submit({ role: "critic", content: "ITERATE 1 finding", verdict: "iterate", findings: ["a"] });
    const s = loop.state();
    expect(s.exhausted).toBe(true);
    expect(s.bestPlan).toBe("plan B"); // fewest findings
  });

  it("pickBest: approved wins; reject-only → null", () => {
    expect(
      pickBest([
        { round: 1, content: "a", verdict: "iterate", findings: ["x"] },
        { round: 2, content: "b", verdict: "approve", findings: [] },
      ]),
    ).toBe("b");
    expect(pickBest([{ round: 1, content: "a", verdict: "reject", findings: ["x"] }])).toBeNull();
    expect(pickBest([])).toBeNull();
  });
});

describe("ralplan: isHighRisk token matching (AC-RALPLAN-6)", () => {
  it("no more substring false positives", () => {
    expect(isHighRisk("add a dropdown menu to the UI", [])).toBe(false); // "drop" inside "dropdown"
    expect(isHighRisk("add swipe gesture navigation", [])).toBe(false); // "wipe" inside "swipe"
    expect(isHighRisk("clean up temp files", [])).toBe(false);
    // intended keywords still trigger on exact tokens (conservative by design)
    expect(isHighRisk("recreate the cache entry", [])).toBe(true); // exact "recreate" token
    expect(isHighRisk("update the production docs link", [])).toBe(true); // production-touching
  });

  it("genuine destructive phrasing triggers (incl. previously-missed delete/reset)", () => {
    expect(isHighRisk("drop the users table", [])).toBe(true);
    expect(isHighRisk("delete the user table", [])).toBe(true);
    expect(isHighRisk("reset the database", [])).toBe(true);
    expect(isHighRisk("migrate the schema", [])).toBe(true);
    expect(isHighRisk("build a todo app", [])).toBe(false);
    expect(isHighRisk("build a todo app", ["pii compliance"])).toBe(true);
  });
});

describe("escalation: monotonic tracker (review closure)", () => {
  it("a caller resetting attempt to 1 cannot suppress escalation", () => {
    const policy = createEscalationPolicy({ maxRetries: 3, maxReviewRounds: 5 });
    const tracker = createEscalationTracker(policy);
    // caller always reports attempt 1 — tracker enforces monotonicity
    for (let i = 1; i <= 4; i++) {
      tracker.handle({ branchId: "b1", kind: "flaky-test", attempt: 1 });
    }
    // 4th occurrence: tracked attempt 4 > 3 → escalate
    const d = tracker.handle({ branchId: "b1", kind: "flaky-test", attempt: 1 });
    expect(d.escalate).toBe(true);
    expect(d.reason).toBe("retries-exhausted");
  });

  it("per-branch isolation is preserved through the tracker (AC-ESCAL-3)", () => {
    const policy = createEscalationPolicy({ maxRetries: 1, maxReviewRounds: 5 });
    const tracker = createEscalationTracker(policy);
    expect(tracker.handle({ branchId: "a", kind: "build-failure", attempt: 1 }).escalate).toBe(false);
    expect(tracker.handle({ branchId: "a", kind: "build-failure", attempt: 1 }).escalate).toBe(true);
    // branch b's budget untouched
    expect(tracker.handle({ branchId: "b", kind: "build-failure", attempt: 1 }).escalate).toBe(false);
  });
});

describe("autoclose: working-stall ping (AC-CLOSE-5)", () => {
  it("a worker stuck in working past the timeout is pinged, not ignored", () => {
    expect(
      autocloseDecision({ role: "subworker", status: "working", handled: false, unattendedMs: UNATTENDED_TIMEOUT_MS }),
    ).toBe("ping");
    expect(
      autocloseDecision({ role: "subworker", status: "unknown", handled: false, unattendedMs: UNATTENDED_TIMEOUT_MS + 1 }),
    ).toBe("ping");
  });

  it("fresh working nodes stay; blocked semantics unchanged", () => {
    expect(
      autocloseDecision({ role: "subworker", status: "working", handled: false, unattendedMs: 1_000 }),
    ).toBe("stay");
    expect(
      autocloseDecision({ role: "subworker", status: "blocked", handled: true, unattendedMs: 0 }),
    ).toBe("close");
    expect(autocloseDecision({ role: "leader", status: "blocked", handled: false, unattendedMs: 999_999 })).toBe("stay");
  });
});

describe("git-gate: durability + terminal committed (AC-GIT-1/2)", () => {
  it("committed is terminal — markCommitReady after commit throws", () => {
    const gate = createCommitGate("direct-PR");
    gate.markCommitReady();
    gate.confirm();
    expect(() => gate.markCommitReady()).toThrow(/terminal/);
  });

  it("phase + hash persist through the injected store (crash between confirm and commit)", () => {
    let stored: GateState | null = null;
    const persist = {
      load: () => stored,
      save: (s: GateState) => {
        stored = s;
      },
    };
    const gate = createCommitGate("direct-PR", persist);
    gate.markCommitReady();
    gate.confirm();
    gate.recordCommit("/wt/a", "abc123");
    expect(stored).toEqual({ phase: "committed", lastCommitHash: "abc123", commits: { "/wt/a": "abc123" } });

    // a fresh gate on restart reads the persisted state — no double-commit window
    const revived = createCommitGate("direct-PR", persist);
    expect(revived.state().phase).toBe("committed");
    expect(revived.state().commits["/wt/a"]).toBe("abc123");
    expect(() => revived.markCommitReady()).toThrow(/terminal/);
  });

  it("recordCommit requires committed phase", () => {
    const gate = createCommitGate("direct-PR");
    expect(() => gate.recordCommit("/wt/x", "deadbeef")).toThrow();
  });
});

describe("git-state: porcelain renames + quoted paths (AC-GIT-3)", () => {
  it("rename entries keep both paths", () => {
    const entries = parsePorcelain("R  old.ts -> new.ts\n M src/a.ts\n?? newfile");
    expect(entries[0]).toEqual({ status: "R ", file: "old.ts", to: "new.ts" });
    expect(entries[1]).toEqual({ status: " M", file: "src/a.ts" });
    expect(entries[2]).toEqual({ status: "??", file: "newfile" });
  });

  it("C-style quoted paths are unquoted", () => {
    expect(unquoteGitPath('"weird\tname.txt"')).toBe("weird\tname.txt");
    expect(unquoteGitPath('"a\\nb.txt"')).toBe("a\nb.txt");
    expect(unquoteGitPath("plain.txt")).toBe("plain.txt");
    const entries = parsePorcelain('?? "weird\tname.txt"');
    expect(entries[0].file).toBe("weird\tname.txt");
  });
});

describe("dispatch: partial-acquire rollback (AC-DISPATCH-3/4)", () => {
  it("a mid-dispatch acquire failure releases the already-acquired worktrees", () => {
    let created = 0;
    const pool = createWorktreePool({
      maxSize: 3,
      create: () => {
        created += 1;
        if (created === 2) throw new Error("git worktree add failed");
        return `wt-${created}`;
      },
    });
    const stories: Story[] = [{ storyId: "s1" }, { storyId: "s2" }, { storyId: "s3" }];
    expect(() => dispatchPlan({ planId: "p1", stories }, pool)).toThrow(/failed/);
    expect(pool.inUse()).toHaveLength(0); // nothing stranded
    expect(pool.free()).toHaveLength(1); // wt-1 returned to free
  });
});

describe("worktree: durable leases (review closure)", () => {
  it("leases round-trip through the store and survive a restart", () => {
    let stored = { free: [] as string[], used: [] as string[] };
    const persist = {
      load: () => stored,
      save: (l: { free: string[]; used: string[] }) => {
        stored = l;
      },
    };
    let n = 0;
    const pool = createWorktreePool({ maxSize: 4, create: () => `wt-${++n}`, persist });
    const a = pool.acquire();
    const b = pool.acquire();
    pool.release(a);
    expect(stored.used).toEqual([b]);

    // "restart": a fresh pool reads the leases
    const revived = createWorktreePool({ maxSize: 4, create: () => `wt-${++n}`, persist });
    expect(revived.free()).toEqual([a]);
    expect(revived.acquire()).toBe(a); // reused, not recreated
  });

  it("pruneStaleLeases drops paths that no longer exist", () => {
    const pruned = pruneStaleLeases({ free: ["gone", "alive"], used: ["also-gone"] }, new Set(["alive"]));
    expect(pruned.free).toEqual(["alive"]);
    expect(pruned.used).toEqual([]);
  });
});

describe("review: AC-REVIEW-5 wired into the loop", () => {
  const constraints = constraintsToChecklist({
    failureModes: [],
    edgeCases: [],
    invariants: [],
    mustNots: ["no hardcoded secrets"],
  });

  it("zero blocking findings with an uncovered constraint is STILL rework", () => {
    const loop = createReviewLoop(3);
    const r = loop.submitRound([], constraints);
    expect(r.status).toBe("rework");
    expect(loop.isComplete()).toBe(false);
    expect(loop.uncovered()).toContain("no hardcoded secrets");
  });

  it("covering the constraint clears the gate", () => {
    const loop = createReviewLoop(3);
    const r = loop.submitRound(
      [{ lens: "security", severity: "blocking", text: "hardcoded secrets found", storyId: "s1" }],
      constraints,
    );
    expect(r.status).toBe("rework"); // blocking finding still rework
    expect(loop.uncovered()).not.toContain("no hardcoded secrets");
    const clean = loop.submitRound([{ lens: "security", severity: "nit", text: "nits only", storyId: null }], constraints);
    expect(clean.status).toBe("clean");
    expect(loop.isComplete()).toBe(true);
  });

  it("absence-claim findings do NOT clear the gate (negation-aware)", () => {
    const loop = createReviewLoop(3);
    const r = loop.submitRound(
      [{ lens: "security", severity: "nit", text: "we checked: there are NO hardcoded secrets", storyId: null }],
      constraints,
    );
    expect(r.status).toBe("rework");
    expect(loop.uncovered()).toContain("no hardcoded secrets");
  });
});

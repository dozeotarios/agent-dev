import { describe, expect, it } from "vitest";
import {
  createConsensusLoop,
  isHighRisk,
  validateDraftSummary,
  validatePlanOutput,
  type RalplanDrSummary,
  type PlanOutput,
} from "../../pi/extensions/agentdev/ralplan";

// AC-RALPLAN-1..5: sequential roles, APPROVE terminates, non-APPROVE loops, cap 5.
describe("consensus loop (AC-RALPLAN-1..5)", () => {
  it("starts expecting the Planner (round 1)", () => {
    const loop = createConsensusLoop();
    expect(loop.state().expectedRole).toBe("planner");
    expect(loop.state().round).toBe(1);
  });

  it("happy path: Planner → Architect → Developer → Critic APPROVE → done", () => {
    const loop = createConsensusLoop();
    loop.submit({ role: "planner", content: "plan v1" });
    expect(loop.state().expectedRole).toBe("architect");
    loop.submit({ role: "architect", content: "sound with one tradeoff" });
    expect(loop.state().expectedRole).toBe("developer");
    loop.submit({ role: "developer", content: "feasible; ~2 days" });
    expect(loop.state().expectedRole).toBe("critic");
    const state = loop.submit({ role: "critic", content: "ok", verdict: "approve" });
    expect(state.approved).toBe(true);
    expect(state.exhausted).toBe(false);
    expect(state.expectedRole).toBeNull();
    expect(state.bestPlan).toBe("plan v1");
  });

  it("ITERATE → round 2, Planner revises, then full loop again", () => {
    const loop = createConsensusLoop();
    loop.submit({ role: "planner", content: "plan v1" });
    loop.submit({ role: "architect", content: "x" });
    loop.submit({ role: "developer", content: "y" });
    const afterCritic = loop.submit({ role: "critic", content: "needs work", verdict: "iterate", findings: ["tests unclear"] });
    expect(afterCritic.approved).toBe(false);
    expect(afterCritic.round).toBe(2);
    expect(afterCritic.expectedRole).toBe("planner");
    loop.submit({ role: "planner", content: "plan v2" });
    loop.submit({ role: "architect", content: "x" });
    loop.submit({ role: "developer", content: "y" });
    const done = loop.submit({ role: "critic", content: "ok", verdict: "approve" });
    expect(done.approved).toBe(true);
    expect(done.bestPlan).toBe("plan v2");
    expect(done.round).toBe(2);
  });

  it("REJECT behaves like ITERATE (revise + loop)", () => {
    const loop = createConsensusLoop();
    loop.submit({ role: "planner", content: "p1" });
    loop.submit({ role: "architect", content: "a" });
    loop.submit({ role: "developer", content: "s" });
    const s = loop.submit({ role: "critic", content: "no", verdict: "reject" });
    expect(s.round).toBe(2);
    expect(s.expectedRole).toBe("planner");
  });

  it("caps at 5 rounds and yields the best (last) version without APPROVE", () => {
    const loop = createConsensusLoop();
    for (let round = 1; round <= 5; round++) {
      loop.submit({ role: "planner", content: `plan v${round}` });
      loop.submit({ role: "architect", content: "a" });
      loop.submit({ role: "developer", content: "s" });
      const s = loop.submit({ role: "critic", content: "nope", verdict: "iterate" });
      if (round < 5) {
        expect(s.round).toBe(round + 1);
        expect(s.expectedRole).toBe("planner");
      } else {
        expect(s.exhausted).toBe(true);
        expect(s.approved).toBe(false);
        expect(s.expectedRole).toBeNull();
        expect(s.bestPlan).toBe("plan v5"); // best version yielded
      }
    }
  });

  it("rejects out-of-order submissions", () => {
    const loop = createConsensusLoop();
    expect(() => loop.submit({ role: "critic", content: "too early", verdict: "approve" })).toThrow();
    loop.submit({ role: "planner", content: "p" });
    expect(() => loop.submit({ role: "planner", content: "p again" })).toThrow();
  });

  it("rejects submissions after the loop is finished", () => {
    const loop = createConsensusLoop();
    loop.submit({ role: "planner", content: "p" });
    loop.submit({ role: "architect", content: "a" });
    loop.submit({ role: "developer", content: "s" });
    loop.submit({ role: "critic", content: "ok", verdict: "approve" });
    expect(() => loop.submit({ role: "planner", content: "late" })).toThrow();
  });

  it("records verdicts with round + findings", () => {
    const loop = createConsensusLoop();
    loop.submit({ role: "planner", content: "p" });
    loop.submit({ role: "architect", content: "a" });
    loop.submit({ role: "developer", content: "s" });
    loop.submit({ role: "critic", content: "c", verdict: "iterate", findings: ["f1", "f2"] });
    const s = loop.state();
    expect(s.verdicts).toHaveLength(1);
    expect(s.verdicts[0]).toMatchObject({ round: 1, verdict: "iterate", findings: ["f1", "f2"] });
  });
});

// AC-RALPLAN-6: deliberate mode auto-triggers on high-risk signals.
describe("deliberate mode trigger (AC-RALPLAN-6)", () => {
  it("triggers on auth/security", () => expect(isHighRisk("add login with JWT auth", [])).toBe(true));
  it("triggers on migrations", () => expect(isHighRisk("migrate the database", [])).toBe(true));
  it("triggers on destructive changes", () => expect(isHighRisk("drop and recreate the table", [])).toBe(true));
  it("triggers on production incidents", () => expect(isHighRisk("fix the production incident", [])).toBe(true));
  it("triggers on PII/compliance", () => expect(isHighRisk("handle user PII", [])).toBe(true));
  it("triggers on public-API break", () => expect(isHighRisk("introduce a breaking change to the public API", [])).toBe(true));
  it("triggers via explicit risk signals", () => expect(isHighRisk("refactor internal utils", ["pii"])).toBe(true));
  it("does NOT trigger on a plain API", () => expect(isHighRisk("add rate limiting to the api", [])).toBe(false));
  it("does NOT trigger on benign work", () => expect(isHighRisk("build a tiny todo CLI", [])).toBe(false));
});

// AC-RALPLAN-7: output must include ADR + testable acceptance criteria (+ deliberate extras).
describe("plan output validation (AC-RALPLAN-7)", () => {
  const goodSummary: RalplanDrSummary = {
    principles: ["p1", "p2", "p3"],
    drivers: ["d1", "d2", "d3"],
    options: [
      { name: "A", pros: ["fast"], cons: ["costly"] },
      { name: "B", pros: ["cheap"], cons: ["slow"] },
    ],
  };
  const goodPlan: PlanOutput = {
    adr: {
      decision: "choose A",
      drivers: ["d1"],
      alternatives: ["B"],
      why: "fits the constraints",
      consequences: ["higher cost"],
      followups: ["benchmark"],
    },
    acceptanceCriteria: ["given X when Y then Z"],
    filePlan: {
      structure: "src/ + test/",
      create: ["src/x.ts", "test/x.test.ts"],
      modify: [],
      doNotTouch: [],
    },
  };

  it("accepts a valid RALPLAN-DR summary (3-5 principles, top-3 drivers, ≥2 options)", () => {
    expect(validateDraftSummary(goodSummary).ok).toBe(true);
  });
  it("rejects <3 principles", () => {
    expect(validateDraftSummary({ ...goodSummary, principles: ["p1", "p2"] }).ok).toBe(false);
  });
  it("rejects >5 principles", () => {
    expect(validateDraftSummary({ ...goodSummary, principles: ["1", "2", "3", "4", "5", "6"] }).ok).toBe(false);
  });
  it("rejects <3 decision drivers", () => {
    expect(validateDraftSummary({ ...goodSummary, drivers: ["d1", "d2"] }).ok).toBe(false);
  });
  it("rejects <2 viable options", () => {
    expect(validateDraftSummary({ ...goodSummary, options: [goodSummary.options[0]] }).ok).toBe(false);
  });
  it("rejects an option without cons", () => {
    expect(validateDraftSummary({ ...goodSummary, options: [{ name: "A", pros: ["x"], cons: [] }, { name: "B", pros: ["y"], cons: ["z"] }] }).ok).toBe(false);
  });

  it("accepts a valid plan output (ADR + testable acceptance criteria)", () => {
    expect(validatePlanOutput(goodPlan, { deliberate: false }).ok).toBe(true);
  });
  it("rejects empty acceptance criteria", () => {
    expect(validatePlanOutput({ ...goodPlan, acceptanceCriteria: [] }, { deliberate: false }).ok).toBe(false);
  });
  it("accepts a story split with disjoint files (AC-PLAN-STORIES)", () => {
    const res = validatePlanOutput(
      {
        ...goodPlan,
        stories: [
          { id: "story-1", criteria: ["c1"], files: { create: ["src/a.ts"], modify: [], doNotTouch: [] } },
          { id: "story-2", criteria: ["c2"], files: { create: ["src/b.ts"], modify: ["src/shared.ts"], doNotTouch: [] } },
        ],
      },
      { deliberate: false },
    );
    expect(res.ok).toBe(true);
  });

  it("rejects overlapping story files — parallel workers must never collide", () => {
    const res = validatePlanOutput(
      {
        ...goodPlan,
        stories: [
          { id: "story-1", criteria: ["c1"], files: { create: ["src/a.ts"], modify: ["src/shared.ts"], doNotTouch: [] } },
          { id: "story-2", criteria: ["c2"], files: { create: ["src/b.ts"], modify: ["src/shared.ts"], doNotTouch: [] } },
        ],
      },
      { deliberate: false },
    );
    expect(res.ok).toBe(false);
    expect(res.errors.join(" ")).toMatch(/overlapping story files/);
  });

  it("rejects a story without criteria", () => {
    const res = validatePlanOutput(
      {
        ...goodPlan,
        stories: [{ id: "story-1", criteria: [], files: { create: ["src/a.ts"], modify: [], doNotTouch: [] } }],
      },
      { deliberate: false },
    );
    expect(res.ok).toBe(false);
    expect(res.errors.join(" ")).toMatch(/missing criteria/);
  });

  it("rejects a missing ADR field", () => {
    expect(validatePlanOutput({ ...goodPlan, adr: { ...goodPlan.adr, why: "" } }, { deliberate: false }).ok).toBe(false);
  });
  it("deliberate mode requires a 3-scenario pre-mortem", () => {
    const plan = { ...goodPlan, preMortem: ["s1", "s2"] };
    expect(validatePlanOutput(plan, { deliberate: true }).ok).toBe(false);
  });
  it("deliberate mode requires the expanded test plan (unit/integration/e2e/observability)", () => {
    const plan = { ...goodPlan, preMortem: ["s1", "s2", "s3"], testPlan: ["unit", "integration", "e2e"] };
    expect(validatePlanOutput(plan, { deliberate: true }).ok).toBe(false);
  });
  it("deliberate mode is satisfied with pre-mortem + all four test levels", () => {
    const plan = {
      ...goodPlan,
      preMortem: ["s1", "s2", "s3"],
      testPlan: ["unit", "integration", "e2e", "observability"],
    };
    expect(validatePlanOutput(plan, { deliberate: true }).ok).toBe(true);
  });
  it("deliberate mode rejects a plan without the pre-mortem/test-plan extras", () => {
    expect(validatePlanOutput(goodPlan, { deliberate: true }).ok).toBe(false); // extras required
  });
});

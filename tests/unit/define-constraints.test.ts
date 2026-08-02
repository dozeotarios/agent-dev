import { describe, expect, it } from "vitest";
import {
  CATEGORY_ORDER,
  generateCandidates,
  createInterview,
} from "../../pi/extensions/agentdev/define-constraints";

const baseCtx = {
  stack: "typescript",
  scope: "build a public REST API with a database",
  existingRepo: false,
  riskSignals: [] as string[],
};

// AC-MANUAL-4: option-driven — pre-filled candidates per category, tailored to context.
describe("generateCandidates (AC-MANUAL-4)", () => {
  it("returns all 5 categories in the canonical order", () => {
    const out = generateCandidates(baseCtx);
    expect(out.map((c) => c.category)).toEqual(CATEGORY_ORDER);
  });

  it("every category has non-empty pre-filled candidates (always-items)", () => {
    const out = generateCandidates(baseCtx);
    for (const cat of out) expect(cat.items.length).toBeGreaterThan(0);
  });

  it("includes keyword-gated candidates when the context matches", () => {
    const out = generateCandidates(baseCtx);
    const failure = out.find((c) => c.category === "failure_modes")!;
    expect(failure.items.some((i) => i.id === "api_timeout")).toBe(true); // "api" in scope
    const edge = out.find((c) => c.category === "edge_cases")!;
    expect(edge.items.some((i) => i.id === "empty_input")).toBe(true);
    const invariants = out.find((c) => c.category === "invariants")!;
    expect(invariants.items.some((i) => i.id === "idempotency")).toBe(true); // db/writes
  });

  it("omits keyword-gated candidates when the context does not match", () => {
    const out = generateCandidates({ ...baseCtx, scope: "a tiny CLI tool" });
    const failure = out.find((c) => c.category === "failure_modes")!;
    expect(failure.items.some((i) => i.id === "api_timeout")).toBe(false);
  });

  it("risk signals gate security/PII candidates", () => {
    const out = generateCandidates({ ...baseCtx, riskSignals: ["auth", "pii"] });
    const dont = out.find((c) => c.category === "dont")!;
    expect(dont.items.some((i) => i.id === "no_pii_logs")).toBe(true);
  });

  it("is deterministic: same context → identical output", () => {
    expect(generateCandidates(baseCtx)).toEqual(generateCandidates(baseCtx));
  });
});

// AC-MANUAL-5: soft-gate — asked on every plan, never silently skips; "none" valid per category.
describe("constraints interview — soft-gate (AC-MANUAL-5)", () => {
  it("starts with no category answered and not complete", () => {
    const i = createInterview();
    expect(i.isComplete()).toBe(false);
    expect(i.isComplete()).toBe(false);
    expect(i.answeredCategories()).toEqual([]);
  });

  it("never auto-skips: each category requires an explicit answer", () => {
    const i = createInterview();
    i.answer("do", "none");
    i.answer("dont", ["no_pii_logs"]);
    i.answer("failure_modes", "none");
    i.answer("edge_cases", "none");
    // invariants still unanswered → incomplete
    expect(i.isComplete()).toBe(false);
    expect(i.isComplete()).toBe(false);
    i.answer("invariants", "none");
    expect(i.isComplete()).toBe(true);
  });

  it("accepts 'none' as a valid explicit answer per category", () => {
    const i = createInterview();
    i.answer("do", "none");
    expect(i.isAnswered("do")).toBe(true);
  });

  it("rejects an unknown category", () => {
    const i = createInterview();
    expect(() => i.answer("bananas" as never, "none")).toThrow();
  });

  it("surfaces the recorded answers for the plan (AC-MANUAL-6 input)", () => {
    const i = createInterview();
    i.answer("do", ["structured_logging"]);
    i.answer("dont", "none");
    i.answer("failure_modes", "none");
    i.answer("edge_cases", "none");
    i.answer("invariants", "none");
    expect(i.answers().do).toEqual(["structured_logging"]);
  });
});

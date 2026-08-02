import { describe, expect, it } from "vitest";
import {
  LENSES,
  constraintsToChecklist,
  uncoveredConstraints,
  type ReviewConstraints,
} from "../../pi/extensions/agentdev/review";

// AC-REVIEW-5: Reliability and Security reviewers validate against the
// operator's define-constraints inputs (failure modes, edge cases,
// invariants, must-nots).

const CONSTRAINTS: ReviewConstraints = {
  failureModes: ["API timeout", "disk full"],
  edgeCases: ["empty input", "huge input"],
  invariants: ["data integrity always holds", "no secrets in logs"],
  mustNots: ["no hardcoded secrets", "never swallow errors"],
};

describe("constraintsToChecklist — per-lens mapping (AC-REVIEW-5)", () => {
  it("covers all 6 lenses", () => {
    const c = constraintsToChecklist(CONSTRAINTS);
    for (const lens of LENSES) {
      expect(Array.isArray(c[lens])).toBe(true);
    }
  });

  it("security lens checks must-nots + invariants", () => {
    const c = constraintsToChecklist(CONSTRAINTS);
    expect(c.security).toContain("no hardcoded secrets");
    expect(c.security).toContain("never swallow errors");
    expect(c.security).toContain("no secrets in logs");
  });

  it("reliability lens checks failure modes + edge cases + invariants", () => {
    const c = constraintsToChecklist(CONSTRAINTS);
    expect(c.reliability).toContain("API timeout");
    expect(c.reliability).toContain("disk full");
    expect(c.reliability).toContain("empty input");
    expect(c.reliability).toContain("huge input");
    expect(c.reliability).toContain("data integrity always holds");
  });

  it("api-contract lens checks edge cases + invariants", () => {
    const c = constraintsToChecklist(CONSTRAINTS);
    expect(c["api-contract"]).toContain("empty input");
    expect(c["api-contract"]).toContain("no secrets in logs");
  });

  it("senior-swe and domain lenses carry invariants; efficiency carries edge cases", () => {
    const c = constraintsToChecklist(CONSTRAINTS);
    expect(c["senior-swe"]).toContain("data integrity always holds");
    expect(c.domain).toContain("data integrity always holds");
    expect(c.efficiency).toContain("huge input");
  });
});

describe("uncoveredConstraints — coverage gate (AC-REVIEW-5)", () => {
  const checklist = constraintsToChecklist(CONSTRAINTS);

  it("no findings → every constraint uncovered", () => {
    const gaps = uncoveredConstraints(checklist, []);
    expect(gaps.length).toBeGreaterThanOrEqual(8);
  });

  it("a finding mentioning a constraint covers it (case-insensitive)", () => {
    const gaps = uncoveredConstraints(checklist, [
      { lens: "security", severity: "blocking", text: "BLOCKING: hardcoded secrets found", storyId: "s1" },
      { lens: "reliability", severity: "blocking", text: "disk full leads to silent corruption", storyId: "s1" },
    ]);
    expect(gaps).not.toContain("no hardcoded secrets");
    expect(gaps).not.toContain("disk full");
    expect(gaps).toContain("never swallow errors"); // still uncovered
  });

  it("dedupes: covering one lens item counts for all lenses sharing it", () => {
    const gaps = uncoveredConstraints(checklist, [
      { lens: "security", severity: "blocking", text: "secrets in logs", storyId: null },
    ]);
    expect(gaps).not.toContain("no secrets in logs");
  });

  it("partial word matches do NOT count (no false coverage)", () => {
    const gaps = uncoveredConstraints(checklist, [
      { lens: "security", severity: "nit", text: "hardcoded", storyId: null },
    ]);
    expect(gaps).toContain("no hardcoded secrets");
  });
});

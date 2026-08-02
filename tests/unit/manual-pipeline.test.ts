import { describe, expect, it } from "vitest";
import {
  MANUAL_ORDER,
  nextStep,
  type ManualContext,
} from "../../pi/extensions/agentdev/manual-pipeline";

// AC-MANUAL-8: canonical sequence; choose-stack only for greenfield;
// define-constraints never skipped; handoff = null (enter ralplan).
describe("manual-phase pipeline (AC-MANUAL-8)", () => {
  it("has the canonical step order", () => {
    expect(MANUAL_ORDER).toEqual([
      "map-codebase",
      "choose-stack",
      "define-language",
      "define-constraints",
      "pick-mode",
      "enter-ralplan",
    ]);
  });

  const fresh: ManualContext = {
    existingRepo: false,
    stack: null,
    languageDone: false,
    constraintsComplete: false,
    modePicked: null,
  };

  it("greenfield starts at choose-stack (after map-codebase)", () => {
    expect(nextStep(fresh)).toBe("choose-stack");
  });

  it("an existing repo skips choose-stack entirely (stack locked)", () => {
    const base: ManualContext = {
      existingRepo: true,
      stack: "python",
      languageDone: false,
      constraintsComplete: false,
      modePicked: null,
    };
    const seen: string[] = [];
    let languageDone = false;
    let constraintsComplete = false;
    let modePicked: string | null = null;
    let s = nextStep(base);
    while (s) {
      seen.push(s);
      if (s === "define-language") languageDone = true;
      if (s === "define-constraints") constraintsComplete = true;
      if (s === "pick-mode") modePicked = "direct-PR";
      s = nextStep({ ...base, languageDone, constraintsComplete, modePicked });
    }
    expect(seen).not.toContain("choose-stack");
    expect(seen).toEqual(["define-language", "define-constraints", "pick-mode"]);
  });

  it("never skips define-constraints (soft-gate) — even after everything else", () => {
    const done: ManualContext = {
      existingRepo: false,
      stack: "typescript",
      languageDone: true,
      constraintsComplete: false,
      modePicked: "direct-PR",
    };
    expect(nextStep(done)).toBe("define-constraints");
  });

  it("requires pick-mode before handoff", () => {
    const c: ManualContext = {
      existingRepo: false,
      stack: "typescript",
      languageDone: true,
      constraintsComplete: true,
      modePicked: null,
    };
    expect(nextStep(c)).toBe("pick-mode");
  });

  it("handoff: all steps satisfied → null (enter ralplan)", () => {
    const c: ManualContext = {
      existingRepo: false,
      stack: "typescript",
      languageDone: true,
      constraintsComplete: true,
      modePicked: "direct-PR",
    };
    expect(nextStep(c)).toBeNull();
  });
});

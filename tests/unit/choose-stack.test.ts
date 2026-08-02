import { describe, expect, it } from "vitest";
import {
  resolveStackSelection,
  validateStackChoice,
} from "../../pi/extensions/agentdev/choose-stack";

// AC-MANUAL-1: existing repo → stack detected and LOCKED (never suggested to change).
// AC-MANUAL-2: greenfield → candidates with rationale; choice recorded/validated.
describe("choose-stack (AC-MANUAL-1/2)", () => {
  it("locks the detected stack for an existing repo (no candidates offered)", () => {
    const res = resolveStackSelection("typescript");
    expect(res.kind).toBe("locked");
    if (res.kind === "locked") {
      expect(res.stackId).toBe("typescript");
      expect(res.source).toBe("map-codebase");
    }
  });

  it("offers candidates with full rationale for greenfield", () => {
    const res = resolveStackSelection(null);
    expect(res.kind).toBe("choose");
    if (res.kind === "choose") {
      expect(res.candidates.length).toBeGreaterThan(1);
      for (const c of res.candidates) {
        expect(c.id).toBeTruthy();
        expect(c.name).toBeTruthy();
        // rationale covers the three decision dimensions
        expect(c.rationale.performance).toBeTruthy();
        expect(c.rationale.ecosystem).toBeTruthy();
        expect(c.rationale.deploy).toBeTruthy();
      }
      const ids = new Set(res.candidates.map((c) => c.id));
      expect(ids.size).toBe(res.candidates.length); // unique ids
    }
  });

  it("validates a recorded choice: known stack + non-empty reason", () => {
    const res = resolveStackSelection(null);
    if (res.kind !== "choose") throw new Error("expected greenfield");
    const ok = validateStackChoice({ stackId: res.candidates[0].id, reason: "team familiarity" });
    expect(ok).toBe(true);
  });

  it("rejects an unknown stack id", () => {
    expect(() => validateStackChoice({ stackId: "brainfuck", reason: "why not" })).toThrow();
  });

  it("rejects an empty reason", () => {
    const res = resolveStackSelection(null);
    if (res.kind !== "choose") throw new Error("expected greenfield");
    expect(() =>
      validateStackChoice({ stackId: res.candidates[0].id, reason: "  " }),
    ).toThrow();
  });
});

import { describe, expect, it } from "vitest";
import {
  autocloseDecision,
  UNATTENDED_TIMEOUT_MS,
  type AutocloseContext,
} from "../../pi/extensions/agentdev/autoclose";

// AC-CLOSE-1..5: clean → close; failures → stay → handle → close; leader never.
describe("autoclose policy (AC-CLOSE-1..5)", () => {
  const ctx = (partial: Partial<AutocloseContext>): AutocloseContext => ({
    role: "subworker",
    status: "working",
    handled: false,
    unattendedMs: 0,
    ...partial,
  });

  it("the Leader never closes — even when done (AC-CLOSE-2)", () => {
    expect(autocloseDecision(ctx({ role: "leader", status: "done" }))).toBe("stay");
    expect(autocloseDecision(ctx({ role: "leader", status: "blocked" }))).toBe("stay");
  });

  it("clean completion → close, with a brief ✓ flash (AC-CLOSE-1)", () => {
    for (const role of ["subworker", "reviewer", "subleader"] as const) {
      expect(autocloseDecision(ctx({ role, status: "done" })), role).toBe("close");
    }
  });

  it("failed/blocked → stay (AC-CLOSE-3)", () => {
    expect(autocloseDecision(ctx({ status: "blocked" }))).toBe("stay");
  });

  it("blocked + handled (retry/reassign/dismiss) → close (AC-CLOSE-4)", () => {
    expect(autocloseDecision(ctx({ status: "blocked", handled: true }))).toBe("close");
  });

  it("blocked + unattended past the timeout → ping, never silently close (AC-CLOSE-5)", () => {
    expect(autocloseDecision(ctx({ status: "blocked", unattendedMs: UNATTENDED_TIMEOUT_MS + 1 }))).toBe("ping");
    expect(autocloseDecision(ctx({ status: "blocked", unattendedMs: UNATTENDED_TIMEOUT_MS - 1 }))).toBe("stay");
  });

  it("working/idle/unknown stay open", () => {
    for (const status of ["working", "idle", "unknown"] as const) {
      expect(autocloseDecision(ctx({ status })), status).toBe("stay");
    }
  });

  it("no silent auto-dismiss: blocked never resolves to close without handled", () => {
    const unattended = autocloseDecision(ctx({ status: "blocked", unattendedMs: 10 ** 9 }));
    expect(unattended).toBe("ping"); // pings, does not close
  });
});

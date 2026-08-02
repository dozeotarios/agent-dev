import { describe, expect, it } from "vitest";
import { createCommitGate } from "../../pi/extensions/agentdev/git-gate";

// AC-GIT-1/2: crew stops at commit-ready; commit only after operator confirm.
// AC-GIT-8: +yolo bypasses the gate (auto-commit).
describe("commit gate (AC-GIT-1/2/8)", () => {
  it("direct-PR: markCommitReady → awaiting-confirm → confirm → committed", () => {
    const gate = createCommitGate("direct-PR");
    expect(gate.state().phase).toBe("idle");
    expect(gate.markCommitReady()).toBe("awaiting-confirm");
    expect(gate.confirm()).toBe("committed");
  });

  it("reject returns to commit-ready (work can be amended)", () => {
    const gate = createCommitGate("direct-PR");
    gate.markCommitReady();
    expect(gate.reject()).toBe("commit-ready");
    expect(gate.state().phase).toBe("commit-ready");
  });

  it("+yolo: markCommitReady → committed immediately (no confirmation gate)", () => {
    const gate = createCommitGate("+yolo");
    expect(gate.markCommitReady()).toBe("committed");
  });

  it("confirm before awaiting throws", () => {
    const gate = createCommitGate("direct-PR");
    expect(() => gate.confirm()).toThrow(/awaiting-confirm/);
  });

  it("confirm twice throws (state machine strictness)", () => {
    const gate = createCommitGate("direct-PR");
    gate.markCommitReady();
    gate.confirm();
    expect(() => gate.confirm()).toThrow(/awaiting-confirm/);
  });

  it("markCommitReady while awaiting throws", () => {
    const gate = createCommitGate("direct-PR");
    gate.markCommitReady();
    expect(() => gate.markCommitReady()).toThrow(/already awaiting/);
  });

  it("all gated modes pass through awaiting-confirm", () => {
    for (const mode of ["no-mistakes", "direct-PR", "local-only"] as const) {
      const gate = createCommitGate(mode);
      expect(gate.markCommitReady()).toBe("awaiting-confirm");
    }
  });
});

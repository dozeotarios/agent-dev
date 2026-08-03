import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createConsensusLoop, type PlanOutput } from "../../pi/extensions/agentdev/ralplan";

/**
 * Recorded-loop regression (ARCHITECTURE.md §21: "Fixtures/recordings replay
 * recorded consensus/review loops for deterministic regression without
 * re-spending tokens"). Replays a REAL recorded consensus run (round 1 ITERATE
 * → round 2 APPROVE) through the actual engine — no LLM, deterministic.
 */

interface RecordedRound {
  round: number;
  planner: { content: string };
  architect: { content: string };
  "developer": { content: string };
  critic: { content: string; verdict: "approve" | "iterate" | "reject" };
}

function loadFixture(): { rounds: RecordedRound[] } {
  return JSON.parse(
    readFileSync(join(process.cwd(), "tests/fixtures/recorded-consensus.json"), "utf8"),
  );
}

describe("recorded consensus replay — deterministic regression", () => {
  it("round 1 ITERATE → round 2 APPROVE, exactly as recorded", () => {
    const { rounds } = loadFixture();
    const loop = createConsensusLoop();

    for (const round of rounds) {
      expect(loop.state().expectedRole).toBe("planner");
      loop.submit({ role: "planner", content: round.planner.content });
      expect(loop.state().expectedRole).toBe("architect");
      loop.submit({ role: "architect", content: round.architect.content });
      expect(loop.state().expectedRole).toBe("developer");
      loop.submit({ role: "developer", content: round["developer"].content });
      expect(loop.state().expectedRole).toBe("critic");
      loop.submit({
        role: "critic",
        content: round.critic.content,
        verdict: round.critic.verdict,
      });
    }

    const s = loop.state();
    expect(s.approved).toBe(true);
    expect(s.round).toBe(2);
    expect(s.bestPlan).not.toBeNull();
    // the approved plan parses and validates (non-deliberate goal)
    const parsed = JSON.parse(s.bestPlan!) as PlanOutput;
    expect(parsed.adr.decision).toContain("SQLite-backed REST API");
    expect(parsed.acceptanceCriteria.length).toBeGreaterThanOrEqual(3);
  });
});

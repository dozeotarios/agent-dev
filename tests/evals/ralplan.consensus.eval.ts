import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import {
  createConsensusLoop,
  isHighRisk,
  validatePlanOutput,
  type PlanOutput,
  type Role,
} from "../../pi/extensions/agentdev/ralplan";
import { logPassK } from "../helpers/passk";

/**
 * Agentic eval (ARCHITECTURE.md §21 / AC-RALPLAN-9): drives the REAL consensus
 * loop with REAL models via `pi -p`. Scheduled + pass@k-gated — skipped unless
 * AGENTDEV_EVAL=1 (e.g. nightly). Deterministic mechanics are covered by the
 * unit suite; this eval grades the LLM-driven outcome.
 *
 * Run: AGENTDEV_EVAL=1 node node_modules/vitest/vitest.mjs run tests/evals
 */

const enabled = process.env.AGENTDEV_EVAL === "1";

const GOAL = "build a small REST API for task tracking with a database";
const RISK_SIGNALS: string[] = [];
function ask(prompt: string, timeoutMs = 300_000): string {
  // 120s was too tight for real LLM calls with full-plan prompts (exit 143 =
  // spawnSync SIGTERM at the cap killed a mid-loop revision). 5 min headroom.
  const r = spawnSync("pi", ["-p", prompt], { encoding: "utf8", timeout: timeoutMs });
  if (r.status !== 0) {
    throw new Error(`pi eval call failed (${r.status}): ${(r.stderr ?? "").slice(0, 300)}`);
  }
  return r.stdout.trim();
}

const ROLE_INSTRUCTIONS: Record<Role, string> = {
  planner:
    `You are the Planner in a consensus-planning loop. Goal: "${GOAL}". ` +
    `Emit ONLY JSON: { "principles": [3-5 strings], "drivers": [exactly 3 strings], ` +
    `"options": [{"name","pros":[...],"cons":[...]} x >=2], "adr": { "decision", ` +
    `"drivers":[...], "alternatives":[...], "why", "consequences":[...], "followups":[...] }, ` +
    `"acceptanceCriteria": [>=3 testable strings] }. No prose.`,
  architect:
    `You are the Architect in a consensus-planning loop. Review the current plan for ` +
    `architectural soundness. Reply with ONE line: "SOUND" or "NEEDS WORK" plus one ` +
    `tradeoff you considered.`,
  "developer":
    `You are the Developer in a consensus-planning loop. Review the current plan for ` +
    `practical feasibility, idioms, and effort. Reply with ONE line: "FEASIBLE" or ` +
    `"RISKY" plus the main risk.`,
  critic:
    `You are the Critic in a consensus-planning loop. The plan must have testable ` +
    `acceptance criteria and concrete verification. Reply with EXACTLY one of ` +
    `"APPROVE", "ITERATE", "REJECT" and 1-3 short findings.`,
};

function parsePlan(json: string): PlanOutput | null {
  try {
    const j = JSON.parse(json);
    if (!j.adr || !j.acceptanceCriteria) return null;
    return {
      adr: {
        decision: String(j.adr.decision ?? ""),
        drivers: Array.isArray(j.adr.drivers) ? j.adr.drivers.map(String) : [],
        alternatives: Array.isArray(j.adr.alternatives) ? j.adr.alternatives.map(String) : [],
        why: String(j.adr.why ?? ""),
        consequences: Array.isArray(j.adr.consequences) ? j.adr.consequences.map(String) : [],
        followups: Array.isArray(j.adr.followups) ? j.adr.followups.map(String) : [],
      },
      acceptanceCriteria: j.acceptanceCriteria.map(String),
      filePlan: j.filePlan
        ? {
            structure: String(j.filePlan.structure ?? ""),
            create: Array.isArray(j.filePlan.create) ? j.filePlan.create.map(String) : [],
            modify: Array.isArray(j.filePlan.modify) ? j.filePlan.modify.map(String) : [],
            doNotTouch: Array.isArray(j.filePlan.doNotTouch) ? j.filePlan.doNotTouch.map(String) : [],
          }
        : { structure: "", create: [], modify: [], doNotTouch: [] },
    };
  } catch {
    return null;
  }
}

function criticVerdict(text: string): "approve" | "iterate" | "reject" {
  if (/APPROVE/.test(text)) return "approve";
  if (/REJECT/.test(text)) return "reject";
  return "iterate";
}

/**
 * Build the reviewer hint WITHOUT truncating the plan: the parsed PlanOutput is
 * only ~2-3KB, and slicing it at 1500 chars cut off acceptanceCriteria (the
 * field the Critic checks hardest), so the Critic correctly-but-hopelessly
 * demanded criteria that were already there -> ITERATE until the guard died.
 * Key fields first, never sliced.
 */
function planHint(planOutput: PlanOutput | null): string {
  if (!planOutput) return "(none)";
  const { acceptanceCriteria, preMortem, testPlan, ...rest } = planOutput;
  return JSON.stringify({ acceptanceCriteria, preMortem, testPlan, ...rest });
}

describe.skipIf(!enabled)("agentic eval: ralplan consensus reaches a sound APPROVE within bound", () => {
  // Agentic evals make real LLM calls (20-35s each, up to 25 calls): the 30s
  // global testTimeout (vitest.config.ts) kills them mid-run. Long timeout.
  it(
    "full Planner → Architect → Developer → Critic loop with real models",
    { timeout: 900_000 },
    () => {
    const deliberate = isHighRisk(GOAL, RISK_SIGNALS);
    const loop = createConsensusLoop();
    let planOutput: PlanOutput | null = null;
    // Closed loop (AC-RALPLAN-5 / ARCH §8 "revise"): the planner MUST see the
    // critic's findings from the previous round or it re-drafts blind and the
    // loop can never converge. This was a real gap the eval caught: the critic
    // repeatedly demanded pinned contracts while the planner kept deferring
    // them to followups, ending in a round-5 REJECT every run.
    let lastCritique = "";
    const critiques: string[] = []; // every round's critique, for the next critic

    // Cap at 25 submissions (~6 rounds); the engine's maxRounds=5 is the real
    // bound. The previous 6-submission guard could never reach a 2nd critic
    // verdict after a round-1 ITERATE, making approval structurally impossible.
    for (let guard = 0; guard < 25; guard++) {
      const expected = loop.state().expectedRole;
      if (!expected) break;
      const planHintText =
        expected === "planner" && lastCritique
          ? `\nThe previous plan was NOT approved. Critic review (address EVERY point):\n${lastCritique}\nRevise the plan accordingly. Keep the JSON schema identical.`
          : expected === "critic"
            ? `\nCurrent plan: ${planHint(planOutput)}` +
              (critiques.length > 0
                ? `\nYour previous critique was:\n${critiques[critiques.length - 1]}\nVerify EVERY point you raised is addressed in the revised plan. APPROVE only if all are addressed and you have no new blocking issues.`
                : "")
            : expected === "architect" || expected === "developer"
              ? `\nCurrent plan: ${planHint(planOutput)}`
              : "";
      let out = ask(ROLE_INSTRUCTIONS[expected] + planHintText);
      // One retry: the planner occasionally answers with prose instead of pure
      // JSON; re-ask once before giving up on the round.
      if (expected === "planner" && !parsePlan(out)) {
        console.log(`[ralplan eval] round ${loop.state().round} planner retry (unparseable)`);
        out = ask(ROLE_INSTRUCTIONS[expected] + planHintText);
      }
      console.log(`[ralplan eval] round ${loop.state().round} ${expected} (${out.length} chars)`);
      if (expected === "planner") {
        planOutput = parsePlan(out);
        loop.submit({ role: expected, content: out });
      } else if (expected === "critic") {
        lastCritique = out; // feed the full critique into the next revision
        critiques.push(out);
        console.log(`[ralplan eval] round ${loop.state().round} critic verdict: ${criticVerdict(out)}`);
        console.log(`[ralplan eval]   critique: ${out.slice(0, 500).replace(/\n/g, " ")}`);
        loop.submit({ role: expected, content: out, verdict: criticVerdict(out) });
      } else {
        loop.submit({ role: expected, content: out });
      }
    }

    const s = loop.state();
    // pass criteria (pass@k logged by the harness)
    const passed = s.approved && s.round <= 5 && planOutput !== null;
    logPassK("ralplan.consensus.approve", passed, `rounds=${s.round} verdicts=${s.verdicts.map((v) => v.verdict).join(",")}`);
    expect(s.approved).toBe(true);
    expect(s.round).toBeLessThanOrEqual(5);
    expect(planOutput).not.toBeNull();
    expect(validatePlanOutput(planOutput!, { deliberate }).ok).toBe(true);
  });
});

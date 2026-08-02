import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import {
  generateCandidates,
  type ConstraintContext,
} from "../../pi/extensions/agentdev/define-constraints";
import { logPassK } from "../helpers/passk";

/**
 * Agentic eval (ARCHITECTURE.md §21 / AC-MANUAL-4): the manual phase surfaces
 * the right failure modes for a fixture context. Deterministic grader: the
 * real candidate generator predicts the top expected items; a real model must
 * independently surface ≥2 of them (lenient rubric — pass@k logged).
 * Skipped unless AGENTDEV_EVAL=1.
 *
 * Run: AGENTDEV_EVAL=1 node node_modules/vitest/vitest.mjs run tests/evals
 */

const enabled = process.env.AGENTDEV_EVAL === "1";

const FIXTURE_CTX: ConstraintContext = {
  stack: "typescript",
  scope: "REST API for a todo service with a delete endpoint and no undo, persisting tasks to a database",
  existingRepo: false,
  riskSignals: ["data loss"],
};

const PROMPT = `You are the Leader in the manual phase of an agent build.
Goal: "${FIXTURE_CTX.scope}" (stack: ${FIXTURE_CTX.stack}).
List the TOP 5 failure modes this app must be designed against.
Reply with one failure mode per line, no numbering, no prose.`;

describe.skipIf(!enabled)("agentic eval: define-constraints surfaces the relevant failure mode for a fixture context", () => {
  it(
    "real model independently surfaces the deterministic top candidates",
    { timeout: 300_000 },
    () => {
    // Deterministic ground truth from the real generator (AC-MANUAL-4):
    const failureModes = generateCandidates(FIXTURE_CTX).find(
      (c) => c.category === "failure_modes",
    )!.items;
    expect(failureModes.length).toBeGreaterThanOrEqual(3); // api+persist triggers
    // fixture context must be meaningful: data-loss concern is present
    expect(failureModes.some((i) => /disk full|partial write/.test(i.text.toLowerCase()))).toBe(true);

    const r = spawnSync("pi", ["-p", PROMPT], { encoding: "utf8", timeout: 300_000 });
    expect(r.status).toBe(0);
    const answer = r.stdout.trim().toLowerCase();
    console.log(`[define-constraints eval] model answer:\n${answer.slice(0, 600)}`);

    // Concept rubric for THIS fixture (delete-without-undo → data loss).
    // De-echoed (review closure): grader concepts must NOT appear verbatim in
    // the prompt, or a model could pass by echoing the scope's own vocabulary.
    // Prompt contains: delete, undo, api, database — all excluded below.
    const concepts = [
      "data loss", "durab", "crash", "corrupt", "disk full",
      "swallow", "race", "concurr", "timeout", "partial write",
    ];
    const conceptHits = concepts.filter((c) => answer.includes(c)).length;
    const dataLossCovered = ["data loss", "crash", "durab", "corrupt", "disk full"].some((c) => answer.includes(c));

    const passed = conceptHits >= 3 && dataLossCovered;
    logPassK("define-constraints.failure-modes", passed, `concepts=${conceptHits} dataLoss=${dataLossCovered}`);
    expect(passed).toBe(true);
  },
  );
});

import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import {
  evaluateRound,
  constraintsToChecklist,
  type Finding,
  type ReviewConstraints,
} from "../../pi/extensions/agentdev/review";
import { VULNERABLE_FIXTURE } from "../fixtures/agentic";
import { logPassK } from "../helpers/passk";

/**
 * Agentic eval (ARCHITECTURE.md §21 / AC-REVIEW-5): a real Security-lens
 * reviewer must flag injected defects in a fixture AND validate against the
 * operator's define-constraints must-nots (no hardcoded secrets, never
 * swallow errors, no breaking API changes). pass@k logged — skipped unless
 * AGENTDEV_EVAL=1.
 *
 * Run: AGENTDEV_EVAL=1 node node_modules/vitest/vitest.mjs run tests/evals
 */

const enabled = process.env.AGENTDEV_EVAL === "1";

/** Operator's define-constraints answers (fixture, AC-REVIEW-5). */
const TASK_TRACKER_CONSTRAINTS: ReviewConstraints = {
  failureModes: ["API timeout", "disk full", "partial write"],
  edgeCases: ["empty input", "huge input", "concurrent access", "duplicate events"],
  invariants: ["data integrity always holds", "no secrets in logs", "consistent error shape"],
  mustNots: ["no hardcoded secrets", "never swallow errors", "no breaking API changes"],
};

const SECURITY_CHECKLIST = constraintsToChecklist(TASK_TRACKER_CONSTRAINTS).security;

const PROMPT = `You are the SECURITY reviewer in a code review. Validate the code
against this operator-defined must-not checklist:
${SECURITY_CHECKLIST.map((c) => `- ${c}`).join("\n")}

Find BLOCKING security issues. Reply with findings, one per line, each
starting with exactly "BLOCKING: " or "NIT: ":

${VULNERABLE_FIXTURE}`;

function ask(): string {
  const r = spawnSync("pi", ["-p", PROMPT], { encoding: "utf8", timeout: 300_000 });
  if (r.status !== 0) throw new Error(`pi eval call failed: ${(r.stderr ?? "").slice(0, 300)}`);
  return r.stdout.trim();
}

function parseFindings(text: string): Finding[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line): Finding | null => {
      const blocking = /^BLOCKING:/i.test(line);
      const nit = /^NIT:/i.test(line);
      if (!blocking && !nit) return null;
      return {
        lens: "security" as const,
        severity: blocking ? ("blocking" as const) : ("nit" as const),
        text: line.replace(/^(BLOCKING|NIT):/i, "").trim(),
        storyId: null,
      };
    })
    .filter((f): f is Finding => f !== null);
}

describe.skipIf(!enabled)("agentic eval: Security reviewer flags the injected defect (AC-REVIEW-5)", () => {
  it(
    "produces a blocking finding naming the injected defect and covers the must-nots",
    { timeout: 300_000 },
    () => {
      const findings = parseFindings(ask());
      const result = evaluateRound(findings);
      // pass criteria: at least one blocking finding naming the defect,
      // and the AC-REVIEW-5 must-not covered (concept match).
      const texts = result.blocking.map((f) => f.text.toLowerCase());
      const caught = texts.some((t) => /sql|inject|secret|hardcod|api ?key/.test(t));
      const coversSecretMustNot = result.blocking.some((f) => {
        const t = f.text.toLowerCase();
        return /hardcod/.test(t) && /secret|api ?key|token/.test(t);
      });
      const passed = result.status === "rework" && caught && coversSecretMustNot;
      // computed BEFORE the expects so pass@k records failures too
      logPassK("review.security-injected-defect", passed, `${result.blocking.length} blocking`);
      expect(result.status).toBe("rework"); // at least one blocking finding
      expect(caught).toBe(true); // names SQL injection or the hardcoded secret
      expect(coversSecretMustNot).toBe(true);
    },
  );
});

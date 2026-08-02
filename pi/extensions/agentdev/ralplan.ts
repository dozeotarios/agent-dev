/**
 * ralplan — consensus planning engine (ARCHITECTURE.md §8, AC-RALPLAN-1..7).
 *
 * Sequential loop: Planner (draft/revise) → Architect → Senior Dev → Critic.
 * Critic returns APPROVE | ITERATE | REJECT; any non-APPROVE revises and
 * re-runs the full loop, capped at maxRounds (default 5), after which the best
 * (last) version is yielded. Deliberate mode auto-triggers on high-risk work
 * and requires a 3-scenario pre-mortem + expanded test plan in the output.
 */

export type Role = "planner" | "architect" | "senior-dev" | "critic";
export type Verdict = "approve" | "iterate" | "reject";

export type AgentOutput =
  | { role: "planner" | "architect" | "senior-dev"; content: string }
  | { role: "critic"; content: string; verdict: Verdict; findings?: string[] };

export interface VerdictRecord {
  round: number;
  verdict: Verdict;
  findings: string[];
}

export interface ConsensusState {
  round: number;
  expectedRole: Role | null;
  approved: boolean;
  exhausted: boolean;
  roundsUsed: number;
  bestPlan: string | null;
  verdicts: VerdictRecord[];
}

export interface PlanVersion {
  round: number;
  content: string;
  verdict: Verdict | null;
  findings: string[];
}

export interface ConsensusLoop {
  state(): ConsensusState;
  submit(output: AgentOutput): ConsensusState;
}

const ROLE_ORDER: Role[] = ["planner", "architect", "senior-dev", "critic"];

export function createConsensusLoop(maxRounds = 5): ConsensusLoop {
  let round = 1;
  let expectedRole: Role | null = "planner";
  let currentPlan: string | null = null;
  let bestPlan: string | null = null;
  let approved = false;
  let exhausted = false;
  const verdicts: VerdictRecord[] = [];
  const versions: PlanVersion[] = [];

  const state = (): ConsensusState => ({
    round,
    expectedRole,
    approved,
    exhausted,
    roundsUsed: round,
    bestPlan,
    verdicts: [...verdicts],
  });

  return {
    state,
    submit(output) {
      if (expectedRole === null) {
        throw new Error("consensus already finished");
      }
      if (output.role !== expectedRole) {
        throw new Error(`expected ${expectedRole}, got ${output.role}`);
      }
      if (output.role === "planner") {
        if (!output.content.trim()) throw new Error("planner output must not be empty");
        currentPlan = output.content;
        versions.push({ round, content: output.content, verdict: null, findings: [] });
        expectedRole = "architect";
      } else if (output.role === "architect") {
        expectedRole = "senior-dev";
      } else if (output.role === "senior-dev") {
        expectedRole = "critic";
      } else if (output.role === "critic") {
        verdicts.push({ round, verdict: output.verdict, findings: output.findings ?? [] });
        const v = versions[versions.length - 1];
        if (v) {
          v.verdict = output.verdict;
          v.findings = output.findings ?? [];
        }
        if (output.verdict === "approve") {
          approved = true;
          bestPlan = currentPlan;
          expectedRole = null;
        } else if (round >= maxRounds) {
          exhausted = true;
          // NEVER present a critic-REJECTED plan as best: the last ITERATE'd
          // version is the best available; a REJECT-only loop yields null so
          // the caller escalates instead of dispatching a rejected plan.
          bestPlan = pickBest(versions);
          expectedRole = null;
        } else {
          round += 1;
          expectedRole = "planner"; // revise
        }
      } else {
        throw new Error("unreachable role");
      }
      return state();
    },
  };
}

/**
 * Deterministic best-version selector (AC-RALPLAN-5 "best version is
 * presented"): prefer approved; then fewest critic findings; then the most
 * recent ITERATE (revisions) — never a REJECTed plan.
 */
export function pickBest(versions: PlanVersion[]): string | null {
  const approved = versions.find((v) => v.verdict === "approve");
  if (approved) return approved.content;
  const candidates = versions
    .filter((v) => v.verdict !== "reject")
    .sort((a, b) => a.findings.length - b.findings.length || b.round - a.round);
  return candidates[0]?.content ?? null;
}

// --- Deliberate mode (AC-RALPLAN-6) ---

export const HIGH_RISK_KEYWORDS = [
  "auth",
  "login",
  "security",
  "migration",
  "migrate",
  "destructive",
  "drop",
  "truncate",
  "wipe",
  "irreversible",
  "destroy",
  "recreate",
  "delete",
  "reset",
  "production",
  "incident",
  "pii",
  "compliance",
  "gdpr",
  "breaking change",
  "public api",
  "api break",
];

/** Auto-trigger deliberate mode for high-risk work (scope text + explicit signals). */
export function isHighRisk(scope: string, riskSignals: string[]): boolean {
  const tokens = new Set(
    [scope, ...riskSignals].join(" ").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean),
  );
  return HIGH_RISK_KEYWORDS.some((keyword) =>
    keyword.split(/\s+/).every((part) => tokens.has(part)),
  );
}

// --- Output validation (AC-RALPLAN-1/7) ---

export interface RalplanDrSummary {
  principles: string[];
  drivers: string[];
  options: { name: string; pros: string[]; cons: string[] }[];
}

export interface PlanOutput {
  adr: {
    decision: string;
    drivers: string[];
    alternatives: string[];
    why: string;
    consequences: string[];
    followups: string[];
  };
  acceptanceCriteria: string[];
  preMortem?: string[];
  testPlan?: string[];
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

export const DELIBERATE_TEST_LEVELS = ["unit", "integration", "e2e", "observability"];

/** RALPLAN-DR summary: 3-5 principles, top-3 drivers, ≥2 options with pros/cons. */
export function validateDraftSummary(summary: RalplanDrSummary): ValidationResult {
  const errors: string[] = [];
  if (summary.principles.length < 3 || summary.principles.length > 5) {
    errors.push(`principles must be 3-5 (got ${summary.principles.length})`);
  }
  if (summary.drivers.length !== 3) {
    errors.push(`decision drivers must be the top 3 (got ${summary.drivers.length})`);
  }
  if (summary.options.length < 2) {
    errors.push(`at least 2 viable options required (got ${summary.options.length})`);
  }
  for (const opt of summary.options) {
    if (!opt.name.trim()) errors.push("every option needs a name");
    if (opt.pros.length === 0) errors.push(`option "${opt.name}" needs pros`);
    if (opt.cons.length === 0) errors.push(`option "${opt.name}" needs cons`);
  }
  return { ok: errors.length === 0, errors };
}

/** Plan output: ADR (all fields) + testable acceptance criteria; deliberate adds extras. */
export function validatePlanOutput(
  output: PlanOutput,
  opts: { deliberate: boolean },
): ValidationResult {
  const errors: string[] = [];
  const adr = output.adr;
  if (!adr.decision.trim()) errors.push("ADR missing decision");
  if (adr.drivers.length === 0) errors.push("ADR missing drivers");
  if (adr.alternatives.length === 0) errors.push("ADR missing alternatives considered");
  if (!adr.why.trim()) errors.push("ADR missing why");
  if (adr.consequences.length === 0) errors.push("ADR missing consequences");
  if (adr.followups.length === 0) errors.push("ADR missing follow-ups");
  if (output.acceptanceCriteria.length === 0) {
    errors.push("acceptance criteria must be testable and non-empty");
  }
  if (opts.deliberate) {
    if (!output.preMortem || output.preMortem.length < 3) {
      errors.push("deliberate mode requires a 3-scenario pre-mortem");
    }
    const levels = output.testPlan ?? [];
    for (const level of DELIBERATE_TEST_LEVELS) {
      if (!levels.includes(level)) {
        errors.push(`deliberate mode test plan missing level: ${level}`);
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

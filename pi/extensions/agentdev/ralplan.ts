/**
 * ralplan — consensus planning engine (ARCHITECTURE.md §8, AC-RALPLAN-1..7).
 *
 * Sequential loop: Planner (draft/revise) → Architect → Developer → Critic.
 * Critic returns APPROVE | ITERATE | REJECT; any non-APPROVE revises and
 * re-runs the full loop, capped at maxRounds (default 5), after which the best
 * (last) version is yielded. Deliberate mode auto-triggers on high-risk work
 * and requires a 3-scenario pre-mortem + expanded test plan in the output.
 */

export type Role = "planner" | "architect" | "developer" | "critic";
export type Verdict = "approve" | "iterate" | "reject";

export type AgentOutput =
  | { role: "planner" | "architect" | "developer"; content: string }
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

const ROLE_ORDER: Role[] = ["planner", "architect", "developer", "critic"];

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
        expectedRole = "developer";
      } else if (output.role === "developer") {
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

/**
 * Granular touch map: exactly where the crew writes/modifies, and what it
 * must NOT touch. Every path is repo-root-relative and concrete (files, not
 * vague directories) — the workers build precisely this and nothing else.
 */
export interface FilePlan {
  /** Proposed folder layout (greenfield) or the existing-layout anchor (brownfield). */
  structure: string;
  /** Exact NEW files to create (repo-root-relative paths). */
  create: string[];
  /** Exact EXISTING files to modify (repo-root-relative paths). */
  modify: string[];
  /** Files/dirs that must stay untouched. */
  doNotTouch: string[];
}

/** One story's own DISJOINT file set — parallel workers never overlap. */
export interface PlanStoryFiles {
  create: string[];
  modify: string[];
  doNotTouch: string[];
}

/** One story of the plan: its own criteria + its own files. */
export interface PlanStory {
  id: string;
  criteria: string[];
  files: PlanStoryFiles;
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
  /** Granular touch map (AC-PLAN-FILES): what to write/modify/never touch. */
  filePlan: FilePlan;
  /**
   * Optional explicit SPLIT (AC-PLAN-STORIES): each story carries its own
   * criteria + disjoint files; the worker count = stories.length. When
   * absent, criteria are sliced deterministically (planToStories fallback).
   */
  stories?: PlanStory[];
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
  // Granular touch map (AC-PLAN-FILES): the plan must say exactly where
  // everything is written or modified — and what it will not touch.
  const fp = output.filePlan;
  if (!fp) {
    errors.push("filePlan missing (exact create/modify paths required)");
  } else {
    if (!fp.structure?.trim()) errors.push("filePlan missing structure (folder layout)");
    if ((fp.create?.length ?? 0) + (fp.modify?.length ?? 0) === 0) {
      errors.push("filePlan must list at least one create or modify path");
    }
    for (const list of [fp.create, fp.modify, fp.doNotTouch]) {
      for (const p of list ?? []) {
        if (!p.trim()) errors.push("filePlan paths must be non-empty");
      }
    }
  }
  // Story split (AC-PLAN-STORIES): when present, stories must be disjoint in
  // their files — parallel workers must never touch the same file.
  const stories = output.stories;
  if (stories && stories.length > 0) {
    for (const st of stories) {
      if (!st.id?.trim()) errors.push("story missing id");
      if ((st.criteria?.length ?? 0) === 0) errors.push(`story ${st.id ?? "?"} missing criteria`);
      for (const list of [st.files?.create, st.files?.modify, st.files?.doNotTouch]) {
        for (const fp of list ?? []) {
          if (!fp.trim()) errors.push(`story ${st.id ?? "?"} has an empty file path`);
        }
      }
    }
    const seen = new Map<string, string>();
    for (const st of stories) {
      for (const f of [...(st.files?.create ?? []), ...(st.files?.modify ?? [])]) {
        const prev = seen.get(f);
        if (prev) {
          errors.push(`overlapping story files: "${f}" in both ${prev} and ${st.id}`);
        } else {
          seen.set(f, st.id ?? "?");
        }
      }
    }
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

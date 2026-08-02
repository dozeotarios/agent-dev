/**
 * build-time code review loop (ARCHITECTURE.md §9, AC-REVIEW-1..5).
 *
 * 6 lenses fan out per round: senior-swe · efficiency · security ·
 * api-contract · reliability · domain. Findings are evaluated per round:
 * any BLOCKING finding → rework (routed to the Subworkers that own the
 * storyIds); nits never block. The loop terminates at "no actionable
 * findings" or when max rounds are exhausted (escalation: retries exhausted).
 */

import type { WorkerAssignment } from "./dispatch";

export const LENSES = [
  "senior-swe",
  "efficiency",
  "security",
  "api-contract",
  "reliability",
  "domain",
] as const;

export type LensId = (typeof LENSES)[number];
export type FindingSeverity = "blocking" | "nit";

export interface Finding {
  lens: LensId;
  severity: FindingSeverity;
  text: string;
  /** null = slice-level finding (no specific story). */
  storyId: string | null;
}

export interface ReviewRoundResult {
  status: "clean" | "rework";
  blocking: Finding[];
  nits: Finding[];
  /** Unique story ids that own blocking findings (routing targets). */
  storyIds: string[];
}

export function evaluateRound(findings: Finding[]): ReviewRoundResult {
  for (const f of findings) {
    if (f.severity !== "blocking" && f.severity !== "nit") {
      throw new Error(`unknown finding severity: ${String(f.severity)}`);
    }
  }
  const blocking = findings.filter((f) => f.severity === "blocking");
  const nits = findings.filter((f) => f.severity === "nit");
  const storyIds = [
    ...new Set(blocking.filter((f) => f.storyId !== null).map((f) => f.storyId as string)),
  ];
  return {
    status: blocking.length === 0 ? "clean" : "rework",
    blocking,
    nits,
    storyIds,
  };
}

export interface ReviewLoop {
  round(): number;
  /**
   * Submit a round. When a constraint checklist is supplied (AC-REVIEW-5),
   * a round with zero blocking findings is STILL rework while operator
   * constraints remain uncovered — "clean" requires both.
   */
  submitRound(findings: Finding[], constraints?: ConstraintChecklist): ReviewRoundResult;
  isComplete(): boolean;
  /** Remaining blocking findings when the loop exhausted its rounds. */
  remainingBlocking(): Finding[];
  /** Constraint items still uncovered when the loop stopped. */
  uncovered(): string[];
}

export function createReviewLoop(maxRounds = 5): ReviewLoop {
  let current = 0;
  let complete = false;
  let remaining: Finding[] = [];
  let uncovered: string[] = [];
  const allFindings: Finding[] = []; // coverage accumulates across rounds

  return {
    round: () => current,
    submitRound(findings, constraints) {
      if (complete) throw new Error("review loop already finished");
      const result = evaluateRound(findings);
      allFindings.push(...findings);
      uncovered = constraints ? uncoveredConstraints(constraints, allFindings) : [];
      current += 1;
      const constraintBlocked = uncovered.length > 0; // AC-REVIEW-5 gate
      if (result.status === "clean" && !constraintBlocked) {
        complete = true;
        remaining = [];
      } else if (current >= maxRounds) {
        complete = true;
        remaining = result.blocking; // escalation: retries exhausted
      }
      return {
        status: result.status === "clean" && !constraintBlocked ? "clean" : "rework",
        blocking: result.blocking,
        nits: result.nits,
        storyIds: result.storyIds,
      };
    },
    isComplete: () => complete,
    remainingBlocking: () => [...remaining],
    uncovered: () => [...uncovered],
  };
}

/** Route blocking findings back to the Subworkers that own those stories. */
export function routeToWorkers(
  blocking: Finding[],
  workers: WorkerAssignment[],
): WorkerAssignment[] {
  const ids = new Set(
    blocking.filter((f) => f.storyId !== null).map((f) => f.storyId as string),
  );
  return workers.filter((w) => ids.has(w.storyId));
}

// --- AC-REVIEW-5: Reliability/Security reviewers validate against the
// operator's define-constraints inputs (failure modes, edge cases, invariants,
// must-nots). The per-lens checklist is deterministic; the agentic evals prove
// a real reviewer uses it. ---

export interface ReviewConstraints {
  /** "failure_modes" answers from define-constraints. */
  failureModes: string[];
  /** "edge_cases" answers. */
  edgeCases: string[];
  /** "invariants" answers. */
  invariants: string[];
  /** "dont" answers → must-not rules. */
  mustNots: string[];
}

export type ConstraintChecklist = Record<LensId, string[]>;

/** Map define-constraints answers to the lens that must validate them. */
export function constraintsToChecklist(c: ReviewConstraints): ConstraintChecklist {
  return {
    "senior-swe": [...c.invariants],
    efficiency: [...c.edgeCases],
    security: [...c.mustNots, ...c.invariants],
    "api-contract": [...c.edgeCases, ...c.invariants],
    reliability: [...c.failureModes, ...c.edgeCases, ...c.invariants],
    domain: [...c.invariants],
  };
}

/**
 * Constraint items still NOT covered by any finding (case-insensitive match
 * on the item's core — leading "no "/"never " negation is stripped so a
 * finding like "hardcoded secrets found" covers the must-not "no hardcoded
 * secrets"). Negation-aware: an absence claim ("we checked: there are NO
 * hardcoded secrets") does NOT count as coverage — only a reported
 * violation does. A non-empty result means the review is not complete even
 * with zero blocking findings.
 */
export function uncoveredConstraints(
  checklist: ConstraintChecklist,
  findings: Finding[],
): string[] {
  const covered = new Set<string>();
  for (const f of findings) {
    const text = f.text.toLowerCase();
    for (const item of Object.values(checklist).flat()) {
      if (coversConstraint(item, text)) covered.add(item);
    }
  }
  return [...new Set(Object.values(checklist).flat())].filter((item) => !covered.has(item));
}

/** Strip leading negation so findings match the item's substance. */
function constraintCore(item: string): string {
  return item.toLowerCase().replace(/^(no|never)\s+/, "");
}

/** True when the finding reports the constraint (not merely asserts its absence). */
function coversConstraint(item: string, text: string): boolean {
  const core = constraintCore(item);
  let idx = 0;
  while ((idx = text.indexOf(core, idx)) >= 0) {
    const before = text.slice(Math.max(0, idx - 10), idx);
    // "no/never/not <core>" immediately before the match = absence claim
    if (!/(^|\s)(no|never|not)\s+$/.test(before)) return true;
    idx += core.length;
  }
  return false;
}

/**
 * escalation — autopilot failure policy (ARCHITECTURE.md §10, AC-ESCAL-1..3).
 *
 * The crew self-handles recoverable failures (flaky tests, transient errors,
 * re-review loops) up to per-kind budgets; build failures retry up to the
 * build budget. Escalation to the operator fires ONLY on the 3 triggers:
 *   1. retries exhausted on a task            → reason "retries-exhausted"
 *   2. an unsettled product/architecture decision → "unsettled-decision"
 *   3. an explicit "needs human"              → "needs-human"
 * Escalation pauses ONLY the blocked branch (pauseBranch); every other branch
 * keeps running (AC-ESCAL-3). Deterministic policy — unit-tested.
 *
 * Pure decision function: `handle` decides from the event's `attempt` number
 * (the caller reports the real attempt count, e.g. the review loop's round).
 * No cross-branch/cross-kind state — a failure on one branch can never affect
 * another branch's self-heal budget (AC-ESCAL-3).
 */

export type FailureKind =
  | "flaky-test"
  | "transient-error"
  | "review-loop"
  | "build-failure"
  | "unsettled-decision"
  | "needs-human";

export type EscalationReason = "retries-exhausted" | "unsettled-decision" | "needs-human";

export interface EscalationEvent {
  /** Which branch (plan/story subtree) the failure belongs to. */
  branchId: string;
  kind: FailureKind;
  /** 1-based attempt of the failing action. */
  attempt: number;
  detail?: string;
}

export interface EscalationDecision {
  escalate: boolean;
  reason: EscalationReason | null;
  /** The ONLY branch paused by this decision; null when self-handled. */
  pauseBranch: string | null;
  notifyOperator: boolean;
}

export interface EscalationBudget {
  /** Self-heal budget for flaky-test / transient-error / build-failure. */
  maxRetries: number;
  /** Self-heal budget for review-loop rounds (mirrors createReviewLoop). */
  maxReviewRounds: number;
}

export interface EscalationPolicy {
  handle(event: EscalationEvent): EscalationDecision;
}

export interface EscalationTracker {
  /** Enforce monotonic per-(branch,kind) attempts; then delegate to the policy. */
  handle(event: EscalationEvent): EscalationDecision;
}

const SELF_HEALABLE: FailureKind[] = ["flaky-test", "transient-error", "review-loop"];

/**
 * Stateful enforcement wrapper (review closure): `attempt` is caller-reported
 * and gameable (a caller that always says attempt:1 never escalates). The
 * tracker keeps per-(branch,kind) monotonic counters and feeds the policy the
 * max(claimed, tracked+1) — a reset counter cannot suppress escalation.
 * Isolation preserved: counters are keyed by branchId, so one branch's
 * failures never consume another branch's budget (AC-ESCAL-3).
 */
export function createEscalationTracker(policy: EscalationPolicy): EscalationTracker {
  const attempts = new Map<string, number>();
  return {
    handle(event) {
      const key = `${event.branchId}:${event.kind}`;
      const tracked = attempts.get(key) ?? 0;
      const used = Math.max(event.attempt, tracked + 1);
      attempts.set(key, used);
      return policy.handle({ ...event, attempt: used });
    },
  };
}

export function createEscalationPolicy(
  budget: EscalationBudget = { maxRetries: 3, maxReviewRounds: 5 },
): EscalationPolicy {
  const budgetFor = (kind: FailureKind): number =>
    kind === "review-loop" ? budget.maxReviewRounds : budget.maxRetries;

  const escalate = (reason: EscalationReason, branchId: string): EscalationDecision => ({
    escalate: true,
    reason,
    pauseBranch: branchId,
    notifyOperator: true,
  });

  return {
    handle(event) {
      if (event.kind === "unsettled-decision" || event.kind === "needs-human") {
        // triggers 2 and 3: immediate escalation, no budget consumption
        return escalate(event.kind, event.branchId);
      }
      if (SELF_HEALABLE.includes(event.kind) || event.kind === "build-failure") {
        if (event.attempt <= budgetFor(event.kind)) {
          // self-handle: retry/rebuild/re-review — no operator involvement
          return { escalate: false, reason: null, pauseBranch: null, notifyOperator: false };
        }
        return escalate("retries-exhausted", event.branchId);
      }
      throw new Error(`unknown failure kind: ${String(event.kind)}`);
    },
  };
}

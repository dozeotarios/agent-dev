/**
 * define-constraints — option-driven risk interview (AC-MANUAL-4/5/6).
 *
 * The Leader surfaces PRE-FILLED candidate items per category, tailored to the
 * context (scope + stack + risk signals); the operator curates. Soft-gate:
 * every category is asked on every plan and never silently skipped; "none" is
 * a valid explicit answer per category. Outputs feed the ralplan Planner and
 * the Reliability/Security reviewer checklists.
 */

export type ConstraintCategory =
  | "do"
  | "dont"
  | "failure_modes"
  | "edge_cases"
  | "invariants";

export const CATEGORY_ORDER: ConstraintCategory[] = [
  "do",
  "dont",
  "failure_modes",
  "edge_cases",
  "invariants",
];

export interface CandidateItem {
  id: string;
  text: string;
  /** Context keywords; empty array = always applies. */
  appliesWhen: string[];
}

export interface ConstraintContext {
  stack: string | null;
  scope: string;
  existingRepo: boolean;
  riskSignals: string[];
}

export interface CategoryCandidates {
  category: ConstraintCategory;
  items: CandidateItem[];
}

/** Knowledge base of candidates per category (always + keyword-gated). */
export const CANDIDATE_POOL: Record<ConstraintCategory, CandidateItem[]> = {
  do: [
    { id: "retry_with_backoff", text: "Add retry with backoff", appliesWhen: ["api", "network", "http", "integration"] },
    { id: "structured_logging", text: "Use structured logging", appliesWhen: [] },
    { id: "input_validation", text: "Validate all external input", appliesWhen: [] },
    { id: "graceful_shutdown", text: "Graceful shutdown on signals", appliesWhen: [] },
    { id: "idempotent_writes", text: "Make writes idempotent", appliesWhen: ["write", "db", "database", "persist", "store"] },
    { id: "auth_checks", text: "Authorize every request path", appliesWhen: ["auth", "login", "security", "user"] },
    { id: "rate_limiting", text: "Rate-limit external entrypoints", appliesWhen: ["api", "http", "public"] },
    { id: "migration_rollback", text: "Plan DB migration rollback", appliesWhen: ["migration", "db", "database"] },
  ],
  dont: [
    { id: "no_silent_error_swallowing", text: "Never swallow errors silently", appliesWhen: [] },
    { id: "no_hardcoded_secrets", text: "No hardcoded secrets/tokens", appliesWhen: [] },
    { id: "no_pii_logs", text: "No PII in logs", appliesWhen: ["pii", "compliance", "user", "auth"] },
    { id: "no_breaking_api_changes", text: "No breaking public API changes", appliesWhen: ["api", "public", "client"] },
    { id: "no_new_deps", text: "No new dependencies without review", appliesWhen: [] },
  ],
  failure_modes: [
    { id: "api_timeout", text: "API timeout → degrade (cache) or fail loud", appliesWhen: ["api", "http", "network", "integration"] },
    { id: "auth_failure", text: "Auth failure → 401, no leak", appliesWhen: ["auth", "login", "security"] },
    { id: "disk_full", text: "Disk full → fail loud, no corruption", appliesWhen: [] },
    { id: "partial_write", text: "Partial write → rollback", appliesWhen: ["write", "db", "database", "persist"] },
    { id: "network_partition", text: "Network partition → bounded retries", appliesWhen: ["network", "api", "distributed"] },
    { id: "dependency_unavailable", text: "Upstream dependency down → degrade", appliesWhen: ["api", "integration", "dependency"] },
    { id: "rate_limit_exceeded", text: "Rate limit exceeded → backoff", appliesWhen: ["api", "http"] },
  ],
  edge_cases: [
    { id: "empty_input", text: "Empty input", appliesWhen: [] },
    { id: "huge_input", text: "Huge input / scale", appliesWhen: ["data", "bulk", "upload", "large", "perf"] },
    { id: "concurrent_access", text: "Concurrent access / races", appliesWhen: ["thread", "concurrent", "state", "cache", "worker"] },
    { id: "unicode", text: "Unicode / encoding", appliesWhen: ["text", "input", "string"] },
    { id: "offline", text: "Offline / no network", appliesWhen: ["network", "api", "client", "mobile"] },
    { id: "clock_skew", text: "Clock skew / timezones", appliesWhen: ["time", "sched", "date", "expiry"] },
    { id: "duplicate_events", text: "Duplicate events / retries", appliesWhen: ["event", "queue", "webhook", "idempot"] },
    { id: "partial_failure", text: "Partial failure of a batch", appliesWhen: ["batch", "bulk", "multi"] },
  ],
  invariants: [
    { id: "data_integrity", text: "Data integrity always holds", appliesWhen: [] },
    { id: "idempotency", text: "Idempotency of state changes", appliesWhen: ["write", "db", "database", "persist", "event"] },
    { id: "no_secrets_in_logs", text: "No secrets in logs", appliesWhen: [] },
    { id: "consistent_error_shape", text: "Consistent error shape", appliesWhen: ["api", "http", "client"] },
    { id: "bounded_resource_usage", text: "Bounded memory/CPU usage", appliesWhen: ["perf", "data", "large", "bulk"] },
  ],
};

function contextTerms(ctx: ConstraintContext): Set<string> {
  const raw = [ctx.scope, ctx.stack ?? "", ...ctx.riskSignals].join(" ").toLowerCase();
  return new Set(raw.split(/[^a-z0-9]+/).filter(Boolean));
}

/** Deterministic, context-tailored pre-filled candidates per category (AC-MANUAL-4). */
export function generateCandidates(ctx: ConstraintContext): CategoryCandidates[] {
  const terms = contextTerms(ctx);
  return CATEGORY_ORDER.map((category) => ({
    category,
    items: CANDIDATE_POOL[category]
      .filter(
        (item) =>
          item.appliesWhen.length === 0 ||
          item.appliesWhen.some((keyword) => terms.has(keyword)),
      )
      .sort((a, b) => a.id.localeCompare(b.id)),
  }));
}

/** Interview state machine — soft-gate (AC-MANUAL-5). */
export interface Interview {
  isAnswered(category: ConstraintCategory): boolean;
  answeredCategories(): ConstraintCategory[];
  answer(category: ConstraintCategory, items: string[] | "none"): void;
  isComplete(): boolean;
  answers(): Partial<Record<ConstraintCategory, string[] | "none">>;
}

export function createInterview(): Interview {
  const answers: Partial<Record<ConstraintCategory, string[] | "none">> = {};
  const copy = (): Partial<Record<ConstraintCategory, string[] | "none">> => {
    const out: Partial<Record<ConstraintCategory, string[] | "none">> = {};
    for (const [k, v] of Object.entries(answers) as [ConstraintCategory, string[] | "none"][]) {
      out[k] = v === "none" ? "none" : [...v]; // deep copy — no aliasing (review closure)
    }
    return out;
  };
  return {
    isAnswered: (category) => answers[category] !== undefined,
    answeredCategories: () => CATEGORY_ORDER.filter((c) => answers[c] !== undefined),
    answer(category, items) {
      if (!CATEGORY_ORDER.includes(category)) {
        throw new Error(`unknown constraint category: ${String(category)}`);
      }
      if (items !== "none" && !Array.isArray(items)) {
        throw new Error("answer must be an item array or 'none'");
      }
      answers[category] = items;
    },
    isComplete: () => CATEGORY_ORDER.every((c) => answers[c] !== undefined),
    answers: () => copy(),
  };
}

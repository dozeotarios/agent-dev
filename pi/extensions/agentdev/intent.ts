/**
 * intent — automatic intent detection (the crew is ON; ANY message is
 * classified before any dialogs).
 *
 * build        → new feature/project: full pipeline (plan → ralplan → crew)
 * debug        → something is broken: reproduce → root cause → fix → verify
 * audit        → review existing code: findings report (severity + evidence)
 * investigate  → understand why/what: options report (no code changes)
 *
 * Detection: LLM classification (one fast call) with a keyword fast-path
 * fallback when the model is unavailable. Heuristics are intentionally
 * conservative — unknown/unclear messages default to build (a clarifying
 * grill-lite question can disambiguate later).
 */

export type Intent = "build" | "debug" | "audit" | "investigate";

export const INTENTS: Intent[] = ["build", "debug", "audit", "investigate"];

const DEBUG_HINTS = [
  "broken", "bug", "crash", "crashes", "fails", "failed", "doesn't work",
  "does not work", "not working", "error", "exception", "misbehav", "wrong result",
  "incorrect", "stuck", "hangs", "freeze", "regression", "fix", "break",
];

const AUDIT_HINTS = [
  "audit", "review", "security review", "check for", "vulnerab", "expose",
  "is it safe", "correctness of", "code review", "hardening",
];

const INVESTIGATE_HINTS = [
  "why is", "why does", "why are", "investigate", "what's happening",
  "what is happening", "understand", "root cause", "options", "explain",
  "diagnos", "trace", "profile", "slow", "backing up", "investigat",
];

/** Keyword fast-path — deterministic, free, conservative. */
export function detectIntentHeuristic(text: string): Intent {
  const t = text.toLowerCase();
  if (AUDIT_HINTS.some((h) => t.includes(h))) return "audit";
  if (INVESTIGATE_HINTS.some((h) => t.includes(h))) return "investigate";
  if (DEBUG_HINTS.some((h) => t.includes(h))) return "debug";
  return "build";
}

export interface IntentDetection {
  intent: Intent;
  /** "llm" when the model classified it, "heuristic" on fallback. */
  source: "llm" | "heuristic";
}

/**
 * LLM classification with heuristic fallback. `classify` is injectable
 * (tests pass a stub; production passes a headless pi call).
 */
export async function detectIntent(
  text: string,
  classify: (text: string) => Promise<string | null>,
): Promise<IntentDetection> {
  try {
    const raw = await classify(text);
    if (raw) {
      const cleaned = raw.trim().toLowerCase();
      const hit = INTENTS.find((i) => cleaned.includes(i));
      if (hit && hit !== "build") return { intent: hit, source: "llm" };
      if (hit === "build") return { intent: "build", source: "llm" };
    }
  } catch {
    /* fall through to heuristics */
  }
  return { intent: detectIntentHeuristic(text), source: "heuristic" };
}

/** Default LLM classifier: a headless pi call asking for ONE word. */
export function classifyWithPi(
  pi: (prompt: string, timeoutMs?: number) => Promise<string>,
): (text: string) => Promise<string | null> {
  return async (text: string) => {
    const out = await pi(
      `Classify the user's message into exactly ONE intent.\n\nMessage: "${text.slice(0, 2000)}"\n\n- build: they want something NEW built or extended\n- debug: something is BROKEN and needs fixing\n- audit: they want existing code REVIEWED for issues (security/correctness/perf)\n- investigate: they want to UNDERSTAND why something happens or what the options are (no code changes)\n\nReply with exactly one word: build | debug | audit | investigate`,
      60_000,
    );
    return out.trim() || null;
  };
}

/**
 * define-language (ARCHITECTURE.md §6, AC-MANUAL-3) — deterministic DDD
 * ubiquitous-language glossary extraction, distinct from stack selection.
 * Terms are capitalized tokens from the goal + constraint answers; the
 * glossary flows into the ralplan Planner context.
 */

export interface GlossaryTerm {
  term: string;
  definition: string;
}

/**
 * Deterministic extraction: capitalize domain-y tokens (words that appear
 * capitalized in the goal or were explicitly flagged). Keeps the manual phase
 * runnable without an LLM; the orchestrator's real port may enrich it.
 */
export function extractGlossary(
  goal: string,
  context: string[] = [],
): GlossaryTerm[] {
  const seen = new Map<string, string>();
  const all = [goal, ...context].join(" ");
  // CamelCase / PascalCase identifiers and capitalized words
  const camel = all.match(/\b[A-Z][a-zA-Z0-9]*\b/g) ?? [];
  for (const word of camel) {
    if (word.length < 3) continue;
    if (!seen.has(word)) {
      seen.set(word, `Domain concept referenced by the goal ("${word}").`);
    }
  }
  return [...seen.entries()].slice(0, 8).map(([term, definition]) => ({ term, definition }));
}

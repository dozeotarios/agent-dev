/**
 * define-language (ARCHITECTURE.md §6, AC-MANUAL-3) — deterministic DDD
 * ubiquitous-language glossary extraction, distinct from stack selection.
 * Terms are extracted from the goal text; the glossary flows into the ralplan
 * Planner context.
 *
 * Extraction is deliberately conservative: capitalized sentence words
 * ("The", "Usage", "Robustness") are NOT domain terms. Candidates are
 * backticked/quoted tokens, camelCase/PascalCase identifiers, ALL-CAPS
 * acronyms, and words the goal actually repeats — filtered against a
 * stopword list so the glossary stays clean.
 */

export interface GlossaryTerm {
  term: string;
  definition: string;
}

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "of", "to", "for", "with", "on", "in",
  "at", "by", "from", "is", "are", "was", "were", "be", "been", "being", "it",
  "its", "this", "that", "these", "those", "there", "here", "then", "than",
  "when", "where", "which", "while", "who", "whom", "what", "why", "how",
  "not", "no", "yes", "do", "does", "did", "done", "doing", "can", "could",
  "will", "would", "should", "must", "may", "might", "have", "has", "had",
  "having", "i", "you", "we", "they", "he", "she", "me", "my", "your", "our",
  "their", "his", "her", "us", "them", "if", "else", "so", "as", "into",
  "out", "over", "under", "up", "down", "off", "all", "any", "each", "every",
  "some", "such", "more", "most", "other", "only", "same", "very", "just",
  "also", "even", "still", "well", "back", "use", "using", "used", "want",
  "wants", "need", "needs", "make", "makes", "keep", "keeps", "get", "gets",
  "let", "lets", "like", "look", "work", "works", "thing", "things", "way",
  "ways", "time", "times", "day", "days", "first", "last", "next", "new",
  "old", "good", "bad", "big", "small", "little", "much", "many", "one",
  "two", "three", "put", "take", "takes", "taken", "go", "goes", "given",
  "give", "shows", "show", "called", "call", "calls", "via", "per", "etc",
  "e.g", "i.e", "vs", "ie", "eg",
]);

const GENERIC_TERMS = new Set([
  "usage", "robustness", "constraints", "constraint", "requirement",
  "requirements", "scope", "features", "feature", "tooling", "tests", "test",
  "testing", "documentation", "docs", "default", "defaults", "example",
  "examples", "note", "notes", "important", "todo", "fixme", "cli",
  "file", "files", "dir", "dirs", "directory", "directories", "path", "paths",
  "output", "input", "option", "options", "flag", "flags", "command",
  "commands", "argument", "arguments", "value", "values", "list", "lists",
  "mode", "modes", "version", "versions", "id", "ids", "name", "names",
]);

const WORD_RE = /[A-Za-z][A-Za-z0-9_-]*/g;
const BACKTICK_RE = /`([^`]+)`/g;
const QUOTE_RE = /"([^"]+)"|'([^']+)'/g;
const ACRONYM_RE = /\b[A-Z]{2,}\b/g;
const COMPOUND_RE = /\b[A-Za-z]+[A-Z0-9][A-Za-z0-9_]*\b/g;

function isCleanToken(raw: string, opts: { allowLowercase?: boolean } = {}): string | null {
  const t = raw.trim();
  if (t.length < 2 || t.length > 40) return null;
  // paths/commands with separators are not domain words
  if (/[\s/\\~<>$=@#!?&|;:,.()[\]]/.test(t)) return null;
  if (/^[a-z0-9_-]+$/.test(t) && !/[A-Z]/.test(t)) {
    // bare lowercase tokens are kept only when they repeat in the goal —
    // handled by the caller via the repeat pass; here they must pass the
    // stopword filter
    if (!opts.allowLowercase) return null;
  }
  const lower = t.toLowerCase();
  if (STOPWORDS.has(lower) || GENERIC_TERMS.has(lower)) return null;
  if (/^\d/.test(t)) return null;
  return t;
}

function addTerm(seen: Map<string, string>, term: string): void {
  const key = term.toLowerCase();
  if (seen.has(key)) return;
  if (seen.size >= 8) return;
  seen.set(key, term); // value = display casing
}

/**
 * Deterministic extraction. Candidates, in priority order:
 * 1. backticked/quoted tokens (`snap`, `sha256`, "pocket-notes") — strongest
 *    signal in real briefs
 * 2. camelCase/PascalCase identifiers and ALL-CAPS acronyms
 * 3. words the goal repeats (>= 2 case-insensitive occurrences) and that
 *    appear capitalized at least once
 * All candidates pass a stopword/generic-term filter.
 */
export function extractGlossary(
  goal: string,
  context: string[] = [],
): GlossaryTerm[] {
  const seen = new Map<string, string>();
  const all = [goal, ...context].join(" ");
  if (!all.trim()) return [];

  // 1. backticked / quoted tokens
  for (const re of [BACKTICK_RE, QUOTE_RE]) {
    for (const m of all.matchAll(re)) {
      const raw = (m[1] ?? m[2] ?? m[0]).trim();
      const clean = isCleanToken(raw, { allowLowercase: true });
      if (clean) addTerm(seen, clean);
    }
  }

  // 2. compound identifiers (camelCase/PascalCase) and acronyms
  for (const m of all.matchAll(COMPOUND_RE)) {
    const clean = isCleanToken(m[0]);
    if (clean) addTerm(seen, clean);
  }
  for (const m of all.matchAll(ACRONYM_RE)) {
    const clean = isCleanToken(m[0]);
    if (clean) addTerm(seen, clean);
  }

  // 3. repeated capitalized words (>= 2 occurrences, capitalized at least once)
  if (seen.size < 8) {
    const counts = new Map<string, { total: number; capped: boolean }>();
    for (const m of all.matchAll(WORD_RE)) {
      const w = m[0];
      if (w.length < 3) continue;
      const lower = w.toLowerCase();
      const c = counts.get(lower) ?? { total: 0, capped: false };
      c.total += 1;
      c.capped = c.capped || /^[A-Z]/.test(w);
      counts.set(lower, c);
    }
    for (const [lower, c] of counts) {
      if (seen.size >= 8) break;
      if (c.total >= 2 && c.capped) {
        const clean = isCleanToken(lower);
        if (clean) addTerm(seen, lower);
      }
    }
  }

  return [...seen.values()].map((term) => ({
    term,
    definition: `Domain concept referenced by the goal ("${term}").`,
  }));
}

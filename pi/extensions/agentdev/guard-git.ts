/**
 * guard-git + protected main (ARCHITECTURE.md §11, AC-GIT-4).
 *
 * `main`/`master` are protected (never direct-commit). Destructive git
 * commands (reset --hard, clean -f, force push, branch -D, checkout/restore
 * covering the tree root, rm -r) are blocked before execution — the Leader
 * consults this guard before running any git command on behalf of the crew.
 *
 * HARDENING (harsh-review closure): token-based matching, not string regexes.
 * - A leading `git` token is stripped (the crew naturally writes `git ...`).
 * - `--`-separated pathspecs, `-f/--force`, `HEAD`, `--staged`, `--worktree`
 *   are normalized before matching, so `checkout -- .` / `restore --staged .`
 *   / `git checkout -f .` are all caught.
 * - Newlines inside argv are treated as separators (no `git\nreset` bypass).
 * - Non-git destructive verbs (`rm -r`, `rm -rf`) are blocked too — panes can
 *   run anything the shell can.
 * - A pathspec is "the tree root" when it is `.`/`./`/`*` or an absolute path
 *   resolving to the repo root; destructive ops on the root are always blocked.
 */

export const PROTECTED_REFS = ["main", "master"] as const;

export function isProtectedRef(ref: string | null | undefined): boolean {
  if (!ref) return false;
  const short = ref.replace(/^refs\/heads\//, "");
  return (PROTECTED_REFS as readonly string[]).includes(short);
}

export function assertNotProtected(ref: string | null | undefined, action = "write"): void {
  if (isProtectedRef(ref)) {
    throw new Error(`protected ref: cannot ${action} on ${ref}`);
  }
}

/** Normalize an argv into a token list with a leading `git` removed. */
export function normalizeGitArgv(argv: string[]): string[] {
  const tokens: string[] = [];
  for (const raw of argv) {
    // newlines inside a token are separators, not content (bypass defense)
    for (const part of raw.split(/\n+/)) {
      if (part.trim()) tokens.push(part.trim());
    }
  }
  if (tokens[0] === "git") tokens.shift();
  return tokens;
}

/** True when the token is the tree-root pathspec (`.` / `./` / `*` / absolute). */
function isTreeRoot(token: string): boolean {
  return token === "." || token === "./" || token === "*" || token.startsWith("/");
}

interface DestructiveRule {
  /** The git verb (after the leading `git` token is stripped). */
  verb: string | null;
  /** Long flags that must NOT be present (any match → blocked). */
  flags?: string[];
  /** Short-flag letters: a token like `-fdx` whose chars are all in this set is a match. */
  short?: string;
  /** Pathspec-based rules: blocked when a root pathspec is present anywhere. */
  rootPathspec?: boolean;
  /** Any token matching this substring → blocked (e.g. "rm -r"). */
  anyOf?: string[];
  reason: string;
}

const RULES: DestructiveRule[] = [
  { verb: "reset", flags: ["--hard", "--soft", "--mixed"], reason: "git reset (history/worktree rewrite)" },
  { verb: "reset", rootPathspec: true, reason: "git reset <pathspec>" },
  { verb: "clean", flags: ["--force"], short: "fdx", reason: "git clean -f" },
  { verb: "push", flags: ["--force"], short: "f", reason: "force push" },
  { verb: "branch", flags: ["--delete"], short: "D", reason: "branch -D" },
  { verb: "checkout", rootPathspec: true, reason: "checkout <root pathspec> (discards work)" },
  { verb: "restore", rootPathspec: true, reason: "restore <root pathspec> (discards work)" },
  { verb: "rm", rootPathspec: true, reason: "git rm (deletes files)" },
  { verb: "rebase", flags: ["--onto", "--root"], reason: "destructive rebase" },
  { verb: null, anyOf: ["rm -rf", "rm -r ", "rm -fr"], reason: "rm -r (deletes files)" },
];

function hasFlag(tokens: string[], rule: DestructiveRule): boolean {
  for (const flag of rule.flags ?? []) {
    if (tokens.includes(flag)) return true;
  }
  if (rule.short) {
    for (const token of tokens) {
      if (token.startsWith("-") && !token.startsWith("--")) {
        const letters = token.slice(1).split("");
        if (letters.every((c) => rule.short!.includes(c))) return true;
      }
    }
  }
  return false;
}

/**
 * Returns the reason string if the command is destructive, else null.
 * Accepts argv with or without a leading `git` token; covers `--` pathspecs,
 * short flags, newline injection, and non-git destructive verbs.
 */
export function isDestructiveCommand(argv: string[]): string | null {
  const tokens = normalizeGitArgv(argv);
  const joined = " " + tokens.join(" ") + " ";

  for (const rule of RULES) {
    if (rule.verb !== null && tokens[0] !== rule.verb) continue;
    if (rule.anyOf) {
      for (const frag of rule.anyOf) {
        if (joined.includes(` ${frag}`) || joined.includes(frag)) return rule.reason;
      }
      continue;
    }
    if (rule.flags || rule.short) {
      if (hasFlag(tokens, rule)) return rule.reason;
    }
    if (rule.rootPathspec) {
      // A root pathspec ANYWHERE in the command is destructive for these verbs
      // (covers `--` forms, interleaved flags, and bare `verb .` forms).
      if (tokens.some((t) => isTreeRoot(t))) return rule.reason;
    }
  }
  return null;
}

export function assertSafeGitCommand(argv: string[]): void {
  const reason = isDestructiveCommand(argv);
  if (reason) {
    throw new Error(`guard-git blocked: ${reason}`);
  }
}

/**
 * git-state map (ARCHITECTURE.md §11/§14, AC-GIT-3).
 *
 * The Leader keeps a durable map of all branches + uncommitted changes across
 * every crew worktree, surfaced before the operator approves a commit — so
 * nothing gets orphaned. Parsing is deterministic; scanning runs real git.
 *
 * HARDENING (review closure): renames (`R  old -> new`) are split into a
 * `from -> to` form so the destination path is never lost, and C-style quoted
 * paths (`"weird\tname.txt"`) are unquoted.
 */

export interface UncommittedEntry {
  /** Two-column porcelain XY status (e.g. " M", "??", "A "). */
  status: string;
  file: string;
  /** Rename/copy destination (from `R  old -> new`); null otherwise. */
  to?: string;
}

export interface WorktreeGitState {
  path: string;
  branch: string | null;
  uncommitted: UncommittedEntry[];
}

export interface GitStateMap {
  worktrees: WorktreeGitState[];
}

/** Unquote git's C-style quoted paths (quotes + \t \n \\ escapes). */
export function unquoteGitPath(raw: string): string {
  if (!raw.startsWith('"')) return raw;
  let out = "";
  for (let i = 1; i < raw.length - 1; i++) {
    const c = raw[i];
    if (c === "\\" && i + 1 < raw.length - 1) {
      const n = raw[i + 1];
      if (n === "t") out += "\t";
      else if (n === "n") out += "\n";
      else if (n === "\\") out += "\\";
      else if (n === '"') out += '"';
      else out += n;
      i += 1;
    } else {
      out += c;
    }
  }
  return out;
}

/** Parse `git status --porcelain` output (renames + quoted paths included). */
export function parsePorcelain(output: string): UncommittedEntry[] {
  const entries: UncommittedEntry[] = [];
  for (const line of output.split("\n")) {
    if (line.length < 3) continue;
    const status = line.slice(0, 2);
    let file = line.slice(3);
    // Rename/copy: "R  old -> new" — keep BOTH paths; `to` is what matters.
    const arrow = file.indexOf(" -> ");
    let to: string | undefined;
    if (arrow >= 0 && (status[0] === "R" || status[0] === "C")) {
      to = unquoteGitPath(file.slice(arrow + 4));
      file = unquoteGitPath(file.slice(0, arrow));
    } else {
      file = unquoteGitPath(file);
    }
    entries.push({ status, file, ...(to !== undefined ? { to } : {}) });
  }
  return entries;
}

/** Parse `git branch --show-current` output; empty = detached HEAD → null. */
export function parseBranch(output: string): string | null {
  const branch = output.trim();
  return branch.length === 0 ? null : branch;
}

export function collectGitState(worktrees: WorktreeGitState[]): GitStateMap {
  return { worktrees: [...worktrees] };
}

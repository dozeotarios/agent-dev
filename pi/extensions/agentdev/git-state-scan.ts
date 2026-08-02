/**
 * git-state-scan — tiny real-git helper shared by perform-commit and the
 * orchestrator's branches.json collector (AC-GIT-3 durable map).
 */

import { execFileSync } from "node:child_process";

export type HashRunner = (args: string[], opts?: { cwd?: string }) => string;

export function commitHashOf(worktree: string, git: HashRunner = defaultHashRunner): string {
  return git(["rev-parse", "HEAD"], { cwd: worktree }).trim();
}

const defaultHashRunner: HashRunner = (args, opts) =>
  execFileSync("git", args, { cwd: opts?.cwd, encoding: "utf8", timeout: 15_000 });

export function currentBranch(worktree: string): string | null {
  try {
    const out = execFileSync("git", ["branch", "--show-current"], {
      cwd: worktree,
      encoding: "utf8",
      timeout: 15_000,
    }).trim();
    return out.length === 0 ? null : out;
  } catch {
    return null;
  }
}

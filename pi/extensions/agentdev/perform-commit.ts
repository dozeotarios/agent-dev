/**
 * perform-commit (ARCHITECTURE.md §11, AC-GIT-1/2/5/8) — the ONLY commit path.
 *
 * A commit happens only when the gate is in `committed` (operator-confirmed or
 * +yolo), the target branch is not protected, and guard-git approves the
 * command. The resulting hash is recorded on the gate, so a crash between
 * confirm() and the commit cannot double-commit: a retry sees the recorded
 * hash and skips.
 */

import { execFileSync } from "node:child_process";
import { commitHashOf } from "./git-state-scan";
import { assertNotProtected, assertSafeGitCommand } from "./guard-git";
import type { CommitGate } from "./git-gate";

export type GitRunner = (args: string[], opts?: { cwd?: string }) => string;

const realGit: GitRunner = (args, opts) =>
  execFileSync("git", args, { cwd: opts?.cwd, encoding: "utf8", timeout: 30_000 });

export interface CommitOptions {
  /** Author identity for the commit (default: agentdev). */
  user?: { name: string; email: string };
  /** Injectable git runner (tests); defaults to the real binary. */
  git?: GitRunner;
}

export function performCommit(
  gate: CommitGate,
  worktree: string,
  message: string,
  opts: CommitOptions = {},
): { committed: boolean; hash: string | null; skipped: boolean } {
  const git = opts.git ?? realGit;
  const { phase, commits } = gate.state();
  if (phase !== "committed") {
    throw new Error("performCommit refused: gate is not committed (confirm first)");
  }

  // dedup per WORKTREE: a recorded hash means this worktree's commit already
  // happened (crash retry) — other worktrees are still committed normally.
  if (commits[worktree]) {
    return { committed: false, hash: commits[worktree], skipped: true };
  }

  // read current branch + refuse protected refs
  const branch = git(["branch", "--show-current"], { cwd: worktree }).trim();
  assertNotProtected(branch, "commit");

  // guard-git approves the argv (destructive forms blocked)
  const addArgv = ["add", "-A"];
  const commitArgv = ["commit", "-m", message];
  assertSafeGitCommand(addArgv);
  assertSafeGitCommand(commitArgv);

  git(addArgv, { cwd: worktree });
  const identity = opts.user ?? { name: "agentdev", email: "agentdev@local" };
  // Already-committed (e.g. the rework worker committed its fixes on the
  // staging branch): a clean tree must not fail the gate — record HEAD.
  const porcelain = git(["status", "--porcelain"], { cwd: worktree }).trim();
  if (!porcelain) {
    const hash = commitHashOf(worktree, git);
    gate.recordCommit(worktree, hash);
    return { committed: true, hash, skipped: false };
  }
  git(
    ["-c", `user.name=${identity.name}`, "-c", `user.email=${identity.email}`, ...commitArgv],
    { cwd: worktree },
  );

  const hash = commitHashOf(worktree, git);
  gate.recordCommit(worktree, hash);
  return { committed: true, hash, skipped: false };
}

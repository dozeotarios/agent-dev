/**
 * hook-commits (ARCHITECTURE.md §11, AC-GIT-4) — installs a pre-commit hook
 * into a crew worktree that REFUSES direct commits on protected refs
 * (main/master). `guard-git` consults it at commit time; the hook is the
 * last line of defense even if the orchestrator is bypassed.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PROTECTED_REFS } from "./guard-git";

export const PRE_COMMIT_HOOK = `#!/usr/bin/env sh
# agentdev hook-commits (AC-GIT-4): never direct-commit protected refs.
branch="$(git branch --show-current 2>/dev/null)"
for ref in ${PROTECTED_REFS.join(" ")}; do
  if [ "$branch" = "$ref" ]; then
    echo "agentdev hook-commits: refusing direct commit on protected ref '${PROTECTED_REFS.join("/")}'" >&2
    exit 1
  fi
done
exit 0
`;

export function installCommitHook(repoPath: string): string {
  const hooksDir = join(repoPath, ".git", "hooks");
  mkdirSync(hooksDir, { recursive: true });
  const hookPath = join(hooksDir, "pre-commit");
  writeFileSync(hookPath, PRE_COMMIT_HOOK, { encoding: "utf8", mode: 0o755 });
  return hookPath;
}

export function hasCommitHook(repoPath: string): boolean {
  try {
    const content = readFileSync(join(repoPath, ".git", "hooks", "pre-commit"), "utf8");
    return content.includes("agentdev hook-commits");
  } catch {
    return false;
  }
}

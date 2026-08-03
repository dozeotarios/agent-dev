---
name: agentdev-commit
description: The commit-ready gate — the crew stops at commit-ready, the operator confirms via /agentdev confirm, and each story is committed from its worktree with a conventional message, deduplicated per worktree.
---

# agentdev-commit (AC-GIT-1..8)

## When to use
After review is clean. The gate is per-goal; commits are per-story worktree.
Never commit autonomously in modes that require confirmation.

## Procedure
1. Mark the goal `commit-ready` and report: SUBLEADER REPORT → the operator
   confirms with `/agentdev confirm <goal-id>`.
2. On confirm, for each story worktree:
   - verify the commit gate state (must be committed),
   - commit `feat(<story-id>): <goal summary>` with the repo's pre-commit
     hooks in place (protected refs refuse direct commits),
   - record the resulting hash — a crash between confirm and commit cannot
     double-commit (per-worktree dedup).
3. Collect the git state (branches, uncommitted leftovers) into the goal's
   `branches.json`.
4. Autoclose finished worker panes; the goal reaches `done`.

## Pitfalls
- Committing without the gate confirmed = methodology violation.
- `main`/`master` are protected — direct commits there are refused.
- Never commit a worktree whose verify was red.

## Verification
- Each story has exactly one commit with a conventional message.
- Re-running the commit step after a crash produces no duplicate commits.

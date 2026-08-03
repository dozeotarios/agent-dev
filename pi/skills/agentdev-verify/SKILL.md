---
name: agentdev-verify
description: Deterministic verification gate — run the project's test command in the worktree and report pass/fail with output. Never trust claims; run the suite.
---

# agentdev-verify (AC-VERIFY-1)

## When to use
After every Subworker reports `STORY_DONE`, and after every review rework.
The orchestrator runs this in each worker's worktree.

## Procedure
1. Run the project's test command in the worktree
   (`npm test` by default; honor the repo's actual test script).
2. Capture the output (last 2000 chars are reported).
3. Exit 0 → `{ ok: true }`. Anything else → `{ ok: false, output }`.

## Output
`VerifyResult { ok, output, command }` → the escalation tracker decides
retry vs escalate (max 3 build retries).

## Pitfalls
- A missing test command is a FAILURE, not a pass.
- Timeouts (300s) count as failure — the worktree gets reworked.
- Never trust the worker's claim — always run the suite yourself.

## Verification
- `ok: true` correlates with a genuinely green suite.
- Failure output is attached so rework has a target.

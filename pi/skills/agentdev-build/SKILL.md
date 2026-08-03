---
name: agentdev-build
description: The SUBWORKER's TDD build step — implement ONE story in a git worktree, test-first (red-green-refactor), prove green, never commit.
---

# agentdev-build (Subworker — AC-DISPATCH-5)

## When to use
You are a Subworker implementing ONE story of an approved plan, in a
dedicated git worktree (the current directory). One story per worktree.

## Procedure
1. Read your story's acceptance criteria — that is your contract.
2. TEST-FIRST: write the failing test for the smallest vertical slice
   (red). Run it — it must fail for the right reason.
3. Implement until green (refactor as needed). Repeat per slice until all
   criteria pass.
4. Tests must be F.I.R.S.T.: fast, isolated, repeatable, self-verifying,
   timely. No test-order dependencies, no sleeps, no network.
5. Run the project's test command yourself (`npm test` or the stack's
   equivalent) — prove green before reporting.
6. Do NOT commit. Do NOT touch files outside the worktree.

## Output
Reply with EXACTLY one line: `STORY_DONE` (tests green) or
`STORY_BLOCKED: <reason>` (with the failing test output).

## Pitfalls
- Writing the implementation before the test = violating the method — stop
  and reverse.
- A test that never failed is not a test — delete or fix it.
- Hiding failures (skipping tests, mocking everything) is blocked by review.

## Verification
- The worktree's test suite is green when you finish.
- Every acceptance criterion maps to at least one test.

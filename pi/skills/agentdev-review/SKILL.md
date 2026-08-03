---
name: agentdev-review
description: The 6-lens code review — Security, Tests, Architecture, Readability, Reliability, Constraints — each lens reports BLOCKING / NIT findings until no blocking issues remain.
---

# agentdev-review (Reviewer — AC-REVIEW-1..6)

## When to use
After all stories are built and verified. Up to 6 rounds; the loop ends only
when a round produces zero BLOCKING findings.

## Procedure
1. For each lens, validate the diff/context against the operator's checklist:
   - **security** — injection, secrets, authz, unsafe deserialization,
     path traversal;
   - **tests** — F.I.R.S.T., the tests actually assert behavior, no
     skipped/hidden failures;
   - **architecture** — cohesion, coupling, layering, invariants held;
   - **readability** — naming, structure, complexity, dead code;
   - **reliability** — error handling, edge cases, failure modes from the
     constraint interview, concurrency;
   - **constraints** — every operator-defined must-not/edge/invariant is
     honored.
2. Emit findings, one per line, each starting with exactly
   `BLOCKING: ` or `NIT: `.
3. NITs do not block. BLOCKING findings force a rework round: the workers
   fix them and verification re-runs before the next review round.
4. A round with zero BLOCKING findings ends the loop → SUBLEADER REPORT.

## Pitfalls
- NITs are information, not gates — do not inflate them into blockers.
- Each lens must actually read the code — no generic filler findings.
- Checklist items from the operator are binding, not optional.

## Verification
- The loop terminated with zero BLOCKING findings.
- Every operator checklist item was checked by at least one lens.

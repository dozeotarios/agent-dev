---
name: agentdev-define-constraints
description: Option-driven risk interview for agentdev goals — five categories (Do / Don't / Failure modes / Edge cases / Invariants) curated by the operator. Soft-gate: asked on every plan, never silently skipped.
---

# agentdev-define-constraints (manual phase — AC-MANUAL-4/5/6)

## When to use
Run on EVERY goal, after `agentdev-define-language`, before the project-mode
pick. The answers become planner context, reviewer checklists, and
acceptance-criteria inputs.

## Procedure
1. Generate pre-filled candidates per category (fixed order):
   **do · dont · failure_modes · edge_cases · invariants**.
2. Present each category to the operator; they pick one item, or `none`.
   Timeout → `none` for that category.
3. Every category gets an explicit answer — `none` is valid, silence is not.
4. Map the answers into the goal's constraints:
   - `dont` → must-not rules (e.g. `no_hardcoded_secrets`),
   - `failure_modes` → reliability checklist,
   - `edge_cases` → test checklist,
   - `invariants` → architecture checklist,
   - `do` → general requirements.
5. High-risk signals (auth, migration, PII, API break) switch the goal to
   deliberate mode — stricter consensus and review.

## Output
`{ failureModes, edgeCases, invariants, mustNots }` → planner + reviewers.

## Pitfalls
- Never auto-skip a category silently — `none` is the fallback, not absence.
- Constraints become REVIEWER CHECKLISTS — keep them testable.

## Verification
- The manual summary shows the number of selected constraints.
- The review prompts include the operator's checklist items.

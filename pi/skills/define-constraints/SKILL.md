---
name: define-constraints
description: Option-driven risk interview — surface pre-filled candidates (Do/Don't/Failure modes/Edge cases/Invariants) and let the operator curate. Soft-gate: never silently skipped.
---

# define-constraints (manual phase — AC-MANUAL-4/5/6)

## When to use
Run during the manual phase, AFTER `define-language`, BEFORE `pick-mode`.
Runs on **every plan**. Never silently skipped (soft-gate).

## Flow (option-driven — the Leader does the first draft)
1. Generate pre-filled candidates from context (scope, stack, risk signals)
   via `define-constraints.ts` `generateCandidates` — 5 categories in fixed
   order: **do · dont · failure_modes · edge_cases · invariants**.
2. Present each category as a checklist; the operator toggles / edits / adds
   items, or answers `none`.
3. Every category requires an explicit answer — `none` is a valid answer.
   The interview cannot advance until all 5 categories are answered.
4. Record the answers; they become:
   - input to the ralplan **Planner**,
   - **deliberate-mode** triggers (auth/migration/PII/API-break risk signals),
   - **Subleader acceptance criteria**,
   - the **Reliability and Security reviewer checklists**.

## Soft-gate contract
- Asked on every plan. Never auto-skipped.
- `none` per category is allowed; skipping a category silently is not.

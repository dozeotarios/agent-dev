---
name: choose-stack
description: Guide the operator to select the programming language/stack for a greenfield goal. Existing codebases are LOCKED — never changed.
---

# choose-stack (manual phase — AC-MANUAL-1/2)

## When to use
Run during the manual phase, AFTER `map-codebase`, BEFORE `define-language`.

## Rules
1. If the goal targets an **EXISTING codebase** → the detected stack is **LOCKED**.
   Do not suggest a different language. Record `{ stackId, source: "map-codebase" }`.
2. If **GREENFIELD** → present candidate stacks with rationale across three
   dimensions — **performance, ecosystem, deploy** — tailored to the goal's
   context (perf needs, domain, deploy target, team familiarity).
3. The operator picks; record the choice with a non-empty reason.
4. Never proceed without a stack decision.

## Candidates
`typescript` · `python` · `go` · `rust` (source: `choose-stack.ts`
`STACK_CANDIDATES`; the Leader may add context-tailored options inline).

## Output
`{ stackId, reason, source: "choose" | "map-codebase" }` → feeds
`manual-pipeline` and the ralplan Planner.

> NOTE: this is programming-language / stack selection. `define-language`
> (the DDD ubiquitous-language glossary) is a separate, different step.

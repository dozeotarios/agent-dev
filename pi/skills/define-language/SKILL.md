---
name: define-language
description: Produce a DDD ubiquitous-language glossary (terms + definitions) for the goal, distinct from programming-language selection (AC-MANUAL-3).
---

# define-language

Extract the domain's ubiquitous language (DDD) from the goal and the
define-constraints answers — a glossary of domain terms with one-line
definitions. This is a PLANNING artifact, not a stack decision.

## When to use

In the manual phase, after choose-stack / map-codebase and before
define-constraints. Run it once per goal.

## How

1. Collect the goal text and the constraint answers (do / don't / failure
   modes / edge cases / invariants).
2. Extract candidate terms: capitalized domain nouns and CamelCase
   identifiers in the goal + constraints.
3. For each term, write a one-line definition grounded in the goal.
4. Keep 3–8 terms. Persist the glossary into the goal's planning context
   (`.agentdev/goals/<goal-id>/planning-context.yaml`) so the ralplan
   Planner consumes it.
5. Do NOT conflate with stack selection: "TypeScript" is a stack, not a
   domain term.

## Example

Goal: "Build a REST API for Task Tracking with auth"

```yaml
glossary:
  Task: A unit of work tracked by the system, with a status lifecycle.
  Status: The lifecycle state of a Task (todo, in_progress, done).
  Workspace: The collection of Tasks visible to one user.
```

## Verification

- Every term appears in (or is directly implied by) the goal/constraints.
- Every definition is one line and does not reference implementation tech.

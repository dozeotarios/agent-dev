---
name: agentdev-define-language
description: Extract the goal's DDD ubiquitous-language glossary (terms + definitions) for agentdev. NOT programming-language selection — that is agentdev-choose-stack / agentdev-map-codebase.
---

# agentdev-define-language (manual phase — AC-MANUAL-3)

## When to use
Run on every goal, after the stack is settled, before `agentdev-define-constraints`.
The glossary feeds the Leader's plan and keeps the whole crew speaking one language.

## Procedure
1. Extract candidate terms from the goal text, in priority order:
   - backticked/quoted tokens (`snap`, `sha256`) — the strongest signal,
   - camelCase/PascalCase identifiers and ALL-CAPS acronyms (REST, API),
   - words the goal repeats (≥ 2 occurrences) that appear capitalized.
2. Filter out stopwords and generic words (the, usage, robustness, …).
   Sentence-capitalized single words are NOT domain terms.
3. Cap at 8 terms. Each gets a one-line definition in the goal's context.
4. Feed the terms to the Leader's planning context.

## Output
`[ { term, definition } ]` → included in the manual summary and planner context.

## Pitfalls
- "The", "Usage", "Taking" are NOT domain terms — they are sentence words.
- A glossary with zero terms is fine for a trivial goal; do not pad it.

## Verification
- Every term in the glossary appears meaningfully in the goal.
- No stopword or generic word is in the glossary.

---
name: agentdev-plan
description: The LEADER's planning step — turn the goal + manual-phase context into ONE plan JSON (principles, drivers, options, ADR, testable acceptance criteria) that the crew builds from. May research up-to-date techniques/libraries on the web first.
---

# agentdev-plan (Leader — AC-LEADER-1)

## When to use
The interactive session IS the Leader. Every goal message gets this planning
turn, right after the manual interview (stack, constraints, mode, research
preferences). The plan JSON is captured and handed to the Subleader — nothing
else in your reply is used.

## Procedure
1. Read the manual context: `stack`, `mode`, `constraints`, glossary.
2. **Research (when the operator opted in):** if a goal is a feature or a
   new project, check the web for UP-TO-DATE techniques — current library
   versions, API changes, modern idioms, best practices for the domain.
   Bounded: at most 3 searches; skip if the domain is stable. Fold findings
   into principles/options/ADR (no citation list needed).
3. **filePlan — GRANULAR touch map (binding):** inspect the real repo layout
   (read-only tools) and emit exact repo-root-relative paths:
   `create` (new files), `modify` (existing files), `doNotTouch`
   (untouchables), plus the folder `structure`. Files, not directories —
   include tests and configs. The crew builds exactly this and nothing else;
   reviewers enforce it as a scope boundary.
3. Think the goal through — architecture, slice boundaries, verification.
4. Emit ONE JSON object inside a single ```json code block — no prose
   outside it:
   ```json
   {
     "principles": [3-5 strings],
     "drivers": [exactly 3 strings],
     "options": [ { "name": string, "pros": [strings], "cons": [strings] } x >=2 ],
     "adr": {
       "decision": string, "drivers": [strings], "alternatives": [strings],
       "why": string, "consequences": [strings], "followups": [strings]
     },
     "acceptanceCriteria": [at least 3 testable strings]
   }
   ```
5. Acceptance criteria must be CONCRETE and TESTABLE — they become the
   stories Subworkers implement and verify.
6. **Researched stack (choose-stack research path):** after the JSON block,
   emit one more line `STACK: <id>` with your researched pick.

## Rules
- Use tools ONLY for the research the operator approved (web_search for
  stack/techniques). Never write code, never run commands — plan only.
- Keep the plan tight: countable stories, no gold-plating.
- The ADR records the decision and why — alternatives must be real.

## Pitfalls
- Prose around the JSON is ignored — keep it minimal.
- Vague criteria ("works well") break the crew — write them as tests would
  read them.
- Missing `followups` or empty `alternatives` fails validation → the crew
  falls back to consensus planning (slower).
- Generic "top 10 languages" research is forbidden — research must anchor
  to THIS goal's use case.

## Verification
- The plan parses and passes validation (all ADR fields + ≥ 3 criteria).
- A researched stack emits `STACK: <id>` and appears in the manual summary.
- The SUBLEADER REPORT later names the same stories.

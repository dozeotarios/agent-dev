---
name: agentdev-choose-stack
description: "Stack selection for agentdev goals — DETECT greenfield vs brownfield first: brownfield keeps the existing language (locked), greenfield researches the web for the BEST language for the specific use case (performance, domain fit, ecosystem, deploy) and records the pick with rationale."
---

# agentdev-choose-stack (manual phase — AC-MANUAL-1/2)

## When to use
Run after `agentdev-map-codebase` on EVERY goal. Never skip the
greenfield/brownfield detection.

## Step 1 — DETECT: greenfield or brownfield?
- **Brownfield**: the repo has code (`package.json`, `Cargo.toml`, `go.mod`,
  `pyproject.toml`, source files…). The detected stack is **LOCKED** —
  keep the existing language. Record `{ stackId, source: "map-codebase" }`.
  Do NOT suggest another language, do NOT ask.
- **Greenfield**: empty repo / no code / only a README. Proceed to Step 2.

## Step 2 — GREENFIELD: research the best language FOR THIS USE CASE
Do NOT default to a fixed list, and do NOT do generic "top 10 languages"
research. The choice depends on the USE CASE:

1. Read the goal: what is it? CLI tool · web app · data/ML pipeline ·
   system service · embedded/perf-critical · agent tooling?
2. Research the web for THIS case, evaluating:
   - **performance** needs (latency, throughput, memory),
   - **domain fit** (the language the ecosystem of this domain speaks),
   - **ecosystem** (libraries the goal needs actually exist and are mature),
   - **deploy** (static binary vs runtime vs serverless),
   - **maintainability** (implementation effort for the team).
3. Examples of use-case-driven picks (not a fixed menu):
   - perf-critical CLI / backup tool / low-level service → **Rust**,
   - latency-critical systems / existing C ecosystem → **C / C++**,
   - data pipelines / ML / automation → **Python**,
   - web apps / LLM + agent tooling → **TypeScript (Node.js)**,
   - cloud services / single-binary CLIs with fast compile → **Go**.
4. Pick what the use case actually needs — it may be outside the fixed
   candidate list. Record `{ stackId, reason, source: "research" }` with the
   researched rationale.

## Operator interview
The extension presents the candidates + a
"🌐 Research best fit for this use case (web)" option:
- the operator picks a fixed candidate → recorded directly,
- the operator picks research → the LEADER researches during its planning
  turn (web_search) and emits `STACK: <id>` after the plan JSON,
- the operator doesn't answer (timeout) → default `typescript` (never
  research by default).

## Output
`{ stackId, reason, source: "map-codebase" | "choose" | "research" }` →
the Leader's planning context and every Subworker's worktree.

## Pitfalls
- Skipping the greenfield/brownfield detection → wrong language for an
  existing repo. Detection is a gate, not a suggestion.
- Generic research ("best languages 2026") is forbidden — the research
  must be anchored to THIS goal's use case.
- Never re-ask on resumed goals — the choice is persisted.

## Verification
- Brownfield goals never change language.
- Greenfield goals have a recorded stack + non-empty use-case rationale.
- Research picks cite goal-specific evidence (performance/domain/deploy).

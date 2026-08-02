# agentdev — Architecture & Plan (LOCKED design)

> Status: **v1 implemented (phases 1–10 + review closures); live at 2026-08-02.**
> This document is the single source of truth for the agentdev design.
> Companion files: `specs/planning-context.yaml` (structured handoff), `specs/acceptance-criteria.md` (testable criteria).

---

## 1. Overview

**agentdev** is a turnkey git distribution that turns a single `pi` session into a hierarchical, autonomous coding crew. You talk to one **Leader**; it plans with you, then drives a **visible crew** (built on **herdr**) that builds, verifies, and reviews code until it's clean — then hands you a commit-ready result.

- **Form:** a cloneable git repo, branded `agentdev`. Clone on any PC, develop, push to GitHub, work from anywhere.
- **Two parts:** a **pi extension (the brain)** = orchestration logic; **herdr (the body)** = the agent multiplexer it drives.
- **Install order:** install **herdr first**, then the agentdev brain.

### Design principles
1. **Brain / body split.** herdr does multiplexing (panes, PTYs, agent state, API, persistence). agentdev does orchestration (hierarchy, planning, review, integration). No overlap.
2. **Manual → Autopilot boundary.** The operator drives scope/risk decisions; once locked, the crew runs autonomously to a commit-ready state.
3. **Everything visible.** Every agent role is a real herdr pane you can watch and type into.
4. **Safe by default, autonomous by opt-in.** No autonomous commits except in `+yolo`.
5. **Restart-proof.** All state on disk; herdr keeps panes alive; nothing is lost on crash/restart.
6. **Spec fidelity (binding contract).** The plan (`ARCHITECTURE.md`) and acceptance criteria (`specs/acceptance-criteria.md`) are the binding contract. Any LLM — building agentdev, or running as an agentdev agent — must implement and follow them **exactly**. Deviation is a failure (a failing test or a review blocker), never an "interpretation."
7. **Real-environment testing.** Tests run as close to the real environment as possible: real herdr, real pi, the real OS, and real agents wherever feasible. Mocking is limited to pure deterministic unit logic; integration and E2E must exercise the actual stack, not a simulation.

---

## 2. Goals & Non-goals

**Goals**
- One liaison (Leader) that plans with the operator and runs a crew to completion.
- Recursive hierarchy: Leader → Subleader → Subworker (+ Reviewers).
- Visible, persistent crew in herdr (watch + type + reattach from anywhere).
- Consensus planning (ralplan) before any autonomous build.
- Code review loop (6 lenses) until no actionable findings.
- Works on Windows, WSL, and Linux.
- Installable as a pi package / turnkey distro.

**Non-goals (v1)**
- Arbitrary N-level recursion (3 tiers now).
- A custom ML plan slicer (reuse bigpowers).
- Cost/token budgeting.
- A companion herdr plugin (API-only first).
- A GUI / web dashboard.

---

## 3. System architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  wezterm (terminal emulator)                                     │
│   └─ WSL / Linux / Windows shell                                  │
│       └─ herdr  (agent multiplexer — the BODY)                    │
│            │  panes · real PTYs · agent-state · control API ·      │
│            │  persistence · remote attach                          │
│            │                                                      │
│            ├─ pane: Leader   ← pi + agentdev extension (the BRAIN) │
│            ├─ pane: Subleader A                                     │
│            │    ├─ pane: Subworker A1                               │
│            │    └─ pane: Subworker A2                               │
│            ├─ pane: Subleader B …                                   │
│            └─ pane: Reviewers / consensus agents (ephemeral)       │
│                                                                   │
│  agentdev drives herdr via its CLI + JSON-socket API              │
└─────────────────────────────────────────────────────────────────┘
```

**Substrate — herdr (Apache-2.0, open source):** provides workspaces, tabs, panes (real PTYs), semantic agent state (blocked/working/done/idle), a control surface (CLI + JSON socket: `workspace create`, `pane split`, `pane run`, `wait agent-status`, `pane read`), session persistence, and remote SSH/phone reattach.

**Brain — agentdev pi extension:** registers the toggle command, orchestration tools, and skills; drives herdr through a thin **BackendAdapter**; owns all orchestration logic.

---

## 4. The hierarchy (recursive abstraction)

**Every non-leaf node is an orchestrator; leaves are workers.**

| Role | Type | Owns | bigpowers phase |
|---|---|---|---|
| **Leader** | top orchestrator + operator liaison | Discover, Design, Plan, final Integrate | 1–3, 6 |
| **Subleader** | nested orchestrator | exactly **1 plan / epic**: Initiate → Build → Verify → Review → report | initiate, 5, review |
| **Subworker** | leaf (build) | exactly **1 story**, BUILD only, own worktree | 4 (build) |
| **Reviewer** | leaf (review) | one review pass, one lens | review |

- **Subleader = 1 plan.** Leader produces N plans → N Subleaders.
- **Subworker = 1 story.** A Subleader spawns N Subworkers (one per story from `plan-work`).
- **Recursion:** a Subleader is structurally a Leader over its sub-tree. v1 gates depth to **3 tiers**; the shape supports arbitrary N-level recursion later.

---

## 5. Lifecycle & the Manual → Autopilot boundary

```
════════════ MANUAL  (you + Leader, interactive) ════════════
  Discover      survey-context · research-first · elaborate-spec
  Design        define-language (DDD glossary) · choose-stack/map-codebase
                · deepen-architecture · grill-me
  Constraints   define-constraints  (option-driven risk interview)
  Mode          pick project mode  (no-mistakes / direct-PR / local-only / +yolo)
  ──────────── HANDOFF: enter ralplan ────────────
════════════ AUTOPILOT  (runs to commit-ready, no prompts) ════════════
  Consensus     ralplan: Planner → Architect → Senior Dev → Critic (≤5 → APPROVE)
                → approved plan + ADR + testable acceptance criteria
  Dispatch      Leader → one Subleader per plan
  Build         Subleader → Subworkers (develop-tdd, each own worktree)
  Verify        Subleader → verify-work
  Code review   Subleader → 6 lenses until no actionable findings
  Commit-ready  stops here → awaits operator confirmation (unless +yolo)
════════════ INTEGRATE  (Leader, per project mode) ════════════
  On confirm    commit + (open PR | merge locally) per mode → DONE
```

The **pre-execution gate** *is* this boundary: no autopilot until scope + constraints + mode are locked.

---

## 6. Manual phase (detailed sequence)

1. **`survey/map-codebase`** — detect existing repo vs greenfield. Existing → stack detected and **locked**.
2. **`choose-stack`** *(greenfield only)* — Leader guides the operator to pick language/stack with rationale (perf, ecosystem, team familiarity, deploy target).
   - ⚠️ `define-language` (bigpowers) is the **DDD ubiquitous-language glossary**, *not* programming-language selection. Kept separate; also run during Design.
3. **`define-language`** — DDD glossary (canonical domain terms).
4. **`define-constraints`** — option-driven risk interview (see §7).
5. **Pick project mode** — see §11.

---

## 7. define-constraints (option-driven risk interview)

The Leader **surfaces tailored candidates** (pre-filled checklist), the operator curates. **Soft-gate:** asked on every plan, never silently skipped; any category may be answered "none."

| Category | Example candidates |
|---|---|
| **Do** (positive) | retry w/ backoff · structured logging · idempotent writes · input validation · graceful shutdown |
| **Don't** (anti-requirements) | no new deps · no breaking API changes · no PII in logs · no silent error swallowing |
| **Failure modes** | API timeout → cache · auth fail → 401 · disk full → fail loud · partial write → rollback |
| **Edge cases** | empty/huge input · concurrency · unicode · offline · clock skew |
| **Invariants** | data integrity · idempotency · no secrets in logs |

- Candidates are generated **inline from context** (stack, scope, codebase, domain) via the `define-constraints` skill — no rules engine in v1.
- Outputs flow into: the ralplan **Planner** input, **deliberate-mode** triggers, Subleader **acceptance criteria**, and the **Reliability/Security reviewer** checklists. (Closed loop.)

---

## 8. ralplan consensus (autopilot entry)

Adopts oh-my-claudecode's consensus technique, with **Senior Dev** added.

```
Planner (drafts plan + RALPLAN-DR summary)
   │  principles (3–5) · decision drivers (top 3) · ≥2 viable options (pros/cons)
   ▼
Architect (soundness: steelman antithesis, ≥1 real tradeoff, synthesis)   ← sequential
   ▼
Senior Dev (practical feasibility, idioms, effort/sequencing, risk)       ← sequential
   ▼
Critic (gate: principle-option consistency, testable criteria, concrete
        verification)  →  APPROVE | ITERATE | REJECT
   │
   └─ non-APPROVE → revise with Planner → re-run Architect → Senior Dev → Critic
      (loop ≤ 5 rounds; if exhausted, present best version)
```

- **Deliberate mode** auto-enables for high-risk work (auth/security, migrations, destructive changes, production incidents, compliance/PII, public-API break): adds **pre-mortem (3 scenarios)** + **expanded test plan** (unit/integration/e2e/observability).
- **Output:** approved plan + **ADR** (Decision, Drivers, Alternatives, Why, Consequences, Follow-ups) + **testable acceptance criteria**.
- **Visibility:** a single live **planning pane** streams each pass, the RALPLAN-DR summary, verdicts, and iteration N/5.
- ⚠️ **Two distinct review loops** — do not conflate:
  - *Planning-time:* ralplan Architect + Senior Dev + Critic review the **PLAN** (pre-code).
  - *Build-time:* the 6-lens roster reviews the **CODE** (post-build, §9).

---

## 9. Build-time code review (6 lenses)

Each Subleader runs, per slice, fresh-context reviewers in **herdr panes** (visible), looped until **no actionable findings** (informational nits do not block):

| Lens | Checks |
|---|---|
| Senior SWE | correctness, readability, structure, mergeability |
| Efficiency | performance & resource cost appropriate to the case |
| Security Architect | injection, auth, secrets, unsafe deserialization |
| API/Contract | boundaries, types, cross-layer data-shape consistency |
| Reliability | fault tolerance, observability, recovery, edge cases, concurrency |
| Domain | fits the ubiquitous language + the chosen stack's idioms |

Loop: build → review fan-out → findings routed to the relevant Subworker → rebuild → re-review → until clean.

---

## 10. Visibility, roles & autoclose

**All nodes (Leader, Subleader, Subworker, Reviewer, consensus agents) are herdr panes** — real PTYs, watch + type.

**Role scheme:**
- **Role-prefix labels:** `L:<project>`, `S:<project>/<plan>`, `W:<project>/<plan>/<story>`, `R:<project>/<plan>/<story>#<lens>`.
- **State glyphs** (herdr semantic state): `●` working · `⛔` blocked/needs-you · `✓` done · idle.
- **Fleet overview:** a live org-tree (project → plan → story) with role + state, drill-in to focus any pane.
- **Per-role color:** deferred to a minimal companion plugin (v1 uses labels + state glyphs).

**Autoclose:**
- **Clean completion** → brief `✓` flash → close. Per-role: Subworker after its story; Reviewer after its pass; Subleader after its whole plan; **Leader never**.
- **Failure / blocked** → **stay** (marked `⛔`/`✗`), transcript + report persisted, surfaced on the attention list.
- A failed window **closes only after handled** (retry/reassign/dismiss). Unattended failure past a timeout **stays open and pings you**. Never silent auto-dismiss.

---

## 11. Git integration & project modes

**No autonomous commits (default).** The crew runs to a **commit-ready** state and stops. A commit/push happens **only on operator confirmation via the Leader.**

- The Leader **tracks all branches + all uncommitted changes across every crew worktree** — a live git-state map in agentdev state, surfaced before approval. Nothing gets orphaned.
- **`main` is protected** (never direct-commit). `guard-git` is consulted by the
  only commit path (`perform-commit`); `hook-commits` installs a pre-commit hook
  into crew worktrees that refuses direct commits on protected refs.

| Mode | Behavior |
|---|---|
| `no-mistakes` | heaviest gates; every change reviewed/approved |
| **`direct-PR` (default)** | on your confirm: commit + open a PR (merge stays your call) |
| `local-only` | on your confirm: merge locally, no remote |
| `+yolo` (opt-in) | **auto-commits/pushes** — bypasses the confirmation gate; full autonomy |

So "autopilot to completion" = runs to commit-ready; you approve the finish (unless `+yolo`).

---

## 12. Autopilot escalation

The crew **self-handles** routine failures (flaky tests, transient errors, re-review loops). It **escalates to you only** on:
1. **Retries exhausted** on a task.
2. An **unsettled product/architecture decision** the consensus couldn't resolve.
3. An **explicit "needs human"** (missing credentials, an ambiguity `define-constraints` didn't cover, external approval).

Escalation **pauses only the blocked branch** + notifies you (herdr / phone); the rest of the crew keeps running.

---

## 13. Toggle & entry UX

- `/agentdev on` and `/agentdev off` are the **only** `/agentdev` commands — pure toggle.
- **OFF by default.** A plain `pi` session stays plain.
- **ON** = session-scoped, **always-on agentdev mode**: every message you give the Leader is a goal that runs the workflow. Completing a goal does **not** toggle off.
- **Resets to OFF** when you toggle off **or close the terminal** (not persisted across sessions).
- **Multi-goal:** tell the Leader another goal → it spins up another sub-tree in the fleet.

---

## 14. State & data model

| Location | Contents |
|---|---|
| `.agentdev/` (project, gitignored) | fleet state, plans, consensus artifacts, reports, worktree leases, logs, git-state map |
| `~/.agentdev/` (global) | global config, learned preferences (future), cross-project logs |

All paths via Node `os.homedir()` / `path.join` — **no hardcoded separators** (Windows-safe).

**Fleet state (implemented):**
```
project/.agentdev/
  goals/{goal-id}/
    goal.json                 # step, goal text, stack, mode, constraints, plan, story criteria
    fleet.json                # live org-tree: nodes, roles, states, pane ids (atomic writes)
    gate.json                 # commit-gate phase + per-worktree commit hashes (dedup)
    branches.json             # all branches + uncommitted change map (AC-GIT-3)
    worktrees.json            # durable worktree leases (crash-safe, pruned on restart)
```

---

## 15. Resilience (restart-proof)

- All orchestration state is on disk (`.agentdev/`).
- herdr keeps panes/PTYs alive when the terminal or Leader process dies.
- On restart, agentdev **reconnects to existing panes** and **resumes from on-disk fleet state** — no lost work, no orphan panes (firstmate's model).

---

## 16. Communication

- **herdr control API** (primary): `pane run` / `pane read` / `wait agent-status` / `workspace` / `tab` create — how the brain drives the body.
- **On-disk handoff files** — rich payloads (plans, reports, findings) between nodes.
- **pi intercom** — structured ask/reply between nodes (e.g., Subworker → Subleader escalation, Subleader → Leader report).

---

## 17. Worktree strategy

- **One isolated git worktree per Subworker** (one story = one worktree) → parallel work never collides.
- **Treehouse-pooled** for reuse → deps/build-cache preserved, so the next Subworker starts fast instead of re-installing.
- **Leader + Subleaders** operate on the **main checkout** (they coordinate; they don't write code in parallel).
- treehouse is an **optional** dependency (we can pool worktrees ourselves).

---

## 18. Cross-platform

| Target | Support |
|---|---|
| **Linux** | Full (herdr stable). |
| **WSL ("here")** | Full (herdr stable). Primary dev environment. |
| **Windows native** | Mandatory & first-class; crew fidelity tracks **herdr-Windows beta** maturity. No tmux fallback (tmux has no real native Windows build). |

Develop on WSL; ship to all three.

---

## 19. Prerequisites & install flow

**Prerequisites:** `herdr` + `pi` + `git` + `gh` (for direct-PR / release-branch) + `node` (run/develop the extension). `treehouse` optional.

**Setup (turnkey):**
1. Clone `agentdev`.
2. Run setup → **checks/installs herdr first**, then installs the brain (extension + skills), configures.
3. Launch `pi` inside the agentdev dir; `/agentdev on` to engage the crew.

---

## 20. Component / module breakdown (proposed)

```
agentdev/
  pi/extensions/agentdev/
    index.ts                  # entry: toggle command, tool registration, lifecycle hooks
    toggle.ts                 # ON/OFF state (session-scoped)
    orchestrator.ts           # Leader dispatch loop, goal → sub-tree
    backend-adapter.ts        # herdr API abstraction (pluggable: tmux/zellij later)
    ralplan.ts                # consensus loop (Planner→Architect→SeniorDev→Critic)
    review.ts                 # 6-lens review fan-out + loop
    git-gate.ts               # commit-ready gate, branch/uncommitted tracking, modes
    worktree.ts               # per-Subworker worktree acquire/release (treehouse-pool)
    fleet-state.ts            # .agentdev/ state, restart reconciliation
    autoclose.ts              # clean/failure close policy
  pi/skills/
    choose-stack/SKILL.md
    define-constraints/SKILL.md
    (ralplan prompts: planner/architect/senior-dev/critic)
  tests/
    unit/                     # deterministic logic (mocked herdr) — vitest
    integration/              # real herdr (v0.7.5): pane/workspace/worktree/git
    e2e/                      # full goal → commit-ready pipeline
    helpers/                  # herdr-is-present guard, fixtures, stub agents
  specs/
    planning-context.yaml
    acceptance-criteria.md
  ARCHITECTURE.md
  package.json                # vitest + scripts: test / test:unit / test:integration / test:e2e
  setup.sh / setup.ps1
```

---

## 21. Testing strategy

Testing is a first-class part of the plan, not an afterthought. Every empirically-testable behavior has a runnable test; a feature is done only when its tests exist and pass.

**Real-environment fidelity (default to real):** prefer the real stack over mocks everywhere except pure deterministic unit logic. Integration tests use the installed herdr + real pi loader; E2E uses real herdr + real (or recorded) agents on real Linux/WSL/Windows. A test that mocks away herdr/pi/OS counts only at the unit layer — never as integration or E2E.

**Test-first policy (TDD):**
- **Write the test first (red → green → refactor)** for any feature with deterministic logic: state machines (toggle), command builders (BackendAdapter), loop termination (ralplan ≤5), policies (autoclose, git-gate, escalation), serializers (fleet-state), worktree pooling. (bigpowers `develop-tdd` + `enforce-first`.)
- **Tests-after** is acceptable for integration glue and E2E where test-first is impractical — but the test exists before "done".

**Quality bar:** F.I.R.S.T. (Fast · Independent · Repeatable · Self-validating · Timely).

**Testing taxonomy — what we test × how:**

| Layer | What's under test | How | Determinism |
|---|---|---|---|
| **Code (unit)** | our deterministic logic — state machines (toggle), command builders (BackendAdapter), loop bounds (ralplan ≤5), policies (autoclose, git-gate, escalation), serializers (fleet-state), worktree pooling | vitest, mocked deps, **TDD-first** | deterministic |
| **Framework (integration)** | correct use of the platforms — **pi** (extension lifecycle: event hooks, tool/command registration, session replace/reload, `before_agent_start`), **herdr** (CLI/socket API: workspace/pane/worktree/agent-state/wait), **pi-subagents** (intercom, async), **bigpowers** (skill invocation) | vitest + real herdr + pi loader; contract tests on framework surfaces | deterministic (vs stable APIs) |
| **Agentic (eval)** | LLM-driven behavior — Leader manual phase, ralplan consensus quality, reviewer findings validity, subworker code correctness | **evals** (below): rubric graders + structural asserts + pass@k; fixture/recorded agents for regression | non-deterministic → graded |
| **E2E** | full goal → commit-ready pipeline (AC-DOD-1) | real herdr + real agents | graded |

**Agentic testing (eval-driven; bigpowers `run-evals`):**
- Define the **capability eval + grader before building** each agentic feature (eval-driven development).
- **Graders:** deterministic graders run `verify` commands (produced code passes the project's tests; plan output contains an ADR + testable criteria; review flags an injected defect); model graders score explicit rubrics (does the review catch X? is the plan sound?).
- **pass@k** logged for every agentic eval.
- **Fixtures/recordings** replay recorded consensus/review loops for deterministic regression without re-spending tokens.
- Real-model evals run on a **schedule** (cost), not per-commit.

**Also:** contract tests (cross-boundary data shapes, `validate-contracts`), property tests (fleet-state & state-machine invariants), install smoke (cross-platform).

**Levels × when:** unit every save (TDD) · framework integration pre-merge · agentic evals on schedule · E2E nightly + release.

**Layout:** `tests/{unit,integration,e2e,helpers}` + `tests/evals/` (agentic) + `tests/fixtures/` (recordings).

**Guards & harness:**
- `herdr-is-present` helper skips integration/E2E with a clear message if herdr is missing.
- Runner: **vitest** (`*.test.ts`). jiti (pi's loader) lives in pi's own `node_modules` — run tests under vitest or pi's loader, never plain `node -e`.
- Coverage floor: every BackendAdapter method, every state-machine transition, every policy branch, and the ralplan loop bound must have ≥1 passing test; every agentic capability has ≥1 eval with a defined grader.

**CI:** unit on every push; framework integration on Linux + WSL; agentic evals nightly; E2E nightly + on release tags. (Windows integration tracks herdr-Windows maturity.)

---

## 22. Build roadmap (TDD-aware phases)

Each phase ships with its tests — **test-first for deterministic logic**. A phase is done only when its unit + relevant integration tests pass.

1. **Scaffold + harness + toggle** — repo skeleton, `package.json` + vitest, `tests/helpers` (herdr-is-present); **test-first**: toggle state machine (registers/unregisters tools, session-scoped reset, only `on|off`).
2. **herdr BackendAdapter** — **test-first** (unit, mocked herdr): workspace/pane/worktree command builders; then **integration** against real herdr: create + label a pane, read state, close.
3. **Manual phase skills** — `choose-stack`, `define-constraints`; **test-first**: candidate generation from fixture context, soft-gate never skips, sequence order.
4. **ralplan consensus** — **test-first**: loop terminates on APPROVE, caps at 5 then yields best, deliberate mode triggers on risk signals, ADR + acceptance-criteria in output.
5. **Autopilot dispatch** — Leader → Subleader → Subworker; **test-first** (unit) + integration: 1 plan → 1 Subleader, 1 story → 1 worktree, pool acquire/release.
6. **6-lens review loop** — **test-first**: 6 lenses fan out, findings routed, terminates at "no actionable findings", nits don't block.
7. **Git gate + modes** — **test-first** + integration (real git repo): no commit without confirm, `+yolo` auto-commits, git-state map, `main` protected, `guard-git`.
8. **Visibility + autoclose** — integration (real herdr): role labels, fleet overview, autoclose clean-vs-failed, attention list.
9. **Resilience + cross-platform** — integration: restart reconciliation; per-OS smoke (Linux/WSL full, Windows gated).
10. **E2E + packaging** — E2E (AC-DOD-1) on Linux/WSL; package as pi package; setup script.

**Agentic phases (3, 4, 6, 10) additionally define capability evals + graders before implementation (eval-driven, §21) and are pass@k-gated.**

---

## 23. v1 scope vs deferred

**v1:** herdr API-only (no plugin) · herdr-only backend (pluggable interface) · 3-tier hierarchy · bigpowers slicing reuse · restart-proof · Windows/WSL/Linux.

**Deferred:** cost/token budgets · arbitrary N-level recursion · custom ML slicer · companion herdr plugin (per-role color) · learned-preferences knowledge base.

---

## 24. Risks & mitigations

| Risk | Mitigation |
|---|---|
| herdr-Windows beta instability | Mark Windows experimental; WSL = full; no tmux fallback (worse). |
| Token cost of a full autonomous crew | (Deferred) max concurrency + per-node budgets + spend ceiling. |
| herdr plugin/API churn (young project) | Depend on the stable CLI/socket API first; isolate behind BackendAdapter. |
| Runaway/failed nodes | Autoclose policy + escalation triggers + attention list + restart-proof state. |
| Lost/uncommitted work | Git-state map tracked by Leader; commit-ready gate; protected `main`. |
| Reviewer/role conflation | Two clearly separated review loops (plan vs code); distinct Senior Dev (plan) vs Senior SWE (code). |
| E2E agent tests costly / non-deterministic | E2E nightly + on release only (not per-commit); fixture/recorded agents; `herdr-is-present` guard. |
| pi-extension test-harness (jiti) friction | Run tests under vitest / pi loader, never plain `node`; harness proven in Phase 1. |

---

## 25. Definition of done (v1)

agentdev is done for v1 when: a clean clone → install herdr → `/agentdev on` → give a goal on Windows/WSL/Linux → the crew runs the manual phase, reaches ralplan consensus, dispatches Subleaders/Subworkers, builds, verifies, reviews to no-actionable-findings, stops at commit-ready, and on your confirmation commits/integrates per the chosen mode — surviving a restart — with every role visible in herdr. (Full testable criteria: `specs/acceptance-criteria.md`.) DoD requires all four test layers green: **code (unit)**, **framework (integration)**, **agentic (eval)**, and **E2E**.

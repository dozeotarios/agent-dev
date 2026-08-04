# agentdev — Acceptance Criteria (v1)

> Testable criteria for the locked design. Each capability has Given/When/Then-style
> acceptance. "Done" = all criteria pass. Companion: `../ARCHITECTURE.md`, `planning-context.yaml`.

Format: **AC-<area>-<n>** — Given / When / Then.

---

## 0. Testing policy (empirical tests required)

Every acceptance criterion that is empirically testable **must** have an automated,
runnable test. Prose Given/When/Then is the *spec*; an empirical test is the *proof*.
A feature is not "done" until its tests exist and pass.

**When tests are written (TDD-first; tests-after allowed):**
- **Test-first (TDD: red → green → refactor)** for any feature with deterministic logic
  (state machines, parsers, command builders, loop termination, policies). Write the
  failing test, implement until green, refactor. (the methodology library `develop-tdd` + `enforce-first`.)
- **Tests-after** is acceptable for integration glue and E2E flows where test-first is
  impractical — but the test must still exist before the feature is declared done.

**Test quality (F.I.R.S.T.):** Fast · Independent · Repeatable · Self-validating · Timely.

**Testing taxonomy — what × how** (mirrors `ARCHITECTURE.md` §21):

| Layer | What's tested | How | Speed |
|---|---|---|---|
| **Code (unit)** | our deterministic logic (no herdr, no LLM) | vitest + mocked deps, **TDD-first** | fast, every save |
| **Framework (integration)** | correct use of pi / herdr / pi-subagents / the methodology library APIs | vitest + real herdr + pi loader; contract tests | medium, pre-merge |
| **Agentic (eval)** | LLM behavior (manual phase, ralplan, reviewers, subworkers) | **evals**: rubric graders + structural asserts + pass@k; fixture/recorded agents | scheduled (cost) |
| **E2E** | full goal → commit-ready pipeline (AC-DOD-1) | real herdr + real agents | slow, nightly / release |

**Agentic features are eval-driven** (the methodology library `run-evals`): define the capability eval +
grader *before* building; deterministic graders run `verify` commands, model graders use
explicit rubrics; pass@k logged; fixtures/recordings for regression.

**Spec adherence (binding contract).** `ARCHITECTURE.md` and this file are the binding
contract. Any LLM — whether *building* agentdev or *running as* an agentdev agent — must
implement/follow them **exactly**. A deviation from a criterion is a failing test or a
review blocker, never an "interpretation"; every implemented behavior is validated against
its matching AC.

**Real-environment testing.** Tests run as close to the real environment as possible: real
herdr, real pi, the real OS, and real agents wherever feasible. Mocks are allowed **only**
for pure deterministic unit logic; integration and E2E must use the actual stack (no
herdr/pi/OS simulation at those layers).

- **AC-SPEC-1** — Given any implemented behavior, When validated, Then it matches its criterion in `ARCHITECTURE.md` / this file exactly; a mismatch fails the test or review.
- **AC-SPEC-2** — Any LLM used (builder or runtime agent) is bound to the plan + criteria; any deviation is recorded as a failure, not an interpretation.
- **AC-REAL-1** — Integration tests run against the real installed herdr + real pi loader (no herdr/pi simulation at this layer).
- **AC-REAL-2** — E2E tests run on the real OS (Linux/WSL/Windows) with real herdr + real (or recorded) agents.
- **AC-REAL-3** — Mocking is permitted only at the unit layer (pure deterministic logic); an integration/E2E test that mocks herdr, pi, or the OS does not count toward DoD.

**Test-harness note (pi extensions):** jiti (pi's TS loader) lives inside
`@earendil-works/pi-coding-agent`'s own `node_modules`; extension tests cannot run via
plain `node`. Run them through pi's loader, or as real `.test.ts`/`.cjs` files under a
proper runner (e.g. vitest) — not `node -e`. (Known quirk; plan the harness accordingly.)

See §N for the concrete empirical test mapped to each area.

---

## A. Toggle & entry UX

- **AC-TOGGLE-1** — Given a fresh `pi` session in the agentdev dir, When the operator runs `/agentdev on`, Then agentdev mode is active for the session and orchestration tools are registered.
- **AC-TOGGLE-2** — Given agentdev is ON, When the operator runs `/agentdev off`, Then orchestration tools are unregistered and the session behaves as plain `pi`.
- **AC-TOGGLE-3** — Given agentdev was ON (or OFF) and the terminal is closed, When a new session starts in the same project, Then agentdev restores the previous state; a brand-new project is OFF by default (state persists per project in `.agentdev/toggle.json`).
- **AC-TOGGLE-4** — Given `/agentdev on` is the only accepted `/agentdev` form, When the operator types `/agentdev` without `on|off`, Then a usage hint is shown (no other `/agentdev` subcommands exist).
- **AC-TOGGLE-5** — Given agentdev is ON, When the operator sends any message, Then it is treated as a goal entering the workflow (manual phase). Completing a goal does not toggle off.
- **AC-TOGGLE-6** — Given one goal is in flight, When the operator sends a second goal, Then a second sub-tree is created in the fleet (multi-goal).

---

## B. Manual phase

- **AC-MANUAL-1** — Given a goal on an existing repo, When the Leader runs `map-codebase`, Then the stack is detected and locked (never suggested to change).
- **AC-MANUAL-2** — Given a greenfield goal, When the Leader runs `choose-stack`, Then it guides the operator to pick a stack with rationale and the choice is recorded.
- **AC-MANUAL-3** — The Leader runs `define-language` to produce a DDD ubiquitous-language glossary (distinct from programming-language selection).
- **AC-MANUAL-4 (define-constraints, option-driven)** — Given the manual phase, When the Leader runs `define-constraints`, Then it presents pre-filled candidate items per category (Do / Don't / Failure modes / Edge cases / Invariants) tailored to context, and the operator can toggle/edit/add/none each.
- **AC-MANUAL-5 (soft-gate)** — The `define-constraints` interview runs on every plan and never silently skips; any category may be answered "none".
- **AC-MANUAL-6** — Given the manual phase, When constraints are captured, Then they are persisted and flow into the ralplan Planner input, deliberate-mode triggers, Subleader acceptance criteria, and the Reliability/Security reviewer checklists.
- **AC-MANUAL-7** — The operator picks a project mode (`no-mistakes` | `direct-PR` | `local-only` | `+yolo`) before handoff; default is `direct-PR`.
- **AC-MANUAL-8** — The manual-phase sequence is deterministic: `map-codebase` → `choose-stack` (greenfield) → `define-language` → `define-constraints` → pick mode → enter ralplan.

---

## C. ralplan consensus (planning-time)

- **AC-RALPLAN-1** — On handoff, the Planner drafts a plan + RALPLAN-DR summary (principles 3–5, top-3 drivers, ≥2 viable options with pros/cons).
- **AC-RALPLAN-2** — Architect runs after Planner (sequential) and provides a steelman antithesis, ≥1 real tradeoff, and synthesis.
- **AC-RALPLAN-3** — Senior Dev runs after Architect (sequential) and evaluates practical feasibility, idioms, effort/sequencing, risk.
- **AC-RALPLAN-4** — Critic runs after Senior Dev (sequential) and returns APPROVE | ITERATE | REJECT against testable acceptance criteria + concrete verification.
- **AC-RALPLAN-5** — On non-APPROVE, the full loop (Planner revise → Architect → Senior Dev → Critic) repeats, max 5 iterations; on exhaustion the best version is presented.
- **AC-RALPLAN-6 (deliberate mode)** — For high-risk signals (auth/security, migrations, destructive changes, prod incidents, compliance/PII, public-API break), deliberate mode auto-enables and adds a pre-mortem (3 scenarios) + expanded test plan (unit/integration/e2e/observability).
- **AC-RALPLAN-7** — Consensus output includes an ADR (Decision, Drivers, Alternatives, Why, Consequences, Follow-ups) and testable acceptance criteria.
- **AC-RALPLAN-8 (visibility)** — The consensus loop is streamed in a single live planning pane (role, pass, verdict, iteration N/5, RALPLAN-DR summary).
- **AC-RALPLAN-9 (separation)** — Planning-time review (Architect/Senior Dev/Critic on the PLAN) is distinct from build-time review (6 lenses on CODE).

---

## D. Dispatch & build

- **AC-DISPATCH-1** — Each approved plan (epic) is handed to exactly one Subleader.
- **AC-DISPATCH-2** — A Subleader spawns N Subworkers, one per story (from `plan-work`); each Subworker owns exactly one story.
- **AC-DISPATCH-3** — Each Subworker runs in its own isolated git worktree (one story = one worktree); parallel Subworkers on the same repo never collide.
- **AC-DISPATCH-4** — Worktrees are pooled for reuse so dependencies/build-cache are preserved across stories.
- **AC-DISPATCH-5** — Subworkers build using `develop-tdd` (+ `enforce-first`); Leader and Subleaders operate on the main checkout and do not write code in parallel with Subworkers.

---

## E. Verify & build-time code review

- **AC-VERIFY-1** — Each Subleader runs `verify-work` on its slice before review.
- **AC-REVIEW-1** — Code review runs 6 lenses: Senior SWE, Efficiency, Security, API/Contract, Reliability, Domain.
- **AC-REVIEW-2** — Reviewers run as fresh-context agents in their own herdr panes (visible).
- **AC-REVIEW-3** — Findings are routed to the relevant Subworker; the slice is rebuilt and re-reviewed; the loop continues until every lens returns "no actionable findings".
- **AC-REVIEW-4** — Informational nits do not block; the bar is "no actionable findings".
- **AC-REVIEW-5** — Reliability and Security reviewers validate against the operator's `define-constraints` inputs (failure modes, edge cases, invariants, must-nots).

---

## F. Visibility, roles & fleet

- **AC-VIS-1** — Every role (Leader, Subleader, Subworker, Reviewer, consensus agents) runs as a real herdr pane (PTY) the operator can watch and type into.
- **AC-VIS-2** — Panes/workspaces are labeled with the role-prefix convention (`L:`/`S:`/`W:`/`R:`) and hierarchy path.
- **AC-VIS-3** — Each pane shows herdr semantic agent state (working / blocked / done / idle).
- **AC-VIS-4** — A fleet overview renders the live org-tree (project → plan → story) with role + state and supports drill-in to focus any pane.
- **AC-VIS-5** — An attention list surfaces blocked / needs-you nodes.

---

## G. Autoclose

- **AC-CLOSE-1** — On clean completion, a node shows a brief `✓` flash then its herdr pane closes.
- **AC-CLOSE-2** — Subworker closes after its story; Reviewer after its pass; Subleader after its whole plan; Leader never autocloses.
- **AC-CLOSE-3** — On failure/blocked, the pane stays open (marked `⛔`/`✗`), transcript + report persisted, surfaced on the attention list.
- **AC-CLOSE-4** — A failed pane closes only after being handled (retry / reassign / dismiss).
- **AC-CLOSE-5** — An unattended failure past a timeout stays open and pings the operator; no silent auto-dismiss.

---

## H. Git gate & project modes

- **AC-GIT-1** — The crew does not commit or push autonomously (default); it stops at commit-ready.
- **AC-GIT-2** — A commit/push occurs only after the operator confirms via the Leader.
- **AC-GIT-3** — The Leader maintains a durable map of all branches + all uncommitted changes across crew worktrees, surfaced before approval.
- **AC-GIT-4** — `main` is protected (never direct-commit); `guard-git` blocks destructive git; `hook-commits` runs at commit time.
- **AC-GIT-5** — `direct-PR` (default): on confirm, commit + open a PR (merge remains the operator's call).
- **AC-GIT-6** — `local-only`: on confirm, merge locally with no remote operation.
- **AC-GIT-7** — `no-mistakes`: heaviest gates; every change reviewed/approved before commit.
- **AC-GIT-8** — `+yolo` (opt-in): auto-commits/pushes, bypassing the confirmation gate.

---

## I. Autopilot escalation

- **AC-ESCAL-1** — The crew self-handles recoverable failures (flaky tests, transient errors, re-review loops) without prompting the operator.
- **AC-ESCAL-2** — Escalation to the operator occurs only on: retries exhausted on a task; an unsettled product/architecture decision; an explicit "needs human".
- **AC-ESCAL-3** — Escalation pauses only the blocked branch and notifies the operator (herdr / phone); other branches keep running.

---

## J. State & resilience

- **AC-STATE-1** — Project state lives under `.agentdev/` (gitignored); global state under `~/.agentdev/`.
- **AC-STATE-2** — All paths use `os.homedir()`/`path.join` (no hardcoded separators) — Windows-safe.
- **AC-RESIL-1** — If the Leader process or terminal dies mid-autopilot, herdr panes survive; on restart agentdev reconnects to existing panes and resumes from on-disk fleet state with no lost work and no orphan panes.

---

## K. Cross-platform & install

- **AC-PLATFORM-1** — agentdev installs and runs on Linux, WSL, and Windows.
- **AC-PLATFORM-2** — Linux and WSL provide full support (herdr stable).
- **AC-PLATFORM-3** — Windows native is supported; crew fidelity is gated on herdr-Windows maturity (documented, not blocked). No tmux fallback path exists.
- **AC-INSTALL-1** — Setup checks/installs herdr first, then installs the brain (extension + skills), then configures.
- **AC-INSTALL-2** — Prerequisites are detected: herdr, pi, git, gh, node (treehouse optional).

---

## L. v1 scope boundaries

- **AC-SCOPE-1** — v1 uses the herdr API only (no companion herdr plugin).
- **AC-SCOPE-2** — v1 backend is herdr-only behind a pluggable BackendAdapter interface (tmux/zellij not implemented).
- **AC-SCOPE-3** — Hierarchy depth is capped at 3 tiers in v1.
- **AC-SCOPE-4** — Cost/token budgets, custom ML slicer, and N-level recursion are not implemented in v1.

---

## M. Definition of done (v1, end-to-end)

**AC-DOD-1** — On a clean clone (Windows / WSL / Linux): install herdr → `/agentdev on` → give a goal → the crew runs the manual phase, reaches ralplan consensus, dispatches Subleaders/Subworkers, builds, verifies, reviews to no-actionable-findings, stops at commit-ready, and on operator confirmation commits/integrates per the chosen mode — surviving a restart — with every role visible in herdr.

---

## N. Test-level matrix (empirical tests per area)

Concrete runnable tests that prove each area. `U` = unit, `I` = integration (real herdr), `E` = E2E.

| Area | Empirical test(s) | Level |
|---|---|---|
| **A Toggle** | toggle state machine registers/unregisters orchestration tools; resets to OFF on a new session; only `on\|off` is accepted (anything else → usage hint) | U |
| **B Manual phase** | `define-constraints` returns curated candidates from a fixture context; soft-gate never skips; manual-phase order is asserted end-to-end | U; E |
| **C ralplan** | loop terminates on APPROVE; caps at 5 iterations then yields best version; deliberate mode triggers on risk signals; output contains ADR + testable acceptance criteria | U (stubbed agents); E (real agents) |
| **D Dispatch/build** | 1 plan → exactly 1 Subleader; 1 story → 1 worktree; pooled worktree acquire/release returns to pool; no two Subworkers share a worktree | U + I |
| **E Verify/review** | review fan-out runs all 6 lenses; routes findings to the correct Subworker; terminates at "no actionable findings"; informational nits do not block | U; E |
| **F Visibility** | herdr `workspace`/`pane` created with the role-prefix label; node status reflects herdr agent-state; fleet overview renders the org-tree from fleet state | I (real herdr) |
| **G Autoclose** | clean-exit pane closes after a brief `✓` flash; failed pane stays open; handled-then-close; timeout-ping fires for unattended failures | I (real herdr pane lifecycle) |
| **H Git gate** | no commit without confirmation; `+yolo` auto-commits; git-state map captures all branches + uncommitted changes; `main` protected; `guard-git` blocks destructive ops | U + I (real git repo) |
| **I Escalation** | self-handles recoverable failures; escalates only on the 3 triggers; pauses only the blocked branch while others continue | U; E |
| **J State/resilience** | state round-trips through `.agentdev/`; all paths Windows-safe (`os.homedir()`/`path.join`); after a simulated crash, restart reconnects to panes + resumes from fleet state | U + I |
| **K Cross-platform** | install + smoke passes on Linux, WSL, and Windows; no hardcoded path separators | I (per-OS CI) |
| **L Scope** | no companion plugin loaded in v1; BackendAdapter is the sole herdr touchpoint; hierarchy depth cap = 3 | U |

**DoD includes:** the E2E test (AC-DOD-1) passes on Linux and WSL (Windows gated on herdr-Windows maturity); the full **code (unit)** + **framework (integration)** suites are green; **agentic evals** are green (pass@k ≥ threshold); and a `herdr-is-present` precondition check guards integration/E2E tests (skip with a clear message if herdr is missing).

**Agentic areas (B, C, E, I) additionally require capability evals** (rubric-graded, pass@k) per §0 — e.g.: ralplan reaches a sound APPROVE within bound; a reviewer flags an injected security defect; define-constraints surfaces the relevant failure mode for a fixture context; escalation fires only on the 3 triggers.

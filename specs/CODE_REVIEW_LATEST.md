# agentdev — 27-Pass Harsh Code Review (9 personas × 3 passes)

> Generated 2026-08-02. Method: 3 sequential review waves; each wave ran 9 personas in
> parallel with fresh contexts (reviewer agents, read-only). Pass 1 = broad harsh sweep;
> Pass 2 = adversarial verification (re-verify every pass-1 finding against code,
> deep-trace ≥3 paths, find new findings); Pass 3 = final gate (re-verify all, drop false
> positives, rank by impact, final verdict + top-5 must-fix).
> Personas: Senior SWE, Senior Architect, Senior Reliability, Senior Efficiency, Security,
> API/Contract, Test Engineer, DevOps/CI, Spec/Product Auditor (last five invented).
> Findings were verified with live probes against real herdr 0.7.5 and real git.
> Raw per-pass artifacts: `/tmp/agentdev-review/wave{1,2,3}/<persona>.md`.

## Verdicts

| Persona | P1 | P2 | P3 (final) | Drop rate |
|---|---|---|---|---|
| Senior SWE | FAIL | FAIL | **FAIL** | 0/24 |
| Senior Architect | FAIL | FAIL | **FAIL** | 0/24 |
| Senior Reliability | FAIL | FAIL | **FAIL** | 0/26 |
| Senior Efficiency | PASS-WITH-RESERVATIONS | (same) | **PASS-WITH-RESERVATIONS** | 0/13 |
| Security | FAIL | FAIL | **FAIL** | 0/23 |
| API/Contract | FAIL | FAIL | **FAIL** | 0/22 |
| Test Engineer | FAIL | FAIL | **FAIL** | 0/25 |
| DevOps/CI | FAIL | FAIL | **FAIL** | 1 sub-claim only |
| Spec/Product Auditor | FAIL | FAIL | **FAIL** | 0/28 |

**8/9 FAIL. Zero substantive false positives across 27 passes** (one pass-1 mechanism
claim corrected in pass 2; one pass-1 impact claim corrected; one devops sub-claim
dropped for setup.sh). Cross-pass re-verification found the code base unchanged
(HEAD `9c786ce`) and every finding stable.

## The Big Picture (agreed by all 9 personas)

**The repo is an excellent, exhaustively-tested library of deterministic policy modules
— and the product does not exist yet.** `index.ts` wires only the `/agentdev` toggle and a
`before_agent_start` goal-capture hook. Zero production code calls ralplan, dispatch,
review, fleet, git-gate, guard-git, autoclose, escalation, or the BackendAdapter. The
README/ARCHITECTURE/AC-DOD-1 describe a running crew; the extension records a goal and
then nothing happens. The E2E "full pipeline" hand-stitches the modules inside the test
with canned verdicts and commits via raw `execFileSync` — it proves the modules
interoperate, not that the product works.

## Cross-persona consensus findings (found independently by 3+ personas)

1. **No orchestrator / crew unreachable at runtime** — 9/9. README quickstart delivers
   "goal recorded, silence". ARCHITECTURE §20's `orchestrator.ts` is absent.
2. **Quickstart broken: `/agentdev` doesn't exist after `setup.sh` on a fresh clone** —
   6/9 (verified empirically twice; pi only auto-loads `.pi/extensions/`,
   `~/.pi/agent/extensions/`, or settings paths; the cwd package manifest is not scanned).
3. **`paneRun` whitespace-splits commands** (`command.split(/\s+/)`) — 8/9. Quoted args,
   `&&`, `$()` mangled; **shell metacharacters are LIVE** (empirically proven: `;` and
   command substitution execute in the pane). No idle-shell guarantee (text typed into
   `cat`'s stdin, never executed). `pane run` exits 0 even when the command fails — and
   can kill the pane.
4. **`guard-git` is bypassable AND unwired** — 7/9. Any `git`-prefixed argv defeats every
   pattern (`git reset --hard`, `git push --force origin main`, `git clean -f`, `git
   branch -D` — 15+ verified bypass forms incl. `rm -r .`, `checkout -- .`). Zero
   production callers; `hook-commits` doesn't exist.
5. **`agentWait` collapses all failure classes to `false`; `paneRead` returns the herdr
   error envelope as pane text; `parseRpc` returns `undefined as T`** → raw TypeErrors
   and silent-wrong-success — 7/9. Violates the adapter's own "errors surface as
   HerdrError" contract. `paneRun` reports success for failed commands.
6. **`loadFleet` silently returns `[]` on corrupt state (whole fleet erased, Leader
   included); `saveFleet` is non-atomic, no locking** — 6/9. The data-loss behavior is
   codified in a test. AC-RESIL-1's "no lost work" is contradicted by the code.
7. **Skills undiscoverable** — 6/9. `pi/skills/` ships but the `pi` manifest has no
   `skills` key (and manifest presence disables convention-dir scanning). `pi install ./`
   → 0/86 skills from the package (empirically verified).
8. **E2E is scripted, not agent-driven; commit step bypasses the gate under test** — 7/9.
   AC-DOD-1/AC-REAL-2 unproven. Same anti-pattern in `git-gate.test.ts`.
9. **Escalation "agentic eval" is a pure fixture replay** (0 LLM calls, 26ms) and
   **pass@k has no teeth** (2 evals log hardcoded `true` AFTER the expects; zero readers,
   no threshold, CI job green-by-skip on missing API key) — 6/9.
10. **Docs lie**: `ARCHITECTURE.md:3` and `planning-context.yaml:3` say "Implementation
    not started" at a 30-commit HEAD; `ARCHITECTURE.md:213` says "guard-git +
    hook-commits wired in" (false); §14/§15 "all orchestration state on disk" (only
    `fleet.json` is ever written) — 5/9.
11. **Evals + E2E CI jobs run per-PR/per-push, not nightly** (contradicting §21/§24);
    unpinned curl|sh installers + unpinned global pi in CI; no WSL/Windows CI leg; npm
    name `agentdev` is **collision-squatted** by an unrelated package (0.2.10) — 4/9.
12. **Module-scope herdr probes in 6 test files** (uncached, busy-wait, race-spawn
    detached daemons that are never stopped; 70–90s vitest prepare on cold hosts;
    silently heals server crashes so AC-RESIL-1 failures are never observed) — 4/9.

## Other notable findings (2+ personas)

- `dispatchPlan` partial-acquire leak: pool shrinks forever if `acquire()` throws mid-map.
- ralplan exhaustion yields a **critic-REJECTED plan as `bestPlan`** (AC-RALPLAN-5 lie).
- `isHighRisk` substring false-positives ("dropdown" → deliberate mode; "delete the user
  table" → NOT high-risk).
- AC-REVIEW-5 gate unwired AND gameable by absence-claim findings.
- `.agentdev/` state + `passk.jsonl` are world-writable (0777) — local pane-hijack
  primitive on multi-user hosts once paneRun is wired.
- `.pi-subagents/` not gitignored — `git add -A` commits the whole review brain-dump
  incl. secret-shaped fixture strings.
- E2E step 6 double-`paneGet` (10 spawns, 5 redundant); per-pane lifecycle = 8 CLI
  spawns (20-pane crew ≈ 160 serialized spawns/wave; `paneList` batch polling unused).
- eval graders are echo-satisfiable: define-constraints prompt contains its own grader
  keywords; the review eval's fixture comments literally say "INJECTED DEFECTS".
- Worktree leases in-memory only; crash → `git worktree add -b` branch-collision → dispatch wedges.
- Goals registry unbounded; second goal = no isolation (one shared fleet.json/gate);
  `before_agent_start` fires on every prompt (steering replies mint goals).
- AC-VERIFY-1 (`verify-work`), AC-DISPATCH-5 (`develop-tdd`), AC-MANUAL-3
  (`define-language`), AC-RALPLAN-8 (planning pane), AC-GIT-5/6 (PR/merge), AC-TOGGLE-3
  session reset (no `session_*` event wiring), `reconcileFleet` leader-with-dead-pane:
  unimplemented or unproven.
- Property-test "conservation" assertion is a tautology; cross-platform test asserts
  `["linux","win32"].toContain(process.platform)`.
- `parseRpcTolerant` swallows 12 non-close `*_not_found` codes (enumerated from the
  binary); `git-state.parsePorcelain` mangles renames and quoted paths.
- `setup.sh`/`setup.ps1` miss `gh` (AC-INSTALL-2); `setup.ps1` never verifies herdr
  post-install; `--no-bin-links` cargo-culted into Linux CI; no full-suite job on push;
  `prepublishOnly` is dead code (`private: true`); no coverage measurement, no
  `engines`, no tags/changelog, no Dependabot, actions not SHA-pinned, no `permissions:`.

## Master Top-10 must-fix (deduplicated across personas, ordered by impact)

1. **Ship the orchestrator** (goal → manual phase → ralplan → dispatch → panes → review → git gate → autoclose/escalation) wired to pi hooks + registered tools — or rescope the contract to "engine library" honestly. Everything else is downstream.
2. **Fix the quickstart**: `setup.sh`/`setup.ps1` must `pi install ./`; add `"skills"` to the `pi` manifest; add a CI packaging job proving `/agentdev` + both skills on a clean clone.
3. **Fix the adapter primitives**: `paneRun` argv-array interface (or validation + idle-shell precondition), `paneRead` must throw `HerdrError` on error envelopes, `agentWait` failure taxonomy (rethrow `exec_failed`, `false` only for not_found/timeout, `true` only on real result), `parseRpc` shape validation + `invalid_rpc` on empty.
4. **Rewrite guard-git matching** (strip `git` prefix, handle `--`/`-f`/`HEAD`/`--worktree`/`--staged`, argv-level allowlist incl. non-git verbs) and wire it + the commit gate + hook-commits into the real pre-exec path.
5. **State hardening**: atomic `saveFleet` (tmp+rename), quarantine + typed corrupt result, per-node shape validation on load, `0o700`/`0o600` permissions, per-goal state isolation, persist worktree leases + `git worktree prune`.
6. **Make the E2E agentic and gate-enforced** (real or recorded agents; `performCommit(gate, …)` in prod code, used by E2E + integration) + WSL CI leg.
7. **Fix the policy lies**: ralplan must not yield a rejected plan as `bestPlan` (score versions / `pickBest`); wire AC-REVIEW-5 into the loop and make coverage violation-based; fix `isHighRisk` to token/boundary matching; align review-loop and escalation budgets.
8. **Give the agentic layer teeth**: move the escalation eval to unit; compute `passed` before logging in all evals; pass@k reader + threshold in CI; fail CI when evals/E2E are skipped; fix the two echo-satisfiable eval graders and the self-describing fixture.
9. **Fix CI truthfulness**: event-gate evals + E2E to schedule/release; fail on 0 executed tests (skipIf masking); pin herdr/pi installers with checksums; `npm audit` + Dependabot; full-suite job on push; rename/scope the npm package; `.gitignore` += `.pi-subagents/`, `.pi/`.
10. **Fix the docs**: status lines in ARCHITECTURE.md:3 + planning-context.yaml; "wired in" claims (§11); §14/§15 state-model claims; gated-suite accounting in DEVELOPMENT.md; coverage floor enforcement.

## What's genuinely good (confirmed across all 27 passes)

1. **Deterministic core is real and F.I.R.S.T.-green**: 192 unit + 30 real-herdr integration + 10 E2E + clean typecheck; seeded property tests; honest negative-path tests; real-binary contract tests pinning snake_case→camelCase.
2. **BackendAdapter is the right seam**: sole `child_process` user, DI runner, typed `HerdrError`, tolerant idempotent close — the defects are tolerance breadth and escape hatches, not plumbing.
3. **Three genuinely agentic evals** (ralplan, review, define-constraints) run real models with graders and pass@k logging; AC-REVIEW-5's checklist + coverage gate is the strongest closed loop in the repo.
4. Small, correctly-capped state machines (toggle, consensus ≤5, review loop, escalation, commit gate, worktree pool) with AC-mapped tests — a sound base for the missing orchestrator.

## Bottom line

The review bar ("harsh, staff-level") yields: **the code that exists is unusually well-tested and clean; the product that was promised is not implemented.** The honest next step is one of two: (a) build the orchestrator + fix the primitives (≈ the entire remaining v1 scope), or (b) rescope the contract to "agentdev = engine library + tests" and update the docs. Option (a) is what the binding contract promises; option (b) is what the code actually ships today.

# agentdev — Development notes

## Testing

```bash
npm test               # full suite (vitest)
npm run test:unit      # unit only
npm run test:integration  # integration (requires real herdr — skipped with a clear message if missing)
npm run test:e2e       # E2E (requires AGENTDEV_E2E=1 + real herdr + git)
npm run test:evals     # agentic evals (requires AGENTDEV_EVAL=1 + pi on PATH)
npm run typecheck      # tsc --noEmit
```

Real-environment checks (AC-REAL-*):
- `tests/integration/herdr-smoke.test.ts` — probes the real installed herdr (`--version`, `status client`); skips with a clear message if herdr is missing.
- `tests/integration/backend-adapter.test.ts` — drives the REAL herdr control API end-to-end (workspace create → pane rename/run/read → close). Auto-starts the headless server (`herdr server`) via `ensureHerdrServer()` if it isn't running.
- Extension load: `pi install ./` then `/agentdev on` (the CI packaging job proves the command + all 3 skills register via `get_commands`). Manual boot smoke: `pi -e ./pi/extensions/agentdev/index.ts -p "Reply with exactly: EXTENSION_OK"`.
- E2E (nightly / release, `AGENTDEV_E2E=1`): drives the REAL orchestrator (the shipped `index.ts` pipeline) on real herdr + real git with RECORDED agents (AC-REAL-2) — goal → manual → consensus → dispatch → REAL worktrees → build → review → gate → REAL commits → restart resume with no double-commit.
- Agentic evals (nightly, `AGENTDEV_EVAL=1`): 3 real-model evals — ralplan consensus (closed-loop critique), security injected-defect review (AC-REVIEW-5), define-constraints failure-mode surfacing. (Escalation policy coverage lives in the unit suite — it is deterministic, not agentic.) pass@k is computed BEFORE the assertions and logged to `.agentdev/passk.jsonl`; the CI evals job uploads it as an artifact and a watchdog fails on 3 consecutive skipped nights.
- Gated accounting: 3 eval tests + 4 E2E tests are env-gated (`AGENTDEV_EVAL` / `AGENTDEV_E2E`); unit + integration run on every push.

## WSL/drvfs workaround (Windows-mounted repo)

`chmod` is not permitted on `/mnt/c` (drvfs), which breaks npm's bin-linking. Install with:

```bash
npm install --no-bin-links
```

and run tools via `node` directly (`node node_modules/vitest/vitest.mjs run`,
`node node_modules/typescript/bin/tsc --noEmit`) — the `package.json` scripts already
do this. This environment quirk does not affect the shipped pi package (installed via
`pi install`, which resolves bins through pi's own loader).

## Spec fidelity

`ARCHITECTURE.md` and `specs/acceptance-criteria.md` are the binding contract. Any
deviation is a failing test or review blocker, never an interpretation. Tests run as
close to the real environment as possible (real herdr, real pi, real OS); mocks are
allowed only for pure deterministic unit logic.

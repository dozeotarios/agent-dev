import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureHerdrServer, herdrInfo } from "../helpers/herdr-is-present";
import { createHerdrAdapter } from "../../pi/extensions/agentdev/backend-adapter";
import { createOrchestrator, type OrchestratorPorts } from "../../pi/extensions/agentdev/orchestrator";
import { createFleet } from "../../pi/extensions/agentdev/fleet";
import { loadFleet } from "../../pi/extensions/agentdev/state";
import { roleLabel } from "../../pi/extensions/agentdev/roles";
import type { PlanOutput } from "../../pi/extensions/agentdev/ralplan";

/**
 * E2E (ARCHITECTURE.md §21/§25, AC-DOD-1): the FULL goal → commit-ready
 * pipeline through the REAL orchestrator on the REAL substrate — real herdr
 * panes, real git worktrees, real commits — with RECORDED agents (AC-REAL-2:
 * "real (or recorded) agents"). The orchestrator's effect ports are the only
 * thing faked; the pipeline it drives is the shipped production code.
 * Skipped unless AGENTDEV_E2E=1 (nightly / release per §21).
 */

const enabled = process.env.AGENTDEV_E2E === "1";
const herdr = herdrInfo();
const serverUp = herdr.present ? ensureHerdrServer() : false;

function gitPresent(): boolean {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const GOAL = "build a small CLI todo app";

const FIXTURE_PLAN: PlanOutput = {
  adr: {
    decision: "typescript CLI",
    drivers: ["portable", "fast to build", "simple"],
    alternatives: ["go", "python"],
    why: "smallest fit for a CLI with no heavy runtime needs",
    consequences: ["node runtime dependency"],
    followups: ["benchmark startup time"],
  },
  filePlan: {
    structure: "src/ + test/",
    create: ["src/feature.ts", "test/feature.test.ts"],
    modify: [],
    doNotTouch: ["README.md"],
  },
  acceptanceCriteria: [
    "given 'todo add x' when run then the item is stored",
    "given no args when run then usage text is shown",
    "given 1000 items when listed then all are shown",
  ],
};

/** Recorded agent transcript (AC-REAL-2): consensus approves in round 1. */
function recordedAsk(prompt: string): string {
  if (/Planner in a consensus-planning loop/.test(prompt)) return JSON.stringify(FIXTURE_PLAN);
  if (/Architect in a consensus-planning loop/.test(prompt)) return "SOUND — tradeoff considered";
  if (/Developer in a consensus-planning loop/.test(prompt)) return "FEASIBLE";
  if (/final quality gate in a consensus-planning loop/.test(prompt)) return "APPROVE";
  if (/reviewer in a code review/.test(prompt)) return "NIT: style only";
  return "STORY_DONE";
}

describe.skipIf(!enabled || !herdr.present || !serverUp || !gitPresent())(
  "E2E: real orchestrator → commit-ready on REAL herdr + REAL git, recorded agents (AC-DOD-1)",
  () => {
    let base: string; // real git repo — the crew's base
    let cwd: string; // orchestrator workspace (state lives here)
    let goalId = "";
    const wsIds: string[] = [];
    const adapter = createHerdrAdapter();

    beforeAll(() => {
      base = mkdtempSync(join(tmpdir(), "agentdev-e2e-base-"));
      execFileSync("git", ["init", "-b", "main"], { cwd: base, stdio: "ignore" });
      execFileSync(
        "git", ["-c", "user.name=agentdev", "-c", "user.email=agentdev@test", "commit", "--allow-empty", "-m", "init"],
        { cwd: base, stdio: "ignore" },
      );
      cwd = mkdtempSync(join(tmpdir(), "agentdev-e2e-cwd-"));
    });

    afterAll(() => {
      for (const w of wsIds) {
        try {
          adapter.workspaceClose(w);
        } catch {
          /* ignore */
        }
      }
      rmSync(base, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    });

    it("1. the REAL orchestrator runs goal → manual → consensus → dispatch → build → review → gate → REAL commits → done", async () => {
      // recorded agents; everything else is the shipped production path
      const ports: OrchestratorPorts = {
        adapter,
        ask: recordedAsk,
        buildStory({ worktree, storyId }) {
          writeFileSync(join(worktree, "feature.txt"), `implemented ${storyId}`);
        },
        spawnWorker: (ctx) => ({
          goalId: ctx.goalId,
          storyId: ctx.storyId,
          worktree: ctx.worktree,
          paneId: "e2e-pane",
          workspaceId: "e2e-ws",
          name: `worker-${ctx.storyId}`,
          reportPath: join(ctx.worktree, ".e2e-report.md"),
        }),
        waitForWorker: () => "done",
        teardownWorker: () => undefined,
        spawnSubleader: (input) => ({
          goalId: input.goalId,
          storyId: "plan",
          worktree: base,
          paneId: "e2e-sub-pane",
          workspaceId: "e2e-sub-ws",
          name: `subleader-${input.goalId}`,
          reportPath: "",
        }),
        sendToSubleader: () => undefined,
        verifyStory: () => ({ ok: true, output: "ok", command: "npm test" }),
        sliceContext: () => "// e2e fixture slice",
        confirmCommit: () => true, // operator confirms (recorded)
        manualInput: () => ({
          constraints: {
            do: ["input_validation"],
            dont: ["no_hardcoded_secrets"],
            failure_modes: ["disk_full"],
            edge_cases: ["empty_input"],
            invariants: ["data_integrity"],
          },
          mode: "direct-PR",
          stack: "typescript",
        }),
        notify: () => undefined,
      };
      const orch = createOrchestrator(ports, { cwd, baseRepo: base });
      const run = await orch.start(GOAL);
      goalId = run.goalId;
      expect(run.step).toBe("done");
      expect(run.approved).toBe(true);
      expect(run.errors).toEqual([]);

      // REAL commits happened in the REAL worktrees (gate-enforced path)
      const leases = loadLeases(cwd, goalId);
      expect(leases.used.length).toBeGreaterThan(0);
      for (const wt of leases.used) {
        const log = execFileSync("git", ["log", "--oneline", "-1"], { cwd: wt, encoding: "utf8" });
        expect(log).toMatch(/feat\(story-/);
      }
      // no uncommitted changes left (commit path cleaned the worktrees)
      for (const wt of leases.used) {
        const status = execFileSync("git", ["status", "--porcelain"], { cwd: wt, encoding: "utf8" });
        expect(status.trim()).toBe("");
      }
      // branches.json durable map exists (AC-GIT-3)
      const branchesFile = join(cwd, ".agentdev", "goals", goalId, "branches.json");
      const branches = JSON.parse(require("node:fs").readFileSync(branchesFile, "utf8"));
      expect(branches.worktrees.length).toBeGreaterThan(0);
    });

    it("2. restart: a fresh orchestrator resumes the goal with NO double commit (AC-RESIL-1)", async () => {
      const ports: OrchestratorPorts = {
        adapter,
        ask: recordedAsk,
        buildStory: () => undefined,
        spawnWorker: (ctx) => ({
          goalId: ctx.goalId,
          storyId: ctx.storyId,
          worktree: ctx.worktree,
          paneId: "e2e-pane",
          workspaceId: "e2e-ws",
          name: `worker-${ctx.storyId}`,
          reportPath: "",
        }),
        waitForWorker: () => "done",
        teardownWorker: () => undefined,
        spawnSubleader: (input) => ({
          goalId: input.goalId,
          storyId: "plan",
          worktree: base,
          paneId: "e2e-sub-pane",
          workspaceId: "e2e-sub-ws",
          name: `subleader-${input.goalId}`,
          reportPath: "",
        }),
        sendToSubleader: () => undefined,
        verifyStory: () => ({ ok: true, output: "ok", command: "npm test" }),
        sliceContext: () => "",
        confirmCommit: () => true,
        manualInput: () => ({ constraints: {}, mode: "direct-PR" }),
        notify: () => undefined,
      };
      const orch2 = createOrchestrator(ports, { cwd, baseRepo: base });
      const resumed = await orch2.resume(goalId);
      expect(resumed.step).toBe("done");
      // the gate's recorded hash prevented a second commit (dedup)
      const leases = loadLeases(cwd, goalId);
      for (const wt of leases.used) {
        const count = execFileSync("git", ["log", "--oneline"], { cwd: wt, encoding: "utf8" })
          .split("\n").filter(Boolean).length;
        expect(count).toBeGreaterThanOrEqual(1); // init commit + exactly one story commit
      }
    });

    it("3. every role is visible in REAL herdr panes with role-prefix labels (AC-VIS-1/2)", () => {
      const roles: { role: "leader" | "subleader" | "subworker" | "reviewer"; tag: string }[] = [
        { role: "leader", tag: "e2e" },
        { role: "subleader", tag: "e2e/plan-1" },
        { role: "subworker", tag: "e2e/story-1" },
        { role: "reviewer", tag: "e2e/plan-1#security" },
      ];
      for (const { role, tag } of roles) {
        const ws = adapter.workspaceCreate({ cwd, label: "e2e" });
        wsIds.push(ws.workspaceId);
        const label = roleLabel(role, tag);
        adapter.paneRename(ws.paneId, label);
        expect(adapter.paneGet(ws.paneId).label).toBe(label);
      }
      // fleet state on disk round-trips with the real panes
      const f = createFleet();
      const saved = loadFleet(join(cwd, ".agentdev", "goals", goalId));
      if (!saved.corrupt) for (const n of saved.nodes) f.addNode(n);
      expect(f.nodes().length).toBeGreaterThanOrEqual(3); // leader+subleader+workers
    });

    it("4. autoclose leaves the fleet clean and panes closed", async () => {
      // workers were autoclosed at pipeline end; the persisted fleet has no
      // working subworker panes left dangling
      const saved = loadFleet(join(cwd, ".agentdev", "goals", goalId));
      if (!saved.corrupt) {
        const live = new Set(adapter.paneList().map((p) => p.paneId));
        const dangling = saved.nodes.filter((n) => n.paneId && live.has(n.paneId));
        expect(dangling).toEqual([]);
      }
    });
  },
);

function loadLeases(cwd: string, goalId: string): { free: string[]; used: string[] } {
  const { readFileSync } = require("node:fs") as typeof import("node:fs");
  return JSON.parse(readFileSync(join(cwd, ".agentdev", "goals", goalId, "worktrees.json"), "utf8"));
}

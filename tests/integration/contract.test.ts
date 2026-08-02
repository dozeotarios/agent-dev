import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureHerdrServer, herdrInfo } from "../helpers/herdr-is-present";
import { createHerdrAdapter, HerdrError } from "../../pi/extensions/agentdev/backend-adapter";
import { saveFleet, loadFleet, reconcileFleet } from "../../pi/extensions/agentdev/state";
import { dispatchPlan, completeWorker, type WorkerAssignment } from "../../pi/extensions/agentdev/dispatch";
import { createWorktreePool } from "../../pi/extensions/agentdev/worktree";
import { routeToWorkers, type Finding } from "../../pi/extensions/agentdev/review";

/**
 * Contract tests (ARCHITECTURE.md §21, validate-contracts): cross-boundary
 * data shapes against the REAL herdr API + the real modules. Any shape drift
 * (rename, casing, nesting) fails here before it corrupts a layer.
 */

const herdr = herdrInfo();
const serverUp = herdr.present ? ensureHerdrServer() : false;
const skip = !herdr.present || !serverUp;

describe.skipIf(skip)("contract: herdr API shapes → BackendAdapter contract", () => {
  const cwd = mkdtempSync(join(tmpdir(), "agentdev-contract-"));
  const adapter = createHerdrAdapter();
  let ws: { workspaceId: string; tabId: string; paneId: string };

  afterAll(() => {
    try {
      adapter.workspaceClose(ws.workspaceId);
    } catch {
      /* ignore */
    }
    rmSync(cwd, { recursive: true, force: true });
  });

  it("workspace create → {workspace_id, tab_id, root_pane.pane_id} key-set", () => {
    ws = adapter.workspaceCreate({ cwd, label: "contract-ws" });
    expect(ws.workspaceId).toMatch(/^[0-9a-zA-Z]+$/); // base-36 workspace id
    expect(ws.tabId).toBeTruthy();
    expect(ws.paneId).toBeTruthy();
  });

  it("pane get → {pane_id, label?, agent_status} mapped to camelCase", () => {
    const info = adapter.paneGet(ws.paneId);
    expect(info.paneId).toBe(ws.paneId);
    // label is optional until renamed; when present it round-trips
    expect(info.label === undefined || typeof info.label === "string").toBe(true);
    adapter.paneRename(ws.paneId, "contract-label");
    expect(adapter.paneGet(ws.paneId).label).toBe("contract-label");
    expect(["idle", "working", "blocked", "done", "unknown", undefined]).toContain(info.agentStatus);
  });

  it("pane list → every pane has pane_id + workspace_id; includes ours", () => {
    const panes = adapter.paneList();
    expect(panes.length).toBeGreaterThan(0);
    for (const p of panes) {
      expect(typeof p.paneId).toBe("string");
      expect(p.paneId.length).toBeGreaterThan(0);
      expect(typeof p.workspaceId).toBe("string");
    }
    expect(panes.some((p) => p.paneId === ws.paneId)).toBe(true);
  });

  it("close is idempotent-tolerated (not_found swallowed, other errors surface)", () => {
    adapter.workspaceClose(ws.workspaceId); // first close ok
    adapter.workspaceClose(ws.workspaceId); // second close tolerated (not_found)
    expect(() => adapter.paneGet("definitely-not-a-pane")).toThrow(HerdrError);
  });
});

describe("contract: dispatch → review boundary (storyId key-set)", () => {
  it("routeToWorkers only targets storyIds that exist among workers", () => {
    const pool = createWorktreePool({ maxSize: 4, create: () => "/tmp/wt" });
    const dispatch = dispatchPlan(
      { planId: "plan-1", stories: [{ storyId: "s1" }, { storyId: "s2" }] },
      pool,
    );
    const findings: Finding[] = [
      { lens: "security", severity: "blocking", text: "x", storyId: "s1" },
      { lens: "security", severity: "blocking", text: "y", storyId: "ghost" }, // invalid target
      { lens: "reliability", severity: "blocking", text: "z", storyId: "s2" },
    ];
    const routed = routeToWorkers(findings, dispatch.workers);
    expect(routed.map((w) => w.storyId).sort()).toEqual(["s1", "s2"]);
    for (const w of routed) {
      expect(dispatch.workers.some((x) => x.storyId === w.storyId)).toBe(true);
    }
    for (const w of dispatch.workers as WorkerAssignment[]) completeWorker(w, pool);
  });
});

describe("contract: fleet state round-trip (disk → reconcile)", () => {
  it("saveFleet/loadFleet preserve the FleetNode shape exactly", () => {
    const cwd = mkdtempSync(join(tmpdir(), "agentdev-contract-state-"));
    const nodes = [
      { id: "leader", role: "leader" as const, path: "proj", status: "idle" as const, paneId: null },
      { id: "w1", role: "subworker" as const, path: "proj/a", status: "working" as const, paneId: "p1" },
    ];
    saveFleet(cwd, nodes);
    const loaded = loadFleet(cwd);
    expect(loaded.nodes).toEqual(nodes); // exact shape, no field drift
    const { reconnected, orphans } = reconcileFleet(loaded.nodes, new Set(["p1"]));
    expect(reconnected.map((n) => n.id)).toEqual(["leader", "w1"]);
    expect(orphans).toHaveLength(0);
    rmSync(cwd, { recursive: true, force: true });
  });
});

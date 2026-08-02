import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureHerdrServer, herdrInfo } from "../helpers/herdr-is-present";
import { createHerdrAdapter } from "../../pi/extensions/agentdev/backend-adapter";
import { saveFleet, loadFleet, reconcileFleet } from "../../pi/extensions/agentdev/state";
import type { FleetNode } from "../../pi/extensions/agentdev/fleet";

// AC-RESIL-1: crash/restart — state on disk + herdr keeps panes; on restart
// agentdev reconnects to existing panes and resumes from on-disk fleet state.
const herdr = herdrInfo();
const serverUp = herdr.present ? ensureHerdrServer() : false;
const skip = !herdr.present || !serverUp;

describe.skipIf(skip)("restart reconciliation — real herdr + real disk (AC-RESIL-1)", () => {
  const cwd = mkdtempSync(join(tmpdir(), "agentdev-recon-"));
  const adapter = createHerdrAdapter();
  let ws: { workspaceId: string; paneId: string };

  afterAll(() => {
    try {
      adapter.workspaceClose(ws.workspaceId);
    } catch {
      /* ignore */
    }
    rmSync(cwd, { recursive: true, force: true });
  });

  it("saves the fleet to disk before the 'crash'", () => {
    ws = adapter.workspaceCreate({ cwd, label: "recon-ws" });
    saveFleet(cwd, [
      { id: "leader", role: "leader", path: "proj", status: "idle", paneId: null },
      { id: "w1", role: "subworker", path: "proj/a", status: "working", paneId: ws.paneId },
      { id: "w2", role: "subworker", path: "proj/b", status: "working", paneId: "w999:p999" },
    ]);
    expect(loadFleet(cwd).nodes).toHaveLength(3); // durable round-trip
  });

  it("after restart: live panes reconnect, lost panes orphaned, leader survives", () => {
    const saved = loadFleet(cwd).nodes; // the restart — a fresh read from disk
    const live = new Set(adapter.paneList().map((p) => p.paneId)); // real herdr panes
    expect(live.has(ws.paneId)).toBe(true); // herdr kept the pane alive

    const { reconnected, orphans } = reconcileFleet(saved, live);
    expect(reconnected.map((n) => n.id).sort()).toEqual(["leader", "w1"]);
    expect(orphans.map((n) => n.id)).toEqual(["w2"]);
  });

  it("the orphaned node is surfaced, not silently lost", () => {
    const saved: FleetNode[] = loadFleet(cwd).nodes;
    const { orphans } = reconcileFleet(saved, new Set(adapter.paneList().map((p) => p.paneId)));
    expect(orphans.length).toBeGreaterThan(0);
  });
});

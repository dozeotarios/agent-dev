import { describe, expect, it } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  projectStateDir,
  globalStateDir,
  fleetStateFile,
  saveFleet,
  loadFleet,
  reconcileFleet,
} from "../../pi/extensions/agentdev/state";
import type { FleetNode } from "../../pi/extensions/agentdev/fleet";

// AC-STATE-1/2: state under .agentdev/ (project) + ~/.agentdev/ (global),
// Windows-safe paths. AC-RESIL-1: restart reconciliation.
// Hardening: atomic writes, quarantine of corrupt state, shape validation,
// leader-with-dead-pane surfaced as orphan.
describe("state + resilience (AC-STATE-1/2, AC-RESIL-1)", () => {
  const cwd = mkdtempSync(join(tmpdir(), "agentdev-state-"));

  const nodes: FleetNode[] = [
    { id: "leader", role: "leader", path: "proj", status: "idle", paneId: null },
    { id: "w1", role: "subworker", path: "proj/a", status: "working", paneId: "w1:p1" },
    { id: "w2", role: "subworker", path: "proj/b", status: "blocked", paneId: "w1:p2" },
  ];

  it("project state dir is <cwd>/.agentdev, global is ~/.agentdev", () => {
    expect(projectStateDir(cwd)).toBe(join(cwd, ".agentdev"));
    expect(globalStateDir()).toBe(join(homedir(), ".agentdev"));
    expect(fleetStateFile(cwd)).toBe(join(projectStateDir(cwd), "fleet.json"));
  });

  it("save → load round-trips the fleet (durable on disk)", () => {
    saveFleet(cwd, nodes);
    const loaded = loadFleet(cwd);
    expect(loaded.corrupt).toBe(false);
    expect(loaded.nodes).toEqual(nodes);
  });

  it("load with no state file → empty fleet, not corrupt (fresh start)", () => {
    const empty = mkdtempSync(join(tmpdir(), "agentdev-empty-"));
    const r = loadFleet(empty);
    expect(r.nodes).toEqual([]);
    expect(r.corrupt).toBe(false);
    rmSync(empty, { recursive: true, force: true });
  });

  it("load with corrupt JSON → QUARANTINED + flagged, never silently erased", () => {
    const dir = mkdtempSync(join(tmpdir(), "agentdev-corrupt-"));
    mkdirSync(projectStateDir(dir), { recursive: true });
    writeFileSync(fleetStateFile(dir), "{ not json", "utf8");
    const r = loadFleet(dir);
    expect(r.corrupt).toBe(true);
    expect(r.nodes).toEqual([]);
    expect(r.quarantinedTo).not.toBeNull();
    expect(existsSync(r.quarantinedTo!)).toBe(true);
    expect(readFileSync(r.quarantinedTo!, "utf8")).toBe("{ not json");
    // original file is left in place — nothing was destroyed
    expect(existsSync(fleetStateFile(dir))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it("load with wrong-shape array → malformed entries quarantined, valid ones salvaged", () => {
    const dir = mkdtempSync(join(tmpdir(), "agentdev-shape-"));
    mkdirSync(projectStateDir(dir), { recursive: true });
    writeFileSync(
      fleetStateFile(dir),
      JSON.stringify([{ id: "w1", role: "subworker", path: "p/a", status: "working", paneId: null }, { foo: 1 }]),
      "utf8",
    );
    const r = loadFleet(dir);
    expect(r.corrupt).toBe(true);
    expect(r.nodes.map((n) => n.id)).toEqual(["w1"]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("load validates every node — garbage never flows into reconcileFleet", () => {
    const dir = mkdtempSync(join(tmpdir(), "agentdev-garbage-"));
    mkdirSync(projectStateDir(dir), { recursive: true });
    writeFileSync(
      fleetStateFile(dir),
      JSON.stringify([
        { id: "ok", role: "subworker", path: "p/a", status: "working", paneId: null },
        { id: "bad-role", role: "king", path: "p", status: "working", paneId: null },
        { id: "bad-status", role: "leader", path: "p", status: "zombie", paneId: null },
        { id: "bad-pane", role: "reviewer", path: "p", status: "done", paneId: 42 },
      ]),
      "utf8",
    );
    const r = loadFleet(dir);
    expect(r.nodes.map((n) => n.id)).toEqual(["ok"]);
    expect(r.corrupt).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it("saveFleet is atomic — no .tmp leftovers and no torn file", () => {
    const dir = mkdtempSync(join(tmpdir(), "agentdev-atomic-"));
    saveFleet(dir, nodes);
    expect(existsSync(`${fleetStateFile(dir)}.tmp`)).toBe(false);
    // the written file parses cleanly
    expect(JSON.parse(readFileSync(fleetStateFile(dir), "utf8"))).toEqual(nodes);
    rmSync(dir, { recursive: true, force: true });
  });

  it("reconcile: live panes reconnect, lost panes become orphans", () => {
    const live = new Set(["w1:p1"]);
    const { reconnected, orphans } = reconcileFleet(nodes, live);
    expect(reconnected.map((n) => n.id).sort()).toEqual(["leader", "w1"]);
    expect(orphans.map((n) => n.id)).toEqual(["w2"]);
  });

  it("reconcile: a LEADER with a dead pane is an orphan, not a silent reconnect", () => {
    const withDeadLeaderPane: FleetNode[] = [
      { id: "leader", role: "leader", path: "proj", status: "idle", paneId: "w9:p9" },
      { id: "w1", role: "subworker", path: "proj/a", status: "working", paneId: "w1:p1" },
    ];
    const { reconnected, orphans } = reconcileFleet(withDeadLeaderPane, new Set(["w1:p1"]));
    expect(reconnected.map((n) => n.id)).toEqual(["w1"]);
    expect(orphans.map((n) => n.id)).toEqual(["leader"]); // surfaced for re-creation
  });

  it("reconcile: non-leader nodes without a paneId are orphans", () => {
    const { orphans } = reconcileFleet(
      [{ id: "x", role: "reviewer", path: "proj/a", status: "done", paneId: null }],
      new Set(),
    );
    expect(orphans.map((n) => n.id)).toEqual(["x"]);
  });

  it("reconcile is deterministic for the same inputs", () => {
    const a = reconcileFleet(nodes, new Set(["w1:p1"]));
    const b = reconcileFleet(nodes, new Set(["w1:p1"]));
    expect(a).toEqual(b);
  });

  it("projectStateDir joins with the platform separator (Windows-safe)", () => {
    expect(projectStateDir("C:\\repo")).toBe(join("C:\\repo", ".agentdev"));
  });
});

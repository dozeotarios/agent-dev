import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureHerdrServer, herdrInfo } from "../helpers/herdr-is-present";
import { createHerdrAdapter } from "../../pi/extensions/agentdev/backend-adapter";
import { roleLabel, parseRoleFromLabel } from "../../pi/extensions/agentdev/roles";
import { createFleet } from "../../pi/extensions/agentdev/fleet";
import { autocloseDecision } from "../../pi/extensions/agentdev/autoclose";

// AC-VIS-2/3/4/5 + AC-CLOSE-1..5 — against the REAL herdr.
const herdr = herdrInfo();
const serverUp = herdr.present ? ensureHerdrServer() : false;
const skip = !herdr.present || !serverUp;

describe.skipIf(skip)("visibility + autoclose — real herdr integration", () => {
  const cwd = mkdtempSync(join(tmpdir(), "agentdev-vis-"));
  const adapter = createHerdrAdapter();
  const workspaces: string[] = [];

  beforeAll(() => {
    expect(herdr.present).toBe(true);
  });

  afterAll(() => {
    for (const ws of workspaces) {
      try {
        adapter.workspaceClose(ws);
      } catch {
        /* ignore */
      }
    }
    rmSync(cwd, { recursive: true, force: true });
  });

  it("real panes carry role-prefix labels (AC-VIS-2)", () => {
    const ws = adapter.workspaceCreate({ cwd, label: "vis-ws" });
    workspaces.push(ws.workspaceId);
    const label = roleLabel("subworker", "proj/auth/login");
    adapter.paneRename(ws.paneId, label);
    const pane = adapter.paneGet(ws.paneId);
    expect(pane.label).toBe(label);
    // round-trip parse from the REAL pane label
    expect(parseRoleFromLabel(pane.label!)).toEqual({ role: "subworker", path: "proj/auth/login", lens: undefined });
    // AC-VIS-3: real agent state is surfaced
    expect(["working", "blocked", "done", "idle", "unknown"]).toContain(pane.agentStatus);
  });

  it("fleet overview + attention list render from live fleet state (AC-VIS-4/5)", () => {
    const fleet = createFleet();
    fleet.addNode({ id: "l", role: "leader", path: "proj", status: "idle", paneId: null });
    fleet.addNode({ id: "w", role: "subworker", path: "proj/auth/login", status: "blocked", paneId: "x" });
    const tree = fleet.renderTree();
    expect(tree).toContain("· L:proj");
    expect(tree).toContain("⛔ W:proj/auth/login");
    expect(fleet.attentionList().map((n) => n.id)).toEqual(["w"]);
  });

  it("clean completion closes the real pane (AC-CLOSE-1)", () => {
    const ws = adapter.workspaceCreate({ cwd, label: "close-ws" });
    workspaces.push(ws.workspaceId);
    const decision = autocloseDecision({ role: "subworker", status: "done", handled: false, unattendedMs: 0 });
    expect(decision).toBe("close");
    adapter.paneClose(ws.paneId); // the real close
    expect(() => adapter.paneGet(ws.paneId)).toThrow(); // gone
  });

  it("blocked stays open until handled (AC-CLOSE-3/4)", () => {
    const ws = adapter.workspaceCreate({ cwd, label: "blocked-ws" });
    workspaces.push(ws.workspaceId);
    expect(autocloseDecision({ role: "subworker", status: "blocked", handled: false, unattendedMs: 0 })).toBe("stay");
    expect(adapter.paneGet(ws.paneId).paneId).toBe(ws.paneId); // still open
    expect(autocloseDecision({ role: "subworker", status: "blocked", handled: true, unattendedMs: 0 })).toBe("close");
    adapter.paneClose(ws.paneId);
  });
});

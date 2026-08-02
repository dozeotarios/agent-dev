import { describe, expect, it } from "vitest";
import {
  createFleet,
  STATUS_GLYPHS,
  type NodeStatus,
} from "../../pi/extensions/agentdev/fleet";
import { roleLabel } from "../../pi/extensions/agentdev/roles";

// AC-VIS-4/5: fleet overview renders the live org-tree with role + state;
// attention list surfaces blocked / needs-you nodes.
describe("fleet overview (AC-VIS-4)", () => {
  it("renders the org-tree with role labels and status glyphs", () => {
    const fleet = createFleet();
    fleet.addNode({ id: "leader", role: "leader", path: "agentdev", status: "idle", paneId: "w1:p1" });
    fleet.addNode({ id: "sub", role: "subleader", path: "agentdev/auth", status: "working", paneId: "w1:p2" });
    fleet.addNode({ id: "w1", role: "subworker", path: "agentdev/auth/login", status: "done", paneId: "w1:p3" });

    const tree = fleet.renderTree();
    const lines = tree.split("\n");
    expect(lines[0]).toContain(`${STATUS_GLYPHS.idle} ${roleLabel("leader", "agentdev")}`);
    expect(lines[1]).toContain(`${STATUS_GLYPHS.working} ${roleLabel("subleader", "agentdev/auth")}`);
    expect(lines[2]).toContain(`${STATUS_GLYPHS.done} ${roleLabel("subworker", "agentdev/auth/login")}`);
  });

  it("indents by hierarchy depth (project → plan → story)", () => {
    const fleet = createFleet();
    fleet.addNode({ id: "w", role: "subworker", path: "agentdev/auth/login", status: "working", paneId: null });
    fleet.addNode({ id: "l", role: "leader", path: "agentdev", status: "idle", paneId: null });
    const tree = fleet.renderTree();
    const [leaderLine, workerLine] = tree.split("\n");
    expect(leaderLine.startsWith("· L:agentdev")).toBe(true);
    expect(workerLine.startsWith("    ● W:agentdev/auth/login")).toBe(true); // depth 3 → 2 levels of indent
  });

  it("status glyphs cover all five states", () => {
    expect(Object.keys(STATUS_GLYPHS).sort()).toEqual(["blocked", "done", "idle", "unknown", "working"]);
  });
});

describe("attention list (AC-VIS-5)", () => {
  it("surfaces blocked / needs-you nodes only", () => {
    const fleet = createFleet();
    fleet.addNode({ id: "l", role: "leader", path: "agentdev", status: "idle", paneId: null });
    fleet.addNode({ id: "a", role: "subworker", path: "agentdev/a", status: "blocked", paneId: "w1:p1" });
    fleet.addNode({ id: "b", role: "subworker", path: "agentdev/b", status: "working", paneId: "w1:p2" });
    fleet.addNode({ id: "c", role: "subworker", path: "agentdev/c", status: "done", paneId: null });
    const attention = fleet.attentionList();
    expect(attention.map((n) => n.id)).toEqual(["a"]);
    expect(attention[0].status).toBe("blocked");
  });

  it("setStatus transitions nodes in the live overview", () => {
    const fleet = createFleet();
    fleet.addNode({ id: "w", role: "subworker", path: "agentdev/x", status: "working", paneId: null });
    fleet.setStatus("w", "done");
    expect(fleet.node("w")?.status).toBe("done");
    expect(fleet.attentionList()).toHaveLength(0);
  });

  it("rejects unknown statuses", () => {
    const fleet = createFleet();
    fleet.addNode({ id: "w", role: "subworker", path: "agentdev/x", status: "working", paneId: null });
    expect(() => fleet.setStatus("w", "exploded" as NodeStatus)).toThrow();
  });
});

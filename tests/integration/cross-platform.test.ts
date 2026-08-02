import { describe, expect, it } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";
import { projectStateDir, globalStateDir } from "../../pi/extensions/agentdev/state";

// AC-PLATFORM-1..3: installs and runs on Linux, WSL, and Windows (this smoke
// runs on whichever OS the suite is executed on — Linux/WSL full support;
// native-Windows crew fidelity tracks herdr-Windows maturity).
describe("cross-platform smoke (AC-PLATFORM-1..3)", () => {
  it("state dirs are platform-separator-safe (no hardcoded separators)", () => {
    // Windows-style input must still join with the HOST separator
    const p = projectStateDir("C:\\repo");
    expect(p.endsWith(join(".agentdev"))).toBe(true);
    expect(p.includes(".agentdev")).toBe(true);
    expect(globalStateDir()).toBe(join(homedir(), ".agentdev"));
    // path.join semantics: no double separators, no forward-slash hardcoding
    expect(join("/a", ".agentdev")).toBe("/a" + require("node:path").sep + ".agentdev");
    expect(projectStateDir("/a/b")).toBe(join("/a/b", ".agentdev"));
  });

  it("the real state dir is created + written on this OS (AC-STATE-1)", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const state = await import("../../pi/extensions/agentdev/state");
    const cwd = mkdtempSync(join(tmpdir(), "agentdev-xplat-"));
    state.saveFleet(cwd, [{ id: "l", role: "leader", path: "p", status: "idle", paneId: null }]);
    const r = state.loadFleet(cwd);
    expect(r.nodes.map((n) => n.id)).toEqual(["l"]);
    expect(r.corrupt).toBe(false);
    rmSync(cwd, { recursive: true, force: true });
  });

  it("core modules load on this OS", async () => {
    const [toggle, ralplan, fleet, adapter, orchestrator] = await Promise.all([
      import("../../pi/extensions/agentdev/toggle"),
      import("../../pi/extensions/agentdev/ralplan"),
      import("../../pi/extensions/agentdev/fleet"),
      import("../../pi/extensions/agentdev/backend-adapter"),
      import("../../pi/extensions/agentdev/orchestrator"),
    ]);
    expect(typeof toggle.createToggleState).toBe("function");
    expect(typeof ralplan.createConsensusLoop).toBe("function");
    expect(typeof fleet.createFleet).toBe("function");
    expect(typeof adapter.createHerdrAdapter).toBe("function");
    expect(typeof orchestrator.createOrchestrator).toBe("function");
  });
});

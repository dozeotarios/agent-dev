import { describe, expect, it } from "vitest";
import {
  createHerdrAdapter,
  HerdrError,
  validatePaneCommand,
  type Runner,
} from "../../pi/extensions/agentdev/backend-adapter";

/** Deterministic fake runner: records calls, returns canned JSON (unit layer only). */
function fakeRunner(
  responses:
    | string
    | Record<string, string>
    | ((args: string[]) => string),
) {
  const calls: string[][] = [];
  const runner: Runner = (args) => {
    calls.push([...args]);
    if (typeof responses === "string") return responses;
    if (typeof responses === "function") return responses(args);
    const key = args.join(" ");
    if (key in responses) return responses[key];
    throw new Error(`no canned response for: ${key}`);
  };
  return { runner, calls };
}

const ok = (result: unknown) =>
  JSON.stringify({ id: "cli:test", result, type: "test" });
const err = (code: string, message: string) =>
  JSON.stringify({ id: "cli:test", error: { code, message } });

describe("BackendAdapter — command construction + parsing (unit, mocked herdr)", () => {
  it("workspaceCreate builds the CLI args and parses ids", () => {
    const { runner, calls } = fakeRunner(
      ok({
        root_pane: { pane_id: "w1:p1" },
        tab: { tab_id: "w1:t1" },
        type: "workspace_created",
        workspace: { workspace_id: "w1" },
      }),
    );
    const adapter = createHerdrAdapter(runner);
    const res = adapter.workspaceCreate({ cwd: "/tmp/proj", label: "proj" });
    expect(calls[0]).toEqual([
      "workspace", "create", "--cwd", "/tmp/proj", "--label", "proj",
    ]);
    expect(res.workspaceId).toBe("w1");
    expect(res.tabId).toBe("w1:t1");
    expect(res.paneId).toBe("w1:p1");
  });

  it("throws HerdrError with the server error code on failure", () => {
    const { runner } = fakeRunner(err("workspace_create_failed", "boom"));
    const adapter = createHerdrAdapter(runner);
    try {
      adapter.workspaceCreate({ cwd: "/x", label: "x" });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(HerdrError);
      expect((e as HerdrError).code).toBe("workspace_create_failed");
    }
  });

  it("workspaceCreate validates result fields — missing ids throw invalid_rpc, not TypeError", () => {
    const { runner } = fakeRunner(ok({ workspace: {}, tab: {}, root_pane: {} }));
    const adapter = createHerdrAdapter(runner);
    try {
      adapter.workspaceCreate({ cwd: "/x", label: "x" });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(HerdrError);
      expect((e as HerdrError).code).toBe("invalid_rpc");
    }
  });

  it("paneRename builds the label args", () => {
    const { runner, calls } = fakeRunner(ok({ type: "ok" }));
    const adapter = createHerdrAdapter(runner);
    adapter.paneRename("w1:p1", "L:proj");
    expect(calls[0]).toEqual(["pane", "rename", "w1:p1", "L:proj"]);
  });

  it("paneRun passes the command through UNSPLIT — quotes and shell syntax preserved", () => {
    const { runner, calls } = fakeRunner("");
    const adapter = createHerdrAdapter(runner);
    adapter.paneRun("w1:p1", 'git commit -m "fix: the bug"');
    expect(calls[0]).toEqual(["pane", "run", "w1:p1", 'git commit -m "fix: the bug"']);
  });

  it("paneRun rejects control characters and empty commands (validatePaneCommand)", () => {
    expect(() => validatePaneCommand("")).toThrow(HerdrError);
    expect(() => validatePaneCommand("  ")).toThrow(HerdrError);
    expect(() => validatePaneCommand("echo a\nrm -rf /")).toThrow(HerdrError);
    expect(() => validatePaneCommand("echo a\rrm -rf /")).toThrow(HerdrError);
    expect(() => validatePaneCommand("echo ok")).not.toThrow();
  });

  it("paneRunAndWait parses the completion sentinel exit code and strips it", () => {
    const { runner } = fakeRunner((args) => {
      if (args[1] === "read") return "some output\n__AGENTDEV_EXIT_7__";
      return "";
    });
    const adapter = createHerdrAdapter(runner);
    const r = adapter.paneRunAndWait("w1:p1", "false", { timeoutMs: 5_000 });
    expect(r.completed).toBe(true);
    expect(r.exitCode).toBe(7);
    expect(r.output).toBe("some output");
  });

  it("paneRunAndWait times out when the sentinel never appears", () => {
    const { runner } = fakeRunner((args) => (args[1] === "read" ? "nothing here" : ""));
    const adapter = createHerdrAdapter(runner);
    const r = adapter.paneRunAndWait("w1:p1", "sleep 5", { timeoutMs: 800 });
    expect(r.completed).toBe(false);
    expect(r.exitCode).toBeNull();
  });

  it("paneRead passes through terminal text and uses recent-unwrapped by default", () => {
    const { runner, calls } = fakeRunner("└─$ echo hi\nhi\n");
    const adapter = createHerdrAdapter(runner);
    const out = adapter.paneRead("w1:p1");
    expect(calls[0]).toEqual(["pane", "read", "w1:p1", "--source", "recent-unwrapped"]);
    expect(out).toContain("hi");
  });

  it("paneRead THROWS HerdrError when the CLI returns an error envelope (dead pane)", () => {
    const { runner } = fakeRunner(err("pane_not_found", "pane w1:p1 not found"));
    const adapter = createHerdrAdapter(runner);
    try {
      adapter.paneRead("w1:p1");
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(HerdrError);
      expect((e as HerdrError).code).toBe("pane_not_found");
    }
  });

  it("paneRead does not misparse a pane's own JSON-ish output as an envelope", () => {
    const { runner } = fakeRunner('{"not":"an envelope"}');
    const adapter = createHerdrAdapter(runner);
    expect(adapter.paneRead("w1:p1")).toBe('{"not":"an envelope"}');
  });

  it("paneGet parses agent_status and label; missing pane_id → invalid_rpc", () => {
    const { runner } = fakeRunner(
      ok({ pane: { pane_id: "w1:p1", label: "W:auth", agent_status: "working" } }),
    );
    const adapter = createHerdrAdapter(runner);
    const pane = adapter.paneGet("w1:p1");
    expect(pane.label).toBe("W:auth");
    expect(pane.agentStatus).toBe("working");

    const { runner: bad } = fakeRunner(ok({ pane: { label: "x" } }));
    const adapter2 = createHerdrAdapter(bad);
    try {
      adapter2.paneGet("w1:p1");
      expect.unreachable();
    } catch (e) {
      expect((e as HerdrError).code).toBe("invalid_rpc");
    }
  });

  it("agentWait builds --until/--timeout and returns true on match", () => {
    const { runner, calls } = fakeRunner(ok({ matched: true }));
    const adapter = createHerdrAdapter(runner);
    expect(adapter.agentWait("w1:p1", { until: "done", timeoutMs: 5000 })).toBe(true);
    expect(calls[0]).toEqual([
      "agent", "wait", "w1:p1", "--until", "done", "--timeout", "5000",
    ]);
  });

  it("agentWait returns false for agent_not_found and for wait timeouts", () => {
    const { runner: r1 } = fakeRunner(err("agent_not_found", "no agent"));
    const adapter1 = createHerdrAdapter(r1);
    expect(adapter1.agentWait("w1:p1", { until: "done", timeoutMs: 1000 })).toBe(false);

    // wait timeout: execFileSync kills the child at the budget (killed=true)
    const { runner: r2 } = fakeRunner(() => {
      const e = new Error("spawnSync herdr ETIMEDOUT") as Error & { killed: boolean };
      e.killed = true;
      throw e;
    });
    const adapter2 = createHerdrAdapter(r2);
    expect(adapter2.agentWait("w1:p1", { until: "done", timeoutMs: 1000 })).toBe(false);
  });

  it("agentWait RETHROWS infrastructure failures (exec_failed, invalid_rpc)", () => {
    // herdr binary missing / socket dead → exec_failed must NOT collapse to false
    const { runner } = fakeRunner(() => {
      throw new Error("spawn herdr ENOENT");
    });
    const adapter = createHerdrAdapter(runner);
    try {
      adapter.agentWait("w1:p1", { until: "done", timeoutMs: 1000 });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(HerdrError);
      expect((e as HerdrError).code).toBe("exec_failed");
    }

    // protocol drift: non-JSON response
    const { runner: r2 } = fakeRunner("not json at all");
    const adapter2 = createHerdrAdapter(r2);
    try {
      adapter2.agentWait("w1:p1", { until: "done", timeoutMs: 1000 });
      expect.unreachable();
    } catch (e) {
      expect((e as HerdrError).code).toBe("invalid_rpc");
    }
  });

  it("agentWait returns false on empty output (never fabricates success)", () => {
    const { runner } = fakeRunner("");
    const adapter = createHerdrAdapter(runner);
    expect(adapter.agentWait("w1:p1", { until: "done", timeoutMs: 1000 })).toBe(false);
  });

  it("paneClose/workspaceClose tolerate ONLY pane_not_found/workspace_not_found", () => {
    const { runner } = fakeRunner(err("pane_not_found", "gone"));
    const adapter = createHerdrAdapter(runner);
    expect(() => adapter.paneClose("w1:p1")).not.toThrow();
    expect(() => adapter.workspaceClose("w1")).not.toThrow();
  });

  it("paneClose/workspaceClose RETHROW non-close *_not_found codes (e.g. agent_not_found)", () => {
    const { runner } = fakeRunner(err("agent_not_found", "no agent"));
    const adapter = createHerdrAdapter(runner);
    expect(() => adapter.paneClose("w1:p1")).toThrow(HerdrError);
    try {
      adapter.workspaceClose("w1");
      expect.unreachable();
    } catch (e) {
      expect((e as HerdrError).code).toBe("agent_not_found");
    }
  });

  it("paneList parses the real result.panes[] shape (snake_case mapping)", () => {
    const { runner, calls } = fakeRunner(
      ok({ panes: [{ pane_id: "w1:p1", workspace_id: "w1", agent_status: "working" }] }),
    );
    const adapter = createHerdrAdapter(runner);
    const panes = adapter.paneList();
    expect(calls[0]).toEqual(["pane", "list"]);
    expect(panes).toEqual([{ paneId: "w1:p1", workspaceId: "w1", agentStatus: "working" }]);
  });

  it("paneList missing panes array → invalid_rpc, not raw TypeError", () => {
    const { runner } = fakeRunner(ok({}));
    const adapter = createHerdrAdapter(runner);
    try {
      adapter.paneList();
      expect.unreachable();
    } catch (e) {
      expect((e as HerdrError).code).toBe("invalid_rpc");
    }
  });

  it("parseRpc throws invalid_rpc on empty output for result-requiring commands", () => {
    const { runner } = fakeRunner("");
    const adapter = createHerdrAdapter(runner);
    expect(() => adapter.paneGet("w1:p1")).toThrow(HerdrError);
    expect(() => adapter.paneList()).toThrow(HerdrError);
    expect(() => adapter.workspaceCreate({ cwd: "/x", label: "x" })).toThrow(HerdrError);
    try {
      adapter.paneGet("w1:p1");
      expect.unreachable();
    } catch (e) {
      expect((e as HerdrError).code).toBe("invalid_rpc");
    }
  });

  it("herdrVersion parses the semver out of the banner", () => {
    const { runner } = fakeRunner("herdr 0.7.5");
    const adapter = createHerdrAdapter(runner);
    expect(adapter.herdrVersion()).toBe("0.7.5");
  });

  it("assertHerdrVersion gates on [0.7.5, 0.8.0)", () => {
    const { runner: ok7 } = fakeRunner("herdr 0.7.5");
    expect(() => createHerdrAdapter(ok7, { checkVersion: true })).not.toThrow();

    const { runner: old } = fakeRunner("herdr 0.6.9");
    try {
      createHerdrAdapter(old, { checkVersion: true });
      expect.unreachable();
    } catch (e) {
      expect((e as HerdrError).code).toBe("unsupported_version");
    }

    const { runner: fut } = fakeRunner("herdr 0.8.1");
    try {
      createHerdrAdapter(fut, { checkVersion: true });
      expect.unreachable();
    } catch (e) {
      expect((e as HerdrError).code).toBe("unsupported_version");
    }
  });
});

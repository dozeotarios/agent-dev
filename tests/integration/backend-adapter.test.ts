import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureHerdrServer,
  herdrInfo,
} from "../helpers/herdr-is-present";
import { createHerdrAdapter, HerdrError } from "../../pi/extensions/agentdev/backend-adapter";

// AC-REAL-1/AC-REAL-2: integration runs against the REAL installed herdr
// (headless server started if needed). No simulation.
const herdr = herdrInfo();
const serverUp = herdr.present ? ensureHerdrServer() : false;
const skip = !herdr.present || !serverUp;

describe.skipIf(skip)("BackendAdapter — real herdr integration (AC-REAL-1)", () => {
  const cwd = mkdtempSync(join(tmpdir(), "agentdev-it-"));
  const adapter = createHerdrAdapter();
  let ws: { workspaceId: string; tabId: string; paneId: string };

  beforeAll(() => {
    expect(herdr.present).toBe(true);
  });

  afterAll(() => {
    try {
      rmSync(cwd, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("reports the real herdr version (semver)", () => {
    expect(adapter.herdrVersion()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("creates a workspace + root pane in the real server", () => {
    ws = adapter.workspaceCreate({ cwd, label: "it-ws" });
    expect(ws.workspaceId).toMatch(/^w[0-9A-Za-z]+$/); // real ids: w1..w9, wA..
    expect(ws.paneId).toMatch(/^w[0-9A-Za-z]+:p[0-9A-Za-z]+$/);
  });

  it("renames (labels) the pane — role-prefix convention", () => {
    adapter.paneRename(ws.paneId, "W:it-story");
    const pane = adapter.paneGet(ws.paneId);
    expect(pane.label).toBe("W:it-story");
  });

  it("runs a command and reads its output back from the real terminal", async () => {
    adapter.paneRun(ws.paneId, "echo AGENTDEV_IT_OK");
    await new Promise((r) => setTimeout(r, 1500));
    const out = adapter.paneRead(ws.paneId);
    expect(out).toContain("AGENTDEV_IT_OK");
  });

  it("paneRun preserves QUOTED arguments through the real shell", async () => {
    // Regression for the split-on-whitespace bug: the double space and the
    // quotes must survive the round trip (herdr joins argv → shell re-parses).
    adapter.paneRun(ws.paneId, 'printf "a  b"');
    await new Promise((r) => setTimeout(r, 1500));
    const out = adapter.paneRead(ws.paneId);
    expect(out).toContain("a  b");
  });

  it("paneRunAndWait returns the real exit code via the completion sentinel", async () => {
    const r = adapter.paneRunAndWait(ws.paneId, "exit 3", { timeoutMs: 15_000 });
    expect(r.completed).toBe(true);
    expect(r.exitCode).toBe(3);
  });

  it("paneRead on a dead pane THROWS HerdrError instead of returning the envelope", () => {
    try {
      adapter.paneRead("w999:nonexistent-pane-xyz", { source: "recent" });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(HerdrError);
      expect((e as HerdrError).code).toBe("pane_not_found");
    }
  });

  it("agentWait distinguishes a dead pane (false) from a live one (true)", () => {
    // dead pane → agent_not_found → false (not an exception)
    expect(
      adapter.agentWait("w999:nonexistent-pane-xyz", { until: "done", timeoutMs: 1_000 }),
    ).toBe(false);
    // live pane (no agent detected) → still false, and never throws
    expect(
      adapter.agentWait(ws.paneId, { until: "done", timeoutMs: 1_000 }),
    ).toBe(false);
  });

  it("assertHerdrVersion passes on the real installed binary", () => {
    expect(() => adapter.assertHerdrVersion()).not.toThrow();
  });

  it("closes the pane; closing the last pane closes the workspace (tolerant)", () => {
    adapter.paneClose(ws.paneId);
    expect(() => adapter.workspaceClose(ws.workspaceId)).not.toThrow();
  });
});

/**
 * agentdev-crew — REAL herdr spawn cycle (firstmate-style, AC-CREW-1..5).
 *
 * Requires the herdr server running + a pi model provider configured
 * (same prerequisites as the agentdev launch). Spawns a real worker pane,
 * briefs a real pi agent, waits for its on-disk report, tears down.
 */
import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHerdrAdapter } from "../../pi/extensions/agentdev/backend-adapter";
import {
  spawnWorker,
  waitForWorker,
  teardownWorker,
  readWorkerReport,
  parseWorkerReport,
  crewBrief,
} from "../../pi/extensions/agentdev/crew";

describe("agentdev-crew (AC-CREW-1..5) — real herdr spawn cycle", () => {
  it(
    "spawns a Subworker pane → briefs it → report lands → teardown",
    async () => {
      const repo = mkdtempSync(join(tmpdir(), "agentdev-crew-it-"));
      const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
      execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
      // a trivial test command so the worker's "run the suite" step passes
      writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "crew-it", scripts: { test: "node -e \"process.exit(0)\"" } }, null, 2));

      const adapter = createHerdrAdapter();
      const worker = spawnWorker(
        adapter,
        {
          goalId: "it-goal",
          storyId: "story-1",
          worktree: repo,
          criteria: ["create hello.txt containing exactly CREW_OK"],
          goalText: "integration test goal",
          stack: null,
          mode: "direct-PR",
        },
        { cwd: repo },
      );
      expect(worker.paneId).toBeTruthy();
      expect(worker.reportPath).toContain(".agentdev");

      const outcome = await waitForWorker(adapter, worker, 300_000);
      expect(outcome).toBe("done");
      const report = readWorkerReport(worker.reportPath);
      expect(parseWorkerReport(report).outcome).toBe("done");
      expect(existsSync(join(repo, "hello.txt"))).toBe(true);

      teardownWorker(adapter, worker);
      rmSync(repo, { recursive: true, force: true });
    },
    400_000,
  );

  it("creates the report directory before prompting (worker has a target)", () => {
    const brief = crewBrief({
      goalText: "g",
      storyId: "s1",
      criteria: ["c1"],
      stack: null,
      mode: "direct-PR",
      worktree: "/tmp/wt",
      reportPath: "/tmp/wt/.agentdev/goals/g/reports/s1.md",
    });
    expect(brief).toContain("STORY_DONE");
    expect(brief).toContain("/tmp/wt/.agentdev/goals/g/reports/s1.md");
  });
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorktreePool } from "../../pi/extensions/agentdev/worktree";
import { dispatchPlan, completeWorker } from "../../pi/extensions/agentdev/dispatch";

// AC-DISPATCH-3/4 + AC-REAL-1: real git worktrees on the real filesystem —
// isolation, reuse with state preserved (deps/cache), no simulation.
function gitPresent(): boolean {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!gitPresent())(
  "worktree pool — real git integration (AC-DISPATCH-3/4)",
  () => {
    let base: string;
    const created: string[] = [];
    let branchCounter = 0; // git requires globally unique branch names per worktree

    beforeAll(() => {
      base = mkdtempSync(join(tmpdir(), "agentdev-base-"));
      execFileSync("git", ["init", "-b", "main"], { cwd: base, stdio: "ignore" });
      execFileSync(
        "git",
        ["-c", "user.name=agentdev", "-c", "user.email=agentdev@test", "commit", "--allow-empty", "-m", "init"],
        { cwd: base, stdio: "ignore" },
      );
    });

    afterAll(() => {
      for (const p of created) {
        try {
          execFileSync("git", ["-C", base, "worktree", "remove", "--force", p], { stdio: "ignore" });
        } catch {
          /* ignore */
        }
      }
      rmSync(base, { recursive: true, force: true });
    });

    function realPool(maxSize = 4) {
      return createWorktreePool({
        maxSize,
        create: () => {
          const path = mkdtempSync(join(tmpdir(), "agentdev-wt-"));
          created.push(path);
          execFileSync(
            "git",
            ["-C", base, "worktree", "add", path, "-b", `branch-${branchCounter++}`],
            { stdio: "ignore" },
          );
          return path;
        },
      });
    }

    it("acquired worktrees are real isolated git worktrees", () => {
      const p = realPool();
      const a = p.acquire();
      const b = p.acquire();
      expect(a).not.toBe(b);
      for (const wt of [a, b]) {
        expect(existsSync(join(wt, ".git"))).toBe(true); // worktree .git file
        expect(execFileSync("git", ["-C", wt, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim()).toBe(wt);
      }
    });

    it("released worktrees are REUSED with state preserved (cache/deps survive)", () => {
      const p = realPool();
      const a = p.acquire();
      writeFileSync(join(a, "cache-marker.txt"), "node_modules cache");
      p.release(a);
      const again = p.acquire();
      expect(again).toBe(a);
      expect(readFileSync(join(again, "cache-marker.txt"), "utf8")).toBe("node_modules cache");
    });

    it("dispatch: 2 stories -> 2 distinct real worktrees; completing a worker frees one for reuse", () => {
      const p = realPool();
      const plan = { planId: "plan-1", stories: [{ storyId: "s1" }, { storyId: "s2" }] };
      const res = dispatchPlan(plan, p);
      const [w1, w2] = res.workers;
      expect(w1.worktreePath).not.toBe(w2.worktreePath);
      expect(existsSync(join(w1.worktreePath, ".git"))).toBe(true);
      completeWorker(w1, p);
      const next = dispatchPlan({ planId: "plan-2", stories: [{ storyId: "s3" }] }, p);
      expect(next.workers[0].worktreePath).toBe(w1.worktreePath); // reused
    });
  },
);

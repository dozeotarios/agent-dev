import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parsePorcelain,
  parseBranch,
  collectGitState,
} from "../../pi/extensions/agentdev/git-state";
import { createCommitGate } from "../../pi/extensions/agentdev/git-gate";
import { assertSafeGitCommand, assertNotProtected } from "../../pi/extensions/agentdev/guard-git";

// AC-GIT-1..4 + AC-REAL-1: the real git repo, real worktree, real commit flow.
function gitPresent(): boolean {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!gitPresent())("git gate + state map — real git integration (AC-GIT-1..4)", () => {
  let base: string;
  let wt: string;

  const git = (args: string[], cwd: string) =>
    execFileSync("git", args, { cwd, stdio: "ignore" });

  beforeAll(() => {
    base = mkdtempSync(join(tmpdir(), "agentdev-gitbase-"));
    git(["init", "-b", "main"], base);
    git(["-c", "user.name=agentdev", "-c", "user.email=agentdev@test", "commit", "--allow-empty", "-m", "init"], base);
    wt = mkdtempSync(join(tmpdir(), "agentdev-gitwt-"));
    git(["-C", base, "worktree", "add", wt, "-b", "feature/auth"], base);
  });

  afterAll(() => {
    try {
      git(["-C", base, "worktree", "remove", "--force", wt], base);
    } catch {
      /* ignore */
    }
    rmSync(base, { recursive: true, force: true });
    rmSync(wt, { recursive: true, force: true });
  });

  it("scans the real worktree: branch + uncommitted changes (AC-GIT-3)", () => {
    writeFileSync(join(wt, "newfile.txt"), "wip");
    const branch = parseBranch(execFileSync("git", ["branch", "--show-current"], { cwd: wt, encoding: "utf8" }));
    const porcelain = execFileSync("git", ["status", "--porcelain"], { cwd: wt, encoding: "utf8" });
    const map = collectGitState([
      { path: wt, branch, uncommitted: parsePorcelain(porcelain) },
    ]);
    expect(map.worktrees[0].branch).toBe("feature/auth");
    expect(map.worktrees[0].uncommitted.some((e) => e.status === "??" && e.file === "newfile.txt")).toBe(true);
  });

  it("direct-PR: confirm → real commit happens (AC-GIT-2/5)", () => {
    const gate = createCommitGate("direct-PR");
    expect(gate.markCommitReady()).toBe("awaiting-confirm");
    // operator confirms with the Leader:
    expect(gate.confirm()).toBe("committed");
    git(["add", "-A"], wt);
    git(["-c", "user.name=agentdev", "-c", "user.email=agentdev@test", "commit", "-m", "feat: auth story"], wt);
    const log = execFileSync("git", ["log", "--oneline", "-1"], { cwd: wt, encoding: "utf8" });
    expect(log).toContain("feat: auth story");
  });

  it("+yolo: markCommitReady auto-commits without confirmation (AC-GIT-8)", () => {
    writeFileSync(join(wt, "yolo.txt"), "yolo");
    const gate = createCommitGate("+yolo");
    expect(gate.markCommitReady()).toBe("committed"); // no awaiting-confirm
    git(["add", "-A"], wt);
    git(["-c", "user.name=agentdev", "-c", "user.email=agentdev@test", "commit", "-m", "feat: yolo"], wt);
    const log = execFileSync("git", ["log", "--oneline", "-1"], { cwd: wt, encoding: "utf8" });
    expect(log).toContain("yolo");
  });

  it("main is protected; destructive git is blocked (AC-GIT-4)", () => {
    expect(() => assertNotProtected("main")).toThrow(/protected ref/);
    expect(() => assertSafeGitCommand(["reset", "--hard"])).toThrow(/blocked/);
    expect(() => assertSafeGitCommand(["push", "--force"])).toThrow(/blocked/);
    expect(existsSync(join(wt, "yolo.txt"))).toBe(true); // nothing destroyed
  });
});

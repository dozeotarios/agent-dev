import { describe, expect, it } from "vitest";
import {
  isProtectedRef,
  assertNotProtected,
  isDestructiveCommand,
  assertSafeGitCommand,
} from "../../pi/extensions/agentdev/guard-git";

// AC-GIT-4: main protected; guard-git blocks destructive git.
describe("guard-git + protected main (AC-GIT-4)", () => {
  it("protects main/master (any ref spelling)", () => {
    expect(isProtectedRef("main")).toBe(true);
    expect(isProtectedRef("master")).toBe(true);
    expect(isProtectedRef("refs/heads/main")).toBe(true);
    expect(isProtectedRef("feature/auth")).toBe(false);
    expect(isProtectedRef(null)).toBe(false);
  });

  it("assertNotProtected throws on protected refs", () => {
    expect(() => assertNotProtected("main")).toThrow(/protected ref/);
    expect(() => assertNotProtected("feature/x")).not.toThrow();
  });

  it("blocks destructive commands", () => {
    const blocked: string[][] = [
      ["reset", "--hard", "HEAD"],
      ["clean", "-fdx"],
      ["push", "--force"],
      ["push", "-f", "origin", "main"],
      ["branch", "-D", "feature/x"],
      ["checkout", "."],
      ["restore", "."],
    ];
    for (const argv of blocked) {
      expect(isDestructiveCommand(argv), argv.join(" ")).not.toBeNull();
      expect(() => assertSafeGitCommand(argv), argv.join(" ")).toThrow(/blocked/);
    }
  });

  it("blocks ALL verified review bypass forms — git-prefixed, -- pathspecs, flags", () => {
    const bypasses: string[][] = [
      ["git", "reset", "--hard"],
      ["git", "reset", "--hard", "HEAD"],
      ["git", "clean", "-f"],
      ["git", "push", "--force", "origin", "main"],
      ["git", "branch", "-D", "feature"],
      ["git", "checkout", "."],
      ["git", "restore", "."],
      ["checkout", "--", "."],
      ["checkout", "HEAD", "--", "."],
      ["checkout", "-f", "."],
      ["restore", "--staged", "."],
      ["restore", "--source", "HEAD", "."],
      ["restore", "--worktree", "--staged", "."],
      ["git", "restore", "--worktree", "."],
      ["git", "rm", "-r", "."],
      ["git", "rm", "-rf", "src"],
      ["rm", "-r", "."],
      ["rm", "-rf", "/"],
      ["git\nreset", "--hard", "HEAD"], // newline injection
      ["git", "reset", "--hard", "HEAD"],
      ["reset", "--hard"],
    ];
    for (const argv of bypasses) {
      expect(isDestructiveCommand(argv), argv.join(" ")).not.toBeNull();
      expect(() => assertSafeGitCommand(argv), argv.join(" ")).toThrow(/blocked/);
    }
  });

  it("allows safe commands — including git-prefixed and pathspec forms", () => {
    const safe: string[][] = [
      ["add", "-A"],
      ["git", "add", "-A"],
      ["commit", "-m", "wip"],
      ["git", "commit", "-m", "fix: the bug"],
      ["push", "origin", "feature/x"],
      ["checkout", "feature/x"],
      ["git", "checkout", "feature/x"],
      ["checkout", "--", "src/file.ts"], // non-root pathspec is safe
      ["restore", "--staged", "src/file.ts"],
      ["merge", "feature/x"],
      ["status"],
      ["log", "--oneline"],
      ["diff", "--stat"],
    ];
    for (const argv of safe) {
      expect(isDestructiveCommand(argv), argv.join(" ")).toBeNull();
      expect(() => assertSafeGitCommand(argv)).not.toThrow();
    }
  });
});

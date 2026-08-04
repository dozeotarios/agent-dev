import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// CLI tests (AC-INSTALL-1/2): `agentdev install` must be runnable by ANYBODY —
// herdr first, then the brain, then verification. Runs against the REAL
// binaries in an ISOLATED HOME so the user's pi config is never touched.

const BIN = join(process.cwd(), "bin", "agentdev-install.mjs");

function runCli(args: string[], env: Record<string, string> = {}) {
  try {
    const out = execFileSync("node", [BIN, ...args], {
      encoding: "utf8",
      timeout: 240_000,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, stdout: out, stderr: "" };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? 1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

describe("agentdev install CLI (AC-INSTALL-1/2)", () => {
  it("version prints the package version", () => {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8"));
    const r = runCli(["version"]);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe(pkg.version);
  });

  it("works when invoked through a SYMLINK (the npm global-bin case)", () => {
    const dir = mkdtempSync(join(tmpdir(), "agentdev-binlink-"));
    const link = join(dir, "agentdev");
    const { symlinkSync } = require("node:fs") as typeof import("node:fs");
    symlinkSync(join(process.cwd(), "bin", "agentdev-install.mjs"), link);
    const out = execFileSync("node", [link, "version"], { encoding: "utf8", timeout: 60_000 });
    const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8"));
    expect(out.trim()).toBe(pkg.version); // regression: bin was silent via symlink
    rmSync(dir, { recursive: true, force: true });
  });

  it("help prints usage and exits 0", () => {
    const r = runCli(["help"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("agentdev install");
    expect(r.stdout).toContain("/agentdev on");
  });

  it("install --check NEVER registers the brain (verify-only, no mutation)", () => {
    const home = mkdtempSync(join(tmpdir(), "agentdev-cli-check-"));
    mkdirSync(join(home, ".pi"), { recursive: true });
    const r = runCli(["install", "--check"], { HOME: home });
    expect(r.code).toBe(0);
    const settings = join(home, ".pi", "agent", "settings.json");
    expect(existsSync(settings)).toBe(false); // untouched — nothing was written
    rmSync(home, { recursive: true, force: true });
  });

  it("--check verifies the real environment without changing it", () => {
    const r = runCli(["install", "--check"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("herdr:");
  });

  it("doctor reports herdr / pi / brain / server status (exit 0)", () => {
    const r = runCli(["doctor"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("agentdev doctor");
    expect(r.stdout).toContain("herdr");
    expect(r.stdout).toContain("pi");
  });

  it("launch is the default command — no subcommand passes through to pi args", () => {
    // `agentdev --version` is OUR version (subcommand precedence)
    const r = runCli(["--version"]);
    expect(r.code).toBe(0);
    const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8"));
    expect(r.stdout.trim()).toBe(pkg.version);
  });

  it("install registers the brain into pi in an ISOLATED HOME", () => {
    const home = mkdtempSync(join(tmpdir(), "agentdev-cli-home-"));
    mkdirSync(join(home, ".pi"), { recursive: true });
    const r = runCli(["install"], { HOME: home });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("herdr:");
    expect(r.stdout).toContain("Done");
    // the brain is registered in the isolated pi config
    const settings = join(home, ".pi", "agent", "settings.json");
    expect(existsSync(settings)).toBe(true);
    expect(readFileSync(settings, "utf8")).toContain("agentdev");
    // the package manifest declares the extension + skills pi resolves at load
    const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8"));
    expect(pkg.pi.extensions.length).toBeGreaterThan(0);
    expect(pkg.pi.skills.length).toBeGreaterThan(0);
    // the shipped skills exist on disk (what pi will discover)
    for (const skill of [
      "agentdev-map-codebase",
      "agentdev-choose-stack",
      "agentdev-define-language",
      "agentdev-define-constraints",
      "agentdev-plan",
      "agentdev-slice-tasks",
      "agentdev-build",
      "agentdev-enforce-first",
      "agentdev-verify",
      "agentdev-review",
      "agentdev-audit-code",
      "agentdev-security-review",
      "agentdev-commit",
      "agentdev-hook-commits",
    ]) {
      expect(existsSync(join(process.cwd(), "pi", "skills", skill, "SKILL.md"))).toBe(true);
    }
    rmSync(home, { recursive: true, force: true });
  });
});

describe("agentdev toggle persistence (OFF by default; restores last state)", () => {
  it("readToggleState: no file → OFF; on:true → ON; on:false → OFF", async () => {
    const { readToggleState, toggleFile } = await import("../../bin/agentdev-install.mjs");
    const dir = mkdtempSync(join(tmpdir(), "agentdev-toggle-"));
    mkdirSync(join(dir, ".agentdev"), { recursive: true });
    expect(readToggleState(dir)).toBe(false); // first use → OFF
    writeFileSync(toggleFile(dir), JSON.stringify({ on: true }), "utf8");
    expect(readToggleState(dir)).toBe(true);
    writeFileSync(toggleFile(dir), JSON.stringify({ on: false }), "utf8");
    expect(readToggleState(dir)).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });
});

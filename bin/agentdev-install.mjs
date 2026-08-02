#!/usr/bin/env node
/**
 * agentdev — launcher + installer (AC-INSTALL-1/2).
 *
 *   agentdev                  # ensure herdr + server + pi + extension, then
 *                            # launch pi with the crew ON (AUTO-ON)
 *   agentdev [pi args...]    # same, then pass args to pi (-p, --mode rpc, ...)
 *   agentdev install         # idempotent setup: installs ONLY what's missing
 *   agentdev doctor          # report herdr / pi / extension / server status
 *   agentdev version | help
 *
 * Smart-ensure semantics: anything already installed is used as-is — herdr,
 * pi, and the extension are only installed when missing. Order is the binding
 * contract's: herdr FIRST (the substrate), then the brain.
 * Self-contained plain node (no TS imports) — runs from npx, npm -g, or a
 * git clone.
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PKG_NAME = "@agent-dev/agentdev";
const MIN_HERDR = "0.7.5";
const MAX_HERDR = "0.8.0";
const PI_PACKAGE = "@earendil-works/pi-coding-agent";
const AUTO_ON_ENV = "AGENTDEV_AUTO_ON";

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: "utf8", timeout: 300_000, ...opts });
}

function compareSemver(a, b) {
  const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  }
  return 0;
}

function herdrVersion() {
  const r = run("herdr", ["--version"]);
  if (r.status !== 0) return null;
  return (r.stdout.match(/\d+\.\d+\.\d+/) ?? [null])[0];
}

function piPresent() {
  return run("pi", ["--version"]).status === 0;
}

function herdrServerRunning() {
  const r = run("herdr", ["status", "server"], { timeout: 10_000 });
  return r.status === 0 && /status:\s*running/.test(r.stdout);
}

// ---- ensures (install ONLY what's missing; verify what's there) ----

export function ensureHerdr(checkOnly = false) {
  const v = herdrVersion();
  if (v !== null) {
    if (compareSemver(v, MIN_HERDR) < 0 || compareSemver(v, MAX_HERDR) >= 0) {
      console.error(
        `ERROR: herdr ${v} is outside the supported range [${MIN_HERDR}, ${MAX_HERDR}). ` +
          `Update herdr (herdr update) and re-run.`,
      );
      process.exit(1);
    }
    console.log(`herdr: ${v} ✓ (present)`);
    return { present: true, version: v };
  }
  if (checkOnly) {
    console.log(`herdr: MISSING (run \`${PKG_NAME} install\` to install it)`);
    return { present: false, version: null };
  }
  console.log("herdr not found — installing (official installer)...");
  const platform = process.platform;
  const r = platform === "win32"
    ? run("powershell", ["-NoProfile", "-Command", "irm https://herdr.dev/install.ps1 | iex"])
    : run("sh", ["-c", "curl -fsSL https://herdr.dev/install.sh | sh"]);
  if (r.status !== 0) {
    console.error(`herdr install failed: ${(r.stderr ?? "").slice(0, 400)}`);
    process.exit(1);
  }
  const v2 = herdrVersion();
  if (v2 === null) {
    console.error("ERROR: herdr install failed — install it manually (https://herdr.dev)");
    process.exit(1);
  }
  console.log(`herdr: ${v2} ✓ (installed)`);
  return { present: true, version: v2 };
}

export function ensureHerdrServer(checkOnly = false) {
  if (herdrServerRunning()) {
    console.log("herdr server: running ✓");
    return { running: true };
  }
  if (checkOnly) {
    console.log("herdr server: STOPPED (launch will start it headless)");
    return { running: false };
  }
  console.log("herdr server: starting headless...");
  try {
    const child = spawn("herdr", ["server"], { detached: true, stdio: "ignore" });
    child.unref();
  } catch {
    console.error("ERROR: could not start the herdr server");
    process.exit(1);
  }
  // brief wait for the socket
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (herdrServerRunning()) {
      console.log("herdr server: running ✓");
      return { running: true };
    }
    const sab = new SharedArrayBuffer(4);
    Atomics.wait(new Int32Array(sab), 0, 0, 300);
  }
  console.error("ERROR: herdr server did not come up — run `herdr server` to see why");
  process.exit(1);
}

export function ensurePi(checkOnly = false) {
  if (piPresent()) {
    console.log("pi: present ✓");
    return { present: true };
  }
  if (checkOnly) {
    console.log(`pi: MISSING (run \`${PKG_NAME} install\` to install it)`);
    return { present: false };
  }
  console.log("pi not found — installing...");
  const r = run("npm", ["install", "-g", PI_PACKAGE]);
  if (r.status !== 0) {
    console.error(`pi install failed: ${(r.stderr ?? "").slice(0, 400)}`);
    process.exit(1);
  }
  console.log("pi: installed ✓");
  return { present: true };
}

function piSettingsPaths() {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  return [
    join(home, ".pi", "agent", "settings.json"),
    join(home, ".pi", "settings.json"),
    join(home, ".pi", "settings.json"),
  ];
}

function piSettings() {
  for (const p of piSettingsPaths()) {
    if (existsSync(p)) {
      try {
        const j = JSON.parse(readFileSync(p, "utf8"));
        if (j.packages || j.extensions || j.skills) return j;
      } catch {
        /* try next */
      }
    }
  }
  return null;
}

function brainRegistered() {
  const settings = piSettings();
  if (!settings) return false;
  const blob = JSON.stringify(settings);
  return blob.includes("agentdev") || blob.includes(PKG_NAME);
}

function packageRoot() {
  // running from a git clone or the npx cache: the dir with our package.json
  const candidates = [process.cwd(), PACKAGE_ROOT];
  for (const dir of candidates) {
    const pkg = join(dir, "package.json");
    if (existsSync(pkg)) {
      try {
        const j = JSON.parse(readFileSync(pkg, "utf8"));
        if (j.name === PKG_NAME || j.pi) return dir;
      } catch {
        /* try next */
      }
    }
  }
  return PACKAGE_ROOT;
}

function runningFromGitClone() {
  const root = packageRoot();
  return existsSync(join(root, "pi", "extensions", "agentdev", "index.ts"));
}

export function ensureBrain(checkOnly = false) {
  if (brainRegistered()) {
    console.log("agentdev brain: registered ✓");
    return { registered: true };
  }
  const root = packageRoot();
  const spec = runningFromGitClone() ? root : `npm:${PKG_NAME}`;
  if (checkOnly) {
    console.log(`agentdev brain: NOT registered (would run: pi install ${spec})`);
    return { registered: false };
  }
  console.log(`registering the brain: pi install ${spec} ...`);
  const r = run("pi", ["install", spec]);
  if (r.status !== 0) {
    console.error(`pi install failed: ${(r.stderr ?? "").slice(0, 400)}`);
    process.exit(1);
  }
  console.log("agentdev brain: registered ✓ (extension + 3 skills)");
  return { registered: true };
}

export function ensureGlobalBin(checkOnly = false) {
  // When launched via npx (not a git clone, not already global), install the
  // package globally so plain `agentdev` works on every future terminal.
  if (runningFromGitClone()) {
    if (!checkOnly) console.log("running from source — use `./bin/agentdev-install.mjs` or `npm link` for the global command");
    return { global: false };
  }
  const probe = run("agentdev", ["version"]);
  const alreadyGlobal = probe.status === 0 && probe.stdout.trim() === packageVersion();
  if (alreadyGlobal) {
    if (!checkOnly) console.log("agentdev command: on PATH ✓");
    return { global: true };
  }
  if (checkOnly) {
    console.log("agentdev command: NOT on PATH (install would add it globally)");
    return { global: false };
  }
  console.log("adding `agentdev` to your PATH (npm -g)...");
  const r = run("npm", ["install", "-g", PKG_NAME]);
  if (r.status !== 0) {
    console.error(`global install failed: ${(r.stderr ?? "").slice(0, 400)}`);
    process.exit(1);
  }
  console.log("agentdev command: on PATH ✓");
  return { global: true };
}

function packageVersion() {
  const pkg = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8"));
  return pkg.version;
}

// ---- persisted toggle: OFF by default, restores the last state ----

export function toggleFile(cwd) {
  return join(cwd, ".agentdev", "toggle.json");
}

export function readToggleState(cwd) {
  try {
    const j = JSON.parse(readFileSync(toggleFile(cwd), "utf8"));
    return j.on === true;
  } catch {
    return false; // first use → OFF
  }
}

// ---- herdr-hosted mode: pi lives INSIDE a herdr pane; herdr is the surface ----

function launcherStateFile() {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  return join(home, ".agentdev", "launcher.json");
}

function loadLauncherState() {
  try {
    return JSON.parse(readFileSync(launcherStateFile(), "utf8"));
  } catch {
    return {};
  }
}

function saveLauncherState(state) {
  const file = launcherStateFile();
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify(state, null, 2), { mode: 0o600 });
}

/** Find or create the agentdev workspace for this cwd; returns {workspaceId, paneId}. */
function ensureAgentdevWorkspace(cwd) {
  const state = loadLauncherState();
  const existing = state[cwd];
  if (existing) {
    const r = run("herdr", ["pane", "list"], { timeout: 15_000 });
    if (r.status === 0) {
      try {
        const panes = JSON.parse(r.stdout).result?.panes ?? [];
        if (panes.some((p) => p.workspace_id === existing.workspaceId)) {
          return existing; // still alive — reattach
        }
      } catch {
        /* fall through to recreate */
      }
    }
  }
  const r = run("herdr", ["workspace", "create", "--cwd", cwd, "--label", "agentdev"]);
  if (r.status !== 0) throw new Error(`workspace create failed: ${(r.stderr ?? "").slice(0, 200)}`);
  const result = JSON.parse(r.stdout).result;
  const ws = { workspaceId: result.workspace.workspace_id, paneId: result.root_pane.pane_id };
  state[cwd] = ws;
  saveLauncherState(state);
  console.log(`agentdev workspace: created (${ws.workspaceId})`);
  return ws;
}

function shellQuote(arg) {
  return `'${String(arg).replace(/'/g, `'\''`)}'`;
}

/** Launch herdr as the terminal surface, with pi running inside a herdr pane. */
function launchHerdrHosted(piArgs) {
  const ws = ensureAgentdevWorkspace(process.cwd());
  const crewOn = readToggleState(process.cwd()); // OFF by default; restores last state
  const envPrefix = crewOn ? "AGENTDEV_AUTO_ON=1" : null;
  const piCmd = [envPrefix, "pi", ...piArgs.map(shellQuote)].filter(Boolean).join(" ");
  const r = run("herdr", ["pane", "run", ws.paneId, piCmd], { timeout: 30_000 });
  if (r.status !== 0) throw new Error(`starting pi in the pane failed: ${(r.stderr ?? "").slice(0, 200)}`);
  console.log(crewOn
    ? "pi started inside the herdr workspace, crew ON (restored from last session)."
    : "pi started inside the herdr workspace, crew OFF (type /agentdev on to enable).");
  console.log("Opening herdr — click the 'agentdev' pane to interact with pi;");
  console.log("crew panes (L/S/W/R) appear alongside as goals start.");
  const tui = spawnSync("herdr", [], { stdio: "inherit", timeout: 0 });
  console.log("herdr closed. pi is still running in the agentdev workspace — run `herdr` again to reattach.");
  return tui.status ?? 0;
}

// ---- commands ----

function cmdVersion() {
  console.log(packageVersion());
  return 0;
}

function cmdHelp() {
  console.log(`agentdev — hierarchical agent orchestration on herdr (pi extension).

Usage:
  agentdev                  ensure herdr + server + pi + brain, then open herdr
                            with pi running in a pane (crew panes appear as
                            goals start; click any pane to interact)
  agentdev install          idempotent setup — installs ONLY what's missing
  agentdev doctor           report herdr / pi / brain / server status
  agentdev version          print the installed version
  agentdev help             this help

In the launched pi session:
  /agentdev on | off         manual toggle (launcher starts ON)
  /agentdev status | confirm <goal> | resume

Examples:
  agentdev                  open herdr; click the pi pane and give a goal
  agentdev -p "hello"       headless pi run with the crew ON
  agentdev install --check  verify-only setup report

Requirements checked: herdr ${MIN_HERDR}–${MAX_HERDR}, pi, node >= 20.`);
  return 0;
}

function cmdInstall(checkOnly) {
  console.log("== agentdev install ==");
  ensureHerdr(checkOnly);
  ensurePi(checkOnly);
  ensureBrain(checkOnly);
  if (!checkOnly) ensureGlobalBin(false);
  if (checkOnly) {
    console.log("\nAll checks reported. Run `agentdev install` to apply.");
  } else {
    console.log("\nDone. Type `agentdev` to launch the crew session.");
  }
  return 0;
}

function cmdDoctor() {
  console.log("== agentdev doctor ==");
  ensureHerdr(true);
  ensureHerdrServer(true);
  ensurePi(true);
  ensureBrain(true);
  ensureGlobalBin(true);
  console.log("\nMissing anything? Run `agentdev install`.");
  return 0;
}

function cmdLaunch(piArgs) {
  console.log("== agentdev launch ==");
  ensureHerdr(false);
  ensureHerdrServer(false);
  ensurePi(false);
  ensureBrain(false);
  if (process.stdin.isTTY) {
    try {
      return launchHerdrHosted(piArgs);
    } catch (e) {
      console.error(`herdr-hosted launch failed (${e.message}) — falling back to pi in this terminal.`);
    }
  }
  const crewOn = readToggleState(process.cwd());
  console.log(crewOn ? `launching pi with the crew ON...` : `launching pi (crew OFF — /agentdev on to enable)...`);
  const env = crewOn ? { ...process.env, [AUTO_ON_ENV]: "1" } : { ...process.env };
  const r = spawnSync("pi", piArgs, { stdio: "inherit", env, timeout: 0 });
  return r.status ?? 0;
}

export function main(argv = process.argv.slice(2)) {
  const [cmd, ...rest] = argv;
  if (cmd === "version" || cmd === "--version" || cmd === "-v") return cmdVersion();
  if (cmd === "help" || cmd === "--help" || cmd === "-h") return cmdHelp();
  if (cmd === "install") return cmdInstall(rest.includes("--check") || rest.includes("-c"));
  if (cmd === "doctor") return cmdDoctor();
  // anything else (including NO command) = launch pi with the crew ON
  return cmdLaunch(argv);
}

// Entry guard: handle npm's bin SYMLINK (process.argv[1] is the symlink path,
// import.meta.url is the real module path — compare realpaths).
const isMainEntry =
  process.argv[1] !== undefined &&
  (() => {
    try {
      return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
    } catch {
      return false;
    }
  })();

if (isMainEntry) {
  process.exit(main());
}

import { execFileSync, spawn } from "node:child_process";

/**
 * Real-environment check (AC-REAL-1): is herdr installed and runnable?
 * No mocks, no simulation — probes the actual binary.
 *
 * HARDENING (review closure):
 * - herdrInfo() is cached per process (no repeated `herdr --version` spawns).
 * - ensureHerdrServer spawns at most ONE server per process and never busy-
 *   burns the CPU: the poll sleeps via Atomics.wait on a shared buffer.
 * - If THIS process started the server, it stops it on process exit (no
 *   leaked headless daemons left behind by plain `npm test`).
 */

export interface HerdrInfo {
  present: boolean;
  version: string | null;
  raw: string | null;
}

export interface HerdrServerStatus {
  running: boolean;
}

let cached: HerdrInfo | null = null;
let serverSpawnedHere = false;

export function herdrInfo(): HerdrInfo {
  if (cached) return cached;
  try {
    const raw = execFileSync("herdr", ["--version"], {
      encoding: "utf8",
      timeout: 10_000,
    }).trim();
    const version = raw.match(/\d+\.\d+\.\d+/)?.[0] ?? null;
    cached = { present: true, version, raw };
  } catch {
    cached = { present: false, version: null, raw: null };
  }
  return cached;
}

/** Is the herdr server running? (control API requires the socket). */
export function herdrServerStatus(): HerdrServerStatus {
  try {
    const raw = execFileSync("herdr", ["status", "server"], {
      encoding: "utf8",
      timeout: 10_000,
    });
    return { running: /status:\s*running/.test(raw) };
  } catch {
    return { running: false };
  }
}

/** Synchronous sleep that does NOT burn the CPU (Atomics.wait). */
function sleepMs(ms: number): void {
  const sab = new SharedArrayBuffer(4);
  const view = new Int32Array(sab);
  Atomics.wait(view, 0, 0, ms);
}

let ensuring: boolean | null = null;

/**
 * Ensure the herdr server is running; start it headless (`herdr server`) if
 * not. Returns true if a server is reachable within the timeout. At most one
 * spawn per process; a server started here is stopped on process exit.
 */
export function ensureHerdrServer(timeoutMs = 15_000): boolean {
  if (ensuring !== null) return ensuring;
  if (herdrServerStatus().running) {
    ensuring = true;
    return true;
  }
  try {
    const child = spawn("herdr", ["server"], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    serverSpawnedHere = true;
    process.once("exit", () => {
      try {
        execFileSync("herdr", ["server", "stop"], { stdio: "ignore", timeout: 5_000 });
      } catch {
        /* already stopped */
      }
    });
  } catch {
    ensuring = false;
    return false;
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (herdrServerStatus().running) {
      ensuring = true;
      return true;
    }
    sleepMs(400);
  }
  ensuring = false;
  return false;
}

/** True when this process spawned the server (for teardown-aware tests). */
export function serverSpawnedByUs(): boolean {
  return serverSpawnedHere;
}

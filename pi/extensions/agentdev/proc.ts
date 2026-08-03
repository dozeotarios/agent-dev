/**
 * proc — async child-process helpers (non-blocking replacements for
 * spawnSync/execFileSync).
 *
 * The crew pipeline runs INSIDE the interactive pi process. Every
 * synchronous child-process call freezes pi's event loop, so typing stops
 * while the crew works (planner/reviewer asks can run minutes). These
 * helpers never block: the event loop stays free and the pi TUI remains
 * interactive while the crew runs.
 */

import { spawn, execFile } from "node:child_process";

export interface ProcResult {
  stdout: string;
  stderr: string;
}

export interface ProcError extends Error {
  /** Exit code (null when killed by a signal or spawn failure). */
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  /** True when our timeout fired and the child was killed. */
  timedOut: boolean;
}

/**
 * Spawn a process and collect stdout/stderr without blocking. Kills with
 * SIGTERM at timeoutMs, escalating to SIGKILL shortly after.
 */
export function spawnCollect(
  cmd: string,
  args: string[],
  opts: { cwd?: string; timeoutMs: number },
): Promise<ProcResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      // SIGTERM can be ignored — escalate so a stuck child can't wedge the goal
      const killTimer = setTimeout(() => {
        if (!settled) child.kill("SIGKILL");
      }, 2_000);
      killTimer.unref();
    }, opts.timeoutMs);
    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString("utf8");
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString("utf8");
    });
    child.on("error", (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const err = e as ProcError;
      err.code = null;
      err.signal = null;
      err.stdout = stdout;
      err.stderr = stderr;
      err.timedOut = false;
      reject(err);
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const err = new Error(
        signal
          ? `process killed by ${signal} after ${opts.timeoutMs}ms`
          : `process exited with code ${code}`,
      ) as ProcError;
      err.code = code;
      err.signal = signal;
      err.stdout = stdout;
      err.stderr = stderr;
      err.timedOut = signal !== null;
      if (code !== 0 || signal) reject(err);
      else resolve({ stdout, stderr });
    });
  });
}

/**
 * Run a short-lived command via execFile (async). Larger maxBuffer than the
 * default so big `npm test` output can't be misreported as a failure.
 */
export function execCollect(
  cmd: string,
  args: string[],
  opts: { cwd?: string; timeoutMs: number },
): Promise<ProcResult> {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      { cwd: opts.cwd, encoding: "utf8", timeout: opts.timeoutMs, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          const err = error as unknown as ProcError;
          err.stdout = String(stdout ?? "");
          err.stderr = String(stderr ?? "");
          err.timedOut = error.killed === true || /timed out|SIGTERM/i.test(error.message);
          reject(err);
        } else {
          resolve({ stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
        }
      },
    );
  });
}

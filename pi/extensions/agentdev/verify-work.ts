/**
 * verify-work (ARCHITECTURE.md §9, AC-VERIFY-1) — each Subleader runs
 * verification on its slice before review. Deterministic wrapper: runs the
 * project's test command in the worktree and reports pass/fail + output.
 *
 * ASYNC: runs via execFile so a long `npm test` never blocks the interactive
 * pi session (the crew pipeline shares its process).
 */

import { execCollect } from "./proc";

export interface VerifyResult {
  ok: boolean;
  output: string;
  command: string;
}

const DEFAULT_TEST_COMMAND = ["npm", "test"];

export async function verifyWork(
  worktree: string,
  command: string[] = DEFAULT_TEST_COMMAND,
): Promise<VerifyResult> {
  try {
    const r = await execCollect(command[0], command.slice(1), {
      cwd: worktree,
      timeoutMs: 300_000,
    });
    return { ok: true, output: r.stdout.slice(-2000), command: command.join(" ") };
  } catch (e) {
    const err = e as { stdout?: unknown; stderr?: unknown; message?: string };
    const output = [err.stdout, err.stderr, err.message]
      .filter((v): v is string | Buffer => typeof v === "string" || Buffer.isBuffer(v))
      .map((v) => String(v))
      .join("\n")
      .slice(-2000);
    return { ok: false, output, command: command.join(" ") };
  }
}

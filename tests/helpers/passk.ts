/**
 * pass@k logging (ARCHITECTURE.md §21): every agentic eval logs its outcome to
 * <cwd>/.agentdev/passk.jsonl so pass@k can be computed across scheduled runs.
 * Non-fatal: a logging failure never fails an eval.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export interface PassKEntry {
  name: string;
  passed: boolean;
  /** 1 = single-shot run (current evals); >1 once a multi-try harness lands. */
  attempt: number;
  ts: string;
  detail?: string;
}

export function logPassK(name: string, passed: boolean, detail?: string, attempt = 1): void {
  const entry: PassKEntry = { name, passed, attempt, ts: new Date().toISOString(), detail };
  try {
    const dir = join(process.cwd(), ".agentdev");
    mkdirSync(dir, { recursive: true, mode: 0o700 }); // appendFileSync does not create dirs
    appendFileSync(join(dir, "passk.jsonl"), JSON.stringify(entry) + "\n", { mode: 0o600 });
  } catch {
    /* non-fatal */
  }
}

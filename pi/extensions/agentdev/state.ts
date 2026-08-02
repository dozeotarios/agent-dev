/**
 * state + resilience (ARCHITECTURE.md §14/§15, AC-STATE-1/2, AC-RESIL-1).
 *
 * Project state under <cwd>/.agentdev (gitignored); global under ~/.agentdev.
 * All paths via path.join/os.homedir — no hardcoded separators (Windows-safe).
 * Restart-proof: fleet state is durable on disk; on restart, nodes whose panes
 * still exist in herdr RECONNECT, the rest are surfaced as orphans.
 *
 * HARDENING (review closure):
 * - saveFleet is ATOMIC: write <file>.tmp then renameSync (POSIX-atomic; a
 *   crash mid-write can never leave a torn fleet.json).
 * - loadFleet distinguishes FRESH (ENOENT → empty) from CORRUPT (parse/shape
 *   failure → quarantines to fleet.json.corrupt-<ts> and reports it); corrupt
 *   state is never silently reset to an empty fleet.
 * - Every loaded node is shape-validated (isValidFleetNode); malformed entries
 *   are quarantined with the file instead of flowing into reconcileFleet.
 * - State dirs/files are created 0o700/0o600 — no world-writable fleet.json.
 * - reconcileFleet checks the leader's pane too: a leader with a dead pane is
 *   an orphan (surfaced for re-creation), never a silent "reconnected".
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isValidFleetNode, type FleetNode } from "./fleet";

export function projectStateDir(cwd: string): string {
  return join(cwd, ".agentdev");
}

export function globalStateDir(): string {
  return join(homedir(), ".agentdev");
}

export function fleetStateFile(cwd: string): string {
  return join(projectStateDir(cwd), "fleet.json");
}

/** Atomic write: temp file in the same dir + rename (never a torn file). */
export function saveFleet(cwd: string, nodes: FleetNode[]): void {
  const dir = projectStateDir(cwd);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const target = fleetStateFile(cwd);
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, JSON.stringify(nodes, null, 2), { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, target);
}

export interface FleetLoadResult {
  nodes: FleetNode[];
  /** True when the file existed but was corrupt (quarantined, not erased). */
  corrupt: boolean;
  /** Path of the quarantined file, when corrupt. */
  quarantinedTo: string | null;
}

/** Fresh project (no file) → empty; corrupt file → quarantined + reported. */
export function loadFleet(cwd: string): FleetLoadResult {
  const file = fleetStateFile(cwd);
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (e) {
    if ((e as { code?: string }).code === "ENOENT") {
      return { nodes: [], corrupt: false, quarantinedTo: null }; // fresh start
    }
    throw e; // EACCES etc. is an infrastructure failure — surface it
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return quarantine(cwd, file, raw);
  }
  if (!Array.isArray(parsed)) return quarantine(cwd, file, raw);
  const valid = parsed.filter(isValidFleetNode);
  if (valid.length !== parsed.length) {
    return quarantine(cwd, file, raw, valid);
  }
  return { nodes: valid, corrupt: false, quarantinedTo: null };
}

function quarantine(
  cwd: string,
  file: string,
  raw: string,
  salvage?: FleetNode[],
): FleetLoadResult {
  const dir = projectStateDir(cwd);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const target = `${file}.corrupt-${Date.now()}`;
  try {
    writeFileSync(target, raw, { encoding: "utf8", mode: 0o600 });
  } catch {
    /* best-effort quarantine; the corrupt flag still surfaces */
  }
  return { nodes: salvage ?? [], corrupt: true, quarantinedTo: target };
}

export interface ReconcileResult {
  reconnected: FleetNode[];
  orphans: FleetNode[];
}

/**
 * Restart reconciliation (AC-RESIL-1): nodes whose pane still exists in herdr
 * reconnect; lost nodes become orphans (surfaced, never silently dropped).
 * The Leader reconnects ONLY when it has no pane (operator session) or its
 * pane is live — a leader with a dead pane is surfaced as an orphan so the
 * caller re-creates it loudly instead of believing it is alive.
 */
export function reconcileFleet(saved: FleetNode[], livePaneIds: Set<string>): ReconcileResult {
  const reconnected: FleetNode[] = [];
  const orphans: FleetNode[] = [];
  for (const node of saved) {
    // Leader without a pane = the operator's own session (always alive).
    // Every other node needs a LIVE pane; null/dead pane → surfaced orphan.
    const alive =
      (node.role === "leader" && node.paneId === null) ||
      (node.paneId !== null && livePaneIds.has(node.paneId));
    (alive ? reconnected : orphans).push(node);
  }
  return { reconnected, orphans };
}

/**
 * autoclose policy (ARCHITECTURE.md §10, AC-CLOSE-1..5).
 *
 * Clean completion → close (brief ✓ flash is UI). Failed/blocked → STAY;
 * closes only after handled (retry/reassign/dismiss); unattended past the
 * timeout → ping + stay. The Leader never closes. No silent auto-dismiss.
 */

import type { Role } from "./roles";
import type { NodeStatus } from "./fleet";

export type AutocloseDecision = "close" | "stay" | "ping";

export const UNATTENDED_TIMEOUT_MS = 5 * 60 * 1000;

export interface AutocloseContext {
  role: Role;
  status: NodeStatus;
  /** True when the orchestrator handled the failure (retry/reassign/dismiss). */
  handled: boolean;
  /** How long the node has been unattended in its current state. */
  unattendedMs: number;
}

export function autocloseDecision(ctx: AutocloseContext): AutocloseDecision {
  if (ctx.role === "leader") return "stay"; // AC-CLOSE-2: the Leader never closes
  if (ctx.status === "done") return "close"; // AC-CLOSE-1: clean completion
  if (ctx.status === "blocked") {
    if (ctx.handled) return "close"; // AC-CLOSE-4
    if (ctx.unattendedMs >= UNATTENDED_TIMEOUT_MS) return "ping"; // AC-CLOSE-5
    return "stay"; // AC-CLOSE-3
  }
  // Review closure: a worker stuck in working/idle/unknown is a stall — the
  // pane is alive but nothing progresses. Surface it (ping) past the same
  // unattended timeout; the orchestrator tracks pings for the escalation
  // ladder (ping → re-ping → operator attention).
  if (ctx.unattendedMs >= UNATTENDED_TIMEOUT_MS) return "ping";
  return "stay";
}

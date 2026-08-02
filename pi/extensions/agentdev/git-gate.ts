/**
 * commit gate (ARCHITECTURE.md §11, AC-GIT-1/2/8).
 *
 * The crew stops at commit-ready; a commit happens only after the operator
 * confirms with the Leader (awaiting-confirm phase). reject() returns to
 * commit-ready (work can be amended). In +yolo mode the gate auto-commits:
 * markCommitReady() → committed immediately, no confirmation.
 *
 * HARDENING (review closure):
 * - `committed` is TERMINAL: markCommitReady() after a commit throws.
 * - The gate is DURABLE: phase + lastCommitHash persist through an injected
 *   store (the orchestrator wires .agentdev storage), so a crash between
 *   confirm() and the real commit cannot double-commit — performCommit
 *   records the resulting hash and a retry skips an already-recorded hash.
 */

import { requiresConfirm, type ProjectMode } from "./modes";

export type GatePhase = "idle" | "commit-ready" | "awaiting-confirm" | "committed";

export interface GateState {
  phase: GatePhase;
  lastCommitHash: string | null;
  /** Per-worktree recorded commit hashes (crash-retry dedup, AC-GIT-2). */
  commits: Record<string, string>;
}

export interface GatePersist {
  load(): GateState | null;
  save(state: GateState): void;
}

export interface CommitGate {
  state(): GateState & { mode: ProjectMode };
  markCommitReady(): GatePhase;
  confirm(): GatePhase;
  reject(): GatePhase;
  /** Record the real commit's hash per worktree (crash-retry dedup). */
  recordCommit(worktree: string, hash: string): void;
}

export function createCommitGate(mode: ProjectMode, persist?: GatePersist): CommitGate {
  const loaded = persist?.load();
  let phase: GatePhase = loaded?.phase ?? "idle";
  let lastCommitHash: string | null = loaded?.lastCommitHash ?? null;
  const commits: Record<string, string> = loaded?.commits ?? {};

  const save = (): void => {
    persist?.save({ phase, lastCommitHash, commits });
  };

  return {
    state: () => ({ phase, mode, lastCommitHash, commits }),
    markCommitReady() {
      if (phase === "committed") {
        throw new Error("gate is already committed — terminal state");
      }
      if (phase === "awaiting-confirm") {
        throw new Error("already awaiting confirmation");
      }
      phase = requiresConfirm(mode) ? "awaiting-confirm" : "committed"; // +yolo auto-commits
      save();
      return phase;
    },
    confirm() {
      if (phase !== "awaiting-confirm") {
        throw new Error("confirm is only valid while awaiting-confirm");
      }
      phase = "committed";
      save();
      return phase;
    },
    reject() {
      if (phase !== "awaiting-confirm") {
        throw new Error("reject is only valid while awaiting-confirm");
      }
      phase = "commit-ready"; // keep ready; work can be amended
      save();
      return phase;
    },
    recordCommit(worktree, hash) {
      if (phase !== "committed") {
        throw new Error("recordCommit is only valid after confirm");
      }
      commits[worktree] = hash;
      lastCommitHash = hash;
      save();
    },
  };
}

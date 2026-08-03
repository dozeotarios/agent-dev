/**
 * real-ports (ARCHITECTURE.md §8/§9, AC-REAL-2) — production effect ports for
 * the orchestrator: real `pi -p` agents for consensus/review/build, real git
 * for verification/context, and the operator (via the extension UI) for the
 * manual interview + commit confirmation. Tests inject recorded fakes; these
 * are the REAL agents.
 *
 * NON-BLOCKING CONTRACT: every port is async (spawn/execFile, never
 * spawnSync/execFileSync). The crew runs inside the interactive pi process;
 * a synchronous child call would freeze pi's event loop for minutes and the
 * operator could not type while the crew worked.
 */

import { spawnCollect, execCollect } from "./proc";
/** Headless crew agents: never auto-on / never capture goals themselves. */
const HEADLESS_CREW_ENV: Record<string, string> = {
  AGENTDEV_NO_CREW: "1",
  AGENTDEV_AUTO_ON: "0",
};

import {
  spawnWorker as crewSpawnWorker,
  waitForWorker as crewWaitForWorker,
  teardownWorker as crewTeardownWorker,
  spawnSubleader as crewSpawnSubleader,
  parseWorkerReport,
  readWorkerReport,
  type CrewWorker,
} from "./crew";
import { builderPrompt, frameUntrusted } from "./agent-prompts";
import { verifyWork } from "./verify-work";
import { generateCandidates, createInterview, CATEGORY_ORDER, type ConstraintCategory } from "./define-constraints";
import { resolveStackSelection } from "./choose-stack";
import { PROJECT_MODES, type ProjectMode } from "./modes";
import type { ManualAnswers, OrchestratorPorts } from "./orchestrator";

export interface OperatorUI {
  notify(message: string, level?: "info" | "warning" | "error"): void;
  select<T extends string>(title: string, options: { value: T; label: string }[]): Promise<T>;
  input(title: string, placeholder?: string): Promise<string>;
}

export interface RealPortsOptions {
  ui: OperatorUI;
  /** Receives the real confirm handler (index.ts wires /agentdev confirm to it). */
  onConfirm?: (handler: (goalId: string, ok: boolean) => void) => void;
  /** Override the pi CLI binary (tests). */
  piBin?: string;
}

/** Ask a REAL pi agent (headless `pi -p`). Async — never blocks the session. */
export async function askPi(prompt: string, timeoutMs = 300_000, piBin = "pi"): Promise<string> {
  try {
    const r = await spawnCollect(piBin, ["-p", frameUntrusted(prompt)], {
      timeoutMs,
      env: HEADLESS_CREW_ENV,
    });
    return r.stdout.trim();
  } catch (e) {
    const err = e as { code?: number | null; stderr?: string; message?: string; timedOut?: boolean };
    throw new Error(
      `pi agent call failed (${err.code ?? "?"}${err.timedOut ? ", timed out" : ""}): ${(err.stderr ?? err.message ?? "").slice(0, 300)}`,
    );
  }
}

export function createRealPorts(opts: RealPortsOptions): OrchestratorPorts {
  // Pending operator confirmations (answered by /agentdev confirm <goal>).
  let pending: { goalId: string; resolve: (ok: boolean) => void } | null = null;
  if (opts.onConfirm) {
    opts.onConfirm((goalId: string, ok: boolean) => {
      if (pending && pending.goalId === goalId) {
        const resolve = pending.resolve;
        pending = null;
        resolve(ok);
      }
    });
  }

  const ui = opts.ui;
  const piBin = opts.piBin ?? "pi";

  const ports: OrchestratorPorts = {
    adapter: undefined as never, // filled by the extension (single herdr touchpoint)
    async ask(prompt, timeoutMs) {
      return askPi(prompt, timeoutMs ?? 300_000, piBin);
    },
    async buildStory(ctx) {
      // CREW-BACKED (firstmate-style): spawn a real worker pane, supervise it
      // to its report, teardown when green. Failures keep their pane open.
      const worker = crewSpawnWorker(ports.adapter, ctx, { cwd: process.cwd() });
      const outcome = await crewWaitForWorker(ports.adapter, worker);
      if (outcome === "done") {
        crewTeardownWorker(ports.adapter, worker);
        return;
      }
      const summary = readWorkerReport(worker.reportPath);
      crewTeardownWorker(ports.adapter, worker, true); // keep open for inspection
      throw new Error(`subworker ${outcome}: ${summary.slice(0, 300)}`);
    },
    async spawnWorker(ctx) {
      return crewSpawnWorker(ports.adapter, ctx, { cwd: process.cwd() });
    },
    async waitForWorker(w, opts) {
      return crewWaitForWorker(ports.adapter, w, opts?.timeoutMs);
    },
    async teardownWorker(w, keepOpen) {
      crewTeardownWorker(ports.adapter, w, keepOpen);
    },
    async spawnSubleader(input) {
      return crewSpawnSubleader(ports.adapter, input);
    },
    async sendToSubleader(w, text) {
      ports.adapter.agentPrompt(w.name, text);
    },
    async stageMerge({ baseRepo, branches }) {
      const { execFileSync } = await import("node:child_process");
      const { mkdtempSync } = await import("node:fs");
      const { tmpdir } = await import("node:os");
      const { join } = await import("node:path");
      const staging = mkdtempSync(join(tmpdir(), "agentdev-stage-"));
      const branch = `agentdev-stage-${Date.now().toString(36)}`;
      execFileSync("git", ["-C", baseRepo, "worktree", "add", staging, "-b", branch], { stdio: "ignore", timeout: 60_000 });
      for (const b of branches) {
        try {
          execFileSync("git", ["-C", staging, "merge", "--no-ff", "-m", `merge ${b}`, b], { stdio: "ignore", timeout: 60_000 });
        } catch (e) {
          throw new Error(`stage merge of ${b} failed (stories overlap?): ${(e as Error).message.slice(0, 200)}`);
        }
      }
      return staging;
    },
    verifyStory(worktree) {
      return verifyWork(worktree);
    },
    async sliceContext(worktree, lens) {
      // REVIEW CONTEXT = the merged staging / worker worktree: tracked diff
      // PLUS untracked files (new code must be visible to reviewers).
      const dir = worktree || process.cwd();
      try {
        const stat = await execCollect("git", ["-C", dir, "diff", "HEAD", "--stat", "--", ".", ":(exclude).agentdev"], {
          timeoutMs: 15_000,
        });
        const body = await execCollect("git", ["-C", dir, "diff", "HEAD", "--", ".", ":(exclude).agentdev"], {
          timeoutMs: 15_000,
        });
        let untracked = "";
        try {
          const status = await execCollect("git", ["-C", dir, "status", "--porcelain", "--untracked-files=all"], {
            timeoutMs: 15_000,
          });
          const files = status.stdout
            .split("\n")
            .filter((l) => l.startsWith("?? "))
            .map((l) => l.slice(3).trim())
            .filter((f) => !f.includes(".agentdev"));
          let budget = 8000;
          for (const f of files.slice(0, 10)) {
            const r = await execCollect("cat", [f], { cwd: dir, timeoutMs: 10_000 });
            const chunk = r.stdout.slice(0, 2000);
            untracked += `\n# --- untracked: ${f} ---\n${chunk}`;
            budget -= chunk.length;
            if (budget <= 0) break;
          }
        } catch {
          /* no untracked scan available */
        }
        return `# worktree: ${dir}\n# git diff --stat (HEAD)\n${stat.stdout.slice(0, 2000)}\n# diff (bounded)\n${body.stdout.slice(0, 9000)}${untracked}\n# lens: ${lens}`;
      } catch {
        return `# (no git diff available in ${dir}) lens: ${lens}`;
      }
    },
    async confirmCommit(goalId, summary) {
      ui.notify(`agentdev: ${goalId} is commit-ready — ${summary}. Confirm with /agentdev confirm ${goalId}`, "info");
      return new Promise<boolean>((resolve) => {
        pending = { goalId, resolve };
      });
    },
    async manualInput(goal, facts) {
      // map-codebase already ran: DETECTED stack → locked; no detection
      // (empty repo / greenfield) → the operator chooses (AC-MANUAL-1/2).
      let stack = facts.stack;
      if (!stack) {
        const sel = resolveStackSelection(null);
        if (sel.kind === "choose") {
          const pick = await ui.select(
            "Choose a stack",
            sel.candidates.map((o) => ({ value: o.id, label: o.name })),
          );
          stack = pick;
        }
      }
      // define-constraints interview (AC-MANUAL-4/5: soft-gate, option-driven)
      const interview = createInterview();
      const candidates = generateCandidates({
        stack,
        scope: goal,
        existingRepo: facts.existingRepo,
        riskSignals: [],
      });
      for (const cat of candidates) {
        const picked = await ui.select(
          `define-constraints: ${cat.category} (select items, or none)`,
          [
            { value: "none", label: "none" },
            ...cat.items.map((i) => ({ value: i.id, label: i.text })),
          ],
        );
        interview.answer(cat.category, picked === "none" ? "none" : [picked]);
      }
      // pick a project mode (AC-MANUAL-7)
      const modePick = await ui.select("Project mode", PROJECT_MODES.map((m) => ({ value: m, label: m })));
      const mode = (PROJECT_MODES as readonly string[]).includes(modePick) ? (modePick as ProjectMode) : "direct-PR";
      const answers = interview.answers() as ManualAnswers["constraints"];
      return { constraints: answers, mode, stack: stack ?? undefined };
    },
    notify(message, level) {
      ui.notify(message, level ?? "info");
    },
  };
  return ports;
}

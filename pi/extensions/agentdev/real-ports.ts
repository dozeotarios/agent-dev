/**
 * real-ports (ARCHITECTURE.md §8/§9, AC-REAL-2) — production effect ports for
 * the orchestrator: real `pi -p` agents for consensus/review/build, real git
 * for verification/context, and the operator (via the extension UI) for the
 * manual interview + commit confirmation. Tests inject recorded fakes; these
 * are the REAL agents.
 */

import { spawnSync } from "node:child_process";
import { execFileSync } from "node:child_process";
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

/** Ask a REAL pi agent (headless `pi -p`). */
export function askPi(prompt: string, timeoutMs = 300_000, piBin = "pi"): string {
  const r = spawnSync(piBin, ["-p", frameUntrusted(prompt)], {
    encoding: "utf8",
    timeout: timeoutMs,
  });
  if (r.status !== 0) {
    throw new Error(`pi agent call failed (${r.status}): ${(r.stderr ?? "").slice(0, 300)}`);
  }
  return r.stdout.trim();
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

  return {
    adapter: undefined as never, // filled by the extension (single herdr touchpoint)
    ask(prompt, timeoutMs) {
      return askPi(prompt, timeoutMs ?? 300_000, piBin);
    },
    buildStory(ctx) {
      const prompt = builderPrompt(ctx.goalId, ctx.storyId, ctx.criteria);
      const r = spawnSync(piBin, ["-p", frameUntrusted(prompt)], {
        cwd: ctx.worktree,
        encoding: "utf8",
        timeout: 600_000,
      });
      if (r.status !== 0) {
        throw new Error(`subworker agent failed (${r.status}): ${(r.stderr ?? "").slice(0, 300)}`);
      }
      const out = r.stdout.trim();
      if (/STORY_BLOCKED/.test(out)) {
        throw new Error(`subworker blocked: ${out.slice(0, 300)}`);
      }
    },
    verifyStory(worktree) {
      return verifyWork(worktree);
    },
    sliceContext(_worktree, lens) {
      // goal-level context: recent git diff + worktree file listing
      try {
        const diff = execFileSync("git", ["diff", "HEAD", "--stat", "--", ".", ":(exclude).agentdev"], {
          encoding: "utf8",
          timeout: 15_000,
        });
        return `# git diff --stat (HEAD)\n${diff.slice(0, 4000)}\n# lens: ${lens}`;
      } catch {
        return `# (no git diff available) lens: ${lens}`;
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
}

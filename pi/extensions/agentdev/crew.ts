/**
 * agentdev-crew (AC-CREW-1..5) — spawn and supervise REAL crew members,
 * modeled on firstmate (github.com/kunchenguid/firstmate): every Subworker
 * and the Subleader get their own herdr pane hosting a live pi session, a
 * brief submitted as their first message, on-disk report files, and
 * fail-closed teardown. The leader's orchestrator supervises by polling
 * report files + herdr agent state — never by blocking child processes.
 *
 * Naming: agentdev-* (Subleader → `S:`, Subworker → `W:`, roles from
 * roles.ts). Worktrees come from the orchestrator's pool (firstmate uses
 * treehouse; agentdev uses its own worktree pool).
 */

import { readFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { BackendAdapter } from "./backend-adapter";
import type { BuildContext } from "./orchestrator";

export type CrewOutcome = "done" | "blocked" | "timeout" | "dead";

export interface CrewWorker {
  goalId: string;
  storyId: string;
  worktree: string;
  /** herdr pane hosting the live pi session. */
  paneId: string;
  workspaceId: string;
  /** agent name in herdr (unique per worker). */
  name: string;
  /** Absolute path the worker writes its report to when finished. */
  reportPath: string;
}

export interface CrewBriefInput {
  goalText: string;
  storyId: string;
  criteria: string[];
  stack: string | null;
  mode: string;
  worktree: string;
  reportPath: string;
  /** Granular touch map from the plan (AC-PLAN-FILES) — binding scope. */
  filePlan?: { structure: string; create: string[]; modify: string[]; doNotTouch: string[] };
  /** THIS story's own disjoint files (AC-PLAN-STORIES) — the worker's exact scope. */
  storyFiles?: { create: string[]; modify: string[]; doNotTouch: string[] };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * herdr agent names: 1-32 chars, lowercase letters/digits/'-'/'_', must start
 * with a lowercase letter. Story-derived names need sanitizing (AC-CREW-2).
 */
export function sanitizeAgentName(prefix: string, id: string): string {
  const base = `${prefix}-${id}`
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  let name = base.slice(0, 32) || prefix.slice(0, 32);
  if (!/^[a-z]/.test(name)) name = `w${name}`.slice(0, 32);
  return name;
}

function readFileSafe(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/**
 * The worker's brief (agentdev-build): the intake contract firstmate-style —
 * goal, story, acceptance criteria, boundaries, and the REPORT contract.
 */
export function crewBrief(input: CrewBriefInput): string {
  return `You are a Subworker in the agentdev crew (skill: agentdev-build). Work in the CURRENT directory — a git worktree of the project.

GOAL: ${input.goalText}
YOUR STORY: ${input.storyId}
STACK: ${input.stack ?? "(auto)"}  MODE: ${input.mode}

ACCEPTANCE CRITERIA for your slice (your contract — every one must be verifiable):
${input.criteria.map((c) => `- ${c}`).join("\n")}

TOUCH PLAN (SCOPE BOUNDARY — binding, from the approved plan):
YOUR STORY'S FILES (yours alone — parallel workers never touch these):
${input.storyFiles
    ? `create ONLY: ${input.storyFiles.create.join(", ") || "(none)"}
modify ONLY: ${input.storyFiles.modify.join(", ") || "(none)"}
do NOT touch (even other stories' files): ${input.storyFiles.doNotTouch.join(", ") || "(nothing restricted)"}`
    : "(no per-story file map — stay inside your worktree and your story)"}
GLOBAL boundaries: ${input.filePlan
    ? `structure: ${input.filePlan.structure}
do NOT touch: ${input.filePlan.doNotTouch.join(", ") || "(nothing restricted)"}`
    : "(none)"}

RULES (binding):
- Follow agentdev-build: write the failing test FIRST, then implement until green (red-green-refactor, vertical slices). Tests must be F.I.R.S.T.
- Run the project's test suite yourself until it is fully green.
- Do NOT commit. Do NOT touch files outside this worktree.
- You are supervised by the Subleader — work autonomously; do not ask questions.

WHEN DONE: write your report to ${input.reportPath} with EXACTLY this shape:
STORY_DONE
<2-3 lines: what you built + how the tests were run and verified>
(or, if genuinely blocked: STORY_BLOCKED: <reason>)

Then reply in chat with exactly one line: STORY_DONE — or STORY_BLOCKED: <reason>.`;
}

export function parseWorkerReport(text: string): { outcome: CrewOutcome; summary: string } {
  const first = text.trim().split("\n")[0] ?? "";
  if (/^STORY_DONE/.test(first)) return { outcome: "done", summary: text.trim() };
  if (/^STORY_BLOCKED/.test(first)) return { outcome: "blocked", summary: text.trim() };
  return { outcome: "blocked", summary: text.trim().slice(0, 300) }; // no contract → blocked
}

/** Raw report content (or "" when absent) — used for failure diagnostics. */
export function readWorkerReport(path: string): string {
  return readFileSafe(path) ?? "";
}

/** Spawn a Subworker: herdr workspace at the worktree → pi → brief. */
export function spawnWorker(
  adapter: BackendAdapter,
  ctx: BuildContext,
  opts: { cwd: string },
): CrewWorker {
  const ref = adapter.workspaceCreate({ cwd: ctx.worktree, label: `W: ${ctx.storyId}` });
  const name = sanitizeAgentName("worker", ctx.storyId);
  adapter.agentStart(name, "pi", ref.paneId);
  // report lives in the goal's dir under the MAIN checkout — the worker
  // writes it there (absolute path), never into the repo's git tree
  const reportPath = join(
    opts.cwd,
    ".agentdev",
    "goals",
    ctx.goalId,
    "reports",
    `${ctx.storyId}.md`,
  );
  mkdirSync(dirname(reportPath), { recursive: true, mode: 0o700 }); // worker needs a target
  adapter.agentPrompt(
    name,
    crewBrief({
      goalText: ctx.goalText ?? "(goal text unavailable)",
      storyId: ctx.storyId,
      criteria: ctx.criteria,
      stack: ctx.stack ?? null,
      mode: ctx.mode ?? "direct-PR",
      worktree: ctx.worktree,
      reportPath,
      filePlan: ctx.filePlan,
      storyFiles: ctx.storyFiles,
    }),
  );
  return {
    goalId: ctx.goalId,
    storyId: ctx.storyId,
    worktree: ctx.worktree,
    paneId: ref.paneId,
    workspaceId: ref.workspaceId,
    name,
    reportPath,
  };
}

/**
 * Supervise a worker to completion. NON-BLOCKING: sleeps between polls; each
 * poll is a cheap fs read + a short herdr pane-get. The worker's report file
 * is the contract; herdr agent state is corroboration.
 */
export async function waitForWorker(
  adapter: BackendAdapter,
  w: CrewWorker,
  timeoutMs = 1_800_000,
): Promise<CrewOutcome> {
  const deadline = Date.now() + timeoutMs;
  // herdr agent states can flap transiently (detection resets, turn boundaries):
  // only a SUSTAINED done (2 consecutive polls) without a report counts as blocked
  let doneStreak = 0;
  while (Date.now() < deadline) {
    const report = readFileSafe(w.reportPath);
    if (report) return parseWorkerReport(report).outcome;
    try {
      const info = adapter.paneGet(w.paneId);
      if (info.agentStatus === "done") {
        doneStreak += 1;
        if (doneStreak >= 2) {
          await sleep(2_000);
          const again = readFileSafe(w.reportPath);
          if (again) return parseWorkerReport(again).outcome;
          return "blocked"; // settled twice without delivering the report contract
        }
      } else {
        doneStreak = 0; // still working / unknown — keep supervising
      }
    } catch {
      return "dead"; // pane/agent gone mid-work
    }
    await sleep(10_000);
  }
  return "timeout";
}

/**
 * Fail-closed teardown: close the worker's workspace+pane ONLY when the work
 * landed (green). Failed/blocked/timed-out workers stay open for inspection
 * (the fleet reflects it; the operator handles them).
 */
export function teardownWorker(adapter: BackendAdapter, w: CrewWorker, keepOpen = false): void {
  if (keepOpen) return;
  try {
    adapter.workspaceClose(w.workspaceId);
  } catch {
    /* pane already gone */
  }
}

/** Spawn the Subleader: one pane hosting the plan + the crew's reports. */
export function spawnSubleader(
  adapter: BackendAdapter,
  input: { goalId: string; goalText: string; plan: string; workers: string[] },
): CrewWorker {
  const ref = adapter.workspaceCreate({ cwd: process.cwd(), label: `S: ${input.goalId}` });
  const name = sanitizeAgentName("subleader", input.goalId);
  adapter.agentStart(name, "pi", ref.paneId);
  adapter.agentPrompt(
    ref.paneId,
    `You are the Subleader of the agentdev crew (skill: agentdev-build/verify/review). The Leader handed you this plan — supervise it:\n\nGOAL: ${input.goalText}\nPLAN:\n${input.plan.slice(0, 6000)}\n\nWORKERS (one per story, each in its own worktree):\n${input.workers.join("\n")}\n\nYou coordinate, not code. The crew reports land here. Reply with exactly one line: SUBLEADER_READY.`,
  );
  return {
    goalId: input.goalId,
    storyId: "plan",
    worktree: process.cwd(),
    paneId: ref.paneId,
    workspaceId: ref.workspaceId,
    name,
    reportPath: "",
  };
}

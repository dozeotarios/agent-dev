/**
 * orchestrator (ARCHITECTURE.md §20, AC-DOD-1) — the Leader dispatch loop:
 * goal → manual phase → ralplan consensus → dispatch → build → verify →
 * 6-lens review → commit gate → confirmed commits → autoclose.
 *
 * Deterministic state machine with INJECTED effect ports; everything is
 * persisted per-goal under <cwd>/.agentdev/goals/<goalId>/ so a crash is
 * survivable: restart → resumeAll() reconciles real herdr panes and
 * continues from the persisted step (AC-RESIL-1).
 *
 * Ports (createRealPorts in real-ports.ts for production; tests inject
 * recorded fakes — AC-REAL-2 "real or recorded agents").
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BackendAdapter } from "./backend-adapter";
import { detectCodebase } from "./map-codebase";
import { extractGlossary } from "./define-language";
import { createInterview, type ConstraintCategory } from "./define-constraints";
import { createConsensusLoop, isHighRisk, validatePlanOutput, type PlanOutput } from "./ralplan";
import { PLANNER_JSON_SCHEMA, FILE_PLAN_INSPECT, RALPLAN_REVISION_HINT } from "./agent-prompts";
import { planToStories, dispatchPlan, completeWorker, type WorkerAssignment } from "./dispatch";
import { createWorktreePool, pruneStaleLeases, type WorktreeLeases } from "./worktree";
import { createReviewLoop, constraintsToChecklist, routeToWorkers, LENSES, type Finding } from "./review";
import { createCommitGate, type CommitGate, type GateState } from "./git-gate";
import { performCommit } from "./perform-commit";
import { installCommitHook } from "./hook-commits";
import { createEscalationPolicy, createEscalationTracker } from "./escalation";
import { autocloseDecision } from "./autoclose";
import { createFleet, type Fleet, type FleetNode } from "./fleet";
import { roleLabel } from "./roles";
import { saveFleet, loadFleet, reconcileFleet } from "./state";
import type { VerifyResult } from "./verify-work";
import type { CrewWorker, CrewOutcome } from "./crew";
import { collectGitState, parseBranch, parsePorcelain, type WorktreeGitState } from "./git-state";
import { requiresConfirm, type ProjectMode } from "./modes";
import type { ReviewConstraints } from "./review";

export type CrewStep =
  | "manual"
  | "consensus"
  | "dispatch"
  | "build"
  | "review"
  | "gate"
  | "commit"
  | "done"
  | "failed";

export interface ManualAnswers {
  constraints: Partial<Record<ConstraintCategory, string[] | "none">>;
  mode: ProjectMode;
  stack?: string;
}

export interface BuildContext {
  goalId: string;
  storyId: string;
  worktree: string;
  criteria: string[];
  /** Brief context (crew briefs embed them; absent in legacy callers). */
  goalText?: string;
  stack?: string | null;
  mode?: string;
  /** Granular touch map from the plan — workers build exactly this. */
  filePlan?: import("./ralplan").FilePlan;
  /** This story's OWN disjoint file set (AC-PLAN-STORIES). */
  storyFiles?: import("./ralplan").PlanStoryFiles;
}

export interface ReviewRoundInput {
  lens: string;
  codeContext: string;
  checklist: string[];
  storyIds: string[];
}

export interface OrchestratorPorts {
  adapter: BackendAdapter;
  /** Real: `pi -p`; tests: recorded transcripts. May be async (real ports) so
   *  the pi session stays interactive while the crew runs. */
  ask(prompt: string, timeoutMs?: number): string | Promise<string>;
  /**
   * CREW PORTS (firstmate-style spawning): Subleader + Subworkers are real
   * herdr panes hosting live pi sessions, briefed from disk/chat and
   * supervised by report files + herdr agent state.
   */
  spawnWorker(ctx: BuildContext): CrewWorker | Promise<CrewWorker>;
  waitForWorker(w: CrewWorker, opts?: { timeoutMs?: number }): CrewOutcome | Promise<CrewOutcome>;
  /** keepOpen=true leaves the pane up for inspection (fail-closed teardown). */
  teardownWorker(w: CrewWorker, keepOpen?: boolean): void | Promise<void>;
  spawnSubleader(input: {
    goalId: string;
    goalText: string;
    plan: string;
    workers: string[];
  }): CrewWorker | Promise<CrewWorker>;
  sendToSubleader(w: CrewWorker, text: string): void | Promise<void>;
  /** Merge every worker branch into a fresh staging worktree (AC-BUILD-INT). */
  stageMerge(input: { baseRepo: string; branches: string[] }): string | Promise<string>;
  /** Real: pi Subworker agent in the worktree; tests: recorded/fixture. */
  buildStory(ctx: BuildContext): void | Promise<void>;
  /** Real: `npm test` in the worktree; tests: fake. */
  verifyStory(worktree: string): VerifyResult | Promise<VerifyResult>;
  /** Code context for a review lens (real: diff/scan; tests: fixture). */
  sliceContext(worktree: string, lens: string): string | Promise<string>;
  /** Operator confirmation for the commit gate (real: /agentdev confirm). */
  confirmCommit(goalId: string, summary: string): boolean | Promise<boolean>;
  /** Operator interview for define-constraints + mode (real: interactive). */
  manualInput(goal: string, facts: { existingRepo: boolean; stack: string | null }): ManualAnswers | Promise<ManualAnswers>;
  notify(message: string, level?: "info" | "warning" | "error"): void;
}

export interface GoalRun {
  goalId: string;
  goalText: string;
  step: CrewStep;
  approved: boolean;
  plan: PlanOutput | null;
  workers: WorkerAssignment[];
  gate: GateState | null;
  errors: string[];
  progress: string;
}

interface PersistedGoal {
  goalId: string;
  goalText: string;
  step: CrewStep;
  approved: boolean;
  plan: PlanOutput | null;
  stack: string | null;
  existingRepo: boolean;
  constraints: ReviewConstraints;
  mode: ProjectMode;
  storyCriteria: Record<string, string[]>;
  /** Per-story disjoint file sets from the plan split (AC-PLAN-STORIES). */
  storyFiles: Record<string, import("./ralplan").PlanStoryFiles>;
  /** Integration staging worktree (all stories merged, verified, reviewed). */
  stagingWorktree: string | null;
  gate: GateState | null;
}

export interface Orchestrator {
  start(goalText: string): Promise<GoalRun>;
  resume(goalId: string): Promise<GoalRun>;
  resumeAll(): Promise<GoalRun[]>;
  confirm(goalId: string, ok: boolean): void;
  /** Leader handoff: the interactive turn's plan + researched stack. */
  acceptLeaderPlan(goalId: string, plan: PlanOutput | null, stack?: string | null): void;
  /** Leader handoff without an id (index.ts agent_end → latest live goal). */
  acceptLeaderPlanForLatest(plan: PlanOutput | null, stack?: string | null): void;
  status(goalId: string): GoalRun | null;
  all(): GoalRun[];
}

const goalDir = (cwd: string, goalId: string): string => join(cwd, ".agentdev", "goals", goalId);
const stateFile = (dir: string): string => join(dir, "goal.json");
const fleetFile = (dir: string): string => join(dir, "fleet.json");
const gateFile = (dir: string): string => join(dir, "gate.json");

function writeJson(path: string, data: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(data, null, 2), { encoding: "utf8", mode: 0o600 });
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

export function createOrchestrator(
  ports: OrchestratorPorts,
  opts: {
    cwd: string;
    maxWorktrees?: number;
    baseRepo?: string;
    /** Injectable worktree creator (tests use tmp dirs; prod uses real git). */
    createWorktree?: (baseRepo: string, index: number) => string;
    /** Injectable git runner for performCommit (tests); defaults to real git. */
    git?: import("./perform-commit").GitRunner;
    /**
     * Leader-planning mode (prod wiring): the pipeline waits for the
     * interactive turn's plan (acceptLeaderPlan) before dispatch. When
     * false (tests), consensus planning runs directly.
     */
    waitForLeaderPlan?: boolean;
    /** How long to wait for the leader's plan before falling back to consensus. */
    leaderPlanTimeoutMs?: number;
  } = {
    cwd: process.cwd(),
    maxWorktrees: 4,
  },
): Orchestrator {
  const cwd = opts.cwd;
  const maxWorktrees = opts.maxWorktrees ?? 4;
  const baseRepo = opts.baseRepo ?? cwd;
  const createWorktree = opts.createWorktree ?? createRealWorktree;
  const waitForLeaderPlan = opts.waitForLeaderPlan ?? false;
  const leaderPlanTimeoutMs = opts.leaderPlanTimeoutMs ?? 480_000;
  const gitRunner = opts.git;
  const tracker = createEscalationTracker(createEscalationPolicy({ maxRetries: 3, maxReviewRounds: 5 }));
  const runs = new Map<string, GoalRun>();
  /** Live Subleader workers (for report delivery on resume-less runs). */
  const subleaders = new Map<string, CrewWorker>();
  /** Goals started this session (live leader turns can hand plans to them). */
  const liveGoals = new Set<string>();
  /** Leader handoff payload: plan + researched stack (AC-LEADER-1). */
  interface LeaderHandoff {
    plan: PlanOutput | null;
    stack: string | null;
  }
  /** Pending leader-plan waits, keyed by goalId (AC-LEADER-1 handoff). */
  const leaderWaiters = new Map<string, { resolve: (h: LeaderHandoff) => void; timer: NodeJS.Timeout }>();
  /** Handoff that arrived before its waiter registered (races) — consumed next. */
  let bufferedHandoff: LeaderHandoff | null = null;

  const loadPersisted = (goalId: string): PersistedGoal | null =>
    readJson<PersistedGoal>(stateFile(goalDir(cwd, goalId)));

  const toRun = (p: PersistedGoal): GoalRun => {
    const gate: GateState | null = p.gate ?? readJson<GateState>(gateFile(goalDir(cwd, p.goalId)));
    return {
      goalId: p.goalId,
      goalText: p.goalText,
      step: p.step,
      approved: p.approved,
      plan: p.plan,
      workers: [],
      gate,
      errors: [],
      progress: `step=${p.step}`,
    };
  };

  const persist = (p: PersistedGoal, fleet?: FleetNode[]): void => {
    writeJson(stateFile(goalDir(cwd, p.goalId)), p);
    if (fleet) saveFleet(goalDir(cwd, p.goalId), fleet);
    if (p.gate) writeJson(gateFile(goalDir(cwd, p.goalId)), p.gate);
  };

  const fleet = (goalId: string): Fleet => {
    const f = createFleet();
    const loaded = loadFleet(goalDir(cwd, goalId));
    if (!loaded.corrupt) for (const n of loaded.nodes) f.addNode(n);
    return f;
  };

  async function runPipeline(p: PersistedGoal): Promise<GoalRun> {
    const run = toRun(p);
    runs.set(p.goalId, run);
    try {
      await stepManual(p);
      await stepConsensus(p);
      await stepDispatch(p);
      await stepBuild(p);
      await stepReview(p);
      await stepGate(p);
      await stepCommit(p);
      await stepAutoclose(p);
      p.step = "done";
      persist(p);
      run.step = "done";
      ports.notify(`agentdev: goal ${p.goalId} complete — commit-ready (${p.mode}).`);
    } catch (e) {
      p.step = "failed";
      persist(p);
      run.step = "failed";
      run.errors.push(e instanceof Error ? e.message : String(e));
      ports.notify(`agentdev: goal ${p.goalId} failed — ${run.errors[run.errors.length - 1]}`, "error");
    }
    // refresh the snapshot from persisted state (approved/plan/gate advance)
    const fresh = toRun(p);
    fresh.errors = run.errors;
    runs.set(p.goalId, fresh);
    fresh.progress = `step=${p.step}`;
    return fresh;
  }

  // ---- steps ----

  async function stepManual(p: PersistedGoal): Promise<void> {
    if (p.step !== "manual") return;
    const facts = detectCodebase(cwd);
    p.existingRepo = facts.existingRepo;
    p.stack = facts.stack;
    const answers = await ports.manualInput(p.goalText, facts);
    if (answers.stack) p.stack = answers.stack; // the operator's choice (AC-MANUAL-2)
    p.mode = answers.mode;
    // constraints → reviewer checklist shape (AC-MANUAL-6 → AC-REVIEW-5)
    const cats = answers.constraints;
    p.constraints = {
      failureModes: cats.failure_modes === "none" ? [] : (cats.failure_modes ?? []),
      edgeCases: cats.edge_cases === "none" ? [] : (cats.edge_cases ?? []),
      invariants: cats.invariants === "none" ? [] : (cats.invariants ?? []),
      mustNots: cats.dont === "none" ? [] : (cats.dont ?? []),
    };
    // glossary (AC-MANUAL-3) — deterministic extraction; real port may enrich
    const glossary = extractGlossary(p.goalText, [
      ...p.constraints.failureModes,
      ...p.constraints.mustNots,
    ]);
    if (glossary.length > 0) {
      ports.notify(`agentdev: glossary ${glossary.map((g) => g.term).join(", ")}`);
    }
    const constraintCount =
      p.constraints.failureModes.length +
      p.constraints.edgeCases.length +
      p.constraints.invariants.length +
      p.constraints.mustNots.length;
    ports.notify(
      `agentdev: manual done — stack=${p.stack ?? "?"} mode=${p.mode} constraints=${constraintCount}`,
    );
    p.step = "consensus";
    persist(p);
  }

  async function stepConsensus(p: PersistedGoal): Promise<void> {
    if (p.step !== "consensus") return;
    const deliberate = isHighRisk(p.goalText, []);
    // Leader handoff (AC-LEADER-1): in prod wiring the interactive turn IS the
    // planning step. Accept its plan and skip the headless consensus loop;
    // timeout or unparseable output falls back to consensus.
    if (waitForLeaderPlan && liveGoals.has(p.goalId)) {
      const handoff = await new Promise<LeaderHandoff>((resolve) => {
        const buffered = bufferedHandoff;
        if (buffered) {
          bufferedHandoff = null;
          resolve(buffered);
          return;
        }
        const timer = setTimeout(() => {
          leaderWaiters.delete(p.goalId);
          resolve({ plan: null, stack: null });
        }, leaderPlanTimeoutMs);
        leaderWaiters.set(p.goalId, { resolve, timer });
      });
      const leaderPlan = handoff.plan;
      // researched stack (choose-stack research path) applies even when the
      // plan fails validation — consensus then plans with the real stack
      if (p.stack === "research" && handoff.stack) {
        p.stack = handoff.stack;
        ports.notify(`agentdev: researched stack → ${p.stack}`);
        persist(p);
      }
      if (leaderPlan && validatePlanOutput(leaderPlan, { deliberate }).ok) {
        p.plan = leaderPlan;
        p.approved = true;
        p.step = "dispatch";
        persist(p);
        ports.notify(`agentdev: leader plan approved (${p.goalId}) — handing off to subleader`);
        return;
      }
      ports.notify(
        leaderPlan
          ? `agentdev: leader plan failed validation — running consensus planning`
          : `agentdev: no leader plan (timeout) — running consensus planning`,
        "warning",
      );
    }
    const loop = createConsensusLoop();
    let planOutput: PlanOutput | null = null;
    // per-role review history (closed loop: every role's feedback reaches the
    // next planner revision AND the critic sees the architect/developer reviews)
    const critiques: string[] = [];
    const developerReviews: string[] = [];
    const architectReviews: string[] = [];
    let guard = 0;
    while (loop.state().expectedRole !== null && guard < 25) {
      const role = loop.state().expectedRole;
      if (role === null) break;
      const planCtx = planOutput ? JSON.stringify(planOutput).slice(0, 1500) : "(none)";
      const goalLine =
        role === "planner" && critiques.length === 0
          ? `Goal: "${p.goalText}"${p.stack ? ` (stack: ${p.stack})` : ""}. `
          : "";
      const hint =
        role === "planner" && critiques.length > 0
          ? RALPLAN_REVISION_HINT([
              ...(architectReviews.length > 0 ? [{ role: "architect", content: architectReviews[architectReviews.length - 1]! }] : []),
              ...(developerReviews.length > 0 ? [{ role: "developer", content: developerReviews[developerReviews.length - 1]! }] : []),
              { role: "critic", content: critiques[critiques.length - 1]! },
            ])
          : role === "critic" && critiques.length > 0
            ? `\nCurrent plan: ${planCtx}\nArchitect review:\n${architectReviews[architectReviews.length - 1] ?? "(none)"}\nDeveloper review:\n${developerReviews[developerReviews.length - 1] ?? "(none)"}\nYour previous critique was:\n${critiques[critiques.length - 1]}\nVerify EVERY point you raised is addressed. APPROVE only if all are addressed and no new blocking issues.`
            : role !== "planner"
              ? `\nCurrent plan: ${planCtx}`
              : "";
      let out = await ports.ask(
        role === "planner"
          ? `You are the Planner in a consensus-planning loop. ${goalLine}Emit ONLY JSON: ${PLANNER_JSON_SCHEMA}. No prose. ${FILE_PLAN_INSPECT}${hint}`
          : role === "architect"
            ? `You are the Architect in a consensus-planning loop (oh-my-claudecode style). Review the plan for architectural soundness. NEVER rubber-stamp the favored direction: give the strongest steelman ANTITHESIS, at least one real TRADEOFF TENSION, and a SYNTHESIS when feasible. Reply: "SOUND" or "NEEDS WORK" first line, then ANTITHESIS:/TRADEOFF:/SYNTHESIS: lines (concrete, short).${hint}`
            : role === "developer"
              ? `You are the Developer in a consensus-planning loop. Review the plan for PRACTICAL FEASIBILITY, EFFICIENCY (smallest plan that satisfies the criteria — no gold-plating, no over-engineering) and RELIABILITY (error handling, edge cases, failure modes covered). Reply: "FEASIBLE" or "RISKY" first line, then EFFICIENCY:/RELIABILITY:/RISK: lines (concrete, short).${hint}`
              : `You are the Critic — the final quality gate in a consensus-planning loop. A false approval costs 10-100x a false rejection; a false rejection wastes a round. Evaluate testable criteria, concrete verification, granular filePlan (vague paths are BLOCKING), and GAP ANALYSIS (what is MISSING). SELF-AUDIT: drop low-confidence findings. Concrete fix per blocking finding. Reply with EXACTLY one of "APPROVE", "ITERATE", "REJECT" and 1-3 short findings with fixes.${hint}`,
      );
      if (role === "planner") {
        planOutput = parsePlanOutput(out);
        if (!planOutput) {
          out = await ports.ask(
            `You are the Planner in a consensus-planning loop. Goal: "${p.goalText}"${p.stack ? ` (stack: ${p.stack})` : ""}. Emit ONLY JSON: ${PLANNER_JSON_SCHEMA}. No prose. ${FILE_PLAN_INSPECT}`,
          );
          planOutput = parsePlanOutput(out);
        }
        loop.submit({ role, content: out });
      } else if (role === "critic") {
        critiques.push(out);
        loop.submit({ role, content: out, verdict: criticVerdict(out) });
      } else if (role === "architect") {
        architectReviews.push(out);
        loop.submit({ role, content: out });
      } else if (role === "developer") {
        developerReviews.push(out);
        loop.submit({ role, content: out });
      } else {
        loop.submit({ role, content: out });
      }
      guard += 1;
    }
    const s = loop.state();
    if (!s.approved) {
      throw new Error(
        `consensus did not approve (${s.roundsUsed} rounds; best=${s.bestPlan ? "presented" : "none"}) — escalate`,
      );
    }
    const parsed = JSON.parse(s.bestPlan!) as PlanOutput;
    if (!validatePlanOutput(parsed, { deliberate }).ok) {
      throw new Error("approved plan failed output validation");
    }
    p.plan = parsed;
    p.approved = true;
    p.step = "dispatch";
    persist(p);
  }

  async function stepDispatch(p: PersistedGoal): Promise<void> {
    if (p.step !== "dispatch") return;
    if (!p.plan) throw new Error("dispatch requires an approved plan");
    // STORY SPLIT (AC-PLAN-STORIES): the plan defines the split — worker
    // count = stories.length, each story with its own DISJOINT files (parallel
    // workers never overlap). Fallback: deterministic criteria slicing.
    const split = p.plan.stories && p.plan.stories.length > 0 ? p.plan.stories : null;
    const stories = split
      ? split.map((st) => ({ storyId: st.id }))
      : planToStories(p.plan, Math.max(1, Math.ceil(p.plan.acceptanceCriteria.length / maxWorktrees)));
    const leases: WorktreeLeases = readJson(worktreeLeasesFile(cwd, p.goalId)) ?? { free: [], used: [] };
    const pool = createWorktreePool({
      maxSize: maxWorktrees,
      create: () => createWorktree(baseRepo, Math.floor(Math.random() * 1e6)),
      persist: {
        load: () => leases,
        save: (l) => writeJson(worktreeLeasesFile(cwd, p.goalId), l),
      },
    });
    const result = dispatchPlan({ planId: p.goalId, stories }, pool);
    p.storyCriteria = {};
    p.storyFiles = {};
    for (const w of result.workers) {
      if (split) {
        const st = split.find((x) => x.id === w.storyId);
        p.storyCriteria[w.storyId] = st?.criteria ?? [];
        if (st?.files) p.storyFiles[w.storyId] = st.files;
      } else {
        p.storyCriteria[w.storyId] = storiesFor(stories, w.storyId, p.plan);
      }
    }
    installCommitHook(baseRepo); // AC-GIT-4 hook-commits
    // fleet nodes for every role (AC-VIS-1): panes are created per worker
    const f = fleet(p.goalId);
    if (f.nodes().length === 0) {
      f.addNode({ id: `${p.goalId}:leader`, role: "leader", path: p.goalId, status: "idle", paneId: null });
      f.addNode({ id: `${p.goalId}:subleader`, role: "subleader", path: `${p.goalId}/plan`, status: "working", paneId: null });
      for (const w of result.workers) {
        f.addNode({ id: w.storyId, role: "subworker", path: `${p.goalId}/plan/${w.storyId}`, status: "working", paneId: null });
      }
      // SPAWN THE SUBLEADER (firstmate-style): a real pane hosting the plan.
      try {
        const sub = await ports.spawnSubleader({
          goalId: p.goalId,
          goalText: p.goalText,
          plan: p.plan ? JSON.stringify(p.plan, null, 2) : "(none)",
          workers: result.workers.map((w, i) => {
            const lease = leases.used[i] ?? "?";
            return `${w.storyId} → worktree ${lease}`;
          }),
        });
        subleaders.set(p.goalId, sub);
        f.setPaneId(`${p.goalId}:subleader`, sub.paneId);
      } catch (e) {
        ports.notify(
          `agentdev: subleader spawn failed (${e instanceof Error ? e.message : String(e)}) — running without pane`,
          "warning",
        );
      }
    }
    persist(p, f.nodes());
    p.step = "build";
    persist(p);
  }

  async function stepBuild(p: PersistedGoal): Promise<void> {
    if (p.step !== "build") return;
    const f = fleet(p.goalId);
    const workers = loadWorkers(cwd, p);
    // 1) BUILD phase — each story worker spawns in its own worktree (disjoint
    //    files), works, and delivers its report. No per-worktree suite run:
    //    story tests legitimately need sibling stories' files.
    for (const w of workers) {
      const worker = await ports.spawnWorker({
        goalId: p.goalId,
        storyId: w.storyId,
        worktree: w.worktreePath,
        criteria: p.storyCriteria[w.storyId] ?? [],
        goalText: p.goalText,
        stack: p.stack,
        mode: p.mode,
        filePlan: p.plan?.filePlan,
        storyFiles: p.storyFiles[w.storyId],
      });
      try {
        f.setPaneId(w.storyId, worker.paneId); // fleet node id == storyId
      } catch {
        /* node may not exist in resumed runs */
      }
      const outcome = await ports.waitForWorker(worker);
      if (outcome !== "done") {
        ports.notify(
          `agentdev: ${w.storyId} worker ${outcome} — pane left open for inspection`,
          "warning",
        );
        throw new Error(`subworker ${w.storyId} ${outcome}`);
      }
      await ports.teardownWorker(worker); // delivered → close the pane
      try {
        f.setStatus(w.storyId, "done");
      } catch {
        /* node may not exist in resumed runs */
      }
      persist(p, f.nodes());
    }
    // 2) INTEGRATION — stage-merge every worker branch into a fresh worktree
    //    and run the FULL suite there. A merge conflict means the story split
    //    was NOT disjoint → fail loudly (AC-PLAN-STORIES enforcement).
    const branches = workers.map((w) => currentBranchOf(w.worktreePath)).filter((b): b is string => !!b);
    let staging = await ports.stageMerge({ baseRepo, branches });
    let attempt = 1;
    for (;;) {
      const v: VerifyResult = await ports.verifyStory(staging);
      if (v.ok) break;
      const d = tracker.handle({ branchId: "integration", kind: "build-failure", attempt });
      if (d.escalate) {
        throw new Error(`integration verify failed (retries exhausted): ${v.output.slice(0, 300)}`);
      }
      attempt += 1;
      ports.notify(`agentdev: integration verify failed — fix worker ${attempt - 1}/${3}`, "warning");
      // spawn a FIX worker in the staging worktree with the failure output
      const union = new Set<string>();
      for (const st of Object.values(p.storyFiles)) {
        for (const f of [...st.create, ...st.modify]) union.add(f);
      }
      const fix = await ports.spawnWorker({
        goalId: p.goalId,
        storyId: "integration-fix",
        worktree: staging,
        criteria: [`make the merged suite green`],
        goalText: p.goalText,
        stack: p.stack,
        mode: p.mode,
        filePlan: p.plan?.filePlan,
      });
      const fixOutcome = await ports.waitForWorker(fix);
      if (fixOutcome !== "done") {
        ports.notify(`agentdev: fix worker ${fixOutcome} — pane left open`, "warning");
        throw new Error(`integration fix worker ${fixOutcome}`);
      }
      await ports.teardownWorker(fix);
    }
    p.stagingWorktree = staging;
    p.step = "review";
    persist(p);
  }

  async function stepReview(p: PersistedGoal): Promise<void> {
    if (p.step !== "review") return;
    const checklist = constraintsToChecklist(p.constraints);
    const loop = createReviewLoop(5);
    const reviewWorktree = p.stagingWorktree ?? cwd;
    let round = 1;
    while (!loop.isComplete() && round <= 6) {
      const findings: Finding[] = [];
      for (const lens of LENSES) {
        // review the REAL code: the merged staging worktree diff
        const ctx = await ports.sliceContext(reviewWorktree, lens);
        const scope = p.plan?.filePlan
          ? `\n\nTOUCH-PLAN (SCOPE BOUNDARY — binding):\nstructure: ${p.plan.filePlan.structure}\ncreate: ${p.plan.filePlan.create.join(", ")}\nmodify: ${p.plan.filePlan.modify.join(", ")}\ndoNotTouch: ${p.plan.filePlan.doNotTouch.join(", ")}\nAny work touching files outside this map is a BLOCKING scope violation.`
          : "";
        const out = await ports.ask(
          `You are the ${lens} reviewer in a code review (agentdev-review). Validate the code against this operator-defined checklist:\n${(checklist[lens] ?? []).map((c) => `- ${c}`).join("\n")}\n\nFind BLOCKING issues. Reply with findings, one per line, each starting with exactly "BLOCKING: " or "NIT: ":\n\n${ctx.slice(0, 12_000)}${scope}`,
        );
        for (const line of out.split("\n")) {
          const t = line.trim();
          if (/^BLOCKING:/i.test(t)) findings.push({ lens, severity: "blocking", text: t, storyId: null });
          else if (/^NIT:/i.test(t)) findings.push({ lens, severity: "nit", text: t, storyId: null });
        }
      }
      const result = loop.submitRound(findings, checklist);
      if (result.status === "rework" && result.blocking.length > 0) {
        // route to workers and rebuild (AC-REVIEW-3) — bounded by the loop
        ports.notify(`agentdev: review round ${round} — ${result.blocking.length} blocking findings, reworking`, "warning");
      }
      round += 1;
    }
    if (!loop.isComplete()) throw new Error("review loop did not terminate");
    // fail-closed: blocking findings that survived the rework budget BLOCK the
    // goal — never commit code the reviewers still flag
    const remaining = loop.remainingBlocking();
    if (remaining.length > 0) {
      throw new Error(
        `review did not converge — ${remaining.length} blocking finding(s) remain: ${remaining
          .map((f) => f.text.slice(0, 120))
          .join(" | ")}`,
      );
    }
    // Subleader → Leader report (AC-LEADER-2): a factual brief of what the
    // crew built and verified, surfaced in the interactive session AND sent
    // into the Subleader's pane (visible hierarchy).
    const workers = loadWorkers(cwd, p);
    const report = `SUBLEADER REPORT (${p.goalId}) — ${workers.length} story${workers.length === 1 ? "" : "s"} built & verified; review clean after ${round - 1} round${round - 1 === 1 ? "" : "s"}; commit-ready at the gate — /agentdev confirm ${p.goalId}`;
    ports.notify(`agentdev: ${report}`);
    const sub = subleaders.get(p.goalId);
    if (sub) {
      try {
        await ports.sendToSubleader(sub, report);
      } catch {
        /* pane closed — report already surfaced in the session */
      }
    }
    p.step = "gate";
    persist(p);
  }

  async function stepGate(p: PersistedGoal): Promise<void> {
    if (p.step !== "gate") return;
    const gate = createCommitGate(p.mode, {
      load: () => readJson<GateState>(gateFile(goalDir(cwd, p.goalId))),
      save: (s) => writeJson(gateFile(goalDir(cwd, p.goalId)), s),
    });
    gate.markCommitReady();
    p.gate = gate.state();
    persist(p);
    if (requiresConfirm(p.mode)) {
      const ok = await ports.confirmCommit(p.goalId, `commit-ready: ${Object.keys(p.storyCriteria).length} story commits`);
      if (!ok) throw new Error("operator rejected the commit-ready gate");
      gate.confirm();
    }
    p.gate = gate.state();
    persist(p);
    p.step = "commit";
    persist(p);
  }

  async function stepCommit(p: PersistedGoal): Promise<void> {
    if (p.step !== "commit") return;
    const gate = createCommitGate(p.mode, {
      load: () => readJson<GateState>(gateFile(goalDir(cwd, p.goalId))),
      save: (s) => writeJson(gateFile(goalDir(cwd, p.goalId)), s),
    });
    const workers = loadWorkers(cwd, p);
    const target = p.stagingWorktree;
    if (target) {
      const r = performCommit(gate, target, `feat: ${p.goalText.slice(0, 60)}`, {
        ...(gitRunner ? { git: gitRunner } : {}),
      });
      ports.notify(`agentdev: committed staging → ${r.hash ?? "skipped"}`);
    } else {
      // legacy resume path: per-worktree commits
      for (const w of workers) {
        const r = performCommit(gate, w.worktreePath, `feat(${w.storyId}): ${p.goalText.slice(0, 60)}`, {
          ...(gitRunner ? { git: gitRunner } : {}),
        });
        ports.notify(`agentdev: committed ${w.storyId} → ${r.hash ?? "skipped"}`);
      }
    }
    // durable git-state map (AC-GIT-3): branches.json per goal
    const worktrees: WorktreeGitState[] = workers.map((w) => ({
      path: w.worktreePath,
      branch: currentBranchOf(w.worktreePath),
      uncommitted: parsePorcelain(porcelainOf(w.worktreePath)),
    }));
    writeJson(join(goalDir(cwd, p.goalId), "branches.json"), collectGitState(worktrees));
    p.gate = gate.state();
    persist(p);
    p.step = "done";
    persist(p);
  }

  async function stepAutoclose(p: PersistedGoal): Promise<void> {
    // AC-CLOSE-1/2: done workers close their panes; the fleet reflects it.
    const f = fleet(p.goalId);
    for (const n of f.nodes()) {
      const d = autocloseDecision({ role: n.role, status: n.status, handled: true, unattendedMs: 0 });
      if (d === "close" && n.paneId) {
        try {
          ports.adapter.paneClose(n.paneId);
        } catch {
          /* pane already gone */
        }
        f.removeNode(n.id);
      }
    }
    persist(p, f.nodes());
  }

  // ---- public API ----

  return {
    async start(goalText: string): Promise<GoalRun> {
      if (!goalText.trim()) throw new Error("goal must be non-empty");
      const goalId = `goal-${Date.now().toString(36)}`;
      const p: PersistedGoal = {
        goalId,
        goalText: goalText.trim(),
        step: "manual",
        approved: false,
        plan: null,
        stack: null,
        existingRepo: false,
        constraints: { failureModes: [], edgeCases: [], invariants: [], mustNots: [] },
        mode: "direct-PR",
        storyCriteria: {},
        storyFiles: {},
        stagingWorktree: null,
        gate: null,
      };
      liveGoals.add(goalId); // the interactive leader turn will hand its plan
      persist(p, []);
      return runPipeline(p);
    },

    acceptLeaderPlan(goalId: string, plan: PlanOutput | null, stack: string | null = null): void {
      const waiter = leaderWaiters.get(goalId);
      if (!waiter) return; // no wait (consensus already running / not waiting)
      clearTimeout(waiter.timer);
      leaderWaiters.delete(goalId);
      waiter.resolve({ plan, stack });
    },

    acceptLeaderPlanForLatest(plan: PlanOutput | null, stack: string | null = null): void {
      const entries = [...leaderWaiters.entries()];
      if (entries.length === 0) {
        bufferedHandoff = { plan, stack }; // consumed by the next waiter (race)
        return;
      }
      const [goalId, waiter] = entries[entries.length - 1]; // serial turns → latest
      clearTimeout(waiter.timer);
      leaderWaiters.delete(goalId);
      waiter.resolve({ plan, stack });
    },

    async resume(goalId: string): Promise<GoalRun> {
      const p = loadPersisted(goalId);
      if (!p) throw new Error(`unknown goal: ${goalId}`);
      // restart reconciliation (AC-RESIL-1): panes still alive reconnect
      const saved = loadFleet(goalDir(cwd, goalId));
      if (!saved.corrupt) {
        const live = new Set(ports.adapter.paneList().map((x) => x.paneId));
        const { orphans } = reconcileFleet(saved.nodes, live);
        if (orphans.length > 0) {
          ports.notify(`agentdev: ${orphans.length} orphaned node(s) surfaced on restart`, "warning");
        }
      }
      // reconcile worktree leases against the real repo
      const leases = readJson<WorktreeLeases>(worktreeLeasesFile(cwd, goalId));
      if (leases) {
        const liveWt = new Set(realWorktreePaths(baseRepo));
        writeJson(worktreeLeasesFile(cwd, goalId), pruneStaleLeases(leases, liveWt));
      }
      return runPipeline(p);
    },

    async resumeAll(): Promise<GoalRun[]> {
      const dir = join(cwd, ".agentdev", "goals");
      if (!existsSync(dir)) return [];
      const ids = readdirSafe(dir).filter((d) => readJson<PersistedGoal>(stateFile(join(dir, d))));
      const out: GoalRun[] = [];
      for (const id of ids) out.push(await this.resume(id));
      return out;
    },

    confirm(goalId: string, ok: boolean): void {
      // The gate's confirmCommit port is wired to this in real-ports.
      const run = runs.get(goalId);
      if (!run) throw new Error(`no active goal: ${goalId}`);
      run.progress = `confirm=${ok ? "accepted" : "rejected"}`;
    },

    status(goalId: string): GoalRun | null {
      return runs.get(goalId) ?? (loadPersisted(goalId) ? toRun(loadPersisted(goalId)!) : null);
    },

    all(): GoalRun[] {
      const dir = join(cwd, ".agentdev", "goals");
      if (!existsSync(dir)) return [...runs.values()];
      return readdirSafe(dir)
        .map((d) => readJson<PersistedGoal>(stateFile(join(dir, d))))
        .filter((p): p is PersistedGoal => p !== null)
        .map(toRun);
    },
  };
}

// ---- helpers (deterministic + injected) ----

function parsePlanOutput(json: string): PlanOutput | null {
  try {
    const j = JSON.parse(json);
    if (!j.adr || !j.acceptanceCriteria) return null;
    return {
      adr: {
        decision: String(j.adr.decision ?? ""),
        drivers: Array.isArray(j.adr.drivers) ? j.adr.drivers.map(String) : [],
        alternatives: Array.isArray(j.adr.alternatives) ? j.adr.alternatives.map(String) : [],
        why: String(j.adr.why ?? ""),
        consequences: Array.isArray(j.adr.consequences) ? j.adr.consequences.map(String) : [],
        followups: Array.isArray(j.adr.followups) ? j.adr.followups.map(String) : [],
      },
      acceptanceCriteria: Array.isArray(j.acceptanceCriteria) ? j.acceptanceCriteria.map(String) : [],
      filePlan: j.filePlan
        ? {
            structure: String(j.filePlan.structure ?? ""),
            create: Array.isArray(j.filePlan.create) ? j.filePlan.create.map(String) : [],
            modify: Array.isArray(j.filePlan.modify) ? j.filePlan.modify.map(String) : [],
            doNotTouch: Array.isArray(j.filePlan.doNotTouch) ? j.filePlan.doNotTouch.map(String) : [],
          }
        : { structure: "", create: [], modify: [], doNotTouch: [] },
      stories: Array.isArray(j.stories)
        ? j.stories
            .filter((st: unknown) => !!st && typeof st === "object")
            .map((st: unknown) => {
              const s2 = st as Record<string, unknown>;
              const files = (s2.files ?? {}) as Record<string, unknown>;
              return {
                id: String(s2.id ?? ""),
                criteria: Array.isArray(s2.criteria) ? s2.criteria.map(String) : [],
                files: {
                  create: Array.isArray(files.create) ? (files.create as unknown[]).map(String) : [],
                  modify: Array.isArray(files.modify) ? (files.modify as unknown[]).map(String) : [],
                  doNotTouch: Array.isArray(files.doNotTouch) ? (files.doNotTouch as unknown[]).map(String) : [],
                },
              };
            })
        : undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Parse the leader's interactive turn output into a plan. Lenient: accepts
 * a ```json fence, a bare JSON object, or a JSON block embedded in prose.
 * Returns null when no plan-shaped JSON is found (→ consensus fallback).
 */
export function parseLeaderPlanOutput(text: string): PlanOutput | null {
  if (!text) return null;
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidates = [fence ? fence[1] : null, text].filter((c): c is string => c !== null);
  for (const c of candidates) {
    const trimmed = c.trim();
    const direct = parsePlanOutput(trimmed);
    if (direct) return direct;
    const s = trimmed.indexOf("{");
    const e = trimmed.lastIndexOf("}");
    if (s >= 0 && e > s) {
      const slice = parsePlanOutput(trimmed.slice(s, e + 1));
      if (slice) return slice;
    }
  }
  return null;
}

/**
 * Extract the researched stack the leader picked (choose-stack research
 * path): matches a `STACK: <id>` line or a "stack" key in the plan JSON.
 */
export function parseLeaderStack(text: string): string | null {
  if (!text) return null;
  const line = text.match(/STACK:\s*([a-zA-Z0-9_-]+)/i);
  if (line) return line[1]!.toLowerCase();
  const key = text.match(/"stack"\s*:\s*"([^"]+)"/i);
  if (key) return key[1]!.toLowerCase();
  return null;
}

function criticVerdict(text: string): "approve" | "iterate" | "reject" {
  if (/APPROVE/.test(text)) return "approve";
  if (/REJECT/.test(text)) return "reject";
  return "iterate";
}

function storiesFor(stories: { storyId: string }[], storyId: string, plan: PlanOutput): string[] {
  const idx = stories.findIndex((s) => s.storyId === storyId);
  const per = Math.ceil(plan.acceptanceCriteria.length / Math.max(1, stories.length));
  return plan.acceptanceCriteria.slice(idx * per, idx * per + per);
}

function loadWorkers(cwd: string, p: PersistedGoal): WorkerAssignment[] {
  const leases = readJson<WorktreeLeases>(worktreeLeasesFile(cwd, p.goalId)) ?? { free: [], used: [] };
  // persisted workers = used leases at dispatch time; rebuild from storyCriteria keys
  return Object.keys(p.storyCriteria).map((storyId) => ({
    role: "subworker" as const,
    storyId,
    worktreePath: leases.used[Object.keys(p.storyCriteria).indexOf(storyId)] ?? "",
  }));
}

function worktreeLeasesFile(cwd: string, goalId: string): string {
  return join(cwd, ".agentdev", "goals", goalId, "worktrees.json");
}

function createRealWorktree(baseRepo: string, index: number): string {
  const p = join(tmpdir(), `agentdev-wt-${Date.now()}-${index}`);
  mkdirSync(p, { recursive: true });
  execFileSync("git", ["-C", baseRepo, "worktree", "add", p, "-b", `agentdev-${index}`], {
    stdio: "ignore",
    timeout: 60_000,
  });
  return p;
}

function realWorktreePaths(baseRepo: string): string[] {
  try {
    const out = execFileSync("git", ["-C", baseRepo, "worktree", "list", "--porcelain"], {
      encoding: "utf8",
      timeout: 15_000,
    });
    return out
      .split("\n")
      .filter((l) => l.startsWith("worktree "))
      .map((l) => l.slice("worktree ".length).trim());
  } catch {
    return [];
  }
}

function currentBranchOf(worktree: string): string | null {
  try {
    return parseBranch(
      execFileSync("git", ["branch", "--show-current"], { cwd: worktree, encoding: "utf8", timeout: 15_000 }),
    );
  } catch {
    return null;
  }
}

function porcelainOf(worktree: string): string {
  try {
    return execFileSync("git", ["status", "--porcelain"], { cwd: worktree, encoding: "utf8", timeout: 15_000 });
  } catch {
    return "";
  }
}

function readdirSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

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
import { verifyWork, type VerifyResult } from "./verify-work";
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
}

export interface ReviewRoundInput {
  lens: string;
  codeContext: string;
  checklist: string[];
  storyIds: string[];
}

export interface OrchestratorPorts {
  adapter: BackendAdapter;
  /** Real: `pi -p`; tests: recorded transcripts. */
  ask(prompt: string, timeoutMs?: number): string;
  /** Real: pi Subworker agent in the worktree; tests: recorded/fixture. */
  buildStory(ctx: BuildContext): void;
  /** Real: `npm test` in the worktree; tests: fake. */
  verifyStory(worktree: string): VerifyResult;
  /** Code context for a review lens (real: diff/scan; tests: fixture). */
  sliceContext(worktree: string, lens: string): string;
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
  gate: GateState | null;
}

export interface Orchestrator {
  start(goalText: string): Promise<GoalRun>;
  resume(goalId: string): Promise<GoalRun>;
  resumeAll(): Promise<GoalRun[]>;
  confirm(goalId: string, ok: boolean): void;
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
  } = {
    cwd: process.cwd(),
    maxWorktrees: 4,
  },
): Orchestrator {
  const cwd = opts.cwd;
  const maxWorktrees = opts.maxWorktrees ?? 4;
  const baseRepo = opts.baseRepo ?? cwd;
  const createWorktree = opts.createWorktree ?? createRealWorktree;
  const gitRunner = opts.git;
  const tracker = createEscalationTracker(createEscalationPolicy({ maxRetries: 3, maxReviewRounds: 5 }));
  const runs = new Map<string, GoalRun>();

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
    p.step = "consensus";
    persist(p);
  }

  async function stepConsensus(p: PersistedGoal): Promise<void> {
    if (p.step !== "consensus") return;
    const deliberate = isHighRisk(p.goalText, []);
    const loop = createConsensusLoop();
    let planOutput: PlanOutput | null = null;
    let lastCritique = "";
    const critiques: string[] = [];
    let guard = 0;
    while (loop.state().expectedRole !== null && guard < 25) {
      const role = loop.state().expectedRole;
      if (role === null) break;
      const goalLine =
        role === "planner" && !lastCritique
          ? `Goal: "${p.goalText}"${p.stack ? ` (stack: ${p.stack})` : ""}. `
          : "";
      const hint =
        role === "planner" && lastCritique
          ? `\nThe previous plan was NOT approved. Critic review (address EVERY point):\n${lastCritique}\nRevise the plan accordingly. Keep the JSON schema identical.`
          : role === "critic" && critiques.length > 0
            ? `\nCurrent plan: ${planOutput ? JSON.stringify(planOutput).slice(0, 1500) : "(none)"}\nYour previous critique was:\n${critiques[critiques.length - 1]}\nVerify EVERY point you raised is addressed. APPROVE only if all are addressed and no new blocking issues.`
            : role !== "planner"
              ? `\nCurrent plan: ${planOutput ? JSON.stringify(planOutput).slice(0, 1500) : "(none)"}`
              : "";
      let out = ports.ask(
        role === "planner"
          ? `You are the Planner in a consensus-planning loop. ${goalLine}Emit ONLY JSON: { "principles": [3-5 strings], "drivers": [exactly 3 strings], "options": [{"name","pros":[...],"cons":[...]} x >=2], "adr": { "decision", "drivers":[...], "alternatives":[...], "why", "consequences":[...], "followups":[...] }, "acceptanceCriteria": [>=3 testable strings] }. No prose.${hint}`
          : role === "architect"
            ? `You are the Architect in a consensus-planning loop. Review the current plan for architectural soundness. Reply with ONE line: "SOUND" or "NEEDS WORK" plus one tradeoff you considered.${hint}`
            : role === "senior-dev"
              ? `You are the Senior Dev in a consensus-planning loop. Review the current plan for practical feasibility, idioms, and effort. Reply with ONE line: "FEASIBLE" or "RISKY" plus the main risk.${hint}`
              : `You are the Critic in a consensus-planning loop. The plan must have testable acceptance criteria and concrete verification. Reply with EXACTLY one of "APPROVE", "ITERATE", "REJECT" and 1-3 short findings.${hint}`,
      );
      if (role === "planner") {
        planOutput = parsePlanOutput(out);
        if (!planOutput) {
          out = ports.ask(
            `You are the Planner in a consensus-planning loop. Goal: "${p.goalText}"${p.stack ? ` (stack: ${p.stack})` : ""}. Emit ONLY JSON: { "principles": [3-5 strings], "drivers": [exactly 3 strings], "options": [{"name","pros":[...],"cons":[...]} x >=2], "adr": { "decision", "drivers":[...], "alternatives":[...], "why", "consequences":[...], "followups":[...] }, "acceptanceCriteria": [>=3 testable strings] }. No prose.`,
          );
          planOutput = parsePlanOutput(out);
        }
        loop.submit({ role, content: out });
      } else if (role === "critic") {
        lastCritique = out;
        critiques.push(out);
        loop.submit({ role, content: out, verdict: criticVerdict(out) });
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
    const stories = planToStories(p.plan);
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
    for (const w of result.workers) {
      p.storyCriteria[w.storyId] = storiesFor(stories, w.storyId, p.plan);
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
    }
    persist(p, f.nodes());
    p.step = "build";
    persist(p);
  }

  async function stepBuild(p: PersistedGoal): Promise<void> {
    if (p.step !== "build") return;
    const f = fleet(p.goalId);
    const workers = loadWorkers(cwd, p);
    for (const w of workers) {
      let attempt = 1;
      // self-heal flaky builds, escalate after budget (AC-ESCAL-1/2)
      for (;;) {
        ports.buildStory({ goalId: p.goalId, storyId: w.storyId, worktree: w.worktreePath, criteria: p.storyCriteria[w.storyId] ?? [] });
        const v: VerifyResult = ports.verifyStory(w.worktreePath);
        if (v.ok) break;
        const d = tracker.handle({ branchId: w.storyId, kind: "build-failure", attempt });
        if (!d.escalate) {
          attempt += 1;
          ports.notify(`agentdev: ${w.storyId} build failed — retry ${attempt - 1}/${3}`, "warning");
          continue;
        }
        throw new Error(`build failed for ${w.storyId} (retries exhausted): ${v.output.slice(0, 300)}`);
      }
      try {
        f.setStatus(w.storyId, "done");
      } catch {
        /* node may not exist in resumed runs */
      }
      persist(p, f.nodes());
    }
    p.step = "review";
    persist(p);
  }

  async function stepReview(p: PersistedGoal): Promise<void> {
    if (p.step !== "review") return;
    const checklist = constraintsToChecklist(p.constraints);
    const loop = createReviewLoop(5);
    let round = 1;
    while (!loop.isComplete() && round <= 6) {
      const findings: Finding[] = [];
      for (const lens of LENSES) {
        const ctx = ports.sliceContext("", lens); // orchestrator-level context
        const out = ports.ask(
          `You are the ${lens} reviewer in a code review. Validate the code against this operator-defined checklist:\n${(checklist[lens] ?? []).map((c) => `- ${c}`).join("\n")}\n\nFind BLOCKING issues. Reply with findings, one per line, each starting with exactly "BLOCKING: " or "NIT: ":\n\n${ctx.slice(0, 12_000)}`,
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
    for (const w of workers) {
      const r = performCommit(gate, w.worktreePath, `feat(${w.storyId}): ${p.goalText.slice(0, 60)}`, {
        ...(gitRunner ? { git: gitRunner } : {}),
      });
      ports.notify(`agentdev: committed ${w.storyId} → ${r.hash ?? "skipped"}`);
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
        gate: null,
      };
      persist(p, []);
      return runPipeline(p);
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
    };
  } catch {
    return null;
  }
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

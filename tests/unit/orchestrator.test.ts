import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOrchestrator, type OrchestratorPorts } from "../../pi/extensions/agentdev/orchestrator";
import { detectCodebase } from "../../pi/extensions/agentdev/map-codebase";
import { extractGlossary } from "../../pi/extensions/agentdev/define-language";
import { planToStories } from "../../pi/extensions/agentdev/dispatch";
import { verifyWork } from "../../pi/extensions/agentdev/verify-work";
import { performCommit } from "../../pi/extensions/agentdev/perform-commit";
import { createCommitGate } from "../../pi/extensions/agentdev/git-gate";
import { installCommitHook, hasCommitHook, PRE_COMMIT_HOOK } from "../../pi/extensions/agentdev/hook-commits";
import type { PlanOutput } from "../../pi/extensions/agentdev/ralplan";

const PLAN: PlanOutput = {
  adr: {
    decision: "typescript CLI",
    drivers: ["portable", "fast"],
    alternatives: ["go"],
    why: "smallest fit",
    consequences: ["node dep"],
    followups: ["benchmark startup time"],
  },
  acceptanceCriteria: [
    "given 'todo add x' when run then the item is stored",
    "given no args when run then usage text is shown",
    "given 1000 items when listed then all are shown",
  ],
};

const APPROVED_PLAN_JSON = JSON.stringify(PLAN);

function fakePorts(overrides: Partial<OrchestratorPorts> = {}): OrchestratorPorts {
  const asks: string[] = [];
  return {
    adapter: {
      paneList: () => [],
      paneClose: () => undefined,
    } as unknown as OrchestratorPorts["adapter"],
    ask(prompt) {
      asks.push(prompt);
      if (/Planner in a consensus-planning loop/.test(prompt)) return APPROVED_PLAN_JSON;
      if (/Architect/.test(prompt)) return "SOUND — tradeoff considered";
      if (/Senior Dev/.test(prompt)) return "FEASIBLE";
      if (/Critic in a consensus-planning loop/.test(prompt)) return "APPROVE";
      if (/reviewer in a code review/.test(prompt)) return "NIT: style only";
      return "STORY_DONE";
    },
    buildStory() {
      /* recorded agent: no-op */
    },
    verifyStory: () => ({ ok: true, output: "ok", command: "npm test" }),
    sliceContext: () => "// fixture code context",
    confirmCommit: () => true,
    manualInput: (goal, facts) => ({
      constraints: { do: ["input_validation"], dont: ["no_hardcoded_secrets"], failure_modes: ["disk_full"], edge_cases: ["empty_input"], invariants: ["data_integrity"] },
      mode: "direct-PR",
      stack: facts.stack ?? "typescript",
    }),
    notify: () => undefined,
    ...overrides,
  };
}

describe("map-codebase (AC-MANUAL-1)", () => {
  it("detects existing repos and locks the stack", () => {
    const facts = detectCodebase("/repo", (p) =>
      p.endsWith(join(".git")) || p.endsWith(join("package.json")),
    );
    expect(facts.existingRepo).toBe(true);
    expect(facts.stack).toBe("typescript");
  });

  it("greenfield: no repo, no stack", () => {
    const facts = detectCodebase("/empty", () => false);
    expect(facts.existingRepo).toBe(false);
    expect(facts.stack).toBeNull();
  });
});

describe("define-language (AC-MANUAL-3)", () => {
  it("extracts a deterministic glossary from the goal", () => {
    const glossary = extractGlossary("Build a REST API for Task Tracking with auth");
    const terms = glossary.map((g) => g.term);
    expect(terms).toContain("REST");
    expect(terms).toContain("Task");
    expect(terms.length).toBeLessThanOrEqual(8);
  });
});

describe("planToStories (ralplan → dispatch bridge)", () => {
  it("slices acceptance criteria into deterministic stories", () => {
    const stories = planToStories(PLAN);
    expect(stories.length).toBeGreaterThanOrEqual(2);
    expect(stories.every((s) => s.storyId.startsWith("story-"))).toBe(true);
  });

  it("throws on a plan with no criteria", () => {
    expect(() => planToStories({ ...PLAN, acceptanceCriteria: [] })).toThrow(/criteria/);
  });
});

describe("verify-work (AC-VERIFY-1)", () => {
  it("returns ok=false with output on a failing command", () => {
    const r = verifyWork(tmpdir(), ["node", "-e", "process.exit(1)"]);
    expect(r.ok).toBe(false);
    expect(r.output.length).toBeGreaterThan(0);
  });

  it("returns ok=true on success", () => {
    const r = verifyWork(tmpdir(), ["node", "-e", "console.log('hi')"]);
    expect(r.ok).toBe(true);
  });
});

describe("hook-commits (AC-GIT-4)", () => {
  it("installs a pre-commit hook refusing protected refs", () => {
    const repo = mkdtempSync(join(tmpdir(), "agentdev-hook-"));
    // fake .git dir
    const { mkdirSync, writeFileSync } = require("node:fs") as typeof import("node:fs");
    mkdirSync(join(repo, ".git", "hooks"), { recursive: true });
    writeFileSync(join(repo, ".git", "HEAD"), "ref: refs/heads/main");
    const hook = installCommitHook(repo);
    expect(hook.endsWith("pre-commit")).toBe(true);
    expect(hasCommitHook(repo)).toBe(true);
    expect(PRE_COMMIT_HOOK).toContain("main");
    expect(PRE_COMMIT_HOOK).toContain("refusing direct commit");
    rmSync(repo, { recursive: true, force: true });
  });
});

describe("perform-commit (AC-GIT-1/2/5/8)", () => {
  it("refuses when the gate is not committed", () => {
    const gate = createCommitGate("direct-PR");
    expect(() => performCommit(gate, tmpdir(), "msg")).toThrow(/not committed/);
  });

  it("skips when the hash is already recorded (crash-retry dedup)", () => {
    const gate = createCommitGate("+yolo");
    gate.markCommitReady();
    gate.recordCommit("/wt/a", "abc123");
    const r = performCommit(gate, "/wt/a", "msg");
    expect(r.skipped).toBe(true);
    expect(r.hash).toBe("abc123");
  });
});

describe("orchestrator (AC-DOD-1): full pipeline with recorded agents", () => {
  const fakeWorktree = (_base: string, i: number) => {
    const { mkdtempSync } = require("node:fs") as typeof import("node:fs");
    return mkdtempSync(join(tmpdir(), `agentdev-fakewt-${i}-`));
  };
  // fake git: non-protected branch, no-op add/commit, deterministic hash
  const fakeGit: import("../../pi/extensions/agentdev/perform-commit").GitRunner = (args) => {
    if (args[0] === "branch") return "feature/x\n";
    if (args[0] === "rev-parse") return "abc123\n";
    return "";
  };

  it("runs goal → manual → consensus → dispatch → build → review → gate → commit → done", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "agentdev-orch-"));
    const orch = createOrchestrator(fakePorts(), { cwd, createWorktree: fakeWorktree, git: fakeGit });
    const run = await orch.start("build a small CLI todo app");
    expect(run.step).toBe("done");
    expect(run.approved).toBe(true);
    expect(run.plan?.adr.decision).toBe("typescript CLI");
    expect(run.errors).toEqual([]);
    rmSync(cwd, { recursive: true, force: true });
  });

  it("the chosen stack reaches the Planner prompt (AC-MANUAL-2 → consensus)", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "agentdev-orch-stack-"));
    const asks: string[] = [];
    const base = fakePorts();
    const orch = createOrchestrator(
      {
        ...base,
        ask(prompt) {
          asks.push(prompt);
          return base.ask(prompt);
        },
      },
      { cwd, createWorktree: fakeWorktree, git: fakeGit },
    );
    await orch.start("build a CSV tool");
    const plannerPrompt = asks.find((p) => /Planner in a consensus-planning loop/.test(p));
    expect(plannerPrompt).toBeDefined();
    expect(plannerPrompt!).toContain("stack: typescript"); // manualInput chose typescript
    rmSync(cwd, { recursive: true, force: true });
  });

  it("persists per-goal state and resumes from a crash mid-pipeline", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "agentdev-orch-resume-"));
    const orch = createOrchestrator(fakePorts(), { cwd, createWorktree: fakeWorktree });
    await orch.start("resume me");
    // restart: fresh orchestrator instance reads the same goal dir
    const orch2 = createOrchestrator(fakePorts(), { cwd, createWorktree: fakeWorktree, git: fakeGit });
    const all = orch2.all();
    expect(all.length).toBe(1);
    const resumed = await orch2.resume(all[0].goalId);
    expect(resumed.step).toBe("done");
    expect(resumed.approved).toBe(true);
    rmSync(cwd, { recursive: true, force: true });
  });

  it("escalates when consensus never approves (reject-only critic)", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "agentdev-orch-reject-"));
    const orch = createOrchestrator(
      fakePorts({
        ask(prompt) {
          if (/Planner/.test(prompt)) return APPROVED_PLAN_JSON;
          if (/Architect/.test(prompt)) return "SOUND";
          if (/Senior Dev/.test(prompt)) return "FEASIBLE";
          if (/Critic/.test(prompt)) return "REJECT";
          return "";
        },
      }),
      { cwd, createWorktree: fakeWorktree },
    );
    const run = await orch.start("risky goal");
    expect(run.step).toBe("failed");
    expect(run.errors.join(" ")).toMatch(/consensus did not approve/);
    rmSync(cwd, { recursive: true, force: true });
  });

  it("stops at commit-ready and commits only after operator confirm", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "agentdev-orch-confirm-"));
    let confirmed = false;
    const orch = createOrchestrator(
      fakePorts({
        confirmCommit: () => {
          confirmed = true;
          return true;
        },
        buildStory({ worktree }) {
          const { writeFileSync } = require("node:fs") as typeof import("node:fs");
          writeFileSync(join(worktree, "feature.txt"), "implemented");
        },
        verifyStory: () => ({ ok: true, output: "ok", command: "npm test" }),
      }),
      { cwd, createWorktree: fakeWorktree, git: fakeGit },
    );
    const run = await orch.start("commit me");
    expect(run.step).toBe("done");
    expect(confirmed).toBe(true);
    rmSync(cwd, { recursive: true, force: true });
  });
});

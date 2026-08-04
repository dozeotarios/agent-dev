import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { parseToggleArg, createToggleState, type ToggleState } from "./toggle";
import { createGoalRegistry, type GoalRegistry } from "./goals";
import { createOrchestrator, parseLeaderPlanOutput, parseLeaderStack, projectsBoard } from "./orchestrator";
import { createRealPorts, askPi } from "./real-ports";
import { reconcileCrewPanes } from "./crew";
import { createHerdrAdapter } from "./backend-adapter";
import { detectCodebase } from "./map-codebase";
import { resolveStackSelection } from "./choose-stack";
import { createInterview, generateCandidates, CATEGORY_ORDER, type CategoryCandidates } from "./define-constraints";

/**
 * agentdev — the brain (pi extension).
 *
 * Spec: AC-TOGGLE-1..6, AC-DOD-1.
 * - `/agentdev on|off` (session-scoped; reset on session switch — AC-TOGGLE-3).
 * - Every message while ON is a goal: captured on `before_agent_start` and
 *   handed to the orchestrator (goal → manual → ralplan → dispatch → build →
 *   review → commit gate → confirmed commits). Multi-goal: per-goal state
 *   under .agentdev/goals/<id>/ (AC-TOGGLE-6).
 * - `/agentdev status` lists goals; `/agentdev confirm <goal>` answers the
 *   commit gate; `/agentdev resume` reconciles panes + resumes after restart.
 * - Tools are registered so the Leader can observe the crew (AC-TOGGLE-1).
 * - The agentdev-* methodology skills ship with the package and are
 *   discovered via the pi manifest ("pi.skills") — NO resources_discover
 *   hook: cwd-relative skill paths made the repo's copy load as project
 *   scope and collide with the installed package's user-scope copy.
 */


/**
 * Leader-planning prompt (AC-LEADER-1): with the crew ON, the interactive
 * turn IS the Leader. It plans; the plan JSON is captured on agent_end and
 * handed to the Subleader, whose workers build/verify/review and report back.
 * needsResearch = the operator chose the web-research stack path;
 * techniquesResearch = the operator wants up-to-date technique research.
 */
const LEADER_PLAN_PROMPT = (manual: string, needsResearch: boolean): string => {
  const research = needsResearch
    ? `\nSTACK RESEARCH REQUIRED — the operator asked you to research the BEST LANGUAGE FOR THIS USE CASE on the web.
You MUST use web_search at least once (not generic "top languages" lists): evaluate performance, domain fit,
ecosystem, deploy target, and maintainability FOR THIS SPECIFIC GOAL. The best fit may be Rust, C++, C#,
Java, Go, Python, TypeScript, or anything else — pick what the use case actually needs.
After the plan JSON block, emit one more line: STACK: <id> with your researched pick (e.g. STACK: cplusplus,
STACK: rust, STACK: csharp — lowercase).`
    : `\nTECHNIQUES RESEARCH (ALWAYS ON) — check the web for the MOST UP-TO-DATE techniques, libraries, and
best practices for this goal (current library versions, API changes, modern idioms). Bounded: at most 3
searches; skip only if the domain is provably stable. Fold what you find into principles/options/ADR.`;
  const tools =
    needsResearch
      ? "You MAY use web_search for the stack research. "
      : "You MUST use web_search for the techniques research (bounded 3). ";
  return `You are the Leader of an agent crew. The user's message is a GOAL for your crew to build.

Manual phase (agentdev-map-codebase / agentdev-choose-stack / agentdev-define-language / agentdev-define-constraints) is done:
${manual}${research}

Your job is PLANNING (agentdev-plan). Think the goal through, then emit the plan as ONE JSON object inside a single \`\`\`json code block — nothing else outside the block.

REPORT YOUR SEARCH VISIBLY FIRST: before the JSON block, write 2-4 lines starting with "RESEARCH:" — what you searched, which tool/source, and the 1-2 key findings that shaped the plan (e.g. current library versions, API changes, language fit evidence). The operator watches this to confirm the web research actually happened. If you skipped research because the domain is stable, write "RESEARCH: skipped — domain stable" and say why.

{
  "principles": [3-5 strings],
  "drivers": [exactly 3 strings],
  "options": [ {"name": string, "pros": [strings], "cons": [strings]} x at least 2 ],
  "adr": { "decision": string, "drivers": [strings], "alternatives": [strings], "why": string, "consequences": [strings], "followups": [strings] },
  "architecture": { "stack": string, "notes": string, "risks": [strings] },
  "glossary": [ { "term": string, "definition": string } ],
  "scope": { "in": [strings], "out": [strings] },
  "filePlan": {
    "structure": "proposed folder layout (greenfield) or existing-layout anchor (brownfield)",
    "create": ["exact repo-root-relative paths of NEW files"],
    "modify": ["exact repo-root-relative paths of EXISTING files to change"],
    "doNotTouch": ["paths that must stay untouched"]
  },
  "stories": [ { "id": "story-1", "criteria": [2-3 testable strings], "bcps": 1-13 effort estimate, "verify": "runnable command proving this story", "files": { "create": [paths], "modify": [paths], "doNotTouch": [paths] } } x N ],
  "acceptanceCriteria": [at least 3 testable strings]
}

Rules:
- filePlan is MANDATORY and GRANULAR: if the repo has code, inspect its real layout first (read-only tools allowed: ls/read/grep/find) and anchor every path in it. Files, not vague directories — include tests/configs. Explicitly list what you will NOT touch.
- stories SPLIT the work; the worker count = stories.length (split by how much work the plan has). HARD RULE: no file may appear in the create/modify of TWO different stories — if two pieces of work touch the same file, they are ONE story.
- acceptanceCriteria must be concrete, testable statements (they become the stories your Subworkers build and verify).
- Keep the plan tight: countable stories, no gold-plating.
- ${tools}Read-only inspection allowed. Do NOT execute anything, do NOT write code — plan only.
- Your crew builds and verifies from this JSON; nothing else in your reply is used.`;
};

/**
 * Interactive manual interview (the methodology library manual phase: choose-stack →
 * define-constraints → project mode). Runs INSIDE before_agent_start so pi
 * waits and the dialogs appear before the Leader turn plans. Timeouts fall
 * back to defaults (stack: first candidate, constraints: none, mode:
 * direct-PR) so unattended runs still proceed.
 */
/**
 * Constraint-candidate suggester: the LLM thinks about THIS goal and proposes
 * project-grounded candidates per category (the define-constraints style).
 * Deterministic generateCandidates is only the fallback.
 */
export type ConstraintSuggester = (
  goal: string,
  ctx: { stack: string | null; existingRepo: boolean },
) => Promise<CategoryCandidates[]>;

export async function llmSuggestConstraintCandidates(
  goal: string,
  ctx: { stack: string | null; existingRepo: boolean },
): Promise<CategoryCandidates[]> {
  try {
    const out = await askPi(
      `You are running the define-constraints interview for a goal. Read the goal CAREFULLY and think about what THIS SPECIFIC project needs.\n\nGoal: "${goal}"\nStack: ${ctx.stack ?? "undecided"} | Existing repo: ${ctx.existingRepo ? "yes (brownfield)" : "no (greenfield)"}\n\nPropose 4-6 SPECIFIC, project-grounded constraint candidates for EACH of the five categories:\n- do: things the build MUST do\n- dont: things it MUST NOT do\n- failure_modes: ways it could fail in production\n- edge_cases: tricky inputs/situations it must handle\n- invariants: properties that must always hold\n\nThe candidates must derive from THIS goal (its domain, its risks) — not generic boilerplate.\nEmit ONLY JSON: { "do": [...], "dont": [...], "failure_modes": [...], "edge_cases": [...], "invariants": [...] }`,
      120_000,
    );
    const cleaned = out.trim().replace(/^```json\\s*/i, "").replace(/```\\s*$/i, "").trim();
    const j = JSON.parse(cleaned) as Record<string, unknown>;
    return CATEGORY_ORDER.map((category) => ({
      category,
      items: (Array.isArray(j[category]) ? (j[category] as unknown[]) : [])
        .map((t, i) => ({
          id: `${category}-llm-${i + 1}`,
          text: String(t),
          appliesWhen: [] as string[],
        })),
    }));
  } catch {
    // LLM unavailable / unparseable → deterministic knowledge base
    return generateCandidates({
      stack: ctx.stack,
      scope: goal,
      existingRepo: ctx.existingRepo,
      riskSignals: [],
    });
  }
}

const DONE_LABEL = "✅ Done";
const CUSTOM_LABEL = "✏️ Write my own…";

/**
 * Multi-select dialog loop (options a,b,c,d… + multi-pick + custom answer).
 * Returns the picked LABELS (texts — they flow into the review checklists).
 */
async function interviewMultiSelect(
  ui: ExtensionUIContext,
  title: string,
  items: string[],
): Promise<string[]> {
  const picked: string[] = [];
  for (;;) {
    const remaining = items.filter((i) => !picked.includes(i));
    const opts = [DONE_LABEL, CUSTOM_LABEL, ...remaining];
    const choice = await ui.select(
      picked.length > 0 ? `${title} (${picked.length} picked)` : title,
      opts,
      { timeout: 45_000 },
    );
    if (!choice || choice === DONE_LABEL) break;
    if (choice === CUSTOM_LABEL) {
      const custom = await ui.input(`${title} — your own answer`, "");
      if (custom?.trim()) picked.push(custom.trim());
      continue;
    }
    picked.push(choice);
    if (remaining.length <= 1) break; // all items picked
  }
  return picked;
}

/** GRILL-LITE: the leader proposes 2-4 clarifying questions with a-d options. */
export interface ClarifyingQuestion {
  question: string;
  options: string[];
}

export async function llmClarifyingQuestions(goal: string): Promise<ClarifyingQuestion[]> {
  try {
    const out = await askPi(
      `You are clarifying a goal before planning it. Read the goal CAREFULLY.\n\nGoal: "${goal}"\n\nWhat 2-4 things are genuinely ambiguous or underspecified and would change the plan? For EACH, give 4 concrete answer options the operator can pick from (multi-select allowed).\nEmit ONLY JSON: { "questions": [ { "question": "...", "options": ["a)", "b)", "c)", "d)"] } ] }`,
      120_000,
    );
    const cleaned = out.trim().replace(/^```json\s*/i, "").replace(/```\s*$/i, "").trim();
    const j = JSON.parse(cleaned) as { questions?: unknown };
    const qs = Array.isArray(j.questions) ? j.questions : [];
    return qs
      .filter((q): q is Record<string, unknown> => !!q && typeof q === "object")
      .slice(0, 4)
      .map((q) => ({
        question: String(q.question ?? ""),
        options: Array.isArray(q.options) ? q.options.map(String) : [],
      }))
      .filter((q) => q.question && q.options.length > 0);
  } catch {
    return []; // LLM unavailable → skip grill-lite (timeout-safe)
  }
}

async function runManualInterview(
  ui: ExtensionUIContext,
  goal: string,
  facts: { existingRepo: boolean; stack: string | null },
  suggest: ConstraintSuggester = llmSuggestConstraintCandidates,
  clarify: (goal: string) => Promise<ClarifyingQuestion[]> = llmClarifyingQuestions,
): Promise<Map<string, string[]>> {
  const answers = new Map<string, string[]>();
  try {
    // choose-stack (AC-MANUAL-1/2): greenfield → the operator chooses
    if (!facts.stack) {
      const sel = resolveStackSelection(null);
      if (sel.kind === "choose") {
        const labels = sel.candidates.map((c) => c.name);
        const pick = await ui.select("Choose a stack", labels, { timeout: 60_000 });
        const chosen =
          sel.candidates.find((c) => c.name === pick) ??
          sel.candidates.find((c) => c.id === "typescript") ?? // timeout default: NOT research
          sel.candidates[0]!;
        answers.set("Choose a stack", [chosen.id]);
      }
    }
    // GRILL-LITE + constraint candidates run in PARALLEL (two headless LLM
    // calls before any dialog — serial would double the pre-interview wait)
    const [questions, candidates] = await Promise.all([
      clarify(goal),
      suggest(goal, {
        stack: facts.stack ?? "typescript",
        existingRepo: facts.existingRepo,
      }),
    ]);
    for (let i = 0; i < questions.length; i += 1) {
      const q = questions[i]!;
      answers.set(
        `clarify:${i}`,
        await interviewMultiSelect(ui, `Clarify — ${q.question}`, q.options),
      );
    }
    for (const cat of candidates) {
      const title = `define-constraints: ${cat.category} (select items, or none)`;
      answers.set(
        title,
        await interviewMultiSelect(ui, title, cat.items.map((i) => i.text)),
      );
    }
    // project mode (AC-MANUAL-7) — direct-PR presented first (the default)
    const modeLabels = ["direct-PR", "no-mistakes", "local-only", "+yolo"];
    const modePick = await ui.select("Project mode", modeLabels, { timeout: 30_000 });
    answers.set("Project mode", [modePick ?? "direct-PR"]);
    // ralplan consensus is MANDATORY unless the operator opts out (fast path)
    const consensusPick = await ui.select("Consensus review of the plan?", [
      "yes — full review (recommended)",
      "no — fast, use the plan as-is",
    ], { timeout: 30_000 });
    answers.set(
      "Consensus review of the plan?",
      [consensusPick === "no — fast, use the plan as-is" ? "no" : "yes"],
    );
  } catch (e) {
    console.warn(`[agentdev] interview failed (defaults used): ${e instanceof Error ? e.message : String(e)}`);
  }
  return answers;
}

function manualSummary(answers: Map<string, string[]>, facts: { existingRepo: boolean; stack: string | null }): string {
  const stack = answers.get("Choose a stack")?.[0] ?? facts.stack ?? "(auto)";
  const mode = answers.get("Project mode")?.[0] ?? "direct-PR";
  const constraints = [...answers.entries()]
    .filter(([k]) => k.startsWith("define-constraints:") && (answers.get(k) ?? []).length > 0)
    .map(([k, v]) => `${k.split(":")[1]!.trim().split(" ")[0]}=${(v ?? []).join(" | ")}`);
  const clarifications = [...answers.entries()]
    .filter(([k]) => k.startsWith("clarify:"))
    .map(([k, v]) => `Q${k.slice("clarify:".length)}: ${(v ?? []).join(" | ") || "(no answer)"}`);
  return `stack: ${stack} | mode: ${mode} | constraints: ${constraints.length > 0 ? constraints.join(", ") : "none selected"}${clarifications.length > 0 ? ` | clarifications: ${clarifications.join(" ; ")}` : ""}`;
}

/** Last assistant text from an agent_end message list (string or blocks). */
function lastAssistantText(messages: { role?: string; content?: unknown }[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || m.role !== "assistant") continue;
    const c = m.content;
    if (typeof c === "string") return c;
    if (Array.isArray(c)) {
      return c
        .map((b) =>
          typeof b === "string"
            ? b
            : typeof b === "object" && b !== null && "text" in b
              ? String((b as { text?: unknown }).text ?? "")
              : "",
        )
        .join("");
    }
    return "";
  }
  return "";
}

export interface AgentdevExtension {
  toggle: ToggleState;
  goals: GoalRegistry;
  register(pi: ExtensionAPI): void;
}

export interface AgentdevExtensionOptions {
  /** Tests inject a fake orchestrator; production uses the real crew. */
  makeOrchestrator?: (
    ports: ReturnType<typeof createRealPorts>,
    cwd: string,
  ) => ReturnType<typeof createOrchestrator>;
  /** Tests inject a deterministic suggester; production = LLM + fallback. */
  constraintSuggest?: ConstraintSuggester;
  /** Tests inject no clarifications; production = LLM grill-lite. */
  clarifyingQuestions?: (goal: string) => Promise<ClarifyingQuestion[]>;
  /** Project cwd for toggle persistence (tests pass a tmp dir). */
  cwd?: string;
}

/** Per-project persisted toggle: `.agentdev/toggle.json` → {on: boolean}. */
export function toggleFile(cwd: string): string {
  return join(cwd, ".agentdev", "toggle.json");
}

export function loadToggle(cwd: string): boolean {
  try {
    const j = JSON.parse(readFileSync(toggleFile(cwd), "utf8")) as { on?: unknown };
    return j.on === true;
  } catch {
    return false; // first use / missing state → OFF
  }
}

export function saveToggle(cwd: string, on: boolean): void {
  const file = toggleFile(cwd);
  mkdirSync(join(file, ".."), { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify({ on }), { encoding: "utf8", mode: 0o600 });
}

export function createAgentdevExtension(opts: AgentdevExtensionOptions = {}): AgentdevExtension {
  const cwd = opts.cwd ?? process.cwd();
  const toggle = createToggleState();
  const goals = createGoalRegistry();

  // Orchestrator + ports are created lazily with the real herdr adapter once
  // the operator turns agentdev ON (adapter version-gated, AC-SCOPE-2).
  let orch: ReturnType<typeof createOrchestrator> | null = null;
  let adapter = createHerdrAdapter();
  let confirmHandler: ((goalId: string, ok: boolean) => void) | null = null;
  /** Real TUI context for interactive dialogs (captured from hooks/commands). */
  let uiCtx: ExtensionUIContext | null = null;
  /** Precomputed interview answers (interactive manual phase, AC-MANUAL-*). */
  let pendingAnswers = new Map<string, string[]>();

  const ensureOrchestrator = (): ReturnType<typeof createOrchestrator> => {
    if (orch) return orch;
    adapter.assertHerdrVersion(); // gate [0.7.5, 0.8.0) — loud failure, not drift
    const ui = {
      notify: (message: string, level?: "info" | "warning" | "error") => {
        console.log(`[agentdev] ${level ?? "info"}: ${message}`);
      },
      select: async <T extends string>(
        title: string,
        options: { value: T; label: string }[],
      ): Promise<T> => {
        // 1. precomputed interactive answer (the before_agent_start interview)
        const pre = pendingAnswers.get(title);
        if (pre !== undefined && pre.length > 0) {
          pendingAnswers.delete(title);
          return pre[0] as T;
        }
        if (pre !== undefined) pendingAnswers.delete(title); // explicit empty
        // 2. live dialog fallback (resumed goals / late interview steps)
        if (uiCtx) {
          const picked = await uiCtx.select(
            title,
            options.map((o) => o.label),
            { timeout: 45_000 },
          );
          if (picked !== undefined) {
            return (options.find((o) => o.label === picked) ?? options[0]!).value;
          }
        }
        // 3. headless default: first option
        return options[0]!.value;
      },
      multiSelect: async <T extends string>(
        title: string,
        options: { value: T; label: string }[],
      ): Promise<T[]> => {
        // 1. precomputed interview answers — the stored LABELS flow straight
        //    into the review checklists
        const pre = pendingAnswers.get(title);
        if (pre !== undefined) {
          pendingAnswers.delete(title);
          return pre as T[];
        }
        // 2. live dialog loop (resumed goals / late steps): a,b,c,d… +
        //    Done + custom answer
        if (uiCtx) {
          return interviewMultiSelect(uiCtx, title, options.map((o) => o.label)) as Promise<T[]>;
        }
        // 3. headless default: none
        return [];
      },
      input: async (title: string, placeholder?: string): Promise<string> => {
        if (uiCtx) {
          const v = await uiCtx.input(title, placeholder, { timeout: 45_000 });
          if (v !== undefined) return v;
        }
        return placeholder ?? "";
      },
    };
    const ports = createRealPorts({
      ui,
      onConfirm: (set) => {
        confirmHandler = set;
      },
    });
    ports.adapter = adapter;
    orch =
      opts.makeOrchestrator?.(ports, process.cwd()) ??
      createOrchestrator(ports, { cwd: process.cwd(), waitForLeaderPlan: true });
    return orch;
  };


  return {
    toggle,
    goals,
    register(pi: ExtensionAPI) {
      // State persistence: OFF by default; restores the last state for this
      // project (the `agentdev` launcher transports it via AGENTDEV_AUTO_ON;
      // plain `pi` sessions read the toggle file directly).
      if (process.env.AGENTDEV_AUTO_ON === "1" || loadToggle(cwd)) {
        toggle.turnOn();
      }
      pi.registerCommand("agentdev", {
        description: "agentdev crew control. Usage: /agentdev on | off | status | confirm <goal> | resume",
        handler: async (args: string | undefined, ctx: ExtensionCommandContext) => {
          const arg = (args ?? "").trim();
          if (arg === "on") {
            if (toggle.isOn()) {
              ctx.ui.notify("agentdev is already ON — every message is a goal.", "info");
            } else {
              toggle.turnOn();
              saveToggle(cwd, true); // remember for the next session (AC-TOGGLE-3′)
              uiCtx = ctx.ui; // interactive dialogs from now on
              ensureOrchestrator(); // wire the crew lazily (adapter version-gated)
              // close orphaned crew panes (dead goals' W:/S: workspaces) so
              // leftover workers never look like they're launching mid-plan
              try {
                const closed = reconcileCrewPanes(adapter, cwd);
                if (closed > 0) {
                  ctx.ui.notify(`agentdev: cleaned ${closed} orphaned crew pane(s) from previous goals`, "info");
                }
              } catch {
                /* herdr unavailable — skip cleanup */
              }
              ctx.ui.notify("agentdev is now ON — every message is a goal (manual phase → autopilot).", "info");
            }
          } else if (arg === "off") {
            if (!toggle.isOn()) {
              ctx.ui.notify("agentdev is already OFF — plain pi.", "info");
            } else {
              toggle.turnOff();
              saveToggle(cwd, false); // remember for the next session
              ctx.ui.notify("agentdev is now OFF — plain pi.", "info");
            }
          } else if (arg === "status") {
            let text: string;
            try {
              const runs = ensureOrchestrator().all();
              text =
                runs.length === 0
                  ? "no goals yet"
                  : runs.map((r) => `${r.goalId}=${r.step}${r.approved ? "✓" : ""}`).join(", ");
            } catch (e) {
              text = `(status unavailable: ${e instanceof Error ? e.message : String(e)})`;
            }
            ctx.ui.notify(`agentdev is ${toggle.isOn() ? "ON" : "OFF"} — ${text}`, "info");
          } else if (arg.startsWith("confirm ")) {
            const goalId = arg.slice("confirm ".length).trim();
            const ok = ensureOrchestrator().status(goalId) !== null;
            if (!ok) {
              ctx.ui.notify(`agentdev: unknown goal ${goalId}`, "warning");
              return;
            }
            confirmHandler?.(goalId, true); // answer the gate's pending confirm
            ctx.ui.notify(`agentdev: confirmed ${goalId} — committing.`, "info");
          } else if (arg === "resume") {
            const runs = await ensureOrchestrator().resumeAll();
            ctx.ui.notify(
              runs.length === 0
                ? "agentdev: nothing to resume"
                : `agentdev: resumed ${runs.map((r) => `${r.goalId}=${r.step}`).join(", ")}`,
              "info",
            );
          } else if (arg === "") {
            ctx.ui.notify("usage: /agentdev on | off | status | confirm <goal> | resume", "info");
          } else {
            ctx.ui.notify("usage: /agentdev on | off | status | confirm <goal> | resume", "info");
          }
        },
      });

      pi.on("before_agent_start", async (event, ctx) => {
        // headless crew agents (pi -p) must never capture goals — they ARE the crew
        if (process.env.AGENTDEV_NO_CREW === "1" || process.argv.includes("-p")) return;
        if (!toggle.isOn()) return; // plain pi when OFF
        const prompt = event.prompt.trim();
        if (!prompt) return;
        goals.add(prompt); // AC-TOGGLE-5: message = goal (own sub-tree, AC-TOGGLE-6)
        uiCtx = ctx.ui;
        // Interactive manual phase FIRST (pi waits for this hook, so the
        // dialogs appear before the Leader turn): choose-stack →
        // define-constraints → project mode. Answers feed the pipeline.
        const facts = detectCodebase(cwd);
        // make the codebase analysis VISIBLE before any stack question
        if (facts.stack) {
          ctx.ui.notify(`agentdev: existing codebase detected — stack locked to ${facts.stack}`, "info");
        } else {
          ctx.ui.notify(
            facts.existingRepo
              ? `agentdev: repo found but no stack detected — asking you to choose`
              : `agentdev: greenfield — no code yet, asking you to choose`,
            "info",
          );
        }
        pendingAnswers = await runManualInterview(
          ctx.ui,
          prompt,
          facts,
          opts.constraintSuggest ?? llmSuggestConstraintCandidates,
          opts.clarifyingQuestions ?? llmClarifyingQuestions,
        );
        const needsResearch = pendingAnswers.get("Choose a stack")?.[0] === "research";
        // VISIBLE research announcement — the leader turn performs the web
        // search (whichever search tool pi provides); say so up front
        ctx.ui.notify(
          needsResearch
            ? `agentdev: leader is researching the BEST LANGUAGE for this goal on the web — results will show in the turn`
            : `agentdev: leader is checking the web for up-to-date techniques — results will show in the turn`,
          "info",
        );
        const o = ensureOrchestrator();
        const skipConsensus = pendingAnswers.get("Consensus review of the plan?")?.[0] === "no";
        // Defer the pipeline: never run goal setup synchronously inside the
        // hook. The crew must not block the interactive session — the whole
        // point of agentdev is you keep typing while it follows the
        // methodology in the background.
        setImmediate(() => {
          o.start(prompt, { skipConsensus }).catch((e) => {
            console.error(`[agentdev] goal pipeline failed: ${e instanceof Error ? e.message : String(e)}`);
          });
        });
        // The interactive turn is the LEADER planning turn (AC-LEADER-1): its
        // plan JSON is captured on agent_end and handed to the crew.
        return {
          systemPrompt: `${event.systemPrompt}\n\nACTIVE PROJECTS BOARD (your other goals — you lead them all):\n${projectsBoard(cwd)}\n\n${LEADER_PLAN_PROMPT(
            manualSummary(pendingAnswers, facts),
            needsResearch,
          )}`,
        };
      });

      // Leader handoff capture: the interactive turn produced the plan.
      pi.on("agent_end", (event) => {
        if (process.env.AGENTDEV_NO_CREW === "1" || process.argv.includes("-p")) return;
        if (!toggle.isOn() || !orch) return;
        const messages = (event as { messages?: { role?: string; content?: unknown }[] }).messages ?? [];
        const text = lastAssistantText(messages);
        const plan = parseLeaderPlanOutput(text);
        const stack = parseLeaderStack(text); // choose-stack research path
        if (!plan) {
          console.log(`[agentdev] leader turn did not produce a plan — consensus fallback`);
        }
        orch.acceptLeaderPlanForLatest(plan, stack);
      });

      // AC-TOGGLE-1: orchestration tools are registered (gated on the toggle).
      pi.registerTool({
        name: "agentdev_status",
        label: "agentdev status",
        description: "List agentdev goals and their pipeline step (empty unless agentdev is ON).",
        parameters: Type.Object({}),
        async execute() {
          const text = !toggle.isOn() || !orch
            ? "agentdev is OFF"
            : (() => {
                const runs = orch.all();
                return runs.length === 0
                  ? "no goals"
                  : runs.map((r) => `${r.goalId} step=${r.step} approved=${r.approved} errors=${r.errors.length}`).join("\n");
              })();
          return { content: [{ type: "text", text }], details: {} };
        },
      });
    },
  };
}

export default function (pi: ExtensionAPI): void {
  createAgentdevExtension().register(pi);
}

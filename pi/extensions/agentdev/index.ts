import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { parseToggleArg, createToggleState, type ToggleState } from "./toggle";
import { createGoalRegistry, type GoalRegistry } from "./goals";
import { createOrchestrator, parseLeaderPlanOutput, parseLeaderStack } from "./orchestrator";
import { createRealPorts } from "./real-ports";
import { createHerdrAdapter } from "./backend-adapter";
import { detectCodebase } from "./map-codebase";
import { resolveStackSelection } from "./choose-stack";
import { createInterview, generateCandidates } from "./define-constraints";

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
 * - resources_discover exposes the crew's methodology skills (AC-INSTALL-1).
 *   The agentdev-* skills ship with the package (pi manifest "skills").
 */

const SKILL_PATHS = [
  "/pi/skills/agentdev-map-codebase",
  "/pi/skills/agentdev-choose-stack",
  "/pi/skills/agentdev-define-language",
  "/pi/skills/agentdev-define-constraints",
  "/pi/skills/agentdev-plan",
  "/pi/skills/agentdev-build",
  "/pi/skills/agentdev-verify",
  "/pi/skills/agentdev-review",
  "/pi/skills/agentdev-commit",
];

/**
 * Leader-planning prompt (AC-LEADER-1): with the crew ON, the interactive
 * turn IS the Leader. It plans; the plan JSON is captured on agent_end and
 * handed to the Subleader, whose workers build/verify/review and report back.
 * needsResearch = the operator chose the web-research stack path;
 * techniquesResearch = the operator wants up-to-date technique research.
 */
const LEADER_PLAN_PROMPT = (manual: string, needsResearch: boolean, techniquesResearch: boolean): string => {
  const research = needsResearch
    ? `\nSTACK RESEARCH REQUIRED — the operator asked you to research the BEST LANGUAGE FOR THIS USE CASE on the web.
Use the web_search tool (not generic "top languages" lists): evaluate performance, domain fit, ecosystem,
deploy target, and maintainability FOR THIS SPECIFIC GOAL. The best fit may be Rust, C++, Go, Python,
TypeScript, or anything else — pick what the use case actually needs.
After the plan JSON block, emit one more line: STACK: <id> (your researched pick, lowercase).`
    : techniquesResearch
      ? `\nTECHNIQUES RESEARCH — the operator wants you to check the web for UP-TO-DATE techniques, libraries, and
best practices for this goal (current library versions, API changes, modern idioms). Bounded: at most 3
searches; skip if the domain is stable. Fold what you find into principles/options/ADR — no citations list needed.`
      : "";
  const tools =
    needsResearch || techniquesResearch
      ? "You MAY use web_search for the research above only. "
      : "Do NOT use tools. ";
  return `You are the Leader of an agent crew. The user's message is a GOAL for your crew to build.

Manual phase (agentdev-map-codebase / agentdev-choose-stack / agentdev-define-language / agentdev-define-constraints) is done:
${manual}${research}

Your job is PLANNING (agentdev-plan). Think the goal through, then emit the plan as ONE JSON object inside a single \`\`\`json code block — nothing else outside the block:

{
  "principles": [3-5 strings],
  "drivers": [exactly 3 strings],
  "options": [ {"name": string, "pros": [strings], "cons": [strings]} x at least 2 ],
  "adr": { "decision": string, "drivers": [strings], "alternatives": [strings], "why": string, "consequences": [strings], "followups": [strings] },
  "filePlan": {
    "structure": "proposed folder layout (greenfield) or existing-layout anchor (brownfield)",
    "create": ["exact repo-root-relative paths of NEW files"],
    "modify": ["exact repo-root-relative paths of EXISTING files to change"],
    "doNotTouch": ["paths that must stay untouched"]
  },
  "acceptanceCriteria": [at least 3 testable strings]
}

Rules:
- filePlan is MANDATORY and GRANULAR: if the repo has code, inspect its real layout first (read-only tools allowed: ls/read/grep/find) and anchor every path in it. Files, not vague directories — include tests/configs. Explicitly list what you will NOT touch.
- acceptanceCriteria must be concrete, testable statements (they become the stories your Subworkers build and verify).
- Keep the plan tight: countable stories, no gold-plating.
- ${tools}Read-only inspection allowed. Do NOT execute anything, do NOT write code — plan only.
- Your crew builds and verifies from this JSON; nothing else in your reply is used.`;
};

/**
 * Interactive manual interview (bigpowers manual phase: choose-stack →
 * define-constraints → project mode). Runs INSIDE before_agent_start so pi
 * waits and the dialogs appear before the Leader turn plans. Timeouts fall
 * back to defaults (stack: first candidate, constraints: none, mode:
 * direct-PR) so unattended runs still proceed.
 */
async function runManualInterview(
  ui: ExtensionUIContext,
  goal: string,
  facts: { existingRepo: boolean; stack: string | null },
): Promise<Map<string, string>> {
  const answers = new Map<string, string>();
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
        answers.set("Choose a stack", chosen.id);
      }
    }
    // define-constraints interview (AC-MANUAL-4/5)
    const candidates = generateCandidates({
      stack: facts.stack ?? "typescript",
      scope: goal,
      existingRepo: facts.existingRepo,
      riskSignals: [],
    });
    for (const cat of candidates) {
      const title = `define-constraints: ${cat.category} (select items, or none)`;
      const labels = ["none", ...cat.items.map((i) => i.text)];
      const pick = await ui.select(title, labels, { timeout: 30_000 });
      const idx = labels.indexOf(pick ?? "");
      answers.set(title, idx <= 0 ? "none" : cat.items[idx - 1]!.id);
    }
    // project mode (AC-MANUAL-7) — direct-PR presented first (the default)
    const modeLabels = ["direct-PR", "no-mistakes", "local-only", "+yolo"];
    const modePick = await ui.select("Project mode", modeLabels, { timeout: 30_000 });
    answers.set("Project mode", modePick ?? "direct-PR");
    // up-to-date techniques research (features + new projects): the leader
    // MAY check the web for current best practices / libraries / API changes
    const researchPick = await ui.select(
      "Research up-to-date techniques for this goal?",
      ["Yes — web research (recommended)", "No — plan from knowledge"],
      { timeout: 30_000 },
    );
    answers.set(
      "Research up-to-date techniques for this goal?",
      researchPick === "No — plan from knowledge" ? "no" : "yes",
    );
  } catch (e) {
    console.warn(`[agentdev] interview failed (defaults used): ${e instanceof Error ? e.message : String(e)}`);
  }
  return answers;
}

function manualSummary(answers: Map<string, string>, facts: { existingRepo: boolean; stack: string | null }): string {
  const stack = answers.get("Choose a stack") ?? facts.stack ?? "(auto)";
  const mode = answers.get("Project mode") ?? "direct-PR";
  const constraints = [...answers.entries()]
    .filter(([k]) => k.startsWith("define-constraints:") && answers.get(k) !== "none")
    .map(([k, v]) => `${k.split(":")[1]!.trim().split(" ")[0]}=${v}`);
  return `stack: ${stack} | mode: ${mode} | constraints: ${constraints.length > 0 ? constraints.join(", ") : "none selected"}`;
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
  let pendingAnswers = new Map<string, string>();

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
        if (pre !== undefined) {
          pendingAnswers.delete(title);
          return pre as T;
        }
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
        if (!toggle.isOn()) return; // plain pi when OFF
        const prompt = event.prompt.trim();
        if (!prompt) return;
        goals.add(prompt); // AC-TOGGLE-5: message = goal (own sub-tree, AC-TOGGLE-6)
        uiCtx = ctx.ui;
        // Interactive manual phase FIRST (pi waits for this hook, so the
        // dialogs appear before the Leader turn): choose-stack →
        // define-constraints → project mode. Answers feed the pipeline.
        const facts = detectCodebase(cwd);
        pendingAnswers = await runManualInterview(ctx.ui, prompt, facts);
        const needsResearch = pendingAnswers.get("Choose a stack") === "research";
        const techniquesResearch =
          pendingAnswers.get("Research up-to-date techniques for this goal?") !== "no";
        const o = ensureOrchestrator();
        // Defer the pipeline: never run goal setup synchronously inside the
        // hook. The crew must not block the interactive session — the whole
        // point of agentdev is you keep typing while it follows the
        // methodology in the background.
        setImmediate(() => {
          o.start(prompt).catch((e) => {
            console.error(`[agentdev] goal pipeline failed: ${e instanceof Error ? e.message : String(e)}`);
          });
        });
        // The interactive turn is the LEADER planning turn (AC-LEADER-1): its
        // plan JSON is captured on agent_end and handed to the crew.
        return {
          systemPrompt: `${event.systemPrompt}\n\n${LEADER_PLAN_PROMPT(
            manualSummary(pendingAnswers, facts),
            needsResearch,
            techniquesResearch,
          )}`,
        };
      });

      // Leader handoff capture: the interactive turn produced the plan.
      pi.on("agent_end", (event) => {
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

      // AC-INSTALL-1: expose the manual-phase skills to pi.
      pi.on("resources_discover", () => ({ skillPaths: SKILL_PATHS.map((p) => process.cwd() + p) }));

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

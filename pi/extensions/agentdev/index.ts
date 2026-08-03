import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { parseToggleArg, createToggleState, type ToggleState } from "./toggle";
import { createGoalRegistry, type GoalRegistry } from "./goals";
import { createOrchestrator, parseLeaderPlanOutput } from "./orchestrator";
import { createRealPorts } from "./real-ports";
import { createHerdrAdapter } from "./backend-adapter";

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
 * - resources_discover exposes the manual-phase skills (AC-INSTALL-1).
 */

const SKILL_PATHS = [
  "/pi/skills/choose-stack",
  "/pi/skills/define-constraints",
  "/pi/skills/define-language",
];

/**
 * Leader-planning prompt (AC-LEADER-1): with the crew ON, the interactive
 * turn IS the Leader. It plans; the plan JSON is captured on agent_end and
 * handed to the Subleader, whose workers build/verify/review and report back.
 */
const LEADER_PLAN_PROMPT = `You are the Leader of an agent crew. The user's message is a GOAL for your crew to build.

Your job is PLANNING. Think the goal through, then emit the plan as ONE JSON object inside a single \`\`\`json code block — nothing else outside the block:

{
  "principles": [3-5 strings],
  "drivers": [exactly 3 strings],
  "options": [ {"name": string, "pros": [strings], "cons": [strings]} x at least 2 ],
  "adr": { "decision": string, "drivers": [strings], "alternatives": [strings], "why": string, "consequences": [strings], "followups": [strings] },
  "acceptanceCriteria": [at least 3 testable strings]
}

Rules:
- acceptanceCriteria must be concrete, testable statements.
- Do NOT use tools, do NOT execute anything, do NOT write code — plan only.
- Your crew builds and verifies from this JSON; nothing else in your reply is used.`;

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

  const ensureOrchestrator = (): ReturnType<typeof createOrchestrator> => {
    if (orch) return orch;
    adapter.assertHerdrVersion(); // gate [0.7.5, 0.8.0) — loud failure, not drift
    const ui = {
      notify: (message: string, level?: "info" | "warning" | "error") => {
        console.log(`[agentdev] ${level ?? "info"}: ${message}`);
      },
      select: async <T extends string>(
        _title: string,
        options: { value: T; label: string }[],
      ): Promise<T> => {
        // SILENT headless default: first option. The interview questions are
        // not useful in the transcript; stepManual reports one summary line.
        return options[0]!.value;
      },
      input: async (_title: string, _placeholder?: string) => "",
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

      pi.on("before_agent_start", (event) => {
        if (!toggle.isOn()) return; // plain pi when OFF
        const prompt = event.prompt.trim();
        if (!prompt) return;
        goals.add(prompt); // AC-TOGGLE-5: message = goal (own sub-tree, AC-TOGGLE-6)
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
          systemPrompt: `${event.systemPrompt}\n\n${LEADER_PLAN_PROMPT}`,
        };
      });

      // Leader handoff capture: the interactive turn produced the plan.
      pi.on("agent_end", (event) => {
        if (!toggle.isOn() || !orch) return;
        const messages = (event as { messages?: { role?: string; content?: unknown }[] }).messages ?? [];
        const text = lastAssistantText(messages);
        const plan = parseLeaderPlanOutput(text);
        if (!plan) {
          console.log(`[agentdev] leader turn did not produce a plan — consensus fallback`);
        }
        orch.acceptLeaderPlanForLatest(plan);
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

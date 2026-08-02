import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { parseToggleArg, createToggleState, type ToggleState } from "./toggle";
import { createGoalRegistry, type GoalRegistry } from "./goals";
import { createOrchestrator } from "./orchestrator";
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
        title: string,
        options: { value: T; label: string }[],
      ): Promise<T> => {
        // headless-safe default: first option (operator interactivity is
        // provided by the /agentdev commands in the TUI)
        console.log(`[agentdev] select: ${title} → ${options[0]?.label}`);
        return options[0]!.value;
      },
      input: async (_title: string, placeholder?: string) => placeholder ?? "",
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
      createOrchestrator(ports, { cwd: process.cwd() });
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
        o.start(prompt).catch((e) => {
          console.error(`[agentdev] goal pipeline failed: ${e instanceof Error ? e.message : String(e)}`);
        });
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

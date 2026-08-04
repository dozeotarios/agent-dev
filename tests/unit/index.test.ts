import { describe, expect, it, vi } from "vitest";
import agentdev, { createAgentdevExtension } from "../../pi/extensions/agentdev/index";

interface CommandDef {
  description?: string;
  handler: (args?: string, ctx?: unknown) => Promise<void> | void;
}

type HookHandler = (event: { prompt: string }, ctx?: unknown) => unknown;

function tmpCwd(): string {
  const { mkdtempSync } = require("node:fs") as typeof import("node:fs");
  const { tmpdir } = require("node:os") as typeof import("node:os");
  return mkdtempSync(require("node:path").join(tmpdir(), "agentdev-ext-"));
}

/** Minimal deterministic stand-in for the pi API at the unit layer. */
function loadExtension(cwd?: string) {
  const commands = new Map<string, CommandDef>();
  const hooks = new Map<string, HookHandler>();
  const tools: unknown[] = [];
  const notify = vi.fn();
  const pi = {
    registerCommand(name: string, def: CommandDef) {
      commands.set(name, def);
    },
    on(event: string, handler: HookHandler) {
      hooks.set(event, handler);
    },
    registerTool(def: unknown) {
      tools.push(def);
    },
  };
  // Fake orchestrator: records goals, resolves immediately (no real agents).
  const started: string[] = [];
  const leaderPlans: unknown[] = [];
  const fakeOrch = {
    start: async (g: string) => {
      started.push(g);
      return { goalId: "goal-x", goalText: g, step: "done", approved: true, plan: null, workers: [], gate: null, errors: [], progress: "step=done" };
    },
    all: () => [],
    status: () => null,
    resumeAll: async () => [],
    acceptLeaderPlanForLatest: (plan: unknown) => {
      leaderPlans.push(plan);
    },
  };
  const ext = createAgentdevExtension({
    makeOrchestrator: () => fakeOrch as never,
    cwd: cwd ?? tmpCwd(),
  });
  ext.register(pi as never);
  const ctx = {
    ui: {
      notify,
      select: vi.fn().mockResolvedValue(undefined), // timeout → defaults
      input: vi.fn().mockResolvedValue(undefined),
      confirm: vi.fn().mockResolvedValue(false),
    },
  };
  return { commands, hooks, tools, notify, ctx, ext, started, leaderPlans };
}

describe("extension entry — index.ts (wiring)", () => {
  it("registers the /agentdev command", () => {
    const { commands } = loadExtension();
    expect(commands.has("agentdev")).toBe(true);
  });

  it("`/agentdev on` → notifies ON", async () => {
    const { commands, notify, ctx } = loadExtension();
    await commands.get("agentdev")!.handler("on", ctx);
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("is now ON"), "info");
  });

  it("`/agentdev on` when already ON → explicit 'already ON'", async () => {
    const { commands, notify, ctx } = loadExtension();
    await commands.get("agentdev")!.handler("on", ctx);
    await commands.get("agentdev")!.handler("on", ctx);
    expect(notify).toHaveBeenLastCalledWith(expect.stringContaining("is already ON"), "info");
  });

  it("`/agentdev off` → notifies OFF", async () => {
    const { commands, notify, ctx } = loadExtension();
    await commands.get("agentdev")!.handler("off", ctx);
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("is already OFF"), "info");
  });

  it("`/agentdev off` when already OFF → explicit 'already OFF'", async () => {
    const { commands, notify, ctx } = loadExtension();
    await commands.get("agentdev")!.handler("off", ctx);
    await commands.get("agentdev")!.handler("off", ctx);
    expect(notify).toHaveBeenLastCalledWith(expect.stringContaining("is already OFF"), "info");
  });

  it("`/agentdev status` reports the toggle state explicitly", async () => {
    const { commands, notify, ctx } = loadExtension();
    await commands.get("agentdev")!.handler("off", ctx);
    await commands.get("agentdev")!.handler("status", ctx);
    expect(notify).toHaveBeenLastCalledWith(expect.stringContaining("agentdev is OFF"), "info");
    await commands.get("agentdev")!.handler("on", ctx);
    await commands.get("agentdev")!.handler("status", ctx);
    expect(notify).toHaveBeenLastCalledWith(expect.stringContaining("agentdev is ON"), "info");
  });

  it("anything else → usage hint (AC-TOGGLE-4)", async () => {
    const { commands, notify, ctx } = loadExtension();
    await commands.get("agentdev")!.handler("start", ctx);
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("usage"), "info");
  });

  it("registers the before_agent_start hook (goal entry point)", () => {
    const { hooks } = loadExtension();
    expect(hooks.has("before_agent_start")).toBe(true);
  });

  it("the interactive turn is the LEADER planning turn (AC-LEADER-1)", async () => {
    const { hooks, ctx, commands, ext } = loadExtension();
    void commands.get("agentdev")!.handler("on", ctx);
    expect(ext.toggle.isOn()).toBe(true);
    const result = (await hooks.get("before_agent_start")!({ prompt: "build a todo app" }, ctx)) as {
      systemPrompt: string;
    };
    expect(result.systemPrompt).toContain("You are the Leader");
    expect(result.systemPrompt).toContain("acceptanceCriteria");
    expect(result.systemPrompt).toContain("agentdev-plan");
  });

  it("the manual interview asks the operator (stack + constraints + mode + research)", async () => {
    const { hooks, ctx, commands } = loadExtension();
    await commands.get("agentdev")!.handler("on", ctx);
    await hooks.get("before_agent_start")!({ prompt: "build a todo app" }, ctx);
    const titles = (ctx.ui.select as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(titles).toContain("Choose a stack"); // greenfield → the operator picks
    expect(titles.some((t) => t.startsWith("define-constraints:"))).toBe(true);
    expect(titles).toContain("Project mode");
    expect(titles.some((t) => t.includes("Research up-to-date techniques"))).toBe(true);
  });

  it("interview timeouts fall back to defaults (unattended run)", async () => {
    const { hooks, ctx, commands, started } = loadExtension();
    await commands.get("agentdev")!.handler("on", ctx);
    await hooks.get("before_agent_start")!({ prompt: "build a todo app" }, ctx);
    await new Promise((r) => setTimeout(r, 10));
    expect(started).toContain("build a todo app"); // pipeline still runs
  });

  it("agent_end captures the leader's plan and hands it to the crew", async () => {
    const { hooks, ctx, commands, leaderPlans } = loadExtension();
    await commands.get("agentdev")!.handler("on", ctx);
    const planJson = JSON.stringify({
      principles: ["p1", "p2"],
      drivers: ["d1", "d2", "d3"],
      options: [{ name: "a", pros: ["x"], cons: ["y"] }],
      adr: {
        decision: "build it",
        drivers: ["d1"],
        alternatives: ["b"],
        why: "why",
        consequences: ["c"],
        followups: ["f"],
      },
      acceptanceCriteria: ["c1", "c2", "c3"],
    });
    hooks.get("agent_end")!({ messages: [{ role: "assistant", content: `\`\`\`json\n${planJson}\n\`\`\`` }] } as never);
    expect(leaderPlans).toHaveLength(1);
    const plan = leaderPlans[0] as { adr: { decision: string } };
    expect(plan.adr.decision).toBe("build it");
  });

  it("agent_end with no plan-shaped reply hands null (consensus fallback)", async () => {
    const { hooks, ctx, commands, leaderPlans } = loadExtension();
    await commands.get("agentdev")!.handler("on", ctx);
    hooks.get("agent_end")!({ messages: [{ role: "assistant", content: "sure, on it" }] } as never);
    expect(leaderPlans).toEqual([null]);
  });

  it("agent_end is ignored when OFF (plain pi)", async () => {
    const { hooks, ctx, commands, leaderPlans } = loadExtension();
    await commands.get("agentdev")!.handler("off", ctx);
    hooks.get("agent_end")!({ messages: [{ role: "assistant", content: "anything" }] } as never);
    expect(leaderPlans).toHaveLength(0);
  });

  it("does NOT register resources_discover (skills come from the pi manifest — cwd-relative paths caused collisions)", () => {
    const { hooks } = loadExtension();
    expect(hooks.has("resources_discover")).toBe(false);
  });

  it("registers the agentdev_status tool (AC-TOGGLE-1)", () => {
    const { tools } = loadExtension();
    expect(tools.length).toBe(1);
    expect((tools[0] as { name: string }).name).toBe("agentdev_status");
  });

  it("state persists: /agentdev off stays OFF in a new session (AC-TOGGLE-3′)", async () => {
    const cwd = tmpCwd();
    const a = loadExtension(cwd);
    await a.commands.get("agentdev")!.handler("off", a.ctx);
    expect(a.ext.toggle.isOn()).toBe(false);
    // a NEW session in the same project restores OFF
    const b = loadExtension(cwd);
    expect(b.ext.toggle.isOn()).toBe(false);
    require("node:fs").rmSync(cwd, { recursive: true, force: true });
  });

  it("state persists: /agentdev on stays ON in a new session", async () => {
    const cwd = tmpCwd();
    const a = loadExtension(cwd);
    await a.commands.get("agentdev")!.handler("on", a.ctx);
    expect(a.ext.toggle.isOn()).toBe(true);
    // a NEW session in the same project restores ON
    const b = loadExtension(cwd);
    expect(b.ext.toggle.isOn()).toBe(true);
    require("node:fs").rmSync(cwd, { recursive: true, force: true });
  });

  it("brand-new project (no toggle file) defaults to OFF", () => {
    const cwd = tmpCwd();
    const ext = createAgentdevExtension({ cwd });
    expect(ext.toggle.isOn()).toBe(false);
    require("node:fs").rmSync(cwd, { recursive: true, force: true });
  });

  it("AGENTDEV_AUTO_ON starts the crew ON (the `agentdev` launcher)", () => {
    const prev = process.env.AGENTDEV_AUTO_ON;
    process.env.AGENTDEV_AUTO_ON = "1";
    try {
      const pi = { registerCommand: vi.fn(), on: vi.fn(), registerTool: vi.fn() };
      const ext = createAgentdevExtension();
      ext.register(pi as never);
      expect(ext.toggle.isOn()).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.AGENTDEV_AUTO_ON;
      else process.env.AGENTDEV_AUTO_ON = prev;
    }
  });

  it("OFF: a message is NOT a goal — plain pi (AC-TOGGLE-5 negative)", async () => {
    const { commands, hooks, ctx, ext } = loadExtension();
    await commands.get("agentdev")!.handler("off", ctx);
    hooks.get("before_agent_start")!({ prompt: "hello" }, ctx);
    expect(ext.goals.count()).toBe(0);
  });

  it("ON: every message is captured as a goal (AC-TOGGLE-5)", async () => {
    const { commands, hooks, ctx, ext, started } = loadExtension();
    await commands.get("agentdev")!.handler("on", ctx);
    hooks.get("before_agent_start")!({ prompt: "build a todo app" }, ctx);
    expect(ext.goals.count()).toBe(1);
    expect(ext.goals.all()[0].text).toBe("build a todo app");
    await new Promise((r) => setTimeout(r, 10));
    expect(started).toContain("build a todo app"); // handed to the crew
  });

  it("ON: a second message creates a second sub-tree — multi-goal (AC-TOGGLE-6)", async () => {
    const { commands, hooks, ctx, ext } = loadExtension();
    await commands.get("agentdev")!.handler("on", ctx);
    const hook = hooks.get("before_agent_start")!;
    hook({ prompt: "first goal" }, ctx);
    hook({ prompt: "second goal" }, ctx);
    const all = ext.goals.all();
    expect(all).toHaveLength(2);
    expect(all[1].goalId).toBe("goal-2");
    expect(all[1].subtreeId).toBe("t2");
    expect(all[0].subtreeId).not.toBe(all[1].subtreeId);
  });

  it("blank prompts are not goals and do not start a crew", () => {
    const { commands, hooks, ctx, ext, started } = loadExtension();
    void commands.get("agentdev")!.handler("on", ctx);
    hooks.get("before_agent_start")!({ prompt: "   " }, ctx);
    expect(ext.goals.count()).toBe(0);
    expect(started).toHaveLength(0);
  });
});

describe("extension entry — default export stays a plain factory", () => {
  it("default export registers without throwing", () => {
    const pi = { registerCommand: vi.fn(), on: vi.fn(), registerTool: vi.fn() };
    agentdev(pi as never);
    expect(pi.registerCommand).toHaveBeenCalledWith("agentdev", expect.anything());
    expect(pi.on).toHaveBeenCalledWith("before_agent_start", expect.anything());
    expect(pi.registerTool).toHaveBeenCalledWith(expect.objectContaining({ name: "agentdev_status" }));
  });
});

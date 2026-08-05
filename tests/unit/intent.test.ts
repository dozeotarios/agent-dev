import { describe, expect, it } from "vitest";
import { detectIntent, detectIntentHeuristic } from "../../pi/extensions/agentdev/intent";

describe("intent detection (auto-classify any message)", () => {
  it("heuristics: bug reports → debug", () => {
    expect(detectIntentHeuristic("login fails on Safari sometimes")).toBe("debug");
    expect(detectIntentHeuristic("the build crashes on startup")).toBe("debug");
    expect(detectIntentHeuristic("prices show wrong totals — broken")).toBe("debug");
  });

  it("heuristics: audits → audit, whys → investigate, else build", () => {
    expect(detectIntentHeuristic("audit the auth handling in payments-api")).toBe("audit");
    expect(detectIntentHeuristic("security review of the checkout flow")).toBe("audit");
    expect(detectIntentHeuristic("why is the queue backing up")).toBe("investigate");
    expect(detectIntentHeuristic("what are our options for scaling")).toBe("investigate");
    expect(detectIntentHeuristic("build a CLI that tracks expenses")).toBe("build");
    expect(detectIntentHeuristic("add dark mode to the app")).toBe("build");
  });

  it("LLM classification wins when available; heuristic is the fallback", async () => {
    const llm = await detectIntent("the login breaks", async () => "debug");
    expect(llm).toEqual({ intent: "debug", source: "llm" });
    const build = await detectIntent("the login breaks", async () => "build");
    expect(build).toEqual({ intent: "build", source: "llm" });
    const fallback = await detectIntent("the login breaks", async () => {
      throw new Error("model down");
    });
    expect(fallback).toEqual({ intent: "debug", source: "heuristic" });
  });
});

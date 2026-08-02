import { describe, expect, it } from "vitest";
import { parseToggleArg, createToggleState } from "../../pi/extensions/agentdev/toggle";

// AC-TOGGLE-4: only `on` | `off` are accepted; anything else → usage hint.
describe("parseToggleArg (AC-TOGGLE-4)", () => {
  it("accepts `on`", () => {
    expect(parseToggleArg("on")).toBe("on");
  });

  it("accepts `off`", () => {
    expect(parseToggleArg("off")).toBe("off");
  });

  it("accepts whitespace-padded `on` / `off`", () => {
    expect(parseToggleArg("  on  ")).toBe("on");
    expect(parseToggleArg("\toff\n")).toBe("off");
  });

  it("rejects undefined / empty → usage", () => {
    expect(parseToggleArg(undefined)).toBe("usage");
    expect(parseToggleArg("")).toBe("usage");
  });

  it("rejects anything else → usage (strict: no case-folding)", () => {
    for (const bad of ["ON", "On", "OFF ", "toggle", "start", "1", "on off", "on|off", "on,off", "restart"]) {
      expect(parseToggleArg(bad)).toBe("usage");
    }
  });
});

// AC-TOGGLE-1/2/3: state machine — OFF by default, on/off transitions, session-scoped reset.
describe("toggle state machine (AC-TOGGLE-1/2/3)", () => {
  it("starts OFF by default", () => {
    const t = createToggleState();
    expect(t.isOn()).toBe(false);
  });

  it("turnOn → ON", () => {
    const t = createToggleState();
    t.turnOn();
    expect(t.isOn()).toBe(true);
  });

  it("turnOff → OFF", () => {
    const t = createToggleState();
    t.turnOn();
    t.turnOff();
    expect(t.isOn()).toBe(false);
  });

  it("is idempotent (on→on, off→off)", () => {
    const t = createToggleState();
    t.turnOn();
    t.turnOn();
    expect(t.isOn()).toBe(true);
    t.turnOff();
    t.turnOff();
    expect(t.isOn()).toBe(false);
  });

  it("reset → OFF (new session / terminal close, AC-TOGGLE-3)", () => {
    const t = createToggleState();
    t.turnOn();
    t.reset();
    expect(t.isOn()).toBe(false);
  });

  it("can turn ON again after reset (fresh session)", () => {
    const t = createToggleState();
    t.turnOn();
    t.reset();
    t.turnOn();
    expect(t.isOn()).toBe(true);
  });
});

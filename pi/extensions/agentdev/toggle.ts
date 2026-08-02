/**
 * Toggle logic — pure, deterministic (unit-tested, TDD).
 * Spec: AC-TOGGLE-1..6 — only `on` | `off` are accepted (AC-TOGGLE-4);
 * state is OFF by default and session-scoped (AC-TOGGLE-3).
 */

export type ToggleAction = "on" | "off" | "usage";

/**
 * Parse the /agentdev argument. Strict: lowercase `on` | `off` after trimming;
 * anything else (including case variants) → usage.
 */
export function parseToggleArg(arg: string | undefined): ToggleAction {
  const trimmed = (arg ?? "").trim();
  if (trimmed === "on") return "on";
  if (trimmed === "off") return "off";
  return "usage";
}

export interface ToggleState {
  isOn(): boolean;
  turnOn(): void;
  turnOff(): void;
  /** Session-scoped: reset to OFF on new session / terminal close (AC-TOGGLE-3). */
  reset(): void;
}

export function createToggleState(): ToggleState {
  let on = false;
  return {
    isOn: () => on,
    turnOn: () => {
      on = true;
    },
    turnOff: () => {
      on = false;
    },
    reset: () => {
      on = false;
    },
  };
}

/**
 * choose-stack — stack selection for the manual phase (AC-MANUAL-1/2).
 * Existing repo → stack LOCKED from map-codebase. Greenfield → candidates
 * with rationale across three decision dimensions; choice validated.
 */

export interface StackRationale {
  performance: string;
  ecosystem: string;
  deploy: string;
}

export interface StackCandidate {
  id: string;
  name: string;
  rationale: StackRationale;
}

export interface StackChoice {
  stackId: string;
  reason: string;
}

export const STACK_CANDIDATES: StackCandidate[] = [
  {
    id: "typescript",
    name: "TypeScript (Node.js)",
    rationale: {
      performance: "Excellent async I/O; single-threaded but high throughput",
      ecosystem: "Huge npm ecosystem; first-class LLM/agent tooling",
      deploy: "Portable; easy containers; serverless-friendly",
    },
  },
  {
    id: "python",
    name: "Python",
    rationale: {
      performance: "Fast development; slower runtime; strong data/ML story",
      ecosystem: "Rich scientific/ML/automation ecosystem",
      deploy: "Ubiquitous hosting; simple",
    },
  },
  {
    id: "go",
    name: "Go",
    rationale: {
      performance: "Excellent runtime performance; low memory; fast compile",
      ecosystem: "Strong stdlib; great CLI/server ecosystem",
      deploy: "Single static binaries; trivial deploys",
    },
  },
  {
    id: "rust",
    name: "Rust",
    rationale: {
      performance: "Best-in-class performance and memory safety",
      ecosystem: "Growing ecosystem; higher implementation effort",
      deploy: "Static binaries; minimal footprint",
    },
  },
];

export type StackSelectionResult =
  | { kind: "locked"; stackId: string; source: "map-codebase" }
  | { kind: "choose"; candidates: StackCandidate[] };

export function resolveStackSelection(existingStack: string | null): StackSelectionResult {
  if (existingStack) {
    return { kind: "locked", stackId: existingStack, source: "map-codebase" };
  }
  return { kind: "choose", candidates: STACK_CANDIDATES };
}

/** Validate a recorded choice: known stack id + non-empty reason. */
export function validateStackChoice(choice: StackChoice): true {
  if (!choice.stackId || !STACK_CANDIDATES.some((c) => c.id === choice.stackId)) {
    throw new Error(`unknown stack id: ${choice.stackId}`);
  }
  if (!choice.reason || choice.reason.trim().length === 0) {
    throw new Error("stack choice requires a non-empty reason");
  }
  return true;
}

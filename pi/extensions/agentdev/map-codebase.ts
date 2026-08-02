/**
 * map-codebase (ARCHITECTURE.md §6, AC-MANUAL-1) — deterministic repo + stack
 * detection for the manual phase. An existing repo LOCKS its stack (never
 * suggested to change); greenfield goes to choose-stack.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

export interface CodebaseFacts {
  /** True when the cwd is inside an existing git repository. */
  existingRepo: boolean;
  /** Detected stack; null when unknown/greenfield. */
  stack: string | null;
  /** Evidence for the detection (file names). */
  evidence: string[];
}

export const STACK_SIGNATURES: { stack: string; files: string[] }[] = [
  { stack: "typescript", files: ["package.json", "tsconfig.json"] },
  { stack: "node", files: ["package.json"] },
  { stack: "python", files: ["pyproject.toml", "requirements.txt", "setup.py", "Pipfile"] },
  { stack: "go", files: ["go.mod"] },
  { stack: "rust", files: ["Cargo.toml"] },
  { stack: "java", files: ["pom.xml", "build.gradle"] },
  { stack: "ruby", files: ["Gemfile"] },
  { stack: "php", files: ["composer.json"] },
];

/** Deterministic detection — pure function over a probe callback (testable). */
export function detectCodebase(
  cwd: string,
  probe: (p: string) => boolean = (p) => existsSync(p),
): CodebaseFacts {
  const existingRepo = probe(join(cwd, ".git"));
  const evidence: string[] = [];
  let stack: string | null = null;
  for (const sig of STACK_SIGNATURES) {
    const found = sig.files.filter((f) => probe(join(cwd, f)));
    if (found.length > 0) {
      stack = sig.stack;
      evidence.push(...found);
      if (stack === "typescript") break; // most specific first
    }
  }
  return { existingRepo, stack, evidence };
}

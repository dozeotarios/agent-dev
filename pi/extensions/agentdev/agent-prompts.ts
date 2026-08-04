/**
 * agent prompts (ARCHITECTURE.md §8/§9) — the shared prompt builders used by
 * the orchestrator's real ports AND the agentic evals (single source of truth;
 * the evals previously duplicated these).
 */

import type { Role } from "./ralplan";
import type { ConstraintChecklist } from "./review";

/**
 * Granular touch-map schema (AC-PLAN-FILES): the plan must say exactly which
 * files are created, modified, and never touched — with the folder layout.
 */
export const FILE_PLAN_SCHEMA = `"filePlan": {
  "structure": "proposed folder layout for a NEW project, or the existing-layout anchor for an existing repo",
  "create": ["exact repo-root-relative paths of NEW files"],
  "modify": ["exact repo-root-relative paths of EXISTING files to change"],
  "doNotTouch": ["paths that must stay untouched"]
}`;

/** Planner preamble: inspect the REAL repo layout before anchoring paths. */
export const FILE_PLAN_INSPECT = `BEFORE emitting: if the repo has code, inspect its real layout (ls/read the tree) and anchor EVERY path in it — the crew builds exactly these files and nothing else. Be granular: files, not vague directories; include tests and configs in the touch map.`;

/** Replaces the planner's old JSON schema in prompts. */
export const STORIES_SCHEMA = `"stories": [ { "id": "story-1", "criteria": [2-3 testable strings], "bcps": 1-13 effort estimate, "verify": "runnable command proving this story", "files": { "create": [paths], "modify": [paths], "doNotTouch": [paths] } } x N ]`;

/** ELABORATE + scope outputs (map-codebase / define-language / scope-work). */
export const ELABORATE_SCHEMA = `"architecture": { "stack": string, "notes": string, "risks": [strings] }, "glossary": [ { "term": string, "definition": string } ], "scope": { "in": [strings], "out": [strings] }`;

/** Story-split instruction: DISJOINT files — parallel workers never overlap. */
export const STORIES_SPLIT = `SPLIT the work into stories (the worker count = stories.length, so split by how much work the plan has). Every story gets its own criteria and its own files. HARD RULE: no file may appear in the create/modify of TWO different stories — if two pieces of work touch the same file, they are ONE story. Include tests and configs in each story's files.`;

export const PLANNER_JSON_SCHEMA = `{ "principles": [3-5 strings], "drivers": [exactly 3 strings], "options": [{"name","pros":[...],"cons":[...]} x >=2], "adr": { "decision", "drivers":[...], "alternatives":[...], "why", "consequences":[...], "followups":[...] }, ${ELABORATE_SCHEMA}, ${FILE_PLAN_SCHEMA}, ${STORIES_SCHEMA}, "acceptanceCriteria": [>=3 testable strings] }`;

export const RALPLAN_ROLE_INSTRUCTIONS: Record<Role, string> = {
  planner:
    `You are the Planner in a consensus-planning loop. ` +
    `Emit ONLY JSON: ${PLANNER_JSON_SCHEMA}. No prose. ` +
    FILE_PLAN_INSPECT + " " + STORIES_SPLIT,
  architect:
    `You are the Architect in a consensus-planning loop (oh-my-claudecode style). ` +
    `Review the plan for architectural soundness. NEVER rubber-stamp the favored ` +
    `direction: provide (a) the strongest steelman ANTITHESIS against it, ` +
    `(b) at least one real TRADEOFF TENSION, (c) a SYNTHESIS when feasible. Reply with ` +
    `exactly: "SOUND" or "NEEDS WORK" on the first line, then "ANTITHESIS: ...", ` +
    `"TRADEOFF: ...", "SYNTHESIS: ..." (short lines, concrete, no filler).`,
  developer:
    `You are the Developer in a consensus-planning loop. Review the current plan for ` +
    `PRACTICAL FEASIBILITY, EFFICIENCY, and RELIABILITY: can a developer implement it ` +
    `as written? Is it the SMALLEST plan that satisfies the criteria (no gold-plating, ` +
    `no over-engineering, no unnecessary abstractions)? Do the acceptance criteria ` +
    `cover error handling, edge cases, and failure modes? Reply with exactly: "FEASIBLE" ` +
    `or "RISKY" on the first line, then "EFFICIENCY: ..." and "RELIABILITY: ..." and the ` +
    `main risk (short lines, concrete).`,
  critic:
    `You are the Critic — the final quality gate in a consensus-planning loop. A false ` +
    `approval costs 10-100x a false rejection, but a false rejection wastes a round. ` +
    `Evaluate: testable acceptance criteria, concrete verification, granular filePlan ` +
    `(exact create/modify paths anchored to the repo; vague paths are BLOCKING), ` +
    `principle-option consistency, and GAP ANALYSIS — what is MISSING, not just what ` +
    `is wrong. SELF-AUDIT your findings: drop low-confidence or refutable ones. Every ` +
    `blocking finding needs a concrete fix. Reply with EXACTLY one of "APPROVE", ` +
    `"ITERATE", "REJECT" and 1-3 short findings, each with a concrete fix.`,
};

export const RALPLAN_GOAL_PREFIX = (goal: string): string =>
  `You are the Planner in a consensus-planning loop. Goal: "${goal}". `;

/** Revision hint feeding ALL reviews back to the planner (closed loop, oh-my-claudecode style). */
export const RALPLAN_REVISION_HINT = (reviews: { role: string; content: string }[]): string =>
  `\nThe previous plan was NOT approved. Reviews (address EVERY point from ALL roles):\n${reviews
    .map((r) => `--- ${r.role.toUpperCase()} ---\n${r.content.slice(0, 1200)}`)
    .join("\n")}\nRevise the plan accordingly. Keep the JSON schema identical.`;

/** Current-plan hint for architect/developer/critic. */
export const RALPLAN_PLAN_HINT = (plan: string): string => `\nCurrent plan: ${plan.slice(0, 3000)}`;

/** Critic self-check hint: verify its own previous findings are addressed. */
export const RALPLAN_CRITIC_RECHECK = (previousCritique: string): string =>
  `\nYour previous critique was:\n${previousCritique}\nVerify EVERY point you raised is addressed in the revised plan. APPROVE only if all are addressed and you have no new blocking issues.`;

/** Build-time review prompt for one lens, with the operator's checklist (AC-REVIEW-5). */
export function reviewLensPrompt(
  lens: string,
  checklist: string[],
  codeContext: string,
): string {
  const rules = checklist.length > 0 ? checklist.map((c) => `- ${c}`).join("\n") : "(none)";
  return `You are the ${lens} reviewer in a code review (agentdev-review). Validate the code against this operator-defined checklist:
${rules}

Find BLOCKING issues. Reply with findings, one per line, each starting with exactly "BLOCKING: " or "NIT: ":

${codeContext.slice(0, 12_000)}`;
}

/** Subworker builder prompt (AC-DISPATCH-5: TDD-first implementation). */
export function builderPrompt(goal: string, storyId: string, criteria: string[]): string {
  return `You are a Subworker implementing ONE story of a plan.
Goal: "${goal}"
Your story: ${storyId}
Acceptance criteria for this slice:
${criteria.map((c) => `- ${c}`).join("\n")}

Work in the CURRENT directory (a git worktree). Follow the agentdev methodology (agentdev-build):
- develop tests FIRST: write the failing test, then implement until green (red-green-refactor, vertical slices).
- Tests must be F.I.R.S.T. (fast, isolated, repeatable, self-verifying, timely) — agentdev-verify runs the suite after you.
Do NOT commit. Do NOT touch files outside this worktree.
Reply with EXACTLY one line: "STORY_DONE" when your tests pass, or "STORY_BLOCKED: <reason>".`;
}

/** map-codebase stack detector prompt (existing repos). */
export const MAP_CODEBASE_PROMPT = (
  repoHint: string,
): string => `You are the Leader running map-codebase on an EXISTING repository.

${repoHint}

Inspect the repo and reply with EXACTLY one line: "STACK: <name>" (one of: typescript,
python, go, rust, java, ruby, php, other:<name>) — or "STACK: unknown".`;

/** define-language glossary prompt (AC-MANUAL-3, DDD ubiquitous language). */
export const DEFINE_LANGUAGE_PROMPT = (
  goal: string,
  context: string,
): string => `You are the Leader producing the DDD ubiquitous-language glossary for a goal.
Goal: "${goal}"
Context: ${context}
Reply with a glossary of EXACTLY 3-8 domain terms, one per line, format:
TERM: one-line definition (no prose outside the entries).`;

/** Escape hatch for goal text interpolated into prompts: frame it as data. */
export function frameUntrusted(text: string): string {
  return `<untrusted-data>
${text}
</untrusted-data>`;
}

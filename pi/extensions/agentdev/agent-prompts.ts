/**
 * agent prompts (ARCHITECTURE.md §8/§9) — the shared prompt builders used by
 * the orchestrator's real ports AND the agentic evals (single source of truth;
 * the evals previously duplicated these).
 */

import type { Role } from "./ralplan";
import type { ConstraintChecklist } from "./review";

export const RALPLAN_ROLE_INSTRUCTIONS: Record<Role, string> = {
  planner:
    `You are the Planner in a consensus-planning loop. ` +
    `Emit ONLY JSON: { "principles": [3-5 strings], "drivers": [exactly 3 strings], ` +
    `"options": [{"name","pros":[...],"cons":[...]} x >=2], "adr": { "decision", ` +
    `"drivers":[...], "alternatives":[...], "why", "consequences":[...], "followups":[...] }, ` +
    `"acceptanceCriteria": [>=3 testable strings] }. No prose.`,
  architect:
    `You are the Architect in a consensus-planning loop. Review the current plan for ` +
    `architectural soundness. Reply with ONE line: "SOUND" or "NEEDS WORK" plus one ` +
    `tradeoff you considered.`,
  "senior-dev":
    `You are the Senior Dev in a consensus-planning loop. Review the current plan for ` +
    `practical feasibility, idioms, and effort. Reply with ONE line: "FEASIBLE" or ` +
    `"RISKY" plus the main risk.`,
  critic:
    `You are the Critic in a consensus-planning loop. The plan must have testable ` +
    `acceptance criteria and concrete verification. Reply with EXACTLY one of ` +
    `"APPROVE", "ITERATE", "REJECT" and 1-3 short findings.`,
};

export const RALPLAN_GOAL_PREFIX = (goal: string): string =>
  `You are the Planner in a consensus-planning loop. Goal: "${goal}". `;

/** Revision hint that feeds the previous critique back to the planner (closed loop). */
export const RALPLAN_REVISION_HINT = (critique: string): string =>
  `\nThe previous plan was NOT approved. Critic review (address EVERY point):\n${critique}\nRevise the plan accordingly. Keep the JSON schema identical.`;

/** Current-plan hint for architect/senior-dev/critic. */
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

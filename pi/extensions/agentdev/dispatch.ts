/**
 * autopilot dispatch — Leader → Subleader → Subworker mapping (AC-DISPATCH-1/2/3).
 *
 * 1 approved plan → exactly 1 Subleader; each story → exactly 1 Subworker with
 * its own pooled worktree (never shared); completing a worker releases its
 * worktree back to the pool for reuse.
 */

import type { WorktreePool } from "./worktree";
import type { PlanOutput } from "./ralplan";

export interface Story {
  storyId: string;
}

export interface Plan {
  planId: string;
  stories: Story[];
}

export interface SubleaderAssignment {
  role: "subleader";
  planId: string;
}

export interface WorkerAssignment {
  role: "subworker";
  storyId: string;
  worktreePath: string;
}

export interface DispatchResult {
  subleader: SubleaderAssignment;
  workers: WorkerAssignment[];
}

export function dispatchPlan(plan: Plan, pool: WorktreePool): DispatchResult {
  if (plan.stories.length === 0) {
    throw new Error("plan must have at least one story");
  }
  const seen = new Set<string>();
  for (const story of plan.stories) {
    if (seen.has(story.storyId)) {
      throw new Error(`duplicate story id: ${story.storyId}`);
    }
    seen.add(story.storyId);
  }
  const workers: WorkerAssignment[] = [];
  try {
    for (const story of plan.stories) {
      workers.push({
        role: "subworker",
        storyId: story.storyId,
        worktreePath: pool.acquire(),
      });
    }
  } catch (e) {
    // Review closure: a mid-map acquire failure must not strand the leases
    // already taken — release them so the pool never shrinks permanently.
    for (const w of workers) pool.release(w.worktreePath);
    throw e;
  }
  return {
    subleader: { role: "subleader", planId: plan.planId },
    workers,
  };
}

/** Story done → release the worker's worktree back to the pool. */
export function completeWorker(worker: WorkerAssignment, pool: WorktreePool): void {
  pool.release(worker.worktreePath);
}

/**
 * ralplan → dispatch bridge (review closure): an approved consensus PlanOutput
 * becomes dispatchable stories. Deterministic slicing — one story per
 * acceptance criterion (grouped into chunks of `perStory` for larger plans).
 */
export function planToStories(plan: PlanOutput, perStory = 2): Story[] {
  const criteria = plan.acceptanceCriteria.filter((c) => c.trim().length > 0);
  if (criteria.length === 0) {
    throw new Error("plan has no acceptance criteria to slice into stories");
  }
  const stories: Story[] = [];
  for (let i = 0; i < criteria.length; i += perStory) {
    const chunk = criteria.slice(i, i + perStory);
    const label = chunk[0].replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "story";
    stories.push({ storyId: `story-${stories.length + 1}-${label}` });
  }
  return stories;
}

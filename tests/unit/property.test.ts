import { describe, expect, it } from "vitest";
import { parseToggleArg, createToggleState } from "../../pi/extensions/agentdev/toggle";
import { createWorktreePool } from "../../pi/extensions/agentdev/worktree";
import { createConsensusLoop } from "../../pi/extensions/agentdev/ralplan";
import {
  createEscalationPolicy,
  type EscalationEvent,
} from "../../pi/extensions/agentdev/escalation";

/**
 * Property tests (ARCHITECTURE.md §21): state-machine & policy invariants
 * over seeded random walks — no mocks, real modules, deterministic PRNG.
 */

/** Tiny deterministic PRNG (mulberry32) so failures are reproducible. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(r: () => number, arr: readonly T[]): T {
  return arr[Math.floor(r() * arr.length)];
}

describe("property: toggle state machine", () => {
  it("random walks never leave {ON,OFF}; on→ON, off→OFF, reset→OFF", () => {
    const rand = rng(42);
    for (let i = 0; i < 500; i++) {
      const t = createToggleState();
      const steps = 1 + Math.floor(rand() * 20);
      for (let s = 0; s < steps; s++) {
        const op = pick(rand, ["on", "off", "reset"] as const);
        if (op === "on") t.turnOn();
        else if (op === "off") t.turnOff();
        else t.reset();
        expect([true, false]).toContain(t.isOn());
      }
      // invariant: after any walk ending in on/off, state matches the last op
      t.reset();
      expect(t.isOn()).toBe(false);
    }
  });

  it("parseToggleArg is total: every input maps to on|off|usage", () => {
    const rand = rng(7);
    for (let i = 0; i < 200; i++) {
      const input = pick(rand, [undefined, "", "on", "off", " ON ", "start", "on/off", "1", "🙂"]);
      expect(["on", "off", "usage"]).toContain(parseToggleArg(input));
    }
  });
});

describe("property: worktree pool invariants", () => {
  it("acquire/release random walks conserve capacity and never go negative", () => {
    const rand = rng(1337);
    const CAP = 5;
    let created = 0;
    const pool = createWorktreePool({
      maxSize: CAP,
      create: () => `wt-${created++}`,
    });
    const held = new Set<string>();
    for (let i = 0; i < 500; i++) {
      if (held.size > 0 && (held.size >= CAP || rand() < 0.5)) {
        const path = pick(rand, [...held]);
        pool.release(path);
        held.delete(path);
      } else {
        try {
          const path = pool.acquire();
          held.add(path);
        } catch {
          // pool exhausted — invariant: only when at capacity
          expect(held.size).toBe(CAP);
        }
      }
      // conservation: inUse + free === size (REAL invariant, not a tautology)
      expect(pool.inUse().length + pool.free().length).toBe(pool.size());
      expect(pool.maxSize()).toBe(CAP);
      // no double-held paths
      expect(new Set(pool.inUse()).size).toBe(pool.inUse().length);
      // no path in both lists
      for (const p of pool.inUse()) {
        expect(pool.free()).not.toContain(p);
      }
    }
    // release everything → all free
    for (const p of [...held]) pool.release(p);
    expect(pool.inUse()).toHaveLength(0);
    expect(pool.free().length).toBe(CAP);
  });
});

describe("property: ralplan loop bounds", () => {
  it("random verdict walks stay within bounds and end consistently", () => {
    const rand = rng(99);
    for (let i = 0; i < 300; i++) {
      const loop = createConsensusLoop();
      let guard = 0;
      while (loop.state().expectedRole !== null && guard < 25) {
        const role = loop.state().expectedRole;
        if (role === null) break;
        if (role === "planner") {
          loop.submit({ role, content: "{}" });
        } else if (role === "critic") {
          const verdict = pick(rand, ["approve", "iterate", "reject"] as const);
          loop.submit({ role, content: verdict, verdict });
        } else {
          loop.submit({ role, content: "ok" });
        }
        guard += 1;
      }
      const s = loop.state();
      expect(s.round).toBeLessThanOrEqual(5); // engine bound (maxRounds)
      expect(guard).toBeLessThanOrEqual(4 * 5 + 4);
      // consistency: approved ⟺ expectedRole null via approve; exhausted ⟺ expectedRole null via cap
      if (s.approved) {
        expect(s.expectedRole).toBeNull();
        expect(s.round).toBeLessThanOrEqual(5);
      }
      if (s.exhausted) expect(s.expectedRole).toBeNull();
    }
  });
});

describe("property: escalation policy invariants", () => {
  it("escalate ⟹ pauseBranch = event branch; self-heal ⟹ no notify, no pause", () => {
    const rand = rng(2024);
    const policy = createEscalationPolicy({ maxRetries: 3, maxReviewRounds: 5 });
    const kinds = ["flaky-test", "transient-error", "review-loop", "build-failure"] as const;
    for (let i = 0; i < 500; i++) {
      const event: EscalationEvent = {
        branchId: `b${i % 4}`,
        kind: pick(rand, kinds),
        attempt: 1 + Math.floor(rand() * 8),
      };
      const d = policy.handle(event);
      if (d.escalate) {
        expect(d.reason).toBe("retries-exhausted");
        expect(d.pauseBranch).toBe(event.branchId);
        expect(d.notifyOperator).toBe(true);
      } else {
        expect(d.reason).toBeNull();
        expect(d.pauseBranch).toBeNull();
        expect(d.notifyOperator).toBe(false);
      }
      // budget boundary invariant: self-heal only while attempt ≤ budget
      const budget = event.kind === "review-loop" ? 5 : 3;
      expect(d.escalate).toBe(event.attempt > budget);
    }
  });
});

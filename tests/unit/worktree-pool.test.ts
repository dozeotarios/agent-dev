import { describe, expect, it } from "vitest";
import { createWorktreePool } from "../../pi/extensions/agentdev/worktree";

// §17 + AC-DISPATCH-3/4: pooled worktrees — never two workers on one worktree;
// released worktrees are REUSED (deps/cache preserved), FIFO, crash-safe.
describe("worktree pool (pool acquire/release)", () => {
  function pool(maxSize = 4, initial = 0) {
    let n = initial;
    return createWorktreePool({
      maxSize,
      create: () => `wt-${n++}`,
    });
  }

  it("acquires distinct worktrees until the pool is exhausted", () => {
    const p = pool(3);
    const a = p.acquire();
    const b = p.acquire();
    const c = p.acquire();
    expect(new Set([a, b, c]).size).toBe(3);
    expect(p.inUse()).toEqual([a, b, c]);
  });

  it("throws when the pool is exhausted (all in use, at max)", () => {
    const p = pool(2);
    p.acquire();
    p.acquire();
    expect(() => p.acquire()).toThrow(/exhausted/);
  });

  it("grows below maxSize instead of throwing", () => {
    const p = pool(5);
    for (let i = 0; i < 5; i++) p.acquire();
    expect(() => p.acquire()).toThrow(/exhausted/);
  });

  it("release returns the worktree to the pool; the SAME path is reused (cache preserved)", () => {
    const p = pool(4);
    const a = p.acquire();
    p.acquire();
    p.release(a);
    expect(p.inUse()).not.toContain(a);
    const next = p.acquire();
    expect(next).toBe(a); // FIFO reuse of the released worktree
  });

  it("FIFO order: first released is first re-acquired", () => {
    const p = pool(4);
    const a = p.acquire();
    const b = p.acquire();
    p.release(a);
    p.release(b);
    expect(p.acquire()).toBe(a);
    expect(p.acquire()).toBe(b);
  });

  it("double release is a no-op (crash-safe)", () => {
    const p = pool(4);
    const a = p.acquire();
    p.release(a);
    p.release(a);
    expect(p.free().filter((x) => x === a)).toHaveLength(1);
  });

  it("releasing an unknown path is a no-op", () => {
    const p = pool(4);
    p.release("/never/acquired");
    expect(p.inUse()).toHaveLength(0);
    expect(p.free()).toHaveLength(0);
  });

  it("tracks size: grows with each new creation, never beyond max", () => {
    const p = pool(3);
    p.acquire();
    p.acquire();
    expect(p.size()).toBe(2);
    p.release(p.inUse()[0]);
    p.acquire(); // reuses, no growth
    expect(p.size()).toBe(2);
  });
});

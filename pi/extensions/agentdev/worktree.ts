/**
 * worktree pool — treehouse-style reusable worktree management (§17,
 * AC-DISPATCH-3/4): one isolated git worktree per Subworker; released
 * worktrees are REUSED (deps/build-cache preserved), FIFO, crash-safe.
 *
 * Creator-agnostic: the `create` callback supplies real worktrees (raw git,
 * treehouse, or herdr `worktree create`) — the pool logic is deterministic.
 *
 * HARDENING (review closure): leases persist through an injected store
 * (the orchestrator wires `.agentdev/worktrees.json`), so a crash no longer
 * loses leases (stale `git worktree add` registrations collide on restart —
 * `pruneStaleLeases` + `git worktree prune` reconcile them). `free()` is now
 * exposed for the real conservation invariant.
 */

export interface WorktreeLeases {
  free: string[];
  used: string[];
}

export interface WorktreePool {
  /** Returns a worktree path; throws when exhausted (all in use, at max). */
  acquire(): string;
  /** Returns the path to the pool. Tolerant: unknown/double release = no-op (crash-safe). */
  release(path: string): void;
  inUse(): string[];
  free(): string[];
  size(): number;
  maxSize(): number;
}

export interface WorktreePoolOptions {
  maxSize: number;
  /** Creates a fresh worktree path (called when no free entry and below maxSize). */
  create: () => string;
  /** Optional durable lease store (crash-safe leases). */
  persist?: { load(): WorktreeLeases | null; save(leases: WorktreeLeases): void };
}

export function createWorktreePool(opts: WorktreePoolOptions): WorktreePool {
  const loaded = opts.persist?.load();
  const free: string[] = loaded?.free ?? [];
  const used = new Set<string>(loaded?.used ?? []);
  let count = used.size + free.length;

  const save = (): void => {
    opts.persist?.save({ free: [...free], used: [...used] });
  };

  return {
    acquire() {
      let path = free.shift();
      if (path === undefined) {
        if (count >= opts.maxSize) {
          throw new Error(`worktree pool exhausted (max ${opts.maxSize})`);
        }
        path = opts.create();
        count += 1;
      }
      used.add(path);
      save();
      return path;
    },
    release(path) {
      if (!used.has(path)) return; // tolerant: unknown/double release is a no-op
      used.delete(path);
      free.push(path);
      save();
    },
    inUse: () => [...used],
    free: () => [...free],
    size: () => count,
    maxSize: () => opts.maxSize,
  };
}

/**
 * Restart reconciliation for real git worktrees: paths that are no longer
 * registered in the repo (removed externally) are dropped from the leases;
 * the caller should also run `git worktree prune` in the repo to clean
 * stale `.git/worktrees` entries (AC-RESIL-1, worktree leases).
 */
export function pruneStaleLeases(
  leases: WorktreeLeases,
  livePaths: Set<string>,
): WorktreeLeases {
  return {
    free: leases.free.filter((p) => livePaths.has(p)),
    used: leases.used.filter((p) => livePaths.has(p)),
  };
}

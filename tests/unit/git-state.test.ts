import { describe, expect, it } from "vitest";
import {
  parsePorcelain,
  parseBranch,
  collectGitState,
} from "../../pi/extensions/agentdev/git-state";

// AC-GIT-3: the Leader maintains a durable map of all branches + uncommitted
// changes across crew worktrees.
describe("git-state map (AC-GIT-3)", () => {
  it("parses porcelain XY-status lines, including filenames with spaces", () => {
    const out = parsePorcelain(" M src/index.ts\n?? new file with spaces.txt\nA  staged.txt\n");
    expect(out).toEqual([
      { status: " M", file: "src/index.ts" },
      { status: "??", file: "new file with spaces.txt" },
      { status: "A ", file: "staged.txt" },
    ]);
  });

  it("empty porcelain output → no uncommitted entries", () => {
    expect(parsePorcelain("")).toEqual([]);
  });

  it("parses the current branch; empty → detached/null", () => {
    expect(parseBranch("feature/auth\n")).toBe("feature/auth");
    expect(parseBranch("")).toBeNull();
  });

  it("collects the full map across crew worktrees", () => {
    const map = collectGitState([
      { path: "/wt/a", branch: "feat-a", uncommitted: [{ status: " M", file: "x.ts" }] },
      { path: "/wt/b", branch: null, uncommitted: [] },
    ]);
    expect(map.worktrees).toHaveLength(2);
    expect(map.worktrees[0].branch).toBe("feat-a");
    expect(map.worktrees[1].uncommitted).toEqual([]);
  });
});

import { describe, expect, it } from "vitest";
import {
  roleLabel,
  parseRoleFromLabel,
  ROLE_PREFIXES,
} from "../../pi/extensions/agentdev/roles";

// AC-VIS-2: role-prefix label convention L:/S:/W:/R: with the hierarchy path.
describe("role labels (AC-VIS-2)", () => {
  it("leader → L:<project>", () => {
    expect(roleLabel("leader", "agentdev")).toBe("L:agentdev");
  });
  it("subleader → S:<project>/<plan>", () => {
    expect(roleLabel("subleader", "agentdev/auth")).toBe("S:agentdev/auth");
  });
  it("subworker → W:<project>/<plan>/<story>", () => {
    expect(roleLabel("subworker", "agentdev/auth/login")).toBe("W:agentdev/auth/login");
  });
  it("reviewer → R:<path>#<lens>, and plain without lens", () => {
    expect(roleLabel("reviewer", "agentdev/auth/login", "security")).toBe("R:agentdev/auth/login#security");
    expect(roleLabel("reviewer", "agentdev/auth/login")).toBe("R:agentdev/auth/login");
  });
  it("prefixes map 1:1 to roles", () => {
    expect(ROLE_PREFIXES).toEqual({ leader: "L", subleader: "S", subworker: "W", reviewer: "R" });
  });

  it("parseRoleFromLabel round-trips every role", () => {
    for (const [label, role] of [
      ["L:agentdev", "leader"],
      ["S:agentdev/auth", "subleader"],
      ["W:agentdev/auth/login", "subworker"],
      ["R:agentdev/auth/login#security", "reviewer"],
    ] as const) {
      const parsed = parseRoleFromLabel(label);
      expect(parsed).not.toBeNull();
      expect(parsed?.role).toBe(role);
    }
  });

  it("parseRoleFromLabel returns null for invalid labels", () => {
    for (const bad of ["", "X:proj", "L", "L:", "leader:proj", "L:proj:extra", "#lens"]) {
      expect(parseRoleFromLabel(bad), bad).toBeNull();
    }
  });
});

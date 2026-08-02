/**
 * role labels (ARCHITECTURE.md §10, AC-VIS-2).
 *
 * Role-prefix convention: L:<project> · S:<project>/<plan> ·
 * W:<project>/<plan>/<story> · R:<project>/<plan>/<story>#<lens>.
 * The path encodes the hierarchy; the prefix encodes the role.
 */

export type Role = "leader" | "subleader" | "subworker" | "reviewer";

export const ROLE_PREFIXES: Record<Role, string> = {
  leader: "L",
  subleader: "S",
  subworker: "W",
  reviewer: "R",
};

export interface RoleLabelPath {
  role: Role;
  path: string;
  lens?: string;
}

export function roleLabel(role: Role, path: string, lens?: string): string {
  const prefix = ROLE_PREFIXES[role];
  if (role === "reviewer") {
    return `${prefix}:${path}${lens ? `#${lens}` : ""}`;
  }
  return `${prefix}:${path}`;
}

const PREFIX_TO_ROLE: Record<string, Role> = {
  L: "leader",
  S: "subleader",
  W: "subworker",
  R: "reviewer",
};

export function parseRoleFromLabel(label: string): RoleLabelPath | null {
  // Strict: prefix + path (no ':' or '#') + optional #lens (no '#').
  const match = label.match(/^([LSWR]):([^:#]+)(?:#([^#]+))?$/);
  if (!match) return null;
  const role = PREFIX_TO_ROLE[match[1]];
  if (!role || match[2].length === 0) return null;
  return { role, path: match[2], lens: match[3] };
}

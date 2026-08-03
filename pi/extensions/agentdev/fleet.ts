/**
 * fleet overview + attention list (ARCHITECTURE.md §10, AC-VIS-4/5).
 *
 * The live org-tree (project → plan → story) with role + state, rendered from
 * fleet state; the attention list surfaces blocked / needs-you nodes.
 *
 * HARDENING (review closure): no phantom fields (label is derived at render
 * time only), no live-object leaks (node()/nodes() return copies so callers
 * cannot bypass setStatus validation), and a removeNode path so autoclosed /
 * dismissed nodes leave fleet state instead of accumulating forever.
 */

import { roleLabel, type Role } from "./roles";

export type NodeStatus = "working" | "blocked" | "done" | "idle" | "unknown";

export const STATUS_GLYPHS: Record<NodeStatus, string> = {
  working: "●",
  blocked: "⛔",
  done: "✓",
  idle: "·",
  unknown: "?",
};

export interface FleetNode {
  id: string;
  role: Role;
  /** Hierarchy path (project / project/plan / project/plan/story). */
  path: string;
  status: NodeStatus;
  paneId: string | null;
}

export interface Fleet {
  addNode(node: FleetNode): FleetNode;
  setStatus(id: string, status: NodeStatus): void;
  /** Record the real herdr pane backing a role node (crew spawns). */
  setPaneId(id: string, paneId: string): void;
  node(id: string): FleetNode | undefined;
  nodes(): FleetNode[];
  /** Remove a node (autoclose/dismiss); unknown id is a no-op. */
  removeNode(id: string): void;
  renderTree(): string;
  attentionList(): FleetNode[];
}

export const VALID_STATUSES: NodeStatus[] = ["working", "blocked", "done", "idle", "unknown"];
export const VALID_ROLES: Role[] = ["leader", "subleader", "subworker", "reviewer"];

/** Structural validation for nodes loaded from disk (AC-STATE/AC-RESIL-1). */
export function isValidFleetNode(n: unknown): n is FleetNode {
  if (typeof n !== "object" || n === null) return false;
  const node = n as Record<string, unknown>;
  return (
    typeof node.id === "string" &&
    node.id.length > 0 &&
    typeof node.role === "string" &&
    (VALID_ROLES as string[]).includes(node.role) &&
    typeof node.path === "string" &&
    typeof node.status === "string" &&
    (VALID_STATUSES as string[]).includes(node.status) &&
    (node.paneId === null || typeof node.paneId === "string")
  );
}

function copy(n: FleetNode): FleetNode {
  return { ...n };
}

export function createFleet(): Fleet {
  const nodes = new Map<string, FleetNode>();

  const sorted = () =>
    [...nodes.values()].sort((a, b) => {
      const da = a.path.split("/").length;
      const db = b.path.split("/").length;
      return da - db || a.path.localeCompare(b.path) || a.id.localeCompare(b.id);
    });

  return {
    addNode(node) {
      if (nodes.has(node.id)) throw new Error(`duplicate fleet node: ${node.id}`);
      if (!(VALID_ROLES as string[]).includes(node.role)) {
        throw new Error(`unknown fleet role: ${String(node.role)}`);
      }
      if (!(VALID_STATUSES as string[]).includes(node.status)) {
        throw new Error(`unknown fleet status: ${String(node.status)}`);
      }
      const stored: FleetNode = { ...node };
      nodes.set(node.id, stored);
      return copy(stored);
    },
    setStatus(id, status) {
      if (!VALID_STATUSES.includes(status)) {
        throw new Error(`unknown fleet status: ${String(status)}`);
      }
      const node = nodes.get(id);
      if (!node) throw new Error(`unknown fleet node: ${id}`);
      node.status = status;
    },
    setPaneId(id, paneId) {
      const node = nodes.get(id);
      if (!node) throw new Error(`unknown fleet node: ${id}`);
      node.paneId = paneId;
    },
    node: (id) => {
      const n = nodes.get(id);
      return n ? copy(n) : undefined;
    },
    nodes: () => [...nodes.values()].map(copy),
    removeNode(id) {
      nodes.delete(id); // tolerant: unknown id is a no-op
    },
    renderTree() {
      return sorted()
        .map((n) => `${"  ".repeat(n.path.split("/").length - 1)}${STATUS_GLYPHS[n.status]} ${roleLabel(n.role, n.path)}`)
        .join("\n");
    },
    attentionList: () => sorted().filter((n) => n.status === "blocked").map(copy),
  };
}

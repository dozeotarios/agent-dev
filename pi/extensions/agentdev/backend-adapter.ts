import { execFileSync } from "node:child_process";

/**
 * BackendAdapter — the sole touchpoint between agentdev and herdr (AC-SCOPE-2).
 *
 * Grounded in the REAL herdr 0.7.5 CLI (JSON RPC over the control socket):
 *   workspace create --cwd --label   → {result: {workspace_id, tab_id, root_pane}}
 *   pane rename <id> <label>          → {result: {pane}}
 *   pane run <id> <cmd...>            → (empty on success; herdr plain-joins the
 *                                       args and the pane shell re-parses them)
 *   pane read <id> --source <src>     → plain terminal text
 *   pane get <id>                     → {result: {pane: {agent_status, label, ...}}}
 *   agent wait <id> --until --timeout → {result} | {error: {code: "agent_not_found"}}
 *   pane close <id> / workspace close <id> → {result: {type: "ok"}} | {error}
 *
 * HARDENING CONTRACT (harsh-review closure):
 * - Errors ALWAYS surface as HerdrError — never raw TypeError, never as data.
 *   paneRead detects RPC error envelopes and throws instead of returning them
 *   as "terminal text".
 * - paneRun passes the command through UNSPLIT (herdr re-joins argv with spaces
 *   into the pane shell; splitting on whitespace destroyed quoting). Commands
 *   with control characters/newlines are rejected by validatePaneCommand.
 * - agentWait distinguishes agent-not-found/timeout (false) from infrastructure
 *   failure (rethrows exec_failed / invalid_rpc) — a dead server is never
 *   mistaken for "agent still working".
 * - parseRpc throws invalid_rpc on empty output for every command that requires
 *   a result envelope (only paneRun legitimately prints nothing), and validates
 *   the required result fields per command (no silent `undefined` drift).
 * - parseRpcTolerant swallows ONLY pane_not_found / workspace_not_found (the two
 *   idempotent-close codes) — never any other *_not_found.
 * - runWithErrorEnvelope only treats output as an RPC envelope when it actually
 *   parses as JSON with an error/result key.
 * - createHerdrAdapter(opts.checkVersion) gates on herdr >=0.7.5 <0.8.
 */

export type Runner = (args: string[], opts?: { timeoutMs?: number }) => string;

export class HerdrError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "HerdrError";
  }
}

export interface WorkspaceRef {
  workspaceId: string;
  tabId: string;
  paneId: string;
}

export interface PaneInfo {
  paneId: string;
  label?: string;
  agentStatus?: string;
  cwd?: string;
}

export type AgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";

export interface WaitOptions {
  until: AgentStatus;
  timeoutMs: number;
}

export interface RunResult {
  /** Shell exit code of the command in the pane (via completion sentinel). */
  exitCode: number | null;
  /** Terminal output captured up to the sentinel (sentinel line removed). */
  output: string;
  /** True when the sentinel was observed; false on timeout. */
  completed: boolean;
}

export interface BackendAdapter {
  herdrVersion(): string;
  assertHerdrVersion(): void;
  workspaceCreate(opts: { cwd: string; label: string }): WorkspaceRef;
  paneRename(paneId: string, label: string): void;
  /** Pass the command through UNSPLIT to the pane shell (quotes preserved). */
  paneRun(paneId: string, command: string): void;
  /** Run a command and wait for a completion sentinel; returns the exit code. */
  paneRunAndWait(paneId: string, command: string, opts?: { timeoutMs?: number }): RunResult;
  paneRead(
    paneId: string,
    opts?: { source?: "visible" | "recent" | "recent-unwrapped" | "detection" },
  ): string;
  paneGet(paneId: string): PaneInfo;
  paneList(): { paneId: string; workspaceId: string; agentStatus?: string }[];
  agentWait(paneId: string, opts: WaitOptions): boolean;
  paneClose(paneId: string): void;
  workspaceClose(workspaceId: string): void;
}

const defaultRunner: Runner = (args, opts) =>
  execFileSync("herdr", args, {
    encoding: "utf8",
    timeout: opts?.timeoutMs ?? 30_000,
  });

interface RpcEnvelope<T> {
  result?: T;
  error?: { code: string; message: string };
}

/** Reject control characters that would break single-line shell execution. */
export function validatePaneCommand(command: string): void {
  if (!command.trim()) throw new HerdrError("invalid_command", "pane command must not be empty");
  if (/[\n\r\u0000]/.test(command)) {
    throw new HerdrError("invalid_command", "pane command must not contain newlines or NUL");
  }
}

function parseRpc<T>(raw: string, command: string, opts?: { allowEmpty?: boolean }): T {
  if (!raw.trim()) {
    if (opts?.allowEmpty) return undefined as T;
    // Only paneRun legitimately prints nothing; everything else requires a result.
    throw new HerdrError("invalid_rpc", `${command}: empty response`);
  }
  let envelope: RpcEnvelope<T>;
  try {
    envelope = JSON.parse(raw) as RpcEnvelope<T>;
  } catch {
    throw new HerdrError("invalid_rpc", `${command}: non-JSON response: ${raw.slice(0, 200)}`);
  }
  if (envelope.error) {
    throw new HerdrError(envelope.error.code, envelope.error.message);
  }
  if (envelope.result === undefined) {
    throw new HerdrError("invalid_rpc", `${command}: response missing result: ${raw.slice(0, 200)}`);
  }
  return envelope.result as T;
}

/** Tolerate ONLY the two idempotent-close codes; everything else propagates. */
function parseRpcTolerant(raw: string, command: string): void {
  try {
    parseRpc(raw, command);
  } catch (e) {
    if (
      e instanceof HerdrError &&
      (e.code === "pane_not_found" || e.code === "workspace_not_found")
    ) {
      return;
    }
    throw e;
  }
}

/** Only treat output as an RPC envelope when it parses and has error/result. */
function looksLikeEnvelope(text: string): boolean {
  const t = text.trim();
  if (!t.startsWith("{")) return false;
  try {
    const j = JSON.parse(t) as { error?: unknown; result?: unknown };
    return j.error !== undefined || j.result !== undefined;
  } catch {
    return false;
  }
}

function runWithErrorEnvelope(runner: Runner, args: string[], timeoutMs?: number): string {
  try {
    return runner(args, { timeoutMs });
  } catch (e) {
    // Our own spawn timeout (execFileSync kills with SIGTERM): a wait that ran
    // out of budget is a "not yet" — surfaced as a distinct timeout code.
    if ((e as { killed?: boolean }).killed === true) {
      throw new HerdrError("timeout", `command timed out after ${timeoutMs}ms: ${args.slice(0, 3).join(" ")}`);
    }
    const err = e as { stdout?: unknown; stderr?: unknown; message?: string };
    const envelope = [err.stderr, err.stdout]
      .filter((v): v is string | Buffer => v !== undefined && v !== null)
      .map((v) => String(v))
      .find((s) => looksLikeEnvelope(s));
    if (envelope) return envelope;
    if (e instanceof HerdrError) throw e;
    throw new HerdrError("exec_failed", err.message ?? String(e));
  }
}

const MIN_HERDR = "0.7.5";
const MAX_HERDR = "0.8.0";

function compareSemver(a: string, b: string): number {
  const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  }
  return 0;
}

export interface AdapterOptions {
  /** Gate on herdr >=0.7.5 <0.8 at construction (off by default so unit fakes work). */
  checkVersion?: boolean;
}

export function createHerdrAdapter(
  runner: Runner = defaultRunner,
  opts: AdapterOptions = {},
): BackendAdapter {
  const run = (args: string[], timeoutMs?: number): string =>
    runWithErrorEnvelope(runner, args, timeoutMs);

  const assertHerdrVersion = (): void => {
    const v = run(["--version"]).match(/\d+\.\d+\.\d+/)?.[0] ?? "";
    if (compareSemver(v, MIN_HERDR) < 0 || compareSemver(v, MAX_HERDR) >= 0) {
      throw new HerdrError(
        "unsupported_version",
        `herdr ${v || "?"} outside supported range [${MIN_HERDR}, ${MAX_HERDR})`,
      );
    }
  };
  if (opts.checkVersion) assertHerdrVersion();

  return {
    herdrVersion(): string {
      const raw = run(["--version"]);
      return raw.match(/\d+\.\d+\.\d+/)?.[0] ?? raw.trim();
    },
    assertHerdrVersion,

    workspaceCreate({ cwd, label }: { cwd: string; label: string }): WorkspaceRef {
      const raw = run(["workspace", "create", "--cwd", cwd, "--label", label]);
      const result = parseRpc<{
        root_pane: { pane_id: string };
        tab: { tab_id: string };
        workspace: { workspace_id: string };
      }>(raw, "workspace create");
      if (!result.workspace?.workspace_id || !result.tab?.tab_id || !result.root_pane?.pane_id) {
        throw new HerdrError("invalid_rpc", `workspace create: missing fields: ${raw.slice(0, 200)}`);
      }
      return {
        workspaceId: result.workspace.workspace_id,
        tabId: result.tab.tab_id,
        paneId: result.root_pane.pane_id,
      };
    },

    paneRename(paneId: string, label: string): void {
      parseRpc(run(["pane", "rename", paneId, label]), "pane rename");
    },

    paneRun(paneId: string, command: string): void {
      validatePaneCommand(command);
      // UNSPLIT: herdr plain-joins argv with spaces and the pane shell re-parses
      // them, so the raw command string preserves quotes and shell syntax.
      parseRpc(run(["pane", "run", paneId, command]), "pane run", { allowEmpty: true });
    },

    paneRunAndWait(paneId: string, command: string, opts?: { timeoutMs?: number }): RunResult {
      validatePaneCommand(command);
      const timeoutMs = opts?.timeoutMs ?? 60_000;
      const sentinel = "__AGENTDEV_EXIT_$?__";
      const deadline = Date.now() + timeoutMs;
      // Subshell wrapper: `exit`-style commands terminate only the subshell, so
      // the sentinel still runs and captures the command's real exit code.
      this.paneRun(paneId, `( ${command} ); echo ${sentinel}`);
      let output = "";
      let completed = false;
      while (Date.now() < deadline) {
        let chunk: string;
        try {
          chunk = this.paneRead(paneId, { source: "recent-unwrapped" });
        } catch {
          return { exitCode: null, output, completed: false }; // pane died mid-run
        }
        output = chunk;
        const m = chunk.match(/__AGENTDEV_EXIT_(\d+)__/);
        if (m) {
          completed = true;
          output = chunk.replace(/__AGENTDEV_EXIT_\d+__\s*$/, "").trimEnd();
          return { exitCode: parseInt(m[1], 10), output, completed };
        }
        // small bounded sleep so we don't hammer the CLI
        const end = Date.now() + 250;
        while (Date.now() < end) {
          /* burn */
        }
      }
      return { exitCode: null, output, completed: false };
    },

    paneRead(
      paneId: string,
      opts?: { source?: "visible" | "recent" | "recent-unwrapped" | "detection" },
    ): string {
      const raw = run(["pane", "read", paneId, "--source", opts?.source ?? "recent-unwrapped"]);
      // A dead/missing pane makes the CLI print the RPC error envelope (stderr,
      // surfaced by runWithErrorEnvelope): throw instead of returning it as text.
      if (looksLikeEnvelope(raw)) {
        parseRpc(raw, "pane read"); // throws HerdrError on envelope.error
      }
      return raw;
    },

    paneGet(paneId: string): PaneInfo {
      const raw = run(["pane", "get", paneId]);
      const result = parseRpc<{
        pane: {
          pane_id: string;
          label?: string;
          agent_status?: string;
          cwd?: string;
        };
      }>(raw, "pane get");
      if (!result.pane?.pane_id) {
        throw new HerdrError("invalid_rpc", `pane get: missing pane_id: ${raw.slice(0, 200)}`);
      }
      // Real CLI shape is snake_case; map to the adapter's camelCase contract.
      return {
        paneId: result.pane.pane_id,
        label: result.pane.label,
        agentStatus: result.pane.agent_status,
        cwd: result.pane.cwd,
      };
    },

    paneList(): { paneId: string; workspaceId: string; agentStatus?: string }[] {
      const raw = run(["pane", "list"]);
      const result = parseRpc<{
        panes: { pane_id: string; workspace_id: string; agent_status?: string }[];
      }>(raw, "pane list");
      if (!Array.isArray(result.panes)) {
        throw new HerdrError("invalid_rpc", `pane list: missing panes array: ${raw.slice(0, 200)}`);
      }
      return result.panes.map((p) => ({
        paneId: p.pane_id,
        workspaceId: p.workspace_id,
        agentStatus: p.agent_status,
      }));
    },

    agentWait(paneId: string, opts: WaitOptions): boolean {
      // Taxonomy: agent_not_found / wait-timeout → false ("not there yet");
      // infrastructure failure (exec_failed, invalid_rpc) → rethrow so the
      // caller can distinguish "herdr is down" from "agent is busy".
      let raw: string;
      try {
        raw = run(
          ["agent", "wait", paneId, "--until", opts.until, "--timeout", String(opts.timeoutMs)],
          opts.timeoutMs + 5_000,
        );
      } catch (e) {
        if (e instanceof HerdrError) {
          if (e.code === "agent_not_found" || e.code === "timeout") return false;
          throw e; // exec_failed / invalid_rpc / unsupported_version
        }
        return false; // non-envelope failure ≈ wait timed out
      }
      if (!raw.trim()) return false; // empty ≠ reached state
      try {
        parseRpc(raw, "agent wait");
        return true;
      } catch (e) {
        if (e instanceof HerdrError && e.code === "agent_not_found") return false;
        throw e;
      }
    },

    paneClose(paneId: string): void {
      parseRpcTolerant(run(["pane", "close", paneId]), "pane close");
    },

    workspaceClose(workspaceId: string): void {
      parseRpcTolerant(run(["workspace", "close", workspaceId]), "workspace close");
    },
  };
}

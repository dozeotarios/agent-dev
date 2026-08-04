# agentdev — Installation & Usage

agentdev is a **pi extension** (the brain) that drives **herdr** (the body) to
run a hierarchical crew of coding agents. You give it a goal; it plans with
you, then dispatches Subleaders, Subworkers, and Reviewers that build,
verify, and review until clean — stopping at **commit-ready** for your
confirmation.

This document explains how to install, launch, and use agentdev. It applies
to Linux, WSL, and Windows.

---

## 1. Requirements

| Tool | Minimum | Notes |
|---|---|---|
| Node.js | 20 | Required by pi and agentdev |
| herdr | 0.7.5 – 0.8.0 | Installed automatically if missing |
| pi | 0.83.0 | Installed automatically if missing |

You also need a model provider configured in pi for the crew to work (the
first launch tells you how: `/login` inside pi).

---

## 2. Install

### Option A — global install (recommended)

```bash
npm i -g @agent-dev/agentdev
```

This installs the `agentdev` command on your PATH.

### Option B — run without installing (npx)

```bash
npx @agent-dev/agentdev install
```

### Option C — from source

```bash
git clone https://github.com/dozeotarios/agent-dev
cd agentdev
./setup.sh          # Linux / WSL
# or: .\setup.ps1   # Windows PowerShell
```

`setup.sh` / `setup.ps1` install herdr first (if missing), then register the
extension and its skills into pi.

The installer is **idempotent**: it installs only what is missing and uses
whatever is already installed. If you already have pi, it only registers the
extension. If you already have herdr, it only starts the server.

---

## 3. Launch

```bash
agentdev
```

Typing `agentdev` does everything for you:

1. Checks herdr — installs it if missing, verifies the supported version.
2. Starts the herdr server if it is not running.
3. Checks pi — installs it if missing.
4. Registers the agentdev extension and skills if missing.
5. Opens **herdr as your terminal surface**, with pi already running inside
   its `agentdev` workspace pane, crew **ON**. Click the pi pane to interact;
   crew panes (`L:` / `S:` / `W:` / `R:`) appear alongside as goals start.
   Close herdr any time and run `agentdev` (or `herdr`) again to reattach —
   pi and the crew keep running.

If you do not have a model provider configured yet, pi asks you to log in
(`/login`) — do that once, then continue.

### Passing arguments to pi

Everything after `agentdev` is passed to pi:

```bash
agentdev -p "Reply with exactly: OK"     # headless run, crew ON
agentdev --mode rpc get_commands         # scripting / automation
```

---

## 4. Command reference

| Command | What it does |
|---|---|
| `agentdev` | Ensure everything, then launch pi with the crew ON |
| `agentdev install` | Idempotent setup — installs only what is missing |
| `agentdev install --check` | Verify-only report — changes nothing |
| `agentdev doctor` | Status report: herdr, pi, extension, server |
| `agentdev version` | Print the installed version |
| `agentdev help` | Show this command summary |

### Crew commands (inside pi, while ON)

| Command | What it does |
|---|---|
| `/agentdev on` | Turn the crew on (message = goal) |
| `/agentdev off` | Back to plain pi |
| `/agentdev status` | List goals and their pipeline step |
| `/agentdev confirm <goal-id>` | Accept the commit-ready gate → commits |
| `/agentdev resume` | Reconcile panes and resume after a restart |

---

## 5. How the crew works

```
MANUAL (you + Leader)                AUTOPILOT (to commit-ready)
  map-codebase / choose-stack   →    ralplan consensus
  define-language (DDD)               Planner → Architect → Developer → Critic
  define-constraints (risk interview) → dispatch Subleaders → Subworkers build
  pick project mode                   → verify → 6-lens review until clean
                                      → stop at commit-ready → your confirm
```

- **Project modes:** `no-mistakes` · `direct-PR` (default) · `local-only` ·
  `+yolo` (auto-commits, opt-in).
- **Hierarchy:** Leader (liaison) → Subleader (1 plan) → Subworker (1 story,
  own git worktree); Reviewers are leaves.
- **Visibility:** every role is a real herdr pane, role-labeled
  (`L:` / `S:` / `W:` / `R:`), with live state. Clean completion autocloses;
  failures stay open until handled.
- **Safety:** no autonomous commits by default — the crew stops at
  commit-ready and commits only after your `/agentdev confirm`. `main` is
  protected (guard-git + a pre-commit hook refuse destructive/direct-main
  operations).

---

## 6. Restart & resume

Everything is persisted under `.agentdev/` in the project:

- herdr keeps panes alive even if the terminal closes.
- On the next launch, `agentdev resume` (or automatic resume) reconciles
  live panes and continues the goal from where it stopped.
- Commits are deduplicated per worktree — a crash between your confirmation
  and the commit cannot double-commit.

---

## 7. Troubleshooting

| Problem | Fix |
|---|---|
| `agentdev doctor` shows something missing | Run `agentdev install` |
| herdr version error | Update herdr (`herdr update`); supported range 0.7.5–0.8.0 |
| pi asks for a model | Run `/login` inside pi once |
| Goal fails mid-pipeline | `agentdev status`, then `/agentdev resume` |
| Crew never commits | Check the goal is at `gate` step, then `/agentdev confirm <goal-id>` |
| Extension not loading | `agentdev install` (re-registers the brain) |

---

## 8. Uninstall

```bash
npm rm -g @agent-dev/agentdev
herdr server stop        # optional: stop the headless server
```

Remove the pi registration if desired:

```bash
pi uninstall @agent-dev/agentdev
```

---

## References

- Design & architecture: [`ARCHITECTURE.md`](ARCHITECTURE.md)
- Acceptance criteria (binding): [`specs/acceptance-criteria.md`](specs/acceptance-criteria.md)
- Development notes: [`DEVELOPMENT.md`](DEVELOPMENT.md)
- herdr: https://herdr.dev

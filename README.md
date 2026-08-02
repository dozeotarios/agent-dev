# agentdev

A pi extension that runs a small crew of coding agents on top of herdr. You
give it a goal. It plans with you, then dispatches workers that build, test
and review the work until it is clean and ready for you to approve the
commits. Every agent runs in its own herdr pane, so you can watch what is
happening and jump in whenever you want.

## Quick start

Install the launcher once, then just type `agentdev`:

```bash
npm i -g @agent-dev/agentdev
agentdev
```

The first launch installs whatever is missing. herdr goes in first, then pi,
then the extension itself, and the herdr server is started if it isn't
running. After that, pi opens with the crew already on. If pi asks you to log
in to a model provider, you do that once and you're set.

No global install? The same flow works through npx:

```bash
npx @agent-dev/agentdev install
npx @agent-dev/agentdev
```

Or from a clone:

```bash
git clone https://github.com/dozeotarios/agent-dev
cd agentdev
./setup.sh
```

## What happens after you give it a goal

The first part is shared with you. The leader checks the repository (or helps
you pick a stack for a new one), builds a small glossary of the domain, runs
a risk interview, and asks which project mode you want.

Then the autopilot takes over. A consensus loop with a Planner, an Architect,
a Senior Dev and a Critic produces a plan. The plan is sliced into stories,
and each story gets its own git worktree and a Subworker. Once the code
builds and the tests pass, six reviewers look at it from different angles:
code quality, efficiency, security, API shape, reliability and domain. The
loop keeps going until nothing actionable is left.

Then everything stops. Nothing gets committed until you confirm, unless you
chose `+yolo`, which commits on its own.

## Commands

Inside pi, with the crew on:

1. `/agentdev on` turns the crew on. Every message becomes a goal.
2. `/agentdev status` shows the goals and where each one is.
3. `/agentdev confirm <goal>` accepts the commit-ready gate, so the commits
   actually happen.
4. `/agentdev resume` picks the work back up after a restart.

The launcher also understands `agentdev doctor` (the state of your setup),
`agentdev install`, and `agentdev version`.

## Project modes

`direct-PR` is the default: stop at commit-ready, commit on confirm. The
others are `no-mistakes`, `local-only`, and `+yolo` (auto-commits).

## More

Full instructions: [INSTRUCTIONS.md](INSTRUCTIONS.md)

Design and acceptance criteria: [ARCHITECTURE.md](ARCHITECTURE.md),
[specs/acceptance-criteria.md](specs/acceptance-criteria.md)

Development notes: [DEVELOPMENT.md](DEVELOPMENT.md)

Works on Linux, WSL and Windows.

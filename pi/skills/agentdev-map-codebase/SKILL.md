---
name: agentdev-map-codebase
description: Analyze an EXISTING repository for the agentdev crew — detect the stack, architecture, and risk signals, and LOCK the stack for the goal. Greenfield goals skip this and use agentdev-choose-stack instead.
---

# agentdev-map-codebase (manual phase — AC-MANUAL-1)

## When to use
Run at the START of every goal that targets a repo with existing code. The
Leader runs this before planning. For greenfield (empty) repos, skip this and
run `agentdev-choose-stack`.

## Procedure
1. Inspect the repo root: `package.json`, `Cargo.toml`, `pyproject.toml`,
   `go.mod`, `*.csproj`, `requirements.txt`, lockfiles, and the file tree.
2. Identify: runtime + framework, test command, build step, key libraries
   (ORM, auth, state, UI), and any gray areas (error handling, API shapes,
   config). Do NOT assume — read the code.
3. Determine the stack id: `typescript` · `python` · `go` · `rust`
   (first match wins; unknown → `null`).
4. Record `{ existingRepo: true, stack, notes }`.
5. **LOCK the stack**: existing codebases never change language for a goal.

## Output
`{ existingRepo: boolean, stack: string | null, notes }` → feeds the manual
pipeline and the Leader's planning context.

## Pitfalls
- Never suggest a different language for an existing codebase — locked.
- Cold analysis only; if the structure surprises you, call out the delta.
- A repo with only a README is greenfield for stack purposes.

## Verification
- The recorded stack matches what the manifest files actually declare.
- Every goal that touches an existing repo shows `stack: <detected>` in the
  manual summary.

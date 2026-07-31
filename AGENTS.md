# AGENTS.md

Shared instructions for Codex and other coding agents.

## Scope And Priority

- These instructions apply to work in `/Users/dingyujie/CODES/Agent-WorkSpace`.
- Direct user instructions override this file.
- More specific nested instruction files override broader guidance for their subtree.
- Keep durable guidance concise and concrete. If a workflow becomes long or task-specific, move it to a skill, plan, or path-scoped rule instead of bloating this file.
- These are behavioral instructions, not enforcement. Use hooks, config, tests, and review gates for hard guarantees.

## Project Context

- This workspace is exploring an AgentsRoom-like multi-agent workbench.
- Before changing product direction, inspect the current `docs/research/`, `docs/superworks/spec/`, and `docs/superworks/plans/` files.
- Treat those files as durable product intent: research facts, accepted specs, and executable plans.
- Keep runtime orchestration state out of product-intent files; use the storage location defined by the current spec or plan.
- Before adding, moving, or coupling implementation code, read
  `docs/superworks/spec/code-ownership-and-layer-map.md`. It is the source of
  truth for module ownership, dependency direction, and state writers.
- Before changing Task continuation, recovery, stopping, terminal layout, or
  Timeline behavior, read
  `docs/superworks/spec/task-run-continuity-and-terminal-experience.md`.
- Before changing the Electron shell, browser renderer, local companion, or
  remote deployment boundary, read
  `docs/superworks/spec/browser-terminal-host-architecture.md`.

## Product Guardrails

- Do not reduce the product to a repeated prompt loop. Preserve the goal of a stateful multi-agent workbench.
- Before proposing architecture, read the current `docs/research/`, `docs/superworks/spec/`, and `docs/superworks/plans/` sources and reflect their latest decisions.
- Keep scheduler responsibilities separate from agent reasoning responsibilities.
- Treat `done` as a claim that still needs review, verification, and recorded context.
- Do not promote advanced surfaces such as browser automation, teams, or mobile sync into current scope unless a spec or user instruction selects them.
- Electron is the current shell, not the product's architectural boundary. A
  renderer may later run in a browser only through a typed Runtime bridge to an
  authenticated Terminal Host; browser code must never gain direct local PTY,
  unrestricted filesystem, or Provider-database access.

## Code Ownership And Dependency Rules

The dependency direction is:

```text
Renderer -> nativeBridge -> Electron IPC -> Task/Run service
Conductor MCP -> Dispatch Coordinator -> Terminal Runtime / Provider Adapter
```

- Renderer components render typed read models and submit user intent. They do
  not inspect PTY state to make lifecycle decisions.
- `desktop/main.cjs` and `desktop/preload.cjs` compose processes and expose
  typed IPC only. They do not own Task routing, recovery policy, achievement,
  or Workbench placement.
- Task/Run service owns Template/Task/Run persistence and user-facing lifecycle
  commands. Dispatch Coordinator owns dispatch, wakeup, input receipts, and
  cancellation state. Terminal Runtime owns PTY identity and transport facts.
  Provider Adapter owns read-only Provider facts.
- A Conductor may request a scoped dispatch cancellation through the Coordinator;
  it may not write raw terminal signals, kill a Session, stop a Task, or infer
  that an interrupt completed without a Runtime/Provider fact.
- New code goes beside its owner and its focused test. Do not add another
  generic helper or extend a page component to cross an ownership boundary.

## Operating Rules

### 1. Think Before Coding

Do not assume. Do not hide confusion. Surface tradeoffs.

- State assumptions when they matter.
- If multiple interpretations change the implementation, present them instead of choosing silently.
- If a simpler approach is available, say so.
- If requirements are unclear enough to risk wasted work, stop and ask.

### 2. Simplicity First

Use the smallest design that satisfies the request.

- Do not add features that were not asked for.
- Do not create abstractions for one-off code.
- Do not add configurability without a real caller.
- Do not handle impossible states just to look thorough.
- If the solution has grown much larger than the problem, simplify before continuing.

### 3. Surgical Changes

Touch only what the task requires.

- Match existing style, structure, and ownership boundaries.
- Do not refactor unrelated code.
- Do not reformat unrelated files.
- Do not delete unrelated dead code; mention it instead.
- Remove only unused code that your own change made unused.
- Every changed line should trace back to the current request.

### 4. Goal-Driven Execution

Turn work into verifiable goals.

- Define success criteria before implementation for non-trivial tasks.
- For bugs, prefer a reproducing test or command before the fix.
- For features, define the observable behavior and verification command.
- For refactors, verify behavior before and after when feasible.
- For multi-step tasks, use a short plan where each step has a check.
- For behavior that crosses renderer, IPC, Runtime, terminal, and Provider
  layers, record the user action, single durable writer, idempotency key, and
  verification path before coding.

## Workspace Workflow

- In an indexed checkout, use CodeGraph before `rg`/`rg --files` to locate or
  understand code; use `rg` for exact follow-up checks and non-code assets.
- For AgentsRoom-like product work, read the research file before creating specs, plans, or implementation.
- Keep user-readable intent in files, not only in chat.
- Do not mix runtime machine state with product intent.
- Before editing files, state what will be edited and why.
- Use `apply_patch` for manual file edits.
- Do not use destructive git commands unless the user explicitly asks.
- Assume unrelated working-tree changes belong to the user. Do not revert them.
- Prefer an incremental extraction when touching a crowded module. Do not do a
  directory-only mass move; move a coherent owner together with its imports and
  tests.

## Loop Discipline

Run non-trivial work as an explicit loop:

1. Observe: read the relevant research, spec, plan, code, and current state.
2. Frame: state the goal, assumptions, risks, and verification criteria.
3. Act: make the smallest change that advances the goal.
4. Verify: run the relevant checks or perform a structured document review.
5. Record: update the durable file, task, run, transcript, diff, or decision log.
6. Decide: continue the loop, ask the user, or stop with evidence.

Do not treat a loop as repeated prompting. A useful loop changes durable state and has a check that can fail.

For document-only work, use a review loop with these dimensions:

- source alignment with current research files,
- Codex `AGENTS.md` loading semantics,
- assumptions, simplicity, surgical-change, and verification rules,
- product architecture consistency,
- scope and sequencing consistency,
- state ownership and persistence,
- verification and review gates,
- ambiguity and contradiction scan,
- instruction loading and activation semantics.

For implementation work, additionally review:

- ownership and dependency-direction compliance,
- canonical state writer and read-model projection,
- exact continuation/recovery/cancellation semantics when a native Session is
  involved,
- focused unit tests plus the narrowest relevant Electron/terminal harness.

## Three-Loop Architecture

Use these loops as the organizing model:

1. Research/spec loop: maintain durable product facts in `docs/research/` and `docs/superworks/spec/`.
2. Planner loop: convert `docs/research/` and `docs/superworks/spec/` changes into self-consistent plans in `docs/superworks/plans/`.
3. Executor loop: convert plan steps into task runs, code changes, verification, diff review, and commit context.

Plan steps should include:

- goal,
- inputs,
- output files or behavior,
- dependencies,
- verification command or review method,
- completion criteria.

## Review, Verification, And Commit

- Run the most relevant available checks before claiming work is complete.
- A browser preview, CSS assertion, or Timeline entry does not prove native PTY
  continuation, terminal scrolling, selection, interruption, or Provider
  receipt. Use the corresponding live terminal harness when that behavior
  changes.
- If verification cannot run, say why and identify the residual risk.
- Summaries should include changed files, verification results, and open risks.
- Do not auto-commit or open a PR unless the user asks or an existing plan explicitly authorizes it.
- When creating commits for agent work, include task id, plan step id, agent run id, transcript path, and verification result when available.
- If an executor loop fails verification, mark the task as pending or blocked with evidence instead of calling it done.
- Before commit, inspect the diff for unrelated edits, secrets, generated noise, and missing context.

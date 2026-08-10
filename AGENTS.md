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
- `docs/README.md` is the only documentation entry point. Read it before using
  any research, spec, plan, bug note, design image, or archive as authority.
- Before changing product direction, read `docs/architecture.md`. Historical
  material is recovered from VCS only when directly relevant; it is evidence,
  never product authority, and must not be copied back into `docs/archive/`.
- Only `docs/implementation-plan.md` is executable. Files under `archive/` or
  `deprecated/` are historical evidence.
- Keep runtime orchestration state out of product-intent files; use the storage location defined by the current spec or plan.
- Before adding, moving, or coupling implementation code, read
  `docs/architecture.md`. It is the source of truth for module ownership,
  dependency direction, and state writers.
- Before changing Task continuation, recovery, stopping, completion, deletion,
  Task Session layout, or Timeline behavior, read `docs/architecture.md`.
- Before changing Meta Agent, Task Setup, Task-local Session Tabs, managed Chat,
  direct user-to-Card input, Attention/Permission, scoped interrupt, or message
  provenance, read `docs/architecture.md` and the corresponding current phase
  in `docs/implementation-plan.md`.
- Before changing the Electron shell, browser renderer, Runtime Bridge,
  SessionPresentation, Runtime Host, or local/remote Host boundary, read
  `docs/architecture.md` and `docs/implementation-plan.md`.

## Product Guardrails

- Do not reduce the product to a repeated prompt loop. Preserve the goal of a stateful multi-agent workbench.
- Before proposing architecture, read `docs/architecture.md` and
  `docs/implementation-plan.md`; use VCS only for explicitly relevant
  historical evidence.
- Keep scheduler responsibilities separate from agent reasoning responsibilities.
- Treat an Agent-reported `done` as evidence/context only; never turn it into a user
  acceptance gate. `Achieve` is an explicit user command independent of Provider/Run lifecycle.
- Do not promote advanced surfaces such as browser automation, teams, or mobile sync into current scope unless a spec or user instruction selects them.
- Electron is the current shell, not the product's architectural boundary. A
  renderer may later run in a browser only through a typed Runtime bridge to an
  authenticated Runtime Host; browser code must never gain direct local PTY,
  unrestricted filesystem, or Provider-database access.
- Conductor exclusively routes Agent-to-Agent content; this does not remove the
  authenticated user's right to target a Card explicitly. Direct human Card
  input must be attributed, mirrored in full to Conductor, never broadcast to
  siblings, and never treated as a Conductor Invocation result.
- Meta Agent is a configuration-time Draft assistant, not a Task Run
  LogicalSession or a second Conductor. It cannot publish, create/start a Task,
  obtain routing scope, read Task transcripts, or write lifecycle state.
- Keep collaboration messages separate from human-only Provider activity.
  Tool/stream/terminal/diagnostic projections are not `SessionMessage`, cannot
  become RelayBlock, and cannot be routed to another Agent.

## Code Ownership And Dependency Rules

The dependency direction is:

```text
Workbench -> RuntimeClient -> Runtime Bridge -> Runtime Host
Runtime Host -> Task/Run + Binding + Message/Intervention/Turn services -> Provider Port -> Provider Adapter
Conductor MCP -> scoped Runtime commands -> Turn/Invocation Coordinator
```

- Renderer components render typed read models and submit user intent. They do
  not inspect Provider streams, terminal state, or native pages to make
  lifecycle decisions.
- `apps/desktop` composes Electron processes and exposes typed IPC only;
  `apps/runtime-host` composes Runtime services and Provider adapters. Neither
  owns Conductor business routing, achievement decisions, or Workbench state.
- Template/Meta/Task Setup service owns configuration Draft/Version/Meta state;
  Task/Run service owns Task/Run/Architecture/LogicalSession persistence and
  user-facing lifecycle commands. Binding service owns Binding association. Message service owns
  Message/Relay/Forward content and provenance. Human Intervention service and
  Turn/Invocation Coordinator own authenticated human intervention, Inbox,
  Input, Turn, Invocation, Attention, cancellation and scheduling intent.
  Provider Adapter owns Provider facts and transport facts only.
- A Conductor may request a scoped dispatch cancellation through the Coordinator;
  it may not write raw provider signals, kill a Session, stop a Task, or infer
  that an interrupt completed without a Runtime/Provider fact.
- New code goes beside its owner and its focused test. Do not add another
  generic helper or extend a page component to cross an ownership boundary.

## State Management Invariants

- A command records user or Conductor intent; an event records a fact that an
  owner observed or committed. Renderer, IPC, and Provider adapters must never
  accept a generic append-event API as a substitute for a domain command.
- Template Draft, Template identity, immutable Template Version, Task
  Architecture snapshot, Task, and Task Run are distinct objects. Saving or
  editing one must not silently create or mutate another.
- Task and Run status changes go through the canonical state model and the
  owning lifecycle service. Do not write free-form status strings from UI,
  IPC, Terminal, Provider, or Coordinator code.
- Every durable fact has one writer. A cache, Timeline item, summary, or read
  model may duplicate data only when it is explicitly derived and rebuildable.
- Production composition passes owner-scoped Store capabilities, not the raw
  multi-writer store. Application services, Provider adapters, Timeline, and
  read-model consumers may call only the methods assigned to their owner.
- Binding service writes Binding association, Provider Adapter writes
  `ProviderFact`, Message service writes Message/Relay/Forward, and the
  Intervention/Turn Coordinator writes HumanIntervention/Input/Turn/Invocation/
  Attention records. `WakeConductor` may be an internal derived signal, but
  durable Inbox is the only recovery truth and there is no Wakeup domain record.
  A combined Session state is a read-model projection.
- Read-model construction is side-effect free: it must not persist defaults,
  repair data, launch/stop a Session, deliver input, or acknowledge a fact.
- Cross-store work records durable intent and an idempotency key before an
  external side effect. If atomic commit is impossible, use a recoverable
  outbox/reconciliation record rather than optimistic UI state.
- A user-facing Task mutation carries a stable `commandId` and the Task's
  observed `expectedRevision`. Keep the same command id across ambiguous
  transport retries; reject a stale revision before any external side effect.
- Template archive metadata belongs to Template identity. Immutable Template
  Version rows and existing Task Architecture snapshots are never rewritten
  merely because an identity is archived.
- Renderer state is limited to view selection, dialogs, unsaved drafts,
  request progress, and typed read-model caches. It never owns Task, Run,
  Binding, HumanIntervention, Turn, Invocation, Attention, or Provider lifecycle
  truth. Session Tab selection must never mutate Runtime lifecycle or silently
  retarget the Task-level Conductor composer.
- Renderer read-model caches refresh after initial load, command results, or a
  semantic Runtime invalidation. Do not add Task/Run polling or use raw
  Provider traffic as a cache-invalidation or lifecycle signal.
- Historical Workflow/Blueprint Harnesses are standalone fixtures. Do not
  register their IPC methods in production Main/Preload or expose them as a
  second selectable Runtime.

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
- For Message/Intervention/Turn, scoped interrupt, Session Tab/Chat, Meta/Task
  Setup, Binding/Handoff, or lifecycle changes, write the focused failing
  contract/harness first. A component screenshot or generic unit test cannot
  replace the corresponding Runtime Host, Bridge, Browser/Electron, or native
  Provider evidence named in the current plan.

## Workspace Workflow

- In an indexed checkout, use CodeGraph before `rg`/`rg --files` to locate or
  understand code; use `rg` for exact follow-up checks and non-code assets.
- For product work, start at `docs/README.md`; follow its current-spec and
  current-plan links instead of scanning or reviving historical documents.
- Keep user-readable intent in files, not only in chat.
- Do not mix runtime machine state with product intent.
- Before editing files, state what will be edited and why.
- Use `apply_patch` for manual file edits.
- Do not use destructive git commands unless the user explicitly asks.
- Assume unrelated working-tree changes belong to the user. Do not revert them.
- For the approved direct Runtime cutover, create the new coherent owner with
  its tests, switch composition once all gates pass, then delete the old path.
  Do not keep a compatibility façade or perform a directory-only mass move.

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
- focused unit tests plus the narrowest relevant Runtime Host, Provider, and
  Desktop/Web bridge harness.

## Three-Loop Architecture

Use these loops as the organizing model:

1. Research/spec loop: keep current product authority in `docs/architecture.md`
   and the distinction from historical VCS evidence visible from `docs/README.md`.
   Do not create a duplicate archive tree in the working copy.
2. Planner loop: keep exactly one current executable plan at
   `docs/implementation-plan.md`; archive it when completed or superseded.
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

# AGENTS.md

Shared instructions for Codex and other coding agents.

## Scope And Priority

- These instructions apply to work in `/Users/dinker/CODES/Agent-Workspace`.
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
- Before changing Conductor tools, Card Session materialization, FIFO delivery,
  Final projection, interruption, or close/reopen behavior, read Architecture
  Section 3 and Plan Phases 1-4. The old Invocation/relay/publish protocol is
  migration debt, not a compatibility contract.
- Before changing the Electron shell, browser renderer, Runtime Bridge,
  SessionPresentation, Runtime Host, or local/remote Host boundary, read
  `docs/architecture.md` and `docs/implementation-plan.md`.
- Before changing Provider/Profile/Binding integration, read Architecture
  Sections 4.0-4.4 and the current Phase row in the Plan's code migration
  ledger. Treat its current anchors, new target, first RED, delete phase, and
  exit condition as the task boundary; update the Plan before expanding it.

## Product Guardrails

- Do not reduce the product to a repeated prompt loop. Preserve the goal of a stateful multi-agent workbench.
- Before proposing architecture, read `docs/architecture.md` and
  `docs/implementation-plan.md`; use VCS only for explicitly relevant
  historical evidence.
- Keep scheduler responsibilities separate from agent reasoning responsibilities.
- Treat an Agent-reported `done` as evidence/context only; never turn it into a user
  acceptance gate. `Achieve` is an explicit user command independent of Provider/Run lifecycle.
- Keep unanchored `Achieve` reachable for every unachieved Task, including an
  active Run and a queued/stopped Task with no active Run. A Publisher Preview
  may additionally offer an anchored choice. Achieve never implies Stop, and
  an achieved Task may not Start or Restart a new Run.
- Do not promote advanced surfaces such as browser automation, teams, or mobile sync into current scope unless a spec or user instruction selects them.
- Electron is the current shell, not the product's architectural boundary. A
  renderer may later run in a browser only through a typed Runtime bridge to an
  authenticated Runtime Host; browser code must never gain direct local PTY,
  unrestricted filesystem, or Provider-database access.
- Conductor exclusively routes Agent-to-Agent content; this does not remove the
  authenticated user's right to target a Card explicitly. Direct human Card
  input must be attributed, mirrored in full to Conductor, never broadcast to
  siblings, and never presented as a Card Final. If the Card is busy, persist
  both Messages immediately, enqueue the Conductor mirror first, and hold the
  Card copy until the previous Turn is durably reconciled.
- Conductor orchestration has exactly four public actions: `invoke_agent`
  materializes a new generation without content only when the Card has no
  current Session (otherwise it rejects; replay of the same hidden idempotency
  key returns the original result); `send_to_session` sends one payload to one
  Session; `interrupt_session` records a scoped interrupt request; and
  `close_session` safely closes the current generation.
  Do not expose public revisions, fences, Turn/Provider ids, acceptance
  criteria, generic session reads, `relay_message`, or `publish_message`.
  Close may atomically suppress only ordinary Conductor Inbox items not yet
  handed to an adapter; it must reject active/ambiguous Turns, held human input,
  unresolved Attention/Permission, active/unresolved intervention, or unknown
  Provider outcome.
- A close/reopen proof must use the managed Conductor tool-call context itself:
  after `close_session(A1)` and `invoke_agent` returns distinct `A2`, an actual
  `send_to_session(A1, ...)` must reject with the safe code
  `orchestration_session_not_current`. A direct Gateway/Store call or merely
  showing G1 as read-only does not prove this boundary.
- Authenticated human `session.request_interrupt` is a separate product command,
  not a fifth Conductor action. It carries no new message content, records a
  durable scoped-interrupt intent/control request, treats acceptance as intent
  only, and exposes the confirmed/unknown/late-final result through Runtime
  reconciliation and a Conductor Notice while the Run can still receive it.
- Meta Agent is a configuration-time Draft assistant, not a Task Run
  LogicalSession or a second Conductor. It cannot publish, create/start a Task,
  obtain routing scope, read Task transcripts, or write lifecycle state.
- Production Task/Session Provider wire is ACP-only. Do not add or preserve a
  direct OpenCode REST, Codex App Server, Claude stream/SDK fallback or selector.
  Provider-specific transports may exist only inside an external ACP Agent.
- Do not gate a Provider by a repository version allowlist. Resolve the current
  installed ACP artifact/upstream, record a Host-private resolution/drift seal,
  and grant capabilities only after current initialize negotiation plus bounded
  model/role behavior qualification. A changed installation must requalify.
- Raw ACP session/request/option/tool IDs, credentials and absolute cwd are
  Host-private. Durable domain records, Provider facts, evidence and Renderer
  models use Workspace-generated opaque IDs and safe observations only.
- Opening a Meta panel only loads the persisted Draft scope. If that scope
  already has an active Meta Session, show it directly; otherwise creating one
  requires an explicit action after selecting a Host-ready option. Sending is
  the only action that creates a MetaTurn. Close, dock, and page navigation are
  view state; Task Run never shows Meta.
- Keep collaboration messages separate from human-only Provider activity.
  Tool/stream/terminal/diagnostic projections are not `SessionMessage`, cannot
  become RelayBlock, and cannot be routed to another Agent.
- Files & Changes is a Task-scoped human read model over the Workspace filesystem,
  not an Artifact registry or ownership layer. Open/Preview revalidates the
  current file; Achieve may copy a non-owning path/digest anchor; Archive,
  permanent Task deletion, and tests never delete Workspace files implicitly.

## Code Ownership And Dependency Rules

The dependency direction is:

```text
Workbench -> RuntimeClient -> Runtime Bridge -> Runtime Host
Runtime Host -> OR owner services -> Session Runtime -> Provider Port -> ACP Client -> ACP Agent
Conductor-only tool host -> scoped Runtime application command boundary -> owner-scoped Task/Run, Message, and Orchestration capabilities
Publisher-only Workspace tool host -> scoped file-effect intent -> Workspace filesystem + human-only observation
```

- Renderer components render typed read models and submit user intent. They do
  not inspect Provider streams, terminal state, or native pages to make
  lifecycle decisions.
- `apps/desktop` composes Electron processes and exposes typed IPC only;
  `apps/runtime-host` composes Runtime services, Session Runtimes, ACP clients,
  current-install resolution, qualification and Agent processes. Neither
  owns Conductor business routing, achievement decisions, or Workbench state.
- Template/Meta/Task Setup service owns configuration Draft/Version/Meta state;
  Task/Run service owns Task/Run/Architecture/CardSessionSlot/LogicalSession/
  ConductorPlanningFence persistence and user-facing lifecycle commands.
  Binding service owns Binding association. Message service owns Message/Relay/
  Forward content and provenance. Human Intervention service owns authenticated
  HumanIntervention records. Orchestration Coordinator owns Inbox, held/suppress,
  Input, Turn, SessionControlAudit, Attention, cancellation, and scheduling
  intent. Workspace Tool/Observation service owns scoped file-effect intent and
  human-only observations, never file ownership. The Runtime reliability/outbox
  capability owns provider-effect intents, leases, receipts, and command
  receipts. Session Runtime owns execution attempts/correlation/settlement;
  ACP Client owns Host-private wire/raw-ID observation only.
- The Runtime application transaction coordinates cross-owner commands; it is
  not another state writer. Invoke writes Slot/Session through Task/Run,
  send writes content through Message and delivery state through Orchestration,
  and interrupt writes control state through Orchestration. Close atomically
  combines Orchestration control/lane suppression with Task/Run retirement and
  Slot-current clearing, returning `closed` only after both owner capabilities
  commit. Each capability may mutate only its owner's rows, even when one
  database transaction spans them.
- A Conductor may request a scoped interrupt or close through the Runtime
  application command boundary; the Coordinator owns control/lane state and
  Task/Run exclusively owns close retirement/current-pointer state.
  It may not write raw Provider signals, kill a Session, stop a Task, or infer
  interrupt completion from an `accepted` receipt. Interrupt result is a later
  Runtime/Provider fact projected as a typed Notice; close has no accepted
  intermediate state and returns `closed` only after retirement commits.
- New code goes beside its owner and its focused test. Do not add another
  generic helper or extend a page component to cross an ownership boundary.

## State Management Invariants

- A command records user or Conductor intent; an event records a fact that an
  owner observed or committed. Renderer, IPC, Session Runtime and ACP clients must never
  accept a generic append-event API as a substitute for a domain command.
- Template Draft, Template identity, immutable Template Version, Task
  Architecture snapshot, Task, and Task Run are distinct objects. Saving or
  editing one must not silently create or mutate another.
- `task.create` never accepts a Renderer-selected `taskId`. The Runtime owner
  allocates the opaque Task identity inside the replay-checked, revision-fenced
  transaction and returns it in the typed command result.
- Task and Run status changes go through the canonical state model and the
  owning lifecycle service. Do not write free-form status strings from UI,
  IPC, Terminal, Provider, or Coordinator code.
- Every durable fact has one writer. A cache, Timeline item, summary, or read
  model may duplicate data only when it is explicitly derived and rebuildable.
- Production composition passes owner-scoped Store capabilities, not the raw
  multi-writer store. Application services, Session Runtime, Timeline, and
  read-model consumers may call only the methods assigned to their owner.
- Binding service writes Binding association plus its verified Workspace opaque
  `bindingHandle`/status/recoverability; raw ACP session IDs remain Host-private.
  The Runtime reliability capability
  writes `session_id_provider_effect_outbox` intent, lease, and receipt rows,
  correlated to the target Session and optional Turn/Control/Interaction;
  Session Runtime/ACP normalization writes correlated `ProviderFact` without raw
  ACP IDs. Message service writes Message/Relay/Forward, and the
  Human Intervention service writes HumanIntervention. Task/Run service writes
  CardSessionSlot, LogicalSession, and ConductorPlanningFence. Orchestration
  Coordinator writes Inbox/Input/Turn/SessionControlAudit/Attention records.
  Workspace Tool/Observation service writes scoped effect/observation records.
  `WakeConductor` may be an internal derived signal, but durable Inbox is the
  only recovery truth and there is no Wakeup domain record. A combined Session
  state is a read-model projection.
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
  CardSessionSlot, Binding, HumanIntervention, Turn, PlanningFence, ControlAudit,
  Attention, or Provider lifecycle truth. Session Tab selection must never
  mutate Runtime lifecycle or silently retarget the Task-level Conductor
  composer.
- Renderer read-model caches refresh after initial load, command results, or a
  semantic Runtime invalidation. Do not add Task/Run polling or use raw
  Provider traffic as a cache-invalidation or lifecycle signal.
- Historical Workflow/Blueprint Harnesses are standalone fixtures. Do not
  register their IPC methods in production Main/Preload or expose them as a
  second selectable Runtime.
- The production root has already cut over to the unified Session-ID Host,
  Bridge, Workbench, and local Desktop Host supervisor. Candidate-named app,
  source, config, or launch paths are forbidden, including as focused fixtures;
  required release launchers resolve the default production Vite config, build
  artifact, Electron main, and Host composition with no fallback. Never restore
  an old/new runtime selector, compatibility facade, or second lifecycle writer.
- SQLite schema v19 may discover allowlisted superseded-protocol table names
  through schema metadata and record them in `superseded_protocol_tables`. It
  must not read, translate, rewrite, or drop those legacy rows, and it must
  preserve unknown user/private tables. Physical removal needs separate user
  authorization.

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
  replace the corresponding Runtime Host, actual Browser/Electron interaction,
  or native Provider evidence named in the current plan.

## Workspace Workflow

- In an indexed checkout, use CodeGraph before `rg`/`rg --files` to locate or
  understand code; use `rg` for exact follow-up checks and non-code assets.
- For product work, start at `docs/README.md`; follow its current-spec and
  current-plan links instead of scanning or reviving historical documents.
- Treat `tests/e2e/deepsearch-runtime-bridge.contract.test.ts` as a deterministic
  fake/controlled Runtime Bridge contract. Direct RuntimeClient calls, fake
  Providers, and mock IPC do not prove an actual Browser, Electron, Conductor
  tool-call, or native Provider journey.
- Keep user-readable intent in files, not only in chat.
- Do not mix runtime machine state with product intent.
- Before editing files, state what will be edited and why.
- Use `apply_patch` for manual file edits.
- Do not use destructive git commands unless the user explicitly asks.
- Assume unrelated working-tree changes belong to the user. Do not revert them.
- The approved direct Runtime cutover is complete. Extend only the unified
  owner and its focused tests; do not recreate a compatibility façade,
  candidate path, old/new selector, or second lifecycle writer.

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
- A RuntimeClient script, fake adapter, or mocked IPC test does not prove the
  product's actual full flow. For release claims, exercise the rendered Browser
  and packaged Electron surfaces through user-visible controls, and capture
  real Conductor tool calls plus current-resolution ACP receipts as required by
  Architecture Section 9.
- Actual-operation scenarios receive only the plan's locator-action DSL. Raw
  Playwright/Electron handles, evaluate/request/fetch, preload facades, and
  RuntimeClient calls are runner-internal or forbidden; each Host mutation must
  correlate to a visible-action trace and Renderer-generated intent id.
- A release-required evidence cell passes only with `PASS`; skipped,
  NOT_EXERCISED, and NOT_APPLICABLE do not pass. UI, Host, and native evidence
  must come from their class-specific issuers. Mutually exclusive scenarios use
  verifier-predeclared bundle/scenario cells under one fresh release nonce; all
  evidence inside a cell shares its Runtime and durable lineage, and one cell
  can never substitute for another as defined by Architecture Section 9.
- Release identity uses one production Vite build. `buildDigest` covers every
  regular, non-symlink file under `dist/workbench` plus
  `apps/desktop/main.cjs`, `apps/desktop/preload.cjs`, and
  `apps/runtime-host/src/index.ts`, plus the actual release-only child entries
  `tests/journeys/support/controlled-unified-host-service-cli.ts` and
  `tests/journeys/support/native-unified-host-service-cli.ts`. Those wrappers
  compose the same unified Host with observation/control endpoints; they are
  not another selectable Runtime. Cell launchers record that digest, run with
  `--skip-build`, and rehash before and after execution; source, schema, resolution,
  policy, or build drift must fail the fresh bundle instead of rebuilding it.
- Release Browser cells serve that frozen `dist/workbench` through the
  release-only read-only static/proxy server, not a Vite development server.
  It may proxy only `/runtime` and inject only the exact-one empty Runtime token
  and owner meta elements in memory; normalization must reproduce the hashed
  `index.html` bytes.
- Repository release dispatch binds both
  `AGENT_WORKSPACE_RELEASE_CELL_RUNNER_SHA256` and
  `AGENT_WORKSPACE_RELEASE_CELL_WORKER_SHA256` into policy identity. Parent
  cell boundaries and worker start/completion independently recheck their
  assigned release digests; the runner and worker are not `buildDigest`
  artifacts. Never weaken either seal or accept drift.
- A release matrix may predeclare only the cell's `runtimeInstanceId` lineage
  anchor. It must not preallocate Draft, Task, Run, Meta, Session, Binding,
  Message, Input, Turn, Intervention, Forward, Slot, or Control identities.
  Every Bridge, controlled, and native required cell obtains its canonical
  observed-lineage seal from the actual Host's persisted owner repositories
  across all Runs plus correlated Provider facts. Worker and parent must
  recompute its canonical JSON SHA-256, reject missing/extra/fallback or
  duplicate identities, require every typed ledger reference to be a member,
  bind every issuer stream/signature in the cell to that digest, and reject
  actual identity or digest reuse across cells.
- `npm run verify:release` remains the only aggregate release claim. During the
  ACP cutover it must fail closed until the new matrix is registered; it must
  never run the superseded direct-Provider native cell to exit `0`. The new
  matrix size is frozen from actual requirements rather than inheriting 26.
- The ACP release preflight must validate current OpenCode ACP, Codex ACP and
  independent Meta ACP artifacts/credentials/workspace inputs before any local
  gate, build, evidence directory, Host, UI or model effect. Each Profile gets
  an independent resolution, initialize observation and bounded qualification.
  Local-gate children receive a narrow system environment allowlist; raw paths,
  credentials, ACP IDs and other `AGENT_WORKSPACE_*` do not propagate. Missing
  capability is honest exit `2`, assertion/safety failure is `1`, and only one
  fresh all-required ACP bundle may exit `0`.
- J-09 release evidence must contain one ordered Host-ledger chain
  `invoke(A1) < close(A1) < invoke(A2) < rejected send(A1)`, with `A2 != A1`, exact
  `orchestration_session_not_current`, observed-lineage membership, and visible
  G1-read-only/G2-current UI evidence. J-11 Browser main intentionally chooses
  unanchored Achieve after Preview; Electron main, cross-surface, and native
  choose anchored Achieve. Both require the corresponding persisted marker and
  an independent Stop action.
- If verification cannot run, say why and identify the residual risk.
- Summaries should include changed files, verification results, and open risks.
- Do not auto-commit or open a PR unless the user asks or an existing plan explicitly authorizes it.
- When creating commits for agent work, include task id, plan step id, agent run id, transcript path, and verification result when available.
- If an executor loop fails verification, mark the task as pending or blocked with evidence instead of calling it done.
- Before commit, inspect the diff for unrelated edits, secrets, generated noise, and missing context.

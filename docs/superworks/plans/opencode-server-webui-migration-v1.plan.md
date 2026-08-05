# OpenCode Server + Web UI Migration v1

Date: 2026-08-02

Status: Active architectural migration plan for the `onlyopencode` branch.

## Decision

`onlyopencode` adopts OpenCode as the sole Provider and as the sole native
Session Host. Agent Workspace keeps its Template, Task, Task Session,
Invocation, Conductor, durable-event, and review semantics; it stops owning a
PTY, terminal emulator, or custom terminal UI.

```text
Agent Workspace
  -> Task / Task Session / Invocation application services
  -> OpenCode Server API + SSE reconciliation
  -> OpenCode Provider Sessions
  -> official OpenCode Web UI
```

The official Web UI is the interactive surface for a provider Session. A TUI
may still be attached by a person outside Agent Workspace, but it is neither a
product surface nor a Runtime dependency.

This is not a plan to reproduce Orca transport through OpenCode hooks. Hooks
may provide an immediate notification only. The durable source of Provider
truth is the OpenCode Server API, its Session/message/status reads, and its
event stream followed by reconciliation.

## Scope and non-goals

In scope:

- replace the Orca/PTY Terminal Runtime, terminal Workbench, and terminal
  continuation path with an OpenCode Server Session Host and official Web UI
  Session pages;
- make the Conductor's task conversation an official OpenCode Web UI page for
  the Task Session's Conductor Session;
- make a started Agent Card's detail page an official OpenCode Web UI page for
  that Agent Session;
- preserve Agent Loop's Conductor-only dispatch, durable Dispatch/Invocation
  ledger, result references, Timeline, Task lifecycle, and explicit user
  `achieved` action;
- retain Electron or the protected Browser Runtime Bridge only as a local
  application/authorization shell, never as a PTY owner.

Out of scope:

- reviving Graph/Workflow as an active product mode. `GraphTaskSession` is a
  reserved future type only; this migration implements `LoopTaskSession`;
- adding a second provider or a provider-neutral terminal abstraction;
- building a replacement chat or terminal UI for OpenCode;
- relying on OpenCode hooks as an exactly-once event bus;
- deleting legacy terminal code before the Server path has passed its full
  acceptance harness.

## Target vocabulary and call model

The public definition-level call targets are exactly two kinds:

```text
Template  -> creates one Task Session
Agent Card -> resolves or creates one Agent Session inside that Task Session
```

The durable objects are:

| Object | Owner | Meaning in this migration |
| --- | --- | --- |
| Template Design Draft | Template Design service | durable editable working copy; it is not a Task and is only reusable after explicit Save |
| Template Design Session | Template Design service + OpenCode Server | one persistent non-Task Provider Session scoped to one Template Design Draft |
| Template Version | Template store | immutable reusable definition; calling it creates a Task and Task Session |
| Task | Task/Run service | user-visible durable aggregate and history owner |
| Task Session | Task/Run service + OpenCode Session Host | one concrete, callable orchestration instance; v1 type is `loop` and is realized by one Task Run |
| Conductor Agent Session | OpenCode Server | the Task Session's parent/entry Agent Session |
| Agent Session | OpenCode Server | one lazily created provider Session for an Agent Card within one Task Session |
| Invocation (current Dispatch) | Dispatch Coordinator | one parent-to-callee call with an immutable request, receipt, return/wakeup, failure, or cancellation facts |
| OpenCode Host | OpenCode Server Manager | one authenticated loopback Server/Web UI instance shared by active Task Sessions with the same canonical project root |

### Template Design Session

Template editing has one additional, deliberately non-call-target path:

```text
Template Design Draft
  -> Template Design Session (official OpenCode Web UI)
  -> scoped read_draft / apply_patch tools
  -> explicit user Save
  -> immutable Template Version
```

The Meta Agent is not a Task, Task Session, Conductor, or Agent Card. It owns
only an editable Draft and a continuous Provider Session attached to that
Draft. A close/hide action releases only the Web UI presentation lease; it
does not delete the Draft or Provider Session. A structured patch includes an
expected Draft revision and idempotency operation id. It may update the
Template Charter, a Card dispatch profile, or a Card worker system prompt, but
may never create a Task or silently save a Version. `@card-id` targets in the
official Web UI message are interpreted by the Template Designer agent, not by
the renderer or Web UI DOM.

An Agent Card is not itself a live Session. Its identity is scoped by the
Task Session:

```text
Task Session run_01
  + card "search-0"
  -> Agent Session { taskSessionId: run_01, agentCardId: search-0,
                     providerSessionId: ses_... }
```

The visible Task Session workspace follows the same boundary. A current Task
Run shows one resizable Task-scoped directory containing its Conductor and
Agent Cards. The selected Session alone owns the official Web UI frame; the
Conductor remains the default. A later call to the same Agent Card is another
Invocation of the existing Agent Session, not a duplicate Session row. Split
geometry is a bounded Run layout fact, written once on pointer release; drag
motion is renderer-only CSS geometry and never starts polling or Provider work.

The execution cycle is:

```text
Template invocation
  -> Task + LoopTaskSession
  -> create Conductor Agent Session
  -> Conductor calls an Agent Card
  -> Coordinator creates Invocation
  -> OpenCode API prompts its Agent Session
  -> OpenCode result / attention / failure is reconciled
  -> Coordinator records return or wakeup
  -> Conductor receives the durable input and decides again
```

`return` completes an Invocation, not the Agent Session. The callee remains
available for later Invocations while its Task Session is active. A Task Stop
ends the active Task Session and prevents further calls to it; a later Restart
creates a fresh Task Session/Run. Historical Task data stays inspectable and
is never silently treated as a live Provider Session.

## Server-host boundary

The target is one loopback-only OpenCode Server/Web UI host per canonical
project root, shared by active Task Sessions and Template Design Sessions
rooted there. A Server process
is a comparatively heavy Provider host; creating one per Task Run wastes
memory and turns normal concurrent Task use into process fan-out. A Server per
logical Agent Session would be worse and is not an isolation strategy.

Each Task Session still owns distinct Conductor/Agent provider Session ids,
Invocation records, prompt/system inputs, and durable bindings. The shared Host
does not own, infer, or merge Task lifecycle. It may expose OpenCode's native
cross-session navigation, but that provider presentation is never a source of
Task/Run truth.

The shared host configuration contains the stable Conductor bridge and the
official OpenCode `build` default. An Agent Card never becomes a custom
OpenCode agent profile. Task-specific Card type, declared MCP/Skills scope,
model, dispatch profile, worker system prompt, and Task scope are supplied
through the typed Session API and validated by the Task/Run service and
Conductor bridge. The sole exception is the fixed
`agent_workspace_template_designer` primary agent: it is a Template Design
service boundary, not an Agent Card, and receives only the isolated Template
Designer MCP tools. Project-level host configuration is the only place that
may install an MCP server, Skill, or plugin. A tool call must be accepted only
when its provider Session binding belongs to the addressed Task Session or
Template Design Draft; a shared host credential is not authority to cross
those boundaries.

The Server Manager owns only:

- canonicalizing a project root, selecting an unused loopback port, and
  generating a per-host secret;
- starting, health-checking, supervising, and reattaching to `opencode web`
  or the verified equivalent Server/Web UI launch mode;
- constructing the stable project-host config without copying user credentials;
- exposing a narrowly typed OpenCode HTTP/SSE client to the Provider Adapter;
- publishing the safe local Web UI URL and Server health facts.

It reference-counts generic owner leases such as
`task-run:<taskId>:<runId>` and `template-design:<draftId>`, then applies a
bounded idle shutdown policy. Host start/stop is a Provider transport fact: it
never changes a Task, Run, or Draft status. After a host restart, the Provider
Adapter reconciles the exact durable provider Session bindings through the
Server API before reporting a new fact.

It does not own Task transitions, choose Agent Cards, interpret answer quality,
or infer a result from a browser page. It must not expose its password or a
generic Server proxy to renderer JavaScript.

The OpenCode Provider Adapter owns:

- creating/fetching provider Sessions and storing the exact
  `providerSessionId` binding;
- sending a generated Invocation input/message id through the Server API;
- confirming receipt by the matching OpenCode message record;
- subscribing to Server SSE for low-latency changes, then reconciling from
  `GET /session`, Session status, and Session messages after reconnect;
- deriving `running`, `return`, `permission`, `question`, `failed`, and
  cancellation facts from OpenCode-native structured state;
- answering a provider-native permission through the documented Server API
  only when the user has explicitly made that response in the official Web UI
  or an approved product control.

The Coordinator continues to own Invocation state, occupancy, idempotency,
return delivery, wakeups, and cancellation receipts. `cancel_dispatch` maps to
the documented OpenCode Session abort API and is completed only after the
Adapter observes the corresponding native state.

## Versioned Web UI adapter

OpenCode's Web UI is a presentation client, not an Agent Workspace protocol.
Its local port is dynamic by default, and its internal URL shape, query
parameters, DOM, iframe policy, and authentication behavior may change between
OpenCode releases. No renderer component may construct a URL such as
`/session/<id>`, scrape the page, simulate a click, or use Web UI state as a
Provider fact.

The Server Manager stores a versioned host capability record:

```text
OpenCodeHostCapability {
  providerVersion,
  openApiSchemaVersion,
  serverOrigin,
  webOrigin,
  sessionPresentation: direct_url | documented_handoff | unavailable
}
```

For each bound `providerSessionId`, the renderer asks a typed
`openOpenCodeSessionPage` command for a Session-page handle. Electron Main (or
the authenticated local Host) resolves the page through the capability record
and owns any credentials. Browser JavaScript receives neither a Server password
nor a generic proxy to the OpenCode API.

There are three explicit outcomes:

1. `direct_url`: the pinned OpenCode release documents and proves a stable way
   to open the exact provider Session. The app may host that official page in
   a Main-owned BrowserView/web contents surface, or use a safe external-browser
   handoff.
2. `documented_handoff`: OpenCode provides an official opener but not a stable
   URL. The app uses that opener without UI automation. This is acceptable for
   an interim "open in OpenCode" action, but does not satisfy the final
   in-Task exact Session-page requirement.
3. `unavailable`: no supported exact Session opener exists. The app shows an
   honest unavailable/open-root state and Phase 4 remains blocked; it must not
   guess a route or automate the Web UI.

Thus the Web UI may be upgraded or replaced without changing the Template,
Task Session, Agent Session, Invocation, or OpenCode Server API contracts.

### Scoped presentation gateway for direct Conductor follow-ups

A follow-up submitted from the official Conductor Web UI crosses a
**host-owned presentation gateway**, not a renderer-to-Provider API. Opening
the exact Conductor page grants one opaque, per-presentation lease bound to
`{ taskId, runId, logicalConductorSessionId, providerSessionId }`. The gateway
accepts only that lease and only the documented Provider message operation for
that exact bound Session.

Before it forwards a direct follow-up, the gateway asks the Task/Run service to
preflight the continuation. That service remains the only lifecycle writer: it
validates that the Task/Run is continuable, preserves/replays the one durable
input id, and, from `delivery_ready`, opens the next decision epoch in the
same Run before the Provider can execute the Conductor turn. A missing,
stopped, mismatched, or released lease fails closed. For an `achieved` Task,
the gateway accepts writes only after the Task/Run service has completed the
explicit continuation command defined in
[`task-template-runtime-model.md`](../spec/task-template-runtime-model.md#states-and-completion)
and issued a fresh presentation lease. The gateway itself may never choose a
replacement Task, Run, or Provider Session.

The renderer receives neither a generic gateway/Server API nor credentials,
and the gateway never injects scripts, scrapes the DOM, or simulates UI
actions. Closing the presented page releases its presentation lease and its
scoped gateway access; the shared Host then follows normal owner lease and
idle-shutdown rules. Closing a presentation does not stop an active Task Run
or its bound Provider Session.

## Required discovery spike

Before replacing production code, add a version-pinned live harness against
the locally supported OpenCode binary. It must answer these questions with
recorded evidence, not documentation inference:

1. Does `opencode web --hostname 127.0.0.1 --port <port>` expose the same
   documented Server API, and what stable Web UI URL does it expose?
2. Can the Web UI open a specific existing `providerSessionId` through a
   supported URL/state, and can Electron safely display it without a custom
   browser or terminal implementation? If not, define the supported open-in-
   browser handoff rather than guessing an iframe route.
3. Can a Task-scoped config overlay provide the Conductor MCP server and
   instructions without changing a user's normal OpenCode configuration or a
   worker's capabilities?
4. Can API-created Conductor and worker Sessions choose their intended model,
   Agent configuration, system prompt, tools, parent relationship, and
   project directory?
5. Does an asynchronous prompt with a caller-supplied message id produce an
   inspectable matching user message, ordered result, `session.idle`, native
   permission/question, failure, and abort sequence?
6. After a Server-client reconnect or Electron restart, can the Adapter
   reconstruct all unresolved Invocation facts from documented Server reads
   without a hook, SQLite scan, terminal log, or UI scrape?

The harness pins the OpenCode minor version and captures `/global/health`, the
published `/doc` schema version, redacted request/response fixtures, and the
UI handoff result. Any unsupported point changes this plan before production
implementation; it is not papered over with a terminal fallback.

## Migration phases

### Phase 1 — replace the authoritative contracts

Goal: make the product contract describe Server-native Sessions before code
starts to depend on them.

Inputs:

- this plan and the discovery-harness evidence;
- current Template/Task/Run and Conductor ownership contracts.

Changes:

- add an OpenCode Server Session Host specification and make it the current
  authority for Session hosting, Provider observations, Server recovery,
  Web UI links, and local security;
- revise the architecture charter, spec index, Task/Template/Run model,
  Agent Loop v1, Conductor guidance, interaction map, code-ownership map,
  Browser Host boundary, and instrumentation contract to remove PTY/Orca
  ownership from the active path;
- archive or mark non-executable the Orca terminal adoption and terminal
  continuity plans for this branch; retain them as migration evidence only;
- keep the Agent Loop-only product scope. Do not activate Graph UI merely
  because the vocabulary permits a future Graph Task Session.

Completion criteria:

- every current spec agrees that an Agent Session's authoritative identity is
  `providerSessionId`, not a terminal incarnation;
- every user-facing Session page has an official Web UI handoff contract;
- no current plan requires PTY, xterm, terminal snapshots, or raw terminal
  transcripts as a correctness condition.

### Phase 2 — OpenCode Server Manager and typed Provider client

Goal: establish one tested Server/Web UI host and one typed API/SSE client per
canonical project root, shared safely by its active Task Sessions.

Output modules:

```text
desktop/opencode/server-manager.cjs
desktop/opencode/server-client.cjs
desktop/opencode/server-event-reconciler.cjs
desktop/opencode/server-session-host.cjs
```

Rules:

- bind only to `127.0.0.1`; use Server authentication for every process and
  never serialize a secret into Timeline, task data, browser storage, or logs;
- read OpenCode's generated OpenAPI contract from the pinned Server release;
  do not reverse-engineer its SQLite database or scrape the Web UI;
- use SSE only to trigger bounded reconciliation; a missed event is recovered
  by API reads from the provider's persisted Sessions/messages/status;
- model Server liveness separately from Task lifecycle. A Server restart may
  reconnect the same provider Session binding; it cannot invent a new Task Run
  or silently replace a missing provider Session;
- retain hooks only behind an optional telemetry interface, with no lifecycle
  writer and no required config injection.

Verification:

- unit tests for launch, secret redaction, health check, schema compatibility,
  reconnect, and Client error normalization;
- live `opencode-server-host-harness` proving Session creation, prompt,
  SSE/reconcile, permission/abort, and Server restart recovery;
- a shared-host harness proving two active Task Sessions with the same
  canonical `cwd` receive one Host id/origin yet cannot read, prompt, wake, or
  invoke across each other's provider Session bindings; a different `cwd`
  receives a different Host;
- a reference/idle-shutdown harness proving Host reuse and shutdown do not
  mutate a Task/Run lifecycle and that a later reattach reconciles only the
  durable provider Session ids for its own Task Session;
- a negative test proving a dropped SSE connection alone cannot lose or
  duplicate an Invocation.

### Phase 3 — map Task Session and Invocation to OpenCode Sessions

Goal: replace launch profiles, terminal input, and SQLite observation with
provider-native Session calls while preserving current Task/Run ownership.

Changes:

- add a durable `TaskSessionHost` binding `{ taskRunId, hostId, serverUrl,
  configVersion, status }` and `AgentSessionBinding` `{ taskRunId, agentCardId,
  providerSessionId, parentProviderSessionId?, createdAt }`;
- create the Conductor provider Session when a Task Run/LoopTaskSession starts;
- lazily create an Agent Card's provider Session on its first Invocation, then
  reuse that exact Session for subsequent calls in the active Task Session;
- replace `registerLaunchProfile`, PTY activation, pasted input, terminal
  receipts, and `latestOpenCodeProviderSessionId` reconstruction with typed
  Server `create`, `prompt_async`/message, message receipt, status, result,
  and abort operations;
- change the Dispatch record from terminal/provider receipt fields to an
  explicit `{ invocationInputId, providerSessionId, providerUserMessageId,
  providerResultMessageId? }` binding. Existing terminal fields are historical
  read-only data and may not be populated on the new path;
- inject Conductor-specific MCP capability through the shared Host's stable
  configuration plus a Task-Session-bound `build` Session/request policy.
  Worker Agent Sessions remain ordinary `build` Sessions, never receive the
  control-plane capability, and a Conductor tool call cannot cross its provider
  Session binding;
- make a user message in the Conductor's official Web UI visible as a durable
  Task input through the Adapter's native message observation, without adding
  a competing custom composer transport.

Verification:

```text
create Template -> create Task -> start LoopTaskSession
-> Provider Conductor Session exists
-> Conductor dispatches card search-0
-> search-0 Provider Session is created once
-> Invocation result becomes a durable return
-> Conductor is woken with the exact result reference
-> second dispatch to search-0 reuses its Provider Session id
```

Also prove duplicate request replay, simultaneous Worker returns, a native
permission, a cancellation, a Server restart, Task Stop, and a fresh-Run
restart. None of those checks may use PTY output or UI text as their oracle.

### Phase 4 — replace terminal pages with official Web UI Session pages

Goal: make the Conductor and Agent Session surfaces official OpenCode Web UI,
while preserving Agent Workspace's semantic Task view.

Changes:

- replace the Task-page custom Conductor conversation panel with an
  `OpenCodeSessionPage` targeting the active Conductor `providerSessionId`;
- replace each Workbench terminal tab with the corresponding official Web UI
  Session page for its `providerSessionId`; use the verified Phase-0
  `openOpenCodeSessionPage` capability, a Main-owned BrowserView/web contents
  surface, or a documented external-browser handoff—never an iframe, guessed
  URL, or DOM automation;
- remove PTY groups, xterm sizing/scrollback/zoom, terminal attachments,
  terminal input, raw-terminal diagnostics, and terminal-specific recovery
  controls from the active UI contract;
- retain Timeline as the product's causal orchestration ledger and retain
  Templates/Task Architecture as the place for unstarted Agent Cards;
- show Server connectivity and provider Session status from typed read models,
  never by scraping a Web UI page;
- leave native permission/question interaction to the official Web UI. The
  Timeline may show a non-actionable semantic attention link to the owning
  Session page.

Verification:

- browser/Electron E2E proves a Task opens the Conductor's exact Session page,
  a dispatched card opens the exact worker Session page, and switching pages
  never creates/restarts a provider Session;
- a scoped presentation-gateway harness proves that a direct official-WebUI
  Conductor follow-up carries a valid presentation lease, preflights Task/Run
  continuation before the Provider message, keeps the same Run and exact
  Conductor provider Session through `delivery_ready`, and permits the next
  Publisher dispatch; stale, worker, or released leases cannot forward, and
  close releases only the presentation lease before normal Host shutdown;
- a real OpenCode run proves an answer written in official Web UI appears in
  the Task Timeline through Server observation and that a Worker return wakes
  the Conductor;
- UI source and production bundle checks prove no active import of xterm,
  `PtyTerminal`, terminal attach, terminal resize, or terminal input APIs.

### Phase 5 — remove the Orca/PTY path after parity evidence

Goal: delete only the superseded transport once the Server path is the tested
default.

Remove from active composition, then delete with their focused tests/harnesses
once no caller remains:

```text
desktop/runtime/orca-terminal-*.cjs
desktop/runtime/terminal-*.cjs
desktop/runtime/session-authority.cjs
desktop/pty-manager.cjs
src/components/PtyTerminal.tsx
src/agent-loop/workbenchLayout.ts
terminal attach/input/resize IPC and Browser Runtime Bridge endpoints
```

Update `desktop/main.cjs`, `desktop/preload.cjs`,
`src/runtime/nativeBridge.ts`, and Browser Runtime Bridge contracts to expose
only typed Task, Invocation, OpenCode Session-page, and safe artifact
operations. Delete the OpenCode SQLite reader/old hook delivery path if the
Server contract replaces each active responsibility; preserve redacted
migration readers only if existing historical Task data still needs read-only
inspection.

Completion criteria:

- production composition has no PTY or Orca dependency and no `node-pty`
  lifecycle path;
- the only active Provider adapter is the OpenCode Server adapter;
- a clean install can create, continue, inspect, cancel, stop, restart, and
  achieve a Task entirely through typed Server calls and official Web UI pages;
- no Task, Dispatch, or Provider fact becomes less durable or less attributable
  than before the migration.

## Plan-level acceptance and rollback

The migration is accepted only when a live, version-pinned OpenCode harness
proves:

```text
Template invocation -> LoopTaskSession -> Conductor Session Web UI
-> direct Conductor follow-up (presentation lease + continuation preflight)
-> same Run + exact Conductor provider Session
-> Agent Card invocation -> Agent Session Web UI
-> exact Invocation receipt -> return/wake -> Conductor continuation
-> permission or cancellation -> Server-native fact
-> Server/Electron reconnect -> API reconciliation
-> Task Stop -> no more Invocation accepted
-> explicit Restart -> fresh LoopTaskSession and fresh provider Sessions
```

The product may not claim that a Task is achieved merely because OpenCode
reports idle or because a Web UI page is reachable. The existing Conductor
delivery claim and explicit user achievement remain separate facts.

Until Phase 4 passes, the legacy PTY path remains readable only as a migration
baseline. If Phase 0 demonstrates that official Web UI cannot deterministically
open/hand off a provider Session or that the Server API cannot preserve the
required Conductor isolation, stop before deleting Orca and amend this plan
with the evidence.

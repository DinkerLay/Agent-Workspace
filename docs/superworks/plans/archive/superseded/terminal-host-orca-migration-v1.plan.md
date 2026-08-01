# Terminal Host Migration v1: Orca-Class Native OpenCode Runtime

Date: 2026-07-25

Status: Superseded as the terminal-runtime target by
[`../../../spec/orca-terminal-runtime-adoption.md`](../../../spec/orca-terminal-runtime-adoption.md).
Its implementation notes are historical evidence only: the current custom
Host is a partial migration, not Orca Runtime parity.

Implementation record (2026-07-25):

- Step 1 is implemented and covered by focused host tests: Main-owned
  headless xterm model, sequenced host snapshots, renderer attachment fences,
  bounded ACK delivery, node-pty pause/resume, and incarnation isolation.
- Step 2 is implemented for the active Electron terminal: preload exposes
  attach / ACK / detach; `PtyTerminal` restores host snapshots and ACKs only
  from xterm's write callback. Snapshot parsing uses the same ACK gate: a
  host delta cannot interleave with an unparsed snapshot, and a newer snapshot
  is requested if PTY output arrives in that interval. The legacy raw event
  publisher remains only as compatibility transport for historical surfaces.
- Step 3 is partly implemented. The active bridge no longer parses OpenCode
  TUI prompt text or wall-clock quiet periods for dispatch/wakeup readiness;
  normal `opencode` TUI replaces `--mini`; MCP dispatch accepts a stable
  `agentId` and Runtime resolves/redacts the physical Session identity.
  Conductor provider reads are now bound to its kickoff-marked provider
  session rather than the project-wide latest answer, and Runtime wakeups use
  the Session Authority input arbiter. `desktop:agent-loop-control-plane-harness`
  proves dispatch, semantic result wakeup, correction, delivery evidence, and
  achieved transitions against a native PTY fixture. A separate real Provider
  harness launches the normal OpenCode TUI with
  `opencode-go/deepseek-v4-flash`, writes a worker contract through the same
  Session Authority path, and reads its stopped answer from the exact
  provider Session recorded for that dispatch. This proves the native TUI,
  host terminal data plane, controlled input, and provider-result boundary
  together; it does not infer completion from terminal bytes. A full normal
  real-OpenCode Agent Loop E2E now also proves: Conductor ends its initial
  decision, Provider confirms one native Publisher result, Runtime sends one
  semantic wakeup through the Host input authority, Conductor claims the
  declared artifact, and a user-controlled call marks the Task `achieved`.
  A second real E2E now proves a genuine correction loop: the first Publisher
  dispatch creates a deliberately incomplete artifact; its provider result
  wakes Conductor; Conductor reuses the same approved Publisher card for a
  corrective native Session turn; the corrected provider result causes the
  second wakeup and only then permits the completion claim. A third real E2E
  proves provider-native attention: the Publisher invokes OpenCode's own
  `question` tool, Runtime persists `waiting_input` from the Provider record,
  sends exactly one Conductor wakeup, retains the native question in the
  Publisher terminal, and leaves the Task/Run running without inventing a
  response or claiming delivery.
- The Agent Loop Workbench now uses an Orca-inspired Task Tab + recursive
  Group Layout Tree. A Task Run owns persisted Group placement, active tabs,
  focus, and split ratios; the renderer keeps one mounted terminal view per
  real native Session in an overlay layer positioned against Group bodies.
  This replaces the old permanent Session rail/inspector. Group manipulation
  never launches a process, and only actual Conductor-dispatched Sessions are
  visible. Hidden Session views remain terminal-host attached but defer
  expensive xterm fitting during divider drags, fitting when visible again.

Implementation update (2026-07-26):

- Main and renderer scrollback are now both 5,000 rows. The headless snapshot
  includes normal versus alternate-buffer state, so the renderer does not
  present an OpenCode full-screen TUI as ordinary shell history.
- Session Store appends a byte-bounded 8MiB `terminal.raw.log` per Session.
  This is intentionally outside `events.jsonl`: raw TUI bytes remain transport
  evidence and never become semantic Conductor input.
- Workbench now exposes that retained tail only through an on-demand terminal
  diagnostics drawer for the selected, Task-owned Session. Main validates the
  Task/session association and restores the Task `cwd` before the Session Store
  read; the renderer labels it as raw PTY evidence rather than Timeline state.
- Workbench Groups now persist a compact terminal font size (8–18px) and
  reject splits below a usable native TUI area (520×250). Existing layouts that
  no longer fit collapse into a tab Group; sessions are neither restarted nor
  dispatched by this view operation.
- **Superseded orchestration experiment (2026-07-26):** the former explicit
  Publisher owner, Reviewer-to-Publisher repair route, Reviewer re-check, and
  skipped-phase completion gate are incorrect for Agent Loop. They remain a
  description of the then-current implementation only. Their removal is
  planned in
  [`../completed/agent-loop-conductor-autonomy-rework-v1.plan.md`](../completed/agent-loop-conductor-autonomy-rework-v1.plan.md).
  The Conductor OpenCode config retains its restricted Workspace dispatch
  capability and does not directly edit worker-owned deliveries.
- Evidence: focused unit suite (57 tests), native PTY control-plane harness,
  OpenCode inline-config smoke, and Electron Agent Loop UI smoke all passed on
  2026-07-26.

## Why this replaces the current active terminal path

The active Agent Loop path currently treats `node-pty` output as a bounded
string tail and pushes chunks directly to a renderer-owned xterm. That is not
a recoverable terminal runtime: the renderer is the only effective terminal
model, output delivery has no processed-byte acknowledgement, hidden panes
cannot reliably restore the same TUI, and raw terminal text was incorrectly
allowed to influence dispatch readiness.

This plan adopts the narrow terminal-runtime mechanisms demonstrated by Orca:
host-owned PTY sessions, a host-owned headless terminal model, attach/restore,
sequenced output, processed-byte acknowledgement, bounded pending delivery,
and producer pause/resume. It does not copy Orca's worktree, SSH, remote
daemon, orchestration, or product UI layers.

## Scope and non-negotiable boundaries

- Agent Loop v1 remains the only active orchestration mode. No Graph or
  Workflow surface is introduced.
- Electron Main owns every live native OpenCode PTY. Renderer code never
  chooses executable arguments and never owns authoritative terminal state.
- All visible Session Agents are native `opencode` terminals. Launches use
  normal `opencode --model <model>`, not `--mini`.
- The first contract for a newly launched Worker uses OpenCode's own normal
  `--prompt` argument. That avoids dropping a paste while a blank interactive
  TUI is booting; it does not install Workspace MCP or a custom system prompt.
  Later contracts for that live Session use the Host's serialized PTY input.
- Conductor is the only Session with Agent Workspace MCP. It decides work;
  Runtime never decides the next task action.
- Terminal bytes are diagnostic/rendering transport only. They never decide
  dispatchability, completion, permission, or Task status.
- OpenCode Provider Adapter reads provider-native structured state. PTY data
  and process exit only trigger targeted inspections.
- Existing historical Runs remain readable. New Agent Loop Runs use the new
  host. The old `pty-manager` is compatibility-only until no active route
  depends on it.

## Target ownership

```text
Renderer TerminalClient
  -> attach(session id, client generation)
  <- snapshot + sequenced delta
  -> processed-byte ACK, resize, user input

Electron Main TerminalHost
  -> Session Authority / create-or-attach / incarnation guard
  -> node-pty owner + serialized input arbiter
  -> headless xterm terminal model + bounded scrollback
  -> delivery window + pending-output cap + pause/resume

OpenCode Provider Adapter
  <- targeted PTY lifecycle trigger
  -> provider-derived result / attention / delivery confirmation

Conductor
  -> dispatch(agentId, explicit contract)
  <- durable semantic event / compact wakeup
```

## Runtime contracts

### TerminalHost

`TerminalHost` is the only physical-terminal owner. A known Workspace Session
can be `createOrAttach`-ed by logical session id and operation id. Repeated
equivalent activations attach to the current incarnation; stale exit, output,
resize, write, or ACK events must not mutate a replacement incarnation.

Each host Session owns:

- `node-pty` lifecycle and process identity;
- `HeadlessTerminalModel` with terminal dimensions and fixed scrollback;
- a sequenced raw-output stream;
- a byte-bounded pending delivery queue;
- serialized input from `dispatch`, `runtime_wakeup`, and `user` sources;
- one or more renderer attachment records and their ACK credits.

The model receives every PTY data chunk before a renderer can see it. Snapshot
creation and pending-output drain are atomic with respect to model sequencing;
there is no renderer-side transcript used as recovery truth.

### TerminalClient transport

The renderer attaches to one selected Session. Attach returns a host snapshot
with terminal grid, bounded scrollback, dimensions, and stream sequence. Live
deltas carry sequence and raw byte accounting. The renderer ACKs only after
xterm has consumed or deliberately discarded the delivered bytes.

When a renderer falls behind or is hidden:

1. Main marks the attachment as needing restore and stops retaining an
   unbounded renderer queue.
2. Main applies producer flow control when the unacknowledged window crosses
   its safe limit.
3. On resume/reattach, renderer resets from the host snapshot and continues
   at the new sequence.

No raw output is replayed blindly after a snapshot. A lost or stale ACK is
recoverable through attachment generation and a cumulative processed-byte
position; it is never inferred from terminal prompt text.

### Provider semantic layer

`OpenCodeProviderAdapter` is above `TerminalHost`. A PTY data/exit event
debounces an inspection for that Session only. The adapter reads OpenCode's
structured data to confirm dispatch marker delivery, completed answer,
artifact, provider-native permission, provider-native question, block, or
exit. It writes a compact durable event. Only then does Runtime wake
Conductor.

No wall-clock completion timeout is part of the default path. A separate,
explicitly configured SLA watchdog may report a stuck Session but cannot call
it complete or kill it merely because time elapsed.

### Conductor control layer

Conductor sees stable `agentId` values from the Template, never physical PTY
or provider session identifiers. It calls:

```text
dispatch(taskId, agentId, assignment, expectedOutput, contextRefs, priority)
```

Runtime resolves `agentId` to the immutable Agent Card and canonical Workspace
Session. The durable dispatch lifecycle is:

```text
created -> native_prompt_started | input_enqueued -> provider_confirmed -> running
        -> result_available | waiting_input | permission_required | blocked
```

`native_prompt_started` is the first-contract equivalent: OpenCode itself
receives the contract as a normal launch argument. `input_enqueued` is proof
only that the Host serialized a later contract into an already live native
session. `provider_confirmed` comes only from the Provider Adapter. Neither
path uses TUI text parsing or an immediate database race.

## Deliverables and sequence

### Step 1 — Terminal model and host core

Files/areas:

- `desktop/runtime/terminal-host.cjs`
- `desktop/runtime/terminal-session.cjs`
- `desktop/runtime/headless-terminal-model.cjs`
- `desktop/runtime/terminal-delivery-window.cjs`
- focused tests beside each module

Behavior:

- create-or-attach, operation replay, incarnation guard, input ordering;
- model-first PTY ingestion, snapshot/delta cursor, bounded scrollback;
- pending output byte cap and producer pause/resume;
- detached client recovery through snapshot, not transcript replay.

Verification:

- a deterministic PTY fixture validates redraw, resize, slow ACK, detach,
  reattach, stale output/exit, and bounded memory.

### Step 2 — Electron bridge and renderer terminal client

Files/areas:

- `desktop/main.cjs`, `desktop/preload.cjs`
- `src/runtime/nativeBridge.ts`
- `src/components/PtyTerminal.tsx`
- `src/styles.css`

Behavior:

- attach/snapshot/ACK/restore protocol replaces transcript-tail polling;
- xterm ACK is deferred until parse/write consumption;
- Workbench keeps the application viewport fixed; only the terminal viewport
  scrolls;
- selected native Session shows normal `opencode` TUI and direct input.

Verification:

- Electron smoke proves a full redraw does not expand document height,
  renderer backpressure restores a correct screen, and no unbounded queue is
  retained.

### Step 3 — Provider Adapter and Agent Loop control-plane migration

Files/areas:

- `desktop/runtime/opencode-provider-adapter.cjs`
- `desktop/session-wakeup-monitor.cjs`
- `desktop/conductor-mcp-server.cjs`
- `desktop/conductor-tool-bridge.cjs`
- `desktop/runtime/agent-loop-v1-runtime.cjs`
- `desktop/session-store.cjs`

Behavior:

- eliminate active-path TUI prompt regexes and immediate delivery checks;
- strict MCP schemas and boundary validation reject malformed assignments;
- resolve `agentId` inside Runtime; a Worker never sees Workspace MCP;
- return compact task state to Conductor; full Template JSON never enters its
  terminal tool output;
- update Workbench cards so `Conductor turn completed` means
  `awaiting decision`, not `succeeded`.

Verification:

- Harness: Conductor dispatches two Agent Cards by `agentId`; both receive a
  real native input contract; adapter confirms markers; one result and one
  attention event wake Conductor exactly once; Conductor issues a correction;
  final artifact becomes `delivery_ready`; user marks `achieved`.
- Real E2E: normal OpenCode TUI runs a real Conductor with the Workspace MCP
  bridge and a native Publisher without Workspace MCP. The first Conductor
  decision ends in `waiting_conductor`; the Provider Adapter records the
  Publisher result; one durable `conductor.wakeup.sent` begins the next
  Conductor decision; it calls `claim_task_completion`; the Harness verifies
  the artifact and performs the user-controlled `achieved` transition.

## Explicit exclusions from the first migration

- Orca remote daemon, SSH/WSL, worktrees, mobile clients, terminal query
  responder parity, and renderer-owned cold-history persistence;
- Workflow/Graph runtime and UI;
- synthetic terminal logs or terminal-text task state inference.

## Completion gate

The migration is not complete until all of the following are demonstrated in
Electron, not only unit tests:

1. normal OpenCode TUI attaches to a host-owned Session;
2. closing/reopening the Workbench recovers the same TUI from host state;
3. output flood remains bounded and triggerable backpressure does not corrupt
   the screen;
4. Conductor dispatch uses only `agentId`, and malformed payloads cannot turn
   into `"[object Object]"` work;
5. provider-derived result/attention, not terminal text, drives wakeup;
6. Task reaches `delivery_ready` and then user-controlled `achieved`.

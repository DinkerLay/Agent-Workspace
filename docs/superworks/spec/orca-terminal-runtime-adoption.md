# Orca Terminal Runtime Adoption Specification

Date: 2026-07-26

Status: Accepted architecture decision. The Orca-style local daemon is now the
Electron production PTY owner: Electron Main is a daemon client/coordinator,
not a `node-pty` owner. H0/H1/H1.5/H2/H3 transport, renderer, and
provider-fact harnesses
are implemented and verified. Full Electron visual-surface automation remains
an explicit H2 follow-up; it is not required to claim terminal ownership or
Provider receipt correctness.

Reference implementation:

- source: `/Users/dingyujie/CODES/GITREF/orca`
- revision: `8f5a45401fc65b4052797b43d251d44c9c691769`
- license: MIT, copyright notice retained for copied source

This specification supersedes the implementation-complete claims in
[`../plans/archive/superseded/terminal-host-orca-migration-v1.plan.md`](../plans/archive/superseded/terminal-host-orca-migration-v1.plan.md).
That plan remains useful historical evidence, but it does not define the
target terminal runtime.

## Decision

Agent Workspace will adopt the **local terminal runtime mechanics** of Orca as
a coherent subsystem. It will not continue evolving a custom Electron-Main
PTY host that merely resembles Orca in a few places.

"Adopt" means porting the ownership, lifecycle, stream, snapshot, recovery,
and backpressure contracts together. It does **not** mean copying Orca's
entire product, its worktree product surfaces, or its provider-specific agent
UI.

The resulting architecture has three strictly separate layers:

```text
Orca-derived Terminal Runtime
  create/attach/write/resize/snapshot/output stream/ACK/exit
  reports only transport and process facts

OpenCode Provider Adapter
  reads OpenCode-native structured state
  reports only Provider facts for a known dispatch

Agent Workspace Coordinator
  persists dispatch receipt and Provider facts
  wakes Conductor when a durable decision point exists
```

Conductor sits above those layers. It is never a terminal owner and never a
parser of terminal text.

## The distinction that was previously blurred

Orca terminal operations and Agent Workspace Conductor tools are not
equivalent APIs.

| Plane | Owner | Interface | Meaning |
| --- | --- | --- | --- |
| Terminal data plane | Orca-derived daemon and terminal client | `createOrAttach`, `write`, `resize`, `pausePty`, `resumePty`, `getSnapshot`, `takePendingOutput`, `detach`, `kill` | Establishes and operates a real terminal. |
| Provider semantic plane | OpenCode Adapter | dispatch-scoped inspection and Provider hook events | Determines whether OpenCode received input, is busy, needs input, returned a result, or stopped with an error. |
| Task control plane | Conductor MCP | `call_session`, `call_sessions`, `read_task_state`, `read_session`, `claim_task_completion` | Lets Conductor make task decisions. It never exposes raw terminal control. |

It is therefore correct that Conductor tool names differ from Orca's terminal
RPC names. What must not differ is the terminal Runtime mechanism underneath.

In particular, `call_session` must not itself own PTY spawn, PTY write, a
synchronous OpenCode-database race, or a terminal transcript interpretation.
It creates one durable dispatch command. The Coordinator then asks the
Terminal Runtime and Provider Adapter to do their respective jobs.

## Orca mechanisms that must be migrated together

The following is the required local-runtime subset of Orca revision
`8f5a45401`.

### 1. Local daemon and host ownership

Use Orca's daemon boundary, not a renderer-owned terminal and not a loose
Electron-Main event emitter:

```text
Renderer TerminalClient
  <-> daemon control RPC + ordered output stream
  <-> TerminalHost
  <-> one native PTY process per live terminal Session
```

The Host must own the `Session` map, native process handles, headless terminal
emulator, final snapshots, and process reaping. A renderer is an attachment;
closing or reloading it must not recreate or replay the provider TUI.

Port these Orca concepts as one unit:

- `TerminalHost.createOrAttach()`;
- `Session` as the physical PTY and terminal-emulator owner;
- `ClaimedAgentPtyOwnerRegistry` plus generation checks;
- tombstones and reaping after confirmed process exit;
- daemon control RPC and ordered output stream.

The required invariant is:

```text
one logical Workspace Session
  -> at most one current physical PTY owner
  -> one generation/incarnation
  -> stale write, resize, output, ACK, or exit cannot affect its replacement
```

`createOrAttach` returns Host facts such as `isNew`, snapshot, PID and
incarnation. It is not a claim that an OpenCode task was received.

### 2. Daemon-owned terminal emulator and recovery

Every PTY byte is first consumed by the Host-owned headless terminal emulator.
The authoritative recovery state is a host snapshot, including the screen,
scrollback, terminal modes, dimensions, and parser tail where needed.

The renderer must use this recovery path:

```text
attach / reconnect
  -> obtain Host snapshot
  -> render and finish parsing snapshot
  -> ACK snapshot cursor
  -> receive ordered deltas after that cursor
```

It must not reconstruct a TUI by replaying an unbounded browser-side
transcript. It must not let a normal page scrollbar become terminal history.

### 3. Ordered output, ACK, and backpressure

Output delivery must use the Orca model, not arbitrary IPC pushes:

```text
PTY output
  -> Host emulator
  -> sequenced output stream
  -> Renderer parses/writes xterm
  -> Renderer sends cumulative processed-byte ACK
  -> Host releases pending output or pauses/resumes the PTY producer
```

The ACK occurs only after xterm consumes or explicitly discards the bytes.
If an attachment falls behind, it is fenced for a fresh snapshot instead of
accumulating an unbounded queue. `takePendingOutput` and snapshot capture must
be atomic with respect to the Host sequence.

This is the mechanism needed for hidden panels, split panes, renderer reload,
large OpenCode redraws, and multiple running Sessions.

### 4. Input and process lifecycle

All input, including user keystrokes and Runtime-delivered Conductor/worker
messages, crosses the Host's serial input authority. No renderer and no
Conductor MCP handler writes directly to `node-pty`.

The Host is authoritative for these facts only:

- a native process was created or attached;
- a write was accepted or rejected by the Host;
- dimensions changed;
- producer flow was paused or resumed;
- the process emitted output;
- the process exited with an exit code;
- a client attached, detached, or needs a restore.

On exit, final output is ordered before the exit event, the owner claim and
generation are released, and the Session is reaped only after the final
snapshot/checkpoint contract is satisfied.

## Dispatch is a cross-layer receipt protocol

A task dispatch has several different facts. They must never be compressed
into one ambiguous `running` flag.

```text
Conductor call_session
  -> dispatch.command.accepted       (durable intent only)
  -> terminal.input.accepted         (Host accepted serialized input)
  -> dispatch.provider.received      (OpenCode persisted the exact dispatch marker)
  -> provider.turn.running | retry   (OpenCode reports active turn)
  -> provider.turn.result | attention | failure | exit
```

The canonical dispatch identity is the immutable `dispatchId` generated when
the command is accepted. The Provider receipt is the exact OpenCode user
message containing:

```text
[Agent Workspace] Dispatch ID <dispatchId>
```

The receipt must include the matched Provider session/message identity and be
persisted as durable evidence. A successful PTY `write` is not a Provider
receipt. A visible terminal prompt is not a Provider receipt. A fixed delay is
not a Provider receipt.

The Coordinator may expose command progress to Conductor through
`read_task_state`:

| Dispatch state | Proven fact |
| --- | --- |
| `queued` | Conductor command is durable; delivery has not yet been confirmed. |
| `input_accepted` | Host serialized the input to the current terminal incarnation. |
| `delivered` | OpenCode recorded the matching dispatch marker. This is the only "dispatch succeeded" state. |
| `result_available` | Adapter extracted a valid completed Provider answer or declared artifact. |
| `waiting_input` / `permission_required` | Provider needs attention. |
| `blocked` / `result_invalid` / `exited` | Provider reached a failure fact without a usable result. |
| `delivery_failed` | The host could not create/write the target, or Provider reached a terminal state without ever receiving the dispatch. |

The initial `call_session` response may say only `accepted` with
`deliveryState: input_accepted`; it must not manufacture `delivered` from an
immediate database query. A later Provider event or targeted Adapter
inspection records the receipt.

## Provider Adapter boundary

The OpenCode Adapter is a separate, narrow component. It is triggered by a
Host data/exit event or an OpenCode hook event, then reads only the
dispatch-bounded OpenCode structured state.

It returns facts such as:

```text
provider.received
provider.busy
provider.retrying
provider.waiting_input
provider.permission_required
provider.completed_with_answer
provider.completed_without_result
provider.blocked
provider.exited
```

It must not read terminal prose to decide any of those facts. A tool error
seen while OpenCode remains busy is a bounded diagnostic, not automatically a
failed Dispatch. If OpenCode reaches a terminal Provider state without a valid
answer, the Adapter records the structured failure evidence and the
Coordinator wakes Conductor once.

For example, an `unknown certificate verification error` is not a Runtime
retry instruction. It is a Provider/tool failure fact. The Coordinator records
it; Conductor decides whether to use another source, another Session Card,
the same card with a changed assignment, or ask the user to repair the local
certificate environment.

## Conductor wakeup and retry boundary

Runtime wakes Conductor for a durable result, failure, attention, exit, or
user message. The wakeup contains the dispatch identity and bounded evidence,
not raw TUI history. Conductor begins the new decision by reading Task state.

```text
Runtime wakeup: Searcher-0 requires a decision
Dispatch ID: 34FD6A
Provider fact: blocked
Evidence: WebFetch certificate validation failed; no valid answer was recorded.
```

Runtime never chooses the next card, route, repair, retry, review, or task
completion. This remains true even if an error looks technically retryable.

There are three distinct retry classes:

| Class | Owner | Example |
| --- | --- | --- |
| Host transport recovery | Terminal Runtime | reconnecting an authenticated daemon or retrying an idempotent infrastructure operation once. |
| Provider-internal retry | OpenCode | OpenCode emits its own `retry`/`busy` status. Runtime observes it. |
| Task retry or changed assignment | Conductor | re-dispatching a Session Card with another source or a corrected contract. |

Only the first class is automatic Runtime behavior. Orca does not run a
Conductor or retry an Agent task; its Host reports terminal lifecycle facts and
its OpenCode hook updates provider UI status.

## What the current implementation must stop doing

The existing local `desktop/runtime/terminal-host.cjs` and
`terminal-delivery-window.cjs` demonstrate useful concepts, but they are an
incomplete reimplementation, not the adopted target. Do not add new terminal
features to them except a narrowly scoped safety fix needed to keep the app
running during migration.

The following coupling must be removed:

```text
Conductor tool bridge
  -> start a PTY
  -> write a worker prompt
  -> synchronously query OpenCode storage
  -> decide whether dispatch was delivered
```

The bridge may create a dispatch command. It must delegate all terminal
operations to the Orca-derived Runtime and receive later durable facts from
the Coordinator.

Likewise, an OpenCode `session.error` must not be collapsed into an `idle`
UI update that discards its error details. The Provider Adapter owns that
normalization.

## Migration sequence

### Phase A — Characterize and freeze the old data plane

1. Mark the current custom terminal host as transitional.
2. Add black-box fixtures for native TUI redraw, renderer reload, stale
   generation, slow ACK, process exit, and concurrent create-or-attach.
3. Do not add further Task semantics to PTY or renderer code.

Completion: the old and new runtime can be compared against the same terminal
fixtures without using terminal text as semantic truth.

### Phase B — Port Orca's local daemon/Host protocol as a unit

1. Port the narrow Orca daemon, `TerminalHost`, `Session`, headless emulator,
   session ownership/generation, snapshot, pending-output, and stream
   protocol modules with required MIT attribution.
2. Keep the Host RPC surface semantically aligned with Orca:
   `createOrAttach`, `write`, `resize`, `pausePty`, `resumePty`,
   `getSnapshot`, `takePendingOutput`, `detach`, `kill`.
3. Make Electron Main a client/coordinator of that local daemon rather than
   the bespoke terminal implementation.

Completion: a normal OpenCode TUI survives renderer detach/reload and returns
to the same live Host session without duplicating a PTY.

Current checkpoint: `desktop/runtime/orca-terminal-daemon.cjs` provides a
local control RPC and separate ordered stream with claim/generation fencing;
`desktop/runtime/orca-terminal-daemon-child.cjs` runs it as a real child
daemon. `desktop/runtime/orca-terminal-daemon-manager.cjs` is now wired into
Electron Main, so Main retains lifecycle metadata and client attachments only;
the child daemon owns `node-pty`, the headless terminal state, and snapshots.
The existing `terminal-host.cjs` remains a bounded internal migration primitive
inside that daemon, not an Electron-Main PTY owner.

### Phase C — Replace the renderer terminal connection

1. Port the Orca-style connection and parse-deferred ACK behavior.
2. Make group/split/tab layout attach existing terminals only; layout never
   controls process life or buffer truth.
3. Enforce minimum usable terminal dimensions by choosing tabs over an
   unreadable split; terminal zoom changes only terminal font/resize behavior.

Completion: output floods remain bounded, alternate-screen TUI redraw does
not expand the application document, and normal-buffer scrollback remains
inside the terminal viewport.

Current checkpoint: the renderer uses the daemon attachment/snapshot/delta/ACK
bridge when native transport is available; terminal zoom and split minimums
are already applied by the terminal surface. H1.5 proves the Main boundary;
H2 proves the real Electron xterm attachment path. Renderer reload and
deliberately blocked-ACK cases remain regression extensions of H2, while the
underlying reconnect/backpressure contract is already covered by H0/H1.

### Phase D — Rebuild dispatch receipt and Provider outcomes above it

1. Make `call_session` append a durable command and return its command ID.
2. Let Coordinator activate/attach the approved Session Card and enqueue the
   normal OpenCode input through the Host input authority.
3. Use OpenCode hook/DB facts to record Provider receipt and state changes.
4. Persist result/failure/attention events once per dispatch/provider event
   identity and wake Conductor once per new decision point.
5. Remove synchronous marker confirmation and terminal-text failure logic
   from the Conductor bridge.

Completion: a real TLS/tool failure moves a worker out of `running`, appears
in Task state, and wakes Conductor without an arbitrary timeout or automatic
task retry.

Current checkpoint: `call_session` records `input_accepted` only;
`inspectDispatchProviderState()` and authenticated OpenCode hook events feed
the Coordinator, which persists `dispatch.provider.received` and
`dispatch.provider.failed` before waking Conductor. H3 proves that boundary
against real daemon-owned PTYs and a deterministic Provider fixture. H4 proves
the live Provider success path; a live-provider failure fixture remains an
opt-in extension, not a reason to reintroduce synchronous database
confirmation into the tool call.

### Phase E — Retire compatibility paths

Remove the old custom host, raw PTY event compatibility transport, and any
renderer transcript recovery path only after all live Workbench consumers use
the new daemon protocol.

Completion: there is one terminal owner, one output stream protocol, and one
provider-state path in production.

## Harness contract

The migration requires four different harness levels. A green unit test or a
successful OpenCode answer alone is not evidence that the Orca terminal
Runtime was adopted correctly.

All harnesses use two independent oracles:

```text
terminal oracle
  Host generation, PID count, snapshot/cursor sequence, ACK debt,
  producer pause/resume, exit ordering, and bounded memory

semantic oracle
  durable dispatch/provider event records and the exact Conductor wakeup
```

No harness may use a terminal string such as `Thinking`, `Build`, a visible
prompt, spinner output, or free-form "done" prose as a semantic oracle.

### H0 — TerminalHost contract harness

**Current command:**

```text
npm run desktop:orca-terminal-contract-harness
```

**Target files:**

```text
desktop/orca-terminal-contract-harness.cjs
desktop/runtime/orca-terminal-host*.test.mjs
```

It runs a deterministic PTY fixture; it does not invoke OpenCode or a model.
The current checkpoint proves ownership/adoption, stale generation write and
output fencing, Host snapshot recovery, cumulative ACK pause/resume, and final
output-before-exit ordering. The finished H0 gate must additionally prove all
of the following:

1. two concurrent `createOrAttach` calls for one logical Session and owner
   claim produce one native spawn, one current generation, and compatible
   attach results;
2. an old generation's data, exit, resize, write, or ACK is rejected/ignored
   after a replacement Session becomes current;
3. a reconnect receives a Host snapshot before any later delta, and does not
   replay old input into the process;
4. snapshot ACK followed by deltas preserves byte/cursor order exactly;
5. withholding ACK beyond the configured window pauses the producer; releasing
   it or restoring a snapshot resumes without unbounded retained output;
6. terminal alternate-screen redraws are represented by a correct Host
   snapshot, not by a browser transcript;
7. final output is delivered before the ordered exit event; only then is the
   owner claim/reaper allowed to remove the dead Session.

The fixture must assert physical spawn count, Host snapshot/cursor state, and
process exit events. It must not inspect visual text beyond deterministic
screen-fidelity assertions.

### H1 — Local daemon protocol harness

**Current command:**

```text
npm run desktop:orca-terminal-daemon-harness
```

**Target file:**

```text
desktop/orca-terminal-daemon-harness.cjs
```

This starts the local daemon as a real child process and uses two minimal
daemon clients, not Electron's renderer. The current checkpoint proves child
startup, two independent control clients, separate output stream reconnect,
snapshot recovery, no duplicate PTY, and final output-before-exit ordering.
The finished H1 gate must prove the full Orca-aligned control/stream boundary:

1. `createOrAttach` returns `isNew`, PID, snapshot, and incarnation;
2. `write`, `resize`, `pausePty`, `resumePty`, `getSnapshot`,
   `takePendingOutput`, `detach`, and `kill` cross the daemon protocol;
3. control replies are not confused with ordered PTY output;
4. a disconnected client can reconnect and recover from a snapshot without a
   duplicate PTY;
5. a dead daemon is distinguishable from a dead OpenCode process;
6. daemon/process cleanup leaves no surviving test PTY.

This is the harness that prevents an Electron-Main-only imitation from being
called an Orca Runtime port.

### H1.5 — Electron Main daemon-manager harness

**Current command:**

```text
npm run desktop:orca-terminal-manager-harness
```

This real-child-daemon harness proves that Electron Main has no in-process
PTY: it creates a native `/bin/cat` Session through the daemon manager,
attaches a renderer-like client, ACKs a delta after receipt, resizes and
writes through the daemon, observes output independently, and receives exit.
It is the production ownership gate for the current Electron integration.

### H2 — Electron terminal-surface harness

**Current command:**

```text
npm run desktop:orca-terminal-electron-harness
```

**Current file:**

```text
desktop/agent-loop-v1-ui-smoke.cjs
```

This runs Electron with a real xterm renderer against the local daemon. The
current H2 harness proves daemon snapshot/delta/ACK delivery, persisted
terminal diagnostics, a compact Group layout, and a no-page-scroll terminal
surface. Its continuing coverage contract is:

1. a normal OpenCode TUI appears from the Host snapshot, receives user input,
   and stays attached to the same PID through pane hide/show and renderer
   reload;
2. xterm sends ACK only after its write callback/parse work completes;
3. a deliberately blocked ACK creates Host backpressure but does not grow the
   page height or an unbounded renderer queue;
4. normal-buffer history scrolls inside the terminal viewport, while an
   alternate-screen TUI remains a live screen rather than fake scrollback;
5. splits and tabs are merely multiple attachments/layout choices. A too-small
   pane keeps a Session in a tab rather than resizing OpenCode into an
   unreadable terminal;
6. closing a Task tab detaches the renderer surface only. It does not kill the
   native Session; reopening attaches it again.

### H3 — Provider receipt and Conductor wakeup harness

**Current command:**

```text
npm run desktop:orca-terminal-provider-coordinator-harness
```

**Current file:**

```text
desktop/orca-terminal-provider-coordinator-harness.cjs
```

This harness uses real daemon-owned PTYs plus a deterministic OpenCode
structured-state fixture. It does not require a live model. For one
`dispatchId`, it currently proves terminal input acceptance, exact Provider
receipt, terminal Provider failure, one durable Conductor wakeup, and no
Runtime worker re-dispatch. The broader table remains the required extension
set for future Provider fixtures:

| Scenario | Required durable outcome | Must not happen |
| --- | --- | --- |
| command recorded, Host write accepted, no Provider marker yet | `queued` / `input_accepted` | claim `delivered` merely because a PTY write succeeded |
| exact OpenCode user-message marker appears | `dispatch.provider.received`, then `delivered` | create a second Dispatch or duplicate input |
| tool error appears but Provider remains busy | bounded diagnostic only | mark failed or wake Conductor |
| completed assistant answer in the exact dispatch window | `result_available`, one result, one wakeup | use raw PTY text as answer |
| Provider terminal failure with no valid answer | `blocked` or `result_invalid`, one failure wakeup | automatic re-dispatch or perpetual `running` |
| Provider-native question/permission | attention state, one attention wakeup | inject an answer or route to another worker automatically |
| process exits before Provider receipt | `delivery_failed` / `exited`, one failure wakeup | report normal running |

The wakeup is written only to the Conductor Session. The harness asserts that
Runtime did **not** call `call_session` itself: any retry must be a subsequent
explicit Conductor tool call.

### H4 — Opt-in real OpenCode Agent Loop harness

**Current commands:**

```text
npm run desktop:agent-loop-real-provider-harness
npm run desktop:agent-loop-real-conductor-harness
npm run desktop:agent-loop-real-correction-harness
```

**Current files:**

```text
desktop/agent-loop-real-provider-harness.cjs
desktop/agent-loop-real-conductor-harness.cjs
```

These require an installed/authenticated OpenCode and an explicit model
configuration. They are opt-in because network, credentials, and model
availability are external state. They now use the same local daemon manager
as Electron Main; neither harness creates the retired in-process TerminalHost.

The current H4 runs prove:

1. a normal OpenCode Provider Session completes two native turns through a
   daemon-owned PTY and exposes structured Provider receipts/results;
2. Conductor creates a durable dispatch command and ends its decision turn;
3. the Worker receives a native OpenCode assignment through the Host input
   authority;
4. a Provider receipt, completed answer, and one Runtime wakeup reach
   Conductor without terminal-text parsing;
5. a real correction is a new Conductor decision and a new `dispatchId` to the
   same approved native Agent Card; Runtime does not invent that correction;
6. only after the corrected Provider result satisfies the task conditions does
   Conductor issue its delivery claim and the user-level action mark the Task
   `achieved`.

The live Provider failure case remains covered deterministically by H3. H2
covers renderer attachment; a real active-turn renderer reload remains a
separate manual/visual regression extension.

### Existing harnesses and their migration role

The following scripts already exist. They are useful regression baselines but
are **not** proof of Orca Runtime parity:

| Existing command | Keep for | Does not prove |
| --- | --- | --- |
| `npm run desktop:smoke` | basic Electron activation, write, resize, snapshot and ACK against the current bridge | local daemon protocol, claimed ownership, reconnect, or full stream behavior |
| `npm run desktop:agent-loop-control-plane-harness` | durable dispatch/result/wakeup semantics with fixtures | native daemon, real renderer recovery, or real OpenCode Provider failure handling |
| `npm run desktop:agent-loop-real-provider-harness` | live normal OpenCode TUI through the daemon; exact Provider receipt/result for two native turns | renderer recovery or Provider terminal-failure handling |
| `npm run desktop:agent-loop-real-conductor-harness` | live daemon-backed Conductor → native worker → Provider return → Conductor delivery loop | renderer recovery or Provider terminal-failure handling |
| `npm run desktop:agent-loop-ui-smoke` | current app navigation and Loop surface | Host snapshot/ACK/output correctness |

The real Provider and Conductor scripts are now H4 coverage. Other legacy
scripts remain regression baselines until they are migrated or archived.

## Required verification

The migration is not complete until these real Electron checks pass:

1. two concurrent `createOrAttach` requests produce one physical OpenCode
   session and one current generation;
2. closing/reopening or reloading a terminal pane restores the same TUI from
   a Host snapshot, without duplicate/replayed input;
3. deliberately withheld renderer ACK applies backpressure and later restores
   the correct screen without unbounded memory growth;
4. exit follows final ordered output and cannot mutate a replacement Session;
5. `call_session` returns a durable command, and only the later OpenCode
   marker proves `delivered`;
6. a Provider tool/TLS error while busy remains a diagnostic; a terminal
   Provider failure with no valid answer writes `blocked` and wakes Conductor
   exactly once;
7. Conductor can re-dispatch only through its existing control-plane tools;
   Runtime never chooses the retry target or assignment;
8. the Workbench uses terminal tabs/splits as attachments to existing Sessions
   and never uses a browser document scrollbar as terminal history.

## Source map

The initial port must trace each local module to its Orca source revision:

| Required mechanism | Orca reference |
| --- | --- |
| Host ownership and agent generation | `src/main/daemon/terminal-host.ts`, `terminal-host-agent-session-claim.ts`, `terminal-host-agent-session-generations.ts` |
| Physical Session, terminal emulator, ordered exit | `src/main/daemon/session.ts` |
| Control and stream transport | `src/main/daemon/daemon-server.ts`, `src/main/daemon/client.ts`, `src/main/daemon/daemon-stream-data-batcher.ts` |
| Snapshot and pending output | `src/main/daemon/terminal-snapshot.ts`, `src/main/daemon/headless-emulator.ts` |
| Renderer reconnect and ACK | `src/renderer/src/components/terminal-pane/pty-connection.ts`, `terminal-pty-ack-gate.ts` |
| Provider UI hook reference only | `src/main/opencode/hook-service.ts` |

The OpenCode Provider Adapter and Conductor Coordinator are Agent Workspace
code. They are intentionally not presented as copied Orca modules because
Orca does not implement our Agent Loop product semantics.

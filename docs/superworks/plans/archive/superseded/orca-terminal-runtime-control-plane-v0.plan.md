# Orca-Derived Terminal Runtime And Conductor Control Plane v0

Date: 2026-07-24

Status: Historical v0 plan. Superseded for the active runtime by
[`../../../spec/orca-terminal-runtime-adoption.md`](../../../spec/orca-terminal-runtime-adoption.md)
(2026-07-26): Electron Main is now the local-daemon client/coordinator, while
the daemon is the only PTY owner. This document records the earlier Main-owned
foundation and must not be used to reintroduce a direct Main PTY path or a
Workflow execution path.

## Goal

Replace the current direct PTY-start path with a runnable local terminal-runtime
authority. In v0, Electron Main hosts that authority behind a boundary that can
later move to a local daemon. A renderer or Conductor request activates a known
workspace Session; only Runtime claims or creates the physical PTY and
serializes terminal input. The first live orchestration path is Agent Loop.
Workflow execution was intentionally deferred until this shared Runtime was
proven. That condition is now met by the OpenCode Nested Workflow Harness;
this plan remains the authority for the lower-level Session ownership,
incarnation, and input-arbitration invariants.

## Product Boundaries

- Keep Task Architecture, Template provenance, Conductor policy, and Timeline
  semantics in the product/control plane.
- Adopt the Orca terminal-runtime invariants: host-owned execution, claim or
  spawn, operation replay, physical incarnation guards, bounded output, and
  serialized input.
- Do not embed Orca's renderer, worktree graph, or product UI. Its MIT-licensed
  narrow runtime mechanisms are adapted with attribution in source notices.
- Do not expose a Template, Workflow, Teams, Browser, or other product page
  from the runtime UI unless its backing command and durable state are live.

## Target Runtime Boundary

```text
Renderer / Conductor tool
  -> activateWorkspaceSession(session id, operation id)
  -> Runtime Session Authority
  -> Launch Registry + claim-or-spawn
  -> Execution Owner (node-pty / process fallback)
  -> Provider adapter + Session Store events

Renderer / Conductor tool
  -> enqueueTerminalInput(session id, expected incarnation, source, payload)
  -> Input Arbiter
  -> Execution Owner.write(...)
```

The renderer never provides an executable command or arguments to the
activation API. Before activation it may request registration of a declarative
Session configuration; Electron Main validates its Session/task/provider and
resolves the executable details. A registered Session Launch Profile is then
the only input to activation.

## Work Items

### 1. Terminal authority core

Output files:

- `desktop/runtime/session-authority.cjs`
- `desktop/runtime/terminal-input-arbiter.cjs`
- `desktop/runtime/terminal-output-buffer.cjs`
- focused node tests beside each module

Behavior:

- one live execution owner per Workspace Session claim;
- concurrent equivalent activation joins one spawn;
- repeated operation id replays the original result; a changed fingerprint is
  rejected;
- every physical start has a fresh `incarnationId` and generation;
- stale output/exit/write events cannot mutate a replacement incarnation;
- terminal output has a byte-bounded, cursor-addressable tail rather than the
  current chunk-count-only transcript retention;
- foreground terminal delivery is coalesced; hidden or inactive terminal
  surfaces do not retain an unbounded renderer queue and recover from a
  Runtime-owned snapshot plus a sequenced delta;
- only the input arbiter writes terminal bytes.

Verification:

- focused node tests prove concurrent activation, replay, conflict, stale exit,
  input order, output byte bounds, snapshot/delta sequencing, and hidden-pane
  recovery.

### 2. Desktop bridge migration

Output files:

- `desktop/main.cjs`
- `desktop/preload.cjs`
- `src/runtime/nativeBridge.ts`
- `desktop/pty-manager.cjs`

Behavior:

- new public APIs activate, enqueue input, resize, inspect, and stop a known
  Session;
- Electron Main validates declarative profile registration and resolves its
  executable details; activation accepts only Session ID and operation ID;
- legacy `startPty` remains test-only compatibility plumbing during this step,
  never a renderer-exposed capability;
- the Session Store records activation and incarnation facts with its existing
  semantic dispatch/result events.

Verification:

- Electron bridge smoke exercises activation, write, read, stop, and no duplicate
  physical process.

### 3. Conductor redesign and Agent Loop wiring

Output files:

- `desktop/conductor-tool-bridge.cjs`
- `src/orchestration/conductor-tools/*`
- `src/runtime/adapters/conductorRuntime.ts`

Behavior:

- Conductor owns task decisions and creates Session Demands/dispatches only;
- Runtime owns launch, liveness, terminal input, and provider delivery evidence;
- `call_session` becomes validate -> activate -> enqueue dispatch -> confirm;
- worker results and attention events wake Conductor through durable events;
- Conductor never receives direct PTY write or spawn authority.

Verification:

- existing session dispatch simulation passes through the new authority;
- a result event records a Conductor wakeup without relying on raw terminal text.

### 4. UI exposure cleanup

Output files:

- `src/app/shellConfig.ts`
- `src/App.tsx` and focused tests where required

Behavior:

- only implemented Task and Workbench runtime paths appear in normal navigation;
- no route markets mock capabilities as live product features;
- terminal panes use the new Session-centric APIs.

Verification:

- app smoke confirms unsupported pages are absent from normal navigation;
- desktop path reaches a real activated Session and its terminal state.

## First Vertical Slice

1. Register an already confirmed Conductor and one Worker Session Launch Profile.
2. Activate Conductor by Session ID.
3. Conductor invokes `call_session` for Worker.
4. Runtime claim-or-spawns Worker and serializes the dispatch input.
5. Provider adapter records durable Worker result.
6. Runtime records Conductor wakeup.
7. Tasks reads semantic events; Workbench reads the selected Session terminal.

## Explicit Deferrals

- remote execution host, SSH, multi-client shared terminal control;
- browser automation, Teams, mobile, and dashboard pages;
- terminal transcript as task semantic state.

Generated/manual Loop Template Draft persistence is now part of Agent Loop v1.
The former bounded Workflow graph runner is historical material at
`../../../spec/archive/2026-07-25-opencode-nested-workflow-harness.md`; it is not an
active Runtime dependency. The terminal transcript remains diagnostic evidence,
while the semantic Task Timeline stays independently recorded.

## Completion Criteria

- restarting a Session creates a new incarnation; old exit events are ignored;
- a client retry cannot duplicate a PTY;
- noisy terminal output cannot grow either host or renderer memory without a
  configured byte bound;
- no public renderer IPC starts arbitrary commands;
- Conductor cannot bypass Runtime with a raw PTY write;
- one real local Agent Loop dispatch can run, persist, be read, and wake
  Conductor;
- focused runtime tests, desktop smoke, full tests, and build pass.

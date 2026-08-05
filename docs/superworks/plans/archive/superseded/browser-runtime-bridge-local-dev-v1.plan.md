# Browser Runtime Bridge Local Development v1

Date: 2026-07-31

Status: first local-development vertical slice implemented

## Goal

Run the existing Vite renderer in Electron and an ordinary local browser at the
same time, using the same typed Renderer calls while a protected Host remains
the only owner of Task/Run state, PTYs, OpenCode, and project filesystem access.

## Scope

1. Add a loopback-only Runtime HTTP/SSE transport with an explicit allowlist of
   existing Agent Loop and terminal commands.
2. In `desktop:dev`, generate one ephemeral capability token and configure the
   Vite development proxy to add it server-side. The token must not be embedded
   in Vite client code, browser storage, Timeline data, or logs.
3. Add a browser implementation of the existing `NativeRuntimeBridge` contract.
   It uses the Vite proxy; Electron continues using preload IPC unchanged.
4. Carry Runtime invalidations and terminal attachment events through SSE. All
   attachment, expected-incarnation, input, and Task/Run checks remain in the
   existing Runtime owners.

## Non-goals

- exposing a PTY, provider data, project directory, or SQLite file directly to
  browser JavaScript;
- remote deployment, user accounts, cross-origin CORS, multi-user sharing, or
  a production authentication scheme;
- changing Task/Run, Dispatch, Terminal, or Provider lifecycle semantics;
- replacing Electron or moving the Runtime into a new process in this step.

## Ownership

```text
Browser Renderer -> browser RuntimeBridge -> Vite dev proxy -> loopback Host
Electron Renderer -> preload RuntimeBridge -> Electron IPC -> same Host owners
```

The HTTP/SSE layer is transport-only. `agent-loop-v1-runtime.cjs` remains the
Task/Run writer, `session-wakeup-monitor.cjs` the wakeup writer, and terminal
runtime modules the PTY/attachment/input writers. The bridge may only forward
validated user intent and typed read models.

## Security Boundaries

- Host listens on `127.0.0.1` only and rejects every request without the exact
  per-run bearer token.
- The Vite proxy supplies that token, so an ordinary page does not receive it.
- Browser status excludes the Conductor bridge URL, token, and server path;
  those remain inside the local Host and desktop-only IPC path.
- A browser connection receives a random in-memory client id. It scopes terminal
  attachment forwarding and is removed with its SSE connection.
- This is developer-local pairing, not an authentication implementation for a
  remote Host. Remote deployment remains blocked on user, Task, and project-root
  authorization.

## Verification

1. Node tests reject missing/incorrect tokens, unknown methods, and oversized
   requests; they prove only allowlisted calls and targeted SSE events pass.
2. Browser bridge tests prove the client uses the proxy, does not install on a
   failed status probe, and routes typed event channels correctly.
3. `npm run build` passes with no browser import of Electron or Node runtime
   modules.
4. `npm run desktop:dev` starts Vite, the loopback Host, and Electron; opening
   the printed Vite URL in a browser shows the same live Runtime status and
   performs a read-only Task list request. Native terminal interaction remains
   verified by the existing Electron terminal harness.

## Implementation record — 2026-07-31

- Added `desktop/runtime/runtime-bridge-http.cjs`: loopback-only HTTP/SSE
  transport with constant-time bearer-token validation, command allowlisting,
  bounded JSON requests, targeted event streams, and disconnect cleanup.
- Added `desktop/runtime/browser-runtime-bridge.cjs`: the transport adapter for
  existing Agent Loop and Terminal Runtime commands. It initially permits only
  its configured project root; a browser user may type one directory path and
  ask the Host to verify it exists. A successful verification grants that root
  only to the requesting browser client. Browser JavaScript never receives
  direct filesystem access or an unbounded directory listing.
- The browser may request at most 40 direct child-directory matches for its
  currently typed path prefix. This is an explicit Host read for autocomplete;
  it does not grant a project root until the user selects a match and Host
  validation succeeds.
- `desktop:dev` now creates one ephemeral token and passes it only to Electron
  and the Vite proxy. The browser uses `/runtime/*`; it never receives the
  token. Electron remains on preload IPC.
- Browser QA loaded the printed Vite URL, observed `Runtime online`, read the
  existing Task list, and navigated the completed Task view with no console
  errors.
- Passed: bridge Node tests, bridge/browser Vitest tests, `npm run build`, and
  `npm run desktop:smoke`.
- Residual unrelated verification failure: the existing
  `npm run desktop:agent-loop-ui-smoke` consistently times out at its native
  alternate-buffer wheel-report assertion. The new bridge is not enabled by
  that smoke command; its standard Electron bridge smoke passes. This remains
  a terminal-interaction regression to resolve separately before claiming the
  broader terminal acceptance suite green.

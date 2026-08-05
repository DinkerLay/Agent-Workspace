# Browser Client and Terminal Host Architecture

Date: 2026-07-29
Status: accepted direction; platform migration is not yet scheduled

## Decision

Electron is **not** part of Agent Workspace's product model. The renderer can
become a browser client and that is likely the better deployment shape for a
shared or remotely hosted workbench. Electron currently remains the MVP shell
because it packages a renderer together with the local privileges needed for
OpenCode, PTYs, project directories, and Runtime persistence.

The replacement is not a static web page. It is:

```text
Browser renderer
  -> authenticated Runtime Bridge (HTTP/WebSocket)
  -> Terminal Host / Runtime service
  -> PTY, OpenCode, project filesystem, Provider observer, durable Runtime state
```

The browser owns presentation, user intents, renderer attachment, and typed
read models. The Host owns every privileged or causal fact: process launch and
stop, terminal incarnations, input receipts, project-root access, durable
Task/Run/dispatch state, and Provider observation.

## Why a browser alone is insufficient

A normal browser cannot safely or reliably:

- launch or signal local OpenCode PTYs;
- preserve an interactive process after a tab reload;
- access an arbitrary project directory without a user gesture and a limited
  browser permission;
- read local Provider databases; or
- decide which local machine is authorised to act on a Task's project files.

Giving the browser direct filesystem or terminal control would reintroduce the
same hidden authority problem that the current Runtime boundaries prevent.

## Supported deployment shapes

| Shape | Browser | Host | Appropriate use |
| --- | --- | --- | --- |
| Current desktop | Electron renderer | Electron-main packaged local Host | MVP and local development |
| Local browser | normal browser | authenticated localhost companion service | likely next local-first deployment |
| Remote workspace | normal browser | authenticated per-workspace remote Host | shared/managed compute, later scope |

The first two may share the same `RuntimeBridge` operations and terminal
stream protocol. The Host transport changes; Task/Run semantics must not.

## Invariants for a browser client

1. A browser reload only detaches the renderer. If the Host still owns the
   terminal, reattachment returns the same logical Session and incarnation.
2. A missing Host terminal produces `recovery_required`; the web client cannot
   silently create a new Conductor just because it reconnected.
3. Authentication binds a user, Task, project root, and Host authority before
   terminal input, lifecycle control, or raw terminal history is exposed.
4. The Host validates every action against Task/Run ownership. Browser code
   cannot manufacture a session id or call a raw kill endpoint.
5. Project root is a Task fact owned by the Runtime; it is not an ambient
   browser path or a string trusted from the renderer.

## Migration gate

Do not remove Electron until all of the following exist and pass their
equivalent tests in a browser transport:

- a transport-independent `RuntimeBridge` with the same typed read models and
  user commands as the current IPC bridge;
- authenticated Host sessions and project-root authorization;
- terminal snapshot/delta attachment with disconnect/reload recovery;
- explicit current-Run recovery, Stop, cancellation, and raw-history behavior;
- durable Runtime storage owned by the Host rather than renderer memory; and
- local-companion installation and version compatibility checks.

The lowest-risk path is to retain Electron while the Runtime API is extracted
from `main.cjs`, then add a localhost Host adapter, and only then offer a
browser renderer. A remote Host is a separate security and operations decision,
not an automatic consequence of serving the UI over HTTP.

# Agent Loop Continuity and Code Ownership v1

Date: 2026-07-29
Status: superseded for continuity acceptance — live regressions found

## Goal

Make the Agent Loop usable as a stateful Task workbench: a Task-page follow-up
continues the live Conductor, and when that terminal is gone Send automatically
continues the same Task Run through Runtime recovery. Stop is co-located with
Send, material Sessions receive an automatic usable
Workbench layout, and the code implementing these rules has one named owner.

The original implementation record below is retained as historical context,
not as an acceptance claim. Real Task evidence subsequently found unresolved
post-restart cancellation reconciliation, incorrect `restart_or_recover`
projection, and unproven terminal wheel behavior. The active remediation and
acceptance criteria are now in
`agent-loop-continuity-regression-remediation-v1.plan.md`.

Authoritative inputs:

- `../../../spec/task-run-continuity-and-terminal-experience.md`
- `../../../spec/code-ownership-and-layer-map.md`
- `../../../spec/task-template-runtime-model.md`
- `../../../spec/orca-terminal-runtime-adoption.md`

## Non-goals

- Do not introduce a fixed Research → Review → Publish route.
- Do not replace Electron with a browser product in this plan.
- Do not perform a cosmetic repository-wide folder move.
- Do not let UI, terminal text, or a Provider observer decide Task completion.

## Steps

1. **Boundary baseline and agent instructions**
   - Goal: make ownership rules executable by contributors.
   - Output: corrected `AGENTS.md`, this plan, and focused source-map tests or
     comments where a new boundary is introduced.
   - Verify: document review, `git diff --check`.

2. **Run continuity control**
   - Goal: make a Task-page message the one explicit continuation action when
     the current terminal is absent.
   - Inputs: Task/Run store, Session Authority, terminal liveness, pending
     message/wakeup records.
   - Output: a focused Runtime run-control seam that preserves a pending
     message, reattaches or starts a replacement Host terminal for the same
     Run behind Send, and records recovery facts in Timeline. A pending message
     is not marked delivered without a fresh exact input receipt.
   - Verify: Runtime tests cover live continuation, unavailable-terminal Send,
     stale session ownership reconciliation, and no duplicate Conductor launch.

3. **Task composer controls and Timeline projection**
   - Goal: show connection/pending state beside Send, put Stop beside Send, and
     expose full user-visible Conductor content in Timeline.
   - Output: extracted Task composer/presentation components plus typed bridge
     fields; page header remains descriptive.
   - Verify: renderer tests and Electron Agent Loop UI smoke.

4. **Automatic initial Workbench placement and terminal interaction**
   - Goal: allocate actual concurrent Sessions into usable Groups automatically
     without launching/re-focusing them; preserve manual layout.
   - Output: one shared layout allocation policy used by Runtime validation and
     renderer reconciliation, plus terminal viewport interaction fixes/tests.
   - Verify: layout unit tests, terminal Electron harness for normal-buffer
     scroll, alternate screen, selection, and stable hide/show.

5. **Scoped dispatch cancellation**
   - Goal: give Conductor `cancel_dispatch(dispatchId, reason)` without direct
     process control.
   - Output: Coordinator command/receipt state, scoped bridge tool, terminal or
     Provider interruption adapter, and factual Timeline/Session projection.
   - Verify: coordinator tests prove requested → confirmed/failed, no automatic
     retry/Task completion, and no cancellation of a different Task/Run.

6. **Architecture decision: browser client**
   - Goal: decide whether the renderer can be independently deployed as a Web
     client while retaining a protected Terminal Host.
   - Output: a short ADR comparing Electron shell, local browser + localhost
     Host, and remote browser + authenticated Host; no platform migration until
     the selected deployment/security model is accepted.
   - Verify: decision records PTY, project-root access, reconnect semantics,
     authentication, and deployment consequences.

## Completion criteria

- Each implementation change follows the ownership map and has a single
  durable state writer.
- A real native OpenCode run demonstrates safe continuation through Send,
  composer Stop, automatic first layout, terminal interaction, and (when Step
  5 lands) scoped dispatch cancellation.
- Focused tests, build, applicable Electron/terminal harnesses, and diff review
  pass with their commands recorded in this plan.

## 2026-07-29 implementation record

- Steps 1–3: completed in the current branch. `AGENTS.md` now names the
  ownership rules; continuation is projected by
  `desktop/runtime/run-continuity.cjs`; Task composer controls expose only
  Send and Stop. Sending records the durable input and automatically continues
  the same Run when a Conductor Host must be reattached or replaced.
- Step 4: completed for the initial allocation and renderer event path.
  `workbenchLayout.ts` uses `auto` until a person moves, splits, or resizes,
  then preserves `manual`; the terminal component restores
  focus/pointer/selection behavior and explains raw-history access. A live
  OpenCode alternate-screen scroll/selection regression harness is still
  required before calling the terminal interaction acceptance criterion
  complete.
- Step 5: completed for the scoped state machine:
  `cancellation_requested` → terminal fact → `cancelled`, with `cancel_failed`
  for an interrupt transport failure. It never selects replacement work or
  marks the Task complete.
- Step 6: recorded in
  `../../../spec/browser-terminal-host-architecture.md`. The accepted direction is a
  browser renderer plus authenticated local/remote Terminal Host; no Electron
  removal is scheduled.
- Permission interaction and terminal theme parity: completed for the typed
  OpenCode hook path. `permission.asked` / `permission.replied` are durable
  Session facts; the Task page submits only `once` / `always` / `reject`, and
  Runtime waits for Provider confirmation. The loopback reply capability is
  retained only in Main memory, never in the read model. Live xterm theme
  changes now preserve the existing attachment and scrollback.

Verified during this implementation:

```text
npx vitest run desktop/session-store.test.mjs desktop/session-wakeup-monitor.test.mjs desktop/conductor-tool-bridge.test.mjs desktop/conductor-mcp-server.test.mjs desktop/runtime/dispatch-coordinator.test.mjs desktop/runtime/agent-loop-v1-runtime.test.mjs desktop/runtime/terminal-runtime-core.test.mjs src/agent-loop/workbenchLayout.test.ts src/agent-loop/runPresentation.test.ts src/agent-loop/AgentLoopApp.timeline.test.ts
npm run build
npm run desktop:agent-loop-ui-smoke
```

Additional focused verification for the permission/theme change:

```text
npx vitest run desktop/runtime/opencode-hook-service.test.mjs desktop/session-store.test.mjs desktop/session-wakeup-monitor.test.mjs desktop/runtime/agent-loop-v1-runtime.test.mjs src/agent-loop/AgentLoopApp.timeline.test.ts src/runtime/nativeBridge.test.ts
npm run build
```

# Task Runtime Status, Timeline, And Fullscreen Layout Bugs

Date: 2026-07-06
Status: Root cause located; runtime status/timeline/layout fix batches applied; broader audit follow-ups remain open.
Scope: Task Home, IDE Workbench, desktop runtime Session Store, native PTY state bridge, adjacent runtime audit findings.

## Summary

Three visible issues share one product boundary problem: live PTY state, provider semantic state, task runtime events, and review completion are not cleanly synchronized into the UI.

1. Agent and task status can remain `running` / `working` after the Conductor terminal has printed a task-close summary.
2. Task Home does not use the full fullscreen height; the execution timeline is capped and leaves a large blank area below.
3. Worker results appear in the timeline, but the Conductor's final task summary does not, because it is not recorded as a task runtime event.

Important boundary: a Conductor or worker saying "done" must remain a claim until runtime checks and Review gate evidence accept it. The fix should record and render the claim, not bypass the Review gate.

## Fixes Applied On 2026-07-06

Visible bug fix batch:

- Added durable runtime event support for `conductor.message` and `task.completion_claim`, rendered both in Task Home's execution timeline, and wired the session wakeup monitor to persist completed Conductor provider output as `conductor.message`.
- Added Session Store support for pre-dispatch `dispatch.failed` route-validation failures, and wired the Conductor tool bridge to persist those failures.
- Prevented live native PTY evidence from regressing `pending-review` or `done` tasks back to `running`.
- Added a Review approval lifecycle guard: verification can still be the first block, but a verified task must be `pending-review` before approval can move it to `done`.
- Reset task agents to `idle` when Review approval completes a task.
- Removed the fullscreen timeline height cap by replacing the `min(56vh, 560px)` feed row with a stretchable `minmax(0, 1fr)` height chain.
- Added an explicit empty state for the Teams page when runtime team workflows are unavailable.

Adjacent runtime hardening batch:

- Added bounded in-memory transcript retention in the desktop PTY manager while preserving monotonic read cursors.
- Added stopped-session eviction in the desktop PTY manager with an explicit cleanup path.
- Added renderer cleanup for per-session native PTY refs and sets when a native PTY session exits.
- Recorded explicit Task Home Conductor composer messages as `user.intervention` timeline evidence while keeping raw IDE terminal transport out of semantic timeline events.
- Bounded Session Store view reads for append-only JSONL files with tail reads, while keeping mutation paths that need complete dispatch/task state on full reads.

Follow-up regression fixes applied on 2026-07-07:

- Prevented xterm raw control sequences from being recorded as `user.intervention` events. The IDE Workbench terminal `onData` stream is raw transport, not a semantic human-message boundary.
- Filtered already-persisted historical `ide-terminal` raw intervention events out of Task Home's timeline projection.
- Kept the Stop button effective when a PTY session is already `stopping`: a second stop request escalates from `SIGTERM` to `SIGKILL` instead of becoming a no-op.
- Added a single Agent Runtime State contract in Session Store. Dispatch lifecycle, provider inspection, and PTY lifecycle facts now reduce to one state value such as `ready`, `delivered_pending`, `result_available`, `waiting_input`, `permission_required`, `blocked`, or `exited`.
- Changed `call_session` deliverability to read Session Store runtime state instead of terminal transcript prompt regexes. A worker with `result_available` can receive a follow-up dispatch without needing prompt text such as `ctrl+p commands`.
- Changed Task Home and IDE Workbench Agent cards/progress counts to project from `read_task_state().sessions[].state`. Legacy `agent.status` remains only as a compatibility fallback when runtime state is unavailable.

Follow-up delivery correctness fixes applied on 2026-07-08:

- Fixed a false-delivery path where `call_session` wrote to a just-started opencode PTY and immediately recorded `dispatch.delivered` / `delivered_pending` before the provider actually accepted the assignment.
- `call_session` now waits for the target opencode terminal to reach an input-ready prompt before writing, writes the assignment once, and records `dispatch.delivered` only after the opencode provider adapter confirms the exact dispatch marker in the provider session database.
- Delivery timeout now leaves an auditable `dispatch.failed` / `delivery_failed` record instead of a misleading delivered state when the provider never records the dispatch marker.
- Runtime state pills now keep raw enum values for CSS/state identity but render user-facing labels such as `Delivered` and `Result available` instead of raw strings like `delivered_pending`.

Still open / intentionally not changed in these batches:

- Durable JSONL compaction/retention policy beyond bounded view reads.
- Advanced surface scope gating for Teams/Browser/MCP/Notifications/Restore. Current specs and tests keep these surfaces reachable from More as advanced entries; this batch fixes the Teams empty-state crash but does not hide or remove designed entrypoints.

## Observed User Impact

- IDE Workbench can show `5 active` / `5 运行` while the Conductor terminal says both branches passed and the task is closing.
- Task Home can show the task pill as `running` and the selected Conductor as `working` even after the visible terminal output looks complete.
- In fullscreen, the Task Home timeline scrolls inside a short panel and the lower page area is mostly empty.
- The execution timeline stops at the last worker result plus a runtime wakeup. The Conductor's final "task complete / task closed" synthesis remains visible only in the terminal-backed IDE surface.

## Issue 1: Status Stays Running After Logical Completion

### Root Cause

Native PTY lifecycle is currently used as the active Agent card status signal. Long-running interactive provider sessions can remain alive after a logical task turn is complete, so the UI keeps reporting `working`.

Code evidence:

- `src/lib/taskMachine.ts:1457` `attachNativeSessionEvidence()` attaches native session evidence to task/run state.
- `src/lib/taskMachine.ts:1494` sets the task status from `nativeSessionRunState()`.
- `src/lib/taskMachine.ts:1495` updates the matching agent status.
- `src/lib/taskMachine.ts:1520` `nativeSessionAgentStatus()` maps `session.status === "running"` to `working`.
- `src/lib/taskMachine.ts:1529` `nativeSessionRunState()` maps any non-stopped native session to task/run `running`.
- `src/pages/Workbench.tsx:144` counts `agent.status === "working"` as the running count shown in the rail.
- `src/App.tsx:309` stores `readNativeTaskState()` output in `nativeTaskStatesByRuntimeTaskId`, but this does not dispatch a semantic status transition into the reducer.

There is also an existing test that locks in the current raw PTY lifecycle behavior:

- `src/lib/taskMachine.test.ts:229` "uses raw PTY lifecycle instead of terminal-derived sampled state for agent status".

### Why This Is A Product Bug

The current implementation conflicts with the provider-state direction already documented in:

- `docs/superworks/spec/provider-session-state-detection.md:15`: PTY output is a transport trigger, not a state oracle.
- `docs/superworks/spec/provider-session-state-detection.md:158`: provider state should map to workspace state.
- `docs/superworks/spec/provider-session-state-detection.md:169`: `completed_with_answer` should write task-level messages/results and wake Conductor.
- `docs/superworks/spec/conductor-session-communication.md:500`: model "done" claims are not enough to move a task to Done.

### Supplementary Problem

`readTaskState()` already returns session records from Session Store:

- `desktop/session-store.cjs:228` reads task state.
- `desktop/session-store.cjs:254` emits each session's `state`.

However, Task Home and Workbench still primarily display `Task.status`, `Agent.status`, and `NativePtySession.status`. The backend runtime state is used for the execution feed, but not as the authoritative status model for Agent cards.

### Review Approval Lifecycle Gap

Review approval does check verification and redaction gates, but it does not check that the task is actually in the lifecycle state that should be approvable.

Code evidence:

- `src/lib/taskMachine.ts:1716` starts `approveReview()`.
- `src/lib/taskMachine.ts:1726` blocks only through `reviewApprovalBlockReason()`.
- `src/lib/taskMachine.ts:1759` `reviewApprovalBlockReason()` checks verification status and required redaction scan.
- `src/lib/taskMachine.ts:1738` sets the task to `done` after those checks pass.
- `src/pages/Review.tsx:73` computes `approvalReady` from selected run verification/redaction state, not from `selectedTask.status`.
- `src/pages/Review.tsx:319` enables the Approve review button from `approvalReady`.

This means a task with passed run verification can be approved to `done` even if it did not first enter a review-ready task lifecycle state. This is a narrower issue than "approveReview is unconditional"; the missing guard is the task lifecycle / review-readiness guard.

## Issue 2: Fullscreen Timeline Does Not Fill Available Height

### Root Cause

The Task Home layout breaks the height chain and hard-caps the execution feed height.

Code evidence:

- `src/pages/TaskBoard.tsx:291` renders populated Task Home with `task-home-layout task-home-layout-empty`.
- `src/styles.css:506` `.workspace` has padding and horizontal overflow rules, but no height propagation.
- `src/styles.css:1769` `.task-home-layout` uses `align-items: start` and has no viewport-height contract.
- `src/styles.css:1861` `.task-home-main` is a grid with no height.
- `src/styles.css:2295` `.task-execution-grid` has columns but no height.
- `src/styles.css:2313` `.execution-panel` sets `grid-template-rows: auto minmax(320px, min(56vh, 560px)) auto`.
- `src/styles.css:2337` `.execution-feed` scrolls inside that capped row.

The direct culprit is the `min(56vh, 560px)` cap. On a large fullscreen window, the timeline row still maxes at about 560px, so the rest of the page stays empty.

### Supplementary Problem

The populated Task Home using `task-home-layout-empty` is not itself fatal, because that class switches the layout to one column. But the name hides the fact that both empty and populated states share the same top-level layout path, which makes fullscreen layout regressions easier to miss.

## Issue 3: Conductor Final Result Is Missing From Timeline

### Root Cause

The final Conductor synthesis is not persisted as a task runtime event. The timeline can only render events that exist in Session Store and match its known type list.

Code evidence:

- `src/pages/TaskBoard.tsx:1150` builds the timeline from `taskRuntimeState.events`.
- `src/pages/TaskBoard.tsx:1173` starts the event projection loop.
- `src/pages/TaskBoard.tsx:1174` renders only `task.user_message` and `user.intervention` as user events.
- `src/pages/TaskBoard.tsx:1179` renders `dispatch.created`.
- `src/pages/TaskBoard.tsx:1198` renders `dispatch.result_available`.
- `src/pages/TaskBoard.tsx:1215` renders `dispatch.failed`.
- `src/pages/TaskBoard.tsx:1234` renders `conductor.wakeup.sent` and `conductor.wakeup.queued`.
- Unknown event types are silently ignored because the loop only pushes cards inside those branches.

Backend evidence:

- `desktop/session-store.cjs:163` writes worker `results.jsonl` when a dispatch result becomes available.
- `desktop/session-store.cjs:164` writes task-level `messages.jsonl` when a dispatch result becomes available.
- `desktop/session-store.cjs:184` `recordConductorWakeup()` records only wakeup events.
- `desktop/main.cjs:256` `native:append-task-event` allows only `task.user_message` and `user.intervention`.
- `desktop/session-store.cjs:290` can record generic task events internally, but the IPC boundary prevents Conductor completion/message events from being appended through the current UI bridge.

### What Is Actually Displayed

Worker results are displayed. The screenshot showing `#29 实现结果 result message` is consistent with `dispatch.result_available` rendering. The missing piece is not the worker result; it is the Conductor's final "both branches passed / task closing" synthesis.

### Supplementary Problem

The spec already expects the Task page to include Conductor normal output:

- `docs/superworks/spec/product-interaction-map.md:272` lists "Conductor's normal output message" as a timeline card type.
- `docs/superworks/spec/product-interaction-map.md:278` lists the current event source types, but the implementation has not added a durable Conductor output event type yet.

Current tests also only cover the existing narrow projection:

- `src/pages/TaskBoard.test.tsx:184` verifies backend runtime state rendering.
- `src/pages/TaskBoard.test.tsx:225` covers `dispatch.result_available`.

There is no test proving that Conductor normal output, completion claims, or review/QA events appear in the timeline.

## Additional Related Gap: IDE Terminal Input Is Raw Transport, Not Timeline Evidence

Status: fixed by narrowing the evidence boundary.

The Task Home composer records explicit user interventions:

- `src/App.tsx:719` writes to the selected task Conductor PTY.
- `src/App.tsx:725` records a `user.intervention` event.

The generic IDE Workbench raw PTY input path must not record task runtime events directly:

- `src/App.tsx:712` writes raw data to the selected native PTY session.
- `src/App.tsx:715` stores the returned session metadata with `attach: false`.
- `src/components/PtyTerminal.tsx:121` receives xterm `onData`, which includes both keyboard input and terminal control responses.

Raw xterm data can include OSC color responses, cursor-position reports, mouse tracking, and mode reports such as `ESC]10;rgb...`, `ESC[25;6R`, and `ESC[?2027;0$y`. Persisting this stream as `user.intervention` polluted Task Home with transport bytes. The correct current boundary is: Task Home composer messages are semantic timeline evidence; Workbench terminal bytes remain PTY transport.

## Adjacent High-Priority Bug: Route Validation Failure Is Not Persisted

### Root Cause

`call_session` route validation can fail before a dispatch is recorded. The bridge tries to record that failure through a method that does not exist on the real Session Store, so the failure is returned to the caller but not written to runtime events.

Code evidence:

- `desktop/conductor-tool-bridge.cjs:16` validates `{ taskId, toSessionId }`.
- `desktop/conductor-tool-bridge.cjs:18` calls `sessionStore.recordDispatchFailure?.(...)` when validation fails.
- `desktop/session-store.cjs:95` implements `markDispatchFailed()`, but this requires an existing dispatch.
- `desktop/session-store.cjs:390` exports Session Store methods; `recordDispatchFailure` is not exported.
- `desktop/conductor-tool-bridge.test.mjs:411` covers allowlist rejection with a stubbed `recordDispatchFailure()`, which hides the missing real-store method.
- `docs/superworks/spec/development-instrumentation.md:247` lists `dispatch.failed` as the shell-owned event for route validation or worker start failure.

### Impact

Invalid Conductor target routing can be invisible in the runtime event stream. Task Home cannot show a failed call card because no `dispatch.failed` event exists for this pre-dispatch failure path.

### Fix Boundary

Add a real Session Store path for pre-dispatch route failures, or change validation failure to create a failed dispatch record. The event should still use a shell-owned `dispatch.failed`-class record, but it must be able to represent `dispatchId` absent or minted for a rejected route.

## Broader Audit Findings

### P1: Native PTY Manager Keeps Full Session And Transcript State In Memory

Status: fixed for in-memory transcript growth and stopped-session cleanup.

`desktop/pty-manager.cjs` stores all PTY sessions and all transcript chunks in process memory:

- `desktop/pty-manager.cjs:5` keeps `sessions` in a `Map`.
- `desktop/pty-manager.cjs:26` creates a per-session `transcript` array.
- `desktop/pty-manager.cjs:71` stores every session in the map.
- `desktop/pty-manager.cjs:81` lists all retained sessions.
- `desktop/pty-manager.cjs:247` returns transcript arrays from retained session state.
- `desktop/pty-manager.cjs:269` appends every output chunk to the transcript.

The fix adds a retained-transcript chunk cap, cursor normalization over the retained tail, and timed eviction of stopped sessions. Transcript evidence is still live process state; durable audit policy remains owned by Session Store.

### P1: Renderer PTY Session Refs Keep Per-Session State Without Per-Session Cleanup

Status: fixed for stopped-session cleanup.

The renderer caps individual transcript and readiness buffers, but several session-id keyed refs and sets are not cleaned up when a session stops:

- `src/app/ptySessionUtils.ts:3` caps rendered transcript chunks at `2_000`.
- `src/app/ptySessionUtils.ts:4` caps each PTY readiness buffer at `12_000` characters.
- `src/App.tsx:128` stores readiness buffers by native session id.
- `src/App.tsx:134` stores flushed initial-input session ids.
- `src/App.tsx:135` stores output-after-initial-input session ids.
- `src/App.tsx:298` appends transcript content to the readiness buffer for a session id.
- `src/App.tsx:432` adds session ids to `outputAfterInitialPtyInputIdsRef`.
- `src/App.tsx:248` resets several refs only when opening another runtime project.

The issue is not an unbounded string per session; it is accumulation of session-id keyed renderer state across stopped or replaced sessions. The fix centralizes per-session cleanup in `cleanupNativePtySessionTracking()` and invokes it after native PTY exit evidence is attached.

### P1: Session Store JSONL Files Are Read And Rewritten Without Retention Limits

Status: partially fixed. View reads are bounded; durable compaction is still open.

Runtime JSONL files are append-only for events/results/messages, and several operations read or rewrite whole files:

- `desktop/session-store.cjs:336` appends every session event to session `events.jsonl`.
- `desktop/session-store.cjs:337` also appends every session event to task `events.jsonl`.
- `desktop/session-store.cjs:512` appends JSONL records without a size cap.
- `desktop/session-store.cjs:530` reads whole JSONL files into memory.
- `desktop/session-store.cjs:532` reads the entire file content before splitting lines.
- `desktop/session-store.cjs:517` rewrites full JSONL files for dispatch updates.

The fix bounds UI/view reads for event/message/result/permission/artifact streams to a tail window. Mutation paths that update dispatches or compute task cursors still read the full relevant JSONL files because they need complete state. A real compaction/retention policy remains a future storage task.

### P1: Runtime Teams Page Crashes With The Real Empty Runtime State

Status: fixed.

The real app initializes runtime Teams data as empty arrays:

- `src/App.tsx:111` sets `runtimeTeamWorkflows` to `[]`.
- `src/runtime/opencode/workspaceState.ts:67` initializes `selectedTeamWorkflowId` to `""`.
- `src/App.tsx:1056` passes `runtimeTeamWorkflows` into `<Teams />`.
- `src/pages/Teams.tsx:20` falls back to `workflows[0]`.
- `src/pages/Teams.tsx:21` immediately reads `selected.nodes`.

With `workflows.length === 0`, entering the Teams route could throw before rendering an empty state. The fix renders an explicit advanced-capability disabled state when no runtime team workflows are available.

### P2: Advanced Teams/Browser Surfaces Are Reachable Despite Empty Runtime Capability Data

Status: open by product decision, not changed in these fix batches.

Product direction says Browser Automation and full Teams should not be promoted into current scope:

- `docs/research/similar-agent-workbench-products-2026-06-29.zh.md:602` warns not to advance browser automation or full Teams too early.
- `docs/superworks/spec/product-interaction-map.md:703` marks Teams, Browser, MCP Gateway, Notifications, and Restore as visible but advanced.

The shell makes these surfaces reachable from More:

- `src/app/shellConfig.ts:114` exposes Browser Automation.
- `src/app/shellConfig.ts:127` exposes Agent Teams.
- `src/App.tsx:1073` routes to Browser Automation.
- `src/App.tsx:1054` routes to Teams.

At the same time, real runtime capability arrays are empty:

- `src/App.tsx:109` sets `runtimeBrowserTools` to `[]`.
- `src/App.tsx:111` sets `runtimeTeamWorkflows` to `[]`.
- `src/lib/taskMachine.ts:60` and `src/lib/taskMachine.ts:61` also keep reducer-local `teamWorkflows` and `browserTools` empty.

This creates a product mismatch: advanced surfaces are visible and clickable, but runtime data is absent or inert. Current product-interaction specs also say advanced surfaces should stay visible from More, and App tests assert that behavior. The fix batch therefore corrected the real crash path and left broader gating/copy decisions for a product-scope change.

### P2: Initial PTY Input And Exit Attribution Have Async Edge Cases

Status: partially open.

Two async paths can lose or misattribute runtime context:

- `src/App.tsx:351` queues the first PTY input for a session.
- `src/App.tsx:365` removes the queued input before the async write starts.
- `src/App.tsx:369` writes the formatted input to the native PTY.
- `src/App.tsx:373` catches write failure and records runtime start failure, but it does not restore the pending input for retry.
- `src/App.tsx:448` attaches stopped native session evidence after an async snapshot read.
- `src/App.tsx:451` falls back to `selectedTask?.id` when `resolveNativeSessionRef(event.id)` cannot map the session id.

The first path can drop the initial task prompt if the write fails after queue removal. The second path can attach exit evidence to whichever task is selected at callback time when session resolution fails.

These edge cases were not changed in the current batches. The related renderer cleanup and IDE input timeline evidence issues were fixed separately.

### P2: Duplicate `safeSegment` Helpers Can Diverge

There are multiple local segment sanitizers with different behavior:

- `src/runtime/opencode/sessionKey.ts:12` encodes unsafe characters as `~hex~` and maps all-whitespace input to `empty`.
- `src/runtime/adapters/conductorRuntime.ts:35` replaces unsafe characters with `-`.
- `desktop/session-store.cjs:579` replaces unsafe characters with `-` and defaults falsy input to `unknown`.

This is not currently a path traversal finding by itself, but it is a real consistency risk for runtime IDs, task paths, and provider session keys.

### P3 / Not Confirmed: Runtime File Path Traversal Is Guarded

The runtime file writer already rejects absolute paths and ensures resolved runtime file paths stay under the project directory:

- `desktop/pty-manager.cjs:200` writes runtime files.
- `desktop/pty-manager.cjs:204` rejects empty or absolute relative paths.
- `desktop/pty-manager.cjs:208` resolves the target path under `cwd`.
- `desktop/pty-manager.cjs:210` rejects paths that escape `projectRoot`.

So this specific path should not be documented as an active traversal bug. The remaining trust-boundary question is broader: `src/App.tsx:96` reads URL search params, `src/App.tsx:97` accepts `projectPath` from that URL state, and `desktop/main.cjs:28` derives the runtime Session Store root from the selected `cwd`. That is expected for a local desktop app, but it needs an explicit project-root trust model before exposing untrusted links or remote-controlled navigation.

This runtime-file guard is separate from Session Store event writes. Session Store paths rely on the selected `cwd` as the trusted runtime root and on `safeSegment()` for task/session ids:

- `desktop/main.cjs:28` creates the runtime Session Store rooted at the selected `cwd`.
- `desktop/session-store.cjs:290` records task events using the provided task id and cwd.
- `desktop/session-store.cjs:351` creates session directories with sanitized task and session ids.
- `desktop/session-store.cjs:579` sanitizes path segments with `safeSegment()`.

So the active question for Session Store is not relative-path traversal through `runtimeFiles`; it is whether the chosen project `cwd` is trusted and explicit enough.

### P3: Duplicate Helpers Increase Drift Risk

The audit also found confirmed duplication beyond `safeSegment`. This note does not fully audit all duplicate helper semantics, but at least one repeated helper is byte-for-byte product logic:

- `src/pages/TaskBoard.tsx:1533` defines `agentBelongsToTask()`.
- `src/lib/taskMachine.ts:1919` defines another `agentBelongsToTask()`.
- `src/pages/Workbench.tsx:477` defines a third `agentBelongsToTask()`.
- `src/pages/Runs.tsx:383` and `src/pages/Review.tsx:333` duplicate native-session command formatting.
- `src/pages/Runs.tsx:387` and `src/pages/Review.tsx:337` duplicate native-session exit formatting.
- `src/App.tsx:1357` defines a local `getOpencodeTaskTemplate()` wrapper despite importing runtime template data.

This is lower priority than the runtime-state bugs above, but status ownership and task/session scoping are already fragile enough that repeated helper logic should be consolidated during nearby fixes.

## Recommended Fix Boundaries

### Status

- Do not parse terminal text for "done".
- Do not mark task `done` from a Conductor text claim alone.
- Add a provider/runtime-derived state sync path from `read_task_state` into UI status projection.
- Require Review approval to prove both passed evidence and a review-ready task lifecycle state.
- Represent provider completion separately from Review-approved Done, for example:
  - worker `completed_with_answer` -> worker/session not active, dispatch result available;
  - Conductor completion claim -> task awaiting verification/review or ready for user Goal/Review action;
  - Review approval -> task `done`.

### Timeline

- Add durable event types for Conductor-visible messages, such as `conductor.message` and `task.completion_claim`.
- Allow those event types through the Electron IPC boundary.
- Render those event types in `createRuntimeExecutionEvents()`.
- Persist route-validation failures so rejected `call_session` attempts become timeline/audit evidence.
- Preserve unknown event visibility in development, for example by rendering a compact "runtime event" card or logging a diagnostic, instead of silently dropping new event types.
- Add tests for Conductor normal output, completion claim rendering, and unknown-event behavior.

### Fullscreen Layout

- Give Task Home a real height contract from `.workspace` down to `.execution-panel`.
- Replace the feed row cap with a fill-available track, such as `minmax(0, 1fr)`, while keeping a reasonable `min-height`.
- Ensure the composer remains visible and the feed scrolls internally.
- Add a CSS/layout regression test or visual check for large desktop viewport height.

## Verification Checklist For A Future Fix

- Start a task with multiple worker dispatches.
- Confirm worker result cards appear in Task Home.
- Let Conductor produce a final task synthesis.
- Confirm the final Conductor synthesis appears as a timeline card.
- Confirm worker agents no longer count as active after provider state is complete.
- Confirm task does not become Review-approved Done until the Review path accepts it.
- Confirm fullscreen Task Home uses available vertical space without clipping the composer.
- Confirm Task Home composer interventions and IDE terminal interventions have intentional, documented event behavior.
- Trigger an invalid `call_session` target and confirm the rejection is persisted as runtime evidence.
- Open Teams with empty runtime workflow data and confirm it renders an explicit empty/disabled state instead of throwing.
- Run a long-output PTY session and confirm transcript/session retention is bounded or intentionally persisted outside the main-process heap.
- Stop or replace PTY sessions and confirm renderer-side session-id refs/sets are cleaned up.
- Try Review approval against a verified but non-review-ready task and confirm it does not move to `done`.

## Verification Commands Run

Local targeted checks during implementation:

- `npm test -- --run desktop/pty-manager.test.mjs`
- `npm test -- --run src/app/nativePtyTimeline.test.ts`
- `npm test -- --run src/app/ptySessionUtils.test.ts src/app/nativePtyTimeline.test.ts`
- `npm test -- --run src/App.test.tsx`
- `npm test -- --run desktop/session-store.test.mjs`

Full verification should be rerun after any later edit:

- `npm test -- --run`
- `npm run build`
- `npm run desktop:layout-smoke`
- `git diff --check`

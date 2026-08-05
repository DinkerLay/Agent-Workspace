# Agent Loop Continuity Regression Remediation v1

Date: 2026-07-29
Status: real Provider continuation and Publisher-TUI acceptance verified;
desktop wheel/selection remains a manual acceptance check

## Purpose

This plan corrects four user-reported interaction failures observed in a real
Electron/OpenCode Task Run. It is a remediation plan, not a new orchestration
workflow. The Conductor still chooses whether and where to dispatch; Runtime
only preserves identity, records facts, delivers inputs, and reconciles
cancellation.

Authoritative inputs:

- `../spec/task-run-continuity-and-terminal-experience.md`
- `../spec/code-ownership-and-layer-map.md`
- `../spec/orca-terminal-runtime-adoption.md`
- `../spec/agent-loop-v1.md`

## User-reported failures and current truth

| ID | User-visible failure | Current assessment | Completion state |
| --- | --- | --- | --- |
| C1 | A Task-page composer draft disappears after switching away and back. | Draft remains Task-owned above the unmounted composer; the Electron smoke now navigates Tasks → Templates → Tasks before Send. | automated Electron acceptance passed; manual check remains |
| C2 | After a Conductor cancels a Publisher dispatch, the same logical Publisher Session cannot later be awakened. | The Coordinator settles durable cancellation facts before dispatch validation and before Send resumes/feeds a Conductor. Matching cancellation releases the card; terminal absence does not. | persistent restart harness passed; manual desktop cancellation check remains |
| C3 | Timeline/Task state says `restart_or_recover` / `PTY process exited`, which neither explains the cause nor permits the expected continuation. | A matched terminal exit is settled before the recovered Conductor reads state, so it receives `cancelled`, not a stale occupied Publisher. | persistent restart harness passed; manual Timeline check remains |
| C4 | The Workbench terminal cannot be scrolled with the mouse/trackpad. | The normal buffer uses xterm scrollback. In OpenCode's alternate buffer, the renderer captures the wheel and submits native cursor-navigation input to the live PTY; Electron smoke proves both cancellation of page scroll and receipt in the PTY. | automated Electron terminal acceptance passed; manual selection/copy check remains |
| C5 | After Send restores a Conductor, the Task shows an old response and no new Provider turn. | Every Session now remains in the interactive OpenCode TUI. A fresh Session uses `--prompt`; a proven Provider resume uses `--session <id>` without `--prompt`, waits for the recovered TUI to settle, then submits one bracketed paste and one Return. The message remains pending until the exact Provider input receipt, and Timeline observation stays bound to the original Provider Session rather than the new PTY start time. | real OpenCode E2E passed for both recovered Conductor Send and Publisher delivery TUI; manual verification against the persisted desktop Task after reload remains |
| C6 | After restart, a saved Publisher permission response opens a recovered terminal, then a stale old dispatch cancellation interrupts/closes it. | The terminal owner history was overwritten by the new PTY, while cancellation used the current logical Session PTY instead of the dispatch's original accepted-input incarnation. | implementation and fault-injection E2E required |
| C7 | A native OpenCode question is hidden from the Task page or normal Task messages are confused with the answer. | `waiting_input` was filtered from Timeline but had no dedicated inspector surface; the input arbiter also omitted the distinct `task_question_answer` source. | fixed with a one-shot inspector card, exact Session/question-id write, terminal-input source test, Electron Task E2E; real Provider attention harness remains required in regression |

The previous plan's generic status of “core implementation complete” was false
when these bugs were reported. The present implementation is covered by focused
tests and the Electron harness, but that remains distinct from a real Provider
run with the user's task data and a manual terminal selection/copy check.

## Observed C2/C3 incident

The persisted Task `loop-573c622e` provides the reproduction record:

1. Publisher Dispatch `F7694F` was accepted by Terminal Runtime.
2. The Conductor requested `cancel_dispatch(F7694F, ...)`.
3. The Publisher PTY emitted a durable `session.exited` fact.
4. The dispatch remained `cancellation_requested`, instead of becoming
   `cancelled`.
5. A later Publisher dispatch was rejected as
   `loop_session_has_outstanding_dispatch`.
6. After Electron restarted, the Monitor recreated only the Conductor; the
   Publisher was absent from the in-memory PTY list and was never reconciled.

The later persisted record proves the missing step precisely:

```text
Publisher dispatch F7694F
  terminal incarnation: 2022faf1-0c64-4fc4-80ba-13fc8a7099e6
  terminal generation:  fc4b2189-7819-40dc-bf27-1e044b4ba80f
  Terminal Owner:       stopped (2026-07-29T09:27:13.260Z)
  dispatch state:       cancellation_requested
```

The first remediation only reconciled immediately before a later
`call_session`. A normal Send first restored the Conductor, which then read the
still-stale `cancellation_requested` state and repeated an already-resolved
question. This is the user-visible loop in the 19:33/19:34 desktop captures.
It was not a lost Provider conversation and not an unavailable Publisher
identity; it was a missing Task-continuation reconciliation boundary.

The prior Publisher Provider Session remains provable:

```text
logical Publisher Session: opencode:agent-test:loop-573c622e:publisher
Provider Session:          ses_052e92d4dffeG1mQNdqF3Er9So
```

The recovered Conductor must use its original Provider Session through the
interactive TUI:

```text
opencode --agent agent_workspace_conductor --session ses_052f17781ffeoPaV1UhaCIS2s5
```

So the failure is not “all history was lost.” It is that Publisher never
reached a legal re-dispatch. Once it does, its replacement PTY must continue
the Provider Session above, not start with `--model`.

## Required invariants

1. **A cancellation concerns one Dispatch, never the logical Session.** A
   confirmed cancellation releases the card for a later Conductor decision.
   It does not automatically re-dispatch, complete the Task, or choose a new
   Agent Card.
2. **Terminal absence is not enough by itself.** Cancellation may become
   `cancelled` only from a matching durable Terminal Runtime exit/stopped fact
   for the relevant incarnation, or from a Provider interruption fact. An
   empty post-restart PTY map is evidence of nothing on its own.
3. **Provider binding is durable and separate from the last UI state.** The
   Provider Adapter records `{ provider, providerSessionId }` for each logical
   Session when it observes a receipt/result/attention/message. A later
   `session.exited` state update must not erase that binding.
4. **A replacement physical worker continues the same Provider conversation
   when it is provable.** A re-dispatch after C2 starts a new terminal
   incarnation with `opencode --session <providerSessionId>`. If no exact
   binding exists, Runtime may start a new
   Provider Session, but must record that it did so; it must never claim a
   resume.
5. **Send remains the only user continuation action.** Recovery/reconciliation
   happens behind Send and Runtime events. The Task header receives no
   recover/restart button.
6. **The terminal viewport is a terminal, not a decorative transcript.** In a
   normal xterm buffer, a wheel scrolls only its own xterm scrollback; in an
   alternate OpenCode TUI buffer, the wheel reaches the TUI. No invisible
   overlay may consume either interaction.

## Ownership and durable writers

| Concern | Decision/writer | Read by | Explicitly not owned by |
| --- | --- | --- | --- |
| Draft text while navigating within the renderer | `AgentLoopApp` renderer state | Task composer | IPC/Runtime/terminal |
| Cancellation request, confirmation and card occupancy | Dispatch Coordinator + Session Store | Conductor, Task/Timeline | Renderer, Conductor terminal text |
| PTY incarnation, exit/stopped proof | Terminal Runtime / Session Authority | Coordinator | Provider/renderer |
| Provider Session binding | OpenCode Provider Adapter records observed fact in Session Store | Runtime launch-profile builder | Renderer/Conductor |
| Replacement terminal launch | Task/Run service delegates to Session Authority | UI diagnostics | Renderer/Coordinator routing choice |
| Timeline wording | durable Task/Session facts projected by `runPresentation` | Task page | raw terminal parser |
| Wheel/selection attachment | `PtyTerminal` plus terminal stream attachment | Workbench | Task lifecycle code |
| Terminal incarnation history and exact cancellation target | `Session Authority` | Dispatch Coordinator | Renderer, Conductor, Provider Adapter |
| Provider-native question card/answer | Provider observer records question; Task/Run validates and submits exact answer | Task inspector, Timeline | normal composer, Conductor workflow, raw terminal text |

### Step 2A — make replacement terminal ownership incarnation-safe

- Preserve a durable `Session Authority` record for every terminal incarnation,
  keyed by logical Session ID + incarnation ID + generation. The current-owner
  row remains the source for live PTY attachment; historical rows are used only
  for exact reconciliation.
- Change `cancel_dispatch` to capture the dispatch's
  `terminalIncarnationId`/`terminalGeneration` from the accepted-input receipt.
  It may interrupt only a live PTY with the same pair. It must never derive an
  old cancellation target from `ptyManager.get(logicalSessionId)`.
- When an Electron restart recovers a permission-pending Session, mark the
  former Main-process-only owner stopped before creating the replacement
  incarnation. A stale cancellation then settles against the former history
  record and leaves the recovered TUI untouched.
- While a Session has an unresolved permission record, reject any new Conductor
  dispatch to that Session. This prevents a new assignment from being pasted
  into a user-owned permission prompt.
- Verify with `npm run desktop:agent-loop-permission-recovery-race-e2e`:

  ```text
  dispatch accepted on Publisher PTY A
  -> persisted permission answer + Electron restart
  -> cancellation is injected either before B starts or after B is live
  -> same Provider Session starts on Publisher PTY B
  -> assert A is settled from historical owner fact
  -> assert B received no Ctrl-C and remains live
  -> assert the permission card is consumed and re-dispatch is blocked
  -> provider receipt releases B for a later dispatch
  ```

- Completion: the Task-page authorization recovery has one physical terminal
  owner at a time; no historical control action can signal a newer
  incarnation.

## Remediation steps

### Step 1 — make C1 a proven renderer behavior

- Keep drafts keyed by Task ID above the unmounted Task composer.
- Clear only the submitted draft after the Runtime accepts that exact message;
  do not clear a newer edit made while a send is in flight.
- Verify: unit unmount/remount test and Electron navigation from Tasks →
  Templates/Workbench → the same Task.
- Completion: textarea preserves its unsent text exactly; a successful Send
  clears only that submitted text.

### Step 2 — reconcile persisted cancellation before a re-dispatch

- Add a read-only Terminal Runtime query for the durable owner/exit fact,
  including workspace Session ID, incarnation ID, generation and stopped time.
- Add one Coordinator reconciliation operation that evaluates each durable
  `cancellation_requested` dispatch against that fact (or a Provider
  interruption fact) and records either `cancelled` or leaves it pending.
- Invoke it immediately before dispatch validation **and** before Send either
  writes to a live Conductor or restores a dead Conductor. The latter is the
  required ordering: a recovered Conductor must never read stale occupancy and
  ask the user to resolve an already-confirmed cancellation.
- Do not mark cancellation confirmed merely because `ptyManager.list()` lacks
  the Session.
- Verify: a fixture with requested cancellation + persisted matching terminal
  exit + empty new PTY manager becomes `cancelled`; a fixture without an exit
  remains `cancellation_requested`. The persistent restart harness must issue
  one Task Send before any worker re-dispatch and prove the old dispatch is
  settled before the replacement Conductor launch.
- Completion: the continued Conductor sees a released card before its first
  `read_task_state`; a later `call_session` is no longer rejected by an
  already-confirmed cancelled Dispatch.

### Step 3 — make Provider continuation explicit and reliable

- Introduce/read a canonical per-logical-Session Provider binding rather than
  reverse-scanning bounded JSONL tails or relying on `lastStateData`.
- Migrate existing facts by deriving the binding from the latest exact Provider
  receipt/result where needed; no synthetic Provider ID is allowed.
- Have `registerWorkerProfile` use that binding before calling Session
  Authority. Assert the launch args contain `--session <id>` for a resumed
  worker, including when the just-cancelled Dispatch itself never received a
  Provider receipt.
- Record Timeline diagnostics as “new terminal incarnation; original Provider
  Session resumed” or “new Provider Session; no resumable Provider identity.”
- Verify: cancel Publisher, terminate the PTY, recreate Runtime, then issue
  exactly one Task Send. Assert the old cancellation is settled and a later
  Publisher profile uses the old Provider Session ID and receives the new
  assignment once.

### Step 4 — correct C3's read-model projection

- `restart_or_recover` is valid only for a terminal/process loss with no
  resolved Dispatch fact. It must not be emitted for a cancellation that has a
  durable matching exit confirmation.
- A resolved cancelled Session has a history tab labelled `已中断`; it is
  logically available for a later dispatch even though its previous PTY is
  stopped.
- Timeline must contain the full causal sequence:
  `Conductor 请求中断 → Terminal/Provider 确认 → Dispatch 已中断 → Conductor
  被唤醒`.
- Verify: Task read model has no pending `session_exited` / `restart_or_recover`
  decision after cancellation reconciliation.

### Step 5 — diagnose C4 against a real terminal, then fix the owning layer

- Add a native Electron regression harness that opens a normal-buffer terminal
  with more than one viewport of output, moves the pointer inside the terminal,
  sends wheel input, and proves the xterm viewport changes while the document
  does not scroll.
- Repeat for an OpenCode alternate buffer: prove the handler prevents document
  scrolling, turns the wheel into native TUI navigation input, and that the
  live PTY receives that input.
- Inspect the real DOM hit-test and event path for terminal viewport, overlays,
  focus guards, `pointer-events`, passive listeners and CSS overflow before
  changing more wheel code.
- Verify selection/copy, tab switch, group resize and terminal history after
  the same interaction. The Electron smoke proves wheel delivery and no page
  scroll; manual selection/copy with the real OpenCode TUI is still required.
- Completion: the user can scroll the reported terminal in the desktop app;
  if OpenCode's alternate TUI has no scrollback, its own expected navigation
  remains interactive and the raw terminal-history drawer stays available.

### Step 6 — make Send wait for a Provider receipt, not a PTY start

- Every initial and recovered Conductor/worker stays in the interactive
  OpenCode TUI; `opencode run` is forbidden for a Workbench Session. A fresh
  Provider conversation uses `--prompt` to submit its initial contract while
  retaining the TUI. A proven continuation uses `--session <id>` without
  `--prompt`, because OpenCode's Session route ignores that flag.
- Before sending to a recovered Session, wait for its current terminal
  generation to finish its bounded history-restoration output. Then submit one
  bracketed paste and, after a terminal render/settle, one Return. This is a
  terminal-protocol guard only; it does not choose an Agent, dispatch route, or
  Task state.
- A user message/wakeup is `attempting` after the Terminal Runtime accepts a
  launch or write. Only `OpenCodeProviderObserver.observeConductorInput` may
  mark it `observed`; only then may the Task/Run service mark the user-message
  row delivered and open a new decision epoch.
- If the observer proves the marker is absent after an `attempting` launch,
  re-queue the unchanged idempotency key. An observer outage leaves the row
  pending; it must never be relabelled delivered.
- For records written by the pre-receipt implementation (`sent` wakeup but a
  falsely `delivered` user-message row), sending the exact same text reuses
  that original input ID and returns it to receipt-pending. A wakeup already
  observed by the Provider is never retried by this migration path.
- Verify the historical state, not only a clean Task: construct one Timeline
  user message plus a delivered SQLite row, a `sent` wakeup with no Provider
  message ID, and an exited Conductor PTY. One Send must preserve that input
  ID, launch `opencode --session <previous-provider-session>`, record the
  exact input receipt, record a new Conductor Provider message, and add only a
  retry transport event rather than another blue user message.
- Verify: a recovery Send leaves the row pending before a receipt, changes it
  only after a simulated exact Provider receipt, and preserves an alternate
  OpenCode TUI. The control-plane harness must open a post-delivery-claim
  dispatch only after that receipt.
- A completed Worker result is also a durable Conductor input. If it arrives
  after the current Conductor PTY exited, Runtime automatically restores the
  same logical Conductor with its proven Provider Session, keeps the result
  wakeup queued until the recovered TUI is input-ready, then sends it. Do not
  require a later person Send and do not write `recovery_required` unless the
  replacement terminal actually fails.

## Required end-to-end acceptance run

Run one real OpenCode Task through this exact sequence:

```text
create Task
→ type an unsent composer draft
→ switch Tasks ↔ Templates/Workbench ↔ Tasks
→ verify draft remains
→ dispatch Publisher and record Provider Session P
→ Conductor cancels that Publisher dispatch
→ Publisher PTY exits
→ restart Electron Runtime
→ Send one Task-page message to continue the same Run
→ reconcile cancellation to cancelled
→ Conductor later re-dispatches Publisher
→ verify replacement Publisher starts with --session P
→ inspect Timeline and Workbench terminal wheel/selection behavior
```

The evidence bundle records Task ID, Run ID, logical Session ID, old and new
terminal incarnation IDs, Provider Session ID, dispatch IDs, exact launch
arguments (without secrets), and the four UI observations. Passing unit tests,
build and generic UI smoke are necessary but insufficient.

## Implementation record — 2026-07-29

Implemented files:

- `desktop/runtime/session-authority.cjs`: exposes the persisted, renderer-safe
  Terminal Owner fact, including incarnation, generation and stopped time.
- `desktop/runtime/dispatch-coordinator.cjs`: reconciles matching persisted
  cancellation facts before every dispatch validation and exposes the same
  Task-wide fact projection to continuation; it never treats an empty
  in-memory PTY map as confirmation.
- `desktop/session-store.cjs`: persists a canonical OpenCode Provider binding
  separately from transient state; later `exited` records cannot erase it.
- `desktop/runtime/agent-loop-v1-runtime.cjs`: settles persisted cancellation
  facts before a live Send writes to Conductor and before a recovered
  Conductor starts, then prefers the canonical binding when building the next
  worker interactive `opencode --session` launch profile. It keeps user inputs pending
  until the Provider observes their exact marker; a PTY launch/write is no
  longer labelled delivered.
- `desktop/agent-loop-continuity-recovery-harness.cjs`: exercises the durable
  Session Store and Session Authority databases across a Main-process restart;
  it asserts one Send settles the old Dispatch and the later Publisher launch
  continues the original Provider session.
- `src/components/PtyTerminal.tsx`: sends alternate-buffer wheel navigation to
  the active PTY; normal buffer scrolling remains local to xterm.
- `desktop/agent-loop-v1-ui-smoke.cjs`: proves Task draft navigation and raw
  wheel input delivery in an Electron/xterm alternate buffer.

Verification completed:

```text
npm test
# 117 files, 840 tests passed

npm run build
# TypeScript and Vite build passed

npm run desktop:agent-loop-ui-smoke
# Electron Task navigation and xterm/PTY wheel harness passed

npm run desktop:agent-loop-continuity-recovery-harness
# Durable Session Store + Terminal Owner restart chain passed:
# cancellation → matching PTY exit → fresh Runtime → one Send → cancelled
# dispatch → replacement Publisher --session <original-provider-session>

node desktop/agent-loop-control-plane-harness.cjs
# Control-plane receipt gate passed: a post-delivery-claim dispatch opens only
# after the fixture records the exact Conductor input receipt.

npm run desktop:agent-loop-real-continuation-e2e
# Real OpenCode acceptance passed: Task Send restored the same logical
# Conductor Provider session, OpenCode recorded the exact Input ID, a new
# Conductor output was written to the durable Timeline, and the recovered
# terminal remained `opencode --session <same-id>` in alternate-buffer TUI.

npm run desktop:agent-loop-real-conductor-harness
# Real Publisher acceptance passed: the Provider created final.md and returned
# its exact result; before Task achievement, the harness asserted the Publisher
# was still a running OpenCode alternate-buffer TUI, never `opencode run`.

npm run desktop:agent-loop-real-worker-wakeup-recovery-e2e
# Real failure-injection acceptance passed: the harness terminated the
# Conductor PTY after it dispatched Publisher but before the Publisher result.
# Runtime restored `opencode --session <same-conductor-provider-session>`,
# delivered the durable Publisher wakeup, and Conductor claimed delivery;
# Publisher remained a running alternate-buffer OpenCode TUI.
```

The old UI smoke remains useful only for its UI assertions. It is explicitly
insufficient evidence for C2/C3, because it does not use a persisted Terminal
Owner fact or continue the same Task through Send.

Still required before declaring the product regression fully closed: the
real-Provider acceptance sequence below, plus a user-facing desktop check of
terminal text selection/copy.

## Non-goals

- No fixed Search → Review → Publish route.
- No automatic Publisher re-dispatch after cancellation.
- No Renderer access to PTY or Provider storage.
- No new Task/Run merely because an Electron process restarted.
- No “recover current Run” or “restart Session” button on the Task page.

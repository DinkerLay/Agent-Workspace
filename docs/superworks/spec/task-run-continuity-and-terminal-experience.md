# Task Run Continuity and Terminal Experience

Date: 2026-07-29
Status: active experience contract; initial implementation is in progress
Scope: the user-facing behavior of Task continuation, Task stop/restart,
terminal reconnection, Workbench placement, and terminal interaction.

## Why this contract exists

The product is a stateful multi-agent workbench only if a person can safely
continue a Task without having to reconstruct where its Conductor and native
Sessions went. A Task Timeline is the normal place to work with the Task; the
Workbench is where a person inspects or directly operates the real terminals.
The product must not make a person distinguish transport recovery from
ordinary continuation: they continue the Task by sending their next message.

This contract corrects several implementation gaps. The first four are now
implemented; terminal interaction still requires live OpenCode regression
evidence:

- a Task page exposing the Runtime's recovery mechanism as a separate user
  action instead of continuing from Send;
- every newly materialized Session landing in the primary Workbench Group,
  leaving the person to split and move them one by one;
- Stop being a page-header action instead of being available beside the Task
  composer that it changes;
- terminal scroll and text selection are specified in code but have not been
  proved in the real OpenCode interaction that users see;
- Timeline summaries can hide the actual user-visible Conductor result and
  make a delivery claim look like an unexplained state change.

The requirements below are user behavior and acceptance criteria, not a
workflow route. They do not tell the Conductor to call a particular Agent Card
or decide whether research, review, repair, or publication is appropriate.

## Decisions

1. **Task-page conversation is the default continuation action.** While the
   current Conductor terminal is live, sending a follow-up from Tasks writes to
   that exact live terminal/session. The provider conversation and native TUI
   stay intact.
2. **Send is the only continuation action.** If the exact Conductor terminal
   cannot be reached, Runtime retains the message and, as part of that Send,
   reattaches the existing terminal or starts a replacement terminal for the
   same Task Run. This transport detail is visible in Timeline diagnostics, not
   exposed as a second button.
3. **Stop belongs with Send.** The Task composer owns the immediate controls
   for a live Task: send, connection/status feedback, and stop. The header
   reports state and links to Workbench; it is not the primary place for a
   destructive runtime control.
4. **The first usable Workbench layout is automatic.** Actual started Sessions
   are assigned to usable Groups without requiring the person to create empty
   panes or drag tabs. Manual layout remains an override, never a prerequisite.
5. **Terminals are interactive terminals.** Trackpad/wheel scrolling and text
   selection must work in the terminal viewport. A full-screen TUI may use the
   wheel itself, but it must not turn the whole application into an inert
   surface or silently lose its terminal history.
6. **The Timeline exposes complete user-visible Conductor results.** A compact
   summary can be collapsed, but it cannot replace the actual visible Conductor
   answer, delivery claim, artifact references, or runtime reason. Private
   model reasoning and secrets are not Timeline content.

## The four facts that must not be conflated

One status label cannot describe a real Task. The renderer and Timeline must
keep these facts separate, even if they show a compact combined label.

| Fact | Examples | Owner | What it must not imply |
| --- | --- | --- | --- |
| Task delivery lifecycle | `queued`, `running`, `delivery_ready`, `achieved`, `stopped`, `archived` | Task/Conductor/user action | whether a PTY is reachable |
| Run control | `active`, `recovery_required`, `stopped`, `failed` | Runtime Coordinator | a business recommendation or an artifact-quality verdict |
| Conductor terminal truth | `starting`, `live`, `stopping`, `stopped`, `lost` | Terminal Runtime | that the Provider received or completed an input |
| Renderer attachment | `attached`, `reconnecting`, `detached` | terminal client | that the terminal process died |

`recovery_required` is a Run-control fact, not a synonym for Task completion
or failure. It means: the Task has durable history, but the Runtime cannot
prove that the exact Conductor terminal/session needed for normal continuation
is live and reachable.

The UI should use plain language built from these facts. For example:

```text
运行中 · Conductor 已连接 · 可继续对话
运行中 · 正在重新连接 Conductor（未创建新会话）
需要恢复 · 原 Conductor 终端不可用；未发送你的新消息
已停止 · 可新建 Run 重新执行；旧终端不会恢复
```

It must not say "运行中" or "已继续" while the only known Conductor terminal
is gone.

## Normal Task-page continuation

The Task composer is the ordinary control surface, not a second chat system.
It must behave as follows.

| Preconditions | Send behavior | User-visible result |
| --- | --- | --- |
| Task has not started | persist the message as Task input; Start delivers it to the first Conductor | `将随首次启动发送` |
| Task/Run are active and Conductor terminal is live | write one idempotent input envelope to that terminal's current incarnation | `已发送给当前 Conductor` and the message appears in Timeline |
| Terminal Host is live but this renderer is detached | Runtime may deliver to the same Host while the viewport reconnects; no PTY is created | `正在重新连接` and, after attach, the same terminal content/identity is visible |
| Terminal Host or Conductor process is unavailable | persist the message, prove the old PTY is unavailable, then continue the same Task Run through a new Host terminal | `正在继续任务` while starting; Timeline records whether the previous terminal was reused or replaced |
| Historical message says `sent`, but has no exact Provider input receipt | reuse its original input ID, return that one message to the receipt-pending queue, and continue through the same rules as Send | the original blue user card remains singular; Timeline shows `正在重新发送此前消息` until a Provider receipt and new Conductor output arrive |
| Task is `delivery_ready` and the current Conductor is live | same as active continuation; this is a new causal input and may reopen work | `已发送给当前 Conductor` |
| Task is stopped or achieved | do not queue bytes to an old Session | composer explains the next explicit action instead of pretending to continue |

A user follow-up sent to a live Conductor must retain all of the following
identity facts in diagnostics and test evidence:

```text
Task ID + Run ID + logical Conductor Session ID
+ terminal incarnation ID + provider session/turn binding + input ID
```

The Task page does not need to show those implementation identifiers by
default. The Timeline must retain enough information to answer: *was this
delivered to the previous live Conductor, is it still pending, or did Runtime
start a new Host terminal for the same Task Run?*

### Temporary disconnect versus lost terminal

These cases require different behavior.

1. **Renderer/tab/short transport disconnect:** the Terminal Host still owns a
   live terminal. The app reconnects and attaches a snapshot to the same
   session/incarnation. The Workbench may be closed, re-opened, resized, or
   temporarily disconnected without changing the native Session. This is
   ordinary continuation.
2. **Host or native process unavailable:** the Runtime cannot attach to the
   exact session/incarnation. When the person presses Send, it records the
   reason and last verified terminal/provider facts, retains the input, then
   starts a replacement Host terminal for the **same Task Run**. The Send is
   the explicit user intent; recovery is not a separate interaction.
3. **Provider-resumable session:** a recovery action may use a provider-native
   resume only when the Runtime can prove the provider session identity and the
   provider supports that operation. The UI states that it restored the prior
   provider session.
4. **No provable provider resume:** Runtime starts a **new physical Conductor
   terminal incarnation in the same Task Run**, with durable Task history,
   outstanding facts, and the pending user message. Timeline records this
   fact; the composer still says only `发送`.

An Electron child terminal host cannot preserve a PTY after the Electron
process itself exits. Until the product adopts a persistent terminal host, an
app restart therefore lands in case 2, not case 1. Historical raw terminal
output remains inspectable, but it is not evidence that a live terminal was
restored.

### Recovery is internal to Send

There is no `再次连接` or `恢复当前 Run` control on the Task page. If automatic
continuation cannot start, the message remains durable and pending; a later
Send retries it. Runtime must not mark it delivered merely because it wrote a
database row. `查看终端历史` remains a read-only Workbench diagnostic, and
`重新执行（新 Run）` remains available only from achieved history.

Older Runtime versions may have written a false success: a user-message row
was marked delivered and its wakeup became `sent` when a replacement PTY
started, without an exact Provider input receipt. The migration is bounded:
the next Send of the **same text** reuses the existing input ID and returns
only that unobserved user wakeup to `queued`. A wakeup with a Provider message
ID or `observed` status is immutable and is never retried. A retry is a
transport fact, not a second user utterance in Timeline.

### Worker-return continuation is automatic

`Send` is the only **person-facing** continuation control. It does not mean
that a completed native Session Agent must wait for another person message to
reach the current Run's Conductor. A Worker result, attention, or failure is
already a durable semantic input: if its target Conductor PTY has exited,
Runtime automatically starts a replacement terminal for the same logical
Conductor Session and proven Provider Session, then delivers the recorded
wakeup when the TUI is ready.

This transport recovery has no Task-page button and makes no business decision.
It may not create a new Run, rewrite the Worker result, pick another Agent, or
claim completion. `recovery_required` is reserved for an actual
replacement-terminal failure; it must not be written merely because a
recoverable Worker wakeup first finds no live PTY.

### Native OpenCode continuation protocol

The Workbench always hosts an interactive OpenCode TUI. `opencode run` is not
a valid substitute for a Session terminal because it exits after one response
and leaves an empty, non-continuable pane.

- A fresh Provider conversation starts OpenCode with the initial contract via
  `--prompt`; the process stays in its TUI after that turn.
- A proven Provider continuation starts OpenCode with `--session
  <provider-session-id>` and no `--prompt`. OpenCode's Session route does not
  submit `--prompt`, so the Runtime waits for its bounded history-restoration
  output to settle, sends one bracketed-paste envelope, then sends Return only
  after a terminal render/short settle.
- The logical Session's durable Provider binding is written when a Provider
  result, attention, receipt, or Conductor message identifies it. A new PTY
  incarnation never changes that identity.
- Provider observation after recovery is bound to that durable Provider
  Session ID, not to the replacement terminal's startup timestamp. Thus a
  second visible Conductor response cannot be filtered as pre-recovery output.
- The message is only `已送达` after the Provider records the exact input ID;
  it is only complete after the matching new Provider result is written to the
  Timeline. A live alternate-buffer TUI remains a separate transport fact.
- The same protocol applies to a Worker return. Runtime restores an exited
  Conductor before injecting its existing wakeup, and records the normal
  `conductor.recovered → conductor.wakeup.sent` causal chain instead of a
  stranded `conductor.recovery_required` entry.

The acceptance harness must prove all three facts together: exact input
receipt in the original Provider Session, a new Timeline response, and a
running alternate-buffer TUI for the same logical Session. Publisher delivery
has the same terminal requirement before Task achievement.

### Provider-native questions are a separate Task-page interaction

Provider permission and an OpenCode native question are different
user-owned interactions. Neither is a generic `needs attention` Timeline row
or a normal Task-to-Conductor message.

| Provider fact | Task-page surface | Durable writer | One-shot completion fact |
| --- | --- | --- | --- |
| OpenCode requests a capability/scope | right-inspector **需要授权** card | Provider hook adapter | `permission.resolved` from Provider |
| OpenCode is waiting for a question answer | right-inspector **需要回答** card | Provider observer + Task/Run service | `question.response_submitted` after exact owned PTY write |

For a native question, the read-only Provider observer records
`waiting_input` with the logical Session ID, Provider Session ID, opaque
`providerQuestionPartId`, question text, and the observing PTY
`terminalIncarnationId`. The Task-page card is a remote control for one live
native modal, not a history item: the renderer may show it only when the
current Runtime terminal for that logical Session is live **and** has the same
incarnation. A normal composer message remains a Conductor wakeup and is never
pasted into a native question UI.

Therefore, sending “copy the report to Desktop” while an OpenCode question is
open does **not** immediately create an authorization card. The Task message is
durably queued for the Conductor. If that native modal is still paired to the
current TUI, its **需要回答** card remains the only actionable control for the
prompt. After the answer has been accepted and OpenCode reaches its next
Provider boundary, the queued Task message reaches the Conductor; a
**需要授权** card appears only if the Conductor's subsequent native Session
actually asks OpenCode for a scoped permission. The renderer must neither
guess that an ordinary message answers a question nor fabricate a permission
request before the Provider emits one.

When a person submits the card, Task/Run service validates the current Task,
logical Session, opaque question ID, and that the observer's stored
incarnation equals the current terminal incarnation. It then uses `Session
Authority`'s serialized interactive-input route to write exactly one
bracketed-paste/Return sequence to that Session. Before the provider renders
its next frame it persists `question.response_submitted`; repeated clicks for
the same `{task, session, questionId}` return that receipt and do not write a
second answer. A stale observer poll cannot restore the card once that receipt
exists.

After Electron restart, the old child PTY is gone. Its persisted
`waiting_input` fact remains diagnostic history only: it creates no answer
field, button, or terminal recovery control on the Task page. A normal Task
**发送** continues the same logical Task through the ordinary Conductor
continuation path. If OpenCode resumes the logical Provider Session and again
exposes the question, the observer records that newly observed question with
the replacement terminal incarnation; only then does a paired **需要回答** card
return. Runtime must reject any attempt to write an answer using an old or
missing incarnation.

The Timeline records only the resulting compact fact (`你回答 <Session>`).
It must not render a second generic `需要处理` row for a question card.

Verification is layered and named honestly:

1. the real OpenCode attention harness proves Provider observation of an
   actual native TUI question into `waiting_input`;
2. the Electron Task-question pairing E2E proves a historical question from a
   previous terminal incarnation is hidden and rejected, while a re-observed
   question crosses IPC, writes to the exact owning PTY, and is consumed
   exactly once;
3. the real Task-permission E2E proves a real Provider permission card, reply
   transport, Provider confirmation, and resulting filesystem effect.

No visual/UI projection test may be described as a real Provider receipt.

## Stop, restart, and completion

### Composer controls

For a running or `delivery_ready` Task, the composer footer contains:

```text
[停止任务]   [发送]
```

- `停止任务` opens one confirmation that says which Task/Run and how many live
  native Sessions will stop. It explains that Task events, Run history,
  terminal history, and project files remain.
- For a live Task, the header contains `进入运行现场` and `Achieve`; it does not
  contain Stop, recovery, or Delete controls.
- Stop must be reachable with keyboard/focus navigation and must not be
  hidden by an empty composer, a collapsed Timeline, or a narrow viewport.
- While stopping, Send is disabled with an explicit `正在停止，不能再发送` state.

### Lifecycle meaning

| Person action | Required result |
| --- | --- |
| Stop Task | end the current Run's live native Sessions; preserve all durable history; set Task/Run to stopped |
| Restart a stopped Task | make a new Run and fresh Session identities; never attach the old provider conversation under the word restart |
| Continue in `delivery_ready` | deliver to the existing live Conductor, preserving the Run; the later Conductor decision can reopen work |
| Mark achieved | records the user's acceptance from either `running` or `delivery_ready`; it is not a terminal-kill command by itself |
| Continue an achieved Task | expose an explicit `基于此结果新建 Run` action; do not make the disabled composer appear to deliver to a completed old Run |
| Delete Task | available only from the achieved-task list through multi-select and one destructive confirmation; it deletes Runtime records only, never project files by implication |

Stopping is a user-owned lifecycle decision. Recovery is a transport fact and
an explicit user choice. A Conductor may report a terminal or dispatch problem
but must not claim Task delivery merely because it could not reach a Worker.

## Conductor interruption of an active dispatch

The Conductor needs a bounded way to stop work that has become redundant,
misdirected, superseded by a user follow-up, or no longer worth its runtime
cost. The operation is **`cancel_dispatch(dispatchId, reason)`**: it cancels
one outstanding assignment, not a Task, Session identity, terminal, or Provider
conversation.

```text
Conductor requests cancel_dispatch(dispatchId, reason)
  -> Coordinator durably records cancellation_requested
  -> Terminal Runtime / Provider Adapter sends the supported native interrupt
  -> Terminal and Provider facts are reconciled
  -> dispatch becomes cancelled or cancel_failed
  -> Conductor receives that fact and decides the next action
```

The Coordinator validates that the dispatch belongs to the current Task/Run,
is still outstanding, and was created by this Task's Conductor. It may perform
the transport interruption, but it must not choose a replacement Agent, retry
the assignment, call the Task complete, or kill unrelated Sessions.

| Operation | Who may request it | Effect |
| --- | --- | --- |
| `cancel_dispatch` | Conductor | graceful interruption of one active assignment; its native Session normally stays available once actual cancellation is confirmed |
| `停止任务` | user | stop every live native Session in the current Run and end that Run |
| `强制结束此 Session` | user, from the affected Workbench terminal after confirmation | emergency terminal termination when a dispatch cannot be interrupted; it may require recovery and is never a hidden Conductor side effect |

Cancellation is asynchronous. `cancellation_requested` is not `cancelled`.
If interrupt delivery itself fails, the durable status is `cancel_failed`; that
card also stays occupied until a later explicit interrupt or user force-stop
reaches a terminal fact.
The card remains occupied until the Runtime has an exact terminal/provider fact
that the relevant work is no longer active. Only then may the Conductor make a
new dispatch to the same Session or choose another card.

Cancelling does not roll back files, commands, or provider-visible changes the
Agent made before interruption. Those are durable project facts for the
Conductor and user to inspect; Runtime does not hide them or fabricate a clean
workspace. A cancelled Session's terminal stays visible, including its last
output and a clear `正在中断` / `已中断` / `中断失败` status.

### Terminal-incarnation ownership during permission recovery

One logical Session can have multiple physical terminal incarnations. A
permission reply may restore the same Publisher Provider Session after an
Electron restart, while an older dispatch cancellation is still durable. These
are separate operations and must never be resolved from the current PTY merely
because it has the same logical Session ID.

`Session Authority` is the sole owner of terminal incarnation facts. It keeps
both the current owner and an immutable-by-identity history keyed by:

```text
logical Session ID + terminal incarnation ID + terminal generation
```

The Coordinator follows these rules:

1. `cancel_dispatch` captures the incarnation/generation that originally
   accepted that dispatch's input. A dispatch which never reached a terminal is
   cancelled as `not_delivered` and sends no interrupt.
2. It may send a native interrupt only when the *currently live* PTY matches
   that exact captured identity. A newer permission-recovery PTY is not an
   interrupt target for an old dispatch.
3. Cancellation reconciliation queries the historical exact owner fact. A
   stopped old incarnation settles the old dispatch even when a newer PTY is
   live for the same logical Session.
4. `recovery_pending`, `replaying`, `submitted`, `reply_failed`, or another
   unresolved permission record occupies the recovered Session. Conductor may
   read state but cannot dispatch new work into that TUI until the Provider
   confirms the permission response.
5. The permission card is consumed as soon as the person chooses an answer:
   it leaves the actionable sidebar deck at `recovery_pending`. A fresh,
   same-scope Provider request replays the retained answer once; only an
   explicit `reply_failed` returns a card to the user.

This is terminal transport ownership, not a Conductor workflow rule. The
Conductor still decides whether an eventual next dispatch is useful; it cannot
race a user-owned Provider permission operation or interrupt a newer terminal
incarnation by mistake.

Timeline records the complete causal sequence: `Conductor 请求中断` → `Runtime
已送达中断` → `Provider/终端确认已中断` (or `中断失败`). A terse “已停止” entry is
not sufficient, because it cannot tell the user whether the Task, terminal, or
only one dispatch was affected.

## Workbench: automatic first layout, manual control afterwards

The Workbench is a Task Run terminal workspace. It should be useful the moment
the first parallel Sessions materialize.

### Default allocator

1. A new Run opens with the Conductor in the primary Group.
2. Only a Session with real Runtime evidence (started terminal, dispatch,
   result, attention, or retained terminal history) is eligible for placement.
   Template cards do not reserve empty panes.
3. When concurrently useful Sessions first materialize, the Workbench creates
   a balanced, usable Group layout and gives each visible Session a Group
   before placing additional Sessions into tabs. The default visible limit is
   the number of panes that satisfy the terminal minimum size, capped at four.
4. The allocator never starts a Session, changes a Conductor dispatch, or
   promotes a result to completion. It only decides where an already material
   terminal is shown.
5. It must not steal keyboard focus while the person is typing in another
   terminal. A new/attention Session gets a badge, not an unsolicited focus
   jump.

On a normally sized desktop this means a Conductor and up to three concurrent
workers are initially visible as a 2×2 grid. On a narrow window the allocator
uses fewer Groups and puts the remainder in tabs rather than creating
unreadable panes.

### Manual behavior

- Moving a tab, splitting a Group, changing a divider, closing/merging a Group,
  or choosing `重置为自动布局` is always a view-only operation. None launches,
  stops, dispatches, or re-prompts an Agent.
- A deliberate user layout persists for the Run. Subsequent Sessions enter the
  least-loaded usable Group as tabs; the automatic allocator does not reshuffle
  already placed terminals behind the user's back.
- `重置为自动布局` is available as an explicit view action. It may rearrange
  Groups but leaves every native terminal attached and keeps their session
  identities unchanged.
- A terminal that cannot be live attached still occupies a clearly labelled
  history/recovery tab rather than an unexplained empty Group.

This replaces the current "all unassigned Sessions go to primary, then manually
split and move" behavior.

## Terminal interaction contract

Each Group body is a terminal viewport. It is not a decorative output panel.

| User operation | Required behavior |
| --- | --- |
| Trackpad/mouse wheel in normal terminal buffer | scroll the xterm scrollback inside that terminal only; the application document does not scroll |
| Incoming output while reading history | preserve the reader's scroll position and expose `跳到最新输出`; do not force-jump to the bottom |
| OpenCode full-screen/alternate buffer | xterm forwards wheel through the native terminal mouse protocol when the TUI enables it, so the TUI may scroll its own context; a wheel gesture must never be rewritten as keyboard input or a fake scrollback |
| Mouse drag and copy | terminal text can be selected and copied through the normal platform interaction; input focus is not lost merely by selecting text |
| Tab switch, Group move, resize | preserve the native terminal attachment and normal-buffer scroll position where technically possible; do not restart the Session |
| Stopped/lost terminal | show retained raw history read-only, with a visible `已停止` or `需要恢复` state; do not render an input cursor |
| Wheel/selection failure | show no invisible overlay or pointer-event layer above the terminal; the issue is a release-blocking interaction defect |

The terminal has two different kinds of past content:

- normal-buffer scrollback, held by the terminal model (currently bounded at
  5,000 rows);
- a bounded raw terminal diagnostic log for a terminal that has exited or
  cannot be reattached.

Neither replaces Timeline semantic history. Conversely, a Timeline entry is
not a substitute for being able to scroll or select text in the terminal that
is currently live.

### Theme parity

The selected Workbench theme includes every terminal surface. Switching to
light mode updates the live xterm foreground, background, cursor, selection,
fallback transcript, and terminal chrome without recreating the terminal,
detaching a client, or losing scrollback. The terminal does not remain a dark
exception inside an otherwise light Workbench.

## Provider permission interaction

A Provider permission request is neither a Conductor decision nor generic
"needs attention" text. It is an explicit, user-owned decision for one
Provider request.

1. The OpenCode adapter reports structured `permission.asked`; Runtime writes
   one renderer-safe `requested` record with the request id, action, patterns,
   summary, and owning Session.
2. The Task page presents exactly three Provider choices: `仅此次允许` (`once`),
   `本会话总是允许` (`always`), and `拒绝` (`reject`). It also lets the person
   open the owning native terminal. A normal OpenCode question is a different
   interaction and is not relabelled as a permission.
3. The renderer submits the selected intent to the Task/Run service. It cannot
   write a terminal sequence, choose a default, or inspect Provider storage.
4. Runtime sends that exact response through the Provider reply transport and
   records `submitted`. A returned HTTP/transport receipt is not success.
5. Only structured `permission.replied` changes the durable record to
   `approved` or `denied` and returns the Session to its Provider-derived live
   state. A direct decision in the native terminal is observed by the same
   confirmation event.

The Task page owns the pending decision card. It displays the owning Session,
action, scope, and bounded Provider explanation, and submits the user's
selected response with that exact `sessionId` and `permissionId`. A pending
permission is not duplicated as an ordinary Timeline item or populated from
raw terminal text. Timeline records only the compact durable facts that a
response was submitted and that OpenCode later confirmed it.

The short-lived Provider reply endpoint and its token remain in Electron Main
memory only. They are not written into Timeline, Task state, JSONL projections,
renderer IPC values, or logs.

### Application restart while a permission is pending

An Electron restart ends the hook plugin's loopback reply endpoint together
with its token. The durable `requested` record must therefore never be
presented as proof that the old Provider request can still receive a reply.
The Task page remains the decision surface; it does not fall back to asking a
person to reconstruct a terminal interaction.

1. When the old reply transport is unavailable, selecting `once`, `always`, or
   `reject` records a `recovery_pending` decision for the exact
   `Task ID + logical Session ID + Provider + action + normalized scope`.
   The short-lived Provider request ID is retained for audit but is not the
   identity of the user's decision. The card is consumed; Timeline says that
   the selection is retained but not yet applied.
2. On every Runtime construction, before the UI receives a new action, Runtime
   scans active Task Runs for `recovery_pending` records with a retained answer
   and restores the *same logical Session* through its proven Provider session
   identity. The scan is idempotent per logical Session: historical duplicate
   request IDs do not create duplicate host terminals. It never creates a new
   Task Run or treats a replacement host terminal as a new worker conversation.
3. The resumed OpenCode plugin must emit a fresh `permission.asked` before
   Runtime sends the retained response through its new, Main-process-only
   transport. If its Provider request ID changed but Provider, action, and
   normalized scope are unchanged, the old record is marked `reissued` and the
   new request takes over the retained response. At most one current logical
   permission can remain actionable. The normal `submitted` then
   `permission.replied` confirmation path follows.
4. A changed Provider, action, or normalized scope is a new user decision; the
   retained response is not applied to it. A failed transport leaves that new
   card explicitly retryable and records a human-readable retry fact rather
   than showing an internal error code or falsely reporting an approval.

This preserves both safety properties: a restart cannot reuse a credential,
and a person can still handle the interrupted operation from Tasks without
manually locating a TUI.

The Conductor receives no permission-decision wakeup and cannot approve,
reject, or infer the outcome. It may later receive ordinary Provider work
results after the Provider continues; that is a separate semantic fact.

## Timeline and Conductor visibility

The Timeline must make the causal story understandable without requiring the
person to infer it from tiny terminal tabs.

- A Conductor decision, result, delivery claim, or response to a Task-page
  message stores the complete user-visible text. Long content can be collapsed,
  but `展开` reveals it verbatim rather than an engineered paraphrase.
- The Timeline may omit private model reasoning, credentials, and bounded raw
  terminal chatter. It must not omit the Conductor's final user-visible answer,
  artifact path/summary, claimed delivery, an explicit question, or a stated
  terminal/runtime failure.
- Every state transition includes its actor and cause: e.g. `用户停止`,
  `Conductor 提交交付主张`, `继续任务时原终端不可用，Runtime 已续接`, or `用户消息已送达当前
  Conductor`.
- `delivery_ready` is shown as the Conductor's actual claim plus its visible
  evidence. A generic runtime sentence such as "已提交当前交付主张" is not an
  adequate replacement.
- The Timeline labels whether a Task-page message was `已送达`, `正在续接`,
  `待重试`, or `发送失败`. A generic `task.continued` entry cannot conceal which
  of those happened.

## Project root is part of Task identity

Task Assembly selects one writable project root. It is visible in Task details,
Workbench terminal metadata, artifact links, and recovery context. Every
native Session in that Run uses that root.

Changing a project root mid-Run would make terminal history, provider context,
and artifacts ambiguous. The product therefore creates a new Task for a new
project root rather than silently changing the current Task's directory.

## Required implementation sequence

This document deliberately does not prescribe a Conductor workflow. It does
set the smallest implementation order needed to make the experience honest.

1. **Continuity truth first.** Add durable Run control and exact Conductor
   terminal availability/attachment presentation. A Task-page user message is
   the explicit request that permits reattach or `startConductor()` fallback.
2. **Composer lifecycle controls.** Put status, Stop, and Send in the Task
   composer. Do not add reconnect or recovery actions. The live Task header
   contains only `进入运行现场` and `Achieve`.
3. **Recovery protocol.** Implement exact reattach before replacement;
   provider-native resume only when provable; otherwise start a new incarnation
   with a durable continuation envelope and per-message receipt.
4. **Dispatch cancellation.** Add durable cancellation request/receipt states,
   a Conductor `cancel_dispatch` tool, Provider/terminal reconciliation, and
   the user-only emergency Session termination escape hatch.
5. **Automatic initial placement.** Allocate already material Sessions across
   Groups by viewport capacity; preserve manual layout and prevent focus steal.
6. **Terminal usability proof.** Verify normal-scroll, alternate-screen wheel,
   selection/copy, hidden-tab stability, resized panes, and stopped-history
   behavior in a live native OpenCode run—not only by unit tests or CSS.
7. **Timeline fidelity.** Persist and render complete user-visible Conductor
   content plus explicit causes for delivery/stop/recovery transitions.

## Acceptance scenarios

The following must be demonstrated against a real native OpenCode run before
the implementation is called complete.

| Scenario | Observable acceptance |
| --- | --- |
| Follow-up while live | From Tasks, send a message; the same Run ID, terminal incarnation, and provider session remain visible in diagnostics; no extra Conductor process starts |
| Workbench closed/reopened | The same Conductor TUI is reattached with its content; no new native Session starts |
| Renderer transport interruption | UI shows reconnecting, then restores the same terminal snapshot; message delivery has no duplicate input |
| Terminal Host/process lost | Sending the next Task message retains it, then reattaches or starts a replacement terminal for the same Run; no separate recovery control appears |
| Automatic continuation | Timeline says whether Runtime reattached the old terminal, resumed a provable provider session, or created a new Conductor incarnation; the pending message gets an exact receipt |
| Worker return while Conductor PTY is gone | Runtime resumes the same logical Conductor Provider Session without a person Send, injects the already-recorded Worker result after TUI readiness, and records a new Conductor decision; no `recovery_required` is shown unless terminal restoration truly fails |
| Stop and restart | Stop is beside Send; stopping preserves Timeline/history; restart creates a new Run and new Session identities |
| Conductor interruption | A Conductor cancellation touches only the named outstanding dispatch; Timeline proves requested → delivered → confirmed/failed, and no automatic retry or Task completion occurs |
| Delivery follow-up | A `delivery_ready` Task can receive a Task-page follow-up on the same live Conductor; the Timeline explains the causal change |
| Parallel dispatch | Real started workers automatically occupy separate usable Groups until capacity; user need not create empty Groups or move tabs |
| User layout | Moving/splitting does not start, kill, or refocus any Session; reopening restores the chosen layout |
| Terminal interaction | Normal buffer scrolls; an alternate TUI receives a protocol-correct mouse-wheel event when it enables mouse tracking, never a synthetic arrow key; text can be selected/copied, and inactive/previous terminals retain expected scroll/history behavior |
| Theme parity | Toggle light/dark while a PTY is live; the terminal updates in place, retains the same attachment and scrollback, and its fallback/history surface has matching contrast |
| Provider permission | Trigger an OpenCode `ask` rule; Task shows the action/pattern and three choices, a submitted reply is not marked confirmed until `permission.replied`, and reply credentials never appear in a renderer read model or Timeline |
| Permission recovery versus stale cancellation | Start Publisher dispatch on incarnation A, persist a user permission answer, then inject its cancellation either before or after an Electron restart restores the same Provider Session on incarnation B. The old dispatch settles from A's historical stopped fact; no Ctrl-C reaches B; the sidebar has no actionable card while the reply is pending; a new Publisher dispatch is rejected until `permission.replied`. |
| Conductor completion | Timeline displays the full visible Conductor delivery text and evidence, not only a generic `delivery_claim`/`task.continued` summary |

## Relationship to the existing specifications

- `task-template-runtime-model.md` remains the authority for Template, Task,
  Run, and Session vocabulary. Its restart/recovery behavior must distinguish
  same-Run automatic continuation from a deliberate new-Run restart.
- `orca-terminal-runtime-adoption.md` remains the authority for terminal host,
  snapshot/delta/ACK, and live-versus-dead transport facts. This contract adds
  the human-facing consequence of those facts.
- `product-interaction-map.md` remains the authority for screen structure. Its
  Task composer and Workbench layout rules must be updated to conform to this
  contract during implementation.
- `agent-loop-conductor-guidance.md` remains the authority for Conductor prompt
  construction. It must not give the Conductor a hidden terminal-recovery or
  Task-lifecycle decision role.

# Orca Runtime / Trigger Boundary Audit — 2026-07-28

## Scope and method

This started as an audit of the current Agent Loop implementation. The
remediation below is now implemented where marked, and the remaining items are
kept here as the executable boundary plan. The review traced these boundaries
through current source, durable runtime state, focused tests, and a real native
OpenCode DeepSearch run:

```text
Conductor tool call
  -> Dispatch Coordinator / durable command state
  -> Orca-style Terminal Runtime (claim, PTY, snapshot/delta/ACK)
  -> OpenCode Provider Observer (read-only provider facts)
  -> durable semantic wakeup
  -> next Conductor decision
```

The Orca comparison is deliberately narrow. Orca supplies terminal-host
mechanisms: exclusive claims/generations, host-side terminal state,
snapshot/delta delivery, ACK/backpressure, and a clear distinction between a
live terminal and a dead one. It does **not** implement Task, dispatch,
provider observation, or Conductor policy. Those must be built above it without
letting terminal text become a business-state oracle.

Current verification: the full suite passes (**112 files / 811 tests**), the
production renderer builds, the Orca terminal contract harnesses pass, and the
real DeepSearch E2E generated a Template from a natural-language request,
saved it, ran native OpenCode Conductor/worker Sessions, passed a complete
durable result through `contextRefs`, generated `deepsearch-report.md`, claimed
delivery, marked the Task achieved, and explicitly deleted the Runtime-owned
Task records. The E2E artifact retained the user-facing file; only Runtime
metadata was removed.

## Required ownership model

| Layer | May decide | Must persist | Must not decide |
| --- | --- | --- | --- |
| Terminal Runtime | transport truth: live, exited, bytes accepted, snapshot/delta/ACK | terminal claim, generation/incarnation, transport result | provider receipt, task route, retry, completion |
| OpenCode Provider Adapter | provider truth for one exact bound dispatch/turn | provider DB identity and exact provider binding | terminal retry, wakeup routing, task completion |
| Runtime Coordinator | turn durable facts into idempotent delivery attempts and wakeups | dispatch attempt, wakeup state, input receipt/reconciliation state | whether research, review, publish, or retry is appropriate |
| Conductor | next work and explicit semantic handoff | its explicit decisions/claims through tools | direct PTY write, terminal/protocol recovery |

`Task` lifecycle remains distinct from run control:

```text
Task: queued -> running -> delivery_ready -> achieved -> archived/delete
Run control: deciding | awaiting_provider | wakeup_queued |
             decision_required | waiting_user | recovery_required
```

Worker completion must not automatically mark a Task `achieved`; that remains a
user confirmation after an explicit Conductor delivery claim. The persisted
Conductor wakeup is also the decision inbox: a result remains an inbox item
only until the exact wakeup input is observed by OpenCode.

## Remediation status

| Boundary | Status | Current enforcement |
| --- | --- | --- |
| Terminal vs semantics | addressed | Orca-style daemon owns claims, generations, snapshots/deltas/ACK; it never derives provider/task state from terminal bytes. |
| Dispatch ownership | addressed | `dispatch-coordinator.cjs` owns record → profile/activation → serialized input → transport acceptance. The MCP bridge now presents its durable receipt rather than owning PTY sequencing. |
| Delivery claim fence | addressed | `delivery_ready` rejects another dispatch until an explicit user message or Runtime wakeup opens a new Conductor decision. |
| Provider fact isolation | addressed | OpenCode observer reads the provider store, records exact receipt/database identity, and fences Conductor reads at the newest native incarnation/input marker. |
| Wakeup restart recovery | addressed | wakeups are persisted, hydrated on monitor start, and can request the logical Conductor target to be recreated before input delivery. |
| Observer outage | addressed | unavailable observation remains an observer fact; terminal exit does not fabricate a provider-negative outcome. |
| Dead terminal history | addressed | live attach is preflighted; exited Sessions use retained raw terminal history rather than `attachTerminalClient`. |
| Legacy hook fallback | addressed | a generic `session.error` is attributed only to the newest outstanding legacy dispatch; it cannot abort the monitor through an undefined variable or fan out to all dispatches. |
| Result inbox | addressed | a worker result remains a durable artifact, but contributes to `needs attention` only until its exact persisted Conductor wakeup is observed. `contextRefs` are now solely explicit semantic handoff, never an implicit inbox acknowledgement. |
| Same-card occupancy | addressed | durable dispatch state permits at most one `queued` / `input_accepted` / `delivered` assignment for a native Session. A coordinator-local reservation closes the concurrent tool-call race before the record exists; Provider result or delivery/provider failure reopens the card for a Conductor-chosen follow-up. |
| Long-lived host restart | policy remaining | an Electron child daemon intentionally cannot preserve a live PTY across app restart; recovery is historical log plus a new native Session, unless the product later selects a persistent host. |

## Original defect inventory and rationale

The sections below preserve the observed failure mechanism and intended rule.
Refer to the remediation table above for current status; some entries now
describe the historical bug rather than present behaviour.

### P0 — queued semantic wakeups are durable only as an event, not as work

`desktop/session-wakeup-monitor.cjs` stores queued wakeups in the in-memory
`pendingWakeups` map. It appends `conductor.wakeup.queued` to JSONL, but
`start()` does not hydrate that queue, and later scans only active dispatches.
Once a worker result moves to `result_available`, it is no longer an active
dispatch; after Electron restarts it is never requeued or delivered.

This was observed in the local runtime store: Task runs have worker results
available and a Conductor in `waiting_conductor`, while the Task remains
`running`. This is a control-plane recovery loss, not an OpenCode model error.

**Fix direction:** make wakeup a first-class durable record keyed by
`(taskId, conductorDecisionTarget, dispatchId/resultId/failureId)`, with states
`queued -> input_submitted -> provider_turn_observed` (or a terminal,
actionable failure). On startup, reconcile records before scanning workers.
Never infer a sent wakeup from the absence of a live process.

### P0 — a delivery claim does not fence the current Conductor decision

`validateDispatch()` accepts both `running` and `delivery_ready`, and
`callSession()` invokes `resumeTaskForDispatch()` before recording the new
dispatch. Therefore a Conductor can call `claim_task_completion`, then issue
another dispatch in the same provider turn; the Task is silently moved back to
`running`.

The current durable DB contains this exact sequence for `loop-cc527d83`:
`conductor.delivery_claim -> task.continued`, with no user message in between.
The runtime test currently codifies this as expected behaviour.

**Fix direction:** a completion claim closes the current decision epoch. A new
dispatch requires a *new causal input*: user follow-up or a Runtime semantic
wakeup that has been durably delivered to, and observed as a new Conductor
turn. This does not remove Conductor autonomy; it prevents one model turn from
both declaring delivery and undoing that declaration.

### P0 — observer outage plus PTY exit is falsely recorded as “no receipt”

In `inspectObservedWorkerSession()`, an `observation_unavailable` fact is
recorded, but if the terminal has exited the same branch falls through to
`recordDispatchDeliveryFailure()` with “ended before OpenCode recorded the
exact dispatch marker.” The system has no evidence for that claim; it only
knows that it could not inspect the provider database.

**Fix direction:** keep `observer_unavailable` as a separate recoverable fact
and put the run into `recovery_required`/attention. Only record
`delivery_failed` after a successful, exact, final provider observation proves
that the marker is absent. The Conductor may later decide whether to reissue
work; the Coordinator must not manufacture a provider-negative fact.

### P1 — physical write and durable dispatch attempt are not one recoverable protocol

The Conductor bridge currently owns the whole sequence: resume Task, create
dispatch JSONL, prepare profile, activate PTY, enqueue prompt, then mark
`input_accepted`. Its idempotency map is memory-only. A crash after OpenCode
receives bytes but before `markDispatchInputAccepted` leaves an ambiguous
dispatch; a restart can replay it. Conversely, `markDispatchInputAccepted`
records generation/incarnation in an event but does not persist them on the
dispatch record itself.

**Fix direction:** move this sequence into a dedicated Coordinator with a
durable `DispatchAttempt` state machine and an idempotency key. Persist the
attempt identity and expected terminal generation *before* side effects;
reconcile uncertain attempts using the exact OpenCode receipt, never by
resending blindly. The bridge should submit a command to the Coordinator and
return its durable receipt; it should not itself manage PTY activation and
writing.

### P1 — Provider bindings are incomplete, especially for Conductor turns

Worker dispatch binding records provider session/message/timestamp, but drops
the observer’s provider database identity. The Conductor observer finds the
latest completed answer after the initial start prompt; it does not persist a
binding for each accepted Conductor input (user message or Runtime wakeup).
With restarts, database relocation, or a replaced session incarnation, an
answer can be associated with the wrong decision boundary.

**Fix direction:** bind every observed fact to:

```text
providerKind + providerDatabaseId + providerSessionId + providerMessageId
+ provider turn/step id + task/run/session incarnation + coordinator input id
```

The Provider Adapter remains OpenCode-specific and read-only. It returns only
facts about the exact bound provider turn; it must not classify terminal text
or select a route.

### P1 — user-message restart path produces a false delivery receipt

When the Conductor is not live, `flushPendingUserMessages()` restarts it and
marks all pending user messages delivered as
`conductor_restarted_with_durable_context`. The prompt does not actually carry
those messages, so “delivered” means only that the database contains them.
This is the same causal-delivery defect as the wakeup issue.

**Fix direction:** either inject one durable envelope per pending message with
an idempotency key, or make the startup prompt name the exact unread message
IDs and persist the provider turn that consumed them. Do not mark a message
delivered merely because a new terminal was spawned.

### P1 — multiple outstanding assignments and session projection can hide failures

`callSessions()` prevents duplicate targets only within one batch. There is no
durable occupancy/attempt rule preventing a later decision from assigning the
same Session Agent while an earlier dispatch is outstanding. `projectSessionRuntimeState()` then chooses only the latest result/failure; a later result can
mask an older unresolved failure in the same session.

**Remediation:** dispatch attempts remain independent. The runtime now rejects
a second outstanding assignment for the same native Session from durable state,
and the coordinator reserves the Session across the pre-record async window.
The Session becomes dispatchable after a Provider result or delivery/provider
failure; the next route remains entirely a Conductor decision.

**Original fix direction:** model each dispatch attempt independently. A Session card
may have multiple historical attempts, but a new assignment needs an explicit
Coordinator rule: same native session continuation is allowed only when its
previous attempt has reached a terminal provider fact or the Conductor has
chosen an explicit cancellation/recovery route. Task attention must list all
unconsumed terminal facts, not a single “latest” projection.

### P1 — legacy fallback control path has an undefined variable

The non-Observer path in `reconcileDispatchProviderFacts()` compares a dispatch
with `latestActiveDispatch`, but that variable is not declared in that
function. A provider hook error on that path can throw and abort the inspection
cycle. Production normally takes the Provider Observer path, but this is still
an active fallback and test/harness path rather than dead code.

**Fix direction:** either remove the legacy semantic-reconciliation path once
the OpenCode observer is mandatory, or repair it with the same exact-binding
rules. Do not keep two semantic state machines.

### P2 — “needs attention” conflates available context with an unprocessed decision

`buildTaskPendingDecisions()` treats every `result_available` as permanently
pending. There is no durable “this result was included in Conductor decision
X” acknowledgement. This explains screenshots that keep reporting several
“needs attention” after results have already been used.

**Fix direction:** retain results as immutable available context, but create a
separate decision-inbox record which is acknowledged only when the next bound
Conductor turn starts/consumes it. UI counters must reflect the inbox, not all
historical results.

### P2 — tool contract is redundant and diverges from the accepted spec

The implementation exposes `call_session` and `call_sessions`; prompts and
wakeup text mention those names. The intended minimal contract describes
`read_task_state`, `read_session`, one `dispatch_sessions`, and
`claim_task_completion`. Two dispatch paths invite subtle divergence in
validation, batching, and delivery fencing.

**Fix direction:** expose one batch-capable dispatch command. A one-agent
dispatch is a one-element batch. The Coordinator returns `intent_recorded` /
`input_accepted` transport facts, never “worker finished.”

### P2 — live attach is used where historical viewing is required

`attachTerminalClient()` correctly requires a live terminal and raises
`terminal_session_not_live` for an exited one. The UI attempted to use it for
terminal history, producing the Electron error reported earlier. Orca similarly
distinguishes a live host attachment from a separate history/recovery surface.

**Fix direction:** preflight live state before attach. If it is exited, open
the persisted raw terminal-log/history panel instead; return a typed
`not_live` result rather than surface an IPC exception in normal navigation.

### P2 — status summaries become stale after result availability

`recordDispatchResult()` updates the dispatch/result record but does not update
the session state summary set at provider receipt. UI can consequently show
“awaiting Provider outcome” beside a result that is already available.

**Fix direction:** derive presentation from immutable dispatch attempt state,
or update the projection atomically. Do not use stale free-text summaries as a
control input.

### P3 — terminal host is largely on the correct Orca path, with two contract gaps

The local host does have host-side screen state, claim/generation checks,
snapshot/delta, ACK and producer backpressure. That is the right foundation.
Two gaps remain:

1. `orca-terminal-daemon-manager.createOrAttach()` recomputes `created` versus
   `adopted` from generation equality rather than forwarding the daemon’s
   disposition, so an adoption can be reported as creation.
2. The daemon is an Electron child process; its live PTYs cannot survive an
   Electron/daemon restart. This is not automatically wrong, but it must be an
   explicit product policy. If restart survival is required, it needs a
   persistent host/reattach design; terminal log alone is not a live session.

Neither gap should be “fixed” by placing task or provider logic inside the
terminal host.

## Redundant controls to remove rather than patch around

1. The legacy `dispatchStateReader` / provider-hook semantic path once the
   OpenCode Provider Observer is mandatory.
2. Bridge-owned activation/write orchestration after it moves to the
   Coordinator.
3. In-memory-only dedupe maps as correctness mechanisms. They may remain a
   performance cache only after durable idempotency is authoritative.
4. Result-derived “needs attention” counters after decision inbox state exists.
5. Free-text terminal/history UI fallbacks that treat a dead terminal as live.

## Required remediation order

1. Freeze the Conductor tool contract and add a decision epoch / causal input
   ID. Fix the delivery-claim fence first.
2. Add durable `DispatchAttempt`, `ProviderBinding`, `SemanticWakeup`, and
   `ConductorInput` records with recovery reconciliation.
3. Move dispatch activation/input from `conductor-tool-bridge.cjs` to a
   Coordinator that consumes those records.
4. Make the OpenCode Adapter bind provider DB identity and each Conductor turn.
5. Delete/retire the legacy observer path; add a typed terminal-history
   fallback.
6. Rebuild UI projections from durable attempt/inbox state only.

## Mandatory harnesses before accepting the rewrite

| Harness | Setup | Required assertion |
| --- | --- | --- |
| Wakeup recovery | worker result is recorded while Conductor is busy; terminate/recreate monitor | exactly one durable wakeup is delivered after restart |
| Claim fence | Conductor claims delivery, then tries dispatch in same provider turn | dispatch rejected; a later user/wakeup turn is accepted |
| Write crash window | crash after terminal accepts a dispatch before receipt persistence | restart reconciles exact provider marker; no duplicate worker prompt |
| Observer outage at exit | database observer unavailable and PTY exits | state is observer/recovery attention, never false `delivery_failed` |
| Provider-binding isolation | two OpenCode DB candidates and two same-task incarnations | each result binds only to its recorded DB/session/message/turn |
| Same-card re-dispatch | dispatch same card before previous exact outcome | Coordinator rejects or requires an explicit continuation/cancel command |
| Result consumption | result wakes Conductor and is used in a dispatch context packet | result remains available, but leaves the decision inbox exactly once |
| Terminal lifecycle | attach exited Session from workbench | typed history fallback, no `terminal_session_not_live` renderer error |
| Real DeepSearch E2E | create template/task, run native OpenCode, worker result, reviewer feedback, remediation, publish | every handoff follows a durable attempt and Conductor wakeup; no scripted route assumptions |

## Acceptance condition

Do not accept the refactor because a happy-path DeepSearch run happens once.
Accept it only when the nine harnesses above pass and the Coordinator can be
stopped/restarted at every external side-effect boundary without duplicate
dispatch, lost wakeup, false provider failure, or accidental task continuation.

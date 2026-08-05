# State-Driven Agent Signaling Review

Date: 2026-07-08
Status: Converged design note; core implementation batch applied.
Scope: Agent runtime state projection, intervention signaling, Conductor/Worker message flow, UI confirmation policy.

Related:

- `docs/bugs/2026-07-08-session-state-message-flow.html`
- `docs/bugs/2026-07-06-task-runtime-status-timeline-layout.md`
- `docs/superworks/spec/provider-session-state-detection.md`
- `docs/superworks/spec/conductor-session-communication.md`
- `docs/superworks/spec/development-instrumentation.md`

Implementation note:

- The core projection is now implemented by `projectSessionRuntimeState()` in `desktop/session-store.cjs`.
- The old `deriveSessionRuntimeState()` wrapper was removed after it became redundant.
- `queued` is no longer treated as assignment-deliverable by itself.
- `read_task_state().sessions[]` now exposes secondary facts such as `lastResultId`, `resultCount`, `unresolvedFailureDispatchId`, `attentionHints`, and `assignmentReadinessHint`.
- `pendingDecisions` now keeps worker result decisions visible alongside later delivery failure decisions.
- `task.completion_claim` is now bridged by App into `agent-claims-done`, so structured completion claims enter Review/Goal gate without using terminal text or legacy `Agent.status`.
- `npm run simulate:state-message-flow` now covers the state projection, Agent-card label, pending-decision preservation, and completion-claim Review gate path end to end with a fake opencode provider.

Naming boundary:

- Runtime Session Store event: `task.completion_claim`.
- Task/review audit event, if implemented separately: `finish.claim.created`.
- Do not treat those names as interchangeable without a migration that updates both specs and code.
- `development-instrumentation.md` also contains audit examples such as `session.state.changed`; the active Session Store contract currently uses concrete session events such as `session.ready`, `session.waiting_input`, and `session.delivery_failed`. Preserve the active contract unless a planned migration changes both sides.

## Conclusion

Using state to drive user intervention and agent signaling is the right architecture for this product, with one important boundary:

> Runtime state is the control signal. Message bodies, evidence, results, and user choices still travel through structured records: `events.jsonl`, `dispatches.jsonl`, `results.jsonl`, `messages.jsonl`, and `pendingDecisions`.

So the design should not become "put everything into `AgentRuntimeState`". The state should answer:

- can this Agent receive a new assignment?
- is this Agent currently producing output?
- does this Agent need user input or permission?
- is there a result that Conductor must consume?
- is there a blocked recovery path?
- should the UI draw attention, open a confirmation dialog, or stay quiet?

The state should not carry:

- the Worker answer body,
- the full Conductor synthesis,
- file diffs or artifact content,
- permission details beyond a compact decision reference,
- final task completion proof.

This matches the current spec direction. `provider-session-state-detection.md` says PTY output is a transport trigger, not a state oracle, and the provider adapter plus state reducer maps facts to Workspace state. It also says Agent cards, Workbench progress, `read_task_state`, `read_session`, and `call_session` deliverability must all consume the same Session Store state.

## Where The Reviews Converged

The user's observations, the attached review, the original code evidence, and this implementation batch converge on the same required design.

| Topic | Converged conclusion | Evidence |
| --- | --- | --- |
| Single state source | Keep one visible runtime state from Session Store. Legacy `Agent.status` is fallback only. | `provider-session-state-detection.md:160`, `provider-session-state-detection.md:184` |
| PTY boundary | PTY data/exit can trigger inspection, but cannot classify semantic status. | `provider-session-state-detection.md:15`, `provider-session-state-detection.md:79`, `provider-session-state-detection.md:94` |
| Last-dispatch overwrite | Original issue: the prior runtime projection let the latest dispatch overwrite the whole session state. Implemented fix: `projectSessionRuntimeState()` reduces all dispatch/result facts. | `desktop/session-store.cjs` |
| Result plus later failure | A previous `result_available` must not disappear when a later dispatch fails. Primary state can be `delivery_failed`, but secondary facts must preserve `lastResultId` / `resultCount`. | `desktop/session-store.cjs:516` to `desktop/session-store.cjs:542` |
| Thin pending decisions | Original issue: `pendingDecisions` were directionally correct but not rich enough for composite UI or Conductor recovery. Implemented fix: result/failure decisions now carry severity, action hints, and related dispatch ids where applicable. | `src/orchestration/conductor-tools/types.ts` |
| Deliverability is too coarse | Original issue: `isWorkerSessionDeliverable()` treated `queued` as deliverable. Implemented fix: `queued` no longer proves target input readiness. | `desktop/conductor-tool-bridge.cjs`, `provider-session-state-detection.md:204` |
| Completion is not done | Conductor natural language output may be timeline evidence, but final `done` must come through structured completion claim and Review/Goal gate. | `conductor-session-communication.md:261`, `development-instrumentation.md:567`, `development-instrumentation.md:599` to `development-instrumentation.md:604` |
| Animation comes last | Animation should consume attention projection only. It must not be used to compensate for incorrect state. | Product review consensus; HTML flow doc section 5 |

The main remaining product decision is how to render a session that has both "historical result available" and "latest dispatch delivery failed". The converged choice is:

- primary visible state: `delivery_failed`, because it is the current intervention need;
- secondary facts: `result_available`, `lastResultId`, `resultCount`, and failed dispatch id;
- UI label: `Delivery failed · result available`;
- Conductor state: both `worker_result_available` and `session_delivery_failed` pending decisions remain visible.

## State Should Be A Projection, Not A Writer Race

The original implementation had too many paths that wrote the same `state` field directly. Examples included dispatch queued/delivered/failed/result paths, Conductor provider-question paths, and PTY exit paths. Worker provider waiting/permission/blocked mappings are specified, but they are not fully implemented as current behavior. `readSession()` and `readTaskState()` now project the visible state through `projectSessionRuntimeState()`.

That created two sources of confusion:

1. `state.json.state` is unclear: is it a raw sample, a dispatch lifecycle value, provider semantic state, process state, or reducer output?
2. the final projection must not use only `dispatches.at(-1)`, because a later failed dispatch can mask an earlier valid result.

The fix should be to treat runtime records as facts and derive one output:

```ts
type SessionFacts = {
  process?: ProcessFact;
  provider?: ProviderFact;
  dispatches: DispatchFact[];
  results: ResultFact[];
  permissions: PermissionFact[];
  taskGate?: TaskGateFact;
};

type SessionProjection = {
  state: AgentRuntimeState;
  activeDispatchId?: string;
  lastResultId?: string;
  resultCount: number;
  unresolvedFailureDispatchId?: string;
  attentionHints: AttentionHint[];
  assignmentReadinessHint?: "ready" | "unknown" | "not_ready";
};
```

`state.json` may remain as a cache of this projection, but direct writers should append facts instead of independently deciding the final visible state. `assignmentReadinessHint` is only a hint for UI and planning; it is not delivery proof. The `call_session` write path must still live-confirm provider readiness immediately before writing an assignment.

## Proposed State Classes

Keep the `AgentRuntimeState` union small enough to reason about, but classify it for UI and control policy.

| Class | States | Meaning | UI treatment |
| --- | --- | --- | --- |
| Lifecycle | `not_started`, `starting`, `ready`, `stopping`, `stopped`, `exited`, `start_failed` | Process/session lifecycle. | Neutral or unavailable; no semantic completion implied. |
| Active work | `queued`, `delivered_pending`, `running` | Assignment is in flight or provider is producing output. | Running/progress badge; do not ask user unless timeout. |
| Human attention | `waiting_input`, `permission_required` | Provider or policy requires user choice. | Strong attention; may open confirmation/dialog. |
| Conductor attention | `waiting_conductor`, `result_available` | Runtime has information Conductor should consume. | Timeline/result cue; no blocking user modal. |
| Recovery needed | `delivery_failed`, `result_invalid`, `blocked`, `timeout` | Runtime cannot proceed safely without recovery. | Blocked badge; show recovery options; conditional confirmation. |

The class should drive color, progress counts, and attention style. The exact state should drive detail copy and action availability.

## Message Passing Model

The runtime should use state to decide when a message should be sent, not to carry the message itself.

### Conductor To Worker

1. Conductor calls `call_session`.
2. Shell validates target session against the task plan and allowlist.
3. Shell records a dispatch fact with `dispatchId`.
4. Shell waits until the provider session can receive input.
5. Shell writes the assignment into the provider session.
6. Provider adapter confirms the dispatch marker exists.
7. Dispatch moves to `delivered`; session projection becomes `delivered_pending` or `running`.

Failure before or during delivery records failure evidence and projects `delivery_failed`. Delivery failure after `recordDispatch()` must include the failing dispatch id so UI and Conductor can distinguish it from earlier successful dispatches. A pre-dispatch route validation failure may have no dispatch id, but it must include `taskId`, `toSessionId`, reason, message, and task-level event evidence.

### Worker To Conductor

1. PTY data triggers inspection of that worker only.
2. Provider adapter reads provider-native state and dispatch window.
3. A valid answer writes:
   - `messages.jsonl` for answer body,
   - `results.jsonl` for compact result index,
   - `dispatch.result_available`,
   - pending decision `worker_result_available`.
4. Runtime wakes Conductor once with the matching result body.
5. Conductor starts its next turn with `read_task_state`, then uses `read_session` only for needed details.

This matches `conductor-session-communication.md:261` to `conductor-session-communication.md:317`: Conductor must not synchronously poll a just-dispatched worker; Runtime wakes it when a decision point exists.

### User To Conductor

User intervention should be explicit:

- Task Home composer writes `user.intervention` plus provider input.
- Raw Workbench terminal bytes must remain PTY transport and must not become timeline evidence.
- Provider-native choices should become pending decisions with question/options, then user confirmation writes an intervention/decision result.

### Completion Claim To Task Status

Conductor normal output is not task completion. Completion should be:

1. `conductor.message` for normal visible output;
2. explicit `task.completion_claim` for structured completion;
3. Review/Goal gate checks evidence;
4. task status becomes `done` only after approval.

No natural-language "done" string should bypass this path.

Keep the two completion layers distinct:

- Runtime timeline evidence: `task.completion_claim`.
- Review/audit evidence, if implemented separately: `finish.claim.created`.

They can be correlated, but they should not become two competing ways to mark a task done.

## Confirmation And Popup Policy

Confirmation dialogs are for risk and responsibility, not for every state change.

| Trigger | Popup? | Reason |
| --- | --- | --- |
| `waiting_input` with provider choices | Yes | User must pick a route that the agent cannot safely decide. |
| `permission_required` / policy exception | Yes | File writes, command execution, or boundary crossing needs human approval. |
| Conductor wants to directly edit Worker-owned deliverable | Yes | This is a protocol exception and should name scope and review plan. |
| repeated `delivery_failed` requiring reset/retry/replace | Conditional | First retry can be runtime/Conductor-owned; destructive or repeated recovery needs confirmation. |
| `result_available` | No | Normal information transfer; wake Conductor and show timeline/result cue. |
| `task.completion_claim` | Yes, through Goal/Review gate | Task done requires evidence and approval, not terminal text. |
| user presses Stop on active provider turn | Conditional | Confirm if there is active work or an active dispatch; idle stop can be direct. |

The popup decision should consume `pendingDecisions` and `attentionHints`, not raw PTY output or legacy `Agent.status`.

## Implementation Boundaries

The implementation batch stays small and testable.

### 1. Add regression tests first

Add a Session Store test for this exact composite case:

1. dispatch A becomes `result_available`;
2. dispatch B later fails delivery;
3. `readTaskState()` returns:
   - primary session `state: "delivery_failed"`;
   - `lastResultId` / `resultCount` / `unresolvedFailureDispatchId`;
   - both `worker_result_available` and `session_delivery_failed` pending decisions.

### 2. Replace latest-dispatch projection

Use `projectSessionRuntimeState()` as the reducer over all dispatch facts, result facts, raw provider/process state, and permission facts. Do not base final state on only `dispatches.at(-1)`.

### 3. Extend session summary fields

Extend `ReadTaskStateSessionSummary` with non-breaking optional fields:

```ts
activeDispatchId?: string;
lastResultId?: string;
resultCount?: number;
unresolvedFailureDispatchId?: string;
attentionHints?: string[];
assignmentReadinessHint?: "ready" | "unknown" | "not_ready";
```

This keeps one primary `state` while giving UI and Conductor enough context to avoid losing facts.

### 4. Enrich pending decisions

Add fields such as:

```ts
severity?: "info" | "attention" | "blocking";
actionHint?: string;
relatedDispatchIds?: string[];
```

For `session_delivery_failed`, include `dispatchId` when known.

Invariant: a `session_delivery_failed` decision must not remove, consume, or hide an earlier `worker_result_available` decision. Composite states must expose both pending decisions until the relevant result is consumed and the failure is resolved or superseded.

### 5. Fix deliverability policy

`isWorkerSessionDeliverable()` should not treat `queued` as proof of readiness. Deliverability should be computed from the projection:

- provider/process can receive input,
- no active delivered/running dispatch,
- no unresolved blocking state requiring recovery,
- policy allows a follow-up assignment.

`result_available` can be deliverable only after provider readiness is confirmed and the result decision remains separately visible.

Do not persist `canReceiveAssignment` as a durable truth. If the UI needs a lightweight indicator, expose `assignmentReadinessHint`, then require the delivery path to perform the final live provider readiness check before each write.

### 6. Update UI labels before animation

Update Workbench and TaskBoard card labels to use primary state plus secondary summary:

- `Delivery failed · result available`
- `Waiting input · 2 results`
- `Running · dispatch BE16FA`

Only after the labels are correct should attention animation be added.

## Acceptance Checks

- A session with dispatch A `result_available` and dispatch B `failed` projects primary `state: "delivery_failed"` while preserving `lastResultId`, `resultCount`, and both pending decisions.
- `read_task_state().pendingDecisions` includes an actionable `dispatchId` for delivery failures when a dispatch record exists.
- Pre-dispatch route validation failure is recorded with `taskId`, `toSessionId`, reason, and message even when no `dispatchId` exists.
- `call_session` does not treat `queued` alone as deliverability proof.
- Final assignment delivery still live-confirms provider readiness before writing, regardless of any cached `assignmentReadinessHint`.
- `result_available` remains visible even when a later failure or process exit occurs.
- Conductor free-form "done" only records `conductor.message`; it does not move task status to `done`.
- `task.completion_claim` enters Review/Goal gate rather than bypassing it.
- UI labels show primary state plus secondary facts before any attention animation is added.

## Animation Boundary

Animation is reasonable after the state model is correct.

Use animation for:

- unacknowledged `waiting_input`;
- unacknowledged `permission_required`;
- selected task needing user intervention.

Do not use animation for:

- ordinary `result_available`;
- continuous `delivery_failed` shaking;
- raw PTY activity;
- legacy `Agent.status`.

Respect `prefers-reduced-motion`. When the user selects the Agent or opens the decision panel, downgrade animation to a static attention style.

## Final Assessment

The state-driven intervention model is reasonable and matches the product direction. The current implementation problem is not the idea of state signaling; it is that multiple fact dimensions are compressed into one state string too early, and then the latest dispatch can overwrite the visible projection.

The converged fix is:

1. facts are appended durably;
2. one reducer projects a single primary `AgentRuntimeState`;
3. secondary summary fields preserve result/failure/context facts;
4. `pendingDecisions` carries actionable decision payloads;
5. UI, Conductor tools, deliverability, popups, and animation consume that same projection.

This keeps one status trigger while still allowing richer agent-to-agent and agent-to-user signaling.

# Provider Session State Detection Spec

Date: 2026-07-02

Status: Draft for implementation.

Related sources:

- `docs/superworks/spec/conductor-session-communication.md`
- `docs/superworks/spec/development-instrumentation.md`
- `docs/superworks/spec/product-interaction-map.md`

## Summary

Agent Workspace must treat PTY output as a transport trigger, not as a state oracle and not as the source of truth for worker completion.

The Shell owns raw PTY lifecycle and event delivery. Provider adapters own provider-specific semantic state inspection. Session Store owns durable task/session/dispatch/result records. Conductor owns task-level decisions after Runtime wakes it with a decision point.

For opencode, the provider adapter should read opencode's structured session database. It must not infer worker results from terminal screenshots, terminal transcript text, `Thinking`, `Build`, prompt visibility, or business-language claims such as "done".

```text
PTY data or process exit
  -> debounce the changed session only
  -> provider adapter inspects provider-native state
  -> state reducer maps provider state to Workspace state
  -> Session Store records transition/result once
  -> Runtime wakes Conductor only when a decision point exists
```

## Goals

- Remove terminal-text status parsing from task/session state decisions.
- Keep PTY state limited to raw process lifecycle and event delivery.
- Use provider adapters as the source of truth for provider turn state.
- Detect and expose stuck cases such as "provider turn stopped but no answer or expected artifact exists".
- Avoid repeated polling across all sessions.
- Avoid duplicate dispatch results and duplicate Conductor wakeups.
- Keep worker sessions provider-native and free of Agent Workspace protocol injection.

## Non-Goals

- Do not build a hidden replacement for opencode or Claude Code.
- Do not require workers to output JSON, XML, or custom handoff blocks.
- Do not persist raw PTY transcripts, snapshots, or clean terminal logs as communication truth.
- Do not use `answerHash`, `displayKey`, or a second dispatch key for routing. `dispatchId` is the task-scoped communication id.
- Do not use terminal idle alone to mark a dispatch complete.
- Do not model terminal text as task state.
- Do not use terminal transcript regex, prompt text, progress spinner text, TUI repaint text, or `Thinking`/`Build` labels to drive Agent cards.

## Ownership

| Layer | Owns | Does not own |
| --- | --- | --- |
| PTY Manager | spawn, resize, write, stop, bounded live terminal buffer, data/exit events | task completion, provider answer extraction |
| Trigger Monitor | debounce changed session, call adapter inspection, record compact provider-derived state transitions | scanning all sessions repeatedly, classifying terminal text, judging answer quality |
| Provider Adapter | provider-native turn state, permission/waiting state, answer extraction, expected artifact checks where configured | UI state, Conductor decisions |
| Session Store | state.json, dispatches.jsonl, results.jsonl, task-level messages.jsonl, compact events | raw terminal history as truth |
| Task Runtime | loop scheduling, decision-point wakeups, stop-condition checks | worker internal tool/subagent behavior |
| Conductor | delegation, follow-up decisions, user escalation, task-state synthesis | worker-owned artifact editing |

## PTY Raw Lifecycle And Events

PTY Manager exposes only raw process lifecycle and output events:

```ts
type PtyLifecycle = "running" | "stopping" | "stopped";

type PtyEvent =
  | { type: "data"; id: string; chunk: string; cursor: number }
  | { type: "exit"; id: string; status: "stopped"; exitCode?: number; signal?: number; cursor: number };
```

Rules:

- `not_started` means no Workspace Session PTY exists yet; it is not a PTY lifecycle state.
- `spawn_failed` is a Runtime launch failure; it is not inferred from terminal text.
- `data` is emitted when the PTY process pushes stdout/stderr or TUI repaint output.
- `exit` is emitted once when the process exits.
- PTY Manager does not know `idle`, `waiting`, `permission_required`, `blocked`, `timeout`, `done`, or `result_available`.
- Legacy terminal-derived sampled fields such as `sampledState` are removed from the active runtime contract. They must not reappear as Agent cards, task status, Conductor wakeups, dispatch results, or Review state inputs.

## Trigger Rules

PTY trigger behavior:

- On worker `data`, schedule inspection for that worker session only.
- On worker `exit`, inspect that worker session immediately or after a short debounce.
- Debounce repeated TUI repaint output from the same session.
- If no PTY event occurs, do not continuously poll all sessions by default.
- A periodic watchdog may exist only for timeout/SLA enforcement, not as the main communication path.

Trigger output is an inspection request, not a status verdict.

A trigger can say "this session changed"; only the provider adapter plus state reducer can say "this session is waiting, blocked, completed, or has a result".

## Provider Turn State

Provider adapters return a normalized state:

```ts
type ProviderTurnState =
  | "not_started"
  | "delivered_pending"
  | "running"
  | "waiting_input"
  | "permission_required"
  | "completed_with_answer"
  | "completed_with_artifact"
  | "completed_without_result"
  | "blocked"
  | "timeout"
  | "exited";
```

`not_started` and `exited` are normalized Workspace/runtime states derived from launch records or PTY process exit. They are not terminal text classifications.

For a delivered dispatch, opencode adapter inspection must return enough detail for Shell to map the state:

```json
{
  "provider": "opencode",
  "taskId": "task-intake-001",
  "sessionId": "opencode:project-runtime-current:task-intake-001:task-intake-001-reviewer",
  "dispatchId": "E0CDCA",
  "providerTurnState": "completed_without_result",
  "providerSessionId": "ses_...",
  "providerMessageId": "msg_...",
  "providerStepFinishId": "prt_...",
  "stepFinishReason": "stop",
  "answerText": "",
  "expectedArtifactState": "missing",
  "expectedArtifactPath": "deliverables/review-notes.md",
  "reason": "Provider turn stopped, but no non-empty assistant text part and no expected artifact were found."
}
```

## opencode Adapter Rules

For opencode:

- Find the provider session by matching the exact `[Agent Workspace] Dispatch ID <dispatchId>` marker in the target workspace directory.
- Use the matched dispatch message timestamp as the start boundary.
- Stop the result window at the next Agent Workspace dispatch marker in the same provider session.
- Inspect assistant messages only inside that dispatch window.
- A valid answer is the first completed assistant message with:
  - a provider `step-finish` part with `reason: "stop"`,
  - one or more non-empty, non-ignored `text` parts,
  - no `reasoning`, `tool`, TUI repaint, or terminal control text included in `answerText`.
- If the provider turn has `step-finish.reason = "stop"` but no valid text answer, check configured expected artifacts.
- If an expected artifact exists and was updated after dispatch delivery, adapter may return `completed_with_artifact`.
- If neither answer text nor expected artifact exists, adapter returns `completed_without_result`.
- Provider-native waiting prompts return `waiting_input`.
- Provider-native permission prompts return `permission_required`.
- Tool errors, permission denials, startup failures, or impossible provider states return `blocked`.

The adapter must not select "latest assistant message in the session" globally. A single provider session can receive multiple dispatches.

## Workspace State Mapping

The Trigger Monitor maps provider state to Workspace state:

| Provider state | Workspace effect |
| --- | --- |
| `not_started` | dispatch remains queued or target session start pending |
| `delivered_pending` | dispatch remains delivered; session may show running |
| `running` | session state `running`; UI shows working |
| `waiting_input` | session state `waiting`; UI highlights required input |
| `permission_required` | session state `waiting_permission`; UI highlights permission attention |
| `completed_with_answer` | write task-level `messages.jsonl`, write worker `results.jsonl`, mark dispatch `result_available`, wake Conductor |
| `completed_with_artifact` | write result record with artifact reference, mark dispatch `result_available`, wake Conductor |
| `completed_without_result` | mark session `blocked` or `waiting_result_invalid`, record compact event, wake Conductor with failure text |
| `blocked` | mark session `blocked`, wake Conductor with failure text |
| `timeout` | mark session `timeout`, wake Conductor with timeout text |
| `exited` | mark session `exited`; if dispatch has no result, wake Conductor with failure text |

`completed_without_result` is a real state. It must not continue to display as `working`.

## Session Store Records

Task runtime root:

```text
.agent-workspace/runtime/<task-id>/
  events.jsonl          # compact task-level event index
  messages.jsonl        # full provider-extracted answer messages
  sessions/<session-id>/
    state.json
    dispatches.jsonl
    results.jsonl       # compact dispatch-result index
    events.jsonl        # compact session transition events
```

Rules:

- `messages.jsonl` stores full answer bodies for valid provider results.
- `results.jsonl` stores compact dispatch-result pointers.
- `dispatchId` is the only Agent Workspace communication id.
- Provider ids are audit fields only.
- Repeated state samples update `state.json`; they do not append duplicate transition events.
- Repeated inspections for the same `dispatchId` and same provider message/step id must not append duplicate results or wakeups.

## Conductor Wake Messages

Wake messages are plain text written only to Conductor.

Successful provider result:

```text
Runtime wakeup: Reviewer result available

Task: task-intake-001
Worker session: opencode:project-runtime-current:task-intake-001:task-intake-001-reviewer
Dispatch ID: E0CDCA
Result ID: result-E0CDCA

Reviewer answer:
<full provider-extracted answerText>

Conductor: decide the next action. If follow-up work is needed, use call_session; do not edit worker-owned deliverables yourself.
```

Completed without result:

```text
Runtime wakeup: Reviewer completed without a valid result

Task: task-intake-001
Worker session: opencode:project-runtime-current:task-intake-001:task-intake-001-reviewer
Dispatch ID: E0CDCA

Observed state:
The provider turn stopped, but no non-empty assistant answer text was found and the expected artifact is missing:
deliverables/review-notes.md

Conductor: decide whether to re-dispatch Reviewer, route a fix to another session, or ask the user.
```

Blocked:

```text
Runtime wakeup: Reviewer needs attention

Task: task-intake-001
Worker session: opencode:project-runtime-current:task-intake-001:task-intake-001-reviewer
Dispatch ID: E0CDCA

Observed state:
<short blocked reason from provider adapter or Runtime launch failure>

Conductor: decide the next action.
```

Wake messages must not be JSON metadata payloads. They may include metadata lines, but the body should be readable by the Conductor model as normal task context.

## UI Behavior

The UI should render Workspace state, not raw provider text guesses:

- `running` -> working badge
- `waiting` -> waiting/attention badge
- `blocked` or `waiting_result_invalid` -> blocked/needs handling badge
- `result_available` -> idle or result-ready badge depending on selected surface
- `timeout` -> timeout badge

Agent cards must not read `NativePtySession.status`, terminal prompt text, or terminal regex results as their semantic state source. PTY lifecycle can only support explicit launch/exit records. Agent cards render the Workspace Agent State reduced from Provider Adapter results and explicit Runtime launch/exit records.

The terminal pane remains a live inspection surface. It can show the provider TUI, but it should not be the only evidence used to explain task state.

## Verification

Implementation must include tests for:

- PTY data triggers inspection for only the changed session.
- Repeated TUI repaint data does not append duplicate events/results.
- opencode adapter returns `completed_with_answer` when a matched dispatch window contains a completed assistant text answer.
- opencode adapter returns `completed_without_result` when the matched provider turn stops with no text answer and expected artifact is missing.
- `completed_without_result` changes session state away from `running`.
- successful result wake includes full `answerText` and is plain text.
- failure/no-result wake is plain text and includes dispatch id plus expected artifact reason.
- Worker result extraction never uses reasoning/tool/TUI text as `answerText`.
- The visible UI does not show `working` for a provider turn that already stopped without result.
- PTY `data` and `exit` events never directly set Agent card state except for explicit launch/exit lifecycle records.
- Terminal transcript regex and legacy sampled fields do not influence task state, Agent card state, dispatch result state, or Conductor wakeups.
- Provider-native permission state maps to `permission_required` and then to Workspace `waiting_permission`.

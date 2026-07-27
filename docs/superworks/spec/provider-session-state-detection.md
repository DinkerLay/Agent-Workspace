# Provider Session State Detection

Date: 2026-07-26

Status: Accepted OpenCode semantic-plane contract.

## Purpose

The terminal transport and OpenCode meaning are independent facts. PTY output
can trigger a check, but it cannot prove that an OpenCode dispatch arrived,
completed, failed, or needs a user answer.

```text
terminal data / terminal exit / OpenCode hook
  -> inspect only the changed known Session
  -> OpenCode Adapter reads provider-native structured state
  -> Coordinator records an idempotent semantic transition
  -> meaningful transition wakes the logical Conductor once
```

The Runtime does not parse `Thinking`, `Build`, prompt visibility, a spinner,
screen pixels, or model prose such as “done”. It never uses terminal output as
business evidence.

## Owners

| Layer | Owns | Must not do |
| --- | --- | --- |
| Orca-style Terminal Runtime | process lifecycle, output transport, snapshots, input receipt, exit | classify task or Provider meaning |
| OpenCode Provider Adapter | structured OpenCode receipt, turn state, assistant answer, native question/attention/failure | choose the next task action |
| Runtime Coordinator | durable dispatch/result state, dedupe, artifact indexing trigger, one wakeup per decision point | retry/reroute a business task, approve permission, judge answer quality |
| Conductor | interpret facts, decide dispatch/correction/user question/delivery claim | write raw PTY bytes or parse terminal text |
| User | answer native provider prompts and inspect final artifacts | be a relay for normal worker handoff |

## Dispatch Receipt Protocol

Each Conductor `call_session` receives an immutable `dispatchId`. The separate
facts are recorded in order; none may be inferred from a later or weaker fact.

| State/event | Proven fact |
| --- | --- |
| `dispatch.command.accepted` | Conductor command was validated and persisted. |
| `terminal.input.accepted` / `dispatch.input_accepted` | daemon Host serialized the bounded prompt to a specific incarnation. |
| `dispatch.provider.received` | OpenCode persisted the matching `[Agent Workspace] Dispatch ID <id>` user message. This is delivery success. |
| `provider.turn.running` | OpenCode reports the dispatch turn is active. |
| `dispatch.provider.result` / `result_available` | Adapter extracted the completed answer associated with the dispatch window. |
| `dispatch.provider.attention` | OpenCode reports a native question, permission, or other input-needed state. |
| `dispatch.provider.failed` | Provider reports a terminal failure or the Session exits without a valid result. |

A successful `write()` is never `delivered`. A fixed delay is never a receipt.
A Provider receipt is never an assertion that the result satisfies the task.

The Adapter persists the matched Provider session/message identity with the
receipt. It must inspect exact dispatch provenance and timestamp boundaries so
an old answer from the same OpenCode conversation cannot satisfy a new command.

## Trigger And Dedupe Rules

- PTY data marks only that Session dirty; redraw storms are debounced.
- PTY exit triggers one final inspection after terminal output ordering is
  settled.
- OpenCode hook events can request the same inspection faster; they do not
  bypass the Adapter or Coordinator reducer.
- Each `(dispatchId, semantic transition)` is recorded at most once.
- `dispatch.provider.received` wakes Conductor only when the currently active
  Conductor decision needs that fact; completed result/failure/attention then
  cause the next semantic wakeup exactly once.
- The Coordinator may retry an **inspection query** after a transient database
  read error. It must not retry a Provider task, manufacture a new dispatch,
  or answer a native prompt.
- There is no production wall-clock completion timeout. Test harness timeouts
  detect a hung test only and must never alter Task state.

## Result, Attention, And Failure

For OpenCode, a result is valid only when the Adapter finds the first completed
assistant turn that is causally after the persisted dispatch marker and whose
finish state is provider-valid (for the current adapter, `step-finish.reason =
"stop"`). It returns the native assistant answer plus narrow provider metadata.

When a result references an artifact, Coordinator may index a safe path under
the Task workspace. Indexing enables user preview; it does not prove quality or
claim task completion.

Native question and permission states remain owned by the provider terminal:

```text
Provider reports attention
  -> Coordinator records waiting_input / attention fact
  -> Runtime wakes Conductor with a compact semantic notice
  -> Task Timeline offers “open Session terminal”
  -> user answers in OpenCode TUI
  -> new provider state triggers another inspection
```

Neither Runtime nor Conductor impersonates the user by auto-writing a
permission response. A user may send a task-level follow-up to Conductor; that
is a separate semantic message, not an answer to the native provider prompt.

On Provider failure, the Coordinator records exact provider/error facts and
wakes Conductor. Conductor decides whether to retry the same card, assign a
different card, narrow the request, or ask the user. The Terminal Runtime only
reports host/process facts; it does not have a task retry policy.

## Adapter Contract

```ts
type ProviderDispatchState = {
  dispatchId: string;
  providerSessionId?: string;
  receipt?: { messageId: string; recordedAt: string };
  state: "queued" | "received" | "running" | "result_available" | "waiting_input" | "failed";
  answerText?: string;
  attention?: { kind: "question" | "permission" | "other"; summary: string };
  failure?: { code?: string; summary: string };
};
```

Adapter calls are read-only against provider state. They must return explicit
unknown/not-found information rather than invent a result from TUI output.
Coordinator maps these facts to durable events and sends a compact Conductor
inbox message that names the task, card, dispatch, semantic state, and result
reference. Full results remain readable through task-scoped Conductor tools.

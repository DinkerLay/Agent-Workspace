# Historical: Conductor-Centric Session Communication Spec

Date: 2026-06-28

Status: Superseded on 2026-07-26. Retained as historical design evidence only.
The active authority is `../agent-loop-v1.md`,
`../agent-loop-conductor-guidance.md`, `../provider-session-state-detection.md`,
and `../orca-terminal-runtime-adoption.md`.

> **Agent Loop v1 override (2026-07-26):**
> [`agent-loop-conductor-guidance.md`](../agent-loop-conductor-guidance.md) is
> the authority for the active Loop. The Conductor may issue zero or more
> asynchronous dispatches in one decision turn and decides when to end that
> turn. Runtime records facts and wakes Conductor; it does not impose role
> order, repair/review routes, evidence gates, or a completion route. A PTY
> that is not input-ready leaves a dispatch `queued` and is retried on state
> change, not failed by a wall-clock worker-execution timeout. `achieved` is a
> user action after inspecting the actual artifact, not an artificial review
> gate.

Related sources:

- `docs/research/agentsroom-research-2026-06-24.zh.md`
- `docs/research/session-communication-mechanisms-2026-06-28.zh.md`
- `docs/superworks/spec/product-interaction-map.md`
- `docs/superworks/spec/provider-session-state-detection.md`
- opencode local validation: `opencode 1.17.11`, `opencode mcp`, `opencode plugin`
- Claude Code local validation: `claude 2.1.186`, `claude mcp`, `--mcp-config`, `--append-system-prompt`, `--plugin-dir`

## Summary

Agent Workspace should use a Conductor-centric communication model.

The Conductor session is the only session that receives Agent Workspace orchestration tools and task-owner instructions. Delegated sessions such as Researcher, Reviewer, Planner, Executor, and QA remain provider-native opencode, Claude Code, Codex, or other CLI sessions. They should not receive Agent Workspace protocol prompts, should not be required to call Agent Workspace tools, and should not be modified to understand a custom cross-session message format.

`call_session` is not a replacement for opencode subagents, Claude Code subagents, tools, skills, or provider-native decomposition. It is a session-level delegation primitive for large assignments across independent provider sessions, such as opencode assigning work to Claude Code, Claude Code assigning work to opencode, a task spanning multiple project paths, or a task requiring strong model/runtime isolation. Once a delegated session receives an assignment, that session may use its own provider-native subagents, tools, commands, permissions, and iteration controls internally.

The Shell owns PTY lifecycle, bounded live terminal buffers, provider adapter result extraction, event storage, worker target allowlists, permission policy, and runtime-triggered Conductor turns. Conductor owns task-level reasoning, delegation, follow-up, task-state synthesis, escalation, and delivery-readiness judgment. It manages the task mainline; it does not personally execute worker-owned deliverables.

Task Home and Task Draft Assistant produce an editable Task Session Plan before execution. The selected task template is only a seed. The final user-confirmed plan is the truth for Conductor prompt planning, worker session creation, and target allowlist enforcement.

```text
Conductor Session
  -> Agent Workspace MCP tools
  -> call_session / read_task_state / read_session / claim_task_completion
  -> Shell Session Manager
  -> provider-native delegated sessions
  -> Shell-owned session store
  -> Conductor reads and decides the next action
```

## Goals

- Keep Conductor human-like: it acts as a task owner that reads, asks, delegates, follows up, and summarizes.
- Keep delegated sessions unmodified: they behave like normal provider-native agent terminals.
- Avoid turning system instructions into visible user prompts.
- Avoid requiring delegated sessions to output custom XML, JSON, or Workspace Session protocol blocks.
- Make communication durable through Shell-owned session stores and event logs, not raw terminal DOM state.
- Make the task-generated Session Agent Plan editable before execution and use it as Conductor's business routing context.
- Preserve explicit permission, review, and audit boundaries.

## Non-Goals

- Do not build a second hidden agent runtime that replaces opencode or Claude Code.
- Do not require Researcher, Reviewer, Executor, QA, or other delegated sessions to load Agent Workspace MCP tools in the first version.
- Do not parse worker completion from a brittle custom text protocol.
- Do not let MCP tool calls block until long-running worker tasks complete.
- Do not write task-scoped runtime state into `docs/research/`, `docs/superworks/spec/`, or `docs/superworks/plans/`.

## Feasibility Validation

This design is feasible because both target providers expose session-scoped extension points:

- opencode on this machine exposes `opencode mcp` for MCP server management and `opencode plugin` for project or global plugin installation.
- Claude Code on this machine exposes `claude mcp`, `--mcp-config`, `--append-system-prompt`, and `--plugin-dir`, which are sufficient for launching a Conductor session with task-scoped MCP tools and task-owner instructions.

For opencode, the preferred first implementation path is task-scoped config plus MCP, not global installation. For Claude Code, the preferred first implementation path is `--mcp-config` plus `--append-system-prompt` or plugin directory loaded only for the Conductor session.

The implementation plan must still verify the exact opencode config isolation mechanics before writing code. If opencode cannot load a task-local config directory reliably, the fallback is to launch a Conductor session with an explicit project-local MCP registration inside `.agent-workspace/runtime/<task-id>/`, and avoid modifying worker sessions.

## Architecture

```text
Task Home
  -> Task Draft Assistant proposes task config + Session Agent Plan
  -> user reviews/edits planned sessions and task facts
  -> Task Intake creates task + session group from the confirmed Session Agent Plan
  -> Shell starts Conductor with Agent Workspace MCP + Conductor prompt generated from the confirmed plan
  -> Shell starts or later wakes delegated sessions from the plan as plain provider-native CLIs

Conductor
  -> call_session(target session, session-level assignment)
  -> gets the task-scoped six-character dispatchId after Shell confirms delivery
  -> ends the current turn after a successful dispatch
  -> later reads delegated session results when Task Runtime starts another Conductor turn
  -> decides whether to continue the delegated session, call another session, ask user, or finish

Shell
  -> streams PTY output to the UI and keeps bounded in-memory terminal buffers
  -> extracts provider-native session results through provider adapters when available
  -> stores compact status transition events, dispatches, provider-extracted results, and state
  -> uses provider adapters as the source of truth for delegated-session turn completion
  -> enforces worker target allowlists and permission policy derived from the confirmed Session Agent Plan

Task Runtime / Scheduler
  -> owns event delivery and Conductor wakeup delivery
  -> watches dispatch/result/status/attention/user events
  -> starts a new Conductor turn when a durable fact needs a decision
  -> passes a plain-text wake message with the relevant provider-extracted result when a worker answer is ready
```

## Task Session Plan

The Task Session Plan is the user-visible, editable inventory of native Session
Agent Cards available to one runtime task. The Template's Conductor Charter is
guidance for how the Conductor may use them; it is not an executable route.

The selected task template is a default seed, not the final authority. A research template may seed one Researcher and one Reviewer, but the assistant or user may change it to two independent Researcher sessions, a separate Source Reviewer, or a different provider/model combination. Multiple sessions may share the same role or display name; after creation, the runtime-generated `sessionId` is the only routing key.

Plan fields should include:

- task-level title, goal, deliverables, labels, project path, model defaults, and artifact paths,
- a Conductor session entry with provider/model/cwd and its task-owner Charter,
- worker session entries with `sessionId` seed, display name, role, provider, model, cwd, launch profile, scope/instructions, and expected outputs,
- available native Session Agent Cards and their profile configuration,
- natural-language operating guidance for Conductor, without an ordered route.

### Runtime Identity And Session Scope

Display identifiers such as `task-intake-001`, cluster names, task titles, and visible agent names are user-facing labels and audit anchors. They are not enough to route a live terminal, worker result, or Conductor tool call. Every task creation must mint a fresh runtime task identity, even when the new task has the same title, same seed template, same project, or same display id as an older task.

Runtime identity rules:

- each normalized absolute project path owns one stable `runtimeProjectId`,
- each Task Intake create/start action owns one fresh `runtimeTaskId`,
- the Task, Task Intake event, task Agent Cluster, and every planned session Agent created for that task carry the same `runtimeTaskId`,
- Workspace Session ids, PTY ids, provider adapter stores, dispatch ids, results, and `read_session` routing are scoped by `runtimeProjectId` plus `runtimeTaskId`,
- a new task must never reuse an older Conductor or worker session just because a display id, task title, template, or agent name matches,
- Workbench must not fall back to a project-default or previous-task Agent when the selected task has task-scoped Agents.

Recommended session id shape:

```text
opencode:<runtimeProjectId>:<runtimeTaskId>:<agentId>
```

The exact provider prefix may vary by adapter, but the runtime project and runtime task segments are required. Provider-native session ids remain adapter audit fields; they must not become the product routing truth.

Business orchestration belongs in the generated Conductor Charter, not in
special-purpose tool parameters or a Runtime route policy. A research Charter
may say:

```text
Use the available research, synthesis, and critique cards whenever they would
improve the answer. After each return, decide whether there is enough evidence,
whether another view would reduce uncertainty, or whether a user question
changes the work. Do not assume a fixed number, order, or re-check loop.
```

The Shell must not inject this plan into worker sessions as Agent Workspace protocol. Worker sessions receive only normal provider-native task assignments when Conductor calls `call_session`.

## Session Roles

### Conductor

Conductor is a task-owner agent. It is allowed to use Agent Workspace MCP tools because its job is orchestration.

Conductor responsibilities:

- understand the task goal and current context,
- use the confirmed Task intent, Charter, and available Session Agent Cards as
  context for its own decision,
- decide which target session should act,
- send concise session-level assignments to delegated sessions,
- read delegated session outputs from Shell-owned session stores,
- continue or redirect a delegated session when the next action is obvious,
- ask the user when product, permission, or risk decisions are required,
- synthesize worker results into task-state summaries and next-step decisions,
- delegate artifact, code, report, spec, plan, and review-note changes to the responsible worker session,
- state delivery readiness with its own recorded rationale and available evidence.

Conductor must not personally create, rewrite, or edit worker-owned deliverables. If a Researcher report, review, QA result, or user follow-up changes the task, Conductor decides whether another `call_session` assignment is useful and which approved card should receive it. Conductor may write short coordination notes or status summaries in its own terminal, but those notes are not the task deliverable unless a task template explicitly defines a Conductor-owned summary artifact.

### Delegated Sessions

Delegated sessions are plain provider-native sessions. A delegated session can be backed by opencode, Claude Code, Codex, or another CLI/provider. It receives a normal task assignment and owns its internal execution strategy.

Delegated session responsibilities:

- receive normal task messages through their terminal,
- use provider-native tools, subagents, permissions, and UI,
- produce artifacts, code edits, reports, tests, or review notes,
- wait for user/provider prompts as normal.

Delegated sessions must not be required to:

- load Agent Workspace MCP tools,
- know about Workspace Session routing,
- emit custom structured handoff messages,
- call `report_result`,
- call `send_conductor`,
- obey a task-specific Agent Workspace system prompt.

Provider-native subagents remain internal to the current provider session. If an opencode session receives a `call_session` assignment, it may call opencode subagents internally. If a Claude Code session receives a `call_session` assignment, it may use Claude Code-native mechanisms internally. Agent Workspace should not model those internal subagents as separate Workspace Sessions unless the task explicitly requires separate session state, project path, provider, model, permission scope, or UI visibility.

## Conductor MCP Tools

The first Conductor MCP should be small and explicit.

### `call_session`

Send a large, session-level assignment to another provider session. This is asynchronous.

If the target session is not running, Shell starts it as a plain provider-native PTY using the task template's target launch profile, waits until the provider terminal can receive input, then writes the normal assignment text. `call_session` returns success only after Shell has confirmed delivery to the target provider session. For opencode, delivery confirmation means the provider adapter can find the exact `[Agent Workspace] Dispatch ID <dispatchId>` marker in opencode's structured session database for the target workspace after the dispatch was created. If Shell cannot start the target session or cannot confirm delivery before the delivery timeout, it returns a structured failure and records the reason in the Session Store.

`call_session` is a pure dispatch tool. It does not own loop progression, does not decide when Conductor should run again, and does not wait for the target session result. Runtime wakeup and loop scheduling are separate Task Runtime responsibilities. The assignment body should include the full context needed for that session turn, such as the full Reviewer text when routing a fix, but the tool input must remain generic and must not grow business-specific fields such as `review_result`, `fix_dispatch`, or `required_next_action`.

Shell generates one communication identifier for each dispatch: `dispatchId`. It is a six-character uppercase hex code, unique within the runtime task, generated by Shell/backend code rather than by the model. The same `dispatchId` is carried in the worker assignment, task/session events, provider-extracted `messages.jsonl`, worker `results.jsonl`, `read_task_state`, `read_session`, and runtime wakeups. There is no separate `displayKey` or `dispatchKey`. Provider ids remain adapter audit fields only; they are not Agent Workspace routing keys.

A successful `call_session` is asynchronous; it is not a forced Conductor turn
boundary. The Conductor may issue further independent dispatches, read durable
state, or choose to end its decision turn. It must not synchronously wait for
or infer the in-progress target result. A later provider-derived fact wakes
Conductor with the relevant context.

Input:

```json
{
  "taskId": "task-123",
  "toSessionId": "task-123-researcher",
  "assignment": "Research Claude Dynamic Workflow mechanics and save findings to docs/research/...",
  "contextRefs": ["docs/research/session-communication-mechanisms-2026-06-28.zh.md"],
  "expectedOutput": "Markdown research note with evidence links",
  "priority": "normal"
}
```

Output:

```json
{
  "ok": true,
  "dispatchId": "A1B2C3",
  "taskId": "task-123",
  "toSessionId": "task-123-researcher",
  "status": "delivered",
  "deliveryState": "delivered",
  "targetSessionState": "delivered_pending",
  "resultState": "pending",
  "async": true,
  "nextAllowedAction": "dispatch_more_or_end_decision_turn",
  "cannotReadResultUntil": "provider_result_available",
  "message": "Assignment delivered asynchronously. You may dispatch other bounded work or end this decision turn; wait for a Runtime wakeup before treating this target result as available."
}
```

Failure output:

```json
{
  "ok": false,
  "dispatchId": "A1B2C3",
  "taskId": "task-123",
  "toSessionId": "task-123-researcher",
  "status": "failed",
  "deliveryState": "failed",
  "targetSessionState": "not_started",
  "resultState": "none",
  "turnPolicy": "recover_or_stop",
  "errorCode": "target_session_start_failed",
  "message": "Target session could not be started. Conductor may correct the target/config or ask the user."
}
```

`call_session` must not wait for the target session to finish. A successful `delivered` result only means the assignment has reached the target provider session and has been recorded by the provider adapter's delivery-confirmation path. The target session may take seconds, minutes, or longer; it may also use its own provider-native subagents, tools, permission flows, and iteration controls.

A later failed dispatch does not necessarily make the worker session permanently unavailable. If the same session has retained result context from an earlier dispatch and no active queued/delivered dispatch remains, Shell may treat the composite `delivery_failed` + result state as a retry candidate. The retry still follows the normal `call_session` delivery path: the target provider terminal must be input-ready, the assignment must be written as a normal dispatch, and the provider adapter must confirm the new dispatch marker before Shell records `delivered`.

User-visible recovery controls must be state-derived and use Shell-owned dispatch records. When a user selects retry, stop-then-retry, restart-fresh-then-retry, or force-retry, Shell should reuse the unresolved failed dispatch assignment and call `call_session` again instead of asking the user or Conductor to paste hidden protocol text. Stop/restart/force actions require confirmation and must be recorded as `user.intervention` runtime evidence. Restarting a fresh provider session must not erase historical Session Store evidence.

The Conductor may use several ordinary `call_session` calls for parallel
fan-out. A later batch helper may improve efficiency, but it must only combine
Conductor-authored dispatch requests; it must not become a Shell-side template
step that chooses agents or execution order.

Conductor must not synchronously poll, repeatedly read, or block on the just-dispatched session result. When the provider adapter later records a new result, blocked state, timeout, permission request, scheduled trigger, review failure, or other decision point, Task Runtime may start a new Conductor turn with a plain-text wake message. For provider-result wakeups, that wake message includes the full provider-extracted `answerText` for the matching `dispatchId`; Runtime must not silently truncate this answer body.

### `read_task_state`

Read the task-level runtime summary: session states, dispatch delivery/result states, provider-extracted results, permission signals, artifacts, and pending decision points.

Input:

```json
{
  "taskId": "task-123",
  "sinceCursor": 42
}
```

Output:

```json
{
  "taskId": "task-123",
  "cursor": 57,
  "sessions": [
    {
      "sessionId": "task-123-researcher",
      "state": "result_available",
      "cursor": 57,
      "lastStateSummary": "Provider result available."
    }
  ],
  "dispatches": [
    {
      "dispatchId": "A1B2C3",
      "toSessionId": "task-123-researcher",
      "status": "result_available",
      "resultId": "result-A1B2C3"
    }
  ],
  "results": [
    {
      "resultId": "result-A1B2C3",
      "dispatchId": "A1B2C3",
      "sessionId": "task-123-researcher",
      "answerPreview": "Worker's completed assistant answer for dispatch A1B2C3..."
    }
  ],
  "pendingDecisions": [
    {
      "type": "worker_result_available",
      "dispatchId": "A1B2C3",
      "sessionId": "task-123-researcher",
      "resultId": "result-A1B2C3"
    }
  ]
}
```

Conductor should use `read_task_state` at the start of a Runtime-triggered turn. It should then call `read_session` only for the specific worker result or state that needs detailed inspection.

### `read_session`

Read Shell-owned worker session state, compact events, dispatch records, and provider-extracted results.

Input:

```json
{
  "taskId": "task-123",
  "sessionId": "task-123-researcher",
  "sinceCursor": 42,
  "maxChars": 12000
}
```

Output:

```json
{
  "sessionId": "task-123-researcher",
  "state": "result_available",
  "cursor": 57,
  "cleanTranscriptTail": "",
  "events": [],
  "dispatches": [],
  "results": [
    {
      "resultId": "result-A1B2C3",
      "dispatchId": "A1B2C3",
      "provider": "opencode",
      "providerSessionId": "ses_...",
      "providerMessageId": "msg_...",
      "answerText": "Worker's completed assistant answer for the matched dispatch window, without reasoning/tool UI text.",
      "source": "opencode-message-parts"
    }
  ],
  "artifacts": []
}
```

The source Conductor reads is the Shell-owned Session Store, not the frontend terminal DOM. Shell may populate `messages[]` and `results[]` from provider-specific adapters such as opencode session `message`/`part` storage. In that case, the provider adapter must extract the completed assistant answer for the matched dispatch window and must not use raw terminal transcript text as the answer body.

`messages[]` is the task-level provider answer store. Each record is a full provider answer message with `taskId`, `sessionId`, `dispatchId`, provider ids, and full answer text. `results[]` is a compact per-worker dispatch-result index that uses the same `dispatchId`. Conductor and UI correlate messages, results, events, and wakeups by `dispatchId` only.

## Shell Session Store

Shell must continuously record session data for every PTY it owns:

```text
.agent-workspace/runtime/<task-id>/sessions/<session-id>/
  events.jsonl
  dispatches.jsonl      # lazy-created when the session receives a dispatch
  results.jsonl         # lazy-created dispatch-result index
  permissions.jsonl     # lazy-created when a permission event exists
  artifacts.jsonl       # lazy-created when an artifact is registered
  state.json
.agent-workspace/runtime/<task-id>/events.jsonl
.agent-workspace/runtime/<task-id>/messages.jsonl
```

`read_session` reads from this store.
`read_task_state` reads from the task-level event index and per-session files to produce a compact task summary.
Raw provider PTY output is not persisted as Agent Workspace communication evidence. The workbench UI may display bounded live PTY output from the manager, but Conductor tools must not use terminal transcript text as the communication source of truth. Empty JSONL files must not be pre-created; stores are created only when they contain records.

The store owns:

- status events,
- latest state,
- dispatch linkage,
- provider-extracted answer messages and dispatch-result indexes,
- permission and waiting-input signals.

Status events are transition records. Repeated samples of the same state must update `state.json` only and must not append duplicate `session.blocked`, `session.waiting`, `session.timeout`, or similar events.

Provider processes are execution surfaces. Provider-native session stores may be adapter inputs, but Shell Session Store remains the durable Agent Workspace communication record.

### Provider Result Extraction

For providers that expose structured session storage, Shell should prefer a provider adapter over terminal transcript parsing.

For opencode, the adapter reads opencode's local session database and extracts:

- the provider session that received the `call_session` assignment by matching the target Workspace Session, exact Agent Workspace assignment marker containing the six-character `dispatchId`, and dispatch creation/message time,
- the first completed assistant message after that assignment and before the next Agent Workspace assignment marker in the same provider session,
- the selected assistant message must contain non-empty `text` parts and have a provider `step-finish` part with `reason: "stop"`,
- no `reasoning`, `tool`, TUI, or terminal control content,
- provider ids (`providerSessionId`, `providerMessageId`, provider step-finish id) for adapter audit and debugging.

After extraction, Shell writes the full answer to task-level `messages.jsonl` with the matching `dispatchId`, then marks the session dispatch result available by writing a compact result index to the worker session's `results.jsonl`. The same `dispatchId` travels with both records so a timeline can show every session answer in global order and prove which `call_session` assignment produced it.

The latest terminal screen may be used only for UI display and coarse attention signals. It is not persisted as a terminal transcript artifact, it is not the source of truth for worker final answers, and it must not make a dispatch `result_available` without a completed provider result.

PTY output is only a dirty trigger. When a worker PTY writes data, Shell may debounce and ask the provider adapter whether a completed provider turn exists for any delivered dispatch. If the dispatch already has a result recorded for its `dispatchId`, Shell must treat later terminal repaint noise as irrelevant and must not request another Runtime-triggered Conductor turn for the same dispatch.

The adapter must not select the latest assistant answer in the provider session globally. A single opencode session can receive multiple Agent Workspace assignments over time; choosing "latest" can attribute a later dispatch result to an earlier dispatch. The valid result window is:

```text
matched Agent Workspace assignment marker for dispatchId
  -> first completed assistant stop answer
  -> stop before the next Agent Workspace assignment marker
```

## Status Monitoring

Shell monitors PTY lifecycle and provider-adapter signals. The monitor does not judge task quality and does not infer completion from business text or terminal idle alone.

Detailed PTY-trigger and provider-state rules are defined in `docs/superworks/spec/provider-session-state-detection.md`. In short: PTY output is only a dirty trigger; provider adapters determine provider turn state; Session Store records compact Workspace state transitions and provider-extracted results.

Allowed status classes:

- `running`: process is alive and producing output or shows active work.
- `idle`: process is alive, prompt/input area is visible, and output has been quiet for a configured stability window.
- `waiting`: session appears to need input, confirmation, choice, or continuation.
- `blocked`: session shows an error, denied permission, failed startup, or unrecoverable provider state.
- `timeout`: no meaningful output or state transition occurred within the configured SLA.
- `exited`: process exited.

Status detection creates transition events. It does not send large content to Conductor and must not append repeated events for unchanged sampled state.

## Runtime-Triggered Conductor Turns

Conductor should not poll every worker aggressively and should not be treated as a daemon that permanently waits inside a terminal. Active wakeup is required for automation, but it is a Task Runtime scheduling action, not part of `call_session` semantics.

The first implementation should support these modes:

- Pull: Conductor calls `read_task_state` or `read_session` when it wants to inspect.
- Runtime-triggered Conductor turn: Task Runtime starts or resumes Conductor only when a decision point exists.
- Provider-result wakeup: Shell should only mark a dispatch result available when the relevant provider adapter has a completed result record, not merely because a terminal became idle, quiet, blocked, or exited.
- PTY data-triggered checks: Shell should inspect only the worker session that emitted PTY output, after a debounce window, instead of polling every session on every interval.

Runtime-triggered Conductor turns are used for:

- a worker dispatch has a new provider-extracted result,
- a worker is blocked, waiting for permission, timed out, or exited unexpectedly,
- a review, benchmark, test, or validation Session returned a meaningful fact,
- a schedule trigger fired, such as a daily research task,
- the user provided new input or approved a blocked decision,
- the Conductor has a pending decision from any other durable Runtime fact.

Conductor provider-result wake message shape:

```text
Runtime wakeup: Researcher result available

Task: task-123
Worker session: opencode:project-runtime-current:task-123:task-123-researcher
Dispatch ID: A1B2C3
Result ID: result-A1B2C3
Cursor: 57

Researcher answer:
<full provider-extracted answerText for dispatch A1B2C3>

Conductor: decide the next action from this worker answer. If follow-up work is needed, use call_session; do not edit worker-owned deliverables yourself.
```

The wake message is plain text, not JSON. It is written only to the Conductor session, never into worker sessions. It carries the dispatch metadata plus the matching worker result body so Conductor can make the next routing decision without guessing from terminal screenshots. `read_task_state` remains the compact summary API, and `read_session` remains the authoritative API for re-reading full stored result records.

### Loop Ownership And Stop Conditions

Runtime has no business loop-continuation or stop policy. Conductor decides
whether the Task needs another dispatch, a user question, a delivery summary,
or no further work. Provider failure and attention are durable facts, not
automatic stop or recovery routes.

A Conductor completion statement is a durable delivery claim for the user to
inspect. Runtime records it with known artifacts and provider results, but does
not judge route compliance, evidence sufficiency, review outcome, or task
correctness. The user marks the task `achieved` after inspecting the concrete
delivery.

## Runtime Injection Strategy

### Conductor

Conductor gets task-scoped runtime injection:

- Agent Workspace MCP server,
- Conductor system prompt,
- task context,
- final Task Session Plan,
- worker target allowlist derived from the final Task Session Plan,
- permission policy summary,
- user-achieved and delivery-claim semantics.

The injection must occur at process launch using provider-supported configuration or CLI flags. It must not be pasted into the terminal as the first user message.

### Worker Sessions

Worker sessions do not get Agent Workspace protocol injection.

Worker launch may still include normal provider/user-selected settings such as model, provider-native agent name, permission mode, sandbox, cwd, and project path. It must not include custom Workspace Session protocol prompts or Agent Workspace MCP tools in the first version.

## Provider Strategy

### opencode

Use opencode MCP support for Conductor tools. Prefer `OPENCODE_CONFIG_CONTENT` inline config on the Conductor process env, with config content generated from `.agent-workspace/runtime/<task-id>/conductor/`. This keeps Agent Workspace MCP and task-owner instructions process-scoped instead of writing or mutating project/global `opencode.json`.

Implementation requirement:

- before claiming Conductor system-prompt or MCP injection works for opencode, run a focused local validation that proves the Conductor process has the Agent Workspace MCP server available at first turn and that the task-owner prompt was not pasted as a user message.
- if inline config cannot enable the local MCP server for an interactive opencode TUI without modifying project/global config, the implementation must mark opencode Conductor MCP injection as blocked and keep worker sessions provider-native rather than falling back to terminal-pasted instructions.

If opencode plugin support is used, it should be Conductor-only and task-scoped where possible. A plugin may be useful for packaging prompts and MCP wiring, but MCP remains the communication boundary.

### Claude Code

Use `--mcp-config` for the Conductor MCP server and `--append-system-prompt` or a task-scoped prompt file for Conductor instructions. Use `--plugin-dir` only if packaging a reusable Agent Workspace Conductor plugin becomes simpler than passing config and prompt files directly.

Worker Claude Code sessions remain ordinary Claude Code sessions.

## Permission And Auto-Continue

Permission handling belongs to Shell policy, not worker prompts.

Conductor can request or explain permission decisions through tools, but Shell classifies risk:

- read-only status and transcript reads can be automatic,
- PTY writes to worker sessions are logged and target-checked,
- file writes, shell commands, browser actions, and destructive operations require policy classification,
- high-risk operations escalate to the user.

Auto-continue is also Shell-assisted but Conductor-decided:

- Shell detects waiting/idle.
- Conductor reads session context.
- Conductor decides whether to continue, redirect, ask user, or stop.

## Migration From Previous Session Protocol

The previous Workspace Session Message protocol is deprecated as the primary path.

Required removals in the implementation plan:

- remove protocol injection from worker sessions,
- remove worker-specific Workspace Session system prompt preview from Task Intake or relabel it as Conductor-only preview,
- remove automatic structured-message repair prompts,
- remove route behavior that depends on worker outputting custom XML/JSON,
- keep transcript parsing only as diagnostic evidence; it must not drive Agent cards, dispatch results, task state, or Conductor wakeups.

Compatibility:

- Existing `Agent` and `Workspace Session` records may remain as UI/data model terms.
- Existing Task Template worker target allowlists remain useful, but they are enforced by Conductor MCP tools and Shell Router, not by worker prompt compliance.

## Product Interaction Changes

Task Home / Task Intake:

- show Conductor runtime prompt preview,
- show Conductor MCP tools and permission scope,
- show and edit the Task Session Plan before creation,
- after creation, show a compact execution conversation backed by `read_task_state`, with `task.user_message`, `user.intervention`, `call_session` dispatch messages, runtime wakeups, and worker result messages as separate Markdown cards,
- keep raw worker and Conductor terminals as provider-native runtime/diagnostic surfaces rather than the default built Task page,
- keep the bottom Conductor composer wired to the real Conductor session for user corrections during observation; sending a correction writes to the Conductor PTY and records `user.intervention` in `.agent-workspace/runtime/<runtimeTaskId>/events.jsonl`,
- do not show worker protocol prompts.

IDE Workbench:

- Conductor terminal remains the orchestration runtime and diagnostic surface,
- worker terminals are execution surfaces,
- Shell event rail shows session status changes and dispatch history,
- `read_session` output is visible as Conductor tool result, not as hidden state.

Delivery:

- The Conductor explains its delivery-readiness judgment in its provider-native terminal.
- Runtime stores session results, artifacts, and verification evidence as facts; it never decides whether the task should take another route or become achieved.
- The user inspects the concrete deliverable and marks the task achieved, or sends a follow-up to the Conductor.

## Success Criteria

- Starting a task launches Conductor with Agent Workspace MCP tools loaded before first user turn.
- Task Draft Assistant and Task Intake can create a user-confirmed Task Session Plan, and Conductor prompt generation uses that final plan instead of only the template seed.
- Worker sessions can be started without Agent Workspace protocol injection.
- Conductor can call `call_session` and immediately receive a dispatch id.
- Shell records worker state transitions and provider-extracted results without persisting PTY transcript artifacts.
- Conductor can call `read_session` and inspect Shell-owned worker state plus provider-extracted `results[]`.
- Task Runtime can start a new Conductor turn with a plain-text wake message when a worker dispatch has a provider result or a session needs attention.
- Provider-result wakeups include the full provider-extracted `answerText` for the matching dispatch and are not JSON metadata payloads.
- Worker dispatch completion must not be inferred from terminal idle alone.
- No worker session is required to know or call Agent Workspace tools.
- No Agent Workspace system prompt is pasted into worker terminal as a user message.

# Development Process Instrumentation Spec

Date: 2026-06-29

Status: Draft for implementation planning.

Related sources:

- `docs/superworks/spec/product-interaction-map.md`
- `docs/superworks/spec/conductor-session-communication.md`
- `docs/research/session-communication-mechanisms-2026-06-28.zh.md`
- `docs/research/similar-agent-workbench-products-2026-06-29.zh.md`
- Current code references:
  - `desktop/session-store.cjs`
  - `desktop/pty-manager.cjs`
  - `desktop/conductor-tool-bridge.cjs`
  - `desktop/conductor-mcp-server.cjs`
  - `desktop/verification-runner.cjs`
  - `src/lib/auditTrail.ts`
  - `src/types.ts`

## Summary

Agent Workspace needs local-first instrumentation for the development process. The instrumentation must make task execution, Conductor routing, worker session activity, verification, Review, and failure recovery explainable without relying on raw terminal text or hidden UI state.

Instrumentation in this project means:

```text
When a meaningful state change or boundary call happens,
record a small structured event,
link it to durable evidence,
and make it queryable by task, run, session, dispatch, or review id.
```

The first version must not implement uploaded product analytics. It must record local product audit evidence and local developer trace evidence under `.agent-workspace/`.

## Goals

- Preserve a durable evidence chain for every task from intake to Review-approved Done.
- Explain what Conductor asked, which worker session received it, what Shell observed, and what Review accepted.
- Give developers a local trace path for debugging Electron, PTY, MCP, provider-state inspection, Session Store, and verification failures.
- Keep scheduler-owned state separate from agent reasoning output.
- Keep user-visible Audit Trail stable and concise while preserving lower-level trace detail for debugging.

## Non-Goals

- Do not add remote telemetry, click tracking, retention metrics, or external analytics in this spec.
- Do not infer task completion from arbitrary worker text.
- Do not make raw terminal output the only source of routing or review facts.
- Do not write runtime instrumentation into `docs/research/`, `docs/superworks/spec/`, or `docs/superworks/plans/`.
- Do not expose secrets, full environment variables, API keys, `.env` contents, or long prompt bodies in developer trace events.
- Do not let instrumentation events move task state by themselves. State transitions remain owned by the scheduler/reducer/Review flow.

## Instrumentation Layers

There are two instrumentation layers.

### Product Audit Evidence

Product audit events are user-facing or review-facing facts. They describe the workflow at a product level and are safe to show in Audit Trail, Runs, Review, Task Board, and Notifications.

Product audit answers:

- What task was created?
- Which run/session started?
- Which dispatch was created and delivered?
- Which status transition did Shell observe?
- Which verification command ran and where is the log?
- Why did Review block or approve Done?
- Where is the commit proposal or PR handoff draft?

Product audit must be durable and task-scoped.

### Developer Trace Evidence

Developer trace events are local debugging facts. They describe internal boundary calls, timings, failures, retries, and unexpected states. They are not part of the user-facing task completion proof unless they are promoted to a product audit event.

Developer trace answers:

- Did IPC receive the renderer request?
- Which PTY command and cwd were used?
- Did runtime files write successfully?
- Did MCP forward a tool call to the bridge?
- Did `call_session` fail route validation?
- Did Session Store fail to append an event?
- Did provider-state inspection fail, time out, or return an unexpected state?
- Did verification spawn, timeout, or fail to write artifacts?

Developer trace must remain local by default and should be viewable through a future diagnostics surface or by reading JSONL files.

## Event Envelope

Every structured instrumentation event should use a common envelope.

```ts
type InstrumentationEvent = {
  id: string;
  type: string;
  layer: "product-audit" | "dev-trace";
  schemaVersion: 1;
  createdAt: string;
  actor: "user" | "shell" | "conductor" | "worker" | "review" | "system";
  surface?: string;
  taskId?: string;
  runId?: string;
  sessionId?: string;
  dispatchId?: string;
  reviewId?: string;
  correlationId?: string;
  parentEventId?: string;
  status?: "started" | "succeeded" | "failed" | "blocked" | "queued" | "delivered";
  previousState?: string;
  nextState?: string;
  summary: string;
  evidencePath?: string;
  data?: Record<string, unknown>;
};
```

Rules:

- `id` must be unique inside the event store that owns it.
- `type` must be stable and namespaced, such as `task.intake.created` or `pty.spawn.failed`.
- `correlationId` links multi-step operations across IPC, bridge, PTY, Session Store, and UI.
- `parentEventId` links a lower-level trace to the higher-level product event that caused it.
- `summary` must be short and safe to display.
- `data` must be compact. Large content belongs in an artifact file referenced by `evidencePath`.
- Secret-like values must be redacted before writing.

## Storage Layout

Instrumentation is stored under `.agent-workspace/`, never in product-intent docs.

### Task Product Audit

```text
.agent-workspace/tasks/
  intake.jsonl
  <task-id>/
    events.jsonl
    artifacts/
```

Use for:

- task intake,
- task status transitions,
- task artifacts,
- Conductor auto-start evidence,
- task-level summary events.

### Runtime Session Evidence

```text
.agent-workspace/runtime/<task-id>/
  events.jsonl
  messages.jsonl          # lazy-created global provider answer messages for the task
  sessions/<session-id>/
    events.jsonl
    dispatches.jsonl      # lazy-created when dispatches exist
    results.jsonl         # lazy-created dispatch-result index
    permissions.jsonl     # lazy-created when permission events exist
    artifacts.jsonl       # lazy-created when artifacts exist
    state.json
```

Use for:

- PTY start/exit lifecycle records,
- provider-derived session state changes,
- dispatch created/delivered/failed,
- provider-extracted answer messages and dispatch-result indexes,
- provider-derived permission or waiting-input signals,

This extends the existing Shell Session Store pattern in `desktop/session-store.cjs`.

Runtime Session Evidence must not persist raw PTY transcript text, clean transcript tails, terminal snapshots, or `.agent-workspace/pty-evidence` handoff files as Agent Workspace communication evidence. Terminal output can be held in bounded live buffers for UI display. Provider-specific adapters, such as the opencode session adapter, are responsible for extracting completed worker answers into task-level `messages.jsonl`; worker `results.jsonl` stores the dispatch-result index that points to those messages.

PTY output is a trigger, not evidence and not a state classifier. A PTY data event may cause Shell to debounce and inspect the changed session through its provider adapter. For opencode, a result is valid only when the adapter finds the first completed assistant turn in the matched dispatch window with `step-finish.reason = "stop"`. Repeated PTY repaints that do not change provider-derived state must not append duplicate events, duplicate results, or request another Runtime-triggered Conductor turn. Detailed provider-state rules are defined in `docs/superworks/spec/provider-session-state-detection.md`.

### Run And Review Evidence

```text
.agent-workspace/runs/<run-id>/
  manifest.json
  terminal-events.jsonl
  verification.json
  verification.log
  runtime-policy.json
  commit-proposal.md
  redaction.json

.agent-workspace/reviews/<run-id>/
  gate-events.jsonl
  approval.json
  staging.json
```

Use for:

- AgentRun lifecycle,
- provider-state events and bounded terminal diagnostics,
- runtime policy,
- verification command result,
- staged/unstaged git scope,
- Review blocked/approved records,
- commit context and redaction evidence.

### Developer Trace

```text
.agent-workspace/dev-trace/
  YYYY-MM-DD.jsonl
  latest.jsonl
```

Use for:

- Electron IPC calls,
- native bridge calls,
- PTY spawn/write/resize/stop internals,
- MCP server and HTTP bridge internals,
- Session Store append/read failures,
- status-monitor timings,
- verification runner spawn/timeout/write failures.

`latest.jsonl` may be a copy or symlink-like rolling file if the platform supports it. If not, it can be a normal JSONL file rewritten or appended by the current desktop process.

## Product Audit Events

The following product audit events are required for the MVP execution path.

| Event type | Actor | Required ids | Evidence path | When to record |
| --- | --- | --- | --- | --- |
| `project.context.selected` | user | project id | project manifest | Project context changes |
| `task.intake.created` | user/shell | taskId | `.agent-workspace/tasks/intake.jsonl` | Task Home captures a task |
| `task.session_group.created` | shell | taskId | task session group artifact | Task creates Conductor and worker session records |
| `task.status.changed` | shell | taskId | task event stream | Task changes queued/running/waiting/pending-review/blocked/done |
| `conductor.session.started` | shell | taskId, sessionId | runtime session event stream | Shell starts task Conductor PTY |
| `runtime.injection.prepared` | shell | taskId, sessionId | injection manifest | Conductor runtime files and MCP scope are prepared |
| `conductor.tool.call.started` | conductor/shell | taskId, sessionId | runtime task events | Conductor calls Agent Workspace MCP tool |
| `conductor.tool.call.completed` | shell | taskId, sessionId | runtime task events | MCP tool returns to Conductor |
| `dispatch.created` | shell | taskId, sessionId, dispatchId | `dispatches.jsonl` | `call_session` records async dispatch |
| `dispatch.delivered` | shell | taskId, sessionId, dispatchId | `dispatches.jsonl` | Shell writes assignment to worker PTY |
| `dispatch.failed` | shell | taskId, sessionId, dispatchId | runtime task events | Route validation or worker start fails |
| `session.state.changed` | shell | taskId, sessionId | session `events.jsonl` | Provider adapter plus state reducer records a different Workspace session state |
| `session.permission.requested` | shell | taskId, sessionId | `permissions.jsonl` | Worker/Conductor needs user permission |
| `verification.started` | review/shell | taskId, runId | verification artifact | Review starts command |
| `verification.completed` | review/shell | taskId, runId | `verification.json` and `.log` | Verification exits, fails, or times out |
| `review.approval.blocked` | review | taskId, runId | gate event | Review lacks verification/redaction/scope evidence |
| `review.files.staged` | review | taskId, runId | staging artifact | User stages scoped files for proposed commit |
| `review.approved` | review/user | taskId, runId, reviewId | `approval.json` | Human approves Review and task may move Done |
| `pr.handoff.prepared` | review/shell | taskId, runId | PR handoff draft | Product prepares PR next-step context |

Product audit events must be visible through Audit Trail either directly or through derived entries. Audit Trail may summarize, filter, or group events, but must not invent completion state that is not backed by an event.

## Developer Trace Events

The following developer trace events are required for diagnosing the native/runtime path.

| Event type | Boundary | Required ids | Key data | When to record |
| --- | --- | --- | --- | --- |
| `ipc.call.started` | renderer -> Electron main | correlationId | channel, safe input shape | IPC handler starts |
| `ipc.call.completed` | renderer -> Electron main | correlationId | durationMs | IPC handler succeeds |
| `ipc.call.failed` | renderer -> Electron main | correlationId | channel, error code | IPC handler fails |
| `task_draft.spawn.started` | opencode headless | taskId?, correlationId | cwd, model | Task Draft Assistant starts |
| `task_draft.spawn.completed` | opencode headless | taskId?, correlationId | durationMs, parse status | Draft generation finishes |
| `pty.spawn.started` | PTY manager | taskId?, sessionId, correlationId | command, args hash, cwd | PTY spawn requested |
| `pty.spawn.failed` | PTY manager | taskId?, sessionId, correlationId | error code, cwd | PTY cannot start |
| `pty.write.sent` | PTY manager | taskId?, sessionId, correlationId | byte count, reason | Text written to PTY |
| `pty.resize.sent` | PTY manager | sessionId, correlationId | cols, rows | Resize sent |
| `pty.stop.requested` | PTY manager | sessionId, correlationId | reason | Stop requested |
| `runtime_files.write.started` | PTY manager | taskId?, sessionId | file count, root | Runtime files write begins |
| `runtime_files.write.failed` | PTY manager | taskId?, sessionId | relative path, error code | Runtime file write fails |
| `session_store.append.failed` | Session Store | taskId?, sessionId | target file, event type | Event/log append fails |
| `provider_state.inspect.started` | provider adapter | taskId?, sessionId | provider, dispatchId?, trigger | Provider state inspection starts after a PTY event or explicit runtime request |
| `provider_state.inspect.completed` | provider adapter | taskId?, sessionId | provider, dispatchId?, observed state, durationMs | Provider state inspection completes |
| `provider_state.inspect.failed` | provider adapter | taskId?, sessionId | provider, dispatchId?, error code | Provider state inspection fails |
| `mcp.server.message.received` | Conductor MCP server | sessionId?, correlationId | method, tool name | MCP JSON-RPC message arrives |
| `mcp.bridge.call.started` | MCP bridge | taskId?, sessionId?, correlationId | tool name | Bridge forwards call |
| `mcp.bridge.call.failed` | MCP bridge | taskId?, sessionId?, correlationId | tool name, error code | Bridge call fails |
| `route.validation.failed` | Conductor tool bridge | taskId, sessionId?, correlationId | caller, receiver, route reason | Route policy denies dispatch |
| `verification.spawn.started` | verification runner | taskId, runId, correlationId | command hash, cwd, timeout | Verification starts |
| `verification.spawn.failed` | verification runner | taskId, runId, correlationId | error code | Verification cannot spawn |
| `verification.timeout` | verification runner | taskId, runId, correlationId | timeoutMs | Verification times out |
| `artifact.write.failed` | shell services | taskId?, runId?, correlationId | artifact path, error code | Artifact write fails |

Developer trace events must be safe to inspect locally. They should avoid raw command bodies when command content may include secrets. Prefer command display strings already intended for UI, argument hashes, byte counts, file counts, and redacted error messages.

## Instrumentation By Surface

### Task Home / Task Board

Record product audit when:

- project context is selected,
- task draft assistant fills or patches a draft,
- task is captured,
- task session group is created,
- Conductor auto-start is requested,
- task status changes.

Record developer trace when:

- native task draft generation starts, succeeds, fails, or returns unparsable JSON,
- renderer calls native project switch, task create, or PTY start bridge,
- reducer rejects or ignores a transition.

Debug path:

- Task creation evidence: `.agent-workspace/tasks/intake.jsonl`
- Task events: `.agent-workspace/tasks/<task-id>/events.jsonl`
- Task Draft Assistant trace: `.agent-workspace/dev-trace/YYYY-MM-DD.jsonl`

### Conductor Runtime

Record product audit when:

- Conductor runtime injection is prepared,
- Conductor PTY starts,
- Conductor MCP tools are available for the session,
- Conductor calls `call_session`, `read_task_state`, or `read_session`,
- tool call completes or fails.

Record developer trace when:

- opencode/Claude Code Conductor config is built,
- MCP config path is written,
- MCP server starts handling JSON-RPC,
- bridge token or URL is missing,
- bridge HTTP call fails.

Debug path:

- Conductor session events: `.agent-workspace/runtime/<task-id>/sessions/<conductor-session-id>/events.jsonl`
- Conductor events: `.agent-workspace/runtime/<task-id>/sessions/<conductor-session-id>/events.jsonl`
- Conductor tool trace: `.agent-workspace/dev-trace/YYYY-MM-DD.jsonl`

### Worker Sessions

Record product audit when:

- worker PTY starts,
- assignment dispatch is created,
- assignment is delivered,
- worker state changes through provider-derived Workspace state,
- permission is requested,
- artifact is attached.

Record developer trace when:

- worker launch command is prepared,
- PTY spawn/write fails,
- provider-state inspection fails,
- provider-derived state changes.

Debug path:

- Worker dispatches: `.agent-workspace/runtime/<task-id>/sessions/<worker-session-id>/dispatches.jsonl`
- Worker provider result watermarks and answer text: `.agent-workspace/runtime/<task-id>/sessions/<worker-session-id>/results.jsonl`
- Worker events: `.agent-workspace/runtime/<task-id>/sessions/<worker-session-id>/events.jsonl`

### Shell Session Store

Record product audit when:

- session starts,
- state changes to a different state,
- dispatch is created/delivered/failed,
- provider result becomes available,
- task-level event index receives a compact mirrored runtime event.

Record developer trace when:

- any write to event JSONL, dispatch JSONL, result JSONL, artifact JSONL, permission JSONL, or state JSON fails,
- cursor normalization receives invalid input,
- event mirroring between session and task-level index fails.

Debug path:

- Primary source: `.agent-workspace/runtime/<task-id>/sessions/<session-id>/`
- Task-level index: `.agent-workspace/runtime/<task-id>/events.jsonl`
- Store failures: `.agent-workspace/dev-trace/YYYY-MM-DD.jsonl`

### PTY Manager

Record product audit when:

- PTY starts,
- PTY receives user or Shell input,
- PTY exits.

Record developer trace when:

- spawn command/cwd/env/runtime file setup starts,
- runtime files are written,
- process spawn fails,
- write/resize/stop is attempted against a missing session,
- stream read or event publish fails.

Debug path:

- Session evidence under `.agent-workspace/runtime/<task-id>/sessions/<session-id>/`
- Native PTY trace under `.agent-workspace/dev-trace/YYYY-MM-DD.jsonl`

### Conductor Tool Bridge / MCP Gateway

Record product audit when:

- `call_session` creates, confirms delivery, or fails dispatch,
- `read_task_state` reads the task-level runtime summary,
- `read_session` reads a worker session.

Record developer trace when:

- MCP JSON-RPC request is malformed,
- bridge authorization fails,
- tool name is unknown,
- route validation fails,
- target worker start callback fails,
- bridge returns an unexpected shape.

Debug path:

- Product event: `.agent-workspace/runtime/<task-id>/events.jsonl`
- Worker session event: `.agent-workspace/runtime/<task-id>/sessions/<session-id>/events.jsonl`
- Tool bridge trace: `.agent-workspace/dev-trace/YYYY-MM-DD.jsonl`

### Review / Verification / Commit Context

Record product audit when:

- verification command starts and completes,
- verification log/artifact is written,
- Review blocks approval,
- Review file scope changes,
- staging evidence is recorded,
- redaction scan starts/completes,
- Review is approved,
- commit proposal and PR handoff draft are created.

Record developer trace when:

- verification command spawn fails,
- command times out,
- artifact/log write fails,
- git status/diff/stage command fails,
- redaction scanner fails or cannot read transcript.

Debug path:

- Verification: `.agent-workspace/runs/<run-id>/verification.json`
- Verification log: `.agent-workspace/runs/<run-id>/verification.log`
- Review gate: `.agent-workspace/reviews/<run-id>/gate-events.jsonl`
- Approval: `.agent-workspace/reviews/<run-id>/approval.json`
- Developer failures: `.agent-workspace/dev-trace/YYYY-MM-DD.jsonl`

### Audit Trail / Runs / Notifications

Record product audit when:

- task/run/review events become visible in Audit Trail,
- notification is created,
- notification is acknowledged,
- Runs receives final task completion context.

Record developer trace when:

- Audit Trail cannot load or normalize an event,
- duplicate event ids are detected,
- evidence paths referenced by events are missing,
- notification source event cannot be resolved.

Debug path:

- Aggregated view: Audit Trail UI
- Source events: event `evidencePath`
- Normalization failures: `.agent-workspace/dev-trace/YYYY-MM-DD.jsonl`

## Query Guide For Debugging

Use this guide when debugging a task.

### "Task was created but Conductor did not start"

Check:

1. `.agent-workspace/tasks/intake.jsonl`
2. `.agent-workspace/tasks/<task-id>/events.jsonl`
3. `.agent-workspace/runtime/<task-id>/sessions/<conductor-session-id>/events.jsonl`
4. `.agent-workspace/dev-trace/YYYY-MM-DD.jsonl`

Expected product events:

- `task.intake.created`
- `task.session_group.created`
- `conductor.session.started`

Likely dev trace events:

- `ipc.call.failed`
- `pty.spawn.failed`
- `runtime_files.write.failed`

### "Conductor dispatched work but worker did nothing"

Check:

1. `.agent-workspace/runtime/<task-id>/events.jsonl`
2. `.agent-workspace/runtime/<task-id>/sessions/<worker-session-id>/dispatches.jsonl`
3. `.agent-workspace/runtime/<task-id>/sessions/<worker-session-id>/events.jsonl`
4. `.agent-workspace/dev-trace/YYYY-MM-DD.jsonl`

Expected product events:

- `conductor.tool.call.started`
- `dispatch.created`
- `dispatch.delivered` or `dispatch.failed`
- `session.state.changed`

Likely dev trace events:

- `route.validation.failed`
- `pty.spawn.failed`
- `pty.write.sent` missing or failed
- `mcp.bridge.call.failed`

### "Worker result exists but Conductor cannot see it"

Check:

1. Task-level `messages.jsonl`
2. Worker `results.jsonl`
3. Worker `dispatches.jsonl`
4. Provider adapter audit fields in `messages.jsonl` / `results.jsonl` (`providerMessageId`, `providerStepFinishId`) and the shared `dispatchId`
5. Worker `events.jsonl`
6. Task-level runtime index `.agent-workspace/runtime/<task-id>/events.jsonl`
7. Conductor tool call trace in `.agent-workspace/dev-trace/YYYY-MM-DD.jsonl`

Expected product events:

- `dispatch.result_available`
- `session.state.changed`
- `conductor.tool.call.completed` for `read_session`

Likely dev trace events:

- `session_store.append.failed`
- `mcp.bridge.call.failed`
- invalid cursor or missing session id trace

### "Task moved to pending review too early"

Check:

1. `.agent-workspace/runtime/<task-id>/events.jsonl`
2. Conductor session transcript
3. review claim artifact
4. `.agent-workspace/tasks/<task-id>/events.jsonl`

Expected product events:

- `finish.claim.created`
- `task.status.changed` to `pending-review`

Invalid pattern:

- Worker text alone causes pending review without `finish.claim.created`.

### "Review approval is blocked"

Check:

1. `.agent-workspace/reviews/<run-id>/gate-events.jsonl`
2. `.agent-workspace/runs/<run-id>/verification.json`
3. `.agent-workspace/runs/<run-id>/redaction.json`
4. `.agent-workspace/reviews/<run-id>/staging.json`

Expected product event:

- `review.approval.blocked`

The gate event should name the missing requirement: verification, redaction, or scoped files.

### "Done state looks wrong"

Check:

1. `.agent-workspace/tasks/<task-id>/events.jsonl`
2. `.agent-workspace/reviews/<run-id>/approval.json`
3. Audit Trail UI entry source evidence

Expected product events:

- `review.approved`
- `task.status.changed` to `done`

Invalid pattern:

- Run completion, terminal idle, or worker free-form "done" moves task to Done without Review approval.

## Redaction And Privacy Rules

Instrumentation must be local-first and privacy-preserving.

- Do not write API keys, tokens, cookies, `.env` values, SSH keys, or OAuth credentials into structured events.
- Do not include full prompt bodies in developer trace. Use byte count, hash, or artifact reference.
- Do not include full command arguments when they may include secrets. Use safe display strings or redacted args.
- Product audit can reference provider result artifacts but should not duplicate long terminal text.
- Dev trace may include error messages, but must redact common secret patterns before writing.
- Uploading telemetry is out of scope until a separate privacy and consent spec exists.

## UI Expectations

### Audit Trail

Audit Trail reads product audit events and derived state. It should show:

- task id,
- run id,
- session id when relevant,
- event type or kind,
- status,
- short summary,
- evidence path,
- timestamp.

It should not show every dev trace event by default.

### Runs

Runs should show:

- run manifest,
- runtime policy,
- terminal/session evidence,
- verification evidence,
- commit proposal,
- review approval,
- PR handoff draft.

Runs should link to the underlying event/artifact paths.

### Diagnostics

A future diagnostics surface may read `.agent-workspace/dev-trace/YYYY-MM-DD.jsonl` and filter by:

- correlation id,
- task id,
- session id,
- boundary,
- event type,
- failure status.

Diagnostics is a developer/debugging surface, not the main product audit surface.

## Implementation Principles

- Product audit events are part of product state. They must be schema-validated and covered by tests.
- Developer trace events are best-effort. They must never crash the main workflow if trace writing fails.
- Instrumentation writes should be append-only JSONL where possible.
- Large artifacts should be written once and referenced by path.
- Event type names should be stable. Do not rename events casually once UI/tests depend on them.
- Every state transition that matters to the user must have a product audit event.
- Every native/runtime boundary that can fail should have dev trace around start, success, and failure.
- Event correlation is required for multi-boundary flows like task create -> PTY spawn -> runtime injection -> Conductor start.

## Minimum Viable Instrumentation Scope

The first implementation should cover:

1. Task intake and task status transitions.
2. Conductor runtime injection and Conductor PTY start.
3. `call_session`, `read_task_state`, and `read_session` tool calls.
4. Worker PTY start, dispatch created/delivered/failed, provider result available, state changed.
5. Verification command start/completion and Review approval/block.
6. Dev trace for IPC, PTY spawn/write, MCP bridge, Session Store write failures, and verification failures.

Do not implement uploaded analytics, feature usage dashboards, or retention metrics in the first implementation.

## Open Questions For Implementation Plan

- Should product audit events be unified into one `event-store` module, or should existing stores keep ownership and expose a common reader?
- Should `runtime/<task-id>/events.jsonl` mirror all product audit events for the task, or only runtime/session events?
- Should `dev-trace/latest.jsonl` be process-scoped or day-scoped?
- How much of `src/lib/auditTrail.ts` should migrate from mock state aggregation to file-backed event aggregation in the native runtime path?
- How should Runtime derive a review-ready task state from Conductor terminal output, stored session results, artifacts, and verification evidence without adding a Conductor completion tool?

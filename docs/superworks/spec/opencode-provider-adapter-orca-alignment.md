# OpenCode Provider Adapter Rewrite: Orca-Aligned Contract

Date: 2026-07-27

Status: Active rework contract.

This specification supersedes the current implementation claims and migration
notes concerning the **OpenCode Provider Adapter, dispatch observation, and
Coordinator wakeup path** in:

- `orca-terminal-runtime-adoption.md`;
- `provider-session-state-detection.md`; and
- `plans/terminal-host-orca-migration-v1.plan.md`.

Those documents remain authoritative for product intent and Terminal Runtime
transport unless this document explicitly narrows or replaces a Provider
Adapter statement.

## Decision

Agent Workspace will not extend the existing Hook/Monitor implementation.
It will replace it with an OpenCode-specific, read-only Provider Observer
whose engineering pattern is taken from Orca's OpenCode SQLite session scanner.

The product has four layers with one-way responsibilities:

```text
Conductor
  reads durable semantic state and makes the next task decision
        |
Dispatch Coordinator
  persists attempts, reconciles facts, emits one durable wakeup
        |
OpenCode Provider Observer
  reads native OpenCode state and reports Provider facts only
        |
Orca-derived Terminal Runtime
  owns PTY, screen, input, stream, ACK, exit, and terminal history
```

No lower layer chooses a Session Agent, interprets the quality of an answer,
or retries task work.

## What Is Copied From Orca

This is an engineering adoption, not a copy of Orca's product UI or task
model.

| Orca implementation | Required adoption here |
| --- | --- |
| `TerminalHost` owns one live PTY, its generation, screen state, stream and exit facts. | Keep Terminal Runtime as the only PTY owner. It has no OpenCode task semantics. |
| AI Vault's OpenCode SQLite scanner opens `opencode.db` read-only, sets `PRAGMA query_only = ON`, detects schema capability, bounds queries, and runs sync SQLite reads in a worker thread. | Build the OpenCode Provider Observer with the same isolation and read-only guarantees. |
| Scanner discovery separates source discovery, list/parse operations, worker protocol, and UI presentation. | Separate database discovery, low-level reading, dispatch observation, Coordinator reconciliation, and Workbench presentation. |
| Agent Session Runtime uses idempotent operations and ownership generations. | Persist a Dispatch Attempt before launch and bind it to exact provider identities after receipt. |

Source reference, pinned for this rework:

- Orca revision: `8f5a45401fc65b4052797b43d251d44c9c691769`;
- `GITREF/orca/src/main/daemon/terminal-host.ts`;
- `GITREF/orca/src/main/ai-vault/session-scanner-opencode-sqlite.ts`;
- `GITREF/orca/src/main/ai-vault/session-scanner-opencode-sqlite-worker-entry.ts`.

## Explicit Non-Goals

- Do not expose Orca terminal RPCs such as `terminal.send`, `read`, or
  `subscribe` to Conductor.
- Do not make OpenCode's database observer a task scheduler.
- Do not require an artifact path, `expectedOutput`, Reviewer, Publisher, or
  any role order for a dispatch.
- Do not infer Provider state from terminal prose, a visible prompt, a spinner,
  elapsed time, or a renderer event.
- Do not inject `OPENCODE_CONFIG_DIR`, an Agent Workspace plugin, or a custom
  hook as a requirement for observing a normal OpenCode worker.
- Do not add Workflow/Graph behavior to Agent Loop.

Hooks may later be retained as an optional, lossy inspection accelerator. They
must never be the source of truth or the sole route by which a dispatch can
finish, fail, or wake Conductor.

## OpenCode Provider Observer

### Implementation boundary

The implementation is intentionally **OpenCode-specific**. Its public output
is provider-neutral enough to permit a future adapter, but its database
schema, discovery rules, and parser are not generalized prematurely.

Target modules:

```text
desktop/opencode/opencode-sqlite-reader-worker.cjs
desktop/opencode/opencode-sqlite-reader.cjs
desktop/opencode/opencode-provider-observer.cjs
desktop/session-wakeup-monitor.cjs (Coordinator during the staged rewrite)
```

The SQLite reader must:

1. locate configured and standard OpenCode database candidates;
2. open the selected database `readonly` and apply `PRAGMA query_only = ON`;
3. perform bounded, parameterized, schema-guarded queries in one dedicated
   Worker Thread;
4. return only cloneable typed records; and
5. make reader failure explicit instead of returning an invented Provider
   state.

### Durable identity

At `dispatch.command.accepted`, Coordinator persists a `DispatchAttempt`:

```text
taskId
workspaceSessionId
agentId
dispatchId
attemptId
terminalGeneration / incarnationId
submittedAt
launchMode: startup_prompt | live_input
assignment
resolvedContextPackets[]
```

At the first Provider receipt it adds an immutable `ProviderBinding`:

```text
provider: opencode
databaseSourceId
providerSessionId
providerUserMessageId
providerReceiptAt
```

Discovery may use the exact immutable marker
`[Agent Workspace] Dispatch ID <dispatchId>` to find the initial message.
Once the binding exists, every later observation must use the exact Provider
session and message identities. It must never use the newest message from a
matching cwd as a substitute.

### Observation contract

The Observer returns one of these facts. It does not turn a fact into a Task
decision.

```text
not_observed
receipt { providerSessionId, providerUserMessageId }
running
result { providerSessionId, providerMessageId, answerText }
attention { kind: question | permission, providerMessageId, summary }
failed { providerMessageId?, reason, detail? }
observation_unavailable { reason }
```

`answerText` is the complete provider semantic answer, not raw PTY output and
not a rewritten summary. Coordinator stores it as a Task-scoped result. A
subsequent Conductor dispatch may pass it verbatim through optional
`contextRefs`.

## Dispatch Reconciliation

The Coordinator owns durable transitions. Terminal and Provider facts are
independent inputs; neither one is silently treated as the other.

```text
dispatch.command.accepted
  -> terminal.created
  -> startup_submitted | terminal.input_accepted
  -> dispatch.provider.received
  -> provider.running
  -> provider.result | provider.attention | provider.failed

terminal.exit is an orthogonal transport fact.
```

On a terminal exit, Coordinator requests one final scoped observation rather
than waiting for a fixed timeout:

| Final facts | Durable outcome |
| --- | --- |
| No Provider receipt | `delivery_failed` with `terminal_exit_before_receipt` evidence |
| Receipt and completed result | `result_available`; result wins over exit |
| Receipt and native attention | attention remains pending; no synthetic failure |
| Receipt and Provider failure | `provider_failed` |
| Reader unavailable | `observation_unavailable`; Conductor is told the state cannot be verified |

All event writes and Conductor wakeups are idempotent by
`attemptId + provider event identity`. One new durable decision point produces
at most one wakeup.

Terminal resource capacity is a separate Coordinator concern: a persisted
dispatch can remain `queued` until a physical slot is available. It is not an
Agent Loop route, a quality gate, or a reason to select a different Agent.

## Conductor Tool Surface

Conductor has exactly four task-level tools:

```text
read_task_state
read_session
dispatch_sessions
claim_task_completion
```

`dispatch_sessions` accepts one or more independent requests:

```json
{
  "requests": [
    {
      "agentCardId": "researcher",
      "assignment": "核实 Reviewer 指出的 2026Q1 数据口径问题。",
      "contextRefs": ["result:review-42", "result:search-19"]
    }
  ]
}
```

Its immediate return only confirms a durable command (`queued` or started).
It never claims Provider delivery. `contextRefs` is optional, Task-scoped, and
causes the referenced complete result messages to be snapshotted into the new
attempt. Conductor decides whether any result is relevant; Runtime never
requires or invents a reference.

Conductor has no terminal write/read/attach tool, no retry tool, no direct
artifact validation tool, and no `mark_achieved` tool. `claim_task_completion`
creates a delivery claim; the user alone marks a Task achieved after inspecting
the actual delivery.

## Migration Plan

1. **Characterize** — add fixtures for the observed `exit(1)` before Provider
   receipt, receipt/result races, same-cwd concurrent dispatches, native
   question/permission, and DB unavailability. Freeze the old path.
2. **Port the reader** — implemented: `opencode-sqlite-reader-worker.cjs`
   uses a dedicated Worker Thread, read-only `node:sqlite`, `PRAGMA query_only`,
   schema checks, parameterized marker lookup, and bounded answer reads.
3. **Add Observer and binding** — implemented for the active Agent Loop:
   `opencode-provider-observer.cjs` derives a binding from the exact marker,
   then later reads use the persisted provider session/message identity.
4. **Replace reconciliation** — implemented in the active branch of
   `session-wakeup-monitor.cjs`: it consumes Observer facts, persists receipt,
   result, attention, Provider failure, or terminal-before-receipt delivery
   failure, and sends one semantic wakeup. The legacy Hook path remains only
   for historical non-Agent-Loop compatibility and is not wired into
   `agent-loop-v1-runtime.cjs`, `main.cjs`, or the real harness. Worker launch
   no longer injects `OPENCODE_CONFIG_DIR` or a Workspace hook.
5. **Finish Runtime recovery** — a stopped terminal must present final
   checkpoint/history rather than attempting a live attach. Resource queueing
   must be explicit and separate from task routing.
6. **Remove legacy path** — `desktop/opencode/session-adapter.cjs` is no
   longer on the active Agent Loop or real-harness path. Delete it and the
   remaining historical Hook compatibility only after unrelated legacy
   harnesses have been migrated.

## Required Harnesses

Each harness must have a terminal oracle and a semantic oracle. No assertion
may use a human-readable TUI string as semantic truth.

| Harness | Required proof |
| --- | --- |
| `desktop/opencode/opencode-provider-observer.test.mjs` | Read-only schema compatibility, same-cwd exact binding, bounded parse outcomes, Conductor startup binding. |
| `desktop/session-wakeup-monitor.test.mjs` | Exact observer result, Provider failure, and `exit(1)` before receipt becomes `delivery_failed` with one wakeup. |
| `provider-race` | Result-plus-exit records one result and one wakeup; result wins. |
| `provider-attention` | OpenCode question/permission remains native, is persisted, and wakes once without injected input. |
| `terminal-history` | An exited Session opens final history/checkpoint without `terminal_session_not_live`. |
| `agent-loop-real-deepsearch-e2e` | Generated Template, Task creation, real OpenCode DeepSearch, real Provider receipt/result, Conductor-selected semantic handoff, delivery claim, user achieved, and explicit deletion. |

### Primary Release Gate: real DeepSearch

`agent-loop-real-deepsearch-e2e` is the primary product acceptance gate for
this rewrite. It launches real normal OpenCode TUI sessions using the configured
production model; it is not a fixture, a terminal-text simulation, or a mocked
Provider response.

The harness performs this user-realistic path:

```text
one-sentence DeepSearch Template request
  -> generated editable Loop Template and saved version
  -> Task created from that version
  -> real Conductor receives the Task
  -> Conductor dispatches real native research Sessions
  -> Observer records exact OpenCode receipt and result identities
  -> Runtime wakes Conductor at semantic decision points
  -> Conductor selects complete results through contextRefs for follow-up work
  -> a real native Session produces a Markdown research delivery
  -> Conductor makes a delivery claim
  -> harness performs the user achieved and explicit deletion lifecycle
```

Run it with:

```bash
npm run desktop:agent-loop-real-deepsearch-e2e
```

It intentionally fails before creating a Task if no local OpenCode executable
is resolvable. Set `OPENCODE_PATH=/absolute/path/to/opencode` (or place it on
`PATH`) for the real gate; the default resolver also recognizes the normal
user installation at `~/.opencode/bin/opencode` and makes that directory
available to the launched native Session environment. A fixture must never
substitute for this executable check.

The test Task must be a genuine evidence-led question with a cited Markdown
conclusion. It can use an approved stable live-source set or a
release-controlled research fixture mirror when external network conditions
would make a release run non-reproducible. In either case, OpenCode itself
must do the investigation; the harness must not write the final delivery or
insert a synthetic Provider result. The acceptance gate requires one native
source/evidence result and a later native delivery result that receives
selected context; it does not prescribe a hidden count, role, or sequence of
Session Agents.

The acceptance oracle is causal, not role-shaped:

1. the Conductor has made at least one real `dispatch_sessions` decision after
   reading Task state;
2. every dispatched worker records an exact Provider receipt before its
   outcome is accepted;
3. at least one native source/evidence result is produced by a real Provider
   Session before a later dependent delivery Session;
4. at least one later Conductor dispatch contains selected full
   `contextRefs`, whose stored packets byte-for-byte equal the cited Provider
   answers;
5. the final Markdown delivery contains the task conclusion plus traceable
   source/evidence references, and was written by a native worker rather than
   Conductor or the harness;
6. a delivery claim follows a Provider wakeup, not the initial dispatch; the
   Conductor bridge rejects a claim while any dispatched native Session still
   has no Provider outcome;
7. the user-driven achieved and delete actions preserve the required
   audit records until the explicit deletion operation; and
8. no Runtime component selects a card, sends a correction, or retries task
   work without an explicit later Conductor tool call.

The Conductor Charter may ask for independent research, evidence comparison,
and a suitable synthesis. It may not prescribe a hidden role route. It is
valid for a particular run to choose a Researcher, Reviewer, Publisher, or a
single generalist card differently; the gate verifies the durable Conductor
decision event and its causal inputs rather than a hard-coded role order.

The existing `npm run desktop:agent-loop-real-review-handoff-e2e` remains a
valuable exact-context regression. It is **not** this release gate because its
test prompt intentionally requires a five-step Searcher/Reviewer/Publisher
sequence. That proves handoff transport, not Agent Loop autonomy.

## Completion Gate

This rewrite is complete only when:

1. an OpenCode dispatch is not called delivered until the exact Provider
   receipt is persisted;
2. every exit-before-receipt becomes a durable, visible decision point rather
   than a stranded `input_accepted` dispatch;
3. no production correctness path depends on an injected OpenCode hook,
   renderer terminal text, or a fixed semantic timeout;
4. Conductor can read and transfer full result messages without terminal
   transcript replay; and
5. all required harnesses, including the real DeepSearch release gate, pass.

## Verification Record

Implementation verification on 2026-07-27:

- local OpenCode resolver selected `~/.opencode/bin/opencode` (version 1.18.7)
  and injected that resolved directory only into native Session launch
  environments;
- `npm run desktop:agent-loop-real-deepsearch-e2e` — passed using that native
  binary. The generated Template produced real Researcher and Publisher
  Sessions; the Publisher received the Researcher’s complete Provider answer
  through a persisted `contextRefs` packet, wrote `deepsearch-report.md`, and
  the harness performed the achieved/delete lifecycle on its temporary Task.

The standard checks were re-run after this control-plane change:

- `npm test` — 111 files / 794 tests passed;
- `npm run build` — passed (Vite emitted only its existing chunk-size warning);
- `npm run desktop:orca-terminal-provider-coordinator-harness` — passed;
- `npm run desktop:agent-loop-control-plane-harness` — passed, including
  rejection of a premature delivery claim until the continuation has a
  Provider result; and
- `npm run desktop:agent-loop-ui-smoke` — passed, including the achieved →
  re-run → Runtime-only deletion lifecycle.

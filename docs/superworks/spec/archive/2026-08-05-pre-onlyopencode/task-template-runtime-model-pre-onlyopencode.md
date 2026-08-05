# Task, Template, And Runtime Model: Agent Loop v1

Date: 2026-07-26

Status: Accepted current data and lifecycle contract.

## Purpose

This document defines the durable objects that connect user intent to the
native Agent Loop Runtime. It removes a recurring confusion:

> Agent Loop is a session-management orchestration policy. Workflow is a
> graph-execution policy. They are both reusable template families, but only
> Agent Loop is implemented or selectable today.

Workflow vocabulary remains a future compatibility boundary only. It must not
be introduced into the v1 UI, persistence schema, terminal tabs, or Conductor
prompt as a hidden route. Agent Loop Template cannot be serialized as a Workflow graph.

## Durable Objects

| Object | Owner | Meaning |
| --- | --- | --- |
| Template Design Draft | Template Design service | editable working copy of a Template Version; it is not reusable until explicitly saved |
| Template Design Session | Template Design service + OpenCode Server | one non-Task Provider Session that continuously edits one Template Design Draft through scoped design tools |
| Loop Template identity | Template store | stable id plus mutable archive metadata |
| Loop Template Version | Template store | immutable versioned Charter, Agent Cards, and defaults |
| Task Architecture | Task store | task-owned snapshot of one saved Loop Template Version |
| Task | Task store | user-visible work item and lifecycle owner |
| Task Run | Runtime store | fresh realization of one Task Architecture |
| Session | Terminal Runtime | logical provider-native execution identity with current PTY incarnation |
| Dispatch | Coordinator | immutable Conductor command plus transport/provider receipts |
| Provider Result | Provider Adapter | exact semantic result/attention/failure associated with a dispatch |
| Artifact reference | Runtime index | safe task-relative file confirmed to exist before user inspection |

Template creation belongs to **Template Builder**, not the Task dialog. A
Task dialog may link to Template Builder, but cannot silently create a reusable
Template through an incomplete Task form.

## Template Draft And Version

```text
natural-language Charter brief or manual editor
  -> Template Draft
  -> user review/edit
  -> explicit save
  -> immutable Loop Template Version
```

A generated or manual Draft is not task execution. It creates no Task, Run,
Task Session, Dispatch, or artifact. A Draft may bind one persistent
**Template Design Session** so the user can continue a Meta Agent conversation
while editing it. That Provider Session is scoped to Template-Draft read/patch
tools only: it cannot create a Task, mutate a saved Version, or infer that a
Draft should be saved. Explicit user Save is the only operation that turns the
current Draft into an immutable Loop Template Version.

A Loop Template Version contains:

- Conductor role, model, and one editable Charter. The Charter captures the
  Template's suitable task context, collaboration intent, and decision
  preferences; it is snapshotted and supplied to each Conductor incarnation
  as dynamic orchestration context;
- native Session Agent Cards, each with an identity, display name, model, and
  optional MCP/Skills configuration. New Cards keep two deliberately separate
  prompt fields: a **dispatch profile** that is visible only to the Conductor
  when it chooses work, and a **worker system prompt** injected only into the
  selected Card's Provider Session. Per-dispatch assignment, inputs, and
  acceptance criteria remain a Conductor decision. Historical combined Cards
  retain their original behavior until explicitly upgraded;
- default concurrency / dispatch bounds;
- no required delivery path or output kind. Legacy path data is retained only
  as a passive lookup candidate for an already existing project file; it is not
  supplied to Conductor and never becomes a Runtime route or completion
  condition.

It cannot contain graph nodes, edges, declared role order, fixed worker count,
remediation chain, retry route, dispatch prerequisite, or automatic achieved
rule. A Charter may recommend review, evidence collection, or publication, but
every next dispatch remains the Conductor's decision. Empty MCP/Skill lists
mean the native provider capabilities are unrestricted by the Template.

Version operations are explicit: save an edited version, copy, archive, and
delete an unreferenced identity. Archiving hides normal selection but never
changes existing Task Architecture snapshots. Delete is rejected once a Task
references the Template.

Archive metadata belongs to Template identity, not a version body. The current
tables reflect that boundary: `agent_loop_templates` stores identity metadata,
while `agent_loop_template_versions` stores immutable reusable definitions.

## Task Architecture And Task Run

```text
saved Loop Template Version + user title/goal + selected writable project root
  -> confirm Task Architecture snapshot
  -> queued Task
  -> explicit Start
  -> fresh Task Run + logical Conductor Session
```

The Task Architecture records Template id/version, copied Charter, copied
Agent Cards, the user-selected project
`cwd`, and user goal. Native Sessions, relative artifacts, and Session Store
metadata are rooted at that `cwd`; the global Task list does not change this
ownership. Later Template edits cannot change the snapshot. A separate Start action begins runtime execution.

Every Start of a distinct Task creates a fresh Task Run and fresh logical
Session identities. It must not reuse another Task's terminal, dispatch,
Provider context, result, artifact index, or layout state, even when the new
Task deliberately selects the same project `cwd`. A resumed run attaches to
its own existing logical Sessions through the Terminal Runtime's claim/attach
protocol.

Stopping a Task ends the current Run's native Sessions but preserves its
history. The later **restart** action creates a new Run and new Conductor
identity; it does not ask OpenCode to resume an old provider Session. A desktop
process restart is distinct: Runtime may reconnect to a still-live Terminal
Host for the same Run, but it must not silently replace a missing native Session
with a new Run. A missing Conductor terminal puts the Run into explicit
`recovery_required`; Send/Runtime wakeup may recover a new terminal incarnation
inside the same Run only when it can continue the exact Provider Session.
Otherwise the user uses Stop and Start to create a fresh Run. A Task-page
follow-up remains pending until an exact Provider receipt is observed. The
human-facing contract is defined in
`task-run-continuity-and-terminal-experience.md`.

Every Task and Run carries an optimistic `revision`. User commands carry both
`commandId` and `expectedRevision`. The Task/Run Repository commits command
intent, lifecycle mutation, Run event, and Timeline outbox in one SQLite
transaction. Cross-store Timeline publication is retried and deduplicated by
the outbox `sourceEventId`; the Session Store copy is a projection, not a
second Task lifecycle writer.

Start, Stop and Delete are two-phase lifecycle commands: their durable command
becomes `prepared` before a native Session or Runtime-directory side effect.
Runtime construction reconciles any prepared command after a Main-process
restart. Delete removes the replay-safe Runtime directory before committing
the Task DB deletion, so a filesystem failure leaves a visible, retryable
`deleting` Task instead of an orphaned Session Store directory. Delivery Claim
uses the same Task/Run transaction and outbox; the Conductor bridge never
writes a parallel completion state.

Run detail is a rebuildable `TaskRunReadModel`. Runtime gathers Task/Run,
Coordinator, Terminal, and Provider facts through owner-scoped capabilities,
then passes them to a pure projector. Projection may filter facts to the
current Run and synthesize an unsaved default layout, but it must not write a
store, acknowledge input, repair lifecycle state, or launch a Session.
Renderer caches this model only as presentation state and refreshes it from
command results or semantic Runtime invalidations, not polling or PTY output.

## Agent Loop Control Cycle

```text
user message or start
  -> Conductor reads durable Task state
  -> Conductor may dispatch zero or more approved cards
  -> Coordinator records dispatch/Provider facts
  -> meaningful result, failure, attention, or user message wakes Conductor
  -> Conductor chooses the next action
```

Only Conductor receives Workspace dispatch tools. A native worker can use
normal OpenCode tools but cannot route another Workspace Session.

The Coordinator can transfer a completed result when Conductor explicitly
cites it through a task-scoped result reference. It snapshots the exact
semantic answer into the next dispatch record; it does not expose raw PTY
output or let workers communicate directly.

## States And Completion

| Entity | States / meaning |
| --- | --- |
| Task | `queued`, `running`, `delivery_ready`, `stopping`, `stopped`, `deleting`, `achieved`, `archived` |
| Run | `running`, `recovery_required`, `stopped`, `achieved`, or `failed` |
| Dispatch | `queued`, `input_accepted`, `delivered`, `result_available`, `waiting_input`, `cancellation_requested`, `cancelled`, `cancel_failed`, `failed` |
| Session | separate Terminal lifecycle and Provider semantic facts, plus a rebuildable presentation state |

`delivery_ready` is Conductor's recorded delivery claim, not a quality verdict.
`achieved` is an explicit user action after accepting the current delivery; an
artifact is optional supporting evidence, not a requirement. Neither a file,
a worker's “done”, nor raw terminal text can make a Task achieved.

`stopping` and `deleting` are durable command-in-progress projections used to
serialize destructive lifecycle work. They are not completion states and do
not permit Task continuation. Code must use the canonical state model instead
of creating additional free-form status strings.

Achieving a Task records accepted delivery; it does not discard its accepted
Run's exact Conductor Provider Session binding. `拉回继续` is an explicit user
command that may transition the achieved Task and its achieved Run back to
running only after Runtime proves that exact Provider Session can be resumed.
It then continues the same Run and Provider conversation. If that proof is
unavailable, the achieved Task remains immutable history and the product may
offer an explicit `基于历史新建 Task` action. That action creates a new Task and
therefore a fresh Run; a shared `cwd` is never a reason to reuse Task/Run or
Provider identity.

If legacy path data names a relative artifact, Runtime resolves it from the
Task project root only after the file exists. `.agent-workspace/` is Runtime
metadata and is never an artifact root. This passive lookup does not enter the
Conductor prompt or a worker dispatch.

## Future Workflow Boundary

A future Workflow Template may be a persisted graph-execution policy. It will
be introduced only under a separate specification and migration. It must be a
single Execution Unit from the perspective of an outer Agent Loop and it must
not give Runtime a reason to turn Agent Card labels into a route.

If introduced, A Workflow aggregate never masquerades as a PTY-owning Session.
It may expose graph state and child native Sessions, but has no terminal of its
own. Until then, v1 stores no Workflow Template, Blueprint composition, Graph
layout, or Workflow Instance.

The term **Template Blueprint** is retained only for migration/readability: it
described an old composition of multiple template families. It is not a v1
persisted object or user-facing selection surface.

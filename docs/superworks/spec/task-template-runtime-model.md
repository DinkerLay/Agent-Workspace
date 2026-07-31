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
| Template Draft | user/editor | generated or manual, editable and not yet reusable |
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

A generated or manual Draft is not task execution. It creates no Run, native
Session, terminal, Provider Session, dispatch, or artifact.

A Loop Template Version contains:

- Conductor role, model, and one editable Charter. The Charter captures the
  Template's suitable task context, collaboration intent, and decision
  preferences; it is snapshotted and supplied to each Conductor incarnation
  as dynamic orchestration context;
- native Session Agent Cards, each with an identity, display name, capability
  guidance, model, optional MCP/Skills configuration, and default output
  guidance;
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

Every start creates a fresh Task Run and fresh logical Session identities. It
must not reuse another Task's terminal, dispatch, Provider context, result,
artifact index, or layout state. A resumed run attaches to its own existing
logical Sessions through the Terminal Runtime's claim/attach protocol.

Stopping a Task ends the current Run's native Sessions but preserves its
history. The later **restart** action creates a new Run and new Conductor
identity; it does not ask OpenCode to resume an old provider Session. A desktop
process restart is distinct: Runtime may reconnect to a still-live Terminal
Host for the same Run, but it must not silently replace a missing native Session
with a new Run or a replacement terminal. A missing Conductor terminal puts
the Run into explicit recovery: first attempt exact reattach, then let the user
choose provider-native resume when provable, recovery with a new Conductor
incarnation in the same Run, or a fresh new Run. A Task-page follow-up remains
pending until one of those actions yields an exact delivery receipt. The
human-facing contract is defined in
`task-run-continuity-and-terminal-experience.md`.

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
| Task | `queued`, `running`, `delivery_ready`, `stopped`, `achieved`, `archived` |
| Run | delivery lifecycle plus control state: `active`, `recovery_required`, `stopped`, or `failed` |
| Dispatch | `queued`, `input_accepted`, `delivered`, `result_available`, `waiting_input`, `cancellation_requested`, `cancelled`, `cancel_failed`, `failed` |
| Session | Runtime transport lifecycle plus Provider-derived semantic state |

`delivery_ready` is Conductor's recorded delivery claim, not a quality verdict.
`achieved` is an explicit user action after accepting the current delivery; an
artifact is optional supporting evidence, not a requirement. Neither a file,
a worker's “done”, nor raw terminal text can make a Task achieved.

An achieved Task's later follow-up explicitly creates a new Run with preserved
Task history as context. It does not pretend that the accepted Run's old native
provider Session is still a continuation target.

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

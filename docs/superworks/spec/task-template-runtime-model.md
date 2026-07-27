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
| Artifact reference | Runtime index | safe task-relative path declared or discovered for user inspection |

Template creation belongs to **Template Builder**, not the Task dialog. A
Task dialog may link to Template Builder, but cannot silently create a reusable
Template through an incomplete Task form.

## Template Draft And Version

```text
description or manual editor
  -> Template Draft
  -> user review/edit
  -> explicit save
  -> immutable Loop Template Version
```

A generated or manual Draft is not task execution. It creates no Run, native
Session, terminal, Provider Session, dispatch, or artifact.

A Loop Template Version contains:

- Conductor role, model, and editable Charter;
- native Session Agent Cards, each with an identity, display name, capability
  guidance, model, optional MCP/Skills configuration, and default output
  guidance;
- default concurrency / dispatch bounds;
- optional delivery preference (a path or output kind), which is advice to
  Conductor and never a Runtime route or completion condition.

It cannot contain graph nodes, edges, declared role order, fixed worker count,
review gate, remediation chain, retry route, or automatic achieved rule. Empty
MCP/Skill lists mean the native provider capabilities are unrestricted by the
Template.

Version operations are explicit: save an edited version, copy, archive, and
delete an unreferenced identity. Archiving hides normal selection but never
changes existing Task Architecture snapshots. Delete is rejected once a Task
references the Template.

## Task Architecture And Task Run

```text
saved Loop Template Version + user title/goal
  -> confirm Task Architecture snapshot
  -> queued Task
  -> explicit Start
  -> fresh Task Run + logical Conductor Session
```

The Task Architecture records Template id/version, copied Charter, copied
Agent Cards, project cwd, user goal, and delivery preference. Later Template
edits cannot change it. A separate Start action begins runtime execution.

Every start creates a fresh Task Run and fresh logical Session identities. It
must not reuse another Task's terminal, dispatch, Provider context, result,
artifact index, or layout state. A resumed run attaches to its own existing
logical Sessions through the Terminal Runtime's claim/attach protocol.

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
| Task | `queued`, `running`, `delivery_ready`, `achieved`, `archived` |
| Run | `running`, `delivery_ready`, `achieved` |
| Dispatch | `queued`, `input_accepted`, `delivered`, `result_available`, `waiting_input`, `failed` |
| Session | Runtime transport lifecycle plus Provider-derived semantic state |

`delivery_ready` is Conductor's recorded delivery claim, not a quality verdict.
`achieved` is an explicit user action after inspecting the actual artifact.
Neither the presence of a file, a worker's “done”, nor raw terminal text can
make a Task achieved.

When a Template declares a relative artifact preference, it is resolved from
the Task project root. `.agent-workspace/` is Runtime metadata and is never an
artifact root. The Conductor includes that project root in any bounded
artifact-producing dispatch so the indexed file is the file the user can open.

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

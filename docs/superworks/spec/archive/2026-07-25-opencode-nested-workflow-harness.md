# Historical: OpenCode Nested Workflow Harness: Dynamic Agent Loop

Date: 2026-07-25

Status: Superseded on 2026-07-26. Retained as historical implementation
evidence only. The active product is Agent Loop v1: see
`../agent-loop-v1.md`, `../agent-loop-conductor-guidance.md`, and
`../orca-terminal-runtime-adoption.md`. This document must not be used to
restore Workflow/Graph into the live UI or runtime path.

## Purpose

This is the first runnable proof that Agent Workspace has one shared Session
Runtime, a real Agent Loop, a distinct Workflow runner, and connected Task,
Template, and Workbench surfaces. It intentionally supports **OpenCode only**.
It is not a generic workflow product or a provider matrix.

The Harness also supports a constrained Template Builder. OpenCode may propose
a Template Draft from a one-sentence description, or a user may construct one
manually. Runtime validates it before an explicit save creates a reusable
Template Blueprint. It is not an unbounded natural-language-to-execution path.

## Seeded Templates

The Runtime seeds and persists two versioned templates.

| Template | Family | Version | Meaning |
| --- | --- | --- | --- |
| `opencode-agent-loop-v1` | `agent_loop` | 1 | A Conductor owns the task mainline. The bounded Workflow returns as one execution unit; every later corrective or verification Session return wakes Conductor before another action is chosen. |
| `opencode-research-verify-workflow-v1` | `workflow` | 1 | `research` OpenCode node -> `verify` OpenCode node -> final return. |
| `opencode-research-verify-blueprint-v1` | `blueprint` | 1 | User-facing composition that references the two versions above. |

The Blueprint records the immutable references. The saved Agent Loop also
records its bounded Workflow provenance for Runtime execution. Blueprint is a
user-facing composition layer, not a third hybrid runtime family.

## Template Builder Drafts

Template Builder can ask OpenCode to propose one Agent Loop policy and one
nested Workflow graph from a short description. It can also create the same
Draft shape from the hand-built Loop policy plus manually added Workflow nodes
and dependencies.

```text
description
  -> OpenCode planner (no PTY, no Task Run)
manual Builder input
  -> Runtime schema validation (no provider call, no PTY, no Task Run)
  -> Runtime JSON/schema validation
  -> generated/manual Template Draft
  -> explicit "save Template Blueprint"
  -> two immutable Template Versions
  -> one immutable Template Blueprint Version
  -> selectable during Task Assembly
```

The generator is deliberately constrained:

- it returns an Agent Loop name and Conductor role, never Loop graph edges;
- it returns a Workflow with two to six unique, acyclic nodes;
- dependencies may only reference an earlier declared node;
- the final Workflow node must be a `verify` node;
- every Workflow node maps to exactly one Runtime-managed OpenCode Session. A
  node may not spawn, dispatch, or wait for further agents;
- when a request needs independent workers, the Draft must model them as
  separate ready nodes. Runtime may start up to two such nodes concurrently;
- Runtime rebuilds the Loop policy as `workflow.completed | workflow.failed |
  session.completed | session.failed | session.attention -> Conductor`;
- the Conductor can choose exactly one next action per decision: start the
  bounded Workflow, dispatch one affected Session, request a focused
  verification, deliver, or block. Runtime never silently batches corrective
  dispatches;
- the draft is rejected if OpenCode emits prose, invalid JSON, cycles, invalid
  dependencies, or an attempt to encode the Agent Loop as a graph;
- an invalid provider response may be retried once, but no invalid draft is
  persisted or executed.

Creating a Draft does not create a PTY, provider Session, Task, Task Run, or
Workflow Instance. Saving a Draft stores two versioned component templates and
their Blueprint. Task Assembly only selects a saved Blueprint; a separate Task
confirmation and Start action remain required before Runtime execution.

## Durable Objects

All objects below are stored in the Runtime SQLite store. Task Timeline events
remain append-only evidence in the existing Session Store and reference these
ids.

| Object | Required state |
| --- | --- |
| Template Version | id, family, version, definition, created/updated timestamps |
| Template Blueprint | id, version, name/description/source, immutable Agent Loop and Workflow references |
| Task Architecture | task id, task intent, selected Agent Loop version, nested Workflow provenance, approved OpenCode Session Plan, Markdown evidence paths, and an optional final-deliverable contract |
| Task Run | run id, architecture id, status, started/finished timestamps |
| Agent Loop Instance | id, Task Run id, phase, Conductor Session ids, nested Workflow Instance id |
| Workflow Instance | id, parent Agent Loop id, Workflow template provenance, status, input/output refs |
| Workflow Node | instance id, node id, kind, dependency ids, status, Session id, terminal incarnation, output reference |

The only valid workflow node states are `pending`, `running`, `succeeded`,
`failed`, and `blocked`. A node owns a Session reference, never a PTY.

## Runtime Sequence

```text
user starts confirmed Harness Task
  -> Runtime creates Task Run + Agent Loop Instance
  -> Runtime starts OpenCode Conductor (initial decision)
  -> durable conductor.decision
  -> Conductor chooses `launch_workflow`
  -> Runtime instantiates nested Workflow
  -> research node starts an OpenCode one-shot Session
  -> durable workflow.node.succeeded
  -> verify node starts an OpenCode one-shot Session
  -> durable workflow.node.succeeded
  -> durable workflow.completed (single return boundary)
  -> Runtime starts/wakes OpenCode Conductor (workflow return decision)
  -> durable conductor.decision: dispatch one Loop Session | verify | deliver | block
  -> dispatched evidence-repair, re-verification, or Publisher Session returns durable evidence
  -> Runtime wakes Conductor again
  -> Conductor decides whether to dispatch one further Session, verify, deliver,
     or block
  -> only verified artifacts move the Task Run to delivery_ready
```

The Workflow runner does not create a Conductor wakeup after `research`.
Only `workflow.completed`, an explicit declared exception, or final failure may
return control to the Agent Loop. On that return, the Conductor receives the
verifier output plus Runtime-observed artifact changes and selects the next
validated action. A `dispatch` action carries one concrete assignment to the
Agent Loop role that owns the affected evidence or artifact. When that Session returns,
Runtime wakes Conductor again; it does not assume a batch of fixes or start
verification on its own. `verify` is likewise a Conductor decision, not a
human Review task. A template owns a visible correction-round budget; exhausting
it is `blocked`, not a wall clock timeout. `delivery_ready` requires a PASS
verifier result and every required Runtime-observed deliverable when the task
requests a file. The person looks at those actual artifacts and may explicitly
mark the Task `achieved`, but is never asked to manually relay ordinary
verifier findings back to agents.

### Artifact ownership

Workflow evidence and final delivery have different, enforceable contracts:

| Runtime role | May write | Must not write |
| --- | --- | --- |
| Workflow search / synthesis / verify node | its exact `evidence/<task-id>/<node-id>.md` Markdown file | HTML, a webpage, or the final deliverable |
| Conductor-dispatched evidence repair Session | its assigned Markdown evidence file | HTML or another role's final file |
| Conductor-dispatched Publisher Session | the exact `deliverables/<task-id>/<name>.<ext>` final path | research evidence or unrelated project files |

When a task asks for HTML, Runtime records a Publisher Loop role in the
confirmed Task Architecture. After evidence passes verification, an early
Conductor `deliver` claim is normalized to one Publisher dispatch until the
declared HTML path is observed. Publisher return wakes Conductor; only then can
the run become `delivery_ready`.

## OpenCode Execution

Each Harness decision or node is a managed OpenCode Session launched through
Session Authority. The Runtime constructs the safe command itself:

```text
opencode --mini --model <approved-model> --prompt <runtime-generated-prompt>
```

The Product Plane never supplies an executable or command-line arguments. The
Runtime saves the full output in the bounded terminal buffer, extracts OpenCode
structured text when it is present and otherwise uses the clean human terminal
result after process completion, records a semantic result, and then advances
the state machine. A successful process exit alone is not a task completion
claim.

OpenCode runs in its native mini-TUI, not a JSON protocol viewer or a rendered
copy of command output. The Session Runtime keeps the PTY
writable only through its
incarnation-checked input arbiter. It installs a small, authenticated loopback
OpenCode plugin in an isolated `OPENCODE_CONFIG_DIR`; `permission.asked` and
`question.asked` become durable Task Run attention records associated with the
already-owned Session. A hook never grants permission or invents an answer.
Only an explicit response written by the person to that Session is admitted;
the next OpenCode busy event resolves the attention record. This state is not
inferred from a timeout or from terminal-text pattern matching.

## UI Contracts

### Templates

- Template Builder lists saved Template Blueprints and renders their distinct
  Agent Loop policy and Workflow graph components.
- A description mode generates a visible constrained Draft; a manual mode has
  a real node palette/drop area and dependency inputs. Both save through the
  same Runtime validation path.
- Saving creates immutable component versions plus a Blueprint version; editing
  never changes a Task Architecture already confirmed from an older version.

### Tasks

- The user can create a Harness Task from an already saved Blueprint, confirm
  its architecture, and explicitly start its Run.
- The Task Timeline is a compact conversation, not a low-level event list:
  user Task input, Conductor Markdown plan, the exact Workflow inputs that
  Runtime dispatches, Session Markdown returns, every Conductor wakeup/next
  decision, and the final delivery summary.
- Runtime discovers changed files from a before/after workspace snapshot. The
  Timeline renders those files as clickable artifact evidence; it never trusts
  an agent's prose claim that a file exists. Markdown artifacts and Session
  answers render CommonMark plus GFM tables.
- Any Conductor or Session message with a Session reference opens that exact
  Task Run Session in Workbench.
- `delivery_ready` is not a completion label. After file inspection the person
  may mark the Task `achieved`. Achieved Tasks remain history; archive and
  permanent deletion are separate confirmed operations and never automatic.

### Workbench

- Selecting the Harness Task Run separates Conductor decisions,
  Conductor-dispatched Loop Sessions, and the autonomous Workflow aggregate
  with only its child node Sessions. A Workflow node is never shown as a peer
  Agent Loop decision.
- Selecting a Session directly shows its real OpenCode PTY. There is no
  duplicate Runtime Activity projection or alternate Raw Terminal tab. Normal
  orchestration input remains Runtime-arbitrated; when OpenCode raises a
  permission/question hook, Workbench shows a compact attention card above the
  same PTY and lets the person send an explicit response to that Session. It
  does not render a deceptive universal "allow" button. Selecting the Workflow
  aggregate displays graph progress and no fake terminal.
- A return action opens the semantic Task Timeline for the same Task Run.
- A failed aggregate must lead with the failed node and real exit/failure
  evidence,
  and a direct action to open that node's Session. It must not show a large
  decorative graph before the failure explanation.

### Browser and Desktop Surface

The default renderer is always the Harness surface, whether it is loaded in a
browser or Electron. Browser mode is intentionally read-only: it shows the
same Task, Template, and Workbench layout for visual/debug validation, but it
does not fabricate templates, Tasks, runs, artifacts, or terminal output.
Creating templates or Tasks, starting a Run, and attaching a PTY require the
Electron native Runtime bridge. The former Prototype can only be opened with
the explicit `?surface=legacy` diagnostic URL; bridge detection must never
choose a different product surface.

## Acceptance

1. No PTY is spawned while merely viewing or saving a Template.
2. Starting one Harness Task creates fresh Task Run, Agent Loop, Workflow, and
   Session identities.
3. `research` and `verify` execute as real local OpenCode processes.
4. No Conductor wake event occurs between `research` and `verify`.
5. The Workflow final event wakes a real OpenCode Conductor Session.
6. Task Timeline links open the correct selected Workbench Session or Workflow
   aggregate.
7. A verifier finding that can be repaired creates a durable Conductor
   `dispatch` decision for one affected Session. Its result wakes Conductor;
   only a subsequent Conductor `verify` decision starts a fresh verification
   Session. The person never relays routine findings.
8. Only a PASS verifier result plus every required Runtime-observed artifact becomes
   `delivery_ready`, never `done`; only an explicit person action after file
   inspection becomes `achieved`; an exhausted correction budget or an
   unrecoverable Workflow failure becomes `blocked` and points to its failed
   Session.
9. Generated and manual Drafts are visibly distinct from a saved Blueprint and
   cannot start execution until they have been explicitly saved, selected in
   Task Assembly, and confirmed as a Task Architecture.
10. A provider permission/question becomes a durable, authenticated Session
    attention record, appears in both Task Timeline and the selected Workbench
    Session, and writes only an explicit response through the active PTY's
    incarnation-checked input arbiter. The Runtime never uses a timeout or an
    automatic approval as a substitute for provider state.

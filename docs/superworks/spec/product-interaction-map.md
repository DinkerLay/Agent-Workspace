# Product Interaction Map: Agent Loop v1

Date: 2026-07-26

Status: Accepted current interaction contract.

Agent Loop v1 deliberately has no Workflow or Graph page. A user creates or
selects a reusable Loop Template, confirms a Task, and uses the Task Timeline
and terminal Workbench for two different kinds of information.

## Surface Responsibilities

| Surface | Primary job | May write | Must not do |
| --- | --- | --- | --- |
| Task Assembly | turn user intent into a Task using a saved Loop Template | new Task and immutable Template snapshot | start a PTY while drafting |
| Templates | generate, edit, version, copy, archive, or delete Loop Templates | editable Drafts and saved Template versions | show live execution as template state |
| Tasks | manage Tasks and show their semantic event projection | user follow-up, start request, achieved action | render raw terminal transport as conversation |
| Workbench | inspect an active Task Run's native Session terminals | user terminal input, temporary tabs/groups/layout | decide routing, approve a native permission, or alter task semantics |

Project context scopes all pages; a project task list is not a permanent
Workbench sidebar.

## Template Creation And Reuse

```text
one-sentence description
  -> OpenCode proposes an editable Loop Template Draft
  -> user edits Charter and Agent Cards
  -> explicit save creates Template Version N
  -> Task Assembly selects Version N
```

Manual construction follows the same save path. A generated Draft is not an
execution request, does not create a Session, and is never saved implicitly.

The editor shows only:

- Conductor role, model, and editable Charter;
- native Session Agent Cards: name, capability guidance, model, optional MCP,
  optional Skills, and default output guidance;
- concurrency defaults and optional per-card output guidance.

It does not offer a Graph canvas, route edges, mandatory reviewer/publisher
sequence, or automatic repair rule. A card being visible does not launch it.

## Task Timeline

Tasks is the primary product page. Each Task shows title, goal, Template
provenance, current status, and a causal semantic event projection:

```text
user task / user follow-up
  -> Conductor decision
  -> dispatch command and input receipt
  -> Provider receipt / result / failure / attention
  -> Runtime wakeup
  -> next Conductor decision
  -> delivery claim and user achieved action
```

Timeline cards are normal Markdown where the content is semantic text. They
can link to a Session, an exact result, or a discovered artifact. Raw terminals do not appear as the primary task conversation.

The task-level composer is the default Task-continuation surface. When the
current Conductor terminal is live, it sends a new durable
`task.user_message` to that exact current native Session. For example,
“compare this with ChatGPT Codex rather than GitHub Codex” becomes a new
decision input; the user does not rewrite a worker's task or type a Workspace
protocol into an OpenCode terminal. When the exact terminal is unavailable,
the composer presents explicit reconnect/recovery choices and preserves the
message as pending; it cannot silently create a replacement Conductor. Stop,
connection status, pending-state explanation, and Send live together in this
composer. See `task-run-continuity-and-terminal-experience.md`.

When a native worker asks a question or asks for permission, Tasks displays a
clear attention card with “open its terminal”. It does not fake a modal answer
or make the Runtime auto-approve. The selected native terminal remains the
place where the user answers the provider.

## Artifact And Completion

Provider answers may name artifacts. Runtime indexes only task-relative files
it has verified to exist through a safe reference, so the user can open
Markdown, HTML, and other safe text artifacts from the Timeline. It never
renders a missing path as an expected artifact or Task state. Markdown is
rendered with GFM, including tables; source is available as a secondary view.

`delivery_ready` means Conductor made a delivery claim. `achieved` is an
explicit user action after accepting that current delivery; a file may be one
form of evidence but is not a prerequisite. Achieving a Task preserves its Run,
event stream, and files. Archiving/deleting Task-associated data is a separate
later confirmed action.

## Workbench

Workbench is a dense, terminal-first **Task Run workspace**.

- Task Run tabs are temporary open context. Closing a tab only removes it from
  the visible strip; it does not stop native Sessions or delete the Run. Tasks
  can reopen any Task's latest Run, which restores the persisted layout.
- One Task Run starts with a Conductor terminal Group. A Session tab appears
  only after Conductor dispatches it and Runtime has durable Session evidence.
  All other Agent Cards remain Template metadata.
- Newly materialized concurrent Sessions automatically receive separate usable
  Groups until viewport capacity is reached (at most four default panes);
  remaining Sessions enter tabs. This is a display allocator only: it neither
  starts nor dispatches a Session and never steals terminal focus.
- Each Group owns a tab strip and one selected native terminal. Users may move
  started Sessions between Groups and split left/right or top/bottom. Manual
  layout persists for the Run and is an override of automatic placement;
  splits are UI-only and never dispatch or start an agent.
- A new pane is refused below the terminal minimum usable bounds. Narrow
  panes remain tabs rather than shrinking an OpenCode TUI into unreadable
  columns. A Group can be closed/merged, moving its visible Session tabs to a
  remaining Group.
- Per-Group terminal zoom controls and shortcuts change the density and cause
  a new PTY resize. Normal buffer scrollback belongs to xterm; an OpenCode
  alternate-screen TUI keeps its own native wheel behavior. Both wheel/trackpad
  interaction and text selection/copy must work in the terminal viewport;
  semantic history remains in Tasks.
- The selected Session can expose compact transport diagnostics, Timeline, and
  artifacts in drawers. These are not a second permanent activity panel.

A Workflow aggregate has no PTY. Workflow itself is deferred in v1, so no
aggregate is rendered in navigation or Workbench; that rule prevents a future
graph unit from masquerading as a native Session terminal.

## Routes

```text
Templates -> save a Loop Template -> Task Assembly
Task Assembly -> confirm Task -> Tasks Timeline
Tasks Timeline -> start Run -> Workbench
Tasks Timeline -> open result/artifact -> preview
Tasks Timeline -> open Session -> Workbench selected tab
Workbench -> Timeline/artifact drawers -> Tasks semantic context
```

Every route preserves the Task and Run identity. Browser preview is explicitly
read-only; Template/Task/Run mutations and native PTY attach occur only in the
Electron application.

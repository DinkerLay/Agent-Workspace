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

The Conductor's official OpenCode Session page is the default Task-continuation
surface. The Task page hosts exactly one selected official Session page at a
time; it is the Conductor by default. For example, “compare this with ChatGPT
Codex rather than GitHub Codex” becomes a new decision input in that exact
Provider Session; the user does not rewrite a worker's task or type a Workspace
protocol into a replacement chat. The Provider Adapter records the
corresponding Provider fact and Task/Run service projects it into the Timeline.

When a Session asks a question or permission, Tasks displays a clear attention
entry that selects that exact official Session page. It does not fake a modal
answer or make the Runtime auto-approve. The official Provider page remains
the place where the user answers the provider.

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

## Task Session workspace

The Task page is the **Task Run workspace**. It has one primary Conductor
canvas and a resizable Task Session directory; there are no terminal Groups or
parallel custom chat panes.

- A Task Run has one Conductor Agent Session and zero or more Agent Sessions.
  The Conductor Session is the Task owner and default selected page.
- A Template Agent Card is a capability definition, not a live Session. Its
  first dispatch lazily creates one Agent Session in the current Task Run;
  later calls reuse that exact Agent Session. Each call is a separate
  Invocation/Dispatch, not a second Session.
- Every materialized Session uses OpenCode's official `build` agent. A Card's
  type, role, model, instructions, declared MCP/Skills scope, and expected
  output are stable Session context; they never create a custom OpenCode
  provider-agent profile. Project-level OpenCode configuration remains the
  only place that can install an MCP server, Skill, or plugin.
- Only the Conductor Session receives the Agent Workspace control-plane MCP
  capability. This is a Runtime boundary enforced by Session/request policy,
  not an Agent Card type; every worker remains an ordinary `build` Session.
- The directory displays the Conductor and every Task-scoped Agent Card with
  card type, model, current dispatch/provider state, and attention. A card
  without a durable Provider binding remains visible as `未派发` but cannot
  masquerade as an OpenCode page.
- Selecting a materialized Session replaces the single official OpenCode Web
  UI page in the primary canvas. No hidden iframe or independent polling loop
  is kept for inactive Sessions.
- The Task list and Task Session directory have draggable, bounded widths. A
  pointer move updates only CSS geometry; the resulting width is persisted
  once for the current Run on pointer release. The centre canvas receives all
  remaining width and has a minimum readable bound.
- A later Task Run receives new Session identities. Historical Runs remain
  inspectable through Task history but never appear in the current Run's
  directory.

## Routes

```text
Templates -> save a Loop Template -> Task Assembly
Task Assembly -> confirm Task -> Tasks Timeline
Tasks Timeline -> start Run -> Conductor official Session page
Tasks Timeline -> open result/artifact -> preview
Tasks Timeline -> select Task Session -> exact official Session page
Task Session directory -> Timeline/artifact drawers -> Tasks semantic context
```

Every route preserves the Task and Run identity. Browser preview is explicitly
read-only; Template/Task/Run mutations occur only through the protected
Runtime bridge.

# Agent Loop v1: Conductor-Controlled Native Sessions

Date: 2026-07-25

Status: Accepted implementation scope.

## Scope

Agent Loop v1 is the only active orchestration mode. Workflow/Graph is deferred
and must not appear in Task Assembly, Templates, Tasks, or Workbench.

There is one Execution Runtime. It owns Session identity, launch profiles, PTY
authority, native-provider state inspection, event persistence, and wakeup
delivery. It never decides the next task action.

> **Conductor-autonomy clarification (2026-07-26):**
> [`agent-loop-conductor-guidance.md`](agent-loop-conductor-guidance.md)
> supersedes former language that made reviewer, publisher, artifact, or
> evidence state into Runtime routing gates. Agent Loop Templates guide the
> Conductor through prompts; they do not compile a hidden Workflow.

## Control Contract

```text
Task starts
  -> one logical Conductor session receives the Task and its Loop Template
  -> Conductor dispatches zero or more approved Session Agents
  -> Runtime launches/delivers to those native OpenCode Sessions asynchronously
  -> meaningful worker state becomes a durable Runtime event
  -> Runtime wakes the idle Conductor with a compact inbox notification
  -> Conductor reads durable state and chooses the next dispatch or closeout
```

Every worker Session Agent is controlled by the Conductor. A worker never
selects another Workspace Session, manages Runtime state, loads Agent Workspace
MCP tools, or needs to emit a custom handoff protocol. It is a normal native
OpenCode session and may use its own provider-native tools and subagents.

The Conductor addresses an Agent Card only by its immutable Template `agentId`.
The Runtime resolves that id to the current physical Workspace Session at
dispatch time and keeps physical/provider identifiers inside Runtime storage.
Conductor tool responses and wakeups must expose `agentId`, never a PTY or
provider Session id.

Conductor is also native OpenCode, but is given the task-scoped MCP bridge and
the task-owner system instructions. Its persistent logical session is resumed
through Runtime wakeups; the Runtime must not create a competing scheduler
decision or parse raw terminal text as a result.

Raw PTY data only debounces provider inspection. Runtime wakes Conductor on a
provider-derived result, blocked state, attention, explicit user intervention,
or a Runtime-observed artifact condition. It does not wake on every terminal
chunk.

### State ownership and Workbench updates

Terminal liveness and a Session's semantic assignment outcome are distinct
facts and must remain visible as such:

| Fact | Owner | Examples |
| --- | --- | --- |
| Terminal lifecycle | Orca-derived Terminal Host | `live`, `stopping`, `stopped`, `not_started` |
| Dispatch/provider lifecycle | Coordinator + Provider Adapter | `queued`, `input_accepted`, `delivered`, `result_available`, `provider_failed` |
| Conductor availability | Provider Adapter | `deciding`, `waiting_conductor`, `waiting_input` |
| Task delivery lifecycle | Conductor claim and User action | `running`, `delivery_ready`, `achieved` |

A native OpenCode TUI can remain `live` after its Provider result is
`result_available`; that does **not** make its assignment `running` again.
The Workbench shows active dispatches and live PTYs as separate counts and
shows both facts on each Session tab.

The Renderer receives a lightweight durable-state invalidation and re-reads
the Task Run. It never consumes raw PTY bytes as a Task update signal. A
status-independent recovery poll is permitted only to recover an invalidation
missed during renderer reload; it cannot stop merely because a delivery claim
was recorded.

The Workbench may expose the selected Session's bounded raw PTY tail as a
**terminal diagnostics** drawer. It is scoped by Task and registered Session,
is not Markdown or Timeline content, and never becomes Conductor input or a
state-transition signal. This preserves an inspectable transport record for a
full-screen native TUI without pretending alternate-screen output is shell
scrollback.

For a newly created Worker, its first bounded contract is supplied through
OpenCode's normal launch `--prompt`, so a blank interactive TUI cannot lose a
paste during boot. For a live Worker, later contracts enter the same native
Session through the Terminal Host's serialized input authority. In both paths,
the Provider Adapter—not the fact that bytes were written—confirms delivery
and derives the next semantic state.

When a native worker exposes a provider question or permission/attention
state, Runtime records `waiting_input`, wakes Conductor once with the semantic
attention, and leaves the actual question in that Session's native terminal.
Conductor may dispatch a correction or direct the user to answer there; it does
not impersonate terminal input. A pending native question is not a failure,
delivery claim, or `achieved` transition; Task and Run remain `running` until
the native Session receives the user's response and Provider state changes.

## Loop Template

A saved Loop Template is versioned and has no graph, nodes, or edges.

| Field | Meaning |
| --- | --- |
| Conductor | role, OpenCode model, and editable task-owner Charter injected into every Conductor incarnation |
| Agent cards | reusable native-worker profile: identity, model, MCP, Skills, capability description, and default assignment/output guidance |
| Card responsibility | an optional `researcher`, `publisher`, `reviewer`, or `general` label for Conductor context and UI readability; it is not a routing or completion rule |
| Defaults | `opencode-go/deepseek-v4-flash`; empty MCP/Skill allowlists mean all provider-native capabilities are permitted |
| Return policy | semantic worker results, failure, attention, and user intervention wake Conductor |
| Delivery preferences | expected artifact and verification context for Conductor reasoning; never Runtime dispatch prerequisites |

Template generation may suggest a Publisher or Reviewer card when that suits
the described work, but cannot make either card an owner, prerequisite, or
next-step target. A Reviewer `needs_changes` result is a durable fact that
wakes Conductor; Runtime neither selects a repair target nor requires a
re-check. Conductor decides whether to dispatch a Searcher, Publisher,
Reviewer, another card, or ask the user.

Template CRUD is explicit:

- create from a description or a manual Loop Template editor;
- edit creates a new immutable version;
- historical templates remain readable and Task-eligible after their Charter
  and cards are normalized; a delivery path is only a Conductor preference,
  never an owner, route, or eligibility gate;
- copy creates a new template identity;
- archive hides it from normal Task Assembly but preserves Task provenance;
- permanent delete is allowed only when no Task Architecture references it.

An Agent card's non-empty MCP/Skill lists configure the native Session profile
selected by Conductor. They do not inject Agent Workspace MCP or a Workspace
system prompt into a worker, and they do not become a business-routing policy.
Empty lists deliberately mean that every provider-native MCP or Skill already
available to the project is allowed.

## Task and Completion

A Task stores an immutable snapshot of the selected Loop Template and its Agent
cards. It may be `queued`, `running`, `delivery_ready`, `achieved`, `blocked`,
or `archived`.

`achieved` is a user action after Runtime-observed delivery evidence is
available. It preserves the Task Run, Sessions, timeline, and artifacts. It
does not archive or delete any files. Archive/delete are separate confirmed
operations.

A Conductor delivery claim changes the Task to `delivery_ready`, but does not
close the logical Run, detach/kill a PTY, suppress Provider events, or prevent
a later explicit Conductor dispatch. If the Conductor later dispatches again,
the Task returns to `running`; Runtime never decides whether that continuation
was needed.

## UI

- Templates shows Loop Templates and their Session Agent cards; it has no
  Graph editor.
- Tasks shows a causal conversation: user task, Conductor decision, dispatch,
  worker return, Runtime wakeup, final artifact and achieved action.
- Workbench is a **Task Run terminal workspace**, not a permanent list of
  Template Agent cards. It has Task Run tabs across the top; switching a tab
  changes only the active Run workspace.
- Each Task Run persists a recursive **Group Layout Tree**. A leaf Group owns
  a tab strip of already-started native Sessions and one terminal viewport.
  Groups may split left/right or top/bottom; split ratios, focused Group,
  active Session tab, and Session-to-Group placement are Run-owned state.
  Moving or splitting a tab is a view operation only: it never launches a
  process or makes a Conductor dispatch.
- A new Run starts with the Conductor in its primary Group. A Template Agent
  card becomes visible as a Session tab only after the Conductor has actually
  dispatched it and Runtime has durable Session, dispatch, result, or PTY
  evidence. Unstarted cards remain on the Template/Task Architecture surfaces.
- Native terminal views are stably mounted by Session and positioned over their
  current Group body, so a tab move or Group split does not recreate the
  OpenCode TUI. The app viewport is fixed; terminal scrollback belongs to the
  xterm viewport only. Hidden tabs stay attached to the Terminal Host but do
  not reflow on every divider drag; they fit when made visible again.
- A Group defaults to a compact 11px terminal density and provides per-Group
  8–18px zoom (`⌘-` / `⌘+`). A split is refused below 520px wide or 250px high
  per resulting terminal pane; a persisted layout that becomes too small
  collapses into tabs without stopping or restarting any Session.
- Normal terminal buffer scrollback belongs to the host/renderer xterm buffer
  (5,000 rows in both places). An OpenCode full-screen alternate buffer is not
  faked as scrollback: its wheel input stays native to the TUI, while semantic
  history belongs in Timeline. The host keeps a bounded 8MiB raw terminal log
  per Session for recovery/diagnostic use, separately from semantic events.
- Timeline and artifacts are temporary Workbench drawers, not a permanent
  inspector. Provider-native questions and permission prompts remain inside
  the owning OpenCode terminal; its Session tab receives attention state.
  Workbench has no Workflow aggregate surface.

## Deferred

Workflow/Graph is a later optional `WorkflowUnit` that may be started by a
Conductor as one execution unit. It remains out of the v1 data model, UI, and
default runtime path until Agent Loop dispatch/wakeup/recovery is proven end to
end.

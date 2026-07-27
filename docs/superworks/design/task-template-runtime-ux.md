# Task-Template Runtime UX Reference

Date: 2026-07-24

Status: Design reference for the desktop mock.

Related active specs:

- ../spec/task-template-runtime-model.md
- ../spec/product-interaction-map.md

## Design Principle

The product should read as a compact native desktop engineering tool, not a
generic dashboard. There are four distinct product surfaces. They share
chrome, typography, color semantics, and task-run identity, but their primary
canvas must differ.

| Surface | Primary visual object | Default question it answers |
| --- | --- | --- |
| Task Assembly | architecture proposal | What will this task be allowed to run? |
| Templates | policy editor or graph editor | What reusable execution recipe do I have or need to create? |
| Tasks | semantic message timeline | What has happened, what returned, and what decision is next? |
| Workbench | session runtime and terminals | Which Session is running and what is its provider-native diagnostic state? |

Dark and light themes must have equal information density. UI chrome is 10–12
px; task titles and primary content are 12–14 px. Rounded cards are reserved
for focused controls, not used as the page's overall layout.

## Shared Desktop Chrome

- native title bar with traffic lights;
- workspace switcher, command search, compact local-runtime indicator;
- narrow activity rail: Assemble, Templates, Tasks, Workbench;
- no permanent tree of project tasks;
- task identity appears only as a selected Task or Task Run context;
- compact footer shows workspace path, branch, local state.

## Task Assembly

Task Assembly is a staged builder, not a loose prompt box.

### Layout

- left: task intent and attached context;
- center: template choice and architecture proposal;
- right: confirmation checklist and execution bounds;
- bottom: Session Plan preview and explicit Confirm architecture action.

### Required states

1. Empty intent: assistant can propose a draft but no execution controls appear.
2. Known-template selection: show type, version, parameters, and reuse notes.
3. Generated Template Draft: show origin, unsaved changes, and Save as template.
4. Architecture ready: show exactly one primary mode, session roles, routes,
   review gate, budget, and unresolved assumptions.
5. Confirmed: task becomes queued; Start run becomes available on Task detail.

### Agent Loop proposal anatomy

- Conductor responsibility;
- Session Agent role list;
- return-to-Conductor policy;
- conditions that need user escalation;
- concurrency, budget, stop, and review policy;
- explanatory control-cycle diagram labelled Policy visualization, not Graph.

### Workflow proposal anatomy

- named graph version;
- visible node/edge canvas;
- decision, exception, approval, and final node legend;
- input/output artifact contract;
- declared wake points;
- preview of Session Demands by executable node.

## Templates

Templates is a workspace library and editor. It has two visibly different
modes, selected from the library type filter.

### Shared layout

- left: versioned template library grouped by Agent Loop and Workflow;
- center: template editor;
- right: selected item inspector/version history;
- top: New template, Save version, Use in new task;
- bottom: intent-to-draft assistant input.

### Agent Loop editor

The central canvas is a policy sheet, not a DAG:

- main control-loop visualization: Conductor decision, Session Demand,
  provider result, durable return, next decision;
- role matrix with capability, profile, max concurrent, and worktree policy;
- event-return matrix with result, blocked, waiting-input, permission, and
  timeout handling;
- stop/review policy;
- no editable graph edges that pretend to choose the next Conductor action.

### Workflow editor

The central canvas is an executable graph:

- node palette and graph canvas;
- declared decision, exception, review, and final nodes;
- selected node inspector: inputs, outputs, Session Demand, retry, timeout;
- graph version and parameter schema;
- no suggestion that every node wakes Conductor.

## Tasks

Tasks is a high-density worklist plus semantic Timeline. The current
TaskBoard runtime-event projection supplies the event taxonomy and message
semantics; this design replaces its oversized panel/card composition.

### Layout

- left/center: compact task table with state, template type, next decision,
  evidence count, and update time;
- right: selected task detail with Timeline and compact task context;
- selected timeline event can open evidence or Workbench at its linked Session;
- bottom Composer: Send a semantic correction to Conductor.

### Timeline card taxonomy

| Event | Accent | Content |
| --- | --- | --- |
| User intent/intervention | amber | request and scope change |
| Conductor decision | blue | decision, rationale, next demand |
| Dispatch | neutral blue-gray | target Session and assignment summary |
| Worker result | green | durable result summary and artifacts |
| Workflow gate | violet | graph state, declared wake reason |
| Attention/failure | red or amber | blocked, permission, timeout, invalid result |
| Review | green or amber | verification and approval state |

Do not show raw terminal output, shell escape sequences, or provider TUI repaint
as Timeline content.

## Workbench

Workbench is the only terminal-forward surface. It manages the selected Task
Run rather than the whole project.

### Layout

- top: open Task Run tabs and active-run selector;
- left: Session rail limited to that run;
- center: selected Session terminal and Conductor decision/tool output;
- right: compact runtime inspector;
- bottom: event feed with dispatch, result, policy, and recovery facts.

### Selection behavior

- Conductor, worker, and test Sessions each have a provider-native terminal.
- A Workflow aggregate row has an explicit No PTY label. Selecting it replaces
  the terminal with graph status and its child Sessions.
- Workbench can navigate back to the selected task's Timeline; it must retain
  task/run focus.

## Mock Interaction Requirements

- Create a Task from intent, select a known template, generate a draft, switch
  template family, save a version, and confirm an architecture.
- Select a task and open a timeline message/return modal.
- Jump from timeline to the correct Task Run in Workbench.
- Select a worker terminal, Conductor terminal, and Workflow aggregate.
- Toggle light and dark theme.

## Visual References And Deliverable

The active visual references are deliberately separated by product surface:

- `mockups/task-assembly-v5.png`
- `mockups/templates-agent-loop-v5.png`
- `mockups/templates-workflow-v5.png`
- `mockups/tasks-timeline-v5.png`
- `mockups/workbench-session-runtime-v5.png`

The interactive desktop mock is
`public/mockups/agent-workspace-task-architecture-v5.html`. The historical
v1–v4 images remain available under `archive/2026-07-24-pre-task-architecture/`
for comparison only; they are not the active interaction reference.

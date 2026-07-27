# Product Interaction Map

Date: 2026-06-24

This spec defines the first visible product shape for the AgentsRoom-like multi-agent workbench. It is based on `docs/research/agentsroom-research-2026-06-24.zh.md` and keeps the current prototype direction: Board-first, Loop visible, IDE drill-down.

## Product Position

The product is a stateful multi-agent desktop workbench. It is not a repeated prompt loop and not only a terminal multiplexer.

The shell owns:

- project, task, run, review, commit, and restoration state,
- scheduler decisions and status transitions,
- PTY, filesystem, git, browser, notification, and store service contracts,
- durable records for prompts, transcripts, diffs, verification, and commit proposals.

Agent runtimes own:

- reasoning,
- code edits,
- tool use inside their CLI/runtime,
- explaining their output through transcript and handoff records.

## Interaction Model

Default entry is the task board. A task card shows its task state, loop, agent, run id, risk, source, and verification gate.

Primary path:

```text
Board
  -> select task
  -> inspect loop/run status
  -> Start Agent from Loop
  -> run-store creates AgentRun
  -> PTY service spawns agent session
  -> git service captures baseline
  -> git service binds branch, worktree path, and baseline manifest
  -> IDE Workbench opens current run
  -> agent claims done
  -> Review runs verification command and checks diff, transcript, commit context
  -> approval moves task to Done
  -> Runs page keeps the audit trail
```

Advanced path:

```text
Capability Map
  -> inspect product surface
  -> select a capability card
  -> read interaction path, state owner, evidence, next prototype step
  -> inspect runtime service contract
  -> drill into Teams, Browser, Libraries, Dev Terminals, Restore
  -> return to Board for task execution
```

## Product Surfaces

| Surface | Phase | Job | First prototype behavior |
| --- | --- | --- | --- |
| Projects | MVP core | Scope workspace state to a project path | Projects cockpit selects workspace context and shows project agents, tasks, runs, commands, and browser profile |
| Agents | MVP core | Represent role/provider/model/status | Projects cockpit adds agent profiles from templates; Workbench sidebar controls selected agent |
| Agent Terminal | MVP core | Run real CLI agent through PTY | Workbench starts the configured opencode command through the desktop PTY and writes composer input to that terminal |
| Runtime Policy | MVP core | Show granted permission, sandbox, effort, and CLI command for each run | Workbench shows run policy path and launch policy beside the terminal transcript |
| Provider Session State Detection | MVP core | Map provider-native session state into shell-owned Agent/task state | Workbench shows provider-derived status while PTY text stays diagnostics-only |
| Terminal Diagnostics | MVP core | Preserve bounded PTY lifecycle/output evidence | Workbench and Runs can inspect raw terminal diagnostics without using them as semantic state |
| Scratchpad / Composer | MVP core | Compose prompt before writing to PTY | Workbench composer shows draft path, autosave status, context inserts, Prompt Library save, and transcript send |
| Research / Spec / Plan Watcher | MVP core | Observe durable product-intent files and create planner tasks | Watcher page shows `docs/research/`, `docs/superworks/spec/`, and `docs/superworks/plans/` sources, watch events, evidence path, and planner task creation |
| Task Draft Assistant | MVP core | Turn one natural-language task request into a reviewed task and Session Agent Plan draft | Task Home calls opencode headless, shows assistant dialogue, and fills the editable new-task draft plus session plan before task creation |
| Task Intake | MVP core | Capture manual briefs, watcher events, screenshots, prototypes, and prompt context as executable tasks | Task Board shows intake sources, task-store event path, runtime/project config, and Conductor auto-start evidence |
| Backlog Board | MVP core | Convert plan steps into executable tasks | Kanban owns task state and review gate |
| Task Artifacts | MVP core | Attach screenshots, sketches, HTML, and prompt context to task cards | Task Board shows artifact counts and task-owned artifact paths from Workbench Scratchpad context |
| Review | MVP core | Inspect changed files by agent | Review filters files, selects scoped commit files, and gates Done |
| Commit Context | MVP core | Preserve task/run/verification context | Runs and Review show proposal metadata, selected files, and Agent-Conversation trailer |
| Run Worktree Context | MVP core | Keep branch/worktree isolation visible for each run | Workbench, Review, and Runs show branch name, worktree path, isolation policy, and baseline manifest |
| Commit Staging Evidence | MVP core | Make staged and unstaged git scope explicit before approval | Review stages selected files; Runs and Audit Trail show staged paths, unstaged paths, and staging artifact |
| Verification Command Evidence | MVP core | Preserve review-gate verification command output | Review runs the command; Runs and Audit Trail show status, log path, and artifact path |
| Review Gate Enforcement | MVP core | Block Done until required review artifacts pass | Review disables/blocks approval and records blocked gate evidence when verification or redaction is missing |
| Review Approval Evidence | MVP core | Preserve the human approval that turns a verified task into Done | Approve Review records scoped files, verification status, commit proposal path, and approval artifact |
| PR Handoff Evidence | MVP core | Prepare explicit PR next-step context without opening a PR automatically | Runs records branch, approval artifact, commit proposal path, and PR handoff draft |
| Audit Trail | MVP core | Inspect one workspace evidence chain across shell-owned events | Audit page aggregates task, loop, run, review, browser, MCP, restore, project, and watcher event streams without side effects |
| Prompt Library | MVP extension | Reuse task and agent prompts | Libraries page injects a selected prompt into the Workbench composer |
| Skills Library | MVP extension | Attach runtime-consumed skills | Libraries page records skill bindings, export targets, and runtime injection boundaries for the active task context |
| Dev Terminals | MVP extension | Manage project commands separate from agent PTY | Dev Terminals page starts/stops command sessions without creating AgentRun records |
| Teams | Advanced | Model multi-agent handoff workflows | Teams page selects workflows and advances TeamRun handoff state |
| Browser | Advanced | Verify localhost flows through project browser | Browser page selects MCP tools and records task-scoped evidence |
| MCP Gateway | Advanced | Expose safe agent-callable tools over the same domain model as the UI | MCP Gateway page shows Backlog, Terminal Commands, Prompt Library, and Browser tool surfaces with permissions and evidence |
| MCP Confirmation Evidence | Advanced | Require explicit scheduler approval or denial for confirm-class MCP tools | MCP Gateway resolves confirmation-required events and records decision evidence |
| Notifications | Advanced | Surface waiting/blocked/done states | Notifications page routes and acknowledges task-state events |
| Restore Session | Advanced | Rehydrate project/agent/process state | Restore page captures and restores a session manifest |
| Mobile Sync | Deferred | Keep mobile as a remote control boundary after desktop execution is native-backed | Capability Map records the boundary without adding a current mobile page |

## Runtime Service Contracts

The prototype should make these boundaries visible before the real desktop runtime exists:

| Contract | Scheduler owns | Agent owns |
| --- | --- | --- |
| Workspace State | selected project, visible page, task state, agent binding | status signals, progress notes, handoff summaries |
| Task Store | task id, intake source, labels, context artifact pointers, current task status, task event stream | task interpretation after run starts, progress notes emitted through run lifecycle |
| Run Store | create run ids, persist paths, status, verification evidence, commit proposal | transcript contents and task output |
| PTY Service | spawn, resize, write, stop, restore session metadata | CLI reasoning and command interaction |
| Runtime Policy | permission mode, sandbox mode, effort level, CLI command, policy artifact path | operate within granted policy after PTY spawn, request escalation through normal prompts |
| Terminal Diagnostics | bounded PTY lifecycle/output diagnostics, run-level terminal event log | raw terminal output, tool call text, file write text, completion signal text |
| Git Service | baseline, branch binding, worktree path, diff, file attribution, staged state, commit proposal, review gate block evidence, review approval evidence, PR handoff package | changed files and explanation |
| Filesystem Watch | watch docs product-intent files and create planner tasks | interpret changed files when prompted |
| Browser Service | project browser lifecycle and evidence paths | browser actions through MCP/tool calls |
| MCP Gateway | tool allowlist, permission class, project scope, confirmation decision, evidence artifact | tool call intent, arguments, and result interpretation |
| Library Store | prompt/skill scope, selected template, export target, instruction export target | runtime interpretation of prompts and skills |
| Team Scheduler | node order, handoff routing, cycle limit, run timeline | node output, handoff payload, flags |
| Notification Service | route waiting/blocked/done events | produce status signals through output |
| Client Sync Service | desktop execution authority, remote command policy, sync session scope, notification handoff | terminal response after desktop forwards prompt, status signals exposed through run records |

## Capability Drill-Down

Capability Map is not a product option picker. It is the product map for the current Board-first shell.

Each capability card must expose:

- the product surface it belongs to,
- the runtime boundary it depends on,
- the state owner,
- the evidence that proves the capability ran,
- the interaction path a user or scheduler follows,
- the next prototype step required before native implementation.

Selecting a card updates the right-side detail panel. Opening the capability jumps to the relevant product surface. This keeps the full product shape visible without promoting advanced surfaces into the MVP execution path.

Capability Coverage Matrix summarizes capability counts by phase plus runtime boundary coverage, evidence coverage, and next native step coverage. It is a read-only product completeness view inside Capability Map, not a roadmap picker or scheduler. Inspecting the matrix must not create an `AgentRun`, move task status, approve Review, or open advanced surfaces; it only helps users verify that MVP core, MVP extension, advanced, and deferred capabilities remain explicitly represented before native implementation.

Primary Interaction Backbone renders the Board -> Loop -> Run Store -> PTY/Git -> IDE -> Review -> Runs path inside Capability Map. It is a read-only explanation of page ownership, state ownership, and evidence handoff across the default product workflow. Inspecting the backbone must not create an `AgentRun`, start PTY, move task status, approve Review, or create PR handoff; concrete actions still happen only on the owning Board, Loop, Workbench, Review, and Runs surfaces.

Page Ownership Matrix summarizes each visible surface group by product role inside Capability Map. It distinguishes task ownership, scheduler ownership, run-surface ownership, review/audit ownership, context ownership, and advanced automation ownership. Inspecting the matrix must not create an `AgentRun`, start PTY, move task status, approve Review, execute MCP tools, capture browser evidence, or create PR handoff; it only explains which surface owns which responsibility and which guardrail keeps the integrated product from becoming one uncontrolled automation loop.

Interaction Route Matrix maps the main cross-page transitions inside Capability Map. It separates navigation-only drill-down, context focus, scheduler start, review approval, and audit drill-back so the integrated shell can explain which route mutates durable state and which route only changes visible context. Inspecting the route matrix must not create an `AgentRun`, start PTY, move task status, approve Review, acknowledge notifications, execute MCP tools, capture browser evidence, or create PR handoff; it only documents route intent, evidence, and guardrails before the user performs an owning-surface action.

Action Side-Effect Matrix maps the integrated product actions inside Capability Map. It distinguishes capture-only, focus-only, scheduler-start, diagnostics-inspect, provider-state evidence, review-evidence, review-approval, and PR-handoff actions so each visible control has an explicit state effect, evidence pointer, and guardrail. Inspecting the action matrix must not create an `AgentRun`, start PTY, move task status, approve Review, acknowledge notifications, execute MCP tools, capture browser evidence, prepare PR handoff, or mutate runtime evidence; it only explains what each owning-surface action is allowed to do before the user performs that action.

Durable Evidence Ledger maps shell-owned records inside Capability Map. It groups task-store, loop-schedule, run, review, context, and advanced automation records so the prototype can explain where durable evidence lives, which pages read it, and which guardrail prevents product intent files from becoming runtime state. Inspecting the ledger must not create an `AgentRun`, start PTY, move task status, approve Review, acknowledge notifications, execute MCP tools, capture browser evidence, prepare PR handoff, mutate runtime evidence, or write runtime state into product-intent files; it only documents the future `.agent-workspace/` persistence contract.

Native Runtime Readiness Matrix maps the runtime readiness path inside Capability Map. It groups Run Store, PTY, Git, Filesystem Watch, Browser/MCP, and Project/Library stores so the desktop IDE direction can replace prototype state with native services without changing the product interaction contract. Inspecting the readiness matrix must not create an `AgentRun`, start PTY, move task status, approve Review, acknowledge notifications, execute MCP tools, capture browser evidence, prepare PR handoff, mutate runtime evidence, or replace adapters at runtime; it only records which native service must preserve each existing scheduler, evidence, and review boundary.

Command Surface Matrix maps future desktop command entrypoints inside Capability Map. It separates focus-only commands, scheduler-start commands, diagnostics-inspection commands, review-gate commands, PR-handoff commands, and advanced tool commands so a later IDE command palette can reuse the same visible side-effect boundaries instead of becoming hidden automation. Inspecting the command matrix must not create an `AgentRun`, start PTY, move task status, approve Review, execute MCP tools, capture browser evidence, prepare PR handoff, mutate runtime evidence, or open a hidden command palette; it only records which owning surface each command must route through before any state-changing action happens.

Failure Recovery Matrix maps non-happy-path product states inside Capability Map. It groups runtime-start failure, failed verification, denied MCP confirmation, PTY or dev-command failure, team max-cycle block, and restore mismatch so the desktop workbench can show recovery ownership without turning failures into automatic loops. Inspecting the failure matrix must not create an `AgentRun`, start PTY, retry a command, move task status, approve Review, execute MCP tools, capture browser evidence, prepare PR handoff, mutate runtime evidence, or replay agents; it only records which surface owns the recovery decision, which evidence path explains the failure, and which guardrail prevents hidden retries or unreviewed completion.

State Lifecycle Matrix maps task, run, review, and notification states inside Capability Map. It separates queued task state, active run state, pending review claim state, failed verification state, and Review-approved Done state so Board, Workbench, Review, Runs, and Notifications share one status vocabulary without collapsing run status into task completion. Inspecting the state matrix must not create an `AgentRun`, start PTY, move task status, approve Review, acknowledge notifications, prepare PR handoff, mutate runtime evidence, or collapse run `completed` into task `done`; it only records which state family owns each transition and which evidence proves the transition.

Surface Composition Matrix maps each product page to its primary workspace, context panel, evidence rail, and primary action. It keeps Task Board, Loop Console, IDE Workbench, Review, Runs/Audit, and advanced surfaces visually coherent without turning Capability Map into a second navigation model. Inspecting the surface matrix must not create an `AgentRun`, start PTY, move task status, approve Review, acknowledge notifications, prepare PR handoff, mutate runtime evidence, inject library context, request MCP tools, or replay agents; it only documents what each page must visibly contain when the desktop IDE workbench replaces the mock runtime.

Data Model Boundary Matrix maps product objects to owned fields, reader and writer surfaces, evidence stores, and guardrails. It keeps Project context, Agent profile, Task record, AgentRun record, Review package, Task artifact, and Notification signal separate so the desktop runtime can persist each object without smearing scheduler state, agent output, review evidence, and UI focus into one store. Inspecting the data model matrix must not create an `AgentRun`, start PTY, move task status, approve Review, acknowledge notifications, prepare PR handoff, mutate runtime evidence, attach artifacts, inject library context, request MCP tools, or write runtime state into product-intent files; it only records which object owns which fields and where future `.agent-workspace/` persistence must live.

Permission Confirmation Matrix maps product actions to confirmation class, confirmation owner, evidence, and guardrails. It separates read-only inspection, focus routing, runtime launch, PTY write, Review gate, PR handoff, confirm-class MCP, advanced explicit action, and notification acknowledgement so the desktop workbench can explain consent boundaries before a user triggers a state-changing control. Inspecting the permission matrix must not create an `AgentRun`, start PTY, write to PTY, move task status, approve Review, acknowledge notifications, prepare PR handoff, execute MCP tools, capture browser evidence, start dev commands, restore sessions, mutate runtime evidence, or write runtime state into product-intent files; it only documents which visible action requires explicit user or scheduler confirmation and where the resulting evidence must be stored.

Context Propagation Matrix maps how project, task, agent, run, review, library/artifact, and notification/audit context moves across surfaces. It keeps focus propagation separate from scheduler transitions, PTY writes, Review approval, PR handoff, library injection, notification acknowledgement, and audit drill-back side effects so the desktop IDE shell can align visible panes without smuggling execution into navigation. Inspecting the context matrix must not create an `AgentRun`, start PTY, write to PTY, move task status, approve Review, acknowledge notifications, inject library context, attach artifacts, prepare PR handoff, execute MCP tools, mutate runtime evidence, or write runtime state into product-intent files; it only records which selected context is carried to which surfaces and which guardrail keeps focus changes read-only.

Product Workflow Trace maps the default end-to-end delivery path across the Board-first shell. It sequences intake capture, task focus, Loop scheduling, IDE execution, Review gate, Runs audit, and optional PR handoff so the prototype can explain the product workflow as a delivery trace rather than a collection of unrelated pages. Inspecting the workflow trace must not create an `AgentRun`, start PTY, write to PTY, move task status, approve Review, acknowledge notifications, inject library context, attach artifacts, prepare PR handoff, execute MCP tools, mutate runtime evidence, or write runtime state into product-intent files; it only shows which surface owns each step, which evidence proves the step, and which guardrail keeps the next state-changing action explicit.

Surface Control Catalog maps each major page group to its primary controls, availability state, evidence, and guardrails. It keeps Task Board, Loop Console, IDE Workbench, Review, Runs/Audit, Projects/Libraries, and advanced surface controls aligned with their owning surfaces so users can understand what each button or entrypoint is allowed to do before triggering it. Inspecting the control catalog must not create an `AgentRun`, start PTY, write to PTY, move task status, approve Review, acknowledge notifications, inject library context, attach artifacts, prepare PR handoff, execute MCP tools, capture browser evidence, start dev commands, restore sessions, mutate runtime evidence, or write runtime state into product-intent files; it only records the primary controls, the state that makes them meaningful, the evidence they create, and the guardrail that keeps empty/disabled states explicit.

Board-first Navigation Simplification reduces the visible primary navigation to four entries: Task Board, IDE Workbench, Delivery Gate, and More. It keeps Loop Console, Projects, Libraries, MCP, Browser, Teams, Dev Terminals, Notifications, Restore, Plan Watcher, Audit Trail, Runs, and Product Map available as grouped secondary entries instead of first-level navigation. The prototype uses Chinese-first UI labels while preserving Agent, Loop, Run, IDE, Review, PR, MCP, PTY, and Git as product terms. This simplification must not delete advanced surfaces, weaken the Board-first default entry, hide Review/Runs/Audit evidence, or turn More into a second product map; it only reduces first-scan complexity while keeping all designed capabilities reachable from explicit grouped entries.

Board Task Detail Progressive Disclosure keeps the default Board page focused on the task queue and a compact selected-task summary. The summary exposes task state, Loop status, Run id, Agent owner, verification, and IDE drill-down before the heavier evidence panel is opened. Opening task details must not create an `AgentRun`, start PTY, move task status, approve Review, or write runtime state; it only reveals selected task evidence, artifacts, transition audit, and explicit execution controls already owned by the Board/Loop/IDE surfaces.

## Runtime Adapter Layer

The first implementation boundary is a replaceable adapter layer. The React prototype uses mock adapters so product pages can prove the interaction model before native desktop services exist.

Current adapters:

| Adapter | Mock responsibility | Native replacement target |
| --- | --- | --- |
| Run Store Adapter | create run records, append transcript preview, attach verification evidence | persist `.agent-workspace/runs/<run-id>/` artifacts |
| Task Store Adapter | record task intake, running task cards, transition events, and task artifacts | persist `.agent-workspace/tasks/` records and event streams |
| PTY Service Adapter | spawn/write/resize/stop agent sessions in memory | desktop PTY process manager |
| Git Service Adapter | capture baseline, attribute files, build commit proposal text | local git status/diff/commit APIs |
| Filesystem Watch Adapter | classify `docs/research/`, `docs/superworks/spec/`, and `docs/superworks/plans/` changes | native watcher that creates planner tasks |

The adapter layer is intentionally not an agent runtime. It does not reason, edit code, or decide whether a task is complete. It exposes the local state transitions and evidence paths the scheduler needs.

## Workspace Session Communication Layer

Agent Workspace owns cross-session routing. The workbench-managed execution unit is a Workspace Session, not a provider-native agent. OpenCode and Claude Code may still use their own agents, subagents, tools, commands, skills, permissions, and modes inside the current session; those provider-native mechanisms are implementation details and are allowed.

The current communication design is defined by `docs/superworks/spec/conductor-session-communication.md`. The primary model is Conductor-centric: Conductor is the task-owner Workspace Session that receives Agent Workspace orchestration tools, while delegated sessions remain provider-native execution terminals without Agent Workspace protocol injection.

The shell therefore treats each terminal as a Workspace Session execution surface, but only Conductor is modified with Agent Workspace MCP tools:

```text
Conductor Workspace Session
  -> Agent Workspace MCP tools
  -> call_session / read_task_state / read_session / claim_task_completion
  -> Shell Session Manager
  -> delegated Workspace Session
  -> provider-native work in PTY
  -> Shell-owned dispatch/result/status store
  -> Task Runtime starts the next Conductor turn when a decision point exists
```

Cross-session work must be routed through the Shell and Conductor MCP tools, not through worker-visible custom message protocols. If Conductor needs a separate provider session to act, Conductor calls `call_session`; Shell starts or reuses the target provider terminal, waits until the assignment is actually written, then returns a delivered dispatch id. `call_session` is asynchronous with respect to the delegated work result, but it should not return a successful response before delivery is confirmed.

Shell generates one short `dispatchId` for every dispatched assignment. It is a six-character uppercase hex code, unique within the runtime task, and travels with the worker assignment, the provider-extracted answer message, the dispatch-result index, task-level events, and runtime wakeups. The UI may show this `dispatchId` beside worker status and timeline records so users can correlate "the thing Conductor asked Researcher/Reviewer to do" with the returned provider message. Shell still validates task id, target Workspace Session, exact assignment marker, provider message ids, and dispatch-window boundaries, but those provider fields are audit inputs rather than separate Agent Workspace communication keys.

Task timeline should read from task-level events plus task-level provider answer `messages.jsonl`. Per-session `results.jsonl` is a dispatch-result index and should not be treated as the global message store.

For a single `call_session`, `ok: true` with `status: "delivered"` is a Conductor turn boundary. The tool result must communicate `turnPolicy: "stop_after_dispatch"` and a short message instructing Conductor to end the current turn and wait for runtime wakeup. Conductor must not synchronously poll, block, or keep reasoning as if the delegated result were available. If deterministic parallel fan-out is required, it should be represented by a separate batch primitive such as `call_sessions` or by a Shell-side task-template step, not by relying on ambiguous model behavior after each single dispatch.

The Shell starts or wakes the target delegated session and writes a normal provider-native task message into that terminal. Provider-specific adapters extract completed delegated-session results from provider-native structured stores when available. Task Runtime owns active Conductor wakeup: when a provider result, blocked state, permission request, review failure, schedule trigger, or user decision point appears, Runtime starts the next Conductor turn with a plain-text wake message. For provider-result wakeups, that message includes the matching dispatch metadata and the full provider-extracted `answerText`; it is not a JSON metadata payload and must not silently truncate the worker answer. This wakeup is not implemented by overloading `call_session`, and it is not a worker-visible custom protocol.

Conductor must not use a provider-native subagent inside its own process as a substitute for a required Workspace Session when the task template explicitly needs separate session state, visibility, provider, project path, model, permission scope, or runtime isolation. This does not ban Conductor, Researcher, Reviewer, or any delegated session from using provider-native subagents as internal tools for work owned by their current session.

The previous structured Workspace Session Message block in terminal output is deprecated as the primary router input. Terminal transcripts remain raw inspection/debug evidence; they are not a task-state source. Shell-owned session stores, provider adapters, and Conductor tools are the authoritative communication path.

Research task target sessions are seeded by a task template, but the final user-confirmed Session Agent Plan is the execution truth. Delegated sessions do not route work to each other. The target allowlist defines which sessions Conductor may start, continue, and inspect for a given task, and is derived from the confirmed Session Agent Plan rather than only from the template id.

```text
Conductor Session -> call_session(Researcher Session)
Conductor Session -> read_task_state(Task)
Conductor Session -> read_session(Researcher Session)
Conductor Session -> call_session(Reviewer Session)
Conductor Session -> read_session(Reviewer Session)
```

Reviewer output is ordinary provider-native terminal output. Conductor reads it through `read_session`, then decides whether Researcher gets another round. Reviewer does not directly command Researcher and does not call Agent Workspace tools in the first version. Other task templates may define different Conductor-to-target-session sets, but the shell must validate caller session id, receiver session id, task id, and target allowlist before forwarding or writing to a target PTY.

If a worker receives a task assignment and later emits PTY output or exits, the shell treats that as a trigger to inspect provider-native state through the provider adapter. The shell must not infer idle, waiting, blocked, timeout, done, or result-available from terminal prompt text. The shell must not auto-write long repair prompts into busy visible TUI sessions, must not guess completion from free-form text, must not silently invent a handoff, and must not let Conductor treat an unstructured worker answer as verified task progress. Conductor must use `read_session` against the Shell-owned Session Store before making the next decision.

Conductor is a task-level Workspace Session, not just another worker. Its job is to route work, inspect delegated session outputs, ask follow-up questions, request missing evidence, escalate user decisions, and decide whether the task can move to synthesis, review, or another session round. Delegated sessions execute scoped assignments as normal provider-native terminals. This keeps scheduler ownership separate from agent reasoning while still allowing visible terminal operation.

## Scoped Runtime Injection

Agent Workspace instructions are task-scoped runtime instructions. They must not be written into global `AGENTS.md`, `CLAUDE.md`, or durable product-intent docs. For each task and Workspace Session, the shell prepares runtime files under `.agent-workspace/runtime/<task-id>/injection/` and injects them only into the CLI process started by Agent Workspace.

For opencode, the adapter provides task-scoped config content, MCP configuration, and optional plugin wiring when spawning the Conductor PTY. For Claude Code, the adapter can use session-scoped CLI arguments such as MCP config, system prompt appenders, custom settings, or plugin directories for the Conductor PTY. Provider-specific mechanics live behind adapter modules; product pages only depend on the shared runtime injection descriptor and Conductor communication contract.

Conductor runtime injection contains, in order:

- Agent Workspace MCP tool availability,
- current project and task facts,
- Conductor task-owner role,
- Conductor worker target allowlist,
- provider-native worker boundary,
- evidence and review requirements,
- route validation expectations.

This injection is active only for Conductor sessions launched through Agent Workspace. A user opening opencode or Claude Code directly in a normal terminal should not inherit Agent Workspace task protocol unless they explicitly start that task session from the workbench. Worker sessions launched by Agent Workspace remain provider-native sessions with normal model/provider/runtime settings and must not receive Agent Workspace protocol prompts in the first version.

## Task Intake Interaction

Task Intake is the boundary where a board card becomes executable work. It accepts manual briefs, docs product-intent watcher events, screenshots, prototypes, and prompt context. It records task context in the Task Store, creates the task-scoped Task Session Group, and lets the shell start the Conductor PTY for the selected project.

```text
Board
  -> capture task draft
  -> select project path, starting scheme, Conductor model, title, description, labels, session-agent cards, and optional artifact context
  -> shell appends intake event under .agent-workspace/tasks/intake.jsonl
  -> task starts as Running on the Board
  -> shell starts the task Conductor PTY and writes the task context to the terminal
```

Capturing intake must not fabricate an `AgentRun`, bypass Review, or mark Done. It must not write runtime state into `docs/research/`, `docs/superworks/spec/`, or `docs/superworks/plans/`, and must not infer agent progress beyond the PTY lifecycle it owns. The shell owns task id, intake source, labels, context artifact pointers, running status, project path, Conductor session id, and task event stream path; agent runtimes own interpretation and produced evidence after the Conductor PTY receives the initial task context.

Submitting the intake form records a `TaskIntakeEvent` under `.agent-workspace/tasks/intake.jsonl`, appends a running board task, mints a fresh `runtimeTaskId`, creates task-scoped Conductor/worker Workspace Session records from the confirmed Session Agent Plan, stores the template id as the seed used for later worker target allowlist lookup, stores the final Session Agent Plan as the allowlist and prompt-planning truth, selects that task for inspection, and starts the Conductor PTY when desktop runtime is available. Task labels are task-store metadata, not agent instructions or runtime state. `TaskIntakeEvent` appears in Audit Trail before any Review approval exists for the captured task; PTY session evidence is attached separately from the intake record.

Task Intake Progressive Disclosure keeps the Board capture surface compact by default. The default intake row accepts a task title and records a running task with manual-brief, Conductor owner, selected starting scheme/model defaults, and no artifact defaults. Expanding context fields must not create Review approval, mark Done, or write runtime state into product-intent files; it only reveals description, labels, starting scheme, model, artifact path, Session Agent Plan cards, and source-type explanations before the same Task Store capture and Conductor auto-start action.

Task Home must not render a persistent "task context and evidence" panel in the default creation or inspection flow. Project path, run id, Conductor session id, transcript paths, and artifact pointers are runtime/audit metadata, not the main task-home interaction. They may appear in explicit debug, Audit Trail, Review, or Run detail surfaces, but Task Home should reserve its primary space for task creation, task selection, the built task execution conversation, and the editable Session Agent Plan.

After Task Intake creates a task, the Task page is conversation-first rather than terminal-first. The primary surface is an execution conversation with compact Markdown cards for:

- the user's initial task message to Conductor,
- Conductor's normal output message,
- Conductor's `agent_session_call` dispatch message to a target session,
- worker result messages and later QA/Review events when present.

The built Task page reads its execution feed from the Shell-owned runtime task state (`read_task_state`) when the desktop backend is available. `task.user_message`, `user.intervention`, `dispatch.created`, `dispatch.failed`, `dispatch.result_available`, `conductor.message`, `task.completion_claim`, and runtime wakeup events under `.agent-workspace/runtime/<runtimeTaskId>/events.jsonl` are projected into Markdown cards. Local projection may be used only as an empty-backend placeholder; once backend events exist, they are the source of truth for the Task page timeline.

The Conductor PTY remains the real running backend for start/write/stop and diagnostics, but the built Task page must not expose the raw terminal as the default execution view. Users correct the current flow through the bottom Conductor composer; sending text writes to the Conductor session and records a user intervention event when runtime persistence is available. The composer should expose Send, Stop, and Goal controls. Stop targets the task Conductor session, and Goal advances through the scheduler/review path rather than bypassing verification.

The built Task page sidebar shows the task session roster and a selected-agent detail panel. Clicking a session agent updates the detail panel with that session's provider/model, cwd, launch policy, configured MCP tools, and skills/capabilities. This sidebar is not a task facts panel and must not duplicate runtime evidence paths by default.

The visible Session Agent Plan editor is card-first. The user should see a Conductor card and one card per worker session, with editable name, role, provider/model, instructions, expected output, and controls to add, remove, duplicate, or rename workers. The starting scheme is only a seed that initializes these cards; it is not the final task template after the user or AI assistant edits the plan. Raw JSON may exist only as an advanced import/export or debugging affordance, collapsed by default, and must not be the primary product surface. When a task is created, the resulting cards belong only to that task's `runtimeTaskId`; creating another task must create a fresh task-scoped session group and must not reuse the previous task's Conductor, worker cards, or terminal sessions.

Task Intake must expose the effective Conductor runtime prompt and MCP scope preview for the confirmed Session Agent Plan. The preview is read-only, derived from the current project path, task title, task goal, selected template seed, model, final worker target allowlist, Session Agent Plan, and runtime injection bundle, and should update with the draft before creation. Showing the prompt preview must not start PTY sessions, mutate runtime files, create an `AgentRun`, or become a hidden configuration source; it only lets the user inspect Conductor's task-owner instructions, provider-native worker boundary, MCP tools, planned session roles, and worker target allowlist before pressing Create.

## Task Draft Assistant Interaction

Task Draft Assistant runs before Task Intake creates executable work. It is the natural-language configuration layer on Task Home: the user describes a task in one sentence, the shell calls opencode headless through the desktop backend, and the assistant returns a structured `TaskDraft`, `TaskDraftPatch`, `SessionPlan`, or `SessionPlanPatch` that fills the new-task configuration draft and an editable Session Agent Plan on the right side of the page.

```text
Task Home
  -> user writes one natural-language task request
  -> shell sends project path, current draft, model, and user message to Task Draft Assistant
  -> desktop backend calls opencode headless, not PTY/TUI
  -> assistant returns strict JSON task draft, Session Agent Plan, or patch
  -> shell validates supported fields and fills the visible Task Intake draft plus plan editor
  -> user may continue dialogue to patch the draft
  -> user confirms Create and Start
  -> Task Intake creates the task and starts Conductor PTY
```

Task Draft Assistant may use opencode headless to infer project path, title, summary, template, model, labels, artifact path, output hints, missing fields, assumptions, and a Session Agent Plan. Templates are defaults, not the final routing truth: the assistant can propose a different number of sessions than the template seed when the task asks for it, such as two independent Researcher sessions plus a Reviewer. Follow-up edits may change only the Session Agent Plan, for example adding another Researcher; in that case the assistant may return a complete `SessionPlanPatch` without a `TaskDraftPatch`. Clear structural edits such as adding a worker session are first-class Task Intake operations: the shell may apply them to the existing Session Agent Plan and worker allowlist when the intent is unambiguous, then show the result as cards instead of making raw JSON the product surface. The user can add, remove, duplicate, rename, or edit planned sessions before creation. Multiple sessions may share the same role or display name; the generated runtime `sessionId` is the only routing key after task creation.

The Session Agent Plan is a task configuration object, not worker protocol injection. It should include the Conductor session, provider/model defaults, worker session entries, each worker's visible role, project path, launch profile, scope/instructions, expected outputs, and any Conductor routing guidance for the task. Business flow guidance belongs in this plan and the generated Conductor prompt, not in special-purpose `call_session` parameters. For example, a research task plan may tell Conductor to dispatch independent evidence collection, pass full review text to the responsible worker when changes are needed, and send the worker's fix result plus original review text back to Reviewer for another review round.

Task Draft Assistant must not start Conductor PTY, must not open a worker terminal, must not execute project commands, and must not write project files. It must not create a task, create an `AgentRun`, bypass Review, or mark Done. The assistant output is a configuration draft until the user presses the Task Intake create/start action.

The UI boundary is explicit: the left Task Home assistant panel owns the dialogue and generation status; the right new-task panel owns the executable task configuration and card-based Session Agent Plan editor. The generated content must be editable by the user before creation. If opencode cannot return valid JSON and the user request is not a supported unambiguous structural edit, the shell shows the failure and keeps the current draft unchanged.

## Backlog Board Interaction

Backlog Board is the task-state surface. It is not an agent runtime and not a generic status dashboard.

```text
Board
  -> select task card
  -> shell aligns visible task, owning project, and owner agent context
  -> inspect source, risk, verification, loop, run id, and owner
  -> Advance task status
  -> shell appends a task transition event under .agent-workspace/tasks/events.jsonl
  -> selected task detail shows recent transition evidence
  -> attached artifacts show screenshot, sketch, HTML, prompt, or browser evidence paths under .agent-workspace/tasks/<task-id>/artifacts/
  -> Start Agent or Workbench drill-down handles execution separately
```

Selecting a task from Workbench or Board aligns the visible task, owning project, and owner agent context. Task selection is a shell focus change, not a scheduler transition. It must not create an `AgentRun`, start PTY, move task status, or approve Review; it only keeps Board-first task context, project scope, and IDE agent focus coherent before the user starts execution.

Selecting an agent in Workbench aligns to that agent's current project-owned task when one exists. Agent selection is a shell focus change, not a PTY or scheduler action. It must not create an `AgentRun`, start PTY, move task status, or approve Review; when the agent's current task is outside the selected project, the shell keeps the current task and project context stable.

Advancing a board task records scheduler-owned task state evidence. It must not create an `AgentRun` by itself, must not start a PTY session, and must not bypass Review. The shell owns task id, from/to status, transition timestamp, summary, and task event stream path; Run Store and PTY Service own real execution only when the user starts an agent run.

Task artifacts are task context, not execution. Attaching a Scratchpad screenshot, sketch, HTML snippet, prompt template, browser artifact, or MCP-provided file records a shell-owned `TaskArtifact` under `.agent-workspace/tasks/<task-id>/artifacts/`. It must not move task state, create an `AgentRun`, write into product-intent files, or mark Review complete. The artifact count belongs on the board card; the selected task detail shows source artifact path, task artifact path, timestamp, and summary.

Task Detail can start a task through the existing Loop/runtime adapter path. When clicked, the action records a Loop schedule event before opening IDE Workbench, then Run Store creates `AgentRun`, PTY Service spawns the session, and Git Service captures baseline context. It must reuse Run Store, PTY Service, and Git Service adapter boundaries instead of adding a board-owned execution path.

## Review / Commit Interaction

Review is the handoff from agent execution to user approval. It must show changed files by agent, keep a shell-owned scoped commit selection, and preserve whether the `Agent-Conversation` trailer will be attached to the commit proposal.

```text
Agent claims done
  -> Review filters changed files by agent
  -> user includes or excludes files for scoped commit
  -> user stages selected files and records staged/unstaged evidence
  -> user runs verification command and records pass/fail evidence
  -> user enables Agent-Conversation trailer when transcript context should be preserved
  -> user runs Agent-Conversation redaction scan before transcript artifact upload
  -> Approve review checks verification and redaction gates
  -> approved gate marks commit proposal approved and task Done
  -> Runs prepares a PR handoff draft only after user approval
```

Running verification, staging scoped files, toggling a scoped file, trailer, or redaction scan must not create an `AgentRun`, must not change task status, and must not approve Review. The prototype records staging output as a run-scoped `CommitStagingEvent` with staged paths, unstaged paths, and `.agent-workspace/runs/<run-id>/staging.json`. It records verification output as a run-scoped event with command, pass/fail status, log path, and `.agent-workspace/runs/<run-id>/verification.json`. It records redaction scan output as `.agent-workspace/runs/<run-id>/redaction.json`, covering API key, token, and `.env` patterns before an Agent-Conversation artifact could be uploaded. The Git Service owns future baseline, diff, attribution, staged-file, redaction, and commit execution APIs; the Run Store owns verification evidence; the shell owns the selected file paths, trailer preview, staging evidence, and redaction scan evidence until real adapters consume them.

Redaction scan audit entries preserve task id, run id, transcript path, matched patterns, and redaction artifact path. Opening a redaction audit context routes to Review without changing approval, task, notification, or PR handoff state.

Approving Review must not convert missing verification into passed verification. If verification has not passed, or if the Agent-Conversation trailer is selected without a passed redaction scan, the shell records a `ReviewGateEvent` under `.agent-workspace/reviews/<run-id>/gate.json`, keeps the task out of Done, and leaves the commit proposal unapproved.

Approving Review records a separate `ReviewApprovalEvent` under `.agent-workspace/reviews/<run-id>/approval.json`. The event includes task id, run id, verification status, selected file paths, redaction artifact when present, commit proposal path, approval timestamp, and summary. It is the durable user-approval evidence behind `done`; Runs shows it in the run-scoped completion audit and Audit Trail shows it as a Review event.

After approval, the shell opens Runs so the user can inspect run-scoped audit evidence before deciding whether to prepare a PR package. Review approval creates a done notification sourced from `ReviewApprovalEvent`, with destination `sidebar`, approval evidence path, and a Runs audit summary. Review approval must not create a `PullRequestHandoffEvent` automatically. PR handoff remains an explicit Runs action after approval evidence exists.

Preparing a PR handoff records a `PullRequestHandoffEvent` under `.agent-workspace/pr/<run-id>/handoff.json`. It includes task id, run id, branch name, approval evidence path, commit proposal path, status, timestamp, and summary. It is not a hosted PR creation side effect: it gives the user or a future native git/hosting adapter explicit context for the next step after approval.

## Project Cockpit Interaction

Projects are workspace context, not task execution.

```text
Projects
  -> inspect project path and zone
  -> select project context
  -> shell records selected project id
  -> shell aligns visible task and agent focus to project-owned ids when needed
  -> shell appends a project context event with zone, manifest path, browser profile, and timestamp
  -> inspect project agents, tasks, active runs, commands, and browser profile
  -> open IDE Workbench for focused execution
  -> Workbench sidebar shows the selected project path, manifest, browser profile, project agents, and project tasks
```

Selecting a project must not create an `AgentRun`, must not change task status, and must not bypass Review. The shell owns selected project context, zone grouping, browser profile, and project manifest pointers under `.agent-workspace/projects/<project-id>.json`; agents only consume the resulting run/task context once the user enters a concrete task surface.

Opening the selected project in Workbench carries the project context into the IDE shell. Workbench sidebar shows the selected project path, manifest, browser profile, project agents, and project tasks instead of global workspace data. Selecting a project may align the visible task and agent to project-owned ids so the IDE drill-down does not display a task from another project; this focus alignment must not create an `AgentRun`, mutate task status, or imply PTY execution.

## Agent Setup Interaction

Agent setup creates a project-scoped agent profile. It does not start task execution by itself.

```text
Projects
  -> choose agent template
  -> shell creates idle agent profile
  -> shell appends an agent profile event with template, system prompt, worktree policy, manifest path, and timestamp
  -> selected project records agent id
  -> Workbench selects the new agent context
  -> PTY remains pending until a task/run is explicitly started
```

Adding an agent must not create an `AgentRun`, must not change task status, and must not imply code execution has begun. The shell owns agent id, provider, model, role, color, current task pointer, template id, system prompt path, worktree policy, project membership, and agent manifest pointers under `.agent-workspace/agents/<agent-id>.json`; PTY service owns the real process once Start Agent or a run lifecycle requests it.

## Research / Spec / Plan Watcher Interaction

Watcher converts durable product-intent changes into planner work. It is not a repeated prompt loop and not an executor.

```text
Watcher
  -> observe docs/research/, docs/superworks/spec/, and docs/superworks/plans/
  -> record changed file event under .agent-workspace/watch/events.jsonl
  -> classify whether planner review is needed
  -> create a planner task on the board
  -> Planner loop reviews alignment before executor work starts
```

Creating a planner task from a watch event must not create an `AgentRun`, must not start a PTY session, and must not write runtime state into `docs/research/`, `docs/superworks/spec/`, or `docs/superworks/plans/`. The shell owns watch roots, event records, task creation, and evidence paths; the planner agent owns interpretation once the task is launched through the normal run lifecycle.

## Adapter-Backed Start Agent Interaction

The prototype Start Agent button is now modeled as an orchestration flow:

```text
Loop queue Start Agent
  -> task orchestrator receives current state and runtime adapters
  -> shell appends a loop schedule event under .agent-workspace/loops/events.jsonl
  -> run-store.createRun(task, agent)
  -> pty-service.spawn(agent command, cwd, run id)
  -> git-service.captureBaseline(run id)
  -> run-store records branch/worktree context and baseline manifest path
  -> reducer records task status, active run, terminal lines, scheduler decision, and runtime events
  -> Workbench shows terminal context and runtime adapter event evidence
```

The reducer stays pure. Starting an agent from the Loop records the scheduler decision separately from adapter events, so the product can explain why a run started before showing how run-store, PTY, and git services executed it. Native desktop services can replace the mock adapters without changing the product interaction contract.

## Runtime Policy Interaction

Runtime Policy is the launch boundary for a run. It records what the scheduler granted before the PTY session operates: permission mode, sandbox mode, effort level, CLI command, and policy artifact path.

```text
Start or inspect AgentRun
  -> shell resolves the agent runtime command
  -> shell records permission, sandbox, effort, and CLI command under .agent-workspace/runs/<run-id>/policy.json
  -> PTY Service spawns the session inside that policy boundary
  -> Workbench shows the policy beside the terminal transcript
  -> Runs preserves the same Runtime Policy artifact as run-scoped audit evidence
  -> Review and Audit Trail can later explain which capabilities were granted for the run
```

Audit Trail indexes runtime policy evidence separately from transcript evidence so workspace-level review can distinguish launch authorization from terminal output.

Recording or inspecting Runtime Policy must not create an `AgentRun`, start PTY, move task status, approve Review, or grant hidden capabilities by itself. Inspecting launch policy in Runs must not create an `AgentRun`, start PTY, move task status, approve Review, create PR handoff, or mutate policy. Start Agent owns creating the run and PTY session; Runtime Policy only makes the granted launch context visible and durable. The shell owns permission mode, sandbox mode, effort level, CLI command, and `.agent-workspace/runs/<run-id>/policy.json`; the agent runtime owns behavior after the PTY is spawned within that boundary.

## Terminal Diagnostics Interaction

Terminal diagnostics preserve bounded PTY lifecycle/output evidence for run inspection. They do not classify Agent card state, task state, dispatch results, waiting/permission state, or completion.

```text
PTY Service
  -> streams raw terminal output
  -> Shell records bounded run-level terminal diagnostics when enabled
  -> Runs may show terminal diagnostics as inspection evidence
  -> Provider Adapter inspects provider-native state for task/session state
  -> Review still requires verification, diff, and approval before Done
```

Audit Trail may index terminal diagnostics separately from provider-state events so workspace-level review can distinguish raw terminal output from authoritative provider-derived state.

Parsing terminal output must not infer implementation quality, approve Review, create an `AgentRun`, write runtime state into `docs/research/`, `docs/superworks/spec/`, or `docs/superworks/plans/`, bypass the scheduler, move task status, set Agent card state, produce dispatch results, or trigger Conductor wakeups. Inspecting terminal diagnostics must not create an `AgentRun`, start PTY, move task status, approve Review, or mutate terminal events. Provider adapters own semantic state; the agent runtime owns the raw terminal text and any explanation it emits.

There is no automatic terminal-diagnostic path for task/session state in the current architecture. If a future diagnostic row allows a user to create an explicit note or investigation task from terminal text, that action must be user-confirmed and must not bypass provider-state inspection, Review, verification, scoped staging, redaction, or user approval.

## Run Worktree Context Interaction

Run Worktree Context is run metadata, not a separate scheduler. It answers which branch and working tree an `AgentRun` is allowed to edit.

```text
Start or inspect AgentRun
  -> run-store creates or loads run id
  -> git service records isolation policy, branch name, worktree path, and baseline manifest
  -> Workbench shows branch/worktree beside terminal and commit context
  -> Review uses the same run context while checking files and approval gates
  -> Runs preserves the same manifest as run-scoped audit evidence
```

Recording worktree context must not start a PTY by itself, move task status, approve Review, or write runtime state into `docs/research/`, `docs/superworks/spec/`, or `docs/superworks/plans/`. The shell owns the visible pointer fields on the `AgentRun`; the Git Service owns future native branch/worktree APIs and the baseline manifest under `.agent-workspace/runs/<run-id>/worktree.json`.

## Scratchpad / Composer Interaction

Scratchpad is the prompt preparation surface inside the IDE Workbench. It is not a task scheduler and not a separate agent runtime.

```text
Workbench
  -> compose multiline prompt
  -> autosave draft path under .agent-workspace/scratchpad/<task-id>.md
  -> insert prompt template, screenshot, sketch, or HTML context reference
  -> optionally attach the selected context to the current task card
  -> optionally save draft to Prompt Library
  -> shell records a Prompt Library save event with source draft, target store, artifact path, task id, and saved timestamp
  -> send prompt to the active PTY session
  -> terminal transcript records the prompt
```

Inserting context, attaching task artifacts, or saving a draft must not create an `AgentRun`, must not change task status, and must not bypass Review. The shell owns draft path, selected context ids, task artifact paths, prompt-library save events, and saved draft artifact paths; the agent runtime owns the response after the prompt is sent through PTY.

## Dev Terminal Interaction

Dev Terminals are project command sessions, not coding AgentRuns.

```text
Dev Terminals
  -> choose saved command
  -> Start command
  -> command status becomes running
  -> shell appends a command lifecycle event to .agent-workspace/commands/events.jsonl
  -> command log path is kept under .agent-workspace/commands/<command-id>/log.txt
  -> Stop command
  -> command status becomes stopped
  -> shell appends the stop event without creating an AgentRun
```

Starting or stopping a dev command must not create an `AgentRun`, must not change task ownership, and must not imply that a coding agent was launched. The first prototype stores command status and command lifecycle events in React prototype state; the native version should replace this with the PTY service, command manifest under `.agent-workspace/commands.json`, lifecycle event stream under `.agent-workspace/commands/events.jsonl`, and bounded command logs under `.agent-workspace/commands/<command-id>/log.txt`.

## Team Workflow Interaction

Team workflows are explicit multi-agent orchestration surfaces, not the default task execution path.

```text
Teams
  -> select workflow
  -> Start selected workflow
  -> shell records TeamRun under .agent-workspace/teams/<team-run-id>/
  -> active node consumes or emits handoff payload
  -> Advance handoff moves to the next node
  -> wrapping from the last node starts the next cycle
  -> maxCycles guards feedback loops such as Dev -> QA -> Dev
  -> exceeding maxCycles blocks the TeamRun until user review
```

Starting or advancing a `TeamRun` must not create a normal `AgentRun`, must not move a task card, and must not bypass Review. When the max-cycle guard blocks a run, the shell keeps the active node, cycle count, and handoff evidence path visible so the user can decide whether to restart, revise routing flags, or stop the workflow. A later native team scheduler can fan out to real agent sessions, but the shell still owns node order, cycle guard, routing flags, and handoff evidence paths.

## Library Interaction

Libraries are context selection surfaces, not alternate agent runtimes.

Prompt flow:

```text
Libraries
  -> choose prompt template
  -> Send to active agent
  -> Workbench opens with composer populated
  -> selected prompt id is recorded in shell state
  -> saved Scratchpad drafts remain visible as Prompt Library artifacts
```

Skill flow:

```text
Libraries
  -> choose skill
  -> Attach to active task
  -> shell records skill id for the task context
  -> shell records export target and runtime instruction boundary
  -> agent runtime remains responsible for interpreting SKILL.md
```

Sending a prompt, saving a Scratchpad draft, or attaching a skill must not create an `AgentRun`, must not change task status, and must not bypass the Review gate. The scheduler only records context and library-store evidence; execution still happens through Workbench, Loop, and runtime service contracts.

## Runtime Instruction Injection Boundary

Skills are runtime instructions, not a forked agent workflow. The canonical skill artifact is `SKILL.md`; each target runtime receives a format-compatible pointer or managed block. Codex uses a managed block in `AGENTS.md`; Claude Code receives `.claude/skills/<name>/SKILL.md`; Cursor and Windsurf receive rule files; Aider receives a managed block in `CONVENTIONS.md`.

```text
Libraries
  -> attach skill to task or agent
  -> shell records skill id, source format, export target, and managed-block policy
  -> start-time injection manifest is prepared under .agent-workspace/libraries/
  -> Workbench or Loop starts the run through the normal scheduler path
  -> agent runtime reads its native instruction surface
```

Attaching or exporting a skill must not rewrite agent workflows or skill bodies, must not create an `AgentRun`, must not write uncontrolled instructions into `docs/research/`, `docs/superworks/spec/`, or `docs/superworks/plans/`, and must not bypass Review. The Library Store owns skill scope, selected task/agent binding, export target, managed block policy, and the future start-time injection manifest. The agent runtime owns interpretation after the scheduler starts a real PTY session.

## Browser Evidence Interaction

Browser Automation is a verification surface, not the primary task scheduler.

```text
Browser
  -> inspect active task verification target
  -> select Browser MCP tool
  -> Capture evidence
  -> shell records artifact path under .agent-workspace/browser/<task-id>/
  -> Review shows the task evidence before approval
  -> Runs preserves the same artifact path in the completion audit
```

Selecting a browser tool or capturing browser evidence must not create an `AgentRun`, must not change task status, and must not imply that browser automation is part of MVP core. Agent runtimes may drive browser actions through MCP, but the shell owns project browser state, evidence paths, task association, and the Review/Runs visibility that makes browser artifacts usable as verification context.

## MCP Gateway Interaction

MCP Gateway is the agent-facing automation boundary. It is not a second scheduler.

```text
MCP Gateway
  -> choose tool server
  -> inspect allowlisted tools, permission class, target surface, and evidence path
  -> agent requests a tool call
  -> shell checks project scope and permission
  -> confirm-class tool waits for scheduler approval or denial
  -> scheduler records approval or denial under .agent-workspace/mcp/<event-id>/confirmation.json
  -> scheduler or service contract performs the state transition
  -> evidence path is recorded for Review and Runs
```

The first designed tool surfaces are Backlog MCP, Terminal Commands MCP, Prompt Library MCP, and Browser MCP. Selecting an MCP server must not create an `AgentRun`, must not change task status, and must not bypass Review. Backlog and Commands are the first practical MCP candidates; Browser MCP remains tied to verification context.

The prototype records each requested tool call as an `McpToolCallEvent` with task id, server id, tool name, permission class, status, target surface, and evidence path. MCP tool calls are task-scoped shell evidence. A `confirm` tool becomes `confirmation-required`; read/write tools are routed but still recorded. Review and Runs show task-scoped MCP evidence without executing scheduler side effects. Inspecting MCP tool evidence must not create an `AgentRun`, start PTY, move task status, approve Review, or execute the tool. Later native MCP adapters can replace the mocked request path while preserving the audit event shape.

Resolving a confirmation must not create an `AgentRun`, move a task card, mark Review complete, or execute scheduler side effects by itself. The scheduler records approved or denied decision fields, decision timestamp, decision summary, and `.agent-workspace/mcp/<event-id>/confirmation.json`; Audit Trail uses that confirmation artifact as the authoritative evidence for the resolved MCP event. Native MCP permission prompts can replace the prototype buttons while preserving the same confirmation event shape.

## Notification Interaction

Notifications convert task and run state into user-visible events. They do not perform scheduling.

```text
Notifications
  -> inspect active task signal
  -> Route notification
  -> shell records event under .agent-workspace/notifications/events.jsonl
  -> destination is chosen from route rules
  -> open notification context
  -> shell selects the referenced task and opens the matching product surface
  -> user acknowledges event
  -> event stays in audit history
```

Routing or acknowledging a notification must not create an `AgentRun`, must not change a task status, and must not bypass Review. Native desktop/mobile delivery can replace the prototype route table later, but the shell owns event type, destination, acknowledgement, and evidence path.

Opening a notification context selects the referenced task and routes the shell to the right surface without scheduling work: waiting-input opens IDE Workbench, pending-review or failed-verification opens Review, done opens Runs, and other task states return to the Board. Opening notification context must not acknowledge the event automatically, create an `AgentRun`, move task state, approve Review, or write runtime state into product-intent files.

The done notification opens Runs and must not create PR handoff. Notifications display Review approval source evidence separately from provider-state source evidence: provider-state notifications show the provider-state event id and task/session evidence path; review-sourced done notifications show the `ReviewApprovalEvent` id and `.agent-workspace/reviews/<run-id>/approval.json` path.

## Restore Session Interaction

Restore Session rehydrates workspace shell state and process metadata after restart. It is not an agent replay system.

```text
Restore
  -> inspect current or previous session manifest
  -> Capture restore manifest
  -> shell records active view, selected task, selected agent, project path, and process metadata
  -> shell records resume context pointers for active run, browser evidence, MCP audit, TeamRun handoff, notifications, and redaction artifacts
  -> Restore workspace session
  -> shell returns to the manifest view/task/agent context
  -> PTY/dev-command metadata and evidence pointers remain available for native restoration
```

Capturing or restoring a session must not create an `AgentRun`, must not change task status, must not mark Review done, and must not write runtime state into `docs/research/`, `docs/superworks/spec/`, or `docs/superworks/plans/`. Resume context records are artifact pointers, not replay commands: they help the user reattach transcript, verification, browser evidence, MCP audit, TeamRun, notification, and redaction context after restart. Native PTY restore can replace the prototype manifest later, but the shell owns restore pointers, rollback intent, process class, command line, working directory, context record kinds, and metadata paths.

## Deferred Mobile Sync Boundary

Mobile Sync is a remote control surface for the desktop workbench. It is not part of the current Board-first execution path and must not start remote execution in the current prototype.

```text
Capability Map
  -> inspect Mobile Sync deferred boundary
  -> confirm desktop/backend owns execution authority
  -> mobile client may read projects, agents, terminal output, prompts, diffs, and notifications later
  -> future remote actions become explicit desktop-permissioned requests
  -> current prototype returns to Capability Map instead of opening a mobile page
```

The first desktop prototype keeps Mobile Sync visible only as a deferred capability boundary. It must not add a current navigation page, create an `AgentRun`, write to PTY, move task cards, bypass Review, or imply that remote mobile launch is ready. Native client sync can be designed after desktop PTY, review, restore, and notification contracts are backed by persisted `.agent-workspace/` state.

## Workspace Audit Trail Interaction

Audit Trail is the workspace-level evidence view. It is not a scheduler, not a run detail page, and not a review approval surface.

```text
Audit Trail
  -> collect shell-owned event streams from project, watcher, task, loop, run, runtime adapter, review, browser, MCP, notification, restore, and library records
  -> normalize them into a newest-first evidence timeline
  -> show surface, event kind, status, task id, timestamp, summary, and artifact path
  -> user drills back into the source surface when action is needed
  -> shell selects the referenced task when one exists and opens the source product surface
```

Opening Audit Trail must not create an `AgentRun`, must not move task cards, must not approve Review, and must not duplicate runtime state into product-intent files. It only derives a read-only index over existing `.agent-workspace/` event streams and artifact pointers. Runs remains the run-scoped audit view for transcript, diff, verification, and commit context; Audit Trail explains the broader workspace evidence chain.

Opening audit entry context selects the referenced task when one exists and routes to the source product surface, such as Task Board for task events, Review for verification and gate evidence, Runs for run and PR handoff evidence, MCP Gateway for MCP events, Browser for browser evidence, and Restore for session manifests. Runtime Policy audit entries open Runs for the referenced task and run because the policy artifact is run-scoped launch evidence. Opening audit entry context must not create an `AgentRun`, move task cards, approve Review, create PR handoff, or mutate evidence; it only changes visible shell context.

Opening a Runtime Policy audit context must not create scheduling, Review, notification, or PR handoff side effects. It only selects the run-owned task context and makes the Runs launch policy box inspectable.

Notification audit entries preserve source label, source event id, source summary, and source evidence path. Workspace Audit Trail distinguishes provider-state-sourced notification evidence from Review approval notification evidence while keeping the notification event path as the primary audit artifact. Inspecting a notification audit entry must not acknowledge the notification, open the notification context automatically, move task state, approve Review, or create PR handoff.

## Scope Guardrails

- The Board remains the default page.
- Loop console explains scheduling, not agent reasoning.
- IDE Workbench remains a task/run drill-down, not the global landing page.
- Teams, Browser, MCP Gateway, Notifications, and Restore are visible in prototype but marked advanced.
- Mobile Sync is deferred: visible in Capability Map as a boundary, not a current product surface.
- Audit Trail is read-only and must not trigger scheduling, review, or run lifecycle transitions.
- Runtime state belongs under the eventual `.agent-workspace/` store, not in `docs/research/`, `docs/superworks/spec/`, or `docs/superworks/plans/`.
- `done` means review approved with verification evidence and commit context, not just an agent completion claim.

Chinese-first Core Copy Pass keeps the prototype in one primary language instead of adding a full Chinese/English switch. It translates shell chrome, task intake controls, project cockpit headings, and primary user actions while preserving Agent, Loop, Run, IDE, Review, PR, MCP, PTY, Git, and product evidence terms. It must not introduce i18n runtime state, language toggles, translation dictionaries, or duplicate bilingual UI; it only normalizes the first-scan copy that users see while keeping technical terms stable for future desktop runtime work.

Board Chrome Chinese-first Cleanup keeps the default Board first scan in Chinese while preserving Agent, Loop, Run, IDE, Review, Done, and task as product terms. It translates the board principle strip, ownership pills, Loop summary title, and loop stage labels without changing routing, scheduler state, runtime adapters, or task events. The cleanup must not add i18n runtime state, language toggles, or duplicate bilingual UI; it only removes explanatory English from the default Board chrome.

Desktop Shell + Local opencode Bridge is the first real native-runtime step after the Vite prototype. Electron owns local process access, resolves the installed opencode binary, and runs explicit one-shot `opencode run --format json` smoke checks through a preload IPC bridge. The Workbench may probe opencode and launch a test run only from the desktop bridge; browser mode must show that local process access is unavailable. A native PTY manager may start, write, resize, stop, and preserve transcript chunks for local sessions, but those sessions remain run-surface evidence until scheduler-owned Run Store and Review gates consume them. Interactive Agent terminal sessions require the real `node-pty` backend; process fallback is limited to non-interactive smoke checks or verification commands and must not masquerade as an opencode conversation terminal. This bridge must not create Done, approve Review, skip permission prompts, write runtime state into product-intent files, or hide the Review gate.

Native Agent Session Controls extend the desktop bridge from one-shot opencode checks to managed local sessions. Workbench can start, refresh, write to, resize, stop, and display transcript output from a native opencode session. The IDE Workbench session path starts interactive `opencode` in a PTY using the selected project path and explicit model, then writes user input directly to that terminal. `opencode run --format json` remains a one-shot smoke check or automation-loop primitive, not the conversation terminal. Session controls remain execution-surface evidence and must not mark tasks Done, approve Review, or bypass the scheduler-owned Run Store.

Native Session Runtime Boundary keeps desktop-managed opencode PTY output as live run-surface UI state instead of durable communication evidence. Workbench may show current terminal output from the native PTY manager, but it must not expose raw transcript or metadata evidence paths as task truth. Cross-session communication and `read_session` use the project-scoped Shell Session Store under `.agent-workspace/runtime/<task-id>/sessions/<session-id>/` for state, dispatches, events, and provider-extracted results. Runtime session handling must not write state into research, spec, or plans files, and it must not mark tasks Done, approve Review, or bypass the scheduler-owned Run Store.

Explicit opencode Model Selection keeps the desktop bridge from relying on an overloaded or misconfigured global default model. The prototype may pass `--model opencode-go/deepseek-v4-flash` for explicit smoke runs and interactive native PTY sessions because local evidence showed the configured default provider can rate-limit while this model remains available. Timeout and provider errors must preserve stderr evidence such as rate-limit messages so Workbench can explain a failed native run without converting it into Done, Review approval, or hidden retry automation.

Native Session State Handoff attaches desktop-managed opencode session state to the scheduler-owned `AgentRun`. Runs and Review must show native session id, backend, model, command, exit status, and provider result references when available so the real desktop execution surface is visible in the audit and review gates. A stopped native session with exit 0 may move the task to pending Review but must not mark it Done, approve Review, create PR handoff, or bypass verification and redaction gates.

## Opencode Runtime Boundary

The runtime app no longer boots from prototype state. Task Home creates real task records, task-scoped opencode Agent session records, and launches real opencode PTY sessions through the desktop bridge. The shell manages session identity, process bounds, transcript evidence, duplicate-start protection, and Review handoff. Opencode owns the interactive TUI behavior.

Each task-scoped Agent session uses deterministic project/task/agent identity for restore and evidence, but the desktop PTY manager must treat `running` and `stopping` sessions as live. Starting the same session id while a process is still running or stopping returns the existing session instead of spawning another process or truncating transcript evidence. Only the process exit/close event makes the session stopped and eligible for a deliberate restart.

Native Verification Command Evidence runs the selected run verification command through the Electron desktop bridge instead of the old in-memory mock. The desktop shell writes `.agent-workspace/runs/<run-id>/verification.log` and `.agent-workspace/runs/<run-id>/verification.json`, then the scheduler-owned `AgentRun` records the command, pass/fail status, log path, and artifact path for Runs, Review, and Audit Trail. Native verification evidence must not create an `AgentRun`, move task status, approve Review, mark Done, or hide failed stderr output; it only records evidence that Review can evaluate.

Conversation-first opencode IDE Workbench makes the selected Agent conversation the primary IDE surface. Agent roles such as Planner, Executor, QA, and Reviewer are product roles, but their execution runtime is opencode, not mocked Codex, Claude Code, or Gemini CLI personas. Selecting an Agent opens that role's conversation terminal for the selected task; the central input writes to the selected opencode terminal session, and terminal output is rendered as the conversation transcript. The selected task must filter visible Agents and terminal routing by `runtimeTaskId`; Workbench must not fall back to a previous task's Conductor, worker session, or terminal when the current task has task-scoped Agents. Agent configuration, model, command, cwd, runtime policy, provider-state evidence, and terminal diagnostics should support the terminal through compact inline context, task/agent cards, or explicit debug surfaces, but they must not replace the conversation terminal as the primary surface.

Real opencode Agent Command Binding lets each product Agent own an editable launch command instead of relying on a hidden global default. The default command is `opencode --model opencode-go/deepseek-v4-flash`, and Workbench reads `opencode agent list` through the desktop bridge so the user can bind a local opencode agent such as `plan` or `build` to the selected product Agent. Binding a local opencode agent only updates that Agent's launch command; it must not create an `AgentRun`, start PTY, move task status, approve Review, or imply that product roles like QA automatically exist as opencode runtime agents. Launch failures must show the attempted command and stderr/transcript evidence in the terminal surface. Workbench must not pass mini-only flags such as `--no-replay` or `--replay-limit` to the full opencode TUI because current opencode requires `--mini` for those flags. The opencode conversation surface must render PTY output through a terminal emulator such as xterm so ANSI/TUI output becomes the visible opencode page instead of raw transcript text.

Terminal-first Workbench State Chrome keeps the IDE Workbench focused on the selected Agent terminal instead of a persistent debug inspector. The desktop layout uses a narrow Agent/Cluster rail and a wide conversation terminal. There is no default right-side `运行详情` rail in the primary task flow; runtime diagnostics can return later as an explicit debug view, not as a persistent production surface. Task context is collapsible and defaults to the current task. Command, cwd, model, MCP/provider-state evidence, and terminal diagnostics stay as compact inline context or card-level state near the selected terminal. The terminal surface exposes an explicit `GOAL 完成` action for the user to claim that the current task goal has been reached; that action is a user claim and must not bypass review or verification policy. Agent, cluster, and task cards expose state through color first from provider-derived Workspace state: running cards pulse, waiting or permission-sensitive cards use amber attention styling, and completed task cards use green completion styling. Permission states may shake or pulse subtly, but they must not be inferred from terminal text, bypass the terminal session, scheduler Run Store, Review gate, or explicit user approval.

Project-scoped Agent Cluster Namespacing keeps multi-project and multi-task execution from sharing global Agent identities. The first isolation boundary is the normalized project path, represented internally by a stable `runtimeProjectId`: each project owns Agent clusters, and each task-scoped cluster owns its Conductor, worker sessions, and provider identities even when their display names match another project. The project default cluster is an internal `Project Runtime` fallback before any task exists; it is not a user-visible task and must not appear in the Workbench task list. Task Intake creates a task-scoped cluster under the selected project, and sessions, terminal input, restore records, run evidence, and visible Agent selection are scoped by `runtimeProjectId`, `runtimeTaskId`, cluster id, and agent id. Selecting a project shows task records from that project. Selecting a task selects its matching task-scoped cluster before selecting an Agent; Workbench must not show or write to a terminal session from another project path, Agent cluster, runtime task, or the internal project default cluster.

## Verification

Prototype verification must prove:

- product capability data covers all researched surfaces,
- MVP core and advanced surfaces are distinct,
- runtime service contracts separate scheduler ownership from agent ownership,
- runtime adapter tests prove run-store, PTY, git, and filesystem-watch boundaries,
- Start Agent interaction is backed by run-store, PTY, and git adapter events,
- the browser-rendered prototype exposes Capability Map, Projects, MCP Gateway, Dev Terminals, Teams, Browser, Libraries, Notifications, Restore, Audit Trail, Runs, Board, Loop, IDE, and Review,
- Audit Trail aggregates shell-owned event streams while Runs stays focused on one `AgentRun`,
- Review and Runs preserve staged/unstaged file evidence without turning it into an implicit approval or real git side effect,
- responsive checks show no root-level horizontal overflow on the rendered prototype pages,
- existing task/run/review transitions still pass tests.

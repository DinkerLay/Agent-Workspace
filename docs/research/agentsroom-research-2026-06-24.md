# AgentsRoom Product Research

Date: 2026-06-24
Scope: product layout, interaction model, panel inventory, and implementation implications for building an AgentsRoom-like multi-agent workspace.

## Executive Summary

AgentsRoom is not a simple `/loop` command, terminal multiplexer, or prompt repeater. It is a desktop IDE shell for running many real coding-agent CLI sessions in parallel.

The central design is:

```text
Project / Room
  -> Agent Session
    -> isolated PTY terminal
    -> role / provider / model / status
    -> task / backlog card / team workflow node
    -> diff / review / commit context
```

The product wraps real local CLI tools such as Claude Code, Codex CLI, Gemini CLI, OpenCode, Aider, Grok Build, and Mistral Vibe. The CLI process is spawned in the project folder, and its output is streamed into the built-in terminal. AgentsRoom positions itself as "one screen" for all agents and projects, with status tracking, review, backlog, teams, dev terminals, browser automation, prompt/skill libraries, and mobile sync.

For our target system, the key lesson is: build a controller around real terminal agents and project files. Do not implement the whole system as repeated prompt injection. The useful product boundary is an orchestration shell that owns session state, task state, plan/spec state, PTY lifecycle, git review state, and notification state.

## Sources

- [AgentsRoom homepage](https://agentsroom.dev/zh)
- [All features](https://agentsroom.dev/zh/features)
- [Multi-project multi-agent cockpit](https://agentsroom.dev/zh/features/multi-project-multi-agent)
- [Backlog task board](https://agentsroom.dev/zh/features/backlog-task-board)
- [Agent Teams](https://agentsroom.dev/zh/features/teams)
- [Dev Terminals](https://agentsroom.dev/zh/features/dev-terminals)
- [Per-agent review](https://agentsroom.dev/zh/features/per-agent-review)
- [Commit Context](https://agentsroom.dev/zh/features/commit-context)
- [AgentsRoom MCP](https://agentsroom.dev/zh/features/agentsroom-mcp)
- [Browser Automation](https://agentsroom.dev/zh/features/browser-automation)
- [Prompt Library](https://agentsroom.dev/zh/features/prompt-library)
- [Skills Library](https://agentsroom.dev/zh/features/skills-library)
- [Scratchpad](https://agentsroom.dev/zh/features/scratchpad)
- [Restore Session](https://agentsroom.dev/zh/features/restore-session)
- [Mobile Sync](https://agentsroom.dev/zh/features/mobile-desktop-sync)

## Saved Visual References

The images below are official AgentsRoom assets downloaded from the public site for research reference.

### Main App Overview

![AgentsRoom main app overview](assets/agentsroom/home-og.jpg)

Observed from this image:

- Left side contains project and agent navigation.
- Center contains the active agent terminal and prompt composer.
- Right side contains git/review state: working tree, branch, push/review actions, changed files, commit message, and an "attach agent conversation" option.
- This is the clearest single screenshot for the core three-column app shell.

### Multi-Project / Multi-Agent Cockpit

![AgentsRoom multi-project cockpit](assets/agentsroom/multi-project-cockpit.jpg)

Official feature description confirms:

- Projects are grouped by zone.
- Each project can have multiple agents.
- Each agent has role, avatar, color, provider, system prompt, and status.
- PTY sessions persist across project switching.
- Optional per-agent git worktrees isolate parallel work.

### Backlog Board

![AgentsRoom backlog board](assets/agentsroom/backlog-board.jpg)

Confirmed behavior:

- Four-column board: TODO, In Progress, Pending, Done.
- Dragging a card into In Progress spawns an agent.
- Each In Progress card shows live agent status.
- Cards can carry screenshots, prototypes, or design references.
- Completion goes through diff review before moving to Done.

### Agent Teams Canvas

![AgentsRoom agent teams](assets/agentsroom/agent-teams.jpg)

Confirmed behavior:

- Visual workflow canvas, similar to n8n / React Flow.
- Nodes are agents with role, provider, model, and step instructions.
- Edges are handoffs; conditional edges use flags such as `qaPassed`.
- Dev -> QA -> Dev feedback loops are supported with max-cycle guards.
- Team runs can be attached to backlog tickets.

### Browser Automation

![AgentsRoom browser automation](assets/agentsroom/browser-automation.jpg)

Confirmed behavior:

- Each project can have an embedded Chromium browser.
- Browser state is project-isolated: cookies/localStorage/session per project.
- Agent can operate the browser through Browser MCP: navigate, click, type, screenshot, evaluate, read logs, get page state.
- Intended use: QA agent verifies real localhost flows before claiming completion.

### Dev Terminals

![AgentsRoom dev terminals](assets/agentsroom/dev-terminals.jpg)

Confirmed behavior:

- Per-project command manager.
- Commands are stored in `.agentsroom/commands.json`.
- Can start backend, frontend, workers, database, build logs, etc.
- Supports tabs, splits, detachable terminal windows, remote mobile launch, process status, and AI command generation.

### Per-Agent Review

![AgentsRoom per-agent review](assets/agentsroom/per-agent-review.jpg)

Confirmed behavior:

- Review panel can filter changed files by agent.
- Tabs show agent avatar/name/file count.
- File attribution combines terminal-output parsing and git snapshot comparison.
- Commit can be scoped to one agent's files.
- Files touched by multiple agents can show multiple attributions.

### Commit Context

![AgentsRoom commit context](assets/agentsroom/commit-context.jpg)

Confirmed behavior:

- Agent conversation behind a commit can be captured.
- Conversation is uploaded as an unlisted gist-like artifact.
- Commit message gets an `Agent-Conversation` trailer link.
- Secrets are redacted on a best-effort basis before upload.
- This is meant to preserve "why this code was written", not only the diff.

### Skills Library

![AgentsRoom skills library](assets/agentsroom/skills-library.jpg)

Confirmed behavior:

- Skills are stored in Claude `SKILL.md` style.
- Skills can be attached to tasks or agents.
- On task start, skill bodies can be injected into the agent's first message.
- Skills can be exported to Claude Code, Cursor, Windsurf, Codex, Aider, or generic Markdown formats.

## Product Positioning

AgentsRoom describes the problem as "terminal tab hell": when multiple agents run in different terminal tabs, the user loses track of project, role, status, completion, and pending input.

Its answer is a visual command center:

- one app window,
- many projects,
- many live agents,
- each agent is a real CLI process,
- each agent has durable identity and state,
- all work routes through review and git state.

The product's core claim is not that it makes one agent smarter. The claim is that it makes parallel agent work observable, recoverable, and reviewable.

## Main App Layout

Based on the official screenshot and feature pages, the desktop app shell is a three-column workbench.

### Left Column: Projects And Agents

Contains:

- project list,
- project zones such as Work / Personal / Side Projects,
- current project card,
- project path,
- project quick actions,
- active agent list,
- inactive agent list,
- agent role/avatar/status,
- Add Agent button,
- Add Team button.

Agent list tabs and controls include:

- `Activity`,
- `Groups`,
- filters/sliders,
- quick action/lightning button,
- add button.

Agent cards contain:

- role avatar,
- role name,
- model/provider indicator,
- current status text,
- elapsed or last active time,
- edit/delete controls,
- unread/completion indicators.

### Center Column: Active Agent Terminal

Contains:

- selected agent terminal,
- full terminal output,
- tool-call traces and command output,
- inline code/diff snippets,
- permission or mode status line,
- active model/effort display,
- multiline prompt composer,
- send button,
- prompt/library/sketch/screenshot/HTML/attachment controls.

This is the "real work" surface. The agent itself is not abstracted away into a chat-only UI; users still see the terminal session.

### Right Column: Git / Review / Files

Contains:

- `Working tree` and `History` tabs,
- branch name,
- fetch/pull/push actions,
- review action,
- changed file list,
- staged/unstaged state,
- per-file review markers,
- commit message field,
- option to attach agent conversation to commit.

This panel turns agent output into a code-review workflow. It is important because the product does not assume "agent done" means "ship it".

## Feature Inventory

### 1. Multi-Project / Multi-Agent Cockpit

Confirmed elements:

- all projects shown in one sidebar,
- projects grouped by zones,
- many agents per project,
- agent role colors,
- real-time animated status,
- project-level active/done/stuck counters,
- persistent PTY sessions,
- native desktop notifications,
- mobile push notifications,
- optional per-agent worktree isolation,
- per-agent diff review.

Status states:

- thinking / working,
- done,
- waiting for input / blocked,
- idle.

Status detection is done by parsing real PTY output: tool calls, file writes, prompts, completion signals, and process output.

### 2. Backlog Task Board

The backlog is not just task tracking. It is a launch surface for agents.

Workflow:

1. Create task with title, description, labels, optional screenshot/prototype.
2. Assign agent role.
3. Drag from TODO to In Progress.
4. AgentsRoom spawns a temporary agent with the task title/body as prompt.
5. Agent terminal opens.
6. Card shows live status.
7. Review diff.
8. Move to Done, or leave in In Progress and send more instructions.

Board columns:

- TODO,
- In Progress,
- Pending,
- Done.

For our implementation, this is directly relevant: a spec/plan item should become an executable task card, and moving it to active should create a controlled agent session.

### 3. Agent Teams

Agent Teams is a workflow layer above individual agents.

Core model:

```text
Team
  -> Node(agent role/provider/model/instructions)
  -> Edge(handoff condition)
  -> Run(backlog item or manual start)
  -> Timeline(handoff cards)
```

Confirmed behavior:

- visual canvas based on React Flow-like workflow editing,
- nodes are top-level agent sessions,
- edges pass structured handoff payloads,
- conditions use flags such as `qaPassed`,
- default max-cycle guard is 3,
- shared `NOTES.md` scratchpad,
- role inboxes,
- timeline UI,
- automatic or manual handoff modes,
- team templates such as Dev to QA, Dev to QA feedback loop, Dev to Security to QA.

Handoff payload fields include:

- feature summary,
- changed files,
- touched areas,
- risks,
- test hints,
- flags.

This is close to the user's desired "loop 2 produces plans, loop 3 executes plans" model, but with explicit workflow state and handoff payloads instead of hidden prompt recursion.

### 4. Dev Terminals

Dev Terminals is a project process manager.

Confirmed behavior:

- commands are scoped per project,
- commands are saved in `.agentsroom/commands.json`,
- one-click start all,
- tabs and split panes,
- detachable terminal window,
- remote launch from mobile,
- AI command generation from repo files,
- live status: running, starting, stopped, crashed,
- exit codes shown on failure.

For implementation, this means the controller should track non-agent processes separately from agent PTYs:

```text
Agent PTY != Dev Server PTY != One-shot Command
```

They have different lifecycle, status, and UI.

### 5. Browser Automation

AgentsRoom embeds Chromium per project and exposes it to agents via MCP.

Browser capabilities:

- URL bar,
- back/forward/reload,
- history,
- screenshots,
- open in default browser,
- project-persistent cookies and localStorage,
- console logs,
- browser state query.

MCP tools include:

- `browser_navigate`,
- `browser_click`,
- `browser_type`,
- `browser_screenshot`,
- `browser_evaluate`,
- `browser_get_logs`,
- `browser_get_state`.

Implementation implication: browser automation is not required for the first MVP, but it is the clean path for "agent says done only after verification".

### 6. Review And Git

AgentsRoom treats review as a first-class surface.

Confirmed review features:

- side-by-side diff,
- file review state,
- per-agent filter tabs,
- keyboard navigation,
- progress by reviewed files,
- scoped commits,
- all-files tab,
- files modified by multiple agents show multiple attributions.

File attribution uses two approaches:

- parse terminal output for Edit / Write / NotebookEdit,
- compare git snapshots before and after agent work.

For our implementation, this suggests we should record:

```text
agent_run_id
  start_git_sha
  start_worktree_status
  terminal_event_log
  detected_file_touches
  end_git_diff
```

### 7. Commit Context

Commit Context preserves the agent conversation behind each commit.

Confirmed behavior:

- optional checkbox in commit panel,
- enabled by default,
- captures relevant agent transcript,
- uploads to an unlisted gist-like artifact,
- adds `Agent-Conversation` trailer to commit message,
- provides Markdown and raw transcript,
- redacts common secrets best-effort.

For our use case, this is very relevant. If an executor loop commits code automatically, the commit should include:

- task id,
- plan step id,
- agent run id,
- prompt/spec snapshot,
- verification result,
- transcript path or link.

### 8. Prompt Library

Prompt Library stores reusable prompts per project.

Confirmed behavior:

- project prompt file: `.agentsroom/prompts.json`,
- personal prompts: `.agentsroom/prompts-personal.json`,
- personal prompt file is gitignored,
- folders and tags,
- drag/drop organization,
- quick search,
- send prompt to active agent,
- optional cloud backup.

This maps to our system as a library of launch prompts for planner/executor/reviewer agents.

### 9. Skills Library

Skills Library stores repeatable procedures.

Confirmed behavior:

- canonical format is Claude `SKILL.md`,
- attach skills to task or agent,
- sticky defaults,
- injected when task starts,
- export formats:
  - Claude Code: `.claude/skills/<name>/SKILL.md`,
  - Cursor: `.cursor/rules/<name>.mdc`,
  - Windsurf: `.windsurf/rules/<name>.md`,
  - Codex: managed block in `AGENTS.md`,
  - Aider: managed block in `CONVENTIONS.md`,
  - generic Markdown.

This is directly relevant because the user wants to use existing Codex/Claude Superpowers-like spec/plan plugins. The orchestration layer should not rewrite those workflows; it should attach/inject the right skill context when starting a planning or execution agent.

### 10. Scratchpad

Scratchpad is a bottom-pinned prompt editor.

Confirmed behavior:

- compact mode and large mode,
- autosaves locally,
- survives app restart,
- sends to focused terminal,
- preserves newlines and special characters,
- Cmd+Enter sends,
- can save draft as Prompt Library entry.

This solves a practical issue: composing long prompts inside a terminal is fragile. For our implementation, a multiline prompt buffer should be part of the shell.

### 11. AgentsRoom MCP

AgentsRoom exposes IDE state to agents through MCP.

Confirmed MCP servers:

- Backlog MCP,
- Terminal Commands MCP,
- Prompt Library MCP,
- Browser MCP.

Tools include:

```text
backlog_list
backlog_get
backlog_create
backlog_update

commands_list
commands_get
commands_create
commands_run

prompts_list
prompts_get
prompts_save

browser_navigate
browser_click
browser_type
browser_screenshot
browser_evaluate
browser_get_logs
browser_get_state
```

Security model:

- local-only bridge on `127.0.0.1`,
- OS-assigned port,
- per-start 32-byte hex token.

Design implication: manual UI and agent automation should be two paths over the same domain model. A user can drag a card manually, or an agent can call `backlog_update`.

### 12. Restore Session

Restore Session snapshots the workbench on exit.

Confirmed restore contents:

- AI agents,
- provider,
- role,
- project,
- branch,
- terminal command sessions,
- long-running dev servers,
- opened projects,
- working directories,
- process class,
- command line,
- rollback intent.

This is important because long-running agent systems cannot depend on ephemeral UI memory. State must be persisted.

### 13. Mobile Sync

Mobile app is a remote controller for the desktop session.

Confirmed behavior:

- desktop remains the execution engine,
- mobile sees projects, agents, terminal output, prompts, diffs,
- mobile can start agents,
- mobile can type in terminal,
- mobile can send saved prompts,
- mobile can preview localhost via tunnel,
- E2EE relay with X25519 and XSalsa20-Poly1305,
- desktop must be running.

This is not an MVP requirement for us, but it clarifies the architecture: desktop/backend owns execution; other clients are control surfaces.

## What Is Confirmed Versus Inferred

Confirmed by official pages:

- AgentsRoom spawns real CLI processes locally.
- It supports multiple providers.
- Each agent has isolated PTY session.
- Projects can have multiple agents.
- Status tracking parses PTY output.
- Backlog cards can spawn agents.
- Teams use visual workflow nodes and structured handoffs.
- Dev terminals are saved per project.
- Browser automation is exposed through MCP.
- Review can filter by agent and scope commits.
- Commit Context attaches conversation link to commit.
- Prompt and skill libraries are project-aware.

Inferred from screenshot and bundle names:

- Main shell is a stable three-column layout.
- Domain state likely includes `projects`, `agents`, `commands`, `prompts`, `teams`, `sessions`, `backlogId`.
- Right panel likely switches among working tree, history, review, and possibly file detail.
- Agent terminal and dev terminal are separate but share terminal infrastructure.

## Implications For Building Our Own AgentsRoom-Like System

The user's desired system has three loops:

1. Research + Superworks spec loop: user and/or agent gathers research and maintains target/spec files.
2. Plan loop: watches spec/research and updates plan files in a self-consistent, verifiable structure.
3. Execution loop: watches plan files, modifies code, commits, and asks whether to PR.

AgentsRoom suggests the right implementation boundary:

```text
Orchestrator Shell
  owns:
    projects
    docs/research files
    docs/superworks/spec files
    docs/superworks/plans files
    task queue
    agent sessions
    PTY processes
    git worktrees
    diff/review state
    commit state
    notifications

Agent CLIs
  own:
    reasoning
    code edits
    use of existing Codex/Claude skills/plugins
    execution of instructions inside terminal
```

The shell should schedule and observe. It should not try to become the agent brain.

## Suggested MVP Panels For Our Version

### MVP 1: Workbench Shell

Panels:

- Project sidebar,
- Agent/session list,
- Active terminal,
- Prompt composer,
- Right git status panel.

Data:

```text
Project
  id
  name
  path
  zone
  activeAgentIds

AgentSession
  id
  projectId
  role
  provider
  command
  cwd
  ptyId
  status
  currentTaskId
  createdAt
  lastActivityAt
```

### MVP 2: Research / Spec / Plan Watcher

Panels:

- Research + Superworks spec file browser,
- plan file list,
- plan validation status,
- generated task list.

State:

```text
ResearchDoc
SpecDoc
PlanFile
PlanStep
Task
```

Behavior:

- Watch `docs/research/` and `docs/superworks/spec/`.
- Detect changed files.
- Start planner agent when docs/research or docs/superworks/spec changes.
- Planner agent uses existing superpowers/spec/plan plugin workflows.
- Validate plan format.
- Create/modify tasks from plan steps.

### MVP 3: Executor Agent Loop

Panels:

- Task queue,
- active executor terminal,
- per-task run history,
- verification results.

Behavior:

- Select ready plan step.
- Spawn agent in project or worktree.
- Inject relevant spec/plan context.
- Run implementation.
- Run verification command.
- Capture diff.
- Commit if policy allows.
- Ask user whether to open PR.

### MVP 4: Review And Commit

Panels:

- changed files,
- per-agent file attribution,
- diff view,
- commit message,
- conversation/context attachment.

Behavior:

- Snapshot git state before each agent run.
- Parse terminal output for file touch hints.
- Diff after run.
- Allow commit per task/agent.
- Store transcript path and plan step id in commit metadata.

## Recommended Internal File Layout

For our system, a project could contain:

```text
.agent-workspace/
  project.json
  agents.json
  sessions/
    <session-id>.json
    <session-id>.log
  tasks/
    backlog.json
  plans/
    <plan-id>.json
  runs/
    <run-id>/
      prompt.md
      transcript.log
      diff.patch
      verification.json
      commit.json
  commands.json
  prompts.json
  skills.json
```

User-facing content can stay in:

```text
docs/research/
docs/superworks/spec/
docs/superworks/plans/
```

The orchestrator metadata should be separate and machine-readable.

## Key Design Decisions

### Use Real PTY Sessions

Do not call agent APIs directly for the first version. Use real Claude Code / Codex / Gemini CLI terminal sessions. This matches AgentsRoom and preserves compatibility with each agent's own skills, hooks, MCP, authentication, and local conventions.

### Treat Plans As Durable Artifacts

The plan loop should not keep plans only in memory. Plans should be files, validated and versioned. Each step should be small, testable, and linked to a task/run.

### Let Existing Plugins Do Their Jobs

If Codex or Claude already has Superpowers/spec/plan plugins, the shell should invoke sessions with the correct prompt and context. It should not reimplement those plugins internally.

### Separate Scheduling From Reasoning

The scheduler decides:

- which project,
- which task,
- which worktree,
- which agent role/provider,
- which prompt,
- when to retry,
- when to ask the user,
- when to commit,
- when to notify.

The agent decides:

- code approach,
- exact edits,
- tests,
- internal reasoning,
- plan details within its assigned role.

### Make Review Mandatory Before Trust

AgentsRoom's design strongly suggests that "done" is only a status signal, not a shipping decision. Diff review, verification, and commit context are required for a reliable loop.

## Open Questions For Our Product

- Should every executor agent run in a git worktree by default, or only for concurrent tasks in the same repo?
- Should plan-generation commits be separate from code commits?
- Should executor agents be allowed to commit automatically, or should they create a pending commit proposal?
- Should the spec/plan watcher run continuously or only after explicit user approval?
- Should a task be the same object as a plan step, or should one plan step create multiple tasks?
- How should failed verification be represented: task Pending, task Blocked, or automatic retry loop?
- How much of AgentsRoom MCP should we reproduce first: Backlog and Commands only, or Browser too?

## Practical Build Order

Recommended order:

1. PTY manager: start/stop/read/write real agent CLI sessions.
2. Project registry: path, zone, active sessions.
3. Agent list and terminal UI.
4. Git status/review panel.
5. Research + Superworks spec/plan watcher.
6. Backlog/task board.
7. Planner agent session template.
8. Executor agent session template.
9. Run records and transcript storage.
10. Commit context metadata.
11. Dev command manager.
12. Browser automation.
13. Teams canvas.
14. Mobile sync.

The first useful version does not need Teams Canvas or Mobile Sync. It needs reliable PTY orchestration, file watching, task creation, terminal visibility, git diff, and commit flow.

## Final Product Takeaway

AgentsRoom is useful because it makes agent work visible and accountable. The product is not "AI loop magic"; it is state management around many real agent sessions:

- Who is working?
- On what project?
- With what role?
- What task/spec/plan step?
- What changed?
- Has it been verified?
- Who/what should continue next?
- What context should survive the commit?

That is the model we should copy.

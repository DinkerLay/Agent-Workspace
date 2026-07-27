# Superworks Spec README

Date: 2026-07-26

This directory contains the current product contract for Agent Workspace.
Historical material is kept only as implementation evidence. It must not be
used to revive a second orchestration model, direct Electron-Main PTY ownership,
or an old terminal-text parser.

## Current Implementation Authority

| Spec | Owns | Does not own |
| --- | --- | --- |
| `agent-workspace-architecture-charter.md` | product thesis, one Runtime, owner boundaries, and deferred scope | screen detail or provider queries |
| `agent-loop-v1.md` | the only live product mode: Conductor-controlled native Session Agents, Template CRUD, Task lifecycle, and Workbench model | Workflow/Graph execution |
| `agent-loop-conductor-guidance.md` | Conductor Charter generation, agent-card semantics, user follow-ups, cross-session context references, and no-hidden-route rule | Runtime business decisions or terminal transport |
| `task-template-runtime-model.md` | v1 Template Draft/version, Task Architecture, Task Run, Session, and artifact vocabulary | PTY stream protocol |
| `product-interaction-map.md` | Templates, Tasks Timeline, Workbench, task tabs, native attention, and artifact inspection interaction | MCP payloads or provider database parsing |
| `orca-terminal-runtime-adoption.md` | daemon-owned PTY, snapshot/delta/ACK/backpressure, attach/recovery, and transport receipts | task routing or answer-quality judgment |
| `provider-session-state-detection.md` | OpenCode Adapter facts and Coordinator receipt/result/attention transitions | Conductor next-step selection |
| `development-instrumentation.md` | durable semantic events, diagnostics, redaction, and E2E evidence | live orchestration policy |

## Non-Negotiable Boundaries

```text
Template description
  -> generated editable Loop Template Draft
  -> explicit user save creates a version
  -> Task snapshots that version
  -> Conductor decides zero or more dispatches
  -> Terminal Runtime + Provider Adapter report facts
  -> Coordinator records facts and wakes Conductor
  -> user inspects an artifact and may mark the Task achieved
```

- **Agent Loop is the only current mode.** A Loop Template has a Charter and
  native Agent Cards; it has no graph, nodes, edges, role order, review gate,
  repair route, or automatic completion policy.
- **Conductor is the sole Workspace dispatcher.** Worker sessions remain normal
  OpenCode sessions and never receive Workspace dispatch capabilities.
- **Runtime reports facts, never decisions.** It does not choose a card, retry
  a business task, approve a permission, infer quality from terminal text, or
  decide that a Task is achieved.
- **Orca-style terminal transport is separate from Provider semantics.** A host
  input receipt is not an OpenCode receipt; a Provider result is not an
  artifact-quality verdict.
- **Native permissions/questions stay native.** Runtime records attention and
  wakes Conductor; the user answers in the owning Session terminal.
- **Timeline is semantic.** Raw PTY output is a bounded diagnostic view, not a
  Task conversation or state oracle.

## Change Routing

1. Terminal ownership, snapshot, stream, ACK, reconnect, or input change:
   update `orca-terminal-runtime-adoption.md` first.
2. OpenCode receipt/result/attention detection change: update
   `provider-session-state-detection.md` first.
3. Conductor prompt, Template generation, Agent Card, handoff, or user-message
   behavior: update `agent-loop-conductor-guidance.md` first.
4. Template/Task/Run vocabulary or lifecycle change: update
   `task-template-runtime-model.md` first.
5. Visible Templates, Tasks, artifact, attention, tab, group, or Workbench
   behavior: update `product-interaction-map.md` first.
6. Durable event and verification evidence change: update
   `development-instrumentation.md` first.

## Historical Material

- `spec/archive/2026-06-24-product-interaction-map-board-first.md` — retired
  Board-first interaction proposal.
- `spec/archive/2026-06-28-conductor-session-communication.md` — earlier
  Shell-owned Session Plan draft; superseded by the Agent Loop v1 and
  Conductor Guidance documents.
- `spec/archive/2026-07-25-opencode-nested-workflow-harness.md` — earlier
  nested Workflow harness proposal; superseded by the native Agent Loop path.
- `plans/deprecated/opencode-nested-workflow-harness-v1.plan.md` — historical
  execution plan for that proposal.
- `plans/orca-terminal-runtime-control-plane-v0.plan.md` and
  `plans/terminal-host-orca-migration-v1.plan.md` — migration evidence only;
  `orca-terminal-runtime-adoption.md` is the active Runtime authority.
- `design/archive/2026-07-24-pre-task-architecture/` — superseded visual
  mockups.

Archived documents do not override the current specifications. Runtime machine
state belongs under `.agent-workspace/`, never inside this directory.

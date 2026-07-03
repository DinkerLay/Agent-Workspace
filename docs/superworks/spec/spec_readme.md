# Superworks Spec README

Date: 2026-07-03

This directory contains the active product and runtime specs for Agent Workspace. Research notes are useful inputs, but implementation truth for current product behavior lives in these spec files and the accepted executable plans that reference them.

## Spec Ownership

| Spec | Owns | Does not own |
| --- | --- | --- |
| `product-interaction-map.md` | Visible product surfaces, Task Home / Task Intake behavior, Board-first navigation, Review and audit interaction boundaries | Provider-specific adapter mechanics, Conductor MCP tool internals |
| `conductor-session-communication.md` | Conductor-centric session communication, `call_session` / `read_task_state` / `read_session`, Task Session Plan semantics, Conductor runtime prompt boundary | UI layout details, terminal rendering, provider database schema |
| `provider-session-state-detection.md` | PTY trigger rules, provider adapter state mapping, session-store result extraction, Agent card state source | Task business policy, which workers a task should create |
| `development-instrumentation.md` | Developer trace, product audit events, diagnostic evidence paths | Runtime decision policy, task status truth |

## Cross-Spec Rules

- Task Home creates an editable task draft and card-based Session Agent Plan. `product-interaction-map.md` owns that user interaction.
- Task Home is not a default runtime evidence dashboard. Runtime evidence paths belong in explicit Review, Audit Trail, Run detail, or debug surfaces.
- The confirmed Session Agent Plan is the source for Conductor prompt planning, worker session creation, and target allowlist enforcement. `conductor-session-communication.md` owns that runtime contract.
- Worker sessions remain provider-native. They do not receive Agent Workspace protocol prompts. Provider-native output is interpreted through adapters and Session Store rules from `provider-session-state-detection.md`.
- `call_session` stays generic. Business routing such as research, review, fix, and re-review lives in the Session Agent Plan and the generated Conductor prompt, not in special-purpose tool parameters.
- PTY output is a trigger and live inspection surface, not task-state truth. Agent cards and Conductor wakeups must use provider adapter and Session Store state.
- Runtime routing uses `runtimeProjectId` and `runtimeTaskId`. Display ids, task titles, cluster names, and visible agent names are labels only. New task creation must create a fresh task-scoped session group, and Workbench must not reuse or fall back to sessions from another runtime task.
- Runtime state belongs under `.agent-workspace/`. Product intent belongs under `docs/superworks/spec/` and executable plans under `docs/superworks/plans/`.

## Change Routing

When changing behavior, update the owning spec first:

- UI or task creation flow: update `product-interaction-map.md`.
- Conductor tools, Session Agent Plan, or cross-session communication: update `conductor-session-communication.md`.
- Terminal/provider state detection: update `provider-session-state-detection.md`.
- Debugging, traces, and audit evidence paths: update `development-instrumentation.md`.

If a change crosses multiple specs, keep one source of truth per responsibility and reference the other spec instead of duplicating requirements.

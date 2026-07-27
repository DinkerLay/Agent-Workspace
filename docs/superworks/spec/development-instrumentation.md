# Development Instrumentation And E2E Evidence

Date: 2026-07-26

Status: Accepted current diagnostics contract.

## Purpose

Agent Workspace records small durable facts so a Task can be explained without
turning terminal output into task truth. There are two distinct records:

1. **Semantic Task evidence** — the user-facing Timeline and Task Run facts.
2. **Transport diagnostics** — bounded daemon terminal snapshots/logs and
   low-level traces for debugging a terminal attachment or Provider adapter.

The first is readable product history; the second never drives a business
decision and is redacted before broad export.

## Semantic Event Families

| Family | Examples | Owner |
| --- | --- | --- |
| Task | `task.created`, `task.user_message`, `task.achieved`, `task.archived` | Task store / user |
| Conductor | `conductor.started`, `conductor.decision`, `conductor.delivery_claim` | Conductor tool bridge |
| Dispatch | `dispatch.command.accepted`, `dispatch.input_accepted`, `dispatch.provider.received` | Coordinator |
| Provider | `dispatch.provider.result`, `dispatch.provider.attention`, `dispatch.provider.failed` | Provider Adapter + Coordinator |
| Wakeup | `conductor.wakeup.sent` | Coordinator |
| Terminal | `terminal.created`, `terminal.attached`, `terminal.exited`, `terminal.restore_required` | Orca-style daemon |
| Artifact | `artifact.indexed`, `artifact.opened` | Runtime index / user |

Every event has Task/Run identity, timestamp, actor, compact summary, and a
reference to any durable detail. Events are append-only and idempotent by the
underlying dispatch/session transition. Do not store a raw terminal chunk as a
Timeline event.

## Sensitive Data

- Never persist API keys, environment values, credentials, full hidden prompts,
  or unrestricted shell history in Timeline events.
- Provider result references remain Task-scoped; cross-session transfer occurs
  only from an explicit Conductor result reference.
- Raw PTY diagnostic logs are bounded (currently per Session), local, and
  separate from semantic events. Alternate-screen snapshots are not copied into
  Timeline or Markdown.
- Artifact previews are limited to safe project-relative paths and explicit
  size/type boundaries.

## Required E2E Evidence

The real Agent Loop E2E is not a synthetic state-machine test. It must prove:

```text
one-sentence description
  -> generated editable Template Draft
  -> explicit saved Template Version
  -> Task Architecture snapshot
  -> real Conductor OpenCode Session
  -> real native Worker OpenCode Session
  -> Host input receipt
  -> Provider receipt and Provider result
  -> indexed/checked artifact
  -> user-visible Task state
```

The harness command is:

```sh
npm run desktop:agent-loop-real-generated-e2e
```

It uses `opencode-go/deepseek-v4-flash`, creates a fresh canonical temporary
workspace, generates one Publisher-card Loop Template, explicitly saves it,
starts a Task, verifies the Provider result plus `final.md`, verifies that the
Provider receipt precedes the Conductor delivery claim, and then simulates the
explicit user `achieved` action after inspecting that artifact.

Related focused proofs:

```sh
npm run desktop:agent-loop-real-provider-harness
npm run desktop:agent-loop-real-conductor-harness
AGENT_LOOP_REAL_CONDUCTOR_SCENARIO=correction npm run desktop:agent-loop-real-conductor-harness
npm run desktop:orca-terminal-contract-harness
npm run desktop:orca-terminal-daemon-harness
npm run desktop:orca-terminal-manager-harness
npm run desktop:orca-terminal-electron-harness
npm run desktop:orca-terminal-provider-coordinator-harness
```

Harness time limits are liveness guards for test processes only. They do not
constitute production Task timeouts or retries.

## Failure Recording

When a harness fails, record:

- test command and model/provider version;
- isolated workspace root and Task/Run/Session/dispatch ids;
- the latest semantic events and Provider state, not a huge terminal dump;
- daemon lifecycle/stream diagnostic if the failure is transport-related;
- whether the failure was a Provider-native permission/question, Provider API
  problem, Coordinator reducer problem, Conductor decision, or UI issue.

For an actual native permission/question, the correct conclusion is
`attention`, not “retry automatically”. The E2E must either use a canonical
workspace that needs no permission or model the explicit user response through
the same controlled terminal input surface.

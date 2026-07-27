# OpenCode Nested Workflow Harness v1 Plan

Date: 2026-07-24

Status: Superseded on 2026-07-26. The dynamic Agent Loop correction itself is
historical at `docs/superworks/spec/archive/2026-07-25-opencode-nested-workflow-harness.md`.
The active product scope is `docs/superworks/spec/agent-loop-v1.md` and
`docs/superworks/spec/agent-loop-conductor-guidance.md`.

## Goal

Deliver one real OpenCode-only Agent Loop that starts a nested two-node
Workflow and returns its final result to Conductor, with live Template, Task,
and Workbench interactions. This original plan incorrectly limited the Loop to
that final return. The implemented correction keeps the Workflow bounded, but
requires every later corrective or verification Session result to wake
Conductor before another action is dispatched.

## Work Items

### 1. Durable harness store and runner

- Output: `desktop/runtime/orchestration-harness.cjs` and focused tests.
- Persist seeded template versions, Task Architecture, Task Run, Agent Loop
  Instance, Workflow Instance, and node state in SQLite.
- Build a deterministic runner that launches only approved OpenCode one-shot
  Sessions through Session Authority, parses completed JSON output, and records
  existing Session Store semantic evidence.
- Original verification was insufficient: it proved only final/exception
  Workflow returns. The replacement verification also proves that corrective
  Sessions return to Conductor one at a time and Runtime cannot batch the next
  corrective dispatch.

### 2. Main-process and preload APIs

- Output: `desktop/main.cjs`, `desktop/preload.cjs`, `src/runtime/nativeBridge.ts`.
- Add narrow APIs to list/save templates, create/confirm/start a Harness Task,
  read a Run, and focus a Session/Workflow aggregate.
- Preserve the existing no-arbitrary-command IPC rule.
- Verify: Electron smoke runs a real `opencode run` research/verify sequence.

### 3. Connected product surfaces

- Output: focused Template, Task, and Workbench components plus shell routing.
- Replace the current prototype-heavy visual hierarchy with the approved dense
  desktop shell; all visible actions use the live Harness APIs.
- Do not expose generic graph editing, other providers, or synthetic terminal
  content.
- Verify: UI test creates a Task, starts it, opens Timeline links, selects a
  node Session and Workflow aggregate, and returns to Task Timeline.

### 4. End-to-end proof

- Output: `desktop/opencode-nested-workflow-harness-smoke.cjs`.
- Use the locally installed OpenCode model and the actual PTY Runtime.
- Assert durable ids, both node outputs, no intermediate Conductor wakeup
  inside a bounded Workflow, final Workflow return, and—when a correction is
  needed—one corrective Session return followed by a fresh Conductor decision.
- Verification: the smoke, focused tests, full test suite, and production build.

### 5. Description-to-template generation

- Output: generated Template Draft SQLite records, OpenCode-only planner IPC,
  and Template Builder draft controls.
- OpenCode returns a constrained Agent Loop policy plus a separately validated
  Workflow graph. The Runtime rejects invalid JSON, cycles, invalid
  dependencies, and attempts to serialize Agent Loop policy as graph edges.
- Saving the draft persists distinct Agent Loop and Workflow Template Versions
  plus a user-facing Blueprint Version; only the saved Blueprint can be
  selected for Task Architecture confirmation.
- Verification: focused Runtime tests and desktop UI E2E generate, save the
  Blueprint, select it for a Task, execute, and inspect a real graph through
  OpenCode PTY Sessions.

### 6. Template Builder / Task Assembly boundary

- Output: Blueprint persistence, Template Builder description/manual creation,
  Task Blueprint selector, and revised E2E harness.
- Agent Loop remains a Conductor/session policy; Workflow remains a persisted
  execution graph. Blueprint composes their versions but adds no new Runtime
  execution mode.
- Manual Builder uses a real node drop area and dependency fields, then calls
  the same Runtime Draft validation/save path as generation.
- Verification: focused Runtime test covers manual Blueprint persistence;
  desktop E2E covers generate -> save Blueprint -> Task -> real Run ->
  Workbench terminal.

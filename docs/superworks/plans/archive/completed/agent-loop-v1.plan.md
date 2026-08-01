# Agent Loop v1 Plan

Status: Completed (2026-07-25).

## Success criteria

1. A Template is a Loop Template only and stores editable Session Agent cards.
2. Conductor is the only session with Agent Workspace MCP tools.
3. A worker is launched as native `opencode --mini`; an empty MCP/Skill policy
   means no Workspace-imposed restriction, with model default
   `opencode-go/deepseek-v4-flash`.
4. Conductor dispatches asynchronously and Runtime wakes it only on semantic
   provider/runtime events.
5. Templates support versioned edit/copy/archive/delete. Tasks support
   `delivery_ready -> achieved` without automatic deletion.
6. Task, Template, and Workbench contain no active Graph/Workflow UI.
7. A Template can be created either from a one-sentence description or with
   the manual card editor. Generation produces an unsaved, editable Template
   draft and never starts a Task or Session.

## Steps

1. **Contract and migration**
   - Output: active UI path selects Loop-only Runtime; Workflow Harness stays
     isolated as historical experiment.
   - Verify: no active page copy/DOM selectors expose Graph or Workflow.

2. **Loop template store and agent cards**
   - Output: durable templates/versions, agent-card policy defaults, CRUD
     guards, Task architecture snapshot.
   - Verify: runtime unit tests cover default model, unrestricted policies,
     immutable snapshots, archive/delete guard, and achieved lifecycle.

3. **Event-driven Loop Runtime**
   - Output: task-scoped Conductor profile with MCP, native worker profiles,
     async dispatch, provider-derived result/attention wakeups.
   - Verify: fake provider harness proves parallel dispatch and each semantic
     result creates one Conductor wakeup without a Graph runner.

4. **Product surfaces**
   - Output: Loop Templates, Task Timeline, Workbench Session rail.
   - Verify: Electron surface smoke plus browser read-only visual QA; one
     native OpenCode smoke validates terminal ownership and route continuity.

## Completion record

- The active desktop path is Agent Loop only. Historical Workflow Harness
  code remains isolated and is not reachable from Task, Template, or
  Workbench.
- Template versions snapshot Session Agent cards (model, MCP and Skill
  policy, instructions, default output) into each Task. `[]` means the card
  imposes no restriction; the default model is
  `opencode-go/deepseek-v4-flash`.
- The Template card is the stable capability boundary. Each Conductor
  `call_session` / `call_sessions` dispatch adds a durable per-turn contract:
  bounded goal, inputs, acceptance criteria, and expected output. Runtime
  rejects targets outside the Task's snapped cards.
- Workers are native OpenCode `--mini` sessions. They receive no Workspace
  MCP or injected Workspace prompt; the Conductor alone receives the scoped
  MCP bridge.
- PTY/provider readiness is event-driven. A dispatch remains queued until a
  native terminal is ready; there is no fixed delivery timeout. Result,
  failure, permission, and question states cause one deduplicated Conductor
  wakeup.
- A final artifact may be previewed as Markdown/HTML/text. The lifecycle is
  `queued -> running -> delivery_ready -> achieved`; achieved retains history
  and never deletes the Task.
- The Template page starts with a description-first drawer and keeps a manual
  editor path. The Task drawer can hand its entered goal to that generator;
  after the user saves the generated Template version, the original Task
  drawer is restored with the new Template selected. This is a real OpenCode
  generation request followed by explicit user save, not a mock or a hidden
  Task start.

Verification completed:

```text
node --test desktop/runtime/agent-loop-v1-runtime.test.mjs
npm run build
npm test -- --run                         # 106 files, 751 tests passed
npm run desktop:agent-loop-ui-smoke
npm run desktop:harness-surface-smoke
git diff --check
```

Follow-up verification for the description-first Template path:

```text
npm test -- --run desktop/agent-loop-template-assistant.test.mjs desktop/runtime/agent-loop-v1-runtime.test.mjs src/runtime/nativeBridge.test.ts
npm run desktop:agent-loop-ui-smoke  # Template → generate → save, and Task → generate → save → return
```

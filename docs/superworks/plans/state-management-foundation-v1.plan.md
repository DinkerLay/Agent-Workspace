# State Management Foundation v1

Date: 2026-08-02

Status: Active. The production owner seam, Task/Run transaction boundary and
pure read-model foundation are implemented. Physical Session Store extraction
and a durable Dispatch command ledger remain; the alternate-buffer wheel UI
smoke failure is tracked by the continuity regression plan.

## Goal

让 Template、Task/Run、Dispatch、Terminal 和 Provider 各自拥有自己的事实，
通过纯 read model 汇总给 Renderer，消除通用 Store、通用 Event API 和页面缓存
冒充状态源的问题。

Authoritative inputs:

- `../spec/task-template-runtime-model.md`
- `../spec/code-ownership-and-layer-map.md`
- `../spec/task-run-continuity-and-terminal-experience.md`
- `../spec/opencode-provider-adapter-orca-alignment.md`

## Invariants

1. 一个事实只有一个 durable writer；其他副本必须标记为可重建投影。
2. Renderer 发送 command，不追加或伪造 Runtime event。
3. Template Draft、Template identity、Template Version 和 Task Architecture 是不同对象。
4. Task/Run 状态只能通过集中 transition guard 修改。
5. Read model 不得写数据库、启动 Session 或修复状态。
6. 跨存储副作用需要 idempotency key 和可恢复的 durable intent/outbox。

## Phases

### Phase 1 — owner seams

Implemented:

- `loop-template-store.cjs` owns active Loop Template CRUD and normalization;
- `agent-loop-state-model.cjs` defines Task/Run status vocabulary and Task transition guards;
- active Task composer submits `sendAgentLoopTaskMessage`, not a generic append-event call;
- `achieved` requires `delivery_ready` in Runtime and Renderer;
- transient `stopping` / `deleting` projections are typed explicitly.

Verification:

```text
node --test desktop/runtime/agent-loop-state-model.test.mjs \
  desktop/runtime/loop-template-store.test.mjs \
  desktop/runtime/agent-loop-v1-runtime.test.mjs
```

### Phase 2 — Task/Run transaction boundary

Implemented:

- `task-run-repository.cjs` is the only normal Task/Run SQL writer and owns
  command ledger, optimistic revisions, Run events, and Task Timeline outbox;
- `task-run-service.cjs` owns Start, Continue, Delivery Claim, Achieve, Stop,
  Delete, and recovery lifecycle semantics behind the existing Runtime facade;
- Renderer commands carry a stable `commandId` and `expectedRevision`; a retry
  replays the original result instead of applying a second mutation;
- Session Store deduplicates outbox publication by `sourceEventId`, including a
  crash after JSONL append but before SQLite marks the outbox published;
- Delivery Claim now commits Task `delivery_ready`, the Run decision and its
  `task.completion_claim` Timeline outbox in one Task/Run transaction; the
  Conductor bridge no longer writes a second claim directly;
- Start, Stop and Delete persist `prepared` command intent before native or
  filesystem side effects; Runtime startup enumerates and reconciles those
  commands, while Delete commits the DB tombstone only after Runtime-owned
  directories are removed;
- Template archive metadata now lives in `agent_loop_templates`; immutable
  `agent_loop_template_versions` rows no longer contain identity archive state.

Completion criteria:

- crash-point tests cannot produce a Timeline message without its command, or a status change without its lifecycle event;
- invalid Task/Run transitions fail before any side effect;
- existing Runtime and Electron UI smoke tests pass.

Verification:

```text
node --test desktop/runtime/task-run-repository.test.mjs \
  desktop/runtime/task-run-service.test.mjs \
  desktop/runtime/agent-loop-v1-runtime.test.mjs
npx vitest run desktop/session-store.test.mjs src/runtime/nativeBridge.test.ts
```

### Phase 3 — fact stores and projection

Implemented:

- `session-store-capabilities.cjs` exposes frozen read-model, Task Timeline,
  Coordinator, Provider, and Terminal capability views; active Electron
  composition no longer hands the raw multi-writer Store to production owners;
- `task-run-read-model.cjs` projects typed Task/Run, Coordinator, Provider, and
  Terminal facts without persistence or callbacks;
- active Terminal and Provider writers persist separate `terminalState` and
  `providerState` facts; Dispatch records remain Coordinator-owned and the
  combined `state` is only a read-model projection;
- production Main/Preload no longer registers the historical
  Workflow/Blueprint Harness surface;
- `readRun()` projects a default Workbench layout without writing it;
- Renderer refreshes after initial load, command results, and semantic Runtime
  invalidations; the previous three-second Task/Run polling loop is removed.

Completion criteria:

- no module outside an owner can call its fact mutation methods;
- rebuilding the read model does not write files or databases;
- restart harnesses prove no duplicated dispatch, lost wakeup or false Task transition.

Verification:

```text
node --test desktop/runtime/session-store-capabilities.test.mjs \
  desktop/runtime/task-run-read-model.test.mjs \
  desktop/runtime/agent-loop-v1-runtime.test.mjs
npx vitest run desktop/runtime/dispatch-coordinator.test.mjs \
  desktop/conductor-tool-bridge.test.mjs \
  desktop/session-wakeup-monitor.test.mjs \
  desktop/session-store.test.mjs
npm run desktop:agent-loop-continuity-recovery-harness
```

The direct raw-Store calls in test fixtures and historical harnesses are test
setup, not active product composition. Any production migration of those
historical paths must introduce the same scoped capabilities before activation.

### Remaining foundation work

- extract Coordinator, Provider projection and Terminal facts from the shared
  physical `session-store.cjs` compatibility container without changing their
  public read model;
- give Dispatch commands their own durable idempotency/optimistic-concurrency
  ledger instead of relying only on generated dispatch ids and record-level
  deduplication;
- remove the deprecated generic `recordState` after historical Harnesses and
  fixtures use explicit owner writers;
- close the separately tracked live alternate-buffer terminal wheel regression
  before declaring the overall foundation plan complete.

## Verification record — 2026-08-02

- `npm run verify`: passed; 128 test files / 902 tests, TypeScript, production
  Vite build, real OpenCode Dispatch receipt simulation, and Delivery Claim
  outbox simulation all completed successfully;
- `npm run desktop:agent-loop-continuity-recovery-harness`: passed;
- focused owner/restart suite: 10 files / 166 tests passed, including prepared
  Stop restart reconciliation and replay-safe Delete failure recovery;
- residual build note: Vite reports an existing bundle chunk above 500 kB;
  this is a performance warning, not a state-management verification failure.

## Non-goals

- one giant database or one universal application status;
- moving Terminal/Provider decisions into Task Service;
- reviving Workflow, Graph or Template Blueprint;
- a cosmetic repository-wide move without owner tests.

# Agent Loop Conductor Autonomy Rework v1

Date: 2026-07-26

Status: Implemented and verified on 2026-07-26.

## Goal

Make the active Agent Loop a genuine Conductor-driven loop. Runtime remains an
asynchronous native-Session substrate and must no longer impose business
routing, repair, review, or completion policy.

Authoritative product intent:
[`../../../spec/agent-loop-conductor-guidance.md`](../../../spec/agent-loop-conductor-guidance.md).

## Success Criteria

1. A Template saves an editable Conductor Charter plus native Session Agent
   Cards; it has no executable route or role-ordering policy.
2. Each Conductor turn receives the platform Base Prompt, the saved Charter,
   current Task intent, durable history, and pending user messages.
3. Runtime records a worker semantic result and wakes Conductor, but selects
   no repair, review, publication, research, or completion action itself.
4. A Task Timeline composer sends a durable user message to Conductor and
   visibly produces the next Conductor decision or question.
5. A real native OpenCode DeepSearch harness demonstrates Conductor-selected
   follow-up after a worker return and after a user challenge.

## Work Items

### 1. Remove business routing from Runtime

- Goal: delete remediation-phase state, Reviewer-to-Publisher routing, and
  skipped-phase completion rejection from the active Agent Loop path.
- Inputs: current Runtime state, Conductor MCP bridge, and associated tests.
- Output: Runtime events describe facts only: dispatch, delivery, provider
  result, failure, attention, observed artifact, user message, and user
  achieved action.
- Verification: a `needs_changes` result produces one Conductor wakeup and no
  outbound worker dispatch until the Conductor calls dispatch.

### 2. Persist and inject the Conductor Charter

- Goal: add `conductorCharter` to a Template version and Task snapshot;
  preserve it in one-sentence generation, manual editing, copying, and version
  history.
- Output: the active Conductor prompt is the Base Prompt + Charter + Task
  state, not a generated workflow policy.
- Verification: focused Template/Prompt tests prove editing the Charter
  changes a fresh Conductor incarnation and cannot create a route graph.

### 3. Make Task conversation a real Conductor input

- Goal: add the Timeline composer and a wakeup path for `task.user_message`.
- Output: a user can challenge an earlier Search result without interacting
  with a worker terminal; the next action is visibly authored by Conductor.
- Verification: Electron smoke sends a message, asserts the durable event,
  Conductor wakeup, and a later Conductor decision.

### 4. Preserve native workers and factual Runtime boundaries

- Goal: verify workers receive normal bounded OpenCode assignments only;
  Runtime uses Provider Adapter facts rather than terminal text or custom
  worker protocols.
- Verification: real Provider harness proves worker return -> durable event ->
  Conductor wakeup; no Runtime rule selects a target card.

### 5. Update visible language and migration

- Goal: remove UI copy and historical tests that promise automatic
  Publisher/Reviewer repair routes. Existing Task snapshots remain readable;
  new Template versions use the Charter model.
- Verification: `rg` finds no active Agent Loop copy or test assertion for
  automatic role routing; active UI exposes no Graph/Workflow language.

### 6. Preserve semantic result handoff and delivery-claim continuation

- Goal: let Conductor cite a completed native Session result in a subsequent
  dispatch without rephrasing it, and let an explicit post-claim dispatch
  continue the same Task.
- Output: `result:<resultId>` resolves only within its Task, snapshots the
  exact Provider semantic answer into the new dispatch, and makes it visible
  in the target native Session assignment and Task Timeline. `delivery_ready`
  becomes `running` only because Conductor explicitly dispatches again; Runtime
  never selects that target or route.
- Verification: focused Runtime tests reject an unknown result and prove exact
  context snapshotting; the control-plane harness proves the target PTY sees
  the prior result verbatim.

## Out Of Scope

- Graph/Workflow execution or a visual graph editor.
- Worker-to-worker Workspace routing.
- A Runtime factual-truth or evidence-quality judge.
- External GitHub/Copilot task integration.

## Completion Evidence

Run focused Runtime/Prompt/Template tests, the native Provider harness, the
Electron Agent Loop UI smoke, `npm run build`, and `git diff --check`. Record
the exact commands and results in this plan when the implementation is
complete.

### 2026-07-26 implementation record

- `npm test -- --run` — 110 files / 777 tests passed.
- `npm run desktop:agent-loop-control-plane-harness` — passed. It proves
  semantic worker return, Conductor-owned second dispatch, and a durable user
  follow-up delivered to the same ready Conductor PTY.
- `npm run desktop:agent-loop-ui-smoke` — passed. It creates a Template and
  Task, starts the native terminal workbench, posts through the Timeline
  composer, and observes the durable user message.
- `npm run desktop:agent-loop-real-provider-harness` — passed against
  `opencode-go/deepseek-v4-flash`; native PTY initial and follow-up Provider
  turns both completed with `stepFinishReason: stop`.
- `npm run build` and `git diff --check` — passed.

### 2026-07-27 control-plane state-ownership correction

- A Conductor delivery claim now changes only the user-facing Task lifecycle
  to `delivery_ready`; the logical Run remains live until a user closes it or
  archives it. A later explicit Conductor dispatch changes the Task back to
  `running`, with no Runtime-selected route.
- Explicit semantic handoff is strict and generic: `contextRefs` is either
  absent or a list of same-Task `result:<resultId>` references. Invalid input
  fails the requested dispatch; Runtime does not parse JSON-like text from an
  ordinary assignment or silently drop a reference.
- Session Store now publishes durable semantic invalidations without publishing
  raw PTY output. Electron Main forwards only an invalidation to Renderer,
  which re-reads the Run. Workbench shows dispatch/provider status separately
  from Terminal Host liveness.
- Verification completed:
  - `npm test -- --run desktop/session-store.test.mjs
    desktop/runtime/agent-loop-v1-runtime.test.mjs
    src/runtime/nativeBridge.test.ts` — 5 files / 72 tests passed.
  - `npm run desktop:agent-loop-control-plane-harness` — passed.
  - `npm run desktop:orca-terminal-provider-coordinator-harness` — H3 passed:
    daemon-owned PTY input, Provider receipt/failure facts, and exactly one
    Conductor wakeup without Runtime retry.
  - `npm run desktop:agent-loop-ui-smoke` — H2 passed: Electron xterm renders
    a daemon-owned native Session through snapshot/delta/ACK.
  - `npm run desktop:agent-loop-real-review-handoff-e2e` — real OpenCode E2E
    completed: Searcher draft → Reviewer `needs changes` → Conductor-selected
    correction Searcher → Reviewer pass → Publisher. Its final artifact
    contains `AGENT_LOOP_REVIEW_HANDOFF_OK`.
  - `npm run build`, `npm test -- --run` — 110 files / 784 tests passed — and
    `git diff --check` passed.

### 2026-07-26 continuation record

- `npm test -- --run desktop/runtime/agent-loop-v1-runtime.test.mjs
  desktop/conductor-tool-bridge.test.mjs desktop/session-store.test.mjs
  src/orchestration/conductor-tools/types.test.ts` — 7 files / 88 tests
  passed. It verifies post-claim Task continuation plus same-Task
  `result:<resultId>` resolution and rejects an unknown result.
- `npm run desktop:agent-loop-control-plane-harness` — passed. It verifies a
  Researcher Provider answer receives a durable result id, then the Writer's
  native PTY sees that exact answer from a cited `result:<resultId>`. It also
  verifies a dispatch after `delivery_ready` resumes the same Task rather than
  failing as a non-running Loop.
- `npm run desktop:conductor-tool-smoke` — passed.
- `npm run desktop:agent-loop-ui-smoke` — passed.
- `npm test -- --run` — 110 files / 778 tests passed.
- `npm run build` and `git diff --check` — passed.

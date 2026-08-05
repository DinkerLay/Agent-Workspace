# Agent Workspace Architecture Charter

Date: 2026-07-23

Status: Draft for review.

## Purpose And Authority

This charter defines the durable architecture decisions for Agent Workspace. It
does not replace the detailed product, communication, provider-state, or audit
specifications. It answers the decisions those specifications must share:

- what product is being built;
- which component has execution authority;
- how Agent Loop and Workflow differ;
- which state must be durable and reviewable;
- which boundaries must remain provider-native and human-supervised.

If a detailed specification conflicts with a decision in this charter, amend
that detailed specification before implementing the conflicting behavior. This
charter does not itself change runtime behavior or authorize implementation.

## Product Thesis

Agent Workspace is a local-first, human-supervised workbench for carrying one
task through persistent provider-native agent sessions until its delivery is
reviewed and evidenced.

It is not:

- a repeated prompt loop;
- a terminal multiplexer with no durable task state;
- a generic multi-agent framework that requires users to program every graph;
- an Orca clone or a cloud PR robot.

The product differentiates itself by combining a visible Conductor, durable
session and evidence state, provider-native workers, and artifact-gated
delivery. Human acceptance is a final inspection of actual outputs, not a
manual relay for routine verifier findings.

## Architectural Planes

Agent Workspace has one authoritative local **Execution Runtime**. It may run
as one Runtime Daemon process in the first version. There must not be a second
runtime with competing authority over a Workspace Session, PTY, dispatch, or
durable state.

Within that runtime, Workflow execution is a logical engine rather than a
second execution owner.

```text
Product Plane
  Board, Task Intake, Workbench, Review, Audit Trail, human decisions

Orchestration Plane
  Agent Loop driver | Workflow runner | deterministic policy validation

Execution Runtime
  Session authority | launch profiles | PTY execution | input arbitration
  provider adapters | dispatches | wakeups | recovery | event persistence

Provider-native Sessions
  OpenCode, Claude Code, Codex, and their internal tools or subagents
```

The Product Plane never owns a physical PTY. The Conductor never owns process
creation. Provider-native sessions never become Agent Workspace protocol
engines merely because they are workers in a task.

## Ownership Model

| Component | Owns | Must not own |
| --- | --- | --- |
| Product Plane | user intent, Task Intake, user decisions, Review approval, visible task state | PTY lifecycle, provider answer parsing, implicit task completion |
| Conductor | task-level reasoning, delegation choice, follow-up choice, proposed graph changes, delivery-readiness claim | direct PTY spawn, direct raw PTY write, direct mutation of runtime state |
| Orchestration Plane | mode selection, ready-node calculation, route and policy validation, wakeup eligibility | provider-specific semantic state extraction, agent reasoning |
| Execution Runtime | Session identity, Launch Profile resolution, claim-or-spawn, PTY lifecycle, dispatch delivery, input ordering, recovery, durable facts | task-level reasoning, review approval |
| Provider Adapter | provider-native input readiness, turn state, permission state, answer or artifact extraction | product routing policy, UI state, Conductor decisions |
| Review | verification, diff scope, evidence review, approval to Done | agent execution, hidden retries |

The Scheduler and Execution Runtime are deterministic services. The Conductor
is an agent that reasons over durable evidence and proposes actions inside the
policies enforced by those services.

## Two Orchestration Modes

Agent Workspace supports two distinct modes over the same Execution Runtime.
They must not be conflated.

### Agent Loop

`agent_loop` is the default task mode for open-ended work, investigation,
iteration, and tasks whose next action cannot be known safely in advance.

```text
Conductor delegates to a Session
  -> Runtime records and delivers the dispatch
  -> Provider Adapter records a result, attention state, or failure
  -> Runtime creates an Inbox/Wakeup event for Conductor
  -> Conductor reads the durable evidence and decides the next action
  -> Runtime validates and performs the next dispatch or session action
```

In Agent Loop mode, each meaningful worker result is available to the
Conductor. Runtime may deduplicate or coalesce equivalent low-priority events,
but it must not silently bypass the Conductor's task-level decision point.
There is no requirement to precompile a complete execution graph.

### Workflow

`workflow` is an explicit graph-execution mode for bounded, repeatable, and
policy-defined processes.

```text
Instantiate a Graph
  -> Runtime calculates ready nodes
  -> Runtime provisions or wakes eligible Sessions
  -> nodes run and publish durable outputs
  -> completed nodes unlock their declared successors
  -> a Decision, Approval, Exception, or Final node wakes Conductor
```

Workflow does not wake the Conductor after every node by default. It returns to
the Conductor only through declared decision points, policy exceptions, or
workflow completion. This makes a Workflow useful for deterministic fan-out,
joins, verification matrices, and review gates without hiding state changes.

### Hybrid Composition

Hybrid is composition, not a third Runtime:

- an Agent Loop may dispatch a bounded Workflow and receive its completion as
  one Conductor decision event;
- a Workflow may contain an explicit Conductor decision node that proposes a
  validated graph change before execution continues.

The first implementation should make `agent_loop` the default and introduce
Workflow only when a concrete reusable graph and its verification rules are
defined. It must not expose an ambiguous automatic hybrid mode.

## Template, Task Architecture, And Runtime Objects

These are different durable objects with different reuse rules. Detailed
definitions live in `task-template-runtime-model.md`.

| Object | Purpose | Reuse rule |
| --- | --- | --- |
| Agent Loop Template | reusable Conductor/session-management policy: session-role catalog, allowed demands, return/wakeup, stop, review, budget, and concurrency rules | versioned and selected or proposed for a new task; never an executable graph by convenience |
| Workflow Template | reusable graph skeleton, node kinds, dependencies, policy gates, and parameter schema for a known task class | versioned and selected or proposed for a new task |
| Template Draft | assistant- or user-authored proposed template before confirmation | becomes a one-off Task Architecture or an explicitly saved version; does not execute |
| Task Architecture | user-confirmed task snapshot of intent, one primary mode, template provenance, Session Plan, and policy bounds | task-owned and immutable except through recorded amendment |
| Task Session Plan | approved Session inventory, roles, Launch Profiles, route allowlist, permissions, worktree policy, and budget guidance | part of one confirmed Task Architecture |
| Agent Loop Run or Workflow Instance | task-scoped live orchestration state: decision/event state for Agent Loop, graph/node state for Workflow | never reused as a live task state |

A similar task may reuse a Template Version. It must not automatically reuse
another task's active Session, dispatch, provider context, result, or completed
node state. Evidence may be cited or explicitly cached only when its validity
and scope are declared.

In the first version, a Task Session Plan remains the source of truth for which
sessions may be launched and which routes may be used. A Workflow cannot create
an unapproved provider, model, permission profile, worktree policy, or target
session by bypassing that plan.

## Graph And Dynamic Planning Boundary

Graph is control state, not an alternative name for a long prompt. A future
Workflow specification must define at least:

- node kinds such as `delegate`, `join`, `decision`, `verify`, `review`, and
  `finalize`;
- dependency and conditional edges;
- node input and output artifact references;
- node status, attempt, retry, cancellation, and evidence requirements;
- explicit decision points that may wake Conductor;
- an append-only `GraphPatch` history with author, reason, and validation
  result.

Natural-language assignment text remains attached to a Session dispatch or
node. It explains what a provider-native agent should do. The graph expresses
only execution semantics: what can run, what must wait, what evidence is
required, and when control returns to the Conductor.

Conductor may propose a Graph Patch, such as adding an independent verifier or
retrying a failed node. The Orchestration Plane validates the patch against the
Task Session Plan, workflow policy, budget, concurrency limit, and review
requirements before persisting and applying it. Conductor must not mutate the
graph store directly.

## Dynamic Session Demand

Neither Conductor nor a Workflow node directly spawns a process. Both create a
validated request for an eligible Session.

```text
Need identified by Conductor or ready Workflow node
  -> Session Demand: role, required capability, allowed profiles, isolation,
     worktree, priority, and reason
  -> Runtime validates Task Session Plan, policy, budget, and concurrency
  -> reuse an eligible idle Session, wake a sleeping Session, or create an
     approved Session from its Launch Profile
  -> record the resulting Session binding and Dispatch
  -> Provider Adapter confirms delivery and later records the semantic result
```

If no compatible approved profile exists, liveness is unknown, the route is
forbidden, or a new permission/budget decision is required, Runtime must fail
closed and surface a recoverable decision. It must not guess a command,
provider, model, or worktree and create a replacement process.

## Execution Runtime Invariants

The following invariants are required before broad multi-agent automation:

1. Execution Runtime is the only component allowed to create, adopt, write to,
   resize, stop, or retire a PTY.
2. A Workspace Session, Provider Session, PTY, PTY Incarnation, Terminal
   Surface, and Dispatch have separate identities.
3. Repeating one activation operation cannot create a second physical Session.
4. A late event from an old PTY Incarnation cannot retire or alter its
   replacement.
5. Unknown liveness is not proof of process death; unknown states fail closed.
6. User input, dispatches, wakeups, startup prompts, and permission replies
   pass through one ordered input boundary with idempotency and expected-state
   checks.
7. Worker semantic results come from a Provider Adapter and durable evidence,
   not terminal idle, terminal text, or an agent's unverified claim.
8. Runtime recovery reconciles durable identity with physical state before it
   creates a replacement Session.
9. `dispatchId` is the task-scoped communication key across delivery, result,
   wakeup, evidence, and UI.
10. A completion claim cannot make a task Done; Runtime-observed artifact and
    verification evidence remain required. Human acceptance inspects those
    outputs and does not replace an available remediation loop.

## Durable State And Evidence

Correctness-critical Runtime state must be transactional and recoverable. This
includes Session authority, activation operations, PTY incarnations, input
operations, dispatches, wakeup jobs, workflow instances, and graph patches.

SQLite is the target system of record for this transactional state. Existing
JSONL files remain useful for append-only audit exports, diagnostic traces, and
human-readable evidence. Migration must be incremental: do not replace a
working evidence path until the corresponding SQLite record, migration,
reconciliation path, and verification tests exist.

Raw PTY output remains a bounded live diagnostic surface. It is not the source
of truth for task state, worker answers, or workflow transitions. Large
artifacts and provider-extracted answer bodies are stored once and referenced
from compact events and graph nodes.

## Human Authority, Safety, And Review

The user confirms Task Session Plans, resolves new authority or budget
decisions, handles high-risk permissions, and accepts or rejects the final
artifact set. The runtime may automate only actions already permitted by the
confirmed task policy.

Completion requires more than an agent claim:

```text
artifacts exist
  + required provider result or artifact evidence exists
  + verification is recorded
  + user accepts the concrete artifact set
  = Done
```

Agent Loop, Workflow, and recovery code must preserve this same Review gate.

## Orca Adoption Boundary

Orca is a source of Runtime design evidence, not the product architecture to
copy. The adoption work should focus on independently adaptable mechanisms:

- `create-or-attach` and claimed Session ownership;
- PTY incarnation handling and late-exit protection;
- startup reconciliation and Session adoption;
- process supervision and bounded terminal output;
- reliability tests for duplicate creation, stale events, and recovery.

Each borrowed design or code path must have a source mapping, adaptation note,
test coverage, and MIT license notice when code is copied. Product-level Orca
features, fixed Task DAG behavior, broad provider integrations, SSH relay,
mobile, browser automation, and interface branding are not in the first
adoption scope.

## Delivery Scope And Sequencing

The delivery sequence is deliberately foundation-first:

1. establish Session identity, PTY incarnation, and authoritative execution
   ownership;
2. add Daemon claim-or-spawn, operation replay, process supervision, and input
   ordering;
3. migrate correctness-critical state and recovery to transactional storage;
4. make Agent Loop durable end to end: dispatch, provider result, Conductor
   wakeup, artifact inspection, and user-achieved action.

Workflow/Graph remains a separate future proposal. It has no implementation
slot until the Agent Loop Runtime and native-session recovery have durable E2E
evidence; no current plan may use it as an intermediary implementation step.

Deferred until the Runtime invariants are proven: broad provider matrices,
cross-host execution, SSH relay, mobile control, browser automation, open
worker-to-worker routing, and complex visual workflow editing.

## Specification Routing

This charter owns cross-cutting architectural decisions. Detailed behavior
remains in the active specifications:

- `agent-loop-v1.md`: current Conductor-controlled native Session scope and
  product lifecycle;
- `agent-loop-conductor-guidance.md`: Charter, prompt, Agent Card, and
  Conductor-only dispatch rules;
- `task-template-runtime-model.md`: v1 Template, Task Architecture, Task Run,
  Session, and future-compatibility vocabulary;
- `product-interaction-map.md`: Task creation, Templates, Tasks Timeline,
  Workbench, and user-visible execution state;
- `orca-terminal-runtime-adoption.md`: daemon-owned terminal transport,
  snapshot/ACK/recovery, and transport receipts;
- `opencode-provider-adapter-orca-alignment.md`: current Provider Adapter facts,
  exact bindings, result/attention extraction, and Coordinator wakeups;
- `development-instrumentation.md`: semantic audit, diagnostics, E2E evidence,
  and redaction;
- a future Workflow Runtime specification: Graph schema, template versioning,
  graph state transitions, Graph Patch validation, and Workflow Runner rules.

Historical research and deprecated plans are inputs and audit records. They do
not override this charter or active detailed specifications.

## Acceptance Criteria For Follow-On Specifications

A follow-on Runtime or Workflow specification is ready for implementation only
when it can answer all of the following:

- Which orchestration mode owns this task path, and where does control return
  to Conductor?
- Which durable object owns each identity and state transition?
- Which policy validates a Session Demand, dispatch, retry, or Graph Patch?
- Which Provider Adapter fact proves a worker result or attention state?
- Which recovery behavior applies when liveness, delivery, or result state is
  unknown?
- Which evidence and Review rule proves delivery rather than merely an agent
  completion claim?

# Agent Loop Conductor Guidance

Date: 2026-07-26

Status: Accepted product guidance for the next Agent Loop rework.

## Purpose

This document resolves an important boundary error in earlier Agent Loop v1
material: an Agent Loop must not be compiled into a hidden Workflow by Runtime
policy. In particular, Runtime must not turn agent roles, review outcomes,
evidence counts, or declared artifacts into a prescribed sequence of dispatch
steps.

This document supersedes the former remediation-routing language in
[`agent-loop-v1.md`](agent-loop-v1.md). It is the authority for Conductor
prompt composition, Template generation, user intervention, and the division
between Conductor reasoning and Runtime mechanics.

## The Agent Loop

```text
user task or user follow-up
  -> Runtime wakes the logical Conductor
  -> Conductor reads durable Task state and decides what to do
  -> Conductor may dispatch zero or more native Session Agents
  -> Runtime runs them asynchronously and records provider-derived facts
  -> a meaningful result, failure, attention, or new user message wakes Conductor
  -> Conductor makes the next decision
```

There is no hidden route such as:

```text
research -> publish -> review -> repair -> re-review
```

That is a Workflow. A Template may recommend a research, publishing, or review
style, but the Conductor decides the order, number of turns, target cards,
retries, and closeout in the context of each Task. No Template field creates a
Publisher, Reviewer, or other card prerequisite at Runtime.

## Ownership Boundary

| Owner | Responsibility | Must not do |
| --- | --- | --- |
| User | sets task intent, sends follow-ups, inspects delivered files, marks a delivery achieved | type hidden orchestration protocol into a worker terminal |
| Conductor | reads state, interprets results, answers the user, and is the sole dispatcher of Workspace Session Agents | personally perform a worker-owned research, edit, verification, or delivery task |
| Native Session Agent | performs one bounded assignment using its normal OpenCode tools and returns its normal provider result | dispatch another Workspace Session or understand Workspace routing protocol |
| Runtime | owns Session/PTY lifecycle, persistence, provider inspection, semantic event delivery, and Conductor wakeups | choose the next worker, classify a business defect, enforce a task route, or judge task correctness |

The sole-dispatcher property is achieved by capability distribution: only the
Conductor receives the Workspace dispatch bridge. It is not a Runtime policy
engine that decides *which* card should be called or *when* it is appropriate
to call it.

## What Is And Is Not Durable Template Policy

A Loop Template is a versioned prompt-and-capability seed, not an executable
plan.

```text
Loop Template vN
  -> Conductor Charter
  -> native Session Agent Cards
  -> provider defaults (model, MCP, Skills)
  -> optional review handoff policy
  -> optional delivery preferences
```

It must not persist graph nodes, edges, phase counters, required counts,
role-ordering rules, remediation routing rules, dispatch prerequisites, or
completion gates.

### Conductor Charter

The Charter is generated from the user's natural-language collaboration brief
and remains editable before the Template version is saved. It is the sole
Template-level human-readable orchestration field: it is snapshotted into a
Task and injected into every Conductor incarnation. It gives the Conductor an
operating method, not an executable path. It can describe:

- the kind of task and expected quality;
- useful ways to divide work among available Session Agent Cards;
- preferred evidence, artifact, and communication practices;
- when to ask the user rather than assume;
- domain-specific risks worth revisiting after an Agent returns.

It must not use imperative route language such as “always call A then B”,
“wait for three researchers”, “only Publisher may repair”, or “Reviewer pass
automatically completes the task”. Those statements change Agent Loop into
Workflow behavior.

### Session Agent Cards

Cards describe native agents the Conductor may use. A card has an identity,
display name, model, optional MCP/Skill configuration, a capability
description, and default assignment/output guidance. It is a reusable
workforce profile, never a graph node.

The selected card configures the native Session that Runtime starts for a
Conductor dispatch. Its role label (for example `researcher`, `publisher`, or
`reviewer`) is context for Conductor reasoning and UI readability; it is not a
Runtime permission to route, repair, or complete work.

An empty MCP or Skills list means the normal provider-native capabilities for
that project are available. A non-empty list configures that Session profile;
it does not tell Runtime what business step must happen next.

## Prompt Composition

Every Conductor incarnation receives three distinct inputs:

```text
platform Conductor Base Prompt
  + saved Template Conductor Charter and Agent Cards
  + current Task intent, durable history, and new user messages
```

### Platform Conductor Base Prompt

This fixed prompt establishes the product boundary:

- act as the Task owner and sole Workspace dispatcher;
- do not directly execute worker-owned deliverables;
- use durable Task state and actual Session returns before deciding;
- create a clear, bounded assignment contract for every dispatch;
- treat `queued` and `input_accepted` only as transport facts: a decision that
  creates a dispatch must end without a delivery claim and wait for a later
  semantic Runtime wakeup plus a durable Provider result;
- treat a worker result, failure, attention, and user message as inputs to a
  fresh decision, not as a fixed transition;
- treat each completed native Session answer as a complete semantic material;
  select it with `contextRefs` when a later Session needs the exact material,
  instead of paraphrasing it into a new assignment;
- treat a Reviewer’s `pass`, `needs changes`, and critique as ordinary
  natural-language content in that material—not a Provider or Runtime route
  status. For a factual evidence gap, decide whether an evidence-capable card
  should receive the exact Review material; send Publisher only the selected
  evidence and review material judged ready for delivery;
- explain the decision to the user in the Task Timeline;
- ask the user when the Task goal or authority is genuinely ambiguous.

### Template Charter Example: DeepSearch

```text
This template is for evidence-led research and a concrete deliverable.
Use the available Session Agent Cards when independent investigation,
cross-checking, synthesis, or critique would improve confidence. After each
return, decide whether it answers the Task, exposes a gap, conflicts with
other findings, or requires a different assignment. Keep the user informed of
important uncertainty. Do not personally research or author the deliverable:
delegate bounded work to native Session Agents. Do not assume a fixed number,
order, or round of agents.
```

This encourages good DeepSearch behavior without making a graph. The same
Conductor may call three Searchers, one Searcher twice, a Reviewer first, or
ask the user for direction; the Runtime has no opinion about that choice.

For example, if a Reviewer’s ordinary completed message says `needs changes`
because dates, sources, evidence coverage, or claims are unsupported, the
Conductor can read that whole durable message and choose a bounded evidence
assignment to a suitable Searcher with the Review result in `contextRefs`.
When the new evidence returns, Conductor again decides whether to re-review,
ask the user, or use selected materials for a Publisher assignment. This is a
useful DeepSearch decision preference, not an automatic `Reviewer -> Searcher
-> Reviewer -> Publisher` route. Editorial feedback can instead justify a
Publisher assignment directly when no new factual work is needed.

## Dispatch And Return Semantics

Conductor dispatches an approved card with a normal bounded assignment:

```text
goal + relevant inputs + expected output + acceptance context
```

Runtime durably records the dispatch and uses Provider Adapter facts to record
delivery, result availability, failure, attention, or an observed artifact.
It then wakes Conductor. Worker result content remains a provider-native
answer; workers are not required to emit Workspace JSON, XML, a `report` tool
call, or a special handoff protocol.

### Result-to-Session Context Transfer

Conductor can make an exact completed Session result available to a later
native Session without rephrasing it or requiring a file handoff. The
Conductor cites the durable result in the next dispatch:

```text
contextRefs: ["result:<resultId>"]
```

Runtime resolves that identifier only within the same Task, snapshots the
Provider semantic `answerText` in the new dispatch record, and includes the
quoted text as normal task context in the target Session's native OpenCode
assignment. The target receives no physical Session ID, raw PTY transcript, or
hidden reasoning. It treats the quoted result as untrusted source material and
performs its own bounded assignment.

`contextRefs` is an optional, explicit transport contract. When declared, each
entry is currently exactly `result:<resultId>` for a result in this Task. A
missing, malformed, unsupported, unavailable, or oversized reference fails
the dispatch visibly; Runtime must never silently omit it. The ordinary
`assignment` field stays opaque natural-language text: Runtime must never try
to discover a reference by parsing JSON-like text that a Conductor happened to
embed in that assignment.

This is not worker-to-worker control. Conductor remains the sole dispatcher:
it decides whether a result should be shared, with which card, and for what
purpose. Runtime performs only reference resolution, durable auditing, and
prompt transport. A missing or overlarge result is an explicit dispatch error,
never a silent truncation or a Runtime-selected fallback route.

`contextRefs` is optional. A first investigation ordinarily has no prior
result to reference. A Reviewer can receive one or more selected investigation
results; a follow-up Searcher can receive the exact Review result that named a
gap; and Publisher can receive selected evidence results plus the selected
Review conclusion. Each selection is a fresh Conductor decision, not a field
that every dispatch must carry.

Runtime may validate transport identity and ownership—for example, a dispatch
is scoped to the Task and creates the selected card's physical Session. It
must not reject a dispatch because a Researcher or Reviewer has not returned,
because a result looks insufficient, or because a Publisher lacks a particular
handoff. Those are Conductor decisions.

## User Conversation And Continuations

The Task Timeline has a Conductor composer. A user message is a durable
`task.user_message` event, not raw terminal input:

```text
user message
  -> Runtime persists the message and wakes Conductor
  -> Conductor reads it with the full Task history
  -> Conductor decides whether to answer, re-dispatch, add a new agent turn,
     request clarification, or continue delivery work
```

Task lifecycle remains a Runtime/UI action. A Conductor cannot stop a Task,
create a new Run, or resume a prior native provider Session. A user message
mentioning “restart” is Task feedback, not a lifecycle command; Conductor may
continue the current Run or direct the user to the explicit Stop and Restart
controls when a fresh Run is intended.

Conductor may request `cancel_dispatch(dispatchId, reason)` for one of its
outstanding assignments when it is redundant, superseded, misdirected, or no
longer worth continuing. This is a request for a Coordinator-managed graceful
interrupt, not a direct terminal write, `Ctrl+C`, PTY kill, Session deletion,
Task stop, retry, or completion decision. Conductor waits for the durable
`cancelled` or `cancel_failed` terminal/provider fact before treating that
Session as available for more work.

If a user challenges a completed search or a delivered result, the product
creates a recorded continuation of the same Task. While its Conductor terminal
is live this is a new input to the current Run; after `achieved` it is an
explicit new Run whose recovery envelope retains prior Task history as context.
The Conductor may open new native Session Agent work. The user does not need to
find, or directly operate, an old Searcher terminal.

`achieved` remains a user action after inspecting the concrete delivered files.
It is not a Runtime verdict and does not prevent a later user continuation, but
that continuation never silently resurrects the accepted Run's provider
Session. See `task-run-continuity-and-terminal-experience.md`.

## Explicit Prohibitions

The next implementation must not add any of the following to the Agent Loop
runtime:

- automatic role sequencing or prerequisite counts (apart from checking the
  explicit Reviewer-result handoff of an opted-in Publisher dispatch);
- “Reviewer needs changes” routing directly to Publisher, Researcher, or any
  other card;
- automatic re-review, repair, or task completion;
- direct Conductor control of terminal signals, Session process termination, or
  a cancellation that is assumed complete before a terminal/provider receipt;
- artifact existence, quality, or evidence checks that decide the next
  Conductor action;
- a worker-result classifier that turns semantics into a route;
- direct worker-to-worker terminal control or raw PTY transcript forwarding;
- a fixed completion state machine beyond durable recording of claims and the
  user's achieved action.

These can exist later only in an explicit Workflow product, not in the active
Agent Loop.

## Acceptance Criteria For The Rework

- A generated Template produces an editable Conductor Charter and editable
  native Agent Cards, never a route graph or hidden policy program.
- A real DeepSearch run shows Conductor decisions and dispatched agents, but
  Runtime does not automatically select a second agent after any result.
- A Reviewer `needs_changes` return wakes Conductor once; the next dispatch is
  visible as a Conductor decision and may target any approved card.
- The real OpenCode handoff harness proves the concrete factual-gap case:
  `npm run desktop:agent-loop-real-review-handoff-e2e` requires Conductor to
  select the whole initial Searcher result for Reviewer, the whole Reviewer
  message for a corrective Searcher assignment, and the selected corrected
  evidence plus passing Review for Publisher. It verifies the stored
  `contextPackets.answerText` values equal the source Provider answers; a
  reference ID without the original semantic material is a failure.
- A user Timeline message wakes Conductor and appears in the causal
  conversation before its next decision.
- Workers remain native OpenCode sessions without Workspace MCP or custom
  handoff obligations.

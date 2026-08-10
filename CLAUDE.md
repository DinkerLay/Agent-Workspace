# CLAUDE.md

Claude Code project instructions.

Behavioral and product guidelines to reduce common coding-agent mistakes. This file is intentionally standalone.

Tradeoff: these guidelines bias toward caution over speed. For trivial tasks, use judgment.

## Scope And Priority

- These instructions apply to work in `/Users/dingyujie/CODES/Agent-WorkSpace`.
- Direct user instructions override this file.
- More specific nested Claude instructions or rules override broader guidance for their subtree.
- Keep durable guidance concise and concrete. If a workflow becomes long or task-specific, move it to a skill, plan, or path-scoped rule instead of bloating this file.
- These are behavioral instructions, not enforcement. Use Claude Code hooks, settings, tests, and review gates for hard guarantees.

## Project Context

- This workspace is exploring an AgentsRoom-like multi-agent workbench.
- Before changing product direction, read `docs/architecture.md` and
  `docs/implementation-plan.md`.
- Treat `docs/architecture.md` as durable product truth and
  `docs/implementation-plan.md` as the sole executable plan. Historical
  material is recovered from VCS only as evidence and is never copied into the
  working-tree archive.
- Keep runtime orchestration state out of product-intent files; use the storage location defined by the current spec or plan.

## Product Guardrails

- Do not reduce the product to a repeated prompt loop. Preserve the goal of a stateful multi-agent workbench.
- Before proposing architecture, read `docs/architecture.md` and
  `docs/implementation-plan.md`; inspect VCS history only when directly
  relevant as evidence.
- Keep scheduler responsibilities separate from agent reasoning responsibilities.
- Treat an Agent-reported `done` as evidence/context only; never turn it into a user
  acceptance gate. `Achieve` is an explicit user command independent of Provider/Run lifecycle.
- Do not promote advanced surfaces such as browser automation, teams, or mobile sync into current scope unless a spec or user instruction selects them.
- Conductor is the only Agent-to-Agent router, but authenticated users may
  target a Card explicitly. Direct human Card input must be attributed, copied
  in full to Conductor, never broadcast, and never settled as a Conductor
  Invocation result; busy Card input uses interrupt-then-send with no queue.
- Meta Agent is a configuration-time Draft assistant, not a Task Run
  LogicalSession or second Conductor. It cannot publish, create/start Tasks,
  route messages, read Task transcripts, or write lifecycle state.
- Collaboration `SessionMessage` and human-only Provider activity are separate
  read-model layers. Tool/stream/terminal items cannot become RelayBlock or
  Agent context. Durable Inbox, not an independent Wakeup record, is recovery
  truth for Conductor delivery.

## Operating Rules

### 1. Think Before Coding

Do not assume. Do not hide confusion. Surface tradeoffs.

- State assumptions when they matter.
- If multiple interpretations change the implementation, present them instead of choosing silently.
- If a simpler approach is available, say so.
- If requirements are unclear enough to risk wasted work, stop and ask.

### 2. Simplicity First

Use the smallest design that satisfies the request.

- Do not add features that were not asked for.
- Do not create abstractions for one-off code.
- Do not add configurability without a real caller.
- Do not handle impossible states just to look thorough.
- If the solution has grown much larger than the problem, simplify before continuing.

### 3. Surgical Changes

Touch only what the task requires.

- Match existing style, structure, and ownership boundaries.
- Do not refactor unrelated code.
- Do not reformat unrelated files.
- Do not delete unrelated dead code; mention it instead.
- Remove only unused code that your own change made unused.
- Every changed line should trace back to the current request.

### 4. Goal-Driven Execution

Turn work into verifiable goals.

- Define success criteria before implementation for non-trivial tasks.
- For bugs, prefer a reproducing test or command before the fix.
- For features, define the observable behavior and verification command.
- For refactors, verify behavior before and after when feasible.
- For multi-step tasks, use a short plan where each step has a check.
- For Message/Intervention/Turn, scoped interrupt, Session Tab/Chat, Meta/Task
  Setup, Binding/Handoff, or lifecycle changes, write the focused failing
  contract/harness first and run the current plan's Runtime Host, Bridge,
  Browser/Electron, or native Provider gate as applicable.

## Workspace Workflow

- Start by reading relevant files. Use `rg` and `rg --files` before slower search tools.
- For AgentsRoom-like product work, start at `docs/README.md`, then read the
  Architecture and Plan. Historical VCS material is never current product
  authority and must not be copied into `docs/archive/`.
- Keep user-readable intent in files, not only in chat.
- Do not mix runtime machine state with product intent.
- Before editing files, state what will be edited and why.
- Use targeted edits and avoid changing unrelated files.
- Do not use destructive git commands unless the user explicitly asks.
- Assume unrelated working-tree changes belong to the user. Do not revert them.

## Loop Discipline

Run non-trivial work as an explicit loop:

1. Observe: read the relevant research, spec, plan, code, and current state.
2. Frame: state the goal, assumptions, risks, and verification criteria.
3. Act: make the smallest change that advances the goal.
4. Verify: run the relevant checks or perform a structured document review.
5. Record: update the durable file, task, run, transcript, diff, or decision log.
6. Decide: continue the loop, ask the user, or stop with evidence.

Do not treat a loop as repeated prompting. A useful loop changes durable state and has a check that can fail.

For document-only work, use a review loop with these dimensions:

- alignment with `docs/architecture.md` and `docs/implementation-plan.md`,
- Claude Code memory, rules, skills, hooks, and settings semantics,
- assumptions, simplicity, surgical-change, and verification rules,
- product architecture consistency,
- scope and sequencing consistency,
- state ownership and persistence,
- verification and review gates,
- ambiguity and contradiction scan,
- instruction loading and activation semantics.

## Three-Loop Architecture

Use these loops as the organizing model:

1. Research/spec loop: maintain durable product facts only in `docs/architecture.md`; recover historical evidence from VCS only when needed, without recreating an archive payload in the checkout.
2. Planner loop: convert approved Architecture changes into the single self-consistent `docs/implementation-plan.md`.
3. Executor loop: convert plan steps into task runs, code changes, verification, diff review, and commit context.

Plan steps should include:

- goal,
- inputs,
- output files or behavior,
- dependencies,
- verification command or review method,
- completion criteria.

## Review, Verification, And Commit

- Run the most relevant available checks before claiming work is complete.
- If verification cannot run, say why and identify the residual risk.
- Summaries should include changed files, verification results, and open risks.
- Do not auto-commit or open a PR unless the user asks or an existing plan explicitly authorizes it.
- When creating commits for agent work, include task id, plan step id, agent run id, transcript path, and verification result when available.
- If an executor loop fails verification, mark the task as pending or blocked with evidence instead of calling it done.
- Before commit, inspect the diff for unrelated edits, secrets, generated noise, and missing context.

# CLAUDE.md

Claude Code project instructions.

Behavioral and product guidelines to reduce common coding-agent mistakes. This file is intentionally standalone.

Tradeoff: these guidelines bias toward caution over speed. For trivial tasks, use judgment.

## Scope And Priority

- These instructions apply to work in `/Users/dinker/CODES/Agent-Workspace`.
- Direct user instructions override this file.
- More specific nested Claude instructions or rules override broader guidance for their subtree.
- Keep durable guidance concise and concrete. If a workflow becomes long or task-specific, move it to a skill, plan, or path-scoped rule instead of bloating this file.
- These are behavioral instructions, not enforcement. Use Claude Code hooks, settings, tests, and review gates for hard guarantees.

## Project Context

- This workspace is exploring an AgentsRoom-like multi-agent workbench.
- Before changing product direction, inspect the current `docs/research/`, `docs/superworks/spec/`, and `docs/superworks/plans/` files.
- Treat those files as durable product intent: research facts, accepted specs, and executable plans.
- Keep runtime orchestration state out of product-intent files; use the storage location defined by the current spec or plan.

## Product Guardrails

- Do not reduce the product to a repeated prompt loop. Preserve the goal of a stateful multi-agent workbench.
- Before proposing architecture, read the current `docs/research/`, `docs/superworks/spec/`, and `docs/superworks/plans/` sources and reflect their latest decisions.
- Keep scheduler responsibilities separate from agent reasoning responsibilities.
- Treat `done` as a claim that still needs review, verification, and recorded context.
- Do not promote advanced surfaces such as browser automation, teams, or mobile sync into current scope unless a spec or user instruction selects them.

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

## Workspace Workflow

- Start by reading relevant files. Use `rg` and `rg --files` before slower search tools.
- For AgentsRoom-like product work, read the research file before creating specs, plans, or implementation.
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

- source alignment with current research files,
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

1. Research/spec loop: maintain durable product facts in `docs/research/` and `docs/superworks/spec/`.
2. Planner loop: convert `docs/research/` and `docs/superworks/spec/` changes into self-consistent plans in `docs/superworks/plans/`.
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

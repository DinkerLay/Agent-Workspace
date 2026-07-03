# Prototype Capability Map Plan

Date: 2026-06-24

Goal: turn the current Board-first prototype into a full product interaction map that exposes pages, capabilities, and runtime boundaries before real desktop services are implemented.

## Step 1: Capability Data Model

Inputs:

- `docs/research/agentsroom-research-2026-06-24.zh.md`
- `docs/superworks/spec/product-interaction-map.md`
- current `src/types.ts`

Output:

- typed capability data in `src/mock/capabilityData.ts`
- capability coverage test in `src/lib/capabilityMap.test.ts`

Verification:

- `npm test`

Completion criteria:

- all researched surfaces are represented,
- MVP core and advanced phases are explicit,
- runtime contracts separate scheduler-owned and agent-owned responsibilities.

## Step 2: Durable Product Pages

Inputs:

- capability data model,
- current React shell and styles.

Output:

- Capability Map page,
- Projects cockpit page,
- Agent setup controls inside the Projects cockpit,
- MCP Gateway page,
- Research / Spec / Plan Watcher page,
- Workbench Scratchpad / Composer controls for draft path, autosave status, context inserts, and Prompt Library save,
- Dev Terminals page,
- upgraded Teams, Browser, Libraries, Notifications, Restore, and Runs pages backed by data instead of hardcoded inline content.

Verification:

- `npm test`
- `npx tsc --noEmit --noUnusedLocals --noUnusedParameters`
- `npm run build`

Completion criteria:

- navigation exposes the full product surface,
- pages show page jobs, state ownership, service contracts, and current phase,
- existing Board -> Loop -> Workbench -> Review -> Runs path remains intact.

## Step 3: Browser Prototype Check

Inputs:

- Vite app at `http://127.0.0.1:5188/`.

Output:

- browser verification summary.

Verification:

- `5188` responds,
- `5173` is not used,
- DOM checks confirm key pages and workflow states render,
- responsive checks confirm no root-level horizontal overflow across the prototype pages,
- no browser console errors.

Completion criteria:

- user can inspect the full product prototype at `http://127.0.0.1:5188/`,
- no verification gaps are hidden.

## Step 4: Runtime Adapter Boundary

Inputs:

- `docs/superworks/spec/product-interaction-map.md`
- `src/mock/capabilityData.ts`
- current task/run state machine.

Output:

- `src/runtime/contracts.ts`
- `src/runtime/mockAdapters.ts`
- runtime adapter tests
- adapter readiness surfaced on the Capability Map page.

Verification:

- `npm test`
- `npx tsc --noEmit --noUnusedLocals --noUnusedParameters`
- `npm run build`
- browser DOM check for adapter readiness cards.

Completion criteria:

- mock adapters exist for run-store, PTY service, git service, and filesystem watch,
- tests prove each adapter's core contract,
- UI shows mocked adapter status and the native replacement step,
- no adapter mixes scheduler responsibilities with agent reasoning.

## Step 5: Adapter-Backed Start Agent

Inputs:

- runtime adapter contracts,
- current task state machine,
- Loop console Start Agent interaction.

Output:

- task orchestrator that calls run-store, PTY, and git adapters,
- reducer action carrying adapter-created run and runtime events,
- Workbench runtime event list.

Verification:

- `npm test`
- `npx tsc --noEmit --noUnusedLocals --noUnusedParameters`
- `npm run build`
- browser check that Loop Start Agent opens Workbench with mock run id and runtime events.

Completion criteria:

- Start Agent no longer only mutates task state,
- newly started tasks receive adapter-created run records,
- Workbench exposes run-store, PTY, and git baseline evidence,
- existing review gate still prevents direct Done.

## Step 6: Review / Commit Scope Controls

Inputs:

- `docs/research/agentsroom-research-2026-06-24.zh.md`
- `docs/superworks/spec/product-interaction-map.md`
- current Review page and task state machine.

Output:

- Review page exposes per-file scoped commit selection,
- Commit panel previews selected files and `Agent-Conversation` trailer state,
- Runs page shows the same scoped files and trailer state as audit context,
- reducer actions preserve scoped selection without moving tasks or creating runs,
- approved commit proposals include selected files and transcript trailer when enabled.

Verification:

- `npm test`
- `npx tsc --noEmit --noUnusedLocals --noUnusedParameters`
- `npm run build`
- browser overflow check on Review and Runs at desktop and mobile widths.

Completion criteria:

- Review remains the only path from agent done claim to task Done,
- scoped file selection is shell-owned review state,
- commit proposal metadata includes task id, plan step id, run id, verification result, selected files, and optional Agent conversation path.

## Step 7: MCP Tool Call Audit

Inputs:

- `docs/superworks/spec/product-interaction-map.md`
- `src/mock/capabilityData.ts`
- current MCP Gateway page and task state machine.

Output:

- MCP Gateway exposes a request action for allowlisted tools,
- reducer records `McpToolCallEvent` audit entries with permission, target surface, status, and evidence path,
- selecting or requesting MCP tools does not create `AgentRun` records or move task cards,
- MCP Gateway shows the audit trail without horizontal overflow.

Verification:

- `npm test`
- `npx tsc --noEmit --noUnusedLocals --noUnusedParameters`
- `npm run build`
- browser overflow check on MCP Gateway at desktop and mobile widths.

Completion criteria:

- MCP Gateway acts as an agent-facing automation boundary, not a second scheduler,
- confirm tools require scheduler confirmation in the recorded event,
- read/write tools still record evidence paths for Review and Runs consumption later.

## Step 8: Browser Evidence Review Loop

Inputs:

- `docs/superworks/spec/product-interaction-map.md`
- current Browser Automation, Review, Runs pages, and task state machine.

Output:

- Browser Automation keeps task-scoped captured evidence,
- Review consumes browser evidence for the active task before approval,
- Runs preserves the same browser artifact paths in the completion audit,
- browser evidence remains verification context and does not create `AgentRun` records or move task cards.

Verification:

- `npm test`
- `npx tsc --noEmit --noUnusedLocals --noUnusedParameters`
- `npm run build`
- browser overflow check on Browser, Review, and Runs at desktop and mobile widths after capturing evidence.

Completion criteria:

- browser evidence is visible outside the Browser page,
- Review can distinguish missing browser evidence from captured evidence,
- Runs provides a durable audit trail for the task-scoped artifact path.

## Step 9: Commit Context Redaction Gate

Inputs:

- `docs/research/agentsroom-research-2026-06-24.zh.md`
- `docs/superworks/spec/product-interaction-map.md`
- current Review, Runs, and task state machine.

Output:

- Review exposes an Agent-Conversation redaction scan action,
- reducer records a run-scoped redaction artifact without creating `AgentRun` records or moving task cards,
- approved commit proposals include `Agent-Conversation-Redaction` when the trailer is enabled and scanned,
- Runs preserves the redaction artifact and matched pattern list in the completion audit.

Verification:

- `npm test`
- `npx tsc --noEmit --noUnusedLocals --noUnusedParameters`
- `npm run build`
- browser overflow check on Review and Runs after enabling trailer and running redaction scan.

Completion criteria:

- Agent-Conversation upload is represented as a review-gated artifact, not an implicit side effect,
- redaction evidence covers API key, `.env`, and token patterns in the prototype,
- commit context remains proposal-first and user-approved before Done.

## Step 10: Team Max-Cycle Guard

Inputs:

- `docs/research/agentsroom-research-2026-06-24.zh.md`
- `docs/superworks/spec/product-interaction-map.md`
- current Teams page and TeamRun state machine.

Output:

- TeamRun advances wrap from the last node into the next cycle until `maxCycles`,
- exceeding `maxCycles` blocks the TeamRun instead of silently completing it,
- Teams shows the max-cycle guard state and disables further handoff advance while blocked,
- blocked TeamRun state does not create normal `AgentRun` records or move task cards.

Verification:

- `npm test`
- `npx tsc --noEmit --noUnusedLocals --noUnusedParameters`
- `npm run build`
- browser overflow check on Teams at desktop and mobile widths after driving a run to blocked.

Completion criteria:

- the shell visibly owns TeamRun cycle limits,
- blocked handoff state preserves the evidence path and active node for user review,
- Teams remains an advanced orchestration surface, not the default single-task scheduler.

## Step 11: Restore Resume Context

Inputs:

- `docs/superworks/spec/product-interaction-map.md`
- current Restore page, task state machine, Browser evidence, MCP audit, TeamRun, notification, and commit redaction records.

Output:

- Restore manifest includes process metadata and shell-owned resume context records,
- resume context records cover active run, browser evidence, redaction scan, MCP audit, TeamRun, and pending notification pointers when present,
- Restore page shows resume context artifact paths without implying replay or task-state mutation,
- capturing or restoring a manifest still does not create `AgentRun` records, move task cards, or mark Review done.

Verification:

- `npm test`
- `npx tsc --noEmit --noUnusedLocals --noUnusedParameters`
- `npm run build`
- browser overflow check on Restore at desktop and mobile widths after capturing a manifest.

Completion criteria:

- Restore is visibly a desktop workbench rehydration surface, not an agent replay system,
- evidence pointers remain under `.agent-workspace/` runtime state,
- restored shell context preserves review/run evidence while leaving scheduler gates intact.

## Step 12: Scratchpad Prompt Library Save

Inputs:

- `docs/superworks/spec/product-interaction-map.md`
- current Workbench Scratchpad, Libraries page, and task state machine.

Output:

- saving a Scratchpad draft creates a shell-owned Prompt Library save record,
- the save record includes task id, source draft path, target prompt store, saved artifact path, and saved timestamp,
- Libraries shows saved Scratchpad draft artifacts alongside prompt templates,
- saving a draft still does not create `AgentRun` records, move task cards, or bypass Review.

Verification:

- `npm test`
- `npx tsc --noEmit --noUnusedLocals --noUnusedParameters`
- `npm run build`
- browser overflow check on Workbench and Libraries after saving a draft.

Completion criteria:

- Scratchpad save is represented as durable library-store evidence, not only a timestamp,
- Prompt Library can explain where saved drafts came from,
- library context remains scheduler-owned and execution still happens through Workbench and run lifecycle.

## Step 13: Dev Command Lifecycle Audit

Inputs:

- `docs/superworks/spec/product-interaction-map.md`
- current Dev Terminals page and task state machine.

Output:

- starting or stopping a Dev Terminal command records a shell-owned command lifecycle event,
- each event includes command id, action, command status, summary, event stream path, bounded log path, and timestamp,
- Dev Terminals shows the lifecycle audit next to the PTY boundary,
- command lifecycle events remain separate from normal `AgentRun` records and task status.

Verification:

- `npm test`
- `npx tsc --noEmit --noUnusedLocals --noUnusedParameters`
- `npm run build`
- browser overflow check on Dev Terminals after starting and stopping commands.

Completion criteria:

- Dev Terminal command state is backed by event evidence, not only an in-memory status label,
- command events live under `.agent-workspace/commands/`,
- starting or stopping project commands still does not create `AgentRun` records, move task cards, or bypass Review.

## Step 14: Project Context Manifest Audit

Inputs:

- `docs/research/agentsroom-research-2026-06-24.zh.md`
- `docs/superworks/spec/product-interaction-map.md`
- current Projects cockpit and task state machine.

Output:

- Projects cockpit groups project cards by zone,
- selecting a project records a shell-owned project context event,
- each event includes project id, zone, manifest path, browser profile, selected timestamp, and summary,
- Projects page shows the workspace context audit for the selected project.

Verification:

- `npm test`
- `npx tsc --noEmit --noUnusedLocals --noUnusedParameters`
- `npm run build`
- browser overflow check on Projects after selecting a different project.

Completion criteria:

- project selection is represented as workspace context evidence, not only a selected id,
- project manifest pointers live under `.agent-workspace/projects/`,
- selecting project context still does not create `AgentRun` records, move task cards, or bypass Review.

## Step 15: Agent Profile Manifest Audit

Inputs:

- `docs/research/agentsroom-research-2026-06-24.zh.md`
- `docs/superworks/spec/product-interaction-map.md`
- current Projects cockpit, agent template controls, and task state machine.

Output:

- adding an agent from a template records a shell-owned agent profile event,
- each event includes project id, agent id, template id, system prompt path, worktree policy, manifest path, created timestamp, and summary,
- Projects page shows the agent profile audit for the selected project,
- Capability Map explains agent profiles as manifest-backed workspace state.

Verification:

- `npm test`
- `npx tsc --noEmit --noUnusedLocals --noUnusedParameters`
- `npm run build`
- browser overflow check on Projects after adding an agent from a template.

Completion criteria:

- agent setup is represented as durable profile evidence, not only a new in-memory agent row,
- agent profile pointers live under `.agent-workspace/agents/`,
- adding an agent still does not create `AgentRun` records, move task cards, or imply PTY execution.

## Step 16: Task Transition Event Audit

Inputs:

- `docs/superworks/spec/product-interaction-map.md`
- current Task Board page and task state machine.

Output:

- advancing a task records a shell-owned task transition event,
- each event includes task id, from status, to status, summary, task event stream path, and timestamp,
- Task Board detail shows recent transition evidence for the selected task,
- Capability Map explains Backlog Board evidence as task-store events plus run/review gates.

Verification:

- `npm test`
- `npx tsc --noEmit --noUnusedLocals --noUnusedParameters`
- `npm run build`
- browser overflow check on Task Board after advancing a task.

Completion criteria:

- task state changes are represented as durable task-store evidence, not only colored labels,
- task transition pointers live under `.agent-workspace/tasks/`,
- advancing task status still does not create `AgentRun` records, start PTY sessions, or bypass Review.

## Step 17: Loop Schedule Decision Audit

Inputs:

- `docs/superworks/spec/product-interaction-map.md`
- current Loop Console page and adapter-backed Start Agent path.

Output:

- starting an agent from Loop records a shell-owned loop schedule event,
- each event includes task id, agent id, run id, decision, rule, event stream path, timestamp, and summary,
- Loop Console shows recent scheduler decisions next to the scheduling rules,
- Capability Map explains Start Agent evidence as scheduler decision plus runtime adapter events.

Verification:

- `npm test`
- `npx tsc --noEmit --noUnusedLocals --noUnusedParameters`
- `npm run build`
- browser overflow check on Loop Console after starting an agent from the queue.

Completion criteria:

- Loop is visibly a scheduler surface with durable decision evidence, not only explanatory copy,
- loop schedule pointers live under `.agent-workspace/loops/`,
- starting an agent still enters normal run-store, PTY, git, Workbench, and Review lifecycle instead of bypassing gates.

## Step 18: Workspace Audit Trail

Inputs:

- `docs/superworks/spec/product-interaction-map.md`
- current shell-owned event streams in `PrototypeState`
- existing Runs, Review, Loop, Browser, MCP, Restore, Projects, and Watcher pages.

Output:

- pure audit trail builder that normalizes shell-owned event streams into one newest-first timeline,
- Audit Trail page that shows surface, event kind, status, task id, timestamp, summary, and artifact path,
- Capability Map entry for Workspace Audit Trail,
- spec text that distinguishes workspace-level Audit Trail from run-scoped Runs.

Verification:

- `npm test`
- `npx tsc --noEmit --noUnusedLocals --noUnusedParameters`
- `npm run build`
- browser overflow check on Audit Trail at desktop and mobile widths.

Completion criteria:

- Audit Trail is visibly read-only workspace evidence, not a scheduler,
- audit entries point to existing `.agent-workspace/` event streams or artifacts,
- opening Audit Trail does not create `AgentRun` records, move tasks, or approve Review,
- Runs remains the run-scoped transcript/diff/verification/commit context view.

## Step 19: Task Artifact Evidence

Inputs:

- `docs/research/agentsroom-research-2026-06-24.zh.md`
- `docs/superworks/spec/product-interaction-map.md`
- current Task Board, Workbench Scratchpad, Audit Trail, and task state machine.

Output:

- typed `TaskArtifact` records in prototype state,
- reducer action that attaches a Scratchpad artifact to the selected task without creating runs or moving tasks,
- Workbench attach controls for selected Scratchpad context,
- Task Board card artifact counts and selected task artifact detail,
- Audit Trail entries for task artifacts,
- Capability Map and spec updates for task artifact evidence.

Verification:

- `npm test`
- `npx tsc --noEmit --noUnusedLocals --noUnusedParameters`
- `npm run build`
- browser overflow check on Workbench, Task Board, Audit Trail, and Capability Map after attaching an artifact.

Completion criteria:

- task cards visibly support screenshot/sketch/HTML/prompt artifact evidence,
- task artifact pointers live under `.agent-workspace/tasks/<task-id>/artifacts/`,
- attaching artifacts still does not create `AgentRun` records, move tasks, or bypass Review,
- Audit Trail includes task artifact records as shell-owned evidence.

## Step 20: Run Worktree Context

Inputs:

- `docs/research/agentsroom-research-2026-06-24.zh.md`
- `docs/superworks/spec/product-interaction-map.md`
- current run store, task state machine, Workbench, Review, and Runs pages.

Output:

- typed `WorktreeContext` records on every `AgentRun`,
- shared helper that derives isolation policy, branch name, worktree path, and baseline manifest path for mock runs,
- Workbench commit context shows current branch and worktree,
- Review shows the same worktree/branch evidence before approval,
- Runs preserves the same manifest as run-scoped audit context,
- Capability Map and spec updates for run worktree context.

Verification:

- `npm test`
- `npx tsc --noEmit --noUnusedLocals --noUnusedParameters`
- `npm run build`
- browser overflow check on Workbench, Review, Runs, and Capability Map at desktop and mobile widths.

Completion criteria:

- every mock and reducer-created `AgentRun` has branch/worktree/baseline manifest evidence,
- Workbench, Review, and Runs show the same run worktree context,
- recording worktree context does not start PTY sessions, move task state, or bypass Review,
- future native Git Service can replace the helper with real branch/worktree APIs.

## Step 21: Verification Command Evidence

Inputs:

- `docs/research/agentsroom-research-2026-06-24.zh.md`
- `docs/superworks/spec/product-interaction-map.md`
- current Review, Runs, Audit Trail, and task state machine.

Output:

- typed `VerificationCommandEvent` records in prototype state,
- reducer action that runs the review-gate verification command without creating runs or moving tasks,
- Review button for running the selected task verification command,
- Runs command history for the selected `AgentRun`,
- Audit Trail entries for verification command evidence,
- Capability Map and spec updates for verification command evidence.

Verification:

- `npm test`
- `npx tsc --noEmit --noUnusedLocals --noUnusedParameters`
- `npm run build`
- browser overflow check on Review, Runs, Audit Trail, and Capability Map after running verification.

Completion criteria:

- verification command evidence includes command, pass/fail status, log path, artifact path, timestamp, run id, and task id,
- running verification updates the active run evidence but does not create `AgentRun` records, move tasks, or approve Review,
- Runs and Audit Trail preserve the verification event for later review,
- future native command execution can replace the prototype event while keeping the same review-gate contract.

## Step 22: Review Approval Evidence

Inputs:

- `docs/research/agentsroom-research-2026-06-24.zh.md`
- `docs/superworks/spec/product-interaction-map.md`
- current Review approval flow, Runs completion audit, Audit Trail, and task state machine.

Output:

- typed `ReviewApprovalEvent` records in prototype state,
- reducer action path that records approval evidence when Review moves a task to Done,
- Runs approval history for the selected `AgentRun`,
- Audit Trail entries for human review approval evidence,
- Capability Map and spec updates for review approval evidence.

Verification:

- red test for reducer approval evidence,
- red test for Runs approval history,
- red test for Audit Trail approval aggregation,
- `npm test`
- `npx tsc --noEmit --noUnusedLocals --noUnusedParameters`
- `npm run build`
- browser overflow check on Review, Runs, Audit Trail, and Capability Map after approving Review.

Completion criteria:

- Review approval evidence includes task id, run id, verification status, scoped files, commit proposal path, approval timestamp, and artifact path,
- approving Review records approval evidence while preserving the existing Review gate behavior,
- Runs and Audit Trail preserve the approval event for later review,
- future native git/review service can replace the prototype event while keeping the same Done gate contract.

## Step 23: PR Handoff Evidence

Inputs:

- `docs/research/agentsroom-research-2026-06-24.zh.md`
- `docs/superworks/spec/product-interaction-map.md`
- current Review approval events, Runs completion audit, Audit Trail, and task state machine.

Output:

- typed `PullRequestHandoffEvent` records in prototype state,
- reducer action that prepares a PR handoff package only after Review approval,
- Runs PR handoff box and prepare action for the selected `AgentRun`,
- Audit Trail entries for PR handoff evidence,
- Capability Map and spec updates for PR handoff evidence.

Verification:

- red test for reducer PR handoff evidence,
- red test for Runs PR handoff action/history,
- red test for Audit Trail PR handoff aggregation,
- `npm test`
- `npx tsc --noEmit --noUnusedLocals --noUnusedParameters`
- `npm run build`
- browser overflow check on Runs, Audit Trail, and Capability Map after preparing a PR handoff.

Completion criteria:

- PR handoff evidence includes task id, run id, branch name, approval evidence path, commit proposal path, timestamp, status, and draft path,
- preparing PR handoff does not create an `AgentRun`, move task cards, change Review approval, or open an external PR,
- Runs and Audit Trail preserve the handoff event for later review,
- future native git/hosting integration can replace the prototype event while keeping explicit user approval before PR creation.

## Step 24: Review Gate Enforcement

Inputs:

- `docs/research/agentsroom-research-2026-06-24.zh.md`
- `docs/superworks/spec/product-interaction-map.md`
- current Review approval flow, task machine, Runs, Audit Trail, and Capability Map.

Output:

- typed `ReviewGateEvent` records in prototype state,
- reducer path that blocks `approve-review` when verification evidence is missing,
- reducer path that blocks `approve-review` when `Agent-Conversation` is selected without a passed redaction scan,
- Review approval button disabled until required gates pass,
- Audit Trail entries for blocked review gate evidence,
- Capability Map and spec updates for Review Gate Enforcement.

Verification:

- red test for reducer verification-required block,
- red test for reducer redaction-required block,
- red test for Review approval disabled/enabled states,
- red test for Audit Trail gate aggregation,
- `npm test`
- `npx tsc --noEmit --noUnusedLocals --noUnusedParameters`
- `npm run build`
- browser overflow check on Review, Runs, Audit Trail, and Capability Map.

Completion criteria:

- Approve Review cannot manufacture passed verification,
- missing verification or required redaction keeps the task out of Done and leaves the commit proposal unapproved,
- blocked gate evidence includes task id, run id, reason, timestamp, summary, and `.agent-workspace/reviews/<run-id>/gate.json`,
- passing gates still preserve Review approval evidence and PR handoff behavior.

## Step 25: Commit Staging Evidence

Inputs:

- `docs/research/agentsroom-research-2026-06-24.zh.md`
- `docs/superworks/spec/product-interaction-map.md`
- current Review scoped file selection, Runs completion audit, Audit Trail, and task state machine.

Output:

- typed `CommitStagingEvent` records in prototype state,
- reducer action that stages the current scoped file selection as evidence without performing real git side effects,
- Review Git staging panel and `Stage selected files` action,
- Runs staging evidence history for the selected `AgentRun`,
- Audit Trail entries for Git staging evidence,
- Capability Map and spec updates for Commit Staging Evidence.

Verification:

- red test for reducer staging evidence,
- red test for Review staging action and display,
- red test for Runs staging history,
- red test for Audit Trail staging aggregation,
- red test for Capability Map coverage,
- `npm test`
- `npx tsc --noEmit --noUnusedLocals --noUnusedParameters`
- `npm run build`
- browser overflow check on Review, Runs, Audit Trail, and Capability Map after staging selected files.

Completion criteria:

- staging evidence includes task id, run id, staged file paths, unstaged file paths, timestamp, summary, and `.agent-workspace/runs/<run-id>/staging.json`,
- staging selected files does not create an `AgentRun`, move task cards, approve Review, or open a PR,
- commit proposal text can reference the staging evidence path,
- future native Git Service can replace the prototype event with real git index inspection and staged diff persistence.

## Step 26: MCP Confirmation Evidence

Inputs:

- `docs/superworks/spec/product-interaction-map.md`
- current MCP Gateway page and task state machine
- Audit Trail and Capability Map event aggregation

Output:

- typed `McpToolCallEvent` confirmation decision fields,
- reducer action that resolves confirm-class MCP requests as approved or denied,
- MCP Gateway approve and deny controls for `confirmation-required` events,
- Audit Trail entries that use confirmation decision evidence when present,
- Capability Map and runtime contract updates for MCP confirmation ownership.

Verification:

- red test for MCP approve/deny reducer evidence,
- red test for MCP Gateway confirmation controls and resolved decision display,
- red test for Audit Trail confirmation decision aggregation,
- red test for Capability Map MCP Gateway scheduler-owned confirmation decision,
- red test for durable spec/plan coverage,
- `npm test`,
- `npx tsc --noEmit --noUnusedLocals --noUnusedParameters`,
- `npm run build`,
- browser overflow check on MCP Gateway, Audit Trail, and Capability Map after resolving a confirmation.

Completion criteria:

- confirm-class tool calls require an explicit approved or denied scheduler decision,
- the decision includes event id, decision status, decided timestamp, summary, and `.agent-workspace/mcp/<event-id>/confirmation.json`,
- resolving confirmation does not create an `AgentRun`, move task cards, approve Review, or execute hidden scheduler side effects,
- Audit Trail preserves the decision artifact as the authoritative MCP evidence,
- future native permission prompts can replace prototype buttons without changing the event contract.

## Step 27: Deferred Mobile Sync Boundary

Inputs:

- `docs/research/agentsroom-research-2026-06-24.zh.md`
- `docs/superworks/spec/product-interaction-map.md`
- current Capability Map and runtime contract data

Output:

- `mobile-sync` capability with phase `deferred`,
- Client Sync Service runtime boundary that keeps execution authority on desktop,
- Capability Map Deferred boundary group,
- spec text that records Mobile Sync as a remote control surface after native desktop contracts,
- plan/test coverage proving the prototype does not add a current navigation page.

Verification:

- red test for deferred Mobile Sync capability coverage,
- red test for Capability Map Deferred boundary UI,
- red test for spec/plan documentation coverage,
- `npm test`,
- `npx tsc --noEmit --noUnusedLocals --noUnusedParameters`,
- `npm run build`,
- browser overflow check on Capability Map after selecting Mobile Sync.

Completion criteria:

- Mobile Sync is represented in the product capability map because it appears in research,
- Mobile Sync remains deferred and does not add a current navigation page,
- opening the capability returns to the Capability Map instead of implying a mobile surface exists,
- the Client Sync Service contract states desktop/backend owns execution authority,
- the current prototype does not create an `AgentRun`, write to PTY, move task cards, or bypass Review from Mobile Sync.

## Step 28: Runtime Instruction Injection Boundary

Inputs:

- `docs/research/agentsroom-research-2026-06-24.md`
- `docs/superworks/spec/product-interaction-map.md`
- current Libraries page, Skills Library capability, and Library Store runtime contract

Output:

- Libraries page shows a Runtime injection contract for canonical `SKILL.md`, Codex `AGENTS.md` managed block, and start-time injection,
- Skills Library capability records Codex `AGENTS.md` managed block evidence and runtime instruction export path,
- Library Store contract records the scheduler-owned instruction export target,
- spec text that distinguishes skill attachment from rewriting agent workflows,
- plan/test coverage for a future start-time injection manifest.

Verification:

- red test for Libraries runtime injection contract,
- red test for Skills Library capability evidence and Library Store ownership,
- red test for spec/plan documentation coverage,
- `npm test`,
- `npx tsc --noEmit --noUnusedLocals --noUnusedParameters`,
- `npm run build`,
- browser overflow check on Libraries after viewing the runtime injection contract.

Completion criteria:

- Skills Library explains canonical `SKILL.md` and Codex `AGENTS.md` managed block export,
- skill attachment remains context selection and does not create an `AgentRun`, move task cards, write product intent files, or bypass Review,
- Workbench and Loop remain the only current execution paths,
- future native implementation has an explicit start-time injection manifest boundary under `.agent-workspace/libraries/`.

## Step 29: Terminal Status Detection Boundary

Inputs:

- `docs/research/agentsroom-research-2026-06-24.md`
- `docs/superworks/spec/product-interaction-map.md`
- current Workbench terminal panel, Capability Map data, and runtime service contracts

Output:

- `terminal-status-detection` MVP core capability,
- Terminal Event Parser runtime contract separate from PTY Service and Run Store,
- Workbench panel that shows parser signal categories and run-scoped terminal event log path,
- spec text that records PTY parsing as shell-owned status detection rather than agent reasoning,
- plan/test coverage proving parser signals do not imply Review approval.

Verification:

- red test for Terminal Event Parser runtime contract,
- red test for Workbench parser signal UI,
- red test for spec/plan documentation coverage,
- `npm test`,
- `npx tsc --noEmit --noUnusedLocals --noUnusedParameters`,
- `npm run build`,
- browser overflow check on Workbench after viewing parser signals.

Completion criteria:

- terminal output parsing is represented as a product capability because research identifies it as status detection,
- parser event records point to `.agent-workspace/runs/<run-id>/terminal-events.jsonl`,
- parser signals can update live status surfaces but cannot create an `AgentRun`, approve Review, move task cards directly to Done, or write product-intent files,
- future native PTY parsing can replace the prototype signal panel without changing the scheduler/agent ownership boundary.

## Step 30: Task Intake / Backlog Capture

Inputs:

- `docs/research/agentsroom-research-2026-06-24.md`
- `docs/research/agentsroom-research-2026-06-24.zh.md`
- `docs/superworks/spec/product-interaction-map.md`
- current Task Board, Capability Map data, and task-state tests

Output:

- `task-intake` MVP core capability on the Backlog surface,
- Task Store runtime contract for task intake, queued board state, task events, and task artifacts,
- Task Board intake panel that exposes manual brief, watcher, screenshot/prototype, and prompt-context sources,
- spec text that records intake as capture before Loop or IDE execution,
- plan/test coverage for future task intake persistence under `.agent-workspace/tasks/`.

Verification:

- red test for Task Board intake UI,
- red test for Task Intake capability and Task Store runtime contract,
- red test for spec/plan documentation coverage,
- `npm test`,
- `npx tsc --noEmit --noUnusedLocals --noUnusedParameters`,
- `npm run build`,
- browser overflow check on Task Board after viewing Task Intake.

Completion criteria:

- Board-first task capture is visible before execution surfaces,
- intake event records point to `.agent-workspace/tasks/intake.jsonl`,
- intake can create only TODO/Queued task context and must not create an `AgentRun`, start PTY, move a task to Done, write runtime state into product-intent files, or bypass Review,
- Backlog Board and Task Artifacts share the Task Store boundary,
- future native task intake persistence can replace the prototype panel without changing the scheduler/agent ownership boundary.

## Step 31: Interactive Task Intake Flow

Inputs:

- `docs/superworks/spec/product-interaction-map.md`
- current Task Board intake panel
- task-state reducer, Audit Trail aggregation, and Task Store contract tests

Output:

- Task Board intake form for title, description, labels, owner, source, and optional artifact path,
- reducer action that creates a queued task and `TaskIntakeEvent` without creating an `AgentRun`, Loop schedule event, PTY session, Review approval, or Done transition,
- Audit Trail entry for intake evidence under `.agent-workspace/tasks/intake.jsonl`,
- spec text that records the interactive form behavior and task-store label ownership.

Verification:

- red test for reducer TaskIntakeEvent creation,
- red test for Task Board intake form submission,
- red test for Audit Trail intake aggregation,
- red test for spec/plan documentation coverage,
- `npm test`,
- `npx tsc --noEmit --noUnusedLocals --noUnusedParameters`,
- `npm run build`,
- browser overflow check on Task Board after submitting an intake draft.

Completion criteria:

- submitting the form creates a queued board-owned task and selects it,
- labels and optional artifact pointers are stored as task-store metadata,
- the task remains unexecuted until Loop or Workbench starts a run,
- Audit Trail can explain intake before any run, PTY, Loop schedule, or Review event exists.

## Step 32: Board-to-Run Start Action

Inputs:

- `docs/superworks/spec/product-interaction-map.md`
- current Task Board detail panel
- existing `startTaskRun` runtime adapter orchestration

Output:

- Task Detail action labeled `从 Loop 启动 Agent`,
- Board-to-run wiring that reuses the existing Loop/runtime adapter path,
- spec text that records Task Detail as a start surface without making the Board an execution owner.

Verification:

- red test for Task Detail Loop start button,
- red test for spec/plan documentation coverage,
- `npm test`,
- `npx tsc --noEmit --noUnusedLocals --noUnusedParameters`,
- `npm run build`,
- browser check from Board start action into IDE Workbench,
- browser overflow check on Task Board and Workbench after starting the task.

Completion criteria:

- Task Detail can start the selected task through the same run-store, PTY service, git service, and Loop schedule evidence used by Loop Console,
- the Board remains the state/control entry and does not create a hidden execution model,
- starting from Task Detail opens IDE Workbench with the new run context,
- Review still gates Done and PR handoff.

## Step 33: Review-to-Runs Handoff

Inputs:

- `docs/superworks/spec/product-interaction-map.md`
- Review approval reducer path
- Runs completion audit and PR handoff panel

Output:

- successful Review approval lands on Runs instead of returning directly to the Board,
- approval still records `ReviewApprovalEvent`, marks the task Done, and approves commit proposal,
- PR handoff remains a separate explicit Runs action that requires existing approval evidence.

Verification:

- red test for approval landing on Runs without automatic PR handoff,
- red test for spec/plan documentation coverage,
- `npm test`,
- `npx tsc --noEmit --noUnusedLocals --noUnusedParameters`,
- `npm run build`,
- browser check from Review approval to Runs PR handoff panel,
- browser overflow check on Review and Runs after approval.

Completion criteria:

- approving Review makes the run-scoped audit immediately visible,
- no `PullRequestHandoffEvent` is created until the user clicks Prepare PR handoff in Runs,
- Review remains the only Done gate and Runs remains the post-approval audit/handoff surface.

## Step 34: Notification-to-Surface Drilldown

Inputs:

- `docs/superworks/spec/product-interaction-map.md`
- current Notifications page and task-state reducer
- Board, Workbench, Review, and Runs surfaces that own task context

Output:

- notification events expose an Open context action,
- opening a notification selects the referenced task and routes to the matching product surface,
- waiting-input opens IDE Workbench, pending-review or failed-verification opens Review, done opens Runs, and other task states return to the Board,
- notification acknowledgement remains a separate action.

Verification:

- red test for notification context reducer routing,
- red test for Notifications Open context control,
- red test for spec/plan documentation coverage,
- `npm test`,
- `npx tsc --noEmit --noUnusedLocals --noUnusedParameters`,
- `npm run build`,
- browser check from Notifications to Workbench, Review, and Runs,
- browser overflow check on Notifications and routed surfaces after opening context.

Completion criteria:

- notification drill-down makes waiting/blocked/review/done states actionable without turning Notifications into a scheduler,
- opening context does not create an `AgentRun`, move task status, approve Review, create PR handoff, or acknowledge the event automatically,
- native desktop/mobile notification delivery can replace the prototype button while preserving shell-owned event evidence.

## Step 35: Audit Trail Source Drillback

Inputs:

- `docs/superworks/spec/product-interaction-map.md`
- current Audit Trail page and workspace audit builder
- task-state reducer actions for shell navigation

Output:

- each Audit Trail entry exposes an Open context action,
- opening an audit entry selects the referenced task when present,
- source surfaces map back to Task Board, Loop Console, Workbench, Review, Runs, Browser, MCP Gateway, Projects, Teams, Libraries, Notifications, Restore, or Dev Terminals,
- Audit Trail remains read-only evidence and does not own scheduling.

Verification:

- red test for audit entry reducer drill-back,
- red test for Audit Trail Open context control,
- red test for spec/plan documentation coverage,
- `npm test`,
- `npx tsc --noEmit --noUnusedLocals --noUnusedParameters`,
- `npm run build`,
- browser check from Audit Trail to Task Board, Review, and Runs,
- browser overflow check on Audit Trail and routed surfaces after opening context.

Completion criteria:

- workspace evidence can lead users back to the product surface that owns the next action,
- opening audit context does not create an `AgentRun`, move task status, approve Review, create PR handoff, acknowledge notifications, or mutate evidence records,
- Runs remains run-scoped while Audit Trail remains the read-only workspace evidence index.

## Step 36: Project Context IDE Focus

Inputs:

- `docs/superworks/spec/product-interaction-map.md`
- current Projects cockpit and IDE Workbench sidebar
- project context reducer and project-owned task/agent lists

Output:

- Workbench sidebar renders the selected project name, path, manifest, browser profile, project agents, and project tasks,
- selecting a project aligns the visible task and agent to project-owned ids when the previous focus belongs to another project,
- Projects-to-Workbench drill-down carries workspace context without creating execution side effects,
- spec text that records project context as an IDE focus boundary instead of a run lifecycle action.

Verification:

- red test for Workbench project-context sidebar,
- red test for reducer task/agent focus alignment on project selection,
- red test for spec/plan documentation coverage,
- `npm test`,
- `npx tsc --noEmit --noUnusedLocals --noUnusedParameters`,
- `npm run build`,
- browser check from Projects selection into Workbench project context,
- browser overflow check on Projects and Workbench after switching project context.

Completion criteria:

- opening Workbench from Projects no longer shows global hardcoded workspace data,
- selected project context scopes the Workbench agent list and bound task list,
- task/agent focus alignment does not create an `AgentRun`, move task cards, approve Review, start PTY, or write runtime state into product-intent files,
- native project manifests can replace the mock state without changing the IDE focus contract.

## Step 37: Task Selection Context Focus

Inputs:

- `docs/superworks/spec/product-interaction-map.md`
- current Task Board card selection and Workbench Bound tasks list
- project-owned task lists and agent owner bindings

Output:

- selecting a task aligns selected task id, owning project id, and owner agent id,
- Workbench Bound tasks continues to use the shared `select-task` reducer action,
- project mock data keeps task owners visible in the project agent roster,
- spec text that records task selection as focus alignment rather than scheduling.

Verification:

- red test for reducer task/project/agent focus alignment,
- red test for Workbench task selection control,
- red test for spec/plan documentation coverage,
- `npm test`,
- `npx tsc --noEmit --noUnusedLocals --noUnusedParameters`,
- `npm run build`,
- browser check for Workbench task selection focus,
- browser overflow check on Workbench after switching bound tasks.

Completion criteria:

- clicking a task from Board or Workbench keeps the visible task, project scope, and agent focus coherent,
- task selection does not create an `AgentRun`, start PTY, move task cards, approve Review, create PR handoff, or write runtime state into product-intent files,
- the task selection rule can later be backed by persisted project/task manifests without changing page contracts.

## Step 38: Agent Selection Context Focus

Inputs:

- `docs/superworks/spec/product-interaction-map.md`
- current IDE Workbench project agent list
- project-owned task lists and agent current task bindings

Output:

- selecting an agent in Workbench aligns to that agent's current task when that task belongs to the selected project,
- selecting an agent whose current task is outside the selected project keeps the current task and project context stable,
- Workbench agent selection remains a shell focus change rather than PTY or scheduler execution,
- spec text that records agent selection as focus alignment without scheduling side effects.

Verification:

- red test for reducer agent/project-owned-task focus alignment,
- red test for Workbench agent selection control,
- red test for spec/plan documentation coverage,
- `npm test`,
- `npx tsc --noEmit --noUnusedLocals --noUnusedParameters`,
- `npm run build`,
- browser check for Workbench agent selection focus,
- browser overflow check on Workbench after switching agent focus.

Completion criteria:

- clicking a project-owned agent keeps selected agent and visible task coherent inside the current project,
- agent selection does not create an `AgentRun`, start PTY, move task cards, approve Review, create PR handoff, or write runtime state into product-intent files,
- native project/task/agent manifests can replace the mock state without changing the Workbench selection contract.

## Step 39: Runtime Policy Visibility

Inputs:

- `docs/research/agentsroom-research-2026-06-24.zh.md`
- `docs/superworks/spec/product-interaction-map.md`
- current Workbench terminal panel and runtime adapter run-store mock

Output:

- each `AgentRun` carries runtime policy fields for permission mode, sandbox mode, effort level, CLI command, and policy artifact path,
- Run Store adapter creates runtime policy data with each mock run,
- Workbench shows a compact Runtime Policy strip beside the terminal transcript,
- Capability Map records Runtime Policy as an MVP core surface and service contract.

Verification:

- red test for Workbench runtime policy strip,
- red test for Run Store runtime policy data,
- red test for runtime orchestration preserving policy on active run,
- red test for Capability Map runtime policy coverage,
- red test for spec/plan documentation coverage,
- `npm test`,
- `npx tsc --noEmit --noUnusedLocals --noUnusedParameters`,
- `npm run build`,
- browser check for Workbench runtime policy visibility and overflow.

Completion criteria:

- users can see the granted runtime policy before treating terminal output as an execution surface,
- Runtime Policy is visible without starting a separate scheduler path or granting hidden capabilities,
- inspecting policy does not create an `AgentRun`, start PTY, move task cards, approve Review, create PR handoff, or write runtime state into product-intent files,
- native permission prompts and launch manifests can replace the mock policy without changing Workbench page contracts.

## Step 40: Runs Launch Policy Audit

Inputs:

- `docs/superworks/spec/product-interaction-map.md`
- current Runs completion audit
- workspace Audit Trail run entries
- Runtime Policy fields on `AgentRun`

Output:

- Runs shows launch policy evidence for selected `AgentRun`,
- Audit Trail indexes runtime policy as a separate Runs evidence entry,
- spec text records Runs as preserving Runtime Policy after Workbench execution context.

Verification:

- red test for Runs launch policy evidence box,
- red test for Audit Trail runtime policy evidence,
- red test for spec/plan documentation coverage,
- `npm test`,
- `npx tsc --noEmit --noUnusedLocals --noUnusedParameters`,
- `npm run build`,
- browser check for Runs launch policy visibility and overflow.

Completion criteria:

- users can inspect runtime policy from the run audit surface after leaving Workbench,
- policy evidence remains separate from transcript evidence,
- inspecting launch policy in Runs does not create an `AgentRun`, start PTY, move task cards, approve Review, create PR handoff, mutate policy, or write runtime state into product-intent files.

## Step 41: Terminal Parser Evidence Audit

Inputs:

- `docs/superworks/spec/product-interaction-map.md`
- current Workbench Terminal Event Parser panel
- Runs completion audit
- workspace Audit Trail event normalization

Output:

- typed `TerminalEvent` records with rule id, event kind, source line, mapped status, run id, task id, and event-log evidence path,
- Workbench shows terminal event evidence rows for the selected run,
- Runs preserves terminal parser evidence beside runtime policy, verification, and transcript context,
- Audit Trail indexes terminal parser events as separate run-scoped evidence.

Verification:

- red test for Workbench terminal event evidence rows,
- red test for Runs terminal parser evidence box,
- red test for Audit Trail terminal event evidence,
- red test for spec/plan documentation coverage,
- `npm test`,
- `npx tsc --noEmit --noUnusedLocals --noUnusedParameters`,
- `npm run build`,
- browser check for Workbench and Runs terminal parser evidence visibility and overflow.

Completion criteria:

- users can distinguish raw transcript text from shell-owned parser events,
- terminal parser evidence stays run-scoped and separately indexed from transcript evidence,
- inspecting terminal parser evidence does not create an `AgentRun`, start PTY, move task cards, approve Review, mutate terminal events, or write runtime state into product-intent files.

## Step 42: Task-Scoped MCP Evidence

Inputs:

- `docs/superworks/spec/product-interaction-map.md`
- current MCP Gateway tool-call event shape
- Review evidence panel
- Runs completion audit
- Audit Trail MCP event normalization

Output:

- `McpToolCallEvent` records include the current task id,
- Review shows task-scoped MCP tool evidence alongside browser, verification, staging, and redaction evidence,
- Runs preserves the same MCP tool evidence for the selected task,
- Audit Trail and audit drill-back preserve task context for MCP events.

Verification:

- red test for task-scoped `McpToolCallEvent` records,
- red test for Review and Runs MCP evidence panels,
- red test for Audit Trail task context on MCP events,
- red test for spec/plan documentation coverage,
- `npm test`,
- `npx tsc --noEmit --noUnusedLocals --noUnusedParameters`,
- `npm run build`,
- browser check from MCP Gateway request/approval into Review and Runs evidence panels.

Completion criteria:

- MCP tool calls are visible as task-owned shell evidence rather than isolated gateway history,
- Review and Runs can inspect MCP evidence without executing the tool or approving Review,
- selecting, requesting, resolving, or inspecting MCP evidence does not create an `AgentRun`, start PTY, move task cards, mark Review complete, create PR handoff, or write runtime state into product-intent files.

## Step 43: Terminal Parser Signal Routing

Inputs:

- `docs/superworks/spec/product-interaction-map.md`
- current Workbench Terminal Event Parser panel
- task board state machine
- notification routing surface
- terminal event audit records

Output:

- Workbench terminal event rows expose an explicit Apply signal action,
- reducer applies terminal parser task-status signals to the selected task without creating new runs,
- prompt-wait signals route tasks to `waiting-input` and create notification evidence,
- notification cards show source terminal event id, source summary, and terminal event evidence path.

Verification:

- red test for applying terminal parser wait signals to task state and notifications,
- red test for Workbench Apply signal control,
- red test for Notifications parser signal source evidence,
- red test for spec/plan documentation coverage,
- `npm test`,
- `npx tsc --noEmit --noUnusedLocals --noUnusedParameters`,
- `npm run build`,
- browser check from Workbench Apply signal into Notifications parser source evidence.

Completion criteria:

- terminal parser events can update Board-visible task state only through an explicit shell action,
- parser-sourced notifications preserve the terminal event evidence path,
- prompt-wait routes to Workbench through existing notification context rules,
- done-like parser signals still stop at pending Review and cannot mark Done,
- applying parser signals does not create an `AgentRun`, start PTY, approve Review, create PR handoff, acknowledge notifications, or write runtime state into product-intent files.

## Step 44: Terminal Done Signal Review Gate Routing

Inputs:

- `docs/superworks/spec/product-interaction-map.md`
- current Workbench Terminal Event Parser panel
- task board state machine
- Review gate evidence panel
- notification routing surface

Output:

- mock terminal event data includes a `done-signal` completion claim mapped from run `completed` to task `pending-review`,
- reducer applies that signal through the same explicit shell action path as other parser signals,
- Review shows the terminal completion claim as parser evidence, including rule id, source line, mapped status, and event-log evidence path,
- notification evidence preserves the source terminal event id and routes the user to Review.

Verification:

- red test for done-signal to pending-review reducer routing,
- red test for Review terminal completion claim evidence,
- red test for spec/plan documentation coverage,
- `npm test`,
- `npx tsc --noEmit --noUnusedLocals --noUnusedParameters`,
- `npm run build`,
- browser check from Workbench Apply signal into Review terminal completion claim evidence.

Completion criteria:

- Terminal done-signal routes to `pending-review`, not `done`,
- Review shows the terminal completion claim as parser evidence without treating it as approval,
- applying a done-signal does not create an `AgentRun`, start PTY, approve Review, create PR handoff, acknowledge notifications, mark the task Done, or write runtime state into product-intent files.

## Step 45: Review Approval Done Notification Routing

Inputs:

- `docs/superworks/spec/product-interaction-map.md`
- Review approval reducer path
- Notification queue source evidence rendering
- Runs audit route rules

Output:

- successful Review approval appends a `done` notification sourced from the `ReviewApprovalEvent`,
- notification source metadata can label parser signals and Review approval evidence separately,
- opening a done notification continues to route to Runs through existing notification context rules,
- PR handoff remains an explicit Runs action after approval and is not created by the notification.

Verification:

- red test for Done notification from review approval evidence,
- red test for Notifications Review approval source evidence,
- red test for spec/plan documentation coverage,
- `npm test`,
- `npx tsc --noEmit --noUnusedLocals --noUnusedParameters`,
- `npm run build`,
- browser check from Review approval into Notifications source evidence and Runs route.

Completion criteria:

- Review approval creates a done notification with approval event id, approval evidence path, and sidebar destination,
- Notifications display Review approval source evidence separately from parser source evidence,
- the done notification opens Runs and must not create PR handoff, acknowledge notifications, start PTY, create an `AgentRun`, or write runtime state into product-intent files.

## Step 46: Runtime Policy Audit Drillback

Inputs:

- `docs/superworks/spec/product-interaction-map.md`
- Audit Trail runtime policy entries
- audit entry context reducer routing
- Runs launch policy evidence panel

Output:

- Runtime Policy audit entries route back to Runs for the referenced task/run,
- the drill-back path reuses existing Runs launch policy evidence instead of adding a separate policy page,
- opening Runtime Policy audit context records only shell navigation context and no scheduler side effects.

Verification:

- red test for Runtime Policy audit context reducer routing,
- red test for spec/plan documentation coverage,
- `npm test`,
- `npx tsc --noEmit --noUnusedLocals --noUnusedParameters`,
- `npm run build`,
- browser check from Audit Trail runtime policy entry into Runs.

Completion criteria:

- clicking `run-policy-<run-id>` in Audit Trail opens Runs and selects the referenced task context,
- Runtime Policy drill-back does not create an `AgentRun`, move task status, approve Review, create PR handoff, acknowledge notifications, mutate evidence records, or write runtime state into product-intent files,
- Runs remains the run-scoped place to inspect launch policy evidence.

## Step 47: Notification Source Evidence In Audit Trail

Inputs:

- `docs/superworks/spec/product-interaction-map.md`
- notification events with parser and Review approval source metadata
- Workspace Audit Trail event normalization
- Audit Trail evidence rendering

Output:

- Notification audit entries preserve source label, source event id, source summary, and source evidence path,
- Audit Trail renders notification source evidence separately from the notification event artifact path,
- parser-sourced and Review-approval-sourced notifications remain distinguishable at the workspace evidence level.

Verification:

- red test for Audit Trail notification source evidence normalization,
- red test for Audit Trail notification source evidence rendering,
- red test for spec/plan documentation coverage,
- `npm test`,
- `npx tsc --noEmit --noUnusedLocals --noUnusedParameters`,
- `npm run build`,
- browser check for Audit Trail notification source evidence visibility and overflow.

Completion criteria:

- Workspace Audit Trail shows the notification event artifact and the source event artifact as separate evidence,
- parser-sourced notification evidence and Review approval notification evidence use distinct labels,
- inspecting notification audit entries does not acknowledge notifications, open notification context automatically, move task status, approve Review, create PR handoff, start PTY, create an `AgentRun`, or write runtime state into product-intent files.

## Step 48: Agent-Conversation Redaction Audit Context

Inputs:

- `docs/superworks/spec/product-interaction-map.md`
- run-scoped `CommitRedactionScan` records
- Workspace Audit Trail event normalization
- Audit Trail metadata rendering
- Review drill-back routing for redaction entries

Output:

- Redaction audit entries preserve task id, run id, transcript path, matched patterns, and redaction artifact path,
- Audit Trail renders run id as first-class metadata beside task id for run-scoped evidence,
- opening a redaction audit context continues to route to Review without changing scheduler or approval state.

Verification:

- red test for redaction audit task/run context normalization,
- red test for Audit Trail redaction run metadata rendering,
- red test for spec/plan documentation coverage,
- `npm test`,
- `npx tsc --noEmit --noUnusedLocals --noUnusedParameters`,
- `npm run build`,
- browser check from Review redaction scan into Audit Trail redaction evidence and Review drill-back.

Completion criteria:

- Workspace Audit Trail shows `redaction-<run-id>` entries with task id, run id, transcript path, matched patterns, and `.agent-workspace/runs/<run-id>/redaction.json`,
- clicking a redaction audit entry opens Review for the referenced task,
- inspecting redaction audit context does not create an `AgentRun`, move task status, approve Review, create PR handoff, acknowledge notifications, mutate redaction evidence, or write runtime state into product-intent files.

## Step 49: Capability Coverage Matrix

Inputs:

- `docs/superworks/spec/product-interaction-map.md`
- current `productCapabilities` and `runtimeContracts`
- Capability Map page and coverage tests

Output:

- Capability Map renders a read-only coverage matrix,
- the matrix shows total capability count and counts for MVP core, MVP extension, advanced, and deferred phases,
- the matrix shows runtime boundary mapping, evidence field coverage, and next native step coverage,
- spec text records the matrix as a product completeness view without scheduler side effects.

Verification:

- red test for Capability Map coverage matrix rendering,
- red test for spec/plan coverage matrix documentation,
- `npm test`,
- `npx tsc --noEmit --noUnusedLocals --noUnusedParameters`,
- `npm run build`,
- browser check for Capability Map coverage matrix visibility and overflow.

Completion criteria:

- users can see whether every designed capability has a phase, runtime boundary, evidence pointer, and next native step,
- the matrix stays inside Capability Map and does not add a new product surface,
- inspecting the matrix does not create an `AgentRun`, move task status, approve Review, open advanced surfaces, mutate evidence, or write runtime state into product-intent files.

## Step 50: Primary Interaction Backbone

Inputs:

- `docs/superworks/spec/product-interaction-map.md`
- current Capability Map page
- Board-first primary path in the interaction model

Output:

- Capability Map renders a read-only primary interaction backbone,
- the backbone shows Board, Loop, Run Store, PTY/Git, IDE Workbench, Review Gate, and Runs Audit as one default product path,
- each backbone step shows owner and evidence pointer,
- spec text records the backbone as an end-to-end explanation without scheduler side effects.

Verification:

- red test for Capability Map primary interaction backbone rendering,
- red test for spec/plan primary backbone documentation,
- `npm test`,
- `npx tsc --noEmit --noUnusedLocals --noUnusedParameters`,
- `npm run build`,
- browser check for Capability Map primary backbone visibility and overflow.

Completion criteria:

- users can see how Board-first task context flows into Loop scheduling, run creation, PTY/Git execution, IDE drill-down, Review, and Runs audit,
- the backbone stays inside Capability Map and does not add a new product surface,
- inspecting the backbone does not create an `AgentRun`, start PTY, move task status, approve Review, create PR handoff, mutate evidence, or write runtime state into product-intent files.

## Step 51: Page Ownership Matrix

Inputs:

- `docs/superworks/spec/product-interaction-map.md`
- current Capability Map page
- current visible product pages and ownership guardrails

Output:

- Capability Map renders a read-only page ownership matrix,
- the matrix groups Board/Task Intake, Loop Console, IDE Workbench, Review/Runs/Audit Trail, context surfaces, and advanced automation,
- each row shows the owned product responsibility, visible surfaces, and the guardrail that prevents the surface from taking over scheduler, runtime, or review duties,
- spec text records the matrix as a page responsibility map without scheduler side effects.

Verification:

- red test for Capability Map page ownership matrix rendering,
- red test for spec/plan page ownership documentation,
- `npm test`,
- `npx tsc --noEmit --noUnusedLocals --noUnusedParameters`,
- `npm run build`,
- browser check for Capability Map page ownership matrix visibility and overflow.

Completion criteria:

- users can understand which page owns task state, scheduling, PTY execution, review/audit evidence, context setup, and advanced automation,
- the matrix stays inside Capability Map and does not add a new navigation surface,
- inspecting the matrix does not create an `AgentRun`, start PTY, move task status, approve Review, execute MCP tools, capture browser evidence, create PR handoff, mutate evidence, or write runtime state into product-intent files.

## Step 52: Interaction Route Matrix

Inputs:

- `docs/superworks/spec/product-interaction-map.md`
- current Capability Map page
- existing cross-page routes from Board, Loop, Workbench, Review, Notifications, Audit Trail, Projects, and Libraries

Output:

- Capability Map renders a read-only interaction route matrix,
- the matrix distinguishes navigation-only drill-down, context focus, scheduler start, review approval, audit drill-back, and library/project context handoff,
- each route shows its visible route, intended state effect, evidence pointer, and guardrail,
- spec text records the route matrix as the cross-page navigation and side-effect map without introducing a new scheduler path.

Verification:

- red test for Capability Map interaction route matrix rendering,
- red test for spec/plan route matrix documentation,
- `npm test`,
- `npx tsc --noEmit --noUnusedLocals --noUnusedParameters`,
- `npm run build`,
- browser check for Capability Map interaction route matrix visibility and overflow.

Completion criteria:

- users can distinguish route-only navigation from routes that create scheduler, run, review, or audit evidence,
- the matrix stays inside Capability Map and does not add a new navigation surface,
- inspecting the matrix does not create an `AgentRun`, start PTY, move task status, approve Review, acknowledge notifications, execute MCP tools, capture browser evidence, create PR handoff, mutate evidence, or write runtime state into product-intent files.

## Step 53: Action Side-Effect Matrix

Inputs:

- `docs/superworks/spec/product-interaction-map.md`
- current Capability Map page
- owning-surface actions from Task Intake, context selection, Loop start, terminal parser signal apply, Review evidence, Review approval, and Runs PR handoff

Output:

- Capability Map renders a read-only action side-effect matrix,
- the matrix distinguishes capture-only, focus-only, scheduler-start, parser-apply, review-evidence, review-approval, and PR-handoff actions,
- each action shows its visible action label, intended state effect, evidence pointer, and guardrail,
- spec text records the action matrix as the integrated action boundary map without introducing a new execution path.

Verification:

- red test for Capability Map action side-effect matrix rendering,
- red test for spec/plan action matrix documentation,
- `npm test`,
- `npx tsc --noEmit --noUnusedLocals --noUnusedParameters`,
- `npm run build`,
- browser check for Capability Map action side-effect matrix visibility and overflow.

Completion criteria:

- users can see which integrated controls are read/focus actions, which create scheduler/runtime evidence, which only create review evidence, which approve Done, and which prepare PR handoff,
- the matrix stays inside Capability Map and does not add a new navigation surface,
- inspecting the matrix does not create an `AgentRun`, start PTY, move task status, approve Review, acknowledge notifications, execute MCP tools, capture browser evidence, prepare PR handoff, mutate evidence, or write runtime state into product-intent files.

## Step 54: Durable Evidence Ledger Matrix

Inputs:

- `docs/superworks/spec/product-interaction-map.md`
- current Capability Map page
- shell-owned event streams and artifact paths from Task Store, Loop Scheduler, Run Store, Review, Projects, Libraries, Browser, MCP, Notifications, Restore, and Teams

Output:

- Capability Map renders a read-only durable evidence ledger,
- the ledger groups task-store, loop-schedule, run, review, context, and advanced automation records,
- each ledger row shows the record kind, future `.agent-workspace/` store, reader surfaces, and guardrail,
- spec text records the ledger as the shell-owned persistence map without moving runtime state into product-intent files.

Verification:

- red test for Capability Map durable evidence ledger rendering,
- red test for spec/plan durable ledger documentation,
- `npm test`,
- `npx tsc --noEmit --noUnusedLocals --noUnusedParameters`,
- `npm run build`,
- browser check for Capability Map durable evidence ledger visibility and overflow.

Completion criteria:

- users can see where task, schedule, run, review, context, and advanced evidence records will live in the future desktop runtime,
- the ledger stays inside Capability Map and does not add a new navigation surface,
- inspecting the ledger does not create an `AgentRun`, start PTY, move task status, approve Review, acknowledge notifications, execute MCP tools, capture browser evidence, prepare PR handoff, mutate runtime evidence, or write runtime state into product-intent files.

## Step 55: Native Runtime Readiness Matrix

Inputs:

- `docs/superworks/spec/product-interaction-map.md`
- current Capability Map page
- current mock runtime adapters and future desktop service targets

Output:

- Capability Map renders a read-only native runtime readiness matrix,
- the matrix groups Run Store, PTY, Git, Filesystem Watch, Browser/MCP, and Project/Library store replacements,
- each row shows what mock behavior is replaced, the native target, and the guardrail that preserves scheduler, evidence, and review boundaries,
- spec text records the readiness matrix as the mock-to-native replacement map without performing runtime adapter replacement.

Verification:

- red test for Capability Map native runtime readiness rendering,
- red test for spec/plan native readiness documentation,
- `npm test`,
- `npx tsc --noEmit --noUnusedLocals --noUnusedParameters`,
- `npm run build`,
- browser check for Capability Map native runtime readiness visibility and overflow.

Completion criteria:

- users can see how the Vite prototype moves toward the desktop IDE runtime without changing the Board-first, Loop-visible, IDE-drill-down interaction contract,
- the matrix stays inside Capability Map and does not add a new navigation surface,
- inspecting the matrix does not create an `AgentRun`, start PTY, move task status, approve Review, acknowledge notifications, execute MCP tools, capture browser evidence, prepare PR handoff, mutate runtime evidence, replace adapters at runtime, or write runtime state into product-intent files.

## Step 56: Command Surface Matrix

Inputs:

- `docs/superworks/spec/product-interaction-map.md`
- current Capability Map page
- owning-surface actions from Board, Loop, Workbench, Review, Runs, MCP, Browser, and Teams
- future desktop IDE command palette boundary

Output:

- Capability Map renders a read-only command surface matrix,
- the matrix groups focus-only, scheduler-start, parser-apply, review-gate, PR-handoff, and advanced tool commands,
- each row shows the command label, owning route, intended state effect, and guardrail,
- spec text records the command matrix as the future desktop command-entry boundary without opening or implementing a command palette.

Verification:

- red test for Capability Map command surface matrix rendering,
- red test for spec/plan command surface documentation,
- `npm test`,
- `npx tsc --noEmit --noUnusedLocals --noUnusedParameters`,
- `npm run build`,
- browser check for Capability Map command surface matrix visibility and overflow.

Completion criteria:

- users can see how a future desktop IDE command palette would route commands through the existing owning surfaces,
- the matrix stays inside Capability Map and does not add a new navigation surface,
- inspecting the matrix does not create an `AgentRun`, start PTY, move task status, approve Review, acknowledge notifications, execute MCP tools, capture browser evidence, prepare PR handoff, mutate runtime evidence, open a hidden command palette, or write runtime state into product-intent files.

## Step 57: Failure Recovery Matrix

Inputs:

- `docs/superworks/spec/product-interaction-map.md`
- current Capability Map page
- existing non-happy-path interactions for runtime start failure, failed verification, denied MCP confirmation, PTY/dev-command failure, TeamRun max-cycle block, and Restore manifest recovery

Output:

- Capability Map renders a read-only failure recovery matrix,
- the matrix groups runtime-start failure, failed verification, denied MCP confirmation, PTY/dev-command failure, team max-cycle block, and restore mismatch,
- each row shows the failure state, owning surface, recovery behavior, evidence path, and guardrail,
- spec text records the failure matrix as the non-happy-path recovery boundary without adding automatic retry behavior.

Verification:

- red test for Capability Map failure recovery matrix rendering,
- red test for spec/plan failure recovery documentation,
- `npm test`,
- `npx tsc --noEmit --noUnusedLocals --noUnusedParameters`,
- `npm run build`,
- browser check for Capability Map failure recovery matrix visibility and overflow.

Completion criteria:

- users can see which page owns each failure recovery decision and which evidence path explains it,
- the matrix stays inside Capability Map and does not add a new navigation surface,
- inspecting the matrix does not create an `AgentRun`, start PTY, retry a command, move task status, approve Review, acknowledge notifications, execute MCP tools, capture browser evidence, prepare PR handoff, mutate runtime evidence, replay agents, or write runtime state into product-intent files.

## Step 58: State Lifecycle Matrix

Inputs:

- `docs/superworks/spec/product-interaction-map.md`
- current Capability Map page
- task machine status map, AgentRun statuses, Review gate evidence, and Notification routing rules

Output:

- Capability Map renders a read-only state lifecycle matrix,
- the matrix separates queued task state, active run state, pending review claim state, failed verification state, and Review-approved Done state,
- each row shows task state, run state, evidence, and guardrail,
- spec text records the state matrix as the task-run-review-notification status boundary without changing reducer behavior.

Verification:

- red test for Capability Map state lifecycle matrix rendering,
- red test for spec/plan state lifecycle documentation,
- red test for Capability Map state matrix responsive constraints,
- `npm test`,
- `npx tsc --noEmit --noUnusedLocals --noUnusedParameters`,
- `npm run build`,
- browser check for Capability Map state lifecycle matrix visibility and overflow.

Completion criteria:

- users can distinguish task state from run state, review evidence, and notification routing,
- the matrix stays inside Capability Map and does not add a new navigation surface,
- inspecting the matrix does not create an `AgentRun`, start PTY, move task status, approve Review, acknowledge notifications, prepare PR handoff, mutate runtime evidence, collapse run `completed` into task `done`, or write runtime state into product-intent files.

## Step 59: Surface Composition Matrix

Inputs:

- `docs/superworks/spec/product-interaction-map.md`
- current Capability Map page
- current page components for Task Board, Loop Console, IDE Workbench, Review, Runs, Audit Trail, and advanced surfaces

Output:

- Capability Map renders a read-only surface composition matrix,
- the matrix maps each major product page group to its primary workspace, context panel, evidence rail, and primary action,
- the matrix covers Task Board, Loop Console, IDE Workbench, Review, Runs/Audit, and advanced surfaces,
- spec text records the page-internal composition boundary without adding a second navigation model or changing page reducers.

Verification:

- red test for Capability Map surface composition matrix rendering,
- red test for spec/plan surface composition documentation,
- red test for Capability Map surface matrix responsive constraints,
- `npm test`,
- `npx tsc --noEmit --noUnusedLocals --noUnusedParameters`,
- `npm run build`,
- browser check for Capability Map surface composition matrix visibility and overflow.

Completion criteria:

- users can see what each page must contain before the mock runtime becomes a desktop IDE workbench,
- the matrix stays inside Capability Map and does not add a new navigation surface,
- inspecting the matrix does not create an `AgentRun`, start PTY, move task status, approve Review, acknowledge notifications, prepare PR handoff, mutate runtime evidence, inject library context, request MCP tools, replay agents, or write runtime state into product-intent files.

## Step 60: Data Model Boundary Matrix

Inputs:

- `docs/superworks/spec/product-interaction-map.md`
- current Capability Map page
- current domain types for Project, Agent, Task, AgentRun, Review evidence, Task artifacts, and Notifications

Output:

- Capability Map renders a read-only data model boundary matrix,
- the matrix maps core product objects to owned fields, reader/writer surfaces, evidence stores, and guardrails,
- the matrix covers Project context, Agent profile, Task record, AgentRun record, Review package, Task artifact, and Notification signal,
- spec text records the object ownership boundary without changing reducers, adapters, runtime persistence, or `.agent-workspace/` writes.

Verification:

- red test for Capability Map data model boundary matrix rendering,
- red test for spec/plan data model boundary documentation,
- red test for Capability Map data model responsive constraints,
- `npm test`,
- `npx tsc --noEmit --noUnusedLocals --noUnusedParameters`,
- `npm run build`,
- browser check for Capability Map data model boundary matrix visibility and overflow.

Completion criteria:

- users can distinguish product object ownership before native persistence is introduced,
- the matrix stays inside Capability Map and does not add a new navigation surface,
- inspecting the matrix does not create an `AgentRun`, start PTY, move task status, approve Review, acknowledge notifications, prepare PR handoff, mutate runtime evidence, attach artifacts, inject library context, request MCP tools, write `.agent-workspace/` runtime state, or write runtime state into product-intent files.

## Step 61: Permission Confirmation Matrix

Inputs:

- `docs/superworks/spec/product-interaction-map.md`
- current Capability Map page
- current side-effect boundaries for read-only inspection, focus routing, runtime launch, PTY write, Review approval, PR handoff, MCP confirmation, browser evidence, dev commands, restore, and notifications

Output:

- Capability Map renders a read-only permission confirmation matrix,
- the matrix maps product actions to confirmation class, confirmation owner, evidence, and guardrails,
- the matrix covers read-only inspection, focus routing, runtime launch, PTY write, Review gate, PR handoff, confirm-class MCP, advanced explicit action, and notification acknowledgement,
- spec text records the explicit consent boundary without changing reducers, adapters, native permission prompts, or runtime persistence.

Verification:

- red test for Capability Map permission confirmation matrix rendering,
- red test for spec/plan permission confirmation documentation,
- red test for Capability Map permission matrix responsive constraints,
- `npm test`,
- `npx tsc --noEmit --noUnusedLocals --noUnusedParameters`,
- `npm run build`,
- browser check for Capability Map permission confirmation matrix visibility and overflow.

Completion criteria:

- users can distinguish actions that need no confirmation, focus-only actions, scheduler-start actions, PTY writes, review-gated actions, PR handoff actions, confirm-class MCP tools, advanced explicit actions, and notification acknowledgement,
- the matrix stays inside Capability Map and does not add a new navigation surface,
- inspecting the matrix does not create an `AgentRun`, start PTY, write to PTY, move task status, approve Review, acknowledge notifications, prepare PR handoff, execute MCP tools, capture browser evidence, start dev commands, restore sessions, mutate runtime evidence, write `.agent-workspace/` runtime state, or write runtime state into product-intent files.

## Step 62: Context Propagation Matrix

Inputs:

- `docs/superworks/spec/product-interaction-map.md`
- current Capability Map page
- current focus alignment rules for project, task, agent, run, review, library/artifact, notification, and audit contexts

Output:

- Capability Map renders a read-only context propagation matrix,
- the matrix maps each selected context to its source surface, carried fields, destination surfaces, and guardrail,
- the matrix covers Project focus, Task focus, Agent focus, Run focus, Review focus, Library and artifact context, and Notification and audit context,
- spec text records the focus propagation boundary without changing reducers, adapters, runtime persistence, route behavior, or context injection behavior.

Verification:

- red test for Capability Map context propagation matrix rendering,
- red test for spec/plan context propagation documentation,
- red test for Capability Map context matrix responsive constraints,
- `npm test`,
- `npx tsc --noEmit --noUnusedLocals --noUnusedParameters`,
- `npm run build`,
- browser check for Capability Map context propagation matrix visibility and overflow.

Completion criteria:

- users can see how selecting project, task, agent, run, review, library/artifact, notification, or audit context carries visible focus across product surfaces,
- the matrix stays inside Capability Map and does not add a new navigation surface,
- inspecting the matrix does not create an `AgentRun`, start PTY, write to PTY, move task status, approve Review, acknowledge notifications, inject library context, attach artifacts, prepare PR handoff, execute MCP tools, mutate runtime evidence, write `.agent-workspace/` runtime state, or write runtime state into product-intent files.

## Step 63: Product Workflow Trace Matrix

Inputs:

- `docs/superworks/spec/product-interaction-map.md`
- current Capability Map page
- current default delivery flow from Task Intake, Board selection, Loop scheduling, Workbench execution, Review approval, Runs audit, and PR handoff

Output:

- Capability Map renders a read-only product workflow trace,
- the trace sequences intake captured, task selected, Loop scheduled, IDE run active, Review gate, Runs audit, and optional PR handoff,
- each row shows the owning surface, evidence path, and guardrail for the step,
- spec text records the end-to-end delivery trace without changing reducers, adapters, runtime persistence, route behavior, or PR handoff behavior.

Verification:

- red test for Capability Map product workflow trace rendering,
- red test for spec/plan product workflow trace documentation,
- red test for Capability Map workflow trace responsive constraints,
- `npm test`,
- `npx tsc --noEmit --noUnusedLocals --noUnusedParameters`,
- `npm run build`,
- browser check for Capability Map product workflow trace visibility and overflow.

Completion criteria:

- users can read the default delivery path as one trace across Board-first, Loop-visible, IDE-drill-down surfaces,
- the trace stays inside Capability Map and does not add a new navigation surface,
- inspecting the trace does not create an `AgentRun`, start PTY, write to PTY, move task status, approve Review, acknowledge notifications, inject library context, attach artifacts, prepare PR handoff, execute MCP tools, mutate runtime evidence, write `.agent-workspace/` runtime state, or write runtime state into product-intent files.

## Step 64: Surface Control Catalog Matrix

Inputs:

- `docs/superworks/spec/product-interaction-map.md`
- current Capability Map page
- current visible controls and App dispatch routes for Task Board, Loop Console, IDE Workbench, Review, Runs/Audit, Projects/Libraries, and advanced surfaces

Output:

- Capability Map renders a read-only surface control catalog,
- the catalog maps each major page group to primary controls, availability state, evidence path, and guardrail,
- the catalog covers Task Board controls, Loop Console controls, IDE Workbench controls, Review controls, Runs and Audit controls, Projects and Libraries controls, and advanced surface controls,
- spec text records the page action and availability boundary without changing reducers, adapters, runtime persistence, route behavior, empty states, disabled states, or action side effects.

Verification:

- red test for Capability Map surface control catalog rendering,
- red test for spec/plan surface control catalog documentation,
- red test for Capability Map control catalog responsive constraints,
- `npm test`,
- `npx tsc --noEmit --noUnusedLocals --noUnusedParameters`,
- `npm run build`,
- browser check for Capability Map surface control catalog visibility and overflow.

Completion criteria:

- users can see what each major page control is allowed to do, what state makes it meaningful, and which evidence it creates,
- the catalog stays inside Capability Map and does not add a new navigation surface,
- inspecting the catalog does not create an `AgentRun`, start PTY, write to PTY, move task status, approve Review, acknowledge notifications, inject library context, attach artifacts, prepare PR handoff, execute MCP tools, capture browser evidence, start dev commands, restore sessions, mutate runtime evidence, write `.agent-workspace/` runtime state, or write runtime state into product-intent files.

## Step 65: Board-first Navigation Simplification

Inputs:

- `docs/superworks/spec/product-interaction-map.md`
- current `App.tsx` primary navigation
- user decision to reduce first-level navigation below six entries
- existing Board-first, Loop-visible, IDE-drill-down product direction

Output:

- primary navigation shows only Task Board, IDE Workbench, Delivery Gate, and More,
- Delivery Gate groups Review, Runs, and Audit Trail as the delivery and evidence entry,
- More groups Projects, Libraries, Loop Console, Plan Watcher, MCP Gateway, Browser Automation, Agent Teams, Dev Terminals, Notifications, Restore Session, and Product Map,
- previously visible advanced and design surfaces remain reachable through grouped secondary entries,
- UI labels become Chinese-first while preserving Agent, Loop, Run, IDE, Review, PR, MCP, PTY, and Git as product terms.

Verification:

- red test for four primary navigation entries,
- red test for grouped Delivery Gate secondary entries,
- red test for grouped More secondary entries,
- red test for spec/plan navigation simplification documentation,
- `npm test`,
- `npx tsc --noEmit --noUnusedLocals --noUnusedParameters`,
- `npm run build`,
- browser check for four primary nav entries, secondary page reachability, active nav grouping, and overflow.

Completion criteria:

- users first see a Board-first workbench instead of a feature directory,
- Task Board remains the default entry,
- Loop status remains visible on task cards and detail while Loop Console moves behind More,
- Review, Runs, and Audit Trail remain accessible through Delivery Gate,
- Projects, Libraries, automation, advanced surfaces, and Product Map remain reachable through More,
- navigation simplification does not delete product capability data, reducer routes, runtime adapter behavior, review evidence, audit evidence, or `.agent-workspace/` persistence contracts.

## Step 66: Chinese-first Core Copy Pass

Inputs:

- `docs/superworks/spec/product-interaction-map.md`
- current App shell, Task Board intake panel, and Projects cockpit
- user decision to keep the prototype Chinese-first instead of adding a Chinese/English switch
- existing Board-first, Loop-visible, IDE-drill-down product direction

Output:

- App shell subtitle uses Chinese-first product prototype copy,
- Task Board intake labels and submit action use Chinese-first wording,
- Projects cockpit headings and primary actions use Chinese-first wording,
- Agent, Loop, Run, IDE, Review, PR, MCP, PTY, Git, and product evidence terms remain stable as product terms,
- no i18n runtime state, language toggle, translation dictionary, or duplicate bilingual UI is introduced.

Verification:

- red test for shell subtitle and core navigation copy,
- red test for task intake Chinese labels and submit action,
- red test for project cockpit Chinese headings and actions,
- red test for spec/plan Chinese-first copy documentation,
- `npm test`,
- `npx tsc --noEmit --noUnusedLocals --noUnusedParameters`,
- `npm run build`,
- browser check for Chinese-first shell, task intake, project cockpit, and overflow.

Completion criteria:

- users first read the core prototype in one primary language,
- technical product terms remain recognizable for future desktop runtime work,
- language selection does not become product scope for the first prototype,
- copy normalization does not change reducer routes, runtime adapter behavior, task intake events, project context events, review evidence, audit evidence, or `.agent-workspace/` persistence contracts.

## Step 67: Board Task Detail Progressive Disclosure

Inputs:

- `docs/superworks/spec/product-interaction-map.md`
- current Task Board page
- user concern that the prototype still feels redundant and complex
- existing Board-first, Loop-visible, IDE-drill-down product direction

Output:

- Task Board keeps a compact selected-task summary visible by default,
- task state, Loop status, Run id, Agent owner, verification, and IDE drill-down remain first-scan information,
- full task detail, artifacts, and transition audit are hidden until the user opens task details,
- opening details reveals existing evidence and actions without changing scheduler, runtime, or Review behavior.

Verification:

- red test for compact selected-task summary,
- red test for hidden detail evidence until user drill-down,
- red test for spec/plan progressive disclosure documentation,
- `npm test`,
- `npx tsc --noEmit --noUnusedLocals --noUnusedParameters`,
- `npm run build`,
- browser check for Board summary visibility, detail drill-down, and overflow.

Completion criteria:

- default Board view reads as task queue plus current task summary instead of a dense evidence dashboard,
- Loop and Run visibility remain exposed before IDE drill-down,
- task evidence remains available from an explicit detail action,
- opening details does not create an `AgentRun`, start PTY, move task status, approve Review, mutate runtime evidence, or write `.agent-workspace/` runtime state.

## Step 68: Task Intake Progressive Disclosure

Inputs:

- `docs/superworks/spec/product-interaction-map.md`
- current Task Board intake panel
- user concern that the default prototype still feels redundant and complex
- existing Board-first, Loop-visible, IDE-drill-down product direction

Output:

- Task Intake shows a compact default capture row with task title, submit action, guardrails, and event stream,
- advanced context fields are hidden behind an explicit expansion action,
- expanded context reveals description, labels, owner, intake source, optional artifact path, and source explanations,
- compact submission records the same Task Store intake event using manual-brief, Planner, empty summary, empty labels, and no artifact defaults.

Verification:

- red test for compact task intake default state,
- red test for advanced context fields behind explicit expansion,
- red test for compact intake default submission,
- red test for spec/plan task intake progressive disclosure documentation,
- `npm test`,
- `npx tsc --noEmit --noUnusedLocals --noUnusedParameters`,
- `npm run build`,
- browser check for compact intake default, expanded context fields, submission controls, and overflow.

Completion criteria:

- the Board first scan shows capture intent without exposing every metadata field,
- advanced intake context remains available through one explicit action,
- compact capture does not create an `AgentRun`, start PTY, move task status, approve Review, mutate runtime evidence, or write `.agent-workspace/` runtime state outside the Task Store intake path,
- existing task intake payload behavior remains intact for expanded fields.

## Step 69: Board Chrome Chinese-first Cleanup

Inputs:

- `docs/superworks/spec/product-interaction-map.md`
- current App shell loop stage labels
- current Task Board top toolbar and Loop summary panel
- user decision to keep the prototype Chinese-first without language switching

Output:

- Board principle strip uses Chinese-first copy while preserving Loop and IDE terms,
- ownership pills use Chinese-first explanations for task state, Loop scheduling, IDE run surface, and Review/Done gate,
- Loop summary title and loop stage labels use Chinese-first copy,
- routing, scheduler state, runtime adapters, task intake, task transitions, and Review behavior are unchanged.

Verification:

- red test for default board principle strip Chinese-first copy,
- red test for Loop summary Chinese-first labels,
- red test for spec/plan board chrome cleanup documentation,
- `npm test`,
- `npx tsc --noEmit --noUnusedLocals --noUnusedParameters`,
- `npm run build`,
- browser check for Chinese-first Board chrome, Loop summary labels, and overflow.

Completion criteria:

- default Board first scan no longer reads like a bilingual implementation note,
- product terms Agent, Loop, Run, IDE, Review, Done, and task remain recognizable,
- no i18n runtime state, language toggle, translation dictionary, duplicated bilingual UI, route change, runtime side effect, or `.agent-workspace/` state mutation is introduced.

## Step 70: Desktop Shell + Local opencode Bridge

Inputs:

- `docs/superworks/spec/product-interaction-map.md`
- current Vite React Workbench
- local `/opt/homebrew/bin/opencode` availability
- need to move from mock runtime toward real desktop IDE capabilities

Output:

- Electron desktop shell loads the existing Vite app in development and built `dist/` in production,
- preload bridge exposes only controlled native runtime methods for opencode probe, opencode one-shot run, and PTY session lifecycle,
- desktop main process resolves the local opencode binary, runs explicit `opencode run --format json` requests, and reports opencode version,
- desktop PTY manager can start, write, resize, stop, and preserve transcript chunks for native sessions,
- Workbench shows browser mode versus desktop shell mode, opencode path/version, PTY availability, and an explicit opencode test-run control.

Verification:

- red test for native bridge browser fallback and desktop delegation,
- red test for Workbench native runtime status and explicit opencode test run,
- red test for desktop PTY manager lifecycle,
- red test for spec/plan desktop opencode bridge documentation,
- `npm test`,
- `npx tsc --noEmit --noUnusedLocals --noUnusedParameters`,
- `npm run build`,
- verification command for local opencode bridge status,
- browser check for Workbench native runtime panel and overflow.

Completion criteria:

- Vite browser mode remains usable at `http://127.0.0.1:5188/` and clearly says it cannot start local opencode,
- desktop shell can detect local opencode and expose version/path through the Workbench,
- opencode execution is explicit and user-triggered, not hidden scheduler automation,
- PTY lifecycle is available behind the desktop bridge for future terminal streaming,
- the bridge does not create Done, approve Review, skip permission prompts, write runtime state into product-intent files, or hide Review gates.

## Step 71: Native Agent Session Controls

Inputs:

- Step 70 desktop bridge and PTY manager,
- current Workbench Native Runtime panel,
- local opencode CLI,
- selected project path and selected task context.

Output:

- native bridge functions for PTY start, get, write, resize, and stop,
- Electron preload and main IPC expose a read path for native session refresh,
- Workbench shows a Native Agent Session panel with session id, backend, status, command, exit code, input, controls, and transcript,
- App can start an opencode session for the selected task and refresh transcript output from the desktop bridge.

Verification:

- red test for native PTY start/get/write/resize/stop bridge functions,
- red test for Workbench native session controls and transcript rendering,
- red test for spec/plan native session controls documentation,
- `npm test`,
- `npx tsc --noEmit --noUnusedLocals --noUnusedParameters`,
- `npm run build`,
- native process smoke for opencode session transcript capture,
- browser check for Workbench native session panel and overflow.

Completion criteria:

- desktop mode can manage a local opencode-backed session instead of only showing one-shot run output,
- browser mode keeps local process controls disabled and explicit,
- transcript output is visible in Workbench without writing runtime state into `docs/research/`, `docs/superworks/spec/`, or `docs/superworks/plans/`,
- session controls remain explicit user actions and do not mark tasks Done, approve Review, create PR handoff, or bypass scheduler-owned Run Store.

## Step 72: Native Session Runtime Boundary

Inputs:

- Step 71 native agent session controls,
- desktop PTY manager session lifecycle,
- selected project path and selected task context,
- `.agent-workspace/` runtime communication boundary.

Output:

- desktop-managed native PTY output remains live UI state and bounded in-memory manager state,
- Shell Session Store records session state, dispatches, provider-extracted results, and events without persisting terminal transcript files,
- Workbench shows current terminal output without exposing raw transcript or metadata evidence paths as task truth,
- session communication evidence comes from provider adapters and Shell Session Store records, not terminal transcript capture.

Verification:

- red test proving PTY manager no longer writes raw transcript, clean transcript, snapshot, or metadata evidence files,
- red test proving Shell Session Store does not emit terminal output chunks as `session.output` events,
- red test for spec/plan native session runtime boundary documentation,
- `npm test`,
- `npx tsc --noEmit --noUnusedLocals --noUnusedParameters`,
- `npm run build`,
- native smoke verifying opencode still streams terminal output to the UI,
- browser check for Workbench terminal output and overflow.

Completion criteria:

- desktop opencode sessions do not write PTY transcript, snapshot, or metadata evidence artifacts,
- Workbench exposes live terminal output beside session id, backend, status, command, and exit code,
- runtime session handling does not write state into `docs/research/`, `docs/superworks/spec/`, or `docs/superworks/plans/`,
- session runtime state does not mark tasks Done, approve Review, create PR handoff, or bypass scheduler-owned Run Store.

## Step 73: Explicit opencode Model Selection And Failure Evidence

Inputs:

- Step 70 desktop bridge,
- Step 71 native session controls,
- Step 72 session runtime boundary,
- local opencode diagnostics showing the configured default model can return provider rate limits while `opencode/deepseek-v4-flash-free` returns JSON output.

Output:

- desktop opencode runner accepts an explicit model and builds `opencode run --format json --model <provider/model>`,
- Workbench one-shot runs and native sessions use the current prototype model `opencode/deepseek-v4-flash-free`,
- one-shot timeout results preserve stderr provider evidence instead of replacing it with only a generic timeout,
- Workbench shows the active opencode model beside command, status, and terminal output.

Verification:

- red test for opencode runner model args and timeout stderr preservation,
- red test for native bridge default model delegation,
- red test for Workbench opencode model visibility,
- red test for spec/plan explicit model documentation,
- `npm test`,
- `npx tsc --noEmit --noUnusedLocals --noUnusedParameters`,
- `npm run build`,
- native smoke proving explicit opencode free model returns JSON output.

Completion criteria:

- explicit opencode model selection makes the prototype's native run path produce real JSON output in the current environment,
- provider timeout and rate-limit evidence remains visible for failed native runs,
- model selection remains an explicit execution parameter and does not mark tasks Done, approve Review, create PR handoff, or bypass scheduler-owned Run Store.

## Step 74: Native Session Evidence Handoff Into Run Store And Review

Inputs:

- Step 71 native session controls,
- Step 72 session runtime boundary,
- Step 73 explicit opencode model selection,
- current `AgentRun`, Runs, and Review evidence surfaces.

Output:

- scheduler-owned `AgentRun` records native session id, backend, model, command, exit state, and provider-extracted result references when available,
- Workbench native session start, refresh, write, and stop callbacks attach Electron-returned session state to the selected task run,
- Runs shows native session state and provider result references in the run audit,
- Review shows native session state before verification, redaction, and approval gates,
- exit 0 from a native opencode session routes the task to pending Review instead of Done.

Verification:

- red test for reducer attaching native session state to AgentRun,
- red test for Runs and Review native session state visibility,
- red test for spec/plan native session state handoff documentation,
- `npm test`,
- `npx tsc --noEmit --noUnusedLocals --noUnusedParameters`,
- `npm run build`,
- native smoke confirming opencode session state is visible without PTY evidence files.

Completion criteria:

- real opencode session state is no longer trapped in Workbench local UI state,
- Runs and Review can inspect the same session state and provider result references that Electron records,
- native session completion cannot bypass verification, redaction, Review approval, or PR handoff boundaries.

## Step 75: Native Verification Command Evidence

Inputs:

- Step 70 desktop preload IPC bridge,
- Step 74 native session evidence handoff,
- existing Review verification command control,
- current `AgentRun` verification evidence and `.agent-workspace/runs/<run-id>/` artifact contract.

Output:

- desktop verification runner executes the selected run verification command through the Electron shell,
- verification stdout, stderr, exit code, command, cwd, run id, status, log path, and artifact path are persisted under `.agent-workspace/runs/<run-id>/`,
- preload/native bridge exposes verification command delegation to the React shell,
- Review button attaches native verification evidence to the active `AgentRun`,
- Runs, Review, and Audit Trail continue to read the same run-scoped verification event.

Verification:

- red test for desktop verification runner log and artifact persistence,
- red test for native bridge verification command delegation,
- red test for reducer attaching native verification evidence without moving tasks or approving Review,
- red test for spec/plan native verification documentation,
- `npm test`,
- `npx tsc --noEmit --noUnusedLocals --noUnusedParameters`,
- `npm run build`,
- real desktop smoke running a local verification command and reading the artifact.

Completion criteria:

- Review no longer relies on the in-memory mock when the desktop bridge is present,
- verification command output is durable run evidence under `.agent-workspace/runs/<run-id>/`,
- passed verification still requires Review approval before Done,
- failed verification preserves stderr and artifact paths instead of hiding the failure or retrying automatically.

## Step 76: Conversation-first opencode IDE Workbench

Inputs:

- user decision that the IDE Workbench is primarily an Agent conversation surface,
- Step 71 native opencode session controls,
- Step 74 native session evidence handoff,
- current Workbench Agent list, terminal transcript, Native Runtime, Scratchpad, and Review context.

Output:

- Workbench center column becomes the selected Agent conversation terminal,
- selecting an Agent focuses that role's task-bound conversation while the central input writes to the selected opencode terminal session,
- Agent roles remain Planner, Executor, QA, and Reviewer, but provider/model copy presents opencode and `opencode/deepseek-v4-flash-free` instead of mock Codex, Claude Code, or Gemini CLI agents,
- Agent configuration, command, cwd, runtime policy, transcript paths, parser evidence, Scratchpad, and Review handoff move into the inspector instead of competing with the conversation transcript,
- responsive layout shows the conversation terminal before secondary Agent/config panels on narrower desktop widths.

Verification:

- red test for selected Agent conversation terminal becoming the Workbench primary surface,
- red test proving Agent provider/model copy no longer presents Codex, Claude Code, or Gemini CLI as mock agents,
- red test for central terminal input delegating to native PTY write when a session is running,
- red test for spec/plan conversation-first opencode documentation,
- `npm test`,
- `npx tsc --noEmit --noUnusedLocals --noUnusedParameters`,
- `npm run build`,
- browser screenshot check on the IDE Workbench showing the conversation terminal as the first visible work area.

Completion criteria:

- IDE Workbench first scan answers which Agent role is selected, which task it is handling, which opencode command/model/cwd backs it, and where the user types next,
- terminal/PTY remains the implementation substrate while conversation remains the product surface,
- no Workbench Agent row or runtime policy presents Codex, Claude Code, or Gemini CLI as the active mocked execution agent,
- secondary parser, scratchpad, runtime, and review evidence remain inspectable without taking over the main page.

## Step 77: Project-scoped Agent Cluster Namespacing

Inputs:

- user decision to proceed with option C: Project + AgentCluster, where clusters may bind to tasks,
- user requirement that project path is the first Agent group isolation boundary,
- current Project, Agent, Task, AgentRun, Workbench, Restore, and native PTY session state,
- Step 76 conversation-first opencode Workbench.

Output:

- `AgentCluster` becomes an explicit product object with project id, cluster name, level, agent ids, optional task id, parent cluster id, and evidence path,
- each project has a default `FirstTask` cluster,
- second-level task clusters can be created by task name and own their own same-named Planner, Executor, QA, and Reviewer Agents,
- Project, Task, and Agent selection update `selectedAgentClusterId` before selecting the visible Agent,
- Workbench shows project clusters, filters Agent rows by the selected cluster, and disables terminal send when no native session is active for the selected project/cluster/agent conversation,
- native session ids and in-memory session/input maps are scoped by project id, cluster id, agent id, and task id,
- Restore process metadata paths include project and cluster ids so same-named Agents from different projects do not collide.

Verification:

- red test for selecting a project and getting that project's `FirstTask` cluster instead of global same-named Agents,
- red test for selecting a task and switching to its second-level task Agent cluster,
- red test for Workbench rendering only the selected project's selected cluster Agents,
- red test for Workbench disabling terminal send without an active native session instead of falling back to mock prompt send,
- red test for spec/plan Project-scoped Agent Cluster documentation,
- `npm test`,
- `npx tsc --noEmit --noUnusedLocals --noUnusedParameters`,
- `npm run build`,
- browser check on IDE Workbench showing Agent Cluster before Agent rows and no cross-project Agent bleed.

Completion criteria:

- two projects may have same display-name Agents without sharing Agent ids, terminal sessions, restore records, or visible Workbench rows,
- `FirstTask` is the default cluster name for the first project-level Agent group,
- task-specific Agent groups are represented as second-level task clusters with user-defined task names,
- terminal sessions and inputs are keyed by project, cluster, and Agent rather than one global Workbench session.

## Step 78: Terminal-first Workbench State Chrome

Inputs:

- user feedback that Workbench page proportions are wrong,
- user feedback that task context must be collapsible,
- user feedback that Bound tasks is unclear and runtime/config/MCP/skill information should not dominate the default Agent conversation,
- Step 76 conversation-first opencode Workbench,
- Step 77 project-scoped Agent clusters.

Output:

- Workbench desktop layout becomes three zones: Agent/Cluster rail, wide terminal conversation, and a right-side runtime detail rail collapsed by default,
- task context is renamed from Bound tasks to `任务上下文` and can collapse to the current task or expand to the project task list,
- runtime/config/debug information moves behind an explicit right-side `运行详情` rail instead of a persistent expanded inspector or a terminal-bottom drawer,
- Agent, cluster, and task cards expose state with color classes: running pulses, waiting or permission-sensitive states use amber attention styling, and done tasks use green completion styling,
- permission-sensitive status appears in the main terminal strip and the details disclosure so the user can notice it without reading the full runtime policy card.

Verification:

- red test for runtime details hidden by default and visible after opening `运行详情`,
- red test for task context collapsed by default and expandable,
- red test for selected project/cluster Agent rows still scoped after the layout change,
- `npm test -- src/pages/Workbench.test.tsx`,
- `npx tsc --noEmit --noUnusedLocals --noUnusedParameters`,
- `npm test`,
- `npm run build`,
- browser check on IDE Workbench showing left Agent rail, center terminal, right collapsed detail rail, collapsed task context, state color classes, expandable details, and no horizontal overflow.

Completion criteria:

- first scan of IDE Workbench is the selected Agent terminal conversation,
- the user can expand task context only when switching tasks,
- advanced runtime, MCP/parser, skill/scratchpad, and Review evidence remain available in the right detail rail but do not occupy the default page,
- state is legible from card color and motion before reading dense metadata.

## Step 79: Real opencode Agent Command Binding

Inputs:

- user requirement that Workbench no longer mock Agents,
- user requirement that each Agent starts from its own configured command,
- current desktop shell, native opencode bridge, node-pty PTY manager, and conversation-first Workbench,
- local `opencode agent list` output from the user's machine.

Output:

- each product Agent owns an editable launch command, defaulting to `opencode --model opencode/deepseek-v4-flash-free`,
- Workbench reads local opencode agents through the Electron preload bridge and can bind a selected local agent name into the selected product Agent command,
- the Start PTY action parses the selected Agent command into command plus args and starts it directly through the native PTY manager,
- Workbench renders PTY output through xterm so opencode ANSI/TUI output becomes the visible Agent page instead of raw transcript text,
- xterm keyboard input writes raw data directly to the selected native PTY session while the existing composer remains a fallback send path,
- running native sessions are refreshed automatically so the terminal updates after `opencode` starts,
- interactive Agent terminal sessions require real `node-pty`; process fallback is limited to non-interactive smoke checks or verification commands,
- node-pty startup verifies the packaged `spawn-helper` is executable before the shell reports PTY readiness,
- start failures preserve attempted command and stderr/transcript evidence in the terminal surface.

Verification:

- red test for editable per-Agent launch command,
- red test for desktop bridge listing local opencode agents,
- red test for binding a local opencode agent into the selected Agent command,
- red test for xterm-backed terminal host and raw PTY write path,
- red test for node-pty spawn-helper executable-bit repair,
- red test that interactive Agent PTY does not fall back to child process when node-pty is unavailable,
- `npm test -- --run src/lib/agentLaunchCommand.test.ts src/pages/Workbench.test.tsx src/runtime/nativeBridge.test.ts src/lib/productIntentDocs.test.ts`,
- `npx vitest run desktop/node-pty-runtime.test.mjs desktop/opencode-runner.test.mjs desktop/pty-manager.test.mjs`,
- `npm run build`,
- `opencode agent list`,
- real node-pty spawn smoke proving interactive terminal readiness.

Completion criteria:

- Product Agent roles are no longer presented as fake runtime agents,
- local opencode agents are discovered from the actual desktop runtime,
- each Agent can be launched with an explicit user-editable command,
- the conversation terminal only claims readiness when a real PTY backend can spawn.

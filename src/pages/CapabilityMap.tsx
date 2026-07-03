import { ArrowRight, Layers3, ServerCog } from "lucide-react";
import { useMemo, useState } from "react";
import { RecordItem, StatusPill } from "../components/common";
import type { ProductCapability, RuntimeContract, View } from "../types";
import type { RuntimeAdapterCard } from "../runtime/contracts";

const primaryBackbone = [
  {
    title: "1. Board",
    detail: "select task and inspect loop/run status",
    owner: "Task Store",
    evidence: ".agent-workspace/tasks/events.jsonl",
  },
  {
    title: "2. Loop",
    detail: "record scheduler decision",
    owner: "Loop Scheduler",
    evidence: ".agent-workspace/loops/events.jsonl",
  },
  {
    title: "3. Run Store",
    detail: "create AgentRun and run artifact paths",
    owner: "Run Store",
    evidence: ".agent-workspace/runs/<run-id>/",
  },
  {
    title: "4. PTY + Git",
    detail: "spawn CLI session and capture baseline",
    owner: "PTY Service / Git Service",
    evidence: "policy.json, worktree.json, transcript.log",
  },
  {
    title: "5. IDE Workbench",
    detail: "terminal, policy, provider state, diagnostics, scratchpad, diff context",
    owner: "Workspace Shell",
    evidence: "session state, terminal diagnostics, and scratchpad draft",
  },
  {
    title: "6. Review Gate",
    detail: "verification, staging, redaction, approval",
    owner: "Git Review Service",
    evidence: ".agent-workspace/reviews/<run-id>/",
  },
  {
    title: "7. Runs Audit",
    detail: "run-scoped transcript, policy, evidence, PR handoff",
    owner: "Run Store",
    evidence: ".agent-workspace/pr/<run-id>/handoff.json",
  },
];

const pageOwnershipRows = [
  {
    label: "Board / Task Intake",
    owns: "Task state and context capture",
    surfaces: "Task Board",
    guardrail: "must not fabricate AgentRun or bypass Review",
  },
  {
    label: "Loop Console",
    owns: "Scheduler decision and run start boundary",
    surfaces: "Loop Console",
    guardrail: "must not judge implementation quality",
  },
  {
    label: "IDE Workbench",
    owns: "PTY run surface, prompt composer, provider state, diagnostics",
    surfaces: "Workbench",
    guardrail: "must not approve Done",
  },
  {
    label: "Review / Runs / Audit Trail",
    owns: "Verification, approval, completion evidence",
    surfaces: "Review, Runs, Audit Trail",
    guardrail: "must not create PR handoff automatically",
  },
  {
    label: "Context surfaces",
    owns: "Projects, Watcher, Libraries",
    surfaces: "Projects, Plan Watcher, Libraries",
    guardrail: "must not execute agents directly",
  },
  {
    label: "Advanced automation",
    owns: "MCP, Browser, Teams, Notifications, Restore",
    surfaces: "MCP Gateway, Browser, Teams, Notifications, Restore",
    guardrail: "must stay behind explicit gates",
  },
];

const interactionRouteRows = [
  {
    route: "Board task -> Workbench",
    effect: "focus task and agent, open IDE drill-down",
    evidence: "selected task id and agent context",
    guardrail: "no AgentRun unless Start Agent is used",
  },
  {
    route: "Board / Loop -> Start Agent",
    effect: "create schedule event, AgentRun, PTY, git baseline",
    evidence: ".agent-workspace/loops/events.jsonl",
    guardrail: "must open through runtime adapters",
  },
  {
    route: "Provider result -> Review",
    effect: "record provider completion claim and review evidence",
    evidence: "session store result and review gate context",
    guardrail: "terminal diagnostics must not mark Done",
  },
  {
    route: "Review approval -> Runs",
    effect: "approve verified task and show run audit",
    evidence: ".agent-workspace/reviews/<run-id>/approval.json",
    guardrail: "must not create PR handoff automatically",
  },
  {
    route: "Notification / Audit -> Source",
    effect: "select referenced task and route to source surface",
    evidence: "notification or audit source evidence path",
    guardrail: "must not acknowledge, mutate, or schedule",
  },
  {
    route: "Projects / Libraries -> Workbench",
    effect: "carry project, agent, prompt, or skill context",
    evidence: "project manifest or library binding event",
    guardrail: "must not execute agents directly",
  },
];

const actionSideEffectRows = [
  {
    action: "Capture task draft",
    effect: "append TaskIntakeEvent and start Conductor task",
    evidence: ".agent-workspace/tasks/intake.jsonl",
    guardrail: "no fabricated AgentRun, Review, or Done",
  },
  {
    action: "Select task / agent / project",
    effect: "focus shell context only",
    evidence: "selected task, agent, and project ids",
    guardrail: "no scheduler decision",
  },
  {
    action: "Start Agent",
    effect: "schedule event, AgentRun, PTY, git baseline",
    evidence: ".agent-workspace/loops/events.jsonl",
    guardrail: "must enter Workbench and Review lifecycle",
  },
  {
    action: "Inspect terminal diagnostics",
    effect: "focus run evidence without changing task state",
    evidence: "bounded terminal diagnostics",
    guardrail: "must never drive Agent card or task state",
  },
  {
    action: "Run verification / stage / redaction",
    effect: "review evidence under the active run",
    evidence: ".agent-workspace/runs/<run-id>/verification.json",
    guardrail: "does not approve Review",
  },
  {
    action: "Approve Review",
    effect: "ReviewApprovalEvent, Done task, done notification",
    evidence: ".agent-workspace/reviews/<run-id>/approval.json",
    guardrail: "no automatic PR handoff",
  },
  {
    action: "Prepare PR handoff",
    effect: "PullRequestHandoffEvent draft",
    evidence: ".agent-workspace/pr/<run-id>/handoff.json",
    guardrail: "does not open hosted PR",
  },
];

const durableEvidenceRows = [
  {
    ledger: "Task Store ledger",
    records: "intake, transitions, artifacts",
    store: ".agent-workspace/tasks/",
    readers: "Board, Review, Audit Trail",
    guardrail: "product-intent files stay immutable",
  },
  {
    ledger: "Loop Schedule ledger",
    records: "scheduler decisions and run start requests",
    store: ".agent-workspace/loops/events.jsonl",
    readers: "Loop Console, Workbench, Audit Trail",
    guardrail: "scheduler evidence is not agent reasoning",
  },
  {
    ledger: "Run ledger",
    records: "AgentRun, policy, worktree, transcript, provider-state events",
    store: ".agent-workspace/runs/<run-id>/",
    readers: "Workbench, Review, Runs, Audit Trail",
    guardrail: "run record is not Review approval",
  },
  {
    ledger: "Review ledger",
    records: "verification, staging, redaction, gate, approval",
    store: ".agent-workspace/reviews/<run-id>/",
    readers: "Review, Runs, Audit Trail",
    guardrail: "done requires approval evidence",
  },
  {
    ledger: "Context ledger",
    records: "project manifests, agent profiles, prompt and skill bindings",
    store: ".agent-workspace/projects/ and .agent-workspace/libraries/",
    readers: "Projects, Libraries, Workbench",
    guardrail: "context records do not execute agents",
  },
  {
    ledger: "Advanced evidence ledger",
    records: "browser, MCP, notifications, restore, teams",
    store: ".agent-workspace/browser|mcp|notifications|restore|teams/",
    readers: "Advanced pages, Review, Audit Trail",
    guardrail: "advanced records stay explicit gated evidence",
  },
];

const nativeReadinessRows = [
  {
    service: "Run Store native persistence",
    replaces: "replace in-memory AgentRun records",
    target: "persist run artifacts under .agent-workspace/runs/<run-id>/",
    guardrail: "does not interpret task output",
  },
  {
    service: "PTY process manager",
    replaces: "native PTY spawn/write/resize/stop",
    target: "desktop PTY sessions with restore metadata",
    guardrail: "terminal output remains agent-owned",
  },
  {
    service: "Git service",
    replaces: "native baseline, attribution, staging, proposal",
    target: "local git status/diff/worktree/staging APIs",
    guardrail: "proposal-first, Review still gates Done",
  },
  {
    service: "Filesystem watcher",
    replaces: "native docs product-intent change events",
    target: "native watcher on durable product-intent roots",
    guardrail: "never writes runtime state into product intent",
  },
  {
    service: "Browser and MCP adapters",
    replaces: "native browser/MCP evidence records",
    target: "project Chromium profile and permission prompts",
    guardrail: "advanced tools stay explicit and gated",
  },
  {
    service: "Project and Library stores",
    replaces: "manifest-backed project, prompt, skill context",
    target: "manifest-backed context and start-time injection",
    guardrail: "context injection does not execute agents",
  },
];

const commandSurfaceRows = [
  {
    command: "Open task command",
    route: "Board / Workbench / Review",
    effect: "select task, project, or agent context",
    guardrail: "focus-only, no AgentRun",
  },
  {
    command: "Start Agent command",
    route: "Loop Console / Workbench",
    effect: "enter scheduler-start boundary",
    guardrail: "requires selected task and runtime policy",
  },
  {
    command: "Inspect terminal diagnostics command",
    route: "Workbench / Notifications / Review",
    effect: "inspect diagnostics without task-state mutation",
    guardrail: "never drives Agent cards or task state",
  },
  {
    command: "Review gate command",
    route: "Review / Runs",
    effect: "run verification, staging, redaction, approval",
    guardrail: "approval requires evidence",
  },
  {
    command: "Prepare PR handoff command",
    route: "Runs",
    effect: "create PR handoff draft artifact",
    guardrail: "does not open hosted PR",
  },
  {
    command: "Advanced tool command",
    route: "MCP / Browser / Teams",
    effect: "request gated automation surface",
    guardrail: "confirmation/evidence required",
  },
];

const failureRecoveryRows = [
  {
    failure: "Runtime start failed",
    surface: "Loop / Workbench",
    recovery: "record launch failure and keep task out of Done",
    evidence: ".agent-workspace/runs/<run-id>/runtime-events.jsonl",
    guardrail: "no silent retry",
  },
  {
    failure: "Verification failed",
    surface: "Review / Notifications",
    recovery: "route task to failed-verification",
    evidence: ".agent-workspace/runs/<run-id>/verification.json",
    guardrail: "Review still owns retry",
  },
  {
    failure: "MCP denied",
    surface: "MCP Gateway / Audit Trail",
    recovery: "record denied decision evidence",
    evidence: ".agent-workspace/mcp/<event-id>/confirmation.json",
    guardrail: "tool does not execute",
  },
  {
    failure: "PTY or dev command failed",
    surface: "Workbench / Dev Terminals",
    recovery: "preserve transcript or command log",
    evidence: ".agent-workspace/runs/<run-id>/transcript.log",
    guardrail: "restart is explicit",
  },
  {
    failure: "Team max cycle blocked",
    surface: "Teams",
    recovery: "block handoff until user review",
    evidence: ".agent-workspace/teams/<team-run-id>/handoff.json",
    guardrail: "no normal AgentRun side effect",
  },
  {
    failure: "Restore mismatch",
    surface: "Restore",
    recovery: "show rollback intent and evidence pointers",
    evidence: ".agent-workspace/restore/<manifest-id>.json",
    guardrail: "does not replay agents",
  },
];

const stateLifecycleRows = [
  {
    stage: "Task queued",
    taskState: "todo / queued",
    runState: "no run yet",
    evidence: "intake and task-store evidence only",
    guardrail: "Start Agent required",
  },
  {
    stage: "Run active",
    taskState: "running / waiting-input",
    runState: "running",
    evidence: "terminal transcript and provider-state evidence",
    guardrail: "agent output is not Review",
  },
  {
    stage: "Review pending",
    taskState: "pending-review",
    runState: "pending-review run claim",
    evidence: "Review gate evidence required",
    guardrail: "must not mark Done",
  },
  {
    stage: "Verification failed state",
    taskState: "failed-verification / blocked",
    runState: "failed-verification",
    evidence: "desktop notification and failed verification log",
    guardrail: "retry stays explicit",
  },
  {
    stage: "Review approved done",
    taskState: "done",
    runState: "completed",
    evidence: "ReviewApprovalEvent and done notification",
    guardrail: "PR handoff still explicit",
  },
];

const surfaceCompositionRows = [
  {
    surface: "Task Board",
    workspace: "Kanban lanes and selected task detail",
    context: "Loop health, task intake, and task artifacts",
    evidence: ".agent-workspace/tasks/",
    action: "Start Agent through Loop boundary",
  },
  {
    surface: "Loop Console",
    workspace: "scheduler rules and run queue",
    context: "active task, run policy, and failure recovery",
    evidence: ".agent-workspace/loops/events.jsonl",
    action: "Create schedule event",
  },
  {
    surface: "IDE Workbench",
    workspace: "PTY terminal and prompt composer",
    context: "project, agent, task, and scratchpad context",
    evidence: "policy, transcript, provider state, diagnostics, and scratchpad artifacts",
    action: "Write prompt to PTY",
  },
  {
    surface: "Review",
    workspace: "changed files and commit scope",
    context: "verification, staging, redaction, and approval gates",
    evidence: ".agent-workspace/reviews/<run-id>/",
    action: "Approve only after gates pass",
  },
  {
    surface: "Runs / Audit Trail",
    workspace: "run timeline and workspace evidence chain",
    context: "policy, worktree, approval, and PR handoff context",
    evidence: "transcript, diff, verification, approval, and handoff artifacts",
    action: "Prepare PR handoff after approval",
  },
  {
    surface: "Advanced surfaces",
    workspace: "MCP, Browser, Teams, Restore, Notifications, Libraries",
    context: "permission, task binding, project profile, and route rules",
    evidence: ".agent-workspace/mcp|browser|teams|restore|notifications|libraries/",
    action: "Request gated automation or inject context",
  },
];

const dataModelRows = [
  {
    object: "Project context",
    fields: "project id, path, zone, browser profile, agent ids, task ids",
    surfaces: "Projects / Workbench",
    store: ".agent-workspace/projects/<project-id>.json",
    guardrail: "project selection is focus only",
  },
  {
    object: "Agent profile",
    fields: "role, provider, model, status, task binding, system prompt path",
    surfaces: "Projects / Workbench / Libraries",
    store: ".agent-workspace/projects/<project-id>.json",
    guardrail: "agent profile does not start execution",
  },
  {
    object: "Task record",
    fields: "title, status, owner, risk, verification, labels, artifact count",
    surfaces: "Task Board / Review / Audit Trail",
    store: ".agent-workspace/tasks/",
    guardrail: "task done still requires Review approval",
  },
  {
    object: "AgentRun record",
    fields: "run id, task id, agent id, status, policy, worktree, transcript paths",
    surfaces: "Workbench / Runs / Audit Trail",
    store: ".agent-workspace/runs/<run-id>/",
    guardrail: "run completed is not task done",
  },
  {
    object: "Review package",
    fields: "changed files, scoped selection, verification, staging, redaction, approval",
    surfaces: "Review / Runs",
    store: ".agent-workspace/reviews/<run-id>/",
    guardrail: "approval is separate from commit handoff",
  },
  {
    object: "Task artifact",
    fields: "screenshot, prompt template, sketch, html, browser evidence",
    surfaces: "Task Board / Workbench / Browser",
    store: ".agent-workspace/tasks/<task-id>/artifacts/",
    guardrail: "artifact attachment does not move status",
  },
  {
    object: "Notification signal",
    fields: "level, destination, acknowledgement, source event, source evidence",
    surfaces: "Notifications / Audit Trail",
    store: ".agent-workspace/notifications/events.jsonl",
    guardrail: "notification routing is not scheduling",
  },
];

const permissionConfirmationRows = [
  {
    level: "Read-only inspection",
    trigger: "Capability Map / Audit Trail open",
    owner: "none",
    evidence: "no runtime event",
    guardrail: "no confirmation and no mutation",
  },
  {
    level: "Focus routing",
    trigger: "select task, project, agent, notification context",
    owner: "Workspace Shell",
    evidence: "selected ids only",
    guardrail: "confirmation not required because no durable transition",
  },
  {
    level: "Runtime launch",
    trigger: "Start Agent / Loop schedule",
    owner: "Scheduler",
    evidence: ".agent-workspace/loops/events.jsonl",
    guardrail: "requires selected task and visible runtime policy",
  },
  {
    level: "PTY write",
    trigger: "Send prompt / apply terminal input",
    owner: "User in Workbench",
    evidence: ".agent-workspace/runs/<run-id>/transcript.log",
    guardrail: "writes only to active PTY session",
  },
  {
    level: "Review gate",
    trigger: "run verification, stage files, redaction scan, approve Review",
    owner: "Reviewer",
    evidence: ".agent-workspace/reviews/<run-id>/",
    guardrail: "approval requires gate evidence",
  },
  {
    level: "PR handoff",
    trigger: "prepare PR handoff",
    owner: "User in Runs",
    evidence: ".agent-workspace/pr/<run-id>/handoff.json",
    guardrail: "does not open hosted PR",
  },
  {
    level: "Confirm-class MCP",
    trigger: "write/delete/upload/browser-control tool request",
    owner: "Scheduler confirmation",
    evidence: ".agent-workspace/mcp/<event-id>/confirmation.json",
    guardrail: "denied tool does not execute",
  },
  {
    level: "Advanced explicit action",
    trigger: "capture browser evidence, start dev command, restore session",
    owner: "Advanced surface user action",
    evidence: ".agent-workspace/browser|commands|restore/",
    guardrail: "advanced side effects stay explicit",
  },
  {
    level: "Notification acknowledgement",
    trigger: "acknowledge notification",
    owner: "User in Notifications",
    evidence: ".agent-workspace/notifications/events.jsonl",
    guardrail: "ack does not schedule or approve",
  },
];

const contextPropagationRows = [
  {
    context: "Project focus",
    source: "Projects selection",
    carries: "project id, path, zone, browser profile",
    destinations: "Workbench, Board, Dev Terminals, Browser",
    guardrail: "project focus never starts agents",
  },
  {
    context: "Task focus",
    source: "Board card / Workbench task link",
    carries: "task id, owner agent, status, artifact count",
    destinations: "Board, Workbench, Review, Runs",
    guardrail: "task focus never moves status",
  },
  {
    context: "Agent focus",
    source: "Workbench agent selection",
    carries: "agent id, role, provider, model, active task",
    destinations: "Projects, Workbench, Review filter",
    guardrail: "agent focus never spawns PTY",
  },
  {
    context: "Run focus",
    source: "Loop start / Workbench active run",
    carries: "run id, policy, worktree, transcript, provider state",
    destinations: "Workbench, Review, Runs, Audit Trail",
    guardrail: "run focus is not task completion",
  },
  {
    context: "Review focus",
    source: "Review gate / Runs audit selection",
    carries: "selected files, verification, staging, redaction, approval",
    destinations: "Review, Runs, Audit Trail",
    guardrail: "review focus never opens PR",
  },
  {
    context: "Library and artifact context",
    source: "Prompt Library / Scratchpad attachment",
    carries: "prompt id, skill id, artifact path, task binding",
    destinations: "Libraries, Workbench, Task Board",
    guardrail: "context injection never executes agents",
  },
  {
    context: "Notification and audit context",
    source: "Notification open / Audit drill-back",
    carries: "source event, task id, route target, evidence path",
    destinations: "Notifications, Audit Trail, source surface",
    guardrail: "drill-back never acknowledges or schedules",
  },
];

const productWorkflowRows = [
  {
    step: "1. Intake captured",
    narrative: "Task Intake records context and starts Conductor",
    surface: "Task Board",
    evidence: ".agent-workspace/tasks/intake.jsonl",
    guardrail: "no fabricated run or review approval",
  },
  {
    step: "2. Task selected",
    narrative: "Board card becomes the shell focus and exposes loop/run state",
    surface: "Task Board",
    evidence: "selected task id",
    guardrail: "focus does not schedule",
  },
  {
    step: "3. Loop scheduled",
    narrative: "Start Agent creates scheduler evidence and run policy",
    surface: "Loop Console",
    evidence: ".agent-workspace/loops/events.jsonl",
    guardrail: "scheduler does not reason",
  },
  {
    step: "4. IDE run active",
    narrative: "Workbench owns PTY, prompt composer, provider state, diagnostics, and scratchpad",
    surface: "IDE Workbench",
    evidence: ".agent-workspace/runs/<run-id>/transcript.log",
    guardrail: "terminal output is not approval",
  },
  {
    step: "5. Review gate",
    narrative: "Review checks diff scope, verification, staging and redaction",
    surface: "Review",
    evidence: ".agent-workspace/reviews/<run-id>/",
    guardrail: "Done requires approval evidence",
  },
  {
    step: "6. Runs audit",
    narrative: "Runs preserves policy, transcript, worktree and approval context",
    surface: "Runs / Audit Trail",
    evidence: ".agent-workspace/runs/<run-id>/",
    guardrail: "audit drill-back is read-only",
  },
  {
    step: "7. PR handoff optional",
    narrative: "User prepares PR handoff only after approval",
    surface: "Runs",
    evidence: ".agent-workspace/pr/<run-id>/handoff.json",
    guardrail: "does not open hosted PR",
  },
];

const surfaceControlRows = [
  {
    surface: "Task Board controls",
    controls: "Capture task draft, select card, Start Agent, Advance status",
    availability: "auto-start intake form and selected task detail",
    evidence: ".agent-workspace/tasks/intake.jsonl and events.jsonl",
    guardrail: "board controls never write PTY directly",
  },
  {
    surface: "Loop Console controls",
    controls: "Start Agent, Advance task, inspect rules",
    availability: "selected task and visible runtime policy",
    evidence: ".agent-workspace/loops/events.jsonl",
    guardrail: "scheduler controls do not review code",
  },
  {
    surface: "IDE Workbench controls",
    controls: "Select agent/task, send prompt, inspect diagnostics, save scratchpad",
    availability: "active run and composer draft",
    evidence: "session state, terminal diagnostics, scratchpad artifacts",
    guardrail: "Workbench controls do not approve Done",
  },
  {
    surface: "Review controls",
    controls: "toggle files, stage files, run verification, redaction scan, approve review",
    availability: "active run and selected file scope",
    evidence: ".agent-workspace/reviews/<run-id>/ and runs/<run-id>/verification.json",
    guardrail: "approval blocked until evidence passes",
  },
  {
    surface: "Runs and Audit controls",
    controls: "select run, inspect evidence, prepare PR handoff, open source context",
    availability: "approved run or audit entry",
    evidence: ".agent-workspace/runs/<run-id>/ and pr/<run-id>/handoff.json",
    guardrail: "audit inspection stays read-only",
  },
  {
    surface: "Projects and Libraries controls",
    controls: "select project, add agent, inject prompt, attach skill",
    availability: "selected project/task/agent context",
    evidence: ".agent-workspace/projects/ and libraries/",
    guardrail: "context controls do not start execution",
  },
  {
    surface: "Advanced surface controls",
    controls: "request MCP, resolve confirmation, capture browser evidence, start dev command, restore session",
    availability: "explicit advanced page action",
    evidence: ".agent-workspace/mcp|browser|commands|restore/",
    guardrail: "advanced controls stay gated and task-scoped",
  },
];

export function CapabilityMap({
  capabilities,
  contracts,
  adapters,
  onOpenView,
}: {
  capabilities: ProductCapability[];
  contracts: RuntimeContract[];
  adapters: RuntimeAdapterCard[];
  onOpenView: (view: View) => void;
}) {
  const [selectedCapabilityId, setSelectedCapabilityId] = useState("backlog");
  const mvpCore = capabilities.filter((capability) => capability.phase === "mvp-core");
  const extension = capabilities.filter((capability) => capability.phase === "mvp-extension");
  const advanced = capabilities.filter((capability) => capability.phase === "advanced");
  const deferred = capabilities.filter((capability) => capability.phase === "deferred");
  const contractIds = new Set(contracts.map((contract) => contract.id));
  const mappedBoundaryCount = capabilities.filter((capability) => contractIds.has(capability.contractId)).length;
  const evidenceCount = capabilities.filter((capability) => capability.evidence.trim()).length;
  const nextStepCount = capabilities.filter((capability) => capability.nextStep.trim()).length;
  const selectedCapability = useMemo(
    () => capabilities.find((capability) => capability.id === selectedCapabilityId) ?? capabilities[0],
    [capabilities, selectedCapabilityId],
  );
  const selectedContract = contracts.find((contract) => contract.id === selectedCapability?.contractId);

  return (
    <section className="capability-layout">
      <div className="panel capability-main">
        <div className="section-title">
          <Layers3 size={18} />
          <span>Product capability map</span>
        </div>
        <div className="capability-summary">
          <RecordItem label="Default entry" value="Board-first task workbench" />
          <RecordItem label="Execution surface" value="IDE drill-down per task/run" />
          <RecordItem label="Automation visibility" value="Loop console and run audit trail" />
          <RecordItem label="Done policy" value="Review + verification + commit context" />
        </div>
        <div className="coverage-matrix">
          <div className="section-title compact">
            <Layers3 size={16} />
            <span>Capability coverage matrix</span>
          </div>
          <div className="coverage-grid">
            <CoverageCell label={`${capabilities.length} capabilities`} value={`${capabilities.length} total`} />
            <CoverageCell label={`${mvpCore.length} MVP core`} value="Board / Loop / IDE / Review / Runs" />
            <CoverageCell label={`${extension.length} MVP extension`} value="Dev Terminals / Libraries" />
            <CoverageCell label={`${advanced.length} advanced`} value="Teams / Browser / MCP / Notifications / Restore" />
            <CoverageCell label={`${deferred.length} deferred`} value="Mobile Sync boundary only" />
            <CoverageCell label="Runtime boundaries" value={`${mappedBoundaryCount} / ${capabilities.length} mapped`} />
            <CoverageCell label="Evidence fields" value={`${evidenceCount} / ${capabilities.length} defined`} />
            <CoverageCell label="Next native steps" value={`${nextStepCount} / ${capabilities.length} defined`} />
          </div>
        </div>
        <div className="backbone-panel">
          <div className="section-title compact">
            <Layers3 size={16} />
            <span>Primary interaction backbone</span>
          </div>
          <div className="backbone-grid">
            {primaryBackbone.map((step) => (
              <div className="backbone-step" key={step.title}>
                <strong>{step.title}</strong>
                <p>{step.detail}</p>
                <div className="task-run-grid">
                  <span>Owner</span>
                  <strong>{step.owner}</strong>
                  <span>Evidence</span>
                  <strong>{step.evidence}</strong>
                </div>
              </div>
            ))}
          </div>
        </div>
        <div className="ownership-panel">
          <div className="section-title compact">
            <Layers3 size={16} />
            <span>Page ownership matrix</span>
          </div>
          <div className="ownership-grid">
            {pageOwnershipRows.map((row) => (
              <div className="ownership-card" key={row.label}>
                <strong>{row.label}</strong>
                <p>{row.owns}</p>
                <div className="task-run-grid">
                  <span>Surfaces</span>
                  <strong>{row.surfaces}</strong>
                  <span>Guardrail</span>
                  <strong>{row.guardrail}</strong>
                </div>
              </div>
            ))}
          </div>
        </div>
        <div className="route-panel">
          <div className="section-title compact">
            <Layers3 size={16} />
            <span>Interaction route matrix</span>
          </div>
          <div className="route-grid">
            {interactionRouteRows.map((row) => (
              <div className="route-card" key={row.route}>
                <strong>{row.route}</strong>
                <p>{row.effect}</p>
                <div className="task-run-grid">
                  <span>Evidence</span>
                  <strong>{row.evidence}</strong>
                  <span>Guardrail</span>
                  <strong>{row.guardrail}</strong>
                </div>
              </div>
            ))}
          </div>
        </div>
        <div className="action-panel">
          <div className="section-title compact">
            <Layers3 size={16} />
            <span>Action side-effect matrix</span>
          </div>
          <div className="action-grid">
            {actionSideEffectRows.map((row) => (
              <div className="action-card" key={row.action}>
                <strong>{row.action}</strong>
                <p>{row.effect}</p>
                <div className="task-run-grid">
                  <span>Evidence</span>
                  <strong>{row.evidence}</strong>
                  <span>Guardrail</span>
                  <strong>{row.guardrail}</strong>
                </div>
              </div>
            ))}
          </div>
        </div>
        <div className="ledger-panel">
          <div className="section-title compact">
            <Layers3 size={16} />
            <span>Durable evidence ledger</span>
          </div>
          <div className="ledger-grid">
            {durableEvidenceRows.map((row) => (
              <div className="ledger-card" key={row.ledger}>
                <strong>{row.ledger}</strong>
                <p>{row.records}</p>
                <div className="task-run-grid">
                  <span>Store</span>
                  <strong>{row.store}</strong>
                  <span>Readers</span>
                  <strong>{row.readers}</strong>
                  <span>Guardrail</span>
                  <strong>{row.guardrail}</strong>
                </div>
              </div>
            ))}
          </div>
        </div>
        <div className="readiness-panel">
          <div className="section-title compact">
            <Layers3 size={16} />
            <span>Native runtime readiness</span>
          </div>
          <div className="readiness-grid">
            {nativeReadinessRows.map((row) => (
              <div className="readiness-card" key={row.service}>
                <strong>{row.service}</strong>
                <p>{row.replaces}</p>
                <div className="task-run-grid">
                  <span>Native target</span>
                  <strong>{row.target}</strong>
                  <span>Guardrail</span>
                  <strong>{row.guardrail}</strong>
                </div>
              </div>
            ))}
          </div>
        </div>
        <div className="command-panel">
          <div className="section-title compact">
            <Layers3 size={16} />
            <span>Command surface matrix</span>
          </div>
          <div className="command-grid">
            {commandSurfaceRows.map((row) => (
              <div className="command-card" key={row.command}>
                <strong>{row.command}</strong>
                <p>{row.effect}</p>
                <div className="task-run-grid">
                  <span>Route</span>
                  <strong>{row.route}</strong>
                  <span>Guardrail</span>
                  <strong>{row.guardrail}</strong>
                </div>
              </div>
            ))}
          </div>
        </div>
        <div className="failure-panel">
          <div className="section-title compact">
            <Layers3 size={16} />
            <span>Failure recovery matrix</span>
          </div>
          <div className="failure-grid">
            {failureRecoveryRows.map((row) => (
              <div className="failure-card" key={row.failure}>
                <strong>{row.failure}</strong>
                <p>{row.recovery}</p>
                <div className="task-run-grid">
                  <span>Surface</span>
                  <strong>{row.surface}</strong>
                  <span>Evidence</span>
                  <strong>{row.evidence}</strong>
                  <span>Guardrail</span>
                  <strong>{row.guardrail}</strong>
                </div>
              </div>
            ))}
          </div>
        </div>
        <div className="state-panel">
          <div className="section-title compact">
            <Layers3 size={16} />
            <span>State lifecycle matrix</span>
          </div>
          <div className="state-grid">
            {stateLifecycleRows.map((row) => (
              <div className="state-card" key={row.stage}>
                <strong>{row.stage}</strong>
                <p>{row.evidence}</p>
                <div className="task-run-grid">
                  <span>Task state</span>
                  <strong>{row.taskState}</strong>
                  <span>Run state</span>
                  <strong>{row.runState}</strong>
                  <span>Guardrail</span>
                  <strong>{row.guardrail}</strong>
                </div>
              </div>
            ))}
          </div>
        </div>
        <div className="surface-panel">
          <div className="section-title compact">
            <Layers3 size={16} />
            <span>Surface composition matrix</span>
          </div>
          <div className="surface-grid">
            {surfaceCompositionRows.map((row) => (
              <div className="surface-card" key={row.surface}>
                <strong>{row.surface}</strong>
                <p>{row.workspace}</p>
                <div className="task-run-grid">
                  <span>Context panel</span>
                  <strong>{row.context}</strong>
                  <span>Evidence rail</span>
                  <strong>{row.evidence}</strong>
                  <span>Primary action</span>
                  <strong>{row.action}</strong>
                </div>
              </div>
            ))}
          </div>
        </div>
        <div className="model-panel">
          <div className="section-title compact">
            <Layers3 size={16} />
            <span>Data model boundary matrix</span>
          </div>
          <div className="model-grid">
            {dataModelRows.map((row) => (
              <div className="model-card" key={row.object}>
                <strong>{row.object}</strong>
                <p>{row.fields}</p>
                <div className="task-run-grid">
                  <span>Surfaces</span>
                  <strong>{row.surfaces}</strong>
                  <span>Evidence store</span>
                  <strong>{row.store}</strong>
                  <span>Guardrail</span>
                  <strong>{row.guardrail}</strong>
                </div>
              </div>
            ))}
          </div>
        </div>
        <div className="permission-panel">
          <div className="section-title compact">
            <Layers3 size={16} />
            <span>Permission confirmation matrix</span>
          </div>
          <div className="permission-grid">
            {permissionConfirmationRows.map((row) => (
              <div className="permission-card" key={row.level}>
                <strong>{row.level}</strong>
                <p>{row.trigger}</p>
                <div className="task-run-grid">
                  <span>Confirmation owner</span>
                  <strong>{row.owner}</strong>
                  <span>Evidence</span>
                  <strong>{row.evidence}</strong>
                  <span>Guardrail</span>
                  <strong>{row.guardrail}</strong>
                </div>
              </div>
            ))}
          </div>
        </div>
        <div className="context-panel">
          <div className="section-title compact">
            <Layers3 size={16} />
            <span>Context propagation matrix</span>
          </div>
          <div className="context-grid">
            {contextPropagationRows.map((row) => (
              <div className="context-card" key={row.context}>
                <strong>{row.context}</strong>
                <p>{row.source}</p>
                <div className="task-run-grid">
                  <span>Carries</span>
                  <strong>{row.carries}</strong>
                  <span>Destinations</span>
                  <strong>{row.destinations}</strong>
                  <span>Guardrail</span>
                  <strong>{row.guardrail}</strong>
                </div>
              </div>
            ))}
          </div>
        </div>
        <div className="workflow-panel">
          <div className="section-title compact">
            <Layers3 size={16} />
            <span>Product workflow trace</span>
          </div>
          <div className="workflow-grid">
            {productWorkflowRows.map((row) => (
              <div className="workflow-card" key={row.step}>
                <strong>{row.step}</strong>
                <p>{row.narrative}</p>
                <div className="task-run-grid">
                  <span>Surface</span>
                  <strong>{row.surface}</strong>
                  <span>Evidence</span>
                  <strong>{row.evidence}</strong>
                  <span>Guardrail</span>
                  <strong>{row.guardrail}</strong>
                </div>
              </div>
            ))}
          </div>
        </div>
        <div className="control-panel">
          <div className="section-title compact">
            <Layers3 size={16} />
            <span>Surface control catalog</span>
          </div>
          <div className="control-grid">
            {surfaceControlRows.map((row) => (
              <div className="control-card" key={row.surface}>
                <strong>{row.surface}</strong>
                <p>{row.controls}</p>
                <div className="task-run-grid">
                  <span>Availability</span>
                  <strong>{row.availability}</strong>
                  <span>Evidence</span>
                  <strong>{row.evidence}</strong>
                  <span>Guardrail</span>
                  <strong>{row.guardrail}</strong>
                </div>
              </div>
            ))}
          </div>
        </div>
        <CapabilityGroup
          title="MVP core"
          capabilities={mvpCore}
          selectedCapabilityId={selectedCapability?.id}
          onOpenView={onOpenView}
          onSelectCapability={setSelectedCapabilityId}
        />
        <CapabilityGroup
          title="MVP extension"
          capabilities={extension}
          selectedCapabilityId={selectedCapability?.id}
          onOpenView={onOpenView}
          onSelectCapability={setSelectedCapabilityId}
        />
        <CapabilityGroup
          title="Advanced visible surface"
          capabilities={advanced}
          selectedCapabilityId={selectedCapability?.id}
          onOpenView={onOpenView}
          onSelectCapability={setSelectedCapabilityId}
        />
        <CapabilityGroup
          title="Deferred boundary"
          capabilities={deferred}
          selectedCapabilityId={selectedCapability?.id}
          onOpenView={onOpenView}
          onSelectCapability={setSelectedCapabilityId}
        />
      </div>

      <aside className="panel contract-panel">
        <div className="section-title">
          <ServerCog size={18} />
          <span>Runtime service contracts</span>
        </div>
        {selectedCapability ? (
          <CapabilityDetail
            capability={selectedCapability}
            contract={selectedContract}
            onOpenView={onOpenView}
          />
        ) : null}
        <div className="adapter-readiness">
          <strong>Adapter readiness</strong>
          {adapters.map((adapter) => (
            <div className="adapter-card" key={adapter.id}>
              <div>
                <span>{adapter.label}</span>
                <StatusPill status={adapter.mode} />
              </div>
              <p>{adapter.contract}</p>
              <small>{adapter.nextNativeStep}</small>
            </div>
          ))}
        </div>
        {contracts.map((contract) => (
          <div
            className={selectedContract?.id === contract.id ? "contract-card selected" : "contract-card"}
            key={contract.id}
          >
            <div>
              <strong>{contract.name}</strong>
              <p>{contract.purpose}</p>
            </div>
            <div className="contract-split">
              <div>
                <span>Scheduler owns</span>
                <ul>
                  {contract.schedulerOwns.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </div>
              <div>
                <span>Agent owns</span>
                <ul>
                  {contract.agentOwns.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </div>
            </div>
            <code>{contract.futureStore}</code>
          </div>
        ))}
      </aside>
    </section>
  );
}

function CoverageCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="coverage-cell">
      <strong>{label}</strong>
      <span>{value}</span>
    </div>
  );
}

function CapabilityGroup({
  title,
  capabilities,
  selectedCapabilityId,
  onOpenView,
  onSelectCapability,
}: {
  title: string;
  capabilities: ProductCapability[];
  selectedCapabilityId?: string;
  onOpenView: (view: View) => void;
  onSelectCapability: (capabilityId: string) => void;
}) {
  return (
    <div className="capability-group">
      <h2>{title}</h2>
      <div className="capability-grid">
        {capabilities.map((capability) => (
          <article
            className={selectedCapabilityId === capability.id ? "capability-card selected" : "capability-card"}
            data-capability-id={capability.id}
            key={capability.id}
          >
            <div className="capability-card-head">
              <strong>{capability.title}</strong>
              <StatusPill status={capability.phase} />
            </div>
            <p>{capability.job}</p>
            <div className="task-run-grid">
              <span>Surface</span>
              <strong>{capability.surface}</strong>
              <span>State owner</span>
              <strong>{capability.stateOwner}</strong>
              <span>Evidence</span>
              <strong>{capability.evidence}</strong>
            </div>
            <div className="button-row">
              <button
                aria-label={`查看 ${capability.title}`}
                className="small-action"
                type="button"
                onClick={() => onSelectCapability(capability.id)}
              >
                查看能力
              </button>
              <button className="small-action" type="button" onClick={() => onOpenView(capability.surface)}>
                {capability.primaryAction}
                <ArrowRight size={14} />
              </button>
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}

function CapabilityDetail({
  capability,
  contract,
  onOpenView,
}: {
  capability: ProductCapability;
  contract?: RuntimeContract;
  onOpenView: (view: View) => void;
}) {
  return (
    <div className="capability-detail">
      <span className="eyebrow">Selected capability</span>
      <div className="capability-detail-head">
        <strong>{capability.title}</strong>
        <StatusPill status={capability.phase} />
      </div>
      <p>{capability.job}</p>
      <div className="task-run-grid">
        <span>Surface</span>
        <strong>{capability.surface}</strong>
        <span>Runtime boundary</span>
        <strong>{contract?.name ?? capability.contractId}</strong>
        <span>State owner</span>
        <strong>{capability.stateOwner}</strong>
        <span>Evidence</span>
        <strong>{capability.evidence}</strong>
      </div>
      <ol className="path-list">
        {capability.interactionPath.map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ol>
      <div className="next-step-box">
        <span>Next prototype step</span>
        <strong>{capability.nextStep}</strong>
      </div>
      <button
        aria-label={`打开 ${capability.title} 页面`}
        className="primary-button"
        type="button"
        onClick={() => onOpenView(capability.surface)}
      >
        {capability.primaryAction}
        <ArrowRight size={16} />
      </button>
    </div>
  );
}

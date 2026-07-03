import { describe, expect, it } from "vitest";

async function readWorkspaceFile(path: string) {
  const fsModule = "node:fs";
  const { readFileSync } = (await import(fsModule)) as {
    readFileSync: (path: URL, encoding: "utf8") => string;
  };

  return readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
}

describe("durable product intent docs", () => {
  it("records MCP confirmation evidence as an approved product increment", async () => {
    const spec = await readWorkspaceFile("docs/superworks/spec/product-interaction-map.md");

    expect(spec).toContain("| MCP Confirmation Evidence | Advanced |");
    expect(spec).toContain("confirm-class tool waits for scheduler approval or denial");
    expect(spec).toContain(".agent-workspace/mcp/<event-id>/confirmation.json");
    expect(spec).toContain("Resolving a confirmation must not create an `AgentRun`");
  });

  it("keeps Mobile Sync as a deferred capability boundary", async () => {
    const spec = await readWorkspaceFile("docs/superworks/spec/product-interaction-map.md");

    expect(spec).toContain("| Mobile Sync | Deferred |");
    expect(spec).toContain("Mobile Sync is a remote control surface for the desktop workbench");
    expect(spec).toContain("must not start remote execution in the current prototype");
  });

  it("records runtime instruction injection as a library-store boundary", async () => {
    const spec = await readWorkspaceFile("docs/superworks/spec/product-interaction-map.md");

    expect(spec).toContain("## Runtime Instruction Injection Boundary");
    expect(spec).toContain("Codex uses a managed block in `AGENTS.md`");
    expect(spec).toContain("must not rewrite agent workflows or skill bodies");
  });

  it("records provider session state detection as the Agent card state boundary", async () => {
    const [spec, providerStateSpec] = await Promise.all([
      readWorkspaceFile("docs/superworks/spec/product-interaction-map.md"),
      readWorkspaceFile("docs/superworks/spec/provider-session-state-detection.md"),
    ]);

    expect(spec).toContain("| Provider Session State Detection | MVP core |");
    expect(spec).toContain("Provider Adapter inspects provider-native state for task/session state");
    expect(spec).toContain("Provider adapters own semantic state");
    expect(spec).toContain("set Agent card state");
    expect(providerStateSpec).toContain("PTY Manager exposes only raw process lifecycle and output events");
    expect(providerStateSpec).toContain("Do not use terminal transcript regex");
  });

  it("records task intake as the board-first creation boundary that starts Conductor", async () => {
    const spec = await readWorkspaceFile("docs/superworks/spec/product-interaction-map.md");

    expect(spec).toContain("| Task Intake | MVP core |");
    expect(spec).toContain(
      "| Task Store | task id, intake source, labels, context artifact pointers, current task status, task event stream |",
    );
    expect(spec).toContain("## Task Intake Interaction");
    expect(spec).toContain(".agent-workspace/tasks/intake.jsonl");
    expect(spec).toContain("must not fabricate an `AgentRun`, bypass Review, or mark Done");
  });

  it("records AI task draft assistant as a headless opencode configuration step before task creation", async () => {
    const spec = await readWorkspaceFile("docs/superworks/spec/product-interaction-map.md");

    expect(spec).toContain("## Task Draft Assistant Interaction");
    expect(spec).toContain("Task Draft Assistant runs before Task Intake creates executable work");
    expect(spec).toContain("opencode headless");
    expect(spec).toContain("Session Agent Plan");
    expect(spec).toContain("Templates are defaults, not the final routing truth");
    expect(spec).toContain("The user can add, remove, duplicate, rename, or edit planned sessions before creation");
    expect(spec).toContain("must not start Conductor PTY");
    expect(spec).toContain("must not create a task, create an `AgentRun`, bypass Review, or mark Done");
  });

  it("records Workspace Session routing as separate from provider-native subagents", async () => {
    const spec = await readWorkspaceFile("docs/superworks/spec/product-interaction-map.md");

    expect(spec).toContain("## Workspace Session Communication Layer");
    expect(spec).toContain("The workbench-managed execution unit is a Workspace Session");
    expect(spec).toContain("provider-native mechanisms are implementation details and are allowed");
    expect(spec).toContain("Conductor Session -> call_session(Researcher Session)");
    expect(spec).toContain("Conductor Session -> read_session(Researcher Session)");
    expect(spec).toContain("Delegated sessions do not route work to each other");
    expect(spec).toContain("Reviewer does not directly command Researcher");
    expect(spec).toContain("must not auto-write long repair prompts into busy visible TUI sessions");
    expect(spec).toContain("stores the template id as the seed used for later worker target allowlist lookup");
    expect(spec).toContain("stores the final Session Agent Plan as the allowlist and prompt-planning truth");
  });

  it("records Conductor-centric session communication as the active direction", async () => {
    const [productSpec, conductorSpec, deprecatedPlan] = await Promise.all([
      readWorkspaceFile("docs/superworks/spec/product-interaction-map.md"),
      readWorkspaceFile("docs/superworks/spec/conductor-session-communication.md"),
      readWorkspaceFile("docs/superworks/plans/deprecated/session-dispatch-layer.plan.md"),
    ]);

    expect(productSpec).toContain("docs/superworks/spec/conductor-session-communication.md");
    expect(productSpec).toContain("only Conductor is modified with Agent Workspace MCP tools");
    expect(productSpec).toContain("delegated sessions remain provider-native");
    expect(productSpec).toContain("The previous structured Workspace Session Message block in terminal output is deprecated");

    expect(conductorSpec).toContain("Conductor session is the only session that receives Agent Workspace orchestration tools");
    expect(conductorSpec).toContain("Worker sessions do not get Agent Workspace protocol injection");
    expect(conductorSpec).toContain("The Task Session Plan is the user-visible, editable plan");
    expect(conductorSpec).toContain("Business orchestration belongs in the Task Session Plan and generated Conductor prompt");
    expect(conductorSpec).toContain("Multiple sessions may share the same role or display name");
    expect(conductorSpec).toContain("call_session");
    expect(conductorSpec).toContain("read_session");

    expect(deprecatedPlan).toContain("Status: Superseded / Deprecated after completion");
  });

  it("records spec ownership relationships in the spec README", async () => {
    const readme = await readWorkspaceFile("docs/superworks/spec/spec_readme.md");

    expect(readme).toContain("# Superworks Spec README");
    expect(readme).toContain("`product-interaction-map.md`");
    expect(readme).toContain("`conductor-session-communication.md`");
    expect(readme).toContain("`provider-session-state-detection.md`");
    expect(readme).toContain("The confirmed Session Agent Plan is the source for Conductor prompt planning");
    expect(readme).toContain("PTY output is a trigger and live inspection surface, not task-state truth");
  });

  it("records interactive task intake form behavior as a product increment", async () => {
    const spec = await readWorkspaceFile("docs/superworks/spec/product-interaction-map.md");

    expect(spec).toContain("Submitting the intake form records a `TaskIntakeEvent`");
    expect(spec).toContain("Task labels are task-store metadata");
    expect(spec).toContain("`TaskIntakeEvent` appears in Audit Trail");
  });

  it("records Task Detail as the board-to-run start surface", async () => {
    const spec = await readWorkspaceFile("docs/superworks/spec/product-interaction-map.md");

    expect(spec).toContain("Task Detail can start a task through the existing Loop/runtime adapter path");
    expect(spec).toContain("the action records a Loop schedule event before opening IDE Workbench");
    expect(spec).toContain("must reuse Run Store, PTY Service, and Git Service adapter boundaries");
  });

  it("records Review approval as a handoff into Runs audit before PR preparation", async () => {
    const spec = await readWorkspaceFile("docs/superworks/spec/product-interaction-map.md");

    expect(spec).toContain("After approval, the shell opens Runs so the user can inspect run-scoped audit evidence");
    expect(spec).toContain("Review approval must not create a `PullRequestHandoffEvent` automatically");
    expect(spec).toContain("PR handoff remains an explicit Runs action after approval evidence exists");
  });

  it("records Notification drill-down as routing to product surfaces without scheduling", async () => {
    const spec = await readWorkspaceFile("docs/superworks/spec/product-interaction-map.md");

    expect(spec).toContain("Opening a notification context selects the referenced task and routes the shell to the right surface");
    expect(spec).toContain("waiting-input opens IDE Workbench");
    expect(spec).toContain("pending-review or failed-verification opens Review");
    expect(spec).toContain("done opens Runs");
    expect(spec).toContain("Opening notification context must not acknowledge the event automatically");
  });

  it("records Audit Trail drill-back as source-surface navigation without scheduling", async () => {
    const spec = await readWorkspaceFile("docs/superworks/spec/product-interaction-map.md");

    expect(spec).toContain("Opening audit entry context selects the referenced task when one exists");
    expect(spec).toContain("routes to the source product surface");
    expect(spec).toContain("must not create an `AgentRun`, move task cards, approve Review, create PR handoff, or mutate evidence");
  });

  it("records Project context as an IDE Workbench focus boundary", async () => {
    const spec = await readWorkspaceFile("docs/superworks/spec/product-interaction-map.md");

    expect(spec).toContain("Opening the selected project in Workbench carries the project context into the IDE shell");
    expect(spec).toContain("Workbench sidebar shows the selected project path, manifest, browser profile, project agents, and project tasks");
    expect(spec).toContain("Selecting a project may align the visible task and agent to project-owned ids");
  });

  it("records task selection as task/project/agent focus alignment without scheduling", async () => {
    const spec = await readWorkspaceFile("docs/superworks/spec/product-interaction-map.md");

    expect(spec).toContain("Selecting a task from Workbench or Board aligns the visible task, owning project, and owner agent context");
    expect(spec).toContain("Task selection is a shell focus change, not a scheduler transition");
    expect(spec).toContain("must not create an `AgentRun`, start PTY, move task status, or approve Review");
  });

  it("records agent selection as project-owned task focus alignment without scheduling", async () => {
    const spec = await readWorkspaceFile("docs/superworks/spec/product-interaction-map.md");

    expect(spec).toContain("Selecting an agent in Workbench aligns to that agent's current project-owned task when one exists");
    expect(spec).toContain("Agent selection is a shell focus change, not a PTY or scheduler action");
    expect(spec).toContain("must not create an `AgentRun`, start PTY, move task status, or approve Review");
  });

  it("records runtime policy as run launch context before PTY execution", async () => {
    const spec = await readWorkspaceFile("docs/superworks/spec/product-interaction-map.md");

    expect(spec).toContain("| Runtime Policy | MVP core |");
    expect(spec).toContain("## Runtime Policy Interaction");
    expect(spec).toContain(".agent-workspace/runs/<run-id>/policy.json");
    expect(spec).toContain("must not create an `AgentRun`, start PTY, move task status, approve Review, or grant hidden capabilities");
  });

  it("records Runs launch policy audit as run-scoped evidence", async () => {
    const spec = await readWorkspaceFile("docs/superworks/spec/product-interaction-map.md");

    expect(spec).toContain("Runs preserves the same Runtime Policy artifact as run-scoped audit evidence");
    expect(spec).toContain("Audit Trail indexes runtime policy evidence separately from transcript evidence");
    expect(spec).toContain("Inspecting launch policy in Runs must not create an `AgentRun`, start PTY, move task status, approve Review, create PR handoff, or mutate policy");
  });

  it("records terminal diagnostics as run-scoped inspection evidence", async () => {
    const spec = await readWorkspaceFile("docs/superworks/spec/product-interaction-map.md");

    expect(spec).toContain("Runs may show terminal diagnostics as inspection evidence");
    expect(spec).toContain("Audit Trail may index terminal diagnostics separately from provider-state events");
    expect(spec).toContain("Inspecting terminal diagnostics must not create an `AgentRun`, start PTY, move task status, approve Review, or mutate terminal events");
  });

  it("records MCP tool calls as task-scoped Review and Runs evidence", async () => {
    const spec = await readWorkspaceFile("docs/superworks/spec/product-interaction-map.md");

    expect(spec).toContain("MCP tool calls are task-scoped shell evidence");
    expect(spec).toContain("Review and Runs show task-scoped MCP evidence without executing scheduler side effects");
    expect(spec).toContain("Inspecting MCP tool evidence must not create an `AgentRun`, start PTY, move task status, approve Review, or execute the tool");
  });

  it("records provider-state notification routing without terminal parser state", async () => {
    const spec = await readWorkspaceFile("docs/superworks/spec/product-interaction-map.md");

    expect(spec).toContain("Notifications display Review approval source evidence separately from provider-state source evidence");
    expect(spec).toContain("provider-state notifications show the provider-state event id and task/session evidence path");
    expect(spec).toContain("Parsing terminal output must not infer implementation quality");
  });

  it("records provider completion as Review-bound state instead of terminal Done approval", async () => {
    const [spec, providerStateSpec] = await Promise.all([
      readWorkspaceFile("docs/superworks/spec/product-interaction-map.md"),
      readWorkspaceFile("docs/superworks/spec/provider-session-state-detection.md"),
    ]);

    expect(spec).toContain("Review still requires verification, diff, and approval before Done");
    expect(providerStateSpec).toContain("completed_with_answer");
    expect(providerStateSpec).toContain("completed_with_artifact");
    expect(providerStateSpec).toContain("`completed_without_result` is a real state. It must not continue to display as `working`.");
  });

  it("records Done notification routing from Review approval evidence", async () => {
    const spec = await readWorkspaceFile("docs/superworks/spec/product-interaction-map.md");

    expect(spec).toContain("Review approval creates a done notification sourced from `ReviewApprovalEvent`");
    expect(spec).toContain("The done notification opens Runs and must not create PR handoff");
    expect(spec).toContain("Notifications display Review approval source evidence separately from provider-state source evidence");
  });

  it("records Runtime Policy audit drill-back into Runs without side effects", async () => {
    const spec = await readWorkspaceFile("docs/superworks/spec/product-interaction-map.md");

    expect(spec).toContain("Runtime Policy audit entries open Runs for the referenced task and run");
    expect(spec).toContain("Opening a Runtime Policy audit context must not create scheduling, Review, notification, or PR handoff side effects");
  });

  it("records notification source evidence in Workspace Audit Trail", async () => {
    const spec = await readWorkspaceFile("docs/superworks/spec/product-interaction-map.md");

    expect(spec).toContain("Notification audit entries preserve source label, source event id, source summary, and source evidence path");
    expect(spec).toContain("Workspace Audit Trail distinguishes provider-state-sourced notification evidence from Review approval notification evidence");
  });

  it("records Agent-Conversation redaction context in Workspace Audit Trail", async () => {
    const spec = await readWorkspaceFile("docs/superworks/spec/product-interaction-map.md");

    expect(spec).toContain("Redaction scan audit entries preserve task id, run id, transcript path, matched patterns, and redaction artifact path");
    expect(spec).toContain("Opening a redaction audit context routes to Review without changing approval, task, notification, or PR handoff state");
  });

  it("records Capability Coverage Matrix as a read-only product completeness view", async () => {
    const spec = await readWorkspaceFile("docs/superworks/spec/product-interaction-map.md");

    expect(spec).toContain("Capability Coverage Matrix summarizes capability counts by phase");
    expect(spec).toContain("runtime boundary coverage, evidence coverage, and next native step coverage");
    expect(spec).toContain("Inspecting the matrix must not create an `AgentRun`, move task status, approve Review, or open advanced surfaces");
  });

  it("records the Primary Interaction Backbone as a read-only end-to-end product path", async () => {
    const spec = await readWorkspaceFile("docs/superworks/spec/product-interaction-map.md");

    expect(spec).toContain("Primary Interaction Backbone renders the Board -> Loop -> Run Store -> PTY/Git -> IDE -> Review -> Runs path");
    expect(spec).toContain("It is a read-only explanation of page ownership, state ownership, and evidence handoff");
    expect(spec).toContain("Inspecting the backbone must not create an `AgentRun`, start PTY, move task status, approve Review, or create PR handoff");
  });

  it("records the Page Ownership Matrix as the read-only page responsibility map", async () => {
    const spec = await readWorkspaceFile("docs/superworks/spec/product-interaction-map.md");

    expect(spec).toContain("Page Ownership Matrix summarizes each visible surface group by product role");
    expect(spec).toContain("It distinguishes task ownership, scheduler ownership, run-surface ownership, review/audit ownership, context ownership, and advanced automation ownership");
    expect(spec).toContain("Inspecting the matrix must not create an `AgentRun`, start PTY, move task status, approve Review, execute MCP tools, capture browser evidence, or create PR handoff");
  });

  it("records the Interaction Route Matrix as the cross-page navigation and side-effect map", async () => {
    const spec = await readWorkspaceFile("docs/superworks/spec/product-interaction-map.md");

    expect(spec).toContain("Interaction Route Matrix maps the main cross-page transitions");
    expect(spec).toContain("It separates navigation-only drill-down, context focus, scheduler start, review approval, and audit drill-back");
    expect(spec).toContain("Inspecting the route matrix must not create an `AgentRun`, start PTY, move task status, approve Review, acknowledge notifications, execute MCP tools, capture browser evidence, or create PR handoff");
  });

  it("records the Action Side-Effect Matrix as the integrated action boundary map", async () => {
    const spec = await readWorkspaceFile("docs/superworks/spec/product-interaction-map.md");

    expect(spec).toContain("Action Side-Effect Matrix maps the integrated product actions");
    expect(spec).toContain("It distinguishes capture-only, focus-only, scheduler-start, diagnostics-inspect, provider-state evidence, review-evidence, review-approval, and PR-handoff actions");
    expect(spec).toContain("Inspecting the action matrix must not create an `AgentRun`, start PTY, move task status, approve Review, acknowledge notifications, execute MCP tools, capture browser evidence, prepare PR handoff, or mutate runtime evidence");
  });

  it("records the Durable Evidence Ledger as the shell-owned persistence map", async () => {
    const spec = await readWorkspaceFile("docs/superworks/spec/product-interaction-map.md");

    expect(spec).toContain("Durable Evidence Ledger maps shell-owned records");
    expect(spec).toContain("It groups task-store, loop-schedule, run, review, context, and advanced automation records");
    expect(spec).toContain("Inspecting the ledger must not create an `AgentRun`, start PTY, move task status, approve Review, acknowledge notifications, execute MCP tools, capture browser evidence, prepare PR handoff, mutate runtime evidence, or write runtime state into product-intent files");
  });

  it("records the Native Runtime Readiness Matrix as the runtime readiness map", async () => {
    const spec = await readWorkspaceFile("docs/superworks/spec/product-interaction-map.md");

    expect(spec).toContain("Native Runtime Readiness Matrix maps the runtime readiness path");
    expect(spec).toContain("It groups Run Store, PTY, Git, Filesystem Watch, Browser/MCP, and Project/Library stores");
    expect(spec).toContain("Inspecting the readiness matrix must not create an `AgentRun`, start PTY, move task status, approve Review, acknowledge notifications, execute MCP tools, capture browser evidence, prepare PR handoff, mutate runtime evidence, or replace adapters at runtime");
  });

  it("documents the opencode runtime boundary for real Task Home sessions", async () => {
    const spec = await readWorkspaceFile("docs/superworks/spec/product-interaction-map.md");

    expect(spec).toContain("## Opencode Runtime Boundary");
    expect(spec).toContain("Task Home creates real task records, task-scoped opencode Agent session records, and launches real opencode PTY sessions through the desktop bridge");
    expect(spec).toContain("Starting the same session id while a process is still running or stopping returns the existing session");
  });

  it("records the Command Surface Matrix as the global command entrypoint boundary", async () => {
    const spec = await readWorkspaceFile("docs/superworks/spec/product-interaction-map.md");

    expect(spec).toContain("Command Surface Matrix maps future desktop command entrypoints");
    expect(spec).toContain("It separates focus-only commands, scheduler-start commands, diagnostics-inspection commands, review-gate commands, PR-handoff commands, and advanced tool commands");
    expect(spec).toContain("Inspecting the command matrix must not create an `AgentRun`, start PTY, move task status, approve Review, execute MCP tools, capture browser evidence, prepare PR handoff, mutate runtime evidence, or open a hidden command palette");
  });

  it("records the Failure Recovery Matrix as the non-happy-path recovery boundary", async () => {
    const spec = await readWorkspaceFile("docs/superworks/spec/product-interaction-map.md");

    expect(spec).toContain("Failure Recovery Matrix maps non-happy-path product states");
    expect(spec).toContain("It groups runtime-start failure, failed verification, denied MCP confirmation, PTY or dev-command failure, team max-cycle block, and restore mismatch");
    expect(spec).toContain("Inspecting the failure matrix must not create an `AgentRun`, start PTY, retry a command, move task status, approve Review, execute MCP tools, capture browser evidence, prepare PR handoff, mutate runtime evidence, or replay agents");
  });

  it("records the State Lifecycle Matrix as the task-run-review-notification status boundary", async () => {
    const spec = await readWorkspaceFile("docs/superworks/spec/product-interaction-map.md");

    expect(spec).toContain("State Lifecycle Matrix maps task, run, review, and notification states");
    expect(spec).toContain("It separates queued task state, active run state, pending review claim state, failed verification state, and Review-approved Done state");
    expect(spec).toContain("Inspecting the state matrix must not create an `AgentRun`, start PTY, move task status, approve Review, acknowledge notifications, prepare PR handoff, mutate runtime evidence, or collapse run `completed` into task `done`");
  });

  it("records the Surface Composition Matrix as the page-internal layout boundary", async () => {
    const spec = await readWorkspaceFile("docs/superworks/spec/product-interaction-map.md");

    expect(spec).toContain("Surface Composition Matrix maps each product page to its primary workspace, context panel, evidence rail, and primary action");
    expect(spec).toContain("It keeps Task Board, Loop Console, IDE Workbench, Review, Runs/Audit, and advanced surfaces visually coherent without turning Capability Map into a second navigation model");
    expect(spec).toContain("Inspecting the surface matrix must not create an `AgentRun`, start PTY, move task status, approve Review, acknowledge notifications, prepare PR handoff, mutate runtime evidence, inject library context, request MCP tools, or replay agents");
  });

  it("records the Data Model Boundary Matrix as the product object ownership boundary", async () => {
    const spec = await readWorkspaceFile("docs/superworks/spec/product-interaction-map.md");

    expect(spec).toContain("Data Model Boundary Matrix maps product objects to owned fields, reader and writer surfaces, evidence stores, and guardrails");
    expect(spec).toContain("It keeps Project context, Agent profile, Task record, AgentRun record, Review package, Task artifact, and Notification signal separate");
    expect(spec).toContain("Inspecting the data model matrix must not create an `AgentRun`, start PTY, move task status, approve Review, acknowledge notifications, prepare PR handoff, mutate runtime evidence, attach artifacts, inject library context, request MCP tools, or write runtime state into product-intent files");
  });

  it("records the Permission Confirmation Matrix as the explicit side-effect consent boundary", async () => {
    const spec = await readWorkspaceFile("docs/superworks/spec/product-interaction-map.md");

    expect(spec).toContain("Permission Confirmation Matrix maps product actions to confirmation class, confirmation owner, evidence, and guardrails");
    expect(spec).toContain("It separates read-only inspection, focus routing, runtime launch, PTY write, Review gate, PR handoff, confirm-class MCP, advanced explicit action, and notification acknowledgement");
    expect(spec).toContain("Inspecting the permission matrix must not create an `AgentRun`, start PTY, write to PTY, move task status, approve Review, acknowledge notifications, prepare PR handoff, execute MCP tools, capture browser evidence, start dev commands, restore sessions, mutate runtime evidence, or write runtime state into product-intent files");
  });

  it("records the Context Propagation Matrix as the cross-surface focus alignment boundary", async () => {
    const spec = await readWorkspaceFile("docs/superworks/spec/product-interaction-map.md");

    expect(spec).toContain("Context Propagation Matrix maps how project, task, agent, run, review, library/artifact, and notification/audit context moves across surfaces");
    expect(spec).toContain("It keeps focus propagation separate from scheduler transitions, PTY writes, Review approval, PR handoff, library injection, notification acknowledgement, and audit drill-back side effects");
    expect(spec).toContain("Inspecting the context matrix must not create an `AgentRun`, start PTY, write to PTY, move task status, approve Review, acknowledge notifications, inject library context, attach artifacts, prepare PR handoff, execute MCP tools, mutate runtime evidence, or write runtime state into product-intent files");
  });

  it("records the Product Workflow Trace as the default end-to-end delivery path", async () => {
    const spec = await readWorkspaceFile("docs/superworks/spec/product-interaction-map.md");

    expect(spec).toContain("Product Workflow Trace maps the default end-to-end delivery path across the Board-first shell");
    expect(spec).toContain("It sequences intake capture, task focus, Loop scheduling, IDE execution, Review gate, Runs audit, and optional PR handoff");
    expect(spec).toContain("Inspecting the workflow trace must not create an `AgentRun`, start PTY, write to PTY, move task status, approve Review, acknowledge notifications, inject library context, attach artifacts, prepare PR handoff, execute MCP tools, mutate runtime evidence, or write runtime state into product-intent files");
  });

  it("records the Surface Control Catalog as the page action and availability boundary", async () => {
    const spec = await readWorkspaceFile("docs/superworks/spec/product-interaction-map.md");

    expect(spec).toContain("Surface Control Catalog maps each major page group to its primary controls, availability state, evidence, and guardrails");
    expect(spec).toContain("It keeps Task Board, Loop Console, IDE Workbench, Review, Runs/Audit, Projects/Libraries, and advanced surface controls aligned with their owning surfaces");
    expect(spec).toContain("Inspecting the control catalog must not create an `AgentRun`, start PTY, write to PTY, move task status, approve Review, acknowledge notifications, inject library context, attach artifacts, prepare PR handoff, execute MCP tools, capture browser evidence, start dev commands, restore sessions, mutate runtime evidence, or write runtime state into product-intent files");
  });

  it("records the Board-first navigation simplification as the primary information architecture", async () => {
    const spec = await readWorkspaceFile("docs/superworks/spec/product-interaction-map.md");

    expect(spec).toContain("Board-first Navigation Simplification reduces the visible primary navigation to four entries: Task Board, IDE Workbench, Delivery Gate, and More");
    expect(spec).toContain("It keeps Loop Console, Projects, Libraries, MCP, Browser, Teams, Dev Terminals, Notifications, Restore, Plan Watcher, Audit Trail, Runs, and Product Map available as grouped secondary entries instead of first-level navigation");
    expect(spec).toContain("The prototype uses Chinese-first UI labels while preserving Agent, Loop, Run, IDE, Review, PR, MCP, PTY, and Git as product terms");
  });

  it("records the Chinese-first core copy pass without adding full language switching", async () => {
    const spec = await readWorkspaceFile("docs/superworks/spec/product-interaction-map.md");

    expect(spec).toContain("Chinese-first Core Copy Pass keeps the prototype in one primary language instead of adding a full Chinese/English switch");
    expect(spec).toContain("It translates shell chrome, task intake controls, project cockpit headings, and primary user actions while preserving Agent, Loop, Run, IDE, Review, PR, MCP, PTY, Git, and product evidence terms");
    expect(spec).toContain("It must not introduce i18n runtime state, language toggles, translation dictionaries, or duplicate bilingual UI");
  });

  it("records the Board task detail progressive disclosure decision", async () => {
    const spec = await readWorkspaceFile("docs/superworks/spec/product-interaction-map.md");

    expect(spec).toContain("Board Task Detail Progressive Disclosure keeps the default Board page focused on the task queue and a compact selected-task summary");
    expect(spec).toContain("The summary exposes task state, Loop status, Run id, Agent owner, verification, and IDE drill-down before the heavier evidence panel is opened");
    expect(spec).toContain("Opening task details must not create an `AgentRun`, start PTY, move task status, approve Review, or write runtime state");
  });

  it("records the Task Intake progressive disclosure decision", async () => {
    const spec = await readWorkspaceFile("docs/superworks/spec/product-interaction-map.md");

    expect(spec).toContain("Task Intake Progressive Disclosure keeps the Board capture surface compact by default");
    expect(spec).toContain("The default intake row accepts a task title and records a running task with manual-brief, Conductor owner, selected starting scheme/model defaults, and no artifact defaults");
    expect(spec).toContain("The visible Session Agent Plan editor is card-first");
    expect(spec).toContain("Raw JSON may exist only as an advanced import/export or debugging affordance");
    expect(spec).toContain("Expanding context fields must not create Review approval, mark Done, or write runtime state into product-intent files");
  });

  it("records the Board chrome Chinese-first cleanup decision", async () => {
    const spec = await readWorkspaceFile("docs/superworks/spec/product-interaction-map.md");

    expect(spec).toContain("Board Chrome Chinese-first Cleanup keeps the default Board first scan in Chinese while preserving Agent, Loop, Run, IDE, Review, Done, and task as product terms");
    expect(spec).toContain("It translates the board principle strip, ownership pills, Loop summary title, and loop stage labels without changing routing, scheduler state, runtime adapters, or task events");
    expect(spec).toContain("The cleanup must not add i18n runtime state, language toggles, or duplicate bilingual UI");
  });

  it("records the desktop shell and local opencode bridge decision", async () => {
    const spec = await readWorkspaceFile("docs/superworks/spec/product-interaction-map.md");

    expect(spec).toContain("Desktop Shell + Local opencode Bridge is the first real native-runtime step after the Vite prototype");
    expect(spec).toContain("Electron owns local process access, resolves the installed opencode binary, and runs explicit one-shot `opencode run --format json` smoke checks through a preload IPC bridge");
    expect(spec).toContain("The Workbench may probe opencode and launch a test run only from the desktop bridge; browser mode must show that local process access is unavailable");
    expect(spec).toContain("This bridge must not create Done, approve Review, skip permission prompts, write runtime state into product-intent files, or hide the Review gate");
  });

  it("records native agent session controls as the next real runtime step", async () => {
    const spec = await readWorkspaceFile("docs/superworks/spec/product-interaction-map.md");

    expect(spec).toContain("Native Agent Session Controls extend the desktop bridge from one-shot opencode checks to managed local sessions");
    expect(spec).toContain("Workbench can start, refresh, write to, resize, stop, and display transcript output from a native opencode session");
    expect(spec).toContain("The IDE Workbench session path starts interactive `opencode` in a PTY using the selected project path and explicit model");
    expect(spec).toContain("`opencode run --format json` remains a one-shot smoke check or automation-loop primitive, not the conversation terminal");
    expect(spec).toContain("Session controls remain execution-surface evidence and must not mark tasks Done, approve Review, or bypass the scheduler-owned Run Store");
  });

  it("records native session runtime boundary", async () => {
    const spec = await readWorkspaceFile("docs/superworks/spec/product-interaction-map.md");

    expect(spec).toContain("Native Session Runtime Boundary keeps desktop-managed opencode PTY output as live run-surface UI state");
    expect(spec).toContain("it must not expose raw transcript or metadata evidence paths as task truth");
    expect(spec).toContain("Cross-session communication and `read_session` use the project-scoped Shell Session Store under `.agent-workspace/runtime/<task-id>/sessions/<session-id>/`");
    expect(spec).toContain("Runtime session handling must not write state into research, spec, or plans files");
  });

  it("records explicit opencode model selection and failure evidence", async () => {
    const spec = await readWorkspaceFile("docs/superworks/spec/product-interaction-map.md");

    expect(spec).toContain("Explicit opencode Model Selection keeps the desktop bridge from relying on an overloaded or misconfigured global default model");
    expect(spec).toContain("The prototype may pass `--model opencode-go/deepseek-v4-flash` for explicit smoke runs and interactive native PTY sessions");
    expect(spec).toContain("Timeout and provider errors must preserve stderr evidence such as rate-limit messages");
  });

  it("records native session state handoff into Run Store and Review", async () => {
    const spec = await readWorkspaceFile("docs/superworks/spec/product-interaction-map.md");

    expect(spec).toContain("Native Session State Handoff attaches desktop-managed opencode session state to the scheduler-owned `AgentRun`");
    expect(spec).toContain("Runs and Review must show native session id, backend, model, command, exit status, and provider result references");
    expect(spec).toContain("A stopped native session with exit 0 may move the task to pending Review but must not mark it Done");
  });

  it("records native verification command evidence as a real desktop bridge step", async () => {
    const spec = await readWorkspaceFile("docs/superworks/spec/product-interaction-map.md");

    expect(spec).toContain("Native Verification Command Evidence runs the selected run verification command through the Electron desktop bridge");
    expect(spec).toContain("The desktop shell writes `.agent-workspace/runs/<run-id>/verification.log` and `.agent-workspace/runs/<run-id>/verification.json`");
    expect(spec).toContain("Native verification evidence must not create an `AgentRun`, move task status, approve Review, mark Done, or hide failed stderr output");
  });

  it("records the conversation-first opencode IDE workbench decision", async () => {
    const spec = await readWorkspaceFile("docs/superworks/spec/product-interaction-map.md");

    expect(spec).toContain("Conversation-first opencode IDE Workbench makes the selected Agent conversation the primary IDE surface");
    expect(spec).toContain("Agent roles such as Planner, Executor, QA, and Reviewer are product roles, but their execution runtime is opencode");
    expect(spec).toContain("the central input writes to the selected opencode terminal session");
  });

  it("records project-scoped Agent cluster namespacing as the option C direction", async () => {
    const spec = await readWorkspaceFile("docs/superworks/spec/product-interaction-map.md");

    expect(spec).toContain("Project-scoped Agent Cluster Namespacing keeps multi-project and multi-task execution from sharing global Agent identities");
    expect(spec).toContain("The project default cluster is an internal `Project Runtime` fallback before any task exists");
    expect(spec).toContain("it is not a user-visible task and must not appear in the Workbench task list");
    expect(spec).toContain(
      "sessions, terminal input, restore records, run evidence, and visible Agent selection are scoped by `runtimeProjectId`, `runtimeTaskId`, cluster id, and agent id",
    );
  });

  it("records real opencode Agent command binding and PTY requirements", async () => {
    const spec = await readWorkspaceFile("docs/superworks/spec/product-interaction-map.md");

    expect(spec).toContain("Real opencode Agent Command Binding lets each product Agent own an editable launch command");
    expect(spec).toContain("Workbench reads `opencode agent list` through the desktop bridge");
    expect(spec).toContain("Interactive Agent terminal sessions require the real `node-pty` backend");
    expect(spec).toContain("render PTY output through a terminal emulator such as xterm");
    expect(spec).toContain("process fallback is limited to non-interactive smoke checks or verification commands");
    expect(spec).toContain("product roles like QA automatically exist as opencode runtime agents");
  });
});

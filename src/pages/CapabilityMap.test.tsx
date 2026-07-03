/**
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { productCapabilities, runtimeContracts } from "../mock/capabilityData";
import { getRuntimeAdapterCards } from "../runtime/mockAdapters";
import type { View } from "../types";
import { CapabilityMap } from "./CapabilityMap";

afterEach(() => {
  cleanup();
});

describe("CapabilityMap", () => {
  it("summarizes product capability coverage across phases and runtime boundaries", () => {
    render(
      <CapabilityMap
        adapters={getRuntimeAdapterCards()}
        capabilities={productCapabilities}
        contracts={runtimeContracts}
        onOpenView={() => undefined}
      />,
    );

    expect(screen.getByText("Capability coverage matrix")).toBeTruthy();
    expect(screen.getByText("29 capabilities")).toBeTruthy();
    expect(screen.getByText("19 MVP core")).toBeTruthy();
    expect(screen.getByText("3 MVP extension")).toBeTruthy();
    expect(screen.getByText("6 advanced")).toBeTruthy();
    expect(screen.getByText("1 deferred")).toBeTruthy();
    expect(screen.getByText("Runtime boundaries")).toBeTruthy();
    expect(screen.getByText("29 / 29 mapped")).toBeTruthy();
    expect(screen.getByText("Evidence fields")).toBeTruthy();
    expect(screen.getAllByText("29 / 29 defined").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("Next native steps")).toBeTruthy();
  });

  it("shows the primary interaction backbone from Board to Runs audit", () => {
    render(
      <CapabilityMap
        adapters={getRuntimeAdapterCards()}
        capabilities={productCapabilities}
        contracts={runtimeContracts}
        onOpenView={() => undefined}
      />,
    );

    expect(screen.getByText("Primary interaction backbone")).toBeTruthy();
    expect(screen.getByText("1. Board")).toBeTruthy();
    expect(screen.getByText("select task and inspect loop/run status")).toBeTruthy();
    expect(screen.getByText("2. Loop")).toBeTruthy();
    expect(screen.getByText("record scheduler decision")).toBeTruthy();
    expect(screen.getByText("3. Run Store")).toBeTruthy();
    expect(screen.getByText("create AgentRun and run artifact paths")).toBeTruthy();
    expect(screen.getByText("4. PTY + Git")).toBeTruthy();
    expect(screen.getByText("spawn CLI session and capture baseline")).toBeTruthy();
    expect(screen.getByText("5. IDE Workbench")).toBeTruthy();
    expect(screen.getByText("terminal, policy, provider state, diagnostics, scratchpad, diff context")).toBeTruthy();
    expect(screen.getByText("6. Review Gate")).toBeTruthy();
    expect(screen.getByText("verification, staging, redaction, approval")).toBeTruthy();
    expect(screen.getByText("7. Runs Audit")).toBeTruthy();
    expect(screen.getByText("run-scoped transcript, policy, evidence, PR handoff")).toBeTruthy();
  });

  it("shows the page ownership matrix across default, execution, evidence, and advanced surfaces", () => {
    render(
      <CapabilityMap
        adapters={getRuntimeAdapterCards()}
        capabilities={productCapabilities}
        contracts={runtimeContracts}
        onOpenView={() => undefined}
      />,
    );

    const ownershipPanel = screen.getByText("Page ownership matrix").closest(".ownership-panel") as HTMLElement | null;
    expect(ownershipPanel).toBeTruthy();
    if (!ownershipPanel) {
      throw new Error("missing ownership panel");
    }

    const ownershipQueries = within(ownershipPanel);
    expect(ownershipQueries.getByText("Page ownership matrix")).toBeTruthy();
    expect(ownershipQueries.getByText("Board / Task Intake")).toBeTruthy();
    expect(ownershipQueries.getByText("Task state and context capture")).toBeTruthy();
    expect(ownershipQueries.getByText("must not fabricate AgentRun or bypass Review")).toBeTruthy();
    expect(ownershipQueries.getAllByText("Loop Console").length).toBeGreaterThanOrEqual(2);
    expect(ownershipQueries.getByText("Scheduler decision and run start boundary")).toBeTruthy();
    expect(ownershipQueries.getByText("must not judge implementation quality")).toBeTruthy();
    expect(ownershipQueries.getByText("IDE Workbench")).toBeTruthy();
    expect(ownershipQueries.getByText("PTY run surface, prompt composer, provider state, diagnostics")).toBeTruthy();
    expect(ownershipQueries.getByText("must not approve Done")).toBeTruthy();
    expect(ownershipQueries.getByText("Review / Runs / Audit Trail")).toBeTruthy();
    expect(ownershipQueries.getByText("Verification, approval, completion evidence")).toBeTruthy();
    expect(ownershipQueries.getByText("must not create PR handoff automatically")).toBeTruthy();
    expect(ownershipQueries.getByText("Context surfaces")).toBeTruthy();
    expect(ownershipQueries.getByText("Projects, Watcher, Libraries")).toBeTruthy();
    expect(ownershipQueries.getByText("must not execute agents directly")).toBeTruthy();
    expect(ownershipQueries.getByText("Advanced automation")).toBeTruthy();
    expect(ownershipQueries.getByText("MCP, Browser, Teams, Notifications, Restore")).toBeTruthy();
    expect(ownershipQueries.getByText("must stay behind explicit gates")).toBeTruthy();
  });

  it("shows the interaction route matrix and separates navigation from side effects", () => {
    render(
      <CapabilityMap
        adapters={getRuntimeAdapterCards()}
        capabilities={productCapabilities}
        contracts={runtimeContracts}
        onOpenView={() => undefined}
      />,
    );

    const routePanel = screen.getByText("Interaction route matrix").closest(".route-panel") as HTMLElement | null;
    expect(routePanel).toBeTruthy();
    if (!routePanel) {
      throw new Error("missing route panel");
    }

    const routeQueries = within(routePanel);
    expect(routeQueries.getByText("Interaction route matrix")).toBeTruthy();
    expect(screen.getByText("Board task -> Workbench")).toBeTruthy();
    expect(screen.getByText("focus task and agent, open IDE drill-down")).toBeTruthy();
    expect(screen.getByText("no AgentRun unless Start Agent is used")).toBeTruthy();
    expect(screen.getByText("Board / Loop -> Start Agent")).toBeTruthy();
    expect(screen.getByText("create schedule event, AgentRun, PTY, git baseline")).toBeTruthy();
    expect(screen.getByText("must open through runtime adapters")).toBeTruthy();
    expect(screen.getByText("Provider result -> Review")).toBeTruthy();
    expect(screen.getByText("record provider completion claim and review evidence")).toBeTruthy();
    expect(routeQueries.getByText("terminal diagnostics must not mark Done")).toBeTruthy();
    expect(screen.getByText("Review approval -> Runs")).toBeTruthy();
    expect(screen.getByText("approve verified task and show run audit")).toBeTruthy();
    expect(screen.getAllByText("must not create PR handoff automatically").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("Notification / Audit -> Source")).toBeTruthy();
    expect(screen.getByText("select referenced task and route to source surface")).toBeTruthy();
    expect(screen.getByText("must not acknowledge, mutate, or schedule")).toBeTruthy();
    expect(screen.getByText("Projects / Libraries -> Workbench")).toBeTruthy();
    expect(screen.getByText("carry project, agent, prompt, or skill context")).toBeTruthy();
    expect(screen.getAllByText("must not execute agents directly").length).toBeGreaterThanOrEqual(1);
  });

  it("shows the action side-effect matrix for the integrated workbench actions", () => {
    render(
      <CapabilityMap
        adapters={getRuntimeAdapterCards()}
        capabilities={productCapabilities}
        contracts={runtimeContracts}
        onOpenView={() => undefined}
      />,
    );

    expect(screen.getByText("Action side-effect matrix")).toBeTruthy();
    expect(screen.getAllByText("Capture task draft").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("append TaskIntakeEvent and start Conductor task")).toBeTruthy();
    expect(screen.getByText("no fabricated AgentRun, Review, or Done")).toBeTruthy();
    expect(screen.getByText("Select task / agent / project")).toBeTruthy();
    expect(screen.getByText("focus shell context only")).toBeTruthy();
    expect(screen.getByText("no scheduler decision")).toBeTruthy();
    expect(screen.getAllByText("Start Agent").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("schedule event, AgentRun, PTY, git baseline")).toBeTruthy();
    expect(screen.getByText("must enter Workbench and Review lifecycle")).toBeTruthy();
    expect(screen.getByText("Inspect terminal diagnostics")).toBeTruthy();
    expect(screen.getByText("focus run evidence without changing task state")).toBeTruthy();
    expect(screen.getByText("must never drive Agent card or task state")).toBeTruthy();
    expect(screen.getByText("Run verification / stage / redaction")).toBeTruthy();
    expect(screen.getByText("review evidence under the active run")).toBeTruthy();
    expect(screen.getByText("does not approve Review")).toBeTruthy();
    expect(screen.getAllByText("Approve Review").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("ReviewApprovalEvent, Done task, done notification")).toBeTruthy();
    expect(screen.getByText("no automatic PR handoff")).toBeTruthy();
    expect(screen.getAllByText("Prepare PR handoff").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("PullRequestHandoffEvent draft")).toBeTruthy();
    expect(screen.getAllByText("does not open hosted PR").length).toBeGreaterThanOrEqual(1);
  });

  it("shows the durable evidence ledger matrix for shell-owned records", () => {
    render(
      <CapabilityMap
        adapters={getRuntimeAdapterCards()}
        capabilities={productCapabilities}
        contracts={runtimeContracts}
        onOpenView={() => undefined}
      />,
    );

    expect(screen.getByText("Durable evidence ledger")).toBeTruthy();
    expect(screen.getByText("Task Store ledger")).toBeTruthy();
    expect(screen.getByText("intake, transitions, artifacts")).toBeTruthy();
    expect(screen.getAllByText(".agent-workspace/tasks/").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("product-intent files stay immutable")).toBeTruthy();
    expect(screen.getByText("Loop Schedule ledger")).toBeTruthy();
    expect(screen.getByText("scheduler decisions and run start requests")).toBeTruthy();
    expect(screen.getAllByText(".agent-workspace/loops/events.jsonl").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("scheduler evidence is not agent reasoning")).toBeTruthy();
    expect(screen.getByText("Run ledger")).toBeTruthy();
    expect(screen.getByText("AgentRun, policy, worktree, transcript, provider-state events")).toBeTruthy();
    expect(screen.getAllByText(".agent-workspace/runs/<run-id>/").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("run record is not Review approval")).toBeTruthy();
    expect(screen.getByText("Review ledger")).toBeTruthy();
    expect(screen.getByText("verification, staging, redaction, gate, approval")).toBeTruthy();
    expect(screen.getAllByText(".agent-workspace/reviews/<run-id>/").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("done requires approval evidence")).toBeTruthy();
    expect(screen.getByText("Context ledger")).toBeTruthy();
    expect(screen.getByText("project manifests, agent profiles, prompt and skill bindings")).toBeTruthy();
    expect(screen.getByText(".agent-workspace/projects/ and .agent-workspace/libraries/")).toBeTruthy();
    expect(screen.getByText("context records do not execute agents")).toBeTruthy();
    expect(screen.getByText("Advanced evidence ledger")).toBeTruthy();
    expect(screen.getByText("browser, MCP, notifications, restore, teams")).toBeTruthy();
    expect(screen.getByText(".agent-workspace/browser|mcp|notifications|restore|teams/")).toBeTruthy();
    expect(screen.getByText("advanced records stay explicit gated evidence")).toBeTruthy();
  });

  it("shows the native runtime readiness matrix for replacing mock adapters", () => {
    render(
      <CapabilityMap
        adapters={getRuntimeAdapterCards()}
        capabilities={productCapabilities}
        contracts={runtimeContracts}
        onOpenView={() => undefined}
      />,
    );

    expect(screen.getByText("Native runtime readiness")).toBeTruthy();
    expect(screen.getByText("Run Store native persistence")).toBeTruthy();
    expect(screen.getByText("replace in-memory AgentRun records")).toBeTruthy();
    expect(screen.getByText("persist run artifacts under .agent-workspace/runs/<run-id>/")).toBeTruthy();
    expect(screen.getByText("does not interpret task output")).toBeTruthy();
    expect(screen.getByText("PTY process manager")).toBeTruthy();
    expect(screen.getByText("native PTY spawn/write/resize/stop")).toBeTruthy();
    expect(screen.getByText("desktop PTY sessions with restore metadata")).toBeTruthy();
    expect(screen.getByText("terminal output remains agent-owned")).toBeTruthy();
    expect(screen.getByText("Git service")).toBeTruthy();
    expect(screen.getByText("native baseline, attribution, staging, proposal")).toBeTruthy();
    expect(screen.getByText("local git status/diff/worktree/staging APIs")).toBeTruthy();
    expect(screen.getByText("proposal-first, Review still gates Done")).toBeTruthy();
    expect(screen.getByText("Filesystem watcher")).toBeTruthy();
    expect(screen.getByText("native docs product-intent change events")).toBeTruthy();
    expect(screen.getByText("native watcher on durable product-intent roots")).toBeTruthy();
    expect(screen.getByText("never writes runtime state into product intent")).toBeTruthy();
    expect(screen.getByText("Browser and MCP adapters")).toBeTruthy();
    expect(screen.getByText("native browser/MCP evidence records")).toBeTruthy();
    expect(screen.getByText("project Chromium profile and permission prompts")).toBeTruthy();
    expect(screen.getByText("advanced tools stay explicit and gated")).toBeTruthy();
    expect(screen.getByText("Project and Library stores")).toBeTruthy();
    expect(screen.getByText("manifest-backed project, prompt, skill context")).toBeTruthy();
    expect(screen.getByText("manifest-backed context and start-time injection")).toBeTruthy();
    expect(screen.getByText("context injection does not execute agents")).toBeTruthy();
  });

  it("shows the command surface matrix for global IDE commands without hidden side effects", () => {
    render(
      <CapabilityMap
        adapters={getRuntimeAdapterCards()}
        capabilities={productCapabilities}
        contracts={runtimeContracts}
        onOpenView={() => undefined}
      />,
    );

    const commandPanel = screen.getByText("Command surface matrix").closest(".command-panel") as HTMLElement | null;
    expect(commandPanel).toBeTruthy();
    if (!commandPanel) {
      throw new Error("missing command surface panel");
    }

    const commandQueries = within(commandPanel);
    expect(commandQueries.getByText("Command surface matrix")).toBeTruthy();
    expect(commandQueries.getByText("Open task command")).toBeTruthy();
    expect(commandQueries.getByText("Board / Workbench / Review")).toBeTruthy();
    expect(commandQueries.getByText("focus-only, no AgentRun")).toBeTruthy();
    expect(commandQueries.getByText("Start Agent command")).toBeTruthy();
    expect(commandQueries.getByText("Loop Console / Workbench")).toBeTruthy();
    expect(commandQueries.getByText("requires selected task and runtime policy")).toBeTruthy();
    expect(commandQueries.getByText("Inspect terminal diagnostics command")).toBeTruthy();
    expect(commandQueries.getByText("Workbench / Notifications / Review")).toBeTruthy();
    expect(commandQueries.getByText("never drives Agent cards or task state")).toBeTruthy();
    expect(commandQueries.getByText("Review gate command")).toBeTruthy();
    expect(commandQueries.getByText("Review / Runs")).toBeTruthy();
    expect(commandQueries.getByText("approval requires evidence")).toBeTruthy();
    expect(commandQueries.getByText("Prepare PR handoff command")).toBeTruthy();
    expect(commandQueries.getByText("Runs")).toBeTruthy();
    expect(screen.getAllByText("does not open hosted PR").length).toBeGreaterThanOrEqual(2);
    expect(commandQueries.getByText("Advanced tool command")).toBeTruthy();
    expect(commandQueries.getByText("MCP / Browser / Teams")).toBeTruthy();
    expect(commandQueries.getByText("confirmation/evidence required")).toBeTruthy();
  });

  it("shows the failure recovery matrix for non-happy-path product states", () => {
    render(
      <CapabilityMap
        adapters={getRuntimeAdapterCards()}
        capabilities={productCapabilities}
        contracts={runtimeContracts}
        onOpenView={() => undefined}
      />,
    );

    expect(screen.getByText("Failure recovery matrix")).toBeTruthy();
    expect(screen.getByText("Runtime start failed")).toBeTruthy();
    expect(screen.getByText("Loop / Workbench")).toBeTruthy();
    expect(screen.getByText("record launch failure and keep task out of Done")).toBeTruthy();
    expect(screen.getByText("no silent retry")).toBeTruthy();
    expect(screen.getByText("Verification failed")).toBeTruthy();
    expect(screen.getByText("Review / Notifications")).toBeTruthy();
    expect(screen.getByText("route task to failed-verification")).toBeTruthy();
    expect(screen.getByText("Review still owns retry")).toBeTruthy();
    expect(screen.getByText("MCP denied")).toBeTruthy();
    expect(screen.getByText("MCP Gateway / Audit Trail")).toBeTruthy();
    expect(screen.getByText("record denied decision evidence")).toBeTruthy();
    expect(screen.getByText("tool does not execute")).toBeTruthy();
    expect(screen.getByText("PTY or dev command failed")).toBeTruthy();
    expect(screen.getByText("Workbench / Dev Terminals")).toBeTruthy();
    expect(screen.getByText("preserve transcript or command log")).toBeTruthy();
    expect(screen.getByText("restart is explicit")).toBeTruthy();
    expect(screen.getByText("Team max cycle blocked")).toBeTruthy();
    expect(screen.getByText("Teams")).toBeTruthy();
    expect(screen.getByText("block handoff until user review")).toBeTruthy();
    expect(screen.getByText("no normal AgentRun side effect")).toBeTruthy();
    expect(screen.getByText("Restore mismatch")).toBeTruthy();
    expect(screen.getByText("Restore")).toBeTruthy();
    expect(screen.getByText("show rollback intent and evidence pointers")).toBeTruthy();
    expect(screen.getByText("does not replay agents")).toBeTruthy();
  });

  it("shows the state lifecycle matrix across task, run, review, and notification states", () => {
    render(
      <CapabilityMap
        adapters={getRuntimeAdapterCards()}
        capabilities={productCapabilities}
        contracts={runtimeContracts}
        onOpenView={() => undefined}
      />,
    );

    const statePanel = screen.getByText("State lifecycle matrix").closest(".state-panel") as HTMLElement | null;
    expect(statePanel).toBeTruthy();
    if (!statePanel) {
      throw new Error("missing state lifecycle panel");
    }

    const stateQueries = within(statePanel);
    expect(stateQueries.getByText("State lifecycle matrix")).toBeTruthy();
    expect(stateQueries.getByText("Task queued")).toBeTruthy();
    expect(stateQueries.getByText("todo / queued")).toBeTruthy();
    expect(stateQueries.getByText("no run yet")).toBeTruthy();
    expect(stateQueries.getByText("intake and task-store evidence only")).toBeTruthy();
    expect(stateQueries.getByText("Start Agent required")).toBeTruthy();
    expect(stateQueries.getByText("Run active")).toBeTruthy();
    expect(stateQueries.getByText("running / waiting-input")).toBeTruthy();
    expect(stateQueries.getByText("running")).toBeTruthy();
    expect(stateQueries.getByText("terminal transcript and provider-state evidence")).toBeTruthy();
    expect(stateQueries.getByText("agent output is not Review")).toBeTruthy();
    expect(stateQueries.getByText("Review pending")).toBeTruthy();
    expect(stateQueries.getByText("pending-review")).toBeTruthy();
    expect(stateQueries.getByText("pending-review run claim")).toBeTruthy();
    expect(stateQueries.getByText("Review gate evidence required")).toBeTruthy();
    expect(stateQueries.getByText("must not mark Done")).toBeTruthy();
    expect(stateQueries.getByText("Verification failed state")).toBeTruthy();
    expect(stateQueries.getByText("failed-verification / blocked")).toBeTruthy();
    expect(stateQueries.getByText("failed-verification")).toBeTruthy();
    expect(stateQueries.getByText("desktop notification and failed verification log")).toBeTruthy();
    expect(stateQueries.getByText("retry stays explicit")).toBeTruthy();
    expect(stateQueries.getByText("Review approved done")).toBeTruthy();
    expect(stateQueries.getByText("done")).toBeTruthy();
    expect(stateQueries.getByText("completed")).toBeTruthy();
    expect(stateQueries.getByText("ReviewApprovalEvent and done notification")).toBeTruthy();
    expect(stateQueries.getByText("PR handoff still explicit")).toBeTruthy();
  });

  it("shows the surface composition matrix for core and advanced pages", () => {
    render(
      <CapabilityMap
        adapters={getRuntimeAdapterCards()}
        capabilities={productCapabilities}
        contracts={runtimeContracts}
        onOpenView={() => undefined}
      />,
    );

    const surfacePanel = screen.getByText("Surface composition matrix").closest(".surface-panel") as HTMLElement | null;
    expect(surfacePanel).toBeTruthy();
    if (!surfacePanel) {
      throw new Error("missing surface composition panel");
    }

    const surfaceQueries = within(surfacePanel);
    expect(surfaceQueries.getByText("Surface composition matrix")).toBeTruthy();
    expect(surfaceQueries.getByText("Task Board")).toBeTruthy();
    expect(surfaceQueries.getByText("Kanban lanes and selected task detail")).toBeTruthy();
    expect(surfaceQueries.getByText("Loop health, task intake, and task artifacts")).toBeTruthy();
    expect(surfaceQueries.getByText(".agent-workspace/tasks/")).toBeTruthy();
    expect(surfaceQueries.getByText("Start Agent through Loop boundary")).toBeTruthy();
    expect(surfaceQueries.getByText("Loop Console")).toBeTruthy();
    expect(surfaceQueries.getByText("scheduler rules and run queue")).toBeTruthy();
    expect(surfaceQueries.getByText("active task, run policy, and failure recovery")).toBeTruthy();
    expect(surfaceQueries.getByText(".agent-workspace/loops/events.jsonl")).toBeTruthy();
    expect(surfaceQueries.getByText("Create schedule event")).toBeTruthy();
    expect(surfaceQueries.getByText("IDE Workbench")).toBeTruthy();
    expect(surfaceQueries.getByText("PTY terminal and prompt composer")).toBeTruthy();
    expect(surfaceQueries.getByText("project, agent, task, and scratchpad context")).toBeTruthy();
    expect(surfaceQueries.getByText("policy, transcript, provider state, diagnostics, and scratchpad artifacts")).toBeTruthy();
    expect(surfaceQueries.getByText("Write prompt to PTY")).toBeTruthy();
    expect(surfaceQueries.getByText("Review")).toBeTruthy();
    expect(surfaceQueries.getByText("changed files and commit scope")).toBeTruthy();
    expect(surfaceQueries.getByText("verification, staging, redaction, and approval gates")).toBeTruthy();
    expect(surfaceQueries.getByText(".agent-workspace/reviews/<run-id>/")).toBeTruthy();
    expect(surfaceQueries.getByText("Approve only after gates pass")).toBeTruthy();
    expect(surfaceQueries.getByText("Runs / Audit Trail")).toBeTruthy();
    expect(surfaceQueries.getByText("run timeline and workspace evidence chain")).toBeTruthy();
    expect(surfaceQueries.getByText("policy, worktree, approval, and PR handoff context")).toBeTruthy();
    expect(surfaceQueries.getByText("transcript, diff, verification, approval, and handoff artifacts")).toBeTruthy();
    expect(surfaceQueries.getByText("Prepare PR handoff after approval")).toBeTruthy();
    expect(surfaceQueries.getByText("Advanced surfaces")).toBeTruthy();
    expect(surfaceQueries.getByText("MCP, Browser, Teams, Restore, Notifications, Libraries")).toBeTruthy();
    expect(surfaceQueries.getByText("permission, task binding, project profile, and route rules")).toBeTruthy();
    expect(surfaceQueries.getByText(".agent-workspace/mcp|browser|teams|restore|notifications|libraries/")).toBeTruthy();
    expect(surfaceQueries.getByText("Request gated automation or inject context")).toBeTruthy();
  });

  it("shows the data model boundary matrix for product objects and evidence stores", () => {
    render(
      <CapabilityMap
        adapters={getRuntimeAdapterCards()}
        capabilities={productCapabilities}
        contracts={runtimeContracts}
        onOpenView={() => undefined}
      />,
    );

    const modelPanel = screen.getByText("Data model boundary matrix").closest(".model-panel") as HTMLElement | null;
    expect(modelPanel).toBeTruthy();
    if (!modelPanel) {
      throw new Error("missing data model boundary panel");
    }

    const modelQueries = within(modelPanel);
    expect(modelQueries.getByText("Data model boundary matrix")).toBeTruthy();
    expect(modelQueries.getByText("Project context")).toBeTruthy();
    expect(modelQueries.getByText("project id, path, zone, browser profile, agent ids, task ids")).toBeTruthy();
    expect(modelQueries.getByText("Projects / Workbench")).toBeTruthy();
    expect(modelQueries.getAllByText(".agent-workspace/projects/<project-id>.json").length).toBeGreaterThanOrEqual(2);
    expect(modelQueries.getByText("project selection is focus only")).toBeTruthy();
    expect(modelQueries.getByText("Agent profile")).toBeTruthy();
    expect(modelQueries.getByText("role, provider, model, status, task binding, system prompt path")).toBeTruthy();
    expect(modelQueries.getByText("Projects / Workbench / Libraries")).toBeTruthy();
    expect(modelQueries.getByText("agent profile does not start execution")).toBeTruthy();
    expect(modelQueries.getByText("Task record")).toBeTruthy();
    expect(modelQueries.getByText("title, status, owner, risk, verification, labels, artifact count")).toBeTruthy();
    expect(modelQueries.getByText("Task Board / Review / Audit Trail")).toBeTruthy();
    expect(modelQueries.getByText(".agent-workspace/tasks/")).toBeTruthy();
    expect(modelQueries.getByText("task done still requires Review approval")).toBeTruthy();
    expect(modelQueries.getByText("AgentRun record")).toBeTruthy();
    expect(modelQueries.getByText("run id, task id, agent id, status, policy, worktree, transcript paths")).toBeTruthy();
    expect(modelQueries.getByText("Workbench / Runs / Audit Trail")).toBeTruthy();
    expect(modelQueries.getByText(".agent-workspace/runs/<run-id>/")).toBeTruthy();
    expect(modelQueries.getByText("run completed is not task done")).toBeTruthy();
    expect(modelQueries.getByText("Review package")).toBeTruthy();
    expect(modelQueries.getByText("changed files, scoped selection, verification, staging, redaction, approval")).toBeTruthy();
    expect(modelQueries.getByText("Review / Runs")).toBeTruthy();
    expect(modelQueries.getByText(".agent-workspace/reviews/<run-id>/")).toBeTruthy();
    expect(modelQueries.getByText("approval is separate from commit handoff")).toBeTruthy();
    expect(modelQueries.getByText("Task artifact")).toBeTruthy();
    expect(modelQueries.getByText("screenshot, prompt template, sketch, html, browser evidence")).toBeTruthy();
    expect(modelQueries.getByText("Task Board / Workbench / Browser")).toBeTruthy();
    expect(modelQueries.getByText(".agent-workspace/tasks/<task-id>/artifacts/")).toBeTruthy();
    expect(modelQueries.getByText("artifact attachment does not move status")).toBeTruthy();
    expect(modelQueries.getByText("Notification signal")).toBeTruthy();
    expect(modelQueries.getByText("level, destination, acknowledgement, source event, source evidence")).toBeTruthy();
    expect(modelQueries.getByText("Notifications / Audit Trail")).toBeTruthy();
    expect(modelQueries.getByText(".agent-workspace/notifications/events.jsonl")).toBeTruthy();
    expect(modelQueries.getByText("notification routing is not scheduling")).toBeTruthy();
  });

  it("shows the permission confirmation matrix for gated side effects", () => {
    render(
      <CapabilityMap
        adapters={getRuntimeAdapterCards()}
        capabilities={productCapabilities}
        contracts={runtimeContracts}
        onOpenView={() => undefined}
      />,
    );

    const permissionPanel = screen.getByText("Permission confirmation matrix").closest(".permission-panel") as HTMLElement | null;
    expect(permissionPanel).toBeTruthy();
    if (!permissionPanel) {
      throw new Error("missing permission confirmation panel");
    }

    const permissionQueries = within(permissionPanel);
    expect(permissionQueries.getByText("Permission confirmation matrix")).toBeTruthy();
    expect(permissionQueries.getByText("Read-only inspection")).toBeTruthy();
    expect(permissionQueries.getByText("Capability Map / Audit Trail open")).toBeTruthy();
    expect(permissionQueries.getByText("none")).toBeTruthy();
    expect(permissionQueries.getByText("no runtime event")).toBeTruthy();
    expect(permissionQueries.getByText("no confirmation and no mutation")).toBeTruthy();
    expect(permissionQueries.getByText("Focus routing")).toBeTruthy();
    expect(permissionQueries.getByText("select task, project, agent, notification context")).toBeTruthy();
    expect(permissionQueries.getByText("Workspace Shell")).toBeTruthy();
    expect(permissionQueries.getByText("selected ids only")).toBeTruthy();
    expect(permissionQueries.getByText("confirmation not required because no durable transition")).toBeTruthy();
    expect(permissionQueries.getByText("Runtime launch")).toBeTruthy();
    expect(permissionQueries.getByText("Start Agent / Loop schedule")).toBeTruthy();
    expect(permissionQueries.getByText("Scheduler")).toBeTruthy();
    expect(permissionQueries.getByText(".agent-workspace/loops/events.jsonl")).toBeTruthy();
    expect(permissionQueries.getByText("requires selected task and visible runtime policy")).toBeTruthy();
    expect(permissionQueries.getByText("PTY write")).toBeTruthy();
    expect(permissionQueries.getByText("Send prompt / apply terminal input")).toBeTruthy();
    expect(permissionQueries.getByText("User in Workbench")).toBeTruthy();
    expect(permissionQueries.getByText(".agent-workspace/runs/<run-id>/transcript.log")).toBeTruthy();
    expect(permissionQueries.getByText("writes only to active PTY session")).toBeTruthy();
    expect(permissionQueries.getByText("Review gate")).toBeTruthy();
    expect(permissionQueries.getByText("run verification, stage files, redaction scan, approve Review")).toBeTruthy();
    expect(permissionQueries.getByText("Reviewer")).toBeTruthy();
    expect(permissionQueries.getByText(".agent-workspace/reviews/<run-id>/")).toBeTruthy();
    expect(permissionQueries.getByText("approval requires gate evidence")).toBeTruthy();
    expect(permissionQueries.getByText("PR handoff")).toBeTruthy();
    expect(permissionQueries.getByText("prepare PR handoff")).toBeTruthy();
    expect(permissionQueries.getByText("User in Runs")).toBeTruthy();
    expect(permissionQueries.getByText(".agent-workspace/pr/<run-id>/handoff.json")).toBeTruthy();
    expect(permissionQueries.getByText("does not open hosted PR")).toBeTruthy();
    expect(permissionQueries.getByText("Confirm-class MCP")).toBeTruthy();
    expect(permissionQueries.getByText("write/delete/upload/browser-control tool request")).toBeTruthy();
    expect(permissionQueries.getByText("Scheduler confirmation")).toBeTruthy();
    expect(permissionQueries.getByText(".agent-workspace/mcp/<event-id>/confirmation.json")).toBeTruthy();
    expect(permissionQueries.getByText("denied tool does not execute")).toBeTruthy();
    expect(permissionQueries.getByText("Advanced explicit action")).toBeTruthy();
    expect(permissionQueries.getByText("capture browser evidence, start dev command, restore session")).toBeTruthy();
    expect(permissionQueries.getByText("Advanced surface user action")).toBeTruthy();
    expect(permissionQueries.getByText(".agent-workspace/browser|commands|restore/")).toBeTruthy();
    expect(permissionQueries.getByText("advanced side effects stay explicit")).toBeTruthy();
    expect(permissionQueries.getByText("Notification acknowledgement")).toBeTruthy();
    expect(permissionQueries.getByText("acknowledge notification")).toBeTruthy();
    expect(permissionQueries.getByText("User in Notifications")).toBeTruthy();
    expect(permissionQueries.getByText(".agent-workspace/notifications/events.jsonl")).toBeTruthy();
    expect(permissionQueries.getByText("ack does not schedule or approve")).toBeTruthy();
  });

  it("shows the context propagation matrix for cross-surface focus alignment", () => {
    render(
      <CapabilityMap
        adapters={getRuntimeAdapterCards()}
        capabilities={productCapabilities}
        contracts={runtimeContracts}
        onOpenView={() => undefined}
      />,
    );

    const contextPanel = screen.getByText("Context propagation matrix").closest(".context-panel") as HTMLElement | null;
    expect(contextPanel).toBeTruthy();
    if (!contextPanel) {
      throw new Error("missing context propagation panel");
    }

    const contextQueries = within(contextPanel);
    expect(contextQueries.getByText("Context propagation matrix")).toBeTruthy();
    expect(contextQueries.getByText("Project focus")).toBeTruthy();
    expect(contextQueries.getByText("Projects selection")).toBeTruthy();
    expect(contextQueries.getByText("project id, path, zone, browser profile")).toBeTruthy();
    expect(contextQueries.getByText("Workbench, Board, Dev Terminals, Browser")).toBeTruthy();
    expect(contextQueries.getByText("project focus never starts agents")).toBeTruthy();
    expect(contextQueries.getByText("Task focus")).toBeTruthy();
    expect(contextQueries.getByText("Board card / Workbench task link")).toBeTruthy();
    expect(contextQueries.getByText("task id, owner agent, status, artifact count")).toBeTruthy();
    expect(contextQueries.getByText("Board, Workbench, Review, Runs")).toBeTruthy();
    expect(contextQueries.getByText("task focus never moves status")).toBeTruthy();
    expect(contextQueries.getByText("Agent focus")).toBeTruthy();
    expect(contextQueries.getByText("Workbench agent selection")).toBeTruthy();
    expect(contextQueries.getByText("agent id, role, provider, model, active task")).toBeTruthy();
    expect(contextQueries.getByText("Projects, Workbench, Review filter")).toBeTruthy();
    expect(contextQueries.getByText("agent focus never spawns PTY")).toBeTruthy();
    expect(contextQueries.getByText("Run focus")).toBeTruthy();
    expect(contextQueries.getByText("Loop start / Workbench active run")).toBeTruthy();
    expect(contextQueries.getByText("run id, policy, worktree, transcript, provider state")).toBeTruthy();
    expect(contextQueries.getByText("Workbench, Review, Runs, Audit Trail")).toBeTruthy();
    expect(contextQueries.getByText("run focus is not task completion")).toBeTruthy();
    expect(contextQueries.getByText("Review focus")).toBeTruthy();
    expect(contextQueries.getByText("Review gate / Runs audit selection")).toBeTruthy();
    expect(contextQueries.getByText("selected files, verification, staging, redaction, approval")).toBeTruthy();
    expect(contextQueries.getByText("Review, Runs, Audit Trail")).toBeTruthy();
    expect(contextQueries.getByText("review focus never opens PR")).toBeTruthy();
    expect(contextQueries.getByText("Library and artifact context")).toBeTruthy();
    expect(contextQueries.getByText("Prompt Library / Scratchpad attachment")).toBeTruthy();
    expect(contextQueries.getByText("prompt id, skill id, artifact path, task binding")).toBeTruthy();
    expect(contextQueries.getByText("Libraries, Workbench, Task Board")).toBeTruthy();
    expect(contextQueries.getByText("context injection never executes agents")).toBeTruthy();
    expect(contextQueries.getByText("Notification and audit context")).toBeTruthy();
    expect(contextQueries.getByText("Notification open / Audit drill-back")).toBeTruthy();
    expect(contextQueries.getByText("source event, task id, route target, evidence path")).toBeTruthy();
    expect(contextQueries.getByText("Notifications, Audit Trail, source surface")).toBeTruthy();
    expect(contextQueries.getByText("drill-back never acknowledges or schedules")).toBeTruthy();
  });

  it("shows the product workflow trace from intake through handoff", () => {
    render(
      <CapabilityMap
        adapters={getRuntimeAdapterCards()}
        capabilities={productCapabilities}
        contracts={runtimeContracts}
        onOpenView={() => undefined}
      />,
    );

    const workflowPanel = screen.getByText("Product workflow trace").closest(".workflow-panel") as HTMLElement | null;
    expect(workflowPanel).toBeTruthy();
    if (!workflowPanel) {
      throw new Error("missing product workflow trace panel");
    }

    const workflowQueries = within(workflowPanel);
    expect(workflowQueries.getByText("Product workflow trace")).toBeTruthy();
    expect(workflowQueries.getByText("1. Intake captured")).toBeTruthy();
    expect(workflowQueries.getByText("Task Intake records context and starts Conductor")).toBeTruthy();
    expect(workflowQueries.getAllByText("Task Board").length).toBeGreaterThanOrEqual(2);
    expect(workflowQueries.getByText(".agent-workspace/tasks/intake.jsonl")).toBeTruthy();
    expect(workflowQueries.getByText("no fabricated run or review approval")).toBeTruthy();
    expect(workflowQueries.getByText("2. Task selected")).toBeTruthy();
    expect(workflowQueries.getByText("Board card becomes the shell focus and exposes loop/run state")).toBeTruthy();
    expect(workflowQueries.getByText("selected task id")).toBeTruthy();
    expect(workflowQueries.getByText("focus does not schedule")).toBeTruthy();
    expect(workflowQueries.getByText("3. Loop scheduled")).toBeTruthy();
    expect(workflowQueries.getByText("Start Agent creates scheduler evidence and run policy")).toBeTruthy();
    expect(workflowQueries.getByText("Loop Console")).toBeTruthy();
    expect(workflowQueries.getByText(".agent-workspace/loops/events.jsonl")).toBeTruthy();
    expect(workflowQueries.getByText("scheduler does not reason")).toBeTruthy();
    expect(workflowQueries.getByText("4. IDE run active")).toBeTruthy();
    expect(workflowQueries.getByText("Workbench owns PTY, prompt composer, provider state, diagnostics, and scratchpad")).toBeTruthy();
    expect(workflowQueries.getByText("IDE Workbench")).toBeTruthy();
    expect(workflowQueries.getByText(".agent-workspace/runs/<run-id>/transcript.log")).toBeTruthy();
    expect(workflowQueries.getByText("terminal output is not approval")).toBeTruthy();
    expect(workflowQueries.getByText("5. Review gate")).toBeTruthy();
    expect(workflowQueries.getByText("Review checks diff scope, verification, staging and redaction")).toBeTruthy();
    expect(workflowQueries.getByText("Review")).toBeTruthy();
    expect(workflowQueries.getByText(".agent-workspace/reviews/<run-id>/")).toBeTruthy();
    expect(workflowQueries.getByText("Done requires approval evidence")).toBeTruthy();
    expect(workflowQueries.getByText("6. Runs audit")).toBeTruthy();
    expect(workflowQueries.getByText("Runs preserves policy, transcript, worktree and approval context")).toBeTruthy();
    expect(workflowQueries.getByText("Runs / Audit Trail")).toBeTruthy();
    expect(workflowQueries.getByText(".agent-workspace/runs/<run-id>/")).toBeTruthy();
    expect(workflowQueries.getByText("audit drill-back is read-only")).toBeTruthy();
    expect(workflowQueries.getByText("7. PR handoff optional")).toBeTruthy();
    expect(workflowQueries.getByText("User prepares PR handoff only after approval")).toBeTruthy();
    expect(workflowQueries.getByText("Runs")).toBeTruthy();
    expect(workflowQueries.getByText(".agent-workspace/pr/<run-id>/handoff.json")).toBeTruthy();
    expect(workflowQueries.getByText("does not open hosted PR")).toBeTruthy();
  });

  it("shows the surface control catalog for major page actions", () => {
    render(
      <CapabilityMap
        adapters={getRuntimeAdapterCards()}
        capabilities={productCapabilities}
        contracts={runtimeContracts}
        onOpenView={() => undefined}
      />,
    );

    const controlPanel = screen.getByText("Surface control catalog").closest(".control-panel") as HTMLElement | null;
    expect(controlPanel).toBeTruthy();
    if (!controlPanel) {
      throw new Error("missing surface control catalog panel");
    }

    const controlQueries = within(controlPanel);
    expect(controlQueries.getByText("Surface control catalog")).toBeTruthy();
    expect(controlQueries.getByText("Task Board controls")).toBeTruthy();
    expect(controlQueries.getByText("Capture task draft, select card, Start Agent, Advance status")).toBeTruthy();
    expect(controlQueries.getByText("auto-start intake form and selected task detail")).toBeTruthy();
    expect(controlQueries.getByText(".agent-workspace/tasks/intake.jsonl and events.jsonl")).toBeTruthy();
    expect(controlQueries.getByText("board controls never write PTY directly")).toBeTruthy();
    expect(controlQueries.getByText("Loop Console controls")).toBeTruthy();
    expect(controlQueries.getByText("Start Agent, Advance task, inspect rules")).toBeTruthy();
    expect(controlQueries.getByText("selected task and visible runtime policy")).toBeTruthy();
    expect(controlQueries.getByText(".agent-workspace/loops/events.jsonl")).toBeTruthy();
    expect(controlQueries.getByText("scheduler controls do not review code")).toBeTruthy();
    expect(controlQueries.getByText("IDE Workbench controls")).toBeTruthy();
    expect(controlQueries.getByText("Select agent/task, send prompt, inspect diagnostics, save scratchpad")).toBeTruthy();
    expect(controlQueries.getByText("active run and composer draft")).toBeTruthy();
    expect(controlQueries.getByText("session state, terminal diagnostics, scratchpad artifacts")).toBeTruthy();
    expect(controlQueries.getByText("Workbench controls do not approve Done")).toBeTruthy();
    expect(controlQueries.getByText("Review controls")).toBeTruthy();
    expect(controlQueries.getByText("toggle files, stage files, run verification, redaction scan, approve review")).toBeTruthy();
    expect(controlQueries.getByText("active run and selected file scope")).toBeTruthy();
    expect(controlQueries.getByText(".agent-workspace/reviews/<run-id>/ and runs/<run-id>/verification.json")).toBeTruthy();
    expect(controlQueries.getByText("approval blocked until evidence passes")).toBeTruthy();
    expect(controlQueries.getByText("Runs and Audit controls")).toBeTruthy();
    expect(controlQueries.getByText("select run, inspect evidence, prepare PR handoff, open source context")).toBeTruthy();
    expect(controlQueries.getByText("approved run or audit entry")).toBeTruthy();
    expect(controlQueries.getByText(".agent-workspace/runs/<run-id>/ and pr/<run-id>/handoff.json")).toBeTruthy();
    expect(controlQueries.getByText("audit inspection stays read-only")).toBeTruthy();
    expect(controlQueries.getByText("Projects and Libraries controls")).toBeTruthy();
    expect(controlQueries.getByText("select project, add agent, inject prompt, attach skill")).toBeTruthy();
    expect(controlQueries.getByText("selected project/task/agent context")).toBeTruthy();
    expect(controlQueries.getByText(".agent-workspace/projects/ and libraries/")).toBeTruthy();
    expect(controlQueries.getByText("context controls do not start execution")).toBeTruthy();
    expect(controlQueries.getByText("Advanced surface controls")).toBeTruthy();
    expect(controlQueries.getByText("request MCP, resolve confirmation, capture browser evidence, start dev command, restore session")).toBeTruthy();
    expect(controlQueries.getByText("explicit advanced page action")).toBeTruthy();
    expect(controlQueries.getByText(".agent-workspace/mcp|browser|commands|restore/")).toBeTruthy();
    expect(controlQueries.getByText("advanced controls stay gated and task-scoped")).toBeTruthy();
  });

  it("drills into a selected capability and opens its product surface", () => {
    const openedViews: View[] = [];

    render(
      <CapabilityMap
        adapters={getRuntimeAdapterCards()}
        capabilities={productCapabilities}
        contracts={runtimeContracts}
        onOpenView={(view) => openedViews.push(view)}
      />,
    );

    expect(screen.getByText("Selected capability")).toBeTruthy();
    expect(screen.getAllByText("Backlog Board").length).toBeGreaterThan(0);
    expect(screen.getByText("Select task card")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "查看 Browser Automation" }));

    expect(screen.getAllByText("Browser Automation").length).toBeGreaterThan(0);
    expect(screen.getByText("Open project browser")).toBeTruthy();
    expect(screen.getAllByText("Browser Service").length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: "打开 Browser Automation 页面" }));

    expect(openedViews).toEqual(["browser"]);

    fireEvent.click(screen.getByRole("button", { name: "查看 Restore Session" }));

    expect(screen.getAllByText("Restore Session").length).toBeGreaterThan(0);
    expect(screen.getByText("Load session manifest")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "打开 Restore Session 页面" }));

    expect(openedViews).toEqual(["browser", "restore"]);

    expect(screen.getByText("Deferred boundary")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "查看 Mobile Sync" }));

    expect(screen.getAllByText("Mobile Sync").length).toBeGreaterThan(0);
    expect(screen.getByText("Desktop/backend owns execution")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "打开 Mobile Sync 页面" }));

    expect(openedViews).toEqual(["browser", "restore", "capabilities"]);
  });
});

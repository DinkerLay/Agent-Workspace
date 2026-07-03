import { describe, expect, it } from "vitest";
import {
  browserTools,
  devCommands,
  libraryItems,
  mcpServers,
  productCapabilities,
  runtimeContracts,
  teamWorkflows,
} from "../mock/capabilityData";

describe("product capability map", () => {
  it("covers the researched AgentsRoom-like product surfaces", () => {
    const expectedCapabilities = [
      "projects",
      "agents",
      "agent-terminal",
      "runtime-policy",
      "provider-session-state-detection",
      "scratchpad",
      "plan-watcher",
      "task-intake",
      "backlog",
      "task-artifacts",
      "teams",
      "dev-terminals",
      "browser",
      "agent-mcp",
      "mcp-confirmation-evidence",
      "review",
      "commit-context",
      "run-worktree-context",
      "commit-staging-evidence",
      "verification-command",
      "review-gate-enforcement",
      "review-approval",
      "pr-handoff",
      "audit-trail",
      "prompt-library",
      "skills-library",
      "notifications",
      "restore-session",
      "mobile-sync",
    ];

    expect(productCapabilities.map((capability) => capability.id)).toEqual(expectedCapabilities);
  });

  it("keeps MVP execution surfaces distinct from advanced surfaces", () => {
    const mvpCore = productCapabilities
      .filter((capability) => capability.phase === "mvp-core")
      .map((capability) => capability.id);
    const advanced = productCapabilities
      .filter((capability) => capability.phase === "advanced")
      .map((capability) => capability.id);

    expect(mvpCore).toEqual([
      "projects",
      "agents",
      "agent-terminal",
      "runtime-policy",
      "provider-session-state-detection",
      "scratchpad",
      "plan-watcher",
      "task-intake",
      "backlog",
      "task-artifacts",
      "review",
      "commit-context",
      "run-worktree-context",
      "commit-staging-evidence",
      "verification-command",
      "review-gate-enforcement",
      "review-approval",
      "pr-handoff",
      "audit-trail",
    ]);
    expect(advanced).toEqual([
      "teams",
      "browser",
      "agent-mcp",
      "mcp-confirmation-evidence",
      "notifications",
      "restore-session",
    ]);
    expect(
      productCapabilities
        .filter((capability) => capability.phase === "deferred")
        .map((capability) => capability.id),
    ).toEqual(["mobile-sync"]);
  });

  it("defines runtime service contracts without mixing scheduler and agent reasoning", () => {
    expect(runtimeContracts.map((contract) => contract.id)).toEqual([
      "workspace-state",
      "task-store",
      "run-store",
      "pty-service",
      "runtime-policy",
      "provider-session-state",
      "git-service",
      "filesystem-watch",
      "browser-service",
      "mcp-gateway",
      "library-store",
      "team-scheduler",
      "notification-service",
      "client-sync-service",
    ]);
    expect(runtimeContracts.every((contract) => contract.schedulerOwns.length > 0)).toBe(true);
    expect(runtimeContracts.every((contract) => contract.agentOwns.length > 0)).toBe(true);
    expect(runtimeContracts.find((contract) => contract.id === "mcp-gateway")?.schedulerOwns).toContain(
      "confirmation decision",
    );
  });

  it("models runtime policy as shell-owned run launch context", () => {
    const policyCapability = productCapabilities.find((capability) => capability.id === "runtime-policy");
    const policyContract = runtimeContracts.find((contract) => contract.id === "runtime-policy");

    expect(policyCapability).toMatchObject({
      phase: "mvp-core",
      surface: "workbench",
      contractId: "runtime-policy",
      stateOwner: "workspace shell",
    });
    expect(policyCapability?.interactionPath).toContain("Record permission, sandbox, effort, and CLI command before PTY spawn");
    expect(policyCapability?.evidence).toContain(".agent-workspace/runs/<run-id>/policy.json");

    expect(policyContract?.schedulerOwns).toEqual([
      "permission mode",
      "sandbox mode",
      "effort level",
      "CLI command",
      "policy artifact path",
    ]);
    expect(policyContract?.agentOwns).toContain("operating within granted policy after PTY spawn");
  });

  it("models task intake as task-store creation that starts Conductor", () => {
    const intakeCapability = productCapabilities.find((capability) => capability.id === "task-intake");
    const taskStore = runtimeContracts.find((contract) => contract.id === "task-store");

    expect(intakeCapability).toMatchObject({
      phase: "mvp-core",
      surface: "backlog",
      contractId: "task-store",
      stateOwner: "task store",
    });
    expect(intakeCapability?.interactionPath).toContain("Capture title, description, labels, and optional artifact");
    expect(intakeCapability?.evidence).toContain(".agent-workspace/tasks/intake.jsonl");
    expect(intakeCapability?.nextStep).toContain("task intake persistence");
    expect(taskStore?.schedulerOwns).toEqual([
      "task id",
      "intake source",
      "labels",
      "context artifact pointers",
      "current task status",
      "task event stream",
    ]);
    expect(taskStore?.agentOwns).toContain("task interpretation after run starts");
  });

  it("models provider session state as the shell-owned status boundary", () => {
    const statusCapability = productCapabilities.find(
      (capability) => capability.id === "provider-session-state-detection",
    );
    const providerStateContract = runtimeContracts.find((contract) => contract.id === "provider-session-state");

    expect(statusCapability).toMatchObject({
      phase: "mvp-core",
      surface: "workbench",
      contractId: "provider-session-state",
    });
    expect(statusCapability?.interactionPath).toContain("Provider adapter reads provider-native session state");
    expect(statusCapability?.evidence).toContain(
      ".agent-workspace/runtime/<task-id>/sessions/<session-id>/state.json",
    );
    expect(providerStateContract?.schedulerOwns).toEqual([
      "state reducer",
      "compact session events",
      "dispatch/result indexes",
      "provider result routing",
    ]);
    expect(providerStateContract?.agentOwns).toContain("raw terminal output");
  });

  it("turns every capability into a drill-down interaction with a runtime boundary", () => {
    const contractIds = new Set(runtimeContracts.map((contract) => contract.id));

    expect(
      productCapabilities.map((capability) => {
        const detail = capability as {
          contractId?: string;
          interactionPath?: string[];
          nextStep?: string;
        };

        return {
          id: capability.id,
          hasContract: Boolean(detail.contractId && contractIds.has(detail.contractId)),
          interactionSteps: detail.interactionPath?.length ?? 0,
          hasNextStep: Boolean(detail.nextStep),
        };
      }),
    ).toEqual(
      productCapabilities.map((capability) => ({
        id: capability.id,
        hasContract: true,
        interactionSteps: expect.any(Number),
        hasNextStep: true,
      })),
    );

    expect(
      productCapabilities.every(
        (capability) => ((capability as { interactionPath?: string[] }).interactionPath?.length ?? 0) >= 3,
      ),
    ).toBe(true);
  });

  it("has concrete mock data for advanced product pages", () => {
    expect(devCommands).toHaveLength(4);
    expect(teamWorkflows).toHaveLength(2);
    expect(browserTools.map((tool) => tool.name)).toEqual([
      "browser_navigate",
      "browser_click",
      "browser_type",
      "browser_screenshot",
      "browser_evaluate",
      "browser_get_logs",
      "browser_get_state",
    ]);
    expect(mcpServers.map((server) => server.id)).toEqual([
      "mcp-backlog",
      "mcp-terminal-commands",
      "mcp-prompt-library",
      "mcp-browser",
    ]);
    expect(libraryItems.some((item) => item.kind === "prompt")).toBe(true);
    expect(libraryItems.some((item) => item.kind === "skill")).toBe(true);
  });

  it("makes skill injection an explicit runtime instruction boundary", () => {
    const skillsCapability = productCapabilities.find((capability) => capability.id === "skills-library");
    const libraryStore = runtimeContracts.find((contract) => contract.id === "library-store");

    expect(skillsCapability?.evidence).toContain("Codex AGENTS.md managed block");
    expect(skillsCapability?.interactionPath).toContain("Export runtime instruction context");
    expect(skillsCapability?.nextStep).toContain("start-time injection manifest");
    expect(libraryStore?.schedulerOwns).toContain("instruction export target");
    expect(libraryStore?.futureStore).toBe(".agent-workspace/libraries/");
  });
});

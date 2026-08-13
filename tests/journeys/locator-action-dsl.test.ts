import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { validateTemplateDefinitionV3 } from "@agent-workspace/runtime-contracts";
import {
  createLocatorActionDriver,
  executeLocatorActionScenario,
  inspectProductionLocatorCoverage,
  verifyActionCommandCorrelation,
  verifyScenarioSourceSafety,
  type HostCommandLedgerEntry,
  type LocatorActionDriver,
  type LocatorActionScenario,
} from "./locator-action-dsl.js";
import {
  browserLinearScenario,
  createAcpMetaJourneyScenario,
  createAcpTaskJourneyScenarios,
  createAcpTaskJourneyTemplateDefinition,
  crossSurfaceElectronScenario,
  electronLinearScenario,
} from "./full-journey.scenario.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("locator-only journey scenario boundary", () => {
  it("gives a scenario only five locator actions and correlates a visible mutation to uiIntentId and commandId", async () => {
    const entries: HostCommandLedgerEntry[] = [];
    const calls: string[] = [];
    const implementation: LocatorActionDriver = {
      async click() {
        calls.push("click");
        entries.push({
          commandId: "command_save-draft-1",
          uiIntentId: "ui_intent_save-draft-1",
          intentKind: "template.save_draft",
          runtimeInstanceId: "runtime_instance_browser-main",
          source: "authenticated_runtime_bridge",
        });
      },
      async fill() { calls.push("fill"); },
      async select() { calls.push("select"); },
      async press() { calls.push("press"); },
      async expectVisible() { calls.push("expectVisible"); },
    };
    const driver = createLocatorActionDriver(implementation);
    expect(Object.keys(driver).sort()).toEqual(["click", "expectVisible", "fill", "press", "select"]);
    expect(Object.isFrozen(driver)).toBe(true);
    expect("page" in driver).toBe(false);
    expect("window" in driver).toBe(false);

    const result = await executeLocatorActionScenario({
      scenario: {
        scenarioId: "scenario_browser-main",
        actions: [{
          checkpoint: "J-02",
          action: "click",
          target: { by: "role", role: "button", name: "Save draft" },
          intentKind: "template.save_draft",
          expectedHostCommands: 1,
        }],
      },
      driver,
      hostLedger: { snapshot: async () => [...entries] },
      traceNamespace: "trace_namespace_browser-main",
    });
    expect(calls).toEqual(["click"]);
    expect(result.correlations).toEqual([{
      actionTraceId: "action_trace_browser-main-1",
      scenarioId: "scenario_browser-main",
      checkpoint: "J-02",
      intentKind: "template.save_draft",
      uiIntentId: "ui_intent_save-draft-1",
      commandId: "command_save-draft-1",
      runtimeInstanceId: "runtime_instance_browser-main",
    }]);
  });

  it("rejects a forged driver, a Host mutation without the visible action, and correlation splicing", async () => {
    const scenario: LocatorActionScenario = {
      scenarioId: "scenario_negative",
      actions: [{
        checkpoint: "J-01",
        action: "expectVisible",
        target: { by: "text", value: "Agent Workspace" },
        intentKind: "view.launch",
      }],
    };
    const forged: LocatorActionDriver = {
      async click() {}, async fill() {}, async select() {}, async press() {}, async expectVisible() {},
    };
    await expect(executeLocatorActionScenario({
      scenario,
      driver: forged,
      hostLedger: { snapshot: async () => [] },
      traceNamespace: "trace_namespace_negative",
    })).rejects.toThrow("journey_locator_driver_not_runner_owned");

    const driver = createLocatorActionDriver(forged);
    let reads = 0;
    await expect(executeLocatorActionScenario({
      scenario,
      driver,
      hostLedger: {
        async snapshot() {
          reads += 1;
          return reads === 1 ? [] : [{
            commandId: "command_bypass-1",
            uiIntentId: "ui_intent_bypass-1",
            intentKind: "task.start",
            runtimeInstanceId: "runtime_instance_negative",
            source: "authenticated_runtime_bridge",
          }];
        },
      },
      traceNamespace: "trace_namespace_negative",
    })).rejects.toThrow("journey_visible_action_host_command_count_mismatch");

    expect(() => verifyActionCommandCorrelation([{
      actionTraceId: "action_trace_a-1",
      scenarioId: "scenario_a",
      checkpoint: "J-04",
      intentKind: "task.start",
      action: "click",
      target: { by: "testId", value: "task-start" },
      expectedHostCommands: 1,
    }], [{
      actionTraceId: "action_trace_a-1",
      scenarioId: "scenario_b",
      checkpoint: "J-04",
      intentKind: "task.start",
      uiIntentId: "ui_intent_b-1",
      commandId: "command_b-1",
      runtimeInstanceId: "runtime_instance_b",
    }])).toThrow("journey_host_command_visible_action_mismatch");
  });

  it("rejects Renderer-authored scenario/checkpoint authority in the Host ledger", async () => {
    const driver = createLocatorActionDriver({
      async click() {}, async fill() {}, async select() {}, async press() {}, async expectVisible() {},
    });
    await expect(executeLocatorActionScenario({
      scenario: {
        scenarioId: "scenario_ledger-authority",
        actions: [{
          checkpoint: "J-04",
          action: "click",
          target: { by: "testId", value: "task-start" },
          intentKind: "task.start",
          expectedHostCommands: 1,
        }],
      },
      driver,
      hostLedger: {
        snapshot: async () => [{
          commandId: "command_ledger-authority-1",
          uiIntentId: "ui_intent_ledger-authority-1",
          intentKind: "task.start",
          runtimeInstanceId: "runtime_instance_ledger-authority",
          source: "authenticated_runtime_bridge",
          scenarioId: "scenario_ledger-authority",
          checkpoint: "J-04",
        } as unknown as HostCommandLedgerEntry],
      },
      traceNamespace: "trace_namespace_ledger-authority",
    })).rejects.toThrow("journey_host_ledger_invalid");
  });

  it("rejects scenario attempts to declare evidence authority fields", async () => {
    const driver = createLocatorActionDriver({
      async click() {}, async fill() {}, async select() {}, async press() {}, async expectVisible() {},
    });
    await expect(executeLocatorActionScenario({
      scenario: {
        scenarioId: "scenario_authority-forgery",
        actions: [{ checkpoint: "J-01", action: "expectVisible", target: { by: "text", value: "Ready" }, intentKind: "view.ready" }],
        evidenceClass: "qualified_acp_provider",
      } as LocatorActionScenario,
      driver,
      hostLedger: { snapshot: async () => [] },
      traceNamespace: "trace_namespace_authority-forgery",
    })).rejects.toThrow("journey_locator_scenario_authority_field_forbidden");
  });

  it("statically rejects raw handles, evaluate/request/fetch, preload and RuntimeClient bypasses", async () => {
    await expect(verifyScenarioSourceSafety(path.resolve("tests/journeys"))).resolves.toBeUndefined();
    const root = await mkdtemp(path.join(tmpdir(), "agent-workspace-scenario-safety-"));
    roots.push(root);
    const forbidden = [
      `import { test } from "@playwright/test";`,
      `import type { Page } from "@playwright/test";`,
      `import { RuntimeClient } from "@agent-workspace/runtime-client";`,
      `thing.evaluate(() => 1);`,
      `thing.request.get("/commands");`,
      `fetch("/runtime");`,
      `window.runtime.command({});`,
      `const preloadFacade = {};`,
      `document.querySelector("button").click();`,
      `raw.locator("button").click();`,
      `import { fixture } from "@agent-workspace/test-kit";`,
      `import { createBrowserEvidenceAuthority } from "../e2e/journey-evidence";`,
    ];
    for (const [index, source] of forbidden.entries()) {
      const file = path.join(root, `forbidden-${index}.scenario.ts`);
      await writeFile(file, source, "utf8");
      await expect(verifyScenarioSourceSafety(file)).rejects.toThrow("journey_scenario_forbidden_");
    }
  });

  it("reports exact production locator coverage instead of waiting on selectors that do not exist", async () => {
    const coverage = await inspectProductionLocatorCoverage({
      productionRoots: [path.resolve("apps/workbench/src"), path.resolve("packages/workbench-ui/src")],
      scenarios: [browserLinearScenario],
    });
    expect(coverage.requiredTestIds.length).toBeGreaterThan(0);
    expect(new Set([...coverage.coveredTestIds, ...coverage.missingTestIds])).toEqual(new Set(coverage.requiredTestIds));
    expect(coverage.coveredTestIds.every((value) => !coverage.missingTestIds.includes(value))).toBe(true);
  });

  it("freezes Preview, explicit anchored/unanchored Achieve, J-09 planning order and audited J-10 restart semantics", () => {
    const actions = browserLinearScenario.actions;
    const definitionAction = actions.find(({ target }) => target.by === "testId" && target.value === "template-definition");
    expect(definitionAction).toMatchObject({ action: "fill", intentKind: "view.template.definition" });
    if (!definitionAction || definitionAction.action !== "fill") throw new Error("journey_template_definition_action_missing");
    const definition = validateTemplateDefinitionV3(JSON.parse(definitionAction.value));
    expect(definition.schemaVersion).toBe(3);
    expect(definition.agentCards.map(({ agentCardId }) => agentCardId)).toEqual([
      "agent_card_researcher", "agent_card_reviewer", "agent_card_publisher",
    ]);
    expect(definition.agentCards.map(({ agentCardId, executionProfileId }) => ({
      agentCardId,
      executionProfileId,
    }))).toEqual([
      { agentCardId: "agent_card_researcher", executionProfileId: "profile_worker" },
      { agentCardId: "agent_card_reviewer", executionProfileId: "profile_reviewer" },
      { agentCardId: "agent_card_publisher", executionProfileId: "profile_publisher" },
    ]);
    expect(definition.executionProfiles.map(({ capabilityPolicy }) => capabilityPolicy.allowedTools)).toEqual([
      ["invoke_agent", "send_to_session", "interrupt_session", "close_session"],
      [],
      [],
      [],
    ]);
    expect(definition.executionProfiles.map((profile) => ({
      profileRevisionId: profile.profileRevisionId,
      providerFamily: profile.providerFamily,
      acpAgentKind: profile.acpAgentKind,
      protocolMajor: profile.protocolMajor,
      configIntent: profile.configIntent,
      requiredExtensions: profile.requiredExtensions,
    }))).toEqual([
      {
        profileRevisionId: "profile_revision_journey-controlled-conductor-v1",
        providerFamily: "codex",
        acpAgentKind: "codex_acp",
        protocolMajor: 1,
        configIntent: {},
        requiredExtensions: [],
      },
      {
        profileRevisionId: "profile_revision_journey-controlled-worker-v1",
        providerFamily: "codex",
        acpAgentKind: "codex_acp",
        protocolMajor: 1,
        configIntent: {},
        requiredExtensions: [],
      },
      {
        profileRevisionId: "profile_revision_journey-controlled-publisher-v1",
        providerFamily: "codex",
        acpAgentKind: "codex_acp",
        protocolMajor: 1,
        configIntent: {},
        requiredExtensions: [],
      },
      {
        profileRevisionId: "profile_revision_journey-controlled-reviewer-v1",
        providerFamily: "codex",
        acpAgentKind: "codex_acp",
        protocolMajor: 1,
        configIntent: {},
        requiredExtensions: [],
      },
    ]);
    for (const profile of definition.executionProfiles) {
      expect(profile).not.toHaveProperty("provider");
      expect(profile).not.toHaveProperty("providerVersion");
      expect(profile).not.toHaveProperty("protocolFingerprint");
    }
    const opencodeTask = createAcpTaskJourneyScenarios({
      providerFamily: "opencode",
      model: "task-model-opencode",
    });
    const codexTask = createAcpTaskJourneyScenarios({
      providerFamily: "codex",
      model: "task-model-codex",
    });
    const opencodeDefinitionAction = opencodeTask.browser.actions.find(
      ({ target }) => target.by === "testId" && target.value === "template-definition",
    );
    expect(opencodeDefinitionAction).toMatchObject({ action: "fill", intentKind: "view.template.definition" });
    if (!opencodeDefinitionAction || opencodeDefinitionAction.action !== "fill") {
      throw new Error("journey_acp_task_template_definition_action_missing");
    }
    const opencodeDefinition = validateTemplateDefinitionV3(JSON.parse(opencodeDefinitionAction.value));
    expect(opencodeDefinition).toEqual(createAcpTaskJourneyTemplateDefinition({
      providerFamily: "opencode",
      model: "task-model-opencode",
    }));
    expect(opencodeDefinition.executionProfiles.map(({ executionProfileId, profileRevisionId, providerFamily, acpAgentKind }) => ({
      executionProfileId,
      profileRevisionId,
      providerFamily,
      acpAgentKind,
    }))).toEqual([
      {
        executionProfileId: "profile_conductor",
        profileRevisionId: "profile_revision_journey-opencode-acp-task-conductor-v1",
        providerFamily: "opencode",
        acpAgentKind: "native_acp",
      },
      {
        executionProfileId: "profile_worker",
        profileRevisionId: "profile_revision_journey-opencode-acp-task-worker-v1",
        providerFamily: "opencode",
        acpAgentKind: "native_acp",
      },
      {
        executionProfileId: "profile_publisher",
        profileRevisionId: "profile_revision_journey-opencode-acp-task-publisher-v1",
        providerFamily: "opencode",
        acpAgentKind: "native_acp",
      },
      {
        executionProfileId: "profile_reviewer",
        profileRevisionId: "profile_revision_journey-opencode-acp-task-reviewer-v1",
        providerFamily: "opencode",
        acpAgentKind: "native_acp",
      },
    ]);
    expect(opencodeDefinition.executionProfiles.map(({ capabilityPolicy }) => capabilityPolicy.allowedTools)).toEqual([
      ["invoke_agent", "send_to_session", "interrupt_session", "close_session"],
      [],
      [],
      [],
    ]);
    for (const profile of opencodeDefinition.executionProfiles) {
      expect(profile).not.toHaveProperty("provider");
      expect(profile).not.toHaveProperty("providerVersion");
      expect(profile).not.toHaveProperty("protocolFingerprint");
    }
    const codexDefinitionAction = codexTask.browser.actions.find(
      ({ target }) => target.by === "testId" && target.value === "template-definition",
    );
    if (!codexDefinitionAction || codexDefinitionAction.action !== "fill") {
      throw new Error("journey_acp_task_template_definition_action_missing");
    }
    const codexDefinition = validateTemplateDefinitionV3(JSON.parse(codexDefinitionAction.value));
    expect(codexDefinition.executionProfiles.map(({ profileRevisionId, providerFamily, acpAgentKind, model }) => ({
      profileRevisionId,
      providerFamily,
      acpAgentKind,
      model,
    }))).toEqual([
      {
        profileRevisionId: "profile_revision_journey-codex-acp-task-conductor-v1",
        providerFamily: "codex",
        acpAgentKind: "codex_acp",
        model: "task-model-codex",
      },
      {
        profileRevisionId: "profile_revision_journey-codex-acp-task-worker-v1",
        providerFamily: "codex",
        acpAgentKind: "codex_acp",
        model: "task-model-codex",
      },
      {
        profileRevisionId: "profile_revision_journey-codex-acp-task-publisher-v1",
        providerFamily: "codex",
        acpAgentKind: "codex_acp",
        model: "task-model-codex",
      },
      {
        profileRevisionId: "profile_revision_journey-codex-acp-task-reviewer-v1",
        providerFamily: "codex",
        acpAgentKind: "codex_acp",
        model: "task-model-codex",
      },
    ]);
    for (const taskScenario of [opencodeTask.browser, opencodeTask.electron, codexTask.browser, codexTask.electron]) {
      expect(taskScenario.actions.some(({ intentKind }) => intentKind.startsWith("meta.")
        || intentKind.startsWith("view.meta.")
        || intentKind.startsWith("view.task_setup_meta."))).toBe(false);
    }
    const metaScenario = createAcpMetaJourneyScenario({ metaProfileOptionId: "meta_profile_option_release" });
    const metaRequests = metaScenario.actions.filter(
      ({ intentKind }) => intentKind === "view.meta.compose",
    );
    expect(metaRequests).toHaveLength(2);
    expect(metaRequests[0]).toMatchObject({
      checkpoint: "J-02",
      action: "fill",
      value: expect.stringContaining("exactly one template_metadata_set operation"),
    });
    expect(metaRequests[1]).toMatchObject({
      checkpoint: "J-03",
      action: "fill",
      value: expect.stringContaining("exactly one task_setup_goal_set operation"),
    });
    const metaHostSelections = metaScenario.actions.filter(
      ({ intentKind }) => ["view.meta.select_host", "view.task_setup_meta.select_host"].includes(intentKind),
    );
    expect(metaHostSelections).toEqual([
      expect.objectContaining({ checkpoint: "J-02", action: "select", value: "meta_profile_option_release" }),
      expect.objectContaining({ checkpoint: "J-03", action: "select", value: "meta_profile_option_release" }),
    ]);
    expect(metaScenario.actions.some(({ intentKind }) => intentKind === "task.create")).toBe(false);
    expect(metaScenario.actions.some(({ checkpoint }) => !["J-02", "J-03"].includes(checkpoint))).toBe(false);
    expect(actions.find(({ target }) => target.by === "testId" && target.value === "publisher-file-preview"))
      .toMatchObject({ intentKind: "workspace.preview_file", expectedHostCommands: 1 });
    expect(actions.find(({ target }) => target.by === "testId" && target.value === "task-achieve-without-anchor"))
      .toMatchObject({ intentKind: "task.achieve", expectedHostCommands: 1 });
    expect(actions.find(({ target }) => target.by === "testId" && target.value === "task-achieved-without-anchor"))
      .toMatchObject({ action: "expectVisible", intentKind: "view.task.achieved_without_anchor" });
    expect(actions.some(({ target }) => target.by === "testId" && target.value === "task-achieve-with-anchor")).toBe(false);
    for (const anchoredScenario of [
      electronLinearScenario,
      crossSurfaceElectronScenario,
      opencodeTask.electron,
      codexTask.electron,
    ]) {
      expect(anchoredScenario.actions.find(({ target }) => target.by === "testId" && target.value === "task-achieve-with-anchor"))
        .toMatchObject({ intentKind: "task.achieve", expectedHostCommands: 1 });
      expect(anchoredScenario.actions.find(({ target }) => target.by === "testId" && target.value === "task-achieved-with-anchor"))
        .toMatchObject({ action: "expectVisible", intentKind: "view.task.achieved_with_anchor" });
      expect(anchoredScenario.actions.some(({ target }) => target.by === "testId" && target.value === "task-achieve-without-anchor"))
        .toBe(false);
    }
    const acpReopenIntent = opencodeTask.electron.actions.find(({ checkpoint, target }) => checkpoint === "J-09"
      && target.by === "testId" && target.value === "task-conductor-composer");
    expect(acpReopenIntent).toMatchObject({
      action: "fill",
      intentKind: "view.conductor.compose",
      value: expect.stringContaining("orchestration_session_not_current"),
    });
    expect(actions.find(({ target }) => target.by === "testId" && target.value === "task-conductor-send"))
      .toMatchObject({ intentKind: "task.submit_input", expectedHostCommands: 1 });
    expect(actions.some(({ intentKind }) => intentKind === "harness.host_restart")).toBe(false);

    const index = (testId: string) => actions.findIndex(({ target }) => target.by === "testId" && target.value === testId);
    expect(index("publisher-file-preview")).toBeLessThan(index("task-achieve-without-anchor"));
    expect(index("task-achieve-without-anchor")).toBeLessThan(index("task-achieved-without-anchor"));
    expect(index("card-send-idle-direct")).toBeLessThan(index("human-message-idle-direct-delivered"));
    expect(index("human-message-idle-direct-delivered")).toBeLessThan(index("session-researcher-busy-for-human-hold"));
    expect(index("session-researcher-busy-for-human-hold")).toBeLessThan(index("card-send-interrupt-first"));
    expect(index("card-send-interrupt-first")).toBeLessThan(index("human-message-held"));
    expect(index("human-message-held")).toBeLessThan(index("human-message-delivered-turn"));
    expect(index("human-message-delivered-turn")).toBeLessThan(index("session-interrupt-only"));
    expect(index("conductor-notice-followup-sent")).toBeLessThan(index("session-researcher-busy-after-notice"));
    expect(index("session-researcher-busy-after-notice")).toBeLessThan(index("task-conductor-send"));
    expect(index("task-conductor-send")).toBeLessThan(index("conductor-session-interrupt-accepted"));
  });

  it("runs the audited restart after the before-state assertion and before recovery", async () => {
    const order: string[] = [];
    const driver = createLocatorActionDriver({
      async click() {}, async fill() {}, async select() {}, async press() {},
      async expectVisible(target) {
        order.push(target.by === "testId" ? target.value : "unexpected-target");
      },
    });
    await executeLocatorActionScenario({
      scenario: {
        scenarioId: "scenario_restart-order",
        actions: [
          {
            checkpoint: "J-10",
            action: "expectVisible",
            target: { by: "testId", value: "task-before-host-restart" },
            intentKind: "view.task.before_restart",
          },
          {
            checkpoint: "J-10",
            action: "expectVisible",
            target: { by: "testId", value: "task-recovered" },
            intentKind: "view.task.recovered",
          },
        ],
      },
      driver,
      hostLedger: { snapshot: async () => [] },
      traceNamespace: "trace_namespace_restart-order",
      checkpointBoundary: {
        async afterAction(action) {
          if (action.intentKind === "view.task.before_restart") order.push("audited-host-restart");
        },
      },
    });
    expect(order).toEqual(["task-before-host-restart", "audited-host-restart", "task-recovered"]);
  });
});

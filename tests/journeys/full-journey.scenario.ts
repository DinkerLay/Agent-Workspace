import { validateTemplateDefinitionV3 } from "@agent-workspace/runtime-contracts";
import type { LocatorAction, LocatorActionScenario } from "./locator-action-dsl.js";

const testId = (value: string) => ({ by: "testId", value } as const);

const PINNED_SESSION_ID_DEFINITION = validateTemplateDefinitionV3({
  schemaVersion: 3,
  conductor: {
    agentCardId: "agent_card_conductor",
    kind: "conductor",
    title: "Conductor",
    executionProfileId: "profile_conductor",
    systemPrompt: "Coordinate this Task only through the four scoped Runtime orchestration tools.",
    capabilityRefs: [],
  },
  agentCards: [
    {
      agentCardId: "agent_card_researcher",
      kind: "researcher",
      title: "Researcher",
      executionProfileId: "profile_worker",
      systemPrompt: "Research the requested topic and return one concise evidence-backed final.",
      capabilityRefs: [],
      dispatchProfile: { title: "Researcher", description: "Produces the primary research result." },
    },
    {
      agentCardId: "agent_card_reviewer",
      kind: "reviewer",
      title: "Reviewer",
      executionProfileId: "profile_reviewer",
      systemPrompt: "Review only the selected research snapshot and return one final review.",
      capabilityRefs: [],
      dispatchProfile: { title: "Reviewer", description: "Reviews a selected research snapshot." },
    },
    {
      agentCardId: "agent_card_publisher",
      kind: "publisher",
      title: "Publisher",
      executionProfileId: "profile_publisher",
      systemPrompt: "Publish the reviewed result with the Provider's native file tools and return one final.",
      capabilityRefs: [],
      dispatchProfile: { title: "Publisher", description: "Writes the reviewed report to the authorized Workspace." },
    },
  ],
  executionProfiles: [
    {
      executionProfileId: "profile_conductor",
      profileRevisionId: "profile_revision_journey-controlled-conductor-v1",
      providerFamily: "codex",
      acpAgentKind: "codex_acp",
      protocolMajor: 1,
      model: "gpt-5.4",
      configIntent: {},
      requiredExtensions: [],
      capabilityPolicy: {
        requiredCapabilities: ["create_binding", "resume_binding", "input_correlation", "provider_receipt", "reconcile", "interrupt"],
        allowedTools: ["invoke_agent", "send_to_session", "interrupt_session", "close_session"],
        permissionMode: "deny",
        maxConcurrentTurns: 1,
        maxNativeChildren: 0,
      },
    },
    {
      executionProfileId: "profile_worker",
      profileRevisionId: "profile_revision_journey-controlled-worker-v1",
      providerFamily: "codex",
      acpAgentKind: "codex_acp",
      protocolMajor: 1,
      model: "gpt-5.4",
      configIntent: {},
      requiredExtensions: [],
      capabilityPolicy: {
        requiredCapabilities: ["create_binding", "resume_binding", "input_correlation", "provider_receipt", "reconcile", "interrupt"],
        allowedTools: [],
        permissionMode: "deny",
        maxConcurrentTurns: 1,
        maxNativeChildren: 0,
      },
    },
    {
      executionProfileId: "profile_publisher",
      profileRevisionId: "profile_revision_journey-controlled-publisher-v1",
      providerFamily: "codex",
      acpAgentKind: "codex_acp",
      protocolMajor: 1,
      model: "gpt-5.4",
      configIntent: {},
      requiredExtensions: [],
      capabilityPolicy: {
        requiredCapabilities: ["create_binding", "resume_binding", "input_correlation", "provider_receipt", "reconcile", "interrupt"],
        allowedTools: [],
        permissionMode: "deny",
        maxConcurrentTurns: 1,
        maxNativeChildren: 0,
      },
    },
    {
      executionProfileId: "profile_reviewer",
      profileRevisionId: "profile_revision_journey-controlled-reviewer-v1",
      providerFamily: "codex",
      acpAgentKind: "codex_acp",
      protocolMajor: 1,
      model: "gpt-5.4",
      configIntent: {},
      requiredExtensions: [],
      capabilityPolicy: {
        requiredCapabilities: ["create_binding", "resume_binding", "input_correlation", "provider_receipt", "reconcile", "interrupt"],
        allowedTools: [],
        permissionMode: "deny",
        maxConcurrentTurns: 1,
        maxNativeChildren: 0,
      },
    },
  ],
  routingPolicy: { mode: "agent_loop", maxConcurrentInvocations: 3, maxDispatchesPerDecision: 4 },
  deliverables: [{ artifactPath: "reports/result.md", ownerAgentCardId: "agent_card_publisher" }],
});
const PINNED_SESSION_ID_TEMPLATE = JSON.stringify(PINNED_SESSION_ID_DEFINITION);

const ACP_TASK_J09_REOPEN_INTENT = [
  "Interrupt and reopen Researcher.",
  "First call interrupt_session on the current A1 and finish this planning turn.",
  "After the confirmed interrupt Notice, close A1, invoke Researcher to obtain A2,",
  "then call send_to_session once with the retired A1 ID and retain the expected",
  "orchestration_session_not_current rejection before proceeding to Publisher.",
].join(" ");

const ACP_TEMPLATE_META_REQUEST = [
  "Propose exactly one template_metadata_set operation that changes only the Template title to Deep Research · Meta reviewed.",
  "Preserve every other Template field verbatim, including every Agent prompt, profile, policy, and deliverable.",
  "This title-only operation is the entire requested patch: do not audit unchanged source fields, and return an empty validationIssues array when the operation itself is applicable.",
].join(" ");

const ACP_TASK_SETUP_META_REQUEST = [
  "Propose exactly one task_setup_goal_set operation that changes only the Task goal to Produce a reviewed report with explicit provenance.",
  "Preserve the title, selected Template Version, Workspace, and every Task input value.",
  "This goal-only operation is the entire requested patch: do not audit unchanged source fields, and return an empty validationIssues array when the operation itself is applicable.",
].join(" ");

const linearActions: readonly LocatorAction[] = Object.freeze([
  { checkpoint: "J-01", action: "expectVisible", target: testId("agent-loop-surface"), intentKind: "view.launch" },
  { checkpoint: "J-02", action: "click", target: testId("navigation-templates"), intentKind: "view.navigation.templates" },
  { checkpoint: "J-02", action: "click", target: testId("template-create"), intentKind: "view.template.create" },
  { checkpoint: "J-02", action: "fill", target: testId("template-title"), value: "Deep Research", intentKind: "view.template.edit" },
  { checkpoint: "J-02", action: "fill", target: testId("template-definition"), value: PINNED_SESSION_ID_TEMPLATE, intentKind: "view.template.definition" },
  { checkpoint: "J-02", action: "click", target: testId("template-save-draft"), intentKind: "template.create_draft", expectedHostCommands: 1 },
  { checkpoint: "J-02", action: "click", target: testId("template-meta-opener"), intentKind: "view.meta.open_panel" },
  { checkpoint: "J-02", action: "expectVisible", target: testId("meta-no-active-session"), intentKind: "view.meta.no_session" },
  { checkpoint: "J-02", action: "select", target: testId("meta-host-option"), value: "meta_profile_option_codex", intentKind: "view.meta.select_host" },
  { checkpoint: "J-02", action: "click", target: testId("meta-open-session"), intentKind: "meta.create_session", expectedHostCommands: 1 },
  { checkpoint: "J-02", action: "fill", target: testId("meta-composer"), value: "Refine this research template", intentKind: "view.meta.compose" },
  { checkpoint: "J-02", action: "click", target: testId("meta-send"), intentKind: "meta.send_message", expectedHostCommands: 1 },
  { checkpoint: "J-02", action: "click", target: testId("meta-apply-proposal"), intentKind: "meta.apply_patch", expectedHostCommands: 1 },
  { checkpoint: "J-02", action: "click", target: testId("meta-dock-toggle"), intentKind: "view.meta.dock" },
  { checkpoint: "J-02", action: "click", target: testId("meta-close"), intentKind: "view.meta.close" },
  { checkpoint: "J-02", action: "click", target: testId("template-meta-opener"), intentKind: "view.meta.reopen" },
  { checkpoint: "J-02", action: "expectVisible", target: testId("meta-active-session"), intentKind: "view.meta.resumed" },
  { checkpoint: "J-02", action: "click", target: testId("template-publish"), intentKind: "template.publish_draft", expectedHostCommands: 1 },
  { checkpoint: "J-03", action: "click", target: testId("navigation-tasks"), intentKind: "view.navigation.tasks" },
  { checkpoint: "J-03", action: "click", target: testId("task-setup-launcher-open"), intentKind: "view.task_setup.open" },
  { checkpoint: "J-03", action: "select", target: testId("task-setup-version"), value: "latest", intentKind: "view.task_setup.version" },
  { checkpoint: "J-03", action: "fill", target: testId("task-setup-workspace"), value: "workspace_journey", intentKind: "view.task_setup.workspace" },
  { checkpoint: "J-03", action: "fill", target: testId("task-setup-title"), value: "Deep Search", intentKind: "view.task_setup.title" },
  { checkpoint: "J-03", action: "fill", target: testId("task-setup-goal"), value: "Produce a reviewed report", intentKind: "view.task_setup.goal" },
  { checkpoint: "J-03", action: "click", target: testId("task-setup-save"), intentKind: "task_setup.create_draft", expectedHostCommands: 1 },
  { checkpoint: "J-03", action: "click", target: testId("task-setup-meta-opener"), intentKind: "view.task_setup_meta.open_panel" },
  { checkpoint: "J-03", action: "expectVisible", target: testId("meta-no-active-session"), intentKind: "view.task_setup_meta.no_session" },
  { checkpoint: "J-03", action: "select", target: testId("meta-host-option"), value: "meta_profile_option_codex", intentKind: "view.task_setup_meta.select_host" },
  { checkpoint: "J-03", action: "click", target: testId("meta-open-session"), intentKind: "meta.create_session", expectedHostCommands: 1 },
  { checkpoint: "J-03", action: "fill", target: testId("meta-composer"), value: "Refine the task inputs", intentKind: "view.meta.compose" },
  { checkpoint: "J-03", action: "click", target: testId("meta-send"), intentKind: "meta.send_message", expectedHostCommands: 1 },
  { checkpoint: "J-03", action: "click", target: testId("meta-apply-proposal"), intentKind: "meta.apply_patch", expectedHostCommands: 1 },
  { checkpoint: "J-03", action: "click", target: testId("meta-close"), intentKind: "view.meta.close" },
  { checkpoint: "J-03", action: "click", target: testId("task-setup-meta-opener"), intentKind: "view.task_setup_meta.reopen" },
  { checkpoint: "J-03", action: "click", target: testId("task-create"), intentKind: "task.create", expectedHostCommands: 1 },
  { checkpoint: "J-03", action: "expectVisible", target: testId("task-run-meta-absent"), intentKind: "view.task_run.meta_absent" },
  { checkpoint: "J-04", action: "click", target: testId("task-start"), intentKind: "task.start", expectedHostCommands: 1 },
  { checkpoint: "J-04", action: "expectVisible", target: testId("task-running"), intentKind: "view.task.running" },
  { checkpoint: "J-05", action: "expectVisible", target: testId("session-researcher-g1-waiting"), intentKind: "view.session.materialized" },
  { checkpoint: "J-06", action: "expectVisible", target: testId("session-researcher-final"), intentKind: "view.session.final" },
  { checkpoint: "J-07", action: "expectVisible", target: testId("session-reviewer-final"), intentKind: "view.session.reviewed" },
  { checkpoint: "J-08", action: "click", target: testId("session-tab-researcher-current"), intentKind: "view.session.select_researcher" },
  { checkpoint: "J-08", action: "fill", target: testId("card-composer-researcher"), value: "First direct message while idle", intentKind: "view.human.compose_idle" },
  { checkpoint: "J-08", action: "click", target: testId("card-send-idle-direct"), intentKind: "session.send_human_message", expectedHostCommands: 1 },
  { checkpoint: "J-08", action: "expectVisible", target: testId("human-message-idle-direct-delivered"), intentKind: "view.human.idle_direct_delivered" },
  { checkpoint: "J-08", action: "expectVisible", target: testId("session-researcher-busy-for-human-hold"), intentKind: "view.session.busy_for_human_hold" },
  { checkpoint: "J-08", action: "fill", target: testId("card-composer-researcher"), value: "Add the held human constraint", intentKind: "view.human.compose_held" },
  { checkpoint: "J-08", action: "click", target: testId("card-send-interrupt-first"), intentKind: "session.send_human_message", expectedHostCommands: 1 },
  { checkpoint: "J-08", action: "expectVisible", target: testId("human-message-held"), intentKind: "view.human.held" },
  { checkpoint: "J-09", action: "expectVisible", target: testId("human-message-delivered-turn"), intentKind: "view.human.turn_delivered" },
  { checkpoint: "J-09", action: "click", target: testId("session-interrupt-only"), intentKind: "session.request_interrupt", expectedHostCommands: 1 },
  { checkpoint: "J-09", action: "expectVisible", target: testId("interrupt-confirmed-notice"), intentKind: "view.interrupt.confirmed" },
  { checkpoint: "J-09", action: "expectVisible", target: testId("conductor-notice-followup-sent"), intentKind: "view.conductor.followup_sent" },
  { checkpoint: "J-09", action: "expectVisible", target: testId("session-researcher-busy-after-notice"), intentKind: "view.session.busy_after_notice" },
  { checkpoint: "J-09", action: "fill", target: testId("task-conductor-composer"), value: "Interrupt and reopen Researcher", intentKind: "view.conductor.compose" },
  { checkpoint: "J-09", action: "click", target: testId("task-conductor-send"), intentKind: "task.submit_input", expectedHostCommands: 1 },
  { checkpoint: "J-09", action: "expectVisible", target: testId("conductor-planning-fence-advanced"), intentKind: "view.conductor.fence_advanced" },
  { checkpoint: "J-09", action: "expectVisible", target: testId("conductor-session-interrupt-accepted"), intentKind: "view.conductor.interrupt_accepted" },
  { checkpoint: "J-09", action: "expectVisible", target: testId("conductor-interrupt-confirmed-notice"), intentKind: "view.conductor.interrupt_confirmed" },
  { checkpoint: "J-09", action: "expectVisible", target: testId("session-researcher-g1-readonly"), intentKind: "view.session.g1_readonly" },
  { checkpoint: "J-09", action: "expectVisible", target: testId("session-researcher-g2-current"), intentKind: "view.session.g2_current" },
  { checkpoint: "J-10", action: "expectVisible", target: testId("task-before-host-restart"), intentKind: "view.task.before_restart" },
  { checkpoint: "J-10", action: "expectVisible", target: testId("task-recovered"), intentKind: "view.task.recovered" },
  { checkpoint: "J-11", action: "expectVisible", target: testId("publisher-file-observed"), intentKind: "view.files.observed" },
  { checkpoint: "J-11", action: "click", target: testId("publisher-file-preview"), intentKind: "workspace.preview_file", expectedHostCommands: 1 },
  { checkpoint: "J-11", action: "click", target: testId("task-achieve-with-anchor"), intentKind: "task.achieve", expectedHostCommands: 1 },
  { checkpoint: "J-11", action: "expectVisible", target: testId("task-achieved-with-anchor"), intentKind: "view.task.achieved_with_anchor" },
  { checkpoint: "J-11", action: "click", target: testId("task-stop"), intentKind: "task.stop", expectedHostCommands: 1 },
  { checkpoint: "J-11", action: "expectVisible", target: testId("task-stopped"), intentKind: "view.task.stopped" },
]);

export const browserLinearScenario: LocatorActionScenario = Object.freeze({
  scenarioId: "scenario_browser-controlled-main",
  actions: Object.freeze(linearActions.map((action) => {
    if (action.checkpoint !== "J-11" || action.target.by !== "testId") return action;
    if (action.target.value === "task-achieve-with-anchor") {
      return Object.freeze({ ...action, target: testId("task-achieve-without-anchor") });
    }
    if (action.target.value === "task-achieved-with-anchor") {
      return Object.freeze({
        ...action,
        target: testId("task-achieved-without-anchor"),
        intentKind: "view.task.achieved_without_anchor",
      });
    }
    return action;
  })),
});

export const electronLinearScenario: LocatorActionScenario = Object.freeze({
  scenarioId: "scenario_electron-controlled-main",
  actions: linearActions,
});

export const crossSurfaceBrowserScenario: LocatorActionScenario = Object.freeze({
  scenarioId: "scenario_cross-surface-continuity",
  actions: Object.freeze([
    ...linearActions.filter(({ checkpoint }) => ["J-01", "J-02", "J-03", "J-04", "J-05", "J-06"].includes(checkpoint)),
    { checkpoint: "J-12", action: "expectVisible", target: testId("task-before-host-restart"), intentKind: "view.cross_surface.browser_host_ready" } as const,
    { checkpoint: "J-12", action: "expectVisible", target: testId("task-cross-surface-lineage"), intentKind: "view.cross_surface.browser_lineage" } as const,
  ]),
});

export const crossSurfaceElectronScenario: LocatorActionScenario = Object.freeze({
  scenarioId: "scenario_cross-surface-continuity",
  actions: Object.freeze([
    { checkpoint: "J-12", action: "expectVisible", target: testId("task-cross-surface-restored"), intentKind: "view.cross_surface.restored" } as const,
    { checkpoint: "J-12", action: "expectVisible", target: testId("task-cross-surface-lineage"), intentKind: "view.cross_surface.lineage" } as const,
    ...linearActions.filter(({ checkpoint }) => ["J-07", "J-08", "J-09", "J-10", "J-11"].includes(checkpoint)),
  ]),
});

export type AcpTaskJourneyProviderFamily = "opencode" | "codex";

export type AcpTaskJourneyScenarios = Readonly<{
  browser: LocatorActionScenario;
  electron: LocatorActionScenario;
}>;

export function createAcpTaskJourneyScenarios(input: Readonly<{
  providerFamily: AcpTaskJourneyProviderFamily;
  model: string;
}>): AcpTaskJourneyScenarios {
  if (!/^[^\s\u0000-\u001f\u007f]{1,160}$/u.test(input.model)) {
    throw new Error("acp_task_journey_model_invalid");
  }
  const scenarioId = `scenario_${input.providerFamily}-acp-task`;
  const definition = JSON.stringify(createAcpTaskJourneyTemplateDefinition(input));
  return Object.freeze({
    browser: Object.freeze({
      scenarioId,
      actions: acpTaskActions(crossSurfaceBrowserScenario.actions, definition),
    }),
    electron: Object.freeze({
      scenarioId,
      actions: acpTaskActions(crossSurfaceElectronScenario.actions, definition),
    }),
  });
}

export function createAcpMetaJourneyScenario(input: Readonly<{
  metaProfileOptionId: string;
}>): LocatorActionScenario {
  if (!/^meta_profile_option_[A-Za-z0-9_-]{1,200}$/u.test(input.metaProfileOptionId)) {
    throw new Error("acp_meta_journey_profile_option_invalid");
  }
  return Object.freeze({
    scenarioId: "scenario_acp-meta",
    actions: Object.freeze(linearActions
      .filter((action) => ["J-02", "J-03"].includes(action.checkpoint))
      .filter(({ intentKind }) => intentKind !== "task.create" && intentKind !== "view.task_run.meta_absent")
      .map((action) => Object.freeze({
        ...action,
        ...(["view.meta.select_host", "view.task_setup_meta.select_host"].includes(action.intentKind)
          ? { value: input.metaProfileOptionId }
          : {}),
        ...(action.intentKind === "view.meta.compose" && action.checkpoint === "J-02"
          ? { value: ACP_TEMPLATE_META_REQUEST }
          : {}),
        ...(action.intentKind === "view.meta.compose" && action.checkpoint === "J-03"
          ? { value: ACP_TASK_SETUP_META_REQUEST }
          : {}),
      }))),
  });
}

/**
 * Exact portable v3 Task definition shared by the visible journey and the
 * release-parent production qualification child.  Keeping one builder makes
 * the four Host-issued profile revisions part of one frozen release input.
 */
export function createAcpTaskJourneyTemplateDefinition(input: Readonly<{
  providerFamily: AcpTaskJourneyProviderFamily;
  model: string;
}>) {
  const acpAgentKind = input.providerFamily === "opencode" ? "native_acp" : "codex_acp";
  return validateTemplateDefinitionV3({
    ...PINNED_SESSION_ID_DEFINITION,
    agentCards: PINNED_SESSION_ID_DEFINITION.agentCards.map((card) => card.agentCardId === "agent_card_publisher"
      ? {
          ...card,
          systemPrompt: [
            "Publish the reviewed result through the scoped workspace write tool and return one final.",
            "First attempt ../outside.md and continue only after the Host rejects that out-of-scope path.",
            "Then write the final report to reports/result.md.",
          ].join(" "),
        }
      : card),
    executionProfiles: PINNED_SESSION_ID_DEFINITION.executionProfiles.map((profile) => ({
      ...profile,
      profileRevisionId: acpTaskProfileRevision(input.providerFamily, profile.executionProfileId),
      providerFamily: input.providerFamily,
      acpAgentKind,
      model: input.model,
    })),
  });
}

function acpTaskProfileRevision(
  providerFamily: AcpTaskJourneyProviderFamily,
  executionProfileId: string,
): string {
  const role = (() => {
    switch (executionProfileId) {
      case "profile_conductor": return "conductor";
      case "profile_worker": return "worker";
      case "profile_reviewer": return "reviewer";
      case "profile_publisher": return "publisher";
      default: throw new Error("acp_task_journey_profile_unknown");
    }
  })();
  return `profile_revision_journey-${providerFamily}-acp-task-${role}-v1`;
}

function acpTaskActions(
  actions: readonly LocatorAction[],
  definition: string,
): readonly LocatorAction[] {
  return Object.freeze(actions
    .filter(({ intentKind }) => !intentKind.startsWith("meta.")
      && !intentKind.startsWith("view.meta.")
      && !intentKind.startsWith("view.task_setup_meta."))
    .map((action) => Object.freeze({
      ...action,
      ...(action.intentKind === "view.template.definition" ? { value: definition } : {}),
      ...(action.checkpoint === "J-09"
        && action.action === "fill"
        && action.target.by === "testId"
        && action.target.value === "task-conductor-composer"
        ? { value: ACP_TASK_J09_REOPEN_INTENT }
        : {}),
    })));
}

export const CONTROLLED_UI_BRANCH_CELL_MODES = Object.freeze([
  "j08-unknown",
  "j08-late-final",
  "j10-pending-lane",
  "j10-tool-result",
  "j10-provider-accepted",
  "j10-human-interrupting",
  "j10-final-before-inbox",
] as const);

export type ControlledUiBranchCellMode = typeof CONTROLLED_UI_BRANCH_CELL_MODES[number];

const BRANCH_SETUP_INTENTS = new Set([
  "view.launch",
  "view.navigation.templates",
  "view.template.create",
  "view.template.edit",
  "view.template.definition",
  "template.create_draft",
  "template.publish_draft",
  "view.meta.open_panel",
  "view.meta.no_session",
  "view.meta.select_host",
  "meta.create_session",
  "view.meta.compose",
  "meta.send_message",
  "meta.apply_patch",
  "view.meta.dock",
  "view.meta.close",
  "view.meta.reopen",
  "view.meta.resumed",
  "view.navigation.tasks",
  "view.task_setup.open",
  "view.task_setup.version",
  "view.task_setup.workspace",
  "view.task_setup.title",
  "view.task_setup.goal",
  "task_setup.create_draft",
  "view.task_setup_meta.open_panel",
  "view.task_setup_meta.no_session",
  "view.task_setup_meta.select_host",
  "view.task_setup_meta.reopen",
  "task.create",
  "view.task_run.meta_absent",
  "task.start",
  "view.task.running",
]);

/**
 * Isolated branch cells use the same production controls as the linear flow,
 * but every action belongs to the one verifier-declared J-08 or J-10 cell.
 */
export function controlledUiBranchScenario(
  surface: "browser" | "electron",
  cellMode: ControlledUiBranchCellMode,
): LocatorActionScenario {
  if (!CONTROLLED_UI_BRANCH_CELL_MODES.includes(cellMode)) throw new Error("controlled_ui_branch_cell_mode_invalid");
  const checkpoint = cellMode.startsWith("j08-") ? "J-08" as const : "J-10" as const;
  const setup = linearActions
    .filter(({ intentKind }) => BRANCH_SETUP_INTENTS.has(intentKind))
    .map((action) => Object.freeze({ ...action, checkpoint }));
  const actions = cellMode === "j08-unknown"
    ? j08UnknownActions()
    : cellMode === "j08-late-final"
      ? j08LateFinalActions()
      : j10Actions(cellMode);
  return Object.freeze({
    scenarioId: `scenario_${surface}-controlled-${cellMode}`,
    actions: Object.freeze([...setup, ...actions]),
  });
}

function j08HumanInterruptActions(): readonly LocatorAction[] {
  return Object.freeze([
    { checkpoint: "J-08", action: "expectVisible", target: testId("session-researcher-busy-for-human-hold"), intentKind: "view.branch.researcher_busy" },
    { checkpoint: "J-08", action: "click", target: testId("session-tab-researcher-current"), intentKind: "view.branch.select_researcher" },
    { checkpoint: "J-08", action: "fill", target: testId("card-composer-researcher"), value: "Apply the isolated human correction after interrupt settlement.", intentKind: "view.branch.compose_held" },
    { checkpoint: "J-08", action: "click", target: testId("card-send-interrupt-first"), intentKind: "session.send_human_message", expectedHostCommands: 1 },
    { checkpoint: "J-08", action: "expectVisible", target: testId("human-message-held"), intentKind: "view.branch.human_held" },
  ]);
}

function j08UnknownActions(): readonly LocatorAction[] {
  return Object.freeze([
    ...j08HumanInterruptActions(),
    { checkpoint: "J-08", action: "expectVisible", target: testId("interrupt-unknown-notice"), intentKind: "view.branch.interrupt_unknown" },
    { checkpoint: "J-08", action: "expectVisible", target: testId("task-before-host-restart"), intentKind: "view.task.before_restart" },
    { checkpoint: "J-08", action: "expectVisible", target: testId("task-recovered"), intentKind: "view.branch.unknown_recovered" },
    { checkpoint: "J-08", action: "expectVisible", target: testId("interrupt-unknown-notice"), intentKind: "view.branch.interrupt_unknown_recovered" },
    { checkpoint: "J-08", action: "expectVisible", target: testId("human-message-held"), intentKind: "view.branch.human_still_held" },
  ]);
}

function j08LateFinalActions(): readonly LocatorAction[] {
  return Object.freeze([
    ...j08HumanInterruptActions(),
    { checkpoint: "J-08", action: "expectVisible", target: testId("interrupt-confirmed-notice"), intentKind: "view.branch.interrupt_confirmed" },
    { checkpoint: "J-08", action: "expectVisible", target: testId("late-final-notice"), intentKind: "view.branch.late_final_notice" },
    { checkpoint: "J-08", action: "expectVisible", target: testId("session-researcher-final"), intentKind: "view.branch.late_final" },
  ]);
}

function j10Actions(cellMode: Exclude<ControlledUiBranchCellMode, `j08-${string}`>): readonly LocatorAction[] {
  const beforeRestart: LocatorAction = {
    checkpoint: "J-10",
    action: "expectVisible",
    target: testId("task-before-host-restart"),
    intentKind: "view.task.before_restart",
  };
  const recovered: LocatorAction = {
    checkpoint: "J-10",
    action: "expectVisible",
    target: testId("task-recovered"),
    intentKind: "view.branch.task_recovered",
  };
  if (cellMode === "j10-pending-lane") return Object.freeze([
    { checkpoint: "J-10", action: "fill", target: testId("task-conductor-composer"), value: "Recover this pending Conductor lane.", intentKind: "view.branch.compose_pending_lane" },
    { checkpoint: "J-10", action: "click", target: testId("task-conductor-send"), intentKind: "task.submit_input", expectedHostCommands: 1 },
    beforeRestart,
    recovered,
    { checkpoint: "J-10", action: "expectVisible", target: testId("session-researcher-g1-waiting"), intentKind: "view.branch.pending_lane_recovered" },
  ]);
  if (cellMode === "j10-tool-result") return Object.freeze([
    { checkpoint: "J-10", action: "expectVisible", target: testId("session-researcher-g1-waiting"), intentKind: "view.branch.tool_result_committed" },
    beforeRestart,
    recovered,
    { checkpoint: "J-10", action: "expectVisible", target: testId("session-researcher-g1-waiting"), intentKind: "view.branch.tool_result_not_duplicated" },
  ]);
  if (cellMode === "j10-provider-accepted") return Object.freeze([
    beforeRestart,
    recovered,
    { checkpoint: "J-10", action: "expectVisible", target: testId("session-researcher-final"), intentKind: "view.branch.accepted_effect_recovered" },
  ]);
  if (cellMode === "j10-human-interrupting") return Object.freeze([
    { checkpoint: "J-10", action: "expectVisible", target: testId("session-researcher-busy-for-human-hold"), intentKind: "view.branch.researcher_busy" },
    { checkpoint: "J-10", action: "click", target: testId("session-tab-researcher-current"), intentKind: "view.branch.select_researcher" },
    { checkpoint: "J-10", action: "fill", target: testId("card-composer-researcher"), value: "Apply the crash-safe held human correction.", intentKind: "view.branch.compose_held" },
    { checkpoint: "J-10", action: "click", target: testId("card-send-interrupt-first"), intentKind: "session.send_human_message", expectedHostCommands: 1 },
    { checkpoint: "J-10", action: "expectVisible", target: testId("human-message-held"), intentKind: "view.branch.human_held" },
    beforeRestart,
    recovered,
    { checkpoint: "J-10", action: "expectVisible", target: testId("human-message-delivered-turn"), intentKind: "view.branch.human_interrupt_recovered" },
  ]);
  return Object.freeze([
    beforeRestart,
    recovered,
    { checkpoint: "J-10", action: "expectVisible", target: testId("publisher-file-observed"), intentKind: "view.branch.final_before_inbox_recovered" },
  ]);
}

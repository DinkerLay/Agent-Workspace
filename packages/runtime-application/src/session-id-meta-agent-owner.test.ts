import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  AcpMetaAgentPort,
  AcpMetaAgentTurnRequest,
  MetaAgentTurnReconciliation,
} from "@agent-workspace/provider-port";
import {
  hashDefinition,
  isMetaProfileDefinitionV3,
  type AcpProfileReadinessObservation,
  type ExecutionProfileDefinitionV3,
  type MetaProfileDefinitionV3,
  type MetaProfileOptionDefinitionV3,
  type MetaSessionRecord,
  type MetaSessionRecordV3,
  type TemplateDraftRecord,
} from "@agent-workspace/runtime-contracts";
import {
  appendMetaMessage,
  createMetaSessionV3,
  createTaskSetupDraft,
  createTemplateDraft,
  META_AGENT_OUTPUT_SCHEMA,
} from "@agent-workspace/runtime-domain";
import {
  createRuntimeRepositories,
  SqliteRuntimeStore,
  type AcpMetaTurnRecordV3,
} from "@agent-workspace/runtime-store";
import { afterEach, describe, expect, it } from "vitest";
import {
  BUILT_IN_DEEPSEARCH_TEMPLATE_VERSION_ID,
  installBuiltInTemplates,
} from "./built-in-templates.js";
import { createAcpMetaAgentRegistry } from "./meta-agent.js";
import {
  sessionIdMetaSystemInstructions,
  sessionIdMetaTargetContext,
} from "./session-id-configuration-task-lifecycle.js";
import { createSessionIdMetaAgentOwner } from "./session-id-meta-agent-owner.js";
import { createSessionIdMetaTemplateToolOwner } from "./session-id-meta-template-tool-owner.js";

const roots: string[] = [];
const NOW = "2026-08-12T02:00:00.000Z";

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Session-ID ACP Meta owner", () => {
  it("fresh-probes once, reuses one session, and reconciles accepted/absent/unknown without resending", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "agent-workspace-acp-meta-owner-"));
    roots.push(root);
    const databasePath = path.join(root, "runtime.sqlite");
    let store = new SqliteRuntimeStore({ path: databasePath });
    let repositories = createRuntimeRepositories(store);
    prepareTurn(repositories);

    const firstPort = new ControlledMetaPort(META_OPTION, { state: "absent" });
    const firstOwner = createSessionIdMetaAgentOwner({
      now: monotonicNow("2026-08-12T02:01:00.000Z"),
      createId: () => "agent_card_meta-owner",
      configuration: repositories.configuration,
      templates: repositories.templateTask,
      metaAgents: createAcpMetaAgentRegistry([{ option: META_OPTION, port: firstPort }]),
      resolveMetaProfileOption: resolveOption,
    });

    expect(await firstOwner.drain(1)).toBe(1);
    expect(firstPort.events).toEqual(["probe", "open", "start"]);
    expect(repositories.configuration.getMetaTurn(META_TURN_ID)).toMatchObject({
      status: "provider_accepted",
      attempts: 1,
    });
    expect(firstPort.requests).toHaveLength(1);
    assertConfigurationOnlyRequest(firstPort.requests[0]!);

    expect(await firstOwner.drain(1)).toBe(1);
    expect(firstPort.events).toEqual(["probe", "open", "start", "reconcile"]);
    expect(firstPort.events.filter((event) => event === "open")).toHaveLength(1);
    expect(firstPort.events.filter((event) => event === "start")).toHaveLength(1);
    expect(repositories.configuration.getMetaTurn(META_TURN_ID)).toMatchObject({
      status: "ambiguous",
      attempts: 2,
      failureCode: "meta_provider_reconciliation_absent",
    });
    store.close();

    store = new SqliteRuntimeStore({ path: databasePath });
    repositories = createRuntimeRepositories(store);
    const recoveredPort = new ControlledMetaPort(META_OPTION, { state: "unknown" }, "resume");
    const recoveredOwner = createSessionIdMetaAgentOwner({
      now: monotonicNow("2026-08-12T02:03:00.000Z"),
      createId: () => "agent_card_meta-owner",
      configuration: repositories.configuration,
      templates: repositories.templateTask,
      metaAgents: createAcpMetaAgentRegistry([{ option: META_OPTION, port: recoveredPort }]),
      resolveMetaProfileOption: resolveOption,
    });

    expect(await recoveredOwner.drain(1)).toBe(1);
    expect(recoveredPort.events).toEqual(["open", "reconcile"]);
    expect(recoveredPort.requests).toHaveLength(1);
    expect(repositories.configuration.getMetaTurn(META_TURN_ID)).toMatchObject({
      status: "ambiguous",
      attempts: 3,
      failureCode: "meta_provider_reconciliation_unknown",
    });
    store.close();
  });

  it("fails before any ACP effect when the option resolves to another frozen revision", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "agent-workspace-acp-meta-owner-drift-"));
    roots.push(root);
    const store = new SqliteRuntimeStore({ path: path.join(root, "runtime.sqlite") });
    const repositories = createRuntimeRepositories(store);
    prepareTurn(repositories);
    const port = new ControlledMetaPort(META_OPTION, { state: "absent" });
    const driftedOption = option("drifted");
    const owner = createSessionIdMetaAgentOwner({
      now: monotonicNow("2026-08-12T02:05:00.000Z"),
      createId: () => "agent_card_meta-owner",
      configuration: repositories.configuration,
      templates: repositories.templateTask,
      metaAgents: createAcpMetaAgentRegistry([{ option: META_OPTION, port }]),
      resolveMetaProfileOption: () => driftedOption,
    });

    expect(await owner.drain(1)).toBe(1);
    expect(port.events).toEqual([]);
    expect(repositories.configuration.getMetaTurn(META_TURN_ID)).toMatchObject({
      status: "failed",
      failureCode: "meta_session_profile_snapshot_mismatch",
    });
    store.close();
  });

  it("rejects a Template proposal whose operations were authored without the scoped MCP tools", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "agent-workspace-acp-meta-owner-tool-required-"));
    roots.push(root);
    const store = new SqliteRuntimeStore({ path: path.join(root, "runtime.sqlite") });
    const repositories = createRuntimeRepositories(store);
    prepareTemplateTurn(repositories);
    const finalText = JSON.stringify({
      assistantMessage: "Prepared a direct edit.",
      proposal: {
        operations: [{
          kind: "template_metadata_set",
          field: "description",
          value: "Directly authored without a tool call.",
        }],
        summary: "Direct edit.",
        rationale: "This must be rejected.",
        validationIssues: [],
      },
    });
    const port = new ControlledMetaPort(META_OPTION, {
      state: "returned",
      finalText,
      observedAt: "2026-08-12T02:08:00.000Z",
    }, "create", "template_design");
    const owner = createSessionIdMetaAgentOwner({
      now: monotonicNow("2026-08-12T02:07:00.000Z"),
      createId: () => "agent_card_not-used",
      configuration: repositories.configuration,
      templates: repositories.templateTask,
      metaAgents: createAcpMetaAgentRegistry([{ option: META_OPTION, port }]),
      resolveMetaProfileOption: resolveOption,
      templateDraftTools: createSessionIdMetaTemplateToolOwner({
        templates: repositories.templateTask,
        toolOperations: repositories.configuration,
      }),
    });

    expect(await owner.drain(1)).toBe(1);
    expect(await owner.drain(1)).toBe(1);
    expect(repositories.configuration.getMetaTurn(META_TURN_ID)).toMatchObject({
      status: "failed",
      failureCode: "meta_template_tool_operation_required",
    });
    expect(repositories.configuration.getMetaPatchProposal("meta_patch_proposal_meta-owner")).toBeUndefined();
    store.close();
  });

  it("replaces proposal-local Card refs with Runtime-owned identities before persisting the Proposal", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "agent-workspace-acp-meta-owner-card-create-"));
    roots.push(root);
    const store = new SqliteRuntimeStore({ path: path.join(root, "runtime.sqlite") });
    const repositories = createRuntimeRepositories(store);
    prepareTemplateTurn(repositories);
    const finalText = JSON.stringify({
      assistantMessage: "Prepared one additional independent search card.",
      proposal: {
        operations: [
          {
            kind: "template_card_create",
            proposalRef: "search_2",
            cardKind: "researcher",
            title: "Search Agent 2",
            executionProfileId: "profile_deepsearch-researcher",
            systemPrompt: "Research one independent evidence branch.",
            dispatchProfile: { title: "Independent search 2", description: "Use for a second parallel search branch." },
          },
          {
            kind: "template_card_reorder",
            cardRefs: [
              "agent_card_deepsearch-researcher",
              "search_2",
              "agent_card_deepsearch-reviewer",
              "agent_card_deepsearch-publisher",
            ],
          },
        ],
        summary: "Add one independent search card.",
        rationale: "The branch remains separately reviewable.",
        validationIssues: [],
      },
    });
    const port = new ControlledMetaPort(META_OPTION, {
      state: "returned",
      finalText,
      observedAt: "2026-08-12T02:10:00.000Z",
    }, "create", "template_design");
    const allocatedKinds: string[] = [];
    const templateDraftTools = await templateToolsWithOperations(repositories, [{
      name: "template_draft_create_card",
      arguments: {
        proposalRef: "search_2",
        cardKind: "researcher",
        title: "Search Agent 2",
        executionProfileId: "profile_deepsearch-researcher",
        systemPrompt: "Research one independent evidence branch.",
        dispatchProfile: { title: "Independent search 2", description: "Use for a second parallel search branch." },
      },
    }, {
      name: "template_draft_reorder_cards",
      arguments: {
        cardRefs: [
          "agent_card_deepsearch-researcher",
          "search_2",
          "agent_card_deepsearch-reviewer",
          "agent_card_deepsearch-publisher",
        ],
      },
    }]);
    const owner = createSessionIdMetaAgentOwner({
      now: monotonicNow("2026-08-12T02:09:00.000Z"),
      createId(kind) {
        allocatedKinds.push(kind);
        return "agent_card_runtime-allocated";
      },
      configuration: repositories.configuration,
      templates: repositories.templateTask,
      metaAgents: createAcpMetaAgentRegistry([{ option: META_OPTION, port }]),
      resolveMetaProfileOption: resolveOption,
      templateDraftTools,
    });

    expect(await owner.drain(1)).toBe(1);
    expect(await owner.drain(1)).toBe(1);
    expect(allocatedKinds).toEqual(["agent_card"]);
    expect(repositories.configuration.getMetaPatchProposal("meta_patch_proposal_meta-owner")).toMatchObject({
      validationIssues: [],
      operations: [
        expect.objectContaining({
          kind: "template_card_create",
          agentCardId: "agent_card_runtime-allocated",
          title: "Search Agent 2",
        }),
        {
          kind: "template_card_reorder",
          agentCardIds: [
            "agent_card_deepsearch-researcher",
            "agent_card_runtime-allocated",
            "agent_card_deepsearch-reviewer",
            "agent_card_deepsearch-publisher",
          ],
        },
      ],
    });
    expect(JSON.stringify(repositories.configuration.getMetaPatchProposal("meta_patch_proposal_meta-owner"))).not.toContain("proposalRef");
    store.close();
  });

  it("materializes a Host-issued Profile revision and never accepts Provider-authored config intent", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "agent-workspace-acp-meta-owner-profile-"));
    roots.push(root);
    const store = new SqliteRuntimeStore({ path: path.join(root, "runtime.sqlite") });
    const repositories = createRuntimeRepositories(store);
    prepareTemplateTurn(repositories);
    const source = repositories.templateTask.getDraft("template_draft_meta-owner")!
      .definition.executionProfiles.find((profile) => profile.executionProfileId === "profile_deepsearch-reviewer")!;
    if (!("profileRevisionId" in source)) throw new Error("test_expected_v3_profile");
    const selected = {
      ...source,
      profileRevisionId: "profile_revision_deepsearch-reviewer-xhigh",
      configIntent: { reasoningEffort: "xhigh" },
    };
    const port = new ControlledMetaPort(META_OPTION, {
      state: "returned",
      finalText: JSON.stringify({
        assistantMessage: "Selected the Host-issued xhigh Reviewer profile.",
        proposal: {
          operations: [{
            kind: "template_profile_revision_select",
            executionProfileId: source.executionProfileId,
            profileRevisionId: selected.profileRevisionId,
          }],
          summary: "Increase Reviewer effort.",
          rationale: "The user requested deeper review reasoning.",
          validationIssues: [],
        },
      }),
      observedAt: "2026-08-12T02:20:00.000Z",
    }, "create", "template_design");
    const templateDraftTools = await templateToolsWithOperations(repositories, [{
      name: "template_draft_select_profile",
      arguments: {
        executionProfileId: source.executionProfileId,
        profileRevisionId: selected.profileRevisionId,
      },
    }], ({ executionProfileId }) => executionProfileId === source.executionProfileId
      ? [source, selected]
      : []);
    const owner = createSessionIdMetaAgentOwner({
      now: monotonicNow("2026-08-12T02:19:00.000Z"),
      createId: () => "agent_card_not-used",
      configuration: repositories.configuration,
      templates: repositories.templateTask,
      metaAgents: createAcpMetaAgentRegistry([{ option: META_OPTION, port }]),
      resolveMetaProfileOption: resolveOption,
      templateDraftTools,
      resolveTemplateProfileRevision(input) {
        expect(input.executionProfileId).toBe(source.executionProfileId);
        expect(input.profileRevisionId).toBe(selected.profileRevisionId);
        return selected;
      },
    });

    expect(await owner.drain(1)).toBe(1);
    expect(await owner.drain(1)).toBe(1);
    expect(repositories.configuration.getMetaPatchProposal("meta_patch_proposal_meta-owner"))
      .toMatchObject({
        validationIssues: [],
        operations: [{
          kind: "template_profile_revision_set",
          executionProfileId: source.executionProfileId,
          profile: {
            profileRevisionId: selected.profileRevisionId,
            configIntent: { reasoningEffort: "xhigh" },
          },
        }],
      });
    store.close();
  });
});

function prepareTemplateTurn(repositories: ReturnType<typeof createRuntimeRepositories>): void {
  installBuiltInTemplates(repositories, NOW);
  const version = repositories.templateTask.getTemplateVersion(BUILT_IN_DEEPSEARCH_TEMPLATE_VERSION_ID)!;
  const draft = createTemplateDraft({
    templateDraftId: "template_draft_meta-owner",
    templateId: version.templateId,
    baseTemplateVersionId: version.templateVersionId,
    metadata: { title: "Deepsearch structure draft", slug: "deepsearch-structure-draft" },
    definition: version.definition,
    ownerId: "user_meta-owner",
    now: NOW,
  });
  repositories.templateTask.createDraft(draft);
  const initial = createMetaSessionV3({
    metaSessionId: "meta_session_meta-owner",
    ownerId: draft.ownerId,
    target: { kind: "template_draft", templateDraftId: draft.templateDraftId },
    metaProfileOptionId: META_OPTION.metaProfileOptionId,
    metaProfile: META_OPTION.profile,
    now: NOW,
  });
  repositories.configuration.createMetaSession(initial);
  const appended = appendMetaMessage({
    session: initial,
    metaMessageId: "meta_message_meta-user",
    expectedSessionRevision: initial.revision,
    role: "user",
    content: "Add one independent search card.",
    now: "2026-08-12T02:00:02.000Z",
  });
  const context = sessionIdMetaTargetContext(initial, draft.revision, repositories.templateTask, repositories.configuration);
  const systemInstructions = sessionIdMetaSystemInstructions(initial.mode);
  const turn: AcpMetaTurnRecordV3 = {
    metaTurnId: META_TURN_ID,
    metaSessionId: initial.metaSessionId,
    commandId: "command_meta-owner-send",
    idempotencyKey: "meta-owner-send",
    userMetaMessageId: appended.message.metaMessageId,
    assistantMetaMessageId: "meta_message_meta-owner-assistant",
    metaPatchProposalId: "meta_patch_proposal_meta-owner",
    profile: initial.metaProfile,
    mode: initial.mode,
    targetRevision: draft.revision,
    systemInstructions,
    systemInstructionsDigest: hashDefinition(systemInstructions),
    outputSchema: META_AGENT_OUTPUT_SCHEMA,
    outputSchemaDigest: hashDefinition(META_AGENT_OUTPUT_SCHEMA),
    context,
    contextDigest: hashDefinition(context),
    status: "pending",
    attempts: 0,
    createdAt: appended.message.createdAt,
    updatedAt: appended.message.createdAt,
  };
  repositories.configuration.createMetaMessageAndTurn({
    session: requiredV3Session(appended.session),
    expectedSessionRevision: initial.revision,
    userMessage: appended.message,
    turn,
  });
}

function prepareTurn(repositories: ReturnType<typeof createRuntimeRepositories>): void {
  installBuiltInTemplates(repositories, NOW);
  const version = repositories.templateTask.getTemplateVersion(BUILT_IN_DEEPSEARCH_TEMPLATE_VERSION_ID)!;
  repositories.workspace.createAuthorization({
    workspaceId: "workspace_meta-owner",
    canonicalDirectory: "/host/private/workspace-must-not-enter-request",
    displayName: "Meta owner fixture",
    authorizedAt: NOW,
  });
  const draft = createTaskSetupDraft({
    taskSetupDraftId: "task_setup_draft_meta-owner",
    ownerId: "user_meta-owner",
    templateVersionId: version.templateVersionId,
    workspaceId: "workspace_meta-owner",
    title: "Configuration title",
    goal: "Refine this configuration only.",
    schema: version.definition.taskInputSchema,
    taskInputValues: [],
    now: NOW,
  });
  repositories.configuration.createTaskSetupDraft(draft);
  const initial = createMetaSessionV3({
    metaSessionId: "meta_session_meta-owner",
    ownerId: draft.ownerId,
    target: { kind: "task_setup_draft", taskSetupDraftId: draft.taskSetupDraftId },
    metaProfileOptionId: META_OPTION.metaProfileOptionId,
    metaProfile: META_OPTION.profile,
    now: NOW,
  });
  repositories.configuration.createMetaSession(initial);
  const history = appendMetaMessage({
    session: initial,
    metaMessageId: "meta_message_meta-history",
    expectedSessionRevision: initial.revision,
    role: "assistant",
    content: "Previous configuration-only advice.",
    now: "2026-08-12T02:00:01.000Z",
  });
  repositories.transaction(() => {
    repositories.configuration.createMetaMessage(history.message);
    repositories.configuration.updateMetaSession(
      requiredV3Session(history.session),
      initial.revision,
    );
  });
  const current = requiredV3Session(history.session);
  const appended = appendMetaMessage({
    session: current,
    metaMessageId: "meta_message_meta-user",
    expectedSessionRevision: current.revision,
    role: "user",
    content: "Make the configuration goal more precise.",
    now: "2026-08-12T02:00:02.000Z",
  });
  const context = sessionIdMetaTargetContext(current, draft.revision, repositories.templateTask, repositories.configuration);
  const systemInstructions = sessionIdMetaSystemInstructions(current.mode);
  const turn: AcpMetaTurnRecordV3 = {
    metaTurnId: META_TURN_ID,
    metaSessionId: current.metaSessionId,
    commandId: "command_meta-owner-send",
    idempotencyKey: "meta-owner-send",
    userMetaMessageId: appended.message.metaMessageId,
    assistantMetaMessageId: "meta_message_meta-owner-assistant",
    metaPatchProposalId: "meta_patch_proposal_meta-owner",
    profile: current.metaProfile,
    mode: current.mode,
    targetRevision: draft.revision,
    systemInstructions,
    systemInstructionsDigest: hashDefinition(systemInstructions),
    outputSchema: META_AGENT_OUTPUT_SCHEMA,
    outputSchemaDigest: hashDefinition(META_AGENT_OUTPUT_SCHEMA),
    context,
    contextDigest: hashDefinition(context),
    status: "pending",
    attempts: 0,
    createdAt: appended.message.createdAt,
    updatedAt: appended.message.createdAt,
  };
  repositories.configuration.createMetaMessageAndTurn({
    session: requiredV3Session(appended.session),
    expectedSessionRevision: current.revision,
    userMessage: appended.message,
    turn,
  });
}

async function templateToolsWithOperations(
  repositories: ReturnType<typeof createRuntimeRepositories>,
  calls: readonly Readonly<{ name: string; arguments: unknown }>[],
  listTemplateProfileRevisions?: (input: Readonly<{
    draft: TemplateDraftRecord;
    executionProfileId: string;
  }>) => readonly ExecutionProfileDefinitionV3[],
) {
  const owner = createSessionIdMetaTemplateToolOwner({
    templates: repositories.templateTask,
    toolOperations: repositories.configuration,
    ...(listTemplateProfileRevisions ? { listTemplateProfileRevisions } : {}),
  });
  const draft = repositories.templateTask.getDraft("template_draft_meta-owner")!;
  const session = requiredV3Session(repositories.configuration.getMetaSession("meta_session_meta-owner")!);
  const context = owner.createTurnContext({
    session,
    metaTurnId: META_TURN_ID,
    targetRevision: draft.revision,
  });
  for (const [index, call] of calls.entries()) {
    await context.handleCall({
      providerCallId: `provider_call_meta-owner-${index}`,
      name: call.name,
      arguments: call.arguments,
      lease: context.lease,
    });
  }
  return owner;
}

class ControlledMetaPort implements AcpMetaAgentPort {
  readonly events: string[] = [];
  readonly requests: AcpMetaAgentTurnRequest[] = [];

  constructor(
    readonly option: MetaProfileOptionDefinitionV3,
    readonly reconciliation: MetaAgentTurnReconciliation,
    readonly expectedDisposition: "create" | "resume" = "create",
    readonly expectedSessionMode: "template_design" | "task_setup" = "task_setup",
  ) {}

  async checkMetaProfileReadiness(metaProfileOptionId: string): Promise<AcpProfileReadinessObservation> {
    expect(metaProfileOptionId).toBe(this.option.metaProfileOptionId);
    this.events.push("probe");
    return this.option.readiness;
  }

  async openMetaSession(input: Readonly<{
    metaSessionId: string;
    metaProfileOptionId: string;
    sessionMode: "template_design" | "task_setup";
    disposition: "create" | "resume";
  }>) {
    expect(input).toEqual({
      metaSessionId: "meta_session_meta-owner",
      metaProfileOptionId: this.option.metaProfileOptionId,
      sessionMode: this.expectedSessionMode,
      disposition: this.expectedDisposition,
    });
    this.events.push("open");
    return { available: true as const, readiness: this.option.readiness };
  }

  async startMetaTurn(request: AcpMetaAgentTurnRequest) {
    this.events.push("start");
    this.requests.push(request);
    return "accepted" as const;
  }

  async reconcileMetaTurn(request: AcpMetaAgentTurnRequest): Promise<MetaAgentTurnReconciliation> {
    this.events.push("reconcile");
    this.requests.push(request);
    return this.reconciliation;
  }
}

function assertConfigurationOnlyRequest(request: AcpMetaAgentTurnRequest): void {
  expect(request.transcript).toEqual([{
    metaMessageId: "meta_message_meta-history",
    role: "assistant",
    content: "Previous configuration-only advice.",
  }]);
  expect(request.content).toBe("Make the configuration goal more precise.");
  expect(request.context).toMatchObject({
    mode: "task_setup",
    targetRevision: 1,
    taskSetupDraft: {
      title: "Configuration title",
      goal: "Refine this configuration only.",
    },
  });
  const wire = JSON.stringify(request);
  for (const forbidden of [
    "taskId",
    "taskRunId",
    "taskTranscript",
    "workspaceId",
    "workspace-must-not-enter-request",
    '"cwd"',
    '"tools"',
    "providerSessionId",
    "acpSessionId",
    "nativeSessionId",
    "rawRequestId",
  ]) {
    expect(wire).not.toContain(forbidden);
  }
}

function requiredV3Session(session: ReturnType<typeof appendMetaMessage>["session"]): MetaSessionRecordV3 {
  if (!isV3Session(session)) throw new Error("test_expected_v3_meta_session");
  return session;
}

function isV3Session(session: MetaSessionRecord): session is MetaSessionRecordV3 {
  return isMetaProfileDefinitionV3(session.metaProfile);
}

function monotonicNow(start: string): () => string {
  let current = Date.parse(start);
  return () => new Date(current++).toISOString();
}

function resolveOption(metaProfileOptionId: string): MetaProfileOptionDefinitionV3 {
  if (metaProfileOptionId !== META_OPTION.metaProfileOptionId) throw new Error("meta_profile_option_not_found");
  return META_OPTION;
}

function option(suffix: string): MetaProfileOptionDefinitionV3 {
  const profile: MetaProfileDefinitionV3 = {
    metaProfileId: `meta_profile_${suffix}`,
    profileRevisionId: `profile_revision_meta-${suffix}`,
    providerFamily: "codex",
    acpAgentKind: "codex_acp",
    protocolMajor: 1,
    role: "meta",
    model: "gpt-5.6-sol",
    configIntent: { reasoningEffort: "high" },
    requiredExtensions: [],
    capabilityPolicy: {
      requiredCapabilities: [],
      allowedTools: [],
      permissionMode: "deny",
      maxConcurrentTurns: 1,
      maxNativeChildren: 0,
    },
  };
  return {
    metaProfileOptionId: `meta_profile_option_${suffix}`,
    title: `Meta ${suffix}`,
    profile,
    readiness: {
      profileRevisionId: profile.profileRevisionId,
      providerFamily: profile.providerFamily,
      acpAgentKind: profile.acpAgentKind,
      role: profile.role,
      status: "available",
      reasons: [],
      missingCapabilities: [],
      missingExtensions: [],
      model: profile.model,
      observedProtocolMajor: 1,
      observedAgent: { name: "codex-acp", version: "current" },
      observedCapabilities: [],
      observedExtensions: [],
    },
  };
}

const META_OPTION = option("owner");
const META_TURN_ID = "meta_turn_meta-owner";

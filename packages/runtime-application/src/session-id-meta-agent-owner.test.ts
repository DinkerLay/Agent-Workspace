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
  type MetaProfileDefinitionV3,
  type MetaProfileOptionDefinitionV3,
  type MetaSessionRecord,
  type MetaSessionRecordV3,
} from "@agent-workspace/runtime-contracts";
import {
  appendMetaMessage,
  createMetaSessionV3,
  createTaskSetupDraft,
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
});

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

class ControlledMetaPort implements AcpMetaAgentPort {
  readonly events: string[] = [];
  readonly requests: AcpMetaAgentTurnRequest[] = [];

  constructor(
    readonly option: MetaProfileOptionDefinitionV3,
    readonly reconciliation: MetaAgentTurnReconciliation,
    readonly expectedDisposition: "create" | "resume" = "create",
  ) {}

  async checkMetaProfileReadiness(metaProfileOptionId: string): Promise<AcpProfileReadinessObservation> {
    expect(metaProfileOptionId).toBe(this.option.metaProfileOptionId);
    this.events.push("probe");
    return this.option.readiness;
  }

  async openMetaSession(input: Readonly<{
    metaSessionId: string;
    metaProfileOptionId: string;
    disposition: "create" | "resume";
  }>) {
    expect(input).toEqual({
      metaSessionId: "meta_session_meta-owner",
      metaProfileOptionId: this.option.metaProfileOptionId,
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

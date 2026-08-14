import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  hashDefinition,
  type MetaPatchProposalRecordV3,
  type MetaMessageRecord,
  type MetaSessionRecordV3,
  type MetaProfileDefinitionV3,
  type TaskSetupDraftRecord,
  type JsonValue,
  type TemplateAssetRecord,
  type TemplateRecord,
  type TemplateVersionRecord,
  validateTemplateArchivePayload,
} from "@agent-workspace/runtime-contracts";
import { templatePackageFixture } from "@agent-workspace/test-kit";
import { afterEach, describe, expect, it } from "vitest";
import { createRuntimeRepositories, type AcpMetaTurnRecordV3 } from "./repositories.js";
import { SqliteRuntimeStore } from "./sqlite.js";

const paths: string[] = [];

afterEach(() => {
  for (const directory of paths.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("TemplateTaskStore template assets", () => {
  it("persists immutable binary assets, accepts an exact retry, and rejects a changed manifest", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "agent-workspace-template-assets-"));
    paths.push(directory);
    const store = new SqliteRuntimeStore({ path: path.join(directory, "runtime.sqlite") });
    const repositories = createRuntimeRepositories(store);
    const first = importInput(new Uint8Array([0, 255, 17, 34, 128]));

    expect(repositories.templateTask.importPackage(first.template, first.version, first.packageValue, first.assets)).toBe("created");
    const stored = repositories.templateTask.listTemplateAssets(first.version.templateVersionId);
    expect(stored).toHaveLength(1);
    expect([...stored[0]!.bytes]).toEqual([0, 255, 17, 34, 128]);
    expect(stored[0]!.bytes).not.toBe(first.assets[0]!.bytes);
    expect(repositories.templateTask.importPackage(first.template, first.version, first.packageValue, first.assets)).toBe("idempotent");

    const changed = importInput(new Uint8Array([0, 255, 17, 34, 129]));
    expect(() => repositories.templateTask.importPackage(
      changed.template,
      changed.version,
      changed.packageValue,
      changed.assets,
    )).toThrow("template_import_asset_manifest_conflict");
    store.close();
  });
});

function importInput(bytes: Uint8Array): {
  readonly template: TemplateRecord;
  readonly version: TemplateVersionRecord;
  readonly packageValue: ReturnType<typeof validateTemplateArchivePayload>["package"];
  readonly assets: readonly TemplateAssetRecord[];
} {
  const prepared = validateTemplateArchivePayload({
    package: templatePackageFixture(),
    assets: [{ path: "prompts/brief.bin", bytes, contentType: "application/octet-stream" }],
  });
  const now = "2026-08-06T00:00:00.000Z";
  const template: TemplateRecord = {
    templateId: prepared.package.template.templateId,
    slug: prepared.package.template.slug,
    title: prepared.package.template.title,
    activeVersionId: "template_version_assets",
    revision: 1,
    createdAt: now,
    updatedAt: now,
  };
  const version: TemplateVersionRecord = {
    templateVersionId: "template_version_assets",
    templateId: template.templateId,
    version: prepared.package.template.version,
    definition: prepared.package.definition,
    definitionHash: hashDefinition(prepared.package.definition as unknown as JsonValue),
    assetManifestHash: prepared.assetManifestHash,
    createdAt: now,
    publishedAt: now,
  };
  const manifestByPath = new Map(prepared.manifest.assets.map((asset) => [asset.path, asset] as const));
  const assets = prepared.assets.map((asset) => ({
    templateVersionId: version.templateVersionId,
    path: asset.path,
    ...(asset.contentType ? { contentType: asset.contentType } : {}),
    byteLength: asset.bytes.byteLength,
    contentDigest: manifestByPath.get(asset.path)!.contentDigest,
    bytes: Uint8Array.from(asset.bytes),
    createdAt: now,
  }));
  return { template, version, packageValue: prepared.package, assets };
}

const configurationNow = "2026-08-09T00:00:00.000Z";

const configurationMetaProfile: MetaProfileDefinitionV3 = {
  metaProfileId: "meta_profile_store",
  profileRevisionId: "profile_revision_meta-store",
  providerFamily: "codex",
  acpAgentKind: "codex_acp",
  protocolMajor: 1,
  role: "meta",
  model: "gpt-5.6",
  configIntent: {},
  requiredExtensions: [],
  capabilityPolicy: {
    requiredCapabilities: [],
    allowedTools: [],
    permissionMode: "deny",
    maxConcurrentTurns: 1,
    maxNativeChildren: 0,
  },
};

describe("WorkspaceAuthorizationStore", () => {
  it("persists one immutable canonical directory authority per workspace", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "agent-workspace-workspace-store-"));
    paths.push(directory);
    const store = new SqliteRuntimeStore({ path: path.join(directory, "runtime.sqlite") });
    const repositories = createRuntimeRepositories(store);
    const authorization = {
      workspaceId: "workspace_research",
      canonicalDirectory: "/canonical/research",
      displayName: "Research",
      authorizedAt: "2026-08-06T00:00:00.000Z",
    };

    expect(repositories.workspace.createAuthorization(authorization)).toEqual(authorization);
    expect(repositories.workspace.getAuthorization("workspace_research")).toEqual(authorization);
    expect(repositories.workspace.listAuthorizations()).toEqual([authorization]);
    expect(repositories.workspace.createAuthorization(authorization)).toEqual(authorization);
    expect(() => repositories.workspace.createAuthorization({ ...authorization, displayName: "Other" }))
      .toThrow("workspace_authorization_id_conflict");
    expect(() => repositories.workspace.createAuthorization({ ...authorization, workspaceId: "workspace_duplicate" }))
      .toThrow("workspace_directory_already_authorized");
    store.close();
  });
});

describe("ConfigurationStore", () => {
  it("persists isolated Meta/Task Setup records and revision-fences whole proposal transitions", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "agent-workspace-configuration-store-"));
    paths.push(directory);
    const databasePath = path.join(directory, "runtime.sqlite");
    let store = new SqliteRuntimeStore({ path: databasePath });
    let repositories = createRuntimeRepositories(store);
    const imported = importInput(new Uint8Array([4, 2]));
    repositories.templateTask.importPackage(imported.template, imported.version, imported.packageValue, imported.assets);
    repositories.workspace.createAuthorization({
      workspaceId: "workspace_configuration",
      canonicalDirectory: "/project/configuration",
      displayName: "Configuration",
      authorizedAt: configurationNow,
    });

    const taskSetupDraft: TaskSetupDraftRecord = {
      taskSetupDraftId: "task_setup_draft_store",
      ownerId: "user_1",
      templateVersionId: imported.version.templateVersionId,
      workspaceId: "workspace_configuration",
      title: "Configure task",
      goal: "Prove durable configuration state.",
      taskInputValues: [],
      state: "draft",
      revision: 1,
      createdAt: configurationNow,
      updatedAt: configurationNow,
    };
    repositories.configuration.createTaskSetupDraft(taskSetupDraft);

    const session: MetaSessionRecordV3 = {
      metaSessionId: "meta_session_store",
      ownerId: "user_1",
      mode: "task_setup",
      target: { kind: "task_setup_draft", taskSetupDraftId: taskSetupDraft.taskSetupDraftId },
      metaProfileOptionId: "meta_profile_option_store",
      metaProfile: configurationMetaProfile,
      state: "active",
      revision: 1,
      createdAt: configurationNow,
      updatedAt: configurationNow,
    };
    repositories.configuration.createMetaSession(session);
    const metaMessage: MetaMessageRecord = {
      metaMessageId: "meta_message_store",
      metaSessionId: session.metaSessionId,
      ownerId: session.ownerId,
      role: "user",
      content: "Please refine this setup.",
      contentDigest: hashDefinition("Please refine this setup."),
      createdAt: configurationNow,
    };
    repositories.configuration.createMetaMessage(metaMessage);

    const proposal: MetaPatchProposalRecordV3 = {
      metaPatchProposalId: "meta_patch_proposal_store",
      metaSessionId: session.metaSessionId,
      ownerId: "user_1",
      mode: "task_setup",
      target: session.target,
      sourceMetaProfileOptionId: session.metaProfileOptionId,
      sourceMetaProfile: configurationMetaProfile,
      sourceMetaSessionRevision: session.revision,
      targetRevision: 1,
      operations: [{ kind: "task_setup_goal_set", value: "Updated goal" }],
      summary: "Update the goal.",
      rationale: "Keep a focused acceptance target.",
      validationIssues: [],
      state: "pending",
      revision: 1,
      createdAt: configurationNow,
      updatedAt: configurationNow,
    };
    repositories.configuration.createMetaPatchProposal(proposal);

    expect(repositories.configuration.getTaskSetupDraft(taskSetupDraft.taskSetupDraftId)).toEqual(taskSetupDraft);
    expect(repositories.configuration.listTaskSetupDrafts()).toEqual([taskSetupDraft]);
    expect(repositories.configuration.getMetaSession(session.metaSessionId)).toEqual(session);
    expect(repositories.configuration.listMetaSessions()).toEqual([session]);
    expect(repositories.configuration.listMetaMessages(session.metaSessionId)).toEqual([metaMessage]);
    expect(repositories.configuration.getMetaPatchProposal(proposal.metaPatchProposalId)).toEqual(proposal);

    const applied = { ...proposal, state: "applied" as const, appliedTargetRevision: 2, revision: 2, updatedAt: "2026-08-09T00:01:00.000Z", resolvedAt: "2026-08-09T00:01:00.000Z" };
    repositories.configuration.updateMetaPatchProposal(applied, proposal.revision);
    expect(repositories.configuration.getMetaPatchProposal(proposal.metaPatchProposalId)).toEqual(applied);
    expect(() => repositories.configuration.updateMetaPatchProposal({ ...applied, revision: 3 }, 1))
      .toThrow("stale_meta_patch_proposal_revision");
    store.close();

    store = new SqliteRuntimeStore({ path: databasePath });
    repositories = createRuntimeRepositories(store);
    expect(repositories.configuration.getTaskSetupDraft(taskSetupDraft.taskSetupDraftId)).toEqual(taskSetupDraft);
    expect(repositories.configuration.getMetaSession(session.metaSessionId)).toEqual(session);
    expect(repositories.configuration.listMetaMessages(session.metaSessionId)).toEqual([metaMessage]);
    expect(repositories.configuration.getMetaPatchProposal(proposal.metaPatchProposalId)).toEqual(applied);
    store.close();
  });

  it("atomically queues, replays, leases, recovers and completes one Meta provider turn", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "agent-workspace-meta-turn-store-"));
    paths.push(directory);
    const databasePath = path.join(directory, "runtime.sqlite");
    let store = new SqliteRuntimeStore({ path: databasePath });
    let repositories = createRuntimeRepositories(store);
    const initialSession: MetaSessionRecordV3 = {
      metaSessionId: "meta_session_turn_store",
      ownerId: "user_1",
      mode: "task_setup",
      target: { kind: "task_setup_draft", taskSetupDraftId: "task_setup_draft_turns" },
      metaProfileOptionId: "meta_profile_option_store",
      metaProfile: configurationMetaProfile,
      state: "active",
      revision: 1,
      createdAt: configurationNow,
      updatedAt: configurationNow,
    };
    repositories.configuration.createMetaSession(initialSession);

    const queuedAt = "2026-08-09T00:01:00.000Z";
    const userMessage: MetaMessageRecord = {
      metaMessageId: "meta_message_turn_user",
      metaSessionId: initialSession.metaSessionId,
      ownerId: initialSession.ownerId,
      role: "user",
      content: "Make the research task more rigorous.",
      contentDigest: hashDefinition("Make the research task more rigorous."),
      createdAt: queuedAt,
    };
    const appendedSession: MetaSessionRecordV3 = {
      ...initialSession,
      revision: 2,
      updatedAt: queuedAt,
    };
    const systemInstructions = "Return a configuration-only patch proposal. Never execute the Task.";
    const outputSchema: JsonValue = {
      type: "object",
      required: ["assistantMessage"],
    };
    const context: JsonValue = {
      target: { title: "Research", goal: "Compare companies." },
      targetRevision: 1,
    };
    const turn: AcpMetaTurnRecordV3 = {
      metaTurnId: "meta_turn_store",
      metaSessionId: initialSession.metaSessionId,
      commandId: "command_meta_turn_store",
      idempotencyKey: "meta-turn-store-1",
      userMetaMessageId: userMessage.metaMessageId,
      assistantMetaMessageId: "meta_message_turn_assistant",
      metaPatchProposalId: "meta_patch_proposal_turn",
      profile: configurationMetaProfile,
      mode: initialSession.mode,
      targetRevision: 1,
      systemInstructions,
      systemInstructionsDigest: hashDefinition(systemInstructions),
      outputSchema,
      outputSchemaDigest: hashDefinition(outputSchema),
      context,
      contextDigest: hashDefinition(context),
      status: "pending",
      attempts: 0,
      createdAt: queuedAt,
      updatedAt: queuedAt,
    };
    const createInput = {
      session: appendedSession,
      expectedSessionRevision: initialSession.revision,
      userMessage,
      turn,
    };

    expect(repositories.configuration.createMetaMessageAndTurn(createInput)).toEqual(turn);
    // A transport retry reaches the identity fence before the now-advanced Session revision.
    expect(repositories.configuration.createMetaMessageAndTurn(createInput)).toEqual(turn);
    expect(repositories.configuration.listMetaMessages(initialSession.metaSessionId)).toEqual([userMessage]);
    expect(repositories.configuration.listMetaTurns(initialSession.metaSessionId)).toEqual([turn]);

    const changedContext: JsonValue = { ...context as Record<string, JsonValue>, targetRevision: 2 };
    expect(() => repositories.configuration.createMetaMessageAndTurn({
      ...createInput,
      turn: { ...turn, context: changedContext, contextDigest: hashDefinition(changedContext) },
    })).toThrow("meta_turn_identity_conflict");

    const blockedAt = "2026-08-09T00:01:30.000Z";
    const blockedUser: MetaMessageRecord = {
      ...userMessage,
      metaMessageId: "meta_message_turn_blocked",
      content: "This must not become a second active turn.",
      contentDigest: hashDefinition("This must not become a second active turn."),
      createdAt: blockedAt,
    };
    const blockedTurn: AcpMetaTurnRecordV3 = {
      ...turn,
      metaTurnId: "meta_turn_blocked",
      commandId: "command_meta_turn_blocked",
      idempotencyKey: "meta-turn-store-2",
      userMetaMessageId: blockedUser.metaMessageId,
      assistantMetaMessageId: "meta_message_turn_blocked_assistant",
      metaPatchProposalId: "meta_patch_proposal_turn_blocked",
      createdAt: blockedAt,
      updatedAt: blockedAt,
    };
    expect(() => repositories.configuration.createMetaMessageAndTurn({
      session: { ...appendedSession, revision: 3, updatedAt: blockedAt },
      expectedSessionRevision: appendedSession.revision,
      userMessage: blockedUser,
      turn: blockedTurn,
    })).toThrow("meta_turn_active");
    expect(repositories.configuration.getMetaMessage(blockedUser.metaMessageId)).toBeUndefined();

    const firstLease = repositories.configuration.claimMetaTurn(
      "2026-08-09T00:02:00.000Z",
      "2026-08-09T00:03:00.000Z",
    );
    expect(firstLease).toMatchObject({ status: "leased", attempts: 1, leasedFromStatus: "pending" });
    store.close();

    store = new SqliteRuntimeStore({ path: databasePath });
    repositories = createRuntimeRepositories(store);
    const recoveredLease = repositories.configuration.claimMetaTurn(
      "2026-08-09T00:04:00.000Z",
      "2026-08-09T00:05:00.000Z",
    );
    expect(recoveredLease).toMatchObject({ status: "leased", attempts: 2, leasedFromStatus: "pending" });
    expect(repositories.configuration.releaseMetaTurn(
      turn.metaTurnId,
      2,
      "2026-08-09T00:04:05.000Z",
    )).toMatchObject({ status: "pending", attempts: 2 });

    const sendingLease = repositories.configuration.claimMetaTurn(
      "2026-08-09T00:04:10.000Z",
      "2026-08-09T00:05:10.000Z",
    )!;
    expect(repositories.configuration.settleMetaTurn({
      metaTurnId: turn.metaTurnId,
      expectedAttempts: sendingLease.attempts,
      status: "provider_accepted",
      now: "2026-08-09T00:04:15.000Z",
    })).toMatchObject({ status: "provider_accepted", attempts: 3 });
    const reconciliationLease = repositories.configuration.claimMetaTurn(
      "2026-08-09T00:04:20.000Z",
      "2026-08-09T00:05:20.000Z",
    )!;
    expect(reconciliationLease).toMatchObject({ status: "leased", attempts: 4, leasedFromStatus: "provider_accepted" });

    expect(repositories.configuration.settleMetaTurn({
      metaTurnId: turn.metaTurnId,
      expectedAttempts: reconciliationLease.attempts,
      status: "ambiguous",
      failureCode: "meta_provider_reconciliation_unknown",
      now: "2026-08-09T00:04:21.000Z",
    })).toMatchObject({ status: "ambiguous", attempts: 4 });
    expect(repositories.configuration.claimMetaTurn(
      "2026-08-09T00:04:22.000Z",
      "2026-08-09T00:05:22.000Z",
    )).toBeUndefined();
    const boundedReconciliationLease = repositories.configuration.claimMetaTurn(
      "2026-08-09T00:04:29.000Z",
      "2026-08-09T00:05:29.000Z",
    )!;
    expect(boundedReconciliationLease).toMatchObject({
      status: "leased",
      attempts: 5,
      leasedFromStatus: "ambiguous",
    });

    const completedAt = "2026-08-09T00:04:30.000Z";
    const assistantMessage: MetaMessageRecord = {
      metaMessageId: turn.assistantMetaMessageId,
      metaSessionId: turn.metaSessionId,
      ownerId: initialSession.ownerId,
      role: "assistant",
      content: "I prepared a stricter research goal for your review.",
      contentDigest: hashDefinition("I prepared a stricter research goal for your review."),
      createdAt: completedAt,
    };
    const proposal: MetaPatchProposalRecordV3 = {
      metaPatchProposalId: turn.metaPatchProposalId,
      metaSessionId: turn.metaSessionId,
      ownerId: initialSession.ownerId,
      mode: turn.mode,
      target: initialSession.target,
      sourceMetaProfileOptionId: initialSession.metaProfileOptionId,
      sourceMetaProfile: configurationMetaProfile,
      sourceMetaSessionRevision: appendedSession.revision,
      targetRevision: turn.targetRevision,
      operations: [{ kind: "task_setup_goal_set", value: "Compare companies using cited primary evidence." }],
      summary: "Tighten the research goal.",
      rationale: "Primary evidence makes the result reviewable.",
      validationIssues: [],
      state: "pending",
      revision: 1,
      createdAt: completedAt,
      updatedAt: completedAt,
    };
    const completion = {
      metaTurnId: turn.metaTurnId,
      expectedAttempts: boundedReconciliationLease.attempts,
      session: { ...appendedSession, revision: 3, updatedAt: completedAt },
      expectedSessionRevision: appendedSession.revision,
      assistantMessage,
      proposal,
      completedAt,
    };
    expect(repositories.configuration.completeMetaTurn(completion)).toMatchObject({ status: "returned", attempts: 5 });
    expect(repositories.configuration.completeMetaTurn(completion)).toMatchObject({ status: "returned", attempts: 5 });
    expect(repositories.configuration.getMetaMessage(assistantMessage.metaMessageId)).toEqual(assistantMessage);
    expect(repositories.configuration.getMetaPatchProposal(proposal.metaPatchProposalId)).toEqual(proposal);

    store.close();
  });
});

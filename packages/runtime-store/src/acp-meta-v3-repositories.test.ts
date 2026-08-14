import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  hashDefinition,
  type JsonValue,
  type MetaMessageRecord,
  type MetaPatchProposalRecordV2,
  type MetaProfileDefinitionV2,
  type MetaProfileDefinitionV3,
  type MetaSessionRecordV2,
  type MetaSessionRecordV3,
} from "@agent-workspace/runtime-contracts";
import { afterEach, describe, expect, it } from "vitest";
import {
  createRuntimeRepositories,
  type AcpMetaTurnRecordV3,
  type MetaTurnRecord,
} from "./repositories.js";
import { encodeJson, SqliteRuntimeStore } from "./sqlite.js";

const roots: string[] = [];
const NOW = "2026-08-12T01:00:00.000Z";

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("durable ACP Meta v3 repositories", () => {
  it("reads exact v2 records without upgrading or dispatching them and fences every legacy writer", () => {
    const { store, repositories } = createStore("legacy-fence");
    const session = legacySession();
    const message = metaMessage(session, "meta_message_legacy-user", "legacy input");
    const proposal = legacyProposal(session);
    const turn = legacyTurn(session, message);
    const profileBytes = encodeJson(session.metaProfile);
    const proposalProfileBytes = encodeJson(proposal.sourceMetaProfile);
    insertRawSession(store, session, profileBytes);
    insertRawMessage(store, message);
    insertRawProposal(store, proposal, proposalProfileBytes);
    insertRawTurn(store, turn, encodeJson(turn.profile));

    expect(repositories.configuration.getMetaSession(session.metaSessionId)).toEqual(session);
    expect(repositories.configuration.getMetaPatchProposal(proposal.metaPatchProposalId)).toEqual(proposal);
    expect(repositories.configuration.getMetaTurn(turn.metaTurnId)).toEqual(turn);
    expect(repositories.configuration.claimMetaTurn(NOW, "2026-08-12T01:01:00.000Z")).toBeUndefined();

    const attemptedSession: MetaSessionRecordV2 = {
      metaSessionId: "meta_session_legacy-attempt",
      ownerId: session.ownerId,
      mode: "template_design",
      target: { kind: "template_draft", templateDraftId: "template_draft_legacy-attempt" },
      metaProfileOptionId: session.metaProfileOptionId,
      metaProfile: session.metaProfile,
      state: "active",
      revision: 1,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
    };
    expect(() => Reflect.apply(repositories.configuration.createMetaSession, undefined, [attemptedSession]))
      .toThrow("meta_profile_v2_read_only");
    expect(() => Reflect.apply(repositories.configuration.updateMetaSession, undefined, [
      { ...session, state: "abandoned", revision: 2, updatedAt: "2026-08-12T01:00:01.000Z" },
      1,
    ])).toThrow("meta_profile_v2_read_only");
    expect(() => repositories.configuration.createMetaMessage(metaMessage(
      session,
      "meta_message_legacy-attempt",
      "must not be appended",
    ))).toThrow("meta_profile_v2_read_only");
    expect(() => Reflect.apply(repositories.configuration.createMetaPatchProposal, undefined, [{
      ...proposal,
      metaPatchProposalId: "meta_patch_proposal_legacy-attempt",
    }])).toThrow("meta_profile_v2_read_only");
    expect(() => Reflect.apply(repositories.configuration.releaseMetaTurn, undefined, [
      turn.metaTurnId,
      turn.attempts,
      NOW,
    ])).toThrow("meta_profile_v2_read_only");

    expect(repositories.configuration.getMetaSession(attemptedSession.metaSessionId)).toBeUndefined();
    expect(repositories.configuration.getMetaMessage("meta_message_legacy-attempt")).toBeUndefined();
    expect(rawText(store, "meta_sessions", "meta_profile_json", "meta_session_id", session.metaSessionId)).toBe(profileBytes);
    expect(rawText(store, "meta_patch_proposals", "source_meta_profile_json", "meta_patch_proposal_id", proposal.metaPatchProposalId))
      .toBe(proposalProfileBytes);
    expect(rawText(store, "meta_turns", "status", "meta_turn_id", turn.metaTurnId)).toBe("pending");
    store.close();
  });

  it("replays and reopens v3 exactly while claim skips an older ready v2 turn", () => {
    const root = mkdtempSync(path.join(tmpdir(), "agent-workspace-acp-meta-reopen-"));
    roots.push(root);
    const databasePath = path.join(root, "runtime.sqlite");
    let store = new SqliteRuntimeStore({ path: databasePath });
    let repositories = createRuntimeRepositories(store);
    const legacy = legacySession();
    const legacyMessage = metaMessage(legacy, "meta_message_legacy-ready", "legacy ready input");
    const oldTurn = legacyTurn(legacy, legacyMessage);
    insertRawSession(store, legacy, encodeJson(legacy.metaProfile));
    insertRawMessage(store, legacyMessage);
    insertRawTurn(store, oldTurn, encodeJson(oldTurn.profile));

    const session = acpSession();
    repositories.configuration.createMetaSession(session);
    const createdAt = "2026-08-12T01:02:00.000Z";
    const userMessage = metaMessage(session, "meta_message_acp-user", "portable input", createdAt);
    const appendedSession: MetaSessionRecordV3 = { ...session, revision: 2, updatedAt: createdAt };
    const outputSchema: JsonValue = { type: "object", required: ["assistantMessage"] };
    const context: JsonValue = { target: { title: "Configuration only" }, targetRevision: 1 };
    const systemInstructions = "Return configuration-only JSON. Never execute a Task.";
    const turn: AcpMetaTurnRecordV3 = {
      metaTurnId: "meta_turn_acp-reopen",
      metaSessionId: session.metaSessionId,
      commandId: "command_acp-meta-reopen",
      idempotencyKey: "acp-meta-reopen",
      userMetaMessageId: userMessage.metaMessageId,
      assistantMetaMessageId: "meta_message_acp-assistant",
      metaPatchProposalId: "meta_patch_proposal_acp-reopen",
      profile: session.metaProfile,
      mode: session.mode,
      targetRevision: 1,
      systemInstructions,
      systemInstructionsDigest: hashDefinition(systemInstructions),
      outputSchema,
      outputSchemaDigest: hashDefinition(outputSchema),
      context,
      contextDigest: hashDefinition(context),
      status: "pending",
      attempts: 0,
      createdAt,
      updatedAt: createdAt,
    };
    const input = { session: appendedSession, expectedSessionRevision: 1, userMessage, turn };
    expect(repositories.configuration.createMetaMessageAndTurn(input)).toEqual(turn);
    expect(repositories.configuration.createMetaMessageAndTurn(input)).toEqual(turn);
    expect(repositories.configuration.claimMetaTurn(
      "2026-08-12T01:03:00.000Z",
      "2026-08-12T01:04:00.000Z",
    )).toMatchObject({ metaTurnId: turn.metaTurnId, status: "leased", attempts: 1 });
    const toolOperation: JsonValue = {
      kind: "template_metadata_set",
      field: "description",
      value: "Durably recorded by the Template MCP tool owner.",
    };
    expect(repositories.configuration.recordMetaTurnToolOperation({
      metaTurnId: turn.metaTurnId,
      targetRevision: turn.targetRevision,
      providerCallId: "provider_call_store-tool",
      operation: toolOperation,
    })).toEqual([toolOperation]);
    expect(repositories.configuration.recordMetaTurnToolOperation({
      metaTurnId: turn.metaTurnId,
      targetRevision: turn.targetRevision,
      providerCallId: "provider_call_store-tool",
      operation: toolOperation,
    })).toEqual([toolOperation]);
    expect(() => repositories.configuration.recordMetaTurnToolOperation({
      metaTurnId: turn.metaTurnId,
      targetRevision: turn.targetRevision,
      providerCallId: "provider_call_store-tool",
      operation: { ...toolOperation, value: "conflict" },
    })).toThrow("meta_turn_tool_call_conflict");
    expect(rawText(store, "meta_turns", "status", "meta_turn_id", oldTurn.metaTurnId)).toBe("pending");
    store.close();

    store = new SqliteRuntimeStore({ path: databasePath });
    repositories = createRuntimeRepositories(store);
    expect(repositories.configuration.getMetaSession(legacy.metaSessionId)).toEqual(legacy);
    expect(repositories.configuration.getMetaSession(session.metaSessionId)).toEqual(appendedSession);
    expect(repositories.configuration.listMetaTurnToolOperations(turn.metaTurnId)).toEqual([toolOperation]);
    expect(repositories.configuration.getMetaTurn(oldTurn.metaTurnId)).toEqual(oldTurn);
    expect(repositories.configuration.getMetaTurn(turn.metaTurnId)).toEqual({
      ...turn,
      status: "leased",
      attempts: 1,
      leaseUntil: "2026-08-12T01:04:00.000Z",
      leasedFromStatus: "pending",
      updatedAt: "2026-08-12T01:03:00.000Z",
    });
    expect(rawText(store, "meta_sessions", "meta_profile_json", "meta_session_id", legacy.metaSessionId))
      .toBe(encodeJson(legacy.metaProfile));
    store.close();
  });

  it("fails closed on a mixed v2/v3 durable snapshot without repairing its bytes", () => {
    const { store, repositories } = createStore("mixed-decode");
    const legacy = legacySession();
    const mixed = { ...legacy.metaProfile, profileRevisionId: "profile_revision_mixed-corruption" };
    const bytes = encodeJson(mixed);
    insertRawSession(store, legacy, bytes);

    expect(() => repositories.configuration.getMetaSession(legacy.metaSessionId))
      .toThrow("meta_profile_snapshot_schema_ambiguous");
    expect(rawText(store, "meta_sessions", "meta_profile_json", "meta_session_id", legacy.metaSessionId)).toBe(bytes);
    store.close();
  });
});

function createStore(suffix: string) {
  const root = mkdtempSync(path.join(tmpdir(), `agent-workspace-acp-meta-${suffix}-`));
  roots.push(root);
  const store = new SqliteRuntimeStore({ path: path.join(root, "runtime.sqlite") });
  return { store, repositories: createRuntimeRepositories(store) };
}

function legacyProfile(): MetaProfileDefinitionV2 {
  return {
    metaProfileId: "meta_profile_legacy_store",
    provider: "codex",
    model: "legacy-direct",
    providerVersion: "preserved",
    protocolFingerprint: "preserved",
    capabilityPolicy: {
      requiredCapabilities: [],
      allowedTools: [],
      permissionMode: "deny",
      maxConcurrentTurns: 1,
      maxNativeChildren: 0,
    },
  };
}

function acpProfile(): MetaProfileDefinitionV3 {
  return {
    metaProfileId: "meta_profile_acp-store",
    profileRevisionId: "profile_revision_meta-acp-store",
    providerFamily: "codex",
    acpAgentKind: "codex_acp",
    protocolMajor: 1,
    role: "meta",
    model: "gpt-5.6-sol",
    configIntent: { reasoningEffort: "high" },
    requiredExtensions: [],
    capabilityPolicy: legacyProfile().capabilityPolicy,
  };
}

function legacySession(): MetaSessionRecordV2 {
  return {
    metaSessionId: "meta_session_legacy-store",
    ownerId: "user_meta-store",
    mode: "template_design",
    target: { kind: "template_draft", templateDraftId: "template_draft_legacy-store" },
    metaProfileOptionId: "meta_profile_option_legacy-store",
    metaProfile: legacyProfile(),
    state: "active",
    revision: 1,
    createdAt: "2026-08-12T00:00:00.000Z",
    updatedAt: "2026-08-12T00:00:00.000Z",
  };
}

function acpSession(): MetaSessionRecordV3 {
  return {
    metaSessionId: "meta_session_acp-reopen",
    ownerId: "user_meta-store",
    mode: "template_design",
    target: { kind: "template_draft", templateDraftId: "template_draft_acp-store" },
    metaProfileOptionId: "meta_profile_option_acp-store",
    metaProfile: acpProfile(),
    state: "active",
    revision: 1,
    createdAt: "2026-08-12T01:01:00.000Z",
    updatedAt: "2026-08-12T01:01:00.000Z",
  };
}

function metaMessage(
  session: MetaSessionRecordV2 | MetaSessionRecordV3,
  metaMessageId: string,
  content: string,
  createdAt = session.createdAt,
): MetaMessageRecord {
  return {
    metaMessageId,
    metaSessionId: session.metaSessionId,
    ownerId: session.ownerId,
    role: "user",
    content,
    contentDigest: hashDefinition(content),
    createdAt,
  };
}

function legacyProposal(session: MetaSessionRecordV2): MetaPatchProposalRecordV2 {
  return {
    metaPatchProposalId: "meta_patch_proposal_legacy-store",
    metaSessionId: session.metaSessionId,
    ownerId: session.ownerId,
    mode: session.mode,
    target: session.target,
    sourceMetaProfileOptionId: session.metaProfileOptionId,
    sourceMetaProfile: session.metaProfile,
    sourceMetaSessionRevision: session.revision,
    targetRevision: 1,
    operations: [{ kind: "template_metadata_set", field: "title", value: "Legacy title" }],
    summary: "Preserved legacy proposal",
    rationale: "Read-only fixture",
    validationIssues: [],
    state: "pending",
    revision: 1,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
}

function legacyTurn(session: MetaSessionRecordV2, message: MetaMessageRecord): MetaTurnRecord {
  const outputSchema: JsonValue = { type: "object" };
  const context: JsonValue = { targetRevision: 1 };
  const systemInstructions = "Preserved historical direct Meta turn.";
  return {
    metaTurnId: "meta_turn_legacy-store",
    metaSessionId: session.metaSessionId,
    commandId: "command_legacy-meta-store",
    idempotencyKey: "legacy-meta-store",
    userMetaMessageId: message.metaMessageId,
    assistantMetaMessageId: "meta_message_legacy-assistant",
    metaPatchProposalId: "meta_patch_proposal_legacy-turn",
    profile: session.metaProfile,
    mode: session.mode,
    targetRevision: 1,
    systemInstructions,
    systemInstructionsDigest: hashDefinition(systemInstructions),
    outputSchema,
    outputSchemaDigest: hashDefinition(outputSchema),
    context,
    contextDigest: hashDefinition(context),
    status: "pending",
    attempts: 0,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
}

function insertRawSession(store: SqliteRuntimeStore, session: MetaSessionRecordV2, profileBytes: string): void {
  store.run(
    `INSERT INTO meta_sessions(
      meta_session_id, owner_id, mode, target_kind, target_id, meta_profile_option_id,
      meta_profile_json, state, revision, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    session.metaSessionId,
    session.ownerId,
    session.mode,
    session.target.kind,
    metaTargetId(session.target),
    session.metaProfileOptionId,
    profileBytes,
    session.state,
    session.revision,
    session.createdAt,
    session.updatedAt,
  );
}

function insertRawMessage(store: SqliteRuntimeStore, message: MetaMessageRecord): void {
  store.run(
    `INSERT INTO meta_messages(
      meta_message_id, meta_session_id, owner_id, role, content, content_digest, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    message.metaMessageId,
    message.metaSessionId,
    message.ownerId,
    message.role,
    message.content,
    message.contentDigest,
    message.createdAt,
  );
}

function insertRawProposal(
  store: SqliteRuntimeStore,
  proposal: MetaPatchProposalRecordV2,
  profileBytes: string,
): void {
  store.run(
    `INSERT INTO meta_patch_proposals(
      meta_patch_proposal_id, meta_session_id, owner_id, mode, target_kind, target_id,
      source_meta_profile_option_id, source_meta_profile_json, source_meta_session_revision,
      target_revision, operations_json, summary, rationale, validation_issues_json, state,
      applied_target_revision, revision, created_at, updated_at, resolved_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    proposal.metaPatchProposalId,
    proposal.metaSessionId,
    proposal.ownerId,
    proposal.mode,
    proposal.target.kind,
    metaTargetId(proposal.target),
    proposal.sourceMetaProfileOptionId,
    profileBytes,
    proposal.sourceMetaSessionRevision,
    proposal.targetRevision,
    encodeJson(proposal.operations),
    proposal.summary,
    proposal.rationale,
    encodeJson(proposal.validationIssues),
    proposal.state,
    null,
    proposal.revision,
    proposal.createdAt,
    proposal.updatedAt,
    null,
  );
}

function insertRawTurn(store: SqliteRuntimeStore, turn: MetaTurnRecord, profileBytes: string): void {
  store.run(
    `INSERT INTO meta_turns(
      meta_turn_id, meta_session_id, command_id, idempotency_key, user_meta_message_id,
      assistant_meta_message_id, meta_patch_proposal_id, profile_json, mode, target_revision,
      system_instructions, system_instructions_digest, output_schema_json, output_schema_digest,
      context_json, context_digest, status, attempts, lease_until, leased_from_status,
      failure_code, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    turn.metaTurnId,
    turn.metaSessionId,
    turn.commandId,
    turn.idempotencyKey,
    turn.userMetaMessageId,
    turn.assistantMetaMessageId,
    turn.metaPatchProposalId,
    profileBytes,
    turn.mode,
    turn.targetRevision,
    turn.systemInstructions,
    turn.systemInstructionsDigest,
    encodeJson(turn.outputSchema),
    turn.outputSchemaDigest,
    encodeJson(turn.context),
    turn.contextDigest,
    turn.status,
    turn.attempts,
    null,
    null,
    null,
    turn.createdAt,
    turn.updatedAt,
  );
}

function rawText(
  store: SqliteRuntimeStore,
  table: "meta_sessions" | "meta_patch_proposals" | "meta_turns",
  column: "meta_profile_json" | "source_meta_profile_json" | "status",
  idColumn: "meta_session_id" | "meta_patch_proposal_id" | "meta_turn_id",
  id: string,
): string {
  const row = store.one<Record<string, unknown>>(`SELECT ${column} FROM ${table} WHERE ${idColumn} = ?`, id);
  const value = row?.[column];
  if (typeof value !== "string") throw new Error("fixture_row_missing");
  return value;
}

function metaTargetId(
  target: MetaSessionRecordV2["target"],
): string {
  return target.kind === "template_draft" ? target.templateDraftId : target.taskSetupDraftId;
}

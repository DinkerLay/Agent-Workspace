import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  hashDefinition,
  type ArtifactReference,
  type MetaPatchProposalRecord,
  type MetaMessageRecord,
  type MetaSessionRecord,
  type MetaProfileDefinition,
  type TaskSetupDraftRecord,
  type InputSubmissionRecord,
  type InvocationRecord,
  type JsonValue,
  type ProviderFact,
  type RelayBlockRecord,
  type SessionInboxItemRecord,
  type SessionMessageRecord,
  type TemplateAssetRecord,
  type TemplateRecord,
  type TemplateVersionRecord,
  validateTemplateArchivePayload,
} from "@agent-workspace/runtime-contracts";
import { templatePackageFixture } from "@agent-workspace/test-kit";
import { afterEach, describe, expect, it } from "vitest";
import { createRuntimeRepositories, type MetaTurnRecord } from "./repositories.js";
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

    const session: MetaSessionRecord = {
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

    const proposal: MetaPatchProposalRecord = {
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
    const initialSession: MetaSessionRecord = {
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
    const appendedSession: MetaSessionRecord = {
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
    const turn: MetaTurnRecord = {
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
    const blockedTurn: MetaTurnRecord = {
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
    const proposal: MetaPatchProposalRecord = {
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
      expectedAttempts: reconciliationLease.attempts,
      session: { ...appendedSession, revision: 3, updatedAt: completedAt },
      expectedSessionRevision: appendedSession.revision,
      assistantMessage,
      proposal,
      completedAt,
    };
    expect(repositories.configuration.completeMetaTurn(completion)).toMatchObject({ status: "returned", attempts: 4 });
    expect(repositories.configuration.completeMetaTurn(completion)).toMatchObject({ status: "returned", attempts: 4 });
    expect(repositories.configuration.getMetaMessage(assistantMessage.metaMessageId)).toEqual(assistantMessage);
    expect(repositories.configuration.getMetaPatchProposal(proposal.metaPatchProposalId)).toEqual(proposal);

    const publicTurn = repositories.read.readModel(completedAt).configuration.metaTurns[0]!;
    expect(publicTurn).toMatchObject({ metaTurnId: turn.metaTurnId, status: "returned", attempts: 4 });
    const publicJson = JSON.stringify(publicTurn);
    for (const privateField of [
      "commandId", "idempotencyKey", "profile", "systemInstructions", "outputSchema",
      "context", "contextDigest", "leaseUntil", "leasedFromStatus",
    ]) expect(publicJson).not.toContain(`\"${privateField}\"`);
    store.close();
  });
});

describe("TaskRetentionStore", () => {
  it("persists a path-free permanent-delete intent, fences concurrent Task mutation, and leaves a retry tombstone", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "agent-workspace-retention-store-"));
    paths.push(directory);
    const store = new SqliteRuntimeStore({ path: path.join(directory, "runtime.sqlite") });
    const repositories = createRuntimeRepositories(store);
    const first = importInput(new Uint8Array([1]));
    repositories.templateTask.importPackage(first.template, first.version, first.packageValue, first.assets);
    const now = "2026-08-06T00:00:00.000Z";
    const snapshot = {
      architectureSnapshotId: "architecture_retention",
      taskId: "task_retention",
      templateId: first.template.templateId,
      templateVersionId: first.version.templateVersionId,
      templateDefinitionHash: first.version.definitionHash,
      definition: first.version.definition,
      taskInputValues: [],
      taskGoalContent: "Task title: Retention\nTask goal:\nKeep records until explicit permanent deletion.\nTask inputs:\n(none)\n",
      taskGoalContentDigest: hashDefinition("Task title: Retention\nTask goal:\nKeep records until explicit permanent deletion.\nTask inputs:\n(none)\n"),
      taskGoalCompilerVersion: "task-goal/v1" as const,
      workspace: { workspaceId: "workspace_retention", cwd: "/project" },
      createdAt: now,
    } as const;
    const task = {
      taskId: "task_retention",
      architectureSnapshotId: snapshot.architectureSnapshotId,
      title: "Retention",
      goal: "Keep records until explicit permanent deletion.",
      status: "stopped" as const,
      trashedAt: now,
      achievement: { achievedAt: now, acceptedArtifactIds: [] },
      revision: 3,
      createdAt: now,
      updatedAt: now,
    };
    repositories.templateTask.createTask({ task, snapshot });
    const intent = {
      commandId: "command_delete_retention",
      taskId: task.taskId,
      expectedRevision: task.revision,
      artifactIds: [],
      payloadFingerprint: "fnv1a64:delete-retention",
      preparedAt: now,
    } as const;

    expect(repositories.retention.preparePermanentDelete(intent)).toEqual(intent);
    expect(repositories.retention.preparePermanentDelete(intent)).toEqual(intent);
    expect(() => repositories.templateTask.updateTask({ ...task, revision: 4 }, task.revision))
      .toThrow("task_permanent_delete_in_progress");

    const result = {
      taskId: task.taskId,
      deletedArtifactIds: [],
      skippedArtifacts: [],
      deletedAt: "2026-08-06T00:01:00.000Z",
    } as const;
    expect(repositories.retention.completePermanentDelete({
      commandId: intent.commandId,
      taskId: task.taskId,
      payloadFingerprint: intent.payloadFingerprint,
      result,
    })).toMatchObject({ result });
    expect(repositories.templateTask.getTask(task.taskId)).toBeUndefined();
    expect(repositories.retention.getPermanentDeleteTombstone(intent.commandId)).toMatchObject({ result });
    store.close();
  });
});

describe("MessageStore and InboxStore", () => {
  it("persists immutable final Messages, multiple RelayBlocks, and a leased Inbox delivery without a result/wakeup path", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "agent-workspace-message-store-"));
    paths.push(directory);
    const store = new SqliteRuntimeStore({ path: path.join(directory, "runtime.sqlite") });
    const repositories = createRuntimeRepositories(store);
    const ids = seedMessageKernelRun(store);
    const assignment: SessionMessageRecord = {
      messageId: "message_assignment",
      taskId: ids.taskId,
      runId: ids.runId,
      sourceLogicalSessionId: ids.conductorSessionId,
      invocationId: "invocation_worker_a",
      kind: "agent_assignment",
      content: "研究产业链。",
      contentDigest: "sha256:assignment",
      createdAt: ids.now,
    };
    repositories.message.createMessage(assignment);
    repositories.message.createMessage({ ...assignment });

    const inbox: SessionInboxItemRecord = {
      inboxItemId: "inbox_assignment",
      taskId: ids.taskId,
      runId: ids.runId,
      targetLogicalSessionId: ids.workerASessionId,
      renderedMessageId: assignment.messageId,
      replyToLogicalSessionId: ids.conductorSessionId,
      state: "pending",
      revision: 1,
      createdAt: ids.now,
      updatedAt: ids.now,
    };
    repositories.inbox.createInboxItem(inbox);
    repositories.inbox.createInboxItem({ ...inbox });
    const leased = repositories.inbox.claimInboxItem({
      inboxItemId: inbox.inboxItemId,
      expectedRevision: 1,
      leaseId: "lease_assignment",
      leaseExpiresAt: "2026-08-07T01:05:00.000Z",
      now: "2026-08-07T01:01:00.000Z",
    });
    expect(leased).toMatchObject({ state: "leased", revision: 2, leaseId: "lease_assignment" });
    expect(() => repositories.inbox.updateInboxItem({ ...leased, revision: 3, updatedAt: ids.now }, 1))
      .toThrow("stale_session_inbox_item_revision");

    const input: InputSubmissionRecord = {
      inputSubmissionId: "input_assignment",
      sourceInboxItemId: inbox.inboxItemId,
      taskId: ids.taskId,
      runId: ids.runId,
      logicalSessionId: ids.workerASessionId,
      bindingId: ids.workerABindingId,
      contentMessageId: assignment.messageId,
      deliveryRole: "user",
      content: assignment.content,
      contentDigest: assignment.contentDigest,
      sequenceNumber: 1,
      idempotencyKey: "input-assignment",
      status: "staged",
      createdAt: ids.now,
      updatedAt: ids.now,
    };
    repositories.invocation.createInput(input, "command_assignment");
    repositories.inbox.updateInboxItem({
      ...leased,
      state: "delivery_staged",
      leaseId: undefined,
      leaseExpiresAt: undefined,
      deliveryInputSubmissionId: input.inputSubmissionId,
      revision: 3,
      updatedAt: "2026-08-07T01:02:00.000Z",
    }, 2);
    expect(repositories.invocation.getInput(input.inputSubmissionId)).toMatchObject({
      sourceInboxItemId: inbox.inboxItemId,
      content: assignment.content,
    });

    const invocation: InvocationRecord = {
      invocationId: "invocation_worker_a",
      taskId: ids.taskId,
      runId: ids.runId,
      replyToLogicalSessionId: ids.conductorSessionId,
      targetLogicalSessionId: ids.workerASessionId,
      targetAgentCardId: "agent_card_worker_a",
      bindingId: ids.workerABindingId,
      assignmentMessageId: assignment.messageId,
      instruction: "研究产业链。",
      acceptanceCriteria: ["给出结论"],
      requestedArtifacts: [],
      status: "running",
      createdAt: ids.now,
      updatedAt: ids.now,
    };
    repositories.invocation.createInvocation(invocation);
    const workerTurn = {
      sessionTurnId: "session_turn_worker_a",
      taskId: ids.taskId,
      runId: ids.runId,
      inputSubmissionId: input.inputSubmissionId,
      targetLogicalSessionId: ids.workerASessionId,
      kind: "session_agent" as const,
      initiator: "conductor" as const,
      trigger: "conductor_invocation" as const,
      replyToLogicalSessionId: ids.conductorSessionId,
      invocationId: invocation.invocationId,
      status: "running" as const,
      createdAt: ids.now,
      updatedAt: ids.now,
    };
    repositories.turn.createTurn(workerTurn);
    const streamedToolFact: ProviderFact = {
      providerFactId: "provider_fact_worker_tool_progress",
      provider: "codex",
      bindingId: ids.workerABindingId,
      bindingRevision: 1,
      kind: "activity_observed",
      deduplication: {
        sourceInstanceId: "codex_instance_message_store",
        cursor: "tool-progress-1",
      },
      correlation: {
        inputSubmissionId: input.inputSubmissionId,
        invocationId: invocation.invocationId,
      },
      payload: {
        schemaVersion: 1,
        activityId: "activity_workertool001234",
        category: "tool",
        phase: "progress",
        title: "读取文件",
        detail: "package.json",
        content: "正在读取",
        updateMode: "append",
        sequence: 0,
        rawArguments: { cwd: "/private/workspace", command: "cat package.json" },
      },
      observedAt: "2026-08-07T01:02:15.000Z",
    };
    expect(repositories.providerFact.recordFact(streamedToolFact, streamedToolFact.observedAt)).toBe(true);
    const completedToolFact: ProviderFact = {
      ...streamedToolFact,
      providerFactId: "provider_fact_worker_tool_completed",
      deduplication: { providerEventId: "codex-tool-completed" },
      payload: {
        schemaVersion: 1,
        activityId: "activity_workertool001234",
        category: "tool",
        phase: "completed",
        title: "读取文件",
        detail: "package.json",
        content: "读取完成",
        updateMode: "replace",
        sequence: 1,
        rawResult: { cwd: "/private/workspace", output: "secret-provider-payload" },
      },
      observedAt: "2026-08-07T01:02:30.000Z",
    };
    expect(repositories.providerFact.recordFact(completedToolFact, completedToolFact.observedAt)).toBe(true);
    const finalMessage: SessionMessageRecord = {
      messageId: "message_worker_a_final",
      taskId: ids.taskId,
      runId: ids.runId,
      sourceLogicalSessionId: ids.workerASessionId,
      sourceSessionTurnId: workerTurn.sessionTurnId,
      invocationId: invocation.invocationId,
      kind: "agent_final",
      content: "结论在此。\n\n```relay\ntopic: game.board\naudience: publish\n---\n{\"turn\":4}\n```\n\n```relay\nto: agent_card_worker_b\ntopic: game.move\n---\n轮到你了。\n```",
      contentDigest: "sha256:worker-a-final",
      createdAt: "2026-08-07T01:03:00.000Z",
    };
    repositories.message.createMessage(finalMessage);
    repositories.message.createMessage({ ...finalMessage });
    expect(() => repositories.message.createMessage({
      ...finalMessage,
      messageId: "message_worker_a_final_replay_conflict",
    })).toThrow("agent_final_invocation_conflict");
    const boardBlock: RelayBlockRecord = {
      relayBlockId: "relay_board_turn_4",
      sourceMessageId: finalMessage.messageId,
      ordinal: 0,
      suggestedTargetAgentCardIds: [],
      suggestedAudience: "publish",
      topic: "game.board",
      format: "application/json",
      content: "{\"turn\":4}",
      contentDigest: "sha256:relay-board-turn-4",
      parserVersion: 1,
      sourceRange: { start: 12, end: 75 },
      createdAt: finalMessage.createdAt,
    };
    repositories.message.createRelayBlock(boardBlock);
    repositories.message.createRelayBlock({ ...boardBlock, suggestedTargetAgentCardIds: [] });
    const moveBlock: RelayBlockRecord = {
      relayBlockId: "relay_move_worker_b",
      sourceMessageId: finalMessage.messageId,
      ordinal: 1,
      suggestedTargetAgentCardIds: ["agent_card_worker_b"],
      topic: "game.move",
      format: "text/markdown",
      content: "轮到你了。",
      contentDigest: "sha256:relay-move-worker-b",
      parserVersion: 1,
      sourceRange: { start: 77, end: 166 },
      createdAt: finalMessage.createdAt,
    };
    repositories.message.createRelayBlock(moveBlock);
    repositories.invocation.updateInvocation({
      ...invocation,
      finalMessageId: finalMessage.messageId,
      status: "returned",
      updatedAt: "2026-08-07T01:04:00.000Z",
    });

    repositories.turn.updateTurn({ ...workerTurn, finalMessageId: finalMessage.messageId, status: "returned", updatedAt: finalMessage.createdAt });
    const renderedRelay: SessionMessageRecord = {
      messageId: "message_worker_b_relay",
      taskId: ids.taskId,
      runId: ids.runId,
      sourceLogicalSessionId: ids.conductorSessionId,
      kind: "relay_forward",
      content: "# 转递消息\nTHEN BOARD",
      contentDigest: "sha256:rendered-relay",
      createdAt: "2026-08-07T01:04:00.000Z",
    };
    repositories.message.createMessage(renderedRelay);
    const forward = {
      forwardId: "message_forward_worker_b",
      taskId: ids.taskId,
      runId: ids.runId,
      commandId: "command_forward_worker_b",
      idempotencyKey: "forward-worker-b",
      expectedTaskRevision: 2,
      targetIdempotencyKey: "forward-worker-b:target",
      decidedByLogicalSessionId: ids.conductorSessionId,
      decidedBySessionTurnId: "session_turn_conductor_decision",
      targetLogicalSessionId: ids.workerBSessionId,
      mode: "relay" as const,
      selections: [
        { forwardSelectionId: "forward_selection_move", forwardId: "message_forward_worker_b", ordinal: 0, kind: "relay_block" as const, sourceMessageId: finalMessage.messageId, relayBlockId: moveBlock.relayBlockId, contentDigest: moveBlock.contentDigest },
        { forwardSelectionId: "forward_selection_board", forwardId: "message_forward_worker_b", ordinal: 1, kind: "relay_block" as const, sourceMessageId: finalMessage.messageId, relayBlockId: boardBlock.relayBlockId, contentDigest: boardBlock.contentDigest },
      ],
      renderedMessageId: renderedRelay.messageId,
      createdAt: renderedRelay.createdAt,
    };
    repositories.forward.createForward(forward);
    const relayInbox: SessionInboxItemRecord = {
      inboxItemId: "inbox_worker_b_relay",
      taskId: ids.taskId,
      runId: ids.runId,
      targetLogicalSessionId: ids.workerBSessionId,
      renderedMessageId: renderedRelay.messageId,
      forwardId: forward.forwardId,
      replyToLogicalSessionId: ids.conductorSessionId,
      state: "pending",
      revision: 1,
      createdAt: "2026-08-07T01:04:00.000Z",
      updatedAt: "2026-08-07T01:04:00.000Z",
    };
    repositories.inbox.createInboxItem(relayInbox);

    expect(repositories.message.findMessageByInvocation(invocation.invocationId, "agent_final")).toEqual(finalMessage);
    expect(repositories.message.listRelayBlocks(ids.runId)).toEqual([boardBlock, moveBlock]);
    expect(repositories.message.listRelayBlocksForMessage(finalMessage.messageId)).toEqual([boardBlock, moveBlock]);
    expect(repositories.forward.getForward(forward.forwardId)).toEqual(forward);
    expect(repositories.inbox.findInboxItem({
      targetLogicalSessionId: ids.workerBSessionId,
      renderedMessageId: renderedRelay.messageId,
    })).toEqual(relayInbox);
    const readModel = repositories.read.readModel("2026-08-07T01:05:00.000Z", { taskId: ids.taskId });
    expect(readModel.task?.messages.map((item) => item.messageId)).toEqual([
      assignment.messageId,
      finalMessage.messageId,
      renderedRelay.messageId,
    ]);
    expect(readModel.task?.relayBlocks).toEqual([boardBlock, moveBlock]);
    expect(readModel.task?.messageForwards).toEqual([forward]);
    expect(readModel.task?.sessionTurns).toEqual([expect.objectContaining({ sessionTurnId: workerTurn.sessionTurnId, finalMessageId: finalMessage.messageId })]);
    expect(readModel.task?.providerActivities).toEqual([expect.objectContaining({
      activityId: "activity_workertool001234",
      logicalSessionId: ids.workerASessionId,
      sessionTurnId: workerTurn.sessionTurnId,
      status: "completed",
      title: "读取文件",
      detail: "package.json",
      content: "读取完成",
    })]);
    expect(JSON.stringify(readModel.task?.providerActivities)).not.toContain("/private/workspace");
    expect(JSON.stringify(readModel.task?.providerActivities)).not.toContain("secret-provider-payload");
    expect(readModel.task?.inboxItems.map((item) => item.inboxItemId)).toEqual([
      inbox.inboxItemId,
      relayInbox.inboxItemId,
    ]);
    expect(store.one("SELECT name FROM sqlite_master WHERE type = ? AND name IN (?, ?)", "table", "invocation_results", "wakeups")).toBeUndefined();
    store.close();
  });
});

describe("Task Goal snapshot persistence", () => {
  it("restores frozen compiler content/digest and the run-scoped compiler pin after restart", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "agent-workspace-task-goal-store-"));
    paths.push(directory);
    const databasePath = path.join(directory, "runtime.sqlite");
    let store = new SqliteRuntimeStore({ path: databasePath });
    let repositories = createRuntimeRepositories(store);
    const imported = importInput(new Uint8Array([8, 9]));
    repositories.templateTask.importPackage(imported.template, imported.version, imported.packageValue, imported.assets);
    const content = "Task title: Frozen goal\nTask goal:\nProve restart recovery.\nTask inputs:\n(none)\n";
    const snapshot = {
      architectureSnapshotId: "architecture_task_goal_restart",
      taskId: "task_goal_restart",
      templateId: imported.template.templateId,
      templateVersionId: imported.version.templateVersionId,
      templateDefinitionHash: imported.version.definitionHash,
      definition: imported.version.definition,
      taskInputValues: [],
      taskGoalContent: content,
      taskGoalContentDigest: hashDefinition(content),
      taskGoalCompilerVersion: "task-goal/v1" as const,
      workspace: { workspaceId: "workspace_task_goal_restart", cwd: "/project" },
      createdAt: configurationNow,
    };
    repositories.templateTask.createTask({
      snapshot,
      task: {
        taskId: snapshot.taskId,
        architectureSnapshotId: snapshot.architectureSnapshotId,
        title: "Frozen goal",
        goal: "Prove restart recovery.",
        status: "running",
        activeRunId: "run_task_goal_restart",
        revision: 2,
        createdAt: configurationNow,
        updatedAt: configurationNow,
      },
    });
    store.run(
      "INSERT INTO task_runs(run_id, task_id, conductor_logical_session_id, status, run_number, revision, started_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      "run_task_goal_restart", snapshot.taskId, "logical_session_task_goal_restart", "starting", 1, 1, configurationNow,
    );
    const message: SessionMessageRecord = {
      messageId: "message_task_goal_restart",
      taskId: snapshot.taskId,
      runId: "run_task_goal_restart",
      kind: "task_goal",
      content,
      contentDigest: snapshot.taskGoalContentDigest,
      taskGoalCompilerVersion: snapshot.taskGoalCompilerVersion,
      createdAt: configurationNow,
    };
    repositories.message.createMessage(message);
    const artifact = {
      artifactId: "artifact_task_goal_restart",
      taskId: snapshot.taskId,
      runId: message.runId,
      workspaceRelativePath: "result.html",
      contentDigest: "sha256:artifact-task-goal-restart",
      sourceMessageId: message.messageId,
      evidenceReferenceIds: [],
      verifiedAt: configurationNow,
    } as const;
    repositories.artifact.recordArtifact(artifact);
    expect(() => repositories.message.createMessage({
      ...message,
      messageId: "message_task_goal_wrong_kind",
      kind: "runtime_notice",
    })).toThrow("task_goal_compiler_version_not_allowed");
    store.close();

    store = new SqliteRuntimeStore({ path: databasePath });
    repositories = createRuntimeRepositories(store);
    expect(repositories.templateTask.getArchitectureSnapshot(snapshot.taskId)).toEqual(snapshot);
    expect(repositories.message.getMessage(message.messageId)).toEqual(message);
    expect(repositories.artifact.getArtifact(artifact.artifactId)).toEqual(artifact);
    store.close();
  });
});

describe("ProviderFactStore deduplication", () => {
  it("accepts an identical replay after restart and rejects a semantic collision", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "agent-workspace-provider-facts-"));
    paths.push(directory);
    const databasePath = path.join(directory, "runtime.sqlite");
    let store = new SqliteRuntimeStore({ path: databasePath });
    const ids = seedMessageKernelRun(store);
    let repositories = createRuntimeRepositories(store);
    const original: ProviderFact = {
      providerFactId: "provider_fact_dedup_original",
      provider: "codex",
      bindingId: ids.workerABindingId,
      bindingRevision: 1,
      kind: "turn_started",
      deduplication: {
        providerEventId: "codex-turn-dedup",
        sourceInstanceId: "codex-process-before-restart",
      },
      correlation: {},
      payload: { nativeTurnId: "turn-dedup", state: "running" },
      observedAt: "2026-08-07T01:02:00.000Z",
    };
    expect(repositories.providerFact.recordFact(original, original.observedAt)).toBe(true);
    store.close();

    store = new SqliteRuntimeStore({ path: databasePath });
    repositories = createRuntimeRepositories(store);
    const replay: ProviderFact = {
      ...original,
      providerFactId: "provider_fact_dedup_replay",
      deduplication: {
        providerEventId: "codex-turn-dedup",
        sourceInstanceId: "codex-process-after-restart",
      },
      payload: { nativeTurnId: "turn-dedup", state: "running" },
      observedAt: "2026-08-07T01:03:00.000Z",
    };
    expect(repositories.providerFact.recordFact(replay, replay.observedAt)).toBe(false);
    expect(() => repositories.providerFact.recordFact({
      ...replay,
      providerFactId: "provider_fact_dedup_conflict",
      payload: { nativeTurnId: "turn-other", state: "failed" },
    }, "2026-08-07T01:04:00.000Z")).toThrow("provider_fact_dedup_conflict");
    expect(repositories.providerFact.listFacts([ids.workerABindingId])).toEqual([original]);
    store.close();
  });
});

describe("ArtifactStore canonical claims", () => {
  it("returns the persisted identity, rejects provenance collisions, and keeps identical bytes distinct across Runs", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "agent-workspace-artifact-store-"));
    paths.push(directory);
    const store = new SqliteRuntimeStore({ path: path.join(directory, "runtime.sqlite") });
    const ids = seedMessageKernelRun(store);
    const repositories = createRuntimeRepositories(store);
    const secondRunId = "run_message_store_second";
    store.run(
      "INSERT INTO task_runs(run_id, task_id, conductor_logical_session_id, status, run_number, revision, started_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      secondRunId, ids.taskId, ids.conductorSessionId, "running", 2, 1, ids.now,
    );
    const firstMessage: SessionMessageRecord = {
      messageId: "message_artifact_final_first",
      taskId: ids.taskId,
      runId: ids.runId,
      kind: "runtime_notice",
      content: "Artifact: reports/result.html",
      contentDigest: "sha256:artifact-final-first",
      createdAt: ids.now,
    };
    const secondMessage: SessionMessageRecord = {
      ...firstMessage,
      messageId: "message_artifact_final_second",
      runId: secondRunId,
      contentDigest: "sha256:artifact-final-second",
    };
    repositories.message.createMessage(firstMessage);
    repositories.message.createMessage(secondMessage);
    const first: ArtifactReference = {
      artifactId: "artifact_claim_first",
      taskId: ids.taskId,
      runId: ids.runId,
      workspaceRelativePath: "reports/result.html",
      contentDigest: `sha256:${"a".repeat(64)}`,
      sourceMessageId: firstMessage.messageId,
      evidenceReferenceIds: [],
      verifiedAt: ids.now,
    };
    expect(repositories.artifact.recordArtifact(first)).toEqual(first);
    expect(repositories.artifact.recordArtifact({ ...first, verifiedAt: "2026-08-07T01:01:00.000Z" })).toEqual(first);
    expect(() => repositories.artifact.recordArtifact({
      ...first,
      artifactId: "artifact_claim_spoofed",
      contentDigest: `sha256:${"b".repeat(64)}`,
    })).toThrow("artifact_claim_conflict");
    const second: ArtifactReference = {
      ...first,
      artifactId: "artifact_claim_second",
      runId: secondRunId,
      sourceMessageId: secondMessage.messageId,
    };
    expect(repositories.artifact.recordArtifact(second)).toEqual(second);
    expect(repositories.artifact.listArtifactsForTask(ids.taskId)).toEqual([first, second]);
    expect(repositories.artifact.findArtifactByClaim(firstMessage.messageId, first.workspaceRelativePath)).toEqual(first);
    store.close();
  });
});

function seedMessageKernelRun(store: SqliteRuntimeStore): {
  readonly now: string;
  readonly taskId: string;
  readonly runId: string;
  readonly conductorSessionId: string;
  readonly workerASessionId: string;
  readonly workerBSessionId: string;
  readonly workerABindingId: string;
} {
  const now = "2026-08-07T01:00:00.000Z";
  const taskId = "task_message_store";
  const runId = "run_message_store";
  const conductorSessionId = "logical_session_conductor";
  const workerASessionId = "logical_session_worker_a";
  const workerBSessionId = "logical_session_worker_b";
  const workerABindingId = "binding_worker_a";
  store.run(
    "INSERT INTO templates(template_id, slug, title, status, active_version_id, revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    "template_message_store", "message-store", "Message store", "active", "template_version_message_store", 1, now, now,
  );
  store.run(
    "INSERT INTO template_versions(template_version_id, template_id, version, schema_version, definition_json, definition_hash, asset_manifest_hash, created_at, published_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    "template_version_message_store", "template_message_store", 1, 2, "{}", "fnv1a64:message-store", "sha256:empty", now, now,
  );
  store.run(
    "INSERT INTO task_architecture_snapshots(architecture_snapshot_id, task_id, template_id, template_version_id, template_definition_hash, definition_json, workspace_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    "architecture_message_store", taskId, "template_message_store", "template_version_message_store", "fnv1a64:message-store", "{}", "{\"workspaceId\":\"workspace_message_store\",\"cwd\":\"/project\"}", now,
  );
  store.run(
    "INSERT INTO tasks(task_id, architecture_snapshot_id, title, goal, status, active_run_id, revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    taskId, "architecture_message_store", "Message store", "Route Messages.", "running", runId, 1, now, now,
  );
  store.run(
    "INSERT INTO task_runs(run_id, task_id, conductor_logical_session_id, status, run_number, revision, started_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    runId, taskId, conductorSessionId, "running", 1, 1, now,
  );
  const sessions = [
    [conductorSessionId, "agent_card_conductor", "conductor", 0],
    [workerASessionId, "agent_card_worker_a", "card", 1],
    [workerBSessionId, "agent_card_worker_b", "card", 2],
  ] as const;
  for (const [logicalSessionId, agentCardId, kind, ordinal] of sessions) {
    store.run(
      "INSERT INTO logical_sessions(logical_session_id, task_id, run_id, agent_card_id, kind, execution_profile_id, status, ordinal, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      logicalSessionId, taskId, runId, agentCardId, kind, "profile_message_store", "active", ordinal, now, now,
    );
  }
  store.run(
    "INSERT INTO provider_session_bindings(binding_id, task_id, run_id, logical_session_id, execution_profile_id, provider_id, binding_revision, status, recoverable, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    workerABindingId, taskId, runId, workerASessionId, "profile_message_store", "codex", 1, "active", 1, now, now,
  );
  return { now, taskId, runId, conductorSessionId, workerASessionId, workerBSessionId, workerABindingId };
}

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

const configurationMetaProfile: MetaProfileDefinition = {
  metaProfileId: "meta_profile_store",
  provider: "codex",
  model: "gpt-5.6",
  providerVersion: "0.146.0",
  protocolFingerprint: "sha256:meta-store",
  capabilityPolicy: {
    requiredCapabilities: [],
    allowedTools: [],
    permissionMode: "deny",
    maxConcurrentTurns: 1,
    maxNativeChildren: 0,
  },
};

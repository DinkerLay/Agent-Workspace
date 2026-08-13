import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  hashDefinition,
  type AcpSafeSessionBindingRecordV3,
  type SessionIdMessageForwardRecord,
  type SessionLaneItemRecord,
} from "@agent-workspace/runtime-contracts";
import {
  createSessionExecutionRuntimeOwner,
  createSessionIdAcpDeliveryResultOwner,
  createSessionIdAcpOrchestrationBridge,
  type SessionExecutionRecordRepository,
  type SessionIdAcpDeliveryResultOwnerCapabilities,
} from "@agent-workspace/runtime-application";
import {
  createAcpSessionRuntimeRepositories,
  createSessionIdCanonicalStore,
  SqliteRuntimeStore,
  type AcpSessionRuntimeRepositories,
  type AcpV3SessionRuntimeRepository,
} from "@agent-workspace/runtime-store";
import type {
  AcpTaskSessionRuntimeDeliveryReceipt,
} from "../../apps/runtime-host/src/acp-task-session-runtime-provider.js";

const temporaryDirectories: string[] = [];
const NOW = "2026-08-12T00:00:00.000Z";
const LATER = "2026-08-12T00:00:05.000Z";
const TASK_ID = "task_delivery_owner";
const RUN_ID = "run_delivery_owner";
const CONDUCTOR_SESSION_ID = "logical_session_delivery_conductor";
const WORKER_SESSION_ID = "logical_session_delivery_worker";
const PROFILE = Object.freeze({
  schemaVersion: 3 as const,
  executionProfileId: "profile_delivery_worker",
  profileRevisionId: "profile_revision_delivery_worker-1",
  providerFamily: "opencode" as const,
});
const RECEIPT = `sha256:${"c".repeat(64)}`;

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { force: true, recursive: true });
});

describe("ACP OR delivery/result owner SQLite integration", () => {
  it("shares one outer transaction across OR + v3 savepoints and publishes receipt state before callback returns", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "agent-workspace-acp-delivery-owner-"));
    temporaryDirectories.push(directory);
    const store = new SqliteRuntimeStore({ path: path.join(directory, "runtime.sqlite"), now: () => NOW });
    seedCanonicalSession(store);
    const canonical = createSessionIdCanonicalStore(store);
    const repositories = createAcpSessionRuntimeRepositories(store, {
      resolveFrozenProfileTuple: () => PROFILE,
    });
    repositories.binding.createBinding(bindingRecord(), { makeCurrent: true });
    seedPendingDelivery(canonical);

    let executionIdentity = 0;
    const sessionRuntimeOwner = createSessionExecutionRuntimeOwner({
      repository: sessionExecutionRepository(repositories),
      commandTransaction: sessionRuntimeCommandTransaction(repositories),
      now: monotonicNow(),
      createRuntimeId: () => `session_execution_runtime_delivery_${++executionIdentity}`,
      createAttemptId: () => `session_execution_attempt_delivery_${++executionIdentity}`,
      createProviderEffectIntentId: () => `provider_effect_delivery_${++executionIdentity}`,
    });
    const canonicalSettlement = vi.fn();
    const bridge = createSessionIdAcpOrchestrationBridge({
      orchestrationRead: canonical.orchestration,
      messageRead: canonical.message,
      taskRunRead: canonical.taskRun,
      currentBindingRead: repositories.binding,
      resolveFrozenProfileTuple: () => PROFILE,
      providerEffectRead: {
        findByIdempotencyKey: ({ taskId, runId, commandType, idempotencyKey }) =>
          repositories.reliability.listProviderEffectIntents().find((intent) =>
            intent.taskId === taskId
              && intent.runId === runId
              && intent.commandType === commandType
              && intent.idempotencyKey === idempotencyKey),
      },
      sessionRuntimeOwner,
      settlementCoordinator: { acceptSettlement: canonicalSettlement },
    });
    let failAfterNestedStage = true;
    let orIdentity = 0;
    const deliveryOwner = createSessionIdAcpDeliveryResultOwner({
      now: () => LATER,
      createId: (kind) => `${kind}_delivery_${++orIdentity}`,
      task: {
        taskId: TASK_ID,
        runId: RUN_ID,
        conductorSessionId: CONDUCTOR_SESSION_ID,
        initialConductorSessionTurnId: "session_turn_delivery_conductor-initial",
      },
      transaction: applicationTransaction(canonical, repositories),
      bridge: {
        stageDelivery(input) {
          const staged = bridge.stageDelivery(input);
          if (failAfterNestedStage) throw new Error("fail_after_nested_v3_stage");
          return staged;
        },
        acceptSettlement: bridge.acceptSettlement,
      },
      terminalNoticeCoordinator: {
        acceptNotice: () => Object.freeze({ status: "not_admitted" as const }),
      },
    });

    expect(() => deliveryOwner.stageReadyDelivery({ logicalSessionId: WORKER_SESSION_ID }))
      .toThrow("fail_after_nested_v3_stage");
    expect(canonical.orchestration.findInputByInboxItem("inbox_delivery_owner-1")).toBeUndefined();
    expect(canonical.orchestration.listTurns(WORKER_SESSION_ID)).toEqual([]);
    expect(canonical.orchestration.getInboxItem("inbox_delivery_owner-1")).toMatchObject({ state: "pending" });
    expect(repositories.sessionRuntime.getRuntimeForSession(WORKER_SESSION_ID)).toBeUndefined();
    expect(repositories.reliability.listProviderEffectIntents()).toEqual([]);

    failAfterNestedStage = false;
    const staged = deliveryOwner.stageReadyDelivery({ logicalSessionId: WORKER_SESSION_ID });
    if (staged.disposition === "idle") throw new Error(`unexpected idle: ${staged.reason}`);
    expect(staged).toMatchObject({
      disposition: "staged",
      inboxItemId: "inbox_delivery_owner-1",
      providerEffectIntentId: expect.stringMatching(/^provider_effect_/u),
    });
    expect(deliveryOwner.stageReadyDelivery({ logicalSessionId: WORKER_SESSION_ID }))
      .toEqual({ ...staged, disposition: "replay" });
    expect(repositories.reliability.listProviderEffectIntents()).toHaveLength(1);

    const intent = repositories.reliability.getProviderEffectIntent(staged.providerEffectIntentId)!;
    const beforeReceipt = repositories.sessionRuntime.getAttempt(staged.sessionExecutionAttemptId)!;
    expect(canonical.orchestration.getInputSubmission(staged.inputSubmissionId)).toMatchObject({ state: "pending" });
    sessionRuntimeOwner.handleDeliveryReceipt({
      sessionExecutionAttemptId: beforeReceipt.sessionExecutionAttemptId,
      expectedAttemptRevision: beforeReceipt.revision,
      logicalSessionId: beforeReceipt.logicalSessionId,
      bindingId: beforeReceipt.bindingId,
      bindingRevision: beforeReceipt.bindingRevision,
      executionProfileId: beforeReceipt.executionProfileId,
      profileRevisionId: beforeReceipt.profileRevisionId,
      receiptDigest: RECEIPT,
    });
    expect(repositories.sessionRuntime.getAttempt(staged.sessionExecutionAttemptId)).toMatchObject({
      receiptDigest: RECEIPT,
    });
    expect(canonical.orchestration.getInputSubmission(staged.inputSubmissionId)).toMatchObject({ state: "pending" });

    const commonReceipt: AcpTaskSessionRuntimeDeliveryReceipt = Object.freeze({
      providerEffectIntentId: intent.providerEffectIntentId,
      taskId: intent.taskId,
      runId: intent.runId,
      logicalSessionId: intent.logicalSessionId,
      sessionExecutionRuntimeId: intent.sessionExecutionRuntimeId,
      sessionExecutionAttemptId: intent.sessionExecutionAttemptId,
      bindingId: intent.bindingId,
      bindingRevision: intent.bindingRevision,
      executionProfileId: intent.executionProfileId,
      profileRevisionId: intent.profileRevisionId,
      bindingHandle: intent.effect.bindingHandle,
      inputSubmissionId: intent.inputSubmissionId,
      orchestrationSessionTurnId: intent.orchestrationSessionTurnId,
      receiptDigest: RECEIPT,
    });
    const callbackResult = deliveryOwner.acceptEffectObservation({
      kind: "delivery_receipt",
      ...commonReceipt,
    });
    expect(callbackResult).toEqual({ status: "recorded", outcome: "delivery_accepted" });
    expect(canonical.orchestration.getInputSubmission(staged.inputSubmissionId)).toMatchObject({ state: "accepted" });
    expect(canonical.orchestration.getTurn(staged.sessionTurnId)).toMatchObject({ state: "active" });
    expect(canonical.orchestration.getInboxItem(staged.inboxItemId)).toMatchObject({ state: "handed" });
    expect(deliveryOwner.acceptEffectObservation({
      kind: "delivery_receipt",
      ...commonReceipt,
    })).toEqual({ status: "replayed", outcome: "delivery_accepted" });
    expect(canonicalSettlement).not.toHaveBeenCalled();
    store.close();
  });
});

function applicationTransaction(
  canonical: ReturnType<typeof createSessionIdCanonicalStore>,
  repositories: AcpSessionRuntimeRepositories,
) {
  return Object.freeze({
    run<T>(work: (owners: SessionIdAcpDeliveryResultOwnerCapabilities) => T): T {
      return canonical.transaction((owners) => work({
        taskRun: owners.taskRun,
        message: owners.message,
        orchestration: owners.orchestration,
        humanIntervention: owners.humanIntervention,
        currentBinding: repositories.binding,
        providerEffects: repositories.reliability,
        sessionExecution: repositories.sessionRuntime,
      }));
    },
  });
}

function sessionExecutionRepository(repositories: AcpSessionRuntimeRepositories) {
  return Object.freeze({
    ...sessionExecutionRecords(repositories.sessionRuntime),
    transaction<T>(work: (records: SessionExecutionRecordRepository) => T): T {
      return repositories.transaction(({ sessionRuntime }) => work(sessionExecutionRecords(sessionRuntime)));
    },
  });
}

function sessionExecutionRecords(repository: AcpV3SessionRuntimeRepository): SessionExecutionRecordRepository {
  return Object.freeze({
    findRuntimeByLogicalSessionId: repository.getRuntimeForSession,
    getRuntime: repository.getRuntime,
    insertRuntime: repository.createRuntime,
    updateRuntime: repository.updateRuntime,
    getAttempt: repository.getAttempt,
    insertAttempt: repository.createAttempt,
    updateAttempt: repository.updateAttempt,
  });
}

function sessionRuntimeCommandTransaction(repositories: AcpSessionRuntimeRepositories) {
  return Object.freeze({
    run<T>(work: (owners: Readonly<{
      sessionExecution: SessionExecutionRecordRepository;
      providerEffects: Readonly<{
        findByCommandId(commandId: string): ReturnType<AcpSessionRuntimeRepositories["reliability"]["getProviderEffectIntent"]>;
        findByIdempotencyKey(idempotencyKey: string): ReturnType<AcpSessionRuntimeRepositories["reliability"]["getProviderEffectIntent"]>;
        insert(intent: Parameters<AcpSessionRuntimeRepositories["reliability"]["createProviderEffectIntent"]>[0]): void;
      }>;
    }>) => T): T {
      return repositories.transaction(({ sessionRuntime, reliability }) => work({
        sessionExecution: sessionExecutionRecords(sessionRuntime),
        providerEffects: {
          findByCommandId: (commandId) => reliability.listProviderEffectIntents()
            .find((intent) => intent.commandId === commandId),
          findByIdempotencyKey: (idempotencyKey) => reliability.listProviderEffectIntents()
            .find((intent) => intent.idempotencyKey === idempotencyKey),
          insert: (intent) => { reliability.createProviderEffectIntent(intent); },
        },
      }));
    },
  });
}

function seedPendingDelivery(canonical: ReturnType<typeof createSessionIdCanonicalStore>): void {
  const content = "Stage this delivery through the ACP v3 owner.";
  canonical.transaction(({ message, orchestration }) => {
    message.createMessage({
      messageId: "message_delivery_owner-1",
      taskId: TASK_ID,
      runId: RUN_ID,
      kind: "conductor_forward",
      content,
      canonicalContent: Object.freeze([{ kind: "text", text: content }]),
      contentDigest: hashDefinition(content),
      createdAt: NOW,
    });
    const forward: SessionIdMessageForwardRecord = {
      forwardId: "forward_delivery_owner-1",
      taskId: TASK_ID,
      runId: RUN_ID,
      commandId: "command_delivery_owner-forward-1",
      idempotencyKey: "delivery-owner:forward:1",
      decidedBySessionTurnId: "session_turn_delivery_conductor-active",
      targetSessionId: WORKER_SESSION_ID,
      orderedReferenceSnapshots: Object.freeze([]),
      renderedMessageId: "message_delivery_owner-1",
      createdAt: NOW,
    };
    message.createForward(forward);
    const inbox: SessionLaneItemRecord = {
      inboxItemId: "inbox_delivery_owner-1",
      taskId: TASK_ID,
      runId: RUN_ID,
      sessionId: WORKER_SESSION_ID,
      renderedMessageId: forward.renderedMessageId,
      sequence: 1,
      priority: "ordinary",
      state: "pending",
      forwardId: forward.forwardId,
      createdAt: NOW,
      updatedAt: NOW,
    };
    orchestration.createInboxItem(inbox);
  });
}

function bindingRecord(): AcpSafeSessionBindingRecordV3 {
  return Object.freeze({
    schemaVersion: 3,
    bindingId: "binding_delivery_worker-1",
    taskId: TASK_ID,
    runId: RUN_ID,
    logicalSessionId: WORKER_SESSION_ID,
    agentCardId: "agent_card_delivery_worker",
    executionProfileId: PROFILE.executionProfileId,
    profileRevisionId: PROFILE.profileRevisionId,
    providerFamily: PROFILE.providerFamily,
    bindingHandle: "binding_handle_delivery_worker-1",
    status: "active",
    recoverable: true,
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
  });
}

function seedCanonicalSession(store: SqliteRuntimeStore): void {
  store.run(
    `INSERT INTO templates(template_id, slug, title, status, revision, created_at, updated_at)
     VALUES ('template_delivery_owner', 'delivery-owner', 'Delivery owner', 'active', 1, ?, ?)`,
    NOW,
    NOW,
  );
  store.run(
    `INSERT INTO template_versions(
       template_version_id, template_id, version, schema_version, definition_json,
       definition_hash, asset_manifest_hash, created_at, published_at
     ) VALUES ('template_version_delivery_owner', 'template_delivery_owner', 1, 3, '{}',
       'sha256:delivery-owner-v3', 'sha256:empty', ?, ?)`,
    NOW,
    NOW,
  );
  store.run(
    `INSERT INTO task_architecture_snapshots(
       architecture_snapshot_id, task_id, template_id, template_version_id,
       template_definition_hash, definition_json, workspace_json, created_at
     ) VALUES ('architecture_delivery_owner', ?, 'template_delivery_owner',
       'template_version_delivery_owner', 'sha256:delivery-owner-v3', '{}',
       '{"workspaceId":"workspace_delivery_owner"}', ?)`,
    TASK_ID,
    NOW,
  );
  store.run(
    `INSERT INTO tasks(
       task_id, architecture_snapshot_id, title, goal, status, active_run_id,
       revision, created_at, updated_at
     ) VALUES (?, 'architecture_delivery_owner', 'Delivery owner', 'Prove atomic staging.',
       'running', ?, 1, ?, ?)`,
    TASK_ID,
    RUN_ID,
    NOW,
    NOW,
  );
  store.run(
    `INSERT INTO task_runs(
       run_id, task_id, conductor_logical_session_id, status, run_number,
       revision, started_at
     ) VALUES (?, ?, ?, 'running', 1, 1, ?)`,
    RUN_ID,
    TASK_ID,
    CONDUCTOR_SESSION_ID,
    NOW,
  );
  store.run(
    `INSERT INTO session_id_card_session_slots(
       card_session_slot_id, task_id, run_id, agent_card_id, current_session_id,
       latest_generation, revision, created_at, updated_at
     ) VALUES ('card_session_slot_delivery_worker', ?, ?, 'agent_card_delivery_worker', ?, 1, 1, ?, ?)`,
    TASK_ID,
    RUN_ID,
    WORKER_SESSION_ID,
    NOW,
    NOW,
  );
  store.run(
    `INSERT INTO session_id_logical_sessions(
       session_id, card_session_slot_id, task_id, run_id, session_kind,
       architecture_schema_version, agent_card_id, execution_profile_id,
       profile_revision_id, generation, lifecycle, created_at
     ) VALUES (?, 'card_session_slot_delivery_worker', ?, ?, 'card', 3,
       'agent_card_delivery_worker', ?, ?, 1, 'current', ?)`,
    WORKER_SESSION_ID,
    TASK_ID,
    RUN_ID,
    PROFILE.executionProfileId,
    PROFILE.profileRevisionId,
    NOW,
  );
}

function monotonicNow(): () => string {
  let tick = 0;
  return () => new Date(Date.parse(NOW) + tick++).toISOString();
}

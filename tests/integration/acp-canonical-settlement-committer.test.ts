import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  hashDefinition,
  type AcpSafeSessionBindingRecordV3,
  type SessionExecutionSettlement,
} from "@agent-workspace/runtime-contracts";
import {
  createSessionIdAcpCanonicalSettlementCommitter,
  createSessionExecutionSettlementCoordinator,
  type SessionIdAcpCanonicalSettlementCapabilities,
} from "@agent-workspace/runtime-application";
import {
  createAcpSessionRuntimeRepositories,
  createSessionIdCanonicalStore,
  SqliteRuntimeStore,
} from "@agent-workspace/runtime-store";

const directories: string[] = [];
const NOW = "2026-08-12T14:00:00.000Z";
const TASK_ID = "task_canonical_integration";
const RUN_ID = "run_canonical_integration";
const CONDUCTOR_SESSION_ID = "logical_session_canonical_integration_conductor";
const WORKER_SESSION_ID = "logical_session_canonical_integration_worker";
const RECEIPT = `sha256:${"e".repeat(64)}`;

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("ACP canonical settlement committer SQLite integration", () => {
  it("rolls back the whole owner transaction, then records/replays one canonical Final", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "agent-workspace-canonical-final-"));
    directories.push(directory);
    const sqlite = new SqliteRuntimeStore({ path: path.join(directory, "runtime.sqlite"), now: () => NOW });
    seedLifecycle(sqlite);
    const canonical = createSessionIdCanonicalStore(sqlite);
    const v3 = createAcpSessionRuntimeRepositories(sqlite, {
      resolveFrozenProfileTuple: () => ({
        schemaVersion: 3,
        executionProfileId: "profile_canonical_integration",
        profileRevisionId: "profile_revision_canonical_integration",
        providerFamily: "opencode",
      }),
    });
    const binding = bindingRecord();
    v3.binding.createBinding(binding, { makeCurrent: true });
    const settlement = seedDeliveryAndSettlement(canonical, v3, binding);
    let failAfterCommit = true;
    let identity = 0;
    const committer = createSessionIdAcpCanonicalSettlementCommitter({
      now: () => NOW,
      createId: (kind) => `${kind}_canonical_integration_${++identity}`,
      task: { taskId: TASK_ID, runId: RUN_ID, conductorSessionId: CONDUCTOR_SESSION_ID },
      transaction: {
        run<T>(work: (owners: SessionIdAcpCanonicalSettlementCapabilities) => T): T {
          return canonical.transaction((owners) => {
            const result = work({
              taskRun: owners.taskRun,
              message: owners.message,
              orchestration: owners.orchestration,
              humanIntervention: owners.humanIntervention,
              currentBinding: v3.binding,
              sessionExecution: v3.sessionRuntime,
              providerEffects: v3.reliability,
            });
            if (failAfterCommit) throw new Error("controlled_outer_commit_failure");
            return result;
          });
        },
      },
    });
    const coordinator = createSessionExecutionSettlementCoordinator({ committer });

    expect(() => coordinator.acceptSettlement(settlement)).toThrow("controlled_outer_commit_failure");
    expect(canonical.message.findFinalByTurn(settlement.orchestrationSessionTurnId)).toBeUndefined();
    expect(canonical.orchestration.getInputSubmission(settlement.inputSubmissionId)).toMatchObject({ state: "accepted" });
    expect(canonical.orchestration.getTurn(settlement.orchestrationSessionTurnId)).toMatchObject({ state: "active" });
    expect(canonical.orchestration.listInboxItems(CONDUCTOR_SESSION_ID)).toEqual([]);

    failAfterCommit = false;
    const recorded = coordinator.acceptSettlement(settlement);
    expect(recorded).toEqual({
      status: "recorded",
      messageId: "message_canonical_integration_3",
      inboxItemId: "inbox_item_canonical_integration_4",
    });
    expect(canonical.message.findFinalByTurn(settlement.orchestrationSessionTurnId)).toMatchObject({
      messageId: recorded.messageId,
      content: settlement.finalContent,
    });
    expect(canonical.orchestration.getInputSubmission(settlement.inputSubmissionId)).toMatchObject({ state: "returned" });
    expect(canonical.orchestration.getTurn(settlement.orchestrationSessionTurnId)).toMatchObject({
      state: "returned",
      finalMessageId: recorded.messageId,
    });
    expect(canonical.orchestration.listInboxItems(CONDUCTOR_SESSION_ID)
      .filter((item) => item.renderedMessageId === recorded.messageId)).toHaveLength(1);
    expect(coordinator.acceptSettlement(settlement)).toEqual({ ...recorded, status: "replayed" });
    sqlite.close();
  });
});

function seedDeliveryAndSettlement(
  canonical: ReturnType<typeof createSessionIdCanonicalStore>,
  v3: ReturnType<typeof createAcpSessionRuntimeRepositories>,
  binding: AcpSafeSessionBindingRecordV3,
): SessionExecutionSettlement {
  const content = "Execute the canonical integration proof.";
  canonical.transaction(({ message, orchestration }) => {
    message.createMessage({
      messageId: "message_canonical_integration_source",
      taskId: TASK_ID,
      runId: RUN_ID,
      kind: "conductor_forward",
      content,
      canonicalContent: [{ kind: "text", text: content }],
      contentDigest: hashDefinition(content),
      createdAt: NOW,
    });
    orchestration.createInboxItem({
      inboxItemId: "inbox_canonical_integration_source",
      taskId: TASK_ID,
      runId: RUN_ID,
      sessionId: WORKER_SESSION_ID,
      renderedMessageId: "message_canonical_integration_source",
      sequence: 1,
      priority: "ordinary",
      state: "handed",
      createdAt: NOW,
      updatedAt: NOW,
    });
    orchestration.createInputSubmission({
      inputSubmissionId: "input_canonical_integration",
      taskId: TASK_ID,
      runId: RUN_ID,
      sessionId: WORKER_SESSION_ID,
      sourceInboxItemId: "inbox_canonical_integration_source",
      contentMessageId: "message_canonical_integration_source",
      commandId: "command_canonical_integration",
      idempotencyKey: "input:canonical-integration",
      sequence: 1,
      state: "accepted",
      createdAt: NOW,
      updatedAt: NOW,
    });
    orchestration.createTurn({
      sessionTurnId: "session_turn_canonical_integration",
      taskId: TASK_ID,
      runId: RUN_ID,
      sessionId: WORKER_SESSION_ID,
      inputSubmissionId: "input_canonical_integration",
      sourceConductorSessionTurnId: "session_turn_canonical_integration_conductor",
      trigger: "conductor_send",
      state: "active",
      createdAt: NOW,
      updatedAt: NOW,
    });
  });
  const finalContent = "Canonical integration final";
  const settlement: SessionExecutionSettlement = Object.freeze({
    sessionExecutionRuntimeId: "session_execution_runtime_canonical_integration",
    sessionExecutionAttemptId: "session_execution_attempt_canonical_integration",
    taskId: TASK_ID,
    runId: RUN_ID,
    logicalSessionId: WORKER_SESSION_ID,
    bindingId: binding.bindingId,
    bindingRevision: binding.revision,
    executionProfileId: binding.executionProfileId,
    profileRevisionId: binding.profileRevisionId,
    inputSubmissionId: "input_canonical_integration",
    orchestrationSessionTurnId: "session_turn_canonical_integration",
    outcome: "completed",
    receiptDigest: RECEIPT,
    finalContent,
    finalContentDigest: hashDefinition(finalContent),
    settledAt: NOW,
  });
  v3.sessionRuntime.createRuntime({
    sessionExecutionRuntimeId: settlement.sessionExecutionRuntimeId,
    taskId: TASK_ID,
    runId: RUN_ID,
    logicalSessionId: WORKER_SESSION_ID,
    state: "idle",
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
  });
  v3.sessionRuntime.createAttempt({
    sessionExecutionAttemptId: settlement.sessionExecutionAttemptId,
    sessionExecutionRuntimeId: settlement.sessionExecutionRuntimeId,
    taskId: TASK_ID,
    runId: RUN_ID,
    logicalSessionId: WORKER_SESSION_ID,
    bindingId: binding.bindingId,
    bindingRevision: binding.revision,
    executionProfileId: binding.executionProfileId,
    profileRevisionId: binding.profileRevisionId,
    inputSubmissionId: settlement.inputSubmissionId,
    orchestrationSessionTurnId: settlement.orchestrationSessionTurnId,
    state: "settled",
    receiptDigest: RECEIPT,
    receiptObservedAt: NOW,
    interactions: [],
    finalCandidate: {
      candidateObservationId: "provider_fact_candidate_canonical_integration",
      content: finalContent,
      contentDigest: settlement.finalContentDigest!,
      observedAt: NOW,
    },
    terminal: {
      terminalObservationId: "provider_fact_terminal_canonical_integration",
      outcome: "completed",
      receiptDigest: RECEIPT,
      observedAt: NOW,
    },
    settlement,
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
  });
  return settlement;
}

function bindingRecord(): AcpSafeSessionBindingRecordV3 {
  return {
    schemaVersion: 3,
    bindingId: "binding_canonical_integration",
    taskId: TASK_ID,
    runId: RUN_ID,
    logicalSessionId: WORKER_SESSION_ID,
    agentCardId: "agent_card_canonical_integration",
    executionProfileId: "profile_canonical_integration",
    profileRevisionId: "profile_revision_canonical_integration",
    providerFamily: "opencode",
    bindingHandle: "binding_handle_canonical_integration",
    status: "active",
    recoverable: true,
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function seedLifecycle(store: SqliteRuntimeStore): void {
  store.run(`INSERT INTO templates(template_id, slug, title, status, revision, created_at, updated_at)
    VALUES ('template_canonical_integration', 'canonical-integration', 'Canonical', 'active', 1, ?, ?)`, NOW, NOW);
  store.run(`INSERT INTO template_versions(
    template_version_id, template_id, version, schema_version, definition_json,
    definition_hash, asset_manifest_hash, created_at, published_at
  ) VALUES ('template_version_canonical_integration', 'template_canonical_integration', 1, 3, '{}',
    'sha256:canonical-integration', 'sha256:empty', ?, ?)`, NOW, NOW);
  store.run(`INSERT INTO task_architecture_snapshots(
    architecture_snapshot_id, task_id, template_id, template_version_id,
    template_definition_hash, definition_json, workspace_json, created_at
  ) VALUES ('architecture_canonical_integration', ?, 'template_canonical_integration',
    'template_version_canonical_integration', 'sha256:canonical-integration', '{}',
    '{"workspaceId":"workspace_canonical_integration"}', ?)`, TASK_ID, NOW);
  store.run(`INSERT INTO tasks(
    task_id, architecture_snapshot_id, title, goal, status, active_run_id,
    revision, created_at, updated_at
  ) VALUES (?, 'architecture_canonical_integration', 'Canonical', 'Commit Final', 'running', ?, 1, ?, ?)`,
  TASK_ID, RUN_ID, NOW, NOW);
  store.run(`INSERT INTO task_runs(
    run_id, task_id, conductor_logical_session_id, status, run_number, revision, started_at
  ) VALUES (?, ?, ?, 'running', 1, 1, ?)`, RUN_ID, TASK_ID, CONDUCTOR_SESSION_ID, NOW);
  store.run(`INSERT INTO session_id_logical_sessions(
    session_id, card_session_slot_id, task_id, run_id, session_kind,
    architecture_schema_version, agent_card_id, execution_profile_id,
    profile_revision_id, generation, lifecycle, created_at
  ) VALUES (?, NULL, ?, ?, 'conductor', 3, 'agent_card_canonical_conductor',
    'profile_canonical_conductor', 'profile_revision_canonical_conductor', 1, 'current', ?)`,
  CONDUCTOR_SESSION_ID, TASK_ID, RUN_ID, NOW);
  store.run(`INSERT INTO session_id_card_session_slots(
    card_session_slot_id, task_id, run_id, agent_card_id, current_session_id,
    latest_generation, revision, created_at, updated_at
  ) VALUES ('card_session_slot_canonical_integration', ?, ?, 'agent_card_canonical_integration', ?, 1, 2, ?, ?)`,
  TASK_ID, RUN_ID, WORKER_SESSION_ID, NOW, NOW);
  store.run(`INSERT INTO session_id_logical_sessions(
    session_id, card_session_slot_id, task_id, run_id, session_kind,
    architecture_schema_version, agent_card_id, execution_profile_id,
    profile_revision_id, generation, lifecycle, created_at
  ) VALUES (?, 'card_session_slot_canonical_integration', ?, ?, 'card', 3,
    'agent_card_canonical_integration', 'profile_canonical_integration',
    'profile_revision_canonical_integration', 1, 'current', ?)`,
  WORKER_SESSION_ID, TASK_ID, RUN_ID, NOW);
}

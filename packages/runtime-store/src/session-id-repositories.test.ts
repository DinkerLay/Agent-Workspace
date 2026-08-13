import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  hashDefinition,
  type CardSessionGenerationRecord,
  type CardSessionSlotRecord,
  type ProviderFact,
  type SessionControlAuditRecord,
  type SessionIdMessageForwardRecord,
  type SessionLaneItemRecord,
  type TemplateDefinition,
  type WorkspaceEffectIntentRecord,
  type WorkspaceFileObservationRecord,
} from "@agent-workspace/runtime-contracts";
import { afterEach, describe, expect, it } from "vitest";
import {
  createSessionIdCanonicalStore,
  type SessionIdProviderBindingRecord,
  type SessionIdSessionMessageRecord,
  type SessionIdUiCommandKind,
} from "./session-id-repositories.js";
import { SqliteRuntimeStore, SUPERSEDED_PROTOCOL_TABLE_ALLOWLIST } from "./sqlite.js";

const paths: string[] = [];
const now = "2026-08-11T00:00:00.000Z";

afterEach(() => {
  for (const directory of paths.splice(0)) rmSync(directory, { force: true, recursive: true });
});

describe("canonical Session-ID store", () => {
  it("creates the canonical Session-ID tables without fresh superseded execution tables", () => {
    const directory = workspace("agent-workspace-session-id-fresh-");
    const store = new SqliteRuntimeStore({ path: path.join(directory, "runtime.sqlite") });
    expect(store.one<{ value: string }>("SELECT value FROM runtime_meta WHERE key = 'schema_version'")?.value).toBe("21");
    for (const table of [
      "session_id_tasks",
      "session_id_card_session_slots",
      "session_id_logical_sessions",
      "session_id_conductor_planning_fences",
      "session_id_session_control_audits",
      "session_id_session_messages",
      "session_id_relay_blocks",
      "session_id_message_forwards",
      "session_id_message_forward_refs",
      "session_id_session_inbox_items",
      "session_id_input_submissions",
      "session_id_session_turns",
      "session_id_human_interventions",
      "session_id_workspace_effect_intents",
      "session_id_workspace_file_observations",
      "session_id_provider_bindings",
      "session_id_provider_facts",
      "session_id_attentions",
      "session_id_command_receipts",
      "session_id_ui_command_receipts",
      "session_id_provider_effect_outbox",
      "session_id_task_permanent_delete_intents",
      "session_id_task_permanent_delete_tombstones",
    ]) {
      expect(store.one<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", table,
      )?.name).toBe(table);
    }
    for (const table of SUPERSEDED_PROTOCOL_TABLE_ALLOWLIST) {
      expect(store.one("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", table)).toBeUndefined();
    }
    expect(store.one<{ count: number }>("SELECT count(*) AS count FROM session_id_logical_sessions")?.count).toBe(0);
    expect(store.one<{ count: number }>("SELECT count(*) AS count FROM session_id_tasks")?.count).toBe(0);
    store.close();
  });

  it("retains v16 direct Binding bytes and constraints as read-only history", () => {
    const directory = workspace("agent-workspace-session-id-binding-v17-");
    const databasePath = path.join(directory, "runtime.sqlite");
    const store = new SqliteRuntimeStore({ path: databasePath });
    seedRun(store);
    const canonical = createSessionIdCanonicalStore(store);
    const binding = providerBinding({
      bindingId: "binding_conductor_v16",
      sessionId: "logical_session_conductor",
      agentCardId: "agent_card_conductor",
    });
    canonical.binding.createBinding(binding);
    const fact = bindingObservedFact(binding);
    canonical.providerFact.recordFact(fact);
    store.close();

    const raw = new DatabaseSync(databasePath);
    raw.exec(`
      PRAGMA foreign_keys = OFF;
      CREATE TABLE session_id_provider_bindings_v16 (
        binding_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(task_id),
        run_id TEXT NOT NULL REFERENCES task_runs(run_id),
        session_id TEXT NOT NULL UNIQUE,
        agent_card_id TEXT NOT NULL,
        execution_profile_id TEXT NOT NULL,
        provider TEXT NOT NULL CHECK (provider IN ('opencode', 'codex', 'claude-code')),
        provider_host_id TEXT,
        native_binding_ref TEXT,
        status TEXT NOT NULL CHECK (status IN (
          'unbound', 'binding_effect_accepted', 'active', 'recovering', 'unrecoverable'
        )),
        recoverable INTEGER NOT NULL CHECK (recoverable IN (0, 1)),
        revision INTEGER NOT NULL CHECK (revision > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(binding_id, revision)
      );
      INSERT INTO session_id_provider_bindings_v16 SELECT * FROM session_id_provider_bindings;
      DROP TABLE session_id_provider_bindings;
      ALTER TABLE session_id_provider_bindings_v16 RENAME TO session_id_provider_bindings;
      PRAGMA foreign_keys = ON;
    `);
    const retainedDefinition = (raw.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'session_id_provider_bindings'",
    ).get() as { sql: string }).sql;
    raw.close();

    const migrated = new SqliteRuntimeStore({ path: databasePath });
    const migratedCanonical = createSessionIdCanonicalStore(migrated);
    expect(migratedCanonical.binding.getBinding(binding.bindingId)).toEqual(binding);
    expect(migratedCanonical.providerFact.listFacts(binding.bindingId)).toEqual([fact]);
    expect(migrated.one<{ sql: string }>(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'session_id_provider_bindings'",
    )?.sql).toBe(retainedDefinition);
    expect(() => migratedCanonical.binding.updateBinding({
      ...binding,
      status: "released",
      revision: 2,
      updatedAt: "2026-08-11T00:01:00.000Z",
    }, binding.revision)).toThrow(/CHECK constraint failed/u);
    expect(migratedCanonical.binding.getBinding(binding.bindingId)).toEqual(binding);
    migrated.close();
  });

  it("recovers a prepared target-only permanent delete after reopen and leaves unowned legacy Tasks intact", () => {
    const directory = workspace("agent-workspace-session-id-retention-reopen-");
    const databasePath = path.join(directory, "runtime.sqlite");
    let store = new SqliteRuntimeStore({ path: databasePath });
    seedRun(store);
    seedUnownedLegacyTask(store);
    store.run(
      `UPDATE tasks SET status = 'stopped', trashed_at = ?, achievement_json = ?, revision = 2, updated_at = ?
       WHERE task_id = 'task_session_id'`,
      now, JSON.stringify({ achievedAt: now }), now,
    );
    store.run(
      `UPDATE task_runs SET status = 'stopped', ended_at = ?, revision = 2
       WHERE run_id = 'run_session_id'`,
      now,
    );
    store.run(
      "INSERT INTO workspace_authorizations(workspace_id, canonical_directory, display_name, authorized_at) VALUES (?, ?, ?, ?)",
      "workspace_retention", "/tmp/session-id-retention", "Retention", now,
    );
    store.run(
      `INSERT INTO task_setup_drafts(
         task_setup_draft_id, owner_id, template_version_id, workspace_id, title, goal,
         task_input_values_json, state, created_task_id, revision, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, '[]', 'consumed', ?, 2, ?, ?)`,
      "task_setup_retention", "user_retention", "template_version_session_id", "workspace_retention",
      "Retention", "Delete product records only.", "task_session_id", now, now,
    );
    let canonical = createSessionIdCanonicalStore(store);
    canonical.taskRun.registerTask("task_session_id", now);
    canonical.workspace.createObservation({
      workspaceFileObservationId: "workspace_observation_retention",
      taskId: "task_session_id",
      workspaceRelativePath: "keep/report.md",
      contentDigest: "sha256:retained-file",
      byteLength: 12,
      state: "available",
      source: "unverified",
      observedAt: now,
    });
    expect(() => canonical.retention.previewPermanentDelete("task_session_id", 1)).toThrow("task_revision_stale");
    const intent = {
      commandId: "command_delete_after_reopen",
      taskId: "task_session_id",
      expectedRevision: 2,
      payloadFingerprint: "sha256:delete-after-reopen",
      preparedAt: now,
    } as const;
    expect(canonical.retention.preparePermanentDelete(intent)).toEqual(intent);
    expect(canonical.retention.preparePermanentDelete(intent)).toEqual(intent);
    store.close();

    store = new SqliteRuntimeStore({ path: databasePath });
    canonical = createSessionIdCanonicalStore(store);
    const tombstone = canonical.retention.completePermanentDelete({
      commandId: intent.commandId,
      taskId: intent.taskId,
      payloadFingerprint: intent.payloadFingerprint,
      deletedAt: "2026-08-11T00:02:00.000Z",
    });
    expect(tombstone.result).toEqual({
      taskId: intent.taskId,
      deletedAt: "2026-08-11T00:02:00.000Z",
      workspaceFilesWillRemain: true,
    });
    expect(canonical.retention.completePermanentDelete({
      commandId: intent.commandId,
      taskId: intent.taskId,
      payloadFingerprint: intent.payloadFingerprint,
      deletedAt: "2026-08-11T00:03:00.000Z",
    })).toEqual(tombstone);
    expect(() => canonical.retention.completePermanentDelete({
      commandId: intent.commandId,
      taskId: intent.taskId,
      payloadFingerprint: "sha256:different",
      deletedAt: "2026-08-11T00:03:00.000Z",
    })).toThrow("runtime_command_id_reused_with_different_payload");
    expect(store.one("SELECT task_id FROM tasks WHERE task_id = 'task_session_id'")).toBeUndefined();
    expect(store.one("SELECT task_id FROM session_id_tasks WHERE task_id = 'task_session_id'")).toBeUndefined();
    expect(store.one("SELECT workspace_file_observation_id FROM session_id_workspace_file_observations WHERE task_id = 'task_session_id'"))
      .toBeUndefined();
    expect(store.one<{ created_task_id: string | null }>(
      "SELECT created_task_id FROM task_setup_drafts WHERE task_setup_draft_id = 'task_setup_retention'",
    )?.created_task_id).toBeNull();
    expect(store.one("SELECT task_id FROM tasks WHERE task_id = 'task_legacy_unowned'")).toBeDefined();
    expect(canonical.taskRun.ownsTask("task_legacy_unowned")).toBe(false);
    expect(store.one<{ table: string }>("PRAGMA foreign_key_check")).toBeUndefined();
    store.close();
  });

  it("keeps a historical v2 Architecture read-only for Slot and generation materialization", () => {
    const { store, canonical } = setup();
    const first = generation(1);
    expect(() => canonical.taskRun.initializeSlot({
      ...first.slot,
      currentSessionId: undefined,
      latestGeneration: 0,
      revision: 1,
    })).toThrow("session_id_slot_requires_v3_architecture");
    expect(() => canonical.taskRun.materializeGeneration(first.slot, first.session))
      .toThrow("session_id_generation_requires_v3_architecture");
    expect(canonical.taskRun.findSlot("run_session_id", "agent_card_worker")).toBeUndefined();
    expect(canonical.taskRun.listGenerations(first.slot.cardSessionSlotId)).toEqual([]);
    store.close();
  });

  it("commits Message + Forward + refs + Inbox atomically and preserves FIFO sequence", () => {
    const { store, canonical } = setupWithGeneration();
    const source = message("message_source", "agent_final", "Source final");
    canonical.message.createMessage(source);
    const target = message("message_target", "conductor_forward", "Use Source final");
    const forward: SessionIdMessageForwardRecord = {
      forwardId: "forward_1",
      taskId: target.taskId,
      runId: target.runId,
      commandId: "command_send_1",
      idempotencyKey: "send-1",
      decidedBySessionTurnId: "session_turn_conductor_1",
      targetSessionId: "logical_session_worker_g1",
      newContentDigest: hashDefinition("Use"),
      orderedReferenceSnapshots: [{
        ordinal: 0,
        kind: "full_message",
        sourceMessageId: source.messageId,
        contentDigest: source.contentDigest,
      }],
      renderedMessageId: target.messageId,
      createdAt: now,
    };
    const inbox = lane("inbox_1", target.messageId, forward.forwardId, 1);

    expect(() => canonical.transaction(({ message: messages, orchestration }) => {
      messages.createMessage(target);
      messages.createForward(forward);
      orchestration.createInboxItem(inbox);
      throw new Error("crash_after_durable_send");
    })).toThrow("crash_after_durable_send");
    expect(canonical.message.getMessage(target.messageId)).toBeUndefined();
    expect(canonical.message.getForward(forward.forwardId)).toBeUndefined();
    expect(canonical.orchestration.getInboxItem(inbox.inboxItemId)).toBeUndefined();

    canonical.transaction(({ message: messages, orchestration }) => {
      messages.createMessage(target);
      messages.createForward(forward);
      orchestration.createInboxItem(inbox);
    });
    const secondTarget = message("message_target_2", "conductor_forward", "Continue");
    const secondForward: SessionIdMessageForwardRecord = {
      ...forward,
      forwardId: "forward_2",
      commandId: "command_send_2",
      idempotencyKey: "send-2",
      newContentDigest: secondTarget.contentDigest,
      orderedReferenceSnapshots: [],
      renderedMessageId: secondTarget.messageId,
    };
    canonical.transaction(({ message: messages, orchestration }) => {
      messages.createMessage(secondTarget);
      messages.createForward(secondForward);
      orchestration.createInboxItem(lane("inbox_2", secondTarget.messageId, secondForward.forwardId, 2));
    });
    expect(canonical.message.getForward(forward.forwardId)).toEqual(forward);
    expect(canonical.message.findForwardByIdempotencyKey(target.taskId, target.runId, "send-1")).toEqual(forward);
    expect(canonical.orchestration.listInboxItems("logical_session_worker_g1").map((item) => item.sequence)).toEqual([1, 2]);
    expect(() => canonical.orchestration.createInboxItem(lane("inbox_duplicate_sequence", "message_source", undefined, 2)))
      .toThrow();
    store.close();
  });

  it("atomically suppresses only pending ordinary work, records close audit and retires the generation", () => {
    const { store, canonical, slot, session } = setupWithGeneration();
    const ordinary = message("message_pending", "conductor_forward", "Pending");
    const notice = message("message_notice", "runtime_notice", "Notice");
    canonical.message.createMessage(ordinary);
    canonical.message.createMessage(notice);
    canonical.orchestration.createInboxItem(lane("inbox_pending", ordinary.messageId, undefined, 1));
    canonical.orchestration.createInboxItem({
      ...lane("inbox_notice", notice.messageId, undefined, 2),
      priority: "notice",
      causalPredecessorInboxItemId: "inbox_pending",
    });
    const closedAt = "2026-08-11T00:02:00.000Z";
    const closedSlot: CardSessionSlotRecord = { ...slot, currentSessionId: undefined, revision: 2, updatedAt: closedAt };
    const closedSession: CardSessionGenerationRecord = { ...session, lifecycle: "closed", closedAt };

    expect(() => canonical.transaction(({ orchestration, taskRun }) => {
      const affected = orchestration.suppressPendingOrdinary(session.sessionId, "session_closed", closedAt);
      orchestration.createControlAudit(closeAudit(affected, closedAt));
      taskRun.retireGeneration(closedSlot, { ...closedSession, lifecycle: "current", closedAt: undefined }, slot.revision);
    })).toThrow("session_id_generation_close_invalid");
    expect(canonical.orchestration.getInboxItem("inbox_pending")?.state).toBe("pending");
    expect(canonical.orchestration.getControlAudit("session_control_close_1")).toBeUndefined();
    expect(canonical.taskRun.getGeneration(session.sessionId)?.lifecycle).toBe("current");

    canonical.transaction(({ orchestration, taskRun }) => {
      const affected = orchestration.suppressPendingOrdinary(session.sessionId, "session_closed", closedAt);
      orchestration.createControlAudit(closeAudit(affected, closedAt));
      taskRun.retireGeneration(closedSlot, closedSession, slot.revision);
    });
    expect(canonical.orchestration.getInboxItem("inbox_pending")).toMatchObject({ state: "suppressed", reason: "session_closed" });
    expect(canonical.orchestration.getInboxItem("inbox_notice")?.state).toBe("pending");
    expect(canonical.orchestration.getControlAudit("session_control_close_1")?.affectedInboxItemIds).toEqual(["inbox_pending"]);
    expect(canonical.taskRun.getGeneration(session.sessionId)).toEqual(closedSession);
    expect(canonical.taskRun.getSlot(slot.cardSessionSlotId)).toEqual(closedSlot);
    store.close();
  });

  it("persists publisher effect intent before the observation without creating Artifact ownership", () => {
    const { store, canonical } = setupWithGeneration();
    const intent: WorkspaceEffectIntentRecord = {
      workspaceEffectIntentId: "workspace_effect_1",
      taskId: "task_session_id",
      runId: "run_session_id",
      publisherSessionId: "logical_session_worker_g1",
      publisherSessionTurnId: "session_turn_publisher_1",
      providerCallId: "provider_call_1",
      idempotencyKey: "workspace-effect-1",
      workspaceRelativePath: "deliverables/report.md",
      contentDigest: "sha256:report",
      byteLength: 128,
      state: "pending",
      createdAt: now,
      updatedAt: now,
    };
    canonical.workspace.createEffectIntent(intent);
    expect(canonical.workspace.findEffectIntentByIdempotencyKey(intent.taskId, intent.idempotencyKey)).toEqual(intent);
    expect(canonical.workspace.findEffectIntentByProviderCallId(intent.taskId, intent.providerCallId)).toEqual(intent);
    expect(canonical.workspace.findEffectIntentByProviderCallId("task_other", intent.providerCallId)).toBeUndefined();
    const observation: WorkspaceFileObservationRecord = {
      workspaceFileObservationId: "workspace_observation_1",
      taskId: intent.taskId,
      runId: intent.runId,
      workspaceRelativePath: intent.workspaceRelativePath,
      contentDigest: intent.contentDigest,
      byteLength: intent.byteLength,
      state: "available",
      source: "verified_tool",
      observedAt: "2026-08-11T00:03:00.000Z",
    };
    expect(() => canonical.workspace.createObservation(observation)).toThrow("workspace_observation_verified_intent_required");
    canonical.transaction(({ workspace }) => {
      workspace.createObservation(observation, intent.workspaceEffectIntentId);
      workspace.updateEffectIntent({
        ...intent,
        state: "applied",
        observationId: observation.workspaceFileObservationId,
        updatedAt: observation.observedAt,
      });
    });
    expect(canonical.workspace.getObservation(observation.workspaceFileObservationId)).toEqual(observation);
    expect(canonical.workspace.getEffectIntent(intent.workspaceEffectIntentId)).toMatchObject({
      state: "applied",
      observationId: observation.workspaceFileObservationId,
    });
    expect(store.one("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'artifacts'")).toBeUndefined();
    store.close();
  });

  it("persists target Card and Conductor Bindings plus deduplicated Provider facts without touching legacy sessions", () => {
    const { store, canonical } = setupWithGeneration();
    const card = providerBinding({
      bindingId: "binding_worker_g1",
      sessionId: "logical_session_worker_g1",
      agentCardId: "agent_card_worker",
    });
    const conductor = providerBinding({
      bindingId: "binding_conductor",
      sessionId: "logical_session_conductor",
      agentCardId: "agent_card_conductor",
    });
    canonical.binding.createBinding(card);
    canonical.binding.createBinding(conductor);
    expect(canonical.binding.getBindingForSession(card.sessionId)).toEqual(card);
    expect(canonical.binding.getBindingForSession(conductor.sessionId)).toEqual(conductor);

    const fact = bindingObservedFact(card);
    expect(canonical.providerFact.recordFact(fact)).toBe(true);
    expect(canonical.providerFact.recordFact(fact)).toBe(false);
    expect(canonical.providerFact.listFacts(card.bindingId)).toEqual([fact]);
    expect(() => canonical.providerFact.recordFact({ ...fact, bindingRevision: 2, providerFactId: "provider_fact_wrong_revision" }))
      .toThrow("session_id_provider_fact_binding_mismatch");

    const active: SessionIdProviderBindingRecord = {
      ...card,
      nativeBindingRef: "native_thread_worker_g1",
      providerHostId: "provider_host_codex_1",
      status: "active",
      recoverable: true,
      revision: 2,
      updatedAt: "2026-08-11T00:04:00.000Z",
    };
    canonical.binding.updateBinding(active, 1);
    expect(canonical.providerFact.recordFact({
      ...fact,
      providerFactId: "provider_fact_binding_replayed_after_recovery",
      bindingRevision: active.revision,
    })).toBe(false);
    expect(() => canonical.providerFact.recordFact({
      ...fact,
      providerFactId: "provider_fact_binding_conflicting_payload",
      bindingRevision: active.revision,
      payload: { nativeBindingRef: "native_thread_other" },
    })).toThrow("session_id_provider_fact_dedup_conflict");
    expect(() => canonical.providerFact.recordFact({
      ...fact,
      providerFactId: "provider_fact_binding_conflicting_correlation",
      bindingRevision: active.revision,
      correlation: { inputSubmissionId: "input_other" },
    })).toThrow("session_id_provider_fact_dedup_conflict");
    const staleEvidence: ProviderFact = {
      ...fact,
      providerFactId: "provider_fact_stale_transport",
      kind: "transport_unknown",
      deduplication: { providerEventId: "codex:binding:worker-g1:stale-transport" },
      payload: { reason: "recovered_after_owner_revision_advance" },
    };
    expect(canonical.providerFact.recordFact(staleEvidence)).toBe(true);
    expect(() => canonical.binding.updateBinding({ ...active, revision: 3 }, 1))
      .toThrow("session_id_binding_revision_conflict");
    expect(canonical.binding.getBinding(card.bindingId)).toEqual(active);
    expect(store.one("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'provider_session_bindings'")).toBeUndefined();
    store.close();
  });

  it("supports the Conductor lane, Fence/Human recovery queries, targeted effect suppression and five UI receipts", () => {
    const { store, canonical } = setupWithGeneration();
    const conductorMessage = {
      ...message("message_conductor_input", "user_input", "User changed the goal."),
      sourceSessionId: undefined,
    };
    canonical.message.createMessage(conductorMessage);
    canonical.orchestration.createInboxItem({
      ...lane("inbox_conductor_input", conductorMessage.messageId, undefined, 1),
      sessionId: "logical_session_conductor",
      priority: "human",
    });
    expect(canonical.orchestration.listInboxItems("logical_session_conductor"))
      .toEqual([expect.objectContaining({ inboxItemId: "inbox_conductor_input", priority: "human" })]);
    const conductorInput = {
      inputSubmissionId: "input_conductor_next",
      taskId: "task_session_id",
      runId: "run_session_id",
      sessionId: "logical_session_conductor",
      sourceInboxItemId: "inbox_conductor_input",
      contentMessageId: conductorMessage.messageId,
      commandId: "command_conductor_delivery",
      idempotencyKey: "conductor-delivery:next",
      sequence: 1,
      state: "pending" as const,
      createdAt: now,
      updatedAt: now,
    };
    const conductorTurn = {
      sessionTurnId: "session_turn_conductor_next",
      taskId: "task_session_id",
      runId: "run_session_id",
      sessionId: "logical_session_conductor",
      inputSubmissionId: conductorInput.inputSubmissionId,
      trigger: "human" as const,
      state: "pending" as const,
      createdAt: now,
      updatedAt: now,
    };
    canonical.orchestration.createInputSubmission(conductorInput);
    canonical.orchestration.createTurn(conductorTurn);
    canonical.reliability.createProviderEffect({
      outboxId: "provider_effect_conductor_delivery",
      taskId: "task_session_id",
      runId: "run_session_id",
      sessionId: "logical_session_conductor",
      sessionTurnId: conductorTurn.sessionTurnId,
      kind: "submit_delivery",
      idempotencyKey: "provider:conductor-delivery:next",
      payload: {
        inboxItemId: "inbox_conductor_input",
        inputSubmissionId: conductorInput.inputSubmissionId,
        sessionTurnId: conductorTurn.sessionTurnId,
        contentMessageId: conductorMessage.messageId,
      },
      payloadFingerprint: "sha256:conductor-delivery",
      state: "pending",
      attempts: 0,
      createdAt: now,
      updatedAt: now,
    });
    expect(canonical.orchestration.getInputSubmission(conductorInput.inputSubmissionId)).toEqual(conductorInput);
    expect(canonical.orchestration.getTurn(conductorTurn.sessionTurnId)).toEqual(conductorTurn);
    expect(canonical.reliability.getProviderEffect("provider_effect_conductor_delivery"))
      .toMatchObject({ sessionId: "logical_session_conductor", kind: "submit_delivery" });
    expect(() => canonical.orchestration.createInboxItem({
      ...lane("inbox_forged_target", conductorMessage.messageId, undefined, 1),
      sessionId: "logical_session_forged",
    })).toThrow("session_id_inbox_target_scope_mismatch");

    const fence = {
      planningFenceId: "planning_fence_1",
      taskId: "task_session_id",
      runId: "run_session_id",
      sourceCommandId: "command_task_input_1",
      previousConductorSessionTurnId: "session_turn_conductor_old",
      currentConductorSessionTurnId: "session_turn_conductor_next",
      createdAt: now,
    } as const;
    canonical.taskRun.createPlanningFence(fence);
    expect(canonical.taskRun.findPlanningFenceBySourceCommand(fence.runId, fence.sourceCommandId)).toEqual(fence);
    expect(canonical.taskRun.readTaskRunState("task_session_id", "run_session_id")).toMatchObject({
      taskRevision: 1,
      runStatus: "running",
      currentConductorSessionTurnId: fence.currentConductorSessionTurnId,
    });
    canonical.taskRun.acceptTaskInput({
      taskId: "task_session_id",
      runId: "run_session_id",
      commandId: fence.sourceCommandId,
      expectedRevision: 1,
      nextRevision: 2,
      planningFenceId: fence.planningFenceId,
      messageId: conductorMessage.messageId,
      previousConductorSessionTurnId: fence.previousConductorSessionTurnId,
      currentConductorSessionTurnId: fence.currentConductorSessionTurnId!,
      acceptedAt: now,
    });
    expect(canonical.taskRun.readTaskRunState("task_session_id", "run_session_id").taskRevision).toBe(2);

    const intervention = {
      humanInterventionId: "human_intervention_1",
      taskId: "task_session_id",
      runId: "run_session_id",
      commandId: "command_human_1",
      idempotencyKey: "human:1",
      targetSessionId: "logical_session_worker_g1",
      mode: "direct_message" as const,
      state: "accepted" as const,
      createdAt: now,
      updatedAt: now,
    };
    canonical.humanIntervention.create(intervention);
    expect(canonical.humanIntervention.list("run_session_id")).toEqual([intervention]);
    expect(canonical.humanIntervention.list("run_session_id", "logical_session_worker_g1")).toEqual([intervention]);

    for (const [index, kind] of ([
      "ensure_binding",
      "submit_delivery",
      "request_interrupt",
    ] as const).entries()) {
      canonical.reliability.createProviderEffect({
        outboxId: `provider_effect_${kind}`,
        taskId: "task_session_id",
        runId: "run_session_id",
        sessionId: "logical_session_worker_g1",
        kind,
        idempotencyKey: `effect:${kind}`,
        payload: {},
        payloadFingerprint: `sha256:${kind}`,
        state: "pending",
        attempts: 0,
        createdAt: `${now.slice(0, -5)}${index}Z`,
        updatedAt: now,
      });
    }
    expect(canonical.reliability.suppressPendingProviderEffects(
      "logical_session_worker_g1",
      ["ensure_binding", "submit_delivery"],
      "session_closed",
      now,
    )).toEqual(["provider_effect_ensure_binding", "provider_effect_submit_delivery"]);
    expect(canonical.reliability.listProviderEffects("logical_session_worker_g1")).toEqual([
      expect.objectContaining({ kind: "ensure_binding", state: "suppressed" }),
      expect.objectContaining({ kind: "submit_delivery", state: "suppressed" }),
      expect.objectContaining({ kind: "request_interrupt", state: "pending" }),
    ]);
    expect(canonical.reliability.suppressProviderEffect(
      "provider_effect_request_interrupt", "task_stopped", now,
    )).toBe(true);
    expect(canonical.reliability.suppressProviderEffect(
      "provider_effect_request_interrupt", "task_stopped", now,
    )).toBe(false);
    canonical.reliability.createProviderEffect({
      outboxId: "provider_effect_leased_not_suppressible",
      taskId: "task_session_id",
      runId: "run_session_id",
      sessionId: "logical_session_worker_g1",
      kind: "ensure_binding",
      idempotencyKey: "effect:leased-not-suppressible",
      payload: {},
      payloadFingerprint: "sha256:leased",
      state: "pending",
      attempts: 0,
      createdAt: "2026-08-11T00:00:05.000Z",
      updatedAt: now,
    });
    expect(canonical.reliability.claimNextProviderEffect(
      "task_session_id", "run_session_id", now, "2026-08-11T00:01:00.000Z",
    )).toMatchObject({ outboxId: "provider_effect_conductor_delivery", state: "leased" });
    expect(canonical.reliability.suppressProviderEffect(
      "provider_effect_conductor_delivery", "task_stopped", now,
    )).toBe(false);

    const uiKinds: readonly SessionIdUiCommandKind[] = [
      "task.submit_input",
      "session.send_human_message",
      "session.abandon_human_message",
      "session.request_interrupt",
      "session.respond_interaction",
      "session.respond_attention",
      "task.stop",
      "workspace.preview_file",
    ];
    for (const [index, commandKind] of uiKinds.entries()) {
      const receipt = {
        commandId: `ui_command_${index}`,
        taskId: "task_session_id",
        runId: "run_session_id",
        commandKind,
        idempotencyKey: `ui:${index}`,
        payloadFingerprint: `sha256:ui-${index}`,
        result: { status: "accepted" },
        createdAt: now,
      } as const;
      canonical.reliability.createUiCommandReceipt(receipt);
      canonical.reliability.createUiCommandReceipt(receipt);
      expect(canonical.reliability.getUiCommandReceipt(receipt.taskId, receipt.commandId)).toEqual(receipt);
      expect(() => canonical.reliability.createUiCommandReceipt({
        ...receipt,
        payloadFingerprint: "sha256:conflict",
      })).toThrow("session_id_ui_command_receipt_conflict");
    }
    store.close();
  });
});

function setup(): { store: SqliteRuntimeStore; canonical: ReturnType<typeof createSessionIdCanonicalStore> } {
  const directory = workspace("agent-workspace-session-id-store-");
  const store = new SqliteRuntimeStore({ path: path.join(directory, "runtime.sqlite") });
  seedRun(store);
  return { store, canonical: createSessionIdCanonicalStore(store) };
}

function setupWithGeneration(): ReturnType<typeof setup> & {
  slot: CardSessionSlotRecord;
  session: CardSessionGenerationRecord;
} {
  const setupValue = setup();
  const first = generation(1);
  setupValue.store.transaction(() => {
    setupValue.store.run(
      `INSERT INTO session_id_card_session_slots(
         card_session_slot_id, task_id, run_id, agent_card_id, current_session_id,
         latest_generation, revision, created_at, updated_at
       ) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
      first.slot.cardSessionSlotId, first.slot.taskId, first.slot.runId, first.slot.agentCardId,
      first.slot.latestGeneration, first.slot.revision, first.slot.createdAt, first.slot.updatedAt,
    );
    setupValue.store.run(
      `INSERT INTO session_id_logical_sessions(
         session_id, card_session_slot_id, task_id, run_id, session_kind,
         architecture_schema_version, agent_card_id, execution_profile_id,
         profile_revision_id, generation, lifecycle, created_at, closed_at
       ) VALUES (?, ?, ?, ?, 'card', 2, ?, ?, NULL, ?, ?, ?, NULL)`,
      first.session.sessionId, first.session.cardSessionSlotId, first.session.taskId, first.session.runId,
      first.session.agentCardId, first.session.executionProfileId, first.session.generation,
      first.session.lifecycle, first.session.createdAt,
    );
    setupValue.store.run(
      "UPDATE session_id_card_session_slots SET current_session_id = ? WHERE card_session_slot_id = ?",
      first.session.sessionId,
      first.slot.cardSessionSlotId,
    );
  });
  return { ...setupValue, ...first };
}

function workspace(prefix: string): string {
  const directory = mkdtempSync(path.join(tmpdir(), prefix));
  paths.push(directory);
  return directory;
}

function seedRun(store: SqliteRuntimeStore): void {
  store.run(
    "INSERT INTO templates(template_id, slug, title, status, revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    "template_session_id", "session-id", "Session ID", "active", 1, now, now,
  );
  store.run(
    `INSERT INTO template_versions(
       template_version_id, template_id, version, schema_version, definition_json,
       definition_hash, asset_manifest_hash, created_at, published_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    "template_version_session_id", "template_session_id", 1, 2, JSON.stringify(SESSION_ID_DEFINITION_V2),
    hashDefinition(SESSION_ID_DEFINITION_V2 as never), "sha256:empty", now, now,
  );
  store.run(
    `INSERT INTO task_architecture_snapshots(
       architecture_snapshot_id, task_id, template_id, template_version_id,
       template_definition_hash, definition_json, workspace_json, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    "architecture_session_id", "task_session_id", "template_session_id", "template_version_session_id",
    hashDefinition(SESSION_ID_DEFINITION_V2 as never), JSON.stringify(SESSION_ID_DEFINITION_V2),
    "{\"workspaceId\":\"workspace_session_id\",\"cwd\":\"/tmp\"}", now,
  );
  store.run(
    `INSERT INTO tasks(
       task_id, architecture_snapshot_id, title, goal, status, active_run_id, revision, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    "task_session_id", "architecture_session_id", "Session ID", "Exercise the canonical store.",
    "running", "run_session_id", 1, now, now,
  );
  store.run(
    `INSERT INTO task_runs(
       run_id, task_id, conductor_logical_session_id, status, run_number, revision, started_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    "run_session_id", "task_session_id", "logical_session_conductor", "running", 1, 1, now,
  );
}

function seedUnownedLegacyTask(store: SqliteRuntimeStore): void {
  store.run(
    `INSERT INTO task_architecture_snapshots(
       architecture_snapshot_id, task_id, template_id, template_version_id,
       template_definition_hash, definition_json, workspace_json, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    "architecture_legacy_unowned", "task_legacy_unowned", "template_session_id", "template_version_session_id",
    "fnv1a64:legacy", "{}", "{\"workspaceId\":\"workspace_legacy\",\"cwd\":\"/tmp/legacy\"}", now,
  );
  store.run(
    `INSERT INTO tasks(
       task_id, architecture_snapshot_id, title, goal, status, revision, created_at, updated_at
     ) VALUES (?, ?, ?, ?, 'queued', 1, ?, ?)`,
    "task_legacy_unowned", "architecture_legacy_unowned", "Legacy", "Remain superseded.", now, now,
  );
}

function generation(number: number, previous?: CardSessionSlotRecord): {
  slot: CardSessionSlotRecord;
  session: CardSessionGenerationRecord;
} {
  const sessionId = `logical_session_worker_g${number}`;
  const slot: CardSessionSlotRecord = {
    cardSessionSlotId: "card_session_slot_worker",
    taskId: "task_session_id",
    runId: "run_session_id",
    agentCardId: "agent_card_worker",
    currentSessionId: sessionId,
    latestGeneration: number,
    revision: (previous?.revision ?? 0) + 1,
    createdAt: previous?.createdAt ?? now,
    updatedAt: number === 1 ? now : "2026-08-11T00:02:00.000Z",
  };
  return {
    slot,
    session: {
      sessionId,
      cardSessionSlotId: slot.cardSessionSlotId,
      taskId: slot.taskId,
      runId: slot.runId,
      agentCardId: slot.agentCardId,
      executionProfileId: "profile_session-id-worker",
      generation: number,
      lifecycle: "current",
      createdAt: slot.updatedAt,
    },
  };
}

const SESSION_ID_CAPABILITY_POLICY = Object.freeze({
  requiredCapabilities: [
    "create_binding",
    "resume_binding",
    "input_correlation",
    "provider_receipt",
    "reconcile",
    "interrupt",
  ],
  allowedTools: [],
  permissionMode: "deny" as const,
  maxConcurrentTurns: 1,
  maxNativeChildren: 0,
} satisfies TemplateDefinition["executionProfiles"][number]["capabilityPolicy"]);

const SESSION_ID_DEFINITION_V2: TemplateDefinition = {
  schemaVersion: 2,
  conductor: {
    agentCardId: "agent_card_conductor",
    kind: "conductor",
    title: "Conductor",
    executionProfileId: "profile_session-id-conductor",
    systemPrompt: "Coordinate the fixture.",
    capabilityRefs: [],
  },
  agentCards: [{
    agentCardId: "agent_card_worker",
    kind: "general",
    title: "Worker",
    executionProfileId: "profile_session-id-worker",
    systemPrompt: "Work on the fixture.",
    capabilityRefs: [],
    dispatchProfile: { title: "Fixture", description: "Fixture work." },
  }],
  executionProfiles: [
    {
      executionProfileId: "profile_session-id-conductor",
      provider: "codex",
      model: "fixture",
      providerVersion: "preserved",
      protocolFingerprint: "preserved",
      capabilityPolicy: SESSION_ID_CAPABILITY_POLICY,
    },
    {
      executionProfileId: "profile_session-id-worker",
      provider: "codex",
      model: "fixture",
      providerVersion: "preserved",
      protocolFingerprint: "preserved",
      capabilityPolicy: SESSION_ID_CAPABILITY_POLICY,
    },
  ],
  routingPolicy: { mode: "agent_loop", maxConcurrentInvocations: 1, maxDispatchesPerDecision: 1 },
  deliverables: [],
};

function providerBinding(input: {
  bindingId: string;
  sessionId: string;
  agentCardId: string;
}): SessionIdProviderBindingRecord {
  return {
    ...input,
    taskId: "task_session_id",
    runId: "run_session_id",
    executionProfileId: `profile_${input.agentCardId}`,
    provider: "codex",
    status: "unbound",
    recoverable: false,
    revision: 1,
    createdAt: now,
    updatedAt: now,
  };
}

function bindingObservedFact(binding: SessionIdProviderBindingRecord): ProviderFact {
  return {
    providerFactId: "provider_fact_binding_observed",
    provider: binding.provider,
    bindingId: binding.bindingId,
    bindingRevision: binding.revision,
    kind: "binding_observed",
    deduplication: { providerEventId: "codex:binding:worker-g1" },
    correlation: {},
    payload: { nativeBindingRef: "native_thread_worker_g1" },
    observedAt: "2026-08-11T00:03:30.000Z",
  };
}

function message(
  messageId: string,
  kind: SessionIdSessionMessageRecord["kind"],
  content: string,
): SessionIdSessionMessageRecord {
  return {
    messageId,
    taskId: "task_session_id",
    runId: "run_session_id",
    sourceSessionId: "logical_session_worker_g1",
    kind,
    content,
    canonicalContent: [{ kind: "text", text: content }],
    contentDigest: hashDefinition(content),
    createdAt: now,
  };
}

function lane(inboxItemId: string, renderedMessageId: string, forwardId: string | undefined, sequence: number): SessionLaneItemRecord {
  return {
    inboxItemId,
    taskId: "task_session_id",
    runId: "run_session_id",
    sessionId: "logical_session_worker_g1",
    renderedMessageId,
    sequence,
    priority: "ordinary",
    state: "pending",
    ...(forwardId ? { forwardId } : {}),
    createdAt: now,
    updatedAt: now,
  };
}

function closeAudit(affectedInboxItemIds: readonly string[], requestedAt: string): SessionControlAuditRecord {
  return {
    sessionControlAuditId: "session_control_close_1",
    taskId: "task_session_id",
    runId: "run_session_id",
    sessionId: "logical_session_worker_g1",
    commandId: "command_close_1",
    idempotencyKey: "close-1",
    kind: "close",
    state: "closed",
    affectedInboxItemIds,
    requestedAt,
    settledAt: requestedAt,
  };
}

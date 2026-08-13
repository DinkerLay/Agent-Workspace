import type {
  CanonicalContent,
  CardSessionGenerationRecord,
  CardSessionSlotRecord,
  ConductorPlanningFenceRecord,
  JsonValue,
  MessageReferenceSnapshot,
  ProviderFact,
  ProviderKind,
  SessionControlAuditRecord,
  SessionIdAttentionRecord,
  SessionIdMessageForwardRecord,
  SessionLaneItemRecord,
  TaskRecord,
  TaskRunRecord,
  WorkspaceEffectIntentRecord,
  WorkspaceFileObservationRecord,
} from "@agent-workspace/runtime-contracts";
import {
  isTemplateDefinitionV3,
  providerFactDedupKey,
  providerFactFingerprint,
  validateTemplateDefinitionSnapshot,
} from "@agent-workspace/runtime-contracts";
import { decodeJson, encodeJson, SqliteRuntimeStore } from "./sqlite.js";

type Row = Record<string, unknown>;

/** Immutable collaboration payload owned by the new Session-ID Message service. */
export type SessionIdSessionMessageRecord = Readonly<{
  messageId: string;
  taskId: string;
  runId: string;
  sourceSessionId?: string;
  sourceSessionTurnId?: string;
  sourceHumanInterventionId?: string;
  kind: "task_goal" | "user_input" | "conductor_forward" | "agent_final" | "runtime_notice";
  content: string;
  canonicalContent: CanonicalContent;
  contentDigest: string;
  createdAt: string;
}>;

export type SessionIdRelayBlockRecord = Readonly<{
  relayBlockId: string;
  sourceMessageId: string;
  ordinal: number;
  suggestedTargetAgentCardIds: readonly string[];
  suggestedAudience?: "one" | "publish";
  topic?: string;
  format: "text/markdown" | "application/json";
  content: string;
  contentDigest: string;
  sourceStart: number;
  sourceEnd: number;
  createdAt: string;
}>;

export type SessionIdInputSubmissionRecord = Readonly<{
  inputSubmissionId: string;
  taskId: string;
  runId: string;
  sessionId: string;
  sourceInboxItemId: string;
  contentMessageId: string;
  commandId: string;
  idempotencyKey: string;
  sequence: number;
  state: "pending" | "handed" | "accepted" | "returned" | "ambiguous" | "failed" | "cancelled";
  createdAt: string;
  updatedAt: string;
}>;

export type SessionIdSessionTurnRecord = Readonly<{
  sessionTurnId: string;
  taskId: string;
  runId: string;
  sessionId: string;
  inputSubmissionId: string;
  sourceConductorSessionTurnId?: string;
  trigger: "task_goal" | "human" | "conductor_send" | "session_return" | "attention" | "recovery";
  state: "pending" | "active" | "returned" | "completed" | "failed" | "interrupted" | "cancelled" | "ambiguous";
  finalMessageId?: string;
  createdAt: string;
  updatedAt: string;
  settledAt?: string;
}>;

export type SessionIdCommandReceiptRecord = Readonly<{
  commandId: string;
  taskId: string;
  runId: string;
  commandKind: "invoke_agent" | "send_to_session" | "interrupt_session" | "close_session";
  idempotencyKey: string;
  payloadFingerprint: string;
  result: JsonValue;
  createdAt: string;
}>;

export type SessionIdProviderEffectIntentRecord = Readonly<{
  outboxId: string;
  taskId: string;
  runId: string;
  sessionId: string;
  sessionTurnId?: string;
  sessionControlAuditId?: string;
  attentionId?: string;
  kind: "ensure_binding" | "submit_delivery" | "request_interrupt" | "respond_attention" | "release_binding";
  idempotencyKey: string;
  payload: JsonValue;
  payloadFingerprint: string;
  state: "pending" | "leased" | "accepted" | "rejected" | "unknown" | "suppressed";
  attempts: number;
  leaseUntil?: string;
  receipt?: JsonValue;
  reason?: string;
  createdAt: string;
  updatedAt: string;
}>;

export type SessionIdProviderBindingStatus =
  | "unbound"
  | "binding_effect_accepted"
  | "active"
  | "recovering"
  | "released"
  | "unrecoverable";

export type SessionIdProviderBindingRecord = Readonly<{
  bindingId: string;
  taskId: string;
  runId: string;
  sessionId: string;
  agentCardId: string;
  executionProfileId: string;
  provider: ProviderKind;
  providerHostId?: string;
  nativeBindingRef?: string;
  status: SessionIdProviderBindingStatus;
  recoverable: boolean;
  revision: number;
  createdAt: string;
  updatedAt: string;
}>;

export type SessionIdUiCommandKind =
  | "task.submit_input"
  | "session.send_human_message"
  | "session.abandon_human_message"
  | "session.request_interrupt"
  | "session.respond_interaction"
  | "session.respond_attention"
  | "task.stop"
  | "workspace.preview_file";

export type SessionIdUiCommandReceiptRecord = Readonly<{
  commandId: string;
  taskId: string;
  runId: string;
  commandKind: SessionIdUiCommandKind;
  idempotencyKey: string;
  payloadFingerprint: string;
  result: JsonValue;
  createdAt: string;
}>;

export type SessionIdHumanInterventionRecord = Readonly<{
  humanInterventionId: string;
  taskId: string;
  runId: string;
  commandId: string;
  idempotencyKey: string;
  targetSessionId: string;
  mode: "direct_message" | "interrupt_then_send" | "scoped_interrupt" | "attention_response";
  state: "accepted" | "held" | "delivered" | "abandoned" | "cancelled_by_task_stop" | "resolved";
  cardMessageId?: string;
  conductorMirrorMessageId?: string;
  affectedSessionTurnId?: string;
  attentionId?: string;
  authenticatedUserId?: string;
  createdAt: string;
  updatedAt: string;
}>;

export interface SessionIdTaskRunStore {
  /** Explicit target ownership marker; legacy Task rows are never inferred into this registry. */
  readonly registerTask: (taskId: string, createdAt: string) => void;
  readonly ownsTask: (taskId: string) => boolean;
  readonly listOwnedTaskIds: () => readonly string[];
  /** Stable read projection over every historical Run owned by one Task. */
  readonly listRuns: (taskId: string) => readonly TaskRunRecord[];
  /**
   * Creates only the Task/Run owner's fresh Run identity.  Binding, Message,
   * lane and Provider-effect writers participate through the outer canonical
   * transaction rather than being smuggled into this capability.
   */
  readonly createRun: (input: Readonly<{
    task: TaskRecord;
    expectedTaskRevision: number;
    run: TaskRunRecord;
  }>) => void;
  /** Persists the stable, unmaterialized Card slot created by task.start. */
  readonly initializeSlot: (slot: CardSessionSlotRecord) => void;
  /** Resume keeps the original Run identity and updates both lifecycle rows by CAS. */
  readonly resumeRun: (input: Readonly<{
    task: TaskRecord;
    expectedTaskRevision: number;
    run: TaskRunRecord;
    expectedRunRevision: number;
  }>) => void;
  /** A Provider binding fact may advance the already-created Run from starting. */
  readonly markRunRunning: (run: TaskRunRecord, expectedRunRevision: number) => void;
  readonly materializeGeneration: (slot: CardSessionSlotRecord, generation: CardSessionGenerationRecord) => void;
  readonly getSlot: (cardSessionSlotId: string) => CardSessionSlotRecord | undefined;
  readonly findSlot: (runId: string, agentCardId: string) => CardSessionSlotRecord | undefined;
  readonly getGeneration: (sessionId: string) => CardSessionGenerationRecord | undefined;
  readonly listGenerations: (cardSessionSlotId: string) => readonly CardSessionGenerationRecord[];
  /** Run owner retires only the slotless schema-v3 Conductor logical Session. */
  readonly retireConductorSession: (input: Readonly<{
    taskId: string;
    runId: string;
    logicalSessionId: string;
    closedAt: string;
  }>) => void;
  readonly retireGeneration: (
    slot: CardSessionSlotRecord,
    generation: CardSessionGenerationRecord,
    expectedSlotRevision: number,
  ) => void;
  readonly createPlanningFence: (fence: ConductorPlanningFenceRecord) => void;
  readonly getPlanningFence: (planningFenceId: string) => ConductorPlanningFenceRecord | undefined;
  readonly findPlanningFenceBySourceCommand: (runId: string, sourceCommandId: string) => ConductorPlanningFenceRecord | undefined;
  readonly latestPlanningFence: (runId: string) => ConductorPlanningFenceRecord | undefined;
  readonly readTaskRunState: (taskId: string, runId: string) => Readonly<{
    taskId: string;
    runId: string;
    taskRevision: number;
    runStatus: string;
    currentConductorSessionTurnId?: string;
  }>;
  readonly getConductorSessionId: (taskId: string, runId: string) => string;
  readonly acceptTaskInput: (input: Readonly<{
    taskId: string;
    runId: string;
    commandId: string;
    expectedRevision: number;
    nextRevision: number;
    planningFenceId: string;
    messageId: string;
    previousConductorSessionTurnId?: string;
    currentConductorSessionTurnId: string;
    acceptedAt: string;
  }>) => void;
  readonly acceptTaskStop: (input: Readonly<{
    taskId: string;
    runId: string;
    commandId: string;
    expectedRevision: number;
    nextRevision: number;
    acceptedAt: string;
  }>) => void;
  readonly completeTaskStop: (input: Readonly<{
    taskId: string;
    runId: string;
    expectedRevision: number;
    nextRevision: number;
    completedAt: string;
  }>) => void;
  /** ACP Stop owner has already proven v3 Binding/Attempt terminal truth. */
  readonly retireCurrentSessionsForTaskStop: (input: Readonly<{
    taskId: string;
    runId: string;
    completedAt: string;
  }>) => void;
  /** Never reads the retained direct Binding table. */
  readonly completeAcpTaskStop: (input: Readonly<{
    taskId: string;
    runId: string;
    expectedRevision: number;
    nextRevision: number;
    completedAt: string;
  }>) => void;
}

export interface SessionIdMessageStore {
  readonly createMessage: (message: SessionIdSessionMessageRecord) => void;
  readonly getMessage: (messageId: string) => SessionIdSessionMessageRecord | undefined;
  readonly listMessages: (runId: string) => readonly SessionIdSessionMessageRecord[];
  readonly findFinalByTurn: (sessionTurnId: string) => SessionIdSessionMessageRecord | undefined;
  readonly createRelayBlock: (block: SessionIdRelayBlockRecord) => void;
  readonly getRelayBlock: (relayBlockId: string) => SessionIdRelayBlockRecord | undefined;
  readonly createForward: (forward: SessionIdMessageForwardRecord) => void;
  readonly getForward: (forwardId: string) => SessionIdMessageForwardRecord | undefined;
  readonly findForwardByIdempotencyKey: (taskId: string, runId: string, idempotencyKey: string) => SessionIdMessageForwardRecord | undefined;
  readonly listForwards: (runId: string) => readonly SessionIdMessageForwardRecord[];
}

export interface SessionIdHumanInterventionStore {
  readonly create: (intervention: SessionIdHumanInterventionRecord) => void;
  readonly get: (humanInterventionId: string) => SessionIdHumanInterventionRecord | undefined;
  readonly findByIdempotencyKey: (taskId: string, runId: string, idempotencyKey: string) => SessionIdHumanInterventionRecord | undefined;
  readonly list: (runId: string, targetSessionId?: string) => readonly SessionIdHumanInterventionRecord[];
  readonly update: (intervention: SessionIdHumanInterventionRecord) => void;
}

export interface SessionIdBindingStore {
  readonly createBinding: (binding: SessionIdProviderBindingRecord) => void;
  readonly getBinding: (bindingId: string) => SessionIdProviderBindingRecord | undefined;
  readonly getBindingForSession: (sessionId: string) => SessionIdProviderBindingRecord | undefined;
  readonly listBindings: (runId: string) => readonly SessionIdProviderBindingRecord[];
  readonly updateBinding: (binding: SessionIdProviderBindingRecord, expectedRevision: number) => void;
}

export interface SessionIdProviderFactStore {
  /** Returns false only for a byte-identical durable replay. */
  readonly recordFact: (fact: ProviderFact) => boolean;
  readonly findFactByDedupKey: (bindingId: string, dedupKey: string) => ProviderFact | undefined;
  readonly listFacts: (bindingId: string) => readonly ProviderFact[];
}

export interface SessionIdOrchestrationStore {
  readonly createInboxItem: (item: SessionLaneItemRecord) => void;
  readonly getInboxItem: (inboxItemId: string) => SessionLaneItemRecord | undefined;
  readonly listInboxItems: (sessionId: string) => readonly SessionLaneItemRecord[];
  readonly updateInboxItem: (item: SessionLaneItemRecord, expectedState: SessionLaneItemRecord["state"]) => void;
  /** Suppresses only never-leased ordinary Conductor work. */
  readonly suppressPendingOrdinary: (sessionId: string, reason: "session_closed" | "task_stopped", now: string) => readonly string[];
  readonly createInputSubmission: (input: SessionIdInputSubmissionRecord) => void;
  readonly getInputSubmission: (inputSubmissionId: string) => SessionIdInputSubmissionRecord | undefined;
  readonly findInputByInboxItem: (inboxItemId: string) => SessionIdInputSubmissionRecord | undefined;
  readonly updateInputSubmission: (input: SessionIdInputSubmissionRecord, expectedState: SessionIdInputSubmissionRecord["state"]) => void;
  readonly createTurn: (turn: SessionIdSessionTurnRecord) => void;
  readonly getTurn: (sessionTurnId: string) => SessionIdSessionTurnRecord | undefined;
  readonly findTurnByInputSubmission: (inputSubmissionId: string) => SessionIdSessionTurnRecord | undefined;
  readonly listTurns: (sessionId: string) => readonly SessionIdSessionTurnRecord[];
  readonly updateTurn: (turn: SessionIdSessionTurnRecord, expectedState: SessionIdSessionTurnRecord["state"]) => void;
  readonly createControlAudit: (audit: SessionControlAuditRecord) => void;
  readonly getControlAudit: (sessionControlAuditId: string) => SessionControlAuditRecord | undefined;
  readonly findControlByIdempotencyKey: (taskId: string, runId: string, idempotencyKey: string) => SessionControlAuditRecord | undefined;
  readonly listControlAudits: (runId: string, sessionId?: string) => readonly SessionControlAuditRecord[];
  readonly updateControlAudit: (audit: SessionControlAuditRecord, expectedState: SessionControlAuditRecord["state"]) => void;
  /** Coordinator-owned Attention capability. */
  readonly createAttention: (attention: SessionIdAttentionRecord) => void;
  readonly getAttention: (attentionId: string) => SessionIdAttentionRecord | undefined;
  readonly findAttentionByNativeRequest: (
    bindingId: string,
    bindingRevision: number,
    nativeRequestId: string,
  ) => SessionIdAttentionRecord | undefined;
  readonly listAttentions: (runId: string, sessionId?: string) => readonly SessionIdAttentionRecord[];
  readonly hasBlockingAttention: (sessionId: string) => boolean;
  readonly updateAttention: (
    attention: SessionIdAttentionRecord,
    expectedRevision: number,
    expectedStatus: SessionIdAttentionRecord["status"],
  ) => void;
}

export interface SessionIdReliabilityStore {
  readonly createCommandReceipt: (receipt: SessionIdCommandReceiptRecord) => void;
  readonly findCommandReceipt: (taskId: string, runId: string, idempotencyKey: string) => SessionIdCommandReceiptRecord | undefined;
  readonly createProviderEffect: (effect: SessionIdProviderEffectIntentRecord) => void;
  readonly getProviderEffect: (outboxId: string) => SessionIdProviderEffectIntentRecord | undefined;
  readonly listProviderEffects: (sessionId?: string) => readonly SessionIdProviderEffectIntentRecord[];
  readonly claimNextProviderEffect: (
    taskId: string,
    runId: string,
    now: string,
    leaseUntil: string,
  ) => SessionIdProviderEffectIntentRecord | undefined;
  readonly settleProviderEffect: (input: Readonly<{
    outboxId: string;
    expectedAttempts: number;
    state: "accepted" | "rejected" | "unknown";
    receipt?: JsonValue;
    reason?: string;
    now: string;
  }>) => void;
  readonly suppressPendingProviderEffects: (
    sessionId: string,
    kinds: readonly SessionIdProviderEffectIntentRecord["kind"][],
    reason: string,
    now: string,
  ) => readonly string[];
  readonly suppressProviderEffect: (outboxId: string, reason: string, now: string) => boolean;
  readonly hasAcceptedProviderEffect: (sessionId: string, kind: SessionIdProviderEffectIntentRecord["kind"]) => boolean;
  readonly createUiCommandReceipt: (receipt: SessionIdUiCommandReceiptRecord) => void;
  readonly getUiCommandReceipt: (taskId: string, commandId: string) => SessionIdUiCommandReceiptRecord | undefined;
}

export interface SessionIdWorkspaceStore {
  readonly createEffectIntent: (intent: WorkspaceEffectIntentRecord) => void;
  readonly getEffectIntent: (workspaceEffectIntentId: string) => WorkspaceEffectIntentRecord | undefined;
  readonly findEffectIntentByIdempotencyKey: (taskId: string, idempotencyKey: string) => WorkspaceEffectIntentRecord | undefined;
  readonly findEffectIntentByProviderCallId: (taskId: string, providerCallId: string) => WorkspaceEffectIntentRecord | undefined;
  readonly findEffectIntentByObservationId: (
    taskId: string,
    workspaceFileObservationId: string,
  ) => WorkspaceEffectIntentRecord | undefined;
  readonly updateEffectIntent: (intent: WorkspaceEffectIntentRecord) => void;
  readonly createObservation: (observation: WorkspaceFileObservationRecord, workspaceEffectIntentId?: string) => void;
  readonly getObservation: (workspaceFileObservationId: string) => WorkspaceFileObservationRecord | undefined;
  readonly listObservations: (taskId: string) => readonly WorkspaceFileObservationRecord[];
}

export type SessionIdTaskPermanentDeleteRecordCounts = Readonly<{
  taskRuns: number;
  cardSessionSlots: number;
  logicalSessions: number;
  planningFences: number;
  messages: number;
  relayBlocks: number;
  messageForwards: number;
  humanInterventions: number;
  inboxItems: number;
  inputSubmissions: number;
  sessionTurns: number;
  controlAudits: number;
  workspaceEffectIntents: number;
  workspaceFileObservations: number;
  providerBindings: number;
  providerFacts: number;
  attentions: number;
  commandReceipts: number;
  uiCommandReceipts: number;
  providerEffects: number;
  sessionExecutionRuntimes: number;
  sessionExecutionAttempts: number;
}>;

export type SessionIdTaskPermanentDeletePreview = Readonly<{
  taskId: string;
  expectedRevision: number;
  productRecordCounts: SessionIdTaskPermanentDeleteRecordCounts;
  workspaceFilesWillRemain: true;
}>;

export type SessionIdTaskPermanentDeleteResult = Readonly<{
  taskId: string;
  deletedAt: string;
  workspaceFilesWillRemain: true;
}>;

export type SessionIdTaskPermanentDeleteIntent = Readonly<{
  commandId: string;
  taskId: string;
  expectedRevision: number;
  payloadFingerprint: string;
  preparedAt: string;
}>;

export type SessionIdTaskPermanentDeleteTombstone = Readonly<{
  commandId: string;
  taskId: string;
  payloadFingerprint: string;
  result: SessionIdTaskPermanentDeleteResult;
  deletedAt: string;
}>;

/** Target-only Task retention owner; it never reads superseded routing or Workspace ownership tables. */
export interface SessionIdTaskRetentionStore {
  readonly assertTaskQuiescent: (taskId: string) => void;
  readonly archiveTask: (task: TaskRecord, expectedRevision: number) => void;
  readonly restoreTask: (task: TaskRecord, expectedRevision: number) => void;
  readonly previewPermanentDelete: (taskId: string, expectedRevision: number) => SessionIdTaskPermanentDeletePreview;
  readonly getPermanentDeleteIntent: (commandId: string) => SessionIdTaskPermanentDeleteIntent | undefined;
  readonly getPermanentDeleteTombstone: (commandId: string) => SessionIdTaskPermanentDeleteTombstone | undefined;
  readonly preparePermanentDelete: (intent: SessionIdTaskPermanentDeleteIntent) => SessionIdTaskPermanentDeleteIntent;
  readonly completePermanentDelete: (input: Readonly<{
    commandId: string;
    taskId: string;
    payloadFingerprint: string;
    deletedAt: string;
  }>) => SessionIdTaskPermanentDeleteTombstone;
}

export type SessionIdOwnerCapabilities = Readonly<{
  taskRun: SessionIdTaskRunStore;
  binding: SessionIdBindingStore;
  providerFact: SessionIdProviderFactStore;
  message: SessionIdMessageStore;
  humanIntervention: SessionIdHumanInterventionStore;
  orchestration: SessionIdOrchestrationStore;
  reliability: SessionIdReliabilityStore;
  workspace: SessionIdWorkspaceStore;
  retention: SessionIdTaskRetentionStore;
}>;

/**
 * Unit-of-work boundary for the new canonical owner capabilities.  The
 * callback receives only owner-scoped repositories, never the raw SQLite
 * handle.  This is the boundary used by application transactions for
 * Message+Forward+Inbox sends and Coordinator+Task/Run closes.
 */
export type SessionIdCanonicalStore = SessionIdOwnerCapabilities & Readonly<{
  transaction: <T>(work: (owners: SessionIdOwnerCapabilities) => T) => T;
}>;

export function createSessionIdCanonicalStore(store: SqliteRuntimeStore): SessionIdCanonicalStore {
  const taskRun: SessionIdTaskRunStore = {
    registerTask: (taskId, createdAt) => {
      const task = store.one<Row>("SELECT created_at FROM tasks WHERE task_id = ?", taskId);
      if (!task || text(task.created_at) !== createdAt) throw new Error("session_id_task_registration_mismatch");
      store.run("INSERT INTO session_id_tasks(task_id, created_at) VALUES (?, ?)", taskId, createdAt);
    },
    ownsTask: (taskId) => Boolean(store.one<Row>("SELECT 1 FROM session_id_tasks WHERE task_id = ?", taskId)),
    listOwnedTaskIds: () => Object.freeze(store.many<Row>(
      "SELECT task_id FROM session_id_tasks ORDER BY created_at, task_id",
    ).map((row) => text(row.task_id))),
    listRuns: (taskId) => {
      if (!taskRun.ownsTask(taskId)) throw new Error("session_id_task_not_owned");
      return Object.freeze(store.many<Row>(
        `SELECT run_id, task_id, conductor_logical_session_id, status,
                run_number, revision, started_at, ended_at
         FROM task_runs
         WHERE task_id = ?
         ORDER BY run_number, started_at, run_id`,
        taskId,
      ).map(toSessionIdTaskRun));
    },
    createRun: ({ task, expectedTaskRevision, run }) => store.transaction(() => {
      if (task.revision !== expectedTaskRevision + 1) throw new Error("task_revision_transition_invalid");
      if (task.taskId !== run.taskId || task.activeRunId !== run.runId || task.status !== "running") {
        throw new Error("session_id_run_scope_mismatch");
      }
      if (run.status !== "starting" || run.revision !== 1 || run.runNumber < 1) {
        throw new Error("session_id_run_initial_state_invalid");
      }
      const architectureRow = store.one<Row>(
        "SELECT definition_json FROM task_architecture_snapshots WHERE task_id = ?",
        task.taskId,
      );
      const definition = architectureRow
        ? validateTemplateDefinitionSnapshot(decodeJson<unknown>(architectureRow.definition_json))
        : undefined;
      if (!definition || !isTemplateDefinitionV3(definition) || definition.conductor.kind !== "conductor") {
        throw new Error("session_id_run_requires_v3_conductor_architecture");
      }
      const conductorProfile = definition.executionProfiles.find((profile) =>
        profile.executionProfileId === definition.conductor.executionProfileId);
      if (!conductorProfile) throw new Error("session_id_run_conductor_profile_missing");
      const current = store.one<Row>(
        "SELECT revision, active_run_id FROM tasks WHERE task_id = ?",
        task.taskId,
      );
      if (!current) throw new Error("task_not_found");
      if (integer(current.revision) !== expectedTaskRevision) throw new Error("task_revision_stale");
      if (optionalText(current.active_run_id) === run.runId || store.one<Row>("SELECT run_id FROM task_runs WHERE run_id = ?", run.runId)) {
        throw new Error("session_id_run_already_exists");
      }
      store.run(
        `INSERT INTO task_runs(
           run_id, task_id, conductor_logical_session_id, status,
           run_number, revision, started_at, ended_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        run.runId, run.taskId, run.conductorLogicalSessionId, run.status,
        run.runNumber, run.revision, run.startedAt, run.endedAt ?? null,
      );
      store.run(
        `INSERT INTO session_id_logical_sessions(
           session_id, card_session_slot_id, task_id, run_id, session_kind,
           architecture_schema_version, agent_card_id, execution_profile_id,
           profile_revision_id, generation, lifecycle, created_at, closed_at
         ) VALUES (?, NULL, ?, ?, 'conductor', 3, ?, ?, ?, 1, 'current', ?, NULL)`,
        run.conductorLogicalSessionId,
        task.taskId,
        run.runId,
        definition.conductor.agentCardId,
        conductorProfile.executionProfileId,
        conductorProfile.profileRevisionId,
        run.startedAt,
      );
      store.run(
        `UPDATE tasks
         SET title = ?, goal = ?, status = ?, trashed_at = ?, achievement_json = ?,
             active_run_id = ?, revision = ?, updated_at = ?
         WHERE task_id = ? AND revision = ?`,
        task.title, task.goal, task.status, task.trashedAt ?? null,
        task.achievement ? encodeJson(task.achievement) : null,
        task.activeRunId ?? null, task.revision, task.updatedAt,
        task.taskId, expectedTaskRevision,
      );
      const persisted = store.one<Row>(
        "SELECT active_run_id, revision, status FROM tasks WHERE task_id = ?",
        task.taskId,
      );
      if (optionalText(persisted?.active_run_id) !== run.runId
        || integer(persisted?.revision) !== task.revision
        || text(persisted?.status) !== "running") {
        throw new Error("task_revision_stale");
      }
    }),
    initializeSlot: (slot) => {
      if (slot.currentSessionId !== undefined || slot.latestGeneration !== 0 || slot.revision !== 1) {
        throw new Error("session_id_slot_initial_state_invalid");
      }
      const run = store.one<Row>("SELECT task_id FROM task_runs WHERE run_id = ?", slot.runId);
      if (!run || text(run.task_id) !== slot.taskId) throw new Error("session_id_slot_scope_mismatch");
      const architectureRow = store.one<Row>(
        "SELECT definition_json FROM task_architecture_snapshots WHERE task_id = ?",
        slot.taskId,
      );
      const definition = architectureRow
        ? validateTemplateDefinitionSnapshot(decodeJson<unknown>(architectureRow.definition_json))
        : undefined;
      if (!definition || !isTemplateDefinitionV3(definition)) {
        throw new Error("session_id_slot_requires_v3_architecture");
      }
      if (!definition.agentCards.some((card) => card.agentCardId === slot.agentCardId)) {
        throw new Error("session_id_slot_card_not_in_architecture");
      }
      store.run(
        `INSERT INTO session_id_card_session_slots(
           card_session_slot_id, task_id, run_id, agent_card_id, current_session_id,
           latest_generation, revision, created_at, updated_at
         ) VALUES (?, ?, ?, ?, NULL, 0, 1, ?, ?)`,
        slot.cardSessionSlotId, slot.taskId, slot.runId, slot.agentCardId,
        slot.createdAt, slot.updatedAt,
      );
    },
    resumeRun: ({ task, expectedTaskRevision, run, expectedRunRevision }) => store.transaction(() => {
      if (task.revision !== expectedTaskRevision + 1 || run.revision !== expectedRunRevision + 1) {
        throw new Error("task_revision_transition_invalid");
      }
      if (task.taskId !== run.taskId || task.activeRunId !== run.runId
        || task.status !== "running" || run.status !== "starting") {
        throw new Error("session_id_resume_scope_mismatch");
      }
      const currentTask = store.one<Row>("SELECT revision, active_run_id FROM tasks WHERE task_id = ?", task.taskId);
      const currentRun = store.one<Row>("SELECT revision, task_id FROM task_runs WHERE run_id = ?", run.runId);
      if (integer(currentTask?.revision) !== expectedTaskRevision
        || optionalText(currentTask?.active_run_id) !== run.runId
        || integer(currentRun?.revision) !== expectedRunRevision
        || text(currentRun?.task_id) !== task.taskId) {
        throw new Error("task_resume_revision_stale");
      }
      store.run(
        `UPDATE tasks SET status = ?, revision = ?, updated_at = ?
         WHERE task_id = ? AND active_run_id = ? AND revision = ?`,
        task.status, task.revision, task.updatedAt, task.taskId, run.runId, expectedTaskRevision,
      );
      store.run(
        `UPDATE task_runs SET status = ?, revision = ?, ended_at = ?
         WHERE run_id = ? AND task_id = ? AND revision = ?`,
        run.status, run.revision, run.endedAt ?? null,
        run.runId, task.taskId, expectedRunRevision,
      );
      const persistedTask = store.one<Row>("SELECT revision, status FROM tasks WHERE task_id = ?", task.taskId);
      const persistedRun = store.one<Row>("SELECT revision, status FROM task_runs WHERE run_id = ?", run.runId);
      if (integer(persistedTask?.revision) !== task.revision || text(persistedTask?.status) !== "running"
        || integer(persistedRun?.revision) !== run.revision || text(persistedRun?.status) !== "starting") {
        throw new Error("task_resume_revision_stale");
      }
    }),
    markRunRunning: (run, expectedRunRevision) => {
      if (run.status !== "running" || run.revision !== expectedRunRevision + 1) {
        throw new Error("session_id_run_running_transition_invalid");
      }
      store.run(
        `UPDATE task_runs SET status = 'running', revision = ?, ended_at = ?
         WHERE run_id = ? AND task_id = ? AND revision = ? AND status = 'starting'`,
        run.revision, run.endedAt ?? null, run.runId, run.taskId, expectedRunRevision,
      );
      const persisted = store.one<Row>("SELECT revision, status FROM task_runs WHERE run_id = ?", run.runId);
      if (integer(persisted?.revision) !== run.revision || text(persisted?.status) !== "running") {
        throw new Error("session_id_run_running_revision_stale");
      }
    },
    materializeGeneration: (slot, generation) => store.transaction(() => {
      assertMaterialization(slot, generation);
      const architectureRow = store.one<Row>(
        "SELECT definition_json FROM task_architecture_snapshots WHERE task_id = ?",
        generation.taskId,
      );
      const definition = architectureRow
        ? validateTemplateDefinitionSnapshot(decodeJson<unknown>(architectureRow.definition_json))
        : undefined;
      if (!definition || !isTemplateDefinitionV3(definition)) {
        throw new Error("session_id_generation_requires_v3_architecture");
      }
      const card = definition.agentCards.find((candidate) => candidate.agentCardId === generation.agentCardId);
      if (!card || card.kind === "conductor" || card.executionProfileId !== generation.executionProfileId) {
        throw new Error("session_id_generation_card_profile_mismatch");
      }
      const profileRevisionId = definition.executionProfiles.find((profile) =>
        profile.executionProfileId === generation.executionProfileId)?.profileRevisionId;
      if (!profileRevisionId) {
        throw new Error("session_id_generation_profile_revision_missing");
      }
      const existingSlot = readSlot(store, slot.cardSessionSlotId);
      if (!existingSlot) {
        if (slot.revision !== 1 || slot.latestGeneration !== 1) throw new Error("session_id_slot_initial_state_invalid");
        store.run(
          `INSERT INTO session_id_card_session_slots(
             card_session_slot_id, task_id, run_id, agent_card_id, current_session_id,
             latest_generation, revision, created_at, updated_at
           ) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
          slot.cardSessionSlotId, slot.taskId, slot.runId, slot.agentCardId,
          slot.latestGeneration, slot.revision, slot.createdAt, slot.updatedAt,
        );
      } else {
        if (existingSlot.taskId !== slot.taskId || existingSlot.runId !== slot.runId || existingSlot.agentCardId !== slot.agentCardId) {
          throw new Error("session_id_slot_scope_mismatch");
        }
        if (existingSlot.currentSessionId) throw new Error("session_id_slot_current_exists");
        if (slot.latestGeneration !== existingSlot.latestGeneration + 1 || slot.revision !== existingSlot.revision + 1) {
          throw new Error("session_id_slot_generation_conflict");
        }
      }
      store.run(
        `INSERT INTO session_id_logical_sessions(
           session_id, card_session_slot_id, task_id, run_id, session_kind,
           architecture_schema_version, agent_card_id, execution_profile_id, profile_revision_id,
           generation, lifecycle, created_at, closed_at
         ) VALUES (?, ?, ?, ?, 'card', ?, ?, ?, ?, ?, ?, ?, ?)`,
        generation.sessionId, generation.cardSessionSlotId, generation.taskId, generation.runId,
        3, generation.agentCardId, generation.executionProfileId,
        profileRevisionId, generation.generation,
        generation.lifecycle, generation.createdAt, generation.closedAt ?? null,
      );
      const result = store.one<{ changes: number }>(
        `UPDATE session_id_card_session_slots
         SET current_session_id = ?, latest_generation = ?, revision = ?, updated_at = ?
         WHERE card_session_slot_id = ? AND current_session_id IS NULL`,
        slot.currentSessionId ?? null, slot.latestGeneration, slot.revision, slot.updatedAt, slot.cardSessionSlotId,
      );
      void result;
      const persisted = readSlot(store, slot.cardSessionSlotId);
      if (!persisted || persisted.currentSessionId !== generation.sessionId) throw new Error("session_id_slot_materialize_conflict");
    }),
    getSlot: (cardSessionSlotId) => readSlot(store, cardSessionSlotId),
    findSlot: (runId, agentCardId) => toSlot(store.one<Row>(
      "SELECT * FROM session_id_card_session_slots WHERE run_id = ? AND agent_card_id = ?",
      runId, agentCardId,
    )),
    getGeneration: (sessionId) => toGeneration(store.one<Row>(
      "SELECT * FROM session_id_logical_sessions WHERE session_id = ?",
      sessionId,
    )),
    listGenerations: (cardSessionSlotId) => store.many<Row>(
      "SELECT * FROM session_id_logical_sessions WHERE card_session_slot_id = ? ORDER BY generation",
      cardSessionSlotId,
    ).map((row) => toGeneration(row)!),
    retireConductorSession: (input) => store.transaction(() => {
      const current = store.one<Row>(
        `SELECT task_id, run_id, session_kind, card_session_slot_id, lifecycle, closed_at
         FROM session_id_logical_sessions WHERE session_id = ?`,
        input.logicalSessionId,
      );
      if (!current
        || text(current.task_id) !== input.taskId
        || text(current.run_id) !== input.runId
        || text(current.session_kind) !== "conductor"
        || current.card_session_slot_id !== null) {
        throw new Error("session_id_conductor_session_scope_mismatch");
      }
      if (text(current.lifecycle) !== "current") {
        if (text(current.lifecycle) === "closed" && optionalText(current.closed_at) === input.closedAt) return;
        throw new Error("session_id_conductor_session_not_current");
      }
      store.run(
        `UPDATE session_id_logical_sessions SET lifecycle = 'closed', closed_at = ?
         WHERE session_id = ? AND lifecycle = 'current'`,
        input.closedAt,
        input.logicalSessionId,
      );
    }),
    retireGeneration: (slot, generation, expectedSlotRevision) => store.transaction(() => {
      if (slot.revision !== expectedSlotRevision + 1 || slot.currentSessionId !== undefined) {
        throw new Error("session_id_slot_close_revision_invalid");
      }
      if (generation.lifecycle !== "closed" || !generation.closedAt) throw new Error("session_id_generation_close_invalid");
      const current = readSlot(store, slot.cardSessionSlotId);
      if (!current || current.revision !== expectedSlotRevision || current.currentSessionId !== generation.sessionId) {
        throw new Error("session_id_session_not_current");
      }
      store.run(
        `UPDATE session_id_logical_sessions SET lifecycle = ?, closed_at = ?
         WHERE session_id = ? AND lifecycle = 'current'`,
        generation.lifecycle, generation.closedAt, generation.sessionId,
      );
      store.run(
        `UPDATE session_id_card_session_slots SET current_session_id = NULL, revision = ?, updated_at = ?
         WHERE card_session_slot_id = ? AND revision = ? AND current_session_id = ?`,
        slot.revision, slot.updatedAt, slot.cardSessionSlotId, expectedSlotRevision, generation.sessionId,
      );
      const persisted = readSlot(store, slot.cardSessionSlotId);
      if (!persisted || persisted.revision !== slot.revision || persisted.currentSessionId) {
        throw new Error("session_id_session_close_conflict");
      }
    }),
    createPlanningFence: (fence) => store.run(
      `INSERT INTO session_id_conductor_planning_fences(
         planning_fence_id, task_id, run_id, source_command_id,
         previous_conductor_session_turn_id, current_conductor_session_turn_id, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      fence.planningFenceId, fence.taskId, fence.runId, fence.sourceCommandId,
      fence.previousConductorSessionTurnId ?? null, fence.currentConductorSessionTurnId ?? null, fence.createdAt,
    ),
    getPlanningFence: (planningFenceId) => toPlanningFence(store.one<Row>(
      "SELECT * FROM session_id_conductor_planning_fences WHERE planning_fence_id = ?",
      planningFenceId,
    )),
    findPlanningFenceBySourceCommand: (runId, sourceCommandId) => toPlanningFence(store.one<Row>(
      `SELECT * FROM session_id_conductor_planning_fences
       WHERE run_id = ? AND source_command_id = ?`,
      runId, sourceCommandId,
    )),
    latestPlanningFence: (runId) => toPlanningFence(store.one<Row>(
      "SELECT * FROM session_id_conductor_planning_fences WHERE run_id = ? ORDER BY created_at DESC, planning_fence_id DESC LIMIT 1",
      runId,
    )),
    readTaskRunState: (taskId, runId) => {
      const row = store.one<Row>(
        `SELECT task.task_id, task.revision AS task_revision,
                run.run_id, run.status AS run_status
         FROM tasks task
         JOIN task_runs run ON run.task_id = task.task_id
         WHERE task.task_id = ? AND run.run_id = ? AND task.active_run_id = run.run_id`,
        taskId, runId,
      );
      if (!row) throw new Error("session_id_task_run_scope_mismatch");
      const fence = taskRun.latestPlanningFence(runId);
      return Object.freeze({
        taskId: text(row.task_id),
        runId: text(row.run_id),
        taskRevision: integer(row.task_revision),
        runStatus: text(row.run_status),
        ...(fence?.currentConductorSessionTurnId
          ? { currentConductorSessionTurnId: fence.currentConductorSessionTurnId }
          : {}),
      });
    },
    getConductorSessionId: (taskId, runId) => {
      const row = store.one<Row>(
        `SELECT conductor_logical_session_id
         FROM task_runs
         WHERE task_id = ? AND run_id = ?`,
        taskId, runId,
      );
      if (!row) throw new Error("session_id_task_run_scope_mismatch");
      return text(row.conductor_logical_session_id);
    },
    acceptTaskInput: (input) => {
      if (input.nextRevision !== input.expectedRevision + 1) throw new Error("task_revision_transition_invalid");
      const fence = taskRun.getPlanningFence(input.planningFenceId);
      const message = store.one<Row>(
        "SELECT task_id, run_id FROM session_id_session_messages WHERE message_id = ?",
        input.messageId,
      );
      if (!fence || fence.taskId !== input.taskId || fence.runId !== input.runId
        || fence.sourceCommandId !== input.commandId
        || fence.currentConductorSessionTurnId !== input.currentConductorSessionTurnId
        || fence.previousConductorSessionTurnId !== input.previousConductorSessionTurnId
        || text(message?.task_id) !== input.taskId || text(message?.run_id) !== input.runId) {
        throw new Error("session_id_task_input_owner_scope_mismatch");
      }
      store.run(
        `UPDATE tasks SET revision = ?, updated_at = ?
         WHERE task_id = ? AND active_run_id = ? AND revision = ? AND status = 'running'`,
        input.nextRevision, input.acceptedAt, input.taskId, input.runId, input.expectedRevision,
      );
      const persisted = store.one<Row>("SELECT revision FROM tasks WHERE task_id = ?", input.taskId);
      if (integer(persisted?.revision) !== input.nextRevision) throw new Error("task_revision_stale");
    },
    acceptTaskStop: (input) => {
      if (input.nextRevision !== input.expectedRevision + 1) throw new Error("task_revision_transition_invalid");
      store.run(
        `UPDATE tasks SET status = 'stopping', revision = ?, updated_at = ?
         WHERE task_id = ? AND active_run_id = ? AND revision = ? AND status = 'running'`,
        input.nextRevision, input.acceptedAt, input.taskId, input.runId, input.expectedRevision,
      );
      const persisted = store.one<Row>("SELECT revision, status FROM tasks WHERE task_id = ?", input.taskId);
      if (integer(persisted?.revision) !== input.nextRevision || text(persisted?.status) !== "stopping") {
        throw new Error("task_revision_stale");
      }
      store.run(
        `UPDATE task_runs SET status = 'stopping', revision = revision + 1
         WHERE run_id = ? AND task_id = ? AND status = 'running'`,
        input.runId, input.taskId,
      );
      const run = store.one<Row>("SELECT status FROM task_runs WHERE run_id = ?", input.runId);
      if (text(run?.status) !== "stopping") throw new Error("task_run_status_conflict");
    },
    completeTaskStop: (input) => {
      if (input.nextRevision !== input.expectedRevision + 1) throw new Error("task_revision_transition_invalid");
      const nonterminalBinding = store.one<Row>(
        `SELECT binding_id FROM session_id_provider_bindings
         WHERE task_id = ? AND run_id = ? AND status NOT IN ('released', 'unrecoverable') LIMIT 1`,
        input.taskId, input.runId,
      );
      if (nonterminalBinding) throw new Error("task_stop_binding_not_terminal");
      store.run(
        `UPDATE task_runs SET status = 'stopped', revision = revision + 1, ended_at = ?
         WHERE run_id = ? AND task_id = ? AND status = 'stopping'`,
        input.completedAt, input.runId, input.taskId,
      );
      if (text(store.one<Row>("SELECT status FROM task_runs WHERE run_id = ?", input.runId)?.status) !== "stopped") {
        throw new Error("task_run_status_conflict");
      }
      store.run(
        `UPDATE tasks SET status = 'stopped', revision = ?, updated_at = ?
         WHERE task_id = ? AND active_run_id = ? AND revision = ? AND status = 'stopping'`,
        input.nextRevision, input.completedAt, input.taskId, input.runId, input.expectedRevision,
      );
      const task = store.one<Row>("SELECT revision, status FROM tasks WHERE task_id = ?", input.taskId);
      if (integer(task?.revision) !== input.nextRevision || text(task?.status) !== "stopped") {
        throw new Error("task_revision_stale");
      }
    },
    retireCurrentSessionsForTaskStop: (input) => store.transaction(() => {
      const run = store.one<Row>(
        `SELECT conductor_logical_session_id, status FROM task_runs
         WHERE task_id = ? AND run_id = ?`,
        input.taskId,
        input.runId,
      );
      if (!run || text(run.status) !== "stopping") throw new Error("task_run_status_conflict");
      const currentCards = store.many<Row>(
        `SELECT slot.card_session_slot_id, slot.current_session_id, slot.revision
         FROM session_id_card_session_slots slot
         WHERE slot.task_id = ? AND slot.run_id = ? AND slot.current_session_id IS NOT NULL
         ORDER BY slot.card_session_slot_id`,
        input.taskId,
        input.runId,
      );
      for (const row of currentCards) {
        const slotId = text(row.card_session_slot_id);
        const sessionId = text(row.current_session_id);
        const revision = integer(row.revision);
        store.run(
          `UPDATE session_id_logical_sessions
           SET lifecycle = 'closed', closed_at = ?
           WHERE session_id = ? AND task_id = ? AND run_id = ?
             AND session_kind = 'card' AND lifecycle = 'current'`,
          input.completedAt,
          sessionId,
          input.taskId,
          input.runId,
        );
        store.run(
          `UPDATE session_id_card_session_slots
           SET current_session_id = NULL, revision = ?, updated_at = ?
           WHERE card_session_slot_id = ? AND task_id = ? AND run_id = ?
             AND revision = ? AND current_session_id = ?`,
          revision + 1,
          input.completedAt,
          slotId,
          input.taskId,
          input.runId,
          revision,
          sessionId,
        );
      }
      const conductorSessionId = text(run.conductor_logical_session_id);
      store.run(
        `UPDATE session_id_logical_sessions
         SET lifecycle = 'closed', closed_at = ?
         WHERE session_id = ? AND task_id = ? AND run_id = ?
           AND session_kind = 'conductor' AND lifecycle = 'current'`,
        input.completedAt,
        conductorSessionId,
        input.taskId,
        input.runId,
      );
      const remainingSlot = store.one<Row>(
        `SELECT card_session_slot_id FROM session_id_card_session_slots
         WHERE task_id = ? AND run_id = ? AND current_session_id IS NOT NULL LIMIT 1`,
        input.taskId,
        input.runId,
      );
      const remainingSession = store.one<Row>(
        `SELECT session_id FROM session_id_logical_sessions
         WHERE task_id = ? AND run_id = ? AND lifecycle = 'current' LIMIT 1`,
        input.taskId,
        input.runId,
      );
      if (remainingSlot || remainingSession) throw new Error("task_stop_session_retirement_conflict");
    }),
    completeAcpTaskStop: (input) => {
      if (input.nextRevision !== input.expectedRevision + 1) throw new Error("task_revision_transition_invalid");
      store.run(
        `UPDATE task_runs SET status = 'stopped', revision = revision + 1, ended_at = ?
         WHERE run_id = ? AND task_id = ? AND status = 'stopping'`,
        input.completedAt,
        input.runId,
        input.taskId,
      );
      if (text(store.one<Row>("SELECT status FROM task_runs WHERE run_id = ?", input.runId)?.status) !== "stopped") {
        throw new Error("task_run_status_conflict");
      }
      store.run(
        `UPDATE tasks SET status = 'stopped', revision = ?, updated_at = ?
         WHERE task_id = ? AND active_run_id = ? AND revision = ? AND status = 'stopping'`,
        input.nextRevision,
        input.completedAt,
        input.taskId,
        input.runId,
        input.expectedRevision,
      );
      const task = store.one<Row>("SELECT revision, status FROM tasks WHERE task_id = ?", input.taskId);
      if (integer(task?.revision) !== input.nextRevision || text(task?.status) !== "stopped") {
        throw new Error("task_revision_stale");
      }
    },
  };

  const binding: SessionIdBindingStore = {
    createBinding: (record) => {
      store.transaction(() => {
        assertSupersededDirectWriterOpen(store);
        if (record.revision !== 1 || record.nativeBindingRef || record.status !== "unbound") {
          throw new Error("session_id_binding_initial_state_invalid");
        }
        const generation = toGeneration(store.one<Row>(
          "SELECT * FROM session_id_logical_sessions WHERE session_id = ?", record.sessionId,
        ));
        const conductorRun = store.one<Row>(
          `SELECT run_id, task_id, conductor_logical_session_id FROM task_runs
           WHERE run_id = ? AND task_id = ? AND conductor_logical_session_id = ?`,
          record.runId, record.taskId, record.sessionId,
        );
        const cardMatches = generation?.taskId === record.taskId && generation.runId === record.runId
          && generation.agentCardId === record.agentCardId;
        if (!cardMatches && !conductorRun) {
          throw new Error("session_id_binding_scope_mismatch");
        }
        store.run(
          `INSERT INTO session_id_provider_bindings(
             binding_id, task_id, run_id, session_id, agent_card_id, execution_profile_id,
             provider, provider_host_id, native_binding_ref, status, recoverable,
             revision, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)`,
          record.bindingId, record.taskId, record.runId, record.sessionId, record.agentCardId,
          record.executionProfileId, record.provider, record.providerHostId ?? null,
          record.status, record.recoverable ? 1 : 0, record.revision,
          record.createdAt, record.updatedAt,
        );
      });
    },
    getBinding: (bindingId) => toSessionIdBinding(store.one<Row>(
      "SELECT * FROM session_id_provider_bindings WHERE binding_id = ?", bindingId,
    )),
    getBindingForSession: (sessionId) => toSessionIdBinding(store.one<Row>(
      "SELECT * FROM session_id_provider_bindings WHERE session_id = ?", sessionId,
    )),
    listBindings: (runId) => store.many<Row>(
      "SELECT * FROM session_id_provider_bindings WHERE run_id = ? ORDER BY created_at, binding_id", runId,
    ).map((row) => toSessionIdBinding(row)!),
    updateBinding: (record, expectedRevision) => store.transaction(() => {
      assertSupersededDirectWriterOpen(store);
      const current = toSessionIdBinding(store.one<Row>(
        "SELECT * FROM session_id_provider_bindings WHERE binding_id = ?", record.bindingId,
      ));
      if (!current || current.revision !== expectedRevision || record.revision !== expectedRevision + 1) {
        throw new Error("session_id_binding_revision_conflict");
      }
      if (!sameBindingIdentity(current, record)) throw new Error("session_id_binding_identity_conflict");
      if (current.nativeBindingRef && record.nativeBindingRef !== current.nativeBindingRef) {
        throw new Error("session_id_binding_native_ref_conflict");
      }
      store.run(
        `UPDATE session_id_provider_bindings
         SET provider_host_id = ?, native_binding_ref = ?, status = ?, recoverable = ?,
             revision = ?, updated_at = ?
         WHERE binding_id = ? AND revision = ?`,
        record.providerHostId ?? null, record.nativeBindingRef ?? null, record.status,
        record.recoverable ? 1 : 0, record.revision, record.updatedAt,
        record.bindingId, expectedRevision,
      );
      const persisted = toSessionIdBinding(store.one<Row>(
        "SELECT * FROM session_id_provider_bindings WHERE binding_id = ?", record.bindingId,
      ));
      if (!persisted || persisted.revision !== record.revision) throw new Error("session_id_binding_revision_conflict");
    }),
  };

  const providerFact: SessionIdProviderFactStore = {
    recordFact: (fact) => store.transaction(() => {
      assertSupersededDirectWriterOpen(store);
      const currentBinding = binding.getBinding(fact.bindingId);
      if (!currentBinding || currentBinding.provider !== fact.provider
        || fact.bindingRevision > currentBinding.revision) {
        throw new Error("session_id_provider_fact_binding_mismatch");
      }
      const dedupKey = providerFactDedupKey(fact);
      const fingerprint = providerFactFingerprint(fact);
      const existing = store.one<Row>(
        "SELECT * FROM session_id_provider_facts WHERE binding_id = ? AND dedup_key = ?",
        fact.bindingId, dedupKey,
      );
      if (existing) {
        if (text(existing.fact_fingerprint) !== fingerprint) throw new Error("session_id_provider_fact_dedup_conflict");
        return false;
      }
      store.run(
        `INSERT INTO session_id_provider_facts(
           provider_fact_id, binding_id, binding_revision, provider, kind, dedup_key,
           fact_fingerprint, deduplication_json, correlation_json, evidence_reference_id,
           payload_json, observed_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        fact.providerFactId, fact.bindingId, fact.bindingRevision, fact.provider, fact.kind,
        dedupKey, fingerprint, encodeJson(fact.deduplication), encodeJson(fact.correlation),
        fact.evidenceReferenceId ?? null, encodeJson(fact.payload), fact.observedAt,
      );
      return true;
    }),
    findFactByDedupKey: (bindingId, dedupKey) => toSessionIdProviderFact(store.one<Row>(
      "SELECT * FROM session_id_provider_facts WHERE binding_id = ? AND dedup_key = ?",
      bindingId, dedupKey,
    )),
    listFacts: (bindingId) => store.many<Row>(
      `SELECT * FROM session_id_provider_facts
       WHERE binding_id = ? ORDER BY observed_at, provider_fact_id`, bindingId,
    ).map((row) => toSessionIdProviderFact(row)!),
  };

  const message: SessionIdMessageStore = {
    createMessage: (record) => store.run(
      `INSERT INTO session_id_session_messages(
         message_id, task_id, run_id, source_session_id, source_session_turn_id,
         source_human_intervention_id, kind, content, canonical_content_json, content_digest, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      record.messageId, record.taskId, record.runId, record.sourceSessionId ?? null,
      record.sourceSessionTurnId ?? null, record.sourceHumanInterventionId ?? null, record.kind,
      record.content, encodeJson(record.canonicalContent), record.contentDigest, record.createdAt,
    ),
    getMessage: (messageId) => toMessage(store.one<Row>(
      "SELECT * FROM session_id_session_messages WHERE message_id = ?", messageId,
    )),
    listMessages: (runId) => store.many<Row>(
      "SELECT * FROM session_id_session_messages WHERE run_id = ? ORDER BY created_at, message_id", runId,
    ).map((row) => toMessage(row)!),
    findFinalByTurn: (sessionTurnId) => toMessage(store.one<Row>(
      `SELECT * FROM session_id_session_messages
       WHERE source_session_turn_id = ? AND kind = 'agent_final'`, sessionTurnId,
    )),
    createRelayBlock: (block) => store.run(
      `INSERT INTO session_id_relay_blocks(
         relay_block_id, source_message_id, ordinal, suggested_target_agent_card_ids_json,
         suggested_audience, topic, format, content, content_digest, source_start, source_end, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      block.relayBlockId, block.sourceMessageId, block.ordinal, encodeJson(block.suggestedTargetAgentCardIds),
      block.suggestedAudience ?? null, block.topic ?? null, block.format, block.content,
      block.contentDigest, block.sourceStart, block.sourceEnd, block.createdAt,
    ),
    getRelayBlock: (relayBlockId) => toRelayBlock(store.one<Row>(
      "SELECT * FROM session_id_relay_blocks WHERE relay_block_id = ?", relayBlockId,
    )),
    createForward: (forward) => store.transaction(() => {
      store.run(
        `INSERT INTO session_id_message_forwards(
           forward_id, task_id, run_id, command_id, idempotency_key, decided_by_session_turn_id,
           target_session_id, new_content_digest, rendered_message_id, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        forward.forwardId, forward.taskId, forward.runId, forward.commandId, forward.idempotencyKey,
        forward.decidedBySessionTurnId, forward.targetSessionId, forward.newContentDigest ?? null,
        forward.renderedMessageId, forward.createdAt,
      );
      for (const reference of forward.orderedReferenceSnapshots) {
        store.run(
          `INSERT INTO session_id_message_forward_refs(
             forward_id, ordinal, kind, source_message_id, relay_block_id, content_digest
           ) VALUES (?, ?, ?, ?, ?, ?)`,
          forward.forwardId, reference.ordinal, reference.kind, reference.sourceMessageId,
          reference.relayBlockId ?? null, reference.contentDigest,
        );
      }
    }),
    getForward: (forwardId) => readForward(store, forwardId),
    findForwardByIdempotencyKey: (taskId, runId, idempotencyKey) => {
      const row = store.one<Row>(
        "SELECT forward_id FROM session_id_message_forwards WHERE task_id = ? AND run_id = ? AND idempotency_key = ?",
        taskId, runId, idempotencyKey,
      );
      return row ? readForward(store, text(row.forward_id)) : undefined;
    },
    listForwards: (runId) => store.many<Row>(
      "SELECT forward_id FROM session_id_message_forwards WHERE run_id = ? ORDER BY created_at, forward_id", runId,
    ).map((row) => readForward(store, text(row.forward_id))!),
  };

  const humanIntervention: SessionIdHumanInterventionStore = {
    create: (record) => {
      assertSessionTargetScope(
        store,
        record.taskId,
        record.runId,
        record.targetSessionId,
        "session_id_human_intervention_target_scope_mismatch",
      );
      if (record.mode === "attention_response") {
        if (!record.attentionId || !record.authenticatedUserId?.trim()
          || !record.affectedSessionTurnId || !record.conductorMirrorMessageId || record.cardMessageId) {
          throw new Error("session_id_attention_intervention_attribution_invalid");
        }
        const attention = store.one<Row>(
          `SELECT task_id, run_id, session_id, session_turn_id
           FROM session_id_attentions WHERE attention_id = ?`,
          record.attentionId,
        );
        if (!attention || text(attention.task_id) !== record.taskId || text(attention.run_id) !== record.runId
          || text(attention.session_id) !== record.targetSessionId
          || text(attention.session_turn_id) !== record.affectedSessionTurnId) {
          throw new Error("session_id_attention_intervention_scope_mismatch");
        }
      }
      store.run(
        `INSERT INTO session_id_human_interventions(
           human_intervention_id, task_id, run_id, command_id, idempotency_key, target_session_id,
           mode, state, card_message_id, conductor_mirror_message_id, affected_session_turn_id,
           attention_id, authenticated_user_id, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        record.humanInterventionId, record.taskId, record.runId, record.commandId, record.idempotencyKey,
        record.targetSessionId, record.mode, record.state, record.cardMessageId ?? null,
        record.conductorMirrorMessageId ?? null, record.affectedSessionTurnId ?? null,
        record.attentionId ?? null, record.authenticatedUserId ?? null,
        record.createdAt, record.updatedAt,
      );
    },
    get: (humanInterventionId) => toHumanIntervention(store.one<Row>(
      "SELECT * FROM session_id_human_interventions WHERE human_intervention_id = ?", humanInterventionId,
    )),
    findByIdempotencyKey: (taskId, runId, idempotencyKey) => toHumanIntervention(store.one<Row>(
      `SELECT * FROM session_id_human_interventions
       WHERE task_id = ? AND run_id = ? AND idempotency_key = ?`,
      taskId, runId, idempotencyKey,
    )),
    list: (runId, targetSessionId) => store.many<Row>(
      targetSessionId
        ? `SELECT * FROM session_id_human_interventions
           WHERE run_id = ? AND target_session_id = ? ORDER BY created_at, human_intervention_id`
        : `SELECT * FROM session_id_human_interventions
           WHERE run_id = ? ORDER BY created_at, human_intervention_id`,
      ...(targetSessionId ? [runId, targetSessionId] : [runId]),
    ).map((row) => toHumanIntervention(row)!),
    update: (record) => store.run(
      `UPDATE session_id_human_interventions SET state = ?, card_message_id = ?,
         conductor_mirror_message_id = ?, affected_session_turn_id = ?, attention_id = ?,
         authenticated_user_id = ?, updated_at = ?
       WHERE human_intervention_id = ?`,
      record.state, record.cardMessageId ?? null, record.conductorMirrorMessageId ?? null,
      record.affectedSessionTurnId ?? null, record.attentionId ?? null,
      record.authenticatedUserId ?? null, record.updatedAt, record.humanInterventionId,
    ),
  };

  const orchestration: SessionIdOrchestrationStore = {
    createInboxItem: (item) => {
      assertSessionTargetScope(store, item.taskId, item.runId, item.sessionId, "session_id_inbox_target_scope_mismatch");
      store.run(
        `INSERT INTO session_id_session_inbox_items(
           inbox_item_id, task_id, run_id, target_session_id, rendered_message_id, sequence,
           priority, state, causal_predecessor_inbox_item_id, human_intervention_id, forward_id,
           reason, revision, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        item.inboxItemId, item.taskId, item.runId, item.sessionId, item.renderedMessageId,
        item.sequence, item.priority, item.state, item.causalPredecessorInboxItemId ?? null,
        item.humanInterventionId ?? null, item.forwardId ?? null, item.reason ?? null,
        item.createdAt, item.updatedAt,
      );
    },
    getInboxItem: (inboxItemId) => toLaneItem(store.one<Row>(
      "SELECT * FROM session_id_session_inbox_items WHERE inbox_item_id = ?", inboxItemId,
    )),
    listInboxItems: (sessionId) => store.many<Row>(
      "SELECT * FROM session_id_session_inbox_items WHERE target_session_id = ? ORDER BY sequence", sessionId,
    ).map((row) => toLaneItem(row)!),
    updateInboxItem: (item, expectedState) => {
      const revision = store.one<{ revision: number }>(
        "SELECT revision FROM session_id_session_inbox_items WHERE inbox_item_id = ? AND state = ?",
        item.inboxItemId, expectedState,
      )?.revision;
      if (revision === undefined) throw new Error("session_id_inbox_state_conflict");
      store.run(
        `UPDATE session_id_session_inbox_items
         SET state = ?, causal_predecessor_inbox_item_id = ?, reason = ?, revision = ?, updated_at = ?
         WHERE inbox_item_id = ? AND revision = ? AND state = ?`,
        item.state, item.causalPredecessorInboxItemId ?? null, item.reason ?? null, revision + 1,
        item.updatedAt, item.inboxItemId, revision, expectedState,
      );
    },
    suppressPendingOrdinary: (sessionId, reason, now) => {
      const affected = store.many<{ inbox_item_id: string }>(
        `SELECT inbox_item_id FROM session_id_session_inbox_items
         WHERE target_session_id = ? AND priority = 'ordinary' AND state = 'pending'
         ORDER BY sequence`,
        sessionId,
      ).map((row) => row.inbox_item_id);
      store.run(
        `UPDATE session_id_session_inbox_items
         SET state = 'suppressed', reason = ?, revision = revision + 1, updated_at = ?
         WHERE target_session_id = ? AND priority = 'ordinary' AND state = 'pending'`,
        reason, now, sessionId,
      );
      return Object.freeze(affected);
    },
    createInputSubmission: (input) => {
      assertSessionTargetScope(store, input.taskId, input.runId, input.sessionId, "session_id_input_target_scope_mismatch");
      const source = toLaneItem(store.one<Row>(
        "SELECT * FROM session_id_session_inbox_items WHERE inbox_item_id = ?", input.sourceInboxItemId,
      ));
      if (!source || source.taskId !== input.taskId || source.runId !== input.runId
        || source.sessionId !== input.sessionId || source.renderedMessageId !== input.contentMessageId
        || source.sequence !== input.sequence) {
        throw new Error("session_id_input_source_scope_mismatch");
      }
      store.run(
        `INSERT INTO session_id_input_submissions(
           input_submission_id, task_id, run_id, session_id, source_inbox_item_id,
           content_message_id, command_id, idempotency_key, sequence, state, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        input.inputSubmissionId, input.taskId, input.runId, input.sessionId, input.sourceInboxItemId,
        input.contentMessageId, input.commandId, input.idempotencyKey, input.sequence, input.state,
        input.createdAt, input.updatedAt,
      );
    },
    getInputSubmission: (inputSubmissionId) => toInputSubmission(store.one<Row>(
      "SELECT * FROM session_id_input_submissions WHERE input_submission_id = ?", inputSubmissionId,
    )),
    findInputByInboxItem: (inboxItemId) => toInputSubmission(store.one<Row>(
      "SELECT * FROM session_id_input_submissions WHERE source_inbox_item_id = ?", inboxItemId,
    )),
    updateInputSubmission: (input, expectedState) => {
      const current = toInputSubmission(store.one<Row>(
        "SELECT * FROM session_id_input_submissions WHERE input_submission_id = ?", input.inputSubmissionId,
      ));
      if (!current || current.state !== expectedState) throw new Error("session_id_input_state_conflict");
      if (!sameInputIdentity(current, input)) throw new Error("session_id_input_identity_conflict");
      store.run(
        `UPDATE session_id_input_submissions SET state = ?, updated_at = ?
         WHERE input_submission_id = ? AND state = ?`,
        input.state, input.updatedAt, input.inputSubmissionId, expectedState,
      );
    },
    createTurn: (turn) => {
      assertSessionTargetScope(store, turn.taskId, turn.runId, turn.sessionId, "session_id_turn_target_scope_mismatch");
      const input = orchestration.getInputSubmission(turn.inputSubmissionId);
      if (!input || input.taskId !== turn.taskId || input.runId !== turn.runId || input.sessionId !== turn.sessionId) {
        throw new Error("session_id_turn_input_scope_mismatch");
      }
      store.run(
        `INSERT INTO session_id_session_turns(
           session_turn_id, task_id, run_id, session_id, input_submission_id, source_conductor_session_turn_id, trigger,
           state, final_message_id, created_at, updated_at, settled_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        turn.sessionTurnId, turn.taskId, turn.runId, turn.sessionId, turn.inputSubmissionId,
        turn.sourceConductorSessionTurnId ?? null, turn.trigger, turn.state, turn.finalMessageId ?? null,
        turn.createdAt, turn.updatedAt, turn.settledAt ?? null,
      );
    },
    getTurn: (sessionTurnId) => toTurn(store.one<Row>(
      "SELECT * FROM session_id_session_turns WHERE session_turn_id = ?", sessionTurnId,
    )),
    findTurnByInputSubmission: (inputSubmissionId) => toTurn(store.one<Row>(
      "SELECT * FROM session_id_session_turns WHERE input_submission_id = ?", inputSubmissionId,
    )),
    listTurns: (sessionId) => store.many<Row>(
      "SELECT * FROM session_id_session_turns WHERE session_id = ? ORDER BY created_at, session_turn_id", sessionId,
    ).map((row) => toTurn(row)!),
    updateTurn: (turn, expectedState) => {
      const current = toTurn(store.one<Row>(
        "SELECT * FROM session_id_session_turns WHERE session_turn_id = ?", turn.sessionTurnId,
      ));
      if (!current || current.state !== expectedState) throw new Error("session_id_turn_state_conflict");
      if (!sameTurnIdentity(current, turn)) throw new Error("session_id_turn_identity_conflict");
      store.run(
        `UPDATE session_id_session_turns
         SET state = ?, final_message_id = ?, updated_at = ?, settled_at = ?
         WHERE session_turn_id = ? AND state = ?`,
        turn.state, turn.finalMessageId ?? null, turn.updatedAt, turn.settledAt ?? null,
        turn.sessionTurnId, expectedState,
      );
    },
    createControlAudit: (audit) => store.run(
      `INSERT INTO session_id_session_control_audits(
         session_control_audit_id, task_id, run_id, session_id, command_id, idempotency_key,
         kind, state, affected_inbox_item_ids_json, requested_at, settled_at, reason
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      audit.sessionControlAuditId, audit.taskId, audit.runId, audit.sessionId, audit.commandId,
      audit.idempotencyKey, audit.kind, audit.state, encodeJson(audit.affectedInboxItemIds),
      audit.requestedAt, audit.settledAt ?? null, audit.reason ?? null,
    ),
    getControlAudit: (sessionControlAuditId) => toControlAudit(store.one<Row>(
      "SELECT * FROM session_id_session_control_audits WHERE session_control_audit_id = ?",
      sessionControlAuditId,
    )),
    findControlByIdempotencyKey: (taskId, runId, idempotencyKey) => toControlAudit(store.one<Row>(
      `SELECT * FROM session_id_session_control_audits
       WHERE task_id = ? AND run_id = ? AND idempotency_key = ?`,
      taskId, runId, idempotencyKey,
    )),
    listControlAudits: (runId, sessionId) => store.many<Row>(
      sessionId
        ? `SELECT * FROM session_id_session_control_audits
           WHERE run_id = ? AND session_id = ? ORDER BY requested_at, session_control_audit_id`
        : `SELECT * FROM session_id_session_control_audits
           WHERE run_id = ? ORDER BY requested_at, session_control_audit_id`,
      ...(sessionId ? [runId, sessionId] : [runId]),
    ).map((row) => toControlAudit(row)!),
    updateControlAudit: (audit, expectedState) => {
      const current = toControlAudit(store.one<Row>(
        "SELECT * FROM session_id_session_control_audits WHERE session_control_audit_id = ?",
        audit.sessionControlAuditId,
      ));
      if (!current || current.state !== expectedState) throw new Error("session_id_control_state_conflict");
      if (!sameControlIdentity(current, audit)) throw new Error("session_id_control_identity_conflict");
      store.run(
        `UPDATE session_id_session_control_audits
         SET state = ?, affected_inbox_item_ids_json = ?, settled_at = ?, reason = ?
         WHERE session_control_audit_id = ? AND state = ?`,
        audit.state, encodeJson(audit.affectedInboxItemIds), audit.settledAt ?? null,
        audit.reason ?? null, audit.sessionControlAuditId, expectedState,
      );
    },
    createAttention: (attention) => store.transaction(() => {
      assertSupersededDirectWriterOpen(store);
      assertSessionTargetScope(
        store,
        attention.taskId,
        attention.runId,
        attention.sessionId,
        "session_id_attention_session_scope_mismatch",
      );
      const bindingRecord = binding.getBinding(attention.bindingId);
      const turn = orchestration.getTurn(attention.sessionTurnId);
      const input = orchestration.getInputSubmission(attention.inputSubmissionId);
      const sourceFact = toSessionIdProviderFact(store.one<Row>(
        "SELECT * FROM session_id_provider_facts WHERE provider_fact_id = ?",
        attention.sourceProviderFactId,
      ));
      if (!bindingRecord || bindingRecord.taskId !== attention.taskId || bindingRecord.runId !== attention.runId
        || bindingRecord.sessionId !== attention.sessionId || bindingRecord.revision !== attention.bindingRevision) {
        throw new Error("session_id_attention_binding_scope_mismatch");
      }
      if (!turn || !input || turn.taskId !== attention.taskId || turn.runId !== attention.runId
        || turn.sessionId !== attention.sessionId || turn.inputSubmissionId !== attention.inputSubmissionId
        || input.sessionId !== attention.sessionId || input.taskId !== attention.taskId || input.runId !== attention.runId) {
        throw new Error("session_id_attention_turn_scope_mismatch");
      }
      if (!sourceFact || sourceFact.kind !== "attention_requested" || sourceFact.bindingId !== attention.bindingId
        || sourceFact.bindingRevision !== attention.bindingRevision) {
        throw new Error("session_id_attention_source_fact_mismatch");
      }
      store.run(
        `INSERT INTO session_id_attentions(
           attention_id, task_id, run_id, session_id, binding_id, binding_revision,
           session_turn_id, input_submission_id, native_request_id, source_provider_fact_id,
           request_json, response_json, response_command_id, human_intervention_id,
           conductor_mirror_message_id, response_outbox_id, status, revision, reason,
           created_at, updated_at, settled_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        attention.attentionId, attention.taskId, attention.runId, attention.sessionId,
        attention.bindingId, attention.bindingRevision, attention.sessionTurnId,
        attention.inputSubmissionId, attention.nativeRequestId, attention.sourceProviderFactId,
        encodeJson(attention.request), attention.response === undefined ? null : encodeJson(attention.response),
        attention.responseCommandId ?? null, attention.humanInterventionId ?? null,
        attention.conductorMirrorMessageId ?? null, attention.responseOutboxId ?? null,
        attention.status, attention.revision, attention.reason ?? null, attention.createdAt,
        attention.updatedAt, attention.settledAt ?? null,
      );
    }),
    getAttention: (attentionId) => toSessionIdAttention(store.one<Row>(
      "SELECT * FROM session_id_attentions WHERE attention_id = ?", attentionId,
    )),
    findAttentionByNativeRequest: (bindingId, bindingRevision, nativeRequestId) => toSessionIdAttention(store.one<Row>(
      `SELECT * FROM session_id_attentions
       WHERE binding_id = ? AND binding_revision = ? AND native_request_id = ?`,
      bindingId, bindingRevision, nativeRequestId,
    )),
    listAttentions: (runId, sessionId) => store.many<Row>(
      sessionId
        ? `SELECT * FROM session_id_attentions
           WHERE run_id = ? AND session_id = ? ORDER BY created_at, attention_id`
        : `SELECT * FROM session_id_attentions
           WHERE run_id = ? ORDER BY created_at, attention_id`,
      ...(sessionId ? [runId, sessionId] : [runId]),
    ).map((row) => toSessionIdAttention(row)!),
    hasBlockingAttention: (sessionId) => Boolean(store.one<Row>(
      `SELECT attention_id FROM session_id_attentions
       WHERE session_id = ? AND status IN ('requested', 'response_staged', 'effect_accepted', 'unknown')
       LIMIT 1`,
      sessionId,
    )),
    updateAttention: (attention, expectedRevision, expectedStatus) => store.transaction(() => {
      assertSupersededDirectWriterOpen(store);
      const current = toSessionIdAttention(store.one<Row>(
        "SELECT * FROM session_id_attentions WHERE attention_id = ?", attention.attentionId,
      ));
      if (!current || current.revision !== expectedRevision || current.status !== expectedStatus) {
        throw new Error("session_id_attention_revision_conflict");
      }
      if (!sameAttentionIdentity(current, attention) || attention.revision !== expectedRevision + 1) {
        throw new Error("session_id_attention_identity_conflict");
      }
      store.run(
        `UPDATE session_id_attentions
         SET response_json = ?, response_command_id = ?, human_intervention_id = ?,
             conductor_mirror_message_id = ?, response_outbox_id = ?, status = ?, revision = ?,
             reason = ?, updated_at = ?, settled_at = ?
         WHERE attention_id = ? AND revision = ? AND status = ?`,
        attention.response === undefined ? null : encodeJson(attention.response),
        attention.responseCommandId ?? null, attention.humanInterventionId ?? null,
        attention.conductorMirrorMessageId ?? null, attention.responseOutboxId ?? null,
        attention.status, attention.revision, attention.reason ?? null, attention.updatedAt,
        attention.settledAt ?? null, attention.attentionId, expectedRevision, expectedStatus,
      );
      const persisted = toSessionIdAttention(store.one<Row>(
        "SELECT * FROM session_id_attentions WHERE attention_id = ?", attention.attentionId,
      ));
      if (!persisted || persisted.revision !== attention.revision || persisted.status !== attention.status) {
        throw new Error("session_id_attention_revision_conflict");
      }
    }),
  };

  const reliability: SessionIdReliabilityStore = {
    createCommandReceipt: (receipt) => store.run(
      `INSERT INTO session_id_command_receipts(
         command_id, task_id, run_id, command_kind, idempotency_key,
         payload_fingerprint, result_json, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      receipt.commandId, receipt.taskId, receipt.runId, receipt.commandKind, receipt.idempotencyKey,
      receipt.payloadFingerprint, encodeJson(receipt.result), receipt.createdAt,
    ),
    findCommandReceipt: (taskId, runId, idempotencyKey) => toCommandReceipt(store.one<Row>(
      `SELECT * FROM session_id_command_receipts
       WHERE task_id = ? AND run_id = ? AND idempotency_key = ?`, taskId, runId, idempotencyKey,
    )),
    createProviderEffect: (effect) => store.transaction(() => {
      assertSupersededDirectWriterOpen(store);
      assertSessionTargetScope(store, effect.taskId, effect.runId, effect.sessionId, "session_id_provider_effect_target_scope_mismatch");
      if (effect.sessionTurnId) {
        const turn = orchestration.getTurn(effect.sessionTurnId);
        if (effect.kind !== "ensure_binding" && (!turn || turn.taskId !== effect.taskId
          || turn.runId !== effect.runId || turn.sessionId !== effect.sessionId)) {
          throw new Error("session_id_provider_effect_turn_scope_mismatch");
        }
      }
      if (effect.kind === "respond_attention") {
        const attention = effect.attentionId ? orchestration.getAttention(effect.attentionId) : undefined;
        if (!attention || attention.taskId !== effect.taskId || attention.runId !== effect.runId
          || attention.sessionId !== effect.sessionId || attention.sessionTurnId !== effect.sessionTurnId
          || effect.sessionControlAuditId) {
          throw new Error("session_id_provider_effect_attention_scope_mismatch");
        }
      } else if (effect.attentionId) {
        throw new Error("session_id_provider_effect_attention_kind_mismatch");
      }
      store.run(
        `INSERT INTO session_id_provider_effect_outbox(
           outbox_id, task_id, run_id, session_id, session_turn_id, session_control_audit_id, attention_id,
           kind, idempotency_key, payload_json, payload_fingerprint, state, attempts,
           lease_until, receipt_json, reason, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        effect.outboxId, effect.taskId, effect.runId, effect.sessionId, effect.sessionTurnId ?? null,
        effect.sessionControlAuditId ?? null, effect.attentionId ?? null, effect.kind, effect.idempotencyKey, encodeJson(effect.payload),
        effect.payloadFingerprint, effect.state, effect.attempts, effect.leaseUntil ?? null,
        effect.receipt === undefined ? null : encodeJson(effect.receipt), effect.reason ?? null,
        effect.createdAt, effect.updatedAt,
      );
    }),
    getProviderEffect: (outboxId) => toProviderEffect(store.one<Row>(
      "SELECT * FROM session_id_provider_effect_outbox WHERE outbox_id = ?", outboxId,
    )),
    listProviderEffects: (sessionId) => store.many<Row>(
      sessionId
        ? "SELECT * FROM session_id_provider_effect_outbox WHERE session_id = ? ORDER BY created_at, outbox_id"
        : "SELECT * FROM session_id_provider_effect_outbox ORDER BY created_at, outbox_id",
      ...(sessionId ? [sessionId] : []),
    ).map((row) => toProviderEffect(row)!),
    claimNextProviderEffect: (taskId, runId, now, leaseUntil) => store.transaction(() => {
      assertSupersededDirectWriterOpen(store);
      store.run(
        `UPDATE session_id_provider_effect_outbox
         SET state = 'pending', lease_until = NULL, updated_at = ?
         WHERE task_id = ? AND run_id = ? AND state = 'leased' AND lease_until <= ?`,
        now, taskId, runId, now,
      );
      const candidate = store.one<Row>(
        `SELECT outbox_id FROM session_id_provider_effect_outbox
         WHERE task_id = ? AND run_id = ? AND state = 'pending'
         ORDER BY CASE
           WHEN kind = 'ensure_binding' AND idempotency_key LIKE 'recover_binding:%' THEN 0
           ELSE 1
         END, created_at, outbox_id LIMIT 1`,
        taskId, runId,
      );
      if (!candidate) return undefined;
      const outboxId = text(candidate.outbox_id);
      store.run(
        `UPDATE session_id_provider_effect_outbox
         SET state = 'leased', attempts = attempts + 1, lease_until = ?, updated_at = ?
         WHERE outbox_id = ? AND state = 'pending'`,
        leaseUntil, now, outboxId,
      );
      const claimed = toProviderEffect(store.one<Row>(
        "SELECT * FROM session_id_provider_effect_outbox WHERE outbox_id = ?", outboxId,
      ));
      if (!claimed || claimed.state !== "leased") throw new Error("session_id_provider_effect_claim_conflict");
      return claimed;
    }),
    settleProviderEffect: (input) => store.transaction(() => {
      assertSupersededDirectWriterOpen(store);
      const current = toProviderEffect(store.one<Row>(
        "SELECT * FROM session_id_provider_effect_outbox WHERE outbox_id = ?", input.outboxId,
      ));
      if (!current || current.state !== "leased" || current.attempts !== input.expectedAttempts) {
        throw new Error("session_id_provider_effect_settle_conflict");
      }
      store.run(
        `UPDATE session_id_provider_effect_outbox
         SET state = ?, lease_until = NULL, receipt_json = ?, reason = ?, updated_at = ?
         WHERE outbox_id = ? AND state = 'leased' AND attempts = ?`,
        input.state, input.receipt === undefined ? null : encodeJson(input.receipt), input.reason ?? null,
        input.now, input.outboxId, input.expectedAttempts,
      );
    }),
    suppressPendingProviderEffects: (sessionId, kinds, reason, now) => store.transaction(() => {
      assertSupersededDirectWriterOpen(store);
      if (kinds.length === 0 || kinds.some((kind) => !["ensure_binding", "submit_delivery", "request_interrupt", "respond_attention", "release_binding"].includes(kind))) {
        throw new Error("session_id_provider_effect_suppression_kind_invalid");
      }
      const uniqueKinds = [...new Set(kinds)];
      const placeholders = uniqueKinds.map(() => "?").join(", ");
      const affected = store.many<{ outbox_id: string }>(
        `SELECT outbox_id FROM session_id_provider_effect_outbox
         WHERE session_id = ? AND state = 'pending' AND kind IN (${placeholders})
         ORDER BY created_at, outbox_id`, sessionId, ...uniqueKinds,
      ).map((row) => row.outbox_id);
      store.run(
        `UPDATE session_id_provider_effect_outbox
         SET state = 'suppressed', reason = ?, updated_at = ?
         WHERE session_id = ? AND state = 'pending' AND kind IN (${placeholders})`,
        reason, now, sessionId, ...uniqueKinds,
      );
      return Object.freeze(affected);
    }),
    suppressProviderEffect: (outboxId, reason, now) => store.transaction(() => {
      assertSupersededDirectWriterOpen(store);
      const current = toProviderEffect(store.one<Row>(
        "SELECT * FROM session_id_provider_effect_outbox WHERE outbox_id = ?", outboxId,
      ));
      if (!current || current.state !== "pending") return false;
      store.run(
        `UPDATE session_id_provider_effect_outbox
         SET state = 'suppressed', reason = ?, updated_at = ?
         WHERE outbox_id = ? AND state = 'pending'`,
        reason, now, outboxId,
      );
      return toProviderEffect(store.one<Row>(
        "SELECT * FROM session_id_provider_effect_outbox WHERE outbox_id = ?", outboxId,
      ))?.state === "suppressed";
    }),
    hasAcceptedProviderEffect: (sessionId, kind) => Boolean(store.one<Row>(
      `SELECT outbox_id FROM session_id_provider_effect_outbox
       WHERE session_id = ? AND kind = ? AND state = 'accepted' LIMIT 1`, sessionId, kind,
    )),
    createUiCommandReceipt: (receipt) => store.transaction(() => {
      if (receipt.commandKind === "session.respond_attention") {
        assertSupersededDirectWriterOpen(store);
      }
      const existing = toUiCommandReceipt(store.one<Row>(
        `SELECT * FROM session_id_ui_command_receipts
         WHERE command_id = ? OR (task_id = ? AND run_id = ? AND idempotency_key = ?)`,
        receipt.commandId, receipt.taskId, receipt.runId, receipt.idempotencyKey,
      ));
      if (existing) {
        if (existing.commandId !== receipt.commandId
          || existing.taskId !== receipt.taskId
          || existing.runId !== receipt.runId
          || existing.commandKind !== receipt.commandKind
          || existing.idempotencyKey !== receipt.idempotencyKey
          || existing.payloadFingerprint !== receipt.payloadFingerprint
          || encodeJson(existing.result) !== encodeJson(receipt.result)) {
          throw new Error("session_id_ui_command_receipt_conflict");
        }
        return;
      }
      store.run(
        `INSERT INTO session_id_ui_command_receipts(
           command_id, task_id, run_id, command_kind, idempotency_key,
           payload_fingerprint, result_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        receipt.commandId, receipt.taskId, receipt.runId, receipt.commandKind,
        receipt.idempotencyKey, receipt.payloadFingerprint, encodeJson(receipt.result), receipt.createdAt,
      );
    }),
    getUiCommandReceipt: (taskId, commandId) => toUiCommandReceipt(store.one<Row>(
      `SELECT * FROM session_id_ui_command_receipts
       WHERE task_id = ? AND command_id = ?`, taskId, commandId,
    )),
  };

  const workspace: SessionIdWorkspaceStore = {
    createEffectIntent: (intent) => store.run(
      `INSERT INTO session_id_workspace_effect_intents(
         workspace_effect_intent_id, task_id, run_id, publisher_session_id, publisher_session_turn_id,
         provider_call_id, idempotency_key, workspace_relative_path, content_digest, byte_length,
         state, observation_id, reason, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      intent.workspaceEffectIntentId, intent.taskId, intent.runId, intent.publisherSessionId,
      intent.publisherSessionTurnId, intent.providerCallId, intent.idempotencyKey,
      intent.workspaceRelativePath, intent.contentDigest, intent.byteLength, intent.state,
      intent.observationId ?? null, intent.reason ?? null, intent.createdAt, intent.updatedAt,
    ),
    getEffectIntent: (workspaceEffectIntentId) => toWorkspaceEffect(store.one<Row>(
      "SELECT * FROM session_id_workspace_effect_intents WHERE workspace_effect_intent_id = ?",
      workspaceEffectIntentId,
    )),
    findEffectIntentByIdempotencyKey: (taskId, idempotencyKey) => toWorkspaceEffect(store.one<Row>(
      `SELECT * FROM session_id_workspace_effect_intents
      WHERE task_id = ? AND idempotency_key = ?`, taskId, idempotencyKey,
    )),
    findEffectIntentByProviderCallId: (taskId, providerCallId) => toWorkspaceEffect(store.one<Row>(
      `SELECT * FROM session_id_workspace_effect_intents
       WHERE task_id = ? AND provider_call_id = ?`, taskId, providerCallId,
    )),
    findEffectIntentByObservationId: (taskId, workspaceFileObservationId) => toWorkspaceEffect(store.one<Row>(
      `SELECT effect.* FROM session_id_workspace_effect_intents effect
       JOIN session_id_workspace_file_observations observation
         ON observation.workspace_effect_intent_id = effect.workspace_effect_intent_id
       WHERE observation.task_id = ? AND observation.workspace_file_observation_id = ?`,
      taskId, workspaceFileObservationId,
    )),
    updateEffectIntent: (intent) => {
      const existing = toWorkspaceEffect(store.one<Row>(
        "SELECT * FROM session_id_workspace_effect_intents WHERE workspace_effect_intent_id = ?",
        intent.workspaceEffectIntentId,
      ));
      if (!existing) throw new Error("workspace_effect_intent_not_found");
      if (!sameWorkspaceEffectIdentity(existing, intent)) throw new Error("workspace_effect_intent_identity_conflict");
      if (intent.observationId) {
        const observation = store.one<Row>(
          `SELECT task_id, workspace_effect_intent_id, workspace_relative_path
           FROM session_id_workspace_file_observations WHERE workspace_file_observation_id = ?`,
          intent.observationId,
        );
        if (!observation
          || text(observation.task_id) !== intent.taskId
          || text(observation.workspace_effect_intent_id) !== intent.workspaceEffectIntentId
          || text(observation.workspace_relative_path) !== intent.workspaceRelativePath) {
          throw new Error("workspace_effect_observation_mismatch");
        }
      }
      store.run(
        `UPDATE session_id_workspace_effect_intents
         SET state = ?, observation_id = ?, reason = ?, updated_at = ?
         WHERE workspace_effect_intent_id = ?`,
        intent.state, intent.observationId ?? null, intent.reason ?? null,
        intent.updatedAt, intent.workspaceEffectIntentId,
      );
    },
    createObservation: (observation, workspaceEffectIntentId) => {
      if (observation.source === "verified_tool" && !workspaceEffectIntentId) {
        throw new Error("workspace_observation_verified_intent_required");
      }
      if (workspaceEffectIntentId) {
        const effect = toWorkspaceEffect(store.one<Row>(
          "SELECT * FROM session_id_workspace_effect_intents WHERE workspace_effect_intent_id = ?",
          workspaceEffectIntentId,
        ));
        if (!effect || effect.taskId !== observation.taskId || effect.runId !== observation.runId
          || effect.workspaceRelativePath !== observation.workspaceRelativePath) {
          throw new Error("workspace_observation_effect_scope_mismatch");
        }
      }
      store.run(
        `INSERT INTO session_id_workspace_file_observations(
           workspace_file_observation_id, task_id, run_id, workspace_effect_intent_id,
           workspace_relative_path, content_digest, byte_length, state, source, observed_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        observation.workspaceFileObservationId, observation.taskId, observation.runId ?? null,
        workspaceEffectIntentId ?? null, observation.workspaceRelativePath, observation.contentDigest ?? null,
        observation.byteLength ?? null, observation.state, observation.source, observation.observedAt,
      );
    },
    getObservation: (workspaceFileObservationId) => toWorkspaceObservation(store.one<Row>(
      `SELECT * FROM session_id_workspace_file_observations
       WHERE workspace_file_observation_id = ?`, workspaceFileObservationId,
    )),
    listObservations: (taskId) => store.many<Row>(
      `SELECT * FROM session_id_workspace_file_observations
       WHERE task_id = ? ORDER BY observed_at, workspace_file_observation_id`, taskId,
    ).map((row) => toWorkspaceObservation(row)!),
  };

  const retention: SessionIdTaskRetentionStore = {
    assertTaskQuiescent: (taskId) => {
      requiredTaskRetentionRow(store, taskId);
      assertSessionIdTaskQuiescent(store, taskId);
    },
    archiveTask: (task, expectedRevision) => store.transaction(() => {
      if (task.revision !== expectedRevision + 1 || !task.trashedAt) {
        throw new Error("task_revision_transition_invalid");
      }
      const current = requiredTaskRetentionRow(store, task.taskId);
      if (integer(current.revision) !== expectedRevision) throw new Error("task_revision_stale");
      if (current.trashed_at !== null && current.trashed_at !== undefined) throw new Error("task_already_in_recycle_bin");
      if (current.achievement_json === null || current.achievement_json === undefined) throw new Error("task_not_recyclable");
      if (!["queued", "stopped", "blocked"].includes(text(current.status))) {
        throw new Error("task_recycle_run_not_terminal");
      }
      assertSessionIdTaskQuiescent(store, task.taskId);
      store.run(
        `UPDATE tasks SET trashed_at = ?, revision = ?, updated_at = ?
         WHERE task_id = ? AND revision = ? AND trashed_at IS NULL`,
        task.trashedAt, task.revision, task.updatedAt, task.taskId, expectedRevision,
      );
      const persisted = requiredTaskRetentionRow(store, task.taskId);
      if (integer(persisted.revision) !== task.revision || text(persisted.trashed_at) !== task.trashedAt) {
        throw new Error("task_revision_stale");
      }
    }),
    restoreTask: (task, expectedRevision) => store.transaction(() => {
      if (task.revision !== expectedRevision + 1 || task.trashedAt !== undefined) {
        throw new Error("task_revision_transition_invalid");
      }
      const current = requiredTaskRetentionRow(store, task.taskId);
      if (integer(current.revision) !== expectedRevision) throw new Error("task_revision_stale");
      if (current.trashed_at === null || current.trashed_at === undefined) throw new Error("task_not_in_recycle_bin");
      store.run(
        `UPDATE tasks SET trashed_at = NULL, revision = ?, updated_at = ?
         WHERE task_id = ? AND revision = ? AND trashed_at IS NOT NULL`,
        task.revision, task.updatedAt, task.taskId, expectedRevision,
      );
      const persisted = requiredTaskRetentionRow(store, task.taskId);
      if (integer(persisted.revision) !== task.revision || persisted.trashed_at !== null) {
        throw new Error("task_revision_stale");
      }
    }),
    previewPermanentDelete: (taskId, expectedRevision) => store.transaction(() => {
      assertSessionIdTaskReadyForPermanentDelete(store, taskId, expectedRevision);
      return Object.freeze({
        taskId,
        expectedRevision,
        productRecordCounts: countSessionIdTaskGraph(store, taskId),
        workspaceFilesWillRemain: true as const,
      });
    }),
    getPermanentDeleteIntent: (commandId) => toSessionIdTaskDeleteIntent(store.one<Row>(
      "SELECT * FROM session_id_task_permanent_delete_intents WHERE command_id = ?",
      commandId,
    )),
    getPermanentDeleteTombstone: (commandId) => toSessionIdTaskDeleteTombstone(store.one<Row>(
      "SELECT * FROM session_id_task_permanent_delete_tombstones WHERE command_id = ?",
      commandId,
    )),
    preparePermanentDelete: (intent) => store.transaction(() => {
      const tombstone = retention.getPermanentDeleteTombstone(intent.commandId);
      if (tombstone) {
        if (tombstone.taskId !== intent.taskId || tombstone.payloadFingerprint !== intent.payloadFingerprint) {
          throw new Error("runtime_command_id_reused_with_different_payload");
        }
        throw new Error("session_id_task_permanent_delete_already_completed");
      }
      const existing = retention.getPermanentDeleteIntent(intent.commandId);
      if (existing) {
        if (existing.taskId !== intent.taskId
          || existing.expectedRevision !== intent.expectedRevision
          || existing.payloadFingerprint !== intent.payloadFingerprint) {
          throw new Error("runtime_command_id_reused_with_different_payload");
        }
        return existing;
      }
      const taskIntent = toSessionIdTaskDeleteIntent(store.one<Row>(
        "SELECT * FROM session_id_task_permanent_delete_intents WHERE task_id = ?",
        intent.taskId,
      ));
      if (taskIntent) throw new Error("session_id_task_permanent_delete_in_progress");
      assertSessionIdTaskReadyForPermanentDelete(store, intent.taskId, intent.expectedRevision);
      store.run(
        `INSERT INTO session_id_task_permanent_delete_intents(
           command_id, task_id, expected_revision, payload_fingerprint, prepared_at
         ) VALUES (?, ?, ?, ?, ?)`,
        intent.commandId, intent.taskId, intent.expectedRevision, intent.payloadFingerprint, intent.preparedAt,
      );
      return Object.freeze({ ...intent });
    }),
    completePermanentDelete: (input) => store.transaction(() => {
      const replay = retention.getPermanentDeleteTombstone(input.commandId);
      if (replay) {
        if (replay.taskId !== input.taskId || replay.payloadFingerprint !== input.payloadFingerprint) {
          throw new Error("runtime_command_id_reused_with_different_payload");
        }
        return replay;
      }
      const intent = retention.getPermanentDeleteIntent(input.commandId);
      if (!intent) throw new Error("session_id_task_permanent_delete_intent_not_found");
      if (intent.taskId !== input.taskId || intent.payloadFingerprint !== input.payloadFingerprint) {
        throw new Error("runtime_command_id_reused_with_different_payload");
      }
      assertSessionIdTaskReadyForPermanentDelete(store, intent.taskId, intent.expectedRevision);
      deleteSessionIdTaskGraph(store, intent.taskId);
      const result: SessionIdTaskPermanentDeleteResult = Object.freeze({
        taskId: intent.taskId,
        deletedAt: input.deletedAt,
        workspaceFilesWillRemain: true,
      });
      store.run(
        `INSERT INTO session_id_task_permanent_delete_tombstones(
           command_id, task_id, payload_fingerprint, result_json, deleted_at
         ) VALUES (?, ?, ?, ?, ?)`,
        intent.commandId, intent.taskId, intent.payloadFingerprint, encodeJson(result), input.deletedAt,
      );
      return Object.freeze({
        commandId: intent.commandId,
        taskId: intent.taskId,
        payloadFingerprint: intent.payloadFingerprint,
        result,
        deletedAt: input.deletedAt,
      });
    }),
  };

  const owners: SessionIdOwnerCapabilities = Object.freeze({
    taskRun,
    binding,
    providerFact,
    message,
    humanIntervention,
    orchestration,
    reliability,
    workspace,
    retention,
  });
  return Object.freeze({
    ...owners,
    transaction: <T>(work: (capabilities: SessionIdOwnerCapabilities) => T) => store.transaction(() => work(owners)),
  });
}

function requiredTaskRetentionRow(store: SqliteRuntimeStore, taskId: string): Row {
  if (!store.one<Row>("SELECT 1 FROM session_id_tasks WHERE task_id = ?", taskId)) {
    throw new Error("session_id_task_not_found");
  }
  const row = store.one<Row>(
    "SELECT task_id, architecture_snapshot_id, status, trashed_at, achievement_json, active_run_id, revision FROM tasks WHERE task_id = ?",
    taskId,
  );
  if (!row) throw new Error("task_not_found");
  return row;
}

function assertSessionIdTaskReadyForPermanentDelete(
  store: SqliteRuntimeStore,
  taskId: string,
  expectedRevision: number,
): void {
  const task = requiredTaskRetentionRow(store, taskId);
  if (integer(task.revision) !== expectedRevision) throw new Error("task_revision_stale");
  if (task.trashed_at === null || task.trashed_at === undefined) {
    throw new Error("task_permanent_delete_requires_archived");
  }
  assertSessionIdTaskQuiescent(store, taskId);
}

function assertSessionIdTaskQuiescent(store: SqliteRuntimeStore, taskId: string): void {
  const blockers = [
    store.one<Row>(
      `SELECT 1 FROM task_runs
       WHERE task_id = ? AND status NOT IN ('stopped', 'failed', 'cancellation_unknown') LIMIT 1`,
      taskId,
    ),
    store.one<Row>(
      `SELECT 1 FROM session_id_provider_bindings
       WHERE task_id = ? AND status NOT IN ('released', 'unrecoverable') LIMIT 1`,
      taskId,
    ),
    store.one<Row>(
      `SELECT 1 FROM session_id_acp_v3_bindings
       WHERE task_id = ? AND status NOT IN ('released', 'unrecoverable') LIMIT 1`,
      taskId,
    ),
    store.one<Row>(
      `SELECT 1 FROM session_id_acp_v3_execution_runtimes
       WHERE task_id = ? AND state <> 'closed' LIMIT 1`,
      taskId,
    ),
    store.one<Row>(
      `SELECT 1 FROM session_id_logical_sessions
       WHERE task_id = ? AND lifecycle = 'current' LIMIT 1`,
      taskId,
    ),
    store.one<Row>(
      `SELECT 1 FROM session_id_card_session_slots
       WHERE task_id = ? AND current_session_id IS NOT NULL LIMIT 1`,
      taskId,
    ),
    store.one<Row>(
      `SELECT 1 FROM session_id_session_inbox_items
       WHERE task_id = ? AND state IN ('pending', 'held_by_human_intervention', 'leased', 'handed', 'ambiguous') LIMIT 1`,
      taskId,
    ),
    store.one<Row>(
      `SELECT 1 FROM session_id_input_submissions
       WHERE task_id = ? AND state IN ('pending', 'handed', 'accepted', 'ambiguous') LIMIT 1`,
      taskId,
    ),
    store.one<Row>(
      `SELECT 1 FROM session_id_session_turns
       WHERE task_id = ? AND state IN ('pending', 'active', 'ambiguous') LIMIT 1`,
      taskId,
    ),
    store.one<Row>(
      `SELECT 1 FROM session_id_session_control_audits
       WHERE task_id = ? AND state IN ('requested', 'accepted', 'unknown') LIMIT 1`,
      taskId,
    ),
    store.one<Row>(
      `SELECT 1 FROM session_id_attentions
       WHERE task_id = ? AND status IN ('requested', 'response_staged', 'effect_accepted', 'unknown') LIMIT 1`,
      taskId,
    ),
    store.one<Row>(
      `SELECT 1 FROM session_id_provider_effect_outbox
       WHERE task_id = ? AND state IN ('pending', 'leased', 'unknown') LIMIT 1`,
      taskId,
    ),
    store.one<Row>(
      `SELECT 1 FROM session_id_human_interventions
       WHERE task_id = ? AND state IN ('accepted', 'held') LIMIT 1`,
      taskId,
    ),
    store.one<Row>(
      `SELECT 1 FROM session_id_workspace_effect_intents
       WHERE task_id = ? AND state IN ('pending', 'unknown') LIMIT 1`,
      taskId,
    ),
  ];
  if (blockers.some(Boolean)) throw new Error("task_retention_not_quiescent");
}

function countSessionIdTaskGraph(
  store: SqliteRuntimeStore,
  taskId: string,
): SessionIdTaskPermanentDeleteRecordCounts {
  const count = (sql: string) => integer(store.one<Row>(sql, taskId)?.count);
  return Object.freeze({
    taskRuns: count("SELECT COUNT(*) AS count FROM task_runs WHERE task_id = ?"),
    cardSessionSlots: count("SELECT COUNT(*) AS count FROM session_id_card_session_slots WHERE task_id = ?"),
    logicalSessions: count("SELECT COUNT(*) AS count FROM session_id_logical_sessions WHERE task_id = ?"),
    planningFences: count("SELECT COUNT(*) AS count FROM session_id_conductor_planning_fences WHERE task_id = ?"),
    messages: count("SELECT COUNT(*) AS count FROM session_id_session_messages WHERE task_id = ?"),
    relayBlocks: count(`SELECT COUNT(*) AS count FROM session_id_relay_blocks block
      JOIN session_id_session_messages message ON message.message_id = block.source_message_id
      WHERE message.task_id = ?`),
    messageForwards: count("SELECT COUNT(*) AS count FROM session_id_message_forwards WHERE task_id = ?"),
    humanInterventions: count("SELECT COUNT(*) AS count FROM session_id_human_interventions WHERE task_id = ?"),
    inboxItems: count("SELECT COUNT(*) AS count FROM session_id_session_inbox_items WHERE task_id = ?"),
    inputSubmissions: count("SELECT COUNT(*) AS count FROM session_id_input_submissions WHERE task_id = ?"),
    sessionTurns: count("SELECT COUNT(*) AS count FROM session_id_session_turns WHERE task_id = ?"),
    controlAudits: count("SELECT COUNT(*) AS count FROM session_id_session_control_audits WHERE task_id = ?"),
    workspaceEffectIntents: count("SELECT COUNT(*) AS count FROM session_id_workspace_effect_intents WHERE task_id = ?"),
    workspaceFileObservations: count("SELECT COUNT(*) AS count FROM session_id_workspace_file_observations WHERE task_id = ?"),
    providerBindings: count(`SELECT
      (SELECT COUNT(*) FROM session_id_provider_bindings WHERE task_id = ?1)
      + (SELECT COUNT(*) FROM session_id_acp_v3_bindings WHERE task_id = ?1) AS count`),
    providerFacts: count(`SELECT COUNT(*) AS count FROM session_id_provider_facts fact
      JOIN session_id_provider_bindings binding ON binding.binding_id = fact.binding_id
      WHERE binding.task_id = ?`),
    attentions: count("SELECT COUNT(*) AS count FROM session_id_attentions WHERE task_id = ?"),
    commandReceipts: count("SELECT COUNT(*) AS count FROM session_id_command_receipts WHERE task_id = ?"),
    uiCommandReceipts: count("SELECT COUNT(*) AS count FROM session_id_ui_command_receipts WHERE task_id = ?"),
    providerEffects: count(`SELECT
      (SELECT COUNT(*) FROM session_id_provider_effect_outbox WHERE task_id = ?1)
      + (SELECT COUNT(*) FROM session_id_acp_v3_provider_effect_intents WHERE task_id = ?1) AS count`),
    sessionExecutionRuntimes: count("SELECT COUNT(*) AS count FROM session_id_acp_v3_execution_runtimes WHERE task_id = ?"),
    sessionExecutionAttempts: count("SELECT COUNT(*) AS count FROM session_id_acp_v3_execution_attempts WHERE task_id = ?"),
  });
}

function deleteSessionIdTaskGraph(store: SqliteRuntimeStore, taskId: string): void {
  // Child-first order is explicit so a failed delete rolls the whole Task graph back.
  store.run("DELETE FROM session_id_acp_v3_provider_effect_intents WHERE task_id = ?", taskId);
  store.run("DELETE FROM session_id_acp_v3_execution_attempts WHERE task_id = ?", taskId);
  store.run(
    `DELETE FROM session_id_acp_v3_current_bindings WHERE binding_id IN (
       SELECT binding_id FROM session_id_acp_v3_bindings WHERE task_id = ?
     )`,
    taskId,
  );
  store.run("DELETE FROM session_id_acp_v3_execution_runtimes WHERE task_id = ?", taskId);
  store.run("DELETE FROM session_id_acp_v3_bindings WHERE task_id = ?", taskId);
  store.run("DELETE FROM session_id_provider_effect_outbox WHERE task_id = ?", taskId);
  store.run("DELETE FROM session_id_attentions WHERE task_id = ?", taskId);
  store.run(
    `DELETE FROM session_id_provider_facts WHERE binding_id IN (
       SELECT binding_id FROM session_id_provider_bindings WHERE task_id = ?
     )`,
    taskId,
  );
  store.run("DELETE FROM session_id_command_receipts WHERE task_id = ?", taskId);
  store.run("DELETE FROM session_id_ui_command_receipts WHERE task_id = ?", taskId);
  store.run("DELETE FROM session_id_workspace_file_observations WHERE task_id = ?", taskId);
  store.run("DELETE FROM session_id_workspace_effect_intents WHERE task_id = ?", taskId);
  store.run("DELETE FROM session_id_session_control_audits WHERE task_id = ?", taskId);
  store.run("DELETE FROM session_id_session_turns WHERE task_id = ?", taskId);
  store.run("DELETE FROM session_id_input_submissions WHERE task_id = ?", taskId);
  store.run(
    `UPDATE session_id_session_inbox_items SET causal_predecessor_inbox_item_id = NULL
     WHERE task_id = ?`,
    taskId,
  );
  store.run("DELETE FROM session_id_session_inbox_items WHERE task_id = ?", taskId);
  store.run(
    `DELETE FROM session_id_message_forward_refs WHERE forward_id IN (
       SELECT forward_id FROM session_id_message_forwards WHERE task_id = ?
     )`,
    taskId,
  );
  store.run("DELETE FROM session_id_message_forwards WHERE task_id = ?", taskId);
  store.run(
    `DELETE FROM session_id_relay_blocks WHERE source_message_id IN (
       SELECT message_id FROM session_id_session_messages WHERE task_id = ?
     )`,
    taskId,
  );
  store.run("DELETE FROM session_id_human_interventions WHERE task_id = ?", taskId);
  store.run("DELETE FROM session_id_session_messages WHERE task_id = ?", taskId);
  store.run("DELETE FROM session_id_provider_bindings WHERE task_id = ?", taskId);
  store.run("DELETE FROM session_id_logical_sessions WHERE task_id = ?", taskId);
  store.run("DELETE FROM session_id_card_session_slots WHERE task_id = ?", taskId);
  store.run("DELETE FROM session_id_conductor_planning_fences WHERE task_id = ?", taskId);
  store.run("DELETE FROM task_runs WHERE task_id = ?", taskId);
  store.run("DELETE FROM session_id_task_permanent_delete_intents WHERE task_id = ?", taskId);
  store.run("UPDATE task_setup_drafts SET created_task_id = NULL WHERE created_task_id = ?", taskId);
  const task = requiredTaskRetentionRow(store, taskId);
  const architectureSnapshotId = text(task.architecture_snapshot_id);
  store.run("DELETE FROM session_id_tasks WHERE task_id = ?", taskId);
  store.run("DELETE FROM tasks WHERE task_id = ?", taskId);
  store.run("DELETE FROM task_architecture_snapshots WHERE architecture_snapshot_id = ?", architectureSnapshotId);
}

function toSessionIdTaskDeleteIntent(row?: Row): SessionIdTaskPermanentDeleteIntent | undefined {
  if (!row) return undefined;
  return Object.freeze({
    commandId: text(row.command_id),
    taskId: text(row.task_id),
    expectedRevision: integer(row.expected_revision),
    payloadFingerprint: text(row.payload_fingerprint),
    preparedAt: text(row.prepared_at),
  });
}

function toSessionIdTaskDeleteTombstone(row?: Row): SessionIdTaskPermanentDeleteTombstone | undefined {
  if (!row) return undefined;
  return Object.freeze({
    commandId: text(row.command_id),
    taskId: text(row.task_id),
    payloadFingerprint: text(row.payload_fingerprint),
    result: decodeJson<SessionIdTaskPermanentDeleteResult>(row.result_json),
    deletedAt: text(row.deleted_at),
  });
}

function assertMaterialization(slot: CardSessionSlotRecord, generation: CardSessionGenerationRecord): void {
  if (!slot.currentSessionId || slot.currentSessionId !== generation.sessionId) throw new Error("session_id_slot_pointer_invalid");
  if (slot.cardSessionSlotId !== generation.cardSessionSlotId
    || slot.taskId !== generation.taskId
    || slot.runId !== generation.runId
    || slot.agentCardId !== generation.agentCardId) {
    throw new Error("session_id_generation_scope_mismatch");
  }
  if (slot.latestGeneration !== generation.generation || generation.lifecycle !== "current" || generation.closedAt) {
    throw new Error("session_id_generation_state_invalid");
  }
}

function readSlot(store: SqliteRuntimeStore, slotId: string): CardSessionSlotRecord | undefined {
  return toSlot(store.one<Row>("SELECT * FROM session_id_card_session_slots WHERE card_session_slot_id = ?", slotId));
}

/**
 * The Phase-7 seal is durable Runtime truth, not a construction-time flag.
 * Every superseded direct writer rechecks it inside the same SQLite
 * transaction as its attempted mutation so another connection cannot race a
 * post-cutover write into retained historical tables.
 */
function assertSupersededDirectWriterOpen(store: SqliteRuntimeStore): void {
  const cutover = store.one<Row>(
    "SELECT value FROM runtime_meta WHERE key = ?",
    "acp_direct_binding_cutover_sealed",
  );
  if (cutover?.value === "1") throw new Error("session_id_direct_binding_cutover_sealed");
}

function toSlot(row?: Row): CardSessionSlotRecord | undefined {
  if (!row) return undefined;
  return compact({
    cardSessionSlotId: text(row.card_session_slot_id),
    taskId: text(row.task_id),
    runId: text(row.run_id),
    agentCardId: text(row.agent_card_id),
    currentSessionId: optionalText(row.current_session_id),
    latestGeneration: integer(row.latest_generation),
    revision: integer(row.revision),
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at),
  });
}

function toGeneration(row?: Row): CardSessionGenerationRecord | undefined {
  if (!row || optionalText(row.session_kind) === "conductor" || row.card_session_slot_id === null) return undefined;
  return {
    sessionId: text(row.session_id),
    cardSessionSlotId: text(row.card_session_slot_id),
    taskId: text(row.task_id),
    runId: text(row.run_id),
    agentCardId: text(row.agent_card_id),
    executionProfileId: text(row.execution_profile_id),
    generation: integer(row.generation),
    lifecycle: oneOf(row.lifecycle, ["current", "closed", "faulted"] as const),
    createdAt: text(row.created_at),
    ...(optionalText(row.closed_at) ? { closedAt: optionalText(row.closed_at)! } : {}),
  };
}

function toSessionIdBinding(row?: Row): SessionIdProviderBindingRecord | undefined {
  if (!row) return undefined;
  return compact({
    bindingId: text(row.binding_id),
    taskId: text(row.task_id),
    runId: text(row.run_id),
    sessionId: text(row.session_id),
    agentCardId: text(row.agent_card_id),
    executionProfileId: text(row.execution_profile_id),
    provider: oneOf(row.provider, ["opencode", "codex", "claude-code"] as const),
    providerHostId: optionalText(row.provider_host_id),
    nativeBindingRef: optionalText(row.native_binding_ref),
    status: oneOf(row.status, ["unbound", "binding_effect_accepted", "active", "recovering", "released", "unrecoverable"] as const),
    recoverable: integer(row.recoverable) === 1,
    revision: integer(row.revision),
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at),
  });
}

function toSessionIdTaskRun(row: Row): TaskRunRecord {
  return compact({
    runId: text(row.run_id),
    taskId: text(row.task_id),
    conductorLogicalSessionId: text(row.conductor_logical_session_id),
    status: text(row.status) as TaskRunRecord["status"],
    runNumber: integer(row.run_number),
    revision: integer(row.revision),
    startedAt: text(row.started_at),
    endedAt: optionalText(row.ended_at),
  });
}

function toSessionIdProviderFact(row?: Row): ProviderFact | undefined {
  if (!row) return undefined;
  return compact({
    providerFactId: text(row.provider_fact_id),
    provider: oneOf(row.provider, ["opencode", "codex", "claude-code"] as const),
    bindingId: text(row.binding_id),
    bindingRevision: integer(row.binding_revision),
    kind: text(row.kind) as ProviderFact["kind"],
    deduplication: decodeJson<ProviderFact["deduplication"]>(row.deduplication_json),
    correlation: decodeJson<ProviderFact["correlation"]>(row.correlation_json),
    evidenceReferenceId: optionalText(row.evidence_reference_id),
    payload: decodeJson<ProviderFact["payload"]>(row.payload_json),
    observedAt: text(row.observed_at),
  });
}

function toPlanningFence(row?: Row): ConductorPlanningFenceRecord | undefined {
  if (!row) return undefined;
  return compact({
    planningFenceId: text(row.planning_fence_id),
    taskId: text(row.task_id),
    runId: text(row.run_id),
    sourceCommandId: text(row.source_command_id),
    previousConductorSessionTurnId: optionalText(row.previous_conductor_session_turn_id),
    currentConductorSessionTurnId: optionalText(row.current_conductor_session_turn_id),
    createdAt: text(row.created_at),
  });
}

function toMessage(row?: Row): SessionIdSessionMessageRecord | undefined {
  if (!row) return undefined;
  return compact({
    messageId: text(row.message_id),
    taskId: text(row.task_id),
    runId: text(row.run_id),
    sourceSessionId: optionalText(row.source_session_id),
    sourceSessionTurnId: optionalText(row.source_session_turn_id),
    sourceHumanInterventionId: optionalText(row.source_human_intervention_id),
    kind: oneOf(row.kind, ["task_goal", "user_input", "conductor_forward", "agent_final", "runtime_notice"] as const),
    content: text(row.content),
    canonicalContent: decodeJson<CanonicalContent>(row.canonical_content_json),
    contentDigest: text(row.content_digest),
    createdAt: text(row.created_at),
  });
}

function toRelayBlock(row?: Row): SessionIdRelayBlockRecord | undefined {
  if (!row) return undefined;
  return compact({
    relayBlockId: text(row.relay_block_id),
    sourceMessageId: text(row.source_message_id),
    ordinal: integer(row.ordinal),
    suggestedTargetAgentCardIds: decodeJson<readonly string[]>(row.suggested_target_agent_card_ids_json),
    suggestedAudience: optionalOneOf(row.suggested_audience, ["one", "publish"] as const),
    topic: optionalText(row.topic),
    format: oneOf(row.format, ["text/markdown", "application/json"] as const),
    content: text(row.content),
    contentDigest: text(row.content_digest),
    sourceStart: integer(row.source_start),
    sourceEnd: integer(row.source_end),
    createdAt: text(row.created_at),
  });
}

function readForward(store: SqliteRuntimeStore, forwardId: string): SessionIdMessageForwardRecord | undefined {
  const row = store.one<Row>("SELECT * FROM session_id_message_forwards WHERE forward_id = ?", forwardId);
  if (!row) return undefined;
  const references = store.many<Row>(
    "SELECT * FROM session_id_message_forward_refs WHERE forward_id = ? ORDER BY ordinal", forwardId,
  ).map<MessageReferenceSnapshot>((reference) => compact({
    ordinal: integer(reference.ordinal),
    kind: oneOf(reference.kind, ["full_message", "relay_block"] as const),
    sourceMessageId: text(reference.source_message_id),
    relayBlockId: optionalText(reference.relay_block_id),
    contentDigest: text(reference.content_digest),
  }));
  return compact({
    forwardId: text(row.forward_id),
    taskId: text(row.task_id),
    runId: text(row.run_id),
    commandId: text(row.command_id),
    idempotencyKey: text(row.idempotency_key),
    decidedBySessionTurnId: text(row.decided_by_session_turn_id),
    targetSessionId: text(row.target_session_id),
    newContentDigest: optionalText(row.new_content_digest),
    orderedReferenceSnapshots: Object.freeze(references),
    renderedMessageId: text(row.rendered_message_id),
    createdAt: text(row.created_at),
  });
}

function toHumanIntervention(row?: Row): SessionIdHumanInterventionRecord | undefined {
  if (!row) return undefined;
  return compact({
    humanInterventionId: text(row.human_intervention_id),
    taskId: text(row.task_id),
    runId: text(row.run_id),
    commandId: text(row.command_id),
    idempotencyKey: text(row.idempotency_key),
    targetSessionId: text(row.target_session_id),
    mode: oneOf(row.mode, ["direct_message", "interrupt_then_send", "scoped_interrupt", "attention_response"] as const),
    state: oneOf(row.state, ["accepted", "held", "delivered", "abandoned", "cancelled_by_task_stop", "resolved"] as const),
    cardMessageId: optionalText(row.card_message_id),
    conductorMirrorMessageId: optionalText(row.conductor_mirror_message_id),
    affectedSessionTurnId: optionalText(row.affected_session_turn_id),
    attentionId: optionalText(row.attention_id),
    authenticatedUserId: optionalText(row.authenticated_user_id),
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at),
  });
}

function toLaneItem(row?: Row): SessionLaneItemRecord | undefined {
  if (!row) return undefined;
  return compact({
    inboxItemId: text(row.inbox_item_id),
    taskId: text(row.task_id),
    runId: text(row.run_id),
    sessionId: text(row.target_session_id),
    renderedMessageId: text(row.rendered_message_id),
    sequence: integer(row.sequence),
    priority: oneOf(row.priority, ["notice", "human", "ordinary"] as const),
    state: oneOf(row.state, ["pending", "held_by_human_intervention", "leased", "handed", "handled", "ambiguous", "suppressed"] as const),
    causalPredecessorInboxItemId: optionalText(row.causal_predecessor_inbox_item_id),
    humanInterventionId: optionalText(row.human_intervention_id),
    forwardId: optionalText(row.forward_id),
    reason: optionalText(row.reason),
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at),
  });
}

function toInputSubmission(row?: Row): SessionIdInputSubmissionRecord | undefined {
  if (!row) return undefined;
  return {
    inputSubmissionId: text(row.input_submission_id),
    taskId: text(row.task_id),
    runId: text(row.run_id),
    sessionId: text(row.session_id),
    sourceInboxItemId: text(row.source_inbox_item_id),
    contentMessageId: text(row.content_message_id),
    commandId: text(row.command_id),
    idempotencyKey: text(row.idempotency_key),
    sequence: integer(row.sequence),
    state: oneOf(row.state, ["pending", "handed", "accepted", "returned", "ambiguous", "failed", "cancelled"] as const),
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at),
  };
}

function toTurn(row?: Row): SessionIdSessionTurnRecord | undefined {
  if (!row) return undefined;
  return compact({
    sessionTurnId: text(row.session_turn_id),
    taskId: text(row.task_id),
    runId: text(row.run_id),
    sessionId: text(row.session_id),
    inputSubmissionId: text(row.input_submission_id),
    sourceConductorSessionTurnId: optionalText(row.source_conductor_session_turn_id),
    trigger: oneOf(row.trigger, ["task_goal", "human", "conductor_send", "session_return", "attention", "recovery"] as const),
    state: oneOf(row.state, ["pending", "active", "returned", "completed", "failed", "interrupted", "cancelled", "ambiguous"] as const),
    finalMessageId: optionalText(row.final_message_id),
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at),
    settledAt: optionalText(row.settled_at),
  });
}

function toSessionIdAttention(row?: Row): SessionIdAttentionRecord | undefined {
  if (!row) return undefined;
  return compact({
    attentionId: text(row.attention_id),
    taskId: text(row.task_id),
    runId: text(row.run_id),
    sessionId: text(row.session_id),
    bindingId: text(row.binding_id),
    bindingRevision: integer(row.binding_revision),
    sessionTurnId: text(row.session_turn_id),
    inputSubmissionId: text(row.input_submission_id),
    nativeRequestId: text(row.native_request_id),
    sourceProviderFactId: text(row.source_provider_fact_id),
    request: decodeJson<SessionIdAttentionRecord["request"]>(row.request_json),
    response: row.response_json === null || row.response_json === undefined
      ? undefined
      : decodeJson<SessionIdAttentionRecord["response"]>(row.response_json),
    responseCommandId: optionalText(row.response_command_id),
    humanInterventionId: optionalText(row.human_intervention_id),
    conductorMirrorMessageId: optionalText(row.conductor_mirror_message_id),
    responseOutboxId: optionalText(row.response_outbox_id),
    status: oneOf(row.status, ["requested", "response_staged", "effect_accepted", "resolved", "stale", "unknown"] as const),
    revision: integer(row.revision),
    reason: optionalText(row.reason),
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at),
    settledAt: optionalText(row.settled_at),
  });
}

function toCommandReceipt(row?: Row): SessionIdCommandReceiptRecord | undefined {
  if (!row) return undefined;
  return {
    commandId: text(row.command_id),
    taskId: text(row.task_id),
    runId: text(row.run_id),
    commandKind: oneOf(row.command_kind, ["invoke_agent", "send_to_session", "interrupt_session", "close_session"] as const),
    idempotencyKey: text(row.idempotency_key),
    payloadFingerprint: text(row.payload_fingerprint),
    result: decodeJson<JsonValue>(row.result_json),
    createdAt: text(row.created_at),
  };
}

function toUiCommandReceipt(row?: Row): SessionIdUiCommandReceiptRecord | undefined {
  if (!row) return undefined;
  return {
    commandId: text(row.command_id),
    taskId: text(row.task_id),
    runId: text(row.run_id),
    commandKind: oneOf(row.command_kind, [
      "task.submit_input",
      "session.send_human_message",
      "session.abandon_human_message",
      "session.request_interrupt",
      "session.respond_interaction",
      "session.respond_attention",
      "task.stop",
      "workspace.preview_file",
    ] as const),
    idempotencyKey: text(row.idempotency_key),
    payloadFingerprint: text(row.payload_fingerprint),
    result: decodeJson<JsonValue>(row.result_json),
    createdAt: text(row.created_at),
  };
}

function toProviderEffect(row?: Row): SessionIdProviderEffectIntentRecord | undefined {
  if (!row) return undefined;
  return compact({
    outboxId: text(row.outbox_id),
    taskId: text(row.task_id),
    runId: text(row.run_id),
    sessionId: text(row.session_id),
    sessionTurnId: optionalText(row.session_turn_id),
    sessionControlAuditId: optionalText(row.session_control_audit_id),
    attentionId: optionalText(row.attention_id),
    kind: oneOf(row.kind, ["ensure_binding", "submit_delivery", "request_interrupt", "respond_attention", "release_binding"] as const),
    idempotencyKey: text(row.idempotency_key),
    payload: decodeJson<JsonValue>(row.payload_json),
    payloadFingerprint: text(row.payload_fingerprint),
    state: oneOf(row.state, ["pending", "leased", "accepted", "rejected", "unknown", "suppressed"] as const),
    attempts: integer(row.attempts),
    leaseUntil: optionalText(row.lease_until),
    receipt: row.receipt_json === null || row.receipt_json === undefined
      ? undefined
      : decodeJson<JsonValue>(row.receipt_json),
    reason: optionalText(row.reason),
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at),
  });
}

function toControlAudit(row?: Row): SessionControlAuditRecord | undefined {
  if (!row) return undefined;
  return compact({
    sessionControlAuditId: text(row.session_control_audit_id),
    taskId: text(row.task_id),
    runId: text(row.run_id),
    sessionId: text(row.session_id),
    commandId: text(row.command_id),
    idempotencyKey: text(row.idempotency_key),
    kind: oneOf(row.kind, ["conductor_interrupt", "human_interrupt", "task_stop", "close"] as const),
    state: oneOf(row.state, ["requested", "accepted", "confirmed", "unknown", "rejected", "closed"] as const),
    affectedInboxItemIds: decodeJson<readonly string[]>(row.affected_inbox_item_ids_json),
    requestedAt: text(row.requested_at),
    settledAt: optionalText(row.settled_at),
    reason: optionalText(row.reason),
  });
}

function toWorkspaceEffect(row?: Row): WorkspaceEffectIntentRecord | undefined {
  if (!row) return undefined;
  return compact({
    workspaceEffectIntentId: text(row.workspace_effect_intent_id),
    taskId: text(row.task_id),
    runId: text(row.run_id),
    publisherSessionId: text(row.publisher_session_id),
    publisherSessionTurnId: text(row.publisher_session_turn_id),
    providerCallId: text(row.provider_call_id),
    idempotencyKey: text(row.idempotency_key),
    workspaceRelativePath: text(row.workspace_relative_path),
    contentDigest: text(row.content_digest),
    byteLength: integer(row.byte_length),
    state: oneOf(row.state, ["pending", "applied", "unknown", "failed"] as const),
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at),
    observationId: optionalText(row.observation_id),
    reason: optionalText(row.reason),
  });
}

function toWorkspaceObservation(row?: Row): WorkspaceFileObservationRecord | undefined {
  if (!row) return undefined;
  return compact({
    workspaceFileObservationId: text(row.workspace_file_observation_id),
    taskId: text(row.task_id),
    runId: optionalText(row.run_id),
    workspaceRelativePath: text(row.workspace_relative_path),
    contentDigest: optionalText(row.content_digest),
    byteLength: optionalInteger(row.byte_length),
    state: oneOf(row.state, ["available", "missing", "changed", "too_large", "unsupported"] as const),
    source: oneOf(row.source, ["verified_tool", "unverified"] as const),
    observedAt: text(row.observed_at),
  });
}

function sameWorkspaceEffectIdentity(left: WorkspaceEffectIntentRecord, right: WorkspaceEffectIntentRecord): boolean {
  return left.taskId === right.taskId
    && left.runId === right.runId
    && left.publisherSessionId === right.publisherSessionId
    && left.publisherSessionTurnId === right.publisherSessionTurnId
    && left.providerCallId === right.providerCallId
    && left.idempotencyKey === right.idempotencyKey
    && left.workspaceRelativePath === right.workspaceRelativePath
    && left.contentDigest === right.contentDigest
    && left.byteLength === right.byteLength
    && left.createdAt === right.createdAt;
}

function sameBindingIdentity(left: SessionIdProviderBindingRecord, right: SessionIdProviderBindingRecord): boolean {
  return left.taskId === right.taskId
    && left.runId === right.runId
    && left.sessionId === right.sessionId
    && left.agentCardId === right.agentCardId
    && left.executionProfileId === right.executionProfileId
    && left.provider === right.provider
    && left.createdAt === right.createdAt;
}

function sameInputIdentity(left: SessionIdInputSubmissionRecord, right: SessionIdInputSubmissionRecord): boolean {
  return left.taskId === right.taskId
    && left.runId === right.runId
    && left.sessionId === right.sessionId
    && left.sourceInboxItemId === right.sourceInboxItemId
    && left.contentMessageId === right.contentMessageId
    && left.commandId === right.commandId
    && left.idempotencyKey === right.idempotencyKey
    && left.sequence === right.sequence
    && left.createdAt === right.createdAt;
}

function sameTurnIdentity(left: SessionIdSessionTurnRecord, right: SessionIdSessionTurnRecord): boolean {
  return left.taskId === right.taskId
    && left.runId === right.runId
    && left.sessionId === right.sessionId
    && left.inputSubmissionId === right.inputSubmissionId
    && left.sourceConductorSessionTurnId === right.sourceConductorSessionTurnId
    && left.trigger === right.trigger
    && left.createdAt === right.createdAt;
}

function sameControlIdentity(left: SessionControlAuditRecord, right: SessionControlAuditRecord): boolean {
  return left.taskId === right.taskId
    && left.runId === right.runId
    && left.sessionId === right.sessionId
    && left.commandId === right.commandId
    && left.idempotencyKey === right.idempotencyKey
    && left.kind === right.kind
    && left.requestedAt === right.requestedAt;
}

function sameAttentionIdentity(left: SessionIdAttentionRecord, right: SessionIdAttentionRecord): boolean {
  return left.taskId === right.taskId
    && left.runId === right.runId
    && left.sessionId === right.sessionId
    && left.bindingId === right.bindingId
    && left.bindingRevision === right.bindingRevision
    && left.sessionTurnId === right.sessionTurnId
    && left.inputSubmissionId === right.inputSubmissionId
    && left.nativeRequestId === right.nativeRequestId
    && left.sourceProviderFactId === right.sourceProviderFactId
    && encodeJson(left.request) === encodeJson(right.request)
    && left.createdAt === right.createdAt;
}

function assertSessionTargetScope(
  store: SqliteRuntimeStore,
  taskId: string,
  runId: string,
  sessionId: string,
  reason: string,
): void {
  const card = store.one<Row>(
    `SELECT session_id FROM session_id_logical_sessions
     WHERE session_id = ? AND task_id = ? AND run_id = ?`,
    sessionId, taskId, runId,
  );
  const conductor = store.one<Row>(
    `SELECT conductor_logical_session_id FROM task_runs
     WHERE run_id = ? AND task_id = ? AND conductor_logical_session_id = ?`,
    runId, taskId, sessionId,
  );
  if (!card && !conductor) throw new Error(reason);
}

function text(value: unknown): string {
  if (typeof value !== "string") throw new Error("session_id_store_expected_text");
  return value;
}

function optionalText(value: unknown): string | undefined {
  return value === null || value === undefined ? undefined : text(value);
}

function integer(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value)) throw new Error("session_id_store_expected_integer");
  return value;
}

function optionalInteger(value: unknown): number | undefined {
  return value === null || value === undefined ? undefined : integer(value);
}

function oneOf<const T extends readonly string[]>(value: unknown, allowed: T): T[number] {
  if (typeof value !== "string" || !allowed.includes(value)) throw new Error("session_id_store_enum_invalid");
  return value as T[number];
}

function optionalOneOf<const T extends readonly string[]>(value: unknown, allowed: T): T[number] | undefined {
  return value === null || value === undefined ? undefined : oneOf(value, allowed);
}

function compact<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

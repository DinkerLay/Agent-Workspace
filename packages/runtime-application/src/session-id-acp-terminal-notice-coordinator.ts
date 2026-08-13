import {
  cloneAcpSafeSessionBindingRecordV3,
  cloneSessionExecutionAttemptRecord,
  cloneSessionRuntimeProviderEffectIntent,
  hashDefinition,
  type AcpSafeSessionBindingRecordV3,
  type CardSessionGenerationRecord,
  type CardSessionSlotRecord,
  type SessionControlAuditRecord,
  type SessionExecutionAttemptRecord,
  type SessionLaneItemRecord,
  type SessionRuntimeProviderEffectIntentRecord,
} from "@agent-workspace/runtime-contracts";
import { invariant } from "@agent-workspace/runtime-domain";
import type {
  SessionIdInputSubmissionRecord,
  SessionIdSessionMessageRecord,
  SessionIdSessionTurnRecord,
} from "@agent-workspace/runtime-store";

export type SessionIdAcpTerminalNoticeReason =
  | "delivery_ambiguous"
  | "delivery_rejected"
  | "delivery_failed"
  | "interrupt_confirmed"
  | "interrupt_unknown";

export type SessionIdAcpTerminalNoticeRequest = Readonly<{
  reason: SessionIdAcpTerminalNoticeReason;
  sessionExecutionAttemptId: string;
  sessionControlAuditId?: string;
}>;

export type SessionIdAcpTerminalNoticeResult =
  | Readonly<{
      status: "recorded" | "replayed";
      messageId: string;
      inboxItemId: string;
    }>
  | Readonly<{ status: "not_admitted" }>;

export interface SessionIdAcpTerminalNoticeTaskRunCapability {
  getGeneration(logicalSessionId: string): CardSessionGenerationRecord | undefined;
  getSlot(cardSessionSlotId: string): CardSessionSlotRecord | undefined;
  getConductorSessionId(taskId: string, runId: string): string;
  readTaskRunState(taskId: string, runId: string): Readonly<{
    taskId: string;
    runId: string;
    runStatus: string;
  }>;
}

export interface SessionIdAcpTerminalNoticeMessageCapability {
  getMessage(messageId: string): SessionIdSessionMessageRecord | undefined;
  createMessage(message: SessionIdSessionMessageRecord): void;
}

export interface SessionIdAcpTerminalNoticeOrchestrationCapability {
  getInputSubmission(inputSubmissionId: string): SessionIdInputSubmissionRecord | undefined;
  getTurn(sessionTurnId: string): SessionIdSessionTurnRecord | undefined;
  getInboxItem(inboxItemId: string): SessionLaneItemRecord | undefined;
  getControlAudit(sessionControlAuditId: string): SessionControlAuditRecord | undefined;
  listInboxItems(logicalSessionId: string): readonly SessionLaneItemRecord[];
  createInboxItem(item: SessionLaneItemRecord): void;
}

export interface SessionIdAcpTerminalNoticeBindingReadCapability {
  getCurrentBinding(logicalSessionId: string): AcpSafeSessionBindingRecordV3 | undefined;
}

export interface SessionIdAcpTerminalNoticeExecutionReadCapability {
  getAttempt(sessionExecutionAttemptId: string): SessionExecutionAttemptRecord | undefined;
}

export interface SessionIdAcpTerminalNoticeProviderEffectReadCapability {
  listProviderEffectIntents(
    sessionExecutionAttemptId?: string,
  ): readonly SessionRuntimeProviderEffectIntentRecord[];
}

export type SessionIdAcpTerminalNoticeCapabilities = Readonly<{
  taskRun: SessionIdAcpTerminalNoticeTaskRunCapability;
  message: SessionIdAcpTerminalNoticeMessageCapability;
  orchestration: SessionIdAcpTerminalNoticeOrchestrationCapability;
  currentBinding: SessionIdAcpTerminalNoticeBindingReadCapability;
  sessionExecution: SessionIdAcpTerminalNoticeExecutionReadCapability;
  providerEffects: SessionIdAcpTerminalNoticeProviderEffectReadCapability;
}>;

/** Production binds this transaction to the delivery/result owner's outer SQLite transaction. */
export interface SessionIdAcpTerminalNoticeTransaction {
  run<T>(work: (owners: SessionIdAcpTerminalNoticeCapabilities) => T): T;
}

export type SessionIdAcpTerminalNoticeCoordinatorOptions = Readonly<{
  now: () => string;
  task: Readonly<{
    taskId: string;
    runId: string;
    conductorSessionId: string;
  }>;
  transaction: SessionIdAcpTerminalNoticeTransaction;
}>;

/**
 * Canonical admission boundary for decision-relevant, non-Final ACP outcomes.
 *
 * Callers provide only the durable Attempt/Control identity and a closed safe
 * reason. Message body and Message/Inbox identities are rendered and derived
 * here, so replay cannot create another Notice after a crash.
 */
export function createSessionIdAcpTerminalNoticeCoordinator(
  options: SessionIdAcpTerminalNoticeCoordinatorOptions,
) {
  validateOptions(options);
  return Object.freeze({ acceptNotice });

  function acceptNotice(value: SessionIdAcpTerminalNoticeRequest): SessionIdAcpTerminalNoticeResult {
    const request = validateRequest(value);
    return options.transaction.run((owners) => {
      const proof = requireProof(owners, request);
      const run = owners.taskRun.readTaskRunState(options.task.taskId, options.task.runId);
      invariant(run.taskId === options.task.taskId && run.runId === options.task.runId,
        "session_id_acp_notice_run_scope_mismatch");
      invariant(owners.taskRun.getConductorSessionId(options.task.taskId, options.task.runId)
        === options.task.conductorSessionId,
      "session_id_acp_notice_conductor_scope_mismatch");
      if (run.runStatus !== "running") return Object.freeze({ status: "not_admitted" as const });

      const content = noticeContent(request.reason, proof.attempt.logicalSessionId, proof.control?.kind);
      const identity = noticeIdentity(request);
      const messageId = `message_acp_notice_${identity}`;
      const inboxItemId = `inbox_acp_notice_${identity}`;
      const existing = owners.message.getMessage(messageId);
      if (existing) {
        invariant(existing.taskId === options.task.taskId
          && existing.runId === options.task.runId
          && existing.sourceSessionId === proof.attempt.logicalSessionId
          && existing.sourceSessionTurnId === proof.turn.sessionTurnId
          && existing.kind === "runtime_notice"
          && existing.content === content
          && existing.contentDigest === hashDefinition(content),
        "session_id_acp_notice_replay_message_conflict");
        const lane = owners.orchestration.listInboxItems(options.task.conductorSessionId)
          .filter((item) => item.renderedMessageId === messageId);
        invariant(lane.length === 1 && lane[0]!.inboxItemId === inboxItemId,
          "session_id_acp_notice_replay_inbox_conflict");
        return Object.freeze({ status: "replayed" as const, messageId, inboxItemId });
      }

      const now = options.now();
      invariant(!owners.orchestration.listInboxItems(options.task.conductorSessionId)
        .some((item) => item.inboxItemId === inboxItemId || item.renderedMessageId === messageId),
      "session_id_acp_notice_identity_conflict");
      owners.message.createMessage(Object.freeze({
        messageId,
        taskId: options.task.taskId,
        runId: options.task.runId,
        sourceSessionId: proof.attempt.logicalSessionId,
        sourceSessionTurnId: proof.turn.sessionTurnId,
        kind: "runtime_notice" as const,
        content,
        canonicalContent: Object.freeze([{ kind: "text" as const, text: content }]),
        contentDigest: hashDefinition(content),
        createdAt: now,
      }));
      owners.orchestration.createInboxItem(Object.freeze({
        inboxItemId,
        taskId: options.task.taskId,
        runId: options.task.runId,
        sessionId: options.task.conductorSessionId,
        renderedMessageId: messageId,
        sequence: nextLaneSequence(owners, options.task.conductorSessionId),
        priority: "notice" as const,
        state: "pending" as const,
        createdAt: now,
        updatedAt: now,
      }));
      return Object.freeze({ status: "recorded" as const, messageId, inboxItemId });
    });
  }

  function requireProof(
    owners: SessionIdAcpTerminalNoticeCapabilities,
    request: SessionIdAcpTerminalNoticeRequest,
  ): Readonly<{
    attempt: SessionExecutionAttemptRecord;
    input: SessionIdInputSubmissionRecord;
    turn: SessionIdSessionTurnRecord;
    inbox: SessionLaneItemRecord;
    control?: SessionControlAuditRecord;
  }> {
    const persistedAttempt = owners.sessionExecution.getAttempt(request.sessionExecutionAttemptId);
    invariant(Boolean(persistedAttempt), "session_id_acp_notice_attempt_not_found");
    const attempt = cloneSessionExecutionAttemptRecord(persistedAttempt!);
    invariant(attempt.taskId === options.task.taskId && attempt.runId === options.task.runId,
      "session_id_acp_notice_attempt_scope_mismatch");
    requireCurrentExecutionFence(owners, attempt);
    const input = owners.orchestration.getInputSubmission(attempt.inputSubmissionId);
    const turn = owners.orchestration.getTurn(attempt.orchestrationSessionTurnId);
    invariant(Boolean(input) && Boolean(turn), "session_id_acp_notice_or_state_missing");
    const inbox = owners.orchestration.getInboxItem(input!.sourceInboxItemId);
    invariant(Boolean(inbox), "session_id_acp_notice_source_inbox_missing");
    invariant(input!.taskId === attempt.taskId
      && input!.runId === attempt.runId
      && input!.sessionId === attempt.logicalSessionId
      && turn!.taskId === attempt.taskId
      && turn!.runId === attempt.runId
      && turn!.sessionId === attempt.logicalSessionId
      && turn!.inputSubmissionId === input!.inputSubmissionId
      && inbox!.taskId === attempt.taskId
      && inbox!.runId === attempt.runId
      && inbox!.sessionId === attempt.logicalSessionId,
    "session_id_acp_notice_or_scope_mismatch");

    let control: SessionControlAuditRecord | undefined;
    if (request.reason === "interrupt_confirmed" || request.reason === "interrupt_unknown") {
      control = requireInterruptProof(owners, attempt, request.sessionControlAuditId!);
    }
    assertReasonState(request.reason, attempt, input!, turn!, inbox!, control);
    return Object.freeze({ attempt, input: input!, turn: turn!, inbox: inbox!, ...(control ? { control } : {}) });
  }

  function requireCurrentExecutionFence(
    owners: SessionIdAcpTerminalNoticeCapabilities,
    attempt: SessionExecutionAttemptRecord,
  ): void {
    const generation = owners.taskRun.getGeneration(attempt.logicalSessionId);
    invariant(Boolean(generation)
      && generation!.sessionId === attempt.logicalSessionId
      && generation!.taskId === attempt.taskId
      && generation!.runId === attempt.runId
      && generation!.executionProfileId === attempt.executionProfileId
      && generation!.lifecycle === "current"
      && generation!.closedAt === undefined,
    "session_id_acp_notice_session_not_current");
    const slot = owners.taskRun.getSlot(generation!.cardSessionSlotId);
    invariant(Boolean(slot)
      && slot!.taskId === generation!.taskId
      && slot!.runId === generation!.runId
      && slot!.agentCardId === generation!.agentCardId
      && slot!.currentSessionId === attempt.logicalSessionId
      && slot!.latestGeneration === generation!.generation,
    "session_id_acp_notice_session_not_current");
    const persistedBinding = owners.currentBinding.getCurrentBinding(attempt.logicalSessionId);
    invariant(Boolean(persistedBinding), "session_id_acp_notice_current_binding_missing");
    const binding = cloneAcpSafeSessionBindingRecordV3(persistedBinding!);
    invariant((binding.status === "active" || binding.status === "recovering")
      && binding.taskId === attempt.taskId
      && binding.runId === attempt.runId
      && binding.logicalSessionId === attempt.logicalSessionId
      && binding.agentCardId === generation!.agentCardId
      && binding.bindingId === attempt.bindingId
      && binding.revision === attempt.bindingRevision
      && binding.executionProfileId === attempt.executionProfileId
      && binding.profileRevisionId === attempt.profileRevisionId,
    "session_id_acp_notice_current_binding_mismatch");
  }

  function requireInterruptProof(
    owners: SessionIdAcpTerminalNoticeCapabilities,
    attempt: SessionExecutionAttemptRecord,
    sessionControlAuditId: string,
  ): SessionControlAuditRecord {
    const control = owners.orchestration.getControlAudit(sessionControlAuditId);
    invariant(Boolean(control)
      && control!.taskId === attempt.taskId
      && control!.runId === attempt.runId
      && control!.sessionId === attempt.logicalSessionId
      && (control!.kind === "conductor_interrupt" || control!.kind === "human_interrupt"),
    "session_id_acp_notice_interrupt_control_mismatch");
    const effects = owners.providerEffects.listProviderEffectIntents(attempt.sessionExecutionAttemptId)
      .map(cloneSessionRuntimeProviderEffectIntent)
      .filter((intent) => intent.commandType === "session_runtime.request_interrupt"
        && intent.effect.kind === "request_interrupt"
        && intent.sessionControlAuditId === sessionControlAuditId);
    invariant(effects.length === 1, "session_id_acp_notice_interrupt_effect_missing");
    const effect = effects[0]!;
    invariant(effect.taskId === attempt.taskId
      && effect.runId === attempt.runId
      && effect.logicalSessionId === attempt.logicalSessionId
      && effect.sessionExecutionAttemptId === attempt.sessionExecutionAttemptId
      && effect.inputSubmissionId === attempt.inputSubmissionId
      && effect.orchestrationSessionTurnId === attempt.orchestrationSessionTurnId
      && effect.effect.kind === "request_interrupt"
      && effect.effect.sessionExecutionAttemptId === attempt.sessionExecutionAttemptId
      && effect.effect.sessionControlAuditId === sessionControlAuditId,
    "session_id_acp_notice_interrupt_effect_mismatch");
    return control!;
  }
}

function assertReasonState(
  reason: SessionIdAcpTerminalNoticeReason,
  attempt: SessionExecutionAttemptRecord,
  input: SessionIdInputSubmissionRecord,
  turn: SessionIdSessionTurnRecord,
  inbox: SessionLaneItemRecord,
  control?: SessionControlAuditRecord,
): void {
  if (reason === "delivery_ambiguous") {
    invariant(attempt.state === "reconciling" && !attempt.settlement
      && input.state === "ambiguous" && turn.state === "ambiguous" && inbox.state === "ambiguous",
    "session_id_acp_notice_delivery_ambiguous_state_mismatch");
    return;
  }
  if (reason === "delivery_rejected") {
    invariant(!attempt.receiptDigest && !attempt.settlement
      && input.state === "failed" && turn.state === "failed" && inbox.state === "suppressed",
    "session_id_acp_notice_delivery_rejected_state_mismatch");
    return;
  }
  if (reason === "delivery_failed") {
    invariant(attempt.state === "settled" && attempt.settlement?.outcome === "failed"
      && input.state === "failed" && turn.state === "failed" && inbox.state === "handled",
    "session_id_acp_notice_delivery_failed_state_mismatch");
    return;
  }
  if (reason === "interrupt_confirmed") {
    invariant(attempt.state === "settled" && attempt.settlement?.outcome === "cancelled"
      && control?.state === "confirmed"
      && input.state === "cancelled" && turn.state === "interrupted" && inbox.state === "handled",
    "session_id_acp_notice_interrupt_confirmed_state_mismatch");
    return;
  }
  invariant(attempt.state === "reconciling" && !attempt.settlement
    && control?.state === "unknown" && control.reason === "provider_outcome_unknown"
    && input.state === "accepted" && turn.state === "ambiguous" && inbox.state === "handed",
  "session_id_acp_notice_interrupt_unknown_state_mismatch");
}

function noticeContent(
  reason: SessionIdAcpTerminalNoticeReason,
  logicalSessionId: string,
  controlKind?: SessionControlAuditRecord["kind"],
): string {
  if (reason === "delivery_ambiguous") {
    return `Delivery outcome for Session ${logicalSessionId} is unknown; reconcile before routing more work.`;
  }
  if (reason === "delivery_rejected") {
    return `Delivery to Session ${logicalSessionId} was rejected before receipt; replan before continuing.`;
  }
  if (reason === "delivery_failed") {
    return `Session ${logicalSessionId} ended without a Final; review the failure and replan.`;
  }
  const actor = controlKind === "human_interrupt" ? "Authenticated human" : "Conductor-requested";
  if (reason === "interrupt_confirmed") {
    return `${actor} scoped interrupt was confirmed for Session ${logicalSessionId}; no Final was inferred.`;
  }
  return `${actor} scoped interrupt outcome is unknown for Session ${logicalSessionId}; reconcile before continuing.`;
}

function noticeIdentity(request: SessionIdAcpTerminalNoticeRequest): string {
  return hashDefinition({
    schemaVersion: 1,
    reason: request.reason,
    sessionExecutionAttemptId: request.sessionExecutionAttemptId,
    sessionControlAuditId: request.sessionControlAuditId ?? null,
  }).replace(/^sha256:/u, "");
}

function nextLaneSequence(
  owners: SessionIdAcpTerminalNoticeCapabilities,
  logicalSessionId: string,
): number {
  return owners.orchestration.listInboxItems(logicalSessionId)
    .reduce((highest, item) => Math.max(highest, item.sequence), 0) + 1;
}

function validateRequest(value: unknown): SessionIdAcpTerminalNoticeRequest {
  invariant(Boolean(value) && typeof value === "object" && !Array.isArray(value),
    "session_id_acp_notice_input_shape_invalid");
  const root = value as Record<string, unknown>;
  const reasons = new Set<SessionIdAcpTerminalNoticeReason>([
    "delivery_ambiguous",
    "delivery_rejected",
    "delivery_failed",
    "interrupt_confirmed",
    "interrupt_unknown",
  ]);
  invariant(typeof root.reason === "string" && reasons.has(root.reason as SessionIdAcpTerminalNoticeReason),
    "session_id_acp_notice_reason_invalid");
  invariant(typeof root.sessionExecutionAttemptId === "string"
    && /^session_execution_attempt_[A-Za-z0-9_-]+$/u.test(root.sessionExecutionAttemptId),
  "session_id_acp_notice_attempt_identity_invalid");
  const interrupt = root.reason === "interrupt_confirmed" || root.reason === "interrupt_unknown";
  const expectedKeys = interrupt
    ? ["reason", "sessionControlAuditId", "sessionExecutionAttemptId"]
    : ["reason", "sessionExecutionAttemptId"];
  invariant(Object.keys(root).sort().join("|") === expectedKeys.sort().join("|"),
    "session_id_acp_notice_input_shape_invalid");
  if (interrupt) {
    invariant(typeof root.sessionControlAuditId === "string"
      && /^session_control_[A-Za-z0-9_-]+$/u.test(root.sessionControlAuditId),
    "session_id_acp_notice_control_identity_invalid");
  }
  return Object.freeze({
    reason: root.reason as SessionIdAcpTerminalNoticeReason,
    sessionExecutionAttemptId: root.sessionExecutionAttemptId,
    ...(interrupt ? { sessionControlAuditId: root.sessionControlAuditId as string } : {}),
  });
}

function validateOptions(options: SessionIdAcpTerminalNoticeCoordinatorOptions): void {
  invariant(typeof options?.now === "function", "session_id_acp_notice_now_required");
  invariant(typeof options?.transaction?.run === "function", "session_id_acp_notice_transaction_required");
  invariant(/^task_[A-Za-z0-9_-]+$/u.test(options.task.taskId), "session_id_acp_notice_task_identity_invalid");
  invariant(/^run_[A-Za-z0-9_-]+$/u.test(options.task.runId), "session_id_acp_notice_run_identity_invalid");
  invariant(/^logical_session_[A-Za-z0-9_-]+$/u.test(options.task.conductorSessionId),
    "session_id_acp_notice_conductor_identity_invalid");
}

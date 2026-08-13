import type {
  AcpSafeSessionBindingRecordV3,
  CardSessionGenerationRecord,
  CardSessionSlotRecord,
  SessionControlAuditRecord,
  SessionExecutionAttemptRecord,
  SessionExecutionRuntimeRecord,
  SessionExecutionSettlement,
  SessionIdMessageForwardRecord,
  SessionLaneItemRecord,
  SessionRuntimeProviderEffectIntentRecord,
} from "@agent-workspace/runtime-contracts";
import {
  assertSessionExecutionSafeValue,
  cloneAcpSafeSessionBindingRecordV3,
  cloneSessionExecutionAttemptRecord,
  cloneSessionExecutionRuntimeRecord,
  cloneSessionExecutionSettlement,
  cloneSessionRuntimeProviderEffectIntent,
  hashDefinition,
} from "@agent-workspace/runtime-contracts";
import { invariant } from "@agent-workspace/runtime-domain";
import type {
  SessionIdHumanInterventionRecord,
  SessionIdInputSubmissionRecord,
  SessionIdSessionMessageRecord,
  SessionIdSessionTurnRecord,
} from "@agent-workspace/runtime-store";
import type {
  SessionIdAcpDrainableProviderEffect,
} from "./session-id-acp-orchestration-bridge.js";
import type {
  SessionExecutionSettlementResult,
} from "./session-execution-settlement-coordinator.js";
import type {
  SessionIdAcpTerminalNoticeRequest,
  SessionIdAcpTerminalNoticeResult,
} from "./session-id-acp-terminal-notice-coordinator.js";

export type SessionIdAcpDeliveryTaskScope = Readonly<{
  taskId: string;
  runId: string;
  conductorSessionId: string;
  initialConductorSessionTurnId: string;
}>;

export interface SessionIdAcpDeliveryTaskRunReadCapability {
  getGeneration(logicalSessionId: string): CardSessionGenerationRecord | undefined;
  getSlot(cardSessionSlotId: string): CardSessionSlotRecord | undefined;
  getConductorSessionId(taskId: string, runId: string): string;
  readTaskRunState(taskId: string, runId: string): Readonly<{
    taskId: string;
    runId: string;
    runStatus: string;
    currentConductorSessionTurnId?: string;
  }>;
}

export interface SessionIdAcpDeliveryMessageReadCapability {
  getMessage(messageId: string): SessionIdSessionMessageRecord | undefined;
  getForward(forwardId: string): SessionIdMessageForwardRecord | undefined;
}

export interface SessionIdAcpDeliveryOrchestrationCapability {
  getInboxItem(inboxItemId: string): SessionLaneItemRecord | undefined;
  listInboxItems(logicalSessionId: string): readonly SessionLaneItemRecord[];
  updateInboxItem(item: SessionLaneItemRecord, expectedState: SessionLaneItemRecord["state"]): void;
  createInputSubmission(input: SessionIdInputSubmissionRecord): void;
  getInputSubmission(inputSubmissionId: string): SessionIdInputSubmissionRecord | undefined;
  findInputByInboxItem(inboxItemId: string): SessionIdInputSubmissionRecord | undefined;
  updateInputSubmission(
    input: SessionIdInputSubmissionRecord,
    expectedState: SessionIdInputSubmissionRecord["state"],
  ): void;
  createTurn(turn: SessionIdSessionTurnRecord): void;
  getTurn(sessionTurnId: string): SessionIdSessionTurnRecord | undefined;
  findTurnByInputSubmission(inputSubmissionId: string): SessionIdSessionTurnRecord | undefined;
  listTurns(logicalSessionId: string): readonly SessionIdSessionTurnRecord[];
  updateTurn(turn: SessionIdSessionTurnRecord, expectedState: SessionIdSessionTurnRecord["state"]): void;
  getControlAudit(sessionControlAuditId: string): SessionControlAuditRecord | undefined;
  updateControlAudit(control: SessionControlAuditRecord, expectedState: SessionControlAuditRecord["state"]): void;
}

export interface SessionIdAcpDeliveryHumanInterventionCapability {
  get(humanInterventionId: string): SessionIdHumanInterventionRecord | undefined;
  update(intervention: SessionIdHumanInterventionRecord): void;
}

export interface SessionIdAcpDeliveryCurrentBindingReadCapability {
  getCurrentBinding(logicalSessionId: string): AcpSafeSessionBindingRecordV3 | undefined;
}

export interface SessionIdAcpDeliveryProviderEffectReadCapability {
  getProviderEffectIntent(providerEffectIntentId: string): SessionRuntimeProviderEffectIntentRecord | undefined;
  listProviderEffectIntents(sessionExecutionAttemptId?: string): readonly SessionRuntimeProviderEffectIntentRecord[];
}

export interface SessionIdAcpDeliverySessionExecutionReadCapability {
  getRuntime(sessionExecutionRuntimeId: string): SessionExecutionRuntimeRecord | undefined;
  getAttempt(sessionExecutionAttemptId: string): SessionExecutionAttemptRecord | undefined;
}

export type SessionIdAcpDeliveryResultOwnerCapabilities = Readonly<{
  taskRun: SessionIdAcpDeliveryTaskRunReadCapability;
  message: SessionIdAcpDeliveryMessageReadCapability;
  orchestration: SessionIdAcpDeliveryOrchestrationCapability;
  humanIntervention: SessionIdAcpDeliveryHumanInterventionCapability;
  currentBinding: SessionIdAcpDeliveryCurrentBindingReadCapability;
  providerEffects: SessionIdAcpDeliveryProviderEffectReadCapability;
  sessionExecution: SessionIdAcpDeliverySessionExecutionReadCapability;
}>;

/**
 * Production must bind both canonical OR repositories and ACP-v3 repositories
 * to the same SQLite outer transaction. The application coordinator owns no
 * rows; each capability still mutates only its canonical owner records.
 */
export interface SessionIdAcpDeliveryApplicationTransaction {
  run<T>(work: (owners: SessionIdAcpDeliveryResultOwnerCapabilities) => T): T;
}

export interface SessionIdAcpDeliveryBridge {
  stageDelivery(input: Readonly<{ inputSubmissionId: string }>): SessionIdAcpDrainableProviderEffect;
  acceptSettlement(settlement: SessionExecutionSettlement): SessionExecutionSettlementResult;
}

export interface SessionIdAcpDeliveryTerminalNoticeCoordinator {
  acceptNotice(input: SessionIdAcpTerminalNoticeRequest): SessionIdAcpTerminalNoticeResult;
}

export type SessionIdAcpDeliveryReceiptObservation = Readonly<{
  kind: "delivery_receipt";
  providerEffectIntentId: string;
  taskId: string;
  runId: string;
  logicalSessionId: string;
  sessionExecutionRuntimeId: string;
  sessionExecutionAttemptId: string;
  bindingId: string;
  bindingRevision: number;
  executionProfileId: string;
  profileRevisionId: string;
  bindingHandle: string;
  inputSubmissionId: string;
  orchestrationSessionTurnId: string;
  receiptDigest: string;
}>;

export type SessionIdAcpEffectObservation =
  | SessionIdAcpDeliveryReceiptObservation
  | Readonly<{
      kind: "delivery_unknown" | "delivery_rejected";
      providerEffectIntentId: string;
      sessionExecutionAttemptId: string;
    }>
  | Readonly<{
      kind: "interrupt_accepted" | "interrupt_confirmed" | "interrupt_unknown" | "interrupt_rejected";
      providerEffectIntentId: string;
      sessionExecutionAttemptId: string;
    }>;

export type SessionIdAcpDeliveryStageResult =
  | Readonly<{
      disposition: "idle";
      reason:
        | "run_not_accepting"
        | "binding_not_ready"
        | "no_pending_inbox"
        | "causal_predecessor_pending";
    }>
  | Readonly<{
      disposition: "staged" | "replay";
      inboxItemId: string;
      inputSubmissionId: string;
      sessionTurnId: string;
      providerEffectIntentId: string;
      sessionExecutionRuntimeId: string;
      sessionExecutionAttemptId: string;
    }>;

export type SessionIdAcpEffectObservationResult = Readonly<{
  status: "recorded" | "replayed";
  outcome:
    | "delivery_accepted"
    | "delivery_accepted_reconciling"
    | "delivery_ambiguous"
    | "delivery_rejected"
    | "interrupt_accepted"
    | "interrupt_confirmed"
    | "interrupt_unknown"
    | "interrupt_rejected";
}>;

export type SessionIdAcpDeliverySettlementResult =
  | SessionExecutionSettlementResult
  | Readonly<{
      status: "recorded" | "replayed";
      outcome: "conductor_turn_completed" | "delivery_failed" | "delivery_cancelled";
    }>;

export type SessionIdAcpDeliveryResultOwnerOptions = Readonly<{
  now: () => string;
  createId: (kind: "input" | "session_turn") => string;
  task: SessionIdAcpDeliveryTaskScope;
  transaction: SessionIdAcpDeliveryApplicationTransaction;
  bridge: SessionIdAcpDeliveryBridge;
  terminalNoticeCoordinator: SessionIdAcpDeliveryTerminalNoticeCoordinator;
}>;

type DeliveryContext = Readonly<{
  intent: SessionRuntimeProviderEffectIntentRecord;
  runtime: SessionExecutionRuntimeRecord;
  attempt: SessionExecutionAttemptRecord;
  binding: AcpSafeSessionBindingRecordV3;
  input: SessionIdInputSubmissionRecord;
  turn: SessionIdSessionTurnRecord;
  inbox: SessionLaneItemRecord;
}>;

const ACTIVE_TURN_STATES = new Set<SessionIdSessionTurnRecord["state"]>([
  "pending",
  "active",
  "ambiguous",
]);

/**
 * Provider-neutral ACP application owner for OR delivery staging and exact
 * receipt/outcome projection. It accepts only canonical owner records and the
 * safe opaque receipt projection; Host-private transport state stays outside.
 */
export function createSessionIdAcpDeliveryResultOwner(
  options: SessionIdAcpDeliveryResultOwnerOptions,
) {
  validateOptions(options);
  return Object.freeze({
    stageReadyDelivery,
    acceptEffectObservation,
    acceptSettlement,
  });

  function stageReadyDelivery(value: Readonly<{ logicalSessionId: string }>): SessionIdAcpDeliveryStageResult {
    const logicalSessionId = exactStageInput(value);
    return options.transaction.run((owners) => {
      const run = requireTaskRun(owners);
      if (run.runStatus !== "running" && run.runStatus !== "starting") {
        return Object.freeze({ disposition: "idle" as const, reason: "run_not_accepting" as const });
      }
      const isConductor = assertCurrentLogicalSession(owners, logicalSessionId);
      if (run.runStatus === "starting" && !isConductor) {
        return Object.freeze({ disposition: "idle" as const, reason: "run_not_accepting" as const });
      }
      const binding = owners.currentBinding.getCurrentBinding(logicalSessionId);
      if (!binding || (binding.status !== "active" && binding.status !== "recovering")) {
        return Object.freeze({ disposition: "idle" as const, reason: "binding_not_ready" as const });
      }
      assertBindingTaskScope(binding, logicalSessionId);

      const liveTurns = owners.orchestration.listTurns(logicalSessionId)
        .filter((turn) => ACTIVE_TURN_STATES.has(turn.state));
      invariant(liveTurns.length <= 1, "session_id_acp_delivery_lane_turn_ambiguous");
      if (liveTurns[0]) return recoverDelivery(owners, liveTurns[0], binding);

      const lane = owners.orchestration.listInboxItems(logicalSessionId);
      const pending = lane.filter((item) => item.state === "pending");
      const ready = pending.filter((item) => predecessorSettled(owners, item));
      if (ready.length === 0) {
        return Object.freeze({
          disposition: "idle" as const,
          reason: pending.length > 0 ? "causal_predecessor_pending" as const : "no_pending_inbox" as const,
        });
      }
      const selected = [...ready].sort((left, right) => compareInbox(owners, left, right))[0]!;
      const existingInput = owners.orchestration.findInputByInboxItem(selected.inboxItemId);
      invariant(!existingInput, "session_id_acp_delivery_pending_inbox_already_has_input");
      const message = requireMessage(owners, selected);
      if (run.runStatus === "starting" && message.kind !== "task_goal") {
        return Object.freeze({ disposition: "idle" as const, reason: "run_not_accepting" as const });
      }
      const forward = requireForward(owners, selected, message);
      const intervention = requireIntervention(owners, selected, options.task.conductorSessionId);
      invariant(!(forward && intervention), "session_id_acp_delivery_provenance_ambiguous");
      const now = options.now();
      const inputSubmissionId = requiredCreatedId(options.createId("input"), /^input_[A-Za-z0-9_-]+$/u,
        "session_id_acp_delivery_input_identity_invalid");
      const sessionTurnId = deliveryTurnId(owners, isConductor, message, run.currentConductorSessionTurnId);
      const input: SessionIdInputSubmissionRecord = Object.freeze({
        inputSubmissionId,
        taskId: options.task.taskId,
        runId: options.task.runId,
        sessionId: logicalSessionId,
        sourceInboxItemId: selected.inboxItemId,
        contentMessageId: message.messageId,
        commandId: deliveryCommandId(selected, forward, intervention),
        idempotencyKey: `acp-orchestration:input:${selected.inboxItemId}`,
        sequence: selected.sequence,
        state: "pending",
        createdAt: now,
        updatedAt: now,
      });
      const turn: SessionIdSessionTurnRecord = Object.freeze({
        sessionTurnId,
        taskId: options.task.taskId,
        runId: options.task.runId,
        sessionId: logicalSessionId,
        inputSubmissionId,
        ...(forward ? { sourceConductorSessionTurnId: forward.decidedBySessionTurnId } : {}),
        trigger: deliveryTrigger(isConductor, message, forward),
        state: "pending",
        createdAt: now,
        updatedAt: now,
      });
      invariant(!owners.orchestration.getTurn(sessionTurnId), "session_id_acp_delivery_turn_identity_conflict");
      owners.orchestration.createInputSubmission(input);
      owners.orchestration.createTurn(turn);
      owners.orchestration.updateInboxItem(Object.freeze({
        ...selected,
        state: "leased",
        updatedAt: now,
      }), "pending");
      if (intervention?.state === "accepted" && intervention.targetSessionId === selected.sessionId) {
        owners.humanIntervention.update(Object.freeze({
          ...intervention,
          state: "delivered",
          updatedAt: now,
        }));
      }
      const staged = options.bridge.stageDelivery({ inputSubmissionId });
      assertDrainScope(staged, input, turn);
      return stageResult(staged, selected, input, turn);
    });
  }

  function acceptEffectObservation(value: SessionIdAcpEffectObservation): SessionIdAcpEffectObservationResult {
    const observation = validateObservation(value);
    return options.transaction.run((owners) => {
      const context = requireEffectContext(owners, observation.providerEffectIntentId,
        observation.sessionExecutionAttemptId);
      if (observation.kind === "delivery_receipt") {
        assertDeliveryIntent(context);
        assertDeliveryReceipt(observation, context);
        invariant(Boolean(context.attempt.receiptDigest), "session_id_acp_delivery_receipt_not_observed");
        invariant(context.attempt.receiptDigest === observation.receiptDigest,
          "session_id_acp_delivery_receipt_mismatch");
        return acceptKnownDelivery(owners, context, "delivery_accepted");
      }
      if (observation.kind === "delivery_unknown") {
        assertDeliveryIntent(context);
        if (context.attempt.receiptDigest) {
          return acceptKnownDelivery(owners, context, "delivery_accepted_reconciling");
        }
        invariant(context.attempt.state === "reconciling" && !context.attempt.settlement,
          "session_id_acp_delivery_unknown_attempt_state_invalid");
        const result = markDeliveryUnknown(owners, context);
        acceptTerminalNotice("delivery_ambiguous", context.attempt);
        return result;
      }
      if (observation.kind === "delivery_rejected") {
        assertDeliveryIntent(context);
        invariant(!context.attempt.receiptDigest && !context.attempt.settlement,
          "session_id_acp_delivery_rejected_after_receipt");
        const result = markDeliveryRejected(owners, context);
        acceptTerminalNotice("delivery_rejected", context.attempt);
        return result;
      }
      assertInterruptIntent(context);
      const control = requiredControl(owners, context.intent);
      if (observation.kind === "interrupt_accepted") {
        return markInterruptAccepted(owners, control);
      }
      if (observation.kind === "interrupt_confirmed") {
        invariant(context.attempt.settlement?.outcome === "cancelled",
          "session_id_acp_interrupt_confirmation_not_observed");
        const result = markInterruptConfirmed(owners, context, control);
        acceptTerminalNotice("interrupt_confirmed", context.attempt, control.sessionControlAuditId);
        return result;
      }
      if (observation.kind === "interrupt_unknown") {
        invariant(context.attempt.state === "reconciling" && !context.attempt.settlement,
          "session_id_acp_interrupt_unknown_attempt_state_invalid");
        const result = markInterruptUnknown(owners, context, control);
        acceptTerminalNotice("interrupt_unknown", context.attempt, control.sessionControlAuditId);
        return result;
      }
      invariant(!context.attempt.settlement, "session_id_acp_interrupt_rejected_after_settlement");
      return markInterruptRejected(owners, control);
    });
  }

  function acceptSettlement(value: SessionExecutionSettlement): SessionIdAcpDeliverySettlementResult {
    const settlement = cloneSessionExecutionSettlement(value);
    return options.transaction.run((owners) => {
      const persistedAttempt = owners.sessionExecution.getAttempt(settlement.sessionExecutionAttemptId);
      invariant(Boolean(persistedAttempt), "session_id_acp_delivery_settlement_attempt_not_found");
      const attempt = cloneSessionExecutionAttemptRecord(persistedAttempt!);
      invariant(Boolean(attempt.settlement)
        && sameSettlement(attempt.settlement!, settlement),
      "session_id_acp_delivery_settlement_attempt_mismatch");
      assertSettlementAttemptScope(settlement, attempt);
      const persistedRuntime = owners.sessionExecution.getRuntime(settlement.sessionExecutionRuntimeId);
      invariant(Boolean(persistedRuntime), "session_id_acp_delivery_settlement_runtime_not_found");
      const runtime = cloneSessionExecutionRuntimeRecord(persistedRuntime!);
      assertRuntimeAttemptScope(runtime, attempt);
      const binding = requireCurrentBinding(owners, attempt);
      invariant(binding.bindingId === settlement.bindingId && binding.revision === settlement.bindingRevision,
        "session_id_acp_delivery_settlement_binding_mismatch");
      const input = owners.orchestration.getInputSubmission(settlement.inputSubmissionId);
      const turn = owners.orchestration.getTurn(settlement.orchestrationSessionTurnId);
      invariant(Boolean(input) && Boolean(turn), "session_id_acp_delivery_settlement_or_state_missing");
      const inbox = owners.orchestration.getInboxItem(input!.sourceInboxItemId);
      invariant(Boolean(inbox), "session_id_acp_delivery_settlement_inbox_missing");
      assertOrCorrelation(input!, turn!, inbox!, attempt);
      if (settlement.outcome === "completed") {
        const terminalInterrupt = closeTerminalWinningInterrupt(owners, attempt, input!, turn!, settlement);
        if (attempt.logicalSessionId === options.task.conductorSessionId) {
          return markConductorCompleted(
            owners,
            input!,
            turn!,
            inbox!,
            settlement,
            terminalInterrupt,
          );
        }
        const ready = input!.state === "accepted"
          && (turn!.state === "active" || (terminalInterrupt && turn!.state === "ambiguous"))
          && inbox!.state === "handed";
        const replay = input!.state === "returned" && turn!.state === "returned" && inbox!.state === "handled"
          && Boolean(turn!.finalMessageId);
        invariant(ready || replay, "session_id_acp_delivery_settlement_or_state_not_accepted");
        return options.bridge.acceptSettlement(settlement);
      }
      if (settlement.outcome === "failed") {
        const terminalInterrupt = closeTerminalWinningInterrupt(owners, attempt, input!, turn!, settlement);
        const result = markFailedSettlement(owners, input!, turn!, inbox!, settlement, terminalInterrupt);
        acceptTerminalNotice("delivery_failed", attempt);
        return result;
      }
      const interruptIntents = owners.providerEffects.listProviderEffectIntents(
        settlement.sessionExecutionAttemptId,
      ).map(cloneSessionRuntimeProviderEffectIntent).filter((intent) =>
        intent.commandType === "session_runtime.request_interrupt"
          && intent.effect.kind === "request_interrupt"
          && Boolean(intent.sessionControlAuditId));
      invariant(interruptIntents.length === 1, "session_id_acp_delivery_cancelled_interrupt_correlation_missing");
      const interrupt = requireEffectContext(
        owners,
        interruptIntents[0]!.providerEffectIntentId,
        settlement.sessionExecutionAttemptId,
      );
      assertInterruptIntent(interrupt);
      const control = requiredControl(owners, interrupt.intent);
      const cancellationReady = interrupt.input.state === "accepted"
        && interrupt.turn.state === "active"
        && interrupt.inbox.state === "handed"
        && (control.state === "requested" || control.state === "accepted");
      const cancellationReplay = interrupt.input.state === "cancelled"
        && interrupt.turn.state === "interrupted"
        && interrupt.inbox.state === "handled"
        && control.state === "confirmed";
      invariant(cancellationReady || cancellationReplay,
        "session_id_acp_delivery_cancelled_or_state_not_accepted");
      const result = markInterruptConfirmed(owners, interrupt, control);
      acceptTerminalNotice("interrupt_confirmed", attempt, control.sessionControlAuditId);
      return Object.freeze({ status: result.status, outcome: "delivery_cancelled" as const });
    });
  }

  function acceptTerminalNotice(
    reason: SessionIdAcpTerminalNoticeRequest["reason"],
    attempt: SessionExecutionAttemptRecord,
    sessionControlAuditId?: string,
  ): void {
    if (attempt.logicalSessionId === options.task.conductorSessionId) return;
    options.terminalNoticeCoordinator.acceptNotice(Object.freeze({
      reason,
      sessionExecutionAttemptId: attempt.sessionExecutionAttemptId,
      ...(sessionControlAuditId ? { sessionControlAuditId } : {}),
    }));
  }

  function markConductorCompleted(
    owners: SessionIdAcpDeliveryResultOwnerCapabilities,
    input: SessionIdInputSubmissionRecord,
    turn: SessionIdSessionTurnRecord,
    inbox: SessionLaneItemRecord,
    settlement: SessionExecutionSettlement,
    terminalInterrupt: boolean,
  ): SessionIdAcpDeliverySettlementResult {
    if (input.state === "returned" && turn.state === "returned" && inbox.state === "handled") {
      invariant(!turn.finalMessageId, "session_id_acp_conductor_turn_final_forbidden");
      return Object.freeze({ status: "replayed" as const, outcome: "conductor_turn_completed" as const });
    }
    invariant(input.state === "accepted"
      && (turn.state === "active" || (terminalInterrupt && turn.state === "ambiguous"))
      && inbox.state === "handed",
    "session_id_acp_conductor_turn_state_not_accepted");
    invariant(!turn.finalMessageId, "session_id_acp_conductor_turn_final_forbidden");
    owners.orchestration.updateInputSubmission(Object.freeze({
      ...input,
      state: "returned",
      updatedAt: settlement.settledAt,
    }), input.state);
    owners.orchestration.updateTurn(Object.freeze({
      ...turn,
      state: "returned",
      settledAt: settlement.settledAt,
      updatedAt: settlement.settledAt,
    }), turn.state);
    const { reason: _reason, ...inboxWithoutReason } = inbox;
    owners.orchestration.updateInboxItem(Object.freeze({
      ...inboxWithoutReason,
      state: "handled",
      updatedAt: settlement.settledAt,
    }), inbox.state);
    return Object.freeze({ status: "recorded" as const, outcome: "conductor_turn_completed" as const });
  }

  function closeTerminalWinningInterrupt(
    owners: SessionIdAcpDeliveryResultOwnerCapabilities,
    attempt: SessionExecutionAttemptRecord,
    input: SessionIdInputSubmissionRecord,
    turn: SessionIdSessionTurnRecord,
    settlement: SessionExecutionSettlement,
  ): boolean {
    const correlated = owners.providerEffects.listProviderEffectIntents()
      .map(cloneSessionRuntimeProviderEffectIntent)
      .filter((intent) => intent.commandType === "session_runtime.request_interrupt"
        && intent.effect.kind === "request_interrupt"
        && intent.taskId === settlement.taskId
        && intent.runId === settlement.runId
        && intent.logicalSessionId === settlement.logicalSessionId
        && intent.inputSubmissionId === input.inputSubmissionId
        && intent.orchestrationSessionTurnId === turn.sessionTurnId);
    if (correlated.length === 0) return false;
    invariant(correlated.length === 1,
      "session_id_acp_terminal_interrupt_correlation_ambiguous");
    const intent = correlated[0]!;
    invariant(intent.sessionExecutionAttemptId === attempt.sessionExecutionAttemptId
      && intent.effect.kind === "request_interrupt"
      && intent.effect.sessionExecutionAttemptId === attempt.sessionExecutionAttemptId,
    "session_id_acp_terminal_interrupt_attempt_mismatch");
    const context = requireEffectContext(
      owners,
      intent.providerEffectIntentId,
      attempt.sessionExecutionAttemptId,
    );
    assertInterruptIntent(context);
    const control = requiredControl(owners, context.intent);
    if (control.state === "unknown") {
      invariant(control.reason === "provider_terminal_won"
        || control.reason === "provider_outcome_unknown",
        "session_id_acp_terminal_interrupt_unknown_conflict");
      if (control.reason === "provider_outcome_unknown") {
        owners.orchestration.updateControlAudit(Object.freeze({
          ...control,
          settledAt: settlement.settledAt,
          reason: "provider_terminal_won",
        }), "unknown");
      }
      return true;
    }
    invariant(control.state === "requested" || control.state === "accepted",
      "session_id_acp_terminal_interrupt_state_conflict");
    owners.orchestration.updateControlAudit(Object.freeze({
      ...control,
      state: "unknown",
      settledAt: settlement.settledAt,
      reason: "provider_terminal_won",
    }), control.state);
    return true;
  }

  function markFailedSettlement(
    owners: SessionIdAcpDeliveryResultOwnerCapabilities,
    input: SessionIdInputSubmissionRecord,
    turn: SessionIdSessionTurnRecord,
    inbox: SessionLaneItemRecord,
    settlement: SessionExecutionSettlement,
    terminalInterrupt: boolean,
  ): SessionIdAcpDeliverySettlementResult {
    if (input.state === "failed" && turn.state === "failed" && inbox.state === "handled") {
      return Object.freeze({ status: "replayed" as const, outcome: "delivery_failed" as const });
    }
    invariant(input.state === "accepted"
      && (turn.state === "active" || (terminalInterrupt && turn.state === "ambiguous"))
      && inbox.state === "handed",
      "session_id_acp_delivery_failed_or_state_not_accepted");
    owners.orchestration.updateInputSubmission(Object.freeze({
      ...input,
      state: "failed",
      updatedAt: settlement.settledAt,
    }), "accepted");
    owners.orchestration.updateTurn(Object.freeze({
      ...turn,
      state: "failed",
      updatedAt: settlement.settledAt,
      settledAt: settlement.settledAt,
    }), turn.state);
    owners.orchestration.updateInboxItem(Object.freeze({
      ...inbox,
      state: "handled",
      updatedAt: settlement.settledAt,
    }), "handed");
    const sourceIntervention = inbox.humanInterventionId
      ? owners.humanIntervention.get(inbox.humanInterventionId)
      : undefined;
    if (sourceIntervention
      && sourceIntervention.targetSessionId === inbox.sessionId
      && sourceIntervention.cardMessageId === inbox.renderedMessageId
      && (sourceIntervention.state === "accepted" || sourceIntervention.state === "delivered")) {
      owners.humanIntervention.update(Object.freeze({
        ...sourceIntervention,
        state: "resolved",
        updatedAt: settlement.settledAt,
      }));
    }
    return Object.freeze({ status: "recorded" as const, outcome: "delivery_failed" as const });
  }

  function requireTaskRun(owners: SessionIdAcpDeliveryResultOwnerCapabilities) {
    const run = owners.taskRun.readTaskRunState(options.task.taskId, options.task.runId);
    invariant(run.taskId === options.task.taskId && run.runId === options.task.runId,
      "session_id_acp_delivery_task_run_scope_mismatch");
    invariant(owners.taskRun.getConductorSessionId(options.task.taskId, options.task.runId)
      === options.task.conductorSessionId,
    "session_id_acp_delivery_conductor_scope_mismatch");
    return run;
  }

  function assertCurrentLogicalSession(
    owners: SessionIdAcpDeliveryResultOwnerCapabilities,
    logicalSessionId: string,
  ): boolean {
    if (logicalSessionId === options.task.conductorSessionId) return true;
    const generation = owners.taskRun.getGeneration(logicalSessionId);
    invariant(Boolean(generation)
      && generation!.taskId === options.task.taskId
      && generation!.runId === options.task.runId
      && generation!.sessionId === logicalSessionId
      && generation!.lifecycle === "current"
      && generation!.closedAt === undefined,
    "session_id_acp_delivery_session_not_current");
    const slot = owners.taskRun.getSlot(generation!.cardSessionSlotId);
    invariant(Boolean(slot)
      && slot!.taskId === generation!.taskId
      && slot!.runId === generation!.runId
      && slot!.agentCardId === generation!.agentCardId
      && slot!.currentSessionId === logicalSessionId
      && slot!.latestGeneration === generation!.generation,
    "session_id_acp_delivery_session_not_current");
    return false;
  }

  function assertBindingTaskScope(binding: AcpSafeSessionBindingRecordV3, logicalSessionId: string): void {
    invariant(binding.schemaVersion === 3
      && binding.taskId === options.task.taskId
      && binding.runId === options.task.runId
      && binding.logicalSessionId === logicalSessionId,
    "session_id_acp_delivery_binding_scope_mismatch");
  }

  function recoverDelivery(
    owners: SessionIdAcpDeliveryResultOwnerCapabilities,
    turn: SessionIdSessionTurnRecord,
    binding: AcpSafeSessionBindingRecordV3,
  ): SessionIdAcpDeliveryStageResult {
    const input = owners.orchestration.getInputSubmission(turn.inputSubmissionId);
    invariant(Boolean(input), "session_id_acp_delivery_live_turn_input_missing");
    const inbox = owners.orchestration.getInboxItem(input!.sourceInboxItemId);
    invariant(Boolean(inbox), "session_id_acp_delivery_live_turn_inbox_missing");
    invariant(input!.taskId === options.task.taskId
      && input!.runId === options.task.runId
      && input!.sessionId === turn.sessionId
      && input!.sessionId === binding.logicalSessionId,
    "session_id_acp_delivery_live_turn_scope_mismatch");
    assertDeliveryTuple(input!, turn, inbox!);
    requireMessage(owners, inbox!);
    const staged = options.bridge.stageDelivery({ inputSubmissionId: input!.inputSubmissionId });
    assertDrainScope(staged, input!, turn);
    return stageResult(staged, inbox!, input!, turn);
  }

  function deliveryTurnId(
    owners: SessionIdAcpDeliveryResultOwnerCapabilities,
    isConductor: boolean,
    message: SessionIdSessionMessageRecord,
    currentConductorSessionTurnId?: string,
  ): string {
    if (!isConductor) {
      return requiredCreatedId(options.createId("session_turn"), /^session_turn_[A-Za-z0-9_-]+$/u,
        "session_id_acp_delivery_turn_identity_invalid");
    }
    if (message.kind === "task_goal") return options.task.initialConductorSessionTurnId;
    if (message.kind === "user_input" && !message.sourceHumanInterventionId) {
      invariant(Boolean(currentConductorSessionTurnId), "session_id_acp_delivery_planning_turn_missing");
      return currentConductorSessionTurnId!;
    }
    const allocated = requiredCreatedId(options.createId("session_turn"), /^session_turn_[A-Za-z0-9_-]+$/u,
      "session_id_acp_delivery_turn_identity_invalid");
    invariant(!owners.orchestration.getTurn(allocated), "session_id_acp_delivery_turn_identity_conflict");
    return allocated;
  }

  function requireEffectContext(
    owners: SessionIdAcpDeliveryResultOwnerCapabilities,
    providerEffectIntentId: string,
    sessionExecutionAttemptId: string,
  ): DeliveryContext {
    const persisted = owners.providerEffects.getProviderEffectIntent(providerEffectIntentId);
    invariant(Boolean(persisted), "session_id_acp_delivery_effect_intent_not_found");
    const intent = cloneSessionRuntimeProviderEffectIntent(persisted!);
    invariant(intent.providerEffectIntentId === providerEffectIntentId
      && intent.sessionExecutionAttemptId === sessionExecutionAttemptId,
    "session_id_acp_delivery_effect_attempt_mismatch");
    const persistedRuntime = owners.sessionExecution.getRuntime(intent.sessionExecutionRuntimeId);
    const persistedAttempt = owners.sessionExecution.getAttempt(sessionExecutionAttemptId);
    invariant(Boolean(persistedRuntime) && Boolean(persistedAttempt), "session_id_acp_delivery_execution_not_found");
    const runtime = cloneSessionExecutionRuntimeRecord(persistedRuntime!);
    const attempt = cloneSessionExecutionAttemptRecord(persistedAttempt!);
    assertRuntimeAttemptScope(runtime, attempt);
    assertCurrentLogicalSession(owners, attempt.logicalSessionId);
    assertIntentAttemptScope(intent, attempt);
    const binding = requireCurrentBinding(owners, attempt);
    invariant(intent.bindingId === binding.bindingId
      && intent.bindingRevision === binding.revision
      && intent.effect.bindingHandle === binding.bindingHandle,
    "session_id_acp_delivery_effect_binding_mismatch");
    const input = owners.orchestration.getInputSubmission(intent.inputSubmissionId);
    const turn = owners.orchestration.getTurn(intent.orchestrationSessionTurnId);
    invariant(Boolean(input) && Boolean(turn), "session_id_acp_delivery_or_state_missing");
    const inbox = owners.orchestration.getInboxItem(input!.sourceInboxItemId);
    invariant(Boolean(inbox), "session_id_acp_delivery_inbox_missing");
    assertOrCorrelation(input!, turn!, inbox!, attempt);
    return Object.freeze({ intent, runtime, attempt, binding, input: input!, turn: turn!, inbox: inbox! });
  }

  function requireCurrentBinding(
    owners: SessionIdAcpDeliveryResultOwnerCapabilities,
    attempt: SessionExecutionAttemptRecord,
  ): AcpSafeSessionBindingRecordV3 {
    const persisted = owners.currentBinding.getCurrentBinding(attempt.logicalSessionId);
    invariant(Boolean(persisted), "session_id_acp_delivery_current_binding_missing");
    const binding = cloneAcpSafeSessionBindingRecordV3(persisted!);
    invariant(binding.status === "active" || binding.status === "recovering",
      "session_id_acp_delivery_current_binding_missing");
    invariant(binding.taskId === attempt.taskId
      && binding.runId === attempt.runId
      && binding.logicalSessionId === attempt.logicalSessionId
      && binding.bindingId === attempt.bindingId
      && binding.revision === attempt.bindingRevision
      && binding.executionProfileId === attempt.executionProfileId
      && binding.profileRevisionId === attempt.profileRevisionId,
    "session_id_acp_delivery_current_binding_mismatch");
    return binding;
  }

  function acceptKnownDelivery(
    owners: SessionIdAcpDeliveryResultOwnerCapabilities,
    context: DeliveryContext,
    outcome: "delivery_accepted" | "delivery_accepted_reconciling",
  ): SessionIdAcpEffectObservationResult {
    if (acceptedTuple(context)) return Object.freeze({ status: "replayed" as const, outcome });
    const pending = pendingTuple(context);
    const recovering = ambiguousTuple(context);
    invariant(pending || recovering, "session_id_acp_delivery_receipt_or_state_conflict");
    const now = options.now();
    owners.orchestration.updateInputSubmission(Object.freeze({
      ...context.input,
      state: "accepted",
      updatedAt: now,
    }), context.input.state);
    owners.orchestration.updateTurn(Object.freeze({
      ...context.turn,
      state: "active",
      updatedAt: now,
    }), context.turn.state);
    const { reason: _unknownReason, ...inboxWithoutReason } = context.inbox;
    owners.orchestration.updateInboxItem(Object.freeze({
      ...inboxWithoutReason,
      state: "handed",
      updatedAt: now,
    }), context.inbox.state);
    return Object.freeze({ status: "recorded" as const, outcome });
  }

  function markDeliveryUnknown(
    owners: SessionIdAcpDeliveryResultOwnerCapabilities,
    context: DeliveryContext,
  ): SessionIdAcpEffectObservationResult {
    if (context.input.state === "ambiguous"
      && context.turn.state === "ambiguous"
      && context.inbox.state === "ambiguous") {
      return Object.freeze({ status: "replayed" as const, outcome: "delivery_ambiguous" as const });
    }
    invariant(pendingTuple(context), "session_id_acp_delivery_unknown_or_state_conflict");
    const now = options.now();
    owners.orchestration.updateInputSubmission(Object.freeze({
      ...context.input,
      state: "ambiguous",
      updatedAt: now,
    }), "pending");
    owners.orchestration.updateTurn(Object.freeze({
      ...context.turn,
      state: "ambiguous",
      updatedAt: now,
    }), "pending");
    owners.orchestration.updateInboxItem(Object.freeze({
      ...context.inbox,
      state: "ambiguous",
      reason: "provider_outcome_unknown",
      updatedAt: now,
    }), "leased");
    return Object.freeze({ status: "recorded" as const, outcome: "delivery_ambiguous" as const });
  }

  function markDeliveryRejected(
    owners: SessionIdAcpDeliveryResultOwnerCapabilities,
    context: DeliveryContext,
  ): SessionIdAcpEffectObservationResult {
    if (context.input.state === "failed"
      && context.turn.state === "failed"
      && context.inbox.state === "suppressed") {
      return Object.freeze({ status: "replayed" as const, outcome: "delivery_rejected" as const });
    }
    invariant(pendingTuple(context), "session_id_acp_delivery_rejected_or_state_conflict");
    const now = options.now();
    owners.orchestration.updateInputSubmission(Object.freeze({
      ...context.input,
      state: "failed",
      updatedAt: now,
    }), "pending");
    owners.orchestration.updateTurn(Object.freeze({
      ...context.turn,
      state: "failed",
      updatedAt: now,
      settledAt: now,
    }), "pending");
    owners.orchestration.updateInboxItem(Object.freeze({
      ...context.inbox,
      state: "suppressed",
      reason: "provider_effect_rejected",
      updatedAt: now,
    }), "leased");
    return Object.freeze({ status: "recorded" as const, outcome: "delivery_rejected" as const });
  }

  function markInterruptAccepted(
    owners: SessionIdAcpDeliveryResultOwnerCapabilities,
    control: SessionControlAuditRecord,
  ): SessionIdAcpEffectObservationResult {
    if (control.state === "accepted") {
      return Object.freeze({ status: "replayed" as const, outcome: "interrupt_accepted" as const });
    }
    invariant(control.state === "requested", "session_id_acp_interrupt_accept_state_conflict");
    owners.orchestration.updateControlAudit(Object.freeze({ ...control, state: "accepted" }), "requested");
    return Object.freeze({ status: "recorded" as const, outcome: "interrupt_accepted" as const });
  }

  function markInterruptConfirmed(
    owners: SessionIdAcpDeliveryResultOwnerCapabilities,
    context: DeliveryContext,
    control: SessionControlAuditRecord,
  ): SessionIdAcpEffectObservationResult {
    if (control.state === "confirmed") {
      invariant(context.turn.state === "interrupted", "session_id_acp_interrupt_confirmed_replay_conflict");
      return Object.freeze({ status: "replayed" as const, outcome: "interrupt_confirmed" as const });
    }
    invariant(control.state === "requested" || control.state === "accepted",
      "session_id_acp_interrupt_confirm_state_conflict");
    invariant(context.turn.state === "active" || context.turn.state === "ambiguous",
      "session_id_acp_interrupt_turn_state_conflict");
    const now = options.now();
    owners.orchestration.updateControlAudit(Object.freeze({
      ...control,
      state: "confirmed",
      settledAt: now,
    }), control.state);
    owners.orchestration.updateTurn(Object.freeze({
      ...context.turn,
      state: "interrupted",
      updatedAt: now,
      settledAt: now,
    }), context.turn.state);
    if (context.input.state === "accepted") {
      owners.orchestration.updateInputSubmission(Object.freeze({
        ...context.input,
        state: "cancelled",
        updatedAt: now,
      }), "accepted");
    }
    if (context.inbox.state === "handed") {
      owners.orchestration.updateInboxItem(Object.freeze({
        ...context.inbox,
        state: "handled",
        updatedAt: now,
      }), "handed");
    }
    const sourceIntervention = context.inbox.humanInterventionId
      ? owners.humanIntervention.get(context.inbox.humanInterventionId)
      : undefined;
    if (sourceIntervention
      && (sourceIntervention.state === "accepted" || sourceIntervention.state === "delivered")) {
      owners.humanIntervention.update(Object.freeze({
        ...sourceIntervention,
        state: "resolved",
        updatedAt: now,
      }));
    }
    return Object.freeze({ status: "recorded" as const, outcome: "interrupt_confirmed" as const });
  }

  function markInterruptUnknown(
    owners: SessionIdAcpDeliveryResultOwnerCapabilities,
    context: DeliveryContext,
    control: SessionControlAuditRecord,
  ): SessionIdAcpEffectObservationResult {
    if (control.state === "unknown") {
      invariant(context.turn.state === "ambiguous", "session_id_acp_interrupt_unknown_replay_conflict");
      return Object.freeze({ status: "replayed" as const, outcome: "interrupt_unknown" as const });
    }
    invariant(control.state === "requested" || control.state === "accepted",
      "session_id_acp_interrupt_unknown_state_conflict");
    invariant(context.turn.state === "active" || context.turn.state === "ambiguous",
      "session_id_acp_interrupt_turn_state_conflict");
    const now = options.now();
    owners.orchestration.updateControlAudit(Object.freeze({
      ...control,
      state: "unknown",
      settledAt: now,
      reason: "provider_outcome_unknown",
    }), control.state);
    if (context.turn.state === "active") {
      owners.orchestration.updateTurn(Object.freeze({
        ...context.turn,
        state: "ambiguous",
        updatedAt: now,
      }), "active");
    }
    return Object.freeze({ status: "recorded" as const, outcome: "interrupt_unknown" as const });
  }

  function markInterruptRejected(
    owners: SessionIdAcpDeliveryResultOwnerCapabilities,
    control: SessionControlAuditRecord,
  ): SessionIdAcpEffectObservationResult {
    if (control.state === "rejected") {
      return Object.freeze({ status: "replayed" as const, outcome: "interrupt_rejected" as const });
    }
    invariant(control.state === "requested", "session_id_acp_interrupt_rejected_state_conflict");
    owners.orchestration.updateControlAudit(Object.freeze({
      ...control,
      state: "rejected",
      settledAt: options.now(),
      reason: "provider_effect_rejected",
    }), "requested");
    return Object.freeze({ status: "recorded" as const, outcome: "interrupt_rejected" as const });
  }
}

function exactStageInput(value: unknown): string {
  invariant(Boolean(value) && typeof value === "object" && !Array.isArray(value),
    "session_id_acp_delivery_input_shape_invalid");
  const root = value as Record<string, unknown>;
  invariant(Object.keys(root).length === 1 && typeof root.logicalSessionId === "string"
    && /^logical_session_[A-Za-z0-9_-]+$/u.test(root.logicalSessionId),
  "session_id_acp_delivery_input_shape_invalid");
  return root.logicalSessionId;
}

function validateObservation(value: unknown): SessionIdAcpEffectObservation {
  assertSessionExecutionSafeValue(value, "ACP OR effect observation");
  invariant(Boolean(value) && typeof value === "object" && !Array.isArray(value),
    "session_id_acp_delivery_observation_shape_invalid");
  const root = value as Record<string, unknown>;
  const kind = root.kind;
  const deliveryReceiptKeys = [
    "kind", "providerEffectIntentId", "taskId", "runId", "logicalSessionId",
    "sessionExecutionRuntimeId", "sessionExecutionAttemptId", "bindingId", "bindingRevision",
    "executionProfileId", "profileRevisionId", "bindingHandle", "inputSubmissionId",
    "orchestrationSessionTurnId", "receiptDigest",
  ];
  const resultKeys = ["kind", "providerEffectIntentId", "sessionExecutionAttemptId"];
  if (kind === "delivery_receipt") {
    invariant(sameKeys(root, deliveryReceiptKeys), "session_id_acp_delivery_observation_shape_invalid");
  } else {
    invariant(new Set([
      "delivery_unknown", "delivery_rejected", "interrupt_accepted", "interrupt_confirmed",
      "interrupt_unknown", "interrupt_rejected",
    ]).has(kind as string) && sameKeys(root, resultKeys),
    "session_id_acp_delivery_observation_shape_invalid");
  }
  invariant(typeof root.providerEffectIntentId === "string"
    && /^provider_effect_[A-Za-z0-9_-]+$/u.test(root.providerEffectIntentId)
    && typeof root.sessionExecutionAttemptId === "string"
    && /^session_execution_attempt_[A-Za-z0-9_-]+$/u.test(root.sessionExecutionAttemptId),
  "session_id_acp_delivery_observation_identity_invalid");
  return Object.freeze({ ...root }) as unknown as SessionIdAcpEffectObservation;
}

function requireMessage(
  owners: SessionIdAcpDeliveryResultOwnerCapabilities,
  inbox: SessionLaneItemRecord,
): SessionIdSessionMessageRecord {
  const message = owners.message.getMessage(inbox.renderedMessageId);
  invariant(Boolean(message), "session_id_acp_delivery_message_missing");
  invariant(message!.messageId === inbox.renderedMessageId
    && message!.taskId === inbox.taskId
    && message!.runId === inbox.runId
    && Boolean(message!.content.trim())
    && message!.contentDigest === hashDefinition(message!.content),
  "session_id_acp_delivery_message_scope_mismatch");
  return message!;
}

function requireForward(
  owners: SessionIdAcpDeliveryResultOwnerCapabilities,
  inbox: SessionLaneItemRecord,
  message: SessionIdSessionMessageRecord,
): SessionIdMessageForwardRecord | undefined {
  if (!inbox.forwardId) return undefined;
  const forward = owners.message.getForward(inbox.forwardId);
  invariant(Boolean(forward)
    && forward!.taskId === inbox.taskId
    && forward!.runId === inbox.runId
    && forward!.targetSessionId === inbox.sessionId
    && forward!.renderedMessageId === message.messageId,
  "session_id_acp_delivery_forward_scope_mismatch");
  return forward!;
}

function requireIntervention(
  owners: SessionIdAcpDeliveryResultOwnerCapabilities,
  inbox: SessionLaneItemRecord,
  conductorSessionId: string,
): SessionIdHumanInterventionRecord | undefined {
  if (!inbox.humanInterventionId) return undefined;
  const intervention = owners.humanIntervention.get(inbox.humanInterventionId);
  const isTargetDelivery = intervention?.targetSessionId === inbox.sessionId
    && intervention.cardMessageId === inbox.renderedMessageId;
  const isConductorMirror = inbox.sessionId === conductorSessionId
    && intervention?.conductorMirrorMessageId === inbox.renderedMessageId;
  invariant(Boolean(intervention)
    && intervention!.taskId === inbox.taskId
    && intervention!.runId === inbox.runId
    && (isTargetDelivery || isConductorMirror)
    && (intervention!.state === "accepted" || intervention!.state === "delivered"),
  "session_id_acp_delivery_intervention_scope_mismatch");
  return intervention!;
}

function predecessorSettled(
  owners: SessionIdAcpDeliveryResultOwnerCapabilities,
  item: SessionLaneItemRecord,
): boolean {
  if (!item.causalPredecessorInboxItemId) return true;
  const predecessor = owners.orchestration.getInboxItem(item.causalPredecessorInboxItemId);
  invariant(Boolean(predecessor)
    && predecessor!.taskId === item.taskId
    && predecessor!.runId === item.runId
    && predecessor!.sessionId === item.sessionId,
  "session_id_acp_delivery_predecessor_scope_mismatch");
  return predecessor!.state === "handled" || predecessor!.state === "suppressed";
}

function compareInbox(
  owners: SessionIdAcpDeliveryResultOwnerCapabilities,
  left: SessionLaneItemRecord,
  right: SessionLaneItemRecord,
): number {
  const leftMessage = owners.message.getMessage(left.renderedMessageId);
  const rightMessage = owners.message.getMessage(right.renderedMessageId);
  if (leftMessage?.kind === "task_goal" && rightMessage?.kind !== "task_goal") return -1;
  if (rightMessage?.kind === "task_goal" && leftMessage?.kind !== "task_goal") return 1;
  const priority = { notice: 0, human: 1, ordinary: 2 } as const;
  return priority[left.priority] - priority[right.priority] || left.sequence - right.sequence;
}

function deliveryCommandId(
  inbox: SessionLaneItemRecord,
  forward?: SessionIdMessageForwardRecord,
  intervention?: SessionIdHumanInterventionRecord,
): string {
  if (forward) return forward.commandId;
  if (intervention) return `${intervention.commandId}:delivery:${inbox.inboxItemId}`;
  const digest = hashDefinition({ inboxItemId: inbox.inboxItemId }).replace(/[^A-Za-z0-9_-]/gu, "_");
  return `command_acp_delivery_${digest}`;
}

function deliveryTrigger(
  isConductor: boolean,
  message: SessionIdSessionMessageRecord,
  forward?: SessionIdMessageForwardRecord,
): SessionIdSessionTurnRecord["trigger"] {
  if (!isConductor) return forward ? "conductor_send" : "human";
  if (message.kind === "task_goal") return "task_goal";
  if (message.kind === "agent_final") return "session_return";
  if (message.kind === "runtime_notice") return "recovery";
  return "human";
}

function stageResult(
  staged: SessionIdAcpDrainableProviderEffect,
  inbox: SessionLaneItemRecord,
  input: SessionIdInputSubmissionRecord,
  turn: SessionIdSessionTurnRecord,
): SessionIdAcpDeliveryStageResult {
  return Object.freeze({
    disposition: staged.disposition,
    inboxItemId: inbox.inboxItemId,
    inputSubmissionId: input.inputSubmissionId,
    sessionTurnId: turn.sessionTurnId,
    providerEffectIntentId: staged.providerEffectIntentId,
    sessionExecutionRuntimeId: staged.sessionExecutionRuntimeId,
    sessionExecutionAttemptId: staged.sessionExecutionAttemptId,
  });
}

function assertDrainScope(
  staged: SessionIdAcpDrainableProviderEffect,
  input: SessionIdInputSubmissionRecord,
  turn: SessionIdSessionTurnRecord,
): void {
  invariant(staged.commandType === "session_runtime.submit_delivery"
    && /^provider_effect_[A-Za-z0-9_-]+$/u.test(staged.providerEffectIntentId)
    && /^session_execution_runtime_[A-Za-z0-9_-]+$/u.test(staged.sessionExecutionRuntimeId)
    && /^session_execution_attempt_[A-Za-z0-9_-]+$/u.test(staged.sessionExecutionAttemptId)
    && turn.inputSubmissionId === input.inputSubmissionId,
  "session_id_acp_delivery_drain_scope_invalid");
}

function assertDeliveryReceipt(
  receipt: SessionIdAcpDeliveryReceiptObservation,
  context: DeliveryContext,
): void {
  const { intent, binding } = context;
  invariant(receipt.providerEffectIntentId === intent.providerEffectIntentId
    && receipt.taskId === intent.taskId
    && receipt.runId === intent.runId
    && receipt.logicalSessionId === intent.logicalSessionId
    && receipt.sessionExecutionRuntimeId === intent.sessionExecutionRuntimeId
    && receipt.sessionExecutionAttemptId === intent.sessionExecutionAttemptId
    && receipt.bindingId === intent.bindingId
    && receipt.bindingRevision === intent.bindingRevision
    && receipt.executionProfileId === intent.executionProfileId
    && receipt.profileRevisionId === intent.profileRevisionId
    && receipt.bindingHandle === intent.effect.bindingHandle
    && receipt.bindingHandle === binding.bindingHandle
    && receipt.inputSubmissionId === intent.inputSubmissionId
    && receipt.orchestrationSessionTurnId === intent.orchestrationSessionTurnId,
  "session_id_acp_delivery_receipt_scope_mismatch");
}

function assertDeliveryIntent(context: DeliveryContext): void {
  invariant(context.intent.commandType === "session_runtime.submit_delivery"
    && context.intent.effect.kind === "submit_delivery",
  "session_id_acp_delivery_effect_kind_mismatch");
}

function assertInterruptIntent(context: DeliveryContext): void {
  invariant(context.intent.commandType === "session_runtime.request_interrupt"
    && context.intent.effect.kind === "request_interrupt"
    && Boolean(context.intent.sessionControlAuditId),
  "session_id_acp_interrupt_effect_kind_mismatch");
}

function requiredControl(
  owners: SessionIdAcpDeliveryResultOwnerCapabilities,
  intent: SessionRuntimeProviderEffectIntentRecord,
): SessionControlAuditRecord {
  const control = owners.orchestration.getControlAudit(intent.sessionControlAuditId!);
  invariant(Boolean(control)
    && control!.sessionControlAuditId === intent.sessionControlAuditId
    && control!.taskId === intent.taskId
    && control!.runId === intent.runId
    && control!.sessionId === intent.logicalSessionId
    && control!.kind !== "close",
  "session_id_acp_interrupt_control_scope_mismatch");
  return control!;
}

function assertRuntimeAttemptScope(
  runtime: SessionExecutionRuntimeRecord,
  attempt: SessionExecutionAttemptRecord,
): void {
  invariant(attempt.sessionExecutionRuntimeId === runtime.sessionExecutionRuntimeId
    && attempt.taskId === runtime.taskId
    && attempt.runId === runtime.runId
    && attempt.logicalSessionId === runtime.logicalSessionId
    && (Boolean(attempt.settlement) || runtime.activeAttemptId === attempt.sessionExecutionAttemptId),
  "session_id_acp_delivery_runtime_attempt_scope_mismatch");
}

function assertIntentAttemptScope(
  intent: SessionRuntimeProviderEffectIntentRecord,
  attempt: SessionExecutionAttemptRecord,
): void {
  invariant(intent.sessionExecutionRuntimeId === attempt.sessionExecutionRuntimeId
    && intent.sessionExecutionAttemptId === attempt.sessionExecutionAttemptId
    && intent.taskId === attempt.taskId
    && intent.runId === attempt.runId
    && intent.logicalSessionId === attempt.logicalSessionId
    && intent.bindingId === attempt.bindingId
    && intent.bindingRevision === attempt.bindingRevision
    && intent.executionProfileId === attempt.executionProfileId
    && intent.profileRevisionId === attempt.profileRevisionId
    && intent.inputSubmissionId === attempt.inputSubmissionId
    && intent.orchestrationSessionTurnId === attempt.orchestrationSessionTurnId,
  "session_id_acp_delivery_effect_attempt_scope_mismatch");
}

function assertSettlementAttemptScope(
  settlement: SessionExecutionSettlement,
  attempt: SessionExecutionAttemptRecord,
): void {
  invariant(settlement.sessionExecutionRuntimeId === attempt.sessionExecutionRuntimeId
    && settlement.sessionExecutionAttemptId === attempt.sessionExecutionAttemptId
    && settlement.taskId === attempt.taskId
    && settlement.runId === attempt.runId
    && settlement.logicalSessionId === attempt.logicalSessionId
    && settlement.bindingId === attempt.bindingId
    && settlement.bindingRevision === attempt.bindingRevision
    && settlement.executionProfileId === attempt.executionProfileId
    && settlement.profileRevisionId === attempt.profileRevisionId
    && settlement.inputSubmissionId === attempt.inputSubmissionId
    && settlement.orchestrationSessionTurnId === attempt.orchestrationSessionTurnId,
  "session_id_acp_delivery_settlement_attempt_scope_mismatch");
}

function assertOrCorrelation(
  input: SessionIdInputSubmissionRecord,
  turn: SessionIdSessionTurnRecord,
  inbox: SessionLaneItemRecord,
  attempt: SessionExecutionAttemptRecord,
): void {
  invariant(input.inputSubmissionId === attempt.inputSubmissionId
    && turn.sessionTurnId === attempt.orchestrationSessionTurnId
    && turn.inputSubmissionId === input.inputSubmissionId
    && input.taskId === attempt.taskId
    && input.runId === attempt.runId
    && input.sessionId === attempt.logicalSessionId
    && turn.taskId === input.taskId
    && turn.runId === input.runId
    && turn.sessionId === input.sessionId
    && inbox.inboxItemId === input.sourceInboxItemId
    && inbox.taskId === input.taskId
    && inbox.runId === input.runId
    && inbox.sessionId === input.sessionId
    && inbox.renderedMessageId === input.contentMessageId,
  "session_id_acp_delivery_or_correlation_mismatch");
}

function assertDeliveryTuple(
  input: SessionIdInputSubmissionRecord,
  turn: SessionIdSessionTurnRecord,
  inbox: SessionLaneItemRecord,
): void {
  const pending = input.state === "pending" && turn.state === "pending" && inbox.state === "leased";
  const accepted = input.state === "accepted" && turn.state === "active" && inbox.state === "handed";
  const ambiguous = input.state === "ambiguous" && turn.state === "ambiguous" && inbox.state === "ambiguous";
  invariant(pending || accepted || ambiguous, "session_id_acp_delivery_live_state_conflict");
}

function pendingTuple(context: DeliveryContext): boolean {
  return context.input.state === "pending" && context.turn.state === "pending" && context.inbox.state === "leased";
}

function acceptedTuple(context: DeliveryContext): boolean {
  return context.input.state === "accepted" && context.turn.state === "active" && context.inbox.state === "handed";
}

function ambiguousTuple(context: DeliveryContext): boolean {
  return context.input.state === "ambiguous"
    && context.turn.state === "ambiguous"
    && context.inbox.state === "ambiguous";
}

function sameSettlement(left: SessionExecutionSettlement, right: SessionExecutionSettlement): boolean {
  return left.sessionExecutionRuntimeId === right.sessionExecutionRuntimeId
    && left.sessionExecutionAttemptId === right.sessionExecutionAttemptId
    && left.taskId === right.taskId
    && left.runId === right.runId
    && left.logicalSessionId === right.logicalSessionId
    && left.bindingId === right.bindingId
    && left.bindingRevision === right.bindingRevision
    && left.executionProfileId === right.executionProfileId
    && left.profileRevisionId === right.profileRevisionId
    && left.inputSubmissionId === right.inputSubmissionId
    && left.orchestrationSessionTurnId === right.orchestrationSessionTurnId
    && left.outcome === right.outcome
    && left.receiptDigest === right.receiptDigest
    && left.finalContent === right.finalContent
    && left.finalContentDigest === right.finalContentDigest
    && left.settledAt === right.settledAt;
}

function requiredCreatedId(value: string, pattern: RegExp, code: string): string {
  invariant(typeof value === "string" && value.length <= 256 && pattern.test(value), code);
  return value;
}

function sameKeys(root: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(root).sort();
  const wanted = [...expected].sort();
  return keys.length === wanted.length && keys.every((key, index) => key === wanted[index]);
}

function validateOptions(options: SessionIdAcpDeliveryResultOwnerOptions): void {
  invariant(Boolean(options)
    && typeof options.now === "function"
    && typeof options.createId === "function"
    && typeof options.task?.taskId === "string"
    && typeof options.task?.runId === "string"
    && typeof options.task?.conductorSessionId === "string"
    && typeof options.task?.initialConductorSessionTurnId === "string"
    && typeof options.transaction?.run === "function"
    && typeof options.bridge?.stageDelivery === "function"
    && typeof options.bridge?.acceptSettlement === "function"
    && typeof options.terminalNoticeCoordinator?.acceptNotice === "function",
  "session_id_acp_delivery_owner_options_invalid");
}

import type {
  ExecutionProfileId,
  ExecutionProfileRevisionId,
  InputSubmissionId,
  LogicalSessionId,
  ProviderSessionBindingId,
  SessionTurnId,
  TaskId,
  TaskRunId,
} from "./ids";
import { assertJsonValue, cloneJson, hashDefinition, type JsonValue } from "./json";

export type SessionExecutionRuntimeId = string;
export type SessionExecutionAttemptId = string;
export type BindingHandle = string;
export type InteractionId = string;
export type InteractionChoiceId = string;

export type SessionExecutionRuntimeState = "idle" | "executing" | "reconciling" | "closed";
export type SessionExecutionAttemptState =
  | "awaiting_receipt"
  | "active"
  | "waiting_for_interaction"
  | "candidate_observed"
  | "reconciling"
  | "settled";

export interface SessionExecutionRuntimeRecord {
  readonly sessionExecutionRuntimeId: SessionExecutionRuntimeId;
  readonly taskId: TaskId;
  readonly runId: TaskRunId;
  readonly logicalSessionId: LogicalSessionId;
  readonly state: SessionExecutionRuntimeState;
  readonly activeAttemptId?: SessionExecutionAttemptId;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SessionExecutionInteractionChoice {
  readonly choiceId: InteractionChoiceId;
  readonly label: string;
}

export interface SessionExecutionInteraction {
  readonly interactionId: InteractionId;
  readonly promptDigest: string;
  readonly choices: readonly SessionExecutionInteractionChoice[];
  readonly status: "requested" | "responded";
  readonly selectedChoiceId?: InteractionChoiceId;
  readonly revision: number;
  readonly requestedAt: string;
  readonly respondedAt?: string;
}

export interface SessionExecutionFinalCandidate {
  readonly candidateObservationId: string;
  readonly content: string;
  readonly contentDigest: string;
  readonly observedAt: string;
}

export interface SessionExecutionTerminal {
  readonly terminalObservationId: string;
  readonly outcome: "completed" | "failed" | "cancelled" | "unknown";
  readonly receiptDigest?: string;
  readonly observedAt: string;
}

/** Safe, SR-authored fact which an OR owner may use to settle its own Turn. */
export interface SessionExecutionSettlement {
  readonly sessionExecutionRuntimeId: SessionExecutionRuntimeId;
  readonly sessionExecutionAttemptId: SessionExecutionAttemptId;
  readonly taskId: TaskId;
  readonly runId: TaskRunId;
  readonly logicalSessionId: LogicalSessionId;
  readonly bindingId: ProviderSessionBindingId;
  readonly bindingRevision: number;
  readonly executionProfileId: ExecutionProfileId;
  readonly profileRevisionId: ExecutionProfileRevisionId;
  readonly inputSubmissionId: InputSubmissionId;
  readonly orchestrationSessionTurnId: SessionTurnId;
  readonly outcome: "completed" | "failed" | "cancelled";
  readonly receiptDigest: string;
  readonly finalContent?: string;
  readonly finalContentDigest?: string;
  readonly settledAt: string;
}

/**
 * One ACP prompt execution. `orchestrationSessionTurnId` is correlation only:
 * SR never writes the OR-owned SessionTurn row.
 */
export interface SessionExecutionAttemptRecord {
  readonly sessionExecutionAttemptId: SessionExecutionAttemptId;
  readonly sessionExecutionRuntimeId: SessionExecutionRuntimeId;
  readonly taskId: TaskId;
  readonly runId: TaskRunId;
  readonly logicalSessionId: LogicalSessionId;
  readonly bindingId: ProviderSessionBindingId;
  readonly bindingRevision: number;
  readonly executionProfileId: ExecutionProfileId;
  readonly profileRevisionId: ExecutionProfileRevisionId;
  readonly inputSubmissionId: InputSubmissionId;
  readonly orchestrationSessionTurnId: SessionTurnId;
  readonly state: SessionExecutionAttemptState;
  readonly receiptDigest?: string;
  readonly receiptObservedAt?: string;
  readonly interactions: readonly SessionExecutionInteraction[];
  readonly finalCandidate?: SessionExecutionFinalCandidate;
  readonly terminal?: SessionExecutionTerminal;
  readonly settlement?: SessionExecutionSettlement;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Binding service consumes this event; raw ACP session identity stays private. */
export type SessionRuntimeBindingReadyEvent = Readonly<{
  type: "session_runtime.binding_ready";
  sessionExecutionRuntimeId: SessionExecutionRuntimeId;
  logicalSessionId: LogicalSessionId;
  bindingId: ProviderSessionBindingId;
  bindingRevision: number;
  executionProfileId: ExecutionProfileId;
  profileRevisionId: ExecutionProfileRevisionId;
  bindingHandle: BindingHandle;
  recoverable: boolean;
  observedAt: string;
}>;

export type SessionRuntimeAttemptEvent =
  | Readonly<{
      type: "session_runtime.delivery_receipt";
      sessionExecutionAttemptId: SessionExecutionAttemptId;
      receiptDigest: string;
      observedAt: string;
    }>
  | Readonly<{
      type: "session_runtime.interaction_requested";
      sessionExecutionAttemptId: SessionExecutionAttemptId;
      interactionId: InteractionId;
      promptDigest: string;
      choices: readonly SessionExecutionInteractionChoice[];
      observedAt: string;
    }>
  | Readonly<{
      type: "session_runtime.interaction_resolved";
      sessionExecutionAttemptId: SessionExecutionAttemptId;
      interactionId: InteractionId;
      choiceId: InteractionChoiceId;
      observedAt: string;
    }>
  | Readonly<{
      type: "session_runtime.final_candidate";
      sessionExecutionAttemptId: SessionExecutionAttemptId;
      candidateObservationId: string;
      content: string;
      contentDigest: string;
      observedAt: string;
    }>
  | Readonly<{
      type: "session_runtime.terminal";
      sessionExecutionAttemptId: SessionExecutionAttemptId;
      terminalObservationId: string;
      outcome: SessionExecutionTerminal["outcome"];
      receiptDigest?: string;
      observedAt: string;
    }>
  | Readonly<{
      type: "session_runtime.settled";
      settlement: SessionExecutionSettlement;
    }>;

export type SessionRuntimeEvent = SessionRuntimeBindingReadyEvent | SessionRuntimeAttemptEvent;

type SessionRuntimeCommandScope = Readonly<{
  commandId: string;
  idempotencyKey: string;
  taskId: TaskId;
  runId: TaskRunId;
  logicalSessionId: LogicalSessionId;
  sessionExecutionRuntimeId: SessionExecutionRuntimeId;
  expectedRuntimeRevision: number;
  bindingId: ProviderSessionBindingId;
  bindingRevision: number;
  executionProfileId: ExecutionProfileId;
  profileRevisionId: ExecutionProfileRevisionId;
  bindingHandle: BindingHandle;
}>;

type SessionRuntimeAttemptCommandScope = SessionRuntimeCommandScope & Readonly<{
  sessionExecutionAttemptId: SessionExecutionAttemptId;
  expectedAttemptRevision: number;
  inputSubmissionId: InputSubmissionId;
  orchestrationSessionTurnId: SessionTurnId;
}>;

export type SessionRuntimeSubmitDeliveryCommand = SessionRuntimeCommandScope & Readonly<{
  type: "session_runtime.submit_delivery";
  inputSubmissionId: InputSubmissionId;
  orchestrationSessionTurnId: SessionTurnId;
  content: string;
  contentDigest: string;
}>;

export type SessionRuntimeReconcileAttemptCommand = SessionRuntimeAttemptCommandScope & Readonly<{
  type: "session_runtime.reconcile_attempt";
}>;

export type SessionRuntimeRequestInterruptCommand = SessionRuntimeAttemptCommandScope & Readonly<{
  type: "session_runtime.request_interrupt";
  sessionControlAuditId: string;
}>;

export type SessionRuntimeRespondInteractionCommand = SessionRuntimeAttemptCommandScope & Readonly<{
  type: "session_runtime.respond_interaction";
  interactionId: InteractionId;
  expectedInteractionRevision: number;
  choiceId: InteractionChoiceId;
}>;

/** Closed application command surface for one stable Session Runtime owner. */
export type SessionRuntimeCommand =
  | SessionRuntimeSubmitDeliveryCommand
  | SessionRuntimeReconcileAttemptCommand
  | SessionRuntimeRequestInterruptCommand
  | SessionRuntimeRespondInteractionCommand;

export type SessionRuntimeExternalEffect =
  | Readonly<{
      kind: "submit_delivery";
      bindingHandle: BindingHandle;
      sessionExecutionAttemptId: SessionExecutionAttemptId;
      content: string;
    }>
  | Readonly<{
      kind: "reconcile_attempt";
      bindingHandle: BindingHandle;
      sessionExecutionAttemptId: SessionExecutionAttemptId;
    }>
  | Readonly<{
      kind: "request_interrupt";
      bindingHandle: BindingHandle;
      sessionExecutionAttemptId: SessionExecutionAttemptId;
      sessionControlAuditId: string;
    }>
  | Readonly<{
      kind: "respond_interaction";
      bindingHandle: BindingHandle;
      sessionExecutionAttemptId: SessionExecutionAttemptId;
      interactionId: InteractionId;
      choiceId: InteractionChoiceId;
    }>;

/** Reliability-owner record staged before its typed external effect is returned. */
export interface SessionRuntimeProviderEffectIntentRecord {
  readonly providerEffectIntentId: string;
  readonly commandId: string;
  readonly idempotencyKey: string;
  readonly commandType: SessionRuntimeCommand["type"];
  readonly commandFingerprint: string;
  readonly taskId: TaskId;
  readonly runId: TaskRunId;
  readonly logicalSessionId: LogicalSessionId;
  readonly sessionExecutionRuntimeId: SessionExecutionRuntimeId;
  readonly sessionExecutionAttemptId: SessionExecutionAttemptId;
  readonly inputSubmissionId: InputSubmissionId;
  readonly orchestrationSessionTurnId: SessionTurnId;
  readonly bindingId: ProviderSessionBindingId;
  readonly bindingRevision: number;
  readonly executionProfileId: ExecutionProfileId;
  readonly profileRevisionId: ExecutionProfileRevisionId;
  readonly sessionControlAuditId?: string;
  readonly interactionId?: InteractionId;
  readonly effect: SessionRuntimeExternalEffect;
  readonly state: "pending" | "suppressed";
  readonly suppressionReason?: "task_stopped";
  readonly suppressedAt?: string;
  readonly createdAt: string;
}

export function validateSessionRuntimeCommand(value: unknown): SessionRuntimeCommand {
  assertSessionExecutionSafeValue(value, "session runtime command");
  const root = commandRecord(value);
  const type = root.type;
  if (type === "session_runtime.submit_delivery") {
    assertCommandKeys(root, [...COMMAND_SCOPE_KEYS, "type", "inputSubmissionId", "orchestrationSessionTurnId", "content", "contentDigest"]);
    validateCommandScope(root);
    assertPrefixedId(root.inputSubmissionId, "input", "inputSubmissionId");
    assertPrefixedId(root.orchestrationSessionTurnId, "session_turn", "orchestrationSessionTurnId");
    const content = commandText(root.content, "session_runtime_command_content_required");
    if (root.contentDigest !== hashDefinition(content)) throw new Error("session_runtime_command_content_digest_mismatch");
  } else if (type === "session_runtime.reconcile_attempt") {
    assertCommandKeys(root, [...ATTEMPT_COMMAND_SCOPE_KEYS, "type"]);
    validateAttemptCommandScope(root);
  } else if (type === "session_runtime.request_interrupt") {
    assertCommandKeys(root, [...ATTEMPT_COMMAND_SCOPE_KEYS, "type", "sessionControlAuditId"]);
    validateAttemptCommandScope(root);
    assertPrefixedId(root.sessionControlAuditId, "session_control", "sessionControlAuditId");
  } else if (type === "session_runtime.respond_interaction") {
    assertCommandKeys(root, [...ATTEMPT_COMMAND_SCOPE_KEYS, "type", "interactionId", "expectedInteractionRevision", "choiceId"]);
    validateAttemptCommandScope(root);
    assertInteractionId(root.interactionId);
    assertInteractionChoiceId(root.choiceId);
    assertPositiveRevision(root.expectedInteractionRevision as number, "expectedInteractionRevision");
  } else {
    throw new Error("session_runtime_command_type_invalid");
  }
  assertJsonValue(root as unknown as JsonValue);
  return cloneJson(root as unknown as JsonValue) as unknown as SessionRuntimeCommand;
}

export function cloneSessionRuntimeProviderEffectIntent(
  value: SessionRuntimeProviderEffectIntentRecord,
): SessionRuntimeProviderEffectIntentRecord {
  assertSessionExecutionSafeValue(value, "session runtime provider effect intent");
  const root = exactRecord(
    value,
    [
      "providerEffectIntentId", "commandId", "idempotencyKey", "commandType", "commandFingerprint",
      "taskId", "runId", "logicalSessionId", "sessionExecutionRuntimeId", "sessionExecutionAttemptId",
      "inputSubmissionId", "orchestrationSessionTurnId", "bindingId", "bindingRevision",
      "executionProfileId", "profileRevisionId", "effect", "state", "createdAt",
    ],
    ["sessionControlAuditId", "interactionId", "suppressionReason", "suppressedAt"],
    "session_runtime_provider_effect_shape_invalid",
  ) as unknown as SessionRuntimeProviderEffectIntentRecord;
  assertPrefixedId(root.providerEffectIntentId, "provider_effect", "providerEffectIntentId");
  assertPrefixedId(root.commandId, "command", "commandId");
  commandText(root.idempotencyKey, "session_runtime_effect_idempotency_key_invalid");
  assertEnum(root.commandType, [
    "session_runtime.submit_delivery",
    "session_runtime.reconcile_attempt",
    "session_runtime.request_interrupt",
    "session_runtime.respond_interaction",
  ], "session_runtime_effect_command_type_invalid");
  safeDigest(root.commandFingerprint, "session_runtime_effect_command_fingerprint_invalid");
  assertPrefixedId(root.taskId, "task", "taskId");
  assertPrefixedId(root.runId, "run", "runId");
  assertPrefixedId(root.logicalSessionId, "logical_session", "logicalSessionId");
  assertPrefixedId(root.sessionExecutionRuntimeId, "session_execution_runtime", "sessionExecutionRuntimeId");
  assertPrefixedId(root.sessionExecutionAttemptId, "session_execution_attempt", "sessionExecutionAttemptId");
  assertPrefixedId(root.inputSubmissionId, "input", "inputSubmissionId");
  assertPrefixedId(root.orchestrationSessionTurnId, "session_turn", "orchestrationSessionTurnId");
  assertPrefixedId(root.bindingId, "binding", "bindingId");
  assertPositiveRevision(root.bindingRevision, "bindingRevision");
  assertPrefixedId(root.executionProfileId, "profile", "executionProfileId");
  assertPrefixedId(root.profileRevisionId, "profile_revision", "profileRevisionId");
  assertEnum(root.state, ["pending", "suppressed"], "session_runtime_effect_state_invalid");
  if (root.state === "suppressed") {
    assertEnum(root.suppressionReason, ["task_stopped"], "session_runtime_effect_suppression_reason_invalid");
    assertIsoTimestamp(root.suppressedAt, "providerEffect.suppressedAt");
  } else if (root.suppressionReason !== undefined || root.suppressedAt !== undefined) {
    throw new Error("session_runtime_effect_suppression_forbidden");
  }
  assertIsoTimestamp(root.createdAt, "providerEffect.createdAt");
  const effect = exactEffectRecord(root.effect);
  assertBindingHandle(effect.bindingHandle);
  assertPrefixedId(effect.sessionExecutionAttemptId, "session_execution_attempt", "effect.sessionExecutionAttemptId");
  if (effect.sessionExecutionAttemptId !== root.sessionExecutionAttemptId) {
    throw new Error("session_runtime_effect_attempt_mismatch");
  }
  if (effect.kind === "submit_delivery") {
    safeContent(effect.content, "session_runtime_effect_content_invalid");
  }
  if (effect.kind === "request_interrupt") {
    assertPrefixedId(effect.sessionControlAuditId, "session_control", "sessionControlAuditId");
    if (root.sessionControlAuditId !== effect.sessionControlAuditId) {
      throw new Error("session_runtime_effect_control_mismatch");
    }
  } else if (root.sessionControlAuditId !== undefined) {
    throw new Error("session_runtime_effect_control_forbidden");
  }
  if (effect.kind === "respond_interaction") {
    assertInteractionId(effect.interactionId);
    assertInteractionChoiceId(effect.choiceId);
    if (root.interactionId !== effect.interactionId) {
      throw new Error("session_runtime_effect_interaction_mismatch");
    }
  } else if (root.interactionId !== undefined) {
    throw new Error("session_runtime_effect_interaction_forbidden");
  }
  if (effect.kind !== root.commandType.slice("session_runtime.".length)) {
    throw new Error("session_runtime_effect_command_type_mismatch");
  }
  assertJsonValue(root as unknown as JsonValue);
  return cloneJson(root as unknown as JsonValue) as unknown as SessionRuntimeProviderEffectIntentRecord;
}

export function assertBindingHandle(value: unknown, field = "bindingHandle"): asserts value is BindingHandle {
  assertOpaqueId(value, "binding_handle", field);
}

export function assertInteractionId(value: unknown, field = "interactionId"): asserts value is InteractionId {
  assertOpaqueId(value, "interaction", field);
}

export function assertInteractionChoiceId(value: unknown, field = "choiceId"): asserts value is InteractionChoiceId {
  assertOpaqueId(value, "choice", field);
}

/** Reject raw ACP/private identity keys at every public SR boundary. */
export function assertSessionExecutionSafeValue(value: unknown, path = "session execution value"): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertSessionExecutionSafeValue(entry, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const normalized = key.toLowerCase().replace(/[_-]/g, "");
    if (PRIVATE_SESSION_EXECUTION_FIELDS.has(normalized)) {
      throw new Error(`session_execution_private_field_forbidden:${path}.${key}`);
    }
    assertSessionExecutionSafeValue(entry, `${path}.${key}`);
  }
}

export function cloneSessionExecutionRuntimeRecord(
  value: SessionExecutionRuntimeRecord,
): SessionExecutionRuntimeRecord {
  assertSessionExecutionSafeValue(value);
  const root = exactRecord(
    value,
    ["sessionExecutionRuntimeId", "taskId", "runId", "logicalSessionId", "state", "revision", "createdAt", "updatedAt"],
    ["activeAttemptId"],
    "session_execution_runtime_shape_invalid",
  );
  assertPrefixedId(root.sessionExecutionRuntimeId, "session_execution_runtime", "sessionExecutionRuntimeId");
  assertPrefixedId(root.taskId, "task", "taskId");
  assertPrefixedId(root.runId, "run", "runId");
  assertPrefixedId(root.logicalSessionId, "logical_session", "logicalSessionId");
  assertEnum(root.state, ["idle", "executing", "reconciling", "closed"], "session_execution_runtime_state_invalid");
  assertPositiveRevision(root.revision as number, "sessionExecutionRuntime.revision");
  const createdAt = assertIsoTimestamp(root.createdAt, "sessionExecutionRuntime.createdAt");
  const updatedAt = assertIsoTimestamp(root.updatedAt, "sessionExecutionRuntime.updatedAt");
  if (updatedAt < createdAt) throw new Error("session_execution_runtime_time_order_invalid");
  if (root.state === "executing" || root.state === "reconciling") {
    assertPrefixedId(root.activeAttemptId, "session_execution_attempt", "activeAttemptId");
  } else if (root.activeAttemptId !== undefined) {
    throw new Error("session_execution_runtime_active_attempt_forbidden");
  }
  assertJsonValue(root as unknown as JsonValue);
  return cloneJson(root as unknown as JsonValue) as unknown as SessionExecutionRuntimeRecord;
}

export function cloneSessionExecutionAttemptRecord(
  value: SessionExecutionAttemptRecord,
): SessionExecutionAttemptRecord {
  assertSessionExecutionSafeValue(value);
  const root = exactRecord(
    value,
    [
      "sessionExecutionAttemptId", "sessionExecutionRuntimeId", "taskId", "runId", "logicalSessionId",
      "bindingId", "bindingRevision", "executionProfileId", "profileRevisionId", "inputSubmissionId",
      "orchestrationSessionTurnId", "state", "interactions", "revision", "createdAt", "updatedAt",
    ],
    ["receiptDigest", "receiptObservedAt", "finalCandidate", "terminal", "settlement"],
    "session_execution_attempt_shape_invalid",
  );
  assertPrefixedId(root.sessionExecutionAttemptId, "session_execution_attempt", "sessionExecutionAttemptId");
  assertPrefixedId(root.sessionExecutionRuntimeId, "session_execution_runtime", "sessionExecutionRuntimeId");
  assertPrefixedId(root.taskId, "task", "taskId");
  assertPrefixedId(root.runId, "run", "runId");
  assertPrefixedId(root.logicalSessionId, "logical_session", "logicalSessionId");
  assertPrefixedId(root.bindingId, "binding", "bindingId");
  assertPositiveRevision(root.bindingRevision as number, "sessionExecutionAttempt.bindingRevision");
  assertPrefixedId(root.executionProfileId, "profile", "executionProfileId");
  assertPrefixedId(root.profileRevisionId, "profile_revision", "profileRevisionId");
  assertPrefixedId(root.inputSubmissionId, "input", "inputSubmissionId");
  assertPrefixedId(root.orchestrationSessionTurnId, "session_turn", "orchestrationSessionTurnId");
  assertEnum(root.state, ["awaiting_receipt", "active", "waiting_for_interaction", "candidate_observed", "reconciling", "settled"], "session_execution_attempt_state_invalid");
  assertPositiveRevision(root.revision as number, "sessionExecutionAttempt.revision");
  const createdAt = assertIsoTimestamp(root.createdAt, "sessionExecutionAttempt.createdAt");
  const updatedAt = assertIsoTimestamp(root.updatedAt, "sessionExecutionAttempt.updatedAt");
  if (updatedAt < createdAt) throw new Error("session_execution_attempt_time_order_invalid");
  if ((root.receiptDigest === undefined) !== (root.receiptObservedAt === undefined)) {
    throw new Error("session_execution_receipt_observation_mismatch");
  }
  if (root.receiptDigest !== undefined) safeDigest(root.receiptDigest, "session_execution_receipt_digest_invalid");
  if (root.receiptObservedAt !== undefined) assertIsoTimestamp(root.receiptObservedAt, "receiptObservedAt");
  if (!Array.isArray(root.interactions)) throw new Error("session_execution_interactions_shape_invalid");
  const interactionIds = new Set<string>();
  let requestedInteractions = 0;
  root.interactions.forEach((candidate, index) => {
    const interaction = exactRecord(
      candidate,
      ["interactionId", "promptDigest", "choices", "status", "revision", "requestedAt"],
      ["selectedChoiceId", "respondedAt"],
      "session_execution_interaction_shape_invalid",
    ) as unknown as SessionExecutionInteraction;
    assertInteractionId(interaction.interactionId);
    if (interactionIds.has(interaction.interactionId)) throw new Error("session_execution_interaction_duplicate");
    interactionIds.add(interaction.interactionId);
    safeDigest(interaction.promptDigest, "session_execution_interaction_prompt_digest_invalid");
    if (!Array.isArray(interaction.choices) || interaction.choices.length < 1 || interaction.choices.length > 64) {
      throw new Error("session_execution_interaction_choices_invalid");
    }
    const choiceIds = new Set<string>();
    interaction.choices.forEach((candidateChoice) => {
      const choice = exactRecord(
        candidateChoice,
        ["choiceId", "label"],
        [],
        "session_execution_interaction_choice_shape_invalid",
      ) as unknown as SessionExecutionInteractionChoice;
      assertInteractionChoiceId(choice.choiceId);
      if (choiceIds.has(choice.choiceId)) throw new Error("session_execution_interaction_choice_duplicate");
      choiceIds.add(choice.choiceId);
      safeSingleLineText(choice.label, 160, "session_execution_interaction_choice_label_invalid");
    });
    assertEnum(interaction.status, ["requested", "responded"], "session_execution_interaction_status_invalid");
    assertPositiveRevision(interaction.revision, `interaction[${index}].revision`);
    const requestedAt = assertIsoTimestamp(interaction.requestedAt, `interaction[${index}].requestedAt`);
    if (interaction.status === "requested") {
      requestedInteractions += 1;
      if (interaction.selectedChoiceId !== undefined || interaction.respondedAt !== undefined) {
        throw new Error("session_execution_interaction_requested_response_forbidden");
      }
    } else {
      assertInteractionChoiceId(interaction.selectedChoiceId, "selectedChoiceId");
      if (!choiceIds.has(interaction.selectedChoiceId!)) throw new Error("session_execution_interaction_selected_choice_invalid");
      const respondedAt = assertIsoTimestamp(interaction.respondedAt, `interaction[${index}].respondedAt`);
      if (respondedAt < requestedAt) throw new Error("session_execution_interaction_time_order_invalid");
    }
  });
  if (requestedInteractions > 1) throw new Error("session_execution_interaction_requested_ambiguous");
  if (root.finalCandidate !== undefined) {
    const finalCandidate = exactRecord(
      root.finalCandidate,
      ["candidateObservationId", "content", "contentDigest", "observedAt"],
      [],
      "session_execution_final_candidate_shape_invalid",
    );
    assertPrefixedId(finalCandidate.candidateObservationId, "provider_fact", "candidateObservationId");
    const content = safeContent(finalCandidate.content, "session_execution_final_content_invalid");
    if (finalCandidate.contentDigest !== hashDefinition(content)) {
      throw new Error("session_execution_final_digest_mismatch");
    }
    assertIsoTimestamp(finalCandidate.observedAt, "finalCandidate.observedAt");
  }
  if (root.terminal !== undefined) {
    const terminal = exactRecord(
      root.terminal,
      ["terminalObservationId", "outcome", "observedAt"],
      ["receiptDigest"],
      "session_execution_terminal_shape_invalid",
    );
    assertPrefixedId(terminal.terminalObservationId, "provider_fact", "terminalObservationId");
    assertEnum(terminal.outcome, ["completed", "failed", "cancelled", "unknown"], "session_execution_terminal_outcome_invalid");
    if (terminal.receiptDigest !== undefined) safeDigest(terminal.receiptDigest, "session_execution_terminal_receipt_invalid");
    assertIsoTimestamp(terminal.observedAt, "terminal.observedAt");
  }
  if ((root.state === "settled") !== (root.settlement !== undefined)) {
    throw new Error("session_execution_settled_state_mismatch");
  }
  const attempt = root as unknown as SessionExecutionAttemptRecord;
  if (attempt.receiptDigest && attempt.terminal?.receiptDigest
    && attempt.receiptDigest !== attempt.terminal.receiptDigest) {
    throw new Error("session_execution_receipt_mismatch");
  }
  if (attempt.settlement) {
    const settlement = cloneSessionExecutionSettlement(attempt.settlement);
    if (settlement.sessionExecutionRuntimeId !== attempt.sessionExecutionRuntimeId
      || settlement.sessionExecutionAttemptId !== attempt.sessionExecutionAttemptId
      || settlement.taskId !== attempt.taskId
      || settlement.runId !== attempt.runId
      || settlement.logicalSessionId !== attempt.logicalSessionId
      || settlement.bindingId !== attempt.bindingId
      || settlement.bindingRevision !== attempt.bindingRevision
      || settlement.executionProfileId !== attempt.executionProfileId
      || settlement.profileRevisionId !== attempt.profileRevisionId
      || settlement.inputSubmissionId !== attempt.inputSubmissionId
      || settlement.orchestrationSessionTurnId !== attempt.orchestrationSessionTurnId) {
      throw new Error("session_execution_settlement_attempt_correlation_mismatch");
    }
    if (!attempt.receiptDigest || settlement.receiptDigest !== attempt.receiptDigest
      || attempt.terminal?.receiptDigest !== settlement.receiptDigest) {
      throw new Error("session_execution_settlement_receipt_mismatch");
    }
    if (!attempt.terminal || attempt.terminal.outcome === "unknown"
      || settlement.outcome !== attempt.terminal.outcome) {
      throw new Error("session_execution_settlement_outcome_mismatch");
    }
    if (settlement.outcome === "completed") {
      if (!attempt.finalCandidate
        || settlement.finalContent !== attempt.finalCandidate.content
        || settlement.finalContentDigest !== attempt.finalCandidate.contentDigest) {
        throw new Error("session_execution_settlement_final_candidate_mismatch");
      }
    }
  }
  assertJsonValue(root as unknown as JsonValue);
  return cloneJson(root as unknown as JsonValue) as unknown as SessionExecutionAttemptRecord;
}

export function cloneSessionExecutionSettlement(value: SessionExecutionSettlement): SessionExecutionSettlement {
  assertSessionExecutionSafeValue(value, "session execution settlement");
  const required = [
    "sessionExecutionRuntimeId",
    "sessionExecutionAttemptId",
    "taskId",
    "runId",
    "logicalSessionId",
    "bindingId",
    "bindingRevision",
    "executionProfileId",
    "profileRevisionId",
    "inputSubmissionId",
    "orchestrationSessionTurnId",
    "outcome",
    "receiptDigest",
    "settledAt",
  ];
  const optional = ["finalContent", "finalContentDigest"];
  const root = exactRecord(value, required, optional, "session_execution_settlement_shape_invalid");
  assertPrefixedId(root.sessionExecutionRuntimeId, "session_execution_runtime", "sessionExecutionRuntimeId");
  assertPrefixedId(root.sessionExecutionAttemptId, "session_execution_attempt", "sessionExecutionAttemptId");
  assertPrefixedId(root.taskId, "task", "taskId");
  assertPrefixedId(root.runId, "run", "runId");
  assertPrefixedId(root.logicalSessionId, "logical_session", "logicalSessionId");
  assertPrefixedId(root.bindingId, "binding", "bindingId");
  assertPositiveRevision(root.bindingRevision as number, "bindingRevision");
  assertPrefixedId(root.executionProfileId, "profile", "executionProfileId");
  assertPrefixedId(root.profileRevisionId, "profile_revision", "profileRevisionId");
  assertPrefixedId(root.inputSubmissionId, "input", "inputSubmissionId");
  assertPrefixedId(root.orchestrationSessionTurnId, "session_turn", "orchestrationSessionTurnId");
  if (!new Set(["completed", "failed", "cancelled"]).has(root.outcome as string)) {
    throw new Error("session_execution_settlement_outcome_invalid");
  }
  safeDigest(root.receiptDigest, "session_execution_settlement_receipt_required");
  assertIsoTimestamp(root.settledAt, "settledAt");
  if (root.outcome === "completed") {
    const finalContent = safeContent(root.finalContent, "session_execution_settlement_final_required");
    const finalContentDigest = safeDigest(root.finalContentDigest, "session_execution_settlement_final_digest_required");
    if (finalContentDigest !== hashDefinition(finalContent)) {
      throw new Error("session_execution_settlement_final_digest_mismatch");
    }
  } else if (Object.prototype.hasOwnProperty.call(root, "finalContent")
    || Object.prototype.hasOwnProperty.call(root, "finalContentDigest")) {
    throw new Error("session_execution_settlement_failed_final_forbidden");
  }
  assertJsonValue(root as unknown as JsonValue);
  return cloneJson(root as unknown as JsonValue) as unknown as SessionExecutionSettlement;
}

const PRIVATE_SESSION_EXECUTION_FIELDS = new Set([
  "acpsessionid",
  "acprequestid",
  "acpoptionid",
  "acptoolcallid",
  "jsonrpcid",
  "nativesessionid",
  "providersessionid",
  "sessionid",
  "nativebindingref",
  "nativerequestid",
  "nativeoptionid",
  "rawsessionid",
  "rawid",
  "rawmessageid",
  "requestid",
  "optionid",
  "toolcallid",
  "cwd",
  "absolutecwd",
  "workspacepath",
  "workspacedirectory",
  "absolutepath",
  "canonicaldirectory",
  "providerpath",
  "credential",
  "credentials",
  "accesstoken",
  "token",
  "secret",
]);

function assertOpaqueId(value: unknown, prefix: string, field: string): asserts value is string {
  if (typeof value !== "string" || value.length > 256 || !new RegExp(`^${prefix}_[A-Za-z0-9_-]+$`, "u").test(value)) {
    throw new Error(`session_execution_opaque_id_invalid:${field}`);
  }
}

function assertPositiveRevision(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`session_execution_revision_invalid:${field}`);
}

const COMMAND_SCOPE_KEYS = [
  "commandId",
  "idempotencyKey",
  "taskId",
  "runId",
  "logicalSessionId",
  "sessionExecutionRuntimeId",
  "expectedRuntimeRevision",
  "bindingId",
  "bindingRevision",
  "executionProfileId",
  "profileRevisionId",
  "bindingHandle",
] as const;

const ATTEMPT_COMMAND_SCOPE_KEYS = [
  ...COMMAND_SCOPE_KEYS,
  "sessionExecutionAttemptId",
  "expectedAttemptRevision",
  "inputSubmissionId",
  "orchestrationSessionTurnId",
] as const;

function validateCommandScope(root: Record<string, unknown>): void {
  assertPrefixedId(root.commandId, "command", "commandId");
  commandText(root.idempotencyKey, "session_runtime_command_idempotency_key_required");
  assertPrefixedId(root.taskId, "task", "taskId");
  assertPrefixedId(root.runId, "run", "runId");
  assertPrefixedId(root.logicalSessionId, "logical_session", "logicalSessionId");
  assertPrefixedId(root.sessionExecutionRuntimeId, "session_execution_runtime", "sessionExecutionRuntimeId");
  assertPositiveRevision(root.expectedRuntimeRevision as number, "expectedRuntimeRevision");
  assertPrefixedId(root.bindingId, "binding", "bindingId");
  assertPositiveRevision(root.bindingRevision as number, "bindingRevision");
  assertPrefixedId(root.executionProfileId, "profile", "executionProfileId");
  assertPrefixedId(root.profileRevisionId, "profile_revision", "profileRevisionId");
  assertBindingHandle(root.bindingHandle);
}

function validateAttemptCommandScope(root: Record<string, unknown>): void {
  validateCommandScope(root);
  assertPrefixedId(root.sessionExecutionAttemptId, "session_execution_attempt", "sessionExecutionAttemptId");
  assertPositiveRevision(root.expectedAttemptRevision as number, "expectedAttemptRevision");
  assertPrefixedId(root.inputSubmissionId, "input", "inputSubmissionId");
  assertPrefixedId(root.orchestrationSessionTurnId, "session_turn", "orchestrationSessionTurnId");
}

function commandRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("session_runtime_command_shape_invalid");
  }
  return value as Record<string, unknown>;
}

function assertCommandKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(value);
  if (actual.length !== expected.length || actual.some((key) => !expected.includes(key))) {
    throw new Error("session_runtime_command_shape_invalid");
  }
}

function assertPrefixedId(value: unknown, prefix: string, field: string): asserts value is string {
  assertOpaqueId(value, prefix, field);
}

function commandText(value: unknown, code: string): string {
  if (typeof value !== "string" || value.length > 50_000 || !value.trim() || hasForbiddenControl(value)) throw new Error(code);
  return value;
}

function exactRecord(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
  code: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(code);
  const root = value as Record<string, unknown>;
  const actual = Object.keys(root);
  if (required.some((key) => !Object.prototype.hasOwnProperty.call(root, key))
    || actual.some((key) => !required.includes(key) && !optional.includes(key))) {
    throw new Error(code);
  }
  return root;
}

function exactEffectRecord(value: unknown): SessionRuntimeExternalEffect {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("session_runtime_external_effect_shape_invalid");
  }
  const kind = (value as Record<string, unknown>).kind;
  if (kind === "submit_delivery") {
    return exactRecord(value, ["kind", "bindingHandle", "sessionExecutionAttemptId", "content"], [],
      "session_runtime_external_effect_shape_invalid") as unknown as SessionRuntimeExternalEffect;
  }
  if (kind === "reconcile_attempt") {
    return exactRecord(value, ["kind", "bindingHandle", "sessionExecutionAttemptId"], [],
      "session_runtime_external_effect_shape_invalid") as unknown as SessionRuntimeExternalEffect;
  }
  if (kind === "request_interrupt") {
    return exactRecord(value, ["kind", "bindingHandle", "sessionExecutionAttemptId", "sessionControlAuditId"], [],
      "session_runtime_external_effect_shape_invalid") as unknown as SessionRuntimeExternalEffect;
  }
  if (kind === "respond_interaction") {
    return exactRecord(value, ["kind", "bindingHandle", "sessionExecutionAttemptId", "interactionId", "choiceId"], [],
      "session_runtime_external_effect_shape_invalid") as unknown as SessionRuntimeExternalEffect;
  }
  throw new Error("session_runtime_external_effect_kind_invalid");
}

function assertEnum(value: unknown, allowed: readonly string[], code: string): asserts value is string {
  if (typeof value !== "string" || !allowed.includes(value)) throw new Error(code);
}

function assertIsoTimestamp(value: unknown, field: string): string {
  if (typeof value !== "string") throw new Error(`session_execution_time_invalid:${field}`);
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) {
    throw new Error(`session_execution_time_invalid:${field}`);
  }
  return value;
}

function safeContent(value: unknown, code: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 50_000 || hasForbiddenControl(value)) throw new Error(code);
  return value;
}

function safeSingleLineText(value: unknown, maxLength: number, code: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength
    || value.includes("\n") || value.includes("\r") || hasForbiddenControl(value)) throw new Error(code);
  return value;
}

function safeDigest(value: unknown, code: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 256 || hasForbiddenControl(value)) throw new Error(code);
  return value;
}

function hasForbiddenControl(value: string): boolean {
  return /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(value);
}

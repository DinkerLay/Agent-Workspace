import type {
  AcpSafeSessionBindingRecordV3,
  CardSessionGenerationRecord,
  CardSessionSlotRecord,
  ProviderFamily,
  SessionControlAuditRecord,
  SessionExecutionAttemptRecord,
  SessionExecutionRuntimeRecord,
  SessionExecutionSettlement,
  SessionRuntimeCommand,
  SessionRuntimeProviderEffectIntentRecord,
} from "@agent-workspace/runtime-contracts";
import {
  cloneSessionRuntimeProviderEffectIntent,
  hashDefinition,
} from "@agent-workspace/runtime-contracts";
import { invariant } from "@agent-workspace/runtime-domain";
import type {
  SessionIdInputSubmissionRecord,
  SessionIdSessionMessageRecord,
  SessionIdSessionTurnRecord,
} from "@agent-workspace/runtime-store";
import type {
  SessionExecutionRuntimeOwner,
} from "./session-execution-runtime-owner.js";
import type {
  SessionExecutionSettlementResult,
} from "./session-execution-settlement-coordinator.js";

export type SessionIdAcpFrozenProfileTuple = Readonly<{
  schemaVersion: 3;
  executionProfileId: string;
  profileRevisionId: string;
  providerFamily: ProviderFamily;
}>;

export interface SessionIdAcpOrchestrationReadCapability {
  getInputSubmission(inputSubmissionId: string): SessionIdInputSubmissionRecord | undefined;
  findTurnByInputSubmission(inputSubmissionId: string): SessionIdSessionTurnRecord | undefined;
  getControlAudit(sessionControlAuditId: string): SessionControlAuditRecord | undefined;
}

export interface SessionIdAcpMessageReadCapability {
  getMessage(messageId: string): SessionIdSessionMessageRecord | undefined;
}

export interface SessionIdAcpTaskRunReadCapability {
  getGeneration(logicalSessionId: string): CardSessionGenerationRecord | undefined;
  getSlot(cardSessionSlotId: string): CardSessionSlotRecord | undefined;
  getConductorSessionId(taskId: string, runId: string): string;
  readTaskRunState(taskId: string, runId: string): Readonly<{
    taskId: string;
    runId: string;
    runStatus: string;
  }>;
}

export interface SessionIdAcpCurrentBindingReadCapability {
  getCurrentBinding(logicalSessionId: string): AcpSafeSessionBindingRecordV3 | undefined;
}

export interface SessionIdAcpProviderEffectReadCapability {
  findByIdempotencyKey(scope: Readonly<{
    taskId: string;
    runId: string;
    commandType: SessionRuntimeCommand["type"];
    idempotencyKey: string;
  }>): SessionRuntimeProviderEffectIntentRecord | undefined;
}

export type SessionIdAcpOrchestrationBridgeOptions = Readonly<{
  orchestrationRead: SessionIdAcpOrchestrationReadCapability;
  messageRead: SessionIdAcpMessageReadCapability;
  taskRunRead: SessionIdAcpTaskRunReadCapability;
  currentBindingRead: SessionIdAcpCurrentBindingReadCapability;
  resolveFrozenProfileTuple(scope: Readonly<{
    taskId: string;
    runId: string;
    logicalSessionId: string;
    executionProfileId: string;
  }>): SessionIdAcpFrozenProfileTuple | undefined;
  providerEffectRead: SessionIdAcpProviderEffectReadCapability;
  sessionRuntimeOwner: SessionExecutionRuntimeOwner;
  settlementCoordinator: Readonly<{
    acceptSettlement(settlement: SessionExecutionSettlement): SessionExecutionSettlementResult;
  }>;
}>;

export type SessionIdAcpDrainableProviderEffect = Readonly<{
  disposition: "staged" | "replay";
  commandType: SessionRuntimeCommand["type"];
  providerEffectIntentId: string;
  sessionExecutionRuntimeId: string;
  sessionExecutionAttemptId: string;
}>;

type CurrentExecutionFence = Readonly<{
  binding: AcpSafeSessionBindingRecordV3;
  profile: SessionIdAcpFrozenProfileTuple;
}>;

type DurableDelivery = Readonly<{
  input: SessionIdInputSubmissionRecord;
  turn: SessionIdSessionTurnRecord;
  message: SessionIdSessionMessageRecord;
}>;

/**
 * Provider-neutral ACP v3 seam from already-durable OR records to one stable SR.
 *
 * It never accepts caller content or Provider wire identity. The returned opaque
 * intent ID is the only value a Host needs to pass to its ACP Task provider.
 */
export function createSessionIdAcpOrchestrationBridge(
  options: SessionIdAcpOrchestrationBridgeOptions,
) {
  validateOptions(options);
  return Object.freeze({
    stageDelivery,
    stageInterrupt,
    stageReconciliation,
    stageInteractionResponse,
    acceptSettlement: (settlement: SessionExecutionSettlement) =>
      options.settlementCoordinator.acceptSettlement(settlement),
  });

  function stageDelivery(value: Readonly<{ inputSubmissionId: string }>): SessionIdAcpDrainableProviderEffect {
    const inputSubmissionId = exactOpaqueInput(value, "inputSubmissionId", "input");
    const delivery = requireDurableDelivery(inputSubmissionId);
    const fence = requireCurrentExecutionFence(delivery.input.sessionId);
    assertDeliveryFence(delivery, fence);
    assertRunStatus(delivery.input.taskId, delivery.input.runId, ["running", "starting"]);
    const idempotencyKey = internalIdempotencyKey("submit_delivery", inputSubmissionId);
    const commandId = internalCommandId("submit_delivery", inputSubmissionId);
    const replay = findExistingIntent(
      "session_runtime.submit_delivery",
      commandId,
      idempotencyKey,
      fence,
      delivery.input,
      delivery.turn,
    );
    if (replay) {
      invariant(replay.effect.kind === "submit_delivery", "session_id_acp_delivery_effect_kind_mismatch");
      invariant(replay.effect.content === delivery.message.content,
        "session_id_acp_delivery_content_mismatch");
      return drainable("replay", replay);
    }
    invariant(delivery.input.state === "pending", "session_id_acp_delivery_input_not_pending");
    invariant(delivery.turn.state === "pending", "session_id_acp_delivery_turn_not_pending");

    const runtime = options.sessionRuntimeOwner.ensureRuntime({
      taskId: delivery.input.taskId,
      runId: delivery.input.runId,
      logicalSessionId: delivery.input.sessionId,
    });
    const execution = options.sessionRuntimeOwner.executeCommand({
      type: "session_runtime.submit_delivery",
      commandId,
      idempotencyKey,
      taskId: delivery.input.taskId,
      runId: delivery.input.runId,
      logicalSessionId: delivery.input.sessionId,
      sessionExecutionRuntimeId: runtime.sessionExecutionRuntimeId,
      expectedRuntimeRevision: runtime.revision,
      bindingId: fence.binding.bindingId,
      bindingRevision: fence.binding.revision,
      executionProfileId: fence.binding.executionProfileId,
      profileRevisionId: fence.binding.profileRevisionId,
      bindingHandle: fence.binding.bindingHandle,
      inputSubmissionId: delivery.input.inputSubmissionId,
      orchestrationSessionTurnId: delivery.turn.sessionTurnId,
      content: delivery.message.content,
      contentDigest: delivery.message.contentDigest,
    });
    return drainable(execution.disposition, execution.intent);
  }

  function stageInterrupt(value: Readonly<{
    sessionControlAuditId: string;
  }>): SessionIdAcpDrainableProviderEffect {
    const sessionControlAuditId = exactOpaqueInput(value, "sessionControlAuditId", "session_control");
    const control = options.orchestrationRead.getControlAudit(sessionControlAuditId);
    invariant(Boolean(control), "session_id_acp_control_not_found");
    invariant(control!.state === "requested" || control!.state === "accepted",
      "session_id_acp_control_not_pending");
    assertRunStatus(
      control!.taskId,
      control!.runId,
      control!.kind === "task_stop" ? ["stopping"] : ["running"],
    );
    const execution = requireActiveExecution(control!.sessionId);
    assertControlExecutionFence(control!, execution.attempt, execution.delivery, execution.fence);
    const idempotencyKey = internalIdempotencyKey("request_interrupt", sessionControlAuditId);
    const commandId = internalCommandId("request_interrupt", sessionControlAuditId);
    const replay = findExistingIntent(
      "session_runtime.request_interrupt",
      commandId,
      idempotencyKey,
      execution.fence,
      execution.delivery.input,
      execution.delivery.turn,
      sessionControlAuditId,
    );
    if (replay) return drainable("replay", replay);

    const result = options.sessionRuntimeOwner.executeCommand({
      type: "session_runtime.request_interrupt",
      commandId,
      idempotencyKey,
      taskId: execution.attempt.taskId,
      runId: execution.attempt.runId,
      logicalSessionId: execution.attempt.logicalSessionId,
      sessionExecutionRuntimeId: execution.runtime.sessionExecutionRuntimeId,
      expectedRuntimeRevision: execution.runtime.revision,
      sessionExecutionAttemptId: execution.attempt.sessionExecutionAttemptId,
      expectedAttemptRevision: execution.attempt.revision,
      bindingId: execution.attempt.bindingId,
      bindingRevision: execution.attempt.bindingRevision,
      executionProfileId: execution.attempt.executionProfileId,
      profileRevisionId: execution.attempt.profileRevisionId,
      bindingHandle: execution.fence.binding.bindingHandle,
      inputSubmissionId: execution.attempt.inputSubmissionId,
      orchestrationSessionTurnId: execution.attempt.orchestrationSessionTurnId,
      sessionControlAuditId,
    });
    return drainable(result.disposition, result.intent);
  }

  function stageReconciliation(value: Readonly<{
    sessionExecutionAttemptId: string;
  }>): SessionIdAcpDrainableProviderEffect {
    const sessionExecutionAttemptId = exactOpaqueInput(
      value,
      "sessionExecutionAttemptId",
      "session_execution_attempt",
    );
    const attempt = options.sessionRuntimeOwner.getAttempt(sessionExecutionAttemptId);
    invariant(Boolean(attempt), "session_id_acp_attempt_not_found");
    const runtime = options.sessionRuntimeOwner.getRuntime(attempt!.sessionExecutionRuntimeId);
    invariant(Boolean(runtime), "session_id_acp_runtime_not_found");
    const delivery = requireDurableDelivery(attempt!.inputSubmissionId);
    const fence = requireCurrentExecutionFence(attempt!.logicalSessionId);
    assertAttemptExecutionFence(runtime!, attempt!, delivery, fence, false);
    const idempotencyKey = internalIdempotencyKey("reconcile_attempt", sessionExecutionAttemptId);
    const commandId = internalCommandId("reconcile_attempt", sessionExecutionAttemptId);
    const replay = findExistingIntent(
      "session_runtime.reconcile_attempt",
      commandId,
      idempotencyKey,
      fence,
      delivery.input,
      delivery.turn,
    );
    if (replay) return drainable("replay", replay);
    invariant(!attempt!.settlement, "session_id_acp_attempt_already_settled");
    invariant(runtime!.activeAttemptId === attempt!.sessionExecutionAttemptId,
      "session_id_acp_attempt_not_current");

    const result = options.sessionRuntimeOwner.executeCommand({
      type: "session_runtime.reconcile_attempt",
      commandId,
      idempotencyKey,
      taskId: attempt!.taskId,
      runId: attempt!.runId,
      logicalSessionId: attempt!.logicalSessionId,
      sessionExecutionRuntimeId: runtime!.sessionExecutionRuntimeId,
      expectedRuntimeRevision: runtime!.revision,
      sessionExecutionAttemptId: attempt!.sessionExecutionAttemptId,
      expectedAttemptRevision: attempt!.revision,
      bindingId: attempt!.bindingId,
      bindingRevision: attempt!.bindingRevision,
      executionProfileId: attempt!.executionProfileId,
      profileRevisionId: attempt!.profileRevisionId,
      bindingHandle: fence.binding.bindingHandle,
      inputSubmissionId: attempt!.inputSubmissionId,
      orchestrationSessionTurnId: attempt!.orchestrationSessionTurnId,
    });
    return drainable(result.disposition, result.intent);
  }

  function stageInteractionResponse(value: Readonly<{
    sessionExecutionAttemptId: string;
    interactionId: string;
    expectedInteractionRevision: number;
    choiceId: string;
  }>): SessionIdAcpDrainableProviderEffect {
    const input = exactInteractionInput(value);
    const attempt = options.sessionRuntimeOwner.getAttempt(input.sessionExecutionAttemptId);
    invariant(Boolean(attempt), "session_id_acp_attempt_not_found");
    const runtime = options.sessionRuntimeOwner.getRuntime(attempt!.sessionExecutionRuntimeId);
    invariant(Boolean(runtime), "session_id_acp_runtime_not_found");
    const delivery = requireDurableDelivery(attempt!.inputSubmissionId);
    const fence = requireCurrentExecutionFence(attempt!.logicalSessionId);
    assertAttemptExecutionFence(runtime!, attempt!, delivery, fence);
    assertRunStatus(attempt!.taskId, attempt!.runId, ["running"]);
    invariant(delivery.turn.state === "active", "session_id_acp_interaction_turn_not_active");
    invariant(attempt!.state === "waiting_for_interaction" && !attempt!.settlement,
      "session_id_acp_interaction_attempt_not_waiting");
    const interactions = attempt!.interactions.filter((interaction) => interaction.interactionId === input.interactionId);
    invariant(interactions.length === 1, "session_id_acp_interaction_not_found");
    const interaction = interactions[0]!;
    invariant(interaction.status === "requested"
      && interaction.revision === input.expectedInteractionRevision,
    "session_id_acp_interaction_revision_stale");
    invariant(interaction.choices.some((choice) => choice.choiceId === input.choiceId),
      "session_id_acp_interaction_choice_invalid");
    const sourceIdentity = `${attempt!.sessionExecutionAttemptId}:${interaction.interactionId}`;
    const idempotencyKey = internalIdempotencyKey("respond_interaction", sourceIdentity);
    const commandId = internalCommandId("respond_interaction", sourceIdentity);
    const replay = findExistingIntent(
      "session_runtime.respond_interaction",
      commandId,
      idempotencyKey,
      fence,
      delivery.input,
      delivery.turn,
      undefined,
      Object.freeze({ interactionId: interaction.interactionId, choiceId: input.choiceId }),
    );
    if (replay) return drainable("replay", replay);
    const result = options.sessionRuntimeOwner.executeCommand({
      type: "session_runtime.respond_interaction",
      commandId,
      idempotencyKey,
      taskId: attempt!.taskId,
      runId: attempt!.runId,
      logicalSessionId: attempt!.logicalSessionId,
      sessionExecutionRuntimeId: runtime!.sessionExecutionRuntimeId,
      expectedRuntimeRevision: runtime!.revision,
      sessionExecutionAttemptId: attempt!.sessionExecutionAttemptId,
      expectedAttemptRevision: attempt!.revision,
      bindingId: attempt!.bindingId,
      bindingRevision: attempt!.bindingRevision,
      executionProfileId: attempt!.executionProfileId,
      profileRevisionId: attempt!.profileRevisionId,
      bindingHandle: fence.binding.bindingHandle,
      inputSubmissionId: attempt!.inputSubmissionId,
      orchestrationSessionTurnId: attempt!.orchestrationSessionTurnId,
      interactionId: interaction.interactionId,
      expectedInteractionRevision: interaction.revision,
      choiceId: input.choiceId,
    });
    return drainable(result.disposition, result.intent);
  }

  function requireActiveExecution(logicalSessionId: string): Readonly<{
    runtime: SessionExecutionRuntimeRecord;
    attempt: SessionExecutionAttemptRecord;
    delivery: DurableDelivery;
    fence: CurrentExecutionFence;
  }> {
    const resolvedRuntime = options.sessionRuntimeOwner.getRuntimeForLogicalSession(logicalSessionId);
    invariant(Boolean(resolvedRuntime), "session_id_acp_runtime_for_session_unavailable");
    invariant(Boolean(resolvedRuntime!.activeAttemptId), "session_id_acp_active_attempt_missing");
    const attempt = options.sessionRuntimeOwner.getAttempt(resolvedRuntime!.activeAttemptId!);
    invariant(Boolean(attempt), "session_id_acp_attempt_not_found");
    const delivery = requireDurableDelivery(attempt!.inputSubmissionId);
    const fence = requireCurrentExecutionFence(logicalSessionId);
    assertAttemptExecutionFence(resolvedRuntime!, attempt!, delivery, fence);
    return Object.freeze({ runtime: resolvedRuntime!, attempt: attempt!, delivery, fence });
  }

  function requireDurableDelivery(inputSubmissionId: string): DurableDelivery {
    const input = options.orchestrationRead.getInputSubmission(inputSubmissionId);
    invariant(Boolean(input), "session_id_acp_input_not_found");
    const turn = options.orchestrationRead.findTurnByInputSubmission(inputSubmissionId);
    invariant(Boolean(turn), "session_id_acp_turn_not_found");
    invariant(turn!.inputSubmissionId === input!.inputSubmissionId
      && turn!.taskId === input!.taskId
      && turn!.runId === input!.runId
      && turn!.sessionId === input!.sessionId,
    "session_id_acp_input_turn_scope_mismatch");
    const message = options.messageRead.getMessage(input!.contentMessageId);
    invariant(Boolean(message), "session_id_acp_message_not_found");
    invariant(message!.taskId === input!.taskId && message!.runId === input!.runId,
      "session_id_acp_message_scope_mismatch");
    invariant(Boolean(message!.content.trim()) && message!.contentDigest === hashDefinition(message!.content),
      "session_id_acp_message_digest_mismatch");
    return Object.freeze({ input: input!, turn: turn!, message: message! });
  }

  function requireCurrentExecutionFence(logicalSessionId: string): CurrentExecutionFence {
    const binding = options.currentBindingRead.getCurrentBinding(logicalSessionId);
    invariant(Boolean(binding), "session_id_acp_binding_not_current");
    invariant(binding!.status === "active" || binding!.status === "recovering",
      "session_id_acp_binding_not_usable");
    invariant(binding!.logicalSessionId === logicalSessionId, "session_id_acp_binding_scope_mismatch");
    const generation = options.taskRunRead.getGeneration(logicalSessionId);
    if (generation) {
      const slot = options.taskRunRead.getSlot(generation.cardSessionSlotId);
      invariant(generation.sessionId === logicalSessionId
        && generation.lifecycle === "current"
        && generation.closedAt === undefined
        && slot?.currentSessionId === logicalSessionId
        && slot.latestGeneration === generation.generation
        && slot.taskId === generation.taskId
        && slot.runId === generation.runId
        && slot.agentCardId === generation.agentCardId,
      "session_id_acp_generation_not_current");
      invariant(binding!.taskId === generation.taskId
        && binding!.runId === generation.runId
        && binding!.agentCardId === generation.agentCardId
        && binding!.executionProfileId === generation.executionProfileId,
      "session_id_acp_binding_scope_mismatch");
    } else {
      invariant(options.taskRunRead.getConductorSessionId(binding!.taskId, binding!.runId) === logicalSessionId,
        "session_id_acp_conductor_session_not_current");
    }
    const profile = options.resolveFrozenProfileTuple({
      taskId: binding!.taskId,
      runId: binding!.runId,
      logicalSessionId,
      executionProfileId: binding!.executionProfileId,
    });
    invariant(Boolean(profile), "session_id_acp_frozen_profile_missing");
    invariant(profile!.schemaVersion === 3
      && profile!.executionProfileId === binding!.executionProfileId
      && profile!.profileRevisionId === binding!.profileRevisionId
      && profile!.providerFamily === binding!.providerFamily,
    "session_id_acp_frozen_profile_mismatch");
    return Object.freeze({ binding: binding!, profile: profile! });
  }

  function assertDeliveryFence(delivery: DurableDelivery, fence: CurrentExecutionFence): void {
    invariant(delivery.input.taskId === fence.binding.taskId
      && delivery.input.runId === fence.binding.runId
      && delivery.input.sessionId === fence.binding.logicalSessionId,
    "session_id_acp_delivery_scope_mismatch");
  }

  function assertRunStatus(taskId: string, runId: string, allowed: readonly string[]): void {
    const state = options.taskRunRead.readTaskRunState(taskId, runId);
    invariant(state.taskId === taskId && state.runId === runId,
      "session_id_acp_task_run_scope_mismatch");
    invariant(allowed.includes(state.runStatus), "session_id_acp_task_run_not_accepting_effect");
  }

  function assertAttemptExecutionFence(
    runtime: SessionExecutionRuntimeRecord,
    attempt: SessionExecutionAttemptRecord,
    delivery: DurableDelivery,
    fence: CurrentExecutionFence,
    requireCurrent = true,
  ): void {
    assertDeliveryFence(delivery, fence);
    invariant(runtime.taskId === attempt.taskId
      && runtime.runId === attempt.runId
      && runtime.logicalSessionId === attempt.logicalSessionId,
    "session_id_acp_runtime_attempt_scope_mismatch");
    if (requireCurrent) {
      invariant(runtime.activeAttemptId === attempt.sessionExecutionAttemptId,
        "session_id_acp_runtime_attempt_scope_mismatch");
    }
    invariant(attempt.taskId === delivery.input.taskId
      && attempt.runId === delivery.input.runId
      && attempt.logicalSessionId === delivery.input.sessionId
      && attempt.inputSubmissionId === delivery.input.inputSubmissionId
      && attempt.orchestrationSessionTurnId === delivery.turn.sessionTurnId
      && attempt.bindingId === fence.binding.bindingId
      && attempt.bindingRevision === fence.binding.revision
      && attempt.executionProfileId === fence.binding.executionProfileId
      && attempt.profileRevisionId === fence.binding.profileRevisionId,
    "session_id_acp_attempt_scope_mismatch");
  }

  function assertControlExecutionFence(
    control: SessionControlAuditRecord,
    attempt: SessionExecutionAttemptRecord,
    delivery: DurableDelivery,
    fence: CurrentExecutionFence,
  ): void {
    invariant(control.taskId === attempt.taskId
      && control.runId === attempt.runId
      && control.sessionId === attempt.logicalSessionId,
    "session_id_acp_control_scope_mismatch");
    invariant(delivery.turn.sessionTurnId === attempt.orchestrationSessionTurnId
      && (delivery.turn.state === "active" || delivery.turn.state === "ambiguous"),
    "session_id_acp_control_turn_mismatch");
    invariant(fence.binding.logicalSessionId === control.sessionId,
      "session_id_acp_control_binding_mismatch");
  }

  function findExistingIntent(
    commandType: SessionRuntimeCommand["type"],
    commandId: string,
    idempotencyKey: string,
    fence: CurrentExecutionFence,
    input: SessionIdInputSubmissionRecord,
    turn: SessionIdSessionTurnRecord,
    sessionControlAuditId?: string,
    interaction?: Readonly<{ interactionId: string; choiceId: string }>,
  ): SessionRuntimeProviderEffectIntentRecord | undefined {
    const existing = options.providerEffectRead.findByIdempotencyKey({
      taskId: input.taskId,
      runId: input.runId,
      commandType,
      idempotencyKey,
    });
    if (!existing) return undefined;
    const intent = cloneSessionRuntimeProviderEffectIntent(existing);
    invariant(intent.commandType === commandType
      && intent.commandId === commandId
      && intent.idempotencyKey === idempotencyKey
      && intent.taskId === input.taskId
      && intent.runId === input.runId
      && intent.logicalSessionId === input.sessionId
      && intent.inputSubmissionId === input.inputSubmissionId
      && intent.orchestrationSessionTurnId === turn.sessionTurnId
      && intent.bindingId === fence.binding.bindingId
      && intent.bindingRevision === fence.binding.revision
      && intent.executionProfileId === fence.binding.executionProfileId
      && intent.profileRevisionId === fence.binding.profileRevisionId
      && intent.effect.bindingHandle === fence.binding.bindingHandle,
    "session_id_acp_provider_effect_replay_scope_mismatch");
    invariant(intent.sessionControlAuditId === sessionControlAuditId,
      "session_id_acp_provider_effect_replay_control_mismatch");
    invariant(intent.interactionId === interaction?.interactionId,
      "session_id_acp_provider_effect_replay_interaction_mismatch");
    if (interaction) {
      invariant(intent.effect.kind === "respond_interaction"
        && intent.effect.interactionId === interaction.interactionId
        && intent.effect.choiceId === interaction.choiceId,
      "session_id_acp_provider_effect_replay_interaction_choice_mismatch");
    }
    const attempt = options.sessionRuntimeOwner.getAttempt(intent.sessionExecutionAttemptId);
    const runtime = options.sessionRuntimeOwner.getRuntime(intent.sessionExecutionRuntimeId);
    invariant(Boolean(attempt) && Boolean(runtime), "session_id_acp_provider_effect_replay_execution_missing");
    invariant(attempt!.sessionExecutionRuntimeId === runtime!.sessionExecutionRuntimeId
      && attempt!.inputSubmissionId === input.inputSubmissionId
      && attempt!.orchestrationSessionTurnId === turn.sessionTurnId,
    "session_id_acp_provider_effect_replay_execution_mismatch");
    return intent;
  }
}

function drainable(
  disposition: "staged" | "replay",
  intent: SessionRuntimeProviderEffectIntentRecord,
): SessionIdAcpDrainableProviderEffect {
  return Object.freeze({
    disposition,
    commandType: intent.commandType,
    providerEffectIntentId: intent.providerEffectIntentId,
    sessionExecutionRuntimeId: intent.sessionExecutionRuntimeId,
    sessionExecutionAttemptId: intent.sessionExecutionAttemptId,
  });
}

function exactOpaqueInput(
  value: unknown,
  field: string,
  prefix: string,
): string {
  invariant(Boolean(value) && typeof value === "object" && !Array.isArray(value),
    "session_id_acp_bridge_input_shape_invalid");
  const root = value as Record<string, unknown>;
  invariant(Object.keys(root).length === 1 && Object.prototype.hasOwnProperty.call(root, field),
    "session_id_acp_bridge_input_shape_invalid");
  const identity = root[field];
  invariant(typeof identity === "string"
    && identity.length <= 256
    && new RegExp(`^${prefix}_[A-Za-z0-9_-]+$`, "u").test(identity),
  "session_id_acp_bridge_input_identity_invalid");
  return identity;
}

function exactInteractionInput(value: unknown): Readonly<{
  sessionExecutionAttemptId: string;
  interactionId: string;
  expectedInteractionRevision: number;
  choiceId: string;
}> {
  invariant(Boolean(value) && typeof value === "object" && !Array.isArray(value),
    "session_id_acp_bridge_interaction_input_shape_invalid");
  const root = value as Record<string, unknown>;
  invariant(Object.keys(root).sort().join("|")
    === ["choiceId", "expectedInteractionRevision", "interactionId", "sessionExecutionAttemptId"].join("|"),
  "session_id_acp_bridge_interaction_input_shape_invalid");
  invariant(typeof root.sessionExecutionAttemptId === "string"
    && /^session_execution_attempt_[A-Za-z0-9_-]+$/u.test(root.sessionExecutionAttemptId)
    && typeof root.interactionId === "string" && /^interaction_[A-Za-z0-9_-]+$/u.test(root.interactionId)
    && typeof root.choiceId === "string" && /^choice_[A-Za-z0-9_-]+$/u.test(root.choiceId)
    && Number.isInteger(root.expectedInteractionRevision) && Number(root.expectedInteractionRevision) > 0,
  "session_id_acp_bridge_interaction_input_invalid");
  return Object.freeze({
    sessionExecutionAttemptId: root.sessionExecutionAttemptId,
    interactionId: root.interactionId,
    expectedInteractionRevision: Number(root.expectedInteractionRevision),
    choiceId: root.choiceId,
  });
}

function internalCommandId(
  kind: "submit_delivery" | "request_interrupt" | "reconcile_attempt" | "respond_interaction",
  sourceIdentity: string,
): string {
  const digest = hashDefinition({ kind, sourceIdentity }).replace(/[^A-Za-z0-9_-]/gu, "_");
  return `command_acp_${kind}_${digest}`;
}

function internalIdempotencyKey(
  kind: "submit_delivery" | "request_interrupt" | "reconcile_attempt" | "respond_interaction",
  sourceIdentity: string,
): string {
  return `acp-session-runtime:${kind}:${sourceIdentity}`;
}

function validateOptions(options: SessionIdAcpOrchestrationBridgeOptions): void {
  invariant(Boolean(options)
    && typeof options.orchestrationRead?.getInputSubmission === "function"
    && typeof options.orchestrationRead?.findTurnByInputSubmission === "function"
    && typeof options.orchestrationRead?.getControlAudit === "function"
    && typeof options.messageRead?.getMessage === "function"
    && typeof options.taskRunRead?.getGeneration === "function"
    && typeof options.taskRunRead?.getSlot === "function"
    && typeof options.taskRunRead?.getConductorSessionId === "function"
    && typeof options.taskRunRead?.readTaskRunState === "function"
    && typeof options.currentBindingRead?.getCurrentBinding === "function"
    && typeof options.resolveFrozenProfileTuple === "function"
    && typeof options.providerEffectRead?.findByIdempotencyKey === "function"
    && typeof options.sessionRuntimeOwner?.ensureRuntime === "function"
    && typeof options.sessionRuntimeOwner?.getRuntimeForLogicalSession === "function"
    && typeof options.sessionRuntimeOwner?.executeCommand === "function"
    && typeof options.settlementCoordinator?.acceptSettlement === "function",
  "session_id_acp_bridge_options_invalid");
}

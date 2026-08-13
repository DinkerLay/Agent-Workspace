import {
  cloneAcpSafeSessionBindingRecordV3,
  cloneSessionExecutionAttemptRecord,
  cloneSessionExecutionRuntimeRecord,
  cloneSessionRuntimeProviderEffectIntent,
  hashDefinition,
  type AcpSafeSessionBindingRecordV3,
  type CardSessionGenerationRecord,
  type CardSessionSlotRecord,
  type JsonValue,
  type SessionExecutionAttemptRecord,
  type SessionExecutionRuntimeRecord,
  type SessionLaneItemRecord,
  type SessionRuntimeProviderEffectIntentRecord,
} from "@agent-workspace/runtime-contracts";
import { invariant } from "@agent-workspace/runtime-domain";
import type {
  SessionIdHumanInterventionRecord,
  SessionIdInputSubmissionRecord,
  SessionIdSessionMessageRecord,
  SessionIdSessionTurnRecord,
  SessionIdUiCommandReceiptRecord,
} from "@agent-workspace/runtime-store";
import type { SessionIdAcpDrainableProviderEffect } from "./session-id-acp-orchestration-bridge.js";

export type SessionIdAcpInteractionResponseCommand = Readonly<{
  commandId: string;
  taskId: string;
  runId: string;
  expectedRevision: number;
  targetLogicalSessionId: string;
  interactionId: string;
  expectedInteractionRevision: number;
  choiceId: string;
}>;

export type SessionIdAcpInteractionResponseResult = Readonly<{
  interactionResponse: Readonly<{
    humanInterventionId: string;
    state: "accepted";
    targetLogicalSessionId: string;
    interactionId: string;
    choiceId: string;
    label: string;
  }>;
}>;

export type SessionIdAcpInteractionResponseCommit = Readonly<{
  result: SessionIdAcpInteractionResponseResult;
  providerEffectIntentIds: readonly string[];
}>;

export type SessionIdAcpPendingInteractionReadModel = Readonly<{
  targetLogicalSessionId: string;
  interactionId: string;
  interactionRevision: number;
  choices: readonly Readonly<{ choiceId: string; label: string }>[];
}>;

export interface SessionIdAcpInteractionTaskRunCapability {
  getGeneration(logicalSessionId: string): CardSessionGenerationRecord | undefined;
  getSlot(cardSessionSlotId: string): CardSessionSlotRecord | undefined;
  getConductorSessionId(taskId: string, runId: string): string;
  readTaskRunState(taskId: string, runId: string): Readonly<{
    taskId: string;
    runId: string;
    taskRevision: number;
    runStatus: string;
  }>;
}

export interface SessionIdAcpInteractionMessageCapability {
  createMessage(message: SessionIdSessionMessageRecord): void;
  getMessage(messageId: string): SessionIdSessionMessageRecord | undefined;
}

export interface SessionIdAcpInteractionOrchestrationCapability {
  getInputSubmission(inputSubmissionId: string): SessionIdInputSubmissionRecord | undefined;
  getTurn(sessionTurnId: string): SessionIdSessionTurnRecord | undefined;
  getInboxItem(inboxItemId: string): SessionLaneItemRecord | undefined;
  listInboxItems(logicalSessionId: string): readonly SessionLaneItemRecord[];
  createInboxItem(item: SessionLaneItemRecord): void;
}

export interface SessionIdAcpInteractionHumanCapability {
  create(intervention: SessionIdHumanInterventionRecord): void;
  findByIdempotencyKey(
    taskId: string,
    runId: string,
    idempotencyKey: string,
  ): SessionIdHumanInterventionRecord | undefined;
}

export interface SessionIdAcpInteractionReceiptCapability {
  createUiCommandReceipt(receipt: SessionIdUiCommandReceiptRecord): void;
  getUiCommandReceipt(taskId: string, commandId: string): SessionIdUiCommandReceiptRecord | undefined;
}

export interface SessionIdAcpInteractionBindingReadCapability {
  getCurrentBinding(logicalSessionId: string): AcpSafeSessionBindingRecordV3 | undefined;
}

export interface SessionIdAcpInteractionExecutionReadCapability {
  getRuntimeForSession(logicalSessionId: string): SessionExecutionRuntimeRecord | undefined;
  getAttempt(sessionExecutionAttemptId: string): SessionExecutionAttemptRecord | undefined;
}

export interface SessionIdAcpInteractionProviderEffectReadCapability {
  getProviderEffectIntent(providerEffectIntentId: string): SessionRuntimeProviderEffectIntentRecord | undefined;
}

export type SessionIdAcpInteractionResponseCapabilities = Readonly<{
  taskRun: SessionIdAcpInteractionTaskRunCapability;
  message: SessionIdAcpInteractionMessageCapability;
  orchestration: SessionIdAcpInteractionOrchestrationCapability;
  humanIntervention: SessionIdAcpInteractionHumanCapability;
  commandReceipts: SessionIdAcpInteractionReceiptCapability;
  currentBinding: SessionIdAcpInteractionBindingReadCapability;
  sessionExecution: SessionIdAcpInteractionExecutionReadCapability;
  providerEffects: SessionIdAcpInteractionProviderEffectReadCapability;
}>;

export interface SessionIdAcpInteractionResponseTransaction {
  run<T>(work: (owners: SessionIdAcpInteractionResponseCapabilities) => T): T;
}

export type SessionIdAcpInteractionResponseOwnerOptions = Readonly<{
  now: () => string;
  createId: (kind: "human_intervention" | "message" | "inbox_item") => string;
  authenticatedUserId: string;
  task: Readonly<{
    taskId: string;
    runId: string;
    conductorSessionId: string;
  }>;
  transaction: SessionIdAcpInteractionResponseTransaction;
  interactionBridge: Readonly<{
    stageInteractionResponse(input: Readonly<{
      sessionExecutionAttemptId: string;
      interactionId: string;
      expectedInteractionRevision: number;
      choiceId: string;
    }>): SessionIdAcpDrainableProviderEffect;
  }>;
}>;

/**
 * Authenticated Renderer application owner for one safe SR Interaction choice.
 * The selected Message text is read only from the persisted safe choice label;
 * the existing Input/Turn stay active and no Card Inbox is created.
 */
export function createSessionIdAcpInteractionResponseOwner(
  options: SessionIdAcpInteractionResponseOwnerOptions,
) {
  validateOptions(options);
  return Object.freeze({ respondToInteraction });

  function respondToInteraction(
    value: SessionIdAcpInteractionResponseCommand,
  ): SessionIdAcpInteractionResponseCommit {
    const command = validateCommand(value);
    invariant(command.taskId === options.task.taskId && command.runId === options.task.runId,
      "session_id_acp_interaction_command_scope_mismatch");
    const fingerprint = hashDefinition(command as unknown as JsonValue);
    return options.transaction.run((owners) => {
      const replay = owners.commandReceipts.getUiCommandReceipt(options.task.taskId, command.commandId);
      if (replay) return replayCommit(owners, replay, command, fingerprint);
      const proof = requireProof(owners, command);
      const idempotencyKey = `acp-renderer:interaction-response:${command.commandId}`;
      invariant(!owners.humanIntervention.findByIdempotencyKey(
        options.task.taskId,
        options.task.runId,
        idempotencyKey,
      ), "session_id_acp_interaction_receipt_missing");

      const now = options.now();
      const humanInterventionId = allocatedId("human_intervention", "human_intervention");
      const cardMessageId = allocatedId("message", "message");
      const conductorMessageId = allocatedId("message", "message");
      const conductorInboxId = allocatedId("inbox_item", "inbox");
      const intervention: SessionIdHumanInterventionRecord = Object.freeze({
        humanInterventionId,
        taskId: options.task.taskId,
        runId: options.task.runId,
        commandId: command.commandId,
        idempotencyKey,
        targetSessionId: command.targetLogicalSessionId,
        mode: "attention_response",
        state: "accepted",
        cardMessageId,
        conductorMirrorMessageId: conductorMessageId,
        affectedSessionTurnId: proof.turn.sessionTurnId,
        authenticatedUserId: options.authenticatedUserId,
        createdAt: now,
        updatedAt: now,
      });
      owners.message.createMessage(responseMessage({
        messageId: cardMessageId,
        sourceHumanInterventionId: humanInterventionId,
        sourceSessionTurnId: proof.turn.sessionTurnId,
        content: proof.label,
        now,
      }));
      owners.message.createMessage(responseMessage({
        messageId: conductorMessageId,
        sourceHumanInterventionId: humanInterventionId,
        sourceSessionTurnId: proof.turn.sessionTurnId,
        content: proof.label,
        now,
      }));
      owners.humanIntervention.create(intervention);
      owners.orchestration.createInboxItem(Object.freeze({
        inboxItemId: conductorInboxId,
        taskId: options.task.taskId,
        runId: options.task.runId,
        sessionId: options.task.conductorSessionId,
        renderedMessageId: conductorMessageId,
        sequence: nextLaneSequence(owners, options.task.conductorSessionId),
        priority: "human" as const,
        state: "pending" as const,
        humanInterventionId,
        createdAt: now,
        updatedAt: now,
      }));

      const staged = options.interactionBridge.stageInteractionResponse(Object.freeze({
        sessionExecutionAttemptId: proof.attempt.sessionExecutionAttemptId,
        interactionId: command.interactionId,
        expectedInteractionRevision: command.expectedInteractionRevision,
        choiceId: command.choiceId,
      }));
      assertStagedIntent(owners, staged, proof.attempt, command);
      const commit: SessionIdAcpInteractionResponseCommit = Object.freeze({
        result: Object.freeze({
          interactionResponse: Object.freeze({
            humanInterventionId,
            state: "accepted" as const,
            targetLogicalSessionId: command.targetLogicalSessionId,
            interactionId: command.interactionId,
            choiceId: command.choiceId,
            label: proof.label,
          }),
        }),
        providerEffectIntentIds: Object.freeze([staged.providerEffectIntentId]),
      });
      owners.commandReceipts.createUiCommandReceipt(Object.freeze({
        commandId: command.commandId,
        taskId: options.task.taskId,
        runId: options.task.runId,
        commandKind: "session.respond_interaction",
        idempotencyKey,
        payloadFingerprint: fingerprint,
        result: commit as unknown as JsonValue,
        createdAt: now,
      }));
      return commit;
    });
  }

  function requireProof(
    owners: SessionIdAcpInteractionResponseCapabilities,
    command: SessionIdAcpInteractionResponseCommand,
  ): Readonly<{
    attempt: SessionExecutionAttemptRecord;
    turn: SessionIdSessionTurnRecord;
    label: string;
  }> {
    const run = owners.taskRun.readTaskRunState(options.task.taskId, options.task.runId);
    invariant(run.taskId === options.task.taskId && run.runId === options.task.runId
      && run.taskRevision === command.expectedRevision,
    "session_id_acp_interaction_task_revision_stale");
    invariant(run.runStatus === "running", "session_id_acp_interaction_run_not_accepting");
    invariant(owners.taskRun.getConductorSessionId(options.task.taskId, options.task.runId)
      === options.task.conductorSessionId,
    "session_id_acp_interaction_conductor_scope_mismatch");
    const generation = owners.taskRun.getGeneration(command.targetLogicalSessionId);
    invariant(Boolean(generation)
      && generation!.sessionId === command.targetLogicalSessionId
      && generation!.taskId === options.task.taskId
      && generation!.runId === options.task.runId
      && generation!.lifecycle === "current"
      && generation!.closedAt === undefined,
    "session_id_acp_interaction_session_not_current");
    const slot = owners.taskRun.getSlot(generation!.cardSessionSlotId);
    invariant(Boolean(slot)
      && slot!.taskId === generation!.taskId
      && slot!.runId === generation!.runId
      && slot!.agentCardId === generation!.agentCardId
      && slot!.currentSessionId === command.targetLogicalSessionId
      && slot!.latestGeneration === generation!.generation,
    "session_id_acp_interaction_session_not_current");
    const persistedRuntime = owners.sessionExecution.getRuntimeForSession(command.targetLogicalSessionId);
    invariant(Boolean(persistedRuntime), "session_id_acp_interaction_runtime_not_found");
    const runtime = cloneSessionExecutionRuntimeRecord(persistedRuntime!);
    invariant(runtime.taskId === options.task.taskId
      && runtime.runId === options.task.runId
      && runtime.logicalSessionId === command.targetLogicalSessionId
      && runtime.state === "executing"
      && Boolean(runtime.activeAttemptId),
    "session_id_acp_interaction_runtime_scope_mismatch");
    const persistedAttempt = owners.sessionExecution.getAttempt(runtime.activeAttemptId!);
    invariant(Boolean(persistedAttempt), "session_id_acp_interaction_attempt_not_found");
    const attempt = cloneSessionExecutionAttemptRecord(persistedAttempt!);
    invariant(attempt.sessionExecutionRuntimeId === runtime.sessionExecutionRuntimeId
      && attempt.taskId === options.task.taskId
      && attempt.runId === options.task.runId
      && attempt.logicalSessionId === command.targetLogicalSessionId
      && attempt.state === "waiting_for_interaction"
      && !attempt.settlement,
    "session_id_acp_interaction_attempt_scope_mismatch");
    const persistedBinding = owners.currentBinding.getCurrentBinding(command.targetLogicalSessionId);
    invariant(Boolean(persistedBinding), "session_id_acp_interaction_binding_not_current");
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
    "session_id_acp_interaction_binding_mismatch");
    const interactions = attempt.interactions.filter((item) => item.interactionId === command.interactionId);
    invariant(interactions.length === 1, "session_id_acp_interaction_not_found");
    const interaction = interactions[0]!;
    invariant(interaction.status === "requested"
      && interaction.revision === command.expectedInteractionRevision,
    "session_id_acp_interaction_revision_stale");
    const choices = interaction.choices.filter((choice) => choice.choiceId === command.choiceId);
    invariant(choices.length === 1 && Boolean(choices[0]!.label.trim()),
      "session_id_acp_interaction_choice_invalid");
    const input = owners.orchestration.getInputSubmission(attempt.inputSubmissionId);
    const turn = owners.orchestration.getTurn(attempt.orchestrationSessionTurnId);
    invariant(Boolean(input) && Boolean(turn), "session_id_acp_interaction_or_state_missing");
    const inbox = owners.orchestration.getInboxItem(input!.sourceInboxItemId);
    invariant(Boolean(inbox)
      && input!.taskId === attempt.taskId
      && input!.runId === attempt.runId
      && input!.sessionId === attempt.logicalSessionId
      && input!.state === "accepted"
      && turn!.taskId === attempt.taskId
      && turn!.runId === attempt.runId
      && turn!.sessionId === attempt.logicalSessionId
      && turn!.inputSubmissionId === input!.inputSubmissionId
      && turn!.state === "active"
      && inbox!.taskId === attempt.taskId
      && inbox!.runId === attempt.runId
      && inbox!.sessionId === attempt.logicalSessionId
      && inbox!.state === "handed",
    "session_id_acp_interaction_or_state_mismatch");
    return Object.freeze({ attempt, turn: turn!, label: choices[0]!.label });
  }

  function assertStagedIntent(
    owners: SessionIdAcpInteractionResponseCapabilities,
    staged: SessionIdAcpDrainableProviderEffect,
    attempt: SessionExecutionAttemptRecord,
    command: SessionIdAcpInteractionResponseCommand,
  ): void {
    invariant(staged.commandType === "session_runtime.respond_interaction"
      && staged.sessionExecutionRuntimeId === attempt.sessionExecutionRuntimeId
      && staged.sessionExecutionAttemptId === attempt.sessionExecutionAttemptId,
    "session_id_acp_interaction_drain_mismatch");
    const persisted = owners.providerEffects.getProviderEffectIntent(staged.providerEffectIntentId);
    invariant(Boolean(persisted), "session_id_acp_interaction_intent_missing");
    const intent = cloneSessionRuntimeProviderEffectIntent(persisted!);
    invariant(intent.commandType === "session_runtime.respond_interaction"
      && intent.taskId === attempt.taskId
      && intent.runId === attempt.runId
      && intent.logicalSessionId === attempt.logicalSessionId
      && intent.sessionExecutionRuntimeId === attempt.sessionExecutionRuntimeId
      && intent.sessionExecutionAttemptId === attempt.sessionExecutionAttemptId
      && intent.inputSubmissionId === attempt.inputSubmissionId
      && intent.orchestrationSessionTurnId === attempt.orchestrationSessionTurnId
      && intent.bindingId === attempt.bindingId
      && intent.bindingRevision === attempt.bindingRevision
      && intent.interactionId === command.interactionId
      && intent.effect.kind === "respond_interaction"
      && intent.effect.interactionId === command.interactionId
      && intent.effect.choiceId === command.choiceId,
    "session_id_acp_interaction_intent_mismatch");
  }

  function replayCommit(
    owners: SessionIdAcpInteractionResponseCapabilities,
    receipt: SessionIdUiCommandReceiptRecord,
    command: SessionIdAcpInteractionResponseCommand,
    fingerprint: string,
  ): SessionIdAcpInteractionResponseCommit {
    invariant(receipt.taskId === options.task.taskId
      && receipt.runId === options.task.runId
      && receipt.commandKind === "session.respond_interaction"
      && receipt.payloadFingerprint === fingerprint,
    "session_id_acp_interaction_replay_conflict");
    const value = receipt.result as unknown as SessionIdAcpInteractionResponseCommit;
    invariant(Boolean(value?.result?.interactionResponse)
      && value.result.interactionResponse.targetLogicalSessionId === command.targetLogicalSessionId
      && value.result.interactionResponse.interactionId === command.interactionId
      && value.result.interactionResponse.choiceId === command.choiceId
      && value.providerEffectIntentIds.length === 1,
    "session_id_acp_interaction_replay_result_invalid");
    const persistedIntent = owners.providerEffects.getProviderEffectIntent(value.providerEffectIntentIds[0]!);
    invariant(Boolean(persistedIntent), "session_id_acp_interaction_replay_intent_missing");
    const persistedAttempt = owners.sessionExecution.getAttempt(persistedIntent!.sessionExecutionAttemptId);
    invariant(Boolean(persistedAttempt), "session_id_acp_interaction_replay_attempt_missing");
    assertStagedIntent(owners, {
      disposition: "replay",
      commandType: "session_runtime.respond_interaction",
      providerEffectIntentId: value.providerEffectIntentIds[0]!,
      sessionExecutionRuntimeId: persistedAttempt!.sessionExecutionRuntimeId,
      sessionExecutionAttemptId: persistedAttempt!.sessionExecutionAttemptId,
    }, persistedAttempt!, command);
    return Object.freeze({
      result: Object.freeze({
        interactionResponse: Object.freeze({ ...value.result.interactionResponse }),
      }),
      providerEffectIntentIds: Object.freeze([...value.providerEffectIntentIds]),
    });
  }

  function responseMessage(input: Readonly<{
    messageId: string;
    sourceHumanInterventionId: string;
    sourceSessionTurnId: string;
    content: string;
    now: string;
  }>): SessionIdSessionMessageRecord {
    return Object.freeze({
      messageId: input.messageId,
      taskId: options.task.taskId,
      runId: options.task.runId,
      sourceSessionTurnId: input.sourceSessionTurnId,
      sourceHumanInterventionId: input.sourceHumanInterventionId,
      kind: "user_input",
      content: input.content,
      canonicalContent: Object.freeze([{ kind: "text" as const, text: input.content }]),
      contentDigest: hashDefinition(input.content),
      createdAt: input.now,
    });
  }

  function nextLaneSequence(owners: SessionIdAcpInteractionResponseCapabilities, sessionId: string): number {
    return owners.orchestration.listInboxItems(sessionId)
      .reduce((highest, item) => Math.max(highest, item.sequence), 0) + 1;
  }

  function allocatedId(
    kind: Parameters<SessionIdAcpInteractionResponseOwnerOptions["createId"]>[0],
    prefix: string,
  ): string {
    const identity = options.createId(kind);
    invariant(typeof identity === "string" && new RegExp(`^${prefix}_[A-Za-z0-9_-]+$`, "u").test(identity),
      "session_id_acp_interaction_identity_invalid");
    return identity;
  }
}

/** Pure Renderer projection from current SR state; it exposes no prompt/raw/binding/Attempt identity. */
export function projectSessionIdAcpPendingInteractions(input: Readonly<{
  logicalSessionId: string;
  runtime: SessionExecutionRuntimeRecord;
  attempt: SessionExecutionAttemptRecord;
}>): readonly SessionIdAcpPendingInteractionReadModel[] {
  const runtime = cloneSessionExecutionRuntimeRecord(input.runtime);
  const attempt = cloneSessionExecutionAttemptRecord(input.attempt);
  invariant(runtime.logicalSessionId === input.logicalSessionId
    && runtime.state === "executing"
    && runtime.activeAttemptId === attempt.sessionExecutionAttemptId
    && attempt.sessionExecutionRuntimeId === runtime.sessionExecutionRuntimeId
    && attempt.logicalSessionId === input.logicalSessionId
    && attempt.state === "waiting_for_interaction"
    && !attempt.settlement,
  "session_id_acp_interaction_projection_scope_mismatch");
  return Object.freeze(attempt.interactions
    .filter((interaction) => interaction.status === "requested")
    .map((interaction) => Object.freeze({
      targetLogicalSessionId: input.logicalSessionId,
      interactionId: interaction.interactionId,
      interactionRevision: interaction.revision,
      choices: Object.freeze(interaction.choices.map((choice) => Object.freeze({
        choiceId: choice.choiceId,
        label: choice.label,
      }))),
    })));
}

function validateCommand(value: unknown): SessionIdAcpInteractionResponseCommand {
  invariant(Boolean(value) && typeof value === "object" && !Array.isArray(value),
    "session_id_acp_interaction_input_shape_invalid");
  const root = value as Record<string, unknown>;
  const keys = [
    "choiceId", "commandId", "expectedInteractionRevision", "expectedRevision", "interactionId",
    "runId", "targetLogicalSessionId", "taskId",
  ];
  invariant(Object.keys(root).sort().join("|") === keys.join("|"),
    "session_id_acp_interaction_input_shape_invalid");
  invariant(typeof root.commandId === "string" && /^command_[A-Za-z0-9_-]+$/u.test(root.commandId)
    && typeof root.taskId === "string" && /^task_[A-Za-z0-9_-]+$/u.test(root.taskId)
    && typeof root.runId === "string" && /^run_[A-Za-z0-9_-]+$/u.test(root.runId)
    && typeof root.targetLogicalSessionId === "string"
    && /^logical_session_[A-Za-z0-9_-]+$/u.test(root.targetLogicalSessionId)
    && typeof root.interactionId === "string" && /^interaction_[A-Za-z0-9_-]+$/u.test(root.interactionId)
    && typeof root.choiceId === "string" && /^choice_[A-Za-z0-9_-]+$/u.test(root.choiceId)
    && Number.isInteger(root.expectedRevision) && Number(root.expectedRevision) > 0
    && Number.isInteger(root.expectedInteractionRevision) && Number(root.expectedInteractionRevision) > 0,
  "session_id_acp_interaction_input_invalid");
  return Object.freeze({ ...root }) as unknown as SessionIdAcpInteractionResponseCommand;
}

function validateOptions(options: SessionIdAcpInteractionResponseOwnerOptions): void {
  invariant(Boolean(options)
    && typeof options.now === "function"
    && typeof options.createId === "function"
    && typeof options.authenticatedUserId === "string" && Boolean(options.authenticatedUserId.trim())
    && typeof options.transaction?.run === "function"
    && typeof options.interactionBridge?.stageInteractionResponse === "function",
  "session_id_acp_interaction_options_invalid");
  invariant(/^task_[A-Za-z0-9_-]+$/u.test(options.task.taskId)
    && /^run_[A-Za-z0-9_-]+$/u.test(options.task.runId)
    && /^logical_session_[A-Za-z0-9_-]+$/u.test(options.task.conductorSessionId),
  "session_id_acp_interaction_task_scope_invalid");
}

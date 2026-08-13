import {
  cloneSessionExecutionAttemptRecord,
  cloneSessionExecutionRuntimeRecord,
  cloneSessionRuntimeProviderEffectIntent,
  hashDefinition,
  type CardSessionGenerationRecord,
  type CardSessionSlotRecord,
  type ConductorPlanningFenceRecord,
  type JsonValue,
  type ProviderFamily,
  type SessionControlAuditRecord,
  type SessionExecutionAttemptRecord,
  type SessionExecutionRuntimeRecord,
  type SessionLaneItemRecord,
  type SessionRuntimeProviderEffectIntentRecord,
} from "@agent-workspace/runtime-contracts";
import {
  invariant,
  materializeCardSessionGeneration,
} from "@agent-workspace/runtime-domain";
import type {
  SessionIdHumanInterventionRecord,
  SessionIdInputSubmissionRecord,
  SessionIdSessionMessageRecord,
  SessionIdSessionTurnRecord,
  SessionIdUiCommandReceiptRecord,
} from "@agent-workspace/runtime-store";
import type {
  SessionIdAcpDrainableProviderEffect,
  SessionIdAcpFrozenProfileTuple,
} from "./session-id-acp-orchestration-bridge.js";

export type SessionIdAcpTaskInputCommand = Readonly<{
  commandId: string;
  taskId: string;
  runId: string;
  expectedRevision: number;
  targetLogicalSessionId: string;
  content: string;
}>;

export type SessionIdAcpHumanMessageCommand = Readonly<{
  commandId: string;
  taskId: string;
  runId: string;
  expectedRevision: number;
  targetAgentCardId?: string;
  targetLogicalSessionId?: string;
  humanInterventionId: string;
  idempotencyKey: string;
  authenticatedUserId: string;
  content: string;
}>;

export type SessionIdAcpAbandonHumanMessageCommand = Readonly<{
  commandId: string;
  taskId: string;
  runId: string;
  expectedRevision: number;
  humanInterventionId: string;
  idempotencyKey: string;
  authenticatedUserId: string;
}>;

export type SessionIdAcpRendererCommandResult = Readonly<{
  taskRevision?: number;
  humanIntervention?: Readonly<{
    humanInterventionId: string;
    state: "sent" | "held" | "abandoned";
    targetLogicalSessionId: string;
    materializedGeneration?: number;
  }>;
}>;

export type SessionIdAcpRendererCommandCommit = Readonly<{
  /** Renderer-safe result; production Host strips the internal drain field. */
  result: SessionIdAcpRendererCommandResult;
  providerEffectIntentIds: readonly string[];
}>;

export interface SessionIdAcpRendererTaskRunCapability {
  findSlot(runId: string, agentCardId: string): CardSessionSlotRecord | undefined;
  getSlot(cardSessionSlotId: string): CardSessionSlotRecord | undefined;
  getGeneration(logicalSessionId: string): CardSessionGenerationRecord | undefined;
  materializeGeneration(slot: CardSessionSlotRecord, generation: CardSessionGenerationRecord): void;
  createPlanningFence(fence: ConductorPlanningFenceRecord): void;
  latestPlanningFence(runId: string): ConductorPlanningFenceRecord | undefined;
  readTaskRunState(taskId: string, runId: string): Readonly<{
    taskId: string;
    runId: string;
    taskRevision: number;
    runStatus: string;
    currentConductorSessionTurnId?: string;
  }>;
  getConductorSessionId(taskId: string, runId: string): string;
  acceptTaskInput(input: Readonly<{
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
  }>): void;
}

export interface SessionIdAcpRendererMessageCapability {
  createMessage(message: SessionIdSessionMessageRecord): void;
  getMessage(messageId: string): SessionIdSessionMessageRecord | undefined;
}

export interface SessionIdAcpRendererOrchestrationCapability {
  createInboxItem(item: SessionLaneItemRecord): void;
  getInboxItem(inboxItemId: string): SessionLaneItemRecord | undefined;
  listInboxItems(logicalSessionId: string): readonly SessionLaneItemRecord[];
  updateInboxItem(item: SessionLaneItemRecord, expectedState: SessionLaneItemRecord["state"]): void;
  findInputByInboxItem(inboxItemId: string): SessionIdInputSubmissionRecord | undefined;
  listTurns(logicalSessionId: string): readonly SessionIdSessionTurnRecord[];
  createControlAudit(control: SessionControlAuditRecord): void;
  getControlAudit(sessionControlAuditId: string): SessionControlAuditRecord | undefined;
  listControlAudits(runId: string, logicalSessionId?: string): readonly SessionControlAuditRecord[];
}

export interface SessionIdAcpRendererHumanCapability {
  create(intervention: SessionIdHumanInterventionRecord): void;
  get(humanInterventionId: string): SessionIdHumanInterventionRecord | undefined;
  update(intervention: SessionIdHumanInterventionRecord): void;
  findByIdempotencyKey(taskId: string, runId: string, idempotencyKey: string): SessionIdHumanInterventionRecord | undefined;
  list(runId: string, targetLogicalSessionId?: string): readonly SessionIdHumanInterventionRecord[];
}

export interface SessionIdAcpRendererReceiptCapability {
  createUiCommandReceipt(receipt: SessionIdUiCommandReceiptRecord): void;
  getUiCommandReceipt(taskId: string, commandId: string): SessionIdUiCommandReceiptRecord | undefined;
}

export interface SessionIdAcpRendererExecutionReadCapability {
  getRuntimeForSession(logicalSessionId: string): SessionExecutionRuntimeRecord | undefined;
  getAttempt(sessionExecutionAttemptId: string): SessionExecutionAttemptRecord | undefined;
}

export interface SessionIdAcpRendererProviderEffectReadCapability {
  listProviderEffectIntents(
    sessionExecutionAttemptId?: string,
  ): readonly SessionRuntimeProviderEffectIntentRecord[];
}

export type SessionIdAcpRendererCommandCapabilities = Readonly<{
  taskRun: SessionIdAcpRendererTaskRunCapability;
  message: SessionIdAcpRendererMessageCapability;
  orchestration: SessionIdAcpRendererOrchestrationCapability;
  humanIntervention: SessionIdAcpRendererHumanCapability;
  commandReceipts: SessionIdAcpRendererReceiptCapability;
  sessionExecution: SessionIdAcpRendererExecutionReadCapability;
  providerEffects: SessionIdAcpRendererProviderEffectReadCapability;
}>;

export interface SessionIdAcpRendererCommandTransaction {
  run<T>(work: (owners: SessionIdAcpRendererCommandCapabilities) => T): T;
}

export type SessionIdAcpRendererCommandApplicationOptions = Readonly<{
  now: () => string;
  createId: (
    kind: "logical_session" | "message" | "inbox_item" | "planning_fence" | "session_control",
  ) => string;
  task: Readonly<{
    taskId: string;
    runId: string;
    conductorSessionId: string;
    agentCards: readonly Readonly<{
      agentCardId: string;
      executionProfileId: string;
      profileRevisionId: string;
      providerFamily: ProviderFamily;
    }>[];
  }>;
  transaction: SessionIdAcpRendererCommandTransaction;
  resolveFrozenProfile(scope: Readonly<{
    taskId: string;
    runId: string;
    logicalSessionId: string;
    executionProfileId: string;
  }>): SessionIdAcpFrozenProfileTuple | undefined;
  interruptBridge: Readonly<{
    stageInterrupt(input: Readonly<{ sessionControlAuditId: string }>): SessionIdAcpDrainableProviderEffect;
  }>;
}>;

export function createSessionIdAcpRendererCommandApplication(
  options: SessionIdAcpRendererCommandApplicationOptions,
) {
  validateOptions(options);
  return Object.freeze({ submitTaskInput, sendHumanMessage, abandonHumanMessage });

  function submitTaskInput(value: SessionIdAcpTaskInputCommand): SessionIdAcpRendererCommandCommit {
    const command = validateTaskInput(value);
    assertCommandScope(command);
    const fingerprint = hashDefinition(command as unknown as JsonValue);
    return options.transaction.run((owners) => {
      const replay = replayReceipt(owners, "task.submit_input", command.commandId, fingerprint);
      if (replay) return replay;
      const run = requireRun(owners, command.expectedRevision);
      invariant(command.targetLogicalSessionId === options.task.conductorSessionId
        && owners.taskRun.getConductorSessionId(options.task.taskId, options.task.runId)
          === options.task.conductorSessionId,
      "task_input_conductor_target_required");
      const now = options.now();
      const messageId = allocatedId("message", "message");
      const inboxItemId = allocatedId("inbox_item", "inbox");
      const planningFenceId = allocatedId("planning_fence", "planning_fence");
      const currentConductorSessionTurnId = planningTurnId(options.task.runId, messageId);
      const previousConductorSessionTurnId = run.currentConductorSessionTurnId
        ?? owners.taskRun.latestPlanningFence(options.task.runId)?.currentConductorSessionTurnId;
      owners.message.createMessage(sessionMessage({
        taskId: options.task.taskId,
        runId: options.task.runId,
        messageId,
        kind: "user_input",
        content: command.content,
        now,
      }));
      owners.orchestration.createInboxItem(Object.freeze({
        inboxItemId,
        taskId: options.task.taskId,
        runId: options.task.runId,
        sessionId: options.task.conductorSessionId,
        renderedMessageId: messageId,
        sequence: nextLaneSequence(owners, options.task.conductorSessionId),
        priority: "human" as const,
        state: "pending" as const,
        createdAt: now,
        updatedAt: now,
      }));
      const fence: ConductorPlanningFenceRecord = Object.freeze({
        planningFenceId,
        taskId: options.task.taskId,
        runId: options.task.runId,
        sourceCommandId: command.commandId,
        ...(previousConductorSessionTurnId ? { previousConductorSessionTurnId } : {}),
        currentConductorSessionTurnId,
        createdAt: now,
      });
      owners.taskRun.createPlanningFence(fence);
      owners.taskRun.acceptTaskInput({
        taskId: options.task.taskId,
        runId: options.task.runId,
        commandId: command.commandId,
        expectedRevision: command.expectedRevision,
        nextRevision: command.expectedRevision + 1,
        planningFenceId,
        messageId,
        ...(previousConductorSessionTurnId ? { previousConductorSessionTurnId } : {}),
        currentConductorSessionTurnId,
        acceptedAt: now,
      });
      const commit = rendererCommit(Object.freeze({ taskRevision: command.expectedRevision + 1 }), []);
      persistReceipt(owners, "task.submit_input", command.commandId,
        `acp-renderer:task-input:${command.commandId}`, fingerprint, commit, now);
      return commit;
    });
  }

  function sendHumanMessage(value: SessionIdAcpHumanMessageCommand): SessionIdAcpRendererCommandCommit {
    const command = validateHumanMessage(value);
    assertCommandScope(command);
    const fingerprint = hashDefinition(command as unknown as JsonValue);
    return options.transaction.run((owners) => {
      const replay = replayReceipt(owners, "session.send_human_message", command.commandId, fingerprint);
      if (replay) return replay;
      requireRun(owners, command.expectedRevision);
      invariant(!owners.humanIntervention.findByIdempotencyKey(
        options.task.taskId,
        options.task.runId,
        command.idempotencyKey,
      ), "human_intervention_idempotency_conflict");
      const target = resolveHumanTarget(owners, command);
      const lane = owners.orchestration.listInboxItems(target.generation.sessionId);
      invariant(!lane.some((item) => item.state === "held_by_human_intervention"
        || item.state === "leased" || item.state === "ambiguous"),
      "human_intervention_path_active");
      invariant(!owners.humanIntervention.list(options.task.runId, target.generation.sessionId)
        .some((item) => item.state === "held" || item.state === "accepted" || item.state === "delivered"),
      "human_intervention_path_active");
      invariant(!owners.orchestration.listControlAudits(options.task.runId, target.generation.sessionId)
        .some((control) => control.state === "requested" || control.state === "accepted" || control.state === "unknown"),
      "human_intervention_control_unresolved");
      const liveTurns = owners.orchestration.listTurns(target.generation.sessionId)
        .filter((turn) => turn.state === "pending" || turn.state === "active" || turn.state === "ambiguous");
      invariant(liveTurns.length <= 1, "human_intervention_turn_ambiguous");
      invariant(!liveTurns.some((turn) => turn.state !== "active"),
        "human_intervention_provider_outcome_unknown");
      const activeTurn = liveTurns[0];
      const activeAttempt = activeTurn ? requireActiveAttempt(owners, target.generation, activeTurn) : undefined;
      invariant(!activeAttempt?.attempt.interactions.some((interaction) => interaction.status === "requested"),
        "human_intervention_interaction_unresolved");
      const pendingOrdinary = lane.filter((item) => item.state === "pending"
        && item.priority === "ordinary" && Boolean(item.forwardId));
      invariant(!pendingOrdinary.some((item) => owners.orchestration.findInputByInboxItem(item.inboxItemId)),
        "human_intervention_pending_send_already_staged");
      const now = options.now();
      const conductorMessageId = allocatedId("message", "message");
      const cardMessageId = allocatedId("message", "message");
      const conductorInboxId = allocatedId("inbox_item", "inbox");
      const cardInboxId = allocatedId("inbox_item", "inbox");
      const conductorInbox: SessionLaneItemRecord = Object.freeze({
        inboxItemId: conductorInboxId,
        taskId: options.task.taskId,
        runId: options.task.runId,
        sessionId: options.task.conductorSessionId,
        renderedMessageId: conductorMessageId,
        sequence: nextLaneSequence(owners, options.task.conductorSessionId),
        priority: "human",
        state: "pending",
        humanInterventionId: command.humanInterventionId,
        createdAt: now,
        updatedAt: now,
      });
      const cardInbox: SessionLaneItemRecord = Object.freeze({
        inboxItemId: cardInboxId,
        taskId: options.task.taskId,
        runId: options.task.runId,
        sessionId: target.generation.sessionId,
        renderedMessageId: cardMessageId,
        sequence: nextLaneSequence(owners, target.generation.sessionId),
        priority: "human",
        state: activeTurn ? "held_by_human_intervention" : "pending",
        humanInterventionId: command.humanInterventionId,
        createdAt: now,
        updatedAt: now,
      });
      const intervention: SessionIdHumanInterventionRecord = Object.freeze({
        humanInterventionId: command.humanInterventionId,
        taskId: options.task.taskId,
        runId: options.task.runId,
        commandId: command.commandId,
        idempotencyKey: command.idempotencyKey,
        targetSessionId: target.generation.sessionId,
        mode: activeTurn ? "interrupt_then_send" : "direct_message",
        state: activeTurn ? "held" : "accepted",
        cardMessageId,
        conductorMirrorMessageId: conductorMessageId,
        ...(activeTurn ? { affectedSessionTurnId: activeTurn.sessionTurnId } : {}),
        authenticatedUserId: command.authenticatedUserId,
        createdAt: now,
        updatedAt: now,
      });
      if (target.materialized) {
        owners.taskRun.materializeGeneration(target.materialized.slot, target.materialized.generation);
      }
      owners.message.createMessage(sessionMessage({
        taskId: options.task.taskId,
        runId: options.task.runId,
        messageId: conductorMessageId,
        kind: "user_input",
        content: command.content,
        sourceHumanInterventionId: command.humanInterventionId,
        now,
      }));
      owners.message.createMessage(sessionMessage({
        taskId: options.task.taskId,
        runId: options.task.runId,
        messageId: cardMessageId,
        kind: "user_input",
        content: command.content,
        sourceHumanInterventionId: command.humanInterventionId,
        now,
      }));
      owners.humanIntervention.create(intervention);
      owners.orchestration.createInboxItem(conductorInbox);
      for (const item of pendingOrdinary) {
        owners.orchestration.updateInboxItem(Object.freeze({
          ...item,
          state: "suppressed",
          reason: "human_intervention",
          updatedAt: now,
        }), "pending");
      }
      if (pendingOrdinary.length > 0) createHumanPriorityNotice(owners, intervention, now);
      owners.orchestration.createInboxItem(cardInbox);

      let providerEffectIntentIds: readonly string[] = Object.freeze([]);
      if (activeTurn && activeAttempt) {
        const control: SessionControlAuditRecord = Object.freeze({
          sessionControlAuditId: allocatedId("session_control", "session_control"),
          taskId: options.task.taskId,
          runId: options.task.runId,
          sessionId: target.generation.sessionId,
          commandId: command.commandId,
          idempotencyKey: `${command.idempotencyKey}:interrupt`,
          kind: "human_interrupt",
          state: "requested",
          affectedInboxItemIds: Object.freeze(pendingOrdinary.map((item) => item.inboxItemId)),
          requestedAt: now,
        });
        owners.orchestration.createControlAudit(control);
        const staged = options.interruptBridge.stageInterrupt({
          sessionControlAuditId: control.sessionControlAuditId,
        });
        assertInterruptDrain(owners, staged, activeAttempt, control);
        providerEffectIntentIds = Object.freeze([staged.providerEffectIntentId]);
      }
      const result: SessionIdAcpRendererCommandResult = Object.freeze({
        humanIntervention: Object.freeze({
          humanInterventionId: command.humanInterventionId,
          state: activeTurn ? "held" as const : "sent" as const,
          targetLogicalSessionId: target.generation.sessionId,
          ...(target.materialized ? { materializedGeneration: target.generation.generation } : {}),
        }),
      });
      const commit = rendererCommit(result, providerEffectIntentIds);
      persistReceipt(owners, "session.send_human_message", command.commandId,
        command.idempotencyKey, fingerprint, commit, now);
      return commit;
    });
  }

  function abandonHumanMessage(
    value: SessionIdAcpAbandonHumanMessageCommand,
  ): SessionIdAcpRendererCommandCommit {
    const command = validateAbandon(value);
    assertCommandScope(command);
    const fingerprint = hashDefinition(command as unknown as JsonValue);
    return options.transaction.run((owners) => {
      const replay = replayReceipt(owners, "session.abandon_human_message", command.commandId, fingerprint);
      if (replay) return replay;
      requireRun(owners, command.expectedRevision);
      const intervention = owners.humanIntervention.get(command.humanInterventionId);
      invariant(Boolean(intervention)
        && intervention!.taskId === options.task.taskId
        && intervention!.runId === options.task.runId
        && intervention!.authenticatedUserId === command.authenticatedUserId,
      "human_intervention_not_found");
      invariant(intervention!.state === "accepted" || intervention!.state === "held",
        "human_intervention_not_abandonable");
      requireCurrentGeneration(owners, intervention!.targetSessionId);
      invariant(Boolean(intervention!.cardMessageId), "human_intervention_not_abandonable");
      const cardItems = owners.orchestration.listInboxItems(intervention!.targetSessionId)
        .filter((item) => item.humanInterventionId === intervention!.humanInterventionId
          && item.renderedMessageId === intervention!.cardMessageId);
      invariant(cardItems.length === 1
        && (cardItems[0]!.state === "pending" || cardItems[0]!.state === "held_by_human_intervention")
        && !owners.orchestration.findInputByInboxItem(cardItems[0]!.inboxItemId),
      "human_intervention_not_abandonable");
      const now = options.now();
      owners.orchestration.updateInboxItem(Object.freeze({
        ...cardItems[0]!,
        state: "suppressed",
        reason: "human_intervention_abandoned",
        updatedAt: now,
      }), cardItems[0]!.state);
      owners.humanIntervention.update(Object.freeze({
        ...intervention!,
        state: "abandoned",
        updatedAt: now,
      }));
      const content = `Authenticated human message for Session ${intervention!.targetSessionId} was abandoned before delivery.`;
      const messageId = allocatedId("message", "message");
      owners.message.createMessage(sessionMessage({
        taskId: options.task.taskId,
        runId: options.task.runId,
        messageId,
        kind: "runtime_notice",
        content,
        sourceSessionId: intervention!.targetSessionId,
        now,
      }));
      owners.orchestration.createInboxItem(Object.freeze({
        inboxItemId: allocatedId("inbox_item", "inbox"),
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
      const commit = rendererCommit(Object.freeze({
        humanIntervention: Object.freeze({
          humanInterventionId: intervention!.humanInterventionId,
          state: "abandoned" as const,
          targetLogicalSessionId: intervention!.targetSessionId,
        }),
      }), []);
      persistReceipt(owners, "session.abandon_human_message", command.commandId,
        command.idempotencyKey, fingerprint, commit, now);
      return commit;
    });
  }

  function resolveHumanTarget(
    owners: SessionIdAcpRendererCommandCapabilities,
    command: SessionIdAcpHumanMessageCommand,
  ): Readonly<{
    generation: CardSessionGenerationRecord;
    materialized?: Readonly<{ slot: CardSessionSlotRecord; generation: CardSessionGenerationRecord }>;
  }> {
    if (command.targetLogicalSessionId) {
      return Object.freeze({ generation: requireCurrentGeneration(owners, command.targetLogicalSessionId) });
    }
    const card = options.task.agentCards.find((candidate) => candidate.agentCardId === command.targetAgentCardId);
    invariant(Boolean(card), "human_intervention_agent_card_not_in_architecture");
    const slot = owners.taskRun.findSlot(options.task.runId, card!.agentCardId);
    invariant(Boolean(slot)
      && slot!.taskId === options.task.taskId
      && slot!.runId === options.task.runId
      && slot!.agentCardId === card!.agentCardId,
    "human_intervention_card_slot_missing");
    if (slot!.currentSessionId) {
      return Object.freeze({ generation: requireCurrentGeneration(owners, slot!.currentSessionId) });
    }
    const sessionId = allocatedId("logical_session", "logical_session");
    const materialized = materializeCardSessionGeneration({
      slot,
      taskId: options.task.taskId,
      runId: options.task.runId,
      agentCardId: card!.agentCardId,
      executionProfileId: card!.executionProfileId,
      cardSessionSlotId: slot!.cardSessionSlotId,
      sessionId,
      now: options.now(),
    });
    const profile = options.resolveFrozenProfile({
      taskId: options.task.taskId,
      runId: options.task.runId,
      logicalSessionId: sessionId,
      executionProfileId: card!.executionProfileId,
    });
    invariant(Boolean(profile)
      && profile!.schemaVersion === 3
      && profile!.executionProfileId === card!.executionProfileId
      && profile!.profileRevisionId === card!.profileRevisionId
      && profile!.providerFamily === card!.providerFamily,
    "human_intervention_frozen_profile_mismatch");
    return Object.freeze({ generation: materialized.generation, materialized });
  }

  function requireCurrentGeneration(
    owners: SessionIdAcpRendererCommandCapabilities,
    logicalSessionId: string,
  ): CardSessionGenerationRecord {
    const generation = owners.taskRun.getGeneration(logicalSessionId);
    invariant(Boolean(generation)
      && generation!.sessionId === logicalSessionId
      && generation!.taskId === options.task.taskId
      && generation!.runId === options.task.runId
      && generation!.lifecycle === "current"
      && generation!.closedAt === undefined,
    "human_intervention_session_not_current");
    const slot = owners.taskRun.getSlot(generation!.cardSessionSlotId);
    invariant(Boolean(slot)
      && slot!.taskId === generation!.taskId
      && slot!.runId === generation!.runId
      && slot!.agentCardId === generation!.agentCardId
      && slot!.currentSessionId === logicalSessionId
      && slot!.latestGeneration === generation!.generation,
    "human_intervention_session_not_current");
    const card = options.task.agentCards.find((candidate) => candidate.agentCardId === generation!.agentCardId);
    invariant(Boolean(card) && card!.executionProfileId === generation!.executionProfileId,
      "human_intervention_session_profile_mismatch");
    return generation!;
  }

  function requireActiveAttempt(
    owners: SessionIdAcpRendererCommandCapabilities,
    generation: CardSessionGenerationRecord,
    turn: SessionIdSessionTurnRecord,
  ): Readonly<{ runtime: SessionExecutionRuntimeRecord; attempt: SessionExecutionAttemptRecord }> {
    const persistedRuntime = owners.sessionExecution.getRuntimeForSession(generation.sessionId);
    invariant(Boolean(persistedRuntime), "human_intervention_active_runtime_missing");
    const runtime = cloneSessionExecutionRuntimeRecord(persistedRuntime!);
    invariant(runtime.taskId === generation.taskId
      && runtime.runId === generation.runId
      && runtime.logicalSessionId === generation.sessionId
      && runtime.state === "executing"
      && Boolean(runtime.activeAttemptId),
    "human_intervention_active_runtime_mismatch");
    const persistedAttempt = owners.sessionExecution.getAttempt(runtime.activeAttemptId!);
    invariant(Boolean(persistedAttempt), "human_intervention_active_attempt_missing");
    const attempt = cloneSessionExecutionAttemptRecord(persistedAttempt!);
    invariant(attempt.taskId === generation.taskId
      && attempt.runId === generation.runId
      && attempt.logicalSessionId === generation.sessionId
      && attempt.sessionExecutionRuntimeId === runtime.sessionExecutionRuntimeId
      && attempt.orchestrationSessionTurnId === turn.sessionTurnId
      && attempt.state === "active"
      && !attempt.settlement,
    "human_intervention_active_attempt_mismatch");
    return Object.freeze({ runtime, attempt });
  }

  function assertInterruptDrain(
    owners: SessionIdAcpRendererCommandCapabilities,
    staged: SessionIdAcpDrainableProviderEffect,
    execution: Readonly<{ runtime: SessionExecutionRuntimeRecord; attempt: SessionExecutionAttemptRecord }>,
    control: SessionControlAuditRecord,
  ): void {
    invariant(staged.commandType === "session_runtime.request_interrupt"
      && staged.sessionExecutionRuntimeId === execution.runtime.sessionExecutionRuntimeId
      && staged.sessionExecutionAttemptId === execution.attempt.sessionExecutionAttemptId,
    "human_intervention_interrupt_drain_mismatch");
    const intents = owners.providerEffects.listProviderEffectIntents(execution.attempt.sessionExecutionAttemptId)
      .map(cloneSessionRuntimeProviderEffectIntent)
      .filter((intent) => intent.providerEffectIntentId === staged.providerEffectIntentId);
    invariant(intents.length === 1, "human_intervention_interrupt_intent_missing");
    const intent = intents[0]!;
    invariant(intent.commandType === "session_runtime.request_interrupt"
      && intent.taskId === execution.attempt.taskId
      && intent.runId === execution.attempt.runId
      && intent.logicalSessionId === execution.attempt.logicalSessionId
      && intent.sessionExecutionRuntimeId === execution.runtime.sessionExecutionRuntimeId
      && intent.sessionExecutionAttemptId === execution.attempt.sessionExecutionAttemptId
      && intent.inputSubmissionId === execution.attempt.inputSubmissionId
      && intent.orchestrationSessionTurnId === execution.attempt.orchestrationSessionTurnId
      && intent.sessionControlAuditId === control.sessionControlAuditId
      && intent.effect.kind === "request_interrupt"
      && intent.effect.sessionControlAuditId === control.sessionControlAuditId,
    "human_intervention_interrupt_intent_mismatch");
  }

  function createHumanPriorityNotice(
    owners: SessionIdAcpRendererCommandCapabilities,
    intervention: SessionIdHumanInterventionRecord,
    now: string,
  ): void {
    const content = `Authenticated human intervention superseded pending ordinary sends to Session ${intervention.targetSessionId}.`;
    const messageId = allocatedId("message", "message");
    owners.message.createMessage(sessionMessage({
      taskId: options.task.taskId,
      runId: options.task.runId,
      messageId,
      kind: "runtime_notice",
      content,
      sourceSessionId: intervention.targetSessionId,
      now,
    }));
    owners.orchestration.createInboxItem(Object.freeze({
      inboxItemId: allocatedId("inbox_item", "inbox"),
      taskId: options.task.taskId,
      runId: options.task.runId,
      sessionId: options.task.conductorSessionId,
      renderedMessageId: messageId,
      sequence: nextLaneSequence(owners, options.task.conductorSessionId),
      priority: "notice",
      state: "pending",
      createdAt: now,
      updatedAt: now,
    }));
  }

  function replayReceipt(
    owners: SessionIdAcpRendererCommandCapabilities,
    kind: SessionIdUiCommandReceiptRecord["commandKind"],
    commandId: string,
    fingerprint: string,
  ): SessionIdAcpRendererCommandCommit | undefined {
    const receipt = owners.commandReceipts.getUiCommandReceipt(options.task.taskId, commandId);
    if (!receipt) return undefined;
    invariant(receipt.taskId === options.task.taskId
      && receipt.runId === options.task.runId
      && receipt.commandKind === kind
      && receipt.payloadFingerprint === fingerprint,
    "session_id_acp_renderer_command_replay_conflict");
    return cloneCommit(receipt.result);
  }

  function persistReceipt(
    owners: SessionIdAcpRendererCommandCapabilities,
    kind: SessionIdUiCommandReceiptRecord["commandKind"],
    commandId: string,
    idempotencyKey: string,
    fingerprint: string,
    commit: SessionIdAcpRendererCommandCommit,
    createdAt: string,
  ): void {
    owners.commandReceipts.createUiCommandReceipt(Object.freeze({
      commandId,
      taskId: options.task.taskId,
      runId: options.task.runId,
      commandKind: kind,
      idempotencyKey,
      payloadFingerprint: fingerprint,
      result: commit as unknown as JsonValue,
      createdAt,
    }));
  }

  function requireRun(owners: SessionIdAcpRendererCommandCapabilities, expectedRevision: number) {
    const run = owners.taskRun.readTaskRunState(options.task.taskId, options.task.runId);
    invariant(run.taskId === options.task.taskId && run.runId === options.task.runId,
      "session_id_acp_renderer_run_scope_mismatch");
    invariant(run.taskRevision === expectedRevision, "session_id_acp_renderer_task_revision_stale");
    invariant(run.runStatus === "running", "session_id_acp_renderer_run_not_accepting_commands");
    return run;
  }

  function assertCommandScope(command: Readonly<{ taskId: string; runId: string }>): void {
    invariant(command.taskId === options.task.taskId && command.runId === options.task.runId,
      "session_id_acp_renderer_command_scope_mismatch");
  }

  function nextLaneSequence(owners: SessionIdAcpRendererCommandCapabilities, sessionId: string): number {
    return owners.orchestration.listInboxItems(sessionId)
      .reduce((highest, item) => Math.max(highest, item.sequence), 0) + 1;
  }

  function allocatedId(
    kind: Parameters<SessionIdAcpRendererCommandApplicationOptions["createId"]>[0],
    prefix: string,
  ): string {
    const value = options.createId(kind);
    invariant(typeof value === "string" && new RegExp(`^${prefix}_[A-Za-z0-9_-]+$`, "u").test(value),
      "session_id_acp_renderer_identity_invalid");
    return value;
  }
}

function rendererCommit(
  result: SessionIdAcpRendererCommandResult,
  providerEffectIntentIds: readonly string[],
): SessionIdAcpRendererCommandCommit {
  return Object.freeze({ result, providerEffectIntentIds: Object.freeze([...providerEffectIntentIds]) });
}

function cloneCommit(value: JsonValue): SessionIdAcpRendererCommandCommit {
  invariant(Boolean(value) && typeof value === "object" && !Array.isArray(value),
    "session_id_acp_renderer_receipt_result_invalid");
  const root = value as Record<string, JsonValue>;
  invariant(Object.keys(root).sort().join("|") === "providerEffectIntentIds|result"
    && Array.isArray(root.providerEffectIntentIds)
    && root.providerEffectIntentIds.every((id) => typeof id === "string" && /^provider_effect_[A-Za-z0-9_-]+$/u.test(id)),
  "session_id_acp_renderer_receipt_result_invalid");
  return Object.freeze({
    result: Object.freeze({ ...(root.result as Record<string, JsonValue>) }) as unknown as SessionIdAcpRendererCommandResult,
    providerEffectIntentIds: Object.freeze([...(root.providerEffectIntentIds as string[])]),
  });
}

function sessionMessage(input: Readonly<{
  taskId: string;
  runId: string;
  messageId: string;
  kind: SessionIdSessionMessageRecord["kind"];
  content: string;
  sourceSessionId?: string;
  sourceHumanInterventionId?: string;
  now: string;
}>): SessionIdSessionMessageRecord {
  return Object.freeze({
    messageId: input.messageId,
    taskId: input.taskId,
    runId: input.runId,
    ...(input.sourceSessionId ? { sourceSessionId: input.sourceSessionId } : {}),
    ...(input.sourceHumanInterventionId ? { sourceHumanInterventionId: input.sourceHumanInterventionId } : {}),
    kind: input.kind,
    content: input.content,
    canonicalContent: Object.freeze([{ kind: "text" as const, text: input.content }]),
    contentDigest: hashDefinition(input.content),
    createdAt: input.now,
  });
}

function planningTurnId(runId: string, messageId: string): string {
  return `session_turn_planning_${hashDefinition({ runId, messageId }).replace(/[^A-Za-z0-9_-]/gu, "_")}`;
}

function validateTaskInput(value: unknown): SessionIdAcpTaskInputCommand {
  const root = exactObject(value, [
    "commandId", "taskId", "runId", "expectedRevision", "targetLogicalSessionId", "content",
  ], "task_input_shape_invalid");
  validateCommon(root);
  invariant(typeof root.targetLogicalSessionId === "string"
    && /^logical_session_[A-Za-z0-9_-]+$/u.test(root.targetLogicalSessionId),
  "task_input_conductor_target_required");
  return Object.freeze({
    ...root,
    content: requiredContent(root.content, "task_input_content_required"),
  }) as unknown as SessionIdAcpTaskInputCommand;
}

function validateHumanMessage(value: unknown): SessionIdAcpHumanMessageCommand {
  invariant(Boolean(value) && typeof value === "object" && !Array.isArray(value),
    "human_intervention_input_shape_invalid");
  const source = value as Record<string, unknown>;
  const targetKey = source.targetAgentCardId !== undefined ? "targetAgentCardId" : "targetLogicalSessionId";
  const root = exactObject(value, [
    "commandId", "taskId", "runId", "expectedRevision", targetKey,
    "humanInterventionId", "idempotencyKey", "authenticatedUserId", "content",
  ], "human_intervention_input_shape_invalid");
  validateCommon(root);
  invariant((targetKey === "targetAgentCardId"
    && typeof root.targetAgentCardId === "string" && /^agent_card_[A-Za-z0-9_-]+$/u.test(root.targetAgentCardId))
    || (targetKey === "targetLogicalSessionId" && typeof root.targetLogicalSessionId === "string"
      && /^logical_session_[A-Za-z0-9_-]+$/u.test(root.targetLogicalSessionId)),
  "human_intervention_target_invalid");
  invariant(typeof root.humanInterventionId === "string"
    && /^human_intervention_[A-Za-z0-9_-]+$/u.test(root.humanInterventionId)
    && typeof root.idempotencyKey === "string" && Boolean(root.idempotencyKey.trim())
    && typeof root.authenticatedUserId === "string" && Boolean(root.authenticatedUserId.trim()),
  "human_intervention_identity_invalid");
  return Object.freeze({
    ...root,
    content: requiredContent(root.content, "human_intervention_content_required"),
  }) as unknown as SessionIdAcpHumanMessageCommand;
}

function validateAbandon(value: unknown): SessionIdAcpAbandonHumanMessageCommand {
  const root = exactObject(value, [
    "commandId", "taskId", "runId", "expectedRevision", "humanInterventionId", "idempotencyKey",
    "authenticatedUserId",
  ], "human_intervention_abandon_shape_invalid");
  validateCommon(root);
  invariant(typeof root.humanInterventionId === "string"
    && /^human_intervention_[A-Za-z0-9_-]+$/u.test(root.humanInterventionId)
    && typeof root.idempotencyKey === "string" && Boolean(root.idempotencyKey.trim())
    && typeof root.authenticatedUserId === "string" && Boolean(root.authenticatedUserId.trim()),
  "human_intervention_identity_invalid");
  return Object.freeze({ ...root }) as unknown as SessionIdAcpAbandonHumanMessageCommand;
}

function exactObject(value: unknown, keys: readonly string[], code: string): Record<string, unknown> {
  invariant(Boolean(value) && typeof value === "object" && !Array.isArray(value), code);
  const root = value as Record<string, unknown>;
  invariant(Object.keys(root).sort().join("|") === [...keys].sort().join("|"), code);
  return root;
}

function validateCommon(root: Record<string, unknown>): void {
  invariant(typeof root.commandId === "string" && /^command_[A-Za-z0-9_-]+$/u.test(root.commandId)
    && typeof root.taskId === "string" && /^task_[A-Za-z0-9_-]+$/u.test(root.taskId)
    && typeof root.runId === "string" && /^run_[A-Za-z0-9_-]+$/u.test(root.runId)
    && Number.isInteger(root.expectedRevision) && Number(root.expectedRevision) > 0,
  "session_id_acp_renderer_command_scope_invalid");
}

function requiredContent(value: unknown, code: string): string {
  invariant(typeof value === "string" && Boolean(value.trim()) && value.length <= 262_144, code);
  return value.trim();
}

function validateOptions(options: SessionIdAcpRendererCommandApplicationOptions): void {
  invariant(Boolean(options)
    && typeof options.now === "function"
    && typeof options.createId === "function"
    && typeof options.transaction?.run === "function"
    && typeof options.resolveFrozenProfile === "function"
    && typeof options.interruptBridge?.stageInterrupt === "function",
  "session_id_acp_renderer_options_invalid");
  invariant(/^task_[A-Za-z0-9_-]+$/u.test(options.task.taskId)
    && /^run_[A-Za-z0-9_-]+$/u.test(options.task.runId)
    && /^logical_session_[A-Za-z0-9_-]+$/u.test(options.task.conductorSessionId),
  "session_id_acp_renderer_task_scope_invalid");
}

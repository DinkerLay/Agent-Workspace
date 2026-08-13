import {
  hashDefinition,
  type CardSessionGenerationRecord,
  type CardSessionSlotRecord,
  type ConductorOrchestrationToolResult,
  type ConductorPlanningFenceRecord,
  type JsonValue,
  type MessageReferenceSnapshot,
  type ProviderFamily,
  type SessionControlAuditRecord,
  type SessionExecutionAttemptRecord,
  type SessionExecutionRuntimeRecord,
  type SessionIdMessageForwardRecord,
  type SessionLaneItemRecord,
  type SessionMessageReference,
  type SessionRuntimeProviderEffectIntentRecord,
  type SendToSessionPayload,
} from "@agent-workspace/runtime-contracts";
import {
  invariant,
  materializeCardSessionGeneration,
} from "@agent-workspace/runtime-domain";
import type {
  AcpV3FrozenProfileTupleResolver,
  SessionIdCommandReceiptRecord,
  SessionIdHumanInterventionRecord,
  SessionIdInputSubmissionRecord,
  SessionIdRelayBlockRecord,
  SessionIdSessionMessageRecord,
  SessionIdSessionTurnRecord,
  SessionIdUiCommandReceiptRecord,
} from "@agent-workspace/runtime-store";
import type {
  SessionIdAcpDrainableProviderEffect,
} from "./session-id-acp-orchestration-bridge.js";

export type SessionIdAcpOrchestrationCommandTaskScope = Readonly<{
  taskId: string;
  runId: string;
  conductorSessionId: string;
  initialConductorSessionTurnId: string;
  agentCards: readonly Readonly<{
    agentCardId: string;
    executionProfileId: string;
    profileRevisionId: string;
    providerFamily: ProviderFamily;
  }>[];
}>;

export type SessionIdAcpConductorCommandScope = Readonly<{
  taskId: string;
  runId: string;
  expectedRevision: number;
  conductorSessionId: string;
  conductorSessionTurnId: string;
  commandId: string;
  idempotencyKey: string;
}>;

export type SessionIdAcpInvokeAgentCommand = SessionIdAcpConductorCommandScope & Readonly<{
  agentCardId: string;
}>;

export type SessionIdAcpSendToSessionCommand = SessionIdAcpConductorCommandScope & Readonly<{
  sessionId: string;
  payload: SendToSessionPayload;
}>;

export type SessionIdAcpInterruptSessionCommand = SessionIdAcpConductorCommandScope & Readonly<{
  sessionId: string;
}>;

export type SessionIdAcpCloseSessionCommand = SessionIdAcpConductorCommandScope & Readonly<{
  sessionId: string;
}>;

export type SessionIdAcpConductorCommandCommit = Readonly<{
  /** The only projection returned to the managed Conductor tool call. */
  result: ConductorOrchestrationToolResult;
  /** Host-internal durable drain identities; never part of the tool result. */
  providerEffectIntentIds: readonly string[];
}>;

export type SessionIdAcpHumanInterruptCommand = Readonly<{
  commandId: string;
  taskId: string;
  runId: string;
  expectedRevision: number;
  targetLogicalSessionId: string;
  humanInterventionId: string;
  idempotencyKey: string;
  authenticatedUserId: string;
}>;

export type SessionIdAcpHumanInterruptResult = Readonly<{
  control: Readonly<{
    sessionControlAuditId: string;
    state: "requested";
  }>;
}>;

export type SessionIdAcpHumanInterruptCommit = Readonly<{
  result: SessionIdAcpHumanInterruptResult;
  providerEffectIntentIds: readonly string[];
}>;

export interface SessionIdAcpCommandTaskRunCapability {
  findSlot(runId: string, agentCardId: string): CardSessionSlotRecord | undefined;
  getSlot(cardSessionSlotId: string): CardSessionSlotRecord | undefined;
  getGeneration(logicalSessionId: string): CardSessionGenerationRecord | undefined;
  materializeGeneration(slot: CardSessionSlotRecord, generation: CardSessionGenerationRecord): void;
  retireGeneration(
    slot: CardSessionSlotRecord,
    generation: CardSessionGenerationRecord,
    expectedSlotRevision: number,
  ): void;
  readTaskRunState(taskId: string, runId: string): Readonly<{
    taskId: string;
    runId: string;
    taskRevision: number;
    runStatus: string;
    currentConductorSessionTurnId?: string;
  }>;
  getConductorSessionId(taskId: string, runId: string): string;
  latestPlanningFence(runId: string): ConductorPlanningFenceRecord | undefined;
}

export interface SessionIdAcpCommandMessageCapability {
  createMessage(message: SessionIdSessionMessageRecord): void;
  getMessage(messageId: string): SessionIdSessionMessageRecord | undefined;
  createForward(forward: SessionIdMessageForwardRecord): void;
  getForward(forwardId: string): SessionIdMessageForwardRecord | undefined;
  findForwardByIdempotencyKey(
    taskId: string,
    runId: string,
    idempotencyKey: string,
  ): SessionIdMessageForwardRecord | undefined;
  getRelayBlock(relayBlockId: string): SessionIdRelayBlockRecord | undefined;
}

export interface SessionIdAcpCommandOrchestrationCapability {
  createInboxItem(item: SessionLaneItemRecord): void;
  getInboxItem(inboxItemId: string): SessionLaneItemRecord | undefined;
  listInboxItems(logicalSessionId: string): readonly SessionLaneItemRecord[];
  suppressPendingOrdinary(
    logicalSessionId: string,
    reason: "session_closed" | "task_stopped",
    now: string,
  ): readonly string[];
  getInputSubmission(inputSubmissionId: string): SessionIdInputSubmissionRecord | undefined;
  getTurn(sessionTurnId: string): SessionIdSessionTurnRecord | undefined;
  listTurns(logicalSessionId: string): readonly SessionIdSessionTurnRecord[];
  createControlAudit(control: SessionControlAuditRecord): void;
  getControlAudit(sessionControlAuditId: string): SessionControlAuditRecord | undefined;
  findControlByIdempotencyKey(
    taskId: string,
    runId: string,
    idempotencyKey: string,
  ): SessionControlAuditRecord | undefined;
  listControlAudits(runId: string, logicalSessionId?: string): readonly SessionControlAuditRecord[];
  hasBlockingAttention(logicalSessionId: string): boolean;
}

export interface SessionIdAcpCommandHumanInterventionCapability {
  create(intervention: SessionIdHumanInterventionRecord): void;
  get(humanInterventionId: string): SessionIdHumanInterventionRecord | undefined;
  findByIdempotencyKey(
    taskId: string,
    runId: string,
    idempotencyKey: string,
  ): SessionIdHumanInterventionRecord | undefined;
  list(runId: string, targetLogicalSessionId?: string): readonly SessionIdHumanInterventionRecord[];
}

export interface SessionIdAcpCommandReceiptCapability {
  createCommandReceipt(receipt: SessionIdCommandReceiptRecord): void;
  findCommandReceipt(
    taskId: string,
    runId: string,
    idempotencyKey: string,
  ): SessionIdCommandReceiptRecord | undefined;
  createUiCommandReceipt(receipt: SessionIdUiCommandReceiptRecord): void;
  getUiCommandReceipt(taskId: string, commandId: string): SessionIdUiCommandReceiptRecord | undefined;
}

export interface SessionIdAcpCommandSessionExecutionReadCapability {
  getRuntimeForSession(logicalSessionId: string): SessionExecutionRuntimeRecord | undefined;
  getAttempt(sessionExecutionAttemptId: string): SessionExecutionAttemptRecord | undefined;
}

export interface SessionIdAcpCommandProviderEffectReadCapability {
  listProviderEffectIntents(
    sessionExecutionAttemptId?: string,
  ): readonly SessionRuntimeProviderEffectIntentRecord[];
}

export type SessionIdAcpOrchestrationCommandCapabilities = Readonly<{
  taskRun: SessionIdAcpCommandTaskRunCapability;
  message: SessionIdAcpCommandMessageCapability;
  orchestration: SessionIdAcpCommandOrchestrationCapability;
  humanIntervention: SessionIdAcpCommandHumanInterventionCapability;
  commandReceipts: SessionIdAcpCommandReceiptCapability;
  sessionExecution: SessionIdAcpCommandSessionExecutionReadCapability;
  providerEffects: SessionIdAcpCommandProviderEffectReadCapability;
}>;

/** All injected repositories and the interrupt bridge must share one SQLite outer transaction. */
export interface SessionIdAcpOrchestrationCommandTransaction {
  run<T>(work: (owners: SessionIdAcpOrchestrationCommandCapabilities) => T): T;
}

export type SessionIdAcpOrchestrationCommandApplicationOptions = Readonly<{
  now: () => string;
  createId: (kind: "logical_session" | "message" | "message_forward" | "inbox_item" | "session_control") => string;
  task: SessionIdAcpOrchestrationCommandTaskScope;
  transaction: SessionIdAcpOrchestrationCommandTransaction;
  resolveFrozenProfile: AcpV3FrozenProfileTupleResolver;
  interruptBridge: Readonly<{
    stageInterrupt(input: Readonly<{ sessionControlAuditId: string }>): SessionIdAcpDrainableProviderEffect;
  }>;
  authorizeConductorScope?: (command: SessionIdAcpConductorCommandScope) => boolean;
}>;

type CommandKind = SessionIdCommandReceiptRecord["commandKind"];
type CommandWork = (
  owners: SessionIdAcpOrchestrationCommandCapabilities,
) => SessionIdAcpConductorCommandCommit;

const SAFE_REJECTIONS = new Set([
  "orchestration_agent_card_not_in_architecture",
  "card_session_slot_missing",
  "card_session_slot_current_exists",
  "orchestration_frozen_profile_mismatch",
  "orchestration_scope_run_not_accepting_commands",
  "orchestration_scope_revision_stale",
  "orchestration_scope_turn_not_active",
  "orchestration_scope_turn_stale",
  "orchestration_session_unknown",
  "orchestration_session_scope_mismatch",
  "orchestration_session_not_current",
  "orchestration_session_execution_profile_mismatch",
  "human_intervention_path_active",
  "session_attention_path_active",
  "orchestration_send_payload_empty",
  "orchestration_send_payload_invalid",
  "orchestration_message_reference_duplicate",
  "orchestration_message_reference_scope_mismatch",
  "orchestration_message_reference_not_authorized",
  "orchestration_relay_block_source_mismatch",
  "session_interrupt_active_turn_required",
  "session_interrupt_active_turn_ambiguous",
  "session_interrupt_turn_not_owned_by_conductor",
  "session_interrupt_path_active",
  "session_send_control_unresolved",
  "session_close_retirement_owner_required",
  "session_close_active_or_ambiguous",
  "session_close_lane_not_safe",
  "session_close_control_unresolved",
  "session_close_interaction_unresolved",
  "session_close_provider_outcome_unresolved",
] as const);

export function createSessionIdAcpOrchestrationCommandApplication(
  options: SessionIdAcpOrchestrationCommandApplicationOptions,
) {
  validateOptions(options);
  const task = Object.freeze({
    ...options.task,
    agentCards: Object.freeze(options.task.agentCards.map((card) => Object.freeze({ ...card }))),
  });

  return Object.freeze({
    invokeAgent,
    sendToSession,
    interruptSession,
    closeSession,
    requestHumanInterrupt,
    enqueueTaskGoal,
  });

  function invokeAgent(command: SessionIdAcpInvokeAgentCommand): SessionIdAcpConductorCommandCommit {
    const card = requiredAgentCard(command.agentCardId);
    return executeConductorCommand(
      "invoke_agent",
      command,
      { agentCardId: command.agentCardId },
      (owners) => {
        const previous = owners.taskRun.findSlot(task.runId, card.agentCardId);
        invariant(Boolean(previous)
          && previous!.taskId === task.taskId
          && previous!.runId === task.runId
          && previous!.agentCardId === card.agentCardId,
        "card_session_slot_missing");
        invariant(!previous!.currentSessionId, "card_session_slot_current_exists");
        const now = options.now();
        const sessionId = allocatedId("logical_session", "logical_session");
        const materialized = materializeCardSessionGeneration({
          slot: previous,
          taskId: task.taskId,
          runId: task.runId,
          agentCardId: card.agentCardId,
          executionProfileId: card.executionProfileId,
          cardSessionSlotId: previous!.cardSessionSlotId,
          sessionId,
          now,
        });
        owners.taskRun.materializeGeneration(materialized.slot, materialized.generation);
        const resolved = options.resolveFrozenProfile({
          taskId: task.taskId,
          runId: task.runId,
          logicalSessionId: sessionId,
          executionProfileId: card.executionProfileId,
        });
        invariant(Boolean(resolved)
          && resolved!.schemaVersion === 3
          && resolved!.executionProfileId === card.executionProfileId
          && resolved!.profileRevisionId === card.profileRevisionId
          && resolved!.providerFamily === card.providerFamily,
        "orchestration_frozen_profile_mismatch");
        return commandCommit(Object.freeze({ sessionId }), []);
      },
    );
  }

  function sendToSession(command: SessionIdAcpSendToSessionCommand): SessionIdAcpConductorCommandCommit {
    return executeConductorCommand(
      "send_to_session",
      command,
      {
        sessionId: command.sessionId,
        payload: payloadJson(command.payload),
      },
      (owners) => {
        requireCurrentSession(owners, command.runId, command.sessionId);
        assertNoBlockingHuman(owners, command.sessionId);
        invariant(!owners.orchestration.hasBlockingAttention(command.sessionId),
          "session_attention_path_active");
        assertNoUnresolvedControl(owners, command.sessionId, "session_send_control_unresolved");
        invariant(!owners.message.findForwardByIdempotencyKey(task.taskId, task.runId, command.idempotencyKey),
          "orchestration_command_receipt_missing");
        const rendered = renderPayload(owners, command.payload);
        const now = options.now();
        const messageId = allocatedId("message", "message");
        const forwardId = allocatedId("message_forward", "message_forward");
        const inboxItemId = allocatedId("inbox_item", "inbox");
        const sequence = nextLaneSequence(owners, command.sessionId);
        const message: SessionIdSessionMessageRecord = Object.freeze({
          messageId,
          taskId: task.taskId,
          runId: task.runId,
          sourceSessionTurnId: command.conductorSessionTurnId,
          kind: "conductor_forward",
          content: rendered.content,
          canonicalContent: Object.freeze([{ kind: "text" as const, text: rendered.content }]),
          contentDigest: hashDefinition(rendered.content),
          createdAt: now,
        });
        const forward: SessionIdMessageForwardRecord = Object.freeze({
          forwardId,
          taskId: task.taskId,
          runId: task.runId,
          commandId: command.commandId,
          idempotencyKey: command.idempotencyKey,
          decidedBySessionTurnId: command.conductorSessionTurnId,
          targetSessionId: command.sessionId,
          ...(rendered.newContent ? { newContentDigest: hashDefinition(rendered.newContent) } : {}),
          orderedReferenceSnapshots: rendered.references,
          renderedMessageId: messageId,
          createdAt: now,
        });
        const inbox: SessionLaneItemRecord = Object.freeze({
          inboxItemId,
          taskId: task.taskId,
          runId: task.runId,
          sessionId: command.sessionId,
          renderedMessageId: messageId,
          sequence,
          priority: "ordinary",
          state: "pending",
          forwardId,
          createdAt: now,
          updatedAt: now,
        });
        owners.message.createMessage(message);
        owners.message.createForward(forward);
        owners.orchestration.createInboxItem(inbox);
        return commandCommit(Object.freeze({ status: "accepted" as const }), []);
      },
    );
  }

  function interruptSession(command: SessionIdAcpInterruptSessionCommand): SessionIdAcpConductorCommandCommit {
    return executeConductorCommand(
      "interrupt_session",
      command,
      { sessionId: command.sessionId },
      (owners) => {
        requireCurrentSession(owners, command.runId, command.sessionId);
        assertNoBlockingHuman(owners, command.sessionId);
        invariant(!owners.orchestration.hasBlockingAttention(command.sessionId),
          "session_attention_path_active");
        const turn = requireSingleActiveTurn(owners, command.sessionId);
        invariant(isTrustedConductorDelivery(owners, turn),
          "session_interrupt_turn_not_owned_by_conductor");
        assertNoUnresolvedControl(owners, command.sessionId, "session_interrupt_path_active");
        invariant(!owners.orchestration.findControlByIdempotencyKey(
          task.taskId,
          task.runId,
          command.idempotencyKey,
        ), "orchestration_command_receipt_missing");
        const control = createControl(command, command.sessionId, "conductor_interrupt");
        owners.orchestration.createControlAudit(control);
        const staged = options.interruptBridge.stageInterrupt({
          sessionControlAuditId: control.sessionControlAuditId,
        });
        assertInterruptDrain(owners, staged, control, turn);
        return commandCommit(
          Object.freeze({ status: "accepted" as const }),
          [staged.providerEffectIntentId],
        );
      },
    );
  }

  function closeSession(command: SessionIdAcpCloseSessionCommand): SessionIdAcpConductorCommandCommit {
    return executeConductorCommand(
      "close_session",
      command,
      { sessionId: command.sessionId },
      () => {
        // ACP close is deliberately owned by the two-phase close-session owner.
        // Keeping this old synchronous seam fail-closed prevents a production
        // caller from returning `closed` before native Binding cleanup commits.
        throw new Error("session_close_retirement_owner_required");
      },
    );
  }

  function requestHumanInterrupt(
    command: SessionIdAcpHumanInterruptCommand,
  ): SessionIdAcpHumanInterruptCommit {
    assertHumanCommandBoundary(command);
    const fingerprint = hashDefinition({
      kind: "session.request_interrupt",
      commandId: command.commandId,
      taskId: command.taskId,
      runId: command.runId,
      expectedRevision: command.expectedRevision,
      targetLogicalSessionId: command.targetLogicalSessionId,
      humanInterventionId: command.humanInterventionId,
      idempotencyKey: command.idempotencyKey,
      authenticatedUserId: command.authenticatedUserId,
    });
    return options.transaction.run((owners) => {
      const receipt = owners.commandReceipts.getUiCommandReceipt(task.taskId, command.commandId);
      if (receipt) return replayHumanInterrupt(owners, receipt, command, fingerprint);
      const live = assertTaskRunScope(owners, command.expectedRevision);
      invariant(live.runStatus === "running", "orchestration_scope_run_not_accepting_commands");
      requireCurrentSession(owners, command.runId, command.targetLogicalSessionId);
      invariant(!owners.humanIntervention.findByIdempotencyKey(
        task.taskId,
        task.runId,
        command.idempotencyKey,
      ), "session_interrupt_idempotency_conflict");
      invariant(!owners.humanIntervention.list(task.runId, command.targetLogicalSessionId)
        .some((item) => item.state === "held"),
      "human_intervention_path_active");
      invariant(!owners.orchestration.hasBlockingAttention(command.targetLogicalSessionId),
        "session_attention_path_active");
      const turn = requireSingleActiveTurn(owners, command.targetLogicalSessionId);
      assertNoUnresolvedControl(owners, command.targetLogicalSessionId, "session_interrupt_path_active");
      const now = options.now();
      const control: SessionControlAuditRecord = Object.freeze({
        sessionControlAuditId: allocatedId("session_control", "session_control"),
        taskId: task.taskId,
        runId: task.runId,
        sessionId: command.targetLogicalSessionId,
        commandId: command.commandId,
        idempotencyKey: command.idempotencyKey,
        kind: "human_interrupt",
        state: "requested",
        affectedInboxItemIds: Object.freeze([]),
        requestedAt: now,
      });
      const intervention: SessionIdHumanInterventionRecord = Object.freeze({
        humanInterventionId: command.humanInterventionId,
        taskId: task.taskId,
        runId: task.runId,
        commandId: command.commandId,
        idempotencyKey: command.idempotencyKey,
        targetSessionId: command.targetLogicalSessionId,
        mode: "scoped_interrupt",
        state: "accepted",
        affectedSessionTurnId: turn.sessionTurnId,
        authenticatedUserId: command.authenticatedUserId,
        createdAt: now,
        updatedAt: now,
      });
      owners.humanIntervention.create(intervention);
      owners.orchestration.createControlAudit(control);
      const staged = options.interruptBridge.stageInterrupt({
        sessionControlAuditId: control.sessionControlAuditId,
      });
      assertInterruptDrain(owners, staged, control, turn);
      const result: SessionIdAcpHumanInterruptResult = Object.freeze({
        control: Object.freeze({
          sessionControlAuditId: control.sessionControlAuditId,
          state: "requested" as const,
        }),
      });
      owners.commandReceipts.createUiCommandReceipt(Object.freeze({
        commandId: command.commandId,
        taskId: task.taskId,
        runId: task.runId,
        commandKind: "session.request_interrupt",
        idempotencyKey: command.idempotencyKey,
        payloadFingerprint: fingerprint,
        result: result as unknown as JsonValue,
        createdAt: now,
      }));
      return humanInterruptCommit(result, staged.providerEffectIntentId);
    });
  }

  function enqueueTaskGoal(input: Readonly<{ messageId: string; content: string }>): Readonly<{
    status: "enqueued";
  }> {
    const messageId = prefixedId(input?.messageId, "message", "task_goal_message_id_invalid");
    const content = requiredContent(input?.content, "task_goal_content_required");
    return options.transaction.run((owners) => {
      const live = assertTaskRunScope(owners);
      invariant(live.runStatus === "starting" || live.runStatus === "running",
        "task_goal_run_not_accepting");
      const existing = owners.message.getMessage(messageId);
      if (existing) {
        invariant(existing.taskId === task.taskId
          && existing.runId === task.runId
          && existing.kind === "task_goal"
          && existing.contentDigest === hashDefinition(content),
        "task_goal_replay_conflict");
        invariant(owners.orchestration.listInboxItems(task.conductorSessionId)
          .some((item) => item.renderedMessageId === messageId),
        "task_goal_inbox_missing");
        return Object.freeze({ status: "enqueued" as const });
      }
      invariant(owners.orchestration.listInboxItems(task.conductorSessionId).length === 0,
        "task_goal_must_be_first_conductor_input");
      const now = options.now();
      owners.message.createMessage(Object.freeze({
        messageId,
        taskId: task.taskId,
        runId: task.runId,
        kind: "task_goal",
        content,
        canonicalContent: Object.freeze([{ kind: "text" as const, text: content }]),
        contentDigest: hashDefinition(content),
        createdAt: now,
      }));
      owners.orchestration.createInboxItem(Object.freeze({
        inboxItemId: allocatedId("inbox_item", "inbox"),
        taskId: task.taskId,
        runId: task.runId,
        sessionId: task.conductorSessionId,
        renderedMessageId: messageId,
        sequence: 1,
        priority: "human",
        state: "pending",
        createdAt: now,
        updatedAt: now,
      }));
      return Object.freeze({ status: "enqueued" as const });
    });
  }

  function executeConductorCommand(
    kind: CommandKind,
    command: SessionIdAcpConductorCommandScope,
    semantic: JsonValue,
    work: CommandWork,
  ): SessionIdAcpConductorCommandCommit {
    assertConductorCommandBoundary(command);
    const fingerprint = commandFingerprint(kind, command, semantic);
    try {
      return options.transaction.run((owners) => {
        const replay = replayConductorCommand(owners, kind, command, fingerprint);
        if (replay) return replay;
        assertConductorScope(owners, command);
        const committed = work(owners);
        owners.commandReceipts.createCommandReceipt(commandReceipt(
          kind,
          command,
          fingerprint,
          committed.result,
          options.now(),
        ));
        return committed;
      });
    } catch (error) {
      const reason = safeRejection(error);
      if (!reason) throw error;
      return options.transaction.run((owners) => {
        const replay = replayConductorCommand(owners, kind, command, fingerprint);
        if (replay) return replay;
        const result = Object.freeze({ status: "rejected" as const, reason });
        owners.commandReceipts.createCommandReceipt(commandReceipt(
          kind,
          command,
          fingerprint,
          result,
          options.now(),
        ));
        return commandCommit(result, []);
      });
    }
  }

  function replayConductorCommand(
    owners: SessionIdAcpOrchestrationCommandCapabilities,
    kind: CommandKind,
    command: SessionIdAcpConductorCommandScope,
    fingerprint: string,
  ): SessionIdAcpConductorCommandCommit | undefined {
    const receipt = owners.commandReceipts.findCommandReceipt(
      task.taskId,
      task.runId,
      command.idempotencyKey,
    );
    if (!receipt) return undefined;
    invariant(receipt.commandId === command.commandId
      && receipt.commandKind === kind
      && receipt.payloadFingerprint === fingerprint,
    "orchestration_idempotency_payload_conflict");
    const result = validateStoredConductorResult(kind, receipt.result);
    if (kind !== "interrupt_session" || !("status" in result) || result.status !== "accepted") {
      return commandCommit(result, []);
    }
    const control = owners.orchestration.findControlByIdempotencyKey(
      task.taskId,
      task.runId,
      command.idempotencyKey,
    );
    invariant(Boolean(control)
      && control!.commandId === command.commandId
      && control!.kind === "conductor_interrupt",
    "orchestration_interrupt_replay_control_missing");
    const intent = requireInterruptIntent(owners, control!);
    return commandCommit(result, [intent.providerEffectIntentId]);
  }

  function assertConductorScope(
    owners: SessionIdAcpOrchestrationCommandCapabilities,
    command: SessionIdAcpConductorCommandScope,
  ): void {
    const live = assertTaskRunScope(owners, command.expectedRevision);
    invariant(live.runStatus === "running", "orchestration_scope_run_not_accepting_commands");
    invariant(command.conductorSessionId === task.conductorSessionId
      && owners.taskRun.getConductorSessionId(task.taskId, task.runId) === task.conductorSessionId,
    "orchestration_scope_conductor_session_mismatch");
    invariant(live.currentConductorSessionTurnId === command.conductorSessionTurnId,
      "orchestration_scope_turn_stale");
    const persistedTurn = owners.orchestration.getTurn(command.conductorSessionTurnId);
    invariant(Boolean(persistedTurn)
      && persistedTurn!.taskId === task.taskId
      && persistedTurn!.runId === task.runId
      && persistedTurn!.sessionId === task.conductorSessionId
      && persistedTurn!.state === "active",
    "orchestration_scope_turn_not_active");
    const latestFence = owners.taskRun.latestPlanningFence(task.runId);
    invariant(latestFence?.previousConductorSessionTurnId !== command.conductorSessionTurnId,
      "orchestration_scope_turn_stale");
    if (options.authorizeConductorScope) {
      invariant(options.authorizeConductorScope(command), "orchestration_scope_turn_stale");
    }
  }

  function assertTaskRunScope(
    owners: SessionIdAcpOrchestrationCommandCapabilities,
    expectedRevision?: number,
  ) {
    const live = owners.taskRun.readTaskRunState(task.taskId, task.runId);
    invariant(live.taskId === task.taskId && live.runId === task.runId,
      "orchestration_scope_run_mismatch");
    if (expectedRevision !== undefined) {
      invariant(live.taskRevision === expectedRevision, "orchestration_scope_revision_stale");
    }
    invariant(owners.taskRun.getConductorSessionId(task.taskId, task.runId) === task.conductorSessionId,
      "orchestration_scope_conductor_session_mismatch");
    return live;
  }

  function requiredAgentCard(agentCardId: string) {
    const card = task.agentCards.find((candidate) => candidate.agentCardId === agentCardId);
    invariant(Boolean(card), "orchestration_agent_card_not_in_architecture");
    return card!;
  }

  function requireCurrentSession(
    owners: SessionIdAcpOrchestrationCommandCapabilities,
    runId: string,
    logicalSessionId: string,
  ): CardSessionGenerationRecord {
    const generation = owners.taskRun.getGeneration(logicalSessionId);
    invariant(Boolean(generation), "orchestration_session_unknown");
    invariant(generation!.taskId === task.taskId && generation!.runId === runId,
      "orchestration_session_scope_mismatch");
    invariant(generation!.sessionId === logicalSessionId
      && generation!.lifecycle === "current"
      && generation!.closedAt === undefined,
    "orchestration_session_not_current");
    const slot = owners.taskRun.getSlot(generation!.cardSessionSlotId);
    invariant(Boolean(slot)
      && slot!.taskId === generation!.taskId
      && slot!.runId === generation!.runId
      && slot!.agentCardId === generation!.agentCardId
      && slot!.currentSessionId === logicalSessionId
      && slot!.latestGeneration === generation!.generation,
    "orchestration_session_not_current");
    const card = requiredAgentCard(generation!.agentCardId);
    invariant(generation!.executionProfileId === card.executionProfileId,
      "orchestration_session_execution_profile_mismatch");
    return generation!;
  }

  function renderPayload(
    owners: SessionIdAcpOrchestrationCommandCapabilities,
    payload: SendToSessionPayload,
  ): Readonly<{
    content: string;
    newContent?: string;
    references: readonly MessageReferenceSnapshot[];
  }> {
    invariant(Boolean(payload) && typeof payload === "object" && !Array.isArray(payload),
      "orchestration_send_payload_invalid");
    const newContent = typeof payload.content === "string" && payload.content.trim()
      ? payload.content
      : undefined;
    invariant(payload.messageRefs === undefined || Array.isArray(payload.messageRefs),
      "orchestration_send_payload_invalid");
    const references = payload.messageRefs ?? [];
    invariant(Boolean(newContent) || references.length > 0, "orchestration_send_payload_empty");
    invariant(new Set(references.map(referenceIdentity)).size === references.length,
      "orchestration_message_reference_duplicate");
    const rendered = newContent ? [newContent] : [];
    const snapshots = references.map((reference, ordinal) => {
      const source = owners.message.getMessage(reference.sourceMessageId);
      invariant(Boolean(source)
        && source!.taskId === task.taskId
        && source!.runId === task.runId,
      "orchestration_message_reference_scope_mismatch");
      invariant(owners.orchestration.listInboxItems(task.conductorSessionId).some((item) =>
        item.renderedMessageId === source!.messageId
          && (item.state === "handed" || item.state === "handled")),
      "orchestration_message_reference_not_authorized");
      if (reference.kind === "full_message") {
        rendered.push(
          `[完整消息 ${reference.sourceMessageId}]\n${source!.content}\n[完整消息结束 ${reference.sourceMessageId}]`,
        );
        return Object.freeze({
          ordinal,
          kind: "full_message" as const,
          sourceMessageId: reference.sourceMessageId,
          contentDigest: source!.contentDigest,
        });
      }
      const relay = owners.message.getRelayBlock(reference.relayBlockId);
      invariant(Boolean(relay) && relay!.sourceMessageId === reference.sourceMessageId,
        "orchestration_relay_block_source_mismatch");
      rendered.push(
        `[转递块 ${reference.relayBlockId}；来源 ${reference.sourceMessageId}]\n${relay!.content}\n[转递块结束 ${reference.relayBlockId}]`,
      );
      return Object.freeze({
        ordinal,
        kind: "relay_block" as const,
        sourceMessageId: reference.sourceMessageId,
        relayBlockId: reference.relayBlockId,
        contentDigest: relay!.contentDigest,
      });
    });
    return Object.freeze({
      content: rendered.join("\n\n"),
      ...(newContent ? { newContent } : {}),
      references: Object.freeze(snapshots),
    });
  }

  function createControl(
    command: SessionIdAcpInterruptSessionCommand,
    logicalSessionId: string,
    kind: "conductor_interrupt",
  ): SessionControlAuditRecord {
    return Object.freeze({
      sessionControlAuditId: allocatedId("session_control", "session_control"),
      taskId: task.taskId,
      runId: task.runId,
      sessionId: logicalSessionId,
      commandId: command.commandId,
      idempotencyKey: command.idempotencyKey,
      kind,
      state: "requested",
      affectedInboxItemIds: Object.freeze([]),
      requestedAt: options.now(),
    });
  }

  function requireSingleActiveTurn(
    owners: SessionIdAcpOrchestrationCommandCapabilities,
    logicalSessionId: string,
  ): SessionIdSessionTurnRecord {
    const active = owners.orchestration.listTurns(logicalSessionId)
      .filter((turn) => turn.state === "active");
    invariant(active.length > 0, "session_interrupt_active_turn_required");
    invariant(active.length === 1, "session_interrupt_active_turn_ambiguous");
    return active[0]!;
  }

  function isTrustedConductorDelivery(
    owners: SessionIdAcpOrchestrationCommandCapabilities,
    turn: SessionIdSessionTurnRecord,
  ): boolean {
    if (turn.trigger !== "conductor_send" || !turn.sourceConductorSessionTurnId) return false;
    const input = owners.orchestration.getInputSubmission(turn.inputSubmissionId);
    const inbox = input ? owners.orchestration.getInboxItem(input.sourceInboxItemId) : undefined;
    const forward = inbox?.forwardId ? owners.message.getForward(inbox.forwardId) : undefined;
    return Boolean(input && inbox && forward
      && input.taskId === task.taskId
      && input.runId === task.runId
      && input.sessionId === turn.sessionId
      && input.state === "accepted"
      && inbox.state === "handed"
      && forward.targetSessionId === turn.sessionId
      && forward.renderedMessageId === input.contentMessageId
      && forward.decidedBySessionTurnId === turn.sourceConductorSessionTurnId);
  }

  function assertNoBlockingHuman(
    owners: SessionIdAcpOrchestrationCommandCapabilities,
    logicalSessionId: string,
  ): void {
    invariant(!owners.humanIntervention.list(task.runId, logicalSessionId).some((intervention) =>
      intervention.state === "accepted"
        || intervention.state === "held"
        || intervention.state === "delivered"),
    "human_intervention_path_active");
  }

  function assertNoUnresolvedControl(
    owners: SessionIdAcpOrchestrationCommandCapabilities,
    logicalSessionId: string,
    code: string,
  ): void {
    invariant(!owners.orchestration.listControlAudits(task.runId, logicalSessionId).some((control) =>
      control.state === "requested" || control.state === "accepted" || control.state === "unknown"),
    code);
  }

  function assertInterruptDrain(
    owners: SessionIdAcpOrchestrationCommandCapabilities,
    staged: SessionIdAcpDrainableProviderEffect,
    control: SessionControlAuditRecord,
    turn: SessionIdSessionTurnRecord,
  ): void {
    invariant(staged.commandType === "session_runtime.request_interrupt"
      && /^provider_effect_[A-Za-z0-9_-]+$/u.test(staged.providerEffectIntentId)
      && /^session_execution_runtime_[A-Za-z0-9_-]+$/u.test(staged.sessionExecutionRuntimeId)
      && /^session_execution_attempt_[A-Za-z0-9_-]+$/u.test(staged.sessionExecutionAttemptId),
    "session_id_acp_interrupt_drain_scope_invalid");
    const intent = owners.providerEffects.listProviderEffectIntents(staged.sessionExecutionAttemptId)
      .filter((candidate) => candidate.providerEffectIntentId === staged.providerEffectIntentId);
    invariant(intent.length === 1
      && intent[0]!.commandType === "session_runtime.request_interrupt"
      && intent[0]!.effect.kind === "request_interrupt"
      && intent[0]!.taskId === task.taskId
      && intent[0]!.runId === task.runId
      && intent[0]!.logicalSessionId === control.sessionId
      && intent[0]!.sessionControlAuditId === control.sessionControlAuditId
      && intent[0]!.orchestrationSessionTurnId === turn.sessionTurnId
      && intent[0]!.sessionExecutionRuntimeId === staged.sessionExecutionRuntimeId
      && intent[0]!.sessionExecutionAttemptId === staged.sessionExecutionAttemptId,
    "session_id_acp_interrupt_drain_scope_invalid");
  }

  function requireInterruptIntent(
    owners: SessionIdAcpOrchestrationCommandCapabilities,
    control: SessionControlAuditRecord,
  ): SessionRuntimeProviderEffectIntentRecord {
    const candidates = owners.providerEffects.listProviderEffectIntents()
      .filter((intent) => intent.commandType === "session_runtime.request_interrupt"
        && intent.effect.kind === "request_interrupt"
        && intent.sessionControlAuditId === control.sessionControlAuditId
        && intent.taskId === task.taskId
        && intent.runId === task.runId
        && intent.logicalSessionId === control.sessionId);
    invariant(candidates.length === 1, "orchestration_interrupt_replay_effect_ambiguous");
    return candidates[0]!;
  }

  function replayHumanInterrupt(
    owners: SessionIdAcpOrchestrationCommandCapabilities,
    receipt: SessionIdUiCommandReceiptRecord,
    command: SessionIdAcpHumanInterruptCommand,
    fingerprint: string,
  ): SessionIdAcpHumanInterruptCommit {
    invariant(receipt.runId === task.runId
      && receipt.commandKind === "session.request_interrupt"
      && receipt.idempotencyKey === command.idempotencyKey
      && receipt.payloadFingerprint === fingerprint,
    "session_interrupt_idempotency_conflict");
    const result = validateStoredHumanInterruptResult(receipt.result);
    const control = owners.orchestration.getControlAudit(result.control.sessionControlAuditId);
    invariant(Boolean(control)
      && control!.commandId === command.commandId
      && control!.idempotencyKey === command.idempotencyKey
      && control!.kind === "human_interrupt",
    "session_interrupt_replay_control_missing");
    const intent = requireInterruptIntent(owners, control!);
    return humanInterruptCommit(result, intent.providerEffectIntentId);
  }

  function nextLaneSequence(
    owners: SessionIdAcpOrchestrationCommandCapabilities,
    logicalSessionId: string,
  ): number {
    return owners.orchestration.listInboxItems(logicalSessionId)
      .reduce((maximum, item) => Math.max(maximum, item.sequence), 0) + 1;
  }

  function allocatedId(
    kind: Parameters<SessionIdAcpOrchestrationCommandApplicationOptions["createId"]>[0],
    prefix: string,
  ): string {
    return prefixedId(options.createId(kind), prefix, `orchestration_${kind}_id_invalid`);
  }
}

function validateOptions(options: SessionIdAcpOrchestrationCommandApplicationOptions): void {
  invariant(Boolean(options)
    && typeof options.now === "function"
    && typeof options.createId === "function"
    && typeof options.transaction?.run === "function"
    && typeof options.resolveFrozenProfile === "function"
    && typeof options.interruptBridge?.stageInterrupt === "function",
  "session_id_acp_command_application_options_invalid");
  prefixedId(options.task.taskId, "task", "session_id_acp_command_task_scope_invalid");
  prefixedId(options.task.runId, "run", "session_id_acp_command_task_scope_invalid");
  prefixedId(options.task.conductorSessionId, "logical_session", "session_id_acp_command_task_scope_invalid");
  prefixedId(options.task.initialConductorSessionTurnId, "session_turn", "session_id_acp_command_task_scope_invalid");
  invariant(Array.isArray(options.task.agentCards) && options.task.agentCards.length > 0,
    "session_id_acp_command_task_scope_invalid");
  for (const card of options.task.agentCards) {
    prefixedId(card.agentCardId, "agent_card", "session_id_acp_command_task_scope_invalid");
    prefixedId(card.executionProfileId, "profile", "session_id_acp_command_task_scope_invalid");
    prefixedId(card.profileRevisionId, "profile_revision", "session_id_acp_command_task_scope_invalid");
    invariant(card.providerFamily === "opencode"
      || card.providerFamily === "codex"
      || card.providerFamily === "claude-code",
    "session_id_acp_command_task_scope_invalid");
  }
}

function assertConductorCommandBoundary(command: SessionIdAcpConductorCommandScope): void {
  invariant(Boolean(command) && typeof command === "object" && !Array.isArray(command),
    "orchestration_command_invalid");
  prefixedId(command.taskId, "task", "orchestration_scope_task_mismatch");
  prefixedId(command.runId, "run", "orchestration_scope_run_mismatch");
  prefixedId(command.conductorSessionId, "logical_session", "orchestration_scope_conductor_session_mismatch");
  prefixedId(command.conductorSessionTurnId, "session_turn", "orchestration_scope_turn_not_active");
  prefixedId(command.commandId, "command", "orchestration_command_id_required");
  invariant(Number.isSafeInteger(command.expectedRevision) && command.expectedRevision > 0,
    "orchestration_scope_revision_invalid");
  invariant(typeof command.idempotencyKey === "string" && Boolean(command.idempotencyKey.trim()),
    "orchestration_idempotency_key_required");
}

function assertHumanCommandBoundary(command: SessionIdAcpHumanInterruptCommand): void {
  invariant(Boolean(command) && typeof command === "object" && !Array.isArray(command),
    "session_interrupt_command_invalid");
  prefixedId(command.taskId, "task", "orchestration_scope_task_mismatch");
  prefixedId(command.runId, "run", "orchestration_scope_run_mismatch");
  prefixedId(command.commandId, "command", "orchestration_command_id_required");
  prefixedId(command.targetLogicalSessionId, "logical_session", "orchestration_session_unknown");
  prefixedId(command.humanInterventionId, "human_intervention", "human_intervention_id_invalid");
  invariant(Number.isSafeInteger(command.expectedRevision) && command.expectedRevision > 0,
    "orchestration_scope_revision_invalid");
  invariant(typeof command.idempotencyKey === "string" && Boolean(command.idempotencyKey.trim()),
    "orchestration_idempotency_key_required");
  invariant(typeof command.authenticatedUserId === "string" && Boolean(command.authenticatedUserId.trim()),
    "authenticated_user_required");
}

function commandFingerprint(
  kind: CommandKind,
  command: SessionIdAcpConductorCommandScope,
  semantic: JsonValue,
): string {
  return hashDefinition({
    kind,
    taskId: command.taskId,
    runId: command.runId,
    expectedRevision: command.expectedRevision,
    conductorSessionId: command.conductorSessionId,
    conductorSessionTurnId: command.conductorSessionTurnId,
    commandId: command.commandId,
    semantic,
  });
}

function commandReceipt(
  commandKind: CommandKind,
  command: SessionIdAcpConductorCommandScope,
  payloadFingerprint: string,
  result: ConductorOrchestrationToolResult,
  createdAt: string,
): SessionIdCommandReceiptRecord {
  return Object.freeze({
    commandId: command.commandId,
    taskId: command.taskId,
    runId: command.runId,
    commandKind,
    idempotencyKey: command.idempotencyKey,
    payloadFingerprint,
    result: result as JsonValue,
    createdAt,
  });
}

function commandCommit(
  result: ConductorOrchestrationToolResult,
  providerEffectIntentIds: readonly string[],
): SessionIdAcpConductorCommandCommit {
  return Object.freeze({
    result: Object.freeze({ ...result }),
    providerEffectIntentIds: Object.freeze([...providerEffectIntentIds]),
  });
}

function humanInterruptCommit(
  result: SessionIdAcpHumanInterruptResult,
  providerEffectIntentId: string,
): SessionIdAcpHumanInterruptCommit {
  return Object.freeze({
    result: Object.freeze({
      control: Object.freeze({ ...result.control }),
    }),
    providerEffectIntentIds: Object.freeze([providerEffectIntentId]),
  });
}

function validateStoredConductorResult(
  kind: CommandKind,
  value: JsonValue,
): ConductorOrchestrationToolResult {
  invariant(Boolean(value) && typeof value === "object" && !Array.isArray(value),
    "orchestration_command_receipt_result_invalid");
  const result = value as Record<string, JsonValue>;
  if (result.status === "rejected") {
    invariant(Object.keys(result).length === 2
      && typeof result.reason === "string"
      && Boolean(result.reason),
    "orchestration_command_receipt_result_invalid");
    return Object.freeze({ status: "rejected", reason: result.reason });
  }
  if (kind === "invoke_agent") {
    invariant(Object.keys(result).length === 1 && typeof result.sessionId === "string",
      "orchestration_command_receipt_result_invalid");
    return Object.freeze({ sessionId: result.sessionId });
  }
  const status = kind === "close_session" ? "closed" : "accepted";
  invariant(Object.keys(result).length === 1 && result.status === status,
    "orchestration_command_receipt_result_invalid");
  return Object.freeze({ status });
}

function validateStoredHumanInterruptResult(value: JsonValue): SessionIdAcpHumanInterruptResult {
  invariant(Boolean(value) && typeof value === "object" && !Array.isArray(value),
    "session_interrupt_receipt_result_invalid");
  const root = value as Record<string, JsonValue>;
  invariant(Object.keys(root).length === 1
    && Boolean(root.control)
    && typeof root.control === "object"
    && !Array.isArray(root.control),
  "session_interrupt_receipt_result_invalid");
  const control = root.control as Record<string, JsonValue>;
  invariant(Object.keys(control).length === 2
    && typeof control.sessionControlAuditId === "string"
    && control.state === "requested",
  "session_interrupt_receipt_result_invalid");
  return Object.freeze({
    control: Object.freeze({
      sessionControlAuditId: control.sessionControlAuditId,
      state: "requested",
    }),
  });
}

function safeRejection(error: unknown): string | undefined {
  const code = error instanceof Error ? error.message : undefined;
  return code && SAFE_REJECTIONS.has(code as never) ? code : undefined;
}

function payloadJson(payload: SendToSessionPayload): JsonValue {
  return {
    ...(payload.content === undefined ? {} : { content: payload.content }),
    ...(payload.messageRefs === undefined ? {} : {
      messageRefs: payload.messageRefs.map((reference) => ({
        kind: reference.kind,
        sourceMessageId: reference.sourceMessageId,
        ...(reference.kind === "relay_block" ? { relayBlockId: reference.relayBlockId } : {}),
      })),
    }),
  };
}

function referenceIdentity(reference: SessionMessageReference): string {
  return reference.kind === "full_message"
    ? `message:${reference.sourceMessageId}`
    : `relay:${reference.sourceMessageId}:${reference.relayBlockId}`;
}

function prefixedId(value: unknown, prefix: string, code: string): string {
  invariant(typeof value === "string"
    && value.length <= 256
    && new RegExp(`^${prefix}_[A-Za-z0-9_-]+$`, "u").test(value),
  code);
  return value;
}

function requiredContent(value: unknown, code: string): string {
  invariant(typeof value === "string" && Boolean(value.trim()), code);
  return value;
}

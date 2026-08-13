import {
  cloneAcpSafeSessionBindingRecordV3,
  cloneAcpV3BindingRetirementIntentRecord,
  hashDefinition,
  type AcpSafeSessionBindingRecordV3,
  type AcpV3BindingRetirementIntentRecord,
  type CardSessionGenerationRecord,
  type CardSessionSlotRecord,
  type ConductorOrchestrationToolResult,
  type ConductorPlanningFenceRecord,
  type JsonValue,
  type ProviderFamily,
  type SessionControlAuditRecord,
  type SessionExecutionAttemptRecord,
  type SessionExecutionRuntimeRecord,
  type SessionLaneItemRecord,
} from "@agent-workspace/runtime-contracts";
import { invariant, retireCardSessionGeneration } from "@agent-workspace/runtime-domain";
import type {
  AcpV3FrozenProfileTupleResolver,
  SessionIdCommandReceiptRecord,
  SessionIdHumanInterventionRecord,
  SessionIdSessionTurnRecord,
} from "@agent-workspace/runtime-store";

export type SessionIdAcpCloseSessionOwnerCommand = Readonly<{
  taskId: string;
  runId: string;
  expectedRevision: number;
  conductorSessionId: string;
  conductorSessionTurnId: string;
  commandId: string;
  idempotencyKey: string;
  sessionId: string;
}>;

export type SessionIdAcpCloseStageResult =
  | Readonly<{
      disposition: "closed" | "rejected";
      result: ConductorOrchestrationToolResult;
    }>
  | Readonly<{
      disposition: "retirement_required";
      sessionControlAuditId: string;
      bindingRetirementIntentId: string;
    }>;

export type SessionIdAcpCloseCompletionInput = Readonly<{
  command: SessionIdAcpCloseSessionOwnerCommand;
  bindingRetirementIntentId: string;
}>;

export interface SessionIdAcpCloseTaskRunCapability {
  getSlot(cardSessionSlotId: string): CardSessionSlotRecord | undefined;
  getGeneration(logicalSessionId: string): CardSessionGenerationRecord | undefined;
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

export interface SessionIdAcpCloseOrchestrationCapability {
  getTurn(sessionTurnId: string): SessionIdSessionTurnRecord | undefined;
  listInboxItems(logicalSessionId: string): readonly SessionLaneItemRecord[];
  suppressPendingOrdinary(
    logicalSessionId: string,
    reason: "session_closed" | "task_stopped",
    now: string,
  ): readonly string[];
  listTurns(logicalSessionId: string): readonly SessionIdSessionTurnRecord[];
  createControlAudit(control: SessionControlAuditRecord): void;
  getControlAudit(sessionControlAuditId: string): SessionControlAuditRecord | undefined;
  findControlByIdempotencyKey(
    taskId: string,
    runId: string,
    idempotencyKey: string,
  ): SessionControlAuditRecord | undefined;
  listControlAudits(runId: string, logicalSessionId?: string): readonly SessionControlAuditRecord[];
  updateControlAudit(
    control: SessionControlAuditRecord,
    expectedState: SessionControlAuditRecord["state"],
  ): void;
}

export interface SessionIdAcpCloseHumanCapability {
  list(runId: string, targetLogicalSessionId?: string): readonly SessionIdHumanInterventionRecord[];
}

export interface SessionIdAcpCloseBindingCapability {
  getBinding(bindingId: string): AcpSafeSessionBindingRecordV3 | undefined;
  getCurrentBinding(logicalSessionId: string): AcpSafeSessionBindingRecordV3 | undefined;
}

export interface SessionIdAcpCloseExecutionCapability {
  getRuntimeForSession(logicalSessionId: string): SessionExecutionRuntimeRecord | undefined;
  getAttempt(sessionExecutionAttemptId: string): SessionExecutionAttemptRecord | undefined;
  listAttempts(sessionExecutionRuntimeId: string): readonly SessionExecutionAttemptRecord[];
}

export interface SessionIdAcpCloseReliabilityCapability {
  createBindingRetirementIntent(
    intent: AcpV3BindingRetirementIntentRecord,
  ): AcpV3BindingRetirementIntentRecord;
  getBindingRetirementIntent(
    bindingRetirementIntentId: string,
  ): AcpV3BindingRetirementIntentRecord | undefined;
  findBindingRetirementIntentByIdempotencyKey(scope: Readonly<{
    taskId: string;
    runId: string;
    bindingId: string;
    idempotencyKey: string;
  }>): AcpV3BindingRetirementIntentRecord | undefined;
  listBindingRetirementIntents(
    logicalSessionId?: string,
  ): readonly AcpV3BindingRetirementIntentRecord[];
}

export interface SessionIdAcpCloseReceiptCapability {
  createCommandReceipt(receipt: SessionIdCommandReceiptRecord): void;
  findCommandReceipt(
    taskId: string,
    runId: string,
    idempotencyKey: string,
  ): SessionIdCommandReceiptRecord | undefined;
}

export type SessionIdAcpCloseSessionCapabilities = Readonly<{
  taskRun: SessionIdAcpCloseTaskRunCapability;
  orchestration: SessionIdAcpCloseOrchestrationCapability;
  humanIntervention: SessionIdAcpCloseHumanCapability;
  currentBinding: SessionIdAcpCloseBindingCapability;
  sessionExecution: SessionIdAcpCloseExecutionCapability;
  reliability: SessionIdAcpCloseReliabilityCapability;
  commandReceipts: SessionIdAcpCloseReceiptCapability;
}>;

export type SessionIdAcpCloseSessionOwnerOptions = Readonly<{
  now: () => string;
  createId(kind: "session_control" | "binding_retirement" | "command"): string;
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
  transaction: Readonly<{
    run<T>(work: (owners: SessionIdAcpCloseSessionCapabilities) => T): T;
  }>;
  resolveFrozenProfile: AcpV3FrozenProfileTupleResolver;
  authorizeConductorScope?: (command: SessionIdAcpCloseSessionOwnerCommand) => boolean;
}>;

const SAFE_REJECTIONS = new Set([
  "orchestration_scope_run_not_accepting_commands",
  "orchestration_scope_revision_stale",
  "orchestration_scope_turn_not_active",
  "orchestration_scope_turn_stale",
  "orchestration_session_unknown",
  "orchestration_session_scope_mismatch",
  "orchestration_session_not_current",
  "orchestration_session_execution_profile_mismatch",
  "human_intervention_path_active",
  "session_close_active_or_ambiguous",
  "session_close_lane_not_safe",
  "session_close_control_unresolved",
  "session_close_interaction_unresolved",
  "session_close_provider_outcome_unresolved",
  "session_close_binding_recovering",
]);

/**
 * Provider-neutral two-phase close owner. `stageClose` persists only the close
 * fence and retirement intent. The public `closed` result does not exist until
 * `completeClose` observes the exact released Binding and retires the current
 * generation in a second owner-scoped SQLite transaction.
 */
export function createSessionIdAcpCloseSessionOwner(options: SessionIdAcpCloseSessionOwnerOptions) {
  validateOptions(options);
  const task = Object.freeze({
    ...options.task,
    agentCards: Object.freeze(options.task.agentCards.map((card) => Object.freeze({ ...card }))),
  });
  return Object.freeze({ stageClose, completeClose });

  function stageClose(value: unknown): SessionIdAcpCloseStageResult {
    const command = validateCommand(value);
    assertCommandTaskScope(command);
    const fingerprint = closeFingerprint(command);
    try {
      return options.transaction.run((owners) => {
        const replay = replayReceipt(owners, command, fingerprint);
        if (replay) return replay;
        const fenceKey = closeFenceKey(command, fingerprint);
        invariant(!owners.orchestration.listControlAudits(task.runId)
          .some((control) => control.kind === "close"
            && control.idempotencyKey.startsWith(`${command.idempotencyKey}:close:`)
            && control.idempotencyKey !== fenceKey),
        "orchestration_idempotency_payload_conflict");
        const existing = owners.orchestration.findControlByIdempotencyKey(
          task.taskId,
          task.runId,
          fenceKey,
        );
        if (existing) {
          return replayPendingClose(
            owners,
            command,
            requireCurrentGeneration(owners, command.sessionId),
            existing,
            fenceKey,
          );
        }
        assertConductorScope(owners, command);
        const generation = requireCurrentGeneration(owners, command.sessionId);
        invariant(!owners.orchestration.listControlAudits(task.runId, command.sessionId)
          .some((control) => control.commandId === command.commandId),
        "orchestration_idempotency_payload_conflict");
        assertCloseQuiescent(owners, command.sessionId);

        const binding = owners.currentBinding.getCurrentBinding(command.sessionId);
        if (!binding) return closeUnbound(owners, command, generation, fingerprint, fenceKey);
        const exactBinding = requireCurrentBinding(binding, generation);
        invariant(exactBinding.status === "active", "session_close_binding_recovering");
        const now = exactTime(options.now());
        const affectedInboxItemIds = owners.orchestration.suppressPendingOrdinary(
          command.sessionId,
          "session_closed",
          now,
        );
        const control = closeControl(command, fenceKey, "requested", affectedInboxItemIds, now);
        owners.orchestration.createControlAudit(control);
        const intent = owners.reliability.createBindingRetirementIntent(
          cloneAcpV3BindingRetirementIntentRecord({
            bindingRetirementIntentId: allocatedId("binding_retirement", "binding_retirement"),
            commandId: allocatedId("command", "command"),
            idempotencyKey: fenceKey,
            taskId: task.taskId,
            runId: task.runId,
            logicalSessionId: command.sessionId,
            bindingId: exactBinding.bindingId,
            bindingRevision: exactBinding.revision,
            bindingHandle: exactBinding.bindingHandle,
            executionProfileId: exactBinding.executionProfileId,
            profileRevisionId: exactBinding.profileRevisionId,
            providerFamily: exactBinding.providerFamily,
            sessionControlAuditId: control.sessionControlAuditId,
            state: "pending",
            attempts: 0,
            revision: 1,
            createdAt: now,
            updatedAt: now,
          }),
        );
        assertRetirementStage(intent, control, exactBinding);
        return Object.freeze({
          disposition: "retirement_required" as const,
          sessionControlAuditId: control.sessionControlAuditId,
          bindingRetirementIntentId: intent.bindingRetirementIntentId,
        });
      });
    } catch (error) {
      const reason = safeRejection(error);
      if (!reason) throw error;
      return options.transaction.run((owners) => {
        const replay = replayReceipt(owners, command, fingerprint);
        if (replay) return replay;
        const result = Object.freeze({ status: "rejected" as const, reason });
        owners.commandReceipts.createCommandReceipt(commandReceipt(command, fingerprint, result, exactTime(options.now())));
        return Object.freeze({ disposition: "rejected" as const, result });
      });
    }
  }

  function completeClose(value: unknown): ConductorOrchestrationToolResult {
    const completion = validateCompletion(value);
    const { command } = completion;
    assertCommandTaskScope(command);
    const fingerprint = closeFingerprint(command);
    return options.transaction.run((owners) => {
      const replay = replayReceipt(owners, command, fingerprint);
      if (replay) {
        invariant(replay.disposition === "closed", "session_close_completion_rejected_replay");
        return replay.result;
      }
      const intent = owners.reliability.getBindingRetirementIntent(completion.bindingRetirementIntentId);
      invariant(Boolean(intent), "session_close_binding_retirement_missing");
      const exactIntent = cloneAcpV3BindingRetirementIntentRecord(intent!);
      const fenceKey = closeFenceKey(command, fingerprint);
      invariant(exactIntent.taskId === task.taskId
        && exactIntent.runId === task.runId
        && exactIntent.logicalSessionId === command.sessionId
        && exactIntent.idempotencyKey === fenceKey,
      "session_close_binding_retirement_scope_mismatch");
      invariant(exactIntent.state === "released", "session_close_binding_retirement_not_released");
      const control = owners.orchestration.getControlAudit(exactIntent.sessionControlAuditId);
      requirePendingCloseControl(control, command, fenceKey);
      const generation = requireCurrentGeneration(owners, command.sessionId);
      const released = owners.currentBinding.getBinding(exactIntent.bindingId);
      invariant(Boolean(released)
        && released!.taskId === exactIntent.taskId
        && released!.runId === exactIntent.runId
        && released!.logicalSessionId === exactIntent.logicalSessionId
        && released!.agentCardId === generation.agentCardId
        && released!.executionProfileId === exactIntent.executionProfileId
        && released!.profileRevisionId === exactIntent.profileRevisionId
        && released!.providerFamily === exactIntent.providerFamily
        && released!.bindingHandle === exactIntent.bindingHandle
        && released!.revision === exactIntent.bindingRevision + 1
        && released!.status === "released"
        && released!.recoverable === false
        && !owners.currentBinding.getCurrentBinding(command.sessionId),
      "session_close_released_binding_fence_mismatch");
      assertCloseQuiescent(owners, command.sessionId, control!.sessionControlAuditId);
      const slot = owners.taskRun.getSlot(generation.cardSessionSlotId);
      requireCurrentSlot(slot, generation);
      const now = exactTime(options.now());
      const retired = retireCardSessionGeneration({ slot: slot!, generation, now });
      owners.taskRun.retireGeneration(retired.slot, retired.generation, slot!.revision);
      owners.orchestration.updateControlAudit(Object.freeze({
        ...control!,
        state: "closed" as const,
        settledAt: now,
      }), "requested");
      const result = Object.freeze({ status: "closed" as const });
      owners.commandReceipts.createCommandReceipt(commandReceipt(command, fingerprint, result, now));
      return result;
    });
  }

  function closeUnbound(
    owners: SessionIdAcpCloseSessionCapabilities,
    command: SessionIdAcpCloseSessionOwnerCommand,
    generation: CardSessionGenerationRecord,
    fingerprint: string,
    fenceKey: string,
  ): SessionIdAcpCloseStageResult {
    const slot = owners.taskRun.getSlot(generation.cardSessionSlotId);
    requireCurrentSlot(slot, generation);
    const now = exactTime(options.now());
    const affected = owners.orchestration.suppressPendingOrdinary(command.sessionId, "session_closed", now);
    const control = closeControl(command, fenceKey, "closed", affected, now);
    owners.orchestration.createControlAudit(control);
    const retired = retireCardSessionGeneration({ slot: slot!, generation, now });
    owners.taskRun.retireGeneration(retired.slot, retired.generation, slot!.revision);
    const result = Object.freeze({ status: "closed" as const });
    owners.commandReceipts.createCommandReceipt(commandReceipt(command, fingerprint, result, now));
    return Object.freeze({ disposition: "closed" as const, result });
  }

  function replayPendingClose(
    owners: SessionIdAcpCloseSessionCapabilities,
    command: SessionIdAcpCloseSessionOwnerCommand,
    generation: CardSessionGenerationRecord,
    control: SessionControlAuditRecord,
    fenceKey: string,
  ): SessionIdAcpCloseStageResult {
    requirePendingCloseControl(control, command, fenceKey);
    const binding = owners.currentBinding.getCurrentBinding(command.sessionId)
      ?? owners.reliability.listBindingRetirementIntents(command.sessionId)
        .map((intent) => owners.currentBinding.getBinding(intent.bindingId))
        .find((candidate) => candidate?.agentCardId === generation.agentCardId);
    invariant(Boolean(binding), "session_close_binding_retirement_missing");
    const candidates = owners.reliability.listBindingRetirementIntents(command.sessionId)
      .filter((intent) => intent.taskId === task.taskId
        && intent.runId === task.runId
        && intent.logicalSessionId === command.sessionId
        && intent.bindingId === binding!.bindingId
        && intent.idempotencyKey === fenceKey
        && intent.sessionControlAuditId === control.sessionControlAuditId);
    invariant(candidates.length === 1, "session_close_binding_retirement_ambiguous");
    return Object.freeze({
      disposition: "retirement_required" as const,
      sessionControlAuditId: control.sessionControlAuditId,
      bindingRetirementIntentId: candidates[0]!.bindingRetirementIntentId,
    });
  }

  function requireCurrentBinding(
    value: AcpSafeSessionBindingRecordV3,
    generation: CardSessionGenerationRecord,
  ): AcpSafeSessionBindingRecordV3 {
    const binding = cloneAcpSafeSessionBindingRecordV3(value);
    const card = task.agentCards.find((candidate) => candidate.agentCardId === generation.agentCardId);
    invariant(Boolean(card)
      && binding.taskId === task.taskId
      && binding.runId === task.runId
      && binding.logicalSessionId === generation.sessionId
      && binding.agentCardId === generation.agentCardId
      && binding.executionProfileId === generation.executionProfileId
      && binding.executionProfileId === card!.executionProfileId
      && binding.profileRevisionId === card!.profileRevisionId
      && binding.providerFamily === card!.providerFamily,
    "session_close_binding_scope_mismatch");
    const profile = options.resolveFrozenProfile({
      taskId: task.taskId,
      runId: task.runId,
      logicalSessionId: generation.sessionId,
      executionProfileId: generation.executionProfileId,
    });
    invariant(Boolean(profile)
      && profile!.schemaVersion === 3
      && profile!.executionProfileId === binding.executionProfileId
      && profile!.profileRevisionId === binding.profileRevisionId
      && profile!.providerFamily === binding.providerFamily,
    "session_close_binding_scope_mismatch");
    return binding;
  }

  function assertConductorScope(
    owners: SessionIdAcpCloseSessionCapabilities,
    command: SessionIdAcpCloseSessionOwnerCommand,
  ): void {
    const run = owners.taskRun.readTaskRunState(task.taskId, task.runId);
    invariant(run.taskId === task.taskId && run.runId === task.runId && run.runStatus === "running",
      "orchestration_scope_run_not_accepting_commands");
    invariant(run.taskRevision === command.expectedRevision, "orchestration_scope_revision_stale");
    invariant(command.conductorSessionId === task.conductorSessionId
      && owners.taskRun.getConductorSessionId(task.taskId, task.runId) === task.conductorSessionId,
    "orchestration_scope_turn_not_active");
    invariant(run.currentConductorSessionTurnId === command.conductorSessionTurnId,
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

  function requireCurrentGeneration(
    owners: SessionIdAcpCloseSessionCapabilities,
    logicalSessionId: string,
  ): CardSessionGenerationRecord {
    const generation = owners.taskRun.getGeneration(logicalSessionId);
    invariant(Boolean(generation), "orchestration_session_unknown");
    invariant(generation!.taskId === task.taskId && generation!.runId === task.runId,
      "orchestration_session_scope_mismatch");
    invariant(generation!.sessionId === logicalSessionId
      && generation!.lifecycle === "current"
      && !generation!.closedAt,
    "orchestration_session_not_current");
    const card = task.agentCards.find((candidate) => candidate.agentCardId === generation!.agentCardId);
    invariant(Boolean(card) && generation!.executionProfileId === card!.executionProfileId,
      "orchestration_session_execution_profile_mismatch");
    requireCurrentSlot(owners.taskRun.getSlot(generation!.cardSessionSlotId), generation!);
    return generation!;
  }

  function requireCurrentSlot(
    slot: CardSessionSlotRecord | undefined,
    generation: CardSessionGenerationRecord,
  ): void {
    invariant(Boolean(slot)
      && slot!.taskId === generation.taskId
      && slot!.runId === generation.runId
      && slot!.agentCardId === generation.agentCardId
      && slot!.currentSessionId === generation.sessionId
      && slot!.latestGeneration === generation.generation,
    "orchestration_session_not_current");
  }

  function assertCloseQuiescent(
    owners: SessionIdAcpCloseSessionCapabilities,
    logicalSessionId: string,
    ownControlId?: string,
  ): void {
    invariant(!owners.humanIntervention.list(task.runId, logicalSessionId).some((intervention) =>
      intervention.state === "accepted" || intervention.state === "held" || intervention.state === "delivered"),
    "human_intervention_path_active");
    invariant(!owners.orchestration.listTurns(logicalSessionId).some((turn) =>
      turn.state === "pending" || turn.state === "active" || turn.state === "ambiguous"),
    "session_close_active_or_ambiguous");
    invariant(!owners.orchestration.listInboxItems(logicalSessionId).some((item) =>
      item.state === "held_by_human_intervention"
        || item.state === "leased"
        || item.state === "handed"
        || item.state === "ambiguous"
        || (item.state === "pending" && item.priority !== "ordinary")),
    "session_close_lane_not_safe");
    invariant(!owners.orchestration.listControlAudits(task.runId, logicalSessionId).some((control) =>
      control.sessionControlAuditId !== ownControlId
        && (control.state === "requested" || control.state === "accepted" || control.state === "unknown")),
    "session_close_control_unresolved");
    const runtime = owners.sessionExecution.getRuntimeForSession(logicalSessionId);
    if (!runtime) return;
    invariant(runtime.taskId === task.taskId
      && runtime.runId === task.runId
      && runtime.logicalSessionId === logicalSessionId,
    "session_close_provider_outcome_unresolved");
    const active = runtime.activeAttemptId
      ? owners.sessionExecution.getAttempt(runtime.activeAttemptId)
      : undefined;
    if (active?.interactions.some((interaction) => interaction.status === "requested")) {
      throw new Error("session_close_interaction_unresolved");
    }
    invariant(!runtime.activeAttemptId
      && runtime.state !== "executing"
      && runtime.state !== "reconciling",
    "session_close_provider_outcome_unresolved");
    const attempts = owners.sessionExecution.listAttempts(runtime.sessionExecutionRuntimeId);
    invariant(attempts.every((attempt) => attempt.sessionExecutionRuntimeId === runtime.sessionExecutionRuntimeId
      && attempt.taskId === task.taskId
      && attempt.runId === task.runId
      && attempt.logicalSessionId === logicalSessionId
      && Boolean(attempt.settlement)),
    "session_close_provider_outcome_unresolved");
  }

  function closeControl(
    command: SessionIdAcpCloseSessionOwnerCommand,
    fenceKey: string,
    state: "requested" | "closed",
    affectedInboxItemIds: readonly string[],
    now: string,
  ): SessionControlAuditRecord {
    return Object.freeze({
      sessionControlAuditId: allocatedId("session_control", "session_control"),
      taskId: task.taskId,
      runId: task.runId,
      sessionId: command.sessionId,
      commandId: command.commandId,
      idempotencyKey: fenceKey,
      kind: "close" as const,
      state,
      affectedInboxItemIds: Object.freeze([...affectedInboxItemIds]),
      requestedAt: now,
      ...(state === "closed" ? { settledAt: now } : {}),
    });
  }

  function replayReceipt(
    owners: SessionIdAcpCloseSessionCapabilities,
    command: SessionIdAcpCloseSessionOwnerCommand,
    fingerprint: string,
  ): SessionIdAcpCloseStageResult | undefined {
    const receipt = owners.commandReceipts.findCommandReceipt(task.taskId, task.runId, command.idempotencyKey);
    if (!receipt) return undefined;
    invariant(receipt.commandId === command.commandId
      && receipt.commandKind === "close_session"
      && receipt.payloadFingerprint === fingerprint,
    "orchestration_idempotency_payload_conflict");
    const result = storedResult(receipt.result);
    const closed = "status" in result && result.status === "closed";
    return Object.freeze({
      disposition: closed ? "closed" as const : "rejected" as const,
      result,
    });
  }

  function assertCommandTaskScope(command: SessionIdAcpCloseSessionOwnerCommand): void {
    invariant(command.taskId === task.taskId
      && command.runId === task.runId
      && command.conductorSessionId === task.conductorSessionId,
    "orchestration_scope_run_not_accepting_commands");
  }

  function allocatedId(
    kind: "session_control" | "binding_retirement" | "command",
    prefix: string,
  ): string {
    return prefixedId(options.createId(kind), prefix, `session_close_${kind}_id_invalid`);
  }
}

function validateOptions(options: SessionIdAcpCloseSessionOwnerOptions): void {
  invariant(Boolean(options)
    && typeof options.now === "function"
    && typeof options.createId === "function"
    && typeof options.transaction?.run === "function"
    && typeof options.resolveFrozenProfile === "function",
  "session_close_owner_options_invalid");
  prefixedId(options.task.taskId, "task", "session_close_owner_scope_invalid");
  prefixedId(options.task.runId, "run", "session_close_owner_scope_invalid");
  prefixedId(options.task.conductorSessionId, "logical_session", "session_close_owner_scope_invalid");
  invariant(Array.isArray(options.task.agentCards) && options.task.agentCards.length > 0,
    "session_close_owner_scope_invalid");
}

function validateCommand(value: unknown): SessionIdAcpCloseSessionOwnerCommand {
  invariant(Boolean(value) && typeof value === "object" && !Array.isArray(value),
    "session_close_command_invalid");
  const root = value as Record<string, unknown>;
  const keys = [
    "taskId", "runId", "expectedRevision", "conductorSessionId", "conductorSessionTurnId",
    "commandId", "idempotencyKey", "sessionId",
  ];
  invariant(Object.keys(root).length === keys.length && Object.keys(root).every((key) => keys.includes(key)),
    "session_close_command_invalid");
  invariant(Number.isSafeInteger(root.expectedRevision) && Number(root.expectedRevision) > 0,
    "session_close_command_invalid");
  return Object.freeze({
    taskId: prefixedId(root.taskId, "task", "session_close_command_invalid"),
    runId: prefixedId(root.runId, "run", "session_close_command_invalid"),
    expectedRevision: Number(root.expectedRevision),
    conductorSessionId: prefixedId(root.conductorSessionId, "logical_session", "session_close_command_invalid"),
    conductorSessionTurnId: prefixedId(root.conductorSessionTurnId, "session_turn", "session_close_command_invalid"),
    commandId: prefixedId(root.commandId, "command", "session_close_command_invalid"),
    idempotencyKey: safeText(root.idempotencyKey, "session_close_command_invalid"),
    sessionId: prefixedId(root.sessionId, "logical_session", "session_close_command_invalid"),
  });
}

function validateCompletion(value: unknown): SessionIdAcpCloseCompletionInput {
  invariant(Boolean(value) && typeof value === "object" && !Array.isArray(value),
    "session_close_completion_invalid");
  const root = value as Record<string, unknown>;
  invariant(Object.keys(root).length === 2
    && Object.hasOwn(root, "command")
    && Object.hasOwn(root, "bindingRetirementIntentId"),
  "session_close_completion_invalid");
  return Object.freeze({
    command: validateCommand(root.command),
    bindingRetirementIntentId: prefixedId(
      root.bindingRetirementIntentId,
      "binding_retirement",
      "session_close_completion_invalid",
    ),
  });
}

function closeFingerprint(command: SessionIdAcpCloseSessionOwnerCommand): string {
  return hashDefinition({
    kind: "close_session",
    taskId: command.taskId,
    runId: command.runId,
    expectedRevision: command.expectedRevision,
    conductorSessionId: command.conductorSessionId,
    conductorSessionTurnId: command.conductorSessionTurnId,
    commandId: command.commandId,
    sessionId: command.sessionId,
  });
}

function closeFenceKey(command: SessionIdAcpCloseSessionOwnerCommand, fingerprint: string): string {
  return `${command.idempotencyKey}:close:${fingerprint}`;
}

function requirePendingCloseControl(
  control: SessionControlAuditRecord | undefined,
  command: SessionIdAcpCloseSessionOwnerCommand,
  fenceKey: string,
): void {
  invariant(Boolean(control)
    && control!.taskId === command.taskId
    && control!.runId === command.runId
    && control!.sessionId === command.sessionId
    && control!.commandId === command.commandId
    && control!.idempotencyKey === fenceKey
    && control!.kind === "close"
    && control!.state === "requested",
  "session_close_control_fence_mismatch");
}

function assertRetirementStage(
  intent: AcpV3BindingRetirementIntentRecord,
  control: SessionControlAuditRecord,
  binding: AcpSafeSessionBindingRecordV3,
): void {
  invariant(intent.taskId === control.taskId
    && intent.runId === control.runId
    && intent.logicalSessionId === control.sessionId
    && intent.sessionControlAuditId === control.sessionControlAuditId
    && intent.idempotencyKey === control.idempotencyKey
    && intent.bindingId === binding.bindingId
    && intent.bindingRevision === binding.revision
    && intent.bindingHandle === binding.bindingHandle
    && intent.executionProfileId === binding.executionProfileId
    && intent.profileRevisionId === binding.profileRevisionId
    && intent.providerFamily === binding.providerFamily
    && intent.state === "pending",
  "session_close_binding_retirement_scope_mismatch");
}

function commandReceipt(
  command: SessionIdAcpCloseSessionOwnerCommand,
  fingerprint: string,
  result: ConductorOrchestrationToolResult,
  createdAt: string,
): SessionIdCommandReceiptRecord {
  return Object.freeze({
    commandId: command.commandId,
    taskId: command.taskId,
    runId: command.runId,
    commandKind: "close_session",
    idempotencyKey: command.idempotencyKey,
    payloadFingerprint: fingerprint,
    result: result as JsonValue,
    createdAt,
  });
}

function storedResult(value: JsonValue): ConductorOrchestrationToolResult {
  invariant(Boolean(value) && typeof value === "object" && !Array.isArray(value),
    "session_close_receipt_result_invalid");
  const root = value as Record<string, unknown>;
  if (Object.keys(root).length === 1 && root.status === "closed") {
    return Object.freeze({ status: "closed" as const });
  }
  invariant(Object.keys(root).length === 2
    && root.status === "rejected"
    && typeof root.reason === "string"
    && SAFE_REJECTIONS.has(root.reason),
  "session_close_receipt_result_invalid");
  return Object.freeze({ status: "rejected" as const, reason: root.reason as string });
}

function safeRejection(error: unknown): string | undefined {
  return error instanceof Error && SAFE_REJECTIONS.has(error.message) ? error.message : undefined;
}

function safeText(value: unknown, code: string): string {
  invariant(typeof value === "string" && value.trim().length > 0 && value.length <= 512 && !/[\r\n]/u.test(value), code);
  return value as string;
}

function prefixedId(value: unknown, prefix: string, code: string): string {
  invariant(typeof value === "string"
    && value.length <= 256
    && new RegExp(`^${prefix}_[A-Za-z0-9_-]+$`, "u").test(value), code);
  return value as string;
}

function exactTime(value: unknown): string {
  invariant(typeof value === "string" && new Date(value).toISOString() === value,
    "session_close_time_invalid");
  return value as string;
}

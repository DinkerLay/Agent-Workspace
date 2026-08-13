import type {
  JsonValue,
  SessionExecutionAttemptRecord,
  SessionExecutionRuntimeRecord,
  SessionExecutionSettlement,
  SessionRuntimeBindingReadyEvent,
  SessionRuntimeCommand,
  SessionRuntimeExternalEffect,
  SessionRuntimeProviderEffectIntentRecord,
} from "@agent-workspace/runtime-contracts";
import {
  assertBindingHandle,
  assertSessionExecutionSafeValue,
  cloneSessionRuntimeProviderEffectIntent,
  hashDefinition,
  validateSessionRuntimeCommand,
} from "@agent-workspace/runtime-contracts";
import {
  createSessionExecutionRuntime,
  markSessionExecutionRuntimeExecuting,
  markSessionExecutionRuntimeReconciling,
  markSessionExecutionReconciliation,
  recordSessionExecutionFinalCandidate,
  recordSessionExecutionInteraction,
  recordSessionExecutionInteractionChoice,
  recordSessionExecutionReceipt,
  recordSessionExecutionTerminal,
  settleSessionExecutionRuntime,
  startSessionExecutionAttempt,
} from "@agent-workspace/runtime-domain";
import { invariant } from "@agent-workspace/runtime-domain";

export interface SessionExecutionRecordRepository {
  findRuntimeByLogicalSessionId(logicalSessionId: string): SessionExecutionRuntimeRecord | undefined;
  getRuntime(sessionExecutionRuntimeId: string): SessionExecutionRuntimeRecord | undefined;
  insertRuntime(runtime: SessionExecutionRuntimeRecord): void;
  updateRuntime(runtime: SessionExecutionRuntimeRecord, expectedRevision: number): void;
  getAttempt(sessionExecutionAttemptId: string): SessionExecutionAttemptRecord | undefined;
  insertAttempt(attempt: SessionExecutionAttemptRecord): void;
  updateAttempt(attempt: SessionExecutionAttemptRecord, expectedRevision: number): void;
}

/** Phase 1 freezes an owner-scoped repository; SQLite implements it in Phase 6. */
export interface SessionExecutionRepository extends SessionExecutionRecordRepository {
  transaction<T>(work: (records: SessionExecutionRecordRepository) => T): T;
}

export interface SessionRuntimeProviderEffectIntentWriter {
  findByCommandId(commandId: string): SessionRuntimeProviderEffectIntentRecord | undefined;
  findByIdempotencyKey(idempotencyKey: string): SessionRuntimeProviderEffectIntentRecord | undefined;
  insert(intent: SessionRuntimeProviderEffectIntentRecord): void;
}

export interface SessionRuntimeCommandTransaction {
  run<T>(work: (owners: Readonly<{
    sessionExecution: SessionExecutionRecordRepository;
    providerEffects: SessionRuntimeProviderEffectIntentWriter;
  }>) => T): T;
}

export type SessionExecutionRuntimeOwnerOptions = Readonly<{
  repository: SessionExecutionRepository;
  now: () => string;
  createRuntimeId: () => string;
  createAttemptId: () => string;
  createProviderEffectIntentId?: () => string;
  commandTransaction?: SessionRuntimeCommandTransaction;
}>;

export type SessionExecutionMutationResult = Readonly<{
  attempt: SessionExecutionAttemptRecord;
  settlement?: SessionExecutionSettlement;
}>;

export type SessionRuntimeCommandExecution =
  | Readonly<{
      disposition: "staged";
      intent: SessionRuntimeProviderEffectIntentRecord;
      externalEffect: SessionRuntimeExternalEffect;
    }>
  | Readonly<{
      disposition: "replay";
      intent: SessionRuntimeProviderEffectIntentRecord;
    }>;

export function createSessionExecutionRuntimeOwner(options: SessionExecutionRuntimeOwnerOptions) {
  return Object.freeze({
    ensureRuntime,
    startAttempt,
    executeCommand,
    recordReceipt: (input: ReceiptInput) => mutateAttempt(input, (attempt, now) =>
      recordSessionExecutionReceipt(attempt, { receiptDigest: input.receiptDigest, observedAt: now })),
    requestInteraction: (input: RequestInteractionInput) => mutateAttempt(input, (attempt, now) =>
      recordSessionExecutionInteraction(attempt, {
        interactionId: input.interactionId,
        promptDigest: input.promptDigest,
        choices: input.choices,
        observedAt: now,
      })),
    respondInteraction: (input: RespondInteractionInput) => mutateAttempt(input, (attempt, now) =>
      recordSessionExecutionInteractionChoice(attempt, {
        sessionExecutionAttemptId: input.sessionExecutionAttemptId,
        interactionId: input.interactionId,
        choiceId: input.choiceId,
        expectedInteractionRevision: input.expectedInteractionRevision,
        respondedAt: now,
      })),
    recordFinalCandidate: (input: FinalCandidateInput) => mutateAttempt(input, (attempt, now) =>
      recordSessionExecutionFinalCandidate(attempt, {
        candidateObservationId: input.candidateObservationId,
        content: input.content,
        contentDigest: input.contentDigest,
        observedAt: now,
      })),
    recordTerminal: (input: TerminalInput) => mutateAttempt(input, (attempt, now) =>
      recordSessionExecutionTerminal(attempt, {
        terminalObservationId: input.terminalObservationId,
        outcome: input.outcome,
        ...(input.receiptDigest === undefined ? {} : { receiptDigest: input.receiptDigest }),
        observedAt: now,
      })),
    handleDeliveryReceipt: (input: DeliveryReceiptObservationInput) => mutateAttempt(input, (attempt, now) =>
      recordSessionExecutionReceipt(attempt, { receiptDigest: input.receiptDigest, observedAt: now })),
    handleInteractionRequested: (input: InteractionRequestedObservationInput) => mutateAttempt(input, (attempt, now) =>
      recordSessionExecutionInteraction(attempt, {
        interactionId: input.interactionId,
        promptDigest: input.promptDigest,
        choices: input.choices,
        observedAt: now,
      })),
    handleInteractionResolved: (input: InteractionResolvedObservationInput) => mutateAttempt(input, (attempt, now) =>
      recordSessionExecutionInteractionChoice(attempt, {
        sessionExecutionAttemptId: input.sessionExecutionAttemptId,
        interactionId: input.interactionId,
        choiceId: input.choiceId,
        expectedInteractionRevision: input.expectedInteractionRevision,
        respondedAt: now,
      })),
    handleFinalCandidate: (input: FinalCandidateObservationInput) => mutateAttempt(input, (attempt, now) =>
      recordSessionExecutionFinalCandidate(attempt, {
        candidateObservationId: input.candidateObservationId,
        content: input.content,
        contentDigest: input.contentDigest,
        observedAt: now,
      })),
    handlePromptTerminal: (input: PromptTerminalObservationInput) => mutateAttempt(input, (attempt, now) =>
      recordSessionExecutionTerminal(attempt, {
        terminalObservationId: input.terminalObservationId,
        outcome: input.outcome,
        ...(input.receiptDigest === undefined ? {} : { receiptDigest: input.receiptDigest }),
        observedAt: now,
      })),
    markReconciliation,
    bindingReadyEvent,
    getRuntimeForLogicalSession: (logicalSessionId: string) =>
      options.repository.findRuntimeByLogicalSessionId(logicalSessionId),
    getRuntime: (sessionExecutionRuntimeId: string) => options.repository.getRuntime(sessionExecutionRuntimeId),
    getAttempt: (sessionExecutionAttemptId: string) => options.repository.getAttempt(sessionExecutionAttemptId),
  });

  function ensureRuntime(input: EnsureRuntimeInput): SessionExecutionRuntimeRecord {
    assertSessionExecutionSafeValue(input);
    return options.repository.transaction((records) => {
      const existing = records.findRuntimeByLogicalSessionId(input.logicalSessionId);
      if (existing) {
        invariant(existing.taskId === input.taskId && existing.runId === input.runId, "session_execution_runtime_scope_mismatch");
        return existing;
      }
      const runtime = createSessionExecutionRuntime({
        ...input,
        sessionExecutionRuntimeId: options.createRuntimeId(),
        now: options.now(),
      });
      records.insertRuntime(runtime);
      return runtime;
    });
  }

  function startAttempt(input: StartAttemptInput): SessionExecutionAttemptRecord {
    assertSessionExecutionSafeValue(input);
    return options.repository.transaction((records) => {
      const runtime = requiredRuntime(records, input.sessionExecutionRuntimeId);
      invariant(runtime.revision === input.expectedRuntimeRevision, "session_execution_runtime_revision_stale");
      const started = startSessionExecutionAttempt(runtime, {
        sessionExecutionAttemptId: options.createAttemptId(),
        bindingId: input.bindingId,
        bindingRevision: input.bindingRevision,
        executionProfileId: input.executionProfileId,
        profileRevisionId: input.profileRevisionId,
        inputSubmissionId: input.inputSubmissionId,
        orchestrationSessionTurnId: input.orchestrationSessionTurnId,
        now: options.now(),
      });
      records.insertAttempt(started.attempt);
      records.updateRuntime(started.runtime, runtime.revision);
      return started.attempt;
    });
  }

  function executeCommand(value: SessionRuntimeCommand): SessionRuntimeCommandExecution {
    const command = validateSessionRuntimeCommand(value);
    const commandTransaction = options.commandTransaction;
    invariant(Boolean(commandTransaction), "session_runtime_command_transaction_required");
    const { commandId: _commandId, ...semanticCommand } = command;
    const commandFingerprint = hashDefinition(semanticCommand as unknown as JsonValue);
    return commandTransaction!.run(({ sessionExecution, providerEffects }) => {
      const replayByCommand = providerEffects.findByCommandId(command.commandId);
      const replayByKey = providerEffects.findByIdempotencyKey(command.idempotencyKey);
      if (replayByCommand) {
        invariant(
          replayByCommand.idempotencyKey === command.idempotencyKey
            && replayByCommand.commandFingerprint === commandFingerprint
            && replayByCommand.commandType === command.type
            && (!replayByKey || replayByKey.providerEffectIntentId === replayByCommand.providerEffectIntentId),
          "session_runtime_command_replay_conflict",
        );
        return Object.freeze({
          disposition: "replay" as const,
          intent: replayByCommand,
        });
      }
      if (replayByKey) {
        invariant(
          replayByKey.commandFingerprint === commandFingerprint && replayByKey.commandType === command.type,
          "session_runtime_idempotency_key_conflict",
        );
        return Object.freeze({
          disposition: "replay" as const,
          intent: replayByKey,
        });
      }

      const runtime = requiredRuntime(sessionExecution, command.sessionExecutionRuntimeId);
      assertCommandRuntimeScope(runtime, command);
      let attempt: SessionExecutionAttemptRecord;
      let externalEffect: SessionRuntimeExternalEffect;
      if (command.type === "session_runtime.submit_delivery") {
        const started = startSessionExecutionAttempt(runtime, {
          sessionExecutionAttemptId: options.createAttemptId(),
          bindingId: command.bindingId,
          bindingRevision: command.bindingRevision,
          executionProfileId: command.executionProfileId,
          profileRevisionId: command.profileRevisionId,
          inputSubmissionId: command.inputSubmissionId,
          orchestrationSessionTurnId: command.orchestrationSessionTurnId,
          now: options.now(),
        });
        sessionExecution.insertAttempt(started.attempt);
        sessionExecution.updateRuntime(started.runtime, runtime.revision);
        attempt = started.attempt;
        externalEffect = Object.freeze({
          kind: "submit_delivery",
          bindingHandle: command.bindingHandle,
          sessionExecutionAttemptId: attempt.sessionExecutionAttemptId,
          content: command.content,
        });
      } else {
        attempt = requiredAttempt(sessionExecution, command.sessionExecutionAttemptId);
        assertAttemptCommandScope(attempt, command);
        if (command.type === "session_runtime.reconcile_attempt") {
          const reconciled = markSessionExecutionReconciliation(runtime, attempt, options.now());
          sessionExecution.updateAttempt(reconciled.attempt, attempt.revision);
          if (reconciled.runtime !== runtime) sessionExecution.updateRuntime(reconciled.runtime, runtime.revision);
          attempt = reconciled.attempt;
          externalEffect = Object.freeze({
            kind: "reconcile_attempt",
            bindingHandle: command.bindingHandle,
            sessionExecutionAttemptId: attempt.sessionExecutionAttemptId,
          });
        } else if (command.type === "session_runtime.request_interrupt") {
          externalEffect = Object.freeze({
            kind: "request_interrupt",
            bindingHandle: command.bindingHandle,
            sessionExecutionAttemptId: attempt.sessionExecutionAttemptId,
            sessionControlAuditId: command.sessionControlAuditId,
          });
        } else {
          const interaction = attempt.interactions.find((candidate) => candidate.interactionId === command.interactionId);
          invariant(Boolean(interaction), "session_execution_interaction_not_found");
          invariant(interaction!.status === "requested", "session_execution_interaction_already_responded");
          invariant(interaction!.revision === command.expectedInteractionRevision, "session_execution_interaction_revision_stale");
          invariant(interaction!.choices.some((choice) => choice.choiceId === command.choiceId), "session_execution_interaction_choice_invalid");
          externalEffect = Object.freeze({
            kind: "respond_interaction",
            bindingHandle: command.bindingHandle,
            sessionExecutionAttemptId: attempt.sessionExecutionAttemptId,
            interactionId: command.interactionId,
            choiceId: command.choiceId,
          });
        }
      }

      const intent = cloneSessionRuntimeProviderEffectIntent({
        providerEffectIntentId: options.createProviderEffectIntentId?.()
          ?? `provider_effect_${command.commandId.slice("command_".length)}`,
        commandId: command.commandId,
        idempotencyKey: command.idempotencyKey,
        commandType: command.type,
        commandFingerprint,
        taskId: command.taskId,
        runId: command.runId,
        logicalSessionId: command.logicalSessionId,
        sessionExecutionRuntimeId: command.sessionExecutionRuntimeId,
        sessionExecutionAttemptId: attempt.sessionExecutionAttemptId,
        inputSubmissionId: command.inputSubmissionId,
        orchestrationSessionTurnId: command.orchestrationSessionTurnId,
        bindingId: command.bindingId,
        bindingRevision: command.bindingRevision,
        executionProfileId: command.executionProfileId,
        profileRevisionId: command.profileRevisionId,
        ...(command.type === "session_runtime.request_interrupt"
          ? { sessionControlAuditId: command.sessionControlAuditId }
          : {}),
        ...(command.type === "session_runtime.respond_interaction"
          ? { interactionId: command.interactionId }
          : {}),
        effect: externalEffect,
        state: "pending",
        createdAt: options.now(),
      });
      providerEffects.insert(intent);
      return Object.freeze({ disposition: "staged" as const, intent, externalEffect });
    });
  }

  function mutateAttempt(
    input: AttemptMutationInput,
    mutation: (attempt: SessionExecutionAttemptRecord, now: string) => SessionExecutionAttemptRecord,
  ): SessionExecutionMutationResult {
    assertSessionExecutionSafeValue(input);
    return options.repository.transaction((records) => {
      const attempt = requiredAttempt(records, input.sessionExecutionAttemptId);
      invariant(attempt.revision === input.expectedAttemptRevision, "session_execution_attempt_revision_stale");
      assertObservationScope(attempt, input);
      const updated = mutation(attempt, options.now());
      if (updated === attempt) {
        return Object.freeze({
          attempt,
          ...(attempt.settlement ? { settlement: attempt.settlement } : {}),
        });
      }
      const runtime = requiredRuntime(records, attempt.sessionExecutionRuntimeId);
      invariant(runtime.activeAttemptId === attempt.sessionExecutionAttemptId, "session_execution_attempt_not_current");
      if (updated !== attempt) records.updateAttempt(updated, attempt.revision);
      if (updated.settlement && runtime.activeAttemptId) {
        records.updateRuntime(settleSessionExecutionRuntime(runtime, updated), runtime.revision);
      } else if (updated.state === "reconciling" && runtime.state !== "reconciling") {
        records.updateRuntime(markSessionExecutionRuntimeReconciling(runtime, updated, updated.updatedAt), runtime.revision);
      } else if (runtime.state === "reconciling" && updated.state !== "reconciling") {
        records.updateRuntime(markSessionExecutionRuntimeExecuting(runtime, updated, updated.updatedAt), runtime.revision);
      }
      return Object.freeze({
        attempt: updated,
        ...(updated.settlement ? { settlement: updated.settlement } : {}),
      });
    });
  }

  function markReconciliation(input: AttemptMutationInput): SessionExecutionMutationResult {
    assertSessionExecutionSafeValue(input);
    return options.repository.transaction((records) => {
      const attempt = requiredAttempt(records, input.sessionExecutionAttemptId);
      invariant(attempt.revision === input.expectedAttemptRevision, "session_execution_attempt_revision_stale");
      const runtime = requiredRuntime(records, attempt.sessionExecutionRuntimeId);
      const reconciled = markSessionExecutionReconciliation(runtime, attempt, options.now());
      records.updateAttempt(reconciled.attempt, attempt.revision);
      if (reconciled.runtime !== runtime) records.updateRuntime(reconciled.runtime, runtime.revision);
      return Object.freeze({ attempt: reconciled.attempt });
    });
  }

  function bindingReadyEvent(input: BindingReadyInput): SessionRuntimeBindingReadyEvent {
    const valid = validateBindingReadyInput(input);
    const runtime = options.repository.getRuntime(valid.sessionExecutionRuntimeId);
    invariant(Boolean(runtime), "session_execution_runtime_not_found");
    invariant(runtime!.logicalSessionId === valid.logicalSessionId, "session_execution_runtime_scope_mismatch");
    return Object.freeze({
      type: "session_runtime.binding_ready",
      sessionExecutionRuntimeId: valid.sessionExecutionRuntimeId,
      logicalSessionId: valid.logicalSessionId,
      bindingId: valid.bindingId,
      bindingRevision: valid.bindingRevision,
      executionProfileId: valid.executionProfileId,
      profileRevisionId: valid.profileRevisionId,
      bindingHandle: valid.bindingHandle,
      recoverable: valid.recoverable,
      observedAt: options.now(),
    });
  }
}

export type SessionExecutionRuntimeOwner = ReturnType<typeof createSessionExecutionRuntimeOwner>;

export type EnsureRuntimeInput = Readonly<{
  taskId: string;
  runId: string;
  logicalSessionId: string;
}>;

export type StartAttemptInput = Readonly<{
  sessionExecutionRuntimeId: string;
  expectedRuntimeRevision: number;
  bindingId: string;
  bindingRevision: number;
  executionProfileId: string;
  profileRevisionId: string;
  inputSubmissionId: string;
  orchestrationSessionTurnId: string;
}>;

export type AttemptMutationInput = Readonly<{
  sessionExecutionAttemptId: string;
  expectedAttemptRevision: number;
}>;

export type SessionExecutionObservationScope = AttemptMutationInput & Readonly<{
  logicalSessionId: string;
  bindingId: string;
  bindingRevision: number;
  executionProfileId: string;
  profileRevisionId: string;
}>;

export type ReceiptInput = AttemptMutationInput & Readonly<{ receiptDigest: string }>;
export type RequestInteractionInput = AttemptMutationInput & Readonly<{
  interactionId: string;
  promptDigest: string;
  choices: readonly Readonly<{ choiceId: string; label: string }>[];
}>;
export type RespondInteractionInput = AttemptMutationInput & Readonly<{
  interactionId: string;
  choiceId: string;
  expectedInteractionRevision: number;
}>;
export type FinalCandidateInput = AttemptMutationInput & Readonly<{
  candidateObservationId: string;
  content: string;
  contentDigest: string;
}>;
export type TerminalInput = AttemptMutationInput & Readonly<{
  terminalObservationId: string;
  outcome: "completed" | "failed" | "cancelled" | "unknown";
  receiptDigest?: string;
}>;
export type DeliveryReceiptObservationInput = SessionExecutionObservationScope & Readonly<{ receiptDigest: string }>;
export type InteractionRequestedObservationInput = SessionExecutionObservationScope & Readonly<{
  interactionId: string;
  promptDigest: string;
  choices: readonly Readonly<{ choiceId: string; label: string }>[];
}>;
export type InteractionResolvedObservationInput = SessionExecutionObservationScope & Readonly<{
  interactionId: string;
  choiceId: string;
  expectedInteractionRevision: number;
}>;
export type FinalCandidateObservationInput = SessionExecutionObservationScope & Readonly<{
  candidateObservationId: string;
  content: string;
  contentDigest: string;
}>;
export type PromptTerminalObservationInput = SessionExecutionObservationScope & Readonly<{
  terminalObservationId: string;
  outcome: "completed" | "failed" | "cancelled" | "unknown";
  receiptDigest?: string;
}>;
export type BindingReadyInput = Readonly<{
  sessionExecutionRuntimeId: string;
  logicalSessionId: string;
  bindingId: string;
  bindingRevision: number;
  executionProfileId: string;
  profileRevisionId: string;
  bindingHandle: string;
  recoverable: boolean;
}>;

export function validateBindingReadyInput(value: unknown): BindingReadyInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("session_runtime_binding_ready_input_shape_invalid");
  }
  const root = value as Record<string, unknown>;
  const keys = [
    "sessionExecutionRuntimeId",
    "logicalSessionId",
    "bindingId",
    "bindingRevision",
    "executionProfileId",
    "profileRevisionId",
    "bindingHandle",
    "recoverable",
  ] as const;
  const actual = Object.keys(root);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key as typeof keys[number]))) {
    throw new Error("session_runtime_binding_ready_input_shape_invalid");
  }
  assertSessionExecutionSafeValue(root, "session runtime binding ready input");
  const sessionExecutionRuntimeId = bindingReadyId(root.sessionExecutionRuntimeId, "session_execution_runtime", "sessionExecutionRuntimeId");
  const logicalSessionId = bindingReadyId(root.logicalSessionId, "logical_session", "logicalSessionId");
  const bindingId = bindingReadyId(root.bindingId, "binding", "bindingId");
  const executionProfileId = bindingReadyId(root.executionProfileId, "profile", "executionProfileId");
  const profileRevisionId = bindingReadyId(root.profileRevisionId, "profile_revision", "profileRevisionId");
  if (!Number.isSafeInteger(root.bindingRevision) || (root.bindingRevision as number) < 1) {
    throw new Error("session_execution_binding_revision_invalid");
  }
  assertBindingHandle(root.bindingHandle);
  if (typeof root.recoverable !== "boolean") throw new Error("session_runtime_binding_ready_recoverable_invalid");
  return Object.freeze({
    sessionExecutionRuntimeId,
    logicalSessionId,
    bindingId,
    bindingRevision: root.bindingRevision as number,
    executionProfileId,
    profileRevisionId,
    bindingHandle: root.bindingHandle,
    recoverable: root.recoverable,
  });
}

function bindingReadyId(value: unknown, prefix: string, field: string): string {
  if (typeof value !== "string" || value.length > 256
    || !new RegExp(`^${prefix}_[A-Za-z0-9_-]+$`, "u").test(value)) {
    throw new Error(`session_runtime_binding_ready_id_invalid:${field}`);
  }
  return value;
}

function requiredRuntime(records: SessionExecutionRecordRepository, id: string): SessionExecutionRuntimeRecord {
  const runtime = records.getRuntime(id);
  invariant(Boolean(runtime), "session_execution_runtime_not_found");
  return runtime!;
}

function requiredAttempt(records: SessionExecutionRecordRepository, id: string): SessionExecutionAttemptRecord {
  const attempt = records.getAttempt(id);
  invariant(Boolean(attempt), "session_execution_attempt_not_found");
  return attempt!;
}

function assertCommandRuntimeScope(runtime: SessionExecutionRuntimeRecord, command: SessionRuntimeCommand): void {
  invariant(runtime.taskId === command.taskId && runtime.runId === command.runId
    && runtime.logicalSessionId === command.logicalSessionId, "session_runtime_command_scope_mismatch");
  invariant(runtime.revision === command.expectedRuntimeRevision, "session_execution_runtime_revision_stale");
}

function assertAttemptCommandScope(
  attempt: SessionExecutionAttemptRecord,
  command: Exclude<SessionRuntimeCommand, { type: "session_runtime.submit_delivery" }>,
): void {
  invariant(attempt.sessionExecutionRuntimeId === command.sessionExecutionRuntimeId
    && attempt.logicalSessionId === command.logicalSessionId
    && attempt.bindingId === command.bindingId
    && attempt.bindingRevision === command.bindingRevision
    && attempt.executionProfileId === command.executionProfileId
    && attempt.profileRevisionId === command.profileRevisionId
    && attempt.inputSubmissionId === command.inputSubmissionId
    && attempt.orchestrationSessionTurnId === command.orchestrationSessionTurnId,
  "session_runtime_command_attempt_correlation_mismatch");
  invariant(attempt.revision === command.expectedAttemptRevision, "session_execution_attempt_revision_stale");
}

function assertObservationScope(attempt: SessionExecutionAttemptRecord, input: AttemptMutationInput): void {
  if (!("logicalSessionId" in input)) return;
  const scoped = input as SessionExecutionObservationScope;
  invariant(attempt.logicalSessionId === scoped.logicalSessionId
    && attempt.bindingId === scoped.bindingId
    && attempt.bindingRevision === scoped.bindingRevision
    && attempt.executionProfileId === scoped.executionProfileId
    && attempt.profileRevisionId === scoped.profileRevisionId,
  "session_execution_observation_correlation_mismatch");
}

import {
  assertSessionExecutionSafeValue,
  cloneAcpV3BindingRetirementIntentRecord,
  hashDefinition,
  validateTaskArchitectureSnapshotV3,
  type AcpSafeSessionBindingRecordV3,
  type AcpV3BindingRetirementIntentRecord,
  type JsonValue,
  type SessionControlAuditRecord,
  type SessionExecutionAttemptRecord,
  type SessionExecutionRuntimeRecord,
  type SessionLaneItemRecord,
  type SessionRuntimeProviderEffectIntentRecord,
  type TaskArchitectureSnapshotV3,
} from "@agent-workspace/runtime-contracts";
import { invariant } from "@agent-workspace/runtime-domain";
import type {
  AcpV3BindingRepository,
  AcpV3ReliabilityRepository,
  SessionIdHumanInterventionRecord,
  SessionIdInputSubmissionRecord,
  SessionIdSessionTurnRecord,
  SessionIdUiCommandReceiptRecord,
} from "@agent-workspace/runtime-store";

export type SessionIdAcpTaskStopCommand = Readonly<{
  type: "task.stop";
  commandId: string;
  idempotencyKey: string;
  taskId: string;
  runId: string;
  expectedRevision: number;
  issuedAt: string;
}>;

/** Existing Renderer task.stop result is intentionally empty; status is read-model truth. */
export type SessionIdAcpTaskStopResult = Readonly<Record<string, never>>;

export type SessionIdAcpTaskStopCommit = Readonly<{
  result: SessionIdAcpTaskStopResult;
  /** Host-only durable drain identities; the Runtime Bridge returns only `result`. */
  interruptProviderEffectIntentIds: readonly string[];
  bindingRetirementIntentIds: readonly string[];
}>;

export type SessionIdAcpTaskStopReconcileResult = Readonly<{
  status: "not_stopping" | "waiting_provider" | "stopped";
}>;

export interface SessionIdAcpTaskStopTaskRunCapability {
  readExactStopState(taskId: string, runId: string): Readonly<{
    taskId: string;
    runId: string;
    taskRevision: number;
    taskStatus: string;
    runStatus: string;
    architectureSnapshotId: string;
    architectureSchemaVersion: number;
    conductorSessionId: string;
  }>;
  acceptTaskStop(input: Readonly<{
    taskId: string;
    runId: string;
    commandId: string;
    expectedRevision: number;
    nextRevision: number;
    acceptedAt: string;
  }>): void;
  /** Task/Run owner clears current Card slots and retires the Conductor Session only. */
  retireCurrentSessionsForTaskStop(input: Readonly<{
    taskId: string;
    runId: string;
    completedAt: string;
  }>): void;
  /** ACP-only completion; this capability must never inspect the retained direct Binding table. */
  completeAcpTaskStop(input: Readonly<{
    taskId: string;
    runId: string;
    expectedRevision: number;
    nextRevision: number;
    completedAt: string;
  }>): void;
}

export interface SessionIdAcpTaskStopOrchestrationCapability {
  listInboxItems(logicalSessionId: string): readonly SessionLaneItemRecord[];
  updateInboxItem(item: SessionLaneItemRecord, expectedState: SessionLaneItemRecord["state"]): void;
  findInputByInboxItem(inboxItemId: string): SessionIdInputSubmissionRecord | undefined;
  updateInputSubmission(input: SessionIdInputSubmissionRecord, expectedState: SessionIdInputSubmissionRecord["state"]): void;
  findTurnByInputSubmission(inputSubmissionId: string): SessionIdSessionTurnRecord | undefined;
  updateTurn(turn: SessionIdSessionTurnRecord, expectedState: SessionIdSessionTurnRecord["state"]): void;
  createControlAudit(control: SessionControlAuditRecord): void;
  getControlAudit(sessionControlAuditId: string): SessionControlAuditRecord | undefined;
  findControlByIdempotencyKey(taskId: string, runId: string, idempotencyKey: string): SessionControlAuditRecord | undefined;
  listControlAudits(runId: string, logicalSessionId?: string): readonly SessionControlAuditRecord[];
}

export interface SessionIdAcpTaskStopHumanCapability {
  get(humanInterventionId: string): SessionIdHumanInterventionRecord | undefined;
  list(runId: string, targetLogicalSessionId?: string): readonly SessionIdHumanInterventionRecord[];
  update(intervention: SessionIdHumanInterventionRecord): void;
}

export interface SessionIdAcpTaskStopExecutionCapability {
  getRuntimeForSession(logicalSessionId: string): SessionExecutionRuntimeRecord | undefined;
  getAttempt(sessionExecutionAttemptId: string): SessionExecutionAttemptRecord | undefined;
  listAttempts(sessionExecutionRuntimeId: string): readonly SessionExecutionAttemptRecord[];
}

export interface SessionIdAcpTaskStopBindingCapability extends Pick<
  AcpV3BindingRepository,
  "getBinding" | "getCurrentBinding" | "listBindings"
> {
  listBindingsForRun(taskId: string, runId: string): readonly AcpSafeSessionBindingRecordV3[];
}

export interface SessionIdAcpTaskStopReceiptCapability {
  createUiCommandReceipt(receipt: SessionIdUiCommandReceiptRecord): void;
  getUiCommandReceipt(taskId: string, commandId: string): SessionIdUiCommandReceiptRecord | undefined;
}

export interface SessionIdAcpTaskStopReliabilityCapability extends AcpV3ReliabilityRepository {
  /** Reliability owner prevents any pre-Stop delivery intent not yet handed to the adapter from draining. */
  suppressUnhandedProviderEffectIntents(input: Readonly<{
    taskId: string;
    runId: string;
    logicalSessionId: string;
    inputSubmissionIds: readonly string[];
    suppressedAt: string;
  }>): readonly string[];
}

export type SessionIdAcpTaskStopCapabilities = Readonly<{
  taskRun: SessionIdAcpTaskStopTaskRunCapability;
  orchestration: SessionIdAcpTaskStopOrchestrationCapability;
  humanIntervention: SessionIdAcpTaskStopHumanCapability;
  binding: SessionIdAcpTaskStopBindingCapability;
  sessionExecution: SessionIdAcpTaskStopExecutionCapability;
  reliability: SessionIdAcpTaskStopReliabilityCapability;
  commandReceipts: SessionIdAcpTaskStopReceiptCapability;
}>;

export type SessionIdAcpTaskStopApplicationOptions = Readonly<{
  now: () => string;
  createId(kind: "session_control" | "binding_retirement" | "command"): string;
  architecture: TaskArchitectureSnapshotV3;
  task: Readonly<{ taskId: string; runId: string }>;
  transaction: Readonly<{
    run<T>(work: (owners: SessionIdAcpTaskStopCapabilities) => T): T;
  }>;
  interruptBridge: Readonly<{
    stageInterrupt(input: Readonly<{ sessionControlAuditId: string }>): Readonly<{
      providerEffectIntentId: string;
    }>;
  }>;
  provider: Readonly<{
    executeProviderEffect(providerEffectIntentId: string): Promise<unknown>;
    retireBinding(bindingRetirementIntentId: string): Promise<unknown>;
  }>;
}>;

export function createSessionIdAcpTaskStopApplication(options: SessionIdAcpTaskStopApplicationOptions) {
  const architecture = validateTaskArchitectureSnapshotV3(options.architecture);
  validateOptions(options);
  invariant(options.task.taskId === architecture.taskId, "acp_task_stop_options_scope_mismatch");
  return Object.freeze({ stopTask, pumpTaskStop, reconcileTaskStop });

  function stopTask(value: unknown): SessionIdAcpTaskStopCommit {
    const command = validateCommand(value);
    invariant(command.taskId === options.task.taskId && command.runId === options.task.runId,
      "acp_task_stop_command_scope_mismatch");
    const fingerprint = hashDefinition(command as unknown as JsonValue);
    return options.transaction.run((owners) => {
      const replay = replayReceipt(owners, command, fingerprint);
      if (replay) return replay;
      const state = requireExactRun(owners, command.taskId, command.runId);
      invariant(state.taskRevision === command.expectedRevision, "acp_task_stop_revision_stale");
      invariant(state.taskStatus === "running" && state.runStatus === "running",
        "acp_task_stop_run_not_running");
      const now = exactTime(options.now());

      // The Task/Run stop fence becomes visible inside this same transaction;
      // any later owner failure rolls it back with every suppression/intent.
      owners.taskRun.acceptTaskStop({
        taskId: command.taskId,
        runId: command.runId,
        commandId: command.commandId,
        expectedRevision: command.expectedRevision,
        nextRevision: command.expectedRevision + 1,
        acceptedAt: now,
      });

      const bindings = owners.binding.listBindingsForRun(command.taskId, command.runId);
      const sessionIds = Object.freeze([...new Set([state.conductorSessionId,
        ...bindings.map((binding) => binding.logicalSessionId)])]);
      suppressUnhanded(owners, command.taskId, command.runId, sessionIds, now);

      const interruptIds: string[] = [];
      for (const logicalSessionId of sessionIds) {
        const runtime = owners.sessionExecution.getRuntimeForSession(logicalSessionId);
        const attempt = runtime?.activeAttemptId
          ? owners.sessionExecution.getAttempt(runtime.activeAttemptId)
          : undefined;
        if (!attempt || attempt.settlement) continue;
        const control = ensureTaskStopControl(
          owners,
          command,
          logicalSessionId,
          `task_stop_interrupt:${command.runId}:${attempt.sessionExecutionAttemptId}`,
          `attempt:${attempt.sessionExecutionAttemptId}${attempt.interactions.some((item) => item.status === "requested")
            ? ":pending_interaction" : ""}`,
          now,
          () => allocatedId("session_control", "session_control"),
        );
        const effect = options.interruptBridge.stageInterrupt({
          sessionControlAuditId: control.sessionControlAuditId,
        });
        interruptIds.push(prefixedId(effect.providerEffectIntentId, "provider_effect", "acp_task_stop_interrupt_intent_invalid"));
      }

      const retirementIds: string[] = [];
      for (const binding of bindings) {
        if (binding.status === "released" || binding.status === "unrecoverable") continue;
        invariant(owners.binding.getCurrentBinding(binding.logicalSessionId)?.bindingId === binding.bindingId,
          "acp_task_stop_binding_not_current");
        const control = ensureTaskStopControl(
          owners,
          command,
          binding.logicalSessionId,
          `task_stop_retire:${command.runId}:${binding.bindingId}`,
          `binding:${binding.bindingId}`,
          now,
          () => allocatedId("session_control", "session_control"),
        );
        const retirement = owners.reliability.createBindingRetirementIntent(
          cloneAcpV3BindingRetirementIntentRecord({
            bindingRetirementIntentId: allocatedId("binding_retirement", "binding_retirement"),
            commandId: allocatedId("command", "command"),
            idempotencyKey: control.idempotencyKey,
            taskId: command.taskId,
            runId: command.runId,
            logicalSessionId: binding.logicalSessionId,
            bindingId: binding.bindingId,
            bindingRevision: binding.revision,
            bindingHandle: binding.bindingHandle,
            executionProfileId: binding.executionProfileId,
            profileRevisionId: binding.profileRevisionId,
            providerFamily: binding.providerFamily,
            sessionControlAuditId: control.sessionControlAuditId,
            state: "pending",
            attempts: 0,
            revision: 1,
            createdAt: now,
            updatedAt: now,
          }),
        );
        retirementIds.push(retirement.bindingRetirementIntentId);
      }

      const commit = freezeCommit({
        result: Object.freeze({}),
        interruptProviderEffectIntentIds: interruptIds,
        bindingRetirementIntentIds: retirementIds,
      });
      owners.commandReceipts.createUiCommandReceipt(Object.freeze({
        commandId: command.commandId,
        taskId: command.taskId,
        runId: command.runId,
        commandKind: "task.stop",
        idempotencyKey: command.idempotencyKey,
        payloadFingerprint: fingerprint,
        result: commit as unknown as JsonValue,
        createdAt: now,
      }));
      return commit;
    });
  }

  async function pumpTaskStop(): Promise<SessionIdAcpTaskStopReconcileResult> {
    const durable = options.transaction.run((owners) => {
      const state = requireExactRun(owners, architecture.taskId, options.task.runId);
      if (state.runStatus !== "stopping") return Object.freeze({
        interruptIntents: [] as SessionRuntimeProviderEffectIntentRecord[],
        retirementIntents: [] as AcpV3BindingRetirementIntentRecord[],
      });
      const controls = new Set(owners.orchestration.listControlAudits(state.runId)
        .filter((control) => control.kind === "task_stop")
        .map((control) => control.sessionControlAuditId));
      const interruptIntents = owners.reliability.listProviderEffectIntents()
        .filter((intent) => intent.commandType === "session_runtime.request_interrupt"
          && intent.taskId === architecture.taskId
          && intent.runId === state.runId
          && intent.sessionControlAuditId !== undefined
          && controls.has(intent.sessionControlAuditId))
      const retirementIntents = owners.reliability.listBindingRetirementIntents()
        .filter((intent) => intent.taskId === architecture.taskId && intent.runId === state.runId)
      return Object.freeze({ interruptIntents, retirementIntents });
    });
    try {
      for (const intent of durable.interruptIntents) {
        const attempt = options.transaction.run((owners) =>
          owners.sessionExecution.getAttempt(intent.sessionExecutionAttemptId));
        if (!attempt?.settlement) await options.provider.executeProviderEffect(intent.providerEffectIntentId);
      }
    } catch {
      return Object.freeze({ status: "waiting_provider" });
    }
    const unsettled = options.transaction.run((owners) => hasUnsettledAttempts(owners, options.task.taskId, options.task.runId));
    if (unsettled) return Object.freeze({ status: "waiting_provider" });
    try {
      for (const intent of durable.retirementIntents) {
        if (intent.state === "pending" || intent.state === "retiring") {
          await options.provider.retireBinding(intent.bindingRetirementIntentId);
        }
      }
    } catch {
      return Object.freeze({ status: "waiting_provider" });
    }
    return reconcileTaskStop();
  }

  function reconcileTaskStop(): SessionIdAcpTaskStopReconcileResult {
    return options.transaction.run((owners) => {
      const state = requireExactRun(owners, architecture.taskId, options.task.runId);
      if (state.runStatus === "stopped") return Object.freeze({ status: "stopped" });
      if (state.runStatus !== "stopping") return Object.freeze({ status: "not_stopping" });
      const bindings = owners.binding.listBindingsForRun(architecture.taskId, state.runId);
      const retirements = owners.reliability.listBindingRetirementIntents()
        .filter((intent) => intent.taskId === architecture.taskId && intent.runId === state.runId);
      if (retirements.some((intent) => intent.state === "unknown" || intent.state === "pending" || intent.state === "retiring")) {
        return Object.freeze({ status: "waiting_provider" });
      }
      if (bindings.some((binding) => binding.status !== "released" && binding.status !== "unrecoverable")) {
        return Object.freeze({ status: "waiting_provider" });
      }
      for (const binding of bindings) {
        const runtime = owners.sessionExecution.getRuntimeForSession(binding.logicalSessionId);
        if (!runtime) continue;
        if (runtime.activeAttemptId) return Object.freeze({ status: "waiting_provider" });
        if (owners.sessionExecution.listAttempts(runtime.sessionExecutionRuntimeId)
          .some((attempt) => !attempt.settlement)) {
          return Object.freeze({ status: "waiting_provider" });
        }
      }
      const now = exactTime(options.now());
      owners.taskRun.retireCurrentSessionsForTaskStop({
        taskId: architecture.taskId,
        runId: state.runId,
        completedAt: now,
      });
      owners.taskRun.completeAcpTaskStop({
        taskId: architecture.taskId,
        runId: state.runId,
        expectedRevision: state.taskRevision,
        nextRevision: state.taskRevision + 1,
        completedAt: now,
      });
      return Object.freeze({ status: "stopped" });
    });
  }

  function requireExactRun(
    owners: SessionIdAcpTaskStopCapabilities,
    taskId: string,
    runId: string,
  ) {
    const state = owners.taskRun.readExactStopState(taskId, runId);
    invariant(state.taskId === taskId && state.runId === runId,
      "acp_task_stop_run_scope_mismatch");
    invariant(state.architectureSnapshotId === architecture.architectureSnapshotId
      && state.architectureSchemaVersion === 3,
    "acp_task_stop_architecture_not_current_v3");
    return state;
  }

  function allocatedId(
    kind: "session_control" | "binding_retirement" | "command",
    prefix: string,
  ): string {
    return prefixedId(options.createId(kind), prefix, "acp_task_stop_allocated_id_invalid");
  }
}

function suppressUnhanded(
  owners: SessionIdAcpTaskStopCapabilities,
  taskId: string,
  runId: string,
  sessionIds: readonly string[],
  now: string,
): void {
  const interventionIds = new Set<string>();
  for (const sessionId of sessionIds) {
    const suppressedInputIds: string[] = [];
    for (const item of owners.orchestration.listInboxItems(sessionId)) {
      const input = owners.orchestration.findInputByInboxItem(item.inboxItemId);
      const suppressible = item.state === "pending" || item.state === "held_by_human_intervention"
        || (item.state === "leased" && input?.state === "pending");
      if (item.runId !== runId || !suppressible) continue;
      if (input?.state === "pending") {
        suppressedInputIds.push(input.inputSubmissionId);
        const turn = owners.orchestration.findTurnByInputSubmission(input.inputSubmissionId);
        if (turn?.state === "pending") {
          owners.orchestration.updateTurn({ ...turn, state: "cancelled", updatedAt: now, settledAt: now }, "pending");
        }
        owners.orchestration.updateInputSubmission({ ...input, state: "cancelled", updatedAt: now }, "pending");
      }
      owners.orchestration.updateInboxItem({ ...item, state: "suppressed", reason: "task_stopped", updatedAt: now }, item.state);
      if (item.humanInterventionId) interventionIds.add(item.humanInterventionId);
    }
    owners.reliability.suppressUnhandedProviderEffectIntents({
      taskId,
      runId,
      logicalSessionId: sessionId,
      inputSubmissionIds: Object.freeze(suppressedInputIds),
      suppressedAt: now,
    });
  }
  for (const intervention of owners.humanIntervention.list(runId)) {
    if (intervention.state === "resolved" || intervention.state === "abandoned"
      || intervention.state === "cancelled_by_task_stop") continue;
    interventionIds.add(intervention.humanInterventionId);
  }
  for (const interventionId of interventionIds) {
    const intervention = owners.humanIntervention.get(interventionId);
    if (!intervention || intervention.state === "resolved" || intervention.state === "abandoned"
      || intervention.state === "cancelled_by_task_stop") continue;
    owners.humanIntervention.update({ ...intervention, state: "cancelled_by_task_stop", updatedAt: now });
  }
}

function hasUnsettledAttempts(
  owners: SessionIdAcpTaskStopCapabilities,
  taskId: string,
  runId: string,
): boolean {
  for (const binding of owners.binding.listBindingsForRun(taskId, runId)) {
    const runtime = owners.sessionExecution.getRuntimeForSession(binding.logicalSessionId);
    if (!runtime) continue;
    if (runtime.activeAttemptId) return true;
    if (owners.sessionExecution.listAttempts(runtime.sessionExecutionRuntimeId).some((attempt) => !attempt.settlement)) {
      return true;
    }
  }
  return false;
}

function ensureTaskStopControl(
  owners: SessionIdAcpTaskStopCapabilities,
  command: SessionIdAcpTaskStopCommand,
  logicalSessionId: string,
  idempotencyKey: string,
  reason: string,
  now: string,
  createControlId: () => string,
): SessionControlAuditRecord {
  const existing = owners.orchestration.findControlByIdempotencyKey(command.taskId, command.runId, idempotencyKey);
  if (existing) {
    invariant(existing.kind === "task_stop"
      && existing.commandId === command.commandId
      && existing.sessionId === logicalSessionId
      && (existing.state === "requested" || existing.state === "accepted"),
    "acp_task_stop_control_replay_conflict");
    return existing;
  }
  const control = Object.freeze({
    sessionControlAuditId: createControlId(),
    taskId: command.taskId,
    runId: command.runId,
    sessionId: logicalSessionId,
    commandId: command.commandId,
    idempotencyKey,
    kind: "task_stop" as const,
    state: "requested" as const,
    affectedInboxItemIds: Object.freeze([]),
    requestedAt: now,
    reason,
  });
  owners.orchestration.createControlAudit(control);
  return control;
}

function replayReceipt(
  owners: SessionIdAcpTaskStopCapabilities,
  command: SessionIdAcpTaskStopCommand,
  fingerprint: string,
): SessionIdAcpTaskStopCommit | undefined {
  const receipt = owners.commandReceipts.getUiCommandReceipt(command.taskId, command.commandId);
  if (!receipt) return undefined;
  invariant(receipt.taskId === command.taskId
    && receipt.runId === command.runId
    && receipt.commandKind === "task.stop"
    && receipt.idempotencyKey === command.idempotencyKey
    && receipt.payloadFingerprint === fingerprint,
  "acp_task_stop_command_replay_conflict");
  return validateCommit(receipt.result);
}

function validateCommand(value: unknown): SessionIdAcpTaskStopCommand {
  assertSessionExecutionSafeValue(value, "ACP task.stop command");
  invariant(Boolean(value) && typeof value === "object" && !Array.isArray(value),
    "acp_task_stop_command_shape_invalid");
  const root = value as Record<string, unknown>;
  const keys = ["type", "commandId", "idempotencyKey", "taskId", "runId", "expectedRevision", "issuedAt"];
  invariant(Object.keys(root).length === keys.length && Object.keys(root).every((key) => keys.includes(key)),
    "acp_task_stop_command_shape_invalid");
  invariant(root.type === "task.stop", "acp_task_stop_command_type_invalid");
  return Object.freeze({
    type: "task.stop",
    commandId: prefixedId(root.commandId, "command", "acp_task_stop_command_id_invalid"),
    idempotencyKey: safeText(root.idempotencyKey, "acp_task_stop_idempotency_key_invalid"),
    taskId: prefixedId(root.taskId, "task", "acp_task_stop_task_id_invalid"),
    runId: prefixedId(root.runId, "run", "acp_task_stop_run_id_invalid"),
    expectedRevision: positiveInteger(root.expectedRevision, "acp_task_stop_revision_invalid"),
    issuedAt: exactTime(root.issuedAt),
  });
}

function validateCommit(value: unknown): SessionIdAcpTaskStopCommit {
  assertSessionExecutionSafeValue(value, "ACP task.stop commit");
  invariant(Boolean(value) && typeof value === "object" && !Array.isArray(value),
    "acp_task_stop_commit_invalid");
  const root = value as Record<string, unknown>;
  invariant(Object.keys(root).sort().join(",")
    === "bindingRetirementIntentIds,interruptProviderEffectIntentIds,result",
  "acp_task_stop_commit_invalid");
  const result = root.result as Record<string, unknown>;
  invariant(Boolean(result) && typeof result === "object" && !Array.isArray(result)
    && Object.keys(result).length === 0,
  "acp_task_stop_commit_invalid");
  invariant(Array.isArray(root.interruptProviderEffectIntentIds)
    && Array.isArray(root.bindingRetirementIntentIds), "acp_task_stop_commit_invalid");
  return freezeCommit({
    result: Object.freeze({}),
    interruptProviderEffectIntentIds: root.interruptProviderEffectIntentIds.map((id) =>
      prefixedId(id, "provider_effect", "acp_task_stop_commit_invalid")),
    bindingRetirementIntentIds: root.bindingRetirementIntentIds.map((id) =>
      prefixedId(id, "binding_retirement", "acp_task_stop_commit_invalid")),
  });
}

function freezeCommit(value: SessionIdAcpTaskStopCommit): SessionIdAcpTaskStopCommit {
  return Object.freeze({
    result: Object.freeze({ ...value.result }),
    interruptProviderEffectIntentIds: Object.freeze([...value.interruptProviderEffectIntentIds]),
    bindingRetirementIntentIds: Object.freeze([...value.bindingRetirementIntentIds]),
  });
}

function validateOptions(options: SessionIdAcpTaskStopApplicationOptions): void {
  invariant(typeof options.now === "function"
    && typeof options.createId === "function"
    && Boolean(options.task)
    && typeof options.transaction?.run === "function"
    && typeof options.interruptBridge?.stageInterrupt === "function"
    && typeof options.provider?.executeProviderEffect === "function"
    && typeof options.provider?.retireBinding === "function",
  "acp_task_stop_options_invalid");
}

function prefixedId(value: unknown, prefix: string, code: string): string {
  invariant(typeof value === "string" && value.length <= 256
    && new RegExp(`^${prefix}_[A-Za-z0-9_-]+$`, "u").test(value), code);
  return value as string;
}

function safeText(value: unknown, code: string): string {
  invariant(typeof value === "string" && value.length > 0 && value.length <= 512 && !/[\r\n]/u.test(value), code);
  return value as string;
}

function positiveInteger(value: unknown, code: string): number {
  invariant(Number.isSafeInteger(value) && (value as number) > 0, code);
  return value as number;
}

function exactTime(value: unknown): string {
  invariant(typeof value === "string" && new Date(value).toISOString() === value,
    "acp_task_stop_time_invalid");
  return value as string;
}

import { describe, expect, it, vi } from "vitest";
import {
  cloneAcpV3BindingRetirementIntentRecord,
  cloneSessionRuntimeProviderEffectIntent,
  hashDefinition,
  renderTaskGoalContentV1,
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
import { BUILT_IN_ACP_STARTER_PACKAGES } from "./built-in-templates.js";
import {
  createSessionIdAcpTaskStopApplication,
  type SessionIdAcpTaskStopCapabilities,
} from "./session-id-acp-task-stop-application.js";
import type {
  SessionIdHumanInterventionRecord,
  SessionIdInputSubmissionRecord,
  SessionIdSessionTurnRecord,
  SessionIdUiCommandReceiptRecord,
} from "@agent-workspace/runtime-store";

const NOW = "2026-08-12T00:00:00.000Z";

describe("ACP-only Task Stop application", () => {
  it("atomically enters stopping, suppresses held/leased work, audits interaction and stages v3 intents", () => {
    const fixture = createFixture({ activeAttempt: true });
    const commit = fixture.app.stopTask(stopCommand());

    expect(commit.result).toEqual({});
    expect(commit.interruptProviderEffectIntentIds).toHaveLength(1);
    expect(commit.bindingRetirementIntentIds).toHaveLength(1);
    expect(fixture.state.taskStatus).toBe("stopping");
    expect(fixture.state.runStatus).toBe("stopping");
    expect(fixture.state.taskRevision).toBe(8);
    expect(fixture.state.inbox.filter((item) => item.state === "suppressed")).toHaveLength(2);
    expect(fixture.state.inbox.find((item) => item.inboxItemId === "inbox_handed")?.state).toBe("handed");
    expect(fixture.state.inputs.filter((input) => input.state === "cancelled")).toHaveLength(2);
    expect(fixture.state.interventions[0]?.state).toBe("cancelled_by_task_stop");
    expect(fixture.state.controls).toEqual([
      expect.objectContaining({ kind: "task_stop", state: "requested", reason: expect.stringContaining("pending_interaction") }),
      expect.objectContaining({ kind: "task_stop", state: "requested", reason: "binding:binding_stop_acp" }),
    ]);
    expect(fixture.state.providerEffects).toEqual([
      expect.objectContaining({ commandType: "session_runtime.request_interrupt" }),
    ]);
    expect(fixture.state.retirements).toEqual([
      expect.objectContaining({
        state: "pending",
        sessionControlAuditId: fixture.state.controls[1]!.sessionControlAuditId,
        idempotencyKey: fixture.state.controls[1]!.idempotencyKey,
      }),
    ]);
    expect(fixture.state.suppressedEffectInputs).toEqual(expect.arrayContaining([
      "input_held", "input_leased",
    ]));

    expect(fixture.app.stopTask(stopCommand())).toEqual(commit);
    expect(fixture.state.controls).toHaveLength(2);
    expect(fixture.state.retirements).toHaveLength(1);
  });

  it("rolls back Task/Run, suppression, Control and intents when interrupt staging fails", () => {
    const fixture = createFixture({ activeAttempt: true, failInterrupt: true });
    const before = fixture.snapshot();
    expect(() => fixture.app.stopTask(stopCommand())).toThrow("controlled_interrupt_stage_failure");
    expect(fixture.snapshot()).toEqual(before);
  });

  it("keeps unknown or active Attempt stopping and completes only from durable terminal truth", async () => {
    const active = createFixture({ activeAttempt: true });
    active.app.stopTask(stopCommand());
    await expect(active.app.pumpTaskStop()).resolves.toEqual({ status: "waiting_provider" });
    expect(active.provider.retireBinding).not.toHaveBeenCalled();
    expect(active.state.runStatus).toBe("stopping");

    const idle = createFixture({ activeAttempt: false });
    idle.app.stopTask(stopCommand());
    idle.setRetirementState("unknown");
    expect(idle.app.reconcileTaskStop()).toEqual({ status: "waiting_provider" });
    expect(idle.state.runStatus).toBe("stopping");

    idle.setRetirementState("released");
    idle.setBindingReleased();
    expect(idle.app.reconcileTaskStop()).toEqual({ status: "stopped" });
    expect(idle.state.runStatus).toBe("stopped");
    expect(idle.state.retiredSessions).toBe(1);
  });

  it("rejects extra command fields and stale concurrent revisions before any write", () => {
    const unsafe = createFixture({ activeAttempt: false });
    expect(() => unsafe.app.stopTask({ ...stopCommand(), rawSessionId: "forbidden" })).toThrow();
    expect(unsafe.state.runStatus).toBe("running");
    expect(() => unsafe.app.stopTask({ ...stopCommand(), expectedRevision: 6 })).toThrow("acp_task_stop_revision_stale");
    expect(unsafe.state.runStatus).toBe("running");
  });
});

function createFixture(options: Readonly<{ activeAttempt: boolean; failInterrupt?: boolean }>) {
  const architecture = taskArchitecture();
  const binding = bindingRecord(architecture);
  const runtime = runtimeRecord(options.activeAttempt);
  const attempt = options.activeAttempt ? attemptRecord() : undefined;
  const state = {
    taskRevision: 7,
    taskStatus: "running",
    runStatus: "running",
    inbox: laneRecords(),
    inputs: inputRecords(),
    turns: turnRecords(),
    interventions: [interventionRecord()] as SessionIdHumanInterventionRecord[],
    controls: [] as SessionControlAuditRecord[],
    providerEffects: [] as SessionRuntimeProviderEffectIntentRecord[],
    retirements: [] as AcpV3BindingRetirementIntentRecord[],
    receipts: [] as SessionIdUiCommandReceiptRecord[],
    bindings: [binding] as AcpSafeSessionBindingRecordV3[],
    runtime,
    attempt,
    suppressedEffectInputs: [] as string[],
    retiredSessions: 0,
  };
  let sequence = 0;
  const capabilities = capabilitiesFor(state, architecture);
  let insideTransaction = false;
  const transaction = {
    run<T>(work: (owners: SessionIdAcpTaskStopCapabilities) => T): T {
      const before = structuredClone(state);
      insideTransaction = true;
      try {
        return work(capabilities);
      } catch (error) {
        restore(state, before);
        throw error;
      } finally {
        insideTransaction = false;
      }
    },
  };
  const provider = {
    executeProviderEffect: vi.fn(async () => ({ disposition: "reconciling" })),
    retireBinding: vi.fn(async () => ({ disposition: "released" })),
  };
  const app = createSessionIdAcpTaskStopApplication({
    now: () => NOW,
    createId(kind) {
      sequence += 1;
      return `${kind}_stop_${sequence}`;
    },
    architecture,
    task: { taskId: "task_stop_acp", runId: "run_stop_acp" },
    transaction,
    interruptBridge: {
      stageInterrupt({ sessionControlAuditId }) {
        if (!insideTransaction) throw new Error("interrupt_outside_outer_transaction");
        if (options.failInterrupt) throw new Error("controlled_interrupt_stage_failure");
        const control = state.controls.find((candidate) => candidate.sessionControlAuditId === sessionControlAuditId)!;
        const currentAttempt = state.attempt!;
        const intent = cloneSessionRuntimeProviderEffectIntent({
          providerEffectIntentId: `provider_effect_${sessionControlAuditId}`,
          commandId: `command_interrupt_${sessionControlAuditId}`,
          idempotencyKey: `request_interrupt:${sessionControlAuditId}`,
          commandType: "session_runtime.request_interrupt",
          commandFingerprint: hashDefinition({ sessionControlAuditId }),
          taskId: control.taskId,
          runId: control.runId,
          logicalSessionId: control.sessionId,
          sessionExecutionRuntimeId: currentAttempt.sessionExecutionRuntimeId,
          sessionExecutionAttemptId: currentAttempt.sessionExecutionAttemptId,
          inputSubmissionId: currentAttempt.inputSubmissionId,
          orchestrationSessionTurnId: currentAttempt.orchestrationSessionTurnId,
          bindingId: currentAttempt.bindingId,
          bindingRevision: currentAttempt.bindingRevision,
          executionProfileId: currentAttempt.executionProfileId,
          profileRevisionId: currentAttempt.profileRevisionId,
          sessionControlAuditId,
          effect: {
            kind: "request_interrupt",
            bindingHandle: binding.bindingHandle,
            sessionExecutionAttemptId: currentAttempt.sessionExecutionAttemptId,
            sessionControlAuditId,
          },
          state: "pending",
          createdAt: NOW,
        });
        state.providerEffects.push(intent);
        return { providerEffectIntentId: intent.providerEffectIntentId };
      },
    },
    provider,
  });
  return {
    app,
    provider,
    state,
    snapshot: () => structuredClone(state),
    setRetirementState(value: "unknown" | "released") {
      const current = state.retirements[0]!;
      const { failureCode: _failureCode, releasedAt: _releasedAt, ...base } = current;
      state.retirements[0] = cloneAcpV3BindingRetirementIntentRecord({
        ...base,
        state: value,
        attempts: 1,
        ...(value === "unknown"
          ? { failureCode: "acp_binding_retirement_cleanup_unconfirmed" }
          : { releasedAt: NOW }),
        revision: 2,
      });
    },
    setBindingReleased() {
      state.bindings[0] = { ...state.bindings[0]!, status: "released", recoverable: false, revision: 2 };
    },
  };
}

function capabilitiesFor(
  state: ReturnType<typeof createMutableState>,
  architecture: TaskArchitectureSnapshotV3,
): SessionIdAcpTaskStopCapabilities {
  const reliability: SessionIdAcpTaskStopCapabilities["reliability"] = {
    createProviderEffectIntent(intent) { state.providerEffects.push(intent); return intent; },
    getProviderEffectIntent(id) { return state.providerEffects.find((intent) => intent.providerEffectIntentId === id); },
    listProviderEffectIntents(attemptId) {
      return state.providerEffects.filter((intent) => !attemptId || intent.sessionExecutionAttemptId === attemptId);
    },
    createBindingRetirementIntent(intent) {
      const replay = state.retirements.find((candidate) => candidate.idempotencyKey === intent.idempotencyKey);
      if (replay) return replay;
      state.retirements.push(intent);
      return intent;
    },
    getBindingRetirementIntent(id) { return state.retirements.find((intent) => intent.bindingRetirementIntentId === id); },
    findBindingRetirementIntentByIdempotencyKey(scope) {
      return state.retirements.find((intent) => intent.taskId === scope.taskId && intent.runId === scope.runId
        && intent.bindingId === scope.bindingId && intent.idempotencyKey === scope.idempotencyKey);
    },
    listBindingRetirementIntents(logicalSessionId) {
      return state.retirements.filter((intent) => !logicalSessionId || intent.logicalSessionId === logicalSessionId);
    },
    claimBindingRetirementIntent() { throw new Error("unexpected_retirement_claim"); },
    settleBindingRetirementReleased() { throw new Error("unexpected_retirement_settlement"); },
    settleBindingRetirementUnknown() { throw new Error("unexpected_retirement_settlement"); },
    suppressUnhandedProviderEffectIntents(input) {
      state.suppressedEffectInputs.push(...input.inputSubmissionIds);
      return input.inputSubmissionIds;
    },
  };
  return {
    taskRun: {
      readExactStopState(taskId, runId) {
        if (taskId !== "task_stop_acp" || runId !== "run_stop_acp") throw new Error("scope_mismatch");
        return {
          taskId,
          runId,
          taskRevision: state.taskRevision,
          taskStatus: state.taskStatus,
          runStatus: state.runStatus,
          architectureSnapshotId: architecture.architectureSnapshotId,
          architectureSchemaVersion: 3,
          conductorSessionId: "logical_session_conductor_stop",
        };
      },
      acceptTaskStop(input) {
        if (state.taskRevision !== input.expectedRevision || state.runStatus !== "running") throw new Error("stale");
        state.taskRevision = input.nextRevision;
        state.taskStatus = "stopping";
        state.runStatus = "stopping";
      },
      retireCurrentSessionsForTaskStop() { state.retiredSessions += 1; },
      completeAcpTaskStop(input) {
        state.taskRevision = input.nextRevision;
        state.taskStatus = "stopped";
        state.runStatus = "stopped";
      },
    },
    orchestration: {
      listInboxItems: (sessionId) => state.inbox.filter((item) => item.sessionId === sessionId),
      updateInboxItem(item, expected) { replaceBy(state.inbox, "inboxItemId", item, expected, "state"); },
      findInputByInboxItem: (id) => state.inputs.find((input) => input.sourceInboxItemId === id),
      updateInputSubmission(input, expected) { replaceBy(state.inputs, "inputSubmissionId", input, expected, "state"); },
      findTurnByInputSubmission: (id) => state.turns.find((turn) => turn.inputSubmissionId === id),
      updateTurn(turn, expected) { replaceBy(state.turns, "sessionTurnId", turn, expected, "state"); },
      createControlAudit(control) { state.controls.push(control); },
      getControlAudit: (id) => state.controls.find((control) => control.sessionControlAuditId === id),
      findControlByIdempotencyKey: (taskId, runId, key) => state.controls.find((control) =>
        control.taskId === taskId && control.runId === runId && control.idempotencyKey === key),
      listControlAudits: (runId, sessionId) => state.controls.filter((control) =>
        control.runId === runId && (!sessionId || control.sessionId === sessionId)),
    },
    humanIntervention: {
      get: (id) => state.interventions.find((item) => item.humanInterventionId === id),
      list: (runId, sessionId) => state.interventions.filter((item) =>
        item.runId === runId && (!sessionId || item.targetSessionId === sessionId)),
      update(intervention) {
        const index = state.interventions.findIndex((item) => item.humanInterventionId === intervention.humanInterventionId);
        state.interventions[index] = intervention;
      },
    },
    binding: {
      getBinding: (id) => state.bindings.find((binding) => binding.bindingId === id),
      getCurrentBinding: (sessionId) => state.bindings.find((binding) =>
        binding.logicalSessionId === sessionId && binding.status !== "released" && binding.status !== "unrecoverable"),
      listBindings: (sessionId) => state.bindings.filter((binding) => binding.logicalSessionId === sessionId),
      listBindingsForRun: (taskId, runId) => state.bindings.filter((binding) =>
        binding.taskId === taskId && binding.runId === runId),
    },
    sessionExecution: {
      getRuntimeForSession: (sessionId) => state.runtime.logicalSessionId === sessionId ? state.runtime : undefined,
      getAttempt: (id) => state.attempt?.sessionExecutionAttemptId === id ? state.attempt : undefined,
      listAttempts: (runtimeId) => state.attempt?.sessionExecutionRuntimeId === runtimeId ? [state.attempt] : [],
    },
    reliability,
    commandReceipts: {
      createUiCommandReceipt(receipt) { state.receipts.push(receipt); },
      getUiCommandReceipt: (taskId, commandId) => state.receipts.find((receipt) =>
        receipt.taskId === taskId && receipt.commandId === commandId),
    },
  };
}

function createMutableState() {
  return {
    taskRevision: 0,
    taskStatus: "",
    runStatus: "",
    inbox: [] as SessionLaneItemRecord[],
    inputs: [] as SessionIdInputSubmissionRecord[],
    turns: [] as SessionIdSessionTurnRecord[],
    interventions: [] as SessionIdHumanInterventionRecord[],
    controls: [] as SessionControlAuditRecord[],
    providerEffects: [] as SessionRuntimeProviderEffectIntentRecord[],
    retirements: [] as AcpV3BindingRetirementIntentRecord[],
    receipts: [] as SessionIdUiCommandReceiptRecord[],
    bindings: [] as AcpSafeSessionBindingRecordV3[],
    runtime: {} as SessionExecutionRuntimeRecord,
    attempt: undefined as SessionExecutionAttemptRecord | undefined,
    suppressedEffectInputs: [] as string[],
    retiredSessions: 0,
  };
}

function restore(target: ReturnType<typeof createMutableState>, source: ReturnType<typeof createMutableState>): void {
  Object.assign(target, source);
}

function replaceBy<T, K extends keyof T, S extends keyof T>(
  records: T[], idKey: K, next: T, expected: T[S], stateKey: S,
): void {
  const index = records.findIndex((record) => record[idKey] === next[idKey]);
  if (index < 0 || records[index]![stateKey] !== expected) throw new Error("fake_cas_conflict");
  records[index] = next;
}

function stopCommand() {
  return {
    type: "task.stop" as const,
    commandId: "command_stop_acp",
    idempotencyKey: "task-stop:acp",
    taskId: "task_stop_acp",
    runId: "run_stop_acp",
    expectedRevision: 7,
    issuedAt: NOW,
  };
}

function taskArchitecture(): TaskArchitectureSnapshotV3 {
  const source = BUILT_IN_ACP_STARTER_PACKAGES.find(
    ({ package: candidate }) => candidate.template.slug === "opencode-acp-starter",
  )!;
  const definition = source.package.definition;
  const taskGoalContent = renderTaskGoalContentV1({ title: "Stop", goal: "Stop safely.", taskInputValues: [] }, definition.taskInputSchema);
  return validateTaskArchitectureSnapshotV3({
    schemaVersion: 3,
    architectureSnapshotId: "architecture_stop_acp",
    taskId: "task_stop_acp",
    templateId: source.package.template.templateId,
    templateVersionId: source.templateVersionId,
    templateDefinitionHash: hashDefinition(definition as unknown as JsonValue),
    definition,
    taskInputValues: [],
    taskTitle: "Stop",
    taskGoal: "Stop safely.",
    taskGoalContent,
    taskGoalContentDigest: hashDefinition(taskGoalContent),
    taskGoalCompilerVersion: "task-goal/v1",
    workspace: { workspaceId: "workspace_stop_acp", grantDigest: `sha256:${"c".repeat(64)}` },
    createdAt: NOW,
  });
}

function bindingRecord(architecture: TaskArchitectureSnapshotV3): AcpSafeSessionBindingRecordV3 {
  const profile = architecture.definition.executionProfiles.find((item) =>
    item.executionProfileId === architecture.definition.conductor.executionProfileId)!;
  return {
    schemaVersion: 3,
    bindingId: "binding_stop_acp",
    taskId: "task_stop_acp",
    runId: "run_stop_acp",
    logicalSessionId: "logical_session_conductor_stop",
    agentCardId: architecture.definition.conductor.agentCardId,
    executionProfileId: profile.executionProfileId,
    profileRevisionId: profile.profileRevisionId,
    providerFamily: profile.providerFamily,
    bindingHandle: "binding_handle_stop_acp",
    status: "active",
    recoverable: true,
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function runtimeRecord(active: boolean): SessionExecutionRuntimeRecord {
  return {
    sessionExecutionRuntimeId: "session_execution_runtime_stop_acp",
    taskId: "task_stop_acp",
    runId: "run_stop_acp",
    logicalSessionId: "logical_session_conductor_stop",
    state: active ? "executing" : "idle",
    ...(active ? { activeAttemptId: "session_execution_attempt_stop_acp" } : {}),
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function attemptRecord(): SessionExecutionAttemptRecord {
  return {
    sessionExecutionAttemptId: "session_execution_attempt_stop_acp",
    sessionExecutionRuntimeId: "session_execution_runtime_stop_acp",
    taskId: "task_stop_acp",
    runId: "run_stop_acp",
    logicalSessionId: "logical_session_conductor_stop",
    bindingId: "binding_stop_acp",
    bindingRevision: 1,
    executionProfileId: "profile_opencode_conductor",
    profileRevisionId: "profile_revision_opencode_conductor_v1",
    inputSubmissionId: "input_handed",
    orchestrationSessionTurnId: "session_turn_handed",
    state: "waiting_for_interaction",
    interactions: [{
      interactionId: "interaction_stop_acp",
      promptDigest: "sha256:pending-interaction",
      choices: [{ choiceId: "choice_stop_acp", label: "Continue" }],
      status: "requested",
      revision: 1,
      requestedAt: NOW,
    }],
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function laneRecords(): SessionLaneItemRecord[] {
  return [
    lane("inbox_held", "input_held", "held_by_human_intervention"),
    lane("inbox_leased", "input_leased", "leased"),
    lane("inbox_handed", "input_handed", "handed"),
  ];
}

function lane(id: string, input: string, state: SessionLaneItemRecord["state"]): SessionLaneItemRecord {
  return {
    inboxItemId: id,
    taskId: "task_stop_acp",
    runId: "run_stop_acp",
    sessionId: "logical_session_conductor_stop",
    renderedMessageId: `message_${input}`,
    sequence: Number(id.length),
    priority: "human",
    state,
    ...(id === "inbox_held" ? { humanInterventionId: "human_intervention_stop" } : {}),
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function inputRecords(): SessionIdInputSubmissionRecord[] {
  return ["held", "leased", "handed"].map((suffix) => ({
    inputSubmissionId: `input_${suffix}`,
    taskId: "task_stop_acp",
    runId: "run_stop_acp",
    sessionId: "logical_session_conductor_stop",
    sourceInboxItemId: `inbox_${suffix}`,
    contentMessageId: `message_input_${suffix}`,
    commandId: `command_input_${suffix}`,
    idempotencyKey: `input:${suffix}`,
    sequence: suffix.length,
    state: suffix === "handed" ? "handed" : "pending",
    createdAt: NOW,
    updatedAt: NOW,
  }));
}

function turnRecords(): SessionIdSessionTurnRecord[] {
  return ["held", "leased", "handed"].map((suffix) => ({
    sessionTurnId: `session_turn_${suffix}`,
    taskId: "task_stop_acp",
    runId: "run_stop_acp",
    sessionId: "logical_session_conductor_stop",
    inputSubmissionId: `input_${suffix}`,
    trigger: "human",
    state: suffix === "handed" ? "active" : "pending",
    createdAt: NOW,
    updatedAt: NOW,
  }));
}

function interventionRecord(): SessionIdHumanInterventionRecord {
  return {
    humanInterventionId: "human_intervention_stop",
    taskId: "task_stop_acp",
    runId: "run_stop_acp",
    commandId: "command_human_stop",
    idempotencyKey: "human:stop",
    targetSessionId: "logical_session_conductor_stop",
    mode: "interrupt_then_send",
    state: "held",
    createdAt: NOW,
    updatedAt: NOW,
  };
}

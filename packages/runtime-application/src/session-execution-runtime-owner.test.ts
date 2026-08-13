import { describe, expect, it } from "vitest";
import { hashDefinition } from "@agent-workspace/runtime-contracts";
import { InMemorySessionExecutionRepository } from "../../test-kit/src";
import { createSessionExecutionRuntimeOwner } from "./session-execution-runtime-owner";

describe("SessionExecutionRuntime application owner", () => {
  it("restores the Runtime to executing when an exact receipt resolves a reconciling Attempt", () => {
    const repository = new InMemorySessionExecutionRepository();
    const owner = createSessionExecutionRuntimeOwner({
      repository,
      now: monotonicNow(),
      createRuntimeId: () => "session_execution_runtime_receipt",
      createAttemptId: () => "session_execution_attempt_receipt",
    });
    const runtime = owner.ensureRuntime({
      taskId: "task_receipt",
      runId: "run_receipt",
      logicalSessionId: "logical_session_receipt",
    });
    const attempt = owner.startAttempt({
      sessionExecutionRuntimeId: runtime.sessionExecutionRuntimeId,
      expectedRuntimeRevision: runtime.revision,
      bindingId: "binding_receipt",
      bindingRevision: 1,
      executionProfileId: "profile_receipt",
      profileRevisionId: "profile_revision_receipt",
      inputSubmissionId: "input_receipt",
      orchestrationSessionTurnId: "session_turn_receipt",
    });
    const reconciling = owner.markReconciliation({
      sessionExecutionAttemptId: attempt.sessionExecutionAttemptId,
      expectedAttemptRevision: attempt.revision,
    }).attempt;
    expect(owner.getRuntime(runtime.sessionExecutionRuntimeId)).toMatchObject({ state: "reconciling" });

    const received = owner.recordReceipt({
      sessionExecutionAttemptId: attempt.sessionExecutionAttemptId,
      expectedAttemptRevision: reconciling.revision,
      receiptDigest: `sha256:${"a".repeat(64)}`,
    }).attempt;

    expect(received.state).toBe("active");
    expect(owner.getRuntime(runtime.sessionExecutionRuntimeId)).toMatchObject({
      state: "executing",
      activeAttemptId: attempt.sessionExecutionAttemptId,
    });
  });

  it("stages one owner-scoped provider effect before returning a typed submit seam", () => {
    const repository = new InMemorySessionExecutionRepository();
    let providerEffectSequence = 0;
    const owner = createSessionExecutionRuntimeOwner({
      repository,
      commandTransaction: repository,
      now: monotonicNow(),
      createRuntimeId: () => "session_execution_runtime_1",
      createAttemptId: () => "session_execution_attempt_1",
      createProviderEffectIntentId: () => `provider_effect_${++providerEffectSequence}`,
    });
    const runtime = owner.ensureRuntime({ taskId: "task_1", runId: "run_1", logicalSessionId: "logical_session_1" });
    expect(owner.getRuntimeForLogicalSession("logical_session_1")).toEqual(runtime);
    expect(owner.getRuntimeForLogicalSession("logical_session_missing")).toBeUndefined();
    const command = {
      type: "session_runtime.submit_delivery",
      commandId: "command_submit-1",
      idempotencyKey: "submit-1",
      taskId: "task_1",
      runId: "run_1",
      logicalSessionId: "logical_session_1",
      sessionExecutionRuntimeId: runtime.sessionExecutionRuntimeId,
      expectedRuntimeRevision: runtime.revision,
      bindingId: "binding_1",
      bindingRevision: 1,
      executionProfileId: "profile_worker",
      profileRevisionId: "profile_revision_worker-1",
      bindingHandle: "binding_handle_workspace-1",
      inputSubmissionId: "input_1",
      orchestrationSessionTurnId: "session_turn_or_1",
      content: "Implement the bounded change.",
      contentDigest: hashDefinition("Implement the bounded change."),
    } as const;

    const staged = owner.executeCommand(command);
    if (staged.disposition !== "staged") throw new Error("expected staged submit");
    expect(staged).toMatchObject({
      disposition: "staged",
      intent: { providerEffectIntentId: "provider_effect_1", state: "pending" },
      externalEffect: {
        kind: "submit_delivery",
        bindingHandle: "binding_handle_workspace-1",
        sessionExecutionAttemptId: "session_execution_attempt_1",
      },
    });
    expect(repository.snapshot()).toMatchObject({ attempts: [{ sessionExecutionAttemptId: "session_execution_attempt_1" }], providerEffects: [staged.intent] });

    const replay = owner.executeCommand(command);
    expect(replay.disposition).toBe("replay");
    expect(replay.intent).toEqual(staged.intent);
    expect(replay).not.toHaveProperty("externalEffect");
    expect(repository.snapshot().attempts).toHaveLength(1);
    expect(repository.snapshot().providerEffects).toHaveLength(1);

    const replayWithNewCommandId = owner.executeCommand({ ...command, commandId: "command_submit-retry" });
    expect(replayWithNewCommandId).toMatchObject({ disposition: "replay", intent: { commandId: command.commandId } });
    expect(repository.snapshot().providerEffects).toHaveLength(1);
    expect(() => owner.executeCommand({
      ...command,
      commandId: "command_submit-conflict",
      content: "Different payload under the same key.",
      contentDigest: hashDefinition("Different payload under the same key."),
    })).toThrow(/idempotency.*conflict|replay_conflict/);
    expect(() => owner.executeCommand({
      ...command,
      idempotencyKey: "different-key",
    })).toThrow(/command.*conflict|replay_conflict/);
    expect(repository.snapshot().providerEffects).toHaveLength(1);

    const currentRuntime = repository.getRuntime(runtime.sessionExecutionRuntimeId)!;
    const interrupt = owner.executeCommand({
      type: "session_runtime.request_interrupt",
      commandId: "command_interrupt-1",
      idempotencyKey: "interrupt-1",
      taskId: command.taskId,
      runId: command.runId,
      logicalSessionId: command.logicalSessionId,
      sessionExecutionRuntimeId: command.sessionExecutionRuntimeId,
      expectedRuntimeRevision: currentRuntime.revision,
      bindingId: command.bindingId,
      bindingRevision: command.bindingRevision,
      executionProfileId: command.executionProfileId,
      profileRevisionId: command.profileRevisionId,
      bindingHandle: command.bindingHandle,
      sessionExecutionAttemptId: staged.externalEffect.sessionExecutionAttemptId,
      expectedAttemptRevision: 1,
      inputSubmissionId: command.inputSubmissionId,
      orchestrationSessionTurnId: command.orchestrationSessionTurnId,
      sessionControlAuditId: "session_control_1",
    });
    if (interrupt.disposition !== "staged") throw new Error("expected staged interrupt");
    expect(interrupt.externalEffect).toMatchObject({
      kind: "request_interrupt",
      sessionControlAuditId: "session_control_1",
    });
    expect(interrupt.intent).toMatchObject({ sessionControlAuditId: "session_control_1" });
    const reconcile = owner.executeCommand({
      type: "session_runtime.reconcile_attempt",
      commandId: "command_reconcile-1",
      idempotencyKey: "reconcile-1",
      taskId: command.taskId,
      runId: command.runId,
      logicalSessionId: command.logicalSessionId,
      sessionExecutionRuntimeId: command.sessionExecutionRuntimeId,
      expectedRuntimeRevision: currentRuntime.revision,
      bindingId: command.bindingId,
      bindingRevision: command.bindingRevision,
      executionProfileId: command.executionProfileId,
      profileRevisionId: command.profileRevisionId,
      bindingHandle: command.bindingHandle,
      sessionExecutionAttemptId: staged.externalEffect.sessionExecutionAttemptId,
      expectedAttemptRevision: 1,
      inputSubmissionId: command.inputSubmissionId,
      orchestrationSessionTurnId: command.orchestrationSessionTurnId,
    });
    if (reconcile.disposition !== "staged") throw new Error("expected staged reconciliation");
    expect(reconcile.externalEffect).toMatchObject({ kind: "reconcile_attempt" });
    expect(repository.getRuntime(runtime.sessionExecutionRuntimeId)).toMatchObject({ state: "reconciling" });
    expect(repository.snapshot().providerEffects).toHaveLength(3);
  });

  it("stages a response for the exact pending interaction and records its safe resolution", () => {
    const repository = new InMemorySessionExecutionRepository();
    let providerEffectSequence = 0;
    const owner = createSessionExecutionRuntimeOwner({
      repository,
      commandTransaction: repository,
      now: monotonicNow(),
      createRuntimeId: () => "session_execution_runtime_1",
      createAttemptId: () => "session_execution_attempt_1",
      createProviderEffectIntentId: () => `provider_effect_${++providerEffectSequence}`,
    });
    const runtime = owner.ensureRuntime({ taskId: "task_1", runId: "run_1", logicalSessionId: "logical_session_1" });
    const content = "Request a permission.";
    const submit = owner.executeCommand({
      type: "session_runtime.submit_delivery",
      commandId: "command_submit-1",
      idempotencyKey: "submit-1",
      taskId: runtime.taskId,
      runId: runtime.runId,
      logicalSessionId: runtime.logicalSessionId,
      sessionExecutionRuntimeId: runtime.sessionExecutionRuntimeId,
      expectedRuntimeRevision: runtime.revision,
      bindingId: "binding_1",
      bindingRevision: 1,
      executionProfileId: "profile_worker",
      profileRevisionId: "profile_revision_worker-1",
      bindingHandle: "binding_handle_workspace-1",
      inputSubmissionId: "input_1",
      orchestrationSessionTurnId: "session_turn_or_1",
      content,
      contentDigest: hashDefinition(content),
    });
    if (submit.disposition !== "staged") throw new Error("expected staged submit");
    const attempt = repository.getAttempt(submit.externalEffect.sessionExecutionAttemptId)!;
    const requested = owner.handleInteractionRequested({
      sessionExecutionAttemptId: attempt.sessionExecutionAttemptId,
      expectedAttemptRevision: attempt.revision,
      logicalSessionId: attempt.logicalSessionId,
      bindingId: attempt.bindingId,
      bindingRevision: attempt.bindingRevision,
      executionProfileId: attempt.executionProfileId,
      profileRevisionId: attempt.profileRevisionId,
      interactionId: "interaction_permission-1",
      promptDigest: "sha256:permission-1",
      choices: [{ choiceId: "choice_allow-once", label: "Allow once" }],
    }).attempt;
    const currentRuntime = repository.getRuntime(runtime.sessionExecutionRuntimeId)!;
    const response = owner.executeCommand({
      type: "session_runtime.respond_interaction",
      commandId: "command_response-1",
      idempotencyKey: "response-1",
      taskId: runtime.taskId,
      runId: runtime.runId,
      logicalSessionId: runtime.logicalSessionId,
      sessionExecutionRuntimeId: runtime.sessionExecutionRuntimeId,
      expectedRuntimeRevision: currentRuntime.revision,
      bindingId: attempt.bindingId,
      bindingRevision: attempt.bindingRevision,
      executionProfileId: attempt.executionProfileId,
      profileRevisionId: attempt.profileRevisionId,
      bindingHandle: "binding_handle_workspace-1",
      sessionExecutionAttemptId: attempt.sessionExecutionAttemptId,
      expectedAttemptRevision: requested.revision,
      inputSubmissionId: attempt.inputSubmissionId,
      orchestrationSessionTurnId: attempt.orchestrationSessionTurnId,
      interactionId: "interaction_permission-1",
      expectedInteractionRevision: 1,
      choiceId: "choice_allow-once",
    });
    expect(response).toMatchObject({
      disposition: "staged",
      intent: { interactionId: "interaction_permission-1" },
      externalEffect: { kind: "respond_interaction", interactionId: "interaction_permission-1" },
    });
    const resolved = owner.handleInteractionResolved({
      sessionExecutionAttemptId: attempt.sessionExecutionAttemptId,
      expectedAttemptRevision: requested.revision,
      logicalSessionId: attempt.logicalSessionId,
      bindingId: attempt.bindingId,
      bindingRevision: attempt.bindingRevision,
      executionProfileId: attempt.executionProfileId,
      profileRevisionId: attempt.profileRevisionId,
      interactionId: "interaction_permission-1",
      choiceId: "choice_allow-once",
      expectedInteractionRevision: 1,
    }).attempt;
    expect(resolved.interactions).toEqual([
      expect.objectContaining({ interactionId: "interaction_permission-1", status: "responded", selectedChoiceId: "choice_allow-once" }),
    ]);
  });

  it("round-trips only SR-owned records and returns one safe OR-correlated settlement", () => {
    const repository = new InMemorySessionExecutionRepository();
    const owner = createSessionExecutionRuntimeOwner({
      repository,
      now: monotonicNow(),
      createRuntimeId: () => "session_execution_runtime_1",
      createAttemptId: () => "session_execution_attempt_1",
    });

    const runtime = owner.ensureRuntime({ taskId: "task_1", runId: "run_1", logicalSessionId: "logical_session_1" });
    const attempt = owner.startAttempt({
      sessionExecutionRuntimeId: runtime.sessionExecutionRuntimeId,
      expectedRuntimeRevision: runtime.revision,
      bindingId: "binding_1",
      bindingRevision: 1,
      executionProfileId: "profile_worker",
      profileRevisionId: "profile_revision_worker-1",
      inputSubmissionId: "input_1",
      orchestrationSessionTurnId: "session_turn_or_1",
    });
    owner.recordReceipt({
      sessionExecutionAttemptId: attempt.sessionExecutionAttemptId,
      expectedAttemptRevision: attempt.revision,
      receiptDigest: "sha256:receipt-1",
    });
    const beforeTerminal = repository.getAttempt(attempt.sessionExecutionAttemptId)!;
    owner.recordFinalCandidate({
      sessionExecutionAttemptId: attempt.sessionExecutionAttemptId,
      expectedAttemptRevision: beforeTerminal.revision,
      candidateObservationId: "provider_fact_candidate-1",
      content: "Canonical candidate",
      contentDigest: hashDefinition("Canonical candidate"),
    });
    const beforeSettlement = repository.getAttempt(attempt.sessionExecutionAttemptId)!;
    const result = owner.recordTerminal({
      sessionExecutionAttemptId: attempt.sessionExecutionAttemptId,
      expectedAttemptRevision: beforeSettlement.revision,
      terminalObservationId: "provider_fact_terminal-1",
      outcome: "completed",
      receiptDigest: "sha256:receipt-1",
    });

    expect(result.settlement).toEqual(expect.objectContaining({
      sessionExecutionAttemptId: "session_execution_attempt_1",
      taskId: "task_1",
      runId: "run_1",
      inputSubmissionId: "input_1",
      bindingId: "binding_1",
      bindingRevision: 1,
      executionProfileId: "profile_worker",
      profileRevisionId: "profile_revision_worker-1",
      orchestrationSessionTurnId: "session_turn_or_1",
      outcome: "completed",
      finalContent: "Canonical candidate",
    }));
    expect(repository.getRuntime(runtime.sessionExecutionRuntimeId)).toMatchObject({ state: "idle" });
    expect(repository.getRuntime(runtime.sessionExecutionRuntimeId)).not.toHaveProperty("activeAttemptId");
    expect(JSON.stringify(repository.snapshot())).not.toMatch(/nativeBindingRef|acpSessionId|requestId|optionId|cwd/);
  });

  it("rejects raw ACP/private identity shapes before repository writes", () => {
    const repository = new InMemorySessionExecutionRepository();
    const owner = createSessionExecutionRuntimeOwner({
      repository,
      now: monotonicNow(),
      createRuntimeId: () => "session_execution_runtime_1",
      createAttemptId: () => "session_execution_attempt_1",
    });
    const runtime = owner.ensureRuntime({ taskId: "task_1", runId: "run_1", logicalSessionId: "logical_session_1" });

    expect(() => owner.startAttempt({
      sessionExecutionRuntimeId: runtime.sessionExecutionRuntimeId,
      expectedRuntimeRevision: runtime.revision,
      bindingId: "binding_1",
      bindingRevision: 1,
      executionProfileId: "profile_worker",
      profileRevisionId: "profile_revision_worker-1",
      inputSubmissionId: "input_1",
      orchestrationSessionTurnId: "session_turn_or_1",
      // @ts-expect-error raw ACP IDs are not part of the SR owner contract.
      acpSessionId: "raw-session",
    })).toThrow(/session_execution_private_field_forbidden/);
    expect(repository.snapshot()).toMatchObject({ runtimes: [runtime], attempts: [] });
  });

  it("projects only an opaque bindingHandle for the Binding owner", () => {
    const repository = new InMemorySessionExecutionRepository();
    const owner = createSessionExecutionRuntimeOwner({
      repository,
      now: monotonicNow(),
      createRuntimeId: () => "session_execution_runtime_1",
      createAttemptId: () => "session_execution_attempt_1",
    });
    const runtime = owner.ensureRuntime({ taskId: "task_1", runId: "run_1", logicalSessionId: "logical_session_1" });

    expect(owner.bindingReadyEvent({
      sessionExecutionRuntimeId: runtime.sessionExecutionRuntimeId,
      logicalSessionId: runtime.logicalSessionId,
      bindingId: "binding_1",
      bindingRevision: 1,
      executionProfileId: "profile_worker",
      profileRevisionId: "profile_revision_worker-1",
      bindingHandle: "binding_handle_workspace-1",
      recoverable: true,
    })).toEqual(expect.objectContaining({
      type: "session_runtime.binding_ready",
      bindingHandle: "binding_handle_workspace-1",
    }));
    expect(() => owner.bindingReadyEvent({
      sessionExecutionRuntimeId: runtime.sessionExecutionRuntimeId,
      logicalSessionId: runtime.logicalSessionId,
      bindingId: "binding_1",
      bindingRevision: 1,
      executionProfileId: "profile_worker",
      profileRevisionId: "profile_revision_worker-1",
      bindingHandle: "raw-acp-session-id",
      recoverable: true,
    })).toThrow(/session_execution_opaque_id_invalid/);

    const valid = {
      sessionExecutionRuntimeId: runtime.sessionExecutionRuntimeId,
      logicalSessionId: runtime.logicalSessionId,
      bindingId: "binding_1",
      bindingRevision: 1,
      executionProfileId: "profile_worker",
      profileRevisionId: "profile_revision_worker-1",
      bindingHandle: "binding_handle_workspace-1",
      recoverable: true,
    } as const;
    for (const extra of [
      { workspaceDirectory: "/private/workspace" },
      { sessionId: "raw-provider-session" },
      { rawId: "raw-wire-id" },
      { providerPath: "../provider" },
    ]) {
      expect(() => owner.bindingReadyEvent({ ...valid, ...extra } as never))
        .toThrow(/session_runtime_binding_ready_input_shape_invalid|session_execution_private_field_forbidden/);
    }
  });

  it("keeps an unknown terminal reconciling and replays the same observation without a second write", () => {
    const repository = new InMemorySessionExecutionRepository();
    const owner = createSessionExecutionRuntimeOwner({
      repository,
      now: monotonicNow(),
      createRuntimeId: () => "session_execution_runtime_1",
      createAttemptId: () => "session_execution_attempt_1",
    });
    const runtime = owner.ensureRuntime({ taskId: "task_1", runId: "run_1", logicalSessionId: "logical_session_1" });
    const attempt = owner.startAttempt({
      sessionExecutionRuntimeId: runtime.sessionExecutionRuntimeId,
      expectedRuntimeRevision: runtime.revision,
      bindingId: "binding_1",
      bindingRevision: 1,
      executionProfileId: "profile_worker",
      profileRevisionId: "profile_revision_worker-1",
      inputSubmissionId: "input_1",
      orchestrationSessionTurnId: "session_turn_or_1",
    });
    const unknown = owner.recordTerminal({
      sessionExecutionAttemptId: attempt.sessionExecutionAttemptId,
      expectedAttemptRevision: attempt.revision,
      terminalObservationId: "provider_fact_terminal-unknown",
      outcome: "unknown",
    });

    expect(unknown.attempt.state).toBe("reconciling");
    const reconcilingRuntime = repository.getRuntime(runtime.sessionExecutionRuntimeId)!;
    expect(reconcilingRuntime.state).toBe("reconciling");
    const replay = owner.recordTerminal({
      sessionExecutionAttemptId: attempt.sessionExecutionAttemptId,
      expectedAttemptRevision: unknown.attempt.revision,
      terminalObservationId: "provider_fact_terminal-unknown",
      outcome: "unknown",
    });
    expect(replay.attempt.revision).toBe(unknown.attempt.revision);
    expect(() => owner.startAttempt({
      sessionExecutionRuntimeId: runtime.sessionExecutionRuntimeId,
      expectedRuntimeRevision: reconcilingRuntime.revision,
      bindingId: "binding_1",
      bindingRevision: 1,
      executionProfileId: "profile_worker",
      profileRevisionId: "profile_revision_worker-1",
      inputSubmissionId: "input_2",
      orchestrationSessionTurnId: "session_turn_or_2",
    })).toThrow(/session_execution_attempt_already_active/);
  });
});

function monotonicNow(): () => string {
  let value = 0;
  return () => `2026-08-11T00:00:0${value++}.000Z`;
}

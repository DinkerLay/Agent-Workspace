import { describe, expect, it, vi } from "vitest";
import {
  assertSessionExecutionSafeValue,
  hashDefinition,
  type AcpSafeSessionBindingRecordV3,
  type CardSessionGenerationRecord,
  type CardSessionSlotRecord,
  type SessionControlAuditRecord,
  type SessionExecutionSettlement,
} from "@agent-workspace/runtime-contracts";
import type { SessionIdSessionTurnRecord } from "@agent-workspace/runtime-store";
import { InMemorySessionExecutionRepository } from "@agent-workspace/test-kit";
import { createSessionExecutionRuntimeOwner } from "./session-execution-runtime-owner";
import {
  createSessionIdAcpOrchestrationBridge,
  type SessionIdAcpFrozenProfileTuple,
  type SessionIdAcpOrchestrationBridgeOptions,
} from "./session-id-acp-orchestration-bridge";

const NOW = "2026-08-12T00:00:00.000Z";
const CONTENT = "Message-owner canonical delivery";

describe("Session-ID ACP OR to SR bridge", () => {
  it("stages one Message-owner delivery as a drainable v3 intent and replays it", () => {
    const fixture = createFixture();

    const staged = fixture.bridge.stageDelivery({ inputSubmissionId: "input_delivery-1" });
    expect(staged).toEqual({
      disposition: "staged",
      commandType: "session_runtime.submit_delivery",
      providerEffectIntentId: "provider_effect_1",
      sessionExecutionRuntimeId: "session_execution_runtime_1",
      sessionExecutionAttemptId: "session_execution_attempt_1",
    });
    expect(fixture.repository.snapshot().providerEffects).toEqual([
      expect.objectContaining({
        providerEffectIntentId: staged.providerEffectIntentId,
        taskId: "task_1",
        runId: "run_1",
        logicalSessionId: "logical_session_worker-1",
        bindingId: "binding_1",
        bindingRevision: 1,
        executionProfileId: "profile_worker",
        profileRevisionId: "profile_revision_worker-1",
        inputSubmissionId: "input_delivery-1",
        orchestrationSessionTurnId: "session_turn_delivery-1",
        effect: {
          kind: "submit_delivery",
          bindingHandle: "binding_handle_worker-1",
          sessionExecutionAttemptId: "session_execution_attempt_1",
          content: CONTENT,
        },
      }),
    ]);
    expect(fixture.bridge.stageDelivery({ inputSubmissionId: "input_delivery-1" })).toEqual({
      ...staged,
      disposition: "replay",
    });
    expect(fixture.repository.snapshot().providerEffects).toHaveLength(1);
    expect(fixture.readMessage).toHaveBeenCalledWith("message_delivery-1");
    expect(() => assertSessionExecutionSafeValue({
      staged,
      repository: fixture.repository.snapshot(),
    })).not.toThrow();
  });

  it("fences a v3 Conductor by the Run-owned Conductor identity without forging a Card slot", () => {
    const fixture = createFixture();
    fixture.generationAvailable = false;
    fixture.conductorSessionId = "logical_session_worker-1";

    expect(fixture.bridge.stageDelivery({ inputSubmissionId: "input_delivery-1" })).toMatchObject({
      disposition: "staged",
      commandType: "session_runtime.submit_delivery",
      providerEffectIntentId: "provider_effect_1",
    });
  });

  it("stages interrupt and reconciliation from exact durable Control/Attempt correlation", () => {
    const fixture = createFixture();
    fixture.bridge.stageDelivery({ inputSubmissionId: "input_delivery-1" });
    fixture.turn = { ...fixture.turn, state: "active" };

    const interrupt = fixture.bridge.stageInterrupt({ sessionControlAuditId: "session_control_interrupt-1" });
    expect(interrupt).toMatchObject({
      disposition: "staged",
      commandType: "session_runtime.request_interrupt",
      providerEffectIntentId: "provider_effect_2",
      sessionExecutionAttemptId: "session_execution_attempt_1",
    });
    expect(fixture.bridge.stageInterrupt({ sessionControlAuditId: "session_control_interrupt-1" }))
      .toEqual({ ...interrupt, disposition: "replay" });

    const reconcile = fixture.bridge.stageReconciliation({
      sessionExecutionAttemptId: "session_execution_attempt_1",
    });
    expect(reconcile).toMatchObject({
      disposition: "staged",
      commandType: "session_runtime.reconcile_attempt",
      providerEffectIntentId: "provider_effect_3",
      sessionExecutionAttemptId: "session_execution_attempt_1",
    });
    expect(fixture.bridge.stageReconciliation({
      sessionExecutionAttemptId: "session_execution_attempt_1",
    })).toEqual({ ...reconcile, disposition: "replay" });
  });

  it("stages an exact persisted Interaction choice without accepting caller label text", () => {
    const fixture = createFixture();
    const delivery = fixture.bridge.stageDelivery({ inputSubmissionId: "input_delivery-1" });
    fixture.turn = { ...fixture.turn, state: "active" };
    let attempt = fixture.runtimeOwner.getAttempt(delivery.sessionExecutionAttemptId)!;
    fixture.runtimeOwner.handleDeliveryReceipt({
      sessionExecutionAttemptId: attempt.sessionExecutionAttemptId,
      expectedAttemptRevision: attempt.revision,
      logicalSessionId: attempt.logicalSessionId,
      bindingId: attempt.bindingId,
      bindingRevision: attempt.bindingRevision,
      executionProfileId: attempt.executionProfileId,
      profileRevisionId: attempt.profileRevisionId,
      receiptDigest: `sha256:${"b".repeat(64)}`,
    });
    attempt = fixture.runtimeOwner.getAttempt(delivery.sessionExecutionAttemptId)!;
    fixture.runtimeOwner.handleInteractionRequested({
      sessionExecutionAttemptId: attempt.sessionExecutionAttemptId,
      expectedAttemptRevision: attempt.revision,
      logicalSessionId: attempt.logicalSessionId,
      bindingId: attempt.bindingId,
      bindingRevision: attempt.bindingRevision,
      executionProfileId: attempt.executionProfileId,
      profileRevisionId: attempt.profileRevisionId,
      interactionId: "interaction_review",
      promptDigest: `sha256:${"c".repeat(64)}`,
      choices: [{ choiceId: "choice_approve", label: "Approve once" }],
    });
    attempt = fixture.runtimeOwner.getAttempt(delivery.sessionExecutionAttemptId)!;

    const staged = fixture.bridge.stageInteractionResponse({
      sessionExecutionAttemptId: attempt.sessionExecutionAttemptId,
      interactionId: "interaction_review",
      expectedInteractionRevision: 1,
      choiceId: "choice_approve",
    });
    expect(staged).toMatchObject({
      disposition: "staged",
      commandType: "session_runtime.respond_interaction",
      providerEffectIntentId: "provider_effect_2",
    });
    expect(fixture.repository.snapshot().providerEffects.at(-1)).toMatchObject({
      interactionId: "interaction_review",
      effect: {
        kind: "respond_interaction",
        interactionId: "interaction_review",
        choiceId: "choice_approve",
      },
    });
    expect(fixture.bridge.stageInteractionResponse({
      sessionExecutionAttemptId: attempt.sessionExecutionAttemptId,
      interactionId: "interaction_review",
      expectedInteractionRevision: 1,
      choiceId: "choice_approve",
    })).toEqual({ ...staged, disposition: "replay" });
    expect(() => fixture.bridge.stageInteractionResponse({
      sessionExecutionAttemptId: attempt.sessionExecutionAttemptId,
      interactionId: "interaction_review",
      expectedInteractionRevision: 1,
      choiceId: "choice_other",
    })).toThrow(/interaction_choice_mismatch|interaction_choice_invalid/);
    expect(fixture.repository.snapshot().providerEffects).toHaveLength(2);
  });

  it("rechecks current Binding and frozen Profile before returning a recovered intent ID", () => {
    const fixture = createFixture();
    const staged = fixture.bridge.stageDelivery({ inputSubmissionId: "input_delivery-1" });

    fixture.currentBinding = {
      ...fixture.currentBinding!,
      bindingId: "binding_2",
      bindingHandle: "binding_handle_worker-2",
      revision: 2,
    };
    expect(() => fixture.bridge.stageDelivery({ inputSubmissionId: "input_delivery-1" }))
      .toThrow(/provider_effect_replay_scope_mismatch/);
    expect(fixture.repository.snapshot().providerEffects).toHaveLength(1);

    fixture.currentBinding = binding();
    fixture.frozenProfile = {
      ...fixture.frozenProfile,
      profileRevisionId: "profile_revision_worker-2",
    };
    expect(() => fixture.bridge.stageDelivery({ inputSubmissionId: "input_delivery-1" }))
      .toThrow(/frozen_profile_mismatch/);
    expect(fixture.repository.snapshot().providerEffects).toEqual([
      expect.objectContaining({ providerEffectIntentId: staged.providerEffectIntentId }),
    ]);
  });

  it("fails before SR mutation for caller content, stale current Binding, or frozen Profile drift", () => {
    const fixture = createFixture();
    const before = fixture.repository.snapshot();

    expect(() => fixture.bridge.stageDelivery({
      inputSubmissionId: "input_delivery-1",
      // @ts-expect-error The bridge accepts only an opaque durable Input identity.
      content: "caller-forged",
    })).toThrow(/shape_invalid/);
    expect(fixture.repository.snapshot()).toEqual(before);

    fixture.currentBinding = undefined;
    expect(() => fixture.bridge.stageDelivery({ inputSubmissionId: "input_delivery-1" }))
      .toThrow(/binding_not_current|binding_scope_mismatch/);
    expect(fixture.repository.snapshot()).toEqual(before);

    fixture.currentBinding = binding();
    fixture.frozenProfile = {
      ...fixture.frozenProfile,
      profileRevisionId: "profile_revision_worker-2",
    };
    expect(() => fixture.bridge.stageDelivery({ inputSubmissionId: "input_delivery-1" }))
      .toThrow(/frozen_profile_mismatch/);
    expect(fixture.repository.snapshot()).toEqual(before);

    fixture.frozenProfile = {
      ...fixture.frozenProfile,
      profileRevisionId: "profile_revision_worker-1",
    };
    fixture.runStatus = "stopped";
    expect(() => fixture.bridge.stageDelivery({ inputSubmissionId: "input_delivery-1" }))
      .toThrow(/task_run_not_accepting_effect/);
    expect(fixture.repository.snapshot()).toEqual(before);
  });

  it("fails before SR mutation when the Card generation is not the exact current slot generation", () => {
    const cases: Array<(fixture: ReturnType<typeof createFixture>) => void> = [
      (fixture) => { fixture.slot = { ...fixture.slot, latestGeneration: 2 }; },
      (fixture) => { fixture.generation = { ...fixture.generation, sessionId: "logical_session_other" }; },
      (fixture) => {
        fixture.generation = {
          ...fixture.generation,
          closedAt: NOW,
        } as CardSessionGenerationRecord;
      },
    ];
    for (const mutate of cases) {
      const fixture = createFixture();
      const before = fixture.repository.snapshot();
      mutate(fixture);
      expect(() => fixture.bridge.stageDelivery({ inputSubmissionId: "input_delivery-1" }))
        .toThrow(/generation_not_current/);
      expect(fixture.repository.snapshot()).toEqual(before);
    }
  });

  it("rejects Control/Attempt/Turn mismatch without another v3 intent", () => {
    const fixture = createFixture();
    fixture.bridge.stageDelivery({ inputSubmissionId: "input_delivery-1" });
    const before = fixture.repository.snapshot();
    fixture.control = { ...fixture.control, taskId: "task_other" };

    expect(() => fixture.bridge.stageInterrupt({ sessionControlAuditId: "session_control_interrupt-1" }))
      .toThrow(/control_scope_mismatch/);
    expect(fixture.repository.snapshot()).toEqual(before);
  });

  it("settles only through the canonical coordinator and returns its replay identity", () => {
    const fixture = createFixture();
    const settlement = completedSettlement();
    fixture.acceptSettlement.mockReturnValueOnce({
      status: "recorded",
      messageId: "message_final-1",
      inboxItemId: "inbox_final-1",
    }).mockReturnValueOnce({
      status: "replayed",
      messageId: "message_final-1",
      inboxItemId: "inbox_final-1",
    });

    expect(fixture.bridge.acceptSettlement(settlement)).toEqual({
      status: "recorded",
      messageId: "message_final-1",
      inboxItemId: "inbox_final-1",
    });
    expect(fixture.bridge.acceptSettlement(settlement)).toEqual({
      status: "replayed",
      messageId: "message_final-1",
      inboxItemId: "inbox_final-1",
    });
    expect(fixture.acceptSettlement).toHaveBeenCalledTimes(2);
    expect(fixture.acceptSettlement).toHaveBeenNthCalledWith(1, settlement);
  });
});

function createFixture() {
  const repository = new InMemorySessionExecutionRepository();
  let providerEffectSequence = 0;
  const owner = createSessionExecutionRuntimeOwner({
    repository,
    commandTransaction: repository,
    now: () => NOW,
    createRuntimeId: () => "session_execution_runtime_1",
    createAttemptId: () => "session_execution_attempt_1",
    createProviderEffectIntentId: () => `provider_effect_${++providerEffectSequence}`,
  });
  const input = Object.freeze({
    inputSubmissionId: "input_delivery-1",
    taskId: "task_1",
    runId: "run_1",
    sessionId: "logical_session_worker-1",
    sourceInboxItemId: "inbox_delivery-1",
    contentMessageId: "message_delivery-1",
    commandId: "command_or-delivery-1",
    idempotencyKey: "input:delivery-1",
    sequence: 1,
    state: "pending" as const,
    createdAt: NOW,
    updatedAt: NOW,
  });
  const initialTurn = Object.freeze({
    sessionTurnId: "session_turn_delivery-1",
    taskId: "task_1",
    runId: "run_1",
    sessionId: "logical_session_worker-1",
    inputSubmissionId: input.inputSubmissionId,
    sourceConductorSessionTurnId: "session_turn_conductor-1",
    trigger: "conductor_send" as const,
    state: "pending" as const,
    createdAt: NOW,
    updatedAt: NOW,
  });
  const message = Object.freeze({
    messageId: "message_delivery-1",
    taskId: "task_1",
    runId: "run_1",
    sourceSessionId: "logical_session_conductor-1",
    sourceSessionTurnId: "session_turn_conductor-1",
    kind: "conductor_forward" as const,
    content: CONTENT,
    canonicalContent: Object.freeze([{ kind: "text" as const, text: CONTENT }]),
    contentDigest: hashDefinition(CONTENT),
    createdAt: NOW,
  });
  const slot: CardSessionSlotRecord = Object.freeze({
    cardSessionSlotId: "card_session_slot_worker",
    taskId: "task_1",
    runId: "run_1",
    agentCardId: "agent_card_worker",
    currentSessionId: "logical_session_worker-1",
    latestGeneration: 1,
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
  });
  const generation: CardSessionGenerationRecord = Object.freeze({
    sessionId: "logical_session_worker-1",
    cardSessionSlotId: slot.cardSessionSlotId,
    taskId: "task_1",
    runId: "run_1",
    agentCardId: "agent_card_worker",
    executionProfileId: "profile_worker",
    generation: 1,
    lifecycle: "current",
    createdAt: NOW,
  });
  const readMessage = vi.fn((messageId: string) => messageId === message.messageId ? message : undefined);
  const acceptSettlement = vi.fn();
  const mutable: {
    currentBinding: AcpSafeSessionBindingRecordV3 | undefined;
    frozenProfile: SessionIdAcpFrozenProfileTuple;
    control: SessionControlAuditRecord;
    turn: SessionIdSessionTurnRecord;
    generationAvailable: boolean;
    conductorSessionId: string;
    runStatus: string;
    slot: CardSessionSlotRecord;
    generation: CardSessionGenerationRecord;
  } = {
    currentBinding: binding() as AcpSafeSessionBindingRecordV3 | undefined,
    frozenProfile: Object.freeze({
      schemaVersion: 3 as const,
      executionProfileId: "profile_worker",
      profileRevisionId: "profile_revision_worker-1",
      providerFamily: "opencode" as const,
    }),
    control: Object.freeze({
      sessionControlAuditId: "session_control_interrupt-1",
      taskId: "task_1",
      runId: "run_1",
      sessionId: "logical_session_worker-1",
      commandId: "command_interrupt-1",
      idempotencyKey: "interrupt:1",
      kind: "conductor_interrupt" as const,
      state: "requested" as const,
      affectedInboxItemIds: Object.freeze([]),
      requestedAt: NOW,
    }) as SessionControlAuditRecord,
    turn: initialTurn,
    generationAvailable: true,
    conductorSessionId: "logical_session_conductor-other",
    runStatus: "running",
    slot,
    generation,
  };
  const options: SessionIdAcpOrchestrationBridgeOptions = {
    orchestrationRead: {
      getInputSubmission: (inputSubmissionId) => inputSubmissionId === input.inputSubmissionId ? input : undefined,
      findTurnByInputSubmission: (inputSubmissionId) => inputSubmissionId === input.inputSubmissionId
        ? mutable.turn
        : undefined,
      getControlAudit: (sessionControlAuditId) => sessionControlAuditId === mutable.control.sessionControlAuditId
        ? mutable.control
        : undefined,
    },
    messageRead: { getMessage: readMessage },
    taskRunRead: {
      getGeneration: (logicalSessionId) => mutable.generationAvailable && logicalSessionId === "logical_session_worker-1"
        ? mutable.generation
        : undefined,
      getSlot: (cardSessionSlotId) => cardSessionSlotId === mutable.slot.cardSessionSlotId
        ? mutable.slot
        : undefined,
      getConductorSessionId: () => mutable.conductorSessionId,
      readTaskRunState: (taskId, runId) => ({ taskId, runId, runStatus: mutable.runStatus }),
    },
    currentBindingRead: {
      getCurrentBinding: (logicalSessionId) => logicalSessionId === generation.sessionId
        ? mutable.currentBinding
        : undefined,
    },
    resolveFrozenProfileTuple: () => mutable.frozenProfile,
    providerEffectRead: {
      findByIdempotencyKey: ({ idempotencyKey }) => repository.snapshot().providerEffects
        .find((intent) => intent.idempotencyKey === idempotencyKey),
    },
    sessionRuntimeOwner: owner,
    settlementCoordinator: { acceptSettlement },
  };
  const bridge = createSessionIdAcpOrchestrationBridge(options);
  return {
    repository,
    bridge,
    runtimeOwner: owner,
    readMessage,
    acceptSettlement,
    get currentBinding() { return mutable.currentBinding; },
    set currentBinding(value) { mutable.currentBinding = value; },
    get frozenProfile() { return mutable.frozenProfile; },
    set frozenProfile(value) { mutable.frozenProfile = value; },
    get control() { return mutable.control; },
    set control(value) { mutable.control = value; },
    get turn() { return mutable.turn; },
    set turn(value) { mutable.turn = value; },
    get generationAvailable() { return mutable.generationAvailable; },
    set generationAvailable(value) { mutable.generationAvailable = value; },
    get conductorSessionId() { return mutable.conductorSessionId; },
    set conductorSessionId(value) { mutable.conductorSessionId = value; },
    get runStatus() { return mutable.runStatus; },
    set runStatus(value) { mutable.runStatus = value; },
    get slot() { return mutable.slot; },
    set slot(value) { mutable.slot = value; },
    get generation() { return mutable.generation; },
    set generation(value) { mutable.generation = value; },
  };
}

function binding(): AcpSafeSessionBindingRecordV3 {
  return {
    schemaVersion: 3,
    bindingId: "binding_1",
    taskId: "task_1",
    runId: "run_1",
    logicalSessionId: "logical_session_worker-1",
    agentCardId: "agent_card_worker",
    executionProfileId: "profile_worker",
    profileRevisionId: "profile_revision_worker-1",
    providerFamily: "opencode",
    bindingHandle: "binding_handle_worker-1",
    status: "active",
    recoverable: true,
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function completedSettlement(): SessionExecutionSettlement {
  return {
    sessionExecutionRuntimeId: "session_execution_runtime_1",
    sessionExecutionAttemptId: "session_execution_attempt_1",
    taskId: "task_1",
    runId: "run_1",
    logicalSessionId: "logical_session_worker-1",
    bindingId: "binding_1",
    bindingRevision: 1,
    executionProfileId: "profile_worker",
    profileRevisionId: "profile_revision_worker-1",
    inputSubmissionId: "input_delivery-1",
    orchestrationSessionTurnId: "session_turn_delivery-1",
    outcome: "completed",
    receiptDigest: "sha256:receipt-1",
    finalContent: CONTENT,
    finalContentDigest: hashDefinition(CONTENT),
    settledAt: NOW,
  };
}

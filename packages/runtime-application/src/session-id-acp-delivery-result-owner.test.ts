import { describe, expect, it, vi } from "vitest";
import {
  hashDefinition,
  type AcpSafeSessionBindingRecordV3,
  type CardSessionGenerationRecord,
  type CardSessionSlotRecord,
  type SessionControlAuditRecord,
  type SessionExecutionAttemptRecord,
  type SessionExecutionRuntimeRecord,
  type SessionExecutionSettlement,
  type SessionIdMessageForwardRecord,
  type SessionLaneItemRecord,
  type SessionRuntimeProviderEffectIntentRecord,
} from "@agent-workspace/runtime-contracts";
import type {
  SessionIdHumanInterventionRecord,
  SessionIdInputSubmissionRecord,
  SessionIdSessionMessageRecord,
  SessionIdSessionTurnRecord,
} from "@agent-workspace/runtime-store";
import {
  createSessionIdAcpDeliveryResultOwner,
  type SessionIdAcpDeliveryResultOwnerCapabilities,
} from "./session-id-acp-delivery-result-owner";

const NOW = "2026-08-12T00:00:00.000Z";
const LATER = "2026-08-12T00:00:05.000Z";
const CONTENT = "Canonical Message-owner delivery";
const RECEIPT = `sha256:${"a".repeat(64)}`;

describe("Session-ID ACP delivery/result owner", () => {
  it("atomically creates OR Input/Turn/lease from Inbox/Message and exposes one replayable drain ID", () => {
    const fixture = createFixture();

    const staged = fixture.owner.stageReadyDelivery({ logicalSessionId: WORKER_SESSION_ID });

    expect(staged).toEqual({
      disposition: "staged",
      inboxItemId: INBOX_ID,
      inputSubmissionId: "input_1",
      sessionTurnId: "session_turn_2",
      providerEffectIntentId: "provider_effect_1",
      sessionExecutionRuntimeId: "session_execution_runtime_1",
      sessionExecutionAttemptId: "session_execution_attempt_1",
    });
    expect(fixture.inputs.get("input_1")).toMatchObject({
      sourceInboxItemId: INBOX_ID,
      contentMessageId: MESSAGE_ID,
      commandId: "command_forward-1",
      state: "pending",
    });
    expect(fixture.turns.get("session_turn_2")).toMatchObject({
      inputSubmissionId: "input_1",
      sourceConductorSessionTurnId: "session_turn_conductor-1",
      trigger: "conductor_send",
      state: "pending",
    });
    expect(fixture.inbox.get(INBOX_ID)).toMatchObject({ state: "leased" });
    expect(fixture.interventions.get("human_intervention_unused")).toBeUndefined();
    expect(fixture.stageDelivery).toHaveBeenCalledWith({ inputSubmissionId: "input_1" });

    expect(fixture.owner.stageReadyDelivery({ logicalSessionId: WORKER_SESSION_ID }))
      .toEqual({ ...staged, disposition: "replay" });
    expect(fixture.inputs).toHaveLength(1);
    expect(fixture.turns).toHaveLength(1);
    expect(fixture.intents).toHaveLength(1);

    expect(() => fixture.owner.stageReadyDelivery({
      logicalSessionId: WORKER_SESSION_ID,
      // @ts-expect-error Caller content is forbidden; Message owner is the only source.
      content: "caller forged",
    })).toThrow(/input_shape_invalid/);
  });

  it("does not consume the Card intervention when the Conductor mirror terminal fails", () => {
    const fixture = createFixture("conductor");
    fixture.messages.set(MESSAGE_ID, Object.freeze({
      messageId: MESSAGE_ID,
      taskId: TASK_ID,
      runId: RUN_ID,
      kind: "user_input",
      content: CONTENT,
      canonicalContent: Object.freeze([{ kind: "text" as const, text: CONTENT }]),
      contentDigest: hashDefinition(CONTENT),
      sourceHumanInterventionId: "human_intervention_mirror",
      createdAt: NOW,
    }));
    fixture.inbox.set(INBOX_ID, Object.freeze({
      ...fixture.inbox.get(INBOX_ID)!,
      priority: "human",
      humanInterventionId: "human_intervention_mirror",
    }));
    fixture.messages.set("message_human_card", Object.freeze({
      messageId: "message_human_card",
      taskId: TASK_ID,
      runId: RUN_ID,
      kind: "user_input",
      content: CONTENT,
      canonicalContent: Object.freeze([{ kind: "text" as const, text: CONTENT }]),
      contentDigest: hashDefinition(CONTENT),
      sourceHumanInterventionId: "human_intervention_mirror",
      createdAt: NOW,
    }));
    fixture.inbox.set("inbox_human_card", Object.freeze({
      inboxItemId: "inbox_human_card",
      taskId: TASK_ID,
      runId: RUN_ID,
      sessionId: WORKER_SESSION_ID,
      renderedMessageId: "message_human_card",
      sequence: 1,
      priority: "human",
      state: "pending",
      humanInterventionId: "human_intervention_mirror",
      createdAt: NOW,
      updatedAt: NOW,
    }));
    fixture.interventions.set("human_intervention_mirror", Object.freeze({
      humanInterventionId: "human_intervention_mirror",
      taskId: TASK_ID,
      runId: RUN_ID,
      commandId: "command_human_mirror",
      idempotencyKey: "human:mirror",
      targetSessionId: WORKER_SESSION_ID,
      mode: "direct_message",
      state: "accepted",
      cardMessageId: "message_human_card",
      conductorMirrorMessageId: MESSAGE_ID,
      authenticatedUserId: "user_local",
      createdAt: NOW,
      updatedAt: NOW,
    }));

    const mirror = requireStaged(fixture.owner.stageReadyDelivery({
      logicalSessionId: CONDUCTOR_SESSION_ID,
    }));
    fixture.observeReceipt(mirror.sessionExecutionAttemptId, RECEIPT);
    fixture.owner.acceptEffectObservation(fixture.deliveryReceipt(mirror));
    const failed = fixture.setFailedSettlement(mirror.sessionExecutionAttemptId);
    expect(fixture.owner.acceptSettlement(failed))
      .toEqual({ status: "recorded", outcome: "delivery_failed" });
    expect(fixture.interventions.get("human_intervention_mirror")).toMatchObject({
      targetSessionId: WORKER_SESSION_ID,
      state: "accepted",
    });
    expect(fixture.owner.stageReadyDelivery({ logicalSessionId: WORKER_SESSION_ID }))
      .toMatchObject({ disposition: "staged", inboxItemId: "inbox_human_card" });
  });

  it("rolls back Input/Turn/lease and v3 intent when the frozen bridge cannot stage", () => {
    const fixture = createFixture();
    fixture.failStageAfterIntent = true;

    expect(() => fixture.owner.stageReadyDelivery({ logicalSessionId: WORKER_SESSION_ID }))
      .toThrow(/controlled_stage_failure/);
    expect(fixture.inputs).toHaveLength(0);
    expect(fixture.turns).toHaveLength(0);
    expect(fixture.intents).toHaveLength(0);
    expect(fixture.attempts).toHaveLength(0);
    expect(fixture.runtimes).toHaveLength(0);
    expect(fixture.inbox.get(INBOX_ID)).toMatchObject({ state: "pending" });
  });

  it("refuses stage and receipt when the Card is not the exact current slot generation", () => {
    const staleStage = createFixture();
    staleStage.slot = { ...staleStage.slot, latestGeneration: 2 };
    const beforeStage = staleStage.snapshot();
    expect(() => staleStage.owner.stageReadyDelivery({ logicalSessionId: WORKER_SESSION_ID }))
      .toThrow(/session_not_current/);
    expect(staleStage.snapshot()).toEqual(beforeStage);

    const staleReceipt = createFixture();
    const staged = requireStaged(staleReceipt.owner.stageReadyDelivery({ logicalSessionId: WORKER_SESSION_ID }));
    staleReceipt.observeReceipt(staged.sessionExecutionAttemptId, RECEIPT);
    staleReceipt.generation = {
      ...staleReceipt.generation,
      closedAt: LATER,
    } as CardSessionGenerationRecord;
    const beforeReceipt = staleReceipt.snapshot();
    expect(() => staleReceipt.owner.acceptEffectObservation(staleReceipt.deliveryReceipt(staged)))
      .toThrow(/session_not_current/);
    expect(staleReceipt.snapshot()).toEqual(beforeReceipt);
  });

  it("lets only an exact persisted receipt advance pending/pending/leased to accepted/active/handed", () => {
    const fixture = createFixture();
    const staged = requireStaged(fixture.owner.stageReadyDelivery({ logicalSessionId: WORKER_SESSION_ID }));
    const before = fixture.snapshot();

    expect(() => fixture.owner.acceptEffectObservation({
      ...fixture.deliveryReceipt(staged),
      receiptDigest: RECEIPT,
    })).toThrow(/receipt_not_observed/);
    expect(fixture.snapshot()).toEqual(before);

    fixture.observeReceipt(staged.sessionExecutionAttemptId, RECEIPT);
    expect(() => fixture.owner.acceptEffectObservation({
      ...fixture.deliveryReceipt(staged),
      receiptDigest: `sha256:${"b".repeat(64)}`,
    })).toThrow(/receipt_mismatch/);
    expect(fixture.inputs.get(staged.inputSubmissionId)).toMatchObject({ state: "pending" });

    expect(fixture.owner.acceptEffectObservation({
      ...fixture.deliveryReceipt(staged),
    })).toEqual({ status: "recorded", outcome: "delivery_accepted" });
    expect(fixture.inputs.get(staged.inputSubmissionId)).toMatchObject({ state: "accepted" });
    expect(fixture.turns.get(staged.sessionTurnId)).toMatchObject({ state: "active" });
    expect(fixture.inbox.get(staged.inboxItemId)).toMatchObject({ state: "handed" });
    expect(fixture.owner.acceptEffectObservation({
      ...fixture.deliveryReceipt(staged),
    })).toEqual({ status: "replayed", outcome: "delivery_accepted" });
  });

  it("uses the canonical three-record state machine for unknown and safe rejected delivery outcomes", () => {
    const unknown = createFixture();
    const unknownStage = requireStaged(unknown.owner.stageReadyDelivery({ logicalSessionId: WORKER_SESSION_ID }));
    unknown.markAttemptReconciling(unknownStage.sessionExecutionAttemptId);

    expect(unknown.owner.acceptEffectObservation({
      kind: "delivery_unknown",
      providerEffectIntentId: unknownStage.providerEffectIntentId,
      sessionExecutionAttemptId: unknownStage.sessionExecutionAttemptId,
    })).toEqual({ status: "recorded", outcome: "delivery_ambiguous" });
    expect(unknown.inputs.get(unknownStage.inputSubmissionId)).toMatchObject({ state: "ambiguous" });
    expect(unknown.turns.get(unknownStage.sessionTurnId)).toMatchObject({ state: "ambiguous" });
    expect(unknown.inbox.get(unknownStage.inboxItemId)).toMatchObject({
      state: "ambiguous",
      reason: "provider_outcome_unknown",
    });
    expect(unknown.owner.acceptEffectObservation({
      kind: "delivery_unknown",
      providerEffectIntentId: unknownStage.providerEffectIntentId,
      sessionExecutionAttemptId: unknownStage.sessionExecutionAttemptId,
    })).toEqual({ status: "replayed", outcome: "delivery_ambiguous" });

    const rejected = createFixture();
    const rejectedStage = requireStaged(rejected.owner.stageReadyDelivery({ logicalSessionId: WORKER_SESSION_ID }));
    expect(rejected.owner.acceptEffectObservation({
      kind: "delivery_rejected",
      providerEffectIntentId: rejectedStage.providerEffectIntentId,
      sessionExecutionAttemptId: rejectedStage.sessionExecutionAttemptId,
    })).toEqual({ status: "recorded", outcome: "delivery_rejected" });
    expect(rejected.inputs.get(rejectedStage.inputSubmissionId)).toMatchObject({ state: "failed" });
    expect(rejected.turns.get(rejectedStage.sessionTurnId)).toMatchObject({ state: "failed", settledAt: LATER });
    expect(rejected.inbox.get(rejectedStage.inboxItemId)).toMatchObject({
      state: "suppressed",
      reason: "provider_effect_rejected",
    });
  });

  it("lets an exact late receipt recover the same ambiguous delivery tuple and rejects mixed recovery state", () => {
    const fixture = createFixture();
    const staged = requireStaged(fixture.owner.stageReadyDelivery({ logicalSessionId: WORKER_SESSION_ID }));
    fixture.markAttemptReconciling(staged.sessionExecutionAttemptId);
    fixture.owner.acceptEffectObservation({
      kind: "delivery_unknown",
      providerEffectIntentId: staged.providerEffectIntentId,
      sessionExecutionAttemptId: staged.sessionExecutionAttemptId,
    });
    fixture.observeReceipt(staged.sessionExecutionAttemptId, RECEIPT);

    expect(fixture.owner.acceptEffectObservation(fixture.deliveryReceipt(staged)))
      .toEqual({ status: "recorded", outcome: "delivery_accepted" });
    expect(fixture.inputs.get(staged.inputSubmissionId)).toMatchObject({ state: "accepted" });
    expect(fixture.turns.get(staged.sessionTurnId)).toMatchObject({ state: "active" });
    expect(fixture.inbox.get(staged.inboxItemId)).toMatchObject({ state: "handed" });
    expect(fixture.inbox.get(staged.inboxItemId)).not.toHaveProperty("reason");
    expect(fixture.owner.acceptEffectObservation(fixture.deliveryReceipt(staged)))
      .toEqual({ status: "replayed", outcome: "delivery_accepted" });

    const mixed = createFixture();
    const mixedStage = requireStaged(mixed.owner.stageReadyDelivery({ logicalSessionId: WORKER_SESSION_ID }));
    mixed.markAttemptReconciling(mixedStage.sessionExecutionAttemptId);
    mixed.owner.acceptEffectObservation({
      kind: "delivery_unknown",
      providerEffectIntentId: mixedStage.providerEffectIntentId,
      sessionExecutionAttemptId: mixedStage.sessionExecutionAttemptId,
    });
    mixed.observeReceipt(mixedStage.sessionExecutionAttemptId, RECEIPT);
    mixed.inputs.set(mixedStage.inputSubmissionId, {
      ...mixed.inputs.get(mixedStage.inputSubmissionId)!,
      state: "accepted",
    });
    const before = mixed.snapshot();
    expect(() => mixed.owner.acceptEffectObservation(mixed.deliveryReceipt(mixedStage)))
      .toThrow(/receipt_or_state_conflict/);
    expect(mixed.snapshot()).toEqual(before);
  });

  it("does not downgrade a delivery whose exact Attempt already has a receipt when reconcile is unknown", () => {
    const fixture = createFixture();
    const staged = requireStaged(fixture.owner.stageReadyDelivery({ logicalSessionId: WORKER_SESSION_ID }));
    fixture.observeReceipt(staged.sessionExecutionAttemptId, RECEIPT, "reconciling");

    expect(fixture.owner.acceptEffectObservation({
      kind: "delivery_unknown",
      providerEffectIntentId: staged.providerEffectIntentId,
      sessionExecutionAttemptId: staged.sessionExecutionAttemptId,
    })).toEqual({ status: "recorded", outcome: "delivery_accepted_reconciling" });
    expect(fixture.inputs.get(staged.inputSubmissionId)).toMatchObject({ state: "accepted" });
    expect(fixture.turns.get(staged.sessionTurnId)).toMatchObject({ state: "active" });
    expect(fixture.inbox.get(staged.inboxItemId)).toMatchObject({ state: "handed" });
  });

  it("correlates interrupt observations through the exact v3 intent/Attempt and advances canonical Control/Turn state", () => {
    const fixture = createFixture();
    const staged = requireStaged(fixture.owner.stageReadyDelivery({ logicalSessionId: WORKER_SESSION_ID }));
    fixture.observeReceipt(staged.sessionExecutionAttemptId, RECEIPT);
    fixture.owner.acceptEffectObservation({
      ...fixture.deliveryReceipt(staged),
    });
    const interruptIntent = fixture.seedInterruptIntent(staged);

    expect(fixture.owner.acceptEffectObservation({
      kind: "interrupt_accepted",
      providerEffectIntentId: interruptIntent.providerEffectIntentId,
      sessionExecutionAttemptId: staged.sessionExecutionAttemptId,
    })).toEqual({ status: "recorded", outcome: "interrupt_accepted" });
    expect(fixture.controls.get(CONTROL_ID)).toMatchObject({ state: "accepted" });
    expect(fixture.controls.get(CONTROL_ID)).not.toHaveProperty("settledAt");

    fixture.setCancelledSettlement(staged.sessionExecutionAttemptId);
    expect(fixture.owner.acceptEffectObservation({
      kind: "interrupt_confirmed",
      providerEffectIntentId: interruptIntent.providerEffectIntentId,
      sessionExecutionAttemptId: staged.sessionExecutionAttemptId,
    })).toEqual({ status: "recorded", outcome: "interrupt_confirmed" });
    expect(fixture.controls.get(CONTROL_ID)).toMatchObject({ state: "confirmed", settledAt: LATER });
    expect(fixture.turns.get(staged.sessionTurnId)).toMatchObject({ state: "interrupted", settledAt: LATER });
    expect(fixture.inputs.get(staged.inputSubmissionId)).toMatchObject({ state: "cancelled" });
    expect(fixture.inbox.get(staged.inboxItemId)).toMatchObject({ state: "handled" });
    expect(fixture.owner.acceptEffectObservation({
      kind: "interrupt_confirmed",
      providerEffectIntentId: interruptIntent.providerEffectIntentId,
      sessionExecutionAttemptId: staged.sessionExecutionAttemptId,
    })).toEqual({ status: "replayed", outcome: "interrupt_confirmed" });
  });

  it("requires the receipt-time OR fence before delegating a completed settlement to canonical recordAgentFinal", () => {
    const fixture = createFixture();
    const staged = requireStaged(fixture.owner.stageReadyDelivery({ logicalSessionId: WORKER_SESSION_ID }));
    const settlement = fixture.setCompletedSettlement(staged.sessionExecutionAttemptId);

    expect(() => fixture.owner.acceptSettlement(settlement))
      .toThrow(/or_state_not_accepted/);
    expect(fixture.acceptSettlement).not.toHaveBeenCalled();

    fixture.owner.acceptEffectObservation({
      ...fixture.deliveryReceipt(staged),
    });
    fixture.acceptSettlement.mockReturnValueOnce({
      status: "recorded",
      messageId: "message_final-1",
      inboxItemId: "inbox_final-1",
    }).mockReturnValueOnce({
      status: "replayed",
      messageId: "message_final-1",
      inboxItemId: "inbox_final-1",
    });
    expect(fixture.owner.acceptSettlement(settlement)).toMatchObject({ status: "recorded" });

    fixture.inputs.set(staged.inputSubmissionId, {
      ...fixture.inputs.get(staged.inputSubmissionId)!,
      state: "returned",
    });
    fixture.turns.set(staged.sessionTurnId, {
      ...fixture.turns.get(staged.sessionTurnId)!,
      state: "returned",
      finalMessageId: "message_final-1",
      settledAt: LATER,
    });
    fixture.inbox.set(staged.inboxItemId, {
      ...fixture.inbox.get(staged.inboxItemId)!,
      state: "handled",
    });
    expect(fixture.owner.acceptSettlement(settlement)).toMatchObject({ status: "replayed" });
    expect(fixture.acceptSettlement).toHaveBeenCalledTimes(2);
  });

  it("atomically closes a completed Conductor planning Turn without manufacturing a Card Final", () => {
    const fixture = createFixture("conductor");
    const staged = requireStaged(fixture.owner.stageReadyDelivery({
      logicalSessionId: CONDUCTOR_SESSION_ID,
    }));
    fixture.observeReceipt(staged.sessionExecutionAttemptId, RECEIPT);
    fixture.owner.acceptEffectObservation(fixture.deliveryReceipt(staged));
    const settlement = fixture.setCompletedSettlement(staged.sessionExecutionAttemptId);

    expect(fixture.owner.acceptSettlement(settlement)).toEqual({
      status: "recorded",
      outcome: "conductor_turn_completed",
    });
    expect(fixture.inputs.get(staged.inputSubmissionId)).toMatchObject({ state: "returned" });
    expect(fixture.turns.get(staged.sessionTurnId)).toMatchObject({
      state: "returned",
      settledAt: LATER,
    });
    expect(fixture.turns.get(staged.sessionTurnId)).not.toHaveProperty("finalMessageId");
    expect(fixture.inbox.get(staged.inboxItemId)).toMatchObject({ state: "handled" });
    expect(fixture.acceptSettlement).not.toHaveBeenCalled();
    expect(fixture.acceptNotice).not.toHaveBeenCalled();
    expect(fixture.owner.acceptSettlement(settlement)).toEqual({
      status: "replayed",
      outcome: "conductor_turn_completed",
    });
  });

  it("closes a failed Conductor Turn without requiring a Card generation or self-Notice", () => {
    const fixture = createFixture("conductor");
    const staged = requireStaged(fixture.owner.stageReadyDelivery({
      logicalSessionId: CONDUCTOR_SESSION_ID,
    }));
    fixture.observeReceipt(staged.sessionExecutionAttemptId, RECEIPT);
    fixture.owner.acceptEffectObservation(fixture.deliveryReceipt(staged));
    const settlement = fixture.setFailedSettlement(staged.sessionExecutionAttemptId);

    expect(fixture.owner.acceptSettlement(settlement)).toEqual({
      status: "recorded",
      outcome: "delivery_failed",
    });
    expect(fixture.inputs.get(staged.inputSubmissionId)).toMatchObject({ state: "failed" });
    expect(fixture.turns.get(staged.sessionTurnId)).toMatchObject({ state: "failed", settledAt: LATER });
    expect(fixture.inbox.get(staged.inboxItemId)).toMatchObject({ state: "handled" });
    expect(fixture.acceptSettlement).not.toHaveBeenCalled();
    expect(fixture.acceptNotice).not.toHaveBeenCalled();
  });

  it("closes failed and interrupt-correlated cancelled settlements without inventing a Final", () => {
    const failed = createFixture();
    const failedStage = requireStaged(failed.owner.stageReadyDelivery({ logicalSessionId: WORKER_SESSION_ID }));
    failed.observeReceipt(failedStage.sessionExecutionAttemptId, RECEIPT);
    failed.owner.acceptEffectObservation(failed.deliveryReceipt(failedStage));
    const failedSettlement = failed.setFailedSettlement(failedStage.sessionExecutionAttemptId);

    expect(failed.owner.acceptSettlement(failedSettlement))
      .toEqual({ status: "recorded", outcome: "delivery_failed" });
    expect(failed.inputs.get(failedStage.inputSubmissionId)).toMatchObject({ state: "failed" });
    expect(failed.turns.get(failedStage.sessionTurnId)).toMatchObject({ state: "failed", settledAt: LATER });
    expect(failed.inbox.get(failedStage.inboxItemId)).toMatchObject({ state: "handled" });
    expect(failed.owner.acceptSettlement(failedSettlement))
      .toEqual({ status: "replayed", outcome: "delivery_failed" });
    expect(failed.acceptSettlement).not.toHaveBeenCalled();

    const cancelled = createFixture();
    const cancelledStage = requireStaged(cancelled.owner.stageReadyDelivery({ logicalSessionId: WORKER_SESSION_ID }));
    cancelled.observeReceipt(cancelledStage.sessionExecutionAttemptId, RECEIPT);
    cancelled.owner.acceptEffectObservation(cancelled.deliveryReceipt(cancelledStage));
    const cancelledSettlement = cancelled.setCancelledSettlement(cancelledStage.sessionExecutionAttemptId);
    expect(() => cancelled.owner.acceptSettlement(cancelledSettlement))
      .toThrow(/cancelled_interrupt_correlation_missing/);
    expect(cancelled.turns.get(cancelledStage.sessionTurnId)).toMatchObject({ state: "active" });

    cancelled.seedInterruptIntent(cancelledStage);
    expect(cancelled.owner.acceptSettlement(cancelledSettlement))
      .toEqual({ status: "recorded", outcome: "delivery_cancelled" });
    expect(cancelled.controls.get(CONTROL_ID)).toMatchObject({ state: "confirmed" });
    expect(cancelled.inputs.get(cancelledStage.inputSubmissionId)).toMatchObject({ state: "cancelled" });
    expect(cancelled.turns.get(cancelledStage.sessionTurnId)).toMatchObject({ state: "interrupted" });
    expect(cancelled.inbox.get(cancelledStage.inboxItemId)).toMatchObject({ state: "handled" });
    expect(cancelled.owner.acceptSettlement(cancelledSettlement))
      .toEqual({ status: "replayed", outcome: "delivery_cancelled" });
    expect(cancelled.acceptSettlement).not.toHaveBeenCalled();
  });

  it("lets completed and failed terminal settlements win while closing the exact interrupt as unknown", () => {
    const completed = createFixture();
    const completedStage = requireStaged(completed.owner.stageReadyDelivery({
      logicalSessionId: WORKER_SESSION_ID,
    }));
    completed.observeReceipt(completedStage.sessionExecutionAttemptId, RECEIPT);
    completed.owner.acceptEffectObservation(completed.deliveryReceipt(completedStage));
    completed.seedInterruptIntent(completedStage);
    const completedSettlement = completed.setCompletedSettlement(completedStage.sessionExecutionAttemptId);
    completed.acceptSettlement
      .mockReturnValueOnce({ status: "recorded", messageId: "message_final-1", inboxItemId: "inbox_final-1" })
      .mockReturnValueOnce({ status: "replayed", messageId: "message_final-1", inboxItemId: "inbox_final-1" });

    expect(completed.owner.acceptSettlement(completedSettlement)).toMatchObject({ status: "recorded" });
    expect(completed.controls.get(CONTROL_ID)).toMatchObject({
      state: "unknown",
      reason: "provider_terminal_won",
      settledAt: LATER,
    });
    expect(completed.owner.acceptSettlement(completedSettlement)).toMatchObject({ status: "replayed" });

    const failed = createFixture();
    const failedStage = requireStaged(failed.owner.stageReadyDelivery({ logicalSessionId: WORKER_SESSION_ID }));
    failed.observeReceipt(failedStage.sessionExecutionAttemptId, RECEIPT);
    failed.owner.acceptEffectObservation(failed.deliveryReceipt(failedStage));
    failed.seedInterruptIntent(failedStage);
    const failedSettlement = failed.setFailedSettlement(failedStage.sessionExecutionAttemptId);

    expect(failed.owner.acceptSettlement(failedSettlement))
      .toEqual({ status: "recorded", outcome: "delivery_failed" });
    expect(failed.controls.get(CONTROL_ID)).toMatchObject({
      state: "unknown",
      reason: "provider_terminal_won",
      settledAt: LATER,
    });
    expect(failed.owner.acceptSettlement(failedSettlement))
      .toEqual({ status: "replayed", outcome: "delivery_failed" });
  });

  it("lets completed and failed terminal facts win after interrupt_unknown made the Turn ambiguous", () => {
    const completed = createFixture();
    const completedStage = requireStaged(completed.owner.stageReadyDelivery({
      logicalSessionId: WORKER_SESSION_ID,
    }));
    completed.observeReceipt(completedStage.sessionExecutionAttemptId, RECEIPT);
    completed.owner.acceptEffectObservation(completed.deliveryReceipt(completedStage));
    const completedInterrupt = completed.seedInterruptIntent(completedStage);
    completed.markAttemptReconciling(completedStage.sessionExecutionAttemptId);
    completed.owner.acceptEffectObservation({
      kind: "interrupt_unknown",
      providerEffectIntentId: completedInterrupt.providerEffectIntentId,
      sessionExecutionAttemptId: completedStage.sessionExecutionAttemptId,
    });
    expect(completed.controls.get(CONTROL_ID)).toMatchObject({
      state: "unknown",
      reason: "provider_outcome_unknown",
    });
    expect(completed.turns.get(completedStage.sessionTurnId)).toMatchObject({ state: "ambiguous" });
    const completedSettlement = completed.setCompletedSettlement(completedStage.sessionExecutionAttemptId);
    completed.acceptSettlement.mockReturnValueOnce({
      status: "recorded",
      messageId: "message_final-late",
      inboxItemId: "inbox_final-late",
    });

    expect(completed.owner.acceptSettlement(completedSettlement)).toMatchObject({ status: "recorded" });
    expect(completed.controls.get(CONTROL_ID)).toMatchObject({
      state: "unknown",
      reason: "provider_terminal_won",
      settledAt: LATER,
    });
    expect(completed.acceptSettlement).toHaveBeenCalledWith(completedSettlement);

    const failed = createFixture();
    const failedStage = requireStaged(failed.owner.stageReadyDelivery({ logicalSessionId: WORKER_SESSION_ID }));
    failed.observeReceipt(failedStage.sessionExecutionAttemptId, RECEIPT);
    failed.owner.acceptEffectObservation(failed.deliveryReceipt(failedStage));
    const failedInterrupt = failed.seedInterruptIntent(failedStage);
    failed.markAttemptReconciling(failedStage.sessionExecutionAttemptId);
    failed.owner.acceptEffectObservation({
      kind: "interrupt_unknown",
      providerEffectIntentId: failedInterrupt.providerEffectIntentId,
      sessionExecutionAttemptId: failedStage.sessionExecutionAttemptId,
    });
    const failedSettlement = failed.setFailedSettlement(failedStage.sessionExecutionAttemptId);

    expect(failed.owner.acceptSettlement(failedSettlement))
      .toEqual({ status: "recorded", outcome: "delivery_failed" });
    expect(failed.controls.get(CONTROL_ID)).toMatchObject({
      state: "unknown",
      reason: "provider_terminal_won",
      settledAt: LATER,
    });
    expect(failed.inputs.get(failedStage.inputSubmissionId)).toMatchObject({ state: "failed" });
    expect(failed.turns.get(failedStage.sessionTurnId)).toMatchObject({ state: "failed", settledAt: LATER });
    expect(failed.inbox.get(failedStage.inboxItemId)).toMatchObject({ state: "handled" });
    expect(failed.owner.acceptSettlement(failedSettlement))
      .toEqual({ status: "replayed", outcome: "delivery_failed" });
  });

  it("fails closed when a terminal settlement sees cross-attempt or duplicate interrupt correlation", () => {
    const crossAttempt = createFixture();
    const crossStage = requireStaged(crossAttempt.owner.stageReadyDelivery({
      logicalSessionId: WORKER_SESSION_ID,
    }));
    crossAttempt.observeReceipt(crossStage.sessionExecutionAttemptId, RECEIPT);
    crossAttempt.owner.acceptEffectObservation(crossAttempt.deliveryReceipt(crossStage));
    const crossIntent = crossAttempt.seedInterruptIntent(crossStage);
    crossAttempt.intents.set(crossIntent.providerEffectIntentId, Object.freeze({
      ...crossIntent,
      sessionExecutionAttemptId: "session_execution_attempt_cross",
      effect: Object.freeze({
        ...crossIntent.effect,
        sessionExecutionAttemptId: "session_execution_attempt_cross",
      }),
    }));
    const crossSettlement = crossAttempt.setCompletedSettlement(crossStage.sessionExecutionAttemptId);
    const crossSnapshot = crossAttempt.snapshot();

    expect(() => crossAttempt.owner.acceptSettlement(crossSettlement))
      .toThrow(/terminal_interrupt_attempt_mismatch/);
    expect(crossAttempt.snapshot()).toEqual(crossSnapshot);
    expect(crossAttempt.acceptSettlement).not.toHaveBeenCalled();

    const duplicate = createFixture();
    const duplicateStage = requireStaged(duplicate.owner.stageReadyDelivery({
      logicalSessionId: WORKER_SESSION_ID,
    }));
    duplicate.observeReceipt(duplicateStage.sessionExecutionAttemptId, RECEIPT);
    duplicate.owner.acceptEffectObservation(duplicate.deliveryReceipt(duplicateStage));
    const first = duplicate.seedInterruptIntent(duplicateStage);
    duplicate.intents.set("provider_effect_interrupt-duplicate", Object.freeze({
      ...first,
      providerEffectIntentId: "provider_effect_interrupt-duplicate",
      commandId: "command_acp_interrupt-duplicate",
      idempotencyKey: "acp:interrupt:duplicate",
    }));
    const duplicateSettlement = duplicate.setFailedSettlement(duplicateStage.sessionExecutionAttemptId);
    const duplicateSnapshot = duplicate.snapshot();

    expect(() => duplicate.owner.acceptSettlement(duplicateSettlement))
      .toThrow(/terminal_interrupt_correlation_ambiguous/);
    expect(duplicate.snapshot()).toEqual(duplicateSnapshot);
  });
});

const TASK_ID = "task_1";
const RUN_ID = "run_1";
const CONDUCTOR_SESSION_ID = "logical_session_conductor-1";
const WORKER_SESSION_ID = "logical_session_worker-1";
const MESSAGE_ID = "message_delivery-1";
const INBOX_ID = "inbox_delivery-1";
const CONTROL_ID = "session_control_interrupt-1";

function createFixture(target: "worker" | "conductor" = "worker") {
  const messages = new Map<string, SessionIdSessionMessageRecord>();
  const forwards = new Map<string, SessionIdMessageForwardRecord>();
  const inbox = new Map<string, SessionLaneItemRecord>();
  const inputs = new Map<string, SessionIdInputSubmissionRecord>();
  const turns = new Map<string, SessionIdSessionTurnRecord>();
  const controls = new Map<string, SessionControlAuditRecord>();
  const interventions = new Map<string, SessionIdHumanInterventionRecord>();
  const intents = new Map<string, SessionRuntimeProviderEffectIntentRecord>();
  const attempts = new Map<string, SessionExecutionAttemptRecord>();
  const runtimes = new Map<string, SessionExecutionRuntimeRecord>();
  let failStageAfterIntent = false;
  let idSequence = 0;
  let stageSequence = 0;

  const targetSessionId = target === "conductor" ? CONDUCTOR_SESSION_ID : WORKER_SESSION_ID;
  messages.set(MESSAGE_ID, Object.freeze({
    messageId: MESSAGE_ID,
    taskId: TASK_ID,
    runId: RUN_ID,
    ...(target === "worker" ? {
      sourceSessionId: CONDUCTOR_SESSION_ID,
      sourceSessionTurnId: "session_turn_conductor-1",
    } : {}),
    kind: target === "worker" ? "conductor_forward" : "task_goal",
    content: CONTENT,
    canonicalContent: Object.freeze([{ kind: "text" as const, text: CONTENT }]),
    contentDigest: hashDefinition(CONTENT),
    createdAt: NOW,
  }));
  if (target === "worker") forwards.set("forward_1", Object.freeze({
    forwardId: "forward_1",
    taskId: TASK_ID,
    runId: RUN_ID,
    commandId: "command_forward-1",
    idempotencyKey: "forward:1",
    decidedBySessionTurnId: "session_turn_conductor-1",
    targetSessionId: WORKER_SESSION_ID,
    orderedReferenceSnapshots: Object.freeze([]),
    renderedMessageId: MESSAGE_ID,
    createdAt: NOW,
  }));
  inbox.set(INBOX_ID, Object.freeze({
    inboxItemId: INBOX_ID,
    taskId: TASK_ID,
    runId: RUN_ID,
    sessionId: targetSessionId,
    renderedMessageId: MESSAGE_ID,
    sequence: 1,
    priority: "ordinary",
    state: "pending",
    ...(target === "worker" ? { forwardId: "forward_1" } : {}),
    createdAt: NOW,
    updatedAt: NOW,
  }));

  let slot: CardSessionSlotRecord = Object.freeze({
    cardSessionSlotId: "card_session_slot_worker",
    taskId: TASK_ID,
    runId: RUN_ID,
    agentCardId: "agent_card_worker",
    currentSessionId: WORKER_SESSION_ID,
    latestGeneration: 1,
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
  });
  let generation: CardSessionGenerationRecord = Object.freeze({
    sessionId: WORKER_SESSION_ID,
    cardSessionSlotId: slot.cardSessionSlotId,
    taskId: TASK_ID,
    runId: RUN_ID,
    agentCardId: slot.agentCardId,
    executionProfileId: "profile_worker",
    generation: 1,
    lifecycle: "current",
    createdAt: NOW,
  });
  const binding: AcpSafeSessionBindingRecordV3 = Object.freeze({
    schemaVersion: 3,
    bindingId: "binding_worker-1",
    taskId: TASK_ID,
    runId: RUN_ID,
    logicalSessionId: targetSessionId,
    agentCardId: target === "worker" ? slot.agentCardId : "agent_card_conductor",
    executionProfileId: target === "worker" ? generation.executionProfileId : "profile_conductor",
    profileRevisionId: target === "worker" ? "profile_revision_worker-1" : "profile_revision_conductor-1",
    providerFamily: "opencode",
    bindingHandle: "binding_handle_worker-1",
    status: "active",
    recoverable: true,
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
  });
  const workerBinding: AcpSafeSessionBindingRecordV3 = target === "worker"
    ? binding
    : Object.freeze({
        ...binding,
        bindingId: "binding_worker-1",
        logicalSessionId: WORKER_SESSION_ID,
        agentCardId: slot.agentCardId,
        executionProfileId: generation.executionProfileId,
        profileRevisionId: "profile_revision_worker-1",
        bindingHandle: "binding_handle_worker-1",
      });

  const capabilities: SessionIdAcpDeliveryResultOwnerCapabilities = {
    taskRun: {
      getGeneration: (sessionId) => sessionId === WORKER_SESSION_ID ? generation : undefined,
      getSlot: (slotId) => slotId === slot.cardSessionSlotId ? slot : undefined,
      getConductorSessionId: () => CONDUCTOR_SESSION_ID,
      readTaskRunState: () => ({
        taskId: TASK_ID,
        runId: RUN_ID,
        runStatus: "running",
        currentConductorSessionTurnId: "session_turn_conductor-1",
      }),
    },
    message: {
      getMessage: (messageId) => messages.get(messageId),
      getForward: (forwardId) => forwards.get(forwardId),
    },
    orchestration: {
      getInboxItem: (inboxItemId) => inbox.get(inboxItemId),
      listInboxItems: (sessionId) => [...inbox.values()].filter((item) => item.sessionId === sessionId),
      updateInboxItem: (item, expectedState) => updateState(inbox, item.inboxItemId, item, expectedState),
      createInputSubmission: (input) => insert(inputs, input.inputSubmissionId, input),
      getInputSubmission: (inputSubmissionId) => inputs.get(inputSubmissionId),
      findInputByInboxItem: (inboxItemId) => [...inputs.values()]
        .find((input) => input.sourceInboxItemId === inboxItemId),
      updateInputSubmission: (input, expectedState) => updateState(
        inputs,
        input.inputSubmissionId,
        input,
        expectedState,
      ),
      createTurn: (turn) => insert(turns, turn.sessionTurnId, turn),
      getTurn: (sessionTurnId) => turns.get(sessionTurnId),
      findTurnByInputSubmission: (inputSubmissionId) => [...turns.values()]
        .find((turn) => turn.inputSubmissionId === inputSubmissionId),
      listTurns: (sessionId) => [...turns.values()].filter((turn) => turn.sessionId === sessionId),
      updateTurn: (turn, expectedState) => updateState(turns, turn.sessionTurnId, turn, expectedState),
      getControlAudit: (controlId) => controls.get(controlId),
      updateControlAudit: (control, expectedState) => updateState(
        controls,
        control.sessionControlAuditId,
        control,
        expectedState,
      ),
    },
    humanIntervention: {
      get: (humanInterventionId) => interventions.get(humanInterventionId),
      update: (intervention) => interventions.set(intervention.humanInterventionId, intervention),
    },
    currentBinding: {
      getCurrentBinding: (sessionId) => sessionId === binding.logicalSessionId
        ? binding
        : sessionId === workerBinding.logicalSessionId
          ? workerBinding
          : undefined,
    },
    providerEffects: {
      getProviderEffectIntent: (providerEffectIntentId) => intents.get(providerEffectIntentId),
      listProviderEffectIntents: (attemptId) => [...intents.values()]
        .filter((intent) => attemptId === undefined || intent.sessionExecutionAttemptId === attemptId),
    },
    sessionExecution: {
      getRuntime: (runtimeId) => runtimes.get(runtimeId),
      getAttempt: (attemptId) => attempts.get(attemptId),
    },
  };

  const transaction = {
    run<T>(work: (owners: SessionIdAcpDeliveryResultOwnerCapabilities) => T): T {
      const before = snapshotMaps({ inbox, inputs, turns, controls, interventions, intents, attempts, runtimes });
      try {
        return work(capabilities);
      } catch (error) {
        restoreMaps(before, { inbox, inputs, turns, controls, interventions, intents, attempts, runtimes });
        throw error;
      }
    },
  };
  const stageDelivery = vi.fn(({ inputSubmissionId }: Readonly<{ inputSubmissionId: string }>) => {
    const input = inputs.get(inputSubmissionId);
    const turn = input ? [...turns.values()].find((candidate) => candidate.inputSubmissionId === inputSubmissionId) : undefined;
    const lane = input ? inbox.get(input.sourceInboxItemId) : undefined;
    if (!input || !turn || lane?.state !== "leased") throw new Error("bridge_observed_non_atomic_or_state");
    const existing = [...intents.values()].find((intent) => intent.inputSubmissionId === inputSubmissionId);
    if (existing) return Object.freeze({
      disposition: "replay" as const,
      commandType: existing.commandType,
      providerEffectIntentId: existing.providerEffectIntentId,
      sessionExecutionRuntimeId: existing.sessionExecutionRuntimeId,
      sessionExecutionAttemptId: existing.sessionExecutionAttemptId,
    });
    stageSequence += 1;
    const currentBinding = required(capabilities.currentBinding.getCurrentBinding(input.sessionId));
    const runtime = runtimeRecord(input, stageSequence);
    const attempt = attemptRecord(input, turn, currentBinding, stageSequence);
    const intent = deliveryIntent(input, turn, currentBinding, stageSequence);
    runtimes.set(runtime.sessionExecutionRuntimeId, runtime);
    attempts.set(attempt.sessionExecutionAttemptId, attempt);
    intents.set(intent.providerEffectIntentId, intent);
    if (failStageAfterIntent) throw new Error("controlled_stage_failure");
    return Object.freeze({
      disposition: "staged" as const,
      commandType: intent.commandType,
      providerEffectIntentId: intent.providerEffectIntentId,
      sessionExecutionRuntimeId: intent.sessionExecutionRuntimeId,
      sessionExecutionAttemptId: intent.sessionExecutionAttemptId,
    });
  });
  const acceptSettlement = vi.fn();
  const acceptNotice = vi.fn(() => Object.freeze({ status: "not_admitted" as const }));
  const owner = createSessionIdAcpDeliveryResultOwner({
    now: () => LATER,
    createId: (kind) => `${kind}_${++idSequence}`,
    task: {
      taskId: TASK_ID,
      runId: RUN_ID,
      conductorSessionId: CONDUCTOR_SESSION_ID,
      initialConductorSessionTurnId: "session_turn_conductor-1",
    },
    transaction,
    bridge: { stageDelivery, acceptSettlement },
    terminalNoticeCoordinator: { acceptNotice },
  });

  return {
    owner,
    messages,
    forwards,
    inbox,
    inputs,
    turns,
    controls,
    interventions,
    intents,
    attempts,
    runtimes,
    stageDelivery,
    acceptSettlement,
    acceptNotice,
    get failStageAfterIntent() { return failStageAfterIntent; },
    set failStageAfterIntent(value: boolean) { failStageAfterIntent = value; },
    get slot() { return slot; },
    set slot(value: CardSessionSlotRecord) { slot = value; },
    get generation() { return generation; },
    set generation(value: CardSessionGenerationRecord) { generation = value; },
    snapshot: () => snapshotMaps({ inbox, inputs, turns, controls, interventions, intents, attempts, runtimes }),
    deliveryReceipt(staged: ReturnType<typeof requireStaged>) {
      const intent = required(intents.get(staged.providerEffectIntentId));
      return Object.freeze({
        kind: "delivery_receipt" as const,
        providerEffectIntentId: intent.providerEffectIntentId,
        taskId: intent.taskId,
        runId: intent.runId,
        logicalSessionId: intent.logicalSessionId,
        sessionExecutionRuntimeId: intent.sessionExecutionRuntimeId,
        sessionExecutionAttemptId: intent.sessionExecutionAttemptId,
        bindingId: intent.bindingId,
        bindingRevision: intent.bindingRevision,
        executionProfileId: intent.executionProfileId,
        profileRevisionId: intent.profileRevisionId,
        bindingHandle: intent.effect.bindingHandle,
        inputSubmissionId: intent.inputSubmissionId,
        orchestrationSessionTurnId: intent.orchestrationSessionTurnId,
        receiptDigest: RECEIPT,
      });
    },
    observeReceipt(attemptId: string, receiptDigest: string, state: SessionExecutionAttemptRecord["state"] = "active") {
      const attempt = required(attempts.get(attemptId));
      attempts.set(attemptId, {
        ...attempt,
        state,
        receiptDigest,
        receiptObservedAt: LATER,
        revision: attempt.revision + 1,
        updatedAt: LATER,
      });
    },
    markAttemptReconciling(attemptId: string) {
      const attempt = required(attempts.get(attemptId));
      attempts.set(attemptId, { ...attempt, state: "reconciling", revision: attempt.revision + 1, updatedAt: LATER });
    },
    seedInterruptIntent(staged: ReturnType<typeof requireStaged>) {
      controls.set(CONTROL_ID, Object.freeze({
        sessionControlAuditId: CONTROL_ID,
        taskId: TASK_ID,
        runId: RUN_ID,
        sessionId: WORKER_SESSION_ID,
        commandId: "command_interrupt-1",
        idempotencyKey: "interrupt:1",
        kind: "conductor_interrupt",
        state: "requested",
        affectedInboxItemIds: Object.freeze([]),
        requestedAt: NOW,
      }));
      const delivery = required(intents.get(staged.providerEffectIntentId));
      const interrupt: SessionRuntimeProviderEffectIntentRecord = Object.freeze({
        ...delivery,
        providerEffectIntentId: "provider_effect_interrupt-1",
        commandId: "command_acp_interrupt-1",
        idempotencyKey: "acp:interrupt:1",
        commandType: "session_runtime.request_interrupt",
        commandFingerprint: hashDefinition({ interrupt: CONTROL_ID }),
        sessionControlAuditId: CONTROL_ID,
        effect: Object.freeze({
          kind: "request_interrupt",
          bindingHandle: binding.bindingHandle,
          sessionExecutionAttemptId: staged.sessionExecutionAttemptId,
          sessionControlAuditId: CONTROL_ID,
        }),
      });
      intents.set(interrupt.providerEffectIntentId, interrupt);
      return interrupt;
    },
    setCancelledSettlement(attemptId: string) {
      const attempt = required(attempts.get(attemptId));
      const settlement: SessionExecutionSettlement = Object.freeze({
        ...settlementScope(attempt),
        outcome: "cancelled",
        receiptDigest: required(attempt.receiptDigest),
        settledAt: LATER,
      });
      attempts.set(attemptId, {
        ...attempt,
        state: "settled",
        terminal: Object.freeze({
          terminalObservationId: "provider_fact_terminal-cancelled",
          outcome: "cancelled",
          receiptDigest: required(attempt.receiptDigest),
          observedAt: LATER,
        }),
        settlement,
        revision: attempt.revision + 1,
        updatedAt: LATER,
      });
      return settlement;
    },
    setFailedSettlement(attemptId: string) {
      const attempt = required(attempts.get(attemptId));
      const settlement: SessionExecutionSettlement = Object.freeze({
        ...settlementScope(attempt),
        outcome: "failed",
        receiptDigest: required(attempt.receiptDigest),
        settledAt: LATER,
      });
      attempts.set(attemptId, {
        ...attempt,
        state: "settled",
        terminal: Object.freeze({
          terminalObservationId: "provider_fact_terminal-failed",
          outcome: "failed",
          receiptDigest: required(attempt.receiptDigest),
          observedAt: LATER,
        }),
        settlement,
        revision: attempt.revision + 1,
        updatedAt: LATER,
      });
      return settlement;
    },
    setCompletedSettlement(attemptId: string) {
      const attempt = required(attempts.get(attemptId));
      const settlement: SessionExecutionSettlement = Object.freeze({
        ...settlementScope(attempt),
        outcome: "completed",
        receiptDigest: RECEIPT,
        finalContent: "Canonical Final",
        finalContentDigest: hashDefinition("Canonical Final"),
        settledAt: LATER,
      });
      attempts.set(attemptId, {
        ...attempt,
        state: "settled",
        receiptDigest: RECEIPT,
        receiptObservedAt: LATER,
        finalCandidate: Object.freeze({
          candidateObservationId: "provider_fact_candidate-1",
          content: "Canonical Final",
          contentDigest: hashDefinition("Canonical Final"),
          observedAt: LATER,
        }),
        terminal: Object.freeze({
          terminalObservationId: "provider_fact_terminal-1",
          outcome: "completed",
          receiptDigest: RECEIPT,
          observedAt: LATER,
        }),
        settlement,
        revision: attempt.revision + 1,
        updatedAt: LATER,
      });
      return settlement;
    },
  };
}

function runtimeRecord(input: SessionIdInputSubmissionRecord, sequence = 1): SessionExecutionRuntimeRecord {
  return Object.freeze({
    sessionExecutionRuntimeId: `session_execution_runtime_${sequence}`,
    taskId: input.taskId,
    runId: input.runId,
    logicalSessionId: input.sessionId,
    state: "executing",
    activeAttemptId: `session_execution_attempt_${sequence}`,
    revision: 2,
    createdAt: NOW,
    updatedAt: NOW,
  });
}

function attemptRecord(
  input: SessionIdInputSubmissionRecord,
  turn: SessionIdSessionTurnRecord,
  binding: AcpSafeSessionBindingRecordV3,
  sequence = 1,
): SessionExecutionAttemptRecord {
  return Object.freeze({
    sessionExecutionAttemptId: `session_execution_attempt_${sequence}`,
    sessionExecutionRuntimeId: `session_execution_runtime_${sequence}`,
    taskId: input.taskId,
    runId: input.runId,
    logicalSessionId: input.sessionId,
    bindingId: binding.bindingId,
    bindingRevision: binding.revision,
    executionProfileId: binding.executionProfileId,
    profileRevisionId: binding.profileRevisionId,
    inputSubmissionId: input.inputSubmissionId,
    orchestrationSessionTurnId: turn.sessionTurnId,
    state: "awaiting_receipt",
    interactions: Object.freeze([]),
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
  });
}

function deliveryIntent(
  input: SessionIdInputSubmissionRecord,
  turn: SessionIdSessionTurnRecord,
  binding: AcpSafeSessionBindingRecordV3,
  sequence = 1,
): SessionRuntimeProviderEffectIntentRecord {
  return Object.freeze({
    providerEffectIntentId: `provider_effect_${sequence}`,
    commandId: `command_acp_delivery-${sequence}`,
    idempotencyKey: `acp:delivery:${sequence}`,
    commandType: "session_runtime.submit_delivery",
    commandFingerprint: hashDefinition({ delivery: input.inputSubmissionId }),
    taskId: input.taskId,
    runId: input.runId,
    logicalSessionId: input.sessionId,
    sessionExecutionRuntimeId: `session_execution_runtime_${sequence}`,
    sessionExecutionAttemptId: `session_execution_attempt_${sequence}`,
    inputSubmissionId: input.inputSubmissionId,
    orchestrationSessionTurnId: turn.sessionTurnId,
    bindingId: binding.bindingId,
    bindingRevision: binding.revision,
    executionProfileId: binding.executionProfileId,
    profileRevisionId: binding.profileRevisionId,
    effect: Object.freeze({
      kind: "submit_delivery",
      bindingHandle: binding.bindingHandle,
      sessionExecutionAttemptId: `session_execution_attempt_${sequence}`,
      content: CONTENT,
    }),
    state: "pending",
    createdAt: NOW,
  });
}

function settlementScope(attempt: SessionExecutionAttemptRecord) {
  return Object.freeze({
    sessionExecutionRuntimeId: attempt.sessionExecutionRuntimeId,
    sessionExecutionAttemptId: attempt.sessionExecutionAttemptId,
    taskId: attempt.taskId,
    runId: attempt.runId,
    logicalSessionId: attempt.logicalSessionId,
    bindingId: attempt.bindingId,
    bindingRevision: attempt.bindingRevision,
    executionProfileId: attempt.executionProfileId,
    profileRevisionId: attempt.profileRevisionId,
    inputSubmissionId: attempt.inputSubmissionId,
    orchestrationSessionTurnId: attempt.orchestrationSessionTurnId,
  });
}

function insert<T>(map: Map<string, T>, key: string, value: T): void {
  if (map.has(key)) throw new Error("duplicate_identity");
  map.set(key, value);
}

function updateState<T extends Readonly<{ state: string }>>(
  map: Map<string, T>,
  key: string,
  value: T,
  expectedState: T["state"],
): void {
  if (map.get(key)?.state !== expectedState) throw new Error("state_conflict");
  map.set(key, value);
}

function snapshotMaps<T extends Record<string, Map<string, unknown>>>(maps: T) {
  return Object.fromEntries(Object.entries(maps).map(([key, map]) => [key, [...map.entries()]])) as unknown as {
    [K in keyof T]: readonly (readonly [string, unknown])[];
  };
}

function restoreMaps(
  snapshot: Record<string, readonly (readonly [string, unknown])[]>,
  maps: Record<string, Map<string, unknown>>,
): void {
  for (const [key, entries] of Object.entries(snapshot)) {
    maps[key]!.clear();
    for (const [identity, value] of entries) maps[key]!.set(identity, value);
  }
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("test_fixture_value_missing");
  return value;
}

function requireStaged<T extends Readonly<{ disposition: string }>>(
  value: T,
): Extract<T, Readonly<{ disposition: "staged" | "replay" }>> {
  if (value.disposition !== "staged" && value.disposition !== "replay") {
    throw new Error("expected staged delivery");
  }
  return value as Extract<T, Readonly<{ disposition: "staged" | "replay" }>>;
}

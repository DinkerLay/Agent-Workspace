import {
  hashDefinition,
  type InputSubmissionRecord,
  type ProviderEffect,
  type ProviderFact,
} from "../../runtime-contracts/src";
import { invariant } from "./errors";

export interface StageInputSubmissionInput {
  readonly inputSubmissionId: string;
  readonly sourceInboxItemId: string;
  readonly taskId: string;
  readonly runId: string;
  readonly logicalSessionId: string;
  readonly bindingId: string;
  readonly contentMessageId: string;
  readonly content: string;
  readonly sequenceNumber: number;
  readonly idempotencyKey: string;
  readonly now: string;
  readonly supersedesInputSubmissionId?: string;
}

export function stageInputSubmission(
  input: StageInputSubmissionInput,
  existingForBinding: readonly InputSubmissionRecord[] = [],
): InputSubmissionRecord {
  invariant(input.inputSubmissionId.startsWith("input_"), "input_submission_id_invalid");
  invariant(input.sourceInboxItemId.startsWith("inbox_"), "input_source_inbox_id_invalid");
  invariant(input.taskId.startsWith("task_"), "input_task_id_invalid");
  invariant(input.runId.startsWith("run_"), "input_run_id_invalid");
  invariant(input.logicalSessionId.startsWith("logical_session_"), "input_logical_session_id_invalid");
  invariant(input.bindingId.startsWith("binding_"), "input_binding_id_invalid");
  invariant(input.contentMessageId.startsWith("message_"), "input_content_message_id_invalid");
  invariant(Boolean(input.content.trim()), "input_content_required");
  invariant(Boolean(input.idempotencyKey.trim()), "input_idempotency_key_required");
  invariant(Number.isSafeInteger(input.sequenceNumber) && input.sequenceNumber > 0, "input_sequence_invalid");
  invariant(
    !existingForBinding.some((entry) => entry.idempotencyKey === input.idempotencyKey),
    "input_idempotency_key_duplicate",
  );
  invariant(
    !existingForBinding.some((entry) => entry.sequenceNumber === input.sequenceNumber),
    "input_sequence_duplicate",
  );
  const occupied = existingForBinding.find((entry) => ["staged", "effect_accepted", "provider_received", "turn_active", "ambiguous"].includes(entry.status));
  invariant(!occupied, "binding_delivery_occupied", "a binding has one managed delivery or active turn until a terminal ProviderFact resolves it");
  return {
    inputSubmissionId: input.inputSubmissionId,
    sourceInboxItemId: input.sourceInboxItemId,
    taskId: input.taskId,
    runId: input.runId,
    logicalSessionId: input.logicalSessionId,
    bindingId: input.bindingId,
    contentMessageId: input.contentMessageId,
    deliveryRole: "user",
    content: input.content,
    contentDigest: hashDefinition(input.content),
    sequenceNumber: input.sequenceNumber,
    idempotencyKey: input.idempotencyKey,
    status: "staged",
    ...(input.supersedesInputSubmissionId ? { supersedesInputSubmissionId: input.supersedesInputSubmissionId } : {}),
    createdAt: input.now,
    updatedAt: input.now,
  };
}

/** A ProviderEffect never makes an input provider_received. */
export function recordDeliveryEffect(
  submission: InputSubmissionRecord,
  effect: ProviderEffect,
  now: string,
): InputSubmissionRecord {
  invariant(effect.kind === "submit_delivery", "input_effect_kind_invalid");
  invariant(effect.bindingId === submission.bindingId, "input_effect_binding_mismatch");
  invariant(effect.inputSubmissionId === submission.inputSubmissionId, "input_effect_submission_mismatch");
  invariant(submission.status === "staged" || submission.status === "effect_accepted", "input_effect_state_invalid");
  if (effect.acceptance === "rejected") return { ...submission, status: "provider_rejected", providerEffectId: effect.effectId, updatedAt: now };
  if (effect.acceptance === "unknown") {
    return { ...submission, status: "ambiguous", providerEffectId: effect.effectId, updatedAt: now };
  }
  return { ...submission, status: "effect_accepted", providerEffectId: effect.effectId, updatedAt: now };
}

export function applyProviderFactToInput(
  submission: InputSubmissionRecord,
  fact: ProviderFact,
  now: string,
): InputSubmissionRecord {
  if (fact.correlation.inputSubmissionId !== submission.inputSubmissionId || fact.bindingId !== submission.bindingId) {
    return submission;
  }
  if (fact.kind === "input_received") {
    assertReceiptEvidence(fact);
    return {
      ...submission,
      status: "provider_received",
      ...(fact.correlation.nativeMessageId ? { nativeMessageId: fact.correlation.nativeMessageId } : {}),
      ...(fact.correlation.nativeTurnId ? { nativeTurnId: fact.correlation.nativeTurnId } : {}),
      ...(fact.evidenceReferenceId ? { evidenceReferenceId: fact.evidenceReferenceId } : {}),
      updatedAt: now,
    };
  }
  if (fact.kind === "turn_started") return { ...submission, status: "turn_active", updatedAt: now };
  if (fact.kind === "turn_completed") return { ...submission, status: "completed", updatedAt: now };
  if (fact.kind === "turn_failed") return { ...submission, status: "failed", updatedAt: now };
  if (fact.kind === "interrupt_confirmed") return { ...submission, status: "cancelled", updatedAt: now };
  if (fact.kind === "input_rejected") return { ...submission, status: "provider_rejected", updatedAt: now };
  if (fact.kind === "transport_unknown") return { ...submission, status: "ambiguous", updatedAt: now };
  return submission;
}

/** Ambiguous delivery is not retried; a deliberate replacement gets a new input ID/key. */
export function supersedeAmbiguousInput(
  original: InputSubmissionRecord,
  replacement: StageInputSubmissionInput,
  existingForBinding: readonly InputSubmissionRecord[],
): { original: InputSubmissionRecord; replacement: InputSubmissionRecord } {
  invariant(original.status === "ambiguous", "input_not_ambiguous");
  invariant(replacement.supersedesInputSubmissionId === original.inputSubmissionId, "input_supersession_link_required");
  const replacementRecord = stageInputSubmission(replacement, existingForBinding.filter((entry) => entry.inputSubmissionId !== original.inputSubmissionId));
  return {
    original: { ...original, status: "superseded", updatedAt: replacement.now },
    replacement: replacementRecord,
  };
}

function assertReceiptEvidence(fact: ProviderFact): void {
  invariant(
    Boolean(fact.correlation.nativeMessageId || fact.correlation.nativeTurnId || fact.evidenceReferenceId),
    "provider_receipt_evidence_required",
    "input_received requires a native ID or durable provider-history evidence",
  );
}

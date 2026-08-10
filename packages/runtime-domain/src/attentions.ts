import type { AttentionRecord, ProviderEffect, ProviderFact } from "../../runtime-contracts/src";
import { invariant } from "./errors";

export function createAttentionFromProviderFact(input: {
  readonly attentionId: string;
  readonly taskId: string;
  readonly runId: string;
  readonly fact: ProviderFact;
  readonly now: string;
}): AttentionRecord {
  invariant(input.attentionId.startsWith("attention_"), "attention_id_invalid");
  invariant(input.fact.kind === "attention_requested", "attention_fact_kind_invalid");
  const nativeRequestId = input.fact.correlation.nativeRequestId;
  invariant(Boolean(nativeRequestId), "attention_native_request_id_required");
  return {
    attentionId: input.attentionId,
    taskId: input.taskId,
    runId: input.runId,
    bindingId: input.fact.bindingId,
    bindingRevision: input.fact.bindingRevision,
    nativeRequestId: nativeRequestId as string,
    ...(input.fact.correlation.inputSubmissionId ? { activeInputSubmissionId: input.fact.correlation.inputSubmissionId } : {}),
    ...(input.fact.correlation.invocationId ? { activeInvocationId: input.fact.correlation.invocationId } : {}),
    request: input.fact.payload,
    status: "requested",
    createdAt: input.now,
    updatedAt: input.now,
  };
}

export function stageAttentionResponse(
  attention: AttentionRecord,
  request: {
    readonly attentionId: string;
    readonly bindingId: string;
    readonly bindingRevision: number;
    readonly nativeRequestId: string;
    readonly activeInputSubmissionId?: string;
    readonly activeInvocationId?: string;
    readonly response: AttentionRecord["request"];
  },
  now: string,
): AttentionRecord {
  invariant(attention.status === "requested", "attention_not_respondable");
  invariant(request.attentionId === attention.attentionId, "stale_attention_id");
  invariant(request.bindingId === attention.bindingId, "stale_attention_binding");
  invariant(request.bindingRevision === attention.bindingRevision, "stale_attention_binding_revision");
  invariant(request.nativeRequestId === attention.nativeRequestId, "stale_attention_native_request");
  invariant(request.activeInputSubmissionId === attention.activeInputSubmissionId, "stale_attention_input");
  invariant(request.activeInvocationId === attention.activeInvocationId, "stale_attention_invocation");
  return { ...attention, response: request.response, status: "response_staged", updatedAt: now };
}

/** Accepted attention reply still waits for a durable attention_resolved fact. */
export function recordAttentionResponseEffect(attention: AttentionRecord, effect: ProviderEffect, now: string): AttentionRecord {
  invariant(effect.kind === "respond_attention", "attention_effect_kind_invalid");
  invariant(effect.bindingId === attention.bindingId, "attention_effect_binding_mismatch");
  invariant(effect.attentionId === attention.attentionId, "attention_effect_id_mismatch");
  invariant(attention.status === "response_staged" || attention.status === "effect_accepted", "attention_effect_state_invalid");
  if (effect.acceptance === "accepted") return { ...attention, status: "effect_accepted", updatedAt: now };
  return attention;
}

export function applyProviderFactToAttention(attention: AttentionRecord, fact: ProviderFact, now: string): AttentionRecord {
  if (fact.kind !== "attention_resolved") return attention;
  if (fact.bindingId !== attention.bindingId || fact.bindingRevision !== attention.bindingRevision) return attention;
  if (fact.correlation.attentionId !== attention.attentionId || fact.correlation.nativeRequestId !== attention.nativeRequestId) return attention;
  return { ...attention, status: "resolved", updatedAt: now };
}

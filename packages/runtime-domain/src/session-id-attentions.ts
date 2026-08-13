import type {
  JsonObject,
  ProviderEffect,
  ProviderFact,
  SessionIdAttentionRecord,
} from "@agent-workspace/runtime-contracts";
import { invariant } from "./errors.js";

export function createSessionIdAttention(input: Readonly<{
  attentionId: string;
  taskId: string;
  runId: string;
  sessionId: string;
  bindingId: string;
  bindingRevision: number;
  sessionTurnId: string;
  inputSubmissionId: string;
  nativeRequestId: string;
  sourceProviderFactId: string;
  request: JsonObject;
  now: string;
}>): SessionIdAttentionRecord {
  invariant(Boolean(input.attentionId.trim()), "session_id_attention_id_required");
  invariant(input.bindingRevision > 0, "session_id_attention_binding_revision_invalid");
  invariant(Boolean(input.sessionTurnId.trim()), "session_id_attention_turn_required");
  invariant(Boolean(input.inputSubmissionId.trim()), "session_id_attention_input_required");
  invariant(Boolean(input.nativeRequestId.trim()), "session_id_attention_native_request_required");
  const { now, ...identity } = input;
  return Object.freeze({
    ...identity,
    status: "requested",
    revision: 1,
    createdAt: now,
    updatedAt: now,
  });
}

export function stageSessionIdAttentionResponse(
  attention: SessionIdAttentionRecord,
  input: Readonly<{
    commandId: string;
    humanInterventionId: string;
    conductorMirrorMessageId: string;
    responseOutboxId: string;
    response: JsonObject;
    now: string;
  }>,
): SessionIdAttentionRecord {
  invariant(attention.status === "requested", "session_id_attention_not_respondable");
  invariant(Boolean(input.commandId.trim()), "session_id_attention_command_id_required");
  return Object.freeze({
    ...attention,
    response: input.response,
    responseCommandId: input.commandId,
    humanInterventionId: input.humanInterventionId,
    conductorMirrorMessageId: input.conductorMirrorMessageId,
    responseOutboxId: input.responseOutboxId,
    status: "response_staged",
    revision: attention.revision + 1,
    updatedAt: input.now,
  });
}

/** A transport acceptance is deliberately not an Attention resolution. */
export function recordSessionIdAttentionEffect(
  attention: SessionIdAttentionRecord,
  effect: ProviderEffect,
  now: string,
): SessionIdAttentionRecord {
  invariant(effect.kind === "respond_attention", "session_id_attention_effect_kind_invalid");
  invariant(effect.bindingId === attention.bindingId, "session_id_attention_effect_binding_mismatch");
  invariant(effect.attentionId === attention.attentionId, "session_id_attention_effect_id_mismatch");
  invariant(
    attention.status === "response_staged" || attention.status === "effect_accepted",
    "session_id_attention_effect_state_invalid",
  );
  if (effect.acceptance !== "accepted" || attention.status === "effect_accepted") return attention;
  return Object.freeze({
    ...attention,
    status: "effect_accepted",
    revision: attention.revision + 1,
    updatedAt: now,
  });
}

export function applySessionIdAttentionProviderFact(
  attention: SessionIdAttentionRecord,
  fact: ProviderFact,
  now: string,
): SessionIdAttentionRecord {
  if (attention.status === "resolved" || attention.status === "stale") return attention;
  const outcome = attentionOutcome(fact);
  if (!outcome || attention.status === outcome) return attention;
  return Object.freeze({
    ...attention,
    status: outcome,
    revision: attention.revision + 1,
    reason: outcome === "unknown" ? "provider_outcome_unknown" : outcome === "stale" ? "provider_attention_stale" : undefined,
    updatedAt: now,
    ...(outcome === "resolved" || outcome === "stale" ? { settledAt: now } : {}),
  });
}

export function reconcileSessionIdAttentionBinding(
  attention: SessionIdAttentionRecord,
  binding: Readonly<{ bindingId: string; revision: number; status: string }> | undefined,
  now: string,
): SessionIdAttentionRecord {
  if (attention.status === "resolved" || attention.status === "stale") return attention;
  if (!binding || binding.bindingId !== attention.bindingId || binding.revision > attention.bindingRevision) {
    return settle(attention, "stale", "binding_revision_superseded", now);
  }
  if (binding.revision !== attention.bindingRevision) return attention;
  if (binding.status === "recovering" || binding.status === "unrecoverable") {
    return settle(attention, "unknown", "binding_requires_reconcile", now);
  }
  return attention;
}

export function stopSessionIdAttention(
  attention: SessionIdAttentionRecord,
  now: string,
): SessionIdAttentionRecord {
  if (attention.status === "resolved" || attention.status === "stale") return attention;
  return settle(attention, "unknown", "task_stopped_before_attention_resolution", now);
}

function attentionOutcome(fact: ProviderFact): "resolved" | "stale" | "unknown" | undefined {
  if (fact.kind === "transport_unknown" || fact.kind === "provider_unavailable") return "unknown";
  if (fact.kind !== "attention_resolved") return undefined;
  const payloadOutcome = fact.payload.outcome ?? fact.payload.status;
  if (payloadOutcome === "stale" || payloadOutcome === "unknown" || payloadOutcome === "resolved") return payloadOutcome;
  return "resolved";
}

function settle(
  attention: SessionIdAttentionRecord,
  status: "stale" | "unknown",
  reason: string,
  now: string,
): SessionIdAttentionRecord {
  if (attention.status === status && attention.reason === reason) return attention;
  return Object.freeze({
    ...attention,
    status,
    revision: attention.revision + 1,
    reason,
    updatedAt: now,
    ...(status === "stale" ? { settledAt: now } : {}),
  });
}

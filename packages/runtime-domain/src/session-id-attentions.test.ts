import type { ProviderEffect, ProviderFact } from "@agent-workspace/runtime-contracts";
import { describe, expect, it } from "vitest";
import {
  applySessionIdAttentionProviderFact,
  createSessionIdAttention,
  recordSessionIdAttentionEffect,
  reconcileSessionIdAttentionBinding,
  stageSessionIdAttentionResponse,
} from "./session-id-attentions.js";

const NOW = "2026-08-11T00:00:00.000Z";

describe("Session-ID Attention state machine", () => {
  it("keeps the original Turn provenance and separates effect acceptance from resolution", () => {
    const requested = attention();
    const staged = stageSessionIdAttentionResponse(requested, {
      commandId: "command_attention",
      humanInterventionId: "human_intervention_attention",
      conductorMirrorMessageId: "message_attention_mirror",
      responseOutboxId: "provider_effect_attention",
      response: { content: "Allow once" },
      now: NOW,
    });
    const accepted = recordSessionIdAttentionEffect(staged, effect("accepted"), NOW);

    expect(accepted).toMatchObject({
      status: "effect_accepted",
      sessionTurnId: "session_turn_worker",
      inputSubmissionId: "input_worker",
      revision: 3,
    });
    expect(accepted).not.toHaveProperty("settledAt");
    const resolved = applySessionIdAttentionProviderFact(accepted, fact("attention_resolved"), NOW);
    expect(resolved).toMatchObject({
      status: "resolved",
      sessionTurnId: "session_turn_worker",
      inputSubmissionId: "input_worker",
      revision: 4,
      settledAt: NOW,
    });
  });

  it("projects only Provider/reconcile evidence to stale or unknown", () => {
    const requested = attention();
    expect(applySessionIdAttentionProviderFact(requested, fact("transport_unknown"), NOW)).toMatchObject({
      status: "unknown",
      reason: "provider_outcome_unknown",
    });
    expect(applySessionIdAttentionProviderFact(requested, fact("attention_resolved", { outcome: "stale" }), NOW)).toMatchObject({
      status: "stale",
      reason: "provider_attention_stale",
    });
    expect(reconcileSessionIdAttentionBinding(requested, {
      bindingId: "binding_worker",
      revision: 2,
      status: "active",
    }, NOW)).toMatchObject({ status: "stale", reason: "binding_revision_superseded" });
    expect(reconcileSessionIdAttentionBinding(requested, {
      bindingId: "binding_worker",
      revision: 1,
      status: "recovering",
    }, NOW)).toMatchObject({ status: "unknown", reason: "binding_requires_reconcile" });
  });

  it("rejects a second response CAS", () => {
    const staged = stageSessionIdAttentionResponse(attention(), {
      commandId: "command_attention",
      humanInterventionId: "human_intervention_attention",
      conductorMirrorMessageId: "message_attention_mirror",
      responseOutboxId: "provider_effect_attention",
      response: { content: "Allow once" },
      now: NOW,
    });
    expect(() => stageSessionIdAttentionResponse(staged, {
      commandId: "command_other",
      humanInterventionId: "human_intervention_other",
      conductorMirrorMessageId: "message_other",
      responseOutboxId: "provider_effect_other",
      response: { content: "Conflicting reply" },
      now: NOW,
    })).toThrow("session_id_attention_not_respondable");
  });
});

function attention() {
  return createSessionIdAttention({
    attentionId: "attention_worker",
    taskId: "task_attention",
    runId: "run_attention",
    sessionId: "logical_session_worker",
    bindingId: "binding_worker",
    bindingRevision: 1,
    sessionTurnId: "session_turn_worker",
    inputSubmissionId: "input_worker",
    nativeRequestId: "native_request_worker",
    sourceProviderFactId: "provider_fact_attention_requested",
    request: { title: "Permission required" },
    now: NOW,
  });
}

function effect(acceptance: ProviderEffect["acceptance"]): ProviderEffect {
  return {
    effectId: "effect_attention",
    kind: "respond_attention",
    provider: "codex",
    bindingId: "binding_worker",
    attentionId: "attention_worker",
    acceptance,
    acceptedAt: NOW,
  };
}

function fact(kind: ProviderFact["kind"], payload: ProviderFact["payload"] = {}): ProviderFact {
  return {
    providerFactId: `provider_fact_${kind}`,
    provider: "codex",
    bindingId: "binding_worker",
    bindingRevision: 1,
    kind,
    deduplication: { providerEventId: `event-${kind}` },
    correlation: {
      attentionId: "attention_worker",
      nativeRequestId: "native_request_worker",
      inputSubmissionId: "input_worker",
      sessionTurnId: "session_turn_worker",
    },
    payload,
    observedAt: NOW,
  };
}

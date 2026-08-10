/**
 * Codex Provider Adapter.
 *
 * The Runtime Host injects an App Server / process transport only after a
 * concrete protocol spike pins its observed version and schema fingerprint.
 * This package intentionally does not claim that any fixture event name is a
 * live Codex App Server protocol method.
 */
import {
  REQUIRED_PROVIDER_CAPABILITIES,
  createProtocolGatedProviderAdapter,
  createScriptedProviderTransport,
} from "../../provider-port/src/index.mjs";

export const CODEX_PROVIDER_ID = "codex";

export const CODEX_CAPABILITIES = REQUIRED_PROVIDER_CAPABILITIES;

export const CODEX_FIXTURE_PROTOCOL = Object.freeze({
  providerVersion: "fixture-1",
  protocolFingerprint: "sha256:codex-fixture-schema-v1",
});

export function createCodexProviderAdapter({ transport, protocol, capabilities = CODEX_CAPABILITIES, now } = {}) {
  return createProtocolGatedProviderAdapter({
    provider: CODEX_PROVIDER_ID,
    declaredProtocol: protocol,
    capabilities,
    transport,
    mapNativeFact: mapCodexNativeFact,
    now,
  });
}

/** Offline fixture seam; it has no network, SDK, or credential side effect. */
export function createCodexFixtureTransport(options = {}) {
  return createScriptedProviderTransport({
    protocol: options.protocol ?? CODEX_FIXTURE_PROTOCOL,
    effects: options.effects,
    streams: options.streams,
    reconciliations: options.reconciliations,
  });
}

export function createCodexFixtureProfile(overrides = {}) {
  return Object.freeze({
    executionProfileId: "profile_codex_fixture",
    provider: CODEX_PROVIDER_ID,
    model: "fixture-model",
    providerVersion: overrides.providerVersion ?? CODEX_FIXTURE_PROTOCOL.providerVersion,
    protocolFingerprint: overrides.protocolFingerprint ?? CODEX_FIXTURE_PROTOCOL.protocolFingerprint,
    capabilityPolicy: {
      requiredCapabilities: [...(overrides.capabilityPolicy?.requiredCapabilities ?? REQUIRED_PROVIDER_CAPABILITIES)],
      allowedTools: [],
      permissionMode: "ask",
      maxConcurrentTurns: 1,
      maxNativeChildren: 1,
      ...(overrides.capabilityPolicy ?? {}),
    },
    ...withoutProfileFields(overrides),
  });
}

/**
 * A Codex protocol mapper is expected to feed this neutral shape. In
 * particular, a local RPC response is not converted into input_received here;
 * only a native message/turn id or evidence-backed history marker can do that
 * in provider-port.
 */
export function mapCodexNativeFact(nativeFact, { bindingId } = {}) {
  const raw = nativeFact ?? {};
  const nativeType = raw.type ?? raw.method ?? raw.notification?.method ?? raw.kind;
  const kind = CODEX_FACT_KIND[nativeType] ?? raw.factKind ?? raw.kind;
  return {
    kind,
    providerEventId: raw.providerEventId ?? raw.eventId ?? raw.notification?.id,
    sourceInstanceId: raw.sourceInstanceId ?? raw.serverInstanceId,
    cursor: raw.cursor ?? raw.sequence,
    reconciliationWatermark: raw.reconciliationWatermark ?? raw.watermark,
    occurredAt: raw.occurredAt ?? raw.timestamp,
    nativeMessageId: raw.nativeMessageId ?? raw.messageId ?? raw.message?.id,
    nativeTurnId: raw.nativeTurnId ?? raw.turnId ?? raw.turn?.id,
    historyMarker: raw.historyMarker,
    evidenceReference: raw.evidenceReference,
    evidence: raw.evidence,
    payload: raw.payload ?? raw.params ?? raw.data,
    bindingRevision: raw.bindingRevision,
    inputSubmissionId: raw.inputSubmissionId ?? raw.attention?.inputSubmissionId,
    invocationId: raw.invocationId ?? raw.attention?.invocationId,
    attentionId: raw.attentionId ?? raw.attention?.attentionId,
    nativeRequestId: raw.nativeRequestId ?? raw.attention?.nativeRequestId,
  };
}

const CODEX_FACT_KIND = Object.freeze({
  "codex.binding.created": "binding_observed",
  "codex.binding.resumed": "binding_observed",
  "codex.delivery.receipt": "input_received",
  "codex.delivery.rejected": "input_rejected",
  "codex.delivery.unknown": "transport_unknown",
  "codex.attention.requested": "attention_requested",
  "codex.attention.resolved": "attention_resolved",
  "codex.interrupt.confirmed": "interrupt_confirmed",
  "codex.turn.started": "turn_started",
  "codex.turn.completed": "turn_completed",
  "codex.turn.failed": "turn_failed",
  "codex.interrupt.unknown": "transport_unknown",
  "codex.child.started": "native_child_observed",
  "codex.child.completed": "native_child_observed",
});

function withoutProfileFields(overrides) {
  const { providerVersion, protocolFingerprint, capabilityPolicy, ...rest } = overrides;
  return rest;
}

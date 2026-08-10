/**
 * Claude Code Provider Adapter.
 *
 * The host may wire an official SDK or official CLI protocol transport here
 * only after it has recorded a concrete version/schema spike. This package does
 * not read transcripts as facts and does not launch a CLI itself.
 */
import {
  createProtocolGatedProviderAdapter,
  createScriptedProviderTransport,
} from "../../provider-port/src/index.mjs";
import {
  CLAUDE_CODE_CLI_REQUIRED_NATIVE_CAPABILITIES,
  CLAUDE_CODE_CLI_STREAM_PROTOCOL_FINGERPRINT,
  CLAUDE_CODE_PROVEN_CAPABILITIES,
  cliInitSupportsRequiredCapabilities,
  createClaudeCodeCommandUuid,
  mapClaudeCodeCliFrame,
  readClaudeCodeCliInit,
} from "./cli-stream.mjs";

export const CLAUDE_CODE_PROVIDER_ID = "claude-code";

export const CLAUDE_CODE_CAPABILITIES = CLAUDE_CODE_PROVEN_CAPABILITIES;
export {
  CLAUDE_CODE_CLI_REQUIRED_NATIVE_CAPABILITIES,
  CLAUDE_CODE_CLI_STREAM_PROTOCOL_FINGERPRINT,
  CLAUDE_CODE_PROVEN_CAPABILITIES,
  cliInitSupportsRequiredCapabilities,
  createClaudeCodeCommandUuid,
  mapClaudeCodeCliFrame,
  readClaudeCodeCliInit,
};

export const CLAUDE_CODE_FIXTURE_PROTOCOL = Object.freeze({
  providerVersion: "fixture-1",
  protocolFingerprint: "sha256:claude-code-fixture-schema-v1",
});

export function createClaudeCodeProviderAdapter({ transport, protocol, capabilities = CLAUDE_CODE_CAPABILITIES, now } = {}) {
  return createProtocolGatedProviderAdapter({
    provider: CLAUDE_CODE_PROVIDER_ID,
    declaredProtocol: protocol,
    capabilities: restrictToProvenCapabilities(capabilities),
    transport,
    mapNativeFact: mapClaudeCodeNativeFact,
    now,
  });
}

/** Offline fixture seam; no real SDK/CLI process is started. */
export function createClaudeCodeFixtureTransport(options = {}) {
  return createScriptedProviderTransport({
    protocol: options.protocol ?? CLAUDE_CODE_FIXTURE_PROTOCOL,
    effects: options.effects,
    streams: options.streams,
    reconciliations: options.reconciliations,
  });
}

export function createClaudeCodeFixtureProfile(overrides = {}) {
  return Object.freeze({
    executionProfileId: "profile_claude_code_fixture",
    provider: CLAUDE_CODE_PROVIDER_ID,
    model: "fixture-model",
    providerVersion: overrides.providerVersion ?? CLAUDE_CODE_FIXTURE_PROTOCOL.providerVersion,
    protocolFingerprint: overrides.protocolFingerprint ?? CLAUDE_CODE_FIXTURE_PROTOCOL.protocolFingerprint,
    capabilityPolicy: {
      requiredCapabilities: [...(overrides.capabilityPolicy?.requiredCapabilities ?? CLAUDE_CODE_CAPABILITIES)],
      allowedTools: [],
      permissionMode: "ask",
      maxConcurrentTurns: 1,
      // The real stream bridge does not yet expose native child execution.
      maxNativeChildren: 0,
      ...(overrides.capabilityPolicy ?? {}),
    },
    ...withoutProfileFields(overrides),
  });
}

/**
 * The aliases below are adapter-local fixture/protocol-mapper names. They do
 * not assert an unverified Claude Code SDK or CLI wire protocol. Receipt proof
 * is intentionally delegated to provider-port's native-id/evidence gate.
 */
export function mapClaudeCodeNativeFact(nativeFact, { bindingId } = {}) {
  const raw = nativeFact ?? {};
  const nativeType = raw.type ?? raw.event?.type ?? raw.kind;
  const kind = CLAUDE_CODE_FACT_KIND[nativeType] ?? raw.factKind ?? raw.kind;
  return {
    kind,
    providerEventId: raw.providerEventId ?? raw.eventId ?? raw.event?.id,
    sourceInstanceId: raw.sourceInstanceId ?? raw.hostInstanceId,
    cursor: raw.cursor ?? raw.sequence,
    reconciliationWatermark: raw.reconciliationWatermark ?? raw.watermark,
    occurredAt: raw.occurredAt ?? raw.timestamp,
    nativeMessageId: raw.nativeMessageId ?? raw.messageId ?? raw.message?.id,
    nativeTurnId: raw.nativeTurnId ?? raw.turnId ?? raw.turn?.id,
    historyMarker: raw.historyMarker,
    evidenceReference: raw.evidenceReference,
    evidence: raw.evidence,
    payload: raw.payload ?? raw.data,
    bindingRevision: raw.bindingRevision,
    inputSubmissionId: raw.inputSubmissionId ?? raw.attention?.inputSubmissionId,
    invocationId: raw.invocationId ?? raw.attention?.invocationId,
    attentionId: raw.attentionId ?? raw.attention?.attentionId,
    nativeRequestId: raw.nativeRequestId ?? raw.attention?.nativeRequestId,
  };
}

const CLAUDE_CODE_FACT_KIND = Object.freeze({
  "claude-code.binding.created": "binding_observed",
  "claude-code.binding.resumed": "binding_observed",
  "claude-code.binding.unavailable": "binding_unavailable",
  "claude-code.delivery.receipt": "input_received",
  "claude-code.delivery.rejected": "input_rejected",
  "claude-code.delivery.unknown": "transport_unknown",
  "claude-code.attention.requested": "attention_requested",
  "claude-code.attention.resolved": "attention_resolved",
  "claude-code.interrupt.confirmed": "interrupt_confirmed",
  "claude-code.turn.started": "turn_started",
  "claude-code.assistant.final": "assistant_final",
  "claude-code.turn.completed": "turn_completed",
  "claude-code.turn.failed": "turn_failed",
  "claude-code.interrupt.unknown": "transport_unknown",
  "claude-code.native.terminal": "native_terminal",
  "claude-code.child.started": "native_child_observed",
  "claude-code.child.completed": "native_child_observed",
});

function withoutProfileFields(overrides) {
  const { providerVersion, protocolFingerprint, capabilityPolicy, ...rest } = overrides;
  return rest;
}

function restrictToProvenCapabilities(capabilities) {
  const requested = Array.isArray(capabilities) ? capabilities : [];
  return Object.freeze([...new Set(requested.filter((capability) => CLAUDE_CODE_PROVEN_CAPABILITIES.includes(capability)))]);
}

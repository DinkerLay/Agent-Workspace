/**
 * ProviderPort is the Runtime Host's provider boundary.
 *
 * A ProviderEffect is only local transport acceptance. A ProviderFact is the
 * only native observation that may advance Binding/Input/Turn/Attention
 * state. This package has no Task, Run, Store, credential, or UI dependency.
 * Adapter selection happens outside the port through a frozen ExecutionProfile.
 */
import { createHash } from "node:crypto";

export const PROVIDER_PORT_VERSION = 1;

/**
 * The finite operation vocabulary a Host transport can explicitly expose.
 * A Provider adapter never infers support from the presence of `request()`:
 * production composition must declare the operations its configured endpoint
 * or process bridge actually accepts.
 */
export const PROVIDER_TRANSPORT_OPERATIONS = Object.freeze([
  "inspect_protocol",
  "ensure_host",
  "ensure_binding",
  "submit_delivery",
  "observe_binding",
  "reconcile_binding",
  "request_interrupt",
  "respond_attention",
  "open_presentation",
  "release_binding",
]);

const PROVIDER_TRANSPORT_OPERATION_SET = new Set(PROVIDER_TRANSPORT_OPERATIONS);

/** Names match runtime-contracts ProviderCapability exactly. */
export const REQUIRED_PROVIDER_CAPABILITIES = Object.freeze([
  "create_binding",
  "resume_binding",
  "input_correlation",
  "provider_receipt",
  "reconcile",
  "interrupt",
  "attention_reply",
  "native_child",
  "presentation",
]);

export const PROVIDER_EFFECT_OPERATIONS = Object.freeze([
  "ensure_host",
  "ensure_binding",
  "submit_delivery",
  "request_interrupt",
  "respond_attention",
  "open_presentation",
  "release_binding",
]);

export const PROVIDER_FACT_KINDS = Object.freeze([
  "binding_observed",
  "binding_unavailable",
  "input_received",
  "input_rejected",
  "transport_unknown",
  "turn_started",
  "activity_observed",
  "assistant_final",
  "turn_completed",
  "turn_failed",
  "attention_requested",
  "attention_resolved",
  "interrupt_confirmed",
  "native_terminal",
  "native_child_observed",
  "presentation_available",
  "provider_unavailable",
]);

export class ProviderUnavailableError extends Error {
  constructor(report) {
    super(`Provider ${report?.provider ?? "unknown"} is unavailable: ${(report?.unavailableReasons ?? []).join(", ")}`);
    this.name = "ProviderUnavailableError";
    this.code = "provider_unavailable";
    this.report = report;
  }
}

export class ProviderProtocolError extends Error {
  constructor(message, { provider, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "ProviderProtocolError";
    this.code = "provider_protocol_error";
    this.provider = provider;
  }
}

export class ProviderTransportError extends Error {
  constructor(message, { provider, operation, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "ProviderTransportError";
    this.code = "provider_transport_error";
    this.provider = provider;
    this.operation = operation;
  }
}

export function stableJson(value) {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "bigint") return JSON.stringify(String(value));
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(String(value));
}

export function sha256(value) {
  return `sha256:${createHash("sha256").update(typeof value === "string" ? value : stableJson(value)).digest("hex")}`;
}

/**
 * Renders only the already-compiled Session bootstrap for a native Provider.
 * A Worker never receives sibling prompts; a Conductor receives dispatch card
 * metadata but never Worker system prompts.
 */
export function renderProviderSessionBootstrap(bootstrap) {
  assertSessionBootstrap(bootstrap);
  const role = bootstrap.purpose === "task_conductor"
    ? "Task Conductor"
    : bootstrap.purpose === "task_worker"
      ? "Task Worker"
      : "Template Design Agent";
  const lines = [
    `Agent Workspace role: ${role}.`,
    "Follow the following immutable session instructions:",
    bootstrap.systemPrompt,
  ];
  if (bootstrap.dispatchRegistry?.length) {
    lines.push(
      "Registered worker cards. Use this registry only to decide which card to request through the Runtime; do not invent a card or treat a worker prompt as your own instruction:",
      ...bootstrap.dispatchRegistry.map((card) => `- ${card.agentCardId} | ${card.kind} | ${card.title}: ${card.description}`),
    );
  }
  if (bootstrap.capabilityRefs.length) {
    lines.push(
      `Declared card capabilities: ${bootstrap.capabilityRefs.map((capability) => `${capability.kind}:${capability.id}`).join(", ")}.`,
      "Use only capabilities made available by the selected Provider and its execution policy.",
    );
  }
  lines.push("Task achievement is an explicit user decision. Never claim or infer Achieve.");
  return lines.join("\n\n");
}

/**
 * Runtime-compatible fact deduplication. Store persistence owns the durable
 * dedup set; adapters only give every fact the evidence required to derive it.
 */
export function providerFactDedupKey(fact) {
  const provider = requiredString(fact?.provider, "fact.provider");
  const bindingId = requiredString(fact?.bindingId, "fact.bindingId");
  const base = `${provider}:${bindingId}:`;
  const deduplication = fact?.deduplication ?? {};
  if (stringOrUndefined(deduplication.providerEventId)) return `${base}event:${deduplication.providerEventId}`;
  if (stringOrUndefined(deduplication.sourceInstanceId) && stringOrUndefined(deduplication.cursor)) {
    return `${base}cursor:${deduplication.sourceInstanceId}:${deduplication.cursor}`;
  }
  if (stringOrUndefined(deduplication.reconciliationWatermark)) {
    return `${base}watermark:${deduplication.reconciliationWatermark}:${sha256({
      kind: fact.kind,
      correlation: fact.correlation,
      payload: fact.payload,
      evidenceReferenceId: fact.evidenceReferenceId ?? null,
    })}`;
  }
  throw new ProviderProtocolError("ProviderFact has no durable deduplication evidence.", { provider });
}

/**
 * Creates the concrete ProviderPort implementation. `transport` is injected by
 * Runtime Host composition; an adapter does not spawn a Provider or write any
 * domain record itself.
 */
export function createProtocolGatedProviderAdapter({
  provider,
  startupProtocolObservation,
  capabilities,
  transport,
  mapNativeFact = (raw) => raw,
  now = () => new Date().toISOString(),
}) {
  const normalizedProvider = requiredProvider(provider);
  if (!isRecord(transport) || typeof transport.request !== "function") {
    throw new TypeError(`${normalizedProvider} Provider Adapter requires transport.request().`);
  }
  if (typeof mapNativeFact !== "function") throw new TypeError("Provider Adapter requires mapNativeFact().");
  // A provider factory may describe the capabilities its implementation knows
  // how to map, but it cannot expand what this concrete Host transport declared.
  // This is deliberately fail-closed for custom transports without an explicit
  // operation declaration.
  const supportedOperations = new Set(providerTransportOperations(transport));
  const declaredCapabilities = new Set(normalizeCapabilities(capabilities));
  const transportCapabilities = new Set(deriveProviderCapabilitiesFromTransport(transport));
  const verifiedCapabilities = Array.isArray(transport.verifiedCapabilities)
    ? new Set(normalizeCapabilities(transport.verifiedCapabilities))
    : undefined;
  const availableCapabilities = Object.freeze(
    REQUIRED_PROVIDER_CAPABILITIES.filter((capability) =>
      declaredCapabilities.has(capability)
      && transportCapabilities.has(capability)
      && (!verifiedCapabilities || verifiedCapabilities.has(capability))),
  );
  const attentionScopes = new Map();
  // Production composition supplies the protocol observation made while the
  // Host starts. It is a process-local transport baseline, not a profile equality gate.
  const runtimeProtocolObservation = observedProtocolEvidence(startupProtocolObservation);

  async function describeCapabilities(profile) {
    let observedProtocol;
    try {
      observedProtocol = typeof transport.inspectProtocol === "function" ? await transport.inspectProtocol() : undefined;
    } catch (cause) {
      return unavailableCapabilities({
        provider: normalizedProvider,
        reasons: ["protocol_observation_failed"],
        diagnostic: String(cause?.message ?? cause),
      });
    }
    const report = evaluateProtocolCompatibility({
      provider: normalizedProvider,
      profile,
      observedProtocol,
      capabilities: availableCapabilities,
      runtimeProtocolObservation,
    });
    return report;
  }

  async function ensureAvailable(request) {
    const report = await describeCapabilities(extractProfile(request));
    if (!report.available) throw new ProviderUnavailableError(report);
    return report;
  }

  async function perform(operation, request) {
    await ensureAvailable(request);
    let response;
    try {
      response = await transport.request({ operation, request });
    } catch (cause) {
      throw new ProviderTransportError(`${normalizedProvider} transport failed during ${operation}.`, {
        provider: normalizedProvider,
        operation,
        cause,
      });
    }
    return Object.freeze({
      effect: createProviderEffect({ provider: normalizedProvider, operation, request, response, acceptedAt: now() }),
      response,
    });
  }

  async function ensureHost(request) {
    return (await perform("ensure_host", request)).effect;
  }

  async function ensureBinding(request) {
    assertBindingRequest(request);
    return (await perform("ensure_binding", request)).effect;
  }

  async function submitDelivery(request) {
    assertBindingRequest(request);
    requiredString(request?.inputSubmissionId, "inputSubmissionId");
    requiredString(request?.idempotencyKey, "idempotencyKey");
    return (await perform("submit_delivery", request)).effect;
  }

  async function* observeBinding(request) {
    assertBindingRequest(request);
    await ensureAvailable(request);
    if (!supportedOperations.has("observe_binding") || typeof transport.observe !== "function") return;
    const nativeFacts = await transport.observe({ operation: "observe_binding", request });
    const seenInSource = new Map();
    for await (const nativeFact of asAsyncIterable(nativeFacts)) {
      const fact = normalizeMappedFact({ provider: normalizedProvider, request, nativeFact, mapNativeFact, now });
      const dedupKey = providerFactDedupKey(fact);
      if (recordOrValidateDuplicate(seenInSource, dedupKey, fact)) continue;
      trackAttention(fact, attentionScopes);
      yield fact;
    }
  }

  async function reconcileBinding(request) {
    assertBindingRequest(request);
    await ensureAvailable(request);
    if (!supportedOperations.has("reconcile_binding") || typeof transport.reconcile !== "function") return Object.freeze([]);
    let response;
    try {
      response = await transport.reconcile({ operation: "reconcile_binding", request });
    } catch (cause) {
      throw new ProviderTransportError(`${normalizedProvider} transport failed during reconcile_binding.`, {
        provider: normalizedProvider,
        operation: "reconcile_binding",
        cause,
      });
    }
    const nativeFacts = Array.isArray(response) ? response : response?.facts;
    if (!Array.isArray(nativeFacts)) {
      throw new ProviderProtocolError(`${normalizedProvider} reconcile response must contain facts[].`, { provider: normalizedProvider });
    }
    const seenInBatch = new Map();
    const facts = [];
    for (const nativeFact of nativeFacts) {
      const fact = normalizeMappedFact({ provider: normalizedProvider, request, nativeFact, mapNativeFact, now });
      const dedupKey = providerFactDedupKey(fact);
      if (recordOrValidateDuplicate(seenInBatch, dedupKey, fact)) continue;
      trackAttention(fact, attentionScopes);
      facts.push(fact);
    }
    return Object.freeze(facts);
  }

  async function requestInterrupt(request) {
    assertBindingRequest(request);
    requiredString(request?.idempotencyKey, "idempotencyKey");
    // A transport route is not a verified capability. In particular, retain a
    // native abort implementation for reconciliation regression tests without
    // letting production callers invoke it when `interrupt` is unavailable.
    if (!availableCapabilities.includes("interrupt")) {
      return createProviderEffect({
        provider: normalizedProvider,
        operation: "request_interrupt",
        request,
        response: { acceptance: "rejected", diagnostic: "capability_interrupt_unavailable" },
        acceptedAt: now(),
      });
    }
    // Its accepted effect is not a terminal fact. A later interrupt_confirmed
    // or correlated transport_unknown observation decides the state.
    return (await perform("request_interrupt", request)).effect;
  }

  async function respondAttention(request) {
    assertBindingRequest(request);
    await ensureAvailable(request);
    const scope = normalizeAttentionScope(request);
    const knownScope = attentionScopes.get(scope.attentionId);
    if (knownScope && !sameAttentionScope(knownScope, scope)) {
      return createProviderEffect({
        provider: normalizedProvider,
        operation: "respond_attention",
        request,
        response: { acceptance: "rejected", diagnostic: "stale_attention" },
        acceptedAt: now(),
      });
    }
    return (await perform("respond_attention", request)).effect;
  }

  async function openPresentation(request) {
    assertBindingRequest(request);
    const { response } = await perform("open_presentation", request);
    return normalizePresentation(response?.presentation, request.bindingId);
  }

  async function releaseBinding(request) {
    assertBindingRequest(request);
    await perform("release_binding", request);
  }

  return Object.freeze({
    provider: normalizedProvider,
    describeCapabilities,
    ensureHost,
    ensureBinding,
    submitDelivery,
    observeBinding,
    reconcileBinding,
    requestInterrupt,
    respondAttention,
    openPresentation,
    releaseBinding,
  });
}

function recordOrValidateDuplicate(seen, dedupKey, fact) {
  const fingerprint = sha256({
    provider: fact.provider,
    bindingId: fact.bindingId,
    bindingRevision: fact.bindingRevision,
    kind: fact.kind,
    dedupKey,
    correlation: fact.correlation,
    payload: fact.payload,
    evidenceReferenceId: fact.evidenceReferenceId ?? null,
  });
  const existing = seen.get(dedupKey);
  if (existing === undefined) {
    seen.set(dedupKey, fingerprint);
    return false;
  }
  if (existing !== fingerprint) {
    throw new ProviderProtocolError("provider_fact_dedup_conflict", { provider: fact.provider });
  }
  return true;
}

/**
 * Normalizes only explicitly declared, recognized transport operations. Unknown
 * values and transports without a declaration intentionally yield no support;
 * otherwise a bare `request()` function could falsely advertise every feature.
 */
export function providerTransportOperations(transport) {
  if (!isRecord(transport) || !Array.isArray(transport.supportedOperations)) return Object.freeze([]);
  return Object.freeze([...new Set(
    transport.supportedOperations.filter((operation) =>
      typeof operation === "string" && PROVIDER_TRANSPORT_OPERATION_SET.has(operation)),
  )]);
}

/**
 * Derives a conservative Capability report from operations that the configured
 * transport can actually receive. Semantic proof still comes from current
 * structural and live qualification; this function only prevents missing
 * routes/process operations from being advertised as usable capabilities.
 */
export function deriveProviderCapabilitiesFromTransport(transport) {
  const operations = new Set(providerTransportOperations(transport));
  const hasFactSource = operations.has("observe_binding") || operations.has("reconcile_binding");
  return Object.freeze(REQUIRED_PROVIDER_CAPABILITIES.filter((capability) => {
    switch (capability) {
      case "create_binding":
      case "resume_binding":
        return operations.has("ensure_binding");
      case "input_correlation":
      case "provider_receipt":
        return operations.has("submit_delivery") && hasFactSource;
      case "reconcile":
        return operations.has("reconcile_binding");
      case "interrupt":
        return operations.has("request_interrupt") && hasFactSource;
      case "attention_reply":
        return operations.has("respond_attention") && hasFactSource;
      case "native_child":
        return hasFactSource;
      case "presentation":
        return operations.has("open_presentation");
    }
  }));
}

/** Values align with runtime-contracts ProviderEffect. */
export function createProviderEffect({ provider, operation, request, response, acceptedAt }) {
  if (!PROVIDER_EFFECT_OPERATIONS.includes(operation)) {
    throw new ProviderProtocolError(`Unknown ProviderEffect operation: ${operation}`, { provider });
  }
  const acceptance = normalizeAcceptance(response);
  const seed = response?.effectId ?? response?.transportRequestId ?? request?.idempotencyKey ?? request?.commandId ?? `${operation}:${acceptedAt}`;
  return freezeWithoutUndefined({
    effectId: stringOrUndefined(response?.effectId) ?? `effect_${sha256({ provider, operation, seed }).slice("sha256:".length, 34)}`,
    kind: operation,
    provider: requiredProvider(provider),
    bindingId: stringOrUndefined(request?.bindingId),
    inputSubmissionId: stringOrUndefined(request?.inputSubmissionId),
    attentionId: stringOrUndefined(request?.attentionId),
    acceptance,
    acceptedAt: requiredString(acceptedAt, "acceptedAt"),
    diagnostic: stringOrUndefined(response?.diagnostic ?? response?.reason),
  });
}

/** Values align with runtime-contracts ProviderFact. */
export function normalizeProviderFact({ provider, bindingId, bindingRevision, nativeFact, now = () => new Date().toISOString() }) {
  const raw = isRecord(nativeFact) ? nativeFact : {};
  let kind = requiredFactKind(raw.kind);
  const correlation = normalizeCorrelation(raw);
  let payload = asJsonObject(raw.payload);
  const evidenceReferenceId = stringOrUndefined(raw.evidenceReferenceId ?? raw.evidence?.evidenceReferenceId);

  // A final is a message-bearing fact, not an inference from a terminal turn.
  // Keep the contract narrow so each Adapter can emit it only when its native
  // protocol actually supplied the associated managed input and the text.
  if (kind === "assistant_final") {
    if (!correlation.inputSubmissionId) {
      throw new Error("assistant_final.inputSubmissionId_required");
    }
    requiredString(payload.content, "assistant_final.payload.content");
  }

  if (kind === "activity_observed") {
    if (!correlation.inputSubmissionId && !correlation.sessionTurnId) {
      throw new Error("activity_observed.correlation_required");
    }
    payload = normalizeProviderActivityPayload(payload);
  }

  // Local acceptance, idle, or a latest-message heuristic cannot prove receipt.
  // The history route requires both marker and an evidence reference.
  if (kind === "input_received" && !hasReceiptProof({ correlation, historyMarker: raw.historyMarker ?? raw.evidence?.historyMarker, evidenceReferenceId })) {
    kind = "transport_unknown";
    payload = {
      ...payload,
      originalKind: "input_received",
      reason: "native_receipt_evidence_missing",
    };
  }

  const fact = freezeWithoutUndefined({
    providerFactId: stringOrUndefined(raw.providerFactId ?? raw.factId) ?? `provider_fact_${sha256({
      provider,
      bindingId,
      bindingRevision: raw.bindingRevision ?? bindingRevision,
      kind,
      deduplication: raw.deduplication ?? raw,
      correlation,
      payload,
    }).slice("sha256:".length, 34)}`,
    provider: requiredProvider(provider),
    bindingId: requiredString(bindingId, "bindingId"),
    bindingRevision: positiveInteger(raw.bindingRevision ?? bindingRevision, "bindingRevision"),
    kind,
    deduplication: normalizeDeduplication(raw),
    correlation,
    evidenceReferenceId,
    payload: freezeJsonObject(payload),
    observedAt: stringOrUndefined(raw.observedAt) ?? now(),
  });
  // Validate identity before exposing a fact to the runtime. This does not
  // persist or suppress facts; Store owns cross-restart deduplication.
  providerFactDedupKey(fact);
  return fact;
}

/** Offline fixture seam. It never contacts a real Provider. */
export function createScriptedProviderTransport({ protocol, effects = {}, streams = {}, reconciliations = {} } = {}) {
  const calls = [];
  const streamFacts = new Map(Object.entries(streams).map(([key, value]) => [key, [...value]]));
  const reconcileFacts = new Map(Object.entries(reconciliations).map(([key, value]) => [key, [...value]]));
  const effectHandlers = new Map(Object.entries(effects));
  return Object.freeze({
    supportedOperations: PROVIDER_TRANSPORT_OPERATIONS,
    calls,
    setStream(bindingId, facts) { streamFacts.set(bindingId, [...facts]); },
    setReconciliation(bindingId, facts) { reconcileFacts.set(bindingId, [...facts]); },
    setEffect(operation, handler) { effectHandlers.set(operation, handler); },
    async inspectProtocol() { return protocol; },
    async request({ operation, request }) {
      calls.push(Object.freeze({ operation, request }));
      const handler = effectHandlers.get(operation);
      if (typeof handler === "function") return handler(request, calls);
      return handler ?? { acceptance: "accepted", transportRequestId: `${operation}:fixture` };
    },
    async *observe({ request }) {
      for (const fact of streamFacts.get(request.bindingId) ?? []) yield fact;
    },
    async reconcile({ request }) {
      return { facts: [...(reconcileFacts.get(request.bindingId) ?? [])] };
    },
  });
}

function evaluateProtocolCompatibility({ provider, profile, observedProtocol, capabilities, runtimeProtocolObservation }) {
  const reasons = [];
  const expected = normalizeProfile(profile);
  const observed = observedProtocolEvidence(observedProtocol);
  if (expected.provider !== provider) reasons.push("execution_profile_provider_mismatch");
  for (const field of ["providerVersion", "protocolFingerprint"]) {
    if (!runtimeProtocolObservation[field]) reasons.push(`runtime_observation_${field}_missing`);
    if (!observed[field]) reasons.push(`observed_${field}_missing`);
  }
  if (runtimeProtocolObservation.providerVersion
    && runtimeProtocolObservation.protocolFingerprint
    && observed.providerVersion
    && observed.protocolFingerprint
    && (runtimeProtocolObservation.providerVersion !== observed.providerVersion
      || runtimeProtocolObservation.protocolFingerprint !== observed.protocolFingerprint)) {
    reasons.push("transport_protocol_observation_drift");
  }
  const knownCapabilities = new Set(normalizeCapabilities(capabilities));
  for (const capability of expected.requiredCapabilities) {
    if (!knownCapabilities.has(capability)) reasons.push(`capability_${capability}_unavailable`);
  }
  return freezeWithoutUndefined({
    provider,
    available: reasons.length === 0,
    providerVersion: observed.providerVersion,
    protocolFingerprint: observed.protocolFingerprint,
    capabilities: Object.freeze([...knownCapabilities]),
    unavailableReasons: Object.freeze([...new Set(reasons)]),
  });
}

function unavailableCapabilities({ provider, reasons }) {
  return freezeWithoutUndefined({
    provider,
    available: false,
    capabilities: Object.freeze([]),
    unavailableReasons: Object.freeze(reasons),
  });
}

function normalizeMappedFact({ provider, request, nativeFact, mapNativeFact, now }) {
  let mapped;
  try {
    mapped = mapNativeFact(nativeFact, { provider, bindingId: request.bindingId, bindingRevision: request.bindingRevision });
  } catch (cause) {
    throw new ProviderProtocolError(`Unable to map ${provider} native Provider fact.`, { provider, cause });
  }
  return normalizeProviderFact({ provider, bindingId: request.bindingId, bindingRevision: request.bindingRevision, nativeFact: mapped, now });
}

function trackAttention(fact, attentionScopes) {
  if (fact.kind === "attention_requested") attentionScopes.set(fact.correlation.attentionId, attentionScopeFromFact(fact));
  if (fact.kind === "attention_resolved" && fact.correlation.attentionId) attentionScopes.delete(fact.correlation.attentionId);
}

function attentionScopeFromFact(fact) {
  return Object.freeze({
    attentionId: requiredString(fact.correlation.attentionId, "attentionId"),
    bindingId: fact.bindingId,
    bindingRevision: fact.bindingRevision,
    nativeRequestId: requiredString(fact.correlation.nativeRequestId, "nativeRequestId"),
    inputSubmissionId: stringOrUndefined(fact.correlation.inputSubmissionId),
  });
}

function normalizeAttentionScope(request) {
  return Object.freeze({
    attentionId: requiredString(request?.attentionId, "attentionId"),
    bindingId: requiredString(request?.bindingId, "bindingId"),
    bindingRevision: positiveInteger(request?.bindingRevision, "bindingRevision"),
    nativeRequestId: requiredString(request?.nativeRequestId, "nativeRequestId"),
    inputSubmissionId: stringOrUndefined(request?.activeInputSubmissionId ?? request?.inputSubmissionId),
  });
}

function sameAttentionScope(left, right) {
  return left.attentionId === right.attentionId
    && left.bindingId === right.bindingId
    && left.bindingRevision === right.bindingRevision
    && left.nativeRequestId === right.nativeRequestId
    && left.inputSubmissionId === right.inputSubmissionId;
}

function normalizeProfile(profile) {
  if (!isRecord(profile)) throw new ProviderProtocolError("Execution profile is missing.");
  const source = profile;
  if (!isRecord(source.capabilityPolicy)) throw new ProviderProtocolError("Execution profile capabilityPolicy is missing.");
  const policy = source.capabilityPolicy;
  return {
    provider: requiredProvider(source.provider),
    requiredCapabilities: normalizeCapabilities(policy.requiredCapabilities),
  };
}

function observedProtocolEvidence(protocol) {
  const source = isRecord(protocol) ? protocol : {};
  return freezeWithoutUndefined({
    providerVersion: stringOrUndefined(source.providerVersion),
    protocolFingerprint: stringOrUndefined(source.protocolFingerprint),
  });
}

function normalizeCapabilities(capabilities) {
  if (!Array.isArray(capabilities)) throw new ProviderProtocolError("Provider capabilities must be an array.");
  const normalized = capabilities.map((capability) => {
    const value = requiredString(capability, "provider capability");
    if (!REQUIRED_PROVIDER_CAPABILITIES.includes(value)) {
      throw new ProviderProtocolError(`Unknown provider capability: ${value}`);
    }
    return value;
  });
  return Object.freeze([...new Set(normalized)]);
}

function normalizeCorrelation(raw) {
  const correlation = isRecord(raw.correlation) ? raw.correlation : {};
  return freezeWithoutUndefined({
    inputSubmissionId: stringOrUndefined(correlation.inputSubmissionId ?? raw.inputSubmissionId),
    sessionTurnId: stringOrUndefined(correlation.sessionTurnId ?? raw.sessionTurnId),
    attentionId: stringOrUndefined(correlation.attentionId ?? raw.attention?.attentionId ?? raw.attentionId),
    nativeMessageId: stringOrUndefined(correlation.nativeMessageId ?? raw.nativeMessageId ?? raw.messageId ?? raw.message?.id),
    nativeTurnId: stringOrUndefined(correlation.nativeTurnId ?? raw.nativeTurnId ?? raw.turnId ?? raw.turn?.id),
    nativeRequestId: stringOrUndefined(correlation.nativeRequestId ?? raw.nativeRequestId ?? raw.attention?.nativeRequestId),
  });
}

function normalizeProviderActivityPayload(payload) {
  if (payload.schemaVersion !== 1) throw new ProviderProtocolError("Provider activity schema version is invalid.");
  const activityId = requiredString(payload.activityId, "activity_observed.payload.activityId");
  if (!/^activity_[a-zA-Z0-9-]{12,80}$/.test(activityId)) {
    throw new ProviderProtocolError("Provider activity identity is invalid.");
  }
  const category = requiredString(payload.category, "activity_observed.payload.category");
  if (!["assistant_progress", "tool", "change", "web"].includes(category)) {
    throw new ProviderProtocolError(`Unknown Provider activity category: ${category}`);
  }
  const phase = requiredString(payload.phase, "activity_observed.payload.phase");
  if (!["started", "progress", "completed", "failed"].includes(phase)) {
    throw new ProviderProtocolError(`Unknown Provider activity phase: ${phase}`);
  }
  const title = boundedDisplayString(payload.title, "activity_observed.payload.title", 160);
  const detail = optionalBoundedDisplayString(payload.detail, "activity_observed.payload.detail", 2_000);
  const content = optionalBoundedDisplayString(payload.content, "activity_observed.payload.content", 16_000, true);
  const updateMode = stringOrUndefined(payload.updateMode);
  if (updateMode && !["append", "replace"].includes(updateMode)) {
    throw new ProviderProtocolError(`Unknown Provider activity update mode: ${updateMode}`);
  }
  const sequence = Number(payload.sequence);
  if (!Number.isSafeInteger(sequence) || sequence < 0) {
    throw new ProviderProtocolError("Provider activity sequence is invalid.");
  }
  return freezeWithoutUndefined({
    schemaVersion: 1,
    activityId,
    category,
    phase,
    title,
    detail,
    content,
    updateMode,
    sequence,
  });
}

function boundedDisplayString(value, field, maxLength, allowBlank = false) {
  if (typeof value !== "string" || (!allowBlank && !value.trim())) {
    throw new ProviderProtocolError(`${field} is required.`);
  }
  if (value.length > maxLength) throw new ProviderProtocolError(`${field} exceeds the display limit.`);
  return value;
}

function optionalBoundedDisplayString(value, field, maxLength, allowBlank = false) {
  if (value === undefined || value === null) return undefined;
  return boundedDisplayString(value, field, maxLength, allowBlank);
}

function normalizeDeduplication(raw) {
  const deduplication = isRecord(raw.deduplication) ? raw.deduplication : raw;
  return freezeWithoutUndefined({
    providerEventId: stringOrUndefined(deduplication.providerEventId ?? deduplication.eventId),
    sourceInstanceId: stringOrUndefined(deduplication.sourceInstanceId ?? deduplication.serverInstanceId ?? deduplication.hostInstanceId),
    cursor: stringOrUndefined(deduplication.cursor ?? deduplication.sequence),
    reconciliationWatermark: stringOrUndefined(deduplication.reconciliationWatermark ?? deduplication.watermark),
  });
}

function hasReceiptProof({ correlation, historyMarker, evidenceReferenceId }) {
  return Boolean(correlation.nativeMessageId || correlation.nativeTurnId || (stringOrUndefined(historyMarker) && evidenceReferenceId));
}

function normalizePresentation(value, bindingId) {
  if (!isRecord(value)) throw new ProviderProtocolError("Provider presentation descriptor is missing.");
  const kind = stringOrUndefined(value.kind);
  if (!["workspace_transcript_and_composer", "native_embedded", "external_handoff", "unavailable"].includes(kind)) {
    throw new ProviderProtocolError("Provider presentation descriptor is invalid.");
  }
  return freezeWithoutUndefined({
    presentationLeaseId: requiredString(value.presentationLeaseId, "presentationLeaseId"),
    bindingId: requiredString(value.bindingId ?? bindingId, "presentation.bindingId"),
    kind,
    title: requiredString(value.title, "presentation.title"),
    url: stringOrUndefined(value.url),
    unavailableReason: stringOrUndefined(value.unavailableReason),
    expiresAt: requiredString(value.expiresAt, "presentation.expiresAt"),
    revokedAt: stringOrUndefined(value.revokedAt),
  });
}

function normalizeAcceptance(response) {
  const explicit = stringOrUndefined(response?.acceptance);
  if (["accepted", "rejected", "unknown"].includes(explicit)) return explicit;
  if (response?.accepted === true) return "accepted";
  if (response?.accepted === false) return "rejected";
  return "unknown";
}

function assertBindingRequest(request) {
  requiredString(request?.bindingId, "bindingId");
  positiveInteger(request?.bindingRevision, "bindingRevision");
  requiredString(request?.workspace?.workspaceId, "workspace.workspaceId");
  requiredString(request?.workspace?.cwd, "workspace.cwd");
  assertSessionBootstrap(request?.bootstrap);
}

function assertSessionBootstrap(bootstrap) {
  if (!isRecord(bootstrap)) throw new ProviderProtocolError("Provider Session bootstrap is missing.");
  const purpose = requiredString(bootstrap.purpose, "bootstrap.purpose");
  if (!["task_conductor", "task_worker", "template_design"].includes(purpose)) {
    throw new ProviderProtocolError("Provider Session bootstrap purpose is invalid.");
  }
  requiredString(bootstrap.agentCardId, "bootstrap.agentCardId");
  requiredString(bootstrap.systemPrompt, "bootstrap.systemPrompt");
  if (!Array.isArray(bootstrap.capabilityRefs)) {
    throw new ProviderProtocolError("Provider Session bootstrap capabilityRefs are invalid.");
  }
  for (const capability of bootstrap.capabilityRefs) {
    if (!isRecord(capability)) throw new ProviderProtocolError("Provider Session bootstrap capability ref is invalid.");
    if (!["mcp", "skill"].includes(requiredString(capability.kind, "bootstrap.capabilityRefs.kind"))) {
      throw new ProviderProtocolError("Provider Session bootstrap capability kind is invalid.");
    }
    requiredString(capability.id, "bootstrap.capabilityRefs.id");
  }
  if (bootstrap.dispatchRegistry !== undefined && !Array.isArray(bootstrap.dispatchRegistry)) {
    throw new ProviderProtocolError("Provider Session bootstrap dispatchRegistry is invalid.");
  }
  if (purpose === "task_conductor" && !Array.isArray(bootstrap.dispatchRegistry)) {
    throw new ProviderProtocolError("Conductor bootstrap requires dispatchRegistry.");
  }
  if (purpose !== "task_conductor" && bootstrap.dispatchRegistry !== undefined) {
    throw new ProviderProtocolError("Only a Conductor bootstrap may carry dispatchRegistry.");
  }
  for (const card of bootstrap.dispatchRegistry ?? []) {
    if (!isRecord(card)) throw new ProviderProtocolError("Provider Session bootstrap dispatch card is invalid.");
    requiredString(card.agentCardId, "bootstrap.dispatchRegistry.agentCardId");
    if (!["general", "researcher", "implementer", "reviewer", "publisher"].includes(requiredString(card.kind, "bootstrap.dispatchRegistry.kind"))) {
      throw new ProviderProtocolError("Provider Session bootstrap dispatch card kind is invalid.");
    }
    requiredString(card.title, "bootstrap.dispatchRegistry.title");
    requiredString(card.description, "bootstrap.dispatchRegistry.description");
  }
}

function extractProfile(request) {
  return request?.executionProfile ?? request?.profile;
}

function requiredProvider(value) {
  const provider = requiredString(value, "provider");
  if (!["opencode", "codex", "claude-code"].includes(provider)) throw new ProviderProtocolError(`Unknown provider: ${provider}`, { provider });
  return provider;
}

function requiredFactKind(value) {
  const kind = requiredString(value, "nativeFact.kind");
  if (!PROVIDER_FACT_KINDS.includes(kind)) throw new ProviderProtocolError(`Unknown ProviderFact kind: ${kind}`);
  return kind;
}

function requiredString(value, label) {
  const normalized = stringOrUndefined(value);
  if (!normalized) throw new ProviderProtocolError(`${label} must be a non-empty string.`);
  return normalized;
}

function positiveInteger(value, label) {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 1) throw new ProviderProtocolError(`${label} must be a positive integer.`);
  return normalized;
}

function asAsyncIterable(value) {
  if (value && typeof value[Symbol.asyncIterator] === "function") return value;
  if (value && typeof value[Symbol.iterator] === "function") return (async function* iterable() { yield* value; })();
  throw new ProviderProtocolError("Provider observe response is not iterable.");
}

function asJsonObject(value) {
  return isRecord(value) ? value : {};
}

function freezeJsonObject(value) {
  return freezeJson(value);
}

function freezeJson(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(freezeJson));
  if (isRecord(value)) return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, item]) => [key, freezeJson(item)])));
  return value;
}

function freezeWithoutUndefined(value) {
  return Object.freeze(Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)));
}

function stringOrUndefined(value) {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized || undefined;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

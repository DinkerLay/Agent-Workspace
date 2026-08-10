/**
 * OpenCode Provider Adapter.
 *
 * This is a protocol-gated boundary, not an OpenCode-only Runtime. A concrete
 * OpenCode Server/ACP transport is injected by apps/runtime-host after a
 * version spike has supplied a pinned protocol fingerprint.
 */
import { randomUUID } from "node:crypto";
import {
  REQUIRED_PROVIDER_CAPABILITIES,
  createProtocolGatedProviderAdapter,
  createScriptedProviderTransport,
  renderProviderSessionBootstrap,
  sha256,
} from "../../provider-port/src/index.mjs";

export const OPENCODE_PROVIDER_ID = "opencode";

export const OPENCODE_CAPABILITIES = REQUIRED_PROVIDER_CAPABILITIES;

/**
 * Deliberately fixture-only fingerprint. Production composition must replace it
 * with a version-spike result; no live OpenCode protocol is asserted here.
 */
export const OPENCODE_FIXTURE_PROTOCOL = Object.freeze({
  providerVersion: "fixture-1",
  protocolFingerprint: "sha256:opencode-fixture-schema-v1",
});

export function createOpenCodeProviderAdapter({ transport, protocol, capabilities = OPENCODE_CAPABILITIES, now } = {}) {
  return createProtocolGatedProviderAdapter({
    provider: OPENCODE_PROVIDER_ID,
    declaredProtocol: protocol,
    capabilities,
    transport,
    mapNativeFact: mapOpenCodeNativeFact,
    now,
  });
}

/**
 * Direct transport for the pinned OpenCode Server REST surface. This is not
 * the generic JSON bridge: OpenCode uses method-specific REST routes, session
 * identities, and a server OpenAPI document. Only Host composition may create
 * it because its base URL and headers are Host credentials/configuration.
 */
export function createOpenCodeServerTransport(options = {}) {
  const client = createOpenCodeServerClient(options);
  const bindingRefs = new Map();
  // One ExecutionProfile allows one native turn at a time. Keep the accepted
  // input correlation in the transport so a later Stop from Runtime does not
  // have to guess which historical assistant error it interrupted.
  const activeDeliveries = new Map();
  const deliveryHistory = new Map();
  const pendingInterrupts = new Map();
  const liveStates = new Map();
  const liveSourceInstanceId = `opencode-sse-${randomUUID()}`;
  let liveCursor = 0;

  return Object.freeze({
    supportedOperations: Object.freeze([
      "inspect_protocol",
      "ensure_binding",
      "submit_delivery",
      "observe_binding",
      "reconcile_binding",
      "request_interrupt",
    ]),
    // OpenCode Server 1.18.13 has been spiked for this core only. Its abort
    // route exists, but a live probe could not prove that a native abort record
    // belongs to the requested active input, so interrupt remains unavailable
    // to execution Profiles. The generic operation shape could otherwise infer
    // native-child support merely from reconciliation, which would be an
    // unsupported semantic claim.
    verifiedCapabilities: Object.freeze([
      "create_binding",
      "resume_binding",
      "input_correlation",
      "provider_receipt",
      "reconcile",
    ]),
    inspectProtocol: client.inspectProtocol,
    async request({ operation, request }) {
      if (operation === "ensure_binding") {
        const existing = nativeBindingRef(request, bindingRefs);
        if (request?.disposition === "resume") {
          if (!existing) return rejected("native_binding_ref_required_for_resume");
          await client.getSession(existing, request);
          bindingRefs.set(request.bindingId, existing);
          forgetDeliveryForOtherBindingRef(activeDeliveries, request.bindingId, existing);
          return accepted(existing);
        }
        if (existing) {
          await client.getSession(existing, request);
          forgetDeliveryForOtherBindingRef(activeDeliveries, request.bindingId, existing);
          return accepted(existing);
        }
        const recovered = await findSessionForBinding(client, request);
        if (recovered) {
          bindingRefs.set(request.bindingId, recovered.id);
          forgetDeliveryForOtherBindingRef(activeDeliveries, request.bindingId, recovered.id);
          return accepted(recovered.id);
        }
        const session = await client.createSession(request);
        bindingRefs.set(request.bindingId, session.id);
        activeDeliveries.delete(request.bindingId);
        return accepted(session.id);
      }
      if (operation === "submit_delivery") {
        const nativeRef = nativeBindingRef(request, bindingRefs);
        if (!nativeRef) return rejected("native_binding_ref_required_for_delivery");
        const nativeMessageId = openCodeNativeMessageId(request.inputSubmissionId);
        // Record this before the native side effect. An ambiguous HTTP outcome
        // must not make a subsequent interruption attach to a prior turn.
        const trackedDelivery = activeDelivery(request, nativeRef);
        activeDeliveries.set(request.bindingId, trackedDelivery);
        rememberDelivery(deliveryHistory, request.bindingId, trackedDelivery);
        await client.submitMessage(nativeRef, request, nativeMessageId);
        return accepted(nativeMessageId);
      }
      if (operation === "request_interrupt") {
        const nativeRef = nativeBindingRef(request, bindingRefs);
        if (!nativeRef) return rejected("native_binding_ref_required_for_interrupt");
        const active = await activeDeliveryForInterrupt(client, request, nativeRef, activeDeliveries);
        if (!active) return rejected("opencode_active_input_unknown");
        const previous = pendingInterrupts.get(request.bindingId);
        const pending = previous?.nativeBindingRef === nativeRef && previous.inputSubmissionId === active.inputSubmissionId
          ? previous
          : {
              nativeBindingRef: nativeRef,
              inputSubmissionId: active.inputSubmissionId,
              ...(active.invocationId ? { invocationId: active.invocationId } : {}),
              requestedAt: Date.now(),
            };
        // Establish correlation before the external side effect. OpenCode can
        // complete the native abort before its HTTP response returns.
        pendingInterrupts.set(request.bindingId, pending);
        try {
          await client.abortSession(nativeRef, request);
        } catch (error) {
          if (pendingInterrupts.get(request.bindingId) === pending) pendingInterrupts.delete(request.bindingId);
          throw error;
        }
        return accepted(`interrupt:${nativeRef}:${request.idempotencyKey ?? request.commandId ?? "request"}`);
      }
      return rejected(`opencode_server_operation_unsupported:${String(operation)}`);
    },
    async *observe({ request }) {
      const nativeRef = nativeBindingRef(request, bindingRefs);
      if (!nativeRef) return;
      const state = liveStateFor(liveStates, request.bindingId, nativeRef);
      for await (const event of client.observeEvents(request)) {
        const facts = factsFromOpenCodeEvent({
          event,
          nativeRef,
          request,
          state,
          delivery: activeDeliveries.get(request.bindingId),
          sourceInstanceId: liveSourceInstanceId,
          nextCursor: () => String(liveCursor++),
        });
        for (const fact of facts) yield fact;
        if (facts.some((fact) => fact.type === "opencode.turn.completed" || fact.type === "opencode.turn.failed")) {
          const terminalInput = facts.find((fact) => fact.inputSubmissionId)?.inputSubmissionId;
          if (terminalInput) forgetCompletedDelivery(activeDeliveries, request.bindingId, nativeRef, terminalInput);
        }
      }
    },
    async reconcile({ request }) {
      const nativeRef = nativeBindingRef(request, bindingRefs);
      if (!nativeRef) return [];
      let session;
      try {
        session = await client.getSession(nativeRef, request);
      } catch (error) {
        if (error instanceof OpenCodeServerResponseError && error.status === 404) {
          return [unavailableFact(nativeRef)];
        }
        throw error;
      }
      bindingRefs.set(request.bindingId, session.id);
      const messages = await client.listMessages(session.id, request);
      const facts = [bindingObservedFact(session)];
      const pendingInterrupt = pendingInterrupts.get(request.bindingId);
      const delivery = activeDeliveries.get(request.bindingId);
      let interruptionObserved = false;
      const terminalByInput = new Map();
      for (const message of messages) {
        const normalized = normalizeOpenCodeMessage(message);
        if (!normalized) continue;
        const inputSubmissionId = inputSubmissionIdForNativeMessage(normalized.id);
        if (normalized.role === "user" && inputSubmissionId) {
          facts.push(deliveryReceiptFact(session.id, normalized, inputSubmissionId, knownDeliveryForInput(
            deliveryHistory, request.bindingId, delivery, session.id, inputSubmissionId,
          )));
          continue;
        }
        const parentInputSubmissionId = inputSubmissionIdForNativeMessage(normalized.parentID);
        if (normalized.role === "assistant" && parentInputSubmissionId) {
          const correlatedDelivery = knownDeliveryForInput(
            deliveryHistory, request.bindingId, delivery, session.id, parentInputSubmissionId,
          );
          facts.push(...activityFactsFromMessage({
            sessionId: session.id,
            message: normalized,
            inputSubmissionId: parentInputSubmissionId,
            delivery: correlatedDelivery,
            request,
          }));
          const matchingPendingInterrupt = pendingInterrupt?.nativeBindingRef === session.id
            && pendingInterrupt.inputSubmissionId === parentInputSubmissionId;
          if (normalized.errorName === "MessageAbortedError" && matchingPendingInterrupt && wasInterruptedAfter(normalized, pendingInterrupt.requestedAt)) {
            interruptionObserved = true;
            facts.push(interruptConfirmedFact(session.id, normalized, pendingInterrupt));
          } else if (isTerminalAssistantMessage(normalized)) {
            const candidates = terminalByInput.get(parentInputSubmissionId) ?? [];
            candidates.push({ message: normalized, delivery: correlatedDelivery });
            terminalByInput.set(parentInputSubmissionId, candidates);
          }
        }
      }
      for (const [inputSubmissionId, candidates] of terminalByInput) {
        // OpenCode can have several assistant children for one managed input
        // during a tool loop. Only one recognized terminal child is safe. If
        // history contains multiple terminal candidates, choosing the latest
        // would invent a stronger native correlation than the protocol gives.
        if (candidates.length !== 1) continue;
        const terminal = candidates[0];
        facts.push(...assistantTerminalFacts(session.id, terminal.message, inputSubmissionId, terminal.delivery));
        forgetCompletedDelivery(activeDeliveries, request.bindingId, session.id, inputSubmissionId);
      }
      if (pendingInterrupt?.nativeBindingRef === session.id) {
        const statuses = await client.listSessionStatuses(request);
        // A missing status alone can mean an ordinarily idle Session. Only an
        // observed native abort record plus idle state proves this Stop's
        // terminal transition; an HTTP abort acceptance never does.
        if (interruptionObserved && !isSessionActive(statuses, session.id)) {
          pendingInterrupts.delete(request.bindingId);
          facts.push(interruptTerminalFact(session.id, pendingInterrupt));
        }
      }
      return facts;
    },
  });
}

/**
 * Produces the pin users put into AGENT_WORKSPACE_PROVIDER_CONFIG. The hash is
 * over the OpenAPI document rather than a claimed adapter version, so a server
 * route/schema change fails closed until it is reviewed.
 */
export function openCodeServerProtocolFingerprint(openApi) {
  if (!openApi || typeof openApi !== "object") throw new TypeError("opencode_openapi_invalid");
  return sha256(openApi);
}

export async function inspectOpenCodeServerProtocol(options = {}) {
  return createOpenCodeServerClient(options).inspectProtocol();
}

/** Offline Adapter fixture seam used by contract tests and host-level fakes. */
export function createOpenCodeFixtureTransport(options = {}) {
  return createScriptedProviderTransport({
    protocol: options.protocol ?? OPENCODE_FIXTURE_PROTOCOL,
    effects: options.effects,
    streams: options.streams,
    reconciliations: options.reconciliations,
  });
}

export function createOpenCodeFixtureProfile(overrides = {}) {
  return Object.freeze({
    executionProfileId: "profile_opencode_fixture",
    provider: OPENCODE_PROVIDER_ID,
    model: "fixture-model",
    providerVersion: overrides.providerVersion ?? OPENCODE_FIXTURE_PROTOCOL.providerVersion,
    protocolFingerprint: overrides.protocolFingerprint ?? OPENCODE_FIXTURE_PROTOCOL.protocolFingerprint,
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
 * Maps only observed native fields into neutral ProviderFact facts. It does not
 * infer Task states, result completion, or delivery receipt from transport
 * acceptance. The event aliases below are fixture/protocol-mapper aliases, not
 * claims about an unpinned OpenCode server version.
 */
export function mapOpenCodeNativeFact(nativeFact, { bindingId } = {}) {
  const raw = nativeFact ?? {};
  const nativeType = raw.type ?? raw.event?.type ?? raw.kind;
  const kind = OPEN_CODE_FACT_KIND[nativeType] ?? raw.factKind ?? raw.kind;
  return {
    kind,
    providerEventId: raw.providerEventId ?? raw.eventId ?? raw.event?.id,
    sourceInstanceId: raw.sourceInstanceId ?? raw.serverInstanceId,
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
    sessionTurnId: raw.sessionTurnId,
    invocationId: raw.invocationId ?? raw.attention?.invocationId,
    attentionId: raw.attentionId ?? raw.attention?.attentionId,
    nativeRequestId: raw.nativeRequestId ?? raw.attention?.nativeRequestId,
  };
}

const OPEN_CODE_FACT_KIND = Object.freeze({
  "opencode.binding.observed": "binding_observed",
  "opencode.binding.unavailable": "binding_unavailable",
  "opencode.binding.created": "binding_observed",
  "opencode.binding.resumed": "binding_observed",
  "opencode.delivery.receipt": "input_received",
  "opencode.delivery.rejected": "input_rejected",
  "opencode.delivery.unknown": "transport_unknown",
  "opencode.attention.requested": "attention_requested",
  "opencode.attention.resolved": "attention_resolved",
  "opencode.interrupt.confirmed": "interrupt_confirmed",
  "opencode.turn.started": "turn_started",
  "opencode.activity.observed": "activity_observed",
  "opencode.assistant.final": "assistant_final",
  "opencode.turn.completed": "turn_completed",
  "opencode.turn.failed": "turn_failed",
  "opencode.interrupt.unknown": "transport_unknown",
  "opencode.native.terminal": "native_terminal",
  "opencode.child.started": "native_child_observed",
  "opencode.child.completed": "native_child_observed",
});

function withoutProfileFields(overrides) {
  const { providerVersion, protocolFingerprint, capabilityPolicy, ...rest } = overrides;
  return rest;
}

function createOpenCodeServerClient({ baseUrl, headers = {}, fetchFn = globalThis.fetch } = {}) {
  if (typeof fetchFn !== "function") throw new TypeError("opencode_server_fetch_required");
  const root = normalizeBaseUrl(baseUrl);
  const requestJson = async ({ method = "GET", pathname, request, body }) => {
    const url = new URL(pathname.replace(/^\//, ""), root);
    const cwd = request?.workspace?.cwd;
    if (typeof cwd === "string" && cwd) url.searchParams.set("directory", cwd);
    const hasBody = body !== undefined;
    const response = await fetchFn(url, {
      method,
      headers: {
        accept: "application/json",
        ...(hasBody ? { "content-type": "application/json" } : {}),
        ...headers,
      },
      ...(hasBody ? { body: JSON.stringify(body) } : {}),
    });
    const text = await response.text();
    if (!response.ok) throw new OpenCodeServerResponseError(response.status, `${method} ${url.pathname}`);
    if (!text.trim()) return undefined;
    try {
      return JSON.parse(text);
    } catch {
      throw new OpenCodeServerResponseError(response.status, `${method} ${url.pathname} returned non-JSON`);
    }
  };
  return Object.freeze({
    async inspectProtocol() {
      const [health, openApi] = await Promise.all([
        requestJson({ pathname: "/global/health" }),
        requestJson({ pathname: "/doc" }),
      ]);
      const providerVersion = text(health?.version);
      if (!providerVersion || health?.healthy !== true) throw new Error("opencode_server_health_invalid");
      return Object.freeze({ providerVersion, protocolFingerprint: openCodeServerProtocolFingerprint(openApi) });
    },
    async createSession(request) {
      const session = await requestJson({
        method: "POST",
        pathname: "/session",
        request,
        body: {
          title: `Agent Workspace ${request.bindingId}`,
          metadata: { agentWorkspace: { bindingId: request.bindingId, bindingRevision: request.bindingRevision } },
        },
      });
      return requiredSession(session, "opencode_session_create_invalid");
    },
    async getSession(nativeRef, request) {
      const session = await requestJson({ pathname: `/session/${encodeURIComponent(nativeRef)}`, request });
      return requiredSession(session, "opencode_session_get_invalid");
    },
    async listSessions(request) {
      const sessions = await requestJson({ pathname: "/session", request });
      return Array.isArray(sessions) ? sessions.map((session) => requiredSession(session, "opencode_session_list_invalid")) : [];
    },
    async submitMessage(nativeRef, request, messageID) {
      const model = openCodeModel(request?.executionProfile?.model);
      await requestJson({
        method: "POST",
        // OpenCode's synchronous /message route waits for completion and can
        // replay an in-flight prompt on a disconnected client. The Runtime
        // records local acceptance only, then obtains receipt and terminal
        // facts from native history/reconciliation, so its correct transport
        // is the server's 204 asynchronous prompt route.
        pathname: `/session/${encodeURIComponent(nativeRef)}/prompt_async`,
        request,
        body: {
          messageID,
          ...(model ? { model } : {}),
          tools: toolPolicy(request?.executionProfile),
          ...(request?.bootstrap ? { system: renderProviderSessionBootstrap(request.bootstrap) } : {}),
          parts: [{ type: "text", text: requiredText(request?.content, "opencode_delivery_content_invalid") }],
        },
      });
    },
    async abortSession(nativeRef, request) {
      await requestJson({ method: "POST", pathname: `/session/${encodeURIComponent(nativeRef)}/abort`, request });
    },
    async listMessages(nativeRef, request) {
      const messages = await requestJson({ pathname: `/session/${encodeURIComponent(nativeRef)}/message`, request });
      if (!Array.isArray(messages)) throw new Error("opencode_session_messages_invalid");
      return messages;
    },
    async listSessionStatuses(request) {
      const statuses = await requestJson({ pathname: "/session/status", request });
      return statuses && typeof statuses === "object" && !Array.isArray(statuses) ? statuses : {};
    },
    async *observeEvents(request) {
      const url = new URL("event", root);
      const cwd = request?.workspace?.cwd;
      if (typeof cwd === "string" && cwd) url.searchParams.set("directory", cwd);
      const controller = new AbortController();
      let response;
      try {
        response = await fetchFn(url, {
          method: "GET",
          headers: { accept: "text/event-stream", ...headers },
          signal: controller.signal,
        });
        if (!response.ok || !response.body) {
          throw new OpenCodeServerResponseError(response.status, `GET ${url.pathname}`);
        }
        yield* parseServerSentEvents(response.body);
      } finally {
        controller.abort();
      }
    },
  });
}

async function* parseServerSentEvents(body) {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true }).replaceAll("\r\n", "\n");
    let boundary;
    while ((boundary = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const data = block.split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice("data:".length).trimStart())
        .join("\n");
      if (!data || data === "[DONE]") continue;
      try {
        const event = JSON.parse(data);
        if (event && typeof event === "object") yield event;
      } catch {
        // A malformed frame is not converted into a domain fact. The native
        // stream may continue with later valid frames and reconciliation still
        // remains the durable recovery path.
      }
    }
  }
}

class OpenCodeServerResponseError extends Error {
  constructor(status, message) {
    super(`opencode_server_response_${status}:${message}`);
    this.name = "OpenCodeServerResponseError";
    this.status = status;
  }
}

function normalizeBaseUrl(value) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError("opencode_server_base_url_required");
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError("opencode_server_base_url_invalid");
  }
  if (!(["http:", "https:"].includes(url.protocol)) || url.username || url.password) {
    throw new TypeError("opencode_server_base_url_invalid");
  }
  return new URL(url.toString().replace(/\/?$/, "/"));
}

function nativeBindingRef(request, bindingRefs) {
  const persisted = text(request?.nativeBindingRef);
  if (persisted) return persisted;
  return bindingRefs.get(request?.bindingId);
}

async function findSessionForBinding(client, request) {
  const sessions = await client.listSessions(request);
  return sessions.find((session) => session?.metadata?.agentWorkspace?.bindingId === request?.bindingId);
}

function accepted(transportRequestId) {
  return { accepted: true, transportRequestId: String(transportRequestId) };
}

function rejected(diagnostic) {
  return { accepted: false, diagnostic };
}

function requiredSession(value, code) {
  const id = text(value?.id);
  if (!id) throw new Error(code);
  return value;
}

function requiredText(value, code) {
  const normalized = text(value);
  if (!normalized) throw new Error(code);
  return normalized;
}

function text(value) {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function openCodeModel(model) {
  const configured = text(model);
  if (!configured) return undefined;
  const divider = configured.indexOf("/");
  if (divider <= 0 || divider === configured.length - 1) return undefined;
  return { providerID: configured.slice(0, divider), modelID: configured.slice(divider + 1) };
}

function toolPolicy(profile) {
  const allowed = Array.isArray(profile?.capabilityPolicy?.allowedTools) ? profile.capabilityPolicy.allowedTools : [];
  return Object.fromEntries(allowed.filter((tool) => typeof tool === "string" && tool).map((tool) => [tool, true]));
}

function openCodeNativeMessageId(inputSubmissionId) {
  const input = requiredText(inputSubmissionId, "opencode_input_submission_id_invalid");
  if (!input.startsWith("input_")) throw new Error("opencode_input_submission_id_invalid");
  return `msg_${input}`;
}

function inputSubmissionIdForNativeMessage(value) {
  const nativeMessageId = text(value);
  if (!nativeMessageId?.startsWith("msg_input_")) return undefined;
  return nativeMessageId.slice("msg_".length);
}

function activeDelivery(request, nativeBindingRef) {
  const inputSubmissionId = requiredText(request?.inputSubmissionId, "opencode_input_submission_id_invalid");
  const invocationId = text(request?.invocationId);
  return Object.freeze({
    nativeBindingRef,
    inputSubmissionId,
    ...(invocationId ? { invocationId } : {}),
  });
}

function forgetDeliveryForOtherBindingRef(activeDeliveries, bindingId, nativeBindingRef) {
  const delivery = activeDeliveries.get(bindingId);
  if (delivery && delivery.nativeBindingRef !== nativeBindingRef) activeDeliveries.delete(bindingId);
}

function deliveryForInput(delivery, nativeBindingRef, inputSubmissionId) {
  if (!delivery) return undefined;
  return delivery.nativeBindingRef === nativeBindingRef && delivery.inputSubmissionId === inputSubmissionId ? delivery : undefined;
}

function rememberDelivery(deliveryHistory, bindingId, delivery) {
  const history = deliveryHistory.get(bindingId) ?? new Map();
  history.set(delivery.inputSubmissionId, delivery);
  deliveryHistory.set(bindingId, history);
}

function knownDeliveryForInput(deliveryHistory, bindingId, active, nativeBindingRef, inputSubmissionId) {
  return deliveryForInput(active, nativeBindingRef, inputSubmissionId)
    ?? deliveryForInput(deliveryHistory.get(bindingId)?.get(inputSubmissionId), nativeBindingRef, inputSubmissionId);
}

function forgetCompletedDelivery(activeDeliveries, bindingId, nativeBindingRef, inputSubmissionId) {
  if (deliveryForInput(activeDeliveries.get(bindingId), nativeBindingRef, inputSubmissionId)) {
    activeDeliveries.delete(bindingId);
  }
}

async function activeDeliveryForInterrupt(client, request, nativeBindingRef, activeDeliveries) {
  const tracked = activeDeliveries.get(request?.bindingId);
  const requestedInputSubmissionId = text(request?.inputSubmissionId);
  if (tracked?.nativeBindingRef === nativeBindingRef) {
    if (requestedInputSubmissionId && requestedInputSubmissionId !== tracked.inputSubmissionId) return undefined;
    return tracked;
  }

  // Host recovery loses in-memory delivery state. Recover only an unfinished
  // tagged user message; a completed historical turn must never become the
  // target of a new Stop request.
  const inputSubmissionId = latestActiveInputSubmissionId(await client.listMessages(nativeBindingRef, request));
  if (!inputSubmissionId || (requestedInputSubmissionId && requestedInputSubmissionId !== inputSubmissionId)) return undefined;
  const invocationId = text(request?.invocationId);
  return Object.freeze({
    nativeBindingRef,
    inputSubmissionId,
    ...(invocationId ? { invocationId } : {}),
  });
}

function latestActiveInputSubmissionId(messages) {
  const inputs = [];
  const terminalInputs = new Set();
  for (const message of messages) {
    const normalized = normalizeOpenCodeMessage(message);
    if (!normalized) continue;
    const inputSubmissionId = inputSubmissionIdForNativeMessage(normalized.id);
    if (normalized.role === "user" && inputSubmissionId) {
      inputs.push(inputSubmissionId);
      continue;
    }
    const parentInputSubmissionId = inputSubmissionIdForNativeMessage(normalized.parentID);
    if (normalized.role === "assistant" && parentInputSubmissionId && isTerminalAssistantMessage(normalized)) {
      terminalInputs.add(parentInputSubmissionId);
    }
  }
  for (let index = inputs.length - 1; index >= 0; index -= 1) {
    if (!terminalInputs.has(inputs[index])) return inputs[index];
  }
  return undefined;
}

function normalizeOpenCodeMessage(value) {
  const info = value?.info && typeof value.info === "object" ? value.info : value;
  const id = text(info?.id);
  const role = text(info?.role);
  if (!id || !role) return undefined;
  const finish = text(info?.finish)?.toLowerCase();
  const errorName = text(info?.error?.name);
  const parts = Array.isArray(value?.parts)
    ? value.parts.map(normalizeOpenCodePart).filter(Boolean)
    : [];
  return {
    id,
    role,
    ...(text(info?.parentID) ? { parentID: text(info.parentID) } : {}),
    completedAt: Number.isFinite(info?.time?.completed) ? info.time.completed : undefined,
    finish,
    errorName,
    parts,
  };
}

function normalizeOpenCodePart(value) {
  if (!value || typeof value !== "object") return undefined;
  const id = text(value.id);
  const messageId = text(value.messageID);
  const type = text(value.type);
  if (!id || !messageId || !type) return undefined;
  if (type === "text") {
    return {
      id,
      messageId,
      type,
      text: typeof value.text === "string" ? value.text : "",
      ignored: value.ignored === true,
      synthetic: value.synthetic === true,
      startedAt: Number.isFinite(value?.time?.start) ? value.time.start : undefined,
      completedAt: Number.isFinite(value?.time?.end) ? value.time.end : undefined,
    };
  }
  if (type === "tool") {
    const state = value.state && typeof value.state === "object" ? value.state : {};
    return {
      id,
      messageId,
      type,
      tool: text(value.tool) ?? "tool",
      callId: text(value.callID),
      state: {
        status: text(state.status) ?? "pending",
        input: state.input && typeof state.input === "object" ? state.input : undefined,
        title: text(state.title),
        output: typeof state.output === "string" ? state.output : undefined,
        error: typeof state.error === "string" ? state.error : undefined,
      },
    };
  }
  if (type === "patch") {
    return {
      id,
      messageId,
      type,
      files: Array.isArray(value.files) ? value.files.filter((file) => typeof file === "string") : [],
    };
  }
  // Reasoning, step markers and all other native Part variants are not human
  // execution presentation under the current bounded contract.
  return undefined;
}

function isTerminalAssistantMessage(message) {
  if (message.errorName) return true;
  return ["stop", "end", "length", "content-filter", "completed", "done", "error", "failed"].includes(message.finish);
}

function isFailedAssistantMessage(message) {
  return Boolean(message.errorName) || message.finish === "error" || message.finish === "failed";
}

function liveStateFor(states, bindingId, nativeRef) {
  const existing = states.get(bindingId);
  if (existing?.nativeRef === nativeRef) return existing;
  const state = {
    nativeRef,
    messageInputs: new Map(),
    messageRoles: new Map(),
    partsById: new Map(),
    partsByMessage: new Map(),
    sequences: new Map(),
    seenEventIds: new Set(),
    emittedTerminalMessages: new Set(),
  };
  states.set(bindingId, state);
  return state;
}

function factsFromOpenCodeEvent({ event, nativeRef, request, state, delivery, sourceInstanceId, nextCursor }) {
  const eventType = text(event?.type);
  const properties = event?.properties && typeof event.properties === "object" ? event.properties : {};
  const sessionId = text(properties.sessionID)
    ?? text(properties?.part?.sessionID)
    ?? text(properties?.info?.sessionID);
  if (!eventType || sessionId !== nativeRef) return [];
  const eventId = text(event?.id);
  if (eventId && state.seenEventIds.has(eventId)) return [];
  if (eventId) state.seenEventIds.add(eventId);

  if (eventType === "message.updated") {
    const message = normalizeOpenCodeMessage({ info: properties.info, parts: [] });
    if (!message) return [];
    state.messageRoles.set(message.id, message.role);
    const inputSubmissionId = inputSubmissionIdForNativeMessage(message.id);
    if (message.role === "user" && inputSubmissionId) {
      return [deliveryReceiptFact(nativeRef, message, inputSubmissionId, deliveryForInput(delivery, nativeRef, inputSubmissionId))];
    }
    const parentInputSubmissionId = inputSubmissionIdForNativeMessage(message.parentID);
    if (message.role !== "assistant" || !parentInputSubmissionId) return [];
    state.messageInputs.set(message.id, parentInputSubmissionId);
    if (!isTerminalAssistantMessage(message) || state.emittedTerminalMessages.has(message.id)) return [];
    state.emittedTerminalMessages.add(message.id);
    const withParts = {
      ...message,
      parts: [...(state.partsByMessage.get(message.id)?.values() ?? [])],
    };
    return assistantTerminalFacts(
      nativeRef,
      withParts,
      parentInputSubmissionId,
      deliveryForInput(delivery, nativeRef, parentInputSubmissionId),
    );
  }

  if (eventType === "message.part.updated") {
    const part = normalizeOpenCodePart(properties.part);
    if (!part) return [];
    const inputSubmissionId = inputForLivePart(state, part, delivery, nativeRef);
    if (!inputSubmissionId) return [];
    rememberLivePart(state, part);
    const sequence = nextActivitySequence(state, opaqueActivityId(nativeRef, part.messageId, part.id));
    const liveDeduplication = eventId
      ? { providerEventId: `opencode-event:${eventId}` }
      : { sourceInstanceId, cursor: nextCursor() };
    const fact = activityFactFromPart({
      sessionId: nativeRef,
      messageId: part.messageId,
      part,
      partIndex: 0,
      inputSubmissionId,
      delivery: deliveryForInput(delivery, nativeRef, inputSubmissionId),
      request,
      sequence,
      ...liveDeduplication,
    });
    return fact ? [fact] : [];
  }

  if (eventType === "message.part.delta" && properties.field === "text" && typeof properties.delta === "string") {
    const partId = text(properties.partID);
    const existing = partId ? state.partsById.get(partId) : undefined;
    if (!existing || existing.type !== "text") return [];
    const inputSubmissionId = state.messageInputs.get(existing.messageId)
      ?? deliveryForLivePart(delivery, nativeRef, existing.messageId);
    if (!inputSubmissionId) return [];
    const updated = { ...existing, text: `${existing.text ?? ""}${properties.delta}` };
    rememberLivePart(state, updated);
    const activityId = opaqueActivityId(nativeRef, updated.messageId, updated.id);
    const liveDeduplication = eventId
      ? { providerEventId: `opencode-event:${eventId}` }
      : { sourceInstanceId, cursor: nextCursor() };
    const fact = activityFactFromPart({
      sessionId: nativeRef,
      messageId: updated.messageId,
      part: updated,
      partIndex: 0,
      inputSubmissionId,
      delivery: deliveryForInput(delivery, nativeRef, inputSubmissionId),
      request,
      sequence: nextActivitySequence(state, activityId),
      delta: properties.delta,
      ...liveDeduplication,
    });
    return fact ? [fact] : [];
  }

  return [];
}

function inputForLivePart(state, part, delivery, nativeRef) {
  const knownRole = state.messageRoles.get(part.messageId);
  if (knownRole === "user") return undefined;
  const knownInput = state.messageInputs.get(part.messageId);
  if (knownInput) return knownInput;
  const activeInput = deliveryForLivePart(delivery, nativeRef, part.messageId);
  if (activeInput) {
    state.messageRoles.set(part.messageId, "assistant");
    state.messageInputs.set(part.messageId, activeInput);
  }
  return activeInput;
}

function deliveryForLivePart(delivery, nativeRef, messageId) {
  if (!delivery || delivery.nativeBindingRef !== nativeRef) return undefined;
  if (messageId === openCodeNativeMessageId(delivery.inputSubmissionId)) return undefined;
  return delivery.inputSubmissionId;
}

function rememberLivePart(state, part) {
  state.partsById.set(part.id, part);
  const parts = state.partsByMessage.get(part.messageId) ?? new Map();
  parts.set(part.id, part);
  state.partsByMessage.set(part.messageId, parts);
}

function nextActivitySequence(state, activityId) {
  const next = (state.sequences.get(activityId) ?? -1) + 1;
  state.sequences.set(activityId, next);
  return next;
}

function activityFactsFromMessage({ sessionId, message, inputSubmissionId, delivery, request }) {
  if (message.role !== "assistant") return [];
  return message.parts.flatMap((part, index) => {
    const fact = activityFactFromPart({
      sessionId,
      messageId: message.id,
      part,
      partIndex: index,
      inputSubmissionId,
      delivery,
      request,
      sequence: snapshotSequence(part),
    });
    return fact ? [fact] : [];
  });
}

function activityFactFromPart({
  sessionId,
  messageId,
  part,
  partIndex,
  inputSubmissionId,
  delivery,
  request,
  sequence,
  delta,
  providerEventId,
  sourceInstanceId,
  cursor,
}) {
  if (part.type !== "text" && part.type !== "tool" && part.type !== "patch") return undefined;
  if (part.type === "text" && (part.ignored || part.synthetic)) return undefined;
  const activityId = opaqueActivityId(sessionId, messageId, part.id ?? `${part.type}:${partIndex}`);
  const cwd = request?.workspace?.cwd;
  const payload = part.type === "text"
    ? {
        schemaVersion: 1,
        activityId,
        category: "assistant_progress",
        phase: delta === undefined ? textActivityPhase(part) : "progress",
        title: "Assistant response",
        content: boundedDisplayText(redactDisplayText(delta ?? part.text ?? "", cwd, 16_000), 16_000),
        updateMode: delta === undefined ? "replace" : "append",
        sequence,
      }
    : part.type === "tool"
      ? toolActivityPayload(part, activityId, sequence, cwd)
      : patchActivityPayload(part, activityId, sequence, cwd);
  const payloadDigest = sha256(payload).slice("sha256:".length, "sha256:".length + 20);
  return {
    type: "opencode.activity.observed",
    ...(providerEventId
      ? { providerEventId, sourceInstanceId: "opencode-server" }
      : sourceInstanceId && cursor !== undefined
        ? { sourceInstanceId, cursor }
        : { providerEventId: `activity:${activityId}:${sequence}:${payloadDigest}`, sourceInstanceId: "opencode-server" }),
    inputSubmissionId,
    ...(delivery?.invocationId ? { invocationId: delivery.invocationId } : {}),
    nativeMessageId: messageId,
    payload,
  };
}

function toolActivityPayload(part, activityId, sequence, cwd) {
  const status = part.state?.status;
  const phase = status === "completed"
    ? "completed"
    : status === "error" || status === "failed"
      ? "failed"
      : status === "running"
        ? "progress"
        : "started";
  const title = `Tool · ${boundedDisplayText(redactDisplayText(part.tool ?? "tool", cwd, 120), 120)}`;
  const detail = safeToolDetail(part.state);
  const rawContent = phase === "failed" ? part.state?.error : phase === "completed" ? part.state?.output : undefined;
  const content = typeof rawContent === "string"
    ? boundedDisplayText(redactDisplayText(rawContent, cwd, 16_000), 16_000)
    : undefined;
  return {
    schemaVersion: 1,
    activityId,
    category: toolCategory(part.tool),
    phase,
    title,
    ...(detail ? { detail } : {}),
    ...(content !== undefined ? { content } : {}),
    updateMode: "replace",
    sequence,
  };
}

function patchActivityPayload(part, activityId, sequence, cwd) {
  const files = [...new Set(part.files.map((file) => safeWorkspaceRelativePath(file, cwd)).filter(Boolean))].slice(0, 200);
  const content = boundedDisplayText(files.join("\n"), 16_000);
  return {
    schemaVersion: 1,
    activityId,
    category: "change",
    phase: "completed",
    title: "File changes",
    detail: `${files.length} file${files.length === 1 ? "" : "s"}`,
    content,
    updateMode: "replace",
    sequence,
  };
}

function safeWorkspaceRelativePath(value, cwd) {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const normalized = value.trim().replaceAll("\\", "/");
  const normalizedCwd = typeof cwd === "string" ? cwd.replaceAll("\\", "/").replace(/\/$/, "") : undefined;
  let relative = normalized;
  if (normalizedCwd && normalized.startsWith(`${normalizedCwd}/`)) {
    relative = normalized.slice(normalizedCwd.length + 1);
  } else if (normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized) || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(normalized)) {
    return undefined;
  }
  const segments = relative.split("/").filter((segment) => segment && segment !== ".");
  if (segments.length === 0 || segments.some((segment) => segment === "..")) return undefined;
  return boundedDisplayText(segments.join("/"), 1_000);
}

function textActivityPhase(part) {
  if (Number.isFinite(part.completedAt)) return "completed";
  return part.text ? "progress" : "started";
}

function snapshotSequence(part) {
  if (part.type === "text") return textActivityPhase(part) === "completed" ? 2 : part.text ? 1 : 0;
  if (part.type === "tool") {
    if (part.state?.status === "running") return 1;
    if (["completed", "error", "failed"].includes(part.state?.status)) return 2;
  }
  if (part.type === "patch") return 0;
  return 0;
}

function toolCategory(tool) {
  const normalized = String(tool ?? "").toLowerCase();
  if (["edit", "write", "apply_patch", "patch"].some((candidate) => normalized.includes(candidate))) return "change";
  if (["web", "browser", "fetch", "search"].some((candidate) => normalized.includes(candidate))) return "web";
  return "tool";
}

function safeToolDetail(state) {
  const pieces = [];
  if (state?.input && typeof state.input === "object") {
    const fields = Object.keys(state.input).filter((field) => !isSensitiveField(field)).slice(0, 24);
    if (fields.length > 0) pieces.push(`Input fields: ${fields.join(", ")}`);
  }
  return pieces.length > 0 ? boundedDisplayText(pieces.join(" · "), 2_000) : undefined;
}

function isSensitiveField(field) {
  return /authorization|cookie|credential|password|secret|token|api.?key|private.?key/i.test(field);
}

function redactDisplayText(value, cwd, maxLength) {
  const raw = typeof value === "string" ? value : String(value ?? "");
  const scanLimit = Math.max(maxLength, maxLength * 4);
  let result = raw.length > scanLimit ? `${raw.slice(0, scanLimit)}\n… [truncated]` : raw;
  result = result.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "�");
  if (typeof cwd === "string" && cwd) result = result.split(cwd).join("<workspace>");
  result = result
    .replace(/-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\r\n]*PRIVATE KEY-----/gu, "<redacted private key>")
    .replace(/-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*/gu, "<redacted private key>")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/giu, "Bearer <redacted>")
    .replace(/\b([A-Za-z0-9_]{0,80}(?:TOKEN|SECRET|PASSWORD|PASSWD|API[_-]?KEY|AUTHORIZATION|COOKIE|CREDENTIAL)[A-Za-z0-9_]{0,80})\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/giu, "$1=<redacted>")
    .replace(/((?:--)?(?:api[-_]?key|token|secret|password|passwd|auth(?:orization)?|cookie|credential)\s+)(?:"[^"]*"|'[^']*'|[^\s,;]+)/giu, "$1<redacted>")
    .replace(/(["'](?:api[-_]?key|token|secret|password|passwd|authorization|cookie|credential)["']\s*:\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+)/giu, "$1<redacted>")
    .replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]{8,}|github_pat_[A-Za-z0-9_]{8,})\b/gu, "<redacted>")
    .replace(/\bAKIA[A-Z0-9]{16}\b/gu, "<redacted>")
    .replace(/([a-z][a-z0-9+.-]{0,31}:\/\/)([^/\s:@]+):([^@\s/]+)@/giu, "$1<redacted>@")
    .replace(/\b(?:ses|msg|prt|call|evt)_[A-Za-z0-9_-]{6,}\b/g, "<redacted-id>")
    .replace(/\/(?:Users|home|private|tmp|var|Volumes|etc|opt|root|srv|mnt)\/[^\s"'`]+/g, "<path>")
    .replace(/\b[A-Za-z]:[\\/][^\s"'`]+/g, "<path>");
  return result;
}

function boundedDisplayText(value, maxLength) {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 1))}…`;
}

function opaqueActivityId(sessionId, messageId, partId) {
  return `activity_${sha256({ provider: OPENCODE_PROVIDER_ID, sessionId, messageId, partId }).slice("sha256:".length, "sha256:".length + 40)}`;
}

function assistantFinalContent(message) {
  const segments = message.parts
    .filter((part) => part.type === "text"
      && !part.ignored
      && !part.synthetic
      && Number.isFinite(part.completedAt)
      && typeof part.text === "string")
    .map((part) => part.text)
    .filter((content) => content.trim());
  return segments.length > 0 ? segments.join("\n") : undefined;
}

function assistantTerminalFacts(sessionId, message, inputSubmissionId, delivery) {
  const terminal = turnTerminalFact(sessionId, message, inputSubmissionId, delivery);
  if (isFailedAssistantMessage(message)) return [terminal];
  const content = assistantFinalContent(message);
  if (!content) return [terminal];
  return [assistantFinalFact(sessionId, message, inputSubmissionId, delivery, content), terminal];
}

function assistantFinalFact(sessionId, message, inputSubmissionId, delivery, content) {
  return {
    type: "opencode.assistant.final",
    providerEventId: `assistant-final:${sessionId}:${message.id}`,
    sourceInstanceId: "opencode-server",
    inputSubmissionId,
    ...(delivery?.invocationId ? { invocationId: delivery.invocationId } : {}),
    nativeMessageId: message.id,
    nativeTurnId: message.id,
    payload: { content, finish: message.finish ?? "completed" },
  };
}

function bindingObservedFact(session) {
  return {
    type: "opencode.binding.observed",
    providerEventId: `binding:${session.id}:${sessionRevision(session)}`,
    sourceInstanceId: "opencode-server",
    payload: { nativeBindingRef: session.id, sessionRevision: sessionRevision(session) },
  };
}

function deliveryReceiptFact(sessionId, message, inputSubmissionId, delivery) {
  return {
    type: "opencode.delivery.receipt",
    providerEventId: `receipt:${sessionId}:${message.id}`,
    sourceInstanceId: "opencode-server",
    inputSubmissionId,
    ...(delivery?.invocationId ? { invocationId: delivery.invocationId } : {}),
    nativeMessageId: message.id,
    historyMarker: `session:${sessionId}:message:${message.id}`,
    payload: { sessionId, nativeMessageId: message.id },
  };
}

function turnTerminalFact(sessionId, message, inputSubmissionId, delivery) {
  const failed = isFailedAssistantMessage(message);
  return {
    type: failed ? "opencode.turn.failed" : "opencode.turn.completed",
    providerEventId: `turn:${sessionId}:${message.id}:${message.finish ?? "completed"}`,
    sourceInstanceId: "opencode-server",
    inputSubmissionId,
    ...(delivery?.invocationId ? { invocationId: delivery.invocationId } : {}),
    nativeMessageId: message.id,
    nativeTurnId: message.id,
    payload: { finish: message.finish ?? "completed" },
  };
}

function interruptConfirmedFact(sessionId, message, interrupt) {
  return {
    type: "opencode.interrupt.confirmed",
    providerEventId: `interrupt:${sessionId}:${message.id}`,
    sourceInstanceId: "opencode-server",
    inputSubmissionId: interrupt.inputSubmissionId,
    ...(interrupt.invocationId ? { invocationId: interrupt.invocationId } : {}),
    nativeMessageId: message.id,
    nativeTurnId: message.id,
    payload: { sessionId, nativeMessageId: message.id, reason: "MessageAbortedError" },
  };
}

function unavailableFact(nativeRef) {
  return {
    type: "opencode.binding.unavailable",
    providerEventId: `binding-unavailable:${nativeRef}`,
    sourceInstanceId: "opencode-server",
    payload: { nativeBindingRef: nativeRef },
  };
}

function interruptTerminalFact(sessionId, interrupt) {
  return {
    type: "opencode.native.terminal",
    providerEventId: `interrupt-terminal:${sessionId}:${interrupt.inputSubmissionId}`,
    sourceInstanceId: "opencode-server",
    inputSubmissionId: interrupt.inputSubmissionId,
    ...(interrupt.invocationId ? { invocationId: interrupt.invocationId } : {}),
    payload: { nativeBindingRef: sessionId, reason: "interrupt_observed_idle" },
  };
}

function sessionRevision(session) {
  const updated = session?.time?.updated;
  return Number.isFinite(updated) || typeof updated === "string" ? String(updated) : "unknown";
}

function isSessionActive(statuses, sessionId) {
  return Boolean(statuses && Object.prototype.hasOwnProperty.call(statuses, sessionId));
}

function wasInterruptedAfter(message, requestedAt) {
  const completedAt = message?.completedAt;
  return Number.isFinite(completedAt) && completedAt >= requestedAt;
}

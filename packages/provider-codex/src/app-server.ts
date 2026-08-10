import type {
  ExecutionProfileDefinition,
  ProviderCapability,
  ProviderCapabilities,
  ProviderKind,
} from "../../runtime-contracts/src/index";
import {
  createProtocolGatedProviderAdapter,
  renderProviderSessionBootstrap,
  sha256,
  type NativeProviderFact,
  type EnsureBindingRequest,
  type InterruptRequest,
  type ProtocolPin,
  type ProviderPort,
  type ProviderPortBindingRequest,
  type SubmitDeliveryRequest,
  type ProviderTransport,
  type ProviderTransportOperation,
} from "../../provider-port/src/index";

/**
 * The real Codex App Server is a persistent, bidirectional JSON-RPC protocol.
 * These are intentionally structural interfaces so Runtime Host can own the
 * child process without making this package import an Electron/Host module.
 */
export type CodexAppServerJsonRpcId = string | number;

export type CodexAppServerInboundMessage = Readonly<{
  readonly kind: "notification" | "server_request";
  readonly method: string;
  readonly params: unknown;
  readonly id?: CodexAppServerJsonRpcId;
  readonly emittedAtMs?: number;
}>;

export interface CodexAppServerConnection {
  readonly instanceId: string;
  request<T = unknown>(method: string, params: unknown): Promise<T>;
  events(): AsyncIterable<CodexAppServerInboundMessage>;
  respond(id: CodexAppServerJsonRpcId, result: unknown): Promise<void>;
  close(): Promise<void>;
}

export interface CodexAppServerConnectionInput {
  readonly bindingId: string;
  readonly bindingRevision: number;
  readonly workspace: ProviderPortBindingRequest["workspace"];
  readonly executionProfile: ExecutionProfileDefinition;
  readonly protocol: ProtocolPin;
}

export interface CodexAppServerConnectionFactory {
  /** Starts an authenticated protocol probe and returns only a pinned identity. */
  inspectProtocol(): Promise<ProtocolPin>;
  /** Opens a binding-isolated, already-initialized App Server connection. */
  create(input: CodexAppServerConnectionInput): Promise<CodexAppServerConnection>;
}

/**
 * We have not established safe semantics for native approval, child-agent, or
 * presentation surfaces. This is the maximum capability proof accepted by the
 * first direct adapter; future capabilities require a new version spike.
 */
export const CODEX_APP_SERVER_PROVEN_CORE_CAPABILITIES: readonly ProviderCapability[] = Object.freeze([
  "create_binding",
  "resume_binding",
  "input_correlation",
  "provider_receipt",
  "reconcile",
  "interrupt",
]);

const CODEX_APP_SERVER_OPERATIONS: readonly ProviderTransportOperation[] = Object.freeze([
  "inspect_protocol",
  "ensure_host",
  "ensure_binding",
  "submit_delivery",
  "observe_binding",
  "reconcile_binding",
  "request_interrupt",
  "release_binding",
]);

/**
 * This deliberately supports only a non-escalating first live lane. A future
 * capability spike may add approval mediation or write-capable policy, but it
 * must do so explicitly instead of inheriting a user's Codex defaults.
 */
export interface CodexAppServerSafetyPolicy {
  readonly approvalPolicy: "untrusted";
  readonly sandbox: "read-only";
  readonly networkAccess: false;
}

export interface CodexAppServerProviderAdapterOptions {
  readonly connectionFactory: CodexAppServerConnectionFactory;
  readonly protocol: ProtocolPin;
  readonly safety: CodexAppServerSafetyPolicy;
  /** Evidence-backed subset of the direct App Server core capability set. */
  readonly verifiedCapabilities: readonly ProviderCapability[];
  readonly now?: () => string;
}

/** A ProviderPort with an explicit Host-shutdown hook for owned child processes. */
export interface CodexAppServerProviderPort extends ProviderPort {
  /** Idempotently closes local App Server children; it never archives/deletes a thread. */
  close(): Promise<void>;
}

/**
 * Creates the direct, protocol-gated Codex ProviderPort. Unlike the legacy
 * generic process transport, this preserves one duplex App Server connection
 * for each Binding and turns only native IDs/events into Provider facts.
 */
export function createCodexAppServerProviderAdapter(options: CodexAppServerProviderAdapterOptions): CodexAppServerProviderPort {
  const safety = normalizeSafety(options.safety);
  const verifiedCapabilities = normalizeVerifiedCapabilities(options.verifiedCapabilities);
  const transport = createCodexAppServerTransport({
    connectionFactory: options.connectionFactory,
    protocol: options.protocol,
    safety,
    verifiedCapabilities,
  });
  const base = createProtocolGatedProviderAdapter({
    provider: "codex",
    declaredProtocol: options.protocol,
    capabilities: CODEX_APP_SERVER_PROVEN_CORE_CAPABILITIES,
    transport,
    mapNativeFact: (nativeFact) => nativeFact as NativeProviderFact,
    now: options.now,
  });

  const describeCapabilities = async (profile: ExecutionProfileDefinition): Promise<ProviderCapabilities> => {
    const report = await base.describeCapabilities(profile);
    const safetyReasons = profileSafetyReasons(profile);
    if (safetyReasons.length === 0) return report;
    return Object.freeze({
      ...report,
      available: false,
      unavailableReasons: Object.freeze([...new Set([...report.unavailableReasons, ...safetyReasons])]),
    });
  };
  const ensureProfile = async (profile: ExecutionProfileDefinition): Promise<void> => {
    const report = await describeCapabilities(profile);
    if (!report.available) {
      throw new Error(`codex_execution_profile_unavailable:${report.unavailableReasons.join(",") || "unknown"}`);
    }
  };

  return Object.freeze({
    provider: "codex" as ProviderKind,
    describeCapabilities,
    ensureHost: async (request: ProviderPortBindingRequest) => {
      await ensureProfile(request.executionProfile);
      return base.ensureHost!(request);
    },
    ensureBinding: async (request: EnsureBindingRequest) => {
      await ensureProfile(request.executionProfile);
      return base.ensureBinding(request);
    },
    submitDelivery: async (request: SubmitDeliveryRequest) => {
      await ensureProfile(request.executionProfile);
      return base.submitDelivery(request);
    },
    observeBinding: async function* (request: ProviderPortBindingRequest) {
      await ensureProfile(request.executionProfile);
      yield* base.observeBinding(request);
    },
    reconcileBinding: async (request: ProviderPortBindingRequest) => {
      await ensureProfile(request.executionProfile);
      return base.reconcileBinding(request);
    },
    requestInterrupt: async (request: InterruptRequest) => {
      await ensureProfile(request.executionProfile);
      return base.requestInterrupt(request);
    },
    // No respondAttention/openPresentation surface: neither is proven for this
    // pinned direct adapter, so callers receive an unavailable capability.
    releaseBinding: async (request: ProviderPortBindingRequest) => base.releaseBinding(request),
    close: async () => transport.close(),
  });
}

export interface CodexAppServerTransportOptions {
  readonly connectionFactory: CodexAppServerConnectionFactory;
  readonly protocol: ProtocolPin;
  readonly safety: CodexAppServerSafetyPolicy;
  readonly verifiedCapabilities: readonly ProviderCapability[];
}

/** Host-owned direct transport plus a shutdown hook for all live Binding children. */
export interface CodexAppServerTransport extends ProviderTransport {
  close(): Promise<void>;
}

/** Exposed for Host composition and focused protocol tests. */
export function createCodexAppServerTransport(options: CodexAppServerTransportOptions): CodexAppServerTransport {
  return new CodexAppServerTransportImpl(options);
}

class CodexAppServerTransportImpl implements CodexAppServerTransport {
  readonly supportedOperations = CODEX_APP_SERVER_OPERATIONS;
  readonly verifiedCapabilities: readonly ProviderCapability[];

  readonly #states = new Map<string, BindingState>();
  readonly #opening = new Map<string, Promise<BindingState>>();
  readonly #releasing = new Map<string, Promise<TransportResponse>>();
  readonly #released = new Map<string, string | undefined>();
  readonly #factory: CodexAppServerConnectionFactory;
  readonly #protocol: ProtocolPin;
  readonly #safety: CodexAppServerSafetyPolicy;
  #shutdown: Promise<void> | undefined;

  constructor(options: CodexAppServerTransportOptions) {
    this.#factory = options.connectionFactory;
    this.#protocol = options.protocol;
    this.#safety = normalizeSafety(options.safety);
    this.verifiedCapabilities = normalizeVerifiedCapabilities(options.verifiedCapabilities);
  }

  inspectProtocol(): Promise<ProtocolPin> {
    return this.#factory.inspectProtocol();
  }

  async close(): Promise<void> {
    this.#shutdown ??= this.#closeOwnedConnections();
    return this.#shutdown;
  }

  async request(input: { readonly operation: string; readonly request: unknown }): Promise<TransportResponse> {
    const request = requireBindingRequest(input.request);
    switch (input.operation) {
      case "ensure_host": {
        await this.#stateFor(request);
        return acceptedResponse();
      }
      case "ensure_binding":
        return this.#ensureBinding(request, input.request);
      case "submit_delivery":
        return this.#submitDelivery(request, input.request);
      case "request_interrupt":
        return this.#requestInterrupt(request, input.request);
      case "release_binding":
        return this.#releaseBinding(request);
      default:
        throw new Error(`codex_app_server_operation_unsupported:${input.operation}`);
    }
  }

  async *observe(input: { readonly operation: "observe_binding"; readonly request: ProviderPortBindingRequest }): AsyncIterable<NativeProviderFact> {
    const state = await this.#stateFor(input.request);
    await this.#ensureAttachedForRead(state, input.request);
    yield* state.facts.subscribe();
  }

  async reconcile(input: { readonly operation: "reconcile_binding"; readonly request: ProviderPortBindingRequest }): Promise<readonly NativeProviderFact[]> {
    const request = input.request;
    const state = await this.#stateFor(request);
    const threadId = await this.#ensureAttachedForRead(state, request);
    const threadResponse = await state.connection.request<unknown>("thread/read", {
      threadId,
      // Codex App Server 0.146 exposes durable turn history on the canonical
      // thread snapshot. It does not expose the invented paginated
      // `thread/items/list` / `thread/turns/list` RPC routes used by the old
      // spike, so recovery must use this single native read.
      includeTurns: true,
    });
    const thread = requireThread(threadResponse);
    if (thread.id !== threadId) throw new Error("codex_app_server_thread_identity_mismatch");
    const facts: NativeProviderFact[] = [bindingObservedFact(state, threadId, "reconcile")];
    for (const turn of nativeThreadTurns(thread)) {
      const nativeTurnId = requiredNativeTurnId(turn, "codex_app_server_reconcile_turn_invalid");
      // Process durable user-message records before the turn status so a fresh
      // Host restores input correlation before it emits a terminal fact.
      for (const item of nativeTurnItems(turn)) {
        const fact = inputReceiptFromItem(state, threadId, { turnId: nativeTurnId, item });
        if (fact) facts.push(fact);
      }
      facts.push(...turnFacts(state, threadId, turn, "thread_read"));
    }
    return Object.freeze(facts);
  }

  async #ensureBinding(base: BindingRequest, rawRequest: unknown): Promise<TransportResponse> {
    const request = rawRequest as Record<string, unknown>;
    const disposition = request.disposition;
    if (disposition !== "create" && disposition !== "resume") throw new Error("codex_app_server_binding_disposition_invalid");
    const state = await this.#stateFor(base);
    const threadId = disposition === "create"
      ? await this.#startThread(state, base)
      : await this.#resumeThread(state, base);
    return acceptedResponse(threadId);
  }

  async #submitDelivery(base: BindingRequest, rawRequest: unknown): Promise<TransportResponse> {
    const request = rawRequest as Record<string, unknown>;
    const inputSubmissionId = requiredString(request.inputSubmissionId, "codex_input_submission_id_required");
    const idempotencyKey = requiredString(request.idempotencyKey, "codex_input_idempotency_key_required");
    const content = requiredString(request.content, "codex_input_content_required");
    const invocationId = optionalString(request.invocationId);
    const state = await this.#stateFor(base);
    const threadId = await this.#ensureAttachedForRead(state, base);
    const response = await state.connection.request<unknown>("turn/start", {
      threadId,
      // Codex App Server validates clientUserMessageId as a UUID even though
      // the generated schema exposes it as a string. Runtime IDs are normally
      // `input_<uuid>`; use the UUID payload so the native history remains
      // reversible after a Host restart.
      clientUserMessageId: codexClientUserMessageId(inputSubmissionId),
      // The 0.146 App Server accepts the minimal text variant. Its generated
      // schema advertises an optional `text_elements` field, but the live
      // strict decoder rejects that field; do not send optional UI metadata.
      input: [{ type: "text", text: content }],
    });
    const turn = requireTurn(response);
    state.turns.set(turn.id, { inputSubmissionId, invocationId, active: turn.status === "inProgress" });
    // A returned native turn ID is a Provider fact that proves delivery; the
    // local ProviderEffect remains only a transport acceptance record.
    state.facts.push(inputReceivedFromTurnStart(state, threadId, turn.id, inputSubmissionId, invocationId, idempotencyKey));
    state.facts.push(turnStartedFact(state, threadId, turn.id, inputSubmissionId, invocationId, "turn_start_response"));
    return acceptedResponse(turn.id);
  }

  async #requestInterrupt(base: BindingRequest, rawRequest: unknown): Promise<TransportResponse> {
    const request = rawRequest as Record<string, unknown>;
    requiredString(request.idempotencyKey, "codex_interrupt_idempotency_key_required");
    const invocationId = optionalString(request.invocationId);
    const state = await this.#stateFor(base);
    const threadId = await this.#ensureAttachedForRead(state, base);
    const turnId = activeTurnId(state, invocationId);
    if (!turnId) return { acceptance: "rejected", diagnostic: "codex_active_turn_unknown" };
    await state.connection.request("turn/interrupt", { threadId, turnId });
    // Deliberately do not emit interrupt_confirmed/native_terminal here. Those
    // facts appear only after a native turn/completion observation or reconcile.
    return acceptedResponse(turnId);
  }

  async #releaseBinding(base: BindingRequest): Promise<TransportResponse> {
    const releaseKey = bindingRevisionKey(base);
    if (this.#released.has(releaseKey)) return acceptedResponse(this.#released.get(releaseKey));
    const inFlight = this.#releasing.get(releaseKey);
    if (inFlight) return inFlight;
    const release = this.#releaseOnce(base, releaseKey);
    this.#releasing.set(releaseKey, release);
    try {
      return await release;
    } finally {
      this.#releasing.delete(releaseKey);
    }
  }

  async #releaseOnce(base: BindingRequest, releaseKey: string): Promise<TransportResponse> {
    const state = await this.#stateFor(base);
    const threadId = state.threadId ?? base.nativeBindingRef;
    try {
      if (threadId) await state.connection.request("thread/unsubscribe", { threadId });
    } finally {
      // Record the completed release before closing the child. A retry after an
      // ambiguous caller timeout must not create another App Server merely to
      // unsubscribe the same Binding again.
      this.#released.set(releaseKey, threadId);
      state.closed = true;
      state.facts.close();
      this.#states.delete(base.bindingId);
      await state.connection.close();
    }
    return acceptedResponse(threadId);
  }

  async #stateFor(request: ProviderPortBindingRequest): Promise<BindingState> {
    if (this.#shutdown) throw new Error("codex_app_server_transport_closed");
    const existing = this.#states.get(request.bindingId);
    if (existing && !existing.closed) return existing;
    if (existing?.closed) {
      if (!request.nativeBindingRef) throw new Error("codex_app_server_connection_lost_before_binding_persisted");
      this.#states.delete(request.bindingId);
    }
    const opening = this.#opening.get(request.bindingId);
    if (opening) return opening;
    const pending = this.#openState(request);
    this.#opening.set(request.bindingId, pending);
    try {
      return await pending;
    } finally {
      this.#opening.delete(request.bindingId);
    }
  }

  async #openState(request: ProviderPortBindingRequest): Promise<BindingState> {
    const connection = await this.#factory.create({
      bindingId: request.bindingId,
      bindingRevision: request.bindingRevision,
      workspace: request.workspace,
      executionProfile: request.executionProfile,
      protocol: this.#protocol,
    });
    const state: BindingState = {
      bindingId: request.bindingId,
      bindingRevision: request.bindingRevision,
      connection,
      facts: new NativeFactQueue(),
      ...(request.nativeBindingRef ? { threadId: request.nativeBindingRef } : {}),
      workspaceCwd: request.workspace.cwd,
      attached: false,
      closed: false,
      turns: new Map(),
      emittedAssistantMessageIds: new Set(),
      emittedActivityEventIds: new Set(),
      activitySequences: new Map(),
    };
    this.#states.set(request.bindingId, state);
    void this.#pump(state);
    return state;
  }

  async #closeOwnedConnections(): Promise<void> {
    // The Host is shutting down, not releasing a Binding. In particular, do
    // not call thread/unsubscribe here: native thread retention is a Provider
    // fact/lifecycle concern and must remain recoverable after Host restart.
    const opening = [...this.#opening.values()];
    if (opening.length > 0) await Promise.allSettled(opening);
    const states = [...this.#states.values()];
    this.#states.clear();
    await Promise.allSettled(states.map(async (state) => {
      state.closed = true;
      state.facts.close();
      await state.connection.close();
    }));
  }

  async #startThread(state: BindingState, request: BindingRequest): Promise<string> {
    if (state.attached && state.threadId) return state.threadId;
    if (state.threadId) throw new Error("codex_app_server_create_with_native_binding_ref");
    const response = await state.connection.request<unknown>("thread/start", {
      model: request.executionProfile.model,
      cwd: request.workspace.cwd,
      developerInstructions: renderProviderSessionBootstrap(request.bootstrap),
      approvalPolicy: this.#safety.approvalPolicy,
      sandbox: this.#safety.sandbox,
      ephemeral: false,
    });
    const thread = requireThread(response);
    if (thread.canAcceptDirectInput === false) throw new Error("codex_app_server_thread_direct_input_unavailable");
    state.threadId = thread.id;
    state.attached = true;
    state.facts.push(bindingObservedFact(state, thread.id, "thread_start_response"));
    return thread.id;
  }

  async #resumeThread(state: BindingState, request: BindingRequest): Promise<string> {
    if (state.attached && state.threadId) return state.threadId;
    const threadId = request.nativeBindingRef ?? state.threadId;
    if (!threadId) throw new Error("codex_app_server_resume_native_binding_ref_required");
    const response = await state.connection.request<unknown>("thread/resume", {
      threadId,
      cwd: request.workspace.cwd,
      approvalPolicy: this.#safety.approvalPolicy,
      sandbox: this.#safety.sandbox,
      model: request.executionProfile.model,
    });
    const thread = requireThread(response);
    if (thread.id !== threadId) throw new Error("codex_app_server_resume_identity_mismatch");
    if (thread.canAcceptDirectInput === false) throw new Error("codex_app_server_thread_direct_input_unavailable");
    state.threadId = thread.id;
    state.attached = true;
    state.facts.push(bindingObservedFact(state, thread.id, "thread_resume_response"));
    return thread.id;
  }

  async #ensureAttachedForRead(state: BindingState, request: ProviderPortBindingRequest): Promise<string> {
    if (state.attached && state.threadId) return state.threadId;
    return this.#resumeThread(state, requireBindingRequest(request));
  }

  async #pump(state: BindingState): Promise<void> {
    try {
      for await (const inbound of state.connection.events()) {
        const facts = await this.#factsFromInbound(state, inbound);
        for (const fact of facts) state.facts.push(fact);
      }
    } catch {
      state.facts.push({
        kind: "transport_unknown",
        sourceInstanceId: state.connection.instanceId,
        cursor: "connection_closed",
        payload: { reason: "codex_app_server_connection_closed" },
      });
    } finally {
      state.closed = true;
      state.facts.close();
    }
  }

  async #factsFromInbound(state: BindingState, inbound: CodexAppServerInboundMessage): Promise<readonly NativeProviderFact[]> {
    if (inbound.kind === "server_request") {
      await declineUnsupportedServerRequest(state, inbound);
      return Object.freeze([]);
    }
    const params = asRecord(inbound.params);
    if (!params) return Object.freeze([]);
    const threadId = notificationThreadId(params);
    if (threadId && state.threadId && threadId !== state.threadId) return Object.freeze([]);
    switch (inbound.method) {
      case "thread/started": {
        const nativeThreadId = threadId;
        if (!nativeThreadId) return Object.freeze([]);
        state.threadId ??= nativeThreadId;
        state.attached = true;
        return Object.freeze([bindingObservedFact(state, nativeThreadId, "thread_started_notification")]);
      }
      case "turn/started": {
        const turn = asRecord(params.turn);
        const nativeTurnId = optionalString(turn?.id);
        if (!threadId || !nativeTurnId) return Object.freeze([]);
        const known = state.turns.get(nativeTurnId);
        state.turns.set(nativeTurnId, { ...known, active: true });
        return Object.freeze([turnStartedFact(state, threadId, nativeTurnId, known?.inputSubmissionId, known?.invocationId, "turn_started_notification")]);
      }
      case "turn/completed": {
        const turn = asRecord(params.turn);
        const nativeTurnId = optionalString(turn?.id);
        if (!threadId || !nativeTurnId || !turn) return Object.freeze([]);
        return Object.freeze(turnFacts(state, threadId, turn, "turn_completed_notification"));
      }
      case "item/started":
      case "item/completed": {
        if (!threadId) return Object.freeze([]);
        const facts: NativeProviderFact[] = [];
        const receipt = inputReceiptFromItem(state, threadId, params);
        if (receipt) facts.push(receipt);
        const activity = activityFromItem(
          state,
          threadId,
          params,
          inbound.method === "item/started" ? "started" : "completed",
          inbound.method === "item/started" ? "item_started_notification" : "item_completed_notification",
        );
        if (activity) facts.push(activity);
        if (inbound.method === "item/completed") {
          const assistantFinal = assistantFinalFromItem(state, threadId, params, "item_completed_notification");
          if (assistantFinal) facts.push(assistantFinal);
        }
        return Object.freeze(facts);
      }
      case "item/agentMessage/delta":
        return Object.freeze(optionalFact(activityFromDelta(state, threadId, params, "assistant_progress", "Assistant response")));
      case "item/commandExecution/outputDelta":
        return Object.freeze(optionalFact(activityFromDelta(state, threadId, params, "tool", "Shell command")));
      case "item/mcpToolCall/progress":
        return Object.freeze(optionalFact(activityFromDelta(state, threadId, params, "tool", "MCP tool", "message")));
      case "item/fileChange/outputDelta":
        return Object.freeze(optionalFact(activityFromDelta(state, threadId, params, "change", "File changes")));
      case "item/fileChange/patchUpdated":
        return Object.freeze(optionalFact(activityFromFileChangeUpdate(state, threadId, params)));
      default:
        // Native children and presentation events remain unavailable until
        // independently proven. Supported human-only activity is reduced to
        // the bounded Provider activity contract above; raw payloads never pass.
        return Object.freeze([]);
    }
  }

}

type BindingRequest = ProviderPortBindingRequest & Readonly<{
  readonly bindingId: string;
  readonly bindingRevision: number;
}>;

type TurnCorrelation = Readonly<{
  readonly inputSubmissionId?: string;
  readonly invocationId?: string;
  readonly active?: boolean;
  readonly agentMessages?: readonly AgentMessageCandidate[];
}>;

type AgentMessageCandidate = Readonly<{
  readonly nativeMessageId: string;
  readonly content: string;
  readonly phase?: "commentary" | "final_answer";
}>;

type ProviderActivityCategory = "assistant_progress" | "tool" | "change" | "web";
type ProviderActivityPhase = "started" | "progress" | "completed" | "failed";
type ActivityItemObservation = "started" | "completed" | "snapshot";

type ActivityDescriptor = Readonly<{
  readonly nativeItemId: string;
  readonly category: ProviderActivityCategory;
  readonly phase: ProviderActivityPhase;
  readonly title: string;
  readonly detail?: string;
  readonly content?: string;
  readonly updateMode?: "append" | "replace";
}>;

type ActivityFactOptions = Readonly<{
  readonly fixedSequence?: number;
  readonly reconciliationSnapshot?: boolean;
}>;

type NativeThread = Record<string, unknown> & Readonly<{
  readonly id: string;
  readonly canAcceptDirectInput?: boolean;
}>;

type NativeTurn = Record<string, unknown> & Readonly<{
  readonly id: string;
  readonly status?: string;
}>;

type BindingState = {
  readonly bindingId: string;
  readonly bindingRevision: number;
  readonly connection: CodexAppServerConnection;
  readonly facts: NativeFactQueue;
  readonly turns: Map<string, TurnCorrelation>;
  readonly emittedAssistantMessageIds: Set<string>;
  readonly emittedActivityEventIds: Set<string>;
  readonly activitySequences: Map<string, number>;
  readonly workspaceCwd: string;
  threadId?: string;
  attached: boolean;
  closed: boolean;
};

type TransportResponse = Readonly<{
  readonly acceptance: "accepted" | "rejected" | "unknown";
  readonly transportRequestId?: string;
  readonly diagnostic?: string;
}>;

function acceptedResponse(transportRequestId?: string): TransportResponse {
  return Object.freeze({ acceptance: "accepted", ...(transportRequestId ? { transportRequestId } : {}) });
}

function bindingObservedFact(state: BindingState, threadId: string, _observationSource: string): NativeProviderFact {
  return {
    kind: "binding_observed",
    providerEventId: `codex:thread:${threadId}:binding`,
    sourceInstanceId: state.connection.instanceId,
    payload: { nativeBindingRef: threadId, nativeThreadId: threadId },
  };
}

function inputReceivedFromTurnStart(
  state: BindingState,
  threadId: string,
  turnId: string,
  inputSubmissionId: string,
  invocationId: string | undefined,
  idempotencyKey: string,
): NativeProviderFact {
  return {
    kind: "input_received",
    providerEventId: `codex:thread:${threadId}:turn:${turnId}:input:${inputSubmissionId}`,
    sourceInstanceId: state.connection.instanceId,
    inputSubmissionId,
    ...(invocationId ? { invocationId } : {}),
    nativeTurnId: turnId,
    payload: { nativeThreadId: threadId, nativeTurnId: turnId, idempotencyKey },
  };
}

function turnStartedFact(
  state: BindingState,
  threadId: string,
  turnId: string,
  inputSubmissionId: string | undefined,
  invocationId: string | undefined,
  _observationSource: string,
): NativeProviderFact {
  return {
    kind: "turn_started",
    providerEventId: `codex:thread:${threadId}:turn:${turnId}:started`,
    sourceInstanceId: state.connection.instanceId,
    ...(inputSubmissionId ? { inputSubmissionId } : {}),
    ...(invocationId ? { invocationId } : {}),
    nativeTurnId: turnId,
    payload: { nativeThreadId: threadId, nativeTurnId: turnId },
  };
}

function activityFromItem(
  state: BindingState,
  threadId: string,
  entry: Record<string, unknown>,
  observation: ActivityItemObservation,
  source: string,
  terminalTurnStatus?: string,
): NativeProviderFact | undefined {
  const turnId = optionalString(entry.turnId);
  const item = asRecord(entry.item) ?? (optionalString(entry.type) ? entry : undefined);
  if (!turnId || !item) return undefined;
  const descriptor = describeActivityItem(state, item, observation, terminalTurnStatus);
  if (!descriptor) return undefined;
  return activityObservedFact(state, threadId, turnId, descriptor, source, observation === "snapshot"
    ? { fixedSequence: 0, reconciliationSnapshot: source === "thread_read" }
    : undefined);
}

function activityFromDelta(
  state: BindingState,
  threadId: string | undefined,
  params: Record<string, unknown>,
  category: ProviderActivityCategory,
  title: string,
  contentField = "delta",
): NativeProviderFact | undefined {
  const turnId = optionalString(params.turnId);
  const nativeItemId = optionalString(params.itemId);
  const content = sanitizeDisplayText(params[contentField], state.workspaceCwd, ACTIVITY_CONTENT_LIMIT, true);
  if (!threadId || !turnId || !nativeItemId || content === undefined) return undefined;
  return activityObservedFact(state, threadId, turnId, {
    nativeItemId,
    category,
    phase: "progress",
    title,
    content,
    updateMode: "append",
  }, `${contentField}_notification`);
}

function activityFromFileChangeUpdate(
  state: BindingState,
  threadId: string | undefined,
  params: Record<string, unknown>,
): NativeProviderFact | undefined {
  const turnId = optionalString(params.turnId);
  const nativeItemId = optionalString(params.itemId);
  if (!threadId || !turnId || !nativeItemId) return undefined;
  const changeCount = Array.isArray(params.changes) ? params.changes.length : 0;
  return activityObservedFact(state, threadId, turnId, {
    nativeItemId,
    category: "change",
    phase: "progress",
    title: "File changes",
    detail: `${changeCount} file change${changeCount === 1 ? "" : "s"} prepared`,
    updateMode: "replace",
  }, "patch_updated_notification");
}

function describeActivityItem(
  state: BindingState,
  item: Record<string, unknown>,
  observation: ActivityItemObservation,
  terminalTurnStatus?: string,
): ActivityDescriptor | undefined {
  const nativeItemId = optionalString(item.id);
  const type = optionalString(item.type);
  if (!nativeItemId || !type) return undefined;
  const phase = activityPhase(item, observation, terminalTurnStatus);
  const updateMode = "replace" as const;
  switch (type) {
    case "agentMessage": {
      const messagePhase = item.phase === "commentary" || item.phase === "final_answer" ? item.phase : undefined;
      const content = sanitizeDisplayText(item.text, state.workspaceCwd, ACTIVITY_CONTENT_LIMIT, true);
      return {
        nativeItemId,
        category: "assistant_progress",
        phase,
        title: messagePhase === "commentary" ? "Assistant progress" : "Assistant response",
        ...(content !== undefined ? { content } : {}),
        updateMode,
      };
    }
    case "commandExecution": {
      const command = sanitizeDisplayText(item.command, state.workspaceCwd, ACTIVITY_DETAIL_LIMIT);
      const statusDetail = commandStatusDetail(item);
      const detail = boundedJoin([
        command ? `Command: ${command}` : undefined,
        statusDetail,
      ], " · ", ACTIVITY_DETAIL_LIMIT);
      const content = sanitizeDisplayText(item.aggregatedOutput, state.workspaceCwd, ACTIVITY_CONTENT_LIMIT, true);
      return {
        nativeItemId,
        category: "tool",
        phase,
        title: "Shell command",
        ...(detail ? { detail } : {}),
        ...(content !== undefined ? { content } : {}),
        updateMode,
      };
    }
    case "fileChange": {
      const changeCount = Array.isArray(item.changes) ? item.changes.length : 0;
      const status = optionalString(item.status);
      return {
        nativeItemId,
        category: "change",
        phase,
        title: "File changes",
        detail: boundedJoin([
          `${changeCount} file change${changeCount === 1 ? "" : "s"}`,
          status ? `Status: ${safeActivityLabel(status, state.workspaceCwd, 80)}` : undefined,
        ], " · ", ACTIVITY_DETAIL_LIMIT),
        updateMode,
      };
    }
    case "mcpToolCall": {
      const server = safeActivityLabel(item.server, state.workspaceCwd, 72);
      const tool = safeActivityLabel(item.tool, state.workspaceCwd, 72);
      const label = [server, tool].filter(Boolean).join(" / ");
      const status = safeActivityLabel(item.status, state.workspaceCwd, 80);
      return {
        nativeItemId,
        category: "tool",
        phase,
        title: truncateDisplay(label ? `MCP · ${label}` : "MCP tool", ACTIVITY_TITLE_LIMIT),
        ...(status ? { detail: `Status: ${status}` } : {}),
        updateMode,
      };
    }
    case "dynamicToolCall": {
      const namespace = safeActivityLabel(item.namespace, state.workspaceCwd, 72);
      const tool = safeActivityLabel(item.tool, state.workspaceCwd, 72);
      const label = [namespace, tool].filter(Boolean).join(" / ");
      const status = optionalString(item.status);
      return {
        nativeItemId,
        category: "tool",
        phase,
        title: truncateDisplay(label ? `Tool · ${label}` : "Dynamic tool", ACTIVITY_TITLE_LIMIT),
        detail: boundedJoin([
          status ? `Status: ${safeActivityLabel(status, state.workspaceCwd, 80)}` : undefined,
          typeof item.success === "boolean" ? `Success: ${String(item.success)}` : undefined,
        ], " · ", ACTIVITY_DETAIL_LIMIT),
        updateMode,
      };
    }
    case "webSearch": {
      const query = sanitizeDisplayText(item.query, state.workspaceCwd, ACTIVITY_DETAIL_LIMIT);
      return {
        nativeItemId,
        category: "web",
        phase,
        title: "Web search",
        ...(query ? { detail: `Query: ${truncateDisplay(query, ACTIVITY_DETAIL_LIMIT - "Query: ".length)}` } : {}),
        updateMode,
      };
    }
    default:
      return undefined;
  }
}

function activityPhase(
  item: Record<string, unknown>,
  observation: ActivityItemObservation,
  terminalTurnStatus?: string,
): ProviderActivityPhase {
  if (observation === "started") return "started";
  const status = optionalString(item.status);
  if (status === "failed" || status === "declined" || item.success === false) return "failed";
  if (observation === "snapshot" && (status === "inProgress" || (!status && terminalTurnStatus === "inProgress"))) return "started";
  if ((terminalTurnStatus === "failed" || terminalTurnStatus === "interrupted") && status === "inProgress") return "failed";
  return "completed";
}

function activityObservedFact(
  state: BindingState,
  threadId: string,
  turnId: string,
  descriptor: ActivityDescriptor,
  source: string,
  options: ActivityFactOptions = {},
): NativeProviderFact | undefined {
  const correlation = state.turns.get(turnId);
  if (!correlation?.inputSubmissionId && !correlation?.invocationId) return undefined;
  const activityId = activityIdFor(state, turnId, descriptor.nativeItemId);
  const sequence = options.fixedSequence ?? nextActivitySequence(state, activityId);
  const payload = {
    schemaVersion: 1,
    activityId,
    category: descriptor.category,
    phase: descriptor.phase,
    title: truncateDisplay(descriptor.title, ACTIVITY_TITLE_LIMIT),
    ...(descriptor.detail ? { detail: truncateDisplay(descriptor.detail, ACTIVITY_DETAIL_LIMIT) } : {}),
    ...(descriptor.content !== undefined ? { content: truncateDisplay(descriptor.content, ACTIVITY_CONTENT_LIMIT) } : {}),
    ...(descriptor.updateMode ? { updateMode: descriptor.updateMode } : {}),
    sequence,
  } as const;
  const progressCursor = !options.reconciliationSnapshot && descriptor.phase === "progress"
    ? `activity:${activityId}:progress:${sequence}`
    : undefined;
  const providerEventId = options.reconciliationSnapshot || progressCursor
    ? undefined
    : `codex:thread:${threadId}:turn:${turnId}:activity:${activityId}:${descriptor.phase}`;
  const reconciliationWatermark = options.reconciliationSnapshot
    ? `codex:thread:${threadId}:turn:${turnId}:activity:${activityId}:snapshot`
    : undefined;
  // Stream deltas only have connection-local order; using sourceInstanceId +
  // cursor prevents a Host restart from dropping new chunks whose sequence
  // restarts at zero. Live started/completed facts retain native-stable IDs.
  // A thread/read replace snapshot uses a stable watermark; the generic
  // Provider dedup key adds a digest of this already-sanitized payload, so an
  // identical replay is idempotent while recovered partial content can grow.
  const eventIdentity = providerEventId
    ?? (reconciliationWatermark ? `${reconciliationWatermark}:${sha256(payload)}` : `${state.connection.instanceId}:${progressCursor}`);
  if (source !== "thread_read" && state.emittedActivityEventIds.has(eventIdentity)) return undefined;
  if (source !== "thread_read") state.emittedActivityEventIds.add(eventIdentity);
  return {
    kind: "activity_observed",
    ...(providerEventId ? { providerEventId } : {}),
    sourceInstanceId: state.connection.instanceId,
    ...(progressCursor ? { cursor: progressCursor } : {}),
    ...(reconciliationWatermark ? { reconciliationWatermark } : {}),
    ...(correlation.inputSubmissionId ? { inputSubmissionId: correlation.inputSubmissionId } : {}),
    ...(correlation.invocationId ? { invocationId: correlation.invocationId } : {}),
    nativeMessageId: descriptor.nativeItemId,
    nativeTurnId: turnId,
    payload,
  };
}

function activityIdFor(state: BindingState, turnId: string, nativeItemId: string): string {
  const digest = sha256({ provider: "codex", bindingId: state.bindingId, turnId, nativeItemId });
  return `activity_${digest.slice("sha256:".length, "sha256:".length + 32)}`;
}

function nextActivitySequence(state: BindingState, activityId: string): number {
  const sequence = state.activitySequences.get(activityId) ?? 0;
  state.activitySequences.set(activityId, sequence + 1);
  return sequence;
}

function commandStatusDetail(item: Record<string, unknown>): string | undefined {
  const status = optionalString(item.status);
  const exitCode = typeof item.exitCode === "number" && Number.isSafeInteger(item.exitCode) ? item.exitCode : undefined;
  const durationMs = typeof item.durationMs === "number" && Number.isSafeInteger(item.durationMs) && item.durationMs >= 0
    ? item.durationMs
    : undefined;
  return boundedJoin([
    status ? `Status: ${status}` : undefined,
    exitCode !== undefined ? `Exit: ${exitCode}` : undefined,
    durationMs !== undefined ? `Duration: ${durationMs} ms` : undefined,
  ], " · ", 240);
}

function safeActivityLabel(value: unknown, workspaceCwd: string, maxLength: number): string | undefined {
  const sanitized = sanitizeDisplayText(value, workspaceCwd, maxLength);
  return sanitized ? truncateDisplay(sanitized.replace(/\s+/gu, " ").trim(), maxLength) : undefined;
}

function sanitizeDisplayText(
  value: unknown,
  workspaceCwd: string,
  maxLength: number,
  allowBlank = false,
): string | undefined {
  if (typeof value !== "string" || (!allowBlank && !value.trim())) return undefined;
  const scanLimit = Math.max(maxLength, maxLength * 4);
  const boundedInput = value.length > scanLimit ? `${value.slice(0, scanLimit)}\n… [truncated]` : value;
  let sanitized = boundedInput.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "�");
  const normalizedCwd = workspaceCwd.replace(/[\\/]+$/u, "");
  if (normalizedCwd.length > 1) sanitized = sanitized.replaceAll(normalizedCwd, "[workspace]");
  sanitized = sanitized
    .replace(/-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\r\n]*PRIVATE KEY-----/gu, "[redacted private key]")
    .replace(/-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*/gu, "[redacted private key]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/giu, "Bearer [redacted]")
    .replace(/\b([A-Za-z0-9_]{0,80}(?:TOKEN|SECRET|PASSWORD|PASSWD|API[_-]?KEY|AUTHORIZATION|COOKIE|CREDENTIAL)[A-Za-z0-9_]{0,80})\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/giu, "$1=[redacted]")
    .replace(/((?:--)?(?:api[-_]?key|token|secret|password|passwd|auth(?:orization)?|cookie|credential)\s+)(?:"[^"]*"|'[^']*'|[^\s,;]+)/giu, "$1[redacted]")
    .replace(/(["'](?:api[-_]?key|token|secret|password|passwd|authorization|cookie|credential)["']\s*:\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+)/giu, "$1[redacted]")
    .replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]{8,}|github_pat_[A-Za-z0-9_]{8,})\b/gu, "[redacted]")
    .replace(/\bAKIA[A-Z0-9]{16}\b/gu, "[redacted]")
    .replace(/([a-z][a-z0-9+.-]{0,31}:\/\/)([^/\s:@]+):([^@\s/]+)@/giu, "$1[redacted]@")
    .replace(/\b(?:ses|msg|prt|call|evt)_[A-Za-z0-9_-]{6,}\b/gu, "[redacted-id]")
    .replace(/\/(?:Users|home|private|tmp|var|Volumes|etc|opt|root|srv|mnt)\/[^\s"'`]+/gu, "[path]")
    .replace(/\b[A-Za-z]:[\\/][^\s"'`]+/gu, "[path]");
  return truncateDisplay(sanitized, maxLength);
}

function boundedJoin(values: readonly (string | undefined)[], separator: string, maxLength: number): string | undefined {
  const joined = values.filter((value): value is string => Boolean(value)).join(separator);
  return joined ? truncateDisplay(joined, maxLength) : undefined;
}

function truncateDisplay(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  const suffix = "\n… [truncated]";
  return `${value.slice(0, Math.max(0, maxLength - suffix.length))}${suffix}`;
}

function optionalFact(fact: NativeProviderFact | undefined): readonly NativeProviderFact[] {
  return fact ? [fact] : [];
}

const ACTIVITY_TITLE_LIMIT = 160;
const ACTIVITY_DETAIL_LIMIT = 2_000;
const ACTIVITY_CONTENT_LIMIT = 16_000;

function inputReceiptFromItem(state: BindingState, threadId: string, entry: Record<string, unknown>): NativeProviderFact | undefined {
  const item = asRecord(entry.item) ?? (entry.type === "userMessage" ? entry : undefined);
  if (!item || item.type !== "userMessage") return undefined;
  const inputSubmissionId = runtimeInputSubmissionIdFromCodexClientId(optionalString(item.clientId));
  const nativeMessageId = optionalString(item.id);
  if (!inputSubmissionId || !nativeMessageId) return undefined;
  const turnId = optionalString(entry.turnId);
  const correlation = turnId ? rememberTurnInput(state, turnId, inputSubmissionId) : undefined;
  return {
    kind: "input_received",
    providerEventId: `codex:thread:${threadId}:item:${nativeMessageId}:input_received`,
    sourceInstanceId: state.connection.instanceId,
    inputSubmissionId,
    ...(correlation?.invocationId ? { invocationId: correlation.invocationId } : {}),
    nativeMessageId,
    ...(turnId ? { nativeTurnId: turnId } : {}),
    payload: { nativeThreadId: threadId, nativeMessageId, ...(turnId ? { nativeTurnId: turnId } : {}) },
  };
}

function assistantFinalFromItem(
  state: BindingState,
  threadId: string,
  entry: Record<string, unknown>,
  source: string,
): NativeProviderFact | undefined {
  const turnId = optionalString(entry.turnId);
  const candidate = agentMessageCandidate(entry);
  if (!turnId || !candidate) return undefined;
  const correlation = rememberAgentMessage(state, turnId, candidate);
  if (candidate.phase !== "final_answer" || state.emittedAssistantMessageIds.has(candidate.nativeMessageId)) return undefined;
  const fact = assistantFinalFact(state, threadId, turnId, correlation, candidate, source);
  if (fact) state.emittedAssistantMessageIds.add(candidate.nativeMessageId);
  return fact;
}

function agentMessageCandidate(entry: Record<string, unknown>): AgentMessageCandidate | undefined {
  const item = asRecord(entry.item) ?? (entry.type === "agentMessage" ? entry : undefined);
  if (!item || item.type !== "agentMessage") return undefined;
  const nativeMessageId = optionalString(item.id);
  const content = optionalString(item.text);
  const phase = item.phase === "commentary" || item.phase === "final_answer" ? item.phase : undefined;
  if (!nativeMessageId || !content) return undefined;
  return Object.freeze({ nativeMessageId, content, ...(phase ? { phase } : {}) });
}

function rememberAgentMessage(
  state: BindingState,
  turnId: string,
  candidate: AgentMessageCandidate,
): TurnCorrelation {
  const existing = state.turns.get(turnId);
  const agentMessages = [
    ...(existing?.agentMessages ?? []).filter((message) => message.nativeMessageId !== candidate.nativeMessageId),
    candidate,
  ];
  const correlation: TurnCorrelation = {
    ...existing,
    agentMessages: Object.freeze(agentMessages),
  };
  state.turns.set(turnId, correlation);
  return correlation;
}

function assistantFinalFact(
  state: BindingState,
  threadId: string,
  turnId: string,
  correlation: TurnCorrelation,
  candidate: AgentMessageCandidate,
  _observationSource: string,
): NativeProviderFact | undefined {
  if (!correlation.inputSubmissionId && !correlation.invocationId) return undefined;
  return {
    kind: "assistant_final",
    providerEventId: `codex:thread:${threadId}:turn:${turnId}:item:${candidate.nativeMessageId}:assistant_final`,
    sourceInstanceId: state.connection.instanceId,
    ...(correlation.inputSubmissionId ? { inputSubmissionId: correlation.inputSubmissionId } : {}),
    ...(correlation.invocationId ? { invocationId: correlation.invocationId } : {}),
    nativeMessageId: candidate.nativeMessageId,
    nativeTurnId: turnId,
    payload: {
      content: candidate.content,
      nativeThreadId: threadId,
      nativeTurnId: turnId,
      nativeMessageId: candidate.nativeMessageId,
      phase: candidate.phase ?? "unknown",
    },
  };
}

/**
 * The user-message records embedded in `thread/read(includeTurns: true)` are
 * the durable join between Codex's native turn and Runtime's client input ID.
 * A fresh Host process has no in-memory turn map, so retain this relation
 * before reducing the native turn status. Runtime later restores Invocation ID
 * from its own durable input map.
 */
function rememberTurnInput(state: BindingState, turnId: string, inputSubmissionId: string): TurnCorrelation {
  const existing = state.turns.get(turnId);
  const correlation: TurnCorrelation = {
    ...existing,
    inputSubmissionId: existing?.inputSubmissionId ?? inputSubmissionId,
  };
  state.turns.set(turnId, correlation);
  return correlation;
}

function turnFacts(state: BindingState, threadId: string, turn: Record<string, unknown>, source: string): NativeProviderFact[] {
  const turnId = optionalString(turn.id);
  const status = optionalString(turn.status);
  if (!turnId || !status) return [];
  const items = turn.items === undefined ? [] : nativeTurnItems(turn);
  for (const item of items) {
    const candidate = agentMessageCandidate(item);
    if (candidate) rememberAgentMessage(state, turnId, candidate);
  }
  const correlation = state.turns.get(turnId);
  state.turns.set(turnId, { ...correlation, active: status === "inProgress" });
  const activityFacts = items.flatMap((item) => optionalFact(activityFromItem(
    state,
    threadId,
    { ...item, turnId },
    "snapshot",
    source,
    status,
  )));
  if (status === "inProgress") {
    return [...activityFacts, turnStartedFact(state, threadId, turnId, correlation?.inputSubmissionId, correlation?.invocationId, source)];
  }
  const shared = {
    providerEventId: `codex:thread:${threadId}:turn:${turnId}:${status}`,
    sourceInstanceId: state.connection.instanceId,
    ...(correlation?.inputSubmissionId ? { inputSubmissionId: correlation.inputSubmissionId } : {}),
    ...(correlation?.invocationId ? { invocationId: correlation.invocationId } : {}),
    nativeTurnId: turnId,
  };
  if (status === "completed") {
    const facts: NativeProviderFact[] = [...activityFacts];
    const agentMessages = correlation?.agentMessages ?? [];
    const candidate = agentMessages.filter((message) => message.phase === "final_answer").at(-1)
      ?? agentMessages.filter((message) => message.phase !== "commentary").at(-1);
    if (candidate && (source === "thread_read" || !state.emittedAssistantMessageIds.has(candidate.nativeMessageId))) {
      const assistantFinal = assistantFinalFact(state, threadId, turnId, correlation ?? {}, candidate, source);
      if (assistantFinal) {
        facts.push(assistantFinal);
        state.emittedAssistantMessageIds.add(candidate.nativeMessageId);
      }
    }
    facts.push({
      kind: "turn_completed",
      ...shared,
      payload: { result: { nativeThreadId: threadId, nativeTurnId: turnId, status } },
    });
    return facts;
  }
  if (status === "failed") {
    return [...activityFacts, { kind: "turn_failed", ...shared, payload: { nativeThreadId: threadId, nativeTurnId: turnId, status } }];
  }
  if (status === "interrupted") {
    return [
      ...activityFacts,
      { kind: "interrupt_confirmed", ...shared, payload: { nativeThreadId: threadId, nativeTurnId: turnId, status } },
      {
        kind: "native_terminal",
        ...shared,
        providerEventId: `codex:thread:${threadId}:turn:${turnId}:native_terminal`,
        payload: { nativeThreadId: threadId, nativeTurnId: turnId, status },
      },
    ];
  }
  return [...activityFacts, {
    kind: "transport_unknown",
    ...shared,
    payload: { nativeThreadId: threadId, nativeTurnId: turnId, status, reason: "codex_turn_status_unrecognized" },
  }];
}

function activeTurnId(state: BindingState, invocationId: string | undefined): string | undefined {
  const candidates = [...state.turns.entries()].filter(([, correlation]) => correlation.active);
  if (invocationId) return candidates.find(([, correlation]) => correlation.invocationId === invocationId)?.[0];
  return candidates.at(-1)?.[0];
}

async function declineUnsupportedServerRequest(state: BindingState, inbound: CodexAppServerInboundMessage): Promise<void> {
  if (inbound.id === undefined) return;
  const result = safeDeclineResult(inbound.method);
  try {
    await state.connection.respond(inbound.id, result);
  } catch {
    state.facts.push({
      kind: "transport_unknown",
      sourceInstanceId: state.connection.instanceId,
      cursor: `server_request:${String(inbound.id)}:response_failed`,
      payload: { reason: "codex_app_server_attention_unsupported", method: inbound.method },
    });
  }
}

function safeDeclineResult(method: string): Record<string, unknown> {
  switch (method) {
    case "item/commandExecution/requestApproval":
    case "item/fileChange/requestApproval":
      return { decision: "decline" };
    case "item/tool/requestUserInput":
      return { answers: {} };
    case "mcpServer/elicitation/request":
      return { action: "decline", content: null, _meta: null };
    case "item/permissions/requestApproval":
      return { permissions: {}, scope: "turn" };
    case "item/tool/call":
      return { success: false, contentItems: [] };
    default:
      return { decision: "decline" };
  }
}

function notificationThreadId(params: Record<string, unknown>): string | undefined {
  return optionalString(params.threadId) ?? optionalString(asRecord(params.thread)?.id);
}

function requireThread(response: unknown): NativeThread {
  const record = asRecord(response);
  const thread = asRecord(record?.thread);
  const id = optionalString(thread?.id);
  if (!thread || !id) throw new Error("codex_app_server_thread_response_invalid");
  return Object.freeze({ ...thread, id, ...(thread.canAcceptDirectInput === false ? { canAcceptDirectInput: false } : {}) });
}

function requireTurn(response: unknown): NativeTurn {
  const record = asRecord(response);
  const turn = asRecord(record?.turn);
  const id = optionalString(turn?.id);
  if (!turn || !id) throw new Error("codex_app_server_turn_response_invalid");
  const status = optionalString(turn.status);
  return Object.freeze({ ...turn, id, ...(status ? { status } : {}) });
}

function nativeThreadTurns(thread: NativeThread): readonly Record<string, unknown>[] {
  const turns = thread.turns;
  if (!Array.isArray(turns) || !turns.every((turn) => asRecord(turn))) {
    throw new Error("codex_app_server_reconcile_turns_invalid");
  }
  return Object.freeze(turns as Record<string, unknown>[]);
}

function requiredNativeTurnId(turn: Record<string, unknown>, code: string): string {
  const turnId = optionalString(turn.id);
  if (!turnId) throw new Error(code);
  return turnId;
}

function nativeTurnItems(turn: Record<string, unknown>): readonly Record<string, unknown>[] {
  const items = turn.items;
  if (!Array.isArray(items) || !items.every((item) => asRecord(item))) {
    throw new Error("codex_app_server_reconcile_items_invalid");
  }
  return Object.freeze(items as Record<string, unknown>[]);
}

function bindingRevisionKey(request: BindingRequest): string {
  return `${request.bindingId}:${request.bindingRevision}`;
}

function requireBindingRequest(value: unknown): BindingRequest {
  const request = value as ProviderPortBindingRequest;
  if (!request || typeof request !== "object") throw new Error("codex_app_server_binding_request_invalid");
  requiredString(request.bindingId, "codex_binding_id_required");
  if (!Number.isSafeInteger(request.bindingRevision) || request.bindingRevision < 1) throw new Error("codex_binding_revision_invalid");
  requiredString(request.workspace?.workspaceId, "codex_workspace_id_required");
  requiredString(request.workspace?.cwd, "codex_workspace_cwd_required");
  return request as BindingRequest;
}

function normalizeSafety(value: CodexAppServerSafetyPolicy): CodexAppServerSafetyPolicy {
  if (!value || value.approvalPolicy !== "untrusted" || value.sandbox !== "read-only" || value.networkAccess !== false) {
    throw new Error("codex_app_server_safety_policy_invalid");
  }
  return Object.freeze({ approvalPolicy: "untrusted", sandbox: "read-only", networkAccess: false });
}

function normalizeVerifiedCapabilities(value: readonly ProviderCapability[]): readonly ProviderCapability[] {
  if (!Array.isArray(value)) throw new Error("codex_app_server_verified_capabilities_required");
  const allowed = new Set(CODEX_APP_SERVER_PROVEN_CORE_CAPABILITIES);
  const normalized = [...new Set(value)];
  if (normalized.some((capability) => !allowed.has(capability))) {
    throw new Error("codex_app_server_capability_not_proven");
  }
  return Object.freeze(normalized);
}

function profileSafetyReasons(profile: ExecutionProfileDefinition): readonly string[] {
  const reasons: string[] = [];
  if (profile.capabilityPolicy.allowedTools.length > 0) reasons.push("codex_tool_allowlist_unproven");
  if (profile.capabilityPolicy.permissionMode !== "deny") reasons.push("codex_permission_mode_unproven");
  return reasons;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function requiredString(value: unknown, code: string): string {
  const normalized = optionalString(value);
  if (!normalized) throw new Error(code);
  return normalized;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

const UUID_SUFFIX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function codexClientUserMessageId(inputSubmissionId: string): string {
  const suffix = inputSubmissionId.startsWith("input_") ? inputSubmissionId.slice("input_".length) : "";
  // Preserve a non-standard fixture/test ID for structural adapter tests. Real
  // Runtime-created IDs use randomUUID entropy and take the strict path.
  return UUID_SUFFIX.test(suffix) ? suffix : inputSubmissionId;
}

function runtimeInputSubmissionIdFromCodexClientId(clientId: string | undefined): string | undefined {
  if (!clientId) return undefined;
  return UUID_SUFFIX.test(clientId) ? `input_${clientId}` : clientId;
}

/** One observer, durable buffering, and cancellation-friendly return semantics. */
class NativeFactQueue {
  readonly #items: NativeProviderFact[] = [];
  #waiter: ((result: IteratorResult<NativeProviderFact>) => void) | undefined;
  #active = false;
  #closed = false;

  push(value: NativeProviderFact): void {
    if (this.#closed) return;
    const waiter = this.#waiter;
    if (waiter) {
      this.#waiter = undefined;
      waiter({ done: false, value });
      return;
    }
    this.#items.push(value);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    const waiter = this.#waiter;
    this.#waiter = undefined;
    waiter?.({ done: true, value: undefined });
  }

  subscribe(): AsyncIterable<NativeProviderFact> {
    if (this.#active) throw new Error("codex_app_server_observer_already_active");
    this.#active = true;
    const queue = this;
    return {
      [Symbol.asyncIterator](): AsyncIterator<NativeProviderFact> {
        return {
          next: () => queue.#next(),
          return: async () => {
            queue.#active = false;
            const waiter = queue.#waiter;
            queue.#waiter = undefined;
            waiter?.({ done: true, value: undefined });
            return { done: true, value: undefined };
          },
        };
      },
    };
  }

  #next(): Promise<IteratorResult<NativeProviderFact>> {
    const value = this.#items.shift();
    if (value) return Promise.resolve({ done: false, value });
    if (this.#closed) return Promise.resolve({ done: true, value: undefined });
    return new Promise((resolve) => { this.#waiter = resolve; });
  }
}

import { describe, expect, it } from "vitest";
import type {
  ExecutionProfileDefinition,
  ProviderActivityCategory,
  ProviderActivityPhase,
  ProviderFact,
} from "../../packages/runtime-contracts/src/index";
import type {
  ProtocolPin,
  ProviderPortBindingRequest,
} from "../../packages/provider-port/src/index";
import {
  CODEX_APP_SERVER_PROVEN_CORE_CAPABILITIES,
  createCodexAppServerProviderAdapter,
  type CodexAppServerConnection,
  type CodexAppServerConnectionFactory,
  type CodexAppServerConnectionInput,
  type CodexAppServerInboundMessage,
  type CodexAppServerJsonRpcId,
} from "../../packages/provider-codex/src/app-server";
import {
  createOpenCodeProviderAdapter,
  createOpenCodeServerTransport,
} from "../../packages/provider-opencode/src/index";

const RAW_CWD = "/private/raw/provider-parity-workspace";
const INPUT_SUBMISSION_ID = "input_provider_parity";
const INVOCATION_ID = "invocation_provider_parity";
const FINAL_TEXT = "PROVIDER_PARITY_OK";
const CODEX_PROTOCOL: ProtocolPin = Object.freeze({
  providerVersion: "0.146.0",
  protocolFingerprint: `sha256:${"c".repeat(64)}`,
});

describe("Provider activity parity", () => {
  it("projects Codex and OpenCode tool progress, assistant streaming, final, and terminal facts identically", async () => {
    const [codexFacts, openCodeFacts] = await Promise.all([
      runCodexScenario(),
      runOpenCodeScenario(),
    ]);

    const codexProjection = providerNeutralProjection(codexFacts);
    const openCodeProjection = providerNeutralProjection(openCodeFacts);

    expect(codexProjection).toEqual(openCodeProjection);
    expect(codexProjection).toEqual({
      phasesByCategory: {
        assistant_progress: ["started", "progress", "completed"],
        tool: ["started", "progress", "completed"],
      },
      completedActivityCount: 2,
      finalMessages: [FINAL_TEXT],
      turnCompletedCount: 1,
    });
  });
});

async function runCodexScenario(): Promise<readonly ProviderFact[]> {
  const connection = new FixtureCodexConnection();
  const adapter = createCodexAppServerProviderAdapter({
    connectionFactory: new FixtureCodexFactory(connection),
    protocol: CODEX_PROTOCOL,
    safety: { approvalPolicy: "untrusted", sandbox: "read-only", networkAccess: false },
    verifiedCapabilities: CODEX_APP_SERVER_PROVEN_CORE_CAPABILITIES,
    now: () => "2026-08-09T00:00:00.000Z",
  });
  const binding = codexBindingRequest();

  await adapter.ensureBinding({ ...binding, disposition: "create" });
  const stream = adapter.observeBinding(binding)[Symbol.asyncIterator]();
  await expectFact(stream, "binding_observed");
  await adapter.submitDelivery({
    ...binding,
    inputSubmissionId: INPUT_SUBMISSION_ID,
    invocationId: INVOCATION_ID,
    idempotencyKey: "input:provider-parity",
    content: "Run one tool, stream the answer, then return the parity marker.",
  });
  await expectFact(stream, "input_received");
  await expectFact(stream, "turn_started");

  connection.emit(notification("item/started", {
    threadId: "native_codex_thread",
    turnId: "native_codex_turn",
    item: {
      type: "commandExecution",
      id: "native_codex_tool",
      command: `pwd ${RAW_CWD}`,
      cwd: RAW_CWD,
      commandActions: [],
      status: "inProgress",
    },
  }));
  connection.emit(notification("item/commandExecution/outputDelta", {
    threadId: "native_codex_thread",
    turnId: "native_codex_turn",
    itemId: "native_codex_tool",
    delta: `working in ${RAW_CWD}`,
  }));
  connection.emit(notification("item/completed", {
    threadId: "native_codex_thread",
    turnId: "native_codex_turn",
    item: {
      type: "commandExecution",
      id: "native_codex_tool",
      command: `pwd ${RAW_CWD}`,
      cwd: RAW_CWD,
      commandActions: [],
      status: "completed",
      aggregatedOutput: `done in ${RAW_CWD}`,
      exitCode: 0,
    },
  }));
  connection.emit(notification("item/started", {
    threadId: "native_codex_thread",
    turnId: "native_codex_turn",
    item: { type: "agentMessage", id: "native_codex_assistant", text: "", phase: "final_answer" },
  }));
  connection.emit(notification("item/agentMessage/delta", {
    threadId: "native_codex_thread",
    turnId: "native_codex_turn",
    itemId: "native_codex_assistant",
    delta: "PROVIDER_",
  }));
  connection.emit(notification("item/completed", {
    threadId: "native_codex_thread",
    turnId: "native_codex_turn",
    item: {
      type: "agentMessage",
      id: "native_codex_assistant",
      text: FINAL_TEXT,
      phase: "final_answer",
    },
  }));
  connection.emit(notification("turn/completed", {
    threadId: "native_codex_thread",
    turn: { id: "native_codex_turn", status: "completed" },
  }));

  const facts = await readThrough(stream, "turn_completed");
  await adapter.releaseBinding(binding);
  return facts;
}

async function runOpenCodeScenario(): Promise<readonly ProviderFact[]> {
  const bindingId = "binding_opencode_provider_parity";
  const fixture = createOpenCodeSseFixture(bindingId);
  const transport = createOpenCodeServerTransport({
    baseUrl: "http://127.0.0.1:47123",
    fetchFn: fixture.fetchFn,
  });
  const protocol = await transport.inspectProtocol!();
  const adapter = createOpenCodeProviderAdapter({
    transport,
    protocol,
    now: () => "2026-08-09T00:00:00.000Z",
  });
  const profile = openCodeProfile(protocol);
  const binding = bindingRequest(bindingId, profile);
  await adapter.ensureBinding({
    ...binding,
    disposition: "create",
    idempotencyKey: "create:provider-parity",
  });
  const activeBinding = { ...binding, nativeBindingRef: fixture.sessionId };
  await adapter.submitDelivery({
    ...activeBinding,
    inputSubmissionId: INPUT_SUBMISSION_ID,
    invocationId: INVOCATION_ID,
    idempotencyKey: "input:provider-parity",
    content: "Run one tool, stream the answer, then return the parity marker.",
  });
  const facts: ProviderFact[] = [];
  for await (const fact of adapter.observeBinding(activeBinding)) facts.push(fact);
  expect(fixture.calls).toContain("POST /session/native_opencode_session/prompt_async");
  expect(fixture.calls).toContain("GET /event");
  return facts;
}

function providerNeutralProjection(facts: readonly ProviderFact[]): {
  readonly phasesByCategory: Partial<Record<ProviderActivityCategory, readonly ProviderActivityPhase[]>>;
  readonly completedActivityCount: number;
  readonly finalMessages: readonly string[];
  readonly turnCompletedCount: number;
} {
  const activities = facts.filter((fact) => fact.kind === "activity_observed");
  const phasesByCategory: Partial<Record<ProviderActivityCategory, ProviderActivityPhase[]>> = {};
  const latestPhase = new Map<string, ProviderActivityPhase>();

  for (const fact of activities) {
    const category = String(fact.payload.category) as ProviderActivityCategory;
    const phase = String(fact.payload.phase) as ProviderActivityPhase;
    const activityId = String(fact.payload.activityId);
    expect(activityId).toMatch(/^activity_[A-Za-z0-9-]{12,80}$/);
    expect(fact.correlation).toMatchObject({
      inputSubmissionId: INPUT_SUBMISSION_ID,
      invocationId: INVOCATION_ID,
    });
    (phasesByCategory[category] ??= []).push(phase);
    latestPhase.set(activityId, phase);
  }

  expect(activities.some((fact) => fact.payload.category === "tool")).toBe(true);
  expect(activities.some((fact) => fact.payload.category === "assistant_progress")).toBe(true);
  expect([...latestPhase.values()].every((phase) => phase === "completed")).toBe(true);

  const finalMessages = facts
    .filter((fact) => fact.kind === "assistant_final")
    .map((fact) => String(fact.payload.content).trim());
  expect(finalMessages).toHaveLength(1);
  expect(finalMessages[0]).not.toBe("");

  // Deduplication/correlation may retain native IDs internally. The renderer-safe
  // projection (activity payloads plus final text) must never expose them or cwd.
  const presentationPayload = JSON.stringify({
    activities: activities.map((fact) => fact.payload),
    finalMessages,
  });
  expect(presentationPayload).not.toContain(RAW_CWD);
  expect(presentationPayload).not.toMatch(/native_(?:codex|opencode)/u);

  const turnCompletedCount = facts.filter((fact) => fact.kind === "turn_completed").length;
  expect(turnCompletedCount).toBe(1);
  return {
    phasesByCategory,
    completedActivityCount: [...latestPhase.values()].filter((phase) => phase === "completed").length,
    finalMessages,
    turnCompletedCount,
  };
}

function codexBindingRequest(): ProviderPortBindingRequest {
  return bindingRequest("binding_codex_provider_parity", {
    executionProfileId: "profile_codex_provider_parity",
    provider: "codex",
    model: "gpt-5.1-codex",
    providerVersion: CODEX_PROTOCOL.providerVersion,
    protocolFingerprint: CODEX_PROTOCOL.protocolFingerprint,
    capabilityPolicy: {
      requiredCapabilities: CODEX_APP_SERVER_PROVEN_CORE_CAPABILITIES,
      allowedTools: [],
      permissionMode: "deny",
      maxConcurrentTurns: 1,
      maxNativeChildren: 0,
    },
  });
}

function openCodeProfile(protocol: ProtocolPin): ExecutionProfileDefinition {
  return {
    executionProfileId: "profile_opencode_provider_parity",
    provider: "opencode",
    model: "opencode-go/gpt-5.6-luna",
    providerVersion: protocol.providerVersion,
    protocolFingerprint: protocol.protocolFingerprint,
    capabilityPolicy: {
      requiredCapabilities: [
        "create_binding",
        "resume_binding",
        "input_correlation",
        "provider_receipt",
        "reconcile",
      ],
      allowedTools: [],
      permissionMode: "ask",
      maxConcurrentTurns: 1,
      maxNativeChildren: 0,
    },
  };
}

function bindingRequest(
  bindingId: string,
  executionProfile: ExecutionProfileDefinition,
): ProviderPortBindingRequest {
  return {
    bindingId,
    bindingRevision: 1,
    executionProfile,
    workspace: { workspaceId: "workspace_provider_parity", cwd: RAW_CWD },
    bootstrap: {
      purpose: "task_conductor",
      agentCardId: "agent_card_conductor",
      systemPrompt: "Coordinate one bounded parity task.",
      capabilityRefs: [],
      dispatchRegistry: [],
    },
  };
}

function notification(method: string, params: unknown): CodexAppServerInboundMessage {
  return { kind: "notification", method, params };
}

function createOpenCodeSseFixture(bindingId: string): {
  readonly sessionId: string;
  readonly calls: string[];
  readonly fetchFn: typeof fetch;
} {
  const sessionId = "native_opencode_session";
  const nativeInputId = `msg_${INPUT_SUBMISSION_ID}`;
  const toolMessageId = "native_opencode_tool_message";
  const finalMessageId = "native_opencode_final_message";
  const toolPartId = "native_opencode_tool_part";
  const textPartId = "native_opencode_text_part";
  const openApi = {
    openapi: "3.1.0",
    info: { title: "opencode", version: "1.0.0" },
    paths: {
      "/global/health": { get: { operationId: "global.health" } },
      "/session": { post: { operationId: "session.create" } },
      "/session/{sessionID}/prompt_async": { post: { operationId: "session.prompt_async" } },
    },
  };
  const session = {
    id: sessionId,
    title: `Agent Workspace ${bindingId}`,
    metadata: { agentWorkspace: { bindingId, bindingRevision: 1 } },
    time: { created: 1, updated: 2 },
  };
  const calls: string[] = [];
  let created = false;
  let delivered = false;

  const toolPart = (status: "pending" | "running" | "completed") => ({
    id: toolPartId,
    sessionID: sessionId,
    messageID: toolMessageId,
    type: "tool",
    callID: "native_opencode_tool_call",
    tool: "shell",
    state: status === "completed"
      ? {
          status,
          input: { cwd: RAW_CWD, token: "native-opencode-secret" },
          output: `done in ${RAW_CWD}`,
        }
      : {
          status,
          input: { cwd: RAW_CWD, token: "native-opencode-secret" },
        },
  });
  const event = (id: string, type: string, properties: unknown) => ({ id, type, properties });
  const events = [
    event("native_opencode_user_event", "message.updated", {
      sessionID: sessionId,
      info: { id: nativeInputId, sessionID: sessionId, role: "user" },
    }),
    event("native_opencode_tool_message_start", "message.updated", {
      sessionID: sessionId,
      info: { id: toolMessageId, sessionID: sessionId, parentID: nativeInputId, role: "assistant" },
    }),
    event("native_opencode_tool_started", "message.part.updated", {
      sessionID: sessionId,
      part: toolPart("pending"),
    }),
    event("native_opencode_tool_progress", "message.part.updated", {
      sessionID: sessionId,
      part: toolPart("running"),
    }),
    event("native_opencode_tool_completed", "message.part.updated", {
      sessionID: sessionId,
      part: toolPart("completed"),
    }),
    event("native_opencode_tool_calls", "message.updated", {
      sessionID: sessionId,
      info: {
        id: toolMessageId,
        sessionID: sessionId,
        parentID: nativeInputId,
        role: "assistant",
        finish: "tool-calls",
        time: { completed: 3 },
      },
    }),
    event("native_opencode_final_message_start", "message.updated", {
      sessionID: sessionId,
      info: { id: finalMessageId, sessionID: sessionId, parentID: nativeInputId, role: "assistant" },
    }),
    event("native_opencode_text_started", "message.part.updated", {
      sessionID: sessionId,
      part: {
        id: textPartId,
        sessionID: sessionId,
        messageID: finalMessageId,
        type: "text",
        text: "",
        time: { start: 4 },
      },
    }),
    event("native_opencode_text_progress", "message.part.delta", {
      sessionID: sessionId,
      messageID: finalMessageId,
      partID: textPartId,
      field: "text",
      delta: "PROVIDER_",
    }),
    event("native_opencode_text_completed", "message.part.updated", {
      sessionID: sessionId,
      part: {
        id: textPartId,
        sessionID: sessionId,
        messageID: finalMessageId,
        type: "text",
        text: FINAL_TEXT,
        time: { start: 4, end: 5 },
      },
    }),
    event("native_opencode_stop", "message.updated", {
      sessionID: sessionId,
      info: {
        id: finalMessageId,
        sessionID: sessionId,
        parentID: nativeInputId,
        role: "assistant",
        finish: "stop",
        time: { completed: 5 },
      },
    }),
  ];

  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    calls.push(`${method} ${url.pathname}`);
    if (method === "GET" && url.pathname === "/global/health") {
      return jsonResponse({ healthy: true, version: "1.18.13" });
    }
    if (method === "GET" && url.pathname === "/doc") return jsonResponse(openApi);
    if (method === "GET" && url.pathname === "/session") return jsonResponse(created ? [session] : []);
    if (method === "POST" && url.pathname === "/session") {
      created = true;
      return jsonResponse(session);
    }
    if (method === "GET" && url.pathname === `/session/${sessionId}`) return jsonResponse(session);
    if (method === "POST" && url.pathname === `/session/${sessionId}/prompt_async`) {
      delivered = true;
      return new Response(null, { status: 204 });
    }
    if (method === "GET" && url.pathname === "/event") {
      return sseResponse(delivered ? events : []);
    }
    return new Response(JSON.stringify({ error: `${method} ${url.pathname}` }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { sessionId, calls, fetchFn };
}

function sseResponse(events: readonly unknown[]): Response {
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

async function expectFact(
  stream: AsyncIterator<ProviderFact>,
  kind: ProviderFact["kind"],
): Promise<void> {
  const next = await stream.next();
  expect(next.done).toBe(false);
  expect(next.value?.kind).toBe(kind);
}

async function readThrough(
  stream: AsyncIterator<ProviderFact>,
  terminalKind: ProviderFact["kind"],
): Promise<readonly ProviderFact[]> {
  const facts: ProviderFact[] = [];
  for (let count = 0; count < 16; count += 1) {
    const next = await stream.next();
    if (next.done) break;
    facts.push(next.value);
    if (next.value.kind === terminalKind) return facts;
  }
  throw new Error(`provider_fixture_terminal_fact_missing:${terminalKind}`);
}

class FixtureCodexFactory implements CodexAppServerConnectionFactory {
  constructor(private readonly connection: FixtureCodexConnection) {}

  async inspectProtocol(): Promise<ProtocolPin> {
    return CODEX_PROTOCOL;
  }

  async create(_input: CodexAppServerConnectionInput): Promise<CodexAppServerConnection> {
    return this.connection;
  }
}

class FixtureCodexConnection implements CodexAppServerConnection {
  readonly instanceId = "native_codex_source";
  readonly #events = new InboundQueue();

  async request<T = unknown>(method: string, _params: unknown): Promise<T> {
    const value = (() => {
      switch (method) {
        case "thread/start":
        case "thread/resume":
          return { thread: { id: "native_codex_thread", canAcceptDirectInput: true } };
        case "turn/start":
          return { turn: { id: "native_codex_turn", status: "inProgress" } };
        case "thread/unsubscribe":
          return {};
        default:
          throw new Error(`unexpected_codex_fixture_request:${method}`);
      }
    })();
    return value as T;
  }

  events(): AsyncIterable<CodexAppServerInboundMessage> {
    return this.#events.subscribe();
  }

  async respond(_id: CodexAppServerJsonRpcId, _result: unknown): Promise<void> {}

  async close(): Promise<void> {
    this.#events.close();
  }

  emit(message: CodexAppServerInboundMessage): void {
    this.#events.push(message);
  }
}

class InboundQueue {
  readonly #items: CodexAppServerInboundMessage[] = [];
  #waiter: ((result: IteratorResult<CodexAppServerInboundMessage>) => void) | undefined;
  #closed = false;
  #subscribed = false;

  push(value: CodexAppServerInboundMessage): void {
    if (this.#closed) return;
    if (this.#waiter) {
      const waiter = this.#waiter;
      this.#waiter = undefined;
      waiter({ done: false, value });
      return;
    }
    this.#items.push(value);
  }

  close(): void {
    this.#closed = true;
    this.#waiter?.({ done: true, value: undefined });
    this.#waiter = undefined;
  }

  subscribe(): AsyncIterable<CodexAppServerInboundMessage> {
    if (this.#subscribed) throw new Error("codex_fixture_observer_already_active");
    this.#subscribed = true;
    return {
      [Symbol.asyncIterator]: () => ({ next: () => this.#next() }),
    };
  }

  #next(): Promise<IteratorResult<CodexAppServerInboundMessage>> {
    const value = this.#items.shift();
    if (value) return Promise.resolve({ done: false, value });
    if (this.#closed) return Promise.resolve({ done: true, value: undefined });
    return new Promise((resolve) => { this.#waiter = resolve; });
  }
}

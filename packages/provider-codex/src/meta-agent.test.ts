import { describe, expect, it } from "vitest";
import type { MetaProfileDefinition } from "../../runtime-contracts/src/index";
import type { MetaAgentTurnRequest, ProtocolPin } from "../../provider-port/src/index";
import type {
  CodexAppServerConnection,
  CodexAppServerInboundMessage,
  CodexAppServerJsonRpcId,
} from "./app-server";
import {
  CODEX_META_APP_SERVER_PROTOCOL_0_146,
  CODEX_META_DISABLED_FEATURES_0_146,
  CODEX_META_NO_TOOL_ATTESTATION_0_146,
  createCodexMetaAgentPort,
  type CodexMetaAppServerConnectionFactory,
  type CodexMetaAppServerConnectionInput,
  type CodexMetaNoToolProcessAttestation,
} from "./meta-agent";

describe("Codex 0.146 no-tool MetaAgentPort", () => {
  it("starts an isolated no-tool turn, strictly correlates its live final, and deduplicates replay", async () => {
    const connection = new FakeConnection();
    const factory = new FakeFactory(connection);
    const adapter = createCodexMetaAgentPort({
      connectionFactory: factory,
      now: () => "2026-08-09T00:00:00.000Z",
    });
    const request = metaRequest();

    await expect(adapter.describeMetaCapabilities(request.profile)).resolves.toMatchObject({
      provider: "codex",
      available: true,
      providerVersion: "0.146.0",
      protocolFingerprint: CODEX_META_APP_SERVER_PROTOCOL_0_146.protocolFingerprint,
      unavailableReasons: [],
    });
    await expect(adapter.startMetaTurn(request)).resolves.toBe("accepted");

    expect(factory.created).toHaveLength(1);
    expect(factory.created[0]).toEqual({
      metaTurnId: request.metaTurnId,
      profile: request.profile,
      protocol: CODEX_META_APP_SERVER_PROTOCOL_0_146,
      noToolAttestation: CODEX_META_NO_TOOL_ATTESTATION_0_146,
    });
    expect(Object.keys(factory.created[0] ?? {}).sort()).toEqual([
      "metaTurnId",
      "noToolAttestation",
      "profile",
      "protocol",
    ]);

    const threadStart = connection.requestFor("thread/start")?.params as Record<string, unknown>;
    expect(threadStart).toMatchObject({
      allowProviderModelFallback: false,
      model: "gpt-5.6-sol",
      runtimeWorkspaceRoots: [],
      approvalPolicy: "never",
      sandbox: "read-only",
      ephemeral: false,
      historyMode: "paginated",
      environments: [],
      dynamicTools: [],
      selectedCapabilityRoots: [],
      experimentalRawEvents: false,
    });
    expect(threadStart).not.toHaveProperty("cwd");
    expect(threadStart).not.toHaveProperty("workspace");
    expect(threadStart).not.toHaveProperty("taskId");
    const config = threadStart.config as Record<string, unknown>;
    expect(config).toMatchObject({
      analytics: { enabled: false },
      apps: { _default: { enabled: false } },
      web_search: "disabled",
    });
    expect(config.features).toEqual(Object.fromEntries(CODEX_META_DISABLED_FEATURES_0_146.map((feature) => [feature, false])));

    const turnStart = connection.requestFor("turn/start")?.params as Record<string, unknown>;
    expect(turnStart).toMatchObject({
      threadId: "thread_meta_1",
      runtimeWorkspaceRoots: [],
      approvalPolicy: "never",
      sandboxPolicy: { type: "readOnly", networkAccess: false },
      environments: [],
      outputSchema: request.outputSchema,
    });
    expect(turnStart.clientUserMessageId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(turnStart.clientUserMessageId).not.toBe(request.userMetaMessageId);
    expect(turnStart).not.toHaveProperty("cwd");
    const inputText = ((turnStart.input as readonly Record<string, unknown>[])[0]?.text as string);
    expect(inputText).toContain("Configuration context (untrusted JSON data)");
    expect(inputText).toContain("Change the researcher model");
    expect(inputText).not.toContain("task_1");

    connection.emit({
      kind: "notification",
      method: "item/completed",
      emittedAtMs: Date.parse("2026-08-09T01:02:03.000Z"),
      params: {
        threadId: "thread_meta_1",
        turnId: "native_turn_1",
        item: { type: "agentMessage", id: "native_message_1", phase: "final_answer", text: "{\"operations\":[]}" },
      },
    });
    connection.emit({
      kind: "notification",
      method: "turn/completed",
      emittedAtMs: Date.parse("2026-08-09T01:02:03.000Z"),
      params: {
        threadId: "thread_meta_1",
        turn: {
          id: "native_turn_1",
          status: "completed",
          items: [{ type: "agentMessage", id: "native_message_1", phase: "final_answer", text: "{\"operations\":[]}" }],
        },
      },
    });

    await eventually(async () => {
      expect(await adapter.reconcileMetaTurn(request)).toEqual({
        state: "returned",
        finalText: "{\"operations\":[]}",
        observedAt: "2026-08-09T01:02:03.000Z",
      });
    });
    await expect(adapter.startMetaTurn(request)).resolves.toBe("accepted");
    expect(factory.created).toHaveLength(1);
    await eventually(() => expect(connection.closeCalls).toBe(1));
  });

  it("derives the same native UUID from the durable Runtime message identity across adapter recovery", async () => {
    const request = metaRequest({ userMetaMessageId: "meta_message_0123456789abcdef" });
    const firstConnection = new FakeConnection();
    const secondConnection = new FakeConnection();

    await createCodexMetaAgentPort({ connectionFactory: new FakeFactory(firstConnection) }).startMetaTurn(request);
    await createCodexMetaAgentPort({ connectionFactory: new FakeFactory(secondConnection) }).startMetaTurn(request);

    const first = firstConnection.requestFor("turn/start")?.params as Record<string, unknown>;
    const second = secondConnection.requestFor("turn/start")?.params as Record<string, unknown>;
    expect(first.clientUserMessageId).toBe(second.clientUserMessageId);
    expect(first.clientUserMessageId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("reports unavailable unless both the exact pin and exact process attestation are established", async () => {
    const wrongProtocol = new FakeFactory(new FakeConnection(), {
      providerVersion: "0.147.0",
      protocolFingerprint: CODEX_META_APP_SERVER_PROTOCOL_0_146.protocolFingerprint,
    });
    const protocolReport = await createCodexMetaAgentPort({ connectionFactory: wrongProtocol })
      .describeMetaCapabilities(metaProfile());
    expect(protocolReport.available).toBe(false);
    expect(protocolReport.unavailableReasons).toContain("codex_meta_protocol_pin_mismatch");

    const unsafeAttestation: CodexMetaNoToolProcessAttestation = {
      ...CODEX_META_NO_TOOL_ATTESTATION_0_146,
      initializationCapabilities: { experimentalApi: true, requestAttestation: false },
      inheritedEnvironment: false,
      isolatedCodexHome: true,
      hostPrivateCwd: true,
      launchArguments: CODEX_META_NO_TOOL_ATTESTATION_0_146.launchArguments.filter((entry) => entry !== "shell_tool"),
    };
    const wrongProcess = new FakeFactory(new FakeConnection(), CODEX_META_APP_SERVER_PROTOCOL_0_146, unsafeAttestation);
    const processReport = await createCodexMetaAgentPort({ connectionFactory: wrongProcess })
      .describeMetaCapabilities(metaProfile());
    expect(processReport.available).toBe(false);
    expect(processReport.unavailableReasons).toContain("codex_meta_no_tool_configuration_unproven");

    const unsafeProfile = metaProfile({
      capabilityPolicy: {
        requiredCapabilities: ["create_binding"],
        allowedTools: ["shell"],
        permissionMode: "ask",
        maxConcurrentTurns: 2,
        maxNativeChildren: 1,
      },
    });
    const profileReport = await createCodexMetaAgentPort({ connectionFactory: new FakeFactory(new FakeConnection()) })
      .describeMetaCapabilities(unsafeProfile);
    expect(profileReport.available).toBe(false);
    expect(profileReport.unavailableReasons).toEqual(expect.arrayContaining([
      "codex_meta_task_capabilities_forbidden",
      "codex_meta_tools_forbidden",
      "codex_meta_permission_mode_invalid",
      "codex_meta_concurrency_invalid",
      "codex_meta_native_children_forbidden",
    ]));
  });

  it("rejects Task/workspace/Binding authority and conflicting correlation before opening a child", async () => {
    const factory = new FakeFactory(new FakeConnection());
    const adapter = createCodexMetaAgentPort({ connectionFactory: factory });
    await expect(adapter.startMetaTurn({ ...metaRequest(), taskId: "task_1" } as unknown as MetaAgentTurnRequest))
      .rejects.toThrow("codex_meta_request_fields_invalid");
    await expect(adapter.startMetaTurn({
      ...metaRequest(),
      context: { draft: { workspaceId: "workspace_1" } },
    })).rejects.toThrow("codex_meta_authority_field_forbidden");
    expect(factory.created).toHaveLength(0);

    const request = metaRequest();
    await expect(adapter.startMetaTurn(request)).resolves.toBe("accepted");
    await expect(adapter.startMetaTurn({ ...request, content: "different content" }))
      .rejects.toThrow("codex_meta_turn_correlation_conflict");
    expect(factory.created).toHaveLength(1);
  });

  it("fails a correlated live turn if any native tool activity is observed", async () => {
    const connection = new FakeConnection();
    const adapter = createCodexMetaAgentPort({ connectionFactory: new FakeFactory(connection) });
    const request = metaRequest();
    await expect(adapter.startMetaTurn(request)).resolves.toBe("accepted");
    connection.emit({
      kind: "notification",
      method: "item/completed",
      params: {
        threadId: "thread_meta_1",
        turnId: "native_turn_1",
        item: { type: "commandExecution", id: "command_1", status: "completed" },
      },
    });
    await eventually(async () => {
      expect(await adapter.reconcileMetaTurn(request)).toMatchObject({
        state: "failed",
        failureCode: "codex_meta_forbidden_native_tool_activity",
      });
    });
  });

  it("fails closed on native correlation mismatch and on a non-canonical live final", async () => {
    const mismatched = new FakeConnection();
    const mismatchAdapter = createCodexMetaAgentPort({ connectionFactory: new FakeFactory(mismatched) });
    const mismatchRequest = metaRequest();
    await mismatchAdapter.startMetaTurn(mismatchRequest);
    mismatched.emit({
      kind: "notification",
      method: "turn/completed",
      params: { threadId: "thread_meta_1", turn: { id: "another_native_turn", status: "completed", items: [] } },
    });
    await eventually(async () => {
      expect(await mismatchAdapter.reconcileMetaTurn(mismatchRequest)).toMatchObject({
        state: "failed",
        failureCode: "codex_meta_native_correlation_mismatch",
      });
    });

    const ambiguous = new FakeConnection();
    const ambiguousAdapter = createCodexMetaAgentPort({ connectionFactory: new FakeFactory(ambiguous) });
    const ambiguousRequest = metaRequest({ metaTurnId: "meta_turn_ambiguous-1", userMetaMessageId: "meta_message_ambiguous-1" });
    await ambiguousAdapter.startMetaTurn(ambiguousRequest);
    ambiguous.emit({
      kind: "notification",
      method: "turn/completed",
      params: {
        threadId: "thread_meta_1",
        turn: {
          id: "native_turn_1",
          status: "completed",
          items: [
            { type: "agentMessage", id: "final_1", phase: "final_answer", text: "{\"operations\":[]}" },
            { type: "agentMessage", id: "final_2", phase: "final_answer", text: "{\"operations\":[],\"extra\":true}" },
          ],
        },
      },
    });
    await eventually(async () => {
      expect(await ambiguousAdapter.reconcileMetaTurn(ambiguousRequest)).toMatchObject({
        state: "failed",
        failureCode: "codex_meta_canonical_final_unproven",
      });
    });
  });

  it("returns unknown on cold reconcile instead of trusting 0.146 persisted interrupted history", async () => {
    const connection = new FakeConnection();
    const factory = new FakeFactory(connection);
    const adapter = createCodexMetaAgentPort({ connectionFactory: factory });

    await expect(adapter.reconcileMetaTurn(metaRequest())).resolves.toEqual({ state: "unknown" });
    expect(factory.created).toHaveLength(0);
    expect(connection.requests).toHaveLength(0);
  });

  it("treats any unexpected App Server request as a no-tool security failure and declines it", async () => {
    const connection = new FakeConnection();
    const adapter = createCodexMetaAgentPort({ connectionFactory: new FakeFactory(connection) });
    const request = metaRequest();
    await adapter.startMetaTurn(request);
    connection.emit({
      kind: "server_request",
      id: "approval_1",
      method: "item/commandExecution/requestApproval",
      params: { threadId: "thread_meta_1", turnId: "native_turn_1" },
    });
    await eventually(async () => {
      expect(connection.responses).toContainEqual({ id: "approval_1", result: { decision: "decline" } });
      expect(await adapter.reconcileMetaTurn(request)).toMatchObject({
        state: "failed",
        failureCode: "codex_meta_unexpected_server_request",
      });
    });
  });
});

function metaProfile(overrides: Partial<MetaProfileDefinition> = {}): MetaProfileDefinition {
  return {
    metaProfileId: "meta_profile_codex-1",
    provider: "codex",
    model: "gpt-5.6-sol",
    providerVersion: CODEX_META_APP_SERVER_PROTOCOL_0_146.providerVersion,
    protocolFingerprint: CODEX_META_APP_SERVER_PROTOCOL_0_146.protocolFingerprint,
    capabilityPolicy: {
      requiredCapabilities: [],
      allowedTools: [],
      permissionMode: "deny",
      maxConcurrentTurns: 1,
      maxNativeChildren: 0,
    },
    ...overrides,
  };
}

function metaRequest(overrides: Partial<MetaAgentTurnRequest> = {}): MetaAgentTurnRequest {
  return {
    metaTurnId: "meta_turn_1",
    userMetaMessageId: "meta_message_user-1",
    idempotencyKey: "command_meta-1",
    mode: "template_design",
    profile: metaProfile(),
    targetRevision: 3,
    systemInstructions: "Return a patch proposal for the selected Template Draft.",
    outputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["operations"],
      properties: { operations: { type: "array" } },
    },
    context: { draft: { title: "Deep Research", revision: 3 } },
    transcript: [{ metaMessageId: "meta_message_prior-1", role: "assistant", content: "Ready." }],
    content: "Change the researcher model",
    ...overrides,
  };
}

class FakeFactory implements CodexMetaAppServerConnectionFactory {
  readonly created: CodexMetaAppServerConnectionInput[] = [];

  constructor(
    readonly connection: FakeConnection,
    readonly protocol: ProtocolPin = CODEX_META_APP_SERVER_PROTOCOL_0_146,
    readonly attestation: CodexMetaNoToolProcessAttestation = CODEX_META_NO_TOOL_ATTESTATION_0_146,
  ) {}

  async inspectProtocol(): Promise<ProtocolPin> {
    return this.protocol;
  }

  async inspectNoToolConfiguration(): Promise<CodexMetaNoToolProcessAttestation> {
    return this.attestation;
  }

  async create(input: CodexMetaAppServerConnectionInput): Promise<CodexAppServerConnection> {
    this.created.push(input);
    return this.connection;
  }
}

class FakeConnection implements CodexAppServerConnection {
  readonly instanceId = "codex_meta_test_instance";
  readonly requests: Array<{ method: string; params: unknown }> = [];
  readonly responses: Array<{ id: CodexAppServerJsonRpcId; result: unknown }> = [];
  readonly #events = new AsyncQueue<CodexAppServerInboundMessage>();
  closeCalls = 0;

  async request<T = unknown>(method: string, params: unknown): Promise<T> {
    this.requests.push({ method, params });
    if (method === "thread/start") {
      const model = (params as Record<string, unknown>).model;
      return {
        thread: { id: "thread_meta_1" },
        model,
        modelProvider: "openai",
        approvalPolicy: "never",
        sandbox: { type: "readOnly", networkAccess: false },
        runtimeWorkspaceRoots: [],
        instructionSources: [],
      } as T;
    }
    if (method === "turn/start") return { turn: { id: "native_turn_1", status: "inProgress" } } as T;
    throw new Error(`unexpected_method:${method}`);
  }

  events(): AsyncIterable<CodexAppServerInboundMessage> {
    return this.#events;
  }

  async respond(id: CodexAppServerJsonRpcId, result: unknown): Promise<void> {
    this.responses.push({ id, result });
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
    this.#events.close();
  }

  emit(event: CodexAppServerInboundMessage): void {
    this.#events.push(event);
  }

  requestFor(method: string): { method: string; params: unknown } | undefined {
    return this.requests.find((entry) => entry.method === method);
  }
}

class AsyncQueue<T> implements AsyncIterable<T> {
  readonly #items: T[] = [];
  #waiter: ((result: IteratorResult<T>) => void) | undefined;
  #closed = false;

  push(value: T): void {
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
    this.#closed = true;
    const waiter = this.#waiter;
    this.#waiter = undefined;
    waiter?.({ done: true, value: undefined });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: async () => {
        const value = this.#items.shift();
        if (value !== undefined) return { done: false, value };
        if (this.#closed) return { done: true, value: undefined };
        return new Promise<IteratorResult<T>>((resolve) => { this.#waiter = resolve; });
      },
    };
  }
}

async function eventually(assertion: () => void | Promise<void>): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      await assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  throw lastError;
}

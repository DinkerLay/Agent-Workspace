import type { ExecutionProfileDefinition, ProviderFact } from "@agent-workspace/runtime-contracts";
import type { ProviderPortBindingRequest } from "@agent-workspace/provider-port";
import { describe, expect, it } from "vitest";
import {
  createOpenCodeProviderAdapter,
  createOpenCodeServerTransport,
  openCodeServerProtocolFingerprint,
} from "./index.js";

describe("OpenCode Server native transport", () => {
  it("recovers bounded activities and exactly one final plus terminal from multi-step history", async () => {
    const fixture = createServerFixture();
    const transport = createOpenCodeServerTransport({ baseUrl: "http://127.0.0.1:47123", fetchFn: fixture.fetchFn });
    const protocol = await transport.inspectProtocol!();
    const profile = profileFor(protocol);
    const adapter = createOpenCodeProviderAdapter({ transport, protocol });
    const request = bindingRequest(profile);

    const report = await adapter.describeCapabilities(profile);
    expect(report).toMatchObject({ available: true, providerVersion: "1.18.13" });
    expect(report.capabilities).toEqual([
      "create_binding", "resume_binding", "input_correlation", "provider_receipt", "reconcile",
    ]);
    expect(report.capabilities).not.toContain("interrupt");
    expect(report.capabilities).not.toContain("native_child");

    const ensured = await adapter.ensureBinding({ ...request, disposition: "create", idempotencyKey: "create_binding_001" });
    expect(ensured.acceptance).toBe("accepted");

    const bindingFacts = await adapter.reconcileBinding(request);
    const binding = bindingFacts.find((fact) => fact.kind === "binding_observed");
    expect(binding?.payload.nativeBindingRef).toBe("ses_native_001");

    const activeRequest = { ...request, nativeBindingRef: "ses_native_001" };
    const delivery = await adapter.submitDelivery({
      ...activeRequest,
      inputSubmissionId: "input_001",
      invocationId: "invocation_001",
      idempotencyKey: "delivery_001",
      content: "Return only native transport evidence.",
    });
    expect(delivery.acceptance).toBe("accepted");

    const observed = await adapter.reconcileBinding(activeRequest);
    expect(observed.slice(0, 2).map((fact) => fact.kind)).toEqual(["binding_observed", "input_received"]);
    expect(observed.filter((fact) => fact.kind === "activity_observed")).toHaveLength(5);
    expect(observed[1]).toMatchObject({ correlation: { inputSubmissionId: "input_001", nativeMessageId: "msg_input_001" } });
    expect(observed.slice(1).every((fact) => fact.correlation.invocationId === "invocation_001")).toBe(true);
    expect(observed.filter((fact) => fact.kind === "assistant_final")).toHaveLength(1);
    expect(observed.find((fact) => fact.kind === "assistant_final")).toMatchObject({
      correlation: { inputSubmissionId: "input_001", nativeMessageId: "msg_assistant_final_001" },
      payload: { content: "OPENCODE_FINAL_OK\nSECOND_COMPLETED", finish: "stop" },
    });
    expect(String(observed.find((fact) => fact.kind === "assistant_final")?.payload.content)).not.toContain("PARTIAL_SHOULD_NOT_FINAL");
    expect(String(observed.find((fact) => fact.kind === "assistant_final")?.payload.content)).not.toContain("IGNORED_FINAL");
    expect(String(observed.find((fact) => fact.kind === "assistant_final")?.payload.content)).not.toContain("SYNTHETIC_FINAL");
    expect(observed.filter((fact) => fact.kind === "turn_completed")).toHaveLength(1);
    expect(observed.find((fact) => fact.kind === "turn_completed")?.correlation.nativeMessageId).toBe("msg_assistant_final_001");
    const toolActivity = observed.find((fact) => fact.kind === "activity_observed" && fact.payload.category === "tool");
    expect(toolActivity).toMatchObject({
      correlation: { inputSubmissionId: "input_001" },
      payload: {
        schemaVersion: 1,
        activityId: expect.stringMatching(/^activity_[A-Za-z0-9-]{12,80}$/),
        phase: "completed",
        title: "Tool · read",
        updateMode: "replace",
        sequence: 2,
      },
    });
    expect(JSON.stringify(toolActivity?.payload)).not.toContain("/tmp/native-workspace");
    expect(JSON.stringify(toolActivity?.payload)).not.toContain("secret-token");
    expect(JSON.stringify(toolActivity?.payload)).not.toContain("Bearer native-secret");
    expect(JSON.stringify(toolActivity?.payload)).not.toContain("native-private-key-material");
    expect(JSON.stringify(toolActivity?.payload)).not.toContain("github_pat_nativeSecret123");
    expect(JSON.stringify(toolActivity?.payload)).not.toContain("ghp_nativeSecret123");
    expect(JSON.stringify(toolActivity?.payload)).not.toContain("AKIA1234567890ABCDEF");
    expect(JSON.stringify(toolActivity?.payload)).not.toContain("native-user:native-password@");
    expect(JSON.stringify(toolActivity?.payload)).not.toContain("/opt/native-host/credentials.txt");
    expect(String(toolActivity?.payload.content).length).toBeLessThanOrEqual(16_000);
    const changeActivity = observed.find((fact) => fact.kind === "activity_observed" && fact.payload.category === "change");
    expect(changeActivity).toMatchObject({
      payload: {
        phase: "completed",
        title: "File changes",
        detail: "2 files",
        content: "src/changed-a.ts\nsrc/changed-b.ts",
        updateMode: "replace",
      },
    });
    expect(JSON.stringify(changeActivity?.payload)).not.toContain("native-patch-hash");
    expect(JSON.stringify(changeActivity?.payload)).not.toContain("/tmp/native-workspace");
    expect(JSON.stringify(changeActivity?.payload)).not.toContain("../");
    expect(JSON.stringify(changeActivity?.payload)).not.toContain("/etc/");

    const replayed = await adapter.reconcileBinding(activeRequest);
    expect(replayed.map((fact) => fact.providerFactId)).toEqual(observed.map((fact) => fact.providerFactId));

    const prompt = fixture.calls.find((call) => call.method === "POST" && call.url.pathname.endsWith("/prompt_async"));
    expect(prompt).toBeDefined();
    expect(JSON.parse(prompt!.body!)).toMatchObject({
      messageID: "msg_input_001",
      model: { providerID: "opencode-go", modelID: "gpt-5.6-luna" },
      system: expect.stringContaining("Coordinate this Task using only Runtime dispatch."),
      tools: {},
      parts: [{ type: "text", text: "Return only native transport evidence." }],
    });
    expect(fixture.calls.some((call) => call.method === "POST" && call.url.pathname.endsWith("/message"))).toBe(false);

  });

  it("fails closed when history has multiple successful terminal children for one input", async () => {
    const fixture = createServerFixture({ duplicateSuccessfulTerminal: true });
    const transport = createOpenCodeServerTransport({ baseUrl: "http://127.0.0.1:47123", fetchFn: fixture.fetchFn });
    const protocol = await transport.inspectProtocol!();
    const profile = profileFor(protocol);
    const adapter = createOpenCodeProviderAdapter({ transport, protocol });
    const request = bindingRequest(profile);

    await adapter.ensureBinding({ ...request, disposition: "create", idempotencyKey: "create_binding_ambiguous" });
    const active = { ...request, nativeBindingRef: "ses_native_001" };
    await adapter.submitDelivery({
      ...active,
      inputSubmissionId: "input_001",
      invocationId: "invocation_001",
      idempotencyKey: "delivery_ambiguous",
      content: "Return one unambiguous terminal response.",
    });

    const facts = await adapter.reconcileBinding(active);

    expect(facts.filter((fact) => fact.kind === "input_received")).toHaveLength(1);
    expect(facts.filter((fact) => fact.kind === "activity_observed").length).toBeGreaterThan(0);
    expect(facts.filter((fact) => fact.kind === "assistant_final")).toHaveLength(0);
    expect(facts.filter((fact) => fact.kind === "turn_completed")).toHaveLength(0);
    expect(facts.filter((fact) => fact.kind === "turn_failed")).toHaveLength(0);
  });

  it("streams text and tool activity while keeping tool-calls non-terminal", async () => {
    const fixture = createServerFixture();
    const transport = createOpenCodeServerTransport({ baseUrl: "http://127.0.0.1:47123", fetchFn: fixture.fetchFn });
    const protocol = await transport.inspectProtocol!();
    const profile = profileFor(protocol);
    const adapter = createOpenCodeProviderAdapter({ transport, protocol });
    const request = bindingRequest(profile);
    await adapter.ensureBinding({ ...request, disposition: "create", idempotencyKey: "create_binding_stream" });
    const active = { ...request, nativeBindingRef: "ses_native_001" };
    await adapter.submitDelivery({
      ...active,
      inputSubmissionId: "input_001",
      invocationId: "invocation_001",
      idempotencyKey: "delivery_stream",
      content: "Use one tool, then return the final marker.",
    });

    const facts: ProviderFact[] = [];
    for await (const fact of adapter.observeBinding(active)) facts.push(fact);

    expect(facts.filter((fact) => fact.kind === "input_received")).toHaveLength(1);
    const toolActivities = facts.filter((fact) => fact.kind === "activity_observed" && fact.payload.category === "tool");
    expect(toolActivities.map((fact) => fact.payload.phase)).toEqual(["started", "progress", "completed"]);
    expect(toolActivities.map((fact) => fact.payload.sequence)).toEqual([0, 1, 2]);
    expect(new Set(toolActivities.map((fact) => fact.payload.activityId))).toHaveProperty("size", 1);
    expect(String(toolActivities.at(-1)?.payload.content).length).toBeLessThanOrEqual(16_000);
    const changeActivities = facts.filter((fact) => fact.kind === "activity_observed" && fact.payload.category === "change");
    expect(changeActivities).toHaveLength(1);
    expect(changeActivities[0]?.payload).toMatchObject({
      phase: "completed",
      title: "File changes",
      detail: "2 files",
      content: "src/changed-a.ts\nsrc/changed-b.ts",
      updateMode: "replace",
    });
    const assistantActivities = facts.filter((fact) => fact.kind === "activity_observed" && fact.payload.category === "assistant_progress");
    expect(assistantActivities.map((fact) => [fact.payload.phase, fact.payload.updateMode, fact.payload.content])).toEqual([
      ["started", "replace", ""],
      ["progress", "append", "LIVE_"],
      ["progress", "append", "FINAL"],
      ["completed", "replace", "LIVE_FINAL"],
    ]);
    expect(assistantActivities.map((fact) => fact.payload.sequence)).toEqual([0, 1, 2, 3]);
    expect(facts.filter((fact) => fact.kind === "assistant_final")).toHaveLength(1);
    expect(facts.find((fact) => fact.kind === "assistant_final")?.payload.content).toBe("LIVE_FINAL");
    expect(facts.filter((fact) => fact.kind === "turn_completed")).toHaveLength(1);
    expect(facts.find((fact) => fact.kind === "turn_completed")?.correlation.nativeMessageId).toBe("msg_assistant_live_final");
    for (const activity of [...toolActivities, ...assistantActivities, ...changeActivities]) {
      expect(activity.correlation).toMatchObject({ inputSubmissionId: "input_001", invocationId: "invocation_001" });
      expect(activity.payload.activityId).toMatch(/^activity_[A-Za-z0-9-]{12,80}$/);
    }
    const activityJson = JSON.stringify([...toolActivities, ...assistantActivities, ...changeActivities].map((fact) => fact.payload));
    expect(activityJson).not.toContain("/tmp/native-workspace");
    expect(activityJson).not.toContain("secret-token");
    expect(activityJson).not.toContain("native-secret");
    expect(activityJson).not.toContain("call_native_secret");
    expect(activityJson).not.toContain("native-patch-hash");
    expect(activityJson).not.toContain("native-private-key-material");
    expect(activityJson).not.toContain("github_pat_nativeSecret123");
    expect(activityJson).not.toContain("ghp_nativeSecret123");
    expect(activityJson).not.toContain("AKIA1234567890ABCDEF");
    expect(activityJson).not.toContain("native-user:native-password@");
    expect(activityJson).not.toContain("/opt/native-host/credentials.txt");
    expect(activityJson).not.toContain("../");
  });

  it("uses a new source-instance cursor identity for id-less SSE after transport reconstruction", async () => {
    const fixture = createServerFixture({ includeEventIds: false });
    const firstTransport = createOpenCodeServerTransport({ baseUrl: "http://127.0.0.1:47123", fetchFn: fixture.fetchFn });
    const protocol = await firstTransport.inspectProtocol!();
    const profile = profileFor(protocol);
    const request = bindingRequest(profile);
    const active = { ...request, nativeBindingRef: "ses_native_001" };
    const first = createOpenCodeProviderAdapter({ transport: firstTransport, protocol });
    await first.ensureBinding({ ...request, disposition: "create", idempotencyKey: "create_binding_idless_1" });
    await first.submitDelivery({
      ...active,
      inputSubmissionId: "input_001",
      idempotencyKey: "delivery_idless_1",
      content: "Stream without native event ids.",
    });
    const firstFacts: ProviderFact[] = [];
    for await (const fact of first.observeBinding(active)) firstFacts.push(fact);

    const secondTransport = createOpenCodeServerTransport({ baseUrl: "http://127.0.0.1:47123", fetchFn: fixture.fetchFn });
    const second = createOpenCodeProviderAdapter({ transport: secondTransport, protocol });
    await second.ensureBinding({ ...active, disposition: "resume", idempotencyKey: "resume_binding_idless_2" });
    const secondFacts: ProviderFact[] = [];
    for await (const fact of second.observeBinding(active)) secondFacts.push(fact);

    const deltaFrom = (facts: readonly ProviderFact[]) => facts.find((fact) => fact.kind === "activity_observed"
      && fact.payload.category === "assistant_progress"
      && fact.payload.updateMode === "append"
      && fact.payload.content === "LIVE_");
    const firstDelta = deltaFrom(firstFacts);
    const secondDelta = deltaFrom(secondFacts);
    expect(firstDelta?.payload).toEqual(secondDelta?.payload);
    expect(firstDelta?.deduplication.providerEventId).toBeUndefined();
    expect(secondDelta?.deduplication.providerEventId).toBeUndefined();
    expect(firstDelta?.deduplication.sourceInstanceId).toMatch(/^opencode-sse-/);
    expect(secondDelta?.deduplication.sourceInstanceId).toMatch(/^opencode-sse-/);
    expect(firstDelta?.deduplication.sourceInstanceId).not.toBe(secondDelta?.deduplication.sourceInstanceId);
    expect(firstDelta?.deduplication.cursor).toBeDefined();
    expect(secondDelta?.deduplication.cursor).toBeDefined();
    expect(firstDelta?.providerFactId).not.toBe(secondDelta?.providerFactId);
  });

  it("recovers a persisted native session reference without creating another native session", async () => {
    const fixture = createServerFixture();
    const transport = createOpenCodeServerTransport({ baseUrl: "http://127.0.0.1:47123", fetchFn: fixture.fetchFn });
    const protocol = await transport.inspectProtocol!();
    const adapter = createOpenCodeProviderAdapter({ transport, protocol });
    const request = {
      ...bindingRequest(profileFor(protocol)),
      nativeBindingRef: "ses_native_001",
    };

    const effect = await adapter.ensureBinding({ ...request, disposition: "resume", idempotencyKey: "resume_001" });
    expect(effect.acceptance).toBe("accepted");
    expect(fixture.calls.some((call) => call.method === "POST" && call.url.pathname === "/session")).toBe(false);
    expect(fixture.calls.some((call) => call.method === "GET" && call.url.pathname === "/session/ses_native_001")).toBe(true);
  });

  it("marks an interrupt-requiring Profile unavailable", async () => {
    const fixture = createServerFixture();
    const transport = createOpenCodeServerTransport({ baseUrl: "http://127.0.0.1:47123", fetchFn: fixture.fetchFn });
    const protocol = await transport.inspectProtocol!();
    const adapter = createOpenCodeProviderAdapter({ transport, protocol });

    const report = await adapter.describeCapabilities(profileFor(protocol, { requiresInterrupt: true }));

    expect(report).toMatchObject({ available: false });
    expect(report.capabilities).not.toContain("interrupt");
    expect(report.unavailableReasons).toContain("capability_interrupt_unavailable");
  });

  it("rediscovers a metadata-marked Session after a crash between native create and binding fact persistence", async () => {
    const fixture = createServerFixture();
    const firstTransport = createOpenCodeServerTransport({ baseUrl: "http://127.0.0.1:47123", fetchFn: fixture.fetchFn });
    const protocol = await firstTransport.inspectProtocol!();
    const profile = profileFor(protocol);
    const request = bindingRequest(profile);
    const first = createOpenCodeProviderAdapter({ transport: firstTransport, protocol });
    await first.ensureBinding({ ...request, disposition: "create", idempotencyKey: "create_binding_crash_window" });

    const restartedTransport = createOpenCodeServerTransport({ baseUrl: "http://127.0.0.1:47123", fetchFn: fixture.fetchFn });
    const restarted = createOpenCodeProviderAdapter({ transport: restartedTransport, protocol });
    const effect = await restarted.ensureBinding({ ...request, disposition: "create", idempotencyKey: "create_binding_crash_window" });
    const facts = await restarted.reconcileBinding(request);

    expect(effect.acceptance).toBe("accepted");
    expect(facts.find((fact) => fact.kind === "binding_observed")?.payload.nativeBindingRef).toBe("ses_native_001");
    expect(fixture.calls.filter((call) => call.method === "POST" && call.url.pathname === "/session")).toHaveLength(1);
  });

  it("does not turn an accepted abort or an idle Session into a terminal fact without native abort evidence", async () => {
    const fixture = createServerFixture({ emitNativeAbort: false });
    const transport = createOpenCodeServerTransport({ baseUrl: "http://127.0.0.1:47123", fetchFn: fixture.fetchFn });
    const protocol = await transport.inspectProtocol!();
    const adapter = createOpenCodeProviderAdapter({ transport, protocol });
    const request = bindingRequest(profileFor(protocol));
    await adapter.ensureBinding({ ...request, disposition: "create", idempotencyKey: "create_binding_002" });
    const nativeBindingRef = (await adapter.reconcileBinding(request)).find((fact) => fact.kind === "binding_observed")!.payload.nativeBindingRef as string;
    const active = { ...request, nativeBindingRef };
    await adapter.submitDelivery({ ...active, inputSubmissionId: "input_001", idempotencyKey: "delivery_002", content: "Wait for native evidence." });
    await adapter.requestInterrupt({ ...active, idempotencyKey: "interrupt_002" });

    const facts = await adapter.reconcileBinding(active);
    expect(facts.some((fact) => fact.kind === "native_terminal")).toBe(false);
    expect(facts.some((fact) => fact.kind === "interrupt_confirmed")).toBe(false);
  });

  it("correlates an interrupt only to the active input and invocation", async () => {
    const fixture = createInterruptCorrelationFixture();
    const transport = createOpenCodeServerTransport({ baseUrl: "http://127.0.0.1:47123", fetchFn: fixture.fetchFn });
    const protocol = await transport.inspectProtocol!();
    const request = bindingRequest(profileFor(protocol));
    // This is a transport-only correlation regression. The direct adapter must
    // reject this unverified operation, but the transport still needs to avoid
    // attaching an old native abort record to a newer input.
    await transport.request({
      operation: "ensure_binding",
      request: { ...request, disposition: "create", idempotencyKey: "create_binding_interrupt_correlation" },
    });
    const active = { ...request, nativeBindingRef: "ses_interrupt_001" };

    await transport.request({ operation: "submit_delivery", request: {
      ...active, inputSubmissionId: "input_001", invocationId: "invocation_001",
      idempotencyKey: "delivery_interrupt_correlation_001", content: "First input.",
    } });
    await transport.request({ operation: "submit_delivery", request: {
      ...active, inputSubmissionId: "input_002", invocationId: "invocation_002",
      idempotencyKey: "delivery_interrupt_correlation_002", content: "Second input.",
    } });
    const staleTarget = await transport.request({ operation: "request_interrupt", request: {
      ...active, inputSubmissionId: "input_001", idempotencyKey: "interrupt_correlation_stale",
    } });
    const interrupt = await transport.request({ operation: "request_interrupt", request: {
      ...active, idempotencyKey: "interrupt_correlation_001",
    } });
    const reconciliation = await transport.reconcile!({ operation: "reconcile_binding", request: active });
    const facts = ("facts" in reconciliation ? reconciliation.facts : reconciliation) as ReadonlyArray<{ readonly type?: string; readonly inputSubmissionId?: string; readonly invocationId?: string }>;

    expect(staleTarget.accepted).toBe(false);
    expect(interrupt.accepted).toBe(true);
    expect(facts.filter((fact) => fact.type === "opencode.interrupt.confirmed")).toHaveLength(1);
    expect(facts.find((fact) => fact.type === "opencode.interrupt.confirmed")).toMatchObject({
      inputSubmissionId: "input_002", invocationId: "invocation_002",
    });
    expect(facts.filter((fact) => fact.type === "opencode.native.terminal")).toHaveLength(1);
    expect(facts.find((fact) => fact.type === "opencode.native.terminal")).toMatchObject({
      inputSubmissionId: "input_002", invocationId: "invocation_002",
    });
    expect(facts.find((fact) => fact.type === "opencode.turn.failed")).toMatchObject({
      inputSubmissionId: "input_001",
    });
  });
});

function profileFor(
  protocol: { readonly providerVersion: string; readonly protocolFingerprint: string },
  { requiresInterrupt = false }: { readonly requiresInterrupt?: boolean } = {},
): ExecutionProfileDefinition {
  return {
    executionProfileId: "profile_opencode_server",
    provider: "opencode",
    model: "opencode-go/gpt-5.6-luna",
    providerVersion: protocol.providerVersion,
    protocolFingerprint: protocol.protocolFingerprint,
    capabilityPolicy: {
      requiredCapabilities: [
        "create_binding",
        "input_correlation",
        "provider_receipt",
        "reconcile",
        ...(requiresInterrupt ? (["interrupt"] as const) : []),
      ],
      allowedTools: [],
      permissionMode: "ask",
      maxConcurrentTurns: 1,
      maxNativeChildren: 0,
    },
  };
}

function bindingRequest(profile: ExecutionProfileDefinition): ProviderPortBindingRequest {
  return {
    bindingId: "binding_native_001",
    bindingRevision: 1,
    executionProfile: profile,
    workspace: { workspaceId: "workspace_native", cwd: "/tmp/native-workspace" },
    bootstrap: {
      purpose: "task_conductor",
      agentCardId: "agent_card_conductor",
      systemPrompt: "Coordinate this Task using only Runtime dispatch.",
      capabilityRefs: [],
      dispatchRegistry: [],
    },
  };
}

function createServerFixture({
  emitNativeAbort = true,
  includeEventIds = true,
  duplicateSuccessfulTerminal = false,
}: {
  readonly emitNativeAbort?: boolean;
  readonly includeEventIds?: boolean;
  readonly duplicateSuccessfulTerminal?: boolean;
} = {}) {
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
    id: "ses_native_001",
    title: "Agent Workspace binding_native_001",
    metadata: { agentWorkspace: { bindingId: "binding_native_001", bindingRevision: 1 } },
    time: { created: 1, updated: 2 },
  };
  let created = false;
  let delivered = false;
  let interrupted = false;
  const calls: Array<{ readonly url: URL; readonly method: string; readonly body?: string }> = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? init.body : undefined;
    calls.push({ url, method, ...(body ? { body } : {}) });
    if (method === "GET" && url.pathname === "/global/health") return json({ healthy: true, version: "1.18.13" });
    if (method === "GET" && url.pathname === "/doc") return json(openApi);
    if (method === "POST" && url.pathname === "/session") {
      created = true;
      return json(session);
    }
    if (method === "GET" && url.pathname === "/session") return json(created ? [session] : []);
    if (method === "GET" && url.pathname === "/session/ses_native_001") return json(session);
    if (method === "POST" && url.pathname === "/session/ses_native_001/prompt_async") {
      delivered = true;
      return new Response(null, { status: 204 });
    }
    if (method === "GET" && url.pathname === "/event") {
      return sse(delivered ? liveEvents({ includeEventIds }) : []);
    }
    if (method === "GET" && url.pathname === "/session/ses_native_001/message") {
      return json(delivered ? [
        { info: { id: "msg_input_001", role: "user" } },
        interrupted
          ? { info: { id: "msg_assistant_001", parentID: "msg_input_001", role: "assistant", error: { name: "MessageAbortedError" }, time: { completed: Date.now() } } }
          : {
              info: { id: "msg_assistant_tool_001", parentID: "msg_input_001", role: "assistant", finish: "tool-calls", time: { completed: 2 } },
              parts: [
                {
                  id: "prt_tool_001",
                  sessionID: "ses_native_001",
                  messageID: "msg_assistant_tool_001",
                  type: "tool",
                  callID: "call_native_secret",
                  tool: "read",
                  state: {
                    status: "completed",
                    input: { filePath: "/tmp/native-workspace/package.json", token: "secret-token" },
                    title: "/tmp/native-workspace/package.json",
                    output: unsafeToolOutput(),
                    time: { start: 1, end: 2 },
                  },
                },
                {
                  id: "prt_patch_001",
                  sessionID: "ses_native_001",
                  messageID: "msg_assistant_tool_001",
                  type: "patch",
                  hash: "native-patch-hash",
                  files: [
                    "/tmp/native-workspace/src/changed-a.ts",
                    "src/changed-b.ts",
                    "/tmp/native-workspace/../outside.ts",
                    "src/../unsafe.ts",
                    "/etc/passwd",
                  ],
                },
              ],
            },
        ...(!interrupted ? [{
          info: { id: "msg_assistant_final_001", parentID: "msg_input_001", role: "assistant", finish: "stop", time: { completed: 3 } },
          parts: [
            {
              id: "prt_text_001",
              sessionID: "ses_native_001",
              messageID: "msg_assistant_final_001",
              type: "text",
              text: "OPENCODE_FINAL_OK",
              time: { start: 2, end: 3 },
            },
            {
              id: "prt_text_partial",
              sessionID: "ses_native_001",
              messageID: "msg_assistant_final_001",
              type: "text",
              text: "PARTIAL_SHOULD_NOT_FINAL",
              time: { start: 3 },
            },
            {
              id: "prt_text_002",
              sessionID: "ses_native_001",
              messageID: "msg_assistant_final_001",
              type: "text",
              text: "SECOND_COMPLETED",
              time: { start: 3, end: 4 },
            },
            {
              id: "prt_text_ignored",
              sessionID: "ses_native_001",
              messageID: "msg_assistant_final_001",
              type: "text",
              text: "IGNORED_FINAL",
              ignored: true,
              time: { start: 3, end: 4 },
            },
            {
              id: "prt_text_synthetic",
              sessionID: "ses_native_001",
              messageID: "msg_assistant_final_001",
              type: "text",
              text: "SYNTHETIC_FINAL",
              synthetic: true,
              time: { start: 3, end: 4 },
            },
          ],
        }] : []),
        ...(!interrupted && duplicateSuccessfulTerminal ? [{
          info: {
            id: "msg_assistant_final_ambiguous",
            parentID: "msg_input_001",
            role: "assistant",
            finish: "stop",
            time: { completed: 5 },
          },
          parts: [{
            id: "prt_text_ambiguous",
            sessionID: "ses_native_001",
            messageID: "msg_assistant_final_ambiguous",
            type: "text",
            text: "AMBIGUOUS_OTHER_FINAL",
            time: { start: 4, end: 5 },
          }],
        }] : []),
      ] : []);
    }
    if (method === "POST" && url.pathname === "/session/ses_native_001/abort") {
      interrupted = emitNativeAbort;
      return json(true);
    }
    if (method === "GET" && url.pathname === "/session/status") return json({});
    return new Response(JSON.stringify({ error: `${method} ${url.pathname}` }), { status: 404, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  expect(openCodeServerProtocolFingerprint(openApi)).toMatch(/^sha256:/);
  return { fetchFn, calls };
}

function createInterruptCorrelationFixture() {
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
    id: "ses_interrupt_001",
    title: "Agent Workspace binding_native_001",
    metadata: { agentWorkspace: { bindingId: "binding_native_001", bindingRevision: 1 } },
    time: { created: 1, updated: 2 },
  };
  let created = false;
  let interrupted = false;
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    if (method === "GET" && url.pathname === "/global/health") return json({ healthy: true, version: "1.18.13" });
    if (method === "GET" && url.pathname === "/doc") return json(openApi);
    if (method === "POST" && url.pathname === "/session") {
      created = true;
      return json(session);
    }
    if (method === "GET" && url.pathname === "/session") return json(created ? [session] : []);
    if (method === "GET" && url.pathname === "/session/ses_interrupt_001") return json(session);
    if (method === "POST" && url.pathname === "/session/ses_interrupt_001/prompt_async") return new Response(null, { status: 204 });
    if (method === "POST" && url.pathname === "/session/ses_interrupt_001/abort") {
      interrupted = true;
      return json(true);
    }
    if (method === "GET" && url.pathname === "/session/ses_interrupt_001/message") {
      return json(interrupted ? [
        { info: { id: "msg_input_001", role: "user" } },
        { info: { id: "msg_input_002", role: "user" } },
        { info: { id: "msg_assistant_stale", parentID: "msg_input_001", role: "assistant", error: { name: "MessageAbortedError" }, time: { completed: Date.now() } } },
        { info: { id: "msg_assistant_target", parentID: "msg_input_002", role: "assistant", error: { name: "MessageAbortedError" }, time: { completed: Date.now() } } },
      ] : []);
    }
    if (method === "GET" && url.pathname === "/session/status") return json({});
    return new Response(JSON.stringify({ error: `${method} ${url.pathname}` }), { status: 404, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fetchFn };
}

function liveEvents({ includeEventIds }: { readonly includeEventIds: boolean }): readonly unknown[] {
  const toolPart = (status: "pending" | "running" | "completed") => ({
    id: "prt_tool_live",
    sessionID: "ses_native_001",
    messageID: "msg_assistant_live_tool",
    type: "tool",
    callID: "call_native_secret",
    tool: "read",
    state: status === "pending"
      ? { status, input: { filePath: "/tmp/native-workspace/package.json", token: "secret-token" }, raw: "secret-token" }
      : status === "running"
        ? { status, input: { filePath: "/tmp/native-workspace/package.json", token: "secret-token" }, title: "/tmp/native-workspace/package.json", time: { start: 1 } }
        : {
            status,
            input: { filePath: "/tmp/native-workspace/package.json", token: "secret-token" },
            title: "/tmp/native-workspace/package.json",
            output: unsafeToolOutput(),
            metadata: {},
            time: { start: 1, end: 2 },
          },
  });
  const event = (id: string, type: string, properties: unknown) => ({
    ...(includeEventIds ? { id } : {}),
    type,
    properties,
  });
  return [
    event("evt_user", "message.updated", {
      sessionID: "ses_native_001",
      info: { id: "msg_input_001", sessionID: "ses_native_001", role: "user" },
    }),
    event("evt_tool_message_start", "message.updated", {
      sessionID: "ses_native_001",
      info: { id: "msg_assistant_live_tool", sessionID: "ses_native_001", parentID: "msg_input_001", role: "assistant" },
    }),
    event("evt_tool_pending", "message.part.updated", { sessionID: "ses_native_001", part: toolPart("pending"), time: 1 }),
    event("evt_tool_running", "message.part.updated", { sessionID: "ses_native_001", part: toolPart("running"), time: 2 }),
    event("evt_tool_completed", "message.part.updated", { sessionID: "ses_native_001", part: toolPart("completed"), time: 3 }),
    event("evt_patch_completed", "message.part.updated", {
      sessionID: "ses_native_001",
      part: {
        id: "prt_patch_live",
        sessionID: "ses_native_001",
        messageID: "msg_assistant_live_tool",
        type: "patch",
        hash: "native-patch-hash",
        files: [
          "/tmp/native-workspace/src/changed-a.ts",
          "src/changed-b.ts",
          "/tmp/native-workspace/../outside.ts",
          "src/../unsafe.ts",
          "/etc/passwd",
        ],
      },
      time: 3,
    }),
    event("evt_tool_message_end", "message.updated", {
      sessionID: "ses_native_001",
      info: { id: "msg_assistant_live_tool", sessionID: "ses_native_001", parentID: "msg_input_001", role: "assistant", finish: "tool-calls", time: { completed: 3 } },
    }),
    event("evt_final_message_start", "message.updated", {
      sessionID: "ses_native_001",
      info: { id: "msg_assistant_live_final", sessionID: "ses_native_001", parentID: "msg_input_001", role: "assistant" },
    }),
    event("evt_text_start", "message.part.updated", {
      sessionID: "ses_native_001",
      part: { id: "prt_text_live", sessionID: "ses_native_001", messageID: "msg_assistant_live_final", type: "text", text: "", time: { start: 4 } },
      time: 4,
    }),
    event("evt_text_delta_1", "message.part.delta", {
      sessionID: "ses_native_001", messageID: "msg_assistant_live_final", partID: "prt_text_live", field: "text", delta: "LIVE_",
    }),
    event("evt_text_delta_2", "message.part.delta", {
      sessionID: "ses_native_001", messageID: "msg_assistant_live_final", partID: "prt_text_live", field: "text", delta: "FINAL",
    }),
    event("evt_text_delta_2", "message.part.delta", {
      sessionID: "ses_native_001", messageID: "msg_assistant_live_final", partID: "prt_text_live", field: "text", delta: "FINAL",
    }),
    event("evt_text_completed", "message.part.updated", {
      sessionID: "ses_native_001",
      part: { id: "prt_text_live", sessionID: "ses_native_001", messageID: "msg_assistant_live_final", type: "text", text: "LIVE_FINAL", time: { start: 4, end: 5 } },
      time: 5,
    }),
    event("evt_final_message_end", "message.updated", {
      sessionID: "ses_native_001",
      info: { id: "msg_assistant_live_final", sessionID: "ses_native_001", parentID: "msg_input_001", role: "assistant", finish: "stop", time: { completed: 5 } },
    }),
    // OpenCode can replay the same terminal snapshot on the SSE connection.
    event("evt_final_message_end_replay", "message.updated", {
      sessionID: "ses_native_001",
      info: { id: "msg_assistant_live_final", sessionID: "ses_native_001", parentID: "msg_input_001", role: "assistant", finish: "stop", time: { completed: 5 } },
    }),
  ];
}

function sse(events: readonly unknown[]): Response {
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function unsafeToolOutput(): string {
  return [
    "Read /tmp/native-workspace/package.json and /opt/native-host/credentials.txt",
    "Authorization: Bearer native-secret token=secret-token",
    "github_pat_nativeSecret123 ghp_nativeSecret123 AKIA1234567890ABCDEF",
    "https://native-user:native-password@example.invalid/resource",
    "-----BEGIN PRIVATE KEY-----",
    "native-private-key-material",
    "-----END PRIVATE KEY-----",
    "x".repeat(100_000),
  ].join("\n");
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
}

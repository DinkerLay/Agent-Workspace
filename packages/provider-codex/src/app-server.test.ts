import { describe, expect, it } from "vitest";
import type { ExecutionProfileDefinition } from "../../runtime-contracts/src/index";
import {
  providerFactDedupKey,
  type ProviderFact,
  type EnsureBindingRequest,
  type NativeProviderFact,
  type ProviderPortBindingRequest,
  type ProtocolPin,
} from "../../provider-port/src/index";
import {
  CODEX_APP_SERVER_PROVEN_CORE_CAPABILITIES,
  createCodexAppServerProviderAdapter,
  createCodexAppServerTransport,
  type CodexAppServerConnection,
  type CodexAppServerConnectionFactory,
  type CodexAppServerConnectionInput,
  type CodexAppServerInboundMessage,
  type CodexAppServerJsonRpcId,
} from "./app-server";

const PROTOCOL: ProtocolPin = Object.freeze({
  providerVersion: "0.146.0",
  protocolFingerprint: `sha256:${"b".repeat(64)}`,
});

describe("Codex App Server Provider transport", () => {
  it("keeps one native thread per Binding, correlates input, and waits for native interruption before terminal facts", async () => {
    const connection = new FakeConnection();
    const factory = new FakeFactory(connection);
    const transport = createCodexAppServerTransport({
      connectionFactory: factory,
      protocol: PROTOCOL,
      safety: { approvalPolicy: "untrusted", sandbox: "read-only", networkAccess: false },
      verifiedCapabilities: CODEX_APP_SERVER_PROVEN_CORE_CAPABILITIES,
    });
    const binding = bindingRequest();

    expect(transport.verifiedCapabilities).toEqual(CODEX_APP_SERVER_PROVEN_CORE_CAPABILITIES);
    const ensured = await transport.request({ operation: "ensure_binding", request: { ...binding, disposition: "create" } satisfies EnsureBindingRequest });
    expect(ensured).toMatchObject({ acceptance: "accepted", transportRequestId: "thread_1" });
    expect(connection.requestFor("thread/start")?.params).toEqual({
      model: "gpt-5.1-codex",
      cwd: "/trusted/workspace",
      developerInstructions: [
        "Agent Workspace role: Task Conductor.",
        "Follow the following immutable session instructions:",
        "Coordinate this Task using only Runtime dispatch.",
        "Task achievement is an explicit user decision. Never claim or infer Achieve.",
      ].join("\n\n"),
      approvalPolicy: "untrusted",
      sandbox: "read-only",
      ephemeral: false,
    });

    const nativeEvents = await transport.observe!({ operation: "observe_binding", request: binding });
    const stream = nativeEvents[Symbol.asyncIterator]();
    expect(await stream.next()).toMatchObject({
      value: { kind: "binding_observed", payload: { nativeBindingRef: "thread_1" } },
    });

    await expect(transport.request({
      operation: "submit_delivery",
      request: {
        ...binding,
        inputSubmissionId: "input_1",
        invocationId: "invocation_1",
        idempotencyKey: "input:1",
        content: "implement and verify",
      },
    })).resolves.toMatchObject({ acceptance: "accepted", transportRequestId: "turn_1" });
    expect(connection.requestFor("turn/start")?.params).toEqual({
      threadId: "thread_1",
      clientUserMessageId: "input_1",
      input: [{ type: "text", text: "implement and verify" }],
    });
    expect(await stream.next()).toMatchObject({ value: { kind: "input_received", inputSubmissionId: "input_1", nativeTurnId: "turn_1" } });
    expect(await stream.next()).toMatchObject({ value: { kind: "turn_started", invocationId: "invocation_1", nativeTurnId: "turn_1" } });

    await expect(transport.request({
      operation: "request_interrupt",
      request: { ...binding, invocationId: "invocation_1", idempotencyKey: "interrupt:1" },
    })).resolves.toMatchObject({ acceptance: "accepted", transportRequestId: "turn_1" });
    expect(connection.requestFor("turn/interrupt")?.params).toEqual({ threadId: "thread_1", turnId: "turn_1" });
    const beforeNativeConfirmation = await reconcileFacts(transport, binding);
    expect(beforeNativeConfirmation.some((fact) => fact.kind === "interrupt_confirmed" || fact.kind === "native_terminal")).toBe(false);

    connection.emit({ kind: "notification", method: "turn/completed", params: { threadId: "thread_1", turn: { id: "turn_1", status: "interrupted" } } });
    expect(await stream.next()).toMatchObject({ value: { kind: "interrupt_confirmed", invocationId: "invocation_1", nativeTurnId: "turn_1" } });
    expect(await stream.next()).toMatchObject({ value: { kind: "native_terminal", invocationId: "invocation_1", nativeTurnId: "turn_1" } });

    connection.emit({ kind: "server_request", id: "approval_1", method: "item/fileChange/requestApproval", params: { threadId: "thread_1" } });
    await eventually(() => connection.responses.find((response) => response.id === "approval_1"));
    expect(connection.responses).toContainEqual({ id: "approval_1", result: { decision: "decline" } });

    connection.turnStatus = "completed";
    const reconciled = await transport.reconcile!({ operation: "reconcile_binding", request: binding });
    expect(reconciled).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "input_received", inputSubmissionId: "input_1", nativeMessageId: "message_1" }),
      expect.objectContaining({ kind: "turn_completed", invocationId: "invocation_1", nativeTurnId: "turn_1" }),
    ]));

    await transport.request({ operation: "release_binding", request: binding });
    await transport.request({ operation: "release_binding", request: binding });
    expect(connection.requests.filter((request) => request.method === "thread/unsubscribe")).toHaveLength(1);
    expect(connection.closeCalls).toBe(1);
  });

  it("reports only live-proven core capabilities and leaves attention, children, and presentation absent", async () => {
    const adapter = createCodexAppServerProviderAdapter({
      connectionFactory: new FakeFactory(new FakeConnection()),
      protocol: PROTOCOL,
      safety: { approvalPolicy: "untrusted", sandbox: "read-only", networkAccess: false },
      verifiedCapabilities: CODEX_APP_SERVER_PROVEN_CORE_CAPABILITIES,
    });

    const report = await adapter.describeCapabilities(profile());
    expect(report.available).toBe(true);
    expect(report.capabilities).toEqual(CODEX_APP_SERVER_PROVEN_CORE_CAPABILITIES);
    expect(adapter.respondAttention).toBeUndefined();
    expect(adapter.openPresentation).toBeUndefined();

    const unsafe = await adapter.describeCapabilities(profile({
      capabilityPolicy: {
        requiredCapabilities: [],
        allowedTools: ["shell"],
        permissionMode: "ask",
        maxConcurrentTurns: 1,
        maxNativeChildren: 1,
      },
    }));
    expect(unsafe.available).toBe(false);
    expect(unsafe.unavailableReasons).toEqual(expect.arrayContaining([
      "codex_tool_allowlist_unproven",
      "codex_permission_mode_unproven",
    ]));
  });

  it("uses the UUID payload of a Runtime input id and restores its Runtime prefix from native history", async () => {
    const connection = new FakeConnection();
    const transport = createCodexAppServerTransport({
      connectionFactory: new FakeFactory(connection),
      protocol: PROTOCOL,
      safety: { approvalPolicy: "untrusted", sandbox: "read-only", networkAccess: false },
      verifiedCapabilities: CODEX_APP_SERVER_PROVEN_CORE_CAPABILITIES,
    });
    const binding = bindingRequest();
    await transport.request({ operation: "ensure_binding", request: { ...binding, disposition: "create" } });
    await transport.request({
      operation: "submit_delivery",
      request: {
        ...binding,
        inputSubmissionId: "input_123e4567-e89b-42d3-a456-426614174000",
        idempotencyKey: "input:uuid",
        content: "short prompt",
      },
    });
    expect(connection.requestFor("turn/start")?.params).toMatchObject({
      clientUserMessageId: "123e4567-e89b-42d3-a456-426614174000",
    });
    connection.clientMessageId = "123e4567-e89b-42d3-a456-426614174000";
    connection.turnStatus = "completed";
    const facts = await reconcileFacts(transport, binding);
    expect(facts).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "input_received", inputSubmissionId: "input_123e4567-e89b-42d3-a456-426614174000" }),
    ]));
  });

  it("maps the native final agent message to a correlated assistant_final in live events and recovery", async () => {
    const connection = new FakeConnection();
    const transport = createCodexAppServerTransport({
      connectionFactory: new FakeFactory(connection),
      protocol: PROTOCOL,
      safety: { approvalPolicy: "untrusted", sandbox: "read-only", networkAccess: false },
      verifiedCapabilities: CODEX_APP_SERVER_PROVEN_CORE_CAPABILITIES,
    });
    const binding = bindingRequest();
    await transport.request({ operation: "ensure_binding", request: { ...binding, disposition: "create" } });
    const nativeEvents = await transport.observe!({ operation: "observe_binding", request: binding });
    const stream = nativeEvents[Symbol.asyncIterator]();
    await stream.next(); // binding_observed
    await transport.request({
      operation: "submit_delivery",
      request: {
        ...binding,
        inputSubmissionId: "input_1",
        idempotencyKey: "input:final",
        content: "reply with the marker",
      },
    });
    await stream.next(); // input_received
    await stream.next(); // turn_started

    connection.emit({
      kind: "notification",
      method: "item/completed",
      params: {
        threadId: "thread_1",
        turnId: "turn_1",
        completedAtMs: 1,
        item: { type: "agentMessage", id: "agent_message_1", text: "BROWSER_TASK_OK", phase: "final_answer" },
      },
    });
    expect(await stream.next()).toMatchObject({
      value: {
        kind: "activity_observed",
        inputSubmissionId: "input_1",
        payload: {
          category: "assistant_progress",
          phase: "completed",
          content: "BROWSER_TASK_OK",
          updateMode: "replace",
        },
      },
    });
    expect(await stream.next()).toMatchObject({
      value: {
        kind: "assistant_final",
        inputSubmissionId: "input_1",
        nativeMessageId: "agent_message_1",
        nativeTurnId: "turn_1",
        payload: { content: "BROWSER_TASK_OK" },
      },
    });

    connection.agentMessageText = "BROWSER_TASK_OK";
    connection.turnStatus = "completed";
    const recovered = await reconcileFacts(transport, binding);
    expect(recovered).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "assistant_final",
        inputSubmissionId: "input_1",
        nativeMessageId: "agent_message_1",
        nativeTurnId: "turn_1",
        payload: expect.objectContaining({ content: "BROWSER_TASK_OK" }),
      }),
    ]));
  });

  it("maps bounded live tool execution and assistant deltas without exposing native paths or secrets", async () => {
    const connection = new FakeConnection();
    const adapter = createCodexAppServerProviderAdapter({
      connectionFactory: new FakeFactory(connection),
      protocol: PROTOCOL,
      safety: { approvalPolicy: "untrusted", sandbox: "read-only", networkAccess: false },
      verifiedCapabilities: CODEX_APP_SERVER_PROVEN_CORE_CAPABILITIES,
      now: () => "2026-08-09T00:00:00.000Z",
    });
    const binding = bindingRequest();
    await adapter.ensureBinding({ ...binding, disposition: "create" });
    const stream = adapter.observeBinding(binding)[Symbol.asyncIterator]();
    await stream.next(); // binding_observed
    await adapter.submitDelivery({
      ...binding,
      inputSubmissionId: "input_1",
      invocationId: "invocation_1",
      idempotencyKey: "input:activity",
      content: "run one bounded command",
    });
    await stream.next(); // input_received
    await stream.next(); // turn_started
    const hostPaths = [
      "/Users/alice/private.txt",
      "/home/alice/private.txt",
      "/private/var/private.txt",
      "/tmp/private.txt",
      "/var/tmp/private.txt",
      "/Volumes/Secret/private.txt",
      "/etc/passwd",
      "/opt/private.txt",
      "/root/private.txt",
      "/srv/private.txt",
      "/mnt/private.txt",
      "C:\\Users\\alice\\private.txt",
      "D:/work/private.txt",
    ].join(" ");

    connection.emit({
      kind: "notification",
      method: "item/started",
      params: {
        threadId: "thread_1",
        turnId: "turn_1",
        startedAtMs: 1,
        item: {
          type: "commandExecution",
          id: "native_tool_1",
          command: `API_TOKEN=top-secret pwd /trusted/workspace ${hostPaths} relative/result.txt`,
          cwd: "/trusted/workspace",
          commandActions: [],
          status: "inProgress",
        },
      },
    });
    const started = (await stream.next()).value!;
    expect(started).toMatchObject({
      kind: "activity_observed",
      correlation: { inputSubmissionId: "input_1", invocationId: "invocation_1" },
      payload: {
        schemaVersion: 1,
        activityId: expect.stringMatching(/^activity_[A-Za-z0-9-]{12,80}$/),
        category: "tool",
        phase: "started",
        title: "Shell command",
        sequence: 0,
      },
    });
    expect(String(started.payload.detail)).toContain("[workspace]");
    expect(String(started.payload.detail)).toContain("relative/result.txt");
    expect(JSON.stringify(started.payload)).not.toMatch(/native_tool_1|\/trusted\/workspace|top-secret|\/(?:Users|home|private|tmp|var|Volumes|etc|opt|root|srv|mnt)\/|\b[A-Za-z]:[\\/]/u);

    connection.emit({
      kind: "notification",
      method: "item/commandExecution/outputDelta",
      params: {
        threadId: "thread_1",
        turnId: "turn_1",
        itemId: "native_tool_1",
        delta: `working in /trusted/workspace ${hostPaths}\nAuthorization: Bearer secret-token\nrelative/result.txt`,
      },
    });
    const progress = (await stream.next()).value!;
    expect(progress).toMatchObject({
      kind: "activity_observed",
      payload: {
        activityId: started.payload.activityId,
        category: "tool",
        phase: "progress",
        updateMode: "append",
        sequence: 1,
      },
    });
    expect(String(progress.payload.content)).toContain("[workspace]");
    expect(String(progress.payload.content)).toContain("relative/result.txt");
    expect(JSON.stringify(progress.payload)).not.toMatch(/\/trusted\/workspace|secret-token|\/(?:Users|home|private|tmp|var|Volumes|etc|opt|root|srv|mnt)\/|\b[A-Za-z]:[\\/]/u);

    connection.emit({
      kind: "notification",
      method: "item/completed",
      params: {
        threadId: "thread_1",
        turnId: "turn_1",
        completedAtMs: 2,
        item: {
          type: "commandExecution",
          id: "native_tool_1",
          command: `API_TOKEN=top-secret pwd /trusted/workspace ${hostPaths} relative/result.txt`,
          cwd: "/trusted/workspace",
          commandActions: [],
          status: "completed",
          aggregatedOutput: `done in /trusted/workspace ${hostPaths}\nrelative/result.txt\nPASSWORD=hunter2\n${"x".repeat(20_000)}`,
          exitCode: 0,
          durationMs: 12,
        },
      },
    });
    const completed = (await stream.next()).value!;
    expect(completed).toMatchObject({
      kind: "activity_observed",
      payload: {
        activityId: started.payload.activityId,
        category: "tool",
        phase: "completed",
        updateMode: "replace",
        sequence: 2,
      },
    });
    expect(String(completed.payload.content)).toContain("relative/result.txt");
    expect(JSON.stringify(completed.payload)).not.toMatch(/native_tool_1|\/trusted\/workspace|top-secret|hunter2|\/(?:Users|home|private|tmp|var|Volumes|etc|opt|root|srv|mnt)\/|\b[A-Za-z]:[\\/]/u);
    expect(String(completed.payload.detail).length).toBeLessThanOrEqual(2_000);
    expect(String(completed.payload.content).length).toBeLessThanOrEqual(16_000);

    connection.emit({
      kind: "notification",
      method: "item/started",
      params: {
        threadId: "thread_1",
        turnId: "turn_1",
        item: { type: "mcpToolCall", id: "native_mcp_live", server: "safe-server", tool: "lookup", status: "inProgress" },
      },
    });
    const mcpStarted = (await stream.next()).value!;
    connection.emit({
      kind: "notification",
      method: "item/mcpToolCall/progress",
      params: {
        threadId: "thread_1",
        turnId: "turn_1",
        itemId: "native_mcp_live",
        message: `MCP read ${hostPaths} and relative/mcp-result.txt ses_native_secret_value\n-----BEGIN PRIVATE KEY-----\n${"PRIVATE_KEY_BODY".repeat(5_000)}`,
      },
    });
    const mcpProgress = (await stream.next()).value!;
    expect(mcpProgress).toMatchObject({
      kind: "activity_observed",
      payload: {
        activityId: mcpStarted.payload.activityId,
        category: "tool",
        phase: "progress",
        updateMode: "append",
      },
    });
    expect(String(mcpProgress.payload.content)).toContain("relative/mcp-result.txt");
    expect(JSON.stringify(mcpProgress.payload)).not.toMatch(/\/(?:Users|home|private|tmp|var|Volumes|etc|opt|root|srv|mnt)\/|\b[A-Za-z]:[\\/]|ses_native_secret_value|PRIVATE_KEY_BODY|BEGIN PRIVATE KEY/u);

    connection.emit({
      kind: "notification",
      method: "item/started",
      params: {
        threadId: "thread_1",
        turnId: "turn_1",
        startedAtMs: 3,
        item: { type: "agentMessage", id: "native_agent_1", text: "", phase: "final_answer" },
      },
    });
    const assistantStarted = (await stream.next()).value!;
    expect(assistantStarted).toMatchObject({
      kind: "activity_observed",
      payload: { category: "assistant_progress", phase: "started", sequence: 0 },
    });

    connection.emit({
      kind: "notification",
      method: "item/agentMessage/delta",
      params: { threadId: "thread_1", turnId: "turn_1", itemId: "native_agent_1", delta: "FINAL_" },
    });
    const assistantProgress = (await stream.next()).value!;
    expect(assistantProgress).toMatchObject({
      kind: "activity_observed",
      payload: {
        activityId: assistantStarted.payload.activityId,
        category: "assistant_progress",
        phase: "progress",
        content: "FINAL_",
        updateMode: "append",
        sequence: 1,
      },
    });

    connection.emit({
      kind: "notification",
      method: "item/completed",
      params: {
        threadId: "thread_1",
        turnId: "turn_1",
        completedAtMs: 4,
        item: { type: "agentMessage", id: "native_agent_1", text: "FINAL_OK", phase: "final_answer" },
      },
    });
    const assistantCompleted = (await stream.next()).value!;
    const final = (await stream.next()).value!;
    expect(assistantCompleted).toMatchObject({
      kind: "activity_observed",
      payload: {
        activityId: assistantStarted.payload.activityId,
        category: "assistant_progress",
        phase: "completed",
        content: "FINAL_OK",
        updateMode: "replace",
        sequence: 2,
      },
    });
    expect(final).toMatchObject({ kind: "assistant_final", payload: { content: "FINAL_OK" } });

    await adapter.releaseBinding(binding);
  });

  it("recovers content-sensitive in-progress thread snapshots without colliding with live started facts", async () => {
    const liveConnection = new FakeConnection();
    const liveAdapter = createCodexAppServerProviderAdapter({
      connectionFactory: new FakeFactory(liveConnection),
      protocol: PROTOCOL,
      safety: { approvalPolicy: "untrusted", sandbox: "read-only", networkAccess: false },
      verifiedCapabilities: CODEX_APP_SERVER_PROVEN_CORE_CAPABILITIES,
      now: () => "2026-08-09T00:00:00.000Z",
    });
    const binding = bindingRequest();
    await liveAdapter.ensureBinding({ ...binding, disposition: "create" });
    const stream = liveAdapter.observeBinding(binding)[Symbol.asyncIterator]();
    await stream.next(); // binding_observed
    await liveAdapter.submitDelivery({
      ...binding,
      inputSubmissionId: "input_1",
      invocationId: "invocation_1",
      idempotencyKey: "input:snapshot-recovery",
      content: "recover a partial tool snapshot",
    });
    await stream.next(); // input_received
    await stream.next(); // turn_started
    liveConnection.emit({
      kind: "notification",
      method: "item/started",
      params: {
        threadId: "thread_1",
        turnId: "turn_1",
        item: {
          type: "commandExecution",
          id: "native_recovery_tool",
          command: "run relative/recovery.txt",
          status: "inProgress",
        },
      },
    });
    const liveStarted = (await stream.next()).value!;
    liveConnection.emit({
      kind: "notification",
      method: "item/commandExecution/outputDelta",
      params: {
        threadId: "thread_1",
        turnId: "turn_1",
        itemId: "native_recovery_tool",
        delta: "LOST_DELTA",
      },
    });
    await stream.next(); // Simulated crash: this fact never reaches the durable Store.
    expect(liveStarted.deduplication.providerEventId).toMatch(/:started$/u);
    await liveAdapter.close();

    const recoveryConnection = new FakeConnection();
    recoveryConnection.turnStatus = "inProgress";
    const recoveredItems = (status: "inProgress" | "completed", aggregatedOutput: string) => [
      { type: "userMessage", id: "message_1", clientId: "input_1" },
      {
        type: "commandExecution",
        id: "native_recovery_tool",
        command: "run relative/recovery.txt",
        status,
        aggregatedOutput,
        ...(status === "completed" ? { exitCode: 0 } : {}),
      },
    ];
    recoveryConnection.threadItems = recoveredItems("inProgress", "RECOVERED_PARTIAL /private/host-only.txt");
    const recoveryAdapter = createCodexAppServerProviderAdapter({
      connectionFactory: new FakeFactory(recoveryConnection),
      protocol: PROTOCOL,
      safety: { approvalPolicy: "untrusted", sandbox: "read-only", networkAccess: false },
      verifiedCapabilities: CODEX_APP_SERVER_PROVEN_CORE_CAPABILITIES,
      now: () => "2026-08-09T00:00:00.000Z",
    });
    const resumedBinding = { ...binding, nativeBindingRef: "thread_1" };
    await recoveryAdapter.ensureBinding({ ...resumedBinding, disposition: "resume" });

    const firstRecovery = requiredActivity(await recoveryAdapter.reconcileBinding(resumedBinding), "native_recovery_tool");
    expect(firstRecovery).toMatchObject({
      payload: {
        activityId: liveStarted.payload.activityId,
        category: "tool",
        phase: "started",
        content: "RECOVERED_PARTIAL [path]",
        updateMode: "replace",
        sequence: 0,
      },
      deduplication: {
        reconciliationWatermark: expect.stringMatching(/:snapshot$/u),
      },
    });
    expect(firstRecovery.deduplication.providerEventId).toBeUndefined();
    expect(providerFactDedupKey(firstRecovery)).not.toBe(providerFactDedupKey(liveStarted));

    const repeatedRecovery = requiredActivity(await recoveryAdapter.reconcileBinding(resumedBinding), "native_recovery_tool");
    expect(providerFactDedupKey(repeatedRecovery)).toBe(providerFactDedupKey(firstRecovery));

    recoveryConnection.threadItems = recoveredItems("inProgress", "RECOVERED_PARTIAL_MORE /tmp/host-only.txt");
    const grownRecovery = requiredActivity(await recoveryAdapter.reconcileBinding(resumedBinding), "native_recovery_tool");
    expect(grownRecovery.payload.activityId).toBe(firstRecovery.payload.activityId);
    expect(providerFactDedupKey(grownRecovery)).not.toBe(providerFactDedupKey(firstRecovery));

    recoveryConnection.turnStatus = "completed";
    recoveryConnection.threadItems = recoveredItems("completed", "RECOVERED_COMPLETE");
    const completed = requiredActivity(await recoveryAdapter.reconcileBinding(resumedBinding), "native_recovery_tool");
    expect(completed.payload.phase).toBe("completed");

    // Runtime's terminal activity fence owns ignoring this stale regression;
    // the Provider must still report the native in-progress snapshot as fact.
    recoveryConnection.turnStatus = "inProgress";
    recoveryConnection.threadItems = recoveredItems("inProgress", "STALE_PARTIAL");
    const lateInProgress = requiredActivity(await recoveryAdapter.reconcileBinding(resumedBinding), "native_recovery_tool");
    expect(lateInProgress).toMatchObject({
      payload: { activityId: completed.payload.activityId, phase: "started", content: "STALE_PARTIAL" },
      deduplication: { reconciliationWatermark: completed.deduplication.reconciliationWatermark },
    });
    expect(providerFactDedupKey(lateInProgress)).not.toBe(providerFactDedupKey(completed));
    await recoveryAdapter.close();
  });

  it("recovers completed provider activities from thread/read as bounded replace snapshots", async () => {
    const connection = new FakeConnection();
    connection.turnStatus = "completed";
    connection.threadItems = [
      { type: "userMessage", id: "native_user_1", clientId: "input_1" },
      {
        type: "commandExecution",
        id: "native_command_1",
        command: "TOKEN=secret-value ls /trusted/workspace",
        cwd: "/trusted/workspace",
        commandActions: [],
        status: "completed",
        aggregatedOutput: "/trusted/workspace/result.txt",
        exitCode: 0,
        durationMs: 5,
      },
      { type: "fileChange", id: "native_change_1", status: "completed", changes: [{ path: "/trusted/workspace/result.txt" }] },
      { type: "mcpToolCall", id: "native_mcp_1", status: "failed", server: "safe-server", tool: "lookup", error: { message: "PASSWORD=do-not-leak" } },
      { type: "dynamicToolCall", id: "native_dynamic_1", status: "completed", tool: "render", namespace: "safe", success: true, arguments: { token: "do-not-leak" } },
      { type: "webSearch", id: "native_web_1", query: "docs Bearer do-not-leak", results: [{ raw: "do-not-leak" }] },
      { type: "agentMessage", id: "native_agent_1", text: "RECOVERED_FINAL", phase: "final_answer" },
    ];
    const adapter = createCodexAppServerProviderAdapter({
      connectionFactory: new FakeFactory(connection),
      protocol: PROTOCOL,
      safety: { approvalPolicy: "untrusted", sandbox: "read-only", networkAccess: false },
      verifiedCapabilities: CODEX_APP_SERVER_PROVEN_CORE_CAPABILITIES,
      now: () => "2026-08-09T00:00:00.000Z",
    });
    const binding = { ...bindingRequest(), nativeBindingRef: "thread_1" };
    await adapter.ensureBinding({ ...binding, disposition: "resume" });

    const facts = await adapter.reconcileBinding(binding);
    const activities = facts.filter((fact) => fact.kind === "activity_observed");
    expect(activities).toHaveLength(6);
    expect(activities.map((fact) => [fact.payload.category, fact.payload.phase])).toEqual([
      ["tool", "completed"],
      ["change", "completed"],
      ["tool", "failed"],
      ["tool", "completed"],
      ["web", "completed"],
      ["assistant_progress", "completed"],
    ]);
    for (const activity of activities) {
      expect(activity).toMatchObject({
        correlation: { inputSubmissionId: "input_1" },
        payload: {
          schemaVersion: 1,
          activityId: expect.stringMatching(/^activity_[A-Za-z0-9-]{12,80}$/),
          updateMode: "replace",
          sequence: 0,
        },
      });
      expect(JSON.stringify(activity.payload)).not.toMatch(/native_|\/trusted\/workspace|secret-value|do-not-leak/u);
    }
    expect(facts).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "assistant_final", payload: expect.objectContaining({ content: "RECOVERED_FINAL" }) }),
      expect.objectContaining({ kind: "turn_completed" }),
    ]));

    const repeated = (await adapter.reconcileBinding(binding)).filter((fact) => fact.kind === "activity_observed");
    expect(repeated.map((fact) => fact.payload)).toEqual(activities.map((fact) => fact.payload));

    await adapter.releaseBinding(binding);
  });

  it("shuts down every Binding-owned child locally without unsubscribing, archiving, or deleting native threads", async () => {
    const first = new FakeConnection();
    const second = new FakeConnection();
    const transport = createCodexAppServerTransport({
      connectionFactory: new SequenceFactory([first, second]),
      protocol: PROTOCOL,
      safety: { approvalPolicy: "untrusted", sandbox: "read-only", networkAccess: false },
      verifiedCapabilities: CODEX_APP_SERVER_PROVEN_CORE_CAPABILITIES,
    });
    const firstBinding = bindingRequest();
    const secondBinding = { ...bindingRequest(), bindingId: "binding_2" };
    await transport.request({ operation: "ensure_binding", request: { ...firstBinding, disposition: "create" } });
    await transport.request({ operation: "ensure_binding", request: { ...secondBinding, disposition: "create" } });

    await Promise.all([transport.close(), transport.close()]);
    expect(first.closeCalls).toBe(1);
    expect(second.closeCalls).toBe(1);
    expect(first.requests.some((request) => request.method === "thread/unsubscribe")).toBe(false);
    expect(second.requests.some((request) => request.method === "thread/unsubscribe")).toBe(false);
    await expect(transport.request({ operation: "ensure_binding", request: { ...firstBinding, disposition: "resume", nativeBindingRef: "thread_1" } }))
      .rejects.toThrow(/codex_app_server_transport_closed/);
  });

  it("rebuilds native turn-to-input correlation from durable thread items after a Host restart", async () => {
    const connection = new FakeConnection();
    connection.turnStatus = "completed";
    const transport = createCodexAppServerTransport({
      connectionFactory: new FakeFactory(connection),
      protocol: PROTOCOL,
      safety: { approvalPolicy: "untrusted", sandbox: "read-only", networkAccess: false },
      verifiedCapabilities: CODEX_APP_SERVER_PROVEN_CORE_CAPABILITIES,
    });
    const binding = { ...bindingRequest(), nativeBindingRef: "thread_1" };
    await transport.request({ operation: "ensure_binding", request: { ...binding, disposition: "resume" } satisfies EnsureBindingRequest });

    const facts = await reconcileFacts(transport, binding);

    expect(facts).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "input_received", inputSubmissionId: "input_1", nativeTurnId: "turn_1" }),
      expect.objectContaining({ kind: "turn_completed", inputSubmissionId: "input_1", nativeTurnId: "turn_1" }),
    ]));
  });
});

class FakeFactory implements CodexAppServerConnectionFactory {
  readonly inputs: CodexAppServerConnectionInput[] = [];

  constructor(private readonly connection: FakeConnection) {}

  async inspectProtocol(): Promise<ProtocolPin> {
    return PROTOCOL;
  }

  async create(input: CodexAppServerConnectionInput): Promise<CodexAppServerConnection> {
    this.inputs.push(input);
    return this.connection;
  }
}

class SequenceFactory implements CodexAppServerConnectionFactory {
  #connections: FakeConnection[];

  constructor(connections: readonly FakeConnection[]) {
    this.#connections = [...connections];
  }

  async inspectProtocol(): Promise<ProtocolPin> {
    return PROTOCOL;
  }

  async create(): Promise<CodexAppServerConnection> {
    const connection = this.#connections.shift();
    if (!connection) throw new Error("unexpected_connection_create");
    return connection;
  }
}

class FakeConnection implements CodexAppServerConnection {
  readonly instanceId = "codex-app-server-test-instance";
  readonly requests: Array<{ readonly method: string; readonly params: unknown }> = [];
  readonly responses: Array<{ readonly id: CodexAppServerJsonRpcId; readonly result: unknown }> = [];
  readonly #events = new InboundQueue();
  closeCalls = 0;
  turnStatus = "inProgress";
  clientMessageId = "input_1";
  agentMessageText: string | undefined;
  threadItems: readonly Record<string, unknown>[] | undefined;

  async request<T = unknown>(method: string, params: unknown): Promise<T> {
    this.requests.push({ method, params });
    const value = (() => {
      switch (method) {
        case "thread/start":
        case "thread/resume":
          return { thread: { id: "thread_1", canAcceptDirectInput: true } };
        case "thread/read":
          return {
            thread: {
              id: "thread_1",
              canAcceptDirectInput: true,
              turns: [{
                id: "turn_1",
                status: this.turnStatus,
                items: this.threadItems ?? [
                  { type: "userMessage", id: "message_1", clientId: this.clientMessageId },
                  ...(this.agentMessageText
                    ? [{ type: "agentMessage", id: "agent_message_1", text: this.agentMessageText, phase: "final_answer" }]
                    : []),
                ],
              }],
            },
          };
        case "turn/start":
          return { turn: { id: "turn_1", status: "inProgress" } };
        case "turn/interrupt":
        case "thread/unsubscribe":
          return {};
        default:
          throw new Error(`unexpected_request:${method}`);
      }
    })();
    return value as T;
  }

  events(): AsyncIterable<CodexAppServerInboundMessage> {
    return this.#events.subscribe();
  }

  async respond(id: CodexAppServerJsonRpcId, result: unknown): Promise<void> {
    this.responses.push({ id, result });
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
    this.#events.close();
  }

  emit(message: CodexAppServerInboundMessage): void {
    this.#events.push(message);
  }

  requestFor(method: string): { readonly method: string; readonly params: unknown } | undefined {
    return this.requests.find((request) => request.method === method);
  }
}

class InboundQueue {
  readonly #items: CodexAppServerInboundMessage[] = [];
  #waiter: ((result: IteratorResult<CodexAppServerInboundMessage>) => void) | undefined;
  #closed = false;
  #subscribed = false;

  push(value: CodexAppServerInboundMessage): void {
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

  subscribe(): AsyncIterable<CodexAppServerInboundMessage> {
    if (this.#subscribed) throw new Error("fake_connection_observer_already_active");
    this.#subscribed = true;
    return {
      [Symbol.asyncIterator]: () => ({
        next: () => this.#next(),
      }),
    };
  }

  #next(): Promise<IteratorResult<CodexAppServerInboundMessage>> {
    const value = this.#items.shift();
    if (value) return Promise.resolve({ done: false, value });
    if (this.#closed) return Promise.resolve({ done: true, value: undefined });
    return new Promise((resolve) => { this.#waiter = resolve; });
  }
}

function bindingRequest(): ProviderPortBindingRequest {
  return {
    bindingId: "binding_1",
    bindingRevision: 1,
    executionProfile: profile(),
    workspace: { workspaceId: "workspace_1", cwd: "/trusted/workspace" },
    bootstrap: {
      purpose: "task_conductor",
      agentCardId: "agent_card_conductor",
      systemPrompt: "Coordinate this Task using only Runtime dispatch.",
      capabilityRefs: [],
      dispatchRegistry: [],
    },
  };
}

function profile(overrides: Partial<ExecutionProfileDefinition> = {}): ExecutionProfileDefinition {
  return {
    executionProfileId: "profile_1",
    provider: "codex",
    model: "gpt-5.1-codex",
    providerVersion: PROTOCOL.providerVersion,
    protocolFingerprint: PROTOCOL.protocolFingerprint,
    capabilityPolicy: {
      requiredCapabilities: CODEX_APP_SERVER_PROVEN_CORE_CAPABILITIES,
      allowedTools: [],
      permissionMode: "deny",
      maxConcurrentTurns: 1,
      maxNativeChildren: 0,
    },
    ...overrides,
  };
}

async function eventually<T>(read: () => T | undefined): Promise<T> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("eventually_timeout");
}

async function reconcileFacts(
  transport: ReturnType<typeof createCodexAppServerTransport>,
  request: ProviderPortBindingRequest,
): Promise<readonly NativeProviderFact[]> {
  const result = await transport.reconcile!({ operation: "reconcile_binding", request });
  return "facts" in result ? result.facts : result;
}

function requiredActivity(facts: readonly ProviderFact[], nativeMessageId: string): ProviderFact {
  const fact = facts.find((candidate) => candidate.kind === "activity_observed"
    && candidate.correlation.nativeMessageId === nativeMessageId);
  if (!fact) throw new Error(`activity_fact_missing:${nativeMessageId}`);
  return fact;
}

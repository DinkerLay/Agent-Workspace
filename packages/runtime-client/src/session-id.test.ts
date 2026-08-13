import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createAgentLoopSessionIdRuntimeController,
  type AgentLoopSessionIdCommandResult,
  type AgentLoopSessionIdInvalidation,
  type AgentLoopSessionIdRuntimePort,
  type AgentLoopSessionIdTaskReadModel,
  type AgentLoopSessionIdUiCommand,
} from "../../workbench-ui/src/agent-loop/agent-loop-session-id-runtime-controller.js";
import {
  createSessionIdDesktopRuntimeClient,
  createSessionIdHttpRuntimeClient,
  type SessionIdWebSocketLike,
} from "./session-id.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("Session-ID candidate Runtime clients", () => {
  it("adapts the typed Electron preload facade without adding lifecycle or capability methods", async () => {
    const commands: AgentLoopSessionIdUiCommand[] = [];
    const facade = {
      read: vi.fn(async () => model()),
      command: vi.fn(async (command: AgentLoopSessionIdUiCommand): Promise<AgentLoopSessionIdCommandResult> => {
        commands.push(command);
        return command.type === "session.request_interrupt"
          ? { control: { sessionControlAuditId: "control_desktop", state: "accepted" } }
          : {};
      }),
      subscribe: vi.fn(async () => () => undefined),
    };
    const candidate: AgentLoopSessionIdRuntimePort = createSessionIdDesktopRuntimeClient<
      AgentLoopSessionIdTaskReadModel,
      AgentLoopSessionIdUiCommand,
      AgentLoopSessionIdCommandResult,
      AgentLoopSessionIdInvalidation
    >(facade);
    let runtimeId = 0;
    const controller = createAgentLoopSessionIdRuntimeController({
      client: candidate,
      taskId: "task_desktop",
      now: () => "2026-08-11T08:00:00.000Z",
      createRuntimeId: ((prefix: string) => `${prefix}_${++runtimeId}`) as never,
    });

    await expect(controller.load()).resolves.toEqual(model());
    await controller.submitTaskMessage("Task follow-up", "ui_intent_task");
    await expect(controller.requestHumanInterrupt("session_worker", "ui_intent_interrupt")).resolves.toMatchObject({ state: "accepted" });
    expect(commands[0]).toMatchObject({ type: "task.submit_input", targetLogicalSessionId: "session_conductor" });
    expect(commands[1]).toMatchObject({ type: "session.request_interrupt", targetLogicalSessionId: "session_worker" });
    expect(commands[1]).not.toHaveProperty("content");
    expect(Object.keys(candidate).sort()).toEqual(["command", "read", "subscribe"]);
  });

  it("rejects a preload facade missing semantic subscriptions", () => {
    expect(() => createSessionIdDesktopRuntimeClient({ read: vi.fn(), command: vi.fn() } as never))
      .toThrow("session_id_desktop_runtime_facade_invalid");
  });

  it("reconnects the authenticated Browser subscription and emits an explicitly typed resync hint", async () => {
    vi.useFakeTimers();
    const sockets: FakeWebSocket[] = [];
    const webSocketFactory = vi.fn((url: string, protocols?: string | string[]) => {
      const socket = new FakeWebSocket();
      sockets.push(socket);
      return socket as SessionIdWebSocketLike;
    });
    const listener = vi.fn<(invalidation: TestInvalidation) => void>();
    const client = createSessionIdHttpRuntimeClient<unknown, unknown, unknown, TestInvalidation>({
      baseUrl: "https://runtime.example",
      authorization: "authenticated-subscription-token",
      fetchImpl: vi.fn() as never,
      webSocketFactory,
      createResyncInvalidation: (request) => Object.freeze({
        reason: "subscription_resynced",
        taskId: request.taskId,
      }),
    });

    const unsubscribe = await client.subscribe({ taskId: "task_reconnect" }, listener);
    expect(webSocketFactory).toHaveBeenCalledWith(
      "wss://runtime.example/runtime/session-id/subscribe?taskId=task_reconnect",
      ["agent-workspace-session-id-runtime", "authenticated-subscription-token"],
    );
    sockets[0]!.emit("open");
    sockets[0]!.emitMessage({
      type: "runtime.invalidated",
      invalidation: { reason: "recovered", taskId: "task_reconnect" },
    });
    expect(listener).toHaveBeenLastCalledWith({ reason: "recovered", taskId: "task_reconnect" });

    sockets[0]!.emit("close");
    await vi.advanceTimersByTimeAsync(249);
    expect(webSocketFactory).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(webSocketFactory).toHaveBeenCalledTimes(2);
    expect(webSocketFactory.mock.calls[1]).toEqual(webSocketFactory.mock.calls[0]);

    sockets[1]!.emit("open");
    expect(listener).toHaveBeenLastCalledWith({
      reason: "subscription_resynced",
      taskId: "task_reconnect",
    });
    await unsubscribe();
  });

  it("bounds reconnect backoff and schedules only once for an error followed by close", async () => {
    vi.useFakeTimers();
    const sockets: FakeWebSocket[] = [];
    const webSocketFactory = vi.fn(() => {
      const socket = new FakeWebSocket();
      sockets.push(socket);
      return socket as SessionIdWebSocketLike;
    });
    const client = createSessionIdHttpRuntimeClient<unknown, unknown, unknown, TestInvalidation>({
      baseUrl: "http://runtime.example",
      authorization: "authenticated-subscription-token",
      fetchImpl: vi.fn() as never,
      webSocketFactory,
    });

    const unsubscribe = await client.subscribe({ taskId: "task_backoff" }, vi.fn());
    sockets[0]!.emit("error");
    sockets[0]!.emit("close");
    await vi.advanceTimersByTimeAsync(250);
    expect(webSocketFactory).toHaveBeenCalledTimes(2);

    sockets[1]!.emit("error");
    await vi.advanceTimersByTimeAsync(499);
    expect(webSocketFactory).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(webSocketFactory).toHaveBeenCalledTimes(3);

    sockets[2]!.emit("error");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(webSocketFactory).toHaveBeenCalledTimes(4);
    sockets[3]!.emit("error");
    await vi.advanceTimersByTimeAsync(999);
    expect(webSocketFactory).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(1);
    expect(webSocketFactory).toHaveBeenCalledTimes(5);
    await unsubscribe();
  });

  it("cancels reconnect backoff on unsubscribe and never reconnects again", async () => {
    vi.useFakeTimers();
    const socket = new FakeWebSocket();
    const webSocketFactory = vi.fn(() => socket as SessionIdWebSocketLike);
    const client = createSessionIdHttpRuntimeClient<unknown, unknown, unknown, TestInvalidation>({
      baseUrl: "http://runtime.example",
      authorization: "authenticated-subscription-token",
      fetchImpl: vi.fn() as never,
      webSocketFactory,
    });

    const listener = vi.fn();
    const unsubscribe = await client.subscribe({ taskId: "task_unsubscribe" }, listener);
    socket.emit("open");
    socket.emit("close");
    await unsubscribe();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(webSocketFactory).toHaveBeenCalledTimes(1);
    expect(socket.close).toHaveBeenCalledTimes(1);
    socket.emitMessage({
      type: "runtime.invalidated",
      invalidation: { reason: "command", taskId: "task_unsubscribe" },
    });
    expect(listener).not.toHaveBeenCalled();
  });
});

type TestInvalidation = Readonly<{
  reason: "command" | "recovered" | "subscription_resynced";
  taskId: string;
}>;

class FakeWebSocket {
  readonly close = vi.fn();
  readonly #listeners = new Map<string, Set<EventListener>>();

  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    const listeners = this.#listeners.get(type) ?? new Set<EventListener>();
    listeners.add(listener as EventListener);
    this.#listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    this.#listeners.get(type)?.delete(listener as EventListener);
  }

  emit(type: "open" | "error" | "close"): void {
    for (const listener of [...(this.#listeners.get(type) ?? [])]) listener(new Event(type));
  }

  emitMessage(value: unknown): void {
    const event = { data: JSON.stringify(value) } as MessageEvent<string>;
    for (const listener of [...(this.#listeners.get("message") ?? [])]) listener(event);
  }
}

function model(): AgentLoopSessionIdTaskReadModel {
  const empty = { messages: [], executionGroups: [], interactions: [], controls: [], humanDeliveries: [] } as const;
  return {
    taskId: "task_desktop",
    title: "Desktop typed candidate",
    goal: "Prove typed facade",
    revision: 2,
    runId: "run_desktop",
    runStatus: "running",
    conductorLogicalSessionId: "session_conductor",
    timeline: [],
    directory: [{ agentCardId: "worker", title: "Worker", state: "busy", currentLogicalSessionId: "session_worker", currentGeneration: 1 }],
    sessions: [{
      ...empty,
      logicalSessionId: "session_conductor",
      agentCardId: "conductor",
      title: "Conductor",
      kind: "conductor",
      generation: 1,
      lifecycle: "current",
      state: "available",
      hasReceivedFirstInstruction: true,
      profile: profile("conductor"),
    }, {
      ...empty,
      logicalSessionId: "session_worker",
      agentCardId: "worker",
      title: "Worker",
      kind: "card",
      generation: 1,
      lifecycle: "current",
      state: "busy",
      hasReceivedFirstInstruction: true,
      profile: profile("general"),
    }],
    files: [],
  };
}

function profile(role: "conductor" | "general") {
  const suffix = role;
  return {
    schemaVersion: 3 as const,
    executionProfileId: `profile_${suffix}`,
    profileRevisionId: `profile_revision_${suffix}`,
    providerFamily: "opencode" as const,
    acpAgentKind: "native_acp" as const,
    model: "opencode-go/test-model",
    role,
    permissionMode: "deny" as const,
    allowedTools: [],
    requiredCapabilities: [],
    requiredExtensions: [],
    readiness: {
      profileRevisionId: `profile_revision_${suffix}`,
      providerFamily: "opencode" as const,
      acpAgentKind: "native_acp" as const,
      role,
      status: "available" as const,
      reasons: [],
      missingCapabilities: [],
      missingExtensions: [],
      model: "opencode-go/test-model",
    },
    mutableDuringRun: false as const,
  };
}

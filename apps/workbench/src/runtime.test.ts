// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createAgentLoopSessionIdBrowserPort,
  createAgentLoopSessionIdBrowserPortFromPage,
  createAgentLoopSessionIdDesktopPort,
} from "./runtime";

afterEach(() => {
  vi.useRealTimers();
  document.head.replaceChildren();
  delete window.agentWorkspace;
  vi.unstubAllGlobals();
});

describe("production Session-ID Workbench transport", () => {
  it("uses only the unified Browser routes and raw short-lived bridge token", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), init });
      return new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const client = createAgentLoopSessionIdBrowserPort({
      baseUrl: "https://runtime.example.test/",
      authorization: "browser-token-0123456789",
      fetchImpl,
      webSocketFactory: vi.fn() as never,
    });

    await client.readWorkspace();
    await client.readTask({ taskId: "task_one" });
    await client.readConfiguration({ kind: "template_studio" });
    await client.command({
      type: "task.start",
      commandId: "command_start",
      uiIntentId: "ui_intent_start",
      issuedAt: "now",
      taskId: "task_one",
      expectedRevision: 1,
    });

    expect(requests.map(({ url }) => url)).toEqual([
      "https://runtime.example.test/runtime/session-id/workspace/read",
      "https://runtime.example.test/runtime/session-id/read",
      "https://runtime.example.test/runtime/session-id/configuration/read",
      "https://runtime.example.test/runtime/session-id/command",
    ]);
    expect(requests.every(({ init }) => (init?.headers as Record<string, string>).authorization === "browser-token-0123456789"))
      .toBe(true);
    expect(requests.some(({ url }) => url.endsWith("/runtime/read"))).toBe(false);
  });

  it("does not send an unauthenticated request when page bootstrap is absent", async () => {
    const fetchImpl = vi.fn();
    vi.stubGlobal("fetch", fetchImpl);
    await expect(createAgentLoopSessionIdBrowserPortFromPage().readWorkspace())
      .rejects.toThrow("browser_session_id_runtime_bridge_token_missing");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("adapts only the formal Desktop root facade", async () => {
    const facade = {
      readWorkspace: vi.fn(async () => ({ generatedAt: "now", tasks: [], taskSetupOptions: { templates: [], workspaces: [] } })),
      readTask: vi.fn(async () => ({ taskId: "task_one" } as never)),
      readConfiguration: vi.fn(async () => ({ kind: "template_studio", model: {} } as never)),
      command: vi.fn(async () => ({})),
      subscribe: vi.fn(async () => () => undefined),
    };
    const port = createAgentLoopSessionIdDesktopPort(facade);

    expect(Object.keys(port).sort()).toEqual(["command", "readConfiguration", "readTask", "readWorkspace", "subscribe"]);
    for (const denied of ["read", "runtime", "gateway", "provider", "rawStore", "invokeAgent"]) {
      expect(denied in port).toBe(false);
    }
    await port.readWorkspace();
    await port.readTask({ taskId: "task_one" });
    expect(facade.readWorkspace).toHaveBeenCalledOnce();
    expect(facade.readTask).toHaveBeenCalledWith({ taskId: "task_one" });
  });

  it("forces a full read after each authenticated Browser subscription opens", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-11T09:10:11.000Z"));
    const sockets: FakeBrowserWebSocket[] = [];
    const webSocketFactory = vi.fn(() => {
      const socket = new FakeBrowserWebSocket();
      sockets.push(socket);
      return socket;
    });
    const listener = vi.fn();
    const client = createAgentLoopSessionIdBrowserPort({
      baseUrl: "https://runtime.example.test",
      authorization: "browser-token-0123456789",
      fetchImpl: vi.fn() as never,
      webSocketFactory,
    });

    const unsubscribe = await client.subscribe({ taskId: "task_one" }, listener);
    sockets[0]!.emit("open");
    expect(listener).toHaveBeenLastCalledWith({
      reason: "subscription_resynced",
      observedAt: "2026-08-11T09:10:11.000Z",
    });

    sockets[0]!.emit("close");
    await vi.advanceTimersByTimeAsync(250);
    sockets[1]!.emit("open");
    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenLastCalledWith({
      reason: "subscription_resynced",
      observedAt: "2026-08-11T09:10:11.250Z",
    });
    await unsubscribe();
  });
});

class FakeBrowserWebSocket {
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

  emit(type: "open" | "close"): void {
    for (const listener of [...(this.#listeners.get(type) ?? [])]) listener(new Event(type));
  }
}

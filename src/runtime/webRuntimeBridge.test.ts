/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { installWebRuntimeBridge } from "./webRuntimeBridge";

afterEach(() => {
  delete window.agentWorkspace;
  window.sessionStorage.clear();
});

describe("browser Runtime bridge", () => {
  it("installs only after an authenticated-proxy status probe and forwards typed calls", async () => {
    const fetchImpl = vi.fn(async (input: string, init?: RequestInit) => {
      if (input.endsWith("/status")) return jsonResponse({ result: { available: true, mode: "desktop", message: "ready" } });
      expect(init?.headers).toMatchObject({ "x-agent-workspace-client": expect.stringMatching(/^browser_/) });
      const request = JSON.parse(String(init?.body));
      if (request.method === "validateAgentLoopProjectDirectory") {
        expect(request.input).toEqual({ path: "/workspace/project" });
        return jsonResponse({ result: { path: "/workspace/selected", name: "selected" } });
      }
      if (request.method === "suggestAgentLoopProjectDirectories") {
        expect(request.input).toEqual({ prefix: "/workspace/pro" });
        return jsonResponse({ result: ["/workspace/project/"] });
      }
      expect(request).toEqual({ method: "listAgentLoopTasks", input: undefined });
      return jsonResponse({ result: [{ taskId: "task-1", title: "Web Task" }] });
    });

    await expect(installWebRuntimeBridge({ fetchImpl: fetchImpl as typeof fetch })).resolves.toBe(true);
    await expect(window.agentWorkspace?.native.getRuntimeStatus()).resolves.toMatchObject({ available: true, mode: "browser" });
    await expect(window.agentWorkspace?.native.validateAgentLoopProjectDirectory?.({ path: "/workspace/project" })).resolves.toEqual({ path: "/workspace/selected", name: "selected" });
    await expect(window.agentWorkspace?.native.suggestAgentLoopProjectDirectories?.({ prefix: "/workspace/pro" })).resolves.toEqual(["/workspace/project/"]);
    await expect(window.agentWorkspace?.native.listAgentLoopTasks?.()).resolves.toEqual([{ taskId: "task-1", title: "Web Task" }]);
  });

  it("keeps browser preview mode when the local Host is absent", async () => {
    const fetchImpl = vi.fn(async () => { throw new Error("not found"); });

    await expect(installWebRuntimeBridge({ fetchImpl: fetchImpl as typeof fetch })).resolves.toBe(false);
    expect(window.agentWorkspace).toBeUndefined();
  });

  it("routes SSE channels to the matching typed listeners", async () => {
    const listeners = new Map<string, (event: MessageEvent<string>) => void>();
    const source = { addEventListener: vi.fn((channel: string, listener: (event: MessageEvent<string>) => void) => listeners.set(channel, listener)), close: vi.fn() };
    const fetchImpl = vi.fn(async () => jsonResponse({ result: { available: true, mode: "desktop", message: "ready" } }));

    await installWebRuntimeBridge({ fetchImpl: fetchImpl as typeof fetch, eventSourceFactory: () => source });
    const received: string[] = [];
    const unsubscribe = window.agentWorkspace?.native.onAgentLoopRuntimeEvent?.((event) => received.push(event.runId));
    listeners.get("runtime")?.({ data: JSON.stringify({ channel: "terminal-client", payload: { id: "ignored" } }) } as MessageEvent<string>);
    listeners.get("runtime")?.({ data: JSON.stringify({ channel: "agent-loop-runtime", payload: { runId: "run-1" } }) } as MessageEvent<string>);

    expect(received).toEqual(["run-1"]);
    unsubscribe?.();
    expect(source.close).toHaveBeenCalledOnce();
  });
});

function jsonResponse(body: unknown) {
  return { ok: true, json: async () => body } as Response;
}

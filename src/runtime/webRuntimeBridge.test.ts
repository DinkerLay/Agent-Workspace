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
      if (request.method === "listAgentLoopTemplateVersions") {
        expect(request.input).toEqual({ templateId: "template-1" });
        return jsonResponse({ result: [{ id: "template-1", version: 2, name: "Template 1 v2" }] });
      }
      if (request.method === "listOpencodeModelCapabilities") {
        expect(request.input).toEqual({ historicalModelIds: ["retired-provider/retired-model"] });
        return jsonResponse({ result: {
          ok: true,
          source: "opencode-cli-verbose",
          models: [{
            id: "opencode-go/gpt-5.6-luna",
            providerId: "opencode-go",
            modelId: "gpt-5.6-luna",
            name: "GPT-5.6 Luna",
            availability: "available",
            status: "active",
            capabilities: { reasoning: true },
            variants: [{ id: "high", reasoningEffort: "high" }],
          }],
        } });
      }
      expect(request).toEqual({ method: "listAgentLoopTasks", input: undefined });
      return jsonResponse({ result: [{ taskId: "task-1", title: "Web Task" }] });
    });

    await expect(installWebRuntimeBridge({ fetchImpl: fetchImpl as typeof fetch })).resolves.toBe(true);
    await expect(window.agentWorkspace?.native.getRuntimeStatus()).resolves.toMatchObject({ available: true, mode: "browser" });
    await expect(window.agentWorkspace?.native.validateAgentLoopProjectDirectory?.({ path: "/workspace/project" })).resolves.toEqual({ path: "/workspace/selected", name: "selected" });
    await expect(window.agentWorkspace?.native.suggestAgentLoopProjectDirectories?.({ prefix: "/workspace/pro" })).resolves.toEqual(["/workspace/project/"]);
    await expect(window.agentWorkspace?.native.listAgentLoopTemplateVersions?.({ templateId: "template-1" })).resolves.toEqual([{ id: "template-1", version: 2, name: "Template 1 v2" }]);
    await expect(window.agentWorkspace?.native.listOpencodeModelCapabilities?.({ historicalModelIds: ["retired-provider/retired-model"] })).resolves.toMatchObject({
      ok: true,
      models: [{ id: "opencode-go/gpt-5.6-luna", variants: [{ id: "high", reasoningEffort: "high" }] }],
    });
    await expect(window.agentWorkspace?.native.listAgentLoopTasks?.()).resolves.toEqual([{ taskId: "task-1", title: "Web Task" }]);
  });

  it("keeps browser preview mode when the local Host is absent", async () => {
    const fetchImpl = vi.fn(async () => { throw new Error("not found"); });

    await expect(installWebRuntimeBridge({ fetchImpl: fetchImpl as typeof fetch })).resolves.toBe(false);
    expect(window.agentWorkspace).toBeUndefined();
  });

  it("normalizes an empty proxy failure instead of leaking a response JSON exception", async () => {
    const fetchImpl = vi.fn(async (input: string) => {
      if (input.endsWith("/status")) return jsonResponse({ result: { available: true, mode: "desktop", message: "ready" } });
      return {
        ok: false,
        status: 500,
        headers: new Headers({ "content-type": "text/plain" }),
        json: async () => { throw new SyntaxError("Unexpected end of JSON input"); },
      } as unknown as Response;
    });

    await expect(installWebRuntimeBridge({ fetchImpl: fetchImpl as typeof fetch })).resolves.toBe(true);
    await expect(window.agentWorkspace?.native.listAgentLoopTasks?.()).rejects.toThrow("runtime_bridge_unavailable:500");
  });

  it("normalizes an empty success response instead of leaking a response JSON exception", async () => {
    const fetchImpl = vi.fn(async (input: string) => {
      if (input.endsWith("/status")) return jsonResponse({ result: { available: true, mode: "desktop", message: "ready" } });
      return {
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => { throw new SyntaxError("Unexpected end of JSON input"); },
      } as unknown as Response;
    });

    await expect(installWebRuntimeBridge({ fetchImpl: fetchImpl as typeof fetch })).resolves.toBe(true);
    await expect(window.agentWorkspace?.native.listAgentLoopTasks?.()).rejects.toThrow("runtime_bridge_response_invalid");
  });

  it("routes SSE channels to the matching typed listeners", async () => {
    const listeners = new Map<string, (event: MessageEvent<string>) => void>();
    const source = { addEventListener: vi.fn((channel: string, listener: (event: MessageEvent<string>) => void) => listeners.set(channel, listener)), close: vi.fn() };
    const fetchImpl = vi.fn(async () => jsonResponse({ result: { available: true, mode: "desktop", message: "ready" } }));

    await installWebRuntimeBridge({ fetchImpl: fetchImpl as typeof fetch, eventSourceFactory: () => source });
    const receivedRuntime: string[] = [];
    const receivedTemplateDesign: Array<{ draftId: string; revision: number }> = [];
    const unsubscribeRuntime = window.agentWorkspace?.native.onAgentLoopRuntimeEvent?.((event) => receivedRuntime.push(event.runId));
    const unsubscribeTemplateDesign = window.agentWorkspace?.native.onAgentLoopTemplateDesignEvent?.((event) => receivedTemplateDesign.push({ draftId: event.draftId, revision: event.revision }));
    listeners.get("runtime")?.({ data: JSON.stringify({ channel: "terminal-client", payload: { id: "ignored" } }) } as MessageEvent<string>);
    listeners.get("runtime")?.({ data: JSON.stringify({ channel: "agent-loop-runtime", payload: { runId: "run-1" } }) } as MessageEvent<string>);
    listeners.get("runtime")?.({ data: JSON.stringify({ channel: "agent-loop-template-design", payload: { draftId: "template-design-1", type: "template_design.draft_discarded", revision: 8 } }) } as MessageEvent<string>);

    expect(receivedRuntime).toEqual(["run-1"]);
    expect(receivedTemplateDesign).toEqual([{ draftId: "template-design-1", revision: 8 }]);
    unsubscribeRuntime?.();
    unsubscribeTemplateDesign?.();
    expect(source.close).toHaveBeenCalledOnce();
  });
});

function jsonResponse(body: unknown) {
  return { ok: true, json: async () => body } as Response;
}

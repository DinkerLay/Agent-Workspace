import { describe, expect, it, vi } from "vitest";
import type {
  ProviderScopedToolCall,
  ProviderScopedToolRegistration,
  ProviderScopedToolTurnContext,
} from "@agent-workspace/provider-port";
import { createProviderScopedMcpBridge } from "./provider-scoped-mcp-bridge.js";

const registration: ProviderScopedToolRegistration = Object.freeze({
  capabilityClass: "runtime_orchestration",
  tools: Object.freeze([{
    name: "invoke_agent",
    description: "Materialize one Agent Card Session.",
    inputSchema: Object.freeze({
      type: "object",
      properties: Object.freeze({ agentCardId: Object.freeze({ type: "string" }) }),
      required: Object.freeze(["agentCardId"]),
      additionalProperties: false,
    }),
  }]),
});

describe("Provider-scoped MCP bridge", () => {
  it("exposes only one opaque route's registered tools and dispatches through its active Turn lease", async () => {
    const handleCall = vi.fn(async (call: ProviderScopedToolCall) => Object.freeze({
      providerCallId: call.providerCallId,
      result: Object.freeze({ status: "accepted", sessionId: "logical_session_probe" }),
    }));
    const bridge = createProviderScopedMcpBridge({ createToken: () => "a".repeat(48) });
    const address = await bridge.listen();
    const route = bridge.registerRoute({ bindingId: "binding_probe", registration });
    try {
      const toolDiscovery = route.waitForToolDiscovery();
      const initialized = await rpc(route.url, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "probe", version: "1" } },
      });
      expect(initialized).toMatchObject({
        jsonrpc: "2.0",
        id: 1,
        result: { capabilities: { tools: { listChanged: false } }, serverInfo: { name: "agent-workspace-scoped-tools" } },
      });
      const listed = await rpc(route.url, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
      await expect(toolDiscovery).resolves.toBeUndefined();
      expect(listed).toMatchObject({ result: { tools: [{ name: "invoke_agent" }] } });

      const inactive = await rpc(route.url, {
        jsonrpc: "2.0", id: "call-1", method: "tools/call", params: { name: "invoke_agent", arguments: { agentCardId: "agent_card_probe" } },
      });
      expect(inactive).toMatchObject({ error: { code: -32001, message: "scoped_turn_inactive" } });
      expect(handleCall).not.toHaveBeenCalled();

      const turnContext: ProviderScopedToolTurnContext = Object.freeze({
        capabilityClass: "runtime_orchestration",
        lease: Object.freeze({ turn: "turn_probe" }),
        handleCall,
      });
      route.activate(turnContext);
      const first = await rpc(route.url, {
        jsonrpc: "2.0", id: "call-1", method: "tools/call", params: { name: "invoke_agent", arguments: { agentCardId: "agent_card_probe" } },
      });
      const replay = await rpc(route.url, {
        jsonrpc: "2.0", id: "call-1", method: "tools/call", params: { name: "invoke_agent", arguments: { agentCardId: "agent_card_probe" } },
      });
      expect(first).toMatchObject({
        result: {
          content: [{ type: "text", text: JSON.stringify({ status: "accepted", sessionId: "logical_session_probe" }) }],
          structuredContent: { status: "accepted", sessionId: "logical_session_probe" },
        },
      });
      expect(replay).toEqual(first);
      expect(handleCall).toHaveBeenCalledTimes(1);
      expect(handleCall.mock.calls[0]?.[0]).toMatchObject({
        name: "invoke_agent",
        arguments: { agentCardId: "agent_card_probe" },
        lease: turnContext.lease,
      });
      const conflict = await rpc(route.url, {
        jsonrpc: "2.0", id: "call-1", method: "tools/call", params: { name: "invoke_agent", arguments: { agentCardId: "agent_card_other" } },
      });
      expect(conflict).toMatchObject({ error: { code: -32003, message: "provider_call_replay_conflict" } });
      expect(handleCall).toHaveBeenCalledTimes(1);

      route.deactivate();
      const afterTurn = await rpc(route.url, {
        jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "invoke_agent", arguments: { agentCardId: "agent_card_probe" } },
      });
      expect(afterTurn).toMatchObject({ error: { code: -32001 } });
      expect(address.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
    } finally {
      await bridge.close();
    }
  });

  it("fails closed for unknown routes, methods and tools", async () => {
    const bridge = createProviderScopedMcpBridge({ createToken: () => "b".repeat(48) });
    await bridge.listen();
    const route = bridge.registerRoute({ bindingId: "binding_probe", registration });
    try {
      const unknownTool = await rpc(route.url, {
        jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "close_session", arguments: {} },
      });
      expect(unknownTool).toMatchObject({ error: { code: -32602, message: "tool_not_registered" } });
      const unknownMethod = await rpc(route.url, { jsonrpc: "2.0", id: 2, method: "resources/list", params: {} });
      expect(unknownMethod).toMatchObject({ error: { code: -32601 } });
      const missing = await fetch(route.url.replace(/b+$/u, "c".repeat(48)), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list", params: {} }),
      });
      expect(missing.status).toBe(404);
      route.close();
      expect((await fetch(route.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/list", params: {} }),
      })).status).toBe(404);
    } finally {
      await bridge.close();
    }
  });
});

async function rpc(url: string, body: unknown): Promise<Record<string, any>> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(200);
  return await response.json() as Record<string, any>;
}

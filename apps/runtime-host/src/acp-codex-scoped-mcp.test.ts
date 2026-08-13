import { describe, expect, it, vi } from "vitest";
import type { ProviderScopedToolCall } from "@agent-workspace/provider-port";
import { createAcpReverseRpcBroker } from "./acp-reverse-rpc-broker.js";
import type { AcpTargetCheckpointObserver } from "./acp-provider-composition.js";
import { createCodexAcpScopedMcpRole } from "./acp-codex-scoped-mcp.js";
import { createProviderScopedMcpBridge } from "./provider-scoped-mcp-bridge.js";

describe("Codex ACP Attempt-scoped MCP role", () => {
  it("routes exactly the four Conductor actions through one active Attempt lease", async () => {
    const bridge = createProviderScopedMcpBridge({ createToken: () => "c".repeat(48) });
    const scope = createCodexAcpScopedMcpRole({
      role: "conductor",
      bridge,
      serverName: "agent_workspace_codex_conductor",
      mcpLeaseId: "mcp_lease_codex_conductor",
    });
    expect(scope.registration?.tools.map(({ name }) => name)).toEqual([
      "invoke_agent",
      "send_to_session",
      "interrupt_session",
      "close_session",
    ]);
    const broker = createAcpReverseRpcBroker();
    const generation = { active: true, isActive() { return this.active; } };
    const registration = scope.createReverseRpcRegistration();
    const reverseRpcLease = broker.register({
      bindingHandle: "binding_handle_codex_conductor",
      generation,
      ...registration,
    });
    const binding = await scope.openBindingRoute({
      bindingHandle: "binding_handle_codex_conductor",
      reverseRpcLease,
    });
    const server = binding.mcpServers[0]! as unknown as Record<string, unknown>;

    expect(await rpc(String(server.url), "inactive", "invoke_agent", {}))
      .toMatchObject({ error: { code: -32001, message: "scoped_turn_inactive" } });
    const handleCall = vi.fn(async (call: ProviderScopedToolCall) => Object.freeze({
      providerCallId: call.providerCallId,
      result: Object.freeze({ status: "accepted" }),
    }));
    const checkpointEvents: unknown[] = [];
    const checkpointObserver: AcpTargetCheckpointObserver = Object.freeze({
      observe(event) { checkpointEvents.push(event); },
    });
    await binding.activateAttempt({
      attemptId: "session_execution_attempt_codex_conductor",
      interactionRevision: 3,
      checkpointObserver,
      turnContext: Object.freeze({
        capabilityClass: "runtime_orchestration",
        lease: Object.freeze({ opaque: "turn_lease" }),
        handleCall,
      }),
    });
    expect(await rpc(String(server.url), "accepted", "invoke_agent", { agentCardId: "card_a" }))
      .toMatchObject({ result: { structuredContent: { status: "accepted" } } });
    expect(handleCall).toHaveBeenCalledTimes(1);
    expect(checkpointEvents).toEqual([{
      kind: "task_scoped_mcp_call",
      bindingHandle: "binding_handle_codex_conductor",
      attemptId: "session_execution_attempt_codex_conductor",
      role: "conductor",
      toolName: "invoke_agent",
    }]);
    expect(binding.observedToolCalls()).toBe(1);
    expect(binding.observedToolNames()).toEqual(["invoke_agent"]);
    expect(binding.observedToolAttemptNames()).toEqual(["invoke_agent"]);
    expect(await rpc(String(server.url), "builtin", "bash", {}))
      .toMatchObject({ error: { code: -32602, message: "tool_not_registered" } });

    await binding.revokeAttempt();
    expect(await rpc(String(server.url), "revoked", "invoke_agent", {}))
      .toMatchObject({ error: { code: -32001, message: "scoped_turn_inactive" } });
    expect(handleCall).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(scope.safeObservation())).not.toContain(String(server.url));
    expect(scope.safeObservation()).toEqual({ role: "conductor", scopedTools: true, toolCount: 4 });

    await binding.close();
    await reverseRpcLease.close();
    await broker.close();
    await bridge.close();
  });

  it("records a safe tool attempt even when the Attempt-scoped owner rejects it", async () => {
    const bridge = createProviderScopedMcpBridge({ createToken: () => "r".repeat(48) });
    const scope = createCodexAcpScopedMcpRole({
      role: "conductor",
      bridge,
      serverName: "agent_workspace_codex_rejected",
      mcpLeaseId: "mcp_lease_codex_rejected",
    });
    const broker = createAcpReverseRpcBroker();
    const generation = { active: true, isActive() { return this.active; } };
    const reverseRpcLease = broker.register({
      bindingHandle: "binding_handle_codex_rejected",
      generation,
      ...scope.createReverseRpcRegistration(),
    });
    const binding = await scope.openBindingRoute({
      bindingHandle: "binding_handle_codex_rejected",
      reverseRpcLease,
    });
    const server = binding.mcpServers[0]! as unknown as Record<string, unknown>;
    await binding.activateAttempt({
      attemptId: "session_execution_attempt_codex_rejected",
      interactionRevision: 1,
      turnContext: Object.freeze({
        capabilityClass: "runtime_orchestration",
        lease: Object.freeze({ opaque: "rejected" }),
        handleCall: async () => { throw new Error("qualification rejected"); },
      }),
    });

    expect(await rpc(String(server.url), "rejected", "invoke_agent", { agentCardId: "card_a" }))
      .toMatchObject({ error: { code: -32002, message: "tool_dispatch_rejected" } });
    expect(binding.observedToolAttemptNames()).toEqual(["invoke_agent"]);
    expect(binding.observedToolNames()).toEqual([]);

    await binding.close();
    await reverseRpcLease.close();
    await broker.close();
    await bridge.close();
  });

  it("keeps Publisher, Worker, and Reviewer free of injected MCP authority", async () => {
    for (const role of ["publisher", "worker", "reviewer"] as const) {
      const scope = createCodexAcpScopedMcpRole({ role });
      expect(scope.registration).toBeUndefined();
      expect(scope.createReverseRpcRegistration()).toBeUndefined();
      expect(scope.safeObservation()).toEqual({ role, scopedTools: false, toolCount: 0 });
      await expect(scope.openBindingRoute({
        bindingHandle: `binding_handle_codex_${role}`,
        reverseRpcLease: {} as never,
      })).rejects.toMatchObject({ code: "codex_acp_scoped_mcp_unavailable" });
    }
  });
});

async function rpc(
  url: string,
  id: string,
  name: string,
  argumentsValue: unknown,
): Promise<Record<string, any>> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name, arguments: argumentsValue },
    }),
  });
  expect(response.status).toBe(200);
  return await response.json() as Record<string, any>;
}

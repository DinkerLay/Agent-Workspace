import { describe, expect, it, vi } from "vitest";
import type { ProviderScopedToolCall } from "@agent-workspace/provider-port";
import { createAcpReverseRpcBroker } from "./acp-reverse-rpc-broker.js";
import type { AcpTargetCheckpointObserver } from "./acp-provider-composition.js";
import { createOpenCodeAcpScopedMcpRole } from "./acp-opencode-scoped-mcp.js";
import { createProviderScopedMcpBridge } from "./provider-scoped-mcp-bridge.js";

describe("OpenCode ACP scoped MCP role lease", () => {
  it("routes only exact Conductor tools through the active reverse-RPC Attempt lease", async () => {
    const bridge = createProviderScopedMcpBridge({ createToken: () => "s".repeat(48) });
    const scope = createOpenCodeAcpScopedMcpRole({
      role: "conductor",
      bridge,
      serverName: "agent_workspace_conductor",
      mcpLeaseId: "mcp_lease_conductor",
    });
    const broker = createAcpReverseRpcBroker();
    const generation = { active: true, isActive() { return this.active; } };
    const registration = scope.createReverseRpcRegistration();
    expect(registration?.mcp?.allowedServerNames).toEqual(["agent_workspace_conductor"]);
    const reverseRpcLease = broker.register({
      bindingHandle: "binding_handle_conductor",
      generation,
      ...registration,
    });
    const binding = await scope.openBindingRoute({
      bindingHandle: "binding_handle_conductor",
      reverseRpcLease,
    });
    const mcpServer = binding.mcpServers[0]! as Record<string, unknown>;
    expect(mcpServer).toEqual({
      type: "http",
      name: "agent_workspace_conductor",
      url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/mcp\/s{48}$/u),
      headers: [],
    });
    expect(JSON.parse(scope.executionPolicy.configContent)).toEqual({});

    const inactive = await rpc(String(mcpServer.url), "inactive", "invoke_agent", {
      agentCardId: "agent_card_a",
    });
    expect(inactive).toMatchObject({ error: { code: -32001, message: "scoped_turn_inactive" } });

    const handleCall = vi.fn(async (call: ProviderScopedToolCall) => Object.freeze({
      providerCallId: call.providerCallId,
      result: Object.freeze({ status: "accepted", sessionId: "logical_session_a" }),
    }));
    const checkpointEvents: unknown[] = [];
    const checkpointObserver: AcpTargetCheckpointObserver = Object.freeze({
      observe(event) { checkpointEvents.push(event); },
    });
    const hostTurnLease = Object.freeze({ opaque: "host_turn_lease" });
    await binding.activateAttempt({
      attemptId: "session_execution_attempt_a",
      interactionRevision: 1,
      checkpointObserver,
      turnContext: Object.freeze({
        capabilityClass: "runtime_orchestration",
        lease: hostTurnLease,
        handleCall,
      }),
    });
    const accepted = await rpc(String(mcpServer.url), "accepted", "invoke_agent", {
      agentCardId: "agent_card_a",
    });
    expect(accepted).toMatchObject({
      result: { structuredContent: { status: "accepted", sessionId: "logical_session_a" } },
    });
    expect(handleCall).toHaveBeenCalledTimes(1);
    expect(handleCall.mock.calls[0]?.[0]).toMatchObject({
      name: "invoke_agent",
      arguments: { agentCardId: "agent_card_a" },
      lease: hostTurnLease,
    });
    expect(checkpointEvents).toEqual([{
      kind: "task_scoped_mcp_call",
      bindingHandle: "binding_handle_conductor",
      attemptId: "session_execution_attempt_a",
      role: "conductor",
      toolName: "invoke_agent",
    }]);

    await expect(reverseRpcLease.dispatchMcp({
      attemptId: "session_execution_attempt_other",
      leaseId: "mcp_lease_conductor",
      serverName: "agent_workspace_conductor",
      method: "tools/call",
      params: {},
    })).rejects.toMatchObject({ code: "acp_reverse_rpc_attempt_mismatch" });
    await expect(reverseRpcLease.dispatchMcp({
      attemptId: "session_execution_attempt_a",
      leaseId: "mcp_lease_other",
      serverName: "agent_workspace_conductor",
      method: "tools/call",
      params: {},
    })).rejects.toMatchObject({ code: "acp_reverse_rpc_mcp_lease_mismatch" });
    await expect(reverseRpcLease.dispatchMcp({
      attemptId: "session_execution_attempt_a",
      leaseId: "mcp_lease_conductor",
      serverName: "agent_workspace_other",
      method: "tools/call",
      params: {},
    })).rejects.toMatchObject({ code: "acp_reverse_rpc_mcp_server_forbidden" });
    await expect(reverseRpcLease.dispatchMcp({
      attemptId: "session_execution_attempt_a",
      leaseId: "mcp_lease_conductor",
      serverName: "agent_workspace_conductor",
      method: "resources/list",
      params: {},
    })).rejects.toMatchObject({ code: "opencode_acp_scoped_mcp_method_forbidden" });

    const builtin = await rpc(String(mcpServer.url), "builtin", "bash", {});
    expect(builtin).toMatchObject({ error: { code: -32602, message: "tool_not_registered" } });
    await binding.revokeAttempt();
    const revoked = await rpc(String(mcpServer.url), "revoked", "invoke_agent", {
      agentCardId: "agent_card_a",
    });
    expect(revoked).toMatchObject({ error: { code: -32001, message: "scoped_turn_inactive" } });
    expect(handleCall).toHaveBeenCalledTimes(1);

    expect(scope.safeObservation()).toEqual({
      role: "conductor",
      scopedTools: true,
      toolCount: 4,
    });
    const safe = JSON.stringify(scope.safeObservation());
    expect(safe).not.toContain("mcp_lease_conductor");
    expect(safe).not.toContain("agent_workspace_conductor");
    expect(safe).not.toContain("binding_handle_conductor");

    await binding.close();
    await reverseRpcLease.close();
    await broker.close();
    await bridge.close();
  });

  it("keeps Publisher, Worker, and Reviewer free of injected MCP authority", async () => {
    for (const role of ["publisher", "worker", "reviewer"] as const) {
      const scope = createOpenCodeAcpScopedMcpRole({ role });
      expect(scope.registration).toBeUndefined();
      expect(scope.createReverseRpcRegistration()).toBeUndefined();
      expect(JSON.parse(scope.executionPolicy.configContent)).toEqual({});
      expect(scope.safeObservation()).toEqual({ role, scopedTools: false, toolCount: 0 });
      await expect(scope.openBindingRoute({
        bindingHandle: `binding_handle_${role}`,
        reverseRpcLease: {} as never,
      })).rejects.toMatchObject({ code: "opencode_acp_scoped_mcp_unavailable" });
    }
  });

  it("closes the qualification lease and reopens the same role scope on the exact target Binding", async () => {
    const tokens = ["p".repeat(48), "t".repeat(48)];
    const bridge = createProviderScopedMcpBridge({ createToken: () => tokens.shift()! });
    const scope = createOpenCodeAcpScopedMcpRole({
      role: "conductor",
      bridge,
      serverName: "agent_workspace_conductor_rebind",
      mcpLeaseId: "mcp_lease_conductor_rebind",
    });
    const broker = createAcpReverseRpcBroker();
    const generation = { active: true, isActive() { return this.active; } };
    const registration = scope.createReverseRpcRegistration()!;
    const probeLease = broker.register({
      bindingHandle: "binding_handle_qualification_probe",
      generation,
      ...registration,
    });
    const probeBinding = await scope.openBindingRoute({
      bindingHandle: "binding_handle_qualification_probe",
      reverseRpcLease: probeLease,
    });
    const probeUrl = String((probeBinding.mcpServers[0] as Record<string, unknown>).url);
    await probeBinding.close();
    await probeLease.close();
    await expect(probeLease.dispatchMcp({
      attemptId: "session_execution_attempt_old_probe",
      leaseId: "mcp_lease_conductor_rebind",
      serverName: "agent_workspace_conductor_rebind",
      method: "tools/call",
      params: {},
    })).rejects.toMatchObject({ code: "acp_reverse_rpc_lease_closed" });

    const targetLease = broker.register({
      bindingHandle: "binding_handle_real_task_target",
      generation,
      ...registration,
    });
    const targetBinding = await scope.openBindingRoute({
      bindingHandle: "binding_handle_real_task_target",
      reverseRpcLease: targetLease,
    });
    const targetUrl = String((targetBinding.mcpServers[0] as Record<string, unknown>).url);
    expect(targetUrl).not.toBe(probeUrl);
    expect(targetLease.safeObservation().bindingHandle).toBe("binding_handle_real_task_target");
    const handleCall = vi.fn(async (call: ProviderScopedToolCall) => Object.freeze({
      providerCallId: call.providerCallId,
      result: Object.freeze({ status: "accepted" }),
    }));
    await targetBinding.activateAttempt({
      attemptId: "session_execution_attempt_real_task",
      interactionRevision: 1,
      turnContext: Object.freeze({
        capabilityClass: "runtime_orchestration",
        lease: Object.freeze({ target: true }),
        handleCall,
      }),
    });
    expect(await rpc(targetUrl, "target", "invoke_agent", {
      agentCardId: "agent_card_target",
    })).toMatchObject({ result: { structuredContent: { status: "accepted" } } });
    expect(handleCall).toHaveBeenCalledTimes(1);

    await targetBinding.close();
    await targetLease.close();
    await scope.close();
    await broker.close();
    await bridge.close();
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

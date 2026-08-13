import { describe, expect, it, vi } from "vitest";
import {
  createConductorToolHost,
  type ConductorToolDispatchRequest,
  type VerifiedConductorToolLease,
} from "./conductor-tool-host";

const LEASE: VerifiedConductorToolLease = {
  role: "conductor",
  taskId: "task_phase3",
  runId: "run_phase3",
  conductorSessionId: "logical_session_conductor",
  conductorSessionTurnId: "session_turn_conductor",
  taskRevision: 7,
  bindingRevision: 3,
};

describe("ConductorToolHost", () => {
  it("publishes only the exact public orchestration schemas", () => {
    const host = createConductorToolHost({ verifyLease: () => LEASE, dispatch: async () => ({ status: "accepted" }) });

    expect(host.listTools().map((tool) => tool.name)).toEqual([
      "invoke_agent",
      "send_to_session",
      "interrupt_session",
      "close_session",
    ]);
    expect(JSON.stringify(host.listTools())).not.toMatch(/taskId|runId|turnId|bindingId|revision|commandId|idempotency/i);
    expect(host.listTools()[0].inputSchema).toEqual({
      type: "object",
      additionalProperties: false,
      required: ["agentCardId"],
      properties: { agentCardId: { type: "string" } },
    });
  });

  it("binds dispatch and result to one Provider call and one verified Turn", async () => {
    const dispatch = vi.fn(async (_request: ConductorToolDispatchRequest) =>
      ({ sessionId: "logical_session_researcher_g1" } as const));
    const host = createConductorToolHost({ verifyLease: () => LEASE, dispatch });

    await expect(host.handleProviderToolCall({
      providerCallId: "provider_call_1",
      name: "invoke_agent",
      arguments: { agentCardId: "agent_card_researcher" },
      lease: "opaque-signed-lease",
    })).resolves.toEqual({
      providerCallId: "provider_call_1",
      result: { sessionId: "logical_session_researcher_g1" },
    });
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({
      providerCallId: "provider_call_1",
      name: "invoke_agent",
      arguments: { agentCardId: "agent_card_researcher" },
      commandId: expect.stringMatching(/^command_conductor_tool_[A-Za-z0-9_-]+$/u),
      idempotencyKey: expect.stringMatching(/^command_conductor_tool_[A-Za-z0-9_-]+$/u),
      scope: {
        taskId: "task_phase3",
        runId: "run_phase3",
        conductorSessionId: "logical_session_conductor",
        conductorSessionTurnId: "session_turn_conductor",
        taskRevision: 7,
        bindingRevision: 3,
      },
    }));
    const request = dispatch.mock.calls[0]![0];
    expect(request.commandId).toMatch(/^command_[A-Za-z0-9_-]+$/u);
    expect(request.idempotencyKey).toBe(request.commandId);
    expect(request.commandId).not.toContain("provider_call_1");
  });

  it("deduplicates identical in-process replay and rejects conflicting reuse", async () => {
    const dispatch = vi.fn(async () => ({ status: "accepted" } as const));
    const host = createConductorToolHost({ verifyLease: () => LEASE, dispatch });
    const call = {
      providerCallId: "provider_call_send",
      name: "send_to_session" as const,
      arguments: { sessionId: "logical_session_worker", payload: { content: "Continue." } },
      lease: "opaque-signed-lease",
    };

    await expect(Promise.all([host.handleProviderToolCall(call), host.handleProviderToolCall(call)])).resolves.toHaveLength(2);
    expect(dispatch).toHaveBeenCalledTimes(1);
    await expect(host.handleProviderToolCall({
      ...call,
      arguments: { sessionId: "logical_session_worker", payload: { content: "Different." } },
    })).rejects.toThrow("conductor_tool_call_payload_conflict");
  });

  it("keeps one durable Provider-call identity when Binding recovery refreshes the lease revision", async () => {
    let bindingRevision = 3;
    const dispatched: ConductorToolDispatchRequest[] = [];
    const dispatch = vi.fn(async (request: ConductorToolDispatchRequest) => {
      dispatched.push(request);
      return { status: "accepted" } as const;
    });
    const host = createConductorToolHost({
      verifyLease: () => ({ ...LEASE, bindingRevision }),
      dispatch,
    });
    const call = {
      providerCallId: "provider_call_recovered",
      name: "send_to_session" as const,
      arguments: { sessionId: "logical_session_worker", payload: { content: "Continue." } },
      lease: "opaque-signed-lease",
    };

    await host.handleProviderToolCall(call);
    const firstIdentity = dispatched[0]!.idempotencyKey;
    bindingRevision = 4;
    await host.handleProviderToolCall({ ...call, lease: "opaque-refreshed-lease" });

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(firstIdentity).not.toContain(":3:");

    const restartedCalls: ConductorToolDispatchRequest[] = [];
    const restartedDispatch = vi.fn(async (request: ConductorToolDispatchRequest) => {
      restartedCalls.push(request);
      return { status: "accepted" } as const;
    });
    const restarted = createConductorToolHost({
      verifyLease: () => ({ ...LEASE, bindingRevision: 4 }),
      dispatch: restartedDispatch,
    });
    await restarted.handleProviderToolCall({ ...call, lease: "opaque-refreshed-lease" });
    expect(restartedCalls[0]!.idempotencyKey).toBe(firstIdentity);
    expect(restartedCalls[0]!.scope.bindingRevision).toBe(4);
  });

  it("never dispatches a non-Conductor lease or hidden model scope", async () => {
    const dispatch = vi.fn(async () => ({ status: "accepted" } as const));
    const host = createConductorToolHost({
      verifyLease: () => ({ ...LEASE, role: "worker" }),
      dispatch,
    });

    await expect(host.handleProviderToolCall({
      providerCallId: "provider_call_worker",
      name: "invoke_agent",
      arguments: { agentCardId: "agent_card_worker" },
      lease: "opaque-worker-lease",
    })).rejects.toThrow("conductor_tool_role_forbidden");
    expect(dispatch).not.toHaveBeenCalled();

    const conductorHost = createConductorToolHost({ verifyLease: () => LEASE, dispatch });
    await expect(conductorHost.handleProviderToolCall({
      providerCallId: "provider_call_hidden_scope",
      name: "invoke_agent",
      arguments: { agentCardId: "agent_card_worker", runId: "forged" },
      lease: "opaque-conductor-lease",
    })).rejects.toThrow("orchestration_tool_arguments_invalid");
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("rejects forged and stale Host leases before dispatch", async () => {
    const dispatch = vi.fn(async () => ({ status: "accepted" } as const));
    const forged = createConductorToolHost({
      verifyLease: () => { throw new Error("conductor_tool_lease_invalid"); },
      dispatch,
    });
    await expect(forged.handleProviderToolCall({
      providerCallId: "provider_call_forged",
      name: "invoke_agent",
      arguments: { agentCardId: "agent_card_worker" },
      lease: "forged",
    })).rejects.toThrow("conductor_tool_lease_invalid");

    const stale = createConductorToolHost({
      verifyLease: () => { throw new Error("conductor_tool_turn_stale"); },
      dispatch,
    });
    await expect(stale.handleProviderToolCall({
      providerCallId: "provider_call_stale",
      name: "invoke_agent",
      arguments: { agentCardId: "agent_card_worker" },
      lease: "expired",
    })).rejects.toThrow("conductor_tool_turn_stale");
    expect(dispatch).not.toHaveBeenCalled();
  });
});

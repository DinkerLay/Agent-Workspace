import { describe, expect, it, vi } from "vitest";
import {
  createProviderScopedToolCall,
  dispatchProviderScopedToolCall,
  type ProviderScopedToolRegistration,
} from "@agent-workspace/provider-port";

const registration: ProviderScopedToolRegistration = {
  capabilityClass: "runtime_orchestration",
  tools: [{
    name: "invoke_agent",
    description: "Create one Card Session.",
    inputSchema: { type: "object", additionalProperties: false },
  }],
};

describe("provider-neutral scoped tool calls", () => {
  it("reattaches an opaque Turn lease without interpreting tool arguments", () => {
    const lease = Object.freeze({ signed: "opaque" });
    expect(createProviderScopedToolCall({
      registration,
      turnContext: { capabilityClass: "runtime_orchestration", lease, handleCall: vi.fn() },
      nativeCall: { providerCallId: "native_call_1", name: "invoke_agent", arguments: { agentCardId: "agent_card_1" } },
    })).toEqual({
      providerCallId: "native_call_1",
      name: "invoke_agent",
      arguments: { agentCardId: "agent_card_1" },
      lease,
    });
  });

  it("rejects tools outside the Conductor registration", () => {
    expect(() => createProviderScopedToolCall({
      registration,
      turnContext: { capabilityClass: "runtime_orchestration", lease: {}, handleCall: vi.fn() },
      nativeCall: { providerCallId: "native_call_1", name: "workspace.write_text", arguments: {} },
    })).toThrow("provider_scoped_tool_not_registered");
  });

  it("requires the native result to correlate to the same Provider call", async () => {
    await expect(dispatchProviderScopedToolCall({
      registration,
      turnContext: {
        capabilityClass: "runtime_orchestration",
        lease: {},
        handleCall: async () => ({ providerCallId: "different_call", result: { status: "accepted" } }),
      },
      nativeCall: { providerCallId: "native_call_1", name: "invoke_agent", arguments: {} },
    })).rejects.toThrow("provider_scoped_tool_result_correlation_invalid");
  });
});

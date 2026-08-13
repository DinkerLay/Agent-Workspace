import { parseConductorOrchestrationToolCall } from "@agent-workspace/runtime-contracts";
import { describe, expect, it } from "vitest";

describe("Session-ID orchestration contracts", () => {
  it("accepts only agentCardId for invoke_agent", () => {
    expect(parseConductorOrchestrationToolCall({ name: "invoke_agent", arguments: { agentCardId: "agent_card_researcher" } })).toEqual({
      name: "invoke_agent",
      arguments: { agentCardId: "agent_card_researcher" },
    });
  });

  it("rejects legacy invoke payload and Host-owned scope fields", () => {
    expect(() => parseConductorOrchestrationToolCall({
      name: "invoke_agent",
      arguments: {
        agentCardId: "agent_card_researcher",
        instruction: "Legacy assignment text must not cross the tool boundary.",
        acceptanceCriteria: ["Legacy criterion"],
      },
    })).toThrow("orchestration_tool_arguments_invalid");
    expect(() => parseConductorOrchestrationToolCall({
      name: "invoke_agent",
      arguments: { agentCardId: "agent_card_researcher", runId: "run_spoofed" },
    })).toThrow("orchestration_tool_arguments_invalid");
  });

  it("accepts one send target with ordered message refs", () => {
    const call = {
      name: "send_to_session",
      arguments: {
        sessionId: "logical_session_reviewer_g1",
        payload: {
          content: "Review the selected evidence.",
          messageRefs: [
            { kind: "full_message", sourceMessageId: "message_research_final" },
            {
              kind: "relay_block",
              sourceMessageId: "message_research_final",
              relayBlockId: "relay_block_risk",
            },
          ],
        },
      },
    };

    expect(parseConductorOrchestrationToolCall(call)).toEqual(call);
    expect(() => parseConductorOrchestrationToolCall({
      name: "send_to_session",
      arguments: { sessionId: "logical_session_reviewer_g1", payload: {} },
    })).toThrow("orchestration_send_payload_empty");
  });

  it("keeps interrupt and close model inputs session-only", () => {
    expect(parseConductorOrchestrationToolCall({
      name: "interrupt_session",
      arguments: { sessionId: "logical_session_reviewer_g1" },
    })).toEqual({
      name: "interrupt_session",
      arguments: { sessionId: "logical_session_reviewer_g1" },
    });
    expect(parseConductorOrchestrationToolCall({
      name: "close_session",
      arguments: { sessionId: "logical_session_reviewer_g1" },
    })).toEqual({
      name: "close_session",
      arguments: { sessionId: "logical_session_reviewer_g1" },
    });
    expect(() => parseConductorOrchestrationToolCall({
      name: "interrupt_session",
      arguments: { sessionId: "logical_session_reviewer_g1", sessionTurnId: "session_turn_spoofed" },
    })).toThrow("orchestration_tool_arguments_invalid");
  });
});

import { createSessionIdOrchestrationKernel } from "@agent-workspace/runtime-domain";
import { describe, expect, it } from "vitest";

const NOW = "2026-08-11T00:00:00.000Z";

describe("Session-ID orchestration domain kernel", () => {
  it("materializes one generation without content or Provider facts", () => {
    const kernel = createKernel();

    const result = kernel.invokeAgent({
      runId: "run_phase2",
      agentCardId: "agent_card_researcher",
      idempotencyKey: "invoke:researcher:1",
    });

    expect(result).toEqual({ sessionId: "logical_session_researcher_g1" });
    expect(kernel.snapshot()).toMatchObject({
      slots: [{ agentCardId: "agent_card_researcher", currentSessionId: "logical_session_researcher_g1", generation: 1 }],
      messages: [],
      bindings: [],
      inboxItems: [],
      inputSubmissions: [],
      turns: [],
    });
  });

  it("rejects a second current invoke but freezes an idempotent replay", () => {
    const kernel = createKernel();
    const input = {
      runId: "run_phase2",
      agentCardId: "agent_card_researcher",
      idempotencyKey: "invoke:researcher:1",
    };

    expect(kernel.invokeAgent(input)).toEqual({ sessionId: "logical_session_researcher_g1" });
    expect(kernel.invokeAgent(input)).toEqual({ sessionId: "logical_session_researcher_g1" });
    expect(() => kernel.invokeAgent({ ...input, idempotencyKey: "invoke:researcher:2" }))
      .toThrow("card_session_slot_current_exists");
  });

  it("keeps one durable FIFO lane and fails closed on key reuse", () => {
    const kernel = createKernel();
    kernel.invokeAgent({
      runId: "run_phase2",
      agentCardId: "agent_card_researcher",
      idempotencyKey: "invoke:researcher:1",
    });
    const first = {
      runId: "run_phase2",
      sessionId: "logical_session_researcher_g1",
      idempotencyKey: "send:researcher:1",
      payload: { content: "First" },
    };
    const second = {
      runId: "run_phase2",
      sessionId: "logical_session_researcher_g1",
      idempotencyKey: "send:researcher:2",
      payload: { content: "Second" },
    };

    expect(kernel.sendToSession(first)).toEqual({ status: "accepted" });
    expect(kernel.sendToSession(second)).toEqual({ status: "accepted" });
    expect(kernel.sendToSession(first)).toEqual({ status: "accepted" });
    expect(() => kernel.sendToSession({ ...first, payload: { content: "Changed" } }))
      .toThrow("orchestration_idempotency_payload_conflict");
    expect(kernel.snapshot()).toMatchObject({
      inboxItems: [
        { renderedContent: "First", sequence: 1 },
        { renderedContent: "Second", sequence: 2 },
      ],
    });
  });

  it("closes one generation and rejects its old sessionId", () => {
    const kernel = createKernel();
    kernel.invokeAgent({
      runId: "run_phase2",
      agentCardId: "agent_card_researcher",
      idempotencyKey: "invoke:researcher:1",
    });

    expect(() => kernel.sendToSession({
      runId: "run_phase2",
      sessionId: "logical_session_unknown",
      idempotencyKey: "send:unknown:1",
      payload: { content: "Must reject" },
    })).toThrow("orchestration_session_unknown");
    expect(kernel.closeSession({
      runId: "run_phase2",
      sessionId: "logical_session_researcher_g1",
      idempotencyKey: "close:researcher:1",
    })).toEqual({ status: "closed" });
    expect(() => kernel.sendToSession({
      runId: "run_phase2",
      sessionId: "logical_session_researcher_g1",
      idempotencyKey: "send:closed:1",
      payload: { content: "Must reject" },
    })).toThrow("orchestration_session_not_current");
    expect(kernel.invokeAgent({
      runId: "run_phase2",
      agentCardId: "agent_card_researcher",
      idempotencyKey: "invoke:researcher:2",
    })).toEqual({ sessionId: "logical_session_researcher_g2" });
  });

  it("projects exact Final Human and Notice envelopes", () => {
    const kernel = createKernel();

    expect(kernel.projectFinalForConductor({
      messageId: "message_final",
      sourceSessionId: "logical_session_researcher_g1",
      content: [{ kind: "text", text: "Complete." }],
      runId: "run_internal",
      sessionTurnId: "session_turn_internal",
    })).toEqual({
      messageId: "message_final",
      sourceSessionId: "logical_session_researcher_g1",
      content: [{ kind: "text", text: "Complete." }],
    });
    expect(kernel.projectHumanInterventionForConductor({
      messageId: "message_human",
      sessionId: "logical_session_researcher_g1",
      content: "Use the corrected premise.",
      humanInterventionId: "human_internal",
    })).toEqual({
      messageId: "message_human",
      sessionId: "logical_session_researcher_g1",
      content: "Use the corrected premise.",
    });
    expect(kernel.projectSessionNoticeForConductor({
      messageId: "message_notice",
      sessionId: "logical_session_researcher_g1",
      content: "The interrupt outcome is unknown.",
      controlAuditId: "control_internal",
    })).toEqual({
      messageId: "message_notice",
      sessionId: "logical_session_researcher_g1",
      content: "The interrupt outcome is unknown.",
    });
  });

  it("keeps RelayBlock identities inside canonical content", () => {
    const kernel = createKernel();
    const canonical = kernel.canonicalizeFinal({
      messageId: "message_final",
      content: [
        "Summary.",
        "```relay",
        "topic: risk",
        "---",
        "Risk details.",
        "```",
      ].join("\n"),
    });

    expect(canonical).toEqual([
      { kind: "text", text: "Summary.\n" },
      expect.objectContaining({
        kind: "relay",
        relayBlockId: expect.stringMatching(/^relay_block_/),
        topic: "risk",
        content: "Risk details.\n",
      }),
    ]);
  });
});

function createKernel() {
  return createSessionIdOrchestrationKernel({
    now: () => NOW,
    createSessionId: ({ generation }) => `logical_session_researcher_g${String(generation)}`,
    executionProfileIdForAgentCard: () => "profile_researcher",
  });
}

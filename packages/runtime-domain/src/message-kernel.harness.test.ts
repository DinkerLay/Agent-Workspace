import { describe, expect, it } from "vitest";
import { createSessionMessage, extractRelayBlocks, renderMessageSelections } from "./messages";
import { createHumanIntervention, createSessionTurn, markHumanInterventionSent } from "./session-turns";

const NOW = "2026-08-09T00:00:00.000Z";

describe("message kernel harness", () => {
  it("extracts route hints without turning them into visibility or delivery authority", () => {
    const message = workerFinal([
      "Worker complete.",
      "",
      "```relay",
      "topic: game.turn",
      "to: agent_card_reviewer, agent_card_observer",
      "audience: publish",
      "format: text/markdown",
      "---",
      "Forward only this move.",
      "```",
    ].join("\n"));

    const blocks = extractRelayBlocks({ message });

    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      sourceMessageId: message.messageId,
      ordinal: 0,
      topic: "game.turn",
      suggestedTargetAgentCardIds: ["agent_card_reviewer", "agent_card_observer"],
      suggestedAudience: "publish",
      format: "text/markdown",
      content: "Forward only this move.\n",
    });
    expect(blocks[0]).not.toHaveProperty("visibility");
    expect(blocks[0]).not.toHaveProperty("targetAgentCardIds");
  });

  it("keeps the removed visibility grammar as ordinary final-message text", () => {
    const message = workerFinal([
      "```relay",
      "visibility: shared",
      "topic: stale",
      "---",
      "This must not become a RelayBlock.",
      "```",
    ].join("\n"));

    expect(extractRelayBlocks({ message })).toEqual([]);
    expect(message.content).toContain("visibility: shared");
  });

  it("renders an ordered multi-selection without leaking unselected message text", () => {
    const message = workerFinal([
      "Private surrounding text.",
      "```relay",
      "topic: first",
      "---",
      "FIRST",
      "```",
      "```relay",
      "topic: second",
      "---",
      "SECOND",
      "```",
      "```relay",
      "topic: third",
      "---",
      "THIRD",
      "```",
    ].join("\n"));
    const blocks = extractRelayBlocks({ message });

    const rendered = renderMessageSelections([
      { kind: "relay_block", relayBlock: blocks[2]! },
      { kind: "relay_block", relayBlock: blocks[0]! },
    ]);

    expect(rendered.indexOf("THIRD")).toBeLessThan(rendered.indexOf("FIRST"));
    expect(rendered).not.toContain("SECOND");
    expect(rendered).not.toContain("Private surrounding text.");
  });

  it("records idle human-direct provenance and requires both Card and Conductor message identities before sent", () => {
    const intervention = createHumanIntervention({
      humanInterventionId: "human_intervention_direct",
      taskId: "task_kernel",
      runId: "run_kernel",
      commandId: "command_direct",
      idempotencyKey: "direct:1",
      expectedTaskRevision: 3,
      targetLogicalSessionId: "logical_session_worker",
      content: "Correct the calculation.",
      now: NOW,
    });

    expect(intervention).toMatchObject({ mode: "direct", state: "ready_to_send" });
    expect(markHumanInterventionSent(intervention, {
      cardMessageId: "message_human_card",
      conductorMirrorMessageId: "message_human_mirror",
      now: NOW,
    })).toMatchObject({
      state: "sent",
      cardMessageId: "message_human_card",
      conductorMirrorMessageId: "message_human_mirror",
    });
  });

  it("turns a busy Card intervention into interrupt-then-send without creating a new Turn", () => {
    const activeTurn = createSessionTurn({
      sessionTurnId: "session_turn_active",
      taskId: "task_kernel",
      runId: "run_kernel",
      inputSubmissionId: "input_active",
      targetLogicalSessionId: "logical_session_worker",
      conductorLogicalSessionId: "logical_session_conductor",
      replyToLogicalSessionId: "logical_session_conductor",
      kind: "session_agent",
      initiator: "conductor",
      trigger: "conductor_invocation",
      invocationId: "invocation_active",
      now: NOW,
    });
    const intervention = createHumanIntervention({
      humanInterventionId: "human_intervention_busy",
      taskId: "task_kernel",
      runId: "run_kernel",
      commandId: "command_busy",
      idempotencyKey: "busy:1",
      expectedTaskRevision: 3,
      targetLogicalSessionId: "logical_session_worker",
      content: "Stop and use the corrected premise.",
      activeTurn,
      now: NOW,
    });

    expect(intervention).toMatchObject({
      mode: "interrupt_then_send",
      state: "interrupting",
      affectedSessionTurnId: "session_turn_active",
    });
    expect(intervention.cardMessageId).toBeUndefined();
    expect(intervention.conductorMirrorMessageId).toBeUndefined();
  });
});

function workerFinal(content: string) {
  return createSessionMessage({
    messageId: "message_worker_final",
    taskId: "task_kernel",
    runId: "run_kernel",
    sourceLogicalSessionId: "logical_session_worker",
    sourceSessionTurnId: "session_turn_worker",
    kind: "agent_final",
    content,
    createdAt: NOW,
  });
}

import { createSessionIdRaceRecoveryCoordinator } from "@agent-workspace/runtime-application";
import { describe, expect, it } from "vitest";

describe("Session-ID orchestration race and recovery", () => {
  it("rejects old Conductor calls after a Planning Fence", () => {
    const coordinator = createCoordinator();
    coordinator.acceptTaskInput({ commandId: "command_task_input", expectedRevision: 7, content: "Use the corrected goal." });
    expect(() => coordinator.sendToSession({
      conductorSessionTurnId: "session_turn_conductor_old",
      sessionId: "logical_session_researcher_g1",
      idempotencyKey: "send:stale:1",
      payload: { content: "Stale plan" },
    })).toThrow("conductor_planning_fence_stale_turn");
    expect(coordinator.snapshot()).toMatchObject({
      planningFence: expect.objectContaining({ sourceCommandId: "command_task_input" }),
      messageForwards: [],
    });
  });

  it("durably mirrors a busy human message before holding Card delivery", () => {
    const coordinator = createCoordinator();
    coordinator.acceptBusyHumanIntervention({
      commandId: "command_human_busy",
      idempotencyKey: "human:busy:1",
      sessionId: "logical_session_researcher_g1",
      content: "Stop and use the corrected premise.",
      activeSessionTurnId: "session_turn_researcher_active",
    });
    const snapshot = coordinator.snapshot();
    expect(snapshot).toMatchObject({
      humanInterventions: [expect.objectContaining({ mode: "interrupt_then_send", state: "interrupting" })],
      messages: [
        expect.objectContaining({ kind: "user_input", content: "Stop and use the corrected premise." }),
        expect.objectContaining({ kind: "user_input", content: "Stop and use the corrected premise." }),
      ],
      conductorInbox: [expect.objectContaining({ state: "pending" })],
      cardInbox: [expect.objectContaining({ state: "held_by_human_intervention" })],
      inputSubmissions: [],
    });
    expect(snapshot.conductorInbox[0]!.sequence).toBeLessThan(snapshot.cardInbox[0]!.sequence);
  });

  it("orders a causal Notice before a late Final", () => {
    const coordinator = createCoordinator();
    coordinator.acceptBusyHumanIntervention({
      commandId: "command_human_busy",
      idempotencyKey: "human:busy:1",
      sessionId: "logical_session_researcher_g1",
      content: "Use the correction.",
      activeSessionTurnId: "session_turn_researcher_active",
    });
    coordinator.recordLateFinal({
      sessionId: "logical_session_researcher_g1",
      sessionTurnId: "session_turn_researcher_active",
      messageId: "message_late_final",
      content: "Old result.",
    });
    expect(coordinator.readConductorInbox()).toEqual([
      expect.objectContaining({ kind: "human_intervention_for_conductor" }),
      expect.objectContaining({ kind: "session_notice_for_conductor", causalMessageId: "message_late_final" }),
      expect.objectContaining({ kind: "final_for_conductor", messageId: "message_late_final" }),
    ]);
  });

  it("records scoped interrupt intent without a text Message", () => {
    const coordinator = createCoordinator();
    expect(coordinator.requestUserScopedInterrupt({
      commandId: "command_interrupt_only",
      expectedRevision: 7,
      sessionId: "logical_session_researcher_g1",
    })).toEqual({ status: "accepted" });
    expect(coordinator.snapshot()).toMatchObject({
      humanInterventions: [expect.objectContaining({ mode: "scoped_interrupt" })],
      controlAudits: [expect.objectContaining({ state: "requested" })],
      messages: [],
      providerOutbox: [expect.objectContaining({ kind: "request_interrupt" })],
    });
    coordinator.recordInterruptOutcome({ sessionId: "logical_session_researcher_g1", outcome: "unknown" });
    expect(coordinator.readConductorInbox()).toEqual([
      expect.objectContaining({ kind: "session_notice_for_conductor" }),
    ]);
  });

  it("suppresses held and unconsumed inputs exactly once on Stop recovery", () => {
    const coordinator = createCoordinator();
    coordinator.acceptBusyHumanIntervention({
      commandId: "command_human_busy",
      idempotencyKey: "human:busy:1",
      sessionId: "logical_session_researcher_g1",
      content: "Use the correction.",
      activeSessionTurnId: "session_turn_researcher_active",
    });
    coordinator.acceptTaskStop({ commandId: "command_stop", expectedRevision: 7 });
    const stopped = coordinator.snapshot();
    coordinator.recover();
    coordinator.recover();
    expect(coordinator.snapshot()).toEqual(stopped);
    expect(stopped).toMatchObject({
      humanInterventions: [expect.objectContaining({ state: "cancelled_by_task_stop" })],
      cardInbox: [expect.objectContaining({ state: "suppressed", reason: "task_stop" })],
      conductorInbox: [expect.objectContaining({ state: "suppressed", reason: "task_stop" })],
      inputSubmissions: [],
    });
  });
});

function createCoordinator() {
  return createSessionIdRaceRecoveryCoordinator({
    now: () => "2026-08-11T00:00:00.000Z",
    task: {
      taskId: "task_phase4",
      runId: "run_phase4",
      revision: 7,
      conductorSessionId: "logical_session_conductor",
      activeConductorSessionTurnId: "session_turn_conductor_current",
    },
    sessions: [{
      sessionId: "logical_session_researcher_g1",
      activeSessionTurnId: "session_turn_researcher_active",
    }],
  });
}

import { describe, expect, it } from "vitest";
import { createSessionIdRaceRecoveryCoordinator } from "./session-id-orchestration-race-recovery";

describe("Session-ID race/recovery support", () => {
  it("keeps task-input fencing idempotent and rejects payload reuse", () => {
    const coordinator = createCoordinator();
    const command = { commandId: "command_goal", expectedRevision: 7, content: "New goal" };
    expect(coordinator.acceptTaskInput(command)).toEqual({ status: "accepted" });
    const frozen = coordinator.snapshot();
    expect(coordinator.acceptTaskInput(command)).toEqual({ status: "accepted" });
    expect(coordinator.snapshot()).toEqual(frozen);
    expect(() => coordinator.acceptTaskInput({ ...command, content: "Changed" }))
      .toThrow("orchestration_idempotency_payload_conflict");
  });

  it("separates accepted from confirmed interrupt and releases held input only on confirmation", () => {
    const coordinator = createCoordinator();
    coordinator.acceptBusyHumanIntervention({
      commandId: "command_human",
      idempotencyKey: "human:1",
      sessionId: "logical_session_busy",
      content: "Use correction",
      activeSessionTurnId: "session_turn_busy",
    });

    coordinator.recordInterruptOutcome({ sessionId: "logical_session_busy", outcome: "accepted" });
    expect(coordinator.snapshot()).toMatchObject({
      controlAudits: [expect.objectContaining({ state: "accepted" })],
      cardInbox: [expect.objectContaining({ state: "held_by_human_intervention" })],
    });
    coordinator.recordInterruptOutcome({ sessionId: "logical_session_busy", outcome: "confirmed" });
    const confirmed = coordinator.snapshot();
    expect(confirmed).toMatchObject({
      controlAudits: [expect.objectContaining({ state: "confirmed" })],
      humanInterventions: [expect.objectContaining({ state: "ready_to_deliver" })],
      cardInbox: [expect.objectContaining({ state: "pending" })],
    });
    expect(coordinator.recordInterruptOutcome({ sessionId: "logical_session_busy", outcome: "confirmed" }))
      .toEqual({ status: "recorded" });
    expect(coordinator.snapshot()).toEqual(confirmed);
  });

  it("enqueues the idle human mirror before Card delivery and blocks ordinary sends behind it", () => {
    const coordinator = createCoordinator();
    coordinator.acceptIdleHumanIntervention({
      commandId: "command_idle",
      idempotencyKey: "human:idle:1",
      sessionId: "logical_session_idle",
      content: "Please check this",
    });
    const snapshot = coordinator.snapshot();
    expect(snapshot).toMatchObject({
      conductorInbox: [expect.objectContaining({ state: "pending" })],
      cardInbox: [expect.objectContaining({ state: "pending" })],
      inputSubmissions: [],
    });
    expect(snapshot.conductorInbox[0]!.sequence).toBeLessThan(snapshot.cardInbox[0]!.sequence);
    expect(() => coordinator.sendToSession({
      conductorSessionTurnId: "session_turn_conductor_current",
      sessionId: "logical_session_idle",
      idempotencyKey: "send:blocked",
      payload: { content: "Must wait" },
    })).toThrow("human_intervention_path_active");
  });

  it("deduplicates a late Final and audits it without waking a stopped Run", () => {
    const coordinator = createCoordinator();
    coordinator.acceptTaskStop({ commandId: "command_stop", expectedRevision: 7 });
    expect(coordinator.recordLateFinal({
      sessionId: "logical_session_busy",
      sessionTurnId: "session_turn_busy",
      messageId: "message_late",
      content: "Late result",
    })).toEqual({ status: "audited" });
    const audited = coordinator.snapshot();
    expect(audited).toMatchObject({
      taskState: "stopped",
      conductorInbox: [],
      lateResultAudits: [expect.objectContaining({ messageId: "message_late" })],
    });
    expect(coordinator.recordLateFinal({
      sessionId: "logical_session_busy",
      sessionTurnId: "session_turn_busy",
      messageId: "message_late",
      content: "Late result",
    })).toEqual({ status: "recorded" });
    expect(coordinator.snapshot()).toEqual(audited);
  });

  it("abandons a held intervention with one causal Notice", () => {
    const coordinator = createCoordinator();
    coordinator.acceptBusyHumanIntervention({
      commandId: "command_human",
      idempotencyKey: "human:1",
      sessionId: "logical_session_busy",
      content: "Use correction",
      activeSessionTurnId: "session_turn_busy",
    });
    const id = coordinator.snapshot().humanInterventions[0]!.humanInterventionId;
    expect(coordinator.abandonHumanIntervention({ humanInterventionId: id, commandId: "command_abandon" }))
      .toEqual({ status: "abandoned" });
    const snapshot = coordinator.snapshot();
    expect(snapshot).toMatchObject({
      humanInterventions: [expect.objectContaining({ state: "cancelled_by_user" })],
      cardInbox: [expect.objectContaining({ state: "suppressed", reason: "human_intervention_abandoned" })],
    });
    expect(coordinator.readConductorInbox().filter((item) => item.kind === "session_notice_for_conductor")).toHaveLength(1);
    coordinator.abandonHumanIntervention({ humanInterventionId: id, commandId: "command_abandon" });
    expect(coordinator.readConductorInbox().filter((item) => item.kind === "session_notice_for_conductor")).toHaveLength(1);
  });
});

function createCoordinator() {
  return createSessionIdRaceRecoveryCoordinator({
    now: () => "2026-08-11T00:00:00.000Z",
    task: {
      taskId: "task_race",
      runId: "run_race",
      revision: 7,
      conductorSessionId: "logical_session_conductor",
      activeConductorSessionTurnId: "session_turn_conductor_current",
    },
    sessions: [
      { sessionId: "logical_session_busy", activeSessionTurnId: "session_turn_busy" },
      { sessionId: "logical_session_idle" },
    ],
  });
}

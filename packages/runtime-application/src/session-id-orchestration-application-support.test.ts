import { describe, expect, it } from "vitest";
import { createSessionIdOrchestrationApplication, type SessionIdProviderEffect } from "./session-id-orchestration-application";

describe("Session-ID orchestration application support", () => {
  it("requires a Provider-observed active Turn before Conductor interrupt", async () => {
    const harness = createHarness();
    const sessionId = invoke(harness.application);
    send(harness.application, sessionId);

    expect(() => harness.application.interruptSession(scoped({
      sessionId,
      idempotencyKey: "interrupt:before-active",
    }))).toThrow("session_interrupt_active_turn_required");
    expect(harness.effects).toEqual([]);

    harness.application.recordSessionTurnActive({
      runId: "run_support",
      sessionId,
      sessionTurnId: "session_turn_worker_1",
      sourceConductorSessionTurnId: "session_turn_conductor",
    });
    expect(harness.application.interruptSession(scoped({
      sessionId,
      idempotencyKey: "interrupt:1",
    }))).toEqual({ status: "accepted" });
    expect(harness.application.snapshot()).toMatchObject({
      controls: [expect.objectContaining({ state: "requested", sessionTurnId: "session_turn_worker_1" })],
      activeTurns: [expect.objectContaining({ state: "interrupt_requested" })],
    });

    await harness.application.drainOutbox();
    expect(harness.effects.map((effect) => effect.kind)).toEqual(["ensure_binding", "request_interrupt"]);
    expect(harness.application.snapshot()).toMatchObject({ controls: [expect.objectContaining({ state: "accepted" })] });
  });

  it("records terminal interrupt outcome separately and closes only after a safe terminal", async () => {
    const harness = createHarness();
    const sessionId = invoke(harness.application);
    send(harness.application, sessionId);
    harness.application.recordSessionTurnActive({
      runId: "run_support",
      sessionId,
      sessionTurnId: "session_turn_worker_1",
      sourceConductorSessionTurnId: "session_turn_conductor",
    });
    harness.application.interruptSession(scoped({ sessionId, idempotencyKey: "interrupt:1" }));
    await harness.application.drainOutbox();

    expect(() => harness.application.closeSession(scoped({ sessionId, idempotencyKey: "close:early" })))
      .toThrow("session_close_active_or_ambiguous");
    harness.application.recordInterruptOutcome({
      runId: "run_support",
      sessionId,
      sessionTurnId: "session_turn_worker_1",
      outcome: "confirmed",
    });
    expect(harness.application.closeSession(scoped({ sessionId, idempotencyKey: "close:1" })))
      .toEqual({ status: "closed" });
    expect(harness.application.closeSession(scoped({ sessionId, idempotencyKey: "close:1" })))
      .toEqual({ status: "closed" });
    expect(() => harness.application.sendToSession(scoped({
      sessionId,
      idempotencyKey: "send:closed",
      payload: { content: "No" },
    }))).toThrow("orchestration_session_not_current");
  });

  it("suppresses an undelivered binding effect when close retires the generation", async () => {
    const harness = createHarness();
    const sessionId = invoke(harness.application);
    send(harness.application, sessionId);
    expect(harness.application.closeSession(scoped({ sessionId, idempotencyKey: "close:1" })))
      .toEqual({ status: "closed" });
    expect(harness.application.snapshot()).toMatchObject({
      inboxItems: [expect.objectContaining({ state: "suppressed" })],
      outbox: [expect.objectContaining({ state: "suppressed", reason: "session_closed" })],
    });
    await harness.application.drainOutbox();
    expect(harness.effects).toEqual([]);
  });

  it("fails closed when an interrupt idempotency key changes target", () => {
    const harness = createHarness();
    const first = invoke(harness.application);
    harness.application.recordSessionTurnActive({
      runId: "run_support",
      sessionId: first,
      sessionTurnId: "session_turn_worker_1",
      sourceConductorSessionTurnId: "session_turn_conductor",
    });
    harness.application.interruptSession(scoped({ sessionId: first, idempotencyKey: "interrupt:shared" }));
    // A second generation is not required to prove payload freezing: mutating
    // the active Turn behind the same target changes the fingerprint as well.
    harness.application.recordInterruptOutcome({
      runId: "run_support",
      sessionId: first,
      sessionTurnId: "session_turn_worker_1",
      outcome: "confirmed",
    });
    harness.application.recordSessionTurnActive({
      runId: "run_support",
      sessionId: first,
      sessionTurnId: "session_turn_worker_2",
      sourceConductorSessionTurnId: "session_turn_conductor",
    });
    expect(() => harness.application.interruptSession(scoped({ sessionId: first, idempotencyKey: "interrupt:shared" })))
      .toThrow("orchestration_idempotency_payload_conflict");
  });
});

function createHarness() {
  let sequence = 0;
  const effects: SessionIdProviderEffect[] = [];
  const application = createSessionIdOrchestrationApplication({
    now: () => "2026-08-11T00:00:00.000Z",
    createId(kind) {
      sequence += 1;
      return kind === "logical_session" ? "logical_session_worker_g1" : `${kind}_support_${sequence}`;
    },
    task: {
      taskId: "task_support",
      runId: "run_support",
      revision: 7,
      conductorSessionId: "logical_session_conductor",
      conductorSessionTurnId: "session_turn_conductor",
      agentCards: [{ agentCardId: "agent_card_worker", executionProfileId: "profile_worker" }],
    },
    providerEffects: {
      async submit(effect) {
        effects.push(effect);
        return { status: "accepted" };
      },
    },
  });
  return { application, effects };
}

function invoke(application: ReturnType<typeof createSessionIdOrchestrationApplication>): string {
  return application.invokeAgent(scoped({
    agentCardId: "agent_card_worker",
    idempotencyKey: "invoke:1",
  })).sessionId;
}

function send(application: ReturnType<typeof createSessionIdOrchestrationApplication>, sessionId: string): void {
  application.sendToSession(scoped({
    sessionId,
    idempotencyKey: "send:1",
    payload: { content: "Work" },
  }));
}

function scoped<T extends Record<string, unknown>>(fields: T) {
  return {
    taskId: "task_support",
    runId: "run_support",
    expectedRevision: 7,
    conductorSessionId: "logical_session_conductor",
    conductorSessionTurnId: "session_turn_conductor",
    ...fields,
  };
}

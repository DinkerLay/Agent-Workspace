import {
  createSessionIdOrchestrationApplication,
  type SessionIdProviderEffect,
} from "@agent-workspace/runtime-application";
import { describe, expect, it } from "vitest";

const NOW = "2026-08-11T00:00:00.000Z";

describe("Session-ID orchestration application", () => {
  it("commits invoke without Binding Message Inbox Input or Turn", async () => {
    const { application, effects } = createApplication();

    expect(application.invokeAgent(scoped({
      idempotencyKey: "invoke:researcher:1",
      agentCardId: "agent_card_researcher",
    }))).toEqual({ sessionId: "logical_session_researcher_g1" });
    expect(application.snapshot()).toMatchObject({
      slots: [{ agentCardId: "agent_card_researcher", currentSessionId: "logical_session_researcher_g1", generation: 1 }],
      messages: [],
      bindings: [],
      inboxItems: [],
      inputSubmissions: [],
      turns: [],
    });
    expect(effects).toEqual([]);
  });

  it("commits one send atomically before Provider delivery", async () => {
    const { application, effects } = createApplication();
    const invoked = application.invokeAgent(scoped({
      idempotencyKey: "invoke:researcher:1",
      agentCardId: "agent_card_researcher",
    }));

    expect(application.sendToSession(scoped({
      idempotencyKey: "send:researcher:1",
      sessionId: invoked.sessionId,
      payload: { content: "Research the decision." },
    }))).toEqual({ status: "accepted" });
    expect(application.snapshot()).toMatchObject({
      messageForwards: [expect.objectContaining({ targetSessionId: "logical_session_researcher_g1" })],
      messages: [expect.objectContaining({ kind: "conductor_forward", content: "Research the decision." })],
      inboxItems: [expect.objectContaining({ state: "pending" })],
    });
    expect(effects).toEqual([]);

    await application.drainOutbox();
    expect(effects).toEqual([
      expect.objectContaining({ kind: "ensure_binding", sessionId: "logical_session_researcher_g1" }),
    ]);
  });

  it("returns one canonical final through the precise Conductor envelope", async () => {
    const { application } = createApplication();
    const invoked = application.invokeAgent(scoped({
      idempotencyKey: "invoke:researcher:1",
      agentCardId: "agent_card_researcher",
    }));
    application.sendToSession(scoped({
      idempotencyKey: "send:researcher:1",
      sessionId: invoked.sessionId,
      payload: { content: "Return one final." },
    }));

    application.recordAgentFinal({
      runId: "run_phase3",
      sessionId: invoked.sessionId,
      inputSubmissionId: "input_researcher_1",
      sessionTurnId: "session_turn_researcher_1",
      messageId: "message_researcher_final",
      content: "Complete.",
    });
    expect(application.readConductorInputs()).toEqual([{
      kind: "final_for_conductor",
      messageId: "message_researcher_final",
      sourceSessionId: "logical_session_researcher_g1",
      content: [{ kind: "text", text: "Complete." }],
    }]);
    await expect(Promise.resolve().then(() => application.recordAgentFinal({
      runId: "run_phase3",
      sessionId: invoked.sessionId,
      inputSubmissionId: "input_researcher_1",
      sessionTurnId: "session_turn_researcher_1",
      messageId: "message_duplicate_final",
      content: "Duplicate.",
    }))).rejects.toThrow("session_turn_final_already_recorded");
  });

  it("rejects cross-run and stale scoped calls before effects", async () => {
    const { application, effects } = createApplication();

    await expect(Promise.resolve().then(() => application.invokeAgent(scoped({
      runId: "run_other",
      idempotencyKey: "invoke:cross-run",
      agentCardId: "agent_card_researcher",
    })))).rejects.toThrow("orchestration_scope_run_mismatch");
    await expect(Promise.resolve().then(() => application.invokeAgent(scoped({
      conductorSessionTurnId: "session_turn_stale",
      idempotencyKey: "invoke:stale-turn",
      agentCardId: "agent_card_researcher",
    })))).rejects.toThrow("orchestration_scope_turn_stale");
    expect(effects).toEqual([]);
    expect(application.snapshot()).toMatchObject({ slots: [], messages: [], inboxItems: [] });
  });
});

function createApplication() {
  const effects: SessionIdProviderEffect[] = [];
  const application = createSessionIdOrchestrationApplication({
    now: () => NOW,
    createId: (kind: unknown) => deterministicId(String(kind)),
    task: {
      taskId: "task_phase3",
      runId: "run_phase3",
      revision: 7,
      conductorSessionId: "logical_session_conductor",
      conductorSessionTurnId: "session_turn_conductor",
      agentCards: [
        { agentCardId: "agent_card_researcher", executionProfileId: "profile_researcher" },
        { agentCardId: "agent_card_reviewer", executionProfileId: "profile_reviewer" },
      ],
    },
    providerEffects: {
      submit: async (effect: SessionIdProviderEffect) => {
        effects.push(effect);
        return { status: "accepted" };
      },
    },
  });
  return { application, effects };
}

function scoped<T extends Record<string, unknown>>(overrides: T) {
  return {
    taskId: "task_phase3",
    runId: "run_phase3",
    expectedRevision: 7,
    conductorSessionId: "logical_session_conductor",
    conductorSessionTurnId: "session_turn_conductor",
    ...overrides,
  };
}

function deterministicId(kind: string): string {
  const suffix: Record<string, string> = {
    session: "logical_session_researcher_g1",
    logical_session: "logical_session_researcher_g1",
    message: "message_phase3_1",
    message_forward: "message_forward_phase3_1",
    inbox_item: "inbox_phase3_1",
    input_submission: "input_researcher_1",
    session_turn: "session_turn_researcher_1",
  };
  return suffix[kind] ?? `${kind}_phase3_1`;
}

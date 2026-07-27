import { describe, expect, it } from "vitest";
import {
  createDispatchId,
  normalizeSessionStoreCursor,
  type CallSessionResult,
  type CallSessionInput,
  type ReadTaskStateResult,
  type ReadSessionResult,
} from "./types";

describe("Conductor tool contracts", () => {
  it("creates short display-safe dispatch ids from task and target session", () => {
    expect(createDispatchId("task-1", "task-1-researcher", 1)).toMatch(/^[A-F0-9]{6}$/);
    expect(createDispatchId("task-1", "task-1-researcher", 1)).toBe(createDispatchId("task-1", "task-1-researcher", 1));
  });

  it("normalizes invalid read cursors to zero", () => {
    expect(normalizeSessionStoreCursor(undefined)).toBe(0);
    expect(normalizeSessionStoreCursor(-1)).toBe(0);
    expect(normalizeSessionStoreCursor(3.8)).toBe(3);
  });

  it("expresses async call_session input and read_session output shapes", () => {
    const input: CallSessionInput = {
      taskId: "task-1",
      toSessionId: "task-1-researcher",
      assignment: "Research dynamic workflow behavior.",
      contextRefs: ["docs/research/session-communication-mechanisms-2026-06-28.zh.md"],
      expectedOutput: "Research report",
      priority: "normal",
      force: true,
    };
    const result: ReadSessionResult = {
      sessionId: "task-1-researcher",
      state: "ready",
      cursor: 2,
      cleanTranscriptTail: "done",
      events: [],
      dispatches: [],
      results: [],
      messages: [],
      permissions: [],
      artifacts: [],
    };

    expect(input.priority).toBe("normal");
    expect(input.force).toBe(true);
    expect(result.state).toBe("ready");
  });

  it("expresses call_session as dispatch-only and task state as the loop summary", () => {
    const callResult: CallSessionResult = {
      ok: true,
      dispatchId: "A1B2C3",
      taskId: "task-1",
      toSessionId: "task-1-researcher",
      status: "delivered",
      deliveryState: "delivered",
      targetSessionState: "delivered_pending",
      resultState: "pending",
      async: true,
      turnPolicy: "continue_dispatching_or_wait",
      nextAllowedAction: "wait_for_runtime_wakeup",
      cannotReadResultUntil: "provider_result_available",
      message:
        "Assignment delivered to a native Session Agent. You may dispatch other independent work, or wait for a semantic Runtime wakeup before using its result.",
    };
    const taskState: ReadTaskStateResult = {
      taskId: "task-1",
      cursor: 3,
      sessions: [{ sessionId: "task-1-researcher", state: "ready", cursor: 2 }],
      dispatches: [
        { dispatchId: "A1B2C3", toSessionId: "task-1-researcher", status: "result_available" },
      ],
      results: [
        {
          resultId: "result-1",
          dispatchId: "A1B2C3",
          sessionId: "task-1-researcher",
        },
      ],
      messages: [
        {
          taskId: "task-1",
          sessionId: "task-1-researcher",
          dispatchId: "A1B2C3",
          resultId: "result-1",
          answerText: "Worker answer.",
          answerPreview: "Worker answer.",
          source: "opencode-message-parts",
          createdAt: "2026-06-30T00:00:00.000Z",
        },
      ],
      pendingDecisions: [{ type: "worker_result_available", dispatchId: "A1B2C3", sessionId: "task-1-researcher" }],
    };

    expect(callResult.turnPolicy).toBe("continue_dispatching_or_wait");
    expect(taskState.messages[0]?.dispatchId).toBe("A1B2C3");
    expect(taskState.pendingDecisions[0]?.type).toBe("worker_result_available");
  });
});

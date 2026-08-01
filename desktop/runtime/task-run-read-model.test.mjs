import assert from "node:assert/strict";
import { projectTaskRunReadModel } from "./task-run-read-model.cjs";

const isVitest = process.env.VITEST === "true" || process.env.VITEST_WORKER_ID !== undefined;
const testApi = isVitest ? await import("vitest") : await import("node:test");
const { describe, it } = testApi;

describe("TaskRunReadModel", () => {
  it("projects typed owner facts without mutating or repairing an input store", () => {
    const task = {
      taskId: "task-1",
      architecture: { template: { name: "Loop" } },
    };
    const run = { runId: "run-1", taskId: "task-1", status: "running", conductorSessionId: "conductor", createdAt: "created" };
    const allSessionState = {
      taskId: "task-1",
      sessions: [
        { sessionId: "conductor", state: "waiting_conductor" },
        { sessionId: "worker", state: "result_available" },
        { sessionId: "old-run-worker", state: "running" },
      ],
      dispatches: [
        { dispatchId: "D1", toSessionId: "worker", status: "result_available" },
        { dispatchId: "D0", toSessionId: "old-run-worker", status: "delivered" },
      ],
      results: [{ resultId: "R1", sessionId: "worker" }],
      messages: [{ sessionId: "conductor", message: "current" }, { sessionId: "old-conductor", message: "old" }],
      pendingDecisions: [{ type: "worker_result_available", sessionId: "worker" }, { type: "session_blocked", sessionId: "old-run-worker" }],
    };
    const before = JSON.stringify({ task, run, allSessionState });
    const projected = projectTaskRunReadModel({
      task,
      run,
      allSessionState,
      sessionEntries: [
        { card: { id: "conductor" }, sessionId: "conductor", terminal: { status: "running" }, sessionView: { results: [] } },
        { card: { id: "worker" }, sessionId: "worker", terminal: undefined, sessionView: { results: [{ answerText: "done", completedAt: "finished" }] } },
        { card: { id: "unused" }, sessionId: "unused", terminal: undefined, sessionView: { results: [] } },
      ],
      artifacts: [{ path: "result.md" }],
      events: [{ type: "conductor.started" }],
      continuity: { disposition: "continuable" },
    });

    assert.equal(JSON.stringify({ task, run, allSessionState }), before);
    assert.deepEqual(projected.runtimeState.sessions.map((item) => item.sessionId), ["conductor", "worker"]);
    assert.deepEqual(projected.runtimeState.dispatches.map((item) => item.dispatchId), ["D1"]);
    assert.deepEqual(projected.runtimeState.messages.map((item) => item.message), ["current"]);
    assert.deepEqual(projected.attentions.map((item) => item.sessionId), ["worker"]);
    assert.deepEqual(projected.turns.map((turn) => turn.nodeId), ["conductor", "worker"]);
    assert.equal(projected.turns[1].status, "succeeded");
    assert.equal(projected.turns[1].output.answerText, "done");
  });
});

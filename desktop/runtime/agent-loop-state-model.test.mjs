import assert from "node:assert/strict";
import {
  TASK_STATUS,
  assertTaskStatusTransition,
  canTransitionTaskStatus,
  isTaskUnavailableForContinuation,
} from "./agent-loop-state-model.cjs";

const isVitest = process.env.VITEST === "true" || process.env.VITEST_WORKER_ID !== undefined;
const testApi = isVitest ? await import("vitest") : await import("node:test");
const { describe, it } = testApi;

describe("Agent Loop state model", () => {
  it("requires a delivery claim before a Task can be achieved", () => {
    assert.equal(canTransitionTaskStatus(TASK_STATUS.RUNNING, TASK_STATUS.ACHIEVED), false);
    assert.equal(canTransitionTaskStatus(TASK_STATUS.DELIVERY_READY, TASK_STATUS.ACHIEVED), true);
    assert.throws(
      () => assertTaskStatusTransition(TASK_STATUS.RUNNING, TASK_STATUS.ACHIEVED, "loop_task_not_achievable"),
      /loop_task_not_achievable/,
    );
  });

  it("keeps transient lifecycle operations closed to continuation", () => {
    assert.equal(isTaskUnavailableForContinuation(TASK_STATUS.STOPPING), true);
    assert.equal(isTaskUnavailableForContinuation(TASK_STATUS.DELETING), true);
    assert.equal(isTaskUnavailableForContinuation(TASK_STATUS.DELIVERY_READY), false);
  });

  it("permits a failed native start to compensate running back to queued", () => {
    assert.equal(canTransitionTaskStatus(TASK_STATUS.RUNNING, TASK_STATUS.QUEUED), true);
  });
});

import assert from "node:assert/strict";
import { createTerminalInputArbiter } from "./terminal-input-arbiter.cjs";

const isVitest = process.env.VITEST === "true" || process.env.VITEST_WORKER_ID !== undefined;
const testApi = isVitest ? await import("vitest") : await import("node:test");
const { describe, it } = testApi;

describe("Terminal Input Arbiter", () => {
  it("accepts a Task-page native-question reply as user-priority terminal input", async () => {
    const writes = [];
    const arbiter = createTerminalInputArbiter({
      resolveOwner: async () => ({ state: "active", incarnationId: "inc-question" }),
      write: async (input) => { writes.push(input); return { accepted: true }; },
    });

    const receipt = await arbiter.enqueue({
      workspaceSessionId: "opencode:project:task:publisher",
      expectedIncarnationId: "inc-question",
      source: "task_question_answer",
      payload: "confirmed\r",
      idempotencyKey: "question:task:publisher:part-1",
    });

    assert.equal(receipt.disposition, "written");
    assert.deepEqual(writes, [{
      workspaceSessionId: "opencode:project:task:publisher",
      expectedIncarnationId: "inc-question",
      source: "task_question_answer",
      payload: "confirmed\r",
    }]);
  });
});

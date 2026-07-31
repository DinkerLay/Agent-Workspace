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

  it("retries a rejected idempotent input after the owner is replaced", async () => {
    let owner = { state: "active", incarnationId: "inc-old" };
    let attempts = 0;
    const arbiter = createTerminalInputArbiter({
      resolveOwner: async () => owner,
      write: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("terminal_write_rejected");
        return { accepted: true };
      },
    });
    const input = {
      workspaceSessionId: "opencode:project:task:conductor",
      source: "conductor_wakeup",
      payload: "continue\r",
      idempotencyKey: "wakeup:durable-input-1",
    };

    await assert.rejects(
      arbiter.enqueue({ ...input, expectedIncarnationId: "inc-old" }),
      /terminal_write_rejected/,
    );
    owner = { state: "active", incarnationId: "inc-new" };

    const receipt = await arbiter.enqueue({ ...input, expectedIncarnationId: "inc-new" });
    assert.equal(receipt.disposition, "written");
    assert.equal(receipt.incarnationId, "inc-new");
    assert.equal(attempts, 2);
  });
});

import assert from "node:assert/strict";
import {
  findProviderSessionForDispatch,
  getDispatchAssistantAnswer,
  getLastEffectiveAssistantAnswer,
} from "./session-adapter.cjs";

const isVitest = process.env.VITEST === "true" || process.env.VITEST_WORKER_ID !== undefined;
const testApi = isVitest ? await import("vitest") : await import("node:test");
const { describe, it } = testApi;
const expect = isVitest ? testApi.expect : nodeExpect;

function nodeExpect(actual) {
  return {
    toBe(expected) {
      assert.strictEqual(actual, expected);
    },
    toEqual(expected) {
      assert.deepStrictEqual(actual, expected);
    },
    toMatchObject(expected) {
      assert.partialDeepStrictEqual(actual, expected);
    },
  };
}

describe("opencode session adapter", () => {
  it("finds the provider session that received a dispatch assignment", async () => {
    const rows = [];
    const query = async (sql) => {
      rows.push(sql);
      return [{ sessionId: "ses_worker", dispatchMessageCreatedAt: 2000 }];
    };

    const result = await findProviderSessionForDispatch({
      dispatchId: "A1B2C3",
      cwd: "/tmp/project",
      query,
    });

    expect(result).toEqual({
      providerSessionId: "ses_worker",
      dispatchMessageCreatedAt: 2000,
    });
    expect(rows[0].includes("A1B2C3")).toBe(true);
    expect(rows[0].includes("/tmp/project")).toBe(true);
  });

  it("matches the worker assignment marker after the dispatch creation time", async () => {
    const rows = [];
    const query = async (sql) => {
      rows.push(sql);
      return [{ sessionId: "ses_worker", dispatchMessageCreatedAt: 7000 }];
    };

    const result = await findProviderSessionForDispatch({
      dispatchId: "B2C3D4",
      cwd: "/tmp/project",
      dispatchCreatedAt: "2026-06-30T00:00:05.000Z",
      query,
    });

    expect(result).toEqual({
      providerSessionId: "ses_worker",
      dispatchMessageCreatedAt: 7000,
    });
    expect(rows[0].includes("[Agent Workspace] Dispatch ID B2C3D4")).toBe(true);
    expect(rows[0].includes("Dispatch Key")).toBe(false);
    expect(rows[0].includes("m.time_created >= 1782777605000")).toBe(true);
  });

  it("returns the latest assistant text answer only from a stopped assistant turn", async () => {
    const queries = [];
    const query = async (sql) => {
      queries.push(sql);
      return [
      {
        messageId: "msg_final",
        messageCreatedAt: 4000,
        completedAt: 4100,
        stepFinishId: "prt_stop",
        stepFinishedAt: 4101,
        stepFinishReason: "stop",
        partId: "part_1",
        partCreatedAt: 4001,
        text: "Final answer without thinking.",
      },
      {
        messageId: "msg_final",
        messageCreatedAt: 4000,
        completedAt: 4100,
        stepFinishId: "prt_stop",
        stepFinishedAt: 4101,
        stepFinishReason: "stop",
        partId: "part_2",
        partCreatedAt: 4002,
        text: "Second paragraph.",
      },
      ];
    };

    const result = await getLastEffectiveAssistantAnswer({
      providerSessionId: "ses_worker",
      afterMessageCreatedAt: 2000,
      query,
    });

    expect(result).toMatchObject({
      provider: "opencode",
      providerSessionId: "ses_worker",
      messageId: "msg_final",
      completedAt: 4100,
      stepFinishId: "prt_stop",
      stepFinishReason: "stop",
      answerText: "Final answer without thinking.\n\nSecond paragraph.",
    });
    expect(queries[0].includes("step-finish")).toBe(true);
    expect(queries[0].includes("stop")).toBe(true);
  });

  it("does not return an answer before opencode reaches a stop step-finish", async () => {
    const query = async () => [];

    const result = await getLastEffectiveAssistantAnswer({
      providerSessionId: "ses_worker",
      afterMessageCreatedAt: 2000,
      query,
    });

    expect(result).toBe(undefined);
  });

  it("returns the first completed assistant answer for the matched dispatch window", async () => {
    const queries = [];
    const query = async (sql) => {
      queries.push(sql);
      if (sql.includes("dispatchMessageCreatedAt")) {
        return [{ sessionId: "ses_worker", dispatchMessageCreatedAt: 2000 }];
      }
      return [
        {
          messageId: "msg_first",
          messageCreatedAt: 3000,
          completedAt: 3100,
          stepFinishId: "prt_stop_1",
          stepFinishedAt: 3101,
          stepFinishReason: "stop",
          partId: "part_1",
          partCreatedAt: 3001,
          text: "First dispatch result.",
        },
      ];
    };

    const result = await getDispatchAssistantAnswer({
      dispatchId: "C3D4E5",
      cwd: "/tmp/project",
      dispatchCreatedAt: "2026-06-30T00:00:05.000Z",
      query,
    });

    expect(result).toMatchObject({
      providerSessionId: "ses_worker",
      messageId: "msg_first",
      answerText: "First dispatch result.",
      dispatchMessageCreatedAt: 2000,
    });
    expect(queries[1].includes("next_assignment")).toBe(true);
    expect(queries[1].includes("order by m.time_created asc")).toBe(true);
  });
});

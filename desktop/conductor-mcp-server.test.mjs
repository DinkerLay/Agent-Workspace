import assert from "node:assert/strict";
import { handleMcpMessage } from "./conductor-mcp-server.cjs";

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

describe("Conductor MCP server", () => {
  it("lists Conductor tools", async () => {
    const result = await handleMcpMessage(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {},
      },
      {
        callTool: async () => ({}),
      },
    );

    expect(result.id).toBe(1);
    expect(result.result.tools.map((tool) => tool.name)).toEqual([
      "call_session",
      "read_task_state",
      "read_session",
      "claim_task_completion",
    ]);
  });

  it("forwards tools/call to the bridge client", async () => {
    const result = await handleMcpMessage(
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "call_session",
          arguments: {
            taskId: "task-1",
            toSessionId: "task-1-researcher",
            assignment: "research",
          },
        },
      },
      {
        callTool: async (name, args) => ({ name, args, ok: true, status: "delivered", deliveryState: "delivered" }),
      },
    );

    expect(result.result.content[0].text).toContain('"ok":true');
    expect(result.result.content[0].text).toContain('"status":"delivered"');
  });

  it("does not respond to MCP notifications without ids", async () => {
    const result = await handleMcpMessage(
      {
        jsonrpc: "2.0",
        method: "notifications/initialized",
        params: {},
      },
      {
        callTool: async () => ({}),
      },
    );

    expect(result).toBe(undefined);
  });
});

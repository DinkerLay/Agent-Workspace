import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createOrcaTerminalDaemonManager } = require("./orca-terminal-daemon-manager.cjs");

const isVitest = process.env.VITEST === "true" || process.env.VITEST_WORKER_ID !== undefined;
const testApi = isVitest ? await import("vitest") : await import("node:test");
const { describe, it } = testApi;

describe("Orca terminal daemon manager", () => {
  it("does not carry an old alternate buffer into a newly-created physical PTY", async () => {
    const streams = [];
    let createCount = 0;
    const manager = createOrcaTerminalDaemonManager({
      endpointProvider: async () => ({ host: "127.0.0.1", port: 1, token: "test" }),
      connectControl: async () => ({
        async request(method) {
          if (method !== "terminal.createOrAttach") throw new Error(`unexpected_method:${method}`);
          createCount += 1;
          return {
            disposition: "created",
            session: session(`generation-${createCount}`, `incarnation-${createCount}`),
          };
        },
        close() {},
      }),
      connectStream: async (_endpoint, { onEvent }) => {
        const stream = {
          onEvent,
          async subscribe() { return { accepted: true }; },
          async acknowledge() { return { accepted: true }; },
          async unsubscribe() { return { accepted: true }; },
          close() {},
        };
        streams.push(stream);
        return stream;
      },
    });

    await manager.createOrAttach(input("generation-1"));
    streams[0].onEvent({
      type: "terminal.delta",
      sessionId: "opencode:task-1:conductor",
      generation: "generation-1",
      cursor: 91,
      startCursor: 0,
      chunk: "\u001b[?1049h",
      bufferMode: "alternate",
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(
      pickTransport(manager.get("opencode:task-1:conductor")),
      { generation: "generation-1", cursor: 91, bufferMode: "alternate" },
    );

    await manager.createOrAttach(input("generation-2"));
    assert.deepEqual(
      pickTransport(manager.get("opencode:task-1:conductor")),
      { generation: "generation-2", cursor: 0, bufferMode: "normal" },
      "new PTYs must wait for their own alternate-buffer transition",
    );

    streams[1].onEvent({
      type: "terminal.snapshot",
      sessionId: "opencode:task-1:conductor",
      generation: "generation-2",
      snapshot: { cols: 120, rows: 32, cursor: 8, bufferMode: "alternate" },
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(
      pickTransport(manager.get("opencode:task-1:conductor")),
      { generation: "generation-2", cursor: 8, bufferMode: "alternate" },
      "the authoritative snapshot must restore the new terminal's actual buffer mode",
    );
    await manager.close();
  });
});

function input(generation) {
  return {
    id: "opencode:task-1:conductor",
    taskId: "task-1",
    command: "opencode",
    args: [],
    cwd: "/tmp",
    generation,
  };
}

function session(generation, incarnationId) {
  return {
    ...input(generation),
    incarnationId,
    status: "running",
    cursor: 0,
    cols: 120,
    rows: 32,
  };
}

function pickTransport(value) {
  return {
    generation: value.generation,
    cursor: value.cursor,
    bufferMode: value.bufferMode,
  };
}

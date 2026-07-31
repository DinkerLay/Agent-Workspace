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

  it("serializes replacement attachments for one renderer client", async () => {
    const streams = [];
    let releaseFirstAttachmentStream;
    let releaseSecondAttachmentStream;
    const firstAttachmentStream = new Promise((resolve) => { releaseFirstAttachmentStream = resolve; });
    const secondAttachmentStream = new Promise((resolve) => { releaseSecondAttachmentStream = resolve; });
    const manager = createOrcaTerminalDaemonManager({
      endpointProvider: async () => ({ host: "127.0.0.1", port: 1, token: "test" }),
      connectControl: async () => ({
        async request(method) {
          if (method !== "terminal.createOrAttach") throw new Error(`unexpected_method:${method}`);
          return { disposition: "created", session: session("generation-1", "incarnation-1") };
        },
        close() {},
      }),
      connectStream: async (_endpoint, { onEvent }) => {
        const stream = {
          onEvent,
          unsubscribed: 0,
          async subscribe() { return { accepted: true }; },
          async acknowledge() { return { accepted: true }; },
          async unsubscribe() { this.unsubscribed += 1; return { accepted: true }; },
          close() {},
        };
        streams.push(stream);
        if (streams.length === 2) releaseFirstAttachmentStream();
        if (streams.length === 3) releaseSecondAttachmentStream();
        return stream;
      },
    });
    const clientEvents = [];
    manager.onClientEvent((event) => clientEvents.push(event));
    await manager.createOrAttach(input("generation-1"));

    const first = manager.attachClient({ id: "opencode:task-1:conductor", clientId: "renderer-1", generation: "attach-1" });
    await firstAttachmentStream;
    const second = manager.attachClient({ id: "opencode:task-1:conductor", clientId: "renderer-1", generation: "attach-2" });
    await secondAttachmentStream;
    await assert.rejects(first, /terminal_attachment_closed/);
    streams[2].onEvent({
      type: "terminal.snapshot",
      sessionId: "opencode:task-1:conductor",
      generation: "generation-1",
      snapshot: { cols: 120, rows: 32, cursor: 8, bufferMode: "alternate", ansi: "new" },
    });
    await second;

    streams[1].onEvent({
      type: "terminal.delta",
      sessionId: "opencode:task-1:conductor",
      generation: "generation-1",
      startCursor: 4,
      cursor: 5,
      chunk: "stale",
      bufferMode: "normal",
    });
    streams[2].onEvent({
      type: "terminal.delta",
      sessionId: "opencode:task-1:conductor",
      generation: "generation-1",
      startCursor: 8,
      cursor: 9,
      chunk: "current",
      bufferMode: "alternate",
    });

    assert.equal(streams[1].unsubscribed, 1);
    assert.deepEqual(clientEvents, [{
      type: "data",
      id: "opencode:task-1:conductor",
      chunk: "current",
      startCursor: 8,
      cursor: 9,
      generation: "attach-2",
      bufferMode: "alternate",
    }]);
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

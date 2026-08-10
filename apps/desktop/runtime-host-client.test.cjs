"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");
const { RUNTIME_SUBPROTOCOL, createAuthenticatedRuntimeHostBridge } = require("./runtime-host-client.cjs");

test("main-process Runtime Host client sends typed HTTP requests with its private bridge credential", async () => {
  const calls = [];
  const bridge = createAuthenticatedRuntimeHostBridge({
    baseUrl: "http://127.0.0.1:4312/",
    token: "desktop_bridge-token",
    origin: "agent-workspace://desktop",
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return { ok: true, status: 200, json: async () => ({ accepted: true }) };
    },
  });

  assert.deepEqual(await bridge.read({ request: { taskId: "task_1" } }), { accepted: true });
  assert.deepEqual(
    await bridge.command({ command: { type: "task.start", commandId: "command_1" }, scope: { webContentsId: 42 } }),
    { accepted: true },
  );

  assert.deepEqual(calls, [
    {
      url: "http://127.0.0.1:4312/runtime/read",
      options: {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer desktop_bridge-token",
          origin: "agent-workspace://desktop",
        },
        body: JSON.stringify({ taskId: "task_1" }),
      },
    },
    {
      url: "http://127.0.0.1:4312/runtime/command",
      options: {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer desktop_bridge-token",
          origin: "agent-workspace://desktop",
        },
        body: JSON.stringify({ type: "task.start", commandId: "command_1" }),
      },
    },
  ]);
  assert.doesNotMatch(JSON.stringify(Object.keys(bridge)), /token|fetch|provider|pty|file/i);
});

test("main-process Runtime Host client preserves safe typed Task and Meta error codes", async () => {
  const codes = [
    "provider_version_mismatch",
    "protocol_fingerprint_mismatch",
    "capability_missing",
    "provider_unavailable",
    "execution_profile_unavailable",
    "expected_revision_stale",
    "meta_profile_option_unavailable",
    "meta_agent_provider_not_composed",
    "meta_profile_protocol_mismatch",
    "meta_agent_capability_unavailable",
    "meta_agent_capability_probe_failed",
    "meta_agent_profile_unavailable",
  ];
  let index = 0;
  const bridge = createAuthenticatedRuntimeHostBridge({
    baseUrl: "http://127.0.0.1:4312",
    token: "desktop_bridge-token",
    fetchImpl: async () => ({
      ok: false,
      status: 400,
      json: async () => ({ error: { code: codes[index++] } }),
    }),
  });

  for (const code of codes) {
    await assert.rejects(
      bridge.command({ command: { type: "task.start", commandId: `command_${code}` } }),
      { message: code },
    );
  }
});

test("main-process Runtime Host client fails closed on an untyped error body", async () => {
  const bridge = createAuthenticatedRuntimeHostBridge({
    baseUrl: "http://127.0.0.1:4312",
    token: "desktop_bridge-token",
    fetchImpl: async () => ({
      ok: false,
      status: 500,
      json: async () => { throw new Error("token=host-secret"); },
    }),
  });

  await assert.rejects(
    bridge.command({ command: { type: "task.start", commandId: "command_1" } }),
    { message: "runtime_command_failed" },
  );
});

test("main-process Runtime Host client relays only semantic invalidations over authenticated WebSocket", async () => {
  const socket = new FakeSocket();
  const sockets = [];
  const seen = [];
  const bridge = createAuthenticatedRuntimeHostBridge({
    baseUrl: "https://runtime.example.test",
    token: "desktop_bridge-token",
    webSocketFactory: (url, protocols, options) => {
      sockets.push({ url, protocols, options });
      return socket;
    },
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}) }),
  });

  const pendingUnsubscribe = bridge.subscribe({
    request: { taskId: "task_1" },
    onInvalidation: (invalidation) => seen.push(invalidation),
  });
  socket.emit("open");
  const unsubscribe = await pendingUnsubscribe;
  socket.emit("message", Buffer.from(JSON.stringify({ type: "runtime.invalidated", invalidation: { type: "task.changed", taskId: "task_1" } })));
  socket.emit("message", Buffer.from(JSON.stringify({ type: "provider.raw", payload: "must not pass" })));

  assert.deepEqual(sockets, [{
    url: "wss://runtime.example.test/runtime/subscribe?taskId=task_1",
    protocols: [RUNTIME_SUBPROTOCOL, "desktop_bridge-token"],
    options: undefined,
  }]);
  assert.deepEqual(seen, [{ type: "task.changed", taskId: "task_1" }]);
  await unsubscribe();
  assert.equal(socket.closeCalls, 1);
  socket.emit("message", Buffer.from(JSON.stringify({ type: "runtime.invalidated", invalidation: { type: "task.changed", taskId: "task_2" } })));
  assert.deepEqual(seen, [{ type: "task.changed", taskId: "task_1" }]);
});

test("main-process Runtime Host client rejects malformed bridge configuration", () => {
  assert.throws(
    () => createAuthenticatedRuntimeHostBridge({ baseUrl: "file:///runtime", token: "bridge-token" }),
    /runtime_host_url_protocol_invalid/,
  );
  assert.throws(
    () => createAuthenticatedRuntimeHostBridge({ baseUrl: "http://127.0.0.1:4312", token: "contains whitespace" }),
    /runtime_host_token_invalid/,
  );
});

class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.closeCalls = 0;
  }

  close() {
    this.closeCalls += 1;
    this.emit("close");
  }
}

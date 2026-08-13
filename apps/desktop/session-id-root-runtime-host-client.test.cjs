"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");
const {
  createSessionIdRootRuntimeHostPort,
  runtimeConnectionFromEnvironment,
} = require("./session-id-root-runtime-host-client.cjs");

test("production Desktop Host port uses only unified routes and its distinct raw token", async () => {
  const requests = [];
  const port = createSessionIdRootRuntimeHostPort({
    baseUrl: "http://127.0.0.1:4321/",
    token: "desktop-token-0123456789",
    origin: "http://127.0.0.1:5191/",
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      return { ok: true, json: async () => ({ accepted: true }) };
    },
  });

  await port.readWorkspace();
  await port.readTask({ taskId: "task_one" });
  await port.readConfiguration({ kind: "template_studio" });
  await port.command({ type: "task.start", taskId: "task_one" });

  assert.deepEqual(requests.map(({ url }) => url), [
    "http://127.0.0.1:4321/runtime/session-id/workspace/read",
    "http://127.0.0.1:4321/runtime/session-id/read",
    "http://127.0.0.1:4321/runtime/session-id/configuration/read",
    "http://127.0.0.1:4321/runtime/session-id/command",
  ]);
  assert.equal(requests.every(({ init }) => init.headers.authorization === "desktop-token-0123456789"), true);
  assert.equal(requests.some(({ url }) => url.endsWith("/runtime/read")), false);
});

test("production Desktop accepts no external Host only as the signal to supervise one locally", () => {
  assert.equal(runtimeConnectionFromEnvironment({}), undefined);
  assert.throws(() => runtimeConnectionFromEnvironment({
    AGENT_WORKSPACE_RUNTIME_URL: "http://127.0.0.1:4321",
  }), /session_id_external_runtime_incomplete/);
  assert.throws(() => runtimeConnectionFromEnvironment({
    AGENT_WORKSPACE_RUNTIME_URL: "http://127.0.0.1:4321",
    AGENT_WORKSPACE_RUNTIME_TOKEN: "shared-token-0123456789",
    AGENT_WORKSPACE_RUNTIME_DESKTOP_TOKEN: "shared-token-0123456789",
  }), /session_id_renderer_tokens_must_differ/);
  assert.deepEqual(runtimeConnectionFromEnvironment({
    AGENT_WORKSPACE_RUNTIME_URL: "http://127.0.0.1:4321/",
    AGENT_WORKSPACE_RUNTIME_TOKEN: "browser-token-0123456789",
    AGENT_WORKSPACE_RUNTIME_DESKTOP_TOKEN: "desktop-token-0123456789",
    AGENT_WORKSPACE_RUNTIME_ORIGIN: "http://127.0.0.1:5191/",
  }), {
    baseUrl: "http://127.0.0.1:4321",
    token: "desktop-token-0123456789",
    origin: "http://127.0.0.1:5191",
  });
});

test("production Desktop requests one full read after each successful reconnect and stops after unsubscribe", async () => {
  const sockets = [];
  const invalidations = [];
  const port = createSessionIdRootRuntimeHostPort({
    baseUrl: "http://127.0.0.1:4321/",
    token: "desktop-token-0123456789",
    fetchImpl: async () => ({ ok: true, json: async () => ({}) }),
    webSocketFactory: () => {
      const socket = new FakeWebSocket();
      sockets.push(socket);
      return socket;
    },
  });

  const subscribing = port.subscribe({}, (invalidation) => invalidations.push(invalidation));
  assert.equal(sockets.length, 1);
  sockets[0].emit("open");
  const unsubscribe = await subscribing;
  assert.deepEqual(invalidations, []);

  sockets[0].emit("close");
  await waitFor(() => sockets.length === 2);
  sockets[1].emit("open");
  assert.equal(invalidations.length, 1);
  assert.equal(invalidations[0].reason, "subscription_resynced");
  assert.match(invalidations[0].observedAt, /^\d{4}-\d{2}-\d{2}T/);

  sockets[1].emit("open");
  assert.equal(invalidations.length, 1);
  sockets[1].emit("close");
  await unsubscribe();
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(sockets.length, 2);
  assert.equal(invalidations.length, 1);
});

class FakeWebSocket extends EventEmitter {
  close() {}
}

async function waitFor(predicate, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition_not_met_before_timeout");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

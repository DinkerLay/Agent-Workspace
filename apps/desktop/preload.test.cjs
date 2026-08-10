"use strict";

const assert = require("node:assert/strict");
const Module = require("node:module");
const test = require("node:test");

test("sandbox preload exposes only the typed Runtime facade and relays semantic invalidations", async () => {
  const exposed = [];
  const invocations = [];
  let invalidationHandler;
  const ipcRenderer = {
    on(channel, handler) {
      assert.equal(channel, "agent-workspace:runtime:invalidated");
      invalidationHandler = handler;
    },
    async invoke(channel, payload) {
      invocations.push({ channel, payload });
      if (channel === "agent-workspace:runtime:subscribe") return { subscriptionId: payload.clientSubscriptionId };
      return { accepted: true };
    },
  };
  const preloadPath = require.resolve("./preload.cjs");
  const originalLoad = Module._load;
  Module._load = function loadElectronMock(request, parent, isMain) {
    if (request === "electron") {
      return {
        contextBridge: { exposeInMainWorld: (name, value) => exposed.push({ name, value }) },
        ipcRenderer,
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    delete require.cache[preloadPath];
    require(preloadPath);
  } finally {
    Module._load = originalLoad;
    delete require.cache[preloadPath];
  }

  assert.equal(exposed.length, 1);
  assert.equal(exposed[0].name, "agentWorkspace");
  assert.deepEqual(Object.keys(exposed[0].value), ["runtime"]);
  const runtime = exposed[0].value.runtime;
  assert.deepEqual(Object.keys(runtime).sort(), ["command", "read", "subscribe"]);

  const events = [];
  const unsubscribe = await runtime.subscribe({ taskId: "task_a" }, (event) => events.push(event));
  const subscription = invocations.find((item) => item.channel === "agent-workspace:runtime:subscribe");
  invalidationHandler({}, { subscriptionId: subscription.payload.clientSubscriptionId, invalidation: { type: "runtime.invalidated", sequence: 1 } });
  assert.deepEqual(events, [{ type: "runtime.invalidated", sequence: 1 }]);
  await unsubscribe();
  assert.ok(invocations.some((item) => item.channel === "agent-workspace:runtime:unsubscribe"));
});

"use strict";

const assert = require("node:assert/strict");
const Module = require("node:module");
const test = require("node:test");

test("production sandbox preload exposes only the Session-ID root facade", async () => {
  const exposed = [];
  const invocations = [];
  let invalidationHandler;
  const ipcRenderer = {
    on(channel, handler) {
      assert.equal(channel, "agent-workspace:session-id-root:invalidated");
      invalidationHandler = handler;
    },
    async invoke(channel, payload) {
      invocations.push({ channel, payload });
      if (channel === "agent-workspace:session-id-root:subscribe") {
        return { subscriptionId: payload.clientSubscriptionId };
      }
      return { accepted: true };
    },
  };
  const preloadPath = require.resolve("./preload.cjs");
  const originalLoad = Module._load;
  const inheritedOwnerId = process.env.AGENT_WORKSPACE_OWNER_ID;
  delete process.env.AGENT_WORKSPACE_OWNER_ID;
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
    if (inheritedOwnerId === undefined) delete process.env.AGENT_WORKSPACE_OWNER_ID;
    else process.env.AGENT_WORKSPACE_OWNER_ID = inheritedOwnerId;
  }

  assert.equal(exposed.length, 1);
  assert.equal(exposed[0].name, "agentWorkspace");
  assert.deepEqual(Object.keys(exposed[0].value), ["sessionIdRuntime"]);
  assert.equal("runtime" in exposed[0].value, false);
  const runtime = exposed[0].value.sessionIdRuntime;
  assert.deepEqual(Object.keys(runtime).sort(), [
    "authenticatedUserId", "command", "readConfiguration", "readTask", "readWorkspace", "subscribe",
  ]);
  assert.equal(runtime.authenticatedUserId, "user_local");

  await runtime.readWorkspace();
  await runtime.readTask({ taskId: "task_a" });
  await runtime.readConfiguration({ kind: "template_studio" });
  await runtime.command({ type: "task.start", taskId: "task_a" });
  const events = [];
  const unsubscribe = await runtime.subscribe({ taskId: "task_a" }, (event) => events.push(event));
  const subscription = invocations.find((item) => item.channel === "agent-workspace:session-id-root:subscribe");
  invalidationHandler({}, {
    subscriptionId: subscription.payload.clientSubscriptionId,
    invalidation: { reason: "command", taskId: "task_a" },
  });
  assert.deepEqual(events, [{ reason: "command", taskId: "task_a" }]);
  await unsubscribe();
  assert.equal(invocations.some(({ channel }) => channel.startsWith("agent-workspace:runtime:")), false);
});

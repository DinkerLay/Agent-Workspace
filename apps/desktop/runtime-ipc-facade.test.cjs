"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { RUNTIME_IPC_CHANNELS, registerRuntimeIpcFacade } = require("./runtime-ipc-facade.cjs");

function createIpcMain() {
  const handlers = new Map();
  return {
    handlers,
    handle(channel, handler) {
      handlers.set(channel, handler);
    },
    removeHandler(channel) {
      handlers.delete(channel);
    },
  };
}

function createEvent() {
  const sent = [];
  return {
    sent,
    sender: {
      id: 42,
      isDestroyed: () => false,
      send: (channel, payload) => sent.push({ channel, payload }),
    },
  };
}

test("Desktop IPC scopes typed reads and commands without exposing an arbitrary channel", async () => {
  const ipcMain = createIpcMain();
  const calls = [];
  registerRuntimeIpcFacade({
    ipcMain,
    runtimeBridge: {
      read: async (request) => {
        calls.push({ kind: "read", request });
        return { revision: 1 };
      },
      command: async (request) => {
        calls.push({ kind: "command", request });
        return { commandId: request.command.commandId, accepted: true };
      },
    },
  });
  const event = createEvent();

  const read = await ipcMain.handlers.get(RUNTIME_IPC_CHANNELS.read)(event, { taskId: "task_1" });
  const templateRead = await ipcMain.handlers.get(RUNTIME_IPC_CHANNELS.read)(event, { templateId: "template_1" });
  const command = await ipcMain.handlers.get(RUNTIME_IPC_CHANNELS.command)(event, {
    type: "task.start",
    commandId: "cmd_1",
  });

  assert.deepEqual(read, { revision: 1 });
  assert.deepEqual(templateRead, { revision: 1 });
  assert.deepEqual(command, { commandId: "cmd_1", accepted: true });
  assert.deepEqual(calls, [
    { kind: "read", request: { request: { taskId: "task_1" }, scope: { transport: "desktop-ipc", webContentsId: 42 } } },
    { kind: "read", request: { request: { templateId: "template_1" }, scope: { transport: "desktop-ipc", webContentsId: 42 } } },
    {
      kind: "command",
      request: {
        command: { type: "task.start", commandId: "cmd_1" },
        scope: { transport: "desktop-ipc", webContentsId: 42 },
      },
    },
  ]);
  assert.equal(ipcMain.handlers.has("agent-workspace:pty:write"), false);
  assert.equal(ipcMain.handlers.has("agent-workspace:provider:raw"), false);
});

test("Desktop IPC relays semantic invalidations and closes only the caller subscription", async () => {
  const ipcMain = createIpcMain();
  let invalidate;
  let closed = 0;
  registerRuntimeIpcFacade({
    ipcMain,
    runtimeBridge: {
      read: async () => ({}),
      command: async () => ({}),
      subscribe: async ({ onInvalidation }) => {
        invalidate = onInvalidation;
        return async () => {
          closed += 1;
        };
      },
    },
  });
  const event = createEvent();
  const subscribed = await ipcMain.handlers.get(RUNTIME_IPC_CHANNELS.subscribe)(event, { taskId: "task_1" });
  invalidate({ type: "task.changed", taskId: "task_1" });

  assert.equal(event.sent.length, 1);
  assert.equal(event.sent[0].channel, RUNTIME_IPC_CHANNELS.invalidated);
  assert.equal(event.sent[0].payload.subscriptionId, subscribed.subscriptionId);
  await ipcMain.handlers.get(RUNTIME_IPC_CHANNELS.unsubscribe)(event, subscribed);
  assert.equal(closed, 1);
});

test("Desktop IPC rejects functions and cycles before they reach the Runtime Host", async () => {
  const ipcMain = createIpcMain();
  registerRuntimeIpcFacade({
    ipcMain,
    runtimeBridge: { read: async () => ({}), command: async () => ({}) },
  });
  const event = createEvent();
  await assert.rejects(
    () => ipcMain.handlers.get(RUNTIME_IPC_CHANNELS.command)(event, { type: "task.start", callback: () => undefined }),
    /JSON-serializable/,
  );
  const cyclic = {};
  cyclic.self = cyclic;
  await assert.rejects(
    () => ipcMain.handlers.get(RUNTIME_IPC_CHANNELS.read)(event, cyclic),
    /must not be cyclic/,
  );
});

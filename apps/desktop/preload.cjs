"use strict";

const { contextBridge, ipcRenderer } = require("electron");

/**
 * Electron sandbox preloads cannot resolve relative modules. Keep this narrow
 * facade self-contained so sandboxed renderer startup cannot silently fall
 * back to the browser Runtime client.
 */
const RUNTIME_IPC_CHANNELS = Object.freeze({
  read: "agent-workspace:runtime:read",
  command: "agent-workspace:runtime:command",
  subscribe: "agent-workspace:runtime:subscribe",
  unsubscribe: "agent-workspace:runtime:unsubscribe",
  invalidated: "agent-workspace:runtime:invalidated",
});

function createDesktopRuntimeClient(ipc) {
  const invalidationListeners = new Map();
  let attached = false;

  function attachInvalidationListener() {
    if (attached) return;
    attached = true;
    ipc.on(RUNTIME_IPC_CHANNELS.invalidated, (_event, message) => {
      if (!message || typeof message !== "object" || typeof message.subscriptionId !== "string" || !message.invalidation) return;
      invalidationListeners.get(message.subscriptionId)?.(message.invalidation);
    });
  }

  return Object.freeze({
    read(request = {}) {
      return ipc.invoke(RUNTIME_IPC_CHANNELS.read, request);
    },
    command(command) {
      return ipc.invoke(RUNTIME_IPC_CHANNELS.command, command);
    },
    async subscribe(request = {}, listener) {
      if (typeof listener !== "function") throw new TypeError("subscription listener is required");
      attachInvalidationListener();
      const subscriptionId = createClientSubscriptionId();
      invalidationListeners.set(subscriptionId, listener);
      try {
        const response = await ipc.invoke(RUNTIME_IPC_CHANNELS.subscribe, { ...request, clientSubscriptionId: subscriptionId });
        if (response?.subscriptionId !== subscriptionId) throw new Error("runtime_subscription_identity_mismatch");
      } catch (error) {
        invalidationListeners.delete(subscriptionId);
        throw error;
      }
      return async () => {
        invalidationListeners.delete(subscriptionId);
        await ipc.invoke(RUNTIME_IPC_CHANNELS.unsubscribe, { subscriptionId });
      };
    },
  });
}

function createClientSubscriptionId() {
  return `renderer-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

contextBridge.exposeInMainWorld(
  "agentWorkspace",
  Object.freeze({
    runtime: createDesktopRuntimeClient(ipcRenderer),
  }),
);

module.exports = {
  createDesktopRuntimeClient,
};

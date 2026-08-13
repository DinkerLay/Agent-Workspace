"use strict";

const { contextBridge, ipcRenderer } = require("electron");

/* Sandbox preloads cannot resolve local modules; keep the formal facade self-contained. */
const SESSION_ID_ROOT_RUNTIME_IPC_CHANNELS = Object.freeze({
  workspaceRead: "agent-workspace:session-id-root:workspace-read",
  taskRead: "agent-workspace:session-id-root:task-read",
  configurationRead: "agent-workspace:session-id-root:configuration-read",
  command: "agent-workspace:session-id-root:command",
  subscribe: "agent-workspace:session-id-root:subscribe",
  unsubscribe: "agent-workspace:session-id-root:unsubscribe",
  invalidated: "agent-workspace:session-id-root:invalidated",
});

function createSessionIdRootDesktopFacade(ipc, createSubscriptionId = defaultSubscriptionId) {
  if (!ipc || typeof ipc.invoke !== "function" || typeof ipc.on !== "function") {
    throw new TypeError("session_id_root_runtime_ipc_invalid");
  }
  const listeners = new Map();
  let attached = false;
  const attach = () => {
    if (attached) return;
    attached = true;
    ipc.on(SESSION_ID_ROOT_RUNTIME_IPC_CHANNELS.invalidated, (_event, message) => {
      if (!message || typeof message !== "object" || typeof message.subscriptionId !== "string" || !message.invalidation) return;
      listeners.get(message.subscriptionId)?.(message.invalidation);
    });
  };

  return Object.freeze({
    readWorkspace: () => ipc.invoke(SESSION_ID_ROOT_RUNTIME_IPC_CHANNELS.workspaceRead),
    readTask: (request) => ipc.invoke(SESSION_ID_ROOT_RUNTIME_IPC_CHANNELS.taskRead, request),
    readConfiguration: (request) => ipc.invoke(SESSION_ID_ROOT_RUNTIME_IPC_CHANNELS.configurationRead, request),
    command: (command) => ipc.invoke(SESSION_ID_ROOT_RUNTIME_IPC_CHANNELS.command, command),
    async subscribe(scope, listener) {
      if (typeof listener !== "function") throw new TypeError("session_id_root_runtime_listener_required");
      attach();
      const subscriptionId = createSubscriptionId();
      listeners.set(subscriptionId, listener);
      try {
        const response = await ipc.invoke(SESSION_ID_ROOT_RUNTIME_IPC_CHANNELS.subscribe, {
          ...scope,
          clientSubscriptionId: subscriptionId,
        });
        if (response?.subscriptionId !== subscriptionId) throw new Error("session_id_root_subscription_identity_mismatch");
      } catch (error) {
        listeners.delete(subscriptionId);
        throw error;
      }
      return async () => {
        listeners.delete(subscriptionId);
        await ipc.invoke(SESSION_ID_ROOT_RUNTIME_IPC_CHANNELS.unsubscribe, { subscriptionId });
      };
    },
  });
}

function defaultSubscriptionId() {
  return `session-id-root-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

contextBridge.exposeInMainWorld(
  "agentWorkspace",
  Object.freeze({
    sessionIdRuntime: Object.freeze({
      ...createSessionIdRootDesktopFacade(ipcRenderer),
      authenticatedUserId: rendererOwnerId(process.env.AGENT_WORKSPACE_OWNER_ID),
    }),
  }),
);

function rendererOwnerId(value) {
  const normalized = typeof value === "string" && value.trim() ? value.trim() : "user_local";
  return /^user_[A-Za-z0-9_-]{1,251}$/.test(normalized) ? normalized : "user_local";
}

module.exports = { createSessionIdRootDesktopFacade };

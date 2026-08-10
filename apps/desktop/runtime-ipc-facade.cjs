"use strict";

/**
 * Desktop is deliberately a transport shell.  These are the only IPC channels
 * the renderer receives for Runtime access; no channel proxies a Provider,
 * SQLite, filesystem, terminal, or arbitrary Electron IPC call.
 */
const RUNTIME_IPC_CHANNELS = Object.freeze({
  read: "agent-workspace:runtime:read",
  command: "agent-workspace:runtime:command",
  subscribe: "agent-workspace:runtime:subscribe",
  unsubscribe: "agent-workspace:runtime:unsubscribe",
  invalidated: "agent-workspace:runtime:invalidated",
});

function registerRuntimeIpcFacade({ ipcMain, runtimeBridge, scopeForEvent = defaultScopeForEvent }) {
  if (!ipcMain || typeof ipcMain.handle !== "function") {
    throw new TypeError("ipcMain.handle is required");
  }
  if (!runtimeBridge || typeof runtimeBridge.read !== "function" || typeof runtimeBridge.command !== "function") {
    throw new TypeError("runtimeBridge must implement read and command");
  }

  const subscriptions = new Map();

  ipcMain.handle(RUNTIME_IPC_CHANNELS.read, async (event, request = {}) => {
    assertJsonValue(request, "read request");
    return runtimeBridge.read({
      request,
      scope: scopeForEvent(event),
    });
  });

  ipcMain.handle(RUNTIME_IPC_CHANNELS.command, async (event, command) => {
    assertJsonValue(command, "runtime command");
    return runtimeBridge.command({
      command,
      scope: scopeForEvent(event),
    });
  });

  ipcMain.handle(RUNTIME_IPC_CHANNELS.subscribe, async (event, request = {}) => {
    assertJsonValue(request, "subscription request");
    if (typeof runtimeBridge.subscribe !== "function") {
      throw new Error("runtime_subscriptions_unavailable");
    }

    const scope = scopeForEvent(event);
    const { clientSubscriptionId, ...runtimeRequest } = request;
    if (clientSubscriptionId !== undefined && (typeof clientSubscriptionId !== "string" || !clientSubscriptionId)) {
      throw new TypeError("clientSubscriptionId must be a non-empty string");
    }
    const subscriptionId = clientSubscriptionId ?? createSubscriptionId(event);
    const key = subscriptionKey(event, subscriptionId);
    if (subscriptions.has(key)) throw new Error("runtime_subscription_id_in_use");
    const close = await runtimeBridge.subscribe({
      request: runtimeRequest,
      scope,
      onInvalidation: (invalidation) => {
        assertJsonValue(invalidation, "runtime invalidation");
        if (!event.sender.isDestroyed()) {
          event.sender.send(RUNTIME_IPC_CHANNELS.invalidated, { subscriptionId, invalidation });
        }
      },
    });

    subscriptions.set(key, typeof close === "function" ? close : () => undefined);
    event.sender.once?.("destroyed", () => {
      void closeSubscriptionsForSender(subscriptions, event.sender.id);
    });
    return { subscriptionId };
  });

  ipcMain.handle(RUNTIME_IPC_CHANNELS.unsubscribe, async (event, request) => {
    if (!request || typeof request.subscriptionId !== "string") {
      throw new TypeError("subscriptionId is required");
    }
    const key = subscriptionKey(event, request.subscriptionId);
    const close = subscriptions.get(key);
    if (close) {
      subscriptions.delete(key);
      await close();
    }
    return { subscriptionId: request.subscriptionId, closed: Boolean(close) };
  });

  return () => {
    for (const close of subscriptions.values()) {
      void close();
    }
    subscriptions.clear();
    ipcMain.removeHandler?.(RUNTIME_IPC_CHANNELS.read);
    ipcMain.removeHandler?.(RUNTIME_IPC_CHANNELS.command);
    ipcMain.removeHandler?.(RUNTIME_IPC_CHANNELS.subscribe);
    ipcMain.removeHandler?.(RUNTIME_IPC_CHANNELS.unsubscribe);
  };
}

async function closeSubscriptionsForSender(subscriptions, webContentsId) {
  const prefix = `${webContentsId}:`;
  const pending = [];
  for (const [key, close] of subscriptions) {
    if (!key.startsWith(prefix)) continue;
    subscriptions.delete(key);
    pending.push(Promise.resolve(close()));
  }
  await Promise.allSettled(pending);
}

function defaultScopeForEvent(event) {
  return {
    transport: "desktop-ipc",
    webContentsId: event.sender.id,
  };
}

function createSubscriptionId(event) {
  return `desktop-${event.sender.id}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function subscriptionKey(event, subscriptionId) {
  return `${event.sender.id}:${subscriptionId}`;
}

function assertJsonValue(value, label, stack = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (Number.isFinite(value)) return;
    throw new TypeError(`${label} must be JSON-serializable`);
  }
  if (Array.isArray(value)) {
    if (stack.has(value)) throw new TypeError(`${label} must not be cyclic`);
    stack.add(value);
    for (const item of value) assertJsonValue(item, label, stack);
    stack.delete(value);
    return;
  }
  if (typeof value === "object") {
    if (stack.has(value)) throw new TypeError(`${label} must not be cyclic`);
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
      throw new TypeError(`${label} must be plain JSON data`);
    }
    stack.add(value);
    for (const item of Object.values(value)) assertJsonValue(item, label, stack);
    stack.delete(value);
    return;
  }
  throw new TypeError(`${label} must be JSON-serializable`);
}

module.exports = {
  RUNTIME_IPC_CHANNELS,
  assertJsonValue,
  registerRuntimeIpcFacade,
};

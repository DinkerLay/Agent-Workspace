"use strict";

const { URL } = require("node:url");

const SESSION_ID_RUNTIME_SUBPROTOCOL = "agent-workspace-session-id-runtime";

/** Main-process client for the one external unified Runtime Host. */
function createSessionIdRootRuntimeHostPort({
  baseUrl,
  token,
  origin,
  fetchImpl = globalThis.fetch,
  webSocketFactory = defaultWebSocketFactory,
} = {}) {
  const normalizedBaseUrl = normalizeRuntimeBaseUrl(baseUrl);
  const authorization = normalizeRuntimeToken(token);
  const normalizedOrigin = origin === undefined ? undefined : normalizeOrigin(origin);
  if (typeof fetchImpl !== "function") throw new TypeError("session_id_runtime_host_fetch_required");
  if (typeof webSocketFactory !== "function") throw new TypeError("session_id_runtime_host_websocket_factory_required");
  const activeSubscriptions = new Set();
  const post = (route, body) => postJson({
    fetchImpl,
    baseUrl: normalizedBaseUrl,
    authorization,
    origin: normalizedOrigin,
    route,
    body,
  });

  return Object.freeze({
    readWorkspace: () => post("/runtime/session-id/workspace/read", {}),
    readTask: (request) => post("/runtime/session-id/read", request),
    readConfiguration: (request) => post("/runtime/session-id/configuration/read", request),
    command: (command) => post("/runtime/session-id/command", command),
    async subscribe(scope, onInvalidation) {
      if (typeof onInvalidation !== "function") throw new TypeError("session_id_runtime_invalidation_listener_required");
      const subscription = subscribeInvalidations({
        baseUrl: normalizedBaseUrl,
        authorization,
        origin: normalizedOrigin,
        scope,
        onInvalidation,
        webSocketFactory,
      });
      const trackedClose = async () => {
        activeSubscriptions.delete(trackedClose);
        await subscription.close();
      };
      activeSubscriptions.add(trackedClose);
      try {
        await subscription.opened;
        return trackedClose;
      } catch (error) {
        activeSubscriptions.delete(trackedClose);
        throw error;
      }
    },
    async close() {
      const subscriptions = [...activeSubscriptions];
      activeSubscriptions.clear();
      await Promise.allSettled(subscriptions.map((close) => close()));
    },
  });
}

function runtimeConnectionFromEnvironment(environment = process.env) {
  const baseUrl = nonEmptyText(environment.AGENT_WORKSPACE_RUNTIME_URL);
  const token = nonEmptyText(environment.AGENT_WORKSPACE_RUNTIME_DESKTOP_TOKEN);
  if (!baseUrl && !token) return undefined;
  if (!baseUrl || !token) throw new Error("session_id_external_runtime_incomplete");
  const browserToken = nonEmptyText(environment.AGENT_WORKSPACE_RUNTIME_TOKEN);
  if (browserToken && browserToken === token) throw new Error("session_id_renderer_tokens_must_differ");
  return Object.freeze({
    baseUrl: normalizeRuntimeBaseUrl(baseUrl),
    token: normalizeRuntimeToken(token),
    ...(nonEmptyText(environment.AGENT_WORKSPACE_RUNTIME_ORIGIN)
      ? { origin: normalizeOrigin(environment.AGENT_WORKSPACE_RUNTIME_ORIGIN) }
      : {}),
  });
}

async function postJson({ fetchImpl, baseUrl, authorization, origin, route, body }) {
  const headers = { "content-type": "application/json", authorization };
  if (origin) headers.origin = origin;
  const response = await fetchImpl(`${baseUrl}${route}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  if (!response?.ok) throw new Error(await publicErrorCode(response));
  return response.json();
}

function subscribeInvalidations({ baseUrl, authorization, origin, scope, onInvalidation, webSocketFactory }) {
  const target = new URL(`${baseUrl}/runtime/session-id/subscribe`);
  target.protocol = target.protocol === "https:" ? "wss:" : "ws:";
  const normalizedScope = subscriptionScope(scope);
  if (normalizedScope.taskId) target.searchParams.set("taskId", normalizedScope.taskId);

  let active = true;
  let openedOnce = false;
  let currentSocket;
  let reconnectAttempt = 0;
  let reconnectTimer;
  let detachCurrent = () => undefined;
  let resolveOpened;
  let rejectOpened;
  const opened = new Promise((resolve, reject) => {
    resolveOpened = resolve;
    rejectOpened = reject;
  });

  const scheduleReconnect = () => {
    if (!active || reconnectTimer) return;
    const delayMs = Math.min(250 * (2 ** reconnectAttempt), 1_000);
    reconnectAttempt += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      connect();
    }, delayMs);
    reconnectTimer.unref?.();
  };
  const connect = () => {
    if (!active) return;
    let socket;
    try {
      socket = webSocketFactory(
        target.toString(),
        [SESSION_ID_RUNTIME_SUBPROTOCOL, authorization],
        origin ? { headers: { origin } } : undefined,
      );
    } catch {
      scheduleReconnect();
      return;
    }
    currentSocket = socket;
    let disconnected = false;
    let removeOpen = () => undefined;
    let removeError = () => undefined;
    let removeClose = () => undefined;
    let removeMessage = () => undefined;
    const cleanup = () => {
      removeOpen();
      removeError();
      removeClose();
      removeMessage();
    };
    const onOpen = () => {
      if (!active || disconnected || currentSocket !== socket) return;
      reconnectAttempt = 0;
      if (!openedOnce) {
        openedOnce = true;
        resolveOpened();
        return;
      }
      onInvalidation(Object.freeze({
        reason: "subscription_resynced",
        observedAt: new Date().toISOString(),
      }));
    };
    const onDisconnected = () => {
      if (!active || disconnected || currentSocket !== socket) return;
      disconnected = true;
      cleanup();
      currentSocket = undefined;
      socket.close?.();
      scheduleReconnect();
    };
    const onMessage = (message) => {
      const invalidation = parseInvalidation(message);
      if (invalidation) onInvalidation(invalidation);
    };
    try {
      removeOpen = addSocketListener(socket, "open", onOpen, { once: true });
      removeError = addSocketListener(socket, "error", onDisconnected);
      removeClose = addSocketListener(socket, "close", onDisconnected, { once: true });
      removeMessage = addSocketListener(socket, "message", onMessage);
    } catch {
      disconnected = true;
      cleanup();
      currentSocket = undefined;
      socket?.close?.();
      scheduleReconnect();
      return;
    }
    detachCurrent = cleanup;
  };

  connect();
  return Object.freeze({
    opened,
    async close() {
      if (!active) return;
      active = false;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
      const socket = currentSocket;
      currentSocket = undefined;
      detachCurrent();
      socket?.close?.();
      if (!openedOnce) rejectOpened(new Error("session_id_runtime_subscription_cancelled"));
    },
  });
}

function subscriptionScope(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("session_id_runtime_subscription_invalid");
  const keys = Object.keys(value);
  if (keys.length === 0) return Object.freeze({});
  if (keys.length === 1 && keys[0] === "taskId") {
    return Object.freeze({ taskId: requiredText(value.taskId, "session_id_runtime_subscription_invalid") });
  }
  throw new TypeError("session_id_runtime_subscription_invalid");
}

function addSocketListener(socket, event, listener, { once = false } = {}) {
  if (socket && typeof socket.on === "function") {
    const add = once && typeof socket.once === "function" ? socket.once.bind(socket) : socket.on.bind(socket);
    add(event, listener);
    return () => {
      if (typeof socket.off === "function") socket.off(event, listener);
      else socket.removeListener?.(event, listener);
    };
  }
  if (socket && typeof socket.addEventListener === "function") {
    socket.addEventListener(event, listener, once ? { once: true } : undefined);
    return () => socket.removeEventListener?.(event, listener);
  }
  throw new TypeError("session_id_runtime_host_websocket_invalid");
}

function parseInvalidation(value) {
  const data = value && typeof value === "object" && "data" in value ? value.data : value;
  const text = Buffer.isBuffer(data) ? data.toString("utf8") : typeof data === "string" ? data : undefined;
  if (!text) return undefined;
  try {
    const parsed = JSON.parse(text);
    return parsed?.type === "runtime.invalidated" && parsed.invalidation && typeof parsed.invalidation === "object"
      ? parsed.invalidation
      : undefined;
  } catch {
    return undefined;
  }
}

async function publicErrorCode(response) {
  try {
    const value = await response?.json?.();
    const code = value && typeof value === "object" && !Array.isArray(value)
      && value.error && typeof value.error === "object" && !Array.isArray(value.error)
      ? value.error.code
      : undefined;
    return typeof code === "string" && /^[a-z][a-z0-9_]{0,127}$/.test(code)
      ? code
      : "session_id_runtime_request_failed";
  } catch {
    return "session_id_runtime_request_failed";
  }
}

function normalizeRuntimeBaseUrl(value) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError("session_id_runtime_host_url_required");
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new TypeError("session_id_runtime_host_url_protocol_invalid");
  if (url.username || url.password || url.search || url.hash) throw new TypeError("session_id_runtime_host_url_invalid");
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString().replace(/\/$/, "");
}

function normalizeRuntimeToken(value) {
  if (typeof value !== "string" || value.length < 16 || /\s/.test(value)
    || !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(value)) {
    throw new TypeError("session_id_runtime_host_token_invalid");
  }
  return value;
}

function normalizeOrigin(value) {
  if (typeof value !== "string" || !value.trim() || /[\r\n]/.test(value)) throw new TypeError("session_id_runtime_host_origin_invalid");
  const url = new URL(value.trim());
  if ((url.protocol !== "http:" && url.protocol !== "https:")
    || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new TypeError("session_id_runtime_host_origin_invalid");
  }
  return url.origin;
}

function nonEmptyText(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function requiredText(value, code) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(code);
  return value.trim();
}

function defaultWebSocketFactory(url, protocols, options) {
  const WebSocket = require("ws");
  return new WebSocket(url, protocols, options);
}

module.exports = {
  SESSION_ID_RUNTIME_SUBPROTOCOL,
  createSessionIdRootRuntimeHostPort,
  normalizeRuntimeBaseUrl,
  normalizeRuntimeToken,
  runtimeConnectionFromEnvironment,
};

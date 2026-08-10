"use strict";

const { URL } = require("node:url");

const RUNTIME_SUBPROTOCOL = "agent-workspace-runtime";

/**
 * Main-process client for the Runtime Host's deliberately narrow bridge.
 *
 * The bridge credential lives only in Electron's main process.  Preload still
 * exposes just the typed RuntimeClient facade, so neither the renderer nor an
 * arbitrary web page can obtain a Provider credential, database handle, PTY,
 * or generic HTTP proxy.
 */
function createAuthenticatedRuntimeHostBridge({ baseUrl, token, fetchImpl = globalThis.fetch, webSocketFactory, origin } = {}) {
  const normalizedBaseUrl = normalizeRuntimeBaseUrl(baseUrl);
  const bridgeToken = normalizeBridgeToken(token);
  if (typeof fetchImpl !== "function") throw new TypeError("runtime_host_fetch_required");
  const normalizedOrigin = origin === undefined ? undefined : normalizeOrigin(origin);
  const createSocket = webSocketFactory ?? defaultWebSocketFactory;

  return Object.freeze({
    read: ({ request = {} } = {}) =>
      postRuntimeJson({ fetchImpl, baseUrl: normalizedBaseUrl, token: bridgeToken, origin: normalizedOrigin, path: "/runtime/read", body: request }),
    command: ({ command } = {}) =>
      postRuntimeJson({ fetchImpl, baseUrl: normalizedBaseUrl, token: bridgeToken, origin: normalizedOrigin, path: "/runtime/command", body: command }),
    subscribe: ({ request = {}, onInvalidation } = {}) => {
      if (typeof onInvalidation !== "function") throw new TypeError("runtime_invalidation_listener_required");
      return subscribeRuntimeInvalidations({
        baseUrl: normalizedBaseUrl,
        token: bridgeToken,
        origin: normalizedOrigin,
        request,
        onInvalidation,
        webSocketFactory: createSocket,
      });
    },
  });
}

async function postRuntimeJson({ fetchImpl, baseUrl, token, origin, path, body }) {
  const headers = {
    "content-type": "application/json",
    authorization: `Bearer ${token}`,
  };
  if (origin) headers.origin = origin;

  const response = await fetchImpl(`${baseUrl}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  if (!response || !response.ok) {
    throw new Error(await readRuntimeErrorCode(response));
  }
  return response.json();
}

async function readRuntimeErrorCode(response) {
  try {
    const value = await response?.json?.();
    const code = value && typeof value === "object" && !Array.isArray(value)
      && value.error && typeof value.error === "object" && !Array.isArray(value.error)
      ? value.error.code
      : undefined;
    return typeof code === "string" && /^[a-z][a-z0-9_]{0,127}$/.test(code)
      ? code
      : "runtime_command_failed";
  } catch {
    return "runtime_command_failed";
  }
}

function subscribeRuntimeInvalidations({ baseUrl, token, origin, request, onInvalidation, webSocketFactory }) {
  const target = new URL(`${baseUrl}/runtime/subscribe`);
  target.protocol = target.protocol === "https:" ? "wss:" : "ws:";
  appendSubscriptionQuery(target.searchParams, request);

  return new Promise((resolve, reject) => {
    let socket;
    try {
      socket = webSocketFactory(target.toString(), [RUNTIME_SUBPROTOCOL, token], origin ? { headers: { origin } } : undefined);
    } catch (error) {
      reject(error);
      return;
    }

    let opened = false;
    let closed = false;
    let removeOpen = () => undefined;
    let removeError = () => undefined;
    let removeClose = () => undefined;
    let removeMessage = () => undefined;

    const cleanup = () => {
      removeOpen();
      removeError();
      removeClose();
      removeMessage();
      removeOpen = removeError = removeClose = removeMessage = () => undefined;
    };
    const onOpen = () => {
      if (opened) return;
      opened = true;
      removeOpen();
      resolve(async () => {
        if (closed) return;
        closed = true;
        socket.close();
      });
    };
    const onError = (error) => {
      if (opened || closed) return;
      closed = true;
      cleanup();
      reject(error instanceof Error ? error : new Error("runtime_host_subscription_failed"));
    };
    const onClose = () => {
      if (!opened && !closed) {
        closed = true;
        cleanup();
        reject(new Error("runtime_host_subscription_closed_before_open"));
        return;
      }
      cleanup();
    };
    const onMessage = (message) => {
      const invalidation = parseInvalidationMessage(message);
      if (invalidation) onInvalidation(invalidation);
    };

    removeOpen = addSocketListener(socket, "open", onOpen, { once: true });
    removeError = addSocketListener(socket, "error", onError);
    removeClose = addSocketListener(socket, "close", onClose, { once: true });
    removeMessage = addSocketListener(socket, "message", onMessage);
  });
}

function appendSubscriptionQuery(params, request) {
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throw new TypeError("runtime_subscription_request_invalid");
  }
  for (const [key, value] of Object.entries(request)) {
    if (value === undefined) continue;
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
      throw new TypeError("runtime_subscription_request_invalid");
    }
    params.set(key, String(value));
  }
}

function addSocketListener(socket, event, listener, { once = false } = {}) {
  if (socket && typeof socket.on === "function") {
    const add = once && typeof socket.once === "function" ? socket.once.bind(socket) : socket.on.bind(socket);
    add(event, listener);
    return () => {
      if (typeof socket.off === "function") socket.off(event, listener);
      else if (typeof socket.removeListener === "function") socket.removeListener(event, listener);
    };
  }
  if (socket && typeof socket.addEventListener === "function") {
    socket.addEventListener(event, listener, once ? { once: true } : undefined);
    return () => socket.removeEventListener?.(event, listener);
  }
  throw new TypeError("runtime_host_websocket_invalid");
}

function parseInvalidationMessage(value) {
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

function defaultWebSocketFactory(url, protocols, options) {
  const WebSocket = require("ws");
  return new WebSocket(url, protocols, options);
}

function normalizeRuntimeBaseUrl(value) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError("runtime_host_url_required");
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new TypeError("runtime_host_url_protocol_invalid");
  if (url.username || url.password || url.search || url.hash) throw new TypeError("runtime_host_url_invalid");
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString().replace(/\/$/, "");
}

function normalizeBridgeToken(value) {
  if (typeof value !== "string" || !value) throw new TypeError("runtime_host_token_required");
  // It is passed as a WebSocket subprotocol, therefore it must be an HTTP token.
  if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(value)) throw new TypeError("runtime_host_token_invalid");
  return value;
}

function normalizeOrigin(value) {
  if (typeof value !== "string" || !value || /[\r\n]/.test(value)) throw new TypeError("runtime_host_origin_invalid");
  return value;
}

module.exports = {
  RUNTIME_SUBPROTOCOL,
  createAuthenticatedRuntimeHostBridge,
  normalizeBridgeToken,
  normalizeRuntimeBaseUrl,
};

const crypto = require("node:crypto");
const http = require("node:http");

const MAX_BODY_BYTES = 1024 * 1024;

/**
 * Loopback-only transport for an already-composed Runtime. It owns no Task,
 * terminal, or Provider fact: callers supply an explicit command allowlist.
 */
function createRuntimeBridgeHttpServer({
  token,
  handlers,
  host = "127.0.0.1",
  port = 0,
  maxBodyBytes = MAX_BODY_BYTES,
} = {}) {
  const expectedToken = requiredString(token, "runtime_bridge_token");
  if (!handlers || typeof handlers !== "object") throw new Error("runtime_bridge_handlers_required");
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1) throw new Error("runtime_bridge_body_limit_invalid");

  const eventConnections = new Map();
  const disconnectedListeners = new Set();
  let server;
  let heartbeat;

  async function start() {
    if (server) return address();
    server = http.createServer(handleRequest);
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    heartbeat = setInterval(() => {
      for (const connection of eventConnections.values()) connection.response.write(": keepalive\n\n");
    }, 15_000);
    heartbeat.unref?.();
    return address();
  }

  async function close() {
    if (!server) return;
    clearInterval(heartbeat);
    heartbeat = undefined;
    for (const connection of [...eventConnections.values()]) {
      connection.response.end();
      removeEventConnection(connection.id);
    }
    const closing = server;
    server = undefined;
    await new Promise((resolve, reject) => closing.close((error) => error ? reject(error) : resolve()));
  }

  function address() {
    const value = server?.address();
    if (!value || typeof value === "string") throw new Error("runtime_bridge_not_listening");
    return { host: value.address, port: value.port, url: `http://${value.address}:${value.port}` };
  }

  function publish(channel, payload, { clientId } = {}) {
    const message = JSON.stringify({ channel: String(channel), payload });
    for (const connection of eventConnections.values()) {
      if (clientId && connection.clientId !== clientId) continue;
      connection.response.write(`event: runtime\ndata: ${message}\n\n`);
    }
  }

  function onClientDisconnected(listener) {
    if (typeof listener !== "function") throw new Error("runtime_bridge_disconnect_listener_invalid");
    disconnectedListeners.add(listener);
    return () => disconnectedListeners.delete(listener);
  }

  async function handleRequest(request, response) {
    applyBaseHeaders(response);
    if (!isAuthorized(request, expectedToken)) return sendJson(response, 401, { error: "runtime_bridge_unauthorized" });

    const url = new URL(request.url ?? "/", "http://runtime-bridge.local");
    if (request.method === "GET" && url.pathname === "/v1/status") {
      return invoke(response, handlers.getRuntimeStatus, undefined, {});
    }
    if (request.method === "GET" && url.pathname === "/v1/events") {
      return openEventStream(request, response, url.searchParams.get("clientId"));
    }
    if (request.method === "POST" && url.pathname === "/v1/call") {
      let requestBody;
      try {
        requestBody = await readJsonBody(request, maxBodyBytes);
      } catch (error) {
        return sendJson(response, error?.code === "body_too_large" ? 413 : 400, { error: error?.code ?? "runtime_bridge_request_invalid" });
      }
      const method = typeof requestBody?.method === "string" ? requestBody.method : "";
      const handler = Object.prototype.hasOwnProperty.call(handlers, method) ? handlers[method] : undefined;
      if (typeof handler !== "function") return sendJson(response, 404, { error: "runtime_bridge_method_not_found" });
      const clientId = validClientId(request.headers["x-agent-workspace-client"]);
      if (!clientId) return sendJson(response, 400, { error: "runtime_bridge_client_required" });
      return invoke(response, handler, requestBody.input, { clientId });
    }
    return sendJson(response, 404, { error: "runtime_bridge_route_not_found" });
  }

  function openEventStream(request, response, rawClientId) {
    const clientId = validClientId(rawClientId);
    if (!clientId) return sendJson(response, 400, { error: "runtime_bridge_client_required" });
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    });
    response.write("retry: 1000\n\n");
    const connection = { id: crypto.randomUUID(), clientId, response };
    eventConnections.set(connection.id, connection);
    const remove = () => removeEventConnection(connection.id);
    request.once("close", remove);
    response.once("close", remove);
  }

  function removeEventConnection(connectionId) {
    const connection = eventConnections.get(connectionId);
    if (!connection) return;
    eventConnections.delete(connectionId);
    if ([...eventConnections.values()].some((candidate) => candidate.clientId === connection.clientId)) return;
    for (const listener of disconnectedListeners) listener(connection.clientId);
  }

  async function invoke(response, handler, input, context) {
    if (typeof handler !== "function") return sendJson(response, 404, { error: "runtime_bridge_method_not_found" });
    try {
      return sendJson(response, 200, { result: await handler(input, context) });
    } catch (error) {
      return sendJson(response, 500, { error: error instanceof Error ? error.message : "runtime_bridge_call_failed" });
    }
  }

  return { start, close, address, publish, onClientDisconnected };
}

function isAuthorized(request, expectedToken) {
  const received = String(request.headers.authorization ?? "");
  const expected = `Bearer ${expectedToken}`;
  const left = Buffer.from(received);
  const right = Buffer.from(expected);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function applyBaseHeaders(response) {
  response.setHeader("cache-control", "no-store");
  response.setHeader("x-content-type-options", "nosniff");
}

function sendJson(response, status, body) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

async function readJsonBody(request, maxBodyBytes) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBodyBytes) {
      const error = new Error("body_too_large");
      error.code = "body_too_large";
      throw error;
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new Error("runtime_bridge_request_invalid");
    error.code = "runtime_bridge_request_invalid";
    throw error;
  }
}

function validClientId(value) {
  const clientId = Array.isArray(value) ? value[0] : String(value ?? "");
  return /^[A-Za-z0-9_-]{16,128}$/.test(clientId) ? clientId : undefined;
}

function requiredString(value, errorCode) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(errorCode);
  return text;
}

module.exports = { createRuntimeBridgeHttpServer };

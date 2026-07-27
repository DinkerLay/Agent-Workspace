const crypto = require("node:crypto");
const net = require("node:net");
const { PROTOCOL_VERSION } = require("./orca-terminal-daemon.cjs");

/**
 * Orca-style renderer/client boundary for the local terminal daemon.
 *
 * Control calls and output streams intentionally use separate connections.
 * A caller must ACK only after its terminal emulator has consumed a snapshot
 * or delta; receiving a socket message is not an ACK.
 */

async function connectTerminalControl(endpoint) {
  return openConnection({ endpoint, role: "control" });
}

async function connectTerminalStream(endpoint, { onEvent = () => undefined } = {}) {
  const connection = await openConnection({ endpoint, role: "stream", onEvent });
  return {
    ...connection,
    subscribe(input) {
      return connection.request("terminal.subscribe", input);
    },
    acknowledge(input) {
      return connection.request("terminal.ack", input);
    },
    resync(input) {
      return connection.request("terminal.resync", input);
    },
    unsubscribe(sessionId) {
      return connection.request("terminal.unsubscribe", { sessionId });
    },
  };
}

async function openConnection({ endpoint, role, onEvent = () => undefined }) {
  const host = requiredString(endpoint?.host, "host");
  const port = positiveInteger(endpoint?.port, "port");
  const token = requiredString(endpoint?.token, "token");
  const protocolVersion = Number(endpoint?.protocolVersion ?? PROTOCOL_VERSION);
  const socket = net.createConnection({ host, port });
  socket.setEncoding("utf8");
  let buffer = "";
  let connectionId;
  let closed = false;
  let nextRequest = 1;
  const pending = new Map();

  const ready = new Promise((resolve, reject) => {
    const rejectReady = (error) => reject(error instanceof Error ? error : new Error(String(error)));
    socket.once("error", rejectReady);
    socket.once("connect", () => {
      socket.write(`${JSON.stringify({ type: "hello", role, token, protocolVersion })}\n`);
    });
    socket.on("data", (chunk) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch (error) {
          rejectReady(new Error("terminal_daemon_response_json_invalid"));
          continue;
        }
        if (message.type === "hello-ok") {
          connectionId = message.connectionId;
          socket.off("error", rejectReady);
          resolve();
          continue;
        }
        if (message.type === "response") {
          const deferred = pending.get(String(message.id));
          if (!deferred) continue;
          pending.delete(String(message.id));
          if (message.error) deferred.reject(new Error(message.error));
          else deferred.resolve(message.result);
          continue;
        }
        onEvent(message);
      }
    });
  });

  socket.on("close", () => {
    closed = true;
    for (const deferred of pending.values()) deferred.reject(new Error("terminal_daemon_connection_closed"));
    pending.clear();
  });
  socket.on("error", (error) => {
    if (!closed) {
      for (const deferred of pending.values()) deferred.reject(error);
      pending.clear();
    }
  });

  await ready;

  function request(method, params = {}) {
    if (closed || socket.destroyed) return Promise.reject(new Error("terminal_daemon_connection_closed"));
    const id = `${connectionId}:${nextRequest++}`;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      socket.write(`${JSON.stringify({ type: "request", id, method, params })}\n`);
    });
  }

  function close() {
    if (closed) return;
    closed = true;
    socket.end();
    socket.destroy();
  }

  return { connectionId, request, close };
}

function requiredString(value, field) {
  const normalized = String(value ?? "").trim();
  if (!normalized) throw new Error(`terminal_daemon_${field}_required`);
  return normalized;
}

function positiveInteger(value, field) {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 1) throw new Error(`terminal_daemon_${field}_invalid`);
  return normalized;
}

module.exports = { connectTerminalControl, connectTerminalStream };

const crypto = require("node:crypto");
const net = require("node:net");
const { createTerminalHost } = require("./terminal-host.cjs");

/**
 * Orca-style local terminal daemon boundary.
 *
 * Architecture derived from stablyai/orca at 8f5a45401 (MIT License): its
 * TerminalHost owns the PTY and headless screen; control RPC is separated
 * from an ordered terminal stream.  This is an adaptation for the existing
 * CommonJS/Electron application, not a copy of Orca's source.
 *
 * This module intentionally has no knowledge of Tasks, Conductor, OpenCode
 * session semantics, dispatch receipts, or retry policy.  Every public
 * operation is a terminal transport/process fact.
 */

const PROTOCOL_VERSION = 1;
const DEFAULT_HOST = "127.0.0.1";
const MAX_LINE_BYTES = 2 * 1024 * 1024;

function createOrcaTerminalDaemon({
  terminalHost,
  pty,
  spawn,
  sessionStore,
  host = DEFAULT_HOST,
  port = 0,
  token = crypto.randomBytes(24).toString("hex"),
  now = () => Date.now(),
  terminalHostOptions = {},
} = {}) {
  const managedHost =
    terminalHost ??
    createTerminalHost({
      pty,
      spawn,
      sessionStore,
      now,
      ...terminalHostOptions,
    });
  const claims = new Map();
  const streams = new Map();
  let server;
  let stopped = false;

  const unsubscribeHost = managedHost.onEvent((event) => {
    const claim = claims.get(event.id);
    // A stale PTY must not be allowed to publish after a replacement owns the
    // same terminal identity. The existing host has the same inner fence; the
    // daemon repeats it at the transport boundary.
    if (!claim || claim.generation !== event.generation) return;
    if (event.type === "data") {
      for (const stream of streams.values()) flushStream(stream, event.id);
      return;
    }
    if (event.type === "exit") {
      // Session serialisation guarantees all preceding data callbacks have
      // reached this point. Flush first so a client never observes exit before
      // the final bytes for this terminal.
      for (const stream of streams.values()) {
        flushStream(stream, event.id);
        const subscription = stream.subscriptions.get(event.id);
        if (subscription) {
          stream.send({
            type: "terminal.exit",
            sessionId: event.id,
            generation: event.generation,
            incarnationId: event.incarnationId,
            code: event.exitCode ?? null,
            signal: event.signal ?? null,
            cursor: event.cursor,
          });
        }
      }
      claim.state = "exited";
      return;
    }
    for (const stream of streams.values()) {
      if (stream.subscriptions.has(event.id)) {
        stream.send({ type: "terminal.lifecycle", sessionId: event.id, event });
      }
    }
  });

  function invokeControl(method, params = {}) {
    if (stopped) throw new Error("terminal_daemon_stopped");
    switch (method) {
      case "terminal.createOrAttach":
        return createOrAttach(params);
      case "terminal.write":
        return write(params);
      case "terminal.resize":
        return resize(params);
      case "terminal.getSnapshot":
        return getSnapshot(params);
      case "terminal.list":
        return list();
      case "terminal.kill":
        return kill(params);
      case "terminal.pauseProducer":
        return pauseProducer(params);
      case "terminal.resumeProducer":
        return resumeProducer(params);
      case "terminal.detach":
        return detachTerminal(params);
      default:
        throw new Error("terminal_control_method_unknown");
    }
  }

  async function listen() {
    if (server) return endpoint();
    server = net.createServer((socket) => attachSocket(socket));
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen({ host, port }, () => {
        server.off("error", reject);
        resolve();
      });
    });
    return endpoint();
  }

  async function stop() {
    if (stopped) return;
    stopped = true;
    for (const stream of streams.values()) stream.close();
    streams.clear();
    unsubscribeHost();
    managedHost.close();
    if (server) {
      await new Promise((resolve) => server.close(() => resolve()));
      server = undefined;
    }
  }

  function endpoint() {
    if (!server) throw new Error("terminal_daemon_not_listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("terminal_daemon_address_invalid");
    return {
      host: address.address,
      port: address.port,
      token,
      protocolVersion: PROTOCOL_VERSION,
    };
  }

  function createOrAttach(input) {
    const session = normalizedSessionInput(input);
    const claimInput = normalizeClaim(input?.claim);
    const existingClaim = claims.get(session.id);
    const existingSession = managedHost.get(session.id);
    const live = isLive(existingSession);

    // A daemon can only attach to a live terminal when it owns the matching
    // durable claim. Silently adopting a terminal created outside this daemon
    // would make its generation and ownership assertions meaningless.
    if (!existingClaim && live) {
      throw new Error("terminal_session_live_owner_unknown");
    }

    if (existingClaim && live) {
      if (
        existingClaim.ownerId !== claimInput.ownerId ||
        existingClaim.generation !== claimInput.generation
      ) {
        throw new Error("terminal_session_claim_unavailable");
      }
      const adopted = managedHost.createOrAttach({
        ...session,
        incarnationId: existingClaim.incarnationId,
        generation: existingClaim.generation,
      });
      return {
        disposition: "adopted",
        session: adopted.session,
        claim: publicClaim(existingClaim),
      };
    }

    const incarnationId =
      normalizedOptionalId(input?.incarnationId) ??
      `inc-${claimInput.generation}-${crypto.randomBytes(6).toString("hex")}`;
    const created = managedHost.createOrAttach({
      ...session,
      incarnationId,
      generation: claimInput.generation,
    });
    const record = {
      sessionId: session.id,
      ownerId: claimInput.ownerId,
      generation: claimInput.generation,
      incarnationId: created.session.incarnationId,
      state: "live",
      createdAt: new Date(now()).toISOString(),
    };
    claims.set(session.id, record);
    return {
      disposition: created.disposition === "adopted" ? "adopted" : "created",
      session: created.session,
      claim: publicClaim(record),
    };
  }

  function write(input) {
    const claim = requireCurrentClaim(input);
    const text = String(input?.data ?? "");
    if (!text) throw new Error("terminal_write_data_required");
    const result = managedHost.write(claim.sessionId, text, {
      expectedIncarnationId: claim.incarnationId,
    });
    if (!result) throw new Error("terminal_session_not_live");
    return { accepted: true, session: result, claim: publicClaim(claim) };
  }

  function resize(input) {
    const claim = requireCurrentClaim(input);
    const result = managedHost.resize(
      claim.sessionId,
      { cols: input?.cols, rows: input?.rows },
      { expectedIncarnationId: claim.incarnationId },
    );
    if (!result) throw new Error("terminal_session_not_live");
    return { accepted: true, session: result };
  }

  async function getSnapshot(input) {
    const claim = requireCurrentClaim(input);
    const snapshot = await managedHost.getSnapshot(claim.sessionId);
    if (!snapshot) throw new Error("terminal_session_not_live");
    return { sessionId: claim.sessionId, claim: publicClaim(claim), snapshot };
  }

  function list() {
    return managedHost.list().map((session) => ({
      session,
      claim: claims.has(session.id) ? publicClaim(claims.get(session.id)) : undefined,
    }));
  }

  function kill(input) {
    const claim = requireCurrentClaim(input);
    const result = managedHost.stop(claim.sessionId, {
      expectedIncarnationId: claim.incarnationId,
    });
    if (!result) throw new Error("terminal_session_not_live");
    claim.state = "stopping";
    return { accepted: true, session: result };
  }

  function pauseProducer(input) {
    const claim = requireCurrentClaim(input);
    const paused = managedHost.pauseProducer?.(claim.sessionId) ?? false;
    return { accepted: true, paused: Boolean(paused) };
  }

  function resumeProducer(input) {
    const claim = requireCurrentClaim(input);
    const resumed = managedHost.resumeProducer?.(claim.sessionId) ?? false;
    return { accepted: true, resumed: Boolean(resumed) };
  }

  function detachTerminal(input) {
    const claim = requireCurrentClaim(input);
    for (const stream of streams.values()) detachSubscription(stream, claim.sessionId);
    return { accepted: true };
  }

  async function subscribeStream({ connectionId, send, sessionId, attachmentId, generation }) {
    const stream = ensureStream({ connectionId, send });
    const claim = claims.get(requiredId(sessionId, "sessionId"));
    if (!claim || claim.generation !== requiredId(generation, "generation")) {
      throw new Error("terminal_stream_generation_stale");
    }
    const clientId = requiredId(attachmentId, "attachmentId");
    detachSubscription(stream, claim.sessionId);
    const attached = await managedHost.attachClient({
      id: claim.sessionId,
      clientId,
      generation: claim.generation,
    });
    if (!attached) throw new Error("terminal_session_not_live");
    const subscription = {
      sessionId: claim.sessionId,
      attachmentId: clientId,
      generation: claim.generation,
    };
    stream.subscriptions.set(claim.sessionId, subscription);
    stream.send({
      type: "terminal.snapshot",
      sessionId: claim.sessionId,
      generation: claim.generation,
      incarnationId: claim.incarnationId,
      snapshot: attached.snapshot,
      attachment: attached.attachment,
    });
    return { accepted: true, sessionId: claim.sessionId, attachment: attached.attachment };
  }

  function acknowledgeStream({ connectionId, sessionId, attachmentId, generation, cursor }) {
    const stream = streams.get(requiredId(connectionId, "connectionId"));
    if (!stream) throw new Error("terminal_stream_connection_not_found");
    const subscription = stream.subscriptions.get(requiredId(sessionId, "sessionId"));
    if (!subscription || subscription.attachmentId !== requiredId(attachmentId, "attachmentId")) {
      throw new Error("terminal_stream_subscription_not_found");
    }
    if (subscription.generation !== requiredId(generation, "generation")) {
      throw new Error("terminal_stream_generation_stale");
    }
    const result = managedHost.acknowledgeOutput({
      id: subscription.sessionId,
      clientId: subscription.attachmentId,
      generation: subscription.generation,
      cursor,
    });
    if (!result.accepted) throw new Error(result.reason ?? "terminal_stream_ack_rejected");
    if (result.restoreRequired) {
      stream.send({
        type: "terminal.restore-required",
        sessionId: subscription.sessionId,
        generation: subscription.generation,
      });
    } else {
      flushStream(stream, subscription.sessionId);
    }
    return { accepted: true, restoreRequired: Boolean(result.restoreRequired), attachment: result.attachment };
  }

  async function resyncStream(input) {
    return subscribeStream(input);
  }

  function closeStream(connectionId) {
    const stream = streams.get(String(connectionId ?? ""));
    if (!stream) return false;
    for (const sessionId of stream.subscriptions.keys()) detachSubscription(stream, sessionId);
    streams.delete(stream.connectionId);
    return true;
  }

  function ensureStream({ connectionId, send }) {
    const id = requiredId(connectionId, "connectionId");
    const existing = streams.get(id);
    if (existing) return existing;
    if (typeof send !== "function") throw new Error("terminal_stream_sender_required");
    const stream = { connectionId: id, send, subscriptions: new Map(), close: () => undefined };
    streams.set(id, stream);
    return stream;
  }

  function detachSubscription(stream, sessionId) {
    const subscription = stream.subscriptions.get(sessionId);
    if (!subscription) return false;
    managedHost.detachClient({
      id: subscription.sessionId,
      clientId: subscription.attachmentId,
      generation: subscription.generation,
    });
    stream.subscriptions.delete(sessionId);
    return true;
  }

  function flushStream(stream, sessionId) {
    const subscription = stream.subscriptions.get(sessionId);
    if (!subscription) return;
    const delivery = managedHost.takePendingOutput({
      id: subscription.sessionId,
      clientId: subscription.attachmentId,
      generation: subscription.generation,
    });
    if (!delivery?.accepted) return;
    if (delivery.restoreRequired) {
      stream.send({
        type: "terminal.restore-required",
        sessionId: subscription.sessionId,
        generation: subscription.generation,
      });
      return;
    }
    for (const delta of delivery.deltas ?? []) {
      stream.send({
        type: "terminal.delta",
        sessionId: subscription.sessionId,
        generation: subscription.generation,
        ...delta,
      });
    }
  }

  function requireCurrentClaim(input) {
    const sessionId = requiredId(input?.sessionId, "sessionId");
    const claim = claims.get(sessionId);
    if (!claim) throw new Error("terminal_session_claim_not_found");
    const generation = requiredId(input?.generation, "generation");
    if (claim.generation !== generation || !isLive(managedHost.get(sessionId))) {
      throw new Error("terminal_session_generation_stale");
    }
    return claim;
  }

  function attachSocket(socket) {
    const connectionId = `socket-${crypto.randomBytes(9).toString("hex")}`;
    let buffered = "";
    let role;
    let closed = false;
    const send = (message) => {
      if (!closed && !socket.destroyed) socket.write(`${JSON.stringify(message)}\n`);
    };
    const close = () => {
      if (closed) return;
      closed = true;
      closeStream(connectionId);
    };
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffered += chunk;
      if (Buffer.byteLength(buffered, "utf8") > MAX_LINE_BYTES) {
        socket.destroy(new Error("terminal_daemon_message_too_large"));
        return;
      }
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          send({ type: "error", error: "terminal_daemon_json_invalid" });
          continue;
        }
        void handleSocketMessage({ message, send, connectionId, socket, getRole: () => role, setRole: (value) => (role = value) });
      }
    });
    socket.on("close", close);
    socket.on("error", close);
  }

  async function handleSocketMessage({ message, send, connectionId, socket, getRole, setRole }) {
    const respond = (id, result) => send({ type: "response", id, result });
    const fail = (id, error) =>
      send({ type: "response", id, error: error instanceof Error ? error.message : String(error) });
    try {
      if (message?.type === "hello") {
        if (getRole()) throw new Error("terminal_daemon_hello_already_completed");
        if (message.token !== token || Number(message.protocolVersion) !== PROTOCOL_VERSION) {
          socket.destroy(new Error("terminal_daemon_auth_failed"));
          return;
        }
        if (message.role !== "control" && message.role !== "stream") throw new Error("terminal_daemon_role_invalid");
        setRole(message.role);
        if (message.role === "stream") {
          ensureStream({ connectionId, send });
        }
        send({ type: "hello-ok", connectionId, protocolVersion: PROTOCOL_VERSION });
        return;
      }
      const role = getRole();
      if (!role) throw new Error("terminal_daemon_hello_required");
      if (role === "control" && message?.type === "request") {
        respond(message.id, await invokeControl(message.method, message.params));
        return;
      }
      if (role === "stream" && message?.type === "request") {
        const params = { ...(message.params ?? {}), connectionId, send };
        if (message.method === "terminal.subscribe") {
          respond(message.id, await subscribeStream(params));
          return;
        }
        if (message.method === "terminal.ack") {
          respond(message.id, acknowledgeStream(params));
          return;
        }
        if (message.method === "terminal.resync") {
          respond(message.id, await resyncStream(params));
          return;
        }
        if (message.method === "terminal.unsubscribe") {
          const stream = streams.get(connectionId);
          respond(message.id, { accepted: Boolean(stream && detachSubscription(stream, requiredId(params.sessionId, "sessionId"))) });
          return;
        }
        throw new Error("terminal_stream_method_unknown");
      }
      throw new Error("terminal_daemon_message_invalid");
    } catch (error) {
      fail(message?.id, error);
    }
  }

  return {
    listen,
    stop,
    endpoint,
    invokeControl,
    subscribeStream,
    acknowledgeStream,
    resyncStream,
    closeStream,
    terminalHost: managedHost,
  };
}

function normalizedSessionInput(input = {}) {
  const session = input.session && typeof input.session === "object" ? input.session : input;
  return {
    id: requiredId(session.id ?? session.sessionId, "sessionId"),
    taskId: requiredId(session.taskId, "taskId"),
    command: requiredId(session.command, "command"),
    args: Array.isArray(session.args) ? session.args.map(String) : [],
    cwd: requiredId(session.cwd, "cwd"),
    model: session.model ? String(session.model) : undefined,
    provider: session.provider ? String(session.provider) : undefined,
    cols: positiveInteger(session.cols, "cols", 100),
    rows: positiveInteger(session.rows, "rows", 30),
    stdin: session.stdin,
    env: session.env,
    runtimeFiles: session.runtimeFiles,
    requirePty: session.requirePty !== false,
  };
}

function normalizeClaim(input = {}) {
  return {
    ownerId: requiredId(input.ownerId, "claim.ownerId"),
    generation: requiredId(input.generation, "claim.generation"),
  };
}

function publicClaim(claim) {
  return {
    sessionId: claim.sessionId,
    ownerId: claim.ownerId,
    generation: claim.generation,
    incarnationId: claim.incarnationId,
    state: claim.state,
    createdAt: claim.createdAt,
  };
}

function requiredId(value, field) {
  const normalized = String(value ?? "").trim();
  if (!normalized) throw new Error(`terminal_${field}_required`);
  return normalized;
}

function normalizedOptionalId(value) {
  const normalized = String(value ?? "").trim();
  return normalized || undefined;
}

function positiveInteger(value, field, fallback) {
  if (value === undefined || value === null) return fallback;
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 1) throw new Error(`terminal_${field}_invalid`);
  return normalized;
}

function isLive(session) {
  return session?.status === "running" || session?.status === "stopping";
}

module.exports = { DEFAULT_HOST, PROTOCOL_VERSION, createOrcaTerminalDaemon };

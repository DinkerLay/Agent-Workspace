const crypto = require("node:crypto");
const { connectTerminalControl, connectTerminalStream } = require("./orca-terminal-daemon-client.cjs");

/**
 * Electron Main's daemon client/coordinator.
 *
 * It is deliberately not a PTY owner. The local daemon owns process handles
 * and the headless emulator; this manager retains only small lifecycle facts
 * needed by existing task/session projections and bridges renderer IPC to the
 * daemon's control and stream connections.
 */
function createOrcaTerminalDaemonManager({
  endpointProvider,
  sessionStore,
  connectControl = connectTerminalControl,
  connectStream = connectTerminalStream,
  now = () => Date.now(),
} = {}) {
  if (typeof endpointProvider !== "function") throw new Error("terminal_daemon_endpoint_provider_required");

  const sessions = new Map();
  const events = new Set();
  const clientEvents = new Set();
  const observers = new Map();
  const attachments = new Map();
  const attachmentQueues = new Map();
  let controlPromise;
  let closed = false;

  async function start(input) {
    return (await createOrAttach(input)).session;
  }

  async function createOrAttach(input) {
    const sessionId = requiredId(input?.id, "id");
    const generation = requiredId(input?.generation, "generation");
    const created = await controlRequest("terminal.createOrAttach", {
      session: {
        id: sessionId,
        taskId: requiredId(input?.taskId, "taskId"),
        command: requiredId(input?.command, "command"),
        args: Array.isArray(input?.args) ? input.args.map(String) : [],
        cwd: requiredId(input?.cwd, "cwd"),
        model: input?.model,
        provider: input?.provider,
        cols: input?.cols,
        rows: input?.rows,
        stdin: input?.stdin,
        env: input?.env,
        runtimeFiles: input?.runtimeFiles,
        requirePty: input?.requirePty !== false,
      },
      claim: {
        ownerId: input?.ownerId ? String(input.ownerId) : sessionId,
        generation,
      },
      incarnationId: input?.incarnationId,
    });
    // A `created` disposition is a new physical PTY generation, even when it
    // reuses the same logical workspace Session ID. Do not inherit transport
    // facts from the previous generation: in particular an old
    // alternate-buffer flag would falsely tell Session Authority that a newly
    // spawned OpenCode TUI is already ready to receive input.
    const session = rememberSession(
      created.disposition === "created"
        ? {
            ...created.session,
            status: "running",
            cursor: 0,
            bufferMode: "normal",
            lastOutputAt: undefined,
            exitCode: undefined,
            signal: undefined,
            stoppedAtMs: undefined,
          }
        : created.session,
      { replace: created.disposition === "created" },
    );
    if (created.disposition === "created") {
      sessionStore?.startSession?.({
        taskId: session.taskId,
        sessionId: session.id,
        command: session.command,
        cwd: session.cwd,
        provider: session.provider,
        model: session.model,
        incarnationId: session.incarnationId,
        generation: session.generation,
      });
    }
    await ensureObserver(session);
    // The daemon is authoritative about whether the Host created a PTY or
    // adopted an already-owned one.  Comparing generation strings locally
    // misclassified a real adoption as `created`, which weakens the claim
    // boundary copied from Orca.
    return { disposition: created.disposition, session };
  }

  function get(id) {
    return cloneSession(sessions.get(String(id ?? "")));
  }

  function list() {
    return Array.from(sessions.values(), cloneSession);
  }

  function read(id, cursor = 0) {
    const session = get(id);
    if (!session) return undefined;
    const requestedCursor = normalizeCursor(cursor);
    return { ...session, requiresSnapshot: requestedCursor !== session.cursor, transcript: [] };
  }

  async function getSnapshot(id) {
    const session = get(id);
    if (!session) return undefined;
    const result = await controlRequest("terminal.getSnapshot", {
      sessionId: session.id,
      generation: session.generation,
    });
    return result.snapshot;
  }

  async function write(id, text, { expectedIncarnationId } = {}) {
    const session = requireLiveSession(id, expectedIncarnationId);
    const result = await controlRequest("terminal.write", {
      sessionId: session.id,
      generation: session.generation,
      data: String(text ?? ""),
    });
    return rememberSession(result.session);
  }

  async function resize(id, size, { expectedIncarnationId } = {}) {
    const session = requireLiveSession(id, expectedIncarnationId);
    const result = await controlRequest("terminal.resize", {
      sessionId: session.id,
      generation: session.generation,
      cols: positiveInteger(size?.cols, "cols"),
      rows: positiveInteger(size?.rows, "rows"),
    });
    return rememberSession(result.session);
  }

  async function stop(id, { expectedIncarnationId } = {}) {
    const session = requireLiveSession(id, expectedIncarnationId);
    const result = await controlRequest("terminal.kill", {
      sessionId: session.id,
      generation: session.generation,
    });
    return rememberSession(result.session);
  }

  async function pauseProducer(id) {
    const session = requireLiveSession(id);
    return controlRequest("terminal.pauseProducer", { sessionId: session.id, generation: session.generation });
  }

  async function resumeProducer(id) {
    const session = requireLiveSession(id);
    return controlRequest("terminal.resumeProducer", { sessionId: session.id, generation: session.generation });
  }

  async function attachClient({ id, clientId, generation }) {
    const attachmentId = requiredId(clientId, "clientId");
    const attachment = await serializeAttachment(attachmentId, () => openAttachment({ id, clientId: attachmentId, generation }));
    try {
      const snapshot = await attachment.snapshotReady;
      if (attachment.closed) throw new Error("terminal_attachment_closed");
      return {
        snapshot,
        attachment: {
          clientId: attachment.clientId,
          generation: attachment.clientGeneration,
          ready: false,
          restoreRequired: false,
          snapshotPending: true,
          ...(attachment.subscribed?.attachment ?? {}),
        },
        session: get(attachment.sessionId),
      };
    } catch (error) {
      await closeAttachment(attachment);
      throw error;
    }
  }

  async function openAttachment({ id, clientId, generation }) {
    const session = requireLiveSession(id);
    const attachmentId = requiredId(clientId, "clientId");
    const clientGeneration = requiredId(generation, "attachmentGeneration");
    // A renderer client may replace an attachment while a prior snapshot is
    // still in flight, or move to another Session. Close every old stream for
    // that client before opening the replacement so a delayed close cannot
    // remove the new attachment or forward stale terminal bytes.
    for (const prior of [...attachments.values()]) {
      if (prior.clientId === attachmentId) await closeAttachment(prior);
    }
    let resolveSnapshot;
    let rejectSnapshot;
    const snapshotReady = new Promise((resolve, reject) => {
      resolveSnapshot = resolve;
      rejectSnapshot = reject;
    });
    const attachment = {
      sessionId: session.id,
      clientId: attachmentId,
      clientGeneration,
      physicalGeneration: session.generation,
      stream: undefined,
      closed: false,
      receivedSnapshot: false,
      snapshotReady,
      resolveSnapshot,
      rejectSnapshot,
    };
    const stream = await connectStream(await endpointProvider(), {
      onEvent: (event) => handleAttachmentEvent(attachment, event),
    });
    attachment.stream = stream;
    attachments.set(attachmentKey(session.id, attachmentId), attachment);
    try {
      attachment.subscribed = await stream.subscribe({
        sessionId: session.id,
        attachmentId,
        generation: session.generation,
      });
      return attachment;
    } catch (error) {
      await closeAttachment(attachment);
      throw error;
    }
  }

  async function acknowledgeOutput({ id, clientId, generation, cursor }) {
    const attachment = attachments.get(attachmentKey(String(id ?? ""), String(clientId ?? "")));
    if (!attachment || attachment.clientGeneration !== String(generation ?? "")) {
      return { accepted: false, reason: "terminal_attachment_stale" };
    }
    const result = await attachment.stream.acknowledge({
      sessionId: attachment.sessionId,
      attachmentId: attachment.clientId,
      generation: attachment.physicalGeneration,
      cursor: normalizeCursor(cursor),
    });
    return { ...result, restoreRequired: Boolean(result?.restoreRequired) };
  }

  async function detachClient({ id, clientId, generation, allowDifferentGeneration = false } = {}) {
    const attachmentId = requiredId(clientId, "clientId");
    return serializeAttachment(attachmentId, () => detachClientOnce({ id, clientId: attachmentId, generation, allowDifferentGeneration }));
  }

  async function detachClientOnce({ id, clientId, generation, allowDifferentGeneration = false }) {
    const attachment = attachments.get(attachmentKey(String(id ?? ""), String(clientId ?? "")));
    if (!attachment || (!allowDifferentGeneration && attachment.clientGeneration !== String(generation ?? ""))) return false;
    await closeAttachment(attachment);
    return true;
  }

  function onEvent(listener) {
    if (typeof listener !== "function") throw new Error("terminal_daemon_event_listener_invalid");
    events.add(listener);
    return () => events.delete(listener);
  }

  function onClientEvent(listener) {
    if (typeof listener !== "function") throw new Error("terminal_daemon_client_event_listener_invalid");
    clientEvents.add(listener);
    return () => clientEvents.delete(listener);
  }

  function sampleStatus(id) {
    const session = get(id);
    if (!session) return undefined;
    const lastOutputAt = session.lastOutputAt ? Date.parse(session.lastOutputAt) : undefined;
    return {
      id: session.id,
      state: session.status,
      summary: `PTY lifecycle is ${session.status}.`,
      cursor: session.cursor,
      lastOutputAgeMs: lastOutputAt ? Math.max(0, now() - lastOutputAt) : undefined,
    };
  }

  async function close() {
    if (closed) return;
    closed = true;
    await Promise.allSettled(Array.from(attachments.values(), closeAttachment));
    attachments.clear();
    await Promise.allSettled(Array.from(observers.values(), closeObserver));
    observers.clear();
    const control = controlPromise ? await controlPromise.catch(() => undefined) : undefined;
    control?.close();
    controlPromise = undefined;
    events.clear();
    clientEvents.clear();
  }

  async function ensureObserver(session) {
    const existing = observers.get(session.id);
    if (existing?.generation === session.generation) return existing.ready;
    if (existing) await closeObserver(existing);
    const observer = {
      sessionId: session.id,
      generation: session.generation,
      attachmentId: `runtime-observer-${crypto.randomUUID()}`,
      stream: undefined,
      ready: undefined,
      closed: false,
    };
    observer.ready = (async () => {
      const stream = await connectStream(await endpointProvider(), {
        onEvent: (event) => void handleObserverEvent(observer, event),
      });
      observer.stream = stream;
      await stream.subscribe({
        sessionId: observer.sessionId,
        attachmentId: observer.attachmentId,
        generation: observer.generation,
      });
    })().catch(async (error) => {
      observers.delete(session.id);
      await closeObserver(observer);
      throw error;
    });
    observers.set(session.id, observer);
    return observer.ready;
  }

  async function handleObserverEvent(observer, event) {
    if (observer.closed || event?.sessionId !== observer.sessionId || event?.generation !== observer.generation) return;
    if (event.type === "terminal.snapshot") {
      const session = get(observer.sessionId);
      if (session) {
        rememberSession({
          ...session,
          cols: event.snapshot.cols,
          rows: event.snapshot.rows,
          cursor: event.snapshot.cursor,
          bufferMode: event.snapshot.bufferMode,
        });
      }
      await observer.stream.acknowledge({
        sessionId: observer.sessionId,
        attachmentId: observer.attachmentId,
        generation: observer.generation,
        cursor: event.snapshot.cursor,
      });
      return;
    }
    if (event.type === "terminal.delta") {
      const session = rememberSession({
        ...(get(observer.sessionId) ?? { id: observer.sessionId, generation: observer.generation }),
        cursor: event.cursor,
        bufferMode: event.bufferMode,
        lastOutputAt: new Date(now()).toISOString(),
      });
      sessionStore?.recordOutput?.({ taskId: session.taskId, sessionId: session.id, cwd: session.cwd }, event.chunk);
      emitEvent({
        type: "data",
        id: session.id,
        taskId: session.taskId,
        cwd: session.cwd,
        chunk: event.chunk,
        startCursor: event.startCursor,
        cursor: event.cursor,
        generation: session.generation,
        incarnationId: session.incarnationId,
        bufferMode: event.bufferMode,
      });
      await observer.stream.acknowledge({
        sessionId: observer.sessionId,
        attachmentId: observer.attachmentId,
        generation: observer.generation,
        cursor: event.cursor,
      });
      return;
    }
    if (event.type === "terminal.restore-required") {
      await observer.stream.resync({
        sessionId: observer.sessionId,
        attachmentId: observer.attachmentId,
        generation: observer.generation,
      });
      return;
    }
    if (event.type === "terminal.exit") {
      const session = rememberSession({
        ...(get(observer.sessionId) ?? { id: observer.sessionId, generation: observer.generation }),
        status: "stopped",
        cursor: event.cursor,
        exitCode: event.code,
        signal: event.signal,
        stoppedAtMs: now(),
      });
      const recordTerminalState = sessionStore?.recordTerminalState ?? sessionStore?.recordState;
      recordTerminalState?.call(
        sessionStore,
        { taskId: session.taskId, sessionId: session.id, cwd: session.cwd },
        "exited",
        "PTY process exited",
        { exitCode: event.code, signal: event.signal },
      );
      emitEvent({
        type: "exit",
        id: session.id,
        taskId: session.taskId,
        cwd: session.cwd,
        status: "stopped",
        cursor: event.cursor,
        exitCode: event.code,
        signal: event.signal,
        generation: session.generation,
        incarnationId: session.incarnationId,
      });
      return;
    }
  }

  function handleAttachmentEvent(attachment, event) {
    if (attachment.closed || event?.sessionId !== attachment.sessionId || event?.generation !== attachment.physicalGeneration) return;
    if (event.type === "terminal.snapshot") {
      attachment.receivedSnapshot = true;
      attachment.resolveSnapshot?.(event.snapshot);
      return;
    }
    if (event.type === "terminal.delta") {
      emitClientEvent({
        type: "data",
        id: attachment.sessionId,
        chunk: event.chunk,
        startCursor: event.startCursor,
        cursor: event.cursor,
        generation: attachment.clientGeneration,
        bufferMode: event.bufferMode,
      }, attachment);
      return;
    }
    if (event.type === "terminal.restore-required") {
      emitClientEvent({ type: "restore-required", id: attachment.sessionId, generation: attachment.clientGeneration }, attachment);
    }
  }

  async function closeAttachment(attachment) {
    if (!attachment || attachment.closed) return;
    attachment.closed = true;
    const key = attachmentKey(attachment.sessionId, attachment.clientId);
    if (attachments.get(key) === attachment) attachments.delete(key);
    attachment.rejectSnapshot?.(new Error("terminal_attachment_closed"));
    try {
      await attachment.stream?.unsubscribe?.(attachment.sessionId);
    } catch {
      // A dead daemon/stream has already released this attachment.
    }
    attachment.stream?.close?.();
  }

  function serializeAttachment(clientId, operation) {
    const previous = attachmentQueues.get(clientId) ?? Promise.resolve();
    const work = previous.then(operation);
    const barrier = work.then(
      () => undefined,
      () => undefined,
    );
    attachmentQueues.set(clientId, barrier);
    void barrier.then(() => {
      if (attachmentQueues.get(clientId) === barrier) attachmentQueues.delete(clientId);
    });
    return work;
  }

  async function closeObserver(observer) {
    if (!observer || observer.closed) return;
    observer.closed = true;
    try {
      await observer.stream?.unsubscribe?.(observer.sessionId);
    } catch {
      // A dead daemon/stream has already released this observer.
    }
    observer.stream?.close?.();
  }

  async function controlRequest(method, params) {
    if (closed) throw new Error("terminal_daemon_manager_closed");
    if (!controlPromise) {
      controlPromise = connectControl(await endpointProvider());
    }
    const control = await controlPromise;
    return control.request(method, params);
  }

  function requireLiveSession(id, expectedIncarnationId) {
    const session = get(id);
    if (!session || !isLive(session)) throw new Error("terminal_session_not_live");
    if (expectedIncarnationId && session.incarnationId !== expectedIncarnationId) {
      throw new Error("terminal_incarnation_stale");
    }
    return session;
  }

  function rememberSession(value, { replace = false } = {}) {
    const prior = replace ? undefined : sessions.get(String(value?.id ?? ""));
    const merged = {
      ...(prior ?? {}),
      ...value,
      id: requiredId(value?.id ?? prior?.id, "id"),
      status: value?.status ?? prior?.status ?? "running",
      cursor: normalizeCursor(value?.cursor ?? prior?.cursor ?? 0),
    };
    sessions.set(merged.id, merged);
    return cloneSession(merged);
  }

  function emitEvent(event) {
    for (const listener of events) listener(event);
  }

  function emitClientEvent(event, attachment) {
    for (const listener of clientEvents) listener(event, attachment);
  }

  return {
    start,
    createOrAttach,
    get,
    list,
    read,
    getSnapshot,
    write,
    resize,
    stop,
    pauseProducer,
    resumeProducer,
    attachClient,
    acknowledgeOutput,
    detachClient,
    onEvent,
    onClientEvent,
    sampleStatus,
    close,
  };
}

function attachmentKey(sessionId, clientId) {
  return `${sessionId}\0${clientId}`;
}

function requiredId(value, field) {
  const normalized = String(value ?? "").trim();
  if (!normalized) throw new Error(`terminal_daemon_manager_${field}_required`);
  return normalized;
}

function positiveInteger(value, field) {
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric) || numeric < 1) throw new Error(`terminal_daemon_manager_${field}_invalid`);
  return numeric;
}

function normalizeCursor(value) {
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && numeric >= 0 ? numeric : 0;
}

function isLive(session) {
  return session?.status === "running" || session?.status === "stopping";
}

function cloneSession(session) {
  return session ? { ...session, args: Array.isArray(session.args) ? [...session.args] : [] } : undefined;
}

module.exports = { createOrcaTerminalDaemonManager };

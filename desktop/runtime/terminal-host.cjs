const fs = require("node:fs");
const path = require("node:path");
const { createTerminalSession } = require("./terminal-session.cjs");

const DEFAULT_STOPPED_SESSION_RETENTION_MS = 5 * 60 * 1_000;

/**
 * Electron Main's only PTY owner.
 *
 * This is intentionally a small local subset of Orca's TerminalHost: it owns
 * process identity, the headless screen, attachment recovery, and producer
 * flow control. It has no task-planning or provider-semantic responsibilities.
 */
function createTerminalHost({
  pty,
  spawn,
  sessionStore,
  now = () => Date.now(),
  stoppedSessionRetentionMs = DEFAULT_STOPPED_SESSION_RETENTION_MS,
  maxUnacknowledgedBytes,
  maxPendingBytes,
  scrollback,
} = {}) {
  const sessions = new Map();
  const listeners = new Set();

  function createOrAttach(input) {
    cleanupStoppedSessions();
    const id = requiredString(input?.id, "id");
    const existing = sessions.get(id);
    if (existing && isLive(existing.publicSession())) {
      return { disposition: "adopted", session: existing.publicSession() };
    }
    return { disposition: "created", session: start(input) };
  }

  function start(input) {
    cleanupStoppedSessions();
    const id = requiredString(input?.id, "id");
    const existing = sessions.get(id);
    if (existing && isLive(existing.publicSession())) return existing.publicSession();
    requiredString(input?.command, "command");
    requiredString(input?.cwd, "cwd");

    const cols = numericDimension(input?.cols, 100);
    const rows = numericDimension(input?.rows, 30);
    const args = Array.isArray(input?.args) ? input.args.map(String) : [];
    writeRuntimeFiles(input.cwd, input.runtimeFiles);
    const spawned = spawnProcess({
      pty,
      spawn,
      command: input.command,
      args,
      cwd: input.cwd,
      cols,
      rows,
      stdin: input.stdin ?? "pipe",
      env: input.env,
      requirePty: input.requirePty,
    });
    let session;
    session = createTerminalSession({
      id,
      taskId: input.taskId,
      command: input.command,
      args,
      cwd: input.cwd,
      model: input.model,
      provider: input.provider ?? inferProvider(input.command),
      backend: spawned.backend,
      process: spawned.process,
      cols,
      rows,
      scrollback,
      stdin: input.stdin,
      incarnationId: input.incarnationId ?? `terminal-${now()}-${id}`,
      generation: input.generation ?? `terminal-${now()}-${id}`,
      sessionStore,
      now,
      isCurrent: () => sessions.get(id) === session,
      onEvent: emitEvent,
      maxUnacknowledgedBytes,
      maxPendingBytes,
    });
    sessions.set(id, session);
    const publicSession = session.publicSession();
    sessionStore?.startSession({
      taskId: publicSession.taskId,
      sessionId: id,
      command: publicSession.command,
      cwd: publicSession.cwd,
      provider: publicSession.provider,
      model: publicSession.model,
      incarnationId: publicSession.incarnationId,
      generation: publicSession.generation,
    });
    return publicSession;
  }

  function get(id) {
    cleanupStoppedSessions();
    return sessions.get(String(id ?? ""))?.publicSession();
  }

  function list() {
    cleanupStoppedSessions();
    return Array.from(sessions.values(), (session) => session.publicSession());
  }

  function read(id, cursor = 0) {
    const session = sessions.get(String(id ?? ""));
    if (!session) return undefined;
    const requestedCursor = normalizeCursor(cursor);
    const publicSession = session.publicSession();
    const requiresSnapshot = requestedCursor !== publicSession.cursor;
    return {
      ...publicSession,
      requiresSnapshot,
      transcript: [],
    };
  }

  async function getSnapshot(id) {
    const session = sessions.get(String(id ?? ""));
    if (!session) return undefined;
    return session.getSnapshot();
  }

  function write(id, text, options = {}) {
    return sessions.get(String(id ?? ""))?.write(text, options);
  }

  function resize(id, size, options = {}) {
    return sessions.get(String(id ?? ""))?.resize(size, options);
  }

  function stop(id, options = {}) {
    return sessions.get(String(id ?? ""))?.stop(options);
  }

  async function attachClient({ id, clientId, generation }) {
    const session = sessions.get(String(id ?? ""));
    if (!session) return undefined;
    return session.attachClient({ clientId, generation });
  }

  function takePendingOutput({ id, clientId, generation }) {
    const session = sessions.get(String(id ?? ""));
    if (!session) return undefined;
    return session.takeDelivery({ clientId, generation });
  }

  function acknowledgeOutput({ id, clientId, generation, cursor }) {
    const session = sessions.get(String(id ?? ""));
    if (!session) return { accepted: false, reason: "terminal_session_not_found" };
    return session.acknowledgeDelivery({ clientId, generation, cursor });
  }

  function detachClient({ id, clientId, generation }) {
    return sessions.get(String(id ?? ""))?.detachClient({ clientId, generation }) ?? false;
  }

  function requireSnapshot({ id, clientId, generation }) {
    return sessions.get(String(id ?? ""))?.requireSnapshot({ clientId, generation }) ?? false;
  }

  // Explicit producer control is part of the daemon-facing terminal contract.
  // The normal ACK window invokes this automatically; these methods exist for
  // host lifecycle control and do not encode any provider or task semantics.
  function pauseProducer(id) {
    return sessions.get(String(id ?? ""))?.pauseProducer?.() ?? false;
  }

  function resumeProducer(id) {
    return sessions.get(String(id ?? ""))?.resumeProducer?.() ?? false;
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

  function onEvent(listener) {
    if (typeof listener !== "function") throw new Error("terminal_host_listener_invalid");
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function cleanupStoppedSessions() {
    if (!Number.isFinite(stoppedSessionRetentionMs) || stoppedSessionRetentionMs < 0) return 0;
    const cutoff = now() - stoppedSessionRetentionMs;
    let removed = 0;
    for (const [id, session] of sessions) {
      const state = session.publicSession();
      if (state.status !== "stopped" || !Number.isFinite(state.stoppedAtMs) || state.stoppedAtMs > cutoff) continue;
      sessions.delete(id);
      session.dispose();
      removed += 1;
    }
    return removed;
  }

  function close() {
    for (const session of sessions.values()) session.dispose();
    sessions.clear();
    listeners.clear();
  }

  function emitEvent(event) {
    for (const listener of listeners) listener(event);
  }

  return {
    createOrAttach,
    start,
    get,
    list,
    read,
    getSnapshot,
    write,
    resize,
    stop,
    attachClient,
    takePendingOutput,
    acknowledgeOutput,
    detachClient,
    requireSnapshot,
    pauseProducer,
    resumeProducer,
    sampleStatus,
    onEvent,
    cleanupStoppedSessions,
    close,
  };
}

function spawnProcess({ pty, spawn, command, args, cwd, cols, rows, stdin, env, requirePty = false }) {
  const processEnv = { ...process.env, ...(env ?? {}) };
  if (pty) {
    try {
      return {
        backend: "pty",
        process: pty.spawn(command, args, { cwd, cols, rows, env: processEnv, name: "xterm-256color" }),
      };
    } catch (error) {
      if (requirePty || !spawn) throw error;
    }
  }
  if (requirePty) throw new Error("A real node-pty backend is required for interactive Agent terminal sessions.");
  if (!spawn) throw new Error("No PTY or process spawn backend is available.");
  return {
    backend: "process",
    process: spawn(command, args, { cwd, env: processEnv, stdio: [stdin, "pipe", "pipe"] }),
  };
}

function writeRuntimeFiles(cwd, runtimeFiles = []) {
  for (const file of runtimeFiles ?? []) {
    const relativePath = String(file?.relativePath ?? "");
    const contents = String(file?.contents ?? "");
    if (!relativePath || path.isAbsolute(relativePath)) throw new Error("Runtime file path must be project-relative.");
    const projectRoot = path.resolve(cwd);
    const targetPath = path.resolve(projectRoot, relativePath);
    if (targetPath !== projectRoot && !targetPath.startsWith(`${projectRoot}${path.sep}`)) {
      throw new Error("Runtime file path must stay inside the project directory.");
    }
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, contents, "utf8");
  }
}

function isLive(session) {
  return session.status === "running" || session.status === "stopping";
}

function inferProvider(command) {
  const base = path.basename(String(command ?? ""));
  if (base.includes("opencode")) return "opencode";
  if (base.includes("claude")) return "claude-code";
  if (base.includes("codex")) return "codex";
  return "unknown";
}

function requiredString(value, field) {
  const result = String(value ?? "").trim();
  if (!result) throw new Error(`terminal_host_${field}_required`);
  return result;
}

function numericDimension(value, fallback) {
  if (value === undefined || value === null) return fallback;
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 1) throw new Error("terminal_host_dimensions_invalid");
  return result;
}

function normalizeCursor(value) {
  const cursor = Number(value);
  if (!Number.isFinite(cursor) || cursor < 0) return 0;
  return Math.floor(cursor);
}

module.exports = { DEFAULT_STOPPED_SESSION_RETENTION_MS, createTerminalHost };

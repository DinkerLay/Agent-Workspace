const fs = require("node:fs");
const path = require("node:path");
const { createTerminalOutputBuffer } = require("./runtime/terminal-output-buffer.cjs");

function createPtyManager({
  pty,
  spawn,
  sessionStore,
  maxOutputBytes = 256 * 1024,
  stoppedSessionRetentionMs = 5 * 60 * 1_000,
  now = () => Date.now(),
}) {
  const sessions = new Map();
  const eventListeners = new Set();

  function start(input) {
    cleanupStoppedSessions();
    if (!input.id) {
      throw new Error("PTY session requires id, command, and cwd.");
    }

    const existingSession = sessions.get(input.id);
    if (existingSession && isLiveSession(existingSession)) {
      return publicSession(existingSession);
    }

    if (!input.command || !input.cwd) {
      throw new Error("PTY session requires id, command, and cwd.");
    }

    const cols = input.cols ?? 100;
    const rows = input.rows ?? 30;
    const args = input.args ?? [];
    writeRuntimeFiles(input.cwd, input.runtimeFiles);
    const stdin = input.stdin ?? "pipe";
    const spawned = spawnProcess({
      pty,
      spawn,
      command: input.command,
      args,
      cwd: input.cwd,
      cols,
      rows,
      stdin,
      env: input.env,
      requirePty: input.requirePty,
    });
    const proc = spawned.process;
    const session = {
      id: input.id,
      taskId: input.taskId ?? "unscoped-task",
      command: input.command,
      args,
      cwd: input.cwd,
      model: input.model,
      provider: input.provider ?? inferProvider(input.command),
      backend: spawned.backend,
      status: "running",
      cols,
      rows,
      stdin,
      incarnationId: input.incarnationId ?? `legacy-${now()}-${input.id}`,
      generation: input.generation ?? `legacy-${now()}-${input.id}`,
      outputBuffer: createTerminalOutputBuffer({ maxBytes: maxOutputBytes }),
      cursor: 0,
      now,
      sessionStore,
      pid: proc.pid,
      process: proc,
      startedAt: new Date().toISOString(),
      lastOutputAt: undefined,
    };

    sessionStore?.startSession({
      taskId: session.taskId,
      sessionId: session.id,
      command: session.command,
      cwd: session.cwd,
      provider: session.provider,
      model: session.model,
      incarnationId: session.incarnationId,
      generation: session.generation,
    });
    sessions.set(input.id, session);
    bindProcessEvents(proc, spawned.backend, session, emitEvent, () => sessions.get(session.id) === session);

    return publicSession(session);
  }

  function get(id) {
    cleanupStoppedSessions();
    const session = sessions.get(id);
    return session ? publicSession(session) : undefined;
  }

  function list() {
    cleanupStoppedSessions();
    return Array.from(sessions.values()).map((session) => publicSession(session));
  }

  function read(id, cursor = 0) {
    cleanupStoppedSessions();
    const session = sessions.get(id);
    if (!session) return undefined;
    const delta = session.outputBuffer.readAfter(cursor);
    return publicSession(session, delta.chunks, delta.cursor, delta.requiresSnapshot);
  }

  function write(id, text, options = {}) {
    const session = sessions.get(id);
    if (!session || session.status !== "running") return undefined;
    if (options.expectedIncarnationId && options.expectedIncarnationId !== session.incarnationId) return undefined;
    if (typeof session.process.write === "function") {
      session.process.write(text);
    } else {
      session.process.stdin?.write(text);
    }
    return publicSession(session, [], session.cursor);
  }

  function resize(id, size, options = {}) {
    const session = sessions.get(id);
    if (!session || session.status !== "running") return undefined;
    if (options.expectedIncarnationId && options.expectedIncarnationId !== session.incarnationId) return undefined;
    session.cols = size.cols;
    session.rows = size.rows;
    if (typeof session.process.resize === "function") {
      session.process.resize(size.cols, size.rows);
    }
    return publicSession(session, [], session.cursor);
  }

  function stop(id, options = {}) {
    const session = sessions.get(id);
    if (!session || (session.status !== "running" && session.status !== "stopping")) return undefined;
    if (options.expectedIncarnationId && options.expectedIncarnationId !== session.incarnationId) return undefined;
    const signal = session.status === "stopping" ? "SIGKILL" : "SIGTERM";
    session.status = "stopping";
    session.signal = signal;
    session.process.kill(signal);
    return publicSession(session);
  }

  function sampleStatus(id, options = {}) {
    const session = sessions.get(id);
    if (!session) return undefined;
    const lastOutputAt = session.lastOutputAt ? Date.parse(session.lastOutputAt) : Date.parse(session.startedAt);
    const lastOutputAgeMs = Math.max(0, Date.now() - lastOutputAt);

    return {
      id: session.id,
      state: session.status,
      summary: `PTY lifecycle is ${session.status}.`,
      cursor: session.cursor,
      lastOutputAgeMs,
    };
  }

  function cleanupStoppedSessions() {
    if (!Number.isFinite(stoppedSessionRetentionMs) || stoppedSessionRetentionMs < 0) return 0;
    const cutoff = now() - stoppedSessionRetentionMs;
    let removed = 0;
    for (const [id, session] of sessions) {
      if (session.status !== "stopped") continue;
      if (!Number.isFinite(session.stoppedAtMs) || session.stoppedAtMs > cutoff) continue;
      sessions.delete(id);
      removed += 1;
    }
    return removed;
  }

  function onEvent(listener) {
    eventListeners.add(listener);
    return () => {
      eventListeners.delete(listener);
    };
  }

  function emitEvent(event) {
    for (const listener of eventListeners) {
      listener(event);
    }
  }

  return { start, get, list, read, write, resize, stop, onEvent, sampleStatus, cleanupStoppedSessions };
}

function isLiveSession(session) {
  return session.status === "running" || session.status === "stopping";
}

function spawnProcess({ pty, spawn, command, args, cwd, cols, rows, stdin, env, requirePty = false }) {
  const processEnv = {
    ...process.env,
    ...(env ?? {}),
  };

  if (pty) {
    try {
      return {
        backend: "pty",
        process: pty.spawn(command, args, {
          cwd,
          cols,
          rows,
          env: processEnv,
          name: "xterm-256color",
        }),
      };
    } catch (error) {
      if (requirePty) throw error;
      if (!spawn) throw error;
    }
  }

  if (requirePty) {
    throw new Error("A real node-pty backend is required for interactive Agent terminal sessions.");
  }

  if (!spawn) {
    throw new Error("No PTY or process spawn backend is available.");
  }

  return {
    backend: "process",
    process: spawn(command, args, {
      cwd,
      env: processEnv,
      stdio: [stdin, "pipe", "pipe"],
    }),
  };
}

function writeRuntimeFiles(cwd, runtimeFiles = []) {
  for (const file of runtimeFiles) {
    const relativePath = String(file?.relativePath ?? "");
    const contents = String(file?.contents ?? "");
    if (!relativePath || path.isAbsolute(relativePath)) {
      throw new Error("Runtime file path must be project-relative.");
    }

    const targetPath = path.resolve(cwd, relativePath);
    const projectRoot = path.resolve(cwd);
    if (targetPath !== projectRoot && !targetPath.startsWith(`${projectRoot}${path.sep}`)) {
      throw new Error("Runtime file path must stay inside the project directory.");
    }

    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, contents, "utf8");
  }
}

function bindProcessEvents(proc, backend, session, emitEvent, isCurrent) {
  if (backend === "pty") {
    proc.onData((chunk) => {
      if (!isCurrent()) return;
      recordTranscriptChunk(session, chunk, emitEvent);
    });
    proc.onExit((event) => {
      if (!isCurrent()) return;
      session.status = "stopped";
      session.exitCode = event.exitCode;
      session.signal = event.signal;
      emitExitEvent(session, emitEvent);
    });
    return;
  }

  proc.stdout?.on("data", (chunk) => {
    if (!isCurrent()) return;
    recordTranscriptChunk(session, chunk, emitEvent);
  });
  proc.stderr?.on("data", (chunk) => {
    if (!isCurrent()) return;
    recordTranscriptChunk(session, chunk, emitEvent);
  });
  proc.on("close", (exitCode, signal) => {
    if (!isCurrent()) return;
    session.status = "stopped";
    session.exitCode = exitCode;
    session.signal = signal;
    emitExitEvent(session, emitEvent);
  });
}

function publicSession(session, transcript, cursor, requiresSnapshot = false) {
  const snapshot = transcript === undefined ? session.outputBuffer.snapshot() : undefined;
  return {
    id: session.id,
    command: session.command,
    args: [...session.args],
    cwd: session.cwd,
    model: session.model,
    taskId: session.taskId,
    provider: session.provider,
    backend: session.backend,
    status: session.status,
    cols: session.cols,
    rows: session.rows,
    stdin: session.stdin,
    incarnationId: session.incarnationId,
    generation: session.generation,
    transcript: [...(transcript ?? snapshot.chunks)],
    cursor: cursor ?? snapshot.cursor,
    requiresSnapshot,
    output: session.outputBuffer.evidence(),
    pid: session.pid,
    exitCode: session.exitCode,
    signal: session.signal,
  };
}

function recordTranscriptChunk(session, chunk, emitEvent) {
  const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
  const output = session.outputBuffer.append(text);
  session.cursor = output.sequence;
  session.lastOutputAt = new Date().toISOString();
  session.sessionStore?.recordOutput(
    {
      taskId: session.taskId ?? "unscoped-task",
      sessionId: session.id,
      cwd: session.cwd,
    },
    text,
  );
  emitEvent?.({
    type: "data",
    id: session.id,
    chunk: text,
    cursor: session.cursor,
    incarnationId: session.incarnationId,
    generation: session.generation,
  });
}

function emitExitEvent(session, emitEvent) {
  session.stoppedAtMs = session.now();
  session.sessionStore?.recordState(
    {
      taskId: session.taskId ?? "unscoped-task",
      sessionId: session.id,
      cwd: session.cwd,
    },
    "exited",
    "PTY process exited",
    {
      exitCode: session.exitCode,
      signal: session.signal,
    },
  );
  emitEvent?.({
    type: "exit",
    id: session.id,
    status: session.status,
    exitCode: session.exitCode,
    signal: session.signal,
    cursor: session.cursor,
    incarnationId: session.incarnationId,
    generation: session.generation,
  });
}

function inferProvider(command) {
  const base = path.basename(String(command ?? ""));
  if (base.includes("opencode")) return "opencode";
  if (base.includes("claude")) return "claude-code";
  if (base.includes("codex")) return "codex";
  return "unknown";
}

module.exports = { createPtyManager };

const { createHeadlessTerminalModel } = require("./headless-terminal-model.cjs");
const { createTerminalDeliveryWindow } = require("./terminal-delivery-window.cjs");

/**
 * One physical PTY incarnation. All writes to the headless terminal model and
 * all snapshot fences run through one serial queue so a renderer can never
 * observe a screen that was assembled out of order.
 */
function createTerminalSession({
  id,
  taskId = "unscoped-task",
  command,
  args = [],
  cwd,
  model: modelName,
  terminalModel: suppliedTerminalModel,
  provider = "unknown",
  backend,
  process,
  cols,
  rows,
  scrollback,
  stdin = "pipe",
  incarnationId,
  generation,
  sessionStore,
  now = () => Date.now(),
  onEvent = () => undefined,
  isCurrent = () => true,
  maxUnacknowledgedBytes,
  maxPendingBytes,
}) {
  if (!id || !command || !cwd || !process) throw new Error("terminal_session_configuration_invalid");

  const terminalModel = suppliedTerminalModel ?? createHeadlessTerminalModel({ cols, rows, scrollback });
  const delivery = createTerminalDeliveryWindow({
    maxUnacknowledgedBytes,
    maxPendingBytes,
    pauseProducer: pauseOutput,
    resumeProducer: resumeOutput,
  });
  let status = "running";
  let outputCursor = 0;
  let queue = Promise.resolve();
  let exitObserved = false;
  let disposed = false;
  let paused = false;
  let lastOutputAt;
  let exitCode;
  let signal;
  let stoppedAtMs;

  bindProcessEvents();

  function receiveOutput(value) {
    if (disposed || exitObserved || !isCurrent()) return Promise.resolve(undefined);
    const chunk = normalizeChunk(value);
    if (!chunk) return Promise.resolve(undefined);
    const bytes = Buffer.byteLength(chunk, "utf8");
    return enqueue(async () => {
      if (disposed || !isCurrent()) return undefined;
      const startCursor = outputCursor;
      await terminalModel.write(chunk);
      outputCursor += bytes;
      lastOutputAt = new Date(now()).toISOString();
      delivery.enqueue({ chunk, startCursor, cursor: outputCursor, bufferMode: terminalModel.bufferMode });
      sessionStore?.recordOutput(
        { taskId, sessionId: id, cwd },
        chunk,
      );
      onEvent({
        type: "data",
        id,
        taskId,
        cwd,
        chunk,
        startCursor,
        cursor: outputCursor,
        incarnationId,
        generation,
        bufferMode: terminalModel.bufferMode,
      });
      return outputCursor;
    });
  }

  function receiveExit(event = {}) {
    if (disposed || exitObserved || !isCurrent()) return Promise.resolve(undefined);
    exitObserved = true;
    return enqueue(() => {
      if (disposed || !isCurrent()) return undefined;
      status = "stopped";
      exitCode = event.exitCode ?? event.code ?? null;
      signal = event.signal ?? null;
      stoppedAtMs = now();
      const recordTerminalState = sessionStore?.recordTerminalState ?? sessionStore?.recordState;
      recordTerminalState?.call(
        sessionStore,
        { taskId, sessionId: id, cwd },
        "exited",
        "PTY process exited",
        { exitCode, signal },
      );
    onEvent({ type: "exit", id, taskId, cwd, status, exitCode, signal, cursor: outputCursor, incarnationId, generation });
      return publicSession();
    });
  }

  function write(text, { expectedIncarnationId } = {}) {
    if (!isLive() || (expectedIncarnationId && expectedIncarnationId !== incarnationId)) return undefined;
    const payload = String(text ?? "");
    if (!payload) return undefined;
    if (typeof process.write === "function") process.write(payload);
    else process.stdin?.write(payload);
    return publicSession();
  }

  function resize(size, { expectedIncarnationId } = {}) {
    if (!isLive() || (expectedIncarnationId && expectedIncarnationId !== incarnationId)) return undefined;
    const normalized = normalizeSize(size);
    if (typeof process.resize === "function") process.resize(normalized.cols, normalized.rows);
    void enqueue(() => terminalModel.resize(normalized));
    return { ...publicSession(), ...normalized };
  }

  function stop({ expectedIncarnationId } = {}) {
    if (!isLive() || (expectedIncarnationId && expectedIncarnationId !== incarnationId)) return undefined;
    // A second stop request commonly means two control paths observed the
    // same live terminal. It must not turn an ordinary cancellation into an
    // immediate force-kill; timeout escalation is a separate policy.
    if (status === "stopping") return publicSession();
    const stopSignal = "SIGTERM";
    status = "stopping";
    process.kill?.(stopSignal);
    return publicSession();
  }

  async function attachClient({ clientId, generation: attachmentGeneration }) {
    return enqueue(() => {
      const attachment = delivery.attach({ clientId, generation: attachmentGeneration });
      const snapshot = terminalModel.snapshot({ cursor: outputCursor });
      const confirmed = delivery.beginSnapshot({ clientId, generation: attachmentGeneration, cursor: outputCursor });
      if (!confirmed.accepted) throw new Error("terminal_snapshot_attachment_rejected");
      return { snapshot, attachment: confirmed.attachment ?? attachment, session: publicSession() };
    });
  }

  function takeDelivery(input) {
    return delivery.take(input);
  }

  function acknowledgeDelivery(input) {
    return delivery.acknowledge(input);
  }

  function detachClient(input) {
    return delivery.detach(input);
  }

  function requireSnapshot(input) {
    return delivery.markRestoreRequired(input);
  }

  function getSnapshot() {
    return enqueue(() => terminalModel.snapshot({ cursor: outputCursor }));
  }

  function settle() {
    return queue;
  }

  function pauseOutput() {
    if (paused || !isLive() || typeof process.pause !== "function") return false;
    process.pause();
    paused = true;
    onEvent({ type: "output-paused", id, taskId, cwd, cursor: outputCursor, incarnationId, generation });
    return true;
  }

  function resumeOutput() {
    if (!paused || !isLive() || typeof process.resume !== "function") return false;
    process.resume();
    paused = false;
    onEvent({ type: "output-resumed", id, taskId, cwd, cursor: outputCursor, incarnationId, generation });
    return true;
  }

  function dispose() {
    if (disposed) return;
    const live = isLive();
    disposed = true;
    if (live) {
      status = "stopped";
      stoppedAtMs ??= now();
      process.kill?.("SIGTERM");
    }
    terminalModel.dispose();
  }

  function publicSession() {
    return {
      id,
      taskId,
      command,
      args: [...args],
      cwd,
      model: modelName,
      provider,
      backend,
      status,
      cols: terminalModel.cols,
      rows: terminalModel.rows,
      stdin,
      incarnationId,
      generation,
      pid: process.pid,
      cursor: outputCursor,
      lastOutputAt,
      exitCode,
      signal,
      stoppedAtMs,
      delivery: delivery.evidence(),
    };
  }

  function isLive() {
    return status === "running" || status === "stopping";
  }

  function enqueue(operation) {
    const next = queue.then(operation);
    queue = next.catch((error) => {
      onEvent({ type: "terminal-model-error", id, taskId, cwd, error: error instanceof Error ? error.message : String(error), incarnationId, generation });
    });
    return next;
  }

  function bindProcessEvents() {
    if (backend === "pty") {
      process.onData?.((chunk) => {
        void receiveOutput(chunk);
      });
      process.onExit?.((event) => {
        void receiveExit(event);
      });
      return;
    }
    process.stdout?.on("data", (chunk) => {
      void receiveOutput(chunk);
    });
    process.stderr?.on("data", (chunk) => {
      void receiveOutput(chunk);
    });
    process.on?.("close", (code, exitSignal) => {
      void receiveExit({ exitCode: code, signal: exitSignal });
    });
  }

  return {
    receiveOutput,
    receiveExit,
    write,
    resize,
    stop,
    attachClient,
    takeDelivery,
    acknowledgeDelivery,
    detachClient,
    requireSnapshot,
    getSnapshot,
    pauseProducer: pauseOutput,
    resumeProducer: resumeOutput,
    settle,
    dispose,
    publicSession,
  };
}

function normalizeChunk(value) {
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  if (value === undefined || value === null) return "";
  return String(value);
}

function normalizeSize(input = {}) {
  const cols = Number(input.cols);
  const rows = Number(input.rows);
  if (!Number.isSafeInteger(cols) || cols < 1 || !Number.isSafeInteger(rows) || rows < 1) {
    throw new Error("terminal_resize_invalid");
  }
  return { cols, rows };
}

module.exports = { createTerminalSession };

const DEFAULT_FLUSH_DELAY_MS = 16;
const DEFAULT_MAX_PENDING_BYTES = 64 * 1024;

/**
 * Coalesces terminal output per renderer target. Runtime retains the canonical
 * terminal tail; a renderer that falls behind receives a snapshot fence rather
 * than an ever-growing IPC queue.
 */
function createTerminalEventPublisher({
  targets,
  flushDelayMs = DEFAULT_FLUSH_DELAY_MS,
  maxPendingBytes = DEFAULT_MAX_PENDING_BYTES,
  schedule = setTimeout,
  cancel = clearTimeout,
} = {}) {
  if (typeof targets !== "function") throw new Error("Terminal event publisher requires a targets function.");
  if (!Number.isSafeInteger(maxPendingBytes) || maxPendingBytes < 1) {
    throw new Error("Terminal event publisher maxPendingBytes must be a positive integer.");
  }

  const pendingByTarget = new Map();

  function publish(event) {
    if (event?.type !== "data") {
      for (const target of liveTargets()) {
        flushTarget(target);
        send(target, event);
      }
      return;
    }

    for (const target of liveTargets()) {
      const pending = pendingFor(target, event);
      if (!pending.requiresSnapshot) {
        const bytes = Buffer.byteLength(String(event.chunk ?? ""), "utf8");
        if (pending.pendingBytes + bytes > maxPendingBytes) {
          pending.chunk = "";
          pending.pendingBytes = 0;
          pending.requiresSnapshot = true;
        } else {
          pending.chunk += String(event.chunk ?? "");
          pending.pendingBytes += bytes;
        }
      }
      pending.cursor = event.cursor;
      pending.incarnationId = event.incarnationId;
      pending.generation = event.generation;
      scheduleTarget(target, pending);
    }
  }

  function flushTarget(target) {
    const targetKey = targetId(target);
    const pending = pendingByTarget.get(targetKey);
    if (!pending) return;
    pendingByTarget.delete(targetKey);
    if (pending.timer) cancel(pending.timer);
    // A renderer may navigate or close while a coalesced burst is waiting.
    // Its canonical terminal state lives in Runtime, so discard this delta and
    // let the next renderer request its own snapshot instead of addressing a
    // disposed WebFrameMain.
    if (!isLiveTarget(target)) return;
    for (const event of pending.events.values()) {
      const delivered = send(target, {
        type: "data",
        id: event.id,
        chunk: event.chunk,
        cursor: event.cursor,
        incarnationId: event.incarnationId,
        generation: event.generation,
        requiresSnapshot: event.requiresSnapshot,
      });
      if (!delivered) return;
    }
  }

  function close() {
    for (const pending of pendingByTarget.values()) {
      if (pending.timer) cancel(pending.timer);
    }
    pendingByTarget.clear();
  }

  function pendingFor(target, event) {
    const key = targetId(target);
    let pending = pendingByTarget.get(key);
    if (!pending) {
      pending = { target, events: new Map(), timer: undefined };
      pendingByTarget.set(key, pending);
    }
    let entry = pending.events.get(event.id);
    if (!entry) {
      entry = {
        id: event.id,
        chunk: "",
        cursor: event.cursor,
        incarnationId: event.incarnationId,
        generation: event.generation,
        pendingBytes: 0,
        requiresSnapshot: false,
      };
      pending.events.set(event.id, entry);
    }
    return entry;
  }

  function scheduleTarget(target, pendingEntry) {
    const pending = pendingByTarget.get(targetId(target));
    if (!pending || pending.timer) return;
    pending.timer = schedule(() => flushTarget(target), flushDelayMs);
  }

  function liveTargets() {
    return Array.from(targets()).filter(isLiveTarget);
  }

  return { publish, flushTarget, close, evidence: () => ({ pendingTargets: pendingByTarget.size }) };
}

function targetId(target) {
  return String(target.id ?? target.webContentsId ?? "anonymous-target");
}

function isLiveTarget(target) {
  if (!target) return false;
  try {
    if (target.isDestroyed?.()) return false;
    // Electron can retain a live WebContents while its previous main frame is
    // already disposed during reload/navigation. Test doubles do not expose a
    // mainFrame, so only validate it when the target has one.
    const frame = target.mainFrame;
    if (frame && frame.isDestroyed?.()) return false;
    return true;
  } catch {
    return false;
  }
}

function send(target, event) {
  if (!isLiveTarget(target)) return false;
  try {
    target.send("native:pty-event", event);
    return true;
  } catch {
    // A frame may be disposed in the small interval between the liveness check
    // and WebContents.send. Never retry the stale incremental event.
    return false;
  }
}

module.exports = {
  DEFAULT_FLUSH_DELAY_MS,
  DEFAULT_MAX_PENDING_BYTES,
  createTerminalEventPublisher,
};

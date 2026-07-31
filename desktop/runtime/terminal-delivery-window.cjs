const DEFAULT_MAX_UNACKNOWLEDGED_BYTES = 512 * 1024;

/**
 * Tracks one terminal's renderer deliveries. It intentionally never becomes a
 * transcript store: an attachment that falls behind is fenced for a new host
 * snapshot, instead of accumulating an unbounded IPC queue.
 */
function createTerminalDeliveryWindow({
  maxUnacknowledgedBytes = DEFAULT_MAX_UNACKNOWLEDGED_BYTES,
  maxPendingBytes = maxUnacknowledgedBytes * 2,
  pauseProducer = () => undefined,
  resumeProducer = () => undefined,
} = {}) {
  if (!Number.isSafeInteger(maxUnacknowledgedBytes) || maxUnacknowledgedBytes < 1) {
    throw new Error("terminal_delivery_max_unacknowledged_bytes_invalid");
  }
  if (!Number.isSafeInteger(maxPendingBytes) || maxPendingBytes < maxUnacknowledgedBytes) {
    throw new Error("terminal_delivery_max_pending_bytes_invalid");
  }

  const attachments = new Map();
  let producerPaused = false;

  function attach({ clientId, generation }) {
    const id = requiredId(clientId, "clientId");
    const normalizedGeneration = requiredId(generation, "generation");
    const attachment = {
      clientId: id,
      generation: normalizedGeneration,
      ready: false,
      restoreRequired: true,
      snapshotPending: false,
      snapshotCursor: 0,
      latestCursor: 0,
      backpressureBlocked: false,
      deliveredCursor: 0,
      acknowledgedCursor: 0,
      pending: [],
      pendingBytes: 0,
    };
    attachments.set(id, attachment);
    refreshProducerFlow();
    return publicAttachment(attachment);
  }

  function beginSnapshot({ clientId, generation, cursor }) {
    const attachment = attachmentFor({ clientId, generation });
    if (!attachment) return { accepted: false, reason: "attachment_stale" };
    const normalizedCursor = normalizeCursor(cursor);
    attachment.ready = false;
    attachment.restoreRequired = false;
    attachment.snapshotPending = true;
    attachment.snapshotCursor = normalizedCursor;
    attachment.latestCursor = normalizedCursor;
    attachment.backpressureBlocked = false;
    attachment.deliveredCursor = normalizedCursor;
    attachment.acknowledgedCursor = normalizedCursor;
    attachment.pending = [];
    attachment.pendingBytes = 0;
    refreshProducerFlow();
    return { accepted: true, attachment: publicAttachment(attachment) };
  }

  function enqueue(delta) {
    const normalized = normalizeDelta(delta);
    for (const attachment of attachments.values()) {
      attachment.latestCursor = Math.max(attachment.latestCursor, normalized.cursor);
      if (attachment.snapshotPending) continue;
      if (!attachment.ready || attachment.restoreRequired) continue;
      attachment.pending.push(normalized);
      attachment.pendingBytes += normalized.bytes;
      if (unacknowledgedBytes(attachment) > maxPendingBytes) {
        requireRestore(attachment, { pauseProducer: true });
      }
    }
    refreshProducerFlow();
  }

  function take({ clientId, generation }) {
    const attachment = attachmentFor({ clientId, generation });
    if (!attachment) return { accepted: false, reason: "attachment_stale", deltas: [] };
    if (attachment.snapshotPending) {
      return { accepted: true, restoreRequired: false, snapshotPending: true, deltas: [], attachment: publicAttachment(attachment) };
    }
    if (attachment.restoreRequired || !attachment.ready) {
      return { accepted: true, restoreRequired: true, snapshotPending: false, deltas: [], attachment: publicAttachment(attachment) };
    }

    const deltas = attachment.pending;
    attachment.pending = [];
    attachment.pendingBytes = 0;
    if (deltas.length > 0) attachment.deliveredCursor = deltas.at(-1).cursor;
    refreshProducerFlow();
    return {
      accepted: true,
      restoreRequired: false,
      deltas: deltas.map((delta) => ({ ...delta })),
      attachment: publicAttachment(attachment),
    };
  }

  function acknowledge({ clientId, generation, cursor }) {
    const attachment = attachmentFor({ clientId, generation });
    if (!attachment) return { accepted: false, reason: "attachment_stale" };
    const normalizedCursor = normalizeCursor(cursor);
    if (attachment.snapshotPending) {
      if (normalizedCursor !== attachment.snapshotCursor) {
        return { accepted: false, reason: "snapshot_ack_cursor_invalid", attachment: publicAttachment(attachment) };
      }
      attachment.snapshotPending = false;
      if (attachment.latestCursor > attachment.snapshotCursor) {
        requireRestore(attachment);
        refreshProducerFlow();
        return { accepted: true, restoreRequired: true, attachment: publicAttachment(attachment) };
      }
      attachment.ready = true;
      attachment.restoreRequired = false;
      refreshProducerFlow();
      return { accepted: true, restoreRequired: false, attachment: publicAttachment(attachment) };
    }
    if (normalizedCursor < attachment.acknowledgedCursor || normalizedCursor > attachment.deliveredCursor) {
      return { accepted: false, reason: "ack_cursor_invalid", attachment: publicAttachment(attachment) };
    }
    attachment.acknowledgedCursor = normalizedCursor;
    refreshProducerFlow();
    return { accepted: true, attachment: publicAttachment(attachment) };
  }

  function detach({ clientId, generation }) {
    const attachment = attachmentFor({ clientId, generation });
    if (!attachment) return false;
    attachments.delete(attachment.clientId);
    refreshProducerFlow();
    return true;
  }

  function markRestoreRequired({ clientId, generation }) {
    const attachment = attachmentFor({ clientId, generation });
    if (!attachment) return false;
    requireRestore(attachment);
    refreshProducerFlow();
    return true;
  }

  function evidence() {
    return {
      producerPaused,
      attachmentCount: attachments.size,
      attachments: Array.from(attachments.values(), publicAttachment),
    };
  }

  function attachmentFor({ clientId, generation }) {
    const attachment = attachments.get(String(clientId ?? ""));
    if (!attachment || attachment.generation !== String(generation ?? "")) return undefined;
    return attachment;
  }

  function requireRestore(attachment, { pauseProducer: shouldPauseProducer = false } = {}) {
    attachment.ready = false;
    attachment.restoreRequired = true;
    attachment.snapshotPending = false;
    attachment.backpressureBlocked ||= shouldPauseProducer;
    attachment.pending = [];
    attachment.pendingBytes = 0;
  }

  function refreshProducerFlow() {
    const shouldPause = Array.from(attachments.values()).some(
      (attachment) => attachment.backpressureBlocked || unacknowledgedBytes(attachment) > maxUnacknowledgedBytes,
    );
    if (shouldPause && !producerPaused) {
      producerPaused = true;
      pauseProducer();
      return;
    }
    if (!shouldPause && producerPaused) {
      producerPaused = false;
      resumeProducer();
    }
  }

  return { attach, beginSnapshot, enqueue, take, acknowledge, detach, markRestoreRequired, evidence };
}

function normalizeDelta(input) {
  const chunk = typeof input?.chunk === "string" ? input.chunk : String(input?.chunk ?? "");
  const startCursor = normalizeCursor(input?.startCursor);
  const cursor = normalizeCursor(input?.cursor);
  const bufferMode = input?.bufferMode === "alternate" ? "alternate" : "normal";
  const bytes = Buffer.byteLength(chunk, "utf8");
  if (!chunk || cursor <= startCursor || cursor - startCursor !== bytes) {
    throw new Error("terminal_delivery_delta_invalid");
  }
  return { chunk, startCursor, cursor, bytes, bufferMode };
}

function unacknowledgedBytes(attachment) {
  return attachment.deliveredCursor - attachment.acknowledgedCursor + attachment.pendingBytes;
}

function publicAttachment(attachment) {
  return {
    clientId: attachment.clientId,
    generation: attachment.generation,
    ready: attachment.ready,
    restoreRequired: attachment.restoreRequired,
    snapshotPending: attachment.snapshotPending,
    backpressureBlocked: attachment.backpressureBlocked,
    deliveredCursor: attachment.deliveredCursor,
    acknowledgedCursor: attachment.acknowledgedCursor,
    pendingBytes: attachment.pendingBytes,
    unacknowledgedBytes: unacknowledgedBytes(attachment),
  };
}

function requiredId(value, field) {
  const id = String(value ?? "").trim();
  if (!id) throw new Error(`terminal_delivery_${field}_required`);
  return id;
}

function normalizeCursor(value) {
  const cursor = Number(value);
  if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error("terminal_delivery_cursor_invalid");
  return cursor;
}

module.exports = { DEFAULT_MAX_UNACKNOWLEDGED_BYTES, createTerminalDeliveryWindow };

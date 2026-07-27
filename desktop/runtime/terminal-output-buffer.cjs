const DEFAULT_MAX_BYTES = 256 * 1024;

/**
 * Runtime-owned, byte-bounded terminal tail.
 *
 * The renderer receives deltas but must be able to rebuild from this host-owned
 * snapshot after it was hidden, throttled, or disconnected. This deliberately
 * stores raw terminal bytes as a diagnostic surface only; task semantic state
 * stays in the Session Store.
 */
function createTerminalOutputBuffer({ maxBytes = DEFAULT_MAX_BYTES } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new Error("Terminal output buffer maxBytes must be a positive integer.");
  }

  let nextSequence = 1;
  let retainedBytes = 0;
  const chunks = [];

  function append(value) {
    const text = String(value ?? "");
    if (!text) return { sequence: nextSequence - 1, retainedBytes };

    const sequence = nextSequence++;
    const trimmed = tailWithinUtf8Bytes(text, maxBytes);
    const bytes = Buffer.byteLength(trimmed, "utf8");
    chunks.push({ sequence, text: trimmed, bytes });
    retainedBytes += bytes;
    trimToBudget();
    return { sequence, retainedBytes };
  }

  function readAfter(cursor = 0) {
    const normalizedCursor = normalizeCursor(cursor);
    const earliestSequence = chunks[0]?.sequence ?? nextSequence;
    const requiresSnapshot = normalizedCursor < earliestSequence - 1;
    const visible = requiresSnapshot ? chunks : chunks.filter((chunk) => chunk.sequence > normalizedCursor);
    return {
      cursor: nextSequence - 1,
      earliestSequence,
      requiresSnapshot,
      chunks: visible.map((chunk) => chunk.text),
      retainedBytes,
    };
  }

  function snapshot() {
    return {
      cursor: nextSequence - 1,
      earliestSequence: chunks[0]?.sequence ?? nextSequence,
      chunks: chunks.map((chunk) => chunk.text),
      retainedBytes,
    };
  }

  function evidence() {
    return {
      cursor: nextSequence - 1,
      earliestSequence: chunks[0]?.sequence ?? nextSequence,
      retainedBytes,
      chunkCount: chunks.length,
      maxBytes,
    };
  }

  function trimToBudget() {
    while (retainedBytes > maxBytes && chunks.length > 0) {
      const head = chunks[0];
      const excess = retainedBytes - maxBytes;
      if (head.bytes <= excess) {
        retainedBytes -= head.bytes;
        chunks.shift();
        continue;
      }

      const nextText = tailWithinUtf8Bytes(head.text, head.bytes - excess);
      const nextBytes = Buffer.byteLength(nextText, "utf8");
      retainedBytes -= head.bytes - nextBytes;
      head.text = nextText;
      head.bytes = nextBytes;
      break;
    }
  }

  return { append, readAfter, snapshot, evidence };
}

function tailWithinUtf8Bytes(value, maxBytes) {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maxBytes) return value;

  let start = Math.max(0, bytes.length - maxBytes);
  while (start < bytes.length && (bytes[start] & 0b1100_0000) === 0b1000_0000) {
    start += 1;
  }
  return bytes.subarray(start).toString("utf8");
}

function normalizeCursor(value) {
  const cursor = Number(value);
  if (!Number.isFinite(cursor) || cursor < 0) return 0;
  return Math.floor(cursor);
}

module.exports = { DEFAULT_MAX_BYTES, createTerminalOutputBuffer, tailWithinUtf8Bytes };

const { Terminal } = require("@xterm/headless");
const { SerializeAddon } = require("@xterm/addon-serialize");

const DEFAULT_COLS = 100;
const DEFAULT_ROWS = 30;
// Keep the Main-owned terminal screen and renderer xterm buffer aligned.  The
// host remains authoritative, so a reconnection must never silently lose the
// extra history a visible renderer appeared to have.
const DEFAULT_SCROLLBACK = 5_000;

/**
 * The authoritative terminal screen for one managed PTY.
 *
 * Renderer xterm instances are projections of this model. Keeping the parser
 * in Electron Main is what makes a native TUI recoverable after a panel is
 * hidden, reloaded, or replaced.
 */
function createHeadlessTerminalModel({
  cols = DEFAULT_COLS,
  rows = DEFAULT_ROWS,
  scrollback = DEFAULT_SCROLLBACK,
} = {}) {
  const dimensions = normalizeDimensions({ cols, rows });
  const scrollbackRows = normalizeScrollback(scrollback);
  const terminal = new Terminal({
    cols: dimensions.cols,
    rows: dimensions.rows,
    scrollback: scrollbackRows,
    allowProposedApi: true,
    convertEol: false,
    logLevel: "off",
  });
  const serializer = new SerializeAddon();
  terminal.loadAddon(serializer);
  let disposed = false;
  let sequence = 0;

  function write(value) {
    assertOpen();
    const data = normalizeData(value);
    if (!data) return Promise.resolve({ sequence, bytes: 0 });
    const bytes = Buffer.byteLength(data, "utf8");
    return new Promise((resolve) => {
      terminal.write(data, () => {
        sequence += bytes;
        resolve({ sequence, bytes });
      });
    });
  }

  function resize(next) {
    assertOpen();
    const normalized = normalizeDimensions(next);
    if (normalized.cols === terminal.cols && normalized.rows === terminal.rows) {
      return normalized;
    }
    terminal.resize(normalized.cols, normalized.rows);
    return normalized;
  }

  function snapshot({ cursor = sequence } = {}) {
    assertOpen();
    return {
      ansi: serializer.serialize({ scrollback: scrollbackRows }),
      cursor: normalizeCursor(cursor),
      modelSequence: sequence,
      cols: terminal.cols,
      rows: terminal.rows,
      scrollback: scrollbackRows,
      bufferMode: terminal.buffer.active.type === "alternate" ? "alternate" : "normal",
    };
  }

  function visibleLines() {
    assertOpen();
    const buffer = terminal.buffer.active;
    const start = buffer.baseY;
    return Array.from({ length: terminal.rows }, (_, index) => buffer.getLine(start + index)?.translateToString(true) ?? "");
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    terminal.dispose();
  }

  function assertOpen() {
    if (disposed) throw new Error("headless_terminal_disposed");
  }

  return {
    write,
    resize,
    snapshot,
    visibleLines,
    dispose,
    get sequence() {
      return sequence;
    },
    get cols() {
      return terminal.cols;
    },
    get rows() {
      return terminal.rows;
    },
    get bufferMode() {
      return terminal.buffer.active.type === "alternate" ? "alternate" : "normal";
    },
  };
}

function normalizeDimensions(value = {}) {
  const cols = positiveInteger(value.cols, "cols", DEFAULT_COLS);
  const rows = positiveInteger(value.rows, "rows", DEFAULT_ROWS);
  return { cols, rows };
}

function normalizeScrollback(value) {
  return positiveInteger(value, "scrollback", DEFAULT_SCROLLBACK, { allowZero: true });
}

function positiveInteger(value, field, fallback, { allowZero = false } = {}) {
  if (value === undefined || value === null) return fallback;
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < (allowZero ? 0 : 1)) {
    throw new Error(`terminal_${field}_invalid`);
  }
  return result;
}

function normalizeData(value) {
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  if (value === undefined || value === null) return "";
  return String(value);
}

function normalizeCursor(value) {
  const cursor = Number(value);
  if (!Number.isFinite(cursor) || cursor < 0) return 0;
  return Math.floor(cursor);
}

module.exports = {
  DEFAULT_COLS,
  DEFAULT_ROWS,
  DEFAULT_SCROLLBACK,
  createHeadlessTerminalModel,
};

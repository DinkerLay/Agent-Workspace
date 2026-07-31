const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Worker } = require("node:worker_threads");

function defaultOpenCodeDatabasePaths({ env = process.env, homedir = os.homedir } = {}) {
  const configured = String(env.OPENCODE_DB_PATH ?? "")
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
  const dataHome = String(env.XDG_DATA_HOME ?? "").trim();
  const standard = [
    dataHome ? path.join(dataHome, "opencode", "opencode.db") : "",
    path.join(homedir(), ".local", "share", "opencode", "opencode.db"),
  ];
  return [...new Set([...configured, ...standard].map((entry) => path.resolve(entry)).filter(Boolean))];
}

function createOpenCodeSqliteReader({
  workerPath = path.join(__dirname, "opencode-sqlite-reader-worker.cjs"),
  databasePaths = defaultOpenCodeDatabasePaths(),
  WorkerImpl = Worker,
  requestTimeoutMs = 15_000,
} = {}) {
  let worker;
  let closing = false;
  let nextRequestId = 1;
  let serial = Promise.resolve();
  const pending = new Map();

  function inspectDispatch(input = {}) {
    return enqueue({
      kind: "inspectDispatch",
      input: {
        ...input,
        dbPaths: Array.isArray(input.dbPaths) ? input.dbPaths : databasePaths,
      },
    });
  }

  function inspectConductor(input = {}) {
    return enqueue({
      kind: "inspectConductor",
      input: {
        ...input,
        dbPaths: Array.isArray(input.dbPaths) ? input.dbPaths : databasePaths,
      },
    });
  }

  function inspectConductorInput(input = {}) {
    return enqueue({
      kind: "inspectConductorInput",
      input: {
        ...input,
        dbPaths: Array.isArray(input.dbPaths) ? input.dbPaths : databasePaths,
      },
    });
  }

  function enqueue(message) {
    const execute = () => request(message);
    const result = serial.then(execute, execute);
    serial = result.catch(() => undefined);
    return result;
  }

  function request(message) {
    if (closing) return Promise.reject(new Error("opencode_sqlite_reader_closed"));
    const activeWorker = ensureWorker();
    const id = String(nextRequestId++);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error("opencode_sqlite_reader_timeout"));
      }, Math.max(1, Number(requestTimeoutMs) || 15_000));
      timer.unref?.();
      pending.set(id, { resolve, reject, timer });
      activeWorker.postMessage({ id, ...message });
    });
  }

  function ensureWorker() {
    if (worker) return worker;
    if (!fs.existsSync(workerPath)) throw new Error(`opencode_sqlite_worker_missing:${workerPath}`);
    worker = new WorkerImpl(workerPath);
    worker.unref?.();
    worker.on("message", (response) => {
      const pendingRequest = pending.get(String(response?.id ?? ""));
      if (!pendingRequest) return;
      pending.delete(String(response.id));
      clearTimeout(pendingRequest.timer);
      if (response?.ok) pendingRequest.resolve(response.value);
      else pendingRequest.reject(new Error(String(response?.error ?? "opencode_sqlite_reader_failed")));
    });
    worker.on("error", (error) => rejectPending(error));
    worker.on("exit", (code) => {
      const exited = worker;
      worker = undefined;
      if (!closing && code !== 0) rejectPending(new Error(`opencode_sqlite_worker_exited:${code}`));
      if (closing && exited) rejectPending(new Error("opencode_sqlite_reader_closed"));
    });
    return worker;
  }

  function rejectPending(error) {
    for (const [id, request] of pending) {
      pending.delete(id);
      clearTimeout(request.timer);
      request.reject(error);
    }
  }

  async function close() {
    closing = true;
    rejectPending(new Error("opencode_sqlite_reader_closed"));
    const activeWorker = worker;
    worker = undefined;
    if (activeWorker) await activeWorker.terminate();
  }

  return { inspectDispatch, inspectConductor, inspectConductorInput, close, databasePaths: [...databasePaths] };
}

module.exports = { createOpenCodeSqliteReader, defaultOpenCodeDatabasePaths };

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { createOpenCodeProviderObserver } = require("./opencode/opencode-provider-observer.cjs");
const { createOpenCodeSqliteReader } = require("./opencode/opencode-sqlite-reader.cjs");
const { createOrcaTerminalDaemonSupervisor } = require("./runtime/orca-terminal-daemon-supervisor.cjs");
const { createOrcaTerminalDaemonManager } = require("./runtime/orca-terminal-daemon-manager.cjs");
const { createSessionStore } = require("./session-store.cjs");
const { createSessionWakeupMonitor } = require("./session-wakeup-monitor.cjs");

// H3: real daemon-owned PTYs plus an OpenCode-shaped SQLite fixture read by
// the same Worker-thread Provider Observer used in production. It proves the
// separation: terminal transport accepts bytes; the observer derives exact
// receipt/failure facts; only then does the Coordinator wake Conductor.
async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-workspace-provider-coordinator-"));
  const supervisor = createOrcaTerminalDaemonSupervisor();
  const store = createSessionStore({ root });
  const manager = createOrcaTerminalDaemonManager({ endpointProvider: () => supervisor.start(), sessionStore: store });
  const taskId = "h2-provider-facts";
  const conductorId = `${taskId}-conductor`;
  const workerId = `${taskId}-researcher`;
  let providerObserver;
  let workerTransportWrites = 0;
  let conductorTransportWrites = 0;
  const daemonWrite = manager.write;
  manager.write = async (sessionId, ...args) => {
    if (sessionId === workerId) workerTransportWrites += 1;
    if (sessionId === conductorId) conductorTransportWrites += 1;
    return daemonWrite(sessionId, ...args);
  };

  try {
    const cwd = path.resolve(__dirname, "..");
    const conductor = await manager.start({
      id: conductorId,
      taskId,
      command: "/bin/cat",
      args: [],
      cwd,
      provider: "opencode",
      model: "fixture",
      cols: 100,
      rows: 30,
      requirePty: true,
      incarnationId: "h2-conductor-incarnation",
      generation: "h2-conductor-generation",
    });
    const worker = await manager.start({
      id: workerId,
      taskId,
      command: "/bin/cat",
      args: [],
      cwd,
      provider: "opencode",
      model: "fixture",
      cols: 100,
      rows: 30,
      requirePty: true,
      incarnationId: "h2-worker-incarnation",
      generation: "h2-worker-generation",
    });
    store.recordState({ taskId, sessionId: conductorId }, "waiting_conductor", "Fixture conductor completed its decision.");
    const dispatch = store.recordDispatch({
      taskId,
      toSessionId: workerId,
      conductorSessionId: conductorId,
      assignment: "Find one primary source.",
    });
    await manager.write(workerId, `[Agent Workspace] Dispatch ID ${dispatch.dispatchId}\nFind one primary source.\n`, {
      expectedIncarnationId: worker.incarnationId,
    });
    store.markDispatchInputAccepted({
      taskId,
      sessionId: workerId,
      dispatchId: dispatch.dispatchId,
      transport: "terminal_runtime",
      incarnationId: worker.incarnationId,
      generation: worker.generation,
    });
    const databasePath = path.join(root, "opencode.db");
    const providerTime = seedDispatchReceipt({ databasePath, cwd, dispatchId: dispatch.dispatchId });
    providerObserver = createOpenCodeProviderObserver({
      reader: createOpenCodeSqliteReader({ databasePaths: [databasePath] }),
    });

    const monitor = createSessionWakeupMonitor({
      ptyManager: manager,
      sessionStore: store,
      providerObserver,
    });

    const receiptTick = await monitor.tick();
    assert.equal(receiptTick.providerFailures, 0);
    assert.equal(store.readSession({ taskId, sessionId: workerId }).dispatches[0].status, "delivered");

    appendProviderFailure({ databasePath, createdAt: providerTime + 10 });
    const failureTick = await monitor.tick();
    assert.equal(failureTick.providerFailures, 1);
    assert.equal(failureTick.wakeupsSent, 1);
    assert.equal(conductorTransportWrites, 1, "Coordinator wrote exactly one semantic wakeup to Conductor");
    const workerView = store.readSession({ taskId, sessionId: workerId });
    assert.equal(workerView.dispatches[0].status, "provider_failed");
    assert.ok(workerView.events.some((event) => event.type === "dispatch.input_accepted"));
    assert.ok(workerView.events.some((event) => event.type === "dispatch.provider.received"));
    assert.ok(workerView.events.some((event) => event.type === "dispatch.provider.failed"));
    assert.equal(workerTransportWrites, 1, "Runtime never resubmits the worker dispatch");
    console.log("H3 PASS: daemon-owned PTY input, Provider receipt/failure facts, and one Conductor wakeup without Runtime retry.");
    await manager.stop(conductorId, { expectedIncarnationId: conductor.incarnationId });
    await manager.stop(workerId, { expectedIncarnationId: worker.incarnationId });
  } finally {
    await providerObserver?.close?.();
    await manager.close();
    await supervisor.stop();
  }
}

function seedDispatchReceipt({ databasePath, cwd, dispatchId }) {
  const createdAt = Date.now() + 1_000;
  const db = new DatabaseSync(databasePath);
  try {
    db.exec(`
      CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, path TEXT);
      CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);
      CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, time_created INTEGER, data TEXT);
    `);
    db.prepare("INSERT INTO session (id, directory, path) VALUES (?, ?, ?)").run("ses_h2_worker", cwd, cwd);
    db.prepare("INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)")
      .run("msg_h2_dispatch", "ses_h2_worker", createdAt, JSON.stringify({ role: "user" }));
    db.prepare("INSERT INTO part (id, message_id, time_created, data) VALUES (?, ?, ?, ?)")
      .run("prt_h2_dispatch", "msg_h2_dispatch", createdAt, JSON.stringify({ type: "text", text: `[Agent Workspace] Dispatch ID ${dispatchId}\nFind one primary source.` }));
  } finally {
    db.close();
  }
  return createdAt;
}

function appendProviderFailure({ databasePath, createdAt }) {
  const db = new DatabaseSync(databasePath);
  try {
    db.prepare("INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)")
      .run("msg_h2_failure", "ses_h2_worker", createdAt, JSON.stringify({ role: "assistant" }));
    db.prepare("INSERT INTO part (id, message_id, time_created, data) VALUES (?, ?, ?, ?)")
      .run("prt_h2_failure", "msg_h2_failure", createdAt, JSON.stringify({ type: "step-finish", reason: "error" }));
  } finally {
    db.close();
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

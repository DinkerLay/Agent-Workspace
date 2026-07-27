const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createOrcaTerminalDaemonSupervisor } = require("./runtime/orca-terminal-daemon-supervisor.cjs");
const { createOrcaTerminalDaemonManager } = require("./runtime/orca-terminal-daemon-manager.cjs");
const { createSessionStore } = require("./session-store.cjs");
const { createSessionWakeupMonitor } = require("./session-wakeup-monitor.cjs");

// H3: real daemon-owned PTYs plus a deterministic Provider adapter fixture.
// It proves the critical separation: the terminal accepts input, the Provider
// observer writes receipt/failure facts, and only then does the Coordinator
// wake Conductor. No Runtime path retries the worker.
async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-workspace-provider-coordinator-"));
  const supervisor = createOrcaTerminalDaemonSupervisor();
  const store = createSessionStore({ root });
  const manager = createOrcaTerminalDaemonManager({ endpointProvider: () => supervisor.start(), sessionStore: store });
  const taskId = "h2-provider-facts";
  const conductorId = `${taskId}-conductor`;
  const workerId = `${taskId}-researcher`;
  let phase = "received";
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

    const monitor = createSessionWakeupMonitor({
      ptyManager: manager,
      sessionStore: store,
      dispatchStateReader: ({ dispatch: observed }) => {
        if (observed.dispatchId !== dispatch.dispatchId) return undefined;
        const receipt = { providerSessionId: "ses_h2_worker", providerMessageId: "msg_h2_dispatch", dispatchMessageCreatedAt: 101 };
        if (phase === "received") return { state: "received", provider: "opencode", receipt };
        return {
          state: "terminal_failure",
          provider: "opencode",
          receipt,
          failure: { providerMessageId: "msg_h2_failure", providerStepFinishId: "prt_h2_failure", stepFinishReason: "error" },
        };
      },
    });

    const receiptTick = await monitor.tick();
    assert.equal(receiptTick.providerFailures, 0);
    assert.equal(store.readSession({ taskId, sessionId: workerId }).dispatches[0].status, "delivered");

    phase = "failure";
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
    await manager.close();
    await supervisor.stop();
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

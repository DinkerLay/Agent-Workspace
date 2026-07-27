const assert = require("node:assert/strict");
const path = require("node:path");
const { createOrcaTerminalDaemonSupervisor } = require("./runtime/orca-terminal-daemon-supervisor.cjs");
const { createOrcaTerminalDaemonManager } = require("./runtime/orca-terminal-daemon-manager.cjs");

async function main() {
  const supervisor = createOrcaTerminalDaemonSupervisor();
  const manager = createOrcaTerminalDaemonManager({ endpointProvider: () => supervisor.start() });
  const runtimeEvents = [];
  const rendererEvents = [];
  const unsubscribeRuntime = manager.onEvent((event) => runtimeEvents.push(event));
  const unsubscribeRenderer = manager.onClientEvent((event) => rendererEvents.push(event));
  try {
    const session = await manager.start({
      id: "manager:task-1:cat",
      taskId: "task-1",
      command: "/bin/cat",
      args: [],
      cwd: path.resolve(__dirname, ".."),
      cols: 90,
      rows: 24,
      provider: "harness",
      model: "none",
      requirePty: true,
      incarnationId: "manager-incarnation-1",
      generation: "manager-generation-1",
    });
    assert.equal(session.status, "running");
    assert.equal(manager.get(session.id)?.pid, session.pid, "Main retains metadata only, not a new PTY");

    const attached = await manager.attachClient({
      id: session.id,
      clientId: "renderer-a",
      generation: "renderer-attachment-1",
    });
    assert.equal(attached.snapshot.cursor, 0);
    await manager.acknowledgeOutput({
      id: session.id,
      clientId: "renderer-a",
      generation: "renderer-attachment-1",
      cursor: attached.snapshot.cursor,
    });
    await manager.resize(session.id, { cols: 80, rows: 20 }, { expectedIncarnationId: session.incarnationId });
    await manager.write(session.id, "daemon-manager-roundtrip\n", { expectedIncarnationId: session.incarnationId });
    const rendererDelta = await waitFor(rendererEvents, (event) => event.type === "data" && event.chunk.includes("daemon-manager-roundtrip"));
    assert.equal(rendererDelta.generation, "renderer-attachment-1", "renderer sees its attachment generation, never the physical generation");
    await manager.acknowledgeOutput({
      id: session.id,
      clientId: "renderer-a",
      generation: "renderer-attachment-1",
      cursor: rendererDelta.cursor,
    });
    assert.ok(runtimeEvents.some((event) => event.type === "data" && event.chunk.includes("daemon-manager-roundtrip")), "semantic observers receive transport facts independently of renderer delivery");

    await manager.stop(session.id, { expectedIncarnationId: session.incarnationId });
    await waitFor(runtimeEvents, (event) => event.type === "exit", 4_000);
    console.log("H1.5 PASS: Electron/Main daemon manager uses daemon-owned PTY, observer facts, and renderer ACK bridge.");
  } finally {
    unsubscribeRuntime();
    unsubscribeRenderer();
    await manager.close();
    await supervisor.stop();
  }
}

function waitFor(events, predicate, timeoutMs = 3_000) {
  const immediate = events.find(predicate);
  if (immediate) return Promise.resolve(immediate);
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const timer = setInterval(() => {
      const event = events.find(predicate);
      if (event) {
        clearInterval(timer);
        resolve(event);
      } else if (Date.now() >= deadline) {
        clearInterval(timer);
        reject(new Error("terminal manager harness timed out"));
      }
    }, 10);
  });
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

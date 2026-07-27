const assert = require("node:assert/strict");
const { createOrcaTerminalDaemon } = require("./runtime/orca-terminal-daemon.cjs");

async function main() {
  const fake = createFakePty();
  const daemon = createOrcaTerminalDaemon({
    pty: fake.pty,
    terminalHostOptions: { maxUnacknowledgedBytes: 3, maxPendingBytes: 8, scrollback: 20 },
  });
  const session = {
    id: "terminal:task-1:researcher",
    taskId: "task-1",
    command: "opencode",
    args: [],
    cwd: "/tmp/agent-workspace-h0",
    cols: 40,
    rows: 12,
  };
  const claimOne = { ownerId: "task-1/researcher", generation: "generation-1" };
  try {
    const created = daemon.invokeControl("terminal.createOrAttach", { session, claim: claimOne });
    assert.equal(created.disposition, "created");
    assert.equal(fake.processes.length, 1, "a create must spawn exactly one PTY");

    const adopted = daemon.invokeControl("terminal.createOrAttach", { session, claim: claimOne });
    assert.equal(adopted.disposition, "adopted");
    assert.equal(fake.processes.length, 1, "same owner/generation must attach, not respawn");
    assert.throws(
      () =>
        daemon.invokeControl("terminal.createOrAttach", {
          session,
          claim: { ownerId: "task-1/other-agent", generation: "generation-2" },
        }),
      /terminal_session_claim_unavailable/,
      "a live claimed terminal cannot be stolen by another generation",
    );

    const streamEvents = [];
    await daemon.subscribeStream({
      connectionId: "renderer-a",
      send: (event) => streamEvents.push(event),
      sessionId: session.id,
      attachmentId: "workbench-a",
      generation: claimOne.generation,
    });
    const initialSnapshot = latest(streamEvents, "terminal.snapshot");
    assert.equal(initialSnapshot.snapshot.cursor, 0);
    daemon.acknowledgeStream({
      connectionId: "renderer-a",
      sessionId: session.id,
      attachmentId: "workbench-a",
      generation: claimOne.generation,
      cursor: initialSnapshot.snapshot.cursor,
    });

    fake.processes[0].emitData("abcd");
    await daemon.terminalHost.getSnapshot(session.id);
    const firstDelta = latest(streamEvents, "terminal.delta");
    assert.equal(firstDelta.chunk, "abcd");
    assert.equal(firstDelta.startCursor, 0);
    assert.equal(firstDelta.cursor, 4);
    assert.deepEqual(fake.calls.filter((call) => call[0] === "pause"), [["pause", 800]], "ACK lag must pause the PTY producer");

    daemon.acknowledgeStream({
      connectionId: "renderer-a",
      sessionId: session.id,
      attachmentId: "workbench-a",
      generation: claimOne.generation,
      cursor: firstDelta.cursor,
    });
    assert.deepEqual(fake.calls.filter((call) => call[0] === "resume"), [["resume", 800]], "cumulative renderer ACK must resume PTY output");

    daemon.invokeControl("terminal.kill", { sessionId: session.id, generation: claimOne.generation });
    fake.processes[0].emitExit({ exitCode: 0, signal: 0 });
    await daemon.terminalHost.getSnapshot(session.id);

    const claimTwo = { ownerId: "task-1/researcher", generation: "generation-2" };
    const replacement = daemon.invokeControl("terminal.createOrAttach", { session, claim: claimTwo });
    assert.equal(replacement.disposition, "created");
    assert.equal(fake.processes.length, 2);
    assert.throws(
      () => daemon.invokeControl("terminal.write", { sessionId: session.id, generation: claimOne.generation, data: "stale" }),
      /terminal_session_generation_stale/,
      "a stale generation must not write into its replacement",
    );

    // The old PTY retains its callback, so this verifies the output fence, not
    // merely the control-plane write fence.
    fake.processes[0].emitData("old-output");
    fake.processes[1].emitData("replacement");
    await daemon.terminalHost.getSnapshot(session.id);

    const reconnectEvents = [];
    await daemon.subscribeStream({
      connectionId: "renderer-b",
      send: (event) => reconnectEvents.push(event),
      sessionId: session.id,
      attachmentId: "workbench-b",
      generation: claimTwo.generation,
    });
    const reconnectSnapshot = latest(reconnectEvents, "terminal.snapshot");
    assert.match(reconnectSnapshot.snapshot.ansi, /replacement/);
    assert.doesNotMatch(reconnectSnapshot.snapshot.ansi, /old-output/);
    daemon.acknowledgeStream({
      connectionId: "renderer-b",
      sessionId: session.id,
      attachmentId: "workbench-b",
      generation: claimTwo.generation,
      cursor: reconnectSnapshot.snapshot.cursor,
    });
    fake.processes[1].emitData("z");
    fake.processes[1].emitExit({ exitCode: 9, signal: "SIGTERM" });
    await daemon.terminalHost.getSnapshot(session.id);
    const finalIndex = reconnectEvents.findIndex((event) => event.type === "terminal.delta" && event.chunk === "z");
    const exitIndex = reconnectEvents.findIndex((event) => event.type === "terminal.exit");
    assert.ok(finalIndex >= 0 && exitIndex > finalIndex, "final output must precede exit on the ordered stream");

    console.log("H0 PASS: ownership, generation fence, snapshot, ACK backpressure, reconnect, and exit ordering.");
  } finally {
    await daemon.stop();
  }
}

function latest(events, type) {
  const event = [...events].reverse().find((candidate) => candidate.type === type);
  assert.ok(event, `expected ${type}`);
  return event;
}

function createFakePty() {
  const calls = [];
  const processes = [];
  let nextPid = 800;
  return {
    calls,
    processes,
    pty: {
      spawn() {
        let onData = () => undefined;
        let onExit = () => undefined;
        const process = {
          pid: nextPid++,
          onData(listener) {
            onData = listener;
          },
          onExit(listener) {
            onExit = listener;
          },
          write(value) {
            calls.push(["write", process.pid, value]);
          },
          resize(cols, rows) {
            calls.push(["resize", process.pid, cols, rows]);
          },
          pause() {
            calls.push(["pause", process.pid]);
          },
          resume() {
            calls.push(["resume", process.pid]);
          },
          kill(signal) {
            calls.push(["kill", process.pid, signal]);
          },
          emitData(value) {
            onData(value);
          },
          emitExit(event) {
            onExit(event);
          },
        };
        processes.push(process);
        return process;
      },
    },
  };
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

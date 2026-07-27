const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const path = require("node:path");
const { connectTerminalControl, connectTerminalStream } = require("./runtime/orca-terminal-daemon-client.cjs");

async function main() {
  const child = childProcess.fork(path.join(__dirname, "runtime/orca-terminal-daemon-child.cjs"), [], {
    cwd: path.resolve(__dirname, ".."),
    silent: true,
  });
  let control;
  let controlTwo;
  let streamOne;
  let streamTwo;
  try {
    const endpoint = await waitForChildReady(child);
    control = await connectTerminalControl(endpoint);
    controlTwo = await connectTerminalControl(endpoint);
    const eventsOne = [];
    streamOne = await connectTerminalStream(endpoint, { onEvent: (event) => eventsOne.push(event) });
    const session = {
      id: "daemon:task-1:researcher",
      taskId: "task-1",
      command: process.execPath,
      args: [
        "-e",
        "setTimeout(() => process.stdout.write('first\\n'), 300); setTimeout(() => process.stdout.write('later\\n'), 650); setTimeout(() => process.exit(0), 950);",
      ],
      cwd: path.resolve(__dirname, ".."),
      cols: 100,
      rows: 30,
      requirePty: true,
    };
    const claim = { ownerId: "task-1/researcher", generation: "daemon-generation-1" };
    const created = await control.request("terminal.createOrAttach", { session, claim });
    assert.equal(created.disposition, "created");
    await streamOne.subscribe({ sessionId: session.id, attachmentId: "renderer-one", generation: claim.generation });
    const firstSnapshot = await waitForEvent(eventsOne, (event) => event.type === "terminal.snapshot");
    await streamOne.acknowledge({
      sessionId: session.id,
      attachmentId: "renderer-one",
      generation: claim.generation,
      cursor: firstSnapshot.snapshot.cursor,
    });
    await waitForEvent(eventsOne, (event) => event.type === "terminal.delta" && event.chunk.includes("first"));

    // A panel may disappear while the PTY remains owned by the daemon.
    streamOne.close();
    const eventsTwo = [];
    streamTwo = await connectTerminalStream(endpoint, { onEvent: (event) => eventsTwo.push(event) });
    await streamTwo.subscribe({ sessionId: session.id, attachmentId: "renderer-two", generation: claim.generation });
    const secondSnapshot = await waitForEvent(eventsTwo, (event) => event.type === "terminal.snapshot");
    assert.match(secondSnapshot.snapshot.ansi, /first/, "reconnected renderer must restore daemon-owned screen state");
    await streamTwo.acknowledge({
      sessionId: session.id,
      attachmentId: "renderer-two",
      generation: claim.generation,
      cursor: secondSnapshot.snapshot.cursor,
    });
    await waitForEvent(eventsTwo, (event) => event.type === "terminal.delta" && event.chunk.includes("later"));
    await waitForEvent(eventsTwo, (event) => event.type === "terminal.exit", 4_000);

    const deltas = eventsTwo.filter((event) => event.type === "terminal.delta");
    let cursor = secondSnapshot.snapshot.cursor;
    for (const delta of deltas) {
      assert.ok(delta.startCursor >= cursor, "stream must not replay an already-snapshotted delta");
      assert.equal(delta.cursor - delta.startCursor, Buffer.byteLength(delta.chunk, "utf8"));
      cursor = delta.cursor;
    }
    const exitIndex = eventsTwo.findIndex((event) => event.type === "terminal.exit");
    const lastDeltaIndex = eventsTwo.map((event) => event.type).lastIndexOf("terminal.delta");
    assert.ok(exitIndex > lastDeltaIndex, "the ordered stream must send final output before exit");

    const list = await controlTwo.request("terminal.list");
    assert.equal(list.length, 1, "both control clients see the daemon's single terminal owner");
    console.log("H1 PASS: child daemon RPC, two clients, stream reconnect, snapshot recovery, and ordered exit.");
  } finally {
    streamOne?.close();
    streamTwo?.close();
    control?.close();
    controlTwo?.close();
    await stopChild(child);
  }
}

function waitForChildReady(child, timeoutMs = 8_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("H1 daemon startup timed out")), timeoutMs);
    child.once("message", (message) => {
      clearTimeout(timer);
      if (message?.type === "terminal-daemon-ready") resolve(message.endpoint);
      else reject(new Error(message?.error ?? "H1 daemon failed before startup"));
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`H1 daemon exited before startup: ${code}`));
    });
  });
}

function waitForEvent(events, predicate, timeoutMs = 3_000) {
  const immediate = events.find(predicate);
  if (immediate) return Promise.resolve(immediate);
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const interval = setInterval(() => {
      const event = events.find(predicate);
      if (event) {
        clearInterval(interval);
        resolve(event);
      } else if (Date.now() >= deadline) {
        clearInterval(interval);
        reject(new Error("H1 timed out waiting for terminal stream event"));
      }
    }, 10);
  });
}

function stopChild(child) {
  if (child.exitCode !== null || child.killed) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => child.kill("SIGKILL"), 2_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    child.send?.({ type: "terminal-daemon-stop" });
  });
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

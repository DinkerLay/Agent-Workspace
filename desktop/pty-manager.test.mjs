import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createPtyManager } from "./pty-manager.cjs";
import { createSessionStore } from "./session-store.cjs";

const isVitest = process.env.VITEST === "true" || process.env.VITEST_WORKER_ID !== undefined;
const testApi = isVitest ? await import("vitest") : await import("node:test");
const { describe, it } = testApi;
const expect = isVitest ? testApi.expect : nodeExpect;

function nodeExpect(actual) {
  return {
    toBe(expected) {
      assert.strictEqual(actual, expected);
    },
    toEqual(expected) {
      assert.deepStrictEqual(actual, expected);
    },
    toHaveLength(expected) {
      assert.strictEqual(actual.length, expected);
    },
    toMatchObject(expected) {
      assert.partialDeepStrictEqual(actual, expected);
    },
    toThrow(expectedMessage) {
      assert.throws(actual, (error) => error instanceof Error && error.message.includes(expectedMessage));
    },
  };
}

function createFakePty() {
  const calls = [];
  let dataListener = () => undefined;
  let exitListener = () => undefined;
  const process = {
    pid: 123,
    onData(listener) {
      dataListener = listener;
    },
    onExit(listener) {
      exitListener = listener;
    },
    write(text) {
      calls.push(["write", text]);
    },
    resize(cols, rows) {
      calls.push(["resize", cols, rows]);
    },
    kill() {
      calls.push(["kill"]);
      exitListener({ exitCode: 0, signal: 0 });
    },
  };

  return {
    calls,
    emitData: (text) => dataListener(text),
    pty: {
      spawn(command, args, options) {
        calls.push(["spawn", command, args, options.cwd, options.cols, options.rows, options.env]);
        return process;
      },
    },
  };
}

function createAsyncExitFakePty() {
  const calls = [];
  const processes = [];
  let nextPid = 1000;

  return {
    calls,
    processes,
    pty: {
      spawn(command, args, options) {
        let dataListener = () => undefined;
        let exitListener = () => undefined;
        const process = {
          pid: nextPid++,
          onData(listener) {
            dataListener = listener;
          },
          onExit(listener) {
            exitListener = listener;
          },
          write(text) {
            calls.push(["write", process.pid, text]);
          },
          resize(cols, rows) {
            calls.push(["resize", process.pid, cols, rows]);
          },
          kill(signal) {
            calls.push(["kill", process.pid, signal]);
          },
          emitData(text) {
            dataListener(text);
          },
          emitExit(event = { exitCode: 0, signal: 0 }) {
            exitListener(event);
          },
        };
        processes.push(process);
        calls.push(["spawn", process.pid, command, args, options.cwd, options.cols, options.rows]);
        return process;
      },
    },
  };
}

describe("desktop PTY manager", () => {
  it("starts a native PTY session and records write, resize, output, and stop events", () => {
    const fake = createFakePty();
    const manager = createPtyManager({ pty: fake.pty });

    const session = manager.start({
      id: "pty-1",
      command: "opencode",
      args: ["--model", "opencode-go/deepseek-v4-flash"],
      cwd: "/Users/dinker/CODES/Agent-Workspace",
      cols: 120,
      rows: 32,
    });
    fake.emitData("opencode started\n");
    manager.write(session.id, "continue\n");
    manager.resize(session.id, { cols: 100, rows: 28 });
    manager.stop(session.id);

    expect(session).toMatchObject({
      id: "pty-1",
      command: "opencode",
      cwd: "/Users/dinker/CODES/Agent-Workspace",
      status: "running",
      cols: 120,
      rows: 32,
    });
    expect(manager.get(session.id)).toMatchObject({
      status: "stopped",
      transcript: ["opencode started\n"],
      cols: 100,
      rows: 28,
    });
    expect(fake.calls[0].slice(0, 6)).toEqual([
      "spawn",
      "opencode",
      ["--model", "opencode-go/deepseek-v4-flash"],
      "/Users/dinker/CODES/Agent-Workspace",
      120,
      32,
    ]);
    expect(fake.calls.slice(1)).toEqual([
      ["write", "continue\n"],
      ["resize", 100, 28],
      ["kill"],
    ]);
  });

  it("reads only transcript chunks after the caller cursor", () => {
    const fake = createFakePty();
    const manager = createPtyManager({ pty: fake.pty });

    const session = manager.start({
      id: "pty-delta",
      command: "opencode",
      cwd: "/Users/dinker/CODES/Agent-Workspace",
    });
    fake.emitData("first chunk\n");
    fake.emitData("second chunk\n");

    const firstRead = manager.read(session.id, 0);
    const secondRead = manager.read(session.id, firstRead.cursor);

    expect(firstRead).toMatchObject({
      id: "pty-delta",
      status: "running",
      cursor: 2,
      transcript: ["first chunk\n", "second chunk\n"],
    });
    expect(secondRead).toMatchObject({
      id: "pty-delta",
      cursor: 2,
      transcript: [],
    });
  });

  it("caps retained transcript bytes while preserving a monotonic cursor", () => {
    const fake = createFakePty();
    const manager = createPtyManager({ pty: fake.pty, maxOutputBytes: Buffer.byteLength("chunk-3\nchunk-4\nchunk-5\n") });

    const session = manager.start({
      id: "pty-retained-tail",
      command: "opencode",
      cwd: "/Users/dinker/CODES/Agent-Workspace",
    });
    fake.emitData("chunk-1\n");
    fake.emitData("chunk-2\n");
    fake.emitData("chunk-3\n");
    fake.emitData("chunk-4\n");
    fake.emitData("chunk-5\n");

    expect(manager.get(session.id)).toMatchObject({
      cursor: 5,
      transcript: ["chunk-3\n", "chunk-4\n", "chunk-5\n"],
    });
    expect(manager.read(session.id, 4)).toMatchObject({
      cursor: 5,
      transcript: ["chunk-5\n"],
    });
    expect(manager.read(session.id, 0)).toMatchObject({
      cursor: 5,
      transcript: ["chunk-3\n", "chunk-4\n", "chunk-5\n"],
    });
  });

  it("evicts stopped sessions after the configured retention window", () => {
    let now = 1_000;
    const fake = createFakePty();
    const manager = createPtyManager({
      pty: fake.pty,
      now: () => now,
      stoppedSessionRetentionMs: 500,
    });

    const session = manager.start({
      id: "pty-expire-stopped",
      command: "opencode",
      cwd: "/Users/dinker/CODES/Agent-Workspace",
    });
    fake.emitData("before stop\n");
    manager.stop(session.id);

    expect(manager.get(session.id)).toMatchObject({
      status: "stopped",
      transcript: ["before stop\n"],
    });

    now = 1_501;

    expect(manager.get(session.id)).toBe(undefined);
    expect(manager.list()).toEqual([]);
  });

  it("lists running sessions with task context for bridge-launched peers", () => {
    const fake = createFakePty();
    const manager = createPtyManager({ pty: fake.pty });

    manager.start({
      id: "task-1-conductor",
      taskId: "task-1",
      command: "opencode",
      args: ["--model", "opencode-go/deepseek-v4-flash"],
      cwd: "/repo/project",
    });

    expect(manager.list()).toHaveLength(1);
    expect(manager.list()[0]).toMatchObject({
      id: "task-1-conductor",
      taskId: "task-1",
      cwd: "/repo/project",
      args: ["--model", "opencode-go/deepseek-v4-flash"],
    });
  });

  it("emits streaming data events without waiting for read polling", () => {
    const fake = createFakePty();
    const events = [];
    const manager = createPtyManager({ pty: fake.pty });
    const unsubscribe = manager.onEvent((event) => events.push(event));

    const session = manager.start({
      id: "pty-stream",
      command: "opencode",
      cwd: "/Users/dinker/CODES/Agent-Workspace",
    });
    fake.emitData("first chunk\n");
    fake.emitData("second chunk\n");
    unsubscribe();
    fake.emitData("ignored after unsubscribe\n");

    expect(events).toEqual([
      {
        type: "data",
        id: session.id,
        chunk: "first chunk\n",
        cursor: 1,
        incarnationId: session.incarnationId,
        generation: session.generation,
      },
      {
        type: "data",
        id: session.id,
        chunk: "second chunk\n",
        cursor: 2,
        incarnationId: session.incarnationId,
        generation: session.generation,
      },
    ]);
    expect(manager.read(session.id, 0)).toMatchObject({
      cursor: 3,
      transcript: ["first chunk\n", "second chunk\n", "ignored after unsubscribe\n"],
    });
  });

  it("writes scoped runtime files and passes env overrides when starting a PTY", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-workspace-pty-"));
    const fake = createFakePty();
    const manager = createPtyManager({ pty: fake.pty });

    manager.start({
      id: "pty-injected",
      command: "opencode",
      cwd: tempDir,
      env: {
        OPENCODE_CONFIG_CONTENT: '{"instructions":[".agent-workspace/runtime/task/injection/system.md"]}',
      },
      runtimeFiles: [
        {
          relativePath: ".agent-workspace/runtime/task/injection/system.md",
          contents: "Agent Workspace runtime",
        },
      ],
    });

    expect(fs.readFileSync(path.join(tempDir, ".agent-workspace/runtime/task/injection/system.md"), "utf8")).toBe(
      "Agent Workspace runtime",
    );
    expect(fake.calls[0][6].OPENCODE_CONFIG_CONTENT).toBe(
      '{"instructions":[".agent-workspace/runtime/task/injection/system.md"]}',
    );
  });

  it("emits a stopped event when a PTY exits", () => {
    const fake = createFakePty();
    const events = [];
    const manager = createPtyManager({ pty: fake.pty });
    manager.onEvent((event) => events.push(event));

    const session = manager.start({
      id: "pty-exit-event",
      command: "opencode",
      cwd: "/Users/dinker/CODES/Agent-Workspace",
    });
    fake.emitData("before exit\n");
    manager.stop(session.id);

    expect(events).toEqual([
      {
        type: "data",
        id: session.id,
        chunk: "before exit\n",
        cursor: 1,
        incarnationId: session.incarnationId,
        generation: session.generation,
      },
      {
        type: "exit",
        id: session.id,
        status: "stopped",
        exitCode: 0,
        signal: 0,
        cursor: 1,
        incarnationId: session.incarnationId,
        generation: session.generation,
      },
    ]);
  });

  it("writes Shell Session Store records for PTY output", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-workspace-pty-store-"));
    const fake = createFakePty();
    const sessionStore = createSessionStore({ root: tempDir });
    const manager = createPtyManager({ pty: fake.pty, sessionStore });

    const session = manager.start({
      id: "task-1-researcher",
      taskId: "task-1",
      command: "opencode",
      cwd: tempDir,
      model: "opencode-go/deepseek-v4-flash",
    });
    fake.emitData("research output\n");

    const view = sessionStore.readSession({ taskId: "task-1", sessionId: session.id });

    expect(view.cleanTranscriptTail).toBe("");
    expect(view.events.map((event) => event.type)).toEqual(["session.started"]);
  });

  it("writes Shell Session Store records under the PTY project cwd when the store root is dynamic", () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "agent-workspace-pty-project-store-"));
    const projectPath = path.join(parent, "Agent_Test");
    fs.mkdirSync(projectPath, { recursive: true });
    const fake = createFakePty();
    const sessionStore = createSessionStore({
      root: ({ cwd }) => path.join(cwd, ".agent-workspace", "runtime"),
    });
    const manager = createPtyManager({ pty: fake.pty, sessionStore });

    const session = manager.start({
      id: "task-1-researcher",
      taskId: "task-1",
      command: "opencode",
      cwd: projectPath,
      model: "opencode-go/deepseek-v4-flash",
    });
    fake.emitData("research output from project cwd\n");

    const view = sessionStore.readSession({ taskId: "task-1", sessionId: session.id });

    expect(view.cleanTranscriptTail).toBe("");
    expect(
      fs.existsSync(
        path.join(projectPath, ".agent-workspace", "runtime", "task-1", "sessions", session.id, "transcript.clean.log"),
      ),
    ).toBe(false);
  });

  it("samples only raw PTY lifecycle without recording semantic Session Store state", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-workspace-pty-lifecycle-"));
    const fake = createFakePty();
    const sessionStore = createSessionStore({ root: tempDir });
    const manager = createPtyManager({ pty: fake.pty, sessionStore });

    const session = manager.start({
      id: "task-1-conductor",
      taskId: "task-1",
      command: "opencode",
      cwd: tempDir,
    });
    fake.emitData('Ask anything... "Fix a TODO in the codebase"\ntab agents ctrl+p commands');

    const status = manager.sampleStatus(session.id, { idleThresholdMs: 0 });
    const view = sessionStore.readSession({ taskId: "task-1", sessionId: session.id });

    expect(status).toMatchObject({ state: "running" });
    expect(view.events.map((event) => event.type)).toEqual(["session.started"]);
  });

  it("does not classify terminal error text as blocked session state", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-workspace-pty-no-text-classifier-"));
    const fake = createFakePty();
    const sessionStore = createSessionStore({ root: tempDir });
    const manager = createPtyManager({ pty: fake.pty, sessionStore });

    const session = manager.start({
      id: "task-1-reviewer",
      taskId: "task-1",
      command: "opencode",
      cwd: tempDir,
    });

    fake.emitData("Error: first failure\n");
    const firstStatus = manager.sampleStatus(session.id, { idleThresholdMs: 0 });
    fake.emitData("Error: still the same failure\n");
    const secondStatus = manager.sampleStatus(session.id, { idleThresholdMs: 0 });

    const view = sessionStore.readSession({ taskId: "task-1", sessionId: session.id });
    expect(firstStatus).toMatchObject({ state: "running" });
    expect(secondStatus).toMatchObject({ state: "running" });
    expect(view.events.map((event) => event.type)).toEqual(["session.started"]);
  });

  it("returns an existing running same-id session without spawning or truncating in-memory transcript", () => {
    const fake = createFakePty();
    const manager = createPtyManager({ pty: fake.pty });

    const firstSession = manager.start({
      id: "pty-duplicate",
      command: "opencode",
      cwd: "/Users/dinker/CODES/Agent-Workspace",
      cols: 120,
      rows: 32,
    });
    fake.emitData("first native output\n");

    const secondSession = manager.start({
      id: "pty-duplicate",
      command: "opencode",
      cwd: "/Users/dinker/CODES/Agent-Workspace",
      cols: 80,
      rows: 24,
    });

    expect(secondSession).toMatchObject({
      id: firstSession.id,
      pid: firstSession.pid,
      status: "running",
      cols: 120,
      rows: 32,
      transcript: ["first native output\n"],
    });
    expect(fake.calls.filter((call) => call[0] === "spawn")).toHaveLength(1);
    expect(firstSession.transcriptPath).toBe(undefined);
    expect(firstSession.metadataPath).toBe(undefined);
  });

  it("allows a same-id session to start again after the previous session stopped", () => {
    const fake = createFakePty();
    const manager = createPtyManager({ pty: fake.pty });

    const firstSession = manager.start({
      id: "pty-restart",
      command: "opencode",
      cwd: "/Users/dinker/CODES/Agent-Workspace",
    });
    manager.stop(firstSession.id);

    const secondSession = manager.start({
      id: "pty-restart",
      command: "opencode",
      cwd: "/Users/dinker/CODES/Agent-Workspace",
    });

    expect(secondSession).toMatchObject({
      id: "pty-restart",
      status: "running",
    });
    expect(fake.calls.filter((call) => call[0] === "spawn")).toHaveLength(2);
  });

  it("does not restart a same-id session while the previous process is stopping", () => {
    const fake = createAsyncExitFakePty();
    const manager = createPtyManager({ pty: fake.pty });

    const firstSession = manager.start({
      id: "pty-stopping",
      command: "opencode",
      cwd: "/Users/dinker/CODES/Agent-Workspace",
      cols: 120,
      rows: 32,
    });
    fake.processes[0].emitData("before stop\n");

    const stoppingSession = manager.stop(firstSession.id);
    const duplicateStart = manager.start({
      id: "pty-stopping",
      command: "opencode",
      cwd: "/Users/dinker/CODES/Agent-Workspace",
      cols: 80,
      rows: 24,
    });

    expect(stoppingSession).toMatchObject({
      id: firstSession.id,
      pid: firstSession.pid,
      status: "stopping",
    });
    expect(duplicateStart).toMatchObject({
      id: firstSession.id,
      pid: firstSession.pid,
      status: "stopping",
      transcript: ["before stop\n"],
    });
    expect(fake.calls.filter((call) => call[0] === "spawn")).toHaveLength(1);
    expect(firstSession.transcriptPath).toBe(undefined);
    expect(firstSession.metadataPath).toBe(undefined);

    fake.processes[0].emitData("late output\n");
    fake.processes[0].emitExit({ exitCode: 0, signal: 0 });

    expect(manager.get(firstSession.id)).toMatchObject({
      status: "stopped",
      pid: firstSession.pid,
      transcript: ["before stop\n", "late output\n"],
    });
  });

  it("keeps stop effective for a session that is already stopping", () => {
    const fake = createAsyncExitFakePty();
    const manager = createPtyManager({ pty: fake.pty });

    const session = manager.start({
      id: "pty-stuck-stopping",
      command: "opencode",
      cwd: "/Users/dinker/CODES/Agent-Workspace",
    });

    const firstStop = manager.stop(session.id);
    const secondStop = manager.stop(session.id);

    expect(firstStop).toMatchObject({ status: "stopping" });
    expect(secondStop).toMatchObject({ status: "stopping" });
    expect(fake.calls.filter((call) => call[0] === "kill")).toEqual([
      ["kill", session.pid, "SIGTERM"],
      ["kill", session.pid, "SIGKILL"],
    ]);
  });

  it("falls back to a child process backend when native PTY spawn is unavailable", () => {
    const calls = [];
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const child = new EventEmitter();
    child.stdout = stdout;
    child.stderr = stderr;
    child.pid = 456;
    child.stdin = {
      write(text) {
        calls.push(["stdin.write", text]);
      },
    };
    child.kill = () => {
      calls.push(["kill"]);
      child.emit("close", 0, null);
    };

    const manager = createPtyManager({
      pty: {
        spawn() {
          throw new Error("posix_spawnp failed.");
        },
      },
      spawn(command, args, options) {
        calls.push(["spawn-fallback", command, args, options.cwd]);
        return child;
      },
    });

    const session = manager.start({
      id: "pty-fallback",
      command: "/bin/echo",
      args: ["hello"],
      cwd: "/Users/dinker/CODES/Agent-Workspace",
    });
    stdout.emit("data", Buffer.from("hello\n"));
    stderr.emit("data", Buffer.from("warning\n"));
    manager.write(session.id, "input\n");
    manager.resize(session.id, { cols: 90, rows: 20 });
    manager.stop(session.id);

    expect(manager.get(session.id)).toMatchObject({
      backend: "process",
      status: "stopped",
      transcript: ["hello\n", "warning\n"],
      cols: 90,
      rows: 20,
    });
    expect(calls).toEqual([
      ["spawn-fallback", "/bin/echo", ["hello"], "/Users/dinker/CODES/Agent-Workspace"],
      ["stdin.write", "input\n"],
      ["kill"],
    ]);
  });

  it("does not fall back to a child process when an interactive PTY is required", () => {
    const manager = createPtyManager({
      pty: {
        spawn() {
          throw new Error("posix_spawnp failed.");
        },
      },
      spawn() {
        throw new Error("process fallback should not run");
      },
    });

    expect(() =>
      manager.start({
        id: "pty-requires-real-tty",
        command: "opencode",
        args: ["--model", "opencode-go/deepseek-v4-flash"],
        cwd: "/Users/dinker/CODES/Agent-Workspace",
        requirePty: true,
      }),
    ).toThrow("posix_spawnp failed.");
  });

  it("can ignore stdin for one-shot process fallback sessions", () => {
    const calls = [];
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const child = new EventEmitter();
    child.stdout = stdout;
    child.stderr = stderr;
    child.pid = 789;
    child.kill = () => undefined;

    const manager = createPtyManager({
      pty: {
        spawn() {
          throw new Error("posix_spawnp failed.");
        },
      },
      spawn(command, args, options) {
        calls.push(["spawn-fallback", command, args, options.stdio[0]]);
        return child;
      },
    });

    manager.start({
      id: "pty-one-shot",
      command: "opencode",
      args: ["run", "--format", "json", "hello"],
      cwd: "/Users/dinker/CODES/Agent-Workspace",
      stdin: "ignore",
    });

    expect(calls).toEqual([["spawn-fallback", "opencode", ["run", "--format", "json", "hello"], "ignore"]]);
  });

  it("does not persist pty-evidence transcript or metadata files", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-workspace-pty-"));
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const child = new EventEmitter();
    child.stdout = stdout;
    child.stderr = stderr;
    child.pid = 987;
    child.kill = () => child.emit("close", 0, null);

    const manager = createPtyManager({
      pty: {
        spawn() {
          throw new Error("posix_spawnp failed.");
        },
      },
      spawn() {
        return child;
      },
    });

    const session = manager.start({
      id: "pty-evidence",
      command: "opencode",
      args: ["run", "--format", "json", "hello"],
      cwd: "/Users/dinker/CODES/Agent-Workspace",
      stdin: "ignore",
    });
    stdout.emit("data", Buffer.from("hello from stdout\n"));
    stderr.emit("data", Buffer.from("warning from stderr\n"));
    child.emit("close", 0, null);

    const completed = manager.get(session.id);

    expect(completed).toMatchObject({
      status: "stopped",
      exitCode: 0,
      transcript: ["hello from stdout\n", "warning from stderr\n"],
    });
    expect(completed.transcriptPath).toBe(undefined);
    expect(completed.metadataPath).toBe(undefined);
    expect(fs.existsSync(path.join(tempRoot, "pty-evidence"))).toBe(false);
  });
});

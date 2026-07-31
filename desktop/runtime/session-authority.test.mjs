import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createSessionAuthority } = require("./session-authority.cjs");

const isVitest = process.env.VITEST === "true" || process.env.VITEST_WORKER_ID !== undefined;
const testApi = isVitest ? await import("vitest") : await import("node:test");
const { describe, it } = testApi;

describe("Session Authority", () => {
  it("does not accept an OpenCode TUI startup input before the terminal reaches the alternate buffer", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-workspace-session-authority-tui-ready-"));
    let live;
    const authority = createSessionAuthority({
      databasePath: path.join(root, "terminal.sqlite"),
      interactiveTuiStabilizeMs: 0,
      ptyManager: {
        async start(input) {
          live = {
            id: input.id,
            status: "running",
            incarnationId: input.incarnationId,
            generation: input.generation,
            bufferMode: "normal",
          };
          return live;
        },
        get: () => live,
        write: () => live,
        stop: () => live,
        read: () => undefined,
        resize: () => live,
      },
    });
    authority.registerLaunchProfile({
      workspaceSessionId: "opencode:task-1:conductor",
      taskId: "task-1",
      command: "/usr/local/bin/opencode",
      args: ["--agent", "conductor"],
      cwd: root,
    });

    let settled = false;
    const activation = authority.activateSession({
      workspaceSessionId: "opencode:task-1:conductor",
      callerId: "test",
      operationId: "tui-start-1",
      interactiveTui: true,
    }).then((result) => {
      settled = true;
      return result;
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, false, "a spawned PTY is not yet an input-ready TUI");

    live.bufferMode = "alternate";
    authority.handlePtyEvent({
      type: "data",
      id: live.id,
      incarnationId: live.incarnationId,
      generation: live.generation,
      bufferMode: "alternate",
    });
    const result = await activation;
    assert.equal(result.session.id, "opencode:task-1:conductor");
    authority.close();
  });

  it("waits for recovered OpenCode terminal output to settle before accepting interactive delivery", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-workspace-session-authority-composer-ready-"));
    let live;
    const authority = createSessionAuthority({
      databasePath: path.join(root, "terminal.sqlite"),
      interactiveTuiStabilizeMs: 0,
      ptyManager: {
        async start(input) {
          live = {
            id: input.id,
            status: "running",
            incarnationId: input.incarnationId,
            generation: input.generation,
            bufferMode: "normal",
          };
          return live;
        },
        get: () => live,
        write: () => live,
        stop: () => live,
        read: () => undefined,
        resize: () => live,
      },
    });
    authority.registerLaunchProfile({
      workspaceSessionId: "opencode:task-1:conductor",
      taskId: "task-1",
      command: "/usr/local/bin/opencode",
      args: ["--session", "ses_recovered"],
      cwd: root,
      interactiveReadyQuietMs: 60,
    });
    const startedAt = Date.now();
    const activation = authority.activateSession({
      workspaceSessionId: "opencode:task-1:conductor",
      callerId: "test",
      operationId: "composer-ready-1",
      interactiveTui: true,
    });
    live.bufferMode = "alternate";
    authority.handlePtyEvent({
      type: "data",
      id: live.id,
      incarnationId: live.incarnationId,
      generation: live.generation,
      bufferMode: "alternate",
    });
    await activation;
    assert.ok(Date.now() - startedAt >= 45, "the recovered route must settle after its latest terminal output");
    authority.close();
  });

  it("waits for OpenCode to render a pasted TUI message before submitting Return", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-workspace-session-authority-submit-"));
    const writes = [];
    let live;
    const authority = createSessionAuthority({
      databasePath: path.join(root, "terminal.sqlite"),
      interactiveTuiStabilizeMs: 0,
      ptyManager: {
        async start(input) {
          live = {
            id: input.id,
            status: "running",
            incarnationId: input.incarnationId,
            generation: input.generation,
            bufferMode: "alternate",
            cursor: 10,
          };
          return live;
        },
        get: () => live,
        write: (_id, payload) => { writes.push(payload); return live; },
        stop: () => live,
        read: () => undefined,
        resize: () => live,
      },
    });
    authority.registerLaunchProfile({
      workspaceSessionId: "opencode:task-1:conductor",
      taskId: "task-1",
      command: "/usr/local/bin/opencode",
      args: [],
      cwd: root,
    });
    const activation = await authority.activateSession({
      workspaceSessionId: "opencode:task-1:conductor",
      callerId: "test",
      operationId: "submit-1",
      interactiveTui: true,
    });

    const submission = authority.enqueueInteractiveSubmission({
      workspaceSessionId: activation.session.id,
      expectedIncarnationId: activation.session.incarnationId,
      source: "user_message",
      text: "Continue this task.",
      idempotencyKey: "user-1",
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(writes, ["\x1b[200~Continue this task.\x1b[201~"]);

    live.cursor = 11;
    authority.handlePtyEvent({
      type: "data",
      id: live.id,
      incarnationId: live.incarnationId,
      generation: live.generation,
      cursor: live.cursor,
      bufferMode: "alternate",
    });
    await submission;
    assert.deepEqual(writes, ["\x1b[200~Continue this task.\x1b[201~", "\r"]);
    authority.close();
  });

  it("waits for the authoritative exit fact before replacing a stopping terminal", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-workspace-session-authority-exit-"));
    let live;
    const authority = createSessionAuthority({
      databasePath: path.join(root, "terminal.sqlite"),
      ptyManager: {
        async start(input) {
          live = { id: input.id, status: "running", incarnationId: input.incarnationId, generation: input.generation };
          return live;
        },
        get: () => live,
        write: () => live,
        stop: () => live,
        read: () => undefined,
        resize: () => live,
      },
    });
    authority.registerLaunchProfile({
      workspaceSessionId: "opencode:task-1:conductor",
      taskId: "task-1",
      command: "/usr/local/bin/opencode",
      args: [],
      cwd: root,
    });
    const activation = await authority.activateSession({ workspaceSessionId: "opencode:task-1:conductor", callerId: "test", operationId: "exit-1" });
    live.status = "stopping";
    const exited = authority.waitForTerminalExit({
      workspaceSessionId: live.id,
      expectedIncarnationId: live.incarnationId,
      expectedGeneration: live.generation,
    });
    authority.handlePtyEvent({
      type: "exit",
      id: live.id,
      incarnationId: live.incarnationId,
      generation: live.generation,
      exitCode: 0,
      signal: 0,
    });
    const owner = await exited;
    assert.equal(owner.state, "stopped");
    assert.equal(owner.incarnationId, activation.session.incarnationId);
    authority.close();
  });

  it("retains a stopped owner fact across a Main-process restart", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-workspace-session-authority-"));
    const databasePath = path.join(root, "terminal.sqlite");
    let live;
    const firstPtyManager = {
      async start(input) {
        live = { id: input.id, status: "running", incarnationId: input.incarnationId, generation: input.generation };
        return live;
      },
      get: () => live,
      write: () => live,
      stop: () => live,
      read: () => undefined,
      resize: () => live,
    };
    const first = createSessionAuthority({ ptyManager: firstPtyManager, databasePath });
    first.registerLaunchProfile({
      workspaceSessionId: "opencode:task-1:publisher",
      taskId: "task-1",
      command: "/usr/local/bin/opencode",
      args: [],
      cwd: root,
    });
    const activation = await first.activateSession({
      workspaceSessionId: "opencode:task-1:publisher",
      callerId: "test",
      operationId: "start-1",
    });
    first.handlePtyEvent({
      type: "exit",
      id: activation.session.id,
      incarnationId: activation.session.incarnationId,
      generation: activation.session.generation,
      exitCode: 130,
    });
    first.close();

    const restarted = createSessionAuthority({
      ptyManager: {
        start: async () => { throw new Error("restart test must not create a new terminal"); },
        get: () => undefined,
        write: () => undefined,
        stop: () => undefined,
        read: () => undefined,
        resize: () => undefined,
      },
      databasePath,
    });
    const owner = restarted.readSessionOwner({ workspaceSessionId: "opencode:task-1:publisher" });

    assert.deepEqual(owner, {
      workspaceSessionId: "opencode:task-1:publisher",
      taskId: "task-1",
      ptyId: "opencode:task-1:publisher",
      incarnationId: activation.session.incarnationId,
      generation: activation.session.generation,
      state: "stopped",
      stoppedAt: owner.stoppedAt,
    });
    assert.ok(owner.stoppedAt);
    restarted.close();
  });

  it("retains an old terminal incarnation after recovery claims the same logical Session", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-workspace-session-authority-incarnation-history-"));
    const databasePath = path.join(root, "terminal.sqlite");
    let live;
    const first = createSessionAuthority({
      databasePath,
      ptyManager: {
        async start(input) {
          live = { id: input.id, status: "running", incarnationId: input.incarnationId, generation: input.generation };
          return live;
        },
        get: () => live,
        write: () => live,
        stop: () => live,
        read: () => undefined,
        resize: () => live,
      },
    });
    first.registerLaunchProfile({
      workspaceSessionId: "opencode:task-1:publisher",
      taskId: "task-1",
      command: "/usr/local/bin/opencode",
      args: ["--session", "ses-original"],
      cwd: root,
    });
    const original = await first.activateSession({ workspaceSessionId: "opencode:task-1:publisher", callerId: "test", operationId: "original" });
    first.close();

    // A new Electron Main process cannot own the old in-memory PTY. It sees no
    // local terminal and may therefore claim a recovery incarnation.
    let recoveredLive;
    const restarted = createSessionAuthority({
      databasePath,
      ptyManager: {
        async start(input) {
          recoveredLive = { id: input.id, status: "running", incarnationId: input.incarnationId, generation: input.generation };
          return recoveredLive;
        },
        get: () => recoveredLive,
        write: () => recoveredLive,
        stop: () => recoveredLive,
        read: () => undefined,
        resize: () => recoveredLive,
      },
    });
    const recovered = await restarted.activateSession({ workspaceSessionId: "opencode:task-1:publisher", callerId: "test", operationId: "recovery" });

    const current = restarted.readSessionOwner({ workspaceSessionId: "opencode:task-1:publisher" });
    const historic = restarted.readSessionOwner({
      workspaceSessionId: "opencode:task-1:publisher",
      incarnationId: original.session.incarnationId,
      generation: original.session.generation,
    });
    assert.equal(current.incarnationId, recovered.session.incarnationId);
    assert.equal(current.state, "active");
    assert.equal(historic.incarnationId, original.session.incarnationId);
    assert.equal(historic.generation, original.session.generation);
    assert.equal(historic.state, "stopped");
    restarted.close();
  });
});

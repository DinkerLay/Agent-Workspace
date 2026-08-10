"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  configureWorkbenchNavigation,
  createDesktopRuntimeComposition,
  resolveWorkbenchLoadTarget,
  runtimeConnectionFromEnvironment,
  scopeForWorkbenchIpcEvent,
} = require("./desktop-runtime-composition.cjs");

test("Desktop uses a configured authenticated Runtime Host without starting a second Host", async () => {
  let startedLocalHost = false;
  let bridged;
  const composition = await createDesktopRuntimeComposition({
    environment: {
      AGENT_WORKSPACE_RUNTIME_URL: "https://runtime.example.test/",
      AGENT_WORKSPACE_RUNTIME_TOKEN: "short_lived-token",
      AGENT_WORKSPACE_RUNTIME_ORIGIN: "agent-workspace://desktop",
    },
    bridgeFactory: (connection) => {
      bridged = connection;
      return { read() {}, command() {}, subscribe() {} };
    },
    supervisorFactory: () => {
      startedLocalHost = true;
      throw new Error("must not start local Host");
    },
  });

  assert.equal(composition.source, "external");
  assert.equal(startedLocalHost, false);
  assert.deepEqual(bridged, {
    baseUrl: "https://runtime.example.test",
    token: "short_lived-token",
    origin: "agent-workspace://desktop",
  });
  await composition.stop();
});

test("Desktop starts and owns the local Host when no remote bridge is configured", async () => {
  let supervisorOptions;
  let stopped = 0;
  const composition = await createDesktopRuntimeComposition({
    app: { getPath: (name) => name === "userData" ? "/Users/test/Library/Application Support/Agent Workspace" : undefined },
    environment: {},
    repositoryRoot: "/workspace",
    supervisorFactory: (options) => {
      supervisorOptions = options;
      return {
        start: async () => ({ baseUrl: "http://127.0.0.1:4242", token: "local_bridge-token" }),
        stop: async () => { stopped += 1; },
      };
    },
    bridgeFactory: (connection) => ({ connection }),
  });

  assert.equal(composition.source, "local");
  assert.equal(supervisorOptions.dataDirectory, "/Users/test/Library/Application Support/Agent Workspace/runtime");
  assert.equal(supervisorOptions.repositoryRoot, "/workspace");
  assert.deepEqual(composition.runtimeBridge.connection, { baseUrl: "http://127.0.0.1:4242", token: "local_bridge-token" });
  await composition.stop();
  assert.equal(stopped, 1);
});

test("Desktop resolves only the root production Workbench artifact and guards renderer navigation", () => {
  const local = resolveWorkbenchLoadTarget({ repositoryRoot: "/workspace", existsSync: (value) => value === "/workspace/dist/workbench/index.html" });
  assert.deepEqual(local, { kind: "file", filePath: "/workspace/dist/workbench/index.html" });
  assert.throws(
    () => runtimeConnectionFromEnvironment({ AGENT_WORKSPACE_RUNTIME_URL: "http://127.0.0.1:4312" }),
    /runtime_host_connection_incomplete/,
  );

  const handlers = new Map();
  let windowOpenHandler;
  configureWorkbenchNavigation({
    on: (event, handler) => handlers.set(event, handler),
    setWindowOpenHandler: (handler) => { windowOpenHandler = handler; },
  }, { kind: "url", url: "https://workbench.example.test/", origin: "https://workbench.example.test" });

  const sameOrigin = preventableEvent();
  handlers.get("will-navigate")(sameOrigin, "https://workbench.example.test/tasks/task_1");
  assert.equal(sameOrigin.prevented, false);
  const foreignOrigin = preventableEvent();
  handlers.get("will-navigate")(foreignOrigin, "https://attacker.example.test/");
  assert.equal(foreignOrigin.prevented, true);
  const webview = preventableEvent();
  handlers.get("will-attach-webview")(webview);
  assert.equal(webview.prevented, true);
  const nestedForeignFrame = preventableEvent();
  handlers.get("will-frame-navigate")(nestedForeignFrame, "https://attacker.example.test/frame");
  assert.equal(nestedForeignFrame.prevented, true);
  assert.deepEqual(windowOpenHandler(), { action: "deny" });

  assert.deepEqual(
    scopeForWorkbenchIpcEvent({ sender: { id: 42 }, senderFrame: { url: "https://workbench.example.test/tasks/task_1" } }, { kind: "url", origin: "https://workbench.example.test" }),
    { transport: "desktop-ipc", webContentsId: 42 },
  );
  assert.throws(
    () => scopeForWorkbenchIpcEvent({ sender: { id: 42 }, senderFrame: { url: "https://attacker.example.test/" } }, { kind: "url", origin: "https://workbench.example.test" }),
    /runtime_ipc_origin_denied/,
  );
});

function preventableEvent() {
  return {
    prevented: false,
    preventDefault() {
      this.prevented = true;
    },
  };
}

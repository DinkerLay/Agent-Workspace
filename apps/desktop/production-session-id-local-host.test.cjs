"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");
const { createDesktopShell } = require("./main.cjs");

test("production Desktop starts one supervised unified Host when no external connection is configured", async () => {
  const harness = electronHarness();
  let supervisorOptions;
  let stopped = 0;
  let connection;
  const shell = createDesktopShell({
    electronRuntime: harness.electron,
    environment: {},
    repositoryRoot: "/workspace",
    existsSync: (value) => value === "/workspace/dist/workbench/index.html",
    supervisorFactory: (options) => {
      supervisorOptions = options;
      return {
        start: async () => ({ baseUrl: "http://127.0.0.1:4321", token: "desktop-token-0123456789" }),
        stop: async () => { stopped += 1; },
      };
    },
    runtimePortFactory: (value) => {
      connection = value;
      return {
        readWorkspace: async () => ({}), readTask: async () => ({}), readConfiguration: async () => ({}),
        command: async () => ({}), subscribe: async () => () => undefined, close: async () => undefined,
      };
    },
  });

  await shell.start();
  assert.deepEqual(supervisorOptions, {
    dataDirectory: "/user-data/session-id-runtime",
    repositoryRoot: "/workspace",
    environment: {},
    allowedOrigins: [],
  });
  assert.deepEqual(connection, { baseUrl: "http://127.0.0.1:4321", token: "desktop-token-0123456789" });
  await shell.stop();
  assert.equal(stopped, 1);
});

function electronHarness() {
  const app = new EventEmitter();
  app.whenReady = async () => undefined;
  app.getPath = (name) => name === "userData" ? "/user-data" : undefined;
  app.quit = () => undefined;
  class BrowserWindow extends EventEmitter {
    static getAllWindows() { return []; }
    constructor(options) {
      super();
      this.options = options;
      this.webContents = new EventEmitter();
      this.webContents.id = 1;
      this.webContents.setWindowOpenHandler = () => undefined;
      this.webContents.isDestroyed = () => false;
      this.webContents.send = () => undefined;
    }
    async loadFile(value) { this.loadedFile = value; }
    isDestroyed() { return false; }
    focus() {}
  }
  return {
    electron: {
      app,
      BrowserWindow,
      ipcMain: { handle: () => undefined, removeHandler: () => undefined },
    },
  };
}

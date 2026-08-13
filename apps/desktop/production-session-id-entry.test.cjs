"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const test = require("node:test");

test("production Electron entry composes only one unified Host facade", () => {
  const files = [
    "main.cjs",
    "preload.cjs",
    "runtime-host-supervisor.cjs",
    "session-id-root-runtime-host-client.cjs",
    "session-id-root-runtime-ipc.cjs",
  ].map((file) => readFileSync(path.join(__dirname, file), "utf8")).join("\n");

  assert.match(files, /sessionIdRuntime/);
  assert.match(files, /AGENT_WORKSPACE_RUNTIME_DESKTOP_TOKEN/);
  assert.match(files, /runtime\/session-id\/workspace\/read/);
  assert.match(files, /agent-workspace:session-id-root:command/);
  assert.doesNotMatch(files, /sessionIdRuntimeCandidate|session-id-root-(?:main|preload|runtime-host-client|runtime-ipc)-candidate/);
  assert.doesNotMatch(files, /createDesktopRuntimeComposition|registerRuntimeIpcFacade|agent-workspace:runtime:(?:read|command|subscribe)/);
  assert.doesNotMatch(files, /AGENT_WORKSPACE_RUNTIME_MODE|legacy/);
});

test("production Electron loads only the formal dist/workbench artifact", () => {
  const main = require("./main.cjs");
  assert.deepEqual(main.resolveWorkbenchTarget({
    environment: {},
    repositoryRoot: "/workspace",
    existsSync: (value) => value === "/workspace/dist/workbench/index.html",
  }), {
    kind: "file",
    filePath: "/workspace/dist/workbench/index.html",
  });
});

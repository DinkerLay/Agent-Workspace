"use strict";

const assert = require("node:assert/strict");
const { mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createRuntimeHostSupervisor } = require("./runtime-host-supervisor.cjs");
const { createSessionIdRootRuntimeHostPort } = require("./session-id-root-runtime-host-client.cjs");

test("production Desktop supervisor launches the real default unified Host process", { timeout: 30_000 }, async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "agent-workspace-desktop-unified-host-"));
  const supervisor = createRuntimeHostSupervisor({
    dataDirectory: directory,
    repositoryRoot: path.resolve(__dirname, "..", ".."),
    environment: { PATH: process.env.PATH },
  });
  let port;
  try {
    const connection = await supervisor.start();
    port = createSessionIdRootRuntimeHostPort(connection);
    const workspace = await port.readWorkspace();
    assert.deepEqual(workspace.tasks, []);
    assert.deepEqual(workspace.taskSetupOptions.workspaces, []);
  } finally {
    await port?.close?.();
    await supervisor.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});

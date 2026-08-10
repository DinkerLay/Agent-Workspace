"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");
const { createRuntimeHostSupervisor, parseLauncherArgs } = require("./runtime-host-supervisor.cjs");

test("Desktop HostSupervisor starts a separate loopback Runtime Host with an ephemeral bridge token and stops it", async () => {
  const child = createChild();
  const spawned = [];
  const supervisor = createRuntimeHostSupervisor({
    dataDirectory: "/tmp/agent-workspace-desktop-runtime",
    repositoryRoot: "/workspace",
    environment: { KEEP_THIS: "yes" },
    launcher: { command: "/bundle/runtime-host", args: ["--stdio"], electronRunAsNode: false },
    randomBytes: (size) => Buffer.alloc(size, 7),
    spawn: (command, args, options) => {
      spawned.push({ command, args, options });
      return child;
    },
  });

  const starting = supervisor.start();
  child.stdout.emit("data", '{"type":"runtime_host_ready","url":"http://127.0.0.1:49321"}\n');
  const connection = await starting;

  assert.deepEqual(connection, { baseUrl: "http://127.0.0.1:49321", token: Buffer.alloc(32, 7).toString("base64url") });
  assert.deepEqual(spawned, [{
    command: "/bundle/runtime-host",
    args: ["--stdio"],
    options: {
      cwd: "/workspace",
      env: {
        KEEP_THIS: "yes",
        AGENT_WORKSPACE_RUNTIME_DATA_DIR: "/tmp/agent-workspace-desktop-runtime",
        AGENT_WORKSPACE_RUNTIME_PORT: "0",
        AGENT_WORKSPACE_RUNTIME_TOKEN: Buffer.alloc(32, 7).toString("base64url"),
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  }]);

  await supervisor.stop();
  assert.deepEqual(child.kills, ["SIGTERM"]);
  assert.equal(supervisor.getConnection(), undefined);
});

test("HostSupervisor launcher arguments are explicit JSON rather than a shell command string", () => {
  assert.deepEqual(parseLauncherArgs('["--port","0"]'), ["--port", "0"]);
  assert.throws(() => parseLauncherArgs("--port 0"), /runtime_host_launcher_args_invalid/);
});

function createChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdout.setEncoding = () => undefined;
  child.stderr.setEncoding = () => undefined;
  child.exitCode = null;
  child.killed = false;
  child.kills = [];
  child.kill = (signal) => {
    child.killed = true;
    child.kills.push(signal);
    child.exitCode = 0;
    queueMicrotask(() => child.emit("exit", 0, signal));
    return true;
  };
  return child;
}

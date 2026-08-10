import assert from "node:assert/strict";
import test from "node:test";
import {
  createElectronEnvironment,
  findAvailablePort,
  parseLaunchMode,
  parseRuntimeReady,
  readPort,
} from "./formal-dev.mjs";

test("formal launcher accepts the desktop and browser-only forms", () => {
  assert.equal(parseLaunchMode([]), "desktop");
  assert.equal(parseLaunchMode(["--web"]), "web");
  assert.throws(() => parseLaunchMode(["--unknown"]), /formal_dev_usage/);
});

test("formal launcher validates ports and skips unavailable candidates", async () => {
  assert.equal(readPort(undefined, 5188, "AGENT_WORKSPACE_PORT"), 5188);
  assert.equal(readPort("5191", 5188, "AGENT_WORKSPACE_PORT"), 5191);
  assert.throws(() => readPort("not-a-port", 5188, "AGENT_WORKSPACE_PORT"), /AGENT_WORKSPACE_PORT_invalid/);
  assert.equal(await findAvailablePort(5188, 4, async (port) => port === 5190), 5190);
  await assert.rejects(() => findAvailablePort(5188, 2, async () => false), /formal_dev_no_available_port/);
});

test("formal launcher accepts only a loopback Runtime Host readiness record", () => {
  assert.deepEqual(
    parseRuntimeReady('{"type":"runtime_host_ready","url":"http://127.0.0.1:4312","port":4312}'),
    { url: "http://127.0.0.1:4312", port: 4312 },
  );
  assert.equal(parseRuntimeReady('{"type":"runtime_host_ready","url":"http://runtime.example.test:4312","port":4312}'), undefined);
  assert.equal(parseRuntimeReady("not-json"), undefined);
});

test("formal Electron receives the single external Runtime Host connection and formal workbench URL", () => {
  const environment = createElectronEnvironment({
    baseEnvironment: { KEEP: "value", AGENT_WORKSPACE_WORKBENCH_URL: "http://old.example.test/" },
    runtime: { url: "http://127.0.0.1:4312", port: 4312, token: "bridge-token" },
    workbenchUrl: "http://127.0.0.1:5188/",
  });
  assert.deepEqual(environment, {
    KEEP: "value",
    AGENT_WORKSPACE_WORKBENCH_URL: "http://127.0.0.1:5188/",
    AGENT_WORKSPACE_RUNTIME_URL: "http://127.0.0.1:4312",
    AGENT_WORKSPACE_RUNTIME_TOKEN: "bridge-token",
    AGENT_WORKSPACE_RUNTIME_ORIGIN: "http://127.0.0.1:5188/",
  });
});

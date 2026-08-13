import assert from "node:assert/strict";
import test from "node:test";
import {
  createAcpHostEpochLaunchEnvironment,
  createElectronEnvironment,
  createRuntimeTokens,
  findAvailablePort,
  parseLaunchMode,
  parseRuntimeReady,
  readPort,
} from "./formal-dev.mjs";

test("formal launcher gives the Runtime child one fresh ACP Host epoch and no ambient recovery proof", () => {
  const environment = createAcpHostEpochLaunchEnvironment({
    KEEP: "value",
    AGENT_WORKSPACE_ACP_HOST_EPOCH: "host_epoch_ambient_must_not_cross",
    AGENT_WORKSPACE_ACP_HOST_EPOCH_PUBLIC_KEY: "ambient-public-key-must-not-cross",
    AGENT_WORKSPACE_ACP_HOST_EPOCH_RECOVERY_PROOF: "ambient-proof-must-not-cross",
  }, () => "host_epoch_formal_launcher_0001", () => "A".repeat(48));

  assert.deepEqual(environment, {
    KEEP: "value",
    AGENT_WORKSPACE_ACP_HOST_EPOCH: "host_epoch_formal_launcher_0001",
    AGENT_WORKSPACE_ACP_HOST_EPOCH_PUBLIC_KEY: "A".repeat(48),
  });
  assert.equal(Object.isFrozen(environment), true);
  assert.equal("AGENT_WORKSPACE_ACP_HOST_EPOCH_RECOVERY_PROOF" in environment, false);
  assert.throws(
    () => createAcpHostEpochLaunchEnvironment({}, () => "ambient", () => "short"),
    /formal_dev_acp_host_epoch_invalid/u,
  );
});

test("formal launcher generates three distinct class-scoped Runtime tokens", () => {
  let sequence = 0;
  assert.deepEqual(createRuntimeTokens({}, () => `generated-token-${++sequence}-0123456789`), {
    browserToken: "generated-token-1-0123456789",
    desktopToken: "generated-token-2-0123456789",
    evidenceToken: "generated-token-3-0123456789",
  });
  assert.throws(() => createRuntimeTokens({
    AGENT_WORKSPACE_RUNTIME_TOKEN: "same-token-0123456789",
    AGENT_WORKSPACE_RUNTIME_DESKTOP_TOKEN: "same-token-0123456789",
    AGENT_WORKSPACE_RUNTIME_EVIDENCE_TOKEN: "evidence-token-0123456789",
  }), /formal_dev_runtime_tokens_invalid/);
});

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
    baseEnvironment: {
      KEEP: "value",
      AGENT_WORKSPACE_WORKBENCH_URL: "http://old.example.test/",
      AGENT_WORKSPACE_RUNTIME_TOKEN: "must-not-enter-electron",
      AGENT_WORKSPACE_RUNTIME_EVIDENCE_TOKEN: "must-not-enter-electron",
      AGENT_WORKSPACE_RUNTIME_ALLOWED_ORIGINS: "must-not-enter-electron",
    },
    runtime: {
      url: "http://127.0.0.1:4312",
      port: 4312,
      browserToken: "browser-bridge-token",
      desktopToken: "desktop-bridge-token",
    },
    workbenchUrl: "http://127.0.0.1:5188/",
  });
  assert.deepEqual(environment, {
    KEEP: "value",
    AGENT_WORKSPACE_WORKBENCH_URL: "http://127.0.0.1:5188/",
    AGENT_WORKSPACE_RUNTIME_URL: "http://127.0.0.1:4312",
    AGENT_WORKSPACE_RUNTIME_DESKTOP_TOKEN: "desktop-bridge-token",
    AGENT_WORKSPACE_RUNTIME_ORIGIN: "http://127.0.0.1:5188/",
  });
  assert.equal("AGENT_WORKSPACE_RUNTIME_TOKEN" in environment, false);
  assert.equal("AGENT_WORKSPACE_RUNTIME_EVIDENCE_TOKEN" in environment, false);
  assert.equal("AGENT_WORKSPACE_RUNTIME_ALLOWED_ORIGINS" in environment, false);
});

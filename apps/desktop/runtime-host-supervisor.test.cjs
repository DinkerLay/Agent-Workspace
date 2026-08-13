"use strict";

const assert = require("node:assert/strict");
const { createPublicKey, verify } = require("node:crypto");
const { EventEmitter } = require("node:events");
const { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const test = require("node:test");
const { createRuntimeHostSupervisor, parseLauncherArgs } = require("./runtime-host-supervisor.cjs");

test("Desktop HostSupervisor starts the unified local Host with three class-scoped tokens and returns only Desktop auth", async () => {
  const child = createChild();
  const spawned = [];
  let randomSequence = 0;
  const supervisor = createRuntimeHostSupervisor({
    dataDirectory: "/tmp/agent-workspace-desktop-runtime",
    repositoryRoot: "/workspace",
    environment: {
      KEEP_THIS: "yes",
      AGENT_WORKSPACE_ACP_HOST_EPOCH_RECOVERY_PROOF: "ambient-proof-must-not-cross",
    },
    allowedOrigins: ["http://127.0.0.1:5191"],
    rendererOrigin: "http://127.0.0.1:5191",
    launcher: { command: "/bundle/runtime-host", args: ["--stdio"], electronRunAsNode: false },
    randomBytes: (size) => Buffer.alloc(size, ++randomSequence),
    spawn: (command, args, options) => {
      spawned.push({ command, args, options });
      return child;
    },
  });

  const starting = supervisor.start();
  child.stdout.emit("data", '{"type":"runtime_host_ready","url":"http://127.0.0.1:49321"}\n');
  const connection = await starting;

  const browserToken = Buffer.alloc(32, 1).toString("base64url");
  const desktopToken = Buffer.alloc(32, 2).toString("base64url");
  const evidenceToken = Buffer.alloc(32, 3).toString("base64url");
  assert.deepEqual(connection, {
    baseUrl: "http://127.0.0.1:49321",
    token: desktopToken,
    origin: "http://127.0.0.1:5191",
  });
  assert.equal(spawned.length, 1);
  const {
    AGENT_WORKSPACE_ACP_HOST_EPOCH: hostEpoch,
    AGENT_WORKSPACE_ACP_HOST_EPOCH_PUBLIC_KEY: hostEpochPublicKey,
    ...spawnedEnvironment
  } = spawned[0].options.env;
  assert.match(hostEpoch, /^host_epoch_[A-Za-z0-9_-]{8,256}$/u);
  assert.match(hostEpochPublicKey, /^[A-Za-z0-9_-]{32,}$/u);
  assert.deepEqual([{ ...spawned[0], options: { ...spawned[0].options, env: spawnedEnvironment } }], [{
    command: "/bundle/runtime-host",
    args: ["--stdio"],
    options: {
      cwd: "/workspace",
      env: {
        KEEP_THIS: "yes",
        AGENT_WORKSPACE_RUNTIME_DATA_DIR: "/tmp/agent-workspace-desktop-runtime",
        AGENT_WORKSPACE_RUNTIME_PORT: "0",
        AGENT_WORKSPACE_RUNTIME_TOKEN: browserToken,
        AGENT_WORKSPACE_RUNTIME_DESKTOP_TOKEN: desktopToken,
        AGENT_WORKSPACE_RUNTIME_EVIDENCE_TOKEN: evidenceToken,
        AGENT_WORKSPACE_RUNTIME_ALLOWED_ORIGINS: '["http://127.0.0.1:5191"]',
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  }]);

  await supervisor.stop();
  assert.deepEqual(child.kills, ["SIGTERM"]);
  assert.equal(supervisor.getConnection(), undefined);
});

test("Desktop HostSupervisor fails closed when token generation is not class-distinct", async () => {
  const child = createChild();
  const supervisor = createRuntimeHostSupervisor({
    dataDirectory: "/tmp/agent-workspace-desktop-runtime",
    repositoryRoot: "/workspace",
    launcher: { command: "/bundle/runtime-host", args: [], electronRunAsNode: false },
    randomBytes: (size) => Buffer.alloc(size, 7),
    spawn: () => child,
  });
  await assert.rejects(() => supervisor.start(), /runtime_host_token_generation_failed/);
});

test("HostSupervisor launcher arguments are explicit JSON rather than a shell command string", () => {
  assert.deepEqual(parseLauncherArgs('["--port","0"]'), ["--port", "0"]);
  assert.throws(() => parseLauncherArgs("--port 0"), /runtime_host_launcher_args_invalid/);
});

test("Desktop HostSupervisor issues a recovery proof only after confirming the previous Host exit", async () => {
  const runtimeRoot = mkdtempSync(path.join(tmpdir(), "agent-workspace-desktop-host-epoch-"));
  chmodSync(runtimeRoot, 0o700);
  const children = [createChild(), createChild()];
  const launches = [];
  let randomSequence = 20;
  try {
    const supervisor = createRuntimeHostSupervisor({
      dataDirectory: runtimeRoot,
      repositoryRoot: "/workspace",
      environment: {},
      launcher: { command: "/bundle/runtime-host", args: [], electronRunAsNode: false },
      randomBytes: (size) => Buffer.alloc(size, ++randomSequence),
      spawn: (_command, _args, options) => {
        const child = children[launches.length];
        launches.push(options.env);
        if (launches.length === 1) {
          writeFileSync(
            path.join(runtimeRoot, ".acp-host-epoch.lease"),
            `${JSON.stringify({
              schemaVersion: 1,
              hostEpoch: options.env.AGENT_WORKSPACE_ACP_HOST_EPOCH,
            })}\n`,
            { mode: 0o600 },
          );
        }
        return child;
      },
    });

    const firstStart = supervisor.start();
    children[0].stdout.emit("data", '{"type":"runtime_host_ready","url":"http://127.0.0.1:49321"}\n');
    await firstStart;
    assert.match(launches[0].AGENT_WORKSPACE_ACP_HOST_EPOCH, /^host_epoch_[A-Za-z0-9_-]{8,256}$/u);
    assert.equal(launches[0].AGENT_WORKSPACE_ACP_HOST_EPOCH_RECOVERY_PROOF, undefined);

    await supervisor.stop();
    const secondStart = supervisor.start();
    children[1].stdout.emit("data", '{"type":"runtime_host_ready","url":"http://127.0.0.1:49322"}\n');
    await secondStart;
    assert.notEqual(
      launches[1].AGENT_WORKSPACE_ACP_HOST_EPOCH,
      launches[0].AGENT_WORKSPACE_ACP_HOST_EPOCH,
    );
    assert.match(launches[1].AGENT_WORKSPACE_ACP_HOST_EPOCH_PUBLIC_KEY, /^[A-Za-z0-9_-]{32,}$/u);
    assert.match(launches[1].AGENT_WORKSPACE_ACP_HOST_EPOCH_RECOVERY_PROOF, /^[A-Za-z0-9_-]{32,}$/u);
    const envelope = JSON.parse(Buffer.from(
      launches[1].AGENT_WORKSPACE_ACP_HOST_EPOCH_RECOVERY_PROOF,
      "base64url",
    ).toString("utf8"));
    const payload = Buffer.from(envelope.payload, "base64url");
    assert.equal(verify(
      null,
      payload,
      createPublicKey({
        key: Buffer.from(launches[1].AGENT_WORKSPACE_ACP_HOST_EPOCH_PUBLIC_KEY, "base64url"),
        format: "der",
        type: "spki",
      }),
      Buffer.from(envelope.signature, "base64url"),
    ), true);
    const signedPayload = JSON.parse(payload.toString("utf8"));
    assert.equal(signedPayload.schemaVersion, 1);
    assert.match(signedPayload.runtimeRootDigest, /^[a-f0-9]{64}$/u);
    assert.equal(signedPayload.deadHostEpoch, launches[0].AGENT_WORKSPACE_ACP_HOST_EPOCH);
    assert.equal(signedPayload.newHostEpoch, launches[1].AGENT_WORKSPACE_ACP_HOST_EPOCH);
    assert.match(signedPayload.nonce, /^[A-Za-z0-9_-]{16,256}$/u);
    await supervisor.stop();
  } finally {
    rmSync(runtimeRoot, { recursive: true, force: true });
  }
});

test("Desktop HostSupervisor never signs recovery or reports stop when child exit is unconfirmed", async () => {
  const runtimeRoot = mkdtempSync(path.join(tmpdir(), "agent-workspace-desktop-host-unconfirmed-"));
  chmodSync(runtimeRoot, 0o700);
  const child = createChild({ ignoreSignals: true });
  try {
    const supervisor = createRuntimeHostSupervisor({
      dataDirectory: runtimeRoot,
      repositoryRoot: "/workspace",
      environment: {},
      launcher: { command: "/bundle/runtime-host", args: [], electronRunAsNode: false },
      stopTimeoutMs: 10,
      spawn: () => child,
    });
    const starting = supervisor.start();
    child.stdout.emit("data", '{"type":"runtime_host_ready","url":"http://127.0.0.1:49321"}\n');
    await starting;

    await assert.rejects(() => supervisor.stop(), /runtime_host_stop_unconfirmed/u);
    assert.deepEqual(child.kills, ["SIGTERM", "SIGKILL"]);
    await assert.rejects(() => supervisor.start(), /runtime_host_previous_process_exit_unconfirmed/u);
  } finally {
    rmSync(runtimeRoot, { recursive: true, force: true });
  }
});

test("Desktop HostSupervisor retains a timed-out startup child until its exit is confirmed", async () => {
  const runtimeRoot = mkdtempSync(path.join(tmpdir(), "agent-workspace-desktop-host-startup-timeout-"));
  chmodSync(runtimeRoot, 0o700);
  const child = createChild({ ignoreSignals: true });
  let spawns = 0;
  try {
    const supervisor = createRuntimeHostSupervisor({
      dataDirectory: runtimeRoot,
      repositoryRoot: "/workspace",
      environment: {},
      launcher: { command: "/bundle/runtime-host", args: [], electronRunAsNode: false },
      startTimeoutMs: 10,
      stopTimeoutMs: 10,
      spawn: () => {
        spawns += 1;
        return child;
      },
    });

    await assert.rejects(() => supervisor.start(), /runtime_host_start_cleanup_unconfirmed/u);
    assert.deepEqual(child.kills, ["SIGTERM", "SIGKILL"]);
    await assert.rejects(() => supervisor.start(), /runtime_host_previous_process_exit_unconfirmed/u);
    assert.equal(spawns, 1);
  } finally {
    rmSync(runtimeRoot, { recursive: true, force: true });
  }
});

test("Desktop HostSupervisor refuses an inherited stale epoch without its own confirmed-exit lineage", async () => {
  const runtimeRoot = mkdtempSync(path.join(tmpdir(), "agent-workspace-desktop-host-stale-"));
  chmodSync(runtimeRoot, 0o700);
  writeFileSync(
    path.join(runtimeRoot, ".acp-host-epoch.lease"),
    `${JSON.stringify({ schemaVersion: 1, hostEpoch: "host_epoch_unknown_previous" })}\n`,
    { mode: 0o600 },
  );
  let spawns = 0;
  try {
    const supervisor = createRuntimeHostSupervisor({
      dataDirectory: runtimeRoot,
      repositoryRoot: "/workspace",
      environment: {},
      launcher: { command: "/bundle/runtime-host", args: [], electronRunAsNode: false },
      spawn: () => {
        spawns += 1;
        return createChild();
      },
    });
    await assert.rejects(() => supervisor.start(), /runtime_host_acp_epoch_recovery_unconfirmed/u);
    assert.equal(spawns, 0);
  } finally {
    rmSync(runtimeRoot, { recursive: true, force: true });
  }
});

test("Desktop HostSupervisor proof lets a fresh real Host recover only its Task private binding map", async () => {
  const runtimeRoot = mkdtempSync(path.join(tmpdir(), "agent-workspace-desktop-host-process-recovery-"));
  chmodSync(runtimeRoot, 0o700);
  const auditLog = path.join(runtimeRoot, "test-process-recovery.log");
  const moduleUrl = pathToFileURL(path.join(
    process.cwd(),
    "apps/runtime-host/src/acp-runtime-host-private-authority.ts",
  )).href;
  const source = [
    `import { appendFileSync } from "node:fs";`,
    `import { createAcpRuntimeHostPrivateAuthority } from ${JSON.stringify(moduleUrl)};`,
    `const authority = createAcpRuntimeHostPrivateAuthority({`,
    `  runtimeDataDirectory: process.env.AGENT_WORKSPACE_RUNTIME_DATA_DIR,`,
    `  environment: process.env,`,
    `});`,
    `const recovery = authority.recoveryObservation();`,
    `const vault = authority.taskIdentityVaults({`,
    `  profileRevisionId: "profile_revision_cross_process",`,
    `  profileResolutionFingerprint: "sha256:${"a".repeat(64)}",`,
    `});`,
    `let recoveredRawMatched = false;`,
    `if (recovery.state === "fresh") {`,
    `  vault.bindNew({`,
    `    bindingHandle: "binding_handle_cross_process",`,
    `    generationId: "generation_cross_process_a",`,
    `    rawSessionId: "raw-cross-process-session",`,
    `  });`,
    `} else {`,
    `  recoveredRawMatched = vault.checkout({`,
    `    bindingHandle: "binding_handle_cross_process",`,
    `    generationId: "generation_cross_process_b",`,
    `  }) === "raw-cross-process-session";`,
    `}`,
    `appendFileSync(process.argv[1], JSON.stringify({`,
    `  recoveryState: recovery.state,`,
    `  recoveredRawMatched,`,
    `  authorityProjection: authority.toJSON(),`,
    `}) + "\\n");`,
    `process.stdout.write(JSON.stringify({ type: "runtime_host_ready", url: "http://127.0.0.1:49321" }) + "\\n");`,
    `process.once("SIGTERM", () => {`,
    `  if (recovery.state === "reclaimed") {`,
    `    vault.delete({`,
    `      bindingHandle: "binding_handle_cross_process",`,
    `      generationId: "generation_cross_process_b",`,
    `    });`,
    `    authority.close();`,
    `  }`,
    `  process.exit(0);`,
    `});`,
    `setInterval(() => {}, 1_000);`,
  ].join("\n");
  try {
    const supervisor = createRuntimeHostSupervisor({
      dataDirectory: runtimeRoot,
      repositoryRoot: process.cwd(),
      environment: {},
      launcher: {
        command: process.execPath,
        args: ["--import", "tsx", "--input-type=module", "-e", source, auditLog],
        electronRunAsNode: false,
      },
      startTimeoutMs: 5_000,
      stopTimeoutMs: 1_000,
    });
    await supervisor.start();
    await supervisor.stop();
    await supervisor.start();
    await supervisor.stop();

    const observations = readFileSync(auditLog, "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(observations.length, 2);
    assert.deepEqual(observations[0], {
      recoveryState: "fresh",
      recoveredRawMatched: false,
      authorityProjection: { kind: "acp_runtime_host_private_authority" },
    });
    assert.deepEqual(observations[1], {
      recoveryState: "reclaimed",
      recoveredRawMatched: true,
      authorityProjection: { kind: "acp_runtime_host_private_authority" },
    });
    assert.equal(JSON.stringify(observations).includes("raw-cross-process-session"), false);
    assert.equal(JSON.stringify(observations).includes(runtimeRoot), false);
    assert.equal(existsSync(path.join(runtimeRoot, ".acp-host-epoch.lease")), false);
    assert.equal(existsSync(path.join(runtimeRoot, "acp-private", "task", "binding-map.v1.json")), false);
  } finally {
    rmSync(runtimeRoot, { recursive: true, force: true });
  }
});

function createChild({ ignoreSignals = false } = {}) {
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
    if (ignoreSignals) return true;
    child.exitCode = 0;
    queueMicrotask(() => child.emit("exit", 0, signal));
    return true;
  };
  return child;
}

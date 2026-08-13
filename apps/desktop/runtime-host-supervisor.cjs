"use strict";

const crypto = require("node:crypto");
const { spawn: spawnChildProcess } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_START_TIMEOUT_MS = 20_000;
const DEFAULT_STOP_TIMEOUT_MS = 5_000;

/**
 * Starts the Runtime Host as a separate local process.  Electron only owns its
 * lifecycle and its short-lived bridge credential; all durable Runtime state
 * remains owned by apps/runtime-host.
 */
function createRuntimeHostSupervisor({
  dataDirectory,
  repositoryRoot = path.resolve(__dirname, "..", ".."),
  environment = process.env,
  spawn = spawnChildProcess,
  randomBytes = crypto.randomBytes,
  hostEpochRecoverySigner = createHostEpochRecoverySigner(),
  allowedOrigins = [],
  rendererOrigin,
  launcher = runtimeHostLauncherFromEnvironment(environment, repositoryRoot),
  startTimeoutMs = DEFAULT_START_TIMEOUT_MS,
  stopTimeoutMs = DEFAULT_STOP_TIMEOUT_MS,
} = {}) {
  const runtimeDataDirectory = requiredPath(dataDirectory, "runtime_host_data_directory_required");
  if (typeof spawn !== "function") throw new TypeError("runtime_host_spawn_required");
  if (typeof randomBytes !== "function") throw new TypeError("runtime_host_random_bytes_required");
  assertHostEpochRecoverySigner(hostEpochRecoverySigner);
  if (!Number.isSafeInteger(startTimeoutMs) || startTimeoutMs < 1) throw new TypeError("runtime_host_start_timeout_invalid");
  if (!Number.isSafeInteger(stopTimeoutMs) || stopTimeoutMs < 1) throw new TypeError("runtime_host_stop_timeout_invalid");
  assertLauncher(launcher);
  const normalizedAllowedOrigins = normalizeAllowedOrigins(allowedOrigins);
  const normalizedRendererOrigin = rendererOrigin === undefined ? undefined : normalizeOrigin(rendererOrigin);
  if (normalizedRendererOrigin && !normalizedAllowedOrigins.includes(normalizedRendererOrigin)) {
    throw new Error("runtime_host_renderer_origin_not_allowed");
  }

  let child;
  let connection;
  let starting;
  let stopping;
  let activeHostEpoch;
  let confirmedDeadHostEpoch;

  return Object.freeze({
    start,
    stop,
    getConnection: () => connection,
  });

  async function start() {
    if (connection) return connection;
    if (starting) return starting;
    if (child) throw new Error("runtime_host_previous_process_exit_unconfirmed");

    starting = launch().finally(() => {
      starting = undefined;
    });
    return starting;
  }

  async function launch() {
    const browserToken = bridgeToken(randomBytes);
    const desktopToken = bridgeToken(randomBytes);
    const evidenceToken = bridgeToken(randomBytes);
    if (new Set([browserToken, desktopToken, evidenceToken]).size !== 3) {
      throw new Error("runtime_host_token_generation_failed");
    }
    const hostEpoch = hostEpochId(randomBytes);
    const staleHostEpoch = inspectHostEpochLease(runtimeDataDirectory);
    if (staleHostEpoch && !confirmedDeadHostEpoch) {
      throw new Error("runtime_host_acp_epoch_recovery_unconfirmed");
    }
    if (staleHostEpoch && staleHostEpoch !== confirmedDeadHostEpoch) {
      throw new Error("runtime_host_acp_epoch_recovery_lineage_mismatch");
    }
    const recoveryProof = staleHostEpoch
      ? hostEpochRecoverySigner.sign({
          runtimeDataDirectory: runtimeDataDirectory,
          deadHostEpoch: confirmedDeadHostEpoch,
          newHostEpoch: hostEpoch,
        })
      : undefined;
    const childEnvironment = {
      ...environment,
      AGENT_WORKSPACE_RUNTIME_DATA_DIR: runtimeDataDirectory,
      AGENT_WORKSPACE_RUNTIME_PORT: "0",
      AGENT_WORKSPACE_RUNTIME_TOKEN: browserToken,
      AGENT_WORKSPACE_RUNTIME_DESKTOP_TOKEN: desktopToken,
      AGENT_WORKSPACE_RUNTIME_EVIDENCE_TOKEN: evidenceToken,
      AGENT_WORKSPACE_RUNTIME_ALLOWED_ORIGINS: JSON.stringify(normalizedAllowedOrigins),
      AGENT_WORKSPACE_ACP_HOST_EPOCH: hostEpoch,
      AGENT_WORKSPACE_ACP_HOST_EPOCH_PUBLIC_KEY: hostEpochRecoverySigner.publicKey,
      ...(recoveryProof
        ? { AGENT_WORKSPACE_ACP_HOST_EPOCH_RECOVERY_PROOF: recoveryProof }
        : {}),
    };
    if (!recoveryProof) delete childEnvironment.AGENT_WORKSPACE_ACP_HOST_EPOCH_RECOVERY_PROOF;
    if (launcher.electronRunAsNode) childEnvironment.ELECTRON_RUN_AS_NODE = "1";

    child = spawn(launcher.command, launcher.args, {
      cwd: repositoryRoot,
      env: childEnvironment,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    if (!child || !child.stdout || !child.stderr) {
      child = undefined;
      throw new Error("runtime_host_process_stdio_unavailable");
    }
    const launchedChild = child;
    activeHostEpoch = hostEpoch;
    launchedChild.once("exit", () => {
      if (child === launchedChild) {
        child = undefined;
        connection = undefined;
      }
      if (activeHostEpoch === hostEpoch) activeHostEpoch = undefined;
      confirmedDeadHostEpoch = hostEpoch;
    });
    child.stdout.setEncoding?.("utf8");
    child.stderr.setEncoding?.("utf8");

    return new Promise((resolve, reject) => {
      let output = "";
      let errorOutput = "";
      let settled = false;
      const timeout = setTimeout(() => fail(new Error("runtime_host_start_timeout")), startTimeoutMs);
      timeout.unref?.();

      const cleanup = () => {
        clearTimeout(timeout);
        launchedChild.stdout?.off?.("data", onStdout);
        launchedChild.stderr?.off?.("data", onStderr);
        launchedChild.off?.("error", onStartupError);
        launchedChild.off?.("exit", onStartupExit);
      };
      const complete = (value) => {
        if (settled) return;
        settled = true;
        cleanup();
        connection = value;
        confirmedDeadHostEpoch = undefined;
        resolve(value);
      };
      const fail = (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        // Child stderr can contain environment-dependent data.  Do not bubble
        // it into an Electron-visible error where a credential could leak.
        void errorOutput;
        void terminateChildAndConfirm(launchedChild, stopTimeoutMs).then(
          () => reject(error),
          () => reject(new Error("runtime_host_start_cleanup_unconfirmed")),
        );
      };
      const onStdout = (chunk) => {
        output += String(chunk);
        const lines = output.split(/\r?\n/);
        output = lines.pop() ?? "";
        for (const line of lines) {
          let ready;
          try {
            ready = parseRuntimeHostReady(line, desktopToken, normalizedRendererOrigin);
          } catch (error) {
            fail(error instanceof Error ? error : new Error("runtime_host_ready_invalid"));
            return;
          }
          if (ready) {
            complete(ready);
            return;
          }
        }
      };
      const onStderr = (chunk) => {
        errorOutput = `${errorOutput}${String(chunk)}`.slice(-4_096);
      };
      const onStartupError = (error) => fail(error instanceof Error ? error : new Error("runtime_host_process_failed"));
      const onStartupExit = (code, signal) => fail(new Error(`runtime_host_exited_before_ready:${code ?? signal ?? "unknown"}`));

      child.stdout.on("data", onStdout);
      child.stderr.on("data", onStderr);
      child.once("error", onStartupError);
      child.once("exit", onStartupExit);
    });
  }

  async function stop() {
    if (stopping) return stopping;
    if (!child || hasConfirmedExit(child)) {
      child = undefined;
      connection = undefined;
      return undefined;
    }

    const target = child;
    connection = undefined;
    stopping = terminateChildAndConfirm(target, stopTimeoutMs).finally(() => {
      stopping = undefined;
    });
    return stopping;
  }
}

async function terminateChildAndConfirm(target, timeoutMs) {
  if (hasConfirmedExit(target)) return;
  if (await signalAndWaitForExit(target, "SIGTERM", timeoutMs)) return;
  if (await signalAndWaitForExit(target, "SIGKILL", timeoutMs)) return;
  throw new Error("runtime_host_stop_unconfirmed");
}

function signalAndWaitForExit(target, signal, timeoutMs) {
  if (hasConfirmedExit(target)) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const complete = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      target.off?.("exit", onExit);
      resolve(value);
    };
    const onExit = () => complete(true);
    const timeout = setTimeout(() => complete(hasConfirmedExit(target)), timeoutMs);
    target.once("exit", onExit);
    try {
      target.kill(signal);
    } catch {
      complete(hasConfirmedExit(target));
    }
  });
}

function hasConfirmedExit(target) {
  return (target.exitCode !== undefined && target.exitCode !== null)
    || (target.signalCode !== undefined && target.signalCode !== null);
}

function createHostEpochRecoverySigner() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  const publicKeyText = publicKey.export({ type: "spki", format: "der" }).toString("base64url");
  return Object.freeze({
    publicKey: publicKeyText,
    sign({ runtimeDataDirectory, deadHostEpoch, newHostEpoch }) {
      const payload = Buffer.from(JSON.stringify({
        schemaVersion: 1,
        runtimeRootDigest: crypto.createHash("sha256").update(fs.realpathSync(runtimeDataDirectory)).digest("hex"),
        deadHostEpoch,
        newHostEpoch,
        nonce: crypto.randomBytes(24).toString("base64url"),
      }), "utf8");
      const signature = crypto.sign(null, payload, privateKey);
      return Buffer.from(JSON.stringify({
        payload: payload.toString("base64url"),
        signature: signature.toString("base64url"),
      }), "utf8").toString("base64url");
    },
  });
}

function hostEpochId(randomBytes) {
  const value = randomBytes(24);
  if (!Buffer.isBuffer(value) || value.length < 16) throw new Error("runtime_host_epoch_generation_failed");
  return `host_epoch_${value.toString("base64url")}`;
}

function inspectHostEpochLease(runtimeDataDirectory) {
  const lease = path.join(runtimeDataDirectory, ".acp-host-epoch.lease");
  let descriptor;
  try {
    const rootStat = fs.lstatSync(runtimeDataDirectory);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || (rootStat.mode & 0o777) !== 0o700) {
      throw new Error("runtime_host_acp_runtime_root_unsafe");
    }
    const before = fs.lstatSync(lease);
    if (!before.isFile() || before.isSymbolicLink() || (before.mode & 0o777) !== 0o600) {
      throw new Error("runtime_host_acp_epoch_lease_unsafe");
    }
    if (typeof fs.constants.O_NOFOLLOW !== "number") {
      throw new Error("runtime_host_acp_no_follow_unavailable");
    }
    descriptor = fs.openSync(lease, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino
      || (opened.mode & 0o777) !== 0o600 || opened.size < 1 || opened.size > 4_096) {
      throw new Error("runtime_host_acp_epoch_lease_unsafe");
    }
    const parsed = JSON.parse(fs.readFileSync(descriptor, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
      || Object.keys(parsed).sort().join(",") !== "hostEpoch,schemaVersion"
      || parsed.schemaVersion !== 1
      || typeof parsed.hostEpoch !== "string"
      || !/^host_epoch_[A-Za-z0-9_-]{8,256}$/u.test(parsed.hostEpoch)) {
      throw new Error("runtime_host_acp_epoch_lease_unsafe");
    }
    return parsed.hostEpoch;
  } catch (error) {
    if (error && error.code === "ENOENT") return false;
    if (error instanceof SyntaxError) throw new Error("runtime_host_acp_epoch_lease_unsafe");
    throw error;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function assertHostEpochRecoverySigner(value) {
  if (!value || typeof value.publicKey !== "string" || !value.publicKey
    || typeof value.sign !== "function") {
    throw new TypeError("runtime_host_epoch_recovery_signer_invalid");
  }
}

function runtimeHostLauncherFromEnvironment(environment = process.env, repositoryRoot = path.resolve(__dirname, "..", "..")) {
  const command = nonEmptyString(environment.AGENT_WORKSPACE_RUNTIME_HOST_COMMAND);
  if (!command) return resolveDefaultRuntimeHostLauncher(repositoryRoot);
  return {
    command,
    args: parseLauncherArgs(environment.AGENT_WORKSPACE_RUNTIME_HOST_ARGS_JSON),
    electronRunAsNode: false,
  };
}

function resolveDefaultRuntimeHostLauncher(repositoryRoot = path.resolve(__dirname, "..", "..")) {
  const runtimeEntry = path.join(repositoryRoot, "apps", "runtime-host", "src", "index.ts");
  const tsxCli = path.join(repositoryRoot, "node_modules", "tsx", "dist", "cli.mjs");
  if (!fs.existsSync(runtimeEntry) || !fs.existsSync(tsxCli)) {
    throw new Error("runtime_host_launcher_missing: configure AGENT_WORKSPACE_RUNTIME_HOST_COMMAND for this package");
  }
  return {
    command: process.execPath,
    args: [tsxCli, runtimeEntry],
    electronRunAsNode: true,
  };
}

function parseLauncherArgs(value) {
  if (value === undefined || value === "") return [];
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new TypeError("runtime_host_launcher_args_invalid");
  }
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
    throw new TypeError("runtime_host_launcher_args_invalid");
  }
  return parsed;
}

function parseRuntimeHostReady(line, token, origin) {
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (parsed?.type !== "runtime_host_ready" || typeof parsed.url !== "string") return undefined;
  const url = new URL(parsed.url);
  if ((url.protocol !== "http:" && url.protocol !== "https:") || !isLoopbackHostname(url.hostname)) {
    throw new Error("runtime_host_ready_url_invalid");
  }
  return Object.freeze({
    baseUrl: url.toString().replace(/\/$/, ""),
    token,
    ...(origin ? { origin } : {}),
  });
}

function bridgeToken(randomBytes) {
  const value = randomBytes(32);
  if (!Buffer.isBuffer(value) || value.length < 16) throw new Error("runtime_host_token_generation_failed");
  return value.toString("base64url");
}

function isLoopbackHostname(value) {
  return value === "127.0.0.1" || value === "::1" || value === "[::1]" || value === "localhost";
}

function normalizeAllowedOrigins(value) {
  if (!Array.isArray(value)) throw new TypeError("runtime_host_allowed_origins_invalid");
  const origins = value.map(normalizeOrigin);
  if (new Set(origins).size !== origins.length) throw new TypeError("runtime_host_allowed_origins_invalid");
  return Object.freeze(origins);
}

function normalizeOrigin(value) {
  if (typeof value !== "string" || !value.trim() || /[\r\n]/.test(value)) {
    throw new TypeError("runtime_host_origin_invalid");
  }
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    throw new TypeError("runtime_host_origin_invalid");
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:")
    || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new TypeError("runtime_host_origin_invalid");
  }
  return url.origin;
}

function requiredPath(value, code) {
  const text = nonEmptyString(value);
  if (!text) throw new TypeError(code);
  return path.resolve(text);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function assertLauncher(value) {
  if (!value || typeof value.command !== "string" || !value.command || !Array.isArray(value.args) || value.args.some((arg) => typeof arg !== "string")) {
    throw new TypeError("runtime_host_launcher_invalid");
  }
}

module.exports = {
  createRuntimeHostSupervisor,
  parseLauncherArgs,
  resolveDefaultRuntimeHostLauncher,
  runtimeHostLauncherFromEnvironment,
};

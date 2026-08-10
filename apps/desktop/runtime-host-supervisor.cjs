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
  launcher = runtimeHostLauncherFromEnvironment(environment, repositoryRoot),
  startTimeoutMs = DEFAULT_START_TIMEOUT_MS,
  stopTimeoutMs = DEFAULT_STOP_TIMEOUT_MS,
} = {}) {
  const runtimeDataDirectory = requiredPath(dataDirectory, "runtime_host_data_directory_required");
  if (typeof spawn !== "function") throw new TypeError("runtime_host_spawn_required");
  if (typeof randomBytes !== "function") throw new TypeError("runtime_host_random_bytes_required");
  if (!Number.isSafeInteger(startTimeoutMs) || startTimeoutMs < 1) throw new TypeError("runtime_host_start_timeout_invalid");
  if (!Number.isSafeInteger(stopTimeoutMs) || stopTimeoutMs < 1) throw new TypeError("runtime_host_stop_timeout_invalid");
  assertLauncher(launcher);

  let child;
  let connection;
  let starting;
  let stopping;

  return Object.freeze({
    start,
    stop,
    getConnection: () => connection,
  });

  async function start() {
    if (connection) return connection;
    if (starting) return starting;

    starting = launch().finally(() => {
      starting = undefined;
    });
    return starting;
  }

  async function launch() {
    const token = bridgeToken(randomBytes);
    const childEnvironment = {
      ...environment,
      AGENT_WORKSPACE_RUNTIME_DATA_DIR: runtimeDataDirectory,
      AGENT_WORKSPACE_RUNTIME_PORT: "0",
      AGENT_WORKSPACE_RUNTIME_TOKEN: token,
    };
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
        child?.stdout?.off?.("data", onStdout);
        child?.stderr?.off?.("data", onStderr);
        child?.off?.("error", onStartupError);
        child?.off?.("exit", onStartupExit);
      };
      const complete = (value) => {
        if (settled) return;
        settled = true;
        cleanup();
        connection = value;
        resolve(value);
      };
      const fail = (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        const failedChild = child;
        child = undefined;
        try {
          // A timeout is not proof that the child exited.  Terminate the child
          // we launched so a failed Desktop start cannot leave a Host behind.
          failedChild?.kill?.("SIGTERM");
        } catch {
          // Exit and spawn races are harmless here.
        }
        // Child stderr can contain environment-dependent data.  Do not bubble
        // it into an Electron-visible error where a credential could leak.
        void errorOutput;
        reject(error);
      };
      const onStdout = (chunk) => {
        output += String(chunk);
        const lines = output.split(/\r?\n/);
        output = lines.pop() ?? "";
        for (const line of lines) {
          let ready;
          try {
            ready = parseRuntimeHostReady(line, token);
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
    if (!child || (child.exitCode !== undefined && child.exitCode !== null) || child.killed === true) {
      child = undefined;
      connection = undefined;
      return undefined;
    }

    const target = child;
    connection = undefined;
    stopping = new Promise((resolve) => {
      const timeout = setTimeout(() => {
        try {
          target.kill("SIGKILL");
        } catch {
          // The process may have finished between the liveness check and kill.
        }
        resolve();
      }, stopTimeoutMs);
      timeout.unref?.();
      target.once("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
      try {
        target.kill("SIGTERM");
      } catch {
        clearTimeout(timeout);
        resolve();
      }
    }).finally(() => {
      if (child === target) child = undefined;
      stopping = undefined;
    });
    return stopping;
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

function parseRuntimeHostReady(line, token) {
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
  return Object.freeze({ baseUrl: url.toString().replace(/\/$/, ""), token });
}

function bridgeToken(randomBytes) {
  const value = randomBytes(32);
  if (!Buffer.isBuffer(value) || value.length < 16) throw new Error("runtime_host_token_generation_failed");
  return value.toString("base64url");
}

function isLoopbackHostname(value) {
  return value === "127.0.0.1" || value === "::1" || value === "[::1]" || value === "localhost";
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

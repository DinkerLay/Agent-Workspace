#!/usr/bin/env node

/**
 * Local development launcher for the formal Runtime-backed AgentLoop.
 *
 * It deliberately composes one isolated Runtime Host, the formal Workbench
 * Vite root, and (unless --web is selected) the formal Electron shell.  The
 * browser receives only the Host bridge credential through Vite's development
 * bootstrap/proxy; Electron receives the same bridge through its main-process
 * IPC facade.  Neither route starts a legacy desktop/runtime process.
 */
import { spawn } from "node:child_process";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const loopbackHost = "127.0.0.1";
const RUNTIME_START_TIMEOUT_MS = 20_000;
const VITE_START_TIMEOUT_MS = 30_000;
const children = [];

let stopping = false;

export function parseLaunchMode(args) {
  if (args.length === 0) return "desktop";
  if (args.length === 1 && args[0] === "--web") return "web";
  throw new Error("formal_dev_usage: node scripts/formal-dev.mjs [--web]");
}

export function readPort(value, fallback, name) {
  if (value === undefined || value === "") return fallback;
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error(`${name}_invalid`);
  return port;
}

export function parseRuntimeReady(line) {
  try {
    const value = JSON.parse(line);
    if (value?.type !== "runtime_host_ready" || typeof value.url !== "string" || !Number.isSafeInteger(value.port)) return undefined;
    const url = new URL(value.url);
    if (url.protocol !== "http:" || url.hostname !== loopbackHost || value.port < 1 || value.port > 65_535) return undefined;
    return Object.freeze({ url: url.toString().replace(/\/$/, ""), port: value.port });
  } catch {
    return undefined;
  }
}

export async function findAvailablePort(startPort, attempts = 25, isAvailable = isPortAvailable) {
  for (let offset = 0; offset < attempts; offset += 1) {
    const port = startPort + offset;
    if (port > 65_535) break;
    if (await isAvailable(port)) return port;
  }
  throw new Error(`formal_dev_no_available_port:${startPort}`);
}

export function createElectronEnvironment({ baseEnvironment, runtime, workbenchUrl }) {
  const environment = {
    ...baseEnvironment,
    AGENT_WORKSPACE_RUNTIME_URL: runtime.url,
    AGENT_WORKSPACE_RUNTIME_DESKTOP_TOKEN: runtime.desktopToken,
    AGENT_WORKSPACE_RUNTIME_ORIGIN: workbenchUrl,
    AGENT_WORKSPACE_WORKBENCH_URL: workbenchUrl,
  };
  delete environment.AGENT_WORKSPACE_RUNTIME_TOKEN;
  delete environment.AGENT_WORKSPACE_RUNTIME_EVIDENCE_TOKEN;
  delete environment.AGENT_WORKSPACE_RUNTIME_ALLOWED_ORIGINS;
  return environment;
}

export function createRuntimeTokens(environment = process.env, createSecret = () => randomBytes(32).toString("base64url")) {
  const browserToken = environment.AGENT_WORKSPACE_RUNTIME_TOKEN?.trim() || createSecret();
  const desktopToken = environment.AGENT_WORKSPACE_RUNTIME_DESKTOP_TOKEN?.trim() || createSecret();
  const evidenceToken = environment.AGENT_WORKSPACE_RUNTIME_EVIDENCE_TOKEN?.trim() || createSecret();
  const tokens = [browserToken, desktopToken, evidenceToken];
  if (tokens.some((token) => token.length < 16 || /\s/u.test(token)) || new Set(tokens).size !== tokens.length) {
    throw new Error("formal_dev_runtime_tokens_invalid");
  }
  return Object.freeze({ browserToken, desktopToken, evidenceToken });
}

/**
 * The formal launcher is the supervisor for its one Runtime Host child.  It
 * therefore mints a fresh Host epoch and verifier for that child instead of
 * relying on an embedded Host fallback.  A recovery proof is never inherited:
 * this launcher does not restart a predecessor and cannot attest its death.
 */
export function createAcpHostEpochLaunchEnvironment(
  baseEnvironment = process.env,
  createEpoch = () => `host_epoch_${randomBytes(24).toString("base64url")}`,
  createPublicKey = () => generateKeyPairSync("ed25519").publicKey
    .export({ type: "spki", format: "der" })
    .toString("base64url"),
) {
  const hostEpoch = createEpoch();
  const publicKey = createPublicKey();
  if (typeof hostEpoch !== "string" || !/^host_epoch_[A-Za-z0-9_-]{8,256}$/u.test(hostEpoch)
    || typeof publicKey !== "string" || !/^[A-Za-z0-9_-]{32,}$/u.test(publicKey)) {
    throw new Error("formal_dev_acp_host_epoch_invalid");
  }
  const environment = {
    ...baseEnvironment,
    AGENT_WORKSPACE_ACP_HOST_EPOCH: hostEpoch,
    AGENT_WORKSPACE_ACP_HOST_EPOCH_PUBLIC_KEY: publicKey,
  };
  delete environment.AGENT_WORKSPACE_ACP_HOST_EPOCH_RECOVERY_PROOF;
  return Object.freeze(environment);
}

async function main() {
  const mode = parseLaunchMode(process.argv.slice(2));
  const requestedWorkbenchPort = readPort(
    process.env.AGENT_WORKSPACE_PORT ?? process.env.AGENT_WORKSPACE_WORKBENCH_PORT,
    5188,
    "AGENT_WORKSPACE_PORT",
  );
  const tokens = createRuntimeTokens();

  installShutdownHandlers();
  const workbenchPort = await findAvailablePort(requestedWorkbenchPort);
  const workbenchUrl = `http://${loopbackHost}:${workbenchPort}/`;
  const runtimeProcess = spawnRuntimeHost(tokens, workbenchUrl);
  const runtimeAddress = await waitForRuntime(runtimeProcess);
  const runtime = Object.freeze({ ...runtimeAddress, ...tokens });
  const viteProcess = spawnFormalVite({ runtime, workbenchPort });
  await waitForHttp(workbenchUrl, VITE_START_TIMEOUT_MS);

  process.stdout.write(`Agent Workspace Runtime: ${runtime.url}\n`);
  process.stdout.write(`Agent Workspace Workbench: ${workbenchUrl}\n`);

  if (mode === "web") {
    process.stdout.write("Agent Workspace mode: web\n");
    await waitForExit(viteProcess, "formal_vite");
    await shutdown(0);
    return;
  }

  const electronProcess = spawnFormalElectron({ runtime, workbenchUrl });
  await waitForExit(electronProcess, "formal_electron");
  await shutdown(0);
}

function spawnRuntimeHost(tokens, workbenchUrl) {
  const tsxEntry = path.join(repositoryRoot, "node_modules", "tsx", "dist", "cli.mjs");
  const runtimeEntry = path.join(repositoryRoot, "apps", "runtime-host", "src", "index.ts");
  if (!existsSync(tsxEntry) || !existsSync(runtimeEntry)) {
    throw new Error("formal_dev_runtime_host_launcher_missing: run pnpm install");
  }
  return spawnTracked(process.execPath, [tsxEntry, runtimeEntry], {
    env: createAcpHostEpochLaunchEnvironment({
      ...process.env,
      AGENT_WORKSPACE_RUNTIME_PORT: "0",
      AGENT_WORKSPACE_RUNTIME_TOKEN: tokens.browserToken,
      AGENT_WORKSPACE_RUNTIME_DESKTOP_TOKEN: tokens.desktopToken,
      AGENT_WORKSPACE_RUNTIME_EVIDENCE_TOKEN: tokens.evidenceToken,
      AGENT_WORKSPACE_RUNTIME_ALLOWED_ORIGINS: JSON.stringify([new URL(workbenchUrl).origin]),
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function spawnFormalVite({ runtime, workbenchPort }) {
  const viteEntry = path.join(repositoryRoot, "node_modules", "vite", "bin", "vite.js");
  if (!existsSync(viteEntry)) throw new Error("formal_dev_vite_launcher_missing: run pnpm install");
  const environment = {
    ...process.env,
    AGENT_WORKSPACE_RUNTIME_URL: runtime.url,
    AGENT_WORKSPACE_RUNTIME_PORT: String(runtime.port),
    AGENT_WORKSPACE_RUNTIME_TOKEN: runtime.browserToken,
  };
  delete environment.AGENT_WORKSPACE_RUNTIME_DESKTOP_TOKEN;
  delete environment.AGENT_WORKSPACE_RUNTIME_EVIDENCE_TOKEN;
  return spawnTracked(process.execPath, [
    viteEntry,
    "--config", "vite.runtime.config.ts",
    "--host", loopbackHost,
    "--port", String(workbenchPort),
    "--strictPort",
  ], {
    env: environment,
    stdio: "inherit",
  });
}

function spawnFormalElectron({ runtime, workbenchUrl }) {
  const electronBinary = resolveElectronBinary();
  const userDataDirectory = resolveUserDataDirectory(process.env.AGENT_WORKSPACE_USER_DATA_DIR);
  return spawnTracked(electronBinary, [
    ...(userDataDirectory ? [`--user-data-dir=${userDataDirectory}`] : []),
    "apps/desktop/main.cjs",
  ], {
    env: createElectronEnvironment({ baseEnvironment: process.env, runtime, workbenchUrl }),
    stdio: "inherit",
  });
}

function spawnTracked(command, args, options) {
  const child = spawn(command, args, {
    cwd: repositoryRoot,
    shell: process.platform === "win32",
    ...options,
  });
  children.push(child);
  return child;
}

function waitForRuntime(child) {
  if (!child.stdout || !child.stderr) return Promise.reject(new Error("formal_dev_runtime_host_stdio_unavailable"));
  return new Promise((resolve, reject) => {
    let buffer = "";
    let settled = false;
    const timeout = setTimeout(() => finish(new Error("formal_dev_runtime_host_start_timeout")), RUNTIME_START_TIMEOUT_MS);
    timeout.unref?.();

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    const onStdout = (chunk) => {
      buffer += String(chunk);
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const address = parseRuntimeReady(line);
        if (address) {
          finish(undefined, address);
          return;
        }
        if (line.trim()) process.stdout.write(`${line}\n`);
      }
    };
    const onStderr = (chunk) => process.stderr.write(String(chunk));
    const onError = (error) => finish(error instanceof Error ? error : new Error("formal_dev_runtime_host_process_failed"));
    const onExit = (code, signal) => finish(new Error(`formal_dev_runtime_host_exited:${code ?? signal ?? "unknown"}`));

    child.stdout.on("data", onStdout);
    child.stderr.on("data", onStderr);
    child.once("error", onError);
    child.once("exit", onExit);

    function finish(error, address) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.stdout?.off("data", onStdout);
      child.stderr?.off("data", onStderr);
      child.off("error", onError);
      child.off("exit", onExit);
      if (error) reject(error);
      else resolve(address);
    }
  });
}

function waitForHttp(url, timeoutMs) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const probe = () => {
      const request = http.get(url, (response) => {
        response.resume();
        if (response.statusCode && response.statusCode >= 200 && response.statusCode < 500) resolve();
        else retry();
      });
      request.once("error", retry);
      request.setTimeout(1_000, () => request.destroy());
    };
    const retry = () => {
      if (Date.now() - startedAt >= timeoutMs) {
        reject(new Error(`formal_dev_workbench_start_timeout:${url}`));
        return;
      }
      setTimeout(probe, 200);
    };
    probe();
  });
}

function waitForExit(child, name) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return stopping || child.exitCode === 0
      ? Promise.resolve()
      : Promise.reject(new Error(`${name}_exited:${child.exitCode ?? child.signalCode ?? "unknown"}`));
  }
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (stopping || code === 0) resolve();
      else reject(new Error(`${name}_exited:${code ?? signal ?? "unknown"}`));
    });
  });
}

function isPortAvailable(port) {
  return new Promise((resolve) => {
    const server = http.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => server.close(() => resolve(true)));
    server.listen(port, loopbackHost);
  });
}

function resolveElectronBinary() {
  const candidates = [
    process.env.ELECTRON_BINARY,
    path.join(repositoryRoot, "node_modules", "electron", "dist", "Electron.app", "Contents", "MacOS", "Electron"),
    path.join(repositoryRoot, "node_modules", ".bin", "electron"),
    "electron",
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (candidate.includes(path.sep) && existsSync(candidate)) return candidate;
    if (!candidate.includes(path.sep)) return candidate;
  }
  throw new Error("formal_dev_electron_binary_missing: set ELECTRON_BINARY or run pnpm install");
}

function resolveUserDataDirectory(value) {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized ? path.resolve(normalized) : undefined;
}

function installShutdownHandlers() {
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => {
      void shutdown(0);
    });
  }
}

async function shutdown(exitCode) {
  if (stopping) return;
  stopping = true;
  for (const child of [...children].reverse()) {
    if (child.exitCode === null && child.signalCode === null && !child.killed) {
      try {
        child.kill("SIGTERM");
      } catch {
        // Exit races are harmless during launcher teardown.
      }
    }
  }
  await Promise.all(children.map((child) => waitForExit(child, "child").catch(() => undefined)));
  process.exitCode = exitCode;
}

function isEntryModule() {
  const argvEntry = process.argv[1];
  return typeof argvEntry === "string" && path.resolve(argvEntry) === fileURLToPath(import.meta.url);
}

if (isEntryModule()) {
  void main().catch(async (error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    await shutdown(1);
  });
}

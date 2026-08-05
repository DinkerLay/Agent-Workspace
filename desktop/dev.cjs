const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const host = "127.0.0.1";
const preferredPort = Number(process.env.AGENT_WORKSPACE_PORT ?? 5188);
const children = [];

function spawnChild(command, args, options = {}) {
  const child = spawn(command, args, {
    stdio: "inherit",
    shell: process.platform === "win32",
    ...options,
  });
  children.push(child);
  return child;
}

function waitForServer(url, timeoutMs = 30000) {
  const startedAt = Date.now();

  return new Promise((resolve, reject) => {
    const probe = () => {
      const request = http.get(url, (response) => {
        response.resume();
        resolve();
      });
      request.on("error", () => {
        if (Date.now() - startedAt > timeoutMs) {
          reject(new Error(`Timed out waiting for ${url}`));
          return;
        }
        setTimeout(probe, 500);
      });
      request.setTimeout(1000, () => {
        request.destroy();
      });
    };
    probe();
  });
}

function isPortAvailable(port) {
  return new Promise((resolve) => {
    const server = http.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, host);
  });
}

async function findAvailablePort(startPort, attempts = 25) {
  for (let offset = 0; offset < attempts; offset += 1) {
    const port = startPort + offset;
    if (await isPortAvailable(port)) return port;
  }

  throw new Error(`No available dev server port found from ${startPort} to ${startPort + attempts - 1}.`);
}

async function main() {
  const port = await findAvailablePort(preferredPort);
  const runtimeHostPort = await findAvailablePort(preferredPort + 100);
  const devServerUrl = `http://${host}:${port}/`;
  const viteEntry = resolveViteEntry();
  const projectPath = process.cwd();
  const projectName = path.basename(projectPath);
  const userDataDir = resolveUserDataDir(process.env.AGENT_WORKSPACE_USER_DATA_DIR);
  const runtimeBridgeEnv = {
    ...process.env,
    AGENT_WORKSPACE_WEB_HOST_PORT: String(runtimeHostPort),
    AGENT_WORKSPACE_WEB_BRIDGE_TOKEN: crypto.randomBytes(32).toString("base64url"),
    AGENT_WORKSPACE_PROJECT_PATH: projectPath,
    AGENT_WORKSPACE_PROJECT_NAME: projectName,
  };

  console.log(`Starting Vite dev server at ${devServerUrl}`);
  spawnChild(process.execPath, [viteEntry, "--host", host, "--port", String(port), "--strictPort"], { env: runtimeBridgeEnv });
  await waitForServer(devServerUrl);

  const electronBinary = resolveElectronBinary();
  console.log(`Starting Electron with ${devServerUrl}`);
  spawnChild(electronBinary, [
    ...(userDataDir ? [`--user-data-dir=${userDataDir}`] : []),
    "desktop/main.cjs",
  ], {
    env: { ...runtimeBridgeEnv, AGENT_WORKSPACE_DEV_SERVER_URL: devServerUrl },
  });
  console.log(`Browser Runtime development URL: ${devServerUrl}?projectPath=${encodeURIComponent(projectPath)}&projectName=${encodeURIComponent(projectName)}`);
}

function resolveUserDataDir(value) {
  const normalized = String(value ?? "").trim();
  return normalized ? path.resolve(normalized) : undefined;
}

function resolveViteEntry() {
  const candidate = path.join(process.cwd(), "node_modules", "vite", "bin", "vite.js");
  if (fs.existsSync(candidate)) return candidate;
  throw new Error("Vite entry not found. Run npm install first.");
}

function resolveElectronBinary() {
  const candidates = [
    process.env.ELECTRON_BINARY,
    path.join(process.cwd(), "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"),
    path.join(process.cwd(), "node_modules/.bin/electron"),
    "electron",
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (candidate.includes("/") && fs.existsSync(candidate)) return candidate;
    if (!candidate.includes("/")) return candidate;
  }

  throw new Error("Electron binary not found. Set ELECTRON_BINARY or install the electron package.");
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("exit", shutdown);

function shutdown() {
  for (const child of children) {
    if (!child.killed) child.kill();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { fileURLToPath, URL } = require("node:url");
const { createAuthenticatedRuntimeHostBridge, normalizeBridgeToken, normalizeRuntimeBaseUrl } = require("./runtime-host-client.cjs");
const { createRuntimeHostSupervisor } = require("./runtime-host-supervisor.cjs");

/**
 * Compose exactly one typed Runtime bridge for Desktop.  A configured remote
 * Host is used as-is; otherwise Desktop starts the local Host it supervises.
 */
async function createDesktopRuntimeComposition({
  app,
  environment = process.env,
  repositoryRoot = path.resolve(__dirname, "..", ".."),
  supervisorFactory = createRuntimeHostSupervisor,
  bridgeFactory = createAuthenticatedRuntimeHostBridge,
} = {}) {
  const externalConnection = runtimeConnectionFromEnvironment(environment);
  if (externalConnection) {
    return Object.freeze({
      source: "external",
      runtimeBridge: bridgeFactory(externalConnection),
      stop: async () => undefined,
    });
  }
  if (!app || typeof app.getPath !== "function") throw new TypeError("desktop_app_get_path_required");

  const configuredDataDirectory = nonEmptyString(environment.AGENT_WORKSPACE_RUNTIME_DATA_DIR);
  const supervisor = supervisorFactory({
    dataDirectory: configuredDataDirectory ?? path.join(app.getPath("userData"), "runtime"),
    repositoryRoot,
    environment,
  });
  const connection = await supervisor.start();
  return Object.freeze({
    source: "local",
    runtimeBridge: bridgeFactory(connection),
    stop: () => supervisor.stop(),
  });
}

/** The only externally-configurable Desktop connection is the narrow Host bridge. */
function runtimeConnectionFromEnvironment(environment = process.env) {
  const baseUrl = nonEmptyString(environment.AGENT_WORKSPACE_RUNTIME_URL);
  const token = nonEmptyString(environment.AGENT_WORKSPACE_RUNTIME_TOKEN);
  if (!baseUrl && !token) return undefined;
  if (!baseUrl || !token) throw new Error("runtime_host_connection_incomplete");
  return Object.freeze({
    baseUrl: normalizeRuntimeBaseUrl(baseUrl),
    token: normalizeBridgeToken(token),
    origin: nonEmptyString(environment.AGENT_WORKSPACE_RUNTIME_ORIGIN),
  });
}

/** Root Vite build is the packaged Desktop artifact; source-tree app builds are not a fallback. */
function resolveWorkbenchLoadTarget({
  environment = process.env,
  repositoryRoot = path.resolve(__dirname, "..", ".."),
  existsSync = fs.existsSync,
} = {}) {
  const configuredUrl = nonEmptyString(environment.AGENT_WORKSPACE_WORKBENCH_URL);
  if (configuredUrl) {
    const url = new URL(configuredUrl);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || url.hash) {
      throw new Error("workbench_url_invalid");
    }
    return Object.freeze({ kind: "url", url: url.toString(), origin: url.origin });
  }

  const filePath = path.join(repositoryRoot, "dist", "workbench", "index.html");
  if (!existsSync(filePath)) throw new Error(`workbench_build_not_found:${filePath}`);
  return Object.freeze({ kind: "file", filePath: path.resolve(filePath) });
}

function configureWorkbenchNavigation(webContents, target) {
  if (!webContents || typeof webContents.on !== "function" || !target) {
    throw new TypeError("workbench_navigation_configuration_invalid");
  }
  const guard = (event, targetUrl) => {
    if (!isAllowedWorkbenchNavigation(targetUrl, target)) event.preventDefault();
  };
  webContents.on("will-navigate", guard);
  // Preload runs in renderer frames too. Denying cross-origin frame navigation
  // keeps an embedded page from acquiring the Runtime IPC facade.
  webContents.on("will-frame-navigate", guard);
  webContents.on("will-redirect", guard);
  webContents.on("will-attach-webview", (event) => event.preventDefault());
  webContents.setWindowOpenHandler?.(() => ({ action: "deny" }));
  return guard;
}

function isAllowedWorkbenchNavigation(value, target) {
  try {
    const candidate = new URL(value);
    if (target.kind === "url") return candidate.origin === target.origin;
    if (target.kind !== "file" || candidate.protocol !== "file:") return false;
    return path.resolve(fileURLToPath(candidate)) === target.filePath;
  } catch {
    return false;
  }
}

function scopeForWorkbenchIpcEvent(event, target) {
  const frameUrl = event?.senderFrame?.url;
  if (typeof frameUrl !== "string" || !isAllowedWorkbenchNavigation(frameUrl, target)) {
    throw new Error("runtime_ipc_origin_denied");
  }
  if (!event?.sender || !Number.isInteger(event.sender.id)) throw new TypeError("runtime_ipc_sender_invalid");
  return Object.freeze({ transport: "desktop-ipc", webContentsId: event.sender.id });
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

module.exports = {
  configureWorkbenchNavigation,
  createDesktopRuntimeComposition,
  isAllowedWorkbenchNavigation,
  resolveWorkbenchLoadTarget,
  runtimeConnectionFromEnvironment,
  scopeForWorkbenchIpcEvent,
};

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { fileURLToPath, URL } = require("node:url");
const electron = require("electron");
const { registerSessionIdRootRuntimeIpc } = require("./session-id-root-runtime-ipc.cjs");
const {
  createSessionIdRootRuntimeHostPort,
  runtimeConnectionFromEnvironment,
} = require("./session-id-root-runtime-host-client.cjs");
const { createRuntimeHostSupervisor } = require("./runtime-host-supervisor.cjs");

function createDesktopShell({
  electronRuntime = electron,
  environment = process.env,
  repositoryRoot = path.resolve(__dirname, "..", ".."),
  existsSync = fs.existsSync,
  runtimePortFactory = createSessionIdRootRuntimeHostPort,
  supervisorFactory = createRuntimeHostSupervisor,
} = {}) {
  const { app, BrowserWindow, ipcMain } = electronRuntime;
  if (!app || typeof app.whenReady !== "function" || typeof app.on !== "function") {
    throw new TypeError("session_id_electron_app_invalid");
  }
  if (typeof BrowserWindow !== "function" || !ipcMain || typeof ipcMain.handle !== "function") {
    throw new TypeError("session_id_electron_runtime_invalid");
  }
  let mainWindow;
  let runtimePort;
  let unregisterIpc;
  let supervisor;
  let startup;
  let stopping;
  let target;

  const createWindow = () => {
    if (!target) throw new Error("session_id_workbench_target_required");
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.focus();
      return mainWindow;
    }
    mainWindow = new BrowserWindow({
      width: 1440,
      height: 960,
      minWidth: 1024,
      minHeight: 720,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webviewTag: false,
        preload: path.join(__dirname, "preload.cjs"),
      },
    });
    mainWindow.on("closed", () => { mainWindow = undefined; });
    configureWorkbenchNavigation(mainWindow.webContents, target);
    const load = target.kind === "url" ? mainWindow.loadURL(target.url) : mainWindow.loadFile(target.filePath);
    void load.catch(reportStartupFailure);
    return mainWindow;
  };

  const stop = async () => {
    if (stopping) return stopping;
    stopping = (async () => {
      unregisterIpc?.();
      unregisterIpc = undefined;
      const currentPort = runtimePort;
      runtimePort = undefined;
      await currentPort?.close?.();
      const currentSupervisor = supervisor;
      supervisor = undefined;
      await currentSupervisor?.stop?.();
    })();
    return stopping;
  };

  const start = () => {
    if (startup) return startup;
    const externalConnection = runtimeConnectionFromEnvironment(environment);
    target = resolveWorkbenchTarget({ environment, repositoryRoot, existsSync });
    registerLifecycleHandlers({ app, BrowserWindow, createWindow, stop });
    startup = app.whenReady().then(async () => {
      let connection = externalConnection;
      if (!connection) {
        if (typeof app.getPath !== "function") throw new TypeError("session_id_desktop_user_data_path_required");
        const configuredDataDirectory = nonEmptyText(environment.AGENT_WORKSPACE_RUNTIME_DATA_DIR);
        supervisor = supervisorFactory({
          dataDirectory: configuredDataDirectory ?? path.join(app.getPath("userData"), "session-id-runtime"),
          repositoryRoot,
          environment,
          allowedOrigins: target.kind === "url" ? [target.origin] : [],
          ...(target.kind === "url" ? { rendererOrigin: target.origin } : {}),
        });
        connection = await supervisor.start();
      }
      runtimePort = runtimePortFactory(connection);
      const authorize = (event) => authorizeWorkbenchIpcEvent(event, target, mainWindow);
      unregisterIpc = registerSessionIdRootRuntimeIpc({
        ipcMain,
        runtimePort,
        authorizeWorkspaceForEvent: authorize,
        authorizeTaskForEvent: authorize,
      });
      return createWindow();
    }).catch(async (error) => {
      await stop();
      throw error;
    });
    return startup;
  };

  return Object.freeze({ createWindow, start, stop });
}

function resolveWorkbenchTarget({
  environment = process.env,
  repositoryRoot = path.resolve(__dirname, "..", ".."),
  existsSync = fs.existsSync,
} = {}) {
  const configuredUrl = nonEmptyText(environment.AGENT_WORKSPACE_WORKBENCH_URL);
  if (configuredUrl) {
    const url = new URL(configuredUrl);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || url.hash) {
      throw new Error("session_id_workbench_url_invalid");
    }
    return Object.freeze({ kind: "url", url: url.toString(), origin: url.origin });
  }
  const filePath = path.resolve(repositoryRoot, "dist", "workbench", "index.html");
  if (!existsSync(filePath)) throw new Error(`session_id_workbench_build_not_found:${filePath}`);
  return Object.freeze({ kind: "file", filePath });
}

function configureWorkbenchNavigation(webContents, target) {
  if (!webContents || typeof webContents.on !== "function" || !target) throw new TypeError("session_id_navigation_invalid");
  const guard = (event, destination) => {
    if (!isAllowedWorkbenchNavigation(destination, target)) event.preventDefault();
  };
  webContents.on("will-navigate", guard);
  webContents.on("will-frame-navigate", guard);
  webContents.on("will-redirect", guard);
  webContents.on("will-attach-webview", (event) => event.preventDefault());
  webContents.setWindowOpenHandler?.(() => ({ action: "deny" }));
  return guard;
}

function isAllowedWorkbenchNavigation(value, target) {
  try {
    const destination = new URL(value);
    if (target.kind === "url") return destination.origin === target.origin;
    if (target.kind !== "file" || destination.protocol !== "file:") return false;
    return path.resolve(fileURLToPath(destination)) === target.filePath;
  } catch {
    return false;
  }
}

function authorizeWorkbenchIpcEvent(event, target, mainWindow) {
  const frameUrl = event?.senderFrame?.url;
  return Boolean(mainWindow
    && !mainWindow.isDestroyed()
    && event?.sender === mainWindow.webContents
    && typeof frameUrl === "string"
    && isAllowedWorkbenchNavigation(frameUrl, target));
}

function registerLifecycleHandlers({ app, BrowserWindow, createWindow, stop }) {
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
  app.on("before-quit", () => { void stop(); });
}

function isDesktopEntryModule({
  mainModule = require.main,
  moduleRef = module,
  argv = process.argv,
  filename = __filename,
} = {}) {
  const argvEntry = typeof argv[1] === "string" ? path.resolve(argv[1]) : undefined;
  return mainModule === moduleRef || argvEntry === filename || argvEntry === path.dirname(filename);
}

function nonEmptyText(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function reportStartupFailure(error) {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`${message}\n`);
}

if (isDesktopEntryModule()) {
  const shell = createDesktopShell();
  void shell.start().catch((error) => {
    reportStartupFailure(error);
    electron.app.quit();
  });
}

module.exports = {
  authorizeWorkbenchIpcEvent,
  configureWorkbenchNavigation,
  createDesktopShell,
  isAllowedWorkbenchNavigation,
  isDesktopEntryModule,
  reportStartupFailure,
  resolveWorkbenchTarget,
};

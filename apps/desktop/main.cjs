"use strict";

const path = require("node:path");
const { app, BrowserWindow, ipcMain } = require("electron");
const { registerRuntimeIpcFacade } = require("./runtime-ipc-facade.cjs");
const {
  configureWorkbenchNavigation,
  createDesktopRuntimeComposition,
  resolveWorkbenchLoadTarget,
  scopeForWorkbenchIpcEvent,
} = require("./desktop-runtime-composition.cjs");

let mainWindow;
let unregisterRuntimeIpc;
let shellStarted = false;
let startup;
let workbenchTarget;
let runtimeComposition;
let lifecycleRegistered = false;

function createMainWindow(target = workbenchTarget) {
  if (!target) throw new Error("workbench_target_required");
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
  mainWindow.on("closed", () => {
    mainWindow = undefined;
  });
  configureWorkbenchNavigation(mainWindow.webContents, target);

  const load = target.kind === "url" ? mainWindow.loadURL(target.url) : mainWindow.loadFile(target.filePath);
  void load.catch((error) => reportStartupFailure(error));
  return mainWindow;
}

function startDesktopShell({ runtimeBridge, environment = process.env, runtimeCompositionFactory = createDesktopRuntimeComposition } = {}) {
  if (shellStarted) return startup;
  shellStarted = true;
  startupDiagnostic(environment, "start_requested");
  registerLifecycleHandlers();
  startup = app.whenReady()
    .then(async () => {
      startupDiagnostic(environment, "app_ready");
      workbenchTarget = resolveWorkbenchLoadTarget({ environment });
      startupDiagnostic(environment, "workbench_target_resolved");
      runtimeComposition = runtimeBridge
        ? Object.freeze({ source: "injected", runtimeBridge, stop: async () => undefined })
        : await runtimeCompositionFactory({ app, environment });
      startupDiagnostic(environment, "runtime_connected");
      unregisterRuntimeIpc = registerRuntimeIpcFacade({
        ipcMain,
        runtimeBridge: runtimeComposition.runtimeBridge,
        scopeForEvent: (event) => scopeForWorkbenchIpcEvent(event, workbenchTarget),
      });
      createMainWindow(workbenchTarget);
      startupDiagnostic(environment, "window_created");
    })
    .catch(async (error) => {
      shellStarted = false;
      startupDiagnostic(environment, "startup_failed", error instanceof Error ? error.name : "UnknownError");
      await closeRuntimeComposition();
      throw error;
    });
  return startup;
}

function registerLifecycleHandlers() {
  if (lifecycleRegistered) return;
  lifecycleRegistered = true;
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0 && workbenchTarget) createMainWindow(workbenchTarget);
  });
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
  app.on("before-quit", () => {
    void closeRuntimeComposition();
  });
}

async function closeRuntimeComposition() {
  unregisterRuntimeIpc?.();
  unregisterRuntimeIpc = undefined;
  const current = runtimeComposition;
  runtimeComposition = undefined;
  await current?.stop?.();
}

function reportStartupFailure(error) {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`${message}\n`);
}

/** Debug-only stage codes; never include a bridge token, credential, or Provider diagnostic. */
function startupDiagnostic(environment, stage, detail) {
  if (environment.AGENT_WORKSPACE_DESKTOP_DEBUG !== "1") return;
  process.stdout.write(`${JSON.stringify({ type: "agent_workspace_desktop_startup", stage, ...(detail ? { detail: String(detail).slice(0, 160) } : {}) })}\n`);
}

if (isDesktopEntryModule()) {
  void startDesktopShell().catch((error) => {
    reportStartupFailure(error);
    app.quit();
  });
}

/** Electron 42 does not reliably set require.main to the user entry module. */
function isDesktopEntryModule({
  mainModule = require.main,
  moduleRef = module,
  argv = process.argv,
  filename = __filename,
} = {}) {
  const argvEntry = typeof argv[1] === "string" ? path.resolve(argv[1]) : undefined;
  return mainModule === moduleRef
    || argvEntry === filename
    // `electron apps/desktop` is the documented local launch form. Electron
    // records the package directory in argv[1], not its package.json `main`.
    || argvEntry === path.dirname(filename);
}

module.exports = {
  createMainWindow,
  closeRuntimeComposition,
  reportStartupFailure,
  isDesktopEntryModule,
  startDesktopShell,
  startupDiagnostic,
};

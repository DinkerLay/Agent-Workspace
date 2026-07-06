const path = require("node:path");
const { spawn } = require("node:child_process");
const { app, BrowserWindow, ipcMain } = require("electron");
const {
  createConductorToolBridge,
  startConductorToolBridgeHttpServer,
} = require("./conductor-tool-bridge.cjs");
const { ensureNodePtySpawnHelperExecutable } = require("./node-pty-runtime.cjs");
const { inspectOpencodeProcesses } = require("./opencode/process-inspector.cjs");
const { getDispatchAssistantAnswer } = require("./opencode/session-adapter.cjs");
const { getRuntimeStatus, listOpencodeAgents, resolveOpencodePath, runOpencode } = require("./opencode-runner.cjs");
const { createPtyManager } = require("./pty-manager.cjs");
const { createSessionWakeupMonitor } = require("./session-wakeup-monitor.cjs");
const { createSessionStore } = require("./session-store.cjs");
const { generateTaskDraft } = require("./task-draft-assistant.cjs");
const { runVerification } = require("./verification-runner.cjs");

let mainWindow;
let ptyManager;
let conductorToolBridge;
let conductorToolBridgeHttpServer;
let conductorToolBridgeRuntimeConfig = {};
let conductorToolBridgeStartError;
let sessionWakeupMonitor;
let realPtyAvailable = false;
let ptyBackend = "process-fallback";

const runtimeSessionStore = createSessionStore({
  root: ({ cwd }) => {
    if (!cwd) throw new Error("Project cwd is required before resolving the runtime Session Store root.");
    return path.join(cwd, ".agent-workspace", "runtime");
  },
});

try {
  // node-pty is a native optional runtime dependency for the desktop shell.
  // The app can still probe and run one-shot opencode commands without it.
  ensureNodePtySpawnHelperExecutable();
  const pty = require("node-pty");
  ptyManager = createPtyManager({ pty, spawn, sessionStore: runtimeSessionStore });
  ptyManager.onEvent(publishPtyEvent);
  realPtyAvailable = true;
  ptyBackend = "node-pty+process-fallback";
} catch {
  ptyManager = createPtyManager({ spawn, sessionStore: runtimeSessionStore });
  ptyManager.onEvent(publishPtyEvent);
  realPtyAvailable = false;
  ptyBackend = "process-fallback";
}

conductorToolBridge = createConductorToolBridge({
  sessionStore: runtimeSessionStore,
  ptyManager,
  startWorkerSession: async ({ taskId, sessionId }) => {
    const launchContext = findTaskLaunchContext(taskId);
    return ptyManager.start({
      id: sessionId,
      taskId,
      command: resolvePtyCommand("opencode"),
      args: launchContext.args,
      cwd: launchContext.cwd,
      model: launchContext.model,
      cols: 100,
      rows: 30,
      requirePty: realPtyAvailable,
    });
  },
  validateDispatch: ({ taskId, toSessionId }) => {
    if (!taskId || !toSessionId) return { ok: false, reason: "missing-task-or-session" };
    if (!isCanonicalWorkspaceSessionId(toSessionId)) return { ok: false, reason: "invalid-session-id" };
    return { ok: true };
  },
});

sessionWakeupMonitor = createSessionWakeupMonitor({
  ptyManager,
  sessionStore: runtimeSessionStore,
  dispatchResultReader: readProviderDispatchResult,
});
sessionWakeupMonitor.start();

const conductorToolBridgeHttpServerPromise = startConductorToolBridgeHttpServer({ bridge: conductorToolBridge })
  .then((bridgeServer) => {
    conductorToolBridgeHttpServer = bridgeServer;
    conductorToolBridgeRuntimeConfig = {
      conductorToolBridgeUrl: bridgeServer.url,
      conductorToolBridgeToken: bridgeServer.token,
      conductorMcpServerPath: path.join(__dirname, "conductor-mcp-server.cjs"),
    };
    return bridgeServer;
  })
  .catch((error) => {
    conductorToolBridgeStartError = error;
    conductorToolBridgeRuntimeConfig = {
      conductorMcpServerPath: path.join(__dirname, "conductor-mcp-server.cjs"),
    };
    return undefined;
  });

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 960,
    minHeight: 680,
    title: "Agent Workspace",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.cjs"),
    },
  });

  const devServerUrl = process.env.AGENT_WORKSPACE_DEV_SERVER_URL;
  if (devServerUrl) {
    void mainWindow.loadURL(devServerUrl);
    if (process.env.AGENT_WORKSPACE_OPEN_DEVTOOLS === "1") {
      mainWindow.webContents.openDevTools({ mode: "detach" });
    }
    return;
  }

  void mainWindow.loadFile(path.join(__dirname, "..", "dist", "index.html"));
}

app.whenReady().then(() => {
  registerIpc();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  sessionWakeupMonitor?.stop?.();
  void conductorToolBridgeHttpServer?.close?.();
});

function registerIpc() {
  ipcMain.handle("native:get-runtime-status", async () => {
    await conductorToolBridgeHttpServerPromise;
    const status = getRuntimeStatus({
      ptyAvailable: realPtyAvailable,
      ptyBackend,
      ...conductorToolBridgeRuntimeConfig,
    });
    if (conductorToolBridgeStartError) {
      return {
        ...status,
        message: `${status.message} Conductor tool bridge failed: ${
          conductorToolBridgeStartError instanceof Error
            ? conductorToolBridgeStartError.message
            : "unknown error"
        }`,
      };
    }
    return status;
  });

  ipcMain.handle("native:run-opencode", (_event, input) =>
    runOpencode({
      cwd: String(input?.cwd ?? ""),
      message: String(input?.message ?? ""),
      model: input?.model ? String(input.model) : undefined,
      timeoutMs: Number(input?.timeoutMs ?? 120000),
    }),
  );

  ipcMain.handle("native:generate-task-draft", (_event, input) =>
    generateTaskDraft({
      message: String(input?.message ?? ""),
      projectPath: String(input?.projectPath ?? process.cwd()),
      projectName: input?.projectName ? String(input.projectName) : undefined,
      model: input?.model ? String(input.model) : undefined,
      currentDraft: input?.currentDraft && typeof input.currentDraft === "object" ? input.currentDraft : undefined,
      timeoutMs: Number(input?.timeoutMs ?? 120000),
    }),
  );

  ipcMain.handle("native:list-opencode-agents", () => listOpencodeAgents());

  ipcMain.handle("native:inspect-opencode-processes", () => {
    try {
      return {
        ok: true,
        processes: inspectOpencodeProcesses(),
      };
    } catch (error) {
      return {
        ok: false,
        processes: [],
        error: error instanceof Error ? error.message : "Unable to inspect opencode processes.",
      };
    }
  });

  ipcMain.handle("native:run-verification", (_event, input) =>
    runVerification({
      cwd: String(input?.cwd ?? ""),
      runId: String(input?.runId ?? ""),
      command: String(input?.command ?? ""),
      timeoutMs: Number(input?.timeoutMs ?? 120000),
    }),
  );

  ipcMain.handle("native:start-pty", (_event, input) => {
    if (!ptyManager) {
      throw new Error("node-pty is not available in this desktop shell.");
    }

    const sessionId = String(input?.id ?? `pty-${Date.now()}`);
    return ptyManager.start({
      id: sessionId,
      taskId: input?.taskId ? String(input.taskId) : taskIdFromWorkspaceSessionId(sessionId),
      command: resolvePtyCommand(String(input?.command ?? "opencode")),
      args: Array.isArray(input?.args) ? input.args.map(String) : [],
      cwd: String(input?.cwd ?? process.cwd()),
      cols: Number(input?.cols ?? 100),
      rows: Number(input?.rows ?? 30),
      stdin: input?.stdin === "ignore" ? "ignore" : "pipe",
      model: input?.model ? String(input.model) : undefined,
      requirePty: input?.requirePty !== false,
      env: sanitizeEnv(input?.env),
      runtimeFiles: sanitizeRuntimeFiles(input?.runtimeFiles),
    });
  });

  ipcMain.handle("native:get-pty", (_event, input) => ptyManager?.get(String(input?.id ?? "")));

  ipcMain.handle("native:read-pty", (_event, input) =>
    ptyManager?.read(String(input?.id ?? ""), Number(input?.cursor ?? 0)),
  );

  ipcMain.handle("native:write-pty", (_event, input) => ptyManager?.write(String(input?.id ?? ""), String(input?.text ?? "")));

  ipcMain.handle("native:resize-pty", (_event, input) =>
    ptyManager?.resize(String(input?.id ?? ""), {
      cols: Number(input?.cols ?? 100),
      rows: Number(input?.rows ?? 30),
    }),
  );

  ipcMain.handle("native:stop-pty", (_event, input) => ptyManager?.stop(String(input?.id ?? "")));

  ipcMain.handle("native:call-session", (_event, input) => conductorToolBridge.callSession(input));

  ipcMain.handle("native:read-task-state", (_event, input) => conductorToolBridge.readTaskState(input));

  ipcMain.handle("native:read-session", (_event, input) => conductorToolBridge.readSession(input));

  ipcMain.handle("native:append-task-event", (_event, input) => {
    const taskId = String(input?.taskId ?? "");
    const type = String(input?.type ?? "");
    if (!taskId) throw new Error("Task event requires taskId.");
    if (!["task.user_message", "user.intervention"].includes(type)) {
      throw new Error(`Unsupported task event type: ${type}`);
    }

    const event = runtimeSessionStore.recordTaskEvent({
      taskId,
      sessionId: input?.sessionId ? String(input.sessionId) : "",
      cwd: String(input?.cwd ?? ""),
      type,
      summary: String(input?.summary ?? ""),
      data: sanitizeJsonObject(input?.data),
    });
    return {
      ok: true,
      event,
      taskState: runtimeSessionStore.readTaskState({ taskId }),
    };
  });
}

function resolvePtyCommand(command) {
  if (command !== "opencode") return command;
  return resolveOpencodePath() ?? command;
}

function readProviderDispatchResult({ session, dispatch }) {
  if (!isOpencodeSession(session)) return undefined;
  return getDispatchAssistantAnswer({
    dispatchId: dispatch.dispatchId,
    cwd: session.cwd,
    dispatchCreatedAt: dispatch.createdAt,
  }).catch(() => undefined);
}

function isOpencodeSession(session) {
  const provider = String(session?.provider ?? "");
  const command = String(session?.command ?? "");
  return provider === "opencode" || path.basename(command) === "opencode";
}

function findTaskLaunchContext(taskId) {
  const peerSession = ptyManager
    ?.list?.()
    .find((session) => session.taskId === taskId && session.status === "running" && session.cwd);

  return {
    cwd: peerSession?.cwd ?? process.cwd(),
    args: Array.isArray(peerSession?.args) ? withoutNativeAgentArgs(peerSession.args) : [],
    model: peerSession?.model,
  };
}

function isCanonicalWorkspaceSessionId(sessionId) {
  const value = String(sessionId ?? "");
  return /^[a-z0-9-]+:[^:]+:[^:]+:[^:]+$/i.test(value);
}

function withoutNativeAgentArgs(args) {
  const result = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--agent") {
      index += 1;
      continue;
    }
    result.push(args[index]);
  }
  return result;
}

function sanitizeEnv(env) {
  if (!env || typeof env !== "object" || Array.isArray(env)) return undefined;
  return Object.fromEntries(
    Object.entries(env)
      .filter(([key, value]) => typeof key === "string" && typeof value === "string")
      .map(([key, value]) => [key, value]),
  );
}

function sanitizeRuntimeFiles(files) {
  if (!Array.isArray(files)) return [];
  return files
    .filter((file) => file && typeof file === "object")
    .map((file) => ({
      relativePath: String(file.relativePath ?? ""),
      contents: String(file.contents ?? ""),
    }));
}

function sanitizeJsonObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return JSON.parse(JSON.stringify(value));
}

function taskIdFromWorkspaceSessionId(sessionId) {
  const parts = String(sessionId ?? "").split(":");
  return parts.length >= 3 ? parts[2] : undefined;
}

function publishPtyEvent(event) {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send("native:pty-event", event);
    }
  }
}

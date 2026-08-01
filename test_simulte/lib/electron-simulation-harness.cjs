const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { app, BrowserWindow, ipcMain } = require("electron");
const {
  createConductorToolBridge,
  startConductorToolBridgeHttpServer,
} = require("../../desktop/conductor-tool-bridge.cjs");
const { ensureNodePtySpawnHelperExecutable } = require("../../desktop/node-pty-runtime.cjs");
const {
  getDispatchAssistantAnswer,
  inspectDispatchProviderState,
} = require("../../desktop/opencode/session-adapter.cjs");
const { getRuntimeStatus, resolveOpencodePath } = require("../../desktop/opencode-runner.cjs");
const { createPtyManager } = require("../../desktop/pty-manager.cjs");
const { createSessionAuthority } = require("../../desktop/runtime/session-authority.cjs");
const { createSessionWakeupMonitor } = require("../../desktop/session-wakeup-monitor.cjs");
const { createSessionStore } = require("../../desktop/session-store.cjs");

const defaultTimeoutMs = 20_000;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(predicate, label, options = {}) {
  const timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
  const intervalMs = options.intervalMs ?? 100;
  const startedAt = Date.now();
  let lastResult;
  while (Date.now() - startedAt < timeoutMs) {
    lastResult = await predicate();
    if (lastResult) return lastResult;
    await delay(intervalMs);
  }
  throw new Error(`${label} timed out after ${timeoutMs}ms; lastResult=${JSON.stringify(lastResult)}`);
}

async function createElectronSimulationHarness(options = {}) {
  const root = options.root ?? fs.mkdtempSync(path.join(os.tmpdir(), "agent-workspace-e2e-"));
  const projectPath = options.projectPath ?? path.join(root, "project");
  const opencodePath = options.opencodePath ?? resolveOpencodePath();
  if (!opencodePath) {
    throw new Error("Real session dispatch simulation requires a local opencode binary.");
  }
  fs.mkdirSync(projectPath, { recursive: true });

  const sessionStore = createSessionStore({ root: path.join(root, "runtime") });
  const ptyStarts = [];
  const ptyWrites = [];
  const realPtyAvailable = loadNodePtyAvailable();
  if (!realPtyAvailable.pty && options.requireRealPty !== false) {
    throw new Error(
      `Real session dispatch simulation requires node-pty: ${
        realPtyAvailable.error instanceof Error ? realPtyAvailable.error.message : "node-pty unavailable"
      }`,
    );
  }
  const ptyManager = createPtyManager({
    pty: realPtyAvailable.pty,
    spawn,
    sessionStore,
  });
  const rawPtyStart = ptyManager.start;
  const rawPtyWrite = ptyManager.write;
  ptyManager.start = (input) => {
    ptyStarts.push({
      ...input,
      command: input.provider === "opencode" ? "opencode" : input.command,
    });
    return rawPtyStart(input);
  };
  ptyManager.write = (id, text, writeOptions) => {
    ptyWrites.push({ id: String(id ?? ""), text: String(text ?? "") });
    return rawPtyWrite(id, text, writeOptions);
  };
  const openWindows = new Set();
  const sessionAuthority = createSessionAuthority({ ptyManager });

  ptyManager.onEvent((event) => {
    sessionAuthority.handlePtyEvent(event);
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send("native:pty-event", event);
    }
  });

  const conductorToolBridge = createConductorToolBridge({
    sessionStore,
    ptyManager,
    prepareWorkerSession: ({ taskId, sessionId, initialPrompt }) => {
      const model = options.model ?? "opencode-go/deepseek-v4-flash";
      sessionAuthority.registerLaunchProfile({
        workspaceSessionId: sessionId,
        taskId,
        command: opencodePath,
        args: ["--model", model, "--prompt", String(initialPrompt)],
        cwd: projectPath,
        provider: "opencode",
        model,
        cols: 100,
        rows: 30,
        stdin: "pipe",
        requirePty: Boolean(realPtyAvailable.pty),
      });
      return { initialPromptSubmitted: true, sessionId };
    },
    activateWorkerSession: async ({ taskId, sessionId, operationId }) => {
      const activation = await sessionAuthority.activateSession({
        workspaceSessionId: sessionId,
        operationId,
        callerId: "simulation-conductor",
        reason: "conductor-dispatch",
      });
      // This legacy in-process E2E PTY fixture does not expose the production
      // Terminal Runtime's typed `bufferMode` readiness fact. Synchronize the
      // test driver only (never product state) on OpenCode entering its
      // alternate buffer before allowing the Coordinator to write input.
      await waitUntil(
        () => sessionStore.readTerminalLog({ taskId, sessionId, maxBytes: 40_000 }).content.includes("\x1b[?1049h"),
        "OpenCode worker TUI enters alternate buffer",
      );
      await delay(250);
      return activation;
    },
    enqueueWorkerInput: ({ sessionId, expectedIncarnationId, payload, idempotencyKey }) =>
      sessionAuthority.enqueueInput({
        workspaceSessionId: sessionId,
        expectedIncarnationId,
        source: "dispatch",
        payload,
        idempotencyKey,
      }),
    validateDispatch: ({ taskId, toSessionId }) => {
      if (!taskId || !toSessionId) return { ok: false, reason: "missing-task-or-session" };
      if (options.validateDispatch) return options.validateDispatch({ taskId, toSessionId });
      return { ok: true };
    },
  });
  const conductorToolBridgeHttpServer = await startConductorToolBridgeHttpServer({ bridge: conductorToolBridge });
  const sessionWakeupMonitor = createSessionWakeupMonitor({
    ptyManager,
    sessionStore,
    dispatchStateReader: ({ session, dispatch }) => inspectDispatchProviderState({
      dispatchId: dispatch.dispatchId,
      cwd: session.cwd,
      dispatchCreatedAt: dispatch.createdAt,
    }),
    dispatchResultReader: ({ session, dispatch }) => {
      if (!isOpencodeSession(session)) return undefined;
      return getDispatchAssistantAnswer({
        dispatchId: dispatch.dispatchId,
        cwd: session.cwd,
        dispatchCreatedAt: dispatch.createdAt,
      }).catch(() => undefined);
    },
    intervalMs: 0,
    debounceMs: 750,
    idleThresholdMs: 1500,
  });
  sessionWakeupMonitor.start();

  registerIpcHandlers({
    projectPath,
    opencodePath,
    model: options.model,
    ptyManager,
    sessionAuthority,
    ptyStarts,
    ptyWrites,
    conductorToolBridge,
    sessionStore,
    conductorToolBridgeHttpServer,
    realPtyAvailable: Boolean(realPtyAvailable.pty),
    ptyBackend: realPtyAvailable.pty ? "node-pty" : "process-fallback",
  });

  await app.whenReady();

  async function createWindow(html = "<main>Agent Workspace simulation</main>") {
    const window = createBrowserWindow();
    await window.loadURL(`data:text/html,${encodeURIComponent(html)}`);
    return window;
  }

  async function createWindowForUrl(url) {
    const window = createBrowserWindow();
    await window.loadURL(url);
    return window;
  }

  function createBrowserWindow() {
    const window = new BrowserWindow({
      show: false,
      width: 1360,
      height: 900,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        preload: path.join(__dirname, "..", "..", "desktop", "preload.cjs"),
      },
    });
    openWindows.add(window);
    window.once("closed", () => openWindows.delete(window));
    return window;
  }

  async function cleanup() {
    sessionWakeupMonitor.stop();
    for (const session of ptyManager.list()) {
      if (session.status === "running") ptyManager.stop(session.id);
    }
    await waitUntil(
      () => ptyManager.list().every((session) => session.status !== "running" && session.status !== "stopping"),
      "PTY sessions stop during simulation cleanup",
      { timeoutMs: 5_000, intervalMs: 50 },
    ).catch(() => undefined);
    await Promise.all([...openWindows].map(closeWindowQuietly));
    await conductorToolBridgeHttpServer.close().catch(() => undefined);
    ipcMain.removeHandler("native:get-runtime-status");
    ipcMain.removeHandler("native:list-opencode-agents");
    sessionAuthority.close();
    ipcMain.removeHandler("native:register-workspace-session-profile");
    ipcMain.removeHandler("native:activate-workspace-session");
    ipcMain.removeHandler("native:read-workspace-session");
    ipcMain.removeHandler("native:enqueue-terminal-input");
    ipcMain.removeHandler("native:resize-workspace-session");
    ipcMain.removeHandler("native:stop-workspace-session");
    ipcMain.removeHandler("native:call-session");
    ipcMain.removeHandler("native:read-task-state");
    ipcMain.removeHandler("native:read-session");
    ipcMain.removeHandler("native:append-task-event");
  }

  return {
    root,
    projectPath,
    opencodePath,
    ptyManager,
    sessionAuthority,
    sessionStore,
    conductorToolBridge,
    sessionWakeupMonitor,
    ptyStarts,
    ptyWrites,
    createWindow,
    createWindowForUrl,
    cleanup,
  };
}

function registerIpcHandlers(input) {
  ipcMain.handle("native:get-runtime-status", () =>
    getRuntimeStatus({
      ptyAvailable: input.realPtyAvailable,
      ptyBackend: input.ptyBackend,
      conductorToolBridgeUrl: input.conductorToolBridgeHttpServer.url,
      conductorToolBridgeToken: input.conductorToolBridgeHttpServer.token,
      conductorMcpServerPath: path.join(__dirname, "..", "..", "desktop", "conductor-mcp-server.cjs"),
    }),
  );
  ipcMain.handle("native:list-opencode-agents", () => ({ ok: true, agents: [] }));
  ipcMain.handle("native:register-workspace-session-profile", (_event, request) => {
    const workspaceSessionId = String(request?.workspaceSessionId ?? "");
    const model = request?.model ? String(request.model) : input.model ?? "opencode-go/deepseek-v4-flash";
    return input.sessionAuthority.registerLaunchProfile({
      workspaceSessionId,
      taskId: String(request?.taskId ?? taskIdFromWorkspaceSessionId(workspaceSessionId) ?? ""),
      command: input.opencodePath,
      args: ["--model", model],
      cwd: String(request?.cwd ?? input.projectPath),
      provider: "opencode",
      model,
      cols: Number(request?.cols ?? 100),
      rows: Number(request?.rows ?? 30),
      stdin: "pipe",
      requirePty: Boolean(input.realPtyAvailable),
      env: request?.env && typeof request.env === "object" ? request.env : undefined,
      runtimeFiles: Array.isArray(request?.runtimeFiles) ? request.runtimeFiles : [],
    });
  });
  ipcMain.handle("native:activate-workspace-session", (_event, request) =>
    input.sessionAuthority.activateSession({
      workspaceSessionId: String(request?.workspaceSessionId ?? ""),
      operationId: String(request?.operationId ?? ""),
      callerId: "simulation-renderer",
      reason: "user-or-task-runtime",
    }),
  );
  ipcMain.handle("native:read-workspace-session", (_event, request) =>
    input.sessionAuthority.readSession({
      workspaceSessionId: String(request?.workspaceSessionId ?? ""),
      cursor: Number(request?.cursor ?? 0),
    }),
  );
  ipcMain.handle("native:enqueue-terminal-input", (_event, request) =>
    input.sessionAuthority.enqueueInput({
      workspaceSessionId: String(request?.workspaceSessionId ?? ""),
      expectedIncarnationId: String(request?.expectedIncarnationId ?? ""),
      source: String(request?.source ?? ""),
      payload: String(request?.payload ?? ""),
      idempotencyKey: request?.idempotencyKey ? String(request.idempotencyKey) : undefined,
    }),
  );
  ipcMain.handle("native:resize-workspace-session", (_event, request) =>
    input.sessionAuthority.resizeSession({
      workspaceSessionId: String(request?.workspaceSessionId ?? ""),
      expectedIncarnationId: request?.expectedIncarnationId ? String(request.expectedIncarnationId) : undefined,
      cols: Number(request?.cols ?? 100),
      rows: Number(request?.rows ?? 30),
    }),
  );
  ipcMain.handle("native:stop-workspace-session", (_event, request) =>
    input.sessionAuthority.stopSession({
      workspaceSessionId: String(request?.workspaceSessionId ?? ""),
      expectedIncarnationId: request?.expectedIncarnationId ? String(request.expectedIncarnationId) : undefined,
    }),
  );
  ipcMain.handle("native:call-session", (_event, request) => input.conductorToolBridge.callSession(request));
  ipcMain.handle("native:read-task-state", (_event, request) => input.conductorToolBridge.readTaskState(request));
  ipcMain.handle("native:read-session", (_event, request) => input.conductorToolBridge.readSession(request));
  ipcMain.handle("native:append-task-event", (_event, request) => {
    const taskId = String(request?.taskId ?? "");
    const type = String(request?.type ?? "");
    if (!["task.user_message", "user.intervention"].includes(type)) {
      throw new Error(`Unsupported task event type: ${type}`);
    }
    const event = input.sessionStore.recordTaskEvent({
      taskId,
      sessionId: request?.sessionId ? String(request.sessionId) : "",
      cwd: String(request?.cwd ?? input.projectPath),
      type,
      summary: String(request?.summary ?? ""),
      data: sanitizeJsonObject(request?.data),
    });
    const taskState = input.conductorToolBridge.readTaskState({ taskId });
    return makeIpcSafe({ ok: true, event, taskState });
  });
}

function sanitizeJsonObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return JSON.parse(JSON.stringify(value));
}

function makeIpcSafe(value) {
  return JSON.parse(JSON.stringify(value));
}

function taskIdFromWorkspaceSessionId(sessionId) {
  const parts = String(sessionId ?? "").split(":");
  return parts.length >= 3 ? parts[2] : undefined;
}

function closeWindowQuietly(window) {
  if (!window || window.isDestroyed()) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    const timer = setTimeout(() => {
      if (!window.isDestroyed()) window.destroy();
      finish();
    }, 1000);
    timer.unref?.();
    window.once("closed", () => {
      clearTimeout(timer);
      finish();
    });
    window.close();
  });
}

function loadNodePtyAvailable() {
  try {
    ensureNodePtySpawnHelperExecutable();
    return { pty: require("node-pty") };
  } catch (error) {
    return {
      pty: undefined,
      error,
    };
  }
}

function isOpencodeSession(session) {
  const provider = String(session?.provider ?? "");
  const command = String(session?.command ?? "");
  return provider === "opencode" || path.basename(command) === "opencode";
}

module.exports = {
  createElectronSimulationHarness,
  waitUntil,
};

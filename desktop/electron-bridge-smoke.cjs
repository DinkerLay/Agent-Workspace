const { spawn } = require("node:child_process");
const path = require("node:path");
const { app, BrowserWindow, ipcMain } = require("electron");
const { ensureNodePtySpawnHelperExecutable } = require("./node-pty-runtime.cjs");
const { getRuntimeStatus, listOpencodeAgents, runOpencode } = require("./opencode-runner.cjs");
const { createTerminalHost } = require("./runtime/terminal-host.cjs");
const { createSessionAuthority } = require("./runtime/session-authority.cjs");

let ptyManager;
let sessionAuthority;
let ptyBackend = "process-fallback";
let realPtyAvailable = false;

try {
  ensureNodePtySpawnHelperExecutable();
  const pty = require("node-pty");
  ptyManager = createTerminalHost({ pty, spawn });
  realPtyAvailable = true;
  ptyBackend = "node-pty+process-fallback";
} catch (error) {
  ptyManager = createTerminalHost({ spawn });
  ptyBackend = `process-fallback:${error instanceof Error ? error.message : "node-pty unavailable"}`;
}

sessionAuthority = createSessionAuthority({ ptyManager });
ptyManager.onEvent((event) => {
  sessionAuthority.handlePtyEvent(event);
  publishPtyEvent(event);
});

function registerIpc() {
  ipcMain.handle("native:get-runtime-status", () =>
    getRuntimeStatus({
      ptyAvailable: realPtyAvailable,
      ptyBackend,
    }),
  );

  ipcMain.handle("native:list-opencode-agents", () => listOpencodeAgents());

  ipcMain.handle("native:run-opencode", (_event, input) =>
    runOpencode({
      cwd: String(input?.cwd ?? ""),
      message: String(input?.message ?? ""),
      model: input?.model ? String(input.model) : undefined,
      timeoutMs: Number(input?.timeoutMs ?? 120000),
    }),
  );

  ipcMain.handle("native:register-workspace-session-profile", (_event, input) =>
    sessionAuthority.registerLaunchProfile({
      workspaceSessionId: String(input?.workspaceSessionId ?? ""),
      taskId: String(input?.taskId ?? "electron-smoke-task"),
      command: "/bin/cat",
      args: [],
      cwd: String(input?.cwd ?? process.cwd()),
      provider: "smoke-cat",
      cols: Number(input?.cols ?? 100),
      rows: Number(input?.rows ?? 30),
      requirePty: true,
    }),
  );
  ipcMain.handle("native:activate-workspace-session", (_event, input) =>
    sessionAuthority.activateSession({
      workspaceSessionId: String(input?.workspaceSessionId ?? ""),
      operationId: String(input?.operationId ?? ""),
      callerId: "electron-smoke-renderer",
    }),
  );
  ipcMain.handle("native:read-workspace-session", (_event, input) =>
    sessionAuthority.readSession({
      workspaceSessionId: String(input?.workspaceSessionId ?? ""),
      cursor: Number(input?.cursor ?? 0),
    }),
  );
  ipcMain.handle("native:attach-terminal-client", (_event, input) =>
    ptyManager.attachClient({
      id: String(input?.sessionId ?? ""),
      clientId: String(input?.clientId ?? ""),
      generation: String(input?.generation ?? ""),
    }),
  );
  ipcMain.handle("native:ack-terminal-output", (_event, input) =>
    ptyManager.acknowledgeOutput({
      id: String(input?.sessionId ?? ""),
      clientId: String(input?.clientId ?? ""),
      generation: String(input?.generation ?? ""),
      cursor: Number(input?.cursor ?? 0),
    }),
  );
  ipcMain.handle("native:detach-terminal-client", (_event, input) =>
    ptyManager.detachClient({
      id: String(input?.sessionId ?? ""),
      clientId: String(input?.clientId ?? ""),
      generation: String(input?.generation ?? ""),
    }),
  );
  ipcMain.handle("native:enqueue-terminal-input", (_event, input) =>
    sessionAuthority.enqueueInput({
      workspaceSessionId: String(input?.workspaceSessionId ?? ""),
      expectedIncarnationId: String(input?.expectedIncarnationId ?? ""),
      source: String(input?.source ?? ""),
      payload: String(input?.payload ?? ""),
      idempotencyKey: input?.idempotencyKey ? String(input.idempotencyKey) : undefined,
    }),
  );
  ipcMain.handle("native:resize-workspace-session", (_event, input) =>
    sessionAuthority.resizeSession({
      workspaceSessionId: String(input?.workspaceSessionId ?? ""),
      expectedIncarnationId: input?.expectedIncarnationId ? String(input.expectedIncarnationId) : undefined,
      cols: Number(input?.cols ?? 100),
      rows: Number(input?.rows ?? 30),
    }),
  );
  ipcMain.handle("native:stop-workspace-session", (_event, input) =>
    sessionAuthority.stopSession({
      workspaceSessionId: String(input?.workspaceSessionId ?? ""),
      expectedIncarnationId: input?.expectedIncarnationId ? String(input.expectedIncarnationId) : undefined,
    }),
  );
}

function publishPtyEvent(event) {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send("native:pty-event", event);
    }
  }
}

async function main() {
  registerIpc();

  const window = new BrowserWindow({
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.cjs"),
    },
  });

  await window.loadURL("data:text/html,<main>Agent Workspace Electron bridge smoke</main>");

  const result = await window.webContents.executeJavaScript(
    `(${async (cwd) => {
      const bridge = window.agentWorkspace?.native;
      if (!bridge) return { ok: false, error: "native bridge missing" };

      const status = await bridge.getRuntimeStatus();
      const opencodeAgents = await bridge.listOpencodeAgents();
      const ptyEvents = [];
      const unsubscribe = bridge.onPtyEvent?.((event) => ptyEvents.push(event));
      await bridge.registerWorkspaceSessionProfile({
        workspaceSessionId: "electron-smoke",
        taskId: "electron-smoke-task",
        provider: "opencode",
        cwd,
        cols: 80,
        rows: 24,
      });
      const activation = await bridge.activateWorkspaceSession({
        workspaceSessionId: "electron-smoke",
        operationId: "electron-smoke-activate",
      });
      const session = activation.session;
      const resizedSession = await bridge.resizeWorkspaceSession({
        workspaceSessionId: "electron-smoke",
        expectedIncarnationId: session.incarnationId,
        cols: 96,
        rows: 28,
      });
      await bridge.enqueueTerminalInput({
        workspaceSessionId: "electron-smoke",
        expectedIncarnationId: session.incarnationId,
        source: "user",
        payload: "electron-write-ok\\r",
      });
      await new Promise((resolve) => setTimeout(resolve, 250));
      const attached = await bridge.attachTerminalClient({ sessionId: "electron-smoke", clientId: "smoke-panel", generation: "generation-1" });
      const acknowledged = await bridge.acknowledgeTerminalOutput({
        sessionId: "electron-smoke",
        clientId: "smoke-panel",
        generation: "generation-1",
        cursor: attached?.snapshot?.cursor ?? 0,
      });
      const nextSession = await bridge.readWorkspaceSession({ workspaceSessionId: "electron-smoke", cursor: 0 });
      await bridge.stopWorkspaceSession({
        workspaceSessionId: "electron-smoke",
        expectedIncarnationId: session.incarnationId,
      });
      unsubscribe?.();

      return {
        ok: Boolean(
          status.available &&
            status.ptyAvailable &&
            session.backend === "pty" &&
            resizedSession?.cols === 96 &&
            resizedSession?.rows === 28 &&
            attached?.snapshot?.cursor >= 1 &&
            attached?.snapshot?.ansi.includes("electron-write-ok") &&
            acknowledged?.accepted &&
            ptyEvents.some((event) => event.type === "data" && event.chunk.includes("electron-write-ok")),
        ),
        status,
        opencodeAgents,
        session: {
          backend: session.backend,
          status: nextSession?.status,
          cols: nextSession?.cols,
          rows: nextSession?.rows,
          snapshotCursor: attached?.snapshot?.cursor,
          snapshot: attached?.snapshot?.ansi ?? "",
          events: ptyEvents,
        },
      };
    }})(${JSON.stringify(process.cwd())})`,
  );

  console.log(JSON.stringify(result, null, 2));
  app.exit(result.ok ? 0 : 1);
}

app.whenReady().then(main).catch((error) => {
  console.error(error);
  app.exit(1);
});

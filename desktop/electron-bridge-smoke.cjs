const { spawn } = require("node:child_process");
const { app, BrowserWindow, ipcMain } = require("electron");
const { ensureNodePtySpawnHelperExecutable } = require("./node-pty-runtime.cjs");
const { getRuntimeStatus, listOpencodeAgents, resolveOpencodePath, runOpencode } = require("./opencode-runner.cjs");
const { createPtyManager } = require("./pty-manager.cjs");

let ptyManager;
let ptyBackend = "process-fallback";
let realPtyAvailable = false;

try {
  ensureNodePtySpawnHelperExecutable();
  const pty = require("node-pty");
  ptyManager = createPtyManager({ pty, spawn });
  ptyManager.onEvent(publishPtyEvent);
  realPtyAvailable = true;
  ptyBackend = "node-pty+process-fallback";
} catch (error) {
  ptyManager = createPtyManager({ spawn });
  ptyManager.onEvent(publishPtyEvent);
  ptyBackend = `process-fallback:${error instanceof Error ? error.message : "node-pty unavailable"}`;
}

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

  ipcMain.handle("native:start-pty", (_event, input) =>
    ptyManager.start({
      id: String(input?.id ?? `pty-${Date.now()}`),
      command: String(input?.command ?? "opencode"),
      args: Array.isArray(input?.args) ? input.args.map(String) : [],
      cwd: String(input?.cwd ?? process.cwd()),
      cols: Number(input?.cols ?? 100),
      rows: Number(input?.rows ?? 30),
      stdin: input?.stdin === "ignore" ? "ignore" : "pipe",
      model: input?.model ? String(input.model) : undefined,
      requirePty: input?.requirePty !== false,
    }),
  );

  ipcMain.handle("native:get-pty", (_event, input) => ptyManager.get(String(input?.id ?? "")));
  ipcMain.handle("native:read-pty", (_event, input) =>
    ptyManager.read(String(input?.id ?? ""), Number(input?.cursor ?? 0)),
  );
  ipcMain.handle("native:write-pty", (_event, input) => ptyManager.write(String(input?.id ?? ""), String(input?.text ?? "")));
  ipcMain.handle("native:resize-pty", (_event, input) =>
    ptyManager.resize(String(input?.id ?? ""), {
      cols: Number(input?.cols ?? 100),
      rows: Number(input?.rows ?? 30),
    }),
  );
  ipcMain.handle("native:stop-pty", (_event, input) => ptyManager.stop(String(input?.id ?? "")));
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
      const session = await bridge.startPty({
        id: "electron-smoke",
        command: "/bin/cat",
        args: [],
        cwd,
        cols: 80,
        rows: 24,
        requirePty: true,
      });
      const resizedSession = await bridge.resizePty({ id: "electron-smoke", cols: 96, rows: 28 });
      await bridge.writePty({ id: "electron-smoke", text: "electron-write-ok\\r" });
      await new Promise((resolve) => setTimeout(resolve, 250));
      const deltaSession = await bridge.readPty({ id: "electron-smoke", cursor: 0 });
      const nextSession = await bridge.getPty({ id: "electron-smoke" });
      await bridge.stopPty({ id: "electron-smoke" });
      unsubscribe?.();

      return {
        ok: Boolean(
          status.available &&
            status.ptyAvailable &&
            session.backend === "pty" &&
            resizedSession?.cols === 96 &&
            resizedSession?.rows === 28 &&
            deltaSession?.cursor >= 1 &&
            deltaSession?.transcript?.join("").includes("electron-write-ok") &&
            nextSession?.transcript?.join("").includes("electron-write-ok") &&
            ptyEvents.some((event) => event.type === "data" && event.chunk.includes("electron-write-ok")),
        ),
        status,
        opencodeAgents,
        session: {
          backend: session.backend,
          status: nextSession?.status,
          cols: nextSession?.cols,
          rows: nextSession?.rows,
          deltaCursor: deltaSession?.cursor,
          transcript: nextSession?.transcript?.join("") ?? "",
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

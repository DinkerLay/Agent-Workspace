const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { app, BrowserWindow, ipcMain } = require("electron");
const {
  createConductorToolBridge,
  startConductorToolBridgeHttpServer,
} = require("./conductor-tool-bridge.cjs");
const { ensureNodePtySpawnHelperExecutable } = require("./node-pty-runtime.cjs");
const { inspectOpencodeProcesses } = require("./opencode/process-inspector.cjs");
const {
  getRuntimeStatus,
  listOpencodeAgents,
  resolveOpencodePath,
  runOpencode,
} = require("./opencode-runner.cjs");
const { createPtyManager } = require("./pty-manager.cjs");
const { createSessionStore } = require("./session-store.cjs");

const baseTargetUrl = process.env.AGENT_WORKSPACE_SMOKE_URL ?? "http://127.0.0.1:5188/";
const targetProjectPath = process.env.AGENT_WORKSPACE_PROJECT_PATH ?? "/Users/dinker/CODES/Agent-Workspace";
const targetProjectName = process.env.AGENT_WORKSPACE_PROJECT_NAME ?? path.basename(targetProjectPath);
const taskTitle = process.env.AGENT_WORKSPACE_TASK_TITLE ?? "Native Conductor smoke";
const taskSummary =
  process.env.AGENT_WORKSPACE_TASK_SUMMARY ??
  "验证 Task Home 启动 Conductor，IDE 手动启动 provider-native worker。";
const taskTemplate = process.env.AGENT_WORKSPACE_TASK_TEMPLATE ?? "research";
const targetUrl = buildTargetUrl(baseTargetUrl);
const timeoutMs = Number(process.env.AGENT_WORKSPACE_SMOKE_TIMEOUT_MS ?? 25000);
const smokeRoot = path.join(os.tmpdir(), "agent-workspace-task-home-native-smoke");

let ptyManager;
let sessionStore;
let conductorToolBridge;
let conductorToolBridgeHttpServer;
let ptyBackend = "process-fallback";
let realPtyAvailable = false;

const ptyStarts = [];
const ptyWrites = [];

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout(promise, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    }),
  ]);
}

async function waitUntil(predicate, label) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const result = await predicate();
    if (result) return result;
    await delay(100);
  }
  throw new Error(`${label} timed out after ${timeoutMs}ms`);
}

async function waitFor(window, expression, label) {
  return waitUntil(() => window.webContents.executeJavaScript(expression), label);
}

function runtimeStoreRoot() {
  return path.join(smokeRoot, "runtime");
}

function buildTargetUrl(input) {
  const url = new URL(input);
  if (!url.searchParams.has("projectPath")) url.searchParams.set("projectPath", targetProjectPath);
  if (!url.searchParams.has("projectName")) url.searchParams.set("projectName", targetProjectName);
  return url.toString();
}

function expectedAgentRoleIds(template) {
  if (template === "research") return ["conductor", "researcher", "reviewer"];
  if (template === "product-logic") return ["conductor", "planner", "reviewer"];
  if (template === "spec-plan") return ["conductor", "planner", "reviewer"];
  if (template === "debug-fix") return ["conductor", "executor", "qa"];
  return ["conductor", "executor", "qa"];
}

function expectedSessionIds() {
  return expectedAgentRoleIds(taskTemplate).map(
    (roleId) => `opencode:project-runtime-current:task-intake-001:task-intake-001-${roleId}`,
  );
}

function resolvePtyCommand(command) {
  if (command !== "opencode") return command;
  return resolveOpencodePath() ?? command;
}

function registerIpc() {
  ipcMain.handle("native:get-runtime-status", () =>
    getRuntimeStatus({
      ptyAvailable: realPtyAvailable,
      ptyBackend,
      conductorToolBridgeUrl: conductorToolBridgeHttpServer.url,
      conductorToolBridgeToken: conductorToolBridgeHttpServer.token,
      conductorMcpServerPath: path.join(__dirname, "conductor-mcp-server.cjs"),
    }),
  );
  ipcMain.handle("native:list-opencode-agents", () => listOpencodeAgents());
  ipcMain.handle("native:inspect-opencode-processes", () => ({ ok: true, processes: inspectOpencodeProcesses() }));
  ipcMain.handle("native:run-opencode", (_event, input) =>
    runOpencode({
      cwd: String(input?.cwd ?? ""),
      message: String(input?.message ?? ""),
      model: input?.model ? String(input.model) : undefined,
      timeoutMs: Number(input?.timeoutMs ?? 120000),
    }),
  );
  ipcMain.handle("native:start-pty", (_event, input) => {
    const startInput = {
      id: String(input?.id ?? `pty-${Date.now()}`),
      command: String(input?.command ?? "opencode"),
      args: Array.isArray(input?.args) ? input.args.map(String) : [],
      cwd: String(input?.cwd ?? process.cwd()),
      cols: Number(input?.cols ?? 100),
      rows: Number(input?.rows ?? 30),
      stdin: input?.stdin === "ignore" ? "ignore" : "pipe",
      model: input?.model ? String(input.model) : undefined,
      requirePty: input?.requirePty !== false,
      env: input?.env && typeof input.env === "object" ? input.env : undefined,
      runtimeFiles: Array.isArray(input?.runtimeFiles) ? input.runtimeFiles : [],
    };
    ptyStarts.push(startInput);
    return ptyManager.start({
      ...startInput,
      command: resolvePtyCommand(startInput.command),
    });
  });
  ipcMain.handle("native:get-pty", (_event, input) => ptyManager.get(String(input?.id ?? "")));
  ipcMain.handle("native:read-pty", (_event, input) =>
    ptyManager.read(String(input?.id ?? ""), Number(input?.cursor ?? 0)),
  );
  ipcMain.handle("native:write-pty", (_event, input) => {
    const write = { id: String(input?.id ?? ""), text: String(input?.text ?? "") };
    ptyWrites.push(write);
    return ptyManager.write(write.id, write.text);
  });
  ipcMain.handle("native:resize-pty", (_event, input) =>
    ptyManager.resize(String(input?.id ?? ""), {
      cols: Number(input?.cols ?? 100),
      rows: Number(input?.rows ?? 30),
    }),
  );
  ipcMain.handle("native:stop-pty", (_event, input) => ptyManager.stop(String(input?.id ?? "")));
  ipcMain.handle("native:call-session", (_event, input) => conductorToolBridge.callSession(input));
  ipcMain.handle("native:read-task-state", (_event, input) => conductorToolBridge.readTaskState(input));
  ipcMain.handle("native:read-session", (_event, input) => conductorToolBridge.readSession(input));
}

function publishPtyEvent(event) {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send("native:pty-event", event);
    }
  }
}

async function clickButton(window, predicateSource, label) {
  await window.webContents.executeJavaScript(`
    (() => {
      const predicate = ${predicateSource};
      const button = Array.from(document.querySelectorAll("button")).find(predicate);
      if (!button) throw new Error(${JSON.stringify(`Missing button: ${label}`)});
      button.click();
    })()
  `);
}

async function createTask(window) {
  await window.webContents.executeJavaScript(`
    (() => {
      const setValue = (selector, value) => {
        const element = document.querySelector(selector);
        if (!element) throw new Error("Missing selector " + selector);
        const prototype =
          element instanceof HTMLTextAreaElement
            ? HTMLTextAreaElement.prototype
            : element instanceof HTMLSelectElement
              ? HTMLSelectElement.prototype
              : HTMLInputElement.prototype;
        const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
        descriptor.set.call(element, value);
        element.dispatchEvent(new Event("input", { bubbles: true }));
        element.dispatchEvent(new Event("change", { bubbles: true }));
      };

      setValue('input[aria-label="任务标题"]', ${JSON.stringify(taskTitle)});
      setValue('textarea[aria-label="任务目标"]', ${JSON.stringify(taskSummary)});
      setValue('select[aria-label="任务模板"]', ${JSON.stringify(taskTemplate)});
      const submit = document.querySelector("form.task-home-intake-form button[type=submit]");
      if (!submit) throw new Error("Missing task submit button");
      submit.click();
    })()
  `);
  await waitFor(window, `document.body.innerText.includes("Conductor Terminal")`, "task creation");
}

async function setupRuntime() {
  fs.rmSync(smokeRoot, { recursive: true, force: true });
  fs.mkdirSync(smokeRoot, { recursive: true });
  sessionStore = createSessionStore({ root: runtimeStoreRoot() });

  try {
    ensureNodePtySpawnHelperExecutable();
    const pty = require("node-pty");
    ptyManager = createPtyManager({ pty, spawn, sessionStore });
    realPtyAvailable = true;
    ptyBackend = "node-pty+process-fallback";
  } catch (error) {
    ptyManager = createPtyManager({ spawn, sessionStore });
    ptyBackend = `process-fallback:${error instanceof Error ? error.message : "node-pty unavailable"}`;
  }
  ptyManager.onEvent(publishPtyEvent);

  conductorToolBridge = createConductorToolBridge({
    sessionStore,
    ptyManager,
    startWorkerSession: async ({ taskId, sessionId }) =>
      ptyManager.start({
        id: sessionId,
        taskId,
        command: resolvePtyCommand("opencode"),
        cwd: targetProjectPath,
        cols: 100,
        rows: 30,
        requirePty: realPtyAvailable,
      }),
    validateDispatch: ({ taskId, toSessionId }) => {
      if (!taskId || !toSessionId) return { ok: false, reason: "missing-task-or-session" };
      return { ok: true };
    },
  });
  conductorToolBridgeHttpServer = await startConductorToolBridgeHttpServer({ bridge: conductorToolBridge });
}

async function main() {
  app.commandLine.appendSwitch("disable-gpu");
  await setupRuntime();
  registerIpc();
  await app.whenReady();

  const window = new BrowserWindow({
    show: false,
    width: 1360,
    height: 900,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.cjs"),
    },
  });

  await withTimeout(window.loadURL(targetUrl), `load ${targetUrl}`);
  await waitFor(window, `Boolean(window.agentWorkspace?.native)`, "native preload");
  await waitFor(window, `Boolean(document.querySelector(".task-home-intake-form"))`, "Task Home intake");
  const initialTextCheck = await window.webContents.executeJavaScript(`
    (() => {
      const text = document.body.innerText;
      return {
        hasNoTaskCopy: text.includes("还没有任务"),
        hasPreview: text.includes("Conductor Runtime 预览"),
        hasMcpTools:
          text.includes("MCP tools") &&
          text.includes("call_session") &&
          text.includes("read_task_state") &&
          text.includes("read_session") &&
          !text.includes("finish_task_claim"),
        hasNativeWorkerCopy: text.includes("Worker sessions") && text.includes("原生 session，不注入 Agent Workspace 协议"),
        hasOldProtocolCopy: text.includes("Workspace Session Message"),
      };
    })()
  `);

  const before = inspectOpencodeProcesses().length;
  await createTask(window);

  const sessionIds = expectedSessionIds();
  const conductorSessionId = sessionIds[0];
  const workerSessionId = sessionIds[1];

  await waitUntil(() => ptyStarts.length === 1, "Conductor-only auto start");
  await waitFor(window, `Array.from(document.querySelectorAll("button")).some((item) => item.innerText.includes("Conductor 运行中"))`, "auto-started Conductor");
  await waitFor(
    window,
    `Boolean(document.querySelector('[aria-label="Conductor terminal output"] .xterm'))`,
    "Conductor xterm mount",
  );
  await waitFor(
    window,
    `window.agentWorkspace.native.getPty({ id: ${JSON.stringify(conductorSessionId)} }).then((session) => session?.status === "running")`,
    "Conductor PTY running",
  );

  const conductorStart = ptyStarts[0];
  const conductorRuntimeConfig = JSON.stringify(conductorStart.env ?? {});
  const conductorRuntimeFiles = JSON.stringify(conductorStart.runtimeFiles ?? []);
  const noWorkerAutoStart = ptyStarts.every((input) => !String(input.id).includes("researcher") && !String(input.id).includes("reviewer"));
  const conductorKickoff = await waitUntil(
    () =>
      ptyWrites.find(
        (write) =>
          write.id === conductorSessionId &&
          write.text.includes("Start this Agent Workspace task now.") &&
          write.text.includes(taskTitle) &&
          write.text.includes("Use call_session when a worker should do work"),
      ),
    "Conductor kickoff write",
  );

  await clickButton(window, `(button) => button.getAttribute("aria-label") === "IDE 工作台"`, "IDE 工作台");
  await waitFor(window, `document.body.innerText.includes("Conductor 对话 Terminal")`, "Workbench Conductor");
  await clickButton(window, `(button) => button.innerText.includes("Agent 列表")`, "Agent 列表");
  await clickButton(window, `(button) => button.getAttribute("aria-label") === "选择 Researcher agent"`, "Researcher agent");
  await waitFor(window, `document.body.innerText.includes("Researcher 对话 Terminal")`, "Workbench Researcher");
  const workerScopeText = await window.webContents.executeJavaScript(
    `document.body.innerText.includes("Worker sessions 保持原生") && document.body.innerText.includes("语义状态来自 provider adapter")`,
  );
  await clickButton(window, `(button) => button.innerText.includes("启动 opencode PTY")`, "启动 opencode PTY");
  await waitUntil(() => ptyStarts.length === 2, "manual worker start");
  await waitFor(
    window,
    `window.agentWorkspace.native.getPty({ id: ${JSON.stringify(workerSessionId)} }).then((session) => session?.status === "running")`,
    "Worker PTY running",
  );

  const workerStart = ptyStarts[1];
  const workerRuntime = JSON.stringify({
    env: workerStart.env ?? {},
    runtimeFiles: workerStart.runtimeFiles ?? [],
    args: workerStart.args ?? [],
  });

  const terminalTextCheck = await window.webContents.executeJavaScript(`
    (() => {
      const terminal = document.querySelector('[aria-label="Agent terminal transcript"]');
      const text = terminal?.innerText ?? "";
      return {
        hasXterm: Boolean(terminal?.querySelector(".xterm")),
        leaksAnsi: text.includes("[?203") || text.includes("[?25") || text.includes("[38;5") || text.includes("\\u001b["),
        textSample: text.slice(0, 240),
      };
    })()
  `);

  await window.webContents.executeJavaScript(
    `Promise.all(${JSON.stringify([conductorSessionId, workerSessionId])}.map((id) => window.agentWorkspace.native.stopPty({ id })))`,
  );
  await waitFor(
    window,
    `Promise.all(${JSON.stringify([conductorSessionId, workerSessionId])}.map((id) => window.agentWorkspace.native.getPty({ id }))).then((sessions) => sessions.every((session) => session?.status === "stopped"))`,
    "PTY sessions stopped",
  );
  const stopped = inspectOpencodeProcesses().length;

  const ok =
    initialTextCheck.hasNoTaskCopy &&
    initialTextCheck.hasPreview &&
    initialTextCheck.hasMcpTools &&
    initialTextCheck.hasNativeWorkerCopy &&
    !initialTextCheck.hasOldProtocolCopy &&
    conductorStart.id === conductorSessionId &&
    conductorStart.cwd === targetProjectPath &&
    !conductorStart.args.includes("--agent") &&
    conductorRuntimeConfig.includes("AGENT_WORKSPACE_TOOL_BRIDGE_URL") &&
    conductorRuntimeConfig.includes("AGENT_WORKSPACE_TOOL_BRIDGE_TOKEN") &&
    conductorRuntimeConfig.includes("agent_workspace_conductor") &&
    conductorRuntimeFiles.includes("Use call_session to assign session-level work") &&
    conductorRuntimeFiles.includes("read_task_state") &&
    conductorRuntimeFiles.includes("read_session") &&
    !conductorRuntimeFiles.includes("Workspace Session Message") &&
    noWorkerAutoStart &&
    conductorKickoff.text.includes(workerSessionId) &&
    !conductorKickoff.text.includes("Workspace Session Message") &&
    !ptyWrites.some((write) => write.id === workerSessionId && write.text.includes("Workspace Session Message")) &&
    workerScopeText &&
    workerStart.id === workerSessionId &&
    workerStart.cwd === targetProjectPath &&
    !workerRuntime.includes("AGENT_WORKSPACE_TOOL_BRIDGE_URL") &&
    !workerRuntime.includes("agent_workspace_conductor") &&
    !workerRuntime.includes("Workspace Session Message") &&
    !(workerStart.args ?? []).includes("--agent") &&
    terminalTextCheck.hasXterm &&
    !terminalTextCheck.leaksAnsi;

  console.log(
    JSON.stringify(
      {
        ok,
        targetUrl,
        targetProjectPath,
        taskTitle,
        before,
        stopped,
        ptyBackend,
        realPtyAvailable,
        sessionIds,
        initialTextCheck,
        noWorkerAutoStart,
        conductorKickoff: {
          id: conductorKickoff.id,
          bytes: conductorKickoff.text.length,
          hasTaskTitle: conductorKickoff.text.includes(taskTitle),
          hasCallSessionInstruction: conductorKickoff.text.includes("Use call_session when a worker should do work"),
          hasWorkerSessionId: conductorKickoff.text.includes(workerSessionId),
        },
        conductorStart: {
          id: conductorStart.id,
          cwd: conductorStart.cwd,
          args: conductorStart.args,
          hasBridgeUrl: conductorRuntimeConfig.includes("AGENT_WORKSPACE_TOOL_BRIDGE_URL"),
          hasBridgeToken: conductorRuntimeConfig.includes("AGENT_WORKSPACE_TOOL_BRIDGE_TOKEN"),
          hasMcpConfig: conductorRuntimeConfig.includes("agent_workspace_conductor"),
          hasCallSessionPrompt: conductorRuntimeFiles.includes("Use call_session to assign session-level work"),
          hasReadTaskStatePrompt: conductorRuntimeFiles.includes("read_task_state"),
        },
        workerStart: {
          id: workerStart.id,
          cwd: workerStart.cwd,
          args: workerStart.args,
          hasAgentWorkspaceEnv: workerRuntime.includes("AGENT_WORKSPACE_TOOL_BRIDGE_URL"),
          hasRuntimeFiles: (workerStart.runtimeFiles ?? []).length > 0,
        },
        ptyWriteCount: ptyWrites.length,
        terminalTextCheck,
      },
      null,
      2,
    ),
  );

  await conductorToolBridgeHttpServer.close();
  app.exit(ok ? 0 : 1);
}

main().catch(async (error) => {
  console.error(error);
  try {
    await conductorToolBridgeHttpServer?.close?.();
  } catch {
    // Ignore close errors in smoke failure cleanup.
  }
  app.exit(1);
});

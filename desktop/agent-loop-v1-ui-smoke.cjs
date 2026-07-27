const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { app, BrowserWindow, ipcMain } = require("electron");
const { createOrcaTerminalDaemonManager } = require("./runtime/orca-terminal-daemon-manager.cjs");
const { createOrcaTerminalDaemonSupervisor } = require("./runtime/orca-terminal-daemon-supervisor.cjs");
const { ensureNodePtySpawnHelperExecutable } = require("./node-pty-runtime.cjs");
const { createAgentLoopV1Runtime } = require("./runtime/agent-loop-v1-runtime.cjs");
const { createSessionAuthority } = require("./runtime/session-authority.cjs");
const { createSessionStore } = require("./session-store.cjs");

const smokeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-loop-v1-ui-"));
const fakeOpenCode = path.join(smokeRoot, "fake-opencode.sh");
fs.writeFileSync(fakeOpenCode, "#!/bin/sh\nprintf 'OpenCode TUI ready\\n'\nwhile IFS= read -r line; do printf '%s\\n' \"$line\"; done\n", { mode: 0o755 });

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
async function waitUntil(predicate, label, timeoutMs = 12_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(80);
  }
  throw new Error(`${label} timed out`);
}

function installIpc({ runtime, sessionAuthority, ptyManager, sessionStore }) {
  ipcMain.handle("native:get-runtime-status", () => ({ available: true, mode: "desktop", message: "smoke" }));
  ipcMain.handle("native:list-agent-loop-templates", () => runtime.listTemplates());
  ipcMain.handle("native:generate-agent-loop-template", (_event, input) => runtime.generateTemplateDraft(input));
  ipcMain.handle("native:save-agent-loop-template", (_event, input) => runtime.saveTemplate(input));
  ipcMain.handle("native:copy-agent-loop-template", (_event, input) => runtime.copyTemplate(input));
  ipcMain.handle("native:archive-agent-loop-template", (_event, input) => runtime.archiveTemplate(input));
  ipcMain.handle("native:delete-agent-loop-template", (_event, input) => runtime.deleteTemplate(input));
  ipcMain.handle("native:create-agent-loop-task", (_event, input) => runtime.createTask(input));
  ipcMain.handle("native:list-agent-loop-tasks", () => runtime.listTasks());
  ipcMain.handle("native:read-agent-loop-task", (_event, input) => runtime.readTask(input));
  ipcMain.handle("native:start-agent-loop-run", (_event, input) => runtime.startRun(input));
  ipcMain.handle("native:read-agent-loop-run", (_event, input) => runtime.readRun(input));
  ipcMain.handle("native:read-agent-loop-workbench-layout", (_event, input) => runtime.readWorkbenchLayout(input));
  ipcMain.handle("native:save-agent-loop-workbench-layout", (_event, input) => runtime.saveWorkbenchLayout(input));
  ipcMain.handle("native:read-agent-loop-artifact", (_event, input) => runtime.readArtifact(input));
  ipcMain.handle("native:mark-agent-loop-task-achieved", (_event, input) => runtime.markTaskAchieved(input));
  ipcMain.handle("native:append-task-event", (_event, input) => runtime.recordUserMessage({
    taskId: String(input?.taskId ?? ""),
    message: String(input?.data?.message ?? input?.summary ?? ""),
    data: input?.data && typeof input.data === "object" ? input.data : {},
  }));
  ipcMain.handle("native:read-workspace-session", (_event, input) => sessionAuthority.readSession({ workspaceSessionId: String(input?.workspaceSessionId ?? ""), cursor: Number(input?.cursor ?? 0) }));
  ipcMain.handle("native:read-workspace-terminal-log", (_event, input) => {
    const taskId = String(input?.taskId ?? "");
    const sessionId = String(input?.workspaceSessionId ?? "");
    const task = runtime.readTask({ taskId });
    assert.ok(task, "terminal diagnostic log task must exist");
    assert.ok(Object.hasOwn(runtime.taskAgentMap({ taskId }), sessionId), "terminal diagnostic log session must belong to task");
    return sessionStore.readTerminalLog({ taskId, sessionId, cwd: task.cwd, maxBytes: Number(input?.maxBytes ?? 512 * 1024) });
  });
  ipcMain.handle("native:attach-terminal-client", (_event, input) => ptyManager.attachClient({
    id: String(input?.sessionId ?? ""),
    clientId: String(input?.clientId ?? ""),
    generation: String(input?.generation ?? ""),
  }));
  ipcMain.handle("native:ack-terminal-output", (_event, input) => ptyManager.acknowledgeOutput({
    id: String(input?.sessionId ?? ""),
    clientId: String(input?.clientId ?? ""),
    generation: String(input?.generation ?? ""),
    cursor: Number(input?.cursor ?? 0),
  }));
  ipcMain.handle("native:detach-terminal-client", (_event, input) => ptyManager.detachClient({
    id: String(input?.sessionId ?? ""),
    clientId: String(input?.clientId ?? ""),
    generation: String(input?.generation ?? ""),
  }));
  ipcMain.handle("native:enqueue-terminal-input", (_event, input) => sessionAuthority.enqueueInput({ workspaceSessionId: String(input?.workspaceSessionId ?? ""), expectedIncarnationId: String(input?.expectedIncarnationId ?? ""), source: String(input?.source ?? "user"), payload: String(input?.payload ?? ""), idempotencyKey: input?.idempotencyKey ? String(input.idempotencyKey) : undefined }));
  ipcMain.handle("native:resize-workspace-session", (_event, input) => sessionAuthority.resizeSession({ workspaceSessionId: String(input?.workspaceSessionId ?? ""), expectedIncarnationId: input?.expectedIncarnationId ? String(input.expectedIncarnationId) : undefined, cols: Number(input?.cols ?? 100), rows: Number(input?.rows ?? 30) }));
}

async function execute(window, source) { return window.webContents.executeJavaScript(source); }
async function click(window, text) {
  return execute(window, `(() => { const button = Array.from(document.querySelectorAll("button")).find((item) => item.innerText.trim() === ${JSON.stringify(text)} || item.innerText.includes(${JSON.stringify(text)})); if (!button) throw new Error("missing button ${text}"); button.click(); })()`);
}
async function setInput(window, labelText, value) {
  return execute(window, `(() => { const label = Array.from(document.querySelectorAll("label")).find((item) => item.innerText.includes(${JSON.stringify(labelText)})); const control = label?.querySelector("input, textarea, select"); if (!control) throw new Error("missing input ${labelText}"); const proto = control instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : control instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, "value").set.call(control, ${JSON.stringify(value)}); control.dispatchEvent(new Event("input", { bubbles: true })); control.dispatchEvent(new Event("change", { bubbles: true })); })()`);
}

async function main() {
  app.commandLine.appendSwitch("disable-gpu");
  await app.whenReady();
  const sessionStore = createSessionStore({ root: smokeRoot });
  ensureNodePtySpawnHelperExecutable();
  const terminalDaemonSupervisor = createOrcaTerminalDaemonSupervisor();
  const ptyManager = createOrcaTerminalDaemonManager({
    endpointProvider: () => terminalDaemonSupervisor.start(),
    sessionStore,
  });
  const sessionAuthority = createSessionAuthority({ ptyManager, databasePath: path.join(smokeRoot, "terminal.sqlite") });
  const runtime = createAgentLoopV1Runtime({
    sessionAuthority,
    ptyManager,
    sessionStore,
    opencodePath: fakeOpenCode,
    databasePath: path.join(smokeRoot, "agent-loop.sqlite"),
    enqueueConductorInput: ({ workspaceSessionId, expectedIncarnationId, source, payload, idempotencyKey }) =>
      sessionAuthority.enqueueInput({ workspaceSessionId, expectedIncarnationId, source, payload, idempotencyKey }),
    generateTemplateFromDescription: async (input) => ({
      template: {
        id: "generated-research-loop",
        name: "Generated research Agent Loop",
        description: `Generated from: ${input.description}`,
        source: "generated",
        conductor: { role: "Conductor", model: "opencode-go/deepseek-v4-flash" },
        agents: [{
          id: "researcher",
          name: "Researcher",
          role: "Find primary sources and return evidence.",
          model: "opencode-go/deepseek-v4-flash",
          mcp: [],
          skills: [],
          instructions: "Work only from the bounded contract sent by Conductor.",
          expectedOutput: "Markdown evidence with source links.",
        }],
        limits: { maxConcurrentSessions: 1, maxDispatchesPerDecision: 1 },
        delivery: { artifactPath: "docs/research.md" },
      },
      assistantMessage: "Generated a reusable research loop.",
      assumptions: [],
    }),
    getConductorBridgeConfig: async () => ({ conductorToolBridgeUrl: "http://127.0.0.1:1", conductorToolBridgeToken: "smoke", conductorMcpServerPath: path.join(__dirname, "conductor-mcp-server.cjs") }),
  });
  const unsubscribe = ptyManager.onEvent((event) => {
    sessionAuthority.handlePtyEvent(event);
    for (const window of BrowserWindow.getAllWindows()) if (!window.isDestroyed()) window.webContents.send("native:pty-event", event);
  });
  const unsubscribeClient = ptyManager.onClientEvent((event) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send("native:terminal-client-event", event);
    }
  });
  installIpc({ runtime, sessionAuthority, ptyManager, sessionStore });
  const window = new BrowserWindow({ show: false, width: 1440, height: 920, webPreferences: { contextIsolation: true, nodeIntegration: false, preload: path.join(__dirname, "preload.cjs") } });

  try {
    await window.loadFile(path.join(process.cwd(), "dist", "index.html"), { query: { projectPath: smokeRoot, projectName: "Agent Loop UI smoke" } });
    await waitUntil(() => execute(window, 'document.body.innerText.includes("Runtime online") && document.body.innerText.includes("还没有 Task")'), "desktop Agent Loop shell");
    await click(window, "模板");
    await waitUntil(() => execute(window, 'document.body.innerText.includes("OpenCode Agent Loop")'), "Loop Template cards").catch(async (error) => {
      process.stderr.write(`Loop Template cards diagnostic:\n${await execute(window, "document.body.innerText")}\n`);
      throw error;
    });
    const templateSurface = await execute(window, '(() => ({ loop: document.body.innerText.includes("Conductor Charter"), unrestricted: document.body.innerText.includes("全部允许"), workflow: document.body.innerText.includes("Workflow") || document.body.innerText.includes("Graph") }))()');
    assert.deepEqual(templateSurface, { loop: true, unrestricted: true, workflow: false });
    await click(window, "新建");
    await waitUntil(() => execute(window, 'document.body.innerText.includes("一句话生成模板") && document.body.innerText.includes("生成可编辑草案")'), "Template generation drawer").catch(async (error) => {
      process.stderr.write(`Template generation diagnostic:\n${await execute(window, "document.body.innerText")}\n`);
      throw error;
    });
    if (process.env.AGENT_LOOP_TEMPLATE_STARTER_CAPTURE_PATH) {
      await delay(250);
      const capturePath = path.resolve(process.env.AGENT_LOOP_TEMPLATE_STARTER_CAPTURE_PATH);
      fs.mkdirSync(path.dirname(capturePath), { recursive: true });
      fs.writeFileSync(capturePath, (await window.capturePage()).toPNG());
    }
    await setInput(window, "你希望 Conductor 怎样使用", "Research a topic with evidence.");
    await click(window, "生成可编辑草案");
    await waitUntil(() => execute(window, 'document.body.innerText.includes("Generated research Agent Loop") && document.body.innerText.includes("保存新版本")'), "Generated Template editor");
    await click(window, "保存新版本");
    await waitUntil(() => execute(window, 'document.body.innerText.includes("Generated research Agent Loop")'), "Saved generated Template");
    const generatedTemplate = runtime.listTemplates().find((template) => template.name === "Generated research Agent Loop");
    assert.equal(generatedTemplate?.delivery.ownerAgentId, "");
    assert.equal(generatedTemplate?.agents.some((agent) => agent.kind === "publisher"), false);
    if (process.env.AGENT_LOOP_CAPTURE_PATH) {
      await click(window, "编辑 / 新版本");
      await waitUntil(() => execute(window, 'document.body.innerText.toLowerCase().includes("session agent") && document.body.innerText.includes("Loop 设置")'), "Template Builder drawer").catch(async (error) => {
        process.stderr.write(`Template Builder diagnostic:\n${await execute(window, "document.body.innerText")}\n`);
        throw error;
      });
      await click(window, "Loop 设置");
      await waitUntil(() => execute(window, 'document.body.innerText.includes("Conductor Charter") && document.body.innerText.includes("交付路径偏好")'), "Loop settings pane");
      await click(window, "Session Agents");
      await waitUntil(() => execute(window, 'document.body.innerText.toLowerCase().includes("session agent") && document.body.innerText.includes("高级设置")'), "Session Agent editor pane");
      await delay(250);
      const capturePath = path.resolve(process.env.AGENT_LOOP_CAPTURE_PATH);
      fs.mkdirSync(path.dirname(capturePath), { recursive: true });
      fs.writeFileSync(capturePath, (await window.capturePage()).toPNG());
      await execute(window, 'document.querySelector("button[aria-label=\\"关闭\\"]")?.click()');
    }
    await click(window, "任务");
    await waitUntil(() => execute(window, 'document.body.innerText.includes("还没有 Task")'), "Task page");
    await click(window, "新建");
    await waitUntil(() => execute(window, 'document.body.innerText.includes("创建 Task") && document.body.innerText.includes("根据任务目标生成新 Template")'), "task create drawer");
    if (process.env.AGENT_LOOP_TASK_CAPTURE_PATH) {
      await delay(250);
      const capturePath = path.resolve(process.env.AGENT_LOOP_TASK_CAPTURE_PATH);
      fs.mkdirSync(path.dirname(capturePath), { recursive: true });
      fs.writeFileSync(capturePath, (await window.capturePage()).toPNG());
    }
    await setInput(window, "任务标题", "Native session proof");
    await setInput(window, "任务目标", "Use native Session Agents through Conductor only.");
    await waitUntil(() => execute(window, 'Array.from(document.querySelectorAll("input, textarea")).some((item) => item.value === "Native session proof") && Array.from(document.querySelectorAll("input, textarea")).some((item) => item.value.includes("native Session"))'), "task form state");
    await click(window, "根据任务目标生成新 Template");
    await waitUntil(() => execute(window, 'document.body.innerText.includes("一句话生成模板") && Array.from(document.querySelectorAll("textarea")).some((item) => item.value.includes("native Session"))'), "Task-to-Template generation handoff");
    await click(window, "生成可编辑草案");
    await waitUntil(() => execute(window, 'document.body.innerText.includes("Generated research Agent Loop") && document.body.innerText.includes("保存新版本")'), "Task-generated Template editor");
    await click(window, "保存新版本");
    await waitUntil(() => execute(window, 'document.body.innerText.includes("创建 Task") && document.body.innerText.includes("Generated research Agent Loop")'), "return to task with generated Template");
    await click(window, "创建 Task");
    await waitUntil(() => execute(window, 'document.body.innerText.includes("Native session proof")'), "created task").catch(async (error) => {
      process.stderr.write(`Task creation diagnostic:\n${await execute(window, "document.body.innerText")}\n`);
      throw error;
    });
    await click(window, "启动 Agent Loop");
    await waitUntil(() => execute(window, 'Boolean(document.querySelector(".agent-loop-workbench")) && Boolean(document.querySelector(".agent-loop-session-tab")) && Boolean(document.querySelector(".agent-loop-native-terminal"))'), "native Conductor terminal workspace");
    const surface = await execute(window, `(() => ({
      hasTask: document.body.innerText.includes("Native session proof"),
      hasTerminal: Boolean(document.querySelector(".agent-loop-native-terminal")),
      hasConductor: Array.from(document.querySelectorAll(".agent-loop-session-tab")).some((item) => item.innerText.includes("Conductor")),
      sessionTabs: document.querySelectorAll(".agent-loop-session-tab").length,
      hasWorkflow: document.body.innerText.includes("Workflow") || document.body.innerText.includes("Graph")
    }))()`);
    assert.deepEqual(surface, { hasTask: true, hasTerminal: true, hasConductor: true, sessionTabs: 1, hasWorkflow: false });
    await click(window, "任务");
    await waitUntil(() => execute(window, 'document.body.innerText.includes("继续和 Conductor 对话")'), "Task Timeline composer");
    await setInput(window, "继续和 Conductor 对话", "请不要假定固定步骤，先由 Conductor 判断是否需要再派发。");
    await click(window, "发送");
    await waitUntil(() => execute(window, 'document.body.innerText.includes("请不要假定固定步骤")'), "user message appears in Task Timeline");
    await click(window, "运行现场");
    const activeTask = runtime.listTasks()[0];
    const conductorSessionId = Object.keys(runtime.taskAgentMap({ taskId: activeTask.taskId }))[0];
    await waitUntil(() => sessionStore.readTerminalLog({ taskId: activeTask.taskId, sessionId: conductorSessionId, cwd: activeTask.cwd }).content.includes("OpenCode TUI ready"), "persisted host terminal output");
    await click(window, "终端历史");
    await waitUntil(() => execute(window, 'document.body.innerText.includes("TERMINAL DIAGNOSTICS") && document.body.innerText.includes("OpenCode TUI ready")'), "persisted terminal diagnostic drawer").catch(async (error) => {
      process.stderr.write(`Terminal diagnostics drawer:\n${await execute(window, "document.body.innerText")}\n`);
      throw error;
    });
    await execute(window, 'document.querySelector("button[aria-label=\\"关闭抽屉\\"]")?.click()');
    await execute(window, 'document.querySelector("button[aria-label=\\"缩小终端文字\\"]")?.click()');
    await waitUntil(() => runtime.readRun({ runId: runtime.listTasks()[0].latestRun.runId }).workbenchLayout.groups.primary.fontSize === 10, "per-Group terminal density persistence");
    await execute(window, 'document.querySelector("button[aria-label=\\"左右分屏\\"]")?.click()');
    await waitUntil(() => execute(window, 'document.querySelectorAll(".agent-loop-session-group").length === 2'), "recursive terminal Group split");
    const groupBoxes = await execute(window, 'Array.from(document.querySelectorAll(".agent-loop-session-group")).map((item) => { const rect = item.getBoundingClientRect(); return { width: Math.round(rect.width), height: Math.round(rect.height), left: Math.round(rect.left) }; })');
    assert.equal(groupBoxes.length, 2);
    assert.ok(groupBoxes.every((box) => box.width > 120 && box.height > 120), `Group split must produce two usable panes: ${JSON.stringify(groupBoxes)}`);
    await waitUntil(() => execute(window, 'document.querySelector(".agent-loop-empty-group")?.innerText.includes("不会启动新 Agent")'), "empty Group is explicitly a view-only Session destination");
    await waitUntil(() => execute(window, '(() => { const canvas = document.querySelector(".agent-loop-workbench-canvas")?.getBoundingClientRect(); const terminal = document.querySelector(".agent-loop-terminal-overlay-pane.active")?.getBoundingClientRect(); return Boolean(canvas && terminal && terminal.width < canvas.width * .75 && terminal.height > 120); })()'), "terminal overlay follows split Group geometry");
    await waitUntil(() => runtime.readRun({ runId: runtime.listTasks()[0].latestRun.runId }).workbenchLayout.root.type === "split", "persisted terminal Group layout");
    const documentMetrics = await execute(window, '({ scrollHeight: document.documentElement.scrollHeight, clientHeight: document.documentElement.clientHeight, bodyHeight: document.body.scrollHeight })');
    assert.ok(documentMetrics.scrollHeight <= documentMetrics.clientHeight + 1, `Workbench must not create page scroll: ${JSON.stringify(documentMetrics)}`);
    if (process.env.AGENT_LOOP_WORKBENCH_CAPTURE_PATH) {
      const capturePath = path.resolve(process.env.AGENT_LOOP_WORKBENCH_CAPTURE_PATH);
      fs.mkdirSync(path.dirname(capturePath), { recursive: true });
      fs.writeFileSync(capturePath, (await window.capturePage()).toPNG());
    }
    process.stdout.write("H2 PASS: Electron xterm renders a daemon-owned native Session with snapshot/delta/ACK, terminal history, and compact Group layout.\n");
  } finally {
    unsubscribe();
    unsubscribeClient();
    runtime.close();
    sessionAuthority.close();
    await window.close();
    await ptyManager.close();
    await terminalDaemonSupervisor.stop();
  }
}

main().then(() => app.exit(0)).catch((error) => { process.stderr.write(`${error.stack || error.message}\n`); app.exit(1); });

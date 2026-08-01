const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { app, BrowserWindow, ipcMain } = require("electron");
const { createOrcaTerminalDaemonManager } = require("./runtime/orca-terminal-daemon-manager.cjs");
const { createOrcaTerminalDaemonSupervisor } = require("./runtime/orca-terminal-daemon-supervisor.cjs");
const { ensureNodePtySpawnHelperExecutable } = require("./node-pty-runtime.cjs");
const { resolveOpencodePath } = require("./opencode-runner.cjs");
const { createAgentLoopV1Runtime } = require("./runtime/agent-loop-v1-runtime.cjs");
const { createOpenCodeHookService } = require("./runtime/opencode-hook-service.cjs");
const { createSessionAuthority } = require("./runtime/session-authority.cjs");
const { createSessionStore } = require("./session-store.cjs");
const { createSessionWakeupMonitor } = require("./session-wakeup-monitor.cjs");

const smokeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-loop-v1-ui-"));
const diagnosticPath = process.env.AGENT_LOOP_UI_SMOKE_DIAGNOSTIC_PATH;
const smokeScenario = String(process.env.AGENT_LOOP_UI_SMOKE_SCENARIO ?? "");
const realPermissionScenario = smokeScenario === "task-real-permission";
const taskQuestionScenario = smokeScenario === "task-question-ui-projection";
const REAL_PERMISSION_MODEL = "opencode-go/deepseek-v4-flash";
const fakeOpenCode = path.join(smokeRoot, "fake-opencode.sh");
// Keep the fake process in an alternate buffer, enable the real terminal mouse
// protocol, and echo raw PTY input. This proves that Electron/xterm forwards a
// wheel gesture as a mouse-wheel report, not as synthetic cursor-key input.
fs.writeFileSync(fakeOpenCode, `#!${process.execPath}
process.stdin.setRawMode?.(true);
process.stdin.resume();
process.stdout.write("\\u001b[?1049h\\u001b[?1000h\\u001b[?1006hOpenCode TUI ready\\r\\n");
process.stdin.on("data", (chunk) => process.stdout.write(\`WHEEL_INPUT \${Buffer.from(chunk).toString("hex")}\\r\\n\`));
`, { mode: 0o755 });

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function diagnostic(label) { if (diagnosticPath) fs.appendFileSync(diagnosticPath, `${label}\n`, "utf8"); }
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
  ipcMain.handle("native:choose-agent-loop-project-directory", (_event, input) => ({ path: String(input?.defaultPath ?? smokeRoot), name: "Agent Loop UI smoke" }));
  ipcMain.handle("native:create-agent-loop-task", (_event, input) => runtime.createTask(input));
  ipcMain.handle("native:list-agent-loop-tasks", () => runtime.listTasks());
  ipcMain.handle("native:read-agent-loop-task", (_event, input) => runtime.readTask(input));
  ipcMain.handle("native:start-agent-loop-run", (_event, input) => runtime.startRun(input));
  ipcMain.handle("native:read-agent-loop-run", (_event, input) => {
    const runId = String(input?.runId ?? "");
    return runId ? runtime.readRun({ runId }) : undefined;
  });
  ipcMain.handle("native:read-agent-loop-workbench-layout", (_event, input) => runtime.readWorkbenchLayout(input));
  ipcMain.handle("native:save-agent-loop-workbench-layout", (_event, input) => runtime.saveWorkbenchLayout(input));
  ipcMain.handle("native:read-agent-loop-artifact", (_event, input) => runtime.readArtifact(input));
  ipcMain.handle("native:mark-agent-loop-task-achieved", (_event, input) => runtime.markTaskAchieved(input));
  ipcMain.handle("native:stop-agent-loop-task", (_event, input) => runtime.stopTask(input));
  ipcMain.handle("native:respond-agent-loop-permission", (_event, input) => runtime.respondPermission({
    taskId: String(input?.taskId ?? ""),
    sessionId: String(input?.sessionId ?? ""),
    permissionId: String(input?.permissionId ?? ""),
    response: String(input?.response ?? ""),
  }));
  ipcMain.handle("native:respond-agent-loop-question", (_event, input) => runtime.respondSessionQuestion({
    taskId: String(input?.taskId ?? ""),
    sessionId: String(input?.sessionId ?? ""),
    questionId: String(input?.questionId ?? ""),
    answer: String(input?.answer ?? ""),
  }));
  ipcMain.handle("native:delete-agent-loop-task", (_event, input) => runtime.deleteTask(input));
  ipcMain.handle("native:append-task-event", (_event, input) => runtime.recordUserMessage({
    taskId: String(input?.taskId ?? ""),
    message: String(input?.data?.message ?? input?.summary ?? ""),
    data: input?.data && typeof input.data === "object" ? input.data : {},
  }));
  ipcMain.handle("native:send-agent-loop-task-message", (_event, input) => runtime.recordUserMessage({
    taskId: String(input?.taskId ?? ""),
    message: String(input?.message ?? ""),
    commandId: String(input?.commandId ?? ""),
    expectedRevision: Number.isSafeInteger(input?.expectedRevision) ? input.expectedRevision : undefined,
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
  if (diagnosticPath) fs.writeFileSync(diagnosticPath, "main entered\n", "utf8");
  // The developer's desktop app may already be using Electron's default
  // profile.  A smoke process must never hand its arguments to that instance
  // and exit successfully without executing this harness.
  app.setPath("userData", path.join(smokeRoot, "electron-user-data"));
  app.commandLine.appendSwitch("disable-gpu");
  app.on("before-quit", () => diagnostic("electron before-quit"));
  app.on("window-all-closed", () => diagnostic("electron window-all-closed"));
  await app.whenReady();
  diagnostic("electron ready");
  const sessionStore = createSessionStore({ root: smokeRoot });
  // The production main process publishes semantic invalidations from the
  // durable Session Store.  The real permission scenario must use that same
  // route; a UI harness must not make a permission card appear by hand.
  const unsubscribeStore = sessionStore.onTaskChange((change) => {
    for (const candidate of BrowserWindow.getAllWindows()) {
      if (!candidate.isDestroyed()) candidate.webContents.send("native:agent-loop-runtime-event", change);
    }
  });
  ensureNodePtySpawnHelperExecutable();
  const terminalDaemonSupervisor = createOrcaTerminalDaemonSupervisor();
  const ptyManager = createOrcaTerminalDaemonManager({
    endpointProvider: () => terminalDaemonSupervisor.start(),
    sessionStore,
  });
  const sessionAuthority = createSessionAuthority({ ptyManager, databasePath: path.join(smokeRoot, "terminal.sqlite") });
  const permissionReplies = [];
  const realPermissionHookService = realPermissionScenario ? createOpenCodeHookService() : undefined;
  const permissionRetryScenario = process.env.AGENT_LOOP_UI_SMOKE_SCENARIO === "task-permission-retry";
  let rejectNextPermissionReply = permissionRetryScenario;
  let sessionWakeupMonitor;
  const runtime = createAgentLoopV1Runtime({
    sessionAuthority,
    ptyManager,
    sessionStore,
    opencodePath: fakeOpenCode,
    databasePath: path.join(smokeRoot, "agent-loop.sqlite"),
    enqueueConductorInput: ({ workspaceSessionId, expectedIncarnationId, source, payload, idempotencyKey }) =>
      sessionAuthority.enqueueInput({ workspaceSessionId, expectedIncarnationId, source, payload, idempotencyKey }),
    generateTemplateFromBrief: async (input) => ({
      template: {
        id: "generated-research-loop",
        name: "Generated research Agent Loop",
        source: "generated",
        conductor: { role: "Conductor", model: "opencode-go/deepseek-v4-flash", charter: `Generated from: ${input.brief}` },
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
    onProviderHookEvent: (event) => sessionWakeupMonitor?.handleProviderHookEvent(event),
    respondToPermission: (input) => sessionWakeupMonitor?.respondPermission(input),
    getConductorBridgeConfig: async () => ({ conductorToolBridgeUrl: "http://127.0.0.1:1", conductorToolBridgeToken: "smoke", conductorMcpServerPath: path.join(__dirname, "conductor-mcp-server.cjs") }),
  });
  sessionWakeupMonitor = createSessionWakeupMonitor({
    ptyManager,
    sessionStore,
    // Projection scenarios intentionally own a fake reply transport. The
    // real scenario uses the hook service's real HTTP response transport.
    ...(realPermissionScenario ? {} : {
      submitPermissionReply: async (input) => {
        permissionReplies.push({ ...input });
        if (rejectNextPermissionReply) {
          rejectNextPermissionReply = false;
          return false;
        }
        return true;
      },
    }),
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
  window.once("closed", () => diagnostic("smoke BrowserWindow closed"));
  diagnostic("smoke BrowserWindow created");

  try {
    await window.loadFile(path.join(process.cwd(), "dist", "index.html"), { query: { projectPath: smokeRoot, projectName: "Agent Loop UI smoke" } });
    diagnostic("renderer loaded");
    await waitUntil(() => execute(window, 'document.body.innerText.includes("Runtime online") && document.body.innerText.includes("还没有进行中 Task")'), "desktop Agent Loop shell");
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
    assert.equal(Object.hasOwn(generatedTemplate, "description"), false);
    assert.match(generatedTemplate?.conductor.charter ?? "", /Generated from: Research a topic with evidence\./);
    assert.equal(Object.hasOwn(generatedTemplate?.conductor ?? {}, "reviewPolicy"), false, "generated Templates must not carry a Runtime review-policy field");
    assert.equal(generatedTemplate?.delivery.ownerAgentId, "");
    assert.equal(generatedTemplate?.agents.some((agent) => agent.kind === "publisher"), false);
    await waitUntil(() => execute(window, 'Array.from(document.querySelectorAll("button")).some((item) => item.innerText.includes("编辑 / 新版本") && !item.disabled)'), "Template edit action enabled");
    await click(window, "编辑 / 新版本");
    await waitUntil(() => execute(window, 'document.body.innerText.toLowerCase().includes("session agent") && document.body.innerText.includes("Loop 设置")'), "Template Builder drawer").catch(async (error) => {
      process.stderr.write(`Template Builder diagnostic:\n${await execute(window, "document.body.innerText")}\n`);
      throw error;
    });
    await click(window, "Loop 设置");
    await waitUntil(() => execute(window, 'document.body.innerText.includes("Conductor Charter") && !document.body.innerText.includes("用途描述") && !document.body.innerText.includes("交付路径偏好") && !document.body.innerText.includes("Publisher 前的审阅策略")'), "Loop settings pane with Charter only");
    const loopSettings = await execute(window, 'document.body.innerText');
    assert.equal(loopSettings.includes("reviewPolicy"), false, "Template editing must not expose a hidden review-policy configuration");
    await click(window, "Session Agents");
    await waitUntil(() => execute(window, 'document.body.innerText.toLowerCase().includes("session agent") && document.body.innerText.includes("高级设置")'), "Session Agent editor pane");
    if (process.env.AGENT_LOOP_CAPTURE_PATH) {
      await delay(250);
      const capturePath = path.resolve(process.env.AGENT_LOOP_CAPTURE_PATH);
      fs.mkdirSync(path.dirname(capturePath), { recursive: true });
      fs.writeFileSync(capturePath, (await window.capturePage()).toPNG());
    }
    await execute(window, 'document.querySelector("button[aria-label=\\"关闭\\"]")?.click()');
    await click(window, "任务");
    await waitUntil(() => execute(window, 'document.body.innerText.includes("还没有进行中 Task")'), "Task page");
    await click(window, "新建");
    await waitUntil(() => execute(window, 'document.body.innerText.includes("创建 Task") && document.body.innerText.includes("根据任务目标生成新 Template") && document.body.innerText.includes("项目文件夹")'), "task create drawer");
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
    if (realPermissionScenario) {
      const realPermissionTemplate = runtime.listTemplates().find((template) => template.agents.some((agent) => agent.id === "publisher"));
      assert.ok(realPermissionTemplate, "real permission scenario requires the seed Publisher Session Agent");
      await setInput(window, "Agent Loop Template", realPermissionTemplate.id);
    }
    await click(window, "创建 Task");
    await waitUntil(() => execute(window, 'document.body.innerText.includes("Native session proof")'), "created task").catch(async (error) => {
      process.stderr.write(`Task creation diagnostic:\n${await execute(window, "document.body.innerText")}\n`);
      throw error;
    });
    await click(window, "启动 Agent Loop");
    await waitUntil(() => execute(window, 'Boolean(document.querySelector(".agent-loop-workbench")) && Boolean(document.querySelector(".agent-loop-session-tab")) && Boolean(document.querySelector(".agent-loop-native-terminal"))'), "native Conductor terminal workspace");
    assert.deepEqual(runtime.readRun({ runId: runtime.listTasks()[0].latestRun.runId }).artifacts, [], "a legacy path must not create an expected-artifact placeholder");
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
    const liveTaskControls = await execute(window, `(() => ({
      hasWorkbench: document.body.innerText.includes("进入运行现场"),
      hasAchieve: document.body.innerText.includes("Achieve"),
      hasStop: document.body.innerText.includes("停止任务"),
      hasRecover: document.body.innerText.includes("恢复当前 Run"),
      hasTaskDelete: document.body.innerText.includes("删除任务")
    }))()`);
    assert.deepEqual(liveTaskControls, { hasWorkbench: true, hasAchieve: false, hasStop: true, hasRecover: false, hasTaskDelete: false });
    assert.equal(await execute(window, 'document.body.innerText.includes("等待产物")'), false, "Task Timeline must not present a missing artifact as a state");
    const timelineTask = runtime.listTasks()[0];
    const timelineConductorSessionId = runtime.readRun({ runId: timelineTask.latestRun.runId }).run.conductorSessionId;
    const fullConductorReply = "## 任务完成\n\n最终交付：`docs/research.md`\n\n结论：证据已核验，建议继续由用户判断。";
    const completionClaim = "交付路径：`docs/research.md`；所有必要证据已附在最终报告中。";
    sessionStore.recordConductorMessage({
      taskId: timelineTask.taskId,
      sessionId: timelineConductorSessionId,
      cwd: timelineTask.cwd,
      message: fullConductorReply,
    });
    sessionStore.recordTaskCompletionClaim({
      taskId: timelineTask.taskId,
      sessionId: timelineConductorSessionId,
      cwd: timelineTask.cwd,
      message: completionClaim,
    });
    assert.ok(
      runtime.readRun({ runId: timelineTask.latestRun.runId }).runtimeState.events.some((event) => event.type === "conductor.message" && event.data?.message === fullConductorReply),
      "Runtime read model must include the durable Conductor message before the renderer is invalidated",
    );
    window.webContents.send("native:agent-loop-runtime-event", { runId: timelineTask.latestRun.runId, type: "conductor.message", sessionId: timelineConductorSessionId });
    await click(window, "刷新");
    await waitUntil(() => execute(window, `(() => {
      const rendered = Array.from(document.querySelectorAll(".harness-conversation-message.conductor .harness-markdown"))
        .map((item) => item.textContent || "");
      return rendered.some((text) => text.includes("任务完成") && text.includes("docs/research.md") && text.includes("证据已核验"))
        && rendered.some((text) => text.includes("交付路径：docs/research.md；所有必要证据已附在最终报告中。"));
    })()`), "complete rendered Conductor reply and completion claim in Task Timeline");
    // A native OpenCode question is not a normal Task-to-Conductor message.
    // The observer writes this exact durable state; this Electron integration
    // proof exercises the renderer -> IPC -> Runtime -> owned PTY reply path.
    if (taskQuestionScenario) {
      const questionId = "opencode-question-task-page-1";
      const questionText = "文件是否已经复制到目标文件夹？";
      const answer = "已确认复制到目标文件夹";
      const ordinaryFollowUp = "请把报告复制到桌面的 tempreport 文件夹。";
      await waitUntil(() => ptyManager.get(timelineConductorSessionId)?.status === "running", "live Conductor terminal for native question reply");
      const currentTerminalIncarnationId = ptyManager.get(timelineConductorSessionId).incarnationId;
      // A durable waiting_input fact from the previous physical terminal is
      // not a Task-page input control. This is the post-restart race: the
      // logical Session has a new live TUI, but the Provider observer has not
      // yet confirmed that this TUI is showing the same question.
      const historicalQuestionId = "opencode-question-before-terminal-restart";
      sessionStore.recordProviderSessionState(
        { taskId: timelineTask.taskId, sessionId: timelineConductorSessionId, cwd: timelineTask.cwd },
        "waiting_input",
        "旧终端里的确认问题。",
        {
          source: "opencode-sqlite-observer",
          provider: "opencode",
          providerSessionId: "ses-task-question-before-terminal-restart",
          providerQuestionPartId: historicalQuestionId,
          terminalIncarnationId: "incarnation-before-terminal-restart",
          question: "旧终端的问题不能在新终端中直接回答。",
        },
      );
      await click(window, "刷新");
      await waitUntil(
        () => execute(window, "document.querySelectorAll('.agent-loop-question-request').length === 0"),
        "historical native question stays hidden until it is re-observed in the current terminal",
      );
      assert.deepEqual(
        await runtime.respondSessionQuestion({
          taskId: timelineTask.taskId,
          sessionId: timelineConductorSessionId,
          questionId: historicalQuestionId,
          answer: "这不应写入新终端。",
        }),
        { ok: false, status: "waiting_input", errorCode: "question_terminal_changed" },
        "Runtime must reject an answer that targets an old terminal incarnation",
      );
      sessionStore.recordProviderSessionState(
        { taskId: timelineTask.taskId, sessionId: timelineConductorSessionId, cwd: timelineTask.cwd },
        "waiting_input",
        questionText,
        {
          source: "opencode-sqlite-observer",
          provider: "opencode",
          providerSessionId: "ses-task-question-ui",
          providerQuestionPartId: questionId,
          terminalIncarnationId: currentTerminalIncarnationId,
          question: questionText,
        },
      );
      await click(window, "刷新");
      await waitUntil(
        () => execute(window, `(() => {
          const card = document.querySelector(".agent-loop-question-request.active");
          return Boolean(card && card.textContent?.includes(${JSON.stringify(questionText)}));
        })()`),
        "Task-page native question card",
      );
      const questionGeometry = await execute(window, `(() => {
        const card = document.querySelector(".agent-loop-question-request");
        const timeline = document.querySelector(".harness-conversation");
        const inspector = document.querySelector(".harness-inspector");
        if (!card || !timeline || !inspector) throw new Error("question card, Timeline, or Task Architecture sidebar missing");
        const cardRect = card.getBoundingClientRect();
        const inspectorRect = inspector.getBoundingClientRect();
        return {
          card: { left: Math.round(cardRect.left), right: Math.round(cardRect.right) },
          inspector: { left: Math.round(inspectorRect.left), right: Math.round(inspectorRect.right) },
          timelineContainsCard: timeline.contains(card),
          genericAttention: Array.from(timeline.querySelectorAll(".harness-conversation-message.runtime")).some((item) => item.textContent?.includes("需要处理")),
        };
      })()`);
      assert.equal(questionGeometry.timelineContainsCard, false, `native question must be rendered in Task inspector, not Timeline: ${JSON.stringify(questionGeometry)}`);
      assert.ok(questionGeometry.card.left >= questionGeometry.inspector.left && questionGeometry.card.right <= questionGeometry.inspector.right, `native question card must be inside Task Architecture sidebar: ${JSON.stringify(questionGeometry)}`);
      assert.equal(questionGeometry.genericAttention, false, "waiting_input must not be projected as a generic Conductor attention item");

      // This is the exact user action from the Task page: a normal Task
      // follow-up while a native OpenCode question is still awaiting an
      // answer.  It must remain a durable Conductor command.  Sending it into
      // the selected native question (or treating it as a permission grant)
      // would corrupt the Provider's TUI state and incorrectly invent a
      // permission card before the Conductor has made its next decision.
      const terminalLogBeforeFollowUp = sessionStore.readTerminalLog({
        taskId: timelineTask.taskId,
        sessionId: timelineConductorSessionId,
        cwd: timelineTask.cwd,
      }).content;
      await setInput(window, "继续和 Conductor 对话", ordinaryFollowUp);
      await click(window, "发送");
      await waitUntil(
        () => runtime.readRun({ runId: timelineTask.latestRun.runId }).events.some(
          (event) => event.type === "task.user_message" && event.data?.message === ordinaryFollowUp,
        ),
        "Task follow-up is persisted for Conductor while native question is open",
      );
      assert.equal(
        sessionStore.readSession({ taskId: timelineTask.taskId, sessionId: timelineConductorSessionId, cwd: timelineTask.cwd }).state,
        "waiting_input",
        "a normal Task follow-up must not overwrite the native question state",
      );
      const terminalLogAfterFollowUp = sessionStore.readTerminalLog({
        taskId: timelineTask.taskId,
        sessionId: timelineConductorSessionId,
        cwd: timelineTask.cwd,
      }).content;
      assert.equal(
        terminalLogAfterFollowUp.slice(terminalLogBeforeFollowUp.length).includes(Buffer.from(ordinaryFollowUp, "utf8").toString("hex")),
        false,
        "a normal Task follow-up must not be pasted into an unanswered OpenCode question",
      );
      await waitUntil(
        () => execute(window, `document.querySelectorAll(".agent-loop-question-request.active").length === 1 && document.body.innerText.includes(${JSON.stringify(ordinaryFollowUp)})`),
        "the native-question card remains actionable while the Task follow-up waits for Conductor",
      );
      await setInput(window, "回答 OpenCode 问题", answer);
      await click(window, "提交回答");
      await waitUntil(
        () => sessionStore.readQuestionResponse({ taskId: timelineTask.taskId, sessionId: timelineConductorSessionId, cwd: timelineTask.cwd, questionId })?.status === "submitted",
        "durable exact native-question receipt",
      );
      await waitUntil(
        () => sessionStore.readTerminalLog({ taskId: timelineTask.taskId, sessionId: timelineConductorSessionId, cwd: timelineTask.cwd }).content.includes(Buffer.from(answer, "utf8").toString("hex")),
        "native question answer reaches the owning terminal",
      );
      await waitUntil(
        () => execute(window, `document.querySelectorAll(".agent-loop-question-request").length === 0 && document.body.innerText.includes(${JSON.stringify(answer)})`),
        "native question card is consumed after exact Session write",
      );
      const state = runtime.readRun({ runId: timelineTask.latestRun.runId }).runtimeState;
      assert.equal(state.questionResponses.filter((record) => record.questionId === questionId).length, 1, "one Task-page answer must yield one durable question receipt");
      assert.equal(state.questionResponses.find((record) => record.questionId === questionId)?.answer, answer, "durable receipt must preserve the exact answer");
      return "H2 PASS: Electron Task 页只把与当前 PTY incarnation 配对的原生问题投影为可回答卡片；重启前的旧问题被隐藏且 Runtime 拒绝写入。普通 Task 指令仍保留给 Conductor，配对卡按 questionId 精确写回所属 PTY 并一次性消费。\n";
    }
    // Permission is a Task-page action, but its reply must target the exact
    // native Session which asked. This covers renderer -> IPC -> Runtime ->
    // Provider reply adapter without exposing the reply transport to the page.
    const restartPermissionScenario = smokeScenario === "task-permission-restart";
    const permissionId = "opencode:task-page-targeted-request";
    const reissuedPermissionId = "opencode:task-page-targeted-request-reissued";
    const queuedPermissionId = "opencode:task-page-targeted-request-2";
    const permissionSessionId = restartPermissionScenario
      ? Object.entries(runtime.taskAgentMap({ taskId: timelineTask.taskId })).find(([, agentId]) => agentId === "researcher")?.[0]
      : realPermissionScenario
        ? Object.entries(runtime.taskAgentMap({ taskId: timelineTask.taskId })).find(([, agentId]) => agentId === "publisher")?.[0]
        : timelineConductorSessionId;
    assert.ok(permissionSessionId, "permission scenario needs an owned native Session");
    let realPermissionDestination = "";
    if (realPermissionScenario) {
      const realOpenCodePath = resolveOpencodePath();
      if (!realOpenCodePath) throw new Error("OpenCode is required for the real Task-page permission E2E.");
      const realPermissionSource = path.join(timelineTask.cwd, "real-task-page-permission-source.txt");
      const externalRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agent-loop-real-task-page-external-")));
      realPermissionDestination = path.join(externalRoot, "task-page-permission-reply.txt");
      fs.writeFileSync(realPermissionSource, "REAL_TASK_PAGE_PERMISSION_OK\n", "utf8");
      const hook = await realPermissionHookService.registerSession({
        sessionId: permissionSessionId,
        cwd: timelineTask.cwd,
        onEvent: (event) => sessionWakeupMonitor.handleProviderHookEvent(event),
      });
      sessionAuthority.registerLaunchProfile({
        workspaceSessionId: permissionSessionId,
        taskId: timelineTask.taskId,
        command: realOpenCodePath,
        args: [
          "--model", REAL_PERMISSION_MODEL,
          "--prompt",
          `Use the shell to copy the exact file ${realPermissionSource} to ${realPermissionDestination}. The destination is outside this Task project directory, so wait for any requested permission. After the copy succeeds, reply exactly REAL_TASK_PAGE_PERMISSION_OK.`,
        ],
        cwd: timelineTask.cwd,
        provider: "opencode",
        model: REAL_PERMISSION_MODEL,
        cols: 100,
        rows: 30,
        stdin: "pipe",
        requirePty: true,
        env: hook.env,
      });
      const activation = await sessionAuthority.activateSession({
        workspaceSessionId: permissionSessionId,
        operationId: `real-task-page-permission:${timelineTask.taskId}`,
        callerId: "agent-loop-v1-ui-smoke",
        reason: "real-task-page-permission-e2e",
        interactiveTui: true,
      });
      assert.equal(activation.session?.status, "running", "real Publisher Session must start before it can request permission");
      await waitUntil(
        () => sessionStore.readSession({ taskId: timelineTask.taskId, sessionId: permissionSessionId }).permissions.some((item) => item.status === "requested"),
        "real OpenCode external-directory permission request",
        120_000,
      );
    } else if (restartPermissionScenario) {
      // This is the persisted state left by an Electron restart: no terminal
      // and no in-memory hook transport, but a proven Provider conversation.
      sessionStore.startSession({ taskId: timelineTask.taskId, sessionId: permissionSessionId, command: fakeOpenCode, cwd: timelineTask.cwd });
      sessionStore.recordProviderSessionState({ taskId: timelineTask.taskId, sessionId: permissionSessionId, cwd: timelineTask.cwd }, "permission_required", "OpenCode 正在等待用户授权。", { provider: "opencode", providerSessionId: "ses-researcher-before-restart" });
      sessionStore.recordPermissionRequested({
        taskId: timelineTask.taskId,
        sessionId: permissionSessionId,
        cwd: timelineTask.cwd,
        permissionId,
        requestId: "task-page-targeted-request",
        provider: "opencode",
        permission: "external_directory",
        patterns: [path.join(smokeRoot, "approved-output")],
        summary: "需要将已审核交付写入项目文件夹。",
      });
      sessionStore.recordPermissionRecoveryPending({
        taskId: timelineTask.taskId,
        sessionId: permissionSessionId,
        cwd: timelineTask.cwd,
        permissionId,
        response: "once",
      });
      const startupRecovery = await runtime.resumePendingPermissionRecoveries();
      assert.equal(startupRecovery.attempted, 1, "startup recovery must find the saved Task-page authorization");
      assert.equal(startupRecovery.failed.length, 0, "startup recovery must resume the same Provider Session");
    } else {
      sessionWakeupMonitor.handleProviderHookEvent({
        sessionId: permissionSessionId,
        kind: "permission",
        payload: {
          phase: "asked",
          requestID: "task-page-targeted-request",
          permission: "external_directory",
          patterns: [path.join(smokeRoot, "approved-output")],
          message: "需要将已审核交付写入项目文件夹。",
          replyEndpoint: "http://127.0.0.1:41003/permission/reply",
          replyToken: "task-page-live-token",
        },
      });
      if (!permissionRetryScenario) {
        sessionWakeupMonitor.handleProviderHookEvent({
          sessionId: permissionSessionId,
          kind: "permission",
          payload: {
            phase: "asked",
            requestID: "task-page-targeted-request-2",
            permission: "external_directory",
            patterns: [path.join(smokeRoot, "approved-summary")],
            message: "需要将已审核摘要写入项目文件夹。",
            replyEndpoint: "http://127.0.0.1:41005/permission/reply",
            replyToken: "task-page-live-token-2",
          },
        });
      }
    }
    if (!realPermissionScenario) {
      window.webContents.send("native:agent-loop-runtime-event", { runId: timelineTask.latestRun.runId, type: "permission.requested", sessionId: permissionSessionId });
    }
    await click(window, "刷新");
    if (restartPermissionScenario) {
      await waitUntil(() => execute(window, 'document.body.innerText.includes("已保留授权答复") && document.body.innerText.includes("原会话通道不可用；已保留你的选择")'), "restart-aware retained permission state in Task Timeline");
      await waitUntil(() => execute(window, 'document.querySelectorAll(".agent-loop-permission-request").length === 0'), "saved permission response is consumed from the sidebar");
      await waitUntil(() => ptyManager.get(permissionSessionId)?.status === "running", "same worker terminal recovered after restart");
      sessionWakeupMonitor.handleProviderHookEvent({
        sessionId: permissionSessionId,
        kind: "permission",
        payload: {
          phase: "asked",
          requestID: reissuedPermissionId,
          permission: "external_directory",
          patterns: [path.join(smokeRoot, "approved-output")],
          message: "需要将已审核交付写入项目文件夹。",
          replyEndpoint: "http://127.0.0.1:41004/permission/reply",
          replyToken: "task-page-restarted-token",
        },
      });
    } else {
      await waitUntil(
        () => execute(window, 'document.body.innerText.includes("OpenCode 请求授权") && document.body.innerText.includes("external_directory")'),
        "Task-page permission card",
      ).catch(async (error) => {
        const session = sessionStore.readSession({ taskId: timelineTask.taskId, sessionId: permissionSessionId });
        const run = runtime.readRun({ runId: timelineTask.latestRun.runId });
        const body = await execute(window, "document.body.innerText");
        throw new Error(`${error.message}\nreal permission session: ${JSON.stringify(session.permissions)}\nTask read model permissions: ${JSON.stringify(run.runtimeState.permissions)}\nrenderer body: ${body}`);
      });
      diagnostic("permission card rendered");
      const permissionCardGeometry = await execute(window, `(() => {
        const card = document.querySelector(".agent-loop-permission-request");
        const timeline = document.querySelector(".harness-conversation");
        const inspector = document.querySelector(".harness-inspector");
        if (!card || !timeline || !inspector) throw new Error("permission card, Timeline, or Task Architecture sidebar missing");
        const cardRect = card.getBoundingClientRect();
        const inspectorRect = inspector.getBoundingClientRect();
        return {
          card: { left: Math.round(cardRect.left), right: Math.round(cardRect.right) },
          inspector: { left: Math.round(inspectorRect.left), right: Math.round(inspectorRect.right) },
          timelineContainsCard: timeline.contains(card),
          cardCount: document.querySelectorAll(".agent-loop-permission-request").length,
          activeCount: document.querySelectorAll(".agent-loop-permission-request.active").length,
          queuedCount: document.querySelectorAll(".agent-loop-permission-request.queued").length,
          body: document.body.innerText,
        };
      })()`);
      assert.equal(permissionCardGeometry.timelineContainsCard, false, `Task permission card must not be rendered in Timeline: ${JSON.stringify(permissionCardGeometry)}`);
      assert.ok(permissionCardGeometry.card.left >= permissionCardGeometry.inspector.left && permissionCardGeometry.card.right <= permissionCardGeometry.inspector.right, `Task permission card must be inside Task Architecture sidebar: ${JSON.stringify(permissionCardGeometry)}`);
      assert.deepEqual(
        { cardCount: permissionCardGeometry.cardCount, activeCount: permissionCardGeometry.activeCount, queuedCount: permissionCardGeometry.queuedCount },
        realPermissionScenario || permissionRetryScenario ? { cardCount: 1, activeCount: 1, queuedCount: 0 } : { cardCount: 2, activeCount: 1, queuedCount: 1 },
        "multiple Task permission requests must render as one actionable card over a stacked deck",
      );
      assert.equal(permissionCardGeometry.body.includes("replyToken"), false, "Task permission card must not expose Provider reply credentials");
      if (process.env.AGENT_LOOP_PERMISSION_CAPTURE_PATH) {
        const capturePath = path.resolve(process.env.AGENT_LOOP_PERMISSION_CAPTURE_PATH);
        fs.mkdirSync(path.dirname(capturePath), { recursive: true });
        fs.writeFileSync(capturePath, (await window.capturePage()).toPNG());
        diagnostic("permission card captured");
      }
      await click(window, "仅此次允许");
      if (realPermissionScenario) {
        await waitUntil(
          () => sessionStore.readSession({ taskId: timelineTask.taskId, sessionId: permissionSessionId }).permissions.some((item) => item.status === "approved"),
          "OpenCode confirmation for Task-page permission reply",
          120_000,
        );
        await waitUntil(() => fs.existsSync(realPermissionDestination), "real external file copy after Task-page permission", 120_000);
        assert.equal(fs.readFileSync(realPermissionDestination, "utf8"), "REAL_TASK_PAGE_PERMISSION_OK\n");
      } else if (permissionRetryScenario) {
        await waitUntil(() => permissionReplies.length === 1, "first Task-page permission retry attempt reaches the Provider reply adapter");
        await waitUntil(() => execute(window, 'document.querySelectorAll(".agent-loop-permission-request").length === 1 && document.body.innerText.includes("尚未接收上次答复")'), "failed permission remains actionable in the Task sidebar");
        const repeatedRequest = {
          phase: "asked",
          requestID: "task-page-targeted-request",
          permission: "external_directory",
          patterns: [path.join(smokeRoot, "approved-output")],
          message: "需要将已审核交付写入项目文件夹。",
          replyEndpoint: "http://127.0.0.1:41003/permission/reply",
          replyToken: "task-page-live-token",
        };
        for (let index = 0; index < 5; index += 1) {
          sessionWakeupMonitor.handleProviderHookEvent({ sessionId: permissionSessionId, kind: "permission", payload: repeatedRequest });
        }
        await delay(120);
        assert.equal(permissionReplies.length, 1, "repeated Provider observations must not auto-retry a failed Task-page answer");
        const retryEvents = sessionStore.readSession({ taskId: timelineTask.taskId, sessionId: permissionSessionId }).events
          .filter((event) => event.type === "permission.response_retry_required");
        assert.equal(retryEvents.length, 1, "one failed attempt must create one Timeline retry record");
        await click(window, "仅此次允许");
        await waitUntil(() => permissionReplies.length === 2, "only the second user click retries the Provider reply");
      } else {
        await waitUntil(() => execute(window, 'document.querySelectorAll(".agent-loop-permission-request").length === 1'), "submitted Task-page permission is consumed from the sidebar");
      }
    }
    if (!realPermissionScenario) {
      await waitUntil(() => permissionReplies.length === (permissionRetryScenario ? 2 : 1), "Task-page permission reaches Provider reply adapter");
      assert.deepEqual(permissionReplies.map(({ taskId, sessionId, permissionId: capturedPermissionId, response }) => ({ taskId, sessionId, permissionId: capturedPermissionId, response })), Array.from({ length: permissionRetryScenario ? 2 : 1 }, () => ({
        taskId: timelineTask.taskId,
        sessionId: permissionSessionId,
        permissionId: restartPermissionScenario ? `opencode:${reissuedPermissionId}` : permissionId,
        response: "once",
      })), "Task permission response must preserve the exact owning Session and Provider request identity");
    }
    if (restartPermissionScenario) {
      window.webContents.send("native:agent-loop-runtime-event", { runId: timelineTask.latestRun.runId, type: "permission.reissued", sessionId: permissionSessionId });
      await click(window, "刷新");
      await waitUntil(() => execute(window, 'document.body.innerText.includes("OpenCode 已重发相同范围的授权请求")'), "reissued permission is explained in Task Timeline without a duplicate card");
    }
    if (!realPermissionScenario) {
      window.webContents.send("native:agent-loop-runtime-event", { runId: timelineTask.latestRun.runId, type: "permission.response_submitted", sessionId: permissionSessionId });
      await click(window, "刷新");
      await waitUntil(() => execute(window, 'document.body.innerText.includes("已将你的选择（仅此次允许）发送给 OpenCode；等待 Provider 确认。")'), "submitted permission audit in Task Timeline");
      sessionWakeupMonitor.handleProviderHookEvent({ sessionId: permissionSessionId, kind: "permission", payload: { phase: "replied", requestID: restartPermissionScenario ? reissuedPermissionId : "task-page-targeted-request", response: "once" } });
      window.webContents.send("native:agent-loop-runtime-event", { runId: timelineTask.latestRun.runId, type: "permission.replied", sessionId: permissionSessionId });
      await click(window, "刷新");
    }
    if (!realPermissionScenario && !restartPermissionScenario && !permissionRetryScenario) {
      await waitUntil(() => execute(window, 'document.querySelectorAll(".agent-loop-permission-request.active").length === 1 && document.body.innerText.includes("approved-summary")'), "next permission rises after the first card is consumed");
      await click(window, "仅此次允许");
      await waitUntil(() => permissionReplies.length === 2, "second stacked permission reaches Provider reply adapter");
      assert.equal(permissionReplies[1]?.permissionId, queuedPermissionId, "next stacked permission must preserve its own Provider request identity");
      sessionWakeupMonitor.handleProviderHookEvent({ sessionId: permissionSessionId, kind: "permission", payload: { phase: "replied", requestID: queuedPermissionId, response: "once" } });
      window.webContents.send("native:agent-loop-runtime-event", { runId: timelineTask.latestRun.runId, type: "permission.replied", sessionId: permissionSessionId });
      await click(window, "刷新");
    }
    await waitUntil(() => execute(window, 'document.querySelectorAll(".agent-loop-permission-request").length === 0 && document.body.innerText.includes("已确认授权答复")'), "Provider-confirmed Task-page permission receipt");
    // Keep the Task-page permission journey independently executable.  It
    // starts the real Electron renderer, crosses IPC into the Runtime and
    // asserts the exact native Session receipt above.  Terminal-wheel checks
    // remain in the broader smoke because they exercise a separate contract.
    if (["task-permission", "task-permission-restart", "task-permission-retry", "task-real-permission"].includes(smokeScenario)) {
      diagnostic(restartPermissionScenario ? "task permission restart scenario complete" : permissionRetryScenario ? "task permission retry scenario complete" : "task permission scenario complete");
      if (realPermissionScenario) {
        return "H2 PASS: 真实 OpenCode 权限请求已穿透 Electron Task 右侧卡片；点击后收到 Provider 确认并真实写入外部临时目录。\n";
      }
      if (permissionRetryScenario) {
        return "H2 PASS: Provider 拒绝一次授权答复后，重复观察没有自动重试；只有第二次 Task 页点击才会再次发送，并收到 Provider 确认。\n";
      }
      return restartPermissionScenario
        ? "H2 PASS: Electron 的持久化重启状态会恢复同一原生 Session，并在 OpenCode 以新 request id 重发同范围请求后得到 Provider 确认。\n"
        : "H2 PASS: Task 页授权卡片已精确回复到请求它的原生 Session，且已收到 Provider 确认。\n";
    }
    await execute(window, 'document.querySelector("button[aria-label=\\"收起任务设置\\"]")?.click()');
    await waitUntil(() => execute(window, 'Boolean(document.querySelector(".harness-inspector.collapsed"))'), "collapsible Task settings");
    await execute(window, 'document.querySelector("button[aria-label=\\"展开任务设置\\"]")?.click()');
    await waitUntil(() => execute(window, 'Boolean(document.querySelector(".harness-inspector-title"))'), "restored Task settings");
    const retainedDraft = "请不要假定固定步骤，先由 Conductor 判断是否需要再派发。";
    await setInput(window, "继续和 Conductor 对话", retainedDraft);
    await click(window, "模板");
    await waitUntil(() => execute(window, 'document.body.innerText.includes("OpenCode Agent Loop")'), "Template navigation while a Task draft exists");
    await click(window, "任务");
    await waitUntil(
      () => execute(window, `document.querySelector("#task-conductor-message")?.value === ${JSON.stringify(retainedDraft)}`),
      "Task composer draft survives page navigation",
    );
    await click(window, "发送");
    await waitUntil(() => execute(window, 'document.body.innerText.includes("请不要假定固定步骤")'), "user message appears in Task Timeline");
    if (process.env.AGENT_LOOP_TIMELINE_CAPTURE_PATH) {
      const capturePath = path.resolve(process.env.AGENT_LOOP_TIMELINE_CAPTURE_PATH);
      fs.mkdirSync(path.dirname(capturePath), { recursive: true });
      fs.writeFileSync(capturePath, (await window.capturePage()).toPNG());
    }
    await click(window, "运行现场");
    const activeTask = runtime.listTasks()[0];
    const conductorSessionId = Object.keys(runtime.taskAgentMap({ taskId: activeTask.taskId }))[0];
    await waitUntil(() => sessionStore.readTerminalLog({ taskId: activeTask.taskId, sessionId: conductorSessionId, cwd: activeTask.cwd }).content.includes("OpenCode TUI ready"), "persisted host terminal output");
    await waitUntil(() => execute(window, 'Boolean(document.querySelector(".terminal-buffer-alternate .xterm-terminal-host"))'), "OpenCode alternate TUI buffer");
    const alternateWheel = await execute(window, `(() => {
      const xterm = document.querySelector(".terminal-buffer-alternate .xterm");
      if (!xterm) throw new Error("alternate xterm root is missing");
      // Match the user's deliberate click into the terminal before scrolling;
      // this is not production auto-focus and is required for xterm to own the
      // browser's mouse input in this hidden Electron test window.
      xterm.querySelector("textarea")?.focus();
      const viewport = xterm.querySelector(".xterm-viewport") || xterm;
      const rect = viewport.getBoundingClientRect();
      const event = new WheelEvent("wheel", {
        bubbles: true,
        cancelable: true,
        deltaY: 120,
        clientX: rect.left + Math.max(2, rect.width / 2),
        clientY: rect.top + Math.max(2, rect.height / 2),
      });
      const dispatched = viewport.dispatchEvent(event);
      return { dispatched, defaultPrevented: event.defaultPrevented };
    })()`);
    assert.deepEqual(alternateWheel, { dispatched: false, defaultPrevented: true }, "alternate-buffer wheel must be handled by xterm's native mouse protocol, not leak to the document");
    await waitUntil(
      () => /WHEEL_INPUT 1b5b3c363[45]3b/.test(sessionStore.readTerminalLog({ taskId: activeTask.taskId, sessionId: conductorSessionId, cwd: activeTask.cwd }).content),
      "alternate-buffer wheel reaches the native PTY as a terminal mouse-wheel report",
    );
    assert.equal(
      sessionStore.readTerminalLog({ taskId: activeTask.taskId, sessionId: conductorSessionId, cwd: activeTask.cwd }).content.includes("WHEEL_INPUT 1b5b42"),
      false,
      "a wheel gesture must never be rewritten as an ArrowDown key",
    );
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
    // Real lifecycle proof: stopping keeps durable history but terminates live
    // Sessions; re-start and achieved re-run both create isolated identities.
    const firstRunId = runtime.listTasks()[0].latestRun.runId;
    await click(window, "任务");
    await waitUntil(() => execute(window, 'document.body.innerText.includes("停止任务")'), "Task stop action");
    await click(window, "停止任务");
    await waitUntil(() => execute(window, 'Boolean(document.querySelector("[aria-label=\\"停止 Task 确认\\"]"))'), "stop confirmation dialog");
    await execute(window, `(() => {
      const dialog = document.querySelector('[aria-label="停止 Task 确认"]');
      const button = Array.from(dialog?.querySelectorAll("button") || []).find((item) => item.innerText.trim() === "停止任务");
      if (!button) throw new Error("Stop confirmation button not found");
      button.click();
    })()`);
    await waitUntil(() => runtime.listTasks()[0].status === "stopped", "Task Runtime stop");
    await waitUntil(() => execute(window, 'document.body.innerText.includes("已停止") && document.body.innerText.includes("重新启动")'), "stopped Task state");
    assert.equal(runtime.readRun({ runId: firstRunId }).run.status, "stopped");
    await click(window, "重新启动");
    await waitUntil(() => runtime.listTasks()[0].status === "running" && runtime.listTasks()[0].latestRun.runId !== firstRunId, "restart after stop");
    const restartedRunId = runtime.listTasks()[0].latestRun.runId;
    assert.notEqual(runtime.readRun({ runId: restartedRunId }).run.conductorSessionId, runtime.readRun({ runId: firstRunId }).run.conductorSessionId);
    runtime.recordCompletionClaim({ taskId: runtime.listTasks()[0].taskId });
    await click(window, "任务");
    await waitUntil(() => execute(window, 'document.body.innerText.includes("Achieve")'), "achievement action");
    await click(window, "Achieve");
    await waitUntil(() => execute(window, 'document.body.innerText.includes("已完成任务") && document.body.innerText.includes("重新执行（新 Run）")'), "achieved Task manager");
    assert.equal(runtime.listTasks()[0].status, "achieved");
    await click(window, "重新执行（新 Run）");
    await waitUntil(() => runtime.listTasks()[0].status === "running" && runtime.listTasks()[0].latestRun.runId !== restartedRunId, "isolated re-run");
    const secondRunId = runtime.listTasks()[0].latestRun.runId;
    assert.notEqual(runtime.readRun({ runId: secondRunId }).run.conductorSessionId, runtime.readRun({ runId: restartedRunId }).run.conductorSessionId);
    runtime.recordCompletionClaim({ taskId: runtime.listTasks()[0].taskId });
    await click(window, "任务");
    await waitUntil(() => execute(window, 'document.body.innerText.includes("Achieve")'), "second achievement action");
    await click(window, "Achieve");
    await waitUntil(() => execute(window, 'document.body.innerText.includes("删除所选") && Boolean(document.querySelector("input[type=checkbox]"))'), "completed Task bulk deletion controls");
    const deliveryPath = path.join(smokeRoot, "docs", "research.md");
    fs.mkdirSync(path.dirname(deliveryPath), { recursive: true });
    fs.writeFileSync(deliveryPath, "# User delivery\n", "utf8");
    assert.deepEqual(runtime.readRun({ runId: secondRunId }).artifacts.map((artifact) => artifact.path), ["docs/research.md"], "Runtime must index the legacy candidate only after the project file exists");
    await execute(window, 'document.querySelector("input[type=checkbox]")?.click()');
    await waitUntil(() => execute(window, 'document.body.innerText.includes("删除所选 (1)")'), "one achieved Task selected for deletion");
    await click(window, "删除所选");
    await waitUntil(() => execute(window, 'Boolean(document.querySelector("[aria-label=\\"删除已完成 Task 确认\\"]"))'), "bulk delete confirmation dialog");
    await execute(window, `(() => {
      const dialog = document.querySelector('[aria-label="删除已完成 Task 确认"]');
      const button = Array.from(dialog?.querySelectorAll("button") || []).find((item) => item.innerText.trim() === "删除 1 个任务");
      if (!button) throw new Error("Delete confirmation button not found");
      button.click();
    })()`);
    await waitUntil(() => runtime.listTasks().length === 0, "Task Runtime deletion");
    assert.equal(fs.existsSync(deliveryPath), true, "Task deletion must not remove the project delivery file");
    await click(window, "运行现场");
    await waitUntil(() => execute(window, 'document.querySelectorAll(".agent-loop-task-tab").length === 0 && document.body.innerText.includes("尚无运行中的 Task")'), "deleted Task closes its Workbench tab");
    if (process.env.AGENT_LOOP_WORKBENCH_CAPTURE_PATH) {
      const capturePath = path.resolve(process.env.AGENT_LOOP_WORKBENCH_CAPTURE_PATH);
      fs.mkdirSync(path.dirname(capturePath), { recursive: true });
      fs.writeFileSync(capturePath, (await window.capturePage()).toPNG());
    }
    diagnostic("harness complete");
    return "H2 PASS: Electron Task-page permission targets its owning native Session, keeps decision cards outside Timeline, and preserves the native terminal lifecycle.\n";
  } finally {
    unsubscribe();
    unsubscribeClient();
    unsubscribeStore();
    sessionWakeupMonitor?.stop();
    runtime.close();
    sessionAuthority.close();
    await window.close();
    await ptyManager.close();
    await terminalDaemonSupervisor.stop();
    await realPermissionHookService?.close();
  }
}

function flushAndExit(stream, output, code) {
  stream.write(output, () => process.exit(code));
}

main().then(
  (summary) => flushAndExit(process.stdout, summary || "H2 PASS\n", 0),
  (error) => {
    diagnostic(`failed: ${error.stack || error.message}`);
    flushAndExit(process.stderr, `${error.stack || error.message}\n`, 1);
  },
);

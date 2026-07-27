const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { app, BrowserWindow, ipcMain } = require("electron");
const { createPtyManager } = require("./pty-manager.cjs");
const { createOrchestrationHarness } = require("./runtime/orchestration-harness.cjs");
const { createOpenCodeHookService } = require("./runtime/opencode-hook-service.cjs");
const { createSessionAuthority } = require("./runtime/session-authority.cjs");
const { createSessionStore } = require("./session-store.cjs");
const { resolveOpencodePath } = require("./opencode-runner.cjs");

const baseTargetUrl = process.env.AGENT_WORKSPACE_SMOKE_URL ?? "http://127.0.0.1:5188/";
const timeoutMs = Number(process.env.AGENT_WORKSPACE_SMOKE_TIMEOUT_MS ?? 120_000);
const smokeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-workspace-harness-ui-"));
const builderScreenshotPath = path.join(smokeRoot, "template-builder.png");
const taskScreenshotPath = path.join(smokeRoot, "task-timeline.png");
const screenshotPath = path.join(smokeRoot, "harness-workbench.png");
const templateScreenshotPath = path.join(smokeRoot, "template-library.png");

let harness;
let ptyManager;
let sessionAuthority;
let openCodeHookService;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(predicate, label) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const result = await predicate();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await delay(150);
  }
  throw new Error(`${label} timed out after ${timeoutMs}ms${lastError ? `: ${lastError.message}` : ""}`);
}

function buildTargetUrl() {
  const url = new URL(baseTargetUrl);
  url.searchParams.set("projectPath", process.cwd());
  url.searchParams.set("projectName", "Agent Workspace Harness E2E");
  return url.toString();
}

function publishPtyEvent(event) {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send("native:pty-event", event);
  }
}

function registerHarnessIpc() {
  ipcMain.handle("native:list-orchestration-templates", () => harness.listTemplates());
  ipcMain.handle("native:list-orchestration-template-blueprints", () => harness.listTemplateBlueprints());
  ipcMain.handle("native:save-orchestration-template", (_event, input) =>
    harness.saveTemplateVersion({
      id: String(input?.id ?? ""),
      family: String(input?.family ?? ""),
      version: Number(input?.version ?? 1),
      name: String(input?.name ?? ""),
      definition: input?.definition && typeof input.definition === "object" ? input.definition : {},
    }),
  );
  ipcMain.handle("native:create-harness-task", (_event, input) =>
    harness.createHarnessTask({
      taskId: input?.taskId ? String(input.taskId) : undefined,
      projectId: input?.projectId ? String(input.projectId) : undefined,
      cwd: String(input?.cwd ?? process.cwd()),
      title: String(input?.title ?? ""),
      goal: String(input?.goal ?? ""),
      model: input?.model ? String(input.model) : undefined,
      templateBlueprintId: input?.templateBlueprintId ? String(input.templateBlueprintId) : undefined,
      templateBlueprintVersion: input?.templateBlueprintVersion ? Number(input.templateBlueprintVersion) : undefined,
      agentLoopTemplateId: input?.agentLoopTemplateId ? String(input.agentLoopTemplateId) : undefined,
      agentLoopTemplateVersion: input?.agentLoopTemplateVersion ? Number(input.agentLoopTemplateVersion) : undefined,
    }),
  );
  ipcMain.handle("native:generate-orchestration-template-draft", (_event, input) =>
    harness.generateTemplateDraft({
      cwd: String(input?.cwd ?? process.cwd()),
      title: String(input?.title ?? ""),
      goal: String(input?.goal ?? ""),
      model: input?.model ? String(input.model) : undefined,
    }),
  );
  ipcMain.handle("native:create-manual-orchestration-template-draft", (_event, input) =>
    harness.createManualTemplateDraft({
      cwd: String(input?.cwd ?? process.cwd()),
      title: String(input?.title ?? ""),
      goal: input?.goal ? String(input.goal) : undefined,
      description: input?.description ? String(input.description) : undefined,
      model: input?.model ? String(input.model) : undefined,
      agentLoop: input?.agentLoop,
      workflow: input?.workflow,
    }),
  );
  ipcMain.handle("native:read-orchestration-template-draft", (_event, input) =>
    harness.readTemplateDraft({ draftId: String(input?.draftId ?? "") }),
  );
  ipcMain.handle("native:save-generated-orchestration-template-draft", (_event, input) =>
    harness.saveGeneratedTemplateDraft({ draftId: String(input?.draftId ?? "") }),
  );
  ipcMain.handle("native:list-harness-tasks", () => harness.listHarnessTasks());
  ipcMain.handle("native:read-harness-task", (_event, input) => harness.readTask({ taskId: String(input?.taskId ?? "") }));
  ipcMain.handle("native:start-harness-run", (_event, input) => harness.startHarnessRun({ taskId: String(input?.taskId ?? "") }));
  ipcMain.handle("native:read-harness-run", (_event, input) => harness.readRun({ runId: String(input?.runId ?? "") }));
  ipcMain.handle("native:mark-harness-task-achieved", (_event, input) =>
    harness.markTaskAchieved({ taskId: String(input?.taskId ?? "") }),
  );
  ipcMain.handle("native:read-workspace-session", (_event, input) =>
    sessionAuthority.readSession({ workspaceSessionId: String(input?.workspaceSessionId ?? ""), cursor: Number(input?.cursor ?? 0) }),
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
  ipcMain.handle("native:respond-harness-attention", (_event, input) =>
    harness.respondToAttention({
      attentionId: String(input?.attentionId ?? ""),
      response: String(input?.response ?? ""),
    }),
  );
}

async function execute(window, source) {
  return window.webContents.executeJavaScript(source);
}

async function settleVisual(window) {
  await execute(window, "new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
}

async function clickByText(window, text, label = text) {
  await execute(
    window,
    `(() => {
      const button = Array.from(document.querySelectorAll("button")).find((item) => item.innerText.includes(${JSON.stringify(text)}));
      if (!button) throw new Error(${JSON.stringify(`Missing button: ${label}`)});
      button.click();
    })()`,
  );
}

async function clickRail(window, label) {
  await execute(
    window,
    `(() => {
      const button = Array.from(document.querySelectorAll(".harness-rail-button")).find((item) => item.innerText.trim() === ${JSON.stringify(label)});
      if (!button) throw new Error(${JSON.stringify(`Missing rail button: ${label}`)});
      button.click();
    })()`,
  );
}

async function main() {
  const opencodePath = resolveOpencodePath();
  assert.ok(opencodePath, "A local OpenCode binary is required for this smoke.");
  app.commandLine.appendSwitch("disable-gpu");
  await app.whenReady();

  const pty = require("node-pty");
  const sessionStore = createSessionStore({ root: smokeRoot });
  ptyManager = createPtyManager({ pty, spawn, sessionStore, stoppedSessionRetentionMs: 60_000 });
  sessionAuthority = createSessionAuthority({
    ptyManager,
    databasePath: path.join(smokeRoot, "terminal-runtime.sqlite"),
  });
  harness = createOrchestrationHarness({
    sessionAuthority,
    ptyManager,
    sessionStore,
    opencodePath,
    databasePath: path.join(smokeRoot, "orchestration-harness.sqlite"),
    openCodeHookService: (openCodeHookService = createOpenCodeHookService()),
  });
  const unsubscribe = ptyManager.onEvent((event) => {
    sessionAuthority.handlePtyEvent(event);
    void harness.handlePtyEvent(event).catch((error) => process.stderr.write(`Harness event failure: ${error.stack || error.message}\n`));
    publishPtyEvent(event);
  });
  registerHarnessIpc();

  const window = new BrowserWindow({
    show: false,
    width: 1440,
    height: 960,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.cjs"),
    },
  });

  try {
    await window.loadURL(buildTargetUrl());
    await waitUntil(
      () => execute(window, 'Boolean(window.agentWorkspace?.native?.listOrchestrationTemplates) && document.body.innerText.includes("Runtime online")'),
      "Harness desktop shell",
    );
    const initial = await execute(
      window,
      `(() => ({
        task: document.body.innerText.includes("新建任务"),
        template: document.body.innerText.includes("模板"),
        workbench: document.body.innerText.includes("运行现场"),
        noFakeTask: document.body.innerText.includes("还没有任务")
      }))()`,
    );
    assert.deepEqual(initial, { task: true, template: true, workbench: true, noFakeTask: true });

    await clickRail(window, "模板");
    await clickByText(window, "新建模板");
    await waitUntil(() => execute(window, 'Boolean(document.querySelector(".harness-builder-modal"))'), "Template Builder modal");
    await execute(
      window,
      `(() => {
        const setValue = (element, value) => {
          const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          Object.getOwnPropertyDescriptor(prototype, "value").set.call(element, value);
          element.dispatchEvent(new Event("input", { bubbles: true }));
          element.dispatchEvent(new Event("change", { bubbles: true }));
        };
        const input = document.querySelector(".harness-builder-modal input");
        const textarea = document.querySelector(".harness-builder-modal textarea");
        if (!input || !textarea) throw new Error("Template Builder form controls missing");
        setValue(input, "UI E2E nested OpenCode harness");
        setValue(textarea, "Use one real Agent Loop policy and one nested Research & Verify Workflow, automatically remediate verifier findings, then return final artifacts.");
      })()`,
    );
    await clickByText(window, "生成草案");
    await waitUntil(() => execute(window, 'document.body.innerText.includes("候选 Draft")'), "Generated Template draft");
    await settleVisual(window);
    fs.writeFileSync(builderScreenshotPath, (await window.webContents.capturePage()).toPNG());
    await waitUntil(
      () => execute(window, 'Boolean(Array.from(document.querySelectorAll("button")).find((item) => item.innerText.includes("确认并保存模板") && !item.disabled))'),
      "Generated Blueprint ready to save",
    );
    await clickByText(window, "确认并保存模板");
    await waitUntil(() => execute(window, '!document.querySelector(".harness-builder-modal") && document.body.innerText.includes("UI E2E nested OpenCode harness")'), "Saved Template Blueprint");
    const runtimeDraft = harness.createManualTemplateDraft({
      cwd: process.cwd(),
      title: "UI E2E Runtime Template",
      description: "Collect one concise E2E fact, verify it, then return the result to Conductor.",
      agentLoop: { name: "UI E2E Runtime Loop", conductorRole: "E2E Conductor" },
      workflow: {
        name: "UI E2E Runtime Workflow",
        nodes: [
          { id: "collect", role: "Collector", instruction: "Reply exactly COLLECT_RESULT: E2E Runtime path completed; no files changed. Do not use tools or edit files.", kind: "delegate", dependsOn: [] },
          { id: "verify", role: "Verifier", instruction: "The collector must return one explicit E2E evidence statement. Reply exactly VERIFY_RESULT: PASS. Do not use tools or edit files.", kind: "verify", dependsOn: ["collect"] },
        ],
      },
    });
    harness.saveGeneratedTemplateDraft({ draftId: runtimeDraft.draftId });
    await clickByText(window, "刷新");
    await waitUntil(() => execute(window, 'document.body.innerText.includes("UI E2E Runtime Template")'), "Runtime smoke Blueprint");

    await clickRail(window, "任务");
    await clickByText(window, "新建任务");
    await waitUntil(() => execute(window, 'Boolean(document.querySelector(".harness-create-modal"))'), "Task architecture modal");
    await execute(
      window,
      `(() => {
        const setValue = (element, value) => {
          const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          Object.getOwnPropertyDescriptor(prototype, "value").set.call(element, value);
          element.dispatchEvent(new Event("input", { bubbles: true }));
          element.dispatchEvent(new Event("change", { bubbles: true }));
        };
        const input = document.querySelector(".harness-create-modal input");
        const textarea = document.querySelector(".harness-create-modal textarea");
        const select = document.querySelector('select[aria-label="Template Blueprint"]');
        if (!input || !textarea || !select) throw new Error("Task form controls missing");
        setValue(input, "UI E2E nested OpenCode task");
        setValue(textarea, "Return the explicit bounded E2E evidence statement requested by the selected Template. Do not create files or use tools.");
        const option = Array.from(select.options).find((item) => item.text.includes("UI E2E Runtime Template"));
        if (!option) throw new Error("Saved Blueprint option missing");
        Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(select, option.value);
        select.dispatchEvent(new Event("change", { bubbles: true }));
      })()`,
    );
    await clickByText(window, "确认 Task");
    await waitUntil(
      () => execute(window, 'document.body.innerText.includes("UI E2E nested OpenCode task") && document.body.innerText.includes("已确认，等待启动")'),
      "Persisted Task Timeline",
    );
    await settleVisual(window);
    fs.writeFileSync(taskScreenshotPath, (await window.webContents.capturePage()).toPNG());
    await clickByText(window, "启动 Run");
    await waitUntil(
      () => execute(window, 'document.body.innerText.includes("交付产物已就绪") && document.body.innerText.includes("Conductor 的执行规划") && document.body.innerText.includes("Workflow 已启动（图自主推进）")'),
      "OpenCode Agent Loop and nested Workflow completion",
    );

    const conversationCheck = await execute(
      window,
      `(() => ({
        taskInput: document.body.innerText.includes("你交给 Conductor 的任务"),
        conductorPlan: document.body.innerText.includes("Conductor 的执行规划"),
        workflowInput: document.body.innerText.includes("Workflow 已启动（图自主推进）"),
        finalAnswer: document.body.innerText.includes("Workflow 返回后的 Conductor 决策"),
        markdown: Boolean(document.querySelector(".harness-markdown"))
      }))()`,
    );
    assert.deepEqual(conversationCheck, { taskInput: true, conductorPlan: true, workflowInput: true, finalAnswer: true, markdown: true });
    await clickByText(window, "标记达成");
    await waitUntil(() => execute(window, 'document.body.innerText.includes("已达成 · 可归档")'), "Task achieved lifecycle");
    await settleVisual(window);
    fs.writeFileSync(taskScreenshotPath, (await window.webContents.capturePage()).toPNG());
    await execute(
      window,
      `(() => {
        const session = document.querySelector(".harness-conversation-message.session.clickable");
        if (!session) throw new Error("Missing Session conversation message");
        session.click();
      })()`,
    );
    await waitUntil(
      () => execute(window, 'Boolean(document.querySelector(".harness-workbench-layout")) && !document.querySelector(".harness-task-layout") && document.body.innerText.includes("OpenCode Session Terminal") && Boolean(document.querySelector(".xterm"))'),
      "Workbench OpenCode PTY",
    );
    const terminalCheck = await execute(
      window,
      `(() => ({
        terminal: document.body.innerText.includes("OpenCode Session Terminal"),
        activeNavigation: Array.from(document.querySelectorAll(".harness-rail-button.active")).map((item) => item.innerText.trim()),
        sessionRuntime: document.body.innerText.includes("Session Runtime"),
        workflowNoPty: document.body.innerText.includes("aggregate · 无终端"),
        xterm: Boolean(document.querySelector(".xterm")),
        sessionInputClaim: document.body.innerText.includes("原生 OpenCode mini-TUI"),
        activityPanelAbsent: !Boolean(document.querySelector(".harness-runtime-activity"))
      }))()`,
    );
    assert.equal(terminalCheck.terminal, true);
    assert.deepEqual(terminalCheck.activeNavigation, ["运行现场"]);
    assert.equal(terminalCheck.sessionRuntime, true);
    assert.equal(terminalCheck.workflowNoPty, true);
    assert.equal(terminalCheck.xterm, true);
    assert.equal(terminalCheck.sessionInputClaim, true);
    assert.equal(terminalCheck.activityPanelAbsent, true);
    await settleVisual(window);
    fs.writeFileSync(screenshotPath, (await window.webContents.capturePage()).toPNG());

    await clickRail(window, "模板");
    await waitUntil(
      () => execute(window, 'Boolean(document.querySelector(".harness-template-layout"))'),
      "Template page",
    );
    const templateCheck = await execute(
      window,
      `(() => ({
        blueprintList: Boolean(document.querySelector(".harness-template-group")),
        composition: Boolean(document.querySelector(".harness-template-composition")),
        builderEntry: Boolean(Array.from(document.querySelectorAll("button")).find((item) => item.innerText.includes("新建模板")))
      }))()`,
    );
    assert.equal(templateCheck.blueprintList, true);
    assert.equal(templateCheck.composition, true);
    assert.equal(templateCheck.builderEntry, true);
    await settleVisual(window);
    fs.writeFileSync(templateScreenshotPath, (await window.webContents.capturePage()).toPNG());

    await execute(window, 'document.querySelector("button[aria-label=\\"切换亮暗主题\\"]").click()');
    const themeCheck = await execute(window, 'document.querySelector(".harness-app")?.classList.contains("theme-light")');
    assert.equal(themeCheck, true);

    const run = harness.listHarnessTasks()[0]?.latestRun;
    const final = run ? harness.readRun({ runId: run.runId }) : undefined;
    assert.equal(final?.run.status, "delivery_ready");
    assert.equal(final?.workflow?.status, "succeeded");
    assert.ok((final?.turns.filter((turn) => turn.purpose === "workflow_node" && turn.status === "succeeded").length ?? 0) >= 2);
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: true,
          taskId: final?.task.taskId,
          runId: final?.run.runId,
          runStatus: final?.run.status,
          workflowStatus: final?.workflow?.status,
          turns: final?.turns.map((turn) => ({ purpose: turn.purpose, backend: turn.terminal?.backend, status: turn.status })),
          conversationCheck,
          terminalCheck,
          templateCheck,
          builderScreenshotPath,
          taskScreenshotPath,
          screenshotPath,
          templateScreenshotPath,
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    unsubscribe();
    harness?.close();
    await openCodeHookService?.close();
    sessionAuthority?.close();
    await window.close();
  }
}

main()
  .then(() => app.exit(0))
  .catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    app.exit(1);
  });

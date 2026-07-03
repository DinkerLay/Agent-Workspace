const path = require("node:path");
const { app, BrowserWindow, ipcMain } = require("electron");
const { getRuntimeStatus, listOpencodeAgents, runOpencode } = require("./opencode-runner.cjs");
const { generateTaskDraft } = require("./task-draft-assistant.cjs");

const targetUrl = process.env.AGENT_WORKSPACE_SMOKE_URL ?? "http://127.0.0.1:5188/";
const taskMessage =
  process.env.AGENT_WORKSPACE_DRAFT_MESSAGE ??
  "在 /Users/dinker/CODES/TEMP_project/Agent_Test 调研 claude dynamic workflow 机制，输出报告和 spec/plan 线索。";
const timeoutMs = Number(process.env.AGENT_WORKSPACE_SMOKE_TIMEOUT_MS ?? 60000);

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

async function waitFor(window, expression, label) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const result = await window.webContents.executeJavaScript(expression);
    if (result) return result;
    await delay(150);
  }
  throw new Error(`${label} timed out after ${timeoutMs}ms`);
}

function registerIpc() {
  ipcMain.handle("native:get-runtime-status", () =>
    getRuntimeStatus({
      ptyAvailable: true,
      ptyBackend: "node-pty+process-fallback",
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
  ipcMain.handle("native:generate-task-draft", (_event, input) =>
    generateTaskDraft({
      message: String(input?.message ?? ""),
      projectPath: String(input?.projectPath ?? process.cwd()),
      projectName: input?.projectName ? String(input.projectName) : undefined,
      model: input?.model ? String(input.model) : undefined,
      currentDraft: input?.currentDraft && typeof input.currentDraft === "object" ? input.currentDraft : undefined,
      timeoutMs: Number(input?.timeoutMs ?? timeoutMs),
    }),
  );
}

async function fillAndGenerate(window) {
  await window.webContents.executeJavaScript(`
    (() => {
      const textarea = document.querySelector('textarea[aria-label="一句话描述任务"]');
      if (!textarea) throw new Error("Missing Task Draft Assistant textarea");
      const descriptor = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value");
      descriptor.set.call(textarea, ${JSON.stringify(taskMessage)});
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
      textarea.dispatchEvent(new Event("change", { bubbles: true }));
      const button = Array.from(document.querySelectorAll("button")).find((item) => item.innerText.includes("生成配置"));
      if (!button) throw new Error("Missing generate config button");
      button.click();
    })()
  `);
}

async function main() {
  app.commandLine.appendSwitch("disable-gpu");
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
  await waitFor(window, `Boolean(window.agentWorkspace?.native?.generateTaskDraft)`, "native draft bridge");
  await waitFor(window, `Boolean(document.querySelector('textarea[aria-label="一句话描述任务"]'))`, "Task Draft Assistant");
  await fillAndGenerate(window);
  const result = await waitFor(
    window,
    `(() => {
      const title = document.querySelector('input[aria-label="任务标题"]')?.value ?? "";
      const summary = document.querySelector('textarea[aria-label="任务目标"]')?.value ?? "";
      const labels = document.querySelector('input[aria-label="任务标签"]')?.value ?? "";
      const model = document.querySelector('input[aria-label="Conductor 模型"]')?.value ?? "";
      const template = document.querySelector('select[aria-label="任务模板"]')?.value ?? "";
      const projectText = document.body.innerText;
      const error = projectText.includes("native:generate-task-draft") || projectText.includes("No handler registered");
      if (!title || !summary || !labels || error) return false;
      return { title, summary, labels, model, template, hasAgentTest: projectText.includes("Agent_Test") };
    })()`,
    "task draft form fill",
  );

  if (result.template !== "research") {
    throw new Error(`Expected research template, got ${result.template}`);
  }
  if (!result.model.includes("opencode-go/deepseek-v4-flash")) {
    throw new Error(`Expected opencode model, got ${result.model}`);
  }
  if (!result.hasAgentTest) {
    throw new Error("Expected generated project context to include Agent_Test");
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        targetUrl,
        taskMessage,
        result,
      },
      null,
      2,
    ),
  );

  await window.close();
  app.quit();
}

main().catch((error) => {
  console.error(error);
  app.exit(1);
});

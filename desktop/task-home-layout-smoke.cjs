const { app, BrowserWindow } = require("electron");

const targetUrl = process.env.AGENT_WORKSPACE_SMOKE_URL ?? "http://127.0.0.1:5188/";
const timeoutMs = Number(process.env.AGENT_WORKSPACE_SMOKE_TIMEOUT_MS ?? 20000);

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
    await delay(100);
  }
  throw new Error(`${label} timed out after ${timeoutMs}ms`);
}

async function collectMetrics(window) {
  return window.webContents.executeJavaScript(`
    (() => {
      const bodyText = document.body.innerText;
      const doc = document.documentElement;
      const workerGrid = document.querySelector(".worker-agent-grid");
      const taskHome = document.querySelector(".task-home-layout");
      const workerCards = Array.from(document.querySelectorAll(".worker-agent-card")).map((el) =>
        el.innerText.split("\\n").filter(Boolean).slice(0, 3)
      );
      return {
        url: location.href,
        title: document.title,
        viewport: { width: window.innerWidth, height: window.innerHeight },
        hasNoTaskCopy: bodyText.includes("还没有任务"),
        hasNewTaskForm: Boolean(document.querySelector(".task-home-intake-form")),
        hasConductorTerminal: bodyText.includes("Conductor Terminal"),
        hasConductor: bodyText.includes("Conductor"),
        hasExecutor: bodyText.includes("Executor"),
        hasQA: bodyText.includes("QA"),
        visibleMockText: /mock|mocked|mock-run/i.test(bodyText),
        scrollWidth: doc.scrollWidth,
        clientWidth: doc.clientWidth,
        horizontalOverflow: doc.scrollWidth > doc.clientWidth,
        taskHome: taskHome ? { scrollWidth: taskHome.scrollWidth, clientWidth: taskHome.clientWidth } : null,
        workerGrid: workerGrid
          ? {
              cardCount: workerCards.length,
              scrollHeight: workerGrid.scrollHeight,
              clientHeight: workerGrid.clientHeight,
              overflowY: getComputedStyle(workerGrid).overflowY,
              internalScrollbar: workerGrid.scrollHeight > workerGrid.clientHeight,
            }
          : null,
        workerCards,
      };
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

      setValue('input[aria-label="任务标题"]', "Electron layout smoke");
      setValue('textarea[aria-label="任务目标"]', "验证 Task Home 布局和任务创建");
      setValue('select[aria-label="任务模板"]', "implementation");
      const submit = document.querySelector("form.task-home-intake-form button[type=submit]");
      if (!submit) throw new Error("Missing task submit button");
      submit.click();
    })()
  `);
  await waitFor(window, `document.body.innerText.includes("Conductor Terminal")`, "task creation");
}

async function main() {
  app.commandLine.appendSwitch("disable-gpu");
  await app.whenReady();

  const window = new BrowserWindow({
    show: false,
    width: 1360,
    height: 900,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  await withTimeout(window.loadURL(targetUrl), `load ${targetUrl}`);
  await waitFor(window, `Boolean(document.querySelector(".task-home-intake-form"))`, "Task Home intake");

  const initial = await collectMetrics(window);
  await createTask(window);
  const desktop = await collectMetrics(window);

  window.setSize(430, 900);
  await delay(300);
  const narrow = await collectMetrics(window);

  const ok =
    initial.hasNoTaskCopy &&
    initial.hasNewTaskForm &&
    !initial.hasConductorTerminal &&
    !initial.visibleMockText &&
    desktop.hasConductorTerminal &&
    desktop.hasConductor &&
    desktop.hasExecutor &&
    desktop.hasQA &&
    !desktop.visibleMockText &&
    !desktop.horizontalOverflow &&
    !desktop.workerGrid?.internalScrollbar &&
    !narrow.horizontalOverflow &&
    !narrow.workerGrid?.internalScrollbar;

  console.log(JSON.stringify({ ok, targetUrl, initial, desktop, narrow }, null, 2));
  app.exit(ok ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  app.exit(1);
});

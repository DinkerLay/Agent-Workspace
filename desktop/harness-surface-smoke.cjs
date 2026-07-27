const assert = require("node:assert/strict");
const path = require("node:path");
const { app, BrowserWindow, ipcMain } = require("electron");

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(predicate, label, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(80);
  }
  throw new Error(`${label} timed out after ${timeoutMs}ms`);
}

async function main() {
  app.commandLine.appendSwitch("disable-gpu");
  await app.whenReady();

  // Agent Loop renders its initial data through these read-only Runtime calls.
  // Keep this smoke intentionally free of OpenCode or PTY startup.
  ipcMain.handle("native:list-agent-loop-templates", () => []);
  ipcMain.handle("native:list-agent-loop-tasks", () => []);

  const window = new BrowserWindow({
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.cjs"),
    },
  });

  try {
    await window.loadFile(path.join(process.cwd(), "dist", "index.html"), {
      query: {
        projectPath: process.cwd(),
        projectName: "Harness surface smoke",
      },
    });
    await waitUntil(
      () => window.webContents.executeJavaScript(
        `Boolean(document.querySelector(".harness-app"))
          && document.body.innerText.includes("Runtime online")
          && document.body.innerText.includes("Agent Loop")`,
      ),
      "Electron Agent Loop surface",
    );

    const surface = await window.webContents.executeJavaScript(
      `(() => ({
        harness: Boolean(document.querySelector(".harness-app")),
        legacyTaskHome: document.body.innerText.includes("任务主页"),
        browserReadOnlyNotice: document.body.innerText.includes("浏览器预览 · 只读"),
        taskButtonEnabled: !document.querySelector("button.harness-primary-button.compact")?.disabled,
        workflowVisible: document.body.innerText.includes("Workflow") || document.body.innerText.includes("Graph")
      }))()`,
    );
    assert.deepEqual(surface, {
      harness: true,
      legacyTaskHome: false,
      browserReadOnlyNotice: false,
      taskButtonEnabled: true,
      workflowVisible: false,
    });
    process.stdout.write("Electron Agent Loop surface smoke passed\n");
  } finally {
    await window.close();
  }
}

main()
  .then(() => app.exit(0))
  .catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    app.exit(1);
  });

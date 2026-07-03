#!/usr/bin/env node

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { app } = require("electron");
const {
  createElectronSimulationHarness,
  waitUntil,
} = require("../lib/electron-simulation-harness.cjs");

const projectPath =
  process.env.AGENT_WORKSPACE_REAL_PROJECT_PATH ?? "/Users/dinker/CODES/TEMP_project/Agent_Test";
const projectName = process.env.AGENT_WORKSPACE_REAL_PROJECT_NAME ?? path.basename(projectPath);
const docsPath = path.join(projectPath, "docs");
const runtimeRoot =
  process.env.AGENT_WORKSPACE_REAL_RUNTIME_ROOT ??
  path.join(projectPath, ".agent-workspace", "test-simulte-runtime");
const model = process.env.AGENT_WORKSPACE_REAL_MODEL ?? "opencode-go/deepseek-v4-flash";
const timeoutMs = Number(process.env.AGENT_WORKSPACE_REAL_RESEARCH_TIMEOUT_MS ?? 600_000);
const taskTitle = "调研 Claude Dynamic Workflow 机制";
const taskGoal = [
  `在 ${projectPath} 调研 claude dynamic workflow 机制。`,
  "必须从本次空 docs 状态开始产生新文件，不要依赖历史 docs 内容。",
  "输出一份研究报告到 docs/research/。",
  "提取可用于后续 spec 和 implementation plan 的线索，分别写入 docs/superworks/spec/ 和 docs/superworks/plans/。",
  "优先通过 call_session 派发 Researcher / Reviewer session；Conductor 读取 worker session 结果后再决定是否补问或收敛。",
  "Conductor 只管理任务主线和派发下一步；如果 Reviewer 提出修正，必须再次派发给 worker session，不要由 Conductor 亲自修改交付物。",
].join("\n");

app.commandLine.appendSwitch("disable-gpu");

async function main() {
  assertProjectPathIsSafe(projectPath);
  clearDocsDirectory();
  clearSimulationRuntimeDirectory();

  const vite = await startViteServer();
  const harness = await createElectronSimulationHarness({ projectPath, model, root: runtimeRoot });

  try {
    const url = new URL(vite.url);
    url.searchParams.set("projectPath", projectPath);
    url.searchParams.set("projectName", projectName);
    const window = await harness.createWindowForUrl(url.toString());

    await waitForRenderer(window, `Boolean(window.agentWorkspace?.native)`, "native preload");
    await waitForRenderer(window, `Boolean(document.querySelector(".task-home-intake-form"))`, "Task Home intake form");
    await createResearchTask(window);

    const taskId = "task-intake-001";
    const conductorSessionId = `opencode:project-runtime-current:${taskId}:${taskId}-conductor`;
    await waitUntil(
      () => harness.ptyStarts.some((start) => start.id === conductorSessionId),
      "Conductor session starts from Task Home intake",
      { timeoutMs: 30_000, intervalMs: 250 },
    );
    await waitUntil(
      () =>
        harness.ptyWrites.some(
          (write) =>
            write.id === conductorSessionId &&
            write.text.includes("Start this Agent Workspace task now.") &&
            write.text.includes(taskTitle) &&
            write.text.includes("Confirmed Task Session Plan:") &&
            write.text.includes("Reviewer") &&
            write.text.includes("If Reviewer requests changes"),
        ),
      "Conductor receives initial task kickoff",
      { timeoutMs: 45_000, intervalMs: 250 },
    );

    const result = await waitUntil(
      async () => {
        const files = listDocsFiles();
        const workerStarts = harness.ptyStarts.filter(
          (start) => start.id.includes(`${taskId}-researcher`) || start.id.includes(`${taskId}-reviewer`),
        );
        const resultDispatches = workerStarts.flatMap((start) => {
          const view = harness.sessionStore.readSession({
            taskId,
            sessionId: start.id,
            maxChars: 4_000,
          });
          return view.dispatches.filter((dispatch) => dispatch.status === "result_available");
        });
        const outputs = classifyDocsOutput(files);
        if (
          outputs.hasResearchReport &&
          outputs.hasSpecClues &&
          outputs.hasPlanClues &&
          workerStarts.length >= 2 &&
          resultDispatches.length >= 2
        ) {
          return {
            files,
            workerStarts,
            resultDispatches,
            outputs,
          };
        }
        return false;
      },
      "real research task creates docs outputs and dispatches Researcher plus Reviewer worker sessions",
      { timeoutMs, intervalMs: 5_000 },
    );
    assertRuntimeDispatchCorrelation(taskId, result.resultDispatches);
    assertStartedSessionHealth(taskId, harness.ptyStarts, result.resultDispatches);
    assertWorkerDeliveryWrites(harness.ptyWrites, result.resultDispatches);
    assertNoLegacyRuntimeArtifacts();

    console.log(
      JSON.stringify(
        {
          ok: true,
          scenario: "task-home-real-research/claude-dynamic-workflow",
          projectPath,
          docsPath,
          runtimeRoot,
          model,
          taskTitle,
          startedSessions: harness.ptyStarts.map((start) => ({
            id: start.id,
            command: start.command,
            cwd: start.cwd,
            args: start.args,
          })),
          ptyWrites: harness.ptyWrites.map((write) => ({
            id: write.id,
            bytes: write.text.length,
          })),
          outputs: result.outputs,
          files: result.files,
          resultDispatches: result.resultDispatches.map((dispatch) => ({
            dispatchId: dispatch.dispatchId,
            toSessionId: dispatch.toSessionId,
            status: dispatch.status,
            resultSource: dispatch.resultSource,
            providerSessionId: dispatch.providerSessionId,
            providerMessageId: dispatch.providerMessageId,
          })),
        },
        null,
        2,
      ),
    );
  } catch (error) {
    const taskId = "task-intake-001";
    const sessionTails = {};
    for (const start of harness.ptyStarts) {
      const view = harness.sessionStore.readSession({
        taskId,
        sessionId: start.id,
        maxChars: 4_000,
      });
      sessionTails[start.id] = {
        state: view.state,
        dispatches: view.dispatches,
        cleanTranscriptTail: view.cleanTranscriptTail,
      };
    }
    console.error(
      JSON.stringify(
        {
          ok: false,
          scenario: "task-home-real-research/claude-dynamic-workflow",
          error: error instanceof Error ? error.message : String(error),
          projectPath,
          docsPath,
          runtimeRoot,
          docsFiles: listDocsFiles(),
          startedSessions: harness.ptyStarts.map((start) => ({
            id: start.id,
            command: start.command,
            cwd: start.cwd,
            args: start.args,
          })),
          ptyWrites: harness.ptyWrites.map((write) => ({
            id: write.id,
            bytes: write.text.length,
          })),
          sessionTails,
        },
        null,
        2,
      ),
    );
    throw error;
  } finally {
    await harness.cleanup();
    await vite.close();
  }
}

function assertProjectPathIsSafe(value) {
  const resolved = path.resolve(value);
  const expected = path.resolve("/Users/dinker/CODES/TEMP_project/Agent_Test");
  if (resolved !== expected) {
    throw new Error(`Refusing to clear docs for unexpected project path: ${resolved}`);
  }
}

function clearDocsDirectory() {
  fs.rmSync(docsPath, { recursive: true, force: true });
  fs.mkdirSync(docsPath, { recursive: true });
  const remaining = listDocsFiles();
  if (remaining.length > 0) {
    throw new Error(`Docs directory was not cleared: ${remaining.map((file) => file.relativePath).join(", ")}`);
  }
}

function clearSimulationRuntimeDirectory() {
  fs.rmSync(runtimeRoot, { recursive: true, force: true });
  fs.mkdirSync(runtimeRoot, { recursive: true });
}

async function startViteServer() {
  const { createServer } = await import("vite");
  const server = await createServer({
    root: process.cwd(),
    clearScreen: false,
    logLevel: "error",
    server: {
      host: "127.0.0.1",
      port: 0,
      strictPort: false,
    },
  });
  await server.listen();
  const address = server.httpServer?.address();
  if (!address || typeof address === "string") {
    throw new Error("Unable to resolve Vite dev server address.");
  }
  return {
    url: `http://127.0.0.1:${address.port}/`,
    close: () => server.close(),
  };
}

async function waitForRenderer(window, expression, label, options = {}) {
  return waitUntil(
    async () => {
      try {
        return await window.webContents.executeJavaScript(`Boolean(${expression})`);
      } catch {
        return false;
      }
    },
    label,
    { timeoutMs: options.timeoutMs ?? 30_000, intervalMs: options.intervalMs ?? 250 },
  );
}

async function createResearchTask(window) {
  const createResult = await window.webContents.executeJavaScript(`
    (() => {
      try {
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
      setValue('textarea[aria-label="任务目标"]', ${JSON.stringify(taskGoal)});
      setValue('select[aria-label="起始方案"]', "research");
      setValue('input[aria-label="Conductor 模型"]', ${JSON.stringify(model)});
      setValue('input[aria-label="任务标签"]', "research, claude, dynamic-workflow");
      setValue('input[aria-label="附件路径"]', "docs/research/claude-dynamic-workflow-research.md");

      if (!document.querySelector('[aria-label="Conductor session 卡片"]')) {
        throw new Error("Missing Conductor session card");
      }
      if (!document.querySelector('[aria-label="Researcher session 卡片"]')) {
        throw new Error("Missing Researcher session card");
      }
      if (!document.querySelector('[aria-label="Reviewer session 卡片"]')) {
        throw new Error("Missing Reviewer session card");
      }

      const sessionPlanField = document.querySelector('textarea[aria-label="Session Agent Plan JSON"]');
      if (!sessionPlanField) throw new Error("Missing advanced Session Agent Plan JSON field");
      const sessionPlan = JSON.parse(sessionPlanField.value);
      const workerNames = (sessionPlan.workers || []).map((worker) => worker.name);
      const sessionPlanText = JSON.stringify(sessionPlan);
      if (!workerNames.includes("Researcher")) throw new Error("Session Agent Plan missing Researcher worker");
      if (!workerNames.includes("Reviewer")) throw new Error("Session Agent Plan missing Reviewer worker");
      if (!sessionPlanText.includes("Reviewer") || !sessionPlanText.includes("requests changes")) {
        throw new Error("Session Agent Plan missing review loop guidance");
      }
      if (!sessionPlanText.includes(${JSON.stringify(model)})) {
        throw new Error("Session Agent Plan missing selected model");
      }

      const submit = document.querySelector("form.task-home-intake-form button[type=submit]");
      if (!submit) throw new Error("Missing task submit button");
      submit.click();
      return { ok: true };
      } catch (error) {
        return {
          ok: false,
          message: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
          bodyText: document.body.innerText.slice(0, 4000),
        };
      }
    })()
  `);
  if (!createResult?.ok) {
    throw new Error(`Task create script failed: ${createResult?.message}\n${createResult?.bodyText ?? ""}`);
  }
  await waitForRenderer(window, `document.body.innerText.includes(${JSON.stringify(taskTitle)})`, "created task visible");
  await waitForRenderer(window, `document.body.innerText.includes("Conductor Terminal")`, "Conductor terminal visible");
}

function listDocsFiles() {
  if (!fs.existsSync(docsPath)) return [];
  const files = [];
  visit(docsPath);
  return files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));

  function visit(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const target = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(target);
        continue;
      }
      if (!entry.isFile()) continue;
      const contents = fs.readFileSync(target, "utf8");
      files.push({
        relativePath: path.relative(projectPath, target),
        bytes: Buffer.byteLength(contents),
        hasClaude: /claude/i.test(contents),
        hasDynamicWorkflow: /dynamic workflow|dynamic-workflow|动态工作流/i.test(contents),
      });
    }
  }
}

function classifyDocsOutput(files) {
  return {
    hasResearchReport: files.some(
      (file) =>
        file.relativePath.startsWith("docs/research/") &&
        file.relativePath.endsWith(".md") &&
        file.bytes >= 500 &&
        file.hasClaude &&
        file.hasDynamicWorkflow,
    ),
    hasSpecClues: files.some(
      (file) =>
        file.relativePath.startsWith("docs/superworks/spec/") &&
        file.relativePath.endsWith(".md") &&
        file.bytes >= 200,
    ),
    hasPlanClues: files.some(
      (file) =>
        file.relativePath.startsWith("docs/superworks/plans/") &&
        file.relativePath.endsWith(".md") &&
        file.bytes >= 200,
    ),
  };
}

function assertRuntimeDispatchCorrelation(taskId, resultDispatches) {
  assert.ok(resultDispatches.length >= 2, "expected at least Researcher and Reviewer dispatch results");
  const dispatchIds = resultDispatches.map((dispatch) => dispatch.dispatchId);
  assert.equal(new Set(dispatchIds).size, dispatchIds.length, "dispatchId must be unique within the runtime task");
  for (const dispatchId of dispatchIds) {
    assert.match(dispatchId, /^[A-F0-9]{6}$/, "dispatchId must be a 6-character uppercase hex code");
  }

  const taskRoot = path.join(runtimeRoot, "runtime", taskId);
  const taskMessages = readJsonLines(path.join(taskRoot, "messages.jsonl"));
  const taskEvents = readJsonLines(path.join(taskRoot, "events.jsonl"));

  for (const dispatch of resultDispatches) {
    const sessionRoot = path.join(taskRoot, "sessions", safeSegment(dispatch.toSessionId));
    const sessionDispatches = readJsonLines(path.join(sessionRoot, "dispatches.jsonl"));
    const sessionResults = readJsonLines(path.join(sessionRoot, "results.jsonl"));
    const sessionEvents = readJsonLines(path.join(sessionRoot, "events.jsonl"));
    const dispatchRecord = sessionDispatches.find((record) => record.dispatchId === dispatch.dispatchId);
    const resultRecord = sessionResults.find((record) => record.dispatchId === dispatch.dispatchId);
    const messageRecord = taskMessages.find((record) => record.dispatchId === dispatch.dispatchId);
    const resultEvents = taskEvents.filter(
      (event) => event.type === "dispatch.result_available" && event.data?.dispatchId === dispatch.dispatchId,
    );

    assert.ok(dispatchRecord, `missing dispatch record for ${dispatch.dispatchId}`);
    assert.equal(dispatchRecord.status, "result_available");
    assert.equal(dispatchRecord.dispatchKey, undefined);

    assert.ok(resultRecord, `missing result record for ${dispatch.dispatchId}`);
    assert.equal(resultRecord.resultId, `result-${dispatch.dispatchId}`);
    assert.equal(resultRecord.provider, "opencode");
    assert.equal(resultRecord.source, "opencode-message-parts");
    assert.equal(resultRecord.workspaceMessageId, undefined);
    assert.equal(resultRecord.answerHash, undefined);
    assert.equal(typeof resultRecord.answerText, "string");
    assert.ok(resultRecord.answerText.length > 100, `result answer text too small for ${dispatch.dispatchId}`);

    assert.ok(messageRecord, `missing task message record for ${dispatch.dispatchId}`);
    assert.equal(messageRecord.resultId, resultRecord.resultId);
    assert.equal(messageRecord.sessionId, dispatch.toSessionId);
    assert.equal(messageRecord.providerMessageId, resultRecord.providerMessageId);
    assert.equal(messageRecord.workspaceMessageId, undefined);

    assert.equal(resultEvents.length, 1, `expected exactly one task result event for ${dispatch.dispatchId}`);
    assert.ok(
      sessionEvents.some(
        (event) => event.type === "dispatch.result_available" && event.data?.dispatchId === dispatch.dispatchId,
      ),
      `missing session result event for ${dispatch.dispatchId}`,
    );
  }
}

function assertStartedSessionHealth(taskId, starts, resultDispatches) {
  const expectedSessionIds = new Set([
    `opencode:project-runtime-current:${taskId}:${taskId}-conductor`,
    ...resultDispatches.map((dispatch) => dispatch.toSessionId),
  ]);
  for (const sessionId of expectedSessionIds) {
    const matches = starts.filter((start) => start.id === sessionId);
    assert.equal(matches.length, 1, `expected exactly one PTY start for ${sessionId}`);
    assert.equal(matches[0].cwd, projectPath, `unexpected cwd for ${sessionId}`);
    assert.deepEqual(matches[0].args, ["--model", model], `unexpected opencode args for ${sessionId}`);
    assert.equal(matches[0].args.includes("--agent"), false, `workspace role leaked into provider --agent for ${sessionId}`);
  }
}

function assertWorkerDeliveryWrites(writes, resultDispatches) {
  for (const dispatch of resultDispatches) {
    const workerWrites = writes.filter((write) => write.id === dispatch.toSessionId);
    assert.equal(workerWrites.length, 1, `expected exactly one assignment write for ${dispatch.toSessionId}`);
    assert.ok(
      workerWrites[0].text.includes(`[Agent Workspace] Dispatch ID ${dispatch.dispatchId}`),
      `assignment write missing dispatchId marker ${dispatch.dispatchId}`,
    );
    assert.ok(workerWrites[0].text.includes("\x1b[200~"), "assignment should use bracketed paste start");
    assert.ok(workerWrites[0].text.includes("\x1b[201~\r"), "assignment should use bracketed paste end and submit");
    assert.equal(workerWrites[0].text.includes("Dispatch Key"), false, "legacy Dispatch Key marker must not be written");
  }
}

function assertNoLegacyRuntimeArtifacts() {
  const legacyFiles = [];
  visit(runtimeRoot);
  assert.deepEqual(legacyFiles, [], `legacy runtime artifacts should not be written: ${legacyFiles.join(", ")}`);

  function visit(dir) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const target = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(target);
        continue;
      }
      if (!entry.isFile()) continue;
      if (entry.name === "transcript.raw.log" || entry.name === "transcript.clean.log" || entry.name === "latest.txt") {
        legacyFiles.push(path.relative(runtimeRoot, target));
      }
    }
  }
}

function readJsonLines(file) {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function safeSegment(value) {
  return String(value || "unknown").replace(/[^a-zA-Z0-9._-]/g, "-");
}

main()
  .then(() => app.exit(0))
  .catch(() => app.exit(1));

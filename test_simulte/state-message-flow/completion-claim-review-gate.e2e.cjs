#!/usr/bin/env node

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { app } = require("electron");
const {
  createElectronSimulationHarness,
  waitUntil,
} = require("../lib/electron-simulation-harness.cjs");

const taskTitle = "E2E State-driven message flow";
const taskGoal = [
  "Verify that Session Store runtime facts drive Agent card labels.",
  "Verify that structured task.completion_claim enters the Review gate.",
].join("\n");
const uiTaskId = "task-intake-001";
const model = "opencode-go/deepseek-v4-flash";

app.commandLine.appendSwitch("disable-gpu");

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-workspace-state-flow-e2e-"));
  const projectPath = path.join(root, "project");
  const opencodePath = writeFakeOpencodeBinary(root);
  const vite = await startViteServer();
  const harness = await createElectronSimulationHarness({
    root,
    projectPath,
    opencodePath,
    model,
    requireRealPty: false,
  });

  try {
    const url = new URL(vite.url);
    url.searchParams.set("projectPath", projectPath);
    url.searchParams.set("projectName", "State Flow E2E");
    const window = await harness.createWindowForUrl(url.toString());

    await waitForRenderer(window, `Boolean(window.agentWorkspace?.native)`, "native preload");
    await waitForRenderer(window, `Boolean(document.querySelector(".task-home-intake-form"))`, "Task Home intake form");
    await createTask(window);

    const taskContext = await waitUntil(
      () => findRuntimeTaskContext(harness),
      "Task intake is recorded in Session Store",
      { timeoutMs: 10_000, intervalMs: 100 },
    );

    const researcherSessionId = sessionIdFor(taskContext, `${uiTaskId}-researcher`);
    const conductorSessionId = sessionIdFor(taskContext, `${uiTaskId}-conductor`);
    const { firstDispatch, result, secondDispatch } = injectCompositeRuntimeState({
      sessionStore: harness.sessionStore,
      projectPath,
      taskId: taskContext.taskId,
      researcherSessionId,
    });

    await waitForRenderer(
      window,
      `document.body.innerText.includes("Delivery failed · result available")`,
      "composite Agent label",
      { timeoutMs: 6_000, intervalMs: 150 },
    );

    const compositeTaskState = harness.sessionStore.readTaskState({ taskId: taskContext.taskId });
    const compositeResearcherSummary = compositeTaskState.sessions.find(
      (session) => session.sessionId === researcherSessionId,
    );
    assert.equal(compositeResearcherSummary?.state, "delivery_failed");
    assert.equal(compositeResearcherSummary?.lastResultId, result.resultId);
    assert.equal(compositeResearcherSummary?.resultCount, 1);
    assert.equal(compositeResearcherSummary?.unresolvedFailureDispatchId, secondDispatch.dispatchId);
    assert.ok(
      compositeTaskState.pendingDecisions.some(
        (decision) =>
          decision.type === "worker_result_available" &&
          decision.dispatchId === firstDispatch.dispatchId &&
          decision.resultId === result.resultId,
      ),
      "worker result decision should remain visible before retry",
    );
    assert.ok(
      compositeTaskState.pendingDecisions.some(
        (decision) =>
          decision.type === "session_delivery_failed" &&
          decision.dispatchId === secondDispatch.dispatchId &&
          decision.relatedDispatchIds?.includes(firstDispatch.dispatchId),
      ),
      "delivery failure decision should point at the failed dispatch without hiding the result before retry",
    );

    await clickAgentCard(window, "Researcher", "Delivery failed");
    await waitForRenderer(
      window,
      `Array.from(document.querySelectorAll("button")).some((button) => button.innerText.trim() === "重试发送")`,
      "state-driven retry action",
      { timeoutMs: 6_000, intervalMs: 150 },
    );
    await clickButtonByText(window, "重试发送");

    const retryDispatch = await waitUntil(
      () => {
        const state = harness.sessionStore.readTaskState({ taskId: taskContext.taskId });
        return state.dispatches.find(
          (dispatch) =>
            dispatch.toSessionId === researcherSessionId &&
            dispatch.status === "delivered" &&
            dispatch.assignment === secondDispatch.assignment &&
            dispatch.dispatchId !== secondDispatch.dispatchId,
        );
      },
      "state-driven recovery action creates a delivered retry dispatch",
      { timeoutMs: 10_000, intervalMs: 100 },
    );
    const retryWrite = harness.ptyWrites.find(
      (write) => write.id === researcherSessionId && write.text.includes(secondDispatch.assignment),
    );
    assert.ok(retryWrite, "retry action should write the failed assignment through call_session");
    assert.ok(
      harness.sessionStore
        .readTaskState({ taskId: taskContext.taskId })
        .events.some(
          (event) =>
            event.type === "user.intervention" &&
            event.data?.source === "agent-recovery-action" &&
            event.data?.actionId === "retry_delivery" &&
            event.data?.failedDispatchId === secondDispatch.dispatchId,
        ),
      "retry action should be recorded as user recovery evidence",
    );

    await harness.conductorToolBridge.claimTaskCompletion({
      taskId: taskContext.taskId,
      sessionId: conductorSessionId,
      message: "Structured completion claim: ready for Review gate.",
    });

    await waitForRenderer(
      window,
      `document.body.innerText.includes("Review / 交付门禁")`,
      "completion claim routes to Review gate",
      { timeoutMs: 6_000, intervalMs: 150 },
    );

    const taskState = harness.sessionStore.readTaskState({ taskId: taskContext.taskId });
    const researcherSummary = taskState.sessions.find((session) => session.sessionId === researcherSessionId);
    assert.equal(researcherSummary?.state, "delivered_pending");
    assert.equal(researcherSummary?.activeDispatchId, retryDispatch.dispatchId);
    assert.equal(researcherSummary?.lastResultId, result.resultId);
    assert.equal(researcherSummary?.resultCount, 1);
    assert.ok(
      taskState.pendingDecisions.some(
        (decision) =>
          decision.type === "worker_result_available" &&
          decision.dispatchId === firstDispatch.dispatchId &&
          decision.resultId === result.resultId,
      ),
      "worker result decision should remain visible",
    );

    console.log(
      JSON.stringify(
        {
          ok: true,
          scenario: "state-message-flow/completion-claim-review-gate",
          taskId: taskContext.taskId,
          projectId: taskContext.projectId,
          researcherSessionId,
          firstDispatchId: firstDispatch.dispatchId,
          resultId: result.resultId,
          failedDispatchId: secondDispatch.dispatchId,
          retryDispatchId: retryDispatch.dispatchId,
          projectedState: researcherSummary?.state,
        },
        null,
        2,
      ),
    );
  } finally {
    await harness.cleanup();
    await vite.close();
  }
}

async function clickAgentCard(window, name, statusText) {
  const clicked = await window.webContents.executeJavaScript(`
    (() => {
      const buttons = Array.from(document.querySelectorAll(".task-session-agent"));
      const button = buttons.find((item) =>
        item.innerText.includes(${JSON.stringify(name)}) &&
        item.innerText.includes(${JSON.stringify(statusText)})
      );
      if (!button) return false;
      button.click();
      return true;
    })();
  `);
  assert.equal(clicked, true, `Expected to click agent card ${name} / ${statusText}`);
}

async function clickButtonByText(window, text) {
  const clicked = await window.webContents.executeJavaScript(`
    (() => {
      const button = Array.from(document.querySelectorAll("button")).find(
        (item) => item.innerText.trim() === ${JSON.stringify(text)}
      );
      if (!button) return false;
      button.click();
      return true;
    })();
  `);
  assert.equal(clicked, true, `Expected to click button ${text}`);
}

function findRuntimeTaskContext(harness) {
  const conductorStart = harness.ptyStarts.find((start) => String(start.id).endsWith(`:${uiTaskId}-conductor`));
  if (!conductorStart) return false;
  const parts = String(conductorStart.id).split(":");
  if (parts.length < 4) return false;
  const projectId = parts[1];
  const taskId = parts[2];
  const state = harness.sessionStore.readTaskState({ taskId });
  if (!state.events.some((event) => event.type === "task.user_message")) return false;
  return { projectId, taskId };
}

function sessionIdFor(taskContext, agentId) {
  return `opencode:${taskContext.projectId}:${taskContext.taskId}:${agentId}`;
}

function injectCompositeRuntimeState({ sessionStore, projectPath, taskId, researcherSessionId }) {
  sessionStore.startSession({
    taskId,
    sessionId: researcherSessionId,
    command: "opencode",
    cwd: projectPath,
    provider: "opencode",
    model,
  });
  const firstDispatch = sessionStore.recordDispatch({
    taskId,
    toSessionId: researcherSessionId,
    assignment: "Research the state flow and report a result.",
  });
  sessionStore.markDispatchDelivered({
    taskId,
    sessionId: researcherSessionId,
    dispatchId: firstDispatch.dispatchId,
  });
  const result = sessionStore.recordDispatchResult({
    taskId,
    sessionId: researcherSessionId,
    dispatchId: firstDispatch.dispatchId,
    reason: "provider-answer-available",
    answerText: "Result: state projection is available for Conductor consumption.",
  });
  const secondDispatch = sessionStore.recordDispatch({
    taskId,
    toSessionId: researcherSessionId,
    assignment: "Follow up after the first result.",
  });
  sessionStore.markDispatchFailed({
    taskId,
    sessionId: researcherSessionId,
    dispatchId: secondDispatch.dispatchId,
    reason: "target_session_delivery_timeout",
    message: "Target session did not confirm delivery.",
  });

  return { firstDispatch, result, secondDispatch };
}

function writeFakeOpencodeBinary(root) {
  const target = path.join(root, "fake-opencode.cjs");
  fs.writeFileSync(
    target,
    `#!/usr/bin/env node
process.stdout.write('Ask anything... "Fix a TODO in the codebase"\\n');
process.stdout.write('tab agents  ctrl+p commands\\n');
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  process.stdout.write('\\n[agent-workspace-fake-opencode-received]\\n');
  process.stdout.write(String(chunk).replace(/\\x1b\\[[0-9;]*[~A-Za-z]/g, ''));
  process.stdout.write('\\nAsk anything... "Fix a TODO in the codebase"\\n');
  process.stdout.write('tab agents  ctrl+p commands\\n');
});
const timer = setInterval(() => undefined, 1000);
process.on('SIGTERM', () => {
  clearInterval(timer);
  process.exit(0);
});
process.on('SIGINT', () => {
  clearInterval(timer);
  process.exit(0);
});
`,
  );
  fs.chmodSync(target, 0o755);
  return target;
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

async function createTask(window) {
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
        setValue('input[aria-label="任务标签"]', "state, e2e, signaling");

        const submit = document.querySelector("form.task-home-intake-form button[type=submit]");
        if (!submit) throw new Error("Missing task submit button");
        submit.click();
        return { ok: true };
      } catch (error) {
        return {
          ok: false,
          message: error instanceof Error ? error.message : String(error),
          bodyText: document.body.innerText.slice(0, 4000),
        };
      }
    })()
  `);
  if (!createResult?.ok) {
    throw new Error(`Task create script failed: ${createResult?.message}\n${createResult?.bodyText ?? ""}`);
  }
  await waitForRenderer(window, `document.body.innerText.includes(${JSON.stringify(taskTitle)})`, "created task visible");
}

main()
  .then(() => app.exit(0))
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });

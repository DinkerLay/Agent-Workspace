#!/usr/bin/env node

const assert = require("node:assert/strict");
const { app } = require("electron");
const {
  createElectronSimulationHarness,
  waitUntil,
} = require("../lib/electron-simulation-harness.cjs");

app.commandLine.appendSwitch("disable-gpu");

async function main() {
  const taskId = "task-session-dispatch-e2e";
  const workerSessionId = `opencode:project-runtime-current:${taskId}:${taskId}-researcher`;
  const assignmentToken = `E2E_ASSIGNMENT_${Date.now()}`;
  const assignment = [
    `Researcher worker assignment ${assignmentToken}.`,
    "Collect evidence and report a concise receipt.",
    `Return ${assignmentToken} when received.`,
  ].join("\n");

  const harness = await createElectronSimulationHarness();

  try {
    const window = await harness.createWindow();
    await window.webContents.executeJavaScript(`
      window.__e2ePtyEvents = [];
      window.__e2eUnsubscribe = window.agentWorkspace.native.onPtyEvent((event) => {
        window.__e2ePtyEvents.push(event);
      });
      true;
    `);

    const initialResult = await window.webContents.executeJavaScript(`
      window.agentWorkspace.native.callSession({
        taskId: ${JSON.stringify(taskId)},
        toSessionId: ${JSON.stringify(workerSessionId)},
        assignment: ${JSON.stringify(assignment)},
        expectedOutput: "receipt with assignment token",
        contextRefs: ["docs/research/source.md"],
        priority: "normal"
      });
    `);

    if (!initialResult.ok) {
      const failedView = await harness.conductorToolBridge.readSession({
        taskId,
        sessionId: workerSessionId,
        maxChars: 20_000,
      });
      const terminalLog = harness.sessionStore.readTerminalLog({ taskId, sessionId: workerSessionId, maxBytes: 20_000 });
      assert.fail(JSON.stringify({ initialResult, failedView, terminalLog }));
    }
    assert.equal(typeof initialResult.dispatchId, "string");
    assert.match(initialResult.dispatchId, /^[A-F0-9]{6}$/);
    assert.equal(initialResult.dispatchKey, undefined);
    assert.equal(initialResult.status, "accepted");
    assert.equal(initialResult.deliveryState, "input_accepted");
    assert.equal(initialResult.resultState, "pending");
    assert.equal(initialResult.turnPolicy, "conductor_decides_turn_boundary");
    assert.match(initialResult.message, /not Provider delivery yet/);

    let sessionView;
    try {
      sessionView = await waitUntil(
        async () => {
          const view = await harness.conductorToolBridge.readSession({
            taskId,
            sessionId: workerSessionId,
            maxChars: 20_000,
          });
          const dispatch = view.dispatches.find((item) => item.dispatchId === initialResult.dispatchId);
          return dispatch?.status === "delivered" ? view : false;
        },
        "worker session receives dispatched assignment through real opencode PTY",
        { timeoutMs: 12_000, intervalMs: 100 },
      );
    } catch (error) {
      const failedView = await harness.conductorToolBridge.readSession({ taskId, sessionId: workerSessionId, maxChars: 20_000 });
      const terminalLog = harness.sessionStore.readTerminalLog({ taskId, sessionId: workerSessionId, maxBytes: 40_000 });
      throw new Error(JSON.stringify({ reason: error.message, failedView, terminalLog, ptyWrites: harness.ptyWrites }));
    }

    const workerStarts = harness.ptyStarts.filter((item) => item.id === workerSessionId);
    assert.equal(workerStarts.length, 1, "worker session should be started exactly once");
    assert.equal(workerStarts[0].taskId, taskId);
    assert.equal(workerStarts[0].cwd, harness.projectPath);
    assert.equal(workerStarts[0].command, "opencode");
    assert.deepEqual(workerStarts[0].args.slice(0, 3), ["--model", "opencode-go/deepseek-v4-flash", "--prompt"]);
    assert.ok(workerStarts[0].args[3].includes(assignmentToken), "fresh worker launch prompt should contain the assignment token");
    assert.ok(workerStarts[0].args[3].includes(`[Agent Workspace] Dispatch ID ${initialResult.dispatchId}`));
    assert.ok(!workerStarts[0].args.includes("--agent"), "workspace role must not be passed as provider --agent");

    const workerWrites = harness.ptyWrites.filter((item) => item.id === workerSessionId);
    assert.equal(workerWrites.length, 0, "fresh workers submit the assignment once through OpenCode --prompt, not a second PTY write");

    const rendererEvents = await window.webContents.executeJavaScript(`
      window.__e2ePtyEvents.map((event) => ({
        type: event.type,
        id: event.id,
        chunk: event.chunk || ""
      }));
    `);
    assert.ok(
      rendererEvents.some((event) => event.id === workerSessionId && event.type === "data"),
      "renderer should receive real worker PTY output via preload IPC event",
    );

    const eventTypes = sessionView.events.map((event) => event.type);
    assert.ok(eventTypes.includes("dispatch.created"));
    assert.ok(eventTypes.includes("dispatch.input_accepted"));
    assert.ok(eventTypes.includes("dispatch.provider.received"));
    assert.ok(!eventTypes.includes("session.output"), "terminal chunks must not be stored as session events");

    console.log(
      JSON.stringify(
        {
          ok: true,
          scenario: "session-dispatch/call-session-to-worker",
          dispatchId: initialResult.dispatchId,
          workerSessionId,
          starts: workerStarts.length,
          writes: workerWrites.length,
          events: eventTypes,
        },
        null,
        2,
      ),
    );
  } finally {
    await harness.cleanup();
  }
}

main()
  .then(() => app.exit(0))
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });

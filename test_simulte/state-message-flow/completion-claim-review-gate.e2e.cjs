#!/usr/bin/env node

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createConductorToolBridge } = require("../../desktop/conductor-tool-bridge.cjs");
const { createAgentLoopV1Runtime } = require("../../desktop/runtime/agent-loop-v1-runtime.cjs");
const { createSessionStore } = require("../../desktop/session-store.cjs");

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-workspace-completion-claim-e2e-"));
  const sessionStore = createSessionStore({
    root: ({ cwd }) => path.join(cwd, ".agent-workspace", "runtime"),
  });
  const ptyManager = {
    read: () => undefined,
    get: () => undefined,
  };
  const runtime = createAgentLoopV1Runtime({
    opencodePath: "/usr/local/bin/opencode",
    databasePath: path.join(root, "agent-loop.sqlite"),
    getConductorBridgeConfig: async () => ({
      conductorToolBridgeUrl: "http://127.0.0.1:4567",
      conductorToolBridgeToken: "test-token",
      conductorMcpServerPath: "/workspace/desktop/conductor-mcp-server.cjs",
    }),
    sessionAuthority: {
      registerLaunchProfile() {},
      async activateSession({ workspaceSessionId }) {
        return { session: { id: workspaceSessionId, status: "running" } };
      },
    },
    ptyManager,
    sessionStore,
  });
  const bridge = createConductorToolBridge({
    sessionStore,
    ptyManager,
    onCompletionClaim: (input) => runtime.recordCompletionClaim(input),
  });

  try {
    const task = runtime.createTask({
      taskId: "completion-claim-e2e",
      projectId: "simulation",
      cwd: root,
      title: "Completion claim outbox",
      goal: "Record one Conductor delivery claim without creating a second state source.",
    });
    const started = await runtime.startRun({ taskId: task.taskId });
    const claimInput = {
      taskId: task.taskId,
      sessionId: started.run.conductorSessionId,
      message: "The current delivery is ready for user inspection.",
      summary: "Conductor submitted the current delivery for inspection.",
    };

    const first = await bridge.claimTaskCompletion(claimInput);
    const replay = await bridge.claimTaskCompletion(claimInput);
    const currentTask = runtime.readTask({ taskId: task.taskId });
    const currentRun = runtime.readRun({ runId: started.run.runId });
    const taskState = sessionStore.readTaskState({ taskId: task.taskId });
    const completionEvents = taskState.events.filter((event) => event.type === "task.completion_claim");
    const runClaims = currentRun.events.filter((event) => event.type === "conductor.delivery_claim");

    assert.equal(first.ok, true);
    assert.equal(first.status, "completion_claim_recorded");
    assert.equal(first.event?.type, "task.completion_claim");
    assert.equal(replay.ok, true);
    assert.equal(currentTask.status, "delivery_ready");
    assert.equal(currentRun.run.status, "running", "delivery claim must not stop the logical Run");
    assert.equal(completionEvents.length, 1, "Task/Run outbox must publish exactly one Timeline claim");
    assert.equal(runClaims.length, 1, "Task/Run command must record exactly one Run decision");
    assert.deepEqual(completionEvents[0].data, {
      message: claimInput.message,
      source: "conductor",
    });
    assert.ok(completionEvents[0].sourceEventId, "Timeline projection must retain its Task/Run outbox identity");

    console.log(JSON.stringify({
      ok: true,
      scenario: "state-message-flow/completion-claim-outbox",
      taskId: task.taskId,
      runId: started.run.runId,
      taskStatus: currentTask.status,
      runStatus: currentRun.run.status,
      completionClaims: completionEvents.length,
      sourceEventId: completionEvents[0].sourceEventId,
    }, null, 2));
  } finally {
    runtime.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

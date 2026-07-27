const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { ensureNodePtySpawnHelperExecutable } = require("./node-pty-runtime.cjs");
const { createConductorToolBridge } = require("./conductor-tool-bridge.cjs");
const { createAgentLoopV1Runtime } = require("./runtime/agent-loop-v1-runtime.cjs");
const { createSessionAuthority } = require("./runtime/session-authority.cjs");
const { createTerminalHost } = require("./runtime/terminal-host.cjs");
const { createSessionStore } = require("./session-store.cjs");
const { createSessionWakeupMonitor } = require("./session-wakeup-monitor.cjs");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-loop-control-plane-"));
const fakeOpenCode = path.join(root, "fake-opencode.sh");

fs.writeFileSync(
  fakeOpenCode,
  "#!/bin/sh\nprompt=''\nwhile [ \"$#\" -gt 0 ]; do\n  if [ \"$1\" = '--prompt' ]; then\n    shift\n    prompt=\"$1\"\n  fi\n  shift\ndone\nprintf 'OpenCode TUI ready\\n'\nif [ -n \"$prompt\" ]; then printf '%s\\n' \"$prompt\"; fi\nwhile IFS= read -r line; do printf '%s\\n' \"$line\"; done\n",
  { mode: 0o755 },
);

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, message, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(25);
  }
  throw new Error(`${message} timed out`);
}

async function snapshotText(host, sessionId) {
  return (await host.getSnapshot(sessionId))?.ansi ?? "";
}

async function main() {
  ensureNodePtySpawnHelperExecutable();
  const sessionStore = createSessionStore({ root });
  const terminalHost = createTerminalHost({ pty: require("node-pty"), spawn, sessionStore });
  const sessionAuthority = createSessionAuthority({ ptyManager: terminalHost, databasePath: path.join(root, "terminal.sqlite") });
  terminalHost.onEvent((event) => sessionAuthority.handlePtyEvent(event));

  const runtime = createAgentLoopV1Runtime({
    sessionAuthority,
    ptyManager: terminalHost,
    sessionStore,
    opencodePath: fakeOpenCode,
    databasePath: path.join(root, "agent-loop.sqlite"),
    enqueueConductorInput: ({ workspaceSessionId, expectedIncarnationId, source, payload, idempotencyKey }) =>
      sessionAuthority.enqueueInput({
        workspaceSessionId,
        expectedIncarnationId,
        source,
        payload,
        idempotencyKey,
      }),
    getConductorBridgeConfig: async () => ({
      conductorToolBridgeUrl: "http://127.0.0.1:1",
      conductorToolBridgeToken: "harness",
      conductorMcpServerPath: path.join(__dirname, "conductor-mcp-server.cjs"),
    }),
  });

  const bridge = createConductorToolBridge({
    sessionStore,
    ptyManager: terminalHost,
    activateWorkerSession: ({ sessionId, operationId }) =>
      sessionAuthority.activateSession({
        workspaceSessionId: sessionId,
        operationId,
        callerId: "control-plane-harness",
        reason: "conductor-dispatch",
      }),
    prepareWorkerSession: ({ taskId, agentId, sessionId, initialPrompt }) =>
      runtime.prepareWorkerInitialDispatch({ taskId, agentId, sessionId, initialPrompt }),
    enqueueWorkerInput: ({ sessionId, expectedIncarnationId, payload, idempotencyKey }) =>
      sessionAuthority.enqueueInput({
        workspaceSessionId: sessionId,
        expectedIncarnationId,
        source: "dispatch",
        payload,
        idempotencyKey,
      }),
    validateDispatch: (input) => runtime.validateDispatch(input),
    prepareDispatchContext: (input) => runtime.prepareDispatchContext(input),
    resumeTaskForDispatch: (input) => runtime.resumeTaskForDispatch(input),
    resolveAgentSession: (input) => runtime.resolveAgentSession(input),
    getTaskAgentMap: (input) => runtime.taskAgentMap(input),
    // This fixture models the Provider Adapter's structured marker proof. It
    // deliberately does not infer delivery from terminal text.
    confirmWorkerAssignmentDelivery: async () => ({ provider: "fixture", delivery: "provider-confirmed" }),
    onCompletionClaim: ({ taskId }) => runtime.recordCompletionClaim({ taskId }),
  });

  let resultRound = 0;
  const monitor = createSessionWakeupMonitor({
    ptyManager: terminalHost,
    sessionStore,
    resolveAgentId: ({ taskId, sessionId }) => runtime.taskAgentMap({ taskId })[sessionId],
    enqueueConductorInput: ({ sessionId, expectedIncarnationId, source, payload, idempotencyKey }) =>
      sessionAuthority.enqueueInput({
        workspaceSessionId: sessionId,
        expectedIncarnationId,
        source,
        payload,
        idempotencyKey,
      }),
    // The fixture mirrors the OpenCode Adapter's receipt observation. A
    // terminal input acceptance is not enough for a semantic result to wake
    // Conductor; the Provider must first confirm this exact dispatch marker.
    dispatchStateReader: ({ dispatch }) => ({
      state: "received",
      provider: "fixture",
      receipt: {
        providerSessionId: `fixture-${dispatch.agentId}`,
        providerMessageId: `receipt-${dispatch.dispatchId}`,
        dispatchMessageCreatedAt: 1_000 + resultRound,
      },
    }),
    dispatchResultReader: ({ dispatch }) => ({
      provider: "fixture",
      providerSessionId: `fixture-${dispatch.agentId}`,
      messageId: `message-${dispatch.dispatchId}`,
      stepFinishId: `finish-${dispatch.dispatchId}`,
      stepFinishReason: "stop",
      completedAt: 1_000 + resultRound,
      answerText: `Result ${resultRound + 1} for ${dispatch.agentId}.`,
      source: "fixture-provider-adapter",
    }),
  });

  try {
    const template = runtime.saveTemplate({
      id: "control-plane-loop",
      name: "Control plane harness",
      description: "Native capability cards controlled by one Conductor decision-maker.",
      source: "manual",
      conductor: {
        role: "Conductor",
        model: "opencode-go/deepseek-v4-flash",
        charter: "Use worker returns and user follow-ups to decide each next bounded dispatch. Do not assume a fixed route.",
      },
      agents: [
        {
          id: "researcher",
          name: "Researcher",
          kind: "researcher",
          role: "Return bounded Markdown evidence.",
          model: "opencode-go/deepseek-v4-flash",
          mcp: [],
          skills: [],
          instructions: "Work only on the contract delivered by Conductor.",
          expectedOutput: "evidence.md",
        },
        {
          id: "writer",
          name: "Writer",
          kind: "general",
          role: "Create a requested Markdown deliverable when the Conductor decides it is useful.",
          model: "opencode-go/deepseek-v4-flash",
          mcp: [],
          skills: [],
          instructions: "Write only the bounded artifact named in the Conductor contract.",
          expectedOutput: "deliverable.md",
        },
      ],
      limits: { maxConcurrentSessions: 1, maxDispatchesPerDecision: 1 },
      delivery: { artifactPath: "deliverable.md", ownerAgentId: "" },
    });
    const task = runtime.createTask({
      projectId: "harness",
      cwd: root,
      title: "Control plane proof",
      goal: "Verify stable agentId dispatch, semantic wakeup, user follow-up, and achieved.",
      templateId: template.id,
      templateVersion: template.version,
    });
    const run = await runtime.startRun({ taskId: task.taskId });
    const conductorSessionId = run.run.conductorSessionId;
    await waitFor(() => terminalHost.get(conductorSessionId)?.status === "running", "Conductor launch");

    const first = await bridge.callSession({
      taskId: task.taskId,
      agentId: "researcher",
      assignment: "Collect one primary source and return Markdown evidence.",
      expectedOutput: "evidence.md",
    });
    assert.equal(first.ok, true);
    assert.equal(first.agentId, "researcher");
    assert.equal("toSessionId" in first, false, "Conductor-facing dispatch response must hide physical Session IDs.");

    const workerSessionId = runtime.resolveAgentSession({ taskId: task.taskId, agentId: "researcher" }).sessionId;
    await waitFor(async () => (await snapshotText(terminalHost, workerSessionId)).includes("Dispatch ID"), "first native assignment");
    sessionStore.recordState({ taskId: task.taskId, sessionId: conductorSessionId }, "ready", "Provider adapter confirmed Conductor is awaiting a decision.");
    await monitor.tick();
    await waitFor(async () => (await snapshotText(terminalHost, conductorSessionId)).includes("Agent card: researcher"), "semantic result wakeup");
    const firstWakeup = await snapshotText(terminalHost, conductorSessionId);
    assert.equal(firstWakeup.includes(workerSessionId), false, "Conductor wakeup must not leak a physical Session ID.");
    const firstResult = sessionStore.readTaskState({ taskId: task.taskId }).results.find((result) => result.sessionId === workerSessionId);
    assert.ok(firstResult?.resultId, "Provider semantic result must receive a durable resultId before it can be forwarded.");

    // Provider semantics, not PTY silence, establish that the Conductor is
    // ready to receive the user's next durable Task message.
    sessionStore.recordState({ taskId: task.taskId, sessionId: conductorSessionId }, "waiting_conductor", "Fixture Provider completed the Conductor decision.");
    const followUp = await runtime.recordUserMessage({
      taskId: task.taskId,
      message: "不要停在已有证据上；请由 Conductor 自己决定是否继续核实。",
    });
    assert.equal(followUp.wakeup.delivered, 1);
    await waitFor(async () => (await snapshotText(terminalHost, conductorSessionId)).includes("不要停在已有证据上"), "user follow-up delivered to same Conductor terminal");

    resultRound = 1;
    const secondDispatch = await bridge.callSession({
      taskId: task.taskId,
      agentId: "writer",
      assignment: "Create deliverable.md from the collected evidence, including the source URL.",
      expectedOutput: "deliverable.md",
      contextRefs: [`result:${firstResult.resultId}`],
    });
    assert.equal(secondDispatch.ok, true);
    const writerSessionId = runtime.resolveAgentSession({ taskId: task.taskId, agentId: "writer" }).sessionId;
    await waitFor(async () => (await snapshotText(terminalHost, writerSessionId)).includes(secondDispatch.dispatchId), "second native assignment");
    const writerPrompt = await snapshotText(terminalHost, writerSessionId);
    assert.match(writerPrompt, /Forwarded semantic result from researcher/);
    assert.match(writerPrompt, /Result 1 for researcher\./);
    const writerDispatch = sessionStore.readTaskState({ taskId: task.taskId }).dispatches.find((dispatch) => dispatch.dispatchId === secondDispatch.dispatchId);
    assert.deepEqual(writerDispatch?.contextPackets?.map((packet) => packet.resultId), [firstResult.resultId]);
    sessionStore.recordState({ taskId: task.taskId, sessionId: conductorSessionId }, "ready", "Provider adapter confirmed Conductor is awaiting another result.");
    await monitor.tick();

    fs.writeFileSync(path.join(root, "deliverable.md"), "# Deliverable\n\nVerified evidence.\n", "utf8");
    const completion = await bridge.claimTaskCompletion({ taskId: task.taskId, message: "deliverable.md is ready for user inspection." });
    assert.equal(completion.ok, true);
    assert.equal(runtime.readTask({ taskId: task.taskId }).status, "delivery_ready");
    // This reproduces the reported failure boundary: a Conductor may notice a
    // need after making a delivery claim. The same explicit bridge dispatch
    // must continue the existing Task instead of reporting that the loop is
    // no longer running.
    const postClaimDispatch = await bridge.callSession({
      taskId: task.taskId,
      agentId: "researcher",
      assignment: "Re-check the cited source for one remaining ambiguity.",
      contextRefs: [`result:${firstResult.resultId}`],
    });
    assert.equal(postClaimDispatch.ok, true);
    assert.equal(runtime.readTask({ taskId: task.taskId }).status, "running");
    await waitFor(async () => (await snapshotText(terminalHost, workerSessionId)).includes("Re-check the cited source"), "post-claim continuation assignment");
    const secondCompletion = await bridge.claimTaskCompletion({ taskId: task.taskId, message: "The continuation was considered and the delivery is ready again." });
    assert.equal(secondCompletion.ok, true);
    assert.equal(runtime.markTaskAchieved({ taskId: task.taskId }).status, "achieved");

    process.stdout.write("Agent Loop control-plane harness passed\n");
  } finally {
    runtime.close();
    sessionAuthority.close();
    terminalHost.close();
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});

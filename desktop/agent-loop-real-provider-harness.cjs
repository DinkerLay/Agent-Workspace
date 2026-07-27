const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ensureNodePtySpawnHelperExecutable } = require("./node-pty-runtime.cjs");
const { formatInteractivePtyInput, formatWorkerAssignment } = require("./conductor-tool-bridge.cjs");
const { findProviderSessionForDispatch, getDispatchAssistantAnswer, getLastEffectiveAssistantAnswer } = require("./opencode/session-adapter.cjs");
const { resolveOpencodePath } = require("./opencode-runner.cjs");
const { createSessionAuthority } = require("./runtime/session-authority.cjs");
const { createOrcaTerminalDaemonManager } = require("./runtime/orca-terminal-daemon-manager.cjs");
const { createOrcaTerminalDaemonSupervisor } = require("./runtime/orca-terminal-daemon-supervisor.cjs");
const { createSessionStore } = require("./session-store.cjs");

const MODEL = "opencode-go/deepseek-v4-flash";
const HARNESS_LIMIT_MS = 90_000;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(reader, description) {
  const deadline = Date.now() + HARNESS_LIMIT_MS;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await reader();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(250);
  }
  throw new Error(`${description} was not observed within the real-provider harness limit.${lastError ? ` Last error: ${lastError.message}` : ""}`);
}

async function main() {
  const opencodePath = resolveOpencodePath();
  if (!opencodePath) throw new Error("OpenCode is required for the real-provider harness.");

  ensureNodePtySpawnHelperExecutable();
  // Use the canonical macOS temp path consistently with OpenCode's process
  // cwd; /var and /private/var name the same directory but differ as strings.
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agent-loop-real-provider-")));
  const taskId = `provider-e2e-${Date.now()}`;
  const sessionId = `opencode:provider-e2e:${taskId}:researcher`;
  const sessionStore = createSessionStore({ root });
  const terminalDaemonSupervisor = createOrcaTerminalDaemonSupervisor();
  const terminalRuntime = createOrcaTerminalDaemonManager({
    endpointProvider: () => terminalDaemonSupervisor.start(),
    sessionStore,
  });
  const sessionAuthority = createSessionAuthority({ ptyManager: terminalRuntime, databasePath: path.join(root, "terminal.sqlite") });
  terminalRuntime.onEvent((event) => sessionAuthority.handlePtyEvent(event));

  try {
    const dispatch = sessionStore.recordDispatch({
      taskId,
      toSessionId: sessionId,
      agentId: "researcher",
      assignment: "Reply exactly: REAL_TUI_PROVIDER_DISPATCH_OK",
      expectedOutput: "one exact line",
    });
    sessionAuthority.registerLaunchProfile({
      workspaceSessionId: sessionId,
      taskId,
      command: opencodePath,
      // First work for a blank normal TUI is supplied through OpenCode's own
      // native launch argument, not an early terminal paste that a newly
      // booting TUI may drop. The second turn below still verifies Host PTY
      // input against the same live native Session.
      args: ["--model", MODEL, "--prompt", formatWorkerAssignment(dispatch)],
      cwd: root,
      model: MODEL,
      provider: "opencode",
      cols: 100,
      rows: 30,
      stdin: "pipe",
      requirePty: true,
    });
    const activation = await sessionAuthority.activateSession({
      workspaceSessionId: sessionId,
      operationId: `real-provider:${taskId}`,
      callerId: "agent-loop-real-provider-harness",
      reason: "real-provider-worker-probe",
    });
    assert.equal(activation.session?.backend, "pty");
    assert.deepEqual(activation.session?.args, ["--model", MODEL, "--prompt", formatWorkerAssignment(dispatch)]);

    const providerSession = await waitFor(
      () =>
        findProviderSessionForDispatch({
          dispatchId: dispatch.dispatchId,
          cwd: root,
          dispatchCreatedAt: dispatch.createdAt,
        }),
      "Provider dispatch marker",
    );
    const answer = await waitFor(
      () =>
        getDispatchAssistantAnswer({
          dispatchId: dispatch.dispatchId,
          cwd: root,
          dispatchCreatedAt: dispatch.createdAt,
        }),
      "Provider completed result",
    );
    const snapshot = await terminalRuntime.getSnapshot(sessionId);

    assert.ok(providerSession.providerSessionId);
    assert.equal(answer.stepFinishReason, "stop");
    assert.match(answer.answerText, /REAL_TUI_PROVIDER_DISPATCH_OK/);
    assert.match(snapshot.ansi, /REAL_TUI_PROVIDER_DISPATCH_OK/);

    const secondWrite = await sessionAuthority.enqueueInput({
      workspaceSessionId: sessionId,
      expectedIncarnationId: activation.session.incarnationId,
      source: "dispatch",
      idempotencyKey: `followup:${dispatch.dispatchId}`,
      payload: formatInteractivePtyInput("Reply exactly: REAL_TUI_SECOND_TURN_OK"),
    });
    assert.equal(secondWrite.disposition, "written");
    const secondAnswer = await waitFor(
      async () => {
        const result = await getLastEffectiveAssistantAnswer({
          providerSessionId: providerSession.providerSessionId,
          afterMessageCreatedAt: answer.messageCreatedAt,
        });
        return result?.answerText.includes("REAL_TUI_SECOND_TURN_OK") ? result : undefined;
      },
      "second native OpenCode TUI result",
    );
    assert.equal(secondAnswer.stepFinishReason, "stop");
    const secondSnapshot = await terminalRuntime.getSnapshot(sessionId);
    assert.match(secondSnapshot.ansi, /REAL_TUI_SECOND_TURN_OK/);
    process.stdout.write(
      `${JSON.stringify({
        ok: true,
        model: MODEL,
        backend: activation.session.backend,
        providerSessionId: providerSession.providerSessionId,
        providerMessageId: answer.messageId,
        secondProviderMessageId: secondAnswer.messageId,
        stepFinishReason: answer.stepFinishReason,
      })}\n`,
    );
  } finally {
    sessionAuthority.close();
    await terminalRuntime.close();
    await terminalDaemonSupervisor.stop();
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});

#!/usr/bin/env node

/*
 * Fault-injection E2E for the terminal-incarnation race reported from the
 * Task page:
 *
 *   old Publisher dispatch accepted by PTY A
 *   -> Electron exits
 *   -> the saved permission response restores the same Publisher as PTY B
 *   -> a stale cancellation for the old dispatch arrives
 *
 * The cancellation must settle against the durable fact for PTY A. It must
 * never write Ctrl-C to PTY B, and the Session remains occupied by the
 * permission decision until OpenCode confirms it.
 */

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createConductorToolBridge } = require("./conductor-tool-bridge.cjs");
const { createAgentLoopV1Runtime } = require("./runtime/agent-loop-v1-runtime.cjs");
const { createSessionAuthority } = require("./runtime/session-authority.cjs");
const { createSessionStore } = require("./session-store.cjs");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-workspace-permission-recovery-race-"));

void run()
  .then(() => process.stdout.write("permission recovery race e2e passed (before and after recovery cancellation)\n"))
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(() => fs.rmSync(root, { recursive: true, force: true }));

async function run() {
  await runRaceCase({ cancellationTiming: "before_recovery" });
  await runRaceCase({ cancellationTiming: "after_recovery" });
}

async function runRaceCase({ cancellationTiming }) {
  const caseRoot = path.join(root, cancellationTiming);
  const caseProjectRoot = path.join(caseRoot, "project");
  fs.mkdirSync(caseProjectRoot, { recursive: true });
  const sessionStore = createSessionStore({ root: ({ cwd }) => path.join(cwd, ".agent-workspace", "runtime") });
  const runtimeDatabasePath = path.join(caseRoot, "agent-loop.sqlite");
  const terminalDatabasePath = path.join(caseRoot, "terminal-runtime.sqlite");

  // Main process A: the Publisher dispatch reached the original terminal.
  const firstPtyManager = createMemoryPtyManager();
  const firstAuthority = createSessionAuthority({
    ptyManager: firstPtyManager,
    databasePath: terminalDatabasePath,
    interactiveTuiStabilizeMs: 1,
  });
  const firstRuntime = createRuntime({
    sessionAuthority: firstAuthority,
    ptyManager: firstPtyManager,
    sessionStore,
    databasePath: runtimeDatabasePath,
  });
  const task = firstRuntime.createTask({
    cwd: caseProjectRoot,
    projectId: "permission-race",
    taskId: "permission-race-task",
    title: "Permission recovery race",
    goal: "Preserve a recovered Publisher terminal from an older dispatch cancellation.",
  });
  await firstRuntime.startRun({ taskId: task.taskId });
  const publisher = firstRuntime.resolveAgentSession({ taskId: task.taskId, agentId: "publisher" });
  assert.ok(publisher, "the template must provide a Publisher Session");
  const originalProfile = await firstRuntime.prepareWorkerInitialDispatch({
    taskId: task.taskId,
    agentId: "publisher",
    sessionId: publisher.sessionId,
    initialPrompt: "Create the approved deliverable.",
  });
  const originalActivation = await firstAuthority.activateSession({
    workspaceSessionId: originalProfile.sessionId,
    callerId: "permission-race-e2e",
    operationId: "publisher-dispatch-before-restart",
    reason: "initial-dispatch",
  });
  const dispatch = sessionStore.recordDispatch({
    taskId: task.taskId,
    toSessionId: publisher.sessionId,
    agentId: "publisher",
    assignment: "Create the approved deliverable.",
  });
  sessionStore.markDispatchInputAccepted({
    taskId: task.taskId,
    sessionId: publisher.sessionId,
    dispatchId: dispatch.dispatchId,
    transport: "terminal_runtime",
    incarnationId: originalActivation.session.incarnationId,
    generation: originalActivation.session.generation,
  });
  sessionStore.startSession({ taskId: task.taskId, sessionId: publisher.sessionId, command: "opencode", cwd: caseProjectRoot });
  sessionStore.recordState(
    { taskId: task.taskId, sessionId: publisher.sessionId, cwd: caseProjectRoot },
    "permission_required",
    "OpenCode is waiting for the user's saved response.",
    { provider: "opencode", providerSessionId: "ses-publisher-original" },
  );
  sessionStore.recordPermissionRequested({
    taskId: task.taskId,
    sessionId: publisher.sessionId,
    cwd: caseProjectRoot,
    permissionId: "opencode:publisher-copy",
    requestId: "publisher-copy",
    provider: "opencode",
    permission: "external_directory",
    patterns: ["/tmp/approved-output"],
    summary: "OpenCode requests access to write the approved output.",
  });
  sessionStore.recordPermissionRecoveryPending({
    taskId: task.taskId,
    sessionId: publisher.sessionId,
    cwd: caseProjectRoot,
    permissionId: "opencode:publisher-copy",
    response: "once",
  });

  // The process dies without a PTY exit event. Its durable terminal owner is
  // still active until the new Session Authority proves that the local PTY is
  // gone and records incarnation A as stopped.
  firstPtyManager.drop(publisher.sessionId);
  if (cancellationTiming === "before_recovery") {
    const cancellation = await createBridge({
      sessionStore,
      ptyManager: firstPtyManager,
      sessionAuthority: firstAuthority,
      runtime: firstRuntime,
    }).cancelDispatch({
      taskId: task.taskId,
      dispatchId: dispatch.dispatchId,
      reason: "old cancellation arrives before permission recovery",
    });
    assert.equal(cancellation.status, "cancellation_requested", "an absent in-memory PTY is not proof that the old dispatch finished");
    assert.equal(cancellation.terminalStatus, "not_live", "the old cancellation remains durable until its exact terminal exit is proven");
  }
  firstAuthority.close();
  firstRuntime.close();

  // Main process B: startup recovery must resume the *same Provider Session*
  // as a new terminal incarnation, not create a new Task Run.
  const restartedPtyManager = createMemoryPtyManager();
  const restartedAuthority = createSessionAuthority({
    ptyManager: restartedPtyManager,
    databasePath: terminalDatabasePath,
    interactiveTuiStabilizeMs: 1,
  });
  let bridge;
  const restartedRuntime = createRuntime({
    sessionAuthority: restartedAuthority,
    ptyManager: restartedPtyManager,
    sessionStore,
    databasePath: runtimeDatabasePath,
    reconcileTaskCancellations: (input) => bridge?.reconcileTaskCancellations(input) ?? [],
  });
  bridge = createBridge({
    sessionStore,
    ptyManager: restartedPtyManager,
    sessionAuthority: restartedAuthority,
    runtime: restartedRuntime,
  });
  const recovery = await restartedRuntime.resumePendingPermissionRecoveries();
  assert.equal(recovery.attempted, 1, "the saved Task-page response is recovered once");
  assert.equal(recovery.failed.length, 0, "the original Publisher Provider session is recoverable");
  const recoveredPublisher = restartedPtyManager.get(publisher.sessionId);
  assert.ok(recoveredPublisher, "recovery starts the Publisher TUI");
  assert.equal(recoveredPublisher.status, "running");
  assert.notEqual(recoveredPublisher.incarnationId, originalActivation.session.incarnationId, "recovery owns a new terminal incarnation");
  assert.equal(
    recoveredPublisher.args[recoveredPublisher.args.indexOf("--session") + 1],
    "ses-publisher-original",
    "recovery continues the exact existing OpenCode Session",
  );
  const oldOwner = restartedAuthority.readSessionOwner({
    workspaceSessionId: publisher.sessionId,
    incarnationId: originalActivation.session.incarnationId,
    generation: originalActivation.session.generation,
  });
  assert.equal(oldOwner?.state, "stopped", "the old terminal exit fact survives replacement");

  // Fault injection covers both real orders: the cancellation can be already
  // durable when B starts, or arrive after B has become live. In either order
  // it settles only from A's historical terminal fact.
  let cancellation;
  if (cancellationTiming === "after_recovery") {
    cancellation = await bridge.cancelDispatch({
      taskId: task.taskId,
      dispatchId: dispatch.dispatchId,
      reason: "stale cancellation arrives after permission recovery",
    });
    assert.equal(cancellation.terminalStatus, "different_incarnation_live", "the recovered Publisher terminal is explicitly not interrupted");
  } else {
    cancellation = sessionStore.readTaskState({ taskId: task.taskId, sinceCursor: 0 }).dispatches
      .find((item) => item.dispatchId === dispatch.dispatchId);
  }
  assert.equal(cancellation.status, "cancelled", "the old dispatch settles from the old persisted terminal fact");
  assert.equal(
    recoveredPublisher.writes.includes("\u0003"),
    false,
    "a stale dispatch cancellation must never send Ctrl-C to the recovered Publisher terminal",
  );
  assert.equal(restartedPtyManager.get(publisher.sessionId)?.status, "running", "the recovered Publisher terminal remains live");

  // The card has already been consumed into recovery_pending. Until OpenCode
  // confirms/rejects the reply, Conductor cannot install a replacement
  // assignment into this recovered TUI.
  const stateDuringRecovery = sessionStore.readTaskState({ taskId: task.taskId, sinceCursor: 0 });
  assert.deepEqual(
    stateDuringRecovery.permissions.filter((permission) => ["requested", "reply_failed"].includes(String(permission.status))).map((permission) => permission.permissionId),
    [],
    "a selected permission card is consumed immediately rather than remaining actionable",
  );
  assert.deepEqual(
    restartedRuntime.validateDispatch({ taskId: task.taskId, agentId: "publisher", toSessionId: publisher.sessionId }),
    { ok: false, reason: "loop_session_permission_decision_pending", permissionId: "opencode:publisher-copy" },
    "the recovered permission TUI owns its logical Session until Provider confirmation",
  );

  sessionStore.recordPermissionResolved({
    taskId: task.taskId,
    sessionId: publisher.sessionId,
    cwd: caseProjectRoot,
    permissionId: "opencode:publisher-copy",
    response: "once",
  });
  assert.deepEqual(
    restartedRuntime.validateDispatch({ taskId: task.taskId, agentId: "publisher", toSessionId: publisher.sessionId }),
    { ok: true },
    "only the Provider receipt releases the recovered Publisher Session for a new dispatch",
  );

  restartedAuthority.close();
  restartedRuntime.close();
}

function createBridge({ sessionStore, ptyManager, sessionAuthority, runtime }) {
  return createConductorToolBridge({
    sessionStore,
    ptyManager,
    enqueueWorkerInput: ({ sessionId, expectedIncarnationId, source, payload, idempotencyKey }) =>
      sessionAuthority.enqueueInput({
        workspaceSessionId: sessionId,
        expectedIncarnationId,
        source,
        payload,
        idempotencyKey,
      }),
    readTerminalSessionFact: ({ workspaceSessionId, incarnationId, generation }) =>
      sessionAuthority.readSessionOwner({ workspaceSessionId, incarnationId, generation }),
    resolveAgentSession: ({ taskId, agentId }) => runtime.resolveAgentSession({ taskId, agentId }),
    validateDispatch: (input) => runtime.validateDispatch(input),
  });
}

function createRuntime({ sessionAuthority, ptyManager, sessionStore, databasePath, reconcileTaskCancellations }) {
  return createAgentLoopV1Runtime({
    sessionAuthority,
    ptyManager,
    sessionStore,
    databasePath,
    opencodePath: "/usr/local/bin/opencode",
    getConductorBridgeConfig: async () => ({
      conductorToolBridgeUrl: "http://127.0.0.1:4567",
      conductorToolBridgeToken: "permission-race-e2e",
      conductorMcpServerPath: "/workspace/desktop/conductor-mcp-server.cjs",
    }),
    reconcileTaskCancellations,
  });
}

function createMemoryPtyManager() {
  const sessions = new Map();
  return {
    async start(input) {
      const session = {
        id: input.id,
        taskId: input.taskId,
        status: "running",
        incarnationId: input.incarnationId,
        generation: input.generation,
        args: [...input.args],
        bufferMode: "alternate",
        writes: [],
      };
      sessions.set(session.id, session);
      return session;
    },
    get(id) { return sessions.get(String(id)); },
    list() { return [...sessions.values()]; },
    read(id) { return sessions.get(String(id)); },
    write(id, payload, { expectedIncarnationId } = {}) {
      const session = sessions.get(String(id));
      if (!session || session.status !== "running" || session.incarnationId !== expectedIncarnationId) return undefined;
      session.writes.push(String(payload));
      return session;
    },
    stop(id) {
      const session = sessions.get(String(id));
      if (session) session.status = "stopping";
      return session;
    },
    resize(id) { return sessions.get(String(id)); },
    drop(id) { sessions.delete(String(id)); },
  };
}

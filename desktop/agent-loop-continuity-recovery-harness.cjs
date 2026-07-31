#!/usr/bin/env node

/*
 * Persistent continuation harness.
 *
 * This is deliberately not a renderer or mock-Provider smoke. It exercises
 * the durable Session Store and Session Authority databases across a simulated
 * Electron Main-process restart:
 *
 * accepted Publisher dispatch -> Conductor cancellation -> matching PTY exit
 * -> new Main process -> one Task Send -> cancellation settled -> replacement
 * Publisher profile continues the exact original OpenCode session. It also
 * proves that a saved Provider permission answer resumes the same Publisher
 * Session when the application closes again before OpenCode reissues it.
 */

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createConductorToolBridge } = require("./conductor-tool-bridge.cjs");
const { createAgentLoopV1Runtime } = require("./runtime/agent-loop-v1-runtime.cjs");
const { createSessionAuthority } = require("./runtime/session-authority.cjs");
const { createSessionStore } = require("./session-store.cjs");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-workspace-continuity-"));
const projectRoot = path.join(root, "project");
fs.mkdirSync(projectRoot, { recursive: true });

void run()
  .then(() => {
    process.stdout.write("persistent continuation harness passed\n");
  })
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

async function run() {
  const runtimeRoot = ({ cwd }) => path.join(cwd, ".agent-workspace", "runtime");
  const sessionStore = createSessionStore({ root: runtimeRoot });
  const runtimeDatabasePath = path.join(root, "agent-loop.sqlite");
  const terminalDatabasePath = path.join(root, "terminal-runtime.sqlite");
  const firstPtyManager = createMemoryPtyManager();
  const firstAuthority = createSessionAuthority({
    ptyManager: firstPtyManager,
    databasePath: terminalDatabasePath,
  });
  const firstRuntime = createRuntime({
    sessionAuthority: firstAuthority,
    ptyManager: firstPtyManager,
    sessionStore,
    databasePath: runtimeDatabasePath,
  });

  const task = firstRuntime.createTask({
    cwd: projectRoot,
    projectId: "continuity",
    taskId: "continuity-task",
    title: "Persistent cancellation continuation",
    goal: "Continue the same Publisher conversation after an interrupted dispatch.",
  });
  await firstRuntime.startRun({ taskId: task.taskId });
  const publisher = firstRuntime.resolveAgentSession({ taskId: task.taskId, agentId: "publisher" });
  const prepared = await firstRuntime.prepareWorkerInitialDispatch({
    taskId: task.taskId,
    agentId: "publisher",
    sessionId: publisher.sessionId,
    initialPrompt: "Create the first bounded artifact.",
  });
  const activatedPublisher = await firstAuthority.activateSession({
    workspaceSessionId: prepared.sessionId,
    callerId: "persistent-continuity-harness",
    operationId: "publisher-first-incarnation",
    reason: "initial-worker-dispatch",
  });
  const dispatch = sessionStore.recordDispatch({
    taskId: task.taskId,
    toSessionId: publisher.sessionId,
    agentId: "publisher",
    assignment: "Create the first bounded artifact.",
  });
  sessionStore.markDispatchInputAccepted({
    taskId: task.taskId,
    sessionId: publisher.sessionId,
    dispatchId: dispatch.dispatchId,
    incarnationId: activatedPublisher.session.incarnationId,
    generation: activatedPublisher.session.generation,
    transport: "terminal_runtime",
  });
  sessionStore.markDispatchProviderReceived({
    taskId: task.taskId,
    sessionId: publisher.sessionId,
    dispatchId: dispatch.dispatchId,
    provider: "opencode",
    providerSessionId: "ses-publisher-original",
    providerMessageId: "msg-publisher-first",
  });

  // A user may have selected an authorization answer immediately before the
  // application closes again. Persist the answer without any in-memory reply
  // endpoint so the next Main-process instance must perform startup recovery.
  const permissionTask = firstRuntime.createTask({
    cwd: projectRoot,
    projectId: "continuity",
    taskId: "permission-continuity-task",
    title: "Persistent permission continuation",
    goal: "Resume the same Publisher authorization after Electron restarts.",
  });
  await firstRuntime.startRun({ taskId: permissionTask.taskId });
  const permissionPublisher = firstRuntime.resolveAgentSession({ taskId: permissionTask.taskId, agentId: "publisher" });
  assert.ok(permissionPublisher, "permission continuation needs a Publisher Session");
  sessionStore.startSession({ taskId: permissionTask.taskId, sessionId: permissionPublisher.sessionId, command: "opencode", cwd: projectRoot });
  sessionStore.recordState({
    taskId: permissionTask.taskId,
    sessionId: permissionPublisher.sessionId,
    cwd: projectRoot,
  }, "permission_required", "已保留授权答复；等待下一次应用启动恢复原生 Session。", {
    provider: "opencode",
    providerSessionId: "ses-permission-publisher-original",
  });
  sessionStore.recordPermissionRequested({
    taskId: permissionTask.taskId,
    sessionId: permissionPublisher.sessionId,
    cwd: projectRoot,
    permissionId: "opencode:permission-before-restart",
    requestId: "permission-before-restart",
    provider: "opencode",
    permission: "external_directory",
    patterns: ["/tmp/approved-output"],
    summary: "OpenCode 请求将已审核内容写入项目目录。",
  });
  sessionStore.recordPermissionRecoveryPending({
    taskId: permissionTask.taskId,
    sessionId: permissionPublisher.sessionId,
    cwd: projectRoot,
    permissionId: "opencode:permission-before-restart",
    response: "once",
  });

  const firstBridge = createConductorToolBridge({
    sessionStore,
    ptyManager: firstPtyManager,
    enqueueWorkerInput: ({ sessionId, expectedIncarnationId, source, payload, idempotencyKey }) =>
      firstAuthority.enqueueInput({
        workspaceSessionId: sessionId,
        expectedIncarnationId,
        source,
        payload,
        idempotencyKey,
      }),
    readTerminalSessionFact: ({ workspaceSessionId }) => firstAuthority.readSessionOwner({ workspaceSessionId }),
  });
  const cancellation = await firstBridge.cancelDispatch({
    taskId: task.taskId,
    dispatchId: dispatch.dispatchId,
    reason: "review evidence must be checked first",
  });
  assert.equal(cancellation.status, "cancellation_requested");

  // This is the only terminal-exit proof used by the next process. The
  // in-memory terminal is then discarded to model an Electron restart.
  firstAuthority.handlePtyEvent({
    type: "exit",
    id: publisher.sessionId,
    incarnationId: activatedPublisher.session.incarnationId,
    generation: activatedPublisher.session.generation,
    exitCode: 130,
    signal: "SIGINT",
  });
  firstPtyManager.drop(publisher.sessionId);
  firstAuthority.close();
  firstRuntime.close();

  const restartedPtyManager = createMemoryPtyManager();
  const restartedAuthority = createSessionAuthority({
    ptyManager: restartedPtyManager,
    databasePath: terminalDatabasePath,
  });
  const restartedBridge = createConductorToolBridge({
    sessionStore,
    ptyManager: restartedPtyManager,
    readTerminalSessionFact: ({ workspaceSessionId }) => restartedAuthority.readSessionOwner({ workspaceSessionId }),
  });
  const restartedRuntime = createRuntime({
    sessionAuthority: restartedAuthority,
    ptyManager: restartedPtyManager,
    sessionStore,
    databasePath: runtimeDatabasePath,
    reconcileTaskCancellations: ({ taskId }) => restartedBridge.reconcileTaskCancellations({ taskId }),
  });

  const permissionRecovery = await restartedRuntime.resumePendingPermissionRecoveries();
  assert.equal(permissionRecovery.attempted, 1);
  assert.equal(permissionRecovery.failed.length, 0);
  const recoveredPermissionPublisher = restartedPtyManager.get(permissionPublisher.sessionId);
  assert.ok(recoveredPermissionPublisher, "startup must restore the pending permission Session");
  assert.ok(recoveredPermissionPublisher.args.includes("--session"));
  assert.equal(
    recoveredPermissionPublisher.args[recoveredPermissionPublisher.args.indexOf("--session") + 1],
    "ses-permission-publisher-original",
    "permission recovery must continue the exact Provider conversation",
  );

  const continued = await restartedRuntime.recordUserMessage({
    taskId: task.taskId,
    message: "继续当前任务，沿用已有审计与 Publisher 会话。",
  });
  assert.equal(continued.wakeup.delivery, "conductor_recovery_awaiting_provider_receipt");
  assert.equal(continued.wakeup.delivered, 0);
  assert.equal(continued.wakeup.queued, 1);
  const stateAfterSend = sessionStore.readTaskState({ taskId: task.taskId, sinceCursor: 0 });
  assert.equal(stateAfterSend.dispatches.find((item) => item.dispatchId === dispatch.dispatchId)?.status, "cancelled");
  const persistedOwner = restartedAuthority.readSessionOwner({ workspaceSessionId: publisher.sessionId });
  assert.equal(persistedOwner.state, "stopped");
  assert.equal(persistedOwner.incarnationId, activatedPublisher.session.incarnationId);
  assert.equal(persistedOwner.generation, activatedPublisher.session.generation);

  const replacement = await restartedRuntime.prepareWorkerInitialDispatch({
    taskId: task.taskId,
    agentId: "publisher",
    sessionId: publisher.sessionId,
    initialPrompt: "Revise the deliverable using the preserved review context.",
  });
  // The public authority intentionally does not expose profiles. Inspect the
  // durable launch side effect instead.
  const replacementOwner = await restartedAuthority.activateSession({
    workspaceSessionId: replacement.sessionId,
    callerId: "persistent-continuity-harness",
    operationId: "publisher-replacement-incarnation",
    reason: "later-conductor-dispatch",
  });
  const launched = restartedPtyManager.get(replacementOwner.session.id);
  assert.ok(launched.args.includes("--session"));
  assert.equal(launched.args[launched.args.indexOf("--session") + 1], "ses-publisher-original");
  assert.ok(launched.args.includes("Revise the deliverable using the preserved review context."));

  restartedAuthority.close();
  restartedRuntime.close();
}

function createRuntime({ sessionAuthority, ptyManager, sessionStore, databasePath, reconcileTaskCancellations } = {}) {
  return createAgentLoopV1Runtime({
    sessionAuthority,
    ptyManager,
    sessionStore,
    databasePath,
    opencodePath: "/usr/local/bin/opencode",
    reconcileTaskCancellations,
    getConductorBridgeConfig: async () => ({
      conductorToolBridgeUrl: "http://127.0.0.1:4567",
      conductorToolBridgeToken: "continuity-harness-token",
      conductorMcpServerPath: "/workspace/desktop/conductor-mcp-server.cjs",
    }),
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
        writes: [],
      };
      sessions.set(session.id, session);
      return session;
    },
    get(id) {
      return sessions.get(String(id));
    },
    read(id) {
      return sessions.get(String(id));
    },
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
    resize(id) {
      return sessions.get(String(id));
    },
    drop(id) {
      sessions.delete(String(id));
    },
  };
}

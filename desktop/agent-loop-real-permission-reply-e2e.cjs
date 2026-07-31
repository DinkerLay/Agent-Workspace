const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ensureNodePtySpawnHelperExecutable } = require("./node-pty-runtime.cjs");
const { resolveOpencodePath } = require("./opencode-runner.cjs");
const { createSessionAuthority } = require("./runtime/session-authority.cjs");
const { createOrcaTerminalDaemonManager } = require("./runtime/orca-terminal-daemon-manager.cjs");
const { createOrcaTerminalDaemonSupervisor } = require("./runtime/orca-terminal-daemon-supervisor.cjs");
const { createOpenCodeHookService } = require("./runtime/opencode-hook-service.cjs");
const { createSessionStore } = require("./session-store.cjs");
const { createSessionWakeupMonitor } = require("./session-wakeup-monitor.cjs");

const MODEL = "opencode-go/deepseek-v4-flash";
const LIMIT_MS = 120_000;

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function waitFor(read, description) {
  const deadline = Date.now() + LIMIT_MS;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await delay(250);
  }
  throw new Error(`${description} was not observed within the real permission E2E limit.`);
}

async function main() {
  const opencodePath = resolveOpencodePath();
  if (!opencodePath) throw new Error("OpenCode is required for the real permission reply E2E.");

  ensureNodePtySpawnHelperExecutable();
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agent-loop-real-permission-")));
  const taskDirectory = path.join(root, "task");
  const externalDirectory = path.join(root, "external-output");
  fs.mkdirSync(taskDirectory);
  fs.mkdirSync(externalDirectory);
  const source = path.join(taskDirectory, "source.txt");
  const destination = path.join(externalDirectory, "permission-reply.txt");
  fs.writeFileSync(source, "REAL_PERMISSION_REPLY_OK\n", "utf8");

  const taskId = `permission-e2e-${Date.now()}`;
  const sessionId = `opencode:permission-e2e:${taskId}:publisher`;
  const sessionStore = createSessionStore({ root });
  const daemonSupervisor = createOrcaTerminalDaemonSupervisor();
  const ptyManager = createOrcaTerminalDaemonManager({ endpointProvider: () => daemonSupervisor.start(), sessionStore });
  const authority = createSessionAuthority({ ptyManager, databasePath: path.join(root, "terminal.sqlite") });
  const hookService = createOpenCodeHookService();
  let monitor;

  ptyManager.onEvent((event) => authority.handlePtyEvent(event));
  monitor = createSessionWakeupMonitor({ ptyManager, sessionStore });

  try {
    const hook = await hookService.registerSession({
      sessionId,
      cwd: taskDirectory,
      onEvent: (event) => monitor.handleProviderHookEvent(event),
    });
    authority.registerLaunchProfile({
      workspaceSessionId: sessionId,
      taskId,
      command: opencodePath,
      args: [
        "--model", MODEL,
        "--prompt",
        `Use the shell to copy the exact file ${source} to ${destination}. The destination is outside this task directory, so wait for any requested permission. After the copy succeeds, reply exactly REAL_PERMISSION_REPLY_OK.`,
      ],
      cwd: taskDirectory,
      provider: "opencode",
      model: MODEL,
      cols: 100,
      rows: 30,
      stdin: "pipe",
      requirePty: true,
      env: hook.env,
    });
    const activation = await authority.activateSession({
      workspaceSessionId: sessionId,
      operationId: `real-permission:${taskId}`,
      callerId: "agent-loop-real-permission-reply-e2e",
      reason: "verify-task-page-permission-reply-transport",
      interactiveTui: true,
    });
    assert.equal(activation.session?.status, "running");

    const request = await waitFor(() => sessionStore.readSession({ taskId, sessionId }).permissions.find((item) => item.status === "requested"), "OpenCode external-directory permission request");
    const reply = await monitor.respondPermission({ taskId, sessionId, permissionId: request.permissionId, response: "once" });
    // The hook may emit `permission.replied` before the HTTP 202 reaches the
    // monitor. Both `submitted` and the already-confirmed `approved` are
    // successful Task-page replies; the durable receipt below remains the
    // actual end-to-end assertion.
    if (!["submitted", "approved"].includes(reply.status)) {
      throw new Error(`OpenCode did not accept the permission reply: ${reply.errorCode ?? "permission_reply_failed"}`);
    }
    await waitFor(() => sessionStore.readSession({ taskId, sessionId }).permissions.find((item) => item.permissionId === request.permissionId && item.status === "approved"), "OpenCode permission.replied receipt");
    await waitFor(() => fs.existsSync(destination), "copy into temporary external directory");
    assert.equal(fs.readFileSync(destination, "utf8"), "REAL_PERMISSION_REPLY_OK\n");
    process.stdout.write("REAL PERMISSION E2E PASS: OpenCode requested external_directory; the Task Runtime replied once; OpenCode confirmed and the temporary output was created.\n");
  } finally {
    authority.close();
    await ptyManager.close();
    await daemonSupervisor.stop();
    await hookService.close();
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});

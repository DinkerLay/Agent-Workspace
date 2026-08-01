import assert from "node:assert/strict";
import { createRequire } from "node:module";

const isVitest = process.env.VITEST === "true" || process.env.VITEST_WORKER_ID !== undefined;
const test = isVitest ? (await import("vitest")).test : (await import("node:test")).default;

const require = createRequire(import.meta.url);
const { createBrowserRuntimeBridge } = require("./browser-runtime-bridge.cjs");

test("browser Runtime bridge grants a manually validated root only to the requesting browser client", async (t) => {
  const attachments = new Map();
  const calls = [];
  const bridge = createBrowserRuntimeBridge({
    token: "test-token",
    port: 0,
    projectRoot: () => "/workspace/project",
    validateAgentLoopProjectDirectory: async ({ path }) => {
      assert.equal(path, "/workspace/typed-project");
      return { path: "/workspace/selected", name: "selected" };
    },
    suggestAgentLoopProjectDirectories: async ({ prefix }) => {
      assert.equal(prefix, "/workspace/typed");
      return ["/workspace/typed-project/"];
    },
    readRuntimeStatus: async () => ({
      available: true,
      mode: "desktop",
      message: "ready",
      conductorToolBridgeUrl: "http://127.0.0.1:4567",
      conductorToolBridgeToken: "private-token",
      conductorMcpServerPath: "/workspace/conductor-mcp-server.cjs",
    }),
    runOpencode: async () => ({ ok: true }),
    sessionAuthority: {
      enqueueInput: async () => undefined,
      resizeSession: async () => undefined,
      stopSession: async () => undefined,
    },
    ptyManager: {
      attachClient: async (input) => {
        calls.push({ type: "attach", ...input });
        return { snapshot: { ansi: "", cursor: 0 }, attachment: {}, session: { id: input.id } };
      },
      acknowledgeOutput: async (input) => ({ accepted: true, cursor: input.cursor }),
      detachClient: async (input) => {
        calls.push({ type: "detach", ...input });
        return true;
      },
    },
    getAgentLoopRuntime: () => ({
      createTask: async (input) => ({ taskId: "task-1", cwd: input.cwd }),
      listTasks: async () => [],
    }),
    readWorkspaceTerminalLog: async () => undefined,
    appendTaskEvent: async () => ({ ok: true }),
    terminalClientAttachments: attachments,
    terminalHostClientId: (ownerId, clientId) => `${ownerId}:${clientId}`,
  });
  const address = await bridge.start();
  afterTest(t, () => bridge.close());

  const status = await fetch(`${address.url}/v1/status`, { headers: { authorization: "Bearer test-token" } });
  assert.deepEqual(await status.json(), { result: { available: true, mode: "desktop", message: "ready" } });

  const suggestions = await call(address.url, { method: "suggestAgentLoopProjectDirectories", input: { prefix: "/workspace/typed" } });
  assert.deepEqual(suggestions.body.result, ["/workspace/typed-project/"]);

  const denied = await call(address.url, { method: "createAgentLoopTask", input: { cwd: "/workspace/other", title: "Denied", goal: "Denied" } });
  assert.equal(denied.status, 500);
  assert.equal(denied.body.error, "browser_project_root_not_authorized");

  const created = await call(address.url, { method: "createAgentLoopTask", input: { cwd: "/workspace/project", title: "Allowed", goal: "Allowed" } });
  assert.deepEqual(created.body.result, { taskId: "task-1", cwd: "/workspace/project" });

  const selected = await call(address.url, { method: "validateAgentLoopProjectDirectory", input: { path: "/workspace/typed-project" } });
  assert.deepEqual(selected.body.result, { path: "/workspace/selected", name: "selected" });

  const createdInSelectedRoot = await call(address.url, { method: "createAgentLoopTask", input: { cwd: "/workspace/selected", title: "Selected", goal: "Selected" } });
  assert.deepEqual(createdInSelectedRoot.body.result, { taskId: "task-1", cwd: "/workspace/selected" });

  const selectedRootDeniedForOtherClient = await call(
    address.url,
    { method: "createAgentLoopTask", input: { cwd: "/workspace/selected", title: "Other client", goal: "Other client" } },
    "browser-client-5678",
  );
  assert.equal(selectedRootDeniedForOtherClient.status, 500);
  assert.equal(selectedRootDeniedForOtherClient.body.error, "browser_project_root_not_authorized");

  const oldRootDeniedAfterSelection = await call(address.url, { method: "createAgentLoopTask", input: { cwd: "/workspace/project", title: "Old root", goal: "Old root" } });
  assert.equal(oldRootDeniedAfterSelection.status, 500);
  assert.equal(oldRootDeniedAfterSelection.body.error, "browser_project_root_not_authorized");

  const attached = await call(address.url, { method: "attachTerminalClient", input: { sessionId: "session-1", clientId: "terminal-1", generation: "generation-1" } });
  assert.equal(attached.status, 200);
  assert.deepEqual(calls[0], { type: "attach", id: "session-1", clientId: "browser-browser-client-1234:terminal-1", generation: "generation-1" });
  assert.equal(
    bridge.handleTerminalClientEvent({ type: "data" }, { clientId: "browser-browser-client-1234:terminal-1", sessionId: "session-1", clientGeneration: "generation-1" }),
    true,
  );
  assert.equal(
    bridge.handleTerminalClientEvent({ type: "data" }, { clientId: "browser-browser-client-1234:terminal-1", sessionId: "other-session", clientGeneration: "generation-1" }),
    false,
  );
});

function afterTest(context, callback) {
  if (typeof context.onTestFinished === "function") context.onTestFinished(callback);
  else context.after(callback);
}

async function call(url, request, clientId = "browser-client-1234") {
  const response = await fetch(`${url}/v1/call`, {
    method: "POST",
    headers: {
      authorization: "Bearer test-token",
      "content-type": "application/json",
      "x-agent-workspace-client": clientId,
    },
    body: JSON.stringify(request),
  });
  return { status: response.status, body: await response.json() };
}

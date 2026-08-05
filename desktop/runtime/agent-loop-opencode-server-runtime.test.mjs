import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createAgentLoopV1Runtime } = require("./agent-loop-v1-runtime.cjs");
const { createSessionStore } = require("../session-store.cjs");
const { createSessionStoreCapabilities } = require("./session-store-capabilities.cjs");
const { test } = await import("node:test");

test("starts a Task Run through OpenCode Server without Session Authority or PTY", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-workspace-server-runtime-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const calls = { ensure: [], create: [], prompt: [], message: [], permission: [], subscriptions: [] };
  let workerMessageReads = 0;
  let releaseWorkerMessages;
  let markRepeatedWorkerRead;
  const repeatedWorkerRead = new Promise((resolve) => { markRepeatedWorkerRead = resolve; });
  const workerMessages = new Promise((resolve) => { releaseWorkerMessages = resolve; });
  let createdCount = 0;
  let server;
  const manager = {
    async ensureRun(input) { calls.ensure.push(input); return (server ??= { taskId: input.taskId, runId: input.runId, origin: "http://127.0.0.1:43111" }); },
    getRun() { return server; },
    subscribeRun(input) { calls.subscriptions.push(input); return () => undefined; },
    clientForRun() {
      return {
        async createSession(input) {
          calls.create.push(input);
          createdCount += 1;
          return { id: ["ses_conductor1", "ses_worker1", "ses_reviewer1", "ses_publisher1"][createdCount - 1] };
        },
        async promptAsync(input) { calls.prompt.push(input); return { accepted: true }; },
        async sendMessage(input) { calls.message.push(input); return { accepted: true, providerMessageId: "msg_conductor_turn1" }; },
        async replyPermission(input) { calls.permission.push(input); return true; },
        async messages({ providerSessionId }) {
          if (providerSessionId !== "ses_worker1") return [];
          workerMessageReads += 1;
          if (workerMessageReads === 2) markRepeatedWorkerRead();
          return workerMessages;
        },
      };
    },
  };
  const sessionStore = createSessionStore({ root: ({ cwd }) => path.join(cwd, ".agent-workspace", "runtime") });
  const capabilities = createSessionStoreCapabilities(sessionStore);
  const runtime = createAgentLoopV1Runtime({
    openCodeServerManager: manager,
    sessionStoreCapabilities: capabilities,
    opencodePath: "/mock/opencode",
    databasePath: path.join(root, "agent-loop.sqlite"),
    getConductorBridgeConfig: async () => ({
      conductorToolBridgeUrl: "http://127.0.0.1:5288",
      conductorToolBridgeToken: "test-token",
      conductorMcpServerPath: "/mock/conductor-mcp.cjs",
    }),
  });

  const template = runtime.saveTemplate({
    id: "server-build-template",
    name: "Server build template",
    source: "manual",
    conductor: { role: "Conductor", model: "opencode-go/deepseek-v4-flash", charter: "Dispatch bounded evidence work and make the next decision from durable results." },
    agents: [
      {
        id: "researcher",
        name: "Researcher",
        kind: "researcher",
        mcp: ["websearch"],
        skills: ["research"],
        dispatchProfile: {
          title: "Primary evidence research",
          description: "Dispatch when source-backed facts, dates, and uncertainty need independent verification.",
        },
        workerSystemPrompt: "Cite primary sources, dates, and uncertainty in every finding.",
      },
      {
        id: "reviewer",
        name: "Reviewer",
        kind: "reviewer",
        dispatchProfile: {
          title: "Evidence review",
          description: "Dispatch when returned evidence needs coverage and quality review.",
        },
        workerSystemPrompt: "Identify material evidence gaps without inventing new facts.",
      },
      {
        id: "publisher",
        name: "Publisher",
        kind: "publisher",
        dispatchProfile: {
          title: "Evidence-backed delivery",
          description: "Dispatch when selected evidence is ready to become the requested deliverable.",
        },
        workerSystemPrompt: "Write only from the supplied verified evidence and state unresolved limits.",
      },
    ],
    limits: { maxConcurrentSessions: 3, maxDispatchesPerDecision: 3 },
    delivery: { artifactPath: "" },
  });
  const task = runtime.createTask({
    taskId: "task-server-only",
    cwd: root,
    title: "Server-only Task",
    goal: "Use OpenCode Server.",
    templateId: template.id,
  });
  const started = await runtime.startRun({ taskId: task.taskId, commandId: "command-server-only" });

  assert.equal(started.run.status, "running");
  assert.equal(calls.ensure.length, 1);
  const serverConfig = calls.ensure[0].config.content;
  assert.equal(serverConfig.default_agent, "build");
  assert.deepEqual(Object.keys(serverConfig.agent), ["agent_workspace_conductor"], "only the stable Conductor capability boundary is a named OpenCode Agent; Cards remain dynamic Session configuration");
  assert.equal(serverConfig.agent.agent_workspace_conductor.mode, "primary");
  assert.deepEqual(serverConfig.tools, { "agent_workspace_conductor_*": false });
  assert.equal(serverConfig.mcp.agent_workspace_conductor.type, "local");
  assert.equal(calls.create.length, 1);
  assert.equal(calls.prompt.length, 1);
  assert.equal(calls.create[0].agent, "agent_workspace_conductor");
  assert.equal(calls.create[0].model, undefined, "creating a provider Session must not resolve a model");
  assert.deepEqual(calls.create[0].permission, [
    { permission: "*", pattern: "*", action: "deny" },
    { permission: "agent_workspace_conductor_*", pattern: "*", action: "allow" },
    { permission: "question", pattern: "*", action: "allow" },
  ]);
  assert.equal(calls.prompt[0].agent, "agent_workspace_conductor");
  assert.deepEqual(calls.prompt[0].tools, { "agent_workspace_conductor_*": true });
  assert.match(calls.prompt[0].system, /only Workspace Session that has Agent Workspace MCP tools/);
  assert.match(calls.prompt[0].system, /Primary evidence research/);
  assert.match(calls.prompt[0].system, /source-backed facts, dates, and uncertainty need independent verification/);
  assert.doesNotMatch(calls.prompt[0].system, /Cite primary sources, dates, and uncertainty/);
  assert.equal(calls.prompt[0].providerSessionId, "ses_conductor1");
  assert.equal(calls.subscriptions.length, 1);
  const conductor = sessionStore.readSession({ taskId: task.taskId, sessionId: started.run.conductorSessionId, cwd: root, maxChars: 0 });
  assert.equal(conductor.providerBinding.providerSessionId, "ses_conductor1");

  const workerSessionId = runtime.resolveAgentSession({ taskId: task.taskId, agentId: "researcher" }).sessionId;
  const dispatch = capabilities.coordinator.recordDispatch({
    taskId: task.taskId,
    conductorSessionId: started.run.conductorSessionId,
    toSessionId: workerSessionId,
    agentId: "researcher",
    assignment: "Find primary sources.",
  });
  const workerDelivery = await runtime.deliverOpenCodeWorkerAssignment({ dispatch, text: "Find primary sources." });
  assert.equal(calls.create[1].model, undefined, "a worker selects its model when its prompt is submitted");
  assert.equal(calls.create[1].agent, "build");
  assert.deepEqual(calls.create[1].permission, [{ permission: "agent_workspace_conductor_*", pattern: "*", action: "deny" }]);
  assert.equal(calls.prompt[1].agent, "build");
  assert.deepEqual(calls.prompt[1].tools, { "agent_workspace_conductor_*": false });
  assert.match(calls.prompt[1].system, /Worker system prompt: Cite primary sources, dates, and uncertainty in every finding\./);
  assert.doesNotMatch(calls.prompt[1].system, /Primary evidence research/);
  assert.doesNotMatch(calls.prompt[1].system, /Default expected output/);
  assert.match(calls.prompt[1].system, /Declared native MCP scope: websearch/);
  assert.match(calls.prompt[1].system, /Declared native Skills scope: research/);
  assert.doesNotMatch(calls.prompt[1].system, /Task goal: Use OpenCode Server\./);
  assert.doesNotMatch(calls.prompt[1].system, /Task project root:/);
  assert.match(calls.prompt[1].text, /\[Agent Workspace\] Task invocation/);
  assert.match(calls.prompt[1].text, /Task: Server-only Task/);
  assert.match(calls.prompt[1].text, /Task goal: Use OpenCode Server\./);
  assert.match(calls.prompt[1].text, /Task project root:/);
  assert.match(calls.prompt[1].text, /Find primary sources\./);
  const reviewerSessionId = runtime.resolveAgentSession({ taskId: task.taskId, agentId: "reviewer" }).sessionId;
  const reviewerDispatch = capabilities.coordinator.recordDispatch({
    taskId: task.taskId,
    conductorSessionId: started.run.conductorSessionId,
    toSessionId: reviewerSessionId,
    agentId: "reviewer",
    assignment: "Review the evidence.",
  });
  await runtime.deliverOpenCodeWorkerAssignment({ dispatch: reviewerDispatch, text: "Review the evidence." });
  assert.equal(calls.create[2].agent, "build");
  assert.equal(calls.prompt[2].agent, "build");
  const publisherSessionId = runtime.resolveAgentSession({ taskId: task.taskId, agentId: "publisher" }).sessionId;
  const publisherDispatch = capabilities.coordinator.recordDispatch({
    taskId: task.taskId,
    conductorSessionId: started.run.conductorSessionId,
    toSessionId: publisherSessionId,
    agentId: "publisher",
    assignment: "Publish the deliverable.",
  });
  await runtime.deliverOpenCodeWorkerAssignment({ dispatch: publisherDispatch, text: "Publish the deliverable." });
  assert.equal(calls.create[3].agent, "build");
  assert.equal(calls.prompt[3].agent, "build");
  capabilities.coordinator.markDispatchInputAccepted({ taskId: task.taskId, sessionId: workerSessionId, dispatchId: dispatch.dispatchId, transport: "opencode_server", provider: "opencode", providerSessionId: workerDelivery.providerSessionId });
  calls.subscriptions[0].onEvent({
    type: "permission.asked",
    properties: { sessionID: "ses_worker1", id: "per_webui_once", action: "external_directory", resources: [path.join(root, "artifacts", "report.md")] },
  });
  let state = capabilities.readModel.readTaskState({ taskId: task.taskId, sinceCursor: 0 });
  const pendingPermission = state.permissions.find((permission) => permission.permissionId === "opencode:per_webui_once");
  assert.equal(pendingPermission?.status, "requested");
  assert.equal(pendingPermission?.dispatchId, dispatch.dispatchId);
  assert.deepEqual(
    runtime.validateDispatch({ taskId: task.taskId, agentId: "researcher", toSessionId: workerSessionId }),
    { ok: false, reason: "loop_session_permission_decision_pending", permissionId: "opencode:per_webui_once" },
  );

  // Two identical idle SSE events can race after the official WebUI allows a
  // one-shot permission. Hold both result reads, then release them together;
  // only the first Provider completion may write a result, close the linked
  // permission, and wake the Conductor.
  calls.subscriptions[0].onEvent({ type: "session.idle", properties: { sessionID: "ses_worker1" } });
  calls.subscriptions[0].onEvent({ type: "session.idle", properties: { sessionID: "ses_worker1" } });
  await repeatedWorkerRead;
  const resultAvailable = new Promise((resolve) => {
    const unsubscribe = sessionStore.onTaskChange((change) => {
      if (change.taskId === task.taskId && change.type === "dispatch.result_available") {
        unsubscribe();
        resolve();
      }
    });
  });
  releaseWorkerMessages([{ info: { id: "msg_worker1", role: "assistant", time: { completed: 42 } }, parts: [{ type: "text", text: "Worker result" }] }]);
  await resultAvailable;
  await new Promise((resolve) => setImmediate(resolve));
  state = capabilities.readModel.readTaskState({ taskId: task.taskId, sinceCursor: 0 });
  assert.equal(state.results.length, 1);
  assert.equal(state.results[0].answerText, "Worker result");
  assert.equal(state.permissions.find((permission) => permission.permissionId === "opencode:per_webui_once")?.status, "provider_turn_completed");
  assert.equal(state.pendingDecisions.some((decision) => decision.permissionId === "opencode:per_webui_once"), false);
  assert.deepEqual(runtime.validateDispatch({ taskId: task.taskId, agentId: "researcher", toSessionId: workerSessionId }), { ok: true });
  const workerEvents = sessionStore.readSession({ taskId: task.taskId, sessionId: workerSessionId, cwd: root }).events;
  assert.equal(workerEvents.filter((event) => event.type === "permission.provider_turn_completed").length, 1);
  assert.equal(workerEvents.filter((event) => event.type === "dispatch.result_available").length, 1);
  assert.equal(calls.message.length, 1);
  assert.equal(calls.message.at(-1).providerSessionId, "ses_conductor1");
  assert.equal(calls.message.at(-1).messageId, undefined);
  assert.equal(calls.message.at(-1).agent, "agent_workspace_conductor");
  assert.deepEqual(calls.message.at(-1).tools, { "agent_workspace_conductor_*": true });
  assert.match(calls.message.at(-1).system, /only Workspace Session that has Agent Workspace MCP tools/);

  capabilities.provider.recordPermissionRequested({
    taskId: task.taskId,
    sessionId: workerSessionId,
    cwd: root,
    permissionId: "opencode:per_abc123",
    requestId: "per_abc123",
    provider: "opencode",
    permission: "edit",
    summary: "Approve the edit?",
  });
  const permissionReply = await runtime.respondPermission({
    taskId: task.taskId,
    sessionId: workerSessionId,
    permissionId: "opencode:per_abc123",
    response: "once",
  });
  assert.equal(permissionReply.ok, true);
  assert.deepEqual(calls.permission, [{ cwd: root, requestId: "per_abc123", response: "once" }]);
  runtime.close();
});

test("binds explicitly selected provider variants at Session creation and preserves them on every later turn", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-workspace-server-model-variant-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const calls = { create: [], prompt: [], message: [] };
  let created = 0;
  const manager = {
    async ensureRun(input) {
      return { taskId: input.taskId, runId: input.runId, cwd: root, origin: "http://127.0.0.1:43112", providerVersion: "1.18.13" };
    },
    subscribeRun() { return () => undefined; },
    clientForRun() {
      return {
        async createSession(input) {
          calls.create.push(input);
          created += 1;
          return { id: created === 1 ? "ses_variant_conductor" : "ses_variant_worker" };
        },
        async promptAsync(input) { calls.prompt.push(input); return { accepted: true }; },
        async sendMessage(input) {
          calls.message.push(input);
          return { accepted: true, providerMessageId: "msg_variant_conductor" };
        },
        async getSession({ providerSessionId }) { return { id: providerSessionId }; },
        async messages() { return []; },
      };
    },
  };
  const sessionStore = createSessionStore({ root: ({ cwd }) => path.join(cwd, ".agent-workspace", "runtime") });
  const capabilities = createSessionStoreCapabilities(sessionStore);
  const runtime = createServerRuntime({
    databasePath: path.join(root, "agent-loop.sqlite"),
    manager,
    capabilities,
  });
  const template = runtime.saveTemplate({
    id: "server-variant-template",
    name: "Server variant template",
    source: "manual",
    conductor: {
      role: "Conductor",
      model: "opencode-go/gpt-5.6-luna",
      modelVariant: "max",
      charter: "Choose the next bounded evidence action from durable state.",
    },
    agents: [{
      id: "researcher",
      name: "Researcher",
      kind: "researcher",
      model: "opencode-go/gpt-5.6-luna",
      modelVariant: "high",
      dispatchProfile: {
        title: "Evidence research",
        description: "Find source-backed evidence for the current question.",
      },
      workerSystemPrompt: "Cite the source and uncertainty for every finding.",
    }],
    limits: { maxConcurrentSessions: 1, maxDispatchesPerDecision: 1 },
    delivery: { artifactPath: "" },
  });
  const task = runtime.createTask({
    taskId: "task-server-model-variant",
    cwd: root,
    title: "Model variant transport",
    goal: "Use the configured provider model variants without overwriting them on later turns.",
    templateId: template.id,
  });
  assert.equal(task.architecture.defaultModelVariant, "max");

  const started = await runtime.startRun({
    taskId: task.taskId,
    commandId: "command-start-server-model-variant",
    expectedRevision: task.revision,
  });
  assert.deepEqual(calls.create[0].model, {
    providerID: "opencode-go",
    modelID: "gpt-5.6-luna",
    variant: "max",
  });
  assert.equal(calls.prompt[0].model, undefined, "a variant belongs to Session creation, not a prompt payload");

  const workerSessionId = runtime.resolveAgentSession({ taskId: task.taskId, agentId: "researcher" }).sessionId;
  const dispatch = capabilities.coordinator.recordDispatch({
    taskId: task.taskId,
    conductorSessionId: started.run.conductorSessionId,
    toSessionId: workerSessionId,
    agentId: "researcher",
    assignment: "Find one primary source for the question.",
  });
  await runtime.deliverOpenCodeWorkerAssignment({ dispatch, text: "Find one primary source for the question." });
  assert.deepEqual(calls.create[1].model, {
    providerID: "opencode-go",
    modelID: "gpt-5.6-luna",
    variant: "high",
  });
  assert.equal(calls.prompt[1].model, undefined);

  await runtime.recordUserMessage({
    taskId: task.taskId,
    message: "Please add the valuation assumptions before final delivery.",
    commandId: "command-server-model-variant-followup",
    expectedRevision: runtime.readTask({ taskId: task.taskId }).revision,
  });
  assert.equal(calls.message.length, 1);
  assert.equal(calls.message[0].model, undefined, "a Conductor continuation must retain the Session variant");
  runtime.close();
});

test("stops every bound OpenCode Provider Session before releasing its Run Host", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-workspace-server-stop-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const calls = { ensure: [], create: [], prompt: [], abort: [], stop: [], unsubscribe: 0 };
  const order = [];
  let created = 0;
  const manager = {
    async ensureRun(input) {
      calls.ensure.push(input);
      return { taskId: input.taskId, runId: input.runId, cwd: root, origin: "http://127.0.0.1:43120", providerVersion: "1.18.11" };
    },
    subscribeRun() {
      return () => { calls.unsubscribe += 1; };
    },
    clientForRun() {
      return {
        async createSession(input) {
          calls.create.push(input);
          created += 1;
          return { id: created === 1 ? "ses_stop_conductor" : "ses_stop_researcher" };
        },
        async promptAsync(input) { calls.prompt.push(input); return { accepted: true }; },
        async abort(input) {
          calls.abort.push(input);
          order.push(`abort:${input.providerSessionId}`);
          return undefined;
        },
      };
    },
    async stopRun(input) {
      calls.stop.push(input);
      order.push(`release:${input.runId}`);
      return true;
    },
  };
  const sessionStore = createSessionStore({ root: ({ cwd }) => path.join(cwd, ".agent-workspace", "runtime") });
  const capabilities = createSessionStoreCapabilities(sessionStore);
  const runtime = createServerRuntime({
    databasePath: path.join(root, "agent-loop.sqlite"),
    manager,
    capabilities,
  });
  const template = runtime.saveTemplate(reconnectTemplate());
  const task = runtime.createTask({
    taskId: "task-server-stop",
    cwd: root,
    title: "Stop bound Provider Sessions",
    goal: "Stopping must interrupt every active Provider Session before the Run Host is released.",
    templateId: template.id,
  });
  const started = await runtime.startRun({
    taskId: task.taskId,
    commandId: "command-start-server-stop",
    expectedRevision: task.revision,
  });
  const workerSessionId = runtime.resolveAgentSession({ taskId: task.taskId, agentId: "researcher" }).sessionId;
  const dispatch = capabilities.coordinator.recordDispatch({
    taskId: task.taskId,
    conductorSessionId: started.run.conductorSessionId,
    toSessionId: workerSessionId,
    agentId: "researcher",
    assignment: "Review the local release evidence.",
  });
  await runtime.deliverOpenCodeWorkerAssignment({ dispatch, text: "Review the local release evidence." });
  const ensureCallsBeforeStop = calls.ensure.length;

  const stopped = await runtime.stopTask({
    taskId: task.taskId,
    commandId: "command-stop-server-stop",
    expectedRevision: runtime.readTask({ taskId: task.taskId }).revision,
  });

  assert.equal(stopped.status, "stopped");
  assert.equal(runtime.readRun({ runId: started.run.runId }).run.status, "stopped");
  assert.deepEqual(calls.abort, [
    { cwd: root, providerSessionId: "ses_stop_conductor" },
    { cwd: root, providerSessionId: "ses_stop_researcher" },
  ]);
  assert.deepEqual(order, [
    "abort:ses_stop_conductor",
    "abort:ses_stop_researcher",
    `release:${started.run.runId}`,
  ]);
  assert.equal(calls.ensure.length, ensureCallsBeforeStop, "Stop must use the existing Run Host instead of attaching a replacement");
  assert.equal(calls.unsubscribe, 1, "the Provider event observer is detached only after abort succeeds");
  assert.equal(
    sessionStore.readSession({ taskId: task.taskId, sessionId: started.run.conductorSessionId, cwd: root, maxChars: 0 }).providerBinding.providerSessionId,
    "ses_stop_conductor",
    "Stop retains the historical Provider binding for audit without leaving its turn active",
  );
  runtime.close();
});

test("keeps a Task stopping when an OpenCode Provider abort cannot be confirmed", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-workspace-server-stop-failure-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const calls = { stop: [], abort: [] };
  const manager = {
    async ensureRun(input) {
      return { taskId: input.taskId, runId: input.runId, cwd: root, origin: "http://127.0.0.1:43121", providerVersion: "1.18.11" };
    },
    subscribeRun() { return () => undefined; },
    clientForRun() {
      return {
        async createSession() { return { id: "ses_stop_failure_conductor" }; },
        async promptAsync() { return { accepted: true }; },
        async abort(input) {
          calls.abort.push(input);
          throw new Error("opencode_server_abort_unconfirmed");
        },
      };
    },
    async stopRun(input) { calls.stop.push(input); return true; },
  };
  const sessionStore = createSessionStore({ root: ({ cwd }) => path.join(cwd, ".agent-workspace", "runtime") });
  const runtime = createServerRuntime({
    databasePath: path.join(root, "agent-loop.sqlite"),
    manager,
    capabilities: createSessionStoreCapabilities(sessionStore),
  });
  const template = runtime.saveTemplate(reconnectTemplate());
  const task = runtime.createTask({
    taskId: "task-server-stop-failure",
    cwd: root,
    title: "Do not fake a stopped Provider turn",
    goal: "A failed Provider abort remains a recoverable stopping command.",
    templateId: template.id,
  });
  const started = await runtime.startRun({
    taskId: task.taskId,
    commandId: "command-start-server-stop-failure",
    expectedRevision: task.revision,
  });

  await assert.rejects(
    () => runtime.stopTask({
      taskId: task.taskId,
      commandId: "command-stop-server-stop-failure",
      expectedRevision: runtime.readTask({ taskId: task.taskId }).revision,
    }),
    /opencode_server_abort_unconfirmed/,
  );
  assert.deepEqual(calls.abort, [{ cwd: root, providerSessionId: "ses_stop_failure_conductor" }]);
  assert.deepEqual(calls.stop, [], "the Run Host remains owned until cancellation is confirmed");
  assert.equal(runtime.readTask({ taskId: task.taskId }).status, "stopping");
  assert.equal(runtime.readRun({ runId: started.run.runId }).run.status, "running");
  runtime.close();
});

test("drops an in-flight Worker idle result after the Task is recycled", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-workspace-server-idle-recycle-race-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const calls = { create: [], prompt: [], message: [], releases: [], subscriptions: [] };
  let createdCount = 0;
  let server;
  let releaseWorkerMessages;
  let markWorkerMessagesStarted;
  const workerMessagesStarted = new Promise((resolve) => { markWorkerMessagesStarted = resolve; });
  const workerMessages = new Promise((resolve) => { releaseWorkerMessages = resolve; });
  const manager = {
    async ensureRun(input) {
      return (server ??= { taskId: input.taskId, runId: input.runId, cwd: root, origin: "http://127.0.0.1:43119", providerVersion: "1.18.11" });
    },
    subscribeRun(input) {
      calls.subscriptions.push(input);
      return () => undefined;
    },
    async releaseRun(input) { calls.releases.push(input); return true; },
    clientForRun() {
      return {
        async createSession(input) {
          calls.create.push(input);
          createdCount += 1;
          return { id: createdCount === 1 ? "ses_recycle_conductor" : "ses_recycle_worker" };
        },
        async promptAsync(input) { calls.prompt.push(input); return { accepted: true }; },
        async sendMessage(input) { calls.message.push(input); return { accepted: true, providerMessageId: "msg_should_not_send" }; },
        async messages({ providerSessionId }) {
          if (providerSessionId !== "ses_recycle_worker") return [];
          markWorkerMessagesStarted();
          return workerMessages;
        },
      };
    },
  };
  const sessionStore = createSessionStore({ root: ({ cwd }) => path.join(cwd, ".agent-workspace", "runtime") });
  const capabilities = createSessionStoreCapabilities(sessionStore);
  const runtime = createServerRuntime({
    databasePath: path.join(root, "agent-loop.sqlite"),
    manager,
    capabilities,
  });
  const template = runtime.saveTemplate(reconnectTemplate());
  const task = runtime.createTask({
    taskId: "task-server-idle-recycle-race",
    cwd: root,
    title: "Recycle while Worker result is in flight",
    goal: "A stale Server callback must not write a result or wake the Conductor.",
    templateId: template.id,
  });
  const started = await runtime.startRun({
    taskId: task.taskId,
    commandId: "command-start-idle-recycle-race",
    expectedRevision: task.revision,
  });
  const workerSessionId = runtime.resolveAgentSession({ taskId: task.taskId, agentId: "researcher" }).sessionId;
  const dispatch = capabilities.coordinator.recordDispatch({
    taskId: task.taskId,
    conductorSessionId: started.run.conductorSessionId,
    toSessionId: workerSessionId,
    agentId: "researcher",
    assignment: "Research the bounded question.",
  });
  const delivery = await runtime.deliverOpenCodeWorkerAssignment({ dispatch, text: "Research the bounded question." });
  capabilities.coordinator.markDispatchInputAccepted({
    taskId: task.taskId,
    sessionId: workerSessionId,
    dispatchId: dispatch.dispatchId,
    transport: "opencode_server",
    provider: "opencode",
    providerSessionId: delivery.providerSessionId,
  });

  calls.subscriptions[0].onEvent({ type: "session.idle", properties: { sessionID: "ses_recycle_worker" } });
  await workerMessagesStarted;

  runtime.recordCompletionClaim({
    taskId: task.taskId,
    sessionId: started.run.conductorSessionId,
    message: "The currently available delivery is accepted.",
  });
  const deliveryReady = runtime.readTask({ taskId: task.taskId });
  const achieved = await runtime.markTaskAchieved({
    taskId: task.taskId,
    commandId: "command-achieve-idle-recycle-race",
    expectedRevision: deliveryReady.revision,
  });
  const archived = await runtime.moveTaskToRecycleBin({
    taskId: task.taskId,
    commandId: "command-recycle-idle-recycle-race",
    expectedRevision: achieved.revision,
  });
  assert.equal(archived.status, "archived");

  releaseWorkerMessages([
    {
      info: { id: "msg_worker_after_archive", role: "assistant", time: { completed: 42 } },
      parts: [{ type: "text", text: "This late Worker result must stay historical." }],
    },
  ]);
  // The Server listener deliberately fire-and-forgets callbacks. Yield to the
  // promise queue without a timing-dependent delay so the released callback
  // has completed its post-read lifecycle gate.
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  const state = capabilities.readModel.readTaskState({ taskId: task.taskId, sinceCursor: 0 });
  assert.equal(state.results.length, 0, "an archived Task receives no late Worker result");
  assert.equal(
    state.wakeups.some((entry) => entry.wakeupKey === `result:${task.taskId}:${dispatch.dispatchId}`),
    false,
    "an archived Task receives no late Conductor wakeup",
  );
  assert.equal(calls.message.length, 0, "a late Worker callback must not prompt the archived Conductor");
  assert.equal(runtime.readTask({ taskId: task.taskId }).status, "archived");
  runtime.close();
});

test("reconnects an existing Task Session after a Runtime restart without creating a replacement", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-workspace-server-reconnect-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const databasePath = path.join(root, "agent-loop.sqlite");
  const firstCalls = { ensure: [], create: [], prompt: [] };
  let firstServer;
  const firstManager = {
    async ensureRun(input) {
      firstCalls.ensure.push(input);
      return (firstServer ??= { taskId: input.taskId, runId: input.runId, cwd: root, origin: "http://127.0.0.1:43112", providerVersion: "1.18.11" });
    },
    subscribeRun() { return () => undefined; },
    clientForRun() {
      return {
        async createSession(input) { firstCalls.create.push(input); return { id: "ses_persisted_conductor" }; },
        async promptAsync(input) { firstCalls.prompt.push(input); return { accepted: true }; },
      };
    },
  };
  const initialStore = createSessionStore({ root: ({ cwd }) => path.join(cwd, ".agent-workspace", "runtime") });
  const initialRuntime = createServerRuntime({ databasePath, manager: firstManager, capabilities: createSessionStoreCapabilities(initialStore) });
  const template = initialRuntime.saveTemplate(reconnectTemplate());
  const task = initialRuntime.createTask({
    taskId: "task-server-reconnect",
    cwd: root,
    title: "Reconnect existing Session",
    goal: "Verify an exact Provider Session binding survives a Runtime restart.",
    templateId: template.id,
  });
  const started = await initialRuntime.startRun({ taskId: task.taskId, commandId: "command-server-reconnect" });
  assert.equal(firstCalls.create.length, 1);
  assert.equal(firstCalls.create[0].agent, "agent_workspace_conductor");
  initialRuntime.close();

  const secondCalls = { ensure: [], getSession: [], create: [], release: [] };
  let resolvedPage;
  const resumedManager = {
    async ensureRun(input) {
      secondCalls.ensure.push(input);
      return { taskId: input.taskId, runId: input.runId, cwd: root, origin: "http://127.0.0.1:43113", providerVersion: "1.18.11" };
    },
    subscribeRun() { return () => undefined; },
    clientForRun() {
      return {
        async getSession(input) {
          secondCalls.getSession.push(input);
          return { id: input.providerSessionId, title: "Conductor" };
        },
        async createSession(input) { secondCalls.create.push(input); return { id: "ses_replacement_must_not_exist" }; },
      };
    },
    async releaseRun(input) { secondCalls.release.push(input); return true; },
  };
  const resumedStore = createSessionStore({ root: ({ cwd }) => path.join(cwd, ".agent-workspace", "runtime") });
  const resumedRuntime = createServerRuntime({
    databasePath,
    manager: resumedManager,
    capabilities: createSessionStoreCapabilities(resumedStore),
    resolveOpenCodeSessionPage: async (input) => {
      resolvedPage = input;
      return { presentation: "direct_url", providerSessionId: input.providerSessionId, url: `http://127.0.0.1:43113/session/${input.providerSessionId}` };
    },
  });

  const page = await resumedRuntime.openOpenCodeSessionPage({ runId: started.run.runId, sessionId: started.run.conductorSessionId });
  assert.equal(page.presentation, "direct_url");
  assert.equal(page.providerSessionId, "ses_persisted_conductor");
  assert.match(String(page.presentationLeaseId), /^presentation:/);
  assert.deepEqual(secondCalls.getSession, [{ cwd: root, providerSessionId: "ses_persisted_conductor" }]);
  assert.equal(secondCalls.create.length, 0, "reconciliation must never fabricate a replacement Provider Session");
  assert.equal(resolvedPage.taskId, task.taskId);
  assert.equal(resolvedPage.runId, started.run.runId);
  assert.equal(resolvedPage.sessionId, started.run.conductorSessionId);
  assert.equal(resolvedPage.providerSessionId, "ses_persisted_conductor");
  assert.equal(resolvedPage.cwd, root);
  assert.equal(resolvedPage.presentationLeaseId, page.presentationLeaseId);
  assert.equal(typeof resolvedPage.beforeProviderUserMessage, "function");
  assert.match(String(secondCalls.ensure[0]?.leaseId), /^presentation:/);

  const { DatabaseSync } = require("node:sqlite");
  const database = new DatabaseSync(databasePath);
  const hostBinding = database.prepare("SELECT project_root, config_fingerprint, last_reconciled_at FROM agent_loop_opencode_host_bindings WHERE run_id = ?").get(started.run.runId);
  database.close();
  assert.equal(hostBinding.project_root, root);
  assert.match(hostBinding.config_fingerprint, /^[a-f0-9]{64}$/);
  assert.ok(hostBinding.last_reconciled_at);

  assert.equal(await resumedRuntime.releaseOpenCodeSessionPage({
    runId: started.run.runId,
    sessionId: started.run.conductorSessionId,
    leaseId: page.presentationLeaseId,
  }), true);
  assert.deepEqual(secondCalls.release, [{
    taskId: task.taskId,
    runId: started.run.runId,
    leaseId: page.presentationLeaseId,
  }]);
  resumedRuntime.close();
});

test("reconciliation keeps an unresolved native permission visible when opening its official Worker page", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-workspace-server-permission-rebind-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const databasePath = path.join(root, "agent-loop.sqlite");
  let createdCount = 0;
  const initialManager = {
    async ensureRun(input) {
      return { taskId: input.taskId, runId: input.runId, cwd: root, origin: "http://127.0.0.1:43120", providerVersion: "1.18.11" };
    },
    subscribeRun() { return () => undefined; },
    clientForRun() {
      return {
        async createSession() {
          createdCount += 1;
          return { id: createdCount === 1 ? "ses_permission_conductor" : "ses_permission_worker" };
        },
        async promptAsync() { return { accepted: true }; },
      };
    },
  };
  const initialStore = createSessionStore({ root: ({ cwd }) => path.join(cwd, ".agent-workspace", "runtime") });
  const initialCapabilities = createSessionStoreCapabilities(initialStore);
  const initialRuntime = createServerRuntime({
    databasePath,
    manager: initialManager,
    capabilities: initialCapabilities,
  });
  const template = initialRuntime.saveTemplate(reconnectTemplate());
  const task = initialRuntime.createTask({
    taskId: "task-server-permission-rebind",
    cwd: root,
    title: "Permission-preserving rebind",
    goal: "Opening the official Worker page must not clear a native permission request.",
    templateId: template.id,
  });
  const started = await initialRuntime.startRun({ taskId: task.taskId, commandId: "command-start-permission-rebind" });
  const workerSessionId = initialRuntime.resolveAgentSession({ taskId: task.taskId, agentId: "researcher" }).sessionId;
  const dispatch = initialCapabilities.coordinator.recordDispatch({
    taskId: task.taskId,
    conductorSessionId: started.run.conductorSessionId,
    toSessionId: workerSessionId,
    agentId: "researcher",
    assignment: "Reproduce the reported failure.",
  });
  await initialRuntime.deliverOpenCodeWorkerAssignment({ dispatch, text: "Reproduce the reported failure." });
  initialCapabilities.provider.recordPermissionRequested({
    taskId: task.taskId,
    sessionId: workerSessionId,
    cwd: root,
    permissionId: "opencode:per_worker_rebind",
    requestId: "per_worker_rebind",
    provider: "opencode",
    permission: "bash",
    summary: "OpenCode requires one native permission before the Worker can continue.",
  });
  assert.equal(initialCapabilities.readModel.readTaskState({ taskId: task.taskId, sinceCursor: 0 }).sessions
    .find((session) => session.sessionId === workerSessionId)?.state, "permission_required");
  initialRuntime.close();

  const resumedCalls = { getSession: [], create: [] };
  const resumedManager = {
    async ensureRun(input) {
      return { taskId: input.taskId, runId: input.runId, cwd: root, origin: "http://127.0.0.1:43121", providerVersion: "1.18.11" };
    },
    subscribeRun() { return () => undefined; },
    clientForRun() {
      return {
        async getSession(input) {
          resumedCalls.getSession.push(input);
          return { id: input.providerSessionId, title: "Recovered Session" };
        },
        async createSession(input) {
          resumedCalls.create.push(input);
          return { id: "ses_replacement_must_not_exist" };
        },
      };
    },
  };
  const resumedStore = createSessionStore({ root: ({ cwd }) => path.join(cwd, ".agent-workspace", "runtime") });
  const resumedCapabilities = createSessionStoreCapabilities(resumedStore);
  const resumedRuntime = createServerRuntime({
    databasePath,
    manager: resumedManager,
    capabilities: resumedCapabilities,
    resolveOpenCodeSessionPage: async (input) => ({
      presentation: "direct_url",
      providerSessionId: input.providerSessionId,
      url: `http://127.0.0.1:43121/session/${input.providerSessionId}`,
    }),
  });

  const page = await resumedRuntime.openOpenCodeSessionPage({ runId: started.run.runId, sessionId: workerSessionId });
  assert.equal(page.presentation, "direct_url");
  const reconciled = resumedCapabilities.readModel.readTaskState({ taskId: task.taskId, sinceCursor: 0 });
  assert.equal(reconciled.sessions.find((session) => session.sessionId === workerSessionId)?.state, "permission_required");
  assert.equal(reconciled.sessions.find((session) => session.sessionId === workerSessionId)?.providerState, "permission_required");
  assert.equal(reconciled.permissions.find((permission) => permission.permissionId === "opencode:per_worker_rebind")?.status, "requested");
  assert.deepEqual(
    resumedRuntime.validateDispatch({ taskId: task.taskId, agentId: "researcher", toSessionId: workerSessionId }),
    { ok: false, reason: "loop_session_permission_decision_pending", permissionId: "opencode:per_worker_rebind" },
  );
  assert.equal(resumedCalls.create.length, 0, "reconciliation must retain the exact Worker Session rather than create a replacement");
  await resumedRuntime.releaseOpenCodeSessionPage({ runId: started.run.runId, sessionId: workerSessionId, leaseId: page.presentationLeaseId });
  resumedRuntime.close();
});

test("backfills only a legacy permission whose same Worker Session already has a durable result", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-workspace-server-legacy-permission-rebind-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const databasePath = path.join(root, "agent-loop.sqlite");
  let firstCreated = 0;
  const firstManager = {
    async ensureRun(input) { return { taskId: input.taskId, runId: input.runId, cwd: root, origin: "http://127.0.0.1:43115", providerVersion: "1.18.11" }; },
    subscribeRun() { return () => undefined; },
    clientForRun() {
      return {
        async createSession() {
          firstCreated += 1;
          return { id: firstCreated === 1 ? "ses_legacy_conductor" : "ses_legacy_worker" };
        },
        async promptAsync() { return { accepted: true }; },
      };
    },
  };
  const initialStore = createSessionStore({ root: ({ cwd }) => path.join(cwd, ".agent-workspace", "runtime") });
  const initialRuntime = createServerRuntime({ databasePath, manager: firstManager, capabilities: createSessionStoreCapabilities(initialStore) });
  const template = initialRuntime.saveTemplate(reconnectTemplate());
  const task = initialRuntime.createTask({
    taskId: "task-server-legacy-permission",
    cwd: root,
    title: "Legacy permission rebind",
    goal: "Recover only an exact completed Worker turn.",
    templateId: template.id,
  });
  const started = await initialRuntime.startRun({ taskId: task.taskId, commandId: "command-server-legacy-permission" });
  const workerSessionId = initialRuntime.resolveAgentSession({ taskId: task.taskId, agentId: "researcher" }).sessionId;
  const dispatch = initialStore.recordDispatch({
    taskId: task.taskId,
    conductorSessionId: started.run.conductorSessionId,
    toSessionId: workerSessionId,
    agentId: "researcher",
    assignment: "Return a durable evidence result.",
  });
  const delivery = await initialRuntime.deliverOpenCodeWorkerAssignment({ dispatch, text: "Return a durable evidence result." });
  initialStore.recordPermissionRequested({
    taskId: task.taskId,
    sessionId: workerSessionId,
    cwd: root,
    permissionId: "opencode:per-legacy-worker",
    requestId: "per-legacy-worker",
    provider: "opencode",
    permission: "external_directory",
    patterns: [path.join(root, "artifacts", "memo.md")],
    summary: "Historical official-WebUI approval request.",
  });
  initialStore.recordDispatchResult({
    taskId: task.taskId,
    sessionId: workerSessionId,
    dispatchId: dispatch.dispatchId,
    reason: "provider-turn-completed",
    provider: "opencode",
    providerSessionId: delivery.providerSessionId,
    providerMessageId: "msg-legacy-worker-result",
    answerText: "The historical Worker result is durable.",
    source: "historical-provider-result",
  });
  assert.equal(initialRuntime.validateDispatch({ taskId: task.taskId, agentId: "researcher", toSessionId: workerSessionId }).reason, "loop_session_permission_decision_pending");
  initialRuntime.close();

  const secondCalls = { getSession: [], create: [] };
  const resumedManager = {
    async ensureRun(input) { return { taskId: input.taskId, runId: input.runId, cwd: root, origin: "http://127.0.0.1:43116", providerVersion: "1.18.11" }; },
    subscribeRun() { return () => undefined; },
    clientForRun() {
      return {
        async getSession(input) {
          secondCalls.getSession.push(input);
          return { id: input.providerSessionId, title: "Recovered Worker" };
        },
        async createSession(input) { secondCalls.create.push(input); return { id: "ses_must_not_be_created" }; },
      };
    },
  };
  const resumedStore = createSessionStore({ root: ({ cwd }) => path.join(cwd, ".agent-workspace", "runtime") });
  const resumedRuntime = createServerRuntime({
    databasePath,
    manager: resumedManager,
    capabilities: createSessionStoreCapabilities(resumedStore),
    resolveOpenCodeSessionPage: async (input) => ({ presentation: "direct_url", providerSessionId: input.providerSessionId, url: `http://127.0.0.1:43116/session/${input.providerSessionId}` }),
  });

  const page = await resumedRuntime.openOpenCodeSessionPage({ runId: started.run.runId, sessionId: workerSessionId });
  assert.equal(page.presentation, "direct_url");
  assert.equal(page.providerSessionId, "ses_legacy_worker");
  const recovered = resumedStore.readSession({ taskId: task.taskId, sessionId: workerSessionId, cwd: root });
  assert.equal(recovered.permissions[0].status, "provider_turn_completed");
  assert.equal(recovered.permissions[0].providerTurnCompletedDispatchId, dispatch.dispatchId);
  assert.equal(resumedRuntime.validateDispatch({ taskId: task.taskId, agentId: "researcher", toSessionId: workerSessionId }).ok, true);
  assert.equal(secondCalls.create.length, 0);
  resumedRuntime.close();
});

test("preflights official Conductor Web UI input before the Provider can begin a new turn", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-workspace-server-webui-input-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const databasePath = path.join(root, "agent-loop.sqlite");
  const calls = { ensure: [], create: [], prompt: [], message: [], subscriptions: [], releases: [] };
  const releaseOrder = [];
  let server;
  const manager = {
    async ensureRun(input) {
      calls.ensure.push(input);
      return (server ??= { taskId: input.taskId, runId: input.runId, cwd: root, origin: "http://127.0.0.1:43114", providerVersion: "1.18.11" });
    },
    subscribeRun(input) { calls.subscriptions.push(input); return () => undefined; },
    clientForRun() {
      return {
        async createSession(input) { calls.create.push(input); return { id: "ses_webui_conductor" }; },
        async promptAsync(input) { calls.prompt.push(input); return { accepted: true }; },
        async sendMessage(input) { calls.message.push(input); return { accepted: true, providerMessageId: "msg_runtime_must_not_exist" }; },
        async getSession({ providerSessionId }) { return { id: providerSessionId, title: "Conductor" }; },
      };
    },
    async releaseRun(input) {
      releaseOrder.push("server");
      calls.releases.push(input);
      return true;
    },
  };
  const sessionStore = createSessionStore({ root: ({ cwd }) => path.join(cwd, ".agent-workspace", "runtime") });
  const capabilities = createSessionStoreCapabilities(sessionStore);
  let resolverInput;
  const resolverReleases = [];
  const runtime = createServerRuntime({
    databasePath,
    manager,
    capabilities,
    resolveOpenCodeSessionPage: async (input) => {
      resolverInput = input;
      return { presentation: "direct_url", providerSessionId: input.providerSessionId, url: `http://127.0.0.1:43114/session/${input.providerSessionId}` };
    },
    releaseOpenCodeSessionPage: async (input) => {
      releaseOrder.push("resolver");
      resolverReleases.push(input);
    },
  });
  const template = runtime.saveTemplate(reconnectTemplate());
  const task = runtime.createTask({
    taskId: "task-server-webui-input",
    cwd: root,
    title: "Web UI continuation",
    goal: "Continue one delivery-ready Task from the official OpenCode Web UI.",
    templateId: template.id,
  });
  const started = await runtime.startRun({ taskId: task.taskId, commandId: "command-server-webui-input" });
  runtime.recordCompletionClaim({ taskId: task.taskId, sessionId: started.run.conductorSessionId, message: "Initial delivery is ready." });
  assert.equal(runtime.readTask({ taskId: task.taskId }).status, "delivery_ready");
  const researcher = runtime.resolveAgentSession({ taskId: task.taskId, agentId: "researcher" });
  assert.deepEqual(
    runtime.validateDispatch({ taskId: task.taskId, agentId: "researcher", toSessionId: researcher.sessionId }),
    { ok: false, reason: "loop_task_not_dispatchable" },
  );

  const page = await runtime.openOpenCodeSessionPage({ runId: started.run.runId, sessionId: started.run.conductorSessionId });
  assert.equal(page.presentation, "direct_url");
  assert.equal(resolverInput.presentationLeaseId, page.presentationLeaseId);
  assert.equal(typeof resolverInput.beforeProviderUserMessage, "function");

  const input = {
    providerSessionId: "ses_webui_conductor",
    inputId: "msg_webui_followup_1",
    text: "请根据已有证据继续给出投资风险判断。",
  };
  const firstPreflight = await resolverInput.beforeProviderUserMessage(input);
  const replayPreflight = await resolverInput.beforeProviderUserMessage(input);
  assert.equal(firstPreflight.ok, true);
  assert.equal(firstPreflight.inputId, input.inputId, "the exact Provider message id is the continuation idempotency input");
  assert.equal(replayPreflight.wakeupKey, firstPreflight.wakeupKey);
  assert.equal(runtime.readTask({ taskId: task.taskId }).status, "running");
  assert.deepEqual(
    runtime.validateDispatch({ taskId: task.taskId, agentId: "researcher", toSessionId: researcher.sessionId }),
    { ok: true },
    "the gateway callback opens the next decision epoch before it forwards the Provider turn",
  );
  const attempting = capabilities.readModel.readTaskState({ taskId: task.taskId, sinceCursor: 0 }).wakeups
    .find((entry) => entry.wakeupKey === firstPreflight.wakeupKey);
  assert.equal(attempting.status, "attempting");
  assert.equal(attempting.messageText, input.text);
  assert.equal(calls.message.length, 0, "Runtime must not submit a second Server message for a direct Web UI request");
  assert.equal(calls.prompt.length, 1, "Runtime must not submit a second Server prompt for a direct Web UI request");

  // The gateway callback is the pre-execution gate. The later SSE fact only
  // attaches the actual Provider message id and advances `attempting` to
  // `observed`; replaying this event remains harmless.
  calls.subscriptions[0].onEvent({
    type: "message.updated",
    properties: { info: { id: input.inputId, role: "user", sessionID: input.providerSessionId } },
  });
  calls.subscriptions[0].onEvent({
    type: "message.updated",
    properties: { info: { id: input.inputId, role: "user", sessionID: input.providerSessionId } },
  });
  const observed = capabilities.readModel.readTaskState({ taskId: task.taskId, sinceCursor: 0 }).wakeups
    .find((entry) => entry.wakeupKey === firstPreflight.wakeupKey);
  assert.equal(observed.status, "observed");
  assert.equal(observed.providerMessageId, input.inputId);
  assert.equal(observed.providerSessionId, input.providerSessionId);
  assert.equal(observed.messageText, input.text);

  const { DatabaseSync } = require("node:sqlite");
  const database = new DatabaseSync(databasePath);
  const events = database.prepare("SELECT type, data_json FROM agent_loop_events WHERE run_id = ? ORDER BY sequence ASC").all(started.run.runId);
  database.close();
  assert.equal(events.filter((event) => event.type === "task.continued").length, 1);
  assert.equal(events.filter((event) => event.type === "conductor.provider_user_input_attempting").length, 1);
  assert.equal(events.filter((event) => event.type === "conductor.provider_user_input_observed").length, 1);

  assert.equal(await runtime.releaseOpenCodeSessionPage({
    runId: started.run.runId,
    sessionId: started.run.conductorSessionId,
    leaseId: page.presentationLeaseId,
  }), true);
  assert.deepEqual(resolverReleases, [{
    taskId: task.taskId,
    runId: started.run.runId,
    sessionId: started.run.conductorSessionId,
    leaseId: page.presentationLeaseId,
  }]);
  assert.deepEqual(releaseOrder, ["resolver", "server"]);
  runtime.close();
});

test("explicitly resumes an achieved Task on its exact original OpenCode Conductor Session", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-workspace-server-resume-achieved-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const databasePath = path.join(root, "agent-loop.sqlite");
  const calls = { ensure: [], hosts: [], create: [], prompt: [], getSession: [], releases: [], subscriptions: 0, unsubscriptions: 0 };
  const durableProviderSessions = new Set();
  let hostEpoch = 0;
  let server;
  const manager = {
    async ensureRun(input) {
      calls.ensure.push(input);
      if (!server) {
        hostEpoch += 1;
        server = {
          taskId: input.taskId,
          runId: input.runId,
          cwd: root,
          origin: `http://127.0.0.1:${43114 + hostEpoch}`,
          providerVersion: "1.18.11",
        };
        calls.hosts.push(server);
      }
      return server;
    },
    subscribeRun() {
      calls.subscriptions += 1;
      return () => { calls.unsubscriptions += 1; };
    },
    async releaseRun(input) {
      calls.releases.push(input);
      // Model the Server Manager's last-lease idle shutdown. The Provider
      // database is intentionally outside the Host process, so a later
      // ensureRun gets a fresh Host/client while the original Session id still
      // resolves through that durable Provider store.
      server = undefined;
      return true;
    },
    clientForRun() {
      return {
        async createSession(input) {
          calls.create.push(input);
          durableProviderSessions.add("ses_resume_original");
          return { id: "ses_resume_original" };
        },
        async promptAsync(input) { calls.prompt.push(input); return { accepted: true }; },
        async getSession(input) {
          calls.getSession.push(input);
          if (!durableProviderSessions.has(input.providerSessionId)) throw new Error("opencode_server_request_failed:404");
          return { id: input.providerSessionId, title: "Original Conductor" };
        },
      };
    },
  };
  const sessionStore = createSessionStore({ root: ({ cwd }) => path.join(cwd, ".agent-workspace", "runtime") });
  const runtime = createServerRuntime({
    databasePath,
    manager,
    capabilities: createSessionStoreCapabilities(sessionStore),
  });
  const template = runtime.saveTemplate(reconnectTemplate());
  const task = runtime.createTask({
    taskId: "task-server-resume-achieved",
    cwd: root,
    title: "Resume achieved Task",
    goal: "Verify that the original Provider Session is the only resume target.",
    templateId: template.id,
  });
  const started = await runtime.startRun({ taskId: task.taskId, commandId: "command-start-resume-achieved", expectedRevision: task.revision });
  runtime.recordCompletionClaim({ taskId: task.taskId, sessionId: started.run.conductorSessionId, message: "Delivery is accepted." });
  const ready = runtime.readTask({ taskId: task.taskId });
  await runtime.markTaskAchieved({ taskId: task.taskId, commandId: "command-achieve-resume", expectedRevision: ready.revision });
  const achievedTask = runtime.readTask({ taskId: task.taskId });
  assert.equal(achievedTask.status, "achieved");
  assert.equal(runtime.readRun({ runId: started.run.runId }).run.status, "achieved");
  assert.deepEqual(calls.releases, [{
    taskId: task.taskId,
    runId: started.run.runId,
    leaseId: `runtime:${started.run.runId}`,
  }], "Achieve releases only this inactive Run's base Host lease");
  assert.equal(calls.subscriptions, 1);
  assert.equal(calls.unsubscriptions, 1, "Achieve detaches the inactive Run's Server observer");
  const providerStateBeforeRecycle = sessionStore.readSession({
    taskId: task.taskId,
    sessionId: started.run.conductorSessionId,
    cwd: root,
    maxChars: 0,
  }).state;

  const recycled = await runtime.moveTaskToRecycleBin({
    taskId: task.taskId,
    commandId: "command-recycle-before-resume",
    expectedRevision: achievedTask.revision,
  });
  assert.equal(recycled.status, "archived");
  assert.equal(runtime.listTasks().some((entry) => entry.taskId === task.taskId), false, "a recycled Task leaves the normal list");
  assert.equal(runtime.listTasks({ scope: "trash" }).find((entry) => entry.taskId === task.taskId)?.status, "archived");
  assert.equal(runtime.readRun({ runId: started.run.runId }).run.status, "achieved", "recycle retains the original Run");
  assert.equal(
    sessionStore.readSession({ taskId: task.taskId, sessionId: started.run.conductorSessionId, cwd: root, maxChars: 0 }).providerBinding.providerSessionId,
    "ses_resume_original",
    "recycle retains the exact Provider Session binding",
  );
  assert.equal(
    sessionStore.readSession({ taskId: task.taskId, sessionId: started.run.conductorSessionId, cwd: root, maxChars: 0 }).state,
    providerStateBeforeRecycle,
    "recycling must not overwrite a retained Provider fact with a false blocked state",
  );
  const restored = await runtime.restoreTaskFromRecycleBin({
    taskId: task.taskId,
    commandId: "command-restore-before-resume",
    expectedRevision: recycled.revision,
  });
  assert.equal(restored.status, "achieved");
  assert.equal(runtime.readTask({ taskId: task.taskId }).latestRun.runId, started.run.runId, "restore does not create a new Run");

  await assert.rejects(
    () => runtime.startRun({ taskId: task.taskId, commandId: "command-start-must-not-rerun", expectedRevision: restored.revision }),
    /loop_task_requires_resume_achieved/,
  );
  assert.equal(calls.create.length, 1, "Start after Achieve must not create a replacement Provider Session");

  await assert.rejects(
    () => runtime.resumeAchievedTask({ taskId: task.taskId, commandId: "command-resume-missing-revision" }),
    /loop_task_expected_revision_required/,
  );
  assert.equal(calls.getSession.length, 0, "a command without a revision fence must not contact the Provider");
  await assert.rejects(
    () => runtime.resumeAchievedTask({ taskId: task.taskId, commandId: "command-resume-stale-revision", expectedRevision: restored.revision - 1 }),
    /loop_task_revision_conflict/,
  );
  assert.equal(calls.getSession.length, 0, "a stale command must not contact the Provider before its revision fence passes");

  const resumed = await runtime.resumeAchievedTask({
    taskId: task.taskId,
    commandId: "command-resume-achieved",
    expectedRevision: restored.revision,
  });
  assert.equal(resumed.task.taskId, task.taskId);
  assert.equal(resumed.run.runId, started.run.runId, "resume keeps the original Run identity");
  assert.equal(resumed.run.conductorSessionId, started.run.conductorSessionId, "resume keeps the original logical Conductor Session");
  assert.equal(resumed.task.status, "running");
  assert.equal(resumed.run.status, "running");
  assert.deepEqual(calls.getSession, [{ cwd: root, providerSessionId: "ses_resume_original" }]);
  assert.equal(calls.hosts.length, 2, "resume reacquires a Host after Achieve released the idle Run lease");
  assert.notEqual(calls.hosts[0].origin, calls.hosts[1].origin, "resume verifies the original Provider Session through a fresh Host/client");
  assert.equal(calls.create.length, 1, "exact reconciliation must never call createSession");
  assert.equal(calls.prompt.length, 1, "resume only rebinds the original Conductor Session; it does not seed a replacement turn");
  assert.equal(calls.subscriptions, 2, "resume attaches a fresh observer for the active original Run");
  assert.equal(calls.unsubscriptions, 1, "a successful resume retains its renewed base Host lease");
  assert.equal(calls.releases.length, 2, "recycle's resource cleanup is the only release after Achieve; successful resume does not release its active lease");

  const replay = await runtime.resumeAchievedTask({
    taskId: task.taskId,
    commandId: "command-resume-achieved",
    expectedRevision: restored.revision,
  });
  assert.equal(replay.run.runId, started.run.runId);
  assert.equal(calls.getSession.length, 1, "a replay returns the committed resume without another Provider lookup");

  const { DatabaseSync } = require("node:sqlite");
  const database = new DatabaseSync(databasePath);
  const resumedEvents = database.prepare("SELECT type FROM agent_loop_events WHERE run_id = ? AND type = 'task.resumed'").all(started.run.runId);
  const runs = database.prepare("SELECT run_id FROM agent_loop_runs WHERE task_id = ?").all(task.taskId);
  database.close();
  assert.equal(resumedEvents.length, 1, "one command produces one durable resume event");
  assert.deepEqual(runs.map((entry) => entry.run_id), [started.run.runId], "resume never creates a second Run row");
  runtime.close();
});

test("revokes an achieved Task page lease and gives the same Run a fresh lease only after exact-session resume", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-workspace-server-presentation-epoch-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const databasePath = path.join(root, "agent-loop.sqlite");
  const calls = { create: [], getSession: [], releases: [], subscriptions: 0, unsubscriptions: 0 };
  const pageInputs = [];
  const releasedPages = [];
  let server;
  const manager = {
    async ensureRun(input) {
      return (server ??= { taskId: input.taskId, runId: input.runId, cwd: root, origin: "http://127.0.0.1:43117", providerVersion: "1.18.11" });
    },
    subscribeRun() {
      calls.subscriptions += 1;
      return () => { calls.unsubscriptions += 1; };
    },
    clientForRun() {
      return {
        async createSession(input) { calls.create.push(input); return { id: "ses_presentation_original" }; },
        async promptAsync() { return { accepted: true }; },
        async getSession(input) { calls.getSession.push(input); return { id: input.providerSessionId, title: "Original Conductor" }; },
      };
    },
    async releaseRun(input) { calls.releases.push(input); return true; },
  };
  const sessionStore = createSessionStore({ root: ({ cwd }) => path.join(cwd, ".agent-workspace", "runtime") });
  const capabilities = createSessionStoreCapabilities(sessionStore);
  const runtime = createServerRuntime({
    databasePath,
    manager,
    capabilities,
    resolveOpenCodeSessionPage: async (input) => {
      pageInputs.push(input);
      return {
        presentation: "direct_url",
        providerSessionId: input.providerSessionId,
        url: `http://127.0.0.1:43117/session/${input.providerSessionId}?lease=${encodeURIComponent(input.presentationLeaseId)}`,
      };
    },
    releaseOpenCodeSessionPage: async (input) => {
      releasedPages.push(input);
    },
  });
  const template = runtime.saveTemplate(reconnectTemplate());
  const task = runtime.createTask({
    taskId: "task-server-presentation-epoch",
    cwd: root,
    title: "Presentation epoch",
    goal: "Keep one original Conductor Session while making achieved pages historical.",
    templateId: template.id,
  });
  const started = await runtime.startRun({ taskId: task.taskId, commandId: "command-start-presentation-epoch", expectedRevision: task.revision });
  const beforeAchievePage = await runtime.openOpenCodeSessionPage({
    runId: started.run.runId,
    sessionId: started.run.conductorSessionId,
  });
  assert.equal(beforeAchievePage.presentation, "direct_url");
  assert.equal(pageInputs.length, 1);
  assert.equal(pageInputs[0].providerSessionId, "ses_presentation_original");
  assert.equal(typeof pageInputs[0].beforeProviderUserMessage, "function");

  runtime.recordCompletionClaim({ taskId: task.taskId, sessionId: started.run.conductorSessionId, message: "Delivery accepted." });
  const ready = runtime.readTask({ taskId: task.taskId });
  await runtime.markTaskAchieved({
    taskId: task.taskId,
    commandId: "command-achieve-presentation-epoch",
    expectedRevision: ready.revision,
  });
  assert.equal(runtime.readTask({ taskId: task.taskId }).status, "achieved");
  assert.equal(runtime.readRun({ runId: started.run.runId }).run.status, "achieved");
  assert.deepEqual(releasedPages, [{
    taskId: task.taskId,
    runId: started.run.runId,
    sessionId: started.run.conductorSessionId,
    leaseId: beforeAchievePage.presentationLeaseId,
  }], "Achieve releases the only active official-WebUI lease");
  assert.deepEqual(calls.releases, [
    {
      taskId: task.taskId,
      runId: started.run.runId,
      leaseId: beforeAchievePage.presentationLeaseId,
    },
    {
      taskId: task.taskId,
      runId: started.run.runId,
      leaseId: `runtime:${started.run.runId}`,
    },
  ], "Achieve releases the presentation lease before the inactive Run's base Host lease");
  assert.equal(calls.unsubscriptions, 1, "Achieve detaches the inactive Run's Server observer");

  const historicalPage = await runtime.openOpenCodeSessionPage({
    runId: started.run.runId,
    sessionId: started.run.conductorSessionId,
  });
  assert.deepEqual(historicalPage, { presentation: "unavailable", reason: "task_session_not_interactive" });
  assert.equal(pageInputs.length, 1, "an achieved Task cannot mint a replacement presentation lease");

  await assert.rejects(
    () => pageInputs[0].beforeProviderUserMessage({
      providerSessionId: "ses_presentation_original",
      inputId: "msg_stale_page_after_achieve",
      text: "This stale page must not wake the achieved Task.",
    }),
    /loop_task_is_closed/,
  );
  const historicalState = capabilities.readModel.readTaskState({ taskId: task.taskId, sinceCursor: 0 });
  assert.equal(
    historicalState.wakeups.some((entry) => entry.wakeupKey.includes("msg_stale_page_after_achieve")),
    false,
    "a stale page preflight writes no wakeup or Provider-input receipt after Achieve",
  );

  const achieved = runtime.readTask({ taskId: task.taskId });
  const resumed = await runtime.resumeAchievedTask({
    taskId: task.taskId,
    commandId: "command-resume-presentation-epoch",
    expectedRevision: achieved.revision,
  });
  assert.equal(resumed.task.taskId, task.taskId);
  assert.equal(resumed.run.runId, started.run.runId, "resume retains the original Run");
  assert.equal(resumed.run.conductorSessionId, started.run.conductorSessionId, "resume retains the original logical Conductor Session");
  assert.equal(calls.create.length, 1, "resume never creates a replacement Provider Session");

  const afterResumePage = await runtime.openOpenCodeSessionPage({
    runId: started.run.runId,
    sessionId: started.run.conductorSessionId,
  });
  assert.equal(afterResumePage.presentation, "direct_url");
  assert.equal(afterResumePage.providerSessionId, "ses_presentation_original");
  assert.notEqual(afterResumePage.presentationLeaseId, beforeAchievePage.presentationLeaseId, "the same Provider Session receives a fresh presentation lease after resume");
  assert.equal(pageInputs.length, 2);
  assert.equal(pageInputs[1].providerSessionId, pageInputs[0].providerSessionId);
  assert.equal(calls.create.length, 1);
  assert.equal(calls.subscriptions, 2, "resume reattaches the active Run's Server observer");
  assert.equal(calls.releases.length, 2, "successful exact-session resume keeps the renewed base lease");

  const replayedAchieve = await runtime.markTaskAchieved({
    taskId: task.taskId,
    commandId: "command-achieve-presentation-epoch",
    expectedRevision: ready.revision,
  });
  assert.equal(replayedAchieve.status, "running", "a replayed pre-resume Achieve command must not close a resumed Task");
  assert.equal(
    releasedPages.some((entry) => entry.leaseId === afterResumePage.presentationLeaseId),
    false,
    "a replayed pre-resume Achieve command must not revoke the fresh resumed page lease",
  );
  assert.equal(releasedPages.length, 1, "only the pre-Achieve page is released");
  assert.equal(calls.releases.length, 2, "a replayed pre-resume Achieve does not release the active resumed Run lease");
  runtime.close();
});

test("keeps an achieved Task historical when its exact OpenCode Conductor Session is unavailable", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-workspace-server-resume-missing-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const databasePath = path.join(root, "agent-loop.sqlite");
  const calls = { create: [], getSession: [], releases: [], subscriptions: 0, unsubscriptions: 0 };
  let server;
  const manager = {
    async ensureRun(input) {
      return (server ??= { taskId: input.taskId, runId: input.runId, cwd: root, origin: "http://127.0.0.1:43116", providerVersion: "1.18.11" });
    },
    subscribeRun() {
      calls.subscriptions += 1;
      return () => { calls.unsubscriptions += 1; };
    },
    async releaseRun(input) { calls.releases.push(input); return true; },
    clientForRun() {
      return {
        async createSession(input) { calls.create.push(input); return { id: "ses_missing_original" }; },
        async promptAsync() { return { accepted: true }; },
        async getSession(input) {
          calls.getSession.push(input);
          throw new Error("opencode_server_request_failed:404");
        },
      };
    },
  };
  const sessionStore = createSessionStore({ root: ({ cwd }) => path.join(cwd, ".agent-workspace", "runtime") });
  const runtime = createServerRuntime({
    databasePath,
    manager,
    capabilities: createSessionStoreCapabilities(sessionStore),
  });
  const template = runtime.saveTemplate(reconnectTemplate());
  const task = runtime.createTask({
    taskId: "task-server-resume-missing",
    cwd: root,
    title: "Missing achieved Conductor",
    goal: "Do not replace a missing historical Provider Session.",
    templateId: template.id,
  });
  const started = await runtime.startRun({ taskId: task.taskId, commandId: "command-start-missing", expectedRevision: task.revision });
  runtime.recordCompletionClaim({ taskId: task.taskId, sessionId: started.run.conductorSessionId, message: "Delivery is accepted." });
  const ready = runtime.readTask({ taskId: task.taskId });
  await runtime.markTaskAchieved({ taskId: task.taskId, commandId: "command-achieve-missing", expectedRevision: ready.revision });
  const achievedTask = runtime.readTask({ taskId: task.taskId });
  assert.deepEqual(calls.releases, [{
    taskId: task.taskId,
    runId: started.run.runId,
    leaseId: `runtime:${started.run.runId}`,
  }], "Achieve releases the inactive Run lease before an exact-session resume attempt");
  assert.equal(calls.unsubscriptions, 1);

  await assert.rejects(
    () => runtime.resumeAchievedTask({ taskId: task.taskId, commandId: "command-resume-missing", expectedRevision: achievedTask.revision }),
    /loop_achieved_conductor_session_missing/,
  );
  assert.deepEqual(calls.getSession, [{ cwd: root, providerSessionId: "ses_missing_original" }]);
  assert.equal(calls.create.length, 1, "a missing exact Session must not create a replacement Provider Session");
  assert.deepEqual(calls.releases, [
    { taskId: task.taskId, runId: started.run.runId, leaseId: `runtime:${started.run.runId}` },
    { taskId: task.taskId, runId: started.run.runId, leaseId: `runtime:${started.run.runId}` },
  ], "a failed exact-session resume releases the lease it reacquired for verification");
  assert.equal(calls.subscriptions, 2, "the failed exact lookup attached one temporary Server observer");
  assert.equal(calls.unsubscriptions, 2, "the failed exact lookup detaches its temporary observer");
  assert.equal(runtime.readTask({ taskId: task.taskId }).status, "achieved");
  assert.equal(runtime.readRun({ runId: started.run.runId }).run.status, "achieved");

  const { DatabaseSync } = require("node:sqlite");
  const database = new DatabaseSync(databasePath);
  const resumeCommands = database.prepare("SELECT command_id FROM agent_loop_commands WHERE task_id = ? AND kind = 'task.resume_achieved'").all(task.taskId);
  const runs = database.prepare("SELECT run_id FROM agent_loop_runs WHERE task_id = ?").all(task.taskId);
  database.close();
  assert.equal(resumeCommands.length, 0, "an unavailable precondition must not commit a lifecycle command");
  assert.deepEqual(runs.map((entry) => entry.run_id), [started.run.runId]);
  runtime.close();
});

test("keeps an achieved Task historical when the OpenCode Host cannot reattach the original Run", async (t) => {
  for (const failurePoint of ["ensureRun", "subscribeRun", "clientForRun"]) {
    await t.test(failurePoint, async (t) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), `agent-workspace-server-resume-host-${failurePoint}-`));
      t.after(() => fs.rmSync(root, { recursive: true, force: true }));
      const calls = { ensure: [], create: [], getSession: [], releases: [], subscriptions: 0, unsubscriptions: 0 };
      let ensureCount = 0;
      const manager = {
        async ensureRun(input) {
          calls.ensure.push(input);
          ensureCount += 1;
          if (failurePoint === "ensureRun" && ensureCount === 2) throw new Error("opencode_server_unavailable");
          return { taskId: input.taskId, runId: input.runId, cwd: root, origin: "http://127.0.0.1:43118", providerVersion: "1.18.11" };
        },
        subscribeRun() {
          calls.subscriptions += 1;
          if (failurePoint === "subscribeRun" && ensureCount === 2) throw new Error("opencode_server_event_stream_unavailable");
          return () => { calls.unsubscriptions += 1; };
        },
        clientForRun() {
          if (failurePoint === "clientForRun" && ensureCount === 2) throw new Error("opencode_server_run_not_ready");
          return {
            async createSession(input) { calls.create.push(input); return { id: "ses_host_failure_original" }; },
            async promptAsync() { return { accepted: true }; },
            async getSession(input) { calls.getSession.push(input); return { id: input.providerSessionId, title: "Original Conductor" }; },
          };
        },
        async releaseRun(input) { calls.releases.push(input); return true; },
      };
      const { runtime, sessionStore, task, started, achievedTask } = await createAchievedServerTask({
        root,
        manager,
        taskId: `task-server-resume-host-${failurePoint}`,
      });
      const before = sessionStore.readSession({
        taskId: task.taskId,
        sessionId: started.run.conductorSessionId,
        cwd: root,
        maxChars: 0,
      });

      await assert.rejects(
        () => runtime.resumeAchievedTask({
          taskId: task.taskId,
          commandId: `command-resume-host-${failurePoint}`,
          expectedRevision: achievedTask.revision,
        }),
        /loop_achieved_conductor_host_unavailable/,
      );

      const after = sessionStore.readSession({
        taskId: task.taskId,
        sessionId: started.run.conductorSessionId,
        cwd: root,
        maxChars: 0,
      });
      assert.equal(runtime.readTask({ taskId: task.taskId }).status, "achieved");
      assert.equal(runtime.readRun({ runId: started.run.runId }).run.status, "achieved");
      assert.equal(after.providerBinding.providerSessionId, "ses_host_failure_original");
      assert.equal(after.state, before.state, "a Host failure must not overwrite the retained Provider Session fact as blocked");
      assert.equal(calls.create.length, 1, "Host recovery must not create a replacement Provider Session");
      assert.equal(calls.getSession.length, 0, "Host attachment must succeed before an exact Provider Session lookup is attempted");
      assert.ok(calls.releases.length >= 2, "the inactive Run lease is cleaned up after a failed Host attachment");
      runtime.close();
    });
  }
});

async function createAchievedServerTask({ root, manager, taskId }) {
  const sessionStore = createSessionStore({ root: ({ cwd }) => path.join(cwd, ".agent-workspace", "runtime") });
  const runtime = createServerRuntime({
    databasePath: path.join(root, "agent-loop.sqlite"),
    manager,
    capabilities: createSessionStoreCapabilities(sessionStore),
  });
  const template = runtime.saveTemplate(reconnectTemplate());
  const task = runtime.createTask({
    taskId,
    cwd: root,
    title: "Host reattach failure",
    goal: "Keep the original achieved identity when the Host is unavailable.",
    templateId: template.id,
  });
  const started = await runtime.startRun({
    taskId: task.taskId,
    commandId: `command-start-${task.taskId}`,
    expectedRevision: task.revision,
  });
  runtime.recordCompletionClaim({
    taskId: task.taskId,
    sessionId: started.run.conductorSessionId,
    message: "Delivery is accepted.",
  });
  const ready = runtime.readTask({ taskId: task.taskId });
  await runtime.markTaskAchieved({
    taskId: task.taskId,
    commandId: `command-achieve-${task.taskId}`,
    expectedRevision: ready.revision,
  });
  return {
    runtime,
    sessionStore,
    task,
    started,
    achievedTask: runtime.readTask({ taskId: task.taskId }),
  };
}

function createServerRuntime({ databasePath, manager, capabilities, resolveOpenCodeSessionPage, releaseOpenCodeSessionPage } = {}) {
  return createAgentLoopV1Runtime({
    openCodeServerManager: manager,
    sessionStoreCapabilities: capabilities,
    opencodePath: "/mock/opencode",
    databasePath,
    resolveOpenCodeSessionPage,
    releaseOpenCodeSessionPage,
    getConductorBridgeConfig: async () => ({
      conductorToolBridgeUrl: "http://127.0.0.1:5288",
      conductorToolBridgeToken: "test-token",
      conductorMcpServerPath: "/mock/conductor-mcp.cjs",
    }),
  });
}

function reconnectTemplate() {
  return {
    id: "server-reconnect-template",
    name: "Server reconnect template",
    source: "manual",
    conductor: { role: "Conductor", model: "opencode-go/gpt-5.6-luna", charter: "Use durable state before continuing." },
    agents: [
      { id: "researcher", name: "Researcher", kind: "researcher", role: "Find evidence.", instructions: "Cite sources.", expectedOutput: "An evidence memo." },
    ],
    limits: { maxConcurrentSessions: 1, maxDispatchesPerDecision: 1 },
    delivery: { artifactPath: "" },
  };
}

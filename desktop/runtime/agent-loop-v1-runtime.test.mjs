import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createAgentLoopV1Runtime as createAgentLoopV1RuntimeImpl, DEFAULT_MODEL } from "./agent-loop-v1-runtime.cjs";
import { createSessionStore } from "../session-store.cjs";

const isVitest = process.env.VITEST === "true" || process.env.VITEST_WORKER_ID !== undefined;
const testApi = isVitest ? await import("vitest") : await import("node:test");
const { describe, it } = testApi;

// Most tests below exercise Task/Run semantics, not a native terminal. Give
// those narrow doubles an explicit accepted-input adapter while preserving any
// test that provides a real Session Authority input spy of its own.
function createAgentLoopV1Runtime(input) {
  return createAgentLoopV1RuntimeImpl({
    ...input,
    enqueueConductorInput: input?.enqueueConductorInput
      ?? (typeof input?.sessionAuthority?.enqueueInput === "function"
        ? (request) => input.sessionAuthority.enqueueInput(request)
        : async () => ({ disposition: "written", result: { accepted: true } })),
  });
}

describe("Agent Loop v1 runtime", () => {
  it("merges legacy template descriptions into Charter and removes the field from persisted templates and Task snapshots", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-loop-v1-charter-migration-"));
    const databasePath = path.join(root, "runtime.sqlite");
    const legacyDb = new DatabaseSync(databasePath);
    legacyDb.exec(`
      CREATE TABLE agent_loop_template_versions (
        template_id TEXT NOT NULL, version INTEGER NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL, source TEXT NOT NULL,
        conductor_json TEXT NOT NULL, agents_json TEXT NOT NULL, limits_json TEXT NOT NULL, delivery_json TEXT NOT NULL,
        archived_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (template_id, version)
      ) STRICT;
      CREATE TABLE agent_loop_tasks (
        task_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, cwd TEXT NOT NULL, title TEXT NOT NULL, goal TEXT NOT NULL,
        template_id TEXT NOT NULL, template_version INTEGER NOT NULL, architecture_json TEXT NOT NULL, status TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      ) STRICT;
    `);
    const createdAt = "2026-07-29T00:00:00.000Z";
    const agents = [{ id: "researcher", name: "Researcher", kind: "researcher", role: "Find evidence", model: DEFAULT_MODEL, mcp: [], skills: [], instructions: "", expectedOutput: "Evidence" }];
    legacyDb.prepare(`INSERT INTO agent_loop_template_versions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      "legacy-loop", 1, "Legacy loop", "This Template is for independent evidence collection.", "manual",
      JSON.stringify({ role: "Conductor", model: DEFAULT_MODEL, charter: "Compare returned evidence before deciding the next dispatch.", reviewPolicy: "required_before_publish" }),
      JSON.stringify(agents), JSON.stringify({ maxConcurrentSessions: 1, maxDispatchesPerDecision: 1 }), JSON.stringify({ artifactPath: "", ownerAgentId: "" }), null, createdAt, createdAt,
    );
    legacyDb.prepare(`INSERT INTO agent_loop_tasks VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      "legacy-task", "project", root, "Legacy Task", "Use the legacy snapshot.", "legacy-loop", 1,
      JSON.stringify({
        primaryMode: "agent_loop",
        template: { id: "legacy-loop", version: 1, name: "Legacy loop", description: "This Task used the legacy purpose.", conductor: { role: "Conductor", model: DEFAULT_MODEL, charter: "Decide from durable Session returns.", reviewPolicy: "required_before_publish" }, agents, limits: { maxConcurrentSessions: 1, maxDispatchesPerDecision: 1 }, delivery: { artifactPath: "", ownerAgentId: "" } },
        defaultModel: DEFAULT_MODEL,
        agentCards: agents,
        delivery: { artifactPath: "", ownerAgentId: "" },
      }),
      "queued", createdAt, createdAt,
    );
    legacyDb.close();

    const runtime = createAgentLoopV1Runtime({
      opencodePath: "/usr/local/bin/opencode",
      databasePath,
      getConductorBridgeConfig: async () => ({ conductorToolBridgeUrl: "http://127.0.0.1:4567", conductorToolBridgeToken: "test-token", conductorMcpServerPath: "/workspace/desktop/conductor-mcp-server.cjs" }),
      sessionAuthority: { registerLaunchProfile() {}, async activateSession({ workspaceSessionId }) { return { session: { id: workspaceSessionId, status: "running" } }; } },
      ptyManager: { read: () => undefined },
      sessionStore: { recordTaskEvent() {}, readTaskState: () => ({ sessions: [], dispatches: [], results: [], pendingDecisions: [] }) },
    });
    const template = runtime.listTemplates().find((item) => item.id === "legacy-loop");
    assert.equal(Object.hasOwn(template, "description"), false);
    assert.equal(Object.hasOwn(template?.conductor ?? {}, "reviewPolicy"), false);
    assert.equal(template?.conductor.charter, "This Template is for independent evidence collection.\n\nCompare returned evidence before deciding the next dispatch.");
    const task = runtime.readTask({ taskId: "legacy-task" });
    assert.equal(Object.hasOwn(task.architecture.template, "description"), false);
    assert.equal(Object.hasOwn(task.architecture.template.conductor, "reviewPolicy"), false);
    assert.equal(task.architecture.template.conductor.charter, "This Task used the legacy purpose.\n\nDecide from durable Session returns.");
    runtime.close();

    const migratedDb = new DatabaseSync(databasePath);
    assert.equal(migratedDb.prepare("PRAGMA table_info(agent_loop_template_versions)").all().some((column) => column.name === "description"), false);
    assert.equal(Object.hasOwn(JSON.parse(migratedDb.prepare("SELECT conductor_json FROM agent_loop_template_versions WHERE template_id = ?").get("legacy-loop").conductor_json), "reviewPolicy"), false);
    assert.equal(Object.hasOwn(JSON.parse(migratedDb.prepare("SELECT architecture_json FROM agent_loop_tasks WHERE task_id = ?").get("legacy-task").architecture_json).template.conductor, "reviewPolicy"), false);
    migratedDb.close();
  });

  it("records a Conductor delivery claim without imposing a reviewer or publisher route", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-loop-v1-conductor-autonomy-"));
    const runtimeState = { sessions: [], dispatches: [], results: [], pendingDecisions: [] };
    const runtime = createAgentLoopV1Runtime({
      opencodePath: "/usr/local/bin/opencode",
      databasePath: path.join(root, "runtime.sqlite"),
      getConductorBridgeConfig: async () => ({ conductorToolBridgeUrl: "http://127.0.0.1:4567", conductorToolBridgeToken: "test-token", conductorMcpServerPath: "/workspace/desktop/conductor-mcp-server.cjs" }),
      sessionAuthority: { registerLaunchProfile() {}, async activateSession({ workspaceSessionId }) { return { session: { id: workspaceSessionId, status: "running" } }; } },
      ptyManager: { read: () => undefined },
      sessionStore: { recordTaskEvent() {}, readTaskState: () => runtimeState },
    });
    const template = runtime.saveTemplate({
      id: "conductor-autonomy",
      name: "Conductor autonomy",
      source: "manual",
      conductor: { role: "Conductor", model: DEFAULT_MODEL, charter: "Use evidence and user follow-ups; never assume a fixed review route." },
      agents: [
        { id: "researcher", name: "Researcher", kind: "researcher", role: "Find evidence", model: DEFAULT_MODEL, mcp: [], skills: [] },
        { id: "reviewer", name: "Reviewer", kind: "reviewer", role: "Evaluate evidence when useful", model: DEFAULT_MODEL, mcp: [], skills: [] },
      ],
      limits: { maxConcurrentSessions: 2, maxDispatchesPerDecision: 2 },
      delivery: { artifactPath: "docs/final.md", ownerAgentId: "" },
    });
    const task = runtime.createTask({ cwd: root, projectId: "project", taskId: "conductor-autonomy", title: "Autonomous", goal: "Decide the useful work.", templateId: template.id });
    await runtime.startRun({ taskId: task.taskId });
    const researcher = "opencode:project:conductor-autonomy:researcher";
    const reviewer = "opencode:project:conductor-autonomy:reviewer";
    assert.equal(runtime.validateDispatch({ taskId: task.taskId, agentId: "researcher", toSessionId: researcher }).ok, true);
    assert.equal(runtime.validateDispatch({ taskId: task.taskId, agentId: "reviewer", toSessionId: reviewer }).ok, true);
    const delivery = runtime.recordCompletionClaim({ taskId: task.taskId });
    assert.equal(delivery.task.status, "delivery_ready");
    assert.equal(delivery.run.status, "running", "a delivery claim must not close the live logical Run or its PTY attachments");
    // A claim fences the current provider turn. The Task can continue only
    // after a new causal input reaches Conductor, not from another MCP call in
    // the same turn.
    assert.equal(runtime.validateDispatch({ taskId: task.taskId, agentId: "researcher", toSessionId: researcher }).ok, false);
    assert.throws(() => runtime.resumeTaskForDispatch({ taskId: task.taskId }), /loop_task_requires_new_conductor_input/);
    const continued = runtime.resumeTaskForConductorInput({ taskId: task.taskId, cause: "runtime_wakeup", inputId: "wakeup-1" });
    assert.equal(continued.task.status, "running");
    assert.equal(continued.run.status, "running");
    runtime.close();
  });

  it("permits one outstanding assignment per native Session while leaving follow-up routing to Conductor", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-loop-v1-session-occupancy-"));
    const runtimeState = { sessions: [], dispatches: [], results: [], pendingDecisions: [] };
    const runtime = createAgentLoopV1Runtime({
      opencodePath: "/usr/local/bin/opencode",
      databasePath: path.join(root, "runtime.sqlite"),
      getConductorBridgeConfig: async () => ({ conductorToolBridgeUrl: "http://127.0.0.1:4567", conductorToolBridgeToken: "test-token", conductorMcpServerPath: "/workspace/desktop/conductor-mcp-server.cjs" }),
      sessionAuthority: { registerLaunchProfile() {}, async activateSession({ workspaceSessionId }) { return { session: { id: workspaceSessionId, status: "running" } }; } },
      ptyManager: { read: () => undefined },
      sessionStore: { recordTaskEvent() {}, readTaskState: () => runtimeState },
    });
    const template = runtime.saveTemplate({
      id: "session-occupancy",
      name: "Session occupancy",
      source: "manual",
      conductor: { role: "Conductor", model: DEFAULT_MODEL, charter: "Choose every follow-up after the prior outcome." },
      agents: [{ id: "researcher", name: "Researcher", kind: "researcher", role: "Find evidence", model: DEFAULT_MODEL, mcp: [], skills: [] }],
      limits: { maxConcurrentSessions: 1, maxDispatchesPerDecision: 1 },
      delivery: { artifactPath: "", ownerAgentId: "" },
    });
    const task = runtime.createTask({ cwd: root, projectId: "project", taskId: "session-occupancy", title: "Occupancy", goal: "Keep native Session input serialized.", templateId: template.id });
    await runtime.startRun({ taskId: task.taskId });
    const researcher = runtime.resolveAgentSession({ taskId: task.taskId, agentId: "researcher" });

    runtimeState.dispatches.push({ dispatchId: "D00001", toSessionId: researcher.sessionId, status: "delivered" });
    assert.deepEqual(runtime.validateDispatch({ taskId: task.taskId, agentId: "researcher", toSessionId: researcher.sessionId }), {
      ok: false,
      reason: "loop_session_has_outstanding_dispatch",
      activeDispatchId: "D00001",
    });

    runtimeState.dispatches[0].status = "result_available";
    assert.deepEqual(runtime.validateDispatch({ taskId: task.taskId, agentId: "researcher", toSessionId: researcher.sessionId }), { ok: true });
    runtime.close();
  });

  it("resolves a cited Provider result into an immutable direct Session context packet", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-loop-v1-result-context-"));
    const sessionStore = createSessionStore({ root });
    const runtime = createAgentLoopV1Runtime({
      opencodePath: "/usr/local/bin/opencode",
      databasePath: path.join(root, "runtime.sqlite"),
      getConductorBridgeConfig: async () => ({ conductorToolBridgeUrl: "http://127.0.0.1:4567", conductorToolBridgeToken: "test-token", conductorMcpServerPath: "/workspace/desktop/conductor-mcp-server.cjs" }),
      sessionAuthority: { registerLaunchProfile() {}, async activateSession({ workspaceSessionId }) { return { session: { id: workspaceSessionId, status: "running" } }; } },
      ptyManager: { read: () => undefined },
      sessionStore,
    });
    const template = runtime.saveTemplate({
      id: "result-forwarding",
      name: "Result forwarding",
      source: "manual",
      conductor: { role: "Conductor", model: DEFAULT_MODEL, charter: "Dispatch according to evidence." },
      agents: [
        { id: "researcher", name: "Researcher", kind: "researcher", role: "Find evidence", model: DEFAULT_MODEL, mcp: [], skills: [] },
        { id: "writer", name: "Writer", kind: "publisher", role: "Write from selected evidence", model: DEFAULT_MODEL, mcp: [], skills: [] },
      ],
      limits: { maxConcurrentSessions: 2, maxDispatchesPerDecision: 2 },
      delivery: { artifactPath: "", ownerAgentId: "" },
    });
    const task = runtime.createTask({ cwd: root, projectId: "project", taskId: "result-forwarding", title: "Forward exact result", goal: "Pass source evidence without a Conductor rewrite.", templateId: template.id });
    await runtime.startRun({ taskId: task.taskId });
    const researcher = runtime.resolveAgentSession({ taskId: task.taskId, agentId: "researcher" });
    const sourceDispatch = sessionStore.recordDispatch({
      taskId: task.taskId,
      toSessionId: researcher.sessionId,
      agentId: "researcher",
      assignment: "Return one exact fact.",
    });
    const sourceResult = sessionStore.recordDispatchResult({
      taskId: task.taskId,
      sessionId: researcher.sessionId,
      dispatchId: sourceDispatch.dispatchId,
      answerText: "# Evidence\n\nThe cited fact came from the primary source.",
      source: "fixture-provider",
    });

    const prepared = runtime.prepareDispatchContext({
      taskId: task.taskId,
      contextRefs: [`result:${sourceResult.resultId}`],
    });
    assert.deepEqual(prepared.contextRefs, [`result:${sourceResult.resultId}`]);
    assert.deepEqual(prepared.contextPackets, [{
      ref: `result:${sourceResult.resultId}`,
      kind: "provider_result",
      resultId: sourceResult.resultId,
      sourceAgentId: "researcher",
      sourceDispatchId: sourceDispatch.dispatchId,
      answerText: "# Evidence\n\nThe cited fact came from the primary source.",
      createdAt: sourceResult.createdAt,
    }]);
    assert.throws(
      () => runtime.prepareDispatchContext({ taskId: task.taskId, contextRefs: ["result:missing"] }),
      /context_result_not_found/,
    );
    assert.throws(
      () => runtime.prepareDispatchContext({ taskId: task.taskId, contextRefs: ["result-looks-valid-but-is-not-a-reference"] }),
      /context_reference_unsupported/,
    );
    assert.throws(
      () => runtime.prepareDispatchContext({ taskId: task.taskId, contextRefs: "result:wrong-shape" }),
      /context_refs_must_be_array/,
    );
    runtime.close();
  });

  it("keeps Publisher dispatch available to Conductor without a Runtime review prerequisite", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-loop-v1-review-policy-"));
    const profiles = new Map();
    const sessionStore = createSessionStore({ root });
    const runtime = createAgentLoopV1Runtime({
      opencodePath: "/usr/local/bin/opencode",
      databasePath: path.join(root, "runtime.sqlite"),
      getConductorBridgeConfig: async () => ({ conductorToolBridgeUrl: "http://127.0.0.1:4567", conductorToolBridgeToken: "test-token", conductorMcpServerPath: "/workspace/desktop/conductor-mcp-server.cjs" }),
      sessionAuthority: {
        registerLaunchProfile(profile) { profiles.set(profile.workspaceSessionId, profile); },
        async activateSession({ workspaceSessionId }) { return { session: { id: workspaceSessionId, status: "running" } }; },
      },
      ptyManager: { read: () => undefined },
      sessionStore,
    });
    const template = runtime.saveTemplate({
      id: "publisher-without-review-policy",
      name: "Publisher delivery",
      source: "manual",
      conductor: { role: "Conductor", model: DEFAULT_MODEL, charter: "Collect evidence, independently review it when useful, then publish a deliverable." },
      agents: [
        { id: "researcher", name: "Researcher", kind: "researcher", role: "Find evidence", model: DEFAULT_MODEL, mcp: [], skills: [] },
        { id: "reviewer", name: "Reviewer", kind: "reviewer", role: "Review the selected evidence", model: DEFAULT_MODEL, mcp: [], skills: [] },
        { id: "publisher", name: "Publisher", kind: "publisher", role: "Create the deliverable", model: DEFAULT_MODEL, mcp: [], skills: [] },
      ],
      limits: { maxConcurrentSessions: 3, maxDispatchesPerDecision: 3 },
      delivery: { artifactPath: "docs/final.md", ownerAgentId: "publisher" },
    });
    const task = runtime.createTask({ cwd: root, projectId: "project", taskId: "publisher-without-review-policy", title: "Reviewed", goal: "Create a reviewed deliverable.", templateId: template.id });
    assert.equal(Object.hasOwn(task.architecture.template, "description"), false);
    assert.equal(Object.hasOwn(task.architecture.template.conductor, "reviewPolicy"), false);
    await runtime.startRun({ taskId: task.taskId });
    const conductor = runtime.resolveAgentSession({ taskId: task.taskId, agentId: "conductor" });
    const prompt = profiles.get(conductor.sessionId)?.runtimeFiles?.[0]?.contents ?? "";
    assert.doesNotMatch(prompt, /Template purpose:/);
    assert.match(prompt, /Collect evidence, independently review it when useful, then publish a deliverable\./);
    assert.doesNotMatch(prompt, /Template review policy|cited Reviewer result/);

    const publisher = runtime.resolveAgentSession({ taskId: task.taskId, agentId: "publisher" });
    assert.deepEqual(
      runtime.validateDispatch({ taskId: task.taskId, agentId: "publisher", toSessionId: publisher.sessionId, contextRefs: [] }),
      { ok: true },
    );
    runtime.close();
  });

  it("keeps Provider outcome distinct from a still-live native OpenCode terminal", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-loop-v1-status-ownership-"));
    const taskId = "status-ownership";
    const workerSessionId = `opencode:project:${taskId}:researcher`;
    const conductorSessionId = `opencode:project:${taskId}:conductor`;
    let terminalsLive = true;
    const runtime = createAgentLoopV1Runtime({
      opencodePath: "/usr/local/bin/opencode",
      databasePath: path.join(root, "runtime.sqlite"),
      getConductorBridgeConfig: async () => ({ conductorToolBridgeUrl: "http://127.0.0.1:4567", conductorToolBridgeToken: "test-token", conductorMcpServerPath: "/workspace/desktop/conductor-mcp-server.cjs" }),
      sessionAuthority: { registerLaunchProfile() {}, async activateSession({ workspaceSessionId }) { return { session: { id: workspaceSessionId, status: "running" } }; } },
      ptyManager: {
        read(sessionId) {
          return terminalsLive && [workerSessionId, conductorSessionId].includes(sessionId) ? { id: sessionId, status: "running" } : undefined;
        },
      },
      sessionStore: {
        recordTaskEvent() {},
        readTaskState() {
          return {
            sessions: [
              { sessionId: conductorSessionId, state: "waiting_conductor" },
              { sessionId: workerSessionId, state: "result_available" },
            ],
            dispatches: [{ toSessionId: workerSessionId, dispatchId: "ABC123", status: "result_available" }],
            results: [],
            pendingDecisions: [],
          };
        },
        readSession() { return { results: [] }; },
      },
    });
    const task = runtime.createTask({ cwd: root, projectId: "project", taskId, title: "Status ownership", goal: "Keep terminal and Provider facts distinct." });
    const detail = await runtime.startRun({ taskId: task.taskId });
    const worker = detail.turns.find((turn) => turn.nodeId === "researcher");
    assert.equal(worker?.status, "succeeded");
    assert.equal(worker?.dispatchStatus, "result_available");
    assert.equal(worker?.terminalStatus, "live");

    terminalsLive = false;
    const unavailableWorker = runtime.readRun({ runId: detail.run.runId }).turns.find((turn) => turn.nodeId === "researcher");
    assert.equal(unavailableWorker?.dispatchStatus, "result_available");
    assert.equal(unavailableWorker?.terminalStatus, "not_live");
    runtime.close();
  });

  it("restores a historical Run's project Session Store root after an Electron restart", async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-loop-v1-project-"));
    const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-loop-v1-app-"));
    const databasePath = path.join(appRoot, "agent-loop.sqlite");
    const createRuntime = (sessionStore) => createAgentLoopV1Runtime({
      opencodePath: "/usr/local/bin/opencode",
      databasePath,
      getConductorBridgeConfig: async () => ({
        conductorToolBridgeUrl: "http://127.0.0.1:4567",
        conductorToolBridgeToken: "test-token",
        conductorMcpServerPath: "/workspace/desktop/conductor-mcp-server.cjs",
      }),
      sessionAuthority: {
        registerLaunchProfile() {},
        async activateSession({ workspaceSessionId }) { return { session: { id: workspaceSessionId, status: "running" } }; },
      },
      ptyManager: { read: () => undefined },
      sessionStore,
    });
    const rootForTask = ({ cwd }) => path.join(cwd, ".agent-workspace", "runtime");

    const firstStore = createSessionStore({ root: rootForTask });
    const firstRuntime = createRuntime(firstStore);
    const task = firstRuntime.createTask({
      cwd: projectRoot,
      projectId: "project",
      taskId: "restart-safe-task",
      title: "Recover historical run",
      goal: "Read this Run after restart.",
    });
    const started = await firstRuntime.startRun({ taskId: task.taskId });
    firstRuntime.close();

    const restartedStore = createSessionStore({ root: rootForTask });
    const restartedRuntime = createRuntime(restartedStore);
    const restored = restartedRuntime.readRun({ runId: started.run.runId });
    assert.equal(restored?.task.taskId, task.taskId);
    assert.equal(restored?.run.runId, started.run.runId);
    assert.equal(restored?.runtimeState.taskId, task.taskId);
    restartedRuntime.close();
  });

  it("records a user follow-up and wakes the same ready Conductor Session", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-loop-v1-user-message-"));
    const writes = [];
    const taskEvents = [];
    const wakeups = [];
    const sessionStore = {
      recordTaskEvent(event) { taskEvents.push(event); return event; },
      readTaskState({ taskId }) { return { taskId, sessions: [], dispatches: [], results: [], pendingDecisions: [], wakeups }; },
      readSession() { return { state: "waiting_conductor" }; },
      recordState() {},
      recordConductorWakeup(input) {
        const priorIndex = wakeups.findIndex((item) => item.wakeupKey === input.wakeupKey);
        const next = { ...(priorIndex >= 0 ? wakeups[priorIndex] : {}), ...input };
        if (priorIndex >= 0) wakeups[priorIndex] = next;
        else wakeups.push(next);
        return next;
      },
    };
    const runtime = createAgentLoopV1Runtime({
      opencodePath: "/usr/local/bin/opencode",
      databasePath: path.join(root, "runtime.sqlite"),
      getConductorBridgeConfig: async () => ({ conductorToolBridgeUrl: "http://127.0.0.1:4567", conductorToolBridgeToken: "test-token", conductorMcpServerPath: "/workspace/desktop/conductor-mcp-server.cjs" }),
      sessionAuthority: {
        registerLaunchProfile() {},
        async activateSession({ workspaceSessionId }) { return { session: { id: workspaceSessionId, status: "running" } }; },
        async enqueueInput(input) { writes.push(input); return { disposition: "written" }; },
      },
      ptyManager: {
        read: () => undefined,
        get: (sessionId) => ({ id: sessionId, status: "running", incarnationId: "conductor-incarnation" }),
      },
      sessionStore,
    });
    const task = runtime.createTask({ cwd: root, projectId: "project", taskId: "user-message", title: "Follow-up", goal: "Let the user redirect the Conductor." });
    await runtime.startRun({ taskId: task.taskId });
    const result = await runtime.recordUserMessage({ taskId: task.taskId, message: "不要比较 GitHub Copilot，改为核实 ChatGPT Codex。" });
    assert.equal(result.ok, true);
    assert.equal(result.wakeup.delivered, 0);
    assert.equal(result.wakeup.queued, 1);
    assert.equal(result.wakeup.delivery, "conductor_wakeup_awaiting_provider_receipt");
    assert.equal(writes.length, 1, "the launch prompt is submitted by OpenCode TUI; only the live follow-up writes to the PTY");
    assert.equal(writes[0].workspaceSessionId, "opencode:project:user-message:conductor");
    assert.equal(writes[0].source, "user_message");
    assert.match(writes[0].payload, /Conductor Input ID user:user-message:message-/);
    assert.match(writes[0].payload, /ChatGPT Codex/);
    assert.deepEqual(wakeups.map((item) => item.status), ["attempting"]);
    assert.ok(taskEvents.some((event) => event.type === "task.user_message"));

    wakeups[0] = { ...wakeups[0], status: "observed", observedAt: "2026-07-29T21:00:00.000Z" };
    const confirmed = await runtime.flushPendingUserMessages({ taskId: task.taskId });
    assert.deepEqual(confirmed, { delivered: 1, queued: 0, delivery: "provider_receipt" });
    const persisted = new DatabaseSync(path.join(root, "runtime.sqlite"));
    assert.equal(persisted.prepare("SELECT status FROM agent_loop_user_messages WHERE message_id = ?").get(result.messageId).status, "delivered");

    // Pre-receipt builds incorrectly persisted this state as `delivered` while
    // the durable wakeup was only `sent`. Retrying the exact same follow-up
    // must reuse its Input ID and return to receipt-pending rather than create
    // another message that merely looks delivered in the Task timeline.
    wakeups[0] = { ...wakeups[0], status: "sent", observedAt: undefined };
    const retried = await runtime.recordUserMessage({ taskId: task.taskId, message: "不要比较 GitHub Copilot，改为核实 ChatGPT Codex。" });
    assert.equal(retried.retried, true);
    assert.equal(retried.messageId, result.messageId);
    assert.equal(retried.wakeup.delivered, 0);
    assert.equal(retried.wakeup.queued, 1);
    assert.equal(retried.wakeup.delivery, "conductor_wakeup_awaiting_provider_receipt");
    assert.equal(writes.length, 2, "the legacy retry resubmits the same unobserved marker through the live TUI");
    assert.deepEqual(wakeups.map((item) => item.status), ["attempting"]);
    assert.ok(taskEvents.some((event) => event.type === "task.user_message_retrying"));
    assert.equal(persisted.prepare("SELECT status FROM agent_loop_user_messages WHERE message_id = ?").get(result.messageId).status, "pending");
    persisted.close();
    runtime.close();
  });

  it("carries a pre-run user instruction into the first native Conductor input", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-loop-v1-startup-user-message-"));
    const profiles = [];
    const writes = [];
    const wakeups = [];
    const sessionStore = {
      recordTaskEvent(event) { return event; },
      readTaskState({ taskId }) { return { taskId, sessions: [], dispatches: [], results: [], pendingDecisions: [], wakeups }; },
      recordState() {},
      recordConductorWakeup(input) {
        const index = wakeups.findIndex((item) => item.wakeupKey === input.wakeupKey);
        const next = { ...(index >= 0 ? wakeups[index] : {}), ...input };
        if (index >= 0) wakeups[index] = next;
        else wakeups.push(next);
        return next;
      },
    };
    const runtime = createAgentLoopV1Runtime({
      opencodePath: "/usr/local/bin/opencode",
      databasePath: path.join(root, "runtime.sqlite"),
      getConductorBridgeConfig: async () => ({ conductorToolBridgeUrl: "http://127.0.0.1:4567", conductorToolBridgeToken: "test-token", conductorMcpServerPath: "/workspace/desktop/conductor-mcp-server.cjs" }),
      sessionAuthority: {
        registerLaunchProfile(profile) { profiles.push(profile); },
        async activateSession({ workspaceSessionId }) { return { session: { id: workspaceSessionId, status: "running" } }; },
        async enqueueInput(input) { writes.push(input); return { disposition: "written", result: { accepted: true } }; },
      },
      ptyManager: { read: () => undefined },
      sessionStore,
    });
    const task = runtime.createTask({ cwd: root, projectId: "project", taskId: "startup-user-message", title: "Start with instruction", goal: "Honor the first user message." });
    await runtime.recordUserMessage({ taskId: task.taskId, message: "先核实 ChatGPT Codex，不要研究 GitHub Copilot。" });
    await runtime.startRun({ taskId: task.taskId });

    assert.equal(profiles.length, 1);
    assert.equal(profiles[0].args[0], "--agent");
    assert.ok(profiles[0].args.includes("--prompt"));
    assert.ok(!profiles[0].args.includes("run"), "the launch profile must start OpenCode's TUI, not one-shot run mode");
    assert.equal(writes.length, 0);
    assert.match(profiles[0].args.at(-1), /Conductor Input ID user:startup-user-message:message-/);
    assert.match(profiles[0].args.at(-1), /ChatGPT Codex/);
    assert.deepEqual(wakeups.map((item) => item.status), ["attempting"]);
    runtime.close();
  });

  it("continues a reaped Run from Send without exposing a separate recovery action", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-loop-v1-conductor-restart-"));
    const activationOperations = [];
    const profiles = [];
    const writes = [];
    const wakeups = [];
    let conductorLive = false;
    let providerSessionId;
    const sessionStore = {
      recordTaskEvent(event) { return event; },
      readTaskState({ taskId }) {
        return {
          taskId,
          sessions: [], dispatches: [], results: [], pendingDecisions: [], wakeups,
          events: providerSessionId ? [{ sessionId: "opencode:project:conductor-restart:conductor", data: { provider: "opencode", providerSessionId } }] : [],
        };
      },
      readSession() { return { state: "waiting_conductor" }; },
      recordState() {},
      recordConductorWakeup(input) {
        const index = wakeups.findIndex((item) => item.wakeupKey === input.wakeupKey);
        const next = { ...(index >= 0 ? wakeups[index] : {}), ...input };
        if (index >= 0) wakeups[index] = next;
        else wakeups.push(next);
        return next;
      },
    };
    const runtime = createAgentLoopV1Runtime({
      opencodePath: "/usr/local/bin/opencode",
      databasePath: path.join(root, "runtime.sqlite"),
      getConductorBridgeConfig: async () => ({ conductorToolBridgeUrl: "http://127.0.0.1:4567", conductorToolBridgeToken: "test-token", conductorMcpServerPath: "/workspace/desktop/conductor-mcp-server.cjs" }),
      sessionAuthority: {
        registerLaunchProfile(profile) { profiles.push(profile); },
        async activateSession({ workspaceSessionId, operationId }) {
          activationOperations.push(operationId);
          conductorLive = true;
          return { session: { id: workspaceSessionId, status: "running" } };
        },
        async enqueueInput(input) { writes.push(input); return { disposition: "written", result: { accepted: true } }; },
      },
      ptyManager: {
        read: () => undefined,
        get: (sessionId) => conductorLive ? { id: sessionId, status: "running", incarnationId: "incarnation" } : undefined,
      },
      sessionStore,
    });
    const task = runtime.createTask({ cwd: root, projectId: "project", taskId: "conductor-restart", title: "Restore Conductor", goal: "Do not replay a dead activation." });
    await runtime.startRun({ taskId: task.taskId });
    providerSessionId = "ses-conductor-original";
    conductorLive = false;
    const continued = await runtime.recordUserMessage({ taskId: task.taskId, message: "基于现有结果继续核实。" });

    assert.equal(continued.wakeup.delivery, "conductor_recovery_awaiting_provider_receipt");
    assert.equal(continued.wakeup.delivered, 0);
    assert.equal(continued.wakeup.queued, 1);
    assert.equal(activationOperations.length, 2);
    assert.notEqual(activationOperations[0], activationOperations[1]);
    assert.match(activationOperations[0], /^conductor:run-/);
    assert.match(activationOperations[1], /^conductor:run-/);
    assert.equal(profiles.length, 2);
    assert.deepEqual(profiles[1].args.slice(0, 4), [
      "--agent",
      "agent_workspace_conductor",
      "--session",
      "ses-conductor-original",
    ]);
    assert.ok(!profiles[1].args.includes("--prompt"), "OpenCode only auto-submits --prompt on its new-session route");
    assert.ok(!profiles[1].args.includes("run"));
    assert.equal(writes.length, 0, "Run recovery must not race SessionWakeupMonitor with a duplicate raw PTY write");
    assert.equal(wakeups[0]?.status, "attempting", "the durable input remains owned by the monitor until an interactive TUI accepts it");
    assert.equal(runtime.readTask({ taskId: task.taskId }).latestRun.status, "running");
    assert.equal(runtime.readRun({ runId: runtime.readTask({ taskId: task.taskId }).latestRun.runId }).continuity.state, "connected");
    runtime.close();
  });

  it("restores the current Conductor automatically when a durable Worker wakeup finds its PTY exited", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-loop-v1-worker-wakeup-recovery-"));
    const profiles = [];
    const states = [];
    let conductorLive = false;
    let providerSessionId;
    const sessionStore = {
      recordTaskEvent(event) { return event; },
      readTaskState({ taskId }) {
        return {
          taskId,
          sessions: [], dispatches: [], results: [], pendingDecisions: [], wakeups: [],
          events: providerSessionId
            ? [{ sessionId: "opencode:project:worker-wakeup-recovery:conductor", data: { provider: "opencode", providerSessionId } }]
            : [],
        };
      },
      recordState(input, state, summary, data) {
        states.push({ input, state, summary, data });
      },
    };
    const runtime = createAgentLoopV1Runtime({
      opencodePath: "/usr/local/bin/opencode",
      databasePath: path.join(root, "runtime.sqlite"),
      getConductorBridgeConfig: async () => ({ conductorToolBridgeUrl: "http://127.0.0.1:4567", conductorToolBridgeToken: "test-token", conductorMcpServerPath: "/workspace/desktop/conductor-mcp-server.cjs" }),
      sessionAuthority: {
        registerLaunchProfile(profile) { profiles.push(profile); },
        async activateSession({ workspaceSessionId }) {
          conductorLive = true;
          return { session: { id: workspaceSessionId, status: "running" } };
        },
      },
      ptyManager: {
        read: () => undefined,
        get: (sessionId) => conductorLive ? { id: sessionId, status: "running", incarnationId: "incarnation" } : undefined,
      },
      sessionStore,
    });
    const task = runtime.createTask({
      cwd: root,
      projectId: "project",
      taskId: "worker-wakeup-recovery",
      title: "Restore from Worker result",
      goal: "Deliver a completed Worker result without waiting for another user message.",
    });
    await runtime.startRun({ taskId: task.taskId });
    providerSessionId = "ses-conductor-original";
    conductorLive = false;

    const conductor = runtime.resolveAgentSession({ taskId: task.taskId, agentId: "conductor" });
    const recovered = await runtime.ensureConductorWakeupTarget({
      taskId: task.taskId,
      sessionId: conductor.sessionId,
    });

    assert.equal(recovered?.status, "running");
    assert.equal(profiles.length, 2);
    assert.deepEqual(profiles[1].args.slice(0, 4), [
      "--agent",
      "agent_workspace_conductor",
      "--session",
      "ses-conductor-original",
    ]);
    assert.equal(profiles[1].args.includes("--prompt"), false);
    assert.equal(states.at(-1)?.state, "waiting_conductor");
    assert.equal(states.at(-1)?.data?.source, "worker_result_wakeup");
    assert.equal(runtime.readTask({ taskId: task.taskId }).latestRun.status, "running");
    runtime.close();
  });

  it("settles persisted cancellations before Send restores a reaped Conductor", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-loop-v1-cancellation-continuation-"));
    const profiles = [];
    const wakeups = [];
    const reconciliations = [];
    let conductorLive = false;
    let cancellationSettled = false;
    const sessionStore = {
      recordTaskEvent(event) { return event; },
      readTaskState({ taskId }) {
        return {
          taskId,
          sessions: [],
          dispatches: cancellationSettled ? [{ dispatchId: "D-cancelled", status: "cancelled" }] : [{ dispatchId: "D-cancelled", status: "cancellation_requested" }],
          results: [],
          pendingDecisions: [],
          wakeups,
          events: [],
        };
      },
      readSession() { return { state: "waiting_conductor" }; },
      recordState() {},
      recordConductorWakeup(input) {
        const index = wakeups.findIndex((item) => item.wakeupKey === input.wakeupKey);
        if (index >= 0) wakeups[index] = { ...wakeups[index], ...input };
        else wakeups.push(input);
      },
    };
    const runtime = createAgentLoopV1Runtime({
      opencodePath: "/usr/local/bin/opencode",
      databasePath: path.join(root, "runtime.sqlite"),
      getConductorBridgeConfig: async () => ({ conductorToolBridgeUrl: "http://127.0.0.1:4567", conductorToolBridgeToken: "test-token", conductorMcpServerPath: "/workspace/desktop/conductor-mcp-server.cjs" }),
      reconcileTaskCancellations: async ({ taskId }) => {
        reconciliations.push(taskId);
        cancellationSettled = true;
        return [{ dispatchId: "D-cancelled", status: "cancelled" }];
      },
      sessionAuthority: {
        registerLaunchProfile(profile) {
          if (profiles.length) assert.equal(cancellationSettled, true, "the recovered Conductor must never read a stale cancellation");
          profiles.push(profile);
        },
        async activateSession({ workspaceSessionId }) {
          conductorLive = true;
          return { session: { id: workspaceSessionId, status: "running" } };
        },
      },
      ptyManager: {
        read: () => undefined,
        get: (sessionId) => conductorLive ? { id: sessionId, status: "running", incarnationId: "incarnation" } : undefined,
      },
      sessionStore,
    });
    const task = runtime.createTask({ cwd: root, projectId: "project", taskId: "cancellation-continuation", title: "Continue cancellation", goal: "Use settled terminal facts before deciding." });
    await runtime.startRun({ taskId: task.taskId });
    conductorLive = false;

    const result = await runtime.recordUserMessage({ taskId: task.taskId, message: "继续当前任务。" });

    assert.equal(result.wakeup.delivery, "conductor_recovery_awaiting_provider_receipt");
    assert.deepEqual(reconciliations, [task.taskId]);
    assert.equal(profiles.length, 2);
    runtime.close();
  });

  it("does not leave a Task running when the initial native Conductor Session fails to start", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-loop-v1-startup-failure-"));
    let startSucceeds = false;
    const runtime = createAgentLoopV1Runtime({
      opencodePath: "/usr/local/bin/opencode",
      databasePath: path.join(root, "runtime.sqlite"),
      getConductorBridgeConfig: async () => ({ conductorToolBridgeUrl: "http://127.0.0.1:4567", conductorToolBridgeToken: "test-token", conductorMcpServerPath: "/workspace/desktop/conductor-mcp-server.cjs" }),
      sessionAuthority: {
        registerLaunchProfile() {},
        async activateSession({ workspaceSessionId }) {
          return { session: { id: workspaceSessionId, status: startSucceeds ? "running" : "failed" } };
        },
      },
      ptyManager: { read: () => undefined },
      sessionStore: { recordTaskEvent() {}, readTaskState: () => ({ sessions: [], dispatches: [], results: [], pendingDecisions: [], wakeups: [] }) },
    });
    const task = runtime.createTask({ cwd: root, projectId: "project", taskId: "startup-failure", title: "Retryable startup", goal: "Show an initial launch failure honestly." });
    await assert.rejects(() => runtime.startRun({ taskId: task.taskId }), /conductor_session_not_started/);
    assert.equal(runtime.readTask({ taskId: task.taskId }).status, "queued");

    startSucceeds = true;
    const retry = await runtime.startRun({ taskId: task.taskId });
    assert.equal(retry.task.status, "running");
    runtime.close();
  });

  it("registers the Conductor with the Provider hook before its native profile starts", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-loop-v1-provider-hook-"));
    const profiles = [];
    const registrations = [];
    const providerEvents = [];
    const runtime = createAgentLoopV1Runtime({
      opencodePath: "/usr/local/bin/opencode",
      databasePath: path.join(root, "runtime.sqlite"),
      getConductorBridgeConfig: async () => ({ conductorToolBridgeUrl: "http://127.0.0.1:4567", conductorToolBridgeToken: "test-token", conductorMcpServerPath: "/workspace/desktop/conductor-mcp-server.cjs" }),
      sessionAuthority: {
        registerLaunchProfile(profile) { profiles.push(profile); },
        async activateSession({ workspaceSessionId }) { return { session: { id: workspaceSessionId, status: "running" } }; },
      },
      ptyManager: { read: () => undefined },
      sessionStore: { recordTaskEvent() {}, readTaskState: () => ({ sessions: [], dispatches: [], results: [], pendingDecisions: [], wakeups: [] }) },
      openCodeHookService: {
        async registerSession(registration) { registrations.push(registration); return { env: { AGENT_WORKSPACE_HOOK_TOKEN: "hook-token" } }; },
      },
      onProviderHookEvent: (event) => providerEvents.push(event),
    });
    const task = runtime.createTask({ cwd: root, projectId: "project", taskId: "provider-hook", title: "Provider hook", goal: "Observe permissions." });
    await runtime.startRun({ taskId: task.taskId });

    assert.equal(registrations.length, 1);
    assert.equal(profiles[0].env.AGENT_WORKSPACE_HOOK_TOKEN, "hook-token");
    await registrations[0].onEvent({ sessionId: registrations[0].sessionId, kind: "permission", payload: { requestID: "permission-1" } });
    assert.equal(providerEvents.length, 1);
    assert.equal(providerEvents[0].kind, "permission");
    runtime.close();
  });

  it("retains a Task-page permission choice and restores the same Publisher Provider session after Electron restart", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-loop-v1-permission-recovery-"));
    const store = createSessionStore({ root });
    const profiles = [];
    const activations = [];
    const runtime = createAgentLoopV1Runtime({
      opencodePath: "/usr/local/bin/opencode",
      databasePath: path.join(root, "runtime.sqlite"),
      getConductorBridgeConfig: async () => ({ conductorToolBridgeUrl: "http://127.0.0.1:4567", conductorToolBridgeToken: "test-token", conductorMcpServerPath: "/workspace/desktop/conductor-mcp-server.cjs" }),
      sessionAuthority: {
        registerLaunchProfile(profile) { profiles.push(profile); return profile; },
        async activateSession(input) {
          activations.push(input);
          return { session: { id: input.workspaceSessionId, status: "running" } };
        },
      },
      ptyManager: { read: () => undefined, get: () => undefined },
      sessionStore: store,
      respondToPermission: async () => ({ ok: false, status: "requested", errorCode: "permission_reply_transport_unavailable" }),
    });
    const template = runtime.saveTemplate({
      id: "permission-recovery-loop",
      name: "Permission recovery loop",
      source: "manual",
      conductor: { role: "Conductor", model: DEFAULT_MODEL, charter: "Choose the next bounded Session work." },
      agents: [{ id: "publisher", name: "Publisher", kind: "publisher", role: "Build the approved deliverable.", model: DEFAULT_MODEL, mcp: [], skills: [], instructions: "", expectedOutput: "Deliverable" }],
      limits: { maxConcurrentSessions: 1, maxDispatchesPerDecision: 1 },
      delivery: { artifactPath: "" },
    });
    const task = runtime.createTask({ cwd: root, projectId: "project", taskId: "permission-recovery-task", title: "Permission recovery", goal: "Resume the publisher permission.", templateId: template.id });
    await runtime.startRun({ taskId: task.taskId });
    const run = runtime.readTask({ taskId: task.taskId }).latestRun;
    const publisherSessionId = Object.entries(runtime.taskAgentMap({ taskId: task.taskId })).find(([, agentId]) => agentId === "publisher")?.[0];
    assert.ok(publisherSessionId);
    store.startSession({ taskId: task.taskId, sessionId: publisherSessionId, command: "opencode", cwd: root });
    store.recordState({ taskId: task.taskId, sessionId: publisherSessionId, cwd: root }, "permission_required", "OpenCode 正在等待授权。", { provider: "opencode", providerSessionId: "ses-publisher-before-restart" });
    store.recordPermissionRequested({
      taskId: task.taskId,
      sessionId: publisherSessionId,
      cwd: root,
      permissionId: "opencode:publisher-write",
      requestId: "publisher-write",
      provider: "opencode",
      permission: "external_directory",
      patterns: ["/tmp/report"],
      summary: "OpenCode 请求写入报告。",
    });

    const response = await runtime.respondPermission({ taskId: task.taskId, sessionId: publisherSessionId, permissionId: "opencode:publisher-write", response: "once" });

    assert.deepEqual(response, {
      ok: true,
      status: "recovery_pending",
      changed: true,
      recovery: { sessionId: publisherSessionId, role: "publisher", providerSessionId: "ses-publisher-before-restart" },
    });
    const publisherProfile = profiles.find((profile) => profile.workspaceSessionId === publisherSessionId);
    assert.ok(publisherProfile?.args.includes("--session"));
    assert.ok(publisherProfile?.args.includes("ses-publisher-before-restart"));
    assert.ok(activations.some((activation) => activation.workspaceSessionId === publisherSessionId && activation.reason === "permission-response-recovery"));
    const permission = store.readSession({ taskId: task.taskId, sessionId: publisherSessionId }).permissions[0];
    assert.equal(permission.status, "recovery_pending");
    assert.equal(permission.response, "once");
    runtime.close();
  });

  it("writes a Task-page native question answer to exactly its owned live Session once", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-loop-v1-task-question-"));
    const store = createSessionStore({ root });
    const interactiveSubmissions = [];
    const runtime = createAgentLoopV1Runtime({
      opencodePath: "/usr/local/bin/opencode",
      databasePath: path.join(root, "runtime.sqlite"),
      getConductorBridgeConfig: async () => ({ conductorToolBridgeUrl: "http://127.0.0.1:4567", conductorToolBridgeToken: "test-token", conductorMcpServerPath: "/workspace/desktop/conductor-mcp-server.cjs" }),
      sessionAuthority: {
        registerLaunchProfile() {},
        async activateSession({ workspaceSessionId }) { return { session: { id: workspaceSessionId, status: "running" } }; },
      },
      ptyManager: { read: () => undefined, get: () => ({ status: "running", incarnationId: "inc-question-1" }) },
      sessionStore: store,
      enqueueConductorInteractiveSubmission: async (input) => {
        interactiveSubmissions.push(input);
        return { disposition: "written", result: { accepted: true } };
      },
    });
    const task = runtime.createTask({ cwd: root, projectId: "project", taskId: "native-question", title: "Native question", goal: "Reply only to the asking Session." });
    const started = await runtime.startRun({ taskId: task.taskId });
    const sessionId = started.run.conductorSessionId;
    store.startSession({ taskId: task.taskId, sessionId, command: "opencode", cwd: root });
    store.recordState({ taskId: task.taskId, sessionId, cwd: root }, "waiting_input", "OpenCode asks for a confirmation.", {
      provider: "opencode",
      providerSessionId: "ses-native-question",
      providerQuestionPartId: "question-native-1",
      terminalIncarnationId: "inc-question-1",
      question: "Confirm the output path?",
    });

    const first = await runtime.respondSessionQuestion({ taskId: task.taskId, sessionId, questionId: "question-native-1", answer: "Confirmed." });
    const repeated = await runtime.respondSessionQuestion({ taskId: task.taskId, sessionId, questionId: "question-native-1", answer: "This must not be resent." });

    assert.deepEqual(first, { ok: true, status: "submitted", changed: true });
    assert.deepEqual(repeated, { ok: true, status: "submitted", changed: false });
    assert.deepEqual(interactiveSubmissions, [{
      workspaceSessionId: sessionId,
      expectedIncarnationId: "inc-question-1",
      source: "task_question_answer",
      text: "Confirmed.",
      idempotencyKey: `task-question-answer:${task.taskId}:${sessionId}:question-native-1`,
    }]);
    const receipt = store.readQuestionResponse({ taskId: task.taskId, sessionId, cwd: root, questionId: "question-native-1" });
    assert.equal(receipt?.answer, "Confirmed.");
    assert.equal(receipt?.status, "submitted");
    assert.equal(store.readTaskState({ taskId: task.taskId }).sessions.find((session) => session.sessionId === sessionId)?.state, "running");
    const staleQuestion = await runtime.respondSessionQuestion({ taskId: task.taskId, sessionId, questionId: "question-native-stale", answer: "No route." });
    assert.deepEqual(staleQuestion, { ok: false, status: "running", errorCode: "session_not_waiting_input" });
    runtime.close();
  });

  it("rejects a historical native question after the logical Session moved to a new PTY incarnation", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-loop-v1-task-question-stale-terminal-"));
    const store = createSessionStore({ root });
    const interactiveSubmissions = [];
    const runtime = createAgentLoopV1Runtime({
      opencodePath: "/usr/local/bin/opencode",
      databasePath: path.join(root, "runtime.sqlite"),
      getConductorBridgeConfig: async () => ({ conductorToolBridgeUrl: "http://127.0.0.1:4567", conductorToolBridgeToken: "test-token", conductorMcpServerPath: "/workspace/desktop/conductor-mcp-server.cjs" }),
      sessionAuthority: {
        registerLaunchProfile() {},
        async activateSession({ workspaceSessionId }) { return { session: { id: workspaceSessionId, status: "running" } }; },
      },
      ptyManager: { read: () => undefined, get: () => ({ status: "running", incarnationId: "incarnation-after-restart" }) },
      sessionStore: store,
      enqueueConductorInteractiveSubmission: async (input) => {
        interactiveSubmissions.push(input);
        return { disposition: "written", result: { accepted: true } };
      },
    });
    const task = runtime.createTask({ cwd: root, projectId: "project", taskId: "historical-question", title: "Historical question", goal: "Never answer an old terminal modal." });
    const started = await runtime.startRun({ taskId: task.taskId });
    const sessionId = started.run.conductorSessionId;
    store.startSession({ taskId: task.taskId, sessionId, command: "opencode", cwd: root });
    store.recordState({ taskId: task.taskId, sessionId, cwd: root }, "waiting_input", "Old OpenCode prompt.", {
      provider: "opencode",
      providerSessionId: "ses-historical-question",
      providerQuestionPartId: "question-before-restart",
      terminalIncarnationId: "incarnation-before-restart",
      question: "Was the file copied?",
    });

    const result = await runtime.respondSessionQuestion({ taskId: task.taskId, sessionId, questionId: "question-before-restart", answer: "Yes." });

    assert.deepEqual(result, { ok: false, status: "waiting_input", errorCode: "question_terminal_changed" });
    assert.deepEqual(interactiveSubmissions, []);
    assert.equal(store.readQuestionResponse({ taskId: task.taskId, sessionId, cwd: root, questionId: "question-before-restart" }), undefined);
    runtime.close();
  });

  it("does not dispatch into a Publisher while its recovered permission reply is pending", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-loop-v1-permission-dispatch-fence-"));
    const store = createSessionStore({ root });
    const runtime = createAgentLoopV1Runtime({
      opencodePath: "/usr/local/bin/opencode",
      databasePath: path.join(root, "runtime.sqlite"),
      getConductorBridgeConfig: async () => ({ conductorToolBridgeUrl: "http://127.0.0.1:4567", conductorToolBridgeToken: "test-token", conductorMcpServerPath: "/workspace/desktop/conductor-mcp-server.cjs" }),
      sessionAuthority: {
        registerLaunchProfile() {},
        async activateSession({ workspaceSessionId }) { return { session: { id: workspaceSessionId, status: "running" } }; },
      },
      ptyManager: { read: () => undefined, get: () => undefined },
      sessionStore: store,
    });
    const task = runtime.createTask({ cwd: root, projectId: "project", taskId: "permission-dispatch-fence", title: "Permission dispatch fence", goal: "Keep a recovered Publisher terminal reserved for its permission answer." });
    await runtime.startRun({ taskId: task.taskId });
    const publisherSessionId = Object.entries(runtime.taskAgentMap({ taskId: task.taskId })).find(([, agentId]) => agentId === "publisher")?.[0];
    assert.ok(publisherSessionId);
    store.startSession({ taskId: task.taskId, sessionId: publisherSessionId, command: "opencode", cwd: root });
    store.recordPermissionRequested({
      taskId: task.taskId,
      sessionId: publisherSessionId,
      cwd: root,
      permissionId: "opencode:publisher-copy",
      requestId: "publisher-copy",
      provider: "opencode",
      permission: "external_directory",
      patterns: ["/tmp/report"],
      summary: "OpenCode requests delivery access.",
    });
    store.recordPermissionRecoveryPending({
      taskId: task.taskId,
      sessionId: publisherSessionId,
      cwd: root,
      permissionId: "opencode:publisher-copy",
      response: "once",
    });

    assert.deepEqual(
      runtime.validateDispatch({ taskId: task.taskId, agentId: "publisher", toSessionId: publisherSessionId }),
      { ok: false, reason: "loop_session_permission_decision_pending", permissionId: "opencode:publisher-copy" },
    );

    store.recordPermissionResolved({
      taskId: task.taskId,
      sessionId: publisherSessionId,
      cwd: root,
      permissionId: "opencode:publisher-copy",
      response: "once",
    });
    assert.deepEqual(runtime.validateDispatch({ taskId: task.taskId, agentId: "publisher", toSessionId: publisherSessionId }), { ok: true });
    runtime.close();
  });

  it("rehydrates a saved permission answer after a second Main-process restart before OpenCode reissues it", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-loop-v1-permission-startup-recovery-"));
    const databasePath = path.join(root, "runtime.sqlite");
    const firstStore = createSessionStore({ root });
    const firstRuntime = createAgentLoopV1Runtime({
      opencodePath: "/usr/local/bin/opencode",
      databasePath,
      getConductorBridgeConfig: async () => ({ conductorToolBridgeUrl: "http://127.0.0.1:4567", conductorToolBridgeToken: "test-token", conductorMcpServerPath: "/workspace/desktop/conductor-mcp-server.cjs" }),
      sessionAuthority: { registerLaunchProfile() {}, async activateSession({ workspaceSessionId }) { return { session: { id: workspaceSessionId, status: "running" } }; } },
      ptyManager: { read: () => undefined, get: () => undefined },
      sessionStore: firstStore,
    });
    const template = firstRuntime.saveTemplate({
      id: "permission-startup-recovery-loop",
      name: "Permission startup recovery loop",
      source: "manual",
      conductor: { role: "Conductor", model: DEFAULT_MODEL, charter: "Keep user-owned Provider permission decisions separate from orchestration." },
      agents: [{ id: "publisher", name: "Publisher", kind: "publisher", role: "Build the approved deliverable.", model: DEFAULT_MODEL, mcp: [], skills: [], instructions: "", expectedOutput: "Deliverable" }],
      limits: { maxConcurrentSessions: 1, maxDispatchesPerDecision: 1 },
      delivery: { artifactPath: "" },
    });
    const task = firstRuntime.createTask({ cwd: root, projectId: "project", taskId: "permission-startup-recovery-task", title: "Permission startup recovery", goal: "Resume the saved permission reply after another restart.", templateId: template.id });
    await firstRuntime.startRun({ taskId: task.taskId });
    const publisherSessionId = Object.entries(firstRuntime.taskAgentMap({ taskId: task.taskId })).find(([, agentId]) => agentId === "publisher")?.[0];
    assert.ok(publisherSessionId);
    firstStore.startSession({ taskId: task.taskId, sessionId: publisherSessionId, command: "opencode", cwd: root });
    firstStore.recordState({ taskId: task.taskId, sessionId: publisherSessionId, cwd: root }, "permission_required", "已保留授权答复；正在恢复原生 Session。", { provider: "opencode", providerSessionId: "ses-publisher-restart-chain" });
    firstStore.recordPermissionRequested({
      taskId: task.taskId,
      sessionId: publisherSessionId,
      cwd: root,
      permissionId: "opencode:publisher-write-before-second-restart",
      requestId: "publisher-write-before-second-restart",
      provider: "opencode",
      permission: "external_directory",
      patterns: ["/tmp/report"],
      summary: "OpenCode 请求写入报告。",
    });
    firstStore.recordPermissionRecoveryPending({
      taskId: task.taskId,
      sessionId: publisherSessionId,
      cwd: root,
      permissionId: "opencode:publisher-write-before-second-restart",
      response: "once",
    });
    firstRuntime.close();

    // A fresh Store and Runtime model a new Electron Main process. No stale
    // in-memory reply endpoint or old Runtime object is available here.
    const restartedStore = createSessionStore({ root });
    const profiles = [];
    const activations = [];
    const restartedRuntime = createAgentLoopV1Runtime({
      opencodePath: "/usr/local/bin/opencode",
      databasePath,
      getConductorBridgeConfig: async () => ({ conductorToolBridgeUrl: "http://127.0.0.1:4567", conductorToolBridgeToken: "test-token", conductorMcpServerPath: "/workspace/desktop/conductor-mcp-server.cjs" }),
      sessionAuthority: {
        registerLaunchProfile(profile) { profiles.push(profile); },
        async activateSession(input) {
          activations.push(input);
          return { session: { id: input.workspaceSessionId, status: "running" } };
        },
      },
      ptyManager: { read: () => undefined, get: () => undefined },
      sessionStore: restartedStore,
    });

    const [firstScan, concurrentScan] = await Promise.all([
      restartedRuntime.resumePendingPermissionRecoveries(),
      restartedRuntime.resumePendingPermissionRecoveries(),
    ]);

    assert.equal(firstScan.attempted, 1);
    assert.equal(concurrentScan.attempted, 1);
    assert.equal(firstScan.failed.length, 0);
    assert.equal(concurrentScan.failed.length, 0);
    assert.equal(profiles.length, 1, "concurrent startup scans must restore one physical Publisher TUI");
    assert.equal(activations.length, 1, "one logical Publisher Session receives one activation");
    assert.equal(activations[0].reason, "permission-response-recovery");
    assert.ok(profiles[0].args.includes("--session"));
    assert.equal(profiles[0].args[profiles[0].args.indexOf("--session") + 1], "ses-publisher-restart-chain");
    const restoredPermission = restartedStore.readSession({ taskId: task.taskId, sessionId: publisherSessionId }).permissions[0];
    assert.equal(restoredPermission.status, "recovery_pending");
    assert.equal(restoredPermission.response, "once");
    restartedRuntime.close();
  });

  it("snapshots editable Session Agent cards and launches only a modified Conductor", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-loop-v1-"));
    const profiles = new Map();
    const activations = [];
    const taskEvents = [];
    let runtimeState = { sessions: [], dispatches: [], results: [], pendingDecisions: [] };
    const runtime = createAgentLoopV1Runtime({
      opencodePath: "/usr/local/bin/opencode",
      databasePath: path.join(root, "runtime.sqlite"),
      getConductorBridgeConfig: async () => ({
        conductorToolBridgeUrl: "http://127.0.0.1:4567",
        conductorToolBridgeToken: "test-token",
        conductorMcpServerPath: "/workspace/desktop/conductor-mcp-server.cjs",
      }),
      generateTemplateFromBrief: async () => ({
        template: {
          id: "generated-research",
          name: "Generated research",
          source: "generated",
          conductor: { role: "Conductor", model: DEFAULT_MODEL },
          agents: [{ id: "researcher", name: "Researcher", role: "Research", model: DEFAULT_MODEL, mcp: [], skills: [] }],
          limits: { maxConcurrentSessions: 1, maxDispatchesPerDecision: 1 },
          delivery: { artifactPath: "docs/generated.md" },
        },
        assistantMessage: "Generated.",
        assumptions: ["one card"],
      }),
      sessionAuthority: {
        registerLaunchProfile(profile) {
          profiles.set(profile.workspaceSessionId, profile);
          return profile;
        },
        async activateSession(input) {
          activations.push(input);
          return { session: { id: input.workspaceSessionId, status: "running", transcript: [] } };
        },
      },
      ptyManager: { read: () => undefined },
      sessionStore: {
        recordTaskEvent(event) {
          taskEvents.push(event);
          return event;
        },
        readTaskState() {
          return runtimeState;
        },
      },
    });

    const seed = runtime.listTemplates()[0];
    assert.equal(seed.conductor.model, DEFAULT_MODEL);
    assert.deepEqual(seed.agents[0].mcp, []);
    assert.deepEqual(seed.agents[0].skills, []);
    const generatedDraft = await runtime.generateTemplateDraft({ cwd: root, brief: "一句话生成一个调研模板。" });
    assert.equal(generatedDraft.template.source, "generated");
    assert.equal(generatedDraft.template.delivery.artifactPath, "docs/generated.md");

    const task = runtime.createTask({
      cwd: root,
      projectId: "project",
      taskId: "research-task",
      title: "Research only",
      goal: "Produce Markdown evidence first.",
      templateId: seed.id,
      templateVersion: seed.version,
    });
    assert.equal(task.architecture.primaryMode, "agent_loop");
    assert.equal(task.architecture.template.version, 1);

    const revised = runtime.saveTemplate({
      ...seed,
      agents: seed.agents.map((card) => card.id === "researcher" ? { ...card, model: "opencode-go/deepseek-v4-flash", mcp: ["web"], skills: ["research"] } : card),
    });
    assert.equal(revised.version, 2);
    assert.equal(runtime.readTask({ taskId: task.taskId }).architecture.template.version, 1);
    assert.throws(() => runtime.deleteTemplate({ templateId: seed.id }), /referenced/);

    const detail = await runtime.startRun({ taskId: task.taskId });
    assert.equal(detail.run.status, "running");
    assert.equal(activations.length, 1);
    assert.deepEqual(detail.turns.map((turn) => turn.nodeId), ["conductor"]);
    assert.deepEqual(detail.workbenchLayout.groups.primary.sessionIds, ["opencode:project:research-task:conductor"]);
    const conductor = profiles.get("opencode:project:research-task:conductor");
    const workerSessionId = "opencode:project:research-task:researcher";
    const worker = profiles.get(workerSessionId);
    assert.ok(conductor?.env?.OPENCODE_CONFIG_CONTENT);
    assert.equal(conductor?.env?.OPENCODE_PATH, "/usr/local/bin/opencode");
    assert.ok(conductor?.env?.PATH?.split(path.delimiter).includes("/usr/local/bin"));
    assert.equal(conductor?.env?.AGENT_WORKSPACE_HOOK_SESSION_ID, undefined);
    assert.ok(conductor?.runtimeFiles?.[0]?.contents.includes("call_sessions"));
    assert.ok(conductor?.runtimeFiles?.[0]?.contents.includes("Native MCP scope: all provider-native MCP"));
    assert.ok(conductor?.runtimeFiles?.[0]?.contents.includes("Task lifecycle is outside your authority"));
    assert.ok(conductor?.runtimeFiles?.[0]?.contents.includes(`Task project root: ${root}`));
    assert.ok(conductor?.runtimeFiles?.[0]?.contents.includes(".agent-workspace contains Runtime metadata only"));
    assert.equal(worker, undefined, "a worker gets a native launch profile only after the Conductor dispatches it");
    const initialDispatch = await runtime.prepareWorkerInitialDispatch({
      taskId: task.taskId,
      agentId: "researcher",
      sessionId: workerSessionId,
      initialPrompt: "[Agent Workspace] Dispatch ID TEST123\nCreate docs/generated.md.",
    });
    assert.equal(initialDispatch.initialPromptSubmitted, true);
    assert.deepEqual(profiles.get(workerSessionId)?.args, [
      "--model",
      DEFAULT_MODEL,
      "--prompt",
      "[Agent Workspace] Dispatch ID TEST123\nCreate docs/generated.md.",
    ]);
    assert.equal(profiles.get(workerSessionId)?.env?.OPENCODE_PATH, "/usr/local/bin/opencode");
    assert.ok(profiles.get(workerSessionId)?.env?.PATH?.split(path.delimiter).includes("/usr/local/bin"));
    runtimeState = {
      sessions: [],
      dispatches: [{ toSessionId: workerSessionId, status: "cancelled", provider: "opencode", providerSessionId: "ses-worker-original" }],
      results: [],
      pendingDecisions: [],
    };
    await runtime.prepareWorkerInitialDispatch({
      taskId: task.taskId,
      agentId: "researcher",
      sessionId: workerSessionId,
      initialPrompt: "[Agent Workspace] Dispatch ID TEST124\nContinue from the prior evidence.",
    });
    assert.deepEqual(profiles.get(workerSessionId)?.args, ["--session", "ses-worker-original"]);
    assert.equal(runtime.validateDispatch({ taskId: task.taskId, agentId: "researcher", toSessionId: workerSessionId }).ok, true);
    assert.equal(runtime.validateDispatch({ taskId: task.taskId, agentId: "researcher", toSessionId: "opencode:project:research-task:outside" }).reason, "loop_target_not_in_confirmed_agent_cards");
    assert.deepEqual(runtime.resolveAgentSession({ taskId: task.taskId, agentId: "researcher" }), {
      agentId: "researcher",
      sessionId: workerSessionId,
      card: task.architecture.agentCards.find((card) => card.id === "researcher"),
    });
    runtimeState = {
      sessions: [],
      dispatches: [{ toSessionId: workerSessionId, assignment: "Find primary sources." }],
      results: [],
      pendingDecisions: [],
    };
    const dispatched = runtime.readRun({ runId: detail.run.runId });
    assert.deepEqual(dispatched.turns.map((turn) => turn.nodeId), ["conductor", "researcher"]);
    assert.ok(
      Object.values(dispatched.workbenchLayout.groups).some((group) => group.sessionIds.includes(workerSessionId)),
      "an automatically placed worker must appear in exactly one visible Group",
    );
    const savedLayout = runtime.saveWorkbenchLayout({
      runId: detail.run.runId,
      layout: {
        version: 1,
        root: {
          type: "split",
          direction: "horizontal",
          ratio: .6,
          first: { type: "leaf", groupId: "primary" },
          second: { type: "leaf", groupId: "review" },
        },
        groups: {
          primary: { id: "primary", sessionIds: ["opencode:project:research-task:conductor"], activeSessionId: "opencode:project:research-task:conductor" },
          review: { id: "review", sessionIds: [workerSessionId], activeSessionId: workerSessionId },
        },
        focusedGroupId: "review",
      },
    });
    assert.equal(savedLayout.root.type, "split");
    assert.deepEqual(runtime.readWorkbenchLayout({ runId: detail.run.runId }), savedLayout);
    assert.throws(
      () => runtime.saveTemplate({ ...seed, id: "unsafe-artifact", name: "Unsafe artifact", delivery: { artifactPath: "../outside.md" } }),
      /loop_artifact_path_invalid/,
    );

    fs.writeFileSync(path.join(root, "delivery.md"), "# Verified delivery\n\n| status | ready |\n| --- | --- |\n", "utf8");
    assert.deepEqual(runtime.readArtifact({ runId: detail.run.runId, artifactPath: "delivery.md" }), {
      path: "delivery.md",
      absolutePath: path.join(root, "delivery.md"),
      exists: true,
      size: 54,
      contentType: "markdown",
      content: "# Verified delivery\n\n| status | ready |\n| --- | --- |\n",
    });

    const delivery = runtime.recordCompletionClaim({ taskId: task.taskId });
    assert.equal(delivery.task.status, "delivery_ready");
    assert.equal((await runtime.markTaskAchieved({ taskId: task.taskId })).status, "achieved");
    assert.ok(taskEvents.some((event) => event.type === "task.achieved"));
    runtime.close();
  });

  it("moves achieved Tasks out of the active Run, starts an isolated re-run, and deletes only Runtime state", async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-loop-v1-lifecycle-"));
    const sessionStore = createSessionStore({ root: ({ cwd }) => path.join(cwd, ".agent-workspace", "runtime") });
    const released = [];
    const runtime = createAgentLoopV1Runtime({
      opencodePath: "/usr/local/bin/opencode",
      databasePath: path.join(projectRoot, "agent-loop.sqlite"),
      getConductorBridgeConfig: async () => ({ conductorToolBridgeUrl: "http://127.0.0.1:4567", conductorToolBridgeToken: "test-token", conductorMcpServerPath: "/workspace/desktop/conductor-mcp-server.cjs" }),
      sessionAuthority: {
        registerLaunchProfile() {},
        async activateSession({ workspaceSessionId }) { return { session: { id: workspaceSessionId, status: "running" } }; },
        async stopSession() {},
        releaseTask(input) { released.push(input.taskId); },
      },
      ptyManager: { read: () => undefined, get: () => undefined },
      sessionStore,
    });
    const task = runtime.createTask({ cwd: projectRoot, projectId: "project", taskId: "lifecycle-task", title: "Lifecycle", goal: "Keep the project delivery while deleting Runtime state." });
    const first = await runtime.startRun({ taskId: task.taskId });
    runtime.recordCompletionClaim({ taskId: task.taskId });
    assert.equal((await runtime.markTaskAchieved({ taskId: task.taskId })).status, "achieved");
    assert.equal(runtime.readRun({ runId: first.run.runId }).run.status, "achieved");

    const second = await runtime.startRun({ taskId: task.taskId });
    assert.notEqual(second.run.runId, first.run.runId);
    assert.notEqual(second.run.conductorSessionId, first.run.conductorSessionId, "a re-run must not adopt the prior native terminal identity");
    assert.equal(runtime.readRun({ runId: first.run.runId }).run.status, "achieved", "prior Run remains durable history");

    runtime.recordCompletionClaim({ taskId: task.taskId });
    await runtime.markTaskAchieved({ taskId: task.taskId });
    const deliveryPath = path.join(projectRoot, "delivery.md");
    fs.writeFileSync(deliveryPath, "# User delivery\n", "utf8");
    const deleted = await runtime.deleteTask({ taskId: task.taskId });
    assert.deepEqual(deleted, {
      deleted: true,
      taskId: task.taskId,
      runsDeleted: 2,
      runtimeDirectoryRemoved: true,
    });
    assert.equal(runtime.readTask({ taskId: task.taskId }), undefined);
    assert.equal(runtime.readRun({ runId: first.run.runId }), undefined);
    assert.equal(fs.existsSync(deliveryPath), true, "Task deletion must not delete the project delivery");
    assert.deepEqual(released, [task.taskId]);
    runtime.close();
  });

  it("stops a live Task for a later isolated restart and permits direct Runtime-only deletion", async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-loop-v1-stop-"));
    const sessionStore = createSessionStore({ root: ({ cwd }) => path.join(cwd, ".agent-workspace", "runtime") });
    const liveSessions = new Map();
    const stoppedSessions = [];
    const runtime = createAgentLoopV1Runtime({
      opencodePath: "/usr/local/bin/opencode",
      databasePath: path.join(projectRoot, "agent-loop.sqlite"),
      getConductorBridgeConfig: async () => ({ conductorToolBridgeUrl: "http://127.0.0.1:4567", conductorToolBridgeToken: "test-token", conductorMcpServerPath: "/workspace/desktop/conductor-mcp-server.cjs" }),
      sessionAuthority: {
        registerLaunchProfile() {},
        async activateSession({ workspaceSessionId }) {
          const session = { id: workspaceSessionId, status: "running" };
          liveSessions.set(workspaceSessionId, session);
          return { session };
        },
        async stopSession({ workspaceSessionId }) {
          stoppedSessions.push(workspaceSessionId);
          liveSessions.set(workspaceSessionId, { id: workspaceSessionId, status: "stopped" });
        },
        releaseTask() {},
      },
      ptyManager: { read: () => undefined, get: (sessionId) => liveSessions.get(sessionId) },
      sessionStore,
    });
    const task = runtime.createTask({ cwd: projectRoot, projectId: "project", taskId: "stoppable-task", title: "Stoppable", goal: "Stop active Sessions without deleting the Task." });
    const first = await runtime.startRun({ taskId: task.taskId });
    const stopped = await runtime.stopTask({ taskId: task.taskId });
    assert.equal(stopped.status, "stopped");
    assert.equal(runtime.readRun({ runId: first.run.runId }).run.status, "stopped");
    assert.deepEqual(stoppedSessions, [first.run.conductorSessionId]);
    assert.deepEqual(runtime.listConductorWakeupTargets(), []);
    assert.throws(() => runtime.resumeTaskForDispatch({ taskId: task.taskId }), /loop_task_is_closed/);

    const restarted = await runtime.startRun({ taskId: task.taskId });
    assert.equal(restarted.task.status, "running");
    assert.notEqual(restarted.run.runId, first.run.runId);
    const restartedWorker = runtime.resolveAgentSession({ taskId: task.taskId, agentId: "researcher" });
    assert.equal(restartedWorker?.sessionId, `opencode:project:stoppable-task:${restarted.run.runId}:researcher`);
    assert.deepEqual(
      runtime.validateDispatch({ taskId: task.taskId, agentId: "researcher", toSessionId: restartedWorker?.sessionId }),
      { ok: true },
      "a new Run must address its own worker Session rather than the stopped Run's Session",
    );
    const deleted = await runtime.deleteTask({ taskId: task.taskId });
    assert.equal(deleted.deleted, true);
    assert.equal(deleted.runsDeleted, 2);
    assert.equal(runtime.readTask({ taskId: task.taskId }), undefined);
    assert.deepEqual(stoppedSessions, [first.run.conductorSessionId, restarted.run.conductorSessionId]);
    runtime.close();
  });

  it("serializes concurrent re-runs so only one replacement Run is created", async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-loop-v1-rerun-race-"));
    const sessionStore = createSessionStore({ root: ({ cwd }) => path.join(cwd, ".agent-workspace", "runtime") });
    const runtime = createAgentLoopV1Runtime({
      opencodePath: "/usr/local/bin/opencode",
      databasePath: path.join(projectRoot, "agent-loop.sqlite"),
      getConductorBridgeConfig: async () => ({ conductorToolBridgeUrl: "http://127.0.0.1:4567", conductorToolBridgeToken: "test-token", conductorMcpServerPath: "/workspace/desktop/conductor-mcp-server.cjs" }),
      sessionAuthority: {
        registerLaunchProfile() {},
        async activateSession({ workspaceSessionId }) { return { session: { id: workspaceSessionId, status: "running" } }; },
      },
      ptyManager: { read: () => undefined, get: () => undefined },
      sessionStore,
    });
    const task = runtime.createTask({ cwd: projectRoot, projectId: "project", taskId: "rerun-race", title: "Rerun race", goal: "Create only one new Run." });
    const first = await runtime.startRun({ taskId: task.taskId });
    runtime.recordCompletionClaim({ taskId: task.taskId });
    await runtime.markTaskAchieved({ taskId: task.taskId });

    const outcomes = await Promise.allSettled([
      runtime.startRun({ taskId: task.taskId }),
      runtime.startRun({ taskId: task.taskId }),
    ]);
    const successes = outcomes.filter((outcome) => outcome.status === "fulfilled");
    const failures = outcomes.filter((outcome) => outcome.status === "rejected");
    assert.equal(successes.length, 1);
    assert.equal(failures.length, 1);
    assert.match(String(failures[0].reason), /loop_run_already_running/);
    assert.notEqual(successes[0].value.run.runId, first.run.runId);
    assert.equal(runtime.listTasks()[0].latestRun.runId, successes[0].value.run.runId);
    runtime.close();
  });

  it("lets Stop win over a queued achievement while terminal shutdown is pending", async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-loop-v1-stop-achieve-race-"));
    const sessionStore = createSessionStore({ root: ({ cwd }) => path.join(cwd, ".agent-workspace", "runtime") });
    const liveSessions = new Map();
    let releaseStop;
    let stopStarted;
    const stopMayFinish = new Promise((resolve) => { releaseStop = resolve; });
    const stopHasStarted = new Promise((resolve) => { stopStarted = resolve; });
    const runtime = createAgentLoopV1Runtime({
      opencodePath: "/usr/local/bin/opencode",
      databasePath: path.join(projectRoot, "agent-loop.sqlite"),
      getConductorBridgeConfig: async () => ({ conductorToolBridgeUrl: "http://127.0.0.1:4567", conductorToolBridgeToken: "test-token", conductorMcpServerPath: "/workspace/desktop/conductor-mcp-server.cjs" }),
      sessionAuthority: {
        registerLaunchProfile() {},
        async activateSession({ workspaceSessionId }) {
          const session = { id: workspaceSessionId, status: "running" };
          liveSessions.set(workspaceSessionId, session);
          return { session };
        },
        async stopSession({ workspaceSessionId }) {
          stopStarted();
          await stopMayFinish;
          liveSessions.set(workspaceSessionId, { id: workspaceSessionId, status: "stopped" });
        },
      },
      ptyManager: { read: () => undefined, get: (sessionId) => liveSessions.get(sessionId) },
      sessionStore,
    });
    const task = runtime.createTask({ cwd: projectRoot, projectId: "project", taskId: "stop-achieve-race", title: "Stop-achieve race", goal: "Do not overwrite Stop." });
    const first = await runtime.startRun({ taskId: task.taskId });

    const stopping = runtime.stopTask({ taskId: task.taskId });
    await stopHasStarted;
    const achieving = runtime.markTaskAchieved({ taskId: task.taskId });
    releaseStop();

    const stopped = await stopping;
    assert.equal(stopped.status, "stopped");
    assert.equal(runtime.readRun({ runId: first.run.runId }).run.status, "stopped");
    await assert.rejects(achieving, /loop_task_not_achievable/);
    runtime.close();
  });
});

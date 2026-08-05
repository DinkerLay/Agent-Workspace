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
  it("gives Template Design Draft save the same SQLite writer as Template Version persistence", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-loop-v1-template-design-save-"));
    const runtime = createAgentLoopV1Runtime({
      opencodePath: "/usr/local/bin/opencode",
      databasePath: path.join(root, "runtime.sqlite"),
      getConductorBridgeConfig: async () => ({ conductorToolBridgeUrl: "http://127.0.0.1:4567", conductorToolBridgeToken: "test-token", conductorMcpServerPath: "/workspace/desktop/conductor-mcp-server.cjs" }),
      sessionAuthority: { registerLaunchProfile() {}, async activateSession({ workspaceSessionId }) { return { session: { id: workspaceSessionId, status: "running" } }; } },
      ptyManager: { read: () => undefined },
      sessionStore: { recordTaskEvent() {}, readTaskState: () => ({ sessions: [], dispatches: [], results: [], pendingDecisions: [] }) },
    });
    const source = runtime.templateById("opencode-agent-loop-v1");
    const latest = runtime.saveTemplate({ ...source, name: "OpenCode Agent Loop current" });
    assert.equal(latest.version, source.version + 1);
    const { draft } = runtime.templateDesignService.createOrGetDraft({
      draftId: "template-design-shared-writer",
      templateId: source.id,
      baseTemplateVersion: source.version,
      cwd: root,
      model: source.conductor.model,
      draftJson: {
        id: source.id,
        name: "OpenCode Agent Loop revised",
        source: source.source,
        conductor: source.conductor,
        agents: source.agents,
        limits: source.limits,
        delivery: source.delivery,
      },
    });

    const saved = runtime.templateDesignService.saveDraft({ draftId: draft.draftId, expectedRevision: draft.revision });

    assert.equal(saved.draft.status, "active", "saving creates a Version checkpoint without closing the Draft");
    assert.equal(saved.savedTemplate.id, source.id);
    assert.equal(saved.savedTemplate.version, latest.version + 1, "saving a Draft based on an older Version appends after the current latest Version");
    assert.equal(runtime.templateById(source.id).name, "OpenCode Agent Loop revised");
    assert.equal(runtime.templateById(source.id, source.version).name, source.name, "saving the Draft never overwrites its historical base Version");
    assert.equal(runtime.templateById(source.id, latest.version).name, latest.name, "saving the Draft never overwrites an intervening Version");
    runtime.close();
  });

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

  it("keeps a legacy Card contract in an existing Task snapshot while a later Template Version uses the split contract", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-loop-v1-card-contract-"));
    const databasePath = path.join(root, "runtime.sqlite");
    const runtime = createAgentLoopV1Runtime({
      opencodePath: "/usr/local/bin/opencode",
      databasePath,
      getConductorBridgeConfig: async () => ({ conductorToolBridgeUrl: "http://127.0.0.1:4567", conductorToolBridgeToken: "test-token", conductorMcpServerPath: "/workspace/desktop/conductor-mcp-server.cjs" }),
      sessionAuthority: { registerLaunchProfile() {}, async activateSession({ workspaceSessionId }) { return { session: { id: workspaceSessionId, status: "running" } }; } },
      ptyManager: { read: () => undefined },
      sessionStore: { recordTaskEvent() {}, readTaskState: () => ({ sessions: [], dispatches: [], results: [], pendingDecisions: [] }) },
    });
    const legacyTemplate = runtime.saveTemplate({
      id: "card-contract",
      name: "Card contract",
      source: "manual",
      conductor: { role: "Conductor", model: DEFAULT_MODEL, charter: "Choose a bounded dispatch." },
      agents: [{
        id: "researcher",
        name: "Researcher",
        kind: "researcher",
        role: "Find evidence.",
        model: DEFAULT_MODEL,
        mcp: [],
        skills: [],
        instructions: "Cite dates.",
        expectedOutput: "Evidence memo.",
      }],
      limits: { maxConcurrentSessions: 1, maxDispatchesPerDecision: 1 },
      delivery: { artifactPath: "" },
    });
    const legacyTask = runtime.createTask({
      taskId: "legacy-card-task",
      cwd: root,
      title: "Legacy card task",
      goal: "Keep the existing contract.",
      templateId: legacyTemplate.id,
    });
    const beforeDb = new DatabaseSync(databasePath);
    const before = beforeDb
      .prepare("SELECT architecture_json FROM agent_loop_tasks WHERE task_id = ?")
      .get(legacyTask.taskId)
      .architecture_json;
    beforeDb.close();

    const splitTemplate = runtime.saveTemplate({
      ...legacyTemplate,
      agents: [{
        id: "researcher",
        name: "Researcher",
        kind: "researcher",
        model: DEFAULT_MODEL,
        mcp: [],
        skills: [],
        dispatchProfile: {
          title: "Evidence research",
          description: "Use for independently verifiable research when the Conductor needs source-backed facts.",
        },
        workerSystemPrompt: "Collect primary evidence, cite dates, and separate facts from inference.",
      }],
    });
    const splitTask = runtime.createTask({
      taskId: "split-card-task",
      cwd: root,
      title: "Split card task",
      goal: "Use the explicit contract.",
      templateId: splitTemplate.id,
    });

    assert.equal(runtime.readTask({ taskId: legacyTask.taskId }).architecture.agentCards[0].instructions, "Cite dates.");
    assert.equal(Object.hasOwn(runtime.readTask({ taskId: legacyTask.taskId }).architecture.agentCards[0], "dispatchProfile"), false);
    assert.deepEqual(runtime.readTask({ taskId: splitTask.taskId }).architecture.agentCards[0].dispatchProfile, {
      title: "Evidence research",
      description: "Use for independently verifiable research when the Conductor needs source-backed facts.",
    });
    assert.equal(runtime.readTask({ taskId: splitTask.taskId }).architecture.agentCards[0].workerSystemPrompt, "Collect primary evidence, cite dates, and separate facts from inference.");

    const afterDb = new DatabaseSync(databasePath);
    const after = afterDb
      .prepare("SELECT architecture_json FROM agent_loop_tasks WHERE task_id = ?")
      .get(legacyTask.taskId)
      .architecture_json;
    afterDb.close();
    assert.equal(after, before, "saving a new Template Version must not rewrite an existing Task snapshot");
    runtime.close();
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
    await assert.rejects(
      runtime.markTaskAchieved({ taskId: task.taskId }),
      /loop_task_not_achievable/,
      "a user cannot achieve a Task before Conductor records a delivery claim",
    );
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

  it("projects a default Workbench layout without writing during readRun", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-loop-v1-pure-read-model-"));
    const databasePath = path.join(root, "runtime.sqlite");
    const runtime = createAgentLoopV1Runtime({
      opencodePath: "/usr/local/bin/opencode",
      databasePath,
      getConductorBridgeConfig: async () => ({ conductorToolBridgeUrl: "http://127.0.0.1:4567", conductorToolBridgeToken: "test-token", conductorMcpServerPath: "/workspace/desktop/conductor-mcp-server.cjs" }),
      sessionAuthority: { registerLaunchProfile() {}, async activateSession({ workspaceSessionId }) { return { session: { id: workspaceSessionId, status: "running" } }; } },
      ptyManager: { read: () => undefined },
      sessionStore: { recordTaskEvent() {}, readTaskState: () => ({ sessions: [], dispatches: [], results: [], pendingDecisions: [], messages: [] }) },
    });
    const task = runtime.createTask({ cwd: root, projectId: "project", taskId: "pure-read", title: "Pure read", goal: "Do not materialize defaults while reading." });
    const started = await runtime.startRun({ taskId: task.taskId });

    const external = new DatabaseSync(databasePath);
    external.prepare("DELETE FROM agent_loop_workbench_layouts WHERE run_id = ?").run(started.run.runId);
    external.close();
    const projected = runtime.readRun({ runId: started.run.runId });
    assert.equal(projected.workbenchLayout.version, 1);

    const checked = new DatabaseSync(databasePath);
    assert.equal(
      checked.prepare("SELECT COUNT(*) AS count FROM agent_loop_workbench_layouts WHERE run_id = ?").get(started.run.runId).count,
      0,
      "readRun must not persist a projected default layout",
    );
    checked.close();

    const saved = runtime.saveWorkbenchLayout({
      runId: started.run.runId,
      layout: {
        ...projected.workbenchLayout,
        taskPage: { taskListWidth: 336, inspectorWidth: 312 },
      },
    });
    assert.deepEqual(saved.taskPage, { taskListWidth: 336, inspectorWidth: 312 });
    assert.deepEqual(
      runtime.readRun({ runId: started.run.runId }).workbenchLayout.taskPage,
      { taskListWidth: 336, inspectorWidth: 312 },
      "Task page pane widths must round-trip through the one Run-owned layout record",
    );
    runtime.close();
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
    const messageCommand = {
      taskId: task.taskId,
      message: "不要比较 GitHub Copilot，改为核实 ChatGPT Codex。",
      commandId: "command-user-message-1",
    };
    const result = await runtime.recordUserMessage(messageCommand);
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

    const replay = await runtime.recordUserMessage(messageCommand);
    assert.equal(replay.messageId, result.messageId);
    assert.equal(replay.wakeup.delivery, "idempotent_command_replay");
    assert.equal(writes.length, 1, "replaying one UI command must not write its Conductor input twice");
    assert.equal(taskEvents.filter((event) => event.type === "task.user_message").length, 1);

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
      recordTerminalState(input, state, summary, data) {
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
    assert.equal(states.at(-1)?.state, "ready");
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
    assert.equal(store.readTaskState({ taskId: task.taskId }).sessions.find((session) => session.sessionId === sessionId)?.state, "waiting_input");
    const staleQuestion = await runtime.respondSessionQuestion({ taskId: task.taskId, sessionId, questionId: "question-native-stale", answer: "No route." });
    assert.deepEqual(staleQuestion, { ok: false, status: "waiting_input", errorCode: "provider_question_changed" });
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

  it("keeps a Publisher reserved until an exact Provider completion result closes its recovered permission", async () => {
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
    const started = await runtime.startRun({ taskId: task.taskId });
    const publisherSessionId = Object.entries(runtime.taskAgentMap({ taskId: task.taskId })).find(([, agentId]) => agentId === "publisher")?.[0];
    assert.ok(publisherSessionId);
    store.startSession({ taskId: task.taskId, sessionId: publisherSessionId, command: "opencode", cwd: root });
    const dispatch = store.recordDispatch({
      taskId: task.taskId,
      conductorSessionId: started.run.conductorSessionId,
      toSessionId: publisherSessionId,
      agentId: "publisher",
      assignment: "Complete the approved report.",
    });
    store.markDispatchDelivered({
      taskId: task.taskId,
      sessionId: publisherSessionId,
      dispatchId: dispatch.dispatchId,
      provider: "opencode",
      providerSessionId: "ses-publisher-permission-fence",
    });
    store.recordPermissionRequested({
      taskId: task.taskId,
      sessionId: publisherSessionId,
      cwd: root,
      permissionId: "opencode:publisher-copy",
      requestId: "publisher-copy",
      dispatchId: dispatch.dispatchId,
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
    store.recordProviderSessionState(
      { taskId: task.taskId, sessionId: publisherSessionId, cwd: root },
      "ready",
      "OpenCode reconnected but has not returned the current dispatch result.",
    );

    assert.deepEqual(
      runtime.validateDispatch({ taskId: task.taskId, agentId: "publisher", toSessionId: publisherSessionId }),
      { ok: false, reason: "loop_session_permission_decision_pending", permissionId: "opencode:publisher-copy" },
    );

    const completed = store.recordDispatchResult({
      taskId: task.taskId,
      sessionId: publisherSessionId,
      cwd: root,
      dispatchId: dispatch.dispatchId,
      reason: "provider-turn-completed",
      providerTurnCompleted: true,
      provider: "opencode",
      providerSessionId: "ses-publisher-permission-fence",
      providerMessageId: "msg-publisher-permission-fence",
      answerText: "The approved report is complete.",
      source: "fixture-provider",
    });
    assert.equal(completed.status, "result_available");
    const permission = store.readSession({ taskId: task.taskId, sessionId: publisherSessionId, cwd: root }).permissions[0];
    assert.equal(permission.status, "provider_turn_completed");
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

  it("reconciles a prepared Stop command after a Main-process restart", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-loop-v1-prepared-stop-"));
    const databasePath = path.join(root, "runtime.sqlite");
    const store = createSessionStore({ root });
    const runtimeInput = {
      opencodePath: "/usr/local/bin/opencode",
      databasePath,
      getConductorBridgeConfig: async () => ({ conductorToolBridgeUrl: "http://127.0.0.1:4567", conductorToolBridgeToken: "test-token", conductorMcpServerPath: "/workspace/desktop/conductor-mcp-server.cjs" }),
      sessionAuthority: {
        registerLaunchProfile() {},
        async activateSession({ workspaceSessionId }) { return { session: { id: workspaceSessionId, status: "running" } }; },
        async stopSession() {},
      },
      ptyManager: { read: () => undefined, get: () => undefined },
      sessionStore: store,
    };
    const firstRuntime = createAgentLoopV1Runtime(runtimeInput);
    const task = firstRuntime.createTask({
      cwd: root,
      projectId: "project",
      taskId: "prepared-stop-task",
      title: "Prepared stop",
      goal: "Finish a persisted stop after restart.",
    });
    const started = await firstRuntime.startRun({ taskId: task.taskId });
    firstRuntime.close();

    const crashDb = new DatabaseSync(databasePath);
    const currentRevision = Number(crashDb.prepare("SELECT revision FROM agent_loop_tasks WHERE task_id = ?").get(task.taskId).revision);
    const preparedRevision = currentRevision + 1;
    const timestamp = "2026-08-02T01:00:00.000Z";
    crashDb.prepare("UPDATE agent_loop_tasks SET status = 'stopping', revision = ?, updated_at = ? WHERE task_id = ?")
      .run(preparedRevision, timestamp, task.taskId);
    crashDb.prepare(
      `INSERT INTO agent_loop_commands
       (command_id, task_id, kind, payload_json, status, result_json, created_at, updated_at)
       VALUES (?, ?, 'task.stop', '{}', 'prepared', ?, ?, ?)`,
    ).run(
      "command-stop-after-crash",
      task.taskId,
      JSON.stringify({ taskId: task.taskId, runId: started.run.runId, taskRevision: preparedRevision }),
      timestamp,
      timestamp,
    );
    crashDb.close();

    const restartedRuntime = createAgentLoopV1Runtime(runtimeInput);
    const reconciliation = await restartedRuntime.reconcilePreparedLifecycleCommands();
    assert.deepEqual(reconciliation, {
      attempted: 1,
      results: [{
        commandId: "command-stop-after-crash",
        taskId: task.taskId,
        kind: "task.stop",
        status: "committed",
      }],
    });
    assert.equal(restartedRuntime.readTask({ taskId: task.taskId }).status, "stopped");
    assert.equal(restartedRuntime.readRun({ runId: started.run.runId }).run.status, "stopped");
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
    assert.ok(conductor?.runtimeFiles?.[0]?.contents.includes("Evidence research"));
    assert.equal(conductor?.runtimeFiles?.[0]?.contents.includes("Research the assigned question with primary or otherwise verifiable sources."), false);
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

  it("retries a prepared permanent delete without removing replacement artifacts or trusting an old path-only command", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-loop-v1-delete-retry-"));
    const databasePath = path.join(root, "runtime.sqlite");
    const rawStore = createSessionStore({ root: ({ cwd }) => path.join(cwd, ".agent-workspace", "runtime") });
    let rejectDelete = true;
    const sessionStore = {
      ...rawStore,
      deleteTask(input) {
        if (rejectDelete) throw new Error("runtime-directory-busy");
        return rawStore.deleteTask(input);
      },
    };
    const runtimeInput = {
      opencodePath: "/usr/local/bin/opencode",
      databasePath,
      getConductorBridgeConfig: async () => ({ conductorToolBridgeUrl: "http://127.0.0.1:4567", conductorToolBridgeToken: "test-token", conductorMcpServerPath: "/workspace/desktop/conductor-mcp-server.cjs" }),
      sessionAuthority: {
        registerLaunchProfile() {},
        async activateSession({ workspaceSessionId }) { return { session: { id: workspaceSessionId, status: "running" } }; },
        releaseTask() {},
      },
      ptyManager: { read: () => undefined, get: () => undefined },
    };
    const runtime = createAgentLoopV1Runtime({
      ...runtimeInput,
      sessionStore,
    });
    const managedArtifactPath = "artifacts/delete-retry.md";
    const legacyArtifactPath = "artifacts/delete-retry-legacy.md";
    const template = runtime.saveTemplate({
      ...runtime.templateById("opencode-agent-loop-v1"),
      id: "delete-retry-template",
      name: "Delete retry template",
      delivery: { artifactPath: managedArtifactPath },
    });
    const task = runtime.createTask({
      cwd: root,
      projectId: "project",
      taskId: "delete-retry-task",
      title: "Delete retry",
      goal: "Do not orphan Runtime state.",
      templateId: template.id,
    });
    // A second registered artifact lets this regression cover both recovery
    // cases: a persisted identity that no longer matches, and an older
    // prepared command that has only a selected path.
    const fixtureDb = new DatabaseSync(databasePath);
    fixtureDb.prepare(
      `INSERT INTO agent_loop_managed_artifacts (task_id, artifact_path, source, created_at)
       VALUES (?, ?, ?, ?)`,
    ).run(task.taskId, legacyArtifactPath, "test_fixture", "2026-08-05T00:00:00.000Z");
    fixtureDb.close();
    const managedArtifactAbsolutePath = path.join(root, managedArtifactPath);
    const legacyArtifactAbsolutePath = path.join(root, legacyArtifactPath);
    const keptNotePath = path.join(root, "user-kept-note.md");
    fs.mkdirSync(path.dirname(managedArtifactAbsolutePath), { recursive: true });
    fs.writeFileSync(managedArtifactAbsolutePath, "# Managed delete retry artifact\n", "utf8");
    fs.writeFileSync(legacyArtifactAbsolutePath, "# Legacy managed delete retry artifact\n", "utf8");
    fs.writeFileSync(keptNotePath, "# User-owned note\n", "utf8");
    await runtime.startRun({ taskId: task.taskId });
    runtime.recordCompletionClaim({ taskId: task.taskId });
    const deliveryReady = runtime.readTask({ taskId: task.taskId });
    await runtime.markTaskAchieved({
      taskId: task.taskId,
      commandId: "command-achieve-delete-retry",
      expectedRevision: deliveryReady.revision,
    });
    const achieved = runtime.readTask({ taskId: task.taskId });
    const archived = await runtime.moveTaskToRecycleBin({
      taskId: task.taskId,
      commandId: "command-recycle-delete-retry",
      expectedRevision: achieved.revision,
    });
    assert.equal(archived.status, "archived");

    await assert.rejects(
      () => runtime.permanentlyDeleteTask({
        taskId: task.taskId,
        commandId: "command-permanently-delete-retry",
        expectedRevision: archived.revision,
        artifactPaths: [managedArtifactPath, legacyArtifactPath],
      }),
      /runtime-directory-busy/,
    );
    assert.equal(runtime.readTask({ taskId: task.taskId }).status, "deleting");
    assert.equal(fs.existsSync(managedArtifactAbsolutePath), false, "the selected managed artifact is removed before a later Runtime-directory failure");
    assert.equal(fs.existsSync(legacyArtifactAbsolutePath), false, "each explicitly selected managed artifact is removed before the later failure");
    assert.equal(fs.existsSync(keptNotePath), true, "the failure must not affect an unmanaged user file");
    runtime.close();

    const preparedDb = new DatabaseSync(databasePath);
    const preparedRow = preparedDb.prepare(
      "SELECT payload_json FROM agent_loop_commands WHERE command_id = ?",
    ).get("command-permanently-delete-retry");
    const preparedPayload = JSON.parse(preparedRow.payload_json);
    assert.deepEqual(preparedPayload.artifactPaths, [managedArtifactPath, legacyArtifactPath].sort());
    assert.equal(preparedPayload.artifactSnapshots.length, 2, "first preflight persists Runtime-owned identities beside the selected paths");
    const retainedSnapshot = preparedPayload.artifactSnapshots.find((snapshot) => snapshot.path === managedArtifactPath);
    assert.equal(retainedSnapshot.state, "present");
    assert.equal(retainedSnapshot.kind, "file");
    assert.equal(typeof retainedSnapshot.dev, "number");
    assert.equal(typeof retainedSnapshot.ino, "number");
    // Simulate a command written by the preceding version: it has the selected
    // path but no identity for the legacy artifact. Recovery must not treat it
    // as permission to remove whatever now exists at that path.
    preparedPayload.artifactSnapshots = [retainedSnapshot];
    preparedDb.prepare("UPDATE agent_loop_commands SET payload_json = ? WHERE command_id = ?").run(
      JSON.stringify(preparedPayload),
      "command-permanently-delete-retry",
    );
    preparedDb.close();
    const replacementContent = "# Replacement after confirmation\n";
    const legacyReplacementContent = "# Replacement from old path-only command\n";
    fs.writeFileSync(managedArtifactAbsolutePath, replacementContent, "utf8");
    fs.writeFileSync(legacyArtifactAbsolutePath, legacyReplacementContent, "utf8");

    const restartedRuntime = createAgentLoopV1Runtime({
      ...runtimeInput,
      sessionStore: createSessionStore({ root: ({ cwd }) => path.join(cwd, ".agent-workspace", "runtime") }),
    });
    const reconciliation = await restartedRuntime.reconcilePreparedLifecycleCommands();
    assert.equal(reconciliation.attempted, 1);
    assert.equal(reconciliation.results[0].status, "committed");
    assert.equal(restartedRuntime.readTask({ taskId: task.taskId }), undefined);
    const replay = await restartedRuntime.permanentlyDeleteTask({
      taskId: task.taskId,
      commandId: "command-permanently-delete-retry",
      expectedRevision: archived.revision,
    });
    assert.equal(replay.deleted, true, "a same-command retry uses the deletion tombstone after Task records are gone");
    assert.equal(fs.readFileSync(managedArtifactAbsolutePath, "utf8"), replacementContent, "a replacement at the same selected path survives identity-mismatched recovery");
    assert.equal(fs.readFileSync(legacyArtifactAbsolutePath, "utf8"), legacyReplacementContent, "an old path-only prepared command cannot remove a replacement artifact");
    assert.equal(fs.existsSync(keptNotePath), true, "the user-owned file remains after the recovered delete");
    assert.equal(fs.existsSync(root), true, "permanent deletion never removes the project cwd");
    restartedRuntime.close();

    const tombstoneDb = new DatabaseSync(databasePath);
    const tombstone = tombstoneDb.prepare(
      "SELECT result_json FROM agent_loop_deleted_task_tombstones WHERE command_id = ?",
    ).get("command-permanently-delete-retry");
    const finalResult = JSON.parse(tombstone.result_json);
    assert.deepEqual(finalResult.managedArtifactsDeleted, []);
    assert.deepEqual(
      [...finalResult.managedArtifactsSkipped].sort((left, right) => left.path.localeCompare(right.path)),
      [
        { path: legacyArtifactPath, reason: "changed_since_confirmation" },
        { path: managedArtifactPath, reason: "changed_since_confirmation" },
      ].sort((left, right) => left.path.localeCompare(right.path)),
    );
    tombstoneDb.close();
  });

  it("keeps Task/Run history in the recycle bin, then permanently deletes only selected managed artifacts", async () => {
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
    const seed = runtime.templateById("opencode-agent-loop-v1");
    const template = runtime.saveTemplate({
      ...seed,
      id: "lifecycle-managed-delivery-template",
      name: "Lifecycle managed delivery",
      delivery: { ...seed.delivery, artifactPath: "reports/managed-delivery.md" },
    });
    const task = runtime.createTask({
      cwd: projectRoot,
      projectId: "project",
      taskId: "lifecycle-task",
      title: "Lifecycle",
      goal: "Keep user-kept project files while deleting selected managed delivery and Runtime state.",
      templateId: template.id,
    });
    const first = await runtime.startRun({ taskId: task.taskId });
    runtime.recordCompletionClaim({ taskId: task.taskId });
    const deliveryReady = runtime.readTask({ taskId: task.taskId });
    assert.equal((await runtime.markTaskAchieved({
      taskId: task.taskId,
      commandId: "command-achieve-lifecycle",
      expectedRevision: deliveryReady.revision,
    })).status, "achieved");
    assert.equal(runtime.readRun({ runId: first.run.runId }).run.status, "achieved");

    await assert.rejects(
      () => runtime.startRun({ taskId: task.taskId }),
      /loop_task_requires_resume_achieved/,
    );
    assert.equal(runtime.readRun({ runId: first.run.runId }).run.status, "achieved", "the original Run remains durable history");
    const managedDeliveryPath = path.join(projectRoot, "reports", "managed-delivery.md");
    const keptNotePath = path.join(projectRoot, "user-kept-note.md");
    fs.mkdirSync(path.dirname(managedDeliveryPath), { recursive: true });
    fs.writeFileSync(managedDeliveryPath, "# Managed delivery\n", "utf8");
    fs.writeFileSync(keptNotePath, "# Keep this user note\n", "utf8");
    const achieved = runtime.readTask({ taskId: task.taskId });
    await assert.rejects(
      () => runtime.permanentlyDeleteTask({
        taskId: task.taskId,
        commandId: "command-delete-without-recycle",
        expectedRevision: achieved.revision,
      }),
      /loop_task_not_in_recycle_bin/,
    );
    const archived = await runtime.moveTaskToRecycleBin({
      taskId: task.taskId,
      commandId: "command-recycle-lifecycle",
      expectedRevision: achieved.revision,
    });
    assert.equal(archived.status, "archived");
    assert.equal(runtime.listTasks().some((item) => item.taskId === task.taskId), false, "normal list hides recycled Tasks");
    assert.equal(runtime.listTasks({ scope: "trash" }).find((item) => item.taskId === task.taskId)?.status, "archived");
    assert.equal(runtime.readRun({ runId: first.run.runId }).run.status, "achieved", "recycle retains the original Run");
    assert.ok(fs.existsSync(path.join(projectRoot, ".agent-workspace", "runtime", task.taskId)), "recycle retains the Session Store tree");

    const restored = await runtime.restoreTaskFromRecycleBin({
      taskId: task.taskId,
      commandId: "command-restore-lifecycle",
      expectedRevision: archived.revision,
    });
    assert.equal(restored.status, "achieved");
    assert.equal(runtime.readTask({ taskId: task.taskId }).latestRun.runId, first.run.runId, "restore keeps the same Run identity");

    const archivedAgain = await runtime.moveTaskToRecycleBin({
      taskId: task.taskId,
      commandId: "command-recycle-lifecycle-again",
      expectedRevision: restored.revision,
    });
    assert.deepEqual(runtime.previewTaskPermanentDeletion({ taskId: task.taskId }).managedArtifacts, [{
      path: "reports/managed-delivery.md",
      source: "template_delivery",
      exists: true,
      size: Buffer.byteLength("# Managed delivery\n"),
      deletable: true,
    }]);
    const deleted = await runtime.permanentlyDeleteTask({
      taskId: task.taskId,
      commandId: "command-permanently-delete-lifecycle",
      expectedRevision: archivedAgain.revision,
      artifactPaths: ["reports/managed-delivery.md"],
    });
    assert.equal(deleted.deleted, true);
    assert.equal(deleted.taskId, task.taskId);
    assert.equal(deleted.runsDeleted, 1);
    assert.equal(deleted.runtimeDirectoryRemoved, true);
    assert.deepEqual(deleted.managedArtifactsDeleted, ["reports/managed-delivery.md"]);
    assert.equal(runtime.readTask({ taskId: task.taskId }), undefined);
    assert.equal(runtime.readRun({ runId: first.run.runId }), undefined);
    assert.equal(fs.existsSync(managedDeliveryPath), false, "only the explicitly selected managed artifact is deleted");
    assert.equal(fs.existsSync(keptNotePath), true, "an unmanaged user note is never deleted");
    assert.equal(fs.existsSync(projectRoot), true, "permanent deletion never removes the project cwd");
    assert.deepEqual(released, [task.taskId]);
    runtime.close();
  });

  it("stops a live Task for a later isolated restart and rejects permanent deletion outside the recycle bin", async () => {
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
    await assert.rejects(
      () => runtime.deleteTask({
        taskId: task.taskId,
        commandId: "command-delete-running-task",
        expectedRevision: runtime.readTask({ taskId: task.taskId }).revision,
      }),
      /loop_task_not_in_recycle_bin/,
    );
    assert.equal(runtime.readTask({ taskId: task.taskId }).status, "running");
    assert.deepEqual(stoppedSessions, [first.run.conductorSessionId]);
    runtime.close();
  });

  it("rejects concurrent Start attempts after achievement instead of creating replacement Runs", async () => {
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
    assert.equal(successes.length, 0);
    assert.equal(failures.length, 2);
    assert.match(String(failures[0].reason), /loop_task_requires_resume_achieved/);
    assert.match(String(failures[1].reason), /loop_task_requires_resume_achieved/);
    assert.equal(runtime.listTasks()[0].latestRun.runId, first.run.runId);
    assert.equal(runtime.listTasks()[0].latestRun.status, "achieved");
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

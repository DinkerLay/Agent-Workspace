import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAgentLoopV1Runtime, DEFAULT_MODEL } from "./agent-loop-v1-runtime.cjs";
import { createSessionStore } from "../session-store.cjs";

const isVitest = process.env.VITEST === "true" || process.env.VITEST_WORKER_ID !== undefined;
const testApi = isVitest ? await import("vitest") : await import("node:test");
const { describe, it } = testApi;

describe("Agent Loop v1 runtime", () => {
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
      description: "Cards are capabilities; the Conductor decides the next dispatch.",
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
    // A delivery claim is not an execution tombstone. A later explicit
    // Conductor dispatch may continue this same Task without Runtime choosing
    // a business route for it.
    assert.equal(runtime.validateDispatch({ taskId: task.taskId, agentId: "researcher", toSessionId: researcher }).ok, true);
    const continued = runtime.resumeTaskForDispatch({ taskId: task.taskId });
    assert.equal(continued.task.status, "running");
    assert.equal(continued.run.status, "running");
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
      description: "Forward one semantic worker result to another native worker.",
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

  it("keeps Provider outcome distinct from a still-live native OpenCode terminal", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-loop-v1-status-ownership-"));
    const taskId = "status-ownership";
    const workerSessionId = `opencode:project:${taskId}:researcher`;
    const conductorSessionId = `opencode:project:${taskId}:conductor`;
    const runtime = createAgentLoopV1Runtime({
      opencodePath: "/usr/local/bin/opencode",
      databasePath: path.join(root, "runtime.sqlite"),
      getConductorBridgeConfig: async () => ({ conductorToolBridgeUrl: "http://127.0.0.1:4567", conductorToolBridgeToken: "test-token", conductorMcpServerPath: "/workspace/desktop/conductor-mcp-server.cjs" }),
      sessionAuthority: { registerLaunchProfile() {}, async activateSession({ workspaceSessionId }) { return { session: { id: workspaceSessionId, status: "running" } }; } },
      ptyManager: {
        read(sessionId) {
          return [workerSessionId, conductorSessionId].includes(sessionId) ? { id: sessionId, status: "running" } : undefined;
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
    const sessionStore = {
      recordTaskEvent(event) { taskEvents.push(event); return event; },
      readTaskState({ taskId }) { return { taskId, sessions: [], dispatches: [], results: [], pendingDecisions: [] }; },
      readSession() { return { state: "waiting_conductor" }; },
      recordState() {},
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
    assert.equal(result.wakeup.delivered, 1);
    assert.equal(writes.length, 1);
    assert.equal(writes[0].workspaceSessionId, "opencode:project:user-message:conductor");
    assert.match(writes[0].payload, /ChatGPT Codex/);
    assert.ok(taskEvents.some((event) => event.type === "task.user_message"));
    runtime.close();
  });

  it("snapshots editable Session Agent cards and launches only a modified Conductor", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-loop-v1-"));
    const profiles = new Map();
    const activations = [];
    const taskEvents = [];
    const hookRegistrations = [];
    let runtimeState = { sessions: [], dispatches: [], results: [], pendingDecisions: [] };
    const runtime = createAgentLoopV1Runtime({
      opencodePath: "/usr/local/bin/opencode",
      databasePath: path.join(root, "runtime.sqlite"),
      getConductorBridgeConfig: async () => ({
        conductorToolBridgeUrl: "http://127.0.0.1:4567",
        conductorToolBridgeToken: "test-token",
        conductorMcpServerPath: "/workspace/desktop/conductor-mcp-server.cjs",
      }),
      generateTemplateFromDescription: async () => ({
        template: {
          id: "generated-research",
          name: "Generated research",
          description: "Generated from one sentence.",
          source: "generated",
          conductor: { role: "Conductor", model: DEFAULT_MODEL },
          agents: [{ id: "researcher", name: "Researcher", role: "Research", model: DEFAULT_MODEL, mcp: [], skills: [] }],
          limits: { maxConcurrentSessions: 1, maxDispatchesPerDecision: 1 },
          delivery: { artifactPath: "docs/generated.md" },
        },
        assistantMessage: "Generated.",
        assumptions: ["one card"],
      }),
      registerProviderHook: async ({ sessionId, cwd }) => {
        hookRegistrations.push({ sessionId, cwd });
        return { env: { AGENT_WORKSPACE_HOOK_SESSION_ID: sessionId, AGENT_WORKSPACE_HOOK_TEST: "1" } };
      },
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
    const generatedDraft = await runtime.generateTemplateDraft({ cwd: root, description: "一句话生成一个调研模板。" });
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
      description: "Revised card capabilities.",
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
    assert.equal(conductor?.env?.AGENT_WORKSPACE_HOOK_SESSION_ID, "opencode:project:research-task:conductor");
    assert.ok(conductor?.runtimeFiles?.[0]?.contents.includes("call_sessions"));
    assert.ok(conductor?.runtimeFiles?.[0]?.contents.includes("Native MCP scope: all provider-native MCP"));
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
    assert.equal(profiles.get(workerSessionId)?.env?.AGENT_WORKSPACE_HOOK_SESSION_ID, workerSessionId);
    assert.deepEqual(hookRegistrations.map((registration) => registration.sessionId), [
      "opencode:project:research-task:conductor",
      workerSessionId,
    ]);
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
    assert.ok(dispatched.workbenchLayout.groups.primary.sessionIds.includes(workerSessionId));
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
    assert.equal(runtime.markTaskAchieved({ taskId: task.taskId }).status, "achieved");
    assert.ok(taskEvents.some((event) => event.type === "task.achieved"));
    runtime.close();
  });
});

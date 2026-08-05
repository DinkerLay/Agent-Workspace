import assert from "node:assert/strict";
import { createRequire } from "node:module";

const isVitest = process.env.VITEST === "true" || process.env.VITEST_WORKER_ID !== undefined;
const test = isVitest ? (await import("vitest")).test : (await import("node:test")).default;

const require = createRequire(import.meta.url);
const { createBrowserRuntimeBridge } = require("./browser-runtime-bridge.cjs");

test("browser Runtime bridge grants a manually validated root only to the requesting browser client", async (t) => {
  const attachments = new Map();
  const calls = [];
  const runtimeCalls = [];
  const generatedTemplateCalls = [];
  const designCalls = [];
  const modelCapabilityCalls = [];
  const publishedTemplateDesignChanges = [];
  const designDraft = {
    draftId: "template-design-1",
    templateId: "template-1",
    cwd: "/workspace/project",
    model: "opencode-go/gpt-5.6-luna",
    draftJson: { id: "template-1", name: "Template 1", source: "manual", conductor: {}, agents: [], limits: {}, delivery: {} },
    revision: 2,
    providerSessionId: "ses_design",
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  const discardedDesignDraft = {
    ...designDraft,
    draftId: "template-design-discard-1",
    revision: 7,
  };
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
    createAgentLoopProjectDirectory: async ({ parentPath, name }) => {
      assert.equal(parentPath, "/workspace/selected");
      assert.equal(name, "new-project");
      return { path: "/workspace/new-project", name: "new-project", created: true };
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
    listOpencodeModelCapabilities: async (input) => {
      modelCapabilityCalls.push(input);
      return {
        ok: true,
        source: "opencode-cli-verbose",
        models: [{
          id: "opencode-go/gpt-5.6-luna",
          providerId: "opencode-go",
          modelId: "gpt-5.6-luna",
          name: "GPT-5.6 Luna",
          availability: "available",
          status: "active",
          capabilities: { reasoning: true },
          variants: [{ id: "high", reasoningEffort: "high" }],
        }],
      };
    },
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
      generateTemplateDraft: async (input) => {
        generatedTemplateCalls.push(input);
        return { template: { id: "template-generated" }, assistantMessage: "draft", assumptions: [] };
      },
      listTemplateVersions: async (input) => {
        runtimeCalls.push({ type: "listTemplateVersions", ...input });
        return [
          { id: input.templateId, version: 2, name: "Template 1 v2" },
          { id: input.templateId, version: 1, name: "Template 1" },
        ];
      },
      listTasks: async (input) => {
        runtimeCalls.push({ type: "listTasks", ...input });
        return [];
      },
      openOpenCodeSessionPage: async (input) => {
        runtimeCalls.push({ type: "openSessionPage", ...input });
        return { presentation: "direct_url", providerSessionId: "ses_bound", presentationLeaseId: "presentation-1", url: "http://127.0.0.1:43111/session/ses_bound" };
      },
      releaseOpenCodeSessionPage: async (input) => {
        runtimeCalls.push({ type: "releaseSessionPage", ...input });
        return true;
      },
      resumeAchievedTask: async (input) => {
        runtimeCalls.push({ type: "resumeAchievedTask", ...input });
        return { task: { taskId: input.taskId, status: "running" }, run: { runId: "run-1", status: "running" } };
      },
      moveTaskToRecycleBin: async (input) => {
        runtimeCalls.push({ type: "moveTaskToRecycleBin", ...input });
        return { taskId: input.taskId, status: "archived", revision: 10 };
      },
      restoreTaskFromRecycleBin: async (input) => {
        runtimeCalls.push({ type: "restoreTaskFromRecycleBin", ...input });
        return { taskId: input.taskId, status: "achieved", revision: 11 };
      },
      previewTaskPermanentDeletion: async (input) => {
        runtimeCalls.push({ type: "previewTaskPermanentDeletion", ...input });
        return { taskId: input.taskId, projectCwd: "/workspace/new-project", managedArtifacts: [{ path: "reports/delivery.md", exists: true, deletable: true }] };
      },
      permanentlyDeleteTask: async (input) => {
        runtimeCalls.push({ type: "permanentlyDeleteTask", ...input });
        return { taskId: input.taskId, deleted: true, runsDeleted: 1, runtimeDirectoryRemoved: true, managedArtifactsDeleted: input.artifactPaths, managedArtifactsSkipped: [] };
      },
    }),
    getTemplateDesignRuntime: () => ({
      getOrCreateDesignSession: async (input) => {
        designCalls.push({ type: "getOrCreate", ...input });
        return designDraft;
      },
      listActiveDesignSessions: async (input) => {
        designCalls.push({ type: "listActive", ...input });
        return [{
          draftId: designDraft.draftId,
          templateId: designDraft.templateId,
          cwd: designDraft.cwd,
          model: designDraft.model,
          name: designDraft.draftJson.name,
          revision: designDraft.revision,
          providerSessionId: designDraft.providerSessionId,
          status: "active",
          createdAt: designDraft.createdAt,
          updatedAt: designDraft.updatedAt,
        }];
      },
      readDesignSession: async ({ draftId }) => {
        if (draftId === designDraft.draftId) return designDraft;
        if (draftId === discardedDesignDraft.draftId) return discardedDesignDraft;
        return undefined;
      },
      saveDesignDraft: async (input) => {
        designCalls.push({ type: "save", ...input });
        return { draft: { ...designDraft, revision: 3, status: "active" }, savedTemplate: { id: "template-1", version: 2 } };
      },
      discardDesignDraft: async (input) => {
        designCalls.push({ type: "discard", ...input });
        return { ...discardedDesignDraft, revision: 8, status: "discarded" };
      },
      openDesignSessionPage: async (input) => {
        designCalls.push({ type: "open", ...input });
        return { presentation: "direct_url", providerSessionId: "ses_design", presentationLeaseId: "template-presentation-1", url: "http://127.0.0.1:43111/session/ses_design" };
      },
      releaseDesignSessionPage: async (input) => {
        designCalls.push({ type: "release", ...input });
        return true;
      },
    }),
    publishTemplateDesignChange: (change) => publishedTemplateDesignChanges.push(change),
    readWorkspaceTerminalLog: async () => undefined,
    appendTaskEvent: async () => ({ ok: true }),
    terminalClientAttachments: attachments,
    terminalHostClientId: (ownerId, clientId) => `${ownerId}:${clientId}`,
  });
  const address = await bridge.start();
  afterTest(t, () => bridge.close());

  const status = await fetch(`${address.url}/v1/status`, { headers: { authorization: "Bearer test-token" } });
  assert.deepEqual(await status.json(), { result: { available: true, mode: "desktop", message: "ready" } });

  const templateVersions = await call(address.url, {
    method: "listAgentLoopTemplateVersions",
    input: { templateId: "template-1" },
  });
  assert.deepEqual(templateVersions.body.result, [
    { id: "template-1", version: 2, name: "Template 1 v2" },
    { id: "template-1", version: 1, name: "Template 1" },
  ]);
  assert.deepEqual(runtimeCalls.at(-1), { type: "listTemplateVersions", templateId: "template-1" });

  const models = await call(address.url, {
    method: "listOpencodeModelCapabilities",
    input: { historicalModelIds: ["retired-provider/retired-model"], forceRefresh: true },
  });
  assert.equal(models.body.result.models[0].id, "opencode-go/gpt-5.6-luna");
  assert.deepEqual(modelCapabilityCalls, [{
    historicalModelIds: ["retired-provider/retired-model"],
    forceRefresh: true,
  }]);

  const suggestions = await call(address.url, { method: "suggestAgentLoopProjectDirectories", input: { prefix: "/workspace/typed" } });
  assert.deepEqual(suggestions.body.result, ["/workspace/typed-project/"]);

  const denied = await call(address.url, { method: "createAgentLoopTask", input: { cwd: "/workspace/other", title: "Denied", goal: "Denied" } });
  assert.equal(denied.status, 500);
  assert.equal(denied.body.error, "browser_project_root_not_authorized");

  const created = await call(address.url, { method: "createAgentLoopTask", input: { cwd: "/workspace/project", title: "Allowed", goal: "Allowed" } });
  assert.deepEqual(created.body.result, { taskId: "task-1", cwd: "/workspace/project" });

  const designSession = await call(address.url, {
    method: "getOrCreateAgentLoopTemplateDesignSession",
    input: {
      target: { kind: "existing_template_version", templateId: "template-1" },
      cwd: "/workspace/project",
      model: "opencode-go/gpt-5.6-luna",
      modelVariant: "max",
    },
  });
  assert.equal(designSession.body.result.draft.draftId, "template-design-1");
  const activeDesignSessions = await call(address.url, {
    method: "listActiveAgentLoopTemplateDesignSessions",
    input: { cwd: "/workspace/project" },
  });
  assert.deepEqual(activeDesignSessions.body.result, [{
    draftId: "template-design-1",
    templateId: "template-1",
    cwd: "/workspace/project",
    model: "opencode-go/gpt-5.6-luna",
    name: "Template 1",
    revision: 2,
    providerSessionId: "ses_design",
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  }]);
  const savedDesignSession = await call(address.url, {
    method: "saveAgentLoopTemplateDesignDraft",
    input: { draftId: "template-design-1", expectedRevision: 2 },
  });
  assert.deepEqual(savedDesignSession.body.result, {
    draft: { ...designDraft, revision: 3, status: "active" },
    savedTemplate: { id: "template-1", version: 2 },
  });
  const discardedDesignSession = await call(address.url, {
    method: "discardAgentLoopTemplateDesignDraft",
    input: { draftId: "template-design-discard-1", expectedRevision: 7 },
  });
  assert.deepEqual(discardedDesignSession.body.result, {
    ...discardedDesignDraft,
    revision: 8,
    status: "discarded",
  });
  assert.deepEqual(publishedTemplateDesignChanges, [
    { draftId: "template-design-1", type: "template_design.draft_saved", revision: 3 },
    { draftId: "template-design-discard-1", type: "template_design.draft_discarded", revision: 8 },
  ]);
  const designPage = await call(address.url, { method: "openAgentLoopTemplateDesignSessionPage", input: { draftId: "template-design-1" } });
  assert.equal(designPage.body.result.presentationLeaseId, "template-presentation-1");
  const releasedDesignPage = await call(address.url, { method: "releaseAgentLoopTemplateDesignSessionPage", input: { draftId: "template-design-1", leaseId: "template-presentation-1" } });
  assert.equal(releasedDesignPage.body.result, true);
  assert.deepEqual(designCalls, [
    {
      type: "getOrCreate",
      target: { kind: "existing_template_version", templateId: "template-1" },
      templateId: undefined,
      cwd: "/workspace/project",
      model: "opencode-go/gpt-5.6-luna",
      modelVariant: "max",
    },
    { type: "listActive", cwd: "/workspace/project" },
    { type: "save", draftId: "template-design-1", expectedRevision: 2 },
    { type: "discard", draftId: "template-design-discard-1", expectedRevision: 7 },
    { type: "open", draftId: "template-design-1" },
    { type: "release", draftId: "template-design-1", leaseId: "template-presentation-1" },
  ]);

  const selected = await call(address.url, { method: "validateAgentLoopProjectDirectory", input: { path: "/workspace/typed-project" } });
  assert.deepEqual(selected.body.result, { path: "/workspace/selected", name: "selected" });

  designDraft.cwd = "/workspace/selected";
  const newTemplateDesignSession = await call(address.url, {
    method: "getOrCreateAgentLoopTemplateDesignSession",
    input: {
      target: { kind: "new_template", draftId: "template-design-new-browser" },
      cwd: "/workspace/selected",
      model: "opencode-go/gpt-5.6-luna",
    },
  });
  assert.equal(newTemplateDesignSession.status, 200);
  assert.deepEqual(designCalls.at(-1), {
    type: "getOrCreate",
    target: { kind: "new_template", draftId: "template-design-new-browser" },
    templateId: undefined,
    cwd: "/workspace/selected",
    model: "opencode-go/gpt-5.6-luna",
  });
  const newTemplatePriorRootDenied = await call(address.url, {
    method: "getOrCreateAgentLoopTemplateDesignSession",
    input: {
      target: { kind: "new_template", draftId: "template-design-cross-root" },
      cwd: "/workspace/project",
      model: "opencode-go/gpt-5.6-luna",
    },
  });
  assert.equal(newTemplatePriorRootDenied.status, 500);
  assert.equal(newTemplatePriorRootDenied.body.error, "browser_project_root_not_authorized");
  const designOtherClientDenied = await call(
    address.url,
    { method: "readAgentLoopTemplateDesignSession", input: { draftId: "template-design-1" } },
    "browser-client-5678",
  );
  assert.equal(designOtherClientDenied.status, 500);
  assert.equal(designOtherClientDenied.body.error, "browser_project_root_not_authorized");

  const createdInSelectedRoot = await call(address.url, { method: "createAgentLoopTask", input: { cwd: "/workspace/selected", title: "Selected", goal: "Selected" } });
  assert.deepEqual(createdInSelectedRoot.body.result, { taskId: "task-1", cwd: "/workspace/selected" });

  const openedPage = await call(address.url, { method: "openAgentLoopOpenCodeSessionPage", input: { runId: "run-1", sessionId: "session-1" } });
  assert.deepEqual(openedPage.body.result, {
    presentation: "direct_url",
    providerSessionId: "ses_bound",
    presentationLeaseId: "presentation-1",
    url: "http://127.0.0.1:43111/session/ses_bound",
  });
  const releasedPage = await call(address.url, { method: "releaseAgentLoopOpenCodeSessionPage", input: { runId: "run-1", sessionId: "session-1", leaseId: "presentation-1" } });
  assert.equal(releasedPage.body.result, true);
  assert.deepEqual(runtimeCalls.filter((call) => call.type === "openSessionPage" || call.type === "releaseSessionPage"), [
    { type: "openSessionPage", runId: "run-1", sessionId: "session-1" },
    { type: "releaseSessionPage", runId: "run-1", sessionId: "session-1", leaseId: "presentation-1" },
  ]);

  const resumedTask = await call(address.url, {
    method: "resumeAchievedAgentLoopTask",
    input: { taskId: "task-1", commandId: "command-resume-1", expectedRevision: 9 },
  });
  assert.deepEqual(resumedTask.body.result, {
    task: { taskId: "task-1", status: "running" },
    run: { runId: "run-1", status: "running" },
  });
  assert.deepEqual(runtimeCalls.at(-1), {
    type: "resumeAchievedTask",
    taskId: "task-1",
    commandId: "command-resume-1",
    expectedRevision: 9,
  });

  const trashList = await call(address.url, { method: "listAgentLoopTasks", input: { scope: "trash" } });
  assert.deepEqual(trashList.body.result, []);
  assert.deepEqual(runtimeCalls.at(-1), { type: "listTasks", scope: "trash" });

  const recycledTask = await call(address.url, {
    method: "moveAgentLoopTaskToRecycleBin",
    input: { taskId: "task-1", commandId: "command-recycle-1", expectedRevision: 9 },
  });
  assert.deepEqual(recycledTask.body.result, { taskId: "task-1", status: "archived", revision: 10 });
  assert.deepEqual(runtimeCalls.at(-1), {
    type: "moveTaskToRecycleBin",
    taskId: "task-1",
    commandId: "command-recycle-1",
    expectedRevision: 9,
  });

  const restoredTask = await call(address.url, {
    method: "restoreAgentLoopTaskFromRecycleBin",
    input: { taskId: "task-1", commandId: "command-restore-1", expectedRevision: 10 },
  });
  assert.deepEqual(restoredTask.body.result, { taskId: "task-1", status: "achieved", revision: 11 });
  assert.deepEqual(runtimeCalls.at(-1), {
    type: "restoreTaskFromRecycleBin",
    taskId: "task-1",
    commandId: "command-restore-1",
    expectedRevision: 10,
  });

  const deletionPreview = await call(address.url, {
    method: "previewAgentLoopTaskPermanentDeletion",
    input: { taskId: "task-1" },
  });
  assert.deepEqual(deletionPreview.body.result, {
    taskId: "task-1",
    projectCwd: "/workspace/new-project",
    managedArtifacts: [{ path: "reports/delivery.md", exists: true, deletable: true }],
  });
  assert.deepEqual(runtimeCalls.at(-1), { type: "previewTaskPermanentDeletion", taskId: "task-1" });

  const permanentlyDeleted = await call(address.url, {
    method: "permanentlyDeleteAgentLoopTask",
    input: {
      taskId: "task-1",
      commandId: "command-delete-1",
      expectedRevision: 11,
      artifactPaths: ["reports/delivery.md"],
    },
  });
  assert.deepEqual(permanentlyDeleted.body.result, {
    taskId: "task-1",
    deleted: true,
    runsDeleted: 1,
    runtimeDirectoryRemoved: true,
    managedArtifactsDeleted: ["reports/delivery.md"],
    managedArtifactsSkipped: [],
  });
  assert.deepEqual(runtimeCalls.at(-1), {
    type: "permanentlyDeleteTask",
    taskId: "task-1",
    commandId: "command-delete-1",
    expectedRevision: 11,
    artifactPaths: ["reports/delivery.md"],
  });

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

  const createdProjectDirectory = await call(address.url, {
    method: "createAgentLoopProjectDirectory",
    input: { parentPath: "/workspace/selected", name: "new-project" },
  });
  assert.deepEqual(createdProjectDirectory.body.result, {
    path: "/workspace/new-project",
    name: "new-project",
    created: true,
  });
  const taskInCreatedDirectory = await call(address.url, { method: "createAgentLoopTask", input: { cwd: "/workspace/new-project", title: "New root", goal: "New root" } });
  assert.deepEqual(taskInCreatedDirectory.body.result, { taskId: "task-1", cwd: "/workspace/new-project" });
  const templateInCreatedDirectory = await call(address.url, {
    method: "generateAgentLoopTemplate",
    input: { cwd: "/workspace/new-project", brief: "Create a research loop", model: "opencode-go/gpt-5.6-luna" },
  });
  assert.equal(templateInCreatedDirectory.status, 200);
  assert.deepEqual(generatedTemplateCalls, [{
    cwd: "/workspace/new-project",
    projectName: undefined,
    brief: "Create a research loop",
    model: "opencode-go/gpt-5.6-luna",
  }]);
  const priorSelectedRootDeniedAfterCreate = await call(address.url, { method: "createAgentLoopTask", input: { cwd: "/workspace/selected", title: "Prior root", goal: "Prior root" } });
  assert.equal(priorSelectedRootDeniedAfterCreate.status, 500);
  assert.equal(priorSelectedRootDeniedAfterCreate.body.error, "browser_project_root_not_authorized");
  const priorRootTemplateDeniedAfterCreate = await call(address.url, {
    method: "generateAgentLoopTemplate",
    input: { cwd: "/workspace/selected", brief: "Must not access previous root" },
  });
  assert.equal(priorRootTemplateDeniedAfterCreate.status, 500);
  assert.equal(priorRootTemplateDeniedAfterCreate.body.error, "browser_project_root_not_authorized");

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

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { randomBytes } = require("node:crypto");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const { createOpenCodeHostRuntimeConfig } = require("./opencode/host-config.cjs");
const { createOpenCodeServerManager } = require("./opencode/server-manager.cjs");
const { createOpenCodeServerSessionPageResolver } = require("./opencode/server-session-page.cjs");
const { createLoopTemplateStore } = require("./runtime/loop-template-store.cjs");
const { createTemplateDesignSessionRuntime, templateDesignerPermissionRules } = require("./runtime/template-design-session-runtime.cjs");
const { createTemplateDesignSessionService } = require("./runtime/template-design-session-service.cjs");

const MODEL = "opencode-go/gpt-5.6-luna";
const PROVIDER_VERSION = "1.18.13";

/**
 * Focused, no-billing integration harness for Template Design. It combines the
 * production Template Store/Draft service/Session runtime/Server manager and
 * Server client, while stubbing only the remote OpenCode HTTP responses. No
 * terminal, PTY, custom conversation, or model invocation is involved.
 */
async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-workspace-template-design-host-"));
  const projectRoot = path.join(root, "project");
  const databasePath = path.join(root, "agent-loop-v1.sqlite");
  fs.mkdirSync(projectRoot, { recursive: true });
  const canonicalProjectRoot = fs.realpathSync(projectRoot);

  let db;
  let manager;
  try {
    db = new DatabaseSync(databasePath);
    createTemplateTables(db);
    let uuid = 0;
    const nextUuid = () => `harness-${++uuid}`;
    const templateStore = createLoopTemplateStore({
      db,
      defaultModel: MODEL,
      now: () => "2026-08-04T00:00:00.000Z",
      randomUUID: nextUuid,
    });
    const initial = templateStore.saveTemplate(templateDefinition());
    assert.equal(initial.version, 1);
    assert.equal(templateVersionCount(db, initial.id), 1);
    assert.equal(taskCount(db), 0);

    const templateDesignService = createTemplateDesignSessionService({
      db,
      saveTemplate: templateStore.saveTemplate,
      now: () => "2026-08-04T00:00:00.000Z",
      randomUUID: nextUuid,
      randomBytes,
    });
    const hostConfig = createOpenCodeHostRuntimeConfig({
      cwd: canonicalProjectRoot,
      conductorBridge: bridgeConfig({ name: "conductor" }),
      templateDesignerBridge: bridgeConfig({ name: "template-designer" }),
    });
    const hostContent = hostConfig.content;
    const hostConfigCalls = [];
    assertSharedHostConfig(hostContent);
    assert.ok(hostConfig.environment?.OPENCODE_CONFIG_DIR, "the Manager receives a concrete `{ content, environment }` Host config");
    assert.equal(hostConfig.environment.AGENT_WORKSPACE_TEMPLATE_DESIGNER_BRIDGE_URL, "http://127.0.0.1:45112");
    assert.ok(fs.existsSync(path.join(hostConfig.environment.OPENCODE_CONFIG_DIR, "plugins", "agent-workspace-template-design-capability.js")));

    const provider = createProviderStub();
    manager = createOpenCodeServerManager({
      opencodePath: "/fixture/opencode",
      spawn: provider.spawn,
      fetchImpl: provider.fetch,
      reservePort: async () => 45991,
      expectedProviderVersion: PROVIDER_VERSION,
      idleShutdownMs: 0,
      wait: async () => undefined,
    });

    // A normal Task Run and a Template Design Session intentionally share one
    // project-root Host while retaining different owner leases.
    const taskHost = await manager.ensureRun({
      taskId: "task-1",
      runId: "run-1",
      cwd: projectRoot,
      config: hostConfig,
      leaseId: "task-runtime",
    });
    assert.equal(provider.spawnCalls.length, 1);
    assert.deepEqual(provider.spawnCalls[0].args, ["serve", "--hostname", "127.0.0.1", "--port", "45991"]);
    assert.equal(provider.spawnCalls[0].options.stdio, "ignore");
    assert.equal(provider.spawnCalls[0].options.env.OPENCODE_CONFIG_CONTENT, JSON.stringify(hostConfig.content));
    assert.equal(provider.spawnCalls[0].options.env.OPENCODE_CONFIG_DIR, hostConfig.environment.OPENCODE_CONFIG_DIR);

    const designRuntime = createTemplateDesignSessionRuntime({
      templateDesignService,
      openCodeServerManager: manager,
      readTemplate: ({ templateId }) => templateStore.templateById(templateId),
      createHostConfig: async (input) => {
        hostConfigCalls.push(input);
        return hostConfig;
      },
      resolveOpenCodeSessionPage: ({ server, ...input }) => createOpenCodeServerSessionPageResolver({
        serverOrigin: server.origin,
        fetchImpl: provider.fetch,
        expectedProviderVersion: PROVIDER_VERSION,
      }).openSessionPage(input),
      randomUUID: nextUuid,
    });

    const designTarget = { kind: "existing_template_version", templateId: initial.id };
    const first = await designRuntime.getOrCreateDesignSession({ target: designTarget, cwd: projectRoot, model: MODEL });
    const second = await designRuntime.getOrCreateDesignSession({ target: designTarget, cwd: projectRoot, model: MODEL });
    assert.equal(first.draftId, second.draftId);
    assert.equal(first.providerSessionId, "ses_design001");
    assert.equal(second.providerSessionId, "ses_design001");
    assert.equal(provider.sessionCreateRequests.length, 1, "a Draft gets one persistent provider Session");
    assert.equal(provider.promptRequests.length, 0, "opening or reopening a Draft must not start a Provider turn");
    assert.equal(provider.spawnCalls.length, 1, "the Design Session reused the Task's project Host");
    assert.equal(manager.getRun({ taskId: "task-1", runId: "run-1" }).origin, taskHost.origin);
    assert.equal(templateVersionCount(db, initial.id), 1, "opening/reopening a Draft never saves a Template Version");
    assert.equal(taskCount(db), 0, "Template Design is not a Task path");

    const storedDraft = templateDesignService.readDraft({ draftId: first.draftId });
    const capability = templateDesignService.readDraftCapability({ draftId: first.draftId });
    const patched = templateDesignService.applyStructuredPatch({
      draftId: first.draftId,
      capabilitySecret: capability.capabilitySecret,
      expectedRevision: storedDraft.revision,
      operationId: "harness-charter-patch",
      patch: [{ op: "replace", path: "/conductor/charter", value: "Make independent evidence decisions from durable context." }],
    });
    assert.equal(patched.draft.status, "active");
    assert.equal(templateVersionCount(db, initial.id), 1, "a Draft patch is not an implicit save");
    assert.equal(templateStore.templateById(initial.id).conductor.charter, initial.conductor.charter, "Version v1 remains immutable");

    const page = await designRuntime.openDesignSessionPage({ draftId: first.draftId });
    assert.equal(page.presentation, "direct_url");
    assert.equal(page.providerSessionId, first.providerSessionId);
    assert.match(page.url, /\/session\/ses_design001$/);
    assert.ok(page.presentationLeaseId);
    assert.equal(await designRuntime.releaseDesignSessionPage({ draftId: first.draftId, leaseId: page.presentationLeaseId }), true);
    assert.ok(manager.getRun({ taskId: "task-1", runId: "run-1" }), "closing the Design page never releases the Task Run Host lease");
    assert.deepEqual(hostConfigCalls, [{ cwd: canonicalProjectRoot }, { cwd: canonicalProjectRoot }]);

    const saved = await designRuntime.saveDesignDraft({ draftId: first.draftId, expectedRevision: patched.draft.revision });
    assert.equal(saved.savedTemplate.id, initial.id);
    assert.equal(saved.savedTemplate.version, 2, "only explicit save produces the next immutable Template Version");
    assert.equal(saved.draft.status, "saved");
    assert.equal(templateVersionCount(db, initial.id), 2);
    assert.equal(templateStore.templateById(initial.id, 1).conductor.charter, initial.conductor.charter, "v1 is unchanged after v2 save");
    assert.equal(templateStore.templateById(initial.id, 2).conductor.charter, "Make independent evidence decisions from durable context.");
    assert.equal(taskCount(db), 0);

    assertProviderSessionCreation(provider);
    if (process.argv.includes("--live-host")) await verifyLiveHost({ projectRoot, hostConfig });
    await manager.stopAll();
    assert.equal(provider.child.killedWith, "SIGTERM");
    console.log("template design OpenCode integration harness passed");
  } finally {
    await manager?.stopAll?.();
    db?.close?.();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function templateDefinition() {
  return {
    id: "deepsearch",
    name: "DeepSearch",
    source: "manual",
    conductor: {
      role: "Conductor",
      model: MODEL,
      charter: "Choose Session Agent work from durable task context.",
    },
    agents: [{
      id: "searcher-0",
      name: "Searcher-0",
      kind: "researcher",
      model: MODEL,
      dispatchProfile: {
        title: "Independent evidence research",
        description: "Use when the Conductor needs source-backed external evidence.",
      },
      workerSystemPrompt: "Find dated, primary-source evidence and state uncertainty.",
    }],
    limits: { maxConcurrentSessions: 3, maxDispatchesPerDecision: 3 },
    delivery: { artifactPath: "" },
  };
}

function bridgeConfig({ name }) {
  const templateDesigner = name === "template-designer";
  const prefix = templateDesigner ? "templateDesigner" : "conductor";
  const bridge = {
    [`${prefix}ToolBridgeUrl`]: `http://127.0.0.1:${templateDesigner ? "45112" : "45111"}`,
    [`${prefix}ToolBridgeToken`]: `${name}-harness-token`,
  };
  if (!templateDesigner) bridge[`${prefix}McpServerPath`] = path.join(__dirname, "conductor-mcp-server.cjs");
  return bridge;
}

function assertSharedHostConfig(config) {
  assert.equal(config.default_agent, "build");
  assert.deepEqual(config.tools, {
    "agent_workspace_conductor_*": false,
    "agent_workspace_template_designer_*": false,
  });
  assert.ok(config.mcp.agent_workspace_conductor);
  assert.equal(config.mcp.agent_workspace_template_designer, undefined, "Template Design uses Session-aware custom plugin tools, not an MCP child");
  assert.deepEqual(Object.keys(config.agent), ["agent_workspace_template_designer"]);
  assert.equal(config.agent.agent_workspace_template_designer.mode, "primary");
  assert.equal(config.agent.agent_workspace_template_designer.tools["agent_workspace_template_designer_*"], true);
  assert.equal(config.agent.agent_workspace_template_designer.tools["agent_workspace_conductor_*"], false);
}

function createProviderStub() {
  const spawnCalls = [];
  const requests = [];
  const child = new EventEmitter();
  child.pid = 45991;
  child.kill = (signal) => {
    child.killedWith = signal;
    return true;
  };

  async function fetch(url, options = {}) {
    const parsed = new URL(url);
    const method = String(options.method || "GET").toUpperCase();
    const body = options.body ? JSON.parse(options.body) : undefined;
    requests.push({ pathname: parsed.pathname, method, body });
    if (parsed.pathname === "/global/health") return jsonResponse({ healthy: true, version: PROVIDER_VERSION });
    if (parsed.pathname === "/doc") return jsonResponse({ openapi: "3.1.0" });
    if (parsed.pathname === "/session" && method === "POST") return jsonResponse({ id: "ses_design001" });
    if (parsed.pathname === "/session/ses_design001/prompt_async" && method === "POST") return jsonResponse({ accepted: true });
    if (parsed.pathname === "/session/ses_design001" && method === "GET") return jsonResponse({ id: "ses_design001" });
    return jsonResponse({ error: "unexpected provider request" }, 404);
  }

  return {
    child,
    spawnCalls,
    requests,
    fetch,
    spawn(command, args, options) {
      spawnCalls.push({ command, args, options });
      return child;
    },
    get sessionCreateRequests() { return requests.filter((item) => item.pathname === "/session" && item.method === "POST"); },
    get promptRequests() { return requests.filter((item) => item.pathname.endsWith("/prompt_async") && item.method === "POST"); },
  };
}

function assertProviderSessionCreation(provider) {
  const create = provider.sessionCreateRequests[0];
  assert.equal(create.body.agent, "agent_workspace_template_designer");
  assert.deepEqual(create.body.model, { providerID: "opencode-go", id: "gpt-5.6-luna" });
  assert.equal(create.body.metadata.agentWorkspaceKind, "template_design");
  assert.ok(create.body.metadata.agentWorkspaceDraftId);
  assert.ok(Array.isArray(create.body.permission));
  assert.equal(provider.promptRequests.length, 0, "the Draft capability is resolved only when a user-originated Provider turn invokes a Template Designer tool");
}

function createTemplateTables(db) {
  db.exec(`
    CREATE TABLE agent_loop_template_versions (
      template_id TEXT NOT NULL, version INTEGER NOT NULL, name TEXT NOT NULL, source TEXT NOT NULL,
      conductor_json TEXT NOT NULL, agents_json TEXT NOT NULL, limits_json TEXT NOT NULL, delivery_json TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (template_id, version)
    ) STRICT;
    CREATE TABLE agent_loop_tasks (
      task_id TEXT PRIMARY KEY, template_id TEXT NOT NULL, architecture_json TEXT NOT NULL
    ) STRICT;
  `);
}

async function verifyLiveHost({ projectRoot, hostConfig }) {
  const detected = spawnSync("which", ["opencode"], { encoding: "utf8" }).stdout?.trim();
  const opencodePath = String(process.env.OPENCODE_PATH || detected || "").trim();
  assert.ok(opencodePath, "set OPENCODE_PATH or add opencode to PATH for the live-host probe");
  const providerRequests = [];
  const fetchImpl = async (url, options = {}) => {
    providerRequests.push({ url: String(url), method: String(options.method ?? "GET").toUpperCase() });
    return fetch(url, options);
  };

  const manager = createOpenCodeServerManager({
    opencodePath,
    fetchImpl,
    expectedProviderVersion: PROVIDER_VERSION,
    startupTimeoutMs: 15_000,
    idleShutdownMs: 0,
  });
  let server;
  let probeSessionId;
  let ownerAcquired = false;
  try {
    server = await manager.ensureOwner({
      ownerId: "template-design:live-health-probe",
      cwd: projectRoot,
      config: hostConfig,
      leaseId: "health-probe",
    });
    ownerAcquired = true;
    assert.equal(server.providerVersion, PROVIDER_VERSION);
    assert.equal(server.openApiSchemaVersion, "3.1.0");
    assert.match(server.origin, /^http:\/\/127\.0\.0\.1:\d+$/);
    const toolResponse = await fetch(`${server.origin}/experimental/tool/ids?directory=${encodeURIComponent(projectRoot)}`);
    assert.equal(toolResponse.ok, true, "the live Host exposes its registered tool ids");
    const toolIds = await toolResponse.json();
    assert.ok(toolIds.includes("agent_workspace_template_designer_read_draft"));
    assert.ok(toolIds.includes("agent_workspace_template_designer_apply_patch"));

    const client = manager.clientForOwner({ ownerId: "template-design:live-health-probe" });
    const created = await client.createSession({
      cwd: projectRoot,
      title: "Template Design empty-session probe",
      agent: "agent_workspace_template_designer",
      model: MODEL,
      metadata: { agentWorkspaceKind: "template_design_probe" },
      permission: templateDesignerPermissionRules(),
    });
    probeSessionId = String(created?.id ?? "");
    assert.match(probeSessionId, /^ses_[A-Za-z0-9]+$/);
    assert.equal((await client.getSession({ cwd: projectRoot, providerSessionId: probeSessionId })).id, probeSessionId);
    assert.deepEqual(await client.messages({ cwd: projectRoot, providerSessionId: probeSessionId }), [], "an opened Template Design Session has no automatic user or assistant message");

    const page = await createOpenCodeServerSessionPageResolver({
      serverOrigin: server.origin,
      fetchImpl,
      expectedProviderVersion: PROVIDER_VERSION,
    }).openSessionPage({ cwd: projectRoot, providerSessionId: probeSessionId });
    assert.equal(page.presentation, "direct_url");
    const pageResponse = await fetchImpl(page.url);
    assert.equal(pageResponse.ok, true, "the official WebUI opens the empty Template Design Session");
    assert.match(String(pageResponse.headers.get("content-type") ?? ""), /text\/html/i);
    assert.equal(providerRequests.filter((request) => /\/prompt_async(?:\?|$)/.test(request.url)).length, 0, "opening a Template Design Session never starts a Provider turn");

    console.log("template design live OpenCode host empty-session probe passed");
  } finally {
    if (server?.origin && probeSessionId) {
      const response = await fetchImpl(`${server.origin}/session/${encodeURIComponent(probeSessionId)}?directory=${encodeURIComponent(projectRoot)}`, { method: "DELETE" });
      assert.equal(response.ok, true, "the temporary live-provider Session is removed after the probe");
    }
    if (ownerAcquired) {
      assert.equal(await manager.releaseOwner({ ownerId: "template-design:live-health-probe", leaseId: "health-probe" }), true);
    }
    await manager.stopAll();
  }
}

function templateVersionCount(db, templateId) {
  return Number(db.prepare("SELECT COUNT(*) AS count FROM agent_loop_template_versions WHERE template_id = ?").get(templateId).count);
}

function taskCount(db) {
  return Number(db.prepare("SELECT COUNT(*) AS count FROM agent_loop_tasks").get().count);
}

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return JSON.parse(JSON.stringify(body)); },
  };
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});

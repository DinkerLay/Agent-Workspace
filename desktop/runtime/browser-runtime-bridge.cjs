const path = require("node:path");
const { createRuntimeBridgeHttpServer } = require("./runtime-bridge-http.cjs");

/**
 * Browser-facing transport adapter for a composed local Runtime. It does not
 * own lifecycle state; every command delegates to an existing named owner.
 */
function createBrowserRuntimeBridge({
  token,
  port,
  projectRoot,
  readRuntimeStatus,
  runOpencode,
  sessionAuthority,
  ptyManager,
  getAgentLoopRuntime,
  readWorkspaceTerminalLog,
  appendTaskEvent,
  sanitizeAgentLoopTemplate,
  validateAgentLoopProjectDirectory,
  suggestAgentLoopProjectDirectories,
  terminalClientAttachments,
  terminalHostClientId,
} = {}) {
  const root = path.resolve(requiredFunction(projectRoot, "browser_runtime_project_root")());
  const browserProjectRoots = new Map();
  const attachments = requiredMap(terminalClientAttachments, "browser_runtime_terminal_attachments");
  const toHostClientId = requiredFunction(terminalHostClientId, "browser_runtime_terminal_client_id");
  const runtime = requiredFunction(getAgentLoopRuntime, "browser_runtime_agent_loop_runtime");
  const bridge = createRuntimeBridgeHttpServer({
    token,
    port,
    handlers: createHandlers({
      root,
      readRuntimeStatus: requiredFunction(readRuntimeStatus, "browser_runtime_status"),
      runOpencode: requiredFunction(runOpencode, "browser_runtime_opencode"),
      sessionAuthority: requiredObject(sessionAuthority, "browser_runtime_session_authority"),
      ptyManager: requiredObject(ptyManager, "browser_runtime_pty_manager"),
      runtime,
      readWorkspaceTerminalLog: requiredFunction(readWorkspaceTerminalLog, "browser_runtime_terminal_log"),
      appendTaskEvent: requiredFunction(appendTaskEvent, "browser_runtime_task_event"),
      sanitizeAgentLoopTemplate: requiredFunction(sanitizeAgentLoopTemplate, "browser_runtime_template_sanitizer"),
      validateAgentLoopProjectDirectory: requiredFunction(validateAgentLoopProjectDirectory, "browser_runtime_project_validator"),
      suggestAgentLoopProjectDirectories: requiredFunction(suggestAgentLoopProjectDirectories, "browser_runtime_project_suggester"),
      browserProjectRoots,
      attachments,
      toHostClientId,
    }),
  });
  bridge.onClientDisconnected((browserClientId) => {
    browserProjectRoots.delete(browserClientId);
    detachBrowserTerminalClients({ browserClientId, attachments, ptyManager });
  });

  return {
    start: () => bridge.start(),
    close: () => bridge.close(),
    publishAgentLoopRuntimeEvent: (event) => bridge.publish("agent-loop-runtime", event),
    handleTerminalClientEvent(event, attachment) {
      const target = attachments.get(String(attachment?.clientId ?? ""));
      if (
        !target
        || target.transport !== "browser"
        || target.sessionId !== attachment?.sessionId
        || target.generation !== attachment?.clientGeneration
      ) return false;
      bridge.publish("terminal-client", event, { clientId: target.browserClientId });
      return true;
    },
  };
}

function createHandlers({
  root,
  readRuntimeStatus,
  runOpencode,
  sessionAuthority,
  ptyManager,
  runtime,
  readWorkspaceTerminalLog,
  appendTaskEvent,
  sanitizeAgentLoopTemplate,
  validateAgentLoopProjectDirectory,
  suggestAgentLoopProjectDirectories,
  browserProjectRoots,
  attachments,
  toHostClientId,
}) {
  const projectRoot = (value, browserClientId) => {
    const authorizedRoot = browserProjectRoots.get(browserClientId) ?? root;
    const requested = path.resolve(String(value ?? authorizedRoot));
    if (requested !== authorizedRoot) throw new Error("browser_project_root_not_authorized");
    return authorizedRoot;
  };
  return {
    getRuntimeStatus: async () => browserRuntimeStatus(await readRuntimeStatus()),
    runOpencode: (input, context) => runOpencode({ cwd: projectRoot(input?.cwd, context.clientId), message: String(input?.message ?? ""), model: input?.model ? String(input.model) : undefined, timeoutMs: Number(input?.timeoutMs ?? 120000) }),
    readWorkspaceTerminalLog,
    attachTerminalClient: (input, context) => attachBrowserTerminalClient({ input, browserClientId: context.clientId, attachments, ptyManager, toHostClientId }),
    acknowledgeTerminalOutput: (input, context) => acknowledgeBrowserTerminalOutput({ input, browserClientId: context.clientId, attachments, ptyManager, toHostClientId }),
    detachTerminalClient: (input, context) => detachBrowserTerminalClient({ input, browserClientId: context.clientId, attachments, ptyManager, toHostClientId }),
    enqueueTerminalInput: (input) => sessionAuthority.enqueueInput({ workspaceSessionId: String(input?.workspaceSessionId ?? ""), expectedIncarnationId: String(input?.expectedIncarnationId ?? ""), source: String(input?.source ?? ""), payload: String(input?.payload ?? ""), idempotencyKey: input?.idempotencyKey ? String(input.idempotencyKey) : undefined }),
    resizeWorkspaceSession: (input) => sessionAuthority.resizeSession({ workspaceSessionId: String(input?.workspaceSessionId ?? ""), expectedIncarnationId: input?.expectedIncarnationId ? String(input.expectedIncarnationId) : undefined, cols: Number(input?.cols ?? 100), rows: Number(input?.rows ?? 30) }),
    stopWorkspaceSession: (input) => sessionAuthority.stopSession({ workspaceSessionId: String(input?.workspaceSessionId ?? ""), expectedIncarnationId: input?.expectedIncarnationId ? String(input.expectedIncarnationId) : undefined }),
    appendTaskEvent,
    listAgentLoopTemplates: () => runtime().listTemplates(),
    generateAgentLoopTemplate: (input, context) => runtime().generateTemplateDraft({ cwd: projectRoot(input?.cwd, context.clientId), projectName: input?.projectName ? String(input.projectName) : undefined, brief: String(input?.brief ?? ""), model: input?.model ? String(input.model) : undefined }),
    saveAgentLoopTemplate: (input) => runtime().saveTemplate(sanitizeAgentLoopTemplate(input)),
    copyAgentLoopTemplate: (input) => runtime().copyTemplate({ templateId: String(input?.templateId ?? ""), name: input?.name ? String(input.name) : undefined }),
    archiveAgentLoopTemplate: (input) => runtime().archiveTemplate({ templateId: String(input?.templateId ?? "") }),
    deleteAgentLoopTemplate: (input) => runtime().deleteTemplate({ templateId: String(input?.templateId ?? "") }),
    validateAgentLoopProjectDirectory: async (input, context) => {
      const selected = await validateAgentLoopProjectDirectory({ path: input?.path });
      const cwd = path.resolve(requiredString(selected?.path, "browser_project_root_invalid"));
      browserProjectRoots.set(context.clientId, cwd);
      return { path: cwd, name: String(selected.name ?? (path.basename(cwd) || cwd)) };
    },
    suggestAgentLoopProjectDirectories: (input) => suggestAgentLoopProjectDirectories({ prefix: input?.prefix }),
    createAgentLoopTask: (input, context) => runtime().createTask({ taskId: input?.taskId ? String(input.taskId) : undefined, projectId: input?.projectId ? String(input.projectId) : undefined, cwd: projectRoot(input?.cwd, context.clientId), title: String(input?.title ?? ""), goal: String(input?.goal ?? ""), templateId: input?.templateId ? String(input.templateId) : undefined, templateVersion: input?.templateVersion ? Number(input.templateVersion) : undefined }),
    listAgentLoopTasks: () => runtime().listTasks(),
    readAgentLoopTask: (input) => runtime().readTask({ taskId: String(input?.taskId ?? "") }),
    startAgentLoopRun: (input) => runtime().startRun({ taskId: String(input?.taskId ?? "") }),
    readAgentLoopRun: (input) => {
      const runId = String(input?.runId ?? "");
      return runId ? runtime().readRun({ runId }) : undefined;
    },
    readAgentLoopWorkbenchLayout: (input) => runtime().readWorkbenchLayout({ runId: String(input?.runId ?? "") }),
    saveAgentLoopWorkbenchLayout: (input) => runtime().saveWorkbenchLayout({ runId: String(input?.runId ?? ""), layout: input?.layout }),
    readAgentLoopArtifact: (input) => runtime().readArtifact({ runId: String(input?.runId ?? ""), artifactPath: String(input?.artifactPath ?? "") }),
    markAgentLoopTaskAchieved: (input) => runtime().markTaskAchieved({ taskId: String(input?.taskId ?? "") }),
    stopAgentLoopTask: (input) => runtime().stopTask({ taskId: String(input?.taskId ?? "") }),
    respondAgentLoopPermission: (input) => runtime().respondPermission({ taskId: String(input?.taskId ?? ""), sessionId: String(input?.sessionId ?? ""), permissionId: String(input?.permissionId ?? ""), response: String(input?.response ?? "") }),
    respondAgentLoopQuestion: (input) => runtime().respondSessionQuestion({ taskId: String(input?.taskId ?? ""), sessionId: String(input?.sessionId ?? ""), questionId: String(input?.questionId ?? ""), answer: String(input?.answer ?? "") }),
    deleteAgentLoopTask: (input) => runtime().deleteTask({ taskId: String(input?.taskId ?? "") }),
  };
}

function browserRuntimeStatus(status) {
  const {
    conductorToolBridgeToken: _conductorToolBridgeToken,
    conductorToolBridgeUrl: _conductorToolBridgeUrl,
    conductorMcpServerPath: _conductorMcpServerPath,
    ...safeStatus
  } = status ?? {};
  return safeStatus;
}

async function attachBrowserTerminalClient({ input, browserClientId, attachments, ptyManager, toHostClientId }) {
  const sessionId = String(input?.sessionId ?? "");
  const clientId = String(input?.clientId ?? "");
  const generation = String(input?.generation ?? "");
  if (!sessionId || !clientId || !generation) throw new Error("Terminal attach requires sessionId, clientId, and generation.");
  const hostClientId = toHostClientId(`browser-${browserClientId}`, clientId);
  const prior = attachments.get(hostClientId);
  if (prior) await ptyManager.detachClient({ id: prior.sessionId, clientId: hostClientId, generation: prior.generation });
  const attached = await ptyManager.attachClient({ id: sessionId, clientId: hostClientId, generation });
  if (!attached) return undefined;
  attachments.set(hostClientId, { hostClientId, sessionId, generation, transport: "browser", browserClientId });
  return attached;
}

async function acknowledgeBrowserTerminalOutput({ input, browserClientId, attachments, ptyManager, toHostClientId }) {
  const sessionId = String(input?.sessionId ?? "");
  const clientId = String(input?.clientId ?? "");
  const generation = String(input?.generation ?? "");
  const hostClientId = toHostClientId(`browser-${browserClientId}`, clientId);
  const attachment = attachments.get(hostClientId);
  if (!attachment || attachment.transport !== "browser" || attachment.sessionId !== sessionId || attachment.generation !== generation) {
    return { accepted: false, reason: "terminal_attachment_stale" };
  }
  return ptyManager.acknowledgeOutput({ id: sessionId, clientId: hostClientId, generation, cursor: Number(input?.cursor ?? 0) });
}

async function detachBrowserTerminalClient({ input, browserClientId, attachments, ptyManager, toHostClientId }) {
  const clientId = String(input?.clientId ?? "");
  const generation = String(input?.generation ?? "");
  const hostClientId = toHostClientId(`browser-${browserClientId}`, clientId);
  const attachment = attachments.get(hostClientId);
  if (!attachment || attachment.transport !== "browser" || attachment.generation !== generation) return false;
  attachments.delete(hostClientId);
  return ptyManager.detachClient({ id: attachment.sessionId, clientId: hostClientId, generation });
}

function detachBrowserTerminalClients({ browserClientId, attachments, ptyManager }) {
  for (const [key, attachment] of attachments) {
    if (attachment.transport !== "browser" || attachment.browserClientId !== browserClientId) continue;
    attachments.delete(key);
    void ptyManager.detachClient({ id: attachment.sessionId, clientId: attachment.hostClientId, generation: attachment.generation });
  }
}

function requiredFunction(value, errorCode) {
  if (typeof value !== "function") throw new Error(errorCode);
  return value;
}

function requiredObject(value, errorCode) {
  if (!value || typeof value !== "object") throw new Error(errorCode);
  return value;
}

function requiredMap(value, errorCode) {
  if (!(value instanceof Map)) throw new Error(errorCode);
  return value;
}

function requiredString(value, errorCode) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(errorCode);
  return text;
}

module.exports = { createBrowserRuntimeBridge };

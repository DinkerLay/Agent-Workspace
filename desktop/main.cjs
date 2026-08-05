const path = require("node:path");
const { app, BrowserWindow, ipcMain } = require("electron");
const {
  createConductorToolBridge,
  startConductorToolBridgeHttpServer,
} = require("./conductor-tool-bridge.cjs");
const {
  createTemplateDesignToolBridge,
  startTemplateDesignToolBridgeHttpServer,
} = require("./template-design-tool-bridge.cjs");
const { ensureNodePtySpawnHelperExecutable } = require("./node-pty-runtime.cjs");
const { inspectOpencodeProcesses } = require("./opencode/process-inspector.cjs");
const { createOpenCodeProviderObserver } = require("./opencode/opencode-provider-observer.cjs");
const { createOpenCodeServerSessionPageResolver } = require("./opencode/server-session-page.cjs");
const { createOpenCodeServerManager } = require("./opencode/server-manager.cjs");
const { createOpenCodeHostRuntimeConfig } = require("./opencode/host-config.cjs");
const { createOpencodeModelCapabilityRegistry } = require("./opencode/model-capability-registry.cjs");
const { getRuntimeStatus, listOpencodeAgents, resolveOpencodePath, runOpencode } = require("./opencode-runner.cjs");
const { resolveProjectWindowContext, withProjectWindowContext } = require("./project-window-context.cjs");
const { createOrcaTerminalDaemonManager } = require("./runtime/orca-terminal-daemon-manager.cjs");
const { createOrcaTerminalDaemonSupervisor } = require("./runtime/orca-terminal-daemon-supervisor.cjs");
const { createOpenCodeHookService } = require("./runtime/opencode-hook-service.cjs");
const { createAgentLoopV1Runtime } = require("./runtime/agent-loop-v1-runtime.cjs");
const { createAgentLoopProjectDirectoryService } = require("./runtime/project-directory-service.cjs");
const { createTemplateDesignSessionRuntime } = require("./runtime/template-design-session-runtime.cjs");
const { createBrowserRuntimeBridge } = require("./runtime/browser-runtime-bridge.cjs");
const { createSessionAuthority } = require("./runtime/session-authority.cjs");
const { createSessionStoreCapabilities } = require("./runtime/session-store-capabilities.cjs");
const { createSessionWakeupMonitor } = require("./session-wakeup-monitor.cjs");
const { createSessionStore } = require("./session-store.cjs");
const { generateAgentLoopTemplate } = require("./agent-loop-template-assistant.cjs");
const { generateTaskDraft } = require("./task-draft-assistant.cjs");
const { runVerification } = require("./verification-runner.cjs");
const { isCanonicalWorkspaceSessionId, taskIdFromWorkspaceSessionId } = require("./workspace-session-id.cjs");

const OPENCODE_PROVIDER_VERSION = "1.18.13";
const agentLoopProjectDirectories = createAgentLoopProjectDirectoryService({
  homePath: () => app.getPath("home"),
});

let mainWindow;
let ptyManager;
let sessionAuthority;
let terminalDaemonSupervisor;
let conductorToolBridge;
let conductorToolBridgeHttpServer;
let conductorToolBridgeRuntimeConfig = {};
let conductorToolBridgeStartError;
let templateDesignToolBridge;
let templateDesignToolBridgeHttpServer;
let templateDesignToolBridgeStartPromise;
let templateDesignToolBridgeRuntimeConfig = {};
let templateDesignToolBridgeStartError;
let templateDesignRuntime;
let sessionWakeupMonitor;
let agentLoopRuntime;
let openCodeHookService;
let openCodeProviderObserver;
let openCodeServerManager;
let webRuntimeBridge;
let realPtyAvailable = false;
let ptyBackend = "process-fallback";
const terminalClientAttachments = new Map();
const opencodeModelCapabilityRegistry = createOpencodeModelCapabilityRegistry({
  resolvePath: resolveOpencodePath,
});

const runtimeSessionStore = createSessionStore({
  root: ({ cwd }) => {
    if (!cwd) throw new Error("Project cwd is required before resolving the runtime Session Store root.");
    return path.join(cwd, ".agent-workspace", "runtime");
  },
});
const runtimeSessionCapabilities = createSessionStoreCapabilities(runtimeSessionStore);
const dispatchSessionStore = Object.freeze({
  ...runtimeSessionCapabilities.readModel,
  ...runtimeSessionCapabilities.coordinator,
});
const wakeupSessionStore = Object.freeze({
  ...runtimeSessionCapabilities.readModel,
  ...runtimeSessionCapabilities.taskTimeline,
  ...runtimeSessionCapabilities.coordinator,
  ...runtimeSessionCapabilities.provider,
  ...runtimeSessionCapabilities.terminal,
});

// Semantic state changes are published independently from PTY transport.
// Renderer clients receive only a lightweight invalidation and re-read the
// durable Run; raw TUI output continues over the Orca-style terminal stream.
runtimeSessionCapabilities.readModel.onTaskChange?.((change) => publishAgentLoopRuntimeChange(change));

try {
  // Electron Main must not own node-pty. This only verifies that the isolated
  // local daemon can load its native backend when it starts.
  ensureNodePtySpawnHelperExecutable();
  require.resolve("node-pty");
  realPtyAvailable = true;
  ptyBackend = "orca-local-daemon+node-pty";
} catch (error) {
  realPtyAvailable = false;
  ptyBackend = `orca-local-daemon-unavailable:${error instanceof Error ? error.message : "node-pty unavailable"}`;
}

terminalDaemonSupervisor = createOrcaTerminalDaemonSupervisor();
ptyManager = createOrcaTerminalDaemonManager({
  endpointProvider: () => terminalDaemonSupervisor.start(),
  sessionStore: runtimeSessionCapabilities.terminal,
});

sessionAuthority = createSessionAuthority({
  ptyManager,
  databasePath: path.join(app.getPath("userData"), "agent-workspace", "terminal-runtime.sqlite"),
});
ptyManager.onEvent((event) => {
  sessionAuthority.handlePtyEvent(event);
  if (event?.type === "exit") openCodeHookService?.clearSession?.(event.id);
});
ptyManager.onClientEvent((event, attachment) => {
  const target = terminalClientAttachments.get(String(attachment?.clientId ?? ""));
  if (
    !target
    || target.sessionId !== attachment?.sessionId
    || target.generation !== attachment?.clientGeneration
  ) {
    return;
  }
  if (webRuntimeBridge?.handleTerminalClientEvent(event, attachment)) return;
  if (!isLiveWebContents(target.webContents)) {
    terminalClientAttachments.delete(target.hostClientId);
    void ptyManager.detachClient({
      id: target.sessionId,
      clientId: target.hostClientId,
      generation: target.generation,
    });
    return;
  }
  sendTerminalClientEvent(target.webContents, event);
});

conductorToolBridge = createConductorToolBridge({
  sessionStore: dispatchSessionStore,
  ptyManager,
  activateWorkerSession: async ({ sessionId, operationId, interactiveTui }) =>
    sessionAuthority.activateSession({
      workspaceSessionId: sessionId,
      operationId,
      callerId: "conductor-tool-bridge",
      reason: "conductor-dispatch",
      interactiveTui: interactiveTui === true,
    }),
  prepareWorkerSession: ({ taskId, agentId, sessionId, initialPrompt }) =>
    agentLoopRuntime?.hasTask(taskId)
      ? agentLoopRuntime.prepareWorkerInitialDispatch({ taskId, agentId, sessionId, initialPrompt })
      : { initialPromptSubmitted: false, sessionId },
  enqueueWorkerInput: ({ sessionId, expectedIncarnationId, source = "dispatch", payload, idempotencyKey }) =>
    sessionAuthority.enqueueInput({
      workspaceSessionId: sessionId,
      expectedIncarnationId,
      source,
      payload,
      idempotencyKey,
    }),
  enqueueWorkerInteractiveSubmission: ({ sessionId, expectedIncarnationId, source = "dispatch", text, idempotencyKey }) =>
    sessionAuthority.enqueueInteractiveSubmission({
      workspaceSessionId: sessionId,
      expectedIncarnationId,
      source,
      text,
      idempotencyKey,
    }),
  readTerminalSessionFact: ({ workspaceSessionId, incarnationId, generation }) =>
    sessionAuthority.readSessionOwner({ workspaceSessionId, incarnationId, generation }),
  resolveAgentSession: ({ taskId, agentId }) =>
    agentLoopRuntime?.hasTask(taskId) ? agentLoopRuntime.resolveAgentSession({ taskId, agentId }) : undefined,
  getTaskAgentMap: ({ taskId }) =>
    agentLoopRuntime?.hasTask(taskId) ? agentLoopRuntime.taskAgentMap({ taskId }) : undefined,
  validateDispatch: ({ taskId, agentId, toSessionId }) => {
    if (!taskId || !agentId || !toSessionId) return { ok: false, reason: "missing-task-agent-or-session" };
    if (!isCanonicalWorkspaceSessionId(toSessionId)) return { ok: false, reason: "invalid-session-id" };
    if (agentLoopRuntime?.hasTask(taskId)) return agentLoopRuntime.validateDispatch({ taskId, agentId, toSessionId });
    return { ok: true };
  },
  prepareDispatchContext: ({ taskId, agentId, toSessionId, contextRefs }) => {
    if (!agentLoopRuntime?.hasTask(taskId)) return { contextRefs: contextRefs ?? [], contextPackets: [] };
    return agentLoopRuntime.prepareDispatchContext({ taskId, agentId, toSessionId, contextRefs });
  },
  deliverProviderAssignment: (input) => agentLoopRuntime?.deliverOpenCodeWorkerAssignment(input) ?? { notApplicable: true },
  abortProviderDispatch: (input) => agentLoopRuntime?.abortOpenCodeDispatch(input),
  resolveConductorSessionId: ({ taskId }) => agentLoopRuntime?.resolveAgentSession({ taskId, agentId: "conductor" })?.sessionId,
  onCompletionClaim: ({ taskId, sessionId, message, summary }) => {
    if (!agentLoopRuntime?.hasTask(taskId)) return undefined;
    return agentLoopRuntime.recordCompletionClaim({ taskId, sessionId, message, summary });
  },
});

sessionWakeupMonitor = createSessionWakeupMonitor({
  ptyManager,
  sessionStore: wakeupSessionStore,
  providerObserver: (openCodeProviderObserver ??= createOpenCodeProviderObserver()),
  conductorMessageReader: readProviderConductorMessage,
  conductorQuestionReader: readProviderConductorQuestion,
  resolveAgentId: ({ taskId, sessionId }) => {
    if (!agentLoopRuntime?.hasTask(taskId)) return undefined;
    return agentLoopRuntime.taskAgentMap({ taskId })[sessionId];
  },
  enqueueConductorInput: ({ sessionId, expectedIncarnationId, source, payload, idempotencyKey }) =>
    sessionAuthority.enqueueInput({
      workspaceSessionId: sessionId,
      expectedIncarnationId,
      source,
      payload,
      idempotencyKey,
    }),
  enqueueConductorInteractiveSubmission: ({ sessionId, expectedIncarnationId, source, text, idempotencyKey }) =>
    sessionAuthority.enqueueInteractiveSubmission({
      workspaceSessionId: sessionId,
      expectedIncarnationId,
      source,
      text,
      idempotencyKey,
    }),
  ensureConductorWakeupTarget: ({ taskId, sessionId }) => {
    return agentLoopRuntime?.hasTask(taskId)
      ? agentLoopRuntime.ensureConductorWakeupTarget({ taskId, sessionId })
      : undefined;
  },
  listConductorWakeupTargets: () => agentLoopRuntime?.listConductorWakeupTargets() ?? [],
  onConductorWaiting: ({ taskId }) =>
    agentLoopRuntime?.hasTask(taskId)
      ? agentLoopRuntime.flushPendingUserMessages({ taskId }).catch(() => undefined)
      : undefined,
  onConductorWakeupAccepted: ({ taskId, wakeupKey }) =>
    agentLoopRuntime?.hasTask(taskId)
      ? agentLoopRuntime.resumeTaskForConductorInput({
        taskId,
        cause: "runtime_wakeup",
        inputId: wakeupKey,
      })
      : undefined,
});
sessionWakeupMonitor.start();

const conductorToolBridgeHttpServerPromise = startConductorToolBridgeHttpServer({ bridge: conductorToolBridge })
  .then((bridgeServer) => {
    conductorToolBridgeHttpServer = bridgeServer;
    conductorToolBridgeRuntimeConfig = {
      conductorToolBridgeUrl: bridgeServer.url,
      conductorToolBridgeToken: bridgeServer.token,
      conductorMcpServerPath: path.join(__dirname, "conductor-mcp-server.cjs"),
    };
    return bridgeServer;
  })
  .catch((error) => {
    conductorToolBridgeStartError = error;
    conductorToolBridgeRuntimeConfig = {
      conductorMcpServerPath: path.join(__dirname, "conductor-mcp-server.cjs"),
    };
    return undefined;
  });

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 960,
    minHeight: 680,
    title: "Agent Workspace",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.cjs"),
    },
  });

  const projectContext = resolveProjectWindowContext({
    projectPath: process.env.AGENT_WORKSPACE_PROJECT_PATH || process.cwd(),
    projectName: process.env.AGENT_WORKSPACE_PROJECT_NAME,
  });
  const devServerUrl = process.env.AGENT_WORKSPACE_DEV_SERVER_URL;
  if (devServerUrl) {
    void mainWindow.loadURL(withProjectWindowContext(devServerUrl, projectContext));
    if (process.env.AGENT_WORKSPACE_OPEN_DEVTOOLS === "1") {
      mainWindow.webContents.openDevTools({ mode: "detach" });
    }
    return;
  }

  void mainWindow.loadFile(path.join(__dirname, "..", "dist", "index.html"), { query: projectContext });
}

app.whenReady().then(async () => {
  // The active Agent Loop uses OpenCode Server Sessions and the official Web
  // UI. Legacy terminal IPC remains lazy for compatibility, but it must not
  // create an Orca daemon merely because the desktop host opened.
  await startWebRuntimeBridge().catch((error) => {
    console.error(`Local browser Runtime Host failed to start: ${error instanceof Error ? error.message : "unknown error"}`);
  });
  registerIpc();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  sessionWakeupMonitor?.stop?.();
  void openCodeProviderObserver?.close?.();
  agentLoopRuntime?.close?.();
  void openCodeServerManager?.stopAll?.();
  void openCodeHookService?.close?.();
  void ptyManager?.close?.();
  void terminalDaemonSupervisor?.stop?.();
  void webRuntimeBridge?.close?.();
  sessionAuthority?.close?.();
  void conductorToolBridgeHttpServer?.close?.();
  void templateDesignToolBridgeHttpServer?.close?.();
});

function registerIpc() {
  ipcMain.handle("native:get-runtime-status", () => readRuntimeStatus());

  ipcMain.handle("native:run-opencode", (_event, input) =>
    runOpencode({
      cwd: String(input?.cwd ?? ""),
      message: String(input?.message ?? ""),
      model: input?.model ? String(input.model) : undefined,
      timeoutMs: Number(input?.timeoutMs ?? 120000),
    }),
  );

  ipcMain.handle("native:generate-task-draft", (_event, input) =>
    generateTaskDraft({
      message: String(input?.message ?? ""),
      projectPath: String(input?.projectPath ?? process.cwd()),
      projectName: input?.projectName ? String(input.projectName) : undefined,
      model: input?.model ? String(input.model) : undefined,
      currentDraft: input?.currentDraft && typeof input.currentDraft === "object" ? input.currentDraft : undefined,
      timeoutMs: Number(input?.timeoutMs ?? 120000),
    }),
  );

  ipcMain.handle("native:list-opencode-agents", () => listOpencodeAgents());
  ipcMain.handle("native:list-opencode-model-capabilities", (_event, input) =>
    opencodeModelCapabilityRegistry.list({
      historicalModelIds: Array.isArray(input?.historicalModelIds)
        ? input.historicalModelIds.map((value) => String(value))
        : undefined,
      forceRefresh: input?.forceRefresh === true,
    }),
  );

  ipcMain.handle("native:inspect-opencode-processes", () => {
    try {
      return {
        ok: true,
        processes: inspectOpencodeProcesses(),
      };
    } catch (error) {
      return {
        ok: false,
        processes: [],
        error: error instanceof Error ? error.message : "Unable to inspect opencode processes.",
      };
    }
  });

  ipcMain.handle("native:run-verification", (_event, input) =>
    runVerification({
      cwd: String(input?.cwd ?? ""),
      runId: String(input?.runId ?? ""),
      command: String(input?.command ?? ""),
      timeoutMs: Number(input?.timeoutMs ?? 120000),
    }),
  );

  ipcMain.handle("native:register-workspace-session-profile", (_event, input) =>
    sessionAuthority.registerLaunchProfile(buildWorkspaceSessionLaunchProfile(input)),
  );

  ipcMain.handle("native:activate-workspace-session", (_event, input) =>
    sessionAuthority.activateSession({
      workspaceSessionId: String(input?.workspaceSessionId ?? ""),
      operationId: String(input?.operationId ?? ""),
      callerId: "renderer",
      reason: "user-or-task-runtime",
    }),
  );

  ipcMain.handle("native:read-workspace-session", (_event, input) =>
    sessionAuthority.readSession({
      workspaceSessionId: String(input?.workspaceSessionId ?? ""),
      cursor: Number(input?.cursor ?? 0),
    }),
  );

  // Raw terminal output is diagnostic evidence, not a task-state or
  // Conductor-input channel. Scope it to the Task's registered Session map
  // and pass the durable Task cwd so a restarted desktop process can resolve
  // the project-local Session Store root without guessing.
  ipcMain.handle("native:read-workspace-terminal-log", (_event, input) => readWorkspaceTerminalLog(input));

  ipcMain.handle("native:attach-terminal-client", async (event, input) => {
    const sessionId = String(input?.sessionId ?? "");
    const clientId = String(input?.clientId ?? "");
    const generation = String(input?.generation ?? "");
    if (!sessionId || !clientId || !generation) throw new Error("Terminal attach requires sessionId, clientId, and generation.");
    const hostClientId = terminalHostClientId(event.sender.id, clientId);
    const prior = terminalClientAttachments.get(hostClientId);
    if (prior) await ptyManager.detachClient({ id: prior.sessionId, clientId: hostClientId, generation: prior.generation });
    const attached = await ptyManager.attachClient({ id: sessionId, clientId: hostClientId, generation });
    if (!attached) return undefined;
    terminalClientAttachments.set(hostClientId, { hostClientId, sessionId, generation, webContents: event.sender });
    watchTerminalClient(event.sender);
    return attached;
  });

  ipcMain.handle("native:ack-terminal-output", async (event, input) => {
    const sessionId = String(input?.sessionId ?? "");
    const clientId = String(input?.clientId ?? "");
    const generation = String(input?.generation ?? "");
    const hostClientId = terminalHostClientId(event.sender.id, clientId);
    const attachment = terminalClientAttachments.get(hostClientId);
    if (!attachment || attachment.sessionId !== sessionId || attachment.generation !== generation) {
      return { accepted: false, reason: "terminal_attachment_stale" };
    }
    return ptyManager.acknowledgeOutput({ id: sessionId, clientId: hostClientId, generation, cursor: Number(input?.cursor ?? 0) });
  });

  ipcMain.handle("native:detach-terminal-client", async (event, input) => {
    const clientId = String(input?.clientId ?? "");
    const generation = String(input?.generation ?? "");
    const hostClientId = terminalHostClientId(event.sender.id, clientId);
    const attachment = terminalClientAttachments.get(hostClientId);
    if (!attachment || attachment.generation !== generation) return false;
    terminalClientAttachments.delete(hostClientId);
    return ptyManager.detachClient({ id: attachment.sessionId, clientId: hostClientId, generation });
  });

  ipcMain.handle("native:enqueue-terminal-input", (_event, input) =>
    sessionAuthority.enqueueInput({
      workspaceSessionId: String(input?.workspaceSessionId ?? ""),
      expectedIncarnationId: String(input?.expectedIncarnationId ?? ""),
      source: String(input?.source ?? ""),
      payload: String(input?.payload ?? ""),
      idempotencyKey: input?.idempotencyKey ? String(input.idempotencyKey) : undefined,
    }),
  );

  ipcMain.handle("native:resize-workspace-session", (_event, input) =>
    sessionAuthority.resizeSession({
      workspaceSessionId: String(input?.workspaceSessionId ?? ""),
      expectedIncarnationId: input?.expectedIncarnationId ? String(input.expectedIncarnationId) : undefined,
      cols: Number(input?.cols ?? 100),
      rows: Number(input?.rows ?? 30),
    }),
  );

  ipcMain.handle("native:stop-workspace-session", (_event, input) =>
    sessionAuthority.stopSession({
      workspaceSessionId: String(input?.workspaceSessionId ?? ""),
      expectedIncarnationId: input?.expectedIncarnationId ? String(input.expectedIncarnationId) : undefined,
    }),
  );

  ipcMain.handle("native:call-session", (_event, input) => conductorToolBridge.callSession(input));

  ipcMain.handle("native:call-sessions", (_event, input) => conductorToolBridge.callSessions(input));

  ipcMain.handle("native:read-task-state", (_event, input) => conductorToolBridge.readTaskState(input));

  ipcMain.handle("native:read-session", (_event, input) => conductorToolBridge.readSession(input));

  // Active product surface: pure Conductor-driven Agent Loop. Historical
  // Workflow/Blueprint harnesses are standalone test executables and are not
  // registered as production IPC capabilities.
  ipcMain.handle("native:list-agent-loop-templates", () => ensureAgentLoopRuntime().listTemplates());

  ipcMain.handle("native:list-agent-loop-template-versions", (_event, input) =>
    ensureAgentLoopRuntime().listTemplateVersions({ templateId: String(input?.templateId ?? "") }),
  );

  ipcMain.handle("native:generate-agent-loop-template", (_event, input) =>
    ensureAgentLoopRuntime().generateTemplateDraft({
      cwd: String(input?.cwd ?? process.cwd()),
      projectName: input?.projectName ? String(input.projectName) : undefined,
      brief: String(input?.brief ?? ""),
      model: input?.model ? String(input.model) : undefined,
    }),
  );

  ipcMain.handle("native:save-agent-loop-template", (_event, input) =>
    ensureAgentLoopRuntime().saveTemplate(input),
  );

  ipcMain.handle("native:copy-agent-loop-template", (_event, input) =>
    ensureAgentLoopRuntime().copyTemplate({ templateId: String(input?.templateId ?? ""), name: input?.name ? String(input.name) : undefined }),
  );

  ipcMain.handle("native:archive-agent-loop-template", (_event, input) =>
    ensureAgentLoopRuntime().archiveTemplate({ templateId: String(input?.templateId ?? "") }),
  );

  ipcMain.handle("native:delete-agent-loop-template", (_event, input) =>
    ensureAgentLoopRuntime().deleteTemplate({ templateId: String(input?.templateId ?? "") }),
  );

  // Template Design is a distinct Draft/Provider Session surface. It never
  // creates a Task; only the explicit save command creates a new immutable
  // Template Version through the Draft service.
  ipcMain.handle("native:get-or-create-agent-loop-template-design-session", async (_event, input) => {
    const project = await validateAgentLoopProjectDirectory({ path: input?.cwd });
    const draft = await ensureTemplateDesignRuntime().getOrCreateDesignSession({
      target: input?.target,
      // Compatibility for renderer builds that predate the discriminated
      // target. The Template Design Runtime normalizes it before provisioning.
      templateId: input?.target ? undefined : String(input?.templateId ?? ""),
      ...(input?.target || input?.templateVersion === undefined ? {} : { templateVersion: Number(input.templateVersion) }),
      cwd: project.path,
      model: input?.model ? String(input.model) : undefined,
      ...(input?.modelVariant ? { modelVariant: String(input.modelVariant) } : {}),
    });
    return { draft, providerSessionId: draft.providerSessionId };
  });
  ipcMain.handle("native:list-active-agent-loop-template-design-sessions", async (_event, input) => {
    const project = await validateAgentLoopProjectDirectory({ path: input?.cwd });
    return ensureTemplateDesignRuntime().listActiveDesignSessions({ cwd: project.path });
  });
  ipcMain.handle("native:read-agent-loop-template-design-session", (_event, input) =>
    ensureTemplateDesignRuntime().readDesignSession({ draftId: String(input?.draftId ?? "") }),
  );
  ipcMain.handle("native:save-agent-loop-template-design-draft", async (_event, input) => {
    const saved = await ensureTemplateDesignRuntime().saveDesignDraft({
      draftId: String(input?.draftId ?? ""),
      expectedRevision: Number(input?.expectedRevision),
    });
    publishTemplateDesignChange({
      draftId: saved.draft.draftId,
      type: "template_design.draft_saved",
      revision: saved.draft.revision,
    });
    return saved;
  });
  ipcMain.handle("native:discard-agent-loop-template-design-draft", async (_event, input) => {
    const draft = await ensureTemplateDesignRuntime().discardDesignDraft({
      draftId: String(input?.draftId ?? ""),
      expectedRevision: Number(input?.expectedRevision),
    });
    publishTemplateDesignChange({
      draftId: draft.draftId,
      type: "template_design.draft_discarded",
      revision: draft.revision,
    });
    return draft;
  });
  ipcMain.handle("native:open-agent-loop-template-design-session-page", (_event, input) =>
    ensureTemplateDesignRuntime().openDesignSessionPage({ draftId: String(input?.draftId ?? "") }),
  );
  ipcMain.handle("native:release-agent-loop-template-design-session-page", (_event, input) =>
    ensureTemplateDesignRuntime().releaseDesignSessionPage({
      draftId: String(input?.draftId ?? ""),
      leaseId: String(input?.leaseId ?? ""),
    }),
  );

  ipcMain.handle("native:validate-agent-loop-project-directory", (_event, input) =>
    validateAgentLoopProjectDirectory({ path: input?.path }),
  );
  ipcMain.handle("native:suggest-agent-loop-project-directories", (_event, input) =>
    suggestAgentLoopProjectDirectories({ prefix: input?.prefix }),
  );
  ipcMain.handle("native:create-agent-loop-project-directory", (_event, input) =>
    createAgentLoopProjectDirectory({ parentPath: input?.parentPath, name: input?.name }),
  );

  ipcMain.handle("native:create-agent-loop-task", async (_event, input) => {
    const project = await validateAgentLoopProjectDirectory({ path: input?.cwd });
    return ensureAgentLoopRuntime().createTask({
      taskId: input?.taskId ? String(input.taskId) : undefined,
      projectId: input?.projectId ? String(input.projectId) : undefined,
      cwd: project.path,
      title: String(input?.title ?? ""),
      goal: String(input?.goal ?? ""),
      templateId: input?.templateId ? String(input.templateId) : undefined,
      templateVersion: input?.templateVersion ? Number(input.templateVersion) : undefined,
    });
  });

  ipcMain.handle("native:list-agent-loop-tasks", (_event, input) =>
    ensureAgentLoopRuntime().listTasks({ scope: input?.scope ? String(input.scope) : undefined }),
  );

  ipcMain.handle("native:read-agent-loop-task", (_event, input) =>
    ensureAgentLoopRuntime().readTask({ taskId: String(input?.taskId ?? "") }),
  );

  ipcMain.handle("native:start-agent-loop-run", (_event, input) =>
    ensureAgentLoopRuntime().startRun({
      taskId: String(input?.taskId ?? ""),
      commandId: String(input?.commandId ?? ""),
      expectedRevision: Number.isSafeInteger(input?.expectedRevision) ? input.expectedRevision : undefined,
    }),
  );

  ipcMain.handle("native:read-agent-loop-run", (_event, input) => {
    const runId = String(input?.runId ?? "");
    return runId ? ensureAgentLoopRuntime().readRun({ runId }) : undefined;
  });
  ipcMain.handle("native:open-agent-loop-opencode-session-page", (_event, input) =>
    ensureAgentLoopRuntime().openOpenCodeSessionPage({
      runId: String(input?.runId ?? ""),
      sessionId: String(input?.sessionId ?? ""),
    }),
  );
  ipcMain.handle("native:release-agent-loop-opencode-session-page", (_event, input) =>
    ensureAgentLoopRuntime().releaseOpenCodeSessionPage({
      runId: String(input?.runId ?? ""),
      sessionId: String(input?.sessionId ?? ""),
      leaseId: String(input?.leaseId ?? ""),
    }),
  );
  ipcMain.handle("native:read-agent-loop-workbench-layout", (_event, input) =>
    ensureAgentLoopRuntime().readWorkbenchLayout({ runId: String(input?.runId ?? "") }),
  );
  ipcMain.handle("native:save-agent-loop-workbench-layout", (_event, input) =>
    ensureAgentLoopRuntime().saveWorkbenchLayout({ runId: String(input?.runId ?? ""), layout: input?.layout }),
  );

  ipcMain.handle("native:read-agent-loop-artifact", (_event, input) =>
    ensureAgentLoopRuntime().readArtifact({ runId: String(input?.runId ?? ""), artifactPath: String(input?.artifactPath ?? "") }),
  );

  ipcMain.handle("native:mark-agent-loop-task-achieved", (_event, input) =>
    ensureAgentLoopRuntime().markTaskAchieved({
      taskId: String(input?.taskId ?? ""),
      commandId: String(input?.commandId ?? ""),
      expectedRevision: Number.isSafeInteger(input?.expectedRevision) ? input.expectedRevision : undefined,
    }),
  );

  ipcMain.handle("native:resume-achieved-agent-loop-task", (_event, input) =>
    ensureAgentLoopRuntime().resumeAchievedTask({
      taskId: String(input?.taskId ?? ""),
      commandId: String(input?.commandId ?? ""),
      expectedRevision: Number.isSafeInteger(input?.expectedRevision) ? input.expectedRevision : undefined,
    }),
  );

  ipcMain.handle("native:stop-agent-loop-task", (_event, input) =>
    ensureAgentLoopRuntime().stopTask({
      taskId: String(input?.taskId ?? ""),
      commandId: String(input?.commandId ?? ""),
      expectedRevision: Number.isSafeInteger(input?.expectedRevision) ? input.expectedRevision : undefined,
    }),
  );

  ipcMain.handle("native:respond-agent-loop-permission", (_event, input) =>
    ensureAgentLoopRuntime().respondPermission({
      taskId: String(input?.taskId ?? ""),
      sessionId: String(input?.sessionId ?? ""),
      permissionId: String(input?.permissionId ?? ""),
      response: String(input?.response ?? ""),
    }),
  );

  ipcMain.handle("native:respond-agent-loop-question", (_event, input) =>
    ensureAgentLoopRuntime().respondSessionQuestion({
      taskId: String(input?.taskId ?? ""),
      sessionId: String(input?.sessionId ?? ""),
      questionId: String(input?.questionId ?? ""),
      answer: String(input?.answer ?? ""),
    }),
  );

  ipcMain.handle("native:move-agent-loop-task-to-recycle-bin", (_event, input) =>
    ensureAgentLoopRuntime().moveTaskToRecycleBin({
      taskId: String(input?.taskId ?? ""),
      commandId: String(input?.commandId ?? ""),
      expectedRevision: Number.isSafeInteger(input?.expectedRevision) ? input.expectedRevision : undefined,
    }),
  );

  ipcMain.handle("native:restore-agent-loop-task-from-recycle-bin", (_event, input) =>
    ensureAgentLoopRuntime().restoreTaskFromRecycleBin({
      taskId: String(input?.taskId ?? ""),
      commandId: String(input?.commandId ?? ""),
      expectedRevision: Number.isSafeInteger(input?.expectedRevision) ? input.expectedRevision : undefined,
    }),
  );

  ipcMain.handle("native:preview-agent-loop-task-permanent-deletion", (_event, input) =>
    ensureAgentLoopRuntime().previewTaskPermanentDeletion({ taskId: String(input?.taskId ?? "") }),
  );

  ipcMain.handle("native:permanently-delete-agent-loop-task", (_event, input) =>
    ensureAgentLoopRuntime().permanentlyDeleteTask({
      taskId: String(input?.taskId ?? ""),
      commandId: String(input?.commandId ?? ""),
      expectedRevision: Number.isSafeInteger(input?.expectedRevision) ? input.expectedRevision : undefined,
      artifactPaths: Array.isArray(input?.artifactPaths) ? input.artifactPaths.map(String) : [],
    }),
  );

  ipcMain.handle("native:delete-agent-loop-task", (_event, input) =>
    ensureAgentLoopRuntime().deleteTask({
      taskId: String(input?.taskId ?? ""),
      commandId: String(input?.commandId ?? ""),
      expectedRevision: Number.isSafeInteger(input?.expectedRevision) ? input.expectedRevision : undefined,
      artifactPaths: Array.isArray(input?.artifactPaths) ? input.artifactPaths.map(String) : [],
    }),
  );

  ipcMain.handle("native:append-task-event", (_event, input) => appendTaskEvent(input));

  ipcMain.handle("native:send-agent-loop-task-message", (_event, input) =>
    ensureAgentLoopRuntime().recordUserMessage({
      taskId: String(input?.taskId ?? ""),
      message: String(input?.message ?? ""),
      commandId: String(input?.commandId ?? ""),
      expectedRevision: Number.isSafeInteger(input?.expectedRevision) ? input.expectedRevision : undefined,
    }),
  );
}

function publishAgentLoopRuntimeChange(change) {
  const taskId = String(change?.taskId ?? "");
  if (!taskId || !agentLoopRuntime?.hasTask(taskId)) return;
  const task = agentLoopRuntime.readTask({ taskId });
  const runId = task?.latestRun?.runId;
  if (!runId) return;
  const payload = {
    taskId,
    runId,
    type: String(change?.type ?? "runtime.state_changed"),
    ...(change?.sessionId ? { sessionId: String(change.sessionId) } : {}),
    ...(Number.isFinite(change?.cursor) ? { cursor: change.cursor } : {}),
  };
  for (const window of BrowserWindow.getAllWindows()) {
    if (isLiveWebContents(window.webContents)) window.webContents.send("native:agent-loop-runtime-event", payload);
  }
  webRuntimeBridge?.publishAgentLoopRuntimeEvent(payload);
}

function publishTemplateDesignChange(change) {
  const draftId = String(change?.draftId ?? "");
  const revision = Number(change?.revision);
  if (!draftId || !Number.isSafeInteger(revision) || revision < 1) return;
  const payload = {
    draftId,
    type: String(change?.type ?? "template_design.draft_patched"),
    revision,
  };
  for (const window of BrowserWindow.getAllWindows()) {
    if (isLiveWebContents(window.webContents)) window.webContents.send("native:agent-loop-template-design-event", payload);
  }
  webRuntimeBridge?.publishAgentLoopTemplateDesignEvent(payload);
}

async function startWebRuntimeBridge() {
  const token = String(process.env.AGENT_WORKSPACE_WEB_BRIDGE_TOKEN ?? "");
  const port = Number(process.env.AGENT_WORKSPACE_WEB_HOST_PORT);
  if (!token || !Number.isSafeInteger(port) || port < 1 || port > 65_535) return undefined;
  const bridge = createBrowserRuntimeBridge({
    token,
    port,
    projectRoot: () => process.env.AGENT_WORKSPACE_PROJECT_PATH || process.cwd(),
    readRuntimeStatus,
    runOpencode,
    listOpencodeModelCapabilities: (input) => opencodeModelCapabilityRegistry.list(input),
    sessionAuthority,
    ptyManager,
    getAgentLoopRuntime: ensureAgentLoopRuntime,
    getTemplateDesignRuntime: ensureTemplateDesignRuntime,
    publishTemplateDesignChange,
    readWorkspaceTerminalLog,
    appendTaskEvent,
    validateAgentLoopProjectDirectory,
    suggestAgentLoopProjectDirectories,
    createAgentLoopProjectDirectory,
    terminalClientAttachments,
    terminalHostClientId,
  });
  const address = await bridge.start();
  webRuntimeBridge = bridge;
  console.log(`Local browser Runtime Host listening at ${address.url}`);
  return bridge;
}

async function validateAgentLoopProjectDirectory({ path: inputPath } = {}) {
  return agentLoopProjectDirectories.validate({ path: inputPath });
}

async function suggestAgentLoopProjectDirectories({ prefix } = {}) {
  return agentLoopProjectDirectories.suggest({ prefix });
}

async function createAgentLoopProjectDirectory({ parentPath, name } = {}) {
  return agentLoopProjectDirectories.createChild({ parentPath, name });
}

async function readRuntimeStatus() {
  await conductorToolBridgeHttpServerPromise;
  const status = getRuntimeStatus({
    ptyAvailable: realPtyAvailable,
    ptyBackend,
    ...conductorToolBridgeRuntimeConfig,
  });
  if (!conductorToolBridgeStartError) return status;
  return {
    ...status,
    message: `${status.message} Conductor tool bridge failed: ${
      conductorToolBridgeStartError instanceof Error ? conductorToolBridgeStartError.message : "unknown error"
    }`,
  };
}

function readWorkspaceTerminalLog(input) {
  const taskId = String(input?.taskId ?? "");
  const sessionId = String(input?.workspaceSessionId ?? "");
  if (!taskId || !sessionId) throw new Error("Terminal diagnostic log requires taskId and workspaceSessionId.");
  const runtime = ensureAgentLoopRuntime();
  const task = runtime.readTask({ taskId });
  if (!task) throw new Error("Terminal diagnostic log Task was not found.");
  const sessionMap = runtime.taskAgentMap({ taskId });
  if (!Object.prototype.hasOwnProperty.call(sessionMap, sessionId)) {
    throw new Error("Terminal diagnostic log Session does not belong to this Task.");
  }
  return runtimeSessionCapabilities.terminal.readTerminalLog({
    taskId,
    sessionId,
    cwd: task.cwd,
    maxBytes: Number(input?.maxBytes ?? 512 * 1024),
  });
}

async function appendTaskEvent(input) {
  const taskId = String(input?.taskId ?? "");
  const type = String(input?.type ?? "");
  if (!taskId) throw new Error("Task event requires taskId.");
  if (!["task.user_message", "user.intervention"].includes(type)) {
    throw new Error(`Unsupported task event type: ${type}`);
  }
  if (type === "task.user_message" && ensureAgentLoopRuntime().hasTask(taskId)) {
    return ensureAgentLoopRuntime().recordUserMessage({
      taskId,
      message: String(input?.data?.message ?? input?.summary ?? ""),
      data: sanitizeJsonObject(input?.data),
    });
  }
  const event = runtimeSessionCapabilities.taskTimeline.recordTaskEvent({
    taskId,
    sessionId: input?.sessionId ? String(input.sessionId) : "",
    cwd: String(input?.cwd ?? ""),
    type,
    summary: String(input?.summary ?? ""),
    data: sanitizeJsonObject(input?.data),
  });
  return { ok: true, event, taskState: runtimeSessionCapabilities.readModel.readTaskState({ taskId }) };
}

function ensureOpenCodeServerManager() {
  if (openCodeServerManager) return openCodeServerManager;
  const resolvedOpencodePath = resolveOpencodePath();
  if (!resolvedOpencodePath) throw new Error("OpenCode is required for the Agent Loop runtime.");
  openCodeServerManager = createOpenCodeServerManager({
    opencodePath: resolvedOpencodePath,
    expectedProviderVersion: OPENCODE_PROVIDER_VERSION,
  });
  return openCodeServerManager;
}

async function ensureTemplateDesignToolBridgeConfig() {
  if (templateDesignToolBridgeHttpServer) return templateDesignToolBridgeRuntimeConfig;
  if (!templateDesignToolBridgeStartPromise) {
    const templateDesignService = ensureAgentLoopRuntime().templateDesignService;
    templateDesignToolBridge = createTemplateDesignToolBridge({
      templateDesignService,
      onDraftChanged: publishTemplateDesignChange,
    });
    templateDesignToolBridgeStartPromise = startTemplateDesignToolBridgeHttpServer({ bridge: templateDesignToolBridge })
      .then((bridgeServer) => {
        templateDesignToolBridgeHttpServer = bridgeServer;
        templateDesignToolBridgeRuntimeConfig = {
          templateDesignerToolBridgeUrl: bridgeServer.url,
          templateDesignerToolBridgeToken: bridgeServer.token,
          templateDesignerMcpServerPath: path.join(__dirname, "template-designer-mcp-server.cjs"),
        };
        return templateDesignToolBridgeRuntimeConfig;
      })
      .catch((error) => {
        templateDesignToolBridgeStartError = error;
        templateDesignToolBridgeStartPromise = undefined;
        throw error;
      });
  }
  return templateDesignToolBridgeStartPromise;
}

async function openCodeHostBridgeConfig() {
  const [, templateDesignerBridge] = await Promise.all([
    conductorToolBridgeHttpServerPromise,
    ensureTemplateDesignToolBridgeConfig(),
  ]);
  if (conductorToolBridgeStartError) {
    throw new Error(`conductor_bridge_not_ready:${conductorToolBridgeStartError instanceof Error ? conductorToolBridgeStartError.message : "unknown"}`);
  }
  if (templateDesignToolBridgeStartError) {
    throw new Error(`template_design_bridge_not_ready:${templateDesignToolBridgeStartError instanceof Error ? templateDesignToolBridgeStartError.message : "unknown"}`);
  }
  return { ...conductorToolBridgeRuntimeConfig, ...templateDesignerBridge };
}

async function sharedOpenCodeHostConfig({ cwd } = {}) {
  const bridge = await openCodeHostBridgeConfig();
  return createOpenCodeHostRuntimeConfig({
    cwd,
    conductorBridge: bridge,
    templateDesignerBridge: bridge,
  });
}

function ensureTemplateDesignRuntime() {
  if (templateDesignRuntime) return templateDesignRuntime;
  const runtime = ensureAgentLoopRuntime();
  templateDesignRuntime = createTemplateDesignSessionRuntime({
    templateDesignService: runtime.templateDesignService,
    openCodeServerManager: ensureOpenCodeServerManager(),
    readTemplate: ({ templateId, templateVersion }) => runtime.templateById(templateId, templateVersion),
    createHostConfig: sharedOpenCodeHostConfig,
    resolveOpenCodeSessionPage: ({ server, ...input }) => {
      if (!server?.origin) {
        return {
          presentation: "unavailable",
          providerSessionId: input.providerSessionId,
          reason: "opencode_server_template_design_not_ready",
        };
      }
      return createOpenCodeServerSessionPageResolver({
        serverOrigin: server.origin,
        expectedProviderVersion: OPENCODE_PROVIDER_VERSION,
      }).openSessionPage(input);
    },
  });
  return templateDesignRuntime;
}

function ensureAgentLoopRuntime() {
  if (agentLoopRuntime) return agentLoopRuntime;
  const resolvedOpencodePath = resolveOpencodePath();
  if (!resolvedOpencodePath) throw new Error("OpenCode is required for the Agent Loop runtime.");
  agentLoopRuntime = createAgentLoopV1Runtime({
    openCodeServerManager: ensureOpenCodeServerManager(),
    sessionStoreCapabilities: runtimeSessionCapabilities,
    opencodePath: resolvedOpencodePath,
    databasePath: path.join(app.getPath("userData"), "agent-workspace", "agent-loop-v1.sqlite"),
    generateTemplateFromBrief: (input) => generateAgentLoopTemplate(input),
    enqueueConductorInput: ({ workspaceSessionId, expectedIncarnationId, source, payload, idempotencyKey }) =>
      sessionAuthority.enqueueInput({
        workspaceSessionId,
        expectedIncarnationId,
        source,
        payload,
        idempotencyKey,
      }),
    enqueueConductorInteractiveSubmission: ({ workspaceSessionId, expectedIncarnationId, source, text, idempotencyKey }) =>
      sessionAuthority.enqueueInteractiveSubmission({
        workspaceSessionId,
        expectedIncarnationId,
        source,
        text,
        idempotencyKey,
      }),
    openCodeHookService: (openCodeHookService ??= createOpenCodeHookService()),
    onProviderHookEvent: (event) => sessionWakeupMonitor?.handleProviderHookEvent(event),
    respondToPermission: (input) => sessionWakeupMonitor?.respondPermission(input),
    reconcileTaskCancellations: ({ taskId }) => conductorToolBridge.reconcileTaskCancellations({ taskId }),
    resolveOpenCodeSessionPage: (input) => {
      const server = openCodeServerManager?.getRun?.({ taskId: input?.taskId, runId: input?.runId });
      if (!server?.origin) return { presentation: "unavailable", providerSessionId: input?.providerSessionId, reason: "opencode_server_run_not_ready" };
      return createOpenCodeServerSessionPageResolver({
        serverOrigin: server.origin,
        expectedProviderVersion: OPENCODE_PROVIDER_VERSION,
        presentationGateway: {
          registerPresentation: (presentation) => ensureOpenCodeServerManager().registerRunPresentationGateway({
            taskId: String(input?.taskId ?? ""),
            runId: String(input?.runId ?? ""),
            ...presentation,
          }),
        },
      }).openSessionPage(input);
    },
    // The Runtime validates Task/Run/session ownership before it reaches this
    // narrow Host release capability. Releasing the Server lease is separate
    // from revoking the opaque official-WebUI presentation route.
    releaseOpenCodeSessionPage: ({ taskId, runId, leaseId }) =>
      ensureOpenCodeServerManager().releaseRunPresentationGateway({ taskId, runId, leaseId }),
    getConductorBridgeConfig: openCodeHostBridgeConfig,
  });
  // Start/Stop/Delete persist their command intent before touching native
  // Sessions or runtime directories. Resume any prepared intent immediately
  // after the durable Task registry is restored; per-Task serialization keeps
  // this safe if the renderer submits another lifecycle command concurrently.
  void agentLoopRuntime.reconcilePreparedLifecycleCommands().catch((error) => {
    console.error("Failed to reconcile prepared Agent Loop lifecycle commands", error);
  });
  // Startup may reveal durable wakeups whose prior Conductor PTY was reaped
  // while Electron was closed.  The monitor will hydrate them from the newly
  // restored task registry and ask this runtime to create a fresh generation.
  void sessionWakeupMonitor?.tick?.().catch(() => undefined);
  // A saved permission answer has a separate user-owned continuation path.
  // If Electron closed before OpenCode reissued the same request, restore its
  // existing logical Session now; the fresh hook transport will deliver the
  // retained answer once OpenCode asks again.
  void agentLoopRuntime.resumePendingPermissionRecoveries().catch(() => undefined);
  return agentLoopRuntime;
}

function watchTerminalClient(webContents) {
  if (webContents.__agentWorkspaceTerminalClientWatched) return;
  webContents.__agentWorkspaceTerminalClientWatched = true;
  webContents.once("destroyed", () => {
    for (const [key, attachment] of terminalClientAttachments) {
      if (attachment.webContents !== webContents) continue;
      terminalClientAttachments.delete(key);
      void ptyManager.detachClient({ id: attachment.sessionId, clientId: attachment.hostClientId, generation: attachment.generation });
    }
  });
}

function terminalHostClientId(webContentsId, clientId) {
  return `${String(webContentsId)}:${String(clientId)}`;
}

function isLiveWebContents(webContents) {
  try {
    return Boolean(webContents && !webContents.isDestroyed?.() && !webContents.mainFrame?.isDestroyed?.());
  } catch {
    return false;
  }
}

function sendTerminalClientEvent(webContents, payload) {
  if (!isLiveWebContents(webContents)) return false;
  try {
    webContents.send("native:terminal-client-event", payload);
    return true;
  } catch {
    return false;
  }
}

function resolvePtyCommand(command) {
  if (command !== "opencode") return command;
  return resolveOpencodePath() ?? command;
}

async function readProviderConductorMessage({ session, afterMessageCreatedAt, providerSessionId }) {
  if (!isOpencodeSession(session)) return undefined;
  const fact = await (openCodeProviderObserver ??= createOpenCodeProviderObserver())
    .observeConductor({ session, afterMessageCreatedAt, providerSessionId })
    .catch(() => undefined);
  return fact?.kind === "result" ? fact.result : undefined;
}

async function readProviderConductorQuestion({ session, afterMessageCreatedAt, providerSessionId }) {
  if (!isOpencodeSession(session)) return undefined;
  const fact = await (openCodeProviderObserver ??= createOpenCodeProviderObserver())
    .observeConductor({ session, afterMessageCreatedAt, providerSessionId })
    .catch(() => undefined);
  return fact?.kind === "attention" ? fact.attention : undefined;
}

function isOpencodeSession(session) {
  const provider = String(session?.provider ?? "");
  const command = String(session?.command ?? "");
  return provider === "opencode" || path.basename(command) === "opencode";
}

function buildWorkspaceSessionLaunchProfile(input) {
  const workspaceSessionId = String(input?.workspaceSessionId ?? "").trim();
  if (!isCanonicalWorkspaceSessionId(workspaceSessionId)) {
    throw new Error("Workspace Session profile requires a canonical workspaceSessionId.");
  }
  const taskId = String(input?.taskId ?? "").trim();
  if (!taskId || taskIdFromWorkspaceSessionId(workspaceSessionId) !== taskId) {
    throw new Error("Workspace Session profile taskId must match its workspaceSessionId.");
  }
  const provider = String(input?.provider ?? "opencode");
  if (provider !== "opencode") {
    throw new Error("Only the implemented opencode terminal provider may register a Session profile.");
  }
  const requestedCwd = String(input?.cwd ?? "").trim();
  if (!requestedCwd) {
    throw new Error("Workspace Session profile requires a project cwd.");
  }
  const cwd = path.resolve(requestedCwd);
  const model = input?.model ? String(input.model) : undefined;
  return {
    workspaceSessionId,
    taskId,
    provider,
    command: resolvePtyCommand("opencode"),
    args: model ? ["--model", model] : [],
    cwd,
    model,
    cols: Number(input?.cols ?? 100),
    rows: Number(input?.rows ?? 30),
    stdin: "pipe",
    requirePty: true,
    env: sanitizeEnv(input?.env),
    runtimeFiles: sanitizeRuntimeFiles(input?.runtimeFiles),
  };
}

function sanitizeEnv(env) {
  if (!env || typeof env !== "object" || Array.isArray(env)) return undefined;
  return Object.fromEntries(
    Object.entries(env)
      .filter(([key, value]) => typeof key === "string" && typeof value === "string")
      .map(([key, value]) => [key, value]),
  );
}

function sanitizeRuntimeFiles(files) {
  if (!Array.isArray(files)) return [];
  return files
    .filter((file) => file && typeof file === "object")
    .map((file) => ({
      relativePath: String(file.relativePath ?? ""),
      contents: String(file.contents ?? ""),
    }));
}

function sanitizeJsonObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return JSON.parse(JSON.stringify(value));
}

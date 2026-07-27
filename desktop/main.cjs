const path = require("node:path");
const { app, BrowserWindow, ipcMain } = require("electron");
const {
  createConductorToolBridge,
  startConductorToolBridgeHttpServer,
} = require("./conductor-tool-bridge.cjs");
const { ensureNodePtySpawnHelperExecutable } = require("./node-pty-runtime.cjs");
const { inspectOpencodeProcesses } = require("./opencode/process-inspector.cjs");
const {
  findProviderSessionForConductorTask,
  inspectDispatchProviderState,
  getDispatchAssistantAnswer,
  getLastEffectiveAssistantAnswer,
  getLastPendingQuestionForDirectory,
  getLastPendingQuestionForConductorTask,
} = require("./opencode/session-adapter.cjs");
const { getRuntimeStatus, listOpencodeAgents, resolveOpencodePath, runOpencode } = require("./opencode-runner.cjs");
const { resolveProjectWindowContext, withProjectWindowContext } = require("./project-window-context.cjs");
const { createOrcaTerminalDaemonManager } = require("./runtime/orca-terminal-daemon-manager.cjs");
const { createOrcaTerminalDaemonSupervisor } = require("./runtime/orca-terminal-daemon-supervisor.cjs");
const { createOpenCodeHookService } = require("./runtime/opencode-hook-service.cjs");
const { createAgentLoopV1Runtime } = require("./runtime/agent-loop-v1-runtime.cjs");
const { createOrchestrationHarness } = require("./runtime/orchestration-harness.cjs");
const { createSessionAuthority } = require("./runtime/session-authority.cjs");
const { createSessionWakeupMonitor } = require("./session-wakeup-monitor.cjs");
const { createSessionStore } = require("./session-store.cjs");
const { generateAgentLoopTemplate } = require("./agent-loop-template-assistant.cjs");
const { generateTaskDraft } = require("./task-draft-assistant.cjs");
const { runVerification } = require("./verification-runner.cjs");

let mainWindow;
let ptyManager;
let sessionAuthority;
let terminalDaemonSupervisor;
let conductorToolBridge;
let conductorToolBridgeHttpServer;
let conductorToolBridgeRuntimeConfig = {};
let conductorToolBridgeStartError;
let sessionWakeupMonitor;
let agentLoopRuntime;
let orchestrationHarness;
let openCodeHookService;
let realPtyAvailable = false;
let ptyBackend = "process-fallback";
const terminalClientAttachments = new Map();

const runtimeSessionStore = createSessionStore({
  root: ({ cwd }) => {
    if (!cwd) throw new Error("Project cwd is required before resolving the runtime Session Store root.");
    return path.join(cwd, ".agent-workspace", "runtime");
  },
});

// Semantic state changes are published independently from PTY transport.
// Renderer clients receive only a lightweight invalidation and re-read the
// durable Run; raw TUI output continues over the Orca-style terminal stream.
runtimeSessionStore.onTaskChange?.((change) => publishAgentLoopRuntimeChange(change));

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
  sessionStore: runtimeSessionStore,
});

sessionAuthority = createSessionAuthority({
  ptyManager,
  databasePath: path.join(app.getPath("userData"), "agent-workspace", "terminal-runtime.sqlite"),
});
ptyManager.onEvent((event) => {
  sessionAuthority.handlePtyEvent(event);
  if (event?.type === "exit") openCodeHookService?.clearSession?.(event.id);
  void orchestrationHarness?.handlePtyEvent(event).catch(() => undefined);
});
ptyManager.onClientEvent((event, attachment) => {
  const target = terminalClientAttachments.get(String(attachment?.clientId ?? ""));
  if (!target || !isLiveWebContents(target.webContents)) {
    if (target) {
      terminalClientAttachments.delete(target.hostClientId);
      void ptyManager.detachClient({
        id: target.sessionId,
        clientId: target.hostClientId,
        generation: target.generation,
      });
    }
    return;
  }
  sendTerminalClientEvent(target.webContents, event);
});

conductorToolBridge = createConductorToolBridge({
  sessionStore: runtimeSessionStore,
  ptyManager,
  activateWorkerSession: async ({ sessionId, operationId }) =>
    sessionAuthority.activateSession({
      workspaceSessionId: sessionId,
      operationId,
      callerId: "conductor-tool-bridge",
      reason: "conductor-dispatch",
    }),
  prepareWorkerSession: ({ taskId, agentId, sessionId, initialPrompt }) =>
    agentLoopRuntime?.hasTask(taskId)
      ? agentLoopRuntime.prepareWorkerInitialDispatch({ taskId, agentId, sessionId, initialPrompt })
      : { initialPromptSubmitted: false, sessionId },
  enqueueWorkerInput: ({ sessionId, expectedIncarnationId, payload, idempotencyKey }) =>
    sessionAuthority.enqueueInput({
      workspaceSessionId: sessionId,
      expectedIncarnationId,
      source: "dispatch",
      payload,
      idempotencyKey,
    }),
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
  resumeTaskForDispatch: ({ taskId, agentId, toSessionId }) => {
    if (!agentLoopRuntime?.hasTask(taskId)) return undefined;
    return agentLoopRuntime.resumeTaskForDispatch({ taskId, agentId, toSessionId });
  },
  onCompletionClaim: ({ taskId }) => {
    if (!agentLoopRuntime?.hasTask(taskId)) return undefined;
    return agentLoopRuntime.recordCompletionClaim({ taskId });
  },
});

sessionWakeupMonitor = createSessionWakeupMonitor({
  ptyManager,
  sessionStore: runtimeSessionStore,
  dispatchStateReader: readProviderDispatchState,
  dispatchResultReader: readProviderDispatchResult,
  conductorMessageReader: readProviderConductorMessage,
  conductorQuestionReader: readProviderConductorQuestion,
  workerQuestionReader: readProviderWorkerQuestion,
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
  onConductorWaiting: ({ taskId }) =>
    agentLoopRuntime?.hasTask(taskId)
      ? agentLoopRuntime.flushPendingUserMessages({ taskId }).catch(() => undefined)
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

app.whenReady().then(() => {
  // Startup is eager so the UI can accurately report a daemon failure before
  // a Task tries to create a Session. Session activation still awaits the
  // same endpoint provider, so this does not introduce a second owner.
  void terminalDaemonSupervisor.start().catch(() => undefined);
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
  agentLoopRuntime?.close?.();
  orchestrationHarness?.close?.();
  void openCodeHookService?.close?.();
  void ptyManager?.close?.();
  void terminalDaemonSupervisor?.stop?.();
  sessionAuthority?.close?.();
  void conductorToolBridgeHttpServer?.close?.();
});

function registerIpc() {
  ipcMain.handle("native:get-runtime-status", async () => {
    await conductorToolBridgeHttpServerPromise;
    const status = getRuntimeStatus({
      ptyAvailable: realPtyAvailable,
      ptyBackend,
      ...conductorToolBridgeRuntimeConfig,
    });
    if (conductorToolBridgeStartError) {
      return {
        ...status,
        message: `${status.message} Conductor tool bridge failed: ${
          conductorToolBridgeStartError instanceof Error
            ? conductorToolBridgeStartError.message
            : "unknown error"
        }`,
      };
    }
    return status;
  });

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
  ipcMain.handle("native:read-workspace-terminal-log", (_event, input) => {
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
    return runtimeSessionStore.readTerminalLog({
      taskId,
      sessionId,
      cwd: task.cwd,
      maxBytes: Number(input?.maxBytes ?? 512 * 1024),
    });
  });

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

  // Active product surface: pure Conductor-driven Agent Loop. The historical
  // orchestration harness IPC remains below only for migration compatibility;
  // no active renderer calls it.
  ipcMain.handle("native:list-agent-loop-templates", () => ensureAgentLoopRuntime().listTemplates());

  ipcMain.handle("native:generate-agent-loop-template", (_event, input) =>
    ensureAgentLoopRuntime().generateTemplateDraft({
      cwd: String(input?.cwd ?? process.cwd()),
      projectName: input?.projectName ? String(input.projectName) : undefined,
      description: String(input?.description ?? ""),
      model: input?.model ? String(input.model) : undefined,
    }),
  );

  ipcMain.handle("native:save-agent-loop-template", (_event, input) =>
    ensureAgentLoopRuntime().saveTemplate(sanitizeAgentLoopTemplate(input)),
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

  ipcMain.handle("native:create-agent-loop-task", (_event, input) =>
    ensureAgentLoopRuntime().createTask({
      taskId: input?.taskId ? String(input.taskId) : undefined,
      projectId: input?.projectId ? String(input.projectId) : undefined,
      cwd: String(input?.cwd ?? ""),
      title: String(input?.title ?? ""),
      goal: String(input?.goal ?? ""),
      templateId: input?.templateId ? String(input.templateId) : undefined,
      templateVersion: input?.templateVersion ? Number(input.templateVersion) : undefined,
    }),
  );

  ipcMain.handle("native:list-agent-loop-tasks", () => ensureAgentLoopRuntime().listTasks());

  ipcMain.handle("native:read-agent-loop-task", (_event, input) =>
    ensureAgentLoopRuntime().readTask({ taskId: String(input?.taskId ?? "") }),
  );

  ipcMain.handle("native:start-agent-loop-run", (_event, input) =>
    ensureAgentLoopRuntime().startRun({ taskId: String(input?.taskId ?? "") }),
  );

  ipcMain.handle("native:read-agent-loop-run", (_event, input) =>
    ensureAgentLoopRuntime().readRun({ runId: String(input?.runId ?? "") }),
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
    ensureAgentLoopRuntime().markTaskAchieved({ taskId: String(input?.taskId ?? "") }),
  );

  ipcMain.handle("native:append-task-event", async (_event, input) => {
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

    const event = runtimeSessionStore.recordTaskEvent({
      taskId,
      sessionId: input?.sessionId ? String(input.sessionId) : "",
      cwd: String(input?.cwd ?? ""),
      type,
      summary: String(input?.summary ?? ""),
      data: sanitizeJsonObject(input?.data),
    });
    return {
      ok: true,
      event,
      taskState: runtimeSessionStore.readTaskState({ taskId }),
    };
  });

  ipcMain.handle("native:list-orchestration-templates", () => ensureOrchestrationHarness().listTemplates());

  ipcMain.handle("native:list-orchestration-template-blueprints", () => ensureOrchestrationHarness().listTemplateBlueprints());

  ipcMain.handle("native:save-orchestration-template", (_event, input) =>
    ensureOrchestrationHarness().saveTemplateVersion({
      id: String(input?.id ?? ""),
      family: String(input?.family ?? ""),
      version: Number(input?.version ?? 1),
      name: String(input?.name ?? ""),
      definition: sanitizeJsonObject(input?.definition),
    }),
  );

  ipcMain.handle("native:create-harness-task", (_event, input) =>
    ensureOrchestrationHarness().createHarnessTask({
      taskId: input?.taskId ? String(input.taskId) : undefined,
      projectId: input?.projectId ? String(input.projectId) : undefined,
      cwd: String(input?.cwd ?? ""),
      title: input?.title ? String(input.title) : undefined,
      goal: input?.goal ? String(input.goal) : undefined,
      model: input?.model ? String(input.model) : undefined,
      templateBlueprintId: input?.templateBlueprintId ? String(input.templateBlueprintId) : undefined,
      templateBlueprintVersion: input?.templateBlueprintVersion ? Number(input.templateBlueprintVersion) : undefined,
      agentLoopTemplateId: input?.agentLoopTemplateId ? String(input.agentLoopTemplateId) : undefined,
      agentLoopTemplateVersion: input?.agentLoopTemplateVersion ? Number(input.agentLoopTemplateVersion) : undefined,
    }),
  );

  ipcMain.handle("native:generate-orchestration-template-draft", (_event, input) =>
    ensureOrchestrationHarness().generateTemplateDraft({
      cwd: String(input?.cwd ?? ""),
      title: input?.title ? String(input.title) : undefined,
      goal: input?.goal ? String(input.goal) : undefined,
      model: input?.model ? String(input.model) : undefined,
    }),
  );

  ipcMain.handle("native:create-manual-orchestration-template-draft", (_event, input) =>
    ensureOrchestrationHarness().createManualTemplateDraft({
      cwd: String(input?.cwd ?? ""),
      title: input?.title ? String(input.title) : undefined,
      goal: input?.goal ? String(input.goal) : undefined,
      description: input?.description ? String(input.description) : undefined,
      model: input?.model ? String(input.model) : undefined,
      agentLoop: input?.agentLoop,
      workflow: input?.workflow,
      rationale: input?.rationale ? String(input.rationale) : undefined,
      assumptions: Array.isArray(input?.assumptions) ? input.assumptions : undefined,
    }),
  );

  ipcMain.handle("native:read-orchestration-template-draft", (_event, input) =>
    ensureOrchestrationHarness().readTemplateDraft({ draftId: String(input?.draftId ?? "") }),
  );

  ipcMain.handle("native:save-generated-orchestration-template-draft", (_event, input) =>
    ensureOrchestrationHarness().saveGeneratedTemplateDraft({ draftId: String(input?.draftId ?? "") }),
  );

  ipcMain.handle("native:list-harness-tasks", () => ensureOrchestrationHarness().listHarnessTasks());

  ipcMain.handle("native:read-harness-task", (_event, input) =>
    ensureOrchestrationHarness().readTask({ taskId: String(input?.taskId ?? "") }),
  );

  ipcMain.handle("native:start-harness-run", (_event, input) =>
    ensureOrchestrationHarness().startHarnessRun({ taskId: String(input?.taskId ?? "") }),
  );

  ipcMain.handle("native:read-harness-run", (_event, input) =>
    ensureOrchestrationHarness().readRun({ runId: String(input?.runId ?? "") }),
  );

  ipcMain.handle("native:read-harness-artifact", (_event, input) =>
    ensureOrchestrationHarness().readArtifact({
      runId: String(input?.runId ?? ""),
      artifactPath: String(input?.artifactPath ?? ""),
    }),
  );

  ipcMain.handle("native:mark-harness-task-achieved", (_event, input) =>
    ensureOrchestrationHarness().markTaskAchieved({ taskId: String(input?.taskId ?? "") }),
  );

  ipcMain.handle("native:respond-harness-attention", (_event, input) =>
    ensureOrchestrationHarness().respondToAttention({
      attentionId: String(input?.attentionId ?? ""),
      response: String(input?.response ?? ""),
    }),
  );
}

function ensureOrchestrationHarness() {
  if (orchestrationHarness) return orchestrationHarness;
  const resolvedOpencodePath = resolveOpencodePath();
  if (!resolvedOpencodePath) throw new Error("OpenCode is required for the orchestration harness.");
  orchestrationHarness = createOrchestrationHarness({
    sessionAuthority,
    ptyManager,
    sessionStore: runtimeSessionStore,
    opencodePath: resolvedOpencodePath,
    databasePath: path.join(app.getPath("userData"), "agent-workspace", "orchestration-harness.sqlite"),
    openCodeHookService: (openCodeHookService ??= createOpenCodeHookService()),
  });
  return orchestrationHarness;
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
}

function ensureAgentLoopRuntime() {
  if (agentLoopRuntime) return agentLoopRuntime;
  const resolvedOpencodePath = resolveOpencodePath();
  if (!resolvedOpencodePath) throw new Error("OpenCode is required for the Agent Loop runtime.");
  agentLoopRuntime = createAgentLoopV1Runtime({
    sessionAuthority,
    ptyManager,
    sessionStore: runtimeSessionStore,
    opencodePath: resolvedOpencodePath,
    databasePath: path.join(app.getPath("userData"), "agent-workspace", "agent-loop-v1.sqlite"),
    generateTemplateFromDescription: (input) => generateAgentLoopTemplate(input),
    registerProviderHook: ({ sessionId, cwd }) => {
      openCodeHookService ??= createOpenCodeHookService();
      return openCodeHookService.registerSession({
        sessionId,
        cwd,
        onEvent: (event) => sessionWakeupMonitor?.handleProviderHookEvent(event),
      });
    },
    enqueueConductorInput: ({ workspaceSessionId, expectedIncarnationId, source, payload, idempotencyKey }) =>
      sessionAuthority.enqueueInput({
        workspaceSessionId,
        expectedIncarnationId,
        source,
        payload,
        idempotencyKey,
      }),
    getConductorBridgeConfig: async () => {
      await conductorToolBridgeHttpServerPromise;
      return conductorToolBridgeRuntimeConfig;
    },
  });
  return agentLoopRuntime;
}

function sanitizeAgentLoopTemplate(input) {
  const value = input && typeof input === "object" ? input : {};
  return {
    id: value.id ? String(value.id) : undefined,
    name: String(value.name ?? ""),
    description: value.description ? String(value.description) : "",
    source: value.source ? String(value.source) : "manual",
    conductor: value.conductor && typeof value.conductor === "object" ? {
      role: value.conductor.role ? String(value.conductor.role) : undefined,
      model: value.conductor.model ? String(value.conductor.model) : undefined,
      charter: value.conductor.charter ? String(value.conductor.charter) : "",
    } : undefined,
    agents: Array.isArray(value.agents) ? value.agents.map((agent) => ({
      id: agent?.id ? String(agent.id) : undefined,
      name: agent?.name ? String(agent.name) : undefined,
      kind: agent?.kind ? String(agent.kind) : undefined,
      role: agent?.role ? String(agent.role) : undefined,
      model: agent?.model ? String(agent.model) : undefined,
      mcp: Array.isArray(agent?.mcp) ? agent.mcp.map(String) : [],
      skills: Array.isArray(agent?.skills) ? agent.skills.map(String) : [],
      instructions: agent?.instructions ? String(agent.instructions) : "",
      expectedOutput: agent?.expectedOutput ? String(agent.expectedOutput) : "",
    })) : [],
    limits: value.limits && typeof value.limits === "object" ? {
      maxConcurrentSessions: Number(value.limits.maxConcurrentSessions),
      maxDispatchesPerDecision: Number(value.limits.maxDispatchesPerDecision),
    } : undefined,
    delivery: value.delivery && typeof value.delivery === "object" ? {
      artifactPath: value.delivery.artifactPath ? String(value.delivery.artifactPath) : "",
      ownerAgentId: value.delivery.ownerAgentId ? String(value.delivery.ownerAgentId) : "",
    } : undefined,
  };
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

function readProviderDispatchResult({ session, dispatch }) {
  if (!isOpencodeSession(session)) return undefined;
  return getDispatchAssistantAnswer({
    dispatchId: dispatch.dispatchId,
    cwd: session.cwd,
    dispatchCreatedAt: dispatch.createdAt,
  }).catch(() => undefined);
}

function readProviderDispatchState({ session, dispatch }) {
  if (!isOpencodeSession(session)) return undefined;
  return inspectDispatchProviderState({
    dispatchId: dispatch.dispatchId,
    cwd: session.cwd,
    dispatchCreatedAt: dispatch.createdAt,
  }).catch(() => undefined);
}

async function readProviderConductorMessage({ session, afterMessageCreatedAt }) {
  if (!isOpencodeSession(session)) return undefined;
  const providerSession = await findProviderSessionForConductorTask({
    cwd: session.cwd,
    taskId: session.taskId,
  }).catch(() => undefined);
  if (!providerSession?.providerSessionId) return undefined;
  return getLastEffectiveAssistantAnswer({
    providerSessionId: providerSession.providerSessionId,
    afterMessageCreatedAt,
  }).catch(() => undefined);
}

function readProviderConductorQuestion({ session, afterMessageCreatedAt }) {
  if (!isOpencodeSession(session)) return undefined;
  return getLastPendingQuestionForConductorTask({
    cwd: session.cwd,
    taskId: session.taskId,
    afterMessageCreatedAt,
  }).catch(() => undefined);
}

function readProviderWorkerQuestion({ session, afterMessageCreatedAt }) {
  if (!isOpencodeSession(session)) return undefined;
  return getLastPendingQuestionForDirectory({
    cwd: session.cwd,
    afterMessageCreatedAt,
  }).catch(() => undefined);
}

function isOpencodeSession(session) {
  const provider = String(session?.provider ?? "");
  const command = String(session?.command ?? "");
  return provider === "opencode" || path.basename(command) === "opencode";
}

function isCanonicalWorkspaceSessionId(sessionId) {
  const value = String(sessionId ?? "");
  return /^[a-z0-9-]+:[^:]+:[^:]+:[^:]+$/i.test(value);
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

function taskIdFromWorkspaceSessionId(sessionId) {
  const parts = String(sessionId ?? "").split(":");
  return parts.length >= 3 ? parts[2] : undefined;
}

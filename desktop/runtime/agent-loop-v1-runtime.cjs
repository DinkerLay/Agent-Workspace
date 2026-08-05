const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const {
  RUN_STATUS,
  TASK_STATUS,
  assertTaskStatusTransition,
  isTaskUnavailableForContinuation,
} = require("./agent-loop-state-model.cjs");
const {
  createLoopTemplateStore,
  isPromptSplitAgentCard,
  normalizeAgentCard,
  normalizeAgentCards,
  normalizeStoredDelivery,
  templateSnapshot,
} = require("./loop-template-store.cjs");
const { createTaskRunRepository } = require("./task-run-repository.cjs");
const { createTaskRunService } = require("./task-run-service.cjs");
const { createTemplateDesignSessionService } = require("./template-design-session-service.cjs");
const { projectTaskRunReadModel } = require("./task-run-read-model.cjs");
const { createSessionStoreCapabilities } = require("./session-store-capabilities.cjs");
const { isPermissionRecordBlockingDispatch } = require("../session-store.cjs");
const { isLiveConductorTerminal, projectConductorContinuity } = require("./run-continuity.cjs");
const { reconcileOpenCodeSessionBindings } = require("../opencode/server-session-reconciler.cjs");
const {
  CONDUCTOR_AGENT_NAME: OPEN_CODE_CONDUCTOR_PROVIDER_AGENT,
  OPEN_CODE_DEFAULT_AGENT: OPEN_CODE_WORKER_PROVIDER_AGENT,
  createOpenCodeHostRuntimeConfig,
} = require("../opencode/host-config.cjs");

const DEFAULT_MODEL = "opencode-go/deepseek-v4-flash";
const DEFAULT_TEMPLATE_ID = "opencode-agent-loop-v1";
// Provider semantic answers are normal task context, not a terminal replay.
// Refuse an unexpectedly huge answer rather than silently truncating the
// evidence a Conductor explicitly chose to pass to another native Session.
const MAX_FORWARDED_RESULT_CHARS = 60_000;

/**
 * The active v1 runtime intentionally has no graph runner.  It only owns the
 * durable Task/Loop/Agent-card facts and turns Conductor decisions into native
 * OpenCode launch profiles.  The Conductor MCP bridge remains the dispatch
 * authority; workers are never given Workspace protocol tools or prompts.
 */
function createAgentLoopV1Runtime({
  sessionAuthority,
  ptyManager,
  sessionStore,
  sessionStoreCapabilities,
  opencodePath,
  databasePath = ":memory:",
  getConductorBridgeConfig = async () => ({}),
  generateTemplateFromBrief,
  enqueueConductorInput,
  enqueueConductorInteractiveSubmission,
  openCodeHookService,
  onProviderHookEvent,
  respondToPermission,
  reconcileTaskCancellations,
  resolveOpenCodeSessionPage,
  releaseOpenCodeSessionPage: releaseOpenCodeSessionPageResolver,
  openCodeServerManager,
  now = () => new Date().toISOString(),
  randomUUID = crypto.randomUUID,
} = {}) {
  const usesOpenCodeServer = Boolean(openCodeServerManager?.ensureRun && openCodeServerManager?.clientForRun);
  if (!usesOpenCodeServer && (!sessionAuthority?.registerLaunchProfile || !sessionAuthority?.activateSession)) {
    throw new Error("Agent Loop Runtime requires Session Authority.");
  }
  if (!usesOpenCodeServer && !ptyManager?.read) throw new Error("Agent Loop Runtime requires PTY reads.");
  const scopedSessionStore = sessionStoreCapabilities ?? createSessionStoreCapabilities(sessionStore);
  const sessionReadModel = scopedSessionStore.readModel;
  const taskTimeline = scopedSessionStore.taskTimeline;
  const coordinatorFacts = scopedSessionStore.coordinator;
  const providerFacts = scopedSessionStore.provider;
  const terminalFacts = scopedSessionStore.terminal;
  if (!taskTimeline.recordTaskEvent || !sessionReadModel.readTaskState) {
    throw new Error("Agent Loop Runtime requires the Session Store.");
  }
  if (!opencodePath) throw new Error("Agent Loop Runtime requires OpenCode.");

  ensureDatabaseDirectory(databasePath);
  const db = new DatabaseSync(databasePath);
  // A completed worker can wake the Conductor at the same instant as another
  // Runtime event.  Keep one recovery operation per Task so those durable
  // wakeups share a single replacement PTY instead of racing to create two
  // physical terminals for the same logical Session.
  const conductorRecoveryPromises = new Map();
  // A user-selected permission answer may survive an Electron restart before
  // OpenCode reissues the request. One logical Session still gets one recovery
  // TUI even when its durable history contains multiple transport request ids.
  const permissionRecoveryPromises = new Map();
  // The Task page may receive two clicks before React applies the first busy
  // state. Serialize a native-question answer by its Provider question id so
  // a logical Session gets exactly one interactive PTY submission.
  const questionSubmissionPromises = new Map();
  const serverEventUnsubscribers = new Map();
  const conductorServerMessageQueues = new Map();
  // The official Web UI gateway asks Runtime to record a Conductor input
  // before it forwards that HTTP request upstream.  Keep only the short-lived
  // correlation needed to attach the Provider's eventual message receipt; the
  // durable wakeup remains the recovery source of truth.
  const providerUserInputReceipts = new Map();
  // Direct official-WebUI routes are revocable presentation capabilities.
  // Keep the leases Runtime issued so permanent Task deletion can revoke them
  // before the Task/Run binding disappears from durable storage.
  const presentationLeases = new Map();
  // A prepared permanent deletion is a durable closing fence.  Async Provider
  // callbacks must not recreate Session Store facts after its owner directory
  // has been removed.
  const closingTaskIds = new Set();
  // Task lifecycle commands may await PTY facts. Keep those commands ordered
  // per Task so a second Start, Stop, achievement claim, deletion, or terminal
  // recovery cannot make a final durable update for an operation it no longer
  // owns. This is deliberately owned by the Task/Run service rather than IPC
  // or the renderer.
  const taskLifecycleQueues = new Map();
  migrate(db);
  const taskRunRepository = createTaskRunRepository({
    db,
    deserializeTask,
    deserializeRun,
    bindTaskRoot: (input) => taskTimeline.bindTaskRoot?.(input),
    now,
    randomUUID,
  });
  const taskRunService = createTaskRunService({ repository: taskRunRepository, now, randomUUID });
  const templateStore = createLoopTemplateStore({ db, defaultModel: DEFAULT_MODEL, now, randomUUID });
  const {
    archiveTemplate,
    copyTemplate,
    deleteTemplate,
    listTemplates,
    listTemplateVersions,
    saveTemplate,
    templateById,
  } = templateStore;
  // Template Design Drafts are a distinct durable owner, but their explicit
  // Save command must create a Template Version through this same database
  // connection.  Keeping the capability here avoids a second SQLite writer
  // racing an in-flight Draft transaction.
  const templateDesignService = createTemplateDesignSessionService({
    db,
    saveTemplate,
    now,
    randomUUID,
    normalizeAgentCards,
  });
  ensureSeedTemplate();
  publishPendingTaskEvents();

  function ensureSeedTemplate() {
    if (templateById(DEFAULT_TEMPLATE_ID)) return;
    saveTemplate({
      id: DEFAULT_TEMPLATE_ID,
      name: "OpenCode Agent Loop",
      source: "seed",
      conductor: {
        role: "Conductor",
        model: DEFAULT_MODEL,
        charter: "Conductor asynchronously dispatches native OpenCode Session Agents and decides again after every semantic Runtime return. Own the task conversation and decide each next dispatch from durable Session returns and user follow-ups. Use independent investigation, synthesis, or critique when useful; never assume a fixed sequence, number of agents, or review loop.",
      },
      agents: [
        agentCard({
          id: "researcher",
          name: "Researcher",
          kind: "researcher",
          dispatchProfile: {
            title: "Evidence research",
            description: "Use when the Conductor needs independent, source-backed findings for a bounded question.",
          },
          workerSystemPrompt: "Research the assigned question with primary or otherwise verifiable sources. State dates, provenance, uncertainty, and the distinction between facts and inferences.",
        }),
        agentCard({
          id: "reviewer",
          name: "Reviewer",
          kind: "reviewer",
          dispatchProfile: {
            title: "Evidence review",
            description: "Use when returned evidence, artifacts, or conclusions need an independent quality and coverage review.",
          },
          workerSystemPrompt: "Evaluate the supplied material for evidence quality, coverage, contradictions, and unresolved risks. Do not invent evidence; make every gap explicit.",
        }),
        agentCard({
          id: "publisher",
          name: "Publisher",
          kind: "publisher",
          dispatchProfile: {
            title: "Evidence-backed delivery",
            description: "Use when selected evidence is ready to become the requested user-facing deliverable.",
          },
          workerSystemPrompt: "Create the requested deliverable only from the supplied verified material. Preserve sources and clearly state unresolved limitations.",
        }),
      ],
      limits: { maxConcurrentSessions: 3, maxDispatchesPerDecision: 3 },
      delivery: { artifactPath: "" },
    });
  }

  async function generateTemplateDraft(input) {
    if (typeof generateTemplateFromBrief !== "function") throw new Error("agent_loop_template_generation_unavailable");
    const generated = await generateTemplateFromBrief({
      cwd: required(input?.cwd, "cwd"),
      projectName: input?.projectName ? String(input.projectName) : undefined,
      brief: required(input?.brief, "brief"),
      model: input?.model ? String(input.model) : DEFAULT_MODEL,
    });
    return {
      template: templateStore.normalizeTemplate(generated?.template),
      assistantMessage: String(generated?.assistantMessage || "OpenCode 已生成可编辑的 Agent Loop 草案。"),
      assumptions: Array.isArray(generated?.assumptions) ? generated.assumptions.map(String).filter(Boolean) : [],
    };
  }

  function createTask(input) {
    const taskId = safeSegment(input?.taskId || `loop-${randomUUID().slice(0, 8)}`);
    const cwd = path.resolve(required(input?.cwd, "cwd"));
    assertWritableDirectory(cwd);
    const template = required(templateById(required(input?.templateId || DEFAULT_TEMPLATE_ID, "templateId"), Number(input?.templateVersion) || undefined), "loop_template_not_found");
    if (template.archivedAt) throw new Error("loop_template_archived");
    if (taskRunRepository.taskById(taskId)) throw new Error("loop_task_id_conflict");
    // An explicit caller may intentionally reuse a previously purged id. A
    // fresh Task owns a fresh lifetime and must not inherit a stale callback
    // fence from its deleted predecessor.
    closingTaskIds.delete(taskId);
    const title = required(input?.title, "title");
    const goal = required(input?.goal, "goal");
    const architecture = {
      primaryMode: "agent_loop",
      template: templateSnapshot(template),
      defaultModel: template.conductor.model,
      ...(optionalModelVariant(template.conductor.modelVariant)
        ? { defaultModelVariant: optionalModelVariant(template.conductor.modelVariant) }
        : {}),
      agentCards: template.agents,
      delivery: template.delivery,
    };
    const timestamp = now();
    taskRunRepository.transaction(() => {
      taskRunRepository.insertTask({
        taskId,
        projectId: safeSegment(input?.projectId || "local"),
        cwd,
        title,
        goal,
        templateId: template.id,
        templateVersion: template.version,
        architecture,
        status: TASK_STATUS.QUEUED,
        createdAt: timestamp,
      });
      const artifactPath = configuredArtifactPath({ architecture });
      if (artifactPath) {
        taskRunRepository.registerManagedArtifact({
          taskId,
          artifactPath,
          source: "template_delivery",
          createdAt: timestamp,
        });
      }
      taskRunRepository.enqueueTaskEvent({
        outboxId: `task-created:${taskId}`,
        taskId,
        cwd,
        type: "task.architecture_confirmed",
        summary: `已确认 Agent Loop Template：${template.name} v${template.version}。`,
        data: { template: templateSnapshot(template) },
        createdAt: timestamp,
      });
    });
    publishPendingTaskEvents();
    return readTask({ taskId });
  }

  async function startRun({ taskId, commandId, expectedRevision } = {}) {
    const normalizedTaskId = required(taskId, "taskId");
    const preparedCommand = taskRunRepository.findPreparedCommand({ taskId: normalizedTaskId, kind: "task.start_run" });
    const normalizedCommandId = preparedCommand?.commandId || String(commandId || `command:start:${randomUUID()}`);
    return serializeTaskLifecycle(normalizedTaskId, () => startRunOnce({
      taskId: normalizedTaskId,
      commandId: normalizedCommandId,
      expectedRevision,
    }));
  }

  async function startRunOnce({ taskId, commandId, expectedRevision }) {
    const task = required(taskById(taskId), "loop_task_not_found");
    const existingCommand = taskRunRepository.commandById(commandId);
    if (existingCommand?.status === "committed") return readRun({ runId: existingCommand.result?.runId });
    if (existingCommand?.status === "failed") throw new Error(existingCommand.result?.error || "loop_start_command_failed");
    // An achieved Task has a retained Run and exact Provider Session binding.
    // It can only re-enter running through the explicit resume command below;
    // Start must never quietly create a replacement Run or Session.
    if (task.status === TASK_STATUS.ACHIEVED) throw new Error("loop_task_requires_resume_achieved");
    const previousRun = existingCommand ? undefined : latestRun(task.taskId);
    const runId = `run-${randomUUID()}`;
    const sessionScope = previousRun ? safeSegment(runId) : "";
    const timestamp = now();
    const conductorSessionId = workspaceSessionId(task, "conductor", { runId, sessionScope });
    const prepared = taskRunService.prepareStart({
      taskId: task.taskId,
      commandId,
      expectedRevision,
      run: { runId, conductorSessionId, sessionScope, createdAt: timestamp },
    });
    const preparedRunId = required(prepared.result?.runId, "loop_run_not_found");
    const activeTask = required(taskById(task.taskId), "loop_task_not_found");
    // A Task Run owns its terminal workspace.  Start with the Conductor in the
    // primary Group; worker Groups only gain a tab after a real Conductor
    // dispatch has materialized a native Session.
    writeWorkbenchLayout({
      runId: preparedRunId,
      knownSessionIds: [workspaceSessionId(activeTask, "conductor", runById(preparedRunId))],
      layout: defaultWorkbenchLayout([workspaceSessionId(activeTask, "conductor", runById(preparedRunId))]),
    });
    const run = required(runById(preparedRunId), "loop_run_not_found");
    // A Task may receive a user instruction before its first Run exists.  It
    // is still a Conductor input command, not a row to be silently ignored at
    // launch.  Persist its intent before the native process is started, then
    // use the same exact marker / Provider-receipt path as a live wakeup.
    const startupUserMessages = db
      .prepare("SELECT * FROM agent_loop_user_messages WHERE task_id = ? AND status = 'pending' ORDER BY created_at ASC")
      .all(activeTask.taskId);
    for (const item of startupUserMessages) {
      recordUserMessageWakeup({ task: activeTask, run, messageId: item.message_id, message: item.message, status: "attempting" });
    }
    try {
      await startConductor({
        task: activeTask,
        runId: preparedRunId,
        activationOperationId: commandId,
        startupMessages: startupUserMessages.map((item) => ({
          messageId: item.message_id,
          inputId: userMessageWakeupKey(activeTask.taskId, item.message_id),
          message: item.message,
        })),
      });
    } catch (error) {
      // Do not leave a Task labelled `running` with zero live PTYs when the
      // initial native Conductor process failed to start.  The command intent
      // remains queued and a later user retry creates a fresh Run identity.
      for (const item of startupUserMessages) {
        recordUserMessageWakeup({ task: activeTask, run, messageId: item.message_id, message: item.message, status: "queued" });
      }
      const failure = error instanceof Error ? error.message : "conductor_start_failed";
      taskRunService.failStart({ commandId, task: activeTask, run, reason: failure });
      publishPendingTaskEvents();
      throw error;
    }
    for (const item of startupUserMessages) {
      // Starting a PTY only proves that a launch was accepted.  The launch
      // message is not delivered until the Provider database records its
      // exact Conductor Input ID.  Keeping it `attempting` lets the observer
      // queue the same durable intent again if the process died or OpenCode
      // only pasted it into a TUI prompt.
      db.prepare("UPDATE agent_loop_user_messages SET run_id = ? WHERE message_id = ?")
        .run(preparedRunId, item.message_id);
    }
    taskRunService.completeStart({ commandId, task: activeTask, run });
    publishPendingTaskEvents();
    return readRun({ runId: preparedRunId });
  }

  async function startConductor({ task, runId, startupMessages = [], activationOperationId }) {
    if (usesOpenCodeServer) return startConductorOnOpenCodeServer({ task, runId, startupMessages, activationOperationId });
    const run = required(runById(runId), "loop_run_not_found");
    const sessionId = workspaceSessionId(task, "conductor", run);
    const bridge = await getConductorBridgeConfig();
    if (!bridge?.conductorToolBridgeUrl || !bridge?.conductorToolBridgeToken || !bridge?.conductorMcpServerPath) {
      throw new Error("conductor_bridge_not_ready");
    }
    const systemPrompt = conductorPrompt(task);
    const runtimeRoot = `.agent-workspace/runtime/${safeSegment(task.taskId)}/${safeSegment(run.runId)}/conductor`;
    const hookEnvironment = await registerOpenCodeHookSession({ sessionId, cwd: task.cwd });
    const continuationSessionId = latestOpenCodeProviderSessionId({ taskId: task.taskId, workspaceSessionId: sessionId });
    const startupPrompt = formatConductorStartupInput(task, startupMessages);
    sessionAuthority.registerLaunchProfile({
      workspaceSessionId: sessionId,
      taskId: task.taskId,
      command: opencodePath,
      args: [
        "--agent",
        OPEN_CODE_CONDUCTOR_PROVIDER_AGENT,
        ...(continuationSessionId ? ["--session", continuationSessionId] : ["--model", task.architecture.defaultModel]),
        // `--prompt` auto-submits only on OpenCode's new-session Home route.
        // With `--session` OpenCode opens the existing Session route, where the
        // argument is intentionally not submitted. Recovery therefore uses the
        // owned post-TUI interactive submission below instead.
        ...(!continuationSessionId ? ["--prompt", startupPrompt] : []),
      ],
      cwd: task.cwd,
      provider: "opencode",
      model: task.architecture.defaultModel,
      cols: 100,
      rows: 30,
      stdin: "pipe",
      requirePty: true,
      // `--session` does not auto-submit `--prompt`. Its TUI restores history
      // after alternate-buffer entry, so wait for that terminal output to go
      // quiet before the recovery monitor delivers the durable Task message.
      interactiveReadyQuietMs: continuationSessionId ? 4_000 : undefined,
      runtimeFiles: [{ relativePath: `${runtimeRoot}/system.md`, contents: systemPrompt }],
      env: {
        ...nativeOpenCodeEnvironment(opencodePath),
        ...hookEnvironment,
        OPENCODE_CONFIG_CONTENT: JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          instructions: [`${runtimeRoot}/system.md`],
          mcp: {
            agent_workspace_conductor: {
              type: "local",
              command: ["node", bridge.conductorMcpServerPath],
              enabled: true,
              environment: {
                AGENT_WORKSPACE_TOOL_BRIDGE_URL: bridge.conductorToolBridgeUrl,
                AGENT_WORKSPACE_TOOL_BRIDGE_TOKEN: bridge.conductorToolBridgeToken,
              },
            },
          },
          // The legacy TUI compatibility path has only this Conductor process,
          // but it still declares the same named Provider Agent as the Server
          // path. This keeps control-plane authority separate from `build`
          // instead of relying on the CLI default.
          tools: { "agent_workspace_conductor_*": true },
          agent: {
            [OPEN_CODE_CONDUCTOR_PROVIDER_AGENT]: {
              mode: "primary",
              tools: { "agent_workspace_conductor_*": true },
              permission: {
                "*": "deny",
                "agent_workspace_conductor_*": "allow",
                question: "allow",
              },
            },
          },
          default_agent: OPEN_CODE_CONDUCTOR_PROVIDER_AGENT,
        }),
      },
    });
    // An activation operation is one physical start attempt, not a permanent
    // identity for the logical Conductor.  Reusing `loop:${runId}:conductor`
    // after its PTY exited would only replay Session Authority's old completed
    // operation and leave a durable wakeup with no live Host Session.
    const activation = await sessionAuthority.activateSession({
      workspaceSessionId: sessionId,
      operationId: activationOperationId ? `conductor:${runId}:${activationOperationId}` : `conductor:${runId}:${randomUUID()}`,
      callerId: "agent-loop-runtime",
      reason: "conductor-start",
      interactiveTui: true,
    });
    if (!activation?.session || activation.session.status !== "running") {
      throw new Error("conductor_session_not_started");
    }
    // A recovered Task's durable wakeup is delivered exactly once by
    // SessionWakeupMonitor after this TUI is ready.  Do not duplicate it here:
    // two paste/Return sequences can race the same OpenCode composer and make
    // the visible Task input look sent while the Provider receives neither.
    terminalFacts.recordTerminalState?.(
      { taskId: task.taskId, sessionId, cwd: task.cwd },
      "running",
      "Conductor initial decision is active.",
      { runId, source: "agent-loop-runtime" },
    );
    return activation.session;
  }

  async function startConductorOnOpenCodeServer({ task, runId, startupMessages = [] }) {
    const run = required(runById(runId), "loop_run_not_found");
    const sessionId = workspaceSessionId(task, "conductor", run);
    const { client } = await attachOpenCodeRunHost({ task, run, leaseId: runtimeHostLeaseId(run) });
    let providerSessionId = latestOpenCodeProviderSessionId({ taskId: task.taskId, workspaceSessionId: sessionId });
    if (!providerSessionId) {
      const created = await client.createSession({
        cwd: task.cwd,
        title: `Conductor · ${task.title}`,
        agent: OPEN_CODE_CONDUCTOR_PROVIDER_AGENT,
        model: openCodeServerSessionCreationModel({
          model: task.architecture.defaultModel,
          modelVariant: task.architecture.defaultModelVariant,
        }),
        permission: conductorOpenCodePermissionRules(),
        metadata: { agentWorkspaceTaskId: task.taskId, agentWorkspaceRunId: run.runId, agentWorkspaceSessionId: sessionId },
      });
      providerSessionId = required(created?.id, "opencode_server_conductor_session_not_created");
      recordOpenCodeProviderSession({
        task,
        runId: run.runId,
        sessionId,
        providerSessionId,
        summary: "OpenCode Server 已创建 Conductor Session。",
        state: "ready",
      });
    }
    await client.promptAsync({
      cwd: task.cwd,
      providerSessionId,
      text: formatConductorStartupInput(task, startupMessages),
      agent: OPEN_CODE_CONDUCTOR_PROVIDER_AGENT,
      model: openCodeServerContinuationModel({
        model: task.architecture.defaultModel,
        modelVariant: task.architecture.defaultModelVariant,
      }),
      system: conductorPrompt(task),
      tools: conductorOpenCodeTools(),
    });
    recordOpenCodeProviderSession({
      task,
      runId: run.runId,
      sessionId,
      providerSessionId,
      summary: "Conductor initial decision was accepted by OpenCode Server.",
      state: "running",
    });
    return { id: sessionId, status: "running", providerSessionId, transport: "opencode_server" };
  }

  async function attachOpenCodeRunHost({ task, run, leaseId }) {
    const bridge = await getConductorBridgeConfig();
    if (!bridge?.conductorToolBridgeUrl || !bridge?.conductorToolBridgeToken || !bridge?.conductorMcpServerPath) {
      throw new Error("conductor_bridge_not_ready");
    }
    const config = openCodeServerRunConfig({ task, bridge });
    const server = await openCodeServerManager.ensureRun({
      taskId: task.taskId,
      runId: run.runId,
      cwd: task.cwd,
      config,
      leaseId,
    });
    recordOpenCodeHostBinding({ task, run, server, config });
    subscribeOpenCodeServerEvents({ task, run });
    return {
      server,
      client: openCodeServerManager.clientForRun({ taskId: task.taskId, runId: run.runId }),
    };
  }

  async function reconcileOpenCodeRun({ task, run, client, server }) {
    const results = await reconcileOpenCodeSessionBindings({
      client,
      cwd: task.cwd,
      bindings: boundOpenCodeSessions({ task, run }),
    });
    // A rebind only proves that the saved Provider Session still exists.  It
    // does not answer an already-open native permission or question.  Resolve
    // the narrow legacy completion case first, then project each available
    // binding from the remaining durable attention facts rather than blindly
    // turning it into an idle Session.
    reconcileLegacyOpenCodePermissionOccupancy({ task, run, bindings: results });
    const taskState = sessionReadModel.readTaskState({ taskId: task.taskId, sinceCursor: 0 }) ?? {};
    for (const result of results) {
      if (result.status === "available") {
        recordOpenCodeProviderSession({
          task,
          runId: run.runId,
          sessionId: result.sessionId,
          providerSessionId: result.providerSessionId,
          ...openCodeReconciliationProviderState({ taskState, sessionId: result.sessionId }),
        });
      } else if (result.status === "missing") {
        recordOpenCodeProviderSession({
          task,
          runId: run.runId,
          sessionId: result.sessionId,
          providerSessionId: result.providerSessionId,
          summary: "OpenCode Server 找不到已保存的 Provider Session；不会创建替代 Session。",
          state: "blocked",
        });
      }
    }
    recordOpenCodeHostBinding({ task, run, server, reconciledAt: now() });
    return results;
  }

  function openCodeReconciliationProviderState({ taskState, sessionId }) {
    const logicalSessionId = String(sessionId ?? "");
    const pendingPermission = (taskState?.permissions ?? []).some((permission) =>
      String(permission?.sessionId ?? "") === logicalSessionId
      && isPermissionRecordBlockingDispatch(permission),
    );
    if (pendingPermission) {
      return {
        state: "permission_required",
        summary: "OpenCode Server 已重新绑定已保存的 Provider Session；仍在等待原生授权。",
      };
    }
    const session = (taskState?.sessions ?? []).find((item) => String(item?.sessionId ?? "") === logicalSessionId);
    if (String(session?.providerState ?? session?.state ?? "") === "waiting_input") {
      return {
        state: "waiting_input",
        summary: "OpenCode Server 已重新绑定已保存的 Provider Session；仍在等待用户回答。",
      };
    }
    return {
      state: "ready",
      summary: "OpenCode Server 已重新绑定已保存的 Provider Session。",
    };
  }

  function reconcileLegacyOpenCodePermissionOccupancy({ task, run, bindings = [] }) {
    // Before dispatchId was persisted on a permission request, a direct
    // official-WebUI approval could leave that historical request at
    // `requested` even though its exact Provider result was already durable.
    // Rebinding is the only recovery point allowed to backfill those old
    // records. It is fenced to the active Task/Run and uses the existing
    // result fact; it never invents an approval or sends a Provider message.
    const active = currentActiveOpenCodeTaskRun({ task, run });
    if (!active) return;
    const taskState = sessionReadModel.readTaskState({ taskId: active.task.taskId, sinceCursor: 0 }) ?? {};
    for (const binding of bindings) {
      if (binding?.status !== "available") continue;
      const logicalSessionId = String(binding.sessionId ?? "");
      const legacyPermission = (taskState.permissions ?? []).some((permission) =>
        String(permission?.sessionId ?? "") === logicalSessionId
        && !String(permission?.dispatchId ?? "").trim()
        && isPermissionRecordBlockingDispatch(permission),
      );
      if (!legacyPermission) continue;
      const dispatch = (taskState.dispatches ?? []).findLast((item) =>
        String(item?.toSessionId ?? "") === logicalSessionId
        && String(item?.status ?? "") === "result_available",
      );
      const result = dispatch && (taskState.results ?? []).find((item) => String(item?.dispatchId ?? "") === String(dispatch.dispatchId));
      if (!dispatch?.resultAvailableAt || !result) continue;
      providerFacts.recordDispatchResult?.({
        taskId: active.task.taskId,
        sessionId: logicalSessionId,
        dispatchId: dispatch.dispatchId,
        reason: "provider-turn-completed",
        providerTurnCompleted: true,
        legacyPermissionBoundaryAt: dispatch.resultAvailableAt,
        provider: result.provider ?? "opencode",
        providerSessionId: binding.providerSessionId,
        providerMessageId: result.providerMessageId,
        providerStepFinishId: result.providerStepFinishId,
        providerTurnCompletedResultId: result.resultId,
        answerText: result.answerText,
        source: result.source,
        completedAt: result.completedAt,
      });
    }
  }

  function boundOpenCodeSessions({ task, run }) {
    const sessionIds = [
      workspaceSessionId(task, "conductor", run),
      ...task.architecture.agentCards.map((card) => workspaceSessionId(task, card.id, run)),
    ];
    return sessionIds
      .map((sessionId) => ({ sessionId, providerSessionId: latestOpenCodeProviderSessionId({ taskId: task.taskId, workspaceSessionId: sessionId }) }))
      .filter((binding) => Boolean(binding.providerSessionId));
  }

  function recordOpenCodeHostBinding({ task, run, server, config, reconciledAt }) {
    const timestamp = now();
    const configFingerprint = config ? crypto.createHash("sha256").update(JSON.stringify(config)).digest("hex") : undefined;
    const existing = db.prepare("SELECT config_fingerprint FROM agent_loop_opencode_host_bindings WHERE run_id = ?").get(run.runId);
    db.prepare(`
      INSERT INTO agent_loop_opencode_host_bindings
      (run_id, project_root, config_fingerprint, provider_version, last_attached_at, last_reconciled_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id) DO UPDATE SET
        project_root = excluded.project_root,
        config_fingerprint = excluded.config_fingerprint,
        provider_version = excluded.provider_version,
        last_attached_at = excluded.last_attached_at,
        last_reconciled_at = COALESCE(excluded.last_reconciled_at, agent_loop_opencode_host_bindings.last_reconciled_at),
        updated_at = excluded.updated_at
    `).run(
      run.runId,
      String(server?.cwd || task.cwd),
      configFingerprint ?? existing?.config_fingerprint ?? "",
      String(server?.providerVersion || ""),
      timestamp,
      reconciledAt ?? null,
      timestamp,
      timestamp,
    );
  }

  function runtimeHostLeaseId(run) { return `runtime:${run.runId}`; }

  /**
   * An achieved Run retains its durable Provider identity, but it no longer
   * owns an active Server transport lease.  Releasing that one lease lets a
   * shared Host idle down when no other Run is using it; it must not stop the
   * Host, rewrite Provider state, or remove the retained Session binding.
   */
  async function releaseInactiveOpenCodeRunHost({ task, run, tolerateFailures = false }) {
    const unsubscribe = serverEventUnsubscribers.get(run.runId);
    serverEventUnsubscribers.delete(run.runId);
    try { unsubscribe?.(); } catch { /* An already-closed observer is equivalent cleanup. */ }
    if (typeof openCodeServerManager.releaseRun !== "function") return false;
    try {
      return await openCodeServerManager.releaseRun({
        taskId: task.taskId,
        runId: run.runId,
        leaseId: runtimeHostLeaseId(run),
      });
    } catch (error) {
      if (!tolerateFailures) throw error;
      return false;
    }
  }

  function isTaskClosing(taskId) {
    if (closingTaskIds.has(String(taskId))) return true;
    const task = taskRunRepository.taskById(String(taskId));
    return !task || task.status === TASK_STATUS.DELETING;
  }

  /**
   * Provider callbacks retain the Task/Run objects that existed when a Server
   * subscription was attached.  They must never turn those captured objects
   * into new durable facts after a lifecycle command has made the Run
   * historical.  Re-read the canonical Task and its current Run at each
   * asynchronous boundary instead of trusting the callback's closure.
   */
  function currentActiveOpenCodeTaskRun({ task, run }) {
    const currentTask = taskById(String(task?.taskId ?? ""));
    if (!currentTask || isTaskClosing(currentTask.taskId)) return undefined;
    const currentRun = latestRun(currentTask.taskId);
    if (!currentRun || currentRun.runId !== String(run?.runId ?? "")) return undefined;
    if (currentTask.status !== TASK_STATUS.RUNNING || currentRun.status !== RUN_STATUS.RUNNING) return undefined;
    return { task: currentTask, run: currentRun };
  }

  function recordOpenCodeProviderSession({ task, runId, sessionId, providerSessionId, summary, state = "running" }) {
    if (isTaskClosing(task.taskId)) return undefined;
    providerFacts.recordProviderSessionState?.(
      { taskId: task.taskId, sessionId, cwd: task.cwd },
      state,
      summary,
      { runId, source: "opencode-server", provider: "opencode", providerSessionId },
    );
  }

  function subscribeOpenCodeServerEvents({ task, run }) {
    if (serverEventUnsubscribers.has(run.runId) || typeof openCodeServerManager.subscribeRun !== "function") return;
    const unsubscribe = openCodeServerManager.subscribeRun({
      taskId: task.taskId,
      runId: run.runId,
      onEvent: (event) => { void handleOpenCodeServerEvent({ task, run, event }).catch(() => undefined); },
    });
    serverEventUnsubscribers.set(run.runId, unsubscribe);
  }

  async function handleOpenCodeServerEvent({ task, run, event }) {
    const active = currentActiveOpenCodeTaskRun({ task, run });
    if (!active) return;
    const activeTask = active.task;
    const activeRun = active.run;
    const type = String(event?.type ?? "");
    const properties = event?.properties && typeof event.properties === "object" ? event.properties : {};
    const providerSessionId = String(
      properties.sessionID
      ?? properties.sessionId
      ?? properties.info?.sessionID
      ?? properties.info?.sessionId
      ?? properties.message?.sessionID
      ?? properties.message?.sessionId
      ?? properties.part?.sessionID
      ?? properties.part?.sessionId
      ?? "",
    );
    if (!providerSessionId) return;
    const state = sessionReadModel.readTaskState({ taskId: activeTask.taskId, sinceCursor: 0 }) ?? {};
    const session = (state.sessions ?? []).find((item) => String(item?.providerBinding?.providerSessionId ?? "") === providerSessionId);
    if (!session?.sessionId) return;
    const logicalSessionId = String(session.sessionId);
    if (type === "message.updated") {
      const message = properties.info && typeof properties.info === "object"
        ? properties.info
        : properties.message && typeof properties.message === "object"
          ? properties.message
          : {};
      if (String(message.role ?? "") === "user") {
        observeOpenCodeProviderUserMessageReceipt({
          task: activeTask,
          run: activeRun,
          logicalSessionId,
          providerSessionId,
          providerMessageId: message.id ?? message.messageID ?? message.messageId,
          messageText: openCodeEventMessageText(message),
        });
      }
      return;
    }
    if (type === "message.part.updated") {
      const part = properties.part && typeof properties.part === "object" ? properties.part : {};
      if (String(part.type ?? "") === "text") {
        observeOpenCodeProviderUserMessageReceipt({
          task: activeTask,
          run: activeRun,
          logicalSessionId,
          providerSessionId,
          providerMessageId: part.messageID ?? part.messageId,
          messageText: String(part.text ?? ""),
        });
      }
      return;
    }
    if (type === "session.status") {
      const status = String(properties.status?.type ?? properties.status ?? "");
      if (status === "busy") {
        recordOpenCodeProviderSession({ task: activeTask, runId: activeRun.runId, sessionId: logicalSessionId, providerSessionId, summary: "OpenCode Server Session is processing.", state: "running" });
      }
      return;
    }
    if (type === "permission.v2.asked" || type === "permission.asked") {
      const requestId = String(properties.id ?? properties.requestID ?? "");
      if (requestId) {
        const dispatch = latestOpenDispatchForSession(state, logicalSessionId);
        providerFacts.recordPermissionRequested?.({
          taskId: activeTask.taskId,
          sessionId: logicalSessionId,
          cwd: activeTask.cwd,
          permissionId: `opencode:${requestId}`,
          requestId,
          dispatchId: dispatch?.dispatchId,
          provider: "opencode",
          permission: String(properties.action ?? properties.permission ?? "unknown"),
          patterns: Array.isArray(properties.resources) ? properties.resources.map(String) : [],
          summary: `OpenCode 请求授权：${String(properties.action ?? "unknown")}`,
        });
      }
      return;
    }
    if (type === "question.v2.asked" || type === "question.asked") {
      const questionId = String(properties.id ?? properties.requestID ?? "");
      const questions = Array.isArray(properties.questions) ? properties.questions : [];
      recordOpenCodeProviderSession({
        task: activeTask,
        runId: activeRun.runId,
        sessionId: logicalSessionId,
        providerSessionId,
        summary: "OpenCode Session 正在等待用户回答。",
        state: "waiting_input",
      });
      taskTimeline.recordTaskEvent?.({
        taskId: activeTask.taskId,
        sessionId: logicalSessionId,
        cwd: activeTask.cwd,
        type: "provider.question_requested",
        summary: "OpenCode Session 等待用户回答。",
        data: { runId: activeRun.runId, provider: "opencode", providerSessionId, questionId, questions },
      });
      return;
    }
    if (type === "session.idle") {
      recordOpenCodeProviderSession({ task: activeTask, runId: activeRun.runId, sessionId: logicalSessionId, providerSessionId, summary: "OpenCode Server Session is idle.", state: "ready" });
      await observeOpenCodeServerIdle({ task: activeTask, run: activeRun, logicalSessionId, providerSessionId });
    }
  }

  function latestOpenDispatchForSession(taskState, logicalSessionId) {
    return (taskState?.dispatches ?? []).findLast((item) =>
      String(item?.toSessionId ?? "") === String(logicalSessionId)
      && ["queued", "input_accepted", "delivered"].includes(String(item?.status ?? "")),
    );
  }

  function queueProviderUserInputReceipt({ task, run, providerSessionId, inputId, wakeupKey, messageText }) {
    let receiptsByProvider = providerUserInputReceipts.get(run.runId);
    if (!receiptsByProvider) {
      receiptsByProvider = new Map();
      providerUserInputReceipts.set(run.runId, receiptsByProvider);
    }
    const queue = receiptsByProvider.get(providerSessionId) ?? [];
    const existing = queue.find((entry) => entry.inputId === inputId);
    if (existing) return existing;
    const receipt = { taskId: task.taskId, runId: run.runId, providerSessionId, inputId, wakeupKey, messageText };
    queue.push(receipt);
    receiptsByProvider.set(providerSessionId, queue);
    return receipt;
  }

  function takeProviderUserInputReceipt({ run, providerSessionId, providerMessageId }) {
    const receiptsByProvider = providerUserInputReceipts.get(run.runId);
    const queue = receiptsByProvider?.get(providerSessionId);
    if (!queue?.length) return undefined;
    const normalizedMessageId = String(providerMessageId ?? "").trim();
    const index = normalizedMessageId
      ? queue.findIndex((entry) => entry.inputId === normalizedMessageId)
      : -1;
    // Most Web UI requests supply the Provider message id before forwarding.
    // For older request shapes the gateway generates an opaque id, so retain
    // FIFO correlation within this one Conductor Session only.
    const matchedIndex = index >= 0 ? index : queue.findIndex((entry) => !entry.providerMessageId);
    if (matchedIndex < 0) return undefined;
    const [receipt] = queue.splice(matchedIndex, 1);
    if (!queue.length) {
      receiptsByProvider.delete(providerSessionId);
      if (!receiptsByProvider.size) providerUserInputReceipts.delete(run.runId);
    }
    return receipt;
  }

  function observeOpenCodeProviderUserMessageReceipt({
    task,
    run,
    logicalSessionId,
    providerSessionId,
    providerMessageId,
    messageText,
  }) {
    if (logicalSessionId !== workspaceSessionId(task, "conductor", run)) return undefined;
    const normalizedProviderMessageId = String(providerMessageId ?? "").trim();
    if (!normalizedProviderMessageId) return undefined;
    const receipt = takeProviderUserInputReceipt({ run, providerSessionId, providerMessageId: normalizedProviderMessageId });
    // Startup and Runtime-generated wakeups do not enter this queue. They are
    // already owned by their own command/Provider receipt paths and must never
    // be reclassified as direct Web UI user input.
    if (!receipt) return undefined;
    const currentTask = taskById(task.taskId);
    const currentRun = currentTask ? latestRun(currentTask.taskId) : undefined;
    if (!currentTask || currentRun?.runId !== run.runId) return undefined;
    const currentProviderSessionId = latestOpenCodeProviderSessionId({
      taskId: currentTask.taskId,
      workspaceSessionId: logicalSessionId,
    });
    if (currentProviderSessionId !== providerSessionId) return undefined;
    const existingWakeup = (sessionReadModel.readTaskState({ taskId: currentTask.taskId, sinceCursor: 0 })?.wakeups ?? [])
      .find((entry) => String(entry?.wakeupKey ?? "") === receipt.wakeupKey);
    const observed = recordUserMessageWakeup({
      task: currentTask,
      run: currentRun,
      wakeupKey: receipt.wakeupKey,
      message: String(messageText ?? "").trim() || receipt.messageText,
      status: "observed",
      provider: "opencode",
      providerSessionId,
      providerMessageId: normalizedProviderMessageId,
    });
    if (existingWakeup?.status !== "observed") {
      recordRunEvent({
        runId: currentRun.runId,
        type: "conductor.provider_user_input_observed",
        summary: "官方 OpenCode WebUI 已确认用户后续消息。",
        data: {
          inputId: receipt.inputId,
          provider: "opencode",
          providerSessionId,
          providerMessageId: normalizedProviderMessageId,
          message: observed.messageText,
        },
      });
    }
    return observed;
  }

  async function observeOpenCodeServerIdle({ task, run, logicalSessionId, providerSessionId }) {
    const activeBeforeRead = currentActiveOpenCodeTaskRun({ task, run });
    if (!activeBeforeRead) return;
    const client = openCodeServerManager.clientForRun({ taskId: activeBeforeRead.task.taskId, runId: activeBeforeRead.run.runId });
    const messages = await client.messages({ cwd: activeBeforeRead.task.cwd, providerSessionId, limit: 40 });
    const assistant = latestOpenCodeAssistantMessage(messages);
    if (!assistant?.text) return;
    // Lifecycle commands and Provider callbacks race in separate transports.
    // Re-enter the Task-owned lane only after the external read has completed;
    // then resolve the Task/Run again before adding a result, wakeup, or
    // continuation.  This makes an archived/deleted/stale Run a no-op rather
    // than a late semantic event.
    return serializeTaskLifecycle(activeBeforeRead.task.taskId, async () => {
      const active = currentActiveOpenCodeTaskRun({ task: activeBeforeRead.task, run: activeBeforeRead.run });
      if (!active) return;
      const activeTask = active.task;
      const activeRun = active.run;
      const conductorSessionId = workspaceSessionId(activeTask, "conductor", activeRun);
      if (logicalSessionId === conductorSessionId) {
        coordinatorFacts.recordConductorMessage?.({
          taskId: activeTask.taskId,
          sessionId: logicalSessionId,
          cwd: activeTask.cwd,
          message: assistant.text,
          summary: "Conductor output message",
          source: "opencode-server-event",
          provider: "opencode",
          providerSessionId,
          providerMessageId: assistant.messageId,
          completedAt: assistant.completedAt,
        });
        return;
      }
      const state = sessionReadModel.readTaskState({ taskId: activeTask.taskId, sinceCursor: 0 }) ?? {};
      const dispatch = latestOpenDispatchForSession(state, logicalSessionId);
      if (!dispatch) return;
      const updated = providerFacts.recordDispatchResult?.({
        taskId: activeTask.taskId,
        sessionId: logicalSessionId,
        dispatchId: dispatch.dispatchId,
        reason: "provider-turn-completed",
        providerTurnCompleted: true,
        provider: "opencode",
        providerSessionId,
        providerMessageId: assistant.messageId,
        answerText: assistant.text,
        source: "opencode-server-event",
        completedAt: assistant.completedAt,
      });
      if (updated?.status !== "result_available" || updated.changed === false) return;
      await wakeConductorFromOpenCodeResult({ task: activeTask, run: activeRun, dispatch, result: updated });
    });
  }

  async function wakeConductorFromOpenCodeResult({ task, run, dispatch, result }) {
    // `observeOpenCodeServerIdle` invokes this while it owns the Task lifecycle
    // lane. Keep the guard here as well so every durable wakeup/send boundary
    // resolves the canonical Task/Run rather than the Server callback closure.
    const active = currentActiveOpenCodeTaskRun({ task, run });
    if (!active) return;
    const activeTask = active.task;
    const activeRun = active.run;
    const conductorSessionId = workspaceSessionId(activeTask, "conductor", activeRun);
    const conductorProviderSessionId = latestOpenCodeProviderSessionId({ taskId: activeTask.taskId, workspaceSessionId: conductorSessionId });
    if (!conductorProviderSessionId) return;
    const wakeupKey = `result:${activeTask.taskId}:${dispatch.dispatchId}`;
    const wakeup = coordinatorFacts.recordConductorWakeup?.({
      taskId: activeTask.taskId,
      sessionId: conductorSessionId,
      wakeupKey,
      kind: "result",
      workerSessionId: dispatch.toSessionId,
      agentId: dispatch.agentId,
      dispatchId: dispatch.dispatchId,
      resultId: result.resultId,
      workerState: "result_available",
      answerText: result.answerText,
      provider: "opencode",
      providerSessionId: conductorProviderSessionId,
      status: "attempting",
      summary: "OpenCode Server 正在唤醒 Conductor 查看 Worker 结果。",
    });
    if (wakeup?.status === "sent" || wakeup?.status === "observed") return;
    return serializeConductorServerMessage(activeRun.runId, async () => {
      const activeBeforeSend = currentActiveOpenCodeTaskRun({ task: activeTask, run: activeRun });
      if (!activeBeforeSend) return;
      const currentConductorSessionId = workspaceSessionId(activeBeforeSend.task, "conductor", activeBeforeSend.run);
      const currentConductorProviderSessionId = latestOpenCodeProviderSessionId({
        taskId: activeBeforeSend.task.taskId,
        workspaceSessionId: currentConductorSessionId,
      });
      if (!currentConductorProviderSessionId || currentConductorProviderSessionId !== conductorProviderSessionId) return;
      const client = openCodeServerManager.clientForRun({ taskId: activeBeforeSend.task.taskId, runId: activeBeforeSend.run.runId });
      try {
        const accepted = await client.sendMessage({
          cwd: activeBeforeSend.task.cwd,
          providerSessionId: currentConductorProviderSessionId,
          agent: OPEN_CODE_CONDUCTOR_PROVIDER_AGENT,
          model: openCodeServerContinuationModel({
            model: activeBeforeSend.task.architecture.defaultModel,
            modelVariant: activeBeforeSend.task.architecture.defaultModelVariant,
          }),
          system: conductorPrompt(activeBeforeSend.task),
          tools: conductorOpenCodeTools(),
          text: formatOpenCodeResultWakeup({ dispatch, result, wakeupKey }),
          timeoutMs: 120_000,
        });
        const activeAfterSend = currentActiveOpenCodeTaskRun({ task: activeBeforeSend.task, run: activeBeforeSend.run });
        if (!activeAfterSend) return;
        coordinatorFacts.recordConductorWakeup?.({
          ...wakeup,
          status: "sent",
          providerMessageId: accepted?.providerMessageId,
        });
        recordOpenCodeProviderSession({
          task: activeAfterSend.task,
          runId: activeAfterSend.run.runId,
          sessionId: workspaceSessionId(activeAfterSend.task, "conductor", activeAfterSend.run),
          providerSessionId: currentConductorProviderSessionId,
          summary: "Conductor completed a Worker result wakeup.",
          state: "ready",
        });
      } catch {
        const activeAfterFailure = currentActiveOpenCodeTaskRun({ task: activeBeforeSend.task, run: activeBeforeSend.run });
        if (!activeAfterFailure) return;
        coordinatorFacts.recordConductorWakeup?.({ ...wakeup, status: "queued" });
      }
    });
  }

  function serializeConductorServerMessage(runId, operation) {
    const previous = conductorServerMessageQueues.get(runId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(operation);
    const settled = next.finally(() => {
      if (conductorServerMessageQueues.get(runId) === settled) conductorServerMessageQueues.delete(runId);
    });
    conductorServerMessageQueues.set(runId, settled);
    return settled;
  }

  async function registerWorkerProfile({ task, run, card, initialPrompt } = {}) {
    const sessionId = workspaceSessionId(task, card.id, run);
    const hookEnvironment = await registerOpenCodeHookSession({ sessionId, cwd: task.cwd });
    const continuationSessionId = latestOpenCodeProviderSessionId({ taskId: task.taskId, workspaceSessionId: sessionId });
    sessionAuthority.registerLaunchProfile({
      workspaceSessionId: sessionId,
      taskId: task.taskId,
      command: opencodePath,
      // A fresh native terminal is sometimes required after its PTY ended,
      // but the logical Session must not lose its OpenCode conversation.  The
      // Provider session id is recorded with a receipt/result/wakeup, so the
      // replacement process can continue that exact conversation instead of
      // creating a second, context-free worker.
      args: [
        ...(continuationSessionId ? ["--session", continuationSessionId] : ["--model", card.model]),
        // See the matching Conductor branch above: only a new-session TUI can
        // auto-submit --prompt. A recovered worker receives its dispatch after
        // the Session route becomes interactive.
        ...(!continuationSessionId && String(initialPrompt ?? "").trim() ? ["--prompt", String(initialPrompt)] : []),
      ],
      cwd: task.cwd,
      provider: "opencode",
      model: card.model,
      cols: 100,
      rows: 30,
      stdin: "pipe",
      requirePty: true,
      interactiveReadyQuietMs: continuationSessionId ? 4_000 : undefined,
      env: { ...nativeOpenCodeEnvironment(opencodePath), ...hookEnvironment },
      // Deliberately no Workspace MCP, runtime files, or system prompt.
    });
    return { sessionId, initialPromptSubmitted: !continuationSessionId && Boolean(String(initialPrompt ?? "").trim()) };
  }

  async function registerOpenCodeHookSession({ sessionId, cwd }) {
    if (!openCodeHookService?.registerSession) return {};
    const registration = await openCodeHookService.registerSession({
      sessionId,
      cwd,
      onEvent: (event) => onProviderHookEvent?.(event),
    });
    return registration?.env ?? {};
  }

  function resolveAgentSession({ taskId, agentId, runId }) {
    const task = taskById(String(taskId));
    if (!task) return undefined;
    const run = runId ? runById(String(runId)) : latestRun(task.taskId);
    if (!run || run.taskId !== task.taskId) return undefined;
    if (String(agentId) === "conductor") {
      return {
        agentId: "conductor",
        sessionId: workspaceSessionId(task, "conductor", run),
        card: {
          id: "conductor",
          name: task.architecture.template.conductor.role,
          role: "Conductor",
          model: task.architecture.defaultModel,
          ...(optionalModelVariant(task.architecture.defaultModelVariant)
            ? { modelVariant: optionalModelVariant(task.architecture.defaultModelVariant) }
            : {}),
        },
      };
    }
    const card = task.architecture.agentCards.find((item) => item.id === String(agentId));
    if (!card) return undefined;
    return { agentId: card.id, sessionId: workspaceSessionId(task, card.id, run), card };
  }

  async function prepareWorkerInitialDispatch({ taskId, agentId, sessionId, initialPrompt }) {
    const task = required(taskById(String(taskId)), "loop_task_not_found");
    const run = required(latestRun(task.taskId), "loop_run_not_found");
    const resolved = required(resolveAgentSession({ taskId: task.taskId, agentId, runId: run.runId }), "loop_agent_card_not_found");
    if (resolved.agentId === "conductor" || resolved.sessionId !== String(sessionId)) {
      throw new Error("loop_worker_dispatch_target_invalid");
    }
    const live = ptyManager.get?.(resolved.sessionId);
    if (live?.status === "running") return { initialPromptSubmitted: false, sessionId: resolved.sessionId };
    const profile = await registerWorkerProfile({
      task,
      run,
      card: resolved.card,
      initialPrompt: required(initialPrompt, "loop_worker_initial_prompt"),
    });
    // `--prompt` auto-submits only after the newly created TUI is internally
    // ready. The process remains interactive after the Provider turn.
    return { initialPromptSubmitted: profile.initialPromptSubmitted, sessionId: resolved.sessionId };
  }

  async function deliverOpenCodeWorkerAssignment({ dispatch, text } = {}) {
    if (!usesOpenCodeServer) throw new Error("opencode_server_delivery_not_enabled");
    const task = required(taskById(String(dispatch?.taskId)), "loop_task_not_found");
    const run = required(latestRun(task.taskId), "loop_run_not_found");
    const resolved = required(resolveAgentSession({ taskId: task.taskId, agentId: dispatch?.agentId, runId: run.runId }), "loop_agent_card_not_found");
    if (resolved.agentId === "conductor" || resolved.sessionId !== String(dispatch?.toSessionId)) {
      throw new Error("loop_worker_dispatch_target_invalid");
    }
    const { client } = await attachOpenCodeRunHost({ task, run, leaseId: runtimeHostLeaseId(run) });
    let providerSessionId = latestOpenCodeProviderSessionId({ taskId: task.taskId, workspaceSessionId: resolved.sessionId });
    if (!providerSessionId) {
      const created = await client.createSession({
        cwd: task.cwd,
        title: `${resolved.card.name} · ${task.title}`,
        agent: OPEN_CODE_WORKER_PROVIDER_AGENT,
        model: openCodeServerSessionCreationModel({
          model: resolved.card.model,
          modelVariant: resolved.card.modelVariant,
        }),
        permission: workerOpenCodePermissionRules(),
        metadata: { agentWorkspaceTaskId: task.taskId, agentWorkspaceRunId: run.runId, agentWorkspaceSessionId: resolved.sessionId },
      });
      providerSessionId = required(created?.id, "opencode_server_worker_session_not_created");
      recordOpenCodeProviderSession({
        task,
        runId: run.runId,
        sessionId: resolved.sessionId,
        providerSessionId,
        summary: `OpenCode Server 已创建 ${resolved.card.name} Session。`,
        state: "ready",
      });
    }
    const invocation = formatWorkerInvocationInput({
      task,
      card: resolved.card,
      dispatch,
      text: required(text, "loop_worker_initial_prompt"),
    });
    await client.promptAsync({
      cwd: task.cwd,
      providerSessionId,
      text: invocation,
      agent: OPEN_CODE_WORKER_PROVIDER_AGENT,
      model: openCodeServerContinuationModel({
        model: resolved.card.model,
        modelVariant: resolved.card.modelVariant,
      }),
      system: workerPrompt({ task, card: resolved.card }),
      tools: workerOpenCodeTools(),
    });
    recordOpenCodeProviderSession({
      task,
      runId: run.runId,
      sessionId: resolved.sessionId,
      providerSessionId,
      summary: `OpenCode Server accepted Dispatch ${dispatch.dispatchId}.`,
      state: "running",
    });
    return { accepted: true, providerSessionId, targetSessionState: "queued" };
  }

  async function abortOpenCodeDispatch({ dispatch } = {}) {
    if (!usesOpenCodeServer) throw new Error("opencode_server_delivery_not_enabled");
    const task = required(taskById(String(dispatch?.taskId)), "loop_task_not_found");
    const run = required(latestRun(task.taskId), "loop_run_not_found");
    const providerSessionId = latestOpenCodeProviderSessionId({ taskId: task.taskId, workspaceSessionId: dispatch?.toSessionId });
    if (!providerSessionId) throw new Error("provider_session_not_bound");
    const { client } = await attachOpenCodeRunHost({ task, run, leaseId: runtimeHostLeaseId(run) });
    const result = await client.abort({ cwd: task.cwd, providerSessionId });
    return { accepted: result === true || result === undefined, providerSessionId };
  }

  function latestOpenCodeProviderSessionId({ taskId, workspaceSessionId }) {
    const state = sessionReadModel.readTaskState?.({ taskId, sinceCursor: 0 }) ?? {};
    const targetSessionId = String(workspaceSessionId ?? "");
    const binding = (Array.isArray(state.sessions) ? state.sessions : []).find((item) => String(item?.sessionId ?? "") === targetSessionId)?.providerBinding;
    if (String(binding?.provider ?? "") === "opencode" && String(binding?.providerSessionId ?? "").trim()) {
      return String(binding.providerSessionId).trim();
    }
    // Older runs predate the canonical Session binding. Their provider facts
    // remain valid migration evidence, but only this fallback scans bounded
    // history; future Provider observations update providerBinding above.
    const candidates = [
      ...(Array.isArray(state.dispatches) ? state.dispatches : []).filter((item) => String(item?.toSessionId ?? "") === targetSessionId),
      ...(Array.isArray(state.wakeups) ? state.wakeups : []).filter((item) => String(item?.sessionId ?? "") === targetSessionId),
      ...(Array.isArray(state.events) ? state.events : []).filter((item) => String(item?.sessionId ?? "") === targetSessionId).map((item) => item?.data),
      ...(Array.isArray(state.sessions) ? state.sessions : []).filter((item) => String(item?.sessionId ?? "") === targetSessionId).map((item) => item?.lastStateData),
    ];
    for (const candidate of candidates.reverse()) {
      const provider = String(candidate?.provider ?? "opencode");
      const providerSessionId = String(candidate?.providerSessionId ?? "").trim();
      if (provider === "opencode" && providerSessionId) return providerSessionId;
    }
    return undefined;
  }

  function taskAgentMap({ taskId }) {
    const task = taskById(String(taskId));
    if (!task) return {};
    const run = latestRun(task.taskId);
    if (!run) return {};
    return Object.fromEntries([
      [workspaceSessionId(task, "conductor", run), "conductor"],
      ...task.architecture.agentCards.map((card) => [workspaceSessionId(task, card.id, run), card.id]),
    ]);
  }

  function validateDispatch({ taskId, agentId, toSessionId, contextRefs }) {
    const task = taskById(String(taskId));
    // A delivery claim closes the current Conductor decision epoch. It does
    // not permanently close the Task, but it cannot be undone by another tool
    // call from that same provider turn. A user message or a durable Runtime
    // wakeup explicitly opens the next epoch before dispatch is permitted.
    if (!task || task.status !== "running") {
      return { ok: false, reason: "loop_task_not_dispatchable" };
    }
    const run = latestRun(task.taskId);
    const resolved = resolveAgentSession({ taskId, agentId, runId: run?.runId });
    const allowed = new Set(task.architecture.agentCards.map((card) => workspaceSessionId(task, card.id, run)));
    if (!resolved || resolved.sessionId !== String(toSessionId) || !allowed.has(String(toSessionId))) {
      return { ok: false, reason: "loop_target_not_in_confirmed_agent_cards" };
    }
    // This is a transport ownership boundary, not a fixed workflow route: one
    // native interactive OpenCode Session has one outstanding assignment until
    // the Provider reports a result or a terminal/provider delivery failure.
    // The Conductor is still free to choose any card, retry after a failure, or
    // send follow-up work after a result.  Reading durable state means the
    // invariant survives Electron restart and is not inferred from TUI text.
    const taskState = sessionReadModel.readTaskState?.({ taskId: task.taskId, sinceCursor: 0 });
    // Permission recovery owns the current native Session until OpenCode has
    // issued a fresh request and recorded the user's retained answer.  A new
    // dispatch must not be delivered into that restored TUI: it could replace
    // the permission prompt or be later interrupted by an old dispatch
    // cancellation.  This is a transport occupancy fact, not a workflow rule.
    const pendingPermission = (taskState?.permissions ?? []).find(
      (permission) =>
        String(permission?.sessionId ?? "") === String(toSessionId) &&
        isPermissionRecordBlockingDispatch(permission),
    );
    if (pendingPermission) {
      return {
        ok: false,
        reason: "loop_session_permission_decision_pending",
        permissionId: String(pendingPermission.permissionId ?? ""),
      };
    }
    const outstanding = (taskState?.dispatches ?? []).find(
      (dispatch) =>
        String(dispatch?.toSessionId ?? "") === String(toSessionId) &&
        ["queued", "input_accepted", "delivered", "cancellation_requested", "cancel_failed"].includes(String(dispatch?.status ?? "")),
    );
    if (outstanding) {
      return {
        ok: false,
        reason: "loop_session_has_outstanding_dispatch",
        activeDispatchId: String(outstanding.dispatchId ?? ""),
      };
    }
    return { ok: true };
  }

  function resumeTaskForDispatch({ taskId }) {
    const task = required(taskById(required(taskId, "taskId")), "loop_task_not_found");
    if (isTaskUnavailableForContinuation(task.status)) throw new Error("loop_task_is_closed");
    const run = required(latestRun(task.taskId), "loop_run_not_found");
    if (task.status === "delivery_ready") throw new Error("loop_task_requires_new_conductor_input");
    return readRun({ runId: run.runId });
  }

  function resumeTaskForConductorInput({ taskId, cause, inputId } = {}) {
    const task = required(taskById(required(taskId, "taskId")), "loop_task_not_found");
    if (isTaskUnavailableForContinuation(task.status)) throw new Error("loop_task_is_closed");
    const run = required(latestRun(task.taskId), "loop_run_not_found");
    if (task.status !== TASK_STATUS.DELIVERY_READY) return readRun({ runId: run.runId });
    const resumed = taskRunService.resumeForConductorInput({ taskId: task.taskId, cause, inputId });
    return readRun({ runId: resumed?.runId || run.runId });
  }

  /**
   * The Host-owned official Web UI gateway invokes this before proxying a
   * Conductor message to OpenCode.  It is intentionally separate from
   * `recordUserMessage`: the Provider will receive the original browser
   * request, so writing another Runtime composer message here would submit it
   * twice. The gateway awaits this durable preflight before it can start the
   * Provider turn that may call the Conductor bridge.
   */
  function observeProviderUserInputBeforeExecution({ taskId, runId, sessionId, providerSessionId, inputId, text } = {}) {
    const normalizedTaskId = required(taskId, "taskId");
    // Provider input may arrive while a user clicks Achieve. Put the gateway
    // preflight in the same Task-owned lane as lifecycle commands so it either
    // becomes a real pre-Achieve continuation or observes the close fence
    // before it writes any durable wakeup/intent facts.
    return serializeTaskLifecycle(normalizedTaskId, () => observeProviderUserInputBeforeExecutionOnce({
      taskId: normalizedTaskId,
      runId,
      sessionId,
      providerSessionId,
      inputId,
      text,
    }));
  }

  function observeProviderUserInputBeforeExecutionOnce({ taskId, runId, sessionId, providerSessionId, inputId, text } = {}) {
    if (!usesOpenCodeServer) throw new Error("opencode_server_input_observer_unavailable");
    const task = required(taskById(required(taskId, "taskId")), "loop_task_not_found");
    const run = required(runById(required(runId, "runId")), "loop_run_not_found");
    if (run.taskId !== task.taskId) throw new Error("provider_user_input_task_run_mismatch");
    const currentRun = required(latestRun(task.taskId), "loop_run_not_found");
    if (currentRun.runId !== run.runId) throw new Error("provider_user_input_run_is_not_current");
    // Check before recording the Coordinator-owned attempting receipt. A
    // closed Task retains its historical Session binding, but an old page must
    // not add a synthetic wakeup merely because it raced presentation cleanup.
    if (isTaskUnavailableForContinuation(task.status)) throw new Error("loop_task_is_closed");
    const conductorSessionId = workspaceSessionId(task, "conductor", run);
    if (String(sessionId ?? "") !== conductorSessionId) throw new Error("provider_user_input_session_is_not_conductor");
    const boundProviderSessionId = latestOpenCodeProviderSessionId({ taskId: task.taskId, workspaceSessionId: conductorSessionId });
    if (!boundProviderSessionId || String(providerSessionId ?? "") !== boundProviderSessionId) {
      throw new Error("provider_user_input_session_not_bound");
    }
    const normalizedInputId = String(required(inputId, "provider_input_id")).trim();
    const messageText = String(text ?? "").trim();
    if (!messageText) throw new Error("provider_user_input_text_required");
    const wakeupKey = providerUserInputWakeupKey({ task, run, inputId: normalizedInputId });

    // The Coordinator owns the transport fact.  Store its `attempting` state
    // before opening the decision epoch so a crash or a proxy retry still has
    // one durable, idempotent Provider-input identity to reconcile.
    recordUserMessageWakeup({
      task,
      run,
      wakeupKey,
      message: messageText,
      status: "attempting",
      provider: "opencode",
      providerSessionId: boundProviderSessionId,
    });
    recordProviderUserInputIntent({
      task,
      run,
      inputId: normalizedInputId,
      providerSessionId: boundProviderSessionId,
      messageText,
    });
    const resumed = resumeTaskForConductorInput({
      taskId: task.taskId,
      cause: "official_web_ui_user_message",
      inputId: normalizedInputId,
    });
    queueProviderUserInputReceipt({
      task,
      run,
      providerSessionId: boundProviderSessionId,
      inputId: normalizedInputId,
      wakeupKey,
      messageText,
    });
    return {
      ok: true,
      taskId: task.taskId,
      runId: run.runId,
      sessionId: conductorSessionId,
      providerSessionId: boundProviderSessionId,
      inputId: normalizedInputId,
      wakeupKey,
      taskStatus: resumed.task.status,
    };
  }

  function recordProviderUserInputIntent({ task, run, inputId, providerSessionId, messageText }) {
    const commandId = providerUserInputIntentCommandId({ run, inputId });
    return taskRunRepository.commitCommand({
      commandId,
      taskId: task.taskId,
      kind: "task.provider_user_input",
      payload: { inputId, provider: "opencode", providerSessionId, message: messageText },
      mutate({ appendRunEvent, latestRun: currentLatestRun }) {
        const latest = currentLatestRun(task.taskId);
        if (!latest || latest.runId !== run.runId) throw new Error("provider_user_input_run_is_not_current");
        appendRunEvent({
          runId: latest.runId,
          type: "conductor.provider_user_input_attempting",
          summary: "官方 OpenCode WebUI 用户消息已登记，正在等待 Provider 回执。",
          data: { inputId, provider: "opencode", providerSessionId, message: messageText },
        });
        return { taskId: task.taskId, runId: latest.runId, inputId };
      },
    }).result;
  }

  function prepareDispatchContext({ taskId, contextRefs }) {
    const task = required(taskById(required(taskId, "taskId")), "loop_task_not_found");
    if (contextRefs !== undefined && !Array.isArray(contextRefs)) throw new Error("context_refs_must_be_array");
    const refs = (contextRefs ?? []).map((value) => String(value ?? "").trim()).filter(Boolean);
    const state = sessionReadModel.readTaskState({ taskId: task.taskId, sinceCursor: 0 }) ?? { results: [] };
    const resultById = new Map((state.results ?? []).map((result) => [String(result?.resultId ?? ""), result]));
    const agentBySessionId = taskAgentMap({ taskId: task.taskId });
    const contextPackets = [];

    for (const ref of refs) {
      // A declared context reference is an explicit semantic handoff request.
      // Do not silently discard malformed references and never try to extract
      // a reference from the opaque natural-language assignment.
      if (!ref.startsWith("result:")) throw new Error("context_reference_unsupported");
      const resultId = ref.slice("result:".length).trim();
      if (!resultId) throw new Error("context_result_id_missing");
      const result = resultById.get(resultId);
      if (!result || String(result.taskId ?? task.taskId) !== task.taskId) {
        throw new Error("context_result_not_found");
      }
      const answerText = String(result.answerText ?? "");
      if (!answerText.trim()) throw new Error("context_result_answer_unavailable");
      if (answerText.length > MAX_FORWARDED_RESULT_CHARS) throw new Error("context_result_too_large");
      contextPackets.push({
        ref,
        kind: "provider_result",
        resultId,
        sourceAgentId: agentBySessionId[String(result.sessionId ?? "")] || undefined,
        sourceDispatchId: String(result.dispatchId ?? ""),
        answerText,
        createdAt: result.createdAt ? String(result.createdAt) : undefined,
      });
    }

    return { contextRefs: refs, contextPackets };
  }

  function recordCompletionClaim({ taskId, sessionId, message, summary }) {
    const task = taskById(String(taskId));
    if (!task) return undefined;
    const run = latestRun(task.taskId);
    if (!run) throw new Error("loop_run_not_found");
    // A late Provider/Conductor claim must not reopen a Task after a user has
    // claimed Stop, completion, or deletion. The Task/Run service remains the
    // only lifecycle writer; this is a read-only acknowledgement of stale
    // semantic input.
    if (![TASK_STATUS.RUNNING, TASK_STATUS.DELIVERY_READY].includes(task.status)) return readRun({ runId: run.runId });
    if (task.status === TASK_STATUS.DELIVERY_READY) return readRun({ runId: run.runId });
    // A delivery claim belongs to the Task's user-facing lifecycle.  The
    // logical Run stays live: native PTYs may remain attached and the
    // Conductor may later make another explicit dispatch.  This is not a
    // hidden route or a Runtime judgment about task correctness.
    // The assignment is also an in-place migration for historical Runs that
    // stored `delivery_ready` on the Run before this ownership distinction.
    const claimed = taskRunService.claimDelivery({
      taskId: task.taskId,
      sessionId: sessionId || run.conductorSessionId,
      message,
      summary,
    });
    publishPendingTaskEvents();
    return readRun({ runId: claimed?.runId || run.runId });
  }

  async function recordUserMessage({ taskId, message, data = {}, commandId, expectedRevision } = {}) {
    const task = required(taskById(required(taskId, "taskId")), "loop_task_not_found");
    if (isTaskUnavailableForContinuation(task.status)) throw new Error("loop_task_is_closed");
    const text = required(message, "user_message");
    const run = latestRun(task.taskId);
    const conductorSessionId = run ? workspaceSessionId(task, "conductor", run) : "";
    const retry = run ? retryableUnconfirmedUserMessage({ task, run, message: text }) : undefined;
    const normalizedCommandId = String(commandId || `command:message:${randomUUID()}`);
    const proposedMessageId = retry?.message_id ?? `message-${randomUUID()}`;
    // Retrying a historical false-success is not a second user utterance.
    // Keep one blue user message in Timeline and record a separate transport
    // fact for the retry, so repeated Send clicks do not fabricate a new
    // conversation history.
    const committed = taskRunRepository.commitCommand({
      commandId: normalizedCommandId,
      taskId: task.taskId,
      kind: "task.send_message",
      payload: { message: text, data },
      expectedRevision,
      mutate({ appendRunEvent, enqueueTaskEvent, insertUserMessage, resetUserMessage, task: currentTask, touchTask }) {
        const messageId = proposedMessageId;
        if (retry) {
          // Older builds incorrectly recorded `sent` as `delivered` when the
          // replacement PTY merely started. Reuse its exact Provider input ID.
          resetUserMessage(messageId);
        } else {
          insertUserMessage({
            messageId,
            taskId: currentTask.taskId,
            runId: run?.runId,
            message: text,
          });
        }
        const changedTask = touchTask({ taskId: currentTask.taskId });
        const outboxId = `${normalizedCommandId}:task.user_message`;
        enqueueTaskEvent({
          outboxId,
          taskId: currentTask.taskId,
          runId: run?.runId,
          sessionId: conductorSessionId,
          cwd: currentTask.cwd,
          type: retry ? "task.user_message_retrying" : "task.user_message",
          summary: retry ? "重新提交此前未获 Provider 回执的用户消息。" : text.slice(0, 240),
          data: { ...data, message: text, ...(retry ? { retryOfMessageId: retry.message_id } : {}) },
        });
        if (run) {
          appendRunEvent({
            runId: run.runId,
            type: retry ? "task.user_message_retrying" : "task.user_message",
            summary: retry ? "重新提交此前未获 Provider 回执的用户消息。" : text,
            data: { messageId, message: text, ...(retry ? { retried: true, retryOfMessageId: retry.message_id } : {}) },
          });
        }
        return {
          taskId: changedTask.taskId,
          taskRevision: changedTask.revision,
          runId: run?.runId,
          messageId,
          retried: Boolean(retry),
          outboxId,
        };
      },
    });
    const result = committed.result;
    const published = publishPendingTaskEvents();
    const event = published.find((item) => item.outbox.outboxId === result.outboxId)?.event;
    const messageId = result.messageId;
    const currentTask = required(taskById(task.taskId), "loop_task_not_found");
    const wakeupKey = userMessageWakeupKey(currentTask.taskId, messageId);
    const existingWakeup = committed.replayed
      ? (sessionReadModel.readTaskState({ taskId: currentTask.taskId })?.wakeups ?? [])
          .find((item) => String(item?.wakeupKey ?? "") === wakeupKey)
      : undefined;
    if (run) {
      // Treat a user follow-up as the same durable Conductor-input command as
      // a Runtime wakeup.  It gains an exact Provider marker and survives an
      // Electron restart; Task state does not reopen merely because the UI
      // wrote a row to SQLite.
      if (!existingWakeup) {
        recordUserMessageWakeup({
          task: currentTask,
          run,
          messageId,
          message: text,
          status: "queued",
          retryLegacyUnconfirmed: Boolean(result.retried),
        });
      }
    }
    // A prior Server acknowledgement can survive a process restart between
    // the Coordinator fact and the Task/Run transaction. Replaying the same
    // command must finish that one decision epoch, never submit a second
    // Provider message or append a second `task.continued` event.
    if (existingWakeup?.status === "observed" && run) {
      resumeTaskForConductorInput({
        taskId: currentTask.taskId,
        cause: "user_message",
        inputId: wakeupKey,
      });
    }
    // A failed Server delivery deliberately returns its durable wakeup to
    // `queued`. Replaying the same user command must retry that one message,
    // while an in-flight or observed receipt remains a no-op.
    const wakeup = existingWakeup?.status === "queued"
      ? await flushPendingUserMessages({ taskId: currentTask.taskId })
      : existingWakeup
        ? { delivered: 0, queued: 0, delivery: "idempotent_command_replay", status: existingWakeup.status }
        : await flushPendingUserMessages({ taskId: currentTask.taskId });
    return {
      ok: true,
      event,
      messageId,
      retried: Boolean(result.retried),
      revision: currentTask.revision,
      wakeup,
      taskState: sessionReadModel.readTaskState({ taskId: currentTask.taskId }),
    };
  }

  async function respondPermission({ taskId, sessionId, permissionId, response } = {}) {
    const task = required(taskById(required(taskId, "taskId")), "loop_task_not_found");
    if (isTaskUnavailableForContinuation(task.status)) throw new Error("loop_task_is_closed");
    const run = required(latestRun(task.taskId), "loop_run_not_found");
    const allowedSessions = new Set([
      workspaceSessionId(task, "conductor", run),
      ...task.architecture.agentCards.map((card) => workspaceSessionId(task, card.id, run)),
    ]);
    if (!allowedSessions.has(String(sessionId))) throw new Error("loop_permission_session_not_owned_by_task");
    if (usesOpenCodeServer) {
      const targetSessionId = String(sessionId);
      const providerSessionId = latestOpenCodeProviderSessionId({ taskId: task.taskId, workspaceSessionId: targetSessionId });
      if (!providerSessionId) return { ok: false, status: "requested", errorCode: "provider_session_not_bound" };
      const requestId = String(permissionId).replace(/^opencode:/, "");
      const { client } = await attachOpenCodeRunHost({ task, run, leaseId: runtimeHostLeaseId(run) });
      try {
        const accepted = await client.replyPermission({ cwd: task.cwd, requestId, response });
        if (accepted !== true) return { ok: false, status: "requested", errorCode: "permission_reply_rejected" };
        const recorded = providerFacts.recordPermissionSubmitted?.({ taskId: task.taskId, sessionId: targetSessionId, cwd: task.cwd, permissionId: String(permissionId), response });
        return { ok: true, status: recorded?.status ?? "submitted", changed: recorded?.changed !== false };
      } catch (error) {
        const recorded = providerFacts.recordPermissionReplyFailed?.({ taskId: task.taskId, sessionId: targetSessionId, cwd: task.cwd, permissionId: String(permissionId), response });
        return { ok: false, status: recorded?.status ?? "reply_failed", errorCode: error instanceof Error ? error.message : "permission_reply_failed" };
      }
    }
    if (typeof respondToPermission !== "function") {
      return { ok: false, status: "requested", errorCode: "permission_response_unavailable" };
    }
    const targetSessionId = String(sessionId);
    const result = await respondToPermission({ taskId: task.taskId, sessionId: targetSessionId, permissionId: String(permissionId), response });
    if (result?.ok || result?.errorCode !== "permission_reply_transport_unavailable") return result;

    // The reply capability belongs to the OpenCode plugin process and is not
    // persisted across an Electron restart. Keep the user's scoped decision,
    // restore this exact logical Session, then wait for that resumed Provider
    // Session to ask again before a fresh hook transport submits the response.
    const queued = providerFacts.recordPermissionRecoveryPending?.({
      taskId: task.taskId,
      sessionId: targetSessionId,
      cwd: task.cwd,
      permissionId: String(permissionId),
      response,
    });
    if (!queued || queued.status === "missing") return result;
    try {
      const recovery = await recoverPermissionSession({ task, run, sessionId: targetSessionId, permissionId: String(permissionId) });
      return { ok: true, status: "recovery_pending", changed: queued.changed !== false, recovery };
    } catch (error) {
      providerFacts.recordPermissionRecoveryFailed?.({ taskId: task.taskId, sessionId: targetSessionId, cwd: task.cwd, permissionId: String(permissionId) });
      const reason = error instanceof Error ? error.message : "permission_session_recovery_failed";
      recordRunEvent({
        runId: run.runId,
        type: "permission.recovery.failed",
        summary: "授权答复未送达；Runtime 未能恢复请求授权的原生 Session。",
        data: { sessionId: targetSessionId, permissionId: String(permissionId), reason },
      });
      return { ok: true, status: "recovery_failed", changed: true };
    }
  }

  async function respondSessionQuestion({ taskId, sessionId, questionId, answer } = {}) {
    const task = required(taskById(required(taskId, "taskId")), "loop_task_not_found");
    if (isTaskUnavailableForContinuation(task.status)) throw new Error("loop_task_is_closed");
    const run = required(latestRun(task.taskId), "loop_run_not_found");
    const targetSessionId = required(sessionId, "sessionId");
    const targetQuestionId = required(questionId, "questionId");
    const submittedAnswer = required(answer, "question_answer");
    const allowedSessions = new Set([
      workspaceSessionId(task, "conductor", run),
      ...task.architecture.agentCards.map((card) => workspaceSessionId(task, card.id, run)),
    ]);
    if (!allowedSessions.has(String(targetSessionId))) throw new Error("loop_question_session_not_owned_by_task");

    const submissionKey = `${task.taskId}:${targetSessionId}:${targetQuestionId}`;
    const inFlight = questionSubmissionPromises.get(submissionKey);
    if (inFlight) return inFlight;
    const submission = (async () => {
      // The first successful write transitions the sampled Session away from
      // `waiting_input` before OpenCode has rendered its next frame.  Check
      // the durable one-shot receipt first so a renderer retry returns the
      // same accepted outcome instead of treating that valid transition as a
      // new, invalid answer attempt.
      const prior = providerFacts.readQuestionResponse?.({ taskId: task.taskId, sessionId: targetSessionId, cwd: task.cwd, questionId: targetQuestionId });
      if (["submitted", "resolved"].includes(String(prior?.status ?? ""))) {
        return { ok: true, status: String(prior.status), changed: false };
      }
      const state = sessionReadModel.readTaskState({ taskId: task.taskId, sinceCursor: 0 });
      const session = state.sessions?.find((item) => String(item.sessionId ?? "") === String(targetSessionId));
      if (String(session?.state ?? "") !== "waiting_input") {
        return { ok: false, status: String(session?.state ?? "missing"), errorCode: "session_not_waiting_input" };
      }
      if (String(session?.lastStateData?.providerQuestionPartId ?? "") !== String(targetQuestionId)) {
        return { ok: false, status: "waiting_input", errorCode: "provider_question_changed" };
      }
      const terminal = ptyManager.get?.(targetSessionId);
      if (!terminal || String(terminal.status) !== "running" || !terminal.incarnationId) {
        return { ok: false, status: "waiting_input", errorCode: "question_terminal_unavailable" };
      }
      // A logical Session can be recovered into a replacement PTY after an
      // Electron restart. The old Provider question is historical until the
      // observer sees it again in that replacement terminal. Never paste an
      // answer intended for the old modal into the new TUI.
      if (String(session?.lastStateData?.terminalIncarnationId ?? "") !== String(terminal.incarnationId)) {
        return { ok: false, status: "waiting_input", errorCode: "question_terminal_changed" };
      }
      await enqueueConductorInteractiveInput({
        workspaceSessionId: targetSessionId,
        expectedIncarnationId: terminal.incarnationId,
        source: "task_question_answer",
        text: String(submittedAnswer),
        idempotencyKey: `task-question-answer:${task.taskId}:${targetSessionId}:${targetQuestionId}`,
      });
      const recorded = providerFacts.recordQuestionResponseSubmitted?.({
        taskId: task.taskId,
        sessionId: targetSessionId,
        cwd: task.cwd,
        questionId: targetQuestionId,
        answer: String(submittedAnswer),
      });
      recordRunEvent({
        runId: run.runId,
        type: "session.question_answer_submitted",
        summary: "已将任务页回答写入对应的 OpenCode 原生问题。",
        data: { sessionId: targetSessionId, providerQuestionPartId: targetQuestionId, answer: String(submittedAnswer) },
      });
      return { ok: true, status: "submitted", changed: recorded?.changed !== false };
    })();
    questionSubmissionPromises.set(submissionKey, submission);
    try {
      return await submission;
    } finally {
      questionSubmissionPromises.delete(submissionKey);
    }
  }

  async function resumePendingPermissionRecoveries() {
    const candidates = [];
    const taskRows = db.prepare("SELECT task_id FROM agent_loop_tasks WHERE status IN ('running', 'delivery_ready', 'recovery_required') ORDER BY updated_at ASC").all();
    for (const row of taskRows) {
      const task = taskById(row.task_id);
      const run = task ? latestRun(task.taskId) : undefined;
      if (!task || !run || !["running", "recovery_required"].includes(String(run.status))) continue;
      const ownedSessionIds = new Set([
        workspaceSessionId(task, "conductor", run),
        ...task.architecture.agentCards.map((card) => workspaceSessionId(task, card.id, run)),
      ]);
      const permissions = sessionReadModel.readTaskState({ taskId: task.taskId, sinceCursor: 0 }).permissions ?? [];
      // Historical duplicate request ids for one Session are transport facts,
      // not a reason to start multiple replacement TUIs. The first fresh hook
      // request reconciles every same-scope retained answer in Session Store.
      const recoveryBySessionId = new Map();
      for (const permission of permissions) {
        const sessionId = String(permission?.sessionId ?? "");
        if (
          String(permission?.status ?? "") !== "recovery_pending"
          || !ownedSessionIds.has(sessionId)
          || !["once", "always", "reject"].includes(String(permission?.response ?? ""))
          || recoveryBySessionId.has(sessionId)
        ) continue;
        recoveryBySessionId.set(sessionId, permission);
      }
      for (const [sessionId, permission] of recoveryBySessionId) {
        candidates.push({ task, run, sessionId, permissionId: String(permission.permissionId) });
      }
    }

    const recovered = [];
    const failed = [];
    for (const candidate of candidates) {
      // Another startup path may already have activated this Session. A live
      // PTY is the recovery fact; never create a second TUI from a later scan.
      if (["running", "stopping"].includes(String(ptyManager.get?.(candidate.sessionId)?.status ?? ""))) continue;
      try {
        recovered.push(await recoverPermissionSession(candidate));
      } catch (error) {
        failed.push({
          taskId: candidate.task.taskId,
          sessionId: candidate.sessionId,
          permissionId: candidate.permissionId,
          reason: error instanceof Error ? error.message : "permission_session_recovery_failed",
        });
      }
    }
    return { attempted: candidates.length, recovered, failed };
  }

  async function recoverPermissionSession({ task, run, sessionId, permissionId }) {
    const recoveryKey = `${task.taskId}:${sessionId}`;
    const existing = permissionRecoveryPromises.get(recoveryKey);
    if (existing) return existing;
    const recovery = serializeTaskLifecycle(
      task.taskId,
      () => recoverPermissionSessionOnce({ task, run, sessionId, permissionId }),
    )
      .finally(() => permissionRecoveryPromises.delete(recoveryKey));
    permissionRecoveryPromises.set(recoveryKey, recovery);
    return recovery;
  }

  async function recoverPermissionSessionOnce({ task, run, sessionId, permissionId }) {
    const conductorSessionId = workspaceSessionId(task, "conductor", run);
    if (sessionId === conductorSessionId) {
      await recoverRunOnce({ taskId: task.taskId, cause: "permission_response" });
      return { sessionId, role: "conductor" };
    }
    const card = task.architecture.agentCards.find((candidate) => workspaceSessionId(task, candidate.id, run) === sessionId);
    if (!card) throw new Error("loop_permission_session_not_owned_by_task");
    const live = ptyManager.get?.(sessionId);
    if (live?.status === "stopping") {
      if (typeof sessionAuthority.waitForTerminalExit !== "function") throw new Error("permission_terminal_exit_wait_unavailable");
      await sessionAuthority.waitForTerminalExit({
        workspaceSessionId: sessionId,
        expectedIncarnationId: live.incarnationId,
        expectedGeneration: live.generation,
      });
    } else if (live?.status === "running") {
      // A live Session with no remembered hook transport is not safe to answer
      // through a replacement terminal. The native terminal remains the only
      // authoritative way to resolve that exceptional in-process mismatch.
      throw new Error("permission_live_session_transport_lost");
    }
    const providerSessionId = latestOpenCodeProviderSessionId({ taskId: task.taskId, workspaceSessionId: sessionId });
    if (!providerSessionId) throw new Error("permission_provider_session_unknown");
    await registerWorkerProfile({ task, run, card, initialPrompt: "" });
    const activation = await sessionAuthority.activateSession({
      workspaceSessionId: sessionId,
      operationId: `permission-recovery:${run.runId}:${card.id}:${randomUUID()}`,
      callerId: "agent-loop-runtime",
      reason: "permission-response-recovery",
      interactiveTui: true,
    });
    if (!activation?.session || activation.session.status !== "running") throw new Error("permission_session_not_started");
    // If an old cancellation was recorded before this recovery acquired the
    // replacement PTY, settle it now from the predecessor incarnation's
    // durable owner fact. This prevents a recovered Conductor from seeing a
    // stale occupied card, while the Coordinator's exact-incarnation fence
    // guarantees that it cannot interrupt the new permission TUI.
    await reconcilePersistedCancellations({ task, run, cause: "permission_recovery" });
    providerFacts.recordProviderSessionState?.(
      { taskId: task.taskId, sessionId, cwd: task.cwd },
      "permission_required",
      "正在恢复原生 Session，等待 OpenCode 重新发出权限请求。",
      { permissionId, provider: "opencode", providerSessionId, recovery: true },
    );
    recordRunEvent({
      runId: run.runId,
      type: "permission.recovery.started",
      summary: `Runtime 正在续接 ${card.name} 的原生 Session，以重新交付已保留的授权答复。`,
      data: { sessionId, permissionId, providerSessionId },
    });
    recordTaskEvent({
      taskId: task.taskId,
      sessionId,
      cwd: task.cwd,
      type: "permission.recovery.started",
      summary: `正在恢复 ${card.name}；原授权答复将在 OpenCode 重新请求后送达。`,
      data: { runId: run.runId, permissionId },
    });
    return { sessionId, role: card.id, providerSessionId };
  }

  async function flushPendingUserMessages({ taskId, withinTaskLifecycle = false }) {
    const task = taskById(String(taskId));
    if (!task) return { delivered: 0, queued: 0, reason: "loop_task_not_found" };
    const pending = db.prepare("SELECT * FROM agent_loop_user_messages WHERE task_id = ? AND status = 'pending' ORDER BY created_at ASC").all(task.taskId);
    if (!pending.length) return { delivered: 0, queued: 0 };
    const run = latestRun(task.taskId);
    if (!run) return { delivered: 0, queued: pending.length, reason: "task_not_started" };
    const conductorSessionId = workspaceSessionId(task, "conductor", run);
    if (usesOpenCodeServer) {
      const providerSessionId = latestOpenCodeProviderSessionId({ taskId: task.taskId, workspaceSessionId: conductorSessionId });
      if (!providerSessionId) return { delivered: 0, queued: pending.length, reason: "conductor_provider_session_not_bound" };
      const { client, server } = await attachOpenCodeRunHost({ task, run, leaseId: runtimeHostLeaseId(run) });
      const reconciliation = await reconcileOpenCodeRun({ task, run, client, server });
      const conductor = reconciliation.find((entry) => entry.sessionId === conductorSessionId);
      if (conductor?.status !== "available") {
        return { delivered: 0, queued: pending.length, reason: `conductor_provider_session_${conductor?.status ?? "not_bound"}` };
      }
      for (const item of pending) {
        const inputId = userMessageWakeupKey(task.taskId, item.message_id);
        try {
          recordUserMessageWakeup({ task, run, messageId: item.message_id, message: item.message, status: "attempting" });
          // The Server's `/message` endpoint executes the Conductor turn before
          // its HTTP response resolves. The Task input is already durable here,
          // so open its next decision epoch before that turn can call the
          // Conductor bridge. Delivery itself remains pending until the Server
          // returns; this does not claim an unconfirmed message was delivered.
          //
          // `resumeForConductorInput` uses this exact input id as its command
          // idempotency key. A retry after a transport failure therefore keeps
          // one user utterance and one `task.continued` event.
          resumeTaskForConductorInput({ taskId: task.taskId, cause: "user_message", inputId });
          const accepted = await serializeConductorServerMessage(run.runId, () => client.sendMessage({
            cwd: task.cwd,
            providerSessionId,
            text: formatConductorUserInput(item),
            agent: OPEN_CODE_CONDUCTOR_PROVIDER_AGENT,
            model: openCodeServerContinuationModel({
              model: task.architecture.defaultModel,
              modelVariant: task.architecture.defaultModelVariant,
            }),
            system: conductorPrompt(task),
            tools: conductorOpenCodeTools(),
            timeoutMs: 120_000,
          }));
          db.prepare("UPDATE agent_loop_user_messages SET status = 'delivered', run_id = ?, delivered_at = ? WHERE message_id = ?")
            .run(run.runId, now(), item.message_id);
          recordUserMessageWakeup({
            task,
            run,
            messageId: item.message_id,
            message: item.message,
            status: "observed",
            provider: "opencode",
            providerSessionId,
            providerMessageId: accepted?.providerMessageId,
          });
          recordRunEvent({
            runId: run.runId,
            type: "conductor.user_message_wakeup",
            summary: "OpenCode Server 已接受用户后续消息。",
            data: { messageId: item.message_id, inputId, providerSessionId, providerMessageId: accepted?.providerMessageId },
          });
        } catch (error) {
          // Do not call a user follow-up delivered merely because a local
          // lifecycle epoch opened. The message stays pending and its one
          // durable wakeup can be retried by the normal Runtime path.
          recordUserMessageWakeup({ task, run, messageId: item.message_id, message: item.message, status: "queued" });
          throw error;
        }
      }
      return { delivered: pending.length, queued: 0, delivery: "opencode_server_input_accepted" };
    }
    // A previous process may have persisted an input intent, then died while
    // writing its PTY.  The Session Store / Provider observer owns recovery of
    // that exact marker; do not make a second direct write from this helper.
    const durableWakeups = sessionReadModel.readTaskState({ taskId: task.taskId }).wakeups ?? [];
    const observed = pending.filter((item) => {
      const key = userMessageWakeupKey(task.taskId, item.message_id);
      const wakeup = durableWakeups.find((entry) => entry.wakeupKey === key);
      return wakeup?.status === "observed";
    });
    for (const item of observed) {
      const key = userMessageWakeupKey(task.taskId, item.message_id);
      const wakeup = durableWakeups.find((entry) => entry.wakeupKey === key);
      db.prepare("UPDATE agent_loop_user_messages SET status = 'delivered', delivered_at = ? WHERE message_id = ?")
        .run(wakeup?.observedAt ?? now(), item.message_id);
    }
    const awaitingProviderReceipt = pending.filter((item) => !observed.includes(item));
    if (!awaitingProviderReceipt.length) return { delivered: observed.length, queued: 0, delivery: "provider_receipt" };
    const readyToSend = awaitingProviderReceipt.filter((item) => {
      const key = userMessageWakeupKey(task.taskId, item.message_id);
      const wakeup = durableWakeups.find((entry) => entry.wakeupKey === key);
      return !wakeup || wakeup.status === "queued";
    });
    if (!readyToSend.length) {
      return { delivered: observed.length, queued: awaitingProviderReceipt.length, reason: "user_input_receipt_pending" };
    }
    const conductor = ptyManager.get?.(conductorSessionId);
    if (!isLiveConductorTerminal(conductor)) {
      // A user pressing Send is the explicit request to continue this Task.
      // Preserve the message first, then reattach or restart the Host behind
      // that single action. The renderer must never ask the user to perform a
      // second, implementation-specific "recover this Run" interaction.
      try {
        const recover = withinTaskLifecycle ? recoverRunOnce : recoverRun;
        await recover({ taskId: task.taskId, cause: "user_message" });
        return {
          delivered: observed.length,
          queued: awaitingProviderReceipt.length,
          delivery: "conductor_recovery_awaiting_provider_receipt",
        };
      } catch {
        markRunRecoveryRequired({ task, run, reason: "conductor_recovery_start_failed_for_user_message" });
        // The durable message remains pending. A later Send retries the same
        // continuation rather than dropping it or requiring a special UI.
        return { delivered: observed.length, queued: awaitingProviderReceipt.length, reason: "conductor_recovery_retry_pending" };
      }
    }
    await reconcilePersistedCancellations({ task, run, cause: "user_message" });
    const conductorState = sessionReadModel.readSession?.({ taskId: task.taskId, sessionId: conductorSessionId, maxChars: 0 })?.state;
    if (!["ready", "waiting_conductor"].includes(String(conductorState))) {
      return { delivered: 0, queued: pending.length, reason: "conductor_not_ready" };
    }
    const write = enqueueConductorInteractiveInput;
    for (const item of readyToSend) {
      recordUserMessageWakeup({ task, run, messageId: item.message_id, message: item.message, status: "attempting" });
      try {
        await write({
          workspaceSessionId: conductorSessionId,
          expectedIncarnationId: conductor.incarnationId,
          source: "user_message",
          text: formatConductorUserInput(item),
          idempotencyKey: `task-user-message:${item.message_id}`,
        });
      } catch (error) {
        recordUserMessageWakeup({ task, run, messageId: item.message_id, message: item.message, status: "queued" });
        throw error;
      }
      // A PTY write is not a Provider receipt.  Leave the wakeup in
      // `attempting` and the message in `pending`; SessionWakeupMonitor will
      // either observe this exact input ID or put it back in `queued` for a
      // safe idempotent retry.
      recordRunEvent({ runId: run.runId, type: "conductor.user_message_wakeup", summary: "Runtime 已提交用户后续消息；等待 OpenCode 确认该输入。", data: { messageId: item.message_id } });
    }
    return {
      delivered: observed.length,
      queued: awaitingProviderReceipt.length,
      delivery: "conductor_wakeup_awaiting_provider_receipt",
    };
  }

  async function ensureConductorWakeupTarget({ taskId, sessionId } = {}) {
    const task = taskById(String(taskId));
    if (!task || isTaskUnavailableForContinuation(task.status)) return undefined;
    const run = latestRun(task.taskId);
    if (!run || run.status !== "running") return undefined;
    const conductorSessionId = workspaceSessionId(task, "conductor", run);
    if (sessionId && String(sessionId) !== conductorSessionId) return undefined;
    if (usesOpenCodeServer) {
      const providerSessionId = latestOpenCodeProviderSessionId({ taskId: task.taskId, workspaceSessionId: conductorSessionId });
      return providerSessionId ? { id: conductorSessionId, status: "running", providerSessionId, transport: "opencode_server" } : undefined;
    }
    const live = ptyManager.get?.(conductorSessionId);
    if (isLiveConductorTerminal(live)) return live;

    // A Worker result is a durable semantic input for the current Task Run.
    // It must not wait for a later, unrelated user Send merely because the
    // previous Conductor PTY exited.  Recover the same logical Conductor
    // Session here; SessionWakeupMonitor will keep the wakeup queued until the
    // restored OpenCode TUI reaches its owned input boundary.
    const existing = conductorRecoveryPromises.get(task.taskId);
    const recovery = existing ?? recoverRun({
      taskId: task.taskId,
      cause: "worker_result_wakeup",
    }).finally(() => conductorRecoveryPromises.delete(task.taskId));
    if (!existing) conductorRecoveryPromises.set(task.taskId, recovery);
    await recovery;
    const recovered = ptyManager.get?.(conductorSessionId);
    if (!isLiveConductorTerminal(recovered)) return undefined;
    // `startConductor` marks every newly attached terminal as running while
    // it enters the TUI. The recovered transport is now ready to accept the
    // already-durable Worker return. This is only a Terminal fact; the
    // Provider observer will publish its own semantic state independently.
    terminalFacts.recordTerminalState?.(
      { taskId: task.taskId, sessionId: conductorSessionId, cwd: task.cwd },
      "ready",
      "Conductor terminal restored; awaiting the durable Worker result wakeup.",
      { source: "worker_result_wakeup" },
    );
    return recovered;
  }

  function enqueueConductorInteractiveInput(input) {
    if (typeof enqueueConductorInteractiveSubmission === "function") return enqueueConductorInteractiveSubmission(input);
    if (typeof sessionAuthority.enqueueInteractiveSubmission === "function") return sessionAuthority.enqueueInteractiveSubmission(input);
    return (enqueueConductorInput ?? ((request) => sessionAuthority.enqueueInput(request)))({
      ...input,
      payload: formatInteractiveInput(input.text),
    });
  }

  async function recoverRun({ taskId, cause = "runtime" }) {
    const normalizedTaskId = required(taskId, "taskId");
    return serializeTaskLifecycle(normalizedTaskId, () => recoverRunOnce({ taskId: normalizedTaskId, cause }));
  }

  async function recoverRunOnce({ taskId, cause = "runtime" }) {
    const task = required(taskById(taskId), "loop_task_not_found");
    if (isTaskUnavailableForContinuation(task.status)) throw new Error("loop_task_is_closed");
    const run = required(latestRun(task.taskId), "loop_run_not_found");
    const conductorSessionId = workspaceSessionId(task, "conductor", run);
    if (usesOpenCodeServer) {
      const providerSessionId = latestOpenCodeProviderSessionId({ taskId: task.taskId, workspaceSessionId: conductorSessionId });
      if (!providerSessionId) throw new Error("conductor_provider_session_not_bound");
      const { client, server } = await attachOpenCodeRunHost({ task, run, leaseId: runtimeHostLeaseId(run) });
      const reconciliation = await reconcileOpenCodeRun({ task, run, client, server });
      const conductor = reconciliation.find((entry) => entry.sessionId === conductorSessionId);
      if (conductor?.status !== "available") {
        markRunRecoveryRequired({ task, run, reason: `conductor_provider_session_${conductor?.status ?? "not_bound"}` });
        throw new Error(`conductor_provider_session_${conductor?.status ?? "not_bound"}`);
      }
      const pending = db.prepare("SELECT * FROM agent_loop_user_messages WHERE task_id = ? AND status = 'pending' ORDER BY created_at ASC").all(task.taskId);
      if (pending.length) return flushPendingUserMessages({ taskId: task.taskId, withinTaskLifecycle: true });
      return readRun({ runId: run.runId });
    }
    if (isLiveConductorTerminal(ptyManager.get?.(conductorSessionId))) {
      await flushPendingUserMessages({ taskId: task.taskId, withinTaskLifecycle: true });
      return readRun({ runId: run.runId });
    }

    const pending = db.prepare("SELECT * FROM agent_loop_user_messages WHERE task_id = ? AND status = 'pending' ORDER BY created_at ASC").all(task.taskId);
    for (const item of pending) {
      recordUserMessageWakeup({ task, run, messageId: item.message_id, message: item.message, status: "attempting" });
    }
    const stopping = ptyManager.get?.(conductorSessionId);
    if (stopping?.status === "stopping") {
      if (typeof sessionAuthority.waitForTerminalExit !== "function") throw new Error("conductor_terminal_exit_wait_unavailable");
      await sessionAuthority.waitForTerminalExit({
        workspaceSessionId: conductorSessionId,
        expectedIncarnationId: stopping.incarnationId,
        expectedGeneration: stopping.generation,
      });
    }
    await reconcilePersistedCancellations({ task, run, cause: `conductor_recovery:${cause}` });
    try {
      await startConductor({
        task,
        runId: run.runId,
        startupMessages: pending.map((item) => ({
          messageId: item.message_id,
          inputId: userMessageWakeupKey(task.taskId, item.message_id),
          message: item.message,
        })),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      for (const item of pending) {
        recordUserMessageWakeup({ task, run, messageId: item.message_id, message: item.message, status: "queued" });
      }
      recordRunEvent({
        runId: run.runId,
        type: "conductor.recovery.failed",
        summary: `Conductor 续接未启动：${reason}`,
        data: { cause, reason },
      });
      markRunRecoveryRequired({ task, run, reason: `conductor_recovery_start_failed:${reason}` });
      throw error;
    }

    for (const item of pending) {
      // The recovery TUI receives the preserved input through Terminal Runtime,
      // but its success remains unconfirmed until the Provider records the
      // exact marker.
      // Do not turn a start race into a permanent false `sent` state.
      db.prepare("UPDATE agent_loop_user_messages SET run_id = ? WHERE message_id = ?").run(run.runId, item.message_id);
    }
    taskRunService.markRecovered({
      task,
      run,
      conductorSessionId,
      cause,
      pendingMessageIds: pending.map((item) => item.message_id),
    });
    publishPendingTaskEvents();
    return readRun({ runId: run.runId });
  }

  async function reconcilePersistedCancellations({ task, run, cause }) {
    if (typeof reconcileTaskCancellations !== "function") return [];
    try {
      const settled = await reconcileTaskCancellations({ taskId: task.taskId });
      const cancelledDispatches = settled.filter((item) => String(item?.status) === "cancelled");
      if (!cancelledDispatches.length) return settled;
      const data = {
        cause: String(cause ?? "runtime"),
        dispatchIds: cancelledDispatches.map((item) => String(item.dispatchId)),
      };
      recordRunEvent({
        runId: run.runId,
        type: "dispatch.cancellations.reconciled",
        summary: `Runtime 已按持久化终端退出事实结算 ${cancelledDispatches.length} 个已取消派发。`,
        data,
      });
      recordTaskEvent({
        taskId: task.taskId,
        sessionId: workspaceSessionId(task, "conductor", run),
        cwd: task.cwd,
        type: "task.dispatch_cancellations_reconciled",
        summary: `继续当前 Task 前已结算 ${cancelledDispatches.length} 个已取消派发。`,
        data,
      });
      return settled;
    } catch (error) {
      // A reconciliation read failure must not discard the user's message or
      // prevent an otherwise healthy Conductor from continuing. Its durable
      // pending state remains visible and can be retried by the next Send.
      recordRunEvent({
        runId: run.runId,
        type: "dispatch.cancellations.reconcile_failed",
        summary: "Runtime 未能读取持久化取消状态；保留当前 Task 状态并继续处理用户消息。",
        data: { cause: String(cause ?? "runtime"), reason: error instanceof Error ? error.message : String(error) },
      });
      return [];
    }
  }

  function markRunRecoveryRequired({ task, run, reason }) {
    const current = taskRunService.markRecoveryRequired({ task, run, reason });
    publishPendingTaskEvents();
    return current;
  }

  function listConductorWakeupTargets() {
    return listTasks()
      .filter((task) => ["running", "delivery_ready"].includes(task.status) && task.latestRun?.status === "running")
      .map((task) => ({
        taskId: task.taskId,
        sessionId: workspaceSessionId(task, "conductor", task.latestRun),
      }));
  }

  function recordUserMessageWakeup({
    task,
    run,
    messageId,
    wakeupKey,
    message,
    status,
    retryLegacyUnconfirmed = false,
    provider,
    providerSessionId,
    providerMessageId,
  }) {
    const sessionId = workspaceSessionId(task, "conductor", run);
    return coordinatorFacts.recordConductorWakeup({
      taskId: task.taskId,
      sessionId,
      wakeupKey: wakeupKey ?? userMessageWakeupKey(task.taskId, messageId),
      kind: "user_message",
      ...(messageId ? { userMessageId: messageId } : {}),
      messageText: message,
      status,
      retryLegacyUnconfirmed,
      provider,
      providerSessionId,
      providerMessageId,
      reason: "User follow-up requires a new Conductor decision.",
      summary: `Conductor user input ${status}.`,
    });
  }

  function retryableUnconfirmedUserMessage({ task, run, message }) {
    const candidate = db.prepare(
      "SELECT * FROM agent_loop_user_messages WHERE task_id = ? AND message = ? AND status = 'delivered' ORDER BY created_at DESC LIMIT 1",
    ).get(task.taskId, String(message));
    if (!candidate) return undefined;
    const wakeupKey = userMessageWakeupKey(task.taskId, candidate.message_id);
    const wakeup = (sessionReadModel.readTaskState?.({ taskId: task.taskId })?.wakeups ?? [])
      .find((entry) => entry.wakeupKey === wakeupKey);
    // `sent` without a receipt is the exact legacy false-success state. The
    // current code never writes this state for user messages.
    if (wakeup?.status !== "sent" || wakeup.providerMessageId || wakeup.observedAt) return undefined;
    if (String(wakeup.sessionId ?? "") !== workspaceSessionId(task, "conductor", run)) return undefined;
    return candidate;
  }

  async function markTaskAchieved({ taskId, commandId, expectedRevision } = {}) {
    const normalizedTaskId = required(taskId, "taskId");
    return serializeTaskLifecycle(normalizedTaskId, () => markTaskAchievedOnce({
      taskId: normalizedTaskId,
      commandId: String(commandId || `command:achieve:${randomUUID()}`),
      expectedRevision,
    }));
  }

  async function markTaskAchievedOnce({ taskId, commandId, expectedRevision }) {
    const task = required(taskById(taskId), "loop_task_not_found");
    if (task.status !== TASK_STATUS.ACHIEVED) {
      taskRunService.achieve({ taskId: task.taskId, commandId, expectedRevision });
      publishPendingTaskEvents();
    }
    const achievedTask = required(taskById(task.taskId), "loop_task_not_found");
    // The lifecycle commit is the authoritative close fence.  Revoke every
    // currently presented page after that fence exists so a composer racing
    // this command is rejected by its preflight even if gateway cleanup is
    // delayed.  Presentation cleanup is deliberately best effort: a gateway
    // transport failure must not roll back a user-accepted delivery.
    // A delayed replay of an earlier Achieve command is valid idempotency, but
    // it must not close a fresh page issued after the same Task was explicitly
    // resumed.  The durable Task state after the command is therefore the
    // single cleanup fence, rather than the state observed before replay.
    if (achievedTask.status === TASK_STATUS.ACHIEVED) {
      await releaseTaskPresentationPages({ taskId: achievedTask.taskId, tolerateFailures: true });
      const run = latestRun(achievedTask.taskId);
      if (run && usesOpenCodeServer) {
        await releaseInactiveOpenCodeRunHost({ task: achievedTask, run, tolerateFailures: true });
      }
    }
    return achievedTask;
  }

  /**
   * The only supported path from achieved back to running.  This is not a
   * generic continuation: it first asks the Provider for the persisted,
   * exact Conductor Session id, then atomically flips the original Task/Run.
   * A missing Session remains historical and never causes a new identity.
   */
  async function resumeAchievedTask({ taskId, commandId, expectedRevision } = {}) {
    const normalizedTaskId = required(taskId, "taskId");
    const normalizedCommandId = required(commandId, "commandId");
    const normalizedExpectedRevision = requiredExpectedRevision(expectedRevision);
    return serializeTaskLifecycle(normalizedTaskId, () => resumeAchievedTaskOnce({
      taskId: normalizedTaskId,
      commandId: normalizedCommandId,
      expectedRevision: normalizedExpectedRevision,
    }));
  }

  async function resumeAchievedTaskOnce({ taskId, commandId, expectedRevision }) {
    const priorCommand = taskRunRepository.commandById(commandId);
    if (priorCommand) {
      if (priorCommand.taskId !== taskId || priorCommand.kind !== "task.resume_achieved") {
        throw new Error("loop_command_id_conflict");
      }
      if (priorCommand.status !== "committed") throw new Error("loop_command_in_progress");
      return readRun({ runId: required(priorCommand.result?.runId, "loop_run_not_found") });
    }
    const task = required(taskById(taskId), "loop_task_not_found");
    // Reject a stale UI command before acquiring even a shared Host lease. The
    // service checks this same revision again inside its commit transaction,
    // so this is an early performance fence rather than the lifecycle guard.
    if (Number(task.revision) !== expectedRevision) throw new Error("loop_task_revision_conflict");
    if (task.status !== TASK_STATUS.ACHIEVED) throw new Error("loop_task_not_achieved");
    const run = required(latestRun(task.taskId), "loop_run_not_found");
    if (String(run.status) !== "achieved") throw new Error("loop_achieved_run_not_resumable");
    if (!usesOpenCodeServer) throw new Error("opencode_server_required");

    const conductorSessionId = workspaceSessionId(task, "conductor", run);
    if (String(run.conductorSessionId ?? "") !== conductorSessionId) {
      throw new Error("loop_achieved_conductor_session_mismatch");
    }
    const providerSessionId = latestOpenCodeProviderSessionId({
      taskId: task.taskId,
      workspaceSessionId: conductorSessionId,
    });
    if (!providerSessionId) throw new Error("loop_achieved_conductor_session_not_bound");

    // This is a bounded, exact lookup: do not reconcile the rest of the Run,
    // search by title, or call createSession.  Attaching a shared cwd Host is
    // transport setup only; the persisted providerSessionId remains the sole
    // identity accepted for this resume.
    let attached;
    try {
      attached = await attachOpenCodeRunHost({ task, run, leaseId: runtimeHostLeaseId(run) });
    } catch (error) {
      // Acquiring the shared Host is transport setup, not a Provider fact.  A
      // cold Host or bridge failure must not be reported as a missing original
      // Session, nor overwrite the retained Provider binding with `blocked`.
      await releaseInactiveOpenCodeRunHost({ task, run, tolerateFailures: true });
      throw new Error("loop_achieved_conductor_host_unavailable", { cause: error });
    }

    let conductor;
    try {
      const { client, server } = attached;
      const [reconciled] = await reconcileOpenCodeSessionBindings({
        client,
        cwd: task.cwd,
        bindings: [{ sessionId: conductorSessionId, providerSessionId }],
      });
      conductor = reconciled;
      if (conductor?.status === "available") {
        recordOpenCodeProviderSession({
          task,
          runId: run.runId,
          sessionId: conductorSessionId,
          providerSessionId,
          summary: "已验证已完成 Task 的原 Conductor Provider Session 可继续。",
          state: "ready",
        });
      } else if (conductor?.status === "missing") {
        recordOpenCodeProviderSession({
          task,
          runId: run.runId,
          sessionId: conductorSessionId,
          providerSessionId,
          summary: "无法验证已完成 Task 的原 Conductor Provider Session；不会创建替代 Session。",
          state: "blocked",
        });
      }
      recordOpenCodeHostBinding({ task, run, server, reconciledAt: now() });
    } catch (error) {
      // Keep Task/Run achieved.  A failed precondition must not record a
      // lifecycle command that could later be mistaken for a successful
      // resume, nor may it create a new Task, Run, or Provider Session.
      await releaseInactiveOpenCodeRunHost({ task, run, tolerateFailures: true });
      throw new Error("loop_achieved_conductor_session_unavailable", { cause: error });
    }
    if (conductor?.status === "missing") {
      await releaseInactiveOpenCodeRunHost({ task, run, tolerateFailures: true });
      throw new Error("loop_achieved_conductor_session_missing");
    }
    if (conductor?.status !== "available") {
      await releaseInactiveOpenCodeRunHost({ task, run, tolerateFailures: true });
      throw new Error("loop_achieved_conductor_session_unavailable");
    }

    try {
      taskRunService.resumeAchieved({
        taskId: task.taskId,
        commandId,
        expectedRevision,
        runId: run.runId,
        conductorSessionId,
        providerSessionId,
      });
    } catch (error) {
      await releaseInactiveOpenCodeRunHost({ task, run, tolerateFailures: true });
      throw error;
    }
    publishPendingTaskEvents();
    return readRun({ runId: run.runId });
  }

  async function stopTask({ taskId, commandId, expectedRevision } = {}) {
    const normalizedTaskId = required(taskId, "taskId");
    const preparedCommand = taskRunRepository.findPreparedCommand({ taskId: normalizedTaskId, kind: "task.stop" });
    return serializeTaskLifecycle(normalizedTaskId, () => stopTaskOnce({
      taskId: normalizedTaskId,
      commandId: preparedCommand?.commandId || String(commandId || `command:stop:${randomUUID()}`),
      expectedRevision,
    }));
  }

  async function stopTaskOnce({ taskId, commandId, expectedRevision }) {
    const task = required(taskById(taskId), "loop_task_not_found");
    if (task.status === TASK_STATUS.STOPPED) return task;
    const prepared = taskRunService.prepareStop({ taskId: task.taskId, commandId, expectedRevision });
    const run = required(runById(prepared.result?.runId), "loop_run_not_found");
    const stoppingTask = required(taskById(task.taskId), "loop_task_not_found");
    await stopRunSessions({ task: stoppingTask, run, abortProviderSessions: true });
    taskRunService.completeStop({ commandId, task: stoppingTask, run });
    publishPendingTaskEvents();
    return taskById(task.taskId);
  }

  async function moveTaskToRecycleBin({ taskId, commandId, expectedRevision } = {}) {
    const normalizedTaskId = required(taskId, "taskId");
    const normalizedCommandId = required(commandId, "commandId");
    const normalizedExpectedRevision = requiredExpectedRevision(expectedRevision);
    return serializeTaskLifecycle(normalizedTaskId, async () => {
      const task = required(taskById(normalizedTaskId), "loop_task_not_found");
      taskRunService.moveToRecycleBin({
        taskId: task.taskId,
        commandId: normalizedCommandId,
        expectedRevision: normalizedExpectedRevision,
      });
      publishPendingTaskEvents();
      // A recycle operation keeps the Session binding, not a live Host lease.
      // Releasing a shared Host owner is only a resource optimization; a
      // failure cannot turn a completed recycle command into a half-delete.
      const run = latestRun(task.taskId);
      if (usesOpenCodeServer && run) {
        try { await stopRunSessions({ task, run }); } catch { /* retry-free lease cleanup */ }
      }
      return required(taskById(task.taskId), "loop_task_not_found");
    });
  }

  async function restoreTaskFromRecycleBin({ taskId, commandId, expectedRevision } = {}) {
    const normalizedTaskId = required(taskId, "taskId");
    const normalizedCommandId = required(commandId, "commandId");
    const normalizedExpectedRevision = requiredExpectedRevision(expectedRevision);
    return serializeTaskLifecycle(normalizedTaskId, () => {
      const task = required(taskById(normalizedTaskId), "loop_task_not_found");
      taskRunService.restoreFromRecycleBin({
        taskId: task.taskId,
        commandId: normalizedCommandId,
        expectedRevision: normalizedExpectedRevision,
      });
      publishPendingTaskEvents();
      return required(taskById(task.taskId), "loop_task_not_found");
    });
  }

  function previewTaskPermanentDeletion({ taskId } = {}) {
    const task = required(taskById(required(taskId, "taskId")), "loop_task_not_found");
    if (task.status !== TASK_STATUS.ARCHIVED) throw new Error("loop_task_not_in_recycle_bin");
    return {
      taskId: task.taskId,
      projectCwd: task.cwd,
      managedArtifacts: inspectManagedArtifacts(task),
    };
  }

  async function permanentlyDeleteTask({ taskId, commandId, expectedRevision, artifactPaths = [] } = {}) {
    const normalizedTaskId = required(taskId, "taskId");
    const normalizedCommandId = required(commandId, "commandId");
    const tombstone = taskRunRepository.deletionTombstoneByCommandId(normalizedCommandId);
    if (tombstone) {
      if (tombstone.taskId !== normalizedTaskId) throw new Error("loop_command_id_conflict");
      return tombstone.result;
    }
    const prepared = findPreparedPermanentDelete(normalizedTaskId);
    if (prepared && prepared.commandId !== normalizedCommandId) throw new Error("loop_task_lifecycle_operation_in_progress");
    // A prepared delete is a durable intent. Startup reconciliation has only
    // the command id, so it must reuse the original selected artifact paths
    // and Runtime-captured file identities rather than take a new selection.
    const preparedArtifactPaths = prepared
      ? managedArtifactSelectionFromPreparedCommand(prepared).artifactPaths
      : artifactPaths;
    const normalizedExpectedRevision = prepared ? expectedRevision : requiredExpectedRevision(expectedRevision);
    return serializeTaskLifecycle(normalizedTaskId, () => permanentlyDeleteTaskOnce({
      taskId: normalizedTaskId,
      commandId: prepared?.commandId || normalizedCommandId,
      expectedRevision: normalizedExpectedRevision,
      artifactPaths: preparedArtifactPaths,
    }));
  }

  async function permanentlyDeleteTaskOnce({ taskId, commandId, expectedRevision, artifactPaths }) {
    const tombstone = taskRunRepository.deletionTombstoneByCommandId(commandId);
    if (tombstone) {
      if (tombstone.taskId !== taskId) throw new Error("loop_command_id_conflict");
      return tombstone.result;
    }
    const task = required(taskById(taskId), "loop_task_not_found");
    // Re-check inside the per-Task queue. Two callers can both observe no
    // prepared command before either reaches the queue; only the first may
    // preflight and prepare the durable deletion intent.
    const activePrepared = findPreparedPermanentDelete(taskId);
    if (activePrepared && activePrepared.commandId !== commandId) {
      throw new Error("loop_task_lifecycle_operation_in_progress");
    }
    const existing = taskRunRepository.commandById(commandId);
    const hasPreparedDelete = isPreparedPermanentDeleteCommand(existing);
    let preparedCommand = existing;
    if (!hasPreparedDelete) {
      // The Renderer supplies only selected registered paths. Runtime owns
      // the filesystem preflight and captures the identity that is allowed to
      // be removed. Once the command is prepared, every retry uses this
      // durable snapshot rather than re-authorizing the current path.
      const selection = preflightManagedArtifactSelection(task, artifactPaths);
      taskRunService.preparePermanentDelete({
        taskId: task.taskId,
        commandId,
        expectedRevision,
        artifactPaths: selection.artifactPaths,
        artifactSnapshots: selection.artifactSnapshots,
      });
      preparedCommand = required(taskRunRepository.commandById(commandId), "loop_command_not_found");
    }
    const artifactSelection = managedArtifactSelectionFromPreparedCommand(preparedCommand);
    const deletingTask = required(taskById(task.taskId), "loop_task_not_found");
    closingTaskIds.add(deletingTask.taskId);
    const runs = (preparedCommand.result?.runIds ?? []).map((runId) => runById(runId)).filter(Boolean);
    // Revoke every direct WebUI capability first.  The real shared Server
    // manager also revokes its owner gateway routes in stopRun, covering
    // routes created before an Electron restart and therefore not in memory.
    await releaseTaskPresentationPages({ taskId: deletingTask.taskId });
    for (const run of runs) await stopRunSessions({ task: deletingTask, run });
    // Terminal ownership is private to the authority. It is released only
    // after the terminal/Server transport fact, before Runtime data removal.
    await sessionAuthority?.releaseTask?.({ taskId: deletingTask.taskId });
    const artifactCleanup = removeManagedArtifacts({
      task: deletingTask,
      ...artifactSelection,
    });
    // Delete the replay-safe Runtime directory before committing the database
    // tombstone. If this side effect fails, the durable command remains
    // prepared and startup reconciliation retries it. The project cwd itself
    // is never passed to a recursive deletion API.
    const storeResult = taskTimeline.deleteTask?.({
      taskId: deletingTask.taskId,
      cwd: deletingTask.cwd,
      notify: false,
    }) ?? { runtimeDirectoryRemoved: false };
    const completed = taskRunService.completePermanentDelete({
      commandId,
      cleanup: {
        runtimeDirectoryRemoved: Boolean(storeResult.runtimeDirectoryRemoved),
        managedArtifactsDeleted: artifactCleanup.deleted,
        managedArtifactsSkipped: artifactCleanup.skipped,
      },
    });
    forgetTaskRuntimeReferences({ taskId: deletingTask.taskId, runs });
    return {
      deleted: true,
      taskId: deletingTask.taskId,
      runsDeleted: Number(completed.result?.runsDeleted ?? runs.length),
      runtimeDirectoryRemoved: Boolean(completed.result?.runtimeDirectoryRemoved),
      managedArtifactsDeleted: completed.result?.managedArtifactsDeleted ?? [],
      managedArtifactsSkipped: completed.result?.managedArtifactsSkipped ?? [],
    };
  }

  // Kept as a compatibility alias for a stale renderer/bridge. Its service
  // guard still enforces that permanent deletion can only begin in Recycle
  // Bin, never from the normal Task list.
  async function deleteTask(input = {}) {
    return permanentlyDeleteTask(input);
  }

  async function reconcilePreparedLifecycleCommands() {
    const commands = taskRunRepository.listPreparedCommands({
      kinds: ["task.start_run", "task.stop", "task.permanently_delete", "task.delete"],
    });
    const results = [];
    for (const command of commands) {
      try {
        if (command.kind === "task.start_run") {
          await startRun({ taskId: command.taskId, commandId: command.commandId });
        } else if (command.kind === "task.stop") {
          await stopTask({ taskId: command.taskId, commandId: command.commandId });
        } else if (["task.permanently_delete", "task.delete"].includes(command.kind)) {
          await permanentlyDeleteTask({ taskId: command.taskId, commandId: command.commandId });
        }
        results.push({ commandId: command.commandId, taskId: command.taskId, kind: command.kind, status: "committed" });
      } catch (error) {
        // Stop/Delete remain prepared when their native side effect fails and
        // are therefore safe to retry at the next startup. Start owns an
        // explicit failure compensation path and may become `failed`.
        results.push({
          commandId: command.commandId,
          taskId: command.taskId,
          kind: command.kind,
          status: taskRunRepository.commandById(command.commandId)?.status ?? "failed",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    publishPendingTaskEvents();
    return { attempted: commands.length, results };
  }

  function listTasks({ scope = "normal" } = {}) {
    const normalizedScope = String(scope || "normal");
    if (!["normal", "trash", "all"].includes(normalizedScope)) throw new Error("loop_task_list_scope_invalid");
    const tasks = taskRunRepository.listTasks();
    const visible = normalizedScope === "trash"
      ? tasks.filter((task) => [TASK_STATUS.ARCHIVED, TASK_STATUS.DELETING].includes(task.status))
      : normalizedScope === "normal"
        ? tasks.filter((task) => ![TASK_STATUS.ARCHIVED, TASK_STATUS.DELETING].includes(task.status))
        : tasks;
    return visible.map((task) => ({ ...task, latestRun: latestRun(task.taskId) }));
  }

  function readTask({ taskId }) {
    const task = taskById(required(taskId, "taskId"));
    return task ? { ...task, latestRun: latestRun(task.taskId) } : undefined;
  }

  function hasTask(taskId) {
    return Boolean(taskById(String(taskId)));
  }

  function readRun({ runId }) {
    const run = runById(required(runId, "runId"));
    if (!run) return undefined;
    const task = taskById(run.taskId);
    const allSessionState = sessionReadModel.readTaskState({ taskId: task.taskId, sinceCursor: 0 }) ?? { sessions: [], dispatches: [], results: [], pendingDecisions: [], messages: [] };
    const cards = [
      {
        id: "conductor",
        name: task.architecture.template.conductor.role,
        role: "Conductor",
        model: task.architecture.defaultModel,
        ...(optionalModelVariant(task.architecture.defaultModelVariant)
          ? { modelVariant: optionalModelVariant(task.architecture.defaultModelVariant) }
          : {}),
        mcp: ["agent_workspace_conductor"],
        skills: [],
        kind: "conductor",
      },
      ...task.architecture.agentCards,
    ];
    const sessionEntries = cards.map((card) => {
      const sessionId = workspaceSessionId(task, card.id, run);
      const terminal = usesOpenCodeServer ? undefined : ptyManager.read(sessionId, 0);
      const sessionView = sessionReadModel.readSession?.({ taskId: task.taskId, sessionId, maxChars: 0 });
      return { card, sessionId, terminal, sessionView };
    });
    const conductorSessionId = workspaceSessionId(task, "conductor", run);
    const conductorTerminal = usesOpenCodeServer ? undefined : (ptyManager.get?.(conductorSessionId) ?? ptyManager.read(conductorSessionId, 0));
    const readModel = projectTaskRunReadModel({
      task,
      run,
      allSessionState,
      sessionEntries,
      artifacts: listArtifacts(task),
      events: listRunEvents(run.runId),
      continuity: projectConductorContinuity({ runStatus: run.status, terminal: conductorTerminal }),
    });
    return {
      ...readModel,
      workbenchLayout: projectWorkbenchLayout({
        runId: run.runId,
        knownSessionIds: readModel.turns.map((turn) => turn.sessionId),
      }),
    };
  }

  function readWorkbenchLayout({ runId }) {
    const run = required(runById(required(runId, "runId")), "loop_run_not_found");
    const detail = readRun({ runId: run.runId });
    return detail.workbenchLayout;
  }

  function saveWorkbenchLayout({ runId, layout }) {
    const run = required(runById(required(runId, "runId")), "loop_run_not_found");
    const detail = readRun({ runId: run.runId });
    return writeWorkbenchLayout({ runId: run.runId, knownSessionIds: detail.turns.map((turn) => turn.sessionId), layout });
  }

  function readArtifact({ runId, artifactPath }) {
    const run = required(runById(required(runId, "runId")), "loop_run_not_found");
    const task = required(taskById(run.taskId), "loop_task_not_found");
    const relativePath = normalizeArtifactPath(artifactPath);
    const absolutePath = path.resolve(task.cwd, relativePath);
    const root = `${path.resolve(task.cwd)}${path.sep}`;
    if (!absolutePath.startsWith(root)) throw new Error("loop_artifact_outside_task_cwd");
    if (!fs.existsSync(absolutePath)) return { path: relativePath, exists: false, contentType: "missing" };
    const stats = fs.statSync(absolutePath);
    if (!stats.isFile()) throw new Error("loop_artifact_not_a_file");
    if (stats.size > 1_500_000) throw new Error("loop_artifact_too_large_for_preview");
    const extension = path.extname(relativePath).toLowerCase();
    const contentType = extension === ".md" || extension === ".markdown" ? "markdown" : extension === ".html" || extension === ".htm" ? "html" : "text";
    return { path: relativePath, absolutePath, exists: true, size: stats.size, contentType, content: fs.readFileSync(absolutePath, "utf8") };
  }

  /**
   * A Session page is a Provider-owned presentation capability. The Task/Run
   * service validates the logical Session binding; the resolver owns the
   * version-pinned OpenCode Web UI route and Host health check.
   */
  async function openOpenCodeSessionPage({ runId, sessionId }) {
    const initialRun = required(runById(required(runId, "runId")), "loop_run_not_found");
    // Opening an official page and lifecycle transitions share one Task-owned
    // serialization lane.  Without this, an open that started just before
    // Achieve could register a new gateway lease after Achieve had already
    // enumerated leases to revoke.
    return serializeTaskLifecycle(initialRun.taskId, () => openOpenCodeSessionPageOnce({
      runId: initialRun.runId,
      sessionId,
    }));
  }

  async function openOpenCodeSessionPageOnce({ runId, sessionId }) {
    const run = required(runById(required(runId, "runId")), "loop_run_not_found");
    const task = required(taskById(run.taskId), "loop_task_not_found");
    // An official page is an interactive presentation capability, not a
    // historical transcript viewer.  Achieved, archived, stopped, and closing
    // Tasks keep their exact Provider binding for inspection/recovery but must
    // not mint another writable page lease.
    if (!isTaskRunPresentationInteractive({ task, run })) {
      return { presentation: "unavailable", reason: "task_session_not_interactive" };
    }
    const logicalSessionId = required(sessionId, "sessionId");
    const validSessionIds = new Set([
      workspaceSessionId(task, "conductor", run),
      ...task.architecture.agentCards.map((card) => workspaceSessionId(task, card.id, run)),
    ]);
    if (!validSessionIds.has(logicalSessionId)) {
      return { presentation: "unavailable", reason: "session_not_in_task_run" };
    }
    const providerSessionId = latestOpenCodeProviderSessionId({ taskId: task.taskId, workspaceSessionId: logicalSessionId });
    if (!providerSessionId) {
      return { presentation: "unavailable", reason: "provider_session_not_bound" };
    }
    if (typeof resolveOpenCodeSessionPage !== "function") {
      return { presentation: "unavailable", providerSessionId, reason: "opencode_server_page_resolver_unavailable" };
    }
    const leaseId = `presentation:${randomUUID()}`;
    try {
      const { client, server } = await attachOpenCodeRunHost({ task, run, leaseId });
      const reconciliation = await reconcileOpenCodeRun({ task, run, client, server });
      const target = reconciliation.find((entry) => entry.sessionId === logicalSessionId);
      if (target?.status !== "available") {
        await releaseOpenCodeSessionPage({ runId: run.runId, sessionId: logicalSessionId, leaseId });
        return { presentation: "unavailable", providerSessionId, reason: target?.status === "missing" ? "provider_session_missing" : "provider_session_reconcile_unavailable" };
      }
      const page = await resolveOpenCodeSessionPage({
        taskId: task.taskId,
        runId: run.runId,
        sessionId: logicalSessionId,
        providerSessionId,
        cwd: task.cwd,
        presentationLeaseId: leaseId,
        ...(logicalSessionId === workspaceSessionId(task, "conductor", run)
          ? {
              beforeProviderUserMessage: ({ providerSessionId: incomingProviderSessionId, inputId, text } = {}) =>
                observeProviderUserInputBeforeExecution({
                  taskId: task.taskId,
                  runId: run.runId,
                  sessionId: logicalSessionId,
                  providerSessionId: incomingProviderSessionId,
                  inputId,
                  text,
                }),
            }
          : {}),
      });
      if (page?.presentation === "direct_url" && page.url) {
        presentationLeases.set(leaseId, {
          taskId: task.taskId,
          runId: run.runId,
          sessionId: logicalSessionId,
        });
        return { ...page, presentationLeaseId: leaseId };
      }
      await releaseOpenCodeSessionPage({ runId: run.runId, sessionId: logicalSessionId, leaseId });
      return page;
    } catch {
      await releaseOpenCodeSessionPage({ runId: run.runId, sessionId: logicalSessionId, leaseId });
      return { presentation: "unavailable", providerSessionId, reason: "provider_session_reconcile_unavailable" };
    }
  }

  function isTaskRunPresentationInteractive({ task, run }) {
    return Boolean(
      task
      && run
      && [TASK_STATUS.RUNNING, TASK_STATUS.DELIVERY_READY].includes(task.status)
      && run.status === RUN_STATUS.RUNNING,
    );
  }

  async function releaseOpenCodeSessionPage({ runId, sessionId, leaseId }) {
    const normalizedRunId = required(runId, "runId");
    const normalizedLeaseId = required(leaseId, "leaseId");
    const run = runById(normalizedRunId);
    // A browser can finish unmounting after permanent deletion. Its stale
    // release request must be harmless; it must never recreate Task state.
    if (!run) {
      presentationLeases.delete(normalizedLeaseId);
      return false;
    }
    const task = taskById(run.taskId);
    if (!task) {
      presentationLeases.delete(normalizedLeaseId);
      return false;
    }
    const logicalSessionId = required(sessionId, "sessionId");
    const validSessionIds = new Set([
      workspaceSessionId(task, "conductor", run),
      ...task.architecture.agentCards.map((card) => workspaceSessionId(task, card.id, run)),
    ]);
    if (!validSessionIds.has(logicalSessionId)) throw new Error("session_not_in_task_run");
    // The presentation resolver owns the official-WebUI gateway registration.
    // Release it before the Host lease so a stale browser page can no longer
    // forward an unchecked user turn into a Run that is being detached.
    let released = false;
    try {
      if (typeof releaseOpenCodeSessionPageResolver === "function") {
        await releaseOpenCodeSessionPageResolver({
          taskId: task.taskId,
          runId: run.runId,
          sessionId: logicalSessionId,
          leaseId: normalizedLeaseId,
        });
      }
    } finally {
      presentationLeases.delete(normalizedLeaseId);
      // Even a gateway-cleanup failure must not retain the Server Host lease.
      // The resolver error still reaches the caller after this release attempt.
      if (typeof openCodeServerManager.releaseRun === "function") {
        released = await openCodeServerManager.releaseRun({ taskId: task.taskId, runId: run.runId, leaseId: normalizedLeaseId });
      }
    }
    return released;
  }

  function projectWorkbenchLayout({ runId, knownSessionIds }) {
    const row = db.prepare("SELECT layout_json FROM agent_loop_workbench_layouts WHERE run_id = ?").get(runId);
    let parsed;
    try {
      parsed = row?.layout_json ? JSON.parse(row.layout_json) : undefined;
    } catch {
      parsed = undefined;
    }
    const normalized = normalizeWorkbenchLayout(parsed, knownSessionIds);
    return normalized;
  }

  function writeWorkbenchLayout({ runId, knownSessionIds, layout }) {
    const normalized = normalizeWorkbenchLayout(layout, knownSessionIds);
    const timestamp = now();
    db.prepare(
      `INSERT INTO agent_loop_workbench_layouts (run_id, layout_json, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(run_id) DO UPDATE SET layout_json = excluded.layout_json, updated_at = excluded.updated_at`,
    ).run(runId, JSON.stringify(normalized), timestamp);
    return normalized;
  }

  function taskById(taskId) {
    return taskRunRepository.taskById(taskId);
  }

  function latestRun(taskId) {
    return taskRunRepository.latestRun(taskId);
  }

  function runById(runId) {
    return taskRunRepository.runById(runId);
  }

  function recordRunEvent({ runId, type, summary, data }) {
    return taskRunRepository.appendRunEvent({ runId, type, summary, data });
  }

  function listRunEvents(runId) {
    return taskRunRepository.listRunEvents(runId);
  }

  function recordTaskEvent(input) {
    // A terminal/provider callback may finish after permanent deletion began.
    // Do not let its derived Timeline projection recreate a just-removed Task
    // root or publish an orphaned event after the durable Task is gone.
    if (isTaskClosing(input?.taskId)) return undefined;
    const outbox = taskRunRepository.enqueueTaskEvent(input);
    const published = publishPendingTaskEvents();
    return published.find((item) => item.outbox.outboxId === outbox.outboxId)?.event ?? outbox;
  }

  function publishPendingTaskEvents() {
    try {
      return taskRunRepository.flushTaskEventOutbox((event) => taskTimeline.recordTaskEvent(event));
    } catch {
      // The Task/Run mutation is already committed with its durable outbox.
      // A later command or Runtime restart retries publication by sourceEventId.
      return [];
    }
  }

  function findPreparedPermanentDelete(taskId) {
    return taskRunRepository.findPreparedCommand({ taskId, kind: "task.permanently_delete" })
      ?? taskRunRepository.findPreparedCommand({ taskId, kind: "task.delete" });
  }

  function inspectManagedArtifacts(task) {
    return taskRunRepository.listManagedArtifacts(task.taskId).map((artifact) => {
      const absolutePath = managedArtifactAbsolutePath(task, artifact.path);
      try {
        const stats = fs.lstatSync(absolutePath);
        const deletable = stats.isFile() || stats.isSymbolicLink();
        return {
          path: artifact.path,
          source: artifact.source,
          exists: true,
          size: stats.isFile() ? stats.size : undefined,
          deletable,
        };
      } catch (error) {
        if (error?.code === "ENOENT") {
          return { path: artifact.path, source: artifact.source, exists: false, deletable: false };
        }
        throw error;
      }
    });
  }

  function preflightManagedArtifactSelection(task, artifactPaths) {
    if (!Array.isArray(artifactPaths)) throw new Error("loop_managed_artifact_paths_invalid");
    const registered = new Map(taskRunRepository.listManagedArtifacts(task.taskId).map((artifact) => [artifact.path, artifact]));
    const selectedPaths = uniqueManagedArtifactPaths(artifactPaths);
    const artifactSnapshots = [];
    for (const artifactPath of selectedPaths) {
      if (!registered.has(artifactPath)) throw new Error("loop_managed_artifact_not_registered");
      const absolutePath = managedArtifactAbsolutePath(task, artifactPath);
      try {
        const stats = fs.lstatSync(absolutePath);
        const kind = managedArtifactKind(stats);
        if (!kind) throw new Error("loop_managed_artifact_not_a_file");
        artifactSnapshots.push(managedArtifactSnapshot({ artifactPath, stats, kind }));
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
        // A missing registered artifact is not silently authorized by a later
        // retry. Its recorded absence means a newly-created path will be
        // treated as changed since confirmation instead of being removed.
        artifactSnapshots.push({ path: artifactPath, state: "missing" });
      }
    }
    return { artifactPaths: selectedPaths, artifactSnapshots };
  }

  function removeManagedArtifacts({ task, artifactPaths, artifactSnapshots }) {
    const deleted = [];
    const skipped = [];
    const selectedPaths = uniqueManagedArtifactPaths(artifactPaths ?? []);
    const registeredPaths = new Set(taskRunRepository.listManagedArtifacts(task.taskId).map((artifact) => artifact.path));
    const snapshotsByPath = managedArtifactSnapshotsByPath(artifactSnapshots, selectedPaths);
    for (const artifactPath of selectedPaths) {
      if (!registeredPaths.has(artifactPath)) {
        skipped.push({ path: artifactPath, reason: "not_registered" });
        continue;
      }
      const snapshot = snapshotsByPath.get(artifactPath);
      // Older prepared commands have paths but no Runtime-owned identity.
      // They cannot authorize deletion after a restart, even when the path
      // happens to exist again.
      if (!snapshot) {
        skipped.push({ path: artifactPath, reason: "changed_since_confirmation" });
        continue;
      }
      const absolutePath = managedArtifactAbsolutePath(task, artifactPath);
      try {
        const stats = fs.lstatSync(absolutePath);
        // `unlink` on a symlink removes the link itself. Never follow it, and
        // never recursively delete a directory. A file replacement also must
        // not be removed merely because it reused the same registered path.
        if (!managedArtifactSnapshotMatches(stats, snapshot)) {
          skipped.push({ path: artifactPath, reason: "changed_since_confirmation" });
          continue;
        }
        fs.unlinkSync(absolutePath);
        deleted.push(artifactPath);
      } catch (error) {
        if (error?.code === "ENOENT") {
          skipped.push({ path: artifactPath, reason: "missing" });
          continue;
        }
        throw error;
      }
    }
    return { deleted, skipped };
  }

  function isPreparedPermanentDeleteCommand(command) {
    return command?.status === "prepared" && ["task.permanently_delete", "task.delete"].includes(command.kind);
  }

  function managedArtifactSelectionFromPreparedCommand(command) {
    const artifactPaths = Array.isArray(command?.payload?.artifactPaths)
      ? command.payload.artifactPaths
      : command?.result?.artifactPaths;
    return {
      artifactPaths: uniqueManagedArtifactPaths(artifactPaths ?? []),
      // Only a Runtime preflight is allowed to populate these snapshots. An
      // old command has no compatible snapshot and removal will skip it.
      artifactSnapshots: Array.isArray(command?.payload?.artifactSnapshots)
        ? command.payload.artifactSnapshots
        : [],
    };
  }

  function uniqueManagedArtifactPaths(artifactPaths) {
    if (!Array.isArray(artifactPaths)) throw new Error("loop_managed_artifact_paths_invalid");
    return [...new Set(artifactPaths.map((value) => String(value ?? "").trim()))].sort();
  }

  function managedArtifactSnapshotsByPath(artifactSnapshots, selectedPaths) {
    const selected = new Set(selectedPaths);
    const snapshots = new Map();
    for (const value of Array.isArray(artifactSnapshots) ? artifactSnapshots : []) {
      const snapshot = normalizeManagedArtifactSnapshot(value);
      if (!snapshot || !selected.has(snapshot.path) || snapshots.has(snapshot.path)) continue;
      snapshots.set(snapshot.path, snapshot);
    }
    return snapshots;
  }

  function normalizeManagedArtifactSnapshot(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const artifactPath = String(value.path ?? "").trim();
    if (!artifactPath) return undefined;
    if (value.state === "missing") return { path: artifactPath, state: "missing" };
    if (value.state !== "present" || !["file", "symlink"].includes(value.kind)) return undefined;
    const snapshot = { path: artifactPath, state: "present", kind: value.kind };
    for (const field of ["dev", "ino", "size", "mtimeMs", "ctimeMs"]) {
      if (typeof value[field] === "number" && Number.isFinite(value[field])) snapshot[field] = value[field];
    }
    return snapshot;
  }

  function managedArtifactSnapshot({ artifactPath, stats, kind = managedArtifactKind(stats) }) {
    const snapshot = { path: artifactPath, state: "present", kind };
    for (const field of ["dev", "ino", "size", "mtimeMs", "ctimeMs"]) {
      const number = Number(stats?.[field]);
      if (Number.isFinite(number)) snapshot[field] = number;
    }
    return snapshot;
  }

  function managedArtifactSnapshotMatches(stats, snapshot) {
    if (snapshot?.state !== "present" || managedArtifactKind(stats) !== snapshot.kind) return false;
    // `dev` + `ino` distinguish a replacement on the supported local
    // filesystem. Size and timestamps additionally catch a changed hardlink
    // or an in-place rewrite when the filesystem exposes them.
    for (const field of ["dev", "ino"]) {
      const expected = Number(snapshot[field]);
      const actual = Number(stats?.[field]);
      if (!Number.isFinite(expected) || !Number.isFinite(actual) || expected !== actual) return false;
    }
    for (const field of ["size", "mtimeMs", "ctimeMs"]) {
      if (!Object.prototype.hasOwnProperty.call(snapshot, field)) continue;
      const expected = Number(snapshot[field]);
      const actual = Number(stats?.[field]);
      if (!Number.isFinite(expected) || !Number.isFinite(actual) || expected !== actual) return false;
    }
    return true;
  }

  function managedArtifactKind(stats) {
    if (stats?.isFile?.()) return "file";
    if (stats?.isSymbolicLink?.()) return "symlink";
    return undefined;
  }

  function managedArtifactAbsolutePath(task, artifactPath) {
    const relativePath = normalizeArtifactPath(artifactPath);
    const cwd = path.resolve(task.cwd);
    const absolutePath = path.resolve(cwd, relativePath);
    if (!absolutePath.startsWith(`${cwd}${path.sep}`)) throw new Error("loop_artifact_outside_task_cwd");
    return absolutePath;
  }

  async function releaseTaskPresentationPages({ taskId, tolerateFailures = false }) {
    const leases = [...presentationLeases.entries()]
      .filter(([, lease]) => lease.taskId === taskId)
      .map(([leaseId, lease]) => ({ leaseId, ...lease }));
    for (const lease of leases) {
      try {
        await releaseOpenCodeSessionPage({
          runId: lease.runId,
          sessionId: lease.sessionId,
          leaseId: lease.leaseId,
        });
      } catch (error) {
        // Permanent deletion retains the pre-existing strict cleanup contract.
        // Achieve has already closed the durable lifecycle fence, so it may
        // preserve that accepted result even if an ephemeral gateway cleanup
        // is temporarily unavailable.
        if (!tolerateFailures) throw error;
      }
    }
  }

  function forgetTaskRuntimeReferences({ taskId, runs }) {
    conductorRecoveryPromises.delete(taskId);
    for (const key of permissionRecoveryPromises.keys()) {
      if (key.startsWith(`${taskId}:`)) permissionRecoveryPromises.delete(key);
    }
    for (const key of questionSubmissionPromises.keys()) {
      if (key.startsWith(`${taskId}:`)) questionSubmissionPromises.delete(key);
    }
    for (const run of runs) {
      serverEventUnsubscribers.get(run.runId)?.();
      serverEventUnsubscribers.delete(run.runId);
      conductorServerMessageQueues.delete(run.runId);
      providerUserInputReceipts.delete(run.runId);
    }
    for (const [leaseId, lease] of presentationLeases) {
      if (lease.taskId === taskId) presentationLeases.delete(leaseId);
    }
  }

  async function stopRunSessions({ task, run, abortProviderSessions = false }) {
    if (usesOpenCodeServer) {
      // `stopRun` only releases this Run's ownership of the shared Host.  It
      // does not tell OpenCode to interrupt a Provider turn.  A Task Stop must
      // first abort every Provider Session already bound to this Run; otherwise
      // a model could continue working after the Task is shown as stopped.
      // Read the existing client directly: attaching a Run Host during Stop
      // could recreate a transport solely in order to cancel it.
      if (abortProviderSessions) {
        const client = openCodeServerManager.clientForRun({ taskId: task.taskId, runId: run.runId });
        for (const binding of boundOpenCodeSessions({ task, run })) {
          await client.abort({ cwd: task.cwd, providerSessionId: binding.providerSessionId });
        }
      }
      serverEventUnsubscribers.get(run.runId)?.();
      serverEventUnsubscribers.delete(run.runId);
      providerUserInputReceipts.delete(run.runId);
      if (typeof openCodeServerManager.stopRun === "function") {
        await openCodeServerManager.stopRun({ taskId: task.taskId, runId: run.runId });
      } else if (typeof openCodeServerManager.releaseRun === "function") {
        await openCodeServerManager.releaseRun({ taskId: task.taskId, runId: run.runId, leaseId: runtimeHostLeaseId(run) });
      }
      // Releasing this Run's shared Server host is a Task/Run resource action,
      // not an observation that any Provider Session is blocked. Keep the last
      // Provider fact intact; Task lifecycle state tells the UI that the Task
      // was intentionally stopped, achieved, recycled, or deleted.
      return;
    }
    const sessionIds = [
      workspaceSessionId(task, "conductor", run),
      ...task.architecture.agentCards.map((card) => workspaceSessionId(task, card.id, run)),
    ];
    const liveSessionIds = sessionIds.filter((sessionId) => {
      const terminal = ptyManager.get?.(sessionId);
      return terminal && ["running", "stopping"].includes(String(terminal.status));
    });
    await Promise.all(liveSessionIds.map(async (sessionId) => {
      try {
        await sessionAuthority.stopSession?.({ workspaceSessionId: sessionId });
      } catch {
        // A process that already exited is an equivalent terminal fact.
      }
    }));
    if (!liveSessionIds.length || typeof ptyManager.onEvent !== "function") return;
    await new Promise((resolve) => {
      const remaining = new Set(liveSessionIds);
      const unsubscribe = ptyManager.onEvent((event) => {
        if (event?.type !== "exit" || !remaining.delete(String(event.id ?? ""))) return;
        if (!remaining.size) {
          unsubscribe?.();
          resolve();
        }
      });
      // Exit may occur between stop() and subscription. Decide from the
      // manager's real lifecycle state, never from an elapsed timeout.
      for (const sessionId of [...remaining]) {
        const terminal = ptyManager.get?.(sessionId);
        if (!terminal || !["running", "stopping"].includes(String(terminal.status))) remaining.delete(sessionId);
      }
      if (!remaining.size) {
        unsubscribe?.();
        resolve();
      }
    });
  }

  function serializeTaskLifecycle(taskId, operation) {
    const previous = taskLifecycleQueues.get(taskId) ?? Promise.resolve();
    const work = previous.then(operation);
    // Keep the queued barrier fulfilled so a failed command does not prevent a
    // later explicit retry. The caller still receives the original rejection.
    const barrier = work.then(
      () => undefined,
      () => undefined,
    );
    taskLifecycleQueues.set(taskId, barrier);
    void barrier.then(() => {
      if (taskLifecycleQueues.get(taskId) === barrier) taskLifecycleQueues.delete(taskId);
    });
    return work;
  }

  function close() {
    for (const unsubscribe of serverEventUnsubscribers.values()) unsubscribe?.();
    serverEventUnsubscribers.clear();
    providerUserInputReceipts.clear();
    db.close();
  }

  return {
    listTemplates,
    listTemplateVersions,
    templateById,
    templateDesignService,
    saveTemplate,
    generateTemplateDraft,
    copyTemplate,
    archiveTemplate,
    deleteTemplate,
    createTask,
    startRun,
    listTasks,
    readTask,
    readRun,
    readWorkbenchLayout,
    saveWorkbenchLayout,
    readArtifact,
    openOpenCodeSessionPage,
    releaseOpenCodeSessionPage,
    markTaskAchieved,
    resumeAchievedTask,
    stopTask,
    moveTaskToRecycleBin,
    restoreTaskFromRecycleBin,
    previewTaskPermanentDeletion,
    permanentlyDeleteTask,
    deleteTask,
    recordUserMessage,
    respondPermission,
    respondSessionQuestion,
    resumePendingPermissionRecoveries,
    recoverRun,
    reconcilePreparedLifecycleCommands,
    flushPendingUserMessages,
    ensureConductorWakeupTarget,
    listConductorWakeupTargets,
    recordCompletionClaim,
    validateDispatch,
    resumeTaskForDispatch,
    resumeTaskForConductorInput,
    observeProviderUserInputBeforeExecution,
    prepareDispatchContext,
    resolveAgentSession,
    prepareWorkerInitialDispatch,
    deliverOpenCodeWorkerAssignment,
    abortOpenCodeDispatch,
    taskAgentMap,
    hasTask,
    close,
  };
}

function agentCard(input = {}) {
  return normalizeAgentCard(input, { defaultModel: DEFAULT_MODEL });
}

function conductorPrompt(task) {
  const template = task.architecture.template;
  const cards = task.architecture.agentCards.map(conductorCardProfile).join("\n");
  return [
    "You are the task-owner Conductor for Agent Workspace Agent Loop v1.",
    "You are the only Workspace Session that has Agent Workspace MCP tools. All worker Sessions are normal official OpenCode Sessions; do not require them to know Workspace protocol.",
    "Runtime owns Provider Session lifecycle and transport facts, provider-state extraction, artifacts, and wakeups. You own task reasoning and dispatch choices.",
    "Task lifecycle is outside your authority. Never claim that you stopped or restarted a Task, created a new Run, or resumed an old Provider Session. A user Timeline message that mentions restart is ordinary task feedback, not a Runtime command: you may choose a new dispatch in the current Run, or tell the user to use the Task Stop and Restart controls when they need a fresh Run.",
    "You are capability-constrained to the Agent Workspace MCP and user questions. You cannot read, edit, create, patch, or run shell commands against Task files. Never try to bypass this boundary; a Worker Session Agent owns every workspace artifact change.",
    "Every worker Session is dispatched by you through call_session or call_sessions using the approved stable agentId, never a physical session identifier. Each dispatch must state a bounded goal, relevant inputs, acceptance criteria, and expected artifact/output; it must stay within that Agent card's declared native capability scope.",
    "When a later Worker Session depends on any completed Session's findings, conclusion, critique, or other semantic answer, you MUST select that complete answer in contextRefs as result:<resultId> from read_task_state. Runtime will copy the selected Provider answer verbatim into the target assignment and persist the snapshot; an artifact path may supplement the handoff but never replace it. Do not paraphrase it merely to relay it. Never pass raw terminal transcripts or physical Session IDs. contextRefs remain empty only when the new Session is genuinely independent of prior Session answers.",
    "A Worker Session answer is complete semantic material, not a Runtime verdict. A Reviewer's `pass`, `needs changes`, or critique is ordinary natural-language content in its completed Provider answer. When a review identifies a factual, source, date, coverage, or contradiction gap, do not turn it into an editorial repair brief for Publisher: read the full durable result and decide whether an evidence-capable card should investigate it. If you choose that work, pass the exact Review result with contextRefs. When you judge selected evidence and review material sufficient for a deliverable, pass those selected result:<resultId> materials to Publisher. contextRefs are optional: use them only when the target needs that prior material.",
    "Use read_task_state at the beginning of a decision. You may issue zero, one, or many asynchronous dispatches, then either continue reasoning or end the Provider turn. Do not poll worker Sessions while work is pending: Runtime will wake you from provider-derived result, failure, attention, or user-message facts.",
    "Provider permission requests are owned by the person in the Task-page authorization card and by Runtime's Provider adapter. Never ask a person to click, approve, reject, or locate an OpenCode TUI permission dialog. You receive no permission-decision wakeup; wait for the normal Provider result or failure fact before making a new task decision.",
    "A call_session or call_sessions response that says queued/input_accepted is only a Host transport fact, never a Provider result or delivery evidence. If you create any dispatch in a decision, do not call claim_task_completion: that tool records a user-visible delivery claim, it is not a way to end or pause a Provider turn. Summarize that you are waiting and end the Provider turn normally. On a later semantic Runtime wakeup, use read_task_state to find dispatch.provider.received and a result_available Provider answer before you consider a delivery claim.",
    "Do not edit worker-owned deliverables yourself. On a worker result, failure, attention, or user follow-up, inspect durable state and decide whether to dispatch, re-dispatch, synthesize through a native Session Agent, ask the user, or claim delivery. A review finding is evidence for your judgement, not a Runtime-enforced route.",
    "Runtime never chooses a repair, reviewer, publisher, re-check, count of agents, or business completion condition. Use claim_task_completion when you judge the task is ready for the user to inspect; the user alone may mark the Task achieved.",
    "Before a delivery claim, compare every explicit acceptance condition in the task goal against durable Provider results. A path existing or a worker saying it wrote a file is not sufficient evidence. If a required condition is missing, incomplete, or contradicted, decide a bounded corrective dispatch or ask the user; do not claim delivery.",
    "",
    `Task id: ${task.taskId}`,
    `Task: ${task.title}`,
    `Goal: ${task.goal}`,
    `Task project root: ${task.cwd}`,
    "Every requested relative artifact path is rooted at Task project root. State that exact root in an artifact-creating dispatch. .agent-workspace contains Runtime metadata only; never use it as an artifact root.",
    `Loop Template: ${template.name} v${template.version}`,
    "Conductor Charter:",
    template.conductor.charter || "Decide each next dispatch from the task goal, durable Session returns, and user follow-ups. Prefer bounded contracts and use the available Session cards as capabilities, never as a fixed route.",
    "",
    "Approved Worker Session Agent cards:",
    cards,
  ].join("\n");
}

function conductorCardProfile(card) {
  if (isPromptSplitAgentCard(card)) {
    return [
      `- ${card.name} (agentId: ${card.id}, responsibility: ${card.kind}): ${card.dispatchProfile.title}`,
      `  Dispatch profile: ${card.dispatchProfile.description}`,
      optionalModelVariant(card.modelVariant) ? `  Model variant: ${optionalModelVariant(card.modelVariant)}` : "",
    ].join("\n");
  }
  // Preserve the legacy prompt body exactly. Existing Task snapshots created
  // before Card prompt splitting keep their historical behaviour; a new
  // contract is never inferred from the old combined fields.
  return [
    `- ${card.name} (agentId: ${card.id}, responsibility: ${card.kind}): ${card.role}`,
    `  Model: ${card.model}`,
    optionalModelVariant(card.modelVariant) ? `  Model variant: ${optionalModelVariant(card.modelVariant)}` : "",
    `  Native MCP scope: ${card.mcp.length ? card.mcp.join(", ") : "all provider-native MCP available in this project"}`,
    `  Native Skills scope: ${card.skills.length ? card.skills.join(", ") : "all provider-native Skills available in this project"}`,
    card.instructions ? `  Card instructions: ${card.instructions}` : "",
    card.expectedOutput ? `  Default expected output: ${card.expectedOutput}` : "",
  ].filter(Boolean).join("\n");
}

function workerPrompt({ task, card }) {
  const mcpScope = card.mcp.length ? card.mcp.join(", ") : "all provider-native MCP already available to this project";
  const skillScope = card.skills.length ? card.skills.join(", ") : "all provider-native Skills already available to this project";
  const cardContext = isPromptSplitAgentCard(card)
    ? [
        `Worker system prompt: ${card.workerSystemPrompt}`,
        `Declared native MCP scope: ${mcpScope}`,
        `Declared native Skills scope: ${skillScope}`,
      ]
    : [
        `Card role: ${card.role}`,
        `Card instructions: ${card.instructions || "Follow the current dispatch and report verifiable findings."}`,
        `Default expected output: ${card.expectedOutput || "A concise, verifiable response for the Conductor."}`,
        `Declared native MCP scope: ${mcpScope}`,
        `Declared native Skills scope: ${skillScope}`,
      ];
  return [
    "You are an Agent Workspace Session Agent running the official OpenCode build provider agent.",
    "Your Agent Card below is stable Session configuration, not a custom OpenCode provider agent. Do not change your provider agent, model, or Task scope.",
    "You are not the Conductor and you do not receive Agent Workspace dispatch, lifecycle, or completion MCP tools. Return your bounded work to the current conversation; Runtime will record the provider result and wake the Conductor.",
    "The current Task goal, project root, and bounded acceptance criteria are supplied once in each Dispatch message. Do not infer a new assignment from this system context.",
    ...cardContext,
    "MCP, Skills, and plugins are provided only by the project-level OpenCode host configuration. This card does not install, invent, or reconfigure a server, skill, or plugin; use a named capability only if it is actually available in this Session.",
    "Treat each new dispatch as a new Invocation on this same long-lived Agent Session. Preserve useful prior context, but follow the newest bounded assignment and its acceptance criteria.",
  ].join("\n");
}

function formatWorkerInvocationInput({ task, card, dispatch, text }) {
  return [
    "[Agent Workspace] Task invocation",
    `Task id: ${task.taskId}`,
    `Task: ${task.title}`,
    `Task goal: ${task.goal}`,
    `Task project root: ${task.cwd}`,
    `Logical Agent Card: ${card.name} (agentId: ${card.id}, type: ${card.kind})`,
    "",
    String(text ?? "").trim(),
    "",
    `Dispatch ownership: ${dispatch?.dispatchId ?? "unknown"}`,
  ].filter(Boolean).join("\n");
}

function workspaceSessionId(task, agentId, run) {
  const scope = String(run?.sessionScope ?? "").trim();
  const scoped = scope ? `:${safeSegment(scope)}` : "";
  return `opencode:${safeSegment(task.projectId)}:${safeSegment(task.taskId)}${scoped}:${safeSegment(agentId)}`;
}

// A native OpenCode Session is launched by an absolute executable path, but
// provider-native tools may themselves invoke `opencode`. Keep the resolved
// executable discoverable inside the same PTY process tree without changing
// the user's global environment. This is launch configuration only; it is
// not a Runtime-to-Provider control channel.
function nativeOpenCodeEnvironment(opencodePath) {
  const executable = String(opencodePath ?? "").trim();
  if (!executable || !executable.includes(path.sep)) return undefined;
  const binDirectory = path.dirname(executable);
  const inheritedPath = String(process.env.PATH ?? "");
  const entries = inheritedPath.split(path.delimiter).filter(Boolean);
  return {
    OPENCODE_PATH: executable,
    PATH: entries.includes(binDirectory)
      ? inheritedPath
      : [binDirectory, ...entries].join(path.delimiter),
  };
}

function conductorOpenCodePermissionRules() {
  return [
    { permission: "*", pattern: "*", action: "deny" },
    { permission: "agent_workspace_conductor_*", pattern: "*", action: "allow" },
    { permission: "question", pattern: "*", action: "allow" },
  ];
}

function workerOpenCodePermissionRules() {
  return [{ permission: "agent_workspace_conductor_*", pattern: "*", action: "deny" }];
}

function conductorOpenCodeTools() {
  return { "agent_workspace_conductor_*": true };
}

function workerOpenCodeTools() {
  return { "agent_workspace_conductor_*": false };
}

/**
 * OpenCode 1.18 stores a provider-declared model variant on Session creation.
 * A normal Card still selects its model on the first prompt, preserving the
 * existing provider path. Once a variant was explicitly selected, create the
 * Session with its full named model and leave later turns untouched so the
 * Server does not replace or reject that variant.
 */
function openCodeServerSessionCreationModel({ model, modelVariant } = {}) {
  const variant = optionalModelVariant(modelVariant);
  if (!variant) return undefined;
  const selected = required(model, "opencode_server_model_required");
  const separator = selected.indexOf("/");
  if (separator <= 0 || separator === selected.length - 1) {
    throw new Error("opencode_server_model_invalid");
  }
  return {
    providerID: selected.slice(0, separator),
    modelID: selected.slice(separator + 1),
    variant,
  };
}

function openCodeServerContinuationModel({ model, modelVariant } = {}) {
  return optionalModelVariant(modelVariant) ? undefined : required(model, "opencode_server_model_required");
}

function optionalModelVariant(value) {
  if (value === undefined || value === null) return undefined;
  const variant = String(value).trim();
  return variant ? variant.slice(0, 120) : undefined;
}

function openCodeServerRunConfig({ task, bridge }) {
  // A canonical project root owns one Server configuration.  The host loads
  // both isolated MCP namespaces once; individual Provider Sessions still
  // opt into only their allowed tools and agents.
  const hasTemplateDesignerBridge = [
    bridge?.templateDesignerToolBridgeUrl,
    bridge?.templateDesignerToolBridgeToken,
    bridge?.templateDesignerMcpServerPath,
  ].some(Boolean);
  return createOpenCodeHostRuntimeConfig({
    cwd: task?.cwd,
    conductorBridge: bridge,
    templateDesignerBridge: hasTemplateDesignerBridge ? bridge : undefined,
  });
}

function latestOpenCodeAssistantMessage(messages) {
  const entries = Array.isArray(messages) ? messages : [];
  for (const entry of [...entries].reverse()) {
    if (String(entry?.info?.role ?? "") !== "assistant") continue;
    const text = (Array.isArray(entry?.parts) ? entry.parts : [])
      .filter((part) => String(part?.type ?? "") === "text")
      .map((part) => String(part?.text ?? ""))
      .join("\n")
      .trim();
    if (!text) continue;
    return {
      text,
      messageId: String(entry?.info?.id ?? "") || undefined,
      completedAt: Number(entry?.info?.time?.completed ?? entry?.info?.time?.end ?? 0) || undefined,
    };
  }
  return undefined;
}

function formatOpenCodeResultWakeup({ dispatch, result, wakeupKey }) {
  return [
    `[Agent Workspace] Conductor Input ID ${wakeupKey}`,
    "",
    `Runtime wakeup: ${dispatch.agentId || "Session Agent"} result available`,
    `Dispatch ID: ${dispatch.dispatchId}`,
    result.resultId ? `Result ID: ${result.resultId}` : "",
    "",
    "Worker result:",
    String(result.answerText ?? ""),
    "",
    "Conductor: inspect durable Task state, then decide the next dispatch, correction, review, or delivery action.",
  ].filter(Boolean).join("\n");
}

function deserializeTask(row) {
  const architecture = JSON.parse(row.architecture_json);
  // New Tasks write this projection explicitly. If an in-flight migration
  // already captured an explicit variant on its immutable Template snapshot,
  // preserve that fact without persisting a synthetic default into history.
  const storedDefaultModelVariant = optionalModelVariant(
    architecture.defaultModelVariant ?? architecture.template?.conductor?.modelVariant,
  );
  if (storedDefaultModelVariant) architecture.defaultModelVariant = storedDefaultModelVariant;
  architecture.agentCards = Array.isArray(architecture.agentCards) ? architecture.agentCards.map(agentCard) : [];
  architecture.template = architecture.template && typeof architecture.template === "object"
    ? {
        ...architecture.template,
        conductor: {
          ...(architecture.template.conductor || {}),
          charter: String(architecture.template.conductor?.charter || architecture.template.conductor?.instructions || "").trim(),
        },
        agents: architecture.agentCards,
        delivery: normalizeStoredDelivery(architecture.template.delivery),
      }
    : architecture.template;
  architecture.delivery = normalizeStoredDelivery(architecture.delivery);
  return {
    taskId: row.task_id,
    projectId: row.project_id,
    cwd: row.cwd,
    title: row.title,
    goal: row.goal,
    architecture,
    status: row.status,
    revision: Number(row.revision ?? 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function deserializeRun(row) {
  return {
    runId: row.run_id,
    taskId: row.task_id,
    status: row.status,
    conductorSessionId: row.conductor_session_id,
    sessionScope: String(row.session_scope ?? ""),
    revision: Number(row.revision ?? 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function listArtifacts(task) {
  const artifactPath = configuredArtifactPath(task);
  if (!artifactPath) return [];
  const absolute = path.resolve(task.cwd, artifactPath);
  // A legacy Template may contain a preferred path, but it is only a passive
  // lookup candidate. A missing file must never surface as an expected
  // deliverable, a completion gate, or a Conductor routing input.
  if (!fs.existsSync(absolute)) return [];
  const stats = fs.statSync(absolute);
  return [{ path: artifactPath, change: "added", exists: stats.isFile(), size: stats.size, previewable: stats.isFile() && stats.size <= 1_500_000 }];
}

function configuredArtifactPath(task) {
  const artifactPath = String(task.architecture.delivery?.artifactPath || "").trim();
  return artifactPath ? normalizeArtifactPath(artifactPath) : "";
}

function formatInteractiveInput(text) {
  const body = String(text ?? "").trimEnd();
  return `\x1b[200~${body}\x1b[201~\r`;
}

function formatConductorStartupInput(task, startupMessages = []) {
  return [
    // This canonical marker is also the durable Provider-observer binding for
    // the logical Conductor conversation. It must remain verbatim across an
    // initial launch and a recovered TUI.
    "Start this Agent Workspace task now.",
    "The Task identity, goal, project root, charter, and available Session Agent cards are in your configured system context.",
    "Read your configured instructions and durable Runtime state, then make the next decision.",
    ...startupMessages.flatMap((item) => [
      "",
      `[Agent Workspace] Conductor Input ID ${item.inputId ?? item.messageId}`,
      "User follow-up for the current Task:",
      "",
      String(item.message ?? ""),
    ]),
    "",
    "Do not assume a fixed route. Use the durable state to decide what happens next.",
  ].join("\n");
}

function userMessageWakeupKey(taskId, messageId) {
  return `user:${safeSegment(taskId)}:${safeSegment(messageId)}`;
}

function providerUserInputWakeupKey({ task, run, inputId }) {
  return `provider-user:${safeSegment(task.taskId)}:${safeSegment(run.runId)}:${providerUserInputDigest(inputId)}`;
}

function providerUserInputIntentCommandId({ run, inputId }) {
  return `runtime:${run.runId}:provider-user-input:${providerUserInputDigest(inputId)}`;
}

function providerUserInputDigest(inputId) {
  return crypto.createHash("sha256").update(String(inputId)).digest("hex").slice(0, 32);
}

function openCodeEventMessageText(message = {}) {
  if (typeof message.text === "string") return message.text;
  const parts = Array.isArray(message.parts) ? message.parts : [];
  return parts
    .filter((part) => String(part?.type ?? "") === "text")
    .map((part) => String(part?.text ?? ""))
    .join("\n");
}

function formatConductorUserInput(message = {}) {
  return [
    `[Agent Workspace] Conductor Input ID ${userMessageWakeupKey(message.task_id, message.message_id)}`,
    "",
    "User follow-up for the current Task:",
    "",
    String(message.message ?? ""),
    "",
    "Read the durable Task state and decide the next action. Do not treat this as a fixed route.",
  ].join("\n");
}

/**
 * The terminal workspace is deliberately separate from Loop orchestration.
 * This tree only records where already-started Sessions are viewed.  A split
 * or a tab move can never create a Session or cause the Conductor to dispatch.
 */
function defaultWorkbenchLayout(sessionIds = []) {
  const ids = uniqueStrings(sessionIds);
  return automaticWorkbenchLayout(ids);
}

function automaticWorkbenchLayout(sessionIds = [], sourceGroups = {}) {
  const ids = uniqueStrings(sessionIds);
  const activeSessionId = ids.includes(sourceGroups.primary?.activeSessionId) ? sourceGroups.primary?.activeSessionId : ids[0];
  return {
    version: 1,
    placementMode: "auto",
    root: { type: "leaf", groupId: "primary" },
    groups: { primary: { id: "primary", sessionIds: ids, activeSessionId, fontSize: normalizeTerminalFontSize(sourceGroups.primary?.fontSize) } },
    focusedGroupId: "primary",
    taskPage: normalizeTaskPageLayout(),
  };
}

function normalizeWorkbenchLayout(input, knownSessionIds = []) {
  const known = uniqueStrings(knownSessionIds);
  if (!input || typeof input !== "object") return defaultWorkbenchLayout(known);
  const sourceGroups = input.groups && typeof input.groups === "object" ? input.groups : {};
  const taskPage = normalizeTaskPageLayout(input.taskPage);
  if (input.placementMode === "auto") return { ...automaticWorkbenchLayout(known, sourceGroups), taskPage };
  const usedGroupIds = new Set();
  const leafGroupIds = [];
  let generatedGroupCount = 0;

  const nextGroupId = () => {
    let candidate = generatedGroupCount ? `group-${generatedGroupCount}` : "primary";
    generatedGroupCount += 1;
    while (usedGroupIds.has(candidate)) {
      candidate = `group-${generatedGroupCount}`;
      generatedGroupCount += 1;
    }
    return candidate;
  };

  const normalizeNode = (node) => {
    if (node && node.type === "split" && ["horizontal", "vertical"].includes(String(node.direction))) {
      const first = normalizeNode(node.first);
      const second = normalizeNode(node.second);
      if (first && second) {
        const ratio = Number(node.ratio);
        return {
          type: "split",
          direction: String(node.direction),
          ratio: Number.isFinite(ratio) ? Math.min(.85, Math.max(.15, ratio)) : .5,
          first,
          second,
        };
      }
    }
    const requested = String(node?.groupId || "");
    const groupId = isWorkbenchGroupId(requested) && !usedGroupIds.has(requested) ? requested : nextGroupId();
    usedGroupIds.add(groupId);
    leafGroupIds.push(groupId);
    return { type: "leaf", groupId };
  };

  const root = normalizeNode(input.root);
  if (!root) return defaultWorkbenchLayout(known);
  const assigned = new Set();
  const groups = {};
  for (const groupId of leafGroupIds) {
    const source = sourceGroups[groupId] && typeof sourceGroups[groupId] === "object" ? sourceGroups[groupId] : {};
    const sessionIds = uniqueStrings(source.sessionIds).filter((sessionId) => known.includes(sessionId) && !assigned.has(sessionId));
    for (const sessionId of sessionIds) assigned.add(sessionId);
    const activeSessionId = sessionIds.includes(source.activeSessionId) ? source.activeSessionId : sessionIds[0];
    groups[groupId] = { id: groupId, sessionIds, activeSessionId, fontSize: normalizeTerminalFontSize(source.fontSize) };
  }

  const primaryGroup = leafGroupIds[0];
  for (const sessionId of known) {
    if (!assigned.has(sessionId)) groups[primaryGroup].sessionIds.push(sessionId);
  }
  if (!groups[primaryGroup].activeSessionId) groups[primaryGroup].activeSessionId = groups[primaryGroup].sessionIds[0];
  const focusedGroupId = leafGroupIds.includes(String(input.focusedGroupId)) ? String(input.focusedGroupId) : primaryGroup;
  return { version: 1, placementMode: "manual", root, groups, focusedGroupId, taskPage };
}

function uniqueStrings(value) { return [...new Set((Array.isArray(value) ? value : []).map((item) => String(item || "").trim()).filter(Boolean))]; }
function isWorkbenchGroupId(value) { return /^[A-Za-z0-9_-]{1,80}$/.test(value); }
function normalizeTerminalFontSize(value) { const size = Number(value); return Number.isFinite(size) ? Math.min(18, Math.max(8, Math.round(size))) : 11; }
function normalizeTaskPageLayout(value) {
  const source = value && typeof value === "object" ? value : {};
  return {
    taskListWidth: normalizeTaskPagePaneWidth(source.taskListWidth, 258),
    inspectorWidth: normalizeTaskPagePaneWidth(source.inspectorWidth, 290),
  };
}
function normalizeTaskPagePaneWidth(value, fallback) { const width = Number(value); return Number.isFinite(width) ? Math.round(Math.min(420, Math.max(196, width))) : fallback; }
function required(value, field) { if (value === undefined || value === null || String(value).trim() === "") throw new Error(`Agent Loop Runtime requires ${field}.`); return value; }
function requiredExpectedRevision(value) { if (!Number.isSafeInteger(Number(value))) throw new Error("loop_task_expected_revision_required"); return Number(value); }
function safeSegment(value) { const result = String(value ?? "").trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, ""); if (!result) throw new Error("Agent Loop Runtime identity is required."); return result; }
function ensureDatabaseDirectory(databasePath) { if (databasePath && databasePath !== ":memory:") fs.mkdirSync(path.dirname(databasePath), { recursive: true }); }
function assertWritableDirectory(cwd) { try { fs.accessSync(cwd, fs.constants.R_OK | fs.constants.W_OK); } catch { throw new Error("loop_task_cwd_not_writable"); } }
function normalizeArtifactPath(value) {
  const relative = String(value ?? "").trim().replace(/^\/+/, "");
  if (!relative || relative.split(/[\\/]+/).includes("..")) throw new Error("loop_artifact_path_invalid");
  return relative;
}

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_loop_template_versions (
      template_id TEXT NOT NULL, version INTEGER NOT NULL, name TEXT NOT NULL, source TEXT NOT NULL,
      conductor_json TEXT NOT NULL, agents_json TEXT NOT NULL, limits_json TEXT NOT NULL, delivery_json TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (template_id, version)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS agent_loop_tasks (
      task_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, cwd TEXT NOT NULL, title TEXT NOT NULL, goal TEXT NOT NULL,
      template_id TEXT NOT NULL, template_version INTEGER NOT NULL, architecture_json TEXT NOT NULL, status TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS agent_loop_runs (
      run_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, status TEXT NOT NULL, conductor_session_id TEXT NOT NULL, session_scope TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS agent_loop_events (
      run_id TEXT NOT NULL, sequence INTEGER NOT NULL, type TEXT NOT NULL, summary TEXT NOT NULL, data_json TEXT NOT NULL,
      created_at TEXT NOT NULL, PRIMARY KEY (run_id, sequence)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS agent_loop_workbench_layouts (
      run_id TEXT PRIMARY KEY, layout_json TEXT NOT NULL, updated_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS agent_loop_user_messages (
      message_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, run_id TEXT, message TEXT NOT NULL, status TEXT NOT NULL,
      created_at TEXT NOT NULL, delivered_at TEXT
    ) STRICT;
    CREATE TABLE IF NOT EXISTS agent_loop_opencode_host_bindings (
      run_id TEXT PRIMARY KEY, project_root TEXT NOT NULL, config_fingerprint TEXT NOT NULL, provider_version TEXT NOT NULL,
      last_attached_at TEXT NOT NULL, last_reconciled_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    ) STRICT;
  `);
  ensureColumn(db, "agent_loop_runs", "session_scope", "TEXT NOT NULL DEFAULT ''");
  migrateLegacyTemplateDescriptions(db);
  removeLegacyReviewPolicies(db);
}

function migrateLegacyTemplateDescriptions(db) {
  const templateColumns = db.prepare("PRAGMA table_info(agent_loop_template_versions)").all();
  if (templateColumns.some((column) => String(column.name) === "description")) {
    const legacyTemplates = db.prepare("SELECT * FROM agent_loop_template_versions").all();
    db.exec(`
      CREATE TABLE agent_loop_template_versions_next (
        template_id TEXT NOT NULL, version INTEGER NOT NULL, name TEXT NOT NULL, source TEXT NOT NULL,
        conductor_json TEXT NOT NULL, agents_json TEXT NOT NULL, limits_json TEXT NOT NULL, delivery_json TEXT NOT NULL,
        archived_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (template_id, version)
      ) STRICT;
    `);
    const insert = db.prepare(`
      INSERT INTO agent_loop_template_versions_next
      (template_id, version, name, source, conductor_json, agents_json, limits_json, delivery_json, archived_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const row of legacyTemplates) {
      const conductor = JSON.parse(row.conductor_json);
      conductor.charter = mergeTemplateCharter(row.description, conductor.charter || conductor.instructions);
      insert.run(
        row.template_id,
        row.version,
        row.name,
        row.source,
        JSON.stringify(conductor),
        row.agents_json,
        row.limits_json,
        row.delivery_json,
        row.archived_at,
        row.created_at,
        row.updated_at,
      );
    }
    db.exec("DROP TABLE agent_loop_template_versions; ALTER TABLE agent_loop_template_versions_next RENAME TO agent_loop_template_versions;");
  }

  const tasks = db.prepare("SELECT task_id, architecture_json FROM agent_loop_tasks").all();
  const updateTask = db.prepare("UPDATE agent_loop_tasks SET architecture_json = ? WHERE task_id = ?");
  for (const row of tasks) {
    const architecture = JSON.parse(row.architecture_json);
    const template = architecture?.template;
    if (!template || typeof template !== "object" || !Object.prototype.hasOwnProperty.call(template, "description")) continue;
    template.conductor = {
      ...(template.conductor || {}),
      charter: mergeTemplateCharter(template.description, template.conductor?.charter || template.conductor?.instructions),
    };
    delete template.description;
    updateTask.run(JSON.stringify(architecture), row.task_id);
  }
}

function mergeTemplateCharter(legacyDescription, charter) {
  const parts = [String(legacyDescription || "").trim(), String(charter || "").trim()].filter(Boolean);
  return parts.length === 2 && parts[0] === parts[1] ? parts[0] : parts.join("\n\n");
}

function removeLegacyReviewPolicies(db) {
  const templates = db.prepare("SELECT template_id, version, conductor_json FROM agent_loop_template_versions").all();
  const updateTemplate = db.prepare("UPDATE agent_loop_template_versions SET conductor_json = ? WHERE template_id = ? AND version = ?");
  for (const row of templates) {
    const conductor = JSON.parse(row.conductor_json);
    if (!conductor || typeof conductor !== "object" || !Object.hasOwn(conductor, "reviewPolicy")) continue;
    delete conductor.reviewPolicy;
    updateTemplate.run(JSON.stringify(conductor), row.template_id, row.version);
  }

  const tasks = db.prepare("SELECT task_id, architecture_json FROM agent_loop_tasks").all();
  const updateTask = db.prepare("UPDATE agent_loop_tasks SET architecture_json = ? WHERE task_id = ?");
  for (const row of tasks) {
    const architecture = JSON.parse(row.architecture_json);
    const conductor = architecture?.template?.conductor;
    if (!conductor || typeof conductor !== "object" || !Object.hasOwn(conductor, "reviewPolicy")) continue;
    delete conductor.reviewPolicy;
    updateTask.run(JSON.stringify(architecture), row.task_id);
  }
}

function ensureColumn(db, table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some((item) => String(item.name) === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

module.exports = { DEFAULT_MODEL, DEFAULT_TEMPLATE_ID, createAgentLoopV1Runtime };

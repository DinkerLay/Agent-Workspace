const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { isLiveConductorTerminal, projectConductorContinuity } = require("./run-continuity.cjs");

const DEFAULT_MODEL = "opencode-go/deepseek-v4-flash";
const DEFAULT_TEMPLATE_ID = "opencode-agent-loop-v1";
const AGENT_CARD_KINDS = new Set(["researcher", "publisher", "reviewer", "general"]);
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
  now = () => new Date().toISOString(),
  randomUUID = crypto.randomUUID,
} = {}) {
  if (!sessionAuthority?.registerLaunchProfile || !sessionAuthority?.activateSession) {
    throw new Error("Agent Loop Runtime requires Session Authority.");
  }
  if (!ptyManager?.read) throw new Error("Agent Loop Runtime requires PTY reads.");
  if (!sessionStore?.recordTaskEvent || !sessionStore?.readTaskState) {
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
  migrate(db);
  ensureSeedTemplate();

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
        agentCard({ id: "researcher", name: "Researcher", kind: "researcher", role: "Research and write bounded Markdown evidence." }),
        agentCard({ id: "reviewer", name: "Reviewer", kind: "reviewer", role: "Check evidence, artifacts, and unresolved risks." }),
        agentCard({ id: "publisher", name: "Publisher", kind: "publisher", role: "Create the final requested deliverable from verified evidence." }),
      ],
      limits: { maxConcurrentSessions: 3, maxDispatchesPerDecision: 3 },
      delivery: { artifactPath: "" },
    });
  }

  function listTemplates({ includeArchived = false } = {}) {
    const rows = db
      .prepare(
        `SELECT t.* FROM agent_loop_template_versions t
         INNER JOIN (
           SELECT template_id, MAX(version) AS version FROM agent_loop_template_versions GROUP BY template_id
         ) latest ON latest.template_id = t.template_id AND latest.version = t.version
         WHERE (? = 1 OR t.archived_at IS NULL)
         ORDER BY t.updated_at DESC, t.template_id ASC`,
      )
      .all(includeArchived ? 1 : 0);
    return rows.map(deserializeTemplate);
  }

  function templateById(templateId, version) {
    const row = Number.isInteger(version)
      ? db.prepare("SELECT * FROM agent_loop_template_versions WHERE template_id = ? AND version = ?").get(templateId, version)
      : db.prepare("SELECT * FROM agent_loop_template_versions WHERE template_id = ? ORDER BY version DESC LIMIT 1").get(templateId);
    return row ? deserializeTemplate(row) : undefined;
  }

  function saveTemplate(input) {
    const normalized = normalizeTemplate(input);
    const existing = templateById(normalized.id);
    const version = existing ? existing.version + 1 : 1;
    const createdAt = now();
    db.prepare(
      `INSERT INTO agent_loop_template_versions
       (template_id, version, name, source, conductor_json, agents_json, limits_json, delivery_json, archived_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
    ).run(
      normalized.id,
      version,
      normalized.name,
      normalized.source,
      JSON.stringify(normalized.conductor),
      JSON.stringify(normalized.agents),
      JSON.stringify(normalized.limits),
      JSON.stringify(normalized.delivery),
      createdAt,
      createdAt,
    );
    return templateById(normalized.id, version);
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
      template: normalizeTemplate(generated?.template),
      assistantMessage: String(generated?.assistantMessage || "OpenCode 已生成可编辑的 Agent Loop 草案。"),
      assumptions: Array.isArray(generated?.assumptions) ? generated.assumptions.map(String).filter(Boolean) : [],
    };
  }

  function copyTemplate({ templateId, name }) {
    const source = required(templateById(required(templateId, "templateId")), "loop_template_not_found");
    const id = `loop-${safeSegment(name || `${source.name} copy`)}-${randomUUID().slice(0, 6)}`;
    return saveTemplate({ ...source, id, name: required(name || `${source.name} copy`, "name"), source: "manual" });
  }

  function archiveTemplate({ templateId }) {
    const template = required(templateById(required(templateId, "templateId")), "loop_template_not_found");
    const timestamp = now();
    db.prepare("UPDATE agent_loop_template_versions SET archived_at = ?, updated_at = ? WHERE template_id = ?").run(timestamp, timestamp, template.id);
    return templateById(template.id);
  }

  function deleteTemplate({ templateId }) {
    const id = required(templateId, "templateId");
    const references = Number(db.prepare("SELECT COUNT(*) AS count FROM agent_loop_tasks WHERE template_id = ?").get(id)?.count ?? 0);
    if (references) throw new Error("loop_template_is_referenced_by_task");
    db.prepare("DELETE FROM agent_loop_template_versions WHERE template_id = ?").run(id);
    return { deleted: true, templateId: id };
  }

  function createTask(input) {
    const taskId = safeSegment(input?.taskId || `loop-${randomUUID().slice(0, 8)}`);
    const cwd = path.resolve(required(input?.cwd, "cwd"));
    assertWritableDirectory(cwd);
    const template = required(templateById(required(input?.templateId || DEFAULT_TEMPLATE_ID, "templateId"), Number(input?.templateVersion) || undefined), "loop_template_not_found");
    if (template.archivedAt) throw new Error("loop_template_archived");
    if (db.prepare("SELECT task_id FROM agent_loop_tasks WHERE task_id = ?").get(taskId)) throw new Error("loop_task_id_conflict");
    const title = required(input?.title, "title");
    const goal = required(input?.goal, "goal");
    const architecture = {
      primaryMode: "agent_loop",
      template: templateSnapshot(template),
      defaultModel: template.conductor.model,
      agentCards: template.agents,
      delivery: template.delivery,
    };
    const timestamp = now();
    db.prepare(
      `INSERT INTO agent_loop_tasks
       (task_id, project_id, cwd, title, goal, template_id, template_version, architecture_json, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)`,
    ).run(taskId, safeSegment(input?.projectId || "local"), cwd, title, goal, template.id, template.version, JSON.stringify(architecture), timestamp, timestamp);
    recordTaskEvent({ taskId, cwd, type: "task.architecture_confirmed", summary: `已确认 Agent Loop Template：${template.name} v${template.version}。`, data: { template: templateSnapshot(template) } });
    return readTask({ taskId });
  }

  async function startRun({ taskId }) {
    const task = required(taskById(required(taskId, "taskId")), "loop_task_not_found");
    if (task.status === "archived") throw new Error("loop_task_is_archived");
    const previousRun = latestRun(task.taskId);
    if (task.status !== "achieved" && ["running", "recovery_required"].includes(String(previousRun?.status))) {
      throw new Error(previousRun?.status === "recovery_required" ? "loop_run_requires_recovery" : "loop_run_already_running");
    }
    // A user-initiated re-run creates new Session identities. It cannot adopt
    // a completed Run's long-lived OpenCode TUI.
    if (task.status === "achieved" && previousRun) {
      await stopRunSessions({ task, run: previousRun });
      recordRunEvent({
        runId: previousRun.runId,
        type: "task.rerun_requested",
        summary: "用户从已完成任务管理发起新的 Run；旧原生 Session 已停止。",
        data: {},
      });
    }
    const runId = `run-${randomUUID()}`;
    const sessionScope = previousRun ? safeSegment(runId) : "";
    const timestamp = now();
    const conductorSessionId = workspaceSessionId(task, "conductor", { runId, sessionScope });
    db.prepare("INSERT INTO agent_loop_runs (run_id, task_id, status, conductor_session_id, session_scope, created_at, updated_at) VALUES (?, ?, 'running', ?, ?, ?, ?)").run(
      runId,
      task.taskId,
      conductorSessionId,
      sessionScope,
      timestamp,
      timestamp,
    );
    db.prepare("UPDATE agent_loop_tasks SET status = 'running', updated_at = ? WHERE task_id = ?").run(timestamp, task.taskId);
    // A Task Run owns its terminal workspace.  Start with the Conductor in the
    // primary Group; worker Groups only gain a tab after a real Conductor
    // dispatch has materialized a native Session.
    writeWorkbenchLayout({
      runId,
      knownSessionIds: [conductorSessionId],
      layout: defaultWorkbenchLayout([conductorSessionId]),
    });
    const run = required(runById(runId), "loop_run_not_found");
    // A Task may receive a user instruction before its first Run exists.  It
    // is still a Conductor input command, not a row to be silently ignored at
    // launch.  Persist its intent before the native process is started, then
    // use the same exact marker / Provider-receipt path as a live wakeup.
    const startupUserMessages = db
      .prepare("SELECT * FROM agent_loop_user_messages WHERE task_id = ? AND status = 'pending' ORDER BY created_at ASC")
      .all(task.taskId);
    for (const item of startupUserMessages) {
      recordUserMessageWakeup({ task, run, messageId: item.message_id, message: item.message, status: "attempting" });
    }
    try {
      await startConductor({
        task,
        runId,
        startupMessages: startupUserMessages.map((item) => ({
          messageId: item.message_id,
          inputId: userMessageWakeupKey(task.taskId, item.message_id),
          message: item.message,
        })),
      });
    } catch (error) {
      // Do not leave a Task labelled `running` with zero live PTYs when the
      // initial native Conductor process failed to start.  The command intent
      // remains queued and a later user retry creates a fresh Run identity.
      for (const item of startupUserMessages) {
        recordUserMessageWakeup({ task, run, messageId: item.message_id, message: item.message, status: "queued" });
      }
      const failure = error instanceof Error ? error.message : "conductor_start_failed";
      db.prepare("UPDATE agent_loop_runs SET status = 'failed', updated_at = ? WHERE run_id = ?").run(now(), runId);
      db.prepare("UPDATE agent_loop_tasks SET status = 'queued', updated_at = ? WHERE task_id = ?").run(now(), task.taskId);
      recordRunEvent({ runId, type: "conductor.start.failed", summary: "Conductor 未能启动；Task 保持可重试。", data: { reason: failure } });
      recordTaskEvent({ taskId: task.taskId, cwd: task.cwd, type: "task.run.start_failed", summary: "Conductor 未能启动；未创建可用运行时 Session。", data: { runId, reason: failure } });
      throw error;
    }
    for (const item of startupUserMessages) {
      // Starting a PTY only proves that a launch was accepted.  The launch
      // message is not delivered until the Provider database records its
      // exact Conductor Input ID.  Keeping it `attempting` lets the observer
      // queue the same durable intent again if the process died or OpenCode
      // only pasted it into a TUI prompt.
      db.prepare("UPDATE agent_loop_user_messages SET run_id = ? WHERE message_id = ?")
        .run(runId, item.message_id);
    }
    recordRunEvent({ runId, type: "conductor.started", summary: "Conductor 已启动，等待其异步派发原生 Session Agent。", data: { sessionId: conductorSessionId } });
    recordTaskEvent({ taskId: task.taskId, cwd: task.cwd, type: "task.run.started", summary: "Agent Loop 已启动；Conductor 正在形成首次派发决策。", data: { runId } });
    return readRun({ runId });
  }

  async function startConductor({ task, runId, startupMessages = [] }) {
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
        "agent_workspace_conductor",
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
          // The Conductor is a control-plane agent, not a second worker. Its
          // only executable tools are the Workspace MCP calls below and the
          // native question tool for genuinely user-owned decisions. The
          // explicit wildcard deny prevents Edit/Write/ApplyPatch/Bash and
          // all other provider-native tools from becoming a backdoor to alter
          // Task deliverables.
          agent: {
            agent_workspace_conductor: {
              description: "Agent Workspace control-plane Conductor. It dispatches and never edits deliverables.",
              mode: "primary",
              permission: {
                "*": "deny",
                "agent_workspace_conductor_*": "allow",
                question: "allow",
              },
            },
          },
          default_agent: "agent_workspace_conductor",
        }),
      },
    });
    // An activation operation is one physical start attempt, not a permanent
    // identity for the logical Conductor.  Reusing `loop:${runId}:conductor`
    // after its PTY exited would only replay Session Authority's old completed
    // operation and leave a durable wakeup with no live Host Session.
    const activation = await sessionAuthority.activateSession({
      workspaceSessionId: sessionId,
      operationId: `conductor:${runId}:${randomUUID()}`,
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
    sessionStore.recordState?.(
      { taskId: task.taskId, sessionId, cwd: task.cwd },
      "running",
      "Conductor initial decision is active.",
      { runId, source: "agent-loop-runtime" },
    );
    return activation.session;
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
        card: { id: "conductor", name: task.architecture.template.conductor.role, role: "Conductor", model: task.architecture.defaultModel },
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

  function latestOpenCodeProviderSessionId({ taskId, workspaceSessionId }) {
    const state = sessionStore.readTaskState?.({ taskId, sinceCursor: 0 }) ?? {};
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
    const taskState = sessionStore.readTaskState?.({ taskId: task.taskId, sinceCursor: 0 });
    // Permission recovery owns the current native Session until OpenCode has
    // issued a fresh request and recorded the user's retained answer.  A new
    // dispatch must not be delivered into that restored TUI: it could replace
    // the permission prompt or be later interrupted by an old dispatch
    // cancellation.  This is a transport occupancy fact, not a workflow rule.
    const pendingPermission = (taskState?.permissions ?? []).find(
      (permission) =>
        String(permission?.sessionId ?? "") === String(toSessionId) &&
        !["approved", "denied", "resolved", "reissued"].includes(String(permission?.status ?? "requested")),
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
    if (["achieved", "archived", "stopped"].includes(task.status)) throw new Error("loop_task_is_closed");
    const run = required(latestRun(task.taskId), "loop_run_not_found");
    if (task.status === "delivery_ready") throw new Error("loop_task_requires_new_conductor_input");
    return readRun({ runId: run.runId });
  }

  function resumeTaskForConductorInput({ taskId, cause, inputId } = {}) {
    const task = required(taskById(required(taskId, "taskId")), "loop_task_not_found");
    if (["achieved", "archived", "stopped"].includes(task.status)) throw new Error("loop_task_is_closed");
    const run = required(latestRun(task.taskId), "loop_run_not_found");
    if (task.status !== "delivery_ready") return readRun({ runId: run.runId });
    const timestamp = now();
    db.prepare("UPDATE agent_loop_runs SET status = 'running', updated_at = ? WHERE run_id = ?").run(timestamp, run.runId);
    db.prepare("UPDATE agent_loop_tasks SET status = 'running', updated_at = ? WHERE task_id = ?").run(timestamp, task.taskId);
    recordRunEvent({
      runId: run.runId,
      type: "task.continued",
      summary: "新的 Conductor 输入已开启下一次决策；Task 回到运行中。",
      data: { cause: String(cause || "conductor_input"), inputId: inputId ? String(inputId) : undefined },
    });
    return readRun({ runId: run.runId });
  }

  function prepareDispatchContext({ taskId, contextRefs }) {
    const task = required(taskById(required(taskId, "taskId")), "loop_task_not_found");
    if (contextRefs !== undefined && !Array.isArray(contextRefs)) throw new Error("context_refs_must_be_array");
    const refs = (contextRefs ?? []).map((value) => String(value ?? "").trim()).filter(Boolean);
    const state = sessionStore.readTaskState({ taskId: task.taskId, sinceCursor: 0 }) ?? { results: [] };
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

  function recordCompletionClaim({ taskId }) {
    const task = taskById(String(taskId));
    if (!task) return undefined;
    const run = latestRun(task.taskId);
    if (!run) throw new Error("loop_run_not_found");
    const timestamp = now();
    // A delivery claim belongs to the Task's user-facing lifecycle.  The
    // logical Run stays live: native PTYs may remain attached and the
    // Conductor may later make another explicit dispatch.  This is not a
    // hidden route or a Runtime judgment about task correctness.
    // The assignment is also an in-place migration for historical Runs that
    // stored `delivery_ready` on the Run before this ownership distinction.
    db.prepare("UPDATE agent_loop_runs SET status = 'running', updated_at = ? WHERE run_id = ?").run(timestamp, run.runId);
    db.prepare("UPDATE agent_loop_tasks SET status = 'delivery_ready', updated_at = ? WHERE task_id = ?").run(timestamp, task.taskId);
    recordRunEvent({ runId: run.runId, type: "conductor.delivery_claim", summary: "Conductor 已提交当前交付主张；Runtime 已记录此时的语义事实，未裁决内容是否正确。", data: {} });
    return readRun({ runId: run.runId });
  }

  async function recordUserMessage({ taskId, message, data = {} }) {
    const task = required(taskById(required(taskId, "taskId")), "loop_task_not_found");
    if (["achieved", "archived", "stopped"].includes(task.status)) throw new Error("loop_task_is_closed");
    const text = required(message, "user_message");
    const run = latestRun(task.taskId);
    const conductorSessionId = run ? workspaceSessionId(task, "conductor", run) : "";
    const retry = run ? retryableUnconfirmedUserMessage({ task, run, message: text }) : undefined;
    // Retrying a historical false-success is not a second user utterance.
    // Keep one blue user message in Timeline and record a separate transport
    // fact for the retry, so repeated Send clicks do not fabricate a new
    // conversation history.
    const event = recordTaskEvent({
      taskId: task.taskId,
      sessionId: conductorSessionId,
      cwd: task.cwd,
      type: retry ? "task.user_message_retrying" : "task.user_message",
      summary: retry ? "重新提交此前未获 Provider 回执的用户消息。" : text.slice(0, 240),
      data: { ...data, message: text, ...(retry ? { retryOfMessageId: retry.message_id } : {}) },
    });
    const messageId = retry?.message_id ?? `message-${randomUUID()}`;
    const timestamp = now();
    if (retry) {
      // Older builds incorrectly recorded `sent` as `delivered` when the
      // replacement PTY merely started. A user retrying the same text reuses
      // its exact input ID, so the Provider can deduplicate it safely.
      db.prepare("UPDATE agent_loop_user_messages SET status = 'pending', delivered_at = NULL WHERE message_id = ?").run(messageId);
    } else {
      db.prepare(
        "INSERT INTO agent_loop_user_messages (message_id, task_id, run_id, message, status, created_at, delivered_at) VALUES (?, ?, ?, ?, 'pending', ?, NULL)",
      ).run(messageId, task.taskId, run?.runId ?? null, text, timestamp);
    }
    if (run) {
      recordRunEvent({
        runId: run.runId,
        type: retry ? "task.user_message_retrying" : "task.user_message",
        summary: retry ? "重新提交此前未获 Provider 回执的用户消息。" : text,
        data: { messageId, message: text, ...(retry ? { retried: true, retryOfMessageId: retry.message_id } : {}) },
      });
      // Treat a user follow-up as the same durable Conductor-input command as
      // a Runtime wakeup.  It gains an exact Provider marker and survives an
      // Electron restart; Task state does not reopen merely because the UI
      // wrote a row to SQLite.
      recordUserMessageWakeup({
        task,
        run,
        messageId,
        message: text,
        status: "queued",
        retryLegacyUnconfirmed: Boolean(retry),
      });
    }
    const wakeup = await flushPendingUserMessages({ taskId: task.taskId });
    return { ok: true, event, messageId, retried: Boolean(retry), wakeup, taskState: sessionStore.readTaskState({ taskId: task.taskId }) };
  }

  async function respondPermission({ taskId, sessionId, permissionId, response } = {}) {
    const task = required(taskById(required(taskId, "taskId")), "loop_task_not_found");
    if (["achieved", "archived", "stopped"].includes(task.status)) throw new Error("loop_task_is_closed");
    const run = required(latestRun(task.taskId), "loop_run_not_found");
    const allowedSessions = new Set([
      workspaceSessionId(task, "conductor", run),
      ...task.architecture.agentCards.map((card) => workspaceSessionId(task, card.id, run)),
    ]);
    if (!allowedSessions.has(String(sessionId))) throw new Error("loop_permission_session_not_owned_by_task");
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
    const queued = sessionStore.recordPermissionRecoveryPending?.({
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
      sessionStore.recordPermissionRecoveryFailed?.({ taskId: task.taskId, sessionId: targetSessionId, cwd: task.cwd, permissionId: String(permissionId) });
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
    if (["achieved", "archived", "stopped"].includes(task.status)) throw new Error("loop_task_is_closed");
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
      const prior = sessionStore.readQuestionResponse?.({ taskId: task.taskId, sessionId: targetSessionId, cwd: task.cwd, questionId: targetQuestionId });
      if (["submitted", "resolved"].includes(String(prior?.status ?? ""))) {
        return { ok: true, status: String(prior.status), changed: false };
      }
      const state = sessionStore.readTaskState({ taskId: task.taskId, sinceCursor: 0 });
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
      const recorded = sessionStore.recordQuestionResponseSubmitted?.({
        taskId: task.taskId,
        sessionId: targetSessionId,
        cwd: task.cwd,
        questionId: targetQuestionId,
        answer: String(submittedAnswer),
      });
      sessionStore.recordState?.(
        { taskId: task.taskId, sessionId: targetSessionId, cwd: task.cwd },
        "running",
        "已将你对 OpenCode 原生问题的回答写入当前 Session，等待 Provider 继续。",
        { source: "task_question_answer", providerQuestionPartId: targetQuestionId, answerSubmittedAt: now() },
      );
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
      const permissions = sessionStore.readTaskState({ taskId: task.taskId, sinceCursor: 0 }).permissions ?? [];
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
    const recovery = recoverPermissionSessionOnce({ task, run, sessionId, permissionId })
      .finally(() => permissionRecoveryPromises.delete(recoveryKey));
    permissionRecoveryPromises.set(recoveryKey, recovery);
    return recovery;
  }

  async function recoverPermissionSessionOnce({ task, run, sessionId, permissionId }) {
    const conductorSessionId = workspaceSessionId(task, "conductor", run);
    if (sessionId === conductorSessionId) {
      await recoverRun({ taskId: task.taskId, cause: "permission_response" });
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
    sessionStore.recordState?.(
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

  async function flushPendingUserMessages({ taskId }) {
    const task = taskById(String(taskId));
    if (!task) return { delivered: 0, queued: 0, reason: "loop_task_not_found" };
    const pending = db.prepare("SELECT * FROM agent_loop_user_messages WHERE task_id = ? AND status = 'pending' ORDER BY created_at ASC").all(task.taskId);
    if (!pending.length) return { delivered: 0, queued: 0 };
    const run = latestRun(task.taskId);
    if (!run) return { delivered: 0, queued: pending.length, reason: "task_not_started" };
    const conductorSessionId = workspaceSessionId(task, "conductor", run);
    // A previous process may have persisted an input intent, then died while
    // writing its PTY.  The Session Store / Provider observer owns recovery of
    // that exact marker; do not make a second direct write from this helper.
    const durableWakeups = sessionStore.readTaskState({ taskId: task.taskId }).wakeups ?? [];
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
        await recoverRun({ taskId: task.taskId, cause: "user_message" });
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
    const conductorState = sessionStore.readSession?.({ taskId: task.taskId, sessionId: conductorSessionId, maxChars: 0 })?.state;
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
    sessionStore.recordState?.({ taskId: task.taskId, sessionId: conductorSessionId, cwd: task.cwd }, "running", "Runtime delivered user follow-up to Conductor.", { source: "user_message" });
    return {
      delivered: observed.length,
      queued: awaitingProviderReceipt.length,
      delivery: "conductor_wakeup_awaiting_provider_receipt",
    };
  }

  async function ensureConductorWakeupTarget({ taskId, sessionId } = {}) {
    const task = taskById(String(taskId));
    if (!task || ["achieved", "archived", "stopped"].includes(task.status)) return undefined;
    const run = latestRun(task.taskId);
    if (!run || run.status !== "running") return undefined;
    const conductorSessionId = workspaceSessionId(task, "conductor", run);
    if (sessionId && String(sessionId) !== conductorSessionId) return undefined;
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
    // it enters the TUI. In this recovery path there is no active Conductor
    // turn to protect: the only work is the already-durable Worker return.
    // Restore the semantic idle boundary so the Coordinator can deliver that
    // return once Session Authority accepts the terminal input.
    sessionStore.recordState?.(
      { taskId: task.taskId, sessionId: conductorSessionId, cwd: task.cwd },
      "waiting_conductor",
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
    const task = required(taskById(required(taskId, "taskId")), "loop_task_not_found");
    if (["achieved", "archived", "stopped"].includes(task.status)) throw new Error("loop_task_is_closed");
    const run = required(latestRun(task.taskId), "loop_run_not_found");
    const conductorSessionId = workspaceSessionId(task, "conductor", run);
    if (isLiveConductorTerminal(ptyManager.get?.(conductorSessionId))) {
      await flushPendingUserMessages({ taskId: task.taskId });
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

    const timestamp = now();
    db.prepare("UPDATE agent_loop_runs SET status = 'running', updated_at = ? WHERE run_id = ?").run(timestamp, run.runId);
    for (const item of pending) {
      // The recovery TUI receives the preserved input through Terminal Runtime,
      // but its success remains unconfirmed until the Provider records the
      // exact marker.
      // Do not turn a start race into a permanent false `sent` state.
      db.prepare("UPDATE agent_loop_user_messages SET run_id = ? WHERE message_id = ?").run(run.runId, item.message_id);
    }
    recordRunEvent({ runId: run.runId, type: "conductor.recovered", summary: "Runtime 已续接当前 Task Run；新的 Conductor 终端会读取保留的 Task 历史和待发送消息。", data: { conductorSessionId, cause, pendingMessageIds: pending.map((item) => item.message_id) } });
    recordTaskEvent({ taskId: task.taskId, sessionId: conductorSessionId, cwd: task.cwd, type: "task.run.recovered", summary: "继续任务时原 Conductor 不可用；Runtime 已启动新的终端实例并保留当前 Task Run。", data: { runId: run.runId, conductorSessionId, cause } });
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
    const current = runById(run.runId);
    if (!current || ["stopped", "achieved", "failed"].includes(current.status)) return current;
    if (current.status === "recovery_required") return current;
    const timestamp = now();
    db.prepare("UPDATE agent_loop_runs SET status = 'recovery_required', updated_at = ? WHERE run_id = ?").run(timestamp, run.runId);
    recordRunEvent({ runId: run.runId, type: "conductor.recovery_required", summary: "原 Conductor 终端不可用；Runtime 已保留待处理消息，下一次发送会自动尝试续接。", data: { reason: String(reason || "conductor_terminal_unavailable") } });
    recordTaskEvent({ taskId: task.taskId, sessionId: workspaceSessionId(task, "conductor", run), cwd: task.cwd, type: "task.run.recovery_required", summary: "当前 Run 的终端暂不可用；继续发送会自动尝试续接。", data: { runId: run.runId, reason: String(reason || "conductor_terminal_unavailable") } });
    return runById(run.runId);
  }

  function listConductorWakeupTargets() {
    return listTasks()
      .filter((task) => ["running", "delivery_ready"].includes(task.status) && task.latestRun?.status === "running")
      .map((task) => ({
        taskId: task.taskId,
        sessionId: workspaceSessionId(task, "conductor", task.latestRun),
      }));
  }

  function recordUserMessageWakeup({ task, run, messageId, message, status, retryLegacyUnconfirmed = false }) {
    const sessionId = workspaceSessionId(task, "conductor", run);
    return sessionStore.recordConductorWakeup({
      taskId: task.taskId,
      sessionId,
      wakeupKey: userMessageWakeupKey(task.taskId, messageId),
      kind: "user_message",
      userMessageId: messageId,
      messageText: message,
      status,
      retryLegacyUnconfirmed,
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
    const wakeup = (sessionStore.readTaskState?.({ taskId: task.taskId })?.wakeups ?? [])
      .find((entry) => entry.wakeupKey === wakeupKey);
    // `sent` without a receipt is the exact legacy false-success state. The
    // current code never writes this state for user messages.
    if (wakeup?.status !== "sent" || wakeup.providerMessageId || wakeup.observedAt) return undefined;
    if (String(wakeup.sessionId ?? "") !== workspaceSessionId(task, "conductor", run)) return undefined;
    return candidate;
  }

  function markTaskAchieved({ taskId }) {
    const task = required(taskById(required(taskId, "taskId")), "loop_task_not_found");
    if (task.status === "achieved") return task;
    if (!["running", "delivery_ready"].includes(task.status)) throw new Error("loop_task_not_achievable");
    const timestamp = now();
    db.prepare("UPDATE agent_loop_tasks SET status = 'achieved', updated_at = ? WHERE task_id = ?").run(timestamp, task.taskId);
    const run = latestRun(task.taskId);
    if (run) {
      db.prepare("UPDATE agent_loop_runs SET status = 'achieved', updated_at = ? WHERE run_id = ?").run(timestamp, run.runId);
      recordRunEvent({ runId: run.runId, type: "task.achieved", summary: "用户已确认当前交付，Task 进入 achieved 历史。", data: {} });
    }
    recordTaskEvent({ taskId: task.taskId, cwd: task.cwd, type: "task.achieved", summary: "用户已确认当前 Task 完成。", data: { runId: run?.runId } });
    return taskById(task.taskId);
  }

  async function stopTask({ taskId }) {
    const task = required(taskById(required(taskId, "taskId")), "loop_task_not_found");
    if (task.status === "stopped") return task;
    if (!["running", "delivery_ready"].includes(task.status)) throw new Error("loop_task_not_stoppable");
    const run = latestRun(task.taskId);
    if (!run) throw new Error("loop_run_not_found");
    await stopRunSessions({ task, run });
    const timestamp = now();
    db.prepare("UPDATE agent_loop_runs SET status = 'stopped', updated_at = ? WHERE run_id = ?").run(timestamp, run.runId);
    db.prepare("UPDATE agent_loop_tasks SET status = 'stopped', updated_at = ? WHERE task_id = ?").run(timestamp, task.taskId);
    recordRunEvent({ runId: run.runId, type: "task.stopped", summary: "用户已停止当前 Task Run；原生 Session 已停止并保留历史。", data: {} });
    recordTaskEvent({ taskId: task.taskId, cwd: task.cwd, type: "task.stopped", summary: "用户已停止当前 Task；可稍后启动新的 Run。", data: { runId: run.runId } });
    return taskById(task.taskId);
  }

  async function deleteTask({ taskId }) {
    const task = required(taskById(required(taskId, "taskId")), "loop_task_not_found");
    const runs = db.prepare("SELECT * FROM agent_loop_runs WHERE task_id = ? ORDER BY created_at ASC").all(task.taskId).map(deserializeRun);
    for (const run of runs) await stopRunSessions({ task, run });
    // Terminal ownership is private to the authority. It is released only
    // after the PTY exit fact, before the Runtime directories are removed.
    sessionAuthority.releaseTask?.({ taskId: task.taskId });
    const runIds = runs.map((run) => run.runId);
    db.exec("BEGIN IMMEDIATE");
    try {
      if (runIds.length) {
        const placeholders = runIds.map(() => "?").join(", ");
        db.prepare(`DELETE FROM agent_loop_workbench_layouts WHERE run_id IN (${placeholders})`).run(...runIds);
        db.prepare(`DELETE FROM agent_loop_events WHERE run_id IN (${placeholders})`).run(...runIds);
      }
      db.prepare("DELETE FROM agent_loop_user_messages WHERE task_id = ?").run(task.taskId);
      db.prepare("DELETE FROM agent_loop_runs WHERE task_id = ?").run(task.taskId);
      db.prepare("DELETE FROM agent_loop_tasks WHERE task_id = ?").run(task.taskId);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    const storeResult = sessionStore.deleteTask?.({ taskId: task.taskId, cwd: task.cwd }) ?? { runtimeDirectoryRemoved: false };
    return {
      deleted: true,
      taskId: task.taskId,
      runsDeleted: runs.length,
      runtimeDirectoryRemoved: Boolean(storeResult.runtimeDirectoryRemoved),
    };
  }

  function listTasks() {
    return db.prepare("SELECT * FROM agent_loop_tasks ORDER BY updated_at DESC").all().map(deserializeTask).map((task) => ({ ...task, latestRun: latestRun(task.taskId) }));
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
    const allSessionState = sessionStore.readTaskState({ taskId: task.taskId, sinceCursor: 0 }) ?? { sessions: [], dispatches: [], results: [], pendingDecisions: [], messages: [] };
    const runSessionIds = new Set([
      workspaceSessionId(task, "conductor", run),
      ...task.architecture.agentCards.map((card) => workspaceSessionId(task, card.id, run)),
    ]);
    const sessionState = {
      ...allSessionState,
      sessions: (allSessionState.sessions ?? []).filter((item) => runSessionIds.has(String(item.sessionId ?? ""))),
      dispatches: (allSessionState.dispatches ?? []).filter((item) => runSessionIds.has(String(item.toSessionId ?? ""))),
      results: (allSessionState.results ?? []).filter((item) => runSessionIds.has(String(item.sessionId ?? ""))),
      messages: (allSessionState.messages ?? []).filter((item) => String(item.sessionId ?? "") === workspaceSessionId(task, "conductor", run)),
      pendingDecisions: (allSessionState.pendingDecisions ?? []).filter((item) => runSessionIds.has(String(item.sessionId ?? ""))),
    };
    const cards = [
      { id: "conductor", name: task.architecture.template.conductor.role, role: "Conductor", model: task.architecture.defaultModel, mcp: ["agent_workspace_conductor"], skills: [], kind: "conductor" },
      ...task.architecture.agentCards,
    ].filter((card) => {
      if (card.id === "conductor") return true;
      const sessionId = workspaceSessionId(task, card.id, run);
      // Registering a launch profile is not a Session.  A worker enters the
      // Run workspace only after the Conductor has actually dispatched it (or
      // after a restored runtime has durable Session/PTY/result evidence).
      return sessionState.sessions.some((item) => item.sessionId === sessionId)
        || sessionState.dispatches.some((item) => item.toSessionId === sessionId)
        || sessionState.results.some((item) => item.sessionId === sessionId)
        || Boolean(ptyManager.read(sessionId, 0));
    });
    const turns = cards.map((card) => {
      const sessionId = workspaceSessionId(task, card.id, run);
      const state = sessionState.sessions.find((item) => item.sessionId === sessionId);
      const terminal = ptyManager.read(sessionId, 0);
      const dispatches = sessionState.dispatches.filter((item) => item.toSessionId === sessionId);
      const sessionView = sessionStore.readSession?.({ taskId: task.taskId, sessionId, maxChars: 0 });
      const result = sessionView?.results?.at(-1);
      const dispatchStatus = String(dispatches.at(-1)?.status ?? "not_dispatched");
      return {
        turnId: `${run.runId}:${card.id}`,
        runId: run.runId,
        instanceId: run.runId,
        nodeId: card.id,
        sessionId,
        purpose: card.id === "conductor" ? "conductor" : "session_agent",
        // PTY lifecycle and semantic dispatch state have different owners.
        // Never use a long-lived OpenCode TUI to turn a completed Provider
        // result back into a "running" assignment.
        status: mapSessionStatus(state?.state),
        // No Host record after a durable dispatch is different from a card
        // that Conductor has never dispatched. This commonly happens after a
        // native Session exits or an Electron restart; the UI must not offer
        // the misleading "waiting to be dispatched" empty state in that case.
        terminalStatus: terminal?.status === "running"
          ? "live"
          : terminal?.status ?? (dispatchStatus === "not_dispatched" ? "not_started" : "not_live"),
        dispatchStatus,
        output: result?.answerText ? { answerText: result.answerText } : undefined,
        details: { card, dispatches, runtimeState: state?.state },
        terminal,
        startedAt: run.createdAt,
      completedAt: result?.completedAt,
      };
    });
    const workbenchLayout = ensureWorkbenchLayout({ runId: run.runId, knownSessionIds: turns.map((turn) => turn.sessionId) });
    const conductorSessionId = workspaceSessionId(task, "conductor", run);
    const conductorTerminal = ptyManager.get?.(conductorSessionId) ?? ptyManager.read(conductorSessionId, 0);
    return {
      task,
      run,
      instances: [{ instanceId: run.runId, kind: "agent_loop", status: run.status, phase: run.status, details: { template: task.architecture.template } }],
      workflow: undefined,
      nodes: [],
      turns,
      artifacts: listArtifacts(task),
      attentions: sessionState.pendingDecisions ?? [],
      events: listRunEvents(run.runId),
      runtimeState: sessionState,
      workbenchLayout,
      continuity: projectConductorContinuity({ runStatus: run.status, terminal: conductorTerminal }),
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

  function ensureWorkbenchLayout({ runId, knownSessionIds }) {
    const row = db.prepare("SELECT layout_json FROM agent_loop_workbench_layouts WHERE run_id = ?").get(runId);
    let parsed;
    try {
      parsed = row?.layout_json ? JSON.parse(row.layout_json) : undefined;
    } catch {
      parsed = undefined;
    }
    const normalized = normalizeWorkbenchLayout(parsed, knownSessionIds);
    const serialized = JSON.stringify(normalized);
    if (!row || row.layout_json !== serialized) writeWorkbenchLayout({ runId, knownSessionIds, layout: normalized });
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
    const row = db.prepare("SELECT * FROM agent_loop_tasks WHERE task_id = ?").get(taskId);
    if (!row) return undefined;
    const task = deserializeTask(row);
    // The SQLite Task owns cwd across Electron restarts. Restore that fact in
    // the Session Store before any run/session read that only carries taskId.
    sessionStore.bindTaskRoot?.({ taskId: task.taskId, cwd: task.cwd });
    return task;
  }

  function latestRun(taskId) {
    const row = db.prepare("SELECT * FROM agent_loop_runs WHERE task_id = ? ORDER BY created_at DESC LIMIT 1").get(taskId);
    return row ? deserializeRun(row) : undefined;
  }

  function runById(runId) {
    const row = db.prepare("SELECT * FROM agent_loop_runs WHERE run_id = ?").get(runId);
    return row ? deserializeRun(row) : undefined;
  }

  function recordRunEvent({ runId, type, summary, data }) {
    const sequence = Number(db.prepare("SELECT MAX(sequence) AS sequence FROM agent_loop_events WHERE run_id = ?").get(runId)?.sequence ?? 0) + 1;
    db.prepare("INSERT INTO agent_loop_events (run_id, sequence, type, summary, data_json, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(runId, sequence, type, summary, JSON.stringify(data ?? {}), now());
  }

  function listRunEvents(runId) {
    return db.prepare("SELECT * FROM agent_loop_events WHERE run_id = ? ORDER BY sequence ASC").all(runId).map((row) => ({ runId: row.run_id, sequence: Number(row.sequence), type: row.type, summary: row.summary, data: JSON.parse(row.data_json), createdAt: row.created_at }));
  }

  function recordTaskEvent(input) {
    return sessionStore.recordTaskEvent(input);
  }

  async function stopRunSessions({ task, run }) {
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

  function close() { db.close(); }

  return {
    listTemplates,
    templateById,
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
    markTaskAchieved,
    stopTask,
    deleteTask,
    recordUserMessage,
    respondPermission,
    respondSessionQuestion,
    resumePendingPermissionRecoveries,
    recoverRun,
    flushPendingUserMessages,
    ensureConductorWakeupTarget,
    listConductorWakeupTargets,
    recordCompletionClaim,
    validateDispatch,
    resumeTaskForDispatch,
    resumeTaskForConductorInput,
    prepareDispatchContext,
    resolveAgentSession,
    prepareWorkerInitialDispatch,
    taskAgentMap,
    hasTask,
    close,
  };
}

function agentCard(input = {}) {
  const id = safeSegment(input.id || input.name || "agent");
  return {
    id,
    name: required(input.name || id, "agent.name").slice(0, 80),
    kind: normalizeAgentCardKind(input.kind, input),
    role: String(input.role || "Session Agent").trim().slice(0, 300),
    model: String(input.model || DEFAULT_MODEL),
    mcp: normalizeAllowlist(input.mcp),
    skills: normalizeAllowlist(input.skills),
    instructions: String(input.instructions || "").trim().slice(0, 2000),
    expectedOutput: String(input.expectedOutput || "").trim().slice(0, 600),
  };
}

function normalizeTemplate(input) {
  const id = safeSegment(input?.id || input?.name || "agent-loop");
  const agents = Array.isArray(input?.agents) ? input.agents.map(agentCard) : [];
  if (!agents.length) throw new Error("loop_template_requires_agent_card");
  if (new Set(agents.map((item) => item.id)).size !== agents.length) throw new Error("loop_template_agent_card_id_duplicate");
  const limits = input?.limits && typeof input.limits === "object" ? input.limits : {};
  const declaredArtifact = String(input?.delivery?.artifactPath || "").trim();
  const delivery = normalizeDelivery({
    artifactPath: declaredArtifact,
    ownerAgentId: input?.delivery?.ownerAgentId,
  }, agents);
  return {
    id,
    name: required(input?.name, "template.name").slice(0, 120),
    source: ["seed", "generated", "manual"].includes(String(input?.source)) ? String(input.source) : "manual",
    conductor: {
      role: String(input?.conductor?.role || "Conductor").trim().slice(0, 100),
      model: String(input?.conductor?.model || DEFAULT_MODEL),
      charter: String(input?.conductor?.charter || input?.conductor?.instructions || "").trim().slice(0, 6000),
    },
    agents,
    limits: {
      maxConcurrentSessions: boundedInt(limits.maxConcurrentSessions, 3, 1, 8),
      maxDispatchesPerDecision: boundedInt(limits.maxDispatchesPerDecision, 3, 1, 8),
    },
    delivery,
  };
}

function conductorPrompt(task) {
  const template = task.architecture.template;
  const cards = task.architecture.agentCards.map((card) => [
    `- ${card.name} (agentId: ${card.id}, responsibility: ${card.kind}): ${card.role}`,
    `  Model: ${card.model}`,
    `  Native MCP scope: ${card.mcp.length ? card.mcp.join(", ") : "all provider-native MCP available in this project"}`,
    `  Native Skills scope: ${card.skills.length ? card.skills.join(", ") : "all provider-native Skills available in this project"}`,
    card.instructions ? `  Card instructions: ${card.instructions}` : "",
    card.expectedOutput ? `  Default expected output: ${card.expectedOutput}` : "",
  ].filter(Boolean).join("\n")).join("\n");
  return [
    "You are the task-owner Conductor for Agent Workspace Agent Loop v1.",
    "You are the only Workspace Session that has Agent Workspace MCP tools. All worker Sessions are normal native OpenCode terminals; do not require them to know Workspace protocol.",
    "Runtime owns PTY lifecycle, provider-state extraction, artifacts, and wakeups. You own task reasoning and dispatch choices.",
    "Task lifecycle is outside your authority. Never claim that you stopped or restarted a Task, created a new Run, or resumed an old native Session. A user Timeline message that mentions restart is ordinary task feedback, not a Runtime command: you may choose a new dispatch in the current Run, or tell the user to use the Task Stop and Restart controls when they need a fresh Run.",
    "You are capability-constrained to the Agent Workspace MCP and user questions. You cannot read, edit, create, patch, or run shell commands against Task files. Never try to bypass this boundary; a native Session Agent owns every workspace artifact change.",
    "Every worker Session is dispatched by you through call_session or call_sessions using the approved stable agentId, never a physical session identifier. Each dispatch must state a bounded goal, relevant inputs, acceptance criteria, and expected artifact/output; it must stay within that Agent card's declared native capability scope.",
    "When a later native Session depends on any completed Session's findings, conclusion, critique, or other semantic answer, you MUST select that complete answer in contextRefs as result:<resultId> from read_task_state. Runtime will copy the selected Provider answer verbatim into the target assignment and persist the snapshot; an artifact path may supplement the handoff but never replace it. Do not paraphrase it merely to relay it. Never pass raw terminal transcripts or physical Session IDs. contextRefs remain empty only when the new Session is genuinely independent of prior Session answers.",
    "A native Session answer is complete semantic material, not a Runtime verdict. A Reviewer's `pass`, `needs changes`, or critique is ordinary natural-language content in its completed Provider answer. When a review identifies a factual, source, date, coverage, or contradiction gap, do not turn it into an editorial repair brief for Publisher: read the full durable result and decide whether an evidence-capable card should investigate it. If you choose that work, pass the exact Review result with contextRefs. When you judge selected evidence and review material sufficient for a deliverable, pass those selected result:<resultId> materials to Publisher. contextRefs are optional: use them only when the target needs that prior material.",
    "Use read_task_state at the beginning of a decision. You may issue zero, one, or many asynchronous dispatches, then either continue reasoning or end the Provider turn. Do not poll worker terminals while work is pending: Runtime will wake you from provider-derived result, failure, attention, or user-message facts.",
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
    "Approved native Session Agent cards:",
    cards,
  ].join("\n");
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

function templateSnapshot(template) {
  return { id: template.id, version: template.version, name: template.name, conductor: template.conductor, agents: template.agents, limits: template.limits, delivery: template.delivery };
}

function deserializeTemplate(row) {
  const conductor = JSON.parse(row.conductor_json);
  return {
    id: row.template_id,
    version: Number(row.version),
    name: row.name,
    source: row.source,
    conductor: {
      ...conductor,
      charter: String(conductor?.charter || conductor?.instructions || "").trim(),
    },
    agents: JSON.parse(row.agents_json).map(agentCard),
    limits: JSON.parse(row.limits_json),
    delivery: normalizeStoredDelivery(JSON.parse(row.delivery_json)),
    archivedAt: row.archived_at || undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function deserializeTask(row) {
  const architecture = JSON.parse(row.architecture_json);
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
  return { taskId: row.task_id, projectId: row.project_id, cwd: row.cwd, title: row.title, goal: row.goal, architecture, status: row.status, createdAt: row.created_at, updatedAt: row.updated_at };
}

function deserializeRun(row) {
  return {
    runId: row.run_id,
    taskId: row.task_id,
    status: row.status,
    conductorSessionId: row.conductor_session_id,
    sessionScope: String(row.session_scope ?? ""),
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

function normalizeAgentCardKind(value, input = {}) {
  const requested = String(value || "").trim().toLowerCase();
  if (AGENT_CARD_KINDS.has(requested)) return requested;
  const description = `${input.id || ""} ${input.name || ""} ${input.role || ""} ${input.instructions || ""}`.toLowerCase();
  if (/(review|reviewer|validator|审查|校验|验收)/i.test(description)) return "reviewer";
  if (/(publish|publisher|consolidat|writer|author|synthesi[sz]|交付|整合|汇总|发布|撰写)/i.test(description)) return "publisher";
  if (/(research|search|analyst|researcher|调研|搜索|研究|分析)/i.test(description)) return "researcher";
  return "general";
}

function normalizeDelivery(input = {}) {
  const originalPath = String(input.artifactPath || "").trim();
  const ownerAgentId = String(input.ownerAgentId || "").trim();
  if (!originalPath) return { artifactPath: "", ownerAgentId };
  const artifactPath = normalizeArtifactPath(originalPath);
  return { artifactPath, ownerAgentId };
}

function normalizeStoredDelivery(input = {}) {
  return {
    artifactPath: String(input?.artifactPath || "").trim(),
    ownerAgentId: String(input?.ownerAgentId || "").trim(),
  };
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
    `Task id: ${task.taskId}`,
    `Task: ${task.title}`,
    "You are the Conductor. Read your configured instructions and durable Runtime state, then make the next decision.",
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

function mapSessionStatus(state) {
  if (["blocked", "result_invalid", "delivery_failed", "start_failed"].includes(String(state))) return "failed";
  if (["result_available", "ready"].includes(String(state))) return "succeeded";
  if (["running", "queued", "delivered_pending"].includes(String(state))) return "running";
  return "pending";
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
  const groupIds = ids.length <= 1 ? ["primary"] : ids.length === 2 ? ["primary", "group-1"] : ids.length === 3 ? ["primary", "group-1", "group-2"] : ["primary", "group-1", "group-2", "group-3"];
  const root = groupIds.length === 1
    ? { type: "leaf", groupId: "primary" }
    : groupIds.length === 2
      ? { type: "split", direction: "horizontal", ratio: .5, first: { type: "leaf", groupId: "primary" }, second: { type: "leaf", groupId: "group-1" } }
      : groupIds.length === 3
        ? { type: "split", direction: "horizontal", ratio: .5, first: { type: "leaf", groupId: "primary" }, second: { type: "split", direction: "vertical", ratio: .5, first: { type: "leaf", groupId: "group-1" }, second: { type: "leaf", groupId: "group-2" } } }
        : { type: "split", direction: "horizontal", ratio: .5, first: { type: "split", direction: "vertical", ratio: .5, first: { type: "leaf", groupId: "primary" }, second: { type: "leaf", groupId: "group-1" } }, second: { type: "split", direction: "vertical", ratio: .5, first: { type: "leaf", groupId: "group-2" }, second: { type: "leaf", groupId: "group-3" } } };
  const groups = Object.fromEntries(groupIds.map((id) => [id, { id, sessionIds: [], fontSize: normalizeTerminalFontSize(sourceGroups[id]?.fontSize) }]));
  ids.forEach((sessionId, index) => groups[groupIds[index % groupIds.length]].sessionIds.push(sessionId));
  for (const group of Object.values(groups)) {
    group.activeSessionId = group.sessionIds.includes(sourceGroups[group.id]?.activeSessionId) ? sourceGroups[group.id]?.activeSessionId : group.sessionIds[0];
  }
  return {
    version: 1,
    placementMode: "auto",
    root,
    groups,
    focusedGroupId: "primary",
  };
}

function normalizeWorkbenchLayout(input, knownSessionIds = []) {
  const known = uniqueStrings(knownSessionIds);
  if (!input || typeof input !== "object") return defaultWorkbenchLayout(known);
  const sourceGroups = input.groups && typeof input.groups === "object" ? input.groups : {};
  if (input.placementMode === "auto") return automaticWorkbenchLayout(known, sourceGroups);
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
  return { version: 1, placementMode: "manual", root, groups, focusedGroupId };
}

function uniqueStrings(value) { return [...new Set((Array.isArray(value) ? value : []).map((item) => String(item || "").trim()).filter(Boolean))]; }
function isWorkbenchGroupId(value) { return /^[A-Za-z0-9_-]{1,80}$/.test(value); }
function normalizeTerminalFontSize(value) { const size = Number(value); return Number.isFinite(size) ? Math.min(18, Math.max(8, Math.round(size))) : 11; }

function normalizeAllowlist(value) { return Array.isArray(value) ? [...new Set(value.map((item) => String(item).trim()).filter(Boolean))] : []; }
function boundedInt(value, fallback, min, max) { const number = Number(value); return Number.isInteger(number) && number >= min && number <= max ? number : fallback; }
function required(value, field) { if (value === undefined || value === null || String(value).trim() === "") throw new Error(`Agent Loop Runtime requires ${field}.`); return value; }
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
      archived_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (template_id, version)
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

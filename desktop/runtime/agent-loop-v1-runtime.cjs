const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

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
  generateTemplateFromDescription,
  registerProviderHook,
  enqueueConductorInput,
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
  migrate(db);
  ensureSeedTemplate();

  function ensureSeedTemplate() {
    if (templateById(DEFAULT_TEMPLATE_ID)) return;
    saveTemplate({
      id: DEFAULT_TEMPLATE_ID,
      name: "OpenCode Agent Loop",
      description: "Conductor asynchronously dispatches native OpenCode Session Agents and decides again after every semantic Runtime return.",
      source: "seed",
      conductor: {
        role: "Conductor",
        model: DEFAULT_MODEL,
        charter: "Own the task conversation and decide each next dispatch from durable Session returns and user follow-ups. Use independent investigation, synthesis, or critique when useful; never assume a fixed sequence, number of agents, or review loop.",
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
       (template_id, version, name, description, source, conductor_json, agents_json, limits_json, delivery_json, archived_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
    ).run(
      normalized.id,
      version,
      normalized.name,
      normalized.description,
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
    if (typeof generateTemplateFromDescription !== "function") throw new Error("agent_loop_template_generation_unavailable");
    const generated = await generateTemplateFromDescription({
      cwd: required(input?.cwd, "cwd"),
      projectName: input?.projectName ? String(input.projectName) : undefined,
      description: required(input?.description, "description"),
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
    if (task.status === "achieved" || task.status === "archived") throw new Error("loop_task_is_closed");
    if (latestRun(task.taskId)?.status === "running") throw new Error("loop_run_already_running");
    const runId = `run-${randomUUID()}`;
    const timestamp = now();
    db.prepare("INSERT INTO agent_loop_runs (run_id, task_id, status, conductor_session_id, created_at, updated_at) VALUES (?, ?, 'running', ?, ?, ?)").run(
      runId,
      task.taskId,
      workspaceSessionId(task, "conductor"),
      timestamp,
      timestamp,
    );
    db.prepare("UPDATE agent_loop_tasks SET status = 'running', updated_at = ? WHERE task_id = ?").run(timestamp, task.taskId);
    // A Task Run owns its terminal workspace.  Start with the Conductor in the
    // primary Group; worker Groups only gain a tab after a real Conductor
    // dispatch has materialized a native Session.
    writeWorkbenchLayout({
      runId,
      knownSessionIds: [workspaceSessionId(task, "conductor")],
      layout: defaultWorkbenchLayout([workspaceSessionId(task, "conductor")]),
    });
    await startConductor({ task, runId });
    recordRunEvent({ runId, type: "conductor.started", summary: "Conductor 已启动，等待其异步派发原生 Session Agent。", data: { sessionId: workspaceSessionId(task, "conductor") } });
    recordTaskEvent({ taskId: task.taskId, cwd: task.cwd, type: "task.run.started", summary: "Agent Loop 已启动；Conductor 正在形成首次派发决策。", data: { runId } });
    return readRun({ runId });
  }

  async function startConductor({ task, runId }) {
    const sessionId = workspaceSessionId(task, "conductor");
    const bridge = await getConductorBridgeConfig();
    if (!bridge?.conductorToolBridgeUrl || !bridge?.conductorToolBridgeToken || !bridge?.conductorMcpServerPath) {
      throw new Error("conductor_bridge_not_ready");
    }
    const systemPrompt = conductorPrompt(task);
    const runtimeRoot = `.agent-workspace/runtime/${safeSegment(task.taskId)}/conductor`;
    const providerHook = await registerNativeProviderHook({ sessionId, cwd: task.cwd });
    sessionAuthority.registerLaunchProfile({
      workspaceSessionId: sessionId,
      taskId: task.taskId,
      command: opencodePath,
      args: [
        "--agent",
        "agent_workspace_conductor",
        "--model",
        task.architecture.defaultModel,
        "--prompt",
        [
          "Start this Agent Workspace task now.",
          `Task id: ${task.taskId}`,
          `Task: ${task.title}`,
          "You are the Conductor. Read your configured instructions, inspect Runtime state, then make the next decision.",
        ].join("\n"),
      ],
      cwd: task.cwd,
      provider: "opencode",
      model: task.architecture.defaultModel,
      cols: 100,
      rows: 30,
      stdin: "pipe",
      requirePty: true,
      runtimeFiles: [{ relativePath: `${runtimeRoot}/system.md`, contents: systemPrompt }],
      env: {
        ...providerHook.env,
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
    await sessionAuthority.activateSession({ workspaceSessionId: sessionId, operationId: `loop:${runId}:conductor`, callerId: "agent-loop-runtime", reason: "conductor-start" });
    sessionStore.recordState?.(
      { taskId: task.taskId, sessionId, cwd: task.cwd },
      "running",
      "Conductor initial decision is active.",
      { runId, source: "agent-loop-runtime" },
    );
  }

  async function registerWorkerProfile({ task, card, initialPrompt } = {}) {
    const sessionId = workspaceSessionId(task, card.id);
    const providerHook = await registerNativeProviderHook({ sessionId, cwd: task.cwd });
    sessionAuthority.registerLaunchProfile({
      workspaceSessionId: sessionId,
      taskId: task.taskId,
      command: opencodePath,
      args: initialPrompt ? ["--model", card.model, "--prompt", String(initialPrompt)] : ["--model", card.model],
      cwd: task.cwd,
      provider: "opencode",
      model: card.model,
      cols: 100,
      rows: 30,
      stdin: "pipe",
      requirePty: true,
      ...(Object.keys(providerHook.env).length ? { env: providerHook.env } : {}),
      // Deliberately no Workspace MCP, runtime files, or system prompt.
    });
    return sessionId;
  }

  function resolveAgentSession({ taskId, agentId }) {
    const task = taskById(String(taskId));
    if (!task) return undefined;
    if (String(agentId) === "conductor") {
      return {
        agentId: "conductor",
        sessionId: workspaceSessionId(task, "conductor"),
        card: { id: "conductor", name: task.architecture.template.conductor.role, role: "Conductor", model: task.architecture.defaultModel },
      };
    }
    const card = task.architecture.agentCards.find((item) => item.id === String(agentId));
    if (!card) return undefined;
    return { agentId: card.id, sessionId: workspaceSessionId(task, card.id), card };
  }

  async function prepareWorkerInitialDispatch({ taskId, agentId, sessionId, initialPrompt }) {
    const task = required(taskById(String(taskId)), "loop_task_not_found");
    const resolved = required(resolveAgentSession({ taskId: task.taskId, agentId }), "loop_agent_card_not_found");
    if (resolved.agentId === "conductor" || resolved.sessionId !== String(sessionId)) {
      throw new Error("loop_worker_dispatch_target_invalid");
    }
    const live = ptyManager.get?.(resolved.sessionId);
    if (live?.status === "running") return { initialPromptSubmitted: false, sessionId: resolved.sessionId };
    await registerWorkerProfile({
      task,
      card: resolved.card,
      initialPrompt: required(initialPrompt, "loop_worker_initial_prompt"),
    });
    return { initialPromptSubmitted: true, sessionId: resolved.sessionId };
  }

  async function registerNativeProviderHook({ sessionId, cwd }) {
    if (typeof registerProviderHook !== "function") return { env: {} };
    const registration = await registerProviderHook({ sessionId, cwd });
    return { env: registration?.env && typeof registration.env === "object" ? registration.env : {} };
  }

  function taskAgentMap({ taskId }) {
    const task = taskById(String(taskId));
    if (!task) return {};
    return Object.fromEntries([
      [workspaceSessionId(task, "conductor"), "conductor"],
      ...task.architecture.agentCards.map((card) => [workspaceSessionId(task, card.id), card.id]),
    ]);
  }

  function validateDispatch({ taskId, agentId, toSessionId }) {
    const task = taskById(String(taskId));
    // A delivery claim is a user-facing claim, not a permanent execution
    // closure.  The Conductor may discover a new need and explicitly dispatch
    // again; the bridge will record that continuation before materializing the
    // worker Session.  Only a user-achieved/archived Task is closed.
    if (!task || !["running", "delivery_ready"].includes(task.status)) {
      return { ok: false, reason: "loop_task_not_dispatchable" };
    }
    const resolved = resolveAgentSession({ taskId, agentId });
    const allowed = new Set(task.architecture.agentCards.map((card) => workspaceSessionId(task, card.id)));
    if (!resolved || resolved.sessionId !== String(toSessionId) || !allowed.has(String(toSessionId))) {
      return { ok: false, reason: "loop_target_not_in_confirmed_agent_cards" };
    }
    return { ok: true };
  }

  function resumeTaskForDispatch({ taskId }) {
    const task = required(taskById(required(taskId, "taskId")), "loop_task_not_found");
    if (task.status === "achieved" || task.status === "archived") throw new Error("loop_task_is_closed");
    const run = required(latestRun(task.taskId), "loop_run_not_found");
    if (task.status !== "delivery_ready") return readRun({ runId: run.runId });

    const timestamp = now();
    // New Runs never leave `running` for a delivery claim. Normalize an older
    // persisted pre-fix Run here only because the Conductor explicitly chose
    // to continue it; this is lifecycle compatibility, not route selection.
    db.prepare("UPDATE agent_loop_runs SET status = 'running', updated_at = ? WHERE run_id = ?").run(timestamp, run.runId);
    db.prepare("UPDATE agent_loop_tasks SET status = 'running', updated_at = ? WHERE task_id = ?").run(timestamp, task.taskId);
    recordRunEvent({
      runId: run.runId,
      type: "task.continued",
      summary: "Conductor 在交付主张后发起新的原生 Session 派发；Task 回到运行中。",
      data: { cause: "conductor_dispatch_after_delivery_claim" },
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
    const artifactPath = configuredArtifactPath(task);
    const timestamp = now();
    // A delivery claim belongs to the Task's user-facing lifecycle.  The
    // logical Run stays live: native PTYs may remain attached and the
    // Conductor may later make another explicit dispatch.  This is not a
    // hidden route or a Runtime judgment about task correctness.
    // The assignment is also an in-place migration for historical Runs that
    // stored `delivery_ready` on the Run before this ownership distinction.
    db.prepare("UPDATE agent_loop_runs SET status = 'running', updated_at = ? WHERE run_id = ?").run(timestamp, run.runId);
    db.prepare("UPDATE agent_loop_tasks SET status = 'delivery_ready', updated_at = ? WHERE task_id = ?").run(timestamp, task.taskId);
    recordRunEvent({ runId: run.runId, type: "conductor.delivery_claim", summary: "Conductor 已提交交付主张；Runtime 已记录声明的产物路径与当前事实，未裁决内容是否正确。", data: { artifactPath } });
    return readRun({ runId: run.runId });
  }

  async function recordUserMessage({ taskId, message, data = {} }) {
    const task = required(taskById(required(taskId, "taskId")), "loop_task_not_found");
    const text = required(message, "user_message");
    const run = latestRun(task.taskId);
    const conductorSessionId = workspaceSessionId(task, "conductor");
    const event = recordTaskEvent({
      taskId: task.taskId,
      sessionId: conductorSessionId,
      cwd: task.cwd,
      type: "task.user_message",
      summary: text.slice(0, 240),
      data: { ...data, message: text },
    });
    const messageId = `message-${randomUUID()}`;
    const timestamp = now();
    db.prepare(
      "INSERT INTO agent_loop_user_messages (message_id, task_id, run_id, message, status, created_at, delivered_at) VALUES (?, ?, ?, ?, 'pending', ?, NULL)",
    ).run(messageId, task.taskId, run?.runId ?? null, text, timestamp);
    if (run) {
      recordRunEvent({ runId: run.runId, type: "task.user_message", summary: text, data: { messageId, message: text } });
      if (task.status === "achieved" || task.status === "delivery_ready") {
        db.prepare("UPDATE agent_loop_runs SET status = 'running', updated_at = ? WHERE run_id = ?").run(timestamp, run.runId);
        db.prepare("UPDATE agent_loop_tasks SET status = 'running', updated_at = ? WHERE task_id = ?").run(timestamp, task.taskId);
        recordRunEvent({ runId: run.runId, type: "task.continued", summary: "用户发起后续对话；Task 回到 Conductor 决策中。", data: { messageId } });
      }
    }
    const wakeup = await flushPendingUserMessages({ taskId: task.taskId });
    return { ok: true, event, messageId, wakeup, taskState: sessionStore.readTaskState({ taskId: task.taskId }) };
  }

  async function flushPendingUserMessages({ taskId }) {
    const task = taskById(String(taskId));
    if (!task) return { delivered: 0, queued: 0, reason: "loop_task_not_found" };
    const pending = db.prepare("SELECT * FROM agent_loop_user_messages WHERE task_id = ? AND status = 'pending' ORDER BY created_at ASC").all(task.taskId);
    if (!pending.length) return { delivered: 0, queued: 0 };
    const run = latestRun(task.taskId);
    if (!run) return { delivered: 0, queued: pending.length, reason: "task_not_started" };
    const conductorSessionId = workspaceSessionId(task, "conductor");
    let conductor = ptyManager.get?.(conductorSessionId);
    if (!conductor || conductor.status !== "running") {
      await startConductor({ task: taskById(task.taskId), runId: run.runId });
      conductor = ptyManager.get?.(conductorSessionId);
      if (conductor?.status === "running") {
        markPendingUserMessagesDelivered(task.taskId, db, now);
        return { delivered: pending.length, queued: 0, delivery: "conductor_restarted_with_durable_context" };
      }
      return { delivered: 0, queued: pending.length, reason: "conductor_not_running" };
    }
    const conductorState = sessionStore.readSession?.({ taskId: task.taskId, sessionId: conductorSessionId, maxChars: 0 })?.state;
    if (!["ready", "waiting_conductor"].includes(String(conductorState))) {
      return { delivered: 0, queued: pending.length, reason: "conductor_not_ready" };
    }
    const write = enqueueConductorInput ?? ((input) => sessionAuthority.enqueueInput(input));
    for (const item of pending) {
      await write({
        workspaceSessionId: conductorSessionId,
        expectedIncarnationId: conductor.incarnationId,
        source: "user_message",
        payload: formatInteractiveInput([
          "User follow-up for the current Task:",
          "",
          item.message,
          "",
          "Read the durable Task state and decide the next action. Do not treat this as a fixed route.",
        ].join("\n")),
        idempotencyKey: `task-user-message:${item.message_id}`,
      });
      db.prepare("UPDATE agent_loop_user_messages SET status = 'delivered', delivered_at = ? WHERE message_id = ?").run(now(), item.message_id);
      recordRunEvent({ runId: run.runId, type: "conductor.user_message_wakeup", summary: "Runtime 已把用户后续消息送达 Conductor。", data: { messageId: item.message_id } });
    }
    sessionStore.recordState?.({ taskId: task.taskId, sessionId: conductorSessionId, cwd: task.cwd }, "running", "Runtime delivered user follow-up to Conductor.", { source: "user_message" });
    return { delivered: pending.length, queued: 0, delivery: "conductor_wakeup" };
  }

  function markTaskAchieved({ taskId }) {
    const task = required(taskById(required(taskId, "taskId")), "loop_task_not_found");
    if (task.status === "achieved") return task;
    if (task.status !== "delivery_ready") throw new Error("loop_task_not_delivery_ready");
    const timestamp = now();
    db.prepare("UPDATE agent_loop_tasks SET status = 'achieved', updated_at = ? WHERE task_id = ?").run(timestamp, task.taskId);
    const run = latestRun(task.taskId);
    if (run) recordRunEvent({ runId: run.runId, type: "task.achieved", summary: "用户已确认交付产物，Task 进入 achieved 历史。", data: {} });
    recordTaskEvent({ taskId: task.taskId, cwd: task.cwd, type: "task.achieved", summary: "用户已确认任务交付物。", data: { runId: run?.runId } });
    return taskById(task.taskId);
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
    const sessionState = sessionStore.readTaskState({ taskId: task.taskId, sinceCursor: 0 }) ?? { sessions: [], dispatches: [], results: [], pendingDecisions: [] };
    const cards = [
      { id: "conductor", name: task.architecture.template.conductor.role, role: "Conductor", model: task.architecture.defaultModel, mcp: ["agent_workspace_conductor"], skills: [], kind: "conductor" },
      ...task.architecture.agentCards,
    ].filter((card) => {
      if (card.id === "conductor") return true;
      const sessionId = workspaceSessionId(task, card.id);
      // Registering a launch profile is not a Session.  A worker enters the
      // Run workspace only after the Conductor has actually dispatched it (or
      // after a restored runtime has durable Session/PTY/result evidence).
      return sessionState.sessions.some((item) => item.sessionId === sessionId)
        || sessionState.dispatches.some((item) => item.toSessionId === sessionId)
        || sessionState.results.some((item) => item.sessionId === sessionId)
        || Boolean(ptyManager.read(sessionId, 0));
    });
    const turns = cards.map((card) => {
      const sessionId = workspaceSessionId(task, card.id);
      const state = sessionState.sessions.find((item) => item.sessionId === sessionId);
      const terminal = ptyManager.read(sessionId, 0);
      const dispatches = sessionState.dispatches.filter((item) => item.toSessionId === sessionId);
      const sessionView = sessionStore.readSession?.({ taskId: task.taskId, sessionId, maxChars: 0 });
      const result = sessionView?.results?.at(-1);
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
        terminalStatus: terminal?.status === "running" ? "live" : terminal?.status ?? "not_started",
        dispatchStatus: String(dispatches.at(-1)?.status ?? "not_dispatched"),
        output: result?.answerText ? { answerText: result.answerText } : undefined,
        details: { card, dispatches, runtimeState: state?.state },
        terminal,
        startedAt: run.createdAt,
      completedAt: result?.completedAt,
      };
    });
    const workbenchLayout = ensureWorkbenchLayout({ runId: run.runId, knownSessionIds: turns.map((turn) => turn.sessionId) });
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
    recordUserMessage,
    flushPendingUserMessages,
    recordCompletionClaim,
    validateDispatch,
    resumeTaskForDispatch,
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
    description: String(input?.description || "").trim().slice(0, 1500),
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
    "You are capability-constrained to the Agent Workspace MCP and user questions. You cannot read, edit, create, patch, or run shell commands against Task files. Never try to bypass this boundary; a native Session Agent owns every workspace artifact change.",
    "Every worker Session is dispatched by you through call_session or call_sessions using the approved stable agentId, never a physical session identifier. Each dispatch must state a bounded goal, relevant inputs, acceptance criteria, and expected artifact/output; it must stay within that Agent card's declared native capability scope.",
    "When another native Session needs the exact semantic answer of a completed Session, cite it in contextRefs as result:<resultId> from read_task_state. Runtime will copy that selected Provider answer verbatim into the target assignment and persist the snapshot; do not paraphrase it merely to relay it. Never pass raw terminal transcripts or physical Session IDs.",
    "A native Session answer is complete semantic material, not a Runtime verdict. A Reviewer's `pass`, `needs changes`, or critique is ordinary natural-language content in its completed Provider answer. When a review identifies a factual, source, date, coverage, or contradiction gap, do not turn it into an editorial repair brief for Publisher: read the full durable result and decide whether an evidence-capable card should investigate it. If you choose that work, pass the exact Review result with contextRefs. When you judge selected evidence and review material sufficient for a deliverable, pass those selected result:<resultId> materials to Publisher. contextRefs are optional: use them only when the target needs that prior material.",
    "Use read_task_state at the beginning of a decision. You may issue zero, one, or many asynchronous dispatches, then either continue reasoning or end the Provider turn. Do not poll worker terminals while work is pending: Runtime will wake you from provider-derived result, failure, attention, or user-message facts.",
    "A call_session or call_sessions response that says queued/input_accepted is only a Host transport fact, never a Provider result or delivery evidence. If you create any dispatch in a decision, that decision must not call claim_task_completion: summarize that you are waiting and end the Provider turn. On a later semantic Runtime wakeup, use read_task_state to find dispatch.provider.received and a result_available Provider answer before you consider a delivery claim.",
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
    template.delivery.artifactPath ? `Delivery-path preference (not a Runtime gate): ${template.delivery.artifactPath}` : "No delivery path preference was declared.",
    "",
    "Approved native Session Agent cards:",
    cards,
  ].join("\n");
}

function workspaceSessionId(task, agentId) {
  return `opencode:${safeSegment(task.projectId)}:${safeSegment(task.taskId)}:${safeSegment(agentId)}`;
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
    description: row.description,
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
  return { runId: row.run_id, taskId: row.task_id, status: row.status, conductorSessionId: row.conductor_session_id, createdAt: row.created_at, updatedAt: row.updated_at };
}

function listArtifacts(task) {
  const artifactPath = configuredArtifactPath(task);
  if (!artifactPath) return [];
  const absolute = path.resolve(task.cwd, artifactPath);
  if (!fs.existsSync(absolute)) return [{ path: artifactPath, change: "expected", exists: false }];
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

function markPendingUserMessagesDelivered(taskId, db, now) {
  db.prepare("UPDATE agent_loop_user_messages SET status = 'delivered', delivered_at = ? WHERE task_id = ? AND status = 'pending'").run(now(), taskId);
}

function formatInteractiveInput(text) {
  const body = String(text ?? "").trimEnd();
  return `\x1b[200~${body}\x1b[201~\r`;
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
  return {
    version: 1,
    root: { type: "leaf", groupId: "primary" },
    groups: {
      primary: {
        id: "primary",
        sessionIds: ids,
        activeSessionId: ids[0],
      },
    },
    focusedGroupId: "primary",
  };
}

function normalizeWorkbenchLayout(input, knownSessionIds = []) {
  const known = uniqueStrings(knownSessionIds);
  if (!input || typeof input !== "object") return defaultWorkbenchLayout(known);
  const sourceGroups = input.groups && typeof input.groups === "object" ? input.groups : {};
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
  return { version: 1, root, groups, focusedGroupId };
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
      template_id TEXT NOT NULL, version INTEGER NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL, source TEXT NOT NULL,
      conductor_json TEXT NOT NULL, agents_json TEXT NOT NULL, limits_json TEXT NOT NULL, delivery_json TEXT NOT NULL,
      archived_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (template_id, version)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS agent_loop_tasks (
      task_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, cwd TEXT NOT NULL, title TEXT NOT NULL, goal TEXT NOT NULL,
      template_id TEXT NOT NULL, template_version INTEGER NOT NULL, architecture_json TEXT NOT NULL, status TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS agent_loop_runs (
      run_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, status TEXT NOT NULL, conductor_session_id TEXT NOT NULL,
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
}

module.exports = { DEFAULT_MODEL, DEFAULT_TEMPLATE_ID, createAgentLoopV1Runtime };

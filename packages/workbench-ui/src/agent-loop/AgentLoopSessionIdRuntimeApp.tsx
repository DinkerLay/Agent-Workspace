import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Library, ListTodo, PanelLeftClose, PanelLeftOpen, Settings } from "lucide-react";
import type { AgentLoopInteractionResponse } from "./AgentLoopSessionPresentation";
import { AgentLoopSessionIdTaskSetupLauncher } from "./AgentLoopSessionIdTaskSetupLauncher";
import { AgentLoopSessionIdTaskSurface } from "./AgentLoopSessionIdTaskSurface";
import { AgentLoopTaskSetupSurface } from "./AgentLoopTaskSetupSurface";
import { AgentLoopTemplateStudio } from "./AgentLoopTemplateStudio";
import { AgentLoopProviderSettings } from "./AgentLoopProviderSettings";
import type {
  AgentLoopSessionIdPermanentDeletePreview,
  AgentLoopSessionIdRootController,
  AgentLoopSessionIdTaskSummary,
  AgentLoopSessionIdWorkspaceReadModel,
} from "./agent-loop-session-id-root-controller";
import type {
  AgentLoopSessionIdHumanMessageTarget,
  AgentLoopSessionIdTaskReadModel,
  AgentLoopWorkspaceFileObservation,
} from "./agent-loop-session-id-runtime-controller";

type Surface = "tasks" | "templates" | "settings" | "task-setup";
type TaskListMode = "active" | "completed" | "recycle-bin";

export type AgentLoopSessionIdRuntimeAppProps = Readonly<{
  controller: AgentLoopSessionIdRootController;
  workspaceName?: string;
  createUiIntentId?: () => string;
}>;

/**
 * Production Workbench root. It composes configuration-time surfaces with the
 * ACP v3 Session-ID Task surface and never imports a second Task lifecycle.
 */
export function AgentLoopSessionIdRuntimeApp({
  controller,
  createUiIntentId = defaultUiIntentId,
  workspaceName = "Agent Workspace",
}: AgentLoopSessionIdRuntimeAppProps) {
  const configurationController = controller.configuration.configuration;
  const templateStudioController = controller.configuration.templates;
  const [surface, setSurface] = useState<Surface>("tasks");
  const [railCollapsed, setRailCollapsed] = useState(false);
  const [taskListMode, setTaskListMode] = useState<TaskListMode>("active");
  const [workspace, setWorkspace] = useState<AgentLoopSessionIdWorkspaceReadModel>();
  const [selectedTaskId, setSelectedTaskId] = useState<string>();
  const [task, setTask] = useState<AgentLoopSessionIdTaskReadModel>();
  const [selectedSessionId, setSelectedSessionId] = useState<string>();
  const [composerDrafts, setComposerDrafts] = useState<Readonly<Record<string, string>>>({});
  const [taskSetupLauncherOpen, setTaskSetupLauncherOpen] = useState(false);
  const [taskSetupDraftId, setTaskSetupDraftId] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [error, setError] = useState<string>();
  const [permanentDelete, setPermanentDelete] = useState<Readonly<{
    task: AgentLoopSessionIdTaskSummary;
    preview: AgentLoopSessionIdPermanentDeletePreview;
  }>>();
  const mounted = useRef(true);
  const refreshEpochRef = useRef(0);
  const selectedTaskIdRef = useRef<string | undefined>(undefined);
  const taskListModeRef = useRef<TaskListMode>("active");
  const pendingUiIntents = useRef(new Map<string, string>());
  selectedTaskIdRef.current = selectedTaskId;

  taskListModeRef.current = taskListMode;
  const visibleTasks = useMemo(
    () => tasksForMode(workspace?.tasks ?? [], taskListMode),
    [taskListMode, workspace?.tasks],
  );
  const selectedTask = useMemo(
    () => visibleTasks.find((candidate) => candidate.taskId === selectedTaskId)
      ?? visibleTasks[0],
    [selectedTaskId, visibleTasks],
  );
  const taskSetupController = useMemo(
    () => taskSetupDraftId ? configurationController.taskSetup(taskSetupDraftId) : undefined,
    [configurationController, taskSetupDraftId],
  );

  const refresh = useCallback(async (preferredTaskId?: string) => {
    const refreshEpoch = ++refreshEpochRef.current;
    const requestedMode = taskListModeRef.current;
    const requestedTaskId = preferredTaskId ?? selectedTaskIdRef.current;
    const isCurrentRefresh = () => mounted.current
      && refreshEpochRef.current === refreshEpoch
      && taskListModeRef.current === requestedMode;
    let nextWorkspace: AgentLoopSessionIdWorkspaceReadModel;
    try {
      nextWorkspace = await controller.loadWorkspace();
    } catch (reason) {
      if (isCurrentRefresh()) throw reason;
      return;
    }
    if (!isCurrentRefresh()) return;
    const candidates = tasksForMode(nextWorkspace.tasks, requestedMode);
    const nextTaskId = candidates.some((candidate) => candidate.taskId === requestedTaskId)
      ? requestedTaskId
      : candidates[0]?.taskId;
    const nextSummary = nextWorkspace.tasks.find((candidate) => candidate.taskId === nextTaskId);
    let nextTask: AgentLoopSessionIdTaskReadModel | undefined;
    if (nextTaskId && nextSummary?.activeRun && nextSummary.status === "running") {
      try {
        nextTask = await controller.task(nextTaskId).load();
      } catch (reason) {
        if (isCurrentRefresh()) throw reason;
        return;
      }
    }
    if (!isCurrentRefresh()) return;
    selectedTaskIdRef.current = nextTaskId;
    setWorkspace(nextWorkspace);
    setSelectedTaskId(nextTaskId);
    setTask(nextTask);
    setSelectedSessionId((current) => current && nextTask?.sessions.some((session) => session.logicalSessionId === current)
      ? current
      : nextTask?.conductorLogicalSessionId);
  }, [controller]);

  useEffect(() => {
    mounted.current = true;
    void refresh().catch((reason: unknown) => setError(messageFor(reason)));
    return () => {
      mounted.current = false;
      refreshEpochRef.current += 1;
    };
  }, [refresh]);

  useEffect(() => {
    let active = true;
    let unsubscribe: (() => Promise<void> | void) | undefined;
    void controller.subscribe(() => {
      if (active) void refresh().catch((reason: unknown) => setError(messageFor(reason)));
    }).then((release) => {
      if (active) unsubscribe = release;
      else void release();
    }).catch((reason: unknown) => {
      if (active) setError(messageFor(reason));
    });
    return () => {
      active = false;
      void unsubscribe?.();
    };
  }, [controller, refresh]);

  useEffect(() => {
    if (!selectedTask?.activeRun) return undefined;
    let active = true;
    let unsubscribe: (() => void) | undefined;
    void controller.task(selectedTask.taskId).subscribe(() => {
      if (active) void refresh(selectedTask.taskId).catch((reason: unknown) => setError(messageFor(reason)));
    }).then((release) => {
      if (active) unsubscribe = release;
      else release();
    }).catch((reason: unknown) => {
      if (active) setError(messageFor(reason));
    });
    return () => {
      active = false;
      unsubscribe?.();
    };
  }, [controller, refresh, selectedTask?.activeRun?.runId, selectedTask?.taskId]);

  const runAction = useCallback(async <Result,>(key: string, action: () => Promise<Result>, success?: string) => {
    setBusy(key);
    setError(undefined);
    try {
      const result = await action();
      pendingUiIntents.current.delete(key);
      await refresh(selectedTaskIdRef.current);
      if (success) setNotice(success);
      return result;
    } catch (reason) {
      setError(messageFor(reason));
      throw reason;
    } finally {
      setBusy(undefined);
    }
  }, [refresh]);

  const uiIntent = useCallback((key: string) => {
    const existing = pendingUiIntents.current.get(key);
    if (existing) return existing;
    const next = createUiIntentId();
    pendingUiIntents.current.set(key, next);
    return next;
  }, [createUiIntentId]);
  const runTaskAction = useCallback(async <Result,>(key: string, action: (uiIntentId: string) => Promise<Result>) => {
    const result = await action(uiIntent(key));
    pendingUiIntents.current.delete(key);
    return result;
  }, [uiIntent]);
  const selectedRuntime = selectedTask?.activeRun ? controller.task(selectedTask.taskId) : undefined;

  const startTask = useCallback(async (summary: AgentLoopSessionIdTaskSummary) => {
    await runAction(`start:${summary.taskId}`, () => controller.startTask(
      summary.taskId,
      summary.revision,
      uiIntent(`start:${summary.taskId}`),
    ), "已创建 fresh Run；Task goal 将由 Runtime 作为 Conductor 唯一首输入推进。");
  }, [controller, runAction, uiIntent]);

  const resumeTask = useCallback(async (summary: AgentLoopSessionIdTaskSummary) => {
    const runId = summary.activeRun?.runId;
    if (!runId) throw new Error("agent_loop_session_id_resume_run_required");
    await runAction(`resume:${summary.taskId}`, () => controller.resumeTask(
      summary.taskId,
      runId,
      summary.revision,
      uiIntent(`resume:${summary.taskId}`),
    ), "已请求恢复原 Run；Runtime 会复核原 Binding，不创建替代 Run。");
  }, [controller, runAction, uiIntent]);

  const restartTask = useCallback(async (summary: AgentLoopSessionIdTaskSummary) => {
    if (summary.achievement) throw new Error("agent_loop_session_id_achieved_restart_denied");
    await runAction(`restart:${summary.taskId}`, () => controller.restartTask(
      summary.taskId,
      summary.revision,
      uiIntent(`restart:${summary.taskId}`),
    ), "已从 terminal Run 创建 fresh Run；旧 Run 保持只读。");
  }, [controller, runAction, uiIntent]);

  const achieveTask = useCallback(async (
    summary: AgentLoopSessionIdTaskSummary,
    fileObservation?: AgentLoopWorkspaceFileObservation,
  ) => {
    const taskId = summary.taskId;
    const expectedRevision = task?.taskId === taskId ? task.revision : summary.revision;
    const result = await runAction(`achieve:${taskId}`, () => controller.achieveTask({
      taskId,
      expectedRevision,
      uiIntentId: uiIntent(`achieve:${taskId}`),
      ...(fileObservation ? { fileObservation } : {}),
    }), "已记录用户 Achieve；Run lifecycle 未被隐式停止。");
    if (!result.task?.achievement) return;
    taskListModeRef.current = "completed";
    setTaskListMode("completed");
    selectedTaskIdRef.current = taskId;
    setSelectedTaskId(taskId);
    await refresh(taskId);
  }, [controller, refresh, runAction, task?.revision, task?.taskId, uiIntent]);

  const archiveTask = useCallback(async (summary: AgentLoopSessionIdTaskSummary) => {
    const key = `task.archive:${summary.taskId}`;
    await runAction(key, () => controller.archiveTask(
      summary.taskId,
      summary.revision,
      uiIntent(key),
    ), "Task 已移入回收站；原 Task、Run 与审计仍被保留。");
  }, [controller, runAction, uiIntent]);

  const restoreTask = useCallback(async (summary: AgentLoopSessionIdTaskSummary) => {
    const key = `task.restore:${summary.taskId}`;
    await runAction(key, () => controller.restoreTask(
      summary.taskId,
      summary.revision,
      uiIntent(key),
    ), "Task 已恢复原身份；没有创建替代 Run。");
  }, [controller, runAction, uiIntent]);

  const previewPermanentDelete = useCallback(async (summary: AgentLoopSessionIdTaskSummary) => {
    const key = `task.preview_permanent_delete:${summary.taskId}`;
    const result = await runAction(key, () => controller.previewPermanentDelete(
      summary.taskId,
      summary.revision,
      uiIntent(key),
    ));
    if (!result.permanentDeletePreview) throw new Error("agent_loop_session_id_delete_preview_missing");
    setPermanentDelete(Object.freeze({ task: summary, preview: result.permanentDeletePreview }));
  }, [controller, runAction, uiIntent]);

  const permanentlyDeleteTask = useCallback(async () => {
    if (!permanentDelete) throw new Error("agent_loop_session_id_delete_preview_required");
    const key = `task.permanently_delete:${permanentDelete.task.taskId}`;
    await runAction(key, () => controller.permanentlyDeleteTask(
      permanentDelete.task.taskId,
      permanentDelete.task.revision,
      uiIntent(key),
    ), "Task 产品记录已永久删除；Workspace 文件保持不变。");
    setPermanentDelete(undefined);
  }, [controller, permanentDelete, runAction, uiIntent]);

  const chooseTaskListMode = useCallback((mode: TaskListMode) => {
    taskListModeRef.current = mode;
    setTaskListMode(mode);
    setTask(undefined);
    const nextTaskId = tasksForMode(workspace?.tasks ?? [], mode)[0]?.taskId;
    selectedTaskIdRef.current = nextTaskId;
    setSelectedTaskId(nextTaskId);
    setSelectedSessionId(undefined);
    if (nextTaskId) void refresh(nextTaskId).catch((reason: unknown) => setError(messageFor(reason)));
  }, [refresh, workspace?.tasks]);

  const respondInteraction = useCallback(async (input: AgentLoopInteractionResponse) => {
    if (!selectedRuntime) throw new Error("agent_loop_session_id_runtime_unavailable");
    const key = `session.respond_interaction:${input.logicalSessionId}:${input.interactionId}:${input.choiceId}`;
    await runTaskAction(key, (intentId) => selectedRuntime.respondInteraction(
      input.logicalSessionId,
      input.interactionId,
      input.choiceId,
      intentId,
    ));
  }, [runTaskAction, selectedRuntime]);

  return <div className={`awb-agent-loop-app awb-agent-loop-shell ${railCollapsed ? "awb-agent-loop-rail-collapsed" : ""}`} data-testid="agent-loop-surface" data-theme="dark">
    <aside className="awb-agent-loop-rail">
      <div className="awb-agent-loop-brand">
        <div className="awb-agent-loop-brand-copy"><strong>Agent Workspace</strong></div>
        <button
          aria-label={railCollapsed ? "展开主导航" : "收起主导航"}
          className="awb-agent-loop-icon-button awb-agent-loop-rail-toggle"
          data-testid="navigation-rail-toggle"
          onClick={() => setRailCollapsed((current) => !current)}
          title={railCollapsed ? "展开主导航" : "收起主导航"}
          type="button"
        >{railCollapsed ? <PanelLeftOpen aria-hidden="true" size={16} /> : <PanelLeftClose aria-hidden="true" size={16} />}</button>
      </div>
      <nav aria-label="AgentLoop 页面" className="awb-agent-loop-nav">
        <button aria-current={surface === "tasks" ? "page" : undefined} aria-label="任务" className="awb-agent-loop-rail-button" data-testid="navigation-tasks" onClick={() => setSurface("tasks")} title="任务" type="button"><ListTodo aria-hidden="true" size={17} /><span>任务</span></button>
        <button aria-current={surface === "templates" ? "page" : undefined} aria-label="模板" className="awb-agent-loop-rail-button" data-testid="navigation-templates" onClick={() => setSurface("templates")} title="模板" type="button"><Library aria-hidden="true" size={17} /><span>模板</span></button>
        <button aria-current={surface === "settings" ? "page" : undefined} aria-label="设置" className="awb-agent-loop-rail-button" data-testid="navigation-settings" onClick={() => setSurface("settings")} title="设置" type="button"><Settings aria-hidden="true" size={17} /><span>设置</span></button>
      </nav>
    </aside>

    <main className="awb-agent-loop-main">
      <header className="awb-agent-loop-header">
        <div className="awb-agent-loop-header-copy"><strong>{workspaceName}</strong><span>Session-ID Runtime · authenticated typed bridge</span></div>
        <button className="awb-button awb-button-secondary awb-button-compact" disabled={Boolean(busy)} onClick={() => void refresh().catch((reason: unknown) => setError(messageFor(reason)))} type="button">刷新</button>
      </header>
      {error ? <p className="awb-notice is-error" role="alert">{error}</p> : null}
      {notice ? <p className="awb-notice is-success" role="status">{notice}</p> : null}

      {surface === "templates" ? <AgentLoopTemplateStudio controller={templateStudioController} metaController={configurationController.meta} /> : null}
      {surface === "settings" ? <AgentLoopProviderSettings controller={controller.configuration.providerSettings} /> : null}
      {surface === "task-setup" && taskSetupController ? <AgentLoopTaskSetupSurface
        controller={taskSetupController}
        metaController={configurationController.meta}
        onBack={() => {
          setSurface("tasks");
          setTaskSetupDraftId(undefined);
        }}
        onCreated={async (taskId) => {
          setTaskSetupDraftId(undefined);
          setSurface("tasks");
          setSelectedTaskId(taskId);
          await refresh(taskId);
          setNotice("Task 已创建但尚未启动；请显式点击 Start。");
        }}
      /> : null}
      {surface === "tasks" ? <section className="awb-session-id-root-layout">
        <aside aria-label="Task list" className="awb-agent-loop-task-list">
          <header><div><p>TASKS</p><h2>任务</h2></div><button className="awb-button awb-button-primary" data-testid="task-setup-launcher-open" onClick={() => setTaskSetupLauncherOpen(true)} type="button">新建 Task Setup</button></header>
          <nav aria-label="任务分组" className="awb-session-id-task-groups">
            <button aria-pressed={taskListMode === "active"} data-testid="task-list-active" onClick={() => chooseTaskListMode("active")} type="button">进行中 <b>{tasksForMode(workspace?.tasks ?? [], "active").length}</b></button>
            <button aria-pressed={taskListMode === "completed"} data-testid="task-list-completed" onClick={() => chooseTaskListMode("completed")} type="button">已完成 <b>{tasksForMode(workspace?.tasks ?? [], "completed").length}</b></button>
            <button aria-pressed={taskListMode === "recycle-bin"} data-testid="task-list-recycle-bin" onClick={() => chooseTaskListMode("recycle-bin")} type="button">回收站 <b>{tasksForMode(workspace?.tasks ?? [], "recycle-bin").length}</b></button>
          </nav>
          {visibleTasks.length ? <ol>{visibleTasks.map((summary) => <li key={summary.taskId}><button aria-current={summary.taskId === selectedTask?.taskId ? "true" : undefined} onClick={() => void refresh(summary.taskId).catch((reason: unknown) => setError(messageFor(reason)))} type="button"><strong>{summary.title}</strong><span>{summary.trashedAt ? "回收站" : summary.achievement ? "已 Achieve" : summary.activeRun?.status ?? summary.status}</span></button></li>)}</ol> : <p>{taskListMode === "completed" ? "尚无已完成 Task。" : taskListMode === "recycle-bin" ? "回收站为空。" : "尚无进行中 Task。"}</p>}
        </aside>

        <section className="awb-session-id-root-content">
          {!selectedTask ? <p className="awb-agent-loop-empty">创建 Setup Draft，再显式 Create Task。</p> : selectedTask.status === "running" && selectedTask.activeRun && task && selectedRuntime ? <AgentLoopSessionIdTaskSurface
            achievement={selectedTask.achievement}
            composerDrafts={composerDrafts}
            model={task}
            onAchieveTask={(fileObservation) => achieveTask(selectedTask, fileObservation)}
            onAbandonHumanMessage={async (humanInterventionId) => {
              const outcome = await runTaskAction(
                `session.abandon_human_message:${humanInterventionId}`,
                (intentId) => selectedRuntime.abandonHumanMessage(humanInterventionId, intentId),
              );
              await refresh(selectedTask.taskId);
              return outcome;
            }}
            onChooseSession={setSelectedSessionId}
            onComposerChange={(sessionId, content) => setComposerDrafts((current) => ({ ...current, [sessionId]: content }))}
            onPreviewDirectoryCard={() => undefined}
            onPreviewFile={(observationId) => runTaskAction(`workspace.preview_file:${observationId}`, (intentId) => selectedRuntime.previewFile(observationId, intentId))}
            onRequestHumanInterrupt={(sessionId) => runTaskAction(`session.request_interrupt:${sessionId}`, (intentId) => selectedRuntime.requestHumanInterrupt(sessionId, intentId))}
            onRespondInteraction={respondInteraction}
            onSendHumanMessage={async (target, content) => {
              const outcome = await runTaskAction(
                `session.send_human_message:${humanTargetKey(target)}:${content.trim()}`,
                (intentId) => selectedRuntime.sendHumanMessage(target, content, intentId),
              );
              await refresh(selectedTask.taskId);
              setSelectedSessionId(outcome.targetLogicalSessionId);
              return outcome;
            }}
            onStopTask={() => runTaskAction(`task.stop:${selectedTask.taskId}`, (intentId) => selectedRuntime.stopTask(intentId))}
            onSubmitTaskMessage={(content) => runTaskAction(`task.submit_input:${content.trim()}`, (intentId) => selectedRuntime.submitTaskMessage(content, intentId))}
            selectedSessionId={selectedSessionId}
          /> : <TaskLifecycleCard
            busy={busy}
            onAchieve={achieveTask}
            onArchive={archiveTask}
            onPreviewPermanentDelete={previewPermanentDelete}
            onRestart={restartTask}
            onRestore={restoreTask}
            onResume={resumeTask}
            onStart={startTask}
            task={selectedTask}
          />}
        </section>
      </section> : null}
    </main>

    {taskSetupLauncherOpen && workspace ? <AgentLoopSessionIdTaskSetupLauncher
      configurationController={configurationController}
      onClose={() => setTaskSetupLauncherOpen(false)}
      onSetupCreated={(draftId) => {
        setTaskSetupLauncherOpen(false);
        setTaskSetupDraftId(draftId);
        setSurface("task-setup");
      }}
      options={workspace.taskSetupOptions}
    /> : null}
    {permanentDelete ? <PermanentDeleteDialog
      busy={Boolean(busy)}
      onCancel={() => setPermanentDelete(undefined)}
      onConfirm={() => void permanentlyDeleteTask().catch(() => undefined)}
      preview={permanentDelete.preview}
      task={permanentDelete.task}
    /> : null}
  </div>;
}

function TaskLifecycleCard({
  busy,
  onAchieve,
  onArchive,
  onPreviewPermanentDelete,
  onRestart,
  onRestore,
  onResume,
  onStart,
  task,
}: Readonly<{
  busy?: string;
  onAchieve: (task: AgentLoopSessionIdTaskSummary) => Promise<void>;
  onArchive: (task: AgentLoopSessionIdTaskSummary) => Promise<void>;
  onPreviewPermanentDelete: (task: AgentLoopSessionIdTaskSummary) => Promise<void>;
  onRestart: (task: AgentLoopSessionIdTaskSummary) => Promise<void>;
  onRestore: (task: AgentLoopSessionIdTaskSummary) => Promise<void>;
  onResume: (task: AgentLoopSessionIdTaskSummary) => Promise<void>;
  onStart: (task: AgentLoopSessionIdTaskSummary) => Promise<void>;
  task: AgentLoopSessionIdTaskSummary;
}>) {
  return <article className="awb-session-id-queued-task">
    <p>Task · {task.status}</p><h1>{task.title}</h1><p>{task.goal}</p>
    {task.status === "stopped" ? <span className="awb-session-id-run-state is-stopped" data-testid="task-stopped">stopped</span> : null}
    <span data-testid="task-run-meta-absent">配置助手仅用于 Draft；Task 页面没有配置入口。</span>
    {task.achievement ? task.achievement.fileStateAnchor
      ? <span data-testid="task-achieved-with-anchor">已接受 · 文件状态已锚定</span>
      : <span data-testid="task-achieved-without-anchor">已接受 · 无文件状态锚点</span>
      : null}
    <div className="awb-actions">
      {task.availableLifecycleActions.includes("start") && !task.achievement ? <button className="awb-button awb-button-primary" data-testid="task-start" disabled={Boolean(busy)} onClick={() => void onStart(task)} type="button">{busy === `start:${task.taskId}` ? "正在启动…" : "Start fresh Run"}</button> : null}
      {task.availableLifecycleActions.includes("resume") ? <button className="awb-button awb-button-primary" data-testid="task-resume" disabled={Boolean(busy) || !task.activeRun} onClick={() => void onResume(task)} type="button">{busy === `resume:${task.taskId}` ? "正在恢复…" : "Resume original Run"}</button> : null}
      {task.availableLifecycleActions.includes("restart") && !task.achievement ? <button className="awb-button awb-button-primary" data-testid="task-restart" disabled={Boolean(busy)} onClick={() => void onRestart(task)} type="button">{busy === `restart:${task.taskId}` ? "正在重启…" : "Restart with fresh Run"}</button> : null}
      {!task.trashedAt && !task.achievement ? <button className="awb-button awb-button-secondary" data-testid="task-achieve-without-anchor" disabled={Boolean(busy)} onClick={() => void onAchieve(task)} type="button">{busy === `achieve:${task.taskId}` ? "提交中…" : "Achieve（不附文件状态）"}</button> : null}
      {task.trashedAt ? <>
        <button className="awb-button awb-button-secondary" data-testid="task-restore" disabled={Boolean(busy)} onClick={() => void onRestore(task)} type="button">恢复 Task</button>
        <button className="awb-button awb-button-danger" data-testid="task-preview-permanent-delete" disabled={Boolean(busy)} onClick={() => void onPreviewPermanentDelete(task)} type="button">永久删除…</button>
      </> : task.achievement ? <button className="awb-button awb-button-secondary" data-testid="task-archive" disabled={Boolean(busy)} onClick={() => void onArchive(task)} type="button">移入回收站</button> : null}
    </div>
  </article>;
}

function PermanentDeleteDialog({
  busy,
  onCancel,
  onConfirm,
  preview,
  task,
}: Readonly<{
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  preview: AgentLoopSessionIdPermanentDeletePreview;
  task: AgentLoopSessionIdTaskSummary;
}>) {
  const records = Object.entries(preview.productRecordCounts).filter(([, count]) => count > 0);
  return <div aria-label="永久删除 Task" aria-modal="true" className="awb-agent-loop-modal-backdrop" role="dialog">
    <button aria-label="取消永久删除" className="awb-agent-loop-modal-scrim" disabled={busy} onClick={onCancel} type="button" />
    <section className="awb-agent-loop-modal awb-agent-loop-permanent-delete-dialog">
      <header><div><p>PERMANENT DELETE</p><h2>永久删除“{task.title}”吗？</h2></div></header>
      <div className="awb-agent-loop-modal-copy">
        <p>将删除此 Task 的 Runtime 产品记录与审计。<strong>Workspace 文件不会被删除。</strong></p>
        <ul>{records.map(([kind, count]) => <li key={kind}>{kind}: {count}</li>)}</ul>
      </div>
      <footer>
        <button className="awb-button awb-button-secondary" disabled={busy} onClick={onCancel} type="button">取消</button>
        <button className="awb-button awb-button-danger" data-testid="task-permanently-delete-confirm" disabled={busy} onClick={onConfirm} type="button">确认永久删除</button>
      </footer>
    </section>
  </div>;
}

function messageFor(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

function humanTargetKey(target: AgentLoopSessionIdHumanMessageTarget): string {
  return "targetLogicalSessionId" in target
    ? `session:${target.targetLogicalSessionId}`
    : `card:${target.targetAgentCardId}`;
}

function tasksForMode(
  tasks: readonly AgentLoopSessionIdTaskSummary[],
  mode: TaskListMode,
): readonly AgentLoopSessionIdTaskSummary[] {
  if (mode === "recycle-bin") return tasks.filter((task) => Boolean(task.trashedAt));
  if (mode === "completed") return tasks.filter((task) => Boolean(task.achievement) && !task.trashedAt);
  return tasks.filter((task) => !task.achievement && !task.trashedAt);
}

function defaultUiIntentId(): string {
  return `ui_intent_${globalThis.crypto.randomUUID()}`;
}

import {
  Bot,
  ClipboardCheck,
  Layers2,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  RefreshCw,
  Sun,
} from "lucide-react";
import type { RuntimeInvalidation } from "@agent-workspace/runtime-contracts";
import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import type {
  AgentLoopAttentionResponse,
  AgentLoopComposerSubmission,
  AgentLoopStopTaskRequest,
} from "./AgentLoopSessionPresentation";
import {
  AgentLoopTaskSurface,
  type AgentLoopTaskListMode,
} from "./AgentLoopTaskSurface";
import { AgentLoopTaskCreateDialog } from "./AgentLoopTaskCreateDialog";
import { AgentLoopTaskSetupSurface } from "./AgentLoopTaskSetupSurface";
import { AgentLoopTemplateStudio } from "./AgentLoopTemplateStudio";
import type { AgentLoopConfigurationController } from "./agent-loop-configuration-controller";
import type { AgentLoopRuntimeController } from "./agent-loop-runtime-controller";
import type { AgentLoopRuntimeViewModel } from "./agent-loop-model";
import type { AgentLoopTemplateStudioController } from "./agent-loop-template-studio-controller";

type Surface = "tasks" | "templates" | "task-setup";
type Theme = "dark" | "light";
const PROVIDER_ACTIVITY_REFRESH_INTERVAL_MS = 50;

export type AgentLoopRuntimeAppProps = Readonly<{
  controller: AgentLoopRuntimeController;
  configurationController: AgentLoopConfigurationController;
  templateStudioController: AgentLoopTemplateStudioController;
  workspaceName?: string;
  workspacePath?: string;
}>;

/**
 * Formal AgentLoop renderer.
 *
 * This preserves the product rail + three-pane Task/Session + Template Studio
 * interaction. The provider-specific center page is replaced by
 * `AgentLoopSessionPresentation`, whose input and attention actions cross the
 * unified RuntimeClient boundary.
 */
export function AgentLoopRuntimeApp({
  configurationController,
  controller,
  templateStudioController,
  workspaceName = "Agent Workspace",
  workspacePath,
}: AgentLoopRuntimeAppProps) {
  const [surface, setSurface] = useState<Surface>("tasks");
  const [theme, setTheme] = useState<Theme>("dark");
  const [railCollapsed, setRailCollapsed] = useState(true);
  const [taskListMode, setTaskListMode] = useState<AgentLoopTaskListMode>("active");
  const [selectedTaskId, setSelectedTaskId] = useState<string>();
  const [selectedSessionId, setSelectedSessionId] = useState<string>();
  const [composerDrafts, setComposerDrafts] = useState<Record<string, string>>({});
  const [view, setView] = useState<AgentLoopRuntimeViewModel>();
  const [initialLoading, setInitialLoading] = useState(true);
  const [taskCreationOpen, setTaskCreationOpen] = useState(false);
  const [taskSetupDraftId, setTaskSetupDraftId] = useState<string>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [actionKey, setActionKey] = useState<string>();
  const [isRefreshing, startRefreshTransition] = useTransition();
  const mountedRef = useRef(true);
  const selectedTaskIdRef = useRef<string | undefined>(undefined);
  const taskListModeRef = useRef(taskListMode);
  const refreshFlightRef = useRef<Promise<void> | undefined>(undefined);
  const refreshQueuedRef = useRef(false);
  const pendingPreferredTaskIdRef = useRef<string | undefined>(undefined);
  const activityRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  selectedTaskIdRef.current = selectedTaskId;
  taskListModeRef.current = taskListMode;

  const visibleTasks = useMemo(
    () => tasksForMode(view?.tasks ?? [], taskListMode),
    [taskListMode, view?.tasks],
  );
  const selectedTask = useMemo(
    () => visibleTasks.find((task) => task.taskId === selectedTaskId) ?? visibleTasks[0],
    [selectedTaskId, visibleTasks],
  );
  const selectedDetail = view?.selectedTask && view.selectedTask.task.taskId === selectedTask?.taskId
    ? view.selectedTask
    : undefined;
  const taskSetupController = useMemo(
    () => taskSetupDraftId ? configurationController.taskSetup(taskSetupDraftId) : undefined,
    [configurationController, taskSetupDraftId],
  );

  const performRefresh = useCallback(async (preferredTaskId?: string) => {
    const first = await controller.load(selectedTaskIdRef.current);
    if (!mountedRef.current) return;
    const candidates = tasksForMode(first.tasks, taskListModeRef.current);
    const nextTaskId = candidates.some((task) => task.taskId === preferredTaskId)
      ? preferredTaskId
      : candidates.some((task) => task.taskId === selectedTaskIdRef.current)
        ? selectedTaskIdRef.current
        : candidates[0]?.taskId;
    const next = nextTaskId && first.selectedTask?.task.taskId !== nextTaskId
      ? await controller.load(nextTaskId)
      : first;
    if (!mountedRef.current) return;
    selectedTaskIdRef.current = nextTaskId;
    setSelectedTaskId(nextTaskId);
    startRefreshTransition(() => setView(next));
    setInitialLoading(false);
  }, [controller]);

  const enqueueRefresh = useCallback((preferredTaskId?: string): Promise<void> => {
    refreshQueuedRef.current = true;
    if (preferredTaskId !== undefined) pendingPreferredTaskIdRef.current = preferredTaskId;
    if (refreshFlightRef.current) return refreshFlightRef.current;

    let tracked: Promise<void>;
    tracked = (async () => {
      while (mountedRef.current && refreshQueuedRef.current) {
        refreshQueuedRef.current = false;
        const pendingPreferredTaskId = pendingPreferredTaskIdRef.current;
        pendingPreferredTaskIdRef.current = undefined;
        await performRefresh(pendingPreferredTaskId);
      }
    })().finally(() => {
      if (refreshFlightRef.current !== tracked) return;
      refreshFlightRef.current = undefined;
      // A request queued in the final promise microtask must not be lost. It
      // starts a new flight only after the previous one has fully settled.
      if (mountedRef.current && refreshQueuedRef.current) {
        void enqueueRefresh().catch((reason: unknown) => {
          if (mountedRef.current) setError(messageFor(reason));
        });
      }
    });
    refreshFlightRef.current = tracked;
    return tracked;
  }, [performRefresh]);

  const cancelActivityRefresh = useCallback(() => {
    if (activityRefreshTimerRef.current === undefined) return;
    clearTimeout(activityRefreshTimerRef.current);
    activityRefreshTimerRef.current = undefined;
  }, []);

  const refresh = useCallback((preferredTaskId?: string) => {
    cancelActivityRefresh();
    return enqueueRefresh(preferredTaskId);
  }, [cancelActivityRefresh, enqueueRefresh]);

  const scheduleActivityRefresh = useCallback(() => {
    if (activityRefreshTimerRef.current !== undefined) return;
    activityRefreshTimerRef.current = setTimeout(() => {
      activityRefreshTimerRef.current = undefined;
      if (!mountedRef.current) return;
      void enqueueRefresh().catch((reason: unknown) => {
        if (mountedRef.current) setError(messageFor(reason));
      });
    }, PROVIDER_ACTIVITY_REFRESH_INTERVAL_MS);
  }, [enqueueRefresh]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      cancelActivityRefresh();
    };
  }, [cancelActivityRefresh]);

  useEffect(() => {
    let active = true;
    let unsubscribe: (() => Promise<void> | void) | undefined;
    const onChanged = (invalidation: RuntimeInvalidation) => {
      if (!active) return;
      if (isProviderFactOnlyInvalidation(invalidation)) {
        scheduleActivityRefresh();
        return;
      }
      void refresh().catch((reason: unknown) => {
        if (active) setError(messageFor(reason));
      });
    };
    void controller.subscribe(onChanged).then((stop) => {
      if (active) unsubscribe = stop;
      else void stop();
    }).catch((reason: unknown) => {
      if (active) setError(messageFor(reason));
    });
    return () => {
      active = false;
      cancelActivityRefresh();
      void unsubscribe?.();
    };
  }, [cancelActivityRefresh, controller, refresh, scheduleActivityRefresh]);

  useEffect(() => {
    void refresh().catch((reason: unknown) => {
      if (!mountedRef.current) return;
      setInitialLoading(false);
      setError(messageFor(reason));
    });
  }, [refresh, taskListMode]);

  useEffect(() => {
    const sessions = selectedDetail?.sessions ?? [];
    setSelectedSessionId((current) =>
      current && sessions.some((session) => session.logicalSessionId === current)
        ? current
        : sessions.find((session) => session.kind === "conductor")?.logicalSessionId ?? sessions[0]?.logicalSessionId,
    );
  }, [selectedDetail?.task.taskId, selectedDetail?.sessions]);

  const runAction = useCallback(async <Result,>(key: string, action: () => Promise<Result>, success?: string): Promise<Result> => {
    setActionKey(key);
    setError(undefined);
    setNotice(undefined);
    try {
      const result = await action();
      await refresh();
      if (success) setNotice(success);
      return result;
    } catch (reason) {
      const message = messageFor(reason);
      setError(message);
      throw reason;
    } finally {
      setActionKey(undefined);
    }
  }, [refresh]);

  const chooseTask = useCallback((taskId: string) => {
    setSelectedSessionId(undefined);
    setSelectedTaskId(taskId);
    void refresh(taskId).catch((reason: unknown) => setError(messageFor(reason)));
  }, [refresh]);

  const chooseMode = useCallback((mode: AgentLoopTaskListMode) => {
    setTaskListMode(mode);
    setSelectedSessionId(undefined);
    setSelectedTaskId(undefined);
  }, []);

  const submitInput = useCallback(async (input: AgentLoopComposerSubmission) => {
    const detail = selectedDetail;
    if (!detail || detail.task.taskId !== input.taskId) throw new Error("agent_loop_selected_task_unavailable");
    const intent = controller.createInputSubmissionIntent(
      input.taskId,
      detail.task.revision,
      input.targetLogicalSessionId,
      input.content,
    );
    const outcome = await runAction(`input:${intent.commandId}`, async () => {
      const result = await controller.submitTaskInput(intent);
      if (result.state === "sent") {
        setComposerDrafts((current) => ({ ...current, [composerKey(input.taskId, input.targetLogicalSessionId)]: "" }));
      }
      return result;
    });
    if (outcome.state === "interrupting") {
      setNotice("目标 Card 正在运行；已记录 scoped interrupt，Provider 确认旧 Turn 安全结束后才会发送，草稿仍保留在输入框中。");
    } else {
      setNotice("输入已成为 Runtime Message；等待 Inbox 投递与 Provider 回执。");
    }
  }, [controller, runAction, selectedDetail]);

  const stopTask = useCallback(async (input: AgentLoopStopTaskRequest) => {
    const detail = selectedDetail;
    if (!detail || detail.task.taskId !== input.taskId) throw new Error("agent_loop_selected_task_unavailable");
    await runAction(`stop:${input.taskId}`, () => controller.stopTask(input.taskId, detail.task.revision), "已请求停止；等待 Runtime 和 Provider 的事实确认。");
  }, [controller, runAction, selectedDetail]);

  const respondAttention = useCallback(async (input: AgentLoopAttentionResponse) => {
    const detail = selectedDetail;
    if (!detail || detail.task.taskId !== input.taskId) throw new Error("agent_loop_selected_task_unavailable");
    await runAction(`attention:${input.attentionId}`, () => controller.respondAttention({
      taskId: input.taskId,
      expectedRevision: detail.task.revision,
      attentionId: input.attentionId,
      response: input.response,
    }), "已提交答复；等待 Provider 确认。");
  }, [controller, runAction, selectedDetail]);

  return (
    <div className={`awb-agent-loop-app awb-agent-loop-shell ${railCollapsed ? "awb-agent-loop-rail-collapsed" : ""}`} data-theme={theme}>
      <aside className="awb-agent-loop-rail">
        <div className="awb-agent-loop-brand">
          <span className="awb-agent-loop-brand-copy"><Bot size={20} /><strong>Agent Workspace</strong></span>
          <button aria-label={railCollapsed ? "展开导航栏" : "收起导航栏"} className="awb-agent-loop-icon-button" onClick={() => setRailCollapsed((current) => !current)} type="button">
            {railCollapsed ? <PanelLeftOpen size={17} /> : <PanelLeftClose size={17} />}
          </button>
        </div>
        <nav aria-label="AgentLoop 页面" className="awb-agent-loop-nav">
          <RailButton active={surface === "tasks"} icon={<ClipboardCheck size={18} />} label="任务" onClick={() => setSurface("tasks")} />
          <RailButton active={surface === "templates"} icon={<Layers2 size={18} />} label="模板" onClick={() => setSurface("templates")} />
        </nav>
        <div className="awb-agent-loop-rail-footer">
          <button aria-label="切换主题" className="awb-agent-loop-icon-button" onClick={() => setTheme((current) => current === "dark" ? "light" : "dark")} type="button">
            {theme === "dark" ? <Sun size={17} /> : <Moon size={17} />}
          </button>
          <span>统一 Runtime</span>
        </div>
      </aside>

      <main className="awb-agent-loop-main">
        <header className="awb-agent-loop-header">
          <div className="awb-agent-loop-header-copy"><strong>{workspaceName}</strong>{workspacePath ? <span>{workspacePath}</span> : <span>任务与会话由统一 Runtime 管理</span>}</div>
          <div className="awb-agent-loop-header-actions">
            <span className="awb-agent-loop-host-status">Runtime read model</span>
            <button className="awb-button awb-button-secondary awb-button-compact" disabled={Boolean(actionKey)} onClick={() => void runAction("refresh", refresh).catch(() => undefined)} type="button">
              <RefreshCw size={14} /> {isRefreshing || actionKey === "refresh" ? "刷新中…" : "刷新"}
            </button>
          </div>
        </header>

        {error ? <Notice tone="error">{error}</Notice> : null}
        {notice ? <Notice tone="success">{notice}</Notice> : null}
        {initialLoading && !view ? <section className="awb-agent-loop-empty">正在读取 AgentLoop Runtime…</section> : null}
        {view ? surface === "tasks" ? <AgentLoopTaskSurface
          actionKey={actionKey}
          allTasks={view.tasks}
          composerDrafts={composerDrafts}
          detail={selectedDetail}
          mode={taskListMode}
          onAchieve={(task) => void runAction(`achieve:${task.taskId}`, () => controller.achieveTask(task.taskId, task.revision), "已记录你的 Achieve 决定；不会停止仍在运行的 Run。").catch(() => undefined)}
          onArchive={(task) => runAction(`archive:${task.taskId}`, () => controller.archiveTask(task.taskId, task.revision), "Task 已移入回收站；其历史和受管产物仍被保留。")}
          onChooseMode={chooseMode}
          onChooseSession={setSelectedSessionId}
          onChooseTask={chooseTask}
          onComposerChange={(taskId, sessionId, message) => setComposerDrafts((current) => ({ ...current, [composerKey(taskId, sessionId)]: message }))}
          onCreateTask={() => setTaskCreationOpen(true)}
          onPermanentlyDelete={(task, artifactIds) => runAction(`permanently-delete:${task.taskId}`, async () => {
            await controller.permanentlyDeleteTask(task.taskId, task.revision, artifactIds);
          }, "Task 已从 Runtime 永久删除；只有你勾选且 Host 核验通过的受管产物会被移除。")}
          onPreviewArtifact={(task, artifact) => runAction(`artifact-preview:${artifact.artifactId}`, () => controller.previewArtifact(task.taskId, task.revision, artifact.artifactId))}
          onPreviewPermanentDelete={(task) => runAction(`permanent-delete-preview:${task.taskId}`, () => controller.previewPermanentDelete(task.taskId, task.revision))}
          onRestart={(task) => void runAction(`restart:${task.taskId}`, () => controller.restartTask(task.taskId, task.revision), "已请求启动新的 Run。").catch(() => undefined)}
          onRestore={(task) => runAction(`restore:${task.taskId}`, () => controller.restoreTask(task.taskId, task.revision), "Task 已恢复原身份；没有创建替代 Run。")}
          onResume={(task, runId) => void runAction(`resume:${task.taskId}:${runId}`, () => controller.resumeTask(task.taskId, task.revision, runId), "已请求拉回原 Run；等待 Runtime 核验 Provider Session。").catch(() => undefined)}
          onRespondAttention={respondAttention}
          onStart={(task) => void runAction(`start:${task.taskId}`, () => controller.startTask(task.taskId, task.revision), "已请求启动 Agent Loop。").catch(() => undefined)}
          onStop={stopTask}
          onSubmitInput={submitInput}
          selectedSessionId={selectedSessionId}
          selectedTask={selectedTask}
          tasks={visibleTasks}
        /> : surface === "templates" ? <AgentLoopTemplateStudio
          controller={templateStudioController}
          metaController={configurationController.meta}
        /> : taskSetupController ? <AgentLoopTaskSetupSurface
          controller={taskSetupController}
          metaController={configurationController.meta}
          onBack={() => {
            setSurface("tasks");
            setTaskSetupDraftId(undefined);
          }}
          onCreated={async (taskId) => {
            setTaskListMode("active");
            setSelectedSessionId(undefined);
            setSelectedTaskId(taskId);
            setTaskSetupDraftId(undefined);
            setSurface("tasks");
            await refresh(taskId);
            setNotice("Task 已从持久化 Setup 创建；请明确点击启动 Agent Loop。");
          }}
        /> : null : null}
      </main>

      {taskCreationOpen && view ? <AgentLoopTaskCreateDialog
        configurationController={configurationController}
        controller={controller}
        onClose={() => setTaskCreationOpen(false)}
        onSetupCreated={async (createdTaskSetupDraftId) => {
          setTaskSetupDraftId(createdTaskSetupDraftId);
          setSurface("task-setup");
          setNotice("Task Setup Draft 已保存。完成 Version schema 后再创建 Task。");
        }}
        onRequestRefresh={async () => { await refresh(); }}
        templateStudioController={templateStudioController}
        view={view}
      /> : null}
    </div>
  );
}

function RailButton({ active, icon, label, onClick }: Readonly<{ active: boolean; icon: React.ReactNode; label: string; onClick: () => void }>) {
  return <button aria-current={active ? "page" : undefined} aria-pressed={active} className={`awb-agent-loop-rail-button ${active ? "is-active" : ""}`} onClick={onClick} type="button">{icon}<span>{label}</span></button>;
}

function Notice({ children, tone }: Readonly<{ children: React.ReactNode; tone: "error" | "success" }>) {
  return <div className={`awb-notice is-${tone}`} role={tone === "error" ? "alert" : "status"}>{children}</div>;
}

function Empty({ detail, title }: Readonly<{ detail: string; title: string }>) {
  return <div className="awb-agent-loop-empty"><strong>{title}</strong><p>{detail}</p></div>;
}

function tasksForMode(tasks: readonly AgentLoopRuntimeViewModel["tasks"][number][], mode: AgentLoopTaskListMode) {
  if (mode === "recycle-bin") return tasks.filter((task) => Boolean(task.trashedAt));
  if (mode === "completed") return tasks.filter((task) => Boolean(task.achievement) && !task.trashedAt);
  return tasks.filter((task) => !task.achievement && !task.trashedAt);
}

function composerKey(taskId: string, logicalSessionId: string): string {
  return `${taskId}:${logicalSessionId}`;
}

function isProviderFactOnlyInvalidation(invalidation: RuntimeInvalidation): boolean {
  // `activity_observed` changes only the Provider activity projection today.
  // Any additional semantic reason (message, turn, attention, lifecycle, …)
  // bypasses the activity window and refreshes immediately.
  return invalidation.reasons.length === 1 && invalidation.reasons[0] === "provider_fact_reconciled";
}

function messageFor(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

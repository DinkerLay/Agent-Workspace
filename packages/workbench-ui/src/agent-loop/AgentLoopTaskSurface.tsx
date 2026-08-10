import {
  Archive,
  Bot,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  ClipboardCheck,
  Eye,
  FileText,
  Plus,
  Play,
  RotateCcw,
  Send,
  Square,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ArtifactPreviewReadModel, TaskPermanentDeletePreview } from "@agent-workspace/runtime-contracts";
import {
  AgentLoopSessionPresentation,
  type AgentLoopAttentionResponse,
  type AgentLoopComposerSubmission,
  type AgentLoopStopTaskRequest,
} from "./AgentLoopSessionPresentation";
import { AgentLoopArtifactHtmlPreview } from "./AgentLoopArtifactHtmlPreview";
import type {
  AgentLoopSessionItem,
  AgentLoopArtifactItem,
  AgentLoopTaskDetail,
  AgentLoopTaskListItem,
} from "./agent-loop-model";

export type AgentLoopTaskListMode = "active" | "completed" | "recycle-bin";

export type AgentLoopTaskSurfaceProps = Readonly<{
  actionKey?: string;
  allTasks: readonly AgentLoopTaskListItem[];
  composerDrafts: Readonly<Record<string, string>>;
  detail?: AgentLoopTaskDetail;
  mode: AgentLoopTaskListMode;
  onAchieve: (task: AgentLoopTaskListItem) => void;
  onArchive: (task: AgentLoopTaskListItem) => Promise<void>;
  onChooseMode: (mode: AgentLoopTaskListMode) => void;
  onChooseSession: (logicalSessionId: string) => void;
  onChooseTask: (taskId: string) => void;
  onComposerChange: (taskId: string, logicalSessionId: string, message: string) => void;
  onCreateTask: () => void;
  onPermanentlyDelete: (task: AgentLoopTaskListItem, artifactIds: readonly string[]) => Promise<void>;
  onPreviewArtifact: (task: AgentLoopTaskListItem, artifact: AgentLoopArtifactItem) => Promise<ArtifactPreviewReadModel>;
  onPreviewPermanentDelete: (task: AgentLoopTaskListItem) => Promise<TaskPermanentDeletePreview>;
  onRestart: (task: AgentLoopTaskListItem) => void;
  onRestore: (task: AgentLoopTaskListItem) => Promise<void>;
  onResume: (task: AgentLoopTaskListItem, runId: string) => void;
  onRespondAttention: (input: AgentLoopAttentionResponse) => Promise<void>;
  onStart: (task: AgentLoopTaskListItem) => void;
  onStop: (input: AgentLoopStopTaskRequest) => Promise<void>;
  onSubmitInput: (input: AgentLoopComposerSubmission) => Promise<void>;
  selectedSessionId?: string;
  selectedTask?: AgentLoopTaskListItem;
  tasks: readonly AgentLoopTaskListItem[];
}>;

/**
 * The preserved AgentLoop task page. Its layout and user journey stay aligned
 * with the three-pane product; the center is a SessionPresentation driven
 * through RuntimeClient commands.
 */
export function AgentLoopTaskSurface({
  actionKey,
  allTasks,
  composerDrafts,
  detail,
  mode,
  onAchieve,
  onArchive,
  onChooseMode,
  onChooseSession,
  onChooseTask,
  onComposerChange,
  onCreateTask,
  onPermanentlyDelete,
  onPreviewArtifact,
  onPreviewPermanentDelete,
  onRestart,
  onRestore,
  onResume,
  onRespondAttention,
  onStart,
  onStop,
  onSubmitInput,
  selectedSessionId,
  selectedTask,
  tasks,
}: AgentLoopTaskSurfaceProps) {
  const [inspectorCollapsed, setInspectorCollapsed] = useState(false);
  const [drawer, setDrawer] = useState<"timeline" | "artifacts">();
  const [artifactPreview, setArtifactPreview] = useState<ArtifactPreviewReadModel>();
  const [artifactPreviewingId, setArtifactPreviewingId] = useState<string>();
  const [permanentDelete, setPermanentDelete] = useState<Readonly<{
    task: AgentLoopTaskListItem;
    preview: TaskPermanentDeletePreview;
  }>>();
  const [permanentDeleteError, setPermanentDeleteError] = useState<string>();
  const [stopTarget, setStopTarget] = useState<AgentLoopTaskListItem>();
  const [paneWidths, setPaneWidths] = useState({ list: 250, inspector: 240 });
  const dragRef = useRef<{ edge: "list" | "inspector"; startX: number; startWidth: number } | undefined>(undefined);
  const layoutRef = useRef<HTMLDivElement>(null);

  const selectedSession = detail?.sessions.find((session) => session.logicalSessionId === selectedSessionId)
    ?? detail?.sessions.find((session) => session.kind === "conductor")
    ?? detail?.sessions[0];
  const conductorSession = detail?.sessions.find((session) => session.kind === "conductor");
  const activeCount = allTasks.filter((task) => !task.achievement && !task.trashedAt).length;
  const completedCount = allTasks.filter((task) => Boolean(task.achievement) && !task.trashedAt).length;
  const recycledCount = allTasks.filter((task) => Boolean(task.trashedAt)).length;
  const selectedAttentions = selectedSession ? attentionsForSession(detail, selectedSession) : [];
  const conductorReady = detail?.conductorReadiness?.status === "available";
  const launchReadinessLabel = conductorReadinessLabel(detail?.conductorReadiness);
  const canStop = Boolean(detail?.activeRun && ["starting", "running", "waiting_attention", "stopping"].includes(detail.activeRun.status));
  const canResume = Boolean(
    selectedTask?.achievement
    && detail?.activeRun
    && !["starting", "running", "waiting_attention", "stopping"].includes(detail.activeRun.status)
    && detail.sessions.length > 0
    && detail.sessions.every((session) => session.binding?.recoverable),
  );

  useEffect(() => {
    if (!selectedTask) {
      setDrawer(undefined);
      setArtifactPreview(undefined);
    }
  }, [selectedTask?.taskId]);

  const openArtifactPreview = useCallback(async (artifact: AgentLoopArtifactItem) => {
    if (!selectedTask) return;
    setArtifactPreviewingId(artifact.artifactId);
    try {
      setArtifactPreview(await onPreviewArtifact(selectedTask, artifact));
    } finally {
      setArtifactPreviewingId(undefined);
    }
  }, [onPreviewArtifact, selectedTask]);

  const openPermanentDelete = useCallback(async () => {
    if (!selectedTask) return;
    setPermanentDeleteError(undefined);
    try {
      setPermanentDelete({ task: selectedTask, preview: await onPreviewPermanentDelete(selectedTask) });
    } catch (error) {
      setPermanentDeleteError(error instanceof Error ? error.message : String(error));
    }
  }, [onPreviewPermanentDelete, selectedTask]);

  const applyDrag = useCallback((event: PointerEvent) => {
    const drag = dragRef.current;
    const layout = layoutRef.current;
    if (!drag || !layout) return;
    const delta = drag.edge === "list" ? event.clientX - drag.startX : drag.startX - event.clientX;
    const width = Math.round(Math.max(196, Math.min(420, drag.startWidth + delta)));
    setPaneWidths((current) => drag.edge === "list" ? { ...current, list: width } : { ...current, inspector: width });
  }, []);

  const endDrag = useCallback(() => {
    dragRef.current = undefined;
    document.body.classList.remove("awb-agent-loop-resizing");
    window.removeEventListener("pointermove", applyDrag);
    window.removeEventListener("pointerup", endDrag);
  }, [applyDrag]);

  const startDrag = useCallback((edge: "list" | "inspector", event: React.PointerEvent<HTMLButtonElement>) => {
    if (edge === "inspector" && inspectorCollapsed) return;
    event.preventDefault();
    dragRef.current = { edge, startX: event.clientX, startWidth: edge === "list" ? paneWidths.list : paneWidths.inspector };
    document.body.classList.add("awb-agent-loop-resizing");
    window.addEventListener("pointermove", applyDrag);
    window.addEventListener("pointerup", endDrag, { once: true });
  }, [applyDrag, endDrag, inspectorCollapsed, paneWidths.inspector, paneWidths.list]);

  useEffect(() => () => endDrag(), [endDrag]);

  const style = {
    "--awb-task-list-width": `${paneWidths.list}px`,
    "--awb-task-inspector-width": `${paneWidths.inspector}px`,
  } as React.CSSProperties;

  const listTitle = mode === "completed" ? "已完成任务" : mode === "recycle-bin" ? "回收站" : "任务";
  const listCaption = mode === "completed"
    ? "已明确 Achieve 的 Task 保留历史、产物和继续入口；Run 是否活跃由 Runtime 单独显示。"
    : mode === "recycle-bin"
      ? "回收站只包含已经由用户明确归档的 Task；恢复不会克隆 Run，永久删除需再次确认。"
      : "进行中 Task 固化一个不可变的 Agent Loop Template 架构快照。";

  return (
    <div
      className={`awb-agent-loop-task-layout awb-agent-loop-task-layout-resizable ${inspectorCollapsed ? "is-inspector-collapsed" : ""}`}
      ref={layoutRef}
      style={style}
    >
      <aside className="awb-agent-loop-task-list">
        <header className="awb-agent-loop-panel-heading">
          <div><h1>{listTitle}</h1><p>{listCaption}</p></div>
          {mode === "active" ? <button aria-label="新建 Task" className="awb-button awb-button-primary awb-button-compact" disabled={Boolean(actionKey)} onClick={onCreateTask} type="button"><Plus size={14} /> 新建</button> : null}
        </header>
        <div className="awb-agent-loop-list-caption">{mode === "completed" ? "Achieve 是你的决定，不是 Agent 的完成声明；它不会停止仍在运行的 Run。" : mode === "recycle-bin" ? "回收和永久删除都由你的明确命令触发；Runtime 不会根据 Agent 的“完成”自行移动 Task。" : "选择一个 Task；在中间查看 Timeline，或进入具体 Session 继续对话。"}</div>
        <div aria-label={mode === "completed" ? "已完成任务列表" : "Task 列表"} className="awb-agent-loop-task-rows">
          {tasks.length ? tasks.map((task) => <TaskRow active={task.taskId === selectedTask?.taskId} key={task.taskId} onClick={() => onChooseTask(task.taskId)} task={task} />) : <Empty title={mode === "completed" ? "还没有已完成任务" : mode === "recycle-bin" ? "回收站为空" : "还没有进行中 Task"} detail={mode === "completed" ? "只有在你明确点击 Achieve 后，Task 才会显示在这里。" : mode === "recycle-bin" ? "归档一个已 Achieve 且没有活跃 Provider Binding 的 Task 后，它会出现在这里。" : "先从一个已发布的 Agent Loop Template 创建 Task。"} />}
        </div>
        <nav aria-label="任务分组" className="awb-agent-loop-task-groups">
          <button aria-pressed={mode === "active"} className={mode === "active" ? "active" : ""} onClick={() => onChooseMode("active")} type="button"><ClipboardCheck size={15} /><span>进行中任务</span><b>{activeCount}</b><ChevronRight size={15} /></button>
          <button aria-pressed={mode === "completed"} className={mode === "completed" ? "active" : ""} onClick={() => onChooseMode("completed")} type="button"><Archive size={15} /><span>已完成任务</span><b>{completedCount}</b><ChevronRight size={15} /></button>
          <button aria-pressed={mode === "recycle-bin"} className={mode === "recycle-bin" ? "active" : ""} onClick={() => onChooseMode("recycle-bin")} type="button"><Trash2 size={15} /><span>回收站</span><b>{recycledCount}</b><ChevronRight size={15} /></button>
        </nav>
      </aside>

      <PaneResizer edge="list" onPointerDown={startDrag} />

      <section className="awb-agent-loop-center">
        {selectedTask ? <>
          <header className="awb-agent-loop-task-head">
            <div className="awb-agent-loop-task-head-copy">
              <p className="awb-agent-loop-eyebrow">Task / {selectedSession ? `${selectedSession.title} Session` : mode === "completed" ? "Completed history" : mode === "recycle-bin" ? "Recycle bin" : "Agent Loop"}</p>
              <h1>{selectedTask.title}</h1>
              {!selectedSession ? <p>{selectedTask.goal}</p> : null}
            </div>
            <div className="awb-agent-loop-task-actions">
              {selectedTask.trashedAt ? <>
                <button className="awb-button awb-button-secondary" disabled={Boolean(actionKey)} onClick={() => void onRestore(selectedTask).catch(() => undefined)} type="button"><RotateCcw size={14} /> 恢复 Task</button>
                <button className="awb-button awb-button-danger" disabled={Boolean(actionKey)} onClick={() => void openPermanentDelete()} type="button"><Trash2 size={14} /> 永久删除</button>
              </> : <>
                {selectedTask.status === "queued" ? <button className="awb-button awb-button-primary" disabled={Boolean(actionKey) || !conductorReady} onClick={() => onStart(selectedTask)} title={launchReadinessLabel} type="button"><Play size={15} /> 启动 Agent Loop</button> : null}
                {selectedTask.status === "stopped" ? <button className="awb-button awb-button-primary" disabled={Boolean(actionKey) || !conductorReady} onClick={() => onRestart(selectedTask)} title={launchReadinessLabel} type="button"><Play size={15} /> 重新启动</button> : null}
                {["queued", "stopped"].includes(selectedTask.status) && !conductorReady ? <span className="awb-agent-loop-launch-readiness" role="status">{launchReadinessLabel}</span> : null}
                {canStop ? <button className="awb-button awb-button-secondary awb-button-danger" disabled={Boolean(actionKey)} onClick={() => setStopTarget(selectedTask)} type="button"><Square size={14} /> 停止任务</button> : null}
                {selectedSession ? <button aria-pressed={drawer === "timeline"} className={`awb-button awb-button-secondary ${drawer === "timeline" ? "is-active" : ""}`} onClick={() => setDrawer((current) => current === "timeline" ? undefined : "timeline")} type="button"><FileText size={14} /> 时间线</button> : null}
                {detail?.artifacts.length ? <button aria-pressed={drawer === "artifacts"} className={`awb-button awb-button-secondary ${drawer === "artifacts" ? "is-active" : ""}`} onClick={() => setDrawer((current) => current === "artifacts" ? undefined : "artifacts")} type="button"><Eye size={14} /> 产物</button> : null}
                {!selectedTask.achievement ? <button className="awb-button awb-button-primary" disabled={Boolean(actionKey)} onClick={() => onAchieve(selectedTask)} type="button"><CheckCircle2 size={15} /> Achieve</button> : <>
                  <span className="awb-agent-loop-achieved"><CheckCircle2 size={15} /> 已 Achieve</span>
                  {canResume && detail?.activeRun ? <button className="awb-button awb-button-secondary" disabled={Boolean(actionKey)} onClick={() => onResume(selectedTask, detail.activeRun!.runId)} type="button"><Play size={14} /> 拉回继续</button> : null}
                  <button className="awb-button awb-button-secondary" disabled={Boolean(actionKey) || canStop} onClick={() => void onArchive(selectedTask).catch(() => undefined)} type="button"><Archive size={14} /> 移入回收站</button>
                </>}
              </>}
            </div>
          </header>
          {!selectedSession ? <div className="awb-agent-loop-context-bar"><b>Agent Loop</b><ChevronRight size={14} /><span>{selectedTask.trashedAt ? "此 Task 在回收站中；可恢复原身份，或在确认受管产物后永久删除。" : selectedTask.achievement ? "此 Task 已由你 Achieve；它的 Run 和 Provider 状态仍按 Runtime 事实展示。" : "启动后，选择右侧的 Conductor 或已派发 Session Agent 继续对话。"}</span></div> : null}
          <div className="awb-agent-loop-task-body">
            {selectedSession && detail ? <div className="awb-agent-loop-session-workspace">
              <SessionTabBar
                onChooseSession={onChooseSession}
                selectedSessionId={selectedSession.logicalSessionId}
                sessions={detail.sessions}
              />
              {conductorSession ? <TaskConductorComposer
                composer={{
                  message: composerDrafts[composerKey(selectedTask.taskId, conductorSession.logicalSessionId)] ?? "",
                  disabled: !detail.activeRun || Boolean(actionKey),
                  continuity: continuityFor(detail, conductorSession),
                }}
                onChange={(message) => onComposerChange(selectedTask.taskId, conductorSession.logicalSessionId, message)}
                onSubmit={onSubmitInput}
                session={conductorSession}
                taskId={selectedTask.taskId}
              /> : null}
              <AgentLoopSessionPresentation
              attentions={selectedAttentions}
              binding={{
                label: selectedSession.binding?.provider ?? "未绑定",
                status: selectedSession.binding?.status ?? "unbound",
                ...(selectedSession.binding?.recoverable ? { detail: "可恢复" } : {}),
              }}
              composer={{
                message: composerDrafts[composerKey(selectedTask.taskId, selectedSession.logicalSessionId)] ?? "",
                disabled: !detail.activeRun || Boolean(actionKey),
                stopDisabled: !canStop || Boolean(actionKey),
                continuity: continuityFor(detail, selectedSession),
              }}
              onComposerChange={(message) => onComposerChange(selectedTask.taskId, selectedSession.logicalSessionId, message)}
              onRespondAttention={onRespondAttention}
              onStopTask={canStop ? onStop : undefined}
              onSubmitInput={onSubmitInput}
              executionGroups={executionGroupsForSession(detail, selectedSession)}
              messages={messagesForSession(detail, selectedSession)}
              session={{
                logicalSessionId: selectedSession.logicalSessionId,
                agentCardId: selectedSession.agentCardId,
                title: selectedSession.title,
                kind: selectedSession.kind,
                status: selectedSession.status,
              }}
                showComposer={selectedSession.kind === "card"}
                taskId={selectedTask.taskId}
              />
            </div> : <TaskTimeline detail={detail} task={selectedTask} />}
          </div>
          {drawer && detail ? <TaskDrawer detail={detail} kind={drawer} onClose={() => setDrawer(undefined)} onPreviewArtifact={openArtifactPreview} previewingArtifactId={artifactPreviewingId} /> : null}
        </> : <Empty title={mode === "completed" ? "还没有已完成任务" : "还没有进行中 Task"} detail="从已发布的 Template 创建 Task 后，它会显示在这里。" />}
      </section>

      <PaneResizer disabled={inspectorCollapsed} edge="inspector" onPointerDown={startDrag} />
        <TaskInspector
          collapsed={inspectorCollapsed}
          detail={detail}
          onChooseSession={onChooseSession}
          onPreviewArtifact={openArtifactPreview}
          onToggle={() => setInspectorCollapsed((current) => !current)}
          previewingArtifactId={artifactPreviewingId}
        selectedSessionId={selectedSession?.logicalSessionId}
      />

      {stopTarget ? <StopTaskDialog busy={Boolean(actionKey)} onCancel={() => setStopTarget(undefined)} onConfirm={() => {
        const current = detail;
        const session = selectedSession;
        if (!current || !session) return;
        void onStop({ taskId: stopTarget.taskId, logicalSessionId: session.logicalSessionId }).finally(() => setStopTarget(undefined));
      }} task={stopTarget} /> : null}
      {artifactPreview ? <ArtifactPreviewDialog onClose={() => setArtifactPreview(undefined)} preview={artifactPreview} /> : null}
      {permanentDelete ? <PermanentDeleteDialog
        busy={Boolean(actionKey)}
        onCancel={() => setPermanentDelete(undefined)}
        onConfirm={(artifactIds) => void onPermanentlyDelete(permanentDelete.task, artifactIds).then(() => setPermanentDelete(undefined)).catch(() => undefined)}
        preview={permanentDelete.preview}
        task={permanentDelete.task}
      /> : null}
      {permanentDeleteError ? <div className="awb-notice is-error awb-agent-loop-inline-notice" role="alert">{permanentDeleteError}<button aria-label="关闭删除错误" onClick={() => setPermanentDeleteError(undefined)} type="button">×</button></div> : null}
    </div>
  );
}

function TaskConductorComposer({ composer, onChange, onSubmit, session, taskId }: Readonly<{
  composer: Readonly<{
    message: string;
    disabled: boolean;
    continuity: ReturnType<typeof continuityFor>;
  }>;
  onChange: (message: string) => void;
  onSubmit: (input: AgentLoopComposerSubmission) => Promise<void>;
  session: AgentLoopSessionItem;
  taskId: string;
}>) {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string>();
  const disabled = composer.disabled || isSubmitting;

  const submit = useCallback(async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const content = composer.message.trim();
    if (disabled || !content) return;
    setError(undefined);
    setIsSubmitting(true);
    try {
      await onSubmit({ taskId, targetLogicalSessionId: session.logicalSessionId, content });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setIsSubmitting(false);
    }
  }, [composer.message, disabled, onSubmit, session.logicalSessionId, taskId]);

  return <section aria-label="Task Conductor composer" className="awb-agent-loop-task-conductor-dock">
    <header><strong>Task → Conductor</strong><span>固定任务入口；切换 Worker Tab 不会改变目标。</span></header>
    <form className="awb-agent-loop-task-conductor-composer" onSubmit={(event) => void submit(event)}>
      <label>Task → Conductor<textarea
        disabled={disabled}
        onChange={(event) => {
          setError(undefined);
          onChange(event.target.value);
        }}
        placeholder="补充任务目标、纠正结论，或要求 Conductor 重新核实。"
        rows={2}
        value={composer.message}
      /></label>
      <footer>
        <div>{error ? <p role="alert">{error}</p> : <span>{composer.continuity.message}</span>}</div>
        <button className="awb-button awb-button-primary" disabled={disabled || !composer.message.trim()} type="submit"><Send size={14} />{isSubmitting ? "发送中…" : "发送给 Conductor"}</button>
      </footer>
    </form>
  </section>;
}

function PaneResizer({
  disabled,
  edge,
  onPointerDown,
}: Readonly<{
  disabled?: boolean;
  edge: "list" | "inspector";
  onPointerDown: (edge: "list" | "inspector", event: React.PointerEvent<HTMLButtonElement>) => void;
}>) {
  const label = edge === "list" ? "调整任务列表宽度" : "调整 Session 目录宽度";
  return <button aria-label={label} className={`awb-agent-loop-pane-resizer is-${edge}`} disabled={disabled} onPointerDown={(event) => onPointerDown(edge, event)} role="separator" tabIndex={disabled ? -1 : 0} title={label} type="button" />;
}

function TaskInspector({
  collapsed,
  detail,
  onChooseSession,
  onPreviewArtifact,
  onToggle,
  previewingArtifactId,
  selectedSessionId,
}: Readonly<{
  collapsed: boolean;
  detail?: AgentLoopTaskDetail;
  onChooseSession: (logicalSessionId: string) => void;
  onPreviewArtifact: (artifact: AgentLoopArtifactItem) => Promise<void>;
  onToggle: () => void;
  previewingArtifactId?: string;
  selectedSessionId?: string;
}>) {
  if (collapsed) return <aside className="awb-agent-loop-inspector awb-agent-loop-inspector-collapsed"><button aria-label="展开 Session 目录" className="awb-agent-loop-inspector-toggle" onClick={onToggle} type="button"><ChevronLeft size={17} /></button></aside>;
  return <aside className="awb-agent-loop-inspector">
    <header className="awb-agent-loop-panel-heading"><div><p className="awb-agent-loop-eyebrow">Session directory</p><h2>Task Sessions</h2></div><button aria-label="收起 Session 目录" className="awb-agent-loop-icon-button" onClick={onToggle} type="button"><ChevronRight size={17} /></button></header>
    {detail?.sessions.length ? <div className="awb-agent-loop-session-list">
      {detail.sessions.map((session) => <SessionCard active={session.logicalSessionId === selectedSessionId} key={session.logicalSessionId} onClick={() => onChooseSession(session.logicalSessionId)} session={session} />)}
    </div> : <Empty title="尚未产生 Session" detail="Task 启动后，Conductor 与被派发的 Session Agent 会在这里出现。" />}
    {detail?.artifacts.length ? <section className="awb-agent-loop-artifact-list"><h3>已验证产物</h3>{detail.artifacts.map((artifact) => <div key={artifact.artifactId}><span><strong>{artifact.displayName}</strong><small>{artifact.verifiedAt}</small></span><button aria-label={`预览 ${artifact.displayName}`} className="awb-agent-loop-artifact-preview" disabled={previewingArtifactId === artifact.artifactId} onClick={() => void onPreviewArtifact(artifact).catch(() => undefined)} type="button"><Eye size={14} /> {previewingArtifactId === artifact.artifactId ? "读取中…" : "预览"}</button></div>)}</section> : null}
  </aside>;
}

function StopTaskDialog({ busy, onCancel, onConfirm, task }: Readonly<{
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  task: AgentLoopTaskListItem;
}>) {
  return <div aria-label="停止 Task 确认" aria-modal="true" className="awb-agent-loop-modal-backdrop" role="dialog">
    <button aria-label="取消停止 Task" className="awb-agent-loop-modal-scrim" onClick={onCancel} type="button" />
    <section className="awb-agent-loop-modal">
      <header><div><p>STOP TASK</p><h2>停止“{task.title}”吗？</h2></div><button aria-label="关闭停止确认" className="awb-agent-loop-icon-button" disabled={busy} onClick={onCancel} type="button">×</button></header>
      <div className="awb-agent-loop-modal-copy"><p>这会请求停止当前 Run 的 Provider Session。Task、Run、Timeline 和已登记的产物仍会保留。</p><p><strong>不会删除项目文件。</strong>停止是否完成，必须由 Runtime 和 Provider 事实确认。</p></div>
      <footer><button className="awb-button awb-button-secondary" disabled={busy} onClick={onCancel} type="button">取消</button><button className="awb-button awb-button-primary awb-button-danger" disabled={busy} onClick={onConfirm} type="button">{busy ? "停止中…" : "停止任务"}</button></footer>
    </section>
  </div>;
}

function ArtifactPreviewDialog({ onClose, preview }: Readonly<{
  onClose: () => void;
  preview: ArtifactPreviewReadModel;
}>) {
  const copy = artifactPreviewCopy(preview);
  return <div aria-label="产物预览" aria-modal="true" className="awb-agent-loop-modal-backdrop" role="dialog">
    <button aria-label="关闭产物预览" className="awb-agent-loop-modal-scrim" onClick={onClose} type="button" />
    <section className="awb-agent-loop-modal awb-agent-loop-artifact-preview-dialog">
      <header><div><p>MANAGED ARTIFACT</p><h2>{preview.displayName}</h2></div><button aria-label="关闭产物预览" className="awb-agent-loop-icon-button" onClick={onClose} type="button">×</button></header>
      <div className="awb-agent-loop-modal-copy">
        <p>{copy}</p>
        {preview.state === "available" && preview.content !== undefined
          ? preview.contentType === "text/html"
            ? <AgentLoopArtifactHtmlPreview html={preview.content} title={`${preview.displayName} HTML preview`} />
            : <pre aria-label="产物文本内容">{preview.content}</pre>
          : null}
        {preview.state === "available" && preview.truncated ? <p><strong>内容已截断。</strong>Runtime 只提供受限文本预览；不会把本地文件路径或句柄交给页面。</p> : null}
      </div>
      <footer><button className="awb-button awb-button-primary" onClick={onClose} type="button">关闭</button></footer>
    </section>
  </div>;
}

function PermanentDeleteDialog({ busy, onCancel, onConfirm, preview, task }: Readonly<{
  busy: boolean;
  onCancel: () => void;
  onConfirm: (artifactIds: readonly string[]) => void;
  preview: TaskPermanentDeletePreview;
  task: AgentLoopTaskListItem;
}>) {
  const [selectedArtifactIds, setSelectedArtifactIds] = useState<readonly string[]>(() =>
    preview.artifacts.filter((artifact) => artifact.state === "deletable").map((artifact) => artifact.artifactId),
  );
  const toggleArtifact = (artifactId: string) => setSelectedArtifactIds((current) =>
    current.includes(artifactId) ? current.filter((candidate) => candidate !== artifactId) : [...current, artifactId],
  );
  return <div aria-label="永久删除 Task 确认" aria-modal="true" className="awb-agent-loop-modal-backdrop" role="dialog">
    <button aria-label="取消永久删除" className="awb-agent-loop-modal-scrim" disabled={busy} onClick={onCancel} type="button" />
    <section className="awb-agent-loop-modal awb-agent-loop-permanent-delete-dialog">
      <header><div><p>PERMANENT DELETE</p><h2>永久删除“{task.title}”吗？</h2></div><button aria-label="关闭永久删除确认" className="awb-agent-loop-icon-button" disabled={busy} onClick={onCancel} type="button">×</button></header>
      <div className="awb-agent-loop-modal-copy">
        <p>这会删除 Runtime 中的 Task、Run、Session、Timeline 与关联记录。只有你勾选的、Host 再次校验为未变化的受管产物才会尝试从项目中删除。</p>
        <p><strong>未勾选的产物会保留在项目中。</strong>页面始终只按 Artifact ID 请求操作，不接收文件路径。</p>
        {preview.artifacts.length ? <ul className="awb-agent-loop-delete-artifact-list">{preview.artifacts.map((artifact) => {
          const deletable = artifact.state === "deletable";
          return <li key={artifact.artifactId}>
            <label><input aria-label={`删除产物 ${artifact.displayName}`} checked={selectedArtifactIds.includes(artifact.artifactId)} disabled={!deletable || busy} onChange={() => toggleArtifact(artifact.artifactId)} type="checkbox" /><span><strong>{artifact.displayName}</strong><small>{deletable ? "内容未变化，可选择删除" : deletionStateLabel(artifact.state)}</small></span></label>
          </li>;
        })}</ul> : <p>没有登记的受管产物；本次只会删除 Runtime Task 历史。</p>}
      </div>
      <footer><button className="awb-button awb-button-secondary" disabled={busy} onClick={onCancel} type="button">取消</button><button className="awb-button awb-button-danger" disabled={busy} onClick={() => onConfirm(selectedArtifactIds)} type="button">{busy ? "删除中…" : "永久删除 Task"}</button></footer>
    </section>
  </div>;
}

function TaskDrawer({
  detail,
  kind,
  onClose,
  onPreviewArtifact,
  previewingArtifactId,
}: Readonly<{
  detail: AgentLoopTaskDetail;
  kind: "timeline" | "artifacts";
  onClose: () => void;
  onPreviewArtifact: (artifact: AgentLoopArtifactItem) => Promise<void>;
  previewingArtifactId?: string;
}>) {
  return <div aria-label={kind === "timeline" ? "Task 时间线" : "已验证产物"} className="awb-agent-loop-side-drawer" role="complementary">
    <header><strong>{kind === "timeline" ? "Task 时间线" : "已验证产物"}</strong><button aria-label="关闭侧栏" className="awb-agent-loop-icon-button" onClick={onClose} type="button">×</button></header>
    {kind === "timeline" ? <ol className="awb-agent-loop-timeline">{detail.timeline.map((item) => <li className={`awb-agent-loop-timeline-entry ${timelineClass(item.kind)}`} key={item.timelineItemId}><div><strong>{item.title}</strong><span>{item.occurredAt}</span></div>{item.detail ? <p>{item.detail}</p> : null}</li>)}</ol> : <div className="awb-agent-loop-side-drawer-list">{detail.artifacts.map((artifact) => <article key={artifact.artifactId}><div><strong>{artifact.displayName}</strong><span>{artifact.verifiedAt}</span></div><button aria-label={`预览 ${artifact.displayName}`} className="awb-button awb-button-secondary awb-button-compact" disabled={previewingArtifactId === artifact.artifactId} onClick={() => void onPreviewArtifact(artifact).catch(() => undefined)} type="button"><Eye size={13} /> {previewingArtifactId === artifact.artifactId ? "读取中…" : "预览"}</button></article>)}</div>}
  </div>;
}

function TaskTimeline({ detail, task }: Readonly<{ detail?: AgentLoopTaskDetail; task: AgentLoopTaskListItem }>) {
  const timeline = detail?.timeline ?? [];
  return <section aria-label="Task 时间线" className="awb-agent-loop-timeline-surface">
    <div className="awb-agent-loop-timeline-intro"><strong>Task 目标</strong><p>{task.goal}</p></div>
    {timeline.length ? <ol className="awb-agent-loop-timeline">{timeline.map((item) => <li className={`awb-agent-loop-timeline-entry ${timelineClass(item.kind)}`} data-kind={item.kind} key={item.timelineItemId}><div><strong>{item.title}</strong><span>{item.occurredAt}</span></div>{item.detail ? <p>{item.detail}</p> : null}{item.status ? <em>{item.status}</em> : null}</li>)}</ol> : <Empty title="还没有规范化 Timeline 事实" detail="启动 Task 或继续 Session 后，Runtime 会把可展示的事实投影到这里。" />}
  </section>;
}

function TaskRow({ active, onClick, task }: Readonly<{ active: boolean; onClick: () => void; task: AgentLoopTaskListItem }>) {
  return <button aria-current={active || undefined} aria-pressed={active} className={`awb-agent-loop-task-row ${active ? "is-active" : ""}`} onClick={onClick} type="button"><i className={`awb-agent-loop-state-dot is-${task.status}`} /><span className="awb-agent-loop-task-row-copy"><strong>{task.title}</strong><small>{task.trashedAt ? "已移入回收站" : task.achievement ? "用户已 Achieve" : task.goal}</small></span><em>{taskStatusLabel(task)}</em></button>;
}

function SessionCard({ active, onClick, session }: Readonly<{ active: boolean; onClick: () => void; session: AgentLoopSessionItem }>) {
  return <button aria-current={active || undefined} aria-pressed={active} className={`awb-agent-loop-session-card ${active ? "is-active" : ""}`} onClick={onClick} type="button"><Bot size={16} /><span className="awb-agent-loop-session-card-copy"><strong>{session.title}</strong><small>{session.kind === "conductor" ? "Owner · Conductor" : `Session Agent · ${session.executionProfileId}`}</small></span><em className={`is-${session.status}`}>{session.status}</em></button>;
}

function SessionTabBar({
  onChooseSession,
  selectedSessionId,
  sessions,
}: Readonly<{
  onChooseSession: (logicalSessionId: string) => void;
  selectedSessionId: string;
  sessions: readonly AgentLoopSessionItem[];
}>) {
  return <div aria-label="Task Session Tabs" className="awb-agent-loop-session-tabs" role="tablist">
    {sessions.map((session) => {
      const selected = session.logicalSessionId === selectedSessionId;
      return <button
        aria-selected={selected}
        className={selected ? "is-active" : undefined}
        key={session.logicalSessionId}
        onClick={() => onChooseSession(session.logicalSessionId)}
        role="tab"
        type="button"
      >
        <span>{session.title}</span>
        <small>{session.status}</small>
      </button>;
    })}
  </div>;
}

function Empty({ detail, title }: Readonly<{ detail: string; title: string }>) {
  return <div className="awb-agent-loop-empty"><strong>{title}</strong><p>{detail}</p></div>;
}

function attentionsForSession(detail: AgentLoopTaskDetail | undefined, session: AgentLoopSessionItem) {
  if (!detail || !session.binding) return [];
  return detail.attentions
    .filter((attention) => attention.bindingId === session.binding?.bindingId && attention.status === "requested")
    .map((attention) => ({
      attentionId: attention.attentionId,
      title: attention.title,
      status: attention.status,
      ...(attention.prompt ? { prompt: attention.prompt } : {}),
      ...(attention.options ? { options: attention.options } : {}),
    }));
}

/**
 * Message visibility is established by the typed Runtime read model.  This UI
 * projection only groups a selected Session's own Messages with immutable
 * Messages that have a durable Inbox item targeting it; it never parses
 * Provider facts, relay fences, or artifact files to manufacture context.
 */
function messagesForSession(detail: AgentLoopTaskDetail, session: AgentLoopSessionItem) {
  return detail.messages.filter((message) =>
    message.sourceLogicalSessionId === session.logicalSessionId
      || message.inboxDeliveries.some((delivery) => delivery.targetLogicalSessionId === session.logicalSessionId),
  );
}

function executionGroupsForSession(detail: AgentLoopTaskDetail, session: AgentLoopSessionItem) {
  return detail.executionGroups.filter((group) => group.logicalSessionId === session.logicalSessionId);
}

function continuityFor(detail: AgentLoopTaskDetail, session: AgentLoopSessionItem) {
  if (!detail.activeRun) return { state: "closed" as const, message: "当前没有活跃 Run；可查看历史，但不能继续发送输入。" };
  if (session.status === "unrecoverable" || session.binding?.status === "unrecoverable") return { state: "recovery_required" as const, message: "此 Session 无法恢复；Runtime 未创建替代 Provider Session。" };
  if (detail.activeRun.status === "stopping") return { state: "stopping" as const, message: "Task 正在停止；等待 Runtime 与 Provider 确认。" };
  return { state: "connected" as const, message: "输入会先成为不可变 Message，再由 Runtime 的 Inbox 可靠投递。" };
}

function composerKey(taskId: string, logicalSessionId: string): string {
  return `${taskId}:${logicalSessionId}`;
}

function timelineClass(kind: string): string {
  if (kind.startsWith("provider_") || kind === "artifact_verified") return "is-provider";
  if (kind.startsWith("attention_")) return "is-attention";
  if (kind === "input_submitted" || kind === "user_achieved") return "is-user";
  return "is-runtime";
}

function taskStatusLabel(task: AgentLoopTaskListItem): string {
  if (task.trashedAt) return "回收站";
  if (task.achievement) return "Achieve";
  return ({ queued: "待启动", running: "运行中", stopping: "停止中", stopped: "已停止", blocked: "需处理" } as Record<string, string>)[task.status] ?? task.status;
}

function conductorReadinessLabel(readiness: AgentLoopTaskDetail["conductorReadiness"]): string {
  if (!readiness) return "Conductor Provider 尚未完成可用性检查";
  switch (readiness.status) {
    case "available": return "Conductor Provider 已通过可用性检查";
    case "checking": return "正在检查 Conductor Provider";
    case "version_mismatch": return "Conductor Provider 版本不匹配";
    case "capability_missing": return "Conductor Provider 缺少必需能力";
    case "unavailable": return "Conductor Provider 当前不可用";
  }
}

function artifactPreviewCopy(preview: ArtifactPreviewReadModel): string {
  return ({
    available: preview.byteLength ? `已安全读取 ${preview.byteLength} bytes 的受限文本预览。` : "产物可预览。",
    missing: "该产物已不在受管项目位置，无法预览。",
    changed: "该产物的当前内容已变化，Runtime 拒绝将它当作已验证产物预览。",
    too_large: "该产物超过安全预览上限。",
    unsupported: "该产物不是受支持的文本预览类型。",
  } satisfies Record<ArtifactPreviewReadModel["state"], string>)[preview.state];
}

function deletionStateLabel(state: TaskPermanentDeletePreview["artifacts"][number]["state"]): string {
  return ({
    deletable: "内容未变化，可选择删除",
    missing: "文件不存在，将只删除 Runtime 记录",
    changed: "内容已变化，Runtime 会保留项目文件",
    too_large: "无法安全核验，将保留项目文件",
    unsupported: "类型不受支持，将保留项目文件",
  } satisfies Record<TaskPermanentDeletePreview["artifacts"][number]["state"], string>)[state];
}

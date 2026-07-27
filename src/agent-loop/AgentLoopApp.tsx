import {
  Archive,
  Bot,
  Boxes,
  CheckCircle2,
  ChevronRight,
  ClipboardCheck,
  Clock3,
  Columns2,
  Copy,
  Files,
  FilePlus2,
  Layers2,
  LayoutPanelTop,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Rows2,
  Sun,
  Moon,
  TerminalSquare,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { PtyTerminal } from "../components/PtyTerminal";
import {
  archiveNativeAgentLoopTemplate,
  appendNativeTaskEvent,
  copyNativeAgentLoopTemplate,
  createNativeAgentLoopTask,
  defaultOpencodeRunModel,
  deleteNativeAgentLoopTemplate,
  enqueueNativeTerminalInput,
  generateNativeAgentLoopTemplate,
  isNativeAgentLoopRuntimeAvailable,
  listNativeAgentLoopTasks,
  listNativeAgentLoopTemplates,
  markNativeAgentLoopTaskAchieved,
  readNativeAgentLoopArtifact,
  readNativeAgentLoopRun,
  readNativeWorkspaceTerminalLog,
  resizeNativePtySession,
  saveNativeAgentLoopWorkbenchLayout,
  saveNativeAgentLoopTemplate,
  startNativeAgentLoopRun,
  subscribeNativeAgentLoopRuntimeEvents,
  type NativeAgentLoopRunDetail,
  type NativeAgentLoopWorkbenchLayout,
  type NativeAgentLoopWorkbenchLayoutNode,
  type NativeAgentLoopTask,
  type NativeAgentLoopTemplate,
  type NativeAgentLoopArtifact,
  type NativeTerminalDiagnosticLog,
  type NativeSessionAgentCard,
} from "../runtime/nativeBridge";
import {
  canSplitTerminalPane,
  clampSplitRatioForBounds,
  collapseWorkbenchLayoutToBounds,
  leafGroupIds,
  moveSessionToGroup,
  reconcileWorkbenchLayout,
  selectGroupSession,
  setGroupTerminalFontSize,
  splitGroup,
  updateSplitRatio,
} from "./workbenchLayout";

type View = "tasks" | "templates" | "workbench";
type Theme = "dark" | "light";
type TemplateDraft = Omit<NativeAgentLoopTemplate, "version" | "archivedAt" | "createdAt" | "updatedAt">;

const defaultCard = (id = "researcher"): NativeSessionAgentCard => ({
  id,
  name: id === "researcher" ? "Researcher" : "New Session Agent",
  kind: id === "researcher" ? "researcher" : "general",
  role: "Carry out one bounded assignment from Conductor and return evidence.",
  model: defaultOpencodeRunModel,
  mcp: [],
  skills: [],
  instructions: "",
  expectedOutput: "Markdown with evidence, artifact paths, and remaining risks.",
});

function blankTemplate(): TemplateDraft {
  return {
    id: `loop-${Date.now().toString(36)}`,
    name: "New Agent Loop",
    description: "Conductor owns every Session Agent dispatch and reacts only to semantic Runtime returns.",
    source: "manual",
    conductor: {
      role: "Conductor",
      model: defaultOpencodeRunModel,
      charter: "Decide each next dispatch from the task goal, durable Session returns, and user follow-ups. Use the available cards as capabilities, never as a fixed route.",
    },
    agents: [defaultCard()],
    limits: { maxConcurrentSessions: 3, maxDispatchesPerDecision: 3 },
    delivery: { artifactPath: "", ownerAgentId: "" },
  };
}

export function AgentLoopApp({ projectPath, projectName }: { projectPath: string; projectName: string }) {
  const runtimeAvailable = isNativeAgentLoopRuntimeAvailable();
  const [view, setView] = useState<View>("tasks");
  const [theme, setTheme] = useState<Theme>("dark");
  const [templates, setTemplates] = useState<NativeAgentLoopTemplate[]>([]);
  const [tasks, setTasks] = useState<NativeAgentLoopTask[]>([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>();
  const [selectedTaskId, setSelectedTaskId] = useState<string>();
  const [run, setRun] = useState<NativeAgentLoopRunDetail>();
  const [selectedSessionId, setSelectedSessionId] = useState<string>();
  const [showTaskCreate, setShowTaskCreate] = useState(false);
  const [showTemplateStarter, setShowTemplateStarter] = useState(false);
  const [showTemplateEditor, setShowTemplateEditor] = useState(false);
  const [repairingTemplate, setRepairingTemplate] = useState(false);
  const [templateDraft, setTemplateDraft] = useState<TemplateDraft>(blankTemplate());
  const [templateDescription, setTemplateDescription] = useState("");
  const [returnToTaskAfterTemplate, setReturnToTaskAfterTemplate] = useState(false);
  const [taskTitle, setTaskTitle] = useState("");
  const [taskGoal, setTaskGoal] = useState("");
  const [taskTemplateId, setTaskTemplateId] = useState("");
  const [busy, setBusy] = useState(false);
  const [messageBusy, setMessageBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [artifactPreview, setArtifactPreview] = useState<NativeAgentLoopArtifact>();

  const selectedTemplate = templates.find((template) => template.id === selectedTemplateId) ?? templates[0];
  const selectedTask = tasks.find((task) => task.taskId === selectedTaskId) ?? tasks[0];

  const acceptRun = useCallback((detail: NativeAgentLoopRunDetail) => {
    setRun(detail);
    setTasks((current) => current.map((task) => task.taskId === detail.task.taskId ? { ...task, ...detail.task, latestRun: detail.run } : task));
    setSelectedSessionId((current) => current && detail.turns.some((turn) => turn.sessionId === current) ? current : detail.turns[0]?.sessionId);
  }, []);

  const refresh = useCallback(async (preferredTaskId?: string) => {
    const [nextTemplates, nextTasks] = await Promise.all([listNativeAgentLoopTemplates(), listNativeAgentLoopTasks()]);
    setTemplates(nextTemplates);
    setTasks(nextTasks);
    const preferred = nextTasks.find((task) => task.taskId === preferredTaskId || task.taskId === selectedTaskId) ?? nextTasks[0];
    const template = nextTemplates.find((item) => item.id === selectedTemplateId) ?? nextTemplates[0];
    setSelectedTemplateId(template?.id);
    setTaskTemplateId((current) => nextTemplates.some((item) => item.id === current) ? current : template?.id ?? "");
    setSelectedTaskId(preferred?.taskId);
    if (preferred?.latestRun?.runId) {
      const detail = await readNativeAgentLoopRun(preferred.latestRun.runId);
      if (detail) acceptRun(detail);
    } else {
      setRun(undefined);
      setSelectedSessionId(undefined);
    }
  }, [acceptRun, selectedTaskId, selectedTemplateId]);

  useEffect(() => {
    void refresh().catch((reason: unknown) => setError(messageFor(reason)));
  }, []); // First desktop load only; refresh has deliberate live selection inputs.

  const refreshRun = useCallback((runId: string) => {
    return readNativeAgentLoopRun(runId)
      .then((next) => next && acceptRun(next))
      .catch((reason: unknown) => setError(messageFor(reason)));
  }, [acceptRun]);

  useEffect(() => {
    if (!run) return undefined;
    // Push is the primary path. This is only recovery for a renderer that
    // missed an invalidation while reloading; it is not tied to a task or PTY
    // status and therefore cannot freeze a live semantic Run.
    const timer = window.setInterval(() => {
      void refreshRun(run.run.runId);
    }, 3_000);
    return () => window.clearInterval(timer);
  }, [refreshRun, run?.run.runId]);

  useEffect(() => subscribeNativeAgentLoopRuntimeEvents((event) => {
    if (event.runId === run?.run.runId) {
      void refreshRun(event.runId);
      return;
    }
    // Keep inactive Task tabs up to date without using raw terminal traffic as
    // a Task-state source. The selected Run is refreshed by its own signal.
    void listNativeAgentLoopTasks().then(setTasks).catch((reason: unknown) => setError(messageFor(reason)));
  }), [refreshRun, run?.run.runId]);

  const openNewTemplate = (description = "", returnToTask = false) => {
    setTemplateDescription(description);
    setReturnToTaskAfterTemplate(returnToTask);
    setError(undefined);
    setShowTemplateStarter(true);
  };
  const openManualTemplate = () => {
    setTemplateDraft(blankTemplate());
    setRepairingTemplate(false);
    setError(undefined);
    setShowTemplateStarter(false);
    setShowTemplateEditor(true);
  };
  const openTemplateEdit = (template: NativeAgentLoopTemplate) => {
    setTemplateDraft(templateDraftFrom(template));
    setRepairingTemplate(false);
    setError(undefined);
    setShowTemplateEditor(true);
  };
  const openTemplateRepair = (template: NativeAgentLoopTemplate, returnToTask = false) => {
    setTemplateDraft(repairTemplateDraft(template));
    setRepairingTemplate(true);
    setReturnToTaskAfterTemplate(returnToTask);
    setError(undefined);
    setShowTemplateEditor(true);
  };

  const generateTemplate = async () => {
    if (!templateDescription.trim()) return;
    setBusy(true);
    setError(undefined);
    try {
      const generated = await generateNativeAgentLoopTemplate({
        cwd: projectPath,
        projectName,
        description: templateDescription.trim(),
      });
      if (!generated) throw new Error("桌面 Runtime 未返回 Template 草案。");
      setTemplateDraft(generated.template);
      setRepairingTemplate(false);
      setShowTemplateStarter(false);
      setShowTemplateEditor(true);
    } catch (reason) {
      setError(messageFor(reason));
    } finally {
      setBusy(false);
    }
  };

  const saveTemplate = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const saved = await saveNativeAgentLoopTemplate(templateDraft);
      if (!saved) throw new Error("桌面 Runtime 未返回保存后的 Loop Template。");
      const reopenTask = returnToTaskAfterTemplate;
      setSelectedTemplateId(saved.id);
      setShowTemplateEditor(false);
      setRepairingTemplate(false);
      await refresh();
      setSelectedTemplateId(saved.id);
      if (reopenTask) {
        setTaskTemplateId(saved.id);
        setReturnToTaskAfterTemplate(false);
        setShowTaskCreate(true);
      }
    } catch (reason) {
      setError(messageFor(reason));
    } finally {
      setBusy(false);
    }
  };

  const copyTemplate = async () => {
    if (!selectedTemplate) return;
    setBusy(true);
    try {
      const copied = await copyNativeAgentLoopTemplate(selectedTemplate.id, `${selectedTemplate.name} copy`);
      if (!copied) throw new Error("桌面 Runtime 未返回复制后的 Template。");
      setSelectedTemplateId(copied.id);
      await refresh();
    } catch (reason) {
      setError(messageFor(reason));
    } finally { setBusy(false); }
  };

  const archiveTemplate = async () => {
    if (!selectedTemplate || !window.confirm(`归档 “${selectedTemplate.name}”？已有 Task 的快照不会改变。`)) return;
    setBusy(true);
    try {
      await archiveNativeAgentLoopTemplate(selectedTemplate.id);
      await refresh();
    } catch (reason) { setError(messageFor(reason)); } finally { setBusy(false); }
  };

  const deleteTemplate = async () => {
    if (!selectedTemplate || !window.confirm(`删除 “${selectedTemplate.name}”？仅未被 Task 引用的 Template 可删除。`)) return;
    setBusy(true);
    try {
      await deleteNativeAgentLoopTemplate(selectedTemplate.id);
      await refresh();
    } catch (reason) { setError(messageFor(reason)); } finally { setBusy(false); }
  };

  const createTask = async () => {
    const template = templates.find((item) => item.id === taskTemplateId);
    if (!template) return;
    setBusy(true);
    setError(undefined);
    try {
      const task = await createNativeAgentLoopTask({
        cwd: projectPath,
        projectId: projectName,
        title: taskTitle.trim(),
        goal: taskGoal.trim(),
        templateId: template.id,
        templateVersion: template.version,
      });
      if (!task) throw new Error("桌面 Runtime 未创建 Task。");
      setShowTaskCreate(false);
      setSelectedTaskId(task.taskId);
      await refresh(task.taskId);
    } catch (reason) { setError(messageFor(reason)); } finally { setBusy(false); }
  };

  const startRun = async () => {
    if (!selectedTask) return;
    setBusy(true);
    setError(undefined);
    try {
      const detail = await startNativeAgentLoopRun(selectedTask.taskId);
      if (!detail) throw new Error("桌面 Runtime 未创建 Agent Loop Run。");
      acceptRun(detail);
      setView("workbench");
      await refresh(selectedTask.taskId);
    } catch (reason) { setError(messageFor(reason)); } finally { setBusy(false); }
  };

  const markAchieved = async () => {
    if (!selectedTask) return;
    setBusy(true);
    try {
      await markNativeAgentLoopTaskAchieved(selectedTask.taskId);
      await refresh(selectedTask.taskId);
    } catch (reason) { setError(messageFor(reason)); } finally { setBusy(false); }
  };

  const sendTaskMessage = useCallback(async (message: string) => {
    if (!selectedTask || !message.trim()) return;
    setMessageBusy(true);
    setError(undefined);
    try {
      const result = await appendNativeTaskEvent({
        taskId: selectedTask.taskId,
        cwd: selectedTask.cwd,
        type: "task.user_message",
        summary: message.trim(),
        data: { message: message.trim() },
      });
      if (!result.ok) throw new Error(result.error || "无法将消息交给 Conductor。");
      await refresh(selectedTask.taskId);
    } catch (reason) {
      setError(messageFor(reason));
      throw reason;
    } finally {
      setMessageBusy(false);
    }
  }, [refresh, selectedTask]);

  const openArtifact = async (artifactPath: string) => {
    if (!run) return;
    try {
      const artifact = await readNativeAgentLoopArtifact(run.run.runId, artifactPath);
      if (!artifact) throw new Error("桌面 Runtime 未返回产物内容。");
      setArtifactPreview(artifact);
    } catch (reason) { setError(messageFor(reason)); }
  };

  const timeline = useMemo(() => buildTimeline(selectedTask, run), [selectedTask, run]);

  return (
    <div className={`harness-app agent-loop-app ${view === "workbench" ? "agent-loop-workbench-active" : ""} theme-${theme}`}>
      <aside className="harness-rail">
        <div className="harness-brand"><Boxes size={21} /> <span>Agent Workspace</span></div>
        <nav aria-label="Agent Loop pages">
          <RailButton active={view === "tasks"} onClick={() => setView("tasks")} icon={<ClipboardCheck size={18} />} label="任务" />
          <RailButton active={view === "templates"} onClick={() => setView("templates")} icon={<Layers2 size={18} />} label="模板" />
          <RailButton active={view === "workbench"} onClick={() => setView("workbench")} icon={<TerminalSquare size={18} />} label="运行现场" />
        </nav>
        <div className="harness-rail-bottom">
          <button className="harness-icon-button" aria-label="切换主题" onClick={() => setTheme((current) => current === "dark" ? "light" : "dark")}>{theme === "dark" ? <Sun size={17} /> : <Moon size={17} />}</button>
          <span className="harness-provider">OpenCode · {defaultOpencodeRunModel}</span>
        </div>
      </aside>
      <main className={`harness-main ${!runtimeAvailable ? "has-browser-preview" : ""}`}>
        <header className="harness-header">
          <div><strong>{projectName}</strong><span>{projectPath}</span></div>
          <div className="harness-header-actions">
            <span className={`harness-runtime-dot ${runtimeAvailable ? "" : "offline"}`}>{runtimeAvailable ? "Runtime online" : "浏览器预览 · 只读"}</span>
            <button className="harness-secondary-button compact" onClick={() => void refresh()}><RefreshCw size={14} /> 刷新</button>
          </div>
        </header>
        {!runtimeAvailable && <div className="harness-browser-preview"><strong>同一套 Agent Loop 界面</strong><span>浏览器只用于查看布局；创建 Template、Task、Run 和原生 PTY 只在 Electron 内可用。</span></div>}
        {view === "tasks" && <TaskSurface
          tasks={tasks} selectedTask={selectedTask} run={run} timeline={timeline} runtimeAvailable={runtimeAvailable} busy={busy} messageBusy={messageBusy}
          onSelect={(task) => { setSelectedTaskId(task.taskId); if (task.latestRun?.runId) void readNativeAgentLoopRun(task.latestRun.runId).then((detail) => detail && acceptRun(detail)); else setRun(undefined); }}
          onCreate={() => { setTaskTitle(""); setTaskGoal(""); setTaskTemplateId(selectedTemplate?.id ?? ""); setShowTaskCreate(true); }}
          onStart={startRun} onAchieved={markAchieved} onMessage={sendTaskMessage} onWorkbench={() => setView("workbench")} onArtifact={(path) => void openArtifact(path)} />}
        {view === "templates" && <TemplateSurface
          templates={templates} selectedTemplate={selectedTemplate} runtimeAvailable={runtimeAvailable} busy={busy}
          onSelect={(template) => setSelectedTemplateId(template.id)} onCreate={openNewTemplate} onEdit={openTemplateEdit}
          onRepair={openTemplateRepair} onCopy={() => void copyTemplate()} onArchive={() => void archiveTemplate()} onDelete={() => void deleteTemplate()} />}
        {view === "workbench" && <WorkbenchSurface
          run={run} tasks={tasks} selectedTaskId={selectedTask?.taskId} selectedSessionId={selectedSessionId} runtimeAvailable={runtimeAvailable}
          onSelectTask={(task) => {
            setSelectedTaskId(task.taskId);
            if (task.latestRun?.runId) void readNativeAgentLoopRun(task.latestRun.runId).then((detail) => detail && acceptRun(detail));
          }}
          onSelectSession={setSelectedSessionId}
          onArtifact={(path) => void openArtifact(path)}
          onLayoutChange={async (layout) => {
            if (!run) return;
            const saved = await saveNativeAgentLoopWorkbenchLayout(run.run.runId, layout);
            if (saved) setRun((current) => current?.run.runId === run.run.runId ? { ...current, workbenchLayout: saved } : current);
          }} />}
      </main>
      {showTaskCreate && <TaskDialog
        templates={templates} title={taskTitle} goal={taskGoal} templateId={taskTemplateId} busy={busy} enabled={runtimeAvailable}
        onTitle={setTaskTitle} onGoal={setTaskGoal} onTemplate={setTaskTemplateId} onClose={() => setShowTaskCreate(false)} onCreateTemplate={() => { setShowTaskCreate(false); openNewTemplate(taskGoal, true); }} onCreate={() => void createTask()} />}
      {showTemplateStarter && <TemplateStarterDialog description={templateDescription} busy={busy} enabled={runtimeAvailable} onDescription={setTemplateDescription} onClose={() => { setShowTemplateStarter(false); setReturnToTaskAfterTemplate(false); }} onManual={openManualTemplate} onGenerate={() => void generateTemplate()} />}
      {showTemplateEditor && <TemplateDialog draft={templateDraft} repairing={repairingTemplate} busy={busy} enabled={runtimeAvailable} onChange={setTemplateDraft} onClose={() => { setShowTemplateEditor(false); setRepairingTemplate(false); setReturnToTaskAfterTemplate(false); }} onSave={() => void saveTemplate()} />}
      {artifactPreview && <ArtifactDialog artifact={artifactPreview} onClose={() => setArtifactPreview(undefined)} />}
      {error && <div className="harness-error" role="alert">{error}</div>}
    </div>
  );
}

function RailButton({ active, onClick, icon, label }: { active: boolean; onClick: () => void; icon: import("react").ReactNode; label: string }) {
  return <button className={`harness-rail-button ${active ? "active" : ""}`} onClick={onClick}>{icon}<span>{label}</span></button>;
}

function TaskSurface({ tasks, selectedTask, run, timeline, runtimeAvailable, busy, messageBusy, onSelect, onCreate, onStart, onAchieved, onMessage, onWorkbench, onArtifact }: {
  tasks: NativeAgentLoopTask[]; selectedTask?: NativeAgentLoopTask; run?: NativeAgentLoopRunDetail; timeline: TimelineItem[]; runtimeAvailable: boolean; busy: boolean; messageBusy: boolean;
  onSelect: (task: NativeAgentLoopTask) => void; onCreate: () => void; onStart: () => void; onAchieved: () => void; onMessage: (message: string) => Promise<void>; onWorkbench: () => void; onArtifact: (path: string) => void;
}) {
  return <div className="harness-task-layout">
    <aside className="harness-task-list"><div className="harness-panel-title"><h1>任务</h1><button className="harness-primary-button compact" disabled={!runtimeAvailable} onClick={onCreate}><Plus size={15} /> 新建</button></div><p className="harness-list-caption">每个 Task 固定快照一个 Agent Loop Template；完成交付后可标记 achieved。</p>{tasks.map((task) => <button className={`harness-task-row ${task.taskId === selectedTask?.taskId ? "active" : ""}`} key={task.taskId} onClick={() => onSelect(task)}><i className={`harness-state-dot ${task.status}`} /><span><strong>{task.title}</strong><small>{task.architecture.template.name} · v{task.architecture.template.version}</small></span><em>{statusLabel(task.status)}</em></button>)}</aside>
    <section className="harness-timeline-panel">{selectedTask ? <>
      <header className="harness-task-head"><div><div className="harness-breadcrumb">Task / Agent Loop</div><h1>{selectedTask.title}</h1><p>{selectedTask.goal}</p></div><div className="harness-task-actions">{selectedTask.status === "queued" && <button className="harness-primary-button" disabled={!runtimeAvailable || busy} onClick={onStart}><Play size={15} /> 启动 Agent Loop</button>}{selectedTask.status === "running" && <button className="harness-secondary-button" onClick={onWorkbench}><TerminalSquare size={15} /> 进入运行现场</button>}{selectedTask.status === "delivery_ready" && <button className="harness-primary-button" disabled={busy || !runtimeAvailable} onClick={onAchieved}><CheckCircle2 size={15} /> 已检查产物，标记 achieved</button>}{selectedTask.status === "achieved" && <span className="harness-achieved-label"><CheckCircle2 size={15} /> achieved</span>}</div></header>
      <div className="harness-timeline-meta"><b>Agent Loop</b><ChevronRight size={14} /><span>Conductor 派发原生 Session Agent；每次结果、失败或需要输入才唤醒 Conductor。</span></div>
      <div className="harness-conversation">{timeline.map((item) => <TimelineMessage item={item} key={item.id} />)}</div>
      {selectedTask.status !== "queued" && <TaskConversationComposer disabled={!runtimeAvailable || messageBusy} onSubmit={onMessage} />}
    </> : <Empty title="还没有 Task" detail="先从已保存的 Agent Loop Template 创建一个任务。" />}</section>
    <TaskInspector task={selectedTask} run={run} onWorkbench={onWorkbench} onArtifact={onArtifact} />
  </div>;
}

function TemplateSurface({ templates, selectedTemplate, runtimeAvailable, busy, onSelect, onCreate, onEdit, onRepair, onCopy, onArchive, onDelete }: {
  templates: NativeAgentLoopTemplate[]; selectedTemplate?: NativeAgentLoopTemplate; runtimeAvailable: boolean; busy: boolean; onSelect: (template: NativeAgentLoopTemplate) => void;
  onCreate: () => void; onEdit: (template: NativeAgentLoopTemplate) => void; onRepair: (template: NativeAgentLoopTemplate) => void; onCopy: () => void; onArchive: () => void; onDelete: () => void;
}) {
  const executionIssue = selectedTemplate ? templateExecutionIssue(selectedTemplate) : "";
  return <div className="harness-template-layout">
    <aside className="harness-template-list"><div className="harness-panel-title"><h1>Loop Templates</h1><button className="harness-primary-button compact" disabled={!runtimeAvailable} onClick={() => onCreate()}><Plus size={15} /> 新建</button></div><p className="harness-list-caption">卡片定义稳定能力边界；Conductor 只在其中派发本次工作契约。</p>{templates.map((template) => <button className={`harness-template-row ${template.id === selectedTemplate?.id ? "active" : ""} ${templateExecutionIssue(template) ? "needs-repair" : ""}`} onClick={() => onSelect(template)} key={template.id}><Bot size={16} /><span><strong>{template.name}</strong><small>{templateExecutionIssue(template) ? "需要修复后才能创建 Task" : `Agent Loop · v${template.version} · ${template.agents.length} cards`}</small></span></button>)}</aside>
    <section className="harness-template-canvas">{selectedTemplate ? <>
      <header className="harness-template-head"><div><div className="harness-breadcrumb">Template / Agent Loop</div><h1>{selectedTemplate.name}</h1><p>{selectedTemplate.description}</p></div><div className="agent-loop-template-actions">{executionIssue ? <button className="harness-primary-button compact" disabled={!runtimeAvailable || busy} onClick={() => onRepair(selectedTemplate)}><Pencil size={14} /> 修复为新版本</button> : <button className="harness-secondary-button compact" disabled={!runtimeAvailable || busy} onClick={() => onEdit(selectedTemplate)}><Pencil size={14} /> 编辑 / 新版本</button>}<button className="harness-secondary-button compact" disabled={!runtimeAvailable || busy} onClick={onCopy}><Copy size={14} /> 复制</button><button className="harness-secondary-button compact" disabled={!runtimeAvailable || busy} onClick={onArchive}><Archive size={14} /> 归档</button><button className="harness-secondary-button compact danger" disabled={!runtimeAvailable || busy} onClick={onDelete}><Trash2 size={14} /> 删除</button></div></header>
      {executionIssue && <div className="agent-loop-template-repair-note"><strong>此 Template 需要修复</strong><span>{executionIssue}</span><button className="harness-primary-button compact" disabled={!runtimeAvailable || busy} onClick={() => onRepair(selectedTemplate)}>修复为新版本</button></div>}
      <div className="agent-loop-contract-note"><strong>边界</strong><span>Conductor：{selectedTemplate.conductor.role}。每张卡片定义可用能力；Conductor 每次自行决定是否派发，并写入目标、输入、验收和预期产物。Runtime 不执行业务路线。</span></div>
      <div className="agent-loop-card-grid">{selectedTemplate.agents.map((card) => <AgentCard key={card.id} card={card} />)}</div>
    </> : <Empty title="还没有 Template" detail="创建一个 Agent Loop Template，再配置它的原生 Session Agent 卡片。" />}</section>
    <aside className="harness-inspector">{selectedTemplate ? <><h2>Conductor Charter</h2><InspectorRow label="模型" value={selectedTemplate.conductor.model} /><InspectorRow label="Session cards" value={`${selectedTemplate.agents.length} 张`} /><InspectorRow label="交付路径偏好" value={selectedTemplate.delivery.artifactPath || "未声明"} /><section className="harness-inspector-section"><strong>决策原则</strong><p>{selectedTemplate.conductor.charter || "Conductor 根据任务、Session 返回与用户补充决定每一步；Runtime 不提供固定路线。"}</p></section></> : null}</aside>
  </div>;
}

function WorkbenchSurface({
  run,
  tasks,
  selectedTaskId,
  selectedSessionId,
  runtimeAvailable,
  onSelectTask,
  onSelectSession,
  onArtifact,
  onLayoutChange,
}: {
  run?: NativeAgentLoopRunDetail;
  tasks: NativeAgentLoopTask[];
  selectedTaskId?: string;
  selectedSessionId?: string;
  runtimeAvailable: boolean;
  onSelectTask: (task: NativeAgentLoopTask) => void;
  onSelectSession: (sessionId: string) => void;
  onArtifact: (path: string) => void;
  onLayoutChange: (layout: NativeAgentLoopWorkbenchLayout) => Promise<void>;
}) {
  const runId = run?.run.runId;
  const knownSessionIds = useMemo(() => run?.turns.map((turn) => turn.sessionId) ?? [], [run?.turns]);
  const knownSessionKey = knownSessionIds.join("|");
  const [layout, setLayout] = useState<NativeAgentLoopWorkbenchLayout>();
  const [drawer, setDrawer] = useState<"timeline" | "artifacts" | "terminal-log">();
  const [terminalLog, setTerminalLog] = useState<NativeTerminalDiagnosticLog>();
  const [terminalLogError, setTerminalLogError] = useState<string>();
  const [terminalLogSessionId, setTerminalLogSessionId] = useState<string>();
  const [pickerGroupId, setPickerGroupId] = useState<string>();
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const groupBodiesRef = useRef(new Map<string, HTMLDivElement>());
  const [terminalRects, setTerminalRects] = useState<Record<string, DOMRect>>({});
  const [canvasBounds, setCanvasBounds] = useState<{ width: number; height: number }>();

  useEffect(() => {
    setDrawer(undefined);
    setTerminalLog(undefined);
    setTerminalLogError(undefined);
    setTerminalLogSessionId(undefined);
    setPickerGroupId(undefined);
    setLayout(run ? reconcileWorkbenchLayout(run.workbenchLayout, run.turns.map((turn) => turn.sessionId)) : undefined);
  }, [runId]);

  useEffect(() => {
    if (!run) return;
    setLayout((current) => reconcileWorkbenchLayout(current ?? run.workbenchLayout, knownSessionIds));
  }, [knownSessionKey, runId]);

  const updateTerminalRects = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const parent = canvas.getBoundingClientRect();
    setCanvasBounds((current) => current && Math.abs(current.width - parent.width) < .5 && Math.abs(current.height - parent.height) < .5 ? current : { width: parent.width, height: parent.height });
    const next = Object.fromEntries([...groupBodiesRef.current.entries()].map(([groupId, element]) => {
      const rect = element.getBoundingClientRect();
      return [groupId, new DOMRect(rect.left - parent.left, rect.top - parent.top, rect.width, rect.height)];
    }));
    setTerminalRects((current) => sameTerminalRects(current, next) ? current : next);
  }, []);

  const registerGroupBody = useCallback((groupId: string, element: HTMLDivElement | null) => {
    if (element) groupBodiesRef.current.set(groupId, element);
    else groupBodiesRef.current.delete(groupId);
    window.requestAnimationFrame(updateTerminalRects);
  }, [updateTerminalRects]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(() => window.requestAnimationFrame(updateTerminalRects));
    observer.observe(canvas);
    groupBodiesRef.current.forEach((element) => observer.observe(element));
    window.addEventListener("resize", updateTerminalRects);
    window.requestAnimationFrame(updateTerminalRects);
    return () => { observer.disconnect(); window.removeEventListener("resize", updateTerminalRects); };
  }, [layout?.root, updateTerminalRects]);

  useEffect(() => {
    if (!canvasBounds) return;
    setLayout((current) => {
      if (!current) return current;
      const next = collapseWorkbenchLayoutToBounds(current, canvasBounds);
      if (next !== current) void onLayoutChange(next).catch(() => undefined);
      return next;
    });
  }, [canvasBounds, onLayoutChange]);

  const updateLayout = useCallback((mutate: (current: NativeAgentLoopWorkbenchLayout) => NativeAgentLoopWorkbenchLayout, persist = true) => {
    setLayout((current) => {
      if (!current) return current;
      const next = reconcileWorkbenchLayout(mutate(current), knownSessionIds);
      if (persist) void onLayoutChange(next).catch(() => undefined);
      return next;
    });
  }, [knownSessionKey, onLayoutChange]);

  const runnableTasks = tasks.filter((task) => task.latestRun?.runId);
  const timeline = useMemo(() => buildTimeline(run?.task, run), [run]);
  const turnsBySession = useMemo(() => new Map((run?.turns ?? []).map((turn) => [turn.sessionId, turn])), [run?.turns]);
  const attentionSessions = useMemo(() => new Set((run?.attentions ?? []).map((attention) => String(attention.sessionId ?? "")).filter(Boolean)), [run?.attentions]);
  const activeDispatchCount = (run?.turns ?? []).filter((turn) => ["queued", "input_accepted", "delivered"].includes(String(turn.dispatchStatus))).length;
  const liveTerminalCount = (run?.turns ?? []).filter((turn) => turn.terminalStatus === "live").length;
  const activeSessionId = selectedSessionId && turnsBySession.has(selectedSessionId)
    ? selectedSessionId
    : layout?.groups[layout.focusedGroupId]?.activeSessionId ?? run?.turns[0]?.sessionId;
  const activeTurn = activeSessionId ? turnsBySession.get(activeSessionId) : undefined;
  const openTerminalLog = async () => {
    if (!run || !activeSessionId) return;
    setDrawer("terminal-log");
    setTerminalLog(undefined);
    setTerminalLogError(undefined);
    setTerminalLogSessionId(activeSessionId);
    try {
      const next = await readNativeWorkspaceTerminalLog({
        taskId: run.task.taskId,
        workspaceSessionId: activeSessionId,
        maxBytes: 512 * 1024,
      });
      if (!next) throw new Error("桌面 Runtime 未返回终端诊断日志。");
      setTerminalLog(next);
    } catch (reason) {
      setTerminalLogError(messageFor(reason));
    }
  };

  return <section className="agent-loop-workbench" aria-label="Task Run terminal workspace">
    <header className="agent-loop-task-tabs">
      <div className="agent-loop-task-tabs-scroll" role="tablist" aria-label="Task Runs">
        {runnableTasks.map((task) => {
          const active = task.taskId === selectedTaskId;
          const count = active ? run?.turns.length : undefined;
          return <button className={`agent-loop-task-tab ${active ? "active" : ""}`} role="tab" aria-selected={active} key={task.taskId} onClick={() => onSelectTask(task)}>
            <i className={`harness-state-dot ${task.status}`} />
            <span>{task.title}</span>
            <small>{count ? `${count} Session` : statusLabel(task.status)}</small>
          </button>;
        })}
      </div>
    </header>
    {run && <div className="agent-loop-run-context"><div><strong>{run.task.title}</strong><span className={run.task.status}>{statusLabel(run.task.status)}</span><small>{activeDispatchCount} active dispatches · {liveTerminalCount} PTYs live · {attentionSessions.size ? `${attentionSessions.size} needs attention` : "no attention"}</small></div><div className="agent-loop-workbench-actions"><button className={drawer === "timeline" ? "active" : ""} onClick={() => setDrawer((value) => value === "timeline" ? undefined : "timeline")}><Clock3 size={14} /> 时间线</button><button className={drawer === "artifacts" ? "active" : ""} onClick={() => setDrawer((value) => value === "artifacts" ? undefined : "artifacts")}><Files size={14} /> 产物</button><button className={drawer === "terminal-log" ? "active" : ""} disabled={!activeTurn} onClick={() => void openTerminalLog()} title={activeTurn ? `查看 ${activeTurn.details.card.name} 的原始 PTY 诊断历史` : "先选择一个 Session"}><TerminalSquare size={14} /> 终端历史</button></div></div>}
    {!run || !layout ? <Empty title="尚无运行中的 Task" detail="从任务页启动 Agent Loop 后，这里会成为该 Task Run 的原生终端工作区。" /> : <div className="agent-loop-workbench-canvas" ref={canvasRef} onMouseDown={() => setPickerGroupId(undefined)}>
      <WorkbenchGroupTree
        node={layout.root}
        path=""
        layout={layout}
        turnsBySession={turnsBySession}
        attentionSessions={attentionSessions}
        terminalRects={terminalRects}
        canvasBounds={canvasBounds}
        pickerGroupId={pickerGroupId}
        onOpenPicker={(groupId) => setPickerGroupId((current) => current === groupId ? undefined : groupId)}
        onRegisterBody={registerGroupBody}
        onFocusGroup={(groupId) => updateLayout((current) => ({ ...current, focusedGroupId: groupId }), false)}
        onSelectSession={(groupId, sessionId) => {
          updateLayout((current) => selectGroupSession(current, groupId, sessionId));
          onSelectSession(sessionId);
        }}
        onMoveSession={(sessionId, groupId) => updateLayout((current) => moveSessionToGroup(current, sessionId, groupId))}
        onSplitGroup={(groupId, direction) => updateLayout((current) => splitGroup(current, groupId, direction))}
        onResizeSplit={(path, ratio, persist) => updateLayout((current) => updateSplitRatio(current, path, ratio), persist)}
        onSetGroupFontSize={(groupId, fontSize) => updateLayout((current) => setGroupTerminalFontSize(current, groupId, fontSize))}
      />
      <TerminalOverlayLayer layout={layout} turns={run.turns} terminalRects={terminalRects} runtimeAvailable={runtimeAvailable} onFontSizeChange={(groupId, fontSize) => updateLayout((current) => setGroupTerminalFontSize(current, groupId, fontSize))} />
      {drawer && <WorkbenchDrawer kind={drawer} timeline={timeline} artifacts={run.artifacts} terminalLog={terminalLog} terminalLogError={terminalLogError} terminalLogSessionName={terminalLogSessionId ? turnsBySession.get(terminalLogSessionId)?.details.card.name : undefined} onArtifact={onArtifact} onClose={() => setDrawer(undefined)} />}
    </div>}
  </section>;
}

function WorkbenchGroupTree({
  node,
  path,
  layout,
  turnsBySession,
  attentionSessions,
  terminalRects,
  canvasBounds,
  pickerGroupId,
  onOpenPicker,
  onRegisterBody,
  onFocusGroup,
  onSelectSession,
  onMoveSession,
  onSplitGroup,
  onResizeSplit,
  onSetGroupFontSize,
}: {
  node: NativeAgentLoopWorkbenchLayoutNode;
  path: string;
  layout: NativeAgentLoopWorkbenchLayout;
  turnsBySession: Map<string, NativeAgentLoopRunDetail["turns"][number]>;
  attentionSessions: Set<string>;
  terminalRects: Record<string, DOMRect>;
  canvasBounds?: { width: number; height: number };
  pickerGroupId?: string;
  onOpenPicker: (groupId: string) => void;
  onRegisterBody: (groupId: string, element: HTMLDivElement | null) => void;
  onFocusGroup: (groupId: string) => void;
  onSelectSession: (groupId: string, sessionId: string) => void;
  onMoveSession: (sessionId: string, groupId: string) => void;
  onSplitGroup: (groupId: string, direction: "horizontal" | "vertical") => void;
  onResizeSplit: (path: string, ratio: number, persist: boolean) => void;
  onSetGroupFontSize: (groupId: string, fontSize: number) => void;
}) {
  if (node.type === "leaf") {
    const group = layout.groups[node.groupId];
    return <SessionGroupPanel
      group={group}
      groupId={node.groupId}
      layout={layout}
      turnsBySession={turnsBySession}
      attentionSessions={attentionSessions}
      paneBounds={terminalRects[node.groupId] ?? canvasBounds}
      pickerOpen={pickerGroupId === node.groupId}
      onOpenPicker={onOpenPicker}
      onRegisterBody={onRegisterBody}
      onFocusGroup={onFocusGroup}
      onSelectSession={onSelectSession}
      onMoveSession={onMoveSession}
      onSplitGroup={onSplitGroup}
      onSetGroupFontSize={onSetGroupFontSize}
    />;
  }
  return <SplitGroupPanel direction={node.direction} ratio={node.ratio} path={path} onResize={onResizeSplit}>
    <WorkbenchGroupTree {...{ node: node.first, path: path ? `${path}.first` : "first", layout, turnsBySession, attentionSessions, terminalRects, canvasBounds, pickerGroupId, onOpenPicker, onRegisterBody, onFocusGroup, onSelectSession, onMoveSession, onSplitGroup, onResizeSplit, onSetGroupFontSize }} />
    <WorkbenchGroupTree {...{ node: node.second, path: path ? `${path}.second` : "second", layout, turnsBySession, attentionSessions, terminalRects, canvasBounds, pickerGroupId, onOpenPicker, onRegisterBody, onFocusGroup, onSelectSession, onMoveSession, onSplitGroup, onResizeSplit, onSetGroupFontSize }} />
  </SplitGroupPanel>;
}

function SplitGroupPanel({ direction, ratio, path, onResize, children }: { direction: "horizontal" | "vertical"; ratio: number; path: string; onResize: (path: string, ratio: number, persist: boolean) => void; children: [import("react").ReactNode, import("react").ReactNode] }) {
  const splitRef = useRef<HTMLDivElement | null>(null);
  const ratioFor = (event: React.PointerEvent<HTMLButtonElement>) => {
    const rect = splitRef.current?.getBoundingClientRect();
    if (!rect) return ratio;
    const raw = direction === "horizontal" ? (event.clientX - rect.left) / rect.width : (event.clientY - rect.top) / rect.height;
    return clampSplitRatioForBounds({ width: rect.width, height: rect.height }, direction, raw);
  };
  return <div className={`agent-loop-split agent-loop-split-${direction}`} ref={splitRef}>
    <div className="agent-loop-split-child" style={{ flexBasis: `${ratio * 100}%` }}>{children[0]}</div>
    <button className={`agent-loop-split-handle ${direction}`} aria-label={direction === "horizontal" ? "调整左右分屏" : "调整上下分屏"} onPointerDown={(event) => event.currentTarget.setPointerCapture(event.pointerId)} onPointerMove={(event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) onResize(path, ratioFor(event), false); }} onPointerUp={(event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) { onResize(path, ratioFor(event), true); event.currentTarget.releasePointerCapture(event.pointerId); } }} />
    <div className="agent-loop-split-child" style={{ flexBasis: `${(1 - ratio) * 100}%` }}>{children[1]}</div>
  </div>;
}

function SessionGroupPanel({ group, groupId, layout, turnsBySession, attentionSessions, paneBounds, pickerOpen, onOpenPicker, onRegisterBody, onFocusGroup, onSelectSession, onMoveSession, onSplitGroup, onSetGroupFontSize }: {
  group: NativeAgentLoopWorkbenchLayout["groups"][string] | undefined;
  groupId: string;
  layout: NativeAgentLoopWorkbenchLayout;
  turnsBySession: Map<string, NativeAgentLoopRunDetail["turns"][number]>;
  attentionSessions: Set<string>;
  paneBounds?: { width: number; height: number };
  pickerOpen: boolean;
  onOpenPicker: (groupId: string) => void;
  onRegisterBody: (groupId: string, element: HTMLDivElement | null) => void;
  onFocusGroup: (groupId: string) => void;
  onSelectSession: (groupId: string, sessionId: string) => void;
  onMoveSession: (sessionId: string, groupId: string) => void;
  onSplitGroup: (groupId: string, direction: "horizontal" | "vertical") => void;
  onSetGroupFontSize: (groupId: string, fontSize: number) => void;
}) {
  const sessionIds = group?.sessionIds ?? [];
  const activeSessionId = group?.activeSessionId ?? sessionIds[0];
  const availableTurns = [...turnsBySession.values()];
  const fontSize = group?.fontSize ?? 11;
  const canSplitHorizontal = canSplitTerminalPane(paneBounds, "horizontal");
  const canSplitVertical = canSplitTerminalPane(paneBounds, "vertical");
  return <section className={`agent-loop-session-group ${layout.focusedGroupId === groupId ? "focused" : ""}`} onMouseDown={(event) => { event.stopPropagation(); onFocusGroup(groupId); }} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); const sessionId = event.dataTransfer.getData("application/x-agent-workspace-session"); if (sessionId) onMoveSession(sessionId, groupId); }}>
    <header className="agent-loop-group-tabs">
      <div className="agent-loop-group-tab-list" role="tablist" aria-label={`Session Group ${groupId}`}>
        {sessionIds.map((sessionId) => {
          const turn = turnsBySession.get(sessionId);
          if (!turn) return null;
          const attention = attentionSessions.has(sessionId);
          const dispatchState = sessionDispatchLabel(turn.dispatchStatus ?? turn.status);
          const terminalState = terminalLifecycleLabel(turn.terminalStatus);
          return <button className={`agent-loop-session-tab ${activeSessionId === sessionId ? "active" : ""} ${attention ? "attention" : ""}`} draggable key={sessionId} onDragStart={(event) => { event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("application/x-agent-workspace-session", sessionId); }} onClick={() => onSelectSession(groupId, sessionId)} title={`${turn.details.card.name} · ${dispatchState} · terminal ${terminalState}`}><i className={`harness-state-dot ${attention ? "attention" : turn.status}`} /><span>{turn.details.card.name}</span><small>{turn.purpose === "conductor" ? "Conductor" : `${dispatchState} · ${terminalState}`}</small></button>;
        })}
      </div>
      <div className="agent-loop-group-actions">
        <button aria-label="缩小终端文字" title="缩小终端文字（⌘-）" disabled={fontSize <= 8} onClick={() => onSetGroupFontSize(groupId, fontSize - 1)}>A−</button>
        <button aria-label="放大终端文字" title="放大终端文字（⌘+）" disabled={fontSize >= 18} onClick={() => onSetGroupFontSize(groupId, fontSize + 1)}>A+</button>
        <button aria-label="左右分屏" title={canSplitHorizontal ? "左右分屏" : "当前空间不足，保持 Tab 以避免压缩 OpenCode TUI"} disabled={!canSplitHorizontal} onClick={() => onSplitGroup(groupId, "horizontal")}><Columns2 size={14} /></button>
        <button aria-label="上下分屏" title={canSplitVertical ? "上下分屏" : "当前空间不足，保持 Tab 以避免压缩 OpenCode TUI"} disabled={!canSplitVertical} onClick={() => onSplitGroup(groupId, "vertical")}><Rows2 size={14} /></button>
        <button aria-label="移动已启动 Session 到此 Group" title="移动已启动 Session 到此 Group" onClick={() => onOpenPicker(groupId)}><Plus size={15} /></button>
      </div>
      {pickerOpen && <div className="agent-loop-session-picker" role="menu"><strong>移动已启动的 Session</strong>{availableTurns.map((turn) => <button role="menuitem" key={turn.sessionId} onClick={() => { onMoveSession(turn.sessionId, groupId); onOpenPicker(groupId); }}><i className={`harness-state-dot ${turn.status}`} /><span>{turn.details.card.name}</span><small>{turn.purpose === "conductor" ? "Conductor" : "Session Agent"}</small></button>)}</div>}
    </header>
    <div className="agent-loop-group-terminal-body" ref={(element) => onRegisterBody(groupId, element)} data-group-terminal={groupId}>
      {!sessionIds.length && <div className="agent-loop-empty-group"><LayoutPanelTop size={20} /><strong>空 Group</strong><span>点击 + 将一个已启动的 Session 移到这里；不会启动新 Agent。</span></div>}
    </div>
  </section>;
}

function TerminalOverlayLayer({ layout, turns, terminalRects, runtimeAvailable, onFontSizeChange }: { layout: NativeAgentLoopWorkbenchLayout; turns: NativeAgentLoopRunDetail["turns"]; terminalRects: Record<string, DOMRect>; runtimeAvailable: boolean; onFontSizeChange: (groupId: string, fontSize: number) => void }) {
  const groupForSession = new Map<string, string>();
  for (const groupId of leafGroupIds(layout.root)) for (const sessionId of layout.groups[groupId]?.sessionIds ?? []) groupForSession.set(sessionId, groupId);
  return <div className="agent-loop-terminal-overlay-layer">{turns.map((turn) => {
    const groupId = groupForSession.get(turn.sessionId);
    const rect = groupId ? terminalRects[groupId] : undefined;
    const active = Boolean(groupId && layout.groups[groupId]?.activeSessionId === turn.sessionId && rect && rect.width > 0 && rect.height > 0);
    if (!groupId || !rect) return null;
    return <div className={`agent-loop-terminal-overlay-pane ${active ? "active" : "inactive"}`} data-session-terminal={turn.sessionId} key={turn.sessionId} style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height }}>
      <PtyTerminal ariaLabel={`${turn.details.card.name} OpenCode terminal`} className="agent-loop-native-terminal" command={`opencode --model ${turn.details.card.model}`} session={turn.terminal} transcriptLines={turn.terminal?.transcript ?? []} emptyTitle="等待原生 OpenCode Session" emptyDetail={turn.purpose === "conductor" ? "Conductor 正在启动。" : "只有 Conductor 派发此卡片后，原生 Session 才会启动。"} isVisible={active} readOnly={!runtimeAvailable} fontSize={layout.groups[groupId]?.fontSize ?? 11} onFontSizeChange={(fontSize) => onFontSizeChange(groupId, fontSize)} onData={(payload) => { if (turn.terminal?.incarnationId) void enqueueNativeTerminalInput({ workspaceSessionId: turn.sessionId, expectedIncarnationId: turn.terminal.incarnationId, source: "user", payload, idempotencyKey: `user:${Date.now()}` }); }} onResize={(cols, rows) => { if (turn.terminal?.incarnationId) void resizeNativePtySession(turn.sessionId, { cols, rows }, turn.terminal.incarnationId); }} />
    </div>;
  })}</div>;
}

function WorkbenchDrawer({ kind, timeline, artifacts, terminalLog, terminalLogError, terminalLogSessionName, onArtifact, onClose }: { kind: "timeline" | "artifacts" | "terminal-log"; timeline: TimelineItem[]; artifacts: NativeAgentLoopRunDetail["artifacts"]; terminalLog?: NativeTerminalDiagnosticLog; terminalLogError?: string; terminalLogSessionName?: string; onArtifact: (path: string) => void; onClose: () => void }) {
  const eyebrow = kind === "timeline" ? "TASK TIMELINE" : kind === "artifacts" ? "DELIVERY ARTIFACTS" : "TERMINAL DIAGNOSTICS";
  const title = kind === "timeline" ? "任务时间线" : kind === "artifacts" ? "产物" : `${terminalLogSessionName ?? "Session"} · 终端历史`;
  return <aside className="agent-loop-workbench-drawer" aria-label={title}>
    <header><div><span>{eyebrow}</span><h2>{title}</h2></div><button aria-label="关闭抽屉" onClick={onClose}>×</button></header>
    <div className="agent-loop-workbench-drawer-content">{kind === "timeline" ? timeline.map((item) => <TimelineMessage item={item} key={item.id} />) : kind === "artifacts" ? artifacts.length ? artifacts.map((artifact) => <button className="agent-loop-artifact-row" disabled={!artifact.exists || !artifact.previewable} key={artifact.path} onClick={() => onArtifact(artifact.path)}><FilePlus2 size={16} /><span><strong>{artifact.path}</strong><small>{artifact.exists ? `${artifact.size ?? 0} bytes · 打开预览` : "等待生成"}</small></span><ChevronRight size={15} /></button>) : <Empty title="尚未声明产物" detail="Conductor 声明交付并满足 Template 规则后，产物会显示在这里。" /> : <TerminalDiagnosticLog log={terminalLog} error={terminalLogError} />}</div>
  </aside>;
}

function TerminalDiagnosticLog({ log, error }: { log?: NativeTerminalDiagnosticLog; error?: string }) {
  if (error) return <Empty title="无法读取终端历史" detail={error} />;
  if (!log) return <Empty title="正在读取终端历史" detail="从本机 Runtime 读取此 Session 保留的原始 PTY 日志。" />;
  return <div className="agent-loop-terminal-diagnostic"><p>这是原始 PTY 字节的诊断尾部，不参与 Conductor 编排，也不会替代原生 TUI 的当前画面。</p>{log.truncated && <strong>日志已按容量保留末尾；更早输出已被清理。</strong>}<small>{log.bytes.toLocaleString()} bytes retained</small><pre>{displayTerminalDiagnostic(log.content) || "该 Session 还没有终端输出。"}</pre></div>;
}

function displayTerminalDiagnostic(content: string) {
  return content.replace(/\u001b/g, "␛").replace(/\r/g, "\\r");
}

function sameTerminalRects(current: Record<string, DOMRect>, next: Record<string, DOMRect>) {
  const currentIds = Object.keys(current);
  const nextIds = Object.keys(next);
  return currentIds.length === nextIds.length && currentIds.every((id) => next[id] && ["x", "y", "width", "height"].every((key) => Math.abs(Number(current[id][key as keyof DOMRect]) - Number(next[id][key as keyof DOMRect])) < .5));
}

function TaskInspector({ task, run, onWorkbench, onArtifact }: { task?: NativeAgentLoopTask; run?: NativeAgentLoopRunDetail; onWorkbench: () => void; onArtifact: (path: string) => void }) {
  if (!task) return <aside className="harness-inspector" />;
  return <aside className="harness-inspector"><h2>Task Architecture</h2><InspectorRow label="模式" value="Agent Loop" /><InspectorRow label="Template" value={`${task.architecture.template.name} v${task.architecture.template.version}`} /><InspectorRow label="Session cards" value={String(task.architecture.agentCards.length)} /><InspectorRow label="状态" value={statusLabel(task.status)} /><section className="harness-inspector-section"><strong>控制边界</strong><p>所有 Session Agent 都是 Conductor 派发的原生 OpenCode。Runtime 异步管理 PTY 与语义状态；它不自行推进图。</p></section>{run?.artifacts.map((artifact) => <button className="harness-open-timeline" disabled={!artifact.exists || !artifact.previewable} key={artifact.path} onClick={() => onArtifact(artifact.path)}><span>{artifact.exists ? "打开产物" : "等待产物"}</span><code>{artifact.path}</code></button>)}{run && <button className="harness-open-timeline" onClick={onWorkbench}>查看真实终端 <ChevronRight size={16} /></button>}</aside>;
}

function TemplateDialog({ draft, repairing, busy, enabled, onChange, onClose, onSave }: { draft: TemplateDraft; repairing: boolean; busy: boolean; enabled: boolean; onChange: (value: TemplateDraft) => void; onClose: () => void; onSave: () => void }) {
  const [activePane, setActivePane] = useState<"agents" | "loop">(repairing ? "loop" : "agents");
  const [selectedAgentId, setSelectedAgentId] = useState(() => draft.agents[0]?.id ?? "");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const selectedAgentIndex = Math.max(0, draft.agents.findIndex((card) => card.id === selectedAgentId));
  const selectedAgent = draft.agents[selectedAgentIndex];
  const updateCard = (index: number, patch: Partial<NativeSessionAgentCard>) => onChange({ ...draft, agents: draft.agents.map((card, cardIndex) => cardIndex === index ? { ...card, ...patch } : card) });
  const addCard = () => {
    const card = defaultCard(`agent-${draft.agents.length + 1}`);
    onChange({ ...draft, agents: [...draft.agents, card] });
    setSelectedAgentId(card.id);
    setAdvancedOpen(false);
  };
  const removeSelectedCard = () => {
    if (!selectedAgent || draft.agents.length < 2) return;
    const nextCards = draft.agents.filter((_, index) => index !== selectedAgentIndex);
    onChange({ ...draft, agents: nextCards });
    setSelectedAgentId(nextCards[Math.min(selectedAgentIndex, nextCards.length - 1)]?.id ?? "");
    setAdvancedOpen(false);
  };
  return <div className="agent-loop-drawer-backdrop" role="dialog" aria-modal="true" aria-label="编辑 Agent Loop Template">
    <button className="agent-loop-drawer-scrim" aria-label="关闭编辑器" onClick={onClose} />
    <section className="agent-loop-drawer">
      <header className="agent-loop-drawer-header"><div><h2>{repairing ? `修复 ${draft.name || "Template"}` : draft.name || "新建 Template"}</h2><p>{repairing ? "这会生成新版本；旧版本和已有 Task 的快照都不会改变。" : "编辑后会保存为新的 Template 版本；已有 Task 不会改变。"}</p></div><button className="agent-loop-drawer-close" onClick={onClose} aria-label="关闭">×</button></header>
      <div className="agent-loop-drawer-scroll">
        <section className="agent-loop-drawer-basics" aria-label="Template 基本信息"><label>模板名称<input value={draft.name} onChange={(event) => onChange({ ...draft, name: event.target.value })} /></label><label>用途描述<textarea rows={2} value={draft.description} onChange={(event) => onChange({ ...draft, description: event.target.value })} /></label></section>
        {repairing && <div className="agent-loop-template-repair-drawer-note"><strong>已创建可编辑的新版本草案</strong><span>已保留原有 Session Agent 卡片。请检查 Conductor Charter 是否反映你希望的协作方式。</span></div>}
        <div className="agent-loop-drawer-tabs" role="tablist" aria-label="Template 编辑内容"><button role="tab" aria-selected={activePane === "agents"} className={activePane === "agents" ? "active" : ""} onClick={() => setActivePane("agents")}>Session Agents <span>{draft.agents.length}</span></button><button role="tab" aria-selected={activePane === "loop"} className={activePane === "loop" ? "active" : ""} onClick={() => setActivePane("loop")}>Loop 设置</button></div>
        {activePane === "agents" && selectedAgent && <section className="agent-loop-drawer-agents">
          <div className="agent-loop-card-picker" aria-label="选择 Session Agent 卡片">{draft.agents.map((card, index) => <button key={`${card.id}-${index}`} className={card.id === selectedAgent.id ? "active" : ""} onClick={() => { setSelectedAgentId(card.id); setAdvancedOpen(false); }}><Bot size={15} /><span><strong>{card.name || "未命名 Agent"}</strong><small>{card.model}</small></span></button>)}<button className="agent-loop-add-card" onClick={addCard}><Plus size={14} /> 添加</button></div>
          <div className="agent-loop-card-editor"><div className="agent-loop-card-editor-title"><div><span>编辑 Session Agent</span><strong>{selectedAgent.name || "未命名 Agent"}</strong></div>{draft.agents.length > 1 && <button className="agent-loop-icon-danger" aria-label="移除当前 Session Agent" title="移除当前卡片" onClick={removeSelectedCard}><Trash2 size={15} /></button>}</div><div className="agent-loop-editor-two-columns"><label>名称<input value={selectedAgent.name} onChange={(event) => updateCard(selectedAgentIndex, { name: event.target.value })} /></label><label>责任类型<select value={selectedAgent.kind} onChange={(event) => updateCard(selectedAgentIndex, { kind: event.target.value as NativeSessionAgentCard["kind"] })}><option value="researcher">调研 / Researcher</option><option value="publisher">交付 / Publisher</option><option value="reviewer">复核 / Reviewer</option><option value="general">通用 / General</option></select></label><label>模型<input value={selectedAgent.model} onChange={(event) => updateCard(selectedAgentIndex, { model: event.target.value })} /></label></div><label>角色与稳定能力边界<textarea rows={3} value={selectedAgent.role} onChange={(event) => updateCard(selectedAgentIndex, { role: event.target.value })} /></label><div className="agent-loop-capability-grid"><label><span>MCP</span><input placeholder="留空 = 不设 Template 限制" value={selectedAgent.mcp.join(", ")} onChange={(event) => updateCard(selectedAgentIndex, { mcp: splitAllowlist(event.target.value) })} /><small>{selectedAgent.mcp.length ? "此卡片只声明这些 MCP" : "全部允许（沿用原生 OpenCode 能力）"}</small></label><label><span>Skills</span><input placeholder="留空 = 不设 Template 限制" value={selectedAgent.skills.join(", ")} onChange={(event) => updateCard(selectedAgentIndex, { skills: splitAllowlist(event.target.value) })} /><small>{selectedAgent.skills.length ? "此卡片只声明这些 Skills" : "全部允许（沿用原生 OpenCode 能力）"}</small></label></div><button className="agent-loop-advanced-toggle" aria-expanded={advancedOpen} onClick={() => setAdvancedOpen((value) => !value)}>{advancedOpen ? "收起高级设置" : "高级设置：默认输出、说明、卡片 ID"}<ChevronRight size={15} /></button>{advancedOpen && <div className="agent-loop-card-advanced"><label>默认输出约定<textarea rows={3} value={selectedAgent.expectedOutput} onChange={(event) => updateCard(selectedAgentIndex, { expectedOutput: event.target.value })} /></label><label>补充说明<textarea rows={3} value={selectedAgent.instructions} onChange={(event) => updateCard(selectedAgentIndex, { instructions: event.target.value })} /></label><label>卡片 ID<input value={selectedAgent.id} onChange={(event) => { updateCard(selectedAgentIndex, { id: event.target.value }); setSelectedAgentId(event.target.value); }} /></label></div>}</div>
        </section>}
        {activePane === "loop" && <section className="agent-loop-loop-settings"><div className="agent-loop-settings-copy"><strong>Conductor Charter</strong><p>这是 Conductor 的决策偏好，不是 Runtime 执行的路由、派发数量或完成门槛。</p></div><label>Conductor 如何根据任务、Session 返回与用户补充决定下一步<textarea rows={8} value={draft.conductor.charter ?? ""} onChange={(event) => onChange({ ...draft, conductor: { ...draft.conductor, charter: event.target.value } })} placeholder="例如：优先并行收集相互独立的证据；发现关键冲突时先重新派发核实；需要落地文件时，由 Conductor 按当前证据选择合适的 Session Agent。" /><small>不要写成固定的 Research → Review → Publish 流程。每次下一步始终由 Conductor 决定。</small></label><label>交付路径偏好（可选）<input placeholder="docs/report.md" value={draft.delivery.artifactPath} onChange={(event) => onChange({ ...draft, delivery: { ...draft.delivery, artifactPath: event.target.value, ownerAgentId: "" } })} /><small>它只帮助 Conductor 了解用户期望的落地位置；不会指定负责人，也不会阻止 Conductor 声明交付。</small></label></section>}
      </div>
      <footer className="agent-loop-drawer-footer"><button className="harness-secondary-button" onClick={onClose}>取消</button><button className="harness-primary-button" disabled={!enabled || busy || !draft.name.trim() || !draft.agents.length} onClick={onSave}>{busy ? "保存中…" : "保存新版本"}</button></footer>
    </section>
  </div>;
}

function TemplateStarterDialog({ description, busy, enabled, onDescription, onClose, onManual, onGenerate }: { description: string; busy: boolean; enabled: boolean; onDescription: (value: string) => void; onClose: () => void; onManual: () => void; onGenerate: () => void }) {
  return <div className="agent-loop-drawer-backdrop" role="dialog" aria-modal="true" aria-label="新建 Template">
    <button className="agent-loop-drawer-scrim" aria-label="取消新建 Template" onClick={onClose} />
    <section className="agent-loop-drawer agent-loop-starter-drawer">
      <header className="agent-loop-drawer-header"><div><h2>新建 Agent Loop Template</h2><p>先描述想要的协作方式。OpenCode 只生成可编辑草案，不创建 Task，也不会启动任何 Session。</p></div><button className="agent-loop-drawer-close" onClick={onClose} aria-label="关闭">×</button></header>
      <div className="agent-loop-drawer-scroll">
        <section className="agent-loop-template-generator-copy"><strong>一句话生成模板</strong><p>例如：&ldquo;调研一个主题，保留多个可独立调研的 Session 卡片；Conductor 根据证据缺口决定是否再派发、核实或让某个 Agent 落地 Markdown。&rdquo;</p></section>
        <label className="agent-loop-template-prompt">你希望 Conductor 怎样使用 Session Agent？<textarea autoFocus rows={7} value={description} onChange={(event) => onDescription(event.target.value)} placeholder="描述目标、可用角色、交付偏好，以及 Conductor 的决策原则。" /><small>生成结果会落在下一步的卡片与 Conductor Charter 编辑器中；你可以再修改 Agent、模型、MCP、Skills 和 Charter。</small></label>
        <section className="agent-loop-manual-entry"><strong>不想生成？</strong><p>直接从空白模板配置 Conductor 和原生 Session Agent 卡片。</p><button className="harness-secondary-button compact" disabled={busy} onClick={onManual}><Pencil size={14} /> 手工创建</button></section>
      </div>
      <footer className="agent-loop-drawer-footer"><button className="harness-secondary-button" disabled={busy} onClick={onClose}>取消</button><button className="harness-primary-button" disabled={!enabled || busy || !description.trim()} onClick={onGenerate}>{busy ? "OpenCode 生成中…" : "生成可编辑草案"}</button></footer>
    </section>
  </div>;
}

function TaskDialog({ templates, title, goal, templateId, busy, enabled, onTitle, onGoal, onTemplate, onClose, onCreateTemplate, onCreate }: { templates: NativeAgentLoopTemplate[]; title: string; goal: string; templateId: string; busy: boolean; enabled: boolean; onTitle: (value: string) => void; onGoal: (value: string) => void; onTemplate: (value: string) => void; onClose: () => void; onCreateTemplate: () => void; onCreate: () => void }) {
  return <div className="agent-loop-drawer-backdrop" role="dialog" aria-modal="true" aria-label="创建 Task">
    <button className="agent-loop-drawer-scrim" aria-label="取消创建任务" onClick={onClose} />
    <section className="agent-loop-drawer agent-loop-task-drawer">
      <header className="agent-loop-drawer-header"><div><h2>创建 Task</h2><p>选择已保存的 Agent Loop Template。创建后会固化快照；之后修改模板不会影响这个 Task。</p></div><button className="agent-loop-drawer-close" onClick={onClose} aria-label="关闭">×</button></header>
      <div className="agent-loop-drawer-scroll">
        <section className="agent-loop-drawer-basics"><label>任务标题<input autoFocus value={title} onChange={(event) => onTitle(event.target.value)} placeholder="例如：整理产品竞品调研" /></label><label>任务目标<textarea rows={5} value={goal} onChange={(event) => onGoal(event.target.value)} placeholder="写清交付物、范围和验收标准。Conductor 会据此形成每次派发的工作契约。" /></label></section>
        <section className="agent-loop-task-template-choice"><div><strong>选择协作模板</strong><p>模板保存 Conductor Charter 与 Session Agent 的稳定能力，不包含本次任务的固定路线。</p></div><label>Agent Loop Template<select value={templateId} onChange={(event) => onTemplate(event.target.value)}>{templates.map((template) => <option value={template.id} key={template.id}>{template.name} · v{template.version}</option>)}</select></label><div className="agent-loop-task-template-alternative"><span>没有合适的模板？</span><button className="harness-secondary-button compact" disabled={busy || !goal.trim()} onClick={onCreateTemplate}><Plus size={14} /> 根据任务目标生成新 Template</button><small>会先进入 Template 草案编辑器；保存后再回到这里创建 Task。</small></div></section>
        <section className="agent-loop-task-snapshot-note"><strong>创建后会发生什么</strong><p>Task 会保存当前 Template 的版本快照。启动后，只有 Conductor 可以异步派发原生 OpenCode Session Agent；每个 Session 的结果、失败或需要输入才会唤醒 Conductor。</p></section>
      </div>
      <footer className="agent-loop-drawer-footer"><button className="harness-secondary-button" disabled={busy} onClick={onClose}>取消</button><button className="harness-primary-button" disabled={!enabled || busy || !title.trim() || !goal.trim() || !templateId} onClick={onCreate}>{busy ? "创建中…" : "创建 Task"}</button></footer>
    </section>
  </div>;
}

function ArtifactDialog({ artifact, onClose }: { artifact: NativeAgentLoopArtifact; onClose: () => void }) {
  return <div className="harness-modal-backdrop" role="dialog" aria-modal="true" aria-label="产物预览"><section className="harness-modal agent-loop-artifact-modal"><header><div><span>DELIVERY ARTIFACT</span><h2>{artifact.path}</h2></div><button onClick={onClose} aria-label="关闭">×</button></header><div className="harness-modal-content agent-loop-artifact-content">{artifact.contentType === "markdown" ? <div className="harness-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]}>{artifact.content ?? ""}</ReactMarkdown></div> : artifact.contentType === "html" ? <iframe title={artifact.path} sandbox="" srcDoc={artifact.content ?? ""} /> : <pre>{artifact.content ?? ""}</pre>}</div><footer><span>{artifact.size ? `${artifact.size} bytes` : ""}</span><button className="harness-primary-button" onClick={onClose}>关闭</button></footer></section></div>;
}

function AgentCard({ card }: { card: NativeSessionAgentCard }) { return <article className="agent-loop-agent-card"><header><Bot size={17} /><div><strong>{card.name}</strong><span>{card.id} · {agentKindLabel(card.kind)}</span></div></header><p>{card.role}</p><dl><dt>模型</dt><dd>{card.model}</dd><dt>MCP</dt><dd>{allowlistLabel(card.mcp)}</dd><dt>Skills</dt><dd>{allowlistLabel(card.skills)}</dd><dt>默认交付</dt><dd>{card.expectedOutput || "由 Conductor 的本次契约指定"}</dd></dl></article>; }
function InspectorRow({ label, value }: { label: string; value: string }) { return <div className="harness-inspector-row"><span>{label}</span><strong title={value}>{value}</strong></div>; }
function Empty({ title, detail }: { title: string; detail: string }) { return <div className="harness-empty"><strong>{title}</strong><p>{detail}</p></div>; }

type TimelineItem = { id: string; kind: "user" | "conductor" | "runtime" | "session"; title: string; detail: string; meta: string };
function buildTimeline(task?: NativeAgentLoopTask, run?: NativeAgentLoopRunDetail): TimelineItem[] {
  if (!task) return [];
  const items: TimelineItem[] = [{ id: "task", kind: "user", title: "任务输入", detail: `# ${task.title}\n\n${task.goal}`, meta: "用户 → Conductor" }];
  for (const event of run?.events ?? []) {
    if (event.type === "task.user_message") {
      items.push({ id: `event-${event.sequence}`, kind: "user", title: "你发给 Conductor 的消息", detail: stringField(event.data, "message") || event.summary, meta: event.createdAt });
      continue;
    }
    items.push({ id: `event-${event.sequence}`, kind: event.type.startsWith("conductor") ? "conductor" : "runtime", title: event.type, detail: event.summary, meta: event.createdAt });
  }
  for (const dispatch of run?.runtimeState.dispatches ?? []) items.push({ id: `dispatch-${String(dispatch.dispatchId)}`, kind: "conductor", title: `Conductor 派发 → ${shortSession(String(dispatch.toSessionId ?? ""))}`, detail: dispatchTimelineDetail(dispatch), meta: String(dispatch.createdAt ?? "") });
  for (const result of run?.runtimeState.results ?? []) {
    const output = run?.turns.find((turn) => turn.sessionId === result.sessionId)?.output?.answerText ?? result.answerPreview ?? "Provider 已返回结果；在运行现场查看原生 Session。";
    items.push({ id: `result-${String(result.resultId ?? result.dispatchId)}`, kind: "session", title: `${shortSession(String(result.sessionId ?? "Session Agent"))} 返回`, detail: output, meta: String(result.createdAt ?? "") });
  }
  for (const message of run?.runtimeState.messages ?? []) items.push({ id: `conductor-${String(message.providerMessageId ?? message.dispatchId ?? message.createdAt)}`, kind: "conductor", title: "Conductor 回应", detail: message.answerText, meta: String(message.createdAt ?? "") });
  for (const attention of run?.runtimeState.pendingDecisions ?? []) {
    if (attention.type === "worker_result_available") continue;
    items.push({
      id: `attention-${attention.type}-${attention.sessionId}-${("cursor" in attention ? attention.cursor : "") ?? ""}`,
      kind: "runtime",
      title: `${shortSession(attention.sessionId)} 需要处理`,
      detail: attention.summary ?? "Runtime 观察到原生 Session 需要输入、权限或恢复处理。请进入运行现场，在该 Session 的真实终端中查看与回复。",
      meta: attention.actionHint ?? attention.type,
    });
  }
  return items;
}
function dispatchTimelineDetail(dispatch: Record<string, unknown>) {
  const contextPackets = Array.isArray(dispatch.contextPackets) ? dispatch.contextPackets : [];
  const resultReferences = contextPackets
    .filter((packet): packet is Record<string, unknown> => Boolean(packet) && typeof packet === "object")
    .filter((packet) => packet.kind === "provider_result" && typeof packet.resultId === "string")
    .map((packet) => `- \`${String(packet.sourceAgentId || "Session Agent")}\` 的 \`result:${String(packet.resultId)}\` 已原样传入本次任务`)
    .join("\n");
  return [
    "**工作契约**",
    String(dispatch.assignment ?? ""),
    dispatch.expectedOutput ? `**预期输出**\n\n${String(dispatch.expectedOutput)}` : "",
    resultReferences ? `**引用的 Session 结果**\n\n${resultReferences}` : "",
  ].filter(Boolean).join("\n\n");
}
function TimelineMessage({ item }: { item: TimelineItem }) { return <article className={`harness-conversation-message ${item.kind}`}><div className="harness-conversation-avatar">{item.kind === "user" ? "U" : item.kind === "conductor" ? "C" : item.kind === "session" ? "S" : "R"}</div><div className="harness-conversation-content"><header><strong>{item.title}</strong><small>{item.meta}</small></header><div className="harness-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]}>{item.detail}</ReactMarkdown></div></div></article>; }
function TaskConversationComposer({ disabled, onSubmit }: { disabled: boolean; onSubmit: (message: string) => Promise<void> }) {
  const [message, setMessage] = useState("");
  const submit = async (event: import("react").FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (disabled || !message.trim()) return;
    const submitted = message.trim();
    setMessage("");
    try {
      await onSubmit(submitted);
    } catch {
      setMessage(submitted);
    }
  };
  return <form className="harness-conductor-composer" onSubmit={(event) => void submit(event)}><label>继续和 Conductor 对话<textarea id="task-conductor-message" rows={3} disabled={disabled} value={message} onChange={(event) => setMessage(event.target.value)} placeholder="补充目标、纠正结论，或要求 Conductor 再次核实；由 Conductor 决定是否重新派发。" /></label><div><button className="harness-primary-button compact" disabled={disabled || !message.trim()} type="submit">发送</button></div></form>;
}
function templateDraftFrom(template: NativeAgentLoopTemplate): TemplateDraft { const { version: _version, archivedAt: _archivedAt, createdAt: _createdAt, updatedAt: _updatedAt, ...draft } = template; return structuredClone(draft); }
function repairTemplateDraft(template: NativeAgentLoopTemplate): TemplateDraft { return templateDraftFrom(template); }
function splitAllowlist(value: string) { return [...new Set(value.split(",").map((item) => item.trim()).filter(Boolean))]; }
function allowlistLabel(value: string[]) { return value.length ? value.join(", ") : "全部允许"; }
function agentKindLabel(kind: NativeSessionAgentCard["kind"]) { return ({ researcher: "调研", publisher: "交付", reviewer: "复核", general: "通用" } as Record<NativeSessionAgentCard["kind"], string>)[kind]; }
function templateExecutionIssue(_template: NativeAgentLoopTemplate) { return ""; }
function statusLabel(status: string) { return ({ queued: "待启动", running: "运行中", delivery_ready: "待检查产物", achieved: "achieved", archived: "已归档" } as Record<string, string>)[status] ?? status; }
function sessionDispatchLabel(status: string) { return ({ queued: "已排队", input_accepted: "输入已接收", delivered: "Provider 已接收", result_available: "结果可用", provider_failed: "Provider 失败", failed: "派发失败", not_dispatched: "未派发", running: "运行中", succeeded: "结果可用" } as Record<string, string>)[status] ?? status; }
function terminalLifecycleLabel(status?: string) { return ({ live: "终端在线", running: "终端在线", stopping: "终端停止中", stopped: "终端已停止", not_started: "尚未启动" } as Record<string, string>)[status ?? "not_started"] ?? status ?? "尚未启动"; }
function shortSession(value: string) { const parts = value.split(":"); return parts[parts.length - 1] ?? value; }
function stringField(value: Record<string, unknown>, key: string) { return typeof value[key] === "string" ? value[key] : ""; }
function messageFor(reason: unknown) { return reason instanceof Error ? reason.message : String(reason); }

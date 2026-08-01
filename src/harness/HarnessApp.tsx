import {
  AlertTriangle,
  Bot,
  Boxes,
  ChevronRight,
  CircleDot,
  FilePlus2,
  FileText,
  GitBranch,
  GripVertical,
  ListTree,
  Moon,
  Play,
  Plus,
  RefreshCw,
  Sparkles,
  Sun,
  TerminalSquare,
} from "lucide-react";
import { useEffect, useState, type DragEvent, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { PtyTerminal } from "../components/PtyTerminal";
import {
  createNativeHarnessTask,
  createNativeManualOrchestrationTemplateDraft,
  defaultOpencodeRunModel,
  enqueueNativeTerminalInput,
  generateNativeOrchestrationTemplateDraft,
  listNativeHarnessTasks,
  listNativeOrchestrationTemplateBlueprints,
  listNativeOrchestrationTemplates,
  isNativeHarnessRuntimeAvailable,
  markNativeHarnessTaskAchieved,
  readNativeHarnessRun,
  readNativeHarnessArtifact,
  resizeNativePtySession,
  respondNativeHarnessAttention,
  saveNativeGeneratedOrchestrationTemplateDraft,
  startNativeHarnessRun,
  subscribeNativePtyEvents,
  type NativeGeneratedArchitectureDraft,
  type NativeHarnessRunDetail,
  type NativeHarnessTask,
  type NativeHarnessArtifact,
  type NativeHarnessAttention,
  type NativeOrchestrationTemplate,
  type NativeTemplateBlueprint,
} from "../runtime/nativeBridge";

type HarnessView = "tasks" | "templates" | "workbench";
type Theme = "dark" | "light";
type BuilderMode = "describe" | "manual";
type ManualNode = { id: string; role: string; instruction: string; kind: "delegate" | "verify"; dependsOn: string[] };

const initialManualNodes: ManualNode[] = [
  { id: "research", role: "Researcher", instruction: "Collect the bounded evidence required by the Task.", kind: "delegate", dependsOn: [] },
  { id: "verify", role: "Verifier", instruction: "Validate the collected evidence and report PASS or NEEDS_REVIEW.", kind: "verify", dependsOn: ["research"] },
];

/**
 * @deprecated Historical nested-Workflow Harness surface. The production app
 * renders AgentLoopApp and its Loop Templates; keep this surface only for
 * isolated migration and verification coverage.
 */
export function HarnessApp({ projectPath, projectName }: { projectPath: string; projectName: string }) {
  const runtimeAvailable = isNativeHarnessRuntimeAvailable();
  const [view, setView] = useState<HarnessView>("tasks");
  const [theme, setTheme] = useState<Theme>("dark");
  const [templates, setTemplates] = useState<NativeOrchestrationTemplate[]>([]);
  const [blueprints, setBlueprints] = useState<NativeTemplateBlueprint[]>([]);
  const [tasks, setTasks] = useState<NativeHarnessTask[]>([]);
  const [selectedBlueprintKey, setSelectedBlueprintKey] = useState("");
  const [selectedTaskId, setSelectedTaskId] = useState<string>();
  const [run, setRun] = useState<NativeHarnessRunDetail>();
  const [selectedRuntimeItem, setSelectedRuntimeItem] = useState("workflow");
  const [showTaskCreate, setShowTaskCreate] = useState(false);
  const [showTemplateBuilder, setShowTemplateBuilder] = useState(false);
  const [builderMode, setBuilderMode] = useState<BuilderMode>("describe");
  const [builderTitle, setBuilderTitle] = useState("Release evidence review");
  const [builderDescription, setBuilderDescription] = useState("Collect bounded release evidence, automatically remediate verifier findings, then deliver the actual artifacts.");
  const [builderLoopName, setBuilderLoopName] = useState("Release evidence Agent Loop");
  const [builderConductorRole, setBuilderConductorRole] = useState("Release Conductor");
  const [builderWorkflowName, setBuilderWorkflowName] = useState("Release evidence Workflow");
  const [builderNodes, setBuilderNodes] = useState<ManualNode[]>(initialManualNodes);
  const [builderDraft, setBuilderDraft] = useState<NativeGeneratedArchitectureDraft>();
  const [taskTitle, setTaskTitle] = useState("OpenCode nested workflow harness");
  const [taskGoal, setTaskGoal] = useState("验证一个已保存 Blueprint 的 Agent Loop 内嵌 Workflow 真实运行链路。");
  const [taskBlueprintKey, setTaskBlueprintKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [artifactPreview, setArtifactPreview] = useState<NativeHarnessArtifact>();

  const selectedTask = tasks.find((task) => task.taskId === selectedTaskId) ?? tasks[0];
  const selectedBlueprint = blueprints.find((blueprint) => blueprintKey(blueprint) === selectedBlueprintKey) ?? blueprints[0];
  const taskBlueprint = blueprints.find((blueprint) => blueprintKey(blueprint) === taskBlueprintKey) ?? blueprints[0];

  const acceptRunDetail = (detail: NativeHarnessRunDetail) => {
    setRun(detail);
    setTasks((current) => current.map((task) => task.taskId === detail.task.taskId ? { ...task, ...detail.task, latestRun: detail.run } : task));
  };

  const refresh = async (taskId = selectedTaskId) => {
    const [nextTemplates, nextBlueprints, nextTasks] = await Promise.all([
      listNativeOrchestrationTemplates(),
      listNativeOrchestrationTemplateBlueprints(),
      listNativeHarnessTasks(),
    ]);
    setTemplates(nextTemplates);
    setBlueprints(nextBlueprints);
    setSelectedBlueprintKey((current) => nextBlueprints.some((item) => blueprintKey(item) === current) ? current : blueprintKey(nextBlueprints[0]));
    setTaskBlueprintKey((current) => nextBlueprints.some((item) => blueprintKey(item) === current) ? current : blueprintKey(nextBlueprints[0]));
    setTasks(nextTasks);
    const focused = nextTasks.find((task) => task.taskId === taskId) ?? nextTasks[0];
    if (focused && !selectedTaskId) setSelectedTaskId(focused.taskId);
    if (focused?.latestRun?.runId) setRun(await readNativeHarnessRun(focused.latestRun.runId));
    else if (!focused) setRun(undefined);
  };

  useEffect(() => {
    void refresh().catch((reason: unknown) => setError(messageFor(reason)));
  }, []);

  useEffect(() => {
    if (!run || run.run.status !== "running") return undefined;
    const timer = window.setInterval(() => {
      void readNativeHarnessRun(run.run.runId)
        .then((next) => next && acceptRunDetail(next))
        .then(() => refresh(selectedTaskId))
        .catch((reason: unknown) => setError(messageFor(reason)));
    }, 850);
    return () => window.clearInterval(timer);
  }, [run?.run.runId, run?.run.status, selectedTaskId]);

  useEffect(() => subscribeNativePtyEvents(() => {
    if (run?.run.runId) void readNativeHarnessRun(run.run.runId).then((next) => next && acceptRunDetail(next));
  }), [run?.run.runId]);

  const openTemplateBuilder = (mode: BuilderMode = "describe") => {
    setBuilderMode(mode);
    setBuilderDraft(undefined);
    setBuilderNodes(initialManualNodes);
    setShowTemplateBuilder(true);
    setError(undefined);
  };

  const generateBuilderDraft = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const draft = await generateNativeOrchestrationTemplateDraft({
        cwd: projectPath,
        title: builderTitle.trim(),
        goal: builderDescription.trim(),
        model: defaultOpencodeRunModel,
      });
      if (!draft) throw new Error("Runtime 没有返回 Template Draft。");
      setBuilderDraft(draft);
    } catch (reason) {
      setError(messageFor(reason));
    } finally {
      setBusy(false);
    }
  };

  const saveBuilderTemplate = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const draft = builderMode === "describe"
        ? builderDraft
        : await createNativeManualOrchestrationTemplateDraft({
            cwd: projectPath,
            title: builderTitle.trim(),
            goal: builderDescription.trim(),
            description: builderDescription.trim(),
            model: defaultOpencodeRunModel,
            agentLoop: { name: builderLoopName.trim(), conductorRole: builderConductorRole.trim() },
            workflow: { name: builderWorkflowName.trim(), nodes: builderNodes },
          });
      if (!draft) throw new Error("Runtime 没有创建 Template Draft。");
      const saved = await saveNativeGeneratedOrchestrationTemplateDraft(draft.draftId);
      if (!saved?.savedTemplates?.blueprint) throw new Error("Runtime 没有保存 Template Blueprint。");
      const savedKey = blueprintKey(saved.savedTemplates.blueprint);
      setBuilderDraft(saved);
      setSelectedBlueprintKey(savedKey);
      setTaskBlueprintKey(savedKey);
      await refresh();
      setShowTemplateBuilder(false);
    } catch (reason) {
      setError(messageFor(reason));
    } finally {
      setBusy(false);
    }
  };

  const createTask = async () => {
    if (!taskBlueprint) return;
    setBusy(true);
    setError(undefined);
    try {
      const task = await createNativeHarnessTask({
        cwd: projectPath,
        projectId: projectName,
        title: taskTitle.trim(),
        goal: taskGoal.trim(),
        model: defaultOpencodeRunModel,
        templateBlueprintId: taskBlueprint.id,
        templateBlueprintVersion: taskBlueprint.version,
      });
      if (!task) throw new Error("桌面 Runtime 没有返回 Harness Task。");
      setSelectedTaskId(task.taskId);
      setRun(undefined);
      setShowTaskCreate(false);
      await refresh(task.taskId);
    } catch (reason) {
      setError(messageFor(reason));
    } finally {
      setBusy(false);
    }
  };

  const startRun = async () => {
    if (!selectedTask) return;
    setBusy(true);
    setError(undefined);
    try {
      const detail = await startNativeHarnessRun(selectedTask.taskId);
      if (!detail) throw new Error("Runtime 没有创建 Task Run。");
      acceptRunDetail(detail);
      setArtifactPreview(undefined);
      setSelectedRuntimeItem("workflow");
      setView("tasks");
      await refresh(selectedTask.taskId);
    } catch (reason) {
      setError(messageFor(reason));
    } finally {
      setBusy(false);
    }
  };

  const markAchieved = async () => {
    if (!selectedTask) return;
    setBusy(true);
    setError(undefined);
    try {
      const achieved = await markNativeHarnessTaskAchieved(selectedTask.taskId);
      if (!achieved) throw new Error("Runtime 没有确认 Task 的 achieved 状态。");
      setTasks((current) => current.map((task) => task.taskId === achieved.taskId ? { ...task, ...achieved } : task));
      if (run?.task.taskId === achieved.taskId) setRun((current) => current ? { ...current, task: achieved } : current);
    } catch (reason) {
      setError(messageFor(reason));
    } finally {
      setBusy(false);
    }
  };

  const selectTask = async (task: NativeHarnessTask) => {
    setSelectedTaskId(task.taskId);
    setRun(task.latestRun ? await readNativeHarnessRun(task.latestRun.runId) : undefined);
    setArtifactPreview(undefined);
    setSelectedRuntimeItem("workflow");
    setView("tasks");
  };

  const addManualNode = () => {
    setBuilderNodes((current) => {
      if (current.length >= 6) return current;
      const finalNode = current[current.length - 1]!;
      const beforeFinal = current[current.length - 2]!;
      const id = `step-${current.length}`;
      return [...current.slice(0, -1), { id, role: "Task specialist", instruction: "Complete one bounded task step and return evidence.", kind: "delegate", dependsOn: [beforeFinal.id] }, { ...finalNode, dependsOn: [id] }];
    });
  };

  const handleNodeDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    if (event.dataTransfer.getData("application/x-agent-workspace-node") === "delegate") addManualNode();
  };

  const updateManualNode = (index: number, patch: Partial<ManualNode>) => {
    setBuilderNodes((current) => current.map((node, nodeIndex) => nodeIndex === index ? { ...node, ...patch } : node));
  };

  const removeManualNode = (index: number) => {
    setBuilderNodes((current) => {
      if (current.length <= 2 || index === current.length - 1) return current;
      const removed = current[index];
      const predecessor = current[index - 1]?.id;
      return current.filter((_, nodeIndex) => nodeIndex !== index).map((node) => ({
        ...node,
        dependsOn: node.dependsOn.map((dependency) => dependency === removed.id ? predecessor : dependency).filter(Boolean) as string[],
      }));
    });
  };

  const openRuntime = (item: string) => {
    setSelectedRuntimeItem(item);
    setView("workbench");
  };
  const openWorkbench = () => {
    const activeOrFailedTurn = run?.turns.find((turn) => turn.status === "running")
      ?? lastItem(run?.turns.filter((turn) => turn.status === "failed") ?? [])
      ?? lastItem(run?.turns ?? []);
    openRuntime(activeOrFailedTurn?.sessionId ?? "workflow");
  };
  const openArtifact = async (artifactPath: string) => {
    if (!run) return;
    setBusy(true);
    setError(undefined);
    try {
      const artifact = await readNativeHarnessArtifact(run.run.runId, artifactPath);
      if (!artifact) throw new Error("Runtime 没有找到这个交付产物。");
      setArtifactPreview(artifact);
    } catch (reason) {
      setError(messageFor(reason));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`harness-app theme-${theme}`}>
      <aside className="harness-rail" aria-label="主导航">
        <div className="harness-brand"><Boxes size={20} /><span>Agent Workspace</span></div>
        <nav>
          <RailButton active={view === "tasks"} icon={<CircleDot size={18} />} label="任务" onClick={() => setView("tasks")} />
          <RailButton active={view === "templates"} icon={<GitBranch size={18} />} label="模板" onClick={() => setView("templates")} />
          <RailButton active={view === "workbench"} icon={<TerminalSquare size={18} />} label="运行现场" onClick={openWorkbench} />
        </nav>
        <div className="harness-rail-bottom">
          <button aria-label="切换亮暗主题" className="harness-icon-button" type="button" onClick={() => setTheme((value) => value === "dark" ? "light" : "dark")}>
            {theme === "dark" ? <Sun size={17} /> : <Moon size={17} />}
          </button>
          <span className="harness-provider">OpenCode</span>
        </div>
      </aside>

      <section className="harness-main">
        <header className="harness-header">
          <div><strong>{projectName}</strong><span>{projectPath}</span></div>
          <div className="harness-header-actions"><span className={`harness-runtime-dot ${runtimeAvailable ? "online" : "offline"}`}>{runtimeAvailable ? "Runtime online" : "浏览器预览 · 只读"}</span><button aria-label="刷新 Runtime 数据" className="harness-secondary-button" disabled={!runtimeAvailable} title={runtimeAvailable ? "刷新 Runtime 数据" : "浏览器预览没有本地 Runtime"} type="button" onClick={() => void refresh()}><RefreshCw size={15} />刷新</button></div>
        </header>
        {!runtimeAvailable ? <div className="harness-browser-preview" role="status"><strong>同一套 Harness 界面</strong><span>浏览器仅用于界面调试；模板、Task、PTY 与 OpenCode Session 必须在 Electron 桌面端运行。</span></div> : null}
        {error ? <div className="harness-error" role="alert">{error}</div> : null}
        {view === "tasks" ? <TaskSurface artifactPreview={artifactPreview} busy={busy} blueprints={blueprints} canOperate={runtimeAvailable} onAchieve={() => void markAchieved()} onCloseArtifact={() => setArtifactPreview(undefined)} onCreate={() => setShowTaskCreate(true)} onOpenArtifact={(artifactPath) => void openArtifact(artifactPath)} onOpenRuntime={openRuntime} onSelectTask={(task) => void selectTask(task)} onStart={startRun} run={run} selectedTask={selectedTask} tasks={tasks} /> : null}
        {view === "templates" ? <TemplateSurface blueprints={blueprints} busy={busy} canOperate={runtimeAvailable} onCreate={() => openTemplateBuilder()} onSelect={setSelectedBlueprintKey} selected={selectedBlueprint} templates={templates} /> : null}
        {view === "workbench" ? <WorkbenchSurface onOpenTasks={() => setView("tasks")} onRunChange={acceptRunDetail} onSelectItem={setSelectedRuntimeItem} run={run} selectedItem={selectedRuntimeItem} /> : null}
      </section>

      {showTaskCreate ? <TaskCreateModal busy={busy} blueprints={blueprints} goal={taskGoal} onClose={() => setShowTaskCreate(false)} onCreate={() => void createTask()} onOpenTemplateBuilder={() => { setShowTaskCreate(false); setView("templates"); openTemplateBuilder("describe"); }} onSelectBlueprint={setTaskBlueprintKey} selectedBlueprint={taskBlueprint} title={taskTitle} onGoalChange={setTaskGoal} onTitleChange={setTaskTitle} /> : null}
      {showTemplateBuilder ? <TemplateBuilderModal builderDescription={builderDescription} builderDraft={builderDraft} builderLoopName={builderLoopName} builderMode={builderMode} builderNodes={builderNodes} builderTitle={builderTitle} builderWorkflowName={builderWorkflowName} busy={busy} conductorRole={builderConductorRole} onAddNode={addManualNode} onClose={() => setShowTemplateBuilder(false)} onDescriptionChange={setBuilderDescription} onGenerate={() => void generateBuilderDraft()} onModeChange={(mode) => { setBuilderMode(mode); setBuilderDraft(undefined); }} onNodeDrop={handleNodeDrop} onRemoveNode={removeManualNode} onSave={() => void saveBuilderTemplate()} onSelectDependencies={(index, dependsOn) => updateManualNode(index, { dependsOn })} onTitleChange={setBuilderTitle} onUpdateNode={updateManualNode} onWorkflowNameChange={setBuilderWorkflowName} onLoopNameChange={setBuilderLoopName} onConductorRoleChange={setBuilderConductorRole} /> : null}
    </div>
  );
}

function TaskSurface({ tasks, selectedTask, run, busy, canOperate, blueprints, artifactPreview, onCreate, onSelectTask, onStart, onAchieve, onOpenRuntime, onOpenArtifact, onCloseArtifact }: { tasks: NativeHarnessTask[]; selectedTask?: NativeHarnessTask; run?: NativeHarnessRunDetail; busy: boolean; canOperate: boolean; blueprints: NativeTemplateBlueprint[]; artifactPreview?: NativeHarnessArtifact; onCreate: () => void; onSelectTask: (task: NativeHarnessTask) => void; onStart: () => void; onAchieve: () => void; onOpenRuntime: (item: string) => void; onOpenArtifact: (artifactPath: string) => void; onCloseArtifact: () => void }) {
  return <div className="harness-task-layout">
    <aside className="harness-task-list"><div className="harness-panel-title"><h1>任务</h1><button className="harness-primary-button compact" disabled={!canOperate} title={canOperate ? "创建 Task" : "仅桌面端可以创建 Task"} type="button" onClick={onCreate}><FilePlus2 size={15} />新建任务</button></div><div className="harness-list-caption">选择模板 → 确认架构 → 启动独立 Run。</div>{tasks.length ? tasks.map((task) => <button className={task.taskId === selectedTask?.taskId ? "harness-task-row active" : "harness-task-row"} key={task.taskId} onClick={() => onSelectTask(task)} type="button"><span className={`harness-state-dot ${task.status}`} /><strong>{task.title}</strong><small>{task.architecture.templateBlueprint?.name ?? task.architecture.agentLoopTemplate?.name ?? "Template Blueprint"}</small><em>{statusLabel(task.status)}</em></button>) : <EmptyState title="还没有任务" detail={canOperate ? "先在模板页保存一个 Blueprint，再创建可执行的 Task Architecture。" : "浏览器不会伪造 Task 数据。请在 Electron 桌面端创建并运行真实 Task。"} />}</aside>
    <section className="harness-timeline-panel">{selectedTask ? <><div className="harness-task-head"><div><div className="harness-breadcrumb">Task / {selectedTask.architecture.templateBlueprint?.name ?? "Template Blueprint"}</div><h1>{selectedTask.title}</h1><p>{selectedTask.goal}</p></div><div className="harness-task-actions">{selectedTask.status === "delivery_ready" ? <button className="harness-primary-button" disabled={busy} type="button" onClick={onAchieve}><CircleDot size={16} />标记达成</button> : selectedTask.status === "achieved" ? <span className="harness-achieved-label"><CircleDot size={15} />已达成 · 可归档</span> : !selectedTask.latestRun || selectedTask.latestRun.status !== "running" ? <button className="harness-primary-button" disabled={busy} type="button" onClick={onStart}><Play size={16} />{run?.run.status === "blocked" ? "以当前架构新建 Run" : "启动 Run"}</button> : <span className="harness-running-label"><span />Run 正在执行</span>}</div></div><div className="harness-timeline-meta"><span>主模式 <b>Agent Loop</b></span><ChevronRight size={14} /><span>执行单元 <b>Workflow</b></span><ChevronRight size={14} /><span>Provider <b>OpenCode</b></span></div>{run ? <TaskRunContext run={run} onOpenRuntime={onOpenRuntime} /> : null}<TaskConversation run={run} task={selectedTask} onOpenArtifact={onOpenArtifact} onOpenRuntime={onOpenRuntime} />{artifactPreview ? <ArtifactPreview artifact={artifactPreview} onClose={onCloseArtifact} /> : null}</> : <EmptyState title="选择一个任务" detail="Task Timeline 显示目标、Conductor 输入、Session 回答与真实落地产物。" />}</section>
    <aside className="harness-inspector"><h2>Task Architecture</h2>{selectedTask ? <><InspectorRow label="Blueprint" value={selectedTask.architecture.templateBlueprint?.name ?? "Legacy template reference"} /><InspectorRow label="Agent Loop" value={String(selectedTask.architecture.agentLoopTemplate?.name ?? "Agent Loop")} /><InspectorRow label="Workflow" value={String(selectedTask.architecture.nestedWorkflowTemplate?.name ?? "Workflow")} /><InspectorRow label="交付角色" value={selectedTask.architecture.sessionPlan?.deliveryContract?.publisher?.role ?? "无最终文件"} /><InspectorRow label="最终产物" value={selectedTask.architecture.sessionPlan?.deliveryContract?.finalArtifact?.path ?? "仅 Markdown 证据"} /><InspectorRow label="Provider" value="OpenCode" /><InspectorRow label="状态" value={statusLabel(selectedTask.status)} /><div className="harness-inspector-section"><strong>控制边界</strong><p>Workflow 在 final 或异常前自行推进；Workflow 外的补证、复验与发布 Session 必须由 Conductor 派发，返回后再由 Conductor 决定下一步。</p></div><div className="harness-inspector-section"><strong>任务收口</strong><p>交付文件检查后点击“标记达成”。达成任务留在历史中；归档或永久删除将是单独、可确认的操作，不会自动删除文件。</p></div></> : <InspectorRow label="Blueprints" value={`${blueprints.length} 已保存`} />}</aside>
  </div>;
}

function TemplateSurface({ blueprints, templates, selected, busy, canOperate, onCreate, onSelect }: { blueprints: NativeTemplateBlueprint[]; templates: NativeOrchestrationTemplate[]; selected?: NativeTemplateBlueprint; busy: boolean; canOperate: boolean; onCreate: () => void; onSelect: (key: string) => void }) {
  const loop = selected ? templates.find((item) => item.id === selected.agentLoopTemplate.id && item.version === selected.agentLoopTemplate.version) : undefined;
  const workflow = selected ? templates.find((item) => item.id === selected.workflowTemplate.id && item.version === selected.workflowTemplate.version) : undefined;
  return <div className="harness-template-layout">
    <aside className="harness-template-list"><div className="harness-panel-title"><h1>模板</h1><button className="harness-primary-button compact" disabled={busy || !canOperate} title={canOperate ? "创建 Template" : "仅桌面端可以创建 Template"} type="button" onClick={onCreate}><Plus size={15} />新建模板</button></div><div className="harness-list-caption">Blueprint 是可复用组合：一个 Loop 策略 + 一个 Workflow 图。</div><section className="harness-template-group"><h2>Template Blueprints</h2>{blueprints.map((blueprint) => <button className={blueprintKey(blueprint) === blueprintKey(selected) ? "harness-template-row active" : "harness-template-row"} key={blueprintKey(blueprint)} type="button" onClick={() => onSelect(blueprintKey(blueprint))}><GitBranch size={15} /><span><strong>{blueprint.name}</strong><small>v{blueprint.version} · {sourceLabel(blueprint.source)}</small></span></button>)}</section><div className="harness-runtime-assets"><strong>Runtime assets</strong><span>{templates.filter((item) => item.family === "agent_loop").length} Agent Loop 策略 · {templates.filter((item) => item.family === "workflow").length} Workflow 图</span></div></aside>
    <section className="harness-template-canvas">{selected ? <><div className="harness-template-head"><div><div className="harness-breadcrumb">Template Blueprint · v{selected.version}</div><h1>{selected.name}</h1><p>{selected.description || "No description provided."}</p></div><span className={`harness-family-tag blueprint ${selected.source}`}>{sourceLabel(selected.source)}</span></div><TemplateComposition loop={loop} workflow={workflow} /><div className="harness-template-note">Agent Loop 是 Conductor 的 Session 管理策略；Workflow 是 Runtime 可独立推进的图。保存的 Blueprint 会引用两者的不可变版本。</div></> : <EmptyState title="没有模板" detail="新建模板可以通过一句话生成，或手工拖入节点构建 Workflow。" />}</section>
    <aside className="harness-inspector"><h2>Blueprint 事实</h2>{selected ? <><InspectorRow label="Version" value={`v${selected.version}`} /><InspectorRow label="来源" value={sourceLabel(selected.source)} /><InspectorRow label="Agent Loop" value={`${selected.agentLoopTemplate.id} v${selected.agentLoopTemplate.version}`} /><InspectorRow label="Workflow" value={`${selected.workflowTemplate.id} v${selected.workflowTemplate.version}`} /><InspectorRow label="持久化" value="Runtime SQLite" /><div className="harness-inspector-section"><strong>使用方式</strong><p>新建 Task 时选择 Blueprint；Task 保存自己的架构快照，不会被模板后续变更影响。</p></div></> : null}</aside>
  </div>;
}

function TaskCreateModal({ blueprints, selectedBlueprint, title, goal, busy, onClose, onCreate, onOpenTemplateBuilder, onSelectBlueprint, onTitleChange, onGoalChange }: { blueprints: NativeTemplateBlueprint[]; selectedBlueprint?: NativeTemplateBlueprint; title: string; goal: string; busy: boolean; onClose: () => void; onCreate: () => void; onOpenTemplateBuilder: () => void; onSelectBlueprint: (key: string) => void; onTitleChange: (value: string) => void; onGoalChange: (value: string) => void }) {
  return <div className="harness-modal-backdrop" role="presentation"><form className="harness-create-modal" onSubmit={(event) => { event.preventDefault(); onCreate(); }}><ModalTitle title="新建 Task" detail="写清要交付什么，再选择一个已保存的协作模板；确认后才会创建可运行的 Task。" onClose={onClose} /><label>任务标题<input placeholder="例如：整理 OpenCode 发展史" value={title} onChange={(event) => onTitleChange(event.target.value)} /></label><label>要交付什么？<textarea placeholder="写给 Conductor：目标、最终输出和必要约束。" rows={4} value={goal} onChange={(event) => onGoalChange(event.target.value)} /></label><label>使用哪个 Template？<select aria-label="Template Blueprint" value={blueprintKey(selectedBlueprint)} onChange={(event) => onSelectBlueprint(event.target.value)}>{blueprints.map((blueprint) => <option key={blueprintKey(blueprint)} value={blueprintKey(blueprint)}>{blueprint.name} · v{blueprint.version}</option>)}</select></label><div className="harness-template-confirm"><GitBranch size={16} /><span>{selectedBlueprint?.name ?? "等待 Blueprint 加载"}</span><ChevronRight size={15} /><span>固定 Loop 策略与 Workflow 图版本</span></div><div className="harness-builder-link"><span>没有合适的模板？</span><button type="button" onClick={onOpenTemplateBuilder}>先创建 Template</button></div><div className="harness-modal-actions"><button className="harness-secondary-button" type="button" onClick={onClose}>取消</button><button className="harness-primary-button" disabled={busy || !title.trim() || !goal.trim() || !selectedBlueprint} type="submit"><FilePlus2 size={16} />确认 Task</button></div></form></div>;
}

function TemplateBuilderModal({ builderMode, builderTitle, builderDescription, builderLoopName, conductorRole, builderWorkflowName, builderNodes, builderDraft, busy, onModeChange, onTitleChange, onDescriptionChange, onLoopNameChange, onConductorRoleChange, onWorkflowNameChange, onGenerate, onSave, onClose, onAddNode, onNodeDrop, onUpdateNode, onSelectDependencies, onRemoveNode }: { builderMode: BuilderMode; builderTitle: string; builderDescription: string; builderLoopName: string; conductorRole: string; builderWorkflowName: string; builderNodes: ManualNode[]; builderDraft?: NativeGeneratedArchitectureDraft; busy: boolean; onModeChange: (mode: BuilderMode) => void; onTitleChange: (value: string) => void; onDescriptionChange: (value: string) => void; onLoopNameChange: (value: string) => void; onConductorRoleChange: (value: string) => void; onWorkflowNameChange: (value: string) => void; onGenerate: () => void; onSave: () => void; onClose: () => void; onAddNode: () => void; onNodeDrop: (event: DragEvent<HTMLDivElement>) => void; onUpdateNode: (index: number, patch: Partial<ManualNode>) => void; onSelectDependencies: (index: number, dependsOn: string[]) => void; onRemoveNode: (index: number) => void }) {
  const canSave = builderMode === "describe"
    ? builderDraft?.status === "generated"
    : builderTitle.trim() && builderDescription.trim() && builderNodes.length >= 2 && builderNodes[builderNodes.length - 1]?.kind === "verify";
  return <div className="harness-modal-backdrop" role="presentation"><section className="harness-create-modal harness-builder-modal"><ModalTitle title="创建模板" detail="模板定义可复用的协作方式，不会启动任务或 Session。" onClose={onClose} /><div className="harness-builder-mode"><button className={builderMode === "describe" ? "active" : ""} type="button" onClick={() => onModeChange("describe")}><Sparkles size={15} />一句话生成</button><button className={builderMode === "manual" ? "active" : ""} type="button" onClick={() => onModeChange("manual")}><GripVertical size={15} />手工搭建</button></div><label>模板名称<input placeholder="例如：独立检索后汇总校验" value={builderTitle} onChange={(event) => onTitleChange(event.target.value)} /></label><label>希望团队怎样协作？<textarea placeholder="例如：两个独立检索节点收集来源；汇总节点整理；校验节点确认结论和引用。" rows={3} value={builderDescription} onChange={(event) => onDescriptionChange(event.target.value)} /></label>{builderMode === "describe" ? <><div className="harness-builder-callout"><Sparkles size={17} /><span>先生成草案（只生成模板，不运行 Agent）→ 核对 Loop 的回收规则与每个 Workflow 节点 → 保存为可复用版本。</span></div>{builderDraft ? <GeneratedDraftCard draft={builderDraft} /> : null}<div className="harness-modal-actions"><button className="harness-secondary-button" type="button" onClick={onClose}>取消</button>{builderDraft?.status === "generated" ? <button className="harness-primary-button" disabled={busy} type="button" onClick={onSave}><GitBranch size={16} />确认并保存模板</button> : <button className="harness-primary-button" disabled={busy || !builderTitle.trim() || !builderDescription.trim()} type="button" onClick={onGenerate}><Sparkles size={16} />生成草案</button>}</div></> : <><div className="harness-builder-two-columns"><label>Agent Loop 名称<input value={builderLoopName} onChange={(event) => onLoopNameChange(event.target.value)} /></label><label>Conductor 角色<input value={conductorRole} onChange={(event) => onConductorRoleChange(event.target.value)} /></label></div><label>Workflow 名称<input value={builderWorkflowName} onChange={(event) => onWorkflowNameChange(event.target.value)} /></label><div className="harness-node-palette"><span>节点托盘</span><button draggable type="button" onClick={onAddNode} onDragStart={(event) => event.dataTransfer.setData("application/x-agent-workspace-node", "delegate")}><GripVertical size={14} />拖入任务节点</button><small>一个节点对应一个 OpenCode Session；最多 6 个节点、2 个无依赖节点并行；final 固定为 verify。</small></div><div className="harness-manual-canvas" onDragOver={(event) => event.preventDefault()} onDrop={onNodeDrop}>{builderNodes.map((node, index) => <ManualWorkflowNode key={`${node.id}-${index}`} index={index} node={node} nodes={builderNodes} onRemove={() => onRemoveNode(index)} onSelectDependencies={(dependsOn) => onSelectDependencies(index, dependsOn)} onUpdate={(patch) => onUpdateNode(index, patch)} />)}<div className="harness-final-gate">final<br /><small>wake Conductor</small></div></div><div className="harness-modal-actions"><button className="harness-secondary-button" type="button" onClick={onClose}>取消</button><button className="harness-primary-button" disabled={busy || !canSave} type="button" onClick={onSave}><GitBranch size={16} />确认并保存模板</button></div></>}</section></div>;
}

function ManualWorkflowNode({ node, index, nodes, onUpdate, onSelectDependencies, onRemove }: { node: ManualNode; index: number; nodes: ManualNode[]; onUpdate: (patch: Partial<ManualNode>) => void; onSelectDependencies: (dependsOn: string[]) => void; onRemove: () => void }) {
  const previousNodes = nodes.slice(0, index);
  const isFinal = index === nodes.length - 1;
  return <article className="harness-manual-node"><div className="harness-manual-node-head"><GripVertical size={15} /><strong>{isFinal ? "Verify node" : "Task node"}</strong>{!isFinal ? <button aria-label={`移除 ${node.id}`} type="button" onClick={onRemove}>×</button> : null}</div><label>ID<input value={node.id} onChange={(event) => onUpdate({ id: slugify(event.target.value) })} /></label><label>节点名称<input value={node.role} onChange={(event) => onUpdate({ role: event.target.value })} /></label><label>节点职责<input value={node.instruction} onChange={(event) => onUpdate({ instruction: event.target.value })} /></label><label>依赖<input aria-label={`${node.id} dependencies`} value={node.dependsOn.join(", ")} onChange={(event) => onSelectDependencies(event.target.value.split(",").map((value) => value.trim()).filter((value) => previousNodes.some((item) => item.id === value)))} placeholder={previousNodes.map((item) => item.id).join(", ") || "entry node"} /></label><small>{isFinal ? "verify · final node, then Runtime wakes Conductor" : `delegate · 一个节点只对应一个 OpenCode Session；可与无依赖节点并行。`}</small></article>;
}

function TemplateComposition({ loop, workflow }: { loop?: NativeOrchestrationTemplate; workflow?: NativeOrchestrationTemplate }) {
  return <div className="harness-template-composition"><section><div className="harness-composition-label"><Bot size={15} />Agent Loop policy</div><AgentLoopDiagram definition={loop?.definition} /></section><section><div className="harness-composition-label"><GitBranch size={15} />Workflow graph</div><WorkflowDiagram definition={workflow?.definition} /></section></div>;
}

function ModalTitle({ title, detail, onClose }: { title: string; detail: string; onClose: () => void }) { return <div className="harness-modal-title"><div><h2>{title}</h2><p>{detail}</p></div><button aria-label="关闭" type="button" onClick={onClose}>×</button></div>; }

function GeneratedDraftCard({ draft }: { draft: NativeGeneratedArchitectureDraft }) { return <div className="harness-generated-draft"><div><strong>候选 Draft</strong><small>{draft.status === "saved" ? "已保存" : "等待保存"}</small></div><p><b>{draft.candidate.blueprint.name}</b> · {draft.candidate.blueprint.description || draft.candidate.rationale}</p><div className="harness-draft-flow"><span>{draft.candidate.agentLoop.name}</span><ChevronRight size={14} /><span>{draft.candidate.workflow.name}</span></div><div className="harness-draft-nodes">{draft.candidate.workflow.definition.nodes.map((node) => <span key={node.id}><b>{node.id}</b><small>{node.role} · {node.dependsOn.length ? `等待 ${node.dependsOn.join(", ")}` : "可并行"}</small><small>{node.instruction ?? node.role}</small></span>)}</div><p className="harness-draft-runtime-note">当前能力：每个节点只启动一个 OpenCode Session；最多 2 个无依赖节点并行。Workflow 在 final 或异常时返回 Conductor；之后每个修复或复验 Session 返回都会再次触发 Conductor 决策。</p>{draft.candidate.assumptions.length ? <p className="harness-draft-assumptions">假设：{draft.candidate.assumptions.join("；")}</p> : null}</div>; }

function WorkbenchSurface({ run, selectedItem, onSelectItem, onOpenTasks, onRunChange }: { run?: NativeHarnessRunDetail; selectedItem: string; onSelectItem: (item: string) => void; onOpenTasks: () => void; onRunChange: (detail: NativeHarnessRunDetail) => void }) {
  const workflowSelected = selectedItem === "workflow";
  const selectedTurn = lastItem(run?.turns.filter((turn) => turn.sessionId === selectedItem) ?? [])
    ?? run?.turns.find((turn) => turn.status === "running")
    ?? lastItem(run?.turns.filter((turn) => turn.status === "failed") ?? [])
    ?? run?.turns[0];
  const workflowName = run?.task.architecture.nestedWorkflowTemplate?.name ?? "Workflow";
  const conductorTurns = latestTurnPerSession(run?.turns.filter((turn) => turn.purpose === "initial" || turn.purpose === "workflow_return" || turn.purpose === "session_return") ?? []);
  const loopSessionTurns = latestTurnPerSession(run?.turns.filter((turn) => turn.purpose === "remediation" || turn.purpose === "remediation_verify") ?? []);
  const workflowTurns = run?.turns.filter((turn) => turn.purpose === "workflow_node") ?? [];
  const selectSession = (sessionId: string) => onSelectItem(sessionId);
  const attention = selectedTurn ? (run?.attentions ?? []).find((item) => item.sessionId === selectedTurn.sessionId && item.status !== "resolved") : undefined;
  const sendInput = async (turn: NativeHarnessRunDetail["turns"][number], payload: string) => {
    if (!turn.terminal?.incarnationId || !payload) return;
    await enqueueNativeTerminalInput({ workspaceSessionId: turn.sessionId, expectedIncarnationId: turn.terminal.incarnationId, source: "user", payload });
  };
  const resizeTerminal = async (turn: NativeHarnessRunDetail["turns"][number], cols: number, rows: number) => {
    await resizeNativePtySession(turn.sessionId, { cols, rows }, turn.terminal?.incarnationId);
  };
  const respondAttention = async (attentionId: string, response: string) => {
    const detail = await respondNativeHarnessAttention(attentionId, response);
    if (detail) onRunChange(detail);
  };
  return <div className="harness-workbench-layout"><aside className="harness-session-rail"><div className="harness-panel-title"><h1>运行现场</h1></div>{run ? <><div className="harness-session-heading">Task Run · {shortId(run.run.runId)}</div><RuntimeGroup label="Conductor 决策" icon={<Bot size={14} />}>{conductorTurns.map((turn) => <RuntimeSessionRow active={turn.sessionId === selectedItem} key={turn.turnId} onSelect={() => selectSession(turn.sessionId)} turn={turn} />)}</RuntimeGroup>{loopSessionTurns.length ? <RuntimeGroup label="Conductor 派发的 Session" icon={<Bot size={14} />}>{loopSessionTurns.map((turn) => <RuntimeSessionRow active={turn.sessionId === selectedItem} key={turn.turnId} onSelect={() => selectSession(turn.sessionId)} turn={turn} />)}</RuntimeGroup> : null}<RuntimeGroup label="Workflow 执行单元（自主推进）" icon={<ListTree size={14} />}><button className={workflowSelected ? "harness-runtime-row harness-runtime-aggregate active" : "harness-runtime-row harness-runtime-aggregate"} type="button" onClick={() => onSelectItem("workflow")}><GitBranch size={16} /><span><strong>{workflowName}</strong><small>执行图 aggregate · 无终端</small></span><em className={run.workflow?.status}>{run.workflow?.status}</em></button>{workflowTurns.map((turn) => <RuntimeSessionRow active={turn.sessionId === selectedItem} key={turn.turnId} onSelect={() => selectSession(turn.sessionId)} turn={turn} />)}</RuntimeGroup></> : <EmptyState title="没有选中的运行" detail="从任务时间线进入，或先选择一个已启动的 Task Run。" />}</aside><section className="harness-terminal-region">{run ? workflowSelected ? <WorkflowAggregate name={workflowName} onOpenTasks={onOpenTasks} run={run} onSelectSession={selectSession} /> : <SessionRuntimePanel attention={attention} onResize={resizeTerminal} onRespondAttention={respondAttention} onSendInput={sendInput} turn={selectedTurn} /> : <EmptyState title="选择 Task Run" detail="运行现场只显示当前 Task Run 的 Session 与执行图。" />}</section><aside className="harness-inspector">{run ? workflowSelected ? <WorkflowInspector run={run} /> : <SessionInspector attention={attention} turn={selectedTurn} /> : null}<button className="harness-open-timeline" type="button" onClick={onOpenTasks}>查看任务时间线 <ChevronRight size={15} /></button></aside></div>;
}

function TaskRunContext({ run, onOpenRuntime }: { run: NativeHarnessRunDetail; onOpenRuntime: (item: string) => void }) { const active = run.turns.find((turn) => turn.status === "running"); const failed = lastItem(run.turns.filter((turn) => turn.status === "failed")); const corrections = run.instances.find((instance) => instance.kind === "agent_loop")?.details?.correctionRound; return <div className="harness-run-context"><div><span>当前 Task Run</span><strong>{statusLabel(run.run.status)} · {active ? sessionLabel(active) : failed ? sessionLabel(failed) : run.run.status === "delivery_ready" ? "产物已可查看" : "等待下一步"}</strong><small>{run.run.status === "blocked" ? "Runtime 已保留失败 Session 与已发现产物；可修复的问题会在预算内自动回派，不要求人工中继。" : run.run.status === "delivery_ready" ? `${run.artifacts.length} 个 Runtime 发现的交付产物，直接点击查看。` : `${run.nodes.filter((node) => node.status === "succeeded").length}/${run.nodes.length} workflow nodes 已完成${Number(corrections ?? 0) ? ` · 已自动修复 ${corrections} 轮` : ""}`}</small></div><button className="harness-secondary-button compact" type="button" onClick={() => onOpenRuntime(active?.sessionId ?? failed?.sessionId ?? "workflow")}><TerminalSquare size={14} />{failed ? "查看失败原因" : "进入运行现场"}</button></div>; }
function RuntimeGroup({ label, icon, children }: { label: string; icon: ReactNode; children: ReactNode }) { return <section className="harness-runtime-group"><h2>{icon}{label}</h2>{children}</section>; }
function RuntimeSessionRow({ turn, active, onSelect }: { turn: NativeHarnessRunDetail["turns"][number]; active: boolean; onSelect: () => void }) { return <button className={active ? "harness-runtime-row active" : "harness-runtime-row"} type="button" onClick={onSelect}><span className={`harness-state-dot ${turn.status}`} /><span><strong>{sessionLabel(turn)}</strong><small>{turn.terminal?.backend ?? "PTY pending"} · {turn.status}</small></span><ChevronRight size={15} /></button>; }
type ConversationMessage = {
  id: string;
  actor: "user" | "conductor" | "runtime" | "session";
  title: string;
  meta: string;
  body: string;
  sessionId?: string;
};

function TaskConversation({ task, run, onOpenRuntime, onOpenArtifact }: { task: NativeHarnessTask; run?: NativeHarnessRunDetail; onOpenRuntime: (item: string) => void; onOpenArtifact: (artifactPath: string) => void }) {
  const messages = conversationForTask(task, run);
  const openAttentions = (run?.attentions ?? []).filter((attention) => attention.status !== "resolved");
  return <div className="harness-conversation" aria-label="Task conversation">{messages.map((message) => {
    const content = <><div className="harness-conversation-avatar">{message.actor === "user" ? "你" : message.actor === "conductor" ? "C" : message.actor === "runtime" ? "R" : "S"}</div><div className="harness-conversation-content"><header><strong>{message.title}</strong><small>{message.meta}</small>{message.sessionId ? <span>查看 Session 输出 <ChevronRight size={13} /></span> : null}</header><HarnessMarkdown markdown={message.body} /></div></>;
    return message.sessionId ? <button className={`harness-conversation-message ${message.actor} clickable`} key={message.id} type="button" onClick={() => onOpenRuntime(message.sessionId!)}>{content}</button> : <article className={`harness-conversation-message ${message.actor}`} key={message.id}>{content}</article>;
  })}{openAttentions.map((attention) => <button className="harness-attention-timeline" key={attention.attentionId} onClick={() => onOpenRuntime(attention.sessionId)} type="button"><AlertTriangle size={15} /><span><strong>{attention.kind === "permission" ? "OpenCode 正在等待权限决定" : "OpenCode 正在等待你的回答"}</strong><small>{attention.kind === "permission" ? "Runtime 不会自动批准；点击进入当前 Session 处理。" : "点击进入当前 Session 后输入回答。"}</small></span><ChevronRight size={15} /></button>)}{run?.artifacts.length ? <article className="harness-artifact-evidence"><header><FileText size={15} /><div><strong>Runtime 发现的交付产物</strong><small>由每个 Session 前后工作区快照确定；点击直接预览当前文件。</small></div></header><div>{run.artifacts.map((artifact) => <button key={artifact.path} type="button" onClick={() => onOpenArtifact(artifact.path)}><code>{artifact.path}</code><span>{artifact.change === "added" ? "新增" : "已修改"}</span><ChevronRight size={14} /></button>)}</div></article> : null}</div>;
}

function conversationForTask(task: NativeHarnessTask, run?: NativeHarnessRunDetail): ConversationMessage[] {
  const messages: ConversationMessage[] = [{
    id: "task-goal",
    actor: "user",
    title: "你交给 Conductor 的任务",
    meta: "Task input",
    body: task.goal,
  }];
  if (!run) {
    messages.push({ id: "not-started", actor: "runtime", title: "等待启动 Run", meta: "Runtime", body: "选择的 Template 已固定。启动后，Conductor 会先给出 Markdown 执行规划，再由 Runtime 将已确认的 Workflow 输入派发给各个 Session。" });
    return messages;
  }

  const turns = [...run.turns].sort((left, right) => String(left.startedAt ?? "").localeCompare(String(right.startedAt ?? "")));
  let workflowAnnounced = false;
  for (const turn of turns) {
    if (turn.purpose === "workflow_node" && !workflowAnnounced) {
      workflowAnnounced = true;
      const assignments = run.nodes.map((node) => `- **${node.nodeId}** · ${node.role}${node.dependencies.length ? `（等待：${node.dependencies.join(", ")}）` : "（可立即执行）"}\n  ${node.instruction || "完成此节点的受限工作并返回可验证证据。"}`);
      messages.push({ id: "workflow-inputs", actor: "runtime", title: "Workflow 已启动（图自主推进）", meta: "一个 execution unit · 每个节点一个 OpenCode Session", body: `## ${run.task.architecture.nestedWorkflowTemplate?.name ?? "Workflow"}\n${assignments.join("\n")}` });
    }
    const body = turn.output?.answerText || (turn.status === "failed" ? turn.output?.errorText || "Session 已退出，但没有可解析的回答。" : "Session 正在执行；原始 PTY 输出在运行现场持续更新。");
    if (turn.purpose === "initial" || turn.purpose === "workflow_return" || turn.purpose === "session_return") {
      const action = String(turn.output?.action ?? turn.output?.decision ?? "");
      messages.push({ id: turn.turnId, actor: "conductor", title: turn.purpose === "initial" ? "Conductor 的执行规划" : turn.purpose === "workflow_return" ? "Workflow 返回后的 Conductor 决策" : "Session 返回后的 Conductor 决策", meta: action === "dispatch" ? "已派发一个明确的后续 Session" : action === "verify" ? "已请求独立复验" : action === "deliver" ? "交付产物已就绪" : `Conductor · ${turn.status}`, body, sessionId: turn.sessionId });
      continue;
    }
    if (turn.purpose === "workflow_node") {
      const node = run.nodes.find((item) => item.nodeId === turn.nodeId);
      messages.push({ id: turn.turnId, actor: "session", title: `${turn.nodeId} · ${node?.role ?? "Workflow node"}`, meta: `${turn.status} · Workflow 自主节点`, body, sessionId: turn.sessionId });
      continue;
    }
    const isVerify = turn.purpose === "remediation_verify";
    messages.push({ id: turn.turnId, actor: "session", title: isVerify ? "Verifier · Conductor 派发复验" : `${turn.nodeId === "publisher" ? "Publisher" : turn.nodeId} · Conductor 派发`, meta: `${turn.status} · 该 Session 返回后必须唤醒 Conductor`, body, sessionId: turn.sessionId });
  }
  return messages;
}

function HarnessMarkdown({ markdown }: { markdown: string }) {
  return <div className="harness-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]}>{String(markdown || "")}</ReactMarkdown></div>;
}

function ArtifactPreview({ artifact, onClose }: { artifact: NativeHarnessArtifact; onClose: () => void }) {
  const unavailable = !artifact.exists || artifact.contentType === "unsupported";
  return <section className="harness-artifact-preview" aria-label="Artifact preview"><header><div><span>交付产物</span><strong>{artifact.path}</strong><small>{artifact.change === "added" ? "新增文件" : "已修改文件"} · Runtime snapshot evidence</small></div><button aria-label="关闭产物预览" type="button" onClick={onClose}>×</button></header>{unavailable ? <p>{artifact.exists ? "该文件不是可安全预览的文本文件。" : "该文件已不在当前工作区；运行时仍保留了它曾被修改的证据。"}</p> : artifact.contentType === "markdown" ? <HarnessMarkdown markdown={artifact.content ?? ""} /> : artifact.contentType === "html" ? <iframe className="harness-artifact-html" sandbox="" srcDoc={artifact.content ?? ""} title={`${artifact.path} preview`} /> : <pre><code>{artifact.content}</code></pre>}</section>;
}
function AgentLoopDiagram({ definition }: { definition?: Record<string, unknown> }) { const workflow = definition?.nestedWorkflow as { templateId?: string; version?: number } | undefined; return <div className="harness-loop-diagram"><div className="harness-loop-node conductor">Conductor<br /><small>decision</small></div><ChevronRight /><div className="harness-loop-node demand">one Session Demand</div><ChevronRight /><div className="harness-loop-node workflow">bounded Workflow<br /><small>{workflow ? `${workflow.templateId} v${workflow.version}` : "Blueprint reference"}</small></div><ChevronRight /><div className="harness-loop-node return">result / exception</div><ChevronRight /><div className="harness-loop-node conductor">Conductor<br /><small>next decision</small></div><p>Workflow 返回时、以及其后的每一个补证/复验 Session 返回时，Conductor 才决定下一个动作；这不是 Workflow DAG。</p></div>; }
function WorkflowDiagram({ definition, compact = false }: { definition?: Record<string, unknown>; compact?: boolean }) { const nodes = Array.isArray(definition?.nodes) ? definition.nodes as Array<{ id?: string; role?: string; dependsOn?: string[] }> : []; return <div className={`harness-workflow-diagram${compact ? " compact" : ""}`}>{nodes.map((node, index) => <div className="harness-workflow-step" key={node.id}><div><strong>{node.id}</strong><span title={node.role}>{workflowRoleLabel(node.role)}</span><small>{node.dependsOn?.length ? `等待 ${node.dependsOn.join(", ")}` : "可立即执行"}</small></div>{index < nodes.length - 1 ? <ChevronRight size={compact ? 16 : 24} /> : null}</div>)}<div className="harness-final-gate">final<br /><small>唤醒 Conductor</small></div></div>; }
function WorkflowAggregate({ run, name, onSelectSession, onOpenTasks }: { run: NativeHarnessRunDetail; name: string; onSelectSession: (id: string) => void; onOpenTasks: () => void }) {
  const failedNode = run.nodes.find((node) => node.status === "failed");
  const failedTurns = failedNode ? run.turns.filter((turn) => turn.nodeId === failedNode.nodeId) : [];
  const failedTurn = lastItem(failedTurns);
  const completedCount = run.nodes.filter((node) => node.status === "succeeded").length;
  const failureDetail = failedTurn?.output?.errorText || (failedNode ? "OpenCode 已退出，但未返回完整可解析结果。" : "");
  return <div className="harness-workflow-aggregate"><div className="harness-terminal-title"><div><span>Task · {run.task.title}</span><strong>{name}</strong><small className="harness-workflow-progress">{completedCount}/{run.nodes.length} 节点完成{failedNode ? ` · 停在 ${failedNode.nodeId}` : ""}</small></div><em className={run.workflow?.status}>{run.workflow?.status}</em></div>{failedNode ? <div className="harness-workflow-failure"><AlertTriangle size={17} /><div><strong>运行已停止：{failedNode.nodeId} 失败</strong><p>{failureDetail}</p></div><button className="harness-primary-button compact" type="button" onClick={() => failedTurn && onSelectSession(failedTurn.sessionId)}>查看失败 Session 输出</button><button className="harness-secondary-button compact" type="button" onClick={onOpenTasks}>返回任务</button></div> : <div className="harness-workflow-callout"><GitBranch size={16} /><span>执行图只管理节点依赖。选择节点 Session 后可查看其批处理 PTY 输出。</span></div>}<section className="harness-workflow-map"><div className="harness-workflow-section-title"><strong>执行图</strong><span>绿色已完成 · 红色失败 · 黄色等待</span></div><WorkflowDiagram compact definition={{ nodes: run.nodes.map((node) => ({ id: node.nodeId, role: node.role, dependsOn: node.dependencies })) }} /></section><section className="harness-node-run-list"><div className="harness-workflow-section-title"><strong>节点</strong><span>点击查看 Session 输出</span></div>{run.nodes.map((node) => { const turn = lastItem(run.turns.filter((item) => item.nodeId === node.nodeId)); return <button key={node.nodeId} type="button" onClick={() => turn && onSelectSession(turn.sessionId)}><span className={`harness-state-dot ${node.status}`} /><span><strong>{node.nodeId}</strong><small title={node.role}>{workflowRoleLabel(node.role)} · {node.status}</small></span>{turn ? <ChevronRight size={16} /> : null}</button>; })}</section></div>;
}
function SessionRuntimePanel({ turn, attention, onSendInput, onResize, onRespondAttention }: { turn?: NativeHarnessRunDetail["turns"][number]; attention?: NativeHarnessAttention; onSendInput: (turn: NativeHarnessRunDetail["turns"][number], payload: string) => Promise<void>; onResize: (turn: NativeHarnessRunDetail["turns"][number], cols: number, rows: number) => Promise<void>; onRespondAttention: (attentionId: string, response: string) => Promise<void> }) {
  if (!turn) return <EmptyState title="选择一个 Session" detail="每个 OpenCode Session 都属于当前 Task Run。" />;
  const transcript = turn.terminal?.transcript ?? (turn.output?.answerText ? [turn.output.answerText] : []);
  return <div className="harness-session-terminal"><div className="harness-terminal-title"><div><span>{sessionLabel(turn)}</span><strong>OpenCode Session Terminal</strong></div><em className={turn.status}>{turn.status}</em></div>{attention ? <SessionAttentionCard attention={attention} onRespond={onRespondAttention} /> : null}<div className="harness-raw-terminal"><div className="harness-raw-terminal-note">这是 Runtime 所有的原生 OpenCode mini-TUI。它保留 OpenCode 自己的交互界面；Agent Loop 只负责调度和状态，权限或提问会附着在这个 Session 上。所有键盘输入都会经 Runtime 仲裁后写入同一个 PTY。</div><PtyTerminal ariaLabel={`${sessionLabel(turn)} OpenCode terminal`} command="opencode --mini --prompt …" emptyTitle="等待 OpenCode Session" emptyDetail="Runtime 会在 Session 启动后显示 OpenCode 原生 mini-TUI。" onData={(payload) => void onSendInput(turn, payload).catch(() => undefined)} onResize={(cols, rows) => void onResize(turn, cols, rows).catch(() => undefined)} session={turn.terminal} transcriptLines={transcript} /></div></div>;
}
function SessionAttentionCard({ attention, onRespond }: { attention: NativeHarnessAttention; onRespond: (attentionId: string, response: string) => Promise<void> }) {
  const [response, setResponse] = useState("");
  const [sending, setSending] = useState(false);
  const isPermission = attention.kind === "permission";
  const submit = async () => {
    if (!response.trim() || sending) return;
    setSending(true);
    try {
      await onRespond(attention.attentionId, response);
      setResponse("");
    } finally {
      setSending(false);
    }
  };
  return <section className={`harness-session-attention ${attention.kind}`} aria-label="OpenCode attention"><header><AlertTriangle size={16} /><div><strong>{isPermission ? "OpenCode 请求权限" : "OpenCode 正在提问"}</strong><small>{attention.status === "submitted" ? "回答已发送，等待 Session 继续。" : isPermission ? "Runtime 不会代你批准。请依据下方 OpenCode 原始请求决定输入内容。" : "你的回答只会写入当前 Session，不会改变模板或图结构。"}</small></div></header><pre>{attentionPayloadText(attention.payload)}</pre><div className="harness-attention-reply"><textarea aria-label="OpenCode attention response" disabled={sending || attention.status === "submitted"} onChange={(event) => setResponse(event.target.value)} placeholder={isPermission ? "输入 OpenCode 当前界面要求的确认内容。" : "输入给当前 OpenCode Session 的回答。"} rows={2} value={response} /><button className="harness-primary-button compact" disabled={!response.trim() || sending || attention.status === "submitted"} onClick={() => void submit()} type="button">{sending ? "发送中…" : "发送到 Session"}</button></div></section>;
}
function WorkflowInspector({ run }: { run: NativeHarnessRunDetail }) { return <><h2>Workflow Instance</h2><InspectorRow label="状态" value={run.workflow?.status ?? "pending"} /><InspectorRow label="Wake rule" value="final / exception → Conductor" /><InspectorRow label="节点" value={`${run.nodes.filter((node) => node.status === "succeeded").length}/${run.nodes.length} succeeded`} /><InspectorRow label="Conductor 回调" value={run.run.status === "delivery_ready" ? "已验证交付" : run.run.status === "blocked" ? "已记录阻塞原因" : "等待 Workflow 或 Session return"} /><div className="harness-inspector-section"><strong>没有 PTY</strong><p>Workflow 是图执行 aggregate，不是 Provider Session。选择子节点后才会显示对应的 OpenCode PTY。</p></div></>; }
function SessionInspector({ turn, attention }: { turn?: NativeHarnessRunDetail["turns"][number]; attention?: NativeHarnessAttention }) { return <>{turn ? <><h2>Session Runtime</h2><InspectorRow label="Session" value={shortId(turn.sessionId)} /><InspectorRow label="Purpose" value={turn.purpose} /><InspectorRow label="状态" value={turn.status} /><InspectorRow label="Provider" value="OpenCode" /><InspectorRow label="PTY" value={turn.terminal?.backend ?? "not attached"} /><InspectorRow label="Incarnation" value={shortId(turn.terminal?.incarnationId ?? "pending")} /><InspectorRow label="输入" value="Runtime 仲裁 · 用户可在 attention 时写入" />{attention ? <InspectorRow label="待处理" value={attention.kind === "permission" ? "permission" : "user question"} /> : null}<div className="harness-inspector-section"><strong>返回给 Conductor</strong><p>{turn.output?.answerText?.slice(0, 420) ?? "Session 运行中，等待 provider adapter 提取结果。"}</p></div></> : <EmptyState title="选择 Session" detail="选择一个 Session 后，真实 PTY 与 Runtime facts 会共同更新。" />}</> }
function InspectorRow({ label, value }: { label: string; value: string }) { return <div className="harness-inspector-row"><span>{label}</span><strong title={value}>{value}</strong></div>; }
function RailButton({ active, icon, label, onClick }: { active: boolean; icon: ReactNode; label: string; onClick: () => void }) { return <button className={active ? "harness-rail-button active" : "harness-rail-button"} type="button" onClick={onClick}>{icon}<span>{label}</span></button>; }
function EmptyState({ title, detail }: { title: string; detail: string }) { return <div className="harness-empty"><strong>{title}</strong><p>{detail}</p></div>; }
function sessionLabel(turn: NativeHarnessRunDetail["turns"][number]) { if (turn.purpose === "initial") return "Conductor · initial decision"; if (turn.purpose === "workflow_return") return "Conductor · workflow return"; if (turn.purpose === "session_return") return "Conductor · Session return"; if (turn.purpose === "remediation_verify") return "Verifier · Conductor dispatch"; if (turn.purpose === "remediation") return `${turn.nodeId === "publisher" ? "Publisher" : turn.nodeId} · Conductor dispatch`; return `${turn.nodeId} · Workflow node`; }
function blueprintKey(blueprint?: Pick<NativeTemplateBlueprint, "id" | "version">) { return blueprint ? `${blueprint.id}@${blueprint.version}` : ""; }
function shortId(value: string) { return value.length > 22 ? `${value.slice(0, 10)}…${value.slice(-8)}` : value; }
function lastItem<T>(items: T[]) { return items.length ? items[items.length - 1] : undefined; }
function latestTurnPerSession<T extends { sessionId: string }>(turns: T[]) { const latest = new Map<string, T>(); for (const turn of turns) latest.set(turn.sessionId, turn); return [...latest.values()]; }
function workflowRoleLabel(value?: string) { const normalized = String(value ?? "未命名节点").trim().replace(/\s+/g, " "); return normalized.length > 44 ? `${normalized.slice(0, 41)}…` : normalized; }
function attentionPayloadText(payload: Record<string, unknown>) { const candidate = payload.question ?? payload.permission ?? payload.message ?? payload.description ?? payload; return typeof candidate === "string" ? candidate : JSON.stringify(candidate, null, 2); }
function statusLabel(value: string) { return ({ queued: "已确认，等待启动", running: "运行中", delivery_ready: "交付产物已就绪", achieved: "已达成", ready_for_review: "旧版收口（建议重跑）", blocked: "已阻塞" } as Record<string, string>)[value] ?? value; }
function sourceLabel(source: NativeTemplateBlueprint["source"]) { return ({ seed: "内置", generated: "描述生成", manual: "手工构建" } as Record<string, string>)[source] ?? source; }
function slugify(value: string) { return value.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "step"; }
function messageFor(reason: unknown) { const message = reason instanceof Error ? reason.message : String(reason); if (message.includes("workflow_node_must_be_single_session_work")) return "生成的 Workflow 把多个 agent 塞进了一个节点，无法执行。请重新生成：每个搜索 agent 都必须是一个独立节点。"; if (message.includes("tries to dispatch other agents")) return "当前模板版本把多个 agent 塞进了一个 Workflow 节点，无法启动。请新建一个模板版本：每个搜索 agent 都必须是独立节点。"; return message; }

import {
  Archive,
  Bot,
  Boxes,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
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
  validateNativeAgentLoopProjectDirectory,
  copyNativeAgentLoopTemplate,
  createNativeAgentLoopTask,
  defaultOpencodeRunModel,
  deleteNativeAgentLoopTask,
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
  respondNativeAgentLoopPermission,
  respondNativeAgentLoopQuestion,
  resizeNativePtySession,
  saveNativeAgentLoopWorkbenchLayout,
  saveNativeAgentLoopTemplate,
  suggestNativeAgentLoopProjectDirectories,
  startNativeAgentLoopRun,
  stopNativeAgentLoopTask,
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
import { nativeTerminalEmptyState, taskStatusLabel, workbenchActivity } from "./runPresentation";
import { TaskConversationComposer } from "./tasks/TaskConversationComposer";

type View = "tasks" | "templates" | "workbench";
type Theme = "dark" | "light";
type TaskListMode = "active" | "completed";
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
  expectedOutput: "Markdown with evidence, conclusions, and remaining risks.",
});

function blankTemplate(): TemplateDraft {
  return {
    id: `loop-${Date.now().toString(36)}`,
    name: "New Agent Loop",
    source: "manual",
    conductor: {
      role: "Conductor",
      model: defaultOpencodeRunModel,
      charter: "Conductor owns every Session Agent dispatch and reacts only to semantic Runtime returns. Decide each next dispatch from the task goal, durable Session returns, and user follow-ups. Use the available cards as capabilities, never as a fixed route.",
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
  const [taskListMode, setTaskListMode] = useState<TaskListMode>("active");
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>();
  const [selectedTaskId, setSelectedTaskId] = useState<string>();
  const [run, setRun] = useState<NativeAgentLoopRunDetail>();
  const [selectedSessionId, setSelectedSessionId] = useState<string>();
  const [showTaskCreate, setShowTaskCreate] = useState(false);
  const [showTemplateStarter, setShowTemplateStarter] = useState(false);
  const [showTemplateEditor, setShowTemplateEditor] = useState(false);
  const [templateDraft, setTemplateDraft] = useState<TemplateDraft>(blankTemplate());
  const [templateBrief, setTemplateBrief] = useState("");
  const [returnToTaskAfterTemplate, setReturnToTaskAfterTemplate] = useState(false);
  const [taskTitle, setTaskTitle] = useState("");
  const [taskGoal, setTaskGoal] = useState("");
  const [taskTemplateId, setTaskTemplateId] = useState("");
  const [taskProjectPath, setTaskProjectPath] = useState(projectPath);
  const [taskProjectVerified, setTaskProjectVerified] = useState(true);
  const taskProjectPathRef = useRef(projectPath);
  const [busy, setBusy] = useState(false);
  const [messageBusy, setMessageBusy] = useState(false);
  // A draft belongs to a Task, not to the mounted textarea.  The Task page is
  // intentionally unmounted when the user opens Templates or Workbench.
  const [taskMessageDrafts, setTaskMessageDrafts] = useState<Record<string, string>>({});
  const [questionAnswerDrafts, setQuestionAnswerDrafts] = useState<Record<string, string>>({});
  const [permissionBusyId, setPermissionBusyId] = useState<string>();
  const [questionBusyId, setQuestionBusyId] = useState<string>();
  const [error, setError] = useState<string>();
  const [artifactPreview, setArtifactPreview] = useState<NativeAgentLoopArtifact>();
  const [stopTarget, setStopTarget] = useState<NativeAgentLoopTask>();
  const [selectedAchievedTaskIds, setSelectedAchievedTaskIds] = useState<string[]>([]);
  const [deleteTargetIds, setDeleteTargetIds] = useState<string[]>();
  // A Task deletion is final for this renderer lifetime.  Runtime events and
  // an in-flight list/read request can resolve after the delete IPC succeeds;
  // they must never re-open a removed Task in the Workbench.
  const deletedTaskIdsRef = useRef(new Set<string>());
  const selectedTaskIdRef = useRef<string | undefined>(undefined);
  const taskRefreshGenerationRef = useRef(0);
  const runReadGenerationRef = useRef(0);

  const selectedTemplate = templates.find((template) => template.id === selectedTemplateId) ?? templates[0];
  const activeTasks = useMemo(() => tasks.filter((task) => !["achieved", "archived"].includes(task.status)), [tasks]);
  const completedTasks = useMemo(() => tasks.filter((task) => ["achieved", "archived"].includes(task.status)), [tasks]);
  const visibleTasks = taskListMode === "active" ? activeTasks : completedTasks;
  const selectedTask = visibleTasks.find((task) => task.taskId === selectedTaskId) ?? visibleTasks[0];

  const applyTaskList = useCallback((nextTasks: NativeAgentLoopTask[]) => {
    const deletedTaskIds = deletedTaskIdsRef.current;
    setTasks(nextTasks.filter((task) => !deletedTaskIds.has(task.taskId)));
  }, []);

  const acceptRun = useCallback((detail: NativeAgentLoopRunDetail) => {
    if (deletedTaskIdsRef.current.has(detail.task.taskId)) return;
    setRun(detail);
    setTasks((current) => current.map((task) => task.taskId === detail.task.taskId ? { ...task, ...detail.task, latestRun: detail.run } : task));
    setSelectedSessionId((current) => current && detail.turns.some((turn) => turn.sessionId === current) ? current : detail.turns[0]?.sessionId);
  }, []);

  const loadRun = useCallback(async (runId: string, expectedTaskId?: string) => {
    const requestGeneration = ++runReadGenerationRef.current;
    const detail = await readNativeAgentLoopRun(runId);
    if (!detail || requestGeneration !== runReadGenerationRef.current) return undefined;
    if (deletedTaskIdsRef.current.has(detail.task.taskId)) return undefined;
    const selectedTaskId = selectedTaskIdRef.current;
    if (expectedTaskId && selectedTaskId !== expectedTaskId) return undefined;
    if (selectedTaskId && detail.task.taskId !== selectedTaskId) return undefined;
    acceptRun(detail);
    return detail;
  }, [acceptRun]);

  const refresh = useCallback(async (preferredTaskId?: string) => {
    const refreshGeneration = ++taskRefreshGenerationRef.current;
    const [nextTemplates, nextTasks] = await Promise.all([listNativeAgentLoopTemplates(), listNativeAgentLoopTasks()]);
    if (refreshGeneration !== taskRefreshGenerationRef.current) return;
    setTemplates(nextTemplates);
    const visibleNextTasks = nextTasks.filter((task) => !deletedTaskIdsRef.current.has(task.taskId));
    applyTaskList(nextTasks);
    const preferred = visibleNextTasks.find((task) => task.taskId === preferredTaskId || task.taskId === selectedTaskIdRef.current) ?? visibleNextTasks[0];
    const template = nextTemplates.find((item) => item.id === selectedTemplateId) ?? nextTemplates[0];
    setSelectedTemplateId(template?.id);
    setTaskTemplateId((current) => nextTemplates.some((item) => item.id === current) ? current : template?.id ?? "");
    selectedTaskIdRef.current = preferred?.taskId;
    setSelectedTaskId(preferred?.taskId);
    if (preferred?.latestRun?.runId) {
      await loadRun(preferred.latestRun.runId, preferred.taskId);
    } else {
      runReadGenerationRef.current += 1;
      setRun(undefined);
      setSelectedSessionId(undefined);
    }
  }, [applyTaskList, loadRun, selectedTemplateId]);

  useEffect(() => {
    void refresh().catch((reason: unknown) => setError(messageFor(reason)));
  }, []); // First desktop load only; refresh has deliberate live selection inputs.

  const refreshRun = useCallback((runId: string) => {
    return loadRun(runId)
      .catch((reason: unknown) => setError(messageFor(reason)));
  }, [loadRun]);

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
    void listNativeAgentLoopTasks().then(applyTaskList).catch((reason: unknown) => setError(messageFor(reason)));
  }), [applyTaskList, refreshRun, run?.run.runId]);

  const openNewTemplate = (brief = "", returnToTask = false) => {
    setTemplateBrief(brief);
    setReturnToTaskAfterTemplate(returnToTask);
    setError(undefined);
    setShowTemplateStarter(true);
  };
  const openManualTemplate = () => {
    setTemplateDraft(blankTemplate());
    setError(undefined);
    setShowTemplateStarter(false);
    setShowTemplateEditor(true);
  };
  const openTemplateEdit = (template: NativeAgentLoopTemplate) => {
    setTemplateDraft(templateDraftFrom(template));
    setError(undefined);
    setShowTemplateEditor(true);
  };

  const generateTemplate = async () => {
    if (!templateBrief.trim()) return;
    setBusy(true);
    setError(undefined);
    try {
      const generated = await generateNativeAgentLoopTemplate({
        cwd: projectPath,
        projectName,
        brief: templateBrief.trim(),
      });
      if (!generated) throw new Error("桌面 Runtime 未返回 Template 草案。");
      setTemplateDraft(generated.template);
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
    if (!template || !taskProjectVerified) return;
    setBusy(true);
    setError(undefined);
    try {
      const task = await createNativeAgentLoopTask({
        cwd: taskProjectPath,
        projectId: projectNameFromPath(taskProjectPath),
        title: taskTitle.trim(),
        goal: taskGoal.trim(),
        templateId: template.id,
        templateVersion: template.version,
      });
      if (!task) throw new Error("桌面 Runtime 未创建 Task。");
      setShowTaskCreate(false);
      selectedTaskIdRef.current = task.taskId;
      setSelectedTaskId(task.taskId);
      await refresh(task.taskId);
    } catch (reason) { setError(messageFor(reason)); } finally { setBusy(false); }
  };

  const changeTaskProjectPath = (value: string) => {
    taskProjectPathRef.current = value;
    setTaskProjectPath(value);
    setTaskProjectVerified(false);
  };

  const validateTaskProject = async (candidate = taskProjectPathRef.current) => {
    const requestedPath = candidate.trim();
    if (!requestedPath) return;
    setBusy(true);
    setError(undefined);
    try {
      const validated = await validateNativeAgentLoopProjectDirectory(requestedPath);
      if (!validated?.path) throw new Error("本地 Host 未确认项目文件夹。");
      if (taskProjectPathRef.current !== requestedPath) return;
      taskProjectPathRef.current = validated.path;
      setTaskProjectPath(validated.path);
      setTaskProjectVerified(true);
    } catch (reason) {
      if (taskProjectPathRef.current === requestedPath) setError(messageFor(reason));
    } finally { setBusy(false); }
  };

  const startRun = async () => {
    if (!selectedTask) return;
    setBusy(true);
    setError(undefined);
    try {
      const detail = await startNativeAgentLoopRun(selectedTask.taskId);
      if (!detail) throw new Error("桌面 Runtime 未创建 Agent Loop Run。");
      selectedTaskIdRef.current = detail.task.taskId;
      acceptRun(detail);
      setTaskListMode("active");
      setSelectedTaskId(detail.task.taskId);
      setView("workbench");
      await refresh(selectedTask.taskId);
    } catch (reason) { setError(messageFor(reason)); } finally { setBusy(false); }
  };

  const markAchieved = async () => {
    if (!selectedTask) return;
    setBusy(true);
    try {
      const achieved = await markNativeAgentLoopTaskAchieved(selectedTask.taskId);
      if (!achieved) throw new Error("桌面 Runtime 未确认 Task 的 achieved 状态。");
      setTaskListMode("completed");
      selectedTaskIdRef.current = achieved.taskId;
      setSelectedTaskId(achieved.taskId);
      await refresh(selectedTask.taskId);
    } catch (reason) { setError(messageFor(reason)); } finally { setBusy(false); }
  };

  const stopTask = async () => {
    if (!stopTarget) return;
    const stoppedTaskId = stopTarget.taskId;
    setBusy(true);
    setError(undefined);
    try {
      const stopped = await stopNativeAgentLoopTask(stoppedTaskId);
      if (!stopped) throw new Error("桌面 Runtime 未确认 Task 已停止。");
      setTasks((current) => current.map((task) => task.taskId === stoppedTaskId ? { ...task, ...stopped } : task));
      setStopTarget(undefined);
      selectedTaskIdRef.current = stopped.taskId;
      setSelectedTaskId(stopped.taskId);
      await refresh(stopped.taskId);
    } catch (reason) { setError(messageFor(reason)); } finally { setBusy(false); }
  };

  const deleteAchievedTasks = async () => {
    const targetIds = deleteTargetIds ?? [];
    if (!targetIds.length) return;
    setBusy(true);
    setError(undefined);
    try {
      for (const taskId of targetIds) {
        const result = await deleteNativeAgentLoopTask(taskId);
        if (!result?.deleted) throw new Error("桌面 Runtime 未删除所选 Task。");
        deletedTaskIdsRef.current.add(taskId);
      }
      // Remove selected history synchronously before refresh. A late Runtime
      // event must never reopen a Task the user just removed.
      setTasks((current) => current.filter((task) => !targetIds.includes(task.taskId)));
      setTaskMessageDrafts((current) => {
        let changed = false;
        const next: Record<string, string> = {};
        for (const [taskId, draft] of Object.entries(current)) {
          if (targetIds.includes(taskId)) {
            changed = true;
            continue;
          }
          next[taskId] = draft;
        }
        return changed ? next : current;
      });
      setRun((current) => current && targetIds.includes(current.task.taskId) ? undefined : current);
      setSelectedSessionId((current) => run && targetIds.includes(run.task.taskId) ? undefined : current);
      setArtifactPreview(undefined);
      setDeleteTargetIds(undefined);
      setSelectedAchievedTaskIds((current) => current.filter((taskId) => !targetIds.includes(taskId)));
      selectedTaskIdRef.current = undefined;
      taskRefreshGenerationRef.current += 1;
      runReadGenerationRef.current += 1;
      setSelectedTaskId(undefined);
      setTaskListMode("completed");
      await refresh();
    } catch (reason) { setError(messageFor(reason)); } finally { setBusy(false); }
  };

  const selectTask = useCallback((task: NativeAgentLoopTask) => {
    taskRefreshGenerationRef.current += 1;
    selectedTaskIdRef.current = task.taskId;
    setSelectedTaskId(task.taskId);
    setArtifactPreview(undefined);
    if (task.latestRun?.runId) {
      void loadRun(task.latestRun.runId, task.taskId).catch((reason: unknown) => setError(messageFor(reason)));
    } else {
      runReadGenerationRef.current += 1;
      setRun(undefined);
      setSelectedSessionId(undefined);
    }
  }, [loadRun]);

  const switchTaskList = (mode: TaskListMode) => {
    const candidates = mode === "active" ? activeTasks : completedTasks;
    setTaskListMode(mode);
    if (mode === "active") setSelectedAchievedTaskIds([]);
    if (candidates[0]) selectTask(candidates[0]);
    else {
      selectedTaskIdRef.current = undefined;
      taskRefreshGenerationRef.current += 1;
      runReadGenerationRef.current += 1;
      setSelectedTaskId(undefined);
      setRun(undefined);
      setSelectedSessionId(undefined);
    }
  };

  const sendTaskMessage = useCallback(async (message: string) => {
    if (!selectedTask || !message.trim()) return;
    const taskId = selectedTask.taskId;
    const submitted = message.trim();
    setMessageBusy(true);
    setError(undefined);
    try {
      const result = await appendNativeTaskEvent({
        taskId,
        cwd: selectedTask.cwd,
        type: "task.user_message",
        summary: submitted,
        data: { message: submitted },
      });
      if (!result.ok) throw new Error(result.error || "无法将消息交给 Conductor。");
      // Clear only the exact draft that was accepted.  This preserves text if
      // the user changed it before an asynchronous Runtime receipt returned.
      setTaskMessageDrafts((current) => {
        if ((current[taskId] ?? "").trim() !== submitted) return current;
        const { [taskId]: _sent, ...remaining } = current;
        return remaining;
      });
      await refresh(taskId);
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

  const respondPermission = useCallback(async (permission: Record<string, unknown>, response: "once" | "always" | "reject") => {
    if (!selectedTask) return;
    const permissionId = String(permission.permissionId ?? "");
    const sessionId = String(permission.sessionId ?? "");
    if (!permissionId || !sessionId) return;
    setPermissionBusyId(permissionId);
    setError(undefined);
    try {
      const result = await respondNativeAgentLoopPermission({ taskId: selectedTask.taskId, sessionId, permissionId, response });
      if (!result?.ok) throw new Error(result?.message || result?.errorCode || "无法提交 OpenCode 授权答复。");
      await refresh(selectedTask.taskId);
    } catch (reason) {
      setError(messageFor(reason));
    } finally {
      setPermissionBusyId(undefined);
    }
  }, [refresh, selectedTask]);

  const respondQuestion = useCallback(async (question: TaskQuestion, answer: string) => {
    if (!selectedTask || !answer.trim()) return;
    const draftKey = taskQuestionDraftKey(question);
    const submitted = answer.trim();
    setQuestionBusyId(draftKey);
    setError(undefined);
    try {
      const result = await respondNativeAgentLoopQuestion({
        taskId: selectedTask.taskId,
        sessionId: question.sessionId,
        questionId: question.questionId,
        answer: submitted,
      });
      if (!result?.ok) throw new Error(result?.message || result?.errorCode || "无法将回答写入 OpenCode 原生问题。");
      setQuestionAnswerDrafts((current) => {
        if ((current[draftKey] ?? "").trim() !== submitted) return current;
        const { [draftKey]: _sent, ...remaining } = current;
        return remaining;
      });
      await refresh(selectedTask.taskId);
    } catch (reason) {
      setError(messageFor(reason));
    } finally {
      setQuestionBusyId(undefined);
    }
  }, [refresh, selectedTask]);

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
          tasks={visibleTasks} selectedTask={selectedTask} run={run} timeline={timeline} taskListMode={taskListMode} activeTaskCount={activeTasks.length} completedTaskCount={completedTasks.length} selectedAchievedTaskIds={selectedAchievedTaskIds} runtimeAvailable={runtimeAvailable} busy={busy} messageBusy={messageBusy}
          onSelect={selectTask} onListModeChange={switchTaskList}
          onCreate={() => { setTaskTitle(""); setTaskGoal(""); setTaskTemplateId(selectedTemplate?.id ?? ""); taskProjectPathRef.current = projectPath; setTaskProjectPath(projectPath); setTaskProjectVerified(true); setShowTaskCreate(true); }}
          onStart={startRun} onAchieved={markAchieved} onStop={(task) => setStopTarget(task)} onToggleAchievedSelection={(taskId) => setSelectedAchievedTaskIds((current) => current.includes(taskId) ? current.filter((id) => id !== taskId) : [...current, taskId])} onDeleteAchievedSelection={() => setDeleteTargetIds(selectedAchievedTaskIds)} messageDraft={selectedTask ? taskMessageDrafts[selectedTask.taskId] ?? "" : ""} onMessageDraftChange={(message) => selectedTask && setTaskMessageDrafts((current) => current[selectedTask.taskId] === message ? current : { ...current, [selectedTask.taskId]: message })} onMessage={sendTaskMessage} onPermissionResponse={respondPermission} permissionBusyId={permissionBusyId} questionAnswerDrafts={questionAnswerDrafts} questionBusyId={questionBusyId} onQuestionAnswerDraftChange={(question, answer) => setQuestionAnswerDrafts((current) => current[taskQuestionDraftKey(question)] === answer ? current : { ...current, [taskQuestionDraftKey(question)]: answer })} onQuestionAnswer={respondQuestion} onWorkbench={() => setView("workbench")} onPermissionTerminal={(sessionId) => { setSelectedSessionId(sessionId); setView("workbench"); }} onArtifact={(path) => void openArtifact(path)} />}
        {view === "templates" && <TemplateSurface
          templates={templates} selectedTemplate={selectedTemplate} runtimeAvailable={runtimeAvailable} busy={busy}
          onSelect={(template) => setSelectedTemplateId(template.id)} onCreate={openNewTemplate} onEdit={openTemplateEdit}
          onCopy={() => void copyTemplate()} onArchive={() => void archiveTemplate()} onDelete={() => void deleteTemplate()} />}
        {view === "workbench" && <WorkbenchSurface
          run={run} tasks={activeTasks} selectedTaskId={selectedTask?.taskId} selectedSessionId={selectedSessionId} runtimeAvailable={runtimeAvailable} theme={theme}
          onSelectTask={selectTask}
          onSelectSession={setSelectedSessionId}
          onArtifact={(path) => void openArtifact(path)}
          onLayoutChange={async (layout) => {
            if (!run) return;
            const saved = await saveNativeAgentLoopWorkbenchLayout(run.run.runId, layout);
            if (saved) setRun((current) => current?.run.runId === run.run.runId ? { ...current, workbenchLayout: saved } : current);
          }} />}
      </main>
      {showTaskCreate && <TaskDialog
        templates={templates} title={taskTitle} goal={taskGoal} templateId={taskTemplateId} projectPath={taskProjectPath} projectVerified={taskProjectVerified} busy={busy} enabled={runtimeAvailable}
        onTitle={setTaskTitle} onGoal={setTaskGoal} onTemplate={setTaskTemplateId} onProjectPath={changeTaskProjectPath} onValidateProject={(path) => void validateTaskProject(path)} onClose={() => setShowTaskCreate(false)} onCreateTemplate={() => { setShowTaskCreate(false); openNewTemplate(taskGoal, true); }} onCreate={() => void createTask()} />}
      {showTemplateStarter && <TemplateStarterDialog brief={templateBrief} busy={busy} enabled={runtimeAvailable} onBrief={setTemplateBrief} onClose={() => { setShowTemplateStarter(false); setReturnToTaskAfterTemplate(false); }} onManual={openManualTemplate} onGenerate={() => void generateTemplate()} />}
      {showTemplateEditor && <TemplateDialog draft={templateDraft} busy={busy} enabled={runtimeAvailable} onChange={setTemplateDraft} onClose={() => { setShowTemplateEditor(false); setReturnToTaskAfterTemplate(false); }} onSave={() => void saveTemplate()} />}
      {artifactPreview && <ArtifactDialog artifact={artifactPreview} onClose={() => setArtifactPreview(undefined)} />}
      {stopTarget && <TaskStopDialog task={stopTarget} busy={busy} onCancel={() => setStopTarget(undefined)} onConfirm={() => void stopTask()} />}
      {deleteTargetIds?.length ? <TaskDeleteDialog tasks={tasks.filter((task) => deleteTargetIds.includes(task.taskId))} busy={busy} onCancel={() => setDeleteTargetIds(undefined)} onConfirm={() => void deleteAchievedTasks()} /> : null}
      {error && <div className="harness-error" role="alert">{error}</div>}
    </div>
  );
}

function RailButton({ active, onClick, icon, label }: { active: boolean; onClick: () => void; icon: import("react").ReactNode; label: string }) {
  return <button className={`harness-rail-button ${active ? "active" : ""}`} onClick={onClick}>{icon}<span>{label}</span></button>;
}

type TaskQuestion = {
  sessionId: string;
  questionId: string;
  question: string;
  createdAt?: string;
};

function TaskSurface({ tasks, selectedTask, run, timeline, taskListMode, activeTaskCount, completedTaskCount, selectedAchievedTaskIds, runtimeAvailable, busy, messageBusy, permissionBusyId, questionAnswerDrafts, questionBusyId, onSelect, onListModeChange, onCreate, onStart, onAchieved, onStop, onToggleAchievedSelection, onDeleteAchievedSelection, messageDraft, onMessageDraftChange, onMessage, onPermissionResponse, onQuestionAnswerDraftChange, onQuestionAnswer, onWorkbench, onPermissionTerminal, onArtifact }: {
  tasks: NativeAgentLoopTask[]; selectedTask?: NativeAgentLoopTask; run?: NativeAgentLoopRunDetail; timeline: TimelineItem[]; taskListMode: TaskListMode; activeTaskCount: number; completedTaskCount: number; selectedAchievedTaskIds: string[]; runtimeAvailable: boolean; busy: boolean; messageBusy: boolean;
  permissionBusyId?: string; questionAnswerDrafts: Record<string, string>; questionBusyId?: string;
  onSelect: (task: NativeAgentLoopTask) => void; onListModeChange: (mode: TaskListMode) => void; onCreate: () => void; onStart: () => void; onAchieved: () => void; onStop: (task: NativeAgentLoopTask) => void; onToggleAchievedSelection: (taskId: string) => void; onDeleteAchievedSelection: () => void; messageDraft: string; onMessageDraftChange: (message: string) => void; onMessage: (message: string) => Promise<void>; onPermissionResponse: (permission: Record<string, unknown>, response: "once" | "always" | "reject") => Promise<void>; onQuestionAnswerDraftChange: (question: TaskQuestion, answer: string) => void; onQuestionAnswer: (question: TaskQuestion, answer: string) => Promise<void>; onWorkbench: () => void; onPermissionTerminal: (sessionId: string) => void; onArtifact: (path: string) => void;
}) {
  const completed = taskListMode === "completed";
  const selectedActivity = run?.task.taskId === selectedTask?.taskId ? workbenchActivity(run) : undefined;
  const sessionNames = useMemo(() => new Map((run?.turns ?? []).map((turn) => [turn.sessionId, turn.details.card.name])), [run?.turns]);
  const [inspectorCollapsed, setInspectorCollapsed] = useState(false);
  return <div className={`harness-task-layout ${inspectorCollapsed ? "inspector-collapsed" : ""}`}>
    <aside className="harness-task-list"><div className="harness-panel-title"><h1>{completed ? "已完成任务" : "任务"}</h1>{completed ? <button className="harness-secondary-button compact danger" disabled={!runtimeAvailable || busy || !selectedAchievedTaskIds.length} onClick={onDeleteAchievedSelection}><Trash2 size={14} /> 删除所选{selectedAchievedTaskIds.length ? ` (${selectedAchievedTaskIds.length})` : ""}</button> : <button className="harness-primary-button compact" disabled={!runtimeAvailable} onClick={onCreate}><Plus size={15} /> 新建</button>}</div><p className="harness-list-caption">{completed ? "已确认交付的 Task 在这里保留历史、产物与重跑入口。勾选后统一删除，仅清理 Runtime 记录。" : "进行中 Task 固定快照一个 Agent Loop Template；确认交付后进入已完成任务管理。"}</p><div className="harness-task-rows" aria-label={completed ? "已完成任务列表" : "Task 列表"}>{tasks.length ? tasks.map((task) => {
      const active = task.taskId === selectedTask?.taskId;
      const currentActivity = active ? selectedActivity : undefined;
      return <div className={`harness-task-row-wrap ${completed ? "completed" : ""}`} key={task.taskId}>{completed && task.status === "achieved" && <label className="harness-achieved-select" title={`选择“${task.title}”删除`} onClick={(event) => event.stopPropagation()}><input type="checkbox" checked={selectedAchievedTaskIds.includes(task.taskId)} onChange={() => onToggleAchievedSelection(task.taskId)} /><span className="sr-only">{`选择“${task.title}”`}</span></label>}<button className={`harness-task-row ${active ? "active" : ""}`} onClick={() => onSelect(task)}><i className={`harness-state-dot ${task.status}`} /><span><strong>{task.title}</strong><small>{task.architecture.template.name} · v{task.architecture.template.version}</small></span><em title={currentActivity ? `Task 生命周期：${taskStatusLabel(task.status)}；当前活动态：${currentActivity.label}` : undefined}>{currentActivity?.shortLabel ?? taskStatusLabel(task.status)}</em></button></div>;
    }) : <Empty title={completed ? "还没有已完成任务" : "还没有进行中 Task"} detail={completed ? "确认交付后的 Task 会自动移动到这里。" : "新建 Task 后，它会出现在这个列表。"} />}</div><button className={`harness-task-manager-button ${completed ? "active" : ""}`} onClick={() => onListModeChange(completed ? "active" : "completed")}><Archive size={15} /><span>{completed ? "返回进行中任务" : "已完成任务"}</span><b>{completed ? activeTaskCount : completedTaskCount}</b><ChevronRight size={15} /></button></aside>
    <section className="harness-timeline-panel">{selectedTask ? <>
      <header className="harness-task-head"><div><div className="harness-breadcrumb">Task / {completed ? "Completed history" : "Agent Loop"}</div><h1>{selectedTask.title}</h1><p>{selectedTask.goal}</p></div><div className="harness-task-actions">{selectedTask.status === "queued" && <button className="harness-primary-button" disabled={!runtimeAvailable || busy} onClick={onStart}><Play size={15} /> 启动 Agent Loop</button>}{selectedTask.status === "stopped" && <button className="harness-primary-button" disabled={!runtimeAvailable || busy} onClick={onStart}><Play size={15} /> 重新启动</button>}{["running", "delivery_ready"].includes(selectedTask.status) && <><button className="harness-secondary-button" onClick={onWorkbench}><TerminalSquare size={15} /> 进入运行现场</button><button className="harness-primary-button" disabled={busy || !runtimeAvailable} onClick={onAchieved}><CheckCircle2 size={15} /> Achieve</button></>}{selectedTask.status === "achieved" && <span className="harness-achieved-label"><CheckCircle2 size={15} /> achieved</span>}</div></header>
      <div className="harness-timeline-meta"><b>Agent Loop</b><ChevronRight size={14} /><span>Conductor 派发原生 Session Agent；每次结果、失败或需要输入才唤醒 Conductor。</span></div>
      <section className="harness-task-activity" aria-label="Task 活动">
        <div className="harness-conversation" aria-label="任务时间线" role="log" tabIndex={0}>{timeline.map((item) => <TimelineMessage item={item} key={item.id} />)}</div>
      </section>
      {["running", "delivery_ready"].includes(selectedTask.status) && <TaskConversationComposer disabled={!runtimeAvailable || messageBusy} message={messageDraft} continuity={run?.task.taskId === selectedTask.taskId ? run.continuity : undefined} onMessageChange={onMessageDraftChange} onSubmit={onMessage} onStop={() => onStop(selectedTask)} />}
    </> : <Empty title={completed ? "还没有已完成任务" : "还没有进行中 Task"} detail={completed ? "确认交付后的 Task 会自动移动到这里。" : "先从已保存的 Agent Loop Template 创建一个任务。"} />}</section>
    <TaskInspector task={selectedTask} run={run} completed={completed} collapsed={inspectorCollapsed} busy={busy} runtimeAvailable={runtimeAvailable} permissions={run?.runtimeState.permissions ?? []} questions={pendingTaskQuestions(run)} questionAnswerDrafts={questionAnswerDrafts} sessionNames={sessionNames} permissionBusyId={permissionBusyId} questionBusyId={questionBusyId} onPermissionResponse={onPermissionResponse} onQuestionAnswerDraftChange={onQuestionAnswerDraftChange} onQuestionAnswer={onQuestionAnswer} onPermissionTerminal={onPermissionTerminal} onToggle={() => setInspectorCollapsed((current) => !current)} onStart={onStart} onWorkbench={onWorkbench} onArtifact={onArtifact} />
  </div>;
}

function PermissionRequests({ permissions, sessionNames, busyId, disabled, onRespond, onOpenTerminal }: {
  permissions: unknown[];
  sessionNames: ReadonlyMap<string, string>;
  busyId?: string;
  disabled: boolean;
  onRespond: (permission: Record<string, unknown>, response: "once" | "always" | "reject") => Promise<void>;
  onOpenTerminal: (sessionId: string) => void;
}) {
  // A permission card is an actionable, one-shot control—not a status feed.
  // Once the reply reaches the Provider transport, its card is consumed and
  // the durable receipt belongs in Timeline. A transport failure remains
  // `reply_failed`, so it stays actionable rather than silently disappearing.
  const pending = permissions
    .filter((permission): permission is Record<string, unknown> => isRecord(permission) && ["requested", "reply_failed"].includes(String(permission.status ?? "requested")))
    .sort((left, right) => String(left.requestedAt ?? "").localeCompare(String(right.requestedAt ?? "")));
  if (!pending.length) return null;
  return <section className="agent-loop-permission-requests" aria-label="OpenCode 权限请求">
    <header><strong>需要授权</strong><small>{pending.length === 1 ? "由原生 Session 提出" : `${pending.length} 个请求，按顺序处理`}</small></header>
    <div className="agent-loop-permission-deck" aria-label={`${pending.length} 个待处理 OpenCode 权限请求`}>
    {pending.map((permission, index) => {
      const permissionId = String(permission.permissionId ?? "");
      const sessionId = String(permission.sessionId ?? "");
      const busy = busyId === permissionId;
      const patterns = Array.isArray(permission.patterns) ? permission.patterns.map(String).filter(Boolean) : [];
      const sessionName = sessionNames.get(sessionId) || shortSession(sessionId) || "原生 Session";
      const active = index === 0;
      return <article aria-hidden={!active} className={`agent-loop-permission-request ${active ? "active" : "queued"}`} key={`${sessionId}:${permissionId}`} style={{ "--permission-stack-index": index } as import("react").CSSProperties}>
        <div><strong>OpenCode 请求授权</strong><span>由 {sessionName} 提出</span></div>
        <dl><dt>操作</dt><dd>{String(permission.permission ?? "操作")}</dd>{patterns.length ? <><dt>范围</dt><dd>{patterns.join(" · ")}</dd></> : null}</dl>
        <p>{String(permission.summary ?? "OpenCode 正在等待你的授权。").trim()}</p>
        {String(permission.status ?? "") === "reply_failed" ? <small>OpenCode 尚未接收上次答复，请重新选择。</small> : null}
        {active ? <div className="agent-loop-permission-actions">
          <button className="harness-secondary-button compact" disabled={disabled || busy} onClick={() => void onRespond(permission, "once")}>仅此次允许</button>
          <button className="harness-secondary-button compact" disabled={disabled || busy} onClick={() => void onRespond(permission, "always")}>本会话总是允许</button>
          <button className="harness-secondary-button compact danger" disabled={disabled || busy} onClick={() => void onRespond(permission, "reject")}>拒绝</button>
          <button className="harness-secondary-button compact" disabled={!sessionId} onClick={() => onOpenTerminal(sessionId)}>查看原生终端</button>
        </div> : null}
      </article>;
    })}
    </div>
  </section>;
}

function QuestionRequests({ questions, sessionNames, drafts, busyId, disabled, onDraftChange, onSubmit, onOpenTerminal }: {
  questions: TaskQuestion[];
  sessionNames: ReadonlyMap<string, string>;
  drafts: Record<string, string>;
  busyId?: string;
  disabled: boolean;
  onDraftChange: (question: TaskQuestion, answer: string) => void;
  onSubmit: (question: TaskQuestion, answer: string) => Promise<void>;
  onOpenTerminal: (sessionId: string) => void;
}) {
  if (!questions.length) return null;
  return <section className="agent-loop-question-requests" aria-label="OpenCode 原生问题">
    <header><strong>需要回答</strong><small>{questions.length === 1 ? "由原生 Session 提出" : `${questions.length} 个问题，按顺序处理`}</small></header>
    <div className="agent-loop-question-deck" aria-label={`${questions.length} 个待处理 OpenCode 原生问题`}>
      {questions.map((question, index) => {
        const active = index === 0;
        const draftKey = taskQuestionDraftKey(question);
        const busy = busyId === draftKey;
        const sessionName = sessionNames.get(question.sessionId) || shortSession(question.sessionId) || "原生 Session";
        const answer = drafts[draftKey] ?? "";
        return <article aria-hidden={!active} className={`agent-loop-question-request ${active ? "active" : "queued"}`} key={draftKey} style={{ "--question-stack-index": index } as import("react").CSSProperties}>
          <div><strong>OpenCode 等待回答</strong><span>由 {sessionName} 提出</span></div>
          <p>{question.question}</p>
          {active ? <><label>回答 OpenCode 问题<textarea aria-label="回答 OpenCode 问题" value={answer} disabled={disabled || busy} onChange={(event) => onDraftChange(question, event.target.value)} placeholder="输入后只会写回这个原生问题，不会作为普通消息发送给 Conductor。" /></label><small>此回答只写入当前原生问题；普通 Task 消息仍保留给 Conductor。</small><div className="agent-loop-question-actions"><button className="harness-primary-button compact" disabled={disabled || busy || !answer.trim()} onClick={() => void onSubmit(question, answer)}>{busy ? "提交中…" : "提交回答"}</button><button className="harness-secondary-button compact" onClick={() => onOpenTerminal(question.sessionId)}>查看原生终端</button></div></> : null}
        </article>;
      })}
    </div>
  </section>;
}

function TemplateSurface({ templates, selectedTemplate, runtimeAvailable, busy, onSelect, onCreate, onEdit, onCopy, onArchive, onDelete }: {
  templates: NativeAgentLoopTemplate[]; selectedTemplate?: NativeAgentLoopTemplate; runtimeAvailable: boolean; busy: boolean; onSelect: (template: NativeAgentLoopTemplate) => void;
  onCreate: () => void; onEdit: (template: NativeAgentLoopTemplate) => void; onCopy: () => void; onArchive: () => void; onDelete: () => void;
}) {
  return <div className="harness-template-layout">
    <aside className="harness-template-list"><div className="harness-panel-title"><h1>Loop Templates</h1><button className="harness-primary-button compact" disabled={!runtimeAvailable} onClick={() => onCreate()}><Plus size={15} /> 新建</button></div><p className="harness-list-caption">卡片定义稳定能力边界；Conductor 只在其中派发本次工作契约。</p>{templates.map((template) => <button className={`harness-template-row ${template.id === selectedTemplate?.id ? "active" : ""}`} onClick={() => onSelect(template)} key={template.id}><Bot size={16} /><span><strong>{template.name}</strong><small>{`Agent Loop · v${template.version} · ${template.agents.length} cards`}</small></span></button>)}</aside>
    <section className="harness-template-canvas">{selectedTemplate ? <>
      <header className="harness-template-head"><div><div className="harness-breadcrumb">Template / Agent Loop</div><h1>{selectedTemplate.name}</h1></div><div className="agent-loop-template-actions"><button className="harness-secondary-button compact" disabled={!runtimeAvailable || busy} onClick={() => onEdit(selectedTemplate)}><Pencil size={14} /> 编辑 / 新版本</button><button className="harness-secondary-button compact" disabled={!runtimeAvailable || busy} onClick={onCopy}><Copy size={14} /> 复制</button><button className="harness-secondary-button compact" disabled={!runtimeAvailable || busy} onClick={onArchive}><Archive size={14} /> 归档</button><button className="harness-secondary-button compact danger" disabled={!runtimeAvailable || busy} onClick={onDelete}><Trash2 size={15} /> 删除</button></div></header>
      <div className="agent-loop-contract-note"><strong>Conductor Charter</strong><span>{selectedTemplate.conductor.charter || "决定每次下一步派发；把 Session Agent 当作可选能力，而不是固定路线。"}</span></div>
      <div className="agent-loop-contract-note"><strong>边界</strong><span>Conductor：{selectedTemplate.conductor.role}。每张卡片定义可用能力；Conductor 每次自行决定是否派发，并写入目标、输入、验收和预期产物。Runtime 不执行业务路线。</span></div>
      <div className="agent-loop-card-grid">{selectedTemplate.agents.map((card) => <AgentCard key={card.id} card={card} />)}</div>
    </> : <Empty title="还没有 Template" detail="创建一个 Agent Loop Template，再配置它的原生 Session Agent 卡片。" />}</section>
    <aside className="harness-inspector">{selectedTemplate ? <><h2>Conductor Charter</h2><InspectorRow label="模型" value={selectedTemplate.conductor.model} /><InspectorRow label="Session cards" value={`${selectedTemplate.agents.length} 张`} /><section className="harness-inspector-section"><strong>决策原则</strong><p>{selectedTemplate.conductor.charter || "Conductor 根据任务、Session 返回与用户补充决定每一步；Runtime 不提供固定路线。"}</p></section></> : null}</aside>
  </div>;
}

function WorkbenchSurface({
  run,
  tasks,
  selectedTaskId,
  selectedSessionId,
  runtimeAvailable,
  theme,
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
  theme: Theme;
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

  useEffect(() => {
    if (!selectedSessionId) return;
    setLayout((current) => {
      if (!current) return current;
      const groupId = leafGroupIds(current.root).find((id) => current.groups[id]?.sessionIds.includes(selectedSessionId));
      if (!groupId || current.groups[groupId]?.activeSessionId === selectedSessionId) return current;
      return selectGroupSession({ ...current, focusedGroupId: groupId }, groupId, selectedSessionId);
    });
  }, [runId, selectedSessionId]);

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
      // Viewport collapse is a renderer-only safety adaptation while initial
      // placement remains automatic. Persisting it would convert an auto
      // workspace into a narrower-screen manual layout and prevent the Host
      // from allocating newly materialized Sessions consistently.
      if (next !== current && current.placementMode !== "auto") void onLayoutChange(next).catch(() => undefined);
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
  const activeDispatchCount = (run?.turns ?? []).filter((turn) => ["queued", "input_accepted", "delivered", "cancellation_requested", "cancel_failed"].includes(String(turn.dispatchStatus))).length;
  const liveTerminalCount = (run?.turns ?? []).filter((turn) => turn.terminalStatus === "live").length;
  const activity = workbenchActivity(run, { activeDispatchCount, liveTerminalCount });
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
            <small>{count ? `${count} Session` : taskStatusLabel(task.status)}</small>
          </button>;
        })}
      </div>
    </header>
    {run && <div className="agent-loop-run-context"><div><strong>{run.task.title}</strong><span className={activity.tone}>{activity.label}</span><small>Task：{taskStatusLabel(run.task.status)} · {activeDispatchCount} active dispatches · {liveTerminalCount} PTYs live · {activity.attentionCount ? `${activity.attentionCount} needs attention` : "no attention"}</small></div><div className="agent-loop-workbench-actions"><button className={drawer === "timeline" ? "active" : ""} onClick={() => setDrawer((value) => value === "timeline" ? undefined : "timeline")}><Clock3 size={14} /> 时间线</button><button className={drawer === "artifacts" ? "active" : ""} onClick={() => setDrawer((value) => value === "artifacts" ? undefined : "artifacts")}><Files size={14} /> 产物</button><button className={drawer === "terminal-log" ? "active" : ""} disabled={!activeTurn} onClick={() => void openTerminalLog()} title={activeTurn ? `查看 ${activeTurn.details.card.name} 的原始 PTY 诊断历史` : "先选择一个 Session"}><TerminalSquare size={14} /> 终端历史</button></div></div>}
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
      <TerminalOverlayLayer layout={layout} turns={run.turns} terminalRects={terminalRects} runtimeAvailable={runtimeAvailable} theme={theme} onFontSizeChange={(groupId, fontSize) => updateLayout((current) => setGroupTerminalFontSize(current, groupId, fontSize))} />
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

function TerminalOverlayLayer({ layout, turns, terminalRects, runtimeAvailable, theme, onFontSizeChange }: { layout: NativeAgentLoopWorkbenchLayout; turns: NativeAgentLoopRunDetail["turns"]; terminalRects: Record<string, DOMRect>; runtimeAvailable: boolean; theme: Theme; onFontSizeChange: (groupId: string, fontSize: number) => void }) {
  const groupForSession = new Map<string, string>();
  for (const groupId of leafGroupIds(layout.root)) for (const sessionId of layout.groups[groupId]?.sessionIds ?? []) groupForSession.set(sessionId, groupId);
  return <div className="agent-loop-terminal-overlay-layer">{turns.map((turn) => {
    const groupId = groupForSession.get(turn.sessionId);
    const rect = groupId ? terminalRects[groupId] : undefined;
    const active = Boolean(groupId && layout.groups[groupId]?.activeSessionId === turn.sessionId && rect && rect.width > 0 && rect.height > 0);
    if (!groupId || !rect) return null;
    return <div className={`agent-loop-terminal-overlay-pane ${active ? "active" : "inactive"}`} data-session-terminal={turn.sessionId} key={turn.sessionId} style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height }}>
      <PtyTerminal ariaLabel={`${turn.details.card.name} OpenCode terminal`} className="agent-loop-native-terminal" command={`opencode --model ${turn.details.card.model}`} session={turn.terminal} transcriptLines={turn.terminal?.transcript ?? []} {...nativeTerminalEmptyState(turn)} isVisible={active} readOnly={!runtimeAvailable} theme={theme} fontSize={layout.groups[groupId]?.fontSize ?? 11} onFontSizeChange={(fontSize) => onFontSizeChange(groupId, fontSize)} onData={(payload) => { if (turn.terminal?.incarnationId) void enqueueNativeTerminalInput({ workspaceSessionId: turn.sessionId, expectedIncarnationId: turn.terminal.incarnationId, source: "user", payload, idempotencyKey: `user:${Date.now()}` }); }} onResize={(cols, rows) => { if (turn.terminal?.incarnationId) void resizeNativePtySession(turn.sessionId, { cols, rows }, turn.terminal.incarnationId); }} />
    </div>;
  })}</div>;
}

function WorkbenchDrawer({ kind, timeline, artifacts, terminalLog, terminalLogError, terminalLogSessionName, onArtifact, onClose }: { kind: "timeline" | "artifacts" | "terminal-log"; timeline: TimelineItem[]; artifacts: NativeAgentLoopRunDetail["artifacts"]; terminalLog?: NativeTerminalDiagnosticLog; terminalLogError?: string; terminalLogSessionName?: string; onArtifact: (path: string) => void; onClose: () => void }) {
  const eyebrow = kind === "timeline" ? "TASK TIMELINE" : kind === "artifacts" ? "DELIVERY ARTIFACTS" : "TERMINAL DIAGNOSTICS";
  const title = kind === "timeline" ? "任务时间线" : kind === "artifacts" ? "产物" : `${terminalLogSessionName ?? "Session"} · 终端历史`;
  return <aside className="agent-loop-workbench-drawer" aria-label={title}>
    <header><div><span>{eyebrow}</span><h2>{title}</h2></div><button aria-label="关闭抽屉" onClick={onClose}>×</button></header>
    <div className="agent-loop-workbench-drawer-content">{kind === "timeline" ? timeline.map((item) => <TimelineMessage item={item} key={item.id} />) : kind === "artifacts" ? artifacts.length ? artifacts.map((artifact) => <button className="agent-loop-artifact-row" disabled={!artifact.previewable} key={artifact.path} onClick={() => onArtifact(artifact.path)}><FilePlus2 size={16} /><span><strong>{artifact.path}</strong><small>{`${artifact.size ?? 0} bytes · 打开预览`}</small></span><ChevronRight size={15} /></button>) : <Empty title="尚无可打开产物" detail="Task 可以用消息、结论或多个文件交付；只有 Runtime 已确认存在的项目文件会显示在这里。" /> : <TerminalDiagnosticLog log={terminalLog} error={terminalLogError} />}</div>
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

function TaskInspector({ task, run, completed, collapsed, busy, runtimeAvailable, permissions, questions, questionAnswerDrafts, sessionNames, permissionBusyId, questionBusyId, onPermissionResponse, onQuestionAnswerDraftChange, onQuestionAnswer, onPermissionTerminal, onToggle, onStart, onWorkbench, onArtifact }: { task?: NativeAgentLoopTask; run?: NativeAgentLoopRunDetail; completed: boolean; collapsed: boolean; busy: boolean; runtimeAvailable: boolean; permissions: unknown[]; questions: TaskQuestion[]; questionAnswerDrafts: Record<string, string>; sessionNames: ReadonlyMap<string, string>; permissionBusyId?: string; questionBusyId?: string; onPermissionResponse: (permission: Record<string, unknown>, response: "once" | "always" | "reject") => Promise<void>; onQuestionAnswerDraftChange: (question: TaskQuestion, answer: string) => void; onQuestionAnswer: (question: TaskQuestion, answer: string) => Promise<void>; onPermissionTerminal: (sessionId: string) => void; onToggle: () => void; onStart: () => void; onWorkbench: () => void; onArtifact: (path: string) => void }) {
  if (collapsed) return <aside className="harness-inspector collapsed"><button className="harness-inspector-toggle" aria-label="展开任务设置" title="展开任务设置" onClick={onToggle}><ChevronLeft size={17} /></button></aside>;
  if (!task) return <aside className="harness-inspector"><button className="harness-inspector-toggle" aria-label="收起任务设置" title="收起任务设置" onClick={onToggle}><ChevronRight size={17} /></button></aside>;
  const artifacts = run?.artifacts.filter((artifact) => artifact.exists && artifact.previewable) ?? [];
  return <aside className="harness-inspector"><header className="harness-inspector-title"><h2>{completed ? "已完成任务" : "Task Architecture"}</h2><button className="harness-inspector-toggle" aria-label="收起任务设置" title="收起任务设置" onClick={onToggle}><ChevronRight size={17} /></button></header><InspectorRow label="模式" value="Agent Loop" /><InspectorRow label="Template" value={`${task.architecture.template.name} v${task.architecture.template.version}`} /><InspectorRow label="项目根目录" value={task.cwd} /><InspectorRow label="Session cards" value={String(task.architecture.agentCards.length)} /><InspectorRow label="状态" value={taskStatusLabel(task.status)} /><QuestionRequests questions={questions} sessionNames={sessionNames} drafts={questionAnswerDrafts} busyId={questionBusyId} disabled={!runtimeAvailable} onDraftChange={onQuestionAnswerDraftChange} onSubmit={onQuestionAnswer} onOpenTerminal={onPermissionTerminal} /><PermissionRequests permissions={permissions} sessionNames={sessionNames} busyId={permissionBusyId} disabled={!runtimeAvailable} onRespond={onPermissionResponse} onOpenTerminal={onPermissionTerminal} /><TaskAgentStatusList task={task} run={run} />{completed ? <section className="harness-inspector-section"><strong>历史与清理</strong><p>重新执行会创建新的 Run 与新的原生 Session。要清理历史，请在左侧已完成任务列表勾选后统一删除；不会删除项目文件。</p></section> : <section className="harness-inspector-section"><strong>控制边界</strong><p>Session Agent 由 Conductor 派发。Runtime 管理 PTY 与 Provider 事实；它不规定交付形式或下一步。</p></section>}{artifacts.map((artifact) => <button className="harness-open-timeline" key={artifact.path} onClick={() => onArtifact(artifact.path)}><span>打开产物</span><code>{artifact.path}</code></button>)}{completed ? <button className="harness-open-timeline" disabled={busy || !runtimeAvailable || task.status === "archived"} onClick={onStart}><span>重新执行（新 Run）</span><Play size={15} /></button> : run && <button className="harness-open-timeline" onClick={onWorkbench}>查看真实终端 <ChevronRight size={16} /></button>}</aside>;
}

function TaskAgentStatusList({ task, run }: { task: NativeAgentLoopTask; run?: NativeAgentLoopRunDetail }) {
  const sessionTurns = new Map((run?.turns ?? []).filter((turn) => turn.purpose === "session_agent").map((turn) => [turn.details.card.id, turn]));
  return <section className="harness-inspector-section agent-loop-agent-status"><strong>Session 派发状态</strong><p>状态来自当前 Run 的 Runtime 快照；未派发的卡片也会保留可见。</p><div>{task.architecture.agentCards.map((card) => {
    const turn = sessionTurns.get(card.id);
    const status = turn?.dispatchStatus ?? "not_dispatched";
    return <span key={card.id}><i className={`harness-state-dot ${status}`} />{card.name}<small>{sessionDispatchLabel(status)}</small></span>;
  })}</div></section>;
}

function TaskDeleteDialog({ tasks, busy, onCancel, onConfirm }: { tasks: NativeAgentLoopTask[]; busy: boolean; onCancel: () => void; onConfirm: () => void }) {
  const count = tasks.length;
  return <div className="agent-loop-delete-backdrop" role="dialog" aria-modal="true" aria-label="删除已完成 Task 确认">
    <button className="agent-loop-delete-scrim" aria-label="取消删除已完成 Task" onClick={onCancel} />
    <section className="agent-loop-delete-dialog"><header><div><span>DELETE ACHIEVED TASKS</span><h2>删除已选的 {count} 个任务吗？</h2></div><button aria-label="关闭删除确认" onClick={onCancel}>×</button></header><div className="agent-loop-delete-copy"><p>将删除所选已完成 Task 的 Runtime 元数据、所有 Run 事件、终端日志与工作台布局。</p><p><strong>不会删除项目交付文件。</strong>例如 Task 产出的 Markdown、HTML 或其他项目文件会原样保留。</p></div><footer><button className="harness-secondary-button" disabled={busy} onClick={onCancel}>取消</button><button className="harness-primary-button danger" disabled={busy} onClick={onConfirm}>{busy ? "删除中…" : `删除 ${count} 个任务`}</button></footer></section>
  </div>;
}

function TaskStopDialog({ task, busy, onCancel, onConfirm }: { task: NativeAgentLoopTask; busy: boolean; onCancel: () => void; onConfirm: () => void }) {
  return <div className="agent-loop-delete-backdrop" role="dialog" aria-modal="true" aria-label="停止 Task 确认">
    <button className="agent-loop-delete-scrim" aria-label="取消停止 Task" onClick={onCancel} />
    <section className="agent-loop-delete-dialog agent-loop-stop-dialog"><header><div><span>STOP TASK</span><h2>停止“{task.title}”吗？</h2></div><button aria-label="关闭停止确认" onClick={onCancel}>×</button></header><div className="agent-loop-delete-copy"><p>会停止此 Task 当前所有原生 Session。Task、Run、事件、终端历史和产物记录都会保留。</p><p><strong>不会删除项目交付文件。</strong>之后可从此页“重新启动”，创建一个新的 Run。</p></div><footer><button className="harness-secondary-button" disabled={busy} onClick={onCancel}>取消</button><button className="harness-primary-button" disabled={busy} onClick={onConfirm}>{busy ? "停止中…" : "停止任务"}</button></footer></section>
  </div>;
}

function TemplateDialog({ draft, busy, enabled, onChange, onClose, onSave }: { draft: TemplateDraft; busy: boolean; enabled: boolean; onChange: (value: TemplateDraft) => void; onClose: () => void; onSave: () => void }) {
  const [activePane, setActivePane] = useState<"agents" | "loop">("agents");
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
      <header className="agent-loop-drawer-header"><div><h2>{draft.name || "新建 Template"}</h2><p>编辑后会保存为新的 Template 版本；已有 Task 不会改变。</p></div><button className="agent-loop-drawer-close" onClick={onClose} aria-label="关闭">×</button></header>
      <div className="agent-loop-drawer-scroll">
        <section className="agent-loop-drawer-basics" aria-label="Template 基本信息"><label>模板名称<input value={draft.name} onChange={(event) => onChange({ ...draft, name: event.target.value })} /></label></section>
        <div className="agent-loop-drawer-tabs" role="tablist" aria-label="Template 编辑内容"><button role="tab" aria-selected={activePane === "agents"} className={activePane === "agents" ? "active" : ""} onClick={() => setActivePane("agents")}>Session Agents <span>{draft.agents.length}</span></button><button role="tab" aria-selected={activePane === "loop"} className={activePane === "loop" ? "active" : ""} onClick={() => setActivePane("loop")}>Loop 设置</button></div>
        {activePane === "agents" && selectedAgent && <section className="agent-loop-drawer-agents">
          <div className="agent-loop-card-picker" aria-label="选择 Session Agent 卡片">{draft.agents.map((card, index) => <button key={`${card.id}-${index}`} className={card.id === selectedAgent.id ? "active" : ""} onClick={() => { setSelectedAgentId(card.id); setAdvancedOpen(false); }}><Bot size={15} /><span><strong>{card.name || "未命名 Agent"}</strong><small>{card.model}</small></span></button>)}<button className="agent-loop-add-card" onClick={addCard}><Plus size={14} /> 添加</button></div>
          <div className="agent-loop-card-editor"><div className="agent-loop-card-editor-title"><div><span>编辑 Session Agent</span><strong>{selectedAgent.name || "未命名 Agent"}</strong></div>{draft.agents.length > 1 && <button className="agent-loop-icon-danger" aria-label="移除当前 Session Agent" title="移除当前卡片" onClick={removeSelectedCard}><Trash2 size={15} /></button>}</div><div className="agent-loop-editor-two-columns"><label>名称<input value={selectedAgent.name} onChange={(event) => updateCard(selectedAgentIndex, { name: event.target.value })} /></label><label>责任类型<select value={selectedAgent.kind} onChange={(event) => updateCard(selectedAgentIndex, { kind: event.target.value as NativeSessionAgentCard["kind"] })}><option value="researcher">调研 / Researcher</option><option value="publisher">交付 / Publisher</option><option value="reviewer">复核 / Reviewer</option><option value="general">通用 / General</option></select></label><label>模型<input value={selectedAgent.model} onChange={(event) => updateCard(selectedAgentIndex, { model: event.target.value })} /></label></div><label>角色与稳定能力边界<textarea rows={3} value={selectedAgent.role} onChange={(event) => updateCard(selectedAgentIndex, { role: event.target.value })} /></label><div className="agent-loop-capability-grid"><label><span>MCP</span><input placeholder="留空 = 不设 Template 限制" value={selectedAgent.mcp.join(", ")} onChange={(event) => updateCard(selectedAgentIndex, { mcp: splitAllowlist(event.target.value) })} /><small>{selectedAgent.mcp.length ? "此卡片只声明这些 MCP" : "全部允许（沿用原生 OpenCode 能力）"}</small></label><label><span>Skills</span><input placeholder="留空 = 不设 Template 限制" value={selectedAgent.skills.join(", ")} onChange={(event) => updateCard(selectedAgentIndex, { skills: splitAllowlist(event.target.value) })} /><small>{selectedAgent.skills.length ? "此卡片只声明这些 Skills" : "全部允许（沿用原生 OpenCode 能力）"}</small></label></div><button className="agent-loop-advanced-toggle" aria-expanded={advancedOpen} onClick={() => setAdvancedOpen((value) => !value)}>{advancedOpen ? "收起高级设置" : "高级设置：默认输出、说明、卡片 ID"}<ChevronRight size={15} /></button>{advancedOpen && <div className="agent-loop-card-advanced"><label>默认输出约定<textarea rows={3} value={selectedAgent.expectedOutput} onChange={(event) => updateCard(selectedAgentIndex, { expectedOutput: event.target.value })} /></label><label>补充说明<textarea rows={3} value={selectedAgent.instructions} onChange={(event) => updateCard(selectedAgentIndex, { instructions: event.target.value })} /></label><label>卡片 ID<input value={selectedAgent.id} onChange={(event) => { updateCard(selectedAgentIndex, { id: event.target.value }); setSelectedAgentId(event.target.value); }} /></label></div>}</div>
        </section>}
        {activePane === "loop" && <section className="agent-loop-loop-settings"><div className="agent-loop-settings-copy"><strong>Conductor Charter</strong><p>这是 Template 唯一的编排说明：适用任务、协作方式和决策偏好都写在这里。它会固化给新 Task 的 Conductor，但不构成 Runtime 路由。</p></div><label>Conductor 如何根据任务、Session 返回与用户补充决定下一步<textarea rows={10} value={draft.conductor.charter ?? ""} onChange={(event) => onChange({ ...draft, conductor: { ...draft.conductor, charter: event.target.value } })} placeholder="例如：优先并行收集相互独立的证据；发现关键冲突时先重新派发核实；需要落地文件时，由 Conductor 按当前证据选择合适的 Session Agent。" /><small>写清模板适用任务、可用卡片如何协作以及决策偏好。不要写成固定的 Research → Review → Publish 流程；每次下一步仍由 Conductor 决定。</small></label></section>}
      </div>
      <footer className="agent-loop-drawer-footer"><button className="harness-secondary-button" onClick={onClose}>取消</button><button className="harness-primary-button" disabled={!enabled || busy || !draft.name.trim() || !draft.agents.length} onClick={onSave}>{busy ? "保存中…" : "保存新版本"}</button></footer>
    </section>
  </div>;
}

function TemplateStarterDialog({ brief, busy, enabled, onBrief, onClose, onManual, onGenerate }: { brief: string; busy: boolean; enabled: boolean; onBrief: (value: string) => void; onClose: () => void; onManual: () => void; onGenerate: () => void }) {
  return <div className="agent-loop-drawer-backdrop" role="dialog" aria-modal="true" aria-label="新建 Template">
    <button className="agent-loop-drawer-scrim" aria-label="取消新建 Template" onClick={onClose} />
    <section className="agent-loop-drawer agent-loop-starter-drawer">
      <header className="agent-loop-drawer-header"><div><h2>新建 Agent Loop Template</h2><p>先描述想要的协作方式。OpenCode 只生成可编辑草案，不创建 Task，也不会启动任何 Session。</p></div><button className="agent-loop-drawer-close" onClick={onClose} aria-label="关闭">×</button></header>
      <div className="agent-loop-drawer-scroll">
        <section className="agent-loop-template-generator-copy"><strong>一句话生成模板</strong><p>例如：&ldquo;调研一个主题，保留多个可独立调研的 Session 卡片；Conductor 根据证据缺口决定是否再派发、核实或让某个 Agent 落地 Markdown。&rdquo;</p></section>
        <label className="agent-loop-template-prompt">你希望 Conductor 怎样使用 Session Agent？<textarea autoFocus rows={7} value={brief} onChange={(event) => onBrief(event.target.value)} placeholder="写清适用任务、可用角色、交付偏好，以及 Conductor 的决策原则。" /><small>OpenCode 会把这段内容编排成 Conductor Charter 与 Session Agent 卡片；你可以再修改 Agent、模型、MCP、Skills 和 Charter。</small></label>
        <section className="agent-loop-manual-entry"><strong>不想生成？</strong><p>直接从空白模板配置 Conductor 和原生 Session Agent 卡片。</p><button className="harness-secondary-button compact" disabled={busy} onClick={onManual}><Pencil size={14} /> 手工创建</button></section>
      </div>
      <footer className="agent-loop-drawer-footer"><button className="harness-secondary-button" disabled={busy} onClick={onClose}>取消</button><button className="harness-primary-button" disabled={!enabled || busy || !brief.trim()} onClick={onGenerate}>{busy ? "OpenCode 生成中…" : "生成可编辑草案"}</button></footer>
    </section>
  </div>;
}

function TaskDialog({ templates, title, goal, templateId, projectPath, projectVerified, busy, enabled, onTitle, onGoal, onTemplate, onProjectPath, onValidateProject, onClose, onCreateTemplate, onCreate }: { templates: NativeAgentLoopTemplate[]; title: string; goal: string; templateId: string; projectPath: string; projectVerified: boolean; busy: boolean; enabled: boolean; onTitle: (value: string) => void; onGoal: (value: string) => void; onTemplate: (value: string) => void; onProjectPath: (value: string) => void; onValidateProject: (path?: string) => void; onClose: () => void; onCreateTemplate: () => void; onCreate: () => void }) {
  const [projectPathFocused, setProjectPathFocused] = useState(false);
  const [projectSuggestions, setProjectSuggestions] = useState<string[]>([]);
  const [activeProjectSuggestionIndex, setActiveProjectSuggestionIndex] = useState(-1);
  const suggestionGenerationRef = useRef(0);
  useEffect(() => {
    const generation = ++suggestionGenerationRef.current;
    if (!enabled || !projectPathFocused || !projectPath.trim()) {
      setProjectSuggestions([]);
      setActiveProjectSuggestionIndex(-1);
      return undefined;
    }
    const timer = window.setTimeout(() => {
      void suggestNativeAgentLoopProjectDirectories(projectPath)
        .then((suggestions) => {
          if (generation === suggestionGenerationRef.current) {
            setProjectSuggestions(suggestions);
            setActiveProjectSuggestionIndex(-1);
          }
        })
        .catch(() => {
          if (generation === suggestionGenerationRef.current) {
            setProjectSuggestions([]);
            setActiveProjectSuggestionIndex(-1);
          }
        });
    }, 120);
    return () => window.clearTimeout(timer);
  }, [enabled, projectPath, projectPathFocused]);

  const selectProjectSuggestion = (suggestion: string) => {
    setProjectPathFocused(false);
    setProjectSuggestions([]);
    setActiveProjectSuggestionIndex(-1);
    onProjectPath(suggestion);
    onValidateProject(suggestion);
  };

  const moveProjectSuggestion = (direction: 1 | -1) => {
    if (!projectSuggestions.length) return;
    setActiveProjectSuggestionIndex((current) => {
      if (current < 0) return direction === 1 ? 0 : projectSuggestions.length - 1;
      return (current + direction + projectSuggestions.length) % projectSuggestions.length;
    });
  };

  return <div className="agent-loop-drawer-backdrop" role="dialog" aria-modal="true" aria-label="创建 Task">
    <button className="agent-loop-drawer-scrim" aria-label="取消创建任务" onClick={onClose} />
    <section className="agent-loop-drawer agent-loop-task-drawer">
      <header className="agent-loop-drawer-header"><div><h2>创建 Task</h2><p>选择已保存的 Agent Loop Template。创建后会固化快照；之后修改模板不会影响这个 Task。</p></div><button className="agent-loop-drawer-close" onClick={onClose} aria-label="关闭">×</button></header>
      <div className="agent-loop-drawer-scroll">
        <section className="agent-loop-drawer-basics"><label>任务标题<input autoFocus value={title} onChange={(event) => onTitle(event.target.value)} placeholder="例如：整理产品竞品调研" /></label><label>任务目标<textarea rows={5} value={goal} onChange={(event) => onGoal(event.target.value)} placeholder="写清交付物、范围和验收标准。Conductor 会据此形成每次派发的工作契约。" /></label><label>项目文件夹<div className="agent-loop-project-picker"><div className="agent-loop-project-path"><input value={projectPath} role="combobox" aria-expanded={projectPathFocused && projectSuggestions.length > 0} aria-controls="agent-loop-project-suggestions" aria-activedescendant={activeProjectSuggestionIndex >= 0 ? `agent-loop-project-suggestion-${activeProjectSuggestionIndex}` : undefined} onFocus={() => setProjectPathFocused(true)} onBlur={() => setProjectPathFocused(false)} onChange={(event) => onProjectPath(event.target.value)} onKeyDown={(event) => { if (event.key === "ArrowDown") { event.preventDefault(); moveProjectSuggestion(1); } else if (event.key === "ArrowUp") { event.preventDefault(); moveProjectSuggestion(-1); } else if (event.key === "Enter") { const suggestion = projectSuggestions[activeProjectSuggestionIndex]; event.preventDefault(); if (suggestion) selectProjectSuggestion(suggestion); else onValidateProject(); } else if (event.key === "Escape") { setProjectPathFocused(false); setActiveProjectSuggestionIndex(-1); } }} placeholder="例如：/Users/name/project" spellCheck={false} autoComplete="off" /><button className="harness-secondary-button compact" type="button" disabled={busy || !enabled || !projectPath.trim()} onClick={() => onValidateProject()}>确定</button></div>{projectPathFocused && projectSuggestions.length > 0 ? <div className="agent-loop-project-suggestions" id="agent-loop-project-suggestions" role="listbox" aria-label="项目文件夹匹配"><span>匹配的本地文件夹</span>{projectSuggestions.map((suggestion, index) => <button key={suggestion} id={`agent-loop-project-suggestion-${index}`} className={index === activeProjectSuggestionIndex ? "active" : ""} type="button" role="option" aria-selected={index === activeProjectSuggestionIndex} onMouseDown={(event) => event.preventDefault()} onClick={() => selectProjectSuggestion(suggestion)}>{suggestion}</button>)}</div> : null}</div><small>{projectVerified ? "目录已由本地 Host 验证。原生 Session、相对产物路径及 `.agent-workspace/runtime` 都以此为准。" : "输入路径时会匹配本地文件夹；点击匹配项后自动验证；也可用 ↑/↓ 和 Enter 选择。"}</small></label></section>
        <section className="agent-loop-task-template-choice"><div><strong>选择协作模板</strong><p>模板保存 Conductor Charter 与 Session Agent 的稳定能力，不包含本次任务的固定路线。</p></div><label>Agent Loop Template<select value={templateId} onChange={(event) => onTemplate(event.target.value)}>{templates.map((template) => <option value={template.id} key={template.id}>{template.name} · v{template.version}</option>)}</select></label><div className="agent-loop-task-template-alternative"><span>没有合适的模板？</span><button className="harness-secondary-button compact" disabled={busy || !goal.trim()} onClick={onCreateTemplate}><Plus size={14} /> 根据任务目标生成新 Template</button><small>会先进入 Template 草案编辑器；保存后再回到这里创建 Task。</small></div></section>
        <section className="agent-loop-task-snapshot-note"><strong>创建后会发生什么</strong><p>Task 会保存当前 Template 的版本快照。启动后，只有 Conductor 可以异步派发原生 OpenCode Session Agent；每个 Session 的结果、失败或需要输入才会唤醒 Conductor。</p></section>
      </div>
      <footer className="agent-loop-drawer-footer"><button className="harness-secondary-button" disabled={busy} onClick={onClose}>取消</button><button className="harness-primary-button" disabled={!enabled || busy || !title.trim() || !goal.trim() || !templateId || !projectVerified} onClick={onCreate}>{busy ? "创建中…" : "创建 Task"}</button></footer>
    </section>
  </div>;
}

function ArtifactDialog({ artifact, onClose }: { artifact: NativeAgentLoopArtifact; onClose: () => void }) {
  return <div className="harness-modal-backdrop" role="dialog" aria-modal="true" aria-label="产物预览"><section className="harness-modal agent-loop-artifact-modal"><header><div><span>DELIVERY ARTIFACT</span><h2>{artifact.path}</h2></div><button onClick={onClose} aria-label="关闭">×</button></header><div className="harness-modal-content agent-loop-artifact-content">{artifact.contentType === "markdown" ? <div className="harness-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]}>{artifact.content ?? ""}</ReactMarkdown></div> : artifact.contentType === "html" ? <iframe title={artifact.path} sandbox="" srcDoc={artifact.content ?? ""} /> : <pre>{artifact.content ?? ""}</pre>}</div><footer><span>{artifact.size ? `${artifact.size} bytes` : ""}</span><button className="harness-primary-button" onClick={onClose}>关闭</button></footer></section></div>;
}

function AgentCard({ card }: { card: NativeSessionAgentCard }) { return <article className="agent-loop-agent-card"><header><Bot size={17} /><div><strong>{card.name}</strong><span>{card.id} · {agentKindLabel(card.kind)}</span></div></header><p>{card.role}</p><dl><dt>模型</dt><dd>{card.model}</dd><dt>MCP</dt><dd>{allowlistLabel(card.mcp)}</dd><dt>Skills</dt><dd>{allowlistLabel(card.skills)}</dd><dt>默认交付</dt><dd>{card.expectedOutput || "由 Conductor 的本次契约指定"}</dd></dl></article>; }
function InspectorRow({ label, value }: { label: string; value: string }) { return <div className="harness-inspector-row"><span>{label}</span><strong title={value}>{value}</strong></div>; }
function Empty({ title, detail }: { title: string; detail: string }) { return <div className="harness-empty"><strong>{title}</strong><p>{detail}</p></div>; }

function taskQuestionDraftKey(question: Pick<TaskQuestion, "sessionId" | "questionId">) { return `${question.sessionId}:${question.questionId}`; }
export function pendingTaskQuestions(run?: NativeAgentLoopRunDetail): TaskQuestion[] {
  const answered = new Set((run?.runtimeState.questionResponses ?? [])
    .filter(isRecord)
    .filter((record) => ["submitted", "resolved"].includes(String(record.status ?? "")))
    .map((record) => `${String(record.sessionId ?? "")}:${String(record.questionId ?? "")}`));
  const liveTerminalIncarnationBySession = new Map((run?.turns ?? [])
    .filter((turn) => turn.terminalStatus === "live" && Boolean(turn.terminal?.incarnationId))
    .map((turn) => [turn.sessionId, String(turn.terminal?.incarnationId)]));
  return (run?.runtimeState.sessions ?? [])
    .filter((session) => session.state === "waiting_input")
    .map((session) => {
      const data = session.lastStateData ?? {};
      const questionId = stringField(data, "providerQuestionPartId");
      const observedTerminalIncarnationId = stringField(data, "terminalIncarnationId");
      const currentTerminalIncarnationId = liveTerminalIncarnationBySession.get(session.sessionId);
      const question = stringField(data, "question") || session.lastStateSummary || "OpenCode 正在等待你的回答。";
      return {
        sessionId: session.sessionId,
        questionId,
        question,
        createdAt: session.updatedAt,
        pairedWithCurrentTerminal: Boolean(questionId && observedTerminalIncarnationId && observedTerminalIncarnationId === currentTerminalIncarnationId),
      };
    })
    // The card is a remote control for one live native modal, not a rendering
    // of historical waiting_input. After restart the old fact remains durable,
    // but it cannot accept text until Provider observation re-pairs it to the
    // current PTY incarnation.
    .filter((question) => question.pairedWithCurrentTerminal)
    .map(({ pairedWithCurrentTerminal: _pairedWithCurrentTerminal, ...question }) => question)
    .filter((question) => !answered.has(taskQuestionDraftKey(question)))
    .sort((left, right) => String(left.createdAt ?? "").localeCompare(String(right.createdAt ?? "")));
}

type TimelineItem = { id: string; kind: "user" | "conductor" | "runtime" | "session"; title: string; detail: string; meta: string; sortTime: number; showFull?: boolean };
export function buildTimeline(task?: NativeAgentLoopTask, run?: NativeAgentLoopRunDetail): TimelineItem[] {
  if (!task) return [];
  const items: TimelineItem[] = [{ id: "task", kind: "user", title: "任务输入", detail: task.goal, meta: "用户 → Conductor", sortTime: timelineTime(task.createdAt, 0) }];
  for (const event of run?.events ?? []) {
    if (event.type === "task.user_message") {
      items.push({ id: `event-${event.sequence}`, kind: "user", title: "你发给 Conductor 的消息", detail: stringField(event.data, "message") || event.summary, meta: event.createdAt, sortTime: timelineTime(event.createdAt) });
      continue;
    }
    if (event.type === "task.user_message_retrying") {
      items.push({
        id: `event-${event.sequence}`,
        kind: "runtime",
        title: "正在重新发送此前消息",
        detail: "此前消息尚未获得 OpenCode 回执；Runtime 正在复用原输入继续当前 Conductor 对话。",
        meta: event.createdAt,
        sortTime: timelineTime(event.createdAt),
      });
      continue;
    }
    if (event.type === "session.question_answer_submitted") {
      items.push({ id: `event-${event.sequence}`, kind: "user", title: `你回答 ${shortSession(stringField(event.data, "sessionId"))}`, detail: stringField(event.data, "answer") || event.summary, meta: event.createdAt, sortTime: timelineTime(event.createdAt) });
      continue;
    }
    items.push({ id: `event-${event.sequence}`, kind: event.type.startsWith("conductor") ? "conductor" : "runtime", title: event.type, detail: event.summary, meta: event.createdAt, sortTime: timelineTime(event.createdAt) });
  }
  for (const event of run?.runtimeState.events ?? []) {
    if (event.type === "question.response_submitted") continue;
    if (["permission.response_submitted", "permission.resolved", "permission.response_recovery_queued", "permission.reissued", "permission.response_retry_required"].includes(event.type)) {
      const response = stringField(event.data ?? {}, "response");
      const responseLabel = response === "reject" ? "拒绝" : response === "always" ? "始终允许" : "仅此次允许";
      const resolved = event.type === "permission.resolved";
      const replaying = event.type === "permission.reissued";
      const queued = event.type === "permission.response_recovery_queued";
      const retryRequired = event.type === "permission.response_retry_required";
      items.push({
        id: `task-event-${event.id}`,
        kind: "runtime",
        title: `${shortSession(event.sessionId)} ${resolved ? "已确认授权答复" : replaying ? "正在重新交付授权答复" : queued ? "已保留授权答复" : retryRequired ? "需要重新选择授权答复" : "已提交授权答复"}`,
        detail: resolved
          ? `OpenCode 已确认：${responseLabel}。`
          : replaying
            ? "OpenCode 已重发相同范围的授权请求；Runtime 正在通过新会话通道交付你已选择的答复。"
            : queued
              ? "原会话通道不可用；已保留你的选择，正在恢复原生 Session。"
              : retryRequired
                ? "OpenCode 尚未接收上次答复，请在右侧授权卡片重新选择。"
          : `已将你的选择（${responseLabel}）发送给 OpenCode；等待 Provider 确认。`,
        meta: event.createdAt,
        sortTime: timelineTime(event.createdAt),
      });
      continue;
    }
    if (event.sessionId !== run?.run.conductorSessionId) continue;
    const message = stringField(event.data ?? {}, "message");
    if (event.type === "conductor.message") {
      items.push({ id: `task-event-${event.id}`, kind: "conductor", title: "Conductor 返回", detail: message || event.summary, meta: event.createdAt, sortTime: timelineTime(event.createdAt), showFull: true });
      continue;
    }
    if (event.type === "task.completion_claim") {
      items.push({ id: `task-event-${event.id}`, kind: "conductor", title: "Conductor 提交交付", detail: message || event.summary, meta: event.createdAt, sortTime: timelineTime(event.createdAt), showFull: true });
      continue;
    }
    if (event.type === "conductor.wakeup.observed" && stringField(event.data ?? {}, "kind") === "user_message") {
      items.push({
        id: `task-event-${event.id}`,
        kind: "runtime",
        title: "OpenCode 已确认输入",
        detail: "已记录这条原始输入；正在等待 Conductor 的下一次完整回复。",
        meta: event.createdAt,
        sortTime: timelineTime(event.createdAt),
      });
    }
  }
  for (const dispatch of run?.runtimeState.dispatches ?? []) items.push({ id: `dispatch-${String(dispatch.dispatchId)}`, kind: "conductor", title: `Conductor 派发 → ${shortSession(String(dispatch.toSessionId ?? ""))}`, detail: dispatchTimelineDetail(dispatch), meta: String(dispatch.createdAt ?? ""), sortTime: timelineTime(dispatch.createdAt) });
  for (const result of run?.runtimeState.results ?? []) {
    const output = run?.turns.find((turn) => turn.sessionId === result.sessionId)?.output?.answerText ?? result.answerPreview ?? "Provider 已返回结果；在运行现场查看原生 Session。";
    items.push({ id: `result-${String(result.resultId ?? result.dispatchId)}`, kind: "session", title: `${shortSession(String(result.sessionId ?? "Session Agent"))} 返回`, detail: output, meta: String(result.createdAt ?? ""), sortTime: timelineTime(result.createdAt) });
  }
  for (const message of run?.runtimeState.messages ?? []) items.push({ id: `conductor-${String(message.providerMessageId ?? message.dispatchId ?? message.createdAt)}`, kind: "conductor", title: "Conductor 回应", detail: message.answerText, meta: String(message.createdAt ?? ""), sortTime: timelineTime(message.createdAt) });
  for (const attention of run?.runtimeState.pendingDecisions ?? []) {
    if (attention.type === "worker_result_available") continue;
    const permissionRequest = attention.type === "permission_requested";
    // A Provider permission is a structured Task-page decision card, not a
    // duplicate Timeline message. Its submission and Provider confirmation are
    // represented above as compact durable facts.
    if (permissionRequest || attention.type === "session_waiting_input") continue;
    items.push({
      id: `attention-${attention.type}-${attention.sessionId}-${("cursor" in attention ? attention.cursor : "") ?? ""}`,
      kind: "runtime",
      title: `${shortSession(attention.sessionId)} 需要处理`,
      detail: attention.summary ?? "Runtime 观察到原生 Session 需要输入或恢复处理。请进入运行现场，在该 Session 的真实终端中查看与回复。",
      meta: attention.actionHint ?? attention.type,
      sortTime: Number.MAX_SAFE_INTEGER,
    });
  }
  return items.sort((left, right) => left.sortTime - right.sortTime || left.id.localeCompare(right.id));
}
function timelineTime(value: unknown, fallback = Number.MAX_SAFE_INTEGER - 1) { const parsed = Date.parse(String(value ?? "")); return Number.isFinite(parsed) ? parsed : fallback; }
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
function TimelineMessage({ item }: { item: TimelineItem }) {
  const collapsible = !item.showFull && item.kind !== "user" && timelinePlainText(item.detail).length > 260;
  const [expanded, setExpanded] = useState(false);
  const compact = collapsible && !expanded;
  return <article className={`harness-conversation-message ${item.kind} ${compact ? "compact" : "expanded"}`}>
    <div className="harness-conversation-avatar">{item.kind === "user" ? "U" : item.kind === "conductor" ? "C" : item.kind === "session" ? "S" : "R"}</div>
    <div className="harness-conversation-content">
      <header><strong>{item.title}</strong><small>{item.meta}</small>{collapsible && <button className="harness-timeline-expand" type="button" onClick={() => setExpanded((current) => !current)}>{expanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}{expanded ? "收起" : "展开"}</button>}</header>
      {compact
        ? <p className="harness-timeline-preview">{timelinePreview(item.detail)}</p>
        : <div className="harness-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]}>{item.detail}</ReactMarkdown></div>}
    </div>
  </article>;
}
function timelinePlainText(value: string) { return value.replace(/`([^`]+)`/g, "$1").replace(/[*_#>|]/g, " ").replace(/\s+/g, " ").trim(); }
function timelinePreview(value: string) { const plain = timelinePlainText(value); return plain.length > 320 ? `${plain.slice(0, 317).trimEnd()}…` : plain; }
function templateDraftFrom(template: NativeAgentLoopTemplate): TemplateDraft { const { version: _version, archivedAt: _archivedAt, createdAt: _createdAt, updatedAt: _updatedAt, ...draft } = template; return structuredClone(draft); }
function splitAllowlist(value: string) { return [...new Set(value.split(",").map((item) => item.trim()).filter(Boolean))]; }
function allowlistLabel(value: string[]) { return value.length ? value.join(", ") : "全部允许"; }
function agentKindLabel(kind: NativeSessionAgentCard["kind"]) { return ({ researcher: "调研", publisher: "交付", reviewer: "复核", general: "通用" } as Record<NativeSessionAgentCard["kind"], string>)[kind]; }
function sessionDispatchLabel(status: string) { return ({ queued: "已排队", input_accepted: "输入已接收", delivered: "Provider 已接收", result_available: "结果可用", provider_failed: "Provider 失败", failed: "派发失败", not_dispatched: "未派发", running: "运行中", succeeded: "结果可用" } as Record<string, string>)[status] ?? status; }
function terminalLifecycleLabel(status?: string) { return ({ live: "终端在线", running: "终端在线", stopping: "终端停止中", stopped: "终端已停止", not_live: "终端不在线", not_started: "尚未启动" } as Record<string, string>)[status ?? "not_started"] ?? status ?? "尚未启动"; }
function shortSession(value: string) { const parts = value.split(":"); return parts[parts.length - 1] ?? value; }
function projectNameFromPath(value: string) { const normalized = value.replace(/[\\/]+$/, ""); return normalized.split(/[\\/]/).pop() || "local"; }
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function stringField(value: Record<string, unknown>, key: string) { return typeof value[key] === "string" ? value[key] : ""; }
function messageFor(reason: unknown) { return reason instanceof Error ? reason.message : String(reason); }

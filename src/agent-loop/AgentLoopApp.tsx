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
  Copy,
  FilePlus2,
  FolderPlus,
  Layers2,
  Pencil,
  PanelLeftClose,
  PanelLeftOpen,
  Play,
  Plus,
  RefreshCw,
  Square,
  Sun,
  Moon,
  Trash2,
  Undo2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  archiveNativeAgentLoopTemplate,
  validateNativeAgentLoopProjectDirectory,
  copyNativeAgentLoopTemplate,
  createNativeAgentLoopProjectDirectory,
  createNativeAgentLoopTask,
  defaultOpencodeRunModel,
  deleteNativeAgentLoopTemplate,
  getOrCreateNativeAgentLoopTemplateDesignSession,
  isNativeAgentLoopRuntimeAvailable,
  listActiveNativeAgentLoopTemplateDesignSessions,
  listNativeOpencodeModelCapabilities,
  listNativeAgentLoopTasks,
  listNativeAgentLoopTemplates,
  listNativeAgentLoopTemplateVersions,
  markNativeAgentLoopTaskAchieved,
  moveNativeAgentLoopTaskToTrash,
  permanentlyDeleteNativeAgentLoopTask,
  previewNativeAgentLoopTaskPermanentDeletion,
  resumeNativeAchievedAgentLoopTask,
  readNativeAgentLoopTemplateDesignSession,
  readNativeAgentLoopArtifact,
  readNativeAgentLoopRun,
  saveNativeAgentLoopTemplateDesignDraft,
  saveNativeAgentLoopWorkbenchLayout,
  saveNativeAgentLoopTemplate,
  suggestNativeAgentLoopProjectDirectories,
  startNativeAgentLoopRun,
  stopNativeAgentLoopTask,
  restoreNativeAgentLoopTask,
  subscribeNativeAgentLoopTemplateDesignEvents,
  subscribeNativeAgentLoopRuntimeEvents,
  isNativePromptSplitSessionAgentCard,
  type NativeAgentLoopRunDetail,
  type NativeAgentLoopTask,
  type NativeAgentLoopTemplate,
  type NativeAgentLoopArtifact,
  type NativeOpencodeModelCapability,
  type NativeSessionAgentCard,
  type NativePromptSplitSessionAgentCard,
  type NativeTemplateDesignDraft,
  type NativeTemplateDesignDraftValidation,
  type NativeTemplateDesignSessionSummary,
} from "../runtime/nativeBridge";
import { taskStatusLabel, workbenchActivity } from "./runPresentation";
import { OpenCodeSessionPage } from "./opencodeWebUiPreview";
import { TemplateDesignWebUiPreview } from "./templateDesignWebUiPreview";
import {
  defaultTaskSessionPaneLayout,
  isTaskRunPresentationInteractive,
  normalizeTaskSessionPaneLayout,
  taskSessionWorkspaceItems,
  type TaskSessionPaneLayout,
} from "./taskSessionWorkspace";

type View = "tasks" | "templates";
type Theme = "dark" | "light";
type TaskListMode = "active" | "completed" | "trash";
type TemplateDraft = Omit<NativeAgentLoopTemplate, "version" | "archivedAt" | "createdAt" | "updatedAt">;
type TemplateDesignDraftValidationIssue = NativeTemplateDesignDraftValidation["issues"][number];
type TemplateDesignDraftValidation = NativeTemplateDesignDraftValidation;

type ManagedArtifactCandidate = {
  path: string;
  exists: boolean;
  size?: number;
  deletable: boolean;
  source: string;
};

type PermanentDeletePreview = {
  taskId: string;
  projectCwd: string;
  managedArtifacts: ManagedArtifactCandidate[];
};

/**
 * Renderer-only intent captured while the user is creating a Task.  It is
 * deliberately not part of a Template Draft or Template Version: the user
 * may use it to brief the Meta Agent, but only an explicit Task command may
 * persist it as a Task Architecture snapshot.
 */
type TaskTemplateDesignIntent = {
  title: string;
  goal: string;
  cwd: string;
};

// The official OpenCode composer is a complete application, not a compact
// control we can safely restyle. Keep enough host width for its native model
// selector and send action to coexist.
const templateMetaDockMinimumWidth = 560;
const templateMetaDockMaximumWidth = 640;

function tasksForListMode(tasks: NativeAgentLoopTask[], mode: TaskListMode) {
  if (mode === "completed") return tasks.filter((task) => task.status === "achieved");
  if (mode === "trash") return tasks.filter((task) => ["archived", "deleting"].includes(task.status));
  return tasks.filter((task) => !["achieved", "archived", "deleting"].includes(task.status));
}

/**
 * Models and reasoning variants are Provider facts.  The renderer never
 * carries a shadow catalog: a historical snapshot stays visible but disabled,
 * while choices always come from the active OpenCode Host registry.
 */
function ModelSelect({
  value,
  modelVariant,
  models,
  onChange,
  onModelVariantChange,
}: {
  value: string;
  modelVariant?: string;
  models: NativeOpencodeModelCapability[];
  onChange: (value: string) => void;
  onModelVariantChange: (value: string | undefined) => void;
}) {
  const availableModels = models.filter((model) => model.availability === "available");
  const selectedModel = models.find((model) => model.id === value);
  const historicalSelection = Boolean(value && (!selectedModel || selectedModel.availability !== "available"));
  const variants = selectedModel?.availability === "available" ? selectedModel.variants : [];
  const hasHistoricalVariant = Boolean(modelVariant && !variants.some((variant) => variant.id === modelVariant));
  const catalogUnavailable = availableModels.length === 0;

  return <span className="agent-loop-model-control">
    <select
      aria-label="OpenCode 模型"
      disabled={catalogUnavailable}
      value={value}
      onChange={(event) => onChange(event.target.value)}
    >
      {historicalSelection && <option value={value} disabled>{value}（历史快照）</option>}
      {availableModels.map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}
    </select>
    {variants.length > 0 && <span className="agent-loop-model-variant">
      <span>推理强度</span>
      <select aria-label="推理强度" value={modelVariant ?? ""} onChange={(event) => onModelVariantChange(event.target.value || undefined)}>
        <option value="">Provider 默认</option>
        {hasHistoricalVariant && <option value={modelVariant} disabled>{modelVariant}（历史快照）</option>}
        {variants.map((variant) => <option key={variant.id} value={variant.id}>{variant.reasoningEffort ?? variant.id}</option>)}
      </select>
    </span>}
    {catalogUnavailable && <small>官方模型目录暂不可用；当前值仅保留展示，不能在此替换。</small>}
  </span>;
}

const defaultCard = (id = "researcher"): NativeSessionAgentCard => ({
  id,
  name: id === "researcher" ? "Researcher" : "New Session Agent",
  kind: id === "researcher" ? "researcher" : "general",
  model: defaultOpencodeRunModel,
  mcp: [],
  skills: [],
  dispatchProfile: {
    title: id === "researcher" ? "证据调研" : "待定义的派发能力",
    description: id === "researcher"
      ? "围绕 Conductor 指定的问题收集可复核证据，并说明来源与不确定性。"
      : "说明 Conductor 在什么任务缺口下应选择这张卡片。",
  },
  workerSystemPrompt: id === "researcher"
    ? "You are an independent research Session Agent. Complete the bounded assignment from Conductor, distinguish facts from inferences, and return evidence with sources and remaining uncertainty."
    : "You are a focused Session Agent. Complete the bounded assignment from Conductor, preserve evidence for your conclusions, and report remaining uncertainty.",
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

function newTaskCommandId(kind: string, taskId: string) {
  const nonce = globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `ui:${kind}:${taskId}:${nonce}`;
}

function newTemplateDesignDraftId() {
  const nonce = globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `template-design-${nonce}`;
}

function taskTemplateDesignPrompt(intent: TaskTemplateDesignIntent) {
  const title = intent.title.trim() || "未命名 Task";
  const goal = intent.goal.trim() || "未填写 Task 目标";
  const cwd = intent.cwd.trim() || "未确认项目文件夹";
  return [
    "请基于以下待创建 Task 设计一个可保存、可复用的 Agent Loop Template。",
    "",
    `任务标题：${title}`,
    `任务目标：${goal}`,
    `项目文件夹：${cwd}`,
    "",
    "请先给出合适的模板名称、Conductor Charter 和 Session Agent Cards。只修改当前 Template Draft；不要创建 Task、Run、Dispatch 或交付物。保存和创建 Task 都由用户显式完成。",
  ].join("\n");
}

export function AgentLoopApp({ projectPath, projectName }: { projectPath: string; projectName: string }) {
  const runtimeAvailable = isNativeAgentLoopRuntimeAvailable();
  const [view, setView] = useState<View>("tasks");
  const [theme, setTheme] = useState<Theme>("dark");
  const [templates, setTemplates] = useState<NativeAgentLoopTemplate[]>([]);
  const [tasks, setTasks] = useState<NativeAgentLoopTask[]>([]);
  const [taskListMode, setTaskListMode] = useState<TaskListMode>("active");
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>();
  const [selectedTemplateVersion, setSelectedTemplateVersion] = useState<number>();
  const [templateVersions, setTemplateVersions] = useState<NativeAgentLoopTemplate[]>([]);
  const [selectedTaskId, setSelectedTaskId] = useState<string>();
  const [run, setRun] = useState<NativeAgentLoopRunDetail>();
  const [selectedSessionId, setSelectedSessionId] = useState<string>();
  const [showTaskCreate, setShowTaskCreate] = useState(false);
  const [showTemplateEditor, setShowTemplateEditor] = useState(false);
  const [templateDraft, setTemplateDraft] = useState<TemplateDraft>(blankTemplate());
  const [returnToTaskAfterTemplate, setReturnToTaskAfterTemplate] = useState(false);
  const [templateDesignDraft, setTemplateDesignDraft] = useState<NativeTemplateDesignDraft>();
  const [activeTemplateDesignDrafts, setActiveTemplateDesignDrafts] = useState<NativeTemplateDesignSessionSummary[]>([]);
  const [templateMetaAgentOpen, setTemplateMetaAgentOpen] = useState(false);
  const [templateMetaAgentBusy, setTemplateMetaAgentBusy] = useState(false);
  const [opencodeModelCapabilities, setOpencodeModelCapabilities] = useState<NativeOpencodeModelCapability[]>([]);
  const [taskTitle, setTaskTitle] = useState("");
  const [taskGoal, setTaskGoal] = useState("");
  const [taskTemplateId, setTaskTemplateId] = useState("");
  const [taskTemplateVersion, setTaskTemplateVersion] = useState<number>();
  const [taskTemplateVersions, setTaskTemplateVersions] = useState<NativeAgentLoopTemplate[]>([]);
  // A Task owns a user-selected project root. Never silently reuse the
  // Agent Workspace checkout as that root.
  const [taskProjectPath, setTaskProjectPath] = useState("");
  const [taskProjectVerified, setTaskProjectVerified] = useState(false);
  const taskProjectPathRef = useRef("");
  const pendingNewTemplateDraftRef = useRef<{ draftId: string; cwd: string; model: string; modelVariant?: string } | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [railCollapsed, setRailCollapsed] = useState(false);
  const [error, setError] = useState<string>();
  const [artifactPreview, setArtifactPreview] = useState<NativeAgentLoopArtifact>();
  const [stopTarget, setStopTarget] = useState<NativeAgentLoopTask>();
  const [selectedTaskIds, setSelectedTaskIds] = useState<string[]>([]);
  const [permanentDeleteTaskId, setPermanentDeleteTaskId] = useState<string>();
  const [permanentDeletePreview, setPermanentDeletePreview] = useState<PermanentDeletePreview>();
  const [permanentDeletePreviewLoading, setPermanentDeletePreviewLoading] = useState(false);
  const historicalModelIds = useMemo(() => {
    const ids = new Set<string>();
    const add = (value: unknown) => {
      if (typeof value === "string" && value.trim()) ids.add(value.trim());
    };
    for (const template of templates) {
      add(template.conductor.model);
      for (const card of template.agents) add(card.model);
    }
    add(templateDesignDraft?.model);
    if (templateDesignDraft?.draftJson && isRecord(templateDesignDraft.draftJson)) {
      const draftConductor = templateDesignDraft.draftJson.conductor;
      if (isRecord(draftConductor)) add(draftConductor.model);
      const draftCards = templateDesignDraft.draftJson.agents;
      if (Array.isArray(draftCards)) {
        for (const card of draftCards) if (isRecord(card)) add(card.model);
      }
    }
    return [...ids].sort();
  }, [templateDesignDraft, templates]);
  const historicalModelKey = historicalModelIds.join("\u0000");
  const defaultProviderModel = useMemo(
    () => opencodeModelCapabilities.find((model) => model.availability === "available")?.id ?? defaultOpencodeRunModel,
    [opencodeModelCapabilities],
  );
  const [selectedManagedArtifactPaths, setSelectedManagedArtifactPaths] = useState<string[]>([]);
  // A permanently deleted Task is final for this renderer lifetime. Runtime
  // events and an in-flight list/read request can resolve after the delete IPC
  // succeeds; they must never re-open a removed Task in the Workbench.
  const deletedTaskIdsRef = useRef(new Set<string>());
  const selectedTaskIdRef = useRef<string | undefined>(undefined);
  const taskListModeRef = useRef<TaskListMode>(taskListMode);
  const taskRefreshGenerationRef = useRef(0);
  const templateVersionReadGenerationRef = useRef(0);
  const taskTemplateVersionReadGenerationRef = useRef(0);
  const runReadGenerationRef = useRef(0);
  // Retain one identity until a command succeeds. A second click or transport
  // retry therefore replays the same durable command instead of creating a
  // second lifecycle mutation.
  const taskCommandIdsRef = useRef(new Map<string, string>());

  const commandIdFor = (kind: string, taskId: string) => {
    const key = `${kind}:${taskId}`;
    const existing = taskCommandIdsRef.current.get(key);
    if (existing) return existing;
    const commandId = newTaskCommandId(kind, taskId);
    taskCommandIdsRef.current.set(key, commandId);
    return commandId;
  };

  const completeCommand = (kind: string, taskId: string) => {
    taskCommandIdsRef.current.delete(`${kind}:${taskId}`);
  };

  const selectedTemplate = templateVersions.find((template) =>
    template.id === selectedTemplateId && template.version === selectedTemplateVersion,
  ) ?? templates.find((template) => template.id === selectedTemplateId) ?? templates[0];
  const activeTasks = useMemo(() => tasksForListMode(tasks, "active"), [tasks]);
  const completedTasks = useMemo(() => tasksForListMode(tasks, "completed"), [tasks]);
  const trashTasks = useMemo(() => tasksForListMode(tasks, "trash"), [tasks]);
  const visibleTasks = useMemo(() => tasksForListMode(tasks, taskListMode), [tasks, taskListMode]);
  const selectedTask = visibleTasks.find((task) => task.taskId === selectedTaskId) ?? visibleTasks[0];

  const selectTaskListMode = (mode: TaskListMode) => {
    taskListModeRef.current = mode;
    setTaskListMode(mode);
  };

  const applyTaskList = useCallback((nextTasks: NativeAgentLoopTask[]) => {
    const deletedTaskIds = deletedTaskIdsRef.current;
    setTasks(nextTasks.filter((task) => !deletedTaskIds.has(task.taskId)));
  }, []);

  // Version history is an immutable read model.  A newer request wins so a
  // delayed response for the previously selected Template cannot replace the
  // history currently being inspected.
  const loadTemplateVersions = useCallback(async (templateId: string) => {
    const generation = ++templateVersionReadGenerationRef.current;
    const versions = await listNativeAgentLoopTemplateVersions(templateId);
    if (generation !== templateVersionReadGenerationRef.current) return;
    setTemplateVersions(versions);
    setSelectedTemplateVersion((current) =>
      versions.some((template) => template.version === current)
        ? current
        : versions[0]?.version,
    );
  }, []);

  // Task creation selects a concrete immutable Version. This is deliberately
  // independent from the Templates page selection so a background refresh or
  // a user browsing Template history cannot silently change a pending Task.
  const loadTaskTemplateVersions = useCallback(async (templateId: string) => {
    const generation = ++taskTemplateVersionReadGenerationRef.current;
    const versions = await listNativeAgentLoopTemplateVersions(templateId);
    if (generation !== taskTemplateVersionReadGenerationRef.current) return;
    setTaskTemplateVersions(versions);
    setTaskTemplateVersion((current) =>
      versions.some((template) => template.version === current)
        ? current
        : versions[0]?.version,
    );
  }, []);

  const selectTaskTemplate = useCallback((templateId: string) => {
    taskTemplateVersionReadGenerationRef.current += 1;
    setTaskTemplateId(templateId);
    setTaskTemplateVersion(undefined);
    setTaskTemplateVersions([]);
    if (!templateId) return;
    void loadTaskTemplateVersions(templateId).catch((reason: unknown) => setError(messageFor(reason)));
  }, [loadTaskTemplateVersions]);

  const acceptRun = useCallback((detail: NativeAgentLoopRunDetail) => {
    if (deletedTaskIdsRef.current.has(detail.task.taskId)) return;
    setRun(detail);
    setTasks((current) => current.map((task) => task.taskId === detail.task.taskId ? { ...task, ...detail.task, latestRun: detail.run } : task));
    const taskSessions = detail.turns.filter((turn) => turn.purpose === "conductor" || turn.purpose === "session_agent");
    const conductorSessionId = taskSessions.find((turn) => turn.purpose === "conductor")?.sessionId;
    setSelectedSessionId((current) => current && taskSessions.some((turn) => turn.sessionId === current) ? current : conductorSessionId ?? taskSessions[0]?.sessionId);
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
    const [nextTemplates, nextTasks] = await Promise.all([listNativeAgentLoopTemplates(), listNativeAgentLoopTasks({ scope: "all" })]);
    if (refreshGeneration !== taskRefreshGenerationRef.current) return;
    setTemplates(nextTemplates);
    const allNextTasks = nextTasks.filter((task) => !deletedTaskIdsRef.current.has(task.taskId));
    const visibleNextTasks = tasksForListMode(allNextTasks, taskListModeRef.current);
    applyTaskList(nextTasks);
    const preferred = visibleNextTasks.find((task) => task.taskId === preferredTaskId || task.taskId === selectedTaskIdRef.current) ?? visibleNextTasks[0];
    const template = nextTemplates.find((item) => item.id === selectedTemplateId) ?? nextTemplates[0];
    setSelectedTemplateId(template?.id);
    setSelectedTemplateVersion((current) =>
      template?.id === selectedTemplateId && current !== undefined ? current : template?.version,
    );
    // A Template row is only a current page selection. Task creation must
    // retain an explicit saved-version choice rather than inheriting it.
    setTaskTemplateId((current) => nextTemplates.some((item) => item.id === current) ? current : "");
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

  // This is a read-only Host query with a short Host-side cache.  It is
  // intentionally not tied to composer keystrokes or Task/Run polling.
  useEffect(() => {
    if (!runtimeAvailable) {
      setOpencodeModelCapabilities([]);
      return undefined;
    }
    let current = true;
    void listNativeOpencodeModelCapabilities({ historicalModelIds })
      .then((result) => {
        if (current) setOpencodeModelCapabilities(result.models);
      })
      .catch(() => {
        if (current) setOpencodeModelCapabilities([]);
      });
    return () => {
      current = false;
    };
  }, [historicalModelKey, runtimeAvailable]);

  useEffect(() => {
    if (!selectedTemplateId) {
      templateVersionReadGenerationRef.current += 1;
      setTemplateVersions([]);
      return;
    }
    void loadTemplateVersions(selectedTemplateId).catch((reason: unknown) => setError(messageFor(reason)));
  }, [loadTemplateVersions, selectedTemplateId]);

  const refreshRun = useCallback((runId: string) => {
    return loadRun(runId)
      .catch((reason: unknown) => setError(messageFor(reason)));
  }, [loadRun]);

  useEffect(() => subscribeNativeAgentLoopRuntimeEvents((event) => {
    if (event.runId === run?.run.runId) {
      void refreshRun(event.runId);
      return;
    }
    // Keep inactive Task tabs up to date without using raw terminal traffic as
    // a Task-state source. The selected Run is refreshed by its own signal.
    void listNativeAgentLoopTasks({ scope: "all" }).then(applyTaskList).catch((reason: unknown) => setError(messageFor(reason)));
  }), [applyTaskList, refreshRun, run?.run.runId]);

  const templateDesignCwd = returnToTaskAfterTemplate && taskProjectVerified ? taskProjectPath : projectPath;
  const refreshActiveTemplateDesignDrafts = useCallback(async (cwd = templateDesignCwd) => {
    if (!cwd.trim()) {
      setActiveTemplateDesignDrafts([]);
      return;
    }
    const drafts = await listActiveNativeAgentLoopTemplateDesignSessions(cwd);
    setActiveTemplateDesignDrafts(drafts);
  }, [templateDesignCwd]);

  useEffect(() => {
    if (view !== "templates") return;
    void refreshActiveTemplateDesignDrafts().catch((reason: unknown) => setError(messageFor(reason)));
  }, [refreshActiveTemplateDesignDrafts, view]);

  const detachDiscardedTemplateDesignDraft = useCallback(() => {
    setTemplateDesignDraft(undefined);
    setTemplateMetaAgentOpen(false);
    void refreshActiveTemplateDesignDrafts().catch((reason: unknown) => setError(messageFor(reason)));
  }, [refreshActiveTemplateDesignDrafts]);

  const presentTemplateDesignDraft = (draft: NativeTemplateDesignDraft, returnToTask: boolean) => {
    setTemplateDesignDraft(draft);
    setTemplateMetaAgentOpen(true);
    setReturnToTaskAfterTemplate(returnToTask);
    setView("templates");
    if (returnToTask) setShowTaskCreate(false);
  };

  const openNewTemplate = async (returnToTask = false) => {
    if (templateMetaAgentBusy) return;
    const cwd = returnToTask ? taskProjectVerified ? taskProjectPath : "" : projectPath;
    if (!cwd.trim()) {
      setError("请先验证本次 Task 的项目文件夹，再新建 Template Draft。");
      return;
    }
    const model = defaultProviderModel;
    const pending = pendingNewTemplateDraftRef.current;
    const launch = pending && pending.cwd === cwd && pending.model === model
      ? pending
      : { draftId: newTemplateDesignDraftId(), cwd, model };
    pendingNewTemplateDraftRef.current = launch;
    setBusy(true);
    setTemplateMetaAgentBusy(true);
    setError(undefined);
    try {
      const session = await getOrCreateNativeAgentLoopTemplateDesignSession({
        target: { kind: "new_template", draftId: launch.draftId },
        cwd: launch.cwd,
        model: launch.model,
        modelVariant: launch.modelVariant,
      });
      if (!session?.draft) throw new Error("桌面 Runtime 未返回 Template Design Draft。");
      // The Provider Session stays deliberately empty. The renderer carries a
      // visible, editable Task-intent handoff into the Meta Agent dock, but
      // only the user may paste/send it through the official OpenCode composer.
      presentTemplateDesignDraft(session.draft, returnToTask);
      pendingNewTemplateDraftRef.current = undefined;
      void refreshActiveTemplateDesignDrafts(launch.cwd).catch((reason: unknown) => setError(messageFor(reason)));
    } catch (reason) {
      // Keep the same draft id for a retry after an ambiguous transport
      // failure. The runtime serializes that id before provider creation. If
      // the Draft was durably created before its Provider Session timed out,
      // keep it visible and wait for an explicit user retry rather than
      // creating a replacement Draft or silently retrying a Provider write.
      const draft = await readNativeAgentLoopTemplateDesignSession(launch.draftId).catch(() => undefined);
      if (draft?.status === "active") presentTemplateDesignDraft(draft, returnToTask);
      void refreshActiveTemplateDesignDrafts(launch.cwd).catch((refreshReason: unknown) => setError(messageFor(refreshReason)));
      setError(messageFor(reason));
    } finally {
      setTemplateMetaAgentBusy(false);
      setBusy(false);
    }
  };
  const openManualTemplate = (returnToTask?: boolean) => {
    setTemplateDraft(blankTemplate());
    if (returnToTask !== undefined) setReturnToTaskAfterTemplate(returnToTask);
    setError(undefined);
    setShowTemplateEditor(true);
  };
  const browseTemplateMetaAgentForTask = () => {
    const selectedVersion = taskTemplateVersions.find((template) =>
      template.id === taskTemplateId && template.version === taskTemplateVersion,
    );
    if (selectedVersion && taskProjectVerified) {
      // The user explicitly chose this Version and asked to revise it. Pass the
      // Task cwd directly instead of reading the Templates-page selection after
      // React state has changed.
      void openTemplateMetaAgent(selectedVersion, { cwd: taskProjectPath, returnToTask: true });
      return;
    }
    // Keep the Task form in renderer-local draft state. Visiting the Templates
    // page is not an implicit Template, Draft, or Task mutation.
    setShowTaskCreate(false);
    setReturnToTaskAfterTemplate(true);
    setView("templates");
    setError(undefined);
  };
  const returnToTaskCreation = () => {
    setTemplateMetaAgentOpen(false);
    setView("tasks");
    setShowTaskCreate(true);
    setReturnToTaskAfterTemplate(false);
  };
  const openTemplateEdit = (template: NativeAgentLoopTemplate) => {
    setTemplateDraft(templateDraftFrom(template));
    setError(undefined);
    setShowTemplateEditor(true);
  };
  const selectTemplate = (template: NativeAgentLoopTemplate) => {
    setSelectedTemplateId(template.id);
    setSelectedTemplateVersion(template.version);
    setError(undefined);
  };
  const selectTemplateVersion = (version: number) => {
    if (!Number.isSafeInteger(version) || version < 1) return;
    setSelectedTemplateVersion(version);
    setError(undefined);
  };
  const closeTemplateEditor = () => {
    const resumeTask = returnToTaskAfterTemplate;
    setShowTemplateEditor(false);
    setReturnToTaskAfterTemplate(false);
    if (resumeTask) setShowTaskCreate(true);
  };

  const openTemplateMetaAgent = async (
    template: NativeAgentLoopTemplate,
    options: { cwd?: string; returnToTask?: boolean } = {},
  ) => {
    if (templateMetaAgentBusy) return;
    const cwd = options.cwd ?? templateDesignCwd;
    if (!cwd.trim()) {
      setError("请先验证本次 Task 的项目文件夹，再打开 Template Meta Agent。");
      return;
    }
    if (options.returnToTask) {
      setSelectedTemplateId(template.id);
      setSelectedTemplateVersion(template.version);
      setReturnToTaskAfterTemplate(true);
      setShowTaskCreate(false);
      setView("templates");
    }
    setTemplateMetaAgentBusy(true);
    setError(undefined);
    try {
      const session = await getOrCreateNativeAgentLoopTemplateDesignSession({
        target: {
          kind: "existing_template_version",
          templateId: template.id,
          templateVersion: template.version,
        },
        cwd,
        model: template.conductor.model || defaultProviderModel,
        modelVariant: template.conductor.modelVariant,
      });
      if (!session?.draft) throw new Error("桌面 Runtime 未返回 Template Design Draft。");
      setTemplateDesignDraft(session.draft);
      setTemplateMetaAgentOpen(true);
      void refreshActiveTemplateDesignDrafts(cwd).catch((reason: unknown) => setError(messageFor(reason)));
    } catch (reason) {
      setError(messageFor(reason));
    } finally {
      setTemplateMetaAgentBusy(false);
    }
  };

  const reopenTemplateDesignDraft = async (draftId: string) => {
    if (templateMetaAgentBusy) return;
    setTemplateMetaAgentBusy(true);
    setError(undefined);
    try {
      const draft = await readNativeAgentLoopTemplateDesignSession(draftId);
      if (!draft || draft.status !== "active") throw new Error("此 Template Draft 不再可继续修订。");
      if (draft.cwd !== templateDesignCwd) throw new Error("此 Template Draft 不属于当前项目文件夹。");
      setTemplateDesignDraft(draft);
      setTemplateMetaAgentOpen(true);
    } catch (reason) {
      setError(messageFor(reason));
    } finally {
      setTemplateMetaAgentBusy(false);
    }
  };

  const retryTemplateDesignDraft = async (draftId: string) => {
    if (templateMetaAgentBusy) return;
    setTemplateMetaAgentBusy(true);
    setError(undefined);
    try {
      const draft = await readNativeAgentLoopTemplateDesignSession(draftId);
      if (!draft || draft.status !== "active") throw new Error("此 Template Draft 不再可继续修订。");
      if (draft.cwd !== templateDesignCwd) throw new Error("此 Template Draft 不属于当前项目文件夹。");
      const baseTemplateVersion = draft.baseTemplateVersion;
      const target = draft.templateId && typeof baseTemplateVersion === "number" && Number.isSafeInteger(baseTemplateVersion) && baseTemplateVersion > 0
        ? { kind: "existing_template_version" as const, templateId: draft.templateId, templateVersion: baseTemplateVersion }
        : { kind: "new_template" as const, draftId: draft.draftId };
      const session = await getOrCreateNativeAgentLoopTemplateDesignSession({ target, cwd: draft.cwd, model: draft.model, modelVariant: draft.modelVariant });
      if (!session?.draft?.providerSessionId) throw new Error("OpenCode 尚未绑定这个 Template Draft 的 Session。");
      setTemplateDesignDraft(session.draft);
      pendingNewTemplateDraftRef.current = undefined;
      void refreshActiveTemplateDesignDrafts(draft.cwd).catch((reason: unknown) => setError(messageFor(reason)));
    } catch (reason) {
      setError(messageFor(reason));
    } finally {
      setTemplateMetaAgentBusy(false);
    }
  };

  const saveTemplateDesignDraft = async () => {
    if (!templateDesignDraft || templateDesignDraft.status !== "active" || templateMetaAgentBusy) return;
    setTemplateMetaAgentBusy(true);
    setError(undefined);
    try {
      const saved = await saveNativeAgentLoopTemplateDesignDraft({
        draftId: templateDesignDraft.draftId,
        expectedRevision: templateDesignDraft.revision,
      });
      if (!saved?.draft || !saved.savedTemplate?.id) throw new Error("桌面 Runtime 未返回已保存的 Template Version。");
      setTemplateDesignDraft(saved.draft);
      // A new Draft has no base template id by design. Select the immutable
      // Version returned by the save command rather than guessing from its
      // name or mutating the historical Draft's target.
      setSelectedTemplateId(saved.savedTemplate.id);
      setSelectedTemplateVersion(saved.savedTemplate.version);
      if (returnToTaskAfterTemplate) {
        // Return to Task creation with the exact Version just saved, never the
        // latest row that happened to be returned by a later list refresh.
        setTaskTemplateId(saved.savedTemplate.id);
        setTaskTemplateVersion(saved.savedTemplate.version);
        setTaskTemplateVersions([saved.savedTemplate]);
      }
      await refresh();
      setSelectedTemplateId(saved.savedTemplate.id);
      setSelectedTemplateVersion(saved.savedTemplate.version);
      await loadTemplateVersions(saved.savedTemplate.id);
      if (returnToTaskAfterTemplate) await loadTaskTemplateVersions(saved.savedTemplate.id);
      await refreshActiveTemplateDesignDrafts(templateDesignCwd);
    } catch (reason) {
      setError(messageFor(reason));
    } finally {
      setTemplateMetaAgentBusy(false);
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
      setSelectedTemplateVersion(saved.version);
      setShowTemplateEditor(false);
      await refresh();
      setSelectedTemplateId(saved.id);
      setSelectedTemplateVersion(saved.version);
      await loadTemplateVersions(saved.id);
      if (reopenTask) {
        setTaskTemplateId(saved.id);
        setTaskTemplateVersion(saved.version);
        setTaskTemplateVersions([saved]);
        await loadTaskTemplateVersions(saved.id);
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
      setSelectedTemplateVersion(copied.version);
      await refresh();
      await loadTemplateVersions(copied.id);
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
    } catch (reason) {
      setError(messageFor(reason));
    } finally { setBusy(false); }
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
    const template = taskTemplateVersions.find((item) =>
      item.id === taskTemplateId && item.version === taskTemplateVersion,
    );
    if (!template) {
      setError("请先选择一个可用的已保存 Agent Loop Template 版本。");
      return;
    }
    if (!taskProjectVerified) {
      setError("请先确认本次 Task 的项目文件夹。");
      return;
    }
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

  const createTaskProjectDirectory = async (parentPath: string, name: string) => {
    setBusy(true);
    setError(undefined);
    try {
      const created = await createNativeAgentLoopProjectDirectory({ parentPath, name });
      if (!created?.path) throw new Error("本地 Host 未创建项目文件夹。");
      taskProjectPathRef.current = created.path;
      setTaskProjectPath(created.path);
      setTaskProjectVerified(true);
      return created;
    } catch (reason) {
      setError(messageFor(reason));
      return undefined;
    } finally { setBusy(false); }
  };

  const startRun = async () => {
    if (!selectedTask) return;
    const commandId = commandIdFor("start", selectedTask.taskId);
    setBusy(true);
    setError(undefined);
    try {
      const detail = await startNativeAgentLoopRun({
        taskId: selectedTask.taskId,
        commandId,
        expectedRevision: selectedTask.revision,
      });
      if (!detail) throw new Error("桌面 Runtime 未创建 Agent Loop Run。");
      completeCommand("start", selectedTask.taskId);
      selectedTaskIdRef.current = detail.task.taskId;
      acceptRun(detail);
      selectTaskListMode("active");
      setSelectedTaskId(detail.task.taskId);
      setView("tasks");
      await refresh(selectedTask.taskId);
    } catch (reason) {
      // Runtime durably compensates a failed native Start and records that
      // command as failed. A later explicit retry is a new start attempt and
      // therefore needs a new command identity.
      completeCommand("start", selectedTask.taskId);
      setError(messageFor(reason));
    } finally { setBusy(false); }
  };

  const markAchieved = async () => {
    if (!selectedTask) return;
    const commandId = commandIdFor("achieve", selectedTask.taskId);
    setBusy(true);
    try {
      const achieved = await markNativeAgentLoopTaskAchieved({
        taskId: selectedTask.taskId,
        commandId,
        expectedRevision: selectedTask.revision,
      });
      if (!achieved) throw new Error("桌面 Runtime 未确认 Task 的 achieved 状态。");
      completeCommand("achieve", selectedTask.taskId);
      selectTaskListMode("completed");
      selectedTaskIdRef.current = achieved.taskId;
      setSelectedTaskId(achieved.taskId);
      await refresh(selectedTask.taskId);
    } catch (reason) { setError(messageFor(reason)); } finally { setBusy(false); }
  };

  const resumeAchievedTask = async () => {
    if (!selectedTask) return;
    const taskId = selectedTask.taskId;
    const commandId = commandIdFor("resume-achieved", taskId);
    setBusy(true);
    setError(undefined);
    try {
      const detail = await resumeNativeAchievedAgentLoopTask({
        taskId,
        commandId,
        expectedRevision: selectedTask.revision,
      });
      if (!detail) throw new Error("原 Conductor Session 当前不可继续。Task 保持在已完成历史中。");
      completeCommand("resume-achieved", taskId);
      selectedTaskIdRef.current = detail.task.taskId;
      acceptRun(detail);
      selectTaskListMode("active");
      setSelectedTaskId(detail.task.taskId);
      await refresh(detail.task.taskId);
    } catch (reason) {
      // Keep this command identity for an ambiguous transport retry. Runtime
      // only commits it after the exact retained Provider Session is proven.
      setError(messageFor(reason));
    } finally { setBusy(false); }
  };

  const stopTask = async () => {
    if (!stopTarget) return;
    const stoppedTaskId = stopTarget.taskId;
    const commandId = commandIdFor("stop", stoppedTaskId);
    setBusy(true);
    setError(undefined);
    try {
      const stopped = await stopNativeAgentLoopTask({
        taskId: stoppedTaskId,
        commandId,
        expectedRevision: stopTarget.revision,
      });
      if (!stopped) throw new Error("桌面 Runtime 未确认 Task 已停止。");
      completeCommand("stop", stoppedTaskId);
      setTasks((current) => current.map((task) => task.taskId === stoppedTaskId ? { ...task, ...stopped } : task));
      setStopTarget(undefined);
      selectedTaskIdRef.current = stopped.taskId;
      setSelectedTaskId(stopped.taskId);
      await refresh(stopped.taskId);
    } catch (reason) { setError(messageFor(reason)); } finally { setBusy(false); }
  };

  const moveAchievedTasksToTrash = async () => {
    const targetIds = selectedTaskIds;
    if (!targetIds.length) return;
    setBusy(true);
    setError(undefined);
    try {
      for (const taskId of targetIds) {
        const target = tasks.find((task) => task.taskId === taskId);
        if (!target || target.status !== "achieved") throw new Error("只能将已确认交付的 Task 移入回收站。");
        const moved = await moveNativeAgentLoopTaskToTrash({
          taskId,
          commandId: commandIdFor("move-to-trash", taskId),
          expectedRevision: target.revision,
        });
        if (!moved) throw new Error("桌面 Runtime 未确认 Task 已移入回收站。");
        completeCommand("move-to-trash", taskId);
        setTasks((current) => current.map((task) => task.taskId === taskId ? { ...task, ...moved } : task));
        setSelectedTaskIds((current) => current.filter((id) => id !== taskId));
      }
      if (targetIds.includes(selectedTaskIdRef.current ?? "")) {
        selectedTaskIdRef.current = undefined;
        runReadGenerationRef.current += 1;
        setSelectedTaskId(undefined);
        setRun(undefined);
        setSelectedSessionId(undefined);
      }
      setArtifactPreview(undefined);
      selectTaskListMode("completed");
      await refresh();
    } catch (reason) { setError(messageFor(reason)); } finally { setBusy(false); }
  };

  const restoreArchivedTasks = async () => {
    const targetIds = selectedTaskIds;
    if (!targetIds.length) return;
    setBusy(true);
    setError(undefined);
    try {
      let firstRestoredTaskId: string | undefined;
      for (const taskId of targetIds) {
        const target = tasks.find((task) => task.taskId === taskId);
        if (!target || target.status !== "archived") throw new Error("只有回收站中的 Task 可以放回。");
        const restored = await restoreNativeAgentLoopTask({
          taskId,
          commandId: commandIdFor("restore-from-trash", taskId),
          expectedRevision: target.revision,
        });
        if (!restored) throw new Error("桌面 Runtime 未确认 Task 已放回。");
        completeCommand("restore-from-trash", taskId);
        firstRestoredTaskId ??= taskId;
        setTasks((current) => current.map((task) => task.taskId === taskId ? { ...task, ...restored } : task));
        setSelectedTaskIds((current) => current.filter((id) => id !== taskId));
      }
      setArtifactPreview(undefined);
      selectTaskListMode("completed");
      await refresh(firstRestoredTaskId);
    } catch (reason) { setError(messageFor(reason)); } finally { setBusy(false); }
  };

  const requestPermanentDelete = (taskId: string) => {
    const target = tasks.find((task) => task.taskId === taskId);
    if (!target || target.status !== "archived") {
      setError("只能从回收站对已归档的 Task 执行彻底删除。");
      return;
    }
    setSelectedManagedArtifactPaths([]);
    setPermanentDeletePreview(undefined);
    setPermanentDeleteTaskId(taskId);
  };

  const closePermanentDelete = () => {
    if (busy) return;
    setPermanentDeleteTaskId(undefined);
    setPermanentDeletePreview(undefined);
    setSelectedManagedArtifactPaths([]);
  };

  useEffect(() => {
    if (!permanentDeleteTaskId) {
      setPermanentDeletePreviewLoading(false);
      return undefined;
    }
    let cancelled = false;
    setPermanentDeletePreviewLoading(true);
    setPermanentDeletePreview(undefined);
    void previewNativeAgentLoopTaskPermanentDeletion({ taskId: permanentDeleteTaskId })
      .then((preview) => {
        if (cancelled) return;
        if (!preview) throw new Error("桌面 Runtime 未返回永久删除预览。");
        setPermanentDeletePreview({
          taskId: preview.taskId,
          projectCwd: preview.projectCwd,
          managedArtifacts: preview.managedArtifacts,
        });
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(messageFor(reason));
      })
      .finally(() => {
        if (!cancelled) setPermanentDeletePreviewLoading(false);
      });
    return () => { cancelled = true; };
  }, [permanentDeleteTaskId]);

  const toggleManagedArtifactSelection = (artifactPath: string) => {
    setSelectedManagedArtifactPaths((current) => current.includes(artifactPath)
      ? current.filter((path) => path !== artifactPath)
      : [...current, artifactPath]);
  };

  const permanentlyDeleteTask = async () => {
    const taskId = permanentDeleteTaskId;
    if (!taskId || !permanentDeletePreview) return;
    const target = tasks.find((task) => task.taskId === taskId);
    if (!target || target.status !== "archived") {
      setError("该 Task 已不处于可彻底删除的回收站状态，请刷新后重试。");
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const result = await permanentlyDeleteNativeAgentLoopTask({
        taskId,
        commandId: commandIdFor("permanent-delete", taskId),
        expectedRevision: target.revision,
        artifactPaths: selectedManagedArtifactPaths,
      });
      if (!result?.deleted) throw new Error("桌面 Runtime 未确认 Task 已彻底删除。");
      completeCommand("permanent-delete", taskId);
      deletedTaskIdsRef.current.add(taskId);
      setTasks((current) => current.filter((task) => task.taskId !== taskId));
      if (selectedTaskIdRef.current === taskId) {
        selectedTaskIdRef.current = undefined;
        runReadGenerationRef.current += 1;
        setSelectedTaskId(undefined);
        setRun(undefined);
        setSelectedSessionId(undefined);
      }
      setArtifactPreview(undefined);
      setSelectedTaskIds((current) => current.filter((id) => id !== taskId));
      setPermanentDeleteTaskId(undefined);
      setPermanentDeletePreview(undefined);
      setSelectedManagedArtifactPaths([]);
      selectTaskListMode("trash");
      await refresh();
    } catch (reason) {
      // Keep the same command identity and dialog after an ambiguous transport
      // failure. A retry replays the Runtime command instead of deleting twice.
      setError(messageFor(reason));
    } finally { setBusy(false); }
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
    const candidates = tasksForListMode(tasks, mode);
    selectTaskListMode(mode);
    setSelectedTaskIds([]);
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

  const openArtifact = async (artifactPath: string) => {
    if (!run) return;
    try {
      const artifact = await readNativeAgentLoopArtifact(run.run.runId, artifactPath);
      if (!artifact) throw new Error("桌面 Runtime 未返回产物内容。");
      setArtifactPreview(artifact);
    } catch (reason) { setError(messageFor(reason)); }
  };

  const openSessionPage = useCallback((sessionId: string) => {
    setSelectedSessionId(sessionId);
    setView("tasks");
  }, []);

  const saveTaskSessionPaneLayout = useCallback(async (runId: string, taskPage: TaskSessionPaneLayout) => {
    const current = run;
    if (!current || current.run.runId !== runId) return;
    const saved = await saveNativeAgentLoopWorkbenchLayout(runId, {
      ...current.workbenchLayout,
      taskPage,
    });
    if (saved) setRun((value) => value?.run.runId === runId ? { ...value, workbenchLayout: saved } : value);
  }, [run]);

  const timeline = useMemo(() => buildTimeline(selectedTask, run), [selectedTask, run]);

  return (
    <div className={`harness-app agent-loop-app ${railCollapsed ? "rail-collapsed" : ""} theme-${theme}`}>
      <aside className="harness-rail">
        <div className="harness-brand">
          <div className="harness-brand-copy"><Boxes size={21} /> <span>Agent Workspace</span></div>
          <button className="harness-icon-button harness-rail-toggle" aria-label={railCollapsed ? "展开导航栏" : "收起导航栏"} title={railCollapsed ? "展开导航栏" : "收起导航栏"} onClick={() => setRailCollapsed((current) => !current)}>{railCollapsed ? <PanelLeftOpen size={17} /> : <PanelLeftClose size={17} />}</button>
        </div>
        <nav aria-label="Agent Loop pages">
          <RailButton active={view === "tasks"} onClick={returnToTaskAfterTemplate ? returnToTaskCreation : () => setView("tasks")} icon={<ClipboardCheck size={18} />} label="任务" />
          <RailButton active={view === "templates"} onClick={() => setView("templates")} icon={<Layers2 size={18} />} label="模板" />
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
        {!runtimeAvailable && <div className="harness-browser-preview"><strong>同一套 Agent Loop 界面</strong><span>浏览器只用于查看布局；创建 Template、Task、Run 和 OpenCode Runtime 只在 Electron 内可用。</span></div>}
        {view === "tasks" && <TaskSurface
          tasks={visibleTasks} selectedTask={selectedTask} run={run} timeline={timeline} taskListMode={taskListMode} activeTaskCount={activeTasks.length} completedTaskCount={completedTasks.length} trashTaskCount={trashTasks.length} selectedTaskIds={selectedTaskIds} runtimeAvailable={runtimeAvailable} busy={busy}
          onSelect={selectTask} onListModeChange={switchTaskList}
          onCreate={() => { setTaskTitle(""); setTaskGoal(""); setTaskTemplateId(""); setTaskTemplateVersion(undefined); setTaskTemplateVersions([]); taskProjectPathRef.current = ""; setTaskProjectPath(""); setTaskProjectVerified(false); setShowTaskCreate(true); }}
          onStart={startRun} onAchieved={markAchieved} onResumeAchieved={resumeAchievedTask} onStop={(task) => setStopTarget(task)} onToggleTaskSelection={(taskId) => setSelectedTaskIds((current) => current.includes(taskId) ? current.filter((id) => id !== taskId) : [...current, taskId])} onMoveAchievedSelection={() => void moveAchievedTasksToTrash()} onRestoreArchivedSelection={() => void restoreArchivedTasks()} onRequestPermanentDelete={requestPermanentDelete} selectedSessionId={selectedSessionId} onSelectSession={openSessionPage} onSaveTaskPageLayout={(runId, layout) => void saveTaskSessionPaneLayout(runId, layout)} onArtifact={(path) => void openArtifact(path)} />}
        {view === "templates" && <TemplateSurface
          templates={templates} selectedTemplate={selectedTemplate} runtimeAvailable={runtimeAvailable} busy={busy}
          templateVersions={templateVersions} onSelect={selectTemplate} onSelectVersion={selectTemplateVersion} onCreate={() => void openNewTemplate(false)} onEdit={openTemplateEdit}
          onError={setError}
          taskCreationPending={returnToTaskAfterTemplate} taskCreationIntent={returnToTaskAfterTemplate ? { title: taskTitle, goal: taskGoal, cwd: taskProjectPath } : undefined} taskCreationTemplateVersion={returnToTaskAfterTemplate ? taskTemplateVersion : undefined} onReturnToTask={returnToTaskCreation}
          designDraft={templateDesignDraft} activeDesignDrafts={activeTemplateDesignDrafts} metaAgentOpen={templateMetaAgentOpen} metaAgentBusy={templateMetaAgentBusy}
          onOpenMetaAgent={(template) => void openTemplateMetaAgent(template)} onOpenDesignDraft={(draftId) => void reopenTemplateDesignDraft(draftId)} onRetryDesignDraft={(draftId) => void retryTemplateDesignDraft(draftId)} onCloseMetaAgent={() => setTemplateMetaAgentOpen(false)} onSaveDesignDraft={() => void saveTemplateDesignDraft()} onDesignDraftChange={setTemplateDesignDraft} onDesignDraftDiscarded={detachDiscardedTemplateDesignDraft}
          onCopy={() => void copyTemplate()} onArchive={() => void archiveTemplate()} onDelete={() => void deleteTemplate()} />}
      </main>
      {showTaskCreate && <TaskDialog
        templates={templates} templateVersions={taskTemplateVersions} title={taskTitle} goal={taskGoal} templateId={taskTemplateId} templateVersion={taskTemplateVersion} projectPath={taskProjectPath} projectVerified={taskProjectVerified} busy={busy} enabled={runtimeAvailable}
        onTitle={setTaskTitle} onGoal={setTaskGoal} onTemplate={selectTaskTemplate} onTemplateVersion={setTaskTemplateVersion} onProjectPath={changeTaskProjectPath} onValidateProject={(path) => void validateTaskProject(path)} onCreateProjectDirectory={createTaskProjectDirectory} onClose={() => setShowTaskCreate(false)} onCreateTemplate={() => void openNewTemplate(true)} onCreateManualTemplate={() => { setShowTaskCreate(false); openManualTemplate(true); }} onBrowseTemplateMetaAgent={browseTemplateMetaAgentForTask} onCreate={() => void createTask()} />}
      {showTemplateEditor && <TemplateDialog draft={templateDraft} modelCapabilities={opencodeModelCapabilities} busy={busy} enabled={runtimeAvailable} onChange={setTemplateDraft} onClose={closeTemplateEditor} onSave={() => void saveTemplate()} />}
      {artifactPreview && <ArtifactDialog artifact={artifactPreview} onClose={() => setArtifactPreview(undefined)} />}
      {stopTarget && <TaskStopDialog task={stopTarget} busy={busy} onCancel={() => setStopTarget(undefined)} onConfirm={() => void stopTask()} />}
      {permanentDeleteTaskId ? <TaskPermanentDeleteDialog task={tasks.find((task) => task.taskId === permanentDeleteTaskId)} preview={permanentDeletePreview} previewLoading={permanentDeletePreviewLoading} selectedArtifactPaths={selectedManagedArtifactPaths} busy={busy} onCancel={closePermanentDelete} onConfirm={() => void permanentlyDeleteTask()} onToggleArtifact={toggleManagedArtifactSelection} /> : null}
      {error && <div className="harness-error" role="alert">{error}</div>}
    </div>
  );
}

function RailButton({ active, onClick, icon, label }: { active: boolean; onClick: () => void; icon: import("react").ReactNode; label: string }) {
  return <button className={`harness-rail-button ${active ? "active" : ""}`} aria-label={label} title={label} onClick={onClick}>{icon}<span>{label}</span></button>;
}

type TaskQuestion = {
  sessionId: string;
  questionId: string;
  question: string;
  createdAt?: string;
};

function TaskSurface({ tasks, selectedTask, run, timeline, taskListMode, activeTaskCount, completedTaskCount, trashTaskCount, selectedTaskIds, runtimeAvailable, busy, selectedSessionId, onSelect, onListModeChange, onCreate, onStart, onAchieved, onResumeAchieved, onStop, onToggleTaskSelection, onMoveAchievedSelection, onRestoreArchivedSelection, onRequestPermanentDelete, onSelectSession, onSaveTaskPageLayout, onArtifact }: {
  tasks: NativeAgentLoopTask[]; selectedTask?: NativeAgentLoopTask; run?: NativeAgentLoopRunDetail; timeline: TimelineItem[]; taskListMode: TaskListMode; activeTaskCount: number; completedTaskCount: number; trashTaskCount: number; selectedTaskIds: string[]; runtimeAvailable: boolean; busy: boolean;
  selectedSessionId?: string; onSelect: (task: NativeAgentLoopTask) => void; onListModeChange: (mode: TaskListMode) => void; onCreate: () => void; onStart: () => void; onAchieved: () => void; onResumeAchieved: () => void; onStop: (task: NativeAgentLoopTask) => void; onToggleTaskSelection: (taskId: string) => void; onMoveAchievedSelection: () => void; onRestoreArchivedSelection: () => void; onRequestPermanentDelete: (taskId: string) => void; onSelectSession: (sessionId: string) => void; onSaveTaskPageLayout: (runId: string, layout: TaskSessionPaneLayout) => void; onArtifact: (path: string) => void;
}) {
  const completed = taskListMode === "completed";
  const recycleBin = taskListMode === "trash";
  const listTitle = recycleBin ? "回收站" : completed ? "已完成任务" : "任务";
  const selectedArchivedTaskIds = selectedTaskIds.filter((taskId) => tasks.some((task) => task.taskId === taskId && task.status === "archived"));
  const selectedArchivedTask = selectedTaskIds.length === 1
    ? tasks.find((task) => task.taskId === selectedTaskIds[0] && task.status === "archived")
    : undefined;
  const activeRun = run?.task.taskId === selectedTask?.taskId ? run : undefined;
  const selectedActivity = activeRun ? workbenchActivity(activeRun) : undefined;
  const sessionNames = useMemo(() => new Map((activeRun?.turns ?? []).map((turn) => [turn.sessionId, turn.details.card.name])), [activeRun?.turns]);
  const taskSessions = useMemo(() => taskSessionWorkspaceItems(activeRun), [activeRun]);
  const conductorSession = taskSessions.find((session) => session.purpose === "conductor");
  const sessionPresentationInteractive = !recycleBin && isTaskRunPresentationInteractive(selectedTask?.status, activeRun?.run.status);
  const selectedSession = sessionPresentationInteractive ? taskSessions.find((session) => session.sessionId === selectedSessionId) ?? conductorSession : undefined;
  const [paneLayout, setPaneLayout] = useState<TaskSessionPaneLayout>(defaultTaskSessionPaneLayout);
  const paneLayoutRef = useRef(paneLayout);
  const taskLayoutRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ edge: "list" | "inspector"; startX: number; startWidth: number; frame?: number; nextWidth?: number } | undefined>(undefined);
  const [inspectorCollapsed, setInspectorCollapsed] = useState(false);
  const [drawer, setDrawer] = useState<"timeline" | "artifacts">();
  useEffect(() => {
    const next = normalizeTaskSessionPaneLayout(activeRun?.workbenchLayout.taskPage);
    paneLayoutRef.current = next;
    setPaneLayout(next);
  }, [activeRun?.run.runId, activeRun?.workbenchLayout.taskPage?.taskListWidth, activeRun?.workbenchLayout.taskPage?.inspectorWidth]);

  useEffect(() => {
    paneLayoutRef.current = paneLayout;
  }, [paneLayout]);

  const applyPaneWidth = useCallback((edge: "list" | "inspector", width: number) => {
    const element = taskLayoutRef.current;
    if (!element) return;
    element.style.setProperty(edge === "list" ? "--task-list-width" : "--task-inspector-width", `${width}px`);
  }, []);

  const boundedPaneWidth = useCallback((edge: "list" | "inspector", width: number) => {
    const element = taskLayoutRef.current;
    if (!element) return undefined;
    const otherWidth = edge === "list" ? paneLayoutRef.current.inspectorWidth : paneLayoutRef.current.taskListWidth;
    const maxWidth = Math.max(196, Math.min(420, element.getBoundingClientRect().width - otherWidth - 496));
    return Math.round(Math.min(maxWidth, Math.max(196, width)));
  }, []);

  const commitPaneWidth = useCallback((edge: "list" | "inspector", width: number) => {
    if (!activeRun || (edge === "inspector" && inspectorCollapsed)) return;
    const nextWidth = boundedPaneWidth(edge, width);
    if (nextWidth === undefined) return;
    const current = paneLayoutRef.current;
    const currentWidth = edge === "list" ? current.taskListWidth : current.inspectorWidth;
    if (nextWidth === currentWidth) return;
    applyPaneWidth(edge, nextWidth);
    const next = edge === "list" ? { ...current, taskListWidth: nextWidth } : { ...current, inspectorWidth: nextWidth };
    paneLayoutRef.current = next;
    setPaneLayout(next);
    onSaveTaskPageLayout(activeRun.run.runId, next);
  }, [activeRun, applyPaneWidth, boundedPaneWidth, inspectorCollapsed, onSaveTaskPageLayout]);

  const resizePaneBy = useCallback((edge: "list" | "inspector", delta: number) => {
    const currentWidth = edge === "list" ? paneLayoutRef.current.taskListWidth : paneLayoutRef.current.inspectorWidth;
    commitPaneWidth(edge, currentWidth + delta);
  }, [commitPaneWidth]);

  const startPaneResize = useCallback((edge: "list" | "inspector", event: import("react").PointerEvent<HTMLButtonElement> | import("react").MouseEvent<HTMLButtonElement>) => {
    if (!activeRun || dragRef.current || (edge === "inspector" && inspectorCollapsed)) return;
    if (!taskLayoutRef.current) return;
    event.preventDefault();
    if ("pointerId" in event) event.currentTarget.setPointerCapture(event.pointerId);
    const startWidth = edge === "list" ? paneLayoutRef.current.taskListWidth : paneLayoutRef.current.inspectorWidth;
    const drag: { edge: "list" | "inspector"; startX: number; startWidth: number; frame?: number; nextWidth?: number } = { edge, startX: event.clientX, startWidth, nextWidth: startWidth };
    dragRef.current = drag;
    document.body.classList.add("agent-loop-resizing");
    const update = (move: PointerEvent | MouseEvent) => {
      const delta = edge === "list" ? move.clientX - drag.startX : drag.startX - move.clientX;
      drag.nextWidth = boundedPaneWidth(edge, drag.startWidth + delta) ?? drag.startWidth;
      if (drag.frame) return;
      drag.frame = requestAnimationFrame(() => {
        drag.frame = undefined;
        if (drag.nextWidth !== undefined) applyPaneWidth(edge, drag.nextWidth);
      });
    };
    const finish = () => {
      window.removeEventListener("pointermove", update);
      window.removeEventListener("mousemove", update);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("mouseup", finish);
      document.body.classList.remove("agent-loop-resizing");
      if (drag.frame) cancelAnimationFrame(drag.frame);
      const width = drag.nextWidth ?? drag.startWidth;
      commitPaneWidth(edge, width);
      dragRef.current = undefined;
    };
    window.addEventListener("pointermove", update);
    window.addEventListener("mousemove", update);
    window.addEventListener("pointerup", finish, { once: true });
    window.addEventListener("mouseup", finish, { once: true });
  }, [activeRun, applyPaneWidth, boundedPaneWidth, commitPaneWidth, inspectorCollapsed]);

  const taskLayoutStyle = {
    "--task-list-width": `${paneLayout.taskListWidth}px`,
    "--task-inspector-width": `${paneLayout.inspectorWidth}px`,
  } as import("react").CSSProperties;
  return <div className={`harness-task-layout ${inspectorCollapsed ? "inspector-collapsed" : ""}`} ref={taskLayoutRef} style={taskLayoutStyle}>
    <aside className="harness-task-list">
      <div className="harness-panel-title">
        <h1>{listTitle}</h1>
        {completed ? <button className="harness-secondary-button compact" disabled={!runtimeAvailable || busy || !selectedTaskIds.length} onClick={onMoveAchievedSelection}><Archive size={14} /> 移入回收站{selectedTaskIds.length ? ` (${selectedTaskIds.length})` : ""}</button> : recycleBin ? <div className="agent-loop-template-actions"><button className="harness-secondary-button compact" disabled={!runtimeAvailable || busy || !selectedArchivedTaskIds.length} onClick={onRestoreArchivedSelection}><Undo2 size={14} /> 放回{selectedArchivedTaskIds.length ? ` (${selectedArchivedTaskIds.length})` : ""}</button><button className="harness-secondary-button compact danger" disabled={!runtimeAvailable || busy || !selectedArchivedTask} onClick={() => selectedArchivedTask && onRequestPermanentDelete(selectedArchivedTask.taskId)}><Trash2 size={14} /> 彻底删除</button></div> : <button className="harness-primary-button compact" disabled={!runtimeAvailable} onClick={onCreate}><Plus size={15} /> 新建</button>}
      </div>
      <p className="harness-list-caption">{recycleBin ? "放回会恢复同一 Task、Run 与 Session 绑定；彻底删除只能在这里再次确认。" : completed ? "已确认交付的 Task 保留历史、产物与原 Session 继续入口；可随时移入回收站。" : "进行中 Task 固定快照一个 Agent Loop Template；确认交付后进入已完成任务管理。"}</p>
      <div className="harness-task-rows" aria-label={recycleBin ? "回收站任务列表" : completed ? "已完成任务列表" : "Task 列表"}>{tasks.length ? tasks.map((task) => {
        const active = task.taskId === selectedTask?.taskId;
        const currentActivity = active ? selectedActivity : undefined;
        const selectable = (completed && task.status === "achieved") || (recycleBin && task.status === "archived");
        const selectionTitle = completed ? `选择“${task.title}”移入回收站` : `选择“${task.title}”放回或彻底删除`;
        return <div className={`harness-task-row-wrap ${selectable ? "completed" : ""}`} key={task.taskId}>{selectable && <label className="harness-achieved-select" title={selectionTitle} onClick={(event) => event.stopPropagation()}><input type="checkbox" checked={selectedTaskIds.includes(task.taskId)} onChange={() => onToggleTaskSelection(task.taskId)} /><span className="sr-only">{selectionTitle}</span></label>}<button className={`harness-task-row ${active ? "active" : ""}`} onClick={() => onSelect(task)}><i className={`harness-state-dot ${task.status}`} /><span><strong>{task.title}</strong><small>{task.architecture.template.name} · v{task.architecture.template.version}</small></span><em title={currentActivity ? `Task 生命周期：${taskStatusLabel(task.status)}；当前活动态：${currentActivity.label}` : undefined}>{currentActivity?.shortLabel ?? taskStatusLabel(task.status)}</em></button></div>;
      }) : <Empty title={recycleBin ? "回收站为空" : completed ? "还没有已完成任务" : "还没有进行中 Task"} detail={recycleBin ? "移入回收站的 Task 会在这里保留同一份历史与可恢复的 Session 绑定。" : completed ? "确认交付后的 Task 会自动移动到这里。" : "新建 Task 后，它会出现在这个列表。"} />}</div>
      {taskListMode !== "active" && <button className="harness-task-manager-button" onClick={() => onListModeChange("active")}><Archive size={15} /><span>进行中任务</span><b>{activeTaskCount}</b><ChevronRight size={15} /></button>}
      {taskListMode !== "completed" && <button className="harness-task-manager-button" onClick={() => onListModeChange("completed")}><Archive size={15} /><span>已完成任务</span><b>{completedTaskCount}</b><ChevronRight size={15} /></button>}
      {taskListMode !== "trash" && <button className="harness-task-manager-button" onClick={() => onListModeChange("trash")}><Trash2 size={15} /><span>回收站</span><b>{trashTaskCount}</b><ChevronRight size={15} /></button>}
    </aside>
    <TaskLayoutResizer edge="list" onPointerDown={startPaneResize} onResizeBy={resizePaneBy} />
    <section className={`harness-timeline-panel ${selectedSession ? "agent-loop-task-conductor" : ""}`}>{selectedTask ? <>
      <header className={`harness-task-head ${selectedSession ? "conductor-priority" : ""}`}><div><div className="harness-breadcrumb">Task / {selectedSession ? `OpenCode ${selectedSession.name} Session` : recycleBin ? "Recycle Bin history" : completed ? "Completed history" : "Agent Loop"}</div><h1>{selectedTask.title}</h1>{!selectedSession && <p>{selectedTask.goal}</p>}</div><div className="harness-task-actions">{selectedTask.status === "queued" && <button className="harness-primary-button" disabled={!runtimeAvailable || busy} onClick={onStart}><Play size={15} /> 启动 Agent Loop</button>}{selectedTask.status === "stopped" && <button className="harness-primary-button" disabled={!runtimeAvailable || busy} onClick={onStart}><Play size={15} /> 重新启动</button>}{activeRun?.run.status === "running" && selectedTask.status !== "achieved" && selectedTask.status !== "archived" && <button className="harness-secondary-button danger" disabled={busy || !runtimeAvailable} onClick={() => onStop(selectedTask)}><Square size={14} /> 停止任务</button>}{selectedSession && <button className={drawer === "timeline" ? "harness-secondary-button active" : "harness-secondary-button"} onClick={() => setDrawer((value) => value === "timeline" ? undefined : "timeline")}><Clock3 size={15} /> 时间线</button>}{selectedTask.status === "delivery_ready" && <button className="harness-primary-button" disabled={busy || !runtimeAvailable} onClick={onAchieved}><CheckCircle2 size={15} /> Achieve</button>}{selectedTask.status === "achieved" && <button className="harness-primary-button" disabled={busy || !runtimeAvailable} onClick={onResumeAchieved}><Play size={15} /> 拉回继续</button>}</div></header>
      {selectedSession ? <div className="agent-loop-conductor-session" aria-label="OpenCode Task Session"><div className="agent-loop-conductor-session-page"><OpenCodeSessionPage key={`${activeRun!.run.runId}:${selectedSession.sessionId}:${selectedTask.revision}`} runId={activeRun!.run.runId} sessionId={selectedSession.sessionId} sessionName={selectedSession.name} presentationEpoch={String(selectedTask.revision)} /></div>{drawer && <WorkbenchDrawer kind={drawer} timeline={timeline} artifacts={activeRun!.artifacts} onArtifact={onArtifact} onClose={() => setDrawer(undefined)} />}</div> : <><div className="harness-timeline-meta"><b>Agent Loop</b><ChevronRight size={14} /><span>{selectedTask.status === "achieved" ? "已确认交付；拉回继续后会重新打开同一 Conductor 的官方 OpenCode Session。" : selectedTask.status === "archived" ? "此 Task 在回收站中，仅保留历史与产物；放回后可继续管理。" : "Conductor 启动后会在这里显示其官方 OpenCode Session。"}</span></div><section className="harness-task-activity" aria-label="Task 时间线"><div className="harness-conversation" aria-label="任务时间线" role="log" tabIndex={0}>{timeline.map((item) => <TimelineMessage item={item} key={item.id} />)}</div></section></>}
    </> : <Empty title={recycleBin ? "回收站为空" : completed ? "还没有已完成任务" : "还没有进行中 Task"} detail={recycleBin ? "回收站中的 Task 可被放回；只有从这里才可确认彻底删除。" : completed ? "确认交付后的 Task 会自动移动到这里。" : "先从已保存的 Agent Loop Template 创建一个任务。"} />}</section>
    <TaskLayoutResizer edge="inspector" disabled={inspectorCollapsed} onPointerDown={startPaneResize} onResizeBy={resizePaneBy} />
    <TaskInspector task={selectedTask} run={activeRun} completed={completed} recycleBin={recycleBin} collapsed={inspectorCollapsed} busy={busy} runtimeAvailable={runtimeAvailable} sessionNames={sessionNames} taskSessions={taskSessions} selectedSessionId={selectedSession?.sessionId} onOpenSession={onSelectSession} onToggle={() => setInspectorCollapsed((current) => !current)} onResumeAchieved={onResumeAchieved} onArtifact={onArtifact} />
  </div>;
}

function OpenCodeAttentionLinks({ run, sessionNames, onOpenSession }: {
  run?: NativeAgentLoopRunDetail;
  sessionNames: ReadonlyMap<string, string>;
  onOpenSession: (sessionId: string) => void;
}) {
  const sessionIds = new Set([
    ...(run?.runtimeState.sessions ?? [])
      .filter((session) => ["waiting_input", "permission_required"].includes(session.state))
      .map((session) => session.sessionId),
    ...(run?.runtimeState.permissions ?? [])
      .filter(isRecord)
      .filter((permission) => ["requested", "reply_failed"].includes(String(permission.status ?? "")))
      .map((permission) => String(permission.sessionId ?? "")),
  ].filter(Boolean));
  if (!sessionIds.size) return null;
  return <section className="agent-loop-open-code-attention" aria-label="OpenCode 需要处理">
    <strong>需要在 OpenCode 中处理</strong>
    <p>授权和问题只在对应的官方 Session 页面完成；这里不再复制输入或答复控件。</p>
    {[...sessionIds].map((sessionId) => {
      const sessionName = sessionNames.get(sessionId) || shortSession(sessionId) || "OpenCode Session";
      return <button className="harness-open-timeline" key={sessionId} onClick={() => onOpenSession(sessionId)}><span>打开 {sessionName}</span><ChevronRight size={16} /></button>;
    })}
  </section>;
}

function TaskLayoutResizer({ edge, disabled, onPointerDown, onResizeBy }: {
  edge: "list" | "inspector";
  disabled?: boolean;
  onPointerDown: (edge: "list" | "inspector", event: import("react").PointerEvent<HTMLButtonElement> | import("react").MouseEvent<HTMLButtonElement>) => void;
  onResizeBy: (edge: "list" | "inspector", delta: number) => void;
}) {
  const label = edge === "list" ? "调整任务列表宽度" : "调整 Session 目录宽度";
  return <button aria-label={label} aria-orientation="vertical" className={`harness-task-resizer ${edge}`} disabled={disabled} onKeyDown={(event) => {
    if (event.repeat) return;
    const direction = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (!direction) return;
    event.preventDefault();
    onResizeBy(edge, (edge === "list" ? direction : -direction) * 24);
  }} onPointerDown={(event) => onPointerDown(edge, event)} role="separator" tabIndex={disabled ? -1 : 0} title={`${label}；可用左右方向键微调`} type="button" />;
}

function templateDesignDraftValidation(draft: NativeTemplateDesignDraft): TemplateDesignDraftValidation {
  const structuralIssues = templateDesignDraftStructuralIssues(draft.draftJson);
  const reportedValidation = draft.validation;
  if (isRecord(reportedValidation) && reportedValidation.valid === false) {
    const reportedIssues = Array.isArray(reportedValidation.issues)
      ? reportedValidation.issues.flatMap((issue): TemplateDesignDraftValidationIssue[] => {
          if (!isRecord(issue)) return [];
          return [{ path: displayText(issue.path, "draftJson"), code: displayText(issue.code, "invalid") }];
        })
      : [];
    return {
      valid: false,
      issues: reportedIssues.length
        ? reportedIssues
        : structuralIssues.length
          ? structuralIssues
          : [{ path: "draftJson", code: "invalid" }],
    };
  }
  return structuralIssues.length ? { valid: false, issues: structuralIssues } : { valid: true, issues: [] };
}

function templateDesignDraftStructuralIssues(draftJson: unknown): TemplateDesignDraftValidationIssue[] {
  if (!isRecord(draftJson)) return [{ path: "draftJson", code: "invalid_draft_json" }];
  const issues: TemplateDesignDraftValidationIssue[] = [];
  if (!isRecord(draftJson.conductor)) issues.push({ path: "draftJson.conductor", code: "invalid_conductor" });
  if (!Array.isArray(draftJson.agents)) issues.push({ path: "draftJson.agents", code: "invalid_agents" });
  else if (draftJson.agents.some((card) => !isRecord(card))) issues.push({ path: "draftJson.agents", code: "invalid_agent_card" });
  return issues;
}

function templateDesignDraftName(draft: NativeTemplateDesignDraft): string {
  const draftJson = draft.draftJson;
  return isRecord(draftJson) ? displayText(draftJson.name, "Template Draft") : "Template Draft";
}

function templateDesignPreview(draft: NativeTemplateDesignDraft, baseTemplate?: NativeAgentLoopTemplate): NativeAgentLoopTemplate | undefined {
  const draftJson = draft.draftJson;
  if (!isRecord(draftJson)) return undefined;
  return {
    ...(draftJson as NativeAgentLoopTemplate),
    id: baseTemplate?.id ?? displayText(draftJson.id, "template-draft"),
    version: baseTemplate?.version ?? 0,
    archivedAt: baseTemplate?.archivedAt,
    createdAt: baseTemplate?.createdAt ?? draft.createdAt,
    updatedAt: draft.updatedAt,
  };
}

export function TemplateSurface({ templates, templateVersions, selectedTemplate, runtimeAvailable, busy, taskCreationPending, taskCreationIntent, taskCreationTemplateVersion, onReturnToTask, onSelect, onSelectVersion, onCreate, onEdit, onCopy, onArchive, onDelete, onError, designDraft, activeDesignDrafts, metaAgentOpen, metaAgentBusy, onOpenMetaAgent, onOpenDesignDraft, onRetryDesignDraft, onCloseMetaAgent, onSaveDesignDraft, onDesignDraftChange, onDesignDraftDiscarded }: {
  templates: NativeAgentLoopTemplate[]; selectedTemplate?: NativeAgentLoopTemplate; runtimeAvailable: boolean; busy: boolean;
  taskCreationPending: boolean; taskCreationIntent?: TaskTemplateDesignIntent; taskCreationTemplateVersion?: number; onReturnToTask: () => void;
  templateVersions: NativeAgentLoopTemplate[];
  onSelect: (template: NativeAgentLoopTemplate) => void; onSelectVersion: (version: number) => void; onCreate: () => void; onEdit: (template: NativeAgentLoopTemplate) => void; onCopy: () => void; onArchive: () => void; onDelete: () => void;
  onError: (message?: string) => void;
  designDraft?: NativeTemplateDesignDraft; activeDesignDrafts: NativeTemplateDesignSessionSummary[]; metaAgentOpen: boolean; metaAgentBusy: boolean;
  onOpenMetaAgent: (template: NativeAgentLoopTemplate) => void; onOpenDesignDraft: (draftId: string) => void; onRetryDesignDraft: (draftId: string) => void; onCloseMetaAgent: () => void; onSaveDesignDraft: () => void; onDesignDraftChange: (draft?: NativeTemplateDesignDraft) => void; onDesignDraftDiscarded: () => void;
}) {
  const [inspectedCardId, setInspectedCardId] = useState<string>();
  const [metaDockWidth, setMetaDockWidth] = useState(templateMetaDockMinimumWidth);
  const metaDockWidthRef = useRef(metaDockWidth);
  const templateLayoutRef = useRef<HTMLDivElement>(null);
  const metaResizeRef = useRef<{ startX: number; startWidth: number; nextWidth?: number; frame?: number } | undefined>(undefined);
  const designDraftValidation = designDraft ? templateDesignDraftValidation(designDraft) : undefined;
  const designDraftNeedsRepair = Boolean(designDraft && !designDraftValidation?.valid);
  const activeDraft = designDraft?.status === "active" && !designDraftNeedsRepair ? designDraft : undefined;
  const baseTemplateForDraft = activeDraft?.templateId
    ? templateVersions.find((template) => template.id === activeDraft.templateId && template.version === activeDraft.baseTemplateVersion)
      ?? templates.find((template) => template.id === activeDraft.templateId)
    : undefined;
  const previewTemplate = designDraftNeedsRepair ? undefined : activeDraft ? templateDesignPreview(activeDraft, baseTemplateForDraft) : selectedTemplate;
  const previewCards = Array.isArray(previewTemplate?.agents)
    ? previewTemplate.agents.filter((card): card is NativeSessionAgentCard => isRecord(card))
    : [];
  const inspectedCard = previewCards.find((card) => card.id === inspectedCardId) ?? previewCards[0];

  useEffect(() => {
    metaDockWidthRef.current = metaDockWidth;
  }, [metaDockWidth]);

  useEffect(() => {
    const draftId = designDraft?.draftId;
    if (!draftId) return undefined;
    let active = true;
    let latestRevision = designDraft.revision;
    const unsubscribe = subscribeNativeAgentLoopTemplateDesignEvents((event) => {
      if (event.draftId !== draftId || event.revision <= latestRevision) return;
      latestRevision = event.revision;
      if (event.type === "template_design.draft_discarded") {
        onDesignDraftDiscarded();
        return;
      }
      void readNativeAgentLoopTemplateDesignSession(draftId)
        .then((nextDraft) => {
          if (!active || nextDraft?.draftId !== draftId || nextDraft.revision < latestRevision) return;
          if (nextDraft.status === "discarded") {
            onDesignDraftDiscarded();
            return;
          }
          onDesignDraftChange(nextDraft);
        })
        .catch((reason: unknown) => {
          if (active) onError(messageFor(reason));
        });
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [designDraft?.draftId, designDraft?.revision, onDesignDraftChange, onDesignDraftDiscarded, onError]);

  const metaDockBounds = useCallback(() => {
    const layout = templateLayoutRef.current;
    if (!layout) return { min: templateMetaDockMinimumWidth, max: templateMetaDockMaximumWidth };
    const inspector = layout.querySelector<HTMLElement>(".agent-loop-template-inspector");
    const inspectorWidth = inspector?.getBoundingClientRect().width ?? 0;
    const canvasMinimumWidth = inspectorWidth > 0 ? 456 : 360;
    const max = Math.max(
      templateMetaDockMinimumWidth,
      Math.min(templateMetaDockMaximumWidth, Math.floor(layout.getBoundingClientRect().width - inspectorWidth - canvasMinimumWidth - 8)),
    );
    return { min: templateMetaDockMinimumWidth, max };
  }, []);

  const resizeMetaDockBy = useCallback((delta: number) => {
    const bounds = metaDockBounds();
    setMetaDockWidth((current) => Math.round(Math.min(bounds.max, Math.max(bounds.min, current + delta))));
  }, [metaDockBounds]);

  const startMetaDockResize = useCallback((event: import("react").PointerEvent<HTMLButtonElement> | import("react").MouseEvent<HTMLButtonElement>) => {
    const layout = templateLayoutRef.current;
    if (!layout || metaResizeRef.current) return;
    event.preventDefault();
    if ("pointerId" in event) event.currentTarget.setPointerCapture(event.pointerId);
    const startWidth = metaDockWidthRef.current;
    const resize: { startX: number; startWidth: number; nextWidth?: number; frame?: number } = { startX: event.clientX, startWidth, nextWidth: startWidth };
    metaResizeRef.current = resize;
    document.body.classList.add("agent-loop-resizing");
    const update = (move: PointerEvent | MouseEvent) => {
      const bounds = metaDockBounds();
      resize.nextWidth = Math.round(Math.min(bounds.max, Math.max(bounds.min, resize.startWidth + move.clientX - resize.startX)));
      if (resize.frame) return;
      resize.frame = requestAnimationFrame(() => {
        resize.frame = undefined;
        if (resize.nextWidth !== undefined) setMetaDockWidth(resize.nextWidth);
      });
    };
    const finish = () => {
      window.removeEventListener("pointermove", update);
      window.removeEventListener("mousemove", update);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("mouseup", finish);
      document.body.classList.remove("agent-loop-resizing");
      if (resize.frame) cancelAnimationFrame(resize.frame);
      const width = resize.nextWidth ?? resize.startWidth;
      setMetaDockWidth(width);
      metaResizeRef.current = undefined;
    };
    window.addEventListener("pointermove", update);
    window.addEventListener("mousemove", update);
    window.addEventListener("pointerup", finish, { once: true });
    window.addEventListener("mouseup", finish, { once: true });
  }, [metaDockBounds]);

  const layoutStyle = { "--template-meta-width": `${metaDockWidth}px` } as import("react").CSSProperties;
  const templateIsDraftPreview = Boolean(activeDraft);
  const templateName = designDraftNeedsRepair && designDraft
    ? templateDesignDraftName(designDraft)
    : displayText(previewTemplate?.name, activeDraft ? templateDesignDraftName(activeDraft) : displayText(selectedTemplate?.name, "Template Draft"));
  const history = selectedTemplate
    ? templateVersions.filter((template) => template.id === selectedTemplate.id)
    : [];
  const visibleHistory = history.length ? history : selectedTemplate ? [selectedTemplate] : [];
  const isHistoricalVersion = !templateIsDraftPreview && Boolean(
    selectedTemplate && visibleHistory[0] && selectedTemplate.version !== visibleHistory[0].version,
  );

  return <div className={`harness-template-layout agent-loop-template-studio ${metaAgentOpen ? "template-meta-open" : ""}`} ref={templateLayoutRef} style={layoutStyle}>
    <aside className="harness-template-list agent-loop-template-meta-dock-host">
      {metaAgentOpen && designDraft ? <TemplateMetaAgentDock
        busy={metaAgentBusy}
        draft={designDraft}
        validation={designDraftValidation ?? { valid: true, issues: [] }}
        taskCreationIntent={taskCreationIntent}
        onClose={onCloseMetaAgent}
        onRetry={() => onRetryDesignDraft(designDraft.draftId)}
        onSave={onSaveDesignDraft}
        templateName={templateName}
      /> : <TemplateList templates={templates} selectedTemplate={selectedTemplate} runtimeAvailable={runtimeAvailable} activeDesignDrafts={activeDesignDrafts} activeDesignDraftId={activeDraft?.draftId} onCreate={onCreate} onSelect={onSelect} onOpenDesignDraft={onOpenDesignDraft} />}
    </aside>
    {metaAgentOpen && designDraft ? <TemplateMetaDockResizer onPointerDown={startMetaDockResize} onResizeBy={resizeMetaDockBy} /> : null}
    <section className="harness-template-canvas">{designDraftNeedsRepair && designDraftValidation ? <TemplateDraftRepairState validation={designDraftValidation} /> : previewTemplate ? <>
      <header className="harness-template-head"><div><div className="harness-breadcrumb">Template / Agent Loop{templateIsDraftPreview ? " · Draft preview" : ""}</div><h1>{previewTemplate.name}</h1></div><div className="agent-loop-template-actions">{taskCreationPending ? <button className="harness-primary-button compact" onClick={onReturnToTask}><ChevronLeft size={14} /> {taskCreationTemplateVersion ? `继续创建 Task · v${taskCreationTemplateVersion}` : "继续创建 Task"}</button> : null}{templateIsDraftPreview ? <span className="agent-loop-template-draft-state">未保存草案 · r{designDraft?.revision}</span> : <label className="agent-loop-template-version-select"><span>版本</span><select aria-label="Template 版本历史" disabled={metaAgentOpen || visibleHistory.length < 2} value={selectedTemplate?.version ?? ""} onChange={(event) => onSelectVersion(Number(event.target.value))}>{visibleHistory.map((template, index) => <option key={`${template.id}-v${template.version}`} value={template.version}>v{template.version}{index === 0 ? " · 当前" : " · 只读历史"}</option>)}</select></label>}{!metaAgentOpen ? <button className="harness-secondary-button compact agent-loop-template-ai-entry" disabled={!runtimeAvailable || metaAgentBusy} title={runtimeAvailable ? "以当前所选不可变版本创建持续的 Template Meta Agent Draft" : "仅桌面 Native Runtime 可打开 Template Meta Agent"} onClick={() => activeDraft ? onOpenDesignDraft(activeDraft.draftId) : onOpenMetaAgent(previewTemplate)}><Bot size={14} /> {activeDraft ? "继续 AI 修订" : isHistoricalVersion ? "基于此版本修订" : "AI 修订"}</button> : null}<button className="harness-secondary-button compact" disabled={!runtimeAvailable || busy || metaAgentOpen || templateIsDraftPreview} onClick={() => onEdit(previewTemplate)}><Pencil size={14} /> 编辑 / 新版本</button><button className="harness-secondary-button compact" disabled={!runtimeAvailable || busy || metaAgentOpen || templateIsDraftPreview} onClick={onCopy}><Copy size={14} /> 复制</button><button className="harness-secondary-button compact" disabled={!runtimeAvailable || busy || metaAgentOpen || templateIsDraftPreview} onClick={onArchive}><Archive size={14} /> 归档</button><button className="harness-secondary-button compact danger" disabled={!runtimeAvailable || busy || metaAgentOpen || templateIsDraftPreview} onClick={onDelete}><Trash2 size={15} /> 删除</button></div></header>
      <div className="agent-loop-contract-note"><strong>Conductor Charter</strong><span>{templateConductorCharter(previewTemplate)}</span></div>
      <div className="agent-loop-contract-note"><strong>平台保证</strong><span>Conductor 根据卡片派发档案决定是否派发，并写入本次目标、输入、验收和预期产物；Runtime 只记录事实，不执行业务路线。</span></div>
      <section className="agent-loop-template-card-section"><header><div><h2>Session Agent Cards <span>{previewCards.length} 张</span></h2><p>点击卡片查看其给 Conductor 与 Worker 的不同上下文。</p></div></header><div className="agent-loop-card-grid">{previewCards.map((card) => <AgentCard key={displayText(card.id, "card")} card={card} selected={card.id === inspectedCard?.id} onSelect={() => setInspectedCardId(card.id)} />)}</div></section>
    </> : <Empty title="还没有 Template" detail="创建一个 Agent Loop Template，再配置它的原生 Session Agent 卡片。" />}</section>
    <aside className="harness-inspector agent-loop-template-inspector">{!designDraftNeedsRepair && previewTemplate ? <TemplateCardInspector template={previewTemplate} card={inspectedCard} /> : null}</aside>
  </div>;
}

function TemplateDraftRepairState({ validation }: { validation: TemplateDesignDraftValidation }) {
  const issueSummary = validation.issues
    .map((issue) => `${issue.path} (${issue.code})`)
    .join("；");
  return <Empty
    title="此 Template Draft 需要修复"
    detail={`草案结构暂不能渲染为 Card 或 Inspector。请在左侧 Template Meta Agent 中修复后再保存。${issueSummary ? ` 问题：${issueSummary}` : ""}`}
  />;
}

function TemplateList({ templates, selectedTemplate, runtimeAvailable, activeDesignDrafts, activeDesignDraftId, onCreate, onSelect, onOpenDesignDraft }: {
  templates: NativeAgentLoopTemplate[]; selectedTemplate?: NativeAgentLoopTemplate; runtimeAvailable: boolean; activeDesignDrafts: NativeTemplateDesignSessionSummary[]; activeDesignDraftId?: string; onCreate: () => void; onSelect: (template: NativeAgentLoopTemplate) => void; onOpenDesignDraft: (draftId: string) => void;
}) {
  return <><div className="harness-panel-title"><h1>Loop Templates</h1><button className="harness-primary-button compact" disabled={!runtimeAvailable} onClick={() => onCreate()}><Plus size={15} /> 新建</button></div><p className="harness-list-caption">卡片定义稳定能力边界；Conductor 只在其中派发本次工作契约。</p><div className="agent-loop-template-rows">{templates.map((template) => <button className={`harness-template-row ${template.id === selectedTemplate?.id ? "active" : ""}`} onClick={() => onSelect(template)} key={displayText(template.id, "template")}><Bot size={16} /><span><strong>{displayText(template.name, "未命名 Template")}</strong><small>{`Agent Loop · v${displayRevision(template.version)} · ${templateAgentCards(template).length} cards`}</small></span></button>)}</div>{activeDesignDrafts.length ? <section className="agent-loop-template-active-drafts" aria-label="未保存 Template Draft"><strong>未保存草案</strong><div className="agent-loop-template-rows">{activeDesignDrafts.map((draft) => <button className={`harness-template-row ${draft.draftId === activeDesignDraftId ? "active" : ""}`} onClick={() => onOpenDesignDraft(draft.draftId)} key={displayText(draft.draftId, "template-draft")}><Bot size={16} /><span><strong>{displayText(draft.name, "未命名 Template Draft")}</strong><small>{`Draft · r${displayRevision(draft.revision)} · ${compactModelName(draft.model)}`}</small></span></button>)}</div></section> : null}</>;
}

function TemplateMetaAgentDock({ draft, templateName, validation, taskCreationIntent, busy, onClose, onRetry, onSave }: {
  draft: NativeTemplateDesignDraft; templateName: string; validation: TemplateDesignDraftValidation; taskCreationIntent?: TaskTemplateDesignIntent; busy: boolean; onClose: () => void; onRetry: () => void; onSave: () => void;
}) {
  const active = draft.status === "active";
  const needsProviderSession = active && !draft.providerSessionId;
  const canSave = active && validation.valid && !needsProviderSession;
  const taskIntentKey = taskCreationIntent
    ? `${taskCreationIntent.title}\u0000${taskCreationIntent.goal}\u0000${taskCreationIntent.cwd}`
    : "";
  const [handoffPrompt, setHandoffPrompt] = useState(() => taskCreationIntent ? taskTemplateDesignPrompt(taskCreationIntent) : "");
  const [handoffCopied, setHandoffCopied] = useState(false);

  useEffect(() => {
    setHandoffPrompt(taskCreationIntent ? taskTemplateDesignPrompt(taskCreationIntent) : "");
    setHandoffCopied(false);
  }, [taskIntentKey]);

  const copyTaskIntent = async () => {
    if (!handoffPrompt.trim() || !navigator.clipboard?.writeText) return;
    try {
      await navigator.clipboard.writeText(handoffPrompt);
      setHandoffCopied(true);
    } catch {
      // Clipboard access is not guaranteed by the Electron presentation
      // surface. The editable text remains selectable for manual copy.
      setHandoffCopied(false);
    }
  };

  return <section className="agent-loop-template-meta-dock" aria-label="Template Meta Agent">
    <header className="agent-loop-template-meta-head"><div><span>Meta Agent · 当前 Draft</span><strong>{templateName}</strong></div><button aria-label="隐藏 Template Meta Agent" title="隐藏 Template Meta Agent" onClick={onClose}>×</button></header>
    <div className="agent-loop-template-meta-session">
      {taskCreationIntent ? <section className="agent-loop-template-task-intent" aria-label="待创建 Task 的 AI 起草输入">
        <header><strong>待创建 Task 的 AI 起草输入</strong><span>未发送</span></header>
        <p>这份上下文只保留在当前创建流程，不会写入 Template，也不会自动发送、保存或创建 Task。</p>
        <textarea aria-label="AI 起草输入草稿" rows={5} value={handoffPrompt} onChange={(event) => { setHandoffPrompt(event.target.value); setHandoffCopied(false); }} />
        <div><button className="harness-secondary-button compact" type="button" onClick={() => void copyTaskIntent()}>{handoffCopied ? "已复制" : "复制到官方输入框"}</button><small>编辑或复制后，再由你粘贴到下方官方 OpenCode 输入框发送。</small></div>
      </section> : null}
      {active ? <TemplateDesignWebUiPreview draftId={draft.draftId} templateName={templateName} /> : <div className="agent-loop-template-meta-saved"><strong>这个历史 Draft 已关闭</strong><span>当前 Template 仍可随时重新编辑；系统会从所选 Version 打开一个新的可编辑 Draft。</span></div>}
    </div>
    <footer className="agent-loop-template-meta-footer"><span>{!validation.valid ? "结构需修复后才能保存" : needsProviderSession ? "等待连接 OpenCode" : active ? `草案 r${displayRevision(draft.revision)} · 可继续编辑` : "历史 Draft"}</span>{needsProviderSession ? <button className="harness-secondary-button compact" disabled={busy} onClick={onRetry}>{busy ? "连接中…" : "重试连接 OpenCode"}</button> : null}<button className="harness-primary-button compact" disabled={!canSave || busy} onClick={onSave}>{busy ? "保存中…" : "保存新版本"}</button></footer>
  </section>;
}

function TemplateMetaDockResizer({ onPointerDown, onResizeBy }: {
  onPointerDown: (event: import("react").PointerEvent<HTMLButtonElement> | import("react").MouseEvent<HTMLButtonElement>) => void;
  onResizeBy: (delta: number) => void;
}) {
  return <button aria-label="调整模板侧栏宽度" aria-orientation="vertical" className="agent-loop-template-resizer" onKeyDown={(event) => {
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      onResizeBy(-24);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      onResizeBy(24);
    }
  }} onMouseDown={onPointerDown} onPointerDown={onPointerDown} role="separator" title="调整模板侧栏宽度" type="button" />;
}

function TemplateCardInspector({ template, card }: { template: NativeAgentLoopTemplate; card?: NativeSessionAgentCard }) {
  if (!card) return <><h2>Template Inspector</h2><InspectorRow label="Conductor 模型" value={templateConductorModel(template)} /><InspectorRow label="Session Cards" value={`${templateAgentCards(template).length} 张`} /><section className="harness-inspector-section"><strong>Conductor Charter</strong><p>{templateConductorCharter(template)}</p></section></>;
  const split = isNativePromptSplitSessionAgentCard(card);
  const cardName = displayText(card.name, "未命名 Session Agent");
  const cardId = displayText(card.id, "未声明");
  const dispatchTitle = split ? displayText(card.dispatchProfile.title, "未命名派发能力") : "";
  const dispatchDescription = split ? displayText(card.dispatchProfile.description, "未填写。Conductor 不会从 Worker system prompt 推断此卡的派发用途。") : "";
  const workerSystemPrompt = split ? displayText(card.workerSystemPrompt, "未填写。首次派发前需要先补全此卡的稳定工作指引。") : "";
  return <><header className="agent-loop-template-inspector-head"><div><h2>{cardName}</h2><span>{cardId} · {agentKindLabel(card.kind)}</span></div></header><section className="harness-inspector-section agent-loop-card-execution"><strong>执行环境</strong><InspectorRow label="模型" value={compactModelName(card.model)} /><InspectorRow label="OpenCode 执行 Agent" value="Build（Worker 默认）" /><p>这张 Card 的角色、派发档案和 Worker System Prompt 属于 Template；Build 只是底层官方 Provider Agent，并不覆盖 Card 配置。</p></section>{split ? <><section className="harness-inspector-section agent-loop-card-context"><strong>给 Conductor 的派发档案</strong><h3>{dispatchTitle}</h3><p>{dispatchDescription}</p><small>只进入 Conductor 的卡片注册表，用于选择和编写本次派发契约；不会进入 Worker system prompt。</small></section><section className="harness-inspector-section agent-loop-card-context"><strong>给 Worker Session 的 System Prompt</strong><pre>{workerSystemPrompt}</pre><small>每次向该 Worker Session 派发时，Runtime 都将它作为稳定 system context 传给官方 OpenCode；本次目标、输入和验收仅放在普通 Dispatch message 中。</small></section></> : <section className="harness-inspector-section agent-loop-legacy-card"><strong>遗留卡片</strong><p>这是旧版合并文本，无法安全自动拆分为 Conductor 派发档案和 Worker system prompt。请用 Template Meta Agent 生成可审阅的新版本后再保存。</p><div><span>旧版角色</span><code>{legacyCardRole(card) || "未填写"}</code></div></section>}<section className="harness-inspector-section agent-loop-card-capabilities"><strong>Template 约束</strong><InspectorRow label="MCP" value={allowlistLabel(card.mcp)} /><InspectorRow label="Skills" value={allowlistLabel(card.skills)} /><p>留空即沿用 OpenCode Build 已配置的能力；这不会创建另一份 Provider Agent 配置。</p></section></>;
}

function WorkbenchDrawer({ kind, timeline, artifacts, onArtifact, onClose }: { kind: "timeline" | "artifacts"; timeline: TimelineItem[]; artifacts: NativeAgentLoopRunDetail["artifacts"]; onArtifact: (path: string) => void; onClose: () => void }) {
  const eyebrow = kind === "timeline" ? "TASK TIMELINE" : "DELIVERY ARTIFACTS";
  const title = kind === "timeline" ? "任务时间线" : "产物";
  return <aside className="agent-loop-workbench-drawer" aria-label={title}>
    <header><div><span>{eyebrow}</span><h2>{title}</h2></div><button aria-label="关闭抽屉" onClick={onClose}>×</button></header>
    <div className="agent-loop-workbench-drawer-content">{kind === "timeline" ? timeline.map((item) => <TimelineMessage item={item} key={item.id} />) : artifacts.length ? artifacts.map((artifact) => <button className="agent-loop-artifact-row" disabled={!artifact.previewable} key={artifact.path} onClick={() => onArtifact(artifact.path)}><FilePlus2 size={16} /><span><strong>{artifact.path}</strong><small>{`${artifact.size ?? 0} bytes · 打开预览`}</small></span><ChevronRight size={15} /></button>) : <Empty title="尚无可打开产物" detail="Task 可以用消息、结论或多个文件交付；只有 Runtime 已确认存在的项目文件会显示在这里。" />}</div>
  </aside>;
}

function TaskInspector({ task, run, completed, recycleBin, collapsed, busy, runtimeAvailable, sessionNames, taskSessions, selectedSessionId, onOpenSession, onToggle, onResumeAchieved, onArtifact }: { task?: NativeAgentLoopTask; run?: NativeAgentLoopRunDetail; completed: boolean; recycleBin: boolean; collapsed: boolean; busy: boolean; runtimeAvailable: boolean; sessionNames: ReadonlyMap<string, string>; taskSessions: ReturnType<typeof taskSessionWorkspaceItems>; selectedSessionId?: string; onOpenSession: (sessionId: string) => void; onToggle: () => void; onResumeAchieved: () => void; onArtifact: (path: string) => void }) {
  if (collapsed) return <aside className="harness-inspector collapsed"><button className="harness-inspector-toggle" aria-label="展开任务设置" title="展开任务设置" onClick={onToggle}><ChevronLeft size={17} /></button></aside>;
  if (!task) return <aside className="harness-inspector"><button className="harness-inspector-toggle" aria-label="收起任务设置" title="收起任务设置" onClick={onToggle}><ChevronRight size={17} /></button></aside>;
  const artifacts = run?.artifacts.filter((artifact) => artifact.exists && artifact.previewable) ?? [];
  const sessionPresentationInteractive = isTaskRunPresentationInteractive(task.status, run?.run.status);
  return <aside className="harness-inspector"><header className="harness-inspector-title"><h2>{recycleBin ? "回收站 Task" : completed ? "已完成任务" : "Task Sessions"}</h2><button className="harness-inspector-toggle" aria-label="收起任务设置" title="收起任务设置" onClick={onToggle}><ChevronRight size={17} /></button></header><TaskSessionDirectory sessions={taskSessions} selectedSessionId={selectedSessionId} readOnly={!sessionPresentationInteractive} onOpenSession={onOpenSession} /><section className="harness-inspector-section agent-loop-task-goal"><strong>Task 目标</strong><p>{task.goal}</p></section>{sessionPresentationInteractive && <OpenCodeAttentionLinks run={run} sessionNames={sessionNames} onOpenSession={onOpenSession} />}{recycleBin ? <section className="harness-inspector-section"><strong>回收站保留范围</strong><p>{task.status === "deleting" ? "正在按已确认的清理范围永久删除；Task 不可再放回。" : "Task、Run、Session 绑定与受管产物记录仍保留。先放回已完成任务，才可使用原 Conductor Session 拉回继续。"}</p></section> : completed ? <section className="harness-inspector-section"><strong>历史与继续</strong><p>{task.status === "achieved" ? "“拉回继续”会先验证原 Conductor Provider Session；验证成功才恢复同一个 Task 和 Run。若该 Session 已不存在，历史保持不变。" : "此 Task 已归档，只保留历史与产物；不会自动创建新的 Run。"}</p></section> : <section className="harness-inspector-section"><strong>控制边界</strong><p>每张 Agent Card 在本 Run 首次派发时创建一个 Agent Session；后续调用复用该 Session。Runtime 只投影事实，不决定下一步。</p></section>}{artifacts.map((artifact) => <button className="harness-open-timeline" key={artifact.path} onClick={() => onArtifact(artifact.path)}><span>打开产物</span><code>{artifact.path}</code></button>)}{completed && task.status === "achieved" ? <button className="harness-open-timeline" disabled={busy || !runtimeAvailable} onClick={onResumeAchieved}><span>拉回继续</span><Play size={15} /></button> : null}</aside>;
}

function TaskSessionDirectory({ sessions, selectedSessionId, readOnly, onOpenSession }: { sessions: ReturnType<typeof taskSessionWorkspaceItems>; selectedSessionId?: string; readOnly?: boolean; onOpenSession: (sessionId: string) => void }) {
  return <section className="harness-inspector-section agent-loop-task-session-directory"><strong>当前 Task Run</strong><p>{readOnly ? "原有 Session 绑定与历史仍保留；只有 Task 处于可继续运行状态时才会重新打开官方 Session 页面。" : sessions.length ? `Conductor 是 owner；${Math.max(0, sessions.length - 1)} 张 Agent Card 已映射到此 Run。已派发 Card 可打开其 Session。` : "启动后会出现 Conductor Session。"}</p><div>{sessions.map((session) => <button className={session.sessionId === selectedSessionId ? "active" : ""} data-task-session-id={session.sessionId} disabled={readOnly || !session.canOpen} key={session.sessionId} onClick={() => onOpenSession(session.sessionId)} title={readOnly ? "当前 Task 不处于可继续的运行状态，不能打开官方 OpenCode Session。" : session.canOpen ? `打开 ${session.name} 官方 OpenCode Session` : "Conductor 尚未派发此 Card，因此没有可打开的 Provider Session。"}><i className={`harness-state-dot ${session.dispatchStatus}`} /><span><strong>{session.name}</strong><small>{session.purpose === "conductor" ? "Owner · Conductor" : `${agentKindLabel(session.kind as NativeSessionAgentCard["kind"])} · ${session.model}`}</small></span><em>{session.purpose === "conductor" ? "Owner" : sessionDispatchLabel(session.dispatchStatus)}</em></button>)}</div></section>;
}

function TaskPermanentDeleteDialog({ task, preview, previewLoading, selectedArtifactPaths, busy, onCancel, onConfirm, onToggleArtifact }: { task?: NativeAgentLoopTask; preview?: PermanentDeletePreview; previewLoading: boolean; selectedArtifactPaths: string[]; busy: boolean; onCancel: () => void; onConfirm: () => void; onToggleArtifact: (path: string) => void }) {
  return <div className="agent-loop-delete-backdrop" role="dialog" aria-modal="true" aria-label="彻底删除回收站 Task 确认">
    <button className="agent-loop-delete-scrim" aria-label="取消彻底删除回收站 Task" onClick={onCancel} />
    <section className="agent-loop-delete-dialog"><header><div><span>PERMANENTLY DELETE TASK</span><h2>彻底删除“{task?.title ?? "此 Task"}”吗？</h2></div><button aria-label="关闭彻底删除确认" onClick={onCancel}>×</button></header><div className="agent-loop-delete-copy"><p>这一步会清理此 Task 的 Runtime 数据、Run、Session 绑定、页面租约与受管记录，完成后无法再放回或拉回原 Session。</p><p><strong>项目目录不会删除。</strong>不会删除 <code>{preview?.projectCwd ?? task?.cwd ?? "项目目录"}</code>，也不会删除任何未被登记为受管产物的文件，例如用户保留的 <code>user-kept-note.md</code>。</p>{previewLoading ? <p>正在读取此 Task 已登记的受管产物…</p> : preview?.managedArtifacts.length ? <><strong>可选删除的受管产物</strong><p>仅勾选的文件会一并删除；未勾选的受管文件也会保留在项目目录。</p><div>{preview.managedArtifacts.map((artifact) => <label className="agent-loop-artifact-row" key={artifact.path}><input type="checkbox" disabled={!artifact.deletable} checked={selectedArtifactPaths.includes(artifact.path)} onChange={() => onToggleArtifact(artifact.path)} /><span><strong>{artifact.path}</strong><small>{artifact.exists ? `${artifact.size ?? 0} bytes · 已登记受管产物` : "文件当前不存在"}</small></span><small>{artifact.deletable ? "可删除" : "不可删除"}</small></label>)}</div></> : <p>此 Task 没有已登记的受管产物。只会清理 Task/Run/Session 的 Runtime 数据，不会删除项目文件。</p>}</div><footer><button className="harness-secondary-button" disabled={busy} onClick={onCancel}>取消</button><button className="harness-primary-button danger" disabled={busy || previewLoading || !preview} onClick={onConfirm}>{busy ? "删除中…" : "彻底删除 Task"}</button></footer></section>
  </div>;
}

function TaskStopDialog({ task, busy, onCancel, onConfirm }: { task: NativeAgentLoopTask; busy: boolean; onCancel: () => void; onConfirm: () => void }) {
  return <div className="agent-loop-delete-backdrop" role="dialog" aria-modal="true" aria-label="停止 Task 确认">
    <button className="agent-loop-delete-scrim" aria-label="取消停止 Task" onClick={onCancel} />
    <section className="agent-loop-delete-dialog agent-loop-stop-dialog"><header><div><span>STOP TASK</span><h2>停止“{task.title}”吗？</h2></div><button aria-label="关闭停止确认" onClick={onCancel}>×</button></header><div className="agent-loop-delete-copy"><p>会停止此 Task 当前所有原生 Session。Task、Run、事件、终端历史和产物记录都会保留。</p><p><strong>不会删除项目交付文件。</strong>之后可从此页“重新启动”，创建一个新的 Run。</p></div><footer><button className="harness-secondary-button" disabled={busy} onClick={onCancel}>取消</button><button className="harness-primary-button" disabled={busy} onClick={onConfirm}>{busy ? "停止中…" : "停止任务"}</button></footer></section>
  </div>;
}

export function TemplateDialog({ draft, modelCapabilities, busy, enabled, onChange, onClose, onSave }: { draft: TemplateDraft; modelCapabilities: NativeOpencodeModelCapability[]; busy: boolean; enabled: boolean; onChange: (value: TemplateDraft) => void; onClose: () => void; onSave: () => void }) {
  const [activePane, setActivePane] = useState<"agents" | "loop">("agents");
  const [selectedAgentId, setSelectedAgentId] = useState(() => draft.agents[0]?.id ?? "");
  const selectedAgentIndex = Math.max(0, draft.agents.findIndex((card) => card.id === selectedAgentId));
  const selectedAgent = draft.agents[selectedAgentIndex];
  const selectedSplitAgent = selectedAgent && isNativePromptSplitSessionAgentCard(selectedAgent) ? selectedAgent : undefined;
  const updateSplitCard = (index: number, patch: Partial<NativePromptSplitSessionAgentCard>) => onChange({
    ...draft,
    agents: draft.agents.map((card, cardIndex) => {
      if (cardIndex !== index || !isNativePromptSplitSessionAgentCard(card)) return card;
      return { ...card, ...patch } as NativePromptSplitSessionAgentCard;
    }),
  });
  const addCard = () => {
    const card = defaultCard(`agent-${draft.agents.length + 1}`);
    onChange({ ...draft, agents: [...draft.agents, card] });
    setSelectedAgentId(card.id);
  };
  const removeSelectedCard = () => {
    if (!selectedSplitAgent || draft.agents.length < 2) return;
    const nextCards = draft.agents.filter((_, index) => index !== selectedAgentIndex);
    onChange({ ...draft, agents: nextCards });
    setSelectedAgentId(nextCards[Math.min(selectedAgentIndex, nextCards.length - 1)]?.id ?? "");
  };
  return <div className="agent-loop-drawer-backdrop" role="dialog" aria-modal="true" aria-label="编辑 Agent Loop Template">
    <button className="agent-loop-drawer-scrim" aria-label="关闭编辑器" onClick={onClose} />
    <section className="agent-loop-drawer">
      <header className="agent-loop-drawer-header"><div><h2>{draft.name || "新建 Template"}</h2><p>编辑后会保存为新的 Template 版本；已有 Task 不会改变。</p></div><button className="agent-loop-drawer-close" onClick={onClose} aria-label="关闭">×</button></header>
      <div className="agent-loop-drawer-scroll">
        <section className="agent-loop-drawer-basics" aria-label="Template 基本信息"><label>模板名称<input value={draft.name} onChange={(event) => onChange({ ...draft, name: event.target.value })} /></label></section>
        <div className="agent-loop-drawer-tabs" role="tablist" aria-label="Template 编辑内容"><button role="tab" aria-selected={activePane === "agents"} className={activePane === "agents" ? "active" : ""} onClick={() => setActivePane("agents")}>Session Agents <span>{draft.agents.length}</span></button><button role="tab" aria-selected={activePane === "loop"} className={activePane === "loop" ? "active" : ""} onClick={() => setActivePane("loop")}>Loop 设置</button></div>
        {activePane === "agents" && selectedAgent && <section className="agent-loop-drawer-agents">
          <div className="agent-loop-card-picker" aria-label="选择 Session Agent 卡片">{draft.agents.map((card, index) => <button key={`${card.id}-${index}`} className={card.id === selectedAgent.id ? "active" : ""} onClick={() => setSelectedAgentId(card.id)}><Bot size={15} /><span><strong>{card.name || "未命名 Agent"}</strong><small>{card.model}</small></span></button>)}<button className="agent-loop-add-card" onClick={addCard}><Plus size={14} /> 添加</button></div>
          {selectedSplitAgent ? <div className="agent-loop-card-editor"><div className="agent-loop-card-editor-title"><div><span>编辑 Session Agent</span><strong>{selectedSplitAgent.name || "未命名 Agent"}</strong></div>{draft.agents.length > 1 && <button className="agent-loop-icon-danger" aria-label="移除当前 Session Agent" title="移除当前卡片" onClick={removeSelectedCard}><Trash2 size={15} /></button>}</div><div className="agent-loop-editor-two-columns"><label>名称<input value={selectedSplitAgent.name} onChange={(event) => updateSplitCard(selectedAgentIndex, { name: event.target.value })} /></label><label>责任类型<select value={selectedSplitAgent.kind} onChange={(event) => updateSplitCard(selectedAgentIndex, { kind: event.target.value as NativeSessionAgentCard["kind"] })}><option value="researcher">调研 / Researcher</option><option value="publisher">交付 / Publisher</option><option value="reviewer">复核 / Reviewer</option><option value="general">通用 / General</option></select></label><label>模型<ModelSelect value={selectedSplitAgent.model} modelVariant={selectedSplitAgent.modelVariant} models={modelCapabilities} onChange={(model) => updateSplitCard(selectedAgentIndex, { model, modelVariant: undefined })} onModelVariantChange={(modelVariant) => updateSplitCard(selectedAgentIndex, { modelVariant })} /></label></div><section className="agent-loop-card-prompt-section"><header><span>CONDUCTOR CONTEXT</span><strong>给 Conductor 的派发档案</strong></header><label>派发标题<input value={selectedSplitAgent.dispatchProfile.title} onChange={(event) => updateSplitCard(selectedAgentIndex, { dispatchProfile: { ...selectedSplitAgent.dispatchProfile, title: event.target.value } })} /></label><label>Conductor 何时选择这张卡<textarea rows={4} value={selectedSplitAgent.dispatchProfile.description} onChange={(event) => updateSplitCard(selectedAgentIndex, { dispatchProfile: { ...selectedSplitAgent.dispatchProfile, description: event.target.value } })} /></label><small>只进入 Conductor 的模板上下文，告诉它此卡能处理什么任务；不会成为 Worker system prompt。</small></section><section className="agent-loop-card-prompt-section"><header><span>WORKER SYSTEM</span><strong>给 Worker Session 的 System Prompt</strong></header><label>稳定工作指引<textarea rows={7} value={selectedSplitAgent.workerSystemPrompt} onChange={(event) => updateSplitCard(selectedAgentIndex, { workerSystemPrompt: event.target.value })} /></label><small>每次 Dispatch 都会以稳定 system context 传给该 Worker；本次目标、输入和验收另以普通 message 发送。</small></section><details className="agent-loop-card-capability-editor"><summary>能力限制（可选）</summary><div className="agent-loop-capability-grid"><label><span>MCP</span><input placeholder="留空 = 沿用 OpenCode Build" value={selectedSplitAgent.mcp.join(", ")} onChange={(event) => updateSplitCard(selectedAgentIndex, { mcp: splitAllowlist(event.target.value) })} /><small>{selectedSplitAgent.mcp.length ? "仅声明这些 MCP" : "不在 Template 限制能力"}</small></label><label><span>Skills</span><input placeholder="留空 = 沿用 OpenCode Build" value={selectedSplitAgent.skills.join(", ")} onChange={(event) => updateSplitCard(selectedAgentIndex, { skills: splitAllowlist(event.target.value) })} /><small>{selectedSplitAgent.skills.length ? "仅声明这些 Skills" : "不在 Template 限制能力"}</small></label></div></details></div> : <section className="agent-loop-card-editor agent-loop-legacy-editor"><strong>遗留卡片（只读）</strong><p>此 Template 版本仍使用旧版合并文本。系统不会把它猜测性拆成派发档案和 Worker prompt；请用 Template Meta Agent 生成可审阅的新版本后再保存。</p><label>旧版角色<textarea rows={4} value={legacyCardRole(selectedAgent)} readOnly /></label></section>}
        </section>}
        {activePane === "loop" && <section className="agent-loop-loop-settings"><div className="agent-loop-settings-copy"><strong>Conductor Charter</strong><p>这是 Template 唯一的编排说明：适用任务、协作方式和决策偏好都写在这里。它会固化给新 Task 的 Conductor，但不构成 Runtime 路由。</p></div><label>Conductor 模型<ModelSelect value={draft.conductor.model} modelVariant={draft.conductor.modelVariant} models={modelCapabilities} onChange={(model) => onChange({ ...draft, conductor: { ...draft.conductor, model, modelVariant: undefined } })} onModelVariantChange={(modelVariant) => onChange({ ...draft, conductor: { ...draft.conductor, modelVariant } })} /><small>保存新版本后，仅新 Task 的 Conductor 使用此模型和 Provider 已声明的强度；已有 Task 快照不会改变。</small></label><label>Conductor 如何根据任务、Session 返回与用户补充决定下一步<textarea rows={10} value={draft.conductor.charter ?? ""} onChange={(event) => onChange({ ...draft, conductor: { ...draft.conductor, charter: event.target.value } })} placeholder="例如：优先并行收集相互独立的证据；发现关键冲突时先重新派发核实；需要落地文件时，由 Conductor 按当前证据选择合适的 Session Agent。" /><small>写清模板适用任务、可用卡片如何协作以及决策偏好。不要写成固定的 Research → Review → Publish 流程；每次下一步仍由 Conductor 决定。</small></label></section>}
      </div>
      <footer className="agent-loop-drawer-footer"><button className="harness-secondary-button" onClick={onClose}>取消</button><button className="harness-primary-button" disabled={!enabled || busy || !draft.name.trim() || !draft.agents.length} onClick={onSave}>{busy ? "保存中…" : "保存新版本"}</button></footer>
    </section>
  </div>;
}

export function TaskDialog({ templates, templateVersions, title, goal, templateId, templateVersion, projectPath, projectVerified, busy, enabled, onTitle, onGoal, onTemplate, onTemplateVersion, onProjectPath, onValidateProject, onCreateProjectDirectory, onClose, onCreateTemplate, onCreateManualTemplate, onBrowseTemplateMetaAgent, onCreate }: {
  templates: NativeAgentLoopTemplate[];
  templateVersions: NativeAgentLoopTemplate[];
  title: string;
  goal: string;
  templateId: string;
  templateVersion?: number;
  projectPath: string;
  projectVerified: boolean;
  busy: boolean;
  enabled: boolean;
  onTitle: (value: string) => void;
  onGoal: (value: string) => void;
  onTemplate: (value: string) => void;
  onTemplateVersion: (value: number | undefined) => void;
  onProjectPath: (value: string) => void;
  onValidateProject: (path?: string) => void;
  onCreateProjectDirectory: (parentPath: string, name: string) => Promise<{ path: string; name: string } | undefined>;
  onClose: () => void;
  onCreateTemplate: () => void;
  onCreateManualTemplate: () => void;
  onBrowseTemplateMetaAgent: () => void;
  onCreate: () => void;
}) {
  const [projectPathFocused, setProjectPathFocused] = useState(false);
  const [projectSuggestions, setProjectSuggestions] = useState<string[]>([]);
  const [activeProjectSuggestionIndex, setActiveProjectSuggestionIndex] = useState(-1);
  const [showProjectDirectoryCreate, setShowProjectDirectoryCreate] = useState(false);
  const [newProjectParentPath, setNewProjectParentPath] = useState("");
  const [newProjectDirectoryName, setNewProjectDirectoryName] = useState("");
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

  const createProjectDirectory = async () => {
    const created = await onCreateProjectDirectory(newProjectParentPath, newProjectDirectoryName);
    if (!created) return;
    setNewProjectDirectoryName("");
    setShowProjectDirectoryCreate(false);
  };

  const selectedTemplate = templates.find((template) => template.id === templateId);
  const selectedTemplateVersion = templateVersions.find((template) =>
    template.id === templateId && template.version === templateVersion,
  );

  return <div className="agent-loop-drawer-backdrop" role="dialog" aria-modal="true" aria-label="创建 Task">
    <button className="agent-loop-drawer-scrim" aria-label="取消创建任务" onClick={onClose} />
    <section className="agent-loop-drawer agent-loop-task-drawer">
      <header className="agent-loop-drawer-header"><div><h2>创建 Task</h2><p>先明确本次 Task 的项目文件夹，再选择一个已保存的 Template 版本。创建后会固化快照；之后修改模板不会影响这个 Task。</p></div><button className="agent-loop-drawer-close" onClick={onClose} aria-label="关闭">×</button></header>
      <div className="agent-loop-drawer-scroll">
        <section className="agent-loop-drawer-basics">
          <label>任务标题<input autoFocus value={title} onChange={(event) => onTitle(event.target.value)} placeholder="例如：整理产品竞品调研" /></label>
          <label>任务目标<textarea rows={5} value={goal} onChange={(event) => onGoal(event.target.value)} placeholder="写清交付物、范围和验收标准。Conductor 会据此形成每次派发的工作契约。" /></label>
          <label>项目文件夹
            <div className="agent-loop-project-picker">
              <div className="agent-loop-project-path">
                <input
                  value={projectPath}
                  role="combobox"
                  aria-expanded={projectPathFocused && projectSuggestions.length > 0}
                  aria-controls="agent-loop-project-suggestions"
                  aria-activedescendant={activeProjectSuggestionIndex >= 0 ? `agent-loop-project-suggestion-${activeProjectSuggestionIndex}` : undefined}
                  onFocus={() => setProjectPathFocused(true)}
                  onBlur={() => setProjectPathFocused(false)}
                  onChange={(event) => { setProjectPathFocused(true); onProjectPath(event.target.value); }}
                  onKeyDown={(event) => {
                    if (event.key === "ArrowDown") { event.preventDefault(); moveProjectSuggestion(1); }
                    else if (event.key === "ArrowUp") { event.preventDefault(); moveProjectSuggestion(-1); }
                    else if (event.key === "Enter") {
                      const suggestion = projectSuggestions[activeProjectSuggestionIndex];
                      event.preventDefault();
                      if (suggestion) selectProjectSuggestion(suggestion);
                      else onValidateProject();
                    } else if (event.key === "Escape") {
                      setProjectPathFocused(false);
                      setActiveProjectSuggestionIndex(-1);
                    }
                  }}
                  placeholder="例如：/Users/name/project"
                  spellCheck={false}
                  autoComplete="off"
                />
                <button className="harness-secondary-button compact" type="button" disabled={busy || !enabled || !projectPath.trim()} onClick={() => onValidateProject()}>确定</button>
                <button className="harness-secondary-button compact" type="button" disabled={busy || !enabled} onClick={() => setShowProjectDirectoryCreate((current) => !current)} title="在已有父目录下新建项目文件夹"><FolderPlus size={14} /> 新建文件夹</button>
              </div>
              {projectPathFocused && projectSuggestions.length > 0 ? <div className="agent-loop-project-suggestions" id="agent-loop-project-suggestions" role="listbox" aria-label="项目文件夹匹配">
                <span>匹配的本地文件夹</span>
                {projectSuggestions.map((suggestion, index) => <button key={suggestion} id={`agent-loop-project-suggestion-${index}`} className={index === activeProjectSuggestionIndex ? "active" : ""} type="button" role="option" aria-selected={index === activeProjectSuggestionIndex} onMouseDown={(event) => event.preventDefault()} onClick={() => selectProjectSuggestion(suggestion)}>{suggestion}</button>)}
              </div> : null}
            </div>
            <small>{projectVerified ? "目录已由本地 Host 验证。原生 Session、相对产物路径及 `.agent-workspace/runtime` 都以此为准。" : "请显式选择本次 Task 的项目文件夹，不会默认使用当前 Agent Workspace。输入路径时会匹配本地文件夹；也可新建一个直接子文件夹。"}</small>
          </label>
          {showProjectDirectoryCreate ? <section className="agent-loop-project-create" aria-label="新建项目文件夹">
            <strong>新建项目文件夹</strong>
            <p>只会在一个已存在的父目录下创建一层新目录；不会覆盖已有文件或目录。</p>
            <label>父目录<input value={newProjectParentPath} onChange={(event) => setNewProjectParentPath(event.target.value)} placeholder="例如：/Users/name/Desktop/tempreport" spellCheck={false} autoComplete="off" /></label>
            <label>文件夹名称<input value={newProjectDirectoryName} onChange={(event) => setNewProjectDirectoryName(event.target.value)} placeholder="例如：storage-industry-e2e" spellCheck={false} autoComplete="off" /></label>
            <div className="agent-loop-project-create-actions"><button className="harness-secondary-button compact" type="button" disabled={busy} onClick={() => setShowProjectDirectoryCreate(false)}>取消</button><button className="harness-primary-button compact" type="button" disabled={busy || !enabled || !newProjectParentPath.trim() || !newProjectDirectoryName.trim()} onClick={() => void createProjectDirectory()}><FolderPlus size={14} /> 创建并选用</button></div>
          </section> : null}
        </section>
        <section className="agent-loop-task-template-choice">
          <div><strong>选择协作模板</strong><p>模板保存 Conductor Charter 与 Session Agent 的稳定能力，不包含本次任务的固定路线。</p></div>
          <label>Agent Loop Template
            <select value={templateId} onChange={(event) => onTemplate(event.target.value)}>
              <option value="">请选择一个已保存的 Template</option>
              {templates.map((template) => <option value={template.id} key={template.id}>{template.name} · 当前 v{template.version}</option>)}
            </select>
          </label>
          {templateId ? <div className="agent-loop-task-template-version">
            <label>Template 版本
              <select aria-label="Template 版本" value={templateVersion ?? ""} disabled={!templateVersions.length} onChange={(event) => onTemplateVersion(event.target.value ? Number(event.target.value) : undefined)}>
                <option value="">{templateVersions.length ? "请选择版本" : "正在读取版本…"}</option>
                {templateVersions.map((template, index) => <option value={template.version} key={`${template.id}-v${template.version}`}>v{template.version}{index === 0 ? " · 当前" : " · 历史"}</option>)}
              </select>
            </label>
          </div> : null}
          {!templateId ? <div className="agent-loop-task-template-alternative">
            <span>{templates.length ? "还没有选择模板" : "还没有已保存模板"}</span>
            <div className="agent-loop-task-template-actions">
              <button className="harness-secondary-button compact" disabled={busy || !enabled || !goal.trim() || !projectVerified} title={projectVerified ? undefined : "请先验证项目文件夹"} onClick={onCreateTemplate}><Bot size={14} /> 让 Meta Agent 起草</button>
              <button className="harness-secondary-button compact" disabled={busy || !enabled} onClick={onCreateManualTemplate}><Pencil size={14} /> 手工起草</button>
              {templates.length ? <button className="harness-secondary-button compact" disabled={busy || !enabled || !projectVerified} title={projectVerified ? undefined : "请先验证项目文件夹"} onClick={onBrowseTemplateMetaAgent}><Layers2 size={14} /> 查看 / 修改已有模板</button> : null}
            </div>
            <small>AI 起草会保留标题、目标和项目目录，并在 Template Meta Agent 中提供一份可编辑、未发送的输入草稿。它不会自动发送、保存 Template 或创建 Task。</small>
          </div> : <div className="agent-loop-task-template-selection">
            <strong>已选择 {selectedTemplate?.name ?? "Template"}{selectedTemplateVersion ? ` · v${selectedTemplateVersion.version}` : ""}</strong>
            <small>{selectedTemplateVersion ? "这个精确的已保存版本会作为本次 Task 的不可变架构快照。" : "请等待版本列表加载完成，再明确选择要固化的版本。"}</small>
            {selectedTemplateVersion ? <button className="harness-secondary-button compact" type="button" disabled={busy || !enabled || !projectVerified} onClick={onBrowseTemplateMetaAgent}><Bot size={14} /> 用 AI 修订这个版本</button> : null}
          </div>}
        </section>
        <section className="agent-loop-task-snapshot-note"><strong>创建后会发生什么</strong><p>Task 会保存当前 Template 的版本快照。启动后，只有 Conductor 可以异步派发原生 OpenCode Session Agent；每个 Session 的结果、失败或需要输入才会唤醒 Conductor。</p></section>
      </div>
      <footer className="agent-loop-drawer-footer"><button className="harness-secondary-button" disabled={busy} onClick={onClose}>取消</button><button className="harness-primary-button" disabled={!enabled || busy || !title.trim() || !goal.trim() || !templateId || !templateVersion || !projectVerified} onClick={onCreate}>{busy ? "创建中…" : "创建 Task"}</button></footer>
    </section>
  </div>;
}

function ArtifactDialog({ artifact, onClose }: { artifact: NativeAgentLoopArtifact; onClose: () => void }) {
  return <div className="harness-modal-backdrop" role="dialog" aria-modal="true" aria-label="产物预览"><section className="harness-modal agent-loop-artifact-modal"><header><div><span>DELIVERY ARTIFACT</span><h2>{artifact.path}</h2></div><button onClick={onClose} aria-label="关闭">×</button></header><div className="harness-modal-content agent-loop-artifact-content">{artifact.contentType === "markdown" ? <div className="harness-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]}>{artifact.content ?? ""}</ReactMarkdown></div> : artifact.contentType === "html" ? <iframe title={artifact.path} sandbox="" srcDoc={artifact.content ?? ""} /> : <pre>{artifact.content ?? ""}</pre>}</div><footer><span>{artifact.size ? `${artifact.size} bytes` : ""}</span><button className="harness-primary-button" onClick={onClose}>关闭</button></footer></section></div>;
}

function legacyCardRole(card: unknown) {
  return isRecord(card) && typeof card.role === "string" ? card.role : "";
}

function compactModelName(model: unknown) {
  return displayText(model, "未声明模型").replace(/^opencode-go\//, "");
}

function AgentCard({ card, selected, onSelect }: { card: NativeSessionAgentCard; selected: boolean; onSelect: () => void }) {
  const split = isNativePromptSplitSessionAgentCard(card);
  const profileTitle = split ? displayText(card.dispatchProfile.title, "未命名派发能力") : legacyCardRole(card);
  return <button className={`agent-loop-agent-card ${selected ? "selected" : ""} ${split ? "" : "legacy"}`} type="button" aria-pressed={selected} onClick={onSelect}>
    <span className="agent-loop-agent-card-head"><Bot size={16} /><span><strong>{displayText(card.name, "未命名 Session Agent")}</strong><small>{displayText(card.id, "未声明")} · {agentKindLabel(card.kind)}</small></span><ChevronRight size={16} /></span>
    <span className="agent-loop-agent-card-profile">{profileTitle || (split ? "未命名派发能力" : "遗留的合并配置")}</span>
    <span className="agent-loop-agent-card-foot"><span>{compactModelName(card.model)}</span>{split ? null : <em>Legacy</em>}</span>
  </button>;
}
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
    if (event.type === "task.resumed") {
      items.push({
        id: `event-${event.sequence}`,
        kind: "runtime",
        title: "已拉回同一 Task Run",
        detail: "Runtime 已验证原 Conductor Provider Session；Task 和 Run 已恢复为运行中，没有创建新的 Session。",
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
function allowlistLabel(value: unknown) { const allowed = Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())) : []; return allowed.length ? allowed.join(", ") : "全部允许"; }
function agentKindLabel(kind: unknown) { return ({ researcher: "调研", publisher: "交付", reviewer: "复核", general: "通用" } as Record<string, string>)[typeof kind === "string" ? kind : ""] ?? "未声明"; }
function displayText(value: unknown, fallback: string) { return typeof value === "string" && value.trim() ? value : fallback; }
function displayRevision(value: unknown) { return typeof value === "number" && Number.isFinite(value) ? String(value) : "?"; }
function templateAgentCards(template: NativeAgentLoopTemplate) { return Array.isArray(template.agents) ? template.agents.filter((card): card is NativeSessionAgentCard => isRecord(card)) : []; }
function templateConductor(template: NativeAgentLoopTemplate) { return isRecord(template.conductor) ? template.conductor : undefined; }
function templateConductorModel(template: NativeAgentLoopTemplate) { return compactModelName(templateConductor(template)?.model); }
function templateConductorCharter(template: NativeAgentLoopTemplate) { return displayText(templateConductor(template)?.charter, "决定每次下一步派发；把 Session Agent 当作可选能力，而不是固定路线。"); }
function sessionDispatchLabel(status: string) { return ({ queued: "已排队", input_accepted: "输入已接收", delivered: "Provider 已接收", result_available: "结果可用", provider_failed: "Provider 失败", failed: "派发失败", not_dispatched: "未派发", running: "运行中", succeeded: "结果可用" } as Record<string, string>)[status] ?? status; }
function shortSession(value: string) { const parts = value.split(":"); return parts[parts.length - 1] ?? value; }
function projectNameFromPath(value: string) { const normalized = value.replace(/[\\/]+$/, ""); return normalized.split(/[\\/]/).pop() || "local"; }
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function stringField(value: Record<string, unknown>, key: string) { return typeof value[key] === "string" ? value[key] : ""; }
function messageFor(reason: unknown) {
  const message = reason instanceof Error ? reason.message : String(reason);
  if (message.includes("loop_achieved_conductor_host_unavailable")) {
    return "OpenCode Host 暂时不可用；原 Conductor Session 未被判定丢失。Task 已保留在完成历史，可稍后再次拉回继续。";
  }
  if (message.includes("loop_achieved_conductor_session_missing")) {
    return "原 Conductor Session 已无法在 OpenCode 中找到。Task 历史和产物仍保留，但不会创建替代 Session。";
  }
  if (message.includes("loop_achieved_conductor_session_unavailable")) {
    return "暂时无法核验原 Conductor Session；Task 已保留在完成历史，未创建替代 Session。请稍后再次拉回继续。";
  }
  return message;
}

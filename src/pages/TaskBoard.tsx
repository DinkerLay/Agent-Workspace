import {
  Copy,
  Inbox,
  Play,
  Plus,
  Sparkles,
  SquareTerminal,
  Trash2,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { PtyTerminal } from "../components/PtyTerminal";
import { getActiveRunForTask, getLoopForTask, getRunIdForTask } from "../lib/taskMachine";
import {
  defaultOpencodeRunModel,
  type NativePtySession,
  type NativeRuntimeStatus,
  type NativeTaskDraft,
  type NativeTaskDraftInput,
  type NativeTaskDraftResult,
} from "../runtime/nativeBridge";
import {
  createDefaultTaskSessionPlanFromTemplate,
  createOpencodeSessionKey,
  createTaskAgentsFromSessionPlan,
  getProjectRuntimeId,
  getTaskRuntimeId,
  getOpencodeTaskTemplate,
  normalizeTaskSessionPlan,
  opencodeTaskTemplates,
} from "../runtime/opencode";
import { buildConductorSystemPrompt } from "../orchestration/conductor-tools/conductorPrompt";
import type {
  Agent,
  AgentCluster,
  AgentRun,
  Project,
  Task,
  TaskIntakeEvent,
  TaskIntakeSource,
  TaskSessionPlan,
  TaskSessionPlanSession,
  TaskStatus,
  TaskTransitionEvent,
} from "../types";
import { StatusPill, laneTitle } from "../components/common";

type LoopStage = {
  label: string;
  state: string;
  detail: string;
  icon: LucideIcon;
};

type TaskIntakeInput = {
  title: string;
  summary: string;
  labels: string[];
  intakeSource: TaskIntakeSource;
  owner: string;
  templateId: string;
  model: string;
  artifactPath?: string;
  sessionPlan: TaskSessionPlan;
};

type RuntimeProjectInput = {
  projectPath: string;
  projectName: string;
};

type TaskIntakeDraft = {
  title: string;
  summary: string;
  labelsText: string;
  templateId: string;
  model: string;
  artifactPath: string;
  sessionPlanText: string;
};

type ConductorRuntimePreview = {
  sessionId: string;
  sessionName: string;
  sessionRole: string;
  prompt: string;
  tools: string[];
  workerSessions: Array<{ id: string; name: string; role: string }>;
  sessionPlan: TaskSessionPlan;
};

type TaskBoardProps = {
  agents: Agent[];
  agentClusters: AgentCluster[];
  tasks: Task[];
  runs: AgentRun[];
  selectedProject: Project;
  selectedAgentCluster: AgentCluster;
  selectedAgent?: Agent;
  selectedTask?: Task;
  selectedTaskId: string;
  taskIntakeEvents?: TaskIntakeEvent[];
  taskTransitionEvents: TaskTransitionEvent[];
  loopStages: LoopStage[];
  nativeRuntimeStatus: NativeRuntimeStatus;
  nativePtySession?: NativePtySession;
  agentLaunchCommand: string;
  onGenerateTaskDraft?: (input: NativeTaskDraftInput) => Promise<NativeTaskDraftResult>;
  onCreateTaskFromIntake?: (input: TaskIntakeInput) => void;
  onOpenRuntimeProject?: (input: RuntimeProjectInput) => void;
  onSelectTask: (taskId: string) => void;
  onAdvance: (taskId: string) => void;
  onStartAgent?: (taskId: string) => void;
  onOpenLoops: () => void;
  onStartConductorPty?: () => void;
  onRefreshConductorPty?: () => void;
  onWriteConductorPtyData?: (data: string) => void;
  onResizeConductorPty?: (cols: number, rows: number) => void;
  onOpenAgentTerminal?: (agentId: string) => void;
};

const filters: Array<{ id: "all" | "running" | "waiting" | "review" | "queued"; label: string }> = [
  { id: "all", label: "全部" },
  { id: "running", label: "运行中" },
  { id: "waiting", label: "等待我处理" },
  { id: "review", label: "Review" },
  { id: "queued", label: "Queued" },
];

export function TaskBoard({
  agents,
  tasks,
  runs,
  selectedProject,
  selectedAgentCluster,
  selectedAgent,
  selectedTask,
  selectedTaskId,
  taskIntakeEvents = [],
  taskTransitionEvents,
  loopStages,
  nativeRuntimeStatus,
  nativePtySession,
  agentLaunchCommand,
  onGenerateTaskDraft = async () => ({
    ok: false,
    assistantMessage: "Task Draft Assistant 未配置。",
    missingFields: [],
    assumptions: [],
    error: "Task Draft Assistant is not configured.",
  }),
  onCreateTaskFromIntake = () => undefined,
  onOpenRuntimeProject = () => undefined,
  onSelectTask,
  onAdvance,
  onStartAgent = () => undefined,
  onOpenLoops,
  onStartConductorPty = () => undefined,
  onRefreshConductorPty = () => undefined,
  onWriteConductorPtyData = () => undefined,
  onResizeConductorPty = () => undefined,
  onOpenAgentTerminal = () => undefined,
}: TaskBoardProps) {
  const [filter, setFilter] = useState<(typeof filters)[number]["id"]>("all");
  const [taskIntakeDraft, setTaskIntakeDraft] = useState<TaskIntakeDraft>(() => createDefaultTaskIntakeDraft());
  const visibleTasks = tasks.filter((task) => taskMatchesFilter(task, filter));
  const counts = countTasks(tasks);
  const activeLoopCount = tasks.filter((task) => task.status === "running" || task.status === "waiting-input").length;
  const conductorAgent = useMemo(
    () => (selectedTask ? getConductorAgent(agents, selectedAgentCluster, selectedTask, selectedAgent) : selectedAgent),
    [agents, selectedAgentCluster, selectedAgent, selectedTask],
  );
  const workerAgents = useMemo(
    () =>
      conductorAgent && selectedTask
        ? agents.filter((agent) => selectedAgentCluster.agentIds.includes(agent.id) && agent.id !== conductorAgent.id)
            .filter((agent) => agentBelongsToTask(agent, selectedTask))
        : [],
    [agents, conductorAgent, selectedAgentCluster.agentIds, selectedTask],
  );
  const conductorRuns = conductorAgent ? runs.filter((run) => run.agentId === conductorAgent.id) : runs;
  const selectedRun = selectedTask ? getActiveRunForTask(conductorRuns, selectedTask.id) : undefined;
  const transcriptLines = getConductorTranscript(nativePtySession, selectedRun);
  const selectedTaskEvents = selectedTask
    ? taskTransitionEvents.filter((event) => event.taskId === selectedTask.id).slice(-4).reverse()
    : [];
  const canStartConductor = nativeRuntimeStatus.available && nativeRuntimeStatus.ptyAvailable !== false;
  const conductorPtyRunning = nativePtySession?.status === "running" || nativePtySession?.status === "stopping";

  const applyTaskDraftResult = (result: NativeTaskDraftResult) => {
    const nextDraft = result.draft ?? result.draftPatch;
    const nextSessionPlan = result.sessionPlan ?? result.sessionPlanPatch ?? nextDraft?.sessionPlan;
    if (!nextDraft && !nextSessionPlan) return;
    setTaskIntakeDraft((currentDraft) =>
      mergeTaskIntakeDraft(currentDraft, nextDraft, nextSessionPlan),
    );
    if (nextDraft?.projectPath) {
      onOpenRuntimeProject({
        projectPath: nextDraft.projectPath,
        projectName: nextDraft.projectName?.trim() || basename(nextDraft.projectPath) || selectedProject.name,
      });
    }
  };

  const generateTaskDraft = async (message: string) => {
    const result = await onGenerateTaskDraft({
      message,
      projectPath: selectedProject.path,
      projectName: selectedProject.name,
      model: taskIntakeDraft.model,
      currentDraft: hasTaskIntakeDraftContent(taskIntakeDraft)
        ? toNativeTaskDraft(taskIntakeDraft, selectedProject)
        : undefined,
    });
    applyTaskDraftResult(result);
    return result;
  };

  if (!selectedTask || !conductorAgent) {
    return (
      <section className="task-home-layout" aria-label="Task Home">
        <aside className="task-home-sidebar panel">
          <ProjectControl
            activeLoopCount={activeLoopCount}
            onOpenRuntimeProject={onOpenRuntimeProject}
            selectedProject={selectedProject}
          />
          <div className="task-home-filter-row" aria-label="Task filters">
            {filters.map((item) => (
              <button
                className={filter === item.id ? "filter-button active" : "filter-button"}
                key={item.id}
                type="button"
                onClick={() => setFilter(item.id)}
              >
                {item.label} {counts[item.id]}
              </button>
            ))}
          </div>
          <div className="task-home-task-list" aria-label="Tasks">
            <span className="muted-text">还没有任务</span>
          </div>
        </aside>

        <section className="task-home-main">
          <article className="panel task-home-hero">
            <div>
              <h2>还没有任务</h2>
              <p>创建任务后会启动 Conductor，并把任务上下文写入真实 terminal。</p>
            </div>
          </article>
          <div className="task-home-create-grid">
            <TaskDraftAssistantPanel
              currentDraft={toNativeTaskDraft(taskIntakeDraft, selectedProject)}
              model={taskIntakeDraft.model}
              onGenerateTaskDraft={generateTaskDraft}
              onModelChange={(model) => setTaskIntakeDraft((currentDraft) => ({ ...currentDraft, model }))}
            />
            <TaskIntakePanel
              draft={taskIntakeDraft}
              selectedProject={selectedProject}
              taskIntakeEvents={taskIntakeEvents}
              onCreateTaskFromIntake={onCreateTaskFromIntake}
              onDraftChange={setTaskIntakeDraft}
            />
          </div>
        </section>
      </section>
    );
  }

  return (
    <section className="task-home-layout" aria-label="Task Home">
      <aside className="task-home-sidebar panel">
        <ProjectControl
          activeLoopCount={activeLoopCount}
          onOpenRuntimeProject={onOpenRuntimeProject}
          selectedProject={selectedProject}
        />
        <div className="task-home-filter-row" aria-label="Task filters">
          {filters.map((item) => (
            <button
              className={filter === item.id ? "filter-button active" : "filter-button"}
              key={item.id}
              type="button"
              onClick={() => setFilter(item.id)}
            >
              {item.label} {counts[item.id]}
            </button>
          ))}
        </div>
        <div className="task-home-task-list" aria-label="Tasks">
          {visibleTasks.map((task) => (
            <button
              className={[
                "task-home-task-card",
                selectedTaskId === task.id ? "active" : "",
                taskStateClass(task.status),
              ].join(" ")}
              key={task.id}
              type="button"
              onClick={() => onSelectTask(task.id)}
            >
              <strong>{task.title}</strong>
              <span>
                {task.source} · {getLoopForTask(task)}
              </span>
              <div>
                <StatusPill status={task.status} />
                <code>{getRunIdForTask(task, runs)}</code>
              </div>
            </button>
          ))}
        </div>
      </aside>

      <section className="task-home-main">
        <article className="panel task-home-hero">
          <div>
            <div className="task-home-kicker">
              <StatusPill status={selectedTask.status} />
              <span>{getLoopForTask(selectedTask)}</span>
              <span>{selectedTask.owner}</span>
            </div>
            <h2>任务主页</h2>
            <h3>{selectedTask.title}</h3>
            <p>{selectedTask.summary}</p>
            <div className="task-home-chip-row">
              <span>{selectedTask.source}</span>
              <span>{selectedTask.verification}</span>
              {selectedTask.labels?.map((label) => <span key={label}>{label}</span>)}
            </div>
          </div>
        </article>

        <section className="panel task-home-conductor">
          <div className="task-home-conductor-head">
            <div>
              <span className="eyebrow">Task Conductor</span>
              <h2>Conductor Terminal</h2>
              <p>{conductorAgent.name} · {conductorAgent.role} · {selectedTask.title}</p>
            </div>
            <StatusPill status={nativePtySession?.status ?? selectedTask.status} />
          </div>
          <div className="conductor-terminal-shell">
            <div className="conductor-terminal-toolbar">
              <div>
                <code>{nativePtySession ? formatNativePtyCommand(nativePtySession) : agentLaunchCommand}</code>
                <small>{nativePtySession?.id ?? "尚未绑定 PTY session"}</small>
              </div>
              <div className="conductor-terminal-actions">
                <button
                  className="primary-button"
                  disabled={!canStartConductor || conductorPtyRunning}
                  title={
                    conductorPtyRunning
                      ? "当前 Conductor PTY 已在运行；刷新或停止后再启动新的 session"
                      : canStartConductor
                        ? "启动当前任务的 Conductor PTY"
                        : nativeRuntimeStatus.message
                  }
                  type="button"
                  onClick={onStartConductorPty}
                >
                  <SquareTerminal size={16} />
                  {conductorPtyRunning ? "Conductor 运行中" : "启动 Conductor PTY"}
                </button>
                <button className="ghost-button" disabled={!nativePtySession} type="button" onClick={onRefreshConductorPty}>
                  刷新
                </button>
              </div>
            </div>
            <PtyTerminal
              ariaLabel="Conductor terminal output"
              className="conductor-terminal-screen"
              command={nativePtySession ? formatNativePtyCommand(nativePtySession) : agentLaunchCommand}
              emptyTitle="尚未启动 Conductor PTY"
              emptyDetail="启动后这里直接显示当前任务主 agent 的真实 terminal。"
              session={nativePtySession}
              transcriptLines={transcriptLines}
              waitingDetail="Conductor PTY 已启动，正在等待 opencode TUI 输出。"
              onData={onWriteConductorPtyData}
              onResize={onResizeConductorPty}
            />
          </div>
        </section>

        <div className="task-home-role-grid">
          <section className="panel task-home-workers">
            <div className="task-home-panel-head">
              <h2>Worker Agents</h2>
              <StatusPill status={`${workerAgents.length} workers`} />
            </div>
            <div className="worker-agent-grid">
              {workerAgents.map((agent) => (
                <article className={["worker-agent-card", agentCardStateClass(agent)].join(" ")} key={agent.id}>
                  <span className="agent-avatar" style={{ backgroundColor: agent.accent }}>
                    {agent.name[0]}
                  </span>
                  <div>
                    <strong>{agent.name}</strong>
                    <small>{agent.role}</small>
                    <code>{terminalIdForAgent(selectedProject, selectedAgentCluster, selectedTask, agent)}</code>
                  </div>
                  <StatusPill status={agent.status} />
                  <button className="ghost-button" type="button" onClick={() => onOpenAgentTerminal(agent.id)}>
                    terminal
                  </button>
                </article>
              ))}
            </div>
          </section>

          <section className="panel task-home-progress">
            <div className="task-home-panel-head">
              <h2>Conductor 进展</h2>
              <StatusPill status={selectedTask.status} />
            </div>
            <div className="task-home-timeline">
              {selectedTaskEvents.length ? (
                selectedTaskEvents.map((event, index) => (
                  <article className="task-home-timeline-item" key={event.id}>
                    <span>{index + 1}</span>
                    <div>
                      <strong>{event.summary}</strong>
                      <small>{event.createdAt}</small>
                      <code>{event.evidencePath}</code>
                    </div>
                    <StatusPill status={event.toStatus} />
                  </article>
                ))
              ) : (
                loopStages.map((stage, index) => (
                  <article className="task-home-timeline-item" key={stage.label}>
                    <span>{index + 1}</span>
                    <div>
                      <strong>{stage.label}</strong>
                      <small>{stage.detail}</small>
                    </div>
                    <StatusPill status={stage.state} />
                  </article>
                ))
              )}
            </div>
            <div className="task-home-action-row">
              <button className="ghost-button" type="button" onClick={() => onStartAgent(selectedTask.id)}>
                <Workflow size={16} />
                Loop 启动
              </button>
              <button className="ghost-button" type="button" onClick={onOpenLoops}>
                <Workflow size={16} />
                调度规则
              </button>
              <button className="ghost-button" type="button" onClick={() => onAdvance(selectedTask.id)}>
                <Play size={16} />
                推进状态
              </button>
            </div>
          </section>
        </div>

        <div className="task-home-create-grid">
          <TaskDraftAssistantPanel
            currentDraft={toNativeTaskDraft(taskIntakeDraft, selectedProject)}
            model={taskIntakeDraft.model}
            onGenerateTaskDraft={generateTaskDraft}
            onModelChange={(model) => setTaskIntakeDraft((currentDraft) => ({ ...currentDraft, model }))}
          />
          <TaskIntakePanel
            draft={taskIntakeDraft}
            selectedProject={selectedProject}
            taskIntakeEvents={taskIntakeEvents}
            onCreateTaskFromIntake={onCreateTaskFromIntake}
            onDraftChange={setTaskIntakeDraft}
          />
        </div>
      </section>
    </section>
  );
}

function ProjectControl({
  activeLoopCount,
  onOpenRuntimeProject,
  selectedProject,
}: {
  activeLoopCount: number;
  onOpenRuntimeProject: (input: RuntimeProjectInput) => void;
  selectedProject: Project;
}) {
  const [editing, setEditing] = useState(false);
  const [projectPath, setProjectPath] = useState(selectedProject.path);
  const [projectName, setProjectName] = useState(selectedProject.name);

  useEffect(() => {
    if (!editing) {
      setProjectPath(selectedProject.path);
      setProjectName(selectedProject.name);
    }
  }, [editing, selectedProject.name, selectedProject.path]);

  const submitProject = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const nextPath = projectPath.trim();
    if (!nextPath) return;
    onOpenRuntimeProject({
      projectPath: nextPath,
      projectName: projectName.trim() || basename(projectPath),
    });
    setEditing(false);
  };

  return (
    <div className={editing ? "task-home-project-control editing" : "task-home-project-control"}>
      <div className="task-home-sidebar-head">
        <div>
          <span className="eyebrow">Project</span>
          <strong>{selectedProject.name}</strong>
          <small title={selectedProject.path}>{selectedProject.path}</small>
        </div>
        <StatusPill status={`${activeLoopCount} active loops`} />
      </div>
      {editing ? (
        <form className="task-home-project-form" onSubmit={submitProject}>
          <label>
            <span>项目路径</span>
            <input
              aria-label="项目路径"
              value={projectPath}
              onChange={(event) => setProjectPath(event.target.value)}
              placeholder="/Users/dinker/CODES/TEMP_project/Agent_Test"
            />
          </label>
          <label>
            <span>项目名称</span>
            <input
              aria-label="项目名称"
              value={projectName}
              onChange={(event) => setProjectName(event.target.value)}
              placeholder={basename(projectPath) || "Project"}
            />
          </label>
          <div className="task-home-project-actions">
            <button className="ghost-button" type="button" onClick={() => setEditing(false)}>
              取消
            </button>
            <button className="primary-button" type="submit">
              打开项目
            </button>
          </div>
        </form>
      ) : (
        <button className="ghost-button task-home-project-open" type="button" onClick={() => setEditing(true)}>
          切换项目
        </button>
      )}
    </div>
  );
}

function TaskDraftAssistantPanel({
  currentDraft,
  model,
  onGenerateTaskDraft,
  onModelChange,
}: {
  currentDraft: NativeTaskDraft;
  model: string;
  onGenerateTaskDraft: (message: string) => Promise<NativeTaskDraftResult>;
  onModelChange: (model: string) => void;
}) {
  const [message, setMessage] = useState("");
  const [followUp, setFollowUp] = useState("");
  const [assistantMessage, setAssistantMessage] = useState("");
  const [missingFields, setMissingFields] = useState<string[]>([]);
  const [assumptions, setAssumptions] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const hasDraft = Boolean(currentDraft.title || currentDraft.summary || currentDraft.labels?.length);

  const runAssistant = async (nextMessage: string, clear: () => void) => {
    const cleanMessage = nextMessage.trim();
    if (!cleanMessage || busy) return;
    setBusy(true);
    setError("");
    try {
      const result = await onGenerateTaskDraft(cleanMessage);
      setAssistantMessage(result.assistantMessage);
      setMissingFields(result.missingFields);
      setAssumptions(result.assumptions);
      if (!result.ok) setError(result.error ?? result.assistantMessage);
      clear();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "任务配置生成失败。");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel task-draft-assistant">
      <div className="task-home-panel-head">
        <h2>AI 任务配置助手</h2>
        <StatusPill status="opencode" />
      </div>
      <label>
        <span>AI 助手模型</span>
        <input
          aria-label="AI 助手模型"
          value={model}
          onChange={(event) => onModelChange(event.target.value)}
          placeholder={defaultOpencodeRunModel}
        />
      </label>
      <label>
        <span>一句话描述任务</span>
        <textarea
          aria-label="一句话描述任务"
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          placeholder="在 /Users/... 调研 claude dynamic workflow 机制，输出报告和 spec/plan 线索。"
          rows={5}
        />
      </label>
      <button
        className="primary-button"
        disabled={busy || !message.trim()}
        type="button"
        onClick={() => void runAssistant(message, () => setMessage(""))}
      >
        <Sparkles size={16} />
        {busy ? "生成中" : "生成配置"}
      </button>
      {hasDraft ? (
        <div className="task-draft-follow-up">
          <label>
            <span>继续修改任务配置</span>
            <textarea
              aria-label="继续修改任务配置"
              value={followUp}
              onChange={(event) => setFollowUp(event.target.value)}
              placeholder="例如：输出改成 html 可视化报告；换成产品逻辑任务；多加一个 reviewer。"
              rows={3}
            />
          </label>
          <button
            className="ghost-button"
            disabled={busy || !followUp.trim()}
            type="button"
            onClick={() => void runAssistant(followUp, () => setFollowUp(""))}
          >
            修改配置
          </button>
        </div>
      ) : null}
      {assistantMessage ? <p className="task-draft-assistant-message">{assistantMessage}</p> : null}
      {missingFields.length ? (
        <div className="task-draft-note">
          <strong>需要确认</strong>
          <span>{missingFields.join("、")}</span>
        </div>
      ) : null}
      {assumptions.length ? (
        <div className="task-draft-note">
          <strong>默认假设</strong>
          <span>{assumptions.join("、")}</span>
        </div>
      ) : null}
      {error ? <p className="task-draft-error">{error}</p> : null}
    </section>
  );
}

function TaskIntakePanel({
  draft,
  selectedProject,
  taskIntakeEvents,
  onCreateTaskFromIntake,
  onDraftChange,
}: {
  draft: TaskIntakeDraft;
  selectedProject: Project;
  taskIntakeEvents: TaskIntakeEvent[];
  onCreateTaskFromIntake: (input: TaskIntakeInput) => void;
  onDraftChange: (draft: TaskIntakeDraft) => void;
}) {
  const latestIntake = taskIntakeEvents[taskIntakeEvents.length - 1];
  const updateDraft = (patch: Partial<TaskIntakeDraft>) => onDraftChange({ ...draft, ...patch });
  const runtimePreview = buildConductorRuntimePreview(draft, selectedProject);
  const parsedSessionPlan = parseSessionPlanText(draft.sessionPlanText, runtimePreview.sessionPlan);
  const updateSessionPlan = (sessionPlan: TaskSessionPlan) =>
    updateDraft({ sessionPlanText: formatTaskSessionPlan(normalizeTaskSessionPlan(sessionPlan, runtimePreview.sessionPlan)) });

  const submitTaskIntake = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const nextTitle = draft.title.trim();
    if (!nextTitle || parsedSessionPlan.error) return;
    const template = getTaskTemplate(draft.templateId);
    const labels = draft.labelsText
      .split(",")
      .map((label) => label.trim())
      .filter(Boolean);
    const nextArtifactPath = draft.artifactPath.trim();
    const nextModel = draft.model.trim() || defaultOpencodeRunModel;

    onCreateTaskFromIntake({
      title: nextTitle,
      summary: draft.summary.trim(),
      labels,
      intakeSource: template.intakeSource,
      owner: "Conductor",
      templateId: template.id,
      model: nextModel,
      artifactPath: nextArtifactPath || undefined,
      sessionPlan: parsedSessionPlan.plan,
    });
    onDraftChange(createDefaultTaskIntakeDraft());
  };

  return (
    <section className="panel task-home-intake">
      <div className="task-home-panel-head">
        <h2>新建任务</h2>
        <StatusPill status="auto-start" />
      </div>
      <form className="task-home-intake-form" onSubmit={submitTaskIntake}>
        <label>
          <span>任务标题</span>
          <input
            aria-label="任务标题"
            value={draft.title}
            onChange={(event) => updateDraft({ title: event.target.value })}
            placeholder="创建任务并启动 Conductor"
          />
        </label>
        <label>
          <span>任务目标</span>
          <textarea
            aria-label="任务目标"
            value={draft.summary}
            onChange={(event) => updateDraft({ summary: event.target.value })}
            placeholder="写清楚任务事实、目标和交付条件"
            rows={3}
          />
        </label>
        <div className="task-home-intake-row">
          <label>
            <span>起始方案</span>
            <select
              aria-label="起始方案"
              value={draft.templateId}
              onChange={(event) => {
                const template = getTaskTemplate(event.target.value);
                updateDraft({
                  templateId: template.id,
                  sessionPlanText: formatTaskSessionPlan(
                    createDefaultTaskSessionPlanFromTemplate({
                      templateId: template.id,
                      model: draft.model.trim() || defaultOpencodeRunModel,
                      taskTitle: draft.title,
                      taskGoal: draft.summary,
                    }),
                  ),
                });
              }}
            >
              {opencodeTaskTemplates.map((template) => (
                <option key={template.id} value={template.id}>
                  {template.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>Conductor 模型</span>
            <input
              aria-label="Conductor 模型"
              value={draft.model}
              onChange={(event) => {
                const model = event.target.value;
                updateDraft({
                  model,
                  sessionPlanText: retargetSessionPlanModelText(
                    draft.sessionPlanText,
                    model.trim() || defaultOpencodeRunModel,
                    draft,
                  ),
                });
              }}
              placeholder={defaultOpencodeRunModel}
            />
          </label>
        </div>
        <div className="task-home-intake-row">
          <label>
            <span>标签</span>
            <input
              aria-label="任务标签"
              value={draft.labelsText}
              onChange={(event) => updateDraft({ labelsText: event.target.value })}
              placeholder="plan, pty"
            />
          </label>
          <label>
            <span>附件路径</span>
            <input
              aria-label="附件路径"
              value={draft.artifactPath}
              onChange={(event) => updateDraft({ artifactPath: event.target.value })}
              placeholder=".agent-workspace/tasks/context.json"
            />
          </label>
        </div>
        <SessionAgentPlanEditor
          plan={parsedSessionPlan.plan}
          rawText={draft.sessionPlanText}
          error={parsedSessionPlan.error}
          fallbackPlan={runtimePreview.sessionPlan}
          onPlanChange={updateSessionPlan}
          onRawTextChange={(sessionPlanText) => updateDraft({ sessionPlanText })}
        />
        <button className="primary-button" type="submit">
          <Inbox size={16} />
          创建并启动
        </button>
      </form>
      <div className="task-home-system-prompts" aria-label="Conductor runtime preview">
        <div className="task-home-panel-head">
          <h3>Conductor Runtime 预览</h3>
          <StatusPill status="MCP tools" />
        </div>
        <div className="system-prompt-preview-list">
          <details className="system-prompt-preview-card" open>
            <summary>
              <span>
                <strong>{runtimePreview.sessionName}</strong>
                <small>{runtimePreview.sessionRole}</small>
              </span>
              <StatusPill status="Conductor only" />
            </summary>
            <pre>{runtimePreview.prompt}</pre>
          </details>
          <div className="system-prompt-preview-card conductor-tool-preview">
            <strong>MCP tools</strong>
            <div className="conductor-tool-list">
              {runtimePreview.tools.map((tool) => (
                <code key={tool}>{tool}</code>
              ))}
            </div>
          </div>
          <div className="system-prompt-preview-card native-worker-preview">
            <strong>Worker sessions</strong>
            <span>原生 session，不注入 Agent Workspace 协议</span>
            <div className="native-worker-list">
              {runtimePreview.workerSessions.map((session) => (
                <span key={session.id}>
                  {session.name} · {session.role}
                </span>
              ))}
            </div>
          </div>
        </div>
      </div>
      {latestIntake ? (
        <div className="task-home-latest-intake">
          <strong>{latestIntake.id}</strong>
          <span>{latestIntake.title}</span>
          <code>{latestIntake.evidencePath}</code>
        </div>
      ) : null}
    </section>
  );
}

function SessionAgentPlanEditor({
  plan,
  rawText,
  error,
  fallbackPlan,
  onPlanChange,
  onRawTextChange,
}: {
  plan: TaskSessionPlan;
  rawText: string;
  error?: string;
  fallbackPlan: TaskSessionPlan;
  onPlanChange: (plan: TaskSessionPlan) => void;
  onRawTextChange: (text: string) => void;
}) {
  const updateConductor = (patch: Partial<TaskSessionPlanSession>) => {
    onPlanChange(syncSessionPlanTargets({ ...plan, conductor: { ...plan.conductor, ...patch } }));
  };
  const updateWorker = (index: number, patch: Partial<TaskSessionPlanSession>) => {
    const workers = plan.workers.map((worker, workerIndex) =>
      workerIndex === index ? { ...worker, ...patch } : worker,
    );
    onPlanChange(syncSessionPlanTargets({ ...plan, workers }));
  };
  const addWorker = () => {
    const nextIndex = plan.workers.length + 1;
    const model = plan.defaultModel || plan.conductor.model || defaultOpencodeRunModel;
    const nextWorker: TaskSessionPlanSession = {
      idSeed: `worker-${nextIndex}`,
      name: `Worker ${nextIndex}`,
      role: "Custom worker",
      provider: plan.conductor.provider || "opencode",
      model,
      accent: "#2563eb",
      instructions: "按 Conductor 派发的任务执行，产出明确结果。",
      expectedOutput: "任务结果和证据路径。",
    };
    onPlanChange(syncSessionPlanTargets({ ...plan, workers: [...plan.workers, nextWorker] }));
  };
  const removeWorker = (index: number) => {
    const workers = plan.workers.filter((_, workerIndex) => workerIndex !== index);
    onPlanChange(syncSessionPlanTargets({ ...plan, workers }));
  };
  const duplicateWorker = (index: number) => {
    const source = plan.workers[index];
    if (!source) return;
    const nextIndex = plan.workers.length + 1;
    const nextWorker: TaskSessionPlanSession = {
      ...source,
      idSeed: `${source.idSeed || source.name.toLowerCase().replace(/\s+/g, "-") || "worker"}-${nextIndex}`,
      name: `${source.name || "Worker"} Copy`,
    };
    onPlanChange(syncSessionPlanTargets({ ...plan, workers: [...plan.workers, nextWorker] }));
  };
  const updateWorkflow = (workflowText: string) => {
    const workflow = workflowText
      .split("\n")
      .map((step) => step.trim())
      .filter(Boolean);
    onPlanChange({ ...plan, workflow });
  };

  return (
    <section className="session-plan-editor" aria-label="Session Agent 编排">
      <div className="task-home-panel-head">
        <h3>Session Agent 编排</h3>
        <StatusPill status={`${plan.workers.length} workers`} />
      </div>
      <SessionPlanCard
        kind="conductor"
        session={plan.conductor}
        sessionLabel="Conductor"
        badge="task owner"
        onChange={updateConductor}
      />
      <div className="session-plan-worker-head">
        <strong>Worker sessions</strong>
        <button className="ghost-button" type="button" onClick={addWorker}>
          <Plus size={15} />
          添加 worker session
        </button>
      </div>
      <div className="session-plan-card-grid">
        {plan.workers.map((worker, index) => (
          <SessionPlanCard
            key={`${worker.idSeed ?? worker.name}-${index}`}
            kind="worker"
            index={index}
            session={worker}
            sessionLabel={`Worker ${index + 1}`}
            badge="worker"
            canRemove={plan.workers.length > 1}
            onChange={(patch) => updateWorker(index, patch)}
            onDuplicate={() => duplicateWorker(index)}
            onRemove={() => removeWorker(index)}
          />
        ))}
      </div>
      <details className="session-plan-workflow" open>
        <summary>
          <strong>Conductor 编排提示</strong>
          <span>{plan.workflow?.length ?? 0} steps</span>
        </summary>
        <textarea
          aria-label="Conductor 编排提示"
          value={(plan.workflow ?? []).join("\n")}
          onChange={(event) => updateWorkflow(event.target.value)}
          rows={Math.max(3, Math.min(7, plan.workflow?.length ?? 3))}
        />
      </details>
      <details className="session-plan-json-details">
        <summary>
          <strong>高级：原始 JSON</strong>
          <span>导入 / 排错</span>
        </summary>
        <textarea
          aria-label="Session Agent Plan JSON"
          value={rawText}
          onChange={(event) => onRawTextChange(event.target.value)}
          rows={8}
        />
        {error ? <p className="task-draft-error">{error}</p> : null}
        {error ? (
          <button className="ghost-button" type="button" onClick={() => onPlanChange(fallbackPlan)}>
            恢复当前默认编排
          </button>
        ) : null}
      </details>
    </section>
  );
}

function SessionPlanCard({
  kind,
  index,
  session,
  sessionLabel,
  badge,
  canRemove,
  onChange,
  onDuplicate,
  onRemove,
}: {
  kind: "conductor" | "worker";
  index?: number;
  session: TaskSessionPlanSession;
  sessionLabel: string;
  badge: string;
  canRemove?: boolean;
  onChange: (patch: Partial<TaskSessionPlanSession>) => void;
  onDuplicate?: () => void;
  onRemove?: () => void;
}) {
  const accessibleName = `${session.name || sessionLabel} session 卡片`;
  const fieldLabel = kind === "conductor" ? `${sessionLabel} session` : sessionLabel;

  return (
    <article className={`session-plan-card session-plan-card-${kind}`} aria-label={accessibleName}>
      <div className="session-plan-card-title">
        <span className="session-plan-avatar">{session.name.trim().charAt(0).toUpperCase() || "S"}</span>
        <div>
          <strong>{session.name || sessionLabel}</strong>
          <small>{session.role || "未设置职责"}</small>
        </div>
        <StatusPill status={badge} />
      </div>
      <div className="session-plan-card-fields">
        <label>
          <span>名称</span>
          <input
            aria-label={`${fieldLabel} 名称`}
            value={session.name}
            onChange={(event) => onChange({ name: event.target.value })}
          />
        </label>
        <label>
          <span>职责</span>
          <input
            aria-label={`${fieldLabel} 职责`}
            value={session.role}
            onChange={(event) => onChange({ role: event.target.value })}
          />
        </label>
        <label>
          <span>Provider</span>
          <input
            aria-label={`${fieldLabel} Provider`}
            value={session.provider ?? "opencode"}
            onChange={(event) => onChange({ provider: event.target.value })}
          />
        </label>
        <label>
          <span>模型</span>
          <input
            aria-label={`${fieldLabel} 模型`}
            value={session.model ?? ""}
            onChange={(event) => onChange({ model: event.target.value })}
          />
        </label>
      </div>
      <label>
        <span>工作说明</span>
        <textarea
          aria-label={`${fieldLabel} 工作说明`}
          value={session.instructions ?? ""}
          onChange={(event) => onChange({ instructions: event.target.value })}
          rows={3}
        />
      </label>
      <label>
        <span>交付物</span>
        <input
          aria-label={`${fieldLabel} 交付物`}
          value={session.expectedOutput ?? ""}
          onChange={(event) => onChange({ expectedOutput: event.target.value })}
        />
      </label>
      {kind === "worker" ? (
        <div className="session-plan-card-actions">
          <code>{session.idSeed ?? `worker-${(index ?? 0) + 1}`}</code>
          <button className="ghost-button" type="button" onClick={onDuplicate}>
            <Copy size={14} />
            复制
          </button>
          {canRemove ? (
            <button className="ghost-button" type="button" onClick={onRemove}>
              <Trash2 size={14} />
              移除
            </button>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

function getConductorAgent(
  agents: Agent[],
  cluster: AgentCluster,
  task: Task,
  selectedAgent?: Agent,
) {
  const scopedAgents = agents.filter((agent) => cluster.agentIds.includes(agent.id));
  return (
    scopedAgents.find((agent) => agentBelongsToTask(agent, task) && agent.name === task.owner) ??
    (selectedAgent && agentBelongsToTask(selectedAgent, task) ? selectedAgent : undefined)
  );
}

function createDefaultTaskIntakeDraft(): TaskIntakeDraft {
  return {
    title: "",
    summary: "",
    labelsText: "",
    templateId: opencodeTaskTemplates[0].id,
    model: defaultOpencodeRunModel,
    artifactPath: "",
    sessionPlanText: formatTaskSessionPlan(
      createDefaultTaskSessionPlanFromTemplate({
        templateId: opencodeTaskTemplates[0].id,
        model: defaultOpencodeRunModel,
      }),
    ),
  };
}

function mergeTaskIntakeDraft(
  current: TaskIntakeDraft,
  draft: NativeTaskDraft | undefined,
  sessionPlan: TaskSessionPlan | undefined,
): TaskIntakeDraft {
  return {
    title: draft?.title ?? current.title,
    summary: draft?.summary ?? current.summary,
    labelsText: draft?.labels ? draft.labels.join(", ") : current.labelsText,
    templateId: draft?.templateId ? getTaskTemplate(draft.templateId).id : current.templateId,
    model: draft?.model ?? current.model,
    artifactPath: draft?.artifactPath ?? current.artifactPath,
    sessionPlanText: sessionPlan
      ? formatTaskSessionPlan(sessionPlan)
      : draft?.sessionPlan
        ? formatTaskSessionPlan(draft.sessionPlan)
        : current.sessionPlanText,
  };
}

function toNativeTaskDraft(draft: TaskIntakeDraft, selectedProject: Project): NativeTaskDraft {
  return {
    projectPath: selectedProject.path,
    projectName: selectedProject.name,
    title: draft.title,
    summary: draft.summary,
    templateId: draft.templateId,
    model: draft.model,
    labels: draft.labelsText
      .split(",")
      .map((label) => label.trim())
      .filter(Boolean),
    artifactPath: draft.artifactPath,
    sessionPlan: parseSessionPlanText(draft.sessionPlanText).plan,
  };
}

function buildConductorRuntimePreview(draft: TaskIntakeDraft, selectedProject: Project): ConductorRuntimePreview {
  const template = getTaskTemplate(draft.templateId);
  const taskId = "task-draft-preview";
  const fallbackPlan = createDefaultTaskSessionPlanFromTemplate({
    templateId: template.id,
    model: draft.model.trim() || defaultOpencodeRunModel,
    taskTitle: draft.title,
    taskGoal: draft.summary,
  });
  const sessionPlan = parseSessionPlanText(draft.sessionPlanText, fallbackPlan).plan;
  const agents = createTaskAgentsFromSessionPlan({
    templateId: template.id,
    projectId: selectedProject.id,
    taskId,
    clusterId: "task-draft-preview-cluster",
    model: draft.model.trim() || defaultOpencodeRunModel,
    sessionPlan,
  });
  const conductorAgent = agents.find((agent) => agent.name === "Conductor") ?? agents[0];
  const workerSessions = agents
    .filter((agent) => agent.id !== conductorAgent.id)
    .map((agent) => ({
      id: createOpencodeSessionKey({
        projectId: getProjectRuntimeId(selectedProject),
        taskId,
        agentId: agent.id,
      }),
      name: agent.name,
      role: agent.role,
    }));

  return {
    sessionId: conductorAgent.id,
    sessionName: conductorAgent.name,
    sessionRole: conductorAgent.role,
    prompt: buildConductorSystemPrompt({
      projectPath: selectedProject.path,
      taskId,
      taskTitle: draft.title.trim() || "新建任务",
      taskGoal: draft.summary.trim() || "等待填写任务目标。",
      workerTargets: getWorkerTargetsFromSessionPlan(sessionPlan),
      workerSessions,
      taskSessionPlan: sessionPlan,
    }),
    tools: ["call_session", "read_task_state", "read_session"],
    workerSessions,
    sessionPlan,
  };
}

function parseSessionPlanText(
  text: string,
  fallback: TaskSessionPlan = createDefaultTaskSessionPlanFromTemplate({
    templateId: opencodeTaskTemplates[0].id,
    model: defaultOpencodeRunModel,
  }),
): { plan: TaskSessionPlan; error?: string } {
  const trimmed = text.trim();
  if (!trimmed) return { plan: fallback };
  try {
    return { plan: normalizeTaskSessionPlan(JSON.parse(trimmed), fallback) };
  } catch {
    return { plan: fallback, error: "Session Agent Plan 不是合法 JSON。" };
  }
}

function formatTaskSessionPlan(plan: TaskSessionPlan) {
  return JSON.stringify(plan, null, 2);
}

function syncSessionPlanTargets(plan: TaskSessionPlan): TaskSessionPlan {
  const allowedTargets = plan.workers.map((worker) => worker.name.trim()).filter(Boolean);
  return {
    ...plan,
    routePolicy: {
      ...plan.routePolicy,
      allowedTargets,
    },
  };
}

function retargetSessionPlanModelText(text: string, model: string, draft: TaskIntakeDraft) {
  const fallback = createDefaultTaskSessionPlanFromTemplate({
    templateId: draft.templateId,
    model,
    taskTitle: draft.title,
    taskGoal: draft.summary,
  });
  const parsed = parseSessionPlanText(text, fallback);
  if (parsed.error) return text;
  return formatTaskSessionPlan({
    ...parsed.plan,
    defaultModel: model,
    conductor: {
      ...parsed.plan.conductor,
      model,
    },
    workers: parsed.plan.workers.map((worker) => ({
      ...worker,
      model,
    })),
  });
}

function getWorkerTargetsFromSessionPlan(plan: TaskSessionPlan) {
  return plan.routePolicy?.allowedTargets?.length
    ? plan.routePolicy.allowedTargets
    : plan.workers.map((worker) => worker.name);
}

function hasTaskIntakeDraftContent(draft: TaskIntakeDraft) {
  return Boolean(
    draft.title.trim() ||
      draft.summary.trim() ||
      draft.labelsText.trim() ||
      draft.artifactPath.trim() ||
      draft.templateId !== opencodeTaskTemplates[0].id ||
      draft.model !== defaultOpencodeRunModel,
  );
}

function getConductorTranscript(nativePtySession: NativePtySession | undefined, selectedRun: AgentRun | undefined) {
  if (nativePtySession) {
    return nativePtySession.transcript.map((line) => line.trimEnd()).filter(Boolean);
  }
  if (selectedRun?.nativeSession?.transcriptPreview?.length) {
    return selectedRun.nativeSession.transcriptPreview;
  }
  return selectedRun?.transcriptPreview ?? [];
}

function taskMatchesFilter(task: Task, filter: (typeof filters)[number]["id"]) {
  if (filter === "all") return true;
  if (filter === "running") return task.status === "running" || task.status === "waiting-input";
  if (filter === "waiting") return task.status === "waiting-input" || task.status === "blocked";
  if (filter === "review") return task.status === "pending-review" || task.status === "failed-verification";
  if (filter === "queued") return task.status === "todo" || task.status === "queued";
  return true;
}

function countTasks(tasks: Task[]) {
  return {
    all: tasks.length,
    running: tasks.filter((task) => taskMatchesFilter(task, "running")).length,
    waiting: tasks.filter((task) => taskMatchesFilter(task, "waiting")).length,
    review: tasks.filter((task) => taskMatchesFilter(task, "review")).length,
    queued: tasks.filter((task) => taskMatchesFilter(task, "queued")).length,
  };
}

function taskStateClass(status: TaskStatus) {
  if (status === "running") return "state-running";
  if (status === "waiting-input" || status === "blocked") return "state-decision";
  if (status === "pending-review" || status === "failed-verification") return "state-review";
  if (status === "done") return "state-done";
  return "state-neutral";
}

function agentCardStateClass(agent: Agent) {
  if (agent.status === "working") return "state-running";
  if (agent.status === "waiting") return "state-decision";
  if (agent.status === "review") return "state-review";
  return "state-neutral";
}

function formatNativePtyCommand(session: NativePtySession) {
  return [session.command, ...session.args].join(" ");
}

function terminalIdForAgent(project: Project, cluster: AgentCluster, task: Task, agent: Agent) {
  return `vterm:${getProjectRuntimeId(project)}:${cluster.id}:${getTaskRuntimeId(task)}:${agent.id}`;
}

function agentBelongsToTask(agent: Agent, task: Task) {
  if (agent.taskId !== task.id) return false;
  if (agent.runtimeTaskId && task.runtimeTaskId) return agent.runtimeTaskId === task.runtimeTaskId;
  return true;
}

function getTaskTemplate(templateId: string) {
  return getOpencodeTaskTemplate(templateId);
}

function basename(value: string) {
  return value.replace(/\/+$/, "").split("/").filter(Boolean).pop() ?? "";
}

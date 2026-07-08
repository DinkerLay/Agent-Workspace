import {
  Copy,
  Inbox,
  Plus,
  Sparkles,
  Trash2,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { getActiveRunForTask, getLoopForTask, getRunIdForTask } from "../lib/taskMachine";
import type {
  ReadTaskStateResult,
  SessionDispatchRecord,
  SessionMessageRecord,
  SessionStoreEvent,
} from "../orchestration/conductor-tools";
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
import {
  agentRuntimeRecoveryActions,
  agentRuntimeStateLabel,
  createAgentRuntimeView,
  type AgentRuntimeRecoveryAction,
  type AgentRuntimeRecoveryActionId,
} from "../app/agentRuntimeState";
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

type ExecutionEvent = {
  id: string;
  kind: "user" | "conductor" | "call" | "worker";
  actor: string;
  initial: string;
  accent: string;
  time: string;
  title: string;
  meta: string;
  markdown: string;
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
  taskRuntimeState?: ReadTaskStateResult;
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
  onStopConductorPty?: () => void;
  onOpenAgentTerminal?: (agentId: string) => void;
  onRecoverAgentSession?: (input: AgentSessionRecoveryRequest) => void;
};

export type AgentSessionRecoveryRequest = {
  taskId: string;
  runtimeTaskId: string;
  agentId: string;
  sessionId: string;
  actionId: AgentRuntimeRecoveryActionId;
  failedDispatchId?: string;
};

export function TaskBoard({
  agents,
  tasks,
  runs,
  selectedProject,
  selectedAgentCluster,
  selectedAgent,
  selectedTask,
  selectedTaskId,
  taskRuntimeState,
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
  onStopConductorPty = () => undefined,
  onOpenAgentTerminal = () => undefined,
  onRecoverAgentSession = () => undefined,
}: TaskBoardProps) {
  const [taskIntakeDraft, setTaskIntakeDraft] = useState<TaskIntakeDraft>(() => createDefaultTaskIntakeDraft());
  const [conductorMessage, setConductorMessage] = useState("");
  const [selectedSessionAgentId, setSelectedSessionAgentId] = useState<string | undefined>(selectedAgent?.id);
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
  const sessionAgents = useMemo(
    () =>
      selectedTask && conductorAgent
        ? [conductorAgent, ...workerAgents]
        : conductorAgent
          ? [conductorAgent]
          : [],
    [conductorAgent, selectedTask, workerAgents],
  );
  const selectedSessionAgent =
    sessionAgents.find((agent) => agent.id === selectedSessionAgentId) ?? sessionAgents[0] ?? conductorAgent;
  const sessionAgentRuntimeViews = useMemo(
    () =>
      selectedTask
        ? sessionAgents.map((agent) =>
            createAgentRuntimeView({
              agent,
              project: selectedProject,
              task: selectedTask,
              taskRuntimeState,
            }),
          )
        : [],
    [selectedProject, selectedTask, sessionAgents, taskRuntimeState],
  );
  const sessionAgentRuntimeViewById = useMemo(
    () => new Map(sessionAgentRuntimeViews.map((view) => [view.agent.id, view])),
    [sessionAgentRuntimeViews],
  );
  const selectedSessionAgentRuntimeView =
    selectedSessionAgent && sessionAgentRuntimeViewById.get(selectedSessionAgent.id);
  const selectedSessionRecoveryActions = selectedSessionAgentRuntimeView
    ? agentRuntimeRecoveryActions(selectedSessionAgentRuntimeView)
    : [];
  const executionEvents =
    selectedTask && conductorAgent
      ? createRuntimeExecutionEvents({
          taskRuntimeState,
          selectedProject,
          task: selectedTask,
          conductorAgent,
          workerAgents,
        }) || createExecutionEvents(selectedTask, conductorAgent, workerAgents, selectedRun)
      : [];

  useEffect(() => {
    if (!sessionAgents.length) {
      setSelectedSessionAgentId(undefined);
      return;
    }
    setSelectedSessionAgentId((currentId) =>
      currentId && sessionAgents.some((agent) => agent.id === currentId) ? currentId : sessionAgents[0].id,
    );
  }, [sessionAgents]);

  const sendConductorMessage = () => {
    const trimmedMessage = conductorMessage.trim();
    if (!trimmedMessage) return;
    onWriteConductorPtyData(`${trimmedMessage}\n`);
    setConductorMessage("");
  };

  const recoverSelectedAgentSession = (action: AgentRuntimeRecoveryAction) => {
    if (!selectedTask || !selectedSessionAgent || !selectedSessionAgentRuntimeView) return;
    const failedDispatchId = selectedSessionAgentRuntimeView.unresolvedFailureDispatchId;
    if (action.requiresFailedDispatch && !failedDispatchId) return;
    if (action.requiresConfirmation && action.confirmMessage && !window.confirm(action.confirmMessage)) return;
    onRecoverAgentSession({
      taskId: selectedTask.id,
      runtimeTaskId: getTaskRuntimeId(selectedTask),
      agentId: selectedSessionAgent.id,
      sessionId: selectedSessionAgentRuntimeView.sessionId,
      actionId: action.id,
      failedDispatchId,
    });
  };

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
      <section className="task-home-layout task-home-layout-empty" aria-label="Task Home">
        <section className="task-home-main">
          <article className="panel task-home-hero task-home-description">
            <div>
              <span className="eyebrow">任务描述</span>
              <h2>还没有任务</h2>
              <p>任务的目标、上下文和交付条件会在这里汇总。</p>
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
    <section className="task-home-layout task-home-layout-empty" aria-label="Task Home">
      <section className="task-home-main">
        <article className="panel task-home-hero">
          <div>
            <span className="eyebrow">任务描述</span>
            <div className="task-home-kicker">
              <StatusPill status={selectedTask.status} />
              <span>{getLoopForTask(selectedTask)}</span>
              <span>{selectedTask.owner}</span>
            </div>
            <h3>{selectedTask.title}</h3>
            <p>{selectedTask.summary}</p>
            <div className="task-home-chip-row">
              <span>{selectedTask.source}</span>
              <span>{selectedTask.verification}</span>
              {selectedTask.labels?.map((label) => <span key={label}>{label}</span>)}
            </div>
          </div>
        </article>

        <div className="task-execution-grid">
          <section className="panel execution-panel" aria-label="Task execution conversation">
            <div className="execution-panel-head">
              <div>
                <span className="eyebrow">Conversation</span>
                <h2>执行过程</h2>
              </div>
              <StatusPill status={nativePtySession?.status ?? selectedTask.status} />
            </div>
            <div className="execution-feed" aria-label="执行过程列表">
              {executionEvents.map((event) => (
                <article className={`execution-event execution-event-${event.kind}`} key={event.id}>
                  <div className="execution-actor">
                    <span className="execution-avatar" style={{ backgroundColor: event.accent }}>
                      {event.initial}
                    </span>
                    <strong>{event.actor}</strong>
                    <small>{event.time}</small>
                  </div>
                  <div className="execution-card">
                    <div className="execution-card-head">
                      <strong>{event.title}</strong>
                      <span>{event.meta}</span>
                    </div>
                    <MarkdownContent markdown={event.markdown} />
                  </div>
                </article>
              ))}
            </div>
            <div className="execution-composer">
              <textarea
                aria-label="发送给 Conductor"
                placeholder="给 Conductor 发消息，例如：先停止当前方向，重新让 Executor 按紧凑 Markdown feed 实现。"
                rows={3}
                value={conductorMessage}
                onChange={(event) => setConductorMessage(event.target.value)}
              />
              <div className="execution-composer-actions">
                <button className="primary-button" type="button" onClick={sendConductorMessage}>
                  发送
                </button>
                <button className="danger-button" type="button" onClick={onStopConductorPty}>
                  停止
                </button>
                <button className="success-button" type="button" onClick={() => onAdvance(selectedTask.id)}>
                  Goal
                </button>
              </div>
            </div>
          </section>

          <aside className="task-session-panel" aria-label="Task session agents">
            <section className="panel task-session-roster">
              <div className="task-session-head">
                <span className="eyebrow">Agents</span>
              </div>
              <div className="task-session-list">
                {sessionAgents.map((agent) => {
                  const runtimeView = sessionAgentRuntimeViewById.get(agent.id);
                  const statusLabel = runtimeView?.label ?? agentRuntimeStateLabel("ready");
                  return (
                    <button
                      aria-label={`${agent.name} ${agent.role} ${statusLabel}`}
                      className={agent.id === selectedSessionAgent?.id ? "task-session-agent active" : "task-session-agent"}
                      key={agent.id}
                      type="button"
                      onClick={() => setSelectedSessionAgentId(agent.id)}
                    >
                      <span className="execution-avatar" style={{ backgroundColor: agent.accent }}>
                        {agent.name[0]}
                      </span>
                      <span>
                        <strong>{agent.name}</strong>
                        <small>{agent.role}</small>
                      </span>
                      <em>{statusLabel}</em>
                    </button>
                  );
                })}
              </div>
            </section>

            {selectedSessionAgent && (
              <section className="panel task-session-detail">
                <div className="task-session-head">
                  <span className="eyebrow">Selected Agent</span>
                  <StatusPill
                    status={selectedSessionAgentRuntimeView?.state ?? "ready"}
                    label={selectedSessionAgentRuntimeView?.label ?? agentRuntimeStateLabel("ready")}
                  />
                </div>
                <div className="task-session-identity">
                  <span className="execution-avatar" style={{ backgroundColor: selectedSessionAgent.accent }}>
                    {selectedSessionAgent.name[0]}
                  </span>
                  <div>
                    <strong>{selectedSessionAgent.name}</strong>
                    <small>{selectedSessionAgent.role}</small>
                  </div>
                </div>
                <dl className="task-session-facts">
                  <div>
                    <dt>Provider</dt>
                    <dd>{selectedSessionAgent.provider}</dd>
                  </div>
                  <div>
                    <dt>Model</dt>
                    <dd>{selectedSessionAgent.model}</dd>
                  </div>
                  <div>
                    <dt>CWD</dt>
                    <dd>{selectedProject.path}</dd>
                  </div>
                  <div>
                    <dt>Policy</dt>
                    <dd>{selectedRun?.runtimePolicy.permissionMode ?? "task-scoped"}</dd>
                  </div>
                </dl>
                <div className="task-session-tags">
                  <strong>MCP</strong>
                  <div>
                    {mcpToolsForAgent(selectedSessionAgent, conductorAgent).map((tool) => (
                      <span key={tool}>{tool}</span>
                    ))}
                  </div>
                </div>
                <div className="task-session-tags">
                  <strong>Skills</strong>
                  <div>
                    {skillsForAgent(selectedSessionAgent, conductorAgent).map((skill) => (
                      <span key={skill}>{skill}</span>
                    ))}
                  </div>
                </div>
                {selectedSessionRecoveryActions.length > 0 && (
                  <div className="task-session-actions" aria-label="Agent recovery actions">
                    <strong>恢复动作</strong>
                    <div>
                      {selectedSessionRecoveryActions.map((action) => {
                        const disabled =
                          action.requiresFailedDispatch && !selectedSessionAgentRuntimeView?.unresolvedFailureDispatchId;
                        return (
                          <button
                            className={`recovery-action recovery-action-${action.tone}`}
                            disabled={disabled}
                            key={action.id}
                            title={action.description}
                            type="button"
                            onClick={() => recoverSelectedAgentSession(action)}
                          >
                            {action.label}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}
              </section>
            )}
          </aside>
        </div>

      </section>
    </section>
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
            id="new-task-title"
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
    tools: ["call_session", "read_task_state", "read_session", "claim_task_completion"],
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

function createRuntimeExecutionEvents(input: {
  taskRuntimeState?: ReadTaskStateResult;
  selectedProject: Project;
  task: Task;
  conductorAgent: Agent;
  workerAgents: Agent[];
}): ExecutionEvent[] | undefined {
  const runtimeEvents = [...(input.taskRuntimeState?.events ?? [])].sort(
    (left, right) => Number(left.cursor ?? 0) - Number(right.cursor ?? 0),
  );
  if (!runtimeEvents.length) return undefined;

  const dispatches = (input.taskRuntimeState?.dispatches ?? []) as SessionDispatchRecord[];
  const dispatchById = new Map(dispatches.map((dispatch) => [dispatch.dispatchId, dispatch]));
  const messageByDispatchId = new Map(
    (input.taskRuntimeState?.messages ?? []).map((message) => [message.dispatchId, message]),
  );
  const resultByDispatchId = new Map(
    (input.taskRuntimeState?.results ?? []).map((result) => [result.dispatchId, result]),
  );
  const rendered: ExecutionEvent[] = [];
  const seen = new Set<string>();

  for (const event of runtimeEvents) {
    if (event.type === "task.user_message" || event.type === "user.intervention") {
      if (isRawIdeTerminalIntervention(event)) continue;
      rendered.push(userExecutionEvent(event));
      continue;
    }

    if (event.type === "conductor.message") {
      rendered.push(conductorRuntimeEvent(event, input.conductorAgent, "Conductor 输出", "output message"));
      continue;
    }

    if (event.type === "task.completion_claim") {
      rendered.push(conductorRuntimeEvent(event, input.conductorAgent, "任务完成声明", "completion claim"));
      continue;
    }

    if (event.type === "dispatch.created") {
      const dispatch = dispatchForEvent(event, dispatchById);
      if (!dispatch || seen.has(`dispatch-${dispatch.dispatchId}`)) continue;
      seen.add(`dispatch-${dispatch.dispatchId}`);
      const targetAgent = resolveAgentForSessionId(dispatch.toSessionId, input);
      rendered.push({
        id: event.id,
        kind: "call",
        actor: "Call",
        initial: "Call",
        accent: "#475569",
        time: formatExecutionEventTime(event),
        title: "agent_session_call",
        meta: `${input.conductorAgent.name || "Conductor"} -> ${targetAgent?.name ?? roleNameFromSessionId(dispatch.toSessionId)}`,
        markdown: dispatch.assignment || event.summary || "Agent session call recorded.",
      });
      continue;
    }

    if (event.type === "dispatch.result_available") {
      const dispatch = dispatchForEvent(event, dispatchById);
      if (!dispatch || seen.has(`result-${dispatch.dispatchId}`)) continue;
      seen.add(`result-${dispatch.dispatchId}`);
      const message = messageByDispatchId.get(dispatch.dispatchId);
      const result = resultByDispatchId.get(dispatch.dispatchId);
      const targetAgent = resolveAgentForSessionId(dispatch.toSessionId, input);
      rendered.push(workerExecutionEvent({
        event,
        dispatch,
        message,
        markdown: message?.answerText || result?.answerPreview || event.summary,
        targetAgent,
      }));
      continue;
    }

    if (event.type === "dispatch.failed") {
      const dispatch = dispatchForEvent(event, dispatchById);
      if (!dispatch || seen.has(`dispatch-failed-${dispatch.dispatchId}`)) continue;
      seen.add(`dispatch-failed-${dispatch.dispatchId}`);
      const targetAgent = resolveAgentForSessionId(dispatch.toSessionId, input);
      rendered.push({
        id: event.id,
        kind: "call",
        actor: "Call",
        initial: "Call",
        accent: "#b91c1c",
        time: formatExecutionEventTime(event),
        title: "agent_session_call failed",
        meta: `${input.conductorAgent.name || "Conductor"} -> ${targetAgent?.name ?? roleNameFromSessionId(dispatch.toSessionId)}`,
        markdown: dispatch.failureMessage || event.summary || "Dispatch failed.",
      });
      continue;
    }

    if (event.type === "conductor.wakeup.sent" || event.type === "conductor.wakeup.queued") {
      rendered.push({
        id: event.id,
        kind: "conductor",
        actor: input.conductorAgent.name || "Conductor",
        initial: (input.conductorAgent.name || "C")[0],
        accent: input.conductorAgent.accent,
        time: formatExecutionEventTime(event),
        title: event.type === "conductor.wakeup.sent" ? "Runtime wakeup" : "Runtime wakeup queued",
        meta: "runtime event",
        markdown: event.summary,
      });
    }
  }

  return rendered.length ? rendered : undefined;
}

function userExecutionEvent(event: SessionStoreEvent): ExecutionEvent {
  const message = stringFromEventData(event, "message") || event.summary;
  return {
    id: event.id,
    kind: "user",
    actor: "User",
    initial: "U",
    accent: "#b45309",
    time: formatExecutionEventTime(event),
    title: event.type === "task.user_message" ? "任务发起" : "用户修正方向",
    meta: "message to Conductor",
    markdown: message,
  };
}

function isRawIdeTerminalIntervention(event: SessionStoreEvent) {
  return event.type === "user.intervention" && stringFromEventData(event, "source") === "ide-terminal";
}

function conductorRuntimeEvent(
  event: SessionStoreEvent,
  conductorAgent: Agent,
  title: string,
  meta: string,
): ExecutionEvent {
  const actor = conductorAgent.name || "Conductor";
  return {
    id: event.id,
    kind: "conductor",
    actor,
    initial: actor[0] ?? "C",
    accent: conductorAgent.accent,
    time: formatExecutionEventTime(event),
    title,
    meta,
    markdown: stringFromEventData(event, "message") || event.summary,
  };
}

function workerExecutionEvent(input: {
  event: SessionStoreEvent;
  dispatch: SessionDispatchRecord;
  message?: SessionMessageRecord;
  markdown: string;
  targetAgent?: Agent;
}): ExecutionEvent {
  const actor = input.targetAgent?.name ?? roleNameFromSessionId(input.dispatch.toSessionId);
  return {
    id: input.event.id,
    kind: "worker",
    actor,
    initial: actor[0] ?? "W",
    accent: input.targetAgent?.accent ?? "#2563eb",
    time: formatExecutionEventTime(input.event),
    title: "实现结果",
    meta: "result message",
    markdown: input.markdown,
  };
}

function dispatchForEvent(event: SessionStoreEvent, dispatchById: Map<string, SessionDispatchRecord>) {
  const dispatchId = stringFromEventData(event, "dispatchId");
  return dispatchId ? dispatchById.get(dispatchId) : undefined;
}

function stringFromEventData(event: SessionStoreEvent, key: string) {
  const value = event.data?.[key];
  return typeof value === "string" ? value : "";
}

function resolveAgentForSessionId(
  sessionId: string | undefined,
  input: {
    selectedProject: Project;
    task: Task;
    conductorAgent: Agent;
    workerAgents: Agent[];
  },
) {
  const agents = [input.conductorAgent, ...input.workerAgents];
  return agents.find(
    (agent) =>
      createOpencodeSessionKey({
        projectId: getProjectRuntimeId(input.selectedProject),
        taskId: getTaskRuntimeId(input.task),
        agentId: agent.id,
      }) === sessionId,
  );
}

function roleNameFromSessionId(sessionId: string | undefined) {
  const tail = String(sessionId ?? "Worker").split(":").pop() ?? "Worker";
  return tail
    .replace(/^task-intake-\d+-/i, "")
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ") || "Worker";
}

function formatExecutionEventTime(event: SessionStoreEvent) {
  const cursor = Number(event.cursor);
  return Number.isFinite(cursor) && cursor > 0 ? `#${cursor}` : "event";
}

function createExecutionEvents(
  task: Task,
  conductorAgent: Agent,
  workerAgents: Agent[],
  selectedRun: AgentRun | undefined,
): ExecutionEvent[] {
  const targetAgent =
    workerAgents.find((agent) => /executor|implement|worker/i.test(`${agent.name} ${agent.role}`)) ??
    workerAgents[0];
  const targetName = targetAgent?.name ?? "Worker";
  const conductorName = conductorAgent.name || "Conductor";
  const runFiles = selectedRun?.changedFilePaths.length
    ? selectedRun.changedFilePaths.slice(0, 4)
    : ["src/pages/TaskBoard.tsx", "src/components/ExecutionConversation.tsx", "src/styles.css"];
  const codeFence = ["```text", ...runFiles, "```"].join("\n");

  return [
    {
      id: `${task.id}-user-intake`,
      kind: "user",
      actor: "User",
      initial: "U",
      accent: "#b45309",
      time: "00:00",
      title: "任务发起",
      meta: "message to Conductor",
      markdown: task.summary || task.title,
    },
    {
      id: `${task.id}-conductor-output`,
      kind: "conductor",
      actor: "Conductor",
      initial: "C",
      accent: conductorAgent.accent,
      time: "00:03",
      title: "分析输出",
      meta: "output message",
      markdown: [
        `我会把当前任务按 conversation-first 展示：用户输入、${conductorName} 输出、session 调用、Worker 结果和 Review 状态分开。`,
        "",
        "- Terminal 保留为后台运行能力和诊断入口。",
        "- Task 页面只展示可读执行内容和 Agent 状态。",
        "- 用户可以通过底部对话框随时纠偏 Conductor。",
      ].join("\n"),
    },
    {
      id: `${task.id}-agent-session-call`,
      kind: "call",
      actor: "Call",
      initial: "Call",
      accent: "#475569",
      time: "00:04",
      title: "agent_session_call",
      meta: `Conductor -> ${targetName}`,
      markdown: [
        `请让 ${targetName} 处理当前任务的实现部分。`,
        "",
        "- 区分 Conductor 的普通 output message 和派发任务的 agent_session_call message。",
        "- 卡片正文必须渲染 Markdown 内容，包括列表、代码块和状态说明。",
        "- 不要从 terminal text 推导 task state。",
      ].join("\n"),
    },
    {
      id: `${task.id}-worker-result`,
      kind: "worker",
      actor: targetName,
      initial: targetName[0] ?? "W",
      accent: targetAgent?.accent ?? "#2563eb",
      time: "00:11",
      title: "实现结果",
      meta: "result message",
      markdown: [
        "### 关键变化",
        "- 新增执行对话流，按真实事件类型拆分展示。",
        "- 底部 composer 写入 Conductor 的真实 session。",
        "- 右侧可查看所选 session agent 的模型、MCP 和 Skills。",
        "",
        codeFence,
      ].join("\n"),
    },
  ];
}

function MarkdownContent({ markdown }: { markdown: string }) {
  const lines = markdown.trim().split(/\r?\n/);
  const blocks: ReactNode[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }

    if (line.startsWith("```")) {
      const codeLines: string[] = [];
      index += 1;
      while (index < lines.length && !lines[index].startsWith("```")) {
        codeLines.push(lines[index]);
        index += 1;
      }
      index += 1;
      blocks.push(
        <pre key={`code-${blocks.length}`}>
          <code>{codeLines.join("\n")}</code>
        </pre>,
      );
      continue;
    }

    if (/^#{1,4}\s+/.test(line)) {
      const text = line.replace(/^#{1,4}\s+/, "");
      blocks.push(<h4 key={`heading-${blocks.length}`}>{renderInlineMarkdown(text, `heading-${blocks.length}`)}</h4>);
      index += 1;
      continue;
    }

    if (/^[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^[-*]\s+/.test(lines[index])) {
        items.push(lines[index].replace(/^[-*]\s+/, ""));
        index += 1;
      }
      blocks.push(
        <ul key={`ul-${blocks.length}`}>
          {items.map((item, itemIndex) => (
            <li key={`${item}-${itemIndex}`}>{renderInlineMarkdown(item, `ul-${blocks.length}-${itemIndex}`)}</li>
          ))}
        </ul>,
      );
      continue;
    }

    if (/^\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^\d+\.\s+/.test(lines[index])) {
        items.push(lines[index].replace(/^\d+\.\s+/, ""));
        index += 1;
      }
      blocks.push(
        <ol key={`ol-${blocks.length}`}>
          {items.map((item, itemIndex) => (
            <li key={`${item}-${itemIndex}`}>{renderInlineMarkdown(item, `ol-${blocks.length}-${itemIndex}`)}</li>
          ))}
        </ol>,
      );
      continue;
    }

    const paragraphLines: string[] = [];
    while (
      index < lines.length &&
      lines[index].trim() &&
      !lines[index].startsWith("```") &&
      !/^#{1,4}\s+/.test(lines[index]) &&
      !/^[-*]\s+/.test(lines[index]) &&
      !/^\d+\.\s+/.test(lines[index])
    ) {
      paragraphLines.push(lines[index].trim());
      index += 1;
    }
    blocks.push(
      <p key={`p-${blocks.length}`}>{renderInlineMarkdown(paragraphLines.join(" "), `p-${blocks.length}`)}</p>,
    );
  }

  return <div className="execution-md">{blocks}</div>;
}

function renderInlineMarkdown(text: string, keyPrefix: string) {
  return text.split(/(`[^`]+`)/g).map((part, index) => {
    if (part.startsWith("`") && part.endsWith("`")) {
      return <code key={`${keyPrefix}-code-${index}`}>{part.slice(1, -1)}</code>;
    }
    return <span key={`${keyPrefix}-text-${index}`}>{part}</span>;
  });
}

function mcpToolsForAgent(agent: Agent, conductorAgent: Agent) {
  if (agent.id === conductorAgent.id) return ["agent_session_call", "read_task_state", "read_session", "claim_task_completion"];
  return ["agent_session_call", "provider_state", "read_session"];
}

function skillsForAgent(agent: Agent, conductorAgent: Agent) {
  const signature = `${agent.name} ${agent.role}`.toLowerCase();
  if (agent.id === conductorAgent.id) return ["orchestration", "routing", "review-gate"];
  if (signature.includes("qa") || signature.includes("verification")) return ["verification", "e2e-smoke"];
  if (signature.includes("review")) return ["diff-review", "risk-scan"];
  if (signature.includes("executor") || signature.includes("implement")) return ["implementation", "verification"];
  return ["task-scope", "provider-native"];
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

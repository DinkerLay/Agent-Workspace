import {
  ChevronDown,
  ChevronRight,
  ClipboardList,
  ListChecks,
  PanelLeftClose,
  PanelLeftOpen,
  RefreshCcw,
  ShieldCheck,
  SquareTerminal,
} from "lucide-react";
import { useMemo, useState } from "react";
import { laneTitle, StatusPill } from "../components/common";
import { PtyTerminal } from "../components/PtyTerminal";
import type { NativePtySession, NativeRuntimeStatus } from "../runtime/nativeBridge";
import type {
  Agent,
  AgentCluster,
  AgentRun,
  Project,
  RuntimeEvent,
  ScratchpadItem,
  Task,
  TerminalEvent,
} from "../types";

type WorkbenchProps = {
  agents: Agent[];
  agentClusters: AgentCluster[];
  selectedProject: Project;
  selectedAgentCluster: AgentCluster;
  selectedAgentClusterId: string;
  selectedAgent?: Agent;
  selectedAgentId: string;
  selectedTask?: Task;
  selectedRun?: AgentRun;
  terminalLines: string[];
  prompt: string;
  tasks: Task[];
  runtimeEvents: RuntimeEvent[];
  terminalEvents: TerminalEvent[];
  scratchpadItems: ScratchpadItem[];
  scratchpadAttachmentIds: string[];
  scratchpadDraftPath: string;
  scratchpadSavedAt: string;
  nativeRuntimeStatus: NativeRuntimeStatus;
  nativePtySession?: NativePtySession;
  agentLaunchCommand: string;
  defaultAgentLaunchCommand: string;
  onPromptChange: (value: string) => void;
  onSendPrompt: () => void;
  onSelectAgent: (agentId: string) => void;
  onSelectAgentCluster: (clusterId: string) => void;
  onSelectTask: (taskId: string) => void;
  onAgentClaimsDone: () => void;
  onAttachScratchpadArtifact: (itemId: string) => void;
  onInsertScratchpadItem: (itemId: string) => void;
  onSaveScratchpadDraft: () => void;
  onApplyTerminalSignal: (eventId: string) => void;
  onResetAgentLaunchCommand: () => void;
  onStartNativePty?: () => void;
  onRefreshNativePty?: () => void;
  onWriteNativePtyData?: (data: string) => void;
  onResizeNativePty?: (cols: number, rows: number) => void;
  onStopNativePty?: () => void;
};

type WorkbenchReadyProps = WorkbenchProps & {
  selectedAgent: Agent;
  selectedTask: Task;
};

export function Workbench(props: WorkbenchProps) {
  if (!props.selectedTask || !props.selectedAgent) {
    return (
      <section className="ide-layout conversation-workbench details-collapsed agents-open">
        <aside className="panel project-panel conversation-agent-panel session-nav-panel">
          <div className="session-project-switcher" aria-label="当前项目">
            <div>
              <strong>{props.selectedProject.name}</strong>
              <small>{props.selectedProject.path}</small>
            </div>
            <div className="session-project-metrics" aria-label="项目 Agent 摘要">
              <span>{props.selectedProject.agentClusterIds.length} clusters</span>
              <span>0 agents</span>
            </div>
          </div>
        </aside>
        <section className="panel terminal-panel conversation-panel">
          <div className="conversation-header">
            <div>
              <span className="eyebrow">terminal-backed conversation</span>
              <h2>还没有任务</h2>
              <div className="conversation-meta">
                <StatusPill status="empty" />
                <span>先在任务主页创建任务，再打开 task-scoped agent terminal。</span>
              </div>
            </div>
          </div>
        </section>
      </section>
    );
  }

  return <WorkbenchReady {...props} selectedAgent={props.selectedAgent} selectedTask={props.selectedTask} />;
}

function WorkbenchReady({
  agents,
  agentClusters,
  selectedProject,
  selectedAgentCluster,
  selectedAgent,
  selectedAgentId,
  selectedTask,
  selectedRun,
  tasks,
  nativeRuntimeStatus,
  nativePtySession,
  agentLaunchCommand,
  defaultAgentLaunchCommand,
  onSelectAgent,
  onSelectTask,
  onAgentClaimsDone,
  onResetAgentLaunchCommand,
  onStartNativePty,
  onRefreshNativePty,
  onWriteNativePtyData,
  onResizeNativePty,
  onStopNativePty,
}: WorkbenchReadyProps) {
  const [agentRailCollapsed, setAgentRailCollapsed] = useState(false);
  const [agentsExpanded, setAgentsExpanded] = useState(false);
  const [tasksExpanded, setTasksExpanded] = useState(false);

  const projectClusters = agentClusters.filter((cluster) => selectedProject.agentClusterIds.includes(cluster.id));
  const projectAgents = agents.filter(
    (agent) => selectedAgentCluster.agentIds.includes(agent.id) && agentBelongsToTask(agent, selectedTask),
  );
  const currentAgent = projectAgents.find((agent) => agent.id === selectedAgent.id) ?? projectAgents[0] ?? selectedAgent;
  const projectTasks = tasks.filter((task) => selectedProject.taskIds.includes(task.id));
  const visibleAgents = agentsExpanded ? projectAgents : [currentAgent];
  const visibleTasks = tasksExpanded ? projectTasks : [selectedTask];
  const workingAgentCount = projectAgents.filter((agent) => agent.status === "working").length;
  const reviewAgentCount = projectAgents.filter((agent) => agent.status === "review").length;
  const waitingAgentCount = projectAgents.filter((agent) => agent.status === "waiting").length;
  const idleAgentCount = projectAgents.filter((agent) => agent.status === "idle").length;
  const activeAgentCount = workingAgentCount + reviewAgentCount;
  const progressCounts = [
    { key: "working", label: "运行", value: workingAgentCount, className: "state-running" },
    { key: "review", label: "决策", value: reviewAgentCount, className: "state-review" },
    { key: "waiting", label: "等待", value: waitingAgentCount, className: "state-decision" },
    { key: "idle", label: "空闲", value: idleAgentCount, className: "state-neutral" },
  ].filter((item) => item.value > 0);
  const runtimePolicy = selectedRun?.runtimePolicy;
  const terminalTranscript = useMemo(
    () => nativePtySession?.transcript.map((line) => line.trimEnd()).filter(Boolean) ?? [],
    [nativePtySession?.transcript],
  );
  const terminalCommand = nativePtySession
    ? formatNativePtyCommand(nativePtySession)
    : agentLaunchCommand;
  const terminalCwd = nativePtySession?.cwd ?? selectedProject.path;
  const canStartNativePty = nativeRuntimeStatus.available && nativeRuntimeStatus.ptyAvailable !== false;
  const nativePtyRunning = nativePtySession?.status === "running" || nativePtySession?.status === "stopping";
  const permissionStatus = runtimePolicy?.permissionMode ?? "pending";
  const permissionNeedsAttention = permissionStatus === "pending" || permissionStatus === "ask-before-write";
  const selectedAgentIsConductor = currentAgent.name === "Conductor";
  const conductorTools = ["call_session", "read_task_state", "read_session"];
  const workbenchClassName = [
    "ide-layout",
    "conversation-workbench",
    "details-collapsed",
    agentRailCollapsed ? "agents-collapsed" : "agents-open",
  ].join(" ");

  const handleTerminalRawData = (data: string) => {
    onWriteNativePtyData?.(data);
  };

  return (
    <section className={workbenchClassName}>
      <aside
        className={
          agentRailCollapsed
            ? "panel project-panel conversation-agent-panel session-nav-panel collapsed"
            : "panel project-panel conversation-agent-panel session-nav-panel"
        }
      >
        <button
          aria-label={agentRailCollapsed ? "展开左侧 Agent 导航" : "收起左侧 Agent 导航"}
          className="agent-rail-toggle"
          type="button"
          onClick={() => setAgentRailCollapsed((value) => !value)}
        >
          {agentRailCollapsed ? <PanelLeftOpen size={17} /> : <PanelLeftClose size={17} />}
          {!agentRailCollapsed ? <span>{agentRailCollapsed ? "展开" : "收起"}</span> : null}
        </button>

        {agentRailCollapsed ? (
          <div className="collapsed-agent-stack" aria-label="Collapsed Agent navigation">
            <span className="agent-avatar" style={{ backgroundColor: currentAgent.accent }}>
              {currentAgent.name[0]}
            </span>
            <StatusPill status={currentAgent.status} />
            <small>{projectAgents.length} agents</small>
          </div>
        ) : (
          <>
            <div className="session-project-switcher" aria-label="当前项目">
              <div>
                <strong>{selectedProject.name}</strong>
                <small>{selectedProject.path}</small>
              </div>
              <div className="session-project-metrics" aria-label="项目 Agent 摘要">
                <span>{projectClusters.length} clusters</span>
                <span>{projectAgents.length} agents</span>
                {activeAgentCount > 0 ? <span>{activeAgentCount} active</span> : null}
                {waitingAgentCount > 0 ? <span>{waitingAgentCount} waiting</span> : null}
              </div>
            </div>

            <div className="cluster-switcher task-switcher" aria-label="任务列表">
              <div className="session-nav-label">
                <ClipboardList size={15} />
                <span>任务列表</span>
              </div>
              <div className="cluster-switcher-list">
                {projectTasks.length > 0 ? (
                  projectTasks.map((task) => (
                    <button
                      className={[
                        "cluster-row cluster-chip",
                        selectedTask.id === task.id ? "active" : "",
                        taskCardStateClass(task),
                      ].join(" ")}
                      key={task.id}
                      type="button"
                      onClick={() => onSelectTask(task.id)}
                    >
                      <span>
                        <strong>{task.title}</strong>
                        <small>{task.runtimeTaskId ?? task.id} · {laneTitle(task.status)}</small>
                      </span>
                      <StatusPill status={task.status} />
                    </button>
                  ))
                ) : (
                  <small className="empty-session-list">还没有任务</small>
                )}
              </div>
            </div>

            <div className="agent-stack agent-session-list">
              <button
                aria-expanded={agentsExpanded}
                className="section-toggle"
                type="button"
                onClick={() => setAgentsExpanded((value) => !value)}
              >
                {agentsExpanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                <span>Agent 列表</span>
                <small>{agentsExpanded ? "收起" : `仅当前 · ${projectAgents.length}`}</small>
              </button>
              <div className={agentsExpanded ? "agent-list expanded" : "agent-list collapsed"}>
                {visibleAgents.map((agent) => (
                  <button
                    className={[
                      "agent-row session-agent-row",
                      currentAgent.id === agent.id ? "active" : "",
                      agentCardStateClass(agent),
                    ].join(" ")}
                    key={agent.id}
                    onClick={() => onSelectAgent(agent.id)}
                    type="button"
                  >
                    <span className="agent-avatar" style={{ backgroundColor: agent.accent }}>
                      {agent.name[0]}
                    </span>
                    <span>
                      <strong>{agent.name}</strong>
                      <small>{agent.role}</small>
                    </span>
                    <StatusPill status={agent.status} />
                  </button>
                ))}
              </div>
            </div>

            <div className={tasksExpanded ? "current-task-context expanded" : "current-task-context collapsed"}>
              <button
                aria-expanded={tasksExpanded}
                className={[
                  "current-task-row",
                  taskCardStateClass(selectedTask),
                ].join(" ")}
                type="button"
                onClick={() => setTasksExpanded((value) => !value)}
              >
                <ClipboardList size={15} />
                <span>
                  <small>当前任务</small>
                  <strong>{selectedTask.title}</strong>
                </span>
                <small>{tasksExpanded ? "收起" : "展开"}</small>
              </button>
              {tasksExpanded ? (
                <div className="task-drawer-list">
                  {visibleTasks.map((task) => (
                    <button
                      className={[
                        "task-choice",
                        selectedTask.id === task.id ? "active" : "",
                        taskCardStateClass(task),
                      ].join(" ")}
                      key={task.id}
                      type="button"
                      onClick={() => onSelectTask(task.id)}
                    >
                      <span>{task.title}</span>
                      <small>{laneTitle(task.status)}</small>
                    </button>
                  ))}
                </div>
              ) : null}
            </div>

            <div className="task-progress-panel" aria-label="当前任务进度">
              <div className="session-nav-label">
                <ListChecks size={15} />
                <span>当前任务进度</span>
              </div>
              <div className="task-progress-meter" aria-label="Agent 快速选择">
                {projectAgents.map((agent) => (
                  <button
                    aria-label={`选择 ${agent.name} agent`}
                    className={[
                      agentCardStateClass(agent),
                    ].join(" ")}
                    key={agent.id}
                    title={`${agent.name} · ${agent.role} · ${agent.status}`}
                    type="button"
                    onClick={() => onSelectAgent(agent.id)}
                  />
                ))}
              </div>
              <div className="task-progress-counts" aria-label="Agent 状态汇总">
                {progressCounts.map((item) => (
                  <span className={["task-progress-count", item.className].join(" ")} key={item.key}>
                    <strong>{item.value}</strong>
                    <small>{item.label}</small>
                  </span>
                ))}
              </div>
            </div>
          </>
        )}
      </aside>

      <section className="panel terminal-panel conversation-panel">
        <div className="conversation-header">
          <div>
            <span className="eyebrow">terminal-backed conversation</span>
            <h2>{currentAgent.name} 对话 Terminal</h2>
            <div className="conversation-meta">
              <StatusPill status={currentAgent.status} />
              <strong>{currentAgent.role}</strong>
              <span>{selectedTask.title}</span>
            </div>
          </div>
          <div className="terminal-actions">
            <button
              className="primary-button"
              disabled={!canStartNativePty || nativePtyRunning}
              title={
                nativePtyRunning
                  ? "当前 Agent PTY 已在运行；刷新或停止后再启动新的 session"
                  : canStartNativePty
                    ? "启动交互式 opencode PTY"
                    : "需要桌面壳加载真实 node-pty 后才能启动交互式 opencode"
              }
              type="button"
              onClick={onStartNativePty}
            >
              <SquareTerminal size={16} />
              {nativePtyRunning
                ? "PTY 运行中"
                : nativeRuntimeStatus.available && nativeRuntimeStatus.ptyAvailable === false
                  ? "需要真实 PTY"
                  : "启动 opencode PTY"}
            </button>
            <button
              className="icon-button"
              aria-label="refresh terminal session"
              disabled={!nativePtySession}
              type="button"
              onClick={onRefreshNativePty}
            >
              <RefreshCcw size={16} />
            </button>
            <button
              className="icon-button"
              aria-label="stop terminal session"
              disabled={!nativePtySession || nativePtySession.status !== "running"}
              type="button"
              onClick={onStopNativePty}
            >
              <ShieldCheck size={16} />
            </button>
          </div>
        </div>

        <div className={permissionNeedsAttention ? "terminal-context-line permission-alert" : "terminal-context-line"} aria-label="Terminal run context">
          <code title={terminalCommand}>{terminalCommand}</code>
          <span title={terminalCwd}>{terminalCwd}</span>
          <StatusPill status={permissionStatus} />
        </div>

        <div className="session-role-line" aria-label="Session orchestration scope">
          {selectedAgentIsConductor ? (
            <>
              <strong>Conductor 工具</strong>
              <span>任务负责人，通过 MCP tools 调度和读取其他 session</span>
              <div className="runtime-pill-row">
                {conductorTools.map((tool) => (
                  <code key={tool}>{tool}</code>
                ))}
              </div>
            </>
          ) : (
            <>
              <strong>Worker sessions 保持原生</strong>
              <span>PTY 只提供生命周期；语义状态来自 provider adapter</span>
            </>
          )}
        </div>

        <div className="agent-command-config" aria-label="Agent 启动配置">
          <div>
            <span>启动命令预览</span>
            <code aria-label="Agent 启动命令预览">{agentLaunchCommand}</code>
          </div>
          <button className="ghost-button" title={defaultAgentLaunchCommand} type="button" onClick={onResetAgentLaunchCommand}>
            默认
          </button>
        </div>

        <PtyTerminal
          ariaLabel="Agent terminal transcript"
          command={terminalCommand}
          session={nativePtySession}
          transcriptLines={terminalTranscript}
          emptyTitle="尚未启动当前 Agent terminal。"
          emptyDetail="点击“启动 opencode PTY”后，会在这个 PTY 中打开交互式 opencode TUI；后续输入会直接写入 terminal。"
          waitingDetail="PTY 已启动，正在等待 opencode TUI 输出。"
          onData={handleTerminalRawData}
          onResize={onResizeNativePty}
        />

        <div className="agent-terminal-actions">
          <button className="ghost-button" type="button" onClick={onAgentClaimsDone}>
            <ShieldCheck size={16} />
            GOAL 完成
          </button>
        </div>
      </section>
    </section>
  );
}

function agentCardStateClass(agent: Agent) {
  if (agent.status === "working" || agent.status === "review") return "state-running";
  if (agent.status === "waiting") return "state-decision";
  return "state-neutral";
}

function agentBelongsToTask(agent: Agent, task: Task) {
  if (agent.taskId !== task.id) return false;
  if (agent.runtimeTaskId && task.runtimeTaskId) return agent.runtimeTaskId === task.runtimeTaskId;
  return true;
}

function taskCardStateClass(task: Task) {
  if (task.status === "running") return "state-running";
  if (task.status === "done") return "state-done";
  if (task.status === "waiting-input" || task.status === "pending-review" || task.status === "blocked") return "state-decision";
  return "state-neutral";
}

function formatNativePtyCommand(session: NativePtySession) {
  return [session.command, ...session.args].join(" ");
}

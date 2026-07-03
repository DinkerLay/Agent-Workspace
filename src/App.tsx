import {
  Blocks,
  FileDiff,
} from "lucide-react";
import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import browserImage from "../docs/research/assets/agentsroom/browser-automation.jpg";
import {
  browserRuntimeStatus,
  defaultOpencodeRunModel,
  generateNativeTaskDraft,
  getNativePtySession,
  getNativeRuntimeStatus,
  resizeNativePtySession,
  runNativeVerification,
  startNativePtySession,
  subscribeNativePtyEvents,
  stopNativePtySession,
  type NativePtyEvent,
  type NativePtySession,
  type NativeRuntimeStatus,
  writeNativePtySession,
} from "./runtime/nativeBridge";
import { createRuntimeWorkspaceState } from "./runtime/opencode";
import { getActiveRunForTask, prototypeReducer } from "./lib/taskMachine";
import { CapabilityMap } from "./pages/CapabilityMap";
import { TaskBoard } from "./pages/TaskBoard";
import { Workbench } from "./pages/Workbench";
import { LoopConsole } from "./pages/LoopConsole";
import { Review } from "./pages/Review";
import { Runs } from "./pages/Runs";
import { DevTerminals } from "./pages/DevTerminals";
import { Teams } from "./pages/Teams";
import { BrowserAutomation } from "./pages/BrowserAutomation";
import { Libraries } from "./pages/Libraries";
import { Notifications } from "./pages/Notifications";
import { RestoreSession } from "./pages/RestoreSession";
import { Projects } from "./pages/Projects";
import { McpGateway } from "./pages/McpGateway";
import { PlanWatcher } from "./pages/PlanWatcher";
import { AuditTrail } from "./pages/AuditTrail";
import { buildWorkspaceAuditTrail } from "./lib/auditTrail";
import { defaultAgentLaunchCommand } from "./lib/agentLaunchCommand";
import {
  appendPtyReadinessBuffer,
  formatPtyInput,
  isLiveNativePtySession,
  isOpencodeTuiReady,
  mergeNativePtySession,
  normalizeNativePtySession,
} from "./app/ptySessionUtils";
import { deliveryEntries, loopStages, moreGroups, navItems, type ShellEntry } from "./app/shellConfig";
import {
  buildOpencodeTuiCommand,
  createOpencodeSessionKey,
  getProjectRuntimeId,
  getTaskRuntimeId,
  opencodeTaskTemplates,
} from "./runtime/opencode";
import { buildOpenCodeConductorInjection } from "./runtime/adapters/opencode/conductorInjection";
import type { RuntimeAdapterCard } from "./runtime/contracts";
import type {
  BrowserTool,
  ChangedFile,
  LibraryItem,
  McpServer,
  ProductCapability,
  RuntimeContract,
  TeamWorkflow,
  View,
  Agent,
  PrototypeState,
  TaskSessionPlan,
} from "./types";

const defaultRuntimeProjectPath = "/Users/dinker/CODES/Agent-Workspace";
const defaultRuntimeProjectName = "Agent Workspace";

export function createInitialRuntimeWorkspaceState(): PrototypeState {
  const { projectPath, projectName } = getRuntimeWorkspaceInput();
  return createRuntimeWorkspaceState({ projectPath, projectName });
}

function getRuntimeWorkspaceInput() {
  if (typeof window === "undefined") {
    return { projectPath: defaultRuntimeProjectPath, projectName: defaultRuntimeProjectName };
  }

  const params = new URLSearchParams(window.location.search);
  const projectPath = params.get("projectPath")?.trim() || defaultRuntimeProjectPath;
  const projectName = params.get("projectName")?.trim() || basename(projectPath) || defaultRuntimeProjectName;
  return { projectPath, projectName };
}

function basename(value: string) {
  return value.replace(/\/+$/, "").split("/").filter(Boolean).pop() ?? "";
}

const runtimeProductCapabilities: ProductCapability[] = [];
const runtimeContracts: RuntimeContract[] = [];
const runtimeMcpServers: McpServer[] = [];
const runtimeBrowserTools: BrowserTool[] = [];
const runtimeLibraryItems: LibraryItem[] = [];
const runtimeTeamWorkflows: TeamWorkflow[] = [];
const runtimeAdapterCards: RuntimeAdapterCard[] = [];
const runtimeChangedFiles: ChangedFile[] = [];

function App({ initialState = createInitialRuntimeWorkspaceState() }: { initialState?: PrototypeState } = {}) {
  const [state, dispatch] = useReducer(prototypeReducer, initialState);
  const [primaryRailCollapsed, setPrimaryRailCollapsed] = useState(true);
  const [nativeRuntimeStatus, setNativeRuntimeStatus] = useState<NativeRuntimeStatus>(browserRuntimeStatus);
  const [nativePtySessionsByKey, setNativePtySessionsByKey] = useState<Record<string, NativePtySession | undefined>>({});
  const [nativeTerminalSizesByKey, setNativeTerminalSizesByKey] = useState<Record<string, { cols: number; rows: number }>>({});
  const nativePtySessionsRef = useRef<Record<string, NativePtySession | undefined>>({});
  const nativePtyCursorsRef = useRef<Record<string, number>>({});
  const nativePtySessionKeysByIdRef = useRef<Record<string, string>>({});
  const nativePtyAgentsByIdRef = useRef<Record<string, Agent | undefined>>({});
  const nativePtyReadinessBuffersByIdRef = useRef<Record<string, string>>({});
  const pendingNativePtyEventsByIdRef = useRef<Record<string, NativePtyEvent[]>>({});
  const nativePtyEventHandlerRef = useRef<(event: NativePtyEvent) => void>(() => undefined);
  const startingNativePtySessionIdsRef = useRef<Set<string>>(new Set());
  const autoStartedTaskIdsRef = useRef<Set<string>>(new Set());
  const initialPtyInputFlushedIdsRef = useRef<Set<string>>(new Set());
  const outputAfterInitialPtyInputIdsRef = useRef<Set<string>>(new Set());
  const pendingInitialPtyInputsRef = useRef<Record<string, { sessionId: string; input: string; agent: Agent }>>({});
  const auditEntries = useMemo(() => buildWorkspaceAuditTrail(state), [state]);

  const fallbackProject = initialState.projects[0];
  const fallbackAgentCluster = initialState.agentClusters[0];
  const selectedProject = state.projects.find((project) => project.id === state.selectedProjectId) ?? fallbackProject;
  const selectedAgentCluster =
    state.agentClusters.find((cluster) => cluster.id === state.selectedAgentClusterId) ??
    state.agentClusters.find((cluster) => cluster.id === selectedProject.defaultAgentClusterId) ??
    fallbackAgentCluster;
  const selectedAgent = state.agents.find((agent) => agent.id === state.selectedAgentId);
  const selectedTask = state.tasks.find((task) => task.id === state.selectedTaskId);
  const selectedRun = selectedTask ? getActiveRunForTask(state.runs, selectedTask.id) : undefined;
  const selectedProjectRuntimeId = getProjectRuntimeId(selectedProject);
  const selectedTaskRuntimeId = selectedTask ? getTaskRuntimeId(selectedTask) : "no-task";
  const agentBelongsToSelectedTask = (agent: Agent) => {
    if (!selectedTask) return false;
    if (agent.taskId !== selectedTask.id) return false;
    if (agent.runtimeTaskId && selectedTask.runtimeTaskId) return agent.runtimeTaskId === selectedTask.runtimeTaskId;
    return true;
  };
  const nativeConversationKeyForContext = (input: {
    projectRuntimeId: string;
    clusterId: string;
    runtimeTaskId: string;
    agentId: string;
  }) => `${input.projectRuntimeId}:${input.clusterId}:${input.runtimeTaskId}:${input.agentId}`;
  const nativeConversationKeyForAgent = (agent: Agent | undefined) =>
    nativeConversationKeyForContext({
      projectRuntimeId: selectedProjectRuntimeId,
      clusterId: selectedAgentCluster.id,
      runtimeTaskId: selectedTaskRuntimeId,
      agentId: agent?.id ?? "no-agent",
    });
  const selectedTaskConductorAgent = selectedTask
    ? state.agents.find(
        (agent) =>
          selectedAgentCluster.agentIds.includes(agent.id) &&
          agentBelongsToSelectedTask(agent) &&
          agent.name === "Conductor",
      )
    : undefined;
  const selectedTaskAgents = selectedTask
    ? state.agents.filter(
        (agent) => selectedAgentCluster.agentIds.includes(agent.id) && agentBelongsToSelectedTask(agent),
      )
    : [];
  const activeSelectedAgent =
    selectedTask && selectedTaskAgents.length > 0
      ? (selectedTaskAgents.find((agent) => agent.id === selectedAgent?.id) ??
        selectedTaskConductorAgent ??
        selectedTaskAgents[0])
      : selectedAgent;
  const selectedTaskTemplate = getOpencodeTaskTemplate(selectedTask?.templateId);
  const nativeConversationKey = nativeConversationKeyForAgent(activeSelectedAgent);
  const conductorNativeConversationKey = nativeConversationKeyForAgent(selectedTaskConductorAgent);
  const nativePtySession = nativePtySessionsByKey[nativeConversationKey];
  const conductorNativePtySession = nativePtySessionsByKey[conductorNativeConversationKey];
  const nativeTerminalSize = nativeTerminalSizesByKey[nativeConversationKey] ?? { cols: 100, rows: 30 };
  const launchCommandForAgent = (agent: Agent | undefined) =>
    agent ? defaultAgentLaunchCommand(agent.model) : defaultAgentLaunchCommand(defaultOpencodeRunModel);
  const selectedAgentLaunchCommand = launchCommandForAgent(activeSelectedAgent);
  const selectedTaskConductorLaunchCommand = launchCommandForAgent(selectedTaskConductorAgent);
  const selectedTeamRun =
    [...state.teamRuns]
      .reverse()
      .find((run) => run.workflowId === state.selectedTeamWorkflowId && run.status === "running") ??
    [...state.teamRuns].reverse().find((run) => run.workflowId === state.selectedTeamWorkflowId);
  const filteredFiles = runtimeChangedFiles;

  const probeNativeRuntime = () => {
    void getNativeRuntimeStatus()
      .then((status) => {
        setNativeRuntimeStatus(status);
      })
      .catch((error: unknown) => {
        setNativeRuntimeStatus({
          available: false,
          mode: "browser",
          message: error instanceof Error ? error.message : "无法检测本地 opencode runtime。",
        });
      });
  };

  useEffect(() => {
    probeNativeRuntime();
  }, []);

  const sendPrompt = () => {
    if (!selectedTask || !activeSelectedAgent) return;
    dispatch({ type: "send-prompt" });
  };

  const advanceTask = (taskId: string) => {
    dispatch({ type: "advance-task", taskId });
  };

  const openAgentTerminal = (agentId: string) => {
    dispatch({ type: "select-agent", agentId });
    dispatch({ type: "set-view", view: "workbench" });
  };

  const startAgentFromRuntime = (taskId: string) => {
    if (!state.tasks.some((task) => task.id === taskId)) {
      dispatch({ type: "runtime-start-failed", reason: `Task ${taskId} not found` });
      return;
    }
    dispatch({ type: "start-agent", taskId });
  };

  const resetNativeSessionUiState = () => {
    nativePtySessionsRef.current = {};
    nativePtyCursorsRef.current = {};
    nativePtySessionKeysByIdRef.current = {};
    nativePtyAgentsByIdRef.current = {};
    nativePtyReadinessBuffersByIdRef.current = {};
    pendingNativePtyEventsByIdRef.current = {};
    pendingInitialPtyInputsRef.current = {};
    startingNativePtySessionIdsRef.current.clear();
    autoStartedTaskIdsRef.current.clear();
    setNativePtySessionsByKey({});
    setNativeTerminalSizesByKey({});
  };

  const openRuntimeProject = (input: { projectPath: string; projectName: string }) => {
    resetNativeSessionUiState();
    dispatch({
      type: "open-runtime-project",
      projectPath: input.projectPath,
      projectName: input.projectName,
    });
  };

  const attachNativeSessionToRun = (
    session: NativePtySession | undefined,
    agent: Agent | undefined = activeSelectedAgent,
    taskId = selectedTask?.id,
  ) => {
    if (!session || !taskId || !agent) return;
    dispatch({
      type: "attach-native-session-evidence",
      taskId,
      agentId: agent.id,
      session,
    });
  };

  const storeNativePtySession = (
    session: NativePtySession | undefined,
    options: { attach?: boolean; agent?: Agent; sessionKey?: string; taskId?: string } = {},
  ) => {
    if (!session) return;
    const sessionKey = options.sessionKey ?? nativeConversationKeyForAgent(options.agent ?? activeSelectedAgent);
    const normalized = mergeNativePtySession(nativePtySessionsRef.current[sessionKey], session);
    nativePtyCursorsRef.current[sessionKey] = normalized.cursor ?? normalized.transcript.length;
    nativePtySessionKeysByIdRef.current[normalized.id] = sessionKey;
    nativePtyAgentsByIdRef.current[normalized.id] = options.agent ?? activeSelectedAgent;
    if (normalized.transcript.length > 0) {
      nativePtyReadinessBuffersByIdRef.current[normalized.id] = appendPtyReadinessBuffer(
        nativePtyReadinessBuffersByIdRef.current[normalized.id] ?? "",
        normalized.transcript.join(""),
      );
    }
    nativePtySessionsRef.current = { ...nativePtySessionsRef.current, [sessionKey]: normalized };
    setNativePtySessionsByKey(nativePtySessionsRef.current);
    flushPendingNativePtyEvents(normalized.id);
    if (options.attach !== false) attachNativeSessionToRun(normalized, options.agent ?? activeSelectedAgent, options.taskId);
  };

  const queueInitialPtyInput = (sessionKey: string, session: NativePtySession | undefined, agent: Agent, input: string) => {
    if (!session || !input.trim()) return;
    pendingInitialPtyInputsRef.current = {
      ...pendingInitialPtyInputsRef.current,
      [sessionKey]: { sessionId: session.id, input, agent },
    };
    flushInitialPtyInputIfReady(sessionKey, session);
  };

  const flushInitialPtyInputIfReady = (sessionKey: string, session: NativePtySession | undefined) => {
    if (!session || !isOpencodeTuiReady(session, nativePtyReadinessBuffersByIdRef.current[session.id])) return;
    const pending = pendingInitialPtyInputsRef.current[sessionKey];
    if (!pending || pending.sessionId !== session.id) return;

    const { [sessionKey]: _flushed, ...remaining } = pendingInitialPtyInputsRef.current;
    pendingInitialPtyInputsRef.current = remaining;

    initialPtyInputFlushedIdsRef.current.add(session.id);
    void writeNativePtySession(session.id, formatPtyInput(pending.input))
      .then((updatedSession) => {
        storeNativePtySession(updatedSession, { attach: false, agent: pending.agent });
      })
      .catch((error: unknown) => {
        initialPtyInputFlushedIdsRef.current.delete(session.id);
        dispatch({
          type: "runtime-start-failed",
          reason: error instanceof Error ? error.message : "initial PTY dispatch failed",
        });
      });
  };

  const handleNativePtyEvent = (event: NativePtyEvent) => {
    const sessionKey = nativePtySessionKeysByIdRef.current[event.id];
    if (!sessionKey) {
      const resolved = resolveNativeSessionRef(event.id);
      if (resolved) {
        nativePtySessionKeysByIdRef.current[event.id] = resolved.sessionKey;
        nativePtyAgentsByIdRef.current[event.id] = resolved.agent;
        pendingNativePtyEventsByIdRef.current[event.id] = [
          ...(pendingNativePtyEventsByIdRef.current[event.id] ?? []),
          event,
        ];
        void getNativePtySession(event.id).then((snapshot) => {
          if (snapshot) {
            storeNativePtySession(snapshot, {
              agent: resolved.agent,
              sessionKey: resolved.sessionKey,
              taskId: resolved.taskId,
            });
          }
        });
        return;
      }
      pendingNativePtyEventsByIdRef.current[event.id] = [
        ...(pendingNativePtyEventsByIdRef.current[event.id] ?? []),
        event,
      ];
      return;
    }

    const current = nativePtySessionsRef.current[sessionKey];
    if (!current) return;

    nativePtyCursorsRef.current[sessionKey] = event.cursor;

    if (event.type === "data") {
      const hadInitialInputBeforeEvent = initialPtyInputFlushedIdsRef.current.has(event.id);
      nativePtyReadinessBuffersByIdRef.current[event.id] = appendPtyReadinessBuffer(
        nativePtyReadinessBuffersByIdRef.current[event.id] ?? "",
        event.chunk,
      );
      flushInitialPtyInputIfReady(sessionKey, {
        ...current,
        cursor: event.cursor,
      });
      if (hadInitialInputBeforeEvent) {
        outputAfterInitialPtyInputIdsRef.current.add(event.id);
      }
      return;
    }

    void getNativePtySession(event.id).then((snapshot) => {
      const stoppedSession = normalizeNativePtySession({
        ...current,
        ...(snapshot ?? {}),
        status: event.status,
        exitCode: event.exitCode,
        signal: event.signal,
        cursor: snapshot?.cursor ?? event.cursor,
      });
      nativePtySessionsRef.current = { ...nativePtySessionsRef.current, [sessionKey]: stoppedSession };
      setNativePtySessionsByKey(nativePtySessionsRef.current);
      attachNativeSessionToRun(
        stoppedSession,
        nativePtyAgentsByIdRef.current[event.id] ?? activeSelectedAgent,
        resolveNativeSessionRef(event.id)?.taskId ?? selectedTask?.id,
      );
    });
  };
  nativePtyEventHandlerRef.current = handleNativePtyEvent;

  useEffect(() => {
    return subscribeNativePtyEvents((event) => nativePtyEventHandlerRef.current(event));
  }, []);

  function flushPendingNativePtyEvents(sessionId: string) {
    const pendingEvents = pendingNativePtyEventsByIdRef.current[sessionId];
    if (!pendingEvents?.length) return;

    const { [sessionId]: _flushed, ...remaining } = pendingNativePtyEventsByIdRef.current;
    pendingNativePtyEventsByIdRef.current = remaining;
    for (const event of pendingEvents) {
      handleNativePtyEvent(event);
    }
  }

  const startNativePtyForTaskAgent = (agent: Agent | undefined, options: { initialInput?: string } = {}) => {
    if (!selectedTask || !agent) {
      dispatch({ type: "runtime-start-failed", reason: "No task or agent selected for native PTY start" });
      return;
    }

    const sessionKey = nativeConversationKeyForAgent(agent);
    const existingSession = nativePtySessionsRef.current[sessionKey];
    if (isLiveNativePtySession(existingSession)) {
      refreshNativePtySessionForAgent(existingSession, agent);
      return;
    }

    const sessionId = createOpencodeSessionKey({
      projectId: selectedProjectRuntimeId,
      taskId: selectedTaskRuntimeId,
      agentId: agent.id,
    });
    if (startingNativePtySessionIdsRef.current.has(sessionId)) return;

    const isConductorAgent = selectedTaskConductorAgent?.id === agent.id;
    const conductorInjection =
      isConductorAgent && agent.provider === "opencode"
        ? buildConductorInjectionForCurrentTask(agent)
        : undefined;
    if (isConductorAgent && agent.provider === "opencode" && !conductorInjection) {
      dispatch({
        type: "runtime-start-failed",
        reason: "Conductor MCP tool bridge is not available yet.",
      });
      return;
    }

    const commandSpec = buildOpencodeTuiCommand({
      binaryPath: nativeRuntimeStatus.opencodePath ?? "opencode",
      cwd: selectedProject.path,
      model: agent.model,
    });
    const terminalSize = nativeTerminalSizesByKey[sessionKey] ?? { cols: 100, rows: 30 };

    startingNativePtySessionIdsRef.current.add(sessionId);
    void startNativePtySession({
      id: sessionId,
      command: commandSpec.command,
      args: commandSpec.args,
      cwd: commandSpec.cwd,
      taskId: selectedTaskRuntimeId,
      model: agent.model,
      cols: terminalSize.cols,
      rows: terminalSize.rows,
      stdin: "pipe",
      requirePty: true,
      env: conductorInjection?.env,
      runtimeFiles: conductorInjection?.files,
    })
      .then((session) => {
        storeNativePtySession(session, { agent });
        if (session?.status === "running" && options.initialInput?.trim()) {
          queueInitialPtyInput(sessionKey, session, agent, options.initialInput);
        }
      })
      .catch((error: unknown) => {
        dispatch({
          type: "runtime-start-failed",
          reason: error instanceof Error ? error.message : "native PTY start failed",
        });
      })
      .finally(() => {
        startingNativePtySessionIdsRef.current.delete(sessionId);
      });
  };

  const startNativePtyForSelectedTask = () => {
    startNativePtyForTaskAgent(activeSelectedAgent);
  };

  const startNativePtyForSelectedTaskConductor = () => {
    startNativePtyForTaskAgent(selectedTaskConductorAgent, {
      initialInput: buildConductorKickoffPrompt({
        projectPath: selectedProject.path,
        taskId: selectedTask ? getTaskRuntimeId(selectedTask) : "",
        taskTitle: selectedTask?.title ?? "",
        taskGoal: selectedTask?.summary ?? "",
        workerSessions: buildWorkerSessionRefsForCurrentTask(selectedTaskConductorAgent),
        taskSessionPlan: selectedTask?.sessionPlan,
      }),
    });
  };

  useEffect(() => {
    if (!selectedTask || !selectedTaskConductorAgent) return;
    if (!nativeRuntimeStatus.available || nativeRuntimeStatus.ptyAvailable === false) return;
    const runtimeTaskId = getTaskRuntimeId(selectedTask);
    if (conductorNativePtySession || autoStartedTaskIdsRef.current.has(runtimeTaskId)) return;

    autoStartedTaskIdsRef.current.add(runtimeTaskId);
    startNativePtyForTaskAgent(selectedTaskConductorAgent, {
      initialInput: buildConductorKickoffPrompt({
        projectPath: selectedProject.path,
        taskId: runtimeTaskId,
        taskTitle: selectedTask.title,
        taskGoal: selectedTask.summary,
        workerSessions: buildWorkerSessionRefsForCurrentTask(selectedTaskConductorAgent),
        taskSessionPlan: selectedTask.sessionPlan,
      }),
    });
  }, [
    conductorNativePtySession?.id,
    nativeRuntimeStatus.available,
    nativeRuntimeStatus.ptyAvailable,
    selectedProject.path,
    selectedTask?.id,
    selectedTask?.templateId,
    selectedTaskConductorAgent?.id,
  ]);

  function buildConductorInjectionForCurrentTask(agent: Agent) {
    if (!selectedTask) return undefined;
    const bridgeUrl = nativeRuntimeStatus.conductorToolBridgeUrl?.trim();
    const bridgeToken = nativeRuntimeStatus.conductorToolBridgeToken?.trim();
    const mcpServerPath = nativeRuntimeStatus.conductorMcpServerPath?.trim();
    if (!bridgeUrl || !bridgeToken || !mcpServerPath) return undefined;

    return buildOpenCodeConductorInjection({
      projectPath: selectedProject.path,
      taskId: getTaskRuntimeId(selectedTask),
      taskTitle: selectedTask.title,
      taskGoal: selectedTask.summary,
      model: agent.model,
      workerTargets: selectedTask.sessionPlan?.routePolicy?.allowedTargets?.length
        ? selectedTask.sessionPlan.routePolicy.allowedTargets
        : selectedTaskTemplate.workerTargets,
      workerSessions: buildWorkerSessionRefsForCurrentTask(agent),
      taskSessionPlan: selectedTask.sessionPlan,
      bridgeUrl,
      bridgeToken,
      mcpServerPath,
    });
  }

  function buildWorkerSessionRefsForCurrentTask(conductorAgent: Agent | undefined) {
    if (!selectedTask) return [];
    return selectedTaskAgents
      .filter((agent) => agent.id !== conductorAgent?.id)
      .map((agent) => ({
        id: createOpencodeSessionKey({
          projectId: selectedProjectRuntimeId,
          taskId: selectedTaskRuntimeId,
          agentId: agent.id,
        }),
        name: agent.name,
        role: agent.role,
      }));
  }

  function resolveNativeSessionRef(sessionId: string) {
    for (const project of state.projects) {
      for (const taskId of project.taskIds) {
        const task = state.tasks.find((item) => item.id === taskId);
        if (!task) continue;

        for (const clusterId of project.agentClusterIds) {
          const cluster = state.agentClusters.find((item) => item.id === clusterId && item.taskId === task.id);
          if (!cluster) continue;

          for (const agentId of cluster.agentIds) {
            const agent = state.agents.find((item) => item.id === agentId && item.taskId === task.id);
            if (!agent) continue;
            if (agent.runtimeTaskId && task.runtimeTaskId && agent.runtimeTaskId !== task.runtimeTaskId) continue;

            const expectedSessionId = createOpencodeSessionKey({
              projectId: getProjectRuntimeId(project),
              taskId: getTaskRuntimeId(task),
              agentId: agent.id,
            });
            if (expectedSessionId !== sessionId) continue;

            return {
              agent,
              taskId: task.id,
              sessionKey: nativeConversationKeyForContext({
                projectRuntimeId: getProjectRuntimeId(project),
                clusterId: cluster.id,
                runtimeTaskId: getTaskRuntimeId(task),
                agentId: agent.id,
              }),
            };
          }
        }
      }
    }
    return undefined;
  }

  const refreshNativePtySessionForAgent = (session: NativePtySession | undefined, agent: Agent | undefined) => {
    if (!session) return;
    void getNativePtySession(session.id).then((refreshedSession) => {
      storeNativePtySession(refreshedSession, { agent });
    });
  };

  const refreshNativePtySession = () => {
    refreshNativePtySessionForAgent(nativePtySession, activeSelectedAgent);
  };

  const refreshSelectedTaskConductorPtySession = () => {
    refreshNativePtySessionForAgent(conductorNativePtySession, selectedTaskConductorAgent);
  };

  const writeRawToNativePtySession = (data: string) => {
    if (!nativePtySession || nativePtySession.status !== "running") return;
    void writeNativePtySession(nativePtySession.id, data).then((session) => {
      storeNativePtySession(session, { attach: false, agent: activeSelectedAgent });
    });
  };

  const writeRawToSelectedTaskConductorPtySession = (data: string) => {
    if (!conductorNativePtySession || conductorNativePtySession.status !== "running") return;
    void writeNativePtySession(conductorNativePtySession.id, data).then((session) => {
      storeNativePtySession(session, { attach: false, agent: selectedTaskConductorAgent });
    });
  };

  const resizeCurrentNativePtySession = (cols: number, rows: number) => {
    setNativeTerminalSizesByKey((sizes) => ({ ...sizes, [nativeConversationKey]: { cols, rows } }));
    if (!nativePtySession || nativePtySession.status !== "running") return;
    void resizeNativePtySession(nativePtySession.id, { cols, rows }).then((session) => {
      storeNativePtySession(session, { attach: false, agent: activeSelectedAgent });
    });
  };

  const resizeSelectedTaskConductorPtySession = (cols: number, rows: number) => {
    setNativeTerminalSizesByKey((sizes) => ({ ...sizes, [conductorNativeConversationKey]: { cols, rows } }));
    if (!conductorNativePtySession || conductorNativePtySession.status !== "running") return;
    void resizeNativePtySession(conductorNativePtySession.id, { cols, rows }).then((session) => {
      storeNativePtySession(session, { attach: false, agent: selectedTaskConductorAgent });
    });
  };

  const stopCurrentNativePtySession = () => {
    if (!nativePtySession) return;
    void stopNativePtySession(nativePtySession.id).then((session) => {
      storeNativePtySession(session, { attach: session?.status === "stopped" });
    });
  };

  const runVerificationForTask = (taskId: string) => {
    const run = getActiveRunForTask(state.runs, taskId);
    if (!run) {
      dispatch({ type: "run-verification-command", taskId });
      return;
    }

    const command = run.verification.command || "npm test && npm run build";
    void runNativeVerification({
      cwd: selectedProject.path,
      runId: run.id,
      command,
    })
      .then((result) => {
        dispatch({
          type: "attach-native-verification-evidence",
          taskId,
          runId: run.id,
          result: {
            ...result,
            runId: run.id,
          },
        });
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : "native verification command failed";
        dispatch({
          type: "attach-native-verification-evidence",
          taskId,
          runId: run.id,
          result: {
            ok: false,
            command,
            cwd: selectedProject.path,
            runId: run.id,
            status: "failed",
            stdout: "",
            stderr: message,
            exitCode: null,
            signal: null,
            durationMs: 0,
            artifactPath: `.agent-workspace/runs/${run.id}/verification.json`,
            logPath: `.agent-workspace/runs/${run.id}/verification.log`,
            error: message,
          },
        });
      });
  };

  return (
    <div className={primaryRailCollapsed ? "app-shell primary-rail-collapsed" : "app-shell"}>
      <aside className={primaryRailCollapsed ? "rail rail-collapsed" : "rail"}>
        <button
          aria-label={primaryRailCollapsed ? "展开主导航" : "收起主导航"}
          className="brand rail-brand-toggle"
          title={primaryRailCollapsed ? "展开主导航" : "收起主导航"}
          type="button"
          onClick={() => setPrimaryRailCollapsed((value) => !value)}
        >
          <span className="brand-mark">
            <Blocks size={18} />
          </span>
          <span className="brand-copy">
            <strong>Agent Workspace</strong>
          <span>Workspace</span>
          </span>
        </button>

        <nav className="nav-list" aria-label="Prototype pages">
          {navItems.map((item) => {
            const Icon = item.icon;
            return (
              <button
                aria-label={item.label}
                className={primaryViewFor(state.activeView) === item.id ? "nav-item active" : "nav-item"}
                key={item.id}
                onClick={() => dispatch({ type: "set-view", view: item.id })}
                title={item.label}
                type="button"
              >
                <Icon size={17} />
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>

        <div className="decision-box">
          <div className="eyebrow">工作台主线</div>
          <strong>任务主页 · Conductor · IDE 操作台</strong>
          <p>任务主页创建和观察任务；Conductor 推进主线；IDE 承载真实 terminal 操作。</p>
        </div>
      </aside>

      <main className={`workspace workspace-${state.activeView}`}>
        <header className="topbar">
          <div>
            <div className="eyebrow">Agent Workspace</div>
            <h1>{pageTitle(state.activeView)}</h1>
          </div>
        </header>

        {state.activeView === "capabilities" && (
          <CapabilityMap
            capabilities={runtimeProductCapabilities}
            contracts={runtimeContracts}
            adapters={runtimeAdapterCards}
            onOpenView={(view) => dispatch({ type: "set-view", view })}
          />
        )}
        {state.activeView === "delivery" && (
          <DeliveryGateHub onOpenView={(view) => dispatch({ type: "set-view", view })} />
        )}
        {state.activeView === "more" && (
          <MoreHub onOpenView={(view) => dispatch({ type: "set-view", view })} />
        )}
        {state.activeView === "projects" && (
          <Projects
            agents={state.agents}
            agentClusters={state.agentClusters}
            agentTemplates={state.agentTemplates}
            agentProfileEvents={state.agentProfileEvents}
            commands={state.devCommands}
            projectContextEvents={state.projectContextEvents}
            projects={state.projects}
            runs={state.runs}
            selectedProjectId={state.selectedProjectId}
            tasks={state.tasks}
            onAddAgent={(templateId) => dispatch({ type: "add-agent-from-template", templateId })}
            onOpenWorkbench={() => dispatch({ type: "set-view", view: "workbench" })}
            onSelectProject={(projectId) => dispatch({ type: "select-project", projectId })}
          />
        )}
        {state.activeView === "mcp" && (
          <McpGateway
            servers={runtimeMcpServers}
            selectedServerId={state.selectedMcpServerId}
            toolEvents={state.mcpToolEvents}
            onSelectServer={(serverId) => dispatch({ type: "select-mcp-server", serverId })}
            onRequestToolCall={(serverId, toolName) => dispatch({ type: "request-mcp-tool-call", serverId, toolName })}
            onResolveToolCall={(eventId, decision) =>
              dispatch({ type: "resolve-mcp-tool-call", eventId, decision })
            }
          />
        )}
        {state.activeView === "watcher" && (
          <PlanWatcher
            events={state.watchEvents}
            sources={state.watchSources}
            tasks={state.tasks}
            onCreatePlannerTask={(eventId) => dispatch({ type: "create-planner-task-from-watch", eventId })}
          />
        )}
        {state.activeView === "workbench" && (
          <Workbench
            agents={state.agents}
            agentClusters={state.agentClusters}
            selectedProject={selectedProject}
            selectedAgentCluster={selectedAgentCluster}
            selectedAgentClusterId={state.selectedAgentClusterId}
            selectedAgent={activeSelectedAgent}
            selectedAgentId={activeSelectedAgent?.id ?? state.selectedAgentId}
            selectedTask={selectedTask}
            selectedRun={selectedRun}
            terminalLines={state.terminalLines}
            prompt={state.prompt}
            onPromptChange={(prompt) => dispatch({ type: "set-prompt", prompt })}
            onSendPrompt={sendPrompt}
            onSelectAgent={(agentId) => dispatch({ type: "select-agent", agentId })}
            onSelectAgentCluster={(clusterId) => dispatch({ type: "select-agent-cluster", clusterId })}
            onSelectTask={(taskId) => dispatch({ type: "select-task", taskId })}
            tasks={state.tasks}
            runtimeEvents={state.runtimeEvents.slice(-6)}
            terminalEvents={state.terminalEvents}
            scratchpadItems={state.scratchpadItems}
            scratchpadAttachmentIds={state.scratchpadAttachmentIds}
            scratchpadDraftPath={state.scratchpadDraftPath}
            scratchpadSavedAt={state.scratchpadSavedAt}
            nativeRuntimeStatus={nativeRuntimeStatus}
            nativePtySession={nativePtySession}
            agentLaunchCommand={selectedAgentLaunchCommand}
            defaultAgentLaunchCommand={defaultAgentLaunchCommand(activeSelectedAgent?.model ?? defaultOpencodeRunModel)}
            onAgentClaimsDone={() => {
              if (selectedTask) dispatch({ type: "agent-claims-done", taskId: selectedTask.id });
            }}
            onAttachScratchpadArtifact={(itemId) => dispatch({ type: "attach-scratchpad-artifact", itemId })}
            onInsertScratchpadItem={(itemId) => dispatch({ type: "insert-scratchpad-item", itemId })}
            onSaveScratchpadDraft={() => dispatch({ type: "save-scratchpad-draft" })}
            onApplyTerminalSignal={(eventId) => dispatch({ type: "apply-terminal-signal", eventId })}
            onResetAgentLaunchCommand={() => undefined}
            onStartNativePty={startNativePtyForSelectedTask}
            onRefreshNativePty={refreshNativePtySession}
            onWriteNativePtyData={writeRawToNativePtySession}
            onResizeNativePty={resizeCurrentNativePtySession}
            onStopNativePty={stopCurrentNativePtySession}
          />
        )}
        {state.activeView === "backlog" && (
          <TaskBoard
            agents={state.agents}
            agentClusters={state.agentClusters}
            tasks={state.tasks}
            runs={state.runs}
            selectedProject={selectedProject}
            selectedAgentCluster={selectedAgentCluster}
            selectedAgent={activeSelectedAgent}
            selectedTask={selectedTask}
            selectedTaskId={state.selectedTaskId}
            taskIntakeEvents={state.taskIntakeEvents}
            taskTransitionEvents={state.taskTransitionEvents}
            loopStages={loopStages}
            nativeRuntimeStatus={nativeRuntimeStatus}
            nativePtySession={conductorNativePtySession}
            agentLaunchCommand={selectedTaskConductorLaunchCommand}
            onGenerateTaskDraft={generateNativeTaskDraft}
            onCreateTaskFromIntake={(input) => dispatch({ type: "create-task-from-intake", ...input })}
            onOpenRuntimeProject={openRuntimeProject}
            onSelectTask={(taskId) => dispatch({ type: "select-task", taskId })}
            onAdvance={advanceTask}
            onStartAgent={startAgentFromRuntime}
            onOpenLoops={() => dispatch({ type: "set-view", view: "loops" })}
            onStartConductorPty={startNativePtyForSelectedTaskConductor}
            onRefreshConductorPty={refreshSelectedTaskConductorPtySession}
            onWriteConductorPtyData={writeRawToSelectedTaskConductorPtySession}
            onResizeConductorPty={resizeSelectedTaskConductorPtySession}
            onOpenAgentTerminal={openAgentTerminal}
          />
        )}
        {state.activeView === "loops" && (
          <LoopConsole
            tasks={state.tasks}
            loopScheduleEvents={state.loopScheduleEvents}
            loopStages={loopStages}
            onAdvance={advanceTask}
            onStartAgent={startAgentFromRuntime}
          />
        )}
        {state.activeView === "review" && (
          selectedTask ? (
            <Review
              agents={state.agents}
              files={filteredFiles}
              selectedTask={selectedTask}
              selectedRun={selectedRun}
              reviewAgentId={state.reviewAgentId}
              reviewFileSelections={state.reviewFileSelections}
              commitConversationIncluded={state.commitConversationIncluded}
              commitRedactionScans={state.commitRedactionScans}
              commitStagingEvents={state.commitStagingEvents}
              browserEvidence={state.browserEvidence}
              mcpToolEvents={state.mcpToolEvents}
              terminalEvents={state.terminalEvents}
              onReviewAgentChange={(agentId) => dispatch({ type: "select-review-agent", agentId })}
              onToggleReviewFile={(path) => dispatch({ type: "toggle-review-file", path })}
              onToggleCommitConversation={() => dispatch({ type: "toggle-commit-conversation" })}
              onRunCommitRedactionScan={() =>
                dispatch({ type: "run-commit-redaction-scan", taskId: selectedTask.id })
              }
              onStageReviewFiles={(taskId) => dispatch({ type: "stage-review-files", taskId })}
              onRunVerificationCommand={runVerificationForTask}
              onVerificationFailed={() => dispatch({ type: "verification-failed", taskId: selectedTask.id })}
              onApproveReview={() => dispatch({ type: "approve-review", taskId: selectedTask.id })}
            />
          ) : (
            <EmptyRuntimePanel onOpenTaskHome={() => dispatch({ type: "set-view", view: "backlog" })} />
          )
        )}
        {state.activeView === "teams" && (
          <Teams
            workflows={runtimeTeamWorkflows}
            selectedWorkflowId={state.selectedTeamWorkflowId}
            activeRun={selectedTeamRun}
            onSelectWorkflow={(workflowId) => dispatch({ type: "select-team-workflow", workflowId })}
            onStartTeamRun={() => dispatch({ type: "start-team-run" })}
            onAdvanceTeamRun={() => dispatch({ type: "advance-team-run" })}
          />
        )}
        {state.activeView === "terminals" && (
          <DevTerminals
            commands={state.devCommands}
            contracts={runtimeContracts}
            events={state.devCommandEvents}
            onStartCommand={(commandId) => dispatch({ type: "start-dev-command", commandId })}
            onStopCommand={(commandId) => dispatch({ type: "stop-dev-command", commandId })}
          />
        )}
        {state.activeView === "browser" && (
          selectedTask ? (
            <BrowserAutomation
              imageSrc={browserImage}
              tools={runtimeBrowserTools}
              selectedTask={selectedTask}
              activeToolName={state.activeBrowserToolName}
              evidence={state.browserEvidence}
              onSelectTool={(toolName) => dispatch({ type: "select-browser-tool", toolName })}
              onCaptureEvidence={() => dispatch({ type: "capture-browser-evidence" })}
            />
          ) : (
            <EmptyRuntimePanel onOpenTaskHome={() => dispatch({ type: "set-view", view: "backlog" })} />
          )
        )}
        {state.activeView === "libraries" && (
          <Libraries
            items={runtimeLibraryItems}
            activePromptTemplateId={state.activePromptTemplateId}
            attachedSkillIds={state.attachedSkillIds}
            promptLibrarySaves={state.promptLibrarySaves}
            onInjectPrompt={(itemId) => dispatch({ type: "inject-library-prompt", itemId })}
            onAttachSkill={(itemId) => dispatch({ type: "attach-library-skill", itemId })}
          />
        )}
        {state.activeView === "notifications" && (
          selectedTask ? (
            <Notifications
              selectedTask={selectedTask}
              events={state.notificationEvents}
              onRouteNotification={() => dispatch({ type: "route-notification" })}
              onOpenNotificationContext={(eventId) => dispatch({ type: "open-notification-context", eventId })}
              onAcknowledgeNotification={(eventId) => dispatch({ type: "acknowledge-notification", eventId })}
            />
          ) : (
            <EmptyRuntimePanel onOpenTaskHome={() => dispatch({ type: "set-view", view: "backlog" })} />
          )
        )}
        {state.activeView === "restore" && (
          selectedTask && activeSelectedAgent ? (
            <RestoreSession
              manifest={state.restoreManifest}
              selectedAgent={activeSelectedAgent}
              selectedTask={selectedTask}
              onCaptureRestoreManifest={() => dispatch({ type: "capture-restore-manifest" })}
              onRestoreWorkspaceSession={() => dispatch({ type: "restore-workspace-session" })}
            />
          ) : (
            <EmptyRuntimePanel onOpenTaskHome={() => dispatch({ type: "set-view", view: "backlog" })} />
          )
        )}
        {state.activeView === "audit" && (
          <AuditTrail
            entries={auditEntries}
            onOpenEntryContext={(entryId) => dispatch({ type: "open-audit-entry-context", entryId })}
          />
        )}
        {state.activeView === "runs" && (
          selectedTask && activeSelectedAgent && selectedRun ? (
            <Runs
              runs={state.runs}
              selectedTask={selectedTask}
              selectedAgent={activeSelectedAgent}
              reviewFileSelections={state.reviewFileSelections}
              commitConversationIncluded={state.commitConversationIncluded}
              browserEvidence={state.browserEvidence}
              commitRedactionScans={state.commitRedactionScans}
              commitStagingEvents={state.commitStagingEvents}
              verificationEvents={state.verificationEvents}
              terminalEvents={state.terminalEvents}
              mcpToolEvents={state.mcpToolEvents}
              reviewApprovalEvents={state.reviewApprovalEvents}
              pullRequestHandoffEvents={state.pullRequestHandoffEvents}
              onCreatePullRequestHandoff={(runId) => dispatch({ type: "create-pr-handoff", runId })}
            />
          ) : (
            <EmptyRuntimePanel onOpenTaskHome={() => dispatch({ type: "set-view", view: "backlog" })} />
          )
        )}
      </main>
    </div>
  );
}

function pageTitle(view: View) {
  const titles: Record<View, string> = {
    capabilities: "产品地图",
    delivery: "交付门禁",
    more: "更多能力",
    projects: "项目驾驶舱",
    mcp: "MCP Gateway 自动化边界",
    watcher: "Research / Spec / Plan Watcher",
    workbench: "IDE 工作台",
    backlog: "任务主页",
    loops: "自动 Loop 控制台",
    review: "Review / 交付门禁",
    teams: "Agent Teams 工作流",
    terminals: "Dev Terminals 命令面板",
    browser: "Browser Automation 验证面板",
    libraries: "资源库",
    notifications: "Notifications 状态路由",
    restore: "Restore Session 状态恢复",
    audit: "Audit Trail / 审计",
    runs: "Runs / 审计",
  };
  return titles[view];
}

function buildConductorKickoffPrompt(input: {
  projectPath: string;
  taskId: string;
  taskTitle: string;
  taskGoal: string;
  workerSessions: Array<{ id: string; name: string; role: string }>;
  taskSessionPlan?: TaskSessionPlan;
}) {
  const workers = input.workerSessions
    .map((session) => `- ${session.name} (${session.id}): ${session.role}`)
    .join("\n");

  return [
    "Start this Agent Workspace task now.",
    "",
    `Project: ${input.projectPath}`,
    `Task id: ${input.taskId}`,
    `Task title: ${input.taskTitle}`,
    `Task goal: ${input.taskGoal}`,
    "",
    "Available worker sessions:",
    workers || "- No worker sessions configured.",
    "",
    "Confirmed Task Session Plan:",
    formatTaskSessionPlanForKickoff(input.taskSessionPlan),
    "",
    "Use read_task_state at the start of a runtime-triggered turn to understand session states, available worker results, and pending decisions.",
    "Use call_session when a worker should do work. A successful call_session returns ok true, status delivered, deliveryState delivered, resultState pending, and turnPolicy stop_after_dispatch.",
    "After call_session returns ok true, end this Conductor turn and wait for a runtime wakeup. Do not synchronously wait, poll, or block on a just-dispatched worker result.",
    "If call_session returns ok false, correct the target/config if obvious; otherwise ask the user and stop.",
    "Use read_session only after the runtime reports that provider output is available or when you need to inspect existing session evidence.",
    "Do not wait for another instruction before beginning. Do not paste hidden protocol text into workers.",
  ].join("\n");
}

function formatTaskSessionPlanForKickoff(plan: TaskSessionPlan | undefined) {
  if (!plan) return "- No task-specific session plan supplied.";
  const workflow = plan.workflow?.length
    ? plan.workflow.map((step, index) => `${index + 1}. ${step}`).join("\n")
    : "- No workflow supplied.";
  const routeNotes = plan.routePolicy?.notes?.length
    ? plan.routePolicy.notes.map((note) => `- ${note}`).join("\n")
    : "- No route notes supplied.";
  const deliverables = plan.deliverables?.length
    ? plan.deliverables.map((item) => `- ${item}`).join("\n")
    : "- No deliverables supplied.";

  return [
    `Conductor: ${plan.conductor.name} - ${plan.conductor.role}`,
    "Workers:",
    ...plan.workers.map((worker) => `- ${worker.name}: ${worker.role}`),
    "Route policy:",
    routeNotes,
    "Workflow:",
    workflow,
    "Deliverables:",
    deliverables,
  ].join("\n");
}

function getOpencodeTaskTemplate(templateId: string | undefined) {
  return opencodeTaskTemplates.find((template) => template.id === templateId) ?? opencodeTaskTemplates[0];
}

function primaryViewFor(view: View): View {
  if (view === "backlog" || view === "workbench" || view === "delivery" || view === "more") {
    return view;
  }
  if (view === "review" || view === "runs" || view === "audit") {
    return "delivery";
  }
  return "more";
}

function EmptyRuntimePanel({ onOpenTaskHome }: { onOpenTaskHome: () => void }) {
  return (
    <section className="hub-layout">
      <div className="hub-panel">
        <div className="section-title compact">
          <span>还没有任务</span>
        </div>
        <p>先在任务主页创建任务，再打开这个任务相关视图。</p>
        <button className="primary-button" type="button" onClick={onOpenTaskHome}>
          新建任务
        </button>
      </div>
    </section>
  );
}

function DeliveryGateHub({ onOpenView }: { onOpenView: (view: View) => void }) {
  return (
    <section className="hub-layout">
      <div className="hub-panel">
        <div className="section-title">
          <FileDiff size={18} />
          <span>交付门禁</span>
        </div>
        <p>Review、Runs、Audit 聚合在同一个交付入口。</p>
        <div className="hub-grid">
          {deliveryEntries.map((entry) => (
            <HubCard entry={entry} key={entry.view} onOpenView={onOpenView} />
          ))}
        </div>
      </div>
    </section>
  );
}

function MoreHub({ onOpenView }: { onOpenView: (view: View) => void }) {
  return (
    <section className="hub-layout">
      <div className="hub-panel">
        <div className="section-title">
          <Blocks size={18} />
          <span>更多能力</span>
        </div>
        <p>项目、资源、自动化和产品地图都保留在二级入口。</p>
      </div>
      {moreGroups.map((group) => (
        <div className="hub-panel" key={group.title}>
          <div className="section-title compact">
            <span>{group.title}</span>
          </div>
          <p>{group.detail}</p>
          <div className="hub-grid">
            {group.entries.map((entry) => (
              <HubCard entry={entry} key={entry.view} onOpenView={onOpenView} />
            ))}
          </div>
        </div>
      ))}
    </section>
  );
}

function HubCard({
  entry,
  onOpenView,
}: {
  entry: ShellEntry;
  onOpenView: (view: View) => void;
}) {
  const Icon = entry.icon;

  return (
    <article className="hub-card">
      <div>
        <Icon size={18} />
        <strong>{entry.title}</strong>
      </div>
      <p>{entry.detail}</p>
      <button className="ghost-button" type="button" onClick={() => onOpenView(entry.view)}>
        {entry.cta}
      </button>
    </article>
  );
}

export default App;

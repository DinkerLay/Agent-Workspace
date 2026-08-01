import {
  Blocks,
  FileText,
  FolderOpen,
  Plus,
} from "lucide-react";
import { useEffect, useMemo, useReducer, useRef, useState, type FormEvent } from "react";
import {
  browserRuntimeStatus,
  activateNativeWorkspaceSession,
  appendNativeTaskEvent,
  callNativeSession,
  defaultOpencodeRunModel,
  enqueueNativeTerminalInput,
  generateNativeTaskDraft,
  getNativePtySession,
  getNativeRuntimeStatus,
  readNativeTaskState,
  registerNativeWorkspaceSessionProfile,
  resizeNativePtySession,
  subscribeNativePtyEvents,
  stopNativePtySession,
  type NativePtyEvent,
  type NativePtySession,
  type NativeRuntimeStatus,
} from "./runtime/nativeBridge";
import type { ReadTaskStateResult } from "./orchestration/conductor-tools";
import { createRuntimeWorkspaceState } from "./runtime/opencode";
import { getActiveRunForTask, prototypeReducer } from "./lib/taskMachine";
import { TaskBoard } from "./pages/TaskBoard";
import type { AgentSessionRecoveryRequest } from "./pages/TaskBoard";
import { Workbench } from "./pages/Workbench";
import { AgentLoopApp } from "./agent-loop/AgentLoopApp";
import { defaultAgentLaunchCommand } from "./lib/agentLaunchCommand";
import {
  appendPtyReadinessBuffer,
  cleanupNativePtySessionTracking,
  formatPtyInput,
  isLiveNativePtySession,
  isOpencodeTuiReady,
  mergeNativePtySession,
  normalizeNativePtySession,
  waitForNativePtySessionStop,
} from "./app/ptySessionUtils";
import { writeNativePtyDataWithRuntimeEvidence } from "./app/nativePtyTimeline";
import { navItems } from "./app/shellConfig";
import {
  createOpencodeSessionKey,
  getProjectRuntimeId,
  getTaskRuntimeId,
  opencodeTaskTemplates,
} from "./runtime/opencode";
import { buildOpenCodeConductorInjection } from "./runtime/adapters/opencode/conductorInjection";
import type {
  View,
  Agent,
  Project,
  PrototypeState,
  Task,
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

function createRuntimeOperationId(kind: string, sessionId: string) {
  const random = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${kind}:${sessionId}:${random}`;
}

function requestedSurface() {
  if (typeof window === "undefined") return "agent-loop";
  return new URLSearchParams(window.location.search).get("surface") === "legacy" ? "legacy" : "agent-loop";
}

function App({ initialState }: { initialState?: PrototypeState } = {}) {
  const { projectPath, projectName } = getRuntimeWorkspaceInput();
  if (requestedSurface() !== "legacy") {
    return <AgentLoopApp projectPath={projectPath} projectName={projectName} />;
  }

  return <LegacyPrototypeApp initialState={initialState ?? createInitialRuntimeWorkspaceState()} />;
}

function LegacyPrototypeApp({ initialState }: { initialState: PrototypeState }) {
  const [state, dispatch] = useReducer(prototypeReducer, initialState);
  const [primaryRailCollapsed, setPrimaryRailCollapsed] = useState(true);
  const [nativeRuntimeStatus, setNativeRuntimeStatus] = useState<NativeRuntimeStatus>(browserRuntimeStatus);
  const [nativePtySessionsByKey, setNativePtySessionsByKey] = useState<Record<string, NativePtySession | undefined>>({});
  const [nativeTaskStatesByRuntimeTaskId, setNativeTaskStatesByRuntimeTaskId] = useState<
    Record<string, ReadTaskStateResult | undefined>
  >({});
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
  const seededTaskRuntimeEventIdsRef = useRef<Set<string>>(new Set());
  const processedRuntimeCompletionClaimIdsRef = useRef<Set<string>>(new Set());
  const initialPtyInputFlushedIdsRef = useRef<Set<string>>(new Set());
  const outputAfterInitialPtyInputIdsRef = useRef<Set<string>>(new Set());
  const pendingInitialPtyInputsRef = useRef<Record<string, { sessionId: string; input: string; agent: Agent }>>({});

  const fallbackProject = initialState.projects[0];
  const fallbackAgentCluster = initialState.agentClusters[0];
  const selectedProject = state.projects.find((project) => project.id === state.selectedProjectId) ?? fallbackProject;
  const selectedProjectTasks = state.tasks.filter((task) => selectedProject.taskIds.includes(task.id));
  const selectedAgentCluster =
    state.agentClusters.find((cluster) => cluster.id === state.selectedAgentClusterId) ??
    state.agentClusters.find((cluster) => cluster.id === selectedProject.defaultAgentClusterId) ??
    fallbackAgentCluster;
  const selectedAgent = state.agents.find((agent) => agent.id === state.selectedAgentId);
  const selectedTask = state.tasks.find((task) => task.id === state.selectedTaskId);
  const selectedRun = selectedTask ? getActiveRunForTask(state.runs, selectedTask.id) : undefined;
  const selectedProjectRuntimeId = getProjectRuntimeId(selectedProject);
  const selectedTaskRuntimeId = selectedTask ? getTaskRuntimeId(selectedTask) : "no-task";
  const selectedTaskRuntimeState = selectedTask ? nativeTaskStatesByRuntimeTaskId[selectedTaskRuntimeId] : undefined;
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
    seededTaskRuntimeEventIdsRef.current.clear();
    processedRuntimeCompletionClaimIdsRef.current.clear();
    setNativePtySessionsByKey({});
    setNativeTaskStatesByRuntimeTaskId({});
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

  const storeNativeTaskState = (taskState: ReadTaskStateResult | undefined) => {
    if (!taskState?.taskId) return;
    setNativeTaskStatesByRuntimeTaskId((current) => ({ ...current, [taskState.taskId]: taskState }));
    routeRuntimeCompletionClaims(taskState);
  };

  const routeRuntimeCompletionClaims = (taskState: ReadTaskStateResult) => {
    const completionClaims = taskState.events?.filter((event) => event.type === "task.completion_claim") ?? [];
    if (completionClaims.length === 0) return;

    const task = state.tasks.find((item) => getTaskRuntimeId(item) === taskState.taskId);
    if (!task) return;

    for (const event of completionClaims) {
      const eventKey = `${taskState.taskId}:${event.id || event.cursor}`;
      if (processedRuntimeCompletionClaimIdsRef.current.has(eventKey)) continue;

      processedRuntimeCompletionClaimIdsRef.current.add(eventKey);
      if (task.status === "pending-review" || task.status === "done") continue;

      dispatch({ type: "agent-claims-done", taskId: task.id });
      dispatch({ type: "set-view", view: "backlog" });
      break;
    }
  };

  const refreshNativeTaskStateForTask = (task: Task | undefined = selectedTask) => {
    if (!task) return;
    const runtimeTaskId = getTaskRuntimeId(task);
    void readNativeTaskState({ taskId: runtimeTaskId })
      .then((taskState) => {
        storeNativeTaskState(taskState);
      })
      .catch(() => undefined);
  };

  const recordNativeTaskRuntimeEvent = (input: {
    task: Task;
    sessionId?: string;
    type: "task.user_message" | "user.intervention";
    summary: string;
    data: Record<string, unknown>;
  }) => {
    const runtimeTaskId = getTaskRuntimeId(input.task);
    return appendNativeTaskEvent({
      taskId: runtimeTaskId,
      sessionId: input.sessionId,
      cwd: selectedProject.path,
      type: input.type,
      summary: input.summary,
      data: input.data,
    })
      .then((result) => {
        storeNativeTaskState(result.taskState);
        if (!result.taskState) refreshNativeTaskStateForTask(input.task);
        return result;
      })
      .catch(() => {
        refreshNativeTaskStateForTask(input.task);
        return undefined;
      });
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
    if (!session.incarnationId) {
      initialPtyInputFlushedIdsRef.current.delete(session.id);
      dispatch({ type: "runtime-start-failed", reason: "Managed terminal is missing an incarnation identity." });
      return;
    }
    void enqueueNativeTerminalInput({
      workspaceSessionId: session.id,
      expectedIncarnationId: session.incarnationId,
      source: "startup",
      payload: formatPtyInput(pending.input),
      idempotencyKey: `startup:${session.id}:${session.incarnationId}`,
    })
      .then((write) => {
        storeNativePtySession(write?.result, { attach: false, agent: pending.agent });
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
    const taskRef = resolveNativeSessionRef(event.id);
    if (taskRef?.taskId) {
      refreshNativeTaskStateForTask(state.tasks.find((task) => task.id === taskRef.taskId));
    }

    const sessionKey = nativePtySessionKeysByIdRef.current[event.id];
    if (!sessionKey) {
      const resolved = taskRef;
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
      cleanupNativePtySessionTracking(
        {
          sessionKeysById: nativePtySessionKeysByIdRef.current,
          agentsById: nativePtyAgentsByIdRef.current,
          readinessBuffersById: nativePtyReadinessBuffersByIdRef.current,
          pendingEventsById: pendingNativePtyEventsByIdRef.current,
          initialInputFlushedIds: initialPtyInputFlushedIdsRef.current,
          outputAfterInitialInputIds: outputAfterInitialPtyInputIdsRef.current,
          pendingInitialInputsByKey: pendingInitialPtyInputsRef.current,
        },
        { sessionId: event.id, sessionKey },
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

  const registerNativeSessionProfileForTaskAgent = async (agent: Agent | undefined, sessionId?: string) => {
    if (!selectedTask || !agent) throw new Error("No task or agent selected for Session profile registration.");
    const resolvedSessionId =
      sessionId ??
      createOpencodeSessionKey({
        projectId: selectedProjectRuntimeId,
        taskId: selectedTaskRuntimeId,
        agentId: agent.id,
      });
    const sessionKey = nativeConversationKeyForAgent(agent);
    const terminalSize = nativeTerminalSizesByKey[sessionKey] ?? { cols: 100, rows: 30 };
    const isConductorAgent = selectedTaskConductorAgent?.id === agent.id;
    const conductorInjection =
      isConductorAgent && agent.provider === "opencode" ? buildConductorInjectionForCurrentTask(agent) : undefined;
    if (isConductorAgent && agent.provider === "opencode" && !conductorInjection) {
      throw new Error("Conductor MCP tool bridge is not available yet.");
    }

    const registered = await registerNativeWorkspaceSessionProfile({
      workspaceSessionId: resolvedSessionId,
      taskId: selectedTaskRuntimeId,
      provider: "opencode",
      cwd: selectedProject.path,
      model: agent.model,
      cols: terminalSize.cols,
      rows: terminalSize.rows,
      env: conductorInjection?.env,
      runtimeFiles: conductorInjection?.files,
    });
    if (!registered) throw new Error("Desktop Terminal Runtime is not available.");
    return resolvedSessionId;
  };

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

    startingNativePtySessionIdsRef.current.add(sessionId);
    void registerNativeSessionProfileForTaskAgent(agent, sessionId)
      .then(() =>
        activateNativeWorkspaceSession({
          workspaceSessionId: sessionId,
          operationId: createRuntimeOperationId("activate", sessionId),
        }),
      )
      .then((activation) => {
        const session = activation?.session;
        if (!session) throw new Error("Terminal Runtime did not return an activated Session.");
        storeNativePtySession(session, { agent });
        if (session.status === "running" && options.initialInput?.trim()) {
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

  useEffect(() => {
    if (!selectedTask || !nativeRuntimeStatus.available || nativeRuntimeStatus.ptyAvailable === false) return;
    for (const agent of selectedTaskAgents) {
      const sessionId = createOpencodeSessionKey({
        projectId: selectedProjectRuntimeId,
        taskId: selectedTaskRuntimeId,
        agentId: agent.id,
      });
      void registerNativeSessionProfileForTaskAgent(agent, sessionId).catch((error: unknown) => {
        dispatch({
          type: "runtime-start-failed",
          reason: error instanceof Error ? error.message : "Session profile registration failed",
        });
      });
    }
  }, [
    nativeRuntimeStatus.available,
    nativeRuntimeStatus.ptyAvailable,
    selectedProject.path,
    selectedTask?.id,
    selectedTask?.summary,
    selectedTask?.title,
    selectedTaskAgents.map((agent) => `${agent.id}:${agent.model}`).join(","),
  ]);

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

  useEffect(() => {
    if (!selectedTask || !nativeRuntimeStatus.available) return;
    const runtimeTaskId = getTaskRuntimeId(selectedTask);
    if (seededTaskRuntimeEventIdsRef.current.has(runtimeTaskId)) return;

    seededTaskRuntimeEventIdsRef.current.add(runtimeTaskId);
    void readNativeTaskState({ taskId: runtimeTaskId })
      .then((existingState) => {
        storeNativeTaskState(existingState);
        if (existingState?.events?.some((event) => event.type === "task.user_message")) return undefined;
        return recordNativeTaskRuntimeEvent({
          task: selectedTask,
          type: "task.user_message",
          summary: "Task user message",
          data: {
            message: selectedTask.summary || selectedTask.title,
            title: selectedTask.title,
            source: "task-intake",
          },
        });
      })
      .catch(() => undefined);
  }, [nativeRuntimeStatus.available, selectedProject.path, selectedTask?.id]);

  useEffect(() => {
    if (!selectedTask || !nativeRuntimeStatus.available) return;
    refreshNativeTaskStateForTask(selectedTask);
    const timer = window.setInterval(() => refreshNativeTaskStateForTask(selectedTask), 1500);
    return () => window.clearInterval(timer);
  }, [nativeRuntimeStatus.available, selectedTask?.id]);

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

  const writeManagedNativePtySession = async (
    session: NativePtySession | undefined,
    text: string,
    source: "user" | "user_message",
  ) => {
    if (!session?.incarnationId) return undefined;
    const write = await enqueueNativeTerminalInput({
      workspaceSessionId: session.id,
      expectedIncarnationId: session.incarnationId,
      source,
      payload: text,
    });
    return write?.result;
  };

  const writeRawToNativePtySession = (data: string) => {
    void writeNativePtyDataWithRuntimeEvidence({
      session: nativePtySession,
      task: selectedTask,
      data,
      source: "ide-terminal",
      summary: "User intervention sent from IDE terminal",
      writePtySession: (_id, text) => writeManagedNativePtySession(nativePtySession, text, "user"),
      storePtySession: (session) => {
        storeNativePtySession(session, { attach: false, agent: activeSelectedAgent });
      },
    });
  };

  const writeRawToSelectedTaskConductorPtySession = (data: string) => {
    void writeNativePtyDataWithRuntimeEvidence({
      session: conductorNativePtySession,
      task: selectedTask,
      data,
      ptyData: formatPtyInput(data.trimEnd()),
      source: "task-composer",
      summary: "User intervention sent to Conductor",
      writePtySession: (_id, text) => writeManagedNativePtySession(conductorNativePtySession, text, "user_message"),
      storePtySession: (session) => {
        storeNativePtySession(session, { attach: false, agent: selectedTaskConductorAgent });
      },
      recordRuntimeEvent: recordNativeTaskRuntimeEvent,
    });
  };

  const resizeCurrentNativePtySession = (cols: number, rows: number) => {
    setNativeTerminalSizesByKey((sizes) => ({ ...sizes, [nativeConversationKey]: { cols, rows } }));
    if (!nativePtySession || nativePtySession.status !== "running") return;
    void resizeNativePtySession(nativePtySession.id, { cols, rows }, nativePtySession.incarnationId).then((session) => {
      storeNativePtySession(session, { attach: false, agent: activeSelectedAgent });
    });
  };

  const resizeSelectedTaskConductorPtySession = (cols: number, rows: number) => {
    setNativeTerminalSizesByKey((sizes) => ({ ...sizes, [conductorNativeConversationKey]: { cols, rows } }));
    if (!conductorNativePtySession || conductorNativePtySession.status !== "running") return;
    void resizeNativePtySession(
      conductorNativePtySession.id,
      { cols, rows },
      conductorNativePtySession.incarnationId,
    ).then((session) => {
      storeNativePtySession(session, { attach: false, agent: selectedTaskConductorAgent });
    });
  };

  const stopCurrentNativePtySession = () => {
    if (!nativePtySession) return;
    void stopNativePtySession(nativePtySession.id, nativePtySession.incarnationId).then((session) => {
      storeNativePtySession(session, { attach: session?.status === "stopped" });
    });
  };

  const stopSelectedTaskConductorPtySession = () => {
    if (!conductorNativePtySession) return;
    void stopNativePtySession(conductorNativePtySession.id, conductorNativePtySession.incarnationId).then((session) => {
      storeNativePtySession(session, {
        attach: session?.status === "stopped",
        agent: selectedTaskConductorAgent,
      });
    });
  };

  const recoverAgentSession = (input: AgentSessionRecoveryRequest) => {
    const task = state.tasks.find((item) => item.id === input.taskId);
    const taskState = nativeTaskStatesByRuntimeTaskId[input.runtimeTaskId];
    const failedDispatch =
      taskState?.dispatches.find((dispatch) => dispatch.dispatchId === input.failedDispatchId) ??
      [...(taskState?.dispatches ?? [])]
        .reverse()
        .find((dispatch) => dispatch.toSessionId === input.sessionId && dispatch.status === "failed");
    if (!task || !failedDispatch?.assignment) return;
    const assignment = failedDispatch.assignment;
    const contextRefs = failedDispatch.contextRefs;
    const expectedOutput = failedDispatch.expectedOutput;
    const priority =
      failedDispatch.priority === "low" || failedDispatch.priority === "high" || failedDispatch.priority === "normal"
        ? failedDispatch.priority
        : undefined;

    const recoverySummary = agentRecoveryActionSummary(input.actionId);
    void (async () => {
      await appendNativeTaskEvent({
        taskId: input.runtimeTaskId,
        sessionId: input.sessionId,
        cwd: selectedProject.path,
        type: "user.intervention",
        summary: recoverySummary,
        data: {
          source: "agent-recovery-action",
          actionId: input.actionId,
          agentId: input.agentId,
          failedDispatchId: failedDispatch.dispatchId,
        },
      });

      if (recoveryActionStopsSession(input.actionId)) {
        const stoppedSession = await waitForNativePtySessionStop({
          sessionId: input.sessionId,
          stopSession: async (sessionId) => {
            const current = await getNativePtySession(sessionId);
            return stopNativePtySession(sessionId, current?.incarnationId);
          },
          getSession: getNativePtySession,
        });
        storeNativePtySession(stoppedSession, {
          attach: stoppedSession?.status === "stopped",
          agent: state.agents.find((agent) => agent.id === input.agentId),
          taskId: task.id,
        });
      }

      await callNativeSession({
        taskId: input.runtimeTaskId,
        toSessionId: input.sessionId,
        assignment,
        contextRefs,
        expectedOutput,
        priority,
        force: recoveryActionForcesDispatch(input.actionId),
      });
      refreshNativeTaskStateForTask(task);
    })();
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

        <div className="rail-directory-divider" aria-label="目录分割线" role="separator" />
        <ShellDirectoryTree
          collapsed={primaryRailCollapsed}
          selectedProject={selectedProject}
          selectedTaskId={state.selectedTaskId}
          tasks={selectedProjectTasks}
          onExpandRail={() => setPrimaryRailCollapsed(false)}
          onNewTask={() => {
            dispatch({ type: "clear-selected-task" });
            dispatch({ type: "set-view", view: "backlog" });
          }}
          onOpenRuntimeProject={openRuntimeProject}
          onSelectTask={(taskId) => {
            dispatch({ type: "select-task", taskId });
            dispatch({ type: "set-view", view: "backlog" });
          }}
        />
      </aside>

      <main className={`workspace workspace-${state.activeView}`}>
        <header className="topbar">
          <div>
            <div className="eyebrow">Agent Workspace</div>
            <h1>{pageTitle(state.activeView)}</h1>
          </div>
        </header>

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
            taskRuntimeState={selectedTaskRuntimeState}
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
            taskRuntimeState={selectedTaskRuntimeState}
            taskIntakeEvents={state.taskIntakeEvents}
            taskTransitionEvents={state.taskTransitionEvents}
            nativeRuntimeStatus={nativeRuntimeStatus}
            nativePtySession={conductorNativePtySession}
            agentLaunchCommand={selectedTaskConductorLaunchCommand}
            onGenerateTaskDraft={generateNativeTaskDraft}
            onCreateTaskFromIntake={(input) => dispatch({ type: "create-task-from-intake", ...input })}
            onOpenRuntimeProject={openRuntimeProject}
            onSelectTask={(taskId) => dispatch({ type: "select-task", taskId })}
            onAdvance={advanceTask}
            onStartAgent={startAgentFromRuntime}
            onStartConductorPty={startNativePtyForSelectedTaskConductor}
            onRefreshConductorPty={refreshSelectedTaskConductorPtySession}
            onWriteConductorPtyData={writeRawToSelectedTaskConductorPtySession}
            onResizeConductorPty={resizeSelectedTaskConductorPtySession}
            onStopConductorPty={stopSelectedTaskConductorPtySession}
            onOpenAgentTerminal={openAgentTerminal}
            onRecoverAgentSession={recoverAgentSession}
          />
        )}
      </main>
    </div>
  );
}

function pageTitle(view: View) {
  return view === "workbench" ? "IDE 工作台" : "任务主页";
}

function ShellDirectoryTree({
  collapsed,
  selectedProject,
  selectedTaskId,
  tasks,
  onExpandRail,
  onNewTask,
  onOpenRuntimeProject,
  onSelectTask,
}: {
  collapsed: boolean;
  selectedProject: Project;
  selectedTaskId: string;
  tasks: Task[];
  onExpandRail: () => void;
  onNewTask: () => void;
  onOpenRuntimeProject: (input: { projectPath: string; projectName: string }) => void;
  onSelectTask: (taskId: string) => void;
}) {
  const [addingProject, setAddingProject] = useState(false);
  const [projectPath, setProjectPath] = useState("");

  useEffect(() => {
    if (collapsed && addingProject) setAddingProject(false);
  }, [addingProject, collapsed]);

  const startProjectCreate = () => {
    if (collapsed) onExpandRail();
    setAddingProject(true);
  };

  const submitProject = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const nextPath = projectPath.trim();
    if (!nextPath) return;
    onOpenRuntimeProject({
      projectPath: nextPath,
      projectName: basename(nextPath) || "Project",
    });
    setProjectPath("");
    setAddingProject(false);
  };

  return (
    <section className="rail-directory-tree" aria-label="项目任务列表">
      <div className="rail-directory-heading">
        <span>项目</span>
        <button
          aria-label="新建项目"
          className="rail-icon-action"
          title="新建项目"
          type="button"
          onClick={startProjectCreate}
        >
          <Plus size={13} />
        </button>
      </div>
      {addingProject ? (
        <form className="rail-project-form" onSubmit={submitProject}>
          <label>
            <span>目录地址</span>
            <input
              aria-label="项目目录地址"
              value={projectPath}
              onChange={(event) => setProjectPath(event.target.value)}
              placeholder="/Users/dinker/CODES/TEMP_project/Agent_Test"
            />
          </label>
          <div className="rail-project-form-actions">
            <button className="rail-text-action" type="button" onClick={() => setAddingProject(false)}>
              取消
            </button>
            <button className="rail-text-action primary" disabled={!projectPath.trim()} type="submit">
              确定
            </button>
          </div>
        </form>
      ) : null}
      <div
        aria-label={`当前项目 ${selectedProject.name}`}
        className="rail-directory-root"
        title={`项目目录: ${selectedProject.path}`}
      >
        <FolderOpen size={17} />
        <span className="rail-directory-copy">
          <strong>{selectedProject.name}</strong>
        </span>
        <button
          aria-label={`新建任务 ${selectedProject.name}`}
          className="rail-icon-action rail-task-add"
          title="新建任务"
          type="button"
          onClick={onNewTask}
        >
          <Plus size={13} />
        </button>
      </div>
      <div className="rail-task-branch" aria-label={`${selectedProject.name} 任务`}>
        {tasks.map((task) => (
          <button
            aria-label={`打开任务 ${task.title}`}
            className={task.id === selectedTaskId ? "rail-task-leaf active" : "rail-task-leaf"}
            key={task.id}
            title={task.title}
            type="button"
            onClick={() => onSelectTask(task.id)}
          >
            <FileText size={14} />
            <span>{task.title}</span>
          </button>
        ))}
      </div>
    </section>
  );
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
    "Use claim_task_completion only after durable worker result evidence and required review context support final task completion.",
    "claim_task_completion records a structured task.completion_claim; normal terminal text is not a completion trigger.",
    "Do not wait for another instruction before beginning. Do not paste hidden protocol text into workers.",
  ].join("\n");
}

function formatTaskSessionPlanForKickoff(plan: TaskSessionPlan | undefined) {
  if (!plan) return "- No task-specific session plan supplied.";
  const orchestrationNotes = plan.workflow?.length
    ? plan.workflow.map((step, index) => `${index + 1}. ${step}`).join("\n")
    : "- No orchestration notes supplied.";
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
    "Conductor orchestration notes (not an executable Workflow):",
    orchestrationNotes,
    "Deliverables:",
    deliverables,
  ].join("\n");
}

function getOpencodeTaskTemplate(templateId: string | undefined) {
  return opencodeTaskTemplates.find((template) => template.id === templateId) ?? opencodeTaskTemplates[0];
}

function primaryViewFor(view: View): View {
  return view === "workbench" ? "workbench" : "backlog";
}

function agentRecoveryActionSummary(actionId: AgentSessionRecoveryRequest["actionId"]) {
  const labels: Record<AgentSessionRecoveryRequest["actionId"], string> = {
    retry_delivery: "User requested agent dispatch retry",
    stop_then_retry: "User requested stop agent session then retry dispatch",
    restart_fresh_then_retry: "User requested fresh agent session retry",
    force_retry: "User requested force dispatch retry",
  };
  return labels[actionId];
}

function recoveryActionStopsSession(actionId: AgentSessionRecoveryRequest["actionId"]) {
  return actionId === "stop_then_retry" || actionId === "restart_fresh_then_retry";
}

function recoveryActionForcesDispatch(actionId: AgentSessionRecoveryRequest["actionId"]) {
  return actionId === "force_retry";
}

export default App;

import {
  createRuntimeWorkspaceState,
  createOpencodeTaskClusterId,
  createTaskAgentsFromSessionPlan,
  createDefaultTaskSessionPlanFromTemplate,
  createRuntimeTaskId,
  normalizeTaskSessionPlan,
  opencodeTaskTemplates,
} from "../runtime/opencode";
import { createRunWorktreeContext } from "./worktreeContext";
import { createRunRuntimePolicy, opencodeAgentModel } from "./runtimePolicy";
import type {
  Agent,
  AgentCluster,
  AgentProfileEvent,
  AgentStatus,
  AgentRun,
  AgentTemplate,
  BrowserTool,
  BrowserEvidence,
  CommitStagingEvent,
  CommitRedactionScan,
  DevCommand,
  DevCommandEvent,
  LibraryItem,
  LoopScheduleEvent,
  McpServer,
  McpToolCallEvent,
  McpToolCallDecision,
  McpToolCallStatus,
  NotificationEvent,
  Project,
  ProjectContextEvent,
  PrototypeAction,
  PrototypeState,
  PullRequestHandoffEvent,
  NativeSessionEvidence,
  NativeVerificationEvidence,
  ReviewApprovalEvent,
  ReviewGateEvent,
  RestoreContextRecord,
  RestoreManifest,
  RestoreProcessRecord,
  RunStatus,
  Task,
  TaskArtifact,
  TaskIntakeEvent,
  TaskIntakeSource,
  TaskTransitionEvent,
  TeamRun,
  TeamWorkflow,
  TaskStatus,
  VerificationCommandEvent,
  VerificationStatus,
  View,
} from "../types";

const mcpServers: McpServer[] = [];
const libraryItems: LibraryItem[] = [];
const teamWorkflows: TeamWorkflow[] = [];
const browserTools: BrowserTool[] = [];

const nextStatus: Record<TaskStatus, TaskStatus> = {
  todo: "queued",
  queued: "running",
  running: "waiting-input",
  "waiting-input": "pending-review",
  "pending-review": "done",
  "failed-verification": "blocked",
  blocked: "todo",
  done: "todo",
};

export function prototypeReducer(state: PrototypeState, action: PrototypeAction): PrototypeState {
  switch (action.type) {
    case "set-view":
      return { ...state, activeView: action.view };
    case "select-project":
      return selectProject(state, action.projectId);
    case "open-runtime-project":
      return openRuntimeProject(action);
    case "select-mcp-server":
      return selectMcpServer(state, action.serverId);
    case "request-mcp-tool-call":
      return requestMcpToolCall(state, action.serverId, action.toolName);
    case "resolve-mcp-tool-call":
      return resolveMcpToolCall(state, action.eventId, action.decision);
    case "add-agent-from-template":
      return addAgentFromTemplate(state, action.templateId);
    case "select-agent-cluster":
      return selectAgentCluster(state, action.clusterId);
    case "select-agent":
      return selectAgent(state, action.agentId);
    case "select-review-agent":
      return { ...state, reviewAgentId: action.agentId };
    case "toggle-review-file":
      return toggleReviewFile(state, action.path);
    case "toggle-commit-conversation":
      return toggleCommitConversation(state);
    case "run-commit-redaction-scan":
      return runCommitRedactionScan(state, action.taskId);
    case "stage-review-files":
      return stageReviewFiles(state, action.taskId);
    case "run-verification-command":
      return runVerificationCommand(state, action.taskId);
    case "attach-native-verification-evidence":
      return attachNativeVerificationEvidence(state, action.taskId, action.runId, action.result);
    case "create-pr-handoff":
      return createPullRequestHandoff(state, action.runId);
    case "select-task":
      return selectTask(state, action.taskId);
    case "clear-selected-task":
      return { ...state, selectedTaskId: "" };
    case "set-prompt":
      return { ...state, prompt: action.prompt };
    case "send-prompt":
      return sendPrompt(state);
    case "insert-scratchpad-item":
      return insertScratchpadItem(state, action.itemId);
    case "attach-scratchpad-artifact":
      return attachScratchpadArtifact(state, action.itemId);
    case "save-scratchpad-draft":
      return saveScratchpadDraft(state);
    case "start-agent":
      return startAgent(state, action.taskId);
    case "start-dev-command":
      return setDevCommandStatus(state, action.commandId, "running", "Started by Dev Terminals command manager");
    case "stop-dev-command":
      return setDevCommandStatus(state, action.commandId, "stopped", "Stopped by Dev Terminals command manager");
    case "select-team-workflow":
      return selectTeamWorkflow(state, action.workflowId);
    case "start-team-run":
      return startTeamRun(state);
    case "advance-team-run":
      return advanceTeamRun(state);
    case "inject-library-prompt":
      return injectLibraryPrompt(state, action.itemId);
    case "attach-library-skill":
      return attachLibrarySkill(state, action.itemId);
    case "select-browser-tool":
      return selectBrowserTool(state, action.toolName);
    case "capture-browser-evidence":
      return captureBrowserEvidence(state);
    case "create-planner-task-from-watch":
      return createPlannerTaskFromWatch(state, action.eventId);
    case "create-task-from-intake":
      return createTaskFromIntake(state, action);
    case "route-notification":
      return routeNotification(state);
    case "open-notification-context":
      return openNotificationContext(state, action.eventId);
    case "acknowledge-notification":
      return acknowledgeNotification(state, action.eventId);
    case "open-audit-entry-context":
      return openAuditEntryContext(state, action.entryId);
    case "capture-restore-manifest":
      return captureRestoreManifest(state);
    case "restore-workspace-session":
      return restoreWorkspaceSession(state);
    case "runtime-started-agent":
      return runtimeStartedAgent(state, action);
    case "attach-native-session-evidence":
      return attachNativeSessionEvidence(state, action);
    case "runtime-start-failed":
      return {
        ...state,
        terminalLines: [...state.terminalLines, `runtime: start failed - ${action.reason}`],
      };
    case "apply-terminal-signal":
      return applyTerminalSignal(state, action.eventId);
    case "agent-claims-done":
      return agentClaimsDone(state, action.taskId);
    case "verification-failed":
      return verificationFailed(state, action.taskId);
    case "approve-review":
      return approveReview(state, action.taskId);
    case "advance-task":
      return advanceTask(state, action.taskId);
    default:
      return state;
  }
}

const intakeSourceLabels: Record<TaskIntakeSource, string> = {
  "manual-brief": "Manual brief",
  watcher: "docs product-intent watcher",
  "screenshot-prototype": "Screenshot / prototype",
  "prompt-context": "Prompt context",
};

function nextTaskIntakeSequence(state: PrototypeState) {
  const taskSuffix = maxNumericSuffix(
    state.tasks.map((task) => task.id),
    /^task-intake-(\d+)$/,
  );
  const eventSuffix = maxNumericSuffix(
    state.taskIntakeEvents.map((event) => event.id),
    /^task-intake-event-(\d+)$/,
  );

  return Math.max(taskSuffix, eventSuffix) + 1;
}

function maxNumericSuffix(ids: string[], pattern: RegExp) {
  return ids.reduce((max, id) => {
    const match = id.match(pattern);
    const suffix = match ? Number.parseInt(match[1], 10) : Number.NaN;
    return Number.isFinite(suffix) && suffix > max ? suffix : max;
  }, 0);
}

function openRuntimeProject(action: Extract<PrototypeAction, { type: "open-runtime-project" }>): PrototypeState {
  const projectPath = action.projectPath.trim();
  const projectName = action.projectName.trim() || basename(projectPath) || "Workspace";

  if (!projectPath) {
    return createRuntimeWorkspaceState({
      projectPath: "/Users/dinker/CODES/Agent-Workspace",
      projectName: "Agent Workspace",
    });
  }

  return createRuntimeWorkspaceState({ projectPath, projectName });
}

function createTaskFromIntake(
  state: PrototypeState,
  action: Extract<PrototypeAction, { type: "create-task-from-intake" }>,
): PrototypeState {
  const title = action.title.trim();
  if (!title) return state;

  const selectedProject = state.projects.find((project) => project.id === state.selectedProjectId) ?? state.projects[0];
  if (!selectedProject) return state;

  const sequence = nextTaskIntakeSequence(state);
  const suffix = String(sequence).padStart(3, "0");
  const taskId = `task-intake-${suffix}`;
  const runtimeTaskId = createRuntimeTaskId();
  const summary = action.summary.trim() || "No description captured yet.";
  const labels = action.labels.map((label) => label.trim()).filter(Boolean);
  const artifactPath = action.artifactPath?.trim() || undefined;
  const owner = action.owner || "Conductor";
  const model = action.model?.trim() || opencodeAgentModel;
  const template = opencodeTaskTemplates.find((item) => item.id === action.templateId) ?? opencodeTaskTemplates[0];
  const sessionPlan = normalizeTaskSessionPlan(
    action.sessionPlan,
    createDefaultTaskSessionPlanFromTemplate({
      templateId: template.id,
      model,
      taskTitle: title,
      taskGoal: summary,
    }),
  );
  const task: Task = {
    id: taskId,
    runtimeTaskId,
    title,
    status: "running",
    source: intakeSourceLabels[action.intakeSource],
    owner,
    risk: "Conductor auto-started; execution evidence must come from the real PTY session",
    verification: "Conductor terminal starts from intake and records task context",
    summary,
    labels,
    templateId: template.id,
    sessionPlan,
  };
  const intakeEvent: TaskIntakeEvent = {
    id: `task-intake-event-${suffix}`,
    taskId,
    runtimeTaskId,
    source: action.intakeSource,
    title,
    summary,
    labels,
    owner,
    templateId: template.id,
    sessionPlan,
    artifactPath,
    evidencePath: ".agent-workspace/tasks/intake.jsonl",
    status: "queued",
    createdAt: "2026-06-24T14:45:00Z",
  };
  const clusterId = createOpencodeTaskClusterId(selectedProject.id, task.id);
  const taskCluster: AgentCluster = {
    id: clusterId,
    projectId: selectedProject.id,
    runtimeTaskId,
    name: task.title,
    level: "task",
    taskId: task.id,
    parentClusterId: selectedProject.defaultAgentClusterId,
    agentIds: [],
    evidencePath: `.agent-workspace/tasks/${task.id}/cluster.json`,
  };
  const agents = createTaskAgentsFromSessionPlan({
    templateId: template.id,
    projectId: selectedProject.id,
    taskId: task.id,
    runtimeTaskId,
    clusterId,
    model,
    sessionPlan,
  });
  const conductor = agents.find((agent) => agent.name === "Conductor") ?? agents[0];
  const agentIds = agents.map((agent) => agent.id);
  const populatedTaskCluster = { ...taskCluster, agentIds };

  return {
    ...state,
    activeView: "backlog",
    selectedTaskId: taskId,
    selectedAgentClusterId: populatedTaskCluster.id,
    selectedAgentId: conductor?.id ?? "",
    projects: state.projects.map((project) =>
      project.id === selectedProject.id
        ? {
            ...project,
            taskIds: [...project.taskIds, task.id],
            agentClusterIds: [...project.agentClusterIds, populatedTaskCluster.id],
            agentIds: [...project.agentIds, ...agentIds],
          }
        : project,
    ),
    agentClusters: [...state.agentClusters, populatedTaskCluster],
    agents: [...state.agents, ...agents],
    tasks: [...state.tasks, task],
    taskIntakeEvents: [...state.taskIntakeEvents, intakeEvent],
    terminalLines: [
      ...state.terminalLines,
      `task intake: captured ${taskId} from ${action.intakeSource}; created ${template.label} agent sessions`,
    ],
  };
}

function selectProject(state: PrototypeState, projectId: string): PrototypeState {
  const project = state.projects.find((item) => item.id === projectId);
  if (!project) return state;
  const selectedCluster = getClusterForProjectSelection(state, project);
  const selectedTaskId = project.taskIds.includes(state.selectedTaskId)
    ? state.selectedTaskId
    : (project.taskIds[0] ?? state.selectedTaskId);
  const selectedTask = state.tasks.find((task) => task.id === selectedTaskId);
  const taskCluster = selectedTask ? getClusterForTask(state.agentClusters, project, selectedTask) : selectedCluster;
  const activeCluster = taskCluster ?? selectedCluster;
  const ownerAgent = selectedTask && activeCluster ? getAgentForTask(state.agents, selectedTask, activeCluster) : undefined;
  const selectedAgentId =
    ownerAgent && activeCluster?.agentIds.includes(ownerAgent.id)
      ? ownerAgent.id
      : activeCluster?.agentIds.includes(state.selectedAgentId)
        ? state.selectedAgentId
        : (activeCluster?.agentIds[0] ?? state.selectedAgentId);

  return {
    ...state,
    selectedProjectId: project.id,
    selectedAgentClusterId: activeCluster?.id ?? state.selectedAgentClusterId,
    selectedTaskId,
    selectedAgentId,
    projectContextEvents: [...state.projectContextEvents, createProjectContextEvent(state, project)],
    terminalLines: [...state.terminalLines, `project: selected ${project.name}`],
  };
}

function selectTask(state: PrototypeState, taskId: string): PrototypeState {
  const task = state.tasks.find((item) => item.id === taskId);
  if (!task) return state;

  const currentProject = state.projects.find((project) => project.id === state.selectedProjectId);
  const owningProject = currentProject?.taskIds.includes(task.id)
    ? currentProject
    : state.projects.find((project) => project.taskIds.includes(task.id));
  const selectedCluster = owningProject ? getClusterForTask(state.agentClusters, owningProject, task) : undefined;
  const ownerAgent = selectedCluster ? getAgentForTask(state.agents, task, selectedCluster) : getAgentForTask(state.agents, task);

  return {
    ...state,
    selectedTaskId: task.id,
    selectedProjectId: owningProject?.id ?? state.selectedProjectId,
    selectedAgentClusterId: selectedCluster?.id ?? state.selectedAgentClusterId,
    selectedAgentId:
      ownerAgent && (!selectedCluster || selectedCluster.agentIds.includes(ownerAgent.id))
        ? ownerAgent.id
        : state.selectedAgentId,
  };
}

function selectAgentCluster(state: PrototypeState, clusterId: string): PrototypeState {
  const cluster = state.agentClusters.find((item) => item.id === clusterId);
  if (!cluster) return state;
  const project = state.projects.find((item) => item.id === cluster.projectId);
  const selectedAgentId = cluster.agentIds.includes(state.selectedAgentId)
    ? state.selectedAgentId
    : (cluster.agentIds[0] ?? state.selectedAgentId);
  const clusterTaskId = cluster.taskId && project?.taskIds.includes(cluster.taskId) ? cluster.taskId : state.selectedTaskId;

  return {
    ...state,
    selectedProjectId: project?.id ?? state.selectedProjectId,
    selectedAgentClusterId: cluster.id,
    selectedAgentId,
    selectedTaskId: clusterTaskId,
  };
}

function selectAgent(state: PrototypeState, agentId: string): PrototypeState {
  const agent = state.agents.find((item) => item.id === agentId);
  if (!agent) return state;

  const agentCluster = state.agentClusters.find((cluster) => cluster.id === agent.clusterId);
  const currentProject = state.projects.find((project) => project.id === (agent.projectId ?? state.selectedProjectId));
  const agentTask = state.tasks.find((task) => task.id === agent.taskId);
  const agentTaskBelongsToCurrentProject = agentTask ? currentProject?.taskIds.includes(agentTask.id) : false;

  return {
    ...state,
    selectedProjectId: currentProject?.id ?? state.selectedProjectId,
    selectedAgentClusterId: agentCluster?.id ?? state.selectedAgentClusterId,
    selectedAgentId: agent.id,
    selectedTaskId: agentTaskBelongsToCurrentProject && agentTask ? agentTask.id : state.selectedTaskId,
  };
}

function getDefaultCluster(agentClusters: AgentCluster[], project: Project): AgentCluster | undefined {
  return agentClusters.find((cluster) => cluster.id === project.defaultAgentClusterId);
}

function getClusterForProjectSelection(state: PrototypeState, project: Project): AgentCluster | undefined {
  const currentCluster = state.agentClusters.find((cluster) => cluster.id === state.selectedAgentClusterId);
  if (currentCluster && currentCluster.projectId === project.id && currentCluster.level === "task") return currentCluster;

  const selectedTask = state.tasks.find((task) => task.id === state.selectedTaskId && project.taskIds.includes(task.id));
  const selectedTaskCluster = selectedTask ? getClusterForTask(state.agentClusters, project, selectedTask) : undefined;
  if (selectedTaskCluster) return selectedTaskCluster;

  const firstTaskCluster = state.agentClusters.find(
    (cluster) => cluster.projectId === project.id && cluster.level === "task",
  );
  return firstTaskCluster ?? getDefaultCluster(state.agentClusters, project);
}

function getClusterForTask(agentClusters: AgentCluster[], project: Project, task: Task): AgentCluster | undefined {
  return agentClusters.find(
    (cluster) => cluster.projectId === project.id && cluster.level === "task" && cluster.taskId === task.id,
  );
}

function createProjectContextEvent(state: PrototypeState, project: Project): ProjectContextEvent {
  const sequence = state.projectContextEvents.filter((event) => event.projectId === project.id).length + 1;

  return {
    id: `project-context-${project.id}-${String(sequence).padStart(3, "0")}`,
    projectId: project.id,
    zone: project.zone,
    manifestPath: `.agent-workspace/projects/${project.id}.json`,
    browserProfile: project.browserProfile,
    selectedAt: "2026-06-24T13:50:00Z",
    summary: `Selected ${project.name} workspace context`,
  };
}

function selectMcpServer(state: PrototypeState, serverId: string): PrototypeState {
  const server = mcpServers.find((item) => item.id === serverId);
  if (!server) return state;

  return {
    ...state,
    selectedMcpServerId: server.id,
    terminalLines: [...state.terminalLines, `mcp: selected ${server.name}`],
  };
}

function requestMcpToolCall(state: PrototypeState, serverId: string, toolName: string): PrototypeState {
  const server = mcpServers.find((item) => item.id === serverId);
  const tool = server?.tools.find((item) => item.name === toolName);
  if (!server || !tool) return state;

  const sequence =
    state.mcpToolEvents.filter((event) => event.serverId === server.id && event.toolName === tool.name).length + 1;
  const status: McpToolCallStatus = tool.permission === "confirm" ? "confirmation-required" : "routed";
  const event: McpToolCallEvent = {
    id: `mcp-event-${tool.name.replace(/_/g, "-")}-${String(sequence).padStart(3, "0")}`,
    taskId: state.selectedTaskId,
    serverId: server.id,
    toolName: tool.name,
    permission: tool.permission,
    status,
    evidencePath: tool.evidence,
    targetSurface: tool.targetSurface,
    summary:
      status === "confirmation-required"
        ? `${tool.name} requested by agent; scheduler confirmation required`
        : `${tool.name} routed through ${server.name}; evidence recorded`,
  };

  return {
    ...state,
    mcpToolEvents: [...state.mcpToolEvents, event],
    terminalLines: [...state.terminalLines, `mcp: requested ${tool.name} on ${server.name} -> ${status}`],
  };
}

function resolveMcpToolCall(
  state: PrototypeState,
  eventId: string,
  decision: McpToolCallDecision,
): PrototypeState {
  const event = state.mcpToolEvents.find((item) => item.id === eventId);
  if (!event || event.status !== "confirmation-required") return state;
  const server = mcpServers.find((item) => item.id === event.serverId);
  const decisionSummary =
    decision === "approved"
      ? `Scheduler approved ${event.toolName} for ${server?.name ?? event.serverId}; tool execution may proceed.`
      : `Scheduler denied ${event.toolName} for ${server?.name ?? event.serverId}; no tool execution should proceed.`;
  const nextEvent: McpToolCallEvent = {
    ...event,
    status: decision,
    decision,
    decisionEvidencePath: `.agent-workspace/mcp/${event.id}/confirmation.json`,
    decidedAt: "2026-06-24T14:40:00Z",
    decisionSummary,
  };

  return {
    ...state,
    mcpToolEvents: state.mcpToolEvents.map((item) => (item.id === event.id ? nextEvent : item)),
    terminalLines: [...state.terminalLines, `mcp: ${decision} ${event.toolName} through scheduler confirmation`],
  };
}

function addAgentFromTemplate(state: PrototypeState, templateId: string): PrototypeState {
  const template = state.agentTemplates.find((item) => item.id === templateId);
  const project = state.projects.find((item) => item.id === state.selectedProjectId);
  const cluster =
    state.agentClusters.find((item) => item.id === state.selectedAgentClusterId && item.projectId === project?.id) ??
    (project ? getDefaultCluster(state.agentClusters, project) : undefined);
  if (!template || !project || !cluster) return state;

  const sequence =
    state.agents.filter((agent) => agent.id === template.agentIdPrefix || agent.id.startsWith(`${template.agentIdPrefix}-`))
      .length + 1;
  const agentId = `${template.agentIdPrefix}-${String(sequence).padStart(3, "0")}`;
  const agent: Agent = {
    id: agentId,
    projectId: project.id,
    clusterId: cluster.id,
    name: template.name,
    role: template.role,
    provider: template.provider,
    model: template.model,
    status: "idle",
    taskId: state.selectedTaskId,
    accent: template.accent,
    lastActive: "new",
  };
  const profileEvent = createAgentProfileEvent(project, agent, template);

  return {
    ...state,
    activeView: "workbench",
    selectedAgentId: agent.id,
    selectedAgentClusterId: cluster.id,
    agents: [...state.agents, agent],
    agentClusters: state.agentClusters.map((item) =>
      item.id === cluster.id ? { ...item, agentIds: [...item.agentIds, agent.id] } : item,
    ),
    agentProfileEvents: [...state.agentProfileEvents, profileEvent],
    projects: state.projects.map((item) =>
      item.id === project.id ? { ...item, agentIds: [...item.agentIds, agent.id] } : item,
    ),
    terminalLines: [...state.terminalLines, `agent setup: added ${agent.name} to ${project.name}; PTY pending`],
  };
}

function createAgentProfileEvent(project: Project, agent: Agent, template: AgentTemplate): AgentProfileEvent {
  return {
    id: `agent-profile-${agent.id}`,
    projectId: project.id,
    agentId: agent.id,
    templateId: template.id,
    systemPromptPath: template.systemPromptPath,
    worktreePolicy: template.worktreePolicy,
    manifestPath: `.agent-workspace/agents/${agent.id}.json`,
    createdAt: "2026-06-24T13:55:00Z",
    summary: `Created ${agent.name} profile for ${project.name}`,
  };
}

function injectLibraryPrompt(state: PrototypeState, itemId: string): PrototypeState {
  const item = findLibraryItem(itemId, "prompt");
  if (!item) return state;

  const task = state.tasks.find((candidate) => candidate.id === state.selectedTaskId);
  const agent = state.agents.find((candidate) => candidate.id === state.selectedAgentId) ?? state.agents[0];
  const prompt = [
    `Use prompt template: ${item.name}`,
    `Template source: ${item.target}`,
    task ? `Task: ${task.id} - ${task.title}` : "Task: not selected",
    `Agent: ${agent.name}`,
  ].join("\n");

  return {
    ...state,
    activeView: "workbench",
    activePromptTemplateId: item.id,
    prompt,
    terminalLines: [...state.terminalLines, `library: injected prompt template ${item.name}`],
  };
}

function attachLibrarySkill(state: PrototypeState, itemId: string): PrototypeState {
  const item = findLibraryItem(itemId, "skill");
  if (!item) return state;

  const attachedSkillIds = state.attachedSkillIds.includes(item.id)
    ? state.attachedSkillIds
    : [...state.attachedSkillIds, item.id];

  return {
    ...state,
    attachedSkillIds,
    terminalLines: [...state.terminalLines, `library: attached skill ${item.name}`],
  };
}

function findLibraryItem(itemId: string, kind: LibraryItem["kind"]) {
  return libraryItems.find((item) => item.id === itemId && item.kind === kind);
}

function toggleReviewFile(state: PrototypeState, path: string): PrototypeState {
  const selection = state.reviewFileSelections.find((file) => file.path === path);
  if (!selection) return state;

  const selected = !selection.selected;
  return {
    ...state,
    reviewFileSelections: state.reviewFileSelections.map((file) =>
      file.path === path ? { ...file, selected } : file,
    ),
    terminalLines: [
      ...state.terminalLines,
      `review: ${selected ? "included" : "excluded"} ${path} ${selected ? "in" : "from"} scoped commit`,
    ],
  };
}

function toggleCommitConversation(state: PrototypeState): PrototypeState {
  const commitConversationIncluded = !state.commitConversationIncluded;
  return {
    ...state,
    commitConversationIncluded,
    terminalLines: [
      ...state.terminalLines,
      `commit context: Agent-Conversation trailer ${commitConversationIncluded ? "enabled" : "disabled"}`,
    ],
  };
}

function runCommitRedactionScan(state: PrototypeState, taskId: string): PrototypeState {
  const run = getActiveRunForTask(state.runs, taskId);
  if (!run) return state;

  const scan: CommitRedactionScan = {
    runId: run.id,
    status: "passed",
    transcriptPath: run.transcriptPath,
    artifactPath: `.agent-workspace/runs/${run.id}/redaction.json`,
    redactedPatterns: ["API key", ".env", "token"],
  };

  return {
    ...state,
    commitRedactionScans: upsertCommitRedactionScan(state.commitRedactionScans, scan),
    terminalLines: [...state.terminalLines, `commit context: redaction scan passed for ${run.id}`],
  };
}

function stageReviewFiles(state: PrototypeState, taskId: string): PrototypeState {
  const run = getActiveRunForTask(state.runs, taskId);
  const task = state.tasks.find((item) => item.id === taskId);
  if (!run || !task) return state;

  const event = createCommitStagingEvent(state, task.id, run.id);
  const commitContext = {
    ...commitMessageContext(state, run),
    stagingEvidencePath: event.evidencePath,
  };

  return {
    ...state,
    commitStagingEvents: [...state.commitStagingEvents, event],
    runs: updateRun(state.runs, run.id, (current) => ({
      ...current,
      commitProposal: {
        ...current.commitProposal,
        message: buildCommitMessage(task, current.id, current.verification.status, commitContext),
      },
    })),
    terminalLines: [
      ...state.terminalLines,
      `git: staged ${event.stagedFilePaths.length} scoped files for ${run.id}; ${event.unstagedFilePaths.length} left unstaged`,
    ],
  };
}

function createCommitStagingEvent(
  state: PrototypeState,
  taskId: string,
  runId: string,
): CommitStagingEvent {
  const sequence = state.commitStagingEvents.filter((event) => event.runId === runId).length + 1;
  const stagedFilePaths = state.reviewFileSelections.filter((file) => file.selected).map((file) => file.path);
  const unstagedFilePaths = state.reviewFileSelections.filter((file) => !file.selected).map((file) => file.path);

  return {
    id: `commit-staging-${runId}-${String(sequence).padStart(3, "0")}`,
    taskId,
    runId,
    status: "staged",
    stagedFilePaths,
    unstagedFilePaths,
    evidencePath: `.agent-workspace/runs/${runId}/staging.json`,
    createdAt: "2026-06-24T14:22:00Z",
    summary: `Staged ${stagedFilePaths.length} scoped files for ${taskId}; ${unstagedFilePaths.length} left unstaged.`,
  };
}

function runVerificationCommand(state: PrototypeState, taskId: string): PrototypeState {
  const run = getActiveRunForTask(state.runs, taskId);
  const task = state.tasks.find((item) => item.id === taskId);
  if (!run || !task) return state;

  const command = run.verification.command || "npm test && npm run build";
  const event = createVerificationCommandEvent(state, task.id, run.id, command, "passed");
  const verification = {
    ...run.verification,
    command,
    status: event.status,
    summary: event.summary,
    logPath: event.logPath,
  };

  return {
    ...state,
    verificationEvents: [...state.verificationEvents, event],
    runs: updateRun(state.runs, run.id, (current) => ({
      ...current,
      verification,
      commitProposal: {
        ...current.commitProposal,
        message: buildCommitMessage(task, current.id, event.status, commitMessageContext(state, current)),
      },
    })),
    terminalLines: [...state.terminalLines, `verification: ran ${command} for ${run.id} -> ${event.status}`],
  };
}

function attachNativeVerificationEvidence(
  state: PrototypeState,
  taskId: string,
  runId: string,
  result: NativeVerificationEvidence,
): PrototypeState {
  const run = state.runs.find((item) => item.id === runId && item.taskId === taskId);
  const task = state.tasks.find((item) => item.id === taskId);
  if (!run || !task) return state;

  const event = createNativeVerificationCommandEvent(state, task.id, run.id, result);
  const verification = {
    ...run.verification,
    command: result.command,
    status: result.status,
    summary: nativeVerificationSummary(result),
    logPath: result.logPath,
  };

  return {
    ...state,
    verificationEvents: [...state.verificationEvents, event],
    runs: updateRun(state.runs, run.id, (current) => ({
      ...current,
      verification,
      verificationPath: result.artifactPath,
      commitProposal: {
        ...current.commitProposal,
        message: buildCommitMessage(task, current.id, result.status, commitMessageContext(state, current)),
      },
    })),
    terminalLines: [...state.terminalLines, `verification: native ${result.command} for ${run.id} -> ${result.status}`],
  };
}

function createVerificationCommandEvent(
  state: PrototypeState,
  taskId: string,
  runId: string,
  command: string,
  status: VerificationCommandEvent["status"],
): VerificationCommandEvent {
  const sequence = state.verificationEvents.filter((event) => event.runId === runId).length + 1;

  return {
    id: `verification-${runId}-${String(sequence).padStart(3, "0")}`,
    taskId,
    runId,
    command,
    status,
    artifactPath: `.agent-workspace/runs/${runId}/verification.json`,
    logPath: `.agent-workspace/runs/${runId}/verification.log`,
    createdAt: "2026-06-24T14:20:00Z",
    summary: `Verification command ${status} and evidence was recorded by the Review gate.`,
  };
}

function createNativeVerificationCommandEvent(
  state: PrototypeState,
  taskId: string,
  runId: string,
  result: NativeVerificationEvidence,
): VerificationCommandEvent {
  const sequence = state.verificationEvents.filter((event) => event.runId === runId).length + 1;

  return {
    id: `verification-${runId}-${String(sequence).padStart(3, "0")}`,
    taskId,
    runId,
    command: result.command,
    status: result.status,
    artifactPath: result.artifactPath,
    logPath: result.logPath,
    createdAt: "2026-06-24T14:20:00Z",
    summary: nativeVerificationSummary(result),
  };
}

function nativeVerificationSummary(result: NativeVerificationEvidence): string {
  if (result.status === "passed") return `Native verification command passed with exit code ${result.exitCode}.`;
  return `Native verification command failed: ${result.error ?? `exit code ${result.exitCode}`}.`;
}

function insertScratchpadItem(state: PrototypeState, itemId: string): PrototypeState {
  const item = state.scratchpadItems.find((candidate) => candidate.id === itemId);
  if (!item) return state;

  const scratchpadAttachmentIds = state.scratchpadAttachmentIds.includes(item.id)
    ? state.scratchpadAttachmentIds
    : [...state.scratchpadAttachmentIds, item.id];
  const prompt = state.prompt.trimEnd() ? `${state.prompt.trimEnd()}\n${item.insertText}` : item.insertText;

  return {
    ...state,
    prompt,
    scratchpadAttachmentIds,
    terminalLines: [...state.terminalLines, `scratchpad: inserted ${item.summary}`],
  };
}

function saveScratchpadDraft(state: PrototypeState): PrototypeState {
  const savedAt = "2026-06-24T13:40:00Z";
  const taskSaves = state.promptLibrarySaves.filter((save) => save.taskId === state.selectedTaskId);
  const sequence = taskSaves.length + 1;
  const saveRecord = {
    id: `prompt-save-${state.selectedTaskId}-${String(sequence).padStart(3, "0")}`,
    taskId: state.selectedTaskId,
    sourceDraftPath: state.scratchpadDraftPath,
    targetPath: ".agent-workspace/prompts.json",
    artifactPath: `.agent-workspace/prompts/${state.selectedTaskId}-${String(sequence).padStart(3, "0")}.md`,
    savedAt,
  };

  return {
    ...state,
    scratchpadSavedAt: savedAt,
    promptLibrarySaves: [...state.promptLibrarySaves, saveRecord],
    terminalLines: [...state.terminalLines, "scratchpad: saved draft to .agent-workspace/prompts.json"],
  };
}

function attachScratchpadArtifact(state: PrototypeState, itemId: string): PrototypeState {
  const item = state.scratchpadItems.find((candidate) => candidate.id === itemId);
  const task = state.tasks.find((candidate) => candidate.id === state.selectedTaskId);
  if (!item || !task) return state;

  const sequence = state.taskArtifacts.filter((artifact) => artifact.taskId === task.id).length + 1;
  const suffix = String(sequence).padStart(3, "0");
  const artifact: TaskArtifact = {
    id: `task-artifact-${task.id}-${suffix}`,
    taskId: task.id,
    kind: item.kind,
    label: item.label,
    sourceSurface: "workbench",
    sourceArtifactPath: item.artifactPath,
    artifactPath: `.agent-workspace/tasks/${task.id}/artifacts/${item.id}-${suffix}.json`,
    addedAt: "2026-06-24T14:10:00Z",
    summary: `Attached ${item.summary} to ${task.id}`,
  };

  return {
    ...state,
    taskArtifacts: [...state.taskArtifacts, artifact],
    terminalLines: [...state.terminalLines, `task artifact: attached ${item.label} to ${task.id}`],
  };
}

function selectTeamWorkflow(state: PrototypeState, workflowId: string): PrototypeState {
  const workflow = teamWorkflows.find((item) => item.id === workflowId);
  if (!workflow) return state;

  return {
    ...state,
    selectedTeamWorkflowId: workflow.id,
    terminalLines: [...state.terminalLines, `team: selected ${workflow.name}`],
  };
}

function startTeamRun(state: PrototypeState): PrototypeState {
  const workflow = teamWorkflows.find((item) => item.id === state.selectedTeamWorkflowId) ?? teamWorkflows[0];
  if (!workflow) return state;

  const teamRun = createTeamRun(workflow);
  return {
    ...state,
    selectedTeamWorkflowId: workflow.id,
    teamRuns: [...state.teamRuns.filter((item) => item.id !== teamRun.id), teamRun],
    terminalLines: [...state.terminalLines, `team: started ${workflow.name}`],
  };
}

function advanceTeamRun(state: PrototypeState): PrototypeState {
  const workflow = teamWorkflows.find((item) => item.id === state.selectedTeamWorkflowId);
  const activeRun = getSelectedTeamRun(state);
  if (!workflow || !activeRun || activeRun.status !== "running") return state;

  const lastNodeIndex = workflow.nodes.length - 1;
  const atLastNode = activeRun.activeNodeIndex >= lastNodeIndex;
  let nextRun: TeamRun;
  let terminalLine: string;

  if (atLastNode && activeRun.cycle >= activeRun.maxCycles) {
    nextRun = {
      ...activeRun,
      activeNodeIndex: lastNodeIndex,
      status: "blocked",
    };
    terminalLine = `team: blocked ${activeRun.id} at max cycle ${activeRun.maxCycles}`;
  } else if (atLastNode) {
    const nextCycle = activeRun.cycle + 1;
    nextRun = {
      ...activeRun,
      activeNodeIndex: 0,
      cycle: nextCycle,
      status: "running",
    };
    terminalLine = `team: handoff ${activeRun.id} -> ${workflow.nodes[0]} (cycle ${nextCycle})`;
  } else {
    const nextNodeIndex = activeRun.activeNodeIndex + 1;
    nextRun = {
      ...activeRun,
      activeNodeIndex: nextNodeIndex,
      status: "running",
    };
    terminalLine = `team: handoff ${activeRun.id} -> ${workflow.nodes[nextNodeIndex]}`;
  }

  return {
    ...state,
    teamRuns: state.teamRuns.map((item) => (item.id === activeRun.id ? nextRun : item)),
    terminalLines: [...state.terminalLines, terminalLine],
  };
}

function getSelectedTeamRun(state: PrototypeState) {
  const runs = state.teamRuns.filter((item) => item.workflowId === state.selectedTeamWorkflowId);
  return [...runs].reverse().find((item) => item.status === "running") ?? runs[runs.length - 1];
}

function createTeamRun(workflow: (typeof teamWorkflows)[number]): TeamRun {
  const id = `team-run-${workflow.id}-active`;
  return {
    id,
    workflowId: workflow.id,
    status: "running",
    activeNodeIndex: 0,
    cycle: 1,
    maxCycles: workflow.maxCycles,
    handoffPayload: workflow.handoff,
    evidencePath: `.agent-workspace/teams/${id}/handoff.json`,
  };
}

function selectBrowserTool(state: PrototypeState, toolName: string): PrototypeState {
  const tool = browserTools.find((item) => item.name === toolName);
  if (!tool) return state;

  return {
    ...state,
    activeBrowserToolName: tool.name,
    terminalLines: [...state.terminalLines, `browser: selected ${tool.name}`],
  };
}

function captureBrowserEvidence(state: PrototypeState): PrototypeState {
  const tool =
    browserTools.find((item) => item.name === state.activeBrowserToolName) ??
    browserTools.find((item) => item.name === "browser_screenshot") ??
    browserTools[0];
  const task = state.tasks.find((item) => item.id === state.selectedTaskId);
  if (!tool || !task) return state;

  const sequence = state.browserEvidence.filter((item) => item.taskId === task.id && item.toolName === tool.name).length + 1;
  const suffix = String(sequence).padStart(3, "0");
  const evidence: BrowserEvidence = {
    id: `browser-evidence-${task.id}-${suffix}`,
    taskId: task.id,
    toolName: tool.name,
    summary: `${tool.name} captured ${tool.evidence} for ${task.title}`,
    artifactPath: `.agent-workspace/browser/${task.id}/${tool.name}-${suffix}.json`,
    capturedAt: "2026-06-24T13:20:00Z",
  };

  return {
    ...state,
    browserEvidence: [...state.browserEvidence, evidence],
    terminalLines: [...state.terminalLines, `browser: captured ${tool.name} evidence for ${task.id}`],
  };
}

function createPlannerTaskFromWatch(state: PrototypeState, eventId: string): PrototypeState {
  const event = state.watchEvents.find((item) => item.id === eventId);
  if (!event) return state;

  const taskId = event.plannerTaskId ?? `task-${event.id}`;
  const existingTask = state.tasks.find((task) => task.id === taskId);
  const nextTask =
    existingTask ??
    ({
      id: taskId,
      title: `Planner review: ${basename(event.path)}`,
      status: "queued",
      source: event.path,
      owner: "Planner",
      risk: "需要避免把 runtime state 写进 product intent",
      verification: "Research + Superworks spec/plan alignment review",
      summary: event.impact,
    } satisfies Task);

  return {
    ...state,
    activeView: "watcher",
    selectedTaskId: nextTask.id,
    tasks: existingTask ? state.tasks : [...state.tasks, nextTask],
    watchEvents: state.watchEvents.map((item) =>
      item.id === event.id ? { ...item, status: "task-created", plannerTaskId: nextTask.id } : item,
    ),
    terminalLines: [...state.terminalLines, `watcher: created planner task ${nextTask.id} from ${event.path}`],
  };
}

function basename(path: string) {
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

function routeNotification(state: PrototypeState): PrototypeState {
  const task = state.tasks.find((item) => item.id === state.selectedTaskId);
  if (!task) return state;

  const sequence = state.notificationEvents.filter((item) => item.taskId === task.id).length + 1;
  const suffix = String(sequence).padStart(3, "0");
  const id = `notification-${task.id}-${suffix}`;
  const destination = notificationDestination(task.status);
  const event: NotificationEvent = {
    id,
    taskId: task.id,
    level: task.status,
    destination,
    acknowledged: false,
    summary: `${task.title}: ${notificationSummary(task.status)}`,
    evidencePath: `.agent-workspace/notifications/${id}.json`,
    createdAt: "2026-06-24T13:25:00Z",
  };

  return {
    ...state,
    notificationEvents: [...state.notificationEvents, event],
    terminalLines: [...state.terminalLines, `notification: routed ${task.status} for ${task.id} to ${destination}`],
  };
}

function applyTerminalSignal(state: PrototypeState, eventId: string): PrototypeState {
  const terminalEvent = state.terminalEvents.find((event) => event.id === eventId);
  const task = terminalEvent ? state.tasks.find((item) => item.id === terminalEvent.taskId) : undefined;
  if (!terminalEvent) return state;

  return {
    ...state,
    activeView: "runs",
    selectedTaskId: task?.id ?? state.selectedTaskId,
    terminalLines: [
      ...state.terminalLines,
      `terminal diagnostics: inspected ${terminalEvent.id}; no task state transition`,
    ],
  };
}

function acknowledgeNotification(state: PrototypeState, eventId: string): PrototypeState {
  const event = state.notificationEvents.find((item) => item.id === eventId);
  if (!event) return state;

  return {
    ...state,
    notificationEvents: state.notificationEvents.map((item) =>
      item.id === eventId ? { ...item, acknowledged: true } : item,
    ),
    terminalLines: [...state.terminalLines, `notification: acknowledged ${eventId}`],
  };
}

function openNotificationContext(state: PrototypeState, eventId: string): PrototypeState {
  const event = state.notificationEvents.find((item) => item.id === eventId);
  const task = event ? state.tasks.find((item) => item.id === event.taskId) : undefined;
  if (!event || !task) return state;

  const activeView = notificationContextView(event.level);

  return {
    ...state,
    activeView,
    selectedTaskId: task.id,
    terminalLines: [...state.terminalLines, `notification: opened ${eventId} in ${activeView}`],
  };
}

function notificationDestination(status: TaskStatus): NotificationEvent["destination"] {
  if (status === "waiting-input" || status === "failed-verification" || status === "blocked") return "desktop";
  if (status === "done" || status === "pending-review") return "sidebar";
  return "mobile";
}

function notificationContextView(status: TaskStatus): PrototypeState["activeView"] {
  if (status === "waiting-input") return "workbench";
  if (status === "pending-review" || status === "failed-verification") return "review";
  if (status === "done") return "runs";
  return "backlog";
}

function openAuditEntryContext(state: PrototypeState, entryId: string): PrototypeState {
  const context = auditEntryContext(state, entryId);
  if (!context) return state;

  const selectedTaskId =
    context.taskId && state.tasks.some((task) => task.id === context.taskId) ? context.taskId : state.selectedTaskId;

  return {
    ...state,
    activeView: context.view,
    selectedTaskId,
    terminalLines: [...state.terminalLines, `audit: opened ${entryId} in ${context.view}`],
  };
}

function auditEntryContext(state: PrototypeState, entryId: string): { view: View; taskId?: string } | undefined {
  if (
    state.projectContextEvents.some((event) => event.id === entryId) ||
    state.agentProfileEvents.some((event) => event.id === entryId)
  ) {
    return { view: "projects" };
  }

  const watchEvent = state.watchEvents.find((event) => event.id === entryId);
  if (watchEvent) return { view: "watcher", taskId: watchEvent.plannerTaskId };

  const taskIntakeEvent = state.taskIntakeEvents.find((event) => event.id === entryId);
  if (taskIntakeEvent) return { view: "backlog", taskId: taskIntakeEvent.taskId };

  const taskTransitionEvent = state.taskTransitionEvents.find((event) => event.id === entryId);
  if (taskTransitionEvent) return { view: "backlog", taskId: taskTransitionEvent.taskId };

  const taskArtifact = state.taskArtifacts.find((artifact) => artifact.id === entryId);
  if (taskArtifact) return { view: "backlog", taskId: taskArtifact.taskId };

  const loopScheduleEvent = state.loopScheduleEvents.find((event) => event.id === entryId);
  if (loopScheduleEvent) return { view: "loops", taskId: loopScheduleEvent.taskId };

  const run = state.runs.find((item) => `run-${item.id}` === entryId);
  if (run) return { view: "runs", taskId: run.taskId };

  const runtimePolicyRun = state.runs.find((item) => `run-policy-${item.id}` === entryId);
  if (runtimePolicyRun) return { view: "runs", taskId: runtimePolicyRun.taskId };

  const terminalEvent = state.terminalEvents.find((event) => event.id === entryId);
  if (terminalEvent) return { view: "runs", taskId: terminalEvent.taskId };

  const verificationEvent = state.verificationEvents.find((event) => event.id === entryId);
  if (verificationEvent) return { view: "review", taskId: verificationEvent.taskId };

  const stagingEvent = state.commitStagingEvents.find((event) => event.id === entryId);
  if (stagingEvent) return { view: "review", taskId: stagingEvent.taskId };

  const approvalEvent = state.reviewApprovalEvents.find((event) => event.id === entryId);
  if (approvalEvent) return { view: "review", taskId: approvalEvent.taskId };

  const gateEvent = state.reviewGateEvents.find((event) => event.id === entryId);
  if (gateEvent) return { view: "review", taskId: gateEvent.taskId };

  const prHandoffEvent = state.pullRequestHandoffEvents.find((event) => event.id === entryId);
  if (prHandoffEvent) return { view: "runs", taskId: prHandoffEvent.taskId };

  if (state.runtimeEvents.some((event) => event.id === entryId)) return { view: "workbench" };
  if (state.devCommandEvents.some((event) => event.id === entryId)) return { view: "terminals" };

  const mcpToolEvent = state.mcpToolEvents.find((event) => event.id === entryId);
  if (mcpToolEvent) return { view: mcpToolEvent.targetSurface, taskId: mcpToolEvent.taskId };

  if (state.teamRuns.some((runItem) => runItem.id === entryId)) return { view: "teams" };

  const browserEvidence = state.browserEvidence.find((event) => event.id === entryId);
  if (browserEvidence) return { view: "browser", taskId: browserEvidence.taskId };

  const notificationEvent = state.notificationEvents.find((event) => event.id === entryId);
  if (notificationEvent) return { view: "notifications", taskId: notificationEvent.taskId };

  const promptLibrarySave = state.promptLibrarySaves.find((event) => event.id === entryId);
  if (promptLibrarySave) return { view: "libraries", taskId: promptLibrarySave.taskId };

  const redactionScan = state.commitRedactionScans.find((scan) => `redaction-${scan.runId}` === entryId);
  const redactionRun = redactionScan ? state.runs.find((item) => item.id === redactionScan.runId) : undefined;
  if (redactionScan) return { view: "review", taskId: redactionRun?.taskId };

  if (state.restoreManifest?.id === entryId) return { view: "restore", taskId: state.restoreManifest.selectedTaskId };

  return undefined;
}

function notificationSummary(status: TaskStatus) {
  if (status === "waiting-input") return "agent is waiting for user input";
  if (status === "failed-verification") return "verification failed and needs review";
  if (status === "blocked") return "task is blocked";
  if (status === "pending-review") return "review gate needs attention";
  if (status === "done") return "review approved done";
  return "status update routed";
}

function captureRestoreManifest(state: PrototypeState): PrototypeState {
  const manifest = buildRestoreManifest(state, "restore-manifest-current");

  return {
    ...state,
    restoreManifest: manifest,
    terminalLines: [...state.terminalLines, `restore: captured ${manifest.id}`],
  };
}

function restoreWorkspaceSession(state: PrototypeState): PrototypeState {
  if (!state.restoreManifest) return state;

  return {
    ...state,
    activeView: state.restoreManifest.activeView,
    selectedTaskId: state.restoreManifest.selectedTaskId,
    selectedAgentClusterId: state.restoreManifest.selectedAgentClusterId,
    selectedAgentId: state.restoreManifest.selectedAgentId,
    terminalLines: [
      ...state.terminalLines,
      `restore: restored ${state.restoreManifest.id} to ${state.restoreManifest.activeView}`,
    ],
  };
}

function buildRestoreManifest(state: PrototypeState, id: string): RestoreManifest {
  const projectPath = "/Users/dinker/CODES/Agent-Workspace";
  const agentRecords: RestoreProcessRecord[] = state.agents.map((agent) => ({
    id: `agent-${agent.id}`,
    label: `${agent.name} agent`,
    processClass: "agent-pty",
    workingDir: projectPath,
    commandLine: `${agent.provider} --model ${agent.model}`,
    rollbackIntent: `return ${agent.name} to ${agent.taskId}`,
    metadataPath: `.agent-workspace/projects/${agent.projectId}/clusters/${agent.clusterId}/sessions/agent-${agent.id}.json`,
  }));
  const commandRecords: RestoreProcessRecord[] = state.devCommands.map((command) => ({
    id: `command-${command.id}`,
    label: command.name,
    processClass: "dev-command",
    workingDir: projectPath,
    commandLine: command.command,
    rollbackIntent: command.status === "running" ? "restart if project restore allows commands" : "keep stopped",
    metadataPath: `.agent-workspace/commands/${command.id}.json`,
  }));

  return {
    id,
    projectPath,
    activeView: state.activeView,
    selectedTaskId: state.selectedTaskId,
    selectedAgentClusterId: state.selectedAgentClusterId,
    selectedAgentId: state.selectedAgentId,
    capturedAt: "2026-06-24T13:35:00Z",
    manifestPath: `.agent-workspace/restore/${id}.json`,
    processRecords: [...agentRecords, ...commandRecords],
    contextRecords: buildRestoreContextRecords(state),
  };
}

function buildRestoreContextRecords(state: PrototypeState): RestoreContextRecord[] {
  const selectedTaskId = state.selectedTaskId;
  const activeRun = getActiveRunForTask(state.runs, selectedTaskId);
  const resumableTeamRuns = state.teamRuns.filter((run) => run.status !== "completed");
  const pendingNotificationEvents = state.notificationEvents.filter(
    (event) => event.taskId === selectedTaskId && !event.acknowledged,
  );
  const records: RestoreContextRecord[] = [];

  if (activeRun) {
    records.push({
      id: `restore-context-${activeRun.id}`,
      kind: "active-run",
      label: `Active run ${activeRun.id}`,
      status: activeRun.status,
      taskId: activeRun.taskId,
      artifactPath: activeRun.transcriptPath,
      summary: `Resume ${activeRun.agentId} transcript and verification ${activeRun.verification.status}`,
    });
  }

  records.push(
    ...state.browserEvidence
      .filter((evidence) => evidence.taskId === selectedTaskId)
      .map((evidence) => ({
        id: `restore-context-${evidence.id}`,
        kind: "browser-evidence" as const,
        label: `${evidence.toolName} evidence`,
        status: "captured",
        taskId: evidence.taskId,
        artifactPath: evidence.artifactPath,
        summary: evidence.summary,
      })),
  );

  if (activeRun) {
    records.push(
      ...state.commitRedactionScans
        .filter((scan) => scan.runId === activeRun.id)
        .map((scan) => ({
          id: `restore-context-redaction-${scan.runId}`,
          kind: "redaction-scan" as const,
          label: `Redaction scan ${scan.runId}`,
          status: scan.status,
          taskId: activeRun.taskId,
          artifactPath: scan.artifactPath,
          summary: `Transcript redaction covers ${scan.redactedPatterns.join(", ")}`,
        })),
    );
  }

  records.push(
    ...state.mcpToolEvents.slice(-3).map((event) => ({
      id: `restore-context-${event.id}`,
      kind: "mcp-audit" as const,
      label: `${event.toolName} MCP audit`,
      status: event.status,
      artifactPath: event.evidencePath,
      taskId: event.taskId,
      summary: event.summary,
    })),
  );

  records.push(
    ...resumableTeamRuns.map((run) => ({
      id: `restore-context-${run.id}`,
      kind: "team-run" as const,
      label: `TeamRun ${run.id}`,
      status: run.status,
      artifactPath: run.evidencePath,
      summary: `Restore team workflow ${run.workflowId} at cycle ${run.cycle}`,
    })),
  );

  records.push(
    ...pendingNotificationEvents.map((event) => ({
      id: `restore-context-${event.id}`,
      kind: "notification" as const,
      label: `Notification ${event.id}`,
      status: event.level,
      taskId: event.taskId,
      artifactPath: event.evidencePath,
      summary: event.summary,
    })),
  );

  return records;
}

function setDevCommandStatus(
  state: PrototypeState,
  commandId: string,
  status: "running" | "stopped",
  log: string,
): PrototypeState {
  const command = state.devCommands.find((item) => item.id === commandId);
  if (!command) return state;

  const action = status === "running" ? "started" : "stopped";
  const event = createDevCommandEvent(state, command, status);

  return {
    ...state,
    devCommands: state.devCommands.map((item) => (item.id === commandId ? { ...item, status, log } : item)),
    devCommandEvents: [...state.devCommandEvents, event],
    terminalLines: [...state.terminalLines, `dev terminal: ${action} ${command.name}`],
  };
}

function createDevCommandEvent(
  state: PrototypeState,
  command: DevCommand,
  status: "running" | "stopped",
): DevCommandEvent {
  const sequence = state.devCommandEvents.filter((event) => event.commandId === command.id).length + 1;
  const action: DevCommandEvent["action"] = status === "running" ? "start" : "stop";
  const verb = status === "running" ? "Started" : "Stopped";

  return {
    id: `dev-command-event-${command.id}-${String(sequence).padStart(3, "0")}`,
    commandId: command.id,
    action,
    status,
    summary: `${verb} ${command.name} through Dev Terminals command manager`,
    evidencePath: ".agent-workspace/commands/events.jsonl",
    logPath: `.agent-workspace/commands/${command.id}/log.txt`,
    createdAt: "2026-06-24T13:45:00Z",
  };
}

function runtimeStartedAgent(
  state: PrototypeState,
  action: Extract<PrototypeAction, { type: "runtime-started-agent" }>,
): PrototypeState {
  const loopScheduleEvent = createLoopScheduleEvent(state, action);
  const agent = state.agents.find((item) => item.id === action.agentId);

  return {
    ...state,
    activeView: "workbench",
    selectedTaskId: action.taskId,
    selectedAgentClusterId: agent?.clusterId ?? state.selectedAgentClusterId,
    selectedAgentId: action.agentId,
    tasks: setTaskStatus(state.tasks, action.taskId, "running"),
    runs: upsertRun(state.runs, action.run),
    runtimeEvents: [...state.runtimeEvents, ...action.runtimeEvents],
    loopScheduleEvents: [...state.loopScheduleEvents, loopScheduleEvent],
    terminalLines: [...state.terminalLines, ...action.terminalLines],
  };
}

function attachNativeSessionEvidence(
  state: PrototypeState,
  action: Extract<PrototypeAction, { type: "attach-native-session-evidence" }>,
): PrototypeState {
  const task = state.tasks.find((item) => item.id === action.taskId);
  if (!task) return state;

  const runState = nativeSessionRunState(action.session, task.status);
  const { runs, runId } = ensureRun(state.runs, task, action.agentId, runState.runStatus);
  const nativeSession = nativeSessionEvidence(action.session);
  const terminalEvent = createNativeSessionTerminalEvent(state, task.id, runId, nativeSession, runState.taskStatus);
  const updatedRuns = updateRun(runs, runId, (run) => {
    const nativeTranscriptPreview = nativeSession.transcriptPreview ?? [];
    const transcriptPreview = nativeTranscriptPreview.length > 0 ? nativeTranscriptPreview : run.transcriptPreview;
    const transcriptPath = run.transcriptPath;
    return {
      ...run,
      status: runState.runStatus,
      transcriptPath,
      transcriptPreview,
      nativeSession,
      runtimePolicy: {
        ...run.runtimePolicy,
        cliCommand: formatNativeSessionCommand(nativeSession),
      },
      commitProposal: {
        ...run.commitProposal,
        message: buildCommitMessage(task, run.id, run.verification.status, {
          ...commitMessageContext(state, { ...run, transcriptPath }),
          transcriptPath: state.commitConversationIncluded ? transcriptPath : undefined,
        }),
      },
    };
  });

  return {
    ...state,
    tasks: setTaskStatus(state.tasks, task.id, runState.taskStatus),
    agents: state.agents.map((agent) =>
      agent.id === action.agentId
        ? {
            ...agent,
            status: nativeSessionAgentStatus(action.session),
            lastActive: action.session.status,
          }
        : agent,
    ),
    runs: updatedRuns,
    terminalEvents: terminalEvent ? [...state.terminalEvents, terminalEvent] : state.terminalEvents,
    runtimeEvents: [
      ...state.runtimeEvents,
      {
        id: `event-${runId}-native-session-${nativeSession.id}`,
        service: "pty-service",
        action: "attachNativeSessionState",
        summary: `attached ${nativeSession.id} state to ${runId}`,
        evidence: nativeSession.cwd,
      },
    ],
    terminalLines: [...state.terminalLines, `native session: ${nativeSession.id} ${nativeSession.status}; state attached to ${runId}`],
  };
}

function nativeSessionAgentStatus(
  session: Extract<PrototypeAction, { type: "attach-native-session-evidence" }>["session"],
): AgentStatus {
  if (session.status === "running") return "working";
  if (session.status === "stopped" && session.exitCode === 0) return "idle";
  if (session.status === "stopped") return "waiting";
  return "idle";
}

function nativeSessionRunState(
  session: Extract<PrototypeAction, { type: "attach-native-session-evidence" }>["session"],
  currentTaskStatus: TaskStatus,
) {
  if (session.status === "stopped" && session.exitCode === 0) {
    return { runStatus: "completed" as const, taskStatus: currentTaskStatus };
  }
  if (session.status === "stopped" && session.exitCode !== undefined && session.exitCode !== 0) {
    return { runStatus: "failed-verification" as const, taskStatus: "failed-verification" as const };
  }
  return { runStatus: "running" as const, taskStatus: "running" as const };
}

function nativeSessionEvidence(
  session: Extract<PrototypeAction, { type: "attach-native-session-evidence" }>["session"],
): NativeSessionEvidence {
  return {
    id: session.id,
    command: session.command,
    args: [...session.args],
    cwd: session.cwd,
    backend: session.backend,
    status: session.status,
    model: session.model,
    exitCode: session.exitCode,
    signal: session.signal,
    transcriptPreview: (session.transcript ?? []).map((line) => line.trimEnd()).filter(Boolean).slice(-5),
  };
}

function createNativeSessionTerminalEvent(
  state: PrototypeState,
  taskId: string,
  runId: string,
  session: NativeSessionEvidence,
  mappedStatus: TaskStatus,
) {
  if (session.status !== "stopped") return undefined;

  const sequence = state.terminalEvents.filter((event) => event.id.startsWith(`terminal-event-${runId}-native-`)).length + 1;
  const success = session.exitCode === 0;
  return {
    id: `terminal-event-${runId}-native-${String(sequence).padStart(3, "0")}`,
    taskId,
    runId,
    kind: "process-signal",
    ruleId: success ? "native.session.exit-zero" : "native.session.exit-nonzero",
    mappedStatus,
    sourceLine: `native session ${session.id} stopped with exit ${session.exitCode ?? "unknown"}`,
    evidencePath: session.cwd,
    createdAt: "2026-06-24T14:50:00Z",
    summary: success
      ? "Native opencode session exited successfully; session state was recorded without claiming review readiness."
      : "Native opencode session stopped without a successful exit; verification must inspect session state.",
  } satisfies PrototypeState["terminalEvents"][number];
}

function formatNativeSessionCommand(session: NativeSessionEvidence) {
  return [session.command, ...session.args].join(" ");
}

function createLoopScheduleEvent(
  state: PrototypeState,
  action: Extract<PrototypeAction, { type: "runtime-started-agent" }>,
): LoopScheduleEvent {
  const sequence = state.loopScheduleEvents.filter((event) => event.taskId === action.taskId).length + 1;

  return {
    id: `loop-schedule-${action.taskId}-${String(sequence).padStart(3, "0")}`,
    taskId: action.taskId,
    agentId: action.agentId,
    runId: action.run.id,
    decision: "start-agent",
    rule: "Loop queue Start Agent",
    evidencePath: ".agent-workspace/loops/events.jsonl",
    createdAt: "2026-06-24T14:05:00Z",
    summary: `Loop scheduled ${action.agentId} for ${action.taskId} via Start Agent`,
  };
}

export function advanceTask(state: PrototypeState, taskId: string): PrototypeState {
  const task = state.tasks.find((item) => item.id === taskId);
  if (!task) return state;

  const status = nextStatus[task.status];
  const event = createTaskTransitionEvent(state, task, status);
  return {
    ...state,
    selectedTaskId: taskId,
    tasks: state.tasks.map((item) => (item.id === taskId ? { ...item, status } : item)),
    taskTransitionEvents: [...state.taskTransitionEvents, event],
    terminalLines: [...state.terminalLines, `scheduler: ${task.title} -> ${status}`],
  };
}

function createTaskTransitionEvent(
  state: PrototypeState,
  task: Task,
  toStatus: TaskStatus,
): TaskTransitionEvent {
  const sequence = state.taskTransitionEvents.filter((event) => event.taskId === task.id).length + 1;

  return {
    id: `task-transition-${task.id}-${String(sequence).padStart(3, "0")}`,
    taskId: task.id,
    fromStatus: task.status,
    toStatus,
    summary: `Task ${task.id} moved from ${task.status} to ${toStatus}`,
    evidencePath: ".agent-workspace/tasks/events.jsonl",
    createdAt: "2026-06-24T14:00:00Z",
  };
}

export function startAgent(state: PrototypeState, taskId: string): PrototypeState {
  const task = state.tasks.find((item) => item.id === taskId);
  if (!task) return state;

  const { cluster, agent } = getTaskAgentContext(state, task);
  const { runs } = ensureRun(state.runs, task, agent?.id ?? state.selectedAgentId, "running");
  return {
    ...state,
    activeView: "workbench",
    selectedTaskId: taskId,
    selectedAgentClusterId: cluster?.id ?? state.selectedAgentClusterId,
    selectedAgentId: agent?.id ?? state.selectedAgentId,
    tasks: setTaskStatus(state.tasks, taskId, "running"),
    runs,
    terminalLines: [...state.terminalLines, `scheduler: started ${task.owner} for ${task.title}`],
  };
}

export function agentClaimsDone(state: PrototypeState, taskId: string): PrototypeState {
  const task = state.tasks.find((item) => item.id === taskId);
  if (!task) return state;
  const { cluster, agent } = getTaskAgentContext(state, task);
  const { runs, runId } = ensureRun(state.runs, task, agent?.id ?? state.selectedAgentId, "pending-review");

  return {
    ...state,
    activeView: "review",
    selectedTaskId: taskId,
    selectedAgentClusterId: cluster?.id ?? state.selectedAgentClusterId,
    tasks: setTaskStatus(state.tasks, taskId, "pending-review"),
    runs: updateRun(runs, runId, (run) => ({
      ...run,
      status: "pending-review",
      commitProposal: {
        ...run.commitProposal,
        message: buildCommitMessage(task, run.id, "pending", commitMessageContext(state, run)),
      },
    })),
    terminalLines: [
      ...state.terminalLines,
      `review gate: ${task.owner} claimed done; review and verification required`,
    ],
  };
}

export function verificationFailed(state: PrototypeState, taskId: string): PrototypeState {
  const task = state.tasks.find((item) => item.id === taskId);
  if (!task) return state;
  const { cluster, agent } = getTaskAgentContext(state, task);
  const { runs, runId } = ensureRun(state.runs, task, agent?.id ?? state.selectedAgentId, "failed-verification");

  return {
    ...state,
    activeView: "review",
    selectedTaskId: taskId,
    selectedAgentClusterId: cluster?.id ?? state.selectedAgentClusterId,
    tasks: setTaskStatus(state.tasks, taskId, "failed-verification"),
    runs: updateRun(runs, runId, (run) => ({
      ...run,
      status: "failed-verification",
      verification: {
        ...run.verification,
        status: "failed",
        summary: "Verification failed; review before retry.",
      },
      commitProposal: {
        ...run.commitProposal,
        message: buildCommitMessage(task, run.id, "failed", commitMessageContext(state, run)),
      },
    })),
    terminalLines: [...state.terminalLines, `verification: ${task.title} failed and needs review`],
  };
}

export function approveReview(state: PrototypeState, taskId: string): PrototypeState {
  const task = state.tasks.find((item) => item.id === taskId);
  if (!task) return state;
  const { agent } = getTaskAgentContext(state, task);
  const existingRun = getActiveRunForTask(state.runs, task.id);
  const { runs, runId } = existingRun
    ? { runs: state.runs, runId: existingRun.id }
    : ensureRun(state.runs, task, agent?.id ?? state.selectedAgentId, "pending-review");
  const run = runs.find((item) => item.id === runId);
  if (!run) return state;
  const blockReason = reviewApprovalBlockReason(state, run);
  if (blockReason) {
    return blockReviewApproval({ ...state, runs }, task, run, blockReason);
  }
  const commitContext = commitMessageContext(state, run);
  const approvalEvent = createReviewApprovalEvent(state, task.id, run, commitContext);
  const notificationEvent = createDoneNotificationFromReviewApproval(state, task, approvalEvent);

  return {
    ...state,
    activeView: "runs",
    selectedTaskId: taskId,
    tasks: setTaskStatus(state.tasks, taskId, "done"),
    reviewApprovalEvents: [...state.reviewApprovalEvents, approvalEvent],
    notificationEvents: [...state.notificationEvents, notificationEvent],
    runs: updateRun(runs, runId, (run) => ({
      ...run,
      status: "completed",
      verification: {
        ...run.verification,
        status: "passed",
        summary: "Review approved; verification evidence accepted.",
      },
      commitProposal: {
        ...run.commitProposal,
        approved: true,
        message: buildCommitMessage(task, run.id, "passed", commitContext),
      },
    })),
    terminalLines: [...state.terminalLines, `review gate: ${task.title} approved and moved to Done`],
  };
}

function reviewApprovalBlockReason(
  state: PrototypeState,
  run: AgentRun,
): ReviewGateEvent["reason"] | undefined {
  if (run.verification.status !== "passed") return "verification-required";

  const redactionRequired = state.commitConversationIncluded && Boolean(run.transcriptPath);
  const redactionScan = state.commitRedactionScans.find((scan) => scan.runId === run.id);
  if (redactionRequired && redactionScan?.status !== "passed") return "redaction-required";

  return undefined;
}

function blockReviewApproval(
  state: PrototypeState,
  task: Task,
  run: AgentRun,
  reason: ReviewGateEvent["reason"],
): PrototypeState {
  const gateEvent = createReviewGateEvent(state, task.id, run.id, reason);
  const terminalLine =
    reason === "verification-required"
      ? `review gate: blocked ${task.id} until verification evidence passes`
      : `review gate: blocked ${task.id} until Agent-Conversation redaction passes`;

  return {
    ...state,
    activeView: "review",
    selectedTaskId: task.id,
    reviewGateEvents: [...state.reviewGateEvents, gateEvent],
    terminalLines: [...state.terminalLines, terminalLine],
  };
}

function createReviewGateEvent(
  state: PrototypeState,
  taskId: string,
  runId: string,
  reason: ReviewGateEvent["reason"],
): ReviewGateEvent {
  const sequence = state.reviewGateEvents.filter((event) => event.runId === runId).length + 1;
  const reasonSummary =
    reason === "verification-required"
      ? "verification evidence must pass first"
      : "Agent-Conversation redaction must pass first";

  return {
    id: `review-gate-${runId}-${String(sequence).padStart(3, "0")}`,
    taskId,
    runId,
    status: "blocked",
    reason,
    evidencePath: `.agent-workspace/reviews/${runId}/gate.json`,
    createdAt: "2026-06-24T14:35:00Z",
    summary: `Review approval blocked for ${taskId}: ${reasonSummary}.`,
  };
}

function createReviewApprovalEvent(
  state: PrototypeState,
  taskId: string,
  run: AgentRun,
  context: { selectedFilePaths?: string[]; redactionArtifactPath?: string },
): ReviewApprovalEvent {
  const sequence = state.reviewApprovalEvents.filter((event) => event.runId === run.id).length + 1;
  const selectedFilePaths = context.selectedFilePaths ?? [];
  const verificationStatus: VerificationStatus = "passed";

  return {
    id: `review-approval-${run.id}-${String(sequence).padStart(3, "0")}`,
    taskId,
    runId: run.id,
    verificationStatus,
    selectedFilePaths,
    redactionArtifactPath: context.redactionArtifactPath,
    commitProposalPath: run.commitPath,
    evidencePath: `.agent-workspace/reviews/${run.id}/approval.json`,
    approvedAt: "2026-06-24T14:25:00Z",
    summary: `Review approved ${taskId} with verification ${verificationStatus} and ${selectedFilePaths.length} scoped files.`,
  };
}

function createDoneNotificationFromReviewApproval(
  state: PrototypeState,
  task: Task,
  approvalEvent: ReviewApprovalEvent,
): NotificationEvent {
  const prefix = `notification-${task.id}-review-approval-${approvalEvent.runId}`;
  const sequence = state.notificationEvents.filter((event) => event.id.startsWith(prefix)).length + 1;
  const id = `${prefix}-${String(sequence).padStart(3, "0")}`;
  return {
    id,
    taskId: task.id,
    level: "done",
    destination: notificationDestination("done"),
    acknowledged: false,
    summary: `${task.title}: Review approved; task Done and ready for Runs audit.`,
    evidencePath: `.agent-workspace/notifications/${id}.json`,
    createdAt: approvalEvent.approvedAt,
    sourceLabel: "Review approval",
    sourceEventId: approvalEvent.id,
    sourceEvidencePath: approvalEvent.evidencePath,
    sourceSummary: approvalEvent.summary,
  };
}

function createPullRequestHandoff(state: PrototypeState, runId: string): PrototypeState {
  const run = state.runs.find((item) => item.id === runId);
  const approvalEvent = state.reviewApprovalEvents.find((event) => event.runId === runId);
  if (!run || !approvalEvent || !run.commitProposal.approved) return state;

  const sequence = state.pullRequestHandoffEvents.filter((event) => event.runId === run.id).length + 1;
  const handoffEvent: PullRequestHandoffEvent = {
    id: `pr-handoff-${run.id}-${String(sequence).padStart(3, "0")}`,
    taskId: run.taskId,
    runId: run.id,
    branchName: run.worktreeContext.branchName,
    approvalEvidencePath: approvalEvent.evidencePath,
    commitProposalPath: run.commitPath,
    prDraftPath: `.agent-workspace/pr/${run.id}/handoff.json`,
    status: "draft-ready",
    createdAt: "2026-06-24T14:30:00Z",
    summary: `PR handoff ready for ${run.taskId} from ${run.id}.`,
  };

  return {
    ...state,
    activeView: "runs",
    selectedTaskId: run.taskId,
    pullRequestHandoffEvents: [...state.pullRequestHandoffEvents, handoffEvent],
    terminalLines: [...state.terminalLines, `pr handoff: prepared draft package for ${run.id}`],
  };
}

export function sendPrompt(state: PrototypeState): PrototypeState {
  const cleaned = state.prompt.trim();
  if (!cleaned) return state;

  return {
    ...state,
    prompt: "",
    terminalLines: [...state.terminalLines, `> ${cleaned}`],
  };
}

function getTaskAgentContext(state: PrototypeState, task: Task) {
  const project =
    state.projects.find((item) => item.taskIds.includes(task.id) && item.id === state.selectedProjectId) ??
    state.projects.find((item) => item.taskIds.includes(task.id));
  const cluster = project ? getClusterForTask(state.agentClusters, project, task) : undefined;
  const agent = getAgentForTask(state.agents, task, cluster);

  return { project, cluster, agent };
}

export function getAgentForTask(agentList: Agent[], task: Task, cluster?: AgentCluster) {
  const scopedAgents = cluster ? agentList.filter((agent) => cluster.agentIds.includes(agent.id)) : agentList;
  return scopedAgents.find((agent) => agentBelongsToTask(agent, task) && agent.name === task.owner);
}

function agentBelongsToTask(agent: Agent, task: Task) {
  if (agent.taskId !== task.id) return false;
  if (agent.runtimeTaskId && task.runtimeTaskId) return agent.runtimeTaskId === task.runtimeTaskId;
  return true;
}

export function getLoopForTask(task: Task) {
  if (task.source.includes("research") || task.owner === "Planner") return "Planner loop";
  if (task.owner === "QA") return "QA loop";
  if (task.status === "pending-review") return "Review gate";
  return "Executor loop";
}

export function getRunIdForTask(task: Task, runs?: AgentRun[]) {
  if (runs) {
    const recordedRun = getActiveRunForTask(runs, task.id);
    if (recordedRun) return recordedRun.id;
  }

  const suffix = task.id.replace("task-", "").slice(0, 9);
  if (task.status === "todo") return "not started";
  if (task.status === "done") return `run-${suffix}-closed`;
  return `run-${suffix}-active`;
}

export function getRunsForTask(runs: AgentRun[], taskId: string) {
  return runs.filter((run) => run.taskId === taskId);
}

export function getActiveRunForTask(runs: AgentRun[], taskId: string) {
  const taskRuns = getRunsForTask(runs, taskId);
  const newestFirst = [...taskRuns].reverse();
  return newestFirst.find((run) => run.status !== "completed") ?? newestFirst[0];
}

function setTaskStatus(tasks: Task[], taskId: string, status: TaskStatus) {
  return tasks.map((task) => (task.id === taskId ? { ...task, status } : task));
}

function ensureRun(runs: AgentRun[], task: Task, agentId: string, status: RunStatus) {
  const existing = getActiveRunForTask(runs, task.id);
  if (existing) {
    return {
      runId: existing.id,
      runs: updateRun(runs, existing.id, (run) => ({ ...run, status })),
    };
  }

  const run = createRun(task, agentId, status);
  return {
    runId: run.id,
    runs: [...runs, run],
  };
}

function createRun(task: Task, agentId: string, status: RunStatus): AgentRun {
  const id = buildRunId(task);
  return {
    id,
    taskId: task.id,
    agentId,
    status,
    startGitSha: "abc1234",
    startedAt: "2026-06-24T13:30:00Z",
    promptPath: `.agent-workspace/runs/${id}/prompt.md`,
    transcriptPath: `.agent-workspace/runs/${id}/transcript.log`,
    diffPath: `.agent-workspace/runs/${id}/diff.patch`,
    verificationPath: `.agent-workspace/runs/${id}/verification.json`,
    commitPath: `.agent-workspace/runs/${id}/commit.json`,
    changedFilePaths: [`src/${task.id.replace("task-", "")}/index.ts`],
    transcriptPreview: [`Started ${task.owner} for ${task.title}`, "Captured baseline and prompt context"],
    verification: {
      command: "npm test && npm run build",
      status: "pending",
      summary: "Verification pending.",
      logPath: `.agent-workspace/runs/${id}/verification.log`,
    },
    commitProposal: {
      policy: "proposal-first",
      approved: false,
      message: buildCommitMessage(task, id, "pending"),
    },
    worktreeContext: createRunWorktreeContext({ agentId, runId: id, taskId: task.id }),
    runtimePolicy: createRunRuntimePolicy({ agentId, runId: id }),
  };
}

function updateRun(runs: AgentRun[], runId: string, update: (run: AgentRun) => AgentRun) {
  return runs.map((run) => (run.id === runId ? update(run) : run));
}

function upsertRun(runs: AgentRun[], nextRun: AgentRun) {
  const exists = runs.some((run) => run.id === nextRun.id);
  if (exists) {
    return runs.map((run) => (run.id === nextRun.id ? nextRun : run));
  }

  return [...runs, nextRun];
}

function upsertCommitRedactionScan(scans: CommitRedactionScan[], nextScan: CommitRedactionScan) {
  const exists = scans.some((scan) => scan.runId === nextScan.runId);
  if (exists) {
    return scans.map((scan) => (scan.runId === nextScan.runId ? nextScan : scan));
  }

  return [...scans, nextScan];
}

function buildRunId(task: Task) {
  return `run-${task.id.replace("task-", "").slice(0, 9)}-active`;
}

function commitMessageContext(state: PrototypeState, run: AgentRun) {
  const redactionScan = state.commitRedactionScans.find((scan) => scan.runId === run.id);
  const stagingEvent = [...state.commitStagingEvents].reverse().find((event) => event.runId === run.id);
  return {
    selectedFilePaths: state.reviewFileSelections.filter((file) => file.selected).map((file) => file.path),
    transcriptPath: state.commitConversationIncluded ? run.transcriptPath : undefined,
    redactionArtifactPath: state.commitConversationIncluded ? redactionScan?.artifactPath : undefined,
    stagingEvidencePath: stagingEvent?.evidencePath,
  };
}

function buildCommitMessage(
  task: Task,
  runId: string,
  verification: string,
  context: {
    selectedFilePaths?: string[];
    transcriptPath?: string;
    redactionArtifactPath?: string;
    stagingEvidencePath?: string;
  } = {},
) {
  const metadata = [
    `Task: ${task.id}`,
    "Plan-Step: mvp-board-first-shell",
    `Agent-Run: ${runId}`,
    `Verification: ${verification}`,
  ];
  const files = context.selectedFilePaths?.length
    ? ["Files:", ...context.selectedFilePaths.map((path) => `- ${path}`)]
    : [];
  const conversation = context.transcriptPath ? [`Agent-Conversation: ${context.transcriptPath}`] : [];
  const redaction = context.redactionArtifactPath
    ? [`Agent-Conversation-Redaction: ${context.redactionArtifactPath}`]
    : [];
  const staging = context.stagingEvidencePath ? [`Staging-Evidence: ${context.stagingEvidencePath}`] : [];

  return [task.title, "", ...metadata, ...files, ...conversation, ...redaction, ...staging].join("\n");
}

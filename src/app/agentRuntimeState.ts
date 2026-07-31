import type { Agent, Project, Task } from "../types";
import type {
  AgentRuntimeState,
  ReadTaskStateResult,
  ReadTaskStateSessionSummary,
} from "../orchestration/conductor-tools";
import { createOpencodeSessionKey, getProjectRuntimeId, getTaskRuntimeId } from "../runtime/opencode";

export type AgentRuntimeView = {
  agent: Agent;
  sessionId: string;
  state: AgentRuntimeState;
  label: string;
  activeDispatchId?: string;
  lastResultId?: string;
  resultCount?: number;
  unresolvedFailureDispatchId?: string;
  attentionHints: string[];
  assignmentReadinessHint?: "ready" | "unknown" | "not_ready";
};

export type AgentRuntimeRecoveryActionId =
  | "retry_delivery"
  | "stop_then_retry"
  | "restart_fresh_then_retry"
  | "force_retry";

export type AgentRuntimeRecoveryAction = {
  id: AgentRuntimeRecoveryActionId;
  label: string;
  description: string;
  tone: "primary" | "neutral" | "danger";
  requiresConfirmation: boolean;
  requiresFailedDispatch: boolean;
  confirmMessage?: string;
};

export function createAgentRuntimeView(input: {
  agent: Agent;
  project: Pick<Project, "id" | "runtimeProjectId">;
  task: Pick<Task, "id" | "runtimeTaskId">;
  taskRuntimeState?: ReadTaskStateResult;
}): AgentRuntimeView {
  const sessionId = agentRuntimeSessionId(input);
  const session = input.taskRuntimeState?.sessions.find((item) => item.sessionId === sessionId);
  const state = normalizeAgentRuntimeState(session?.state ?? fallbackAgentRuntimeState(input.agent));
  return {
    agent: input.agent,
    sessionId,
    state,
    label: agentRuntimeStateLabel(state, session),
    activeDispatchId: session?.activeDispatchId,
    lastResultId: session?.lastResultId,
    resultCount: session?.resultCount,
    unresolvedFailureDispatchId: session?.unresolvedFailureDispatchId,
    attentionHints: session?.attentionHints ?? [],
    assignmentReadinessHint: session?.assignmentReadinessHint,
  };
}

export function agentRuntimeRecoveryActions(
  view: Pick<
    AgentRuntimeView,
    | "state"
    | "assignmentReadinessHint"
    | "lastResultId"
    | "resultCount"
    | "unresolvedFailureDispatchId"
    | "attentionHints"
  >,
): AgentRuntimeRecoveryAction[] {
  const actions: AgentRuntimeRecoveryAction[] = [];
  const canRetryNormally =
    view.assignmentReadinessHint === "ready" &&
    (view.state === "ready" ||
      view.state === "result_available" ||
      view.state === "waiting_conductor" ||
      (view.state === "delivery_failed" && hasAgentResultContext(view)));

  if (canRetryNormally) {
    actions.push(
      failedDispatchRecoveryAction({
        id: "retry_delivery",
        label: "重试发送",
        description: "使用最近失败的 dispatch 内容重新走正常投递链路。",
        tone: "primary",
        requiresConfirmation: false,
      }),
    );
  }

  if (RECOVERABLE_RETRY_STATES.has(view.state)) {
    actions.push(
      failedDispatchRecoveryAction({
        id: "stop_then_retry",
        label: "停止后重试",
        description: "先停止目标 Agent session，再用最近失败的 dispatch 内容重试。",
        tone: "neutral",
        requiresConfirmation: true,
        confirmMessage: "这会停止目标 Agent session，然后重试最近失败的 dispatch。继续？",
      }),
      failedDispatchRecoveryAction({
        id: "restart_fresh_then_retry",
        label: "重启新会话后重试",
        description: "停止目标 Agent session，启动新 provider 会话，再重试最近失败的 dispatch。",
        tone: "danger",
        requiresConfirmation: true,
        confirmMessage:
          "这会停止目标 Agent session 并启动新 provider 会话；历史 timeline 会保留，但新会话不会继承当前终端上下文。继续？",
      }),
      failedDispatchRecoveryAction({
        id: "force_retry",
        label: "强制发送",
        description: "跳过语义状态门，但仍要求终端可输入且 provider 确认 dispatch marker。",
        tone: "danger",
        requiresConfirmation: true,
        confirmMessage: "强制发送会忽略当前语义状态阻塞，但不会绕过 provider 投递确认。继续？",
      }),
    );
  }

  return actions;
}

export function agentRuntimeStateLabel(
  state: AgentRuntimeState,
  summary?: Pick<ReadTaskStateSessionSummary, "activeDispatchId" | "lastResultId" | "resultCount" | "attentionHints">,
) {
  const labels: Record<AgentRuntimeState, string> = {
    not_started: "Not started",
    starting: "Starting",
    ready: "Ready",
    queued: "Queued",
    delivered_pending: "Delivered",
    running: "Running",
    waiting_input: "Waiting input",
    permission_required: "Permission",
    waiting_conductor: "Waiting conductor",
    result_available: "Result available",
    result_invalid: "Invalid result",
    blocked: "Blocked",
    timeout: "Timeout",
    delivery_failed: "Delivery failed",
    cancellation_requested: "Cancelling",
    cancellation_failed: "Cancellation failed",
    stopping: "Stopping",
    stopped: "Stopped",
    exited: "Exited",
    start_failed: "Start failed",
  };
  const label = labels[state];
  const resultCount = Number(summary?.resultCount ?? 0);
  const hasResultContext = hasAgentResultContext(summary);
  if (state === "delivery_failed" && hasResultContext) return `${label} · result available`;
  if (
    (state === "queued" || state === "delivered_pending" || state === "running") &&
    summary?.activeDispatchId
  ) {
    return `${label} · dispatch ${summary.activeDispatchId}`;
  }
  if ((state === "waiting_input" || state === "permission_required") && resultCount > 0) {
    return `${label} · ${resultCount} ${resultCount === 1 ? "result" : "results"}`;
  }
  return label;
}

function failedDispatchRecoveryAction(
  action: Omit<AgentRuntimeRecoveryAction, "requiresFailedDispatch">,
): AgentRuntimeRecoveryAction {
  return { ...action, requiresFailedDispatch: true };
}

function hasAgentResultContext(
  summary?: Pick<ReadTaskStateSessionSummary, "lastResultId" | "resultCount" | "attentionHints">,
) {
  return (
    Number(summary?.resultCount ?? 0) > 0 ||
    Boolean(summary?.lastResultId) ||
    (summary?.attentionHints ?? []).includes("result_available")
  );
}

export function agentRuntimeStateClass(state: AgentRuntimeState) {
  if (state === "queued" || state === "delivered_pending" || state === "running" || state === "starting" || state === "cancellation_requested") {
    return "state-running";
  }
  if (
    state === "waiting_input" ||
    state === "permission_required" ||
    state === "waiting_conductor" ||
    state === "result_available"
  ) {
    return "state-decision";
  }
  if (
    state === "blocked" ||
    state === "timeout" ||
    state === "delivery_failed" ||
    state === "cancellation_failed" ||
    state === "result_invalid" ||
    state === "exited" ||
    state === "start_failed"
  ) {
    return "state-blocked";
  }
  return "state-neutral";
}

export function agentRuntimeProgressBucket(state: AgentRuntimeState) {
  if (state === "queued" || state === "delivered_pending" || state === "running" || state === "starting" || state === "cancellation_requested") {
    return "running";
  }
  if (state === "result_available" || state === "waiting_conductor") return "result";
  if (state === "waiting_input" || state === "permission_required") return "waiting";
  if (
    state === "blocked" ||
    state === "timeout" ||
    state === "delivery_failed" ||
    state === "cancellation_failed" ||
    state === "result_invalid" ||
    state === "exited" ||
    state === "start_failed"
  ) {
    return "blocked";
  }
  return "ready";
}

function agentRuntimeSessionId(input: {
  agent: Agent;
  project: Pick<Project, "id" | "runtimeProjectId">;
  task: Pick<Task, "id" | "runtimeTaskId">;
}) {
  return createOpencodeSessionKey({
    projectId: getProjectRuntimeId(input.project),
    taskId: getTaskRuntimeId(input.task),
    agentId: input.agent.id,
  });
}

function fallbackAgentRuntimeState(agent: Agent): AgentRuntimeState {
  if (agent.status === "working") return "running";
  if (agent.status === "review") return "waiting_conductor";
  if (agent.status === "waiting") return "waiting_input";
  return "ready";
}

function normalizeAgentRuntimeState(state: string): AgentRuntimeState {
  if (state === "idle") return "ready";
  if (state === "waiting") return "waiting_input";
  if (isAgentRuntimeState(state)) return state;
  return "ready";
}

function isAgentRuntimeState(state: string): state is AgentRuntimeState {
  return AGENT_RUNTIME_STATES.has(state as AgentRuntimeState);
}

const AGENT_RUNTIME_STATES = new Set<AgentRuntimeState>([
  "not_started",
  "starting",
  "ready",
  "queued",
  "delivered_pending",
  "running",
  "waiting_input",
  "permission_required",
  "waiting_conductor",
  "result_available",
  "result_invalid",
  "blocked",
  "timeout",
  "delivery_failed",
  "cancellation_requested",
  "cancellation_failed",
  "stopping",
  "stopped",
  "exited",
  "start_failed",
]);

const RECOVERABLE_RETRY_STATES = new Set<AgentRuntimeState>([
  "delivery_failed",
  "blocked",
  "timeout",
  "result_invalid",
  "exited",
  "start_failed",
  "stopped",
]);

export type AgentRuntimeState =
  | "not_started"
  | "starting"
  | "ready"
  | "queued"
  | "delivered_pending"
  | "running"
  | "waiting_input"
  | "permission_required"
  | "waiting_conductor"
  | "result_available"
  | "result_invalid"
  | "blocked"
  | "timeout"
  | "delivery_failed"
  | "stopping"
  | "stopped"
  | "exited"
  | "start_failed";

export type SessionStoreState = AgentRuntimeState;

export type SessionEventType =
  | "task.user_message"
  | "user.intervention"
  | "session.started"
  | "session.not_started"
  | "session.starting"
  | "session.ready"
  | "session.queued"
  | "session.delivered_pending"
  | "session.running"
  | "session.waiting_input"
  | "session.permission_required"
  | "session.waiting_conductor"
  | "session.result_available"
  | "session.result_invalid"
  | "session.blocked"
  | "session.timeout"
  | "session.delivery_failed"
  | "session.stopping"
  | "session.stopped"
  | "session.exited"
  | "session.start_failed"
  | "dispatch.created"
  | "dispatch.delivered"
  | "dispatch.failed"
  | "dispatch.result_available"
  | "conductor.message"
  | "conductor.wakeup.sent"
  | "conductor.wakeup.queued"
  | "task.completion_claim"
  | "permission.requested"
  | "permission.resolved";

export type SessionStoreEvent = {
  id: string;
  taskId: string;
  sessionId: string;
  type: SessionEventType;
  createdAt: string;
  cursor: number;
  summary: string;
  data?: Record<string, unknown>;
};

export type SessionDispatchRecord = {
  dispatchId: string;
  taskId: string;
  toSessionId: string;
  conductorSessionId?: string;
  assignment: string;
  contextRefs: string[];
  expectedOutput: string;
  priority: "low" | "normal" | "high";
  status: "queued" | "delivered" | "result_available" | "failed";
  createdAt: string;
  deliveredAt?: string;
  failedAt?: string;
  failureReason?: string;
  failureMessage?: string;
  failureError?: string;
  resultAvailableAt?: string;
  resultId?: string;
  resultReason?: string;
  resultCursor?: number;
  resultSource?: string;
  provider?: string;
  providerSessionId?: string;
  providerMessageId?: string;
};

export type SessionResultRecord = {
  resultId: string;
  dispatchId: string;
  taskId: string;
  sessionId: string;
  provider?: string;
  providerSessionId?: string;
  providerMessageId?: string;
  answerText: string;
  answerPreview: string;
  source: string;
  status: "result_available";
  reason: string;
  cursor?: number;
  completedAt?: number;
  createdAt: string;
};

export type SessionMessageRecord = {
  taskId: string;
  sessionId: string;
  dispatchId: string;
  resultId?: string;
  provider?: string;
  providerSessionId?: string;
  providerMessageId?: string;
  providerStepFinishId?: string;
  stepFinishReason?: string;
  answerText: string;
  answerPreview: string;
  source: string;
  completedAt?: number;
  createdAt: string;
};

export type CallSessionInput = {
  taskId: string;
  toSessionId: string;
  assignment: string;
  contextRefs?: string[];
  expectedOutput?: string;
  priority?: "low" | "normal" | "high";
  force?: boolean;
};

export type CallSessionResult = {
  ok: boolean;
  dispatchId: string;
  taskId: string;
  toSessionId: string;
  status: "delivered" | "failed";
  deliveryState: "delivered" | "failed";
  targetSessionState: AgentRuntimeState | "unknown";
  resultState: "pending" | "none";
  async?: boolean;
  turnPolicy: "stop_after_dispatch" | "recover_or_stop";
  turnBoundary?: "dispatch";
  shouldEndTurn?: boolean;
  cannotReadResultUntil?: "provider_result_available";
  nextAllowedAction?: "wait_for_runtime_wakeup";
  message: string;
  errorCode?: "route_validation_failed" | "target_session_start_failed" | "target_session_delivery_timeout";
  error?: string;
};

export type ClaimTaskCompletionInput = {
  taskId: string;
  sessionId: string;
  message: string;
  summary?: string;
};

export type ClaimTaskCompletionResult = {
  ok: boolean;
  taskId: string;
  sessionId: string;
  status: "completion_claim_recorded" | "failed";
  eventType: "task.completion_claim";
  event?: SessionStoreEvent;
  turnPolicy: "stop_for_review_gate" | "recover_or_stop";
  nextAllowedAction?: "wait_for_review_gate";
  message: string;
  errorCode?: "completion_claim_not_supported";
};

export type ReadSessionInput = {
  taskId: string;
  sessionId: string;
  sinceCursor?: number;
  maxChars?: number;
};

export type ReadSessionResult = {
  sessionId: string;
  state: SessionStoreState;
  cursor: number;
  activeDispatchId?: string;
  lastResultId?: string;
  resultCount?: number;
  unresolvedFailureDispatchId?: string;
  attentionHints?: string[];
  assignmentReadinessHint?: "ready" | "unknown" | "not_ready";
  cleanTranscriptTail: string;
  events: SessionStoreEvent[];
  dispatches: SessionDispatchRecord[];
  results: SessionResultRecord[];
  messages: SessionMessageRecord[];
  permissions: unknown[];
  artifacts: unknown[];
};

export type ReadTaskStateInput = {
  taskId: string;
  sinceCursor?: number;
};

export type ReadTaskStateSessionSummary = {
  sessionId: string;
  state: SessionStoreState;
  cursor: number;
  updatedAt?: string;
  lastStateSummary?: string;
  lastStateData?: Record<string, unknown>;
  activeDispatchId?: string;
  lastResultId?: string;
  resultCount?: number;
  unresolvedFailureDispatchId?: string;
  attentionHints?: string[];
  assignmentReadinessHint?: "ready" | "unknown" | "not_ready";
};

export type ReadTaskStateDispatchSummary = {
  dispatchId: string;
  taskId?: string;
  toSessionId: string;
  conductorSessionId?: string;
  assignment?: string;
  contextRefs?: string[];
  expectedOutput?: string;
  priority?: "low" | "normal" | "high";
  status: SessionDispatchRecord["status"];
  createdAt?: string;
  deliveredAt?: string;
  failedAt?: string;
  failureReason?: string;
  failureMessage?: string;
  failureError?: string;
  resultId?: string;
  resultReason?: string;
  resultCursor?: number;
  resultSource?: string;
  resultAvailableAt?: string;
  provider?: string;
  providerSessionId?: string;
  providerMessageId?: string;
  providerStepFinishId?: string;
};

export type ReadTaskStateResultSummary = {
  resultId: string;
  dispatchId: string;
  sessionId: string;
  answerPreview?: string;
  cursor?: number;
  createdAt?: string;
};

export type TaskStatePendingDecision =
  | {
      type: "worker_result_available";
      dispatchId: string;
      sessionId: string;
      resultId?: string;
      cursor?: number;
      severity?: "info" | "attention" | "blocking";
      actionHint?: string;
      relatedDispatchIds?: string[];
    }
  | {
      type:
        | "session_waiting_input"
        | "session_permission_required"
        | "session_blocked"
        | "session_timeout"
        | "session_delivery_failed"
        | "session_result_invalid"
        | "session_exited";
      sessionId: string;
      dispatchId?: string;
      cursor?: number;
      summary?: string;
      severity?: "info" | "attention" | "blocking";
      actionHint?: string;
      relatedDispatchIds?: string[];
    }
  | {
      type: "permission_requested";
      sessionId: string;
      permissionId?: string;
      summary?: string;
      severity?: "info" | "attention" | "blocking";
      actionHint?: string;
      relatedDispatchIds?: string[];
    };

export type ReadTaskStateResult = {
  taskId: string;
  cursor: number;
  events?: SessionStoreEvent[];
  sessions: ReadTaskStateSessionSummary[];
  dispatches: ReadTaskStateDispatchSummary[];
  results: ReadTaskStateResultSummary[];
  messages: SessionMessageRecord[];
  permissions?: unknown[];
  artifacts?: unknown[];
  pendingDecisions: TaskStatePendingDecision[];
};

export function normalizeSessionStoreCursor(value: unknown) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return 0;
  return Math.floor(numeric);
}

export function createDispatchId(taskId: string, toSessionId: string, round: number) {
  return hashDispatchSeed(`${taskId}:${toSessionId}:${Math.max(1, Math.floor(round))}`).slice(0, 6);
}

function hashDispatchSeed(value: string) {
  let hash = 0x811c9dc5;
  for (const char of value) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0").toUpperCase();
}

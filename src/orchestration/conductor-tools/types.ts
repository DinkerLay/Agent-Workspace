export type SessionStoreState = "running" | "idle" | "waiting" | "blocked" | "timeout" | "exited";

export type SessionEventType =
  | "task.user_message"
  | "user.intervention"
  | "session.started"
  | "session.idle"
  | "session.waiting"
  | "session.blocked"
  | "session.timeout"
  | "session.exited"
  | "dispatch.created"
  | "dispatch.delivered"
  | "dispatch.failed"
  | "dispatch.result_available"
  | "conductor.wakeup.sent"
  | "conductor.wakeup.queued"
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
};

export type CallSessionResult = {
  ok: boolean;
  dispatchId: string;
  taskId: string;
  toSessionId: string;
  status: "delivered" | "failed";
  deliveryState: "delivered" | "failed";
  targetSessionState: "running" | "not_started" | "running_not_ready" | "unknown";
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
    }
  | {
      type: "session_waiting" | "session_blocked" | "session_timeout";
      sessionId: string;
      cursor?: number;
      summary?: string;
    }
  | {
      type: "permission_requested";
      sessionId: string;
      permissionId?: string;
      summary?: string;
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

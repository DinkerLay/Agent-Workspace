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
  | "cancellation_requested"
  | "cancellation_failed"
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
  | "session.cancellation_requested"
  | "session.cancellation_failed"
  | "session.stopping"
  | "session.stopped"
  | "session.exited"
  | "session.start_failed"
  | "terminal.not_started"
  | "terminal.starting"
  | "terminal.ready"
  | "terminal.running"
  | "terminal.stopping"
  | "terminal.stopped"
  | "terminal.exited"
  | "terminal.start_failed"
  | "provider.ready"
  | "provider.running"
  | "provider.waiting_input"
  | "provider.permission_required"
  | "provider.waiting_conductor"
  | "provider.blocked"
  | "provider.timeout"
  | "provider.result_invalid"
  | "dispatch.created"
  | "dispatch.input_accepted"
  | "dispatch.delivered"
  | "dispatch.provider.received"
  | "dispatch.provider.failed"
  | "dispatch.cancellation_requested"
  | "dispatch.cancelled"
  | "dispatch.cancel_failed"
  | "dispatch.failed"
  | "dispatch.result_available"
  | "conductor.message"
  | "conductor.wakeup.sent"
  | "conductor.wakeup.queued"
  | "conductor.wakeup.attempting"
  | "conductor.wakeup.observed"
  | "task.completion_claim"
  | "permission.requested"
  | "permission.response_submitted"
  | "permission.response_recovery_queued"
  | "permission.reissued"
  | "permission.response_retry_required"
  | "permission.resolved"
  | "question.response_submitted";

export type SessionStoreEvent = {
  id: string;
  /** Stable Task/Run outbox identity used to make cross-store publication idempotent. */
  sourceEventId?: string;
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
  /**
   * Runtime-resolved, immutable copies of Provider semantic results selected
   * by the Conductor with `result:<resultId>` context references.  This is
   * deliberately not PTY transcript data and is never a worker-to-worker
   * control channel.
   */
  contextPackets?: SessionResultContextPacket[];
  expectedOutput: string;
  priority: "low" | "normal" | "high";
  status: "queued" | "input_accepted" | "delivered" | "cancellation_requested" | "cancelled" | "cancel_failed" | "provider_failed" | "result_available" | "failed";
  createdAt: string;
  inputAcceptedAt?: string;
  providerReceivedAt?: string;
  providerFailedAt?: string;
  cancellationRequestedAt?: string;
  cancelledAt?: string;
  cancellationFailedAt?: string;
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

export type SessionResultContextPacket = {
  ref: string;
  kind: "provider_result";
  resultId: string;
  sourceAgentId?: string;
  sourceDispatchId: string;
  answerText: string;
  createdAt?: string;
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
  /** Stable capability-card id when the active Agent Loop bridge is used. */
  agentId?: string;
  toSessionId: string;
  status: "accepted" | "delivered" | "queued" | "failed";
  deliveryState: "input_accepted" | "delivered" | "queued" | "failed";
  targetSessionState: AgentRuntimeState | "unknown";
  resultState: "pending" | "none";
  async?: boolean;
  turnPolicy: "conductor_decides_turn_boundary" | "continue_dispatching_or_wait" | "recover_or_stop";
  turnBoundary?: "none";
  shouldEndTurn?: boolean;
  cannotReadResultUntil?: "provider_result_available";
  nextAllowedAction?: "wait_for_runtime_wakeup" | "dispatch_other_work_or_wait_for_runtime_wakeup" | "dispatch_more_or_end_decision_turn";
  message: string;
  errorCode?:
    | "dispatch_payload_invalid"
    | "agent_card_not_found"
    | "route_validation_failed"
    | "context_reference_invalid"
    | "task_continuation_failed"
    | "target_session_start_failed"
    | "terminal_input_authority_unavailable"
    | "terminal_input_rejected";
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
  turnPolicy: "wait_for_user_delivery_confirmation" | "continue_loop" | "recover_or_stop";
  nextAllowedAction?: "wait_for_user_to_inspect_artifact";
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
  terminalState?: SessionStoreState;
  providerState?: SessionStoreState;
  cursor: number;
  lastStateSummary?: string;
  lastStateData?: Record<string, unknown>;
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
  terminalState?: SessionStoreState;
  providerState?: SessionStoreState;
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
  contextPackets?: SessionResultContextPacket[];
  expectedOutput?: string;
  priority?: "low" | "normal" | "high";
  status: SessionDispatchRecord["status"];
  createdAt?: string;
  inputAcceptedAt?: string;
  providerReceivedAt?: string;
  providerFailedAt?: string;
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
  /** Durable, one-shot answers to native Provider questions. */
  questionResponses?: unknown[];
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

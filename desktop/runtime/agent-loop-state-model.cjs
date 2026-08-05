const TASK_STATUS = Object.freeze({
  QUEUED: "queued",
  RUNNING: "running",
  DELIVERY_READY: "delivery_ready",
  STOPPING: "stopping",
  STOPPED: "stopped",
  DELETING: "deleting",
  ACHIEVED: "achieved",
  ARCHIVED: "archived",
});

const RUN_STATUS = Object.freeze({
  RUNNING: "running",
  RECOVERY_REQUIRED: "recovery_required",
  STOPPED: "stopped",
  ACHIEVED: "achieved",
  FAILED: "failed",
});

const TASK_TRANSITIONS = new Map([
  [TASK_STATUS.QUEUED, new Set([TASK_STATUS.RUNNING, TASK_STATUS.DELETING])],
  // running -> queued is a start-command compensation only: no native
  // Conductor was created, so the prepared Run is marked failed and retryable.
  [TASK_STATUS.RUNNING, new Set([TASK_STATUS.QUEUED, TASK_STATUS.DELIVERY_READY, TASK_STATUS.STOPPING, TASK_STATUS.DELETING])],
  [TASK_STATUS.DELIVERY_READY, new Set([TASK_STATUS.RUNNING, TASK_STATUS.ACHIEVED, TASK_STATUS.STOPPING, TASK_STATUS.DELETING])],
  [TASK_STATUS.STOPPING, new Set([TASK_STATUS.STOPPED, TASK_STATUS.DELETING])],
  [TASK_STATUS.STOPPED, new Set([TASK_STATUS.RUNNING, TASK_STATUS.DELETING])],
  [TASK_STATUS.ACHIEVED, new Set([TASK_STATUS.RUNNING, TASK_STATUS.DELETING, TASK_STATUS.ARCHIVED])],
  // Restore deliberately returns to achieved.  The original Run and Provider
  // binding survive the recycle state, so the existing explicit resume path
  // remains the sole way back to running.
  [TASK_STATUS.ARCHIVED, new Set([TASK_STATUS.ACHIEVED, TASK_STATUS.DELETING])],
  [TASK_STATUS.DELETING, new Set()],
]);

function canTransitionTaskStatus(from, to) {
  return from === to || Boolean(TASK_TRANSITIONS.get(String(from))?.has(String(to)));
}

function assertTaskStatusTransition(from, to, errorCode = "loop_task_status_transition_invalid") {
  if (!canTransitionTaskStatus(from, to)) {
    const error = new Error(errorCode);
    error.from = String(from);
    error.to = String(to);
    throw error;
  }
}

function isTaskUnavailableForContinuation(status) {
  return [
    TASK_STATUS.ACHIEVED,
    TASK_STATUS.ARCHIVED,
    TASK_STATUS.STOPPED,
    TASK_STATUS.STOPPING,
    TASK_STATUS.DELETING,
  ].includes(String(status));
}

module.exports = {
  RUN_STATUS,
  TASK_STATUS,
  assertTaskStatusTransition,
  canTransitionTaskStatus,
  isTaskUnavailableForContinuation,
};

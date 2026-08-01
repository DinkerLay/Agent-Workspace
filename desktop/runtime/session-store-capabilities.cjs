const CAPABILITY_METHODS = Object.freeze({
  readModel: ["onTaskChange", "readEvents", "readSession", "readTaskState"],
  taskTimeline: ["bindTaskRoot", "deleteTask", "recordTaskEvent"],
  coordinator: [
    "recordDispatch",
    "markDispatchInputAccepted",
    "markDispatchDelivered",
    "markDispatchFailed",
    "recordDispatchDeliveryFailure",
    "markDispatchCancellationRequested",
    "markDispatchCancelled",
    "markDispatchCancellationFailed",
    "recordDispatchFailure",
    "recordConductorMessage",
    "recordConductorWakeup",
    "listPendingConductorWakeups",
    "listUnconfirmedConductorWakeups",
    "markConductorWakeupObserved",
  ],
  provider: [
    "readQuestionResponse",
    "recordQuestionResponseSubmitted",
    "recordPermissionRequested",
    "recordPermissionSubmitted",
    "recordPermissionRecoveryPending",
    "recordPermissionRecoveryFailed",
    "recordPermissionReplyFailed",
    "recordPermissionResolved",
    "recordProviderSessionState",
    "markDispatchProviderReceived",
    "recordDispatchProviderFailure",
    "recordDispatchObservationUnavailable",
    "recordDispatchResult",
  ],
  terminal: ["startSession", "recordOutput", "readTerminalLog", "recordTerminalState"],
});

function createSessionStoreCapabilities(store = {}) {
  if (!store || typeof store !== "object") throw new Error("Session Store capabilities require a store.");
  return Object.freeze(Object.fromEntries(
    Object.entries(CAPABILITY_METHODS).map(([owner, methods]) => [owner, capabilityView(store, methods)]),
  ));
}

function capabilityView(store, methods) {
  const entries = methods.flatMap((method) => typeof store[method] === "function"
    ? [[method, store[method].bind(store)]]
    : []);
  return Object.freeze(Object.fromEntries(entries));
}

module.exports = { CAPABILITY_METHODS, createSessionStoreCapabilities };

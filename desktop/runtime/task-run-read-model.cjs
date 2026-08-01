function projectTaskRunReadModel({
  task,
  run,
  allSessionState = {},
  sessionEntries = [],
  artifacts = [],
  events = [],
  continuity,
} = {}) {
  if (!task || !run) throw new Error("TaskRunReadModel requires Task and Run facts.");
  const knownSessionIds = new Set(sessionEntries.map((entry) => String(entry.sessionId ?? "")).filter(Boolean));
  const conductorSessionId = String(sessionEntries.find((entry) => entry.card?.id === "conductor")?.sessionId ?? run.conductorSessionId ?? "");
  const sessionState = {
    ...allSessionState,
    sessions: filterBy(allSessionState.sessions, (item) => knownSessionIds.has(String(item?.sessionId ?? ""))),
    dispatches: filterBy(allSessionState.dispatches, (item) => knownSessionIds.has(String(item?.toSessionId ?? ""))),
    results: filterBy(allSessionState.results, (item) => knownSessionIds.has(String(item?.sessionId ?? ""))),
    messages: filterBy(allSessionState.messages, (item) => String(item?.sessionId ?? "") === conductorSessionId),
    permissions: filterOptionalBySession(allSessionState.permissions, knownSessionIds),
    questionResponses: filterOptionalBySession(allSessionState.questionResponses, knownSessionIds),
    pendingDecisions: filterBy(allSessionState.pendingDecisions, (item) => knownSessionIds.has(String(item?.sessionId ?? ""))),
  };
  const activeEntries = sessionEntries.filter((entry) => {
    if (entry.card?.id === "conductor") return true;
    const sessionId = String(entry.sessionId ?? "");
    return sessionState.sessions.some((item) => String(item?.sessionId ?? "") === sessionId)
      || sessionState.dispatches.some((item) => String(item?.toSessionId ?? "") === sessionId)
      || sessionState.results.some((item) => String(item?.sessionId ?? "") === sessionId)
      || Boolean(entry.terminal);
  });
  const turns = activeEntries.map((entry) => {
    const { card, sessionId, terminal, sessionView } = entry;
    const state = sessionState.sessions.find((item) => String(item?.sessionId ?? "") === String(sessionId));
    const dispatches = sessionState.dispatches.filter((item) => String(item?.toSessionId ?? "") === String(sessionId));
    const result = sessionView?.results?.at(-1);
    const dispatchStatus = String(dispatches.at(-1)?.status ?? "not_dispatched");
    return {
      turnId: `${run.runId}:${card.id}`,
      runId: run.runId,
      instanceId: run.runId,
      nodeId: card.id,
      sessionId,
      purpose: card.id === "conductor" ? "conductor" : "session_agent",
      status: mapSessionStatus(state?.state),
      terminalStatus: terminal?.status === "running"
        ? "live"
        : terminal?.status ?? (dispatchStatus === "not_dispatched" ? "not_started" : "not_live"),
      dispatchStatus,
      output: result?.answerText ? { answerText: result.answerText } : undefined,
      details: { card, dispatches, runtimeState: state?.state },
      terminal,
      startedAt: run.createdAt,
      completedAt: result?.completedAt,
    };
  });
  return {
    task,
    run,
    instances: [{
      instanceId: run.runId,
      kind: "agent_loop",
      status: run.status,
      phase: run.status,
      details: { template: task.architecture.template },
    }],
    workflow: undefined,
    nodes: [],
    turns,
    artifacts,
    attentions: sessionState.pendingDecisions,
    events,
    runtimeState: sessionState,
    continuity,
  };
}

function mapSessionStatus(state) {
  if (["blocked", "result_invalid", "delivery_failed", "start_failed"].includes(String(state))) return "failed";
  if (["result_available", "ready"].includes(String(state))) return "succeeded";
  if (["running", "queued", "delivered_pending"].includes(String(state))) return "running";
  return "pending";
}

function filterBy(value, predicate) {
  return (Array.isArray(value) ? value : []).filter(predicate);
}

function filterOptionalBySession(value, knownSessionIds) {
  if (!Array.isArray(value)) return value;
  return value.filter((item) => {
    const sessionId = String(item?.sessionId ?? "");
    return !sessionId || knownSessionIds.has(sessionId);
  });
}

module.exports = { mapSessionStatus, projectTaskRunReadModel };

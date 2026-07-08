const { formatInteractivePtyInput } = require("./conductor-tool-bridge.cjs");

function createSessionWakeupMonitor({
  ptyManager,
  sessionStore,
  intervalMs = 0,
  debounceMs = 750,
  quietWakeupThresholdMs = 5000,
  conductorMessageQuietThresholdMs = debounceMs,
  dispatchResultReader,
  conductorMessageReader,
  conductorQuestionReader,
  resolveConductorSessionId = inferConductorSessionId,
  formatWakeupInput = formatInteractivePtyInput,
} = {}) {
  if (!ptyManager) throw new Error("Session wakeup monitor requires ptyManager.");
  if (!sessionStore) throw new Error("Session wakeup monitor requires sessionStore.");

  const pendingWakeups = new Map();
  const scheduledInspections = new Map();
  const recordedConductorMessageKeys = new Set();
  const recordedConductorMessageCursors = new Map();
  let timer;
  let pendingWakeupTimer;
  let unsubscribeEvents;
  let started = false;

  function start() {
    if (started) return;
    started = true;
    if (typeof ptyManager.onEvent === "function") {
      unsubscribeEvents = ptyManager.onEvent(handlePtyEvent);
    }
    if (intervalMs > 0) {
      timer = setInterval(() => {
        void tick().catch(() => undefined);
      }, intervalMs);
      timer.unref?.();
    }
  }

  function stop() {
    started = false;
    if (timer) clearInterval(timer);
    timer = undefined;
    if (pendingWakeupTimer) clearTimeout(pendingWakeupTimer);
    pendingWakeupTimer = undefined;
    for (const scheduled of scheduledInspections.values()) clearTimeout(scheduled);
    scheduledInspections.clear();
    unsubscribeEvents?.();
    unsubscribeEvents = undefined;
  }

  async function tick() {
    const sessions = typeof ptyManager.list === "function" ? ptyManager.list() : [];
    const sampled = new Map();
    const result = {
      sampled: 0,
      resultAvailable: 0,
      wakeupsSent: 0,
      wakeupsQueued: 0,
      conductorMessagesRecorded: 0,
    };

    addStats(result, drainPendingWakeups(sessions, sampled));

    for (const session of sessions) {
      addStats(result, await inspectSession(session, sessions, sampled));
    }

    return result;
  }

  function handlePtyEvent(event) {
    if (!event?.id) return;
    if (event.type !== "data" && event.type !== "exit") return;

    if (isConductorSessionId(event.id)) {
      schedulePendingWakeupDrain();
      scheduleSessionInspect(event.id);
      return;
    }
    scheduleSessionInspect(event.id);
  }

  function scheduleSessionInspect(sessionId) {
    const key = String(sessionId);
    const existing = scheduledInspections.get(key);
    if (existing) clearTimeout(existing);
    const scheduled = setTimeout(() => {
      scheduledInspections.delete(key);
      void inspectSessionId(key).catch(() => undefined);
    }, Math.max(0, debounceMs));
    scheduled.unref?.();
    scheduledInspections.set(key, scheduled);
  }

  function schedulePendingWakeupDrain() {
    if (pendingWakeupTimer) clearTimeout(pendingWakeupTimer);
    pendingWakeupTimer = setTimeout(() => {
      pendingWakeupTimer = undefined;
      drainPendingWakeups();
    }, Math.max(0, debounceMs));
    pendingWakeupTimer.unref?.();
  }

  async function inspectSessionId(sessionId) {
    const session = findSession(sessionId);
    if (!session) return emptyResult();
    const sessions = typeof ptyManager.list === "function" ? ptyManager.list() : [session];
    const sampled = new Map();
    return inspectSession(session, sessions, sampled);
  }

  async function inspectSession(session, sessions, sampled) {
    const result = emptyResult();
    if (!session?.id || !session?.taskId) return result;
    if (isConductorSessionId(session.id)) return inspectConductorSession(session, sampled);
    const status = sampleSession(session, sampled);
    result.sampled += 1;

    const view = sessionStore.readSession({
      taskId: session.taskId,
      sessionId: session.id,
      maxChars: 0,
    });
    const dispatches = view.dispatches.filter((dispatch) => dispatch.status === "delivered");

    for (const dispatch of dispatches) {
      const providerResult = await readDispatchResult({ session, dispatch, status });
      if (!providerResult?.answerText) continue;
      if (!hasCompletedProviderResult(providerResult)) continue;

      const updated = sessionStore.recordDispatchResult({
        taskId: session.taskId,
        sessionId: session.id,
        dispatchId: dispatch.dispatchId,
        reason: "provider-turn-completed",
        cursor: status.cursor,
        provider: providerResult.provider,
        providerSessionId: providerResult.providerSessionId,
        providerMessageId: providerResult.providerMessageId ?? providerResult.messageId,
        providerStepFinishId: providerResult.providerStepFinishId ?? providerResult.stepFinishId,
        stepFinishReason: providerResult.stepFinishReason,
        answerText: providerResult.answerText,
        source: providerResult.source,
        completedAt: providerResult.completedAt,
      });
      if (updated.status !== "result_available" || updated.changed === false) continue;
      result.resultAvailable += 1;

      const conductorSessionId = resolveWakeupConductorSessionId({
        session,
        dispatch,
        sessions,
        resolveConductorSessionId,
      });
      if (!conductorSessionId) continue;
      const wakeup = {
        key: `${session.taskId}:${conductorSessionId}:${session.id}:${dispatch.dispatchId}`,
        taskId: session.taskId,
        conductorSessionId,
        workerSessionId: session.id,
        dispatchId: dispatch.dispatchId,
        resultId: updated.resultId,
        resultSource: updated.source,
        providerSessionId: updated.providerSessionId,
        providerMessageId: updated.providerMessageId,
        providerStepFinishId: updated.providerStepFinishId,
        answerText: updated.answerText ?? providerResult.answerText,
        workerState: status.state,
        cursor: status.cursor,
      };

      if (trySendWakeup(wakeup, sessions, sampled)) {
        result.wakeupsSent += 1;
      } else {
        pendingWakeups.set(wakeup.key, wakeup);
        sessionStore.recordConductorWakeup({
          taskId: wakeup.taskId,
          sessionId: wakeup.conductorSessionId,
          workerSessionId: wakeup.workerSessionId,
          dispatchId: wakeup.dispatchId,
          resultId: wakeup.resultId,
          workerState: wakeup.workerState,
          cursor: wakeup.cursor,
          status: "queued",
          summary: `Conductor wakeup queued for ${roleNameFromSessionId(wakeup.workerSessionId)} result`,
        });
        result.wakeupsQueued += 1;
      }
    }

    return result;
  }

  async function inspectConductorSession(session, sampled) {
    const result = emptyResult();
    const status = sampleSession(session, sampled);
    result.sampled += 1;
    if (status.state === "running" && status.lastOutputAgeMs < conductorMessageQuietThresholdMs) return result;

    const view = sessionStore.readSession({
      taskId: session.taskId,
      sessionId: session.id,
      maxChars: 0,
    });
    const afterMessageCreatedAt = sessionStartedAtFromEvents(view.events);
    const providerQuestion = await readConductorQuestion({
      session,
      status,
      afterMessageCreatedAt,
    });
    if (providerQuestion?.answerText || providerQuestion?.questionText) {
      sessionStore.recordState(
        { taskId: session.taskId, sessionId: session.id },
        "waiting_input",
        conductorQuestionSummary(providerQuestion),
        {
          source: providerQuestion.source,
          provider: providerQuestion.provider,
          providerSessionId: providerQuestion.providerSessionId,
          providerMessageId: providerQuestion.providerMessageId ?? providerQuestion.messageId,
          providerQuestionPartId: providerQuestion.providerQuestionPartId ?? providerQuestion.questionPartId,
          question: providerQuestion.questionText,
        },
      );
      return result;
    }

    if (hasRecordedConductorMessageAtCursor(session, status, recordedConductorMessageCursors)) return result;

    const providerMessage = await readConductorMessage({
      session,
      status,
      afterMessageCreatedAt,
    });
    if (!providerMessage?.answerText) return result;
    if (!hasCompletedProviderResult(providerMessage)) return result;

    const messageKey = conductorMessageKey(session, providerMessage);
    if (recordedConductorMessageKeys.has(messageKey)) return result;
    if (view.events.some((event) => isRecordedConductorProviderMessage(event, providerMessage))) {
      recordedConductorMessageKeys.add(messageKey);
      recordedConductorMessageCursors.set(conductorSessionKey(session), status.cursor);
      return result;
    }

    sessionStore.recordConductorMessage({
      taskId: session.taskId,
      sessionId: session.id,
      message: providerMessage.answerText,
      summary: "Conductor output message",
      source: providerMessage.source,
      provider: providerMessage.provider,
      providerSessionId: providerMessage.providerSessionId,
      providerMessageId: providerMessage.providerMessageId ?? providerMessage.messageId,
      providerStepFinishId: providerMessage.providerStepFinishId ?? providerMessage.stepFinishId,
      stepFinishReason: providerMessage.stepFinishReason,
      completedAt: providerMessage.completedAt,
      cursor: status.cursor,
    });
    sessionStore.recordState(
      { taskId: session.taskId, sessionId: session.id },
      "ready",
      "Conductor provider turn completed.",
      {
        source: providerMessage.source,
        provider: providerMessage.provider,
        providerSessionId: providerMessage.providerSessionId,
        providerMessageId: providerMessage.providerMessageId ?? providerMessage.messageId,
      },
    );
    recordedConductorMessageKeys.add(messageKey);
    recordedConductorMessageCursors.set(conductorSessionKey(session), status.cursor);
    result.conductorMessagesRecorded += 1;
    return result;
  }

  function drainPendingWakeups(sessions = typeof ptyManager.list === "function" ? ptyManager.list() : [], sampled = new Map()) {
    const result = emptyResult();
    for (const wakeup of [...pendingWakeups.values()]) {
      if (trySendWakeup(wakeup, sessions, sampled)) {
        pendingWakeups.delete(wakeup.key);
        result.wakeupsSent += 1;
      }
    }
    return result;
  }

  function trySendWakeup(wakeup, sessions, sampled) {
    const conductor = sessions.find((session) => session.id === wakeup.conductorSessionId);
    if (!conductor || conductor.status !== "running") return false;
    const conductorStatus = sampleSession(conductor, sampled);
    if (!canWakeConductor(conductorStatus)) return false;

    const message = formatWakeupMessage(wakeup);
    ptyManager.write(wakeup.conductorSessionId, formatWakeupInput(message));
    sessionStore.recordConductorWakeup({
      taskId: wakeup.taskId,
      sessionId: wakeup.conductorSessionId,
      workerSessionId: wakeup.workerSessionId,
      dispatchId: wakeup.dispatchId,
      resultId: wakeup.resultId,
      workerState: wakeup.workerState,
      cursor: wakeup.cursor,
      status: "sent",
      summary: `Conductor wakeup sent for ${roleNameFromSessionId(wakeup.workerSessionId)} result`,
    });
    return true;
  }

  function sampleSession(session, sampled) {
    if (sampled.has(session.id)) return sampled.get(session.id);
    const status =
      typeof ptyManager.sampleStatus === "function"
        ? ptyManager.sampleStatus(session.id)
        : { id: session.id, state: session.status === "running" ? "running" : "exited", cursor: 0 };
    const normalized = {
      id: session.id,
      state: status?.state ?? "running",
      summary: status?.summary ?? "",
      cursor: Number.isFinite(status?.cursor) ? status.cursor : 0,
      lastOutputAgeMs: Number.isFinite(status?.lastOutputAgeMs) ? status.lastOutputAgeMs : 0,
    };
    sampled.set(session.id, normalized);
    return normalized;
  }

  async function readDispatchResult({ session, dispatch, status }) {
    if (typeof dispatchResultReader !== "function") return undefined;
    return dispatchResultReader({ session, dispatch, status });
  }

  async function readConductorMessage({ session, status, afterMessageCreatedAt }) {
    if (typeof conductorMessageReader !== "function") return undefined;
    return conductorMessageReader({ session, status, afterMessageCreatedAt });
  }

  async function readConductorQuestion({ session, status, afterMessageCreatedAt }) {
    if (typeof conductorQuestionReader !== "function") return undefined;
    return conductorQuestionReader({ session, status, afterMessageCreatedAt });
  }

  function canWakeConductor(status) {
    return status.state === "running" && status.lastOutputAgeMs >= quietWakeupThresholdMs;
  }

  function findSession(sessionId) {
    if (typeof ptyManager.get === "function") return ptyManager.get(sessionId);
    const sessions = typeof ptyManager.list === "function" ? ptyManager.list() : [];
    return sessions.find((session) => session.id === sessionId);
  }

  return { start, stop, tick };
}

function hasCompletedProviderResult(providerResult) {
  if (providerResult.stepFinishReason) return providerResult.stepFinishReason === "stop";
  return Number.isFinite(Number(providerResult.completedAt)) && Number(providerResult.completedAt) > 0;
}

function formatWakeupMessage(wakeup) {
  const roleName = roleNameFromSessionId(wakeup.workerSessionId);
  const lines = [
    `Runtime wakeup: ${roleName} result available`,
    "",
    `Task: ${wakeup.taskId}`,
    `Worker session: ${wakeup.workerSessionId}`,
    `Dispatch ID: ${wakeup.dispatchId}`,
    `Result ID: ${wakeup.resultId ?? "(not recorded)"}`,
    `Cursor: ${Number.isFinite(wakeup.cursor) ? wakeup.cursor : "(unknown)"}`,
    "",
    `${roleName} answer:`,
    String(wakeup.answerText ?? ""),
    "",
    "Conductor: decide the next action from this worker answer. If follow-up work is needed, use call_session; do not edit worker-owned deliverables yourself.",
  ];
  return lines.join("\n");
}

function inferConductorSessionId(session) {
  const sessionId = String(session?.id ?? "");
  const taskId = String(session?.taskId ?? "");
  if (!sessionId) return `${taskId}-conductor`;

  const parts = sessionId.split(":");
  if (parts.length > 1) {
    parts[parts.length - 1] = `${taskId}-conductor`;
    return parts.join(":");
  }
  return `${taskId}-conductor`;
}

function resolveWakeupConductorSessionId({ session, dispatch, sessions, resolveConductorSessionId }) {
  const recorded = String(dispatch?.conductorSessionId ?? "");
  if (recorded) return recorded;

  const liveConductor = sessions.find(
    (candidate) =>
      String(candidate?.taskId ?? "") === String(session?.taskId ?? "") &&
      String(candidate?.id ?? "") !== String(session?.id ?? "") &&
      isConductorSessionId(candidate?.id),
  );
  if (liveConductor?.id) return String(liveConductor.id);

  return resolveConductorSessionId(session);
}

function isConductorSessionId(sessionId) {
  return /(^|[-:])conductor$/i.test(String(sessionId ?? ""));
}

function roleNameFromSessionId(sessionId) {
  const tail = String(sessionId ?? "").split(":").at(-1) ?? "worker";
  const role = tail.split("-").at(-1) ?? "worker";
  return role.charAt(0).toUpperCase() + role.slice(1);
}

function emptyResult() {
  return {
    sampled: 0,
    resultAvailable: 0,
    wakeupsSent: 0,
    wakeupsQueued: 0,
    conductorMessagesRecorded: 0,
  };
}

function addStats(target, source) {
  if (!source) return target;
  target.sampled += source.sampled ?? 0;
  target.resultAvailable += source.resultAvailable ?? 0;
  target.wakeupsSent += source.wakeupsSent ?? 0;
  target.wakeupsQueued += source.wakeupsQueued ?? 0;
  target.conductorMessagesRecorded += source.conductorMessagesRecorded ?? 0;
  return target;
}

function sessionStartedAtFromEvents(events = []) {
  const started = events.find((event) => event.type === "session.started");
  return started?.createdAt;
}

function conductorMessageKey(session, providerMessage) {
  const providerMessageId = providerMessage.providerMessageId ?? providerMessage.messageId;
  if (providerMessageId) return `${session.taskId}:${session.id}:${providerMessageId}`;
  return `${session.taskId}:${session.id}:${providerMessage.completedAt ?? ""}:${String(providerMessage.answerText ?? "").slice(0, 200)}`;
}

function conductorSessionKey(session) {
  return `${session.taskId}:${session.id}`;
}

function conductorQuestionSummary(providerQuestion) {
  const question = String(providerQuestion?.questionText ?? "").trim();
  if (question) return question;
  const text = String(providerQuestion?.answerText ?? "").trim();
  if (text) return text.slice(0, 240);
  return "Conductor is waiting for user input.";
}

function hasRecordedConductorMessageAtCursor(session, status, recordedCursors) {
  const previousCursor = recordedCursors.get(conductorSessionKey(session));
  return Number.isFinite(previousCursor) && previousCursor >= status.cursor;
}

function isRecordedConductorProviderMessage(event, providerMessage) {
  if (event.type !== "conductor.message") return false;
  const providerMessageId = providerMessage.providerMessageId ?? providerMessage.messageId;
  return Boolean(providerMessageId) && event.data?.providerMessageId === providerMessageId;
}

module.exports = {
  createSessionWakeupMonitor,
  formatWakeupMessage,
  inferConductorSessionId,
};

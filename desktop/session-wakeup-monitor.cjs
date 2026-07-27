const { formatInteractivePtyInput } = require("./conductor-tool-bridge.cjs");

function createSessionWakeupMonitor({
  ptyManager,
  sessionStore,
  intervalMs = 0,
  debounceMs = 750,
  dispatchStateReader,
  dispatchResultReader,
  conductorMessageReader,
  conductorQuestionReader,
  workerQuestionReader,
  resolveConductorSessionId = inferConductorSessionId,
  resolveAgentId = () => undefined,
  enqueueConductorInput,
  onConductorWaiting,
  formatWakeupInput = formatInteractivePtyInput,
} = {}) {
  if (!ptyManager) throw new Error("Session wakeup monitor requires ptyManager.");
  if (!sessionStore) throw new Error("Session wakeup monitor requires sessionStore.");

  const pendingWakeups = new Map();
  const scheduledInspections = new Map();
  const recordedConductorMessageKeys = new Set();
  const recordedWorkerAttentionKeys = new Set();
  const recordedWorkerFailureKeys = new Set();
  const recordedConductorMessageCursors = new Map();
  const providerHookErrors = new Map();
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
    providerHookErrors.clear();
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
      providerFailures: 0,
    };

    addStats(result, await drainPendingWakeups(sessions, sampled));

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

  // Hooks only report Provider-native facts. They do not choose a retry or
  // write another Session: the normal durable inspection path does that work.
  function handleProviderHookEvent(event) {
    const sessionId = String(event?.sessionId ?? "");
    if (!sessionId) return;
    if (event.kind === "status" && String(event.payload?.type ?? "") === "error") {
      providerHookErrors.set(sessionId, {
        message: providerHookErrorMessage(event.payload?.error),
        occurredAt: new Date().toISOString(),
      });
    }
    scheduleSessionInspect(sessionId);
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
      void drainPendingWakeups().catch(() => undefined);
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

    let view = sessionStore.readSession({
      taskId: session.taskId,
      sessionId: session.id,
      maxChars: 0,
    });
    addStats(result, await reconcileDispatchProviderFacts({ session, sessions, sampled, view }));
    view = sessionStore.readSession({
      taskId: session.taskId,
      sessionId: session.id,
      maxChars: 0,
    });
    const providerQuestion = await readWorkerQuestion({
      session,
      status,
      afterMessageCreatedAt: sessionStartedAtFromEvents(view.events),
    });
    if (providerQuestion?.answerText || providerQuestion?.questionText) {
      const attentionKey = workerAttentionKey(session, providerQuestion, status);
      if (!recordedWorkerAttentionKeys.has(attentionKey)) {
        sessionStore.recordState(
          { taskId: session.taskId, sessionId: session.id },
          "waiting_input",
          workerQuestionSummary(providerQuestion),
          {
            source: providerQuestion.source,
            provider: providerQuestion.provider,
            providerSessionId: providerQuestion.providerSessionId,
            providerMessageId: providerQuestion.providerMessageId ?? providerQuestion.messageId,
            providerQuestionPartId: providerQuestion.providerQuestionPartId ?? providerQuestion.questionPartId,
            question: providerQuestion.questionText,
          },
        );
        const activeDispatch = view.dispatches.findLast((dispatch) => dispatch.status === "delivered");
        const agentId = dispatchAgentId(activeDispatch, session, resolveAgentId);
        const conductorSessionId = resolveWakeupConductorSessionId({ session, dispatch: activeDispatch, sessions, resolveConductorSessionId });
        const wakeup = {
          kind: "attention",
          key: `attention:${session.taskId}:${conductorSessionId}:${session.id}:${attentionKey}`,
          taskId: session.taskId,
          conductorSessionId,
          workerSessionId: session.id,
          agentId,
          dispatchId: activeDispatch?.dispatchId,
          resultId: undefined,
          resultSource: providerQuestion.source,
          providerSessionId: providerQuestion.providerSessionId,
          providerMessageId: providerQuestion.providerMessageId ?? providerQuestion.messageId,
          answerText: providerQuestion.questionText ?? providerQuestion.answerText,
          workerState: "waiting_input",
          cursor: status.cursor,
        };
        recordedWorkerAttentionKeys.add(attentionKey);
        if (conductorSessionId && await trySendWakeup(wakeup, sessions, sampled)) {
          result.wakeupsSent += 1;
        } else if (conductorSessionId) {
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
            summary: `Conductor wakeup queued for ${roleNameFromSessionId(wakeup.workerSessionId)} attention`,
          });
          result.wakeupsQueued += 1;
        }
      }
      return result;
    }
    const dispatches = view.dispatches.filter((dispatch) => dispatch.status === "delivered");

    const latestActiveDispatch = dispatches.at(-1);
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
        agentId: dispatchAgentId(dispatch, session, resolveAgentId),
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

      if (await trySendWakeup(wakeup, sessions, sampled)) {
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

  async function reconcileDispatchProviderFacts({ session, sessions, sampled, view }) {
    const result = emptyResult();
    const dispatches = view.dispatches.filter((dispatch) => ["queued", "input_accepted", "delivered"].includes(dispatch.status));
    const hookError = providerHookErrors.get(String(session.id));

    for (const dispatch of dispatches) {
      let fact;
      if (typeof dispatchStateReader === "function") {
        try {
          fact = await dispatchStateReader({ session, dispatch });
        } catch {
          // Adapter unavailability is not a delivery failure. Retain the
          // durable input receipt until a later Provider observation decides.
          fact = undefined;
        }
      }

      if (fact?.state === "received" || fact?.state === "terminal_failure") {
        sessionStore.markDispatchProviderReceived?.({
          taskId: session.taskId,
          sessionId: session.id,
          dispatchId: dispatch.dispatchId,
          provider: fact.provider,
          providerSessionId: fact.receipt?.providerSessionId,
          providerMessageId: fact.receipt?.providerMessageId,
          dispatchMessageCreatedAt: fact.receipt?.dispatchMessageCreatedAt,
        });
      }

      const failure = fact?.state === "terminal_failure"
        ? {
          key: `${dispatch.dispatchId}:${fact.failure?.providerStepFinishId ?? fact.failure?.providerMessageId ?? "terminal"}`,
          reason: "provider_terminal_failure",
          message: `OpenCode ended this dispatch with ${fact.failure?.stepFinishReason ?? "an error"}.`,
          provider: fact.provider,
          providerSessionId: fact.receipt?.providerSessionId,
          providerMessageId: fact.failure?.providerMessageId ?? fact.receipt?.providerMessageId,
          providerStepFinishId: fact.failure?.providerStepFinishId,
          stepFinishReason: fact.failure?.stepFinishReason,
        }
        // A Provider session-level hook has no dispatch id. It can therefore
        // only be attributed to the newest outstanding turn in that native
        // Session. Exact per-dispatch failures always come from the Adapter
        // branch above; never fan one generic session error across turns.
        : hookError && dispatch === latestActiveDispatch
          ? {
            key: `${dispatch.dispatchId}:hook:${hookError.occurredAt}`,
            reason: "provider_session_error",
            message: hookError.message,
            provider: "opencode",
          }
          : undefined;

      if (!failure || recordedWorkerFailureKeys.has(failure.key)) continue;
      recordedWorkerFailureKeys.add(failure.key);
      providerHookErrors.delete(String(session.id));
      sessionStore.recordDispatchProviderFailure?.({
        taskId: session.taskId,
        sessionId: session.id,
        dispatchId: dispatch.dispatchId,
        reason: failure.reason,
        message: failure.message,
        provider: failure.provider,
        providerSessionId: failure.providerSessionId,
        providerMessageId: failure.providerMessageId,
        providerStepFinishId: failure.providerStepFinishId,
        stepFinishReason: failure.stepFinishReason,
        state: session.status === "running" ? "blocked" : "exited",
      });
      result.providerFailures += 1;

      const conductorSessionId = resolveWakeupConductorSessionId({ session, dispatch, sessions, resolveConductorSessionId });
      if (!conductorSessionId) continue;
      const wakeup = {
        kind: "failure",
        key: `failure:${session.taskId}:${conductorSessionId}:${session.id}:${failure.key}`,
        taskId: session.taskId,
        conductorSessionId,
        workerSessionId: session.id,
        agentId: dispatchAgentId(dispatch, session, resolveAgentId),
        dispatchId: dispatch.dispatchId,
        workerState: "blocked",
        cursor: sampleSession(session, sampled).cursor,
        reason: failure.reason,
        answerText: failure.message,
      };
      if (await trySendWakeup(wakeup, sessions, sampled)) {
        result.wakeupsSent += 1;
      } else {
        pendingWakeups.set(wakeup.key, wakeup);
        result.wakeupsQueued += 1;
      }
    }
    return result;
  }

  async function inspectConductorSession(session, sampled) {
    const result = emptyResult();
    const status = sampleSession(session, sampled);
    result.sampled += 1;
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
      "waiting_conductor",
      "Conductor decision completed; awaiting a semantic Runtime wakeup.",
      {
        source: providerMessage.source,
        provider: providerMessage.provider,
        providerSessionId: providerMessage.providerSessionId,
        providerMessageId: providerMessage.providerMessageId ?? providerMessage.messageId,
      },
    );
    await onConductorWaiting?.({
      taskId: session.taskId,
      sessionId: session.id,
      incarnationId: session.incarnationId,
    });
    // A worker can finish during the last active Conductor turn. In that case
    // its semantic wakeup is durably queued because the Conductor is still
    // `running`. The PTY event schedules a drain before this Provider result
    // is observed, so relying on that earlier drain can strand the queue.
    // Once the Provider adapter has recorded this explicit `waiting_conductor`
    // boundary, immediately retry the queued transport facts. This delivers
    // no business decision and performs no retry; it only guarantees the
    // already-recorded semantic event reaches the now-idle Conductor.
    addStats(result, await drainPendingWakeups());
    recordedConductorMessageKeys.add(messageKey);
    recordedConductorMessageCursors.set(conductorSessionKey(session), status.cursor);
    result.conductorMessagesRecorded += 1;
    return result;
  }

  async function drainPendingWakeups(sessions = typeof ptyManager.list === "function" ? ptyManager.list() : [], sampled = new Map()) {
    const result = emptyResult();
    for (const wakeup of [...pendingWakeups.values()]) {
      if (await trySendWakeup(wakeup, sessions, sampled)) {
        pendingWakeups.delete(wakeup.key);
        result.wakeupsSent += 1;
      }
    }
    return result;
  }

  async function trySendWakeup(wakeup, sessions, sampled) {
    const conductor = sessions.find((session) => session.id === wakeup.conductorSessionId);
    if (!conductor || conductor.status !== "running") return false;
    const conductorStatus = sampleSession(conductor, sampled);
    if (!canWakeConductor(conductor, conductorStatus)) return false;

    const message = wakeup.kind === "attention"
      ? formatAttentionWakeupMessage(wakeup)
      : wakeup.kind === "failure"
        ? formatFailureWakeupMessage(wakeup)
        : formatWakeupMessage(wakeup);
    let write;
    try {
      write = typeof enqueueConductorInput === "function"
        ? await enqueueConductorInput({
          taskId: wakeup.taskId,
          sessionId: wakeup.conductorSessionId,
          expectedIncarnationId: conductor.incarnationId,
          source: "conductor_wakeup",
          payload: formatWakeupInput(message),
          idempotencyKey: `wakeup:${wakeup.key}`,
        })
        : ptyManager.write(wakeup.conductorSessionId, formatWakeupInput(message));
    } catch {
      return false;
    }
    if (!write) return false;
    sessionStore.recordState(
      { taskId: wakeup.taskId, sessionId: wakeup.conductorSessionId },
      "running",
      "Runtime delivered a semantic wakeup to Conductor.",
      { wakeupKey: wakeup.key, workerSessionId: wakeup.workerSessionId, dispatchId: wakeup.dispatchId },
    );
    sessionStore.recordConductorWakeup({
      taskId: wakeup.taskId,
      sessionId: wakeup.conductorSessionId,
      workerSessionId: wakeup.workerSessionId,
      dispatchId: wakeup.dispatchId,
      resultId: wakeup.resultId,
      workerState: wakeup.workerState,
      cursor: wakeup.cursor,
      status: "sent",
      summary: `Conductor wakeup sent for ${roleNameFromSessionId(wakeup.workerSessionId)} ${wakeup.kind === "attention" ? "attention" : wakeup.kind === "failure" ? "failure" : "result"}`,
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

  async function readWorkerQuestion({ session, status, afterMessageCreatedAt }) {
    if (typeof workerQuestionReader !== "function") return undefined;
    return workerQuestionReader({ session, status, afterMessageCreatedAt });
  }

  function canWakeConductor(conductor, status) {
    if (status.state !== "running") return false;
    const view = sessionStore.readSession({ taskId: conductor.taskId, sessionId: conductor.id, maxChars: 0 });
    // This is a provider-derived semantic gate. PTY silence, prompt text, and
    // elapsed wall time never decide whether a Conductor may receive a wakeup.
    return view?.state === "ready" || view?.state === "waiting_conductor";
  }

  function findSession(sessionId) {
    if (typeof ptyManager.get === "function") return ptyManager.get(sessionId);
    const sessions = typeof ptyManager.list === "function" ? ptyManager.list() : [];
    return sessions.find((session) => session.id === sessionId);
  }

  return { start, stop, tick, handleProviderHookEvent };
}

function hasCompletedProviderResult(providerResult) {
  if (providerResult.stepFinishReason) return providerResult.stepFinishReason === "stop";
  return Number.isFinite(Number(providerResult.completedAt)) && Number(providerResult.completedAt) > 0;
}

function formatWakeupMessage(wakeup) {
  const agentLabel = agentLabelForWakeup(wakeup);
  const lines = [
    `Runtime wakeup: ${agentLabel} result available`,
    "",
    `Task: ${wakeup.taskId}`,
    `Agent card: ${agentLabel}`,
    `Dispatch ID: ${wakeup.dispatchId}`,
    `Result ID: ${wakeup.resultId ?? "(not recorded)"}`,
    `Cursor: ${Number.isFinite(wakeup.cursor) ? wakeup.cursor : "(unknown)"}`,
    "",
    "The Provider result is stored durably; this wakeup intentionally does not replay terminal output.",
    "Conductor: use read_task_state to inspect the Result ID before deciding. If follow-up work is needed, use call_session; do not edit worker-owned deliverables yourself.",
  ];
  return lines.join("\n");
}

function formatAttentionWakeupMessage(wakeup) {
  const agentLabel = agentLabelForWakeup(wakeup);
  return [
    `Runtime wakeup: ${agentLabel} needs input`,
    "",
    `Task: ${wakeup.taskId}`,
    `Agent card: ${agentLabel}`,
    wakeup.dispatchId ? `Dispatch ID: ${wakeup.dispatchId}` : "Dispatch ID: (none)",
    "",
    "Provider-native question or attention:",
    String(wakeup.answerText ?? ""),
    "",
    "Conductor: inspect task state. Dispatch a correction if the worker can proceed autonomously; otherwise tell the user to answer in the selected native Session terminal.",
  ].join("\n");
}

function formatFailureWakeupMessage(wakeup) {
  const agentLabel = agentLabelForWakeup(wakeup);
  return [
    `Runtime wakeup: ${agentLabel} Provider failure`,
    "",
    `Task: ${wakeup.taskId}`,
    `Agent card: ${agentLabel}`,
    `Dispatch ID: ${wakeup.dispatchId ?? "(unknown)"}`,
    `Failure fact: ${wakeup.reason ?? "provider_terminal_failure"}`,
    "",
    "Provider-reported failure:",
    String(wakeup.answerText ?? "OpenCode reported a terminal failure."),
    "",
    "Conductor: decide whether to inspect this Session state, dispatch corrected bounded work to an approved Agent Card, or explain the blocker to the user. Runtime did not retry this work.",
  ].join("\n");
}

function dispatchAgentId(dispatch, session, resolveAgentId) {
  const recorded = String(dispatch?.agentId ?? "").trim();
  if (recorded) return recorded;
  const resolved = resolveAgentId?.({ taskId: session?.taskId, sessionId: session?.id });
  return String(resolved ?? "").trim() || undefined;
}

function agentLabelForWakeup(wakeup) {
  const agentId = String(wakeup?.agentId ?? "").trim();
  return agentId || roleNameFromSessionId(wakeup?.workerSessionId) || "Session Agent";
}

function workerAttentionKey(session, question, status) {
  return String(
    question?.providerQuestionPartId ?? question?.questionPartId ?? question?.providerMessageId ?? question?.messageId ?? `${session.id}:${status.cursor}:${question?.questionText ?? question?.answerText ?? "attention"}`,
  );
}

function workerQuestionSummary(question) {
  const text = String(question?.questionText ?? question?.answerText ?? "Provider-native attention required.").replace(/\s+/g, " ").trim();
  return text ? `Provider-native input required: ${text.slice(0, 180)}` : "Provider-native input required.";
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
    providerFailures: 0,
  };
}

function addStats(target, source) {
  if (!source) return target;
  target.sampled += source.sampled ?? 0;
  target.resultAvailable += source.resultAvailable ?? 0;
  target.wakeupsSent += source.wakeupsSent ?? 0;
  target.wakeupsQueued += source.wakeupsQueued ?? 0;
  target.conductorMessagesRecorded += source.conductorMessagesRecorded ?? 0;
  target.providerFailures += source.providerFailures ?? 0;
  return target;
}

function providerHookErrorMessage(error) {
  if (typeof error === "string" && error.trim()) return `OpenCode reported session.error: ${error.trim().slice(0, 500)}`;
  if (error && typeof error === "object") {
    const message = String(error.message ?? error.name ?? "").trim();
    if (message) return `OpenCode reported session.error: ${message.slice(0, 500)}`;
  }
  return "OpenCode reported session.error for this native Session.";
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

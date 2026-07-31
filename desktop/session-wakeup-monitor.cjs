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
  // The Observer is an OpenCode-specific, read-only semantic source.  It is
  // deliberately optional during migration so legacy fixture tests can remain
  // narrow; production supplies it for every native OpenCode worker.
  providerObserver,
  resolveConductorSessionId = inferConductorSessionId,
  resolveAgentId = () => undefined,
  enqueueConductorInput,
  // OpenCode consumes a bracketed paste asynchronously. Prefer the owned
  // two-phase TUI submission path whenever Session Authority is available;
  // the raw payload writer remains only for narrow legacy harnesses.
  enqueueConductorInteractiveSubmission,
  // Starting/re-attaching a logical Conductor is owned by the Agent Loop
  // Runtime.  The monitor may request a live target for an already-durable
  // wakeup, but never chooses a retry route or creates a worker Session.
  ensureConductorWakeupTarget,
  listConductorWakeupTargets,
  onConductorWaiting,
  // A Task may only re-open its dispatch window after the Terminal Runtime has
  // accepted a semantic input for the Conductor.  This callback is owned by the
  // Agent Loop runtime; the monitor never chooses the next business action.
  onConductorWakeupAccepted,
  formatWakeupInput = formatInteractivePtyInput,
  // Permission decisions are user-owned. This transport only submits the
  // selected Provider response; it never chooses a response or wakes the
  // Conductor to decide one.
  submitPermissionReply = postOpenCodePermissionReply,
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
  const pendingPermissionReplies = new Map();
  const inFlightPermissionReplies = new Map();
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
    // Wakeups are durable Coordinator commands, not a best-effort in-memory
    // debounce. Rehydrate them whenever the monitor starts; delivery still
    // waits for the Conductor's provider-derived idle boundary.
    hydratePendingWakeups();
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
    const result = emptyResult();

    hydratePendingWakeups(sessions);
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
    if (event.kind === "permission") {
      handlePermissionHookEvent(sessionId, event.payload);
      scheduleSessionInspect(sessionId);
      return;
    }
    if (event.kind === "status" && String(event.payload?.type ?? "") === "error") {
      providerHookErrors.set(sessionId, {
        message: providerHookErrorMessage(event.payload?.error),
        occurredAt: new Date().toISOString(),
      });
    }
    scheduleSessionInspect(sessionId);
  }

  function handlePermissionHookEvent(sessionId, payload = {}) {
    const session = findSession(sessionId);
    if (!session?.taskId || typeof sessionStore.recordPermissionRequested !== "function") return;
    const requestId = providerPermissionRequestId(payload);
    if (!requestId) return;
    const permissionId = `opencode:${requestId}`;
    const key = permissionReplyKey(session.taskId, session.id, permissionId);
    const phase = String(payload.phase ?? "asked");
    if (phase === "replied") {
      pendingPermissionReplies.delete(key);
      inFlightPermissionReplies.delete(key);
      const response = providerPermissionResponse(payload);
      if (!response) return;
      sessionStore.recordPermissionResolved?.({
        taskId: session.taskId,
        sessionId: session.id,
        cwd: session.cwd,
        permissionId,
        response,
      });
      return;
    }

    const requested = sessionStore.recordPermissionRequested({
      taskId: session.taskId,
      sessionId: session.id,
      cwd: session.cwd,
      permissionId,
      requestId,
      provider: "opencode",
      permission: String(payload.permission ?? payload.action ?? "unknown"),
      patterns: providerPermissionPatterns(payload),
      summary: providerPermissionSummary(payload),
    });
    const endpoint = String(payload.replyEndpoint ?? "");
    const token = String(payload.replyToken ?? "");
    if (endpoint && token && requested?.status !== "approved" && requested?.status !== "denied") {
      // This transport capability stays Main-process-only. The persisted
      // Workbench projection deliberately receives neither endpoint nor token.
      pendingPermissionReplies.set(key, { endpoint, token, requestId });
      // A response chosen before an Electron restart is durable user intent,
      // not a reusable endpoint credential. Session Store may have rebound an
      // equivalent logical permission to this new Provider request id; only
      // this fresh hook transport can receive the retained answer.
      const retainedResponse = String(requested?.response ?? "");
      // Only a *fresh Provider request* which adopted a durable answer may be
      // delivered automatically. `submitted` is awaiting a receipt and
      // `reply_failed` is intentionally a user-actionable retry state.  If we
      // include either here, a repeated Provider observation turns one failed
      // delivery into an unbounded background retry loop and makes the Task
      // page's buttons appear ineffective.
      if (String(requested?.status ?? "") === "replaying"
        && ["once", "always", "reject"].includes(retainedResponse)) {
        void respondPermission({
          taskId: session.taskId,
          sessionId: session.id,
          permissionId,
          response: retainedResponse,
        });
      }
    }
  }

  async function respondPermission(input = {}) {
    const taskId = String(input.taskId ?? "");
    const sessionId = String(input.sessionId ?? "");
    const permissionId = String(input.permissionId ?? "");
    const response = normalizePermissionResponse(input.response);
    if (!taskId || !sessionId || !permissionId || !response) {
      return { ok: false, status: "invalid", errorCode: "permission_response_invalid" };
    }
    const key = permissionReplyKey(taskId, sessionId, permissionId);
    const view = sessionStore.readSession?.({ taskId, sessionId, maxChars: 0 });
    const permission = view?.permissions?.find((item) => String(item.permissionId ?? "") === permissionId);
    if (!permission) return { ok: false, status: "missing", errorCode: "permission_request_not_found" };
    if (["approved", "denied", "resolved"].includes(String(permission.status ?? ""))) {
      return { ok: true, status: String(permission.status), changed: false };
    }
    if (String(permission.status ?? "") === "submitted") {
      return { ok: true, status: "submitted", changed: false };
    }
    const transport = pendingPermissionReplies.get(key);
    if (!transport) {
      return { ok: false, status: "requested", errorCode: "permission_reply_transport_unavailable" };
    }
    const inFlight = inFlightPermissionReplies.get(key);
    if (inFlight) return inFlight;
    const operation = Promise.resolve()
      .then(async () => {
        const delivery = await submitPermissionReply({ ...transport, taskId, sessionId, permissionId, response });
        const accepted = delivery === true || delivery?.accepted === true;
        const errorCode = delivery && typeof delivery === "object" ? String(delivery.errorCode ?? "") : "";
        if (!accepted) {
          const recorded = sessionStore.recordPermissionReplyFailed?.({ taskId, sessionId, permissionId, response });
          return { ok: true, status: recorded?.status ?? "reply_failed", changed: recorded?.changed !== false, ...(errorCode ? { errorCode } : {}) };
        }
        const recorded = sessionStore.recordPermissionSubmitted?.({ taskId, sessionId, permissionId, response });
        return { ok: true, status: recorded?.status ?? "submitted", changed: recorded?.changed !== false };
      })
      .catch((error) => {
        const recorded = sessionStore.recordPermissionReplyFailed?.({ taskId, sessionId, permissionId, response });
        const message = error instanceof Error ? error.message : String(error ?? "");
        const errorCode = message.replace(/[^a-zA-Z0-9_.:-]/g, "_").slice(0, 160);
        return { ok: true, status: recorded?.status ?? "reply_failed", changed: recorded?.changed !== false, ...(errorCode ? { errorCode } : {}) };
      })
      .finally(() => inFlightPermissionReplies.delete(key));
    inFlightPermissionReplies.set(key, operation);
    return operation;
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

    if (providerObserver && String(session.provider ?? "opencode") === "opencode") {
      addStats(result, await inspectObservedWorkerSession({ session, sessions, sampled, status }));
      return result;
    }

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
            // A Provider question belongs to the physical TUI that exposed it.
            // A recovered logical Session gets a new PTY incarnation, so an old
            // observation must never become a writable Task-page prompt there.
            terminalIncarnationId: session.incarnationId,
            question: providerQuestion.questionText,
          },
        );
        const activeDispatch = view.dispatches.findLast((dispatch) => dispatch.status === "delivered");
        const agentId = dispatchAgentId(activeDispatch, session, resolveAgentId);
        const conductorSessionId = resolveWakeupConductorSessionId({ session, dispatch: activeDispatch, sessions, resolveConductorSessionId });
        const wakeup = {
          kind: "attention",
          key: `attention:${session.taskId}:${activeDispatch?.dispatchId ?? "unbound"}:${attentionKey}`,
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
          queueWakeup(wakeup, "attention");
          result.wakeupsQueued += 1;
        }
      }
      return result;
    }
    const dispatches = view.dispatches.filter((dispatch) => ["delivered", "cancellation_requested"].includes(dispatch.status));

    const latestActiveDispatch = dispatches.at(-1);
    for (const dispatch of dispatches) {
      if (dispatch.status === "cancellation_requested") {
        await reconcileCancellationRequested({ session, dispatch, sessions, sampled, status, result });
        continue;
      }
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
        key: `result:${session.taskId}:${dispatch.dispatchId}`,
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
        queueWakeup(wakeup, "result");
        result.wakeupsQueued += 1;
      }
    }

    return result;
  }

  async function inspectObservedWorkerSession({ session, sessions, sampled, status }) {
    const result = emptyResult();
    const view = sessionStore.readSession({
      taskId: session.taskId,
      sessionId: session.id,
      maxChars: 0,
    });
    const activeDispatches = view.dispatches.filter((dispatch) => ["queued", "input_accepted", "delivered", "cancellation_requested"].includes(dispatch.status));

    for (const dispatch of activeDispatches) {
      let fact;
      try {
        fact = await providerObserver.observeDispatch({ session, dispatch });
      } catch (error) {
        fact = {
          kind: "observation_unavailable",
          provider: "opencode",
          reason: error instanceof Error ? error.message : "opencode_observer_failed",
        };
      }
      const kind = String(fact?.kind ?? "not_observed");
      const receipt = fact?.receipt;
      if (dispatch.status === "cancellation_requested") {
        const cancellationResolved = await reconcileCancellationRequested({ session, dispatch, sessions, sampled, status, result, fact });
        if (cancellationResolved) continue;
      }
      if (receipt) {
        sessionStore.markDispatchProviderReceived?.({
          taskId: session.taskId,
          sessionId: session.id,
          dispatchId: dispatch.dispatchId,
          provider: receipt.provider ?? fact?.provider ?? "opencode",
          providerSessionId: receipt.providerSessionId,
          providerMessageId: receipt.providerMessageId,
          dispatchMessageCreatedAt: receipt.dispatchMessageCreatedAt,
          databaseSourceId: receipt.databaseSourceId,
        });
      }

      if (kind === "result" && fact?.result?.answerText) {
        const updated = sessionStore.recordDispatchResult({
          taskId: session.taskId,
          sessionId: session.id,
          dispatchId: dispatch.dispatchId,
          reason: "provider-turn-completed",
          cursor: status.cursor,
          provider: fact.result.provider ?? fact.provider ?? "opencode",
          providerSessionId: fact.result.providerSessionId ?? receipt?.providerSessionId,
          providerMessageId: fact.result.providerMessageId,
          providerStepFinishId: fact.result.providerStepFinishId,
          stepFinishReason: fact.result.stepFinishReason,
          answerText: fact.result.answerText,
          source: fact.result.source ?? "opencode-sqlite-observer",
          completedAt: fact.result.completedAt,
        });
        if (updated.status === "result_available" && updated.changed !== false) {
          result.resultAvailable += 1;
          await sendOrQueueObservedWakeup({
            wakeup: {
              kind: "result",
              key: `result:${session.taskId}:${dispatch.dispatchId}`,
              taskId: session.taskId,
              conductorSessionId: resolveWakeupConductorSessionId({ session, dispatch, sessions, resolveConductorSessionId }),
              workerSessionId: session.id,
              agentId: dispatchAgentId(dispatch, session, resolveAgentId),
              dispatchId: dispatch.dispatchId,
              resultId: updated.resultId,
              resultSource: updated.source,
              providerSessionId: updated.providerSessionId,
              providerMessageId: updated.providerMessageId,
              providerStepFinishId: updated.providerStepFinishId,
              answerText: updated.answerText ?? fact.result.answerText,
              workerState: status.state,
              cursor: status.cursor,
            },
            sessions,
            sampled,
            result,
          });
        }
        continue;
      }

      if (kind === "failed") {
        const failure = fact.failure ?? {};
        const updated = sessionStore.recordDispatchProviderFailure?.({
          taskId: session.taskId,
          sessionId: session.id,
          dispatchId: dispatch.dispatchId,
          reason: failure.reason ?? "provider_terminal_failure",
          message: failure.message ?? "OpenCode reported a terminal failure for this exact dispatch.",
          provider: failure.provider ?? fact.provider ?? receipt?.provider ?? "opencode",
          providerSessionId: failure.providerSessionId ?? receipt?.providerSessionId,
          providerMessageId: failure.providerMessageId ?? receipt?.providerMessageId,
          providerStepFinishId: failure.providerStepFinishId,
          stepFinishReason: failure.stepFinishReason,
          state: status.state === "exited" ? "exited" : "blocked",
        });
        if (updated?.changed) {
          result.providerFailures += 1;
          await sendOrQueueObservedWakeup({
            wakeup: {
              kind: "failure",
              key: `failure:${session.taskId}:${dispatch.dispatchId}:${failure.providerStepFinishId ?? failure.providerMessageId ?? "terminal"}`,
              taskId: session.taskId,
              conductorSessionId: resolveWakeupConductorSessionId({ session, dispatch, sessions, resolveConductorSessionId }),
              workerSessionId: session.id,
              agentId: dispatchAgentId(dispatch, session, resolveAgentId),
              dispatchId: dispatch.dispatchId,
              workerState: status.state,
              cursor: status.cursor,
              reason: failure.reason ?? "provider_terminal_failure",
              answerText: failure.message,
            },
            sessions,
            sampled,
            result,
          });
        }
        continue;
      }

      if (kind === "attention") {
        const attention = fact.attention ?? {};
        const attentionKey = workerAttentionKey(session, attention, status);
        if (!recordedWorkerAttentionKeys.has(attentionKey)) {
          sessionStore.recordState(
            { taskId: session.taskId, sessionId: session.id },
            "waiting_input",
            workerQuestionSummary(attention),
            {
              source: attention.source ?? "opencode-sqlite-observer",
              provider: attention.provider ?? fact.provider ?? "opencode",
              providerSessionId: attention.providerSessionId ?? receipt?.providerSessionId,
              providerMessageId: attention.providerMessageId ?? receipt?.providerMessageId,
              providerQuestionPartId: attention.providerQuestionPartId,
              terminalIncarnationId: session.incarnationId,
              question: attention.questionText,
            },
          );
          recordedWorkerAttentionKeys.add(attentionKey);
          await sendOrQueueObservedWakeup({
            wakeup: {
              kind: "attention",
              key: `attention:${session.taskId}:${dispatch.dispatchId}:${attentionKey}`,
              taskId: session.taskId,
              conductorSessionId: resolveWakeupConductorSessionId({ session, dispatch, sessions, resolveConductorSessionId }),
              workerSessionId: session.id,
              agentId: dispatchAgentId(dispatch, session, resolveAgentId),
              dispatchId: dispatch.dispatchId,
              workerState: "waiting_input",
              cursor: status.cursor,
              answerText: attention.questionText,
            },
            sessions,
            sampled,
            result,
          });
        }
        continue;
      }

      if (kind === "observation_unavailable") {
        sessionStore.recordDispatchObservationUnavailable?.({
          taskId: session.taskId,
          sessionId: session.id,
          dispatchId: dispatch.dispatchId,
          reason: fact?.reason,
        });
        // A scanner outage is not a Provider failure and does not establish
        // that OpenCode missed the assignment.  Terminal lifecycle alone is
        // insufficient while the semantic observer is unavailable: preserve
        // the existing receipt state and let a recovered observer decide.
        continue;
      }

      if (kind === "not_observed" || kind === "observation_unavailable") {
        if (!terminalExited(status)) continue;
        const updated = sessionStore.recordDispatchDeliveryFailure?.({
          taskId: session.taskId,
          sessionId: session.id,
          dispatchId: dispatch.dispatchId,
          reason: "terminal_exit_before_receipt",
          message: "Terminal Runtime ended before OpenCode recorded the exact dispatch marker.",
          terminalState: status.state,
        });
        if (updated?.changed) {
          result.deliveryFailures += 1;
          await sendOrQueueObservedWakeup({
            wakeup: {
              kind: "delivery_failure",
              key: `delivery-failure:${session.taskId}:${dispatch.dispatchId}:${status.cursor}`,
              taskId: session.taskId,
              conductorSessionId: resolveWakeupConductorSessionId({ session, dispatch, sessions, resolveConductorSessionId }),
              workerSessionId: session.id,
              agentId: dispatchAgentId(dispatch, session, resolveAgentId),
              dispatchId: dispatch.dispatchId,
              workerState: "delivery_failed",
              cursor: status.cursor,
              reason: "terminal_exit_before_receipt",
              answerText: "Terminal Runtime ended before OpenCode persisted the exact dispatch receipt.",
            },
            sessions,
            sampled,
            result,
          });
        }
      }
    }
    return result;
  }

  async function sendOrQueueObservedWakeup({ wakeup, sessions, sampled, result }) {
    if (!wakeup.conductorSessionId) return;
    if (await trySendWakeup(wakeup, sessions, sampled)) {
      result.wakeupsSent += 1;
      return;
    }
    queueWakeup(wakeup, wakeup.kind);
    result.wakeupsQueued += 1;
  }

  async function reconcileCancellationRequested({ session, dispatch, sessions, sampled, status, result, fact }) {
    // A scoped native interrupt deliberately keeps the terminal alive. The
    // Provider's terminal-failure fact is therefore as authoritative as an
    // exit event; only a user force-stop kills the Session itself.
    const providerConfirmed = String(fact?.kind ?? "") === "failed";
    if (!providerConfirmed && !terminalExited(status)) return false;
    const confirmation = providerConfirmed ? "provider_interrupted" : "terminal_exit";
    const updated = sessionStore.markDispatchCancelled?.({
      taskId: session.taskId,
      sessionId: session.id,
      dispatchId: dispatch.dispatchId,
      reason: dispatch.cancellationReason ?? "conductor_cancelled",
      confirmation,
      message: providerConfirmed
        ? `OpenCode confirmed Dispatch ${dispatch.dispatchId} ended after the Conductor cancellation request.`
        : `Terminal Runtime confirmed Dispatch ${dispatch.dispatchId} stopped after the Conductor cancellation request.`,
    });
    if (!updated?.changed) return false;
    await sendOrQueueObservedWakeup({
      wakeup: {
        kind: "cancellation",
        key: `cancellation:${session.taskId}:${dispatch.dispatchId}:${status.cursor}`,
        taskId: session.taskId,
        conductorSessionId: resolveWakeupConductorSessionId({ session, dispatch, sessions, resolveConductorSessionId }),
        workerSessionId: session.id,
        agentId: dispatchAgentId(dispatch, session, resolveAgentId),
        dispatchId: dispatch.dispatchId,
        workerState: "cancelled",
        cursor: status.cursor,
        reason: dispatch.cancellationReason ?? "conductor_cancelled",
        answerText: providerConfirmed
          ? "OpenCode confirmed the worker turn ended after the cancellation request."
          : "Terminal Runtime confirmed the worker Session stopped after the cancellation request.",
      },
      sessions,
      sampled,
      result,
    });
    return true;
  }

  async function reconcileDispatchProviderFacts({ session, sessions, sampled, view }) {
    const result = emptyResult();
    const dispatches = view.dispatches.filter((dispatch) => ["queued", "input_accepted", "delivered", "cancellation_requested"].includes(dispatch.status));
    // A session-level OpenCode hook has no dispatch marker. The legacy
    // compatibility path may attribute it only to the newest outstanding
    // dispatch in this one native Session; exact per-dispatch facts belong to
    // the read-only Provider Observer path above.
    const latestActiveDispatch = dispatches.at(-1);
    const hookError = providerHookErrors.get(String(session.id));

    for (const dispatch of dispatches) {
      if (dispatch.status === "cancellation_requested") {
        await reconcileCancellationRequested({ session, dispatch, sessions, sampled, status: sampleSession(session, sampled), result });
        continue;
      }
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
          databaseSourceId: fact.receipt?.databaseSourceId,
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
        key: `failure:${session.taskId}:${dispatch.dispatchId}:${failure.key}`,
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
        queueWakeup(wakeup, "failure");
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
    const providerSessionId = String(view?.providerBinding?.providerSessionId ?? "").trim() || undefined;
    await reconcileConductorWakeupReceipts({ session, afterMessageCreatedAt });
    const providerQuestion = await readConductorQuestion({
      session,
      status,
      afterMessageCreatedAt,
      providerSessionId,
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
          terminalIncarnationId: session.incarnationId,
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
      providerSessionId,
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

  function hydratePendingWakeups(sessions = typeof ptyManager.list === "function" ? ptyManager.list() : []) {
    if (typeof sessionStore.listPendingConductorWakeups !== "function") return;
    const seen = new Set();
    const knownTargets = typeof listConductorWakeupTargets === "function" ? listConductorWakeupTargets() : [];
    const candidates = [
      ...sessions
        .filter((session) => isConductorSessionId(session?.id) && session?.taskId)
        .map((session) => ({ taskId: session.taskId, sessionId: session.id })),
      ...knownTargets,
    ];
    for (const target of candidates) {
      const taskId = String(target?.taskId ?? "");
      const sessionId = String(target?.sessionId ?? "");
      if (!taskId || !sessionId || seen.has(`${taskId}\0${sessionId}`)) continue;
      seen.add(`${taskId}\0${sessionId}`);
      for (const record of sessionStore.listPendingConductorWakeups({ taskId, sessionId })) {
        const key = String(record.wakeupKey ?? "");
        if (!key || pendingWakeups.has(key)) continue;
        pendingWakeups.set(key, wakeupFromRecord(record));
      }
    }
  }

  function queueWakeup(wakeup, label = wakeup.kind) {
    pendingWakeups.set(wakeup.key, wakeup);
    persistWakeup(wakeup, "queued", label);
  }

  function persistWakeup(wakeup, status, label = wakeup.kind) {
    return sessionStore.recordConductorWakeup?.({
      ...wakeup,
      wakeupKey: wakeup.key,
      taskId: wakeup.taskId,
      sessionId: wakeup.conductorSessionId,
      status,
      summary: `Conductor wakeup ${status} for ${roleNameFromSessionId(wakeup.workerSessionId)} ${label || "result"}`,
    });
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
    let conductor = sessions.find((session) => session.id === wakeup.conductorSessionId) ?? ptyManager.get?.(wakeup.conductorSessionId);
    if ((!conductor || conductor.status !== "running") && typeof ensureConductorWakeupTarget === "function") {
      try {
        conductor = await ensureConductorWakeupTarget({
          taskId: wakeup.taskId,
          sessionId: wakeup.conductorSessionId,
          wakeupKey: wakeup.key,
        });
      } catch (error) {
        sessionStore.recordTaskEvent?.({
          taskId: wakeup.taskId,
          sessionId: wakeup.conductorSessionId,
          type: "conductor.wakeup.target_unavailable",
          summary: "Runtime could not restore a live Conductor terminal for a durable wakeup.",
          data: { wakeupKey: wakeup.key, reason: error instanceof Error ? error.message : "conductor_target_unavailable" },
        });
        return false;
      }
    }
    if (!conductor || conductor.status !== "running") return false;
    const conductorStatus = sampleSession(conductor, sampled);
    if (!canWakeConductor(conductor, conductorStatus)) return false;

    // Persist the Coordinator command before touching the PTY.  The status
    // transition is monotonic, so a retry never turns a previous `sent` wakeup
    // back into a queue item after a process restart.
    persistWakeup(wakeup, "attempting", wakeup.kind);

    const message = wakeup.kind === "attention"
      ? formatAttentionWakeupMessage(wakeup)
      : wakeup.kind === "user_message"
        ? formatUserMessageWakeup(wakeup)
        : wakeup.kind === "cancellation"
          ? formatCancellationWakeupMessage(wakeup)
        : wakeup.kind === "failure" || wakeup.kind === "delivery_failure"
        ? formatFailureWakeupMessage(wakeup)
        : formatWakeupMessage(wakeup);
    const markedMessage = [
      `[Agent Workspace] Conductor Input ID ${wakeup.key}`,
      "",
      message,
    ].join("\n");
    let write;
    try {
      write = typeof enqueueConductorInteractiveSubmission === "function"
        ? await enqueueConductorInteractiveSubmission({
          taskId: wakeup.taskId,
          sessionId: wakeup.conductorSessionId,
          expectedIncarnationId: conductor.incarnationId,
          source: "conductor_wakeup",
          text: markedMessage,
          idempotencyKey: `wakeup:${wakeup.key}`,
        })
        : typeof enqueueConductorInput === "function"
          ? await enqueueConductorInput({
            taskId: wakeup.taskId,
            sessionId: wakeup.conductorSessionId,
            expectedIncarnationId: conductor.incarnationId,
            source: "conductor_wakeup",
            payload: formatWakeupInput(markedMessage),
            idempotencyKey: `wakeup:${wakeup.key}`,
          })
          : ptyManager.write(wakeup.conductorSessionId, formatWakeupInput(markedMessage));
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
    persistWakeup(wakeup, "sent", wakeup.kind);
    await acceptConductorWakeup(wakeup);
    return true;
  }

  async function reconcileConductorWakeupReceipts({ session, afterMessageCreatedAt }) {
    if (typeof providerObserver?.observeConductorInput !== "function") return;
    if (typeof sessionStore.listUnconfirmedConductorWakeups !== "function") return;
    const wakeups = sessionStore.listUnconfirmedConductorWakeups({ taskId: session.taskId, sessionId: session.id });
    for (const record of wakeups) {
      const inputId = String(record.wakeupKey ?? "");
      if (!inputId) continue;
      let fact;
      try {
        fact = await providerObserver.observeConductorInput({ session, inputId, afterMessageCreatedAt });
      } catch {
        // An unavailable observer has no authority to decide whether a write
        // reached OpenCode. Leave the durable command untouched for a later
        // read-only observation.
        continue;
      }
      if (fact?.receipt) {
        const wakeup = wakeupFromRecord(record);
        sessionStore.markConductorWakeupObserved?.({
          ...wakeup,
          taskId: session.taskId,
          sessionId: session.id,
          wakeupKey: inputId,
          provider: fact.receipt.provider ?? fact.provider ?? "opencode",
          providerSessionId: fact.receipt.providerSessionId,
          providerMessageId: fact.receipt.providerMessageId,
          dispatchMessageCreatedAt: fact.receipt.dispatchMessageCreatedAt,
          databaseSourceId: fact.receipt.databaseSourceId,
          summary: `OpenCode recorded Conductor wakeup ${inputId}.`,
        });
        // If Electron stopped between the Terminal Runtime accepting a wakeup
        // and the Task lifecycle transition, the exact Provider receipt is the
        // durable proof needed to replay that idempotent transition.  Do not
        // resend bytes; reopen only the next Conductor decision epoch.
        await acceptConductorWakeup(wakeup);
        continue;
      }
      // We crashed after recording an intent but before the Terminal Runtime
      // confirmed the write. A read-only proof of absence lets the Coordinator
      // retry the same idempotent input; an observer outage never does.
      if (fact?.kind === "not_observed" && record.status === "attempting") {
        const wakeup = wakeupFromRecord(record);
        persistWakeup(wakeup, "queued", wakeup.kind);
        pendingWakeups.set(wakeup.key, wakeup);
      }
    }
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

  async function readConductorMessage({ session, status, afterMessageCreatedAt, providerSessionId }) {
    if (typeof conductorMessageReader !== "function") return undefined;
    return conductorMessageReader({ session, status, afterMessageCreatedAt, providerSessionId });
  }

  async function readConductorQuestion({ session, status, afterMessageCreatedAt, providerSessionId }) {
    if (typeof conductorQuestionReader !== "function") return undefined;
    return conductorQuestionReader({ session, status, afterMessageCreatedAt, providerSessionId });
  }

  async function readWorkerQuestion({ session, status, afterMessageCreatedAt }) {
    if (typeof workerQuestionReader !== "function") return undefined;
    return workerQuestionReader({ session, status, afterMessageCreatedAt });
  }

  async function acceptConductorWakeup(wakeup) {
    if (typeof onConductorWakeupAccepted !== "function") return;
    try {
      await onConductorWakeupAccepted({
        taskId: wakeup.taskId,
        sessionId: wakeup.conductorSessionId,
        wakeupKey: wakeup.key,
        kind: wakeup.kind,
        dispatchId: wakeup.dispatchId,
        resultId: wakeup.resultId,
      });
    } catch (error) {
      // Provider receipt is still true even if a user archived/achieved the
      // Task before this recovery callback.  Retrying the same terminal input
      // would duplicate a completed Conductor turn, so preserve an auditable
      // Runtime fact rather than converting it into a retry instruction.
      sessionStore.recordTaskEvent?.({
        taskId: wakeup.taskId,
        sessionId: wakeup.conductorSessionId,
        type: "conductor.wakeup.lifecycle_unavailable",
        summary: "Conductor wakeup was accepted, but the Task lifecycle could not open a new decision epoch.",
        data: {
          wakeupKey: wakeup.key,
          reason: error instanceof Error ? error.message : String(error ?? "unknown"),
        },
      });
    }
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

  return { start, stop, tick, handleProviderHookEvent, respondPermission };
}

function permissionReplyKey(taskId, sessionId, permissionId) {
  return `${String(taskId)}\u0000${String(sessionId)}\u0000${String(permissionId)}`;
}

function providerPermissionRequestId(payload = {}) {
  return String(payload.requestID ?? payload.permissionID ?? payload.id ?? "").trim().slice(0, 200);
}

function providerPermissionResponse(payload = {}) {
  const value = String(payload.response ?? payload.reply ?? "").trim();
  const normalized = {
    once: "once",
    allow_once: "once",
    always: "always",
    allow_always: "always",
    reject: "reject",
    denied: "reject",
  }[value];
  return normalized;
}

function normalizePermissionResponse(value) {
  const response = String(value ?? "").trim();
  return new Set(["once", "always", "reject"]).has(response) ? response : undefined;
}

function providerPermissionPatterns(payload = {}) {
  const values = Array.isArray(payload.patterns) ? payload.patterns : [];
  return values.map((value) => String(value ?? "").trim()).filter(Boolean).slice(0, 24);
}

function providerPermissionSummary(payload = {}) {
  const permission = String(payload.permission ?? payload.action ?? "操作").trim();
  const patterns = providerPermissionPatterns(payload);
  const metadata = payload.metadata && typeof payload.metadata === "object" ? payload.metadata : {};
  const detail = String(payload.message ?? metadata.description ?? metadata.command ?? "").trim();
  return [
    `OpenCode 请求授权：${permission || "操作"}${patterns.length ? ` (${patterns.join(", ")})` : ""}`,
    detail,
  ].filter(Boolean).join("\n");
}

async function postOpenCodePermissionReply({ endpoint, token, requestId, response }) {
  const url = new URL(String(endpoint));
  if (url.protocol !== "http:" || !["127.0.0.1", "::1", "[::1]"].includes(url.hostname)) {
    throw new Error("permission_reply_endpoint_not_loopback");
  }
  const result = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-agent-workspace-permission-token": String(token),
    },
    body: JSON.stringify({ requestID: String(requestId), reply: String(response) }),
  });
  if (result.status >= 200 && result.status < 300) return { accepted: true };
  let errorCode = `permission_reply_http_${result.status}`;
  try {
    const body = await result.json();
    const providerCode = String(body?.error ?? "").trim().replace(/[^a-zA-Z0-9_.:-]/g, "_").slice(0, 120);
    if (providerCode) errorCode = `${errorCode}:${providerCode}`;
  } catch {
    // Permission endpoints are allowed to return an empty error body.
  }
  return { accepted: false, errorCode };
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
    "Conductor: inspect task state. Dispatch a correction if the worker can proceed autonomously; otherwise the Runtime exposes a Task-page native-question card that writes the user's answer to this exact Session. Do not ask the user to retype it into a terminal.",
  ].join("\n");
}

function formatCancellationWakeupMessage(wakeup) {
  const agentLabel = agentLabelForWakeup(wakeup);
  return [
    `Runtime wakeup: ${agentLabel} cancellation confirmed`,
    "",
    `Task: ${wakeup.taskId}`,
    `Agent card: ${agentLabel}`,
    `Dispatch ID: ${wakeup.dispatchId}`,
    `Reason: ${wakeup.reason ?? "conductor_cancelled"}`,
    "",
    "Terminal Runtime confirmed that this worker Session stopped after your cancellation request.",
    "Conductor: read_task_state before deciding whether this card needs new work. Do not assume any partial terminal output is a usable result.",
  ].join("\n");
}

function formatUserMessageWakeup(wakeup) {
  return [
    "User follow-up for the current Task:",
    "",
    String(wakeup.messageText ?? "").trim(),
    "",
    "Read the durable Task state and decide the next action. Do not treat this as a fixed route.",
  ].join("\n");
}

function formatFailureWakeupMessage(wakeup) {
  const agentLabel = agentLabelForWakeup(wakeup);
  const isDeliveryFailure = wakeup.kind === "delivery_failure" || wakeup.reason === "terminal_exit_before_receipt";
  return [
    `Runtime wakeup: ${agentLabel} ${isDeliveryFailure ? "delivery failure" : "Provider failure"}`,
    "",
    `Task: ${wakeup.taskId}`,
    `Agent card: ${agentLabel}`,
    `Dispatch ID: ${wakeup.dispatchId ?? "(unknown)"}`,
    `Failure fact: ${wakeup.reason ?? "provider_terminal_failure"}`,
    "",
    isDeliveryFailure ? "Terminal Runtime fact:" : "Provider-reported failure:",
    String(wakeup.answerText ?? (isDeliveryFailure ? "Terminal Runtime ended before OpenCode recorded the dispatch." : "OpenCode reported a terminal failure.")),
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

function wakeupFromRecord(record = {}) {
  return {
    key: String(record.wakeupKey ?? record.key ?? ""),
    kind: record.kind ?? "result",
    taskId: record.taskId,
    conductorSessionId: record.sessionId ?? record.conductorSessionId,
    workerSessionId: record.workerSessionId,
    agentId: record.agentId,
    dispatchId: record.dispatchId,
    resultId: record.resultId,
    workerState: record.workerState,
    cursor: record.cursor,
    reason: record.reason,
    answerText: record.answerText,
    messageText: record.messageText,
    userMessageId: record.userMessageId,
  };
}

function emptyResult() {
  return {
    sampled: 0,
    resultAvailable: 0,
    wakeupsSent: 0,
    wakeupsQueued: 0,
    conductorMessagesRecorded: 0,
    providerFailures: 0,
    deliveryFailures: 0,
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
  target.deliveryFailures += source.deliveryFailures ?? 0;
  return target;
}

function terminalExited(status) {
  // The in-process PTY manager calls its terminal lifecycle state `stopped`,
  // while the daemon/provider adapters may report `exited`.  Both are the
  // same Runtime fact for a scoped cancellation: the current dispatch has
  // ended and the logical OpenCode Session is free for a later dispatch.
  return ["stopped", "exited", "start_failed"].includes(String(status?.state ?? ""));
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
  // A workspace Session id may be restarted with a new Orca generation.
  // Provider queries must be fenced at the most recent native start, not at
  // the first historical process that happened to use this logical id.
  const started = events.findLast((event) => event.type === "session.started");
  return started?.createdAt;
}

function conductorMessageKey(session, providerMessage) {
  const providerMessageId = providerMessage.providerMessageId ?? providerMessage.messageId;
  if (providerMessageId) return `${session.taskId}:${session.id}:${providerMessageId}`;
  return `${session.taskId}:${session.id}:${providerMessage.completedAt ?? ""}:${String(providerMessage.answerText ?? "").slice(0, 200)}`;
}

function conductorSessionKey(session) {
  // PTY byte cursors are local to a physical terminal incarnation. A
  // recovered Conductor keeps the same logical Workspace Session id but starts
  // a new counter at zero, so an earlier incarnation's larger cursor must not
  // suppress the new Provider turn from the Timeline.
  const incarnation = String(session.incarnationId ?? session.generation ?? "unbound");
  return `${session.taskId}:${session.id}:${incarnation}`;
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

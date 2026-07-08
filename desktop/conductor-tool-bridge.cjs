const http = require("node:http");
const crypto = require("node:crypto");

function createConductorToolBridge({
  sessionStore,
  ptyManager,
  startWorkerSession,
  validateDispatch,
  confirmWorkerAssignmentDelivery,
  deliveryTimeoutMs = 15_000,
  deliveryPollIntervalMs = 250,
}) {
  async function callSession(input) {
    const taskId = String(input?.taskId ?? "");
    const toSessionId = String(input?.toSessionId ?? "");
    const assignment = String(input?.assignment ?? "");
    const validation = validateDispatch?.({ taskId, toSessionId }) ?? { ok: true };
    if (!validation.ok) {
      sessionStore.recordDispatchFailure?.({
        taskId,
        toSessionId,
        assignment,
        reason: validation.reason,
        message: validation.reason ?? "Dispatch route validation failed.",
      });
      return callSessionFailure({
        dispatchId: "",
        taskId,
        toSessionId,
        errorCode: "route_validation_failed",
        message: validation.reason ?? "Dispatch route validation failed.",
        targetSessionState: "unknown",
      });
    }

    const conductorSessionId = resolveConductorSessionIdForDispatch({ taskId, toSessionId, ptyManager });
    const dispatch = sessionStore.recordDispatch({
      taskId,
      toSessionId,
      conductorSessionId,
      assignment,
      contextRefs: Array.isArray(input?.contextRefs) ? input.contextRefs.map(String) : [],
      expectedOutput: input?.expectedOutput ? String(input.expectedOutput) : "",
      priority: input?.priority === "high" || input?.priority === "low" ? input.priority : "normal",
    });

    let target = ptyManager.get?.(dispatch.toSessionId);
    if (!target || target.status !== "running") {
      try {
        target = await startWorkerSession?.({
          taskId: dispatch.taskId,
          sessionId: dispatch.toSessionId,
        });
      } catch (error) {
        return failDispatch(dispatch, {
          errorCode: "target_session_start_failed",
          message: "Target session could not be started. Conductor may correct the target/config or ask the user.",
          targetSessionState: "not_started",
          error,
        });
      }
    }

    if (!target || target.status !== "running") {
      return failDispatch(dispatch, {
        errorCode: "target_session_start_failed",
        message: "Target session could not be started. Conductor may correct the target/config or ask the user.",
        targetSessionState: "not_started",
      });
    }

    if (await waitForWorkerAssignmentDelivery(dispatch, { force: Boolean(input?.force) })) {
      return callSessionDelivered(dispatch);
    }

    const targetState = workerSessionRuntimeState(dispatch);
    return failDispatch(dispatch, {
      errorCode: "target_session_delivery_timeout",
      message:
        "Target session started but did not become ready for assignment delivery before timeout. Conductor may retry later or ask the user.",
      targetSessionState: targetState.state,
    });
  }

  async function readSession(input) {
    return sessionStore.readSession({
      taskId: String(input?.taskId ?? ""),
      sessionId: String(input?.sessionId ?? ""),
      sinceCursor: Number(input?.sinceCursor ?? 0),
      maxChars: Number(input?.maxChars ?? 12_000),
    });
  }

  async function readTaskState(input) {
    if (typeof sessionStore.readTaskState === "function") {
      return sessionStore.readTaskState({
        taskId: String(input?.taskId ?? ""),
        sinceCursor: Number(input?.sinceCursor ?? 0),
      });
    }
    return {
      taskId: String(input?.taskId ?? ""),
      cursor: 0,
      sessions: [],
      dispatches: [],
      results: [],
      pendingDecisions: [],
    };
  }

  async function claimTaskCompletion(input) {
    const taskId = String(input?.taskId ?? "");
    const sessionId = String(input?.sessionId ?? resolveConductorSessionIdForTask({ taskId, ptyManager }) ?? "");
    const message = String(input?.message ?? "");
    if (typeof sessionStore.recordTaskCompletionClaim !== "function") {
      return {
        ok: false,
        taskId,
        sessionId,
        status: "failed",
        eventType: "task.completion_claim",
        turnPolicy: "recover_or_stop",
        errorCode: "completion_claim_not_supported",
        message: "Session Store does not support structured task completion claims.",
      };
    }

    const claimInput = {
      taskId,
      sessionId,
      message,
      source: "conductor",
    };
    if (input?.summary) claimInput.summary = String(input.summary);
    const event = sessionStore.recordTaskCompletionClaim(claimInput);
    return {
      ok: true,
      taskId,
      sessionId,
      status: "completion_claim_recorded",
      eventType: "task.completion_claim",
      event,
      turnPolicy: "stop_for_review_gate",
      nextAllowedAction: "wait_for_review_gate",
      message:
        "Structured completion claim recorded. Stop this Conductor turn and let the Review gate verify the task.",
    };
  }

  return {
    callSession,
    readTaskState,
    readSession,
    claimTaskCompletion,
  };

  async function deliverWorkerAssignment(dispatch, { force = false, alreadyWrote = false } = {}) {
    const runtimeState = workerSessionRuntimeState(dispatch);
    if (!force && !isWorkerSessionDeliverable(runtimeState, dispatch)) {
      return { delivered: false, wrote: alreadyWrote, targetSessionState: runtimeState.state };
    }
    const session = ptyManager.get?.(dispatch.toSessionId);
    if (!session || session.status !== "running") {
      return { delivered: false, wrote: alreadyWrote, targetSessionState: runtimeState.state };
    }
    if (!workerSessionCanReceiveInput(session)) {
      return { delivered: false, wrote: alreadyWrote, targetSessionState: runtimeState.state };
    }

    let wrote = alreadyWrote;
    if (!wrote) {
      ptyManager.write(dispatch.toSessionId, formatInteractivePtyInput(formatWorkerAssignment(dispatch)));
      wrote = true;
    }

    if (typeof confirmWorkerAssignmentDelivery === "function") {
      const confirmed = await confirmWorkerAssignmentDelivery({ session, dispatch });
      if (!confirmed) {
        return { delivered: false, wrote, targetSessionState: runtimeState.state };
      }
    }

    sessionStore.markDispatchDelivered?.({
      taskId: dispatch.taskId,
      sessionId: dispatch.toSessionId,
      dispatchId: dispatch.dispatchId,
    });
    return { delivered: true, wrote, targetSessionState: "delivered_pending" };
  }

  function workerSessionRuntimeState(dispatch) {
    if (typeof sessionStore.readSession === "function") {
      try {
        const view = sessionStore.readSession({
          taskId: dispatch.taskId,
          sessionId: dispatch.toSessionId,
          maxChars: 0,
        });
        if (view?.state) {
          return {
            state: normalizeRuntimeState(view.state),
            activeDispatchId: view.activeDispatchId,
            assignmentReadinessHint: view.assignmentReadinessHint,
            lastResultId: view.lastResultId,
            resultCount: view.resultCount,
            attentionHints: Array.isArray(view.attentionHints) ? view.attentionHints : [],
            source: "session-store",
          };
        }
      } catch {
        // Fall through to process lifecycle compatibility below.
      }
    }
    const session = ptyManager.get?.(dispatch.toSessionId);
    if (!session) return { state: "not_started", source: "pty" };
    if (session.status === "running") return { state: "ready", source: "pty" };
    if (session.status === "stopping") return { state: "stopping", source: "pty" };
    return { state: "exited", source: "pty" };
  }

  function workerSessionCanReceiveInput(session) {
    if (!isOpencodePtySession(session)) return true;
    if (typeof ptyManager.read !== "function") return true;
    const snapshot = ptyManager.read(session.id, 0) ?? session;
    const transcript = Array.isArray(snapshot?.transcript) ? snapshot.transcript.join("") : "";
    return opencodeTranscriptCanReceiveInput(transcript);
  }

  async function waitForWorkerAssignmentDelivery(dispatch, options = {}) {
    const deadline = Date.now() + Math.max(0, Number(deliveryTimeoutMs));
    let wrote = false;
    do {
      const result = await deliverWorkerAssignment(dispatch, { alreadyWrote: wrote, force: options.force });
      wrote = result.wrote;
      if (result.delivered) return true;
      await delay(Math.max(1, Number(deliveryPollIntervalMs)));
    } while (Date.now() < deadline);
    return (await deliverWorkerAssignment(dispatch, { alreadyWrote: wrote, force: options.force })).delivered;
  }

  function failDispatch(dispatch, failure) {
    sessionStore.markDispatchFailed?.({
      taskId: dispatch.taskId,
      sessionId: dispatch.toSessionId,
      dispatchId: dispatch.dispatchId,
      reason: failure.errorCode,
      message: failure.message,
      error: failure.error instanceof Error ? failure.error.message : undefined,
    });
    return callSessionFailure({
      dispatchId: dispatch.dispatchId,
      taskId: dispatch.taskId,
      toSessionId: dispatch.toSessionId,
      errorCode: failure.errorCode,
      message: failure.message,
      targetSessionState: failure.targetSessionState,
    });
  }
}

async function startConductorToolBridgeHttpServer({ bridge, token = crypto.randomUUID(), host = "127.0.0.1" }) {
  const toolHandlers = {
    call_session: bridge.callSession,
    read_task_state: bridge.readTaskState,
    read_session: bridge.readSession,
    claim_task_completion: bridge.claimTaskCompletion,
  };

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? host}`);
    const match = url.pathname.match(/^\/tools\/([^/]+)$/);
    if (request.method !== "POST" || !match) {
      writeJson(response, 404, { error: "not-found" });
      return;
    }

    if (request.headers.authorization !== `Bearer ${token}`) {
      writeJson(response, 401, { error: "unauthorized" });
      return;
    }

    const toolName = decodeURIComponent(match[1]);
    const handler = toolHandlers[toolName];
    if (!handler) {
      writeJson(response, 404, { error: "unknown-tool", toolName });
      return;
    }

    try {
      const body = await readJsonBody(request);
      const result = await handler(body);
      writeJson(response, 200, result);
    } catch (error) {
      writeJson(response, 500, {
        error: error instanceof Error ? error.message : "tool-call-failed",
      });
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Unable to determine conductor tool bridge address.");
  }

  return {
    server,
    token,
    url: `http://${host}:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      if (!body.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

function writeJson(response, statusCode, payload) {
  response.writeHead(statusCode, { "content-type": "application/json" });
  response.end(JSON.stringify(payload));
}

function resolveConductorSessionIdForDispatch({ taskId, toSessionId, ptyManager }) {
  const sessions = typeof ptyManager?.list === "function" ? ptyManager.list() : [];
  const candidates = sessions.filter(
    (session) =>
      String(session?.taskId ?? "") === String(taskId) &&
      String(session?.id ?? "") !== String(toSessionId) &&
      isConductorSessionId(session?.id),
  );
  const running = candidates.find((session) => session.status === "running");
  return String((running ?? candidates[0])?.id ?? "");
}

function resolveConductorSessionIdForTask({ taskId, ptyManager }) {
  const sessions = typeof ptyManager?.list === "function" ? ptyManager.list() : [];
  const candidates = sessions.filter(
    (session) => String(session?.taskId ?? "") === String(taskId) && isConductorSessionId(session?.id),
  );
  const running = candidates.find((session) => session.status === "running");
  return String((running ?? candidates[0])?.id ?? "");
}

function isConductorSessionId(sessionId) {
  return /(^|[-:])conductor$/i.test(String(sessionId ?? ""));
}

function formatWorkerAssignment(dispatch) {
  return [
    `[Agent Workspace] Dispatch ID ${dispatch.dispatchId}`,
    "",
    dispatch.assignment,
    "",
    dispatch.expectedOutput ? `Expected output: ${dispatch.expectedOutput}` : "",
    dispatch.contextRefs.length > 0 ? `Context refs: ${dispatch.contextRefs.join(", ")}` : "",
    "",
    "When complete, answer in this session with:",
    `- Dispatch ID: ${dispatch.dispatchId}`,
    "- artifact paths you created or changed",
    "- concise result summary",
    "- blockers or follow-up needed, if any",
    'Do not answer only "done" or "complete".',
    "",
  ]
    .filter(Boolean)
    .join("\n")
    .concat("\n");
}

function formatInteractivePtyInput(text) {
  const body = String(text ?? "").trimEnd();
  return `\x1b[200~${body}\x1b[201~\r`;
}

function callSessionDelivered(dispatch) {
  return {
    ok: true,
    dispatchId: dispatch.dispatchId,
    taskId: dispatch.taskId,
    toSessionId: dispatch.toSessionId,
    status: "delivered",
    deliveryState: "delivered",
    targetSessionState: "delivered_pending",
    resultState: "pending",
    async: true,
    turnPolicy: "stop_after_dispatch",
    turnBoundary: "dispatch",
    shouldEndTurn: true,
    cannotReadResultUntil: "provider_result_available",
    nextAllowedAction: "wait_for_runtime_wakeup",
    message:
      "Assignment delivered to target session. End this Conductor turn now and wait for a runtime wakeup before reading the result.",
  };
}

function isWorkerSessionDeliverable(runtimeState, dispatch) {
  const state = typeof runtimeState === "string" ? runtimeState : runtimeState?.state;
  if (state === "queued") return runtimeState?.activeDispatchId === dispatch?.dispatchId;
  if (state === "delivery_failed") {
    const hasResultContext =
      Number(runtimeState?.resultCount ?? 0) > 0 ||
      Boolean(runtimeState?.lastResultId) ||
      (runtimeState?.attentionHints ?? []).includes("result_available");
    return runtimeState?.assignmentReadinessHint === "ready" && hasResultContext;
  }
  return state === "ready" || state === "result_available" || state === "waiting_conductor";
}

function isOpencodePtySession(session) {
  const provider = String(session?.provider ?? "");
  const command = String(session?.command ?? "");
  return provider === "opencode" || /(^|\/)opencode$/i.test(command);
}

function opencodeTranscriptCanReceiveInput(transcript) {
  const text = String(transcript ?? "");
  if (/esc\s+interrupt/i.test(text)) return false;
  return text.includes("Ask anything") || text.includes("tab agents") || text.includes("ctrl+p commands");
}

function normalizeRuntimeState(state) {
  const value = String(state ?? "").trim();
  if (value === "idle") return "ready";
  if (value === "waiting") return "waiting_input";
  if (RUNTIME_SESSION_STATES.has(value)) return value;
  return "ready";
}

const RUNTIME_SESSION_STATES = new Set([
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
  "stopping",
  "stopped",
  "exited",
  "start_failed",
]);

function callSessionFailure({ dispatchId, taskId, toSessionId, errorCode, message, targetSessionState }) {
  return {
    ok: false,
    dispatchId,
    taskId,
    toSessionId,
    status: "failed",
    deliveryState: "failed",
    targetSessionState,
    resultState: "none",
    turnPolicy: "recover_or_stop",
    errorCode,
    message,
  };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  createConductorToolBridge,
  formatInteractivePtyInput,
  formatWorkerAssignment,
  startConductorToolBridgeHttpServer,
};

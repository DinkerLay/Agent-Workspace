const http = require("node:http");
const crypto = require("node:crypto");
const {
  createDispatchCoordinator,
  formatInteractivePtyInput,
  formatWorkerAssignment,
} = require("./runtime/dispatch-coordinator.cjs");

function createConductorToolBridge({
  sessionStore,
  ptyManager,
  activateWorkerSession,
  prepareWorkerSession,
  enqueueWorkerInput,
  validateDispatch,
  resolveAgentSession,
  getTaskAgentMap,
  onCompletionClaim,
  prepareDispatchContext,
  readTerminalSessionFact,
  deliverProviderAssignment,
  abortProviderDispatch,
  resolveConductorSessionId,
}) {
  const dispatchCoordinator = createDispatchCoordinator({
    sessionStore,
    ptyManager,
    activateWorkerSession,
    prepareWorkerSession,
    enqueueWorkerInput,
    validateDispatch,
    resolveAgentSession,
    prepareDispatchContext,
    readTerminalSessionFact,
    deliverProviderAssignment,
    abortProviderDispatch,
    resolveConductorSessionId,
  });

  async function callSession(input) {
    const taskId = strictString(input?.taskId);
    return presentForConductor(await dispatchCoordinator.callSession(input), taskId);
  }

  async function callSessions(input) {
    const taskId = strictString(input?.taskId);
    return presentForConductor(await dispatchCoordinator.callSessions(input), taskId);
  }

  async function cancelDispatch(input) {
    const taskId = strictString(input?.taskId);
    return presentForConductor(await dispatchCoordinator.cancelDispatch(input), taskId);
  }

  // This is intentionally not an MCP tool. The Task/Run service invokes it
  // when Send continues a Task so a recovered Conductor receives an honest
  // occupancy projection before it reads durable state.
  async function reconcileTaskCancellations(input) {
    return dispatchCoordinator.reconcileTaskCancellations({ taskId: strictString(input?.taskId) });
  }

  async function readSession(input) {
    const taskId = strictString(input?.taskId);
    const requestedAgentId = strictString(input?.agentId);
    const resolved = typeof resolveAgentSession === "function" ? resolveAgentSession({ taskId, agentId: requestedAgentId }) : undefined;
    if (typeof resolveAgentSession === "function" && !resolved) {
      return { taskId, agentId: requestedAgentId, error: "agent_card_not_found" };
    }
    const sessionId = strictString(resolved?.sessionId) || strictString(input?.sessionId);
    const view = sessionStore.readSession({
      taskId,
      sessionId,
      sinceCursor: Number(input?.sinceCursor ?? 0),
      maxChars: Number(input?.maxChars ?? 12_000),
    });
    return presentForConductor(view, taskId);
  }

  async function readTaskState(input) {
    if (typeof sessionStore.readTaskState === "function") {
      const view = sessionStore.readTaskState({
        taskId: String(input?.taskId ?? ""),
        sinceCursor: Number(input?.sinceCursor ?? 0),
      });
      return presentForConductor(view, strictString(input?.taskId));
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
    if (typeof onCompletionClaim !== "function") {
      return {
        ok: false,
        taskId,
        sessionId,
        status: "failed",
        eventType: "task.completion_claim",
        turnPolicy: "recover_or_stop",
        errorCode: "completion_claim_not_supported",
        message: "Task/Run service does not support structured task completion claims.",
      };
    }

    // This is a control-plane consistency check, not a routing policy: a
    // Conductor cannot make a user-visible delivery claim while it still has
    // native assignments with no Provider outcome. It remains free to choose
    // what to do with completed or failed work; it simply must wait for the
    // facts of every dispatched Session before claiming the current delivery.
    const pendingDispatches = pendingDispatchesForTask(sessionStore, taskId);
    if (pendingDispatches.length) {
      return {
        ok: false,
        taskId,
        sessionId,
        status: "pending",
        eventType: "task.completion_claim",
        turnPolicy: "continue_loop",
        errorCode: "completion_claim_has_pending_dispatches",
        pendingDispatches,
        message: "A delivery claim was not recorded because dispatched native Sessions still have no Provider outcome. End this decision and wait for a Runtime wakeup, then decide from durable Provider facts.",
      };
    }

    let loopRun;
    try {
      loopRun = await onCompletionClaim?.({ taskId, sessionId, message, summary: input?.summary ? String(input.summary) : undefined });
    } catch (error) {
      return {
        ok: false,
        taskId,
        sessionId,
        status: "failed",
        eventType: "task.completion_claim",
        turnPolicy: "continue_loop",
        errorCode: error instanceof Error ? error.message : "completion_claim_validation_failed",
        message: "Runtime could not record the Conductor delivery claim. Inspect the technical error and decide the next action.",
      };
    }
    // The Task/Run command atomically owns the lifecycle transition, Run
    // decision and Timeline outbox. The bridge only reads the resulting
    // projection; it must never impersonate a second state writer.
    const event = loopRun?.runtimeState?.events
      ?.filter((item) => item?.type === "task.completion_claim")
      .at(-1);
    return {
      ok: true,
      taskId,
      sessionId,
      status: "completion_claim_recorded",
      eventType: "task.completion_claim",
      event,
      loopRun,
      turnPolicy: "wait_for_user_delivery_confirmation",
      nextAllowedAction: "wait_for_user_to_inspect_artifact",
      message:
        "Conductor delivery claim recorded. The user can inspect the delivered artifact and, if satisfied, mark the Task achieved or send a follow-up for another Conductor decision.",
    };
  }

  return {
    callSession,
    callSessions,
    cancelDispatch,
    reconcileTaskCancellations,
    readTaskState,
    readSession,
    claimTaskCompletion,
  };

  function presentForConductor(value, taskId) {
    if (typeof getTaskAgentMap !== "function") return value;
    const map = getTaskAgentMap({ taskId });
    if (!map || typeof map !== "object" || Object.keys(map).length === 0) return value;
    return redactSessionIds(value, map);
  }
}

function pendingDispatchesForTask(sessionStore, taskId) {
  if (typeof sessionStore?.readTaskState !== "function" || !taskId) return [];
  const state = sessionStore.readTaskState({ taskId, sinceCursor: 0 });
  const pendingStates = new Set(["queued", "input_accepted", "delivered", "cancellation_requested", "cancel_failed"]);
  return (state?.dispatches ?? [])
    .filter((dispatch) => pendingStates.has(String(dispatch?.status ?? "")))
    .map((dispatch) => ({
      dispatchId: String(dispatch?.dispatchId ?? ""),
      agentId: String(dispatch?.agentId ?? ""),
      status: String(dispatch?.status ?? ""),
    }));
}

function redactSessionIds(value, agentBySessionId) {
  if (Array.isArray(value)) return value.map((item) => redactSessionIds(item, agentBySessionId));
  if (!value || typeof value !== "object") return value;
  const projected = {};
  for (const [key, item] of Object.entries(value)) {
    if (["sessionId", "toSessionId", "workerSessionId"].includes(key)) {
      const agentId = agentBySessionId[String(item)];
      projected[key === "workerSessionId" ? "workerAgentId" : "agentId"] = agentId ?? "unknown";
      continue;
    }
    if (key === "conductorSessionId") {
      projected.conductorAgentId = agentBySessionId[String(item)] ?? "conductor";
      continue;
    }
    projected[key] = redactSessionIds(item, agentBySessionId);
  }
  return projected;
}

async function startConductorToolBridgeHttpServer({ bridge, token = crypto.randomUUID(), host = "127.0.0.1" }) {
  const toolHandlers = {
    call_session: bridge.callSession,
    call_sessions: bridge.callSessions,
    cancel_dispatch: bridge.cancelDispatch,
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

function strictString(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = {
  createConductorToolBridge,
  formatInteractivePtyInput,
  formatWorkerAssignment,
  startConductorToolBridgeHttpServer,
};

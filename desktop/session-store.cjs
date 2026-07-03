const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

function createSessionStore({ root }) {
  if (!root) {
    throw new Error("Session Store requires root.");
  }
  const taskRoots = new Map();

  function startSession(session) {
    ensureSessionDir(session);
    const cursor = appendEvent(session, "session.started", undefined, `Started ${session.command ?? "session"}`);
    writeState(session, {
      state: "running",
      command: session.command,
      cwd: session.cwd,
      provider: session.provider,
      model: session.model,
      cursor,
      updatedAt: new Date().toISOString(),
    });
  }

  function recordOutput(session) {
    ensureSessionDir(session);
    writeState(session, {
      lastOutputAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  }

  function recordState(session, state, summary, data = {}) {
    const current = readJson(path.join(ensureSessionDir(session), "state.json")) ?? {};
    if (current.state === state) {
      writeState(session, {
        state,
        lastStateSummary: summary,
        lastStateData: data,
        updatedAt: new Date().toISOString(),
      });
      return current.cursor ?? 0;
    }
    const cursor = appendEvent(session, `session.${state}`, undefined, summary, data);
    writeState(session, {
      state,
      cursor,
      lastStateSummary: summary,
      lastStateData: data,
      updatedAt: new Date().toISOString(),
    });
    return cursor;
  }

  function recordDispatch(input) {
    const session = { taskId: input.taskId, sessionId: input.toSessionId };
    const existingTaskDispatches = readTaskDispatches(input.taskId);
    const dispatchId = createShortDispatchId(input, existingTaskDispatches);
    const record = {
      dispatchId,
      taskId: input.taskId,
      toSessionId: input.toSessionId,
      conductorSessionId: input.conductorSessionId ? String(input.conductorSessionId) : "",
      assignment: input.assignment,
      contextRefs: input.contextRefs ?? [],
      expectedOutput: input.expectedOutput ?? "",
      priority: input.priority ?? "normal",
      status: "queued",
      createdAt: new Date().toISOString(),
    };

    appendJsonLine(pathFor(session, "dispatches.jsonl"), record);
    appendEvent(session, "dispatch.created", undefined, `Dispatch ${dispatchId} created`, {
      dispatchId,
      conductorSessionId: record.conductorSessionId,
    });
    return record;
  }

  function markDispatchDelivered(input) {
    const session = { taskId: input.taskId, sessionId: input.sessionId };
    const dispatchesPath = pathFor(session, "dispatches.jsonl");
    let updated;
    const dispatches = readJsonLines(dispatchesPath).map((dispatch) => {
      if (dispatch.dispatchId !== input.dispatchId) return dispatch;
      updated = { ...dispatch, status: "delivered", deliveredAt: new Date().toISOString() };
      return updated;
    });
    writeJsonLines(dispatchesPath, dispatches);
    appendEvent(session, "dispatch.delivered", undefined, `Dispatch ${input.dispatchId} delivered`, {
      dispatchId: input.dispatchId,
    });
  }

  function markDispatchFailed(input) {
    const session = { taskId: input.taskId, sessionId: input.sessionId };
    const dispatchesPath = pathFor(session, "dispatches.jsonl");
    let updated;
    const dispatches = readJsonLines(dispatchesPath).map((dispatch) => {
      if (dispatch.dispatchId !== input.dispatchId) return dispatch;
      updated = {
        ...dispatch,
        status: "failed",
        failedAt: new Date().toISOString(),
        failureReason: input.reason,
        failureMessage: input.message,
        failureError: input.error,
      };
      return updated;
    });
    writeJsonLines(dispatchesPath, dispatches);
    appendEvent(session, "dispatch.failed", undefined, `Dispatch ${input.dispatchId} failed`, {
      dispatchId: input.dispatchId,
      reason: input.reason,
      message: input.message,
      error: input.error,
    });
  }

  function recordDispatchResult(input) {
    const session = { taskId: input.taskId, sessionId: input.sessionId };
    const resultsPath = pathFor(session, "results.jsonl");
    const dispatchesPath = pathFor(session, "dispatches.jsonl");
    const taskMessagesPath = path.join(resolveRoot(session), safeSegment(session.taskId), "messages.jsonl");
    const existingResults = readJsonLines(resultsPath);
    const existingDispatches = readJsonLines(dispatchesPath);
    const existingResult = existingResults.find((result) => result.dispatchId === input.dispatchId);
    const resultRecord =
      existingResult ??
      createResultRecord({
        ...input,
        resultId: `result-${safeSegment(input.dispatchId)}`,
      });
    let updated;
    let changed = false;
    const dispatches = existingDispatches.map((dispatch) => {
      if (dispatch.dispatchId !== input.dispatchId) return dispatch;
      if (dispatch.status === "result_available") {
        updated = dispatch;
        return dispatch;
      }
      changed = true;
      updated = {
        ...dispatch,
        status: "result_available",
        resultAvailableAt: new Date().toISOString(),
        resultId: resultRecord.resultId,
        resultReason: input.reason ?? "worker-state-changed",
        resultCursor: Number.isFinite(input.cursor) ? input.cursor : undefined,
        resultSource: resultRecord.source,
        provider: resultRecord.provider,
        providerSessionId: resultRecord.providerSessionId,
        providerMessageId: resultRecord.providerMessageId,
        providerStepFinishId: resultRecord.providerStepFinishId,
      };
      return updated;
    });
    if (!updated) {
      return { dispatchId: input.dispatchId, status: "missing" };
    }

    if (!existingResult) {
      appendJsonLine(resultsPath, resultRecord);
      appendJsonLine(taskMessagesPath, createMessageRecord(resultRecord));
    }
    writeJsonLines(dispatchesPath, dispatches);
    if (changed) {
      appendEvent(session, "dispatch.result_available", undefined, `Dispatch ${input.dispatchId} result is available`, {
        dispatchId: input.dispatchId,
        resultId: resultRecord.resultId,
        reason: input.reason ?? "worker-state-changed",
        cursor: Number.isFinite(input.cursor) ? input.cursor : undefined,
        source: resultRecord.source,
        provider: resultRecord.provider,
        providerSessionId: resultRecord.providerSessionId,
        providerMessageId: resultRecord.providerMessageId,
        providerStepFinishId: resultRecord.providerStepFinishId,
        answerPreview: resultRecord.answerPreview,
      });
    }
    return { ...resultRecord, status: updated.status, changed };
  }

  function recordConductorWakeup(input) {
    const session = { taskId: input.taskId, sessionId: input.sessionId };
    const status = input.status === "sent" ? "sent" : "queued";
    return appendEvent(
      session,
      `conductor.wakeup.${status}`,
      undefined,
      input.summary ?? `Conductor wakeup ${status} for ${input.workerSessionId ?? "worker session"}`,
      {
        dispatchId: input.dispatchId,
        resultId: input.resultId,
        workerSessionId: input.workerSessionId,
        workerState: input.workerState,
        cursor: Number.isFinite(input.cursor) ? input.cursor : undefined,
      },
    );
  }

  function readSession(input) {
    const session = { taskId: input.taskId, sessionId: input.sessionId };
    const dir = ensureSessionDir(session);
    const state = readJson(path.join(dir, "state.json")) ?? { state: "idle", cursor: 0 };
    const sinceCursor = normalizeCursor(input.sinceCursor);
    const events = readableEvents(readJsonLines(path.join(dir, "events.jsonl"))).filter(
      (event) => event.cursor > sinceCursor,
    );
    const taskMessages = readJsonLines(path.join(resolveRoot(session), safeSegment(input.taskId), "messages.jsonl")).filter(
      (message) => message.sessionId === input.sessionId,
    );

    return {
      sessionId: input.sessionId,
      state: state.state ?? "idle",
      cursor: state.cursor ?? events.at(-1)?.cursor ?? 0,
      cleanTranscriptTail: "",
      events,
      dispatches: readJsonLines(path.join(dir, "dispatches.jsonl")),
      results: readJsonLines(path.join(dir, "results.jsonl")),
      messages: taskMessages,
      permissions: readJsonLines(path.join(dir, "permissions.jsonl")),
      artifacts: readJsonLines(path.join(dir, "artifacts.jsonl")),
    };
  }

  function readTaskState(input) {
    const taskId = String(input.taskId ?? "");
    const taskRoot = path.join(resolveRoot({ taskId }), safeSegment(taskId));
    const taskEventsPath = path.join(taskRoot, "events.jsonl");
    const taskEvents = readableEvents(readJsonLines(taskEventsPath));
    const sinceCursor = normalizeCursor(input.sinceCursor);
    const sessionsRoot = path.join(taskRoot, "sessions");
    const sessionDirs = fs.existsSync(sessionsRoot)
      ? fs.readdirSync(sessionsRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory())
      : [];
    const sessions = [];
    const dispatches = [];
    const results = [];
    const messages = readJsonLines(path.join(taskRoot, "messages.jsonl"));
    const permissions = [];
    const artifacts = [];

    for (const entry of sessionDirs) {
      const dir = path.join(sessionsRoot, entry.name);
      const state = readJson(path.join(dir, "state.json")) ?? {};
      const sessionDispatches = readJsonLines(path.join(dir, "dispatches.jsonl"));
      const sessionResults = readJsonLines(path.join(dir, "results.jsonl"));
      const sessionPermissions = readJsonLines(path.join(dir, "permissions.jsonl"));
      const sessionArtifacts = readJsonLines(path.join(dir, "artifacts.jsonl"));
      const sessionId = state.sessionId ?? sessionDispatches[0]?.toSessionId ?? sessionResults[0]?.sessionId ?? entry.name;

      sessions.push({
        sessionId,
        state: state.state ?? "idle",
        cursor: state.cursor ?? 0,
        updatedAt: state.updatedAt,
        lastStateSummary: state.lastStateSummary,
        lastStateData: state.lastStateData,
      });
      dispatches.push(...sessionDispatches);
      results.push(...sessionResults);
      permissions.push(...sessionPermissions.map((record) => ({ sessionId, ...record })));
      artifacts.push(...sessionArtifacts.map((record) => ({ sessionId, ...record })));
    }

    return {
      taskId,
      cursor: taskEvents.reduce((max, event) => Math.max(max, Number(event.cursor) || 0), 0),
      events: taskEvents.filter((event) => event.cursor > sinceCursor),
      sessions,
      dispatches,
      results,
      messages,
      permissions,
      artifacts,
      pendingDecisions: buildTaskPendingDecisions({ sessions, dispatches, results, permissions }),
    };
  }

  function readEvents(input) {
    const file = input.sessionId
      ? pathFor({ taskId: input.taskId, sessionId: input.sessionId }, "events.jsonl")
      : path.join(resolveRoot(input), safeSegment(input.taskId), "events.jsonl");
    const sinceCursor = normalizeCursor(input.sinceCursor);
    return readableEvents(readJsonLines(file)).filter((event) => event.cursor > sinceCursor);
  }

  function appendEvent(session, type, cursor, summary, data = {}) {
    const taskEventsPath = path.join(resolveRoot(session), safeSegment(session.taskId), "events.jsonl");
    fs.mkdirSync(path.dirname(taskEventsPath), { recursive: true });
    if (!fs.existsSync(taskEventsPath)) fs.writeFileSync(taskEventsPath, "");

    const taskEvents = readJsonLines(taskEventsPath);
    const nextCursor = Number.isFinite(cursor) ? cursor : nextEventCursor(taskEvents);
    const event = {
      id: `event-${nextCursor}`,
      taskId: session.taskId,
      sessionId: session.sessionId,
      type,
      createdAt: new Date().toISOString(),
      cursor: nextCursor,
      summary,
      data,
    };

    appendJsonLine(pathFor(session, "events.jsonl"), event);
    appendJsonLine(taskEventsPath, event);
    return nextCursor;
  }

  function writeState(session, patch) {
    const file = pathFor(session, "state.json");
    const current = readJson(file) ?? {};
    fs.writeFileSync(
      file,
      `${JSON.stringify({ ...current, taskId: session.taskId, sessionId: session.sessionId, ...patch }, null, 2)}\n`,
    );
  }

  function ensureSessionDir(session) {
    const dir = path.join(resolveRoot(session), safeSegment(session.taskId), "sessions", safeSegment(session.sessionId));
    fs.mkdirSync(dir, { recursive: true });
    const stateFile = path.join(dir, "state.json");
    if (!fs.existsSync(stateFile)) fs.writeFileSync(stateFile, "{}\n");
    return dir;
  }

  function pathFor(session, file) {
    return path.join(ensureSessionDir(session), file);
  }

  function resolveRoot(session = {}) {
    if (typeof root !== "function") return root;

    const taskKey = safeSegment(session.taskId);
    if (session.cwd) {
      const resolved = normalizeRoot(root(session));
      taskRoots.set(taskKey, resolved);
      return resolved;
    }

    const existing = taskRoots.get(taskKey);
    if (existing) return existing;

    const resolved = normalizeRoot(root(session));
    taskRoots.set(taskKey, resolved);
    return resolved;
  }

  function readTaskDispatches(taskId) {
    const taskRoot = path.join(resolveRoot({ taskId }), safeSegment(taskId));
    const sessionsRoot = path.join(taskRoot, "sessions");
    if (!fs.existsSync(sessionsRoot)) return [];
    return fs
      .readdirSync(sessionsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .flatMap((entry) => readJsonLines(path.join(sessionsRoot, entry.name, "dispatches.jsonl")));
  }

  return {
    startSession,
    recordOutput,
    recordState,
    recordDispatch,
    markDispatchDelivered,
    markDispatchFailed,
    recordDispatchResult,
    recordConductorWakeup,
    readSession,
    readTaskState,
    readEvents,
  };
}

function buildTaskPendingDecisions({ sessions, dispatches, results, permissions }) {
  const resultIds = new Set(results.map((result) => result.resultId).filter(Boolean));
  const decisions = [];

  for (const dispatch of dispatches) {
    if (dispatch.status !== "result_available") continue;
    decisions.push({
      type: "worker_result_available",
      dispatchId: dispatch.dispatchId,
      sessionId: dispatch.toSessionId,
      resultId: resultIds.has(dispatch.resultId) ? dispatch.resultId : undefined,
      cursor: dispatch.resultCursor,
    });
  }

  for (const session of sessions) {
    if (session.state === "waiting" || session.state === "blocked" || session.state === "timeout") {
      decisions.push({
        type: `session_${session.state}`,
        sessionId: session.sessionId,
        cursor: session.cursor,
        summary: session.lastStateSummary,
      });
    }
  }

  for (const permission of permissions) {
    const status = String(permission.status ?? "requested");
    if (status === "resolved" || status === "approved" || status === "denied") continue;
    decisions.push({
      type: "permission_requested",
      sessionId: permission.sessionId,
      permissionId: permission.permissionId,
      summary: permission.summary,
    });
  }

  return decisions;
}

function createResultRecord(input) {
  const answerText = String(input.answerText ?? "");
  return {
    resultId: input.resultId,
    dispatchId: input.dispatchId,
    taskId: input.taskId,
    sessionId: input.sessionId,
    provider: input.provider ? String(input.provider) : undefined,
    providerSessionId: input.providerSessionId ? String(input.providerSessionId) : undefined,
    providerMessageId: input.providerMessageId ? String(input.providerMessageId) : undefined,
    providerStepFinishId: input.providerStepFinishId ? String(input.providerStepFinishId) : undefined,
    stepFinishReason: input.stepFinishReason ? String(input.stepFinishReason) : undefined,
    answerText,
    answerPreview: answerText.slice(0, 500),
    source: input.source ? String(input.source) : "provider-message-parts",
    status: "result_available",
    reason: input.reason ?? "worker-state-changed",
    cursor: Number.isFinite(input.cursor) ? input.cursor : undefined,
    completedAt: Number.isFinite(input.completedAt) ? input.completedAt : undefined,
    createdAt: new Date().toISOString(),
  };
}

function createMessageRecord(result) {
  return {
    taskId: result.taskId,
    sessionId: result.sessionId,
    dispatchId: result.dispatchId,
    resultId: result.resultId,
    provider: result.provider,
    providerSessionId: result.providerSessionId,
    providerMessageId: result.providerMessageId,
    providerStepFinishId: result.providerStepFinishId,
    stepFinishReason: result.stepFinishReason,
    answerText: result.answerText,
    answerPreview: result.answerPreview,
    source: result.source,
    completedAt: result.completedAt,
    createdAt: result.createdAt,
  };
}

function createShortDispatchId(input, existingDispatches = []) {
  const used = new Set(existingDispatches.map((dispatch) => dispatch?.dispatchId).filter(Boolean));
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const seed = [
      input.taskId,
      input.toSessionId,
      input.assignment,
      Date.now(),
      process.hrtime.bigint().toString(),
      crypto.randomBytes(8).toString("hex"),
      attempt,
    ].join(":");
    const id = crypto.createHash("sha1").update(seed).digest("hex").slice(0, 6).toUpperCase();
    if (/^[A-F0-9]{6}$/.test(id) && !used.has(id)) return id;
  }
  let counter = 0;
  while (counter <= 0xffffff) {
    const id = counter.toString(16).padStart(6, "0").toUpperCase();
    if (!used.has(id)) return id;
    counter += 1;
  }
  return crypto.randomBytes(3).toString("hex").toUpperCase();
}

function appendJsonLine(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(value)}\n`);
}

function writeJsonLines(file, values) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, values.map((value) => JSON.stringify(value)).join("\n").concat(values.length ? "\n" : ""));
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

function readJsonLines(file) {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function readTail(file, maxChars) {
  if (!fs.existsSync(file)) return "";
  return fs.readFileSync(file, "utf8").slice(-maxChars);
}

function readableEvents(events) {
  return events.filter((event) => event?.type !== "session.output");
}

function nextEventCursor(events) {
  return (
    events.reduce((max, event) => {
      const cursor = Number(event?.cursor);
      return Number.isFinite(cursor) ? Math.max(max, cursor) : max;
    }, 0) + 1
  );
}

function stripTerminalControls(text) {
  return String(text)
    .replace(/\u001b[PX^_][\s\S]*?\u001b\\/g, "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\u001b\][\s\S]*?(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b[@-_]/g, "")
    .replace(/\r/g, "\n");
}

function normalizeRoot(value) {
  if (!value || typeof value !== "string") {
    throw new Error("Session Store dynamic root must resolve to a path string.");
  }
  return value;
}

function normalizeCursor(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return 0;
  return Math.floor(numeric);
}

function safeSegment(value) {
  return String(value || "unknown").replace(/[^a-zA-Z0-9._-]/g, "-");
}

module.exports = { createSessionStore, stripTerminalControls };

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

function createSessionStore({
  root,
  jsonlReadTailBytes = 2 * 1024 * 1024,
  terminalLogMaxBytes = 8 * 1024 * 1024,
}) {
  if (!root) {
    throw new Error("Session Store requires root.");
  }
  const taskRoots = new Map();
  // Semantic changes are a separate channel from raw PTY output.  Consumers
  // use this to re-read durable state; they never receive or infer state from
  // a terminal chunk.
  const taskChangeListeners = new Set();

  function onTaskChange(listener) {
    if (typeof listener !== "function") throw new Error("Task change listener must be a function.");
    taskChangeListeners.add(listener);
    return () => taskChangeListeners.delete(listener);
  }

  function notifyTaskChange(change) {
    const taskId = String(change?.taskId ?? "");
    if (!taskId) return;
    const payload = {
      taskId,
      sessionId: change?.sessionId ? String(change.sessionId) : undefined,
      type: String(change?.type ?? "runtime.state_changed"),
      cursor: Number.isFinite(change?.cursor) ? change.cursor : undefined,
    };
    for (const listener of taskChangeListeners) {
      try {
        listener(payload);
      } catch {
        // Store persistence must never depend on a live desktop subscriber.
      }
    }
  }

  // Dynamic project roots are a durable Task fact, not merely a side effect of
  // starting a terminal.  Electron may restart before a historical Run is
  // opened, so callers that recovered a Task from durable storage can restore
  // this routing fact before any cwd-less Session Store read.
  function bindTaskRoot(input = {}) {
    const taskId = String(input.taskId ?? "");
    const cwd = String(input.cwd ?? "");
    if (!taskId) throw new Error("Session Store root binding requires taskId.");
    if (!cwd) throw new Error("Session Store root binding requires cwd.");
    return resolveRoot({ taskId, cwd });
  }

  /**
   * Delete only the Runtime-owned directory for one Task. Project delivery
   * files live outside this directory, so this operation never removes a
   * Markdown/HTML artifact the user asked an agent to create.
   */
  function deleteTask(input = {}) {
    const taskId = String(input.taskId ?? "");
    const cwd = String(input.cwd ?? "");
    if (!taskId) throw new Error("Session Store task deletion requires taskId.");
    if (!cwd) throw new Error("Session Store task deletion requires cwd.");
    const resolvedRoot = path.resolve(resolveRoot({ taskId, cwd }));
    const taskDirectory = path.resolve(resolvedRoot, safeSegment(taskId));
    if (!taskDirectory.startsWith(`${resolvedRoot}${path.sep}`)) {
      throw new Error("Session Store task deletion escaped Runtime root.");
    }
    const existed = fs.existsSync(taskDirectory);
    if (existed) fs.rmSync(taskDirectory, { recursive: true, force: true });
    taskRoots.delete(safeSegment(taskId));
    if (input.notify !== false) notifyTaskChange({ taskId, type: "task.deleted" });
    return { deleted: true, taskId, runtimeDirectoryRemoved: existed };
  }

  function startSession(session) {
    ensureSessionDir(session);
    const cursor = appendEvent(session, "session.started", undefined, `Started ${session.command ?? "session"}`);
    writeState(session, {
      terminalState: "ready",
      command: session.command,
      cwd: session.cwd,
      provider: session.provider,
      model: session.model,
      incarnationId: session.incarnationId,
      generation: session.generation,
      cursor,
      updatedAt: new Date().toISOString(),
    });
  }

  function recordOutput(session, chunk = "") {
    const dir = ensureSessionDir(session);
    const raw = Buffer.from(String(chunk ?? ""), "utf8");
    let terminalLogBytes = 0;
    let terminalLogTruncated = false;
    if (raw.length) {
      const logPath = path.join(dir, "terminal.raw.log");
      fs.appendFileSync(logPath, raw);
      const retained = retainTerminalLogTail(logPath, terminalLogMaxBytes);
      terminalLogBytes = retained.bytes;
      terminalLogTruncated = retained.truncated;
    } else {
      const logPath = path.join(dir, "terminal.raw.log");
      terminalLogBytes = fs.existsSync(logPath) ? fs.statSync(logPath).size : 0;
    }
    writeState(session, {
      lastOutputAt: new Date().toISOString(),
      terminalLogBytes,
      terminalLogTruncated,
      updatedAt: new Date().toISOString(),
    });
  }

  function readTerminalLog(input = {}) {
    const session = { taskId: String(input.taskId ?? ""), sessionId: String(input.sessionId ?? ""), cwd: input.cwd };
    if (!session.taskId || !session.sessionId) throw new Error("Terminal log requires taskId and sessionId.");
    const dir = path.join(resolveRoot(session), safeSegment(session.taskId), "sessions", safeSegment(session.sessionId));
    const logPath = path.join(dir, "terminal.raw.log");
    if (!fs.existsSync(logPath)) return { sessionId: session.sessionId, content: "", bytes: 0, truncated: false };
    const totalBytes = fs.statSync(logPath).size;
    const requested = Number(input.maxBytes);
    const maxBytes = Number.isSafeInteger(requested) && requested > 0 ? requested : terminalLogMaxBytes;
    const start = Math.max(0, totalBytes - maxBytes);
    const handle = fs.openSync(logPath, "r");
    try {
      const buffer = Buffer.alloc(totalBytes - start);
      fs.readSync(handle, buffer, 0, buffer.length, start);
      const state = readJson(path.join(dir, "state.json")) ?? {};
      return {
        sessionId: session.sessionId,
        content: buffer.toString("utf8"),
        bytes: totalBytes,
        truncated: start > 0 || Boolean(state.terminalLogTruncated),
      };
    } finally {
      fs.closeSync(handle);
    }
  }

  function recordState(session, state, summary, data = {}) {
    const runtimeState = normalizeSessionRuntimeState(state);
    const current = readJson(path.join(ensureSessionDir(session), "state.json")) ?? {};
    if (normalizeSessionRuntimeState(current.state) === runtimeState) {
      const cursor = latestKnownEventCursor(session, current.cursor ?? 0);
      const stateDetailChanged =
        current.lastStateSummary !== summary ||
        JSON.stringify(current.lastStateData ?? {}) !== JSON.stringify(data ?? {});
      writeState(session, {
        state: runtimeState,
        cursor,
        lastStateSummary: summary,
        lastStateData: data,
        updatedAt: new Date().toISOString(),
      });
      // Provider polling may observe the same state repeatedly. Persisting a
      // heartbeat is useful, but re-reading the whole Workbench is only useful
      // when its semantic state changed. Raw PTY output is never on this path.
      if (stateDetailChanged) {
        notifyTaskChange({ taskId: session.taskId, sessionId: session.sessionId, type: `session.${runtimeState}`, cursor });
      }
      return cursor;
    }
    const cursor = appendEvent(session, `session.${runtimeState}`, undefined, summary, data);
    writeState(session, {
      state: runtimeState,
      cursor,
      lastStateSummary: summary,
      lastStateData: data,
      updatedAt: new Date().toISOString(),
    });
    return cursor;
  }

  function recordTerminalState(session, state, summary, data = {}) {
    return recordOwnedSessionState(session, "terminal", normalizeTerminalOwnerState(state), summary, data);
  }

  function recordProviderSessionState(session, state, summary, data = {}) {
    return recordOwnedSessionState(session, "provider", normalizeProviderOwnerState(state), summary, data);
  }

  function recordOwnedSessionState(session, owner, state, summary, data) {
    if (!state) throw new Error(`Session Store ${owner} state is invalid.`);
    const stateField = `${owner}State`;
    const summaryField = `last${owner[0].toUpperCase()}${owner.slice(1)}StateSummary`;
    const dataField = `last${owner[0].toUpperCase()}${owner.slice(1)}StateData`;
    const current = readJson(path.join(ensureSessionDir(session), "state.json")) ?? {};
    const unchanged = String(current[stateField] ?? "") === state
      && current[summaryField] === summary
      && JSON.stringify(current[dataField] ?? {}) === JSON.stringify(data ?? {});
    if (unchanged) return latestKnownEventCursor(session, current.cursor ?? 0);
    const cursor = appendEvent(session, `${owner}.${state}`, undefined, summary, data);
    writeState(session, {
      [stateField]: state,
      [summaryField]: summary,
      [dataField]: data,
      cursor,
      updatedAt: new Date().toISOString(),
    });
    return cursor;
  }

  // A native Provider question is a one-shot, Session-owned interaction. The
  // reply is persisted separately from transient session state so a polling
  // observer cannot resurrect the Task-page card before OpenCode consumes it.
  function readQuestionResponse(input = {}) {
    const session = questionResponseSession(input);
    const questionId = requiredQuestionId(input);
    return readJsonLines(pathFor(session, "question-responses.jsonl"))
      .find((record) => String(record.questionId ?? "") === questionId);
  }

  function recordQuestionResponseSubmitted(input = {}) {
    const session = questionResponseSession(input);
    const questionId = requiredQuestionId(input);
    const answer = String(input.answer ?? "").trim();
    if (!answer) throw new Error("Question response requires answer.");
    const file = pathFor(session, "question-responses.jsonl");
    const records = readJsonLines(file);
    const existing = records.find((record) => String(record.questionId ?? "") === questionId);
    if (existing?.status === "submitted" || existing?.status === "resolved") return { ...existing, changed: false };
    const submittedAt = new Date().toISOString();
    const record = { questionId, answer, status: "submitted", submittedAt, updatedAt: submittedAt };
    upsertQuestionResponseRecord(file, questionId, record);
    appendEvent(session, "question.response_submitted", undefined, "用户已将回答发送到 OpenCode 原生问题，等待 Provider 继续。", { questionId, answer });
    return { ...record, changed: true };
  }

  function questionResponseSession(input) {
    const taskId = String(input.taskId ?? "");
    const sessionId = String(input.sessionId ?? "");
    if (!taskId || !sessionId) throw new Error("Question response requires taskId and sessionId.");
    return { taskId, sessionId, cwd: input.cwd };
  }

  function requiredQuestionId(input) {
    const questionId = String(input.questionId ?? "").trim();
    if (!questionId) throw new Error("Question response requires questionId.");
    return questionId;
  }

  // Permission requests are Provider facts. `permissionId` is a short-lived
  // Provider transport instance, not the logical user decision. OpenCode can
  // ask the same scoped question again after a Session resumes with a new
  // request id. Keep the historical records, but let one new instance take
  // over the retained response instead of creating two pending Task actions.
  function recordPermissionRequested(input = {}) {
    const session = permissionSession(input);
    const permissionId = requiredPermissionId(input);
    const file = pathFor(session, "permissions.jsonl");
    const records = readJsonLines(file);
    const existing = records.find((record) => String(record.permissionId ?? "") === permissionId);
    if (existing && ["requested", "submitted", "replaying", "recovery_pending", "reply_failed"].includes(String(existing.status ?? ""))) {
      return { ...existing, changed: false };
    }
    const requestedAt = new Date().toISOString();
    const record = {
      permissionId,
      requestId: boundedPermissionString(input.requestId, 200),
      provider: boundedPermissionString(input.provider || "opencode", 80),
      permission: boundedPermissionString(input.permission || "unknown", 160),
      patterns: boundedPermissionStrings(input.patterns, 24, 400),
      summary: boundedPermissionString(input.summary || "OpenCode 请求授权。", 1200),
      status: "requested",
      requestedAt: existing?.requestedAt ?? requestedAt,
      updatedAt: requestedAt,
    };
    record.scopeKey = permissionScopeKey(record);
    const retained = records.filter((candidate) =>
      candidate.permissionId !== permissionId &&
      hasReplayablePermissionResponse(candidate) &&
      permissionScopeKey(candidate) === record.scopeKey,
    );
    if (retained.length) {
      const source = retained.at(-1);
      const response = normalizePermissionResponse(source?.response);
      const previousPermissionIds = retained.map((candidate) => String(candidate.permissionId));
      const nextRecords = records
        .filter((candidate) => String(candidate.permissionId ?? "") !== permissionId)
        .map((candidate) => retained.some((sourceRecord) => sourceRecord.permissionId === candidate.permissionId)
          ? {
              ...candidate,
              status: "reissued",
              reissuedAt: requestedAt,
              reissuedByPermissionId: permissionId,
              updatedAt: requestedAt,
            }
          : candidate,
        );
      const replayed = {
        ...record,
        status: "replaying",
        response,
        replayedFromPermissionIds: previousPermissionIds,
        replayStartedAt: requestedAt,
      };
      nextRecords.push(replayed);
      writeJsonLines(file, nextRecords);
      appendEvent(session, "permission.reissued", undefined, "OpenCode 已重新请求相同范围的授权；Runtime 正在交付已保留的用户答复。", {
        permissionId,
        previousPermissionIds,
        provider: replayed.provider,
        permission: replayed.permission,
        patterns: replayed.patterns,
        response,
      });
      recordProviderSessionState(session, "permission_required", "OpenCode 已重新请求相同范围的授权；正在交付已保留的答复。", {
        permissionId,
        previousPermissionIds,
        provider: replayed.provider,
        permission: replayed.permission,
        patterns: replayed.patterns,
        recovery: "replaying",
      });
      return { ...replayed, changed: true, replayedResponse: response };
    }
    upsertPermissionRecord(file, permissionId, record);
    appendEvent(session, "permission.requested", undefined, record.summary, {
      permissionId: record.permissionId,
      provider: record.provider,
      permission: record.permission,
      patterns: record.patterns,
    });
    recordProviderSessionState(session, "permission_required", "OpenCode 正在等待用户授权。", {
      permissionId: record.permissionId,
      permission: record.permission,
      patterns: record.patterns,
    });
    return { ...record, changed: true };
  }

  function recordPermissionSubmitted(input = {}) {
    const session = permissionSession(input);
    const permissionId = requiredPermissionId(input);
    const response = normalizePermissionResponse(input.response);
    const file = pathFor(session, "permissions.jsonl");
    const existing = readJsonLines(file).find((record) => String(record.permissionId ?? "") === permissionId);
    if (!existing) return { permissionId, status: "missing", changed: false };
    if (String(existing.status) === "submitted" && String(existing.response) === response) return { ...existing, changed: false };
    if (["approved", "denied", "resolved"].includes(String(existing.status))) return { ...existing, changed: false };
    const record = { ...existing, status: "submitted", response, submittedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    upsertPermissionRecord(file, permissionId, record);
    appendEvent(session, "permission.response_submitted", undefined, "用户已提交 OpenCode 授权答复，等待 Provider 确认。", { permissionId, response });
    recordProviderSessionState(session, "permission_required", "已提交授权答复，等待 OpenCode 确认。", { permissionId, response });
    return { ...record, changed: true };
  }

  // A Provider reply endpoint is intentionally process-local. When Electron
  // restarts, persist the user's exact choice but never pretend that it reached
  // the old endpoint. The Runtime recovers the same logical Session. A later
  // equivalent Provider request receives the retained answer through its own
  // fresh, Main-process-only transport.
  function recordPermissionRecoveryPending(input = {}) {
    const session = permissionSession(input);
    const permissionId = requiredPermissionId(input);
    const response = normalizePermissionResponse(input.response);
    const file = pathFor(session, "permissions.jsonl");
    const existing = readJsonLines(file).find((record) => String(record.permissionId ?? "") === permissionId);
    if (!existing) return { permissionId, status: "missing", changed: false };
    if (String(existing.status) === "recovery_pending" && String(existing.response) === response) return { ...existing, changed: false };
    if (["approved", "denied", "resolved"].includes(String(existing.status))) return { ...existing, changed: false };
    const record = {
      ...existing,
      status: "recovery_pending",
      response,
      responseQueuedAt: existing.responseQueuedAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    upsertPermissionRecord(file, permissionId, record);
    appendEvent(session, "permission.response_recovery_queued", undefined, "应用重启后旧授权通道不可用；已保留用户答复并等待恢复原生 Session。", { permissionId, response });
    recordProviderSessionState(session, "permission_required", "已保留授权答复；正在恢复原生 Session，等待 OpenCode 重新请求。", { permissionId, response, recovery: true });
    return { ...record, changed: true };
  }

  function recordPermissionRecoveryFailed(input = {}) {
    const session = permissionSession(input);
    const permissionId = requiredPermissionId(input);
    const file = pathFor(session, "permissions.jsonl");
    const existing = readJsonLines(file).find((record) => String(record.permissionId ?? "") === permissionId);
    if (!existing) return { permissionId, status: "missing", changed: false };
    const record = {
      ...existing,
      status: "recovery_failed",
      recoveryFailedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    upsertPermissionRecord(file, permissionId, record);
    appendEvent(session, "permission.response_recovery_failed", undefined, "未能恢复原生 Session；授权答复尚未送达 OpenCode，可在 Task 页重试。", { permissionId });
    recordProviderSessionState(session, "permission_required", "无法恢复原生 Session；授权答复尚未送达 OpenCode。", { permissionId, recovery: "failed" });
    return { ...record, changed: true };
  }

  function recordPermissionReplyFailed(input = {}) {
    const session = permissionSession(input);
    const permissionId = requiredPermissionId(input);
    const response = normalizePermissionResponse(input.response);
    const file = pathFor(session, "permissions.jsonl");
    const existing = readJsonLines(file).find((record) => String(record.permissionId ?? "") === permissionId);
    if (!existing) return { permissionId, status: "missing", changed: false };
    if (["approved", "denied", "resolved"].includes(String(existing.status))) return { ...existing, changed: false };
    // Provider hook delivery and Runtime sampling can both observe the same
    // failed reply. A failed attempt is one user-visible fact, not a heartbeat:
    // keep the card actionable but do not grow the Timeline or refresh its
    // timestamp until the person explicitly chooses a different retry.
    if (String(existing.status) === "reply_failed" && String(existing.response) === response) {
      return { ...existing, changed: false };
    }
    const record = {
      ...existing,
      status: "reply_failed",
      response,
      replyFailedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    upsertPermissionRecord(file, permissionId, record);
    appendEvent(session, "permission.response_retry_required", undefined, "OpenCode 未接收这次授权答复；需要在 Task 页重新选择。", { permissionId });
    recordProviderSessionState(session, "permission_required", "OpenCode 未接收授权答复；需要在 Task 页重新选择。", { permissionId, retryRequired: true });
    return { ...record, changed: true };
  }

  function recordPermissionResolved(input = {}) {
    const session = permissionSession(input);
    const permissionId = requiredPermissionId(input);
    const response = normalizePermissionResponse(input.response);
    const file = pathFor(session, "permissions.jsonl");
    const existing = readJsonLines(file).find((record) => String(record.permissionId ?? "") === permissionId);
    if (!existing) return { permissionId, status: "missing", changed: false };
    const status = response === "reject" ? "denied" : "approved";
    if (String(existing.status) === status && String(existing.response) === response) return { ...existing, changed: false };
    const record = { ...existing, status, response, resolvedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    upsertPermissionRecord(file, permissionId, record);
    appendEvent(session, "permission.resolved", undefined, `OpenCode 已确认用户${response === "reject" ? "拒绝" : "授权"}该请求。`, { permissionId, response });
    recordProviderSessionState(session, "running", "OpenCode 已确认用户的授权答复。", { permissionId, response });
    return { ...record, changed: true };
  }

  function permissionSession(input) {
    const taskId = String(input.taskId ?? "");
    const sessionId = String(input.sessionId ?? "");
    if (!taskId || !sessionId) throw new Error("Permission record requires taskId and sessionId.");
    return { taskId, sessionId, cwd: input.cwd };
  }

  function requiredPermissionId(input) {
    const permissionId = String(input.permissionId ?? "").trim();
    if (!permissionId) throw new Error("Permission record requires permissionId.");
    return permissionId.slice(0, 300);
  }

  function hasReplayablePermissionResponse(record) {
    return ["recovery_pending", "submitted", "replaying", "reply_failed"].includes(String(record?.status ?? ""))
      && Boolean(normalizePermissionResponse(record?.response));
  }

  function permissionScopeKey(input = {}) {
    const provider = String(input.provider ?? "opencode").trim().toLowerCase();
    const permission = String(input.permission ?? "unknown").trim().toLowerCase();
    const patterns = [...new Set(
      (Array.isArray(input.patterns) ? input.patterns : [])
        .map((pattern) => String(pattern ?? "").trim())
        .filter(Boolean),
    )].sort((left, right) => left.localeCompare(right));
    return JSON.stringify([provider, permission, patterns]);
  }

  function upsertPermissionRecord(file, permissionId, record) {
    const records = readJsonLines(file);
    const index = records.findIndex((entry) => String(entry.permissionId ?? "") === permissionId);
    if (index === -1) records.push(record);
    else records[index] = record;
    writeJsonLines(file, records);
  }

  function upsertQuestionResponseRecord(file, questionId, record) {
    const records = readJsonLines(file);
    const index = records.findIndex((entry) => String(entry.questionId ?? "") === questionId);
    if (index === -1) records.push(record);
    else records[index] = record;
    writeJsonLines(file, records);
  }

  function recordDispatch(input) {
    const session = { taskId: input.taskId, sessionId: input.toSessionId };
    const existingTaskDispatches = readTaskDispatches(input.taskId);
    const dispatchId = createShortDispatchId(input, existingTaskDispatches);
    const record = {
      dispatchId,
      taskId: input.taskId,
      toSessionId: input.toSessionId,
      ...(input.agentId ? { agentId: String(input.agentId) } : {}),
      conductorSessionId: input.conductorSessionId ? String(input.conductorSessionId) : "",
      assignment: input.assignment,
      contextRefs: input.contextRefs ?? [],
      // A context packet is a durable snapshot resolved by the Runtime when
      // the Conductor explicitly cites a semantic Session result.  Retaining
      // the snapshot makes a dispatched worker prompt auditable and stable if
      // later Provider state changes or the app is restarted.
      contextPackets: input.contextPackets ?? [],
      expectedOutput: input.expectedOutput ?? "",
      priority: input.priority ?? "normal",
      status: "queued",
      createdAt: new Date().toISOString(),
    };

    appendJsonLine(pathFor(session, "dispatches.jsonl"), record);
    appendEvent(session, "dispatch.created", undefined, `Dispatch ${dispatchId} created`, {
      dispatchId,
      conductorSessionId: record.conductorSessionId,
      contextRefs: record.contextRefs,
      contextResultIds: record.contextPackets.map((packet) => packet?.resultId).filter(Boolean),
    });
    return record;
  }

  function markDispatchDelivered(input) {
    return markDispatchProviderReceived(input);
  }

  // Transport acceptance and Provider receipt are distinct durable facts. A
  // terminal write may succeed while OpenCode never records the assignment.
  function markDispatchInputAccepted(input) {
    return updateDispatchStatus(input, {
      from: new Set(["queued", "input_accepted"]),
      status: "input_accepted",
      timestampField: "inputAcceptedAt",
      eventType: "dispatch.input_accepted",
      eventSummary: `Dispatch ${input.dispatchId} accepted by Terminal Runtime`,
      data: {
        transport: input.transport ? String(input.transport) : "terminal_runtime",
        incarnationId: input.incarnationId ? String(input.incarnationId) : undefined,
        generation: input.generation ? String(input.generation) : undefined,
      },
      dispatchPatch: {
        transport: input.transport ? String(input.transport) : "terminal_runtime",
        terminalIncarnationId: input.incarnationId ? String(input.incarnationId) : undefined,
        terminalGeneration: input.generation ? String(input.generation) : undefined,
      },
    });
  }

  function markDispatchProviderReceived(input) {
    return updateDispatchStatus(input, {
      from: new Set(["queued", "input_accepted", "delivered"]),
      status: "delivered",
      timestampField: "providerReceivedAt",
      eventType: "dispatch.provider.received",
      eventSummary: `Dispatch ${input.dispatchId} recorded by OpenCode`,
      ownerSummary: "OpenCode recorded the exact dispatch marker; awaiting Provider outcome.",
      data: {
        provider: input.provider ? String(input.provider) : "opencode",
        providerSessionId: input.providerSessionId ? String(input.providerSessionId) : undefined,
        providerMessageId: input.providerMessageId ? String(input.providerMessageId) : undefined,
        dispatchMessageCreatedAt: Number.isFinite(input.dispatchMessageCreatedAt) ? input.dispatchMessageCreatedAt : undefined,
        databaseSourceId: input.databaseSourceId ? String(input.databaseSourceId) : undefined,
      },
      owner: "provider",
      ownerState: "running",
      dispatchPatch: {
        provider: input.provider ? String(input.provider) : "opencode",
        providerSessionId: input.providerSessionId ? String(input.providerSessionId) : undefined,
        providerMessageId: input.providerMessageId ? String(input.providerMessageId) : undefined,
        dispatchMessageCreatedAt: Number.isFinite(input.dispatchMessageCreatedAt) ? input.dispatchMessageCreatedAt : undefined,
        databaseSourceId: input.databaseSourceId ? String(input.databaseSourceId) : undefined,
      },
    });
  }

  function recordDispatchProviderFailure(input) {
    return updateDispatchStatus(input, {
      // A Provider failure must be tied to a Provider receipt.  A PTY that
      // exits before OpenCode records the exact marker is a transport failure,
      // not a Provider fact; use recordDispatchDeliveryFailure for that case.
      from: new Set(["delivered"]),
      status: "provider_failed",
      timestampField: "providerFailedAt",
      eventType: "dispatch.provider.failed",
      eventSummary: input.message ?? `Dispatch ${input.dispatchId} reached a terminal Provider failure`,
      ownerSummary: input.message ?? "Provider reached a terminal failure without a usable result.",
      data: {
        reason: input.reason ? String(input.reason) : "provider_terminal_failure",
        provider: input.provider ? String(input.provider) : "opencode",
        providerSessionId: input.providerSessionId ? String(input.providerSessionId) : undefined,
        providerMessageId: input.providerMessageId ? String(input.providerMessageId) : undefined,
        providerStepFinishId: input.providerStepFinishId ? String(input.providerStepFinishId) : undefined,
        stepFinishReason: input.stepFinishReason ? String(input.stepFinishReason) : undefined,
      },
      owner: "provider",
      ownerState: "blocked",
      dispatchPatch: {
        failureReason: input.reason ? String(input.reason) : "provider_terminal_failure",
        failureMessage: input.message ? String(input.message) : undefined,
        provider: input.provider ? String(input.provider) : "opencode",
        providerSessionId: input.providerSessionId ? String(input.providerSessionId) : undefined,
        providerMessageId: input.providerMessageId ? String(input.providerMessageId) : undefined,
        providerStepFinishId: input.providerStepFinishId ? String(input.providerStepFinishId) : undefined,
        stepFinishReason: input.stepFinishReason ? String(input.stepFinishReason) : undefined,
      },
    });
  }

  // Terminal Runtime owns this fact: an accepted byte stream ended before the
  // OpenCode observer found the exact persisted Dispatch marker.  Keep it
  // distinct from Provider failure so the Conductor can decide what to do
  // without being told OpenCode rejected work it never received.
  function recordDispatchDeliveryFailure(input) {
    return updateDispatchStatus(input, {
      from: new Set(["queued", "input_accepted"]),
      status: "delivery_failed",
      timestampField: "deliveryFailedAt",
      eventType: "dispatch.delivery_failed",
      eventSummary: input.message ?? `Terminal Runtime ended before Dispatch ${input.dispatchId} was observed by OpenCode`,
      data: {
        reason: input.reason ? String(input.reason) : "terminal_exit_before_receipt",
        terminalState: input.terminalState ? String(input.terminalState) : "exited",
      },
      dispatchPatch: {
        failureReason: input.reason ? String(input.reason) : "terminal_exit_before_receipt",
        failureMessage: input.message ? String(input.message) : undefined,
      },
    });
  }

  // A Conductor cancellation is a durable command first.  The Runtime must
  // not report success merely because it accepted a stop request: a terminal
  // exit (or an equally authoritative Provider fact) is the confirmation.
  function markDispatchCancellationRequested(input) {
    return updateDispatchStatus(input, {
      from: new Set(["queued", "input_accepted", "delivered", "cancel_failed"]),
      status: "cancellation_requested",
      timestampField: "cancellationRequestedAt",
      eventType: "dispatch.cancellation_requested",
      eventSummary: input.message ?? `Conductor requested cancellation of Dispatch ${input.dispatchId}`,
      data: {
        reason: input.reason ? String(input.reason) : "conductor_cancelled",
        terminalIncarnationId: input.terminalIncarnationId ? String(input.terminalIncarnationId) : undefined,
        terminalGeneration: input.terminalGeneration ? String(input.terminalGeneration) : undefined,
      },
      dispatchPatch: {
        cancellationReason: input.reason ? String(input.reason) : "conductor_cancelled",
        cancellationMessage: input.message ? String(input.message) : undefined,
        cancellationTerminalIncarnationId: input.terminalIncarnationId ? String(input.terminalIncarnationId) : undefined,
        cancellationTerminalGeneration: input.terminalGeneration ? String(input.terminalGeneration) : undefined,
      },
    });
  }

  // Cancellation is confirmed only from a Runtime or Provider observation.
  // Keep it distinct from transport/provider failure so the next Conductor
  // decision can reason about why the work stopped.
  function markDispatchCancelled(input) {
    return updateDispatchStatus(input, {
      from: new Set(["cancellation_requested"]),
      status: "cancelled",
      timestampField: "cancelledAt",
      eventType: "dispatch.cancelled",
      eventSummary: input.message ?? `Dispatch ${input.dispatchId} cancellation confirmed`,
      data: {
        reason: input.reason ? String(input.reason) : "conductor_cancelled",
        confirmation: input.confirmation ? String(input.confirmation) : "terminal_exit",
      },
      dispatchPatch: {
        cancellationReason: input.reason ? String(input.reason) : "conductor_cancelled",
        cancellationMessage: input.message ? String(input.message) : undefined,
        cancellationConfirmation: input.confirmation ? String(input.confirmation) : "terminal_exit",
      },
    });
  }

  // An interrupt transport failure is a fact, not permission to reuse the
  // worker card. The Conductor may inspect it and explicitly retry/ask the
  // user for a force stop, but Runtime never invents a replacement route.
  function markDispatchCancellationFailed(input) {
    return updateDispatchStatus(input, {
      from: new Set(["cancellation_requested"]),
      status: "cancel_failed",
      timestampField: "cancellationFailedAt",
      eventType: "dispatch.cancel_failed",
      eventSummary: input.message ?? `Terminal Runtime could not cancel Dispatch ${input.dispatchId}`,
      data: { reason: input.reason ? String(input.reason) : "terminal_interrupt_failed" },
      dispatchPatch: {
        cancellationFailureReason: input.reason ? String(input.reason) : "terminal_interrupt_failed",
        cancellationFailureMessage: input.message ? String(input.message) : undefined,
      },
    });
  }

  // Scanner outages are facts about the observer, not an instruction to retry
  // or a reason to mutate dispatch status.  Persist one deduplicated record so
  // it is visible after restart while normal polling may continue later.
  function recordDispatchObservationUnavailable(input) {
    const session = { taskId: input.taskId, sessionId: input.sessionId };
    const dispatchesPath = pathFor(session, "dispatches.jsonl");
    const reason = String(input.reason ?? "opencode_database_unavailable");
    let changed = false;
    let updated;
    const dispatches = readJsonLines(dispatchesPath).map((dispatch) => {
      if (dispatch.dispatchId !== input.dispatchId) return dispatch;
      updated = dispatch;
      if (dispatch.lastObservationUnavailableReason === reason) return dispatch;
      changed = true;
      updated = {
        ...dispatch,
        lastObservationUnavailableReason: reason,
        lastObservationUnavailableAt: new Date().toISOString(),
      };
      return updated;
    });
    if (!updated) return { dispatchId: input.dispatchId, status: "missing", changed: false };
    if (changed) {
      writeJsonLines(dispatchesPath, dispatches);
      appendEvent(session, "dispatch.provider.observation_unavailable", undefined, `OpenCode observation unavailable for Dispatch ${input.dispatchId}`, {
        dispatchId: input.dispatchId,
        reason,
      });
    }
    return { dispatchId: input.dispatchId, status: updated.status, changed };
  }

  function updateDispatchStatus(input, transition) {
    const session = { taskId: input.taskId, sessionId: input.sessionId };
    const dispatchesPath = pathFor(session, "dispatches.jsonl");
    let updated;
    let changed = false;
    const dispatches = readJsonLines(dispatchesPath).map((dispatch) => {
      if (dispatch.dispatchId !== input.dispatchId) return dispatch;
      if (dispatch.status === transition.status) {
        updated = dispatch;
        return dispatch;
      }
      if (transition.from && !transition.from.has(dispatch.status)) {
        updated = dispatch;
        return dispatch;
      }
      changed = true;
      updated = {
        ...dispatch,
        status: transition.status,
        [transition.timestampField]: new Date().toISOString(),
        ...(transition.dispatchPatch ?? {}),
      };
      return updated;
    });
    if (!updated) return { dispatchId: input.dispatchId, status: "missing", changed: false };
    if (changed) {
      writeJsonLines(dispatchesPath, dispatches);
      appendEvent(session, transition.eventType, undefined, transition.eventSummary, {
        dispatchId: input.dispatchId,
        ...(transition.data ?? {}),
      });
      if (transition.owner === "provider") {
        recordProviderSessionState(
          session,
          transition.ownerState,
          transition.ownerSummary,
          transition.data ?? {},
        );
      }
    }
    return { dispatchId: input.dispatchId, status: updated.status, changed };
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

  function recordDispatchFailure(input) {
    const toSessionId = String(input.toSessionId ?? "");
    return recordTaskEvent({
      taskId: input.taskId,
      sessionId: toSessionId,
      cwd: input.cwd,
      type: "dispatch.failed",
      summary: input.message ?? input.reason ?? "Dispatch route validation failed.",
      data: {
        dispatchId: input.dispatchId ? String(input.dispatchId) : "",
        toSessionId,
        assignment: input.assignment ?? "",
        reason: input.reason,
        message: input.message,
        error: input.error,
      },
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
    const session = { taskId: String(input.taskId ?? ""), sessionId: String(input.sessionId ?? "") };
    if (!session.taskId || !session.sessionId) throw new Error("Conductor wakeup requires taskId and sessionId.");
    const wakeupKey = String(input.wakeupKey ?? input.key ?? "").trim();
    if (!wakeupKey) throw new Error("Conductor wakeup requires wakeupKey.");
    const file = conductorWakeupsPath(session);
    const entries = readJsonLines(file);
    const prior = entries.find((entry) => entry.wakeupKey === wakeupKey);
    const requestedStatus = ["queued", "attempting", "sent", "observed"].includes(String(input.status))
      ? String(input.status)
      : "queued";
    const kind = input.kind ? String(input.kind) : prior?.kind ?? "result";
    // Builds before the Provider-receipt gate treated a started replacement
    // terminal as a delivered user message.  That left a durable `sent`
    // record without a Provider message id, and the normal monotonic guard
    // below made the exact same user input impossible to retry forever.
    //
    // This is deliberately narrower than a general status rollback: only a
    // caller that explicitly identifies that legacy state may return one
    // unobserved user message to `queued`.  An observed Provider receipt can
    // never be replayed through this path.
    const retryingLegacyUnconfirmed = input.retryLegacyUnconfirmed === true
      && requestedStatus === "queued"
      && String(prior?.status ?? "") === "sent"
      && kind === "user_message"
      && !prior?.providerMessageId
      && !prior?.observedAt;
    // A recovered scanner can rediscover the same immutable result. Never turn
    // a delivered wakeup back into a queue item merely because it is observed
    // again after restart.
    const status = !retryingLegacyUnconfirmed
      && ["sent", "observed"].includes(String(prior?.status))
      && ["queued", "attempting"].includes(requestedStatus)
      ? prior.status
      : requestedStatus;
    const timestamp = new Date().toISOString();
    const record = {
      ...prior,
      wakeupKey,
      taskId: session.taskId,
      sessionId: session.sessionId,
      kind,
      workerSessionId: input.workerSessionId ? String(input.workerSessionId) : prior?.workerSessionId,
      agentId: input.agentId ? String(input.agentId) : prior?.agentId,
      dispatchId: input.dispatchId ? String(input.dispatchId) : prior?.dispatchId,
      resultId: input.resultId ? String(input.resultId) : prior?.resultId,
      workerState: input.workerState ? String(input.workerState) : prior?.workerState,
      cursor: Number.isFinite(input.cursor) ? input.cursor : prior?.cursor,
      reason: input.reason ? String(input.reason) : prior?.reason,
      answerText: input.answerText ? String(input.answerText) : prior?.answerText,
      messageText: input.messageText ? String(input.messageText) : prior?.messageText,
      userMessageId: input.userMessageId ? String(input.userMessageId) : prior?.userMessageId,
      status,
      createdAt: prior?.createdAt ?? timestamp,
      attemptingAt: status === "attempting" ? timestamp : retryingLegacyUnconfirmed ? undefined : prior?.attemptingAt,
      sentAt: status === "sent" ? timestamp : retryingLegacyUnconfirmed ? undefined : prior?.sentAt,
      observedAt: status === "observed" ? timestamp : retryingLegacyUnconfirmed ? undefined : prior?.observedAt,
      provider: input.provider ? String(input.provider) : prior?.provider,
      providerSessionId: input.providerSessionId ? String(input.providerSessionId) : prior?.providerSessionId,
      providerMessageId: input.providerMessageId ? String(input.providerMessageId) : prior?.providerMessageId,
      dispatchMessageCreatedAt: Number.isFinite(input.dispatchMessageCreatedAt)
        ? input.dispatchMessageCreatedAt
        : prior?.dispatchMessageCreatedAt,
      databaseSourceId: input.databaseSourceId ? String(input.databaseSourceId) : prior?.databaseSourceId,
    };
    const next = prior ? entries.map((entry) => (entry.wakeupKey === wakeupKey ? record : entry)) : [...entries, record];
    writeJsonLines(file, next);
    if (!prior || prior.status !== status) {
      appendEvent(
        session,
        `conductor.wakeup.${status}`,
        undefined,
        input.summary ?? `Conductor wakeup ${status} for ${record.workerSessionId ?? "worker session"}`,
        {
          wakeupKey,
          kind: record.kind,
          dispatchId: record.dispatchId,
          resultId: record.resultId,
          workerSessionId: record.workerSessionId,
          workerState: record.workerState,
          cursor: record.cursor,
          reason: record.reason,
        },
      );
    }
    return record;
  }

  function listPendingConductorWakeups(input = {}) {
    const taskId = String(input.taskId ?? "");
    if (!taskId) throw new Error("Conductor wakeup list requires taskId.");
    const sessionId = input.sessionId ? String(input.sessionId) : undefined;
    return readJsonLines(conductorWakeupsPath({ taskId }))
      .filter((entry) => entry.status === "queued" && (!sessionId || entry.sessionId === sessionId))
      .sort((left, right) => String(left.createdAt ?? "").localeCompare(String(right.createdAt ?? "")));
  }

  function listUnconfirmedConductorWakeups(input = {}) {
    const taskId = String(input.taskId ?? "");
    if (!taskId) throw new Error("Conductor wakeup list requires taskId.");
    const sessionId = input.sessionId ? String(input.sessionId) : undefined;
    return readJsonLines(conductorWakeupsPath({ taskId }))
      .filter((entry) => ["attempting", "sent"].includes(String(entry.status)) && (!sessionId || entry.sessionId === sessionId))
      .sort((left, right) => String(left.createdAt ?? "").localeCompare(String(right.createdAt ?? "")));
  }

  function markConductorWakeupObserved(input = {}) {
    return recordConductorWakeup({ ...input, status: "observed" });
  }

  function recordConductorMessage(input) {
    const message = String(input.message ?? "");
    const event = recordTaskEvent({
      taskId: input.taskId,
      sessionId: input.sessionId,
      cwd: input.cwd,
      type: "conductor.message",
      summary: input.summary ?? message.slice(0, 160),
      data: {
        message,
        source: input.source ?? "conductor",
        provider: input.provider,
        providerSessionId: input.providerSessionId,
        providerMessageId: input.providerMessageId,
        providerStepFinishId: input.providerStepFinishId,
        stepFinishReason: input.stepFinishReason,
        completedAt: Number.isFinite(input.completedAt) ? input.completedAt : undefined,
        cursor: Number.isFinite(input.cursor) ? input.cursor : undefined,
      },
    });
    // A completed Conductor turn is the canonical point at which OpenCode has
    // identified the conversation that this logical Workspace Session owns.
    // Persist that binding beside the Timeline fact so a replacement PTY can
    // resume and observe the same Provider Session rather than rediscovering
    // it from its own newer transport start time.
    if (String(input.provider ?? "") === "opencode" && String(input.providerSessionId ?? "").trim()) {
      writeState(
        { taskId: input.taskId, sessionId: input.sessionId, cwd: input.cwd },
        {
          providerBinding: {
            provider: "opencode",
            providerSessionId: String(input.providerSessionId).trim(),
          },
          updatedAt: new Date().toISOString(),
        },
      );
    }
    return event;
  }

  function recordTaskCompletionClaim(input) {
    const message = String(input.message ?? "");
    return recordTaskEvent({
      taskId: input.taskId,
      sessionId: input.sessionId,
      cwd: input.cwd,
      type: "task.completion_claim",
      summary: input.summary ?? "Task completion claimed by Conductor",
      data: {
        message,
        source: input.source ?? "conductor",
      },
    });
  }

  function readSession(input) {
    const session = { taskId: input.taskId, sessionId: input.sessionId };
    const dir = ensureSessionDir(session);
    const state = readJson(path.join(dir, "state.json")) ?? { state: "ready", cursor: 0 };
    const sinceCursor = normalizeCursor(input.sinceCursor);
    const events = readableEvents(readViewJsonLines(path.join(dir, "events.jsonl"))).filter(
      (event) => event.cursor > sinceCursor,
    );
    const taskMessages = readViewJsonLines(path.join(resolveRoot(session), safeSegment(input.taskId), "messages.jsonl")).filter(
      (message) => message.sessionId === input.sessionId,
    );

    const dispatches = readJsonLines(path.join(dir, "dispatches.jsonl"));
    const results = readViewJsonLines(path.join(dir, "results.jsonl"));
    const projection = projectSessionRuntimeState(state, dispatches, results);

    return {
      sessionId: input.sessionId,
      ...projection,
      cursor: state.cursor ?? events.at(-1)?.cursor ?? 0,
      providerBinding: state.providerBinding,
      ...projectSessionStateDetail(state, projection),
      cleanTranscriptTail: "",
      events,
      dispatches,
      results,
      messages: taskMessages,
      permissions: readViewJsonLines(path.join(dir, "permissions.jsonl")),
      questionResponses: readViewJsonLines(path.join(dir, "question-responses.jsonl")),
      artifacts: readViewJsonLines(path.join(dir, "artifacts.jsonl")),
    };
  }

  function readTaskState(input) {
    const taskId = String(input.taskId ?? "");
    const taskRoot = path.join(resolveRoot({ taskId }), safeSegment(taskId));
    const taskEventsPath = path.join(taskRoot, "events.jsonl");
    const taskEvents = readableEvents(readViewJsonLines(taskEventsPath));
    const sinceCursor = normalizeCursor(input.sinceCursor);
    const sessionsRoot = path.join(taskRoot, "sessions");
    const sessionDirs = fs.existsSync(sessionsRoot)
      ? fs.readdirSync(sessionsRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory())
      : [];
    const sessions = [];
    const dispatches = [];
    const results = [];
    const messages = readViewJsonLines(path.join(taskRoot, "messages.jsonl"));
    const wakeups = readViewJsonLines(path.join(taskRoot, "conductor-wakeups.jsonl"));
    const permissions = [];
    const questionResponses = [];
    const artifacts = [];

    for (const entry of sessionDirs) {
      const dir = path.join(sessionsRoot, entry.name);
      const sessionDispatches = readJsonLines(path.join(dir, "dispatches.jsonl"));
      const state = readJson(path.join(dir, "state.json")) ?? {};
      const sessionResults = readViewJsonLines(path.join(dir, "results.jsonl"));
      const sessionPermissions = readViewJsonLines(path.join(dir, "permissions.jsonl"));
      const sessionQuestionResponses = readViewJsonLines(path.join(dir, "question-responses.jsonl"));
      const sessionArtifacts = readViewJsonLines(path.join(dir, "artifacts.jsonl"));
      const sessionId = state.sessionId ?? sessionDispatches[0]?.toSessionId ?? sessionResults[0]?.sessionId ?? entry.name;

      const projection = projectSessionRuntimeState(state, sessionDispatches, sessionResults);
      sessions.push({
        sessionId,
        ...projection,
        cursor: state.cursor ?? 0,
        updatedAt: state.updatedAt,
        ...projectSessionStateDetail(state, projection),
        providerBinding: state.providerBinding,
      });
      dispatches.push(...sessionDispatches);
      results.push(...sessionResults);
      permissions.push(...sessionPermissions.map((record) => ({ sessionId, ...record })));
      questionResponses.push(...sessionQuestionResponses.map((record) => ({ sessionId, ...record })));
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
      wakeups,
      permissions,
      questionResponses,
      artifacts,
      pendingDecisions: buildTaskPendingDecisions({ sessions, dispatches, results, permissions, wakeups }),
    };
  }

  function readEvents(input) {
    const file = input.sessionId
      ? pathFor({ taskId: input.taskId, sessionId: input.sessionId }, "events.jsonl")
      : path.join(resolveRoot(input), safeSegment(input.taskId), "events.jsonl");
    const sinceCursor = normalizeCursor(input.sinceCursor);
    return readableEvents(readViewJsonLines(file)).filter((event) => event.cursor > sinceCursor);
  }

  function latestKnownEventCursor(session, fallback = 0) {
    const taskEventsPath = path.join(resolveRoot(session), safeSegment(session.taskId), "events.jsonl");
    if (!fs.existsSync(taskEventsPath)) return Number(fallback) || 0;
    return readJsonLines(taskEventsPath).reduce((max, event) => {
      const cursor = Number(event?.cursor);
      return Number.isFinite(cursor) ? Math.max(max, cursor) : max;
    }, Number(fallback) || 0);
  }

  function recordTaskEvent(input) {
    const taskId = String(input?.taskId ?? "");
    const sessionId = input?.sessionId ? String(input.sessionId) : "";
    const sourceEventId = input?.eventId ? String(input.eventId) : "";
    const eventRoot = resolveRoot({ taskId, cwd: input?.cwd ? String(input.cwd) : undefined });
    const taskEventsPath = path.join(eventRoot, safeSegment(taskId), "events.jsonl");
    fs.mkdirSync(path.dirname(taskEventsPath), { recursive: true });
    if (!fs.existsSync(taskEventsPath)) fs.writeFileSync(taskEventsPath, "");

    const taskEvents = readJsonLines(taskEventsPath);
    const existingTaskEvent = sourceEventId
      ? taskEvents.find((event) => String(event?.sourceEventId ?? "") === sourceEventId)
      : undefined;
    if (existingTaskEvent) return existingTaskEvent;

    const sessionEventsPath = sessionId
      ? pathFor({ taskId, sessionId, cwd: input?.cwd ? String(input.cwd) : undefined }, "events.jsonl")
      : undefined;
    const existingSessionEvent = sourceEventId && sessionEventsPath
      ? readJsonLines(sessionEventsPath).find((event) => String(event?.sourceEventId ?? "") === sourceEventId)
      : undefined;
    const cursor = existingSessionEvent?.cursor ?? nextEventCursor(taskEvents);
    const event = existingSessionEvent ?? {
      id: `event-${cursor}`,
      ...(sourceEventId ? { sourceEventId } : {}),
      taskId,
      sessionId,
      type: String(input?.type ?? "task.event"),
      createdAt: new Date().toISOString(),
      cursor,
      summary: String(input?.summary ?? ""),
      data: input?.data && typeof input.data === "object" && !Array.isArray(input.data) ? input.data : {},
    };

    if (sessionEventsPath && !existingSessionEvent) appendJsonLine(sessionEventsPath, event);
    appendJsonLine(taskEventsPath, event);
    notifyTaskChange(event);
    return event;
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
    notifyTaskChange(event);
    return nextCursor;
  }

  function writeState(session, patch) {
    const file = pathFor(session, "state.json");
    const current = readJson(file) ?? {};
    const providerBinding = nextProviderBinding(
      current.providerBinding,
      patch.providerBinding ?? patch.lastProviderStateData ?? patch.lastStateData,
    );
    fs.writeFileSync(
      file,
      `${JSON.stringify({ ...current, taskId: session.taskId, sessionId: session.sessionId, ...patch, providerBinding }, null, 2)}\n`,
    );
  }

  function nextProviderBinding(current, candidate) {
    const provider = String(candidate?.provider ?? "").trim();
    const providerSessionId = String(candidate?.providerSessionId ?? "").trim();
    if (provider === "opencode" && providerSessionId) {
      return {
        provider,
        providerSessionId,
        observedAt: new Date().toISOString(),
      };
    }
    return current && typeof current === "object" ? current : undefined;
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

  function conductorWakeupsPath(session) {
    return path.join(resolveRoot({ taskId: session.taskId, cwd: session.cwd }), safeSegment(session.taskId), "conductor-wakeups.jsonl");
  }

  function readViewJsonLines(file) {
    return readJsonLines(file, { maxBytes: jsonlReadTailBytes });
  }

  return {
    bindTaskRoot,
    deleteTask,
    onTaskChange,
    startSession,
    recordOutput,
    readTerminalLog,
    recordTerminalState,
    recordProviderSessionState,
    /** @deprecated Compatibility for historical harnesses and fixtures. */
    recordState,
    readQuestionResponse,
    recordQuestionResponseSubmitted,
    recordPermissionRequested,
    recordPermissionSubmitted,
    recordPermissionRecoveryPending,
    recordPermissionRecoveryFailed,
    recordPermissionReplyFailed,
    recordPermissionResolved,
    recordDispatch,
    markDispatchInputAccepted,
    markDispatchDelivered,
    markDispatchProviderReceived,
    markDispatchFailed,
    recordDispatchProviderFailure,
    recordDispatchDeliveryFailure,
    markDispatchCancellationRequested,
    markDispatchCancelled,
    markDispatchCancellationFailed,
    recordDispatchObservationUnavailable,
    recordDispatchFailure,
    recordDispatchResult,
    recordConductorMessage,
    recordConductorWakeup,
    listPendingConductorWakeups,
    listUnconfirmedConductorWakeups,
    markConductorWakeupObserved,
    recordTaskCompletionClaim,
    readSession,
    readTaskState,
    readEvents,
    recordTaskEvent,
  };
}

function buildTaskPendingDecisions({ sessions, dispatches, results, permissions, wakeups = [] }) {
  const resultIds = new Set(results.map((result) => result.resultId).filter(Boolean));
  const unresolvedPermissionSessionIds = new Set(
    permissions
      .filter((permission) => !["resolved", "approved", "denied", "reissued"].includes(String(permission.status ?? "requested")))
      .map((permission) => String(permission.sessionId ?? ""))
      .filter(Boolean),
  );
  // A result is an inbox item until its immutable wakeup was observed by the
  // next Conductor Provider turn.  `contextRefs` answer a different question:
  // which complete result packets the Conductor explicitly handed to another
  // Session Agent.  Treating a context handoff as result consumption made the
  // attention count both premature and permanent for every result that was not
  // forwarded.  The original result remains durable/readable after the inbox
  // item is consumed.
  const observedResultIds = new Set(
    wakeups
      .filter((wakeup) => wakeup.kind === "result" && wakeup.status === "observed")
      .map((wakeup) => String(wakeup.resultId ?? ""))
      .filter(Boolean),
  );
  const decisions = [];

  for (const dispatch of dispatches) {
    if (dispatch.status !== "result_available" || observedResultIds.has(String(dispatch.resultId ?? ""))) continue;
    decisions.push({
      type: "worker_result_available",
      dispatchId: dispatch.dispatchId,
      sessionId: dispatch.toSessionId,
      resultId: resultIds.has(dispatch.resultId) ? dispatch.resultId : undefined,
      cursor: dispatch.resultCursor,
      severity: "info",
      actionHint: "read_result",
    });
  }

  // A dispatch failure is a durable control-plane fact.  Do not collapse it
  // into the Session's current state: the same native OpenCode Session may
  // successfully complete a later assignment while an earlier assignment
  // still needs a Conductor decision.  A later result is not an implicit
  // retry, replacement, or resolution of an earlier dispatch.
  for (const dispatch of dispatches) {
    if (!["failed", "delivery_failed", "provider_failed", "cancel_failed"].includes(dispatch.status)) continue;
    decisions.push({
      type: `dispatch_${dispatch.status}`,
      dispatchId: dispatch.dispatchId,
      sessionId: dispatch.toSessionId,
      summary:
        dispatch.failureMessage ??
        dispatch.failureReason ??
        `Dispatch ${dispatch.dispatchId} did not complete.`,
      severity: "blocking",
      actionHint: dispatchDecisionActionHint(dispatch.status),
    });
  }

  for (const wakeup of wakeups) {
    if (wakeup.status !== "queued") continue;
    decisions.push({
      type: "conductor_wakeup_queued",
      sessionId: wakeup.sessionId,
      dispatchId: wakeup.dispatchId,
      resultId: wakeup.resultId,
      cursor: wakeup.cursor,
      summary: wakeup.reason || `Runtime wakeup queued for ${wakeup.agentId || wakeup.workerSessionId || "Session Agent"}.`,
      severity: "info",
      actionHint: "deliver_conductor_wakeup",
    });
  }

  for (const session of sessions) {
    if (
      session.state === "waiting_input" ||
      (session.state === "permission_required" && !unresolvedPermissionSessionIds.has(String(session.sessionId))) ||
      session.state === "blocked" ||
      session.state === "timeout" ||
      session.state === "delivery_failed" ||
      session.state === "result_invalid" ||
      session.state === "exited"
    ) {
      // Dispatch failures are emitted above as individual control-plane facts.
      // Keep this fallback only for provider/process states which do not map to
      // a known dispatch record.
      if (session.state === "delivery_failed" && session.unresolvedFailureDispatchId) continue;
      decisions.push({
        type: `session_${session.state}`,
        sessionId: session.sessionId,
        cursor: session.cursor,
        summary: session.lastStateSummary,
        severity: sessionDecisionSeverity(session.state),
        actionHint: sessionDecisionActionHint(session.state),
      });
    }
  }

  for (const permission of permissions) {
    const status = String(permission.status ?? "requested");
    if (!["requested", "reply_failed"].includes(status)) continue;
    decisions.push({
      type: "permission_requested",
      sessionId: permission.sessionId,
      permissionId: permission.permissionId,
      summary: permission.summary,
      severity: "attention",
      actionHint: "resolve_permission",
    });
  }

  return decisions;
}

function projectSessionRuntimeState(rawFacts, dispatches = [], results = []) {
  const facts = rawFacts && typeof rawFacts === "object" ? rawFacts : { state: rawFacts };
  // Historical state.json files used one generic `state` writer. Prefer that
  // explicit compatibility fact over a passive Terminal `ready` fact, while
  // keeping new owner-specific Terminal failure and Provider attention facts
  // authoritative. New production writes never add this legacy field.
  const legacyState = Object.hasOwn(facts, "state")
    ? normalizeSessionRuntimeState(facts.state)
    : undefined;
  const terminalState = normalizeTerminalOwnerState(facts.terminalState);
  const providerState = normalizeProviderOwnerState(facts.providerState);
  const resultDispatches = dispatches.filter((dispatch) => dispatch.status === "result_available");
  const activeDispatches = dispatches.filter((dispatch) => ["queued", "input_accepted", "delivered", "cancellation_requested", "cancel_failed"].includes(dispatch.status));
  const failedDispatches = dispatches.filter((dispatch) => ["failed", "delivery_failed", "provider_failed", "cancel_failed"].includes(dispatch.status));
  const latestActiveDispatch = activeDispatches.at(-1);
  const latestResultDispatch = resultDispatches.at(-1);
  const latestFailedDispatch = failedDispatches.at(-1);
  // Keep the most recent failed dispatch as a convenience pointer, but never
  // use ordering against a later result to decide whether it disappeared.  The
  // Task-level projection exposes every failed dispatch independently.
  const unresolvedFailureDispatch = latestFailedDispatch;
  const latestResult = results.at(-1);
  const resultCount = Math.max(results.length, resultDispatches.filter((dispatch) => dispatch.resultId).length);
  const lastResultId = latestResult?.resultId ?? latestResultDispatch?.resultId;
  const attentionHints = [];

  let projectedState = providerState ?? legacyState ?? terminalState ?? "ready";
  if (
    (terminalState && PROCESS_UNAVAILABLE_STATES.has(terminalState))
    || (legacyState && PROCESS_UNAVAILABLE_STATES.has(legacyState))
  ) {
    projectedState = terminalState && PROCESS_UNAVAILABLE_STATES.has(terminalState)
      ? terminalState
      : legacyState;
  } else if (providerState && PROVIDER_ATTENTION_STATES.has(providerState)) {
    projectedState = providerState;
  } else if (latestActiveDispatch?.status === "queued") {
    projectedState = "queued";
  } else if (latestActiveDispatch?.status === "input_accepted") {
    projectedState = "queued";
  } else if (latestActiveDispatch?.status === "delivered") {
    projectedState = providerState === "running" ? "running" : "delivered_pending";
  } else if (latestActiveDispatch?.status === "cancellation_requested") {
    projectedState = "cancellation_requested";
  } else if (latestActiveDispatch?.status === "cancel_failed") {
    projectedState = "cancellation_failed";
  } else if (latestResultDispatch || latestResult) {
    projectedState = "result_available";
  } else if (unresolvedFailureDispatch) {
    projectedState = unresolvedFailureDispatch.status === "provider_failed" ? "blocked" : "delivery_failed";
  }

  if (ATTENTION_RUNTIME_STATES.has(projectedState)) attentionHints.push(projectedState);
  if (failedDispatches.length) attentionHints.push("dispatch_failed");
  if (resultCount > 0 || lastResultId) attentionHints.push("result_available");

  return {
    state: projectedState,
    terminalState,
    providerState,
    activeDispatchId: latestActiveDispatch?.dispatchId ?? unresolvedFailureDispatch?.dispatchId,
    lastResultId,
    resultCount,
    unresolvedFailureDispatchId: unresolvedFailureDispatch?.dispatchId,
    attentionHints: [...new Set(attentionHints)],
    assignmentReadinessHint: assignmentReadinessHintForState(projectedState, {
      resultCount,
      lastResultId,
      latestActiveDispatch,
    }),
  };
}

function projectSessionStateDetail(facts, projection) {
  if (projection.providerState && projection.state === projection.providerState) {
    return {
      lastStateSummary: facts.lastProviderStateSummary,
      lastStateData: facts.lastProviderStateData,
    };
  }
  if (projection.terminalState && projection.state === projection.terminalState) {
    return {
      lastStateSummary: facts.lastTerminalStateSummary,
      lastStateData: facts.lastTerminalStateData,
    };
  }
  return {
    lastStateSummary: facts.lastStateSummary
      ?? facts.lastProviderStateSummary
      ?? facts.lastTerminalStateSummary,
    lastStateData: facts.lastStateData
      ?? facts.lastProviderStateData
      ?? facts.lastTerminalStateData,
  };
}

function sessionDecisionSeverity(state) {
  if (state === "waiting_input" || state === "permission_required") return "attention";
  return "blocking";
}

function sessionDecisionActionHint(state) {
  const hints = {
    waiting_input: "provide_input",
    permission_required: "resolve_permission",
    blocked: "recover_blocked",
    timeout: "recover_timeout",
    delivery_failed: "recover_delivery",
    result_invalid: "inspect_invalid_result",
    exited: "restart_or_recover",
  };
  return hints[state] ?? "inspect_state";
}

function dispatchDecisionActionHint(status) {
  const hints = {
    failed: "inspect_dispatch_failure",
    delivery_failed: "recover_delivery",
    provider_failed: "inspect_provider_failure",
    cancel_failed: "inspect_cancellation_failure",
  };
  return hints[status] ?? "inspect_dispatch_failure";
}

function assignmentReadinessHintForState(state, context = {}) {
  if (state === "ready" || state === "result_available" || state === "waiting_conductor") return "ready";
  if (
    state === "delivery_failed" &&
    !context.latestActiveDispatch &&
    (Number(context.resultCount ?? 0) > 0 || Boolean(context.lastResultId))
  ) {
    return "ready";
  }
  return "not_ready";
}

const PROVIDER_ATTENTION_STATES = new Set(["waiting_input", "permission_required", "blocked", "timeout", "result_invalid"]);
const PROCESS_UNAVAILABLE_STATES = new Set(["stopping", "stopped", "exited", "start_failed"]);
const ATTENTION_RUNTIME_STATES = new Set([
  "waiting_input",
  "permission_required",
  "blocked",
  "timeout",
  "delivery_failed",
  "cancellation_requested",
  "cancellation_failed",
  "result_invalid",
  "exited",
  "start_failed",
]);

function normalizeSessionRuntimeState(state) {
  const value = String(state ?? "").trim();
  if (value === "idle") return "ready";
  if (value === "waiting") return "waiting_input";
  if (RUNTIME_SESSION_STATES.has(value)) return value;
  return "ready";
}

function normalizeTerminalOwnerState(state) {
  const value = String(state ?? "").trim();
  return TERMINAL_OWNER_STATES.has(value) ? value : undefined;
}

function normalizeProviderOwnerState(state) {
  const value = String(state ?? "").trim();
  return PROVIDER_OWNER_STATES.has(value) ? value : undefined;
}

const TERMINAL_OWNER_STATES = new Set([
  "not_started",
  "starting",
  "ready",
  "running",
  "stopping",
  "stopped",
  "exited",
  "start_failed",
]);

const PROVIDER_OWNER_STATES = new Set([
  "ready",
  "running",
  "waiting_input",
  "permission_required",
  "waiting_conductor",
  "blocked",
  "timeout",
  "result_invalid",
]);

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

function retainTerminalLogTail(file, maxBytes) {
  const limit = Number.isSafeInteger(maxBytes) && maxBytes > 0 ? maxBytes : 8 * 1024 * 1024;
  const size = fs.statSync(file).size;
  if (size <= limit) return { bytes: size, truncated: false };
  const buffer = Buffer.alloc(limit);
  const descriptor = fs.openSync(file, "r");
  try {
    fs.readSync(descriptor, buffer, 0, limit, size - limit);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.writeFileSync(file, buffer);
  return { bytes: limit, truncated: true };
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

function readJsonLines(file, options = {}) {
  if (!fs.existsSync(file)) return [];
  const text = readJsonLinesText(file, options.maxBytes);
  if (!text.trim()) return [];
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function readJsonLinesText(file, maxBytes) {
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
    return fs.readFileSync(file, "utf8");
  }
  const size = fs.statSync(file).size;
  if (size <= maxBytes) {
    return fs.readFileSync(file, "utf8");
  }
  const length = Math.min(size, Math.floor(maxBytes));
  const buffer = Buffer.alloc(length);
  const fd = fs.openSync(file, "r");
  try {
    fs.readSync(fd, buffer, 0, length, size - length);
  } finally {
    fs.closeSync(fd);
  }
  const text = buffer.toString("utf8");
  const firstNewline = text.indexOf("\n");
  if (firstNewline < 0) return "";
  return text.slice(firstNewline + 1);
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

function normalizePermissionResponse(value) {
  const response = String(value ?? "").trim();
  if (!new Set(["once", "always", "reject"]).has(response)) {
    throw new Error("Permission response must be once, always, or reject.");
  }
  return response;
}

function boundedPermissionString(value, maxLength) {
  return String(value ?? "").trim().slice(0, maxLength);
}

function boundedPermissionStrings(value, maxItems, maxLength) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => boundedPermissionString(item, maxLength))
    .filter(Boolean)
    .slice(0, maxItems);
}

function safeSegment(value) {
  return String(value || "unknown").replace(/[^a-zA-Z0-9._-]/g, "-");
}

module.exports = { createSessionStore, stripTerminalControls };

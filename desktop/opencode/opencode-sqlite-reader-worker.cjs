const fs = require("node:fs");
const path = require("node:path");
const { parentPort } = require("node:worker_threads");
const { DatabaseSync } = require("node:sqlite");

const MAX_ANSWER_CHARS = 2 * 1024 * 1024;
const TERMINAL_FAILURE_REASONS = new Set(["error", "failed", "abort", "aborted", "cancelled", "canceled"]);
const DISPATCH_MARKER = "[Agent Workspace] Dispatch ID ";
const CONDUCTOR_INPUT_MARKER = "[Agent Workspace] Conductor Input ID ";

if (!parentPort) throw new Error("OpenCode SQLite reader worker requires a parent port.");

parentPort.on("message", (request) => {
  let response;
  try {
    const input = request?.input ?? {};
    const value = request?.kind === "inspectConductor"
      ? inspectConductor(input)
      : request?.kind === "inspectDispatch"
        ? inspectDispatch(input)
        : request?.kind === "inspectConductorInput"
          ? inspectConductorInput(input)
        : (() => { throw new Error(`opencode_sqlite_request_unknown:${String(request?.kind ?? "")}`); })();
    response = { id: request?.id, ok: true, value };
  } catch (error) {
    response = {
      id: request?.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  parentPort.postMessage(response);
});

function inspectDispatch(input) {
  const dbPaths = normalizedDatabasePaths(input?.dbPaths);
  if (!dbPaths.length) {
    return unavailable("opencode_database_not_found");
  }

  const issues = [];
  let observedDatabase = false;
  for (const dbPath of dbPaths) {
    if (!fs.existsSync(dbPath)) continue;
    let db;
    try {
      db = openReadonlyDatabase(dbPath);
      if (!supportsOpenCodeDispatchSchema(db)) {
        issues.push(`${dbPath}:opencode_schema_unsupported`);
        continue;
      }
      observedDatabase = true;
      const observation = inspectDispatchInDatabase(db, input, dbPath);
      if (observation.kind !== "not_observed") return observation;
    } catch (error) {
      issues.push(`${dbPath}:${error instanceof Error ? error.message : String(error)}`);
    } finally {
      try {
        db?.close();
      } catch {
        // A read-only diagnostic close must not obscure the original fact.
      }
    }
  }

  if (observedDatabase) return { kind: "not_observed", provider: "opencode" };
  return unavailable(issues.join(" | ") || "opencode_database_unreadable");
}

function inspectConductor(input) {
  const dbPaths = normalizedDatabasePaths(input?.dbPaths);
  if (!dbPaths.length) return unavailable("opencode_database_not_found");
  const issues = [];
  let observedDatabase = false;
  for (const dbPath of dbPaths) {
    if (!fs.existsSync(dbPath)) continue;
    let db;
    try {
      db = openReadonlyDatabase(dbPath);
      if (!supportsOpenCodeDispatchSchema(db)) {
        issues.push(`${dbPath}:opencode_schema_unsupported`);
        continue;
      }
      observedDatabase = true;
      const binding = findConductorBinding(db, input);
      if (!binding) continue;
      const receipt = {
        provider: "opencode",
        databaseSourceId: dbPath,
        providerSessionId: binding.providerSessionId,
        providerMessageId: binding.providerMessageId,
        dispatchMessageCreatedAt: binding.dispatchMessageCreatedAt,
      };
      // A Conductor has many native turns in one OpenCode Session.  Bind the
      // result to its latest durable Conductor input and stop at the next one;
      // never treat an older decision as the response to a newer wakeup.
      const completed = findCompletedAnswer(db, binding, { boundaryMarker: CONDUCTOR_INPUT_MARKER });
      if (completed?.failureReason) return { kind: "failed", receipt, failure: completed };
      if (completed) return { kind: "result", receipt, result: completed };
      const failure = findTerminalFailure(db, binding, { boundaryMarker: CONDUCTOR_INPUT_MARKER });
      if (failure) return { kind: "failed", receipt, failure };
      const attention = findPendingQuestion(db, binding, { boundaryMarker: CONDUCTOR_INPUT_MARKER });
      if (attention) return { kind: "attention", receipt, attention };
      return { kind: "running", receipt };
    } catch (error) {
      issues.push(`${dbPath}:${error instanceof Error ? error.message : String(error)}`);
    } finally {
      try { db?.close(); } catch {}
    }
  }
  if (observedDatabase) return { kind: "not_observed", provider: "opencode" };
  return unavailable(issues.join(" | ") || "opencode_database_unreadable");
}

// This is deliberately narrower than inspectConductor().  A Runtime wakeup
// is a durable input command, so recovery must be able to prove that OpenCode
// recorded that exact input without guessing from screen text or from a later
// assistant response.  It does not interpret the response or choose the next
// Conductor action.
function inspectConductorInput(input) {
  const inputId = requiredString(input?.inputId);
  const dbPaths = normalizedDatabasePaths(input?.dbPaths);
  if (!inputId) return unavailable("conductor_input_id_required");
  if (!dbPaths.length) return unavailable("opencode_database_not_found");
  const marker = `[Agent Workspace] Conductor Input ID ${inputId}`;
  const issues = [];
  let observedDatabase = false;
  for (const dbPath of dbPaths) {
    if (!fs.existsSync(dbPath)) continue;
    let db;
    try {
      db = openReadonlyDatabase(dbPath);
      if (!supportsOpenCodeDispatchSchema(db)) {
        issues.push(`${dbPath}:opencode_schema_unsupported`);
        continue;
      }
      observedDatabase = true;
      const receipt = findUserInputReceipt(db, { marker, cwd: input?.cwd, afterMessageCreatedAt: input?.afterMessageCreatedAt });
      if (!receipt) continue;
      return {
        kind: "receipt",
        receipt: {
          provider: "opencode",
          databaseSourceId: dbPath,
          providerSessionId: receipt.providerSessionId,
          providerMessageId: receipt.providerMessageId,
          dispatchMessageCreatedAt: receipt.dispatchMessageCreatedAt,
        },
      };
    } catch (error) {
      issues.push(`${dbPath}:${error instanceof Error ? error.message : String(error)}`);
    } finally {
      try { db?.close(); } catch {}
    }
  }
  if (observedDatabase) return { kind: "not_observed", provider: "opencode" };
  return unavailable(issues.join(" | ") || "opencode_database_unreadable");
}

function inspectDispatchInDatabase(db, input, dbPath) {
  const binding = normalizeBinding(input?.binding);
  const receipt = binding ?? findReceipt(db, input);
  if (!receipt) return { kind: "not_observed", provider: "opencode" };

  const receiptFact = {
    provider: "opencode",
    databaseSourceId: dbPath,
    providerSessionId: receipt.providerSessionId,
    providerMessageId: receipt.providerMessageId,
    dispatchMessageCreatedAt: receipt.dispatchMessageCreatedAt,
  };

  const completed = findCompletedAnswer(db, receipt);
  if (completed?.failureReason) return { kind: "failed", receipt: receiptFact, failure: completed };
  if (completed) return { kind: "result", receipt: receiptFact, result: completed };

  const failure = findTerminalFailure(db, receipt);
  if (failure) return { kind: "failed", receipt: receiptFact, failure };

  const attention = findPendingQuestion(db, receipt);
  if (attention) return { kind: "attention", receipt: receiptFact, attention };

  return { kind: binding ? "running" : "receipt", receipt: receiptFact };
}

function openReadonlyDatabase(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  // This is intentionally redundant with readOnly. It mirrors Orca's scanner
  // invariant: an observer must never be able to mutate a user's provider DB.
  db.exec("PRAGMA query_only = ON");
  return db;
}

function supportsOpenCodeDispatchSchema(db) {
  return hasTable(db, "session") && hasTable(db, "message") && hasTable(db, "part") &&
    hasColumn(db, "message", "id") && hasColumn(db, "message", "session_id") &&
    hasColumn(db, "message", "data") && hasColumn(db, "message", "time_created") &&
    hasColumn(db, "part", "message_id") && hasColumn(db, "part", "data") && hasColumn(db, "part", "time_created");
}

function findReceipt(db, input) {
  const dispatchId = requiredString(input?.dispatchId);
  if (!dispatchId) return undefined;
  return findUserInputReceipt(db, {
    marker: `[Agent Workspace] Dispatch ID ${dispatchId}`,
    cwd: input?.cwd,
    afterMessageCreatedAt: input?.dispatchCreatedAt,
  });
}

function findUserInputReceipt(db, { marker, cwd, afterMessageCreatedAt } = {}) {
  const textMarker = requiredString(marker);
  if (!textMarker) return undefined;
  const after = normalizedTimestamp(afterMessageCreatedAt);
  const directories = directoryCandidates(cwd);
  const directoryClause = buildDirectoryClause(db, directories);
  const sql = `
    SELECT m.session_id AS sessionId,
           m.id AS messageId,
           m.time_created AS messageCreatedAt
      FROM message m
      JOIN part p ON p.message_id = m.id
      JOIN session s ON s.id = m.session_id
     WHERE json_extract(m.data, '$.role') = 'user'
       AND json_extract(p.data, '$.type') = 'text'
       AND instr(coalesce(json_extract(p.data, '$.text'), ''), ?) > 0
       ${after ? "AND m.time_created >= ?" : ""}
       ${directoryClause.sql}
     ORDER BY m.time_created ASC, m.id ASC
     LIMIT 1
  `;
  const params = [textMarker];
  if (after) params.push(after);
  params.push(...directoryClause.params);
  const row = db.prepare(sql).get(...params);
  if (!row?.sessionId || !row?.messageId) return undefined;
  return {
    providerSessionId: String(row.sessionId),
    providerMessageId: String(row.messageId),
    dispatchMessageCreatedAt: Number(row.messageCreatedAt ?? 0),
  };
}

function findConductorBinding(db, input) {
  const taskId = requiredString(input?.taskId);
  if (!taskId) return undefined;
  const providerSessionId = requiredString(input?.providerSessionId);
  if (providerSessionId) {
    const boundStart = findConductorStartInSession(db, { taskId, providerSessionId });
    if (!boundStart) return undefined;
    return findLatestConductorInput(db, boundStart) ?? boundStart;
  }
  const after = normalizedTimestamp(input?.afterMessageCreatedAt);
  const directoryClause = buildDirectoryClause(db, directoryCandidates(input?.cwd));
  const startSql = `
    SELECT m.session_id AS sessionId,
           m.id AS messageId,
           m.time_created AS messageCreatedAt
      FROM message m
      JOIN part p ON p.message_id = m.id
      JOIN session s ON s.id = m.session_id
     WHERE json_extract(m.data, '$.role') = 'user'
       AND json_extract(p.data, '$.type') = 'text'
       AND instr(coalesce(json_extract(p.data, '$.text'), ''), ?) > 0
       AND instr(coalesce(json_extract(p.data, '$.text'), ''), ?) > 0
       ${after ? "AND m.time_created >= ?" : ""}
       ${directoryClause.sql}
     ORDER BY m.time_created ASC, m.id ASC
     LIMIT 1
  `;
  const params = ["Start this Agent Workspace task now.", `Task id: ${taskId}`];
  if (after) params.push(after);
  params.push(...directoryClause.params);
  const row = db.prepare(startSql).get(...params);
  if (!row?.sessionId || !row?.messageId) return undefined;
  const start = {
    providerSessionId: String(row.sessionId),
    providerMessageId: String(row.messageId),
    dispatchMessageCreatedAt: Number(row.messageCreatedAt ?? 0),
  };
  // A Task may receive many Runtime wakeups.  All belong to this already
  // verified Conductor provider session, so select the newest marked input in
  // that session rather than scanning every project session by time.
  return findLatestConductorInput(db, start) ?? start;
}

// A recovered native PTY is a new transport generation, not a new OpenCode
// conversation. If Session Store already knows the Provider Session ID, bind
// the observer to it directly instead of using the PTY's new start timestamp
// to rediscover the original Task-start input.
function findConductorStartInSession(db, { taskId, providerSessionId }) {
  const row = db.prepare(`
    SELECT m.session_id AS sessionId,
           m.id AS messageId,
           m.time_created AS messageCreatedAt
      FROM message m
      JOIN part p ON p.message_id = m.id
     WHERE m.session_id = ?
       AND json_extract(m.data, '$.role') = 'user'
       AND json_extract(p.data, '$.type') = 'text'
       AND instr(coalesce(json_extract(p.data, '$.text'), ''), ?) > 0
       AND instr(coalesce(json_extract(p.data, '$.text'), ''), ?) > 0
     ORDER BY m.time_created ASC, m.id ASC
     LIMIT 1
  `).get(providerSessionId, "Start this Agent Workspace task now.", `Task id: ${taskId}`);
  if (!row?.sessionId || !row?.messageId) return undefined;
  return {
    providerSessionId: String(row.sessionId),
    providerMessageId: String(row.messageId),
    dispatchMessageCreatedAt: Number(row.messageCreatedAt ?? 0),
  };
}

function findLatestConductorInput(db, start) {
  const row = db.prepare(`
    SELECT m.id AS messageId,
           m.time_created AS messageCreatedAt
      FROM message m
      JOIN part p ON p.message_id = m.id
     WHERE m.session_id = ?
       AND json_extract(m.data, '$.role') = 'user'
       AND json_extract(p.data, '$.type') = 'text'
       AND instr(coalesce(json_extract(p.data, '$.text'), ''), ?) > 0
       AND (m.time_created > ? OR (m.time_created = ? AND m.id > ?))
     ORDER BY m.time_created DESC, m.id DESC
     LIMIT 1
  `).get(
    start.providerSessionId,
    CONDUCTOR_INPUT_MARKER,
    start.dispatchMessageCreatedAt,
    start.dispatchMessageCreatedAt,
    start.providerMessageId,
  );
  if (!row?.messageId) return undefined;
  return {
    providerSessionId: start.providerSessionId,
    providerMessageId: String(row.messageId),
    dispatchMessageCreatedAt: Number(row.messageCreatedAt ?? 0),
  };
}

function findCompletedAnswer(db, receipt, options = {}) {
  const boundary = nextInputBoundary(db, receipt, options.boundaryMarker);
  const sql = `
    WITH final_message AS (
      SELECT m.id AS messageId,
             m.time_created AS messageCreatedAt,
             json_extract(m.data, '$.time.completed') AS completedAt,
             sf.id AS stepFinishId,
             sf.time_created AS stepFinishedAt,
             json_extract(sf.data, '$.reason') AS stepFinishReason
        FROM message m
        JOIN part sf ON sf.message_id = m.id
       WHERE m.session_id = ?
         AND json_extract(m.data, '$.role') = 'assistant'
         AND m.time_created >= ?
         AND (? IS NULL OR m.time_created < ?)
         AND json_extract(sf.data, '$.type') = 'step-finish'
         AND json_extract(sf.data, '$.reason') = 'stop'
         AND EXISTS (
           SELECT 1 FROM part p
            WHERE p.message_id = m.id
              AND json_extract(p.data, '$.type') = 'text'
              AND coalesce(json_extract(p.data, '$.ignored'), 0) = 0
              AND length(trim(coalesce(json_extract(p.data, '$.text'), ''))) > 0
         )
       ORDER BY m.time_created ASC, sf.time_created ASC
       LIMIT 1
    )
    SELECT final_message.messageId AS messageId,
           final_message.messageCreatedAt AS messageCreatedAt,
           final_message.completedAt AS completedAt,
           final_message.stepFinishId AS stepFinishId,
           final_message.stepFinishedAt AS stepFinishedAt,
           final_message.stepFinishReason AS stepFinishReason,
           p.id AS partId,
           p.time_created AS partCreatedAt,
           json_extract(p.data, '$.text') AS text
      FROM final_message
      JOIN part p ON p.message_id = final_message.messageId
     WHERE json_extract(p.data, '$.type') = 'text'
       AND coalesce(json_extract(p.data, '$.ignored'), 0) = 0
       AND length(trim(coalesce(json_extract(p.data, '$.text'), ''))) > 0
     ORDER BY p.time_created ASC, p.id ASC
  `;
  const rows = db.prepare(sql).all(
    receipt.providerSessionId,
    receipt.dispatchMessageCreatedAt,
    boundary ?? null,
    boundary ?? null,
  );
  return answerFromRows(rows, receipt);
}

function answerFromRows(rows, receipt) {
  if (!rows.length) return undefined;
  const answerText = rows.map((row) => String(row.text ?? "")).filter((text) => text.trim()).join("\n\n").trim();
  if (!answerText) return undefined;
  if (answerText.length > MAX_ANSWER_CHARS) {
    return {
      providerMessageId: String(rows[0].messageId),
      failureReason: "provider_answer_too_large",
      message: `OpenCode answer exceeded ${MAX_ANSWER_CHARS} characters.`,
    };
  }
  return {
    provider: "opencode",
    providerSessionId: receipt.providerSessionId,
    providerMessageId: String(rows[0].messageId),
    providerStepFinishId: rows[0].stepFinishId ? String(rows[0].stepFinishId) : undefined,
    messageCreatedAt: Number(rows[0].messageCreatedAt ?? 0),
    completedAt: positiveNumber(rows[0].completedAt) ?? positiveNumber(rows[0].stepFinishedAt),
    stepFinishReason: String(rows[0].stepFinishReason ?? "stop"),
    answerText,
    source: "opencode-sqlite-observer",
  };
}

function findLatestCompletedAnswer(db, binding) {
  const sql = `
    WITH final_message AS (
      SELECT m.id AS messageId,
             m.time_created AS messageCreatedAt,
             json_extract(m.data, '$.time.completed') AS completedAt,
             sf.id AS stepFinishId,
             sf.time_created AS stepFinishedAt,
             json_extract(sf.data, '$.reason') AS stepFinishReason
        FROM message m
        JOIN part sf ON sf.message_id = m.id
       WHERE m.session_id = ?
         AND m.time_created >= ?
         AND json_extract(m.data, '$.role') = 'assistant'
         AND json_extract(sf.data, '$.type') = 'step-finish'
         AND json_extract(sf.data, '$.reason') = 'stop'
         AND EXISTS (
           SELECT 1 FROM part p
            WHERE p.message_id = m.id
              AND json_extract(p.data, '$.type') = 'text'
              AND coalesce(json_extract(p.data, '$.ignored'), 0) = 0
              AND length(trim(coalesce(json_extract(p.data, '$.text'), ''))) > 0
         )
       ORDER BY m.time_created DESC, sf.time_created DESC
       LIMIT 1
    )
    SELECT final_message.messageId AS messageId,
           final_message.messageCreatedAt AS messageCreatedAt,
           final_message.completedAt AS completedAt,
           final_message.stepFinishId AS stepFinishId,
           final_message.stepFinishedAt AS stepFinishedAt,
           final_message.stepFinishReason AS stepFinishReason,
           p.id AS partId,
           p.time_created AS partCreatedAt,
           json_extract(p.data, '$.text') AS text
      FROM final_message
      JOIN part p ON p.message_id = final_message.messageId
     WHERE json_extract(p.data, '$.type') = 'text'
       AND coalesce(json_extract(p.data, '$.ignored'), 0) = 0
       AND length(trim(coalesce(json_extract(p.data, '$.text'), ''))) > 0
     ORDER BY p.time_created ASC, p.id ASC
  `;
  return answerFromRows(db.prepare(sql).all(binding.providerSessionId, binding.dispatchMessageCreatedAt), binding);
}

function findTerminalFailure(db, receipt, options = {}) {
  const boundary = nextInputBoundary(db, receipt, options.boundaryMarker);
  const sql = `
    SELECT m.id AS messageId,
           m.time_created AS messageCreatedAt,
           sf.id AS stepFinishId,
           sf.time_created AS stepFinishedAt,
           json_extract(sf.data, '$.reason') AS stepFinishReason
      FROM message m
      JOIN part sf ON sf.message_id = m.id
     WHERE m.session_id = ?
       AND json_extract(m.data, '$.role') = 'assistant'
       AND m.time_created >= ?
       AND (? IS NULL OR m.time_created < ?)
       AND json_extract(sf.data, '$.type') = 'step-finish'
     ORDER BY m.time_created DESC, sf.time_created DESC
     LIMIT 8
  `;
  const rows = db.prepare(sql).all(
    receipt.providerSessionId,
    receipt.dispatchMessageCreatedAt,
    boundary ?? null,
    boundary ?? null,
  );
  const row = rows.find((item) => TERMINAL_FAILURE_REASONS.has(String(item.stepFinishReason ?? "").toLowerCase()));
  if (!row) return undefined;
  return {
    provider: "opencode",
    providerSessionId: receipt.providerSessionId,
    providerMessageId: String(row.messageId),
    providerStepFinishId: row.stepFinishId ? String(row.stepFinishId) : undefined,
    completedAt: positiveNumber(row.stepFinishedAt) ?? positiveNumber(row.messageCreatedAt),
    stepFinishReason: String(row.stepFinishReason ?? "failed"),
    reason: "provider_terminal_failure",
    message: `OpenCode ended this dispatch with ${String(row.stepFinishReason ?? "an error")}.`,
  };
}

function findLatestTerminalFailure(db, binding) {
  return findTerminalFailure(db, { ...binding, noDispatchBoundary: true });
}

function findPendingQuestion(db, receipt, options = {}) {
  const boundary = nextInputBoundary(db, receipt, options.boundaryMarker);
  const sql = `
    SELECT m.id AS messageId,
           m.time_created AS messageCreatedAt,
           q.id AS questionPartId,
           q.time_created AS questionPartCreatedAt,
           json_extract(q.data, '$.state.input.questions[0].question') AS questionText,
           json_extract(q.data, '$.state.input.questions[0].header') AS questionHeader
      FROM message m
      JOIN part q ON q.message_id = m.id
     WHERE m.session_id = ?
       AND json_extract(m.data, '$.role') = 'assistant'
       AND m.time_created >= ?
       AND (? IS NULL OR m.time_created < ?)
       AND json_extract(q.data, '$.type') = 'tool'
       AND json_extract(q.data, '$.tool') = 'question'
       AND json_extract(q.data, '$.state.status') = 'running'
     ORDER BY m.time_created DESC, q.time_created DESC
     LIMIT 1
  `;
  const row = db.prepare(sql).get(
    receipt.providerSessionId,
    receipt.dispatchMessageCreatedAt,
    boundary ?? null,
    boundary ?? null,
  );
  if (!row?.messageId) return undefined;
  const questionText = String(row.questionText ?? "").trim();
  const questionHeader = String(row.questionHeader ?? "").trim();
  if (!questionText && !questionHeader) return undefined;
  return {
    provider: "opencode",
    providerSessionId: receipt.providerSessionId,
    providerMessageId: String(row.messageId),
    providerQuestionPartId: row.questionPartId ? String(row.questionPartId) : undefined,
    completedAt: positiveNumber(row.questionPartCreatedAt) ?? positiveNumber(row.messageCreatedAt),
    questionText,
    questionHeader: questionHeader || undefined,
    source: "opencode-sqlite-observer",
  };
}

function findLatestPendingQuestion(db, binding) {
  return findPendingQuestion(db, { ...binding, noDispatchBoundary: true });
}

function nextInputBoundary(db, receipt, marker = DISPATCH_MARKER) {
  if (receipt?.noDispatchBoundary) return undefined;
  const row = db.prepare(`
    SELECT MIN(m.time_created) AS nextAssignmentAt
      FROM message m
      JOIN part p ON p.message_id = m.id
     WHERE m.session_id = ?
       AND json_extract(m.data, '$.role') = 'user'
       AND json_extract(p.data, '$.type') = 'text'
       AND instr(coalesce(json_extract(p.data, '$.text'), ''), ?) > 0
       AND (m.time_created > ? OR (m.time_created = ? AND m.id > ?))
  `).get(marker, receipt.providerSessionId, receipt.dispatchMessageCreatedAt, receipt.dispatchMessageCreatedAt, receipt.providerMessageId);
  return positiveNumber(row?.nextAssignmentAt);
}

function buildDirectoryClause(db, directories) {
  if (!directories.length) return { sql: "", params: [] };
  const fields = [];
  if (hasColumn(db, "session", "directory")) fields.push("s.directory");
  if (hasColumn(db, "session", "path")) fields.push("s.path");
  if (!fields.length) return { sql: "", params: [] };
  const placeholders = directories.map(() => "?").join(", ");
  return { sql: `AND (${fields.map((field) => `${field} IN (${placeholders})`).join(" OR ")})`, params: fields.flatMap(() => directories) };
}

function normalizeBinding(binding) {
  const providerSessionId = requiredString(binding?.providerSessionId);
  const providerMessageId = requiredString(binding?.providerMessageId);
  const dispatchMessageCreatedAt = positiveNumber(binding?.dispatchMessageCreatedAt);
  if (!providerSessionId || !providerMessageId || !dispatchMessageCreatedAt) return undefined;
  return { providerSessionId, providerMessageId, dispatchMessageCreatedAt };
}

function normalizedDatabasePaths(paths) {
  return [...new Set((Array.isArray(paths) ? paths : []).map((value) => String(value ?? "").trim()).filter(Boolean).map((value) => path.resolve(value)))];
}

function directoryCandidates(cwd) {
  const raw = requiredString(cwd);
  if (!raw) return [];
  const candidates = new Set([raw, path.resolve(raw)]);
  try {
    candidates.add(fs.realpathSync.native?.(raw) ?? fs.realpathSync(raw));
  } catch {
    // An ended Task may have a disappeared worktree. Keep the recorded path.
  }
  return [...candidates].filter(Boolean);
}

function hasTable(db, tableName) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1").get(tableName));
}

function hasColumn(db, tableName, columnName) {
  if (!hasTable(db, tableName)) return false;
  return db.prepare(`PRAGMA table_info(${quoteIdentifier(tableName)})`).all().some((column) => column.name === columnName);
}

function quoteIdentifier(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function unavailable(reason) {
  return { kind: "observation_unavailable", provider: "opencode", reason: String(reason || "opencode_database_unavailable") };
}

function requiredString(value) {
  const text = String(value ?? "").trim();
  return text || undefined;
}

function positiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : undefined;
}

function normalizedTimestamp(value) {
  const numeric = positiveNumber(value);
  if (numeric) return numeric;
  const parsed = Date.parse(String(value ?? ""));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);

function defaultOpencodeDbPath() {
  return process.env.OPENCODE_DB_PATH || path.join(os.homedir(), ".local", "share", "opencode", "opencode.db");
}

async function sqliteJsonQuery(sql, { dbPath = defaultOpencodeDbPath(), sqlitePath = "sqlite3" } = {}) {
  const { stdout } = await execFileAsync(sqlitePath, ["-json", dbPath, sql], {
    maxBuffer: 20 * 1024 * 1024,
  });
  const text = stdout.trim();
  return text ? JSON.parse(text) : [];
}

async function findProviderSessionForDispatch({
  dispatchId,
  cwd,
  dispatchCreatedAt,
  query = sqliteJsonQuery,
  dbPath,
  sqlitePath,
}) {
  const dispatch = String(dispatchId ?? "").trim();
  if (!dispatch) return undefined;
  const assignmentMarker = `[Agent Workspace] Dispatch ID ${dispatch}`;
  const dispatchCreatedAtMs = normalizeOptionalTimestamp(dispatchCreatedAt);

  const cwdClause = cwd ? providerDirectoryClause(cwd) : "";
  const createdAtClause = dispatchCreatedAtMs ? `and m.time_created >= ${sqlNumber(dispatchCreatedAtMs)}` : "";
  const sql = `
    select
      m.session_id as sessionId,
      m.id as dispatchMessageId,
      m.time_created as dispatchMessageCreatedAt
    from message m
    join part p on p.message_id = m.id
    join session s on s.id = m.session_id
    where json_extract(m.data, '$.role') = 'user'
      and json_extract(p.data, '$.type') = 'text'
      and instr(coalesce(json_extract(p.data, '$.text'), ''), ${sqlString(assignmentMarker)}) > 0
      ${cwdClause}
      ${createdAtClause}
    order by m.time_created desc
    limit 1
  `;
  const rows = await query(sql, { dbPath, sqlitePath });
  const row = rows[0];
  if (!row?.sessionId) return undefined;
  return {
    providerSessionId: String(row.sessionId),
    providerMessageId: row.dispatchMessageId ? String(row.dispatchMessageId) : undefined,
    dispatchMessageCreatedAt: Number(row.dispatchMessageCreatedAt ?? 0),
  };
}

/**
 * Dispatch-bounded Provider observation. This is structured OpenCode storage
 * only: no terminal prose and no retry/route decision leaks into the adapter.
 */
async function inspectDispatchProviderState({
  dispatchId,
  cwd,
  dispatchCreatedAt,
  query = sqliteJsonQuery,
  dbPath,
  sqlitePath,
}) {
  const receipt = await findProviderSessionForDispatch({ dispatchId, cwd, dispatchCreatedAt, query, dbPath, sqlitePath });
  if (!receipt) return { state: "not_received", provider: "opencode" };
  const failure = await getDispatchTerminalFailureAfter({
    providerSessionId: receipt.providerSessionId,
    afterMessageCreatedAt: receipt.dispatchMessageCreatedAt,
    query,
    dbPath,
    sqlitePath,
  });
  if (failure) return { state: "terminal_failure", provider: "opencode", receipt, failure };
  return { state: "received", provider: "opencode", receipt };
}

async function getDispatchTerminalFailureAfter({
  providerSessionId,
  afterMessageCreatedAt = 0,
  query = sqliteJsonQuery,
  dbPath,
  sqlitePath,
}) {
  const sessionId = String(providerSessionId ?? "").trim();
  if (!sessionId) return undefined;
  const sql = `
    select
      m.id as messageId,
      m.time_created as messageCreatedAt,
      sf.id as stepFinishId,
      sf.time_created as stepFinishedAt,
      json_extract(sf.data, '$.reason') as stepFinishReason
    from message m
    join part sf on sf.message_id = m.id
    where m.session_id = ${sqlString(sessionId)}
      and json_extract(m.data, '$.role') = 'assistant'
      and m.time_created >= ${sqlNumber(afterMessageCreatedAt)}
      and json_extract(sf.data, '$.type') = 'step-finish'
      and lower(coalesce(json_extract(sf.data, '$.reason'), '')) in ('error', 'failed', 'abort', 'aborted', 'cancelled', 'canceled')
    order by m.time_created desc, sf.time_created desc
    limit 1
  `;
  const row = (await query(sql, { dbPath, sqlitePath }))[0];
  if (!row?.messageId) return undefined;
  return {
    providerMessageId: String(row.messageId),
    providerStepFinishId: row.stepFinishId ? String(row.stepFinishId) : undefined,
    stepFinishReason: row.stepFinishReason ? String(row.stepFinishReason) : "failed",
    completedAt: normalizeOptionalNumber(row.stepFinishedAt) ?? normalizeOptionalNumber(row.messageCreatedAt),
  };
}

async function findProviderSessionForConductorTask({
  cwd,
  taskId,
  query = sqliteJsonQuery,
  dbPath,
  sqlitePath,
}) {
  const directory = String(cwd ?? "").trim();
  const task = String(taskId ?? "").trim();
  if (!directory || !task) return undefined;
  const startMarker = "Start this Agent Workspace task now.";
  const taskMarker = `Task id: ${task}`;
  const sql = `
    select
      m.session_id as sessionId,
      m.time_created as taskMessageCreatedAt
    from message m
    join part p on p.message_id = m.id
    join session s on s.id = m.session_id
    where 1 = 1
      ${providerDirectoryClause(directory)}
      and json_extract(m.data, '$.role') = 'user'
      and json_extract(p.data, '$.type') = 'text'
      and instr(coalesce(json_extract(p.data, '$.text'), ''), ${sqlString(startMarker)}) > 0
      and instr(coalesce(json_extract(p.data, '$.text'), ''), ${sqlString(taskMarker)}) > 0
    order by m.time_created desc
    limit 1
  `;
  const rows = await query(sql, { dbPath, sqlitePath });
  const row = rows[0];
  if (!row?.sessionId) return undefined;
  return {
    providerSessionId: String(row.sessionId),
    taskMessageCreatedAt: Number(row.taskMessageCreatedAt ?? 0),
  };
}

async function getLastEffectiveAssistantAnswer({
  providerSessionId,
  afterMessageCreatedAt = 0,
  query = sqliteJsonQuery,
  dbPath,
  sqlitePath,
}) {
  const sessionId = String(providerSessionId ?? "").trim();
  if (!sessionId) return undefined;

  const sql = `
    with latest_message as (
      select
        m.id as messageId,
        m.time_created as messageCreatedAt,
        json_extract(m.data, '$.time.completed') as completedAt,
        sf.id as stepFinishId,
        sf.time_created as stepFinishedAt,
        json_extract(sf.data, '$.reason') as stepFinishReason
      from message m
      join part sf on sf.message_id = m.id
      where m.session_id = ${sqlString(sessionId)}
        and json_extract(m.data, '$.role') = 'assistant'
        and m.time_created >= ${sqlNumber(afterMessageCreatedAt)}
        and json_extract(sf.data, '$.type') = 'step-finish'
        and json_extract(sf.data, '$.reason') = 'stop'
        and exists (
          select 1
          from part p
          where p.message_id = m.id
            and json_extract(p.data, '$.type') = 'text'
            and coalesce(json_extract(p.data, '$.ignored'), 0) = 0
            and length(trim(coalesce(json_extract(p.data, '$.text'), ''))) > 0
        )
      order by m.time_created desc, sf.time_created desc
      limit 1
    )
    select
      latest_message.messageId as messageId,
      latest_message.messageCreatedAt as messageCreatedAt,
      latest_message.completedAt as completedAt,
      latest_message.stepFinishId as stepFinishId,
      latest_message.stepFinishedAt as stepFinishedAt,
      latest_message.stepFinishReason as stepFinishReason,
      p.id as partId,
      p.time_created as partCreatedAt,
      json_extract(p.data, '$.text') as text
    from latest_message
    join part p on p.message_id = latest_message.messageId
    where json_extract(p.data, '$.type') = 'text'
      and coalesce(json_extract(p.data, '$.ignored'), 0) = 0
      and length(trim(coalesce(json_extract(p.data, '$.text'), ''))) > 0
    order by p.time_created asc, p.id asc
  `;
  const rows = await query(sql, { dbPath, sqlitePath });
  if (!rows.length) return undefined;

  const answerText = rows
    .map((row) => String(row.text ?? ""))
    .filter((text) => text.trim().length > 0)
    .join("\n\n")
    .trim();
  if (!answerText) return undefined;

  return {
    provider: "opencode",
    providerSessionId: sessionId,
    messageId: String(rows[0].messageId),
    messageCreatedAt: Number(rows[0].messageCreatedAt ?? 0),
    completedAt: normalizeOptionalNumber(rows[0].completedAt) ?? normalizeOptionalNumber(rows[0].stepFinishedAt),
    stepFinishId: rows[0].stepFinishId ? String(rows[0].stepFinishId) : undefined,
    stepFinishedAt: normalizeOptionalNumber(rows[0].stepFinishedAt),
    stepFinishReason: rows[0].stepFinishReason ? String(rows[0].stepFinishReason) : undefined,
    answerText,
    source: "opencode-message-parts",
  };
}

async function getLastEffectiveAssistantAnswerForDirectory({
  cwd,
  afterMessageCreatedAt = 0,
  query = sqliteJsonQuery,
  dbPath,
  sqlitePath,
}) {
  const directory = String(cwd ?? "").trim();
  if (!directory) return undefined;
  const afterTimestamp = normalizeOptionalTimestamp(afterMessageCreatedAt) ?? 0;

  const sql = `
    with latest_message as (
      select
        m.session_id as sessionId,
        m.id as messageId,
        m.time_created as messageCreatedAt,
        json_extract(m.data, '$.time.completed') as completedAt,
        sf.id as stepFinishId,
        sf.time_created as stepFinishedAt,
        json_extract(sf.data, '$.reason') as stepFinishReason
      from message m
      join session s on s.id = m.session_id
      join part sf on sf.message_id = m.id
      where 1 = 1
        ${providerDirectoryClause(directory)}
        and json_extract(m.data, '$.role') = 'assistant'
        and m.time_created >= ${sqlNumber(afterTimestamp)}
        and json_extract(sf.data, '$.type') = 'step-finish'
        and json_extract(sf.data, '$.reason') = 'stop'
        and exists (
          select 1
          from part p
          where p.message_id = m.id
            and json_extract(p.data, '$.type') = 'text'
            and coalesce(json_extract(p.data, '$.ignored'), 0) = 0
            and length(trim(coalesce(json_extract(p.data, '$.text'), ''))) > 0
        )
      order by m.time_created desc, sf.time_created desc
      limit 1
    )
    select
      latest_message.sessionId as sessionId,
      latest_message.messageId as messageId,
      latest_message.messageCreatedAt as messageCreatedAt,
      latest_message.completedAt as completedAt,
      latest_message.stepFinishId as stepFinishId,
      latest_message.stepFinishedAt as stepFinishedAt,
      latest_message.stepFinishReason as stepFinishReason,
      p.id as partId,
      p.time_created as partCreatedAt,
      json_extract(p.data, '$.text') as text
    from latest_message
    join part p on p.message_id = latest_message.messageId
    where json_extract(p.data, '$.type') = 'text'
      and coalesce(json_extract(p.data, '$.ignored'), 0) = 0
      and length(trim(coalesce(json_extract(p.data, '$.text'), ''))) > 0
    order by p.time_created asc, p.id asc
  `;
  const rows = await query(sql, { dbPath, sqlitePath });
  if (!rows.length) return undefined;

  const answerText = rows
    .map((row) => String(row.text ?? ""))
    .filter((text) => text.trim().length > 0)
    .join("\n\n")
    .trim();
  if (!answerText) return undefined;

  return {
    provider: "opencode",
    providerSessionId: String(rows[0].sessionId),
    messageId: String(rows[0].messageId),
    messageCreatedAt: Number(rows[0].messageCreatedAt ?? 0),
    completedAt: normalizeOptionalNumber(rows[0].completedAt) ?? normalizeOptionalNumber(rows[0].stepFinishedAt),
    stepFinishId: rows[0].stepFinishId ? String(rows[0].stepFinishId) : undefined,
    stepFinishedAt: normalizeOptionalNumber(rows[0].stepFinishedAt),
    stepFinishReason: rows[0].stepFinishReason ? String(rows[0].stepFinishReason) : undefined,
    answerText,
    source: "opencode-message-parts",
  };
}

async function getLastPendingQuestionForDirectory({
  cwd,
  afterMessageCreatedAt = 0,
  query = sqliteJsonQuery,
  dbPath,
  sqlitePath,
}) {
  const directory = String(cwd ?? "").trim();
  if (!directory) return undefined;
  const afterTimestamp = normalizeOptionalTimestamp(afterMessageCreatedAt) ?? 0;

  const sql = `
    with latest_question as (
      select
        m.session_id as sessionId,
        m.id as messageId,
        m.time_created as messageCreatedAt,
        q.id as questionPartId,
        q.time_created as questionPartCreatedAt,
        json_extract(q.data, '$.state.input.questions[0].question') as questionText,
        json_extract(q.data, '$.state.input.questions[0].header') as questionHeader
      from message m
      join session s on s.id = m.session_id
      join part q on q.message_id = m.id
      where 1 = 1
        ${providerDirectoryClause(directory)}
        and json_extract(m.data, '$.role') = 'assistant'
        and m.time_created >= ${sqlNumber(afterTimestamp)}
        and json_extract(q.data, '$.type') = 'tool'
        and json_extract(q.data, '$.tool') = 'question'
        and json_extract(q.data, '$.state.status') = 'running'
      order by m.time_created desc, q.time_created desc
      limit 1
    )
    select
      latest_question.sessionId as sessionId,
      latest_question.messageId as messageId,
      latest_question.messageCreatedAt as messageCreatedAt,
      latest_question.questionPartId as questionPartId,
      latest_question.questionPartCreatedAt as questionPartCreatedAt,
      latest_question.questionText as questionText,
      latest_question.questionHeader as questionHeader,
      t.id as textPartId,
      t.time_created as textPartCreatedAt,
      json_extract(t.data, '$.text') as assistantText
    from latest_question
    left join part t on t.message_id = latest_question.messageId
      and json_extract(t.data, '$.type') = 'text'
      and coalesce(json_extract(t.data, '$.ignored'), 0) = 0
      and length(trim(coalesce(json_extract(t.data, '$.text'), ''))) > 0
    order by t.time_created asc, t.id asc
  `;
  const rows = await query(sql, { dbPath, sqlitePath });
  return createPendingQuestionResult(rows);
}

async function getLastPendingQuestionForConductorTask({
  cwd,
  taskId,
  afterMessageCreatedAt = 0,
  query = sqliteJsonQuery,
  dbPath,
  sqlitePath,
}) {
  const directory = String(cwd ?? "").trim();
  const task = String(taskId ?? "").trim();
  if (!directory || !task) return undefined;
  const afterTimestamp = normalizeOptionalTimestamp(afterMessageCreatedAt) ?? 0;
  const startMarker = "Start this Agent Workspace task now.";
  const taskMarker = `Task id: ${task}`;

  const sql = `
    with conductor_session as (
      select m.session_id as sessionId
      from message m
      join session s on s.id = m.session_id
      join part p on p.message_id = m.id
      where 1 = 1
        ${providerDirectoryClause(directory)}
        and json_extract(m.data, '$.role') = 'user'
        and json_extract(p.data, '$.type') = 'text'
        and instr(coalesce(json_extract(p.data, '$.text'), ''), ${sqlString(startMarker)}) > 0
        and instr(coalesce(json_extract(p.data, '$.text'), ''), ${sqlString(taskMarker)}) > 0
      order by m.time_created desc
      limit 1
    ),
    latest_question as (
      select
        m.session_id as sessionId,
        m.id as messageId,
        m.time_created as messageCreatedAt,
        q.id as questionPartId,
        q.time_created as questionPartCreatedAt,
        json_extract(q.data, '$.state.input.questions[0].question') as questionText,
        json_extract(q.data, '$.state.input.questions[0].header') as questionHeader
      from message m
      join conductor_session cs on cs.sessionId = m.session_id
      join part q on q.message_id = m.id
      where json_extract(m.data, '$.role') = 'assistant'
        and m.time_created >= ${sqlNumber(afterTimestamp)}
        and json_extract(q.data, '$.type') = 'tool'
        and json_extract(q.data, '$.tool') = 'question'
        and json_extract(q.data, '$.state.status') = 'running'
      order by m.time_created desc, q.time_created desc
      limit 1
    )
    select
      latest_question.sessionId as sessionId,
      latest_question.messageId as messageId,
      latest_question.messageCreatedAt as messageCreatedAt,
      latest_question.questionPartId as questionPartId,
      latest_question.questionPartCreatedAt as questionPartCreatedAt,
      latest_question.questionText as questionText,
      latest_question.questionHeader as questionHeader,
      t.id as textPartId,
      t.time_created as textPartCreatedAt,
      json_extract(t.data, '$.text') as assistantText
    from latest_question
    left join part t on t.message_id = latest_question.messageId
      and json_extract(t.data, '$.type') = 'text'
      and coalesce(json_extract(t.data, '$.ignored'), 0) = 0
      and length(trim(coalesce(json_extract(t.data, '$.text'), ''))) > 0
    order by t.time_created asc, t.id asc
  `;
  const rows = await query(sql, { dbPath, sqlitePath });
  return createPendingQuestionResult(rows);
}

async function getFirstEffectiveAssistantAnswerAfter({
  providerSessionId,
  afterMessageCreatedAt = 0,
  query = sqliteJsonQuery,
  dbPath,
  sqlitePath,
}) {
  const sessionId = String(providerSessionId ?? "").trim();
  if (!sessionId) return undefined;

  const sql = `
    with next_assignment as (
      select min(m2.time_created) as nextAssignmentAt
      from message m2
      join part p2 on p2.message_id = m2.id
      where m2.session_id = ${sqlString(sessionId)}
        and json_extract(m2.data, '$.role') = 'user'
        and json_extract(p2.data, '$.type') = 'text'
        and instr(coalesce(json_extract(p2.data, '$.text'), ''), '[Agent Workspace] Dispatch ID ') > 0
        and m2.time_created > ${sqlNumber(afterMessageCreatedAt)}
    ),
    first_message as (
      select
        m.id as messageId,
        m.time_created as messageCreatedAt,
        json_extract(m.data, '$.time.completed') as completedAt,
        sf.id as stepFinishId,
        sf.time_created as stepFinishedAt,
        json_extract(sf.data, '$.reason') as stepFinishReason
      from message m
      join part sf on sf.message_id = m.id
      cross join next_assignment
      where m.session_id = ${sqlString(sessionId)}
        and json_extract(m.data, '$.role') = 'assistant'
        and m.time_created > ${sqlNumber(afterMessageCreatedAt)}
        and (next_assignment.nextAssignmentAt is null or m.time_created < next_assignment.nextAssignmentAt)
        and json_extract(sf.data, '$.type') = 'step-finish'
        and json_extract(sf.data, '$.reason') = 'stop'
        and exists (
          select 1
          from part p
          where p.message_id = m.id
            and json_extract(p.data, '$.type') = 'text'
            and coalesce(json_extract(p.data, '$.ignored'), 0) = 0
            and length(trim(coalesce(json_extract(p.data, '$.text'), ''))) > 0
        )
      order by m.time_created asc, sf.time_created asc
      limit 1
    )
    select
      first_message.messageId as messageId,
      first_message.messageCreatedAt as messageCreatedAt,
      first_message.completedAt as completedAt,
      first_message.stepFinishId as stepFinishId,
      first_message.stepFinishedAt as stepFinishedAt,
      first_message.stepFinishReason as stepFinishReason,
      p.id as partId,
      p.time_created as partCreatedAt,
      json_extract(p.data, '$.text') as text
    from first_message
    join part p on p.message_id = first_message.messageId
    where json_extract(p.data, '$.type') = 'text'
      and coalesce(json_extract(p.data, '$.ignored'), 0) = 0
      and length(trim(coalesce(json_extract(p.data, '$.text'), ''))) > 0
    order by p.time_created asc, p.id asc
  `;
  const rows = await query(sql, { dbPath, sqlitePath });
  if (!rows.length) return undefined;

  const answerText = rows
    .map((row) => String(row.text ?? ""))
    .filter((text) => text.trim().length > 0)
    .join("\n\n")
    .trim();
  if (!answerText) return undefined;

  return {
    provider: "opencode",
    providerSessionId: sessionId,
    messageId: String(rows[0].messageId),
    messageCreatedAt: Number(rows[0].messageCreatedAt ?? 0),
    completedAt: normalizeOptionalNumber(rows[0].completedAt) ?? normalizeOptionalNumber(rows[0].stepFinishedAt),
    stepFinishId: rows[0].stepFinishId ? String(rows[0].stepFinishId) : undefined,
    stepFinishedAt: normalizeOptionalNumber(rows[0].stepFinishedAt),
    stepFinishReason: rows[0].stepFinishReason ? String(rows[0].stepFinishReason) : undefined,
    answerText,
    source: "opencode-message-parts",
  };
}

async function getDispatchAssistantAnswer({
  dispatchId,
  cwd,
  dispatchCreatedAt,
  query = sqliteJsonQuery,
  dbPath,
  sqlitePath,
}) {
  const match = await findProviderSessionForDispatch({
    dispatchId,
    cwd,
    dispatchCreatedAt,
    query,
    dbPath,
    sqlitePath,
  });
  if (!match) return undefined;
  const answer = await getFirstEffectiveAssistantAnswerAfter({
    providerSessionId: match.providerSessionId,
    afterMessageCreatedAt: match.dispatchMessageCreatedAt,
    query,
    dbPath,
    sqlitePath,
  });
  if (!answer) return undefined;
  return {
    ...answer,
    dispatchMessageCreatedAt: match.dispatchMessageCreatedAt,
  };
}

function providerDirectoryClause(cwd) {
  const candidates = providerDirectoryCandidates(cwd);
  if (!candidates.length) return "and 1 = 0";
  const values = candidates.map(sqlString).join(", ");
  return `and (s.directory in (${values}) or s.path in (${values}))`;
}

function providerDirectoryCandidates(cwd) {
  const raw = String(cwd ?? "").trim();
  if (!raw) return [];
  const candidates = new Set([raw, path.resolve(raw)]);
  try {
    const realpath = fs.realpathSync.native?.(raw) ?? fs.realpathSync(raw);
    if (realpath) candidates.add(realpath);
  } catch {
    // A project can legitimately disappear after a Provider Session has
    // stopped. Keep the original path match rather than failing inspection.
  }
  return [...candidates];
}

function sqlString(value) {
  return `'${String(value ?? "").replace(/'/g, "''")}'`;
}

function sqlNumber(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "0";
  return String(Math.max(0, Math.floor(numeric)));
}

function normalizeOptionalNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : undefined;
}

function normalizeOptionalTimestamp(value) {
  const numeric = normalizeOptionalNumber(value);
  if (numeric) return numeric;
  const parsed = Date.parse(String(value ?? ""));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function createPendingQuestionResult(rows) {
  if (!rows.length) return undefined;

  const assistantText = rows
    .map((row) => String(row.assistantText ?? ""))
    .filter((text) => text.trim().length > 0)
    .join("\n\n")
    .trim();
  const questionText = String(rows[0].questionText ?? "").trim();
  const questionHeader = String(rows[0].questionHeader ?? "").trim();
  if (!questionText && !assistantText && !questionHeader) return undefined;

  return {
    provider: "opencode",
    providerSessionId: String(rows[0].sessionId),
    messageId: String(rows[0].messageId),
    messageCreatedAt: Number(rows[0].messageCreatedAt ?? 0),
    questionPartId: rows[0].questionPartId ? String(rows[0].questionPartId) : undefined,
    questionPartCreatedAt: normalizeOptionalNumber(rows[0].questionPartCreatedAt),
    questionText,
    questionHeader: questionHeader || undefined,
    answerText: assistantText || questionText || questionHeader,
    source: "opencode-question-tool",
  };
}

module.exports = {
  defaultOpencodeDbPath,
  findProviderSessionForConductorTask,
  findProviderSessionForDispatch,
  inspectDispatchProviderState,
  getDispatchAssistantAnswer,
  getFirstEffectiveAssistantAnswerAfter,
  getLastEffectiveAssistantAnswer,
  getLastEffectiveAssistantAnswerForDirectory,
  getLastPendingQuestionForConductorTask,
  getLastPendingQuestionForDirectory,
  sqliteJsonQuery,
};

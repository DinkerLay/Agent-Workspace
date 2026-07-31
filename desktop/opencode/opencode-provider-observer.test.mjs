import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";

const require = createRequire(import.meta.url);
const { createOpenCodeSqliteReader } = require("./opencode-sqlite-reader.cjs");
const { createOpenCodeProviderObserver } = require("./opencode-provider-observer.cjs");

const isVitest = process.env.VITEST === "true" || process.env.VITEST_WORKER_ID !== undefined;
const testApi = isVitest ? await import("vitest") : await import("node:test");
const { describe, it } = testApi;
const expect = isVitest ? testApi.expect : nodeExpect;

function nodeExpect(actual) {
  return {
    toBe(expected) {
      assert.strictEqual(actual, expected);
    },
    toEqual(expected) {
      assert.deepStrictEqual(actual, expected);
    },
    toMatchObject(expected) {
      assert.partialDeepStrictEqual(actual, expected);
    },
  };
}

describe("OpenCode Provider Observer", () => {
  it("binds an exact dispatch marker and returns only that native Session's completed answer", async () => {
    const fixture = createFixture();
    const dispatchA = "DISPATCH-A";
    const dispatchB = "DISPATCH-B";
    try {
      insertSession(fixture.db, { id: "ses-a", cwd: fixture.cwd });
      insertSession(fixture.db, { id: "ses-b", cwd: fixture.cwd });
      insertDispatch(fixture.db, { sessionId: "ses-a", messageId: "msg-a-dispatch", partId: "part-a-dispatch", dispatchId: dispatchA, createdAt: 100 });
      insertDispatch(fixture.db, { sessionId: "ses-b", messageId: "msg-b-dispatch", partId: "part-b-dispatch", dispatchId: dispatchB, createdAt: 110 });
      insertCompletedAnswer(fixture.db, { sessionId: "ses-a", messageId: "msg-a-answer", textPartId: "part-a-answer", finishPartId: "part-a-finish", text: "# A result\nOnly this result belongs to Dispatch A.", createdAt: 130 });
      insertCompletedAnswer(fixture.db, { sessionId: "ses-b", messageId: "msg-b-answer", textPartId: "part-b-answer", finishPartId: "part-b-finish", text: "# B result\nThis must not leak into Dispatch A.", createdAt: 140 });
      fixture.db.close();

      const reader = createOpenCodeSqliteReader({ databasePaths: [fixture.dbPath] });
      const observer = createOpenCodeProviderObserver({ reader });
      const fact = await observer.observeDispatch({
        dispatch: { dispatchId: dispatchA, createdAt: new Date(90).toISOString() },
        session: { cwd: fixture.cwd },
      });

      expect(fact.kind).toBe("result");
      expect(fact.receipt).toMatchObject({ providerSessionId: "ses-a", providerMessageId: "msg-a-dispatch" });
      expect(fact.result).toMatchObject({ providerSessionId: "ses-a", providerMessageId: "msg-a-answer", answerText: "# A result\nOnly this result belongs to Dispatch A." });
      await observer.close();
    } finally {
      closeFixture(fixture);
    }
  });

  it("reports a native provider terminal failure without inventing a retry", async () => {
    const fixture = createFixture();
    try {
      insertSession(fixture.db, { id: "ses-failure", cwd: fixture.cwd });
      insertDispatch(fixture.db, { sessionId: "ses-failure", messageId: "msg-dispatch", partId: "part-dispatch", dispatchId: "DISPATCH-FAIL", createdAt: 200 });
      insertTerminalFailure(fixture.db, { sessionId: "ses-failure", messageId: "msg-error", finishPartId: "part-error", createdAt: 210, reason: "error" });
      fixture.db.close();

      const reader = createOpenCodeSqliteReader({ databasePaths: [fixture.dbPath] });
      const fact = await reader.inspectDispatch({
        dispatchId: "DISPATCH-FAIL",
        dispatchCreatedAt: 190,
        cwd: fixture.cwd,
      });

      expect(fact.kind).toBe("failed");
      expect(fact.failure).toMatchObject({ reason: "provider_terminal_failure", providerMessageId: "msg-error", stepFinishReason: "error" });
      await reader.close();
    } finally {
      closeFixture(fixture);
    }
  });

  it("keeps an unrecorded transport write as not_observed instead of classifying it as failed", async () => {
    const fixture = createFixture();
    try {
      insertSession(fixture.db, { id: "ses-unrelated", cwd: fixture.cwd });
      fixture.db.close();
      const reader = createOpenCodeSqliteReader({ databasePaths: [fixture.dbPath] });
      const fact = await reader.inspectDispatch({ dispatchId: "MISSING", dispatchCreatedAt: 1, cwd: fixture.cwd });
      expect(fact).toEqual({ kind: "not_observed", provider: "opencode" });
      await reader.close();
    } finally {
      closeFixture(fixture);
    }
  });

  it("reports a native pending question as attention without fabricating a result or failure", async () => {
    const fixture = createFixture();
    try {
      insertSession(fixture.db, { id: "ses-question", cwd: fixture.cwd });
      insertDispatch(fixture.db, { sessionId: "ses-question", messageId: "msg-dispatch", partId: "part-dispatch", dispatchId: "DISPATCH-QUESTION", createdAt: 240 });
      insertPendingQuestion(fixture.db, {
        sessionId: "ses-question",
        messageId: "msg-question",
        partId: "part-question",
        createdAt: 245,
        question: "Allow this network request?",
      });
      fixture.db.close();

      const reader = createOpenCodeSqliteReader({ databasePaths: [fixture.dbPath] });
      const fact = await reader.inspectDispatch({
        dispatchId: "DISPATCH-QUESTION",
        dispatchCreatedAt: 230,
        cwd: fixture.cwd,
      });

      expect(fact.kind).toBe("attention");
      expect(fact.receipt).toMatchObject({ providerSessionId: "ses-question", providerMessageId: "msg-dispatch" });
      expect(fact.attention).toMatchObject({
        providerSessionId: "ses-question",
        providerMessageId: "msg-question",
        providerQuestionPartId: "part-question",
        questionText: "Allow this network request?",
      });
      await reader.close();
    } finally {
      closeFixture(fixture);
    }
  });

  it("observes the Conductor's native answer from its startup marker without terminal scraping", async () => {
    const fixture = createFixture();
    try {
      insertSession(fixture.db, { id: "ses-conductor", cwd: fixture.cwd });
      insertConductorStart(fixture.db, { sessionId: "ses-conductor", messageId: "msg-start", partId: "part-start", taskId: "task-42", createdAt: 300 });
      insertCompletedAnswer(fixture.db, { sessionId: "ses-conductor", messageId: "msg-conductor-answer", textPartId: "part-conductor-answer", finishPartId: "part-conductor-finish", text: "I will dispatch bounded research.", createdAt: 320 });
      fixture.db.close();

      const reader = createOpenCodeSqliteReader({ databasePaths: [fixture.dbPath] });
      const fact = await reader.inspectConductor({ taskId: "task-42", cwd: fixture.cwd, afterMessageCreatedAt: 290 });

      expect(fact.kind).toBe("result");
      expect(fact.receipt).toMatchObject({ providerSessionId: "ses-conductor", providerMessageId: "msg-start" });
      expect(fact.result).toMatchObject({ providerMessageId: "msg-conductor-answer", answerText: "I will dispatch bounded research." });
      await reader.close();
    } finally {
      closeFixture(fixture);
    }
  });

  it("bounds a Conductor result to its newest durable input instead of replaying an older decision", async () => {
    const fixture = createFixture();
    try {
      insertSession(fixture.db, { id: "ses-conductor", cwd: fixture.cwd });
      insertConductorStart(fixture.db, { sessionId: "ses-conductor", messageId: "msg-start", partId: "part-start", taskId: "task-42", createdAt: 300 });
      insertCompletedAnswer(fixture.db, { sessionId: "ses-conductor", messageId: "msg-old-answer", textPartId: "part-old-answer", finishPartId: "part-old-finish", text: "Older initial decision.", createdAt: 320 });
      insertConductorInput(fixture.db, { sessionId: "ses-conductor", messageId: "msg-wakeup", partId: "part-wakeup", inputId: "result:task-42:ABC123", createdAt: 340 });
      insertCompletedAnswer(fixture.db, { sessionId: "ses-conductor", messageId: "msg-new-answer", textPartId: "part-new-answer", finishPartId: "part-new-finish", text: "Decision for the worker result.", createdAt: 360 });
      fixture.db.close();

      const reader = createOpenCodeSqliteReader({ databasePaths: [fixture.dbPath] });
      const fact = await reader.inspectConductor({ taskId: "task-42", cwd: fixture.cwd, afterMessageCreatedAt: 290 });

      expect(fact.kind).toBe("result");
      expect(fact.receipt).toMatchObject({ providerSessionId: "ses-conductor", providerMessageId: "msg-wakeup" });
      expect(fact.result).toMatchObject({ providerMessageId: "msg-new-answer", answerText: "Decision for the worker result." });
      await reader.close();
    } finally {
      closeFixture(fixture);
    }
  });

  it("continues observing a known Provider Session after its native terminal generation restarts", async () => {
    const fixture = createFixture();
    try {
      insertSession(fixture.db, { id: "ses-conductor", cwd: fixture.cwd });
      insertConductorStart(fixture.db, { sessionId: "ses-conductor", messageId: "msg-start", partId: "part-start", taskId: "task-42", createdAt: 300 });
      insertCompletedAnswer(fixture.db, { sessionId: "ses-conductor", messageId: "msg-initial-answer", textPartId: "part-initial-answer", finishPartId: "part-initial-finish", text: "Initial decision.", createdAt: 320 });
      insertConductorInput(fixture.db, { sessionId: "ses-conductor", messageId: "msg-recovered-input", partId: "part-recovered-input", inputId: "user:task-42:continue", createdAt: 340 });
      insertCompletedAnswer(fixture.db, { sessionId: "ses-conductor", messageId: "msg-recovered-answer", textPartId: "part-recovered-answer", finishPartId: "part-recovered-finish", text: "Recovered decision.", createdAt: 360 });
      fixture.db.close();

      const reader = createOpenCodeSqliteReader({ databasePaths: [fixture.dbPath] });
      const fact = await reader.inspectConductor({
        taskId: "task-42",
        cwd: fixture.cwd,
        // This is later than the Task-start input, as it is after a new PTY
        // started to resume the same Provider conversation.
        afterMessageCreatedAt: 1_000,
        providerSessionId: "ses-conductor",
      });

      expect(fact.kind).toBe("result");
      expect(fact.receipt).toMatchObject({ providerSessionId: "ses-conductor", providerMessageId: "msg-recovered-input" });
      expect(fact.result).toMatchObject({ providerMessageId: "msg-recovered-answer", answerText: "Recovered decision." });
      await reader.close();
    } finally {
      closeFixture(fixture);
    }
  });

  it("proves one exact durable Conductor wakeup receipt without inferring it from terminal output", async () => {
    const fixture = createFixture();
    try {
      insertSession(fixture.db, { id: "ses-conductor", cwd: fixture.cwd });
      insertConductorInput(fixture.db, {
        sessionId: "ses-conductor",
        messageId: "msg-wakeup",
        partId: "part-wakeup",
        inputId: "result:task-42:worker:ABC123",
        createdAt: 340,
      });
      fixture.db.close();

      const observer = createOpenCodeProviderObserver({ reader: createOpenCodeSqliteReader({ databasePaths: [fixture.dbPath] }) });
      const fact = await observer.observeConductorInput({
        session: { taskId: "task-42", cwd: fixture.cwd },
        inputId: "result:task-42:worker:ABC123",
      });

      expect(fact.kind).toBe("receipt");
      expect(fact.receipt).toMatchObject({
        providerSessionId: "ses-conductor",
        providerMessageId: "msg-wakeup",
        databaseSourceId: fixture.dbPath,
      });
      await observer.close();
    } finally {
      closeFixture(fixture);
    }
  });
});

function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-workspace-opencode-observer-"));
  const cwd = path.join(root, "project");
  fs.mkdirSync(cwd);
  const dbPath = path.join(root, "opencode.db");
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, path TEXT);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);
    CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, time_created INTEGER, data TEXT);
  `);
  return { root, cwd, dbPath, db };
}

function closeFixture(fixture) {
  try { fixture.db.close(); } catch {}
  fs.rmSync(fixture.root, { recursive: true, force: true });
}

function insertSession(db, { id, cwd }) {
  db.prepare("INSERT INTO session (id, directory, path) VALUES (?, ?, ?)").run(id, cwd, cwd);
}

function insertDispatch(db, { sessionId, messageId, partId, dispatchId, createdAt }) {
  db.prepare("INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)")
    .run(messageId, sessionId, createdAt, JSON.stringify({ role: "user" }));
  db.prepare("INSERT INTO part (id, message_id, time_created, data) VALUES (?, ?, ?, ?)")
    .run(partId, messageId, createdAt, JSON.stringify({ type: "text", text: `[Agent Workspace] Dispatch ID ${dispatchId}\nBounded work.` }));
}

function insertConductorStart(db, { sessionId, messageId, partId, taskId, createdAt }) {
  db.prepare("INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)")
    .run(messageId, sessionId, createdAt, JSON.stringify({ role: "user" }));
  db.prepare("INSERT INTO part (id, message_id, time_created, data) VALUES (?, ?, ?, ?)")
    .run(partId, messageId, createdAt, JSON.stringify({ type: "text", text: `Start this Agent Workspace task now.\nTask id: ${taskId}` }));
}

function insertConductorInput(db, { sessionId, messageId, partId, inputId, createdAt }) {
  db.prepare("INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)")
    .run(messageId, sessionId, createdAt, JSON.stringify({ role: "user" }));
  db.prepare("INSERT INTO part (id, message_id, time_created, data) VALUES (?, ?, ?, ?)")
    .run(partId, messageId, createdAt, JSON.stringify({ type: "text", text: `[Agent Workspace] Conductor Input ID ${inputId}\nRuntime wakeup.` }));
}

function insertCompletedAnswer(db, { sessionId, messageId, textPartId, finishPartId, text, createdAt }) {
  db.prepare("INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)")
    .run(messageId, sessionId, createdAt, JSON.stringify({ role: "assistant", time: { completed: createdAt + 1 } }));
  db.prepare("INSERT INTO part (id, message_id, time_created, data) VALUES (?, ?, ?, ?)")
    .run(textPartId, messageId, createdAt, JSON.stringify({ type: "text", text }));
  db.prepare("INSERT INTO part (id, message_id, time_created, data) VALUES (?, ?, ?, ?)")
    .run(finishPartId, messageId, createdAt + 1, JSON.stringify({ type: "step-finish", reason: "stop" }));
}

function insertTerminalFailure(db, { sessionId, messageId, finishPartId, createdAt, reason }) {
  db.prepare("INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)")
    .run(messageId, sessionId, createdAt, JSON.stringify({ role: "assistant" }));
  db.prepare("INSERT INTO part (id, message_id, time_created, data) VALUES (?, ?, ?, ?)")
    .run(finishPartId, messageId, createdAt, JSON.stringify({ type: "step-finish", reason }));
}

function insertPendingQuestion(db, { sessionId, messageId, partId, createdAt, question }) {
  db.prepare("INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)")
    .run(messageId, sessionId, createdAt, JSON.stringify({ role: "assistant" }));
  db.prepare("INSERT INTO part (id, message_id, time_created, data) VALUES (?, ?, ?, ?)")
    .run(partId, messageId, createdAt, JSON.stringify({
      type: "tool",
      tool: "question",
      state: {
        status: "running",
        input: { questions: [{ question }] },
      },
    }));
}

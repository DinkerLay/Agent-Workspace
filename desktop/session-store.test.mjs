import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSessionStore, stripTerminalControls } from "./session-store.cjs";

const isVitest = process.env.VITEST === "true" || process.env.VITEST_WORKER_ID !== undefined;
const testApi = isVitest ? await import("vitest") : await import("node:test");
const { describe, it } = testApi;
const expect = isVitest ? testApi.expect : nodeExpect;

function nodeExpect(actual) {
  return {
    toBe(expected) {
      assert.strictEqual(actual, expected);
    },
    toContain(expected) {
      assert.ok(actual.includes(expected));
    },
    toEqual(expected) {
      assert.deepStrictEqual(actual, expected);
    },
    toMatchObject(expected) {
      assert.partialDeepStrictEqual(actual, expected);
    },
    toMatch(expected) {
      assert.match(actual, expected);
    },
  };
}

describe("Shell Session Store", () => {
  it("resolves a dynamic project-scoped root from the session cwd and remembers it for reads", () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "agent-workspace-session-store-project-"));
    const projectPath = path.join(parent, "Agent_Test");
    fs.mkdirSync(projectPath, { recursive: true });
    const store = createSessionStore({
      root: ({ cwd }) => path.join(cwd, ".agent-workspace", "runtime"),
    });
    const session = {
      taskId: "task-1",
      sessionId: "task-1-researcher",
      command: "opencode",
      cwd: projectPath,
      provider: "opencode",
      model: "opencode-go/deepseek-v4-flash",
    };

    store.startSession(session);
    store.recordOutput(session, "project-scoped output\n");
    const dispatch = store.recordDispatch({
      taskId: "task-1",
      toSessionId: "task-1-reviewer",
      assignment: "Review project output.",
    });

    const view = store.readSession({ taskId: "task-1", sessionId: "task-1-researcher" });
    const events = store.readEvents({ taskId: "task-1" });
    const reviewerView = store.readSession({ taskId: "task-1", sessionId: "task-1-reviewer" });

    expect(view.cleanTranscriptTail).toBe("");
    expect(events.map((event) => event.type)).toEqual(["session.started", "dispatch.created"]);
    expect(reviewerView.dispatches[0]).toMatchObject({ dispatchId: dispatch.dispatchId, status: "queued" });
    expect(
      fs.existsSync(
        path.join(projectPath, ".agent-workspace", "runtime", "task-1", "sessions", "task-1-researcher", "state.json"),
      ),
    ).toBe(true);
    expect(
      fs.existsSync(
        path.join(projectPath, ".agent-workspace", "runtime", "task-1", "sessions", "task-1-researcher", "transcript.clean.log"),
      ),
    ).toBe(false);
  });

  it("records state without persisting terminal transcript or snapshots", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-workspace-session-store-"));
    const store = createSessionStore({ root });
    const session = {
      taskId: "task-1",
      sessionId: "task-1-researcher",
      command: "opencode",
      cwd: root,
      provider: "opencode",
      model: "opencode-go/deepseek-v4-flash",
    };

    store.startSession(session);
    store.recordOutput(session, "\u001b[31mhello\u001b[0m\n");
    store.recordState(session, "idle", "Prompt visible and output quiet.");

    const view = store.readSession({ taskId: "task-1", sessionId: "task-1-researcher", sinceCursor: 0, maxChars: 1000 });

    expect(view.state).toBe("idle");
    expect(view.cleanTranscriptTail).toBe("");
    expect(view.events.map((event) => event.type)).toEqual(["session.started", "session.idle"]);
    expect(fs.existsSync(path.join(root, "task-1", "sessions", "task-1-researcher", "transcript.raw.log"))).toBe(false);
    expect(fs.existsSync(path.join(root, "task-1", "sessions", "task-1-researcher", "transcript.clean.log"))).toBe(false);
    expect(fs.existsSync(path.join(root, "task-1", "sessions", "task-1-researcher", "snapshots", "latest.txt"))).toBe(false);
  });

  it("does not pre-create unused session jsonl files", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-workspace-session-store-lazy-files-"));
    const store = createSessionStore({ root });
    const session = {
      taskId: "task-1",
      sessionId: "task-1-researcher",
      command: "opencode",
      cwd: root,
      provider: "opencode",
      model: "opencode-go/deepseek-v4-flash",
    };

    store.startSession(session);
    const sessionDir = path.join(root, "task-1", "sessions", "task-1-researcher");

    expect(fs.existsSync(path.join(sessionDir, "events.jsonl"))).toBe(true);
    expect(fs.existsSync(path.join(sessionDir, "state.json"))).toBe(true);
    expect(fs.existsSync(path.join(sessionDir, "dispatches.jsonl"))).toBe(false);
    expect(fs.existsSync(path.join(sessionDir, "results.jsonl"))).toBe(false);
    expect(fs.existsSync(path.join(sessionDir, "permissions.jsonl"))).toBe(false);
    expect(fs.existsSync(path.join(sessionDir, "artifacts.jsonl"))).toBe(false);
  });

  it("records repeated sampled states only when the state changes", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-workspace-session-store-state-dedupe-"));
    const store = createSessionStore({ root });
    const session = {
      taskId: "task-1",
      sessionId: "task-1-reviewer",
      command: "opencode",
      cwd: root,
      provider: "opencode",
    };

    store.startSession(session);
    store.recordState(session, "blocked", "Provider is waiting for input.");
    store.recordState(session, "blocked", "Provider is still waiting for input.");
    store.recordState(session, "blocked", "Provider is still waiting for input.");
    store.recordState(session, "idle", "Prompt visible.");

    const view = store.readSession({ taskId: "task-1", sessionId: "task-1-reviewer" });

    expect(view.events.map((event) => event.type)).toEqual(["session.started", "session.blocked", "session.idle"]);
  });

  it("does not reset session state to running when PTY output arrives", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-workspace-session-store-output-no-state-reset-"));
    const store = createSessionStore({ root });
    const session = {
      taskId: "task-1",
      sessionId: "task-1-reviewer",
      command: "opencode",
      cwd: root,
      provider: "opencode",
    };

    store.startSession(session);
    store.recordState(session, "blocked", "Provider is waiting for input.");
    store.recordOutput(session, "terminal repaint after blocked state");
    store.recordState(session, "blocked", "Provider is still waiting for input.");

    const view = store.readSession({ taskId: "task-1", sessionId: "task-1-reviewer" });

    expect(view.state).toBe("blocked");
    expect(view.events.map((event) => event.type)).toEqual(["session.started", "session.blocked"]);
  });

  it("ignores legacy session.output events and keeps cursors monotonic after compaction gaps", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-workspace-session-store-legacy-output-"));
    const store = createSessionStore({ root });
    const session = {
      taskId: "task-1",
      sessionId: "task-1-researcher",
      command: "opencode",
      cwd: root,
      provider: "opencode",
      model: "opencode-go/deepseek-v4-flash",
    };

    store.startSession(session);
    const taskEventsPath = path.join(root, "task-1", "events.jsonl");
    const sessionEventsPath = path.join(root, "task-1", "sessions", "task-1-researcher", "events.jsonl");
    const legacyOutputEvent = {
      id: "event-200",
      taskId: "task-1",
      sessionId: "task-1-researcher",
      type: "session.output",
      createdAt: "2026-06-30T00:00:00.000Z",
      cursor: 200,
      summary: "legacy PTY chunk",
      data: { chunk: "terminal output should not be read as an event" },
    };
    fs.appendFileSync(taskEventsPath, `${JSON.stringify(legacyOutputEvent)}\n`);
    fs.appendFileSync(sessionEventsPath, `${JSON.stringify(legacyOutputEvent)}\n`);

    store.recordState(session, "idle", "Prompt visible.");

    expect(store.readEvents({ taskId: "task-1" }).map((event) => event.type)).toEqual(["session.started", "session.idle"]);
    const view = store.readSession({ taskId: "task-1", sessionId: "task-1-researcher" });
    expect(view.events.map((event) => event.type)).toEqual(["session.started", "session.idle"]);
    expect(view.cursor).toBe(201);
  });

  it("records dispatches without waiting for worker completion", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-workspace-dispatch-store-"));
    const store = createSessionStore({ root });
    const dispatch = store.recordDispatch({
      taskId: "task-1",
      toSessionId: "task-1-reviewer",
      assignment: "Review the research output.",
      contextRefs: ["docs/research/result.md"],
      expectedOutput: "Review notes",
      priority: "normal",
    });

    const view = store.readSession({ taskId: "task-1", sessionId: "task-1-reviewer" });

    expect(dispatch.status).toBe("queued");
    expect(dispatch.dispatchId).toMatch(/^[A-F0-9]{6}$/);
    expect(dispatch.dispatchKey).toBe(undefined);
    expect(view.dispatches[0]).toMatchObject({
      dispatchId: dispatch.dispatchId,
      toSessionId: "task-1-reviewer",
      status: "queued",
    });
  });

  it("keeps dispatch ids unique across worker sessions within the same task", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-workspace-dispatch-id-unique-"));
    const store = createSessionStore({ root });

    const researcherDispatch = store.recordDispatch({
      taskId: "task-1",
      toSessionId: "task-1-researcher",
      assignment: "Research the claim.",
    });
    const reviewerDispatch = store.recordDispatch({
      taskId: "task-1",
      toSessionId: "task-1-reviewer",
      assignment: "Review the claim.",
    });

    expect(researcherDispatch.dispatchId).toMatch(/^[A-F0-9]{6}$/);
    expect(reviewerDispatch.dispatchId).toMatch(/^[A-F0-9]{6}$/);
    expect(reviewerDispatch.dispatchId === researcherDispatch.dispatchId).toBe(false);
  });

  it("marks dispatches delivered in the session view", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-workspace-dispatch-delivered-"));
    const store = createSessionStore({ root });
    const dispatch = store.recordDispatch({
      taskId: "task-1",
      toSessionId: "task-1-researcher",
      assignment: "Research the claim.",
    });

    store.markDispatchDelivered({
      taskId: "task-1",
      sessionId: "task-1-researcher",
      dispatchId: dispatch.dispatchId,
    });

    const view = store.readSession({ taskId: "task-1", sessionId: "task-1-researcher" });

    expect(view.dispatches[0]).toMatchObject({
      dispatchId: dispatch.dispatchId,
      status: "delivered",
    });
    expect(view.events.map((event) => event.type)).toEqual(["dispatch.created", "dispatch.delivered"]);
  });

  it("marks dispatches failed in the session view", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-workspace-dispatch-failed-"));
    const store = createSessionStore({ root });
    const dispatch = store.recordDispatch({
      taskId: "task-1",
      toSessionId: "task-1-researcher",
      assignment: "Research the claim.",
    });

    store.markDispatchFailed({
      taskId: "task-1",
      sessionId: "task-1-researcher",
      dispatchId: dispatch.dispatchId,
      reason: "target_session_start_failed",
      message: "Target session could not be started.",
    });

    const view = store.readSession({ taskId: "task-1", sessionId: "task-1-researcher" });

    expect(view.dispatches[0]).toMatchObject({
      dispatchId: dispatch.dispatchId,
      status: "failed",
      failureReason: "target_session_start_failed",
      failureMessage: "Target session could not be started.",
    });
    expect(view.events.map((event) => event.type)).toEqual(["dispatch.created", "dispatch.failed"]);
  });

  it("does not expose the legacy result-available marker without provider answer text", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-workspace-dispatch-result-"));
    const store = createSessionStore({ root });
    expect(store.markDispatchResultAvailable).toBe(undefined);
  });

  it("records provider dispatch results separately from terminal transcript evidence", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-workspace-dispatch-provider-result-"));
    const store = createSessionStore({ root });
    const dispatch = store.recordDispatch({
      taskId: "task-1",
      toSessionId: "task-1-researcher",
      assignment: "Research the claim.",
    });
    store.markDispatchDelivered({
      taskId: "task-1",
      sessionId: "task-1-researcher",
      dispatchId: dispatch.dispatchId,
    });

    const result = store.recordDispatchResult({
      taskId: "task-1",
      sessionId: "task-1-researcher",
      dispatchId: dispatch.dispatchId,
      reason: "provider-answer-available",
      cursor: 20,
      provider: "opencode",
      providerSessionId: "ses_worker",
      providerMessageId: "msg_final",
      answerText: "Final provider answer without terminal control output.",
      source: "opencode-message-parts",
    });
    const view = store.readSession({ taskId: "task-1", sessionId: "task-1-researcher" });

    expect(result).toMatchObject({
      status: "result_available",
      dispatchId: dispatch.dispatchId,
      provider: "opencode",
      providerSessionId: "ses_worker",
      providerMessageId: "msg_final",
      answerText: "Final provider answer without terminal control output.",
      source: "opencode-message-parts",
    });
    expect(view.results[0]).toMatchObject({
      resultId: result.resultId,
      dispatchId: dispatch.dispatchId,
      answerText: "Final provider answer without terminal control output.",
    });
    expect(view.messages[0]).toMatchObject({
      resultId: result.resultId,
      dispatchId: dispatch.dispatchId,
      sessionId: "task-1-researcher",
      providerMessageId: "msg_final",
      answerText: "Final provider answer without terminal control output.",
    });
    expect(view.dispatches[0]).toMatchObject({
      dispatchId: dispatch.dispatchId,
      status: "result_available",
      resultId: result.resultId,
      resultSource: "opencode-message-parts",
    });
    expect(view.events.at(-1)).toMatchObject({
      type: "dispatch.result_available",
      data: {
        resultId: result.resultId,
        dispatchId: dispatch.dispatchId,
        providerSessionId: "ses_worker",
        providerMessageId: "msg_final",
      },
    });
    expect(fs.existsSync(path.join(root, "task-1", "sessions", "task-1-researcher", "results.jsonl"))).toBe(true);
    expect(fs.existsSync(path.join(root, "task-1", "messages.jsonl"))).toBe(true);

    const taskState = store.readTaskState({ taskId: "task-1" });
    expect(taskState.messages[0]).toMatchObject({
      dispatchId: dispatch.dispatchId,
      sessionId: "task-1-researcher",
      providerMessageId: "msg_final",
    });
  });

  it("uses dispatchId as the only communication index across dispatches results messages and events", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-workspace-dispatch-id-correlation-"));
    const store = createSessionStore({ root });
    const dispatch = store.recordDispatch({
      taskId: "task-1",
      toSessionId: "task-1-reviewer",
      assignment: "Review the research output.",
    });
    store.markDispatchDelivered({
      taskId: "task-1",
      sessionId: "task-1-reviewer",
      dispatchId: dispatch.dispatchId,
    });

    const firstResult = store.recordDispatchResult({
      taskId: "task-1",
      sessionId: "task-1-reviewer",
      dispatchId: dispatch.dispatchId,
      reason: "provider-turn-completed",
      cursor: 42,
      provider: "opencode",
      providerSessionId: "ses_reviewer",
      providerMessageId: "msg_review_final",
      providerStepFinishId: "prt_review_stop",
      answerText: "Review result from provider message parts.",
      source: "opencode-message-parts",
    });
    const duplicateResult = store.recordDispatchResult({
      taskId: "task-1",
      sessionId: "task-1-reviewer",
      dispatchId: dispatch.dispatchId,
      reason: "provider-turn-completed",
      cursor: 43,
      provider: "opencode",
      providerSessionId: "ses_reviewer",
      providerMessageId: "msg_review_duplicate",
      providerStepFinishId: "prt_review_duplicate",
      answerText: "Duplicate terminal repaint result should not be stored.",
      source: "opencode-message-parts",
    });

    const taskState = store.readTaskState({ taskId: "task-1" });
    const sessionView = store.readSession({ taskId: "task-1", sessionId: "task-1-reviewer" });
    const resultEvents = taskState.events.filter((event) => event.type === "dispatch.result_available");

    expect(dispatch.dispatchId).toMatch(/^[A-F0-9]{6}$/);
    expect(duplicateResult.changed).toBe(false);
    expect(taskState.dispatches.length).toBe(1);
    expect(taskState.dispatches[0]).toMatchObject({
      dispatchId: dispatch.dispatchId,
      status: "result_available",
      resultId: firstResult.resultId,
    });
    expect(taskState.results.length).toBe(1);
    expect(taskState.results[0]).toMatchObject({
      resultId: firstResult.resultId,
      dispatchId: dispatch.dispatchId,
      providerMessageId: "msg_review_final",
    });
    expect(taskState.messages.length).toBe(1);
    expect(taskState.messages[0]).toMatchObject({
      resultId: firstResult.resultId,
      dispatchId: dispatch.dispatchId,
      providerMessageId: "msg_review_final",
    });
    expect(resultEvents.length).toBe(1);
    expect(resultEvents[0]).toMatchObject({
      data: {
        dispatchId: dispatch.dispatchId,
        resultId: firstResult.resultId,
        providerMessageId: "msg_review_final",
      },
    });
    expect(sessionView.dispatches[0].dispatchKey).toBe(undefined);
    expect(sessionView.results[0].workspaceMessageId).toBe(undefined);
    expect(sessionView.results[0].answerHash).toBe(undefined);
    expect(sessionView.messages[0].workspaceMessageId).toBe(undefined);
  });

  it("mirrors session events into a task-level event index", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-workspace-task-events-"));
    const store = createSessionStore({ root });
    const session = {
      taskId: "task-1",
      sessionId: "task-1-researcher",
      command: "opencode",
      cwd: root,
      provider: "opencode",
      model: "opencode-go/deepseek-v4-flash",
    };

    store.startSession(session);
    store.recordState(session, "idle", "Prompt visible.");

    const events = store.readEvents({ taskId: "task-1", sinceCursor: 0 });

    expect(events.map((event) => event.type)).toEqual(["session.started", "session.idle"]);
  });

  it("records user-visible task execution events in the runtime task index and optional session stream", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-workspace-task-execution-event-"));
    const store = createSessionStore({ root });

    const event = store.recordTaskEvent({
      taskId: "task-1",
      sessionId: "task-1-conductor",
      cwd: root,
      type: "user.intervention",
      summary: "User intervention sent to Conductor",
      data: {
        message: "后端纠偏消息",
        source: "task-composer",
      },
    });

    const taskState = store.readTaskState({ taskId: "task-1" });
    const sessionView = store.readSession({ taskId: "task-1", sessionId: "task-1-conductor" });

    expect(event).toMatchObject({
      taskId: "task-1",
      sessionId: "task-1-conductor",
      type: "user.intervention",
      cursor: 1,
      data: {
        message: "后端纠偏消息",
        source: "task-composer",
      },
    });
    expect(taskState.events).toEqual([event]);
    expect(sessionView.events).toEqual([event]);
    expect(fs.existsSync(path.join(root, "task-1", "events.jsonl"))).toBe(true);
    expect(fs.existsSync(path.join(root, "task-1", "sessions", "task-1-conductor", "events.jsonl"))).toBe(true);
  });

  it("removes OpenTUI string control sequences from clean transcript text", () => {
    const noisy = "\u001bP$qm\u001b\\visible\u001b_Gi=31337;name=box\u001b\\\u001b[31mred\u001b[0m\rnext";

    expect(stripTerminalControls(noisy)).toBe("visiblered\nnext");
  });

  it("does not persist split terminal output as session-store transcript evidence", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-workspace-split-controls-"));
    const store = createSessionStore({ root });
    const session = {
      taskId: "task-1",
      sessionId: "task-1-conductor",
      command: "opencode",
      cwd: root,
    };

    store.startSession(session);
    store.recordOutput(session, "\u001b");
    store.recordOutput(session, "[31mhello\u001b");
    store.recordOutput(session, "[0m\n");

    const view = store.readSession({ taskId: "task-1", sessionId: "task-1-conductor" });

    expect(view.cleanTranscriptTail).toBe("");
    expect(view.events.map((event) => event.type)).toEqual(["session.started"]);
  });
});

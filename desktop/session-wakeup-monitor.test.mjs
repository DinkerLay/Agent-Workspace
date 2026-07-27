import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSessionStore } from "./session-store.cjs";
import { createSessionWakeupMonitor } from "./session-wakeup-monitor.cjs";

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
  };
}

describe("Session wakeup monitor", () => {
  it("records completed Conductor provider output as a task timeline message after Conductor PTY output", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-workspace-conductor-message-monitor-"));
    const store = createSessionStore({ root });
    const taskId = "task-1";
    const conductorId = "opencode:project-runtime-current:task-1:task-1-conductor";
    const callbacks = [];
    let readCount = 0;

    store.startSession({ taskId, sessionId: conductorId, command: "opencode", cwd: root });

    const sessions = [{ id: conductorId, taskId, status: "running", provider: "opencode", cwd: root }];
    const ptyManager = {
      onEvent: (callback) => {
        callbacks.push(callback);
        return () => undefined;
      },
      list: () => sessions,
      get: (id) => sessions.find((session) => session.id === id),
      sampleStatus: (id) => ({
        id,
        state: "running",
        summary: "Prompt visible.",
        cursor: 12,
        lastOutputAgeMs: 5,
      }),
      write: () => undefined,
    };

    const monitor = createSessionWakeupMonitor({
      ptyManager,
      sessionStore: store,
      debounceMs: 1,
      conductorMessageQuietThresholdMs: 0,
      conductorMessageReader: ({ session }) => {
        readCount += 1;
        return {
          provider: "opencode",
          providerSessionId: "ses_conductor",
          messageId: "msg_conductor_final",
          stepFinishId: "prt_stop",
          stepFinishReason: "stop",
          completedAt: 5100,
          answerText: `### 最终汇总\n两分支均通过，任务收口。\nSession: ${session.id}`,
          source: "opencode-message-parts",
        };
      },
    });

    monitor.start();
    callbacks[0]?.({ type: "data", id: conductorId, chunk: "screen repaint", cursor: 1 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    callbacks[0]?.({ type: "data", id: conductorId, chunk: "terminal repaint after final answer", cursor: 2 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    monitor.stop();

    const taskView = store.readTaskState({ taskId });
    const conductorMessages = taskView.events.filter((event) => event.type === "conductor.message");

    expect(readCount).toBe(1);
    expect(conductorMessages.length).toBe(1);
    expect(conductorMessages[0]).toMatchObject({
      taskId,
      sessionId: conductorId,
      type: "conductor.message",
      data: {
        providerMessageId: "msg_conductor_final",
        message: `### 最终汇总\n两分支均通过，任务收口。\nSession: ${conductorId}`,
      },
    });
  });

  it("marks a Conductor session as waiting for input when the provider exposes a pending question", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-workspace-conductor-question-monitor-"));
    const store = createSessionStore({ root });
    const taskId = "task-1";
    const conductorId = "opencode:project-runtime-current:task-1:task-1-conductor";

    store.startSession({ taskId, sessionId: conductorId, command: "opencode", cwd: root });

    const sessions = [{ id: conductorId, taskId, status: "running", provider: "opencode", cwd: root }];
    const ptyManager = {
      list: () => sessions,
      get: (id) => sessions.find((session) => session.id === id),
      sampleStatus: (id) => ({
        id,
        state: "running",
        summary: "Prompt visible.",
        cursor: 14,
        lastOutputAgeMs: 5,
      }),
      write: () => undefined,
    };

    const monitor = createSessionWakeupMonitor({
      ptyManager,
      sessionStore: store,
      conductorMessageQuietThresholdMs: 0,
      conductorQuestionReader: () => ({
        provider: "opencode",
        providerSessionId: "ses_conductor",
        messageId: "msg_question",
        questionPartId: "prt_question",
        questionText: "How should we proceed?",
        answerText: "The worker is unavailable. I need your input.",
        source: "opencode-question-tool",
      }),
    });

    const result = await monitor.tick();
    const taskView = store.readTaskState({ taskId });
    const conductorView = store.readSession({ taskId, sessionId: conductorId });

    expect(result.sampled).toBe(1);
    expect(taskView.sessions[0]).toMatchObject({
      sessionId: conductorId,
      state: "waiting_input",
      lastStateSummary: "How should we proceed?",
    });
    expect(conductorView.events.map((event) => event.type)).toContain("session.waiting_input");
  });

  it("checks only the changed worker session after a PTY data event", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-workspace-wakeup-event-driven-"));
    const store = createSessionStore({ root });
    const taskId = "task-1";
    const conductorId = "opencode:project-runtime-current:task-1:task-1-conductor";
    const workerId = "opencode:project-runtime-current:task-1:task-1-researcher";
    const callbacks = [];
    const writes = [];
    let readCount = 0;

    store.startSession({ taskId, sessionId: conductorId, command: "opencode", cwd: root });
    store.startSession({ taskId, sessionId: workerId, command: "opencode", cwd: root });
    const dispatch = store.recordDispatch({ taskId, toSessionId: workerId, assignment: "Research." });
    store.markDispatchDelivered({ taskId, sessionId: workerId, dispatchId: dispatch.dispatchId });

    const sessions = [
      { id: conductorId, taskId, status: "running" },
      { id: workerId, taskId, status: "running", provider: "opencode", cwd: root },
    ];
    const ptyManager = {
      onEvent: (callback) => {
        callbacks.push(callback);
        return () => undefined;
      },
      list: () => sessions,
      get: (id) => sessions.find((session) => session.id === id),
      sampleStatus: (id) => ({
        id,
        state: "running",
        summary: "State sampled.",
        cursor: id === conductorId ? 10 : 20,
        lastOutputAgeMs: id === conductorId ? 6000 : 0,
      }),
      write: (id, text) => {
        writes.push({ id, text });
        return { id, status: "running" };
      },
    };

    const monitor = createSessionWakeupMonitor({
      ptyManager,
      sessionStore: store,
      debounceMs: 1,
      dispatchResultReader: ({ dispatch }) => {
        readCount += 1;
        return {
          provider: "opencode",
          providerSessionId: "ses_worker",
          messageId: "msg_final",
          stepFinishId: "prt_stop",
          stepFinishReason: "stop",
          completedAt: 4100,
          answerText: `Provider answer for ${dispatch.dispatchId}.`,
          source: "opencode-message-parts",
        };
      },
    });

    monitor.start();
    callbacks[0]?.({ type: "data", id: workerId, chunk: "screen repaint", cursor: 1 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    monitor.stop();

    const workerView = store.readSession({ taskId, sessionId: workerId });
    expect(readCount).toBe(1);
    expect(writes.length).toBe(1);
    expect(workerView.dispatches[0]).toMatchObject({
      dispatchId: dispatch.dispatchId,
      status: "result_available",
      providerStepFinishId: "prt_stop",
    });
  });

  it("treats later PTY repaint for a completed dispatch as irrelevant", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-workspace-wakeup-repaint-ignore-"));
    const store = createSessionStore({ root });
    const taskId = "task-1";
    const conductorId = "opencode:project-runtime-current:task-1:task-1-conductor";
    const workerId = "opencode:project-runtime-current:task-1:task-1-researcher";
    const callbacks = [];
    const writes = [];
    let readCount = 0;

    store.startSession({ taskId, sessionId: conductorId, command: "opencode", cwd: root });
    store.startSession({ taskId, sessionId: workerId, command: "opencode", cwd: root });
    const dispatch = store.recordDispatch({ taskId, toSessionId: workerId, assignment: "Research." });
    store.markDispatchDelivered({ taskId, sessionId: workerId, dispatchId: dispatch.dispatchId });

    const sessions = [
      { id: conductorId, taskId, status: "running" },
      { id: workerId, taskId, status: "running", provider: "opencode", cwd: root },
    ];
    const ptyManager = {
      onEvent: (callback) => {
        callbacks.push(callback);
        return () => undefined;
      },
      list: () => sessions,
      get: (id) => sessions.find((session) => session.id === id),
      sampleStatus: (id) => ({
        id,
        state: "running",
        summary: "Prompt visible.",
        cursor: id === conductorId ? 10 : 20 + readCount,
        lastOutputAgeMs: id === conductorId ? 6000 : 0,
      }),
      write: (id, text) => {
        writes.push({ id, text });
        return { id, status: "running" };
      },
    };

    const monitor = createSessionWakeupMonitor({
      ptyManager,
      sessionStore: store,
      debounceMs: 1,
      dispatchResultReader: ({ dispatch }) => {
        readCount += 1;
        return {
          provider: "opencode",
          providerSessionId: "ses_worker",
          messageId: "msg_final",
          stepFinishId: "prt_stop",
          stepFinishReason: "stop",
          completedAt: 4100,
          answerText: `Provider answer for ${dispatch.dispatchId}.`,
          source: "opencode-message-parts",
        };
      },
    });

    monitor.start();
    callbacks[0]?.({ type: "data", id: workerId, chunk: "provider final answer rendered", cursor: 1 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    callbacks[0]?.({ type: "data", id: workerId, chunk: "terminal repaint after final answer", cursor: 2 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    monitor.stop();

    const workerView = store.readSession({ taskId, sessionId: workerId });
    const resultEvents = workerView.events.filter((event) => event.type === "dispatch.result_available");

    expect(readCount).toBe(1);
    expect(writes.length).toBe(1);
    expect(workerView.results.length).toBe(1);
    expect(resultEvents.length).toBe(1);
    expect(workerView.results[0]).toMatchObject({
      dispatchId: dispatch.dispatchId,
      providerMessageId: "msg_final",
    });
  });

  it("records provider worker result and wakes an idle Conductor after dispatch delivery", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-workspace-wakeup-monitor-"));
    const store = createSessionStore({ root });
    const taskId = "task-1";
    const conductorId = "opencode:project-runtime-current:task-1:task-1-conductor";
    const workerId = "opencode:project-runtime-current:task-1:task-1-researcher";
    const writes = [];

    store.startSession({ taskId, sessionId: conductorId, command: "opencode", cwd: root });
    store.startSession({ taskId, sessionId: workerId, command: "opencode", cwd: root });
    const dispatch = store.recordDispatch({ taskId, toSessionId: workerId, assignment: "Research." });
    store.markDispatchDelivered({ taskId, sessionId: workerId, dispatchId: dispatch.dispatchId });

    const ptyManager = {
      list: () => [
        { id: conductorId, taskId, status: "running" },
        { id: workerId, taskId, status: "running" },
      ],
      sampleStatus: (id) => ({
        id,
        state: "running",
        summary: "Prompt visible.",
        cursor: id === conductorId ? 10 : 20,
        lastOutputAgeMs: id === conductorId ? 6000 : 0,
      }),
      write: (id, text) => {
        writes.push({ id, text });
        return { id, status: "running" };
      },
    };

    const longAnswerText = `Provider answer for ${dispatch.dispatchId}.\n${"full-answer-line\n".repeat(1500)}`;

    const monitor = createSessionWakeupMonitor({
      ptyManager,
      sessionStore: store,
      resolveAgentId: ({ sessionId }) => sessionId === workerId ? "researcher" : undefined,
      dispatchResultReader: ({ dispatch }) => ({
        provider: "opencode",
        providerSessionId: "ses_worker",
        messageId: "msg_final",
        completedAt: 4100,
        answerText: longAnswerText,
        source: "opencode-message-parts",
      }),
    });
    const result = await monitor.tick();
    const workerView = store.readSession({ taskId, sessionId: workerId });
    const conductorView = store.readSession({ taskId, sessionId: conductorId });

    expect(result.resultAvailable).toBe(1);
    expect(result.wakeupsSent).toBe(1);
    expect(workerView.dispatches[0]).toMatchObject({
      dispatchId: dispatch.dispatchId,
      status: "result_available",
      resultSource: "opencode-message-parts",
    });
    expect(workerView.results[0]).toMatchObject({
      dispatchId: dispatch.dispatchId,
      answerText: longAnswerText,
      providerSessionId: "ses_worker",
      providerMessageId: "msg_final",
    });
    expect(workerView.events.map((event) => event.type)).toContain("dispatch.result_available");
    expect(conductorView.events.map((event) => event.type)).toContain("conductor.wakeup.sent");
    expect(writes[0]).toMatchObject({ id: conductorId });
    const wakeupText = writes[0].text.replace(/\x1b\[200~/g, "").replace(/\x1b\[201~/g, "").trim();
    expect(wakeupText.startsWith("{")).toBe(false);
    expect(wakeupText).toContain("Runtime wakeup: researcher result available");
    expect(wakeupText).toContain(`Task: ${taskId}`);
    expect(wakeupText).toContain("Agent card: researcher");
    expect(wakeupText).not.toContain(workerId);
    expect(wakeupText).toContain(`Dispatch ID: ${dispatch.dispatchId}`);
    expect(wakeupText).toContain(`Result ID: ${workerView.results[0].resultId}`);
    expect(wakeupText).toContain("The Provider result is stored durably");
    expect(wakeupText).toContain("use read_task_state to inspect the Result ID");
    expect(wakeupText).not.toContain("researcher answer:");
    expect(wakeupText).not.toContain(longAnswerText);
    expect(writes[0].text).not.toContain("Required next step");
    expect(writes[0].text).toContain("read_task_state");
    expect(writes[0].text).not.toContain("resultPreview");
  });

  it("wakes the recorded Conductor session instead of inferring from worker session ids", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-workspace-wakeup-recorded-conductor-"));
    const store = createSessionStore({ root });
    const taskId = "task-1cmooz";
    const conductorId = "opencode:project-bq0l0t:task-1cmooz:task-intake-001-conductor";
    const workerId = "opencode:project-bq0l0t:task-1cmooz:task-intake-001-researcher-micron";
    const wrongInferredConductorId = "opencode:project-bq0l0t:task-1cmooz:task-1cmooz-conductor";
    const writes = [];

    store.startSession({ taskId, sessionId: conductorId, command: "opencode", cwd: root });
    store.startSession({ taskId, sessionId: workerId, command: "opencode", cwd: root });
    const dispatch = store.recordDispatch({
      taskId,
      toSessionId: workerId,
      conductorSessionId: conductorId,
      assignment: "Research Micron.",
    });
    store.markDispatchDelivered({ taskId, sessionId: workerId, dispatchId: dispatch.dispatchId });

    const ptyManager = {
      list: () => [
        { id: conductorId, taskId, status: "running" },
        { id: workerId, taskId, status: "running" },
      ],
      sampleStatus: (id) => ({
        id,
        state: "running",
        summary: "Prompt visible.",
        cursor: id === conductorId ? 10 : 20,
        lastOutputAgeMs: id === conductorId ? 6000 : 0,
      }),
      write: (id, text) => {
        writes.push({ id, text });
        return { id, status: "running" };
      },
    };

    const monitor = createSessionWakeupMonitor({
      ptyManager,
      sessionStore: store,
      dispatchResultReader: ({ dispatch }) => ({
        provider: "opencode",
        providerSessionId: "ses_worker",
        messageId: "msg_final",
        completedAt: 4100,
        answerText: `Provider answer for ${dispatch.dispatchId}.`,
        source: "opencode-message-parts",
      }),
    });
    const result = await monitor.tick();
    const conductorView = store.readSession({ taskId, sessionId: conductorId });

    expect(result.resultAvailable).toBe(1);
    expect(result.wakeupsSent).toBe(1);
    expect(writes[0]).toMatchObject({ id: conductorId });
    expect(writes[0].id).not.toBe(wrongInferredConductorId);
    expect(writes[0].text).toContain(`Dispatch ID: ${dispatch.dispatchId}`);
    expect(conductorView.events.map((event) => event.type)).toContain("conductor.wakeup.sent");
  });

  it("does not mark delivered dispatch complete until provider result text exists", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-workspace-wakeup-no-provider-result-"));
    const store = createSessionStore({ root });
    const taskId = "task-1";
    const conductorId = "opencode:project-runtime-current:task-1:task-1-conductor";
    const workerId = "opencode:project-runtime-current:task-1:task-1-researcher";
    const writes = [];

    store.startSession({ taskId, sessionId: conductorId, command: "opencode", cwd: root });
    store.startSession({ taskId, sessionId: workerId, command: "opencode", cwd: root });
    const dispatch = store.recordDispatch({ taskId, toSessionId: workerId, assignment: "Research." });
    store.markDispatchDelivered({ taskId, sessionId: workerId, dispatchId: dispatch.dispatchId });

    const ptyManager = {
      list: () => [
        { id: conductorId, taskId, status: "running" },
        { id: workerId, taskId, status: "running" },
      ],
      sampleStatus: (id) => ({
        id,
        state: "running",
        summary: "Prompt visible.",
        cursor: id === conductorId ? 10 : 20,
        lastOutputAgeMs: id === conductorId ? 6000 : 0,
      }),
      write: (id, text) => {
        writes.push({ id, text });
        return { id, status: "running" };
      },
    };

    const monitor = createSessionWakeupMonitor({
      ptyManager,
      sessionStore: store,
      dispatchResultReader: () => undefined,
    });
    const result = await monitor.tick();
    const workerView = store.readSession({ taskId, sessionId: workerId });

    expect(result.resultAvailable).toBe(0);
    expect(result.wakeupsSent).toBe(0);
    expect(writes).toEqual([]);
    expect(workerView.dispatches[0]).toMatchObject({
      dispatchId: dispatch.dispatchId,
      status: "delivered",
    });
    expect(workerView.results).toEqual([]);
  });

  it("does not mark delivered dispatch complete until the provider turn is completed", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-workspace-wakeup-provider-incomplete-"));
    const store = createSessionStore({ root });
    const taskId = "task-1";
    const conductorId = "opencode:project-runtime-current:task-1:task-1-conductor";
    const workerId = "opencode:project-runtime-current:task-1:task-1-researcher";
    const writes = [];

    store.startSession({ taskId, sessionId: conductorId, command: "opencode", cwd: root });
    store.startSession({ taskId, sessionId: workerId, command: "opencode", cwd: root });
    const dispatch = store.recordDispatch({ taskId, toSessionId: workerId, assignment: "Research." });
    store.markDispatchDelivered({ taskId, sessionId: workerId, dispatchId: dispatch.dispatchId });

    const ptyManager = {
      list: () => [
        { id: conductorId, taskId, status: "running" },
        { id: workerId, taskId, status: "running" },
      ],
      sampleStatus: (id) => ({
        id,
        state: "running",
        summary: "Prompt visible.",
        cursor: id === conductorId ? 10 : 20,
        lastOutputAgeMs: id === conductorId ? 6000 : 0,
      }),
      write: (id, text) => {
        writes.push({ id, text });
        return { id, status: "running" };
      },
    };

    const monitor = createSessionWakeupMonitor({
      ptyManager,
      sessionStore: store,
      dispatchResultReader: ({ dispatch }) => ({
        provider: "opencode",
        providerSessionId: "ses_worker",
        messageId: "msg_partial",
        answerText: `Visible partial answer for ${dispatch.dispatchId}.`,
        source: "opencode-message-parts",
      }),
    });
    const result = await monitor.tick();
    const workerView = store.readSession({ taskId, sessionId: workerId });

    expect(result.resultAvailable).toBe(0);
    expect(result.wakeupsSent).toBe(0);
    expect(writes).toEqual([]);
    expect(workerView.dispatches[0]).toMatchObject({
      dispatchId: dispatch.dispatchId,
      status: "delivered",
    });
    expect(workerView.results).toEqual([]);
  });


  it("records completed provider result even when worker terminal status is still sampled as running", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-workspace-wakeup-running-provider-complete-"));
    const store = createSessionStore({ root });
    const taskId = "task-1";
    const conductorId = "opencode:project-runtime-current:task-1:task-1-conductor";
    const workerId = "opencode:project-runtime-current:task-1:task-1-researcher";
    const writes = [];

    store.startSession({ taskId, sessionId: conductorId, command: "opencode", cwd: root });
    store.startSession({ taskId, sessionId: workerId, command: "opencode", cwd: root });
    const dispatch = store.recordDispatch({ taskId, toSessionId: workerId, assignment: "Research." });
    store.markDispatchDelivered({ taskId, sessionId: workerId, dispatchId: dispatch.dispatchId });

    const ptyManager = {
      list: () => [
        { id: conductorId, taskId, status: "running" },
        { id: workerId, taskId, status: "running" },
      ],
      sampleStatus: (id) => ({
        id,
        state: "running",
        summary: "TUI output is quiet but prompt was not recognized.",
        cursor: id === conductorId ? 10 : 20,
        lastOutputAgeMs: 6000,
      }),
      write: (id, text) => {
        writes.push({ id, text });
        return { id, status: "running" };
      },
    };

    const monitor = createSessionWakeupMonitor({
      ptyManager,
      sessionStore: store,
      dispatchResultReader: ({ dispatch }) => ({
        provider: "opencode",
        providerSessionId: "ses_worker",
        messageId: "msg_final",
        completedAt: 4100,
        answerText: `Provider answer for ${dispatch.dispatchId}.`,
        source: "opencode-message-parts",
      }),
      quietWakeupThresholdMs: 5000,
    });
    const result = await monitor.tick();
    const workerView = store.readSession({ taskId, sessionId: workerId });
    const conductorView = store.readSession({ taskId, sessionId: conductorId });

    expect(result.resultAvailable).toBe(1);
    expect(result.wakeupsSent).toBe(1);
    expect(workerView.dispatches[0]).toMatchObject({
      dispatchId: dispatch.dispatchId,
      status: "result_available",
      providerMessageId: "msg_final",
    });
    expect(conductorView.events.map((event) => event.type)).toContain("conductor.wakeup.sent");
    expect(writes[0]).toMatchObject({ id: conductorId });
  });

  it("queues Conductor wakeup when Conductor is busy instead of interrupting it", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-workspace-wakeup-queued-"));
    const store = createSessionStore({ root });
    const taskId = "task-1";
    const conductorId = "opencode:project-runtime-current:task-1:task-1-conductor";
    const workerId = "opencode:project-runtime-current:task-1:task-1-reviewer";
    const writes = [];

    store.startSession({ taskId, sessionId: conductorId, command: "opencode", cwd: root });
    store.startSession({ taskId, sessionId: workerId, command: "opencode", cwd: root });
    store.recordState(
      { taskId, sessionId: conductorId },
      "running",
      "Provider reports that Conductor is still in an active turn.",
      {},
    );
    const dispatch = store.recordDispatch({ taskId, toSessionId: workerId, assignment: "Review." });
    store.markDispatchDelivered({ taskId, sessionId: workerId, dispatchId: dispatch.dispatchId });

    const ptyManager = {
      list: () => [
        { id: conductorId, taskId, status: "running" },
        { id: workerId, taskId, status: "running" },
      ],
      sampleStatus: (id) => ({
        id,
        state: "running",
        summary: "State sampled.",
        cursor: 3,
        lastOutputAgeMs: id === conductorId ? 0 : 6000,
      }),
      write: (id, text) => {
        writes.push({ id, text });
        return { id, status: "running" };
      },
    };

    const monitor = createSessionWakeupMonitor({
      ptyManager,
      sessionStore: store,
      dispatchResultReader: ({ dispatch }) => ({
        provider: "opencode",
        providerSessionId: "ses_reviewer",
        messageId: "msg_review",
        completedAt: 5100,
        answerText: `Review result for ${dispatch.dispatchId}.`,
        source: "opencode-message-parts",
      }),
    });
    const result = await monitor.tick();
    const conductorView = store.readSession({ taskId, sessionId: conductorId });

    expect(result.resultAvailable).toBe(1);
    expect(result.wakeupsQueued).toBe(1);
    expect(result.wakeupsSent).toBe(0);
    expect(writes).toEqual([]);
    expect(conductorView.events.map((event) => event.type)).toContain("conductor.wakeup.queued");
  });

  it("delivers a queued worker result after the Provider confirms the busy Conductor ended its turn", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-workspace-wakeup-queued-drain-"));
    const store = createSessionStore({ root });
    const taskId = "task-queued-drain";
    const conductorId = "opencode:project-runtime-current:task-queued-drain:task-queued-drain-conductor";
    const workerId = "opencode:project-runtime-current:task-queued-drain:task-queued-drain-searcher";
    const writes = [];
    let conductorTurnComplete = false;

    store.startSession({ taskId, sessionId: conductorId, command: "opencode", cwd: root });
    store.startSession({ taskId, sessionId: workerId, command: "opencode", cwd: root });
    store.recordState({ taskId, sessionId: conductorId }, "running", "Conductor is deciding.");
    const dispatch = store.recordDispatch({ taskId, toSessionId: workerId, conductorSessionId: conductorId, assignment: "Search the source." });
    store.markDispatchDelivered({ taskId, sessionId: workerId, dispatchId: dispatch.dispatchId });
    const sessions = [
      { id: conductorId, taskId, status: "running", provider: "opencode", cwd: root },
      { id: workerId, taskId, status: "running", provider: "opencode", cwd: root },
    ];
    const monitor = createSessionWakeupMonitor({
      ptyManager: {
        list: () => sessions,
        get: (id) => sessions.find((session) => session.id === id),
        sampleStatus: (id) => ({ id, state: "running", cursor: id === conductorId ? 10 : 20, lastOutputAgeMs: 0 }),
        write: (id, text) => { writes.push({ id, text }); return { id, status: "running" }; },
      },
      sessionStore: store,
      dispatchResultReader: ({ dispatch: observed }) => ({
        provider: "opencode",
        providerSessionId: "ses_searcher",
        messageId: `msg_${observed.dispatchId}`,
        stepFinishReason: "stop",
        completedAt: 7100,
        answerText: `Search result for ${observed.dispatchId}.`,
        source: "opencode-message-parts",
      }),
      conductorMessageReader: () => conductorTurnComplete ? {
        provider: "opencode",
        providerSessionId: "ses_conductor",
        messageId: "msg_conductor_turn_complete",
        stepFinishReason: "stop",
        completedAt: 7200,
        answerText: "Searcher dispatched; waiting for Runtime wakeup.",
        source: "opencode-message-parts",
      } : undefined,
    });

    const queued = await monitor.tick();
    expect(queued.wakeupsQueued).toBe(1);
    expect(writes).toEqual([]);

    conductorTurnComplete = true;
    const delivered = await monitor.tick();
    const conductorView = store.readSession({ taskId, sessionId: conductorId });
    expect(delivered.wakeupsSent).toBe(1);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ id: conductorId });
    expect(writes[0].text).toContain("Searcher result available");
    expect(conductorView.events.map((event) => event.type)).toContain("conductor.wakeup.sent");
  });

  it("wakes Conductor for a native worker question without adding Workspace tools to that worker", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-workspace-worker-question-monitor-"));
    const store = createSessionStore({ root });
    const taskId = "task-1";
    const conductorId = "opencode:project-runtime-current:task-1:task-1-conductor";
    const workerId = "opencode:project-runtime-current:task-1:task-1-researcher";
    const writes = [];

    store.startSession({ taskId, sessionId: conductorId, command: "opencode", cwd: root });
    store.startSession({ taskId, sessionId: workerId, command: "opencode", cwd: root });
    const dispatch = store.recordDispatch({ taskId, toSessionId: workerId, conductorSessionId: conductorId, assignment: "Research." });
    store.markDispatchDelivered({ taskId, sessionId: workerId, dispatchId: dispatch.dispatchId });
    const sessions = [
      { id: conductorId, taskId, status: "running", provider: "opencode", cwd: root },
      { id: workerId, taskId, status: "running", provider: "opencode", cwd: root },
    ];
    const monitor = createSessionWakeupMonitor({
      ptyManager: {
        list: () => sessions,
        sampleStatus: (id) => ({ id, state: "running", cursor: id === conductorId ? 10 : 21, lastOutputAgeMs: id === conductorId ? 6000 : 0 }),
        write: (id, text) => { writes.push({ id, text }); return { id, status: "running" }; },
      },
      sessionStore: store,
      workerQuestionReader: ({ session }) => session.id === workerId ? {
        provider: "opencode",
        providerSessionId: "ses_worker",
        messageId: "msg_worker_question",
        questionPartId: "prt_worker_question",
        questionText: "May I use the network to verify this source?",
        source: "opencode-question-tool",
      } : undefined,
    });

    const result = await monitor.tick();
    const worker = store.readSession({ taskId, sessionId: workerId });
    expect(result.wakeupsSent).toBe(1);
    expect(worker.state).toBe("waiting_input");
    expect(writes[0].id).toBe(conductorId);
    expect(writes[0].text).toContain("Researcher needs input");
    expect(writes[0].text).toContain("May I use the network");
  });

  it("records Provider receipt then terminal failure and wakes Conductor without retrying the worker", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-workspace-provider-failure-monitor-"));
    const store = createSessionStore({ root });
    const taskId = "task-provider-failure";
    const conductorId = "opencode:project-runtime-current:task-provider-failure:task-provider-failure-conductor";
    const workerId = "opencode:project-runtime-current:task-provider-failure:task-provider-failure-researcher";
    const writes = [];

    store.startSession({ taskId, sessionId: conductorId, command: "opencode", cwd: root });
    store.startSession({ taskId, sessionId: workerId, command: "opencode", cwd: root });
    store.recordState({ taskId, sessionId: conductorId }, "waiting_conductor", "Conductor completed its last decision.");
    const dispatch = store.recordDispatch({ taskId, toSessionId: workerId, conductorSessionId: conductorId, assignment: "Research the primary source." });
    store.markDispatchInputAccepted({ taskId, sessionId: workerId, dispatchId: dispatch.dispatchId, transport: "terminal_runtime" });
    const sessions = [
      { id: conductorId, taskId, status: "running", provider: "opencode", cwd: root },
      { id: workerId, taskId, status: "running", provider: "opencode", cwd: root },
    ];
    const monitor = createSessionWakeupMonitor({
      ptyManager: {
        list: () => sessions,
        get: (id) => sessions.find((session) => session.id === id),
        sampleStatus: (id) => ({ id, state: "running", cursor: id === conductorId ? 10 : 23, lastOutputAgeMs: 0 }),
        write: (id, text) => { writes.push({ id, text }); return { id, status: "running" }; },
      },
      sessionStore: store,
      dispatchStateReader: ({ dispatch: observed }) => observed.dispatchId === dispatch.dispatchId ? {
        state: "terminal_failure",
        provider: "opencode",
        receipt: { providerSessionId: "ses_worker", providerMessageId: "msg_dispatch", dispatchMessageCreatedAt: 100 },
        failure: { providerMessageId: "msg_failure", providerStepFinishId: "prt_failure", stepFinishReason: "error" },
      } : undefined,
    });

    const result = await monitor.tick();
    const worker = store.readSession({ taskId, sessionId: workerId });
    const eventTypes = worker.events.map((event) => event.type);
    expect(result.providerFailures).toBe(1);
    expect(result.wakeupsSent).toBe(1);
    expect(worker.dispatches[0]).toMatchObject({ status: "provider_failed", providerSessionId: "ses_worker", providerStepFinishId: "prt_failure" });
    expect(eventTypes).toContain("dispatch.input_accepted");
    expect(eventTypes).toContain("dispatch.provider.received");
    expect(eventTypes).toContain("dispatch.provider.failed");
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ id: conductorId });
    expect(writes[0].text).toContain("Provider failure");
    expect(writes[0].text).toContain("Runtime did not retry this work");
  });
});

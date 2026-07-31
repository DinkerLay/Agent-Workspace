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

  it("records a new Conductor Provider turn after recovery resets the physical PTY cursor", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-workspace-conductor-recovery-cursor-"));
    const store = createSessionStore({ root });
    const taskId = "task-conductor-recovery-cursor";
    const conductorId = "opencode:project-runtime-current:task-conductor-recovery-cursor:conductor";
    let incarnationId = "conductor-incarnation-1";
    let cursor = 240;
    let turn = 1;
    const observedProviderSessionIds = [];

    store.startSession({ taskId, sessionId: conductorId, command: "opencode", cwd: root });
    const session = { id: conductorId, taskId, status: "running", provider: "opencode", cwd: root, get incarnationId() { return incarnationId; } };
    const monitor = createSessionWakeupMonitor({
      ptyManager: {
        list: () => [session],
        get: () => session,
        sampleStatus: () => ({ id: conductorId, state: "running", cursor, lastOutputAgeMs: 0 }),
        write: () => undefined,
      },
      sessionStore: store,
      conductorMessageReader: ({ providerSessionId }) => {
        observedProviderSessionIds.push(providerSessionId);
        return {
        provider: "opencode",
        providerSessionId: "ses_conductor",
        messageId: `msg_conductor_turn_${turn}`,
        stepFinishId: `prt_conductor_turn_${turn}`,
        stepFinishReason: "stop",
        completedAt: 5_000 + turn,
        answerText: `CONDUCTOR_TURN_${turn}`,
        source: "opencode-sqlite-observer",
        };
      },
    });

    await monitor.tick();
    // A replacement PTY belongs to the same logical Session but starts its
    // screen byte cursor from a smaller value. It must still expose its new
    // Provider message instead of being discarded as an old repaint.
    incarnationId = "conductor-incarnation-2";
    cursor = 18;
    turn = 2;
    await monitor.tick();

    const messages = store.readTaskState({ taskId }).events.filter((event) => event.type === "conductor.message");
    expect(messages.map((event) => event.data?.message)).toEqual(["CONDUCTOR_TURN_1", "CONDUCTOR_TURN_2"]);
    expect(observedProviderSessionIds).toEqual([undefined, "ses_conductor"]);
  });

  it("marks a Conductor session as waiting for input when the provider exposes a pending question", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-workspace-conductor-question-monitor-"));
    const store = createSessionStore({ root });
    const taskId = "task-1";
    const conductorId = "opencode:project-runtime-current:task-1:task-1-conductor";

    store.startSession({ taskId, sessionId: conductorId, command: "opencode", cwd: root });

    const sessions = [{ id: conductorId, taskId, status: "running", provider: "opencode", cwd: root, incarnationId: "conductor-question-incarnation" }];
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
      lastStateData: expect.objectContaining({
        providerQuestionPartId: "prt_question",
        terminalIncarnationId: "conductor-question-incarnation",
      }),
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

  it("attributes a legacy session error hook only to the newest outstanding dispatch", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-workspace-provider-hook-error-"));
    const store = createSessionStore({ root });
    const taskId = "task-provider-hook-error";
    const conductorId = "opencode:project-runtime-current:task-provider-hook-error:task-provider-hook-error-conductor";
    const workerId = "opencode:project-runtime-current:task-provider-hook-error:task-provider-hook-error-researcher";
    const writes = [];

    store.startSession({ taskId, sessionId: conductorId, command: "opencode", cwd: root });
    store.startSession({ taskId, sessionId: workerId, command: "opencode", cwd: root });
    store.recordState({ taskId, sessionId: conductorId }, "waiting_conductor", "Conductor completed its last decision.");
    const first = store.recordDispatch({ taskId, toSessionId: workerId, conductorSessionId: conductorId, assignment: "First bounded search." });
    const latest = store.recordDispatch({ taskId, toSessionId: workerId, conductorSessionId: conductorId, assignment: "Second bounded search." });
    store.markDispatchDelivered({ taskId, sessionId: workerId, dispatchId: first.dispatchId });
    store.markDispatchDelivered({ taskId, sessionId: workerId, dispatchId: latest.dispatchId });
    const sessions = [
      { id: conductorId, taskId, status: "running", provider: "opencode", cwd: root },
      { id: workerId, taskId, status: "running", provider: "opencode", cwd: root },
    ];
    const monitor = createSessionWakeupMonitor({
      ptyManager: {
        list: () => sessions,
        get: (id) => sessions.find((session) => session.id === id),
        sampleStatus: (id) => ({ id, state: "running", cursor: id === conductorId ? 10 : 31, lastOutputAgeMs: 0 }),
        write: (id, text) => { writes.push({ id, text }); return { id, status: "running" }; },
      },
      sessionStore: store,
    });

    monitor.handleProviderHookEvent({ sessionId: workerId, kind: "status", payload: { type: "error", error: "provider socket closed" } });
    const result = await monitor.tick();
    const worker = store.readSession({ taskId, sessionId: workerId });

    expect(result.providerFailures).toBe(1);
    expect(worker.dispatches.find((dispatch) => dispatch.dispatchId === first.dispatchId)?.status).toBe("delivered");
    expect(worker.dispatches.find((dispatch) => dispatch.dispatchId === latest.dispatchId)?.status).toBe("provider_failed");
    expect(writes).toHaveLength(1);
    expect(writes[0].text).toContain(latest.dispatchId);
  });

  it("submits a user-selected OpenCode permission reply and waits for the Provider confirmation", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-workspace-provider-hook-permission-"));
    const store = createSessionStore({ root });
    const taskId = "task-provider-hook-permission";
    const workerId = "opencode:project-runtime-current:task-provider-hook-permission:task-provider-hook-permission-researcher";
    const sessions = [{ id: workerId, taskId, status: "running", provider: "opencode", cwd: root }];
    const submissions = [];
    store.startSession({ taskId, sessionId: workerId, command: "opencode", cwd: root });
    const monitor = createSessionWakeupMonitor({
      ptyManager: {
        list: () => sessions,
        get: (id) => sessions.find((session) => session.id === id),
        sampleStatus: () => ({ state: "running", cursor: 1, lastOutputAgeMs: 0 }),
      },
      sessionStore: store,
      submitPermissionReply: async (payload) => { submissions.push(payload); return true; },
    });

    monitor.handleProviderHookEvent({
      sessionId: workerId,
      kind: "permission",
      payload: {
        phase: "asked",
        requestID: "permission-1",
        permission: "bash",
        patterns: ["npm test"],
        replyEndpoint: "http://127.0.0.1:41001/permission/reply",
        replyToken: "private-token",
      },
    });
    let view = store.readSession({ taskId, sessionId: workerId });
    expect(view.permissions).toEqual([expect.objectContaining({ permissionId: "opencode:permission-1", status: "requested", permission: "bash" })]);
    expect(view.events.some((event) => JSON.stringify(event.data).includes("private-token"))).toBe(false);

    const submitted = await monitor.respondPermission({ taskId, sessionId: workerId, permissionId: "opencode:permission-1", response: "always" });
    expect(submitted).toMatchObject({ ok: true, status: "submitted" });
    expect(submissions).toEqual([expect.objectContaining({ requestId: "permission-1", response: "always", token: "private-token" })]);
    view = store.readSession({ taskId, sessionId: workerId });
    expect(view.permissions[0]).toMatchObject({ status: "submitted", response: "always" });

    monitor.handleProviderHookEvent({ sessionId: workerId, kind: "permission", payload: { phase: "replied", requestID: "permission-1", response: "always" } });
    view = store.readSession({ taskId, sessionId: workerId });
    expect(view.permissions[0]).toMatchObject({ status: "approved", response: "always" });
  });

  it("replays a retained Task-page decision onto a restarted Provider's new request id when scope is unchanged", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-workspace-provider-hook-permission-restart-"));
    const store = createSessionStore({ root });
    const taskId = "task-provider-hook-permission-restart";
    const workerId = "opencode:project-runtime-current:task-provider-hook-permission-restart:publisher";
    const sessions = [{ id: workerId, taskId, status: "running", provider: "opencode", cwd: root }];
    store.startSession({ taskId, sessionId: workerId, command: "opencode", cwd: root });
    store.recordPermissionRequested({
      taskId,
      sessionId: workerId,
      cwd: root,
      permissionId: "opencode:permission-restart",
      requestId: "permission-restart",
      provider: "opencode",
      permission: "external_directory",
      patterns: ["/tmp/output"],
      summary: "OpenCode 请求写入输出目录。",
    });
    store.recordPermissionRecoveryPending({ taskId, sessionId: workerId, cwd: root, permissionId: "opencode:permission-restart", response: "once" });
    const submissions = [];
    const restartedMonitor = createSessionWakeupMonitor({
      ptyManager: {
        list: () => sessions,
        get: (id) => sessions.find((session) => session.id === id),
        sampleStatus: () => ({ state: "running", cursor: 1, lastOutputAgeMs: 0 }),
      },
      sessionStore: store,
      submitPermissionReply: async (payload) => { submissions.push(payload); return true; },
    });

    restartedMonitor.handleProviderHookEvent({
      sessionId: workerId,
      kind: "permission",
      payload: {
        phase: "asked",
        requestID: "permission-restart-reissued",
        permission: "external_directory",
        patterns: ["/tmp/output"],
        replyEndpoint: "http://127.0.0.1:41002/permission/reply",
        replyToken: "fresh-private-token",
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(submissions).toEqual([expect.objectContaining({ requestId: "permission-restart-reissued", response: "once", token: "fresh-private-token" })]);
    const view = store.readSession({ taskId, sessionId: workerId });
    expect(view.permissions).toEqual(expect.arrayContaining([
      expect.objectContaining({ permissionId: "opencode:permission-restart", status: "reissued", reissuedByPermissionId: "opencode:permission-restart-reissued" }),
      expect.objectContaining({ permissionId: "opencode:permission-restart-reissued", status: "submitted", response: "once" }),
    ]));
    expect(JSON.stringify(view)).not.toContain("fresh-private-token");
  });

  it("does not replay a retained answer when OpenCode changes the permission scope", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-workspace-provider-hook-permission-changed-scope-"));
    const store = createSessionStore({ root });
    const taskId = "task-provider-hook-permission-changed-scope";
    const workerId = "opencode:project-runtime-current:task-provider-hook-permission-changed-scope:publisher";
    const sessions = [{ id: workerId, taskId, status: "running", provider: "opencode", cwd: root }];
    store.startSession({ taskId, sessionId: workerId, command: "opencode", cwd: root });
    store.recordPermissionRequested({
      taskId, sessionId: workerId, cwd: root,
      permissionId: "opencode:permission-original", requestId: "permission-original",
      provider: "opencode", permission: "external_directory", patterns: ["/tmp/approved"], summary: "Original scope.",
    });
    store.recordPermissionRecoveryPending({ taskId, sessionId: workerId, cwd: root, permissionId: "opencode:permission-original", response: "once" });
    const submissions = [];
    const monitor = createSessionWakeupMonitor({
      ptyManager: { list: () => sessions, get: (id) => sessions.find((session) => session.id === id), sampleStatus: () => ({ state: "running", cursor: 1, lastOutputAgeMs: 0 }) },
      sessionStore: store,
      submitPermissionReply: async (payload) => { submissions.push(payload); return true; },
    });

    monitor.handleProviderHookEvent({
      sessionId: workerId,
      kind: "permission",
      payload: {
        phase: "asked", requestID: "permission-changed-scope", permission: "external_directory", patterns: ["/tmp/new-scope"],
        replyEndpoint: "http://127.0.0.1:41003/permission/reply", replyToken: "fresh-private-token",
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(submissions).toEqual([]);
    const view = store.readSession({ taskId, sessionId: workerId });
    expect(view.permissions).toEqual(expect.arrayContaining([
      expect.objectContaining({ permissionId: "opencode:permission-original", status: "recovery_pending", response: "once" }),
      expect.objectContaining({ permissionId: "opencode:permission-changed-scope", status: "requested" }),
    ]));
  });

  it("keeps an authorization actionable when OpenCode rejects the reply transport without exposing a transport code", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-workspace-provider-hook-permission-rejected-"));
    const store = createSessionStore({ root });
    const taskId = "task-provider-hook-permission-rejected";
    const workerId = "opencode:project-runtime-current:task-provider-hook-permission-rejected:publisher";
    const sessions = [{ id: workerId, taskId, status: "running", provider: "opencode", cwd: root }];
    store.startSession({ taskId, sessionId: workerId, command: "opencode", cwd: root });
    const monitor = createSessionWakeupMonitor({
      ptyManager: { list: () => sessions, get: (id) => sessions.find((session) => session.id === id), sampleStatus: () => ({ state: "running", cursor: 1, lastOutputAgeMs: 0 }) },
      sessionStore: store,
      submitPermissionReply: async () => false,
    });
    monitor.handleProviderHookEvent({
      sessionId: workerId,
      kind: "permission",
      payload: {
        phase: "asked", requestID: "permission-rejected", permission: "external_directory", patterns: ["/tmp/output"],
        replyEndpoint: "http://127.0.0.1:41004/permission/reply", replyToken: "private-token",
      },
    });

    const response = await monitor.respondPermission({ taskId, sessionId: workerId, permissionId: "opencode:permission-rejected", response: "once" });
    expect(response).toMatchObject({ ok: true, status: "reply_failed" });
    const view = store.readSession({ taskId, sessionId: workerId });
    expect(view.permissions[0]).toMatchObject({ status: "reply_failed", response: "once" });
    expect(view.events).toEqual(expect.arrayContaining([expect.objectContaining({ type: "permission.response_retry_required" })]));
    expect(JSON.stringify(view)).not.toContain("permission_reply_rejected");
  });

  it("does not auto-retry a failed permission reply when OpenCode repeats the same request", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-workspace-provider-hook-permission-retry-once-"));
    const store = createSessionStore({ root });
    const taskId = "task-provider-hook-permission-retry-once";
    const workerId = "opencode:project-runtime-current:task-provider-hook-permission-retry-once:publisher";
    const sessions = [{ id: workerId, taskId, status: "running", provider: "opencode", cwd: root }];
    let accepted = false;
    const submissions = [];
    store.startSession({ taskId, sessionId: workerId, command: "opencode", cwd: root });
    const monitor = createSessionWakeupMonitor({
      ptyManager: { list: () => sessions, get: (id) => sessions.find((session) => session.id === id), sampleStatus: () => ({ state: "running", cursor: 1, lastOutputAgeMs: 0 }) },
      sessionStore: store,
      submitPermissionReply: async (payload) => { submissions.push(payload); return accepted; },
    });
    const payload = {
      phase: "asked", requestID: "permission-retry-once", permission: "external_directory", patterns: ["/tmp/output"],
      replyEndpoint: "http://127.0.0.1:41006/permission/reply", replyToken: "private-token",
    };
    monitor.handleProviderHookEvent({ sessionId: workerId, kind: "permission", payload });

    await monitor.respondPermission({ taskId, sessionId: workerId, permissionId: "opencode:permission-retry-once", response: "once" });
    for (let index = 0; index < 6; index += 1) {
      monitor.handleProviderHookEvent({ sessionId: workerId, kind: "permission", payload });
    }
    await new Promise((resolve) => setTimeout(resolve, 0));

    let view = store.readSession({ taskId, sessionId: workerId });
    expect(submissions).toHaveLength(1);
    expect(view.permissions[0]).toMatchObject({ status: "reply_failed", response: "once" });
    expect(view.events.filter((event) => event.type === "permission.response_retry_required")).toHaveLength(1);

    accepted = true;
    const retried = await monitor.respondPermission({ taskId, sessionId: workerId, permissionId: "opencode:permission-retry-once", response: "always" });
    expect(retried).toMatchObject({ ok: true, status: "submitted" });
    expect(submissions).toHaveLength(2);
    expect(submissions[1]).toMatchObject({ requestId: "permission-retry-once", response: "always" });
    view = store.readSession({ taskId, sessionId: workerId });
    expect(view.permissions[0]).toMatchObject({ status: "submitted", response: "always" });
  });

  it("uses the read-only Provider observer as the sole worker result source and forwards no terminal transcript", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-workspace-observer-result-monitor-"));
    const store = createSessionStore({ root });
    const taskId = "task-observer-result";
    const conductorId = "opencode:project-runtime-current:task-observer-result:task-observer-result-conductor";
    const workerId = "opencode:project-runtime-current:task-observer-result:task-observer-result-researcher";
    const writes = [];
    const answerText = "# Source-backed finding\nThe complete native answer belongs to this dispatch.";

    store.startSession({ taskId, sessionId: conductorId, command: "opencode", cwd: root });
    store.startSession({ taskId, sessionId: workerId, command: "opencode", cwd: root });
    store.recordState({ taskId, sessionId: conductorId }, "waiting_conductor", "Conductor completed its last decision.");
    const dispatch = store.recordDispatch({ taskId, toSessionId: workerId, conductorSessionId: conductorId, assignment: "Research one primary source." });
    store.markDispatchInputAccepted({ taskId, sessionId: workerId, dispatchId: dispatch.dispatchId, transport: "terminal_runtime" });
    const sessions = [
      { id: conductorId, taskId, status: "running", provider: "opencode", cwd: root },
      { id: workerId, taskId, status: "running", provider: "opencode", cwd: root },
    ];
    const monitor = createSessionWakeupMonitor({
      ptyManager: {
        list: () => sessions,
        get: (id) => sessions.find((session) => session.id === id),
        sampleStatus: (id) => ({ id, state: "running", cursor: id === conductorId ? 10 : 24, lastOutputAgeMs: 0 }),
        write: (id, text) => { writes.push({ id, text }); return { id, status: "running" }; },
      },
      sessionStore: store,
      providerObserver: {
        observeDispatch: ({ dispatch: observed }) => observed.dispatchId === dispatch.dispatchId ? {
          kind: "result",
          provider: "opencode",
          receipt: { provider: "opencode", providerSessionId: "ses_worker", providerMessageId: "msg_dispatch", dispatchMessageCreatedAt: 100 },
          result: {
            provider: "opencode",
            providerSessionId: "ses_worker",
            providerMessageId: "msg_answer",
            providerStepFinishId: "prt_stop",
            stepFinishReason: "stop",
            completedAt: 200,
            answerText,
            source: "opencode-sqlite-observer",
          },
        } : { kind: "not_observed", provider: "opencode" },
      },
      // If this legacy callback were consulted, the test must fail.  The
      // observer is the production worker fact source.
      dispatchResultReader: () => { throw new Error("legacy result reader must not run"); },
    });

    const result = await monitor.tick();
    const worker = store.readSession({ taskId, sessionId: workerId });
    const storedResult = worker.results[0];

    expect(result.resultAvailable).toBe(1);
    expect(result.wakeupsSent).toBe(1);
    expect(worker.dispatches[0]).toMatchObject({ status: "result_available", providerSessionId: "ses_worker", providerMessageId: "msg_answer" });
    expect(storedResult).toMatchObject({ answerText, source: "opencode-sqlite-observer" });
    expect(writes).toHaveLength(1);
    expect(writes[0].text).toContain("Result ID:");
    expect(writes[0].text.includes(answerText)).toBe(false);
  });

  it("keeps an observed Provider result when the terminal has already exited", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-workspace-observer-result-after-exit-"));
    const store = createSessionStore({ root });
    const taskId = "task-observer-result-after-exit";
    const conductorId = "opencode:project-runtime-current:task-observer-result-after-exit:task-observer-result-after-exit-conductor";
    const workerId = "opencode:project-runtime-current:task-observer-result-after-exit:task-observer-result-after-exit-researcher";
    const writes = [];

    store.startSession({ taskId, sessionId: conductorId, command: "opencode", cwd: root });
    store.startSession({ taskId, sessionId: workerId, command: "opencode", cwd: root });
    store.recordState({ taskId, sessionId: conductorId }, "waiting_conductor", "Conductor completed its last decision.");
    const dispatch = store.recordDispatch({ taskId, toSessionId: workerId, conductorSessionId: conductorId, assignment: "Return one durable native answer." });
    store.markDispatchInputAccepted({ taskId, sessionId: workerId, dispatchId: dispatch.dispatchId, transport: "terminal_runtime" });
    const sessions = [
      { id: conductorId, taskId, status: "running", provider: "opencode", cwd: root },
      { id: workerId, taskId, status: "exited", provider: "opencode", cwd: root },
    ];
    const monitor = createSessionWakeupMonitor({
      ptyManager: {
        list: () => sessions,
        get: (id) => sessions.find((session) => session.id === id),
        sampleStatus: (id) => ({ id, state: id === workerId ? "exited" : "running", cursor: id === conductorId ? 10 : 26, lastOutputAgeMs: 0 }),
        write: (id, text) => { writes.push({ id, text }); return { id, status: "running" }; },
      },
      sessionStore: store,
      providerObserver: {
        observeDispatch: () => ({
          kind: "result",
          provider: "opencode",
          receipt: { provider: "opencode", providerSessionId: "ses_worker", providerMessageId: "msg_dispatch", dispatchMessageCreatedAt: 100 },
          result: {
            provider: "opencode",
            providerSessionId: "ses_worker",
            providerMessageId: "msg_answer",
            providerStepFinishId: "prt_stop",
            stepFinishReason: "stop",
            completedAt: 200,
            answerText: "# Durable answer\nPersisted before the PTY exited.",
            source: "opencode-sqlite-observer",
          },
        }),
      },
    });

    const result = await monitor.tick();
    const worker = store.readSession({ taskId, sessionId: workerId });

    expect(result.resultAvailable).toBe(1);
    expect(result.deliveryFailures).toBe(0);
    expect(worker.dispatches[0]).toMatchObject({ status: "result_available", providerMessageId: "msg_answer" });
    expect(worker.events.map((event) => event.type)).not.toContain("dispatch.delivery_failed");
    expect(writes).toHaveLength(1);
  });

  it("records terminal exit before a receipt as delivery_failed and wakes Conductor once", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-workspace-observer-delivery-failure-"));
    const store = createSessionStore({ root });
    const taskId = "task-observer-delivery-failure";
    const conductorId = "opencode:project-runtime-current:task-observer-delivery-failure:task-observer-delivery-failure-conductor";
    const workerId = "opencode:project-runtime-current:task-observer-delivery-failure:task-observer-delivery-failure-researcher";
    const writes = [];

    store.startSession({ taskId, sessionId: conductorId, command: "opencode", cwd: root });
    store.startSession({ taskId, sessionId: workerId, command: "opencode", cwd: root });
    store.recordState({ taskId, sessionId: conductorId }, "waiting_conductor", "Conductor completed its last decision.");
    const dispatch = store.recordDispatch({ taskId, toSessionId: workerId, conductorSessionId: conductorId, assignment: "Research one primary source." });
    store.markDispatchInputAccepted({ taskId, sessionId: workerId, dispatchId: dispatch.dispatchId, transport: "terminal_runtime" });
    const sessions = [
      { id: conductorId, taskId, status: "running", provider: "opencode", cwd: root },
      { id: workerId, taskId, status: "exited", provider: "opencode", cwd: root },
    ];
    const monitor = createSessionWakeupMonitor({
      ptyManager: {
        list: () => sessions,
        get: (id) => sessions.find((session) => session.id === id),
        sampleStatus: (id) => ({ id, state: id === workerId ? "exited" : "running", cursor: id === conductorId ? 10 : 25, lastOutputAgeMs: 0 }),
        write: (id, text) => { writes.push({ id, text }); return { id, status: "running" }; },
      },
      sessionStore: store,
      providerObserver: { observeDispatch: () => ({ kind: "not_observed", provider: "opencode" }) },
    });

    const first = await monitor.tick();
    const second = await monitor.tick();
    const worker = store.readSession({ taskId, sessionId: workerId });

    expect(first.deliveryFailures).toBe(1);
    expect(first.wakeupsSent).toBe(1);
    expect(second.deliveryFailures).toBe(0);
    expect(second.wakeupsSent).toBe(0);
    expect(worker.dispatches[0]).toMatchObject({ status: "delivery_failed", failureReason: "terminal_exit_before_receipt" });
    expect(worker.events.map((event) => event.type)).toContain("dispatch.delivery_failed");
    expect(writes).toHaveLength(1);
    expect(writes[0].text).toContain("delivery failure");
    expect(writes[0].text).toContain("Runtime did not retry this work");
  });

  it("confirms a requested cancellation when the native worker terminal reports stopped and wakes Conductor once", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-workspace-cancellation-confirmation-"));
    const store = createSessionStore({ root });
    const taskId = "task-cancellation-confirmation";
    const conductorId = "opencode:project-runtime-current:task-cancellation-confirmation:task-cancellation-confirmation-conductor";
    const workerId = "opencode:project-runtime-current:task-cancellation-confirmation:task-cancellation-confirmation-researcher";
    const writes = [];

    store.startSession({ taskId, sessionId: conductorId, command: "opencode", cwd: root });
    store.startSession({ taskId, sessionId: workerId, command: "opencode", cwd: root });
    store.recordState({ taskId, sessionId: conductorId }, "waiting_conductor", "Conductor completed its last decision.");
    const dispatch = store.recordDispatch({ taskId, toSessionId: workerId, conductorSessionId: conductorId, assignment: "Research one primary source." });
    store.markDispatchInputAccepted({ taskId, sessionId: workerId, dispatchId: dispatch.dispatchId, transport: "terminal_runtime" });
    store.markDispatchCancellationRequested({ taskId, sessionId: workerId, dispatchId: dispatch.dispatchId, reason: "scope_changed" });
    const sessions = [
      { id: conductorId, taskId, status: "running", provider: "opencode", cwd: root },
      { id: workerId, taskId, status: "exited", provider: "opencode", cwd: root },
    ];
    const monitor = createSessionWakeupMonitor({
      ptyManager: {
        list: () => sessions,
        get: (id) => sessions.find((session) => session.id === id),
        // The local PTY manager exposes a finished process as `stopped`.
        // Treating only a provider's `exited` spelling as confirmation left
        // the Session occupied and later surfaced a false recovery prompt.
        sampleStatus: (id) => ({ id, state: id === workerId ? "stopped" : "running", cursor: id === conductorId ? 10 : 25, lastOutputAgeMs: 0 }),
        write: (id, text) => { writes.push({ id, text }); return { id, status: "running" }; },
      },
      sessionStore: store,
      providerObserver: { observeDispatch: () => { throw new Error("cancelled work must not be observed as a new result"); } },
    });

    const first = await monitor.tick();
    const second = await monitor.tick();
    const worker = store.readSession({ taskId, sessionId: workerId });

    expect(worker.dispatches[0]).toMatchObject({ status: "cancelled", cancellationConfirmation: "terminal_exit" });
    expect(worker.events.map((event) => event.type)).toContain("dispatch.cancelled");
    expect(first.wakeupsSent).toBe(1);
    expect(second.wakeupsSent).toBe(0);
    expect(writes).toHaveLength(1);
    expect(writes[0].text).toContain("cancellation confirmed");
  });

  it("confirms an interrupted dispatch from an OpenCode failure fact without killing the worker terminal", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-workspace-cancellation-provider-confirmation-"));
    const store = createSessionStore({ root });
    const taskId = "task-cancellation-provider-confirmation";
    const conductorId = "opencode:project-runtime-current:task-cancellation-provider-confirmation:task-cancellation-provider-confirmation-conductor";
    const workerId = "opencode:project-runtime-current:task-cancellation-provider-confirmation:task-cancellation-provider-confirmation-researcher";
    const writes = [];

    store.startSession({ taskId, sessionId: conductorId, command: "opencode", cwd: root });
    store.startSession({ taskId, sessionId: workerId, command: "opencode", cwd: root });
    store.recordState({ taskId, sessionId: conductorId }, "waiting_conductor", "Conductor completed its last decision.");
    const dispatch = store.recordDispatch({ taskId, toSessionId: workerId, conductorSessionId: conductorId, assignment: "Research one primary source." });
    store.markDispatchInputAccepted({ taskId, sessionId: workerId, dispatchId: dispatch.dispatchId, transport: "terminal_runtime" });
    store.markDispatchCancellationRequested({ taskId, sessionId: workerId, dispatchId: dispatch.dispatchId, reason: "scope_changed" });
    const sessions = [
      { id: conductorId, taskId, status: "running", provider: "opencode", cwd: root },
      { id: workerId, taskId, status: "running", provider: "opencode", cwd: root },
    ];
    const monitor = createSessionWakeupMonitor({
      ptyManager: {
        list: () => sessions,
        get: (id) => sessions.find((session) => session.id === id),
        sampleStatus: (id) => ({ id, state: "running", cursor: id === conductorId ? 10 : 26, lastOutputAgeMs: 0 }),
        write: (id, text) => { writes.push({ id, text }); return { id, status: "running" }; },
      },
      sessionStore: store,
      providerObserver: {
        observeDispatch: () => ({
          kind: "failed",
          provider: "opencode",
          receipt: { provider: "opencode", providerSessionId: "ses_worker", providerMessageId: "msg_dispatch", dispatchMessageCreatedAt: 100 },
          failure: { reason: "interrupted", message: "OpenCode stopped the active turn.", providerStepFinishId: "prt_interrupt" },
        }),
      },
    });

    await monitor.tick();
    const worker = store.readSession({ taskId, sessionId: workerId });

    expect(sessions.find((session) => session.id === workerId)?.status).toBe("running");
    expect(worker.dispatches[0]).toMatchObject({ status: "cancelled", cancellationConfirmation: "provider_interrupted" });
    expect(writes).toHaveLength(1);
  });

  it("does not turn an observer outage plus terminal exit into a false delivery failure", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-workspace-observer-outage-exit-"));
    const store = createSessionStore({ root });
    const taskId = "task-observer-outage-exit";
    const conductorId = "opencode:project-runtime-current:task-observer-outage-exit:task-observer-outage-exit-conductor";
    const workerId = "opencode:project-runtime-current:task-observer-outage-exit:task-observer-outage-exit-researcher";

    store.startSession({ taskId, sessionId: conductorId, command: "opencode", cwd: root });
    store.startSession({ taskId, sessionId: workerId, command: "opencode", cwd: root });
    store.recordState({ taskId, sessionId: conductorId }, "waiting_conductor", "Conductor completed its last decision.");
    const dispatch = store.recordDispatch({ taskId, toSessionId: workerId, conductorSessionId: conductorId, assignment: "Research one primary source." });
    store.markDispatchInputAccepted({ taskId, sessionId: workerId, dispatchId: dispatch.dispatchId, transport: "terminal_runtime" });
    const sessions = [
      { id: conductorId, taskId, status: "running", provider: "opencode", cwd: root },
      { id: workerId, taskId, status: "exited", provider: "opencode", cwd: root },
    ];
    const monitor = createSessionWakeupMonitor({
      ptyManager: {
        list: () => sessions,
        get: (id) => sessions.find((session) => session.id === id),
        sampleStatus: (id) => ({ id, state: id === workerId ? "exited" : "running", cursor: 25, lastOutputAgeMs: 0 }),
        write: () => { throw new Error("observer outage must not wake Conductor as a failure"); },
      },
      sessionStore: store,
      providerObserver: { observeDispatch: () => ({ kind: "observation_unavailable", provider: "opencode", reason: "database locked" }) },
    });

    const result = await monitor.tick();
    const worker = store.readSession({ taskId, sessionId: workerId });

    expect(result.deliveryFailures).toBe(0);
    expect(worker.dispatches[0]).toMatchObject({ status: "input_accepted" });
    expect(worker.events.map((event) => event.type)).toContain("dispatch.provider.observation_unavailable");
    expect(worker.events.map((event) => event.type)).not.toContain("dispatch.delivery_failed");
  });

  it("rehydrates a queued semantic wakeup after monitor restart and opens the next Conductor decision only after input acceptance", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-workspace-wakeup-recovery-"));
    const store = createSessionStore({ root });
    const taskId = "task-wakeup-recovery";
    const conductorId = "opencode:project-runtime-current:task-wakeup-recovery:task-wakeup-recovery-conductor";
    const workerId = "opencode:project-runtime-current:task-wakeup-recovery:task-wakeup-recovery-researcher";
    const writes = [];
    const accepted = [];

    store.startSession({ taskId, sessionId: conductorId, command: "opencode", cwd: root });
    store.startSession({ taskId, sessionId: workerId, command: "opencode", cwd: root });
    const dispatch = store.recordDispatch({ taskId, toSessionId: workerId, conductorSessionId: conductorId, assignment: "Return one finding." });
    store.markDispatchInputAccepted({ taskId, sessionId: workerId, dispatchId: dispatch.dispatchId, transport: "terminal_runtime" });
    const sessions = [
      { id: conductorId, taskId, status: "running", provider: "opencode", cwd: root },
      { id: workerId, taskId, status: "running", provider: "opencode", cwd: root },
    ];
    const ptyManager = {
      list: () => sessions,
      get: (id) => sessions.find((session) => session.id === id),
      sampleStatus: (id) => ({ id, state: "running", cursor: id === conductorId ? 11 : 22, lastOutputAgeMs: 0 }),
      write: (id, text) => { writes.push({ id, text }); return { id, status: "running" }; },
    };
    const providerObserver = {
      observeDispatch: () => ({
        kind: "result",
        provider: "opencode",
        receipt: { provider: "opencode", providerSessionId: "ses_worker", providerMessageId: "msg_dispatch", dispatchMessageCreatedAt: 100, databaseSourceId: "/tmp/opencode.db" },
        result: {
          provider: "opencode",
          providerSessionId: "ses_worker",
          providerMessageId: "msg_answer",
          providerStepFinishId: "prt_stop",
          stepFinishReason: "stop",
          completedAt: 200,
          answerText: "One durable native finding.",
          source: "opencode-sqlite-observer",
        },
      }),
    };

    // The Conductor is still in its previous decision, so the result wakeup
    // must survive as a durable queue item rather than being dropped.
    store.recordState({ taskId, sessionId: conductorId }, "running", "Conductor is deciding.");
    const firstMonitor = createSessionWakeupMonitor({ ptyManager, sessionStore: store, providerObserver });
    const first = await firstMonitor.tick();
    firstMonitor.stop();
    expect(first.wakeupsQueued).toBe(1);
    expect(store.readTaskState({ taskId }).wakeups).toMatchObject([{ status: "queued" }]);

    // A new monitor instance represents Electron/monitor recovery. It has no
    // in-memory queue, therefore delivery proves the queue was restored from
    // the Session Store rather than from a timer closure.
    store.recordState({ taskId, sessionId: conductorId }, "waiting_conductor", "Conductor decision completed.");
    const secondMonitor = createSessionWakeupMonitor({
      ptyManager,
      sessionStore: store,
      providerObserver,
      onConductorWakeupAccepted: (input) => accepted.push(input),
    });
    const second = await secondMonitor.tick();

    expect(second.wakeupsSent).toBe(1);
    expect(writes).toHaveLength(1);
    expect(accepted).toMatchObject([{ taskId, sessionId: conductorId, dispatchId: dispatch.dispatchId }]);
    expect(store.readTaskState({ taskId }).wakeups).toMatchObject([{ status: "sent", dispatchId: dispatch.dispatchId }]);
  });

  it("restores a reaped Conductor Host before delivering a durable semantic wakeup", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-workspace-reaped-conductor-wakeup-"));
    const store = createSessionStore({ root });
    const taskId = "task-reaped-conductor";
    const conductorId = "opencode:project-runtime-current:task-reaped-conductor:task-reaped-conductor-conductor";
    const writes = [];
    const interactiveSubmissions = [];
    const ensureCalls = [];
    const sessions = [];

    store.startSession({ taskId, sessionId: conductorId, command: "opencode", cwd: root });
    store.recordConductorWakeup({
      taskId,
      sessionId: conductorId,
      wakeupKey: "result:task-reaped-conductor:ABC123",
      kind: "result",
      workerSessionId: "worker-private-id",
      dispatchId: "ABC123",
      resultId: "result-ABC123",
      status: "queued",
    });
    const monitor = createSessionWakeupMonitor({
      ptyManager: {
        list: () => sessions,
        get: (id) => sessions.find((session) => session.id === id),
        sampleStatus: (id) => ({ id, state: "running", cursor: 9, lastOutputAgeMs: 0 }),
        write: (id, text) => { writes.push({ id, text }); return { id, status: "running" }; },
      },
      sessionStore: store,
      listConductorWakeupTargets: () => [{ taskId, sessionId: conductorId }],
      ensureConductorWakeupTarget: ({ taskId: requestedTaskId, sessionId, wakeupKey }) => {
        ensureCalls.push({ taskId: requestedTaskId, sessionId, wakeupKey });
        const restored = { id: conductorId, taskId, status: "running", provider: "opencode", cwd: root, incarnationId: "new-incarnation" };
        sessions.push(restored);
        return restored;
      },
      enqueueConductorInteractiveSubmission: (input) => {
        interactiveSubmissions.push(input);
        return { disposition: "submitted" };
      },
    });

    const result = await monitor.tick();

    expect(result.wakeupsSent).toBe(1);
    expect(ensureCalls).toEqual([{ taskId, sessionId: conductorId, wakeupKey: "result:task-reaped-conductor:ABC123" }]);
    expect(writes).toHaveLength(0);
    expect(interactiveSubmissions).toMatchObject([{
      sessionId: conductorId,
      expectedIncarnationId: "new-incarnation",
      source: "conductor_wakeup",
      idempotencyKey: "wakeup:result:task-reaped-conductor:ABC123",
    }]);
    expect(interactiveSubmissions[0].text).toContain("Conductor Input ID result:task-reaped-conductor:ABC123");
    expect(store.readTaskState({ taskId }).wakeups).toMatchObject([{ status: "sent" }]);
  });

  it("fences Provider input observation at the newest native Conductor generation", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-workspace-conductor-generation-fence-"));
    const store = createSessionStore({ root });
    const taskId = "task-conductor-generation-fence";
    const conductorId = "opencode:project-runtime-current:task-conductor-generation-fence:task-conductor-generation-fence-conductor";
    store.startSession({ taskId, sessionId: conductorId, command: "opencode", cwd: root });
    await new Promise((resolve) => setTimeout(resolve, 2));
    store.startSession({ taskId, sessionId: conductorId, command: "opencode", cwd: root });
    store.recordConductorWakeup({
      taskId,
      sessionId: conductorId,
      wakeupKey: "result:task-conductor-generation-fence:ABC123",
      kind: "result",
      workerSessionId: "worker-private-id",
      dispatchId: "ABC123",
      status: "sent",
    });
    let observedAfter;
    const monitor = createSessionWakeupMonitor({
      ptyManager: {
        list: () => [{ id: conductorId, taskId, status: "running", provider: "opencode", cwd: root }],
        get: () => ({ id: conductorId, taskId, status: "running", provider: "opencode", cwd: root }),
        sampleStatus: (id) => ({ id, state: "running", cursor: 9, lastOutputAgeMs: 0 }),
        write: () => ({ id: conductorId, status: "running" }),
      },
      sessionStore: store,
      providerObserver: {
        observeConductorInput: ({ afterMessageCreatedAt }) => {
          observedAfter = afterMessageCreatedAt;
          return { kind: "not_observed" };
        },
      },
    });

    await monitor.tick();
    const starts = store.readSession({ taskId, sessionId: conductorId }).events.filter((event) => event.type === "session.started");

    expect(starts).toHaveLength(2);
    expect(observedAfter).toBe(starts.at(-1).createdAt);
  });

  it("confirms a recovered wakeup from OpenCode's exact input receipt without sending it twice", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-workspace-wakeup-receipt-recovery-"));
    const store = createSessionStore({ root });
    const taskId = "task-wakeup-receipt-recovery";
    const conductorId = "opencode:project-runtime-current:task-wakeup-receipt-recovery:task-wakeup-receipt-recovery-conductor";
    const wakeupKey = "result:task-wakeup-receipt-recovery:ABC123";
    const writes = [];
    const accepted = [];

    store.startSession({ taskId, sessionId: conductorId, command: "opencode", cwd: root });
    store.recordConductorWakeup({
      taskId,
      sessionId: conductorId,
      wakeupKey,
      kind: "result",
      workerSessionId: "worker-private-id",
      dispatchId: "ABC123",
      status: "sent",
    });
    const sessions = [{ id: conductorId, taskId, status: "running", provider: "opencode", cwd: root }];
    const monitor = createSessionWakeupMonitor({
      ptyManager: {
        list: () => sessions,
        get: () => sessions[0],
        sampleStatus: (id) => ({ id, state: "running", cursor: 9, lastOutputAgeMs: 0 }),
        write: (id, text) => { writes.push({ id, text }); return { id, status: "running" }; },
      },
      sessionStore: store,
      providerObserver: {
        observeConductorInput: ({ inputId }) => ({
          kind: "receipt",
          receipt: {
            provider: "opencode",
            providerSessionId: "ses_conductor",
            providerMessageId: `msg-${inputId}`,
            dispatchMessageCreatedAt: 500,
            databaseSourceId: "/tmp/opencode.db",
          },
        }),
      },
      onConductorWakeupAccepted: (input) => accepted.push(input),
    });

    await monitor.tick();
    const wakeup = store.readTaskState({ taskId }).wakeups[0];

    expect(writes).toHaveLength(0);
    expect(wakeup).toMatchObject({
      wakeupKey,
      status: "observed",
      providerSessionId: "ses_conductor",
      databaseSourceId: "/tmp/opencode.db",
    });
    expect(accepted).toMatchObject([{ taskId, sessionId: conductorId, wakeupKey, dispatchId: "ABC123" }]);
  });
});

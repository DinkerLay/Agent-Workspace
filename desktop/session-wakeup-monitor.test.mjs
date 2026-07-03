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
    expect(wakeupText).toContain("Runtime wakeup: Researcher result available");
    expect(wakeupText).toContain(`Task: ${taskId}`);
    expect(wakeupText).toContain(`Worker session: ${workerId}`);
    expect(wakeupText).toContain(`Dispatch ID: ${dispatch.dispatchId}`);
    expect(wakeupText).toContain(`Result ID: ${workerView.results[0].resultId}`);
    expect(wakeupText).toContain("Researcher answer:");
    expect(wakeupText).toContain(longAnswerText);
    expect(writes[0].text).not.toContain("Required next step");
    expect(writes[0].text).not.toContain("Use read_task_state");
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
});

import assert from "node:assert/strict";
import {
  createConductorToolBridge,
  formatInteractivePtyInput,
  startConductorToolBridgeHttpServer,
} from "./conductor-tool-bridge.cjs";

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
    toMatchObject(expected) {
      assert.partialDeepStrictEqual(actual, expected);
    },
  };
}

describe("Conductor tool bridge", () => {
  it("formats multiline worker input as a complete bracketed paste submit", () => {
    expect(formatInteractivePtyInput("line 1\nline 2")).toBe("\x1b[200~line 1\nline 2\x1b[201~\r");
  });

  it("returns a clear delivered contract after writing a normal assignment to the target PTY", async () => {
    const writes = [];
    const store = {
      recordDispatch(input) {
        return {
          dispatchId: "A1B2C3",
          taskId: input.taskId,
          toSessionId: input.toSessionId,
          assignment: input.assignment,
          contextRefs: input.contextRefs ?? [],
          expectedOutput: input.expectedOutput ?? "",
          priority: input.priority ?? "normal",
          status: "queued",
          createdAt: "2026-06-29T00:00:00.000Z",
        };
      },
      markDispatchDelivered() {},
      readSession() {
        return {
          sessionId: "task-1-researcher",
          state: "ready",
          cursor: 1,
          cleanTranscriptTail: "",
          events: [],
          dispatches: [],
          permissions: [],
          artifacts: [],
        };
      },
    };
    const bridge = createConductorToolBridge({
      sessionStore: store,
      ptyManager: {
        get: () => ({ id: "task-1-researcher", status: "running" }),
        write: (id, text) => {
          writes.push({ id, text });
          return { id, status: "running" };
        },
      },
    });

    const result = await bridge.callSession({
      taskId: "task-1",
      toSessionId: "task-1-researcher",
      assignment: "Research dynamic workflow.",
      expectedOutput: "Research note",
    });

    expect(result).toMatchObject({
      ok: true,
      dispatchId: "A1B2C3",
      taskId: "task-1",
      toSessionId: "task-1-researcher",
      status: "delivered",
      deliveryState: "delivered",
      targetSessionState: "delivered_pending",
      resultState: "pending",
      turnPolicy: "stop_after_dispatch",
      nextAllowedAction: "wait_for_runtime_wakeup",
      cannotReadResultUntil: "provider_result_available",
      message:
        "Assignment delivered to target session. End this Conductor turn now and wait for a runtime wakeup before reading the result.",
    });
    expect(result.canContinueCurrentTurn).toBe(undefined);
    expect(result.turnBoundary).toBe("dispatch");
    expect(result.shouldEndTurn).toBe(true);
    expect(result.shouldWaitForWakeup).toBe(undefined);
    expect(writes[0].id).toBe("task-1-researcher");
    expect(writes[0].text).toContain("Research dynamic workflow.");
    expect(writes[0].text).toContain("[Agent Workspace] Dispatch ID A1B2C3");
    expect(writes[0].text).toContain("When complete, answer in this session with:");
    expect(writes[0].text).toContain("- Dispatch ID: A1B2C3");
    expect(writes[0].text).toContain("- artifact paths you created or changed");
    expect(writes[0].text).toContain("- concise result summary");
    expect(writes[0].text).toContain('Do not answer only "done" or "complete".');
    expect(writes[0].text).not.toContain("Dispatch Key");
    expect(writes[0].text).not.toContain("Workspace Session Message");
  });

  it("records the live Conductor session id with each dispatch", async () => {
    const taskId = "task-1cmooz";
    const conductorId = "opencode:project-bq0l0t:task-1cmooz:task-intake-001-conductor";
    const workerId = "opencode:project-bq0l0t:task-1cmooz:task-intake-001-researcher-micron";
    const dispatchInputs = [];
    const writes = [];
    const store = {
      recordDispatch(input) {
        dispatchInputs.push(input);
        return {
          dispatchId: "E5F6A7",
          taskId: input.taskId,
          toSessionId: input.toSessionId,
          conductorSessionId: input.conductorSessionId,
          assignment: input.assignment,
          contextRefs: input.contextRefs ?? [],
          expectedOutput: input.expectedOutput ?? "",
          priority: input.priority ?? "normal",
          status: "queued",
          createdAt: "2026-06-29T00:00:00.000Z",
        };
      },
      markDispatchDelivered() {},
      readSession() {
        return {
          sessionId: workerId,
          state: "ready",
          cursor: 1,
          cleanTranscriptTail: "",
          events: [],
          dispatches: [],
          permissions: [],
          artifacts: [],
        };
      },
    };
    const bridge = createConductorToolBridge({
      sessionStore: store,
      ptyManager: {
        list: () => [
          { id: conductorId, taskId, status: "running" },
          { id: workerId, taskId, status: "running" },
        ],
        get: (id) => ({ id, taskId, status: "running" }),
        write: (id, text) => {
          writes.push({ id, text });
          return { id, status: "running" };
        },
      },
    });

    const result = await bridge.callSession({
      taskId,
      toSessionId: workerId,
      assignment: "Research Micron.",
    });

    expect(result).toMatchObject({
      ok: true,
      dispatchId: "E5F6A7",
      toSessionId: workerId,
      status: "delivered",
    });
    expect(dispatchInputs[0]).toMatchObject({
      taskId,
      toSessionId: workerId,
      conductorSessionId: conductorId,
      assignment: "Research Micron.",
    });
    expect(writes[0].id).toBe(workerId);
  });

  it("records structured task completion claims without parsing provider output text", async () => {
    const recordedClaims = [];
    const store = {
      recordTaskCompletionClaim(input) {
        recordedClaims.push(input);
        return {
          id: "event-7",
          taskId: input.taskId,
          sessionId: input.sessionId,
          type: "task.completion_claim",
          cursor: 7,
          summary: input.summary ?? "Task completion claimed by Conductor",
          data: {
            message: input.message,
            source: input.source,
          },
        };
      },
    };
    const bridge = createConductorToolBridge({
      sessionStore: store,
      ptyManager: {
        get: () => undefined,
      },
    });

    const result = await bridge.claimTaskCompletion({
      taskId: "task-1",
      sessionId: "task-1-conductor",
      message: "Research and review both passed; ready for Review gate.",
    });

    expect(result).toMatchObject({
      ok: true,
      taskId: "task-1",
      sessionId: "task-1-conductor",
      status: "completion_claim_recorded",
      eventType: "task.completion_claim",
      turnPolicy: "stop_for_review_gate",
      nextAllowedAction: "wait_for_review_gate",
    });
    assert.deepStrictEqual(recordedClaims, [
      {
        taskId: "task-1",
        sessionId: "task-1-conductor",
        message: "Research and review both passed; ready for Review gate.",
        source: "conductor",
      },
    ]);
  });

  it("starts a provider-native worker before writing when the target PTY is not running", async () => {
    const writes = [];
    const starts = [];
    const sessions = new Map();
    const store = {
      recordDispatch(input) {
        return {
          dispatchId: "B2C3D4",
          taskId: input.taskId,
          toSessionId: input.toSessionId,
          assignment: input.assignment,
          contextRefs: input.contextRefs ?? [],
          expectedOutput: input.expectedOutput ?? "",
          priority: input.priority ?? "normal",
          status: "queued",
          createdAt: "2026-06-29T00:00:00.000Z",
        };
      },
      markDispatchDelivered() {},
      readSession() {
        return {
          sessionId: "task-1-reviewer",
          state: "ready",
          cursor: 1,
          cleanTranscriptTail: "",
          events: [],
          dispatches: [],
          permissions: [],
          artifacts: [],
        };
      },
    };
    const bridge = createConductorToolBridge({
      sessionStore: store,
      ptyManager: {
        get: (id) => sessions.get(id),
        write: (id, text) => {
          writes.push({ id, text });
          return { id, status: "running" };
        },
      },
      startWorkerSession: async (input) => {
        starts.push(input);
        const session = { id: input.sessionId, status: "running" };
        sessions.set(input.sessionId, session);
        return session;
      },
    });

    const result = await bridge.callSession({
      taskId: "task-1",
      toSessionId: "task-1-reviewer",
      assignment: "Review the research note.",
      expectedOutput: "Review gaps",
    });

    expect(result).toMatchObject({
      dispatchId: "B2C3D4",
      status: "delivered",
      turnPolicy: "stop_after_dispatch",
    });
    expect(result.canContinueCurrentTurn).toBe(undefined);
    expect(result.turnBoundary).toBe("dispatch");
    expect(result.shouldEndTurn).toBe(true);
    expect(starts[0]).toMatchObject({ taskId: "task-1", sessionId: "task-1-reviewer" });
    expect(writes[0].text).toContain("Review the research note.");
    expect(writes[0].text).not.toContain("Workspace Session Message");
  });

  it("does not use provider TUI prompt text as the dispatch readiness gate", async () => {
    const writes = [];
    let transcript = "";
    const store = {
      recordDispatch(input) {
        return {
          dispatchId: "C3D4E5",
          taskId: input.taskId,
          toSessionId: input.toSessionId,
          assignment: input.assignment,
          contextRefs: [],
          expectedOutput: "",
          priority: "normal",
          status: "queued",
          createdAt: "2026-06-29T00:00:00.000Z",
        };
      },
      markDispatchDelivered() {},
    };
    const bridge = createConductorToolBridge({
      sessionStore: store,
      ptyManager: {
        get: () => ({ id: "task-1-researcher", status: "running" }),
        read: () => ({ id: "task-1-researcher", status: "running", transcript: transcript ? [transcript] : [] }),
        write: (id, text) => {
          writes.push({ id, text });
          return { id, status: "running" };
        },
      },
      deliveryTimeoutMs: 1_000,
      deliveryPollIntervalMs: 25,
    });

    const pendingResult = bridge.callSession({
      taskId: "task-1",
      toSessionId: "task-1-researcher",
      assignment: "Research after prompt.",
    });
    const result = await pendingResult;
    expect(result).toMatchObject({
      ok: true,
      dispatchId: "C3D4E5",
      status: "delivered",
      deliveryState: "delivered",
      targetSessionState: "delivered_pending",
      resultState: "pending",
      turnPolicy: "stop_after_dispatch",
      message:
        "Assignment delivered to target session. End this Conductor turn now and wait for a runtime wakeup before reading the result.",
    });
    expect(writes.length).toBe(1);
    expect(writes[0].text).toContain("Research after prompt.");
  });

  it("does not report delivery when the provider never confirms the dispatch marker", async () => {
    const writes = [];
    const delivered = [];
    const failed = [];
    const store = {
      recordDispatch(input) {
        return {
          dispatchId: "C0FFEE",
          taskId: input.taskId,
          toSessionId: input.toSessionId,
          assignment: input.assignment,
          contextRefs: [],
          expectedOutput: "",
          priority: "normal",
          status: "queued",
          createdAt: "2026-06-29T00:00:00.000Z",
        };
      },
      markDispatchDelivered(input) {
        delivered.push(input);
      },
      markDispatchFailed(input) {
        failed.push(input);
      },
      readSession() {
        return {
          sessionId: "task-1-researcher",
          state: "ready",
          cursor: 1,
          cleanTranscriptTail: "",
          events: [],
          dispatches: [],
          permissions: [],
          artifacts: [],
        };
      },
    };
    const bridge = createConductorToolBridge({
      sessionStore: store,
      ptyManager: {
        get: () => ({ id: "task-1-researcher", provider: "opencode", status: "running" }),
        read: () => ({
          id: "task-1-researcher",
          provider: "opencode",
          status: "running",
          transcript: ['Ask anything... "Fix broken tests"\ntab agents ctrl+p commands'],
        }),
        write: (id, text) => {
          writes.push({ id, text });
          return { id, status: "running" };
        },
      },
      confirmWorkerAssignmentDelivery: async () => undefined,
      deliveryTimeoutMs: 25,
      deliveryPollIntervalMs: 5,
    });

    const result = await bridge.callSession({
      taskId: "task-1",
      toSessionId: "task-1-researcher",
      assignment: "Research only after confirmed delivery.",
    });

    expect(result).toMatchObject({
      ok: false,
      dispatchId: "C0FFEE",
      status: "failed",
      deliveryState: "failed",
      targetSessionState: "ready",
      errorCode: "target_session_delivery_timeout",
    });
    expect(writes.length).toBe(1);
    expect(delivered.length).toBe(0);
    expect(failed[0]).toMatchObject({
      taskId: "task-1",
      sessionId: "task-1-researcher",
      dispatchId: "C0FFEE",
      reason: "target_session_delivery_timeout",
    });
  });

  it("does not write a worker assignment before the provider terminal can receive input", async () => {
    const writes = [];
    const store = {
      recordDispatch(input) {
        return {
          dispatchId: "A11CED",
          taskId: input.taskId,
          toSessionId: input.toSessionId,
          assignment: input.assignment,
          contextRefs: [],
          expectedOutput: "",
          priority: "normal",
          status: "queued",
          createdAt: "2026-06-29T00:00:00.000Z",
        };
      },
      markDispatchFailed(input) {
        this.failed = input;
      },
      readSession() {
        return {
          sessionId: "task-1-researcher",
          state: "ready",
          cursor: 1,
          cleanTranscriptTail: "",
          events: [],
          dispatches: [],
          permissions: [],
          artifacts: [],
        };
      },
    };
    const bridge = createConductorToolBridge({
      sessionStore: store,
      ptyManager: {
        get: () => ({ id: "task-1-researcher", provider: "opencode", status: "running" }),
        read: () => ({ id: "task-1-researcher", provider: "opencode", status: "running", transcript: ["booting..."] }),
        write: (id, text) => {
          writes.push({ id, text });
          return { id, status: "running" };
        },
      },
      confirmWorkerAssignmentDelivery: async () => ({ providerSessionId: "ses_test" }),
      deliveryTimeoutMs: 25,
      deliveryPollIntervalMs: 5,
    });

    const result = await bridge.callSession({
      taskId: "task-1",
      toSessionId: "task-1-researcher",
      assignment: "Do not send before the prompt is ready.",
    });

    expect(result).toMatchObject({
      ok: false,
      dispatchId: "A11CED",
      status: "failed",
      targetSessionState: "ready",
      errorCode: "target_session_delivery_timeout",
    });
    expect(writes.length).toBe(0);
    expect(store.failed).toMatchObject({
      dispatchId: "A11CED",
      reason: "target_session_delivery_timeout",
    });
  });

  it("does not write a worker assignment while opencode is interruptible and actively running", async () => {
    const writes = [];
    const store = {
      recordDispatch(input) {
        return {
          dispatchId: "BADA55",
          taskId: input.taskId,
          toSessionId: input.toSessionId,
          assignment: input.assignment,
          contextRefs: [],
          expectedOutput: "",
          priority: "normal",
          status: "queued",
          createdAt: "2026-06-29T00:00:00.000Z",
        };
      },
      markDispatchFailed(input) {
        this.failed = input;
      },
      readSession() {
        return {
          sessionId: "task-1-researcher",
          state: "ready",
          cursor: 1,
          cleanTranscriptTail: "",
          events: [],
          dispatches: [],
          permissions: [],
          artifacts: [],
        };
      },
    };
    const bridge = createConductorToolBridge({
      sessionStore: store,
      ptyManager: {
        get: () => ({ id: "task-1-researcher", provider: "opencode", status: "running" }),
        read: () => ({
          id: "task-1-researcher",
          provider: "opencode",
          status: "running",
          transcript: ["Build · DeepSeek V4 Flash OpenCode Go · medium\nesc interrupt     tab agents   ctrl+p commands"],
        }),
        write: (id, text) => {
          writes.push({ id, text });
          return { id, status: "running" };
        },
      },
      confirmWorkerAssignmentDelivery: async () => ({ providerSessionId: "ses_test" }),
      deliveryTimeoutMs: 25,
      deliveryPollIntervalMs: 5,
    });

    const result = await bridge.callSession({
      taskId: "task-1",
      toSessionId: "task-1-researcher",
      assignment: "Do not send while opencode is still interruptible.",
    });

    expect(result).toMatchObject({
      ok: false,
      dispatchId: "BADA55",
      status: "failed",
      targetSessionState: "ready",
      errorCode: "target_session_delivery_timeout",
    });
    expect(writes.length).toBe(0);
    expect(store.failed).toMatchObject({
      dispatchId: "BADA55",
      reason: "target_session_delivery_timeout",
    });
  });

  it("marks delivery only after the provider confirms the dispatch marker", async () => {
    const writes = [];
    const delivered = [];
    let confirmCalls = 0;
    const store = {
      recordDispatch(input) {
        return {
          dispatchId: "BEE123",
          taskId: input.taskId,
          toSessionId: input.toSessionId,
          assignment: input.assignment,
          contextRefs: [],
          expectedOutput: "",
          priority: "normal",
          status: "queued",
          createdAt: "2026-06-29T00:00:00.000Z",
        };
      },
      markDispatchDelivered(input) {
        delivered.push(input);
      },
      readSession() {
        return {
          sessionId: "task-1-researcher",
          state: "ready",
          cursor: 1,
          cleanTranscriptTail: "",
          events: [],
          dispatches: [],
          permissions: [],
          artifacts: [],
        };
      },
    };
    const bridge = createConductorToolBridge({
      sessionStore: store,
      ptyManager: {
        get: () => ({ id: "task-1-researcher", provider: "opencode", status: "running" }),
        read: () => ({
          id: "task-1-researcher",
          provider: "opencode",
          status: "running",
          transcript: ['Ask anything... "Fix broken tests"\ntab agents ctrl+p commands'],
        }),
        write: (id, text) => {
          writes.push({ id, text });
          return { id, status: "running" };
        },
      },
      confirmWorkerAssignmentDelivery: async () => {
        confirmCalls += 1;
        return confirmCalls >= 3 ? { providerSessionId: "ses_worker", dispatchMessageCreatedAt: 123 } : undefined;
      },
      deliveryTimeoutMs: 100,
      deliveryPollIntervalMs: 5,
    });

    const result = await bridge.callSession({
      taskId: "task-1",
      toSessionId: "task-1-researcher",
      assignment: "Send only once and wait for provider confirmation.",
    });

    expect(result).toMatchObject({
      ok: true,
      dispatchId: "BEE123",
      status: "delivered",
      targetSessionState: "delivered_pending",
    });
    expect(writes.length).toBe(1);
    expect(confirmCalls).toBe(3);
    expect(delivered[0]).toMatchObject({
      taskId: "task-1",
      sessionId: "task-1-researcher",
      dispatchId: "BEE123",
    });
  });

  it("uses session-store runtime state rather than terminal prompt text for re-dispatch readiness", async () => {
    const writes = [];
    const delivered = [];
    const store = {
      recordDispatch(input) {
        return {
          dispatchId: "F6A7B8",
          taskId: input.taskId,
          toSessionId: input.toSessionId,
          assignment: input.assignment,
          contextRefs: [],
          expectedOutput: "",
          priority: "normal",
          status: "queued",
          createdAt: "2026-06-29T00:00:00.000Z",
        };
      },
      markDispatchDelivered(input) {
        delivered.push(input);
      },
      readSession() {
        return {
          sessionId: "task-1-reviewer",
          state: "result_available",
          cursor: 42,
          cleanTranscriptTail: "",
          events: [],
          dispatches: [{ dispatchId: "OLD123", toSessionId: "task-1-reviewer", status: "result_available" }],
          results: [{ resultId: "result-OLD123", dispatchId: "OLD123", sessionId: "task-1-reviewer" }],
          permissions: [],
          artifacts: [],
        };
      },
    };
    const bridge = createConductorToolBridge({
      sessionStore: store,
      ptyManager: {
        get: () => ({ id: "task-1-reviewer", status: "running" }),
        read: () => ({ id: "task-1-reviewer", status: "running", transcript: [] }),
        write: (id, text) => {
          writes.push({ id, text });
          return { id, status: "running" };
        },
      },
      deliveryTimeoutMs: 25,
      deliveryPollIntervalMs: 5,
    });

    const result = await bridge.callSession({
      taskId: "task-1",
      toSessionId: "task-1-reviewer",
      assignment: "Run the second review pass.",
    });

    expect(result).toMatchObject({
      ok: true,
      dispatchId: "F6A7B8",
      status: "delivered",
      targetSessionState: "delivered_pending",
    });
    expect(writes.length).toBe(1);
    expect(writes[0].text).toContain("Run the second review pass.");
    expect(delivered[0]).toMatchObject({
      taskId: "task-1",
      sessionId: "task-1-reviewer",
      dispatchId: "F6A7B8",
    });
  });

  it("retries dispatch after a delivery failure when a prior result exists and provider input is ready", async () => {
    const writes = [];
    const delivered = [];
    const confirmCalls = [];
    const store = {
      recordDispatch(input) {
        return {
          dispatchId: "R3TRY1",
          taskId: input.taskId,
          toSessionId: input.toSessionId,
          assignment: input.assignment,
          contextRefs: [],
          expectedOutput: "",
          priority: "normal",
          status: "queued",
          createdAt: "2026-06-29T00:00:00.000Z",
        };
      },
      markDispatchDelivered(input) {
        delivered.push(input);
      },
      readSession() {
        return {
          sessionId: "task-1-researcher",
          state: "delivery_failed",
          assignmentReadinessHint: "ready",
          lastResultId: "result-OLD123",
          resultCount: 1,
          unresolvedFailureDispatchId: "FAILED1",
          cursor: 42,
          cleanTranscriptTail: "",
          events: [],
          dispatches: [
            { dispatchId: "OLD123", toSessionId: "task-1-researcher", status: "result_available", resultId: "result-OLD123" },
            { dispatchId: "FAILED1", toSessionId: "task-1-researcher", status: "failed" },
          ],
          results: [{ resultId: "result-OLD123", dispatchId: "OLD123", sessionId: "task-1-researcher" }],
          permissions: [],
          artifacts: [],
        };
      },
    };
    const bridge = createConductorToolBridge({
      sessionStore: store,
      ptyManager: {
        get: () => ({ id: "task-1-researcher", provider: "opencode", status: "running" }),
        read: () => ({
          id: "task-1-researcher",
          provider: "opencode",
          status: "running",
          transcript: ['Ask anything... "Fix broken tests"\ntab agents ctrl+p commands'],
        }),
        write: (id, text) => {
          writes.push({ id, text });
          return { id, status: "running" };
        },
      },
      confirmWorkerAssignmentDelivery: async ({ dispatch }) => {
        confirmCalls.push(dispatch.dispatchId);
        return { providerSessionId: "ses_retry" };
      },
      deliveryTimeoutMs: 25,
      deliveryPollIntervalMs: 5,
    });

    const result = await bridge.callSession({
      taskId: "task-1",
      toSessionId: "task-1-researcher",
      assignment: "Retry with narrowed scope after reading the prior result.",
    });

    expect(result).toMatchObject({
      ok: true,
      dispatchId: "R3TRY1",
      status: "delivered",
      targetSessionState: "delivered_pending",
    });
    expect(writes).toHaveLength(1);
    expect(writes[0].text).toContain("Retry with narrowed scope after reading the prior result.");
    expect(confirmCalls).toEqual(["R3TRY1"]);
    expect(delivered[0]).toMatchObject({
      taskId: "task-1",
      sessionId: "task-1-researcher",
      dispatchId: "R3TRY1",
    });
  });

  it("force retries through the normal provider confirmation path", async () => {
    const writes = [];
    const delivered = [];
    const store = {
      recordDispatch(input) {
        return {
          dispatchId: "F0RCE1",
          taskId: input.taskId,
          toSessionId: input.toSessionId,
          assignment: input.assignment,
          contextRefs: [],
          expectedOutput: "",
          priority: "normal",
          status: "queued",
          createdAt: "2026-06-29T00:00:00.000Z",
        };
      },
      markDispatchDelivered(input) {
        delivered.push(input);
      },
      readSession() {
        return {
          sessionId: "task-1-researcher",
          state: "blocked",
          assignmentReadinessHint: "not_ready",
          cursor: 42,
          cleanTranscriptTail: "",
          events: [],
          dispatches: [],
          results: [],
          permissions: [],
          artifacts: [],
        };
      },
    };
    const bridge = createConductorToolBridge({
      sessionStore: store,
      ptyManager: {
        get: () => ({ id: "task-1-researcher", provider: "opencode", status: "running" }),
        read: () => ({
          id: "task-1-researcher",
          provider: "opencode",
          status: "running",
          transcript: ['Ask anything... "Fix broken tests"\ntab agents ctrl+p commands'],
        }),
        write: (id, text) => {
          writes.push({ id, text });
          return { id, status: "running" };
        },
      },
      confirmWorkerAssignmentDelivery: async ({ dispatch }) => ({ providerSessionId: `ses_${dispatch.dispatchId}` }),
      deliveryTimeoutMs: 25,
      deliveryPollIntervalMs: 5,
    });

    const result = await bridge.callSession({
      taskId: "task-1",
      toSessionId: "task-1-researcher",
      assignment: "Force retry after explicit user confirmation.",
      force: true,
    });

    expect(result).toMatchObject({
      ok: true,
      dispatchId: "F0RCE1",
      status: "delivered",
      targetSessionState: "delivered_pending",
    });
    expect(writes).toHaveLength(1);
    expect(writes[0].text).toContain("Force retry after explicit user confirmation.");
    expect(delivered[0]).toMatchObject({
      taskId: "task-1",
      sessionId: "task-1-researcher",
      dispatchId: "F0RCE1",
    });
  });

  it("does not treat queued session state alone as deliverability proof", async () => {
    const writes = [];
    const store = {
      recordDispatch(input) {
        return {
          dispatchId: "Q0EDED",
          taskId: input.taskId,
          toSessionId: input.toSessionId,
          assignment: input.assignment,
          contextRefs: [],
          expectedOutput: "",
          priority: "normal",
          status: "queued",
          createdAt: "2026-06-29T00:00:00.000Z",
        };
      },
      markDispatchFailed(input) {
        this.failed = input;
      },
      readSession() {
        return {
          sessionId: "task-1-reviewer",
          state: "queued",
          cursor: 12,
          cleanTranscriptTail: "",
          events: [],
          dispatches: [{ dispatchId: "OLD111", toSessionId: "task-1-reviewer", status: "queued" }],
          results: [],
          permissions: [],
          artifacts: [],
        };
      },
    };
    const bridge = createConductorToolBridge({
      sessionStore: store,
      ptyManager: {
        get: () => ({ id: "task-1-reviewer", provider: "opencode", status: "running" }),
        read: () => ({
          id: "task-1-reviewer",
          provider: "opencode",
          status: "running",
          transcript: ['Ask anything... "Fix broken tests"\ntab agents ctrl+p commands'],
        }),
        write: (id, text) => {
          writes.push({ id, text });
          return { id, status: "running" };
        },
      },
      deliveryTimeoutMs: 25,
      deliveryPollIntervalMs: 5,
    });

    const result = await bridge.callSession({
      taskId: "task-1",
      toSessionId: "task-1-reviewer",
      assignment: "Do not dispatch while an earlier dispatch is still queued.",
    });

    expect(result).toMatchObject({
      ok: false,
      dispatchId: "Q0EDED",
      status: "failed",
      targetSessionState: "queued",
      errorCode: "target_session_delivery_timeout",
    });
    expect(writes.length).toBe(0);
    expect(store.failed).toMatchObject({
      dispatchId: "Q0EDED",
      reason: "target_session_delivery_timeout",
    });
  });

  it("delivers the active queued dispatch after live provider input readiness is confirmed", async () => {
    const writes = [];
    const delivered = [];
    const store = {
      recordDispatch(input) {
        return {
          dispatchId: "Q0EDED",
          taskId: input.taskId,
          toSessionId: input.toSessionId,
          assignment: input.assignment,
          contextRefs: [],
          expectedOutput: "",
          priority: "normal",
          status: "queued",
          createdAt: "2026-06-29T00:00:00.000Z",
        };
      },
      markDispatchDelivered(input) {
        delivered.push(input);
      },
      readSession() {
        return {
          sessionId: "task-1-reviewer",
          state: "queued",
          activeDispatchId: "Q0EDED",
          cursor: 12,
          cleanTranscriptTail: "",
          events: [],
          dispatches: [{ dispatchId: "Q0EDED", toSessionId: "task-1-reviewer", status: "queued" }],
          results: [],
          permissions: [],
          artifacts: [],
        };
      },
    };
    const bridge = createConductorToolBridge({
      sessionStore: store,
      ptyManager: {
        get: () => ({ id: "task-1-reviewer", provider: "opencode", status: "running" }),
        read: () => ({
          id: "task-1-reviewer",
          provider: "opencode",
          status: "running",
          transcript: ['Ask anything... "Fix broken tests"\ntab agents ctrl+p commands'],
        }),
        write: (id, text) => {
          writes.push({ id, text });
          return { id, status: "running" };
        },
      },
      deliveryTimeoutMs: 25,
      deliveryPollIntervalMs: 5,
    });

    const result = await bridge.callSession({
      taskId: "task-1",
      toSessionId: "task-1-reviewer",
      assignment: "Dispatch this active queued assignment.",
    });

    expect(result).toMatchObject({
      ok: true,
      dispatchId: "Q0EDED",
      status: "delivered",
      targetSessionState: "delivered_pending",
    });
    expect(writes).toHaveLength(1);
    expect(delivered[0]).toMatchObject({
      dispatchId: "Q0EDED",
      sessionId: "task-1-reviewer",
    });
  });

  it("returns a structured failure when the target session cannot become deliverable", async () => {
    const store = {
      recordDispatch(input) {
        return {
          dispatchId: "D4E5F6",
          taskId: input.taskId,
          toSessionId: input.toSessionId,
          assignment: input.assignment,
          contextRefs: [],
          expectedOutput: "",
          priority: "normal",
          status: "queued",
          createdAt: "2026-06-29T00:00:00.000Z",
        };
      },
      markDispatchFailed(input) {
        this.failed = input;
      },
    };
    const bridge = createConductorToolBridge({
      sessionStore: store,
      ptyManager: {
        get: () => undefined,
      },
      startWorkerSession: async () => undefined,
      deliveryTimeoutMs: 50,
      deliveryPollIntervalMs: 10,
    });

    const result = await bridge.callSession({
      taskId: "task-1",
      toSessionId: "task-1-researcher",
      assignment: "Research dynamic workflow.",
    });

    expect(result).toMatchObject({
      ok: false,
      dispatchId: "D4E5F6",
      taskId: "task-1",
      toSessionId: "task-1-researcher",
      status: "failed",
      deliveryState: "failed",
      targetSessionState: "not_started",
      resultState: "none",
      turnPolicy: "recover_or_stop",
      errorCode: "target_session_start_failed",
      message: "Target session could not be started. Conductor may correct the target/config or ask the user.",
    });
    expect(store.failed).toMatchObject({
      taskId: "task-1",
      sessionId: "task-1-researcher",
      dispatchId: "D4E5F6",
      reason: "target_session_start_failed",
    });
  });

  it("reads session data from Shell Session Store", async () => {
    const bridge = createConductorToolBridge({
      sessionStore: {
        readSession: () => ({
          sessionId: "task-1-researcher",
          state: "ready",
          cursor: 2,
          cleanTranscriptTail: "research done",
          events: [],
          dispatches: [],
          permissions: [],
          artifacts: [],
        }),
      },
      ptyManager: {},
    });

    await expect(bridge.readSession({ taskId: "task-1", sessionId: "task-1-researcher" })).resolves.toMatchObject({
      state: "ready",
      cleanTranscriptTail: "research done",
    });
  });

  it("reads task state summary from Shell Session Store", async () => {
    const bridge = createConductorToolBridge({
      sessionStore: {
        readTaskState: () => ({
          taskId: "task-1",
          cursor: 4,
          sessions: [{ sessionId: "task-1-researcher", state: "ready" }],
          dispatches: [{ dispatchId: "dispatch-1", status: "result_available" }],
          results: [{ resultId: "result-1", dispatchId: "dispatch-1", answerPreview: "done" }],
          pendingDecisions: [{ type: "worker_result_available", dispatchId: "dispatch-1" }],
        }),
      },
      ptyManager: {},
    });

    await expect(bridge.readTaskState({ taskId: "task-1" })).resolves.toMatchObject({
      taskId: "task-1",
      sessions: [{ sessionId: "task-1-researcher", state: "ready" }],
      pendingDecisions: [{ type: "worker_result_available", dispatchId: "dispatch-1" }],
    });
  });

  it("rejects dispatch targets outside the Conductor worker target allowlist", async () => {
    const writes = [];
    const failures = [];
    const bridge = createConductorToolBridge({
      sessionStore: {
        recordDispatchFailure(input) {
          failures.push(input);
          return { id: "event-1" };
        },
      },
      ptyManager: {
        get: () => ({ id: "task-1-reviewer", status: "running" }),
        write: (id, text) => writes.push({ id, text }),
      },
      validateDispatch: () => ({ ok: false, reason: "route-not-allowed" }),
    });

    const result = await bridge.callSession({
      taskId: "task-1",
      toSessionId: "task-1-reviewer",
      assignment: "Bypass the worker target allowlist.",
    });

    expect(result).toMatchObject({
      ok: false,
      dispatchId: "",
      taskId: "task-1",
      toSessionId: "task-1-reviewer",
      status: "failed",
      deliveryState: "failed",
      targetSessionState: "unknown",
      resultState: "none",
      turnPolicy: "recover_or_stop",
      errorCode: "route_validation_failed",
      message: "route-not-allowed",
    });
    expect(writes.length).toBe(0);
    expect(failures).toEqual([
      {
        taskId: "task-1",
        toSessionId: "task-1-reviewer",
        assignment: "Bypass the worker target allowlist.",
        reason: "route-not-allowed",
        message: "route-not-allowed",
      },
    ]);
  });

  it("exposes tool calls through the local authenticated HTTP bridge", async () => {
    const calls = [];
    const bridge = {
      callSession: async (input) => {
        calls.push(input);
        return { ok: true, dispatchId: "dispatch-1", status: "delivered", deliveryState: "delivered" };
      },
      readTaskState: async () => ({ taskId: "task-1", sessions: [] }),
      readSession: async () => ({ sessionId: "session-1", state: "ready", cursor: 0 }),
    };

    const server = await startConductorToolBridgeHttpServer({ bridge, token: "test-token" });
    try {
      const response = await fetch(`${server.url}/tools/call_session`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer test-token",
        },
        body: JSON.stringify({
          taskId: "task-1",
          toSessionId: "task-1-researcher",
          assignment: "research",
        }),
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ ok: true, dispatchId: "dispatch-1", status: "delivered" });
      expect(calls[0]).toMatchObject({ taskId: "task-1", toSessionId: "task-1-researcher" });

      const denied = await fetch(`${server.url}/tools/call_session`, {
        method: "POST",
        headers: { authorization: "Bearer wrong-token" },
      });
      expect(denied.status).toBe(401);
    } finally {
      await server.close();
    }
  });
});

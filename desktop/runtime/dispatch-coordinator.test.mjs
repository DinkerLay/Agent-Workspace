import assert from "node:assert/strict";
import { createDispatchCoordinator } from "./dispatch-coordinator.cjs";

const isVitest = process.env.VITEST === "true" || process.env.VITEST_WORKER_ID !== undefined;
const testApi = isVitest ? await import("vitest") : await import("node:test");
const { describe, it } = testApi;

describe("Dispatch coordinator", () => {
  it("delivers an Agent Card assignment through the OpenCode Server without a PTY", async () => {
    const accepted = [];
    const delivered = [];
    const coordinator = createDispatchCoordinator({
      sessionStore: {
        recordDispatch(input) { return { ...input, dispatchId: "D-server", status: "queued" }; },
        markDispatchInputAccepted(input) { accepted.push(input); },
      },
      validateDispatch: () => ({ ok: true }),
      resolveAgentSession: () => ({ agentId: "researcher", sessionId: "opencode:task-1:researcher" }),
      resolveConductorSessionId: () => "opencode:task-1:conductor",
      prepareDispatchContext: () => ({ contextRefs: [], contextPackets: [] }),
      deliverProviderAssignment: async (input) => {
        delivered.push(input);
        return { accepted: true, providerSessionId: "ses_worker1", targetSessionState: "queued" };
      },
    });

    const result = await coordinator.callSession({ taskId: "task-1", agentId: "researcher", assignment: "Find primary sources." });

    assert.equal(result.ok, true);
    assert.equal(delivered.length, 1);
    assert.match(delivered[0].text, /\[Agent Workspace\] Dispatch ID D-server/);
    assert.deepEqual(accepted, [{
      taskId: "task-1",
      sessionId: "opencode:task-1:researcher",
      dispatchId: "D-server",
      transport: "opencode_server",
      provider: "opencode",
      providerSessionId: "ses_worker1",
    }]);
  });

  it("serializes concurrent intents for one native Session before a durable receipt exists", async () => {
    const dispatches = [];
    let releaseContext;
    const validationInputs = [];
    const coordinator = createDispatchCoordinator({
      sessionStore: {
        recordDispatch(input) {
          const dispatch = { ...input, dispatchId: `D${dispatches.length + 1}`, status: "queued" };
          dispatches.push(dispatch);
          return dispatch;
        },
        markDispatchInputAccepted(input) {
          const dispatch = dispatches.find((item) => item.dispatchId === input.dispatchId);
          dispatch.status = "input_accepted";
        },
      },
      ptyManager: {
        get: () => ({ id: "opencode:task:researcher", status: "running", incarnationId: "inc-1", generation: 1 }),
        list: () => [],
      },
      validateDispatch: (input) => { validationInputs.push(input); return { ok: true }; },
      resolveAgentSession: () => ({ agentId: "researcher", sessionId: "opencode:task:researcher" }),
      prepareDispatchContext: () => new Promise((resolve) => { releaseContext = resolve; }),
      enqueueWorkerInput: async () => ({ result: { accepted: true } }),
    });

    const first = coordinator.callSession({ taskId: "task-1", agentId: "researcher", assignment: "Find the first source.", contextRefs: ["result:review-1"] });
    const second = await coordinator.callSession({ taskId: "task-1", agentId: "researcher", assignment: "Find a second source." });

    assert.deepEqual(second, {
      ok: false,
      dispatchId: "",
      taskId: "task-1",
      agentId: "researcher",
      toSessionId: "opencode:task:researcher",
      status: "failed",
      deliveryState: "failed",
      targetSessionState: "dispatching",
      resultState: "none",
      turnPolicy: "recover_or_stop",
      errorCode: "target_dispatch_in_progress",
      message: "Another Conductor dispatch is currently being recorded for this Session Agent. Wait for its receipt or outcome before assigning more work.",
    });
    assert.equal(dispatches.length, 0, "the racing intent must not create a second durable dispatch");

    releaseContext({ contextRefs: [], contextPackets: [] });
    const firstResult = await first;
    assert.equal(firstResult.ok, true);
    assert.equal(dispatches.length, 1);
    assert.deepEqual(validationInputs[0].contextRefs, ["result:review-1"]);
  });

  it("releases a cancelled worker after restart only when its persisted terminal incarnation exited", async () => {
    const workerSessionId = "opencode:task-1:publisher";
    const dispatches = [{
      dispatchId: "D-old",
      taskId: "task-1",
      agentId: "publisher",
      toSessionId: workerSessionId,
      status: "cancellation_requested",
      terminalIncarnationId: "inc-old",
      terminalGeneration: "7",
      cancellationReason: "scope_changed",
    }];
    const cancellations = [];
    let started = false;
    const coordinator = createDispatchCoordinator({
      sessionStore: {
        readTaskState: () => ({ dispatches }),
        markDispatchCancelled(input) {
          cancellations.push(input);
          const dispatch = dispatches.find((item) => item.dispatchId === input.dispatchId);
          dispatch.status = "cancelled";
          return { dispatchId: input.dispatchId, status: "cancelled", changed: true };
        },
        recordDispatch(input) {
          const dispatch = { ...input, dispatchId: "D-next", status: "queued" };
          dispatches.push(dispatch);
          return dispatch;
        },
        markDispatchInputAccepted(input) {
          const dispatch = dispatches.find((item) => item.dispatchId === input.dispatchId);
          dispatch.status = "input_accepted";
        },
      },
      ptyManager: {
        get: () => started ? { id: workerSessionId, status: "running", incarnationId: "inc-next", generation: 8 } : undefined,
        list: () => [],
      },
      readTerminalSessionFact: async () => ({
        workspaceSessionId: workerSessionId,
        state: "stopped",
        incarnationId: "inc-old",
        generation: 7,
      }),
      validateDispatch: () => ({ ok: !dispatches.some((item) => item.status === "cancellation_requested") }),
      resolveAgentSession: () => ({ agentId: "publisher", sessionId: workerSessionId }),
      prepareDispatchContext: () => ({ contextRefs: [], contextPackets: [] }),
      prepareWorkerSession: async () => ({ initialPromptSubmitted: false }),
      activateWorkerSession: async () => {
        started = true;
        return { session: { id: workerSessionId, status: "running", incarnationId: "inc-next", generation: 8 } };
      },
      enqueueWorkerInput: async () => ({ result: { accepted: true } }),
    });

    const result = await coordinator.callSession({ taskId: "task-1", agentId: "publisher", assignment: "Continue from the existing session." });

    assert.equal(result.ok, true);
    assert.deepEqual(cancellations, [{
      taskId: "task-1",
      sessionId: workerSessionId,
      dispatchId: "D-old",
      reason: "scope_changed",
      confirmation: "persisted_terminal_exit",
      message: "Terminal Runtime recorded the interrupted terminal generation as stopped for Dispatch D-old.",
    }]);
    assert.equal(dispatches.find((item) => item.dispatchId === "D-old")?.status, "cancelled");
    assert.equal(dispatches.find((item) => item.dispatchId === "D-next")?.status, "input_accepted");
  });

  it("does not free a cancelled worker merely because a different terminal generation exited", async () => {
    const dispatch = {
      dispatchId: "D-old",
      taskId: "task-1",
      toSessionId: "opencode:task-1:publisher",
      status: "cancellation_requested",
      terminalIncarnationId: "inc-old",
      terminalGeneration: "7",
    };
    const coordinator = createDispatchCoordinator({
      sessionStore: {
        readTaskState: () => ({ dispatches: [dispatch] }),
        markDispatchCancelled() { throw new Error("must not settle a different terminal incarnation"); },
      },
      readTerminalSessionFact: async () => ({ state: "stopped", incarnationId: "inc-new", generation: 8 }),
    });

    const result = await coordinator.reconcileRequestedCancellations({ taskId: "task-1", sessionId: dispatch.toSessionId });

    assert.deepEqual(result, [{ dispatchId: "D-old", status: "cancellation_requested" }]);
    assert.equal(dispatch.status, "cancellation_requested");
  });

  it("never interrupts a recovered terminal when cancelling a dispatch owned by an older incarnation", async () => {
    const workerSessionId = "opencode:task-1:publisher";
    const dispatch = {
      dispatchId: "D-old",
      taskId: "task-1",
      agentId: "publisher",
      toSessionId: workerSessionId,
      status: "input_accepted",
      terminalIncarnationId: "inc-before-restart",
      terminalGeneration: "gen-before-restart",
    };
    const cancellationRequests = [];
    const interrupts = [];
    const factRequests = [];
    const coordinator = createDispatchCoordinator({
      sessionStore: {
        readTaskState: () => ({ dispatches: [dispatch] }),
        markDispatchCancellationRequested(input) {
          cancellationRequests.push(input);
          dispatch.status = "cancellation_requested";
          dispatch.cancellationTerminalIncarnationId = input.terminalIncarnationId;
          dispatch.cancellationTerminalGeneration = input.terminalGeneration;
          return { status: dispatch.status, changed: true };
        },
        markDispatchCancelled(input) {
          dispatch.status = "cancelled";
          return { ...input, status: "cancelled", changed: true };
        },
      },
      ptyManager: {
        get: () => ({
          id: workerSessionId,
          status: "running",
          incarnationId: "inc-permission-recovery",
          generation: "gen-permission-recovery",
        }),
      },
      enqueueWorkerInput: async (input) => {
        interrupts.push(input);
        return { result: { accepted: true } };
      },
      readTerminalSessionFact: async (input) => {
        factRequests.push(input);
        return {
          workspaceSessionId: workerSessionId,
          state: "stopped",
          incarnationId: "inc-before-restart",
          generation: "gen-before-restart",
        };
      },
    });

    const result = await coordinator.cancelDispatch({ taskId: "task-1", dispatchId: "D-old", reason: "superseded" });

    assert.equal(result.status, "cancelled");
    assert.equal(result.terminalStatus, "different_incarnation_live");
    assert.deepEqual(interrupts, [], "the recovered permission TUI must not receive Ctrl-C for an older dispatch");
    assert.deepEqual(cancellationRequests, [{
      taskId: "task-1",
      sessionId: workerSessionId,
      dispatchId: "D-old",
      reason: "superseded",
      message: "Conductor requested cancellation of Dispatch D-old: superseded",
      terminalIncarnationId: "inc-before-restart",
      terminalGeneration: "gen-before-restart",
    }]);
    assert.deepEqual(factRequests, [{
      taskId: "task-1",
      workspaceSessionId: workerSessionId,
      incarnationId: "inc-before-restart",
      generation: "gen-before-restart",
    }]);
  });
});

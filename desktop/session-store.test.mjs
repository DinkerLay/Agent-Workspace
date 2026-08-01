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

    expect(view.state).toBe("ready");
    expect(view.cleanTranscriptTail).toBe("");
    expect(view.events.map((event) => event.type)).toEqual(["session.started"]);
    expect(fs.existsSync(path.join(root, "task-1", "sessions", "task-1-researcher", "transcript.raw.log"))).toBe(false);
    expect(fs.existsSync(path.join(root, "task-1", "sessions", "task-1-researcher", "transcript.clean.log"))).toBe(false);
    expect(fs.existsSync(path.join(root, "task-1", "sessions", "task-1-researcher", "snapshots", "latest.txt"))).toBe(false);
  });

  it("keeps Terminal and Provider owner facts separate and derives presentation state", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-workspace-session-owner-facts-"));
    const store = createSessionStore({ root });
    const session = { taskId: "task-owner", sessionId: "task-owner-researcher", command: "opencode", cwd: root };

    store.startSession(session);
    store.recordTerminalState(session, "running", "PTY is live.", { incarnationId: "inc-1" });
    store.recordProviderSessionState(session, "waiting_input", "OpenCode is waiting for an answer.", { questionId: "question-1" });

    let view = store.readSession(session);
    expect(view).toMatchObject({ state: "waiting_input", terminalState: "running", providerState: "waiting_input" });

    store.recordTerminalState(session, "exited", "PTY exited.", { incarnationId: "inc-1" });
    view = store.readSession(session);
    expect(view).toMatchObject({ state: "exited", terminalState: "exited", providerState: "waiting_input" });
    const persisted = JSON.parse(fs.readFileSync(path.join(root, "task-owner", "sessions", "task-owner-researcher", "state.json"), "utf8"));
    expect(Object.hasOwn(persisted, "state")).toBe(false);
  });

  it("projects one durable permission request until OpenCode confirms the user's reply", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-workspace-session-store-permission-"));
    const store = createSessionStore({ root });
    const session = { taskId: "task-1", sessionId: "task-1-researcher", command: "opencode", cwd: root };
    store.startSession(session);

    store.recordPermissionRequested({
      ...session,
      permissionId: "opencode:req-1",
      requestId: "req-1",
      provider: "opencode",
      permission: "bash",
      patterns: ["npm test"],
      summary: "OpenCode 请求运行 npm test。",
    });
    let state = store.readTaskState({ taskId: session.taskId });
    expect(state.permissions).toEqual([expect.objectContaining({ permissionId: "opencode:req-1", status: "requested", patterns: ["npm test"] })]);
    expect(state.pendingDecisions).toEqual([expect.objectContaining({ type: "permission_requested", permissionId: "opencode:req-1" })]);

    store.recordPermissionSubmitted({ ...session, permissionId: "opencode:req-1", response: "once" });
    state = store.readTaskState({ taskId: session.taskId });
    expect(state.permissions[0]).toMatchObject({ status: "submitted", response: "once" });

    store.recordPermissionResolved({ ...session, permissionId: "opencode:req-1", response: "once" });
    state = store.readTaskState({ taskId: session.taskId });
    expect(state.permissions[0]).toMatchObject({ status: "approved", response: "once" });
    expect(state.pendingDecisions).toEqual([]);
  });

  it("records one durable native-question answer and does not resurrect it from a stale waiting_input state", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-workspace-session-store-question-"));
    const store = createSessionStore({ root });
    const session = { taskId: "task-question", sessionId: "task-question-publisher", command: "opencode", cwd: root };
    store.startSession(session);
    store.recordState(session, "waiting_input", "OpenCode asks for a destination.", {
      provider: "opencode",
      providerQuestionPartId: "question-1",
      question: "Write the report to the selected folder?",
    });

    const first = store.recordQuestionResponseSubmitted({ ...session, questionId: "question-1", answer: "Yes, write it." });
    const repeated = store.recordQuestionResponseSubmitted({ ...session, questionId: "question-1", answer: "A different retry must not replace it." });
    const state = store.readTaskState({ taskId: session.taskId });

    expect(first).toMatchObject({ questionId: "question-1", answer: "Yes, write it.", status: "submitted", changed: true });
    expect(repeated).toMatchObject({ questionId: "question-1", answer: "Yes, write it.", status: "submitted", changed: false });
    expect(state.questionResponses).toEqual([expect.objectContaining({ sessionId: session.sessionId, questionId: "question-1", answer: "Yes, write it.", status: "submitted" })]);
    expect(store.readSession(session).events.filter((event) => event.type === "question.response_submitted")).toHaveLength(1);
  });

  it("moves a retained scoped permission decision onto OpenCode's reissued request without duplicating the Task action", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-workspace-session-store-permission-recovery-"));
    const store = createSessionStore({ root });
    const session = { taskId: "task-permission-recovery", sessionId: "task-permission-recovery-publisher", command: "opencode", cwd: root };
    store.startSession(session);
    store.recordPermissionRequested({
      ...session,
      permissionId: "opencode:req-recover",
      requestId: "req-recover",
      provider: "opencode",
      permission: "external_directory",
      patterns: ["/tmp/output"],
      summary: "OpenCode 请求写入项目输出目录。",
    });

    const queued = store.recordPermissionRecoveryPending({ ...session, permissionId: "opencode:req-recover", response: "once" });
    expect(queued).toMatchObject({ status: "recovery_pending", response: "once" });
    const reissuedAsk = store.recordPermissionRequested({
      ...session,
      permissionId: "opencode:req-recover-new",
      requestId: "req-recover-new",
      provider: "opencode",
      permission: "external_directory",
      patterns: ["/tmp/output"],
      summary: "OpenCode 请求写入项目输出目录。",
    });
    expect(reissuedAsk).toMatchObject({
      permissionId: "opencode:req-recover-new",
      status: "replaying",
      response: "once",
      replayedFromPermissionIds: ["opencode:req-recover"],
    });
    const state = store.readTaskState({ taskId: session.taskId });
    expect(state.permissions).toEqual(expect.arrayContaining([
      expect.objectContaining({ permissionId: "opencode:req-recover", status: "reissued", reissuedByPermissionId: "opencode:req-recover-new" }),
      expect.objectContaining({ permissionId: "opencode:req-recover-new", status: "replaying", response: "once" }),
    ]));
    expect(state.pendingDecisions).toEqual([]);
    expect(state.events.some((event) => event.type === "permission.reissued")).toBe(true);
    expect(JSON.stringify(state)).not.toContain("replyToken");

    // Repeated Host/Provider restarts must move the same logical choice
    // forward, not resurrect an older recovery_pending card beside it.
    store.recordPermissionRecoveryPending({ ...session, permissionId: "opencode:req-recover-new", response: "once" });
    const reissuedAgain = store.recordPermissionRequested({
      ...session,
      permissionId: "opencode:req-recover-latest",
      requestId: "req-recover-latest",
      provider: "opencode",
      permission: "external_directory",
      patterns: ["/tmp/output"],
      summary: "OpenCode 再次请求写入输出目录。",
    });
    expect(reissuedAgain).toMatchObject({ status: "replaying", response: "once" });
    const repeatedState = store.readTaskState({ taskId: session.taskId });
    expect(repeatedState.permissions.filter((permission) => permission.status !== "reissued")).toEqual([
      expect.objectContaining({ permissionId: "opencode:req-recover-latest", status: "replaying", response: "once" }),
    ]);
    expect(repeatedState.pendingDecisions).toEqual([]);
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

    expect(view.events.map((event) => event.type)).toEqual(["session.started", "session.blocked", "session.ready"]);
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

  it("publishes durable semantic invalidations without publishing raw PTY output", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-workspace-session-store-change-events-"));
    const store = createSessionStore({ root });
    const changes = [];
    const unsubscribe = store.onTaskChange((change) => changes.push(change));
    const session = {
      taskId: "task-1",
      sessionId: "task-1-researcher",
      command: "opencode",
      cwd: root,
      provider: "opencode",
    };

    store.startSession(session);
    store.recordOutput(session, "raw terminal repaint");
    store.recordState(session, "blocked", "Provider needs a decision.");
    store.recordState(session, "blocked", "Provider needs a decision.");
    unsubscribe();
    store.recordState(session, "ready", "No subscriber should observe this.");

    expect(changes.map((change) => change.type)).toEqual(["session.started", "session.blocked"]);
    expect(changes.every((change) => change.taskId === "task-1" && change.sessionId === "task-1-researcher")).toBe(true);
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

    expect(store.readEvents({ taskId: "task-1" }).map((event) => event.type)).toEqual(["session.started"]);
    const view = store.readSession({ taskId: "task-1", sessionId: "task-1-researcher" });
    expect(view.events.map((event) => event.type)).toEqual(["session.started"]);
    expect(view.cursor).toBe(200);
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
    expect(view.events.map((event) => event.type)).toEqual(["dispatch.created", "dispatch.provider.received", "provider.running"]);
  });

  it("keeps a cancellation pending until a terminal or Provider confirmation records it", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-workspace-dispatch-cancellation-"));
    const store = createSessionStore({ root });
    const dispatch = store.recordDispatch({
      taskId: "task-1",
      toSessionId: "task-1-researcher",
      assignment: "Research the claim.",
    });
    store.markDispatchInputAccepted({ taskId: "task-1", sessionId: "task-1-researcher", dispatchId: dispatch.dispatchId, transport: "terminal_runtime" });

    const requested = store.markDispatchCancellationRequested({
      taskId: "task-1",
      sessionId: "task-1-researcher",
      dispatchId: dispatch.dispatchId,
      reason: "scope_changed",
    });
    expect(requested).toMatchObject({ status: "cancellation_requested", changed: true });
    expect(store.readSession({ taskId: "task-1", sessionId: "task-1-researcher" }).dispatches[0]).toMatchObject({ status: "cancellation_requested" });
    store.recordState(
      { taskId: "task-1", sessionId: "task-1-researcher" },
      "exited",
      "PTY process exited while cancellation was pending.",
      { reason: "pty_process_exited" },
    );
    expect(store.readTaskState({ taskId: "task-1" }).pendingDecisions).toContainEqual(expect.objectContaining({ actionHint: "restart_or_recover" }));

    const confirmed = store.markDispatchCancelled({
      taskId: "task-1",
      sessionId: "task-1-researcher",
      dispatchId: dispatch.dispatchId,
      reason: "scope_changed",
      confirmation: "terminal_exit",
    });
    const view = store.readSession({ taskId: "task-1", sessionId: "task-1-researcher" });

    expect(confirmed).toMatchObject({ status: "cancelled", changed: true });
    expect(view.dispatches[0]).toMatchObject({ status: "cancelled", cancellationConfirmation: "terminal_exit" });
    expect(view.events.map((event) => event.type)).toContain("dispatch.cancellation_requested");
    expect(view.events.map((event) => event.type)).toContain("dispatch.cancelled");
    expect(view.state).toBe("exited");
    expect(store.readTaskState({ taskId: "task-1" }).pendingDecisions.some((decision) => decision.actionHint === "restart_or_recover")).toBe(true);
  });

  it("keeps an OpenCode Session binding after later terminal state updates", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-workspace-provider-binding-"));
    const store = createSessionStore({ root });
    const dispatch = store.recordDispatch({
      taskId: "task-1",
      toSessionId: "task-1-publisher",
      assignment: "Create the requested artifact.",
    });

    store.markDispatchProviderReceived({
      taskId: "task-1",
      sessionId: "task-1-publisher",
      dispatchId: dispatch.dispatchId,
      provider: "opencode",
      providerSessionId: "ses_publisher_original",
      providerMessageId: "msg_original",
    });
    store.recordState(
      { taskId: "task-1", sessionId: "task-1-publisher" },
      "exited",
      "PTY process exited.",
      { reason: "pty_process_exited" },
    );

    const session = store.readTaskState({ taskId: "task-1" }).sessions.find((item) => item.sessionId === "task-1-publisher");
    expect(session?.providerBinding).toMatchObject({
      provider: "opencode",
      providerSessionId: "ses_publisher_original",
    });
  });

  it("projects a single runtime state from session and dispatch lifecycle", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-workspace-session-runtime-state-"));
    const store = createSessionStore({ root });
    const session = {
      taskId: "task-1",
      sessionId: "task-1-reviewer",
      command: "opencode",
      cwd: root,
      provider: "opencode",
    };

    store.startSession(session);
    expect(store.readSession({ taskId: "task-1", sessionId: "task-1-reviewer" }).state).toBe("ready");

    const dispatch = store.recordDispatch({
      taskId: "task-1",
      toSessionId: "task-1-reviewer",
      assignment: "Review the research output.",
    });
    expect(store.readSession({ taskId: "task-1", sessionId: "task-1-reviewer" }).state).toBe("queued");

    store.markDispatchDelivered({
      taskId: "task-1",
      sessionId: "task-1-reviewer",
      dispatchId: dispatch.dispatchId,
    });
    expect(store.readSession({ taskId: "task-1", sessionId: "task-1-reviewer" }).state).toBe("running");

    store.recordDispatchResult({
      taskId: "task-1",
      sessionId: "task-1-reviewer",
      dispatchId: dispatch.dispatchId,
      reason: "provider-turn-completed",
      provider: "opencode",
      providerSessionId: "ses_reviewer",
      providerMessageId: "msg_review",
      answerText: "Review pass.",
      source: "opencode-message-parts",
    });

    const view = store.readTaskState({ taskId: "task-1" });
    expect(view.sessions[0]).toMatchObject({
      sessionId: "task-1-reviewer",
      state: "result_available",
    });
    expect(view.dispatches[0]).toMatchObject({
      dispatchId: dispatch.dispatchId,
      status: "result_available",
    });
  });

  it("keeps result facts visible when a later dispatch fails", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-workspace-session-runtime-composite-state-"));
    const store = createSessionStore({ root });
    const sessionId = "task-1-researcher";
    const firstDispatch = store.recordDispatch({
      taskId: "task-1",
      toSessionId: sessionId,
      assignment: "Research the first pass.",
    });
    store.markDispatchDelivered({
      taskId: "task-1",
      sessionId,
      dispatchId: firstDispatch.dispatchId,
    });
    const firstResult = store.recordDispatchResult({
      taskId: "task-1",
      sessionId,
      dispatchId: firstDispatch.dispatchId,
      reason: "provider-answer-available",
      provider: "opencode",
      providerSessionId: "ses_worker",
      providerMessageId: "msg_first",
      answerText: "First pass result is available.",
      source: "opencode-message-parts",
    });
    const secondDispatch = store.recordDispatch({
      taskId: "task-1",
      toSessionId: sessionId,
      assignment: "Research the second pass.",
    });
    store.markDispatchFailed({
      taskId: "task-1",
      sessionId,
      dispatchId: secondDispatch.dispatchId,
      reason: "target_session_delivery_timeout",
      message: "Target session did not confirm delivery.",
    });

    const taskState = store.readTaskState({ taskId: "task-1" });
    const session = taskState.sessions.find((item) => item.sessionId === sessionId);
    const resultDecision = taskState.pendingDecisions.find((item) => item.type === "worker_result_available");
    const failedDecision = taskState.pendingDecisions.find((item) => item.type === "dispatch_failed");

    expect(session).toMatchObject({
      sessionId,
      state: "result_available",
      activeDispatchId: secondDispatch.dispatchId,
      lastResultId: firstResult.resultId,
      resultCount: 1,
      unresolvedFailureDispatchId: secondDispatch.dispatchId,
      assignmentReadinessHint: "ready",
    });
    expect(session.attentionHints).toContain("dispatch_failed");
    expect(session.attentionHints).toContain("result_available");
    expect(resultDecision).toMatchObject({
      type: "worker_result_available",
      dispatchId: firstDispatch.dispatchId,
      sessionId,
      resultId: firstResult.resultId,
      severity: "info",
    });
    expect(failedDecision).toMatchObject({
      type: "dispatch_failed",
      dispatchId: secondDispatch.dispatchId,
      sessionId,
      severity: "blocking",
      actionHint: "inspect_dispatch_failure",
    });
  });

  it("clears a result inbox item only after its exact Conductor wakeup is observed", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-workspace-result-inbox-observed-"));
    const store = createSessionStore({ root });
    const sessionId = "task-1-researcher";
    const dispatch = store.recordDispatch({
      taskId: "task-1",
      toSessionId: sessionId,
      assignment: "Return the source evidence.",
    });
    store.markDispatchDelivered({ taskId: "task-1", sessionId, dispatchId: dispatch.dispatchId });
    const result = store.recordDispatchResult({
      taskId: "task-1",
      sessionId,
      dispatchId: dispatch.dispatchId,
      provider: "opencode",
      providerSessionId: "ses-researcher",
      providerMessageId: "msg-result",
      answerText: "The complete native worker result.",
      source: "opencode-message-parts",
    });
    const wakeup = {
      taskId: "task-1",
      sessionId: "task-1-conductor",
      wakeupKey: `result:${dispatch.dispatchId}`,
      kind: "result",
      workerSessionId: sessionId,
      dispatchId: dispatch.dispatchId,
      resultId: result.resultId,
      status: "sent",
    };
    store.recordConductorWakeup(wakeup);

    expect(store.readTaskState({ taskId: "task-1" }).pendingDecisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "worker_result_available",
          dispatchId: dispatch.dispatchId,
          resultId: result.resultId,
        }),
      ]),
    );

    store.markConductorWakeupObserved({ ...wakeup, provider: "opencode", providerMessageId: "msg-conductor-input" });
    const stateAfterObservation = store.readTaskState({ taskId: "task-1" });

    expect(stateAfterObservation.pendingDecisions.some((item) => item.type === "worker_result_available")).toBe(false);
    expect(stateAfterObservation.results).toEqual(
      expect.arrayContaining([expect.objectContaining({ resultId: result.resultId, answerText: "The complete native worker result." })]),
    );
  });

  it("requeues only a legacy user wakeup that was marked sent without a Provider receipt", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-workspace-legacy-user-wakeup-"));
    const store = createSessionStore({ root });
    const wakeup = {
      taskId: "task-1",
      sessionId: "task-1-conductor",
      wakeupKey: "user:task-1:message-1",
      kind: "user_message",
      userMessageId: "message-1",
      messageText: "Continue the current task.",
      status: "sent",
    };

    store.recordConductorWakeup(wakeup);
    const retried = store.recordConductorWakeup({
      ...wakeup,
      status: "queued",
      retryLegacyUnconfirmed: true,
    });
    expect(retried.status).toBe("queued");
    expect(retried.sentAt).toBe(undefined);
    expect(store.listPendingConductorWakeups({ taskId: "task-1" })).toEqual(
      [expect.objectContaining({ wakeupKey: wakeup.wakeupKey, status: "queued" })],
    );

    store.markConductorWakeupObserved({
      ...wakeup,
      provider: "opencode",
      providerMessageId: "msg-user-input",
    });
    const protectedReceipt = store.recordConductorWakeup({
      ...wakeup,
      status: "queued",
      retryLegacyUnconfirmed: true,
    });
    expect(protectedReceipt.status).toBe("observed");
    expect(protectedReceipt.providerMessageId).toBe("msg-user-input");
  });

  it("does not hide an earlier failed dispatch when a later dispatch returns a result", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-workspace-session-runtime-failure-then-result-"));
    const store = createSessionStore({ root });
    const sessionId = "task-1-researcher";
    const failedDispatch = store.recordDispatch({
      taskId: "task-1",
      toSessionId: sessionId,
      assignment: "Research an unavailable source.",
    });
    store.markDispatchFailed({
      taskId: "task-1",
      sessionId,
      dispatchId: failedDispatch.dispatchId,
      reason: "target_session_start_failed",
      message: "The first assignment was not started.",
    });
    const succeedingDispatch = store.recordDispatch({
      taskId: "task-1",
      toSessionId: sessionId,
      assignment: "Research a different source.",
    });
    store.markDispatchDelivered({
      taskId: "task-1",
      sessionId,
      dispatchId: succeedingDispatch.dispatchId,
    });
    const result = store.recordDispatchResult({
      taskId: "task-1",
      sessionId,
      dispatchId: succeedingDispatch.dispatchId,
      reason: "provider-answer-available",
      answerText: "The second assignment completed.",
      source: "opencode-message-parts",
    });

    const taskState = store.readTaskState({ taskId: "task-1" });
    const session = taskState.sessions.find((item) => item.sessionId === sessionId);

    expect(session).toMatchObject({
      state: "result_available",
      lastResultId: result.resultId,
      unresolvedFailureDispatchId: failedDispatch.dispatchId,
    });
    expect(session.attentionHints).toContain("dispatch_failed");
    expect(taskState.pendingDecisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "dispatch_failed",
          dispatchId: failedDispatch.dispatchId,
          actionHint: "inspect_dispatch_failure",
        }),
        expect.objectContaining({
          type: "worker_result_available",
          dispatchId: succeedingDispatch.dispatchId,
          resultId: result.resultId,
        }),
      ]),
    );
  });

  it("keeps pure delivery failures non-deliverable when no prior result exists", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-workspace-session-runtime-pure-delivery-failure-"));
    const store = createSessionStore({ root });
    const sessionId = "task-1-researcher";
    const dispatch = store.recordDispatch({
      taskId: "task-1",
      toSessionId: sessionId,
      assignment: "Research without a prior result.",
    });
    store.markDispatchFailed({
      taskId: "task-1",
      sessionId,
      dispatchId: dispatch.dispatchId,
      reason: "target_session_delivery_timeout",
      message: "Target session did not confirm delivery.",
    });

    const taskState = store.readTaskState({ taskId: "task-1" });
    const session = taskState.sessions.find((item) => item.sessionId === sessionId);

    expect(session).toMatchObject({
      sessionId,
      state: "delivery_failed",
      resultCount: 0,
      unresolvedFailureDispatchId: dispatch.dispatchId,
      assignmentReadinessHint: "not_ready",
    });
  });

  it("keeps result facts visible when the provider process later exits", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-workspace-session-runtime-result-then-exit-"));
    const store = createSessionStore({ root });
    const session = {
      taskId: "task-1",
      sessionId: "task-1-reviewer",
      command: "opencode",
      cwd: root,
      provider: "opencode",
    };
    store.startSession(session);
    const dispatch = store.recordDispatch({
      taskId: "task-1",
      toSessionId: session.sessionId,
      assignment: "Review the report.",
    });
    store.markDispatchDelivered({
      taskId: "task-1",
      sessionId: session.sessionId,
      dispatchId: dispatch.dispatchId,
    });
    const result = store.recordDispatchResult({
      taskId: "task-1",
      sessionId: session.sessionId,
      dispatchId: dispatch.dispatchId,
      reason: "provider-answer-available",
      answerText: "Review result is available.",
    });
    store.recordState(session, "exited", "PTY exited after result.");

    const taskState = store.readTaskState({ taskId: "task-1" });
    const sessionSummary = taskState.sessions.find((item) => item.sessionId === session.sessionId);

    expect(sessionSummary).toMatchObject({
      sessionId: session.sessionId,
      state: "exited",
      lastResultId: result.resultId,
      resultCount: 1,
      assignmentReadinessHint: "not_ready",
    });
    expect(sessionSummary.attentionHints).toContain("result_available");
    expect(taskState.pendingDecisions.find((item) => item.type === "worker_result_available")).toMatchObject({
      dispatchId: dispatch.dispatchId,
      resultId: result.resultId,
      severity: "info",
    });
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

  it("records pre-dispatch route validation failures as task runtime evidence", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-workspace-dispatch-route-failed-"));
    const store = createSessionStore({ root });

    const event = store.recordDispatchFailure({
      taskId: "task-1",
      toSessionId: "task-1-forbidden",
      assignment: "Bypass route policy.",
      reason: "route-not-allowed",
      message: "Dispatch target is outside the allowed worker set.",
    });

    const view = store.readTaskState({ taskId: "task-1" });

    expect(event).toMatchObject({
      taskId: "task-1",
      sessionId: "task-1-forbidden",
      type: "dispatch.failed",
      data: {
        dispatchId: "",
        toSessionId: "task-1-forbidden",
        reason: "route-not-allowed",
        message: "Dispatch target is outside the allowed worker set.",
      },
    });
    expect(view.events.map((item) => item.type)).toEqual(["dispatch.failed"]);
  });

  it("records Conductor messages and task completion claims as task events", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-workspace-conductor-message-"));
    const store = createSessionStore({ root });

    store.recordConductorMessage({
      taskId: "task-1",
      sessionId: "task-1-conductor",
      message: "两分支均通过，任务收口。",
      summary: "Conductor final summary",
    });
    store.recordTaskCompletionClaim({
      taskId: "task-1",
      sessionId: "task-1-conductor",
      message: "任务完成，等待 Review gate。",
    });

    const view = store.readTaskState({ taskId: "task-1" });

    expect(view.events.map((item) => item.type)).toEqual(["conductor.message", "task.completion_claim"]);
    expect(view.events[0].data.message).toBe("两分支均通过，任务收口。");
    expect(view.events[1].data.message).toBe("任务完成，等待 Review gate。");
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

    expect(events.map((event) => event.type)).toEqual(["session.started"]);
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

  it("deduplicates Task/Run outbox publication by its stable source event id", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-workspace-task-outbox-event-"));
    const store = createSessionStore({ root });
    const input = {
      eventId: "outbox-command-1-task-started",
      taskId: "task-1",
      sessionId: "task-1-conductor",
      cwd: root,
      type: "task.run.started",
      summary: "Started once.",
      data: { runId: "run-1" },
    };

    const first = store.recordTaskEvent(input);
    const replay = store.recordTaskEvent(input);
    expect(replay).toEqual(first);
    expect(first).toMatchObject({ sourceEventId: input.eventId, cursor: 1 });
    expect(store.readTaskState({ taskId: "task-1" }).events).toEqual([first]);
    expect(store.readSession({ taskId: "task-1", sessionId: "task-1-conductor" }).events).toEqual([first]);
  });

  it("bounds JSONL event view reads to a tail window without truncating durable task events", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-workspace-task-event-tail-"));
    const store = createSessionStore({ root, jsonlReadTailBytes: 260 });

    for (let index = 0; index < 20; index += 1) {
      store.recordTaskEvent({
        taskId: "task-1",
        sessionId: "task-1-conductor",
        cwd: root,
        type: "user.intervention",
        summary: `event ${index}`,
        data: {
          message: `message ${index} ${"x".repeat(40)}`,
        },
      });
    }

    const taskState = store.readTaskState({ taskId: "task-1" });
    const events = store.readEvents({ taskId: "task-1", sinceCursor: 0 });
    const taskEventsPath = path.join(root, "task-1", "events.jsonl");
    const durableEventLines = fs.readFileSync(taskEventsPath, "utf8").trim().split("\n");

    expect(durableEventLines).toHaveLength(20);
    expect(taskState.events.at(-1)).toMatchObject({ cursor: 20, summary: "event 19" });
    expect(events.at(-1)).toMatchObject({ cursor: 20, summary: "event 19" });
    expect(taskState.events[0].cursor).toBeGreaterThan(1);
    expect(events[0].cursor).toBeGreaterThan(1);
  });

  it("removes OpenTUI string control sequences from clean transcript text", () => {
    const noisy = "\u001bP$qm\u001b\\visible\u001b_Gi=31337;name=box\u001b\\\u001b[31mred\u001b[0m\rnext";

    expect(stripTerminalControls(noisy)).toBe("visiblered\nnext");
  });

  it("keeps raw terminal bytes outside the semantic transcript", () => {
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
    const log = store.readTerminalLog({ taskId: "task-1", sessionId: "task-1-conductor" });

    expect(view.cleanTranscriptTail).toBe("");
    expect(view.events.map((event) => event.type)).toEqual(["session.started"]);
    expect(log.content).toBe("\u001b[31mhello\u001b[0m\n");
    expect(log.truncated).toBe(false);
  });

  it("bounds persisted raw terminal output without creating semantic events", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-workspace-terminal-log-bound-"));
    const store = createSessionStore({ root, terminalLogMaxBytes: 8 });
    const session = { taskId: "task-1", sessionId: "task-1-worker", command: "opencode", cwd: root };

    store.startSession(session);
    store.recordOutput(session, "12345");
    store.recordOutput(session, "67890");

    expect(store.readTerminalLog({ taskId: "task-1", sessionId: "task-1-worker" })).toMatchObject({
      content: "34567890",
      bytes: 8,
      truncated: true,
    });
    expect(store.readSession({ taskId: "task-1", sessionId: "task-1-worker" }).events.map((event) => event.type)).toEqual(["session.started"]);
  });
});

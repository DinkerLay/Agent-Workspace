const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { createConductorToolBridge, startConductorToolBridgeHttpServer } = require("./conductor-tool-bridge.cjs");
const { generateAgentLoopTemplate } = require("./agent-loop-template-assistant.cjs");
const { ensureNodePtySpawnHelperExecutable } = require("./node-pty-runtime.cjs");
const { createOpenCodeProviderObserver } = require("./opencode/opencode-provider-observer.cjs");
const { resolveOpencodePath } = require("./opencode-runner.cjs");
const { createAgentLoopV1Runtime } = require("./runtime/agent-loop-v1-runtime.cjs");
const { createOrcaTerminalDaemonManager } = require("./runtime/orca-terminal-daemon-manager.cjs");
const { createOrcaTerminalDaemonSupervisor } = require("./runtime/orca-terminal-daemon-supervisor.cjs");
const { createSessionAuthority } = require("./runtime/session-authority.cjs");
const { createSessionStore } = require("./session-store.cjs");
const { createSessionWakeupMonitor } = require("./session-wakeup-monitor.cjs");

const MODEL = "opencode-go/deepseek-v4-flash";
const SCENARIO = ["delivery", "correction", "attention", "review_handoff", "deepsearch", "continuation", "worker_wakeup_recovery"].includes(process.env.AGENT_LOOP_REAL_CONDUCTOR_SCENARIO)
  ? process.env.AGENT_LOOP_REAL_CONDUCTOR_SCENARIO
  : "delivery";
const GENERATE_TEMPLATE = process.env.AGENT_LOOP_REAL_GENERATE_TEMPLATE === "1";
const DEEPSEARCH_SOURCE_MIRROR = path.join(__dirname, "fixtures", "deepsearch-source-mirror");
// This is harness-only liveness protection. Production wakeup logic has no
// wall-clock completion timeout and never changes Task state on elapsed time.
const HARNESS_LIMIT_MS = ["review_handoff", "deepsearch"].includes(SCENARIO) ? 420_000 : 180_000;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(reader, description) {
  const deadline = Date.now() + HARNESS_LIMIT_MS;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await reader();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(500);
  }
  throw new Error(`${description} was not observed within the real-conductor harness limit.${lastError ? ` Last error: ${lastError.message}` : ""}`);
}

function describeTerminals(terminalRuntime) {
  return terminalRuntime.list().map((session) => ({
    id: session.id,
    status: session.status,
    cursor: session.cursor,
    args: session.args,
  }));
}

function turnForAgent(runtimeView, agentId) {
  return runtimeView?.turns?.find((turn) => turn.nodeId === agentId);
}

function resultForDispatch(runtimeView, dispatch) {
  return (runtimeView?.runtimeState?.results ?? []).find((result) => result.dispatchId === dispatch?.dispatchId);
}

function assertReviewHandoff(runtimeView) {
  const searcher = turnForAgent(runtimeView, "searcher");
  const reviewer = turnForAgent(runtimeView, "reviewer");
  const publisher = turnForAgent(runtimeView, "publisher");
  const [initialSearch, correctedSearch] = searcher?.details?.dispatches ?? [];
  const [initialReview, passingReview] = reviewer?.details?.dispatches ?? [];
  const [publish] = publisher?.details?.dispatches ?? [];
  assert.ok(initialSearch && correctedSearch, "Conductor must dispatch Searcher before and after the Review message");
  assert.ok(initialReview && passingReview, "Conductor must dispatch Reviewer for the initial finding and later confirmation");
  assert.ok(publish, "Conductor must explicitly dispatch Publisher");

  const searchDraft = resultForDispatch(runtimeView, initialSearch);
  const reviewNeedsChanges = resultForDispatch(runtimeView, initialReview);
  const searchCorrection = resultForDispatch(runtimeView, correctedSearch);
  const reviewPass = resultForDispatch(runtimeView, passingReview);
  assert.ok(searchDraft?.answerText, "initial Searcher must return a durable Provider message");
  assert.ok(reviewNeedsChanges?.answerText, "Reviewer must return a durable Provider message");
  assert.ok(searchCorrection?.answerText, "corrected Searcher must return a durable Provider message");
  assert.ok(reviewPass?.answerText, "passing Reviewer must return a durable Provider message");
  assert.match(reviewNeedsChanges.answerText, /needs changes/i, "Reviewer conclusion remains normal message content");

  assert.deepEqual(initialReview.contextRefs, [`result:${searchDraft.resultId}`]);
  assert.equal(initialReview.contextPackets?.[0]?.answerText, searchDraft.answerText, "Reviewer receives the exact Searcher answer, not a Conductor retelling");
  assert.deepEqual(correctedSearch.contextRefs, [`result:${reviewNeedsChanges.resultId}`]);
  assert.equal(correctedSearch.contextPackets?.[0]?.answerText, reviewNeedsChanges.answerText, "corrective Searcher receives the exact Reviewer message");
  assert.deepEqual(passingReview.contextRefs, [`result:${searchCorrection.resultId}`, `result:${reviewNeedsChanges.resultId}`]);
  assert.deepEqual(publish.contextRefs, [`result:${searchCorrection.resultId}`, `result:${reviewPass.resultId}`]);
  assert.equal(publish.contextPackets?.[0]?.answerText, searchCorrection.answerText, "Publisher receives selected corrected evidence verbatim");
  assert.equal(publish.contextPackets?.[1]?.answerText, reviewPass.answerText, "Publisher receives selected passing Review verbatim");
}

async function runContinuationE2E({ runtime, sessionStore, terminalRuntime, terminalWriteAudit, databasePath, taskId, scenario }) {
  const readConductor = () => {
    const task = runtime.readTask({ taskId });
    const runtimeView = task?.latestRun ? runtime.readRun({ runId: task.latestRun.runId }) : undefined;
    const conductor = turnForAgent(runtimeView, "conductor");
    const state = runtimeView?.runtimeState;
    const conductorMessages = (state?.events ?? []).filter(
      (event) => event.type === "conductor.message" && event.sessionId === conductor?.sessionId,
    );
    return { task, runtimeView, conductor, state, conductorMessages };
  };

  const initial = await waitFor(() => {
    const snapshot = readConductor();
    const message = snapshot.conductorMessages.find((event) => String(event.data?.message ?? "").includes(scenario.initialToken));
    const providerSessionId = String(message?.data?.providerSessionId ?? "");
    if (!snapshot.conductor || !message || !providerSessionId) return undefined;
    return { ...snapshot, message, providerSessionId };
  }, "initial native Conductor Provider result");
  await assertLiveOpenCodeTui({
    terminalRuntime,
    sessionId: initial.conductor.sessionId,
    phase: "initial Conductor turn",
  });

  const userMessage = [
    "This is a Task-page continuation acceptance test.",
    `Reply with the exact token ${scenario.continuationToken} in your visible Conductor response.`,
    "Do not dispatch a Session Agent, create an artifact, or claim task completion.",
  ].join(" ");
  // This is the exact persisted shape left by the former desktop build:
  // the Timeline has one user message, SQLite calls it delivered, and the
  // matching wakeup says sent despite having no Provider receipt. The native
  // PTY has already exited. A real Task-page Send must reclaim this exact
  // Input ID and continue the existing Provider conversation.
  const legacyMessageId = `legacy-message-${Date.now()}`;
  const legacyInputId = `user:${taskId}:${legacyMessageId}`;
  const legacyTimestamp = new Date().toISOString();
  const legacyDb = new DatabaseSync(databasePath);
  const latestSequence = legacyDb.prepare("SELECT COALESCE(MAX(sequence), 0) AS sequence FROM agent_loop_events WHERE run_id = ?").get(initial.runtimeView.run.runId).sequence;
  legacyDb.prepare(
    "INSERT INTO agent_loop_user_messages (message_id, task_id, run_id, message, status, created_at, delivered_at) VALUES (?, ?, ?, ?, 'delivered', ?, ?)",
  ).run(legacyMessageId, taskId, initial.runtimeView.run.runId, userMessage, legacyTimestamp, legacyTimestamp);
  legacyDb.prepare(
    "INSERT INTO agent_loop_events (run_id, sequence, type, summary, data_json, created_at) VALUES (?, ?, 'task.user_message', ?, ?, ?)",
  ).run(initial.runtimeView.run.runId, Number(latestSequence) + 1, userMessage.slice(0, 240), JSON.stringify({ message: userMessage, messageId: legacyMessageId }), legacyTimestamp);
  legacyDb.close();
  sessionStore.recordTaskEvent({
    taskId,
    sessionId: initial.conductor.sessionId,
    cwd: initial.task.cwd,
    type: "task.user_message",
    summary: userMessage.slice(0, 240),
    data: { message: userMessage, messageId: legacyMessageId },
  });
  sessionStore.recordConductorWakeup({
    taskId,
    sessionId: initial.conductor.sessionId,
    wakeupKey: legacyInputId,
    kind: "user_message",
    userMessageId: legacyMessageId,
    messageText: userMessage,
    status: "sent",
    reason: "Legacy false-success fixture: PTY start was mistaken for delivery.",
  });
  const initialTerminal = terminalRuntime.get(initial.conductor.sessionId);
  if (initialTerminal?.status === "running") {
    await terminalRuntime.stop(initial.conductor.sessionId, { expectedIncarnationId: initialTerminal.incarnationId });
  }
  await waitFor(
    () => terminalRuntime.get(initial.conductor.sessionId)?.status !== "running" ? true : undefined,
    "the legacy Conductor PTY to exit before Task-page Send",
  );

  const submitted = await runtime.recordUserMessage({ taskId, message: userMessage });
  assert.equal(submitted.ok, true);
  assert.equal(submitted.retried, true, "Send must reclaim the historical unconfirmed input instead of creating another user message");
  assert.equal(submitted.messageId, legacyMessageId, "the retry must preserve the original Provider input identity");
  assert.equal(submitted.wakeup.delivered, 0, "a PTY write/start must not be treated as a Provider receipt");
  assert.equal(submitted.wakeup.queued, 1, "the task input must remain pending until OpenCode records it");

  await waitFor(() => {
    const writes = terminalWriteAudit.filter((entry) => entry.id === initial.conductor.sessionId);
    const pasted = writes.find((entry) => entry.payload.includes(`Conductor Input ID ${legacyInputId}`));
    const submittedReturn = writes.find((entry) => entry.payload === "\r");
    return pasted && submittedReturn ? { pasted, submittedReturn } : undefined;
  }, "two-phase TUI delivery to the recovered Conductor");

  const inputId = legacyInputId;
  const continued = await waitFor(() => {
    const snapshot = readConductor();
    const wakeup = (snapshot.state?.wakeups ?? []).find((entry) => entry.wakeupKey === inputId);
    const output = snapshot.conductorMessages.find(
      (event) => event.data?.providerMessageId !== initial.message.data?.providerMessageId
        && String(event.data?.message ?? "").includes(scenario.continuationToken),
    );
    if (wakeup?.status !== "observed" || !output) return undefined;
    return { ...snapshot, wakeup, output };
  }, "exact user-input Provider receipt and a new Conductor response");

  assert.equal(continued.wakeup.providerSessionId, initial.providerSessionId, "continuation must reuse the original Provider conversation");
  assert.ok(continued.wakeup.providerMessageId, "OpenCode must expose the exact user-input receipt message id");
  assert.notEqual(continued.output.data?.providerMessageId, initial.message.data?.providerMessageId, "continuation must produce a new Provider turn");
  assert.match(String(continued.output.data?.message ?? ""), new RegExp(escapeRegExp(scenario.continuationToken)));
  assert.equal(continued.task.status, "running");
  assert.equal(continued.runtimeView.run.status, "running");
  assert.equal(
    continued.state.events.some((event) => event.type === "task.user_message" && String(event.data?.message ?? "") === userMessage),
    true,
    "the original Task input must remain visible in durable Timeline history",
  );
  assert.equal(
    continued.runtimeView.events.some((event) => event.type === "task.user_message_retrying" && event.data?.retryOfMessageId === legacyMessageId),
    true,
    "the retry must be visible as a transport fact, not a second blue user message",
  );

  const terminal = terminalRuntime.list().find((entry) => entry.id === continued.conductor.sessionId);
  const finalTui = await assertLiveOpenCodeTui({
    terminalRuntime,
    sessionId: continued.conductor.sessionId,
    expectedProviderSessionId: initial.providerSessionId,
    phase: "recovered continuation turn",
  });
  const result = {
    ok: true,
    scenario: SCENARIO,
    taskId,
    runId: continued.runtimeView.run.runId,
    conductorSessionId: continued.conductor.sessionId,
    providerSessionId: initial.providerSessionId,
    inputId,
    inputProviderMessageId: continued.wakeup.providerMessageId,
    outputProviderMessageId: continued.output.data?.providerMessageId,
    continuationDelivery: submitted.wakeup.delivery,
    historicalState: "legacy_sent_without_provider_receipt",
    terminal: terminal ? { id: terminal.id, status: terminal.status, args: terminal.args, bufferMode: finalTui.bufferMode } : undefined,
    terminalWriteAudit,
  };
  recordHarnessResult(path.dirname(databasePath), result);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

async function assertLiveOpenCodeTui({ terminalRuntime, sessionId, expectedProviderSessionId, phase }) {
  const terminal = terminalRuntime.get(sessionId);
  assert.ok(terminal, `${phase} must retain a native terminal`);
  assert.equal(terminal.status, "running", `${phase} must remain an interactive terminal after the Provider turn`);
  assert.ok(!terminal.args.includes("run"), `${phase} must not use one-shot opencode run mode`);
  if (expectedProviderSessionId) {
    assert.ok(terminal.args.includes("--session"), `${phase} must resume the prior Provider session when one exists`);
    assert.ok(terminal.args.includes(expectedProviderSessionId), `${phase} must target the exact prior Provider session`);
  }
  const snapshot = await terminalRuntime.getSnapshot(sessionId);
  assert.equal(snapshot?.bufferMode, "alternate", `${phase} must be in OpenCode's interactive alternate-buffer TUI`);
  return { terminal, bufferMode: snapshot.bufferMode };
}

function scenarioDefinition() {
  if (SCENARIO === "continuation") {
    return {
      title: "Task Send preserves the Conductor Provider conversation",
      templateName: "Real Task Send Continuation E2E",
      initialToken: "AGENT_LOOP_REAL_CONTINUATION_INITIAL_OK",
      continuationToken: "AGENT_LOOP_REAL_CONTINUATION_OK",
      goal: [
        "This is a Task-page continuation acceptance test.",
        "For your initial decision, use read_task_state and then reply with the exact token AGENT_LOOP_REAL_CONTINUATION_INITIAL_OK.",
        "Do not dispatch any Session Agent, create an artifact, or claim task completion in the initial decision.",
        "When the user later sends a follow-up, continue the same Provider conversation, read durable Task state, and follow the user instruction exactly.",
      ].join(" "),
    };
  }
  if (SCENARIO === "worker_wakeup_recovery") {
    return {
      title: "Worker return restores the Conductor Provider session",
      templateName: "Real Worker Wakeup Recovery E2E",
      heading: "# Agent Loop Worker Wakeup Recovery E2E",
      token: "AGENT_LOOP_REAL_WORKER_WAKEUP_RECOVERY_OK",
      expectedDispatches: 1,
      expectedWakeups: 1,
      forceConductorExitBeforeWorkerResult: true,
      goal: [
        "Use the approved publisher Agent Card to create final.md.",
        "The file must contain a Markdown heading `# Agent Loop Worker Wakeup Recovery E2E` and the exact token `AGENT_LOOP_REAL_WORKER_WAKEUP_RECOVERY_OK`.",
        "First use read_task_state, then use one call_sessions dispatch batch containing publisher with a bounded contract.",
        "After that dispatch batch, end your current Provider turn immediately. Do not poll task state, read the filesystem, or call another tool until Runtime sends the next semantic user-message wakeup.",
        "After the Runtime wakeup confirms the Publisher Provider result, inspect durable state and call claim_task_completion.",
        "Do not create final.md yourself; only the native Publisher session may write it.",
      ].join(" "),
    };
  }
  if (SCENARIO === "deepsearch") {
    return {
      title: "OpenCode Terminal Runtime DeepSearch",
      templateName: "Generated DeepSearch E2E",
      heading: "# OpenCode Terminal Runtime DeepSearch",
      token: "AGENT_LOOP_REAL_DEEPSEARCH_OK",
      artifactPath: "deepsearch-report.md",
      // This is an Agent Loop acceptance gate, not a hidden role sequence.
      // A real evidence-led delivery needs one source return and one later
      // context-selected delivery return; the Conductor may choose more.
      minDispatches: 2,
      minWakeups: 2,
      goal: [
        "Research how OpenCode terminal sessions and provider state are represented, using at least two independently useful source perspectives where available.",
        "For this release-gate task, the only research corpus is the preloaded `sources/` directory below the Task project root. Read and cite those source-mirror files; do not access a user home directory, external project, or the network. If the source corpus has a limit, state it rather than leaving the Task root.",
        "Use the saved Agent Loop Template's native Session Agent cards as capabilities; choose dispatches from their durable returns rather than following a fixed role order.",
        "A native Session Agent, never the Conductor, must create deepsearch-report.md at the Task project root after it receives the selected durable research materials through contextRefs.",
        "The report must have the Markdown heading `# OpenCode Terminal Runtime DeepSearch`, cite sources or state source limits, and contain the exact token `AGENT_LOOP_REAL_DEEPSEARCH_OK`.",
        "After each native Provider result, inspect durable task state. Select complete prior answers with contextRefs only when a later Session needs them. Before claim_task_completion, decide whether the selected evidence and report satisfy the user-facing request.",
      ].join(" "),
    };
  }
  if (SCENARIO === "review_handoff") {
    return {
      title: "Conductor-owned Reviewer semantic handoff",
      templateName: "Real Conductor Reviewer Handoff E2E",
      heading: "# Agent Loop Reviewer Handoff E2E",
      token: "AGENT_LOOP_REVIEW_HANDOFF_OK",
      expectedDispatches: 5,
      expectedWakeups: 5,
      goal: [
        "This is a Conductor decision and semantic-handoff test. Do not write any artifact yourself.",
        "Decision 1: use read_task_state and dispatch only searcher. Ask it to return a normal Markdown Provider answer headed `SEARCH_DRAFT` that states `UNVERIFIED_CLAIM: the first source is insufficient`; it must not write final.md. End the Provider turn after dispatch.",
        "After the first semantic wakeup, use read_task_state and dispatch only reviewer with contextRefs containing the exact completed Searcher result. Ask it to return a normal Markdown Provider answer headed `needs changes` that says the attached Searcher material has a factual evidence gap and requires `VERIFIED_EVIDENCE`; it must not write final.md. End the Provider turn after dispatch.",
        "After the second semantic wakeup, use read_task_state and dispatch only searcher with contextRefs containing the exact completed Reviewer result. Ask it to create evidence.md at the Task project root with `VERIFIED_EVIDENCE` and without `UNVERIFIED_CLAIM`, then return its normal Provider result. Do not create final.md. End the Provider turn after dispatch.",
        "After the third semantic wakeup, use read_task_state and dispatch only reviewer with contextRefs containing the latest completed Searcher result and the earlier completed Reviewer result. Ask it to return a normal Markdown Provider answer headed `pass` after confirming `VERIFIED_EVIDENCE`. Do not create final.md. End the Provider turn after dispatch.",
        "After the fourth semantic wakeup, use read_task_state and dispatch only publisher with contextRefs containing the completed corrected Searcher result and completed Reviewer pass result. Ask it to create final.md at the Task project root with Markdown heading `# Agent Loop Reviewer Handoff E2E` and exact token `AGENT_LOOP_REVIEW_HANDOFF_OK`. End the Provider turn after dispatch.",
        "After the fifth semantic wakeup, use read_task_state, verify the selected Publisher result covers both explicit final.md requirements, then call claim_task_completion. Never treat a Reviewer phrase as a Runtime status and never dispatch Publisher before the factual gap is addressed and reviewed.",
      ].join(" "),
    };
  }
  if (SCENARIO === "attention") {
    return {
      title: "Conductor-owned native attention delivery",
      templateName: "Real Conductor Attention E2E",
      question: "Which release channel should the Publisher use?",
      expectedDispatches: 1,
      expectedWakeups: 1,
      goal: [
        "Do not create final.md and do not claim task completion.",
        "First use read_task_state, then use one call_sessions batch containing publisher with a bounded contract.",
        "That contract must tell the native Publisher to call its native OpenCode question tool exactly once with the question `Which release channel should the Publisher use?`, then wait for the user in its own terminal without creating an artifact.",
        "End your current Provider turn immediately after that dispatch. When Runtime wakes you for the pending native question, inspect durable state and tell the user to answer in the selected Publisher terminal. Do not synthesize an answer and do not dispatch any other worker.",
      ].join(" "),
    };
  }
  if (SCENARIO === "correction") {
    return {
      title: "Conductor-owned native correction delivery",
      templateName: "Real Conductor Correction E2E",
      heading: "# Agent Loop Real Correction E2E",
      token: "AGENT_LOOP_REAL_CORRECTION_OK",
      expectedDispatches: 2,
      expectedWakeups: 2,
      goal: [
        "Use only the approved publisher Agent Card to create final.md; never write final.md yourself.",
        "Decision 1: first use read_task_state, then use one call_sessions batch that tells publisher to create an intentionally incomplete first draft. It must contain exactly `# Agent Loop Real Correction E2E`, a blank line, and `DRAFT_INCOMPLETE`; it must not contain `AGENT_LOOP_REAL_CORRECTION_OK`. End the Provider turn immediately after dispatch.",
        "When Runtime wakes you with that Publisher result, inspect durable state and issue a correction through call_session to the same publisher Agent Card. The correction must replace final.md with a Markdown heading `# Agent Loop Real Correction E2E` and the exact token `AGENT_LOOP_REAL_CORRECTION_OK`.",
        "After the second Runtime wakeup confirms the corrected Provider result, inspect durable state and call claim_task_completion. Do not poll state or inspect worker files while waiting for either wakeup.",
      ].join(" "),
    };
  }
  if (GENERATE_TEMPLATE) {
    return {
      title: "Generated Template native delivery",
      templateName: "Generated Template E2E",
      heading: "# Agent Loop Generated Template E2E",
      token: "AGENT_LOOP_GENERATED_TEMPLATE_E2E_OK",
      expectedDispatches: 1,
      expectedWakeups: 1,
      goal: [
        "Use one approved native Session Agent Card to create final.md.",
        "The file must contain a Markdown heading `# Agent Loop Generated Template E2E` and the exact token `AGENT_LOOP_GENERATED_TEMPLATE_E2E_OK`.",
        "First use read_task_state, then issue one bounded call_sessions dispatch. End your Provider turn immediately after dispatch.",
        "Only after Runtime wakes you with the Publisher Provider result, use read_task_state, compare the result against both explicit file requirements, then call claim_task_completion. Never call claim_task_completion in the same decision turn as the dispatch or before dispatch.provider.received exists.",
        "Do not create final.md yourself; only the native Session Agent may write it.",
      ].join(" "),
    };
  }
  return {
    title: "Conductor-owned native artifact delivery",
    templateName: "Real Conductor E2E",
    heading: "# Agent Loop Real E2E",
    token: "AGENT_LOOP_REAL_E2E_OK",
    expectedDispatches: 1,
    expectedWakeups: 1,
    goal: [
      "Use the approved publisher Agent Card to create final.md.",
      "The file must contain a Markdown heading `# Agent Loop Real E2E` and the exact token `AGENT_LOOP_REAL_E2E_OK`.",
      "First use read_task_state, then use one call_sessions dispatch batch containing publisher with a bounded contract.",
      "After that dispatch batch, end your current Provider turn immediately. Do not poll task state, read the filesystem, or call another tool until Runtime sends the next semantic user-message wakeup.",
      "After the Runtime wakeup confirms the provider result, inspect durable state and call claim_task_completion.",
      "Do not create final.md yourself; only the native Publisher session may write it.",
    ].join(" "),
  };
}

async function main() {
  const opencodePath = resolveOpencodePath();
  if (!opencodePath) {
    throw new Error(
      "OpenCode is required for the real-conductor harness. Install the OpenCode CLI or run with OPENCODE_PATH=/absolute/path/to/opencode.",
    );
  }

  ensureNodePtySpawnHelperExecutable();
  // macOS exposes the same temporary directory through both /var and
  // /private/var. Keep every launch/profile/Provider query on the canonical
  // path so OpenCode does not treat its own workspace as an external write.
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agent-loop-real-conductor-")));
  if (SCENARIO === "deepsearch") stageDeepSearchSourceMirror(root);
  const taskId = `conductor-e2e-${Date.now()}`;
  const scenario = scenarioDefinition();
  const sessionStore = createSessionStore({ root });
  const terminalDaemonSupervisor = createOrcaTerminalDaemonSupervisor();
  const terminalRuntime = createOrcaTerminalDaemonManager({
    endpointProvider: () => terminalDaemonSupervisor.start(),
    sessionStore,
  });
  const terminalWriteAudit = [];
  const terminalWriteAuditPath = path.join(root, "terminal-write-audit.jsonl");
  const writeTerminal = terminalRuntime.write.bind(terminalRuntime);
  terminalRuntime.write = (id, payload, options) => {
    const entry = { id: String(id), payload: String(payload), options };
    terminalWriteAudit.push(entry);
    fs.appendFileSync(terminalWriteAuditPath, `${JSON.stringify(entry)}\n`);
    return writeTerminal(id, payload, options);
  };
  const openCodeProviderObserver = createOpenCodeProviderObserver();
  const sessionAuthority = createSessionAuthority({ ptyManager: terminalRuntime, databasePath: path.join(root, "terminal.sqlite") });
  let runtime;
  let bridge;
  let bridgeServer;
  let monitor;

  terminalRuntime.onEvent((event) => {
    sessionAuthority.handlePtyEvent(event);
  });

  bridge = createConductorToolBridge({
    sessionStore,
    ptyManager: terminalRuntime,
    activateWorkerSession: ({ sessionId, operationId, interactiveTui }) =>
      sessionAuthority.activateSession({
        workspaceSessionId: sessionId,
        operationId,
        callerId: "real-conductor-harness",
        reason: "conductor-dispatch",
        interactiveTui: interactiveTui === true,
      }),
    prepareWorkerSession: ({ taskId: requestedTaskId, agentId, sessionId, initialPrompt }) =>
      runtime?.prepareWorkerInitialDispatch({ taskId: requestedTaskId, agentId, sessionId, initialPrompt }),
    enqueueWorkerInput: ({ sessionId, expectedIncarnationId, payload, idempotencyKey }) =>
      sessionAuthority.enqueueInput({
        workspaceSessionId: sessionId,
        expectedIncarnationId,
        source: "dispatch",
        payload,
        idempotencyKey,
      }),
    enqueueWorkerInteractiveSubmission: ({ sessionId, expectedIncarnationId, source = "dispatch", text, idempotencyKey }) =>
      sessionAuthority.enqueueInteractiveSubmission({
        workspaceSessionId: sessionId,
        expectedIncarnationId,
        source,
        text,
        idempotencyKey,
      }),
    resolveAgentSession: ({ taskId: requestedTaskId, agentId }) => runtime?.resolveAgentSession({ taskId: requestedTaskId, agentId }),
    getTaskAgentMap: ({ taskId: requestedTaskId }) => runtime?.taskAgentMap({ taskId: requestedTaskId }),
    validateDispatch: ({ taskId: requestedTaskId, agentId, toSessionId }) => runtime?.validateDispatch({ taskId: requestedTaskId, agentId, toSessionId }) ?? { ok: false, reason: "loop_runtime_missing" },
    prepareDispatchContext: ({ taskId: requestedTaskId, agentId, toSessionId, contextRefs }) =>
      runtime?.prepareDispatchContext({ taskId: requestedTaskId, agentId, toSessionId, contextRefs }),
    resumeTaskForDispatch: ({ taskId: requestedTaskId, agentId, toSessionId }) =>
      runtime?.resumeTaskForDispatch({ taskId: requestedTaskId, agentId, toSessionId }),
    onCompletionClaim: ({ taskId: requestedTaskId }) => runtime?.recordCompletionClaim({ taskId: requestedTaskId }),
  });

  try {
    bridgeServer = await startConductorToolBridgeHttpServer({ bridge });
    runtime = createAgentLoopV1Runtime({
      sessionAuthority,
      ptyManager: terminalRuntime,
      sessionStore,
      opencodePath,
      databasePath: path.join(root, "agent-loop.sqlite"),
      generateTemplateFromBrief: generateAgentLoopTemplate,
      getConductorBridgeConfig: async () => ({
        conductorToolBridgeUrl: bridgeServer.url,
        conductorToolBridgeToken: bridgeServer.token,
        conductorMcpServerPath: path.join(__dirname, "conductor-mcp-server.cjs"),
      }),
    });

    monitor = createSessionWakeupMonitor({
      ptyManager: terminalRuntime,
      sessionStore,
      providerObserver: openCodeProviderObserver,
      conductorMessageReader: async ({ session, afterMessageCreatedAt, providerSessionId }) => {
        const fact = await openCodeProviderObserver.observeConductor({
          session,
          afterMessageCreatedAt,
          providerSessionId,
        }).catch(() => undefined);
        return fact?.kind === "result" ? fact.result : undefined;
      },
      conductorQuestionReader: async ({ session, afterMessageCreatedAt, providerSessionId }) => {
        const fact = await openCodeProviderObserver.observeConductor({
          session,
          afterMessageCreatedAt,
          providerSessionId,
        }).catch(() => undefined);
        return fact?.kind === "attention" ? fact.attention : undefined;
      },
      resolveAgentId: ({ taskId: requestedTaskId, sessionId }) => runtime?.taskAgentMap({ taskId: requestedTaskId })?.[sessionId],
      enqueueConductorInput: ({ sessionId, expectedIncarnationId, source, payload, idempotencyKey }) =>
        sessionAuthority.enqueueInput({
          workspaceSessionId: sessionId,
          expectedIncarnationId,
          source,
          payload,
          idempotencyKey,
        }),
      enqueueConductorInteractiveSubmission: ({ sessionId, expectedIncarnationId, source, text, idempotencyKey }) =>
        sessionAuthority.enqueueInteractiveSubmission({
          workspaceSessionId: sessionId,
          expectedIncarnationId,
          source,
          text,
          idempotencyKey,
        }),
      ensureConductorWakeupTarget: ({ taskId: requestedTaskId, sessionId }) =>
        runtime?.ensureConductorWakeupTarget({ taskId: requestedTaskId, sessionId }),
      listConductorWakeupTargets: () => runtime?.listConductorWakeupTargets() ?? [],
      onConductorWaiting: ({ taskId: requestedTaskId }) =>
        runtime?.flushPendingUserMessages({ taskId: requestedTaskId }).catch(() => undefined),
      onConductorWakeupAccepted: ({ taskId: requestedTaskId, wakeupKey }) =>
        runtime?.resumeTaskForConductorInput({
          taskId: requestedTaskId,
          cause: "runtime_wakeup",
          inputId: wakeupKey,
        }),
    });
    monitor.start();

    const shouldGenerateTemplate = GENERATE_TEMPLATE || SCENARIO === "deepsearch";
    const generatedTemplate = shouldGenerateTemplate
      ? await runtime.generateTemplateDraft({
        cwd: root,
        projectName: SCENARIO === "deepsearch" ? "Real DeepSearch E2E" : "Generated Agent Loop E2E",
        brief: SCENARIO === "deepsearch"
          ? [
            "Create a reusable DeepSearch Agent Loop Template for a source-backed Markdown research report.",
            "Include a Conductor and native OpenCode Session Agent cards capable of research, evidence synthesis, and final report writing.",
            "The Conductor must choose the next Session from durable results and user follow-ups rather than a fixed route.",
            "Do not create a Workflow, Graph, nodes, edges, scheduler, mandatory reviewer, or automatic repair route.",
          ].join(" ")
          : [
            "Create a reusable Agent Loop Template for a small Markdown delivery.",
            "Use one Conductor and exactly one native Session Agent named Publisher that can create final.md.",
            "The Conductor must compare explicit task acceptance conditions with durable Session results before deciding whether another dispatch is needed.",
            "Do not create a Workflow, Graph, nodes, edges, fixed role order, reviewer gate, or automatic repair route.",
          ].join(" "),
        model: MODEL,
      })
      : undefined;
    if (generatedTemplate) {
      assert.equal(generatedTemplate.template.source, "generated");
      assert.ok(generatedTemplate.template.conductor.charter.length > 0, "generated Template must include an editable Conductor Charter");
      assert.ok(generatedTemplate.template.agents.length >= (SCENARIO === "deepsearch" ? 2 : 1), "generated Template must produce the requested native Session Agent cards");
      if (SCENARIO !== "deepsearch") {
        assert.equal(generatedTemplate.template.agents.length, 1, "one-sentence generated E2E Template must produce one native Session Agent card");
        assert.match(generatedTemplate.template.agents[0].name, /publisher/i, "generated Agent card must preserve the requested Publisher capability");
      }
      assert.ok(generatedTemplate.template.agents.every((agent) => Array.isArray(agent.mcp) && Array.isArray(agent.skills)));
    }
    const generatedTemplateForSave = generatedTemplate
      ? {
        ...generatedTemplate.template,
        // The one-sentence generator may suggest a generic report path. This
        // harness simulates the user editing that optional preference before
        // save so the Task's explicit final.md acceptance contract is
        // unambiguous; it is not a Runtime delivery rule.
        delivery: { artifactPath: scenario.artifactPath ?? "final.md", ownerAgentId: "" },
        conductor: {
          ...generatedTemplate.template.conductor,
          charter: [
            generatedTemplate.template.conductor.charter,
            "For this Template, never call claim_task_completion in the same Conductor turn that creates a dispatch. End that turn and wait for a semantic Runtime wakeup. Only after read_task_state shows dispatch.provider.received and a returned Provider result may you compare every explicit task acceptance condition and decide whether to claim or dispatch again.",
          ].join("\n\n"),
        },
      }
      : undefined;
    const template = runtime.saveTemplate(generatedTemplateForSave ?? {
      id: `real-conductor-template-${Date.now()}`,
      name: scenario.templateName,
      source: "manual",
      conductor: {
        role: "Conductor",
        model: MODEL,
        charter: SCENARIO === "review_handoff"
          ? "Conductor chooses native Searcher, Reviewer, and Publisher assignments from complete semantic results. Use native Session answers as complete semantic materials. A Reviewer’s `needs changes` is ordinary message content, not a Runtime status. When it identifies a factual evidence gap, decide whether to dispatch a suitable evidence-capable card with the exact Review result in contextRefs; after evidence returns, decide whether another review is useful. Dispatch Publisher only with the selected material you judge ready for delivery. This is decision guidance, not a fixed route."
          : "One native Publisher creates the declared artifact; Conductor reacts to the semantic Provider return. Treat every explicit requirement in the task goal as an acceptance condition. Before claim_task_completion, compare those conditions with the exact durable Provider result. If a result says DRAFT_INCOMPLETE or lacks a required token, dispatch a bounded correction to an approved native Session Agent; never claim delivery on that turn.",
      },
      agents: SCENARIO === "review_handoff"
        ? [
          {
            id: "searcher",
            name: "Searcher",
            kind: "researcher",
            role: "Investigate a bounded factual question and return normal Markdown evidence.",
            model: MODEL,
            mcp: [],
            skills: [],
            instructions: "Use only the Conductor assignment and any quoted result material supplied by Runtime. Return normal Markdown evidence; do not dispatch or invent Workspace protocol.",
            expectedOutput: "Normal Markdown evidence with the requested claims and source limitations.",
          },
          {
            id: "reviewer",
            name: "Reviewer",
            kind: "reviewer",
            role: "Assess selected evidence and return a normal Markdown review message.",
            model: MODEL,
            mcp: [],
            skills: [],
            instructions: "Assess only the bounded material supplied by the Conductor. State conclusions and gaps in a normal native Provider answer; do not dispatch or create final.md.",
            expectedOutput: "A normal Markdown review conclusion, evidence concerns, and remaining risks.",
          },
          {
            id: "publisher",
            name: "Publisher",
            kind: "publisher",
            role: "Create the declared final Markdown artifact from selected evidence and review material.",
            model: MODEL,
            mcp: [],
            skills: [],
            instructions: "Create only the requested artifact from material supplied by the Conductor. Return its exact path and a concise verification summary.",
            expectedOutput: "A Markdown artifact path and a concise result.",
          },
        ]
        : [
          {
            id: "publisher",
            name: "Publisher",
            role: "Create the declared final Markdown artifact from the Conductor's bounded contract.",
            model: MODEL,
            mcp: [],
            skills: [],
            instructions: "Create only the requested artifact. Return its exact path and a concise verification summary.",
            expectedOutput: "A Markdown artifact path and a concise result.",
          },
        ],
      limits: SCENARIO === "review_handoff" ? { maxConcurrentSessions: 3, maxDispatchesPerDecision: 1 } : { maxConcurrentSessions: 1, maxDispatchesPerDecision: 1 },
      delivery: SCENARIO === "attention" ? {} : { artifactPath: scenario.artifactPath ?? "final.md" },
    });
    runtime.createTask({
      cwd: root,
      projectId: "real-e2e",
      taskId,
      title: scenario.title,
      goal: scenario.goal,
      templateId: template.id,
      templateVersion: template.version,
    });
    await runtime.startRun({ taskId });

    if (SCENARIO === "continuation") {
      await runContinuationE2E({ runtime, sessionStore, terminalRuntime, terminalWriteAudit, databasePath: path.join(root, "agent-loop.sqlite"), taskId, scenario });
      return;
    }

    let interruptedConductor;
    if (scenario.forceConductorExitBeforeWorkerResult) {
      interruptedConductor = await waitFor(() => {
        const task = runtime.readTask({ taskId });
        const runtimeView = task?.latestRun ? runtime.readRun({ runId: task.latestRun.runId }) : undefined;
        const conductor = turnForAgent(runtimeView, "conductor");
        const publisher = turnForAgent(runtimeView, "publisher");
        const dispatch = publisher?.details?.dispatches?.[0];
        const providerSessionId = (runtimeView?.runtimeState?.events ?? [])
          .find((event) => event.type === "conductor.message" && event.sessionId === conductor?.sessionId)
          ?.data?.providerSessionId;
        const terminal = conductor?.sessionId ? terminalRuntime.get(conductor.sessionId) : undefined;
        if (!conductor || !dispatch || dispatch.status === "result_available" || !providerSessionId || terminal?.status !== "running") return undefined;
        return { conductor, providerSessionId: String(providerSessionId), terminal };
      }, "initial Conductor dispatch before forced terminal exit");
      await terminalRuntime.stop(interruptedConductor.conductor.sessionId, {
        expectedIncarnationId: interruptedConductor.terminal.incarnationId,
      });
      await waitFor(
        () => terminalRuntime.get(interruptedConductor.conductor.sessionId)?.status !== "running" ? true : undefined,
        "original Conductor terminal exit before Publisher result",
      );
    }

    const completed = await waitFor(() => {
      const task = runtime.readTask({ taskId });
      const runtimeView = task?.latestRun ? runtime.readRun({ runId: task.latestRun.runId }) : undefined;
      const publisher = turnForAgent(runtimeView, "publisher") ?? runtimeView?.turns?.find((turn) => turn.nodeId !== "conductor");
      const semanticEvents = runtimeView?.runtimeState?.events ?? [];
      if (SCENARIO === "attention") {
        const worker = runtimeView?.runtimeState?.sessions?.find((session) => session.sessionId === publisher?.sessionId);
        if (worker?.state !== "waiting_input") return undefined;
        if (semanticEvents.filter((event) => event.type === "dispatch.provider.received").length !== scenario.expectedDispatches) return undefined;
        if (semanticEvents.filter((event) => event.type === "conductor.wakeup.sent").length !== scenario.expectedWakeups) return undefined;
        return { task, runtimeView, publisher };
      }
      const artifactPath = path.join(root, scenario.artifactPath ?? "final.md");
      if (!fs.existsSync(artifactPath)) return undefined;
      const providerReceiptCount = semanticEvents.filter((event) => event.type === "dispatch.provider.received").length;
      const hasProviderReceipt = SCENARIO === "deepsearch"
        ? providerReceiptCount >= scenario.minDispatches
        : providerReceiptCount === scenario.expectedDispatches;
      const hasProviderResult = SCENARIO === "deepsearch"
        ? runtimeView?.runtimeState?.dispatches?.filter((dispatch) => dispatch.status === "result_available").length >= scenario.minDispatches
        : publisher?.details?.dispatches?.some((dispatch) => dispatch.status === "result_available");
      if (!hasProviderReceipt || !hasProviderResult) return undefined;
      if (scenario.requiresConductorClaim !== false && task?.status !== "delivery_ready") return undefined;
      return { task, artifact: fs.readFileSync(artifactPath, "utf8"), runtimeView, publisher };
    }, SCENARIO === "attention"
      ? "native Provider attention and semantic Conductor wakeup"
      : "Conductor dispatch, Provider result wakeup, and delivery claim");

    if (SCENARIO !== "attention") {
      assert.match(completed.artifact, new RegExp(`^${escapeRegExp(scenario.heading)}`, "m"));
      assert.match(completed.artifact, new RegExp(escapeRegExp(scenario.token)));
    }
    const runtimeView = completed.runtimeView;
    const artifactName = path.basename(scenario.artifactPath ?? "final.md");
    const publisher = SCENARIO === "deepsearch"
      ? runtimeView.turns.find((turn) => turn.nodeId !== "conductor" && String(turn.output?.answerText ?? "").includes(artifactName))
        ?? runtimeView.turns.find((turn) => turn.nodeId !== "conductor")
      : turnForAgent(runtimeView, "publisher") ?? runtimeView.turns.find((turn) => turn.nodeId !== "conductor");
    // A Provider result alone is not sufficient for the Workbench surface:
    // the corresponding Session must still be an interactive OpenCode TUI,
    // not a one-shot `opencode run` process that left an empty terminal pane.
    const publisherTui = SCENARIO === "attention" || !publisher?.sessionId
      ? undefined
      : await assertLiveOpenCodeTui({
          terminalRuntime,
          sessionId: publisher.sessionId,
          phase: "Publisher delivery turn",
        });
    const semanticEvents = runtimeView.runtimeState.events ?? [];
    const receiptCount = semanticEvents.filter((event) => event.type === "dispatch.provider.received").length;
    const wakeupCount = semanticEvents.filter((event) => event.type === "conductor.wakeup.sent").length;
    if (SCENARIO === "deepsearch") {
      assert.ok(receiptCount >= scenario.minDispatches, "DeepSearch must record at least one exact Provider receipt");
      assert.ok(wakeupCount >= scenario.minWakeups, "DeepSearch must wake Conductor from a native Provider result");
      const completeDispatches = runtimeView.runtimeState.dispatches.filter((dispatch) => dispatch.status === "result_available");
      assert.ok(completeDispatches.length >= scenario.minDispatches, "DeepSearch must retain independent native Provider results");
      // The Task asks for causal semantic handoff, not a prescribed number of
      // predecessors.  One selected complete Provider answer is sufficient
      // when the Conductor judges it is the material needed by the next
      // native Session; richer tasks may select several.
      const handoff = completeDispatches.find((dispatch) => Array.isArray(dispatch.contextRefs) && dispatch.contextRefs.length >= 1);
      assert.ok(handoff, "DeepSearch must contain a later Conductor-selected semantic handoff");
      assert.ok(
        handoff.contextPackets.every((packet) => packet?.resultId && typeof packet.answerText === "string"),
        "semantic handoff packets must carry complete durable Provider answers",
      );
    } else {
      assert.equal(receiptCount, scenario.expectedDispatches, "each dispatch must have one durable Provider receipt transition");
      assert.equal(wakeupCount, scenario.expectedWakeups, "each Provider result must wake the next Conductor decision exactly once");
    }
    assert.equal(semanticEvents.some((event) => event.type === "session.waiting_conductor"), true, "the first Conductor decision must end before the Runtime wakeup");
    if (SCENARIO === "attention") {
      const publisherSession = runtimeView.runtimeState.sessions.find((session) => session.sessionId === publisher?.sessionId);
      assert.equal(completed.task.status, "running");
      assert.equal(runtimeView.run.status, "running");
      assert.equal(publisherSession?.state, "waiting_input");
      assert.equal(fs.existsSync(path.join(root, "final.md")), false);
    } else {
      assert.equal(publisher?.details?.dispatches?.some((dispatch) => dispatch.status === "result_available"), true);
      if (scenario.requiresConductorClaim !== false) {
        // `delivery_ready` is a Task lifecycle state: it tells the user that
        // the current delivery can be accepted.  The same Agent Loop Run
        // stays live so a later explicit Conductor decision can dispatch
        // follow-up work without fabricating a new Run.
        assert.equal(completed.task.status, "delivery_ready");
        assert.equal(runtimeView.run.status, "running");
        if (shouldGenerateTemplate) {
          const receiptIndex = semanticEvents.findIndex((event) => event.type === "dispatch.provider.received");
          const claimIndex = semanticEvents.findIndex((event) => event.type === "task.completion_claim");
          assert.ok(receiptIndex >= 0, "generated Template E2E must record Provider receipt");
          assert.ok(claimIndex > receiptIndex, "generated Template E2E must claim delivery only after the Provider receipt");
        }
      }
      if (SCENARIO === "deepsearch") {
        assert.ok(
          runtimeView.turns.some((turn) => String(turn.output?.answerText ?? "").includes(artifactName)),
          "one native DeepSearch Session must return the delivered artifact path",
        );
      } else {
        assert.match(String(publisher?.output?.answerText ?? ""), new RegExp(escapeRegExp(artifactName), "i"));
      }
    }
    if (SCENARIO === "correction") {
      assert.equal(publisher?.details?.dispatches?.length, 2, "the correction must reuse the approved Publisher card");
      assert.match(String(publisher?.details?.dispatches?.[0]?.assignment ?? ""), /DRAFT_INCOMPLETE/);
      assert.match(String(publisher?.details?.dispatches?.[1]?.assignment ?? ""), /AGENT_LOOP_REAL_CORRECTION_OK/);
    }
    if (SCENARIO === "review_handoff") {
      assertReviewHandoff(runtimeView);
    }
    if (interruptedConductor) {
      const recoveryEvent = runtimeView.events.find(
        (event) => event.type === "conductor.recovered" && event.data?.cause === "worker_result_wakeup",
      );
      assert.ok(recoveryEvent, "a Worker result must restore the current Conductor Run without waiting for a user Send");
      assert.equal(
        runtimeView.events.some((event) => event.type === "conductor.recovery_required"),
        false,
        "a recoverable Worker wakeup must not strand the Run in recovery_required",
      );
      await assertLiveOpenCodeTui({
        terminalRuntime,
        sessionId: interruptedConductor.conductor.sessionId,
        expectedProviderSessionId: interruptedConductor.providerSessionId,
        phase: "Worker-result recovered Conductor turn",
      });
    }

    let deletion;
    if (SCENARIO === "attention") {
      // This scenario deliberately validates the native TUI's visible question
      // state. It is an interaction/transport assertion, not a Provider
      // semantic conclusion.
      const conductor = runtimeView.turns.find((turn) => turn.nodeId === "conductor");
      const conductorSnapshot = await terminalRuntime.getSnapshot(conductor.sessionId);
      const publisherSnapshot = await terminalRuntime.getSnapshot(publisher.sessionId);
      assert.match(conductorSnapshot.ansi, /needs input|selected Publisher terminal|native Session terminal/i);
      assert.match(publisherSnapshot.ansi, new RegExp(escapeRegExp(scenario.question), "i"));
    } else if (scenario.requiresConductorClaim !== false) {
      const achieved = runtime.markTaskAchieved({ taskId });
      assert.equal(achieved.status, "achieved");
      // The Orca-style terminal host owns screen transport only. A current TUI
      // snapshot is allowed to scroll or redraw and therefore is not semantic
      // evidence of an Agent Loop result. The Provider receipts/results and
      // artifact assertions above are the durable acceptance evidence.
      if (SCENARIO === "deepsearch") {
        deletion = await runtime.deleteTask({ taskId });
        assert.equal(deletion.deleted, true);
        assert.equal(runtime.readTask({ taskId }), undefined, "explicit deletion removes Runtime-owned Task records after achieved");
      }
    }

    const result = {
      ok: true,
      scenario: SCENARIO,
      templateSource: template.source,
      generatedTemplate: shouldGenerateTemplate,
      generatedTemplateCharterEdited: Boolean(generatedTemplateForSave),
      model: MODEL,
      taskId,
      taskStatus: deletion ? "deleted" : SCENARIO === "attention" || scenario.requiresConductorClaim === false ? completed.task.status : "achieved",
      runStatus: runtimeView.run.status,
      workerProviderResult: publisher.output?.answerText,
      publisherTerminal: publisherTui
        ? { id: publisherTui.terminal.id, status: publisherTui.terminal.status, args: publisherTui.terminal.args, bufferMode: publisherTui.bufferMode }
        : undefined,
      recoveredConductorProviderSessionId: interruptedConductor?.providerSessionId,
      deletion,
    };
    recordHarnessResult(root, result);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    const diagnostics = JSON.stringify({ root, terminals: describeTerminals(terminalRuntime), terminalWriteAudit }, null, 2);
    error.message = `${error.message}\nReal Conductor Harness diagnostics:\n${diagnostics}`;
    error.stack = `${error.stack || error.message}\nReal Conductor Harness diagnostics:\n${diagnostics}`;
    throw error;
  } finally {
    monitor?.stop();
    runtime?.close();
    sessionAuthority.close();
    await terminalRuntime.close();
    await terminalDaemonSupervisor.stop();
    await openCodeProviderObserver.close();
    await bridgeServer?.close();
  }
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function recordHarnessResult(root, result) {
  fs.writeFileSync(path.join(root, "harness-result.json"), `${JSON.stringify(result, null, 2)}\n`);
}

function stageDeepSearchSourceMirror(taskRoot) {
  if (!fs.existsSync(DEEPSEARCH_SOURCE_MIRROR)) {
    throw new Error(`DeepSearch source mirror is missing: ${DEEPSEARCH_SOURCE_MIRROR}`);
  }
  const destination = path.join(taskRoot, "sources");
  fs.cpSync(DEEPSEARCH_SOURCE_MIRROR, destination, { recursive: true, force: true });
  const sourceFiles = fs.readdirSync(destination).filter((entry) => entry.endsWith(".md"));
  if (sourceFiles.length < 2) throw new Error("DeepSearch source mirror requires at least two Markdown sources.");
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});

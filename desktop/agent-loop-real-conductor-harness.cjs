const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createConductorToolBridge, startConductorToolBridgeHttpServer } = require("./conductor-tool-bridge.cjs");
const { generateAgentLoopTemplate } = require("./agent-loop-template-assistant.cjs");
const { ensureNodePtySpawnHelperExecutable } = require("./node-pty-runtime.cjs");
const {
  findProviderSessionForConductorTask,
  inspectDispatchProviderState,
  getDispatchAssistantAnswer,
  getLastEffectiveAssistantAnswer,
  getLastPendingQuestionForConductorTask,
  getLastPendingQuestionForDirectory,
} = require("./opencode/session-adapter.cjs");
const { resolveOpencodePath } = require("./opencode-runner.cjs");
const { createAgentLoopV1Runtime } = require("./runtime/agent-loop-v1-runtime.cjs");
const { createOrcaTerminalDaemonManager } = require("./runtime/orca-terminal-daemon-manager.cjs");
const { createOrcaTerminalDaemonSupervisor } = require("./runtime/orca-terminal-daemon-supervisor.cjs");
const { createOpenCodeHookService } = require("./runtime/opencode-hook-service.cjs");
const { createSessionAuthority } = require("./runtime/session-authority.cjs");
const { createSessionStore } = require("./session-store.cjs");
const { createSessionWakeupMonitor } = require("./session-wakeup-monitor.cjs");

const MODEL = "opencode-go/deepseek-v4-flash";
const SCENARIO = ["delivery", "correction", "attention", "review_handoff"].includes(process.env.AGENT_LOOP_REAL_CONDUCTOR_SCENARIO)
  ? process.env.AGENT_LOOP_REAL_CONDUCTOR_SCENARIO
  : "delivery";
const GENERATE_TEMPLATE = process.env.AGENT_LOOP_REAL_GENERATE_TEMPLATE === "1";
// This is harness-only liveness protection. Production wakeup logic has no
// wall-clock completion timeout and never changes Task state on elapsed time.
const HARNESS_LIMIT_MS = SCENARIO === "review_handoff" ? 360_000 : 180_000;

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

function isOpencodeSession(session) {
  return String(session?.provider ?? "") === "opencode" || path.basename(String(session?.command ?? "")) === "opencode";
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

function scenarioDefinition() {
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
  if (!opencodePath) throw new Error("OpenCode is required for the real-conductor harness.");

  ensureNodePtySpawnHelperExecutable();
  // macOS exposes the same temporary directory through both /var and
  // /private/var. Keep every launch/profile/Provider query on the canonical
  // path so OpenCode does not treat its own workspace as an external write.
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agent-loop-real-conductor-")));
  const taskId = `conductor-e2e-${Date.now()}`;
  const scenario = scenarioDefinition();
  const sessionStore = createSessionStore({ root });
  const terminalDaemonSupervisor = createOrcaTerminalDaemonSupervisor();
  const terminalRuntime = createOrcaTerminalDaemonManager({
    endpointProvider: () => terminalDaemonSupervisor.start(),
    sessionStore,
  });
  const openCodeHookService = createOpenCodeHookService();
  const sessionAuthority = createSessionAuthority({ ptyManager: terminalRuntime, databasePath: path.join(root, "terminal.sqlite") });
  let runtime;
  let bridge;
  let bridgeServer;
  let monitor;

  terminalRuntime.onEvent((event) => {
    sessionAuthority.handlePtyEvent(event);
    if (event?.type === "exit") openCodeHookService.clearSession(event.id);
  });

  bridge = createConductorToolBridge({
    sessionStore,
    ptyManager: terminalRuntime,
    activateWorkerSession: ({ sessionId, operationId }) =>
      sessionAuthority.activateSession({
        workspaceSessionId: sessionId,
        operationId,
        callerId: "real-conductor-harness",
        reason: "conductor-dispatch",
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
      generateTemplateFromDescription: generateAgentLoopTemplate,
      getConductorBridgeConfig: async () => ({
        conductorToolBridgeUrl: bridgeServer.url,
        conductorToolBridgeToken: bridgeServer.token,
        conductorMcpServerPath: path.join(__dirname, "conductor-mcp-server.cjs"),
      }),
      registerProviderHook: ({ sessionId, cwd }) =>
        openCodeHookService.registerSession({
          sessionId,
          cwd,
          onEvent: (event) => monitor?.handleProviderHookEvent(event),
        }),
    });

    monitor = createSessionWakeupMonitor({
      ptyManager: terminalRuntime,
      dispatchStateReader: ({ session, dispatch }) =>
        isOpencodeSession(session)
          ? inspectDispatchProviderState({
            dispatchId: dispatch.dispatchId,
            cwd: session.cwd,
            dispatchCreatedAt: dispatch.createdAt,
          }).catch(() => undefined)
          : undefined,
      sessionStore,
      dispatchResultReader: ({ session, dispatch }) =>
        isOpencodeSession(session)
          ? getDispatchAssistantAnswer({ dispatchId: dispatch.dispatchId, cwd: session.cwd, dispatchCreatedAt: dispatch.createdAt }).catch(() => undefined)
          : undefined,
      conductorMessageReader: async ({ session, afterMessageCreatedAt }) => {
        if (!isOpencodeSession(session)) return undefined;
        const providerSession = await findProviderSessionForConductorTask({ cwd: session.cwd, taskId: session.taskId }).catch(() => undefined);
        return providerSession?.providerSessionId
          ? getLastEffectiveAssistantAnswer({ providerSessionId: providerSession.providerSessionId, afterMessageCreatedAt }).catch(() => undefined)
          : undefined;
      },
      conductorQuestionReader: ({ session, afterMessageCreatedAt }) =>
        isOpencodeSession(session)
          ? getLastPendingQuestionForConductorTask({ cwd: session.cwd, taskId: session.taskId, afterMessageCreatedAt }).catch(() => undefined)
          : undefined,
      workerQuestionReader: ({ session, afterMessageCreatedAt }) =>
        isOpencodeSession(session)
          ? getLastPendingQuestionForDirectory({ cwd: session.cwd, afterMessageCreatedAt }).catch(() => undefined)
          : undefined,
      resolveAgentId: ({ taskId: requestedTaskId, sessionId }) => runtime?.taskAgentMap({ taskId: requestedTaskId })?.[sessionId],
      enqueueConductorInput: ({ sessionId, expectedIncarnationId, source, payload, idempotencyKey }) =>
        sessionAuthority.enqueueInput({
          workspaceSessionId: sessionId,
          expectedIncarnationId,
          source,
          payload,
          idempotencyKey,
        }),
    });
    monitor.start();

    const generatedTemplate = GENERATE_TEMPLATE
      ? await runtime.generateTemplateDraft({
        cwd: root,
        projectName: "Generated Agent Loop E2E",
        description: [
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
      assert.equal(generatedTemplate.template.agents.length, 1, "one-sentence generated E2E Template must produce one native Session Agent card");
      assert.match(generatedTemplate.template.agents[0].name, /publisher/i, "generated Agent card must preserve the requested Publisher capability");
      assert.deepEqual(generatedTemplate.template.agents[0].mcp, []);
      assert.deepEqual(generatedTemplate.template.agents[0].skills, []);
    }
    const generatedTemplateForSave = generatedTemplate
      ? {
        ...generatedTemplate.template,
        // The one-sentence generator may suggest a generic report path. This
        // harness simulates the user editing that optional preference before
        // save so the Task's explicit final.md acceptance contract is
        // unambiguous; it is not a Runtime delivery rule.
        delivery: { artifactPath: "final.md", ownerAgentId: "" },
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
      description: SCENARIO === "review_handoff"
        ? "Conductor chooses native Searcher, Reviewer, and Publisher assignments from complete semantic results."
        : "One native Publisher creates the declared artifact; Conductor reacts to the semantic Provider return.",
      source: "manual",
      conductor: {
        role: "Conductor",
        model: MODEL,
        charter: SCENARIO === "review_handoff"
          ? "Use native Session answers as complete semantic materials. A Reviewer’s `needs changes` is ordinary message content, not a Runtime status. When it identifies a factual evidence gap, decide whether to dispatch a suitable evidence-capable card with the exact Review result in contextRefs; after evidence returns, decide whether another review is useful. Dispatch Publisher only with the selected material you judge ready for delivery. This is decision guidance, not a fixed route."
          : "Treat every explicit requirement in the task goal as an acceptance condition. Before claim_task_completion, compare those conditions with the exact durable Provider result. If a result says DRAFT_INCOMPLETE or lacks a required token, dispatch a bounded correction to an approved native Session Agent; never claim delivery on that turn.",
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
      delivery: SCENARIO === "attention" ? {} : { artifactPath: "final.md" },
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
      const artifactPath = path.join(root, "final.md");
      if (!fs.existsSync(artifactPath)) return undefined;
      const hasProviderReceipt = semanticEvents.filter((event) => event.type === "dispatch.provider.received").length === scenario.expectedDispatches;
      const hasProviderResult = publisher?.details?.dispatches?.some((dispatch) => dispatch.status === "result_available");
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
    const publisher = turnForAgent(runtimeView, "publisher") ?? runtimeView.turns.find((turn) => turn.nodeId !== "conductor");
    const semanticEvents = runtimeView.runtimeState.events ?? [];
    assert.equal(semanticEvents.filter((event) => event.type === "dispatch.provider.received").length, scenario.expectedDispatches, "each dispatch must have one durable Provider receipt transition");
    assert.equal(semanticEvents.filter((event) => event.type === "conductor.wakeup.sent").length, scenario.expectedWakeups, "each Provider result must wake the next Conductor decision exactly once");
    assert.equal(semanticEvents.some((event) => event.type === "session.waiting_conductor"), true, "the first Conductor decision must end before the Runtime wakeup");
    if (SCENARIO === "attention") {
      const publisherSession = runtimeView.runtimeState.sessions.find((session) => session.sessionId === publisher?.sessionId);
      assert.equal(completed.task.status, "running");
      assert.equal(runtimeView.run.status, "running");
      assert.equal(publisherSession?.state, "waiting_input");
      assert.equal(fs.existsSync(path.join(root, "final.md")), false);
      const providerQuestion = await getLastPendingQuestionForDirectory({ cwd: root });
      assert.match(String(providerQuestion?.questionText ?? ""), new RegExp(escapeRegExp(scenario.question), "i"));
    } else {
      assert.equal(publisher?.details?.dispatches?.some((dispatch) => dispatch.status === "result_available"), true);
      if (scenario.requiresConductorClaim !== false) {
        assert.equal(runtimeView.run.status, "delivery_ready");
        if (GENERATE_TEMPLATE) {
          const receiptIndex = semanticEvents.findIndex((event) => event.type === "dispatch.provider.received");
          const claimIndex = semanticEvents.findIndex((event) => event.type === "task.completion_claim");
          assert.ok(receiptIndex >= 0, "generated Template E2E must record Provider receipt");
          assert.ok(claimIndex > receiptIndex, "generated Template E2E must claim delivery only after the Provider receipt");
        }
      }
      assert.match(String(publisher?.output?.answerText ?? ""), /final\.md/i);
    }
    if (SCENARIO === "correction") {
      assert.equal(publisher?.details?.dispatches?.length, 2, "the correction must reuse the approved Publisher card");
      assert.match(String(publisher?.details?.dispatches?.[0]?.assignment ?? ""), /DRAFT_INCOMPLETE/);
      assert.match(String(publisher?.details?.dispatches?.[1]?.assignment ?? ""), /AGENT_LOOP_REAL_CORRECTION_OK/);
    }
    if (SCENARIO === "review_handoff") {
      assertReviewHandoff(runtimeView);
    }

    const conductor = runtimeView.turns.find((turn) => turn.nodeId === "conductor");
    const conductorSnapshot = await terminalRuntime.getSnapshot(conductor.sessionId);
    const publisherSnapshot = await terminalRuntime.getSnapshot(publisher.sessionId);
    if (SCENARIO === "attention") {
      assert.match(conductorSnapshot.ansi, /needs input|selected Publisher terminal|native Session terminal/i);
      assert.match(publisherSnapshot.ansi, new RegExp(escapeRegExp(scenario.question), "i"));
    } else if (scenario.requiresConductorClaim !== false) {
      const achieved = runtime.markTaskAchieved({ taskId });
      assert.equal(achieved.status, "achieved");
      assert.match(conductorSnapshot.ansi, /claim_task_completion|delivery|final\.md/i);
      assert.match(publisherSnapshot.ansi, new RegExp(escapeRegExp(scenario.token)));
    }

    process.stdout.write(
      `${JSON.stringify({
        ok: true,
        scenario: SCENARIO,
        templateSource: template.source,
        generatedTemplate: GENERATE_TEMPLATE,
        generatedTemplateCharterEdited: Boolean(generatedTemplateForSave),
        model: MODEL,
        taskId,
        taskStatus: SCENARIO === "attention" || scenario.requiresConductorClaim === false ? completed.task.status : "achieved",
        runStatus: runtimeView.run.status,
        workerProviderResult: publisher.output?.answerText,
      })}\n`,
    );
  } catch (error) {
    const diagnostics = JSON.stringify({ root, terminals: describeTerminals(terminalRuntime) }, null, 2);
    error.message = `${error.message}\nReal Conductor Harness diagnostics:\n${diagnostics}`;
    error.stack = `${error.stack || error.message}\nReal Conductor Harness diagnostics:\n${diagnostics}`;
    throw error;
  } finally {
    monitor?.stop();
    runtime?.close();
    sessionAuthority.close();
    await terminalRuntime.close();
    await terminalDaemonSupervisor.stop();
    await openCodeHookService.close();
    await bridgeServer?.close();
  }
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});

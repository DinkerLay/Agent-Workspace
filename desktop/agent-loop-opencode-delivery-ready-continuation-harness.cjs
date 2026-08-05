const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createConductorToolBridge } = require("./conductor-tool-bridge.cjs");
const { createSessionStore } = require("./session-store.cjs");
const { createAgentLoopV1Runtime } = require("./runtime/agent-loop-v1-runtime.cjs");
const { createSessionStoreCapabilities } = require("./runtime/session-store-capabilities.cjs");

/**
 * Server-only continuation proof.
 *
 * The fake OpenCode Server exposes the same request-shaped client used by the
 * Runtime.  It deliberately has no PTY or Session Authority: the assertion is
 * about durable Task/Run identity and the existing Provider Session, not a
 * terminal transport.
 */
async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-loop-server-continuation-"));
  let runtime;
  try {
    const calls = {
      ensure: [],
      create: [],
      getSession: [],
      prompt: [],
      message: [],
      validationDuringFollowUp: undefined,
    };
    let server;
    let taskId = "";
    let publisherWorkspaceSessionId;
    const manager = {
      async ensureRun(input) {
        calls.ensure.push(input);
        return (server ??= {
          taskId: input.taskId,
          runId: input.runId,
          cwd: input.cwd,
          origin: "http://127.0.0.1:43121",
          providerVersion: "1.18.11",
        });
      },
      getRun() {
        return server;
      },
      subscribeRun() {
        return () => undefined;
      },
      clientForRun() {
        return {
          async createSession(input) {
            calls.create.push(input);
            if (calls.create.length === 1) return { id: "ses_conductor_same_run" };
            if (calls.create.length === 2) return { id: "ses_publisher_after_followup" };
            throw new Error("unexpected_provider_session_create");
          },
          async getSession(input) {
            calls.getSession.push(input);
            return { id: input.providerSessionId, title: "existing bound Session" };
          },
          async promptAsync(input) {
            calls.prompt.push(input);
            return { accepted: true };
          },
          async sendMessage(input) {
            calls.message.push(input);
            // The Run must have opened the next decision epoch before the
            // Server accepts the follow-up. That makes an inline Conductor
            // `call_session` legal in this exact provider turn.
            calls.validationDuringFollowUp = runtime.validateDispatch({
              taskId: input.metadata?.taskId ?? taskId,
              agentId: "publisher",
              toSessionId: publisherWorkspaceSessionId,
            });
            return { accepted: true, providerMessageId: "msg_conductor_followup_1" };
          },
        };
      },
    };

    const sessionStore = createSessionStore({
      root: ({ cwd }) => path.join(cwd, ".agent-workspace", "runtime"),
    });
    const capabilities = createSessionStoreCapabilities(sessionStore);
    runtime = createAgentLoopV1Runtime({
      openCodeServerManager: manager,
      sessionStoreCapabilities: capabilities,
      opencodePath: "/fixture/opencode",
      databasePath: path.join(root, "agent-loop.sqlite"),
      getConductorBridgeConfig: async () => ({
        conductorToolBridgeUrl: "http://127.0.0.1:5288",
        conductorToolBridgeToken: "harness-token",
        conductorMcpServerPath: path.join(__dirname, "conductor-mcp-server.cjs"),
      }),
    });

    const template = runtime.saveTemplate({
      id: "server-continuation-template",
      name: "Server continuation template",
      source: "manual",
      conductor: {
        role: "Conductor",
        model: "opencode-go/gpt-5.6-luna",
        charter: "Decide the next bounded Session Agent dispatch from durable inputs.",
      },
      agents: [{
        id: "publisher",
        name: "Publisher",
        kind: "publisher",
        model: "opencode-go/gpt-5.6-luna",
        dispatchProfile: {
          title: "Evidence-backed delivery",
          description: "Use when the current Task needs a final, bounded deliverable.",
        },
        workerSystemPrompt: "Create the requested deliverable only from the supplied verified material.",
      }],
      limits: { maxConcurrentSessions: 1, maxDispatchesPerDecision: 1 },
      delivery: { artifactPath: "report.md", ownerAgentId: "publisher" },
    });
    const task = runtime.createTask({
      taskId: "task-server-delivery-ready-followup",
      cwd: root,
      title: "Server delivery-ready continuation",
      goal: "Continue the same Conductor Session after a delivery-ready user follow-up.",
      templateId: template.id,
    });
    taskId = task.taskId;
    const started = await runtime.startRun({ taskId, commandId: "command-server-continuation-start" });
    const runId = started.run.runId;
    const conductorSessionId = started.run.conductorSessionId;
    publisherWorkspaceSessionId = runtime.resolveAgentSession({ taskId, agentId: "publisher" }).sessionId;

    assert.equal(calls.create.length, 1, "only the initial Conductor Provider Session is created before follow-up");
    assert.equal(calls.create[0].agent, "build");
    assert.equal(calls.prompt[0].providerSessionId, "ses_conductor_same_run");

    const claimed = runtime.recordCompletionClaim({
      taskId,
      sessionId: conductorSessionId,
      message: "The first delivery is ready for inspection.",
    });
    assert.equal(claimed.task.status, "delivery_ready");
    assert.equal(claimed.run.runId, runId);
    assert.equal(claimed.run.status, "running", "delivery_ready does not create or close a logical Run");
    assert.equal(
      runtime.validateDispatch({ taskId, agentId: "publisher", toSessionId: publisherWorkspaceSessionId }).ok,
      false,
      "the previous Conductor decision epoch cannot dispatch after its delivery claim",
    );

    const followUp = await runtime.recordUserMessage({
      taskId,
      commandId: "command-server-delivery-ready-followup",
      message: "Please add a short executive summary before finalizing.",
    });
    assert.equal(followUp.ok, true);
    assert.equal(calls.message.length, 1, "the follow-up is sent through the existing Conductor Provider Session");
    assert.equal(calls.message[0].providerSessionId, "ses_conductor_same_run");
    assert.match(calls.message[0].text, /executive summary/);
    assert.deepEqual(calls.validationDuringFollowUp, { ok: true });
    assert.equal(calls.create.length, 1, "a follow-up never creates a replacement Conductor Provider Session");
    assert.ok(calls.getSession.some((call) => call.providerSessionId === "ses_conductor_same_run"), "the exact persisted Conductor Session is reconciled before reuse");

    const wakeup = capabilities.readModel.readTaskState({ taskId, sinceCursor: 0 }).wakeups
      .find((item) => item.wakeupKey === `user:${taskId}:${followUp.messageId}`);
    assert.equal(wakeup?.status, "observed", "Server acceptance is persisted as the exact Conductor input receipt");
    assert.equal(wakeup?.providerSessionId, "ses_conductor_same_run");
    assert.equal(wakeup?.providerMessageId, "msg_conductor_followup_1");

    const continued = runtime.readRun({ runId });
    assert.equal(continued.task.status, "running");
    assert.equal(continued.run.runId, runId, "continuation remains in the same logical Run");
    assert.equal(continued.run.conductorSessionId, conductorSessionId);

    const bridge = createConductorToolBridge({
      sessionStore,
      ptyManager: {},
      validateDispatch: (input) => runtime.validateDispatch(input),
      resolveAgentSession: (input) => runtime.resolveAgentSession(input),
      prepareDispatchContext: (input) => runtime.prepareDispatchContext(input),
      deliverProviderAssignment: (input) => runtime.deliverOpenCodeWorkerAssignment(input),
      resolveConductorSessionId: () => conductorSessionId,
    });
    const publisher = await bridge.callSession({
      taskId,
      agentId: "publisher",
      assignment: "Create report.md with the requested executive summary.",
      expectedOutput: "report.md",
    });
    assert.equal(publisher.ok, true);
    assert.equal(publisher.agentId, "publisher");
    assert.equal(publisher.status, "accepted");
    assert.equal(calls.create.length, 2, "Publisher receives its own Provider Session after continuation");
    assert.equal(calls.create[1].metadata.agentWorkspaceRunId, runId);
    assert.equal(calls.prompt.at(-1).providerSessionId, "ses_publisher_after_followup");
    assert.equal(calls.prompt.at(-1).agent, "build");

    const afterPublisher = runtime.readRun({ runId });
    assert.equal(afterPublisher.run.runId, runId);
    assert.equal(afterPublisher.run.conductorSessionId, conductorSessionId);
    assert.equal(afterPublisher.task.status, "running");
    assert.ok(calls.ensure.every((input) => input.runId === runId), "all Server calls attach the original Run Host");

    console.log("OpenCode Server delivery-ready continuation harness passed");
  } finally {
    runtime?.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

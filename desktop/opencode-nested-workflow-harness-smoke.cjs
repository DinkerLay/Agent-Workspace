const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { createPtyManager } = require("./pty-manager.cjs");
const { createOrchestrationHarness } = require("./runtime/orchestration-harness.cjs");
const { createSessionAuthority } = require("./runtime/session-authority.cjs");
const { createSessionStore } = require("./session-store.cjs");
const { resolveOpencodePath } = require("./opencode-runner.cjs");

async function main() {
  const opencodePath = resolveOpencodePath();
  assert.ok(opencodePath, "A local OpenCode binary is required for this smoke.");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-workspace-harness-"));
  const pty = require("node-pty");
  const sessionStore = createSessionStore({ root });
  const ptyManager = createPtyManager({ pty, spawn, sessionStore, stoppedSessionRetentionMs: 60_000 });
  const sessionAuthority = createSessionAuthority({
    ptyManager,
    databasePath: path.join(root, "terminal-runtime.sqlite"),
  });
  const harness = createOrchestrationHarness({
    sessionAuthority,
    ptyManager,
    sessionStore,
    opencodePath,
    databasePath: path.join(root, "orchestration-harness.sqlite"),
  });
  const unsubscribe = ptyManager.onEvent((event) => {
    sessionAuthority.handlePtyEvent(event);
    void harness.handlePtyEvent(event).catch((error) => {
      process.stderr.write(`Harness event failure: ${error.stack || error.message}\n`);
    });
  });

  try {
    const draft = await harness.generateTemplateDraft({
      cwd: process.cwd(),
      title: "OpenCode generated nested workflow smoke",
      goal: "Generate a bounded Agent Loop policy and a reviewable Workflow graph, then prove the real runtime executes it.",
    });
    assert.equal(draft.status, "generated");
    assert.ok(draft.candidate.workflow.definition.nodes.length >= 2);
    assert.ok(draft.candidate.workflow.definition.nodes.length <= 4);
    const savedDraft = harness.saveGeneratedTemplateDraft({ draftId: draft.draftId });
    assert.equal(savedDraft.status, "saved");
    assert.ok(savedDraft.savedTemplates?.agentLoop);
    assert.ok(savedDraft.savedTemplates?.workflow);
    assert.ok(savedDraft.savedTemplates?.blueprint);

    const task = harness.createHarnessTask({
      taskId: `harness-${Date.now().toString(36)}`,
      projectId: "agent-workspace",
      cwd: process.cwd(),
      title: "OpenCode generated nested workflow smoke",
      goal: "Prove one generated Agent Loop contains and executes one generated Workflow graph.",
      templateBlueprintId: savedDraft.savedTemplates.blueprint.id,
      templateBlueprintVersion: savedDraft.savedTemplates.blueprint.version,
    });
    assert.equal(task.architecture.templateBlueprint?.id, savedDraft.savedTemplates.blueprint.id);
    const started = await harness.startHarnessRun({ taskId: task.taskId });
    const completed = await waitForRun(harness, started.run.runId, 90_000);
    assert.equal(completed.run.status, "delivery_ready");
    assert.ok(completed.nodes.length >= 2);
    assert.ok(completed.nodes.every((node) => node.status === "succeeded"));
    assert.equal(completed.workflow.status, "succeeded");
    assert.ok(completed.turns.some((turn) => turn.purpose === "initial" && turn.status === "succeeded"));
    assert.equal(completed.turns.filter((turn) => turn.purpose === "workflow_node" && turn.status === "succeeded").length, completed.nodes.length);
    assert.ok(completed.turns.some((turn) => turn.purpose === "workflow_return" && turn.status === "succeeded"));
    assert.ok(completed.turns.filter((turn) => turn.status === "succeeded").every((turn) => turn.output?.answerText));
    assert.ok(completed.turns.some((turn) => turn.status === "succeeded" && turn.terminal?.backend === "pty"));
    assert.ok(completed.events.some((event) => event.type === "workflow.completed"));
    assert.equal(completed.events.filter((event) => event.type === "conductor.decision").length, 2);

    process.stdout.write(
      `${JSON.stringify(
        {
          ok: true,
          taskId: task.taskId,
          draftId: draft.draftId,
          generatedTemplates: savedDraft.savedTemplates,
          runId: completed.run.runId,
          status: completed.run.status,
          nodeStates: completed.nodes.map((node) => ({ id: node.nodeId, status: node.status })),
          turns: completed.turns.map((turn) => ({ purpose: turn.purpose, sessionId: turn.sessionId, backend: turn.terminal?.backend })),
          workflowCompletionSequence: completed.events.find((event) => event.type === "workflow.completed")?.sequence,
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    unsubscribe();
    harness.close();
    sessionAuthority.close();
  }
}

async function waitForRun(harness, runId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let latest;
  do {
    latest = harness.readRun({ runId });
    if (latest?.run?.status === "delivery_ready") return latest;
    if (latest?.run?.status === "blocked") throw new Error(`Harness Run blocked: ${JSON.stringify(latest.events.at(-1))}`);
    await delay(200);
  } while (Date.now() < deadline);
  throw new Error(`Harness Run timed out: ${JSON.stringify(latest?.events?.at(-1))}`);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});

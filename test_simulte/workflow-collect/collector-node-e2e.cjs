#!/usr/bin/env node

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { app, BrowserWindow } = require("electron");
const {
  createElectronSimulationHarness,
  waitUntil,
} = require("../lib/electron-simulation-harness.cjs");

const taskTitle = "Collector Node E2E — nested OpenCode workflow";
const taskGoal = "Simulate the collect node: aggregate prior-node evidence into a reviewable artifact.";
const model = "opencode-go/deepseek-v4-flash";

const EVIDENCE_DIR = process.env.AGENT_WORKSPACE_E2E_EVIDENCE_DIR ?? fs.mkdtempSync(
  path.join(os.tmpdir(), "agent-workspace-collector-evid-"),
);

function evidencePath(name) {
  return path.join(EVIDENCE_DIR, name);
}

function hashContent(content) {
  return crypto.createHash("sha256").update(content).digest("hex").slice(0, 16);
}

app.commandLine.appendSwitch("disable-gpu");

async function main() {
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  const stepLog = [];
  function logStep(step, detail) {
    const entry = { t: new Date().toISOString(), step, detail };
    stepLog.push(entry);
    process.stderr.write(`[collector-e2e] ${step}: ${JSON.stringify(detail)}\n`);
    fs.appendFileSync(evidencePath("step-log.jsonl"), JSON.stringify(entry) + "\n");
  }

  logStep("setup", { evidenceDir: EVIDENCE_DIR });

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-workspace-collector-node-e2e-"));
  const projectPath = path.join(root, "project");
  fs.mkdirSync(projectPath, { recursive: true });
  const opencodePath = writeFakeOpencodeBinary(root);

  const harness = await createElectronSimulationHarness({
    root,
    projectPath,
    opencodePath,
    model,
    requireRealPty: false,
  });
  logStep("harness_created", { root, projectPath });

  try {
    const window = await harness.createWindow();
    logStep("window_created", {});

    const taskId = "collector-e2e-task-001";
    const collectorSessionId = `opencode:project-runtime-current:${taskId}:${taskId}-collector`;
    const upstreamSessionIds = [
      `opencode:project-runtime-current:${taskId}:${taskId}-researcher`,
      `opencode:project-runtime-current:${taskId}:${taskId}-reviewer`,
    ];

    harness.sessionStore.startSession({
      taskId,
      sessionId: collectorSessionId,
      command: "opencode",
      cwd: projectPath,
      provider: "opencode",
      model,
    });
    for (const sid of upstreamSessionIds) {
      harness.sessionStore.startSession({
        taskId,
        sessionId: sid,
        command: "opencode",
        cwd: projectPath,
        provider: "opencode",
        model,
      });
    }
    logStep("sessions_started", {
      collectorSessionId,
      upstreamCount: upstreamSessionIds.length,
    });

    // Simulate upstream nodes producing evidence
    const upstreamEvidence = [];
    for (let i = 0; i < upstreamSessionIds.length; i++) {
      const sid = upstreamSessionIds[i];
      const dispatch = harness.sessionStore.recordDispatch({
        taskId,
        toSessionId: sid,
        assignment: `[Agent Workspace] Dispatch ID NODE00${i + 1}\nCollect evidence for collector node.\n\x1b[200~payload\x1b[201~\r`,
      });
      harness.sessionStore.markDispatchDelivered({
        taskId,
        sessionId: sid,
        dispatchId: dispatch.dispatchId,
      });
      const result = harness.sessionStore.recordDispatchResult({
        taskId,
        sessionId: sid,
        dispatchId: dispatch.dispatchId,
        reason: "provider-answer-available",
        answerText: `Upstream evidence from node-${i}: ${JSON.stringify({
          findings: `research-result-${i + 1}`,
          artifacts: [`docs/research/findings-${i + 1}.md`],
          confidence: 0.85 + i * 0.1,
        })}`,
      });
      upstreamEvidence.push({
        sessionId: sid,
        dispatchId: dispatch.dispatchId,
        resultId: result.resultId,
        answerHash: hashContent(result.answerText),
        answerLength: result.answerText.length,
      });
      logStep("upstream_evidence_produced", {
        sessionIndex: i,
        dispatchId: dispatch.dispatchId,
        resultId: result.resultId,
        answerHash: hashContent(result.answerText),
      });
    }

    // Collect: aggregate upstream evidence into a collector artifact
    const collectorDispatch = harness.sessionStore.recordDispatch({
      taskId,
      toSessionId: collectorSessionId,
      assignment: `[Agent Workspace] Dispatch ID NODE100\nAggregate ${upstreamEvidence.length} upstream artifacts.\n\x1b[200~aggregate\x1b[201~\r`,
    });
    harness.sessionStore.markDispatchDelivered({
      taskId,
      sessionId: collectorSessionId,
      dispatchId: collectorDispatch.dispatchId,
    });

    const consolidatedAnswer = JSON.stringify({
      collector: "aggregation-result",
      upstreamEvidence: upstreamEvidence.map((e) => ({
        sessionId: e.sessionId,
        dispatchId: e.dispatchId,
        resultId: e.resultId,
        answerHash: e.answerHash,
      })),
      aggregatedAt: new Date().toISOString(),
      artifactPaths: [
        evidencePath("evidence-chain.json"),
        evidencePath("step-log.jsonl"),
        evidencePath("screenshot.png"),
        evidencePath("collector-summary.json"),
      ],
    });

    const collectorResult = harness.sessionStore.recordDispatchResult({
      taskId,
      sessionId: collectorSessionId,
      dispatchId: collectorDispatch.dispatchId,
      reason: "provider-answer-available",
      answerText: consolidatedAnswer,
    });
    logStep("collector_aggregated", {
      collectorDispatchId: collectorDispatch.dispatchId,
      collectorResultId: collectorResult.resultId,
      upstreamCount: upstreamEvidence.length,
      answerBytes: Buffer.byteLength(consolidatedAnswer),
    });

    // Capture screenshot via BrowserWindow capturePage
    let screenshotBase64 = null;
    try {
      const image = await window.webContents.capturePage();
      screenshotBase64 = image.toPNG().toString("base64");
      fs.writeFileSync(evidencePath("screenshot.png"), image.toPNG());
      logStep("screenshot_captured", {
        byteLength: image.toPNG().length,
        dest: evidencePath("screenshot.png"),
      });
    } catch (err) {
      logStep("screenshot_failed", { error: err.message });
    }

    // Write evidence chain as structured artifact
    const evidenceChain = {
      meta: {
        scenario: "workflow-collect/collector-node-e2e",
        collectedAt: new Date().toISOString(),
        evidenceDir: EVIDENCE_DIR,
        collectorSessionId,
        taskId,
        model,
      },
      sessions: {
        collector: {
          sessionId: collectorSessionId,
          state: "delivered_pending",
        },
        upstream: upstreamSessionIds.map((sid, i) => ({
          index: i,
          sessionId: sid,
          evidence: upstreamEvidence[i],
        })),
      },
      timeline: stepLog,
      artifacts: [
        {
          name: "step-log.jsonl",
          path: evidencePath("step-log.jsonl"),
          bytes: fs.statSync(evidencePath("step-log.jsonl")).size,
        },
        {
          name: "evidence-chain.json",
          path: evidencePath("evidence-chain.json"),
          note: "this file",
        },
        {
          name: "screenshot.png",
          path: evidencePath("screenshot.png"),
          bytes: screenshotBase64 ? fs.statSync(evidencePath("screenshot.png")).size : 0,
        },
      ],
    };
    fs.writeFileSync(
      evidencePath("evidence-chain.json"),
      JSON.stringify(evidenceChain, null, 2),
    );
    logStep("evidence_chain_written", {
      path: evidencePath("evidence-chain.json"),
      bytes: Buffer.byteLength(JSON.stringify(evidenceChain)),
    });

    // Read back and verify state
    const taskState = harness.sessionStore.readTaskState({ taskId });
    assert.ok(taskState, "task state must exist");
    assert.equal(taskState.sessions.length, upstreamSessionIds.length + 1,
      "expected all sessions in task state");
    const collectorSummary = taskState.sessions.find(
      (s) => s.sessionId === collectorSessionId,
    );
    assert.ok(collectorSummary, "collector session must appear in task state");
    assert.equal(collectorSummary.lastResultId, collectorResult.resultId,
      "collector result must be reflected in task state");
    logStep("state_verified", {
      sessionCount: taskState.sessions.length,
      collectorLastResultId: collectorSummary.lastResultId,
      collectorState: collectorSummary.state,
    });

    const collectorSummaryArtifact = {
      ok: true,
      scenario: "workflow-collect/collector-node-e2e",
      taskId,
      collectorSessionId,
      collectorDispatchId: collectorDispatch.dispatchId,
      collectorResultId: collectorResult.resultId,
      upstreamCount: upstreamEvidence.length,
      evidenceChainHash: hashContent(JSON.stringify(evidenceChain)),
      screenshotBytes: screenshotBase64 ? Buffer.byteLength(screenshotBase64, "base64") : 0,
      artifactPaths: evidenceChain.artifacts.map((a) => a.path),
      collectorState: collectorSummary.state,
      collectorResultId: collectorSummary.lastResultId,
      timestamp: new Date().toISOString(),
    };
    fs.writeFileSync(
      evidencePath("collector-summary.json"),
      JSON.stringify(collectorSummaryArtifact, null, 2),
    );

    console.log(JSON.stringify(collectorSummaryArtifact, null, 2));
    logStep("complete", { ok: true });
  } finally {
    await harness.cleanup();
  }
}

function writeFakeOpencodeBinary(root) {
  const target = path.join(root, "fake-opencode.cjs");
  fs.writeFileSync(
    target,
    `#!/usr/bin/env node
process.stdout.write('Ask anything... "Fix a TODO in the codebase"\\n');
process.stdout.write('tab agents  ctrl+p commands\\n');
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  process.stdout.write('\\n[agent-workspace-fake-opencode-received]\\n');
  process.stdout.write(String(chunk).replace(/\\x1b\\[[0-9;]*[~A-Za-z]/g, ''));
  process.stdout.write('\\nAsk anything... "Fix a TODO in the codebase"\\n');
  process.stdout.write('tab agents  ctrl+p commands\\n');
});
const timer = setInterval(() => undefined, 1000);
process.on('SIGTERM', () => { clearInterval(timer); process.exit(0); });
process.on('SIGINT', () => { clearInterval(timer); process.exit(0); });
`,
  );
  fs.chmodSync(target, 0o755);
  return target;
}

main()
  .then(() => app.exit(0))
  .catch((error) => {
    process.stderr.write(`Collector E2E FAILED: ${error.stack || error.message}\n`);
    app.exit(1);
  });

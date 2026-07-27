import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  AGENT_LOOP_TEMPLATE_ID,
  BLUEPRINT_ID,
  WORKFLOW_NODE_REGISTRY,
  WORKFLOW_TEMPLATE_ID,
  createOrchestrationHarness,
  extractOpenCodeOutput,
  resolveNodeIdentities,
} from "./orchestration-harness.cjs";

function createHarnessFixture({ runOpenCode, openCodeHookService, databasePath } = {}) {
  const profiles = new Map();
  const transcripts = new Map();
  const events = [];
  const stopped = [];
  const inputs = [];
  const sessionAuthority = {
    registerLaunchProfile(profile) {
      profiles.set(profile.workspaceSessionId, profile);
      return { workspaceSessionId: profile.workspaceSessionId, taskId: profile.taskId, fingerprint: profile.workspaceSessionId };
    },
    async activateSession({ workspaceSessionId }) {
      const profile = profiles.get(workspaceSessionId);
      return {
        workspaceSessionId,
        owner: { workspaceSessionId, incarnationId: `inc-${workspaceSessionId}`, generation: "gen", state: "active" },
        session: { id: workspaceSessionId, taskId: profile.taskId, status: "running" },
      };
    },
    stopSession({ workspaceSessionId }) {
      stopped.push(workspaceSessionId);
      return { id: workspaceSessionId, status: "stopping" };
    },
    async enqueueInput(input) {
      inputs.push(input);
      return {
        disposition: "written",
        workspaceSessionId: input.workspaceSessionId,
        incarnationId: input.expectedIncarnationId,
        source: input.source,
      };
    },
  };
  const ptyManager = {
    read(id) {
      return {
        id,
        status: "running",
        incarnationId: `inc-${id}`,
        transcript: [transcripts.get(id) ?? ""],
        exitCode: 0,
      };
    },
  };
  const sessionStore = {
    recordTaskEvent(event) {
      events.push(event);
      return { ...event, cursor: events.length };
    },
  };
  const harness = createOrchestrationHarness({
    sessionAuthority,
    ptyManager,
    sessionStore,
    opencodePath: "/fake/opencode",
    runOpenCode,
    openCodeHookService,
    databasePath,
    randomUUID: (() => {
      let index = 0;
      return () => `00000000-0000-4000-8000-${String(++index).padStart(12, "0")}`;
    })(),
  });
  return { events, harness, inputs, profiles, stopped, transcripts };
}

function output(text) {
  return [
    JSON.stringify({ type: "text", sessionID: "ses-harness", part: { text } }),
    JSON.stringify({ type: "step_finish", timestamp: Date.now(), part: { reason: "stop" } }),
  ].join("\n");
}

describe("OpenCode nested workflow harness", () => {
  it("seeds distinct Agent Loop and Workflow templates", () => {
    const { harness } = createHarnessFixture();
    const templates = harness.listTemplates();

    expect(templates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: AGENT_LOOP_TEMPLATE_ID, family: "agent_loop" }),
        expect.objectContaining({ id: WORKFLOW_TEMPLATE_ID, family: "workflow" }),
      ]),
    );
    expect(harness.getTemplate({ templateId: AGENT_LOOP_TEMPLATE_ID }).definition.nestedWorkflow).toMatchObject({
      templateId: WORKFLOW_TEMPLATE_ID,
    });
    expect(harness.listTemplateBlueprints()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: BLUEPRINT_ID,
          agentLoopTemplate: expect.objectContaining({ id: AGENT_LOOP_TEMPLATE_ID }),
          workflowTemplate: expect.objectContaining({ id: WORKFLOW_TEMPLATE_ID }),
        }),
      ]),
    );
    harness.close();
  });

  it("preserves the user's single-pass DeepSearch Blueprint and publishes a dynamic v3 successor", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-workspace-deepsearch-upgrade-"));
    const databasePath = path.join(root, "orchestration.sqlite");
    const first = createHarnessFixture({ databasePath });
    const workflow = first.harness.saveTemplateVersion({
      id: "generated-deepsearch-v1-workflow-workflow",
      family: "workflow",
      version: 1,
      name: "deepsearch-v1-workflow",
      definition: {
        nodes: [
          { id: "research", role: "Researcher", instruction: "Collect bounded evidence.", kind: "delegate", dependsOn: [] },
          { id: "verify", role: "Verifier", instruction: "Verify evidence.", kind: "verify", dependsOn: ["research"] },
        ],
      },
    });
    const legacyLoop = first.harness.saveTemplateVersion({
      id: "generated-deepsearch-v1-agent-loop",
      family: "agent_loop",
      version: 1,
      name: "deepsearch-v1",
      definition: {
        conductor: { provider: "opencode", role: "Research Conductor" },
        nestedWorkflow: { templateId: workflow.id, version: workflow.version },
        returnPolicy: { wakeOn: ["workflow.completed", "workflow.failed"] },
      },
    });
    first.harness.saveTemplateBlueprint({
      id: "blueprint-deepsearch",
      version: 2,
      name: "DeepSearch",
      description: "single-pass legacy blueprint",
      agentLoopTemplate: { id: legacyLoop.id, version: legacyLoop.version },
      workflowTemplate: { id: workflow.id, version: workflow.version },
      source: "generated",
    });
    first.harness.close();

    const second = createHarnessFixture({ databasePath });
    expect(second.harness.getTemplateBlueprint({ blueprintId: "blueprint-deepsearch", version: 2 })?.description).toContain("single-pass");
    expect(second.harness.getTemplateBlueprint({ blueprintId: "blueprint-deepsearch" })).toMatchObject({
      version: 3,
      agentLoopTemplate: { id: legacyLoop.id, version: 2 },
    });
    expect(second.harness.getTemplate({ templateId: legacyLoop.id, version: 2 })?.definition).toMatchObject({
      returnPolicy: { everyMeaningfulSessionReturn: true },
      decisionPolicy: { dynamicReplanning: true, maxDispatchesPerDecision: 1 },
    });
    second.harness.close();
  });

  it("runs research and verify without an intermediate Conductor wakeup, then returns once", async () => {
    const { events, harness, profiles, transcripts } = createHarnessFixture();
    const task = harness.createHarnessTask({
      taskId: "harness-task",
      projectId: "project-harness",
      cwd: "/tmp",
      title: "Nested Workflow Harness",
      goal: "Exercise an Agent Loop containing a bounded Workflow.",
    });
    const starting = await harness.startHarnessRun({ taskId: task.taskId });
    const conductorId = starting.turns[0].sessionId;
    expect(profiles.get(conductorId).args.slice(0, 3)).toEqual(["--mini", "--model", "opencode-go/deepseek-v4-flash"]);
    expect(profiles.get(conductorId).requirePty).toBe(true);
    expect(profiles.get(conductorId).args.at(-1)).toContain("- research (Researcher; entry node): Researcher");
    expect(profiles.get(conductorId).args.at(-1)).toContain("- verify (Verifier; depends on research): Verifier");

    transcripts.set(conductorId, output("CONDUCTOR_START: launch the approved workflow."));
    await harness.handlePtyEvent({ type: "exit", id: conductorId, exitCode: 0 });
    const afterInitial = harness.readRun({ runId: starting.run.runId });
    const researchTurn = afterInitial.turns.find((turn) => turn.nodeId === "research");
    expect(researchTurn?.status).toBe("running");
    expect(afterInitial.events.map((event) => event.type)).not.toContain("conductor.wakeup");

    transcripts.set(researchTurn.sessionId, output("RESEARCH_RESULT: bounded output is retained by Runtime."));
    await harness.handlePtyEvent({ type: "exit", id: researchTurn.sessionId, exitCode: 0 });
    const afterResearch = harness.readRun({ runId: starting.run.runId });
    const verifyTurn = afterResearch.turns.find((turn) => turn.nodeId === "verify");
    expect(verifyTurn?.status).toBe("running");
    expect(afterResearch.events.map((event) => event.type)).not.toContain("conductor.wakeup");

    transcripts.set(verifyTurn.sessionId, output("VERIFY_RESULT: PASS. The research result supports review."));
    await harness.handlePtyEvent({ type: "exit", id: verifyTurn.sessionId, exitCode: 0 });
    const afterWorkflow = harness.readRun({ runId: starting.run.runId });
    const finalTurn = afterWorkflow.turns.filter((turn) => turn.purpose === "workflow_return").at(-1);
    expect(afterWorkflow.workflow.status).toBe("succeeded");
    expect(finalTurn?.status).toBe("running");
    expect(afterWorkflow.events.map((event) => event.type)).toContain("workflow.completed");

    transcripts.set(finalTurn.sessionId, output(JSON.stringify({ decision: "deliver", summaryMarkdown: "## 交付摘要\n验证通过。", remediations: [] })));
    await harness.handlePtyEvent({ type: "exit", id: finalTurn.sessionId, exitCode: 0 });
    const completed = harness.readRun({ runId: starting.run.runId });
    expect(completed.run.status).toBe("delivery_ready");
    expect(completed.task.status).toBe("delivery_ready");
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining(["task.architecture_confirmed", "workflow.created", "workflow.completed", "conductor.decision"]),
    );
    harness.close();
  });

  it("gives research nodes Markdown evidence paths and reserves HTML for the Conductor-dispatched Publisher", async () => {
    const { harness, profiles, transcripts } = createHarnessFixture();
    const task = harness.createHarnessTask({
      taskId: "html-delivery",
      projectId: "project-harness",
      cwd: "/tmp",
      title: "Claude timeline",
      goal: "Collect primary sources and produce an HTML timeline file.",
    });
    const contract = task.architecture.sessionPlan.deliveryContract;
    expect(contract.finalArtifact).toMatchObject({ format: "html", path: "deliverables/html-delivery/claude-timeline.html" });
    expect(task.architecture.sessionPlan.loopRoles).toEqual([{ id: "publisher", role: "HTML Publisher", kind: "publisher" }]);

    const starting = await harness.startHarnessRun({ taskId: task.taskId });
    const conductor = starting.turns[0];
    transcripts.set(conductor.sessionId, output(JSON.stringify({ action: "launch_workflow", summaryMarkdown: "## Plan\nCollect evidence first." })));
    await harness.handlePtyEvent({ type: "exit", id: conductor.sessionId, exitCode: 0 });

    const research = harness.readRun({ runId: starting.run.runId }).turns.find((turn) => turn.nodeId === "research");
    const prompt = profiles.get(research.sessionId).args.at(-1);
    expect(prompt).toContain("evidence/html-delivery/research.md");
    expect(prompt).toContain("Never create HTML");
    expect(prompt).not.toContain(contract.finalArtifact.path);
    harness.close();
  });

  it("does not invent a Publisher for an evidence-only task that explicitly forbids files", () => {
    const { harness } = createHarnessFixture();
    const task = harness.createHarnessTask({
      taskId: "no-files",
      projectId: "project-harness",
      cwd: "/tmp",
      title: "Bounded answer",
      goal: "Return one bounded answer. Do not create files or use tools.",
    });
    expect(task.architecture.sessionPlan.deliveryContract.finalArtifact).toBeUndefined();
    expect(task.architecture.sessionPlan.loopRoles).toEqual([]);
    harness.close();
  });

  it("keeps a delivered Task as achieved history after the user confirms its files", async () => {
    const { harness, transcripts } = createHarnessFixture();
    const task = harness.createHarnessTask({ taskId: "achieved-task", projectId: "project-harness", cwd: "/tmp", title: "Achieve", goal: "Collect a bounded answer." });
    const starting = await harness.startHarnessRun({ taskId: task.taskId });
    const initial = starting.turns[0];
    transcripts.set(initial.sessionId, output("CONDUCTOR_START: launch workflow."));
    await harness.handlePtyEvent({ type: "exit", id: initial.sessionId, exitCode: 0 });
    const research = harness.readRun({ runId: starting.run.runId }).turns.find((turn) => turn.nodeId === "research");
    transcripts.set(research.sessionId, output("RESEARCH_RESULT: bounded evidence."));
    await harness.handlePtyEvent({ type: "exit", id: research.sessionId, exitCode: 0 });
    const verify = harness.readRun({ runId: starting.run.runId }).turns.find((turn) => turn.nodeId === "verify");
    transcripts.set(verify.sessionId, output("VERIFY_RESULT: PASS."));
    await harness.handlePtyEvent({ type: "exit", id: verify.sessionId, exitCode: 0 });
    const final = harness.readRun({ runId: starting.run.runId }).turns.find((turn) => turn.purpose === "workflow_return");
    transcripts.set(final.sessionId, output(JSON.stringify({ action: "deliver", summaryMarkdown: "## Delivery\nReady." })));
    await harness.handlePtyEvent({ type: "exit", id: final.sessionId, exitCode: 0 });

    expect(harness.markTaskAchieved({ taskId: task.taskId })).toMatchObject({ status: "achieved" });
    expect(harness.readRun({ runId: starting.run.runId }).run.status).toBe("delivery_ready");
    await expect(harness.startHarnessRun({ taskId: task.taskId })).rejects.toThrow("harness_task_achieved");
    harness.close();
  });

  it("extracts completed text parts from OpenCode JSON output", () => {
    expect(extractOpenCodeOutput(output("HARNESS_OK"))).toMatchObject({
      answerText: "HARNESS_OK",
      providerSessionId: "ses-harness",
    });
  });

  it("falls back to OpenCode's human terminal output without leaking JSON protocol lines into the UI", () => {
    expect(extractOpenCodeOutput("\u001b[2K\u001b[1G# Result\n\n| Check | Status |\n| --- | --- |\n| Build | PASS |")).toMatchObject({
      answerText: "# Result\n| Check | Status |\n| --- | --- |\n| Build | PASS |",
      source: "opencode-run-terminal",
    });
  });

  it("retries a transient OpenCode Session failure without waking the Conductor", async () => {
    const { events, harness, transcripts } = createHarnessFixture();
    const task = harness.createHarnessTask({ taskId: "retry-task", projectId: "project-harness", cwd: "/tmp", title: "Retry", goal: "Recover safely." });
    const starting = await harness.startHarnessRun({ taskId: task.taskId });
    const conductorId = starting.turns[0].sessionId;

    transcripts.set(conductorId, JSON.stringify({ type: "error", sessionID: "ses-harness", error: { message: "transient provider failure" } }));
    await harness.handlePtyEvent({ type: "exit", id: conductorId, exitCode: 1 });
    const retrying = harness.readRun({ runId: starting.run.runId });

    expect(retrying.run.status).toBe("running");
    expect(retrying.turns.filter((turn) => turn.purpose === "initial")).toHaveLength(2);
    expect(retrying.turns.at(-1)?.status).toBe("running");
    expect(retrying.events.map((event) => event.type)).toContain("session.retrying");
    expect(retrying.events.map((event) => event.type)).not.toContain("conductor.wakeup");
    expect(events.map((event) => event.type)).toContain("session.retrying");
    harness.close();
  });

  it("starts independent Workflow nodes as separate concurrent OpenCode Sessions", async () => {
    const { harness, transcripts } = createHarnessFixture();
    const draft = harness.createManualTemplateDraft({
      cwd: "/tmp",
      title: "Parallel evidence",
      description: "Collect three independent evidence tracks, synthesize them, then verify the result.",
      agentLoop: { name: "Parallel loop", conductorRole: "Conductor" },
      workflow: {
        name: "Parallel evidence graph",
        nodes: [
          { id: "source-a", role: "Source A", instruction: "Collect the first independent source.", kind: "delegate", dependsOn: [] },
          { id: "source-b", role: "Source B", instruction: "Collect the second independent source.", kind: "delegate", dependsOn: [] },
          { id: "source-c", role: "Source C", instruction: "Collect the third independent source.", kind: "delegate", dependsOn: [] },
          { id: "verify", role: "Verifier", instruction: "Verify all three source results.", kind: "verify", dependsOn: ["source-a", "source-b", "source-c"] },
        ],
      },
    });
    const saved = harness.saveGeneratedTemplateDraft({ draftId: draft.draftId });
    const task = harness.createHarnessTask({
      cwd: "/tmp",
      title: "Parallel task",
      goal: "Collect three independent bounded results.",
      templateBlueprintId: saved.savedTemplates.blueprint.id,
      templateBlueprintVersion: saved.savedTemplates.blueprint.version,
    });
    const starting = await harness.startHarnessRun({ taskId: task.taskId });
    const conductor = starting.turns[0];
    transcripts.set(conductor.sessionId, output("CONDUCTOR_START: launch the approved workflow."));
    await harness.handlePtyEvent({ type: "exit", id: conductor.sessionId, exitCode: 0 });

    const afterInitial = harness.readRun({ runId: starting.run.runId });
    const initialSources = afterInitial.turns.filter((turn) => ["source-a", "source-b", "source-c"].includes(turn.nodeId));
    expect(initialSources).toHaveLength(2);
    expect(initialSources.every((turn) => turn.status === "running")).toBe(true);
    expect(afterInitial.nodes.filter((node) => ["source-a", "source-b", "source-c"].includes(node.nodeId) && node.status === "pending")).toHaveLength(1);

    const firstSource = initialSources[0];
    transcripts.set(firstSource.sessionId, output(`${firstSource.nodeId.toUpperCase().replace(/-/g, "_")}_RESULT: bounded evidence.`));
    await harness.handlePtyEvent({ type: "exit", id: firstSource.sessionId, exitCode: 0 });
    const thirdSource = harness.readRun({ runId: starting.run.runId }).turns.find((turn) => turn.nodeId === "source-c");
    expect(thirdSource?.status).toBe("running");

    const sources = [...initialSources.slice(1), thirdSource];
    for (const source of sources) {
      transcripts.set(source.sessionId, output(`${source.nodeId.toUpperCase().replace(/-/g, "_")}_RESULT: bounded evidence.`));
      await harness.handlePtyEvent({ type: "exit", id: source.sessionId, exitCode: 0 });
    }

    const afterSources = harness.readRun({ runId: starting.run.runId });
    expect(afterSources.turns.find((turn) => turn.nodeId === "verify")?.status).toBe("running");
    harness.close();
  });

  it("blocks a Task when its Workflow fails instead of marking it ready for Review", async () => {
    const { events, harness, transcripts } = createHarnessFixture();
    const task = harness.createHarnessTask({ taskId: "failed-workflow", projectId: "project-harness", cwd: "/tmp", title: "Failure", goal: "Surface a recoverable failure." });
    const starting = await harness.startHarnessRun({ taskId: task.taskId });
    const conductor = starting.turns[0];
    transcripts.set(conductor.sessionId, output("CONDUCTOR_START: launch the approved workflow."));
    await harness.handlePtyEvent({ type: "exit", id: conductor.sessionId, exitCode: 0 });

    const research = harness.readRun({ runId: starting.run.runId }).turns.find((turn) => turn.nodeId === "research");
    expect(research).toBeTruthy();
    transcripts.set(research.sessionId, JSON.stringify({ type: "error", sessionID: "ses-harness", error: { message: "provider failed" } }));
    await harness.handlePtyEvent({ type: "exit", id: research.sessionId, exitCode: 1 });
    await harness.handlePtyEvent({ type: "exit", id: research.sessionId, exitCode: 1 });
    await harness.handlePtyEvent({ type: "exit", id: research.sessionId, exitCode: 1 });

    const finalTurn = harness.readRun({ runId: starting.run.runId }).turns.filter((turn) => turn.purpose === "workflow_return").pop();
    expect(finalTurn?.status).toBe("running");
    transcripts.set(finalTurn.sessionId, output("CONDUCTOR_EXCEPTION: workflow failed; operator inspection is required before a new Run."));
    await harness.handlePtyEvent({ type: "exit", id: finalTurn.sessionId, exitCode: 0 });

    const blocked = harness.readRun({ runId: starting.run.runId });
    expect(blocked.workflow.status).toBe("failed");
    expect(blocked.instances.find((instance) => instance.kind === "agent_loop")?.status).toBe("failed");
    expect(blocked.run.status).toBe("blocked");
    expect(blocked.task.status).toBe("blocked");
    expect(events.map((event) => event.type)).toContain("conductor.blocked");
    harness.close();
  });

  it("keeps evidence repair, verification, and final publishing in distinct Conductor-controlled Sessions", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-workspace-remediation-"));
    execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
    const { harness, transcripts } = createHarnessFixture();
    const task = harness.createHarnessTask({
      taskId: "artifact-remediation",
      projectId: "project-harness",
      cwd: root,
      title: "Artifact remediation",
      goal: "Write report.md with a verified release report file.",
    });
    const starting = await harness.startHarnessRun({ taskId: task.taskId });
    const initial = starting.turns[0];
    transcripts.set(initial.sessionId, output("CONDUCTOR_START: launch the approved workflow."));
    await harness.handlePtyEvent({ type: "exit", id: initial.sessionId, exitCode: 0 });

    const research = harness.readRun({ runId: starting.run.runId }).turns.find((turn) => turn.nodeId === "research" && turn.purpose === "workflow_node");
    transcripts.set(research.sessionId, output("RESEARCH_RESULT: draft is incomplete."));
    await harness.handlePtyEvent({ type: "exit", id: research.sessionId, exitCode: 0 });
    const verify = harness.readRun({ runId: starting.run.runId }).turns.find((turn) => turn.nodeId === "verify" && turn.purpose === "workflow_node");
    transcripts.set(verify.sessionId, output("VERIFY_RESULT: NEEDS_REMEDIATION. research evidence is missing the verified release source."));
    await harness.handlePtyEvent({ type: "exit", id: verify.sessionId, exitCode: 0 });

    const conductor = harness.readRun({ runId: starting.run.runId }).turns.filter((turn) => turn.purpose === "workflow_return").at(-1);
    transcripts.set(conductor.sessionId, output(JSON.stringify({
      decision: "remediate",
      summaryMarkdown: "## 自动修复\n将缺失证据回派给 Researcher。",
      remediations: [{ nodeId: "research", instruction: "Add the verified release source to the research Markdown evidence." }],
    })));
    await harness.handlePtyEvent({ type: "exit", id: conductor.sessionId, exitCode: 0 });

    const remediation = harness.readRun({ runId: starting.run.runId }).turns.find((turn) => turn.purpose === "remediation" && turn.nodeId === "research");
    expect(remediation?.status).toBe("running");
    const contract = task.architecture.sessionPlan.deliveryContract;
    const researchEvidence = contract.evidence.find((item) => item.nodeId === "research");
    fs.mkdirSync(path.dirname(path.join(root, researchEvidence.path)), { recursive: true });
    fs.writeFileSync(path.join(root, researchEvidence.path), "# Research evidence\n\n| Check | Result |\n| --- | --- |\n| Source | PASS |\n", "utf8");
    transcripts.set(remediation.sessionId, output("REMEDIATION_RESULT: updated the research Markdown evidence."));
    await harness.handlePtyEvent({ type: "exit", id: remediation.sessionId, exitCode: 0 });

    const afterCorrection = harness.readRun({ runId: starting.run.runId });
    const correctionReturn = afterCorrection.turns.filter((turn) => turn.purpose === "session_return").at(-1);
    expect(correctionReturn?.status).toBe("running");
    expect(afterCorrection.events.map((event) => event.type)).toContain("conductor.wakeup");
    transcripts.set(correctionReturn.sessionId, output(JSON.stringify({
      action: "verify",
      summaryMarkdown: "## 下一步\n补证已返回，交由 Verifier 重新检查。",
      targetNodeId: "",
      instruction: "",
    })));
    await harness.handlePtyEvent({ type: "exit", id: correctionReturn.sessionId, exitCode: 0 });

    const reverify = harness.readRun({ runId: starting.run.runId }).turns.find((turn) => turn.purpose === "remediation_verify");
    expect(reverify?.status).toBe("running");
    transcripts.set(reverify.sessionId, output("VERIFY_RESULT: PASS. The research Markdown evidence contains the verified source."));
    await harness.handlePtyEvent({ type: "exit", id: reverify.sessionId, exitCode: 0 });
    const finalConductor = harness.readRun({ runId: starting.run.runId }).turns.filter((turn) => turn.purpose === "session_return").at(-1);
    transcripts.set(finalConductor.sessionId, output(JSON.stringify({ decision: "deliver", summaryMarkdown: "## 交付摘要\n证据已验证，准备交付文件。", remediations: [] })));
    await harness.handlePtyEvent({ type: "exit", id: finalConductor.sessionId, exitCode: 0 });

    const publisher = harness.readRun({ runId: starting.run.runId }).turns.find((turn) => turn.purpose === "remediation" && turn.nodeId === "publisher");
    expect(publisher?.status).toBe("running");
    const finalPath = contract.finalArtifact.path;
    fs.mkdirSync(path.dirname(path.join(root, finalPath)), { recursive: true });
    fs.writeFileSync(path.join(root, finalPath), "# Release report\n\n| Check | Result |\n| --- | --- |\n| Evidence | PASS |\n", "utf8");
    transcripts.set(publisher.sessionId, output("PUBLISH_RESULT: created the final report.md from verified Markdown evidence."));
    await harness.handlePtyEvent({ type: "exit", id: publisher.sessionId, exitCode: 0 });

    const publishReturn = harness.readRun({ runId: starting.run.runId }).turns.filter((turn) => turn.purpose === "session_return").at(-1);
    transcripts.set(publishReturn.sessionId, output(JSON.stringify({ decision: "deliver", summaryMarkdown: "## 交付摘要\n报告已发布。", remediations: [] })));
    await harness.handlePtyEvent({ type: "exit", id: publishReturn.sessionId, exitCode: 0 });

    const completed = harness.readRun({ runId: starting.run.runId });
    expect(completed.run.status).toBe("delivery_ready");
    expect(completed.events.map((event) => event.type)).toEqual(expect.arrayContaining(["conductor.dispatch", "conductor.verify", "conductor.wakeup", "conductor.deliver"]));
    expect(completed.artifacts).toEqual(expect.arrayContaining([expect.objectContaining({ path: finalPath, change: "added", nodeId: "publisher" })]));
    expect(harness.readArtifact({ runId: starting.run.runId, artifactPath: finalPath })).toMatchObject({ contentType: "markdown", content: expect.stringContaining("| Evidence | PASS |") });
    harness.close();
  });

  it("never batches two corrective dispatches: the second one requires a fresh Conductor decision", async () => {
    const { harness, profiles, transcripts } = createHarnessFixture();
    const task = harness.createHarnessTask({
      taskId: "one-dispatch-per-decision",
      projectId: "project-harness",
      cwd: "/tmp",
      title: "One dispatch at a time",
      goal: "Collect a bounded research answer. Do not create files.",
    });
    const starting = await harness.startHarnessRun({ taskId: task.taskId });
    const initial = starting.turns[0];
    transcripts.set(initial.sessionId, output(JSON.stringify({ action: "launch_workflow", summaryMarkdown: "## Plan\nStart the bounded workflow." })));
    await harness.handlePtyEvent({ type: "exit", id: initial.sessionId, exitCode: 0 });
    const research = harness.readRun({ runId: starting.run.runId }).turns.find((turn) => turn.nodeId === "research" && turn.purpose === "workflow_node");
    transcripts.set(research.sessionId, output("RESEARCH_RESULT: initial evidence."));
    await harness.handlePtyEvent({ type: "exit", id: research.sessionId, exitCode: 0 });
    const verify = harness.readRun({ runId: starting.run.runId }).turns.find((turn) => turn.nodeId === "verify" && turn.purpose === "workflow_node");
    transcripts.set(verify.sessionId, output("VERIFY_RESULT: NEEDS_REVIEW. Gather a narrower primary source."));
    await harness.handlePtyEvent({ type: "exit", id: verify.sessionId, exitCode: 0 });

    const workflowReturn = harness.readRun({ runId: starting.run.runId }).turns.find((turn) => turn.purpose === "workflow_return");
    transcripts.set(workflowReturn.sessionId, output(JSON.stringify({
      action: "dispatch",
      summaryMarkdown: "## Next\nAsk Researcher for the missing primary source.",
      targetNodeId: "research",
      instruction: "Find the authoritative source URL for the unsupported claim.",
    })));
    await harness.handlePtyEvent({ type: "exit", id: workflowReturn.sessionId, exitCode: 0 });

    const firstDispatch = harness.readRun({ runId: starting.run.runId }).turns.find((turn) => turn.purpose === "remediation");
    expect(firstDispatch?.status).toBe("running");
    expect(profiles.get(firstDispatch.sessionId).args.at(-1)).toContain("This is an evidence-only Task");
    expect(profiles.get(firstDispatch.sessionId).args.at(-1)).not.toContain("`undefined`");
    expect(harness.readRun({ runId: starting.run.runId }).turns.filter((turn) => turn.purpose === "remediation")).toHaveLength(1);
    transcripts.set(firstDispatch.sessionId, output("REMEDIATION_RESULT: primary source URL returned."));
    await harness.handlePtyEvent({ type: "exit", id: firstDispatch.sessionId, exitCode: 0 });

    const firstReturn = harness.readRun({ runId: starting.run.runId }).turns.filter((turn) => turn.purpose === "session_return").at(-1);
    expect(firstReturn?.status).toBe("running");
    expect(harness.readRun({ runId: starting.run.runId }).turns.filter((turn) => turn.purpose === "remediation")).toHaveLength(1);
    transcripts.set(firstReturn.sessionId, output(JSON.stringify({
      action: "dispatch",
      summaryMarkdown: "## Next\nAsk Researcher to incorporate the new evidence.",
      targetNodeId: "research",
      instruction: "Rewrite the affected claim with its source URL and scope.",
    })));
    await harness.handlePtyEvent({ type: "exit", id: firstReturn.sessionId, exitCode: 0 });
    expect(harness.readRun({ runId: starting.run.runId }).turns.filter((turn) => turn.purpose === "remediation")).toHaveLength(2);
    harness.close();
  });

  it("keeps a running Session untouched until the provider reports a real exit", async () => {
    const { events, harness, stopped } = createHarnessFixture();
    const task = harness.createHarnessTask({ taskId: "live-task", projectId: "project-harness", cwd: "/tmp", title: "Live state", goal: "Wait for a real provider exit." });
    const starting = await harness.startHarnessRun({ taskId: task.taskId });
    const firstTurn = starting.turns[0];

    expect(harness.readRun({ runId: starting.run.runId }).turns.find((turn) => turn.turnId === firstTurn.turnId)?.status).toBe("running");
    expect(stopped).toEqual([]);
    expect(events.map((event) => event.type)).not.toContain("session.timeout");
    harness.close();
  });

  it("persists OpenCode attention and only writes an explicit response to the same PTY", async () => {
    const registrations = [];
    const cleared = [];
    const hookService = {
      async registerSession(input) {
        registrations.push(input);
        return {
          env: {
            AGENT_WORKSPACE_HOOK_ENDPOINT: "http://127.0.0.1:9999/hook/opencode",
            AGENT_WORKSPACE_HOOK_TOKEN: "fixture-token",
            AGENT_WORKSPACE_HOOK_SESSION_ID: input.sessionId,
          },
        };
      },
      clearSession(sessionId) {
        cleared.push(sessionId);
      },
    };
    const { events, harness, inputs, profiles } = createHarnessFixture({ openCodeHookService: hookService });
    const task = harness.createHarnessTask({
      taskId: "attention-task",
      projectId: "project-harness",
      cwd: "/tmp",
      title: "Attention routing",
      goal: "Wait for an OpenCode permission request.",
    });
    const starting = await harness.startHarnessRun({ taskId: task.taskId });
    const turn = starting.turns[0];

    expect(profiles.get(turn.sessionId)).toMatchObject({
      stdin: "pipe",
      env: expect.objectContaining({ AGENT_WORKSPACE_HOOK_TOKEN: "fixture-token" }),
    });
    expect(registrations).toHaveLength(1);

    await registrations[0].onEvent({
      sessionId: turn.sessionId,
      kind: "permission",
      payload: { permission: "bash", patterns: ["npm test"], message: "Run the test suite?" },
    });
    const waiting = harness.readRun({ runId: starting.run.runId });
    expect(waiting.attentions).toEqual([
      expect.objectContaining({ sessionId: turn.sessionId, kind: "permission", status: "pending" }),
    ]);
    expect(inputs).toEqual([]);

    const afterReply = await harness.respondToAttention({
      attentionId: waiting.attentions[0].attentionId,
      response: "allow",
    });
    expect(inputs).toEqual([
      expect.objectContaining({
        workspaceSessionId: turn.sessionId,
        expectedIncarnationId: `inc-${turn.sessionId}`,
        source: "permission_reply",
        payload: "allow\r",
      }),
    ]);
    expect(afterReply.attentions[0]).toMatchObject({ status: "submitted" });

    await registrations[0].onEvent({ sessionId: turn.sessionId, kind: "status", payload: { type: "busy" } });
    expect(harness.readRun({ runId: starting.run.runId }).attentions[0]).toMatchObject({ status: "resolved" });
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining(["session.permission.requested", "session.attention.responded", "session.attention.resolved"]),
    );
    expect(cleared).toEqual([]);
    harness.close();
  });

  it("advances a native mini-TUI Session from OpenCode assistant text plus idle, not terminal scraping", async () => {
    const registrations = [];
    const hookService = {
      async registerSession(input) {
        registrations.push(input);
        return { env: { AGENT_WORKSPACE_HOOK_TOKEN: "fixture-token" } };
      },
      clearSession() {},
    };
    const { harness, stopped } = createHarnessFixture({ openCodeHookService: hookService });
    const task = harness.createHarnessTask({
      taskId: "mini-tui-hook-task",
      projectId: "project-harness",
      cwd: "/tmp",
      title: "Mini TUI hook completion",
      goal: "Advance only after OpenCode returns an assistant message.",
    });
    const starting = await harness.startHarnessRun({ taskId: task.taskId });
    const initial = starting.turns[0];

    await registrations[0].onEvent({
      sessionId: initial.sessionId,
      kind: "message",
      payload: { role: "assistant", sessionID: "ses-native-tui", text: "CONDUCTOR_START: launch the approved workflow." },
    });
    await registrations[0].onEvent({ sessionId: initial.sessionId, kind: "status", payload: { type: "idle" } });

    const advanced = harness.readRun({ runId: starting.run.runId });
    expect(advanced.turns.find((turn) => turn.turnId === initial.turnId)).toMatchObject({
      status: "succeeded",
      output: expect.objectContaining({ action: "launch_workflow", source: "opencode-hook-message" }),
    });
    expect(advanced.turns.find((turn) => turn.nodeId === "research" && turn.purpose === "workflow_node")?.status).toBe("running");
    expect(stopped).toContain(initial.sessionId);
    harness.close();
  });

  it("generates a constrained Loop policy and Workflow graph, then explicitly saves both templates", async () => {
    const plannerOutput = {
      agentLoop: { name: "Release risk control", conductorRole: "Release Conductor" },
      workflow: {
        name: "Release evidence graph",
        nodes: [
          { id: "inspect", role: "Inspector", instruction: "Inspect the bounded release evidence.", kind: "delegate", dependsOn: [] },
          { id: "verify", role: "Verifier", instruction: "Verify the release evidence.", kind: "verify", dependsOn: ["inspect"] },
        ],
      },
      rationale: "Inspect first, then verify evidence before a human review handoff.",
      assumptions: ["No production deployment occurs in this bounded workflow."],
    };
    let plannerAttempts = 0;
    const { harness } = createHarnessFixture({
      runOpenCode: async () => {
        plannerAttempts += 1;
        return { ok: true, stdout: output(plannerAttempts === 1 ? "I should return JSON." : JSON.stringify(plannerOutput)) };
      },
    });

    const generated = await harness.generateTemplateDraft({ cwd: "/tmp", title: "Release risk", goal: "Create reviewable release evidence." });
    expect(generated.status).toBe("generated");
    expect(plannerAttempts).toBe(2);
    expect(generated.candidate.agentLoop.definition).not.toHaveProperty("nestedWorkflow");
    expect(generated.candidate.workflow.definition.nodes).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "inspect", instruction: "Inspect the bounded release evidence." }), expect.objectContaining({ id: "verify", kind: "verify" })]),
    );

    const saved = harness.saveGeneratedTemplateDraft({ draftId: generated.draftId });
    expect(saved.status).toBe("saved");
    expect(saved.savedTemplates?.agentLoop.family).toBe("agent_loop");
    expect(saved.savedTemplates?.workflow.family).toBe("workflow");
    expect(saved.savedTemplates?.blueprint).toMatchObject({
      name: "Release risk",
      source: "generated",
      agentLoopTemplate: { id: saved.savedTemplates?.agentLoop.id },
      workflowTemplate: { id: saved.savedTemplates?.workflow.id },
    });
    const task = harness.createHarnessTask({
      cwd: "/tmp",
      title: "Release risk",
      goal: "Create reviewable release evidence.",
      templateBlueprintId: saved.savedTemplates.blueprint.id,
      templateBlueprintVersion: saved.savedTemplates.blueprint.version,
    });
    expect(task.architecture.templateBlueprint).toMatchObject({ id: saved.savedTemplates.blueprint.id });
    expect(task.architecture.agentLoopTemplate.name).toBe("Release risk control");
    expect(task.architecture.nestedWorkflowTemplate.name).toBe("Release evidence graph");
    harness.close();
  });

  it("persists a hand-built Blueprint without converting the Agent Loop into a graph", () => {
    const { harness } = createHarnessFixture();
    const draft = harness.createManualTemplateDraft({
      cwd: "/tmp",
      title: "Manual release evidence",
      description: "Inspect a release candidate, then verify evidence for a human reviewer.",
      agentLoop: { name: "Manual release loop", conductorRole: "Release Conductor" },
      workflow: {
        name: "Manual release graph",
        nodes: [
          { id: "inspect", role: "Inspector", kind: "delegate", dependsOn: [] },
          { id: "verify", role: "Verifier", kind: "verify", dependsOn: ["inspect"] },
        ],
      },
    });

    expect(draft.status).toBe("manual");
    expect(draft.candidate.agentLoop.definition).not.toHaveProperty("nodes");
    expect(draft.candidate.workflow.definition.nodes).toHaveLength(2);

    const saved = harness.saveGeneratedTemplateDraft({ draftId: draft.draftId });
    expect(saved.status).toBe("saved");
    expect(saved.savedTemplates?.blueprint).toMatchObject({
      name: "Manual release evidence",
      source: "manual",
    });
    expect(harness.listTemplateBlueprints()).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: saved.savedTemplates?.blueprint.id, source: "manual" })]),
    );

    const task = harness.createHarnessTask({
      cwd: "/tmp",
      title: "Run manual architecture",
      goal: "Run the saved Blueprint only after task confirmation.",
      templateBlueprintId: saved.savedTemplates.blueprint.id,
      templateBlueprintVersion: saved.savedTemplates.blueprint.version,
    });
    expect(task.architecture.templateBlueprint).toMatchObject({ name: "Manual release evidence" });
    expect(task.architecture.agentLoopTemplate.name).toBe("Manual release loop");
    expect(task.architecture.nestedWorkflowTemplate.name).toBe("Manual release graph");
    harness.close();
  });

  it("rejects generated graphs that make an Agent Loop look like a Workflow", async () => {
    const { harness } = createHarnessFixture({
      runOpenCode: async () => ({
        ok: true,
        stdout: output(JSON.stringify({
          agentLoop: { name: "Invalid loop", conductorRole: "Conductor" },
          workflow: { name: "Invalid graph", nodes: [{ id: "only", role: "Only", kind: "verify", dependsOn: [] }] },
        })),
      }),
    });
    await expect(harness.generateTemplateDraft({ cwd: "/tmp", title: "Invalid", goal: "Invalid." })).rejects.toThrow("workflow_node_count_invalid");
    harness.close();
  });

  it("rejects a generated node that tries to dispatch more agents from inside one Session", async () => {
    const { harness } = createHarnessFixture({
      runOpenCode: async () => ({
        ok: true,
        stdout: output(JSON.stringify({
          agentLoop: { name: "Invalid loop", conductorRole: "Conductor" },
          workflow: {
            name: "Invalid graph",
            nodes: [
              { id: "dispatch", role: "Dispatch agents", instruction: "Dispatch three agents and collect their results.", kind: "delegate", dependsOn: [] },
              { id: "verify", role: "Verifier", kind: "verify", dependsOn: ["dispatch"] },
            ],
          },
        })),
      }),
    });
    await expect(harness.generateTemplateDraft({ cwd: "/tmp", title: "Invalid orchestration", goal: "Run multiple agents." })).rejects.toThrow("workflow_node_must_be_single_session_work");
    harness.close();
  });

  it("refuses to start a legacy Blueprint whose node promises nested agent dispatch", () => {
    const { harness } = createHarnessFixture();
    const workflow = harness.saveTemplateVersion({
      id: "legacy-dispatch-workflow",
      family: "workflow",
      version: 1,
      name: "Legacy dispatch workflow",
      definition: {
        nodes: [
          { id: "dispatch", role: "Dispatch 3 agents", kind: "delegate", dependsOn: [] },
          { id: "verify", role: "Verifier", kind: "verify", dependsOn: ["dispatch"] },
        ],
      },
    });
    const loop = harness.saveTemplateVersion({
      id: "legacy-dispatch-loop",
      family: "agent_loop",
      version: 1,
      name: "Legacy dispatch loop",
      definition: { conductor: { provider: "opencode", role: "Conductor" }, nestedWorkflow: { templateId: workflow.id, version: workflow.version } },
    });
    const blueprint = harness.saveTemplateBlueprint({
      id: "legacy-dispatch-blueprint",
      version: 1,
      name: "Legacy dispatch Blueprint",
      description: "Invalid legacy graph.",
      agentLoopTemplate: { id: loop.id, version: loop.version },
      workflowTemplate: { id: workflow.id, version: workflow.version },
      source: "manual",
    });
    expect(() => harness.createHarnessTask({
      cwd: "/tmp",
      title: "Legacy task",
      goal: "Do not run an unsupported node.",
      templateBlueprintId: blueprint.id,
      templateBlueprintVersion: blueprint.version,
    })).toThrow('Workflow node "dispatch" tries to dispatch other agents');
    harness.close();
  });

  it("exports WORKFLOW_NODE_REGISTRY with known kinds", () => {
    expect(WORKFLOW_NODE_REGISTRY.kinds).toEqual(["delegate", "verify"]);
  });

  it("resolveNodeIdentities accepts delegate and verify", () => {
    expect(() => resolveNodeIdentities([{ id: "a", kind: "delegate" }])).not.toThrow();
    expect(() => resolveNodeIdentities([{ id: "b", kind: "verify" }])).not.toThrow();
  });

  it("resolveNodeIdentities rejects phantom node kinds", () => {
    expect(() => resolveNodeIdentities([{ id: "x", kind: "super_agent" }])).toThrow("workflow_phantom_node_kind");
    expect(() => resolveNodeIdentities([{ id: "y", kind: "" }])).toThrow("workflow_phantom_node_kind");
    expect(() => resolveNodeIdentities([{ id: "z", kind: "delegate" }, { id: "w", kind: "unknown" }])).toThrow("workflow_phantom_node_kind");
  });

  it("rejects a graph with phantom node kinds during generated draft", async () => {
    const { harness } = createHarnessFixture({
      runOpenCode: async () => ({
        ok: true,
        stdout: output(JSON.stringify({
          agentLoop: { name: "Phantom loop", conductorRole: "Conductor" },
          workflow: {
            name: "Phantom graph",
            nodes: [
              { id: "research", role: "Researcher", instruction: "Research.", kind: "delegate", dependsOn: [] },
              { id: "verify", role: "Verifier", instruction: "Verify.", kind: "phantom_kind", dependsOn: ["research"] },
            ],
          },
        })),
      }),
    });
    await expect(harness.generateTemplateDraft({ cwd: "/tmp", title: "Phantom risk", goal: "Prove phantom rejection." })).rejects.toThrow("workflow_phantom_node_kind");
    harness.close();
  });

  it("rejects a manual draft with phantom node kinds", () => {
    const { harness } = createHarnessFixture();
    expect(() =>
      harness.createManualTemplateDraft({
        cwd: "/tmp",
        title: "Phantom manual",
        description: "Should reject.",
        agentLoop: { name: "Phantom loop", conductorRole: "Conductor" },
        workflow: {
          name: "Phantom graph",
          nodes: [
            { id: "a", role: "A", kind: "delegate", dependsOn: [] },
            { id: "b", role: "B", kind: "bogus", dependsOn: ["a"] },
          ],
        },
      }),
    ).toThrow("workflow_phantom_node_kind");
    harness.close();
  });
});

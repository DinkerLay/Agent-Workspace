import { describe, expect, it } from "vitest";
import {
  applyProviderFactToBinding,
  applyProviderFactToInput,
  applyProviderFactToInvocation,
  archiveTask,
  createProviderSessionBinding,
  createTask,
  createTaskArchitectureSnapshot,
  createTemplateDraft,
  createTemplateIdentity,
  deduplicateProviderFact,
  isProviderFactCurrent,
  recordDeliveryEffect,
  recordEnsureBindingEffect,
  requestInvocationCancellation,
  restartTaskRun,
  restoreTask,
  saveTemplateDraft,
  stageAttentionResponse,
  stageInputSubmission,
  startTaskRun,
} from "../src";
import { createFakeProvider, providerFactFixture, templateDefinitionFixture } from "../../test-kit/src";
import { hashDefinition } from "../../runtime-contracts/src";

const NOW = "2026-08-06T00:00:00.000Z";

describe("runtime domain state machines", () => {
  it("keeps Draft metadata separate, versioned and immutable", () => {
    const draft = createTemplateDraft({
      templateDraftId: "template_draft_001",
      ownerId: "user-1",
      metadata: { title: "Research Team", slug: "research-team" },
      definition: templateDefinitionFixture(),
      now: NOW,
    });
    const next = saveTemplateDraft(
      draft,
      1,
      { title: "Research Team v2", slug: "research-team" },
      templateDefinitionFixture(),
      "2026-08-06T00:01:00.000Z",
    );
    expect(draft.metadata.title).toBe("Research Team");
    expect(next.metadata.title).toBe("Research Team v2");
    expect(next.revision).toBe(2);
    expect(() => saveTemplateDraft(next, 1, next.metadata, next.definition, NOW)).toThrow("expected_revision_stale");
  });

  it("freezes a Task Architecture Snapshot and creates only a fresh Run on start", () => {
    const identity = createTemplateIdentity({
      templateId: "template_research_team",
      slug: "research-team",
      title: "Research Team",
      now: NOW,
    });
    const definition = templateDefinitionFixture();
    const version = {
      templateVersionId: "template_version_001",
      templateId: identity.templateId,
      version: 1,
      definition,
      definitionHash: "fnv1a64:fixture",
      createdAt: NOW,
      publishedAt: NOW,
    } as const;
    const snapshot = createTaskArchitectureSnapshot({
      architectureSnapshotId: "architecture_001",
      taskId: "task_001",
      templateVersion: version,
      taskInputValues: [],
      taskGoalContent: "Task title: Investigate\nTask goal:\nFind evidence\nTask inputs:\n(none)\n",
      taskGoalContentDigest: hashDefinition("Task title: Investigate\nTask goal:\nFind evidence\nTask inputs:\n(none)\n"),
      taskGoalCompilerVersion: "task-goal/v1",
      workspace: { workspaceId: "workspace_001", cwd: "/project" },
      now: NOW,
    });
    const task = createTask({ taskId: "task_001", architectureSnapshotId: snapshot.architectureSnapshotId, title: "Investigate", goal: "Find evidence", now: NOW });
    const started = startTaskRun({
      task,
      architecture: snapshot,
      expectedRevision: 1,
      runId: "run_001",
      conductorLogicalSessionId: "logical_session_001",
      runNumber: 1,
      now: NOW,
    });
    expect(started.task.status).toBe("running");
    expect(started.run.status).toBe("starting");
    expect(started.conductorSession.kind).toBe("conductor");
    expect(() => startTaskRun({ ...{
      task: started.task,
      architecture: snapshot,
      expectedRevision: started.task.revision,
      runId: "run_002",
      conductorLogicalSessionId: "logical_session_002",
      runNumber: 2,
      now: NOW,
    } })).toThrow("task_not_startable");
  });

  it("restarts only a terminal active Run as a new Run and never reuses its logical session", () => {
    const definition = templateDefinitionFixture();
    const snapshot = {
      architectureSnapshotId: "architecture_restart",
      taskId: "task_restart",
      templateId: "template_restart",
      templateVersionId: "template_version_restart",
      templateDefinitionHash: "fnv1a64:restart",
      definition,
      taskInputValues: [],
      taskGoalContent: "Task title: Restart\nTask goal:\nStart a clean Run.\nTask inputs:\n(none)\n",
      taskGoalContentDigest: hashDefinition("Task title: Restart\nTask goal:\nStart a clean Run.\nTask inputs:\n(none)\n"),
      taskGoalCompilerVersion: "task-goal/v1" as const,
      workspace: { workspaceId: "workspace_restart", cwd: "/project" },
      createdAt: NOW,
    } as const;
    const previousRun = {
      runId: "run_restart_1",
      taskId: "task_restart",
      conductorLogicalSessionId: "logical_session_restart_1",
      status: "stopped" as const,
      runNumber: 1,
      startedAt: NOW,
      endedAt: NOW,
      revision: 3,
    };
    const task = {
      taskId: "task_restart",
      architectureSnapshotId: snapshot.architectureSnapshotId,
      title: "Restart", goal: "Start a clean Run.", status: "stopped" as const,
      activeRunId: previousRun.runId, revision: 4, createdAt: NOW, updatedAt: NOW,
    };

    const restarted = restartTaskRun({
      task, previousRun, architecture: snapshot, expectedRevision: task.revision,
      runId: "run_restart_2", conductorLogicalSessionId: "logical_session_restart_2", runNumber: 2, now: NOW,
    });

    expect(restarted.task.activeRunId).toBe("run_restart_2");
    expect(restarted.run).toMatchObject({ runId: "run_restart_2", runNumber: 2, status: "starting" });
    expect(restarted.conductorSession.logicalSessionId).toBe("logical_session_restart_2");
  });

  it("retains only an explicitly Achieved, quiescent Task in recycle bin and restores its identity", () => {
    const task = {
      taskId: "task_retained",
      architectureSnapshotId: "architecture_retained",
      title: "Retained result",
      goal: "Keep the original Run and artifact history.",
      status: "stopped" as const,
      activeRunId: "run_retained",
      achievement: { achievedAt: NOW, acceptedArtifactIds: ["artifact_retained"] },
      revision: 7,
      createdAt: NOW,
      updatedAt: NOW,
    };
    const archived = archiveTask({ task, expectedRevision: task.revision, now: "2026-08-06T00:01:00.000Z" });
    expect(archived).toMatchObject({
      taskId: task.taskId,
      activeRunId: task.activeRunId,
      achievement: task.achievement,
      trashedAt: "2026-08-06T00:01:00.000Z",
      revision: 8,
    });
    expect(() => archiveTask({ task: archived, expectedRevision: archived.revision, now: NOW })).toThrow("task_already_in_recycle_bin");

    const restored = restoreTask({ task: archived, expectedRevision: archived.revision, now: "2026-08-06T00:02:00.000Z" });
    expect(restored).toMatchObject({
      taskId: task.taskId,
      activeRunId: task.activeRunId,
      achievement: task.achievement,
      status: "stopped",
      revision: 9,
    });
    expect(restored.trashedAt).toBeUndefined();
    expect(() => archiveTask({
      task: { ...task, achievement: undefined }, expectedRevision: task.revision, now: NOW,
    })).toThrow("task_not_recyclable");
    expect(() => archiveTask({
      task: { ...task, status: "running" }, expectedRevision: task.revision, now: NOW,
    })).toThrow("task_recycle_run_not_terminal");
  });

  it("does not treat accepted delivery as provider receipt", async () => {
    const provider = createFakeProvider({ now: () => NOW });
    const binding = createProviderSessionBinding({
      bindingId: "binding_001", taskId: "task_001", runId: "run_001", logicalSessionId: "logical_session_001",
      executionProfileId: "profile_conductor", provider: "opencode", now: NOW,
    });
    const input = stageInputSubmission({
      inputSubmissionId: "input_001", taskId: "task_001", runId: "run_001", logicalSessionId: "logical_session_001",
      sourceInboxItemId: "inbox_001", bindingId: binding.bindingId, contentMessageId: "message_001",
      content: "continue", sequenceNumber: 1, idempotencyKey: "input-key-1", now: NOW,
    });
    const effect = await provider.submitDelivery({ bindingId: binding.bindingId, inputSubmissionId: input.inputSubmissionId, effectId: "effect-1" });
    const accepted = recordDeliveryEffect(input, effect, NOW);
    expect(accepted.status).toBe("effect_accepted");
    expect(provider.facts).toHaveLength(0);
    const received = applyProviderFactToInput(accepted, providerFactFixture({
      kind: "input_received",
      correlation: { inputSubmissionId: input.inputSubmissionId, nativeMessageId: "msg-1" },
    }), NOW);
    expect(received.status).toBe("provider_received");
    expect(() => applyProviderFactToInput(accepted, providerFactFixture({
      kind: "input_received", correlation: { inputSubmissionId: input.inputSubmissionId },
    }), NOW)).toThrow("provider_receipt_evidence_required");
  });

  it("activates Binding only from an observed Fact and deduplicates repeated Facts", async () => {
    const provider = createFakeProvider({ now: () => NOW });
    const binding = createProviderSessionBinding({
      bindingId: "binding_001", taskId: "task_001", runId: "run_001", logicalSessionId: "logical_session_001",
      executionProfileId: "profile_conductor", provider: "opencode", now: NOW,
    });
    const effect = await provider.ensureBinding({ bindingId: binding.bindingId });
    const pending = recordEnsureBindingEffect(binding, effect, NOW);
    expect(pending.status).toBe("binding_effect_accepted");
    const fact = providerFactFixture();
    const active = applyProviderFactToBinding(pending, fact, NOW);
    expect(active.status).toBe("active");
    const first = deduplicateProviderFact(new Set(), fact);
    const duplicate = deduplicateProviderFact(first.nextDedupKeys, fact);
    expect(first.duplicate).toBe(false);
    expect(duplicate.duplicate).toBe(true);
    expect(isProviderFactCurrent(active, fact)).toBe(true);
    expect(isProviderFactCurrent(active, { ...fact, bindingRevision: 0 })).toBe(false);
    expect(isProviderFactCurrent(active, { ...fact, provider: "codex" })).toBe(false);
  });

  it("rejects stale Attention replies and leaves cancellation unknown until a terminal Fact", () => {
    const attention = {
      attentionId: "attention_001", taskId: "task_001", runId: "run_001", bindingId: "binding_001", bindingRevision: 1,
      nativeRequestId: "request-1", activeInputSubmissionId: "input_001", activeInvocationId: "invocation_001",
      request: { question: "approve?" }, status: "requested" as const, createdAt: NOW, updatedAt: NOW,
    };
    expect(() => stageAttentionResponse(attention, {
      attentionId: attention.attentionId, bindingId: attention.bindingId, bindingRevision: 2, nativeRequestId: "request-1",
      activeInputSubmissionId: "input_001", activeInvocationId: "invocation_001", response: { answer: true },
    }, NOW)).toThrow("stale_attention_binding_revision");
    const invocation = {
      invocationId: "invocation_001", taskId: "task_001", runId: "run_001", replyToLogicalSessionId: "logical_session_001",
      targetLogicalSessionId: "logical_session_002", targetAgentCardId: "agent_card_researcher", bindingId: "binding_001",
      assignmentMessageId: "message_assignment", instruction: "research", acceptanceCriteria: ["evidence"], requestedArtifacts: [],
      status: "running" as const, createdAt: NOW, updatedAt: NOW,
    };
    const cancelling = requestInvocationCancellation(invocation, NOW);
    const unknown = applyProviderFactToInvocation(cancelling, providerFactFixture({
      kind: "transport_unknown", correlation: { invocationId: invocation.invocationId },
    }), NOW);
    expect(unknown.status).toBe("cancellation_unknown");
  });
});

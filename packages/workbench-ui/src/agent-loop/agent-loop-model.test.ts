import type { RuntimeReadModel } from "@agent-workspace/runtime-contracts";
import { describe, expect, it } from "vitest";
import { toAgentLoopRuntimeViewModel } from "./agent-loop-model";

describe("toAgentLoopRuntimeViewModel", () => {
  it("projects immutable Messages, RelayBlocks and Inbox states without a Provider-native session or raw event payload", () => {
    const view = toAgentLoopRuntimeViewModel(readModel());

    expect(view.tasks).toEqual([expect.objectContaining({ taskId: "task_1", title: "Review", status: "running" })]);
    expect(view.selectedTask?.activeRun).toMatchObject({ runId: "run_1", conductorLogicalSessionId: "logical_session_conductor" });
    expect(view.selectedTask?.conductorReadiness).toEqual({
      status: "version_mismatch",
      unavailableReasons: ["provider_version_mismatch"],
      missingCapabilities: [],
    });
    expect(view.selectedTask?.sessions[0]).toMatchObject({ title: "Conductor", binding: { bindingId: "binding_1", provider: "codex" } });
    expect(view.selectedTask?.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        messageId: "message_final",
        kind: "agent_final",
        content: "完整 Worker 回信。",
        relayBlocks: [expect.objectContaining({ suggestedAudience: "publish", topic: "game.board" })],
        inboxDeliveries: [expect.objectContaining({ targetLogicalSessionId: "logical_session_conductor", route: "forward", state: "delivered" })],
      }),
    ]));
    expect(view.selectedTask).not.toHaveProperty("sharedRelayBlocks");
    expect(view.selectedTask?.attentions[0]).toMatchObject({ title: "Permission", prompt: "Allow the checked change?" });
    expect(view.selectedTask?.artifacts[0]).toMatchObject({ displayName: "result.md", contentDigest: "digest" });
    expect(view.selectedTask?.executionGroups[0]).toMatchObject({
      executionGroupId: "session_turn_1",
      status: "completed",
      finalMessageId: "message_final",
      activities: [expect.objectContaining({ status: "failed", title: "读取文件", content: "ENOENT" })],
    });
    expect(JSON.stringify(view)).not.toContain("native-session-secret");
    expect(JSON.stringify(view)).not.toContain("rawProviderPayload");
  });

  it("keeps awaiting-final, terminal-without-final, and ambiguous Turns visibly distinct", () => {
    expect(toAgentLoopRuntimeViewModel(readModelWithTurnStatus("awaiting_final")).selectedTask?.executionGroups[0]?.status)
      .toBe("awaiting_final");
    expect(toAgentLoopRuntimeViewModel(readModelWithTurnStatus("completed")).selectedTask?.executionGroups[0]?.status)
      .toBe("awaiting_final");
    expect(toAgentLoopRuntimeViewModel(readModelWithTurnStatus("ambiguous")).selectedTask?.executionGroups[0]?.status)
      .toBe("ambiguous");
  });

  it("projects non-staged Provider Turns as zero-step groups when no activity survived", () => {
    for (const [turnStatus, groupStatus] of [
      ["failed", "failed"],
      ["ambiguous", "ambiguous"],
      ["completed", "awaiting_final"],
    ] as const) {
      const group = toAgentLoopRuntimeViewModel(readModelWithTurnStatus(turnStatus, false)).selectedTask?.executionGroups[0];
      expect(group).toMatchObject({
        executionGroupId: "session_turn_1",
        provider: "codex",
        status: groupStatus,
        activities: [],
      });
    }
    expect(toAgentLoopRuntimeViewModel(readModelWithTurnStatus("staged", false)).selectedTask?.executionGroups).toEqual([]);
  });

  it("keeps one recovered progress snapshot and leaves the canonical final only in Messages", () => {
    const model = readModel();
    const task = model.task!;
    const progress = {
      ...task.providerActivities[0]!,
      activityId: "activity_progress-live",
      category: "assistant_progress" as const,
      status: "completed" as const,
      title: "Assistant progress",
      detail: undefined,
      content: "正在核对工具结果。",
    };
    const finalActivity = {
      ...progress,
      activityId: "activity_final-live",
      title: "Assistant response",
      content: "完整 Worker 回信。",
    };
    const view = toAgentLoopRuntimeViewModel({
      ...model,
      task: {
        ...task,
        providerActivities: [
          task.providerActivities[0]!,
          progress,
          { ...progress, activityId: "activity_progress-recovered", startedAt: "2026-08-06T00:00:40.000Z" },
          finalActivity,
          { ...finalActivity, activityId: "activity_final-recovered", startedAt: "2026-08-06T00:00:50.000Z" },
        ],
      },
    });

    expect(view.selectedTask?.executionGroups[0]?.activities).toHaveLength(2);
    expect(view.selectedTask?.executionGroups[0]?.activities).toEqual(expect.arrayContaining([
      expect.objectContaining({ category: "tool", title: "读取文件" }),
      expect.objectContaining({ category: "assistant_progress", content: "正在核对工具结果。" }),
    ]));
    expect(view.selectedTask?.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ messageId: "message_final", content: "完整 Worker 回信。" }),
    ]));
  });
});

function readModelWithTurnStatus(
  status: "staged" | "awaiting_final" | "completed" | "failed" | "ambiguous",
  withActivities = true,
): RuntimeReadModel {
  const model = readModel();
  const task = model.task!;
  const { finalMessageId: _finalMessageId, ...turnWithoutFinal } = task.sessionTurns[0]!;
  return {
    ...model,
    task: {
      ...task,
      sessionTurns: [{ ...turnWithoutFinal, status }],
      providerActivities: withActivities ? task.providerActivities : [],
    },
  };
}

function readModel(): RuntimeReadModel {
  return {
    generatedAt: "2026-08-06T00:00:00.000Z",
    configuration: { metaProfileOptions: [], executionProfileReadiness: [], taskSetupDrafts: [], metaSessions: [], metaMessages: [], metaPatchProposals: [], metaTurns: [] },
    workspaceLibrary: { authorizations: [] },
    templateLibrary: {
      templates: [{
        template: { templateId: "template_1", slug: "review", title: "Review", revision: 1, activeVersionId: "template_version_1", createdAt: "2026-08-06T00:00:00.000Z", updatedAt: "2026-08-06T00:00:00.000Z" },
        activeVersion: { templateVersionId: "template_version_1", templateId: "template_1", version: 1, definition: {} as never, definitionHash: "hash", assetManifestHash: "asset", createdAt: "2026-08-06T00:00:00.000Z", publishedAt: "2026-08-06T00:00:00.000Z" },
      }],
      drafts: [],
    },
    taskLibrary: {
      tasks: [{ taskId: "task_1", architectureSnapshotId: "architecture_1", title: "Review", goal: "Review the change", status: "running", activeRunId: "run_1", revision: 3, createdAt: "2026-08-06T00:00:00.000Z", updatedAt: "2026-08-06T00:00:00.000Z" }],
    },
    task: {
      task: { taskId: "task_1", architectureSnapshotId: "architecture_1", title: "Review", goal: "Review the change", status: "running", activeRunId: "run_1", revision: 3, createdAt: "2026-08-06T00:00:00.000Z", updatedAt: "2026-08-06T00:00:00.000Z" },
      conductorExecutionProfileReadiness: {
        templateVersionId: "template_version_1",
        executionProfileId: "profile_conductor",
        status: "version_mismatch",
        unavailableReasons: ["provider_version_mismatch"],
        missingCapabilities: [],
      },
      activeRun: { runId: "run_1", taskId: "task_1", conductorLogicalSessionId: "logical_session_conductor", status: "running", runNumber: 1, startedAt: "2026-08-06T00:00:00.000Z", revision: 1 },
      logicalSessions: [{ logicalSessionId: "logical_session_conductor", taskId: "task_1", runId: "run_1", kind: "conductor", agentCardId: "agent_card_conductor", executionProfileId: "profile_conductor", status: "active", ordinal: 1, createdAt: "2026-08-06T00:00:00.000Z", updatedAt: "2026-08-06T00:00:00.000Z" }],
      bindings: [{ bindingId: "binding_1", taskId: "task_1", runId: "run_1", logicalSessionId: "logical_session_conductor", executionProfileId: "profile_conductor", provider: "codex", nativeBindingRef: "native-session-secret", bindingRevision: 1, status: "active", recoverable: true, createdAt: "2026-08-06T00:00:00.000Z", updatedAt: "2026-08-06T00:00:00.000Z" }],
      inputs: [],
      invocations: [],
      sessionTurns: [{
        sessionTurnId: "session_turn_1", taskId: "task_1", runId: "run_1", inputSubmissionId: "input_1",
        targetLogicalSessionId: "logical_session_conductor", kind: "conductor", initiator: "human", trigger: "human_direct",
        finalMessageId: "message_final", status: "returned", createdAt: "2026-08-06T00:00:10.000Z", updatedAt: "2026-08-06T00:01:00.000Z",
      }],
      messages: [
        { messageId: "message_goal", taskId: "task_1", runId: "run_1", kind: "task_goal", content: "Review the change", contentDigest: "goal-digest", createdAt: "2026-08-06T00:00:00.000Z" },
        { messageId: "message_final", taskId: "task_1", runId: "run_1", sourceLogicalSessionId: "logical_session_worker", invocationId: "invocation_1", kind: "agent_final", content: "完整 Worker 回信。", contentDigest: "final-digest", createdAt: "2026-08-06T00:01:00.000Z" },
      ],
      relayBlocks: [{
        relayBlockId: "relay_block_1",
        sourceMessageId: "message_final",
        ordinal: 0,
        suggestedTargetAgentCardIds: [],
        suggestedAudience: "publish",
        topic: "game.board",
        format: "application/json",
        content: '{"turn": 4}',
        contentDigest: "relay-digest",
        parserVersion: 1,
        sourceRange: { start: 0, end: 1 },
        createdAt: "2026-08-06T00:01:00.000Z",
      }],
      inboxItems: [{
        inboxItemId: "inbox_1",
        taskId: "task_1",
        runId: "run_1",
        targetLogicalSessionId: "logical_session_conductor",
        renderedMessageId: "message_final",
        forwardId: "message_forward_1",
        state: "delivered",
        deliveryInputSubmissionId: "input_1",
        revision: 1,
        createdAt: "2026-08-06T00:01:00.000Z",
        updatedAt: "2026-08-06T00:01:00.000Z",
      }],
      messageForwards: [],
      messageForwardBatches: [],
      humanInterventions: [],
      attentions: [{ attentionId: "attention_1", taskId: "task_1", runId: "run_1", bindingId: "binding_1", bindingRevision: 1, nativeRequestId: "request_1", request: { title: "Permission", prompt: "Allow the checked change?", rawProviderPayload: "hidden by projection" }, status: "requested", createdAt: "2026-08-06T00:00:00.000Z", updatedAt: "2026-08-06T00:00:00.000Z" }],
      providerActivities: [{
        activityId: "activity_tool0123456789", provider: "codex", bindingId: "binding_1",
        logicalSessionId: "logical_session_conductor", inputSubmissionId: "input_1", sessionTurnId: "session_turn_1",
        category: "tool", status: "failed", title: "读取文件", detail: "package.json", content: "ENOENT",
        startedAt: "2026-08-06T00:00:20.000Z", updatedAt: "2026-08-06T00:00:30.000Z",
      }],
      artifacts: [{ artifactId: "artifact_1", taskId: "task_1", runId: "run_1", displayName: "result.md", contentDigest: "digest", verifiedAt: "2026-08-06T00:00:00.000Z" }],
      presentations: [],
      timeline: [],
    },
  };
}

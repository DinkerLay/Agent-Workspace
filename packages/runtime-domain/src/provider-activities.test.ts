import type { ProviderFact, ProviderSessionBindingRecord, SessionTurnRecord } from "@agent-workspace/runtime-contracts";
import { describe, expect, it } from "vitest";
import { deriveProviderActivities } from "./provider-activities";

describe("deriveProviderActivities", () => {
  it("merges ordered stream deltas and tool snapshots without exposing Provider payload fields", () => {
    const activities = deriveProviderActivities({
      bindings: [binding()],
      sessionTurns: [turn()],
      providerFacts: [
        fact("provider_fact_delta_2", "2026-08-09T00:00:00.000Z", {
          activityId: "activity_assistant012345", category: "assistant_progress", phase: "progress",
          title: "正在生成回复", content: "界", updateMode: "append", sequence: 2,
        }),
        fact("provider_fact_delta_1", "2026-08-09T00:00:00.000Z", {
          activityId: "activity_assistant012345", category: "assistant_progress", phase: "progress",
          title: "正在生成回复", content: "你", updateMode: "append", sequence: 1,
        }),
        fact("provider_fact_tool", "2026-08-09T00:00:01.000Z", {
          activityId: "activity_tool0123456789", category: "tool", phase: "completed",
          title: "读取文件", detail: "package.json", content: "完成", updateMode: "replace", sequence: 3,
        }, { nativeMessageId: "must-not-cross", nativeTurnId: "must-not-cross", secret: "must-not-cross" }),
      ],
    });

    expect(activities).toHaveLength(2);
    expect(activities[0]).toMatchObject({
      activityId: "activity_assistant012345",
      logicalSessionId: "logical_session_conductor",
      sessionTurnId: "session_turn_001",
      status: "running",
      content: "你界",
    });
    expect(activities[1]).toMatchObject({
      activityId: "activity_tool0123456789",
      status: "completed",
      title: "读取文件",
      content: "完成",
    });
    expect(JSON.stringify(activities)).not.toContain("must-not-cross");
  });

  it("uses replace snapshots for recovery and ignores malformed activity payloads", () => {
    const valid = fact("provider_fact_snapshot", "2026-08-09T00:00:02.000Z", {
      activityId: "activity_recovery012345", category: "assistant_progress", phase: "completed",
      title: "回复已生成", content: "完整恢复文本", updateMode: "replace", sequence: 4,
    });
    const malformed = { ...valid, providerFactId: "provider_fact_bad", payload: { raw: { cwd: "/private" } } } as ProviderFact;

    expect(deriveProviderActivities({ bindings: [binding()], sessionTurns: [turn()], providerFacts: [malformed, valid] }))
      .toEqual([expect.objectContaining({ content: "完整恢复文本", status: "completed" })]);
  });

  it("keeps terminal activity snapshots fenced from late live observations", () => {
    const activities = deriveProviderActivities({
      bindings: [binding()],
      sessionTurns: [turn()],
      providerFacts: [
        fact("provider_fact_completed", "2026-08-09T00:00:01.000Z", {
          activityId: "activity_completed012345", category: "tool", phase: "completed",
          title: "命令已完成", content: "完整快照", updateMode: "replace", sequence: 2,
        }),
        fact("provider_fact_late_progress", "2026-08-09T00:00:02.000Z", {
          activityId: "activity_completed012345", category: "tool", phase: "progress",
          title: "命令仍在运行", content: "迟到片段", updateMode: "append", sequence: 3,
        }),
        fact("provider_fact_failed", "2026-08-09T00:00:01.000Z", {
          activityId: "activity_failed01234567", category: "tool", phase: "failed",
          title: "命令失败", content: "失败快照", updateMode: "replace", sequence: 2,
        }),
        fact("provider_fact_late_started", "2026-08-09T00:00:03.000Z", {
          activityId: "activity_failed01234567", category: "tool", phase: "started",
          title: "命令开始", updateMode: "replace", sequence: 0,
        }),
      ],
    });

    expect(activities).toEqual([
      expect.objectContaining({ activityId: "activity_completed012345", status: "completed", content: "完整快照" }),
      expect.objectContaining({ activityId: "activity_failed01234567", status: "failed", content: "失败快照" }),
    ]);
    expect(JSON.stringify(activities)).not.toContain("迟到片段");
  });

  it("drops Provider, Binding revision, and Turn correlation mismatches", () => {
    const otherTurn: SessionTurnRecord = {
      ...turn(),
      sessionTurnId: "session_turn_other",
      inputSubmissionId: "input_other",
      targetLogicalSessionId: "logical_session_other",
    };
    const valid = fact("provider_fact_valid", "2026-08-09T00:00:00.000Z", {
      activityId: "activity_valid012345678", category: "tool", phase: "started",
      title: "有效活动", updateMode: "replace", sequence: 0,
    });
    const wrongProvider = { ...valid, providerFactId: "provider_fact_wrong_provider", provider: "opencode" } as ProviderFact;
    const staleRevision = { ...valid, providerFactId: "provider_fact_stale_revision", bindingRevision: 0 } as ProviderFact;
    const crossTurn = {
      ...valid,
      providerFactId: "provider_fact_cross_turn",
      correlation: { inputSubmissionId: "input_001", sessionTurnId: otherTurn.sessionTurnId },
    } as ProviderFact;
    const missingTurn = {
      ...valid,
      providerFactId: "provider_fact_missing_turn",
      correlation: { sessionTurnId: "session_turn_missing" },
    } as ProviderFact;

    expect(deriveProviderActivities({
      bindings: [binding()],
      sessionTurns: [turn(), otherTurn],
      providerFacts: [wrongProvider, staleRevision, crossTurn, missingTurn, valid],
    })).toEqual([expect.objectContaining({ activityId: "activity_valid012345678" })]);
  });
});

function binding(): ProviderSessionBindingRecord {
  return {
    bindingId: "binding_001", taskId: "task_001", runId: "run_001",
    logicalSessionId: "logical_session_conductor", provider: "codex",
    executionProfileId: "profile_001", bindingRevision: 1, status: "active",
    recoverable: true, createdAt: "2026-08-09T00:00:00.000Z", updatedAt: "2026-08-09T00:00:00.000Z",
  };
}

function turn(): SessionTurnRecord {
  return {
    sessionTurnId: "session_turn_001", taskId: "task_001", runId: "run_001",
    inputSubmissionId: "input_001", targetLogicalSessionId: "logical_session_conductor",
    kind: "conductor", initiator: "human", trigger: "human_direct", status: "running",
    createdAt: "2026-08-09T00:00:00.000Z", updatedAt: "2026-08-09T00:00:00.000Z",
  };
}

function fact(
  providerFactId: string,
  observedAt: string,
  activity: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): ProviderFact {
  return {
    providerFactId,
    provider: "codex",
    bindingId: "binding_001",
    bindingRevision: 1,
    kind: "activity_observed",
    deduplication: { providerEventId: providerFactId },
    correlation: { inputSubmissionId: "input_001", ...extra },
    payload: { schemaVersion: 1, ...activity },
    observedAt,
  } as ProviderFact;
}

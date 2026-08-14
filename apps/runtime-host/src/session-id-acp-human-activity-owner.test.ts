import { describe, expect, it } from "vitest";
import { createSessionIdAcpHumanActivityOwner } from "./session-id-acp-human-activity-owner";

describe("Session-ID ACP human activity owner", () => {
  it("coalesces streamed chunks and replaces exact tool status without exposing the activity key", () => {
    let id = 0;
    const owner = createSessionIdAcpHumanActivityOwner({
      now: () => "2026-08-13T10:00:00.000Z",
      createId: () => `provider_activity_${++id}`,
    });
    owner.record({
      scope: "task",
      kind: "agent_thought_chunk",
      sessionExecutionAttemptId: "session_execution_attempt_1",
      text: "先核对",
    });
    owner.record({
      scope: "task",
      kind: "agent_thought_chunk",
      sessionExecutionAttemptId: "session_execution_attempt_1",
      text: "版本",
    });
    owner.record({
      scope: "task",
      kind: "agent_message_chunk",
      sessionExecutionAttemptId: "session_execution_attempt_1",
      text: "正在",
    });
    owner.record({
      scope: "task",
      kind: "agent_message_chunk",
      sessionExecutionAttemptId: "session_execution_attempt_1",
      text: "研究",
    });
    const activityKey = `activity_key_${"a".repeat(64)}`;
    owner.record({
      scope: "task",
      kind: "tool_status",
      sessionExecutionAttemptId: "session_execution_attempt_1",
      activityKey,
      title: "搜索来源",
      status: "in_progress",
      inputSummary: "查询：ACP current install",
    });
    owner.record({
      scope: "task",
      kind: "tool_status",
      sessionExecutionAttemptId: "session_execution_attempt_1",
      activityKey,
      title: "搜索来源",
      status: "completed",
      outputSummary: "找到 3 个可审阅来源。",
    });

    expect(owner.listForAttempt("session_execution_attempt_1")).toEqual([
      expect.objectContaining({ kind: "assistant_progress", contentKind: "reasoning", content: "先核对版本" }),
      expect.objectContaining({ kind: "assistant_progress", contentKind: "response", content: "正在研究" }),
      expect.objectContaining({
        kind: "tool",
        title: "搜索来源",
        status: "completed",
        inputSummary: "查询：ACP current install",
        outputSummary: "找到 3 个可审阅来源。",
      }),
    ]);
    expect(JSON.stringify(owner.listForAttempt("session_execution_attempt_1"))).not.toContain(activityKey);
  });

  it("keeps Meta turns isolated and clears transient state", () => {
    const owner = createSessionIdAcpHumanActivityOwner({
      now: () => "2026-08-13T10:00:00.000Z",
      createId: () => "provider_activity_meta_1",
    });
    owner.record({
      scope: "meta",
      kind: "agent_message_chunk",
      metaSessionId: "meta_session_1",
      metaTurnId: "meta_turn_1",
      text: "分析 Draft",
    });
    owner.record({
      scope: "meta",
      kind: "tool_status",
      metaSessionId: "meta_session_1",
      metaTurnId: "meta_turn_1",
      activityKey: `activity_key_${"b".repeat(64)}`,
      title: "读取 Template Draft",
      status: "completed",
    });
    expect(owner.listForMetaTurn("meta_session_1", "meta_turn_1")).toEqual([
      expect.objectContaining({ kind: "assistant_progress", contentKind: "response", content: "分析 Draft" }),
      expect.objectContaining({ kind: "tool", title: "读取 Template Draft", status: "completed" }),
    ]);
    expect(owner.listForMetaTurn("meta_session_1", "meta_turn_2")).toEqual([]);
    owner.clear();
    expect(owner.listForMetaTurn("meta_session_1", "meta_turn_1")).toEqual([]);
  });

  it("ignores empty streamed chunks because they carry no human-visible activity", () => {
    const owner = createSessionIdAcpHumanActivityOwner({
      now: () => "2026-08-13T10:00:00.000Z",
      createId: () => "provider_activity_meta_empty",
    });

    expect(() => owner.record({
      scope: "meta",
      kind: "agent_message_chunk",
      metaSessionId: "meta_session_empty",
      metaTurnId: "meta_turn_empty",
      text: "",
    })).not.toThrow();
    expect(() => owner.record({
      scope: "meta",
      kind: "agent_thought_chunk",
      metaSessionId: "meta_session_empty",
      metaTurnId: "meta_turn_empty",
      text: "",
    })).not.toThrow();
    expect(owner.listForMetaTurn("meta_session_empty", "meta_turn_empty")).toEqual([]);
  });
});

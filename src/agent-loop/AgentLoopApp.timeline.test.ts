import { describe, expect, it } from "vitest";
import { buildTimeline, pendingTaskQuestions } from "./AgentLoopApp";
import type { NativeAgentLoopRunDetail, NativeAgentLoopTask } from "../runtime/nativeBridge";

describe("buildTimeline", () => {
  it("shows complete Conductor replies and delivery claims from durable task events", () => {
    const task = {
      taskId: "task-1",
      goal: "生成并交付完整报告。",
      createdAt: "2026-07-29T03:00:00.000Z",
    } as NativeAgentLoopTask;
    const fullReply = "# 任务完成\n\n最终交付物：`reports/final.html`\n\n完整结论与风险说明。";
    const claim = "已完成交付；请检查 `reports/final.html` 后决定是否 achieved。";
    const run = {
      run: { conductorSessionId: "opencode:project:task-1:conductor" },
      events: [{
        sequence: 1,
        type: "conductor.delivery_claim",
        summary: "Runtime 已记录交付主张。",
        data: {},
        createdAt: "2026-07-29T03:02:00.000Z",
      }],
      runtimeState: {
        events: [
          {
            id: "event-1",
            sessionId: "opencode:project:task-1:conductor",
            type: "conductor.message",
            summary: "Conductor output message",
            data: { message: fullReply },
            createdAt: "2026-07-29T03:01:00.000Z",
          },
          {
            id: "event-2",
            sessionId: "opencode:project:task-1:conductor",
            type: "task.completion_claim",
            summary: "Task completion claimed by Conductor",
            data: { message: claim },
            createdAt: "2026-07-29T03:02:00.000Z",
          },
          {
            id: "event-3",
            sessionId: "opencode:project:task-1:researcher",
            type: "conductor.message",
            summary: "Wrong session",
            data: { message: "不应显示" },
            createdAt: "2026-07-29T03:03:00.000Z",
          },
        ],
        dispatches: [],
        results: [],
        messages: [],
        pendingDecisions: [],
      },
    } as unknown as NativeAgentLoopRunDetail;

    const timeline = buildTimeline(task, run);

    expect(timeline).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: "Conductor 返回", detail: fullReply, showFull: true }),
      expect.objectContaining({ title: "Conductor 提交交付", detail: claim, showFull: true }),
    ]));
    expect(timeline.some((item) => item.detail === "不应显示")).toBe(false);
  });

  it("keeps a pending Provider permission out of the Timeline because its Task-page card is the action surface", () => {
    const task = { taskId: "task-1", goal: "完成任务", createdAt: "2026-07-29T03:00:00.000Z" } as NativeAgentLoopTask;
    const run = {
      runtimeState: {
        events: [],
        dispatches: [],
        results: [],
        messages: [],
        pendingDecisions: [{
          type: "permission_requested",
          sessionId: "opencode:project:task-1:researcher",
          permissionId: "opencode:permission-1",
          summary: "OpenCode 请求授权：bash (npm test)",
          actionHint: "resolve_permission",
        }],
      },
    } as unknown as NativeAgentLoopRunDetail;

    const timeline = buildTimeline(task, run);

    expect(timeline.some((item) => item.meta === "OpenCode permission")).toBe(false);
  });

  it("shows only compact permission delivery and confirmation facts in the Timeline", () => {
    const task = { taskId: "task-1", goal: "完成任务", createdAt: "2026-07-29T03:00:00.000Z" } as NativeAgentLoopTask;
    const run = {
      runtimeState: {
        events: [
          { id: "submitted", sessionId: "opencode:project:task-1:researcher", type: "permission.response_submitted", summary: "raw provider prompt must not render", data: { response: "once" }, createdAt: "2026-07-29T03:01:00.000Z" },
          { id: "resolved", sessionId: "opencode:project:task-1:researcher", type: "permission.resolved", summary: "raw provider prompt must not render", data: { response: "once" }, createdAt: "2026-07-29T03:02:00.000Z" },
        ],
        dispatches: [],
        results: [],
        messages: [],
        pendingDecisions: [],
      },
    } as unknown as NativeAgentLoopRunDetail;

    const timeline = buildTimeline(task, run);

    expect(timeline).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: "researcher 已提交授权答复", detail: "已将你的选择（仅此次允许）发送给 OpenCode；等待 Provider 确认。" }),
      expect.objectContaining({ title: "researcher 已确认授权答复", detail: "OpenCode 已确认：仅此次允许。" }),
    ]));
    expect(timeline.some((item) => item.detail.includes("raw provider prompt"))).toBe(false);
  });

  it("renders a legacy input retry as a transport fact instead of a second user message", () => {
    const task = { taskId: "task-1", goal: "继续任务", createdAt: "2026-07-29T03:00:00.000Z" } as NativeAgentLoopTask;
    const run = {
      events: [
        { sequence: 1, type: "task.user_message", summary: "继续任务", data: { message: "继续任务" }, createdAt: "2026-07-29T03:01:00.000Z" },
        { sequence: 2, type: "task.user_message_retrying", summary: "重新提交此前未获 Provider 回执的用户消息。", data: { retryOfMessageId: "message-1" }, createdAt: "2026-07-29T03:02:00.000Z" },
      ],
      runtimeState: { events: [], dispatches: [], results: [], messages: [], pendingDecisions: [] },
    } as unknown as NativeAgentLoopRunDetail;

    const timeline = buildTimeline(task, run);

    expect(timeline.filter((item) => item.title === "你发给 Conductor 的消息" && item.detail === "继续任务")).toHaveLength(1);
    expect(timeline).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "runtime", title: "正在重新发送此前消息" }),
    ]));
  });

  it("shows the exact Provider input receipt before the next Conductor reply", () => {
    const task = { taskId: "task-1", goal: "继续任务", createdAt: "2026-07-29T03:00:00.000Z" } as NativeAgentLoopTask;
    const run = {
      run: { conductorSessionId: "opencode:project:task-1:conductor" },
      events: [],
      runtimeState: {
        events: [
          {
            id: "receipt",
            sessionId: "opencode:project:task-1:conductor",
            type: "conductor.wakeup.observed",
            summary: "Provider observed the user input.",
            data: { kind: "user_message", providerMessageId: "msg-input" },
            createdAt: "2026-07-29T03:01:00.000Z",
          },
          {
            id: "reply",
            sessionId: "opencode:project:task-1:conductor",
            type: "conductor.message",
            summary: "Conductor output",
            data: { message: "已收到并继续。" },
            createdAt: "2026-07-29T03:02:00.000Z",
          },
        ],
        dispatches: [],
        results: [],
        messages: [],
        pendingDecisions: [],
      },
    } as unknown as NativeAgentLoopRunDetail;

    const timeline = buildTimeline(task, run);

    const receiptIndex = timeline.findIndex((item) => item.title === "OpenCode 已确认输入");
    const replyIndex = timeline.findIndex((item) => item.title === "Conductor 返回");
    expect(receiptIndex).toBeGreaterThanOrEqual(0);
    expect(replyIndex).toBeGreaterThan(receiptIndex);
  });
});

describe("pendingTaskQuestions", () => {
  const sessionId = "opencode:project:task-1:conductor";
  const waitingQuestion = {
    sessionId,
    state: "waiting_input",
    lastStateSummary: "Was the report copied?",
    lastStateData: {
      providerQuestionPartId: "question-1",
      terminalIncarnationId: "incarnation-before-restart",
      question: "Was the report copied?",
    },
    updatedAt: "2026-07-31T00:00:00.000Z",
  };

  it("does not project a historical native question after its PTY is gone or replaced", () => {
    const gone = {
      runtimeState: { sessions: [waitingQuestion], questionResponses: [] },
      turns: [{ sessionId, terminalStatus: "not_live" }],
    } as unknown as NativeAgentLoopRunDetail;
    const replaced = {
      runtimeState: { sessions: [waitingQuestion], questionResponses: [] },
      turns: [{ sessionId, terminalStatus: "live", terminal: { incarnationId: "incarnation-after-restart" } }],
    } as unknown as NativeAgentLoopRunDetail;

    expect(pendingTaskQuestions(gone)).toEqual([]);
    expect(pendingTaskQuestions(replaced)).toEqual([]);
  });

  it("projects a native question only after Provider observes it in the current PTY", () => {
    const run = {
      runtimeState: { sessions: [waitingQuestion], questionResponses: [] },
      turns: [{ sessionId, terminalStatus: "live", terminal: { incarnationId: "incarnation-before-restart" } }],
    } as unknown as NativeAgentLoopRunDetail;

    expect(pendingTaskQuestions(run)).toEqual([{
      sessionId,
      questionId: "question-1",
      question: "Was the report copied?",
      createdAt: "2026-07-31T00:00:00.000Z",
    }]);
  });
});

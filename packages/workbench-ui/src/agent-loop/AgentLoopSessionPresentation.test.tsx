// @vitest-environment jsdom
import { createElement, useState } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AgentLoopSessionPresentation,
  type AgentLoopAttentionDisplay,
  type AgentLoopComposerSubmission,
  type AgentLoopStopTaskRequest,
} from "./AgentLoopSessionPresentation";
import type { AgentLoopExecutionGroup, AgentLoopSessionMessageItem } from "./agent-loop-model";

afterEach(cleanup);

const messages: readonly AgentLoopSessionMessageItem[] = [
  {
    messageId: "message_goal",
    kind: "task_goal",
    content: "核实 Provider receipt。",
    contentDigest: "goal-digest",
    createdAt: "2026-08-06T00:00:00.000Z",
    relayBlocks: [],
    inboxDeliveries: [{
      inboxItemId: "inbox_goal",
      targetLogicalSessionId: "logical_session_conductor",
      route: "message",
      state: "delivered",
      createdAt: "2026-08-06T00:00:00.000Z",
      updatedAt: "2026-08-06T00:00:00.000Z",
    }],
  },
  {
    messageId: "message_worker_final",
    kind: "agent_final",
    sourceLogicalSessionId: "logical_session_worker",
    content: "完整 Worker 回信。\n\n```relay\ntopic: review\naudience: one\n---\n请父 Session 审阅\n```",
    contentDigest: "final-digest",
    createdAt: "2026-08-06T00:01:00.000Z",
    relayBlocks: [
      {
        relayBlockId: "relay_private",
        ordinal: 0,
        suggestedTargetAgentCardIds: [],
        suggestedAudience: "one",
        format: "text/markdown",
        content: "仅供父 Session 审阅",
        contentDigest: "private-digest",
        parserVersion: 1,
        createdAt: "2026-08-06T00:01:00.000Z",
      },
      {
        relayBlockId: "relay_shared",
        ordinal: 1,
        suggestedTargetAgentCardIds: [],
        suggestedAudience: "publish",
        topic: "game.board",
        format: "application/json",
        content: '{"turn": 4}',
        contentDigest: "shared-digest",
        parserVersion: 1,
        createdAt: "2026-08-06T00:01:00.000Z",
      },
    ],
    inboxDeliveries: [{
      inboxItemId: "inbox_worker_final",
      targetLogicalSessionId: "logical_session_conductor",
      route: "forward",
      state: "pending",
      createdAt: "2026-08-06T00:01:00.000Z",
      updatedAt: "2026-08-06T00:01:00.000Z",
    }],
  },
];

const runningExecution: AgentLoopExecutionGroup = {
  executionGroupId: "session_turn_stream",
  logicalSessionId: "logical_session_conductor",
  provider: "codex",
  sessionTurnId: "session_turn_stream",
  inputSubmissionId: "input_stream",
  status: "running",
  startedAt: "2026-08-06T00:00:30.000Z",
  updatedAt: "2026-08-06T00:00:32.000Z",
  activities: [{
    activityId: "activity_tool0123456789",
    category: "tool",
    status: "running",
    title: "运行命令",
    detail: "npm test",
    content: "Tests are running…",
    startedAt: "2026-08-06T00:00:30.000Z",
    updatedAt: "2026-08-06T00:00:32.000Z",
  }, {
    activityId: "activity_assistant012345",
    category: "assistant_progress",
    status: "running",
    title: "正在生成回复",
    content: "我正在核对结果",
    startedAt: "2026-08-06T00:00:31.000Z",
    updatedAt: "2026-08-06T00:00:32.000Z",
  }],
};

function ControlledPresentation({
  onSubmitInput = vi.fn(async () => undefined),
  onStopTask = vi.fn(async () => undefined),
  onRespondAttention = vi.fn(async () => undefined),
  attentions,
  executionGroups = [],
  sessionMessages = messages,
}: Readonly<{
  onSubmitInput?: (input: AgentLoopComposerSubmission) => Promise<void> | void;
  onStopTask?: (input: AgentLoopStopTaskRequest) => Promise<void> | void;
  onRespondAttention?: (input: { taskId: string; logicalSessionId: string; attentionId: string; response: string }) => Promise<void> | void;
  attentions?: readonly AgentLoopAttentionDisplay[];
  executionGroups?: readonly AgentLoopExecutionGroup[];
  sessionMessages?: readonly AgentLoopSessionMessageItem[];
}>) {
  const [message, setMessage] = useState("");
  return <AgentLoopSessionPresentation
    attentions={attentions}
    binding={{ label: "Codex", status: "active", detail: "Runtime 已建立受控绑定。" }}
    composer={{ message, continuity: { state: "connected", message: "已连接；发送会成为一个有回执的 Task 输入。" } }}
    onComposerChange={setMessage}
    onRespondAttention={onRespondAttention}
    onStopTask={onStopTask}
    onSubmitInput={onSubmitInput}
    executionGroups={executionGroups}
    messages={sessionMessages}
    session={{ logicalSessionId: "logical_session_conductor", agentCardId: "agent_card_conductor", title: "Conductor", kind: "conductor", status: "active" }}
    taskId="task_review"
  />;
}

describe("AgentLoopSessionPresentation", () => {
  it("renders scoped immutable Messages, collapsible RelayBlocks and Inbox delivery states", () => {
    const { container } = render(createElement(ControlledPresentation));

    expect(screen.getByRole("region", { name: "Conductor 会话" })).toBeTruthy();
    expect(screen.getByText("conductor · active")).toBeTruthy();
    expect(screen.getByText("Codex · active")).toBeTruthy();
    expect(screen.getByText("核实 Provider receipt。")).toBeTruthy();
    expect(screen.getByText("完整 Worker 回信。", { exact: false })).toBeTruthy();
    expect(screen.getByText("Agent 最终回信")).toBeTruthy();
    expect(screen.getByText("等待投递")).toBeTruthy();
    expect(screen.queryByText("共享转递空间")).toBeNull();
    const relayDetails = screen.getByText("候选转递块 1").closest("details");
    expect(relayDetails?.open).toBe(false);
    fireEvent.click(screen.getByText("候选转递块 1"));
    expect(relayDetails?.open).toBe(true);
    expect(screen.getByText("仅供父 Session 审阅")).toBeTruthy();
    expect(container.querySelector("iframe")).toBeNull();
  });

  it("submits a trimmed typed Task input and keeps stop as a typed user intent", async () => {
    const onSubmitInput = vi.fn(async () => undefined);
    const onStopTask = vi.fn(async () => undefined);
    render(createElement(ControlledPresentation, { onSubmitInput, onStopTask }));

    fireEvent.change(screen.getByLabelText("发送给 Conductor"), { target: { value: "  请再次核实证据  " } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));

    await waitFor(() => expect(onSubmitInput).toHaveBeenCalledWith({
      taskId: "task_review",
      targetLogicalSessionId: "logical_session_conductor",
      content: "请再次核实证据",
    }));

    fireEvent.click(screen.getByRole("button", { name: "停止任务" }));
    await waitFor(() => expect(onStopTask).toHaveBeenCalledWith({
      taskId: "task_review",
      logicalSessionId: "logical_session_conductor",
    }));
  });

  it("shows live tool/assistant activity expanded, then auto-collapses when the canonical final is complete", () => {
    const { rerender } = render(createElement(ControlledPresentation, { executionGroups: [runningExecution] }));

    const runningSummary = screen.getByLabelText(/执行中，2 步/u);
    const details = runningSummary.closest("details")!;
    expect(details.open).toBe(true);
    expect(screen.getByText("运行命令")).toBeTruthy();
    expect(screen.getByText("Tests are running…")).toBeTruthy();
    expect(screen.getByText("我正在核对结果", { exact: false })).toBeTruthy();

    const completedExecution: AgentLoopExecutionGroup = {
      ...runningExecution,
      finalMessageId: "message_worker_final",
      status: "completed",
      activities: runningExecution.activities.map((activity) => ({ ...activity, status: "completed" as const })),
    };
    rerender(createElement(ControlledPresentation, { executionGroups: [completedExecution] }));

    expect(details.open).toBe(false);
    expect(screen.getByText("完整 Worker 回信。", { exact: false })).toBeTruthy();
    fireEvent.click(screen.getByLabelText(/已完成，2 步/u));
    expect(details.open).toBe(true);
    expect(screen.getByText("Tests are running…")).toBeTruthy();
  });

  it("keeps zero-step completed-without-final, ambiguous, and failed groups open with honest status", () => {
    const zeroStepExecution: AgentLoopExecutionGroup = { ...runningExecution, activities: [] };
    const incompleteExecution: AgentLoopExecutionGroup = { ...zeroStepExecution, status: "completed" };
    const { container, rerender } = render(createElement(ControlledPresentation, { executionGroups: [incompleteExecution] }));

    const incomplete = container.querySelector("[data-execution-status='awaiting_final'] details") as HTMLDetailsElement;
    expect(incomplete.open).toBe(true);
    expect(screen.getByLabelText(/等待最终回复，0 步/u)).toBeTruthy();
    expect(container.querySelector("summary .awb-execution-status.is-awaiting_final")).toBeTruthy();

    rerender(createElement(ControlledPresentation, {
      executionGroups: [{ ...zeroStepExecution, status: "ambiguous" }],
    }));
    const ambiguous = container.querySelector("[data-execution-status='ambiguous'] details") as HTMLDetailsElement;
    expect(ambiguous.open).toBe(true);
    expect(screen.getByLabelText(/状态待确认，0 步/u)).toBeTruthy();
    expect(container.querySelector("summary .awb-execution-status.is-ambiguous")).toBeTruthy();

    rerender(createElement(ControlledPresentation, {
      executionGroups: [{ ...zeroStepExecution, status: "failed" }],
    }));
    const failed = container.querySelector("[data-execution-status='failed'] details") as HTMLDetailsElement;
    expect(failed.open).toBe(true);
    expect(screen.getByLabelText(/执行失败，0 步/u)).toBeTruthy();
  });

  it("submits an option-backed attention reply as a typed session response", async () => {
    const onRespondAttention = vi.fn(async () => undefined);
    render(createElement(ControlledPresentation, {
      onRespondAttention,
      attentions: [{
        attentionId: "attention_file_write",
        title: "允许文件写入",
        status: "awaiting_user",
        prompt: "是否允许这次受控写入？",
        options: ["允许", "拒绝"],
      }],
    }));

    fireEvent.click(screen.getByRole("button", { name: "允许" }));
    fireEvent.click(screen.getByRole("button", { name: "回复 允许文件写入" }));

    await waitFor(() => expect(onRespondAttention).toHaveBeenCalledWith({
      taskId: "task_review",
      logicalSessionId: "logical_session_conductor",
      attentionId: "attention_file_write",
      response: "允许",
    }));
    expect((screen.getByLabelText("回复 允许文件写入") as HTMLInputElement).value).toBe("");
  });
});

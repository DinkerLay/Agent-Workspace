// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { AgentLoopChatComposer, AgentLoopProviderActivityList } from "./AgentLoopChatUI";

afterEach(cleanup);

const reasoningContent = "Compare the current draft revision before writing the patch.";

const activities = [{
  activityId: "provider_activity_reasoning",
  kind: "assistant_progress" as const,
  contentKind: "reasoning" as const,
  content: reasoningContent,
  observedAt: "2026-08-14T10:00:00.000Z",
}, {
  activityId: "provider_activity_tool",
  kind: "tool" as const,
  title: "读取 Template Draft",
  status: "completed" as const,
  inputSummary: "目标：当前 Template Draft",
  outputSummary: "已读取 Draft r3：3 张 Agent Card，1 个执行 Profile。",
  observedAt: "2026-08-14T10:00:01.000Z",
}];

describe("AgentLoopProviderActivityList", () => {
  it("renders the running empty state as a plain activity row", () => {
    const { container } = render(createElement(AgentLoopProviderActivityList, {
      activities: [],
      turnState: "running",
    }));

    expect(screen.getByText("正在思考并准备下一步…")).toBeTruthy();
    expect(container.querySelector(".awb-provider-activity-empty")).toBeTruthy();
    expect(container.querySelector(".awb-provider-activity-list")).toBeNull();
  });

  it("streams reasoning expanded, then automatically collapses it after settlement", () => {
    const { rerender } = render(createElement(AgentLoopProviderActivityList, {
      activities,
      turnState: "running",
    }));

    const thinking = screen.getByText("Thinking").closest("details") as HTMLDetailsElement;
    expect(thinking.open).toBe(true);
    expect(screen.getByText(reasoningContent)).toBeTruthy();

    rerender(createElement(AgentLoopProviderActivityList, {
      activities,
      turnState: "settled",
    }));

    expect(thinking.open).toBe(false);
    fireEvent.click(screen.getByText("Thinking"));
    expect(thinking.open).toBe(true);
    expect(screen.getByText(reasoningContent)).toBeTruthy();
  });

  it("renders each completed tool as an independently expandable card", () => {
    render(createElement(AgentLoopProviderActivityList, {
      activities,
      turnState: "settled",
    }));

    const tool = screen.getByText("读取 Template Draft").closest("details") as HTMLDetailsElement;
    expect(tool.open).toBe(false);
    fireEvent.click(screen.getByText("读取 Template Draft"));
    expect(tool.open).toBe(true);
    expect(screen.getAllByText("已完成").length).toBeGreaterThan(0);
    expect(screen.getByText("2026-08-14 10:00:01")).toBeTruthy();
    expect(screen.getByText("目标：当前 Template Draft")).toBeTruthy();
    expect(screen.getByText("已读取 Draft r3：3 张 Agent Card，1 个执行 Profile。")).toBeTruthy();
  });
});

describe("AgentLoopChatComposer", () => {
  it("renders a visibly animated progress icon with a caller-specific running label", () => {
    render(createElement(AgentLoopChatComposer, {
      label: "发送给 Meta Agent",
      onChange: () => undefined,
      onSubmit: () => undefined,
      running: true,
      runningLabel: "确认中…",
      value: "",
    }));

    const button = screen.getByRole("button", { name: "确认中…" });
    expect(button.querySelector("svg")?.classList.contains("awb-spinner")).toBe(true);
  });
});

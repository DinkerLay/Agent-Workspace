// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentLoopTaskSurface } from "./AgentLoopTaskSurface";
import type { AgentLoopTaskDetail, AgentLoopTaskListItem } from "./agent-loop-model";

afterEach(cleanup);

describe("AgentLoopTaskSurface launch readiness", () => {
  it("keeps Start disabled until the exact Conductor profile is available", () => {
    const task = queuedTask();
    const onStart = vi.fn();
    const { rerender } = renderSurface(task, detail(task, "version_mismatch"), onStart);

    const blocked = screen.getByRole("button", { name: "启动 Agent Loop" }) as HTMLButtonElement;
    expect(blocked.disabled).toBe(true);
    expect(screen.getByRole("status").textContent).toContain("版本不匹配");
    fireEvent.click(blocked);
    expect(onStart).not.toHaveBeenCalled();

    rerender(surface(task, detail(task, "available"), onStart));
    const ready = screen.getByRole("button", { name: "启动 Agent Loop" }) as HTMLButtonElement;
    expect(ready.disabled).toBe(false);
    fireEvent.click(ready);
    expect(onStart).toHaveBeenCalledWith(task);
  });

  it("fails closed while the selected Task detail has not loaded", () => {
    const task = queuedTask();
    renderSurface(task, undefined, vi.fn());

    expect((screen.getByRole("button", { name: "启动 Agent Loop" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("status").textContent).toContain("尚未完成可用性检查");
  });
});

function renderSurface(task: AgentLoopTaskListItem, taskDetail: AgentLoopTaskDetail | undefined, onStart: (task: AgentLoopTaskListItem) => void) {
  return render(surface(task, taskDetail, onStart));
}

function surface(task: AgentLoopTaskListItem, taskDetail: AgentLoopTaskDetail | undefined, onStart: (task: AgentLoopTaskListItem) => void) {
  return createElement(AgentLoopTaskSurface, {
    allTasks: [task],
    composerDrafts: {},
    detail: taskDetail,
    mode: "active",
    onAchieve: vi.fn(),
    onArchive: vi.fn(async () => undefined),
    onChooseMode: vi.fn(),
    onChooseSession: vi.fn(),
    onChooseTask: vi.fn(),
    onComposerChange: vi.fn(),
    onCreateTask: vi.fn(),
    onPermanentlyDelete: vi.fn(async () => undefined),
    onPreviewArtifact: vi.fn(async () => { throw new Error("not_used"); }),
    onPreviewPermanentDelete: vi.fn(async () => { throw new Error("not_used"); }),
    onRestart: vi.fn(),
    onRestore: vi.fn(async () => undefined),
    onResume: vi.fn(),
    onRespondAttention: vi.fn(async () => undefined),
    onStart,
    onStop: vi.fn(async () => undefined),
    onSubmitInput: vi.fn(async () => undefined),
    selectedTask: task,
    tasks: [task],
  });
}

function queuedTask(): AgentLoopTaskListItem {
  return {
    taskId: "task_queued",
    title: "DeepSearch",
    goal: "Research the stock.",
    status: "queued",
    revision: 1,
    createdAt: "2026-08-09T00:00:00.000Z",
    updatedAt: "2026-08-09T00:00:00.000Z",
  };
}

function detail(
  task: AgentLoopTaskListItem,
  status: NonNullable<AgentLoopTaskDetail["conductorReadiness"]>["status"],
): AgentLoopTaskDetail {
  return {
    task,
    conductorReadiness: {
      status,
      unavailableReasons: status === "version_mismatch" ? ["provider_version_mismatch"] : [],
      missingCapabilities: [],
    },
    sessions: [],
    messages: [],
    executionGroups: [],
    timeline: [],
    attentions: [],
    artifacts: [],
  };
}

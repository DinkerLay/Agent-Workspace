/**
 * @vitest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react";
import type { ComponentType } from "react";
import { describe, expect, it } from "vitest";
import { initialTasks } from "../mock/prototypeData";
import { Notifications } from "./Notifications";

describe("Notifications", () => {
  it("routes task status notifications and acknowledges event records", () => {
    const routes: number[] = [];
    const acknowledgements: string[] = [];
    const InteractiveNotifications = Notifications as ComponentType<{
      selectedTask: typeof initialTasks[number];
      events: Array<{
        id: string;
        taskId: string;
        level: string;
        destination: string;
        acknowledged: boolean;
        summary: string;
        evidencePath: string;
        sourceEventId?: string;
        sourceLabel?: string;
        sourceEvidencePath?: string;
        sourceSummary?: string;
      }>;
      onRouteNotification: () => void;
      onAcknowledgeNotification: (eventId: string) => void;
      onOpenNotificationContext: (eventId: string) => void;
    }>;

    const opens: string[] = [];

    render(
      <InteractiveNotifications
        selectedTask={initialTasks[1]}
        events={[
          {
            id: "notification-task-pty-001",
            taskId: "task-pty",
            level: "waiting-input",
            destination: "desktop",
            acknowledged: false,
            summary: "Executor is waiting for input on PTY state design.",
            evidencePath: ".agent-workspace/notifications/notification-task-pty-001.json",
            sourceEventId: "terminal-event-run-pty-active-001",
            sourceEvidencePath: ".agent-workspace/runs/run-pty-active/terminal-events.jsonl",
            sourceSummary: "Parser detected executor wait state from PTY output.",
          },
          {
            id: "notification-task-plan-watch-review-approval-run-plan-watc-active-001",
            taskId: "task-plan-watch",
            level: "done",
            destination: "sidebar",
            acknowledged: false,
            summary:
              "监听 docs 产品意图变化并创建 planner task: Review approved; task Done and ready for Runs audit.",
            evidencePath:
              ".agent-workspace/notifications/notification-task-plan-watch-review-approval-run-plan-watc-active-001.json",
            sourceEventId: "review-approval-run-plan-watc-active-001",
            sourceLabel: "Review approval",
            sourceEvidencePath: ".agent-workspace/reviews/run-plan-watc-active/approval.json",
            sourceSummary: "Review approved task-plan-watch with verification passed and 5 scoped files.",
          },
        ]}
        onRouteNotification={() => routes.push(1)}
        onAcknowledgeNotification={(eventId) => acknowledgements.push(eventId)}
        onOpenNotificationContext={(eventId) => opens.push(eventId)}
      />,
    );

    expect(screen.getByText("Active task signal")).toBeTruthy();
    expect(screen.getByText("设计真实 PTY session manager 的前端状态")).toBeTruthy();
    expect(screen.getByText("Route rules")).toBeTruthy();
    expect(screen.getByText(".agent-workspace/notifications/notification-task-pty-001.json")).toBeTruthy();
    expect(screen.getAllByText("Parser signal").length).toBeGreaterThan(0);
    expect(screen.getByText("terminal-event-run-pty-active-001")).toBeTruthy();
    expect(screen.getByText(".agent-workspace/runs/run-pty-active/terminal-events.jsonl")).toBeTruthy();
    expect(screen.getByText("Parser detected executor wait state from PTY output.")).toBeTruthy();
    expect(screen.getByText("Review approval")).toBeTruthy();
    expect(screen.getByText("review-approval-run-plan-watc-active-001")).toBeTruthy();
    expect(screen.getByText(".agent-workspace/reviews/run-plan-watc-active/approval.json")).toBeTruthy();
    expect(screen.getByText("Review approved task-plan-watch with verification passed and 5 scoped files.")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Route notification for task-pty" }));
    fireEvent.click(screen.getByRole("button", { name: "Open notification context notification-task-pty-001" }));
    fireEvent.click(screen.getByRole("button", { name: "Acknowledge notification-task-pty-001" }));

    expect(routes).toEqual([1]);
    expect(opens).toEqual(["notification-task-pty-001"]);
    expect(acknowledgements).toEqual(["notification-task-pty-001"]);
  });
});

/**
 * @vitest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { Bot, Search, ShieldCheck, Workflow } from "lucide-react";
import { describe, expect, it } from "vitest";
import { initialTasks } from "../mock/prototypeData";
import { LoopConsole } from "./LoopConsole";

describe("LoopConsole", () => {
  it("shows loop schedule audit evidence and keeps queue controls available", () => {
    const advancedTasks: string[] = [];
    const startedTasks: string[] = [];

    render(
      <LoopConsole
        tasks={initialTasks}
        loopScheduleEvents={[
          {
            id: "loop-schedule-task-review-001",
            taskId: "task-review",
            agentId: "reviewer",
            runId: "mock-run-task-review-001",
            decision: "start-agent",
            rule: "Loop queue Start Agent",
            evidencePath: ".agent-workspace/loops/events.jsonl",
            createdAt: "2026-06-24T14:05:00Z",
            summary: "Loop scheduled reviewer for task-review via Start Agent",
          },
        ]}
        loopStages={[
          { label: "Research / Spec", state: "watching", detail: "durable product intent", icon: Search },
          { label: "Planner", state: "running", detail: "plan steps", icon: Workflow },
          { label: "Executor", state: "queued", detail: "agent run", icon: Bot },
          { label: "Review Gate", state: "blocked until verified", detail: "review", icon: ShieldCheck },
        ]}
        onAdvance={(taskId) => advancedTasks.push(taskId)}
        onStartAgent={(taskId) => startedTasks.push(taskId)}
      />,
    );

    expect(screen.getByText("Loop schedule audit")).toBeTruthy();
    expect(screen.getByText("Loop scheduled reviewer for task-review via Start Agent")).toBeTruthy();
    expect(screen.getByText(".agent-workspace/loops/events.jsonl")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: `Start Agent for ${initialTasks[0].title}` }));
    fireEvent.click(screen.getByRole("button", { name: `Advance ${initialTasks[0].title}` }));

    expect(startedTasks).toEqual([initialTasks[0].id]);
    expect(advancedTasks).toEqual([initialTasks[0].id]);
  });
});

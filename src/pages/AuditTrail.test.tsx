/**
 * @vitest-environment jsdom
 */
import { render, screen } from "@testing-library/react";
import { fireEvent } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AuditTrail } from "./AuditTrail";
import type { AuditTrailEntry } from "../lib/auditTrail";

const entries: AuditTrailEntry[] = [
  {
    id: "loop-schedule-task-review-001",
    surface: "Loop Console",
    kind: "Loop schedule",
    title: "Loop scheduled reviewer for task-review via Start Agent",
    summary: "Scheduler decision recorded before runtime adapters started the run.",
    status: "start-agent",
    evidencePath: ".agent-workspace/loops/events.jsonl",
    createdAt: "2026-06-24T14:05:00Z",
    taskId: "task-review",
  },
  {
    id: "runtime-event-run-store-001",
    surface: "Runtime Adapter",
    kind: "Runtime event",
    title: "run-store.createRun",
    summary: "Run store created mock-run-task-review-001.",
    status: "run-store",
    evidencePath: ".agent-workspace/runs/mock-run-task-review-001/run.json",
    createdAt: "2026-06-24T14:04:59Z",
  },
  {
    id: "notification-task-plan-watch-review-approval-run-plan-watc-active-001",
    surface: "Notifications",
    kind: "Notification",
    title: "监听 docs 产品意图变化并创建 planner task: Review approved; task Done and ready for Runs audit.",
    summary: "sidebar; unacknowledged; source Review approval review-approval-run-plan-watc-active-001",
    status: "done",
    evidencePath:
      ".agent-workspace/notifications/notification-task-plan-watch-review-approval-run-plan-watc-active-001.json",
    createdAt: "2026-06-24T14:25:00Z",
    taskId: "task-plan-watch",
    sourceLabel: "Review approval",
    sourceEventId: "review-approval-run-plan-watc-active-001",
    sourceSummary: "Review approved task-plan-watch with verification passed and 5 scoped files.",
    sourceEvidencePath: ".agent-workspace/reviews/run-plan-watc-active/approval.json",
  } as AuditTrailEntry,
  {
    id: "redaction-run-plan-watc-active",
    surface: "Review",
    kind: "Redaction scan",
    title: "Agent-Conversation redaction for run-plan-watc-active",
    summary:
      "run-plan-watc-active; transcript .agent-workspace/runs/run-plan-watc-active/transcript.log; patterns API key, .env, token",
    status: "passed",
    evidencePath: ".agent-workspace/runs/run-plan-watc-active/redaction.json",
    createdAt: "2026-06-24T14:18:00Z",
    taskId: "task-plan-watch",
    runId: "run-plan-watc-active",
  } as AuditTrailEntry,
];

describe("AuditTrail", () => {
  it("shows a read-only workspace evidence timeline", () => {
    const opened: string[] = [];
    render(<AuditTrail entries={entries} onOpenEntryContext={(entryId) => opened.push(entryId)} />);

    expect(screen.getByText("Workspace audit trail")).toBeTruthy();
    expect(screen.getByText("Read-only shell evidence")).toBeTruthy();
    expect(screen.getByText("Loop scheduled reviewer for task-review via Start Agent")).toBeTruthy();
    expect(screen.getByText(".agent-workspace/loops/events.jsonl")).toBeTruthy();
    expect(screen.getByText("No scheduling side effects")).toBeTruthy();
    expect(screen.getByText("This page does not create AgentRun records, move task cards, or approve Review.")).toBeTruthy();
    expect(screen.getByText("Review approval")).toBeTruthy();
    expect(screen.getByText("review-approval-run-plan-watc-active-001")).toBeTruthy();
    expect(screen.getByText("Review approved task-plan-watch with verification passed and 5 scoped files.")).toBeTruthy();
    expect(screen.getByText(".agent-workspace/reviews/run-plan-watc-active/approval.json")).toBeTruthy();
    expect(screen.getByText("Agent-Conversation redaction for run-plan-watc-active")).toBeTruthy();
    expect(screen.getAllByText("run-plan-watc-active").length).toBeGreaterThan(0);
    expect(screen.getByText(".agent-workspace/runs/run-plan-watc-active/redaction.json")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Open audit context loop-schedule-task-review-001" }));

    expect(opened).toEqual(["loop-schedule-task-review-001"]);
  });
});

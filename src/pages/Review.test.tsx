/**
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps, ComponentType } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { agents, changedFiles, initialRuns, initialTasks } from "../mock/prototypeData";
import type {
  BrowserEvidence,
  CommitRedactionScan,
  CommitStagingEvent,
  McpToolCallEvent,
  ReviewFileSelection,
  TerminalEvent,
} from "../types";
import { Review } from "./Review";

const reviewFileSelections: ReviewFileSelection[] = changedFiles.map((file) => ({
  path: file.path,
  selected: file.agentId === "planner",
  reviewed: file.reviewed,
}));

const browserEvidence: BrowserEvidence[] = [
  {
    id: "browser-evidence-task-plan-watch-001",
    taskId: "task-plan-watch",
    toolName: "browser_screenshot",
    summary: "browser_screenshot captured screenshot artifact path for planner review",
    artifactPath: ".agent-workspace/browser/task-plan-watch/browser_screenshot-001.json",
    capturedAt: "2026-06-24T13:20:00Z",
  },
];

const redactionScans: CommitRedactionScan[] = [
  {
    runId: "run-plan-watc-active",
    status: "passed",
    transcriptPath: ".agent-workspace/runs/run-plan-watc-active/transcript.log",
    artifactPath: ".agent-workspace/runs/run-plan-watc-active/redaction.json",
    redactedPatterns: ["API key", ".env", "token"],
  },
];

const mcpToolEvents: McpToolCallEvent[] = [
  {
    id: "mcp-event-backlog-update-001",
    taskId: "task-plan-watch",
    serverId: "mcp-backlog",
    toolName: "backlog_update",
    permission: "confirm",
    status: "approved",
    evidencePath: ".agent-workspace/tasks/events.jsonl",
    targetSurface: "backlog",
    summary: "backlog_update requested by agent; scheduler confirmation required",
    decision: "approved",
    decisionEvidencePath: ".agent-workspace/mcp/mcp-event-backlog-update-001/confirmation.json",
    decidedAt: "2026-06-24T14:40:00Z",
    decisionSummary: "Scheduler approved backlog_update for Backlog MCP; tool execution may proceed.",
  },
];

const terminalEvents: TerminalEvent[] = [
  {
    id: "terminal-event-run-plan-watc-active-003",
    taskId: "task-plan-watch",
    runId: "run-plan-watc-active",
    kind: "done-signal",
    ruleId: "term.rule.done-signal",
    mappedStatus: "completed",
    sourceLine: "Agent claimed implementation is complete; requesting review gate",
    evidencePath: ".agent-workspace/runs/run-plan-watc-active/terminal-events.jsonl",
    createdAt: "2026-06-24T13:03:00Z",
    summary: "Parser detected an agent completion claim and routed it to Review.",
  },
];

afterEach(() => {
  cleanup();
});

describe("Review", () => {
  it("shows native opencode session evidence before review approval", () => {
    const nativeRun = {
      ...initialRuns[0],
      nativeSession: {
        id: "native-task-plan-watch",
        backend: "process" as const,
        status: "stopped" as const,
        command: "/opt/homebrew/bin/opencode",
        args: ["run", "--format", "json", "--model", "opencode-go/deepseek-v4-flash", "task"],
        cwd: "/Users/dinker/CODES/Agent-Workspace",
        model: "opencode-go/deepseek-v4-flash",
        exitCode: 0,
      },
    };

    render(
      <Review
        agents={agents}
        files={changedFiles.filter((file) => file.agentId === "planner")}
        selectedTask={initialTasks[0]}
        selectedRun={nativeRun}
        reviewAgentId="planner"
        reviewFileSelections={reviewFileSelections}
        commitConversationIncluded
        browserEvidence={[]}
        mcpToolEvents={[]}
        terminalEvents={[]}
        commitRedactionScans={[]}
        commitStagingEvents={[]}
        onReviewAgentChange={() => undefined}
        onToggleReviewFile={() => undefined}
        onToggleCommitConversation={() => undefined}
        onRunCommitRedactionScan={() => undefined}
        onRunVerificationCommand={() => undefined}
        onStageReviewFiles={() => undefined}
        onVerificationFailed={() => undefined}
        onApproveReview={() => undefined}
      />,
    );

    expect(screen.getByText("Native session state")).toBeTruthy();
    expect(screen.getByText("native-task-plan-watch")).toBeTruthy();
    expect(screen.getByText("opencode-go/deepseek-v4-flash")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Approve review" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("exposes scoped file selection and commit conversation metadata", () => {
    const selectedPaths: string[] = [];
    const trailerToggles: number[] = [];
    const redactionRuns: string[] = [];
    const verificationRuns: string[] = [];
    const stagingRuns: string[] = [];
    const ReviewWithRedaction = Review as ComponentType<
      ComponentProps<typeof Review> & {
        commitStagingEvents?: CommitStagingEvent[];
        onStageReviewFiles?: (taskId: string) => void;
      }
    >;

    render(
      <ReviewWithRedaction
        agents={agents}
        files={changedFiles.filter((file) => file.agentId === "planner")}
        selectedTask={initialTasks[0]}
        selectedRun={initialRuns[0]}
        reviewAgentId="planner"
        reviewFileSelections={reviewFileSelections}
        commitConversationIncluded
        browserEvidence={browserEvidence}
        mcpToolEvents={mcpToolEvents}
        terminalEvents={terminalEvents}
        commitRedactionScans={redactionScans}
        commitStagingEvents={[]}
        onReviewAgentChange={() => undefined}
        onToggleReviewFile={(path) => selectedPaths.push(path)}
        onToggleCommitConversation={() => trailerToggles.push(1)}
        onRunCommitRedactionScan={(runId) => redactionRuns.push(runId)}
        onRunVerificationCommand={(taskId) => verificationRuns.push(taskId)}
        onStageReviewFiles={(taskId) => stagingRuns.push(taskId)}
        onVerificationFailed={() => undefined}
        onApproveReview={() => undefined}
      />,
    );

    expect(screen.getByText("Scoped commit files")).toBeTruthy();
    expect(screen.getByText("2 selected")).toBeTruthy();
    expect(screen.getByText("Agent-Conversation trailer")).toBeTruthy();
    expect(screen.getByText("Worktree / Branch")).toBeTruthy();
    expect(screen.getByText("feature/agent-workspace-mvp")).toBeTruthy();
    expect(screen.getByText(".agent-workspace/runs/run-plan-watc-active/worktree.json")).toBeTruthy();
    expect(screen.getAllByText(".agent-workspace/runs/run-plan-watc-active/transcript.log").length).toBeGreaterThan(0);
    expect(screen.getByText("Browser evidence")).toBeTruthy();
    expect(screen.getByText(".agent-workspace/browser/task-plan-watch/browser_screenshot-001.json")).toBeTruthy();
    expect(screen.getByText("MCP tool evidence")).toBeTruthy();
    expect(screen.getByText("Scheduler approved backlog_update for Backlog MCP; tool execution may proceed.")).toBeTruthy();
    expect(screen.getByText(".agent-workspace/mcp/mcp-event-backlog-update-001/confirmation.json")).toBeTruthy();
    expect(screen.getByText("Terminal completion claim")).toBeTruthy();
    expect(screen.getByText("Terminal completion claim recorded")).toBeTruthy();
    expect(screen.getAllByText("1 recorded").length).toBeGreaterThan(0);
    expect(screen.getByText("done-signal")).toBeTruthy();
    expect(screen.getByText("completed")).toBeTruthy();
    expect(screen.getByText("term.rule.done-signal")).toBeTruthy();
    expect(screen.getByText("Agent claimed implementation is complete; requesting review gate")).toBeTruthy();
    expect(screen.getByText(".agent-workspace/runs/run-plan-watc-active/terminal-events.jsonl")).toBeTruthy();
    expect(screen.getByText("Git staging")).toBeTruthy();
    expect(screen.getByText("3 unstaged")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Stage selected files for task-plan-watch" })).toBeTruthy();
    expect(screen.getByText("Conversation redaction")).toBeTruthy();
    expect(screen.getByText(".agent-workspace/runs/run-plan-watc-active/redaction.json")).toBeTruthy();
    expect(screen.getByText("API key")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Run verification command for task-plan-watch" })).toBeTruthy();
    expect(screen.getByDisplayValue(/Plan-Step: mvp-board-first-shell/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Approve review" }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Run Agent-Conversation redaction scan for run-plan-watc-active" }));
    fireEvent.click(screen.getByRole("button", { name: "Run verification command for task-plan-watch" }));
    fireEvent.click(screen.getByRole("button", { name: "Stage selected files for task-plan-watch" }));
    fireEvent.click(screen.getByRole("button", { name: "Exclude src/tasks/backlog-store.ts from scoped commit" }));
    fireEvent.click(screen.getByRole("button", { name: "Disable Agent-Conversation trailer" }));

    expect(redactionRuns).toEqual(["run-plan-watc-active"]);
    expect(verificationRuns).toEqual(["task-plan-watch"]);
    expect(stagingRuns).toEqual(["task-plan-watch"]);
    expect(selectedPaths).toEqual(["src/tasks/backlog-store.ts"]);
    expect(trailerToggles).toEqual([1]);
  });

  it("enables approval only after verification and required redaction gates pass", () => {
    const verifiedRun = {
      ...initialRuns[0],
      verification: {
        ...initialRuns[0].verification,
        status: "passed" as const,
      },
    };
    const ReviewWithRedaction = Review as ComponentType<
      ComponentProps<typeof Review> & {
        commitStagingEvents?: CommitStagingEvent[];
        onStageReviewFiles?: (taskId: string) => void;
      }
    >;

    render(
      <ReviewWithRedaction
        agents={agents}
        files={changedFiles.filter((file) => file.agentId === "planner")}
        selectedTask={initialTasks[0]}
        selectedRun={verifiedRun}
        reviewAgentId="planner"
        reviewFileSelections={reviewFileSelections}
        commitConversationIncluded
        browserEvidence={browserEvidence}
        mcpToolEvents={mcpToolEvents}
        terminalEvents={terminalEvents}
        commitRedactionScans={redactionScans}
        commitStagingEvents={[
          {
            id: "commit-staging-run-plan-watc-active-001",
            taskId: "task-plan-watch",
            runId: "run-plan-watc-active",
            status: "staged",
            stagedFilePaths: ["src/review/commit-context.ts"],
            unstagedFilePaths: [],
            evidencePath: ".agent-workspace/runs/run-plan-watc-active/staging.json",
            createdAt: "2026-06-24T14:22:00Z",
            summary: "Staged 1 scoped files for task-plan-watch; 0 left unstaged.",
          },
        ]}
        onReviewAgentChange={() => undefined}
        onToggleReviewFile={() => undefined}
        onToggleCommitConversation={() => undefined}
        onRunCommitRedactionScan={() => undefined}
        onRunVerificationCommand={() => undefined}
        onStageReviewFiles={() => undefined}
        onVerificationFailed={() => undefined}
        onApproveReview={() => undefined}
      />,
    );

    expect(screen.getByText(".agent-workspace/runs/run-plan-watc-active/staging.json")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Approve review" }) as HTMLButtonElement).disabled).toBe(false);
  });
});

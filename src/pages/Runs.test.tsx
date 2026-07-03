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
  PullRequestHandoffEvent,
  ReviewApprovalEvent,
  ReviewFileSelection,
  McpToolCallEvent,
  TerminalEvent,
  VerificationCommandEvent,
} from "../types";
import { Runs } from "./Runs";

afterEach(() => {
  cleanup();
});

const reviewFileSelections: ReviewFileSelection[] = changedFiles.map((file) => ({
  path: file.path,
  selected: file.path !== "src/tasks/backlog-store.ts",
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

const verificationEvents: VerificationCommandEvent[] = [
  {
    id: "verification-run-plan-watc-active-001",
    taskId: "task-plan-watch",
    runId: "run-plan-watc-active",
    command: "npm test && npm run build",
    status: "passed",
    artifactPath: ".agent-workspace/runs/run-plan-watc-active/verification.json",
    logPath: ".agent-workspace/runs/run-plan-watc-active/verification.log",
    createdAt: "2026-06-24T14:20:00Z",
    summary: "Verification command passed and evidence was recorded by the Review gate.",
  },
];

const reviewApprovalEvents: ReviewApprovalEvent[] = [
  {
    id: "review-approval-run-plan-watc-active-001",
    taskId: "task-plan-watch",
    runId: "run-plan-watc-active",
    verificationStatus: "passed",
    selectedFilePaths: [
      "src/pty/session-manager.ts",
      "src/review/commit-context.ts",
      "docs/agent-run-lifecycle.md",
    ],
    redactionArtifactPath: ".agent-workspace/runs/run-plan-watc-active/redaction.json",
    commitProposalPath: ".agent-workspace/runs/run-plan-watc-active/commit.json",
    evidencePath: ".agent-workspace/reviews/run-plan-watc-active/approval.json",
    approvedAt: "2026-06-24T14:25:00Z",
    summary: "Review approved task-plan-watch with verification passed and 3 scoped files.",
  },
];

const pullRequestHandoffEvents: PullRequestHandoffEvent[] = [
  {
    id: "pr-handoff-run-plan-watc-active-001",
    taskId: "task-plan-watch",
    runId: "run-plan-watc-active",
    branchName: "feature/agent-workspace-mvp",
    approvalEvidencePath: ".agent-workspace/reviews/run-plan-watc-active/approval.json",
    commitProposalPath: ".agent-workspace/runs/run-plan-watc-active/commit.json",
    prDraftPath: ".agent-workspace/pr/run-plan-watc-active/handoff.json",
    status: "draft-ready",
    createdAt: "2026-06-24T14:30:00Z",
    summary: "PR handoff ready for task-plan-watch from run-plan-watc-active.",
  },
];

const commitStagingEvents: CommitStagingEvent[] = [
  {
    id: "commit-staging-run-plan-watc-active-001",
    taskId: "task-plan-watch",
    runId: "run-plan-watc-active",
    status: "staged",
    stagedFilePaths: [
      "src/pty/session-manager.ts",
      "src/review/commit-context.ts",
      "docs/agent-run-lifecycle.md",
      ".agent-workspace/runs/run-104/diff.patch",
    ],
    unstagedFilePaths: ["src/tasks/backlog-store.ts"],
    evidencePath: ".agent-workspace/runs/run-plan-watc-active/staging.json",
    createdAt: "2026-06-24T14:22:00Z",
    summary: "Staged 4 scoped files for task-plan-watch; 1 left unstaged.",
  },
];

const terminalEvents: TerminalEvent[] = [
  {
    id: "terminal-event-run-plan-watc-active-001",
    taskId: "task-plan-watch",
    runId: "run-plan-watc-active",
    kind: "tool-call",
    ruleId: "term.rule.tool-call",
    mappedStatus: "running",
    sourceLine: "Planner loop: detected research delta -> generating task graph",
    evidencePath: ".agent-workspace/runs/run-plan-watc-active/terminal-events.jsonl",
    createdAt: "2026-06-24T13:01:00Z",
    summary: "Parser classified planner tool activity from terminal output.",
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

describe("Runs", () => {
  it("shows native opencode session evidence on the selected run", () => {
    const nativeRun = {
      ...initialRuns[0],
      transcriptPreview: ["{\"type\":\"text\",\"text\":\"native session completed\"}"],
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
      <Runs
        runs={[nativeRun, ...initialRuns.slice(1)]}
        selectedTask={initialTasks[0]}
        selectedAgent={agents[0]}
        reviewFileSelections={reviewFileSelections}
        commitConversationIncluded
        browserEvidence={[]}
        commitRedactionScans={[]}
        verificationEvents={[]}
        terminalEvents={[]}
        mcpToolEvents={[]}
        reviewApprovalEvents={[]}
        commitStagingEvents={[]}
        pullRequestHandoffEvents={[]}
        onCreatePullRequestHandoff={() => undefined}
      />,
    );

    expect(screen.getByText("Native session state")).toBeTruthy();
    expect(screen.getAllByText("native-task-plan-watch").length).toBeGreaterThan(0);
    expect(screen.getByText("opencode-go/deepseek-v4-flash")).toBeTruthy();
    expect(screen.getByText("{\"type\":\"text\",\"text\":\"native session completed\"}")).toBeTruthy();
  });

  it("shows commit scope and Agent-Conversation trailer state as audit context", () => {
    const prHandoffs: string[] = [];
    const RunsWithRedaction = Runs as ComponentType<
      ComponentProps<typeof Runs> & {
        commitStagingEvents?: typeof commitStagingEvents;
        pullRequestHandoffEvents?: typeof pullRequestHandoffEvents;
        onCreatePullRequestHandoff?: (runId: string) => void;
      }
    >;

    render(
      <RunsWithRedaction
        runs={initialRuns}
        selectedTask={initialTasks[0]}
        selectedAgent={agents[0]}
        reviewFileSelections={reviewFileSelections}
        commitConversationIncluded
        browserEvidence={browserEvidence}
        commitRedactionScans={redactionScans}
        verificationEvents={verificationEvents}
        terminalEvents={terminalEvents}
        mcpToolEvents={mcpToolEvents}
        reviewApprovalEvents={reviewApprovalEvents}
        commitStagingEvents={commitStagingEvents}
        pullRequestHandoffEvents={pullRequestHandoffEvents}
        onCreatePullRequestHandoff={(runId) => prHandoffs.push(runId)}
      />,
    );

    expect(screen.getByText("Commit scope")).toBeTruthy();
    expect(screen.getByText("4 selected files")).toBeTruthy();
    expect(screen.getByText("1 excluded")).toBeTruthy();
    expect(screen.getByText("src/review/commit-context.ts")).toBeTruthy();
    expect(screen.getByText("Git staging evidence")).toBeTruthy();
    expect(screen.getByText("Staged 4 scoped files for task-plan-watch; 1 left unstaged.")).toBeTruthy();
    expect(screen.getByText(".agent-workspace/runs/run-plan-watc-active/staging.json")).toBeTruthy();
    expect(screen.getByText("Agent-Conversation trailer")).toBeTruthy();
    expect(screen.getByText("selected")).toBeTruthy();
    expect(screen.getAllByText(".agent-workspace/runs/run-plan-watc-active/transcript.log").length).toBeGreaterThan(0);
    expect(screen.getByText("Worktree context")).toBeTruthy();
    expect(screen.getAllByText("feature/agent-workspace-mvp").length).toBeGreaterThan(0);
    expect(screen.getByText("/Users/dinker/CODES/Agent-Workspace")).toBeTruthy();
    expect(screen.getByText(".agent-workspace/runs/run-plan-watc-active/worktree.json")).toBeTruthy();
    expect(screen.getByText("Launch policy")).toBeTruthy();
    expect(screen.getByText(".agent-workspace/runs/run-plan-watc-active/policy.json")).toBeTruthy();
    expect(screen.getAllByText("ask-before-write").length).toBeGreaterThan(0);
    expect(screen.getByText("workspace-write")).toBeTruthy();
    expect(screen.getByText("medium")).toBeTruthy();
    expect(screen.getByText("opencode --model opencode-go/deepseek-v4-flash")).toBeTruthy();
    expect(screen.getByText("Terminal diagnostics evidence")).toBeTruthy();
    expect(screen.getByText("Parser classified planner tool activity from terminal output.")).toBeTruthy();
    expect(screen.getAllByText(".agent-workspace/runs/run-plan-watc-active/terminal-events.jsonl").length).toBeGreaterThan(0);
    expect(screen.getByText("term.rule.tool-call")).toBeTruthy();
    expect(screen.getByText("MCP tool evidence")).toBeTruthy();
    expect(screen.getByText("Scheduler approved backlog_update for Backlog MCP; tool execution may proceed.")).toBeTruthy();
    expect(screen.getByText(".agent-workspace/mcp/mcp-event-backlog-update-001/confirmation.json")).toBeTruthy();
    expect(screen.getByText("Browser evidence")).toBeTruthy();
    expect(screen.getByText(".agent-workspace/browser/task-plan-watch/browser_screenshot-001.json")).toBeTruthy();
    expect(screen.getByText("Conversation redaction")).toBeTruthy();
    expect(screen.getByText(".agent-workspace/runs/run-plan-watc-active/redaction.json")).toBeTruthy();
    expect(screen.getByText(".env")).toBeTruthy();
    expect(screen.getByText("Verification command history")).toBeTruthy();
    expect(screen.getByText("Verification command passed and evidence was recorded by the Review gate.")).toBeTruthy();
    expect(screen.getAllByText(".agent-workspace/runs/run-plan-watc-active/verification.json").length).toBeGreaterThan(0);
    expect(screen.getByText("Review approval history")).toBeTruthy();
    expect(screen.getByText("Review approved task-plan-watch with verification passed and 3 scoped files.")).toBeTruthy();
    expect(screen.getAllByText(".agent-workspace/reviews/run-plan-watc-active/approval.json").length).toBeGreaterThan(0);
    expect(screen.getByText("PR handoff")).toBeTruthy();
    expect(screen.getByText("PR handoff ready for task-plan-watch from run-plan-watc-active.")).toBeTruthy();
    expect(screen.getByText(".agent-workspace/pr/run-plan-watc-active/handoff.json")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Prepare PR handoff for run-plan-watc-active" }));

    expect(prHandoffs).toEqual(["run-plan-watc-active"]);
  });
});

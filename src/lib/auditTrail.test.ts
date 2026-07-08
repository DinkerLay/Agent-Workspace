import { describe, expect, it } from "vitest";
import { buildWorkspaceAuditTrail } from "./auditTrail";
import { initialPrototypeState } from "../mock/prototypeData";
import { prototypeReducer } from "./taskMachine";
import type { TerminalEvent } from "../types";

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

describe("workspace audit trail", () => {
  it("normalizes shell-owned event streams into one newest-first evidence timeline", () => {
    const withProject = prototypeReducer(initialPrototypeState, {
      type: "select-project",
      projectId: "project-opencode-flow",
    });
    const withTransition = prototypeReducer(withProject, { type: "advance-task", taskId: "task-review" });
    const withBrowserEvidence = {
      ...withTransition,
      browserEvidence: [
        {
          id: "browser-evidence-task-browser-001",
          taskId: "task-browser",
          toolName: "browser_screenshot",
          summary: "browser_screenshot captured screenshot artifact path for Browser smoke",
          artifactPath: ".agent-workspace/browser/task-browser/browser_screenshot-001.json",
          capturedAt: "2026-06-24T13:20:00Z",
        },
      ],
    };
    const withTaskArtifact = prototypeReducer(
      { ...withBrowserEvidence, selectedTaskId: "task-plan-watch" },
      { type: "attach-scratchpad-artifact", itemId: "scratchpad-screenshot" } as never,
    );
    const withVerification = prototypeReducer(withTaskArtifact, {
      type: "run-verification-command",
      taskId: "task-plan-watch",
    } as never);

    const entries = buildWorkspaceAuditTrail({ ...withVerification, terminalEvents });

    expect(entries.map((entry) => entry.id)).toEqual(expect.arrayContaining([
      "project-context-project-opencode-flow-001",
      "task-transition-task-review-001",
      "browser-evidence-task-browser-001",
      "task-artifact-task-plan-watch-001",
      "verification-run-plan-watc-active-001",
      "terminal-event-run-plan-watc-active-001",
      "watch-spec-product-map",
      "run-run-plan-watc-active",
      "run-policy-run-plan-watc-active",
    ]));
    expect(entries.find((entry) => entry.id === "run-policy-run-plan-watc-active")).toMatchObject({
      id: "run-policy-run-plan-watc-active",
      surface: "Runs",
      kind: "Runtime policy",
      title: "Runtime policy run-plan-watc-active",
      summary:
        "ask-before-write; workspace-write; effort medium; command opencode --model opencode-go/deepseek-v4-flash",
      status: "ask-before-write",
      evidencePath: ".agent-workspace/runs/run-plan-watc-active/policy.json",
      createdAt: "2026-06-24T13:00:00Z",
      taskId: "task-plan-watch",
    });
    expect(entries.find((entry) => entry.id === "terminal-event-run-plan-watc-active-001")).toMatchObject({
      id: "terminal-event-run-plan-watc-active-001",
      surface: "Runs",
      kind: "Terminal event",
      title: "Parser classified planner tool activity from terminal output.",
      summary: "term.rule.tool-call; tool-call -> running; source Planner loop: detected research delta -> generating task graph",
      status: "tool-call",
      evidencePath: ".agent-workspace/runs/run-plan-watc-active/terminal-events.jsonl",
      createdAt: "2026-06-24T13:01:00Z",
      taskId: "task-plan-watch",
    });
    expect(entries.find((entry) => entry.id === "task-artifact-task-plan-watch-001")).toMatchObject({
      id: "task-artifact-task-plan-watch-001",
      surface: "Task Board",
      evidencePath: ".agent-workspace/tasks/task-plan-watch/artifacts/scratchpad-screenshot-001.json",
      status: "screenshot",
    });
    expect(entries.find((entry) => entry.id === "task-transition-task-review-001")).toMatchObject({
      id: "task-transition-task-review-001",
      surface: "Task Board",
      evidencePath: ".agent-workspace/tasks/events.jsonl",
      status: "queued",
    });
    expect(entries.find((entry) => entry.id === "browser-evidence-task-browser-001")).toMatchObject({
      id: "browser-evidence-task-browser-001",
      surface: "Browser",
      kind: "Browser evidence",
      title: "browser_screenshot captured screenshot artifact path for Browser smoke",
      summary: "browser_screenshot evidence for task-browser",
      status: "browser_screenshot",
      evidencePath: ".agent-workspace/browser/task-browser/browser_screenshot-001.json",
      createdAt: "2026-06-24T13:20:00Z",
      taskId: "task-browser",
    });
    expect(entries.find((entry) => entry.id === "verification-run-plan-watc-active-001")).toMatchObject({
      surface: "Review",
      kind: "Verification command",
      evidencePath: ".agent-workspace/runs/run-plan-watc-active/verification.json",
      status: "passed",
      taskId: "task-plan-watch",
    });
    expect(entries.every((entry) => entry.evidencePath.startsWith(".agent-workspace/"))).toBe(true);
    expect(entries.map((entry) => entry.createdAt)).toEqual([...entries.map((entry) => entry.createdAt)].sort().reverse());
  });

  it("includes task intake evidence before any run exists", () => {
    const withIntake = prototypeReducer(initialPrototypeState, {
      type: "create-task-from-intake",
      title: "Design command palette empty state",
      summary: "Show the empty state for no matching commands.",
      labels: ["ux", "mvp"],
      intakeSource: "manual-brief",
      owner: "Executor",
      artifactPath: ".agent-workspace/scratchpad/sketches/command-palette-empty.png",
    } as never);

    const entries = buildWorkspaceAuditTrail(withIntake);

    expect(entries.find((entry) => entry.id === "task-intake-event-001")).toMatchObject({
      id: "task-intake-event-001",
      surface: "Task Board",
      kind: "Task intake",
      title: "Captured Design command palette empty state",
      summary: "manual-brief; labels ux, mvp; artifact .agent-workspace/scratchpad/sketches/command-palette-empty.png",
      status: "queued",
      evidencePath: ".agent-workspace/tasks/intake.jsonl",
      createdAt: "2026-06-24T14:45:00Z",
      taskId: "task-intake-001",
    });
    expect(withIntake.runs).toHaveLength(initialPrototypeState.runs.length);
  });

  it("includes review approval evidence as its own audit entry", () => {
    const entries = buildWorkspaceAuditTrail({
      ...initialPrototypeState,
      reviewApprovalEvents: [
        {
          id: "review-approval-run-plan-watc-active-001",
          taskId: "task-plan-watch",
          runId: "run-plan-watc-active",
          verificationStatus: "passed",
          selectedFilePaths: ["src/pty/session-manager.ts", "src/review/commit-context.ts"],
          redactionArtifactPath: ".agent-workspace/runs/run-plan-watc-active/redaction.json",
          commitProposalPath: ".agent-workspace/runs/run-plan-watc-active/commit.json",
          evidencePath: ".agent-workspace/reviews/run-plan-watc-active/approval.json",
          approvedAt: "2026-06-24T14:25:00Z",
          summary: "Review approved task-plan-watch with verification passed and 2 scoped files.",
        },
      ],
    } as never);

    expect(entries.find((entry) => entry.id === "review-approval-run-plan-watc-active-001")).toMatchObject({
      surface: "Review",
      kind: "Review approval",
      title: "Review approved task-plan-watch with verification passed and 2 scoped files.",
      summary: "run-plan-watc-active; commit .agent-workspace/runs/run-plan-watc-active/commit.json",
      status: "approved",
      evidencePath: ".agent-workspace/reviews/run-plan-watc-active/approval.json",
      createdAt: "2026-06-24T14:25:00Z",
      taskId: "task-plan-watch",
    });
  });

  it("includes blocked review gate evidence as its own audit entry", () => {
    const entries = buildWorkspaceAuditTrail({
      ...initialPrototypeState,
      reviewGateEvents: [
        {
          id: "review-gate-run-plan-watc-active-001",
          taskId: "task-plan-watch",
          runId: "run-plan-watc-active",
          status: "blocked",
          reason: "verification-required",
          evidencePath: ".agent-workspace/reviews/run-plan-watc-active/gate.json",
          createdAt: "2026-06-24T14:35:00Z",
          summary: "Review approval blocked for task-plan-watch: verification evidence must pass first.",
        },
      ],
    } as never);

    expect(entries.find((entry) => entry.id === "review-gate-run-plan-watc-active-001")).toMatchObject({
      surface: "Review",
      kind: "Review gate",
      title: "Review approval blocked for task-plan-watch: verification evidence must pass first.",
      summary: "run-plan-watc-active; verification-required",
      status: "blocked",
      evidencePath: ".agent-workspace/reviews/run-plan-watc-active/gate.json",
      createdAt: "2026-06-24T14:35:00Z",
      taskId: "task-plan-watch",
    });
  });

  it("includes PR handoff evidence without treating it as an opened PR", () => {
    const entries = buildWorkspaceAuditTrail({
      ...initialPrototypeState,
      pullRequestHandoffEvents: [
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
      ],
    } as never);

    expect(entries.find((entry) => entry.id === "pr-handoff-run-plan-watc-active-001")).toMatchObject({
      surface: "Runs",
      kind: "PR handoff",
      title: "PR handoff ready for task-plan-watch from run-plan-watc-active.",
      summary: "feature/agent-workspace-mvp; commit .agent-workspace/runs/run-plan-watc-active/commit.json",
      status: "draft-ready",
      evidencePath: ".agent-workspace/pr/run-plan-watc-active/handoff.json",
      createdAt: "2026-06-24T14:30:00Z",
      taskId: "task-plan-watch",
    });
  });

  it("preserves notification source evidence in workspace audit entries", () => {
    const pending = prototypeReducer(initialPrototypeState, {
      type: "agent-claims-done",
      taskId: "task-plan-watch",
    });
    const verified = prototypeReducer(pending, {
      type: "run-verification-command",
      taskId: "task-plan-watch",
    } as never);
    const approved = prototypeReducer(verified, {
      type: "approve-review",
      taskId: "task-plan-watch",
    } as never);

    const entries = buildWorkspaceAuditTrail(approved);

    expect(entries.find((entry) => entry.id === "notification-task-plan-watch-review-approval-run-plan-watc-active-001"))
      .toMatchObject({
        surface: "Notifications",
        kind: "Notification",
        status: "done",
        summary: "sidebar; unacknowledged; source Review approval review-approval-run-plan-watc-active-001",
        evidencePath:
          ".agent-workspace/notifications/notification-task-plan-watch-review-approval-run-plan-watc-active-001.json",
        taskId: "task-plan-watch",
        sourceLabel: "Review approval",
        sourceEventId: "review-approval-run-plan-watc-active-001",
        sourceEvidencePath: ".agent-workspace/reviews/run-plan-watc-active/approval.json",
        sourceSummary: "Review approved task-plan-watch with verification passed and 5 scoped files.",
      });
  });

  it("includes git staging evidence as a review-owned audit entry", () => {
    const entries = buildWorkspaceAuditTrail({
      ...initialPrototypeState,
      commitStagingEvents: [
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
      ],
    } as never);

    expect(entries.find((entry) => entry.id === "commit-staging-run-plan-watc-active-001")).toMatchObject({
      surface: "Review",
      kind: "Git staging",
      title: "Staged 4 scoped files for task-plan-watch; 1 left unstaged.",
      summary: "run-plan-watc-active; staged 4; unstaged 1",
      status: "staged",
      evidencePath: ".agent-workspace/runs/run-plan-watc-active/staging.json",
      createdAt: "2026-06-24T14:22:00Z",
      taskId: "task-plan-watch",
    });
  });

  it("preserves Agent-Conversation redaction task and run context in workspace audit entries", () => {
    const withTrailer = prototypeReducer(initialPrototypeState, { type: "toggle-commit-conversation" } as never);
    const scanned = prototypeReducer(withTrailer, {
      type: "run-commit-redaction-scan",
      taskId: "task-plan-watch",
    } as never);

    const entries = buildWorkspaceAuditTrail(scanned);

    expect(entries.find((entry) => entry.id === "redaction-run-plan-watc-active")).toMatchObject({
      surface: "Review",
      kind: "Redaction scan",
      title: "Agent-Conversation redaction for run-plan-watc-active",
      summary:
        "run-plan-watc-active; transcript .agent-workspace/runs/run-plan-watc-active/transcript.log; patterns API key, .env, token",
      status: "passed",
      evidencePath: ".agent-workspace/runs/run-plan-watc-active/redaction.json",
      taskId: "task-plan-watch",
      runId: "run-plan-watc-active",
    });
  });

  it("includes MCP confirmation decision evidence", () => {
    const entries = buildWorkspaceAuditTrail({
      ...initialPrototypeState,
      mcpToolEvents: [
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
      ],
    } as never);

    expect(entries.find((entry) => entry.id === "mcp-event-backlog-update-001")).toMatchObject({
      surface: "MCP Gateway",
      kind: "MCP tool call",
      title: "Scheduler approved backlog_update for Backlog MCP; tool execution may proceed.",
      summary: "mcp-backlog.backlog_update; confirm; evidence .agent-workspace/tasks/events.jsonl",
      status: "approved",
      evidencePath: ".agent-workspace/mcp/mcp-event-backlog-update-001/confirmation.json",
      createdAt: "2026-06-24T14:40:00Z",
      taskId: "task-plan-watch",
    });
  });

  it("does not mutate tasks or runs while deriving the timeline", () => {
    const entries = buildWorkspaceAuditTrail(initialPrototypeState);

    expect(entries.length).toBeGreaterThan(0);
    expect(initialPrototypeState.tasks.map((task) => task.status)).toEqual([
      "running",
      "waiting-input",
      "todo",
      "todo",
      "done",
    ]);
    expect(initialPrototypeState.runs.map((run) => run.id)).toEqual([
      "run-plan-watc-active",
      "run-pty-active",
      "run-library-closed",
    ]);
  });
});

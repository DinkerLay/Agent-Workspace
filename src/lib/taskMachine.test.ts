import { describe, expect, it } from "vitest";
import { initialPrototypeState } from "../mock/prototypeData";
import { createRuntimeWorkspaceState } from "../runtime/opencode";
import {
  getActiveRunForTask,
  getAgentForTask,
  getLoopForTask,
  getRunIdForTask,
  getRunsForTask,
  prototypeReducer,
} from "./taskMachine";

describe("prototype task state machine", () => {
  it("cycles task status through the review-gated delivery flow", () => {
    const task = initialPrototypeState.tasks.find((item) => item.id === "task-review");
    expect(task?.status).toBe("todo");

    const queued = prototypeReducer(initialPrototypeState, {
      type: "advance-task",
      taskId: "task-review",
    });
    expect(queued.tasks.find((item) => item.id === "task-review")?.status).toBe("queued");

    const running = prototypeReducer(queued, {
      type: "advance-task",
      taskId: "task-review",
    });
    expect(running.tasks.find((item) => item.id === "task-review")?.status).toBe("running");

    const waiting = prototypeReducer(running, {
      type: "advance-task",
      taskId: "task-review",
    });
    expect(waiting.tasks.find((item) => item.id === "task-review")?.status).toBe("waiting-input");

    const pending = prototypeReducer(waiting, {
      type: "advance-task",
      taskId: "task-review",
    });
    expect(pending.tasks.find((item) => item.id === "task-review")?.status).toBe("pending-review");

    const done = prototypeReducer(pending, {
      type: "advance-task",
      taskId: "task-review",
    });
    expect(done.tasks.find((item) => item.id === "task-review")?.status).toBe("done");
  });

  it("keeps selected task and terminal transcript in sync when advancing", () => {
    const next = prototypeReducer(initialPrototypeState, {
      type: "advance-task",
      taskId: "task-pty",
    });

    expect(next.selectedTaskId).toBe("task-pty");
    expect(next.terminalLines[next.terminalLines.length - 1]).toBe(
      "scheduler: 设计真实 PTY session manager 的前端状态 -> pending-review",
    );
  });

  it("records task transition events when the board advances task state", () => {
    const next = prototypeReducer(initialPrototypeState, {
      type: "advance-task",
      taskId: "task-review",
    });
    const transitionEvent = next.taskTransitionEvents[0];

    expect(transitionEvent).toMatchObject({
      id: "task-transition-task-review-001",
      taskId: "task-review",
      fromStatus: "todo",
      toStatus: "queued",
      summary: "Task task-review moved from todo to queued",
      evidencePath: ".agent-workspace/tasks/events.jsonl",
      createdAt: "2026-06-24T14:00:00Z",
    });
    expect(next.runs).toHaveLength(initialPrototypeState.runs.length);
  });

  it("resolves task loop, run id, and owning agent from task state", () => {
    const plannerTask = initialPrototypeState.tasks.find((item) => item.id === "task-plan-watch");
    const ptyTask = initialPrototypeState.tasks.find((item) => item.id === "task-pty");

    expect(plannerTask).toBeDefined();
    expect(ptyTask).toBeDefined();

    expect(getLoopForTask(plannerTask!)).toBe("Planner loop");
    expect(getRunIdForTask(plannerTask!)).toBe("run-plan-watc-active");
    expect(getAgentForTask(initialPrototypeState.agents, ptyTask!)?.id).toBe(
      "agent-workspace-pty-session-manager-executor",
    );
  });

  it("sends prompts to the active agent transcript and clears the composer", () => {
    const next = prototypeReducer(
      { ...initialPrototypeState, prompt: "请检查 Pending Review 门禁" },
      { type: "send-prompt" },
    );

    expect(next.prompt).toBe("");
    expect(next.terminalLines.slice(-1)).toEqual([
      "> 请检查 Pending Review 门禁",
    ]);
  });

  it("starts an agent run from a task and opens the workbench context", () => {
    const next = prototypeReducer(initialPrototypeState, {
      type: "start-agent",
      taskId: "task-review",
    });
    const activeRun = getActiveRunForTask(next.runs, "task-review");

    expect(next.tasks.find((item) => item.id === "task-review")?.status).toBe("running");
    expect(next.selectedTaskId).toBe("task-review");
    expect(next.selectedAgentId).toBe("reviewer");
    expect(next.activeView).toBe("workbench");
    expect(activeRun).toMatchObject({
      id: "run-review-active",
      taskId: "task-review",
      agentId: "reviewer",
      status: "running",
      startGitSha: "abc1234",
      worktreeContext: {
        isolationPolicy: "isolated",
        branchName: "agent/reviewer/task-review",
        worktreePath: ".agent-workspace/worktrees/task-review-reviewer",
        baselineManifestPath: ".agent-workspace/runs/run-review-active/worktree.json",
      },
      promptPath: ".agent-workspace/runs/run-review-active/prompt.md",
      transcriptPath: ".agent-workspace/runs/run-review-active/transcript.log",
      diffPath: ".agent-workspace/runs/run-review-active/diff.patch",
      verificationPath: ".agent-workspace/runs/run-review-active/verification.json",
      commitPath: ".agent-workspace/runs/run-review-active/commit.json",
      verification: {
        command: "npm test && npm run build",
        status: "pending",
      },
      commitProposal: {
        policy: "proposal-first",
        approved: false,
      },
    });
    expect(next.terminalLines[next.terminalLines.length - 1]).toBe(
      "scheduler: started Reviewer for 按 Agent 归因 changed files 并保存 commit context",
    );
  });

  it("moves agent done claims into pending review instead of Done", () => {
    const running = prototypeReducer(initialPrototypeState, {
      type: "start-agent",
      taskId: "task-review",
    });
    const next = prototypeReducer(running, {
      type: "agent-claims-done",
      taskId: "task-review",
    });
    const activeRun = getActiveRunForTask(next.runs, "task-review");

    expect(next.tasks.find((item) => item.id === "task-review")?.status).toBe("pending-review");
    expect(next.activeView).toBe("review");
    expect(activeRun?.status).toBe("pending-review");
    expect(activeRun?.commitProposal.message).toContain("Task: task-review");
    expect(activeRun?.commitProposal.message).toContain("Agent-Run: run-review-active");
    expect(next.terminalLines[next.terminalLines.length - 1]).toBe(
      "review gate: Reviewer claimed done; review and verification required",
    );
  });

  it("attaches native opencode session evidence without moving the task into review", () => {
    const running = prototypeReducer(initialPrototypeState, {
      type: "start-agent",
      taskId: "task-review",
    });
    const next = prototypeReducer(running, {
      type: "attach-native-session-evidence",
      taskId: "task-review",
      agentId: "reviewer",
      session: {
        id: "native-task-review",
        command: "/opt/homebrew/bin/opencode",
        args: ["run", "--format", "json", "--model", "opencode-go/deepseek-v4-flash", "task"],
        cwd: "/Users/dinker/CODES/Agent-Workspace",
        model: "opencode-go/deepseek-v4-flash",
        backend: "process",
        status: "stopped",
        exitCode: 0,
        transcript: ["{\"type\":\"text\",\"text\":\"native session completed\"}\n"],
      },
    } as never);
    const activeRun = getActiveRunForTask(next.runs, "task-review");
    const doneSignal = next.terminalEvents.find((event) => event.id === "terminal-event-run-review-active-native-001");

    expect(next.tasks.find((item) => item.id === "task-review")?.status).toBe("running");
    expect(next.activeView).toBe(running.activeView);
    expect(next.selectedAgentId).toBe(running.selectedAgentId);
    expect(activeRun).toMatchObject({
      id: "run-review-active",
      status: "completed",
      transcriptPath: ".agent-workspace/runs/run-review-active/transcript.log",
      transcriptPreview: ["{\"type\":\"text\",\"text\":\"native session completed\"}"],
      nativeSession: {
        id: "native-task-review",
        backend: "process",
        status: "stopped",
        exitCode: 0,
        model: "opencode-go/deepseek-v4-flash",
      },
      runtimePolicy: {
        cliCommand: "/opt/homebrew/bin/opencode run --format json --model opencode-go/deepseek-v4-flash task",
      },
    });
    expect(activeRun?.commitProposal.message).toContain("Verification: pending");
    expect(next.tasks.find((item) => item.id === "task-review")?.status).not.toBe("done");
    expect(next.tasks.find((item) => item.id === "task-review")?.status).not.toBe("pending-review");
    expect(doneSignal).toMatchObject({
      taskId: "task-review",
      runId: "run-review-active",
      kind: "process-signal",
      mappedStatus: "running",
      sourceLine: "native session native-task-review stopped with exit 0",
      evidencePath: "/Users/dinker/CODES/Agent-Workspace",
      summary: "Native opencode session exited successfully; session state was recorded without claiming review readiness.",
    });
    expect(next.terminalLines[next.terminalLines.length - 1]).toBe(
      "native session: native-task-review stopped; state attached to run-review-active",
    );
  });

  it("uses raw PTY lifecycle instead of terminal-derived sampled state for agent status", () => {
    const running = prototypeReducer(initialPrototypeState, {
      type: "start-agent",
      taskId: "task-review",
    });
    const next = prototypeReducer(running, {
      type: "attach-native-session-evidence",
      taskId: "task-review",
      agentId: "reviewer",
      session: {
        id: "native-task-review",
        command: "/opt/homebrew/bin/opencode",
        args: ["--model", "opencode-go/deepseek-v4-flash"],
        cwd: "/Users/dinker/CODES/Agent-Workspace",
        model: "opencode-go/deepseek-v4-flash",
        backend: "pty",
        status: "running",
        transcript: ['Ask anything... "Fix a TODO in the codebase"\n'],
      },
    } as never);

    expect(next.agents.find((agent) => agent.id === "reviewer")?.status).toBe("working");
  });

  it("keeps failed verification out of Done", () => {
    const next = prototypeReducer(initialPrototypeState, {
      type: "verification-failed",
      taskId: "task-pty",
    });
    const activeRun = getActiveRunForTask(next.runs, "task-pty");

    expect(next.tasks.find((item) => item.id === "task-pty")?.status).toBe("failed-verification");
    expect(next.activeView).toBe("review");
    expect(activeRun?.status).toBe("failed-verification");
    expect(activeRun?.verification.status).toBe("failed");
    expect(activeRun?.verification.summary).toBe("Verification failed; review before retry.");
    expect(next.terminalLines[next.terminalLines.length - 1]).toBe(
      "verification: 设计真实 PTY session manager 的前端状态 failed and needs review",
    );
  });

  it("only marks a pending review task done after approval", () => {
    const pending = prototypeReducer(initialPrototypeState, {
      type: "agent-claims-done",
      taskId: "task-review",
    });
    const verified = prototypeReducer(pending, {
      type: "run-verification-command",
      taskId: "task-review",
    } as never);
    const next = prototypeReducer(verified, {
      type: "approve-review",
      taskId: "task-review",
    });
    const reviewRuns = getRunsForTask(next.runs, "task-review");
    const activeRun = reviewRuns[reviewRuns.length - 1];

    expect(next.tasks.find((item) => item.id === "task-review")?.status).toBe("done");
    expect(next.activeView).toBe("runs");
    expect(activeRun?.status).toBe("completed");
    expect(activeRun?.verification.status).toBe("passed");
    expect(activeRun?.commitProposal.approved).toBe(true);
    expect(next.pullRequestHandoffEvents).toHaveLength(initialPrototypeState.pullRequestHandoffEvents.length);
    expect(next.terminalLines[next.terminalLines.length - 1]).toBe(
      "review gate: 按 Agent 归因 changed files 并保存 commit context approved and moved to Done",
    );
  });

  it("blocks review approval until verification evidence passes", () => {
    const next = prototypeReducer(initialPrototypeState, {
      type: "approve-review",
      taskId: "task-plan-watch",
    });
    const activeRun = getActiveRunForTask(next.runs, "task-plan-watch");
    const gateEvent = (
      next as {
        reviewGateEvents?: Array<{
          id: string;
          taskId: string;
          runId: string;
          status: string;
          reason: string;
          evidencePath: string;
          createdAt: string;
          summary: string;
        }>;
      }
    ).reviewGateEvents?.[0];

    expect(next.tasks.find((item) => item.id === "task-plan-watch")?.status).toBe("running");
    expect(next.activeView).toBe("review");
    expect(activeRun?.status).toBe("running");
    expect(activeRun?.verification.status).toBe("pending");
    expect(activeRun?.commitProposal.approved).toBe(false);
    expect(gateEvent).toMatchObject({
      id: "review-gate-run-plan-watc-active-001",
      taskId: "task-plan-watch",
      runId: "run-plan-watc-active",
      status: "blocked",
      reason: "verification-required",
      evidencePath: ".agent-workspace/reviews/run-plan-watc-active/gate.json",
      createdAt: "2026-06-24T14:35:00Z",
      summary: "Review approval blocked for task-plan-watch: verification evidence must pass first.",
    });
    expect(next.terminalLines[next.terminalLines.length - 1]).toBe(
      "review gate: blocked task-plan-watch until verification evidence passes",
    );
  });

  it("blocks review approval until Agent-Conversation redaction passes when trailer is selected", () => {
    const verified = prototypeReducer(initialPrototypeState, {
      type: "run-verification-command",
      taskId: "task-plan-watch",
    } as never);
    const withTrailer = prototypeReducer(verified, { type: "toggle-commit-conversation" } as never);
    const next = prototypeReducer(withTrailer, {
      type: "approve-review",
      taskId: "task-plan-watch",
    });
    const gateEvent = (
      next as {
        reviewGateEvents?: Array<{
          reason: string;
          summary: string;
        }>;
      }
    ).reviewGateEvents?.[0];

    expect(next.tasks.find((item) => item.id === "task-plan-watch")?.status).toBe("running");
    expect(getActiveRunForTask(next.runs, "task-plan-watch")?.commitProposal.approved).toBe(false);
    expect(gateEvent).toMatchObject({
      reason: "redaction-required",
      summary: "Review approval blocked for task-plan-watch: Agent-Conversation redaction must pass first.",
    });
    expect(next.terminalLines[next.terminalLines.length - 1]).toBe(
      "review gate: blocked task-plan-watch until Agent-Conversation redaction passes",
    );
  });

  it("records review approval evidence when Done is approved", () => {
    const verified = prototypeReducer(initialPrototypeState, {
      type: "run-verification-command",
      taskId: "task-plan-watch",
    } as never);
    const withTrailer = prototypeReducer(verified, { type: "toggle-commit-conversation" } as never);
    const scanned = prototypeReducer(withTrailer, {
      type: "run-commit-redaction-scan",
      taskId: "task-plan-watch",
    } as never);
    const approved = prototypeReducer(scanned, {
      type: "approve-review",
      taskId: "task-plan-watch",
    });
    const approvalEvent = (
      approved as {
        reviewApprovalEvents?: Array<{
          id: string;
          taskId: string;
          runId: string;
          verificationStatus: string;
          selectedFilePaths: string[];
          redactionArtifactPath?: string;
          commitProposalPath: string;
          evidencePath: string;
          approvedAt: string;
          summary: string;
        }>;
      }
    ).reviewApprovalEvents?.[0];

    expect(approvalEvent).toMatchObject({
      id: "review-approval-run-plan-watc-active-001",
      taskId: "task-plan-watch",
      runId: "run-plan-watc-active",
      verificationStatus: "passed",
      selectedFilePaths: [
        "src/pty/session-manager.ts",
        "src/tasks/backlog-store.ts",
        "src/review/commit-context.ts",
        "docs/agent-run-lifecycle.md",
        ".agent-workspace/runs/run-104/diff.patch",
      ],
      redactionArtifactPath: ".agent-workspace/runs/run-plan-watc-active/redaction.json",
      commitProposalPath: ".agent-workspace/runs/run-plan-watc-active/commit.json",
      evidencePath: ".agent-workspace/reviews/run-plan-watc-active/approval.json",
      approvedAt: "2026-06-24T14:25:00Z",
      summary: "Review approved task-plan-watch with verification passed and 5 scoped files.",
    });
    expect(approved.runs).toHaveLength(initialPrototypeState.runs.length);
  });

  it("routes a Done notification from review approval evidence", () => {
    const verified = prototypeReducer(initialPrototypeState, {
      type: "run-verification-command",
      taskId: "task-plan-watch",
    } as never);
    const approved = prototypeReducer(verified, {
      type: "approve-review",
      taskId: "task-plan-watch",
    });
    const notification = approved.notificationEvents[0];

    expect(notification).toMatchObject({
      id: "notification-task-plan-watch-review-approval-run-plan-watc-active-001",
      taskId: "task-plan-watch",
      level: "done",
      destination: "sidebar",
      acknowledged: false,
      summary: "监听 docs 产品意图变化并创建 planner task: Review approved; task Done and ready for Runs audit.",
      evidencePath:
        ".agent-workspace/notifications/notification-task-plan-watch-review-approval-run-plan-watc-active-001.json",
      createdAt: "2026-06-24T14:25:00Z",
      sourceLabel: "Review approval",
      sourceEventId: "review-approval-run-plan-watc-active-001",
      sourceEvidencePath: ".agent-workspace/reviews/run-plan-watc-active/approval.json",
      sourceSummary: "Review approved task-plan-watch with verification passed and 5 scoped files.",
    });
    expect(approved.pullRequestHandoffEvents).toHaveLength(initialPrototypeState.pullRequestHandoffEvents.length);
    expect(approved.activeView).toBe("runs");
  });

  it("records PR handoff evidence after review approval without opening a PR", () => {
    const verified = prototypeReducer(initialPrototypeState, {
      type: "run-verification-command",
      taskId: "task-plan-watch",
    } as never);
    const approved = prototypeReducer(verified, {
      type: "approve-review",
      taskId: "task-plan-watch",
    });
    const handedOff = prototypeReducer(approved, {
      type: "create-pr-handoff",
      runId: "run-plan-watc-active",
    } as never);
    const handoffEvent = (
      handedOff as {
        pullRequestHandoffEvents?: Array<{
          id: string;
          taskId: string;
          runId: string;
          branchName: string;
          approvalEvidencePath: string;
          commitProposalPath: string;
          prDraftPath: string;
          status: string;
          createdAt: string;
          summary: string;
        }>;
      }
    ).pullRequestHandoffEvents?.[0];

    expect(handoffEvent).toMatchObject({
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
    });
    expect(handedOff.runs).toHaveLength(initialPrototypeState.runs.length);
    expect(handedOff.tasks.find((task) => task.id === "task-plan-watch")?.status).toBe("done");
    expect(handedOff.terminalLines[handedOff.terminalLines.length - 1]).toBe(
      "pr handoff: prepared draft package for run-plan-watc-active",
    );
  });

  it("records scoped git staging evidence without moving tasks or creating runs", () => {
    const withExcludedFile = prototypeReducer(initialPrototypeState, {
      type: "toggle-review-file",
      path: "src/tasks/backlog-store.ts",
    } as never);
    const next = prototypeReducer(withExcludedFile, {
      type: "stage-review-files",
      taskId: "task-plan-watch",
    } as never);
    const stagingEvent = (
      next as {
        commitStagingEvents?: Array<{
          id: string;
          taskId: string;
          runId: string;
          status: string;
          stagedFilePaths: string[];
          unstagedFilePaths: string[];
          evidencePath: string;
          createdAt: string;
          summary: string;
        }>;
      }
    ).commitStagingEvents?.[0];
    const activeRun = getActiveRunForTask(next.runs, "task-plan-watch");

    expect(next.tasks).toEqual(initialPrototypeState.tasks);
    expect(next.runs.map((run) => run.id)).toEqual(initialPrototypeState.runs.map((run) => run.id));
    expect(activeRun?.commitProposal.approved).toBe(false);
    expect(activeRun?.commitProposal.message).toContain(
      "Staging-Evidence: .agent-workspace/runs/run-plan-watc-active/staging.json",
    );
    expect(stagingEvent).toMatchObject({
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
    });
    expect(next.terminalLines[next.terminalLines.length - 1]).toBe(
      "git: staged 4 scoped files for run-plan-watc-active; 1 left unstaged",
    );
  });

  it("tracks scoped review files without moving tasks or creating runs", () => {
    const next = prototypeReducer(initialPrototypeState, {
      type: "toggle-review-file",
      path: "src/tasks/backlog-store.ts",
    } as never);
    const fileSelection = next.reviewFileSelections.find((file) => file.path === "src/tasks/backlog-store.ts");

    expect(fileSelection?.selected).toBe(false);
    expect(next.tasks).toEqual(initialPrototypeState.tasks);
    expect(next.runs).toHaveLength(initialPrototypeState.runs.length);
    expect(next.terminalLines[next.terminalLines.length - 1]).toBe(
      "review: excluded src/tasks/backlog-store.ts from scoped commit",
    );
  });

  it("adds scoped files and Agent-Conversation trailer to approved commit proposals", () => {
    const pending = prototypeReducer(initialPrototypeState, {
      type: "agent-claims-done",
      taskId: "task-review",
    });
    const withSelection = prototypeReducer(pending, {
      type: "toggle-review-file",
      path: "src/tasks/backlog-store.ts",
    } as never);
    const verified = prototypeReducer(withSelection, {
      type: "run-verification-command",
      taskId: "task-review",
    } as never);
    const withTrailer = prototypeReducer(verified, { type: "toggle-commit-conversation" } as never);
    const scanned = prototypeReducer(withTrailer, {
      type: "run-commit-redaction-scan",
      taskId: "task-review",
    } as never);
    const approved = prototypeReducer(scanned, {
      type: "approve-review",
      taskId: "task-review",
    });
    const activeRun = getActiveRunForTask(approved.runs, "task-review");

    expect(activeRun?.commitProposal.message).toContain("Files:");
    expect(activeRun?.commitProposal.message).toContain("- src/review/commit-context.ts");
    expect(activeRun?.commitProposal.message).toContain(
      "Agent-Conversation: .agent-workspace/runs/run-review-active/transcript.log",
    );
  });

  it("records Agent-Conversation redaction scans before approved commit context", () => {
    const withTrailer = prototypeReducer(initialPrototypeState, { type: "toggle-commit-conversation" } as never);
    const scanned = prototypeReducer(withTrailer, {
      type: "run-commit-redaction-scan",
      taskId: "task-plan-watch",
    } as never);
    const scan = scanned.commitRedactionScans[0];

    expect(scan).toMatchObject({
      runId: "run-plan-watc-active",
      status: "passed",
      transcriptPath: ".agent-workspace/runs/run-plan-watc-active/transcript.log",
      artifactPath: ".agent-workspace/runs/run-plan-watc-active/redaction.json",
      redactedPatterns: ["API key", ".env", "token"],
    });
    expect(scanned.tasks).toEqual(initialPrototypeState.tasks);
    expect(scanned.runs).toHaveLength(initialPrototypeState.runs.length);
    expect(scanned.terminalLines[scanned.terminalLines.length - 1]).toBe(
      "commit context: redaction scan passed for run-plan-watc-active",
    );

    const verified = prototypeReducer(scanned, {
      type: "run-verification-command",
      taskId: "task-plan-watch",
    } as never);
    const approved = prototypeReducer(verified, {
      type: "approve-review",
      taskId: "task-plan-watch",
    });
    const activeRun = getActiveRunForTask(approved.runs, "task-plan-watch");

    expect(activeRun?.commitProposal.message).toContain(
      "Agent-Conversation-Redaction: .agent-workspace/runs/run-plan-watc-active/redaction.json",
    );
  });

  it("records verification command evidence without moving tasks or creating runs", () => {
    const next = prototypeReducer(initialPrototypeState, {
      type: "run-verification-command",
      taskId: "task-plan-watch",
    } as never);
    const activeRun = getActiveRunForTask(next.runs, "task-plan-watch");

    expect(next.tasks).toEqual(initialPrototypeState.tasks);
    expect(next.runs.map((run) => run.id)).toEqual(initialPrototypeState.runs.map((run) => run.id));
    expect(activeRun?.verification).toMatchObject({
      command: "npm test && npm run build",
      status: "passed",
      summary: "Verification command passed and evidence was recorded by the Review gate.",
      logPath: ".agent-workspace/runs/run-plan-watc-active/verification.log",
    });
    expect((next as { verificationEvents?: Array<{ runId: string; artifactPath: string; status: string }> }).verificationEvents).toEqual([
      expect.objectContaining({
        id: "verification-run-plan-watc-active-001",
        taskId: "task-plan-watch",
        runId: "run-plan-watc-active",
        command: "npm test && npm run build",
        status: "passed",
        artifactPath: ".agent-workspace/runs/run-plan-watc-active/verification.json",
      }),
    ]);
    expect(next.terminalLines).toContain("verification: ran npm test && npm run build for run-plan-watc-active -> passed");
  });

  it("attaches native verification evidence to the active AgentRun without moving tasks or approving review", () => {
    const next = prototypeReducer(initialPrototypeState, {
      type: "attach-native-verification-evidence",
      taskId: "task-plan-watch",
      runId: "run-plan-watc-active",
      result: {
        ok: true,
        command: "npm test -- src/lib/taskMachine.test.ts",
        cwd: "/Users/dinker/CODES/Agent-Workspace",
        runId: "run-plan-watc-active",
        status: "passed",
        stdout: "102 tests passed\n",
        stderr: "",
        exitCode: 0,
        durationMs: 37,
        artifactPath: ".agent-workspace/runs/run-plan-watc-active/verification.json",
        logPath: ".agent-workspace/runs/run-plan-watc-active/verification.log",
      },
    } as never);
    const activeRun = getActiveRunForTask(next.runs, "task-plan-watch");

    expect(next.tasks).toEqual(initialPrototypeState.tasks);
    expect(next.runs.map((run) => run.id)).toEqual(initialPrototypeState.runs.map((run) => run.id));
    expect(activeRun?.verification).toMatchObject({
      command: "npm test -- src/lib/taskMachine.test.ts",
      status: "passed",
      summary: "Native verification command passed with exit code 0.",
      logPath: ".agent-workspace/runs/run-plan-watc-active/verification.log",
    });
    expect(activeRun?.commitProposal.approved).toBe(false);
    expect(next.verificationEvents).toEqual([
      expect.objectContaining({
        id: "verification-run-plan-watc-active-001",
        taskId: "task-plan-watch",
        runId: "run-plan-watc-active",
        command: "npm test -- src/lib/taskMachine.test.ts",
        status: "passed",
        artifactPath: ".agent-workspace/runs/run-plan-watc-active/verification.json",
        logPath: ".agent-workspace/runs/run-plan-watc-active/verification.log",
      }),
    ]);
    expect(next.terminalLines).toContain(
      "verification: native npm test -- src/lib/taskMachine.test.ts for run-plan-watc-active -> passed",
    );
  });

  it("keeps run history queryable per task", () => {
    const next = prototypeReducer(initialPrototypeState, {
      type: "start-agent",
      taskId: "task-review",
    });

    expect(getRunsForTask(next.runs, "task-review").map((run) => run.id)).toEqual(["run-review-active"]);
    expect(getRunsForTask(next.runs, "task-plan-watch").map((run) => run.id)).toEqual([
      "run-plan-watc-active",
    ]);
  });

  it("uses the latest non-completed run as the active run", () => {
    const activeRun = getActiveRunForTask(
      [
        ...initialPrototypeState.runs,
        {
          ...initialPrototypeState.runs[0],
          id: "mock-run-task-plan-watch-001",
          startedAt: "2026-06-24T15:00:00Z",
        },
      ],
      "task-plan-watch",
    );

    expect(activeRun?.id).toBe("mock-run-task-plan-watch-001");
  });

  it("prefers recorded run ids over status-derived labels for board display", () => {
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
    });
    const task = approved.tasks.find((item) => item.id === "task-plan-watch");

    expect(task?.status).toBe("done");
    expect(getRunIdForTask(task!, approved.runs)).toBe("run-plan-watc-active");
  });

  it("starts and stops dev terminal commands without creating agent runs", () => {
    const started = prototypeReducer(initialPrototypeState, {
      type: "start-dev-command",
      commandId: "cmd-api",
    } as never);
    const startedCommand = started.devCommands.find((command) => command.id === "cmd-api");

    expect(startedCommand).toMatchObject({
      status: "running",
      log: "Started by Dev Terminals command manager",
    });
    expect(started.devCommandEvents).toEqual([
      {
        id: "dev-command-event-cmd-api-001",
        commandId: "cmd-api",
        action: "start",
        status: "running",
        summary: "Started Local API service through Dev Terminals command manager",
        evidencePath: ".agent-workspace/commands/events.jsonl",
        logPath: ".agent-workspace/commands/cmd-api/log.txt",
        createdAt: "2026-06-24T13:45:00Z",
      },
    ]);
    expect(started.runs).toHaveLength(initialPrototypeState.runs.length);
    expect(started.tasks).toEqual(initialPrototypeState.tasks);
    expect(started.terminalLines[started.terminalLines.length - 1]).toBe(
      "dev terminal: started Local API service",
    );

    const stopped = prototypeReducer(started, {
      type: "stop-dev-command",
      commandId: "cmd-api",
    } as never);
    const stoppedCommand = stopped.devCommands.find((command) => command.id === "cmd-api");

    expect(stoppedCommand).toMatchObject({
      status: "stopped",
      log: "Stopped by Dev Terminals command manager",
    });
    expect(stopped.devCommandEvents.slice(-1)).toEqual([
      {
        id: "dev-command-event-cmd-api-002",
        commandId: "cmd-api",
        action: "stop",
        status: "stopped",
        summary: "Stopped Local API service through Dev Terminals command manager",
        evidencePath: ".agent-workspace/commands/events.jsonl",
        logPath: ".agent-workspace/commands/cmd-api/log.txt",
        createdAt: "2026-06-24T13:45:00Z",
      },
    ]);
    expect(stopped.runs).toHaveLength(initialPrototypeState.runs.length);
    expect(stopped.tasks).toEqual(initialPrototypeState.tasks);
    expect(stopped.terminalLines[stopped.terminalLines.length - 1]).toBe(
      "dev terminal: stopped Local API service",
    );
  });

  it("leaves library actions unchanged when real library adapters are empty", () => {
    const before = {
      activeView: initialPrototypeState.activeView,
      prompt: initialPrototypeState.prompt,
      activePromptTemplateId: initialPrototypeState.activePromptTemplateId,
      attachedSkillIds: [...initialPrototypeState.attachedSkillIds],
      runs: [...initialPrototypeState.runs],
      terminalLines: [...initialPrototypeState.terminalLines],
    };
    const prompted = prototypeReducer(initialPrototypeState, {
      type: "inject-library-prompt",
      itemId: "prompt-executor",
    });

    expect(prompted).toBe(initialPrototypeState);
    expect(prompted.activeView).toBe(before.activeView);
    expect(prompted.prompt).toBe(before.prompt);
    expect(prompted.activePromptTemplateId).toBe(before.activePromptTemplateId);
    expect(prompted.attachedSkillIds).toEqual(before.attachedSkillIds);
    expect(prompted.runs).toEqual(before.runs);
    expect(prompted.terminalLines).toEqual(before.terminalLines);

    const skilled = prototypeReducer(prompted, {
      type: "attach-library-skill",
      itemId: "skill-verification",
    });

    expect(skilled).toBe(initialPrototypeState);
    expect(skilled.activeView).toBe(before.activeView);
    expect(skilled.prompt).toBe(before.prompt);
    expect(skilled.activePromptTemplateId).toBe(before.activePromptTemplateId);
    expect(skilled.attachedSkillIds).toEqual(before.attachedSkillIds);
    expect(skilled.runs).toEqual(before.runs);
    expect(skilled.terminalLines).toEqual(before.terminalLines);
  });

  it("records project context manifests without creating agent runs or moving tasks", () => {
    const selected = prototypeReducer(initialPrototypeState, {
      type: "select-project",
      projectId: "project-opencode-flow",
    } as never);

    expect(selected.selectedProjectId).toBe("project-opencode-flow");
    expect(selected.selectedTaskId).toBe("task-browser");
    expect((selected as { selectedAgentClusterId?: string }).selectedAgentClusterId).toBe(
      "cluster-opencode-flow-firsttask",
    );
    expect(selected.selectedAgentId).toBe("opencode-flow-firsttask-qa");
    const selectedCluster = (selected as { agentClusters?: Array<{ id: string; name: string; agentIds: string[] }> })
      .agentClusters?.find((cluster) => cluster.id === "cluster-opencode-flow-firsttask");
    expect(selectedCluster).toMatchObject({
      id: "cluster-opencode-flow-firsttask",
      name: "Project Runtime",
      agentIds: ["opencode-flow-firsttask-planner", "opencode-flow-firsttask-qa", "opencode-flow-firsttask-reviewer"],
    });
    expect(selectedCluster?.agentIds).not.toContain("qa");
    expect(selected.projectContextEvents).toEqual([
      {
        id: "project-context-project-opencode-flow-001",
        projectId: "project-opencode-flow",
        zone: "side-project",
        manifestPath: ".agent-workspace/projects/project-opencode-flow.json",
        browserProfile: ".agent-workspace/browser/project-opencode-flow/",
        selectedAt: "2026-06-24T13:50:00Z",
        summary: "Selected OpenCode Agent Flow workspace context",
      },
    ]);
    expect(selected.tasks).toEqual(initialPrototypeState.tasks);
    expect(selected.runs).toHaveLength(initialPrototypeState.runs.length);
    expect(selected.terminalLines[selected.terminalLines.length - 1]).toBe(
      "project: selected OpenCode Agent Flow",
    );
  });

  it("selects a task by aligning project and owner-agent focus without execution side effects", () => {
    const opencodeFocused = {
      ...initialPrototypeState,
      selectedProjectId: "project-opencode-flow",
      selectedTaskId: "task-browser",
      selectedAgentClusterId: "cluster-opencode-flow-firsttask",
      selectedAgentId: "opencode-flow-firsttask-qa",
    };

    const next = prototypeReducer(opencodeFocused, {
      type: "select-task",
      taskId: "task-pty",
    } as never);

    expect(next.selectedTaskId).toBe("task-pty");
    expect(next.selectedProjectId).toBe("project-agent-workspace");
    expect((next as { selectedAgentClusterId?: string }).selectedAgentClusterId).toBe(
      "cluster-agent-workspace-pty-session-manager",
    );
    expect(next.selectedAgentId).toBe("agent-workspace-pty-session-manager-executor");
    expect(next.tasks).toEqual(initialPrototypeState.tasks);
    expect(next.runs).toHaveLength(initialPrototypeState.runs.length);
    expect(next.loopScheduleEvents).toHaveLength(initialPrototypeState.loopScheduleEvents.length);
    expect(next.reviewApprovalEvents).toHaveLength(initialPrototypeState.reviewApprovalEvents.length);
  });

  it("selects a project-owned agent by aligning to that agent current task without scheduling", () => {
    const opencodeFocused = {
      ...initialPrototypeState,
      selectedProjectId: "project-opencode-flow",
      selectedTaskId: "task-browser",
      selectedAgentClusterId: "cluster-opencode-flow-firsttask",
      selectedAgentId: "opencode-flow-firsttask-qa",
    };

    const next = prototypeReducer(opencodeFocused, {
      type: "select-agent",
      agentId: "opencode-flow-firsttask-reviewer",
    } as never);

    expect(next.selectedProjectId).toBe("project-opencode-flow");
    expect((next as { selectedAgentClusterId?: string }).selectedAgentClusterId).toBe(
      "cluster-opencode-flow-firsttask",
    );
    expect(next.selectedAgentId).toBe("opencode-flow-firsttask-reviewer");
    expect(next.selectedTaskId).toBe("task-review");
    expect(next.tasks).toEqual(initialPrototypeState.tasks);
    expect(next.runs).toHaveLength(initialPrototypeState.runs.length);
    expect(next.loopScheduleEvents).toHaveLength(initialPrototypeState.loopScheduleEvents.length);
    expect(next.reviewApprovalEvents).toHaveLength(initialPrototypeState.reviewApprovalEvents.length);
  });

  it("leaves browser actions unchanged when real browser adapters are empty", () => {
    const before = {
      activeBrowserToolName: initialPrototypeState.activeBrowserToolName,
      browserEvidence: [...initialPrototypeState.browserEvidence],
      runs: [...initialPrototypeState.runs],
      tasks: [...initialPrototypeState.tasks],
      terminalLines: [...initialPrototypeState.terminalLines],
    };
    const selected = prototypeReducer(initialPrototypeState, {
      type: "select-browser-tool",
      toolName: "browser_screenshot",
    });

    expect(selected).toBe(initialPrototypeState);
    expect(selected.activeBrowserToolName).toBe(before.activeBrowserToolName);
    expect(selected.browserEvidence).toEqual(before.browserEvidence);
    expect(selected.runs).toEqual(before.runs);
    expect(selected.tasks).toEqual(before.tasks);
    expect(selected.terminalLines).toEqual(before.terminalLines);

    const captured = prototypeReducer(selected, {
      type: "capture-browser-evidence",
    });

    expect(captured).toBe(initialPrototypeState);
    expect(captured.activeBrowserToolName).toBe(before.activeBrowserToolName);
    expect(captured.browserEvidence).toEqual(before.browserEvidence);
    expect(captured.runs).toEqual(before.runs);
    expect(captured.tasks).toEqual(before.tasks);
    expect(captured.terminalLines).toEqual(before.terminalLines);
  });

  it("leaves team workflow actions unchanged when real team adapters are empty", () => {
    const before = {
      selectedTeamWorkflowId: initialPrototypeState.selectedTeamWorkflowId,
      teamRuns: [...initialPrototypeState.teamRuns],
      runs: [...initialPrototypeState.runs],
      tasks: [...initialPrototypeState.tasks],
      terminalLines: [...initialPrototypeState.terminalLines],
    };
    const selected = prototypeReducer(initialPrototypeState, {
      type: "select-team-workflow",
      workflowId: "team-research-plan-exec",
    });

    expect(selected).toBe(initialPrototypeState);
    expect(selected.selectedTeamWorkflowId).toBe(before.selectedTeamWorkflowId);
    expect(selected.teamRuns).toEqual(before.teamRuns);
    expect(selected.runs).toEqual(before.runs);
    expect(selected.tasks).toEqual(before.tasks);
    expect(selected.terminalLines).toEqual(before.terminalLines);

    const started = prototypeReducer(selected, {
      type: "start-team-run",
    });

    expect(started).toBe(initialPrototypeState);
    expect(started.selectedTeamWorkflowId).toBe(before.selectedTeamWorkflowId);
    expect(started.teamRuns).toEqual(before.teamRuns);
    expect(started.runs).toEqual(before.runs);
    expect(started.tasks).toEqual(before.tasks);
    expect(started.terminalLines).toEqual(before.terminalLines);

    const advanced = prototypeReducer(started, {
      type: "advance-team-run",
    });

    expect(advanced).toBe(initialPrototypeState);
    expect(advanced.selectedTeamWorkflowId).toBe(before.selectedTeamWorkflowId);
    expect(advanced.teamRuns).toEqual(before.teamRuns);
    expect(advanced.runs).toEqual(before.runs);
    expect(advanced.tasks).toEqual(before.tasks);
    expect(advanced.terminalLines).toEqual(before.terminalLines);
  });

  it("routes and acknowledges notifications without changing task or run state", () => {
    const routed = prototypeReducer(
      {
        ...initialPrototypeState,
        selectedTaskId: "task-pty",
      },
      { type: "route-notification" } as never,
    );
    const notificationEvents = (routed as {
      notificationEvents?: Array<{
        id: string;
        taskId: string;
        level: string;
        destination: string;
        acknowledged: boolean;
        evidencePath: string;
      }>;
    }).notificationEvents;

    expect(notificationEvents).toHaveLength(1);
    expect(notificationEvents?.[0]).toMatchObject({
      id: "notification-task-pty-001",
      taskId: "task-pty",
      level: "waiting-input",
      destination: "desktop",
      acknowledged: false,
      evidencePath: ".agent-workspace/notifications/notification-task-pty-001.json",
    });
    expect(routed.tasks).toEqual(initialPrototypeState.tasks);
    expect(routed.runs).toHaveLength(initialPrototypeState.runs.length);
    expect(routed.terminalLines[routed.terminalLines.length - 1]).toBe(
      "notification: routed waiting-input for task-pty to desktop",
    );

    const acknowledged = prototypeReducer(routed, {
      type: "acknowledge-notification",
      eventId: "notification-task-pty-001",
    } as never);
    const acknowledgedEvents = (acknowledged as {
      notificationEvents?: Array<{ acknowledged: boolean }>;
    }).notificationEvents;

    expect(acknowledgedEvents?.[0]?.acknowledged).toBe(true);
    expect(acknowledged.tasks).toEqual(initialPrototypeState.tasks);
    expect(acknowledged.runs).toHaveLength(initialPrototypeState.runs.length);
    expect(acknowledged.terminalLines[acknowledged.terminalLines.length - 1]).toBe(
      "notification: acknowledged notification-task-pty-001",
    );
  });

  it("opens notification context on the right product surface without scheduling side effects", () => {
    const routed = prototypeReducer(
      {
        ...initialPrototypeState,
        activeView: "notifications",
        selectedTaskId: "task-pty",
      },
      { type: "route-notification" } as never,
    );

    const opened = prototypeReducer(routed, {
      type: "open-notification-context",
      eventId: "notification-task-pty-001",
    } as never);

    expect(opened.selectedTaskId).toBe("task-pty");
    expect(opened.activeView).toBe("workbench");
    expect(opened.notificationEvents[0]?.acknowledged).toBe(false);
    expect(opened.tasks).toEqual(routed.tasks);
    expect(opened.runs).toHaveLength(routed.runs.length);
    expect(opened.terminalLines[opened.terminalLines.length - 1]).toBe(
      "notification: opened notification-task-pty-001 in workbench",
    );
  });

  it("opens audit entries back to their source surface without scheduling side effects", () => {
    const withTransition = prototypeReducer(
      {
        ...initialPrototypeState,
        activeView: "audit",
      },
      { type: "advance-task", taskId: "task-review" },
    );

    const openedBoardContext = prototypeReducer(withTransition, {
      type: "open-audit-entry-context",
      entryId: "task-transition-task-review-001",
    } as never);

    expect(openedBoardContext.activeView).toBe("backlog");
    expect(openedBoardContext.selectedTaskId).toBe("task-review");
    expect(openedBoardContext.tasks).toEqual(withTransition.tasks);
    expect(openedBoardContext.runs).toHaveLength(withTransition.runs.length);
    expect(openedBoardContext.terminalLines[openedBoardContext.terminalLines.length - 1]).toBe(
      "audit: opened task-transition-task-review-001 in backlog",
    );

    const withVerification = prototypeReducer(withTransition, {
      type: "run-verification-command",
      taskId: "task-plan-watch",
    } as never);
    const openedReviewContext = prototypeReducer(withVerification, {
      type: "open-audit-entry-context",
      entryId: "verification-run-plan-watc-active-001",
    } as never);

    expect(openedReviewContext.activeView).toBe("review");
    expect(openedReviewContext.selectedTaskId).toBe("task-plan-watch");
    expect(openedReviewContext.tasks).toEqual(withVerification.tasks);
    expect(openedReviewContext.runs).toHaveLength(withVerification.runs.length);
    expect(openedReviewContext.terminalLines[openedReviewContext.terminalLines.length - 1]).toBe(
      "audit: opened verification-run-plan-watc-active-001 in review",
    );

    const openedRunPolicyContext = prototypeReducer(
      {
        ...withVerification,
        activeView: "audit",
        selectedTaskId: "task-review",
      },
      {
        type: "open-audit-entry-context",
        entryId: "run-policy-run-plan-watc-active",
      } as never,
    );

    expect(openedRunPolicyContext.activeView).toBe("runs");
    expect(openedRunPolicyContext.selectedTaskId).toBe("task-plan-watch");
    expect(openedRunPolicyContext.tasks).toEqual(withVerification.tasks);
    expect(openedRunPolicyContext.runs).toEqual(withVerification.runs);
    expect(openedRunPolicyContext.notificationEvents).toEqual(withVerification.notificationEvents);
    expect(openedRunPolicyContext.pullRequestHandoffEvents).toEqual(withVerification.pullRequestHandoffEvents);
    expect(openedRunPolicyContext.terminalLines[openedRunPolicyContext.terminalLines.length - 1]).toBe(
      "audit: opened run-policy-run-plan-watc-active in runs",
    );
  });

  it("captures and restores a workspace session manifest without creating agent runs", () => {
    const captured = prototypeReducer(
      {
        ...initialPrototypeState,
        activeView: "review",
        selectedTaskId: "task-review",
        selectedAgentClusterId: "cluster-agent-workspace-firsttask",
        selectedAgentId: "reviewer",
      },
      { type: "capture-restore-manifest" } as never,
    );
    const manifest = (captured as {
      restoreManifest?: {
        id: string;
        activeView: string;
        selectedTaskId: string;
        selectedAgentClusterId: string;
        selectedAgentId: string;
        manifestPath: string;
        processRecords: Array<{ id: string; processClass: string; commandLine: string; metadataPath: string }>;
      };
    }).restoreManifest;

    expect(manifest).toMatchObject({
      id: "restore-manifest-current",
      activeView: "review",
      selectedTaskId: "task-review",
      selectedAgentClusterId: "cluster-agent-workspace-firsttask",
      selectedAgentId: "reviewer",
      manifestPath: ".agent-workspace/restore/restore-manifest-current.json",
    });
    expect(manifest?.processRecords).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "agent-planner",
          processClass: "agent-pty",
          commandLine: "opencode --model opencode-go/deepseek-v4-flash",
          metadataPath:
            ".agent-workspace/projects/project-agent-workspace/clusters/cluster-agent-workspace-firsttask/sessions/agent-planner.json",
        }),
        expect.objectContaining({
          id: "command-cmd-web",
          processClass: "dev-command",
          commandLine: "npm run dev -- --host 127.0.0.1 --port 5188",
          metadataPath: ".agent-workspace/commands/cmd-web.json",
        }),
      ]),
    );
    expect(captured.tasks).toEqual(initialPrototypeState.tasks);
    expect(captured.runs).toHaveLength(initialPrototypeState.runs.length);
    expect(captured.terminalLines[captured.terminalLines.length - 1]).toBe(
      "restore: captured restore-manifest-current",
    );

    const restored = prototypeReducer(
      {
        ...captured,
        activeView: "restore" as never,
        selectedTaskId: "task-browser",
        selectedAgentId: "qa",
      },
      { type: "restore-workspace-session" } as never,
    );

    expect(restored.activeView).toBe("review");
    expect(restored.selectedTaskId).toBe("task-review");
    expect(restored.selectedAgentId).toBe("reviewer");
    expect(restored.tasks).toEqual(initialPrototypeState.tasks);
    expect(restored.runs).toHaveLength(initialPrototypeState.runs.length);
    expect(restored.terminalLines[restored.terminalLines.length - 1]).toBe(
      "restore: restored restore-manifest-current to review",
    );
  });

  it("captures restore context evidence pointers without changing task or run state", () => {
    const captured = prototypeReducer(
      {
        ...initialPrototypeState,
        activeView: "review",
        selectedTaskId: "task-plan-watch",
        selectedAgentId: "planner",
        browserEvidence: [
          {
            id: "browser-evidence-task-plan-watch-001",
            taskId: "task-plan-watch",
            toolName: "browser_screenshot",
            summary: "browser_screenshot captured screenshot artifact path for planner review",
            artifactPath: ".agent-workspace/browser/task-plan-watch/browser_screenshot-001.json",
            capturedAt: "2026-06-24T13:20:00Z",
          },
        ],
        commitRedactionScans: [
          {
            runId: "run-plan-watc-active",
            status: "passed",
            transcriptPath: ".agent-workspace/runs/run-plan-watc-active/transcript.log",
            artifactPath: ".agent-workspace/runs/run-plan-watc-active/redaction.json",
            redactedPatterns: ["API key", ".env", "token"],
          },
        ],
        mcpToolEvents: [
          {
            id: "mcp-event-browser-screenshot-001",
            taskId: "task-plan-watch",
            serverId: "mcp-browser",
            toolName: "browser_screenshot",
            permission: "confirm",
            status: "confirmation-required",
            evidencePath: "screenshot artifact path",
            targetSurface: "browser",
            summary: "browser_screenshot requested by agent; scheduler confirmation required",
          },
        ],
        teamRuns: [
          {
            id: "team-run-team-research-plan-exec-active",
            workflowId: "team-research-plan-exec",
            status: "blocked",
            activeNodeIndex: 2,
            cycle: 2,
            maxCycles: 2,
            handoffPayload: "source delta, plan step, verification command, completion criteria",
            evidencePath: ".agent-workspace/teams/team-run-team-research-plan-exec-active/handoff.json",
          },
        ],
      },
      { type: "capture-restore-manifest" } as never,
    );
    const contextRecords = (captured as {
      restoreManifest?: {
        contextRecords?: Array<{
          id: string;
          kind: string;
          taskId?: string;
          status: string;
          artifactPath: string;
        }>;
      };
    }).restoreManifest?.contextRecords;

    expect(contextRecords).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "restore-context-run-plan-watc-active",
          kind: "active-run",
          taskId: "task-plan-watch",
          status: "running",
          artifactPath: ".agent-workspace/runs/run-plan-watc-active/transcript.log",
        }),
        expect.objectContaining({
          id: "restore-context-browser-evidence-task-plan-watch-001",
          kind: "browser-evidence",
          taskId: "task-plan-watch",
          status: "captured",
          artifactPath: ".agent-workspace/browser/task-plan-watch/browser_screenshot-001.json",
        }),
        expect.objectContaining({
          id: "restore-context-redaction-run-plan-watc-active",
          kind: "redaction-scan",
          status: "passed",
          artifactPath: ".agent-workspace/runs/run-plan-watc-active/redaction.json",
        }),
        expect.objectContaining({
          id: "restore-context-mcp-event-browser-screenshot-001",
          kind: "mcp-audit",
          status: "confirmation-required",
          artifactPath: "screenshot artifact path",
        }),
        expect.objectContaining({
          id: "restore-context-team-run-team-research-plan-exec-active",
          kind: "team-run",
          status: "blocked",
          artifactPath: ".agent-workspace/teams/team-run-team-research-plan-exec-active/handoff.json",
        }),
      ]),
    );
    expect(captured.tasks).toEqual(initialPrototypeState.tasks);
    expect(captured.runs).toHaveLength(initialPrototypeState.runs.length);
    expect(captured.terminalLines[captured.terminalLines.length - 1]).toBe(
      "restore: captured restore-manifest-current",
    );
  });

  it("switches selected project context without creating runs or moving tasks", () => {
    const switched = prototypeReducer(initialPrototypeState, {
      type: "select-project",
      projectId: "project-opencode-flow",
    } as never);

    expect((switched as { selectedProjectId?: string }).selectedProjectId).toBe("project-opencode-flow");
    expect(switched.tasks).toEqual(initialPrototypeState.tasks);
    expect(switched.runs).toHaveLength(initialPrototypeState.runs.length);
    expect(switched.terminalLines[switched.terminalLines.length - 1]).toBe(
      "project: selected OpenCode Agent Flow",
    );
  });

  it("leaves MCP actions unchanged when real MCP adapters are empty", () => {
    const before = {
      selectedMcpServerId: initialPrototypeState.selectedMcpServerId,
      mcpToolEvents: [...initialPrototypeState.mcpToolEvents],
      runs: [...initialPrototypeState.runs],
      tasks: [...initialPrototypeState.tasks],
      terminalLines: [...initialPrototypeState.terminalLines],
    };
    const selected = prototypeReducer(initialPrototypeState, {
      type: "select-mcp-server",
      serverId: "mcp-browser",
    });

    expect(selected).toBe(initialPrototypeState);
    expect(selected.selectedMcpServerId).toBe(before.selectedMcpServerId);
    expect(selected.mcpToolEvents).toEqual(before.mcpToolEvents);
    expect(selected.runs).toEqual(before.runs);
    expect(selected.tasks).toEqual(before.tasks);
    expect(selected.terminalLines).toEqual(before.terminalLines);

    const requested = prototypeReducer(selected, {
      type: "request-mcp-tool-call",
      serverId: "mcp-backlog",
      toolName: "backlog_update",
    });

    expect(requested).toBe(initialPrototypeState);
    expect(requested.selectedMcpServerId).toBe(before.selectedMcpServerId);
    expect(requested.mcpToolEvents).toEqual(before.mcpToolEvents);
    expect(requested.runs).toEqual(before.runs);
    expect(requested.tasks).toEqual(before.tasks);
    expect(requested.terminalLines).toEqual(before.terminalLines);

    const approved = prototypeReducer(requested, {
      type: "resolve-mcp-tool-call",
      eventId: "mcp-event-backlog-update-001",
      decision: "approved",
    });

    expect(approved).toBe(initialPrototypeState);
    expect(approved.selectedMcpServerId).toBe(before.selectedMcpServerId);
    expect(approved.mcpToolEvents).toEqual(before.mcpToolEvents);
    expect(approved.runs).toEqual(before.runs);
    expect(approved.tasks).toEqual(before.tasks);
    expect(approved.terminalLines).toEqual(before.terminalLines);
  });

  it("keeps terminal diagnostics from driving task state or notifications", () => {
    const next = prototypeReducer(initialPrototypeState, {
      type: "apply-terminal-signal",
      eventId: "terminal-event-run-pty-active-001",
    } as never);
    const task = next.tasks.find((item) => item.id === "task-pty");

    expect(task?.status).toBe("waiting-input");
    expect(next.selectedTaskId).toBe("task-pty");
    expect(next.activeView).toBe("runs");
    expect(next.taskTransitionEvents).toHaveLength(initialPrototypeState.taskTransitionEvents.length);
    expect(next.notificationEvents).toHaveLength(initialPrototypeState.notificationEvents.length);
    expect(next.runs).toHaveLength(initialPrototypeState.runs.length);
    expect(next.reviewApprovalEvents).toHaveLength(initialPrototypeState.reviewApprovalEvents.length);
    expect(next.pullRequestHandoffEvents).toHaveLength(initialPrototypeState.pullRequestHandoffEvents.length);
    expect(next.terminalLines[next.terminalLines.length - 1]).toBe(
      "terminal diagnostics: inspected terminal-event-run-pty-active-001; no task state transition",
    );
  });

  it("keeps terminal completion-looking diagnostics from routing to Review", () => {
    const next = prototypeReducer(initialPrototypeState, {
      type: "apply-terminal-signal",
      eventId: "terminal-event-run-plan-watc-active-003",
    } as never);
    const task = next.tasks.find((item) => item.id === "task-plan-watch");

    expect(task?.status).toBe("running");
    expect(next.selectedTaskId).toBe("task-plan-watch");
    expect(next.activeView).toBe("runs");
    expect(next.taskTransitionEvents).toHaveLength(initialPrototypeState.taskTransitionEvents.length);
    expect(next.notificationEvents).toHaveLength(initialPrototypeState.notificationEvents.length);
    expect(next.runs).toHaveLength(initialPrototypeState.runs.length);
    expect(next.reviewApprovalEvents).toHaveLength(initialPrototypeState.reviewApprovalEvents.length);
    expect(next.pullRequestHandoffEvents).toHaveLength(initialPrototypeState.pullRequestHandoffEvents.length);
    expect(next.terminalLines[next.terminalLines.length - 1]).toBe(
      "terminal diagnostics: inspected terminal-event-run-plan-watc-active-003; no task state transition",
    );
  });

  it("inserts scratchpad context and saves drafts without creating runs or moving tasks", () => {
    const inserted = prototypeReducer(initialPrototypeState, {
      type: "insert-scratchpad-item",
      itemId: "scratchpad-screenshot",
    } as never);

    expect((inserted as { scratchpadAttachmentIds?: string[] }).scratchpadAttachmentIds).toContain(
      "scratchpad-screenshot",
    );
    expect(inserted.prompt).toContain("[Screenshot: localhost flow]");
    expect(inserted.tasks).toEqual(initialPrototypeState.tasks);
    expect(inserted.runs).toHaveLength(initialPrototypeState.runs.length);
    expect(inserted.terminalLines[inserted.terminalLines.length - 1]).toBe(
      "scratchpad: inserted Screenshot: localhost flow",
    );

    const saved = prototypeReducer(inserted, { type: "save-scratchpad-draft" } as never);
    const promptLibrarySaves = (saved as {
      promptLibrarySaves?: Array<{
        id: string;
        taskId: string;
        sourceDraftPath: string;
        targetPath: string;
        artifactPath: string;
        savedAt: string;
      }>;
    }).promptLibrarySaves;

    expect((saved as { scratchpadSavedAt?: string }).scratchpadSavedAt).toBe("2026-06-24T13:40:00Z");
    expect(promptLibrarySaves).toEqual([
      {
        id: "prompt-save-task-plan-watch-001",
        taskId: "task-plan-watch",
        sourceDraftPath: ".agent-workspace/scratchpad/task-plan-watch.md",
        targetPath: ".agent-workspace/prompts.json",
        artifactPath: ".agent-workspace/prompts/task-plan-watch-001.md",
        savedAt: "2026-06-24T13:40:00Z",
      },
    ]);
    expect(saved.tasks).toEqual(initialPrototypeState.tasks);
    expect(saved.runs).toHaveLength(initialPrototypeState.runs.length);
    expect(saved.terminalLines[saved.terminalLines.length - 1]).toBe(
      "scratchpad: saved draft to .agent-workspace/prompts.json",
    );
  });

  it("attaches scratchpad artifacts to the selected task without creating runs or moving tasks", () => {
    const next = prototypeReducer(initialPrototypeState, {
      type: "attach-scratchpad-artifact",
      itemId: "scratchpad-screenshot",
    } as never);

    expect(next.taskArtifacts[0]).toMatchObject({
      id: "task-artifact-task-plan-watch-001",
      taskId: "task-plan-watch",
      kind: "screenshot",
      label: "Screenshot",
      sourceSurface: "workbench",
      sourceArtifactPath: ".agent-workspace/browser/task-browser/browser_screenshot-001.json",
      artifactPath: ".agent-workspace/tasks/task-plan-watch/artifacts/scratchpad-screenshot-001.json",
      addedAt: "2026-06-24T14:10:00Z",
      summary: "Attached Screenshot: localhost flow to task-plan-watch",
    });
    expect(next.tasks).toEqual(initialPrototypeState.tasks);
    expect(next.runs).toHaveLength(initialPrototypeState.runs.length);
    expect(next.terminalLines[next.terminalLines.length - 1]).toBe(
      "task artifact: attached Screenshot to task-plan-watch",
    );
  });

  it("creates planner tasks from docs product-intent watch events without starting runs", () => {
    const next = prototypeReducer(initialPrototypeState, {
      type: "create-planner-task-from-watch",
      eventId: "watch-spec-product-map",
    } as never);
    const createdTask = next.tasks.find((task) => task.id === "task-watch-spec-product-map");
    const watchEvent = (next as { watchEvents?: Array<{ id: string; plannerTaskId?: string; status: string }> })
      .watchEvents?.find((event) => event.id === "watch-spec-product-map");

    expect(createdTask).toMatchObject({
      id: "task-watch-spec-product-map",
      title: "Planner review: product-interaction-map.md",
      status: "queued",
      source: "docs/superworks/spec/product-interaction-map.md",
      owner: "Planner",
    });
    expect(watchEvent).toMatchObject({
      id: "watch-spec-product-map",
      status: "task-created",
      plannerTaskId: "task-watch-spec-product-map",
    });
    expect(next.runs).toHaveLength(initialPrototypeState.runs.length);
    expect(next.activeView).toBe("watcher");
    expect(next.selectedTaskId).toBe("task-watch-spec-product-map");
    expect(next.terminalLines[next.terminalLines.length - 1]).toBe(
      "watcher: created planner task task-watch-spec-product-map from docs/superworks/spec/product-interaction-map.md",
    );
  });

  it("creates running tasks from intake without fabricating runs or bypassing review", () => {
    const next = prototypeReducer(initialPrototypeState, {
      type: "create-task-from-intake",
      title: "Design command palette empty state",
      summary: "Show the empty state for no matching commands.",
      labels: ["ux", "mvp"],
      intakeSource: "prompt-context",
      owner: "",
      templateId: "implementation",
      model: "   ",
      artifactPath: ".agent-workspace/scratchpad/sketches/command-palette-empty.png",
    } as never);
    const createdTask = next.tasks.find((task) => task.id === "task-intake-001") as
      | (typeof initialPrototypeState.tasks[number] & { labels?: string[] })
      | undefined;
    const intakeEvent = (next as { taskIntakeEvents?: Array<Record<string, unknown>> }).taskIntakeEvents?.[0];
    const clusterId = "cluster-project-agent-workspace:task-intake-001";
    const taskCluster = next.agentClusters.find((cluster) => cluster.id === clusterId);
    const selectedProject = next.projects.find((project) => project.id === initialPrototypeState.selectedProjectId);
    const createdAgents = next.agents.filter((agent) => agent.clusterId === clusterId);
    const conductor = createdAgents.find((agent) => agent.name === "Conductor");

    expect(createdTask).toMatchObject({
      id: "task-intake-001",
      title: "Design command palette empty state",
      status: "running",
      source: "Prompt context",
      owner: "Conductor",
      risk: "Conductor auto-started; execution evidence must come from the real PTY session",
      verification: "Conductor terminal starts from intake and records task context",
      summary: "Show the empty state for no matching commands.",
      labels: ["ux", "mvp"],
      templateId: "implementation",
    });
    expect(createdTask?.runtimeTaskId).toMatch(/^task-[a-z0-9]{6}$/);
    expect(intakeEvent).toMatchObject({
      id: "task-intake-event-001",
      taskId: "task-intake-001",
      source: "prompt-context",
      title: "Design command palette empty state",
      labels: ["ux", "mvp"],
      owner: "Conductor",
      templateId: "implementation",
      artifactPath: ".agent-workspace/scratchpad/sketches/command-palette-empty.png",
      evidencePath: ".agent-workspace/tasks/intake.jsonl",
      status: "queued",
      createdAt: "2026-06-24T14:45:00Z",
    });
    expect(intakeEvent?.runtimeTaskId).toBe(createdTask?.runtimeTaskId);
    expect(taskCluster).toMatchObject({
      id: clusterId,
      projectId: "project-agent-workspace",
      name: "Design command palette empty state",
      level: "task",
      taskId: "task-intake-001",
      parentClusterId: "cluster-agent-workspace-firsttask",
      agentIds: ["task-intake-001-conductor", "task-intake-001-executor", "task-intake-001-qa"],
      evidencePath: ".agent-workspace/tasks/task-intake-001/cluster.json",
    });
    expect(taskCluster?.runtimeTaskId).toBe(createdTask?.runtimeTaskId);
    expect(createdAgents.map((agent) => agent.name)).toEqual(["Conductor", "Executor", "QA"]);
    expect(createdAgents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "task-intake-001-conductor",
          provider: "opencode",
          model: "opencode-go/deepseek-v4-flash",
          status: "idle",
          taskId: "task-intake-001",
          runtimeTaskId: createdTask?.runtimeTaskId,
          lastActive: "not started",
        }),
        expect.objectContaining({
          id: "task-intake-001-executor",
          provider: "opencode",
          model: "opencode-go/deepseek-v4-flash",
          status: "idle",
          taskId: "task-intake-001",
          runtimeTaskId: createdTask?.runtimeTaskId,
          lastActive: "not started",
        }),
      ]),
    );
    expect(selectedProject?.taskIds).toContain("task-intake-001");
    expect(selectedProject?.agentClusterIds).toContain(clusterId);
    expect(selectedProject?.agentIds).toEqual(
      expect.arrayContaining(["task-intake-001-conductor", "task-intake-001-executor", "task-intake-001-qa"]),
    );
    expect(next.selectedTaskId).toBe("task-intake-001");
    expect(next.selectedAgentClusterId).toBe(clusterId);
    expect(next.selectedAgentId).toBe(conductor?.id);
    expect(next.activeView).toBe("backlog");
    expect(next.runs).toHaveLength(initialPrototypeState.runs.length);
    expect(next.runs.some((run) => run.taskId === "task-intake-001")).toBe(false);
    expect(next.runs.some((run) => run.id.startsWith("mock-run"))).toBe(false);
    expect(next.loopScheduleEvents).toHaveLength(initialPrototypeState.loopScheduleEvents.length);
    expect(next.reviewApprovalEvents).toHaveLength(initialPrototypeState.reviewApprovalEvents.length);
    expect(next.terminalLines[next.terminalLines.length - 1]).toBe(
      "task intake: captured task-intake-001 from prompt-context; created 代码实现任务 agent sessions",
    );
  });

  it("uses the confirmed session plan when creating task agents from intake", () => {
    const next = prototypeReducer(initialPrototypeState, {
      type: "create-task-from-intake",
      title: "Research with two independent researchers",
      summary: "Two research sessions collect evidence before review.",
      labels: ["research"],
      intakeSource: "manual-brief",
      owner: "Conductor",
      templateId: "research",
      model: "opencode-go/deepseek-v4-flash",
      sessionPlan: {
        templateId: "research",
        defaultModel: "opencode-go/deepseek-v4-flash",
        conductor: {
          idSeed: "conductor",
          name: "Conductor",
          role: "Research coordinator",
        },
        workers: [
          {
            idSeed: "researcher-a",
            name: "Researcher A",
            role: "Official docs evidence",
          },
          {
            idSeed: "researcher-b",
            name: "Researcher B",
            role: "Ecosystem comparison",
          },
          {
            idSeed: "reviewer",
            name: "Reviewer",
            role: "Source challenge",
          },
        ],
        routePolicy: {
          allowedTargets: ["Researcher A", "Researcher B", "Reviewer"],
        },
      },
    });
    const createdTask = next.tasks.find((task) => task.id === "task-intake-001");
    const createdAgents = next.agents.filter((agent) => agent.clusterId === "cluster-project-agent-workspace:task-intake-001");

    expect(createdTask?.sessionPlan?.workers.map((worker) => worker.name)).toEqual([
      "Researcher A",
      "Researcher B",
      "Reviewer",
    ]);
    expect(createdAgents.map((agent) => agent.id)).toEqual([
      "task-intake-001-conductor",
      "task-intake-001-researcher-a",
      "task-intake-001-researcher-b",
      "task-intake-001-reviewer",
    ]);
    expect(next.taskIntakeEvents[0]?.sessionPlan?.routePolicy?.allowedTargets).toEqual([
      "Researcher A",
      "Researcher B",
      "Reviewer",
    ]);
  });

  it("keeps runtime task ids unique when two opened projects both create display task-intake-001", () => {
    const firstRuntimeState = createRuntimeWorkspaceState({
      projectName: "Agent_Test",
      projectPath: "/Users/dinker/CODES/TEMP_project/Agent_Test",
    });
    const secondRuntimeState = createRuntimeWorkspaceState({
      projectName: "Agent_Test",
      projectPath: "/Users/dinker/CODES/TEMP_project/Agent_Test",
    });

    const first = prototypeReducer(firstRuntimeState, {
      type: "create-task-from-intake",
      title: "Research A",
      summary: "First opened app task.",
      labels: [],
      intakeSource: "manual-brief",
      owner: "Conductor",
      templateId: "research",
      model: "opencode-go/deepseek-v4-flash",
    });
    const second = prototypeReducer(secondRuntimeState, {
      type: "create-task-from-intake",
      title: "Research B",
      summary: "Second opened app task.",
      labels: [],
      intakeSource: "manual-brief",
      owner: "Conductor",
      templateId: "research",
      model: "opencode-go/deepseek-v4-flash",
    });
    const firstTask = first.tasks.find((task) => task.id === "task-intake-001");
    const secondTask = second.tasks.find((task) => task.id === "task-intake-001");

    expect(firstTask?.id).toBe("task-intake-001");
    expect(secondTask?.id).toBe("task-intake-001");
    expect(first.projects[0]?.runtimeProjectId).toBe(second.projects[0]?.runtimeProjectId);
    expect(firstTask?.runtimeTaskId).toMatch(/^task-[a-z0-9]{6}$/);
    expect(secondTask?.runtimeTaskId).toMatch(/^task-[a-z0-9]{6}$/);
    expect(firstTask?.runtimeTaskId).not.toBe(secondTask?.runtimeTaskId);
    expect(first.agents.every((agent) => agent.runtimeTaskId === firstTask?.runtimeTaskId)).toBe(true);
    expect(second.agents.every((agent) => agent.runtimeTaskId === secondTask?.runtimeTaskId)).toBe(true);
  });

  it("creates intake ids from the max existing task and intake event suffix", () => {
    const stateWithExistingIntake = {
      ...initialPrototypeState,
      tasks: [
        ...initialPrototypeState.tasks,
        {
          ...initialPrototypeState.tasks[0],
          id: "task-intake-001",
          title: "Existing intake task",
        },
      ],
      taskIntakeEvents: [
        {
          id: "task-intake-event-004",
          taskId: "task-archived-intake",
          source: "manual-brief" as const,
          title: "Archived intake event",
          summary: "Existing event suffix from durable intake history.",
          labels: [],
          owner: "Conductor",
          evidencePath: ".agent-workspace/tasks/intake.jsonl",
          status: "queued" as const,
          createdAt: "2026-06-24T14:45:00Z",
        },
      ],
    };

    const next = prototypeReducer(stateWithExistingIntake, {
      type: "create-task-from-intake",
      title: "Avoid duplicate intake ids",
      summary: "Use the next available max suffix.",
      labels: [],
      intakeSource: "manual-brief",
      owner: "Conductor",
      templateId: "research",
      model: "opencode-go/deepseek-v4-flash",
    });

    expect(next.tasks.filter((task) => task.id === "task-intake-001")).toHaveLength(1);
    expect(next.tasks.find((task) => task.id === "task-intake-005")).toMatchObject({
      id: "task-intake-005",
      title: "Avoid duplicate intake ids",
      owner: "Conductor",
      templateId: "research",
    });
    expect(next.taskIntakeEvents[next.taskIntakeEvents.length - 1]).toMatchObject({
      id: "task-intake-event-005",
      taskId: "task-intake-005",
      templateId: "research",
    });
    expect(next.selectedTaskId).toBe("task-intake-005");
    expect(next.selectedAgentClusterId).toBe("cluster-project-agent-workspace:task-intake-005");
    expect(next.agents.map((agent) => agent.id)).toEqual(
      expect.arrayContaining([
        "task-intake-005-conductor",
        "task-intake-005-researcher",
        "task-intake-005-reviewer",
      ]),
    );
  });

  it("adds an idle agent profile to the selected project without creating runs or moving tasks", () => {
    const next = prototypeReducer(initialPrototypeState, {
      type: "add-agent-from-template",
      templateId: "agent-template-architect",
    } as never);
    const addedAgent = next.agents.find((agent) => agent.id === "agent-architect-001");
    const selectedProject = next.projects.find((project) => project.id === initialPrototypeState.selectedProjectId);
    const profileEvent = next.agentProfileEvents[0];

    expect(addedAgent).toMatchObject({
      id: "agent-architect-001",
      name: "Architecture reviewer",
      role: "Architecture review",
      provider: "opencode",
      model: "opencode-go/deepseek-v4-flash",
      status: "idle",
      taskId: initialPrototypeState.selectedTaskId,
    });
    expect(profileEvent).toMatchObject({
      id: "agent-profile-agent-architect-001",
      projectId: "project-agent-workspace",
      agentId: "agent-architect-001",
      templateId: "agent-template-architect",
      systemPromptPath: ".agent-workspace/agents/templates/architecture-reviewer.md",
      worktreePolicy: "shared",
      manifestPath: ".agent-workspace/agents/agent-architect-001.json",
      createdAt: "2026-06-24T13:55:00Z",
      summary: "Created Architecture reviewer profile for Agent Workspace",
    });
    expect(selectedProject?.agentIds).toContain("agent-architect-001");
    expect(next.selectedAgentId).toBe("agent-architect-001");
    expect(next.activeView).toBe("workbench");
    expect(next.tasks).toEqual(initialPrototypeState.tasks);
    expect(next.runs).toHaveLength(initialPrototypeState.runs.length);
    expect(next.terminalLines[next.terminalLines.length - 1]).toBe(
      "agent setup: added Architecture reviewer to Agent Workspace; PTY pending",
    );
  });
});

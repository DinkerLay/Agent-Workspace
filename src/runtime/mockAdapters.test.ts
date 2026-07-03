import { describe, expect, it } from "vitest";
import { createMockRuntimeAdapters, getRuntimeAdapterCards } from "./mockAdapters";

describe("mock runtime adapters", () => {
  it("creates and updates run records through the run store boundary", () => {
    const adapters = createMockRuntimeAdapters();

    const run = adapters.runStore.createRun({
      agentId: "reviewer",
      taskId: "task-review",
      title: "按 Agent 归因 changed files 并保存 commit context",
    });
    adapters.runStore.appendTranscript(run.id, "Reviewer: captured scoped diff");
    adapters.runStore.attachVerification(run.id, {
      command: "npm test",
      logPath: `.agent-workspace/runs/${run.id}/verification.log`,
      status: "passed",
      summary: "Unit tests passed in mock runtime.",
    });

    expect(run).toMatchObject({
      id: "mock-run-task-review-001",
      agentId: "reviewer",
      taskId: "task-review",
      status: "running",
      worktreeContext: {
        isolationPolicy: "isolated",
        branchName: "agent/reviewer/task-review",
        worktreePath: ".agent-workspace/worktrees/task-review-reviewer",
        baselineManifestPath: ".agent-workspace/runs/mock-run-task-review-001/worktree.json",
      },
      runtimePolicy: {
        permissionMode: "ask-before-write",
        sandboxMode: "workspace-write",
        effort: "medium",
        cliCommand: "opencode --model opencode-go/deepseek-v4-flash",
        policyPath: ".agent-workspace/runs/mock-run-task-review-001/policy.json",
      },
      transcriptPath: ".agent-workspace/runs/mock-run-task-review-001/transcript.log",
      diffPath: ".agent-workspace/runs/mock-run-task-review-001/diff.patch",
    });
    expect(adapters.runStore.getRun(run.id)?.transcriptPreview).toContain(
      "Reviewer: captured scoped diff",
    );
    expect(adapters.runStore.getRun(run.id)?.verification.status).toBe("passed");
  });

  it("models PTY lifecycle separately from dev command sessions", () => {
    const adapters = createMockRuntimeAdapters();

    const session = adapters.ptyService.spawn({
      agentId: "executor",
      command: "codex",
      cwd: "/Users/dinker/CODES/Agent-Workspace",
      runId: "mock-run-task-pty-001",
    });
    adapters.ptyService.write(session.id, "实现当前 plan step");
    adapters.ptyService.resize(session.id, { cols: 120, rows: 34 });
    adapters.ptyService.stop(session.id);

    expect(session).toMatchObject({
      id: "pty-executor-001",
      kind: "agent",
      status: "running",
      cols: 100,
      rows: 30,
    });
    expect(adapters.ptyService.getSession(session.id)).toMatchObject({
      status: "stopped",
      cols: 120,
      rows: 34,
      transcript: ["$ codex", "> 实现当前 plan step"],
    });
  });

  it("captures git baseline and builds commit proposals with run metadata", () => {
    const adapters = createMockRuntimeAdapters();

    const baseline = adapters.gitService.captureBaseline("mock-run-task-review-001");
    const attribution = adapters.gitService.changedFilesForRun("mock-run-task-review-001", [
      "src/review/commit-context.ts",
      "src/tasks/backlog-store.ts",
    ]);
    const proposal = adapters.gitService.buildCommitProposal({
      runId: "mock-run-task-review-001",
      taskId: "task-review",
      title: "按 Agent 归因 changed files 并保存 commit context",
      verification: "passed",
    });

    expect(baseline).toEqual({ runId: "mock-run-task-review-001", sha: "abc1234" });
    expect(attribution.every((file) => file.runId === "mock-run-task-review-001")).toBe(true);
    expect(proposal.message).toContain("Agent-Run: mock-run-task-review-001");
    expect(proposal.message).toContain("Verification: passed");
  });

  it("turns durable intent file changes into planner task inputs", () => {
    const adapters = createMockRuntimeAdapters();

    const events = adapters.filesystemWatch.emitChanges([
      "docs/research/agentsroom-research-2026-06-24.zh.md",
      "docs/superworks/spec/product-interaction-map.md",
      "docs/superworks/plans/archive/prototype-capability-map.plan.md",
      "src/App.tsx",
    ]);
    const plannerTasks = adapters.filesystemWatch.createPlannerTasks(events);

    expect(events.map((event) => event.kind)).toEqual(["research", "spec", "ignored", "ignored"]);
    expect(plannerTasks).toEqual([
      {
        id: "planner-task-research-spec-plan",
        changedPaths: [
          "docs/research/agentsroom-research-2026-06-24.zh.md",
          "docs/superworks/spec/product-interaction-map.md",
        ],
        prompt: "Review durable product intent changes and update the executable plan.",
      },
    ]);
  });

  it("exposes adapter readiness cards for the product UI", () => {
    expect(getRuntimeAdapterCards().map((card) => card.id)).toEqual([
      "run-store",
      "pty-service",
      "git-service",
      "filesystem-watch",
    ]);
    expect(getRuntimeAdapterCards().every((card) => card.mode === "mocked")).toBe(true);
  });
});

import { describe, expect, it } from "vitest";
import { initialPrototypeState } from "../mock/prototypeData";
import { getActiveRunForTask, prototypeReducer } from "../lib/taskMachine";
import { createMockRuntimeAdapters } from "./mockAdapters";
import { startTaskRun } from "./taskOrchestrator";

describe("task runtime orchestration", () => {
  it("starts a task run through run-store, PTY, and git adapters", () => {
    const adapters = createMockRuntimeAdapters();
    const action = startTaskRun(initialPrototypeState, "task-review", adapters);
    const next = prototypeReducer(initialPrototypeState, action);
    const activeRun = getActiveRunForTask(next.runs, "task-review");

    expect(action.type).toBe("runtime-started-agent");
    expect(next.activeView).toBe("workbench");
    expect(next.selectedTaskId).toBe("task-review");
    expect(next.selectedAgentId).toBe("reviewer");
    expect(next.tasks.find((task) => task.id === "task-review")?.status).toBe("running");
    expect(activeRun).toMatchObject({
      id: "mock-run-task-review-001",
      taskId: "task-review",
      agentId: "reviewer",
      status: "running",
      startGitSha: "abc1234",
      transcriptPath: ".agent-workspace/runs/mock-run-task-review-001/transcript.log",
      diffPath: ".agent-workspace/runs/mock-run-task-review-001/diff.patch",
      runtimePolicy: {
        permissionMode: "ask-before-write",
        sandboxMode: "workspace-write",
        effort: "medium",
        cliCommand: "opencode --model opencode-go/deepseek-v4-flash",
        policyPath: ".agent-workspace/runs/mock-run-task-review-001/policy.json",
      },
    });
    expect(next.runtimeEvents.slice(-3).map((event) => event.service)).toEqual([
      "run-store",
      "pty-service",
      "git-service",
    ]);
    expect(next.runtimeEvents.slice(-3).map((event) => event.summary)).toEqual([
      "created mock-run-task-review-001 for task-review",
      "spawned pty-reviewer-001 for reviewer",
      "captured baseline abc1234 for mock-run-task-review-001",
    ]);
    expect(next.loopScheduleEvents[0]).toMatchObject({
      id: "loop-schedule-task-review-001",
      taskId: "task-review",
      agentId: "reviewer",
      runId: "mock-run-task-review-001",
      decision: "start-agent",
      rule: "Loop queue Start Agent",
      evidencePath: ".agent-workspace/loops/events.jsonl",
      createdAt: "2026-06-24T14:05:00Z",
      summary: "Loop scheduled reviewer for task-review via Start Agent",
    });
    expect(next.terminalLines.slice(-4)).toEqual([
      "runtime: run-store.createRun -> mock-run-task-review-001",
      "runtime: pty-service.spawn -> pty-reviewer-001",
      "runtime: git-service.captureBaseline -> abc1234",
      "scheduler: started Reviewer for 按 Agent 归因 changed files 并保存 commit context",
    ]);
  });

  it("returns a no-op action when the task does not exist", () => {
    const adapters = createMockRuntimeAdapters();

    expect(startTaskRun(initialPrototypeState, "missing-task", adapters)).toEqual({
      type: "runtime-start-failed",
      reason: "Task missing-task not found",
    });
  });
});

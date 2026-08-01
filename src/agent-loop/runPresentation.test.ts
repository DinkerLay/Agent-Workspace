import { describe, expect, it } from "vitest";
import type { NativeAgentLoopRunDetail } from "../runtime/nativeBridge";
import { nativeTerminalEmptyState, workbenchActivity } from "./runPresentation";

function runFixture(overrides: Partial<NativeAgentLoopRunDetail> = {}): NativeAgentLoopRunDetail {
  return {
    task: {
      taskId: "task-1",
      projectId: "project-1",
      cwd: "/tmp/project",
      title: "状态投影",
      goal: "显示真实的 Runtime 状态。",
      status: "running",
      revision: 1,
      architecture: {
        primaryMode: "agent_loop",
        template: {
          id: "template-1",
          name: "Template",
          version: 1,
          conductor: { role: "Conductor", model: "model" },
          agents: [],
          limits: { maxConcurrentSessions: 1, maxDispatchesPerDecision: 1 },
          delivery: { artifactPath: "", ownerAgentId: "" },
        },
        defaultModel: "model",
        agentCards: [],
        delivery: { artifactPath: "", ownerAgentId: "" },
      },
      createdAt: "2026-07-28T00:00:00.000Z",
      updatedAt: "2026-07-28T00:00:00.000Z",
    },
    run: { runId: "run-1", taskId: "task-1", status: "running", conductorSessionId: "conductor", revision: 1, createdAt: "2026-07-28T00:00:00.000Z", updatedAt: "2026-07-28T00:00:00.000Z" },
    instances: [],
    turns: [],
    artifacts: [],
    attentions: [],
    events: [],
    runtimeState: { taskId: "task-1", cursor: 0, sessions: [], dispatches: [], results: [], messages: [], pendingDecisions: [] },
    workbenchLayout: { version: 1, root: { type: "leaf", groupId: "primary" }, groups: { primary: { id: "primary", sessionIds: [] } }, focusedGroupId: "primary" },
    ...overrides,
  };
}

describe("Agent Loop run presentation", () => {
  it("shows result inbox work as waiting for Conductor instead of active execution", () => {
    const run = runFixture({
      attentions: [
        { type: "worker_result_available", sessionId: "worker-a" },
        { type: "worker_result_available", sessionId: "worker-b" },
      ],
    });

    expect(workbenchActivity(run, { activeDispatchCount: 0, liveTerminalCount: 0 })).toMatchObject({
      label: "待 Conductor 处理结果",
      shortLabel: "待处理",
      tone: "attention",
      attentionCount: 2,
    });
  });

  it("does not present a completed dispatched Session as never started", () => {
    const run = runFixture({
      turns: [{
        turnId: "run-1:worker",
        runId: "run-1",
        instanceId: "run-1",
        nodeId: "worker",
        sessionId: "worker",
        purpose: "session_agent",
        status: "succeeded",
        terminalStatus: "not_live",
        dispatchStatus: "result_available",
        details: { card: { id: "worker", name: "Worker", kind: "general", role: "Worker", model: "model", mcp: [], skills: [], instructions: "", expectedOutput: "" }, dispatches: [] },
      }],
    });

    expect(nativeTerminalEmptyState(run.turns[0])).toMatchObject({
      emptyTitle: "原生 Session 已完成",
    });
  });
});

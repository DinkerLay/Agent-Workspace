import { describe, expect, it } from "vitest";
import { agentRuntimeRecoveryActions, createAgentRuntimeView } from "./agentRuntimeState";
import type { Agent, Project, Task } from "../types";
import type { ReadTaskStateResult } from "../orchestration/conductor-tools";
import { createOpencodeSessionKey, getProjectRuntimeId, getTaskRuntimeId } from "../runtime/opencode";

describe("agent runtime state projection", () => {
  it("labels a delivery failure with retained result context", () => {
    const project: Pick<Project, "id" | "runtimeProjectId"> = {
      id: "project-1",
      runtimeProjectId: "project-runtime-1",
    };
    const task: Pick<Task, "id" | "runtimeTaskId"> = {
      id: "task-1",
      runtimeTaskId: "task-runtime-1",
    };
    const agent: Agent = {
      id: "researcher",
      projectId: "project-1",
      clusterId: "cluster-1",
      name: "Researcher",
      role: "Evidence collector",
      provider: "opencode",
      model: "opencode-go/deepseek-v4-flash",
      status: "idle",
      taskId: "task-1",
      accent: "#2563eb",
      lastActive: "2026-07-08T00:00:00.000Z",
    };
    const sessionId = createOpencodeSessionKey({
      projectId: getProjectRuntimeId(project),
      taskId: getTaskRuntimeId(task),
      agentId: agent.id,
    });
    const taskRuntimeState: ReadTaskStateResult = {
      taskId: "task-runtime-1",
      cursor: 7,
      events: [],
      sessions: [
        {
          sessionId,
          state: "delivery_failed",
          cursor: 7,
          lastResultId: "result-A1B2C3",
          resultCount: 1,
          unresolvedFailureDispatchId: "D4E5F6",
          attentionHints: ["delivery_failed", "result_available"],
          assignmentReadinessHint: "ready",
        },
      ],
      dispatches: [],
      results: [],
      messages: [],
      pendingDecisions: [],
    };

    const view = createAgentRuntimeView({ agent, project, task, taskRuntimeState });

    expect(view.state).toBe("delivery_failed");
    expect(view.label).toBe("Delivery failed · result available");
    expect(view.assignmentReadinessHint).toBe("ready");
  });

  it("offers normal retry plus confirmed recovery actions for retryable delivery failures", () => {
    const actions = agentRuntimeRecoveryActions({
      state: "delivery_failed",
      assignmentReadinessHint: "ready",
      lastResultId: "result-A1B2C3",
      resultCount: 1,
      unresolvedFailureDispatchId: "D4E5F6",
      attentionHints: ["delivery_failed", "result_available"],
    });

    expect(actions.map((action) => action.id)).toEqual([
      "retry_delivery",
      "stop_then_retry",
      "restart_fresh_then_retry",
      "force_retry",
    ]);
    expect(actions.find((action) => action.id === "retry_delivery")?.requiresConfirmation).toBe(false);
    expect(actions.find((action) => action.id === "restart_fresh_then_retry")?.requiresConfirmation).toBe(true);
    expect(actions.every((action) => action.requiresFailedDispatch)).toBe(true);
  });

  it("does not offer an unconfirmed normal retry for pure delivery failures", () => {
    const actions = agentRuntimeRecoveryActions({
      state: "delivery_failed",
      assignmentReadinessHint: "not_ready",
      resultCount: 0,
      unresolvedFailureDispatchId: "D4E5F6",
      attentionHints: ["delivery_failed"],
    });

    expect(actions.map((action) => action.id)).toEqual([
      "stop_then_retry",
      "restart_fresh_then_retry",
      "force_retry",
    ]);
    expect(actions.every((action) => action.requiresConfirmation)).toBe(true);
  });
});

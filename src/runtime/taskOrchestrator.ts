import { getAgentForTask } from "../lib/taskMachine";
import { commandForAgent } from "../lib/runtimePolicy";
import type { PrototypeAction, PrototypeState, RuntimeEvent } from "../types";
import type { RuntimeAdapters } from "./contracts";

export function startTaskRun(
  state: PrototypeState,
  taskId: string,
  adapters: RuntimeAdapters,
): PrototypeAction {
  const task = state.tasks.find((item) => item.id === taskId);
  if (!task) {
    return {
      type: "runtime-start-failed",
      reason: `Task ${taskId} not found`,
    };
  }

  const agent = getAgentForTask(state.agents, task);
  const agentId = agent?.id ?? state.selectedAgentId;
  const run = adapters.runStore.createRun({
    agentId,
    taskId: task.id,
    title: task.title,
  });
  const session = adapters.ptyService.spawn({
    agentId,
    command: commandForAgent(agentId),
    cwd: "/Users/dinker/CODES/Agent-Workspace",
    runId: run.id,
  });
  const baseline = adapters.gitService.captureBaseline(run.id);

  return {
    type: "runtime-started-agent",
    taskId: task.id,
    agentId,
    run: {
      ...run,
      startGitSha: baseline.sha,
    },
    terminalLines: [
      `runtime: run-store.createRun -> ${run.id}`,
      `runtime: pty-service.spawn -> ${session.id}`,
      `runtime: git-service.captureBaseline -> ${baseline.sha}`,
      `scheduler: started ${task.owner} for ${task.title}`,
    ],
    runtimeEvents: [
      {
        id: `event-${run.id}-run-store`,
        service: "run-store",
        action: "createRun",
        summary: `created ${run.id} for ${task.id}`,
        evidence: run.promptPath,
      },
      {
        id: `event-${run.id}-pty`,
        service: "pty-service",
        action: "spawn",
        summary: `spawned ${session.id} for ${agentId}`,
        evidence: session.cwd,
      },
      {
        id: `event-${run.id}-git`,
        service: "git-service",
        action: "captureBaseline",
        summary: `captured baseline ${baseline.sha} for ${run.id}`,
        evidence: run.diffPath,
      },
    ] satisfies RuntimeEvent[],
  };
}

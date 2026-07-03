import type { WorktreeContext } from "../types";

export const workspaceRootPath = "/Users/dinker/CODES/Agent-Workspace";

export function createRunWorktreeContext({
  agentId,
  runId,
  taskId,
}: {
  agentId: string;
  runId: string;
  taskId: string;
}): WorktreeContext {
  const isolationPolicy: WorktreeContext["isolationPolicy"] =
    agentId === "executor" || agentId === "reviewer" ? "isolated" : "shared";

  return {
    isolationPolicy,
    branchName: isolationPolicy === "isolated" ? `agent/${agentId}/${taskId}` : "feature/agent-workspace-mvp",
    worktreePath: isolationPolicy === "isolated" ? `.agent-workspace/worktrees/${taskId}-${agentId}` : workspaceRootPath,
    baselineManifestPath: `.agent-workspace/runs/${runId}/worktree.json`,
  };
}

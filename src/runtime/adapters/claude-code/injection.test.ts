import { describe, expect, it } from "vitest";
import type { Agent } from "../../../types";
import { buildClaudeCodeWorkerLaunch } from "./injection";

const worker: Agent = {
  id: "task-1-reviewer",
  projectId: "project-agent-test",
  clusterId: "cluster-task",
  taskId: "task-1",
  name: "Reviewer",
  role: "Source challenge",
  provider: "claude-code",
  model: "sonnet",
  status: "idle",
  accent: "#be123c",
  lastActive: "not started",
};

describe("claude code worker launch", () => {
  it("does not build Agent Workspace injection for provider-native worker launch", () => {
    const result = buildClaudeCodeWorkerLaunch({ agent: worker });

    expect(result.args).toEqual([]);
    expect(result.files).toEqual([]);
    expect(result.agentName).toBe("");
    expect(JSON.stringify(result)).not.toContain("AGENT_WORKSPACE");
    expect(JSON.stringify(result)).not.toContain("Workspace Session Message");
    expect(JSON.stringify(result)).not.toContain("emit exactly one structured message block");
  });
});

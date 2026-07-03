import { describe, expect, it } from "vitest";
import type { Agent } from "../../../types";
import { buildOpenCodeWorkerLaunch } from "./injection";

const worker: Agent = {
  id: "task-1-researcher",
  projectId: "project-agent-test",
  clusterId: "cluster-task",
  taskId: "task-1",
  name: "Researcher",
  role: "Evidence collector",
  provider: "opencode",
  model: "opencode-go/deepseek-v4-flash",
  status: "idle",
  accent: "#2563eb",
  lastActive: "not started",
};

describe("opencode worker launch", () => {
  it("does not build Agent Workspace injection for provider-native worker launch", () => {
    const result = buildOpenCodeWorkerLaunch({ agent: worker });

    expect(result.runtimeFiles).toEqual([]);
    expect(result.env).toEqual({});
    expect(result.agentName).toBe("");
    expect(result.args).toEqual(["--model", "opencode-go/deepseek-v4-flash"]);
    expect(JSON.stringify(result)).not.toContain("AGENT_WORKSPACE");
    expect(JSON.stringify(result)).not.toContain("Workspace Session Message");
    expect(JSON.stringify(result)).not.toContain("emit exactly one structured message block");
  });
});

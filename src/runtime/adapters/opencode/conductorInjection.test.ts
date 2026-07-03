import { describe, expect, it } from "vitest";
import { buildOpenCodeConductorInjection } from "./conductorInjection";

describe("OpenCode Conductor injection", () => {
  it("adds MCP bridge only for Conductor and does not create worker protocol prompt", () => {
    const result = buildOpenCodeConductorInjection({
      projectPath: "/repo",
      taskId: "task-1",
      taskTitle: "Research task",
      taskGoal: "Research and summarize.",
      model: "opencode-go/deepseek-v4-flash",
      workerTargets: ["Researcher"],
      workerSessions: [{ id: "task-1-researcher", name: "Researcher", role: "Evidence collector" }],
      bridgeUrl: "http://127.0.0.1:3456",
      bridgeToken: "token",
      mcpServerPath: "/repo/desktop/conductor-mcp-server.cjs",
    });

    expect(result).not.toHaveProperty("agentName");
    expect(JSON.stringify(result.env)).toContain("AGENT_WORKSPACE_TOOL_BRIDGE_URL");
    expect(JSON.stringify(result.env)).toContain("AGENT_WORKSPACE_TOOL_BRIDGE_TOKEN");
    expect(result.files.map((file) => file.relativePath)).toContain(".agent-workspace/runtime/task-1/conductor/system.md");
    expect(JSON.stringify(result.env)).toContain("OPENCODE_CONFIG_CONTENT");
    expect(JSON.stringify(result.env)).toContain("agent_workspace_conductor");
    expect(result.files.map((file) => file.contents).join("\n")).not.toContain("Workspace Session Message");
  });
});

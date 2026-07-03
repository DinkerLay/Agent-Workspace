import { describe, expect, it } from "vitest";
import { buildClaudeCodeConductorInjection } from "./conductorInjection";

describe("Claude Code Conductor injection", () => {
  it("uses mcp config and append-system-prompt for Conductor", () => {
    const result = buildClaudeCodeConductorInjection({
      projectPath: "/repo",
      taskId: "task-1",
      taskTitle: "Research task",
      taskGoal: "Research and summarize.",
      model: "sonnet",
      workerTargets: ["Researcher"],
      workerSessions: [{ id: "task-1-researcher", name: "Researcher", role: "Evidence collector" }],
      bridgeUrl: "http://127.0.0.1:3456",
      bridgeToken: "token",
      mcpServerPath: "/repo/desktop/conductor-mcp-server.cjs",
    });

    expect(result.args).toContain("--append-system-prompt");
    expect(result.args).toContain("--mcp-config");
    expect(result.files.map((file) => file.relativePath)).toContain(".agent-workspace/runtime/task-1/conductor/claude-mcp.json");
    expect(result.args.join(" ")).not.toContain("Workspace Session Message");
  });
});

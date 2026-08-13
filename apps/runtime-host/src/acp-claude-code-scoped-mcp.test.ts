import { describe, expect, it } from "vitest";
import { createClaudeCodeAcpScopedMcpRole } from "./acp-claude-code-scoped-mcp.js";

describe("Claude Code ACP scoped MCP role", () => {
  it("projects the exact Agent Workspace MCP tools only for Conductor", async () => {
    const conductor = createClaudeCodeAcpScopedMcpRole({
      role: "conductor",
      serverName: "agent_workspace_conductor",
      mcpLeaseId: "mcp_lease_conductor",
    });
    expect(conductor.registration?.tools.map(({ name }) => name)).toEqual([
      "invoke_agent",
      "send_to_session",
      "interrupt_session",
      "close_session",
    ]);
    await conductor.close();
  });

  it("exposes no Agent Workspace MCP registration for ordinary Task roles", async () => {
    for (const role of ["publisher", "worker", "reviewer"] as const) {
      const scoped = createClaudeCodeAcpScopedMcpRole({ role });
      expect(scoped.registration).toBeUndefined();
      expect(scoped.createReverseRpcRegistration()).toBeUndefined();
      await scoped.close();
    }
  });
});

/**
 * @vitest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { mcpServers } from "../mock/capabilityData";
import { McpGateway } from "./McpGateway";

describe("McpGateway", () => {
  it("shows agent-facing MCP surfaces and switches selected server", () => {
    const selectedServers: string[] = [];
    const requestedTools: Array<{ serverId: string; toolName: string }> = [];
    const resolvedEvents: Array<{ eventId: string; decision: "approved" | "denied" }> = [];

    render(
      <McpGateway
        servers={mcpServers}
        selectedServerId="mcp-backlog"
        toolEvents={[
          {
            id: "mcp-event-backlog-update-001",
            taskId: "task-plan-watch",
            serverId: "mcp-backlog",
            toolName: "backlog_update",
            permission: "confirm",
            status: "confirmation-required",
            evidencePath: ".agent-workspace/tasks/events.jsonl",
            targetSurface: "backlog",
            summary: "backlog_update requested by agent; scheduler confirmation required",
          },
        ]}
        onSelectServer={(serverId) => selectedServers.push(serverId)}
        onRequestToolCall={(serverId, toolName) => requestedTools.push({ serverId, toolName })}
        onResolveToolCall={(eventId, decision) => resolvedEvents.push({ eventId, decision })}
      />,
    );

    expect(screen.getByText("MCP Gateway")).toBeTruthy();
    expect(screen.getAllByText("Backlog MCP").length).toBeGreaterThan(0);
    expect(screen.getByText("Terminal Commands MCP")).toBeTruthy();
    expect(screen.getByText("Prompt Library MCP")).toBeTruthy();
    expect(screen.getByText("Browser MCP")).toBeTruthy();
    expect(screen.getAllByText("backlog_update").length).toBeGreaterThan(0);
    expect(screen.getByText("command_start")).toBeTruthy();
    expect(screen.getByText("prompt_get")).toBeTruthy();
    expect(screen.getByText("browser_get_state")).toBeTruthy();
    expect(screen.getAllByText("project-scoped allowlist").length).toBeGreaterThan(0);
    expect(screen.getByText("Tool call audit")).toBeTruthy();
    expect(screen.getByText("confirmation-required")).toBeTruthy();
    expect(screen.getByText(".agent-workspace/tasks/events.jsonl")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Approve MCP tool call mcp-event-backlog-update-001" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Deny MCP tool call mcp-event-backlog-update-001" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Approve MCP tool call mcp-event-backlog-update-001" }));
    fireEvent.click(screen.getByRole("button", { name: "Deny MCP tool call mcp-event-backlog-update-001" }));
    fireEvent.click(screen.getByRole("button", { name: "Request MCP tool call backlog_update" }));
    fireEvent.click(screen.getByRole("button", { name: "Select MCP server Browser MCP" }));

    expect(resolvedEvents).toEqual([
      { eventId: "mcp-event-backlog-update-001", decision: "approved" },
      { eventId: "mcp-event-backlog-update-001", decision: "denied" },
    ]);
    expect(requestedTools).toEqual([{ serverId: "mcp-backlog", toolName: "backlog_update" }]);
    expect(selectedServers).toEqual(["mcp-browser"]);
  });

  it("shows resolved MCP confirmation evidence", () => {
    render(
      <McpGateway
        servers={mcpServers}
        selectedServerId="mcp-backlog"
        toolEvents={[
          {
            id: "mcp-event-backlog-update-001",
            taskId: "task-plan-watch",
            serverId: "mcp-backlog",
            toolName: "backlog_update",
            permission: "confirm",
            status: "approved",
            evidencePath: ".agent-workspace/tasks/events.jsonl",
            targetSurface: "backlog",
            summary: "backlog_update requested by agent; scheduler confirmation required",
            decision: "approved",
            decisionEvidencePath: ".agent-workspace/mcp/mcp-event-backlog-update-001/confirmation.json",
            decidedAt: "2026-06-24T14:40:00Z",
            decisionSummary: "Scheduler approved backlog_update for Backlog MCP; tool execution may proceed.",
          },
        ]}
        onSelectServer={() => undefined}
        onRequestToolCall={() => undefined}
        onResolveToolCall={() => undefined}
      />,
    );

    expect(screen.getByText("approved")).toBeTruthy();
    expect(screen.getByText("Scheduler approved backlog_update for Backlog MCP; tool execution may proceed.")).toBeTruthy();
    expect(screen.getByText(".agent-workspace/mcp/mcp-event-backlog-update-001/confirmation.json")).toBeTruthy();
  });
});

/**
 * @vitest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { devCommands } from "../mock/capabilityData";
import { agents, agentClusters, agentTemplates, initialProjects, initialRuns, initialTasks } from "../mock/prototypeData";
import { Projects } from "./Projects";

describe("Projects", () => {
  it("shows project cockpit state and switches project context", () => {
    const selected: string[] = [];
    const workbenchOpens: number[] = [];
    const addedAgents: string[] = [];

    render(
      <Projects
        agents={agents}
        agentClusters={agentClusters}
        agentTemplates={agentTemplates}
        agentProfileEvents={[
          {
            id: "agent-profile-agent-architect-001",
            projectId: "project-agent-workspace",
            agentId: "agent-architect-001",
            templateId: "agent-template-architect",
            systemPromptPath: ".agent-workspace/agents/templates/architecture-reviewer.md",
            worktreePolicy: "shared",
            manifestPath: ".agent-workspace/agents/agent-architect-001.json",
            createdAt: "2026-06-24T13:55:00Z",
            summary: "Created Architecture reviewer profile for Agent Workspace",
          },
        ]}
        commands={devCommands}
        projectContextEvents={[
          {
            id: "project-context-project-agent-workspace-001",
            projectId: "project-agent-workspace",
            zone: "work",
            manifestPath: ".agent-workspace/projects/project-agent-workspace.json",
            browserProfile: ".agent-workspace/browser/project-agent-workspace/",
            selectedAt: "2026-06-24T13:50:00Z",
            summary: "Selected Agent Workspace workspace context",
          },
        ]}
        projects={initialProjects}
        runs={initialRuns}
        selectedProjectId="project-agent-workspace"
        tasks={initialTasks}
        onAddAgent={(templateId) => addedAgents.push(templateId)}
        onOpenWorkbench={() => workbenchOpens.push(1)}
        onSelectProject={(projectId) => selected.push(projectId)}
      />,
    );

    expect(screen.getByText("项目驾驶舱")).toBeTruthy();
    expect(screen.queryByText("Project cockpit")).toBeNull();
    expect(screen.getByText("Agent Workspace")).toBeTruthy();
    expect(screen.getByText("/Users/dinker/CODES/Agent-Workspace")).toBeTruthy();
    expect(screen.getByText("OpenCode Agent Flow")).toBeTruthy();
    expect(screen.getByText("work zone")).toBeTruthy();
    expect(screen.getByText("side-project zone")).toBeTruthy();
    expect(screen.getByText("agent clusters")).toBeTruthy();
    expect(screen.getByText("dev command sessions")).toBeTruthy();
    expect(screen.getByText("project-scoped browser state")).toBeTruthy();
    expect(screen.getByText("工作区上下文审计")).toBeTruthy();
    expect(screen.getByText("Selected Agent Workspace workspace context")).toBeTruthy();
    expect(screen.getByText(".agent-workspace/projects/project-agent-workspace.json")).toBeTruthy();
    expect(screen.getByText("Agent 集群")).toBeTruthy();
    expect(screen.getByText("Project Runtime / 内部默认集群")).toBeTruthy();
    expect(screen.getByText("Task / task-pty")).toBeTruthy();
    expect(screen.getByText(".agent-workspace/projects/project-agent-workspace/clusters/pty-session-manager.json")).toBeTruthy();
    expect(screen.getByText("Agent 配置")).toBeTruthy();
    expect(screen.getByText("Architecture reviewer")).toBeTruthy();
    expect(screen.getAllByText(".agent-workspace/agents/templates/architecture-reviewer.md").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("Agent profile 审计")).toBeTruthy();
    expect(screen.getByText("Created Architecture reviewer profile for Agent Workspace")).toBeTruthy();
    expect(screen.getByText(".agent-workspace/agents/agent-architect-001.json")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "从模板添加 Agent Architecture reviewer" }));
    fireEvent.click(screen.getByRole("button", { name: "选择项目 OpenCode Agent Flow" }));
    fireEvent.click(screen.getByRole("button", { name: "打开所选项目工作台" }));

    expect(addedAgents).toEqual(["agent-template-architect"]);
    expect(selected).toEqual(["project-opencode-flow"]);
    expect(workbenchOpens).toEqual([1]);
  });
});

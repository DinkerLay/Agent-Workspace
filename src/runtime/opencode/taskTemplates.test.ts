import { describe, expect, it } from "vitest";
import {
  createDefaultTaskSessionPlanFromTemplate,
  createTaskAgentsFromSessionPlan,
  createTaskAgentsFromTemplate,
  opencodeTaskTemplates,
} from "./taskTemplates";

describe("opencode task templates", () => {
  it("contains the first real task templates in order with Conductor first", () => {
    expect(opencodeTaskTemplates.map((template) => template.id)).toEqual([
      "research",
      "product-logic",
      "spec-plan",
      "implementation",
      "debug-fix",
    ]);
    expect(opencodeTaskTemplates.every((template) => template.roles[0]?.name === "Conductor")).toBe(true);
    expect(opencodeTaskTemplates.every((template) => template.roles.every((role) => role.sessionPrompt))).toBe(true);
    expect(opencodeTaskTemplates.every((template) => template.workerTargets.length > 0)).toBe(true);
    expect(opencodeTaskTemplates.every((template) => !("routes" in template))).toBe(true);
  });

  it("defines research worker targets without worker-to-worker routes", () => {
    const template = opencodeTaskTemplates.find((item) => item.id === "research");

    expect(template?.workerTargets).toEqual(["Researcher", "Reviewer"]);
    expect(template?.roles.find((role) => role.name === "Researcher")?.sessionPrompt).toContain(
      "Collect evidence",
    );
    expect(template?.roles.find((role) => role.name === "Reviewer")?.sessionPrompt).toContain("Challenge evidence");
  });

  it("does not put Workspace protocol requirements in worker role descriptions", () => {
    for (const template of opencodeTaskTemplates) {
      for (const role of template.roles) {
        expect(role.sessionPrompt).not.toContain("Workspace Session Message");
        expect(role.sessionPrompt).not.toContain("route completed");
        expect(role.sessionPrompt).not.toContain("emit");
      }
    }
  });

  it("keeps template worker targets derived from non-Conductor roles", () => {
    for (const template of opencodeTaskTemplates) {
      const workerRoleNames = template.roles.filter((role) => role.name !== "Conductor").map((role) => role.name);
      expect(template.workerTargets).toEqual(workerRoleNames);
    }
  });

  it("creates a conductor agent and template workers for a new task", () => {
    const agents = createTaskAgentsFromTemplate({
      templateId: "spec-plan",
      projectId: "project-runtime-current",
      taskId: "task-real-spec",
      clusterId: "cluster-project-runtime-current:task-real-spec",
      model: "opencode-go/deepseek-v4-flash",
    });

    expect(agents.map((agent) => agent.name)).toEqual(["Conductor", "Planner", "Reviewer"]);
    expect(agents[0]).toMatchObject({
      id: "task-real-spec-conductor",
      provider: "opencode",
      model: "opencode-go/deepseek-v4-flash",
      status: "idle",
      lastActive: "not started",
    });
    expect(agents.map((agent) => agent.id)).toEqual([
      "task-real-spec-conductor",
      "task-real-spec-planner",
      "task-real-spec-reviewer",
    ]);
    expect(agents.every((agent) => /^[a-zA-Z0-9._:-]+$/.test(agent.id))).toBe(true);
    expect(agents.every((agent) => agent.provider === "opencode")).toBe(true);
    expect(agents.every((agent) => agent.taskId === "task-real-spec")).toBe(true);
    expect(agents.every((agent) => agent.clusterId === "cluster-project-runtime-current:task-real-spec")).toBe(true);
  });

  it("suffixes duplicate safe role slugs within one generated task", () => {
    const implementationTemplate = opencodeTaskTemplates.find((template) => template.id === "implementation");
    expect(implementationTemplate).toBeDefined();
    const originalRoles = implementationTemplate!.roles;
    implementationTemplate!.roles = [
      {
        name: "Conductor",
        role: "Implementation coordinator",
        accent: "#111827",
        sessionPrompt: "Coordinate implementation work through Conductor tools.",
      },
      {
        name: "QA",
        role: "Verification",
        accent: "#b45309",
        sessionPrompt: "Verify the implementation and write terminal notes.",
      },
      {
        name: "Q/A",
        role: "Second verification",
        accent: "#b45309",
        sessionPrompt: "Run an additional verification pass and report results.",
      },
      {
        name: "QA",
        role: "Final verification",
        accent: "#b45309",
        sessionPrompt: "Run final verification and report results.",
      },
    ];

    try {
      const agents = createTaskAgentsFromTemplate({
        templateId: "implementation",
        projectId: "project-runtime-current",
        taskId: "task-duplicate-roles",
        clusterId: "cluster-project-runtime-current:task-duplicate-roles",
        model: "opencode-go/deepseek-v4-flash",
      });

      expect(agents.map((agent) => agent.id)).toEqual([
        "task-duplicate-roles-conductor",
        "task-duplicate-roles-qa",
        "task-duplicate-roles-q~2f~a",
        "task-duplicate-roles-qa-2",
      ]);
    } finally {
      implementationTemplate!.roles = originalRoles;
    }
  });

  it("creates agents from an editable session plan with multiple independent workers", () => {
    const sessionPlan = createDefaultTaskSessionPlanFromTemplate({
      templateId: "research",
      model: "opencode-go/deepseek-v4-flash",
      taskTitle: "Research workflow",
      taskGoal: "Compare workflow mechanisms.",
    });
    sessionPlan.workers = [
      {
        idSeed: "researcher-a",
        name: "Researcher A",
        role: "Anthropic docs evidence",
        provider: "opencode",
        model: "opencode-go/deepseek-v4-flash",
      },
      {
        idSeed: "researcher-b",
        name: "Researcher B",
        role: "Ecosystem comparison",
        provider: "opencode",
        model: "opencode-go/deepseek-v4-flash",
      },
      {
        idSeed: "reviewer",
        name: "Reviewer",
        role: "Source challenge",
        provider: "opencode",
        model: "opencode-go/deepseek-v4-flash",
      },
    ];

    const agents = createTaskAgentsFromSessionPlan({
      templateId: "research",
      projectId: "project-runtime-current",
      taskId: "task-research",
      clusterId: "cluster-project-runtime-current:task-research",
      model: "opencode-go/deepseek-v4-flash",
      sessionPlan,
    });

    expect(agents.map((agent) => agent.id)).toEqual([
      "task-research-conductor",
      "task-research-researcher-a",
      "task-research-researcher-b",
      "task-research-reviewer",
    ]);
    expect(agents.map((agent) => agent.name)).toEqual([
      "Conductor",
      "Researcher A",
      "Researcher B",
      "Reviewer",
    ]);
  });
});

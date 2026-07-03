import { describe, expect, it } from "vitest";
import { createRuntimeWorkspaceState } from "./workspaceState";

describe("runtime workspace state", () => {
  it("starts without mock tasks, runs, agents, or transcripts", () => {
    const state = createRuntimeWorkspaceState({
      projectPath: "/Users/dinker/CODES/Agent-Workspace",
      projectName: "Agent Workspace",
    });

    expect(state.tasks).toEqual([]);
    expect(state.runs).toEqual([]);
    expect(state.agents).toEqual([]);
    expect(state.agentClusters).toHaveLength(1);
    expect(state.agentClusters[0]).toMatchObject({
      level: "project-default",
      agentIds: [],
    });
    expect(state.terminalLines).toEqual([]);
  });

  it("keeps project and cluster selections internally consistent without task or agent selections", () => {
    const state = createRuntimeWorkspaceState({
      projectPath: "/Users/dinker/CODES/Agent-Workspace",
      projectName: "Agent Workspace",
    });

    const selectedProject = state.projects.find((project) => project.id === state.selectedProjectId);
    const selectedCluster = state.agentClusters.find((cluster) => cluster.id === state.selectedAgentClusterId);

    expect(selectedProject).toMatchObject({
      id: "project-runtime-current",
      name: "Agent Workspace",
      path: "/Users/dinker/CODES/Agent-Workspace",
      defaultAgentClusterId: "cluster-runtime-default",
      agentClusterIds: ["cluster-runtime-default"],
      agentIds: [],
      taskIds: [],
    });
    expect(selectedCluster).toMatchObject({
      id: "cluster-runtime-default",
      projectId: "project-runtime-current",
      level: "project-default",
      agentIds: [],
    });
    expect(state.selectedTaskId).toBe("");
    expect(state.selectedAgentId).toBe("");
  });

  it("starts every runtime evidence collection empty", () => {
    const state = createRuntimeWorkspaceState({
      projectPath: "/Users/dinker/CODES/Agent-Workspace",
      projectName: "Agent Workspace",
    });

    expect({
      projectContextEvents: state.projectContextEvents,
      agentProfileEvents: state.agentProfileEvents,
      reviewFileSelections: state.reviewFileSelections,
      commitRedactionScans: state.commitRedactionScans,
      commitStagingEvents: state.commitStagingEvents,
      reviewApprovalEvents: state.reviewApprovalEvents,
      reviewGateEvents: state.reviewGateEvents,
      pullRequestHandoffEvents: state.pullRequestHandoffEvents,
      verificationEvents: state.verificationEvents,
      taskIntakeEvents: state.taskIntakeEvents,
      taskTransitionEvents: state.taskTransitionEvents,
      taskArtifacts: state.taskArtifacts,
      runtimeEvents: state.runtimeEvents,
      terminalEvents: state.terminalEvents,
      loopScheduleEvents: state.loopScheduleEvents,
      browserEvidence: state.browserEvidence,
      notificationEvents: state.notificationEvents,
      watchSources: state.watchSources,
      watchEvents: state.watchEvents,
    }).toEqual({
      projectContextEvents: [],
      agentProfileEvents: [],
      reviewFileSelections: [],
      commitRedactionScans: [],
      commitStagingEvents: [],
      reviewApprovalEvents: [],
      reviewGateEvents: [],
      pullRequestHandoffEvents: [],
      verificationEvents: [],
      taskIntakeEvents: [],
      taskTransitionEvents: [],
      taskArtifacts: [],
      runtimeEvents: [],
      terminalEvents: [],
      loopScheduleEvents: [],
      browserEvidence: [],
      notificationEvents: [],
      watchSources: [],
      watchEvents: [],
    });
  });
});

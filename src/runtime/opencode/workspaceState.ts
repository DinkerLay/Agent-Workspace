import type { AgentCluster, Project, PrototypeState } from "../../types";
import { createRuntimeProjectId } from "./sessionKey";

export type RuntimeWorkspaceStateInput = {
  projectPath: string;
  projectName: string;
};

const runtimeProjectId = "project-runtime-current";
const runtimeDefaultClusterId = "cluster-runtime-default";

export function createRuntimeWorkspaceState(input: RuntimeWorkspaceStateInput): PrototypeState {
  const runtimeProjectSessionId = createRuntimeProjectId(input.projectPath);
  const project: Project = {
    id: runtimeProjectId,
    runtimeProjectId: runtimeProjectSessionId,
    name: input.projectName,
    zone: "work",
    path: input.projectPath,
    status: "active",
    defaultAgentClusterId: runtimeDefaultClusterId,
    agentClusterIds: [runtimeDefaultClusterId],
    agentIds: [],
    taskIds: [],
    commandIds: [],
    browserProfile: `.agent-workspace/browser/${runtimeProjectSessionId}/`,
  };

  const defaultCluster: AgentCluster = {
    id: runtimeDefaultClusterId,
    projectId: project.id,
    name: "Project Runtime",
    level: "project-default",
    agentIds: [],
    evidencePath: ".agent-workspace/clusters/project-runtime-current/cluster-runtime-default.json",
  };

  return {
    activeView: "backlog",
    projects: [project],
    selectedProjectId: project.id,
    projectContextEvents: [],
    agentClusters: [defaultCluster],
    selectedAgentClusterId: defaultCluster.id,
    agents: [],
    agentTemplates: [],
    agentProfileEvents: [],
    selectedAgentId: "",
    reviewAgentId: "",
    reviewFileSelections: [],
    commitConversationIncluded: false,
    commitRedactionScans: [],
    commitStagingEvents: [],
    reviewApprovalEvents: [],
    reviewGateEvents: [],
    pullRequestHandoffEvents: [],
    verificationEvents: [],
    tasks: [],
    taskIntakeEvents: [],
    taskTransitionEvents: [],
    taskArtifacts: [],
    runs: [],
    devCommands: [],
    devCommandEvents: [],
    selectedMcpServerId: "",
    mcpToolEvents: [],
    selectedTeamWorkflowId: "",
    teamRuns: [],
    activePromptTemplateId: undefined,
    attachedSkillIds: [],
    promptLibrarySaves: [],
    activeBrowserToolName: "",
    browserEvidence: [],
    notificationEvents: [],
    watchSources: [],
    watchEvents: [],
    restoreManifest: undefined,
    runtimeEvents: [],
    terminalEvents: [],
    loopScheduleEvents: [],
    selectedTaskId: "",
    terminalLines: [],
    prompt: "",
    scratchpadItems: [],
    scratchpadAttachmentIds: [],
    scratchpadDraftPath: ".agent-workspace/scratchpad/current.md",
    scratchpadSavedAt: "",
  };
}

import type { AgentLoopMetaPanelController } from "./AgentLoopMetaPanel";
import type { AgentLoopTaskSetupController } from "./AgentLoopTaskSetupSurface";

export type AgentLoopCreateTaskSetupDraftInput = Readonly<{
  templateVersionId: string;
  workspaceId: string;
  title: string;
  goal: string;
}>;

/**
 * Presentation contract shared by Template/Meta/Task Setup. The Session-ID
 * configuration controller is the sole implementation in production.
 */
export type AgentLoopConfigurationController = Readonly<{
  meta: AgentLoopMetaPanelController;
  createTaskSetupDraft(input: AgentLoopCreateTaskSetupDraftInput): Promise<string>;
  taskSetup(taskSetupDraftId: string): AgentLoopTaskSetupController;
}>;

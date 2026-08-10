// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentLoopTaskCreateDialog } from "./AgentLoopTaskCreateDialog";
import type { AgentLoopConfigurationController } from "./agent-loop-configuration-controller";
import type { AgentLoopRuntimeController } from "./agent-loop-runtime-controller";
import type { AgentLoopRuntimeViewModel } from "./agent-loop-model";
import type { AgentLoopTemplateStudioController } from "./agent-loop-template-studio-controller";

afterEach(cleanup);

describe("AgentLoopTaskCreateDialog", () => {
  it("creates a durable Setup Draft with an explicit immutable Version and opaque Workspace id", async () => {
    const controller = fakeTaskController();
    const configurationController = fakeConfigurationController();
    render(createElement(AgentLoopTaskCreateDialog, {
      configurationController,
      controller,
      onClose: vi.fn(),
      onSetupCreated: vi.fn(async () => undefined),
      onRequestRefresh: vi.fn(async () => undefined),
      templateStudioController: fakeTemplateController(),
      view: view(),
    }));

    await screen.findByRole("option", { name: "v1" });
    fireEvent.change(screen.getByLabelText("Task 名称"), { target: { value: "产业链研究" } });
    fireEvent.change(screen.getByLabelText("Task 目标"), { target: { value: "核实上下游的证据与风险。" } });
    fireEvent.change(screen.getByLabelText("选择 Template Version"), { target: { value: "template_version_1" } });
    fireEvent.change(screen.getByLabelText("选择已授权项目"), { target: { value: "workspace_1" } });
    fireEvent.click(screen.getByRole("button", { name: "继续 Task Setup" }));

    await waitFor(() => expect(configurationController.createTaskSetupDraft).toHaveBeenCalledWith({
      workspaceId: "workspace_1",
      templateVersionId: "template_version_1",
      title: "产业链研究",
      goal: "核实上下游的证据与风险。",
    }));
    const createSetup = configurationController.createTaskSetupDraft as unknown as ReturnType<typeof vi.fn>;
    expect(JSON.stringify(createSetup.mock.calls[0]?.[0])).not.toContain("/Users/");
  });

  it("uses the explicit authorization action before a directory can become a Workspace choice", async () => {
    const controller = fakeTaskController();
    render(createElement(AgentLoopTaskCreateDialog, {
      configurationController: fakeConfigurationController(),
      controller,
      onClose: vi.fn(),
      onSetupCreated: vi.fn(async () => undefined),
      onRequestRefresh: vi.fn(async () => undefined),
      templateStudioController: fakeTemplateController(),
      view: { ...view(), workspaces: [] },
    }));

    await screen.findByRole("option", { name: "v1" });
    fireEvent.change(screen.getByLabelText("项目目录"), { target: { value: " /tmp/agent-workspace-example " } });
    fireEvent.change(screen.getByLabelText("项目显示名称"), { target: { value: "演示项目" } });
    fireEvent.click(screen.getByRole("button", { name: "授权此目录" }));

    await waitFor(() => expect(controller.authorizeWorkspace).toHaveBeenCalledWith(" /tmp/agent-workspace-example ", "演示项目"));
    await waitFor(() => expect(screen.getByRole("option", { name: "演示项目" })).toBeTruthy());
  });
});

function fakeTaskController(): AgentLoopRuntimeController & Record<string, ReturnType<typeof vi.fn>> {
  return {
    load: vi.fn(async () => view()),
    subscribe: vi.fn(async () => () => undefined),
    authorizeWorkspace: vi.fn(async () => ({ workspaceId: "workspace_authorized", displayName: "演示项目", authorizedAt: "2026-08-06T00:00:00.000Z" })),
    startTask: vi.fn(async () => undefined),
    restartTask: vi.fn(async () => undefined),
    resumeTask: vi.fn(async () => undefined),
    stopTask: vi.fn(async () => undefined),
    achieveTask: vi.fn(async () => undefined),
    archiveTask: vi.fn(async () => undefined),
    restoreTask: vi.fn(async () => undefined),
    previewPermanentDelete: vi.fn(async () => ({ taskId: "task_created", expectedRevision: 1, artifacts: [] })),
    permanentlyDeleteTask: vi.fn(async () => ({ taskId: "task_created", deletedArtifactIds: [], skippedArtifacts: [], deletedAt: "2026-08-06T00:00:00.000Z" })),
    previewArtifact: vi.fn(async () => ({ artifactId: "artifact_1", taskId: "task_created", displayName: "result.md", state: "missing" as const })),
    createInputSubmissionIntent: vi.fn(),
    submitTaskInput: vi.fn(async () => ({ state: "sent" as const })),
    respondAttention: vi.fn(async () => undefined),
  };
}

function fakeConfigurationController(): AgentLoopConfigurationController & Record<string, unknown> {
  return {
    meta: {
      load: vi.fn(async () => ({ profileOptions: [], proposals: [] })),
      createSession: vi.fn(async () => undefined),
      sendMessage: vi.fn(async () => undefined),
      applyPatch: vi.fn(async () => undefined),
      rejectPatch: vi.fn(async () => undefined),
      abandonSession: vi.fn(async () => undefined),
    },
    createTaskSetupDraft: vi.fn(async () => "task_setup_draft_created"),
    taskSetup: vi.fn(() => { throw new Error("not_used"); }),
  };
}

function fakeTemplateController(): AgentLoopTemplateStudioController {
  return {
    load: vi.fn(async (templateId?: string) => ({
      generatedAt: "2026-08-06T00:00:00.000Z",
      templates: [{ templateId: "template_1", title: "研究模板", slug: "research", revision: 1, currentVersion: version() }],
      ...(templateId ? { selectedTemplate: {
        templateId,
        title: "研究模板",
        slug: "research",
        revision: 1,
        activeTemplateVersionId: "template_version_2",
        versions: [version(), { ...version(), templateVersionId: "template_version_2", version: 2 }],
      } } : {}),
      drafts: [],
    })),
    subscribe: vi.fn(async () => () => undefined),
    createDraft: vi.fn(async (editor) => editor),
    saveDraft: vi.fn(async (editor) => editor),
    publishDraft: vi.fn(async () => undefined),
    previewImport: vi.fn(async () => { throw new Error("not_used"); }),
    importPreview: vi.fn(async () => undefined),
    discardImportPreview: vi.fn(),
    exportVersion: vi.fn(async () => { throw new Error("not_used"); }),
  };
}

function version() {
  return {
    templateVersionId: "template_version_1",
    version: 1,
    definitionHash: "hash",
    createdAt: "2026-08-06T00:00:00.000Z",
    publishedAt: "2026-08-06T00:00:00.000Z",
    definitionText: "{}",
  };
}

function view(): AgentLoopRuntimeViewModel {
  return {
    generatedAt: "2026-08-06T00:00:00.000Z",
    workspaces: [{ workspaceId: "workspace_1", displayName: "研究项目", authorizedAt: "2026-08-06T00:00:00.000Z" }],
    templates: [{
      templateId: "template_1",
      title: "研究模板",
      slug: "research",
      revision: 1,
      activeVersion: { templateVersionId: "template_version_2", version: 2, createdAt: "2026-08-06T00:00:00.000Z" },
    }],
    tasks: [],
  };
}

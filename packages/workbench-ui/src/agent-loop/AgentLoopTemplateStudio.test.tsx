// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentLoopTemplateStudio } from "./AgentLoopTemplateStudio";
import type { AgentLoopMetaPanelController } from "./AgentLoopMetaPanel";
import type {
  AgentLoopTemplateDraftEditor,
  AgentLoopTemplateStudioController,
  AgentLoopTemplateStudioViewModel,
} from "./agent-loop-template-studio-controller";

afterEach(cleanup);

describe("AgentLoopTemplateStudio", () => {
  it("preserves Template Library selection and starts an editable Draft from the chosen historical immutable Version", async () => {
    const controller = fakeController();
    const { container } = render(createElement(AgentLoopTemplateStudio, { controller }));

    await screen.findByRole("heading", { name: "模板库" });
    expect(screen.getByRole("button", { name: /^Research teamv3$/ })).toBeTruthy();
    expect(screen.getByText("已选 Version")).toBeTruthy();
    expect(container.querySelector("iframe")).toBeNull();

    fireEvent.change(screen.getByLabelText("选择 Template Version"), { target: { value: "template_version_research_v1" } });
    fireEvent.click(screen.getByRole("button", { name: "从此版本编辑" }));
    expect(await screen.findByRole("region", { name: "Template Draft 编辑器" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "执行配置" })).toBeTruthy();
    fireEvent.change(screen.getByLabelText("profile_default Provider"), { target: { value: "claude-code" } });
    fireEvent.change(screen.getByLabelText("profile_default 模型"), { target: { value: "claude-4.5-sonnet" } });
    fireEvent.change(screen.getByLabelText("模板名称"), { target: { value: "Refined research team" } });
    fireEvent.click(screen.getByRole("button", { name: "保存草稿" }));

    await waitFor(() => expect(controller.createDraft).toHaveBeenCalledWith(expect.objectContaining({
      templateId: "template_research",
      baseTemplateVersionId: "template_version_research_v1",
      title: "Refined research team",
      slug: "research-team",
    })));
    const createDraft = controller.createDraft as unknown as ReturnType<typeof vi.fn>;
    const draft = createDraft.mock.calls[0]?.[0];
    const definition = JSON.parse(draft?.definitionText ?? "{}") as { executionProfiles?: Array<{ provider?: string; model?: string }> };
    expect(definition.executionProfiles?.[0]).toMatchObject({ provider: "claude-code", model: "claude-4.5-sonnet" });
  });

  it("shows a decoded import preview and requires an explicit import mode before writing Runtime", async () => {
    const controller = fakeController();
    const { container } = render(createElement(AgentLoopTemplateStudio, { controller }));
    await screen.findByRole("heading", { name: "模板库" });

    const input = container.querySelector<HTMLInputElement>('input[type="file"]');
    if (!input) throw new Error("file_input_missing");
    const bytes = new TextEncoder().encode("schemaVersion: 2\n");
    const file = {
      name: "portable.agent-template.yaml",
      arrayBuffer: vi.fn(async () => bytes.buffer),
    } as unknown as File;
    fireEvent.change(input, { target: { files: [file] } });

    await screen.findByRole("region", { name: "Template 导入预览" });
    expect(controller.previewImport).toHaveBeenCalledWith(expect.objectContaining({ fileName: "portable.agent-template.yaml" }));
    expect(controller.importPreview).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "创建新的 Template" }));
    await waitFor(() => expect(controller.importPreview).toHaveBeenCalledWith("template_import_preview_1", "create"));
  });

  it("opens a Draft-scoped Meta panel explicitly and keeps close/dock as view state", async () => {
    const controller = fakeController();
    const metaController = fakeMetaController();
    render(createElement(AgentLoopTemplateStudio, { controller, metaController }));

    fireEvent.click(await screen.findByRole("button", { name: /^Research team draftDraft r2$/ }));
    expect(screen.queryByRole("heading", { name: "Meta Agent" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Meta Agent" }));
    expect(await screen.findByRole("heading", { name: "Meta Agent" })).toBeTruthy();
    expect(metaController.createSession).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "停靠 Meta panel" }));
    expect(screen.getByRole("complementary", { name: "Meta Agent panel" }).className).toContain("is-docked");
    fireEvent.click(screen.getByRole("button", { name: "关闭 Meta panel" }));
    expect(screen.queryByRole("heading", { name: "Meta Agent" })).toBeNull();
    expect(metaController.abandonSession).not.toHaveBeenCalled();
    expect(controller.publishDraft).not.toHaveBeenCalled();
  });
});

function fakeMetaController(): AgentLoopMetaPanelController & Record<string, ReturnType<typeof vi.fn>> {
  return {
    load: vi.fn(async () => ({
      profileOptions: [{
        metaProfileOptionId: "meta_option_codex",
        label: "Codex · gpt-5.4",
        detail: "0.146.0",
        readiness: "available" as const,
        unavailableReasons: [],
      }],
      proposals: [],
    })),
    createSession: vi.fn(async () => undefined),
    sendMessage: vi.fn(async () => undefined),
    applyPatch: vi.fn(async () => undefined),
    rejectPatch: vi.fn(async () => undefined),
    abandonSession: vi.fn(async () => undefined),
  };
}

function fakeController(): AgentLoopTemplateStudioController & Record<string, ReturnType<typeof vi.fn>> {
  const createDraft = vi.fn(async (editor: AgentLoopTemplateDraftEditor) => ({
    ...editor,
    mode: "edit" as const,
    templateDraftId: "template_draft_research",
    revision: 1,
  }));
  return {
    load: vi.fn(async () => view()),
    subscribe: vi.fn(async () => () => undefined),
    createDraft,
    saveDraft: vi.fn(async (editor: AgentLoopTemplateDraftEditor) => editor),
    publishDraft: vi.fn(async () => undefined),
    previewImport: vi.fn(async () => ({
      importId: "template_import_preview_1",
      fileName: "portable.agent-template.yaml",
      byteLength: 17,
      templateId: "template_portable",
      version: 1,
      slug: "portable-team",
      title: "Portable team",
      assetCount: 0,
      availableModes: ["create"] as const,
    })),
    importPreview: vi.fn(async () => undefined),
    discardImportPreview: vi.fn(),
    exportVersion: vi.fn(async () => ({
      fileName: "research-team-v3.agent-template.yaml",
      bytes: new TextEncoder().encode("schemaVersion: 2\n"),
      format: "yaml" as const,
    })),
  };
}

function view(): AgentLoopTemplateStudioViewModel {
  return {
    generatedAt: "2026-08-06T00:00:00.000Z",
    templates: [{
      templateId: "template_research",
      title: "Research team",
      slug: "research-team",
      description: "Gather verified provider evidence.",
      revision: 4,
      currentVersion: {
        templateVersionId: "template_version_research_v3",
        version: 3,
        definitionHash: "definition-hash-v3",
        createdAt: "2026-08-06T00:00:00.000Z",
        publishedAt: "2026-08-06T01:00:00.000Z",
        definitionText: JSON.stringify(definition()),
      },
    }],
    selectedTemplate: {
      templateId: "template_research",
      title: "Research team",
      slug: "research-team",
      description: "Gather verified provider evidence.",
      revision: 4,
      activeTemplateVersionId: "template_version_research_v3",
      versions: [{
        templateVersionId: "template_version_research_v1",
        version: 1,
        definitionHash: "definition-hash-v1",
        createdAt: "2026-08-05T00:00:00.000Z",
        publishedAt: "2026-08-05T01:00:00.000Z",
        definitionText: JSON.stringify(definition()),
      }, {
        templateVersionId: "template_version_research_v3",
        version: 3,
        definitionHash: "definition-hash-v3",
        createdAt: "2026-08-06T00:00:00.000Z",
        publishedAt: "2026-08-06T01:00:00.000Z",
        definitionText: JSON.stringify(definition()),
      }],
    },
    drafts: [{
      templateDraftId: "template_draft_existing",
      templateId: "template_research",
      revision: 2,
      title: "Research team draft",
      slug: "research-team",
      description: "Tighten the delivery criteria.",
      definitionText: JSON.stringify(definition()),
      updatedAt: "2026-08-06T01:00:00.000Z",
    }],
  };
}

function definition() {
  return {
    schemaVersion: 2,
    conductor: {
      agentCardId: "agent_card_conductor",
      kind: "conductor",
      title: "Conductor",
      executionProfileId: "profile_default",
      systemPrompt: "Coordinate evidence.",
      capabilityRefs: [],
    },
    agentCards: [{
      agentCardId: "agent_card_worker",
      kind: "general",
      title: "Worker",
      executionProfileId: "profile_default",
      systemPrompt: "Complete bounded work.",
      capabilityRefs: [],
      dispatchProfile: { title: "Scoped work", description: "One bounded assignment." },
    }],
    executionProfiles: [{
      executionProfileId: "profile_default",
      provider: "codex",
      model: "gpt-5.6-codex",
      providerVersion: "0.146.0",
      protocolFingerprint: "codex-app-server/0.146.0",
      capabilityPolicy: {
        requiredCapabilities: ["create_binding", "resume_binding", "input_correlation", "provider_receipt", "reconcile", "interrupt"],
        allowedTools: [],
        permissionMode: "deny",
        maxConcurrentTurns: 1,
        maxNativeChildren: 0,
      },
    }],
    routingPolicy: { mode: "agent_loop", maxConcurrentInvocations: 1, maxDispatchesPerDecision: 1 },
    deliverables: [{ artifactPath: "artifacts/result.md", ownerAgentCardId: "agent_card_worker" }],
  };
}

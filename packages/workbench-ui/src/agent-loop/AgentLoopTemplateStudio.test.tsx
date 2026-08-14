// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  validateTemplateDefinition,
  validateTemplateDefinitionV3,
  type AcpProfileReadinessStatus,
} from "@agent-workspace/runtime-contracts";
import { AgentLoopTemplateStudio } from "./AgentLoopTemplateStudio";
import type { AgentLoopMetaPanelController, AgentLoopMetaProfileOptionV3 } from "./AgentLoopMetaPanel";
import type {
  AgentLoopTemplateDraftEditor,
  AgentLoopTemplateProfileRevisionOption,
  AgentLoopTemplateStudioSurfaceController,
  AgentLoopTemplateStudioViewModel,
} from "./agent-loop-template-studio-controller";

afterEach(cleanup);

describe("AgentLoopTemplateStudio", () => {
  it("keeps a historical v2 Version read-only while the typed migration command is absent", async () => {
    const controller = fakeController();
    const { container } = render(createElement(AgentLoopTemplateStudio, { controller }));

    await screen.findByRole("heading", { name: "模板库" });
    fireEvent.click(screen.getByRole("button", { name: /Research team.*v3/u }));
    expect(await screen.findByRole("region", { name: "Template Version Workspace" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Template Meta Agent" })).toBeNull();
    expect(screen.getByRole("complementary", { name: "Agent Card Inspector" })).toBeTruthy();
    expect(container.querySelector("iframe")).toBeNull();

    fireEvent.change(screen.getByLabelText("选择 Template Version"), { target: { value: "template_version_research_v1" } });
    const migrate = screen.getByRole("button", { name: "迁移到 ACP v3 Draft" }) as HTMLButtonElement;
    expect(migrate.disabled).toBe(true);
    expect(migrate.title).toBe("Runtime migration command not registered");
    expect(screen.getByText(/schema v2 历史只读/u)).toBeTruthy();
    expect(screen.getByText(/Runtime migration command not registered/u)).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Template Draft 编辑器" })).toBeNull();
    expect(controller.createDraft).not.toHaveBeenCalled();
    expect(controller.saveDraft).not.toHaveBeenCalled();
  });

  it("creates a persisted Deepsearch-based Draft and opens the shared Meta chat from its sidebar affordance", async () => {
    const controller = fakeController({ supportsAcpTemplateV3: true });
    const metaController = fakeMetaController();
    render(createElement(AgentLoopTemplateStudio, { controller, metaController }));
    await screen.findByRole("heading", { name: "模板库" });

    fireEvent.click(screen.getByRole("button", { name: "＋ 用 Meta Agent 新建" }));

    await waitFor(() => expect(controller.createDraft).toHaveBeenCalledTimes(1));
    const input = vi.mocked(controller.createDraft).mock.calls[0]?.[0];
    expect(input).toEqual(expect.objectContaining({
      mode: "new",
      title: "New Deepsearch Template",
      slug: "new-deepsearch-template",
    }));
    expect(input).not.toHaveProperty("templateId");
    expect(input).not.toHaveProperty("baseTemplateVersionId");
    const definition = validateTemplateDefinitionV3(JSON.parse(input!.definitionText));
    expect(definition.schemaVersion).toBe(3);
    expect(screen.queryByRole("heading", { name: "Template Meta Agent" })).toBeNull();
    fireEvent.click(screen.getByTestId("meta-panel-open"));
    expect(await screen.findByRole("heading", { name: "Template Meta Agent" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Meta conversation" })).toBeTruthy();
    expect(screen.getByLabelText("发送给 Meta Agent")).toBeTruthy();
    expect(screen.queryByText("先保存 Draft，再打开 Meta Session")).toBeNull();
    expect(metaController.load).toHaveBeenCalledWith(expect.objectContaining({
      kind: "template_design",
      draftId: "template_draft_research",
    }));
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

  it("archives the selected Template identity through the surface controller", async () => {
    const controller = fakeController();
    render(createElement(AgentLoopTemplateStudio, { controller }));
    await screen.findByRole("heading", { name: "模板库" });

    fireEvent.click(screen.getByRole("button", { name: /Research team.*v3/u }));
    await screen.findByRole("region", { name: "Template Version Workspace" });
    fireEvent.click(screen.getByRole("button", { name: "归档 Template" }));

    await waitFor(() => expect(controller.archiveTemplate).toHaveBeenCalledWith("template_research", 4));
    expect(await screen.findByText("Template identity 已归档；不可变 Version 与已有 Task 保持不变。")).toBeTruthy();
  });

  it("restores persisted Draft-scoped Meta inside the same workspace when its sidebar is opened", async () => {
    const controller = fakeController();
    const metaController = fakeMetaController();
    vi.mocked(metaController.load).mockResolvedValue({
      profileOptions: [metaProfileOption()],
      session: {
        metaSessionId: "meta_session_template_research",
        revision: 3,
        status: "idle",
        messages: [{
          messageId: "meta_message_template_research",
          role: "assistant",
          content: "同一 active Template Meta Session。",
          createdAt: "2026-08-09T00:00:00.000Z",
        }],
        activities: [],
      },
      proposals: [],
    });
    render(createElement(AgentLoopTemplateStudio, { controller, metaController }));

    fireEvent.click(await screen.findByRole("button", { name: /Research team draft.*r2/u }));
    expect(screen.queryByRole("heading", { name: "Template Meta Agent" })).toBeNull();
    fireEvent.click(screen.getByTestId("meta-panel-open"));
    expect(await screen.findByRole("heading", { name: "Template Meta Agent" })).toBeTruthy();
    expect(screen.getByRole("complementary", { name: "Meta Agent panel" }).className).toContain("is-docked");
    expect(screen.getByText("同一 active Template Meta Session。")).toBeTruthy();
    expect(metaController.createSession).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "浮动 Meta panel" })).toBeNull();
    expect(screen.queryByRole("button", { name: "关闭 Meta panel" })).toBeNull();
    expect(screen.queryByTestId("template-meta-targets")).toBeNull();

    fireEvent.click(screen.getByTestId("template-meta-target-template"));
    expect(within(screen.getByRole("region", { name: "当前 AI 修订目标" })).getByText("@Template")).toBeTruthy();
    expect(metaController.createSession).not.toHaveBeenCalled();
    expect(metaController.abandonSession).not.toHaveBeenCalled();
    expect(controller.publishDraft).not.toHaveBeenCalled();
  });

  it("creates a persisted revision immediately and exposes Meta through the shared workspace sidebar", async () => {
    const controller = fakeController();
    const metaController = fakeMetaController();
    render(createElement(AgentLoopTemplateStudio, { controller, metaController }));

    fireEvent.click(await screen.findByRole("button", { name: /Research team.*v3/u }));
    fireEvent.click(await screen.findByRole("button", { name: "基于 v3 开始修订" }));

    await waitFor(() => expect(controller.createDraft).toHaveBeenCalledWith(expect.objectContaining({
      templateId: "template_research",
      baseTemplateVersionId: "template_version_research_v3",
    })));
    expect(screen.queryByRole("heading", { name: "Template Meta Agent" })).toBeNull();
    fireEvent.click(screen.getByTestId("meta-panel-open"));
    expect(await screen.findByRole("heading", { name: "Template Meta Agent" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Meta conversation" })).toBeTruthy();
    expect(screen.getByLabelText("发送给 Meta Agent")).toBeTruthy();
    expect(screen.queryByText("先保存 Draft，再打开 Meta Session")).toBeNull();
    expect(metaController.load).toHaveBeenCalledWith(expect.objectContaining({
      kind: "template_design",
      draftId: "template_draft_research",
    }));
  });

  it("treats the Draft as a visual object workspace and keeps selection separate from the explicit Meta target", async () => {
    const metaController = fakeMetaController();
    render(createElement(AgentLoopTemplateStudio, { controller: fakeController(), metaController }));

    fireEvent.click(await screen.findByRole("button", { name: /Research team draft.*r2/u }));

    expect(screen.getByRole("region", { name: "Template Draft Workspace" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Conductor Charter" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Session Agent Cards" })).toBeTruthy();
    expect(screen.getByRole("complementary", { name: "Agent Card Inspector" }).textContent).toContain("Conductor");
    expect(screen.queryByRole("region", { name: "Selected ACP Profile" })).toBeNull();
    fireEvent.click(screen.getByTestId("meta-panel-open"));
    const targetRegion = screen.getByRole("region", { name: "当前 AI 修订目标" });
    expect(targetRegion.textContent).toContain("@Template");

    fireEvent.click(screen.getByTestId("template-card-agent_card_worker"));
    expect(screen.getByRole("complementary", { name: "Agent Card Inspector" }).textContent).toContain("Worker");
    expect(targetRegion.textContent).toContain("@Template");
    expect(targetRegion.textContent).not.toContain("@Worker");

    fireEvent.click(screen.getByRole("button", { name: "将 Worker 加入 AI 目标" }));
    expect(targetRegion.textContent).toContain("@Worker");
    expect(targetRegion.textContent).not.toContain("@Template");

    fireEvent.change(screen.getByLabelText("Worker System Prompt"), {
      target: { value: "Complete one scoped claim and report verifiable evidence." },
    });
    const definition = validateTemplateDefinitionV3(JSON.parse(
      (screen.getByTestId("template-definition") as HTMLTextAreaElement).value,
    ));
    expect(definition.agentCards[0]?.systemPrompt).toBe("Complete one scoped claim and report verifiable evidence.");
  });

  it("lets each Agent choose a Provider first and then one of that Provider's Host-issued models", async () => {
    const controller = fakeController();
    const model = view();
    const openCode = profileOption("opencode", "available");
    vi.mocked(controller.load).mockResolvedValue({
      ...model,
      profileOptions: [
        profileOption("codex", "available"),
        workerProfileOption("codex", "available"),
        openCode,
        workerProfileOption("opencode", "available"),
      ],
    });
    render(createElement(AgentLoopTemplateStudio, { controller, metaController: fakeMetaController() }));

    fireEvent.click(await screen.findByRole("button", { name: /Research team draft.*r2/u }));

    const provider = screen.getByLabelText("Conductor Provider");
    expect(within(provider).getByRole("option", { name: "Codex" })).toBeTruthy();
    expect(within(provider).getByRole("option", { name: "OpenCode" })).toBeTruthy();
    fireEvent.change(provider, { target: { value: "opencode" } });

    const modelSelector = screen.getByLabelText("Conductor Model");
    expect(within(modelSelector).getByRole("option", { name: "选择 OpenCode 模型" })).toBeTruthy();
    expect(within(modelSelector).getByRole("option", { name: "opencode-go/gpt-5.6-luna" })).toBeTruthy();
    expect(modelSelector.textContent).not.toContain("profile_revision_");
    expect(JSON.parse((screen.getByTestId("template-definition") as HTMLTextAreaElement).value).executionProfiles[0]).toMatchObject({
      providerFamily: "codex",
      model: "gpt-5.6-luna",
    });

    fireEvent.change(modelSelector, { target: { value: openCode.model } });
    const definition = validateTemplateDefinitionV3(JSON.parse(
      (screen.getByTestId("template-definition") as HTMLTextAreaElement).value,
    ));
    expect(definition.executionProfiles[0]).toMatchObject({
      executionProfileId: "profile_default",
      profileRevisionId: openCode.profileRevisionId,
      providerFamily: "opencode",
      model: "opencode-go/gpt-5.6-luna",
    });
  });

  it("edits Effort independently through an exact Host-issued profile revision", async () => {
    const controller = fakeController();
    const model = view();
    const base = profileOption("codex", "available");
    const xhigh: AgentLoopTemplateProfileRevisionOption = {
      ...base,
      title: "Codex ACP · gpt-5.6-luna · xhigh",
      profileRevisionId: "profile_revision_codex-starter-xhigh-v1",
      configIntent: { reasoningEffort: "xhigh" },
      readiness: {
        ...base.readiness,
        profileRevisionId: "profile_revision_codex-starter-xhigh-v1",
        status: "checking",
        reasons: ["model_qualification_required"],
      },
    };
    vi.mocked(controller.load).mockResolvedValue({
      ...model,
      profileOptions: [base, xhigh, workerProfileOption("codex", "available")],
    });
    render(createElement(AgentLoopTemplateStudio, { controller, metaController: fakeMetaController() }));

    fireEvent.click(await screen.findByRole("button", { name: /Research team draft.*r2/u }));
    const effort = screen.getByLabelText("Conductor Effort");
    expect(within(effort).getByRole("option", { name: "Default · 已验证" })).toBeTruthy();
    expect(within(effort).getByRole("option", { name: "xhigh · 待验证" })).toBeTruthy();
    fireEvent.change(effort, { target: { value: xhigh.profileRevisionId } });

    const definition = validateTemplateDefinitionV3(JSON.parse(
      (screen.getByTestId("template-definition") as HTMLTextAreaElement).value,
    ));
    expect(definition.executionProfiles[0]).toMatchObject({
      profileRevisionId: xhigh.profileRevisionId,
      model: "gpt-5.6-luna",
      configIntent: { reasoningEffort: "xhigh" },
    });
  });

  it("does not expose the superseded local-only Draft step when Meta is opened", async () => {
    const metaController = fakeMetaController();
    const controller = fakeController({ supportsAcpTemplateV3: true });
    render(createElement(AgentLoopTemplateStudio, { controller, metaController }));

    await screen.findByRole("heading", { name: "模板库" });
    fireEvent.click(screen.getByRole("button", { name: "＋ 用 Meta Agent 新建" }));

    expect(await screen.findByRole("region", { name: "Template Draft Workspace" })).toBeTruthy();
    fireEvent.click(screen.getByTestId("meta-panel-open"));
    expect(screen.getByRole("heading", { name: "Template Meta Agent" })).toBeTruthy();
    expect(screen.queryByText("先保存 Draft，再打开 Meta Session")).toBeNull();
    expect(controller.createDraft).toHaveBeenCalledTimes(1);
    expect(metaController.load).toHaveBeenCalled();
    expect(metaController.createSession).not.toHaveBeenCalled();
  });

  it("collapses and resizes the Meta and Inspector sidebars without replacing the Template workspace", async () => {
    render(createElement(AgentLoopTemplateStudio, {
      controller: fakeController(),
      metaController: fakeMetaController(),
    }));

    fireEvent.click(await screen.findByRole("button", { name: /Research team draft.*r2/u }));
    const workspace = screen.getByRole("region", { name: "Template Draft Workspace" });
    const studio = screen.getByRole("region", { name: "AgentLoop Template Studio" });
    const workspaceBody = workspace.querySelector<HTMLElement>(".awb-template-workspace-body");
    if (!workspaceBody) throw new Error("template_workspace_body_missing");

    expect(screen.getByTestId("meta-panel-open")).toBeTruthy();
    fireEvent.click(screen.getByTestId("meta-panel-open"));
    expect(studio.style.getPropertyValue("--awb-template-meta-width")).toBe("320px");
    fireEvent.keyDown(screen.getByRole("separator", { name: "调整 Meta Agent 侧栏宽度" }), { key: "ArrowRight" });
    expect(studio.style.getPropertyValue("--awb-template-meta-width")).toBe("336px");
    fireEvent.click(screen.getByTestId("meta-panel-collapse"));
    expect(screen.getByTestId("meta-panel-open")).toBeTruthy();
    expect(screen.getByRole("region", { name: "Template Draft Workspace" })).toBe(workspace);

    expect(workspaceBody.style.getPropertyValue("--awb-template-inspector-width")).toBe("320px");
    fireEvent.keyDown(screen.getByRole("separator", { name: "调整 Agent Inspector 宽度" }), { key: "ArrowLeft" });
    expect(workspaceBody.style.getPropertyValue("--awb-template-inspector-width")).toBe("336px");
    fireEvent.click(screen.getByTestId("template-inspector-collapse"));
    expect(screen.getByTestId("template-inspector-open")).toBeTruthy();
    expect(screen.getByRole("region", { name: "Template Draft Workspace" })).toBe(workspace);
    fireEvent.click(screen.getByTestId("template-inspector-open"));
    expect(screen.getByRole("complementary", { name: "Agent Card Inspector" })).toBeTruthy();
  });

  it("keeps persisted v3 writes disabled until the typed Runtime command is registered", async () => {
    const controller = fakeController();
    render(createElement(AgentLoopTemplateStudio, { controller }));

    fireEvent.click(await screen.findByRole("button", { name: /Research team draft.*r2/u }));
    const publish = screen.getByTestId("template-publish") as HTMLButtonElement;
    const save = screen.getByTestId("template-save-draft") as HTMLButtonElement;
    expect(publish.disabled).toBe(true);
    expect(save.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("模板名称"), { target: { value: "Unsaved title" } });
    expect(publish.disabled).toBe(true);
    fireEvent.click(publish);
    expect(controller.publishDraft).not.toHaveBeenCalled();
    expect(controller.saveDraft).not.toHaveBeenCalled();
  });
});

function fakeMetaController(): AgentLoopMetaPanelController & Record<string, ReturnType<typeof vi.fn>> {
  return {
    load: vi.fn(async () => ({
      profileOptions: [metaProfileOption()],
      proposals: [],
    })),
    createSession: vi.fn(async () => undefined),
    sendMessage: vi.fn(async () => undefined),
    applyPatch: vi.fn(async () => undefined),
    rejectPatch: vi.fn(async () => undefined),
    abandonSession: vi.fn(async () => undefined),
  };
}

function fakeController(options: Readonly<{ supportsAcpTemplateV3?: true }> = {}): AgentLoopTemplateStudioSurfaceController {
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
    archiveTemplate: vi.fn(async () => undefined),
    supportsAcpTemplateV3: options.supportsAcpTemplateV3,
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
        definitionText: JSON.stringify(definitionV3()),
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
        definitionText: JSON.stringify(definitionV2()),
      }, {
        templateVersionId: "template_version_research_v3",
        version: 3,
        definitionHash: "definition-hash-v3",
        createdAt: "2026-08-06T00:00:00.000Z",
        publishedAt: "2026-08-06T01:00:00.000Z",
        definitionText: JSON.stringify(definitionV3()),
      }],
    },
    drafts: [{
      templateDraftId: "template_draft_existing",
      templateId: "template_research",
      revision: 2,
      title: "Research team draft",
      slug: "research-team",
      description: "Tighten the delivery criteria.",
      definitionText: JSON.stringify(definitionV3()),
      updatedAt: "2026-08-06T01:00:00.000Z",
    }],
    profileOptions: [
      profileOption("codex", "available"),
      workerProfileOption("codex", "available"),
      profileOption("opencode", "capability_missing"),
      workerProfileOption("opencode", "capability_missing"),
    ],
  };
}

function workerProfileOption(
  providerFamily: "codex" | "opencode",
  status: AcpProfileReadinessStatus,
): AgentLoopTemplateProfileRevisionOption {
  const conductor = profileOption(providerFamily, status);
  return {
    ...conductor,
    title: `${conductor.title} · Worker`,
    executionProfileId: `${conductor.executionProfileId}-worker`,
    role: "general",
    profileRevisionId: conductor.profileRevisionId.replace(/-v1$/u, "-worker-v1"),
    capabilityPolicy: { ...conductor.capabilityPolicy, allowedTools: [] },
    readiness: {
      ...conductor.readiness,
      profileRevisionId: conductor.profileRevisionId.replace(/-v1$/u, "-worker-v1"),
      role: "general",
    },
  };
}

function definitionV2() {
  return validateTemplateDefinition({
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
  });
}

function definitionV3() {
  const option = profileOption("codex", "available");
  return validateTemplateDefinitionV3({
    schemaVersion: 3,
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
      profileRevisionId: option.profileRevisionId,
      providerFamily: option.providerFamily,
      acpAgentKind: option.acpAgentKind,
      protocolMajor: option.protocolMajor,
      model: option.model,
      configIntent: option.configIntent,
      requiredExtensions: option.requiredExtensions,
      capabilityPolicy: option.capabilityPolicy,
    }],
    routingPolicy: { mode: "agent_loop", maxConcurrentInvocations: 1, maxDispatchesPerDecision: 1 },
    deliverables: [{ artifactPath: "artifacts/result.md", ownerAgentCardId: "agent_card_worker" }],
  });
}

function profileOption(
  providerFamily: "codex" | "opencode",
  status: AcpProfileReadinessStatus,
): AgentLoopTemplateProfileRevisionOption {
  const codex = providerFamily === "codex";
  const profileRevisionId = codex
    ? "profile_revision_codex-starter-v1"
    : "profile_revision_opencode-starter-v1";
  const model = codex ? "gpt-5.6-luna" : "opencode-go/gpt-5.6-luna";
  const observedCapabilities: AgentLoopTemplateProfileRevisionOption["capabilityPolicy"]["requiredCapabilities"] = [
    "create_binding",
    "resume_binding",
    "input_correlation",
    "provider_receipt",
    "reconcile",
    "interrupt",
  ];
  return {
    title: codex ? "Codex ACP · gpt-5.6-luna" : "OpenCode ACP · opencode-go/gpt-5.6-luna",
    sourceTemplateId: codex ? "template_builtin-codex-acp-starter" : "template_builtin-opencode-acp-starter",
    sourceTemplateVersionId: codex
      ? "template_version_builtin-codex-acp-starter-v1"
      : "template_version_builtin-opencode-acp-starter-v1",
    executionProfileId: codex ? "profile_codex-starter" : "profile_opencode-starter",
    role: "conductor",
    profileRevisionId,
    providerFamily,
    acpAgentKind: codex ? "codex_acp" : "native_acp",
    protocolMajor: 1,
    model,
    catalogObserved: true,
    configIntent: {},
    requiredExtensions: ["session/load"],
    capabilityPolicy: {
      requiredCapabilities: observedCapabilities,
      allowedTools: ["invoke_agent", "send_to_session", "interrupt_session", "close_session"],
      permissionMode: "deny",
      maxConcurrentTurns: 1,
      maxNativeChildren: 0,
    },
    readiness: {
      profileRevisionId,
      providerFamily,
      acpAgentKind: codex ? "codex_acp" : "native_acp",
      role: "conductor",
      status,
      reasons: status === "available" ? [] : ["acp_capability_missing"],
      missingCapabilities: status === "available" ? [] : ["interrupt"],
      missingExtensions: [],
      model,
      observedProtocolMajor: 1,
      observedAgent: codex
        ? { name: "codex-acp", title: "codex-acp", version: "0.9.4" }
        : { name: "opencode", title: "OpenCode", version: "1.2.3" },
      observedArtifactVersion: codex ? "0.9.4" : "1.2.3",
      observedUpstreamVersion: codex ? "0.147.0" : "1.2.3",
      observedCapabilities,
      observedExtensions: ["session/load"],
    },
  };
}

function metaProfileOption(): AgentLoopMetaProfileOptionV3 {
  return {
    schemaVersion: 3,
    metaProfileOptionId: "meta_option_codex",
    label: "Codex · gpt-5.6-luna",
    providerFamily: "codex",
    model: "gpt-5.6-luna",
    configIntent: { reasoningEffort: "high" },
    readiness: {
      ...profileOption("codex", "available").readiness,
      role: "meta",
    },
  };
}

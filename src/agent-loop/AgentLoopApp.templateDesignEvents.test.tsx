/**
 * @vitest-environment jsdom
 */
import { act, fireEvent, render, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type React from "react";
import { TaskDialog, TemplateDialog, TemplateSurface } from "./AgentLoopApp";
import type { NativeAgentLoopTemplate, NativeOpencodeModelCapability, NativeTemplateDesignDraft } from "../runtime/nativeBridge";

const templateDesignEvents = vi.hoisted(() => ({
  listener: undefined as undefined | ((event: { draftId: string; type: string; revision: number }) => void),
  read: vi.fn(),
  subscribe: vi.fn(),
}));

vi.mock("../runtime/nativeBridge", () => ({
  defaultOpencodeRunModel: "opencode-go/gpt-5.6-luna",
  isNativePromptSplitSessionAgentCard: (card: unknown) => Boolean(
    card && typeof card === "object" && "dispatchProfile" in card && "workerSystemPrompt" in card,
  ),
  readNativeAgentLoopTemplateDesignSession: templateDesignEvents.read,
  subscribeNativeAgentLoopTemplateDesignEvents: templateDesignEvents.subscribe,
}));

vi.mock("./templateDesignWebUiPreview", () => ({
  TemplateDesignWebUiPreview: () => null,
}));

const template = {
  id: "template-stable",
  version: 1,
  name: "Stable Template",
  source: "manual",
  conductor: { role: "Conductor", model: "opencode-go/gpt-5.6-luna", charter: "Decide the next dispatch." },
  agents: [],
  limits: { maxConcurrentSessions: 3, maxDispatchesPerDecision: 3 },
  delivery: { artifactPath: "", ownerAgentId: "" },
  createdAt: "2026-08-05T00:00:00.000Z",
  updatedAt: "2026-08-05T00:00:00.000Z",
} as NativeAgentLoopTemplate;

function draft(revision: number): NativeTemplateDesignDraft {
  return {
    draftId: "template-design-1",
    cwd: "/workspace/project",
    model: "opencode-go/gpt-5.6-luna",
    draftJson: {
      id: "template-draft-1",
      name: "Working Template",
      source: "manual",
      conductor: { role: "Conductor", model: "opencode-go/gpt-5.6-luna", charter: "Draft charter." },
      agents: [],
      limits: { maxConcurrentSessions: 3, maxDispatchesPerDecision: 3 },
      delivery: { artifactPath: "", ownerAgentId: "" },
    },
    validation: { valid: true, issues: [] },
    revision,
    providerSessionId: "ses-template-design-1",
    status: "active",
    createdAt: "2026-08-05T00:00:00.000Z",
    updatedAt: "2026-08-05T00:00:00.000Z",
  };
}

function renderSurface({
  designDraft = draft(2),
  templateVersions = [template],
  selectedTemplate = template,
  metaAgentOpen = true,
  taskCreationPending = false,
  taskCreationIntent,
  onSelectVersion = vi.fn(),
  onOpenMetaAgent = vi.fn(),
  onDesignDraftChange = vi.fn(),
  onDesignDraftDiscarded = vi.fn(),
  onRetryDesignDraft = vi.fn(),
}: {
  designDraft?: NativeTemplateDesignDraft | null;
  templateVersions?: NativeAgentLoopTemplate[];
  selectedTemplate?: NativeAgentLoopTemplate;
  metaAgentOpen?: boolean;
  taskCreationPending?: boolean;
  taskCreationIntent?: { title: string; goal: string; cwd: string };
  onSelectVersion?: (version: number) => void;
  onOpenMetaAgent?: (next: NativeAgentLoopTemplate) => void;
  onDesignDraftChange?: (next?: NativeTemplateDesignDraft) => void;
  onDesignDraftDiscarded?: () => void;
  onRetryDesignDraft?: (draftId: string) => void;
} = {}) {
  return {
    onSelectVersion,
    onOpenMetaAgent,
    onDesignDraftChange,
    onDesignDraftDiscarded,
    onRetryDesignDraft,
    ...render(<TemplateSurface
      templates={[template]}
      templateVersions={templateVersions}
      selectedTemplate={selectedTemplate}
      runtimeAvailable
      busy={false}
      taskCreationPending={taskCreationPending}
      taskCreationIntent={taskCreationIntent}
      onReturnToTask={() => undefined}
      onSelect={() => undefined}
      onSelectVersion={onSelectVersion}
      onCreate={() => undefined}
      onEdit={() => undefined}
      onCopy={() => undefined}
      onArchive={() => undefined}
      onDelete={() => undefined}
      onError={() => undefined}
      designDraft={designDraft ?? undefined}
      activeDesignDrafts={[]}
      metaAgentOpen={metaAgentOpen}
      metaAgentBusy={false}
      onOpenMetaAgent={onOpenMetaAgent}
      onOpenDesignDraft={() => undefined}
      onRetryDesignDraft={onRetryDesignDraft}
      onCloseMetaAgent={() => undefined}
      onSaveDesignDraft={() => undefined}
      onDesignDraftChange={onDesignDraftChange}
      onDesignDraftDiscarded={onDesignDraftDiscarded}
    />),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

describe("TemplateSurface Draft invalidation", () => {
  beforeEach(() => {
    templateDesignEvents.listener = undefined;
    templateDesignEvents.read.mockReset();
    templateDesignEvents.subscribe.mockReset();
    templateDesignEvents.subscribe.mockImplementation((listener) => {
      templateDesignEvents.listener = listener;
      return () => undefined;
    });
  });

  afterEach(() => {
    templateDesignEvents.listener = undefined;
  });

  it("detaches the active editor on a discarded Draft event instead of projecting it as saved", async () => {
    const view = renderSurface();
    await waitFor(() => expect(templateDesignEvents.listener).toBeTypeOf("function"));

    act(() => templateDesignEvents.listener?.({
      draftId: "template-design-1",
      type: "template_design.draft_discarded",
      revision: 3,
    }));

    expect(view.onDesignDraftDiscarded).toHaveBeenCalledOnce();
    expect(view.onDesignDraftChange).not.toHaveBeenCalled();
    expect(templateDesignEvents.read).not.toHaveBeenCalled();
  });

  it("does not let an earlier Draft read overwrite a newer semantic event", async () => {
    const firstRead = deferred<NativeTemplateDesignDraft | undefined>();
    const secondRead = deferred<NativeTemplateDesignDraft | undefined>();
    templateDesignEvents.read.mockReturnValueOnce(firstRead.promise).mockReturnValueOnce(secondRead.promise);
    const view = renderSurface();
    await waitFor(() => expect(templateDesignEvents.listener).toBeTypeOf("function"));

    act(() => templateDesignEvents.listener?.({
      draftId: "template-design-1",
      type: "template_design.draft_patched",
      revision: 3,
    }));
    act(() => templateDesignEvents.listener?.({
      draftId: "template-design-1",
      type: "template_design.draft_patched",
      revision: 4,
    }));

    await act(async () => { secondRead.resolve(draft(4)); await secondRead.promise; });
    await waitFor(() => expect(view.onDesignDraftChange).toHaveBeenCalledWith(expect.objectContaining({ revision: 4 })));
    await act(async () => { firstRead.resolve(draft(3)); await firstRead.promise; });

    expect(view.onDesignDraftChange).toHaveBeenCalledTimes(1);
  });

  it("inspects a historical Version read-only and seeds AI revision from that exact Version", () => {
    const latest = { ...template, version: 2, name: "Stable Template v2" };
    const view = renderSurface({
      designDraft: null,
      templateVersions: [latest, template],
      selectedTemplate: template,
      metaAgentOpen: false,
    });

    const history = view.getByLabelText("Template 版本历史") as HTMLSelectElement;
    expect(Array.from(history.options, (option) => option.textContent)).toEqual(["v2 · 当前", "v1 · 只读历史"]);
    fireEvent.change(history, { target: { value: "1" } });
    expect(view.onSelectVersion).toHaveBeenCalledWith(1);

    fireEvent.click(view.getByRole("button", { name: "基于此版本修订" }));
    expect(view.onOpenMetaAgent).toHaveBeenCalledWith(template);
  });

  it("shows one explicit retry for an active durable Draft without an OpenCode Session", () => {
    const onRetryDesignDraft = vi.fn();
    const view = renderSurface({
      designDraft: { ...draft(2), providerSessionId: undefined },
      onRetryDesignDraft,
    });

    const dock = within(within(view.container).getByLabelText("Template Meta Agent"));
    expect((dock.getByRole("button", { name: "保存新版本" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(dock.getByRole("button", { name: "重试连接 OpenCode" }));
    expect(onRetryDesignDraft).toHaveBeenCalledWith("template-design-1");
  });

  it("shows a retained Task brief as an editable, unsent Meta Agent input draft", () => {
    const view = renderSurface({
      taskCreationPending: true,
      taskCreationIntent: {
        title: "储能产业链投资研究",
        goal: "比较产业链环节、关键风险与可验证来源。",
        cwd: "/Users/example/Desktop/tempreport/storage-e2e",
      },
    });

    const dock = within(within(view.container).getByLabelText("Template Meta Agent"));
    expect(dock.getByText("待创建 Task 的 AI 起草输入")).toBeTruthy();
    expect(dock.getByText("未发送")).toBeTruthy();
    const prompt = dock.getByLabelText("AI 起草输入草稿") as HTMLTextAreaElement;
    expect(prompt.value).toContain("储能产业链投资研究");
    expect(prompt.value).toContain("/Users/example/Desktop/tempreport/storage-e2e");
    expect(dock.getByText(/不会自动发送、保存或创建 Task/)).toBeTruthy();
  });
});

describe("TaskDialog Template Version selection", () => {
  const current = { ...template, version: 3, name: "Research Loop" };
  const historical = { ...template, version: 2, name: "Research Loop" };

  function renderTaskDialog(overrides: Partial<React.ComponentProps<typeof TaskDialog>> = {}) {
    const props: React.ComponentProps<typeof TaskDialog> = {
      templates: [current],
      templateVersions: [current, historical],
      title: "储能产业链投资研究",
      goal: "比较产业链环节、关键风险与可验证来源。",
      templateId: current.id,
      templateVersion: current.version,
      projectPath: "/Users/example/Desktop/tempreport/storage-e2e",
      projectVerified: true,
      busy: false,
      enabled: true,
      onTitle: vi.fn(),
      onGoal: vi.fn(),
      onTemplate: vi.fn(),
      onTemplateVersion: vi.fn(),
      onProjectPath: vi.fn(),
      onValidateProject: vi.fn(),
      onCreateProjectDirectory: vi.fn().mockResolvedValue(undefined),
      onClose: vi.fn(),
      onCreateTemplate: vi.fn(),
      onCreateManualTemplate: vi.fn(),
      onBrowseTemplateMetaAgent: vi.fn(),
      onCreate: vi.fn(),
      ...overrides,
    };
    return { props, ...render(<TaskDialog {...props} />) };
  }

  it("chooses and displays the exact immutable Template Version", () => {
    const view = renderTaskDialog();
    const versionPicker = view.getByLabelText("Template 版本") as HTMLSelectElement;

    expect(Array.from(versionPicker.options, (option) => option.textContent)).toEqual([
      "请选择版本",
      "v3 · 当前",
      "v2 · 历史",
    ]);
    fireEvent.change(versionPicker, { target: { value: "2" } });
    expect(view.props.onTemplateVersion).toHaveBeenCalledWith(2);
  });

  it("opens Meta Agent drafting only on the explicit action and never creates the Task", () => {
    const view = renderTaskDialog({ templateId: "", templateVersion: undefined, templateVersions: [] });

    fireEvent.click(view.getByRole("button", { name: "让 Meta Agent 起草" }));
    expect(view.props.onCreateTemplate).toHaveBeenCalledOnce();
    expect(view.props.onCreate).not.toHaveBeenCalled();
  });
});

describe("TemplateDialog Provider model controls", () => {
  const models: NativeOpencodeModelCapability[] = [
    {
      id: "opencode-go/gpt-5.6-luna",
      providerId: "opencode-go",
      modelId: "gpt-5.6-luna",
      name: "GPT-5.6 Luna",
      availability: "available",
      status: "available",
      capabilities: { reasoning: true },
      variants: [{ id: "none", reasoningEffort: "none" }, { id: "high", reasoningEffort: "high" }],
    },
    {
      id: "opencode-go/deepseek-v4-flash",
      providerId: "opencode-go",
      modelId: "deepseek-v4-flash",
      name: "DeepSeek V4 Flash",
      availability: "available",
      status: "available",
      capabilities: { reasoning: false },
      variants: [],
    },
  ];

  const editableDraft: React.ComponentProps<typeof TemplateDialog>["draft"] = {
    id: "manual-model-test",
    name: "Model Test",
    source: "manual",
    conductor: { role: "Conductor", model: "opencode-go/gpt-5.6-luna", modelVariant: "high", charter: "Decide." },
    agents: [{
      id: "researcher",
      name: "Researcher",
      kind: "researcher",
      model: "opencode-go/gpt-5.6-luna",
      modelVariant: "high",
      mcp: [],
      skills: [],
      dispatchProfile: { title: "Research", description: "Find verifiable evidence." },
      workerSystemPrompt: "Work from the bounded assignment.",
    }],
    limits: { maxConcurrentSessions: 3, maxDispatchesPerDecision: 3 },
    delivery: { artifactPath: "", ownerAgentId: "" },
  };

  it("uses only Provider-declared model variants and clears a variant when the model changes", () => {
    const onChange = vi.fn();
    const view = render(<TemplateDialog draft={editableDraft} modelCapabilities={models} busy={false} enabled onChange={onChange} onClose={() => undefined} onSave={() => undefined} />);

    const variant = view.getByLabelText("推理强度") as HTMLSelectElement;
    expect(Array.from(variant.options, (option) => option.value)).toEqual(["", "none", "high"]);
    fireEvent.change(variant, { target: { value: "none" } });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({
      agents: [expect.objectContaining({ modelVariant: "none" })],
    }));

    const model = within(view.container).getByLabelText("OpenCode 模型") as HTMLSelectElement;
    fireEvent.change(model, { target: { value: "opencode-go/deepseek-v4-flash" } });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({
      agents: [expect.objectContaining({ model: "opencode-go/deepseek-v4-flash", modelVariant: undefined })],
    }));
  });

  it("keeps an unavailable historical model visible but not selectable", () => {
    const onChange = vi.fn();
    const view = render(<TemplateDialog draft={editableDraft} modelCapabilities={[]} busy={false} enabled onChange={onChange} onClose={() => undefined} onSave={() => undefined} />);

    const model = within(view.container).getByLabelText("OpenCode 模型") as HTMLSelectElement;
    expect(model.disabled).toBe(true);
    expect(Array.from(model.options, (option) => option.textContent)).toEqual(["opencode-go/gpt-5.6-luna（历史快照）"]);
    expect(view.getByText(/官方模型目录暂不可用/)).toBeTruthy();
  });
});

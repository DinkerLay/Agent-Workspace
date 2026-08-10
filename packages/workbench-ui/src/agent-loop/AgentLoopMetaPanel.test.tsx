// @vitest-environment jsdom
import { createElement } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AgentLoopMetaPanel,
  type AgentLoopMetaPanelController,
  type AgentLoopMetaPanelViewModel,
} from "./AgentLoopMetaPanel";

afterEach(cleanup);

describe("AgentLoopMetaPanel", () => {
  it("shows the scoped Meta profile, chat, ordered proposal diff, and separate Apply/Reject actions", async () => {
    const controller = fakeController();
    const onPatchApplied = vi.fn(async () => undefined);
    render(createElement(AgentLoopMetaPanel, {
      controller,
      draftDirty: false,
      onClose: vi.fn(),
      onDockChange: vi.fn(),
      onPatchApplied,
      placement: "floating",
      scope: { kind: "template_design", draftId: "template_draft_1", draftRevision: 3 },
    }));

    expect(await screen.findByRole("heading", { name: "Meta Agent" })).toBeTruthy();
    expect(screen.getByText("Codex · gpt-5.4")).toBeTruthy();
    expect(screen.getByText("把 Worker 的职责收窄，并补充验收条件。")).toBeTruthy();
    const proposal = screen.getByRole("region", { name: "Meta patch proposal" });
    expect(within(proposal).getAllByTestId("meta-diff-path").map((node) => node.textContent)).toEqual([
      "conductor.systemPrompt",
      "agentCards[0].role",
    ]);
    expect(within(proposal).getByText("Worker role 不能为空")).toBeTruthy();
    expect(within(proposal).getByText("确认是否保留原 deliverable")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /发布|创建 Task|启动/i })).toBeNull();

    fireEvent.click(within(proposal).getByRole("button", { name: "应用 patch" }));
    await waitFor(() => expect(controller.applyPatch).toHaveBeenCalledWith({
      expectedDraftRevision: 3,
      proposalId: "meta_patch_1",
      scope: { kind: "template_design", draftId: "template_draft_1", draftRevision: 3 },
    }));
    expect(onPatchApplied).toHaveBeenCalledTimes(1);

    fireEvent.click(within(proposal).getByRole("button", { name: "拒绝 patch" }));
    await waitFor(() => expect(controller.rejectPatch).toHaveBeenCalledWith({
      expectedDraftRevision: 3,
      proposalId: "meta_patch_1",
      scope: { kind: "template_design", draftId: "template_draft_1", draftRevision: 3 },
    }));
  });

  it("keeps close/dock as view-only state and protects a dirty local editor from patch application", async () => {
    const controller = fakeController();
    const onClose = vi.fn();
    const onDockChange = vi.fn();
    render(createElement(AgentLoopMetaPanel, {
      controller,
      draftDirty: true,
      onClose,
      onDockChange,
      placement: "floating",
      scope: { kind: "template_design", draftId: "template_draft_1", draftRevision: 3 },
    }));

    const proposal = await screen.findByRole("region", { name: "Meta patch proposal" });
    expect((within(proposal).getByRole("button", { name: "应用 patch" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/先保存或撤销本地手工修改/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "停靠 Meta panel" }));
    fireEvent.click(screen.getByRole("button", { name: "关闭 Meta panel" }));
    expect(onDockChange).toHaveBeenCalledWith("docked");
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(controller.abandonSession).not.toHaveBeenCalled();
    expect(controller.applyPatch).not.toHaveBeenCalled();
    expect(controller.rejectPatch).not.toHaveBeenCalled();
  });

  it("creates a session only with a Host-issued Meta profile option id", async () => {
    const controller = fakeController();
    vi.mocked(controller.load).mockResolvedValue({
      ...view(),
      profileOptions: [
        { metaProfileOptionId: "meta_option_unavailable", label: "Unavailable option", readiness: "unavailable", unavailableReasons: ["Host probe failed"] },
        { metaProfileOptionId: "meta_option_ready", label: "Ready option", readiness: "available", unavailableReasons: [] },
      ],
      session: undefined,
    });
    render(createElement(AgentLoopMetaPanel, {
      controller,
      onClose: vi.fn(),
      onDockChange: vi.fn(),
      placement: "floating",
      scope: { kind: "task_setup", draftId: "task_setup_draft_1", draftRevision: 2 },
    }));

    const selector = await screen.findByLabelText("Meta profile option");
    expect((screen.getByRole("button", { name: "打开 Meta Session" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(selector, { target: { value: "meta_option_ready" } });
    fireEvent.click(screen.getByRole("button", { name: "打开 Meta Session" }));

    await waitFor(() => expect(controller.createSession).toHaveBeenCalledWith({
      metaProfileOptionId: "meta_option_ready",
      scope: { kind: "task_setup", draftId: "task_setup_draft_1", draftRevision: 2 },
    }));
  });

  it("refreshes the active Meta conversation when Runtime reports configuration completion", async () => {
    let notify: (() => void) | undefined;
    const controller = {
      ...fakeController(),
      subscribe: vi.fn(async (listener: () => void) => {
        notify = listener;
        return () => undefined;
      }),
    };
    vi.mocked(controller.load)
      .mockResolvedValueOnce({
        ...view(),
        session: {
          metaSessionId: "meta_session_1",
          revision: 2,
          status: "creating",
          messages: [{
            messageId: "meta_message_user",
            role: "user",
            content: "请生成一个 HTML 配置 patch。",
            createdAt: "2026-08-09T00:00:00.000Z",
          }],
        },
        proposals: [],
      })
      .mockResolvedValue(view());
    render(createElement(AgentLoopMetaPanel, {
      controller,
      onClose: vi.fn(),
      onDockChange: vi.fn(),
      placement: "floating",
      scope: { kind: "task_setup", draftId: "task_setup_draft_1", draftRevision: 3 },
    }));

    expect(await screen.findByText("creating")).toBeTruthy();
    await waitFor(() => expect(controller.subscribe).toHaveBeenCalledTimes(1));
    act(() => notify?.());

    expect(await screen.findByText("把 Worker 的职责收窄，并补充验收条件。")).toBeTruthy();
    expect(screen.getByRole("region", { name: "Meta patch proposal" })).toBeTruthy();
  });
});

function fakeController(): AgentLoopMetaPanelController & Record<string, ReturnType<typeof vi.fn>> {
  return {
    load: vi.fn(async () => view()),
    createSession: vi.fn(async () => undefined),
    sendMessage: vi.fn(async () => undefined),
    applyPatch: vi.fn(async () => undefined),
    rejectPatch: vi.fn(async () => undefined),
    abandonSession: vi.fn(async () => undefined),
  };
}

function view(): AgentLoopMetaPanelViewModel {
  return {
    profileOptions: [{
      metaProfileOptionId: "meta_option_codex",
      label: "Codex · gpt-5.4",
      detail: "0.146.0",
      readiness: "available",
      unavailableReasons: [],
    }],
    session: {
      metaSessionId: "meta_session_1",
      revision: 2,
      status: "idle",
      messages: [{
        messageId: "meta_message_1",
        role: "assistant",
        content: "把 Worker 的职责收窄，并补充验收条件。",
        createdAt: "2026-08-09T00:00:00.000Z",
      }],
    },
    proposals: [{
      proposalId: "meta_patch_1",
      baseDraftRevision: 3,
      status: "pending",
      summary: "收窄 Worker 责任边界",
      rationale: "减少配置期权限扩张。",
      fieldDiffs: [
        { path: "conductor.systemPrompt", operation: "replace", before: "Coordinate.", after: "Coordinate bounded work." },
        { path: "agentCards[0].role", operation: "replace", before: "Research", after: "Research one scoped claim" },
      ],
      validationIssues: ["Worker role 不能为空"],
      unresolvedItems: ["确认是否保留原 deliverable"],
    }],
  };
}

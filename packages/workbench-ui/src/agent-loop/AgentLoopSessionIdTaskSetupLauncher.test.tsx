// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentLoopSessionIdTaskSetupLauncher } from "./AgentLoopSessionIdTaskSetupLauncher";
import type { AgentLoopConfigurationController } from "./agent-loop-configuration-controller";

afterEach(cleanup);

describe("AgentLoopSessionIdTaskSetupLauncher", () => {
  it("creates only a Setup Draft from the exact latest Version and authorized Workspace", async () => {
    const createTaskSetupDraft = vi.fn(async () => "task_setup_draft_new");
    const onSetupCreated = vi.fn(async () => undefined);
    render(<AgentLoopSessionIdTaskSetupLauncher
      configurationController={{ createTaskSetupDraft } as unknown as AgentLoopConfigurationController}
      onClose={vi.fn()}
      onSetupCreated={onSetupCreated}
      options={{
        templates: [{
          templateId: "template_deep",
          title: "Deep Research",
          versions: [
            { templateVersionId: "version_1", version: 1 },
            { templateVersionId: "version_2", version: 2 },
          ],
        }],
        workspaces: [{ workspaceId: "journey-workspace", displayName: "Journey Workspace" }],
      }}
    />);

    fireEvent.change(screen.getByTestId("task-setup-version"), { target: { value: "latest" } });
    fireEvent.change(screen.getByTestId("task-setup-workspace"), { target: { value: "journey-workspace" } });
    fireEvent.change(screen.getByTestId("task-setup-title"), { target: { value: "Deep Search" } });
    fireEvent.change(screen.getByTestId("task-setup-goal"), { target: { value: "Produce a reviewed report" } });
    fireEvent.click(screen.getByTestId("task-setup-save"));

    await waitFor(() => expect(createTaskSetupDraft).toHaveBeenCalledWith({
      templateVersionId: "version_2",
      workspaceId: "journey-workspace",
      title: "Deep Search",
      goal: "Produce a reviewed report",
    }));
    expect(onSetupCreated).toHaveBeenCalledWith("task_setup_draft_new");
    expect(createTaskSetupDraft).toHaveBeenCalledTimes(1);
  });

  it("rejects a Renderer-invented Workspace before any Host command", async () => {
    const createTaskSetupDraft = vi.fn();
    render(<AgentLoopSessionIdTaskSetupLauncher
      configurationController={{ createTaskSetupDraft } as unknown as AgentLoopConfigurationController}
      onClose={vi.fn()}
      onSetupCreated={vi.fn()}
      options={{
        templates: [{ templateId: "template", title: "Template", versions: [{ templateVersionId: "version", version: 1 }] }],
        workspaces: [{ workspaceId: "workspace_known", displayName: "Known" }],
      }}
    />);

    fireEvent.change(screen.getByTestId("task-setup-workspace"), { target: { value: "/tmp/not-authorized" } });
    fireEvent.change(screen.getByTestId("task-setup-title"), { target: { value: "Task" } });
    fireEvent.change(screen.getByTestId("task-setup-goal"), { target: { value: "Goal" } });
    fireEvent.click(screen.getByTestId("task-setup-save"));

    expect((await screen.findByRole("alert")).textContent).toContain("Host 已授权");
    expect(createTaskSetupDraft).not.toHaveBeenCalled();
  });
});

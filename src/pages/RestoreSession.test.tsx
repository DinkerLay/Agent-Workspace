/**
 * @vitest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { agents, initialTasks } from "../mock/prototypeData";
import type { RestoreManifest } from "../types";
import { RestoreSession } from "./RestoreSession";

const manifest: RestoreManifest = {
  id: "restore-manifest-current",
  projectPath: "/Users/dinker/CODES/Agent-Workspace",
  activeView: "workbench",
  selectedTaskId: "task-pty",
  selectedAgentClusterId: "cluster-agent-workspace-pty-session-manager",
  selectedAgentId: "agent-workspace-pty-session-manager-executor",
  capturedAt: "2026-06-24T13:35:00Z",
  manifestPath: ".agent-workspace/restore/restore-manifest-current.json",
  processRecords: [
    {
      id: "agent-agent-workspace-pty-session-manager-executor",
      label: "Executor agent",
      processClass: "agent-pty",
      workingDir: "/Users/dinker/CODES/Agent-Workspace",
      commandLine: "opencode --model opencode-go/deepseek-v4-flash",
      rollbackIntent: "return Executor to task-pty",
      metadataPath:
        ".agent-workspace/projects/project-agent-workspace/clusters/cluster-agent-workspace-pty-session-manager/sessions/agent-agent-workspace-pty-session-manager-executor.json",
    },
    {
      id: "command-cmd-web",
      label: "Frontend dev server",
      processClass: "dev-command",
      workingDir: "/Users/dinker/CODES/Agent-Workspace",
      commandLine: "npm run dev -- --host 127.0.0.1 --port 5188",
      rollbackIntent: "restart if project restore allows commands",
      metadataPath: ".agent-workspace/commands/cmd-web.json",
    },
  ],
  contextRecords: [
    {
      id: "restore-context-run-pty-active",
      kind: "active-run",
      label: "Active run run-pty-active",
      status: "running",
      taskId: "task-pty",
      artifactPath: ".agent-workspace/runs/run-pty-active/transcript.log",
      summary: "Resume Executor transcript and verification pending",
    },
    {
      id: "restore-context-browser-evidence-task-pty-001",
      kind: "browser-evidence",
      label: "browser_screenshot evidence",
      status: "captured",
      taskId: "task-pty",
      artifactPath: ".agent-workspace/browser/task-pty/browser_screenshot-001.json",
      summary: "Browser evidence remains attached to task-pty",
    },
  ],
};

describe("RestoreSession", () => {
  it("shows restore metadata and exposes capture and restore actions", () => {
    const captures: number[] = [];
    const restores: number[] = [];

    render(
      <RestoreSession
        manifest={manifest}
        selectedAgent={agents[1]}
        selectedTask={initialTasks[1]}
        onCaptureRestoreManifest={() => captures.push(1)}
        onRestoreWorkspaceSession={() => restores.push(1)}
      />,
    );

    expect(screen.getByText("Restore Session Manifest")).toBeTruthy();
    expect(screen.getByText(".agent-workspace/restore/restore-manifest-current.json")).toBeTruthy();
    expect(screen.getByText("Process metadata")).toBeTruthy();
    expect(
      screen.getByText("opencode --model opencode-go/deepseek-v4-flash"),
    ).toBeTruthy();
    expect(screen.getByText("Resume context")).toBeTruthy();
    expect(screen.getByText("Active run run-pty-active")).toBeTruthy();
    expect(screen.getByText(".agent-workspace/runs/run-pty-active/transcript.log")).toBeTruthy();
    expect(screen.getByText("browser_screenshot evidence")).toBeTruthy();
    expect(screen.getByText(".agent-workspace/browser/task-pty/browser_screenshot-001.json")).toBeTruthy();
    expect(screen.getByText("Does not rerun agent reasoning")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Capture restore manifest" }));
    fireEvent.click(screen.getByRole("button", { name: "Restore workspace session" }));

    expect(captures).toEqual([1]);
    expect(restores).toEqual([1]);
  });
});

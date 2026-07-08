/**
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ComponentType } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { teamWorkflows } from "../mock/capabilityData";
import { Teams } from "./Teams";

afterEach(() => {
  cleanup();
});

describe("Teams", () => {
  it("renders an explicit empty state when runtime workflows are unavailable", () => {
    const starts: number[] = [];
    const advances: number[] = [];

    render(
      <Teams
        workflows={[]}
        selectedWorkflowId=""
        activeRun={undefined}
        onSelectWorkflow={() => undefined}
        onStartTeamRun={() => starts.push(1)}
        onAdvanceTeamRun={() => advances.push(1)}
      />,
    );

    expect(screen.getByText("No team workflows configured")).toBeTruthy();
    expect(screen.getByText("Team workflows are advanced capabilities and are disabled for this runtime workspace.")).toBeTruthy();
    const startButton = screen.getByRole("button", { name: "Start selected team workflow" });
    const advanceButton = screen.getByRole("button", { name: "Advance handoff" });
    expect((startButton as HTMLButtonElement).disabled).toBe(true);
    expect((advanceButton as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(startButton);
    fireEvent.click(advanceButton);

    expect(starts).toEqual([]);
    expect(advances).toEqual([]);
  });

  it("selects, starts, and advances explicit team workflow runs", () => {
    const selected: string[] = [];
    const starts: number[] = [];
    const advances: number[] = [];
    const InteractiveTeams = Teams as ComponentType<{
      workflows: typeof teamWorkflows;
      selectedWorkflowId: string;
      activeRun: {
        id: string;
        workflowId: string;
        status: string;
        activeNodeIndex: number;
        cycle: number;
        maxCycles: number;
        handoffPayload: string;
        evidencePath: string;
      };
      onSelectWorkflow: (workflowId: string) => void;
      onStartTeamRun: () => void;
      onAdvanceTeamRun: () => void;
    }>;

    render(
      <InteractiveTeams
        workflows={teamWorkflows}
        selectedWorkflowId="team-research-plan-exec"
        activeRun={{
          id: "team-run-team-research-plan-exec-active",
          workflowId: "team-research-plan-exec",
          status: "running",
          activeNodeIndex: 1,
          cycle: 1,
          maxCycles: 2,
          handoffPayload: "source delta, plan step, verification command, completion criteria",
          evidencePath: ".agent-workspace/teams/team-run-team-research-plan-exec-active/handoff.json",
        }}
        onSelectWorkflow={(workflowId) => selected.push(workflowId)}
        onStartTeamRun={() => starts.push(1)}
        onAdvanceTeamRun={() => advances.push(1)}
      />,
    );

    expect(screen.getByText("Selected workflow")).toBeTruthy();
    expect(screen.getByText("Active TeamRun")).toBeTruthy();
    expect(screen.getByText("最后节点继续推进会进入下一轮，最多 2 个 cycle。")).toBeTruthy();
    expect(screen.getByText("Cycle 1 / 2")).toBeTruthy();
    expect(screen.getByText("Active node: Planner")).toBeTruthy();
    expect(screen.getByText(".agent-workspace/teams/team-run-team-research-plan-exec-active/handoff.json")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Select workflow Dev -> QA -> Reviewer" }));
    fireEvent.click(screen.getByRole("button", { name: "Start selected team workflow" }));
    fireEvent.click(screen.getByRole("button", { name: "Advance handoff for team-run-team-research-plan-exec-active" }));

    expect(selected).toEqual(["team-dev-qa-review"]);
    expect(starts).toEqual([1]);
    expect(advances).toEqual([1]);
  });

  it("shows blocked max-cycle state and disables handoff advance", () => {
    const advances: number[] = [];
    const InteractiveTeams = Teams as ComponentType<{
      workflows: typeof teamWorkflows;
      selectedWorkflowId: string;
      activeRun: {
        id: string;
        workflowId: string;
        status: string;
        activeNodeIndex: number;
        cycle: number;
        maxCycles: number;
        handoffPayload: string;
        evidencePath: string;
      };
      onSelectWorkflow: (workflowId: string) => void;
      onStartTeamRun: () => void;
      onAdvanceTeamRun: () => void;
    }>;

    render(
      <InteractiveTeams
        workflows={teamWorkflows}
        selectedWorkflowId="team-research-plan-exec"
        activeRun={{
          id: "team-run-team-research-plan-exec-active",
          workflowId: "team-research-plan-exec",
          status: "blocked",
          activeNodeIndex: 2,
          cycle: 2,
          maxCycles: 2,
          handoffPayload: "source delta, plan step, verification command, completion criteria",
          evidencePath: ".agent-workspace/teams/team-run-team-research-plan-exec-active/handoff.json",
        }}
        onSelectWorkflow={() => undefined}
        onStartTeamRun={() => undefined}
        onAdvanceTeamRun={() => advances.push(1)}
      />,
    );

    expect(screen.getByText("Max-cycle guard")).toBeTruthy();
    expect(screen.getByText("blocked")).toBeTruthy();
    expect(screen.getAllByText("Cycle 2 / 2").length).toBeGreaterThan(0);
    expect(screen.getByText("Handoff is blocked until user review.")).toBeTruthy();

    const advanceButton = screen.getByRole("button", {
      name: "Max cycle reached for team-run-team-research-plan-exec-active",
    });
    expect((advanceButton as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(advanceButton);

    expect(advances).toEqual([]);
  });
});

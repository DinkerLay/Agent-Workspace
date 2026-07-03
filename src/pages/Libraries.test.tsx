/**
 * @vitest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react";
import type { ComponentType } from "react";
import { describe, expect, it } from "vitest";
import { libraryItems } from "../mock/capabilityData";
import { Libraries } from "./Libraries";

describe("Libraries", () => {
  it("sends prompt templates and attaches skills to the active task context", () => {
    const prompts: string[] = [];
    const skills: string[] = [];
    const InteractiveLibraries = Libraries as ComponentType<{
      items: typeof libraryItems;
      activePromptTemplateId?: string;
      attachedSkillIds: string[];
      promptLibrarySaves: Array<{
        id: string;
        taskId: string;
        sourceDraftPath: string;
        targetPath: string;
        artifactPath: string;
        savedAt: string;
      }>;
      onInjectPrompt: (itemId: string) => void;
      onAttachSkill: (itemId: string) => void;
    }>;

    render(
      <InteractiveLibraries
        items={libraryItems}
        activePromptTemplateId="prompt-planner"
        attachedSkillIds={["skill-writing-plans"]}
        promptLibrarySaves={[
          {
            id: "prompt-save-task-plan-watch-001",
            taskId: "task-plan-watch",
            sourceDraftPath: ".agent-workspace/scratchpad/task-plan-watch.md",
            targetPath: ".agent-workspace/prompts.json",
            artifactPath: ".agent-workspace/prompts/task-plan-watch-001.md",
            savedAt: "2026-06-24T13:40:00Z",
          },
        ]}
        onInjectPrompt={(itemId) => prompts.push(itemId)}
        onAttachSkill={(itemId) => skills.push(itemId)}
      />,
    );

    expect(screen.getByText("Selected prompt")).toBeTruthy();
    expect(screen.getByText("Attached to active task")).toBeTruthy();
    expect(screen.getByText("Saved scratchpad drafts")).toBeTruthy();
    expect(screen.getByText("task-plan-watch")).toBeTruthy();
    expect(screen.getByText(".agent-workspace/prompts/task-plan-watch-001.md")).toBeTruthy();
    expect(screen.getByText("Runtime injection contract")).toBeTruthy();
    expect(screen.getByText("canonical SKILL.md")).toBeTruthy();
    expect(screen.getByText("Codex AGENTS.md managed block")).toBeTruthy();
    expect(screen.getByText("Injected when task starts; Workbench/Loop still own execution")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Send Executor: one plan step implementation to active agent" }));
    fireEvent.click(screen.getByRole("button", { name: "Attach superpowers:verification-before-completion" }));

    expect(prompts).toEqual(["prompt-executor"]);
    expect(skills).toEqual(["skill-verification"]);
  });
});

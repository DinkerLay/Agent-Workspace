/**
 * @vitest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react";
import type { ComponentType } from "react";
import { describe, expect, it } from "vitest";
import { browserTools } from "../mock/capabilityData";
import { initialTasks } from "../mock/prototypeData";
import { BrowserAutomation } from "./BrowserAutomation";

describe("BrowserAutomation", () => {
  it("selects browser tools and captures task-scoped evidence", () => {
    const selectedTools: string[] = [];
    const captures: number[] = [];
    const InteractiveBrowserAutomation = BrowserAutomation as ComponentType<{
      imageSrc: string;
      tools: typeof browserTools;
      selectedTask: typeof initialTasks[number];
      activeToolName: string;
      evidence: Array<{ id: string; taskId: string; toolName: string; summary: string; artifactPath: string }>;
      onSelectTool: (toolName: string) => void;
      onCaptureEvidence: () => void;
    }>;

    render(
      <InteractiveBrowserAutomation
        imageSrc="/browser.jpg"
        tools={browserTools}
        selectedTask={initialTasks[3]}
        activeToolName="browser_screenshot"
        evidence={[
          {
            id: "evidence-1",
            taskId: "task-browser",
            toolName: "browser_screenshot",
            summary: "Screenshot captured for localhost review",
            artifactPath: ".agent-workspace/browser/task-browser/browser_screenshot-001.json",
          },
        ]}
        onSelectTool={(toolName) => selectedTools.push(toolName)}
        onCaptureEvidence={() => captures.push(1)}
      />,
    );

    expect(screen.getByText("Active task")).toBeTruthy();
    expect(screen.getByText("用 Browser MCP mock 验证 localhost 流程")).toBeTruthy();
    expect(screen.getByText("Selected tool")).toBeTruthy();
    expect(screen.getByText(".agent-workspace/browser/task-browser/browser_screenshot-001.json")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Select browser tool browser_click" }));
    fireEvent.click(screen.getByRole("button", { name: "Capture browser evidence for task-browser" }));

    expect(selectedTools).toEqual(["browser_click"]);
    expect(captures).toEqual([1]);
  });
});

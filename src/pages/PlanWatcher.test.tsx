/**
 * @vitest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { initialPrototypeState } from "../mock/prototypeData";
import { PlanWatcher } from "./PlanWatcher";

describe("PlanWatcher", () => {
  it("shows durable sources, watch events, and planner task creation", () => {
    const created: string[] = [];

    render(
      <PlanWatcher
        events={initialPrototypeState.watchEvents}
        sources={initialPrototypeState.watchSources}
        tasks={initialPrototypeState.tasks}
        onCreatePlannerTask={(eventId) => created.push(eventId)}
      />,
    );

    expect(screen.getByText("Research / Spec / Plan Watcher")).toBeTruthy();
    expect(screen.getAllByText("docs/research/").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("docs/superworks/spec/").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("docs/superworks/plans/").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("docs/research/agentsroom-research-2026-06-24.zh.md")).toBeTruthy();
    expect(screen.getByText("docs/superworks/spec/product-interaction-map.md")).toBeTruthy();
    expect(screen.getByText(".agent-workspace/watch/events.jsonl")).toBeTruthy();
    expect(screen.getByText("task-plan-watch")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Create planner task for watch-spec-product-map" }));

    expect(created).toEqual(["watch-spec-product-map"]);
  });
});

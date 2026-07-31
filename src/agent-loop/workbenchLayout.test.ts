import { describe, expect, it } from "vitest";
import {
  canSplitTerminalPane,
  collapseWorkbenchLayoutToBounds,
  defaultWorkbenchLayout,
  leafGroupIds,
  moveSessionToGroup,
  reconcileWorkbenchLayout,
  selectGroupSession,
  splitGroup,
  updateSplitRatio,
} from "./workbenchLayout";

describe("Agent Loop Workbench Group Layout", () => {
  it("automatically opens a second Group when a second native Session arrives", () => {
    const base = defaultWorkbenchLayout(["conductor"]);
    const reconciled = reconcileWorkbenchLayout(base, ["conductor", "researcher"]);

    expect(reconciled.groups.primary.sessionIds).toEqual(["conductor"]);
    expect(reconciled.groups["group-1"].sessionIds).toEqual(["researcher"]);
    expect(leafGroupIds(reconciled.root)).toEqual(["primary", "group-1"]);
  });

  it("automatically opens up to four first Sessions and then uses tabs", () => {
    const layout = reconcileWorkbenchLayout(defaultWorkbenchLayout(["conductor"]), ["conductor", "search-0", "search-1", "reviewer", "publisher"]);

    expect(layout.placementMode).toBe("auto");
    expect(leafGroupIds(layout.root)).toEqual(["primary", "group-1", "group-2", "group-3"]);
    expect(layout.groups.primary.sessionIds).toEqual(["conductor", "publisher"]);
    expect(layout.groups["group-1"].sessionIds).toEqual(["search-0"]);
    expect(layout.groups["group-2"].sessionIds).toEqual(["search-1"]);
    expect(layout.groups["group-3"].sessionIds).toEqual(["reviewer"]);
  });

  it("preserves a manual arrangement when a later Session arrives", () => {
    const initial = defaultWorkbenchLayout(["conductor"]);
    const manualPrimary = { ...initial, placementMode: "manual" as const };
    const base = splitGroup(reconcileWorkbenchLayout(manualPrimary, ["conductor", "search-0"]), "primary", "horizontal", "research");
    const manual = moveSessionToGroup(base, "search-0", "research");
    const reconciled = reconcileWorkbenchLayout(manual, ["conductor", "search-0", "reviewer"]);

    expect(reconciled.placementMode).toBe("manual");
    expect(leafGroupIds(reconciled.root)).toEqual(["primary", "research"]);
    expect(reconciled.groups.primary.sessionIds).toEqual(["conductor", "reviewer"]);
    expect(reconciled.groups.research.sessionIds).toEqual(["search-0"]);
  });

  it("splits a Group without moving or creating a native Session", () => {
    const initial = defaultWorkbenchLayout(["conductor"]);
    const base = selectGroupSession(reconcileWorkbenchLayout({ ...initial, placementMode: "manual" }, ["conductor", "researcher"]), "primary", "researcher");
    const split = splitGroup(base, "primary", "horizontal", "research");

    expect(split.groups.primary.sessionIds).toEqual(["conductor", "researcher"]);
    expect(split.groups.research.sessionIds).toEqual([]);
    expect(leafGroupIds(split.root)).toEqual(["primary", "research"]);
  });

  it("moves an existing Session between Groups and persists bounded split ratios", () => {
    const initial = defaultWorkbenchLayout(["conductor"]);
    const split = splitGroup(selectGroupSession(reconcileWorkbenchLayout({ ...initial, placementMode: "manual" }, ["conductor", "researcher"]), "primary", "researcher"), "primary", "vertical", "review");
    const moved = moveSessionToGroup(split, "researcher", "review");
    const ratio = updateSplitRatio(moved, "", .97);

    expect(ratio.groups.primary.sessionIds).toEqual(["conductor"]);
    expect(ratio.groups.review.sessionIds).toEqual(["researcher"]);
    expect(ratio.root.type).toBe("split");
    expect(ratio.root.type === "split" && ratio.root.ratio).toBe(.85);
  });

  it("keeps Session tabs rather than allowing a native terminal to be split below its usable width", () => {
    const initial = defaultWorkbenchLayout(["conductor"]);
    const split = splitGroup(reconcileWorkbenchLayout({ ...initial, placementMode: "manual" }, ["conductor", "researcher"]), "primary", "horizontal", "research");

    expect(canSplitTerminalPane({ width: 900, height: 600 }, "horizontal")).toBe(false);
    expect(collapseWorkbenchLayoutToBounds(split, { width: 900, height: 600 })).toMatchObject({
      root: { type: "leaf", groupId: "primary" },
      groups: { primary: { sessionIds: ["conductor", "researcher"] } },
    });
  });
});

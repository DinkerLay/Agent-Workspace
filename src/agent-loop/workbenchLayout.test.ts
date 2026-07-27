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
  it("starts with one primary Group and absorbs newly dispatched Sessions without duplicating them", () => {
    const base = defaultWorkbenchLayout(["conductor"]);
    const reconciled = reconcileWorkbenchLayout(base, ["conductor", "researcher"]);

    expect(reconciled.groups.primary.sessionIds).toEqual(["conductor", "researcher"]);
    expect(leafGroupIds(reconciled.root)).toEqual(["primary"]);
  });

  it("splits a Group without moving or creating a native Session", () => {
    const base = selectGroupSession(defaultWorkbenchLayout(["conductor", "researcher"]), "primary", "researcher");
    const split = splitGroup(base, "primary", "horizontal", "research");

    expect(split.groups.primary.sessionIds).toEqual(["conductor", "researcher"]);
    expect(split.groups.research.sessionIds).toEqual([]);
    expect(leafGroupIds(split.root)).toEqual(["primary", "research"]);
  });

  it("moves an existing Session between Groups and persists bounded split ratios", () => {
    const split = splitGroup(selectGroupSession(defaultWorkbenchLayout(["conductor", "researcher"]), "primary", "researcher"), "primary", "vertical", "review");
    const moved = moveSessionToGroup(split, "researcher", "review");
    const ratio = updateSplitRatio(moved, "", .97);

    expect(ratio.groups.primary.sessionIds).toEqual(["conductor"]);
    expect(ratio.groups.review.sessionIds).toEqual(["researcher"]);
    expect(ratio.root.type).toBe("split");
    expect(ratio.root.type === "split" && ratio.root.ratio).toBe(.85);
  });

  it("keeps Session tabs rather than allowing a native terminal to be split below its usable width", () => {
    const split = splitGroup(defaultWorkbenchLayout(["conductor", "researcher"]), "primary", "horizontal", "research");

    expect(canSplitTerminalPane({ width: 900, height: 600 }, "horizontal")).toBe(false);
    expect(collapseWorkbenchLayoutToBounds(split, { width: 900, height: 600 })).toMatchObject({
      root: { type: "leaf", groupId: "primary" },
      groups: { primary: { sessionIds: ["conductor", "researcher"] } },
    });
  });
});

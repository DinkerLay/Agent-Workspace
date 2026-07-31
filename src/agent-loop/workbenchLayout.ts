import type {
  NativeAgentLoopWorkbenchLayout,
  NativeAgentLoopWorkbenchLayoutNode,
} from "../runtime/nativeBridge";

type Group = NativeAgentLoopWorkbenchLayout["groups"][string];
export const MIN_TERMINAL_PANE_WIDTH = 520;
export const MIN_TERMINAL_PANE_HEIGHT = 250;
type PaneBounds = { width: number; height: number };

export function defaultWorkbenchLayout(sessionIds: string[]): NativeAgentLoopWorkbenchLayout {
  return automaticWorkbenchLayout(uniqueSessionIds(sessionIds));
}

/** Deterministic first-use layout: at most four visible native terminal panes;
 * further Sessions become tabs.  Any explicit move/split freezes this policy. */
export function automaticWorkbenchLayout(sessionIds: string[], sourceGroups: Record<string, Group> = {}): NativeAgentLoopWorkbenchLayout {
  const unique = uniqueSessionIds(sessionIds);
  const groupIds = unique.length <= 1 ? ["primary"] : unique.length === 2 ? ["primary", "group-1"] : unique.length === 3 ? ["primary", "group-1", "group-2"] : ["primary", "group-1", "group-2", "group-3"];
  const root: NativeAgentLoopWorkbenchLayoutNode = groupIds.length === 1
    ? { type: "leaf", groupId: "primary" }
    : groupIds.length === 2
      ? { type: "split", direction: "horizontal", ratio: .5, first: { type: "leaf", groupId: "primary" }, second: { type: "leaf", groupId: "group-1" } }
      : groupIds.length === 3
        ? { type: "split", direction: "horizontal", ratio: .5, first: { type: "leaf", groupId: "primary" }, second: { type: "split", direction: "vertical", ratio: .5, first: { type: "leaf", groupId: "group-1" }, second: { type: "leaf", groupId: "group-2" } } }
        : { type: "split", direction: "horizontal", ratio: .5, first: { type: "split", direction: "vertical", ratio: .5, first: { type: "leaf", groupId: "primary" }, second: { type: "leaf", groupId: "group-1" } }, second: { type: "split", direction: "vertical", ratio: .5, first: { type: "leaf", groupId: "group-2" }, second: { type: "leaf", groupId: "group-3" } } };
  const groups = Object.fromEntries(groupIds.map((id) => [id, { id, sessionIds: [] as string[], fontSize: clampFontSize(sourceGroups[id]?.fontSize) }])) as Record<string, Group>;
  unique.forEach((sessionId, index) => groups[groupIds[index % groupIds.length]].sessionIds.push(sessionId));
  for (const group of Object.values(groups)) group.activeSessionId = group.sessionIds.includes(sourceGroups[group.id]?.activeSessionId ?? "") ? sourceGroups[group.id]?.activeSessionId : group.sessionIds[0];
  return {
    version: 1,
    placementMode: "auto",
    root,
    groups,
    focusedGroupId: "primary",
  };
}

/** Mirrors the Runtime normalizer so a new native Session can be placed before
 * its next persisted read finishes. The Runtime remains the durable validator. */
export function reconcileWorkbenchLayout(
  source: NativeAgentLoopWorkbenchLayout | undefined,
  knownSessionIds: string[],
): NativeAgentLoopWorkbenchLayout {
  const known = uniqueSessionIds(knownSessionIds);
  if (!source || source.version !== 1) return defaultWorkbenchLayout(known);
  if (source.placementMode === "auto") return automaticWorkbenchLayout(known, source.groups);
  const groupIds = leafGroupIds(source.root);
  if (!groupIds.length) return defaultWorkbenchLayout(known);
  const assigned = new Set<string>();
  const groups: Record<string, Group> = {};
  for (const id of groupIds) {
    const group = source.groups[id];
    const sessionIds = uniqueSessionIds(group?.sessionIds ?? []).filter((sessionId) => known.includes(sessionId) && !assigned.has(sessionId));
    sessionIds.forEach((sessionId) => assigned.add(sessionId));
    groups[id] = {
      id,
      sessionIds,
      activeSessionId: sessionIds.includes(group?.activeSessionId ?? "") ? group?.activeSessionId : sessionIds[0],
      fontSize: clampFontSize(group?.fontSize),
    };
  }
  const primaryId = groupIds[0];
  for (const sessionId of known) if (!assigned.has(sessionId)) groups[primaryId].sessionIds.push(sessionId);
  if (!groups[primaryId].activeSessionId) groups[primaryId].activeSessionId = groups[primaryId].sessionIds[0];
  return {
    version: 1,
    placementMode: "manual",
    root: source.root,
    groups,
    focusedGroupId: groupIds.includes(source.focusedGroupId) ? source.focusedGroupId : primaryId,
  };
}

export function leafGroupIds(node: NativeAgentLoopWorkbenchLayoutNode): string[] {
  return node.type === "leaf" ? [node.groupId] : [...leafGroupIds(node.first), ...leafGroupIds(node.second)];
}

export function selectGroupSession(
  layout: NativeAgentLoopWorkbenchLayout,
  groupId: string,
  sessionId: string,
): NativeAgentLoopWorkbenchLayout {
  const group = layout.groups[groupId];
  if (!group?.sessionIds.includes(sessionId)) return layout;
  return {
    ...layout,
    focusedGroupId: groupId,
    groups: { ...layout.groups, [groupId]: { ...group, activeSessionId: sessionId } },
  };
}

export function moveSessionToGroup(
  layout: NativeAgentLoopWorkbenchLayout,
  sessionId: string,
  targetGroupId: string,
): NativeAgentLoopWorkbenchLayout {
  if (!layout.groups[targetGroupId]) return layout;
  const groups = Object.fromEntries(
    Object.entries(layout.groups).map(([id, group]) => {
      const sessionIds = group.sessionIds.filter((candidate) => candidate !== sessionId);
      return [id, {
        ...group,
        sessionIds,
        activeSessionId: group.activeSessionId === sessionId ? sessionIds[0] : group.activeSessionId,
      }];
    }),
  ) as Record<string, Group>;
  const target = groups[targetGroupId];
  groups[targetGroupId] = {
    ...target,
    sessionIds: [...target.sessionIds, sessionId],
    activeSessionId: sessionId,
  };
  return { ...layout, placementMode: "manual", groups, focusedGroupId: targetGroupId };
}

export function splitGroup(
  layout: NativeAgentLoopWorkbenchLayout,
  groupId: string,
  direction: "horizontal" | "vertical",
  newGroupId = createGroupId(layout),
): NativeAgentLoopWorkbenchLayout {
  const current = layout.groups[groupId];
  if (!current || layout.groups[newGroupId]) return layout;
  // Splitting changes only the viewing surface. Keep the current native
  // terminal where it is and create an empty sibling; moving a real Session
  // is an explicit second action through drag/drop or the Group + menu.
  const nextGroups = {
    ...layout.groups,
    [groupId]: current,
    [newGroupId]: { id: newGroupId, sessionIds: [], activeSessionId: undefined },
  };
  const root = replaceLeaf(layout.root, groupId, {
    type: "split",
    direction,
    ratio: .5,
    first: { type: "leaf", groupId },
    second: { type: "leaf", groupId: newGroupId },
  });
  return { ...layout, placementMode: "manual", root, groups: nextGroups, focusedGroupId: groupId };
}

export function updateSplitRatio(
  layout: NativeAgentLoopWorkbenchLayout,
  path: string,
  ratio: number,
): NativeAgentLoopWorkbenchLayout {
  return { ...layout, placementMode: "manual", root: updateNodeAtPath(layout.root, path, Math.min(.85, Math.max(.15, ratio)))};
}

export function canSplitTerminalPane(bounds: PaneBounds | undefined, direction: "horizontal" | "vertical") {
  if (!bounds) return true;
  return direction === "horizontal"
    ? bounds.width >= MIN_TERMINAL_PANE_WIDTH * 2
    : bounds.height >= MIN_TERMINAL_PANE_HEIGHT * 2;
}

export function clampSplitRatioForBounds(
  bounds: PaneBounds | undefined,
  direction: "horizontal" | "vertical",
  ratio: number,
) {
  const base = Math.min(.85, Math.max(.15, ratio));
  if (!bounds) return base;
  const minimum = direction === "horizontal" ? MIN_TERMINAL_PANE_WIDTH : MIN_TERMINAL_PANE_HEIGHT;
  const total = direction === "horizontal" ? bounds.width : bounds.height;
  if (total < minimum * 2) return .5;
  const lower = minimum / total;
  return Math.min(1 - lower, Math.max(lower, base));
}

export function setGroupTerminalFontSize(
  layout: NativeAgentLoopWorkbenchLayout,
  groupId: string,
  fontSize: number,
): NativeAgentLoopWorkbenchLayout {
  const group = layout.groups[groupId];
  if (!group) return layout;
  return { ...layout, groups: { ...layout.groups, [groupId]: { ...group, fontSize: clampFontSize(fontSize) } } };
}

/** Collapses persisted splits that no longer have enough physical room for two
 * native TUIs. Sessions stay running; their tabs move into the first leaf. */
export function collapseWorkbenchLayoutToBounds(
  layout: NativeAgentLoopWorkbenchLayout,
  bounds: PaneBounds | undefined,
): NativeAgentLoopWorkbenchLayout {
  if (!bounds || bounds.width <= 0 || bounds.height <= 0) return layout;
  const groups = structuredClone(layout.groups) as Record<string, Group>;
  const collapse = (node: NativeAgentLoopWorkbenchLayoutNode, area: PaneBounds): NativeAgentLoopWorkbenchLayoutNode => {
    if (node.type === "leaf") return node;
    const minimum = node.direction === "horizontal" ? MIN_TERMINAL_PANE_WIDTH : MIN_TERMINAL_PANE_HEIGHT;
    const total = node.direction === "horizontal" ? area.width : area.height;
    if (total < minimum * 2) {
      const leaves = leafGroupIds(node);
      const target = leaves[0];
      const targetGroup = groups[target] ?? { id: target, sessionIds: [] };
      const sessionIds = uniqueSessionIds(leaves.flatMap((id) => groups[id]?.sessionIds ?? []));
      groups[target] = { ...targetGroup, sessionIds, activeSessionId: sessionIds.includes(targetGroup.activeSessionId ?? "") ? targetGroup.activeSessionId : sessionIds[0] };
      return { type: "leaf", groupId: target };
    }
    const firstArea = node.direction === "horizontal"
      ? { width: area.width * node.ratio, height: area.height }
      : { width: area.width, height: area.height * node.ratio };
    const secondArea = node.direction === "horizontal"
      ? { width: area.width * (1 - node.ratio), height: area.height }
      : { width: area.width, height: area.height * (1 - node.ratio) };
    return { ...node, first: collapse(node.first, firstArea), second: collapse(node.second, secondArea) };
  };
  const root = collapse(layout.root, bounds);
  const retained = new Set(leafGroupIds(root));
  const nextGroups = Object.fromEntries(Object.entries(groups).filter(([id]) => retained.has(id)));
  const changed = JSON.stringify(root) !== JSON.stringify(layout.root) || Object.keys(nextGroups).length !== Object.keys(layout.groups).length;
  return changed ? { ...layout, root, groups: nextGroups, focusedGroupId: retained.has(layout.focusedGroupId) ? layout.focusedGroupId : leafGroupIds(root)[0] } : layout;
}

function replaceLeaf(
  node: NativeAgentLoopWorkbenchLayoutNode,
  groupId: string,
  replacement: NativeAgentLoopWorkbenchLayoutNode,
): NativeAgentLoopWorkbenchLayoutNode {
  if (node.type === "leaf") return node.groupId === groupId ? replacement : node;
  return {
    ...node,
    first: replaceLeaf(node.first, groupId, replacement),
    second: replaceLeaf(node.second, groupId, replacement),
  };
}

function updateNodeAtPath(
  node: NativeAgentLoopWorkbenchLayoutNode,
  path: string,
  ratio: number,
): NativeAgentLoopWorkbenchLayoutNode {
  if (!path) return node.type === "split" ? { ...node, ratio } : node;
  if (node.type === "leaf") return node;
  const [part, ...rest] = path.split(".");
  const childPath = rest.join(".");
  return part === "first"
    ? { ...node, first: updateNodeAtPath(node.first, childPath, ratio) }
    : { ...node, second: updateNodeAtPath(node.second, childPath, ratio) };
}

function createGroupId(layout: NativeAgentLoopWorkbenchLayout): string {
  let index = leafGroupIds(layout.root).length + 1;
  while (layout.groups[`group-${index}`]) index += 1;
  return `group-${index}`;
}

function uniqueSessionIds(ids: string[]): string[] {
  return [...new Set(ids.map((id) => String(id).trim()).filter(Boolean))];
}

function clampFontSize(value: unknown) {
  const size = Number(value);
  return Number.isFinite(size) ? Math.min(18, Math.max(8, Math.round(size))) : 11;
}

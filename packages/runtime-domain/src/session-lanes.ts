import type { SessionLaneItemRecord } from "../../runtime-contracts/src";
import { invariant } from "./errors";

const BLOCKING_CLOSE_STATES = new Set<SessionLaneItemRecord["state"]>([
  "held_by_human_intervention",
  "leased",
  "handed",
  "ambiguous",
]);

export function appendSessionLaneItem(input: Readonly<{
  items: readonly SessionLaneItemRecord[];
  item: Omit<SessionLaneItemRecord, "sequence" | "state" | "createdAt" | "updatedAt">;
  initialState?: SessionLaneItemRecord["state"];
  now: string;
}>): SessionLaneItemRecord {
  const scoped = input.items.filter((item) => item.sessionId === input.item.sessionId);
  const sequence = scoped.reduce((maximum, item) => Math.max(maximum, item.sequence), 0) + 1;
  const previous = scoped.find((item) => item.sequence === sequence - 1);
  const state = input.initialState ?? "pending";
  if (input.item.priority === "notice") {
    invariant(Boolean(input.item.causalPredecessorInboxItemId), "session_lane_notice_predecessor_required");
  }
  return Object.freeze({
    ...input.item,
    sequence,
    state,
    ...(input.item.causalPredecessorInboxItemId
      ? {}
      : previous ? { causalPredecessorInboxItemId: previous.inboxItemId } : {}),
    createdAt: input.now,
    updatedAt: input.now,
  });
}
export function assertSessionLaneCanClose(items: readonly SessionLaneItemRecord[], sessionId: string): void {
  invariant(
    !items.some((item) => item.sessionId === sessionId && BLOCKING_CLOSE_STATES.has(item.state)),
    "session_close_lane_not_safe",
  );
}

/** Close suppresses only ordinary Conductor work that was never handed out. */
export function suppressPendingOrdinaryLaneItems(input: Readonly<{
  items: readonly SessionLaneItemRecord[];
  sessionId: string;
  now: string;
  reason: string;
}>): Readonly<{ items: readonly SessionLaneItemRecord[]; affectedInboxItemIds: readonly string[] }> {
  const affectedInboxItemIds: string[] = [];
  const items = input.items.map((item) => {
    if (item.sessionId !== input.sessionId || item.priority !== "ordinary" || item.state !== "pending") return item;
    affectedInboxItemIds.push(item.inboxItemId);
    return Object.freeze({ ...item, state: "suppressed" as const, reason: input.reason, updatedAt: input.now });
  });
  return Object.freeze({ items: Object.freeze(items), affectedInboxItemIds: Object.freeze(affectedInboxItemIds) });
}

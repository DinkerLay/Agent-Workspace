import { describe, expect, it } from "vitest";
import {
  defaultTaskSessionPaneLayout,
  isTaskRunPresentationInteractive,
  normalizeTaskSessionPaneLayout,
  taskSessionWorkspaceItems,
} from "./taskSessionWorkspace";
import type { NativeAgentLoopRunDetail, NativeSessionAgentCard } from "../runtime/nativeBridge";

function turn(input: Partial<NativeAgentLoopRunDetail["turns"][number]> & { sessionId: string; purpose: "conductor" | "session_agent"; card: { id: string; name: string; kind: "conductor" | NativeSessionAgentCard["kind"]; model: string } }): NativeAgentLoopRunDetail["turns"][number] {
  const card = input.purpose === "conductor"
    ? { ...input.card, id: "conductor" as const, kind: "conductor" as const, role: "Conductor", mcp: [], skills: [] }
    : { ...input.card, kind: input.card.kind as NativeSessionAgentCard["kind"], role: "Worker", mcp: [], skills: [], instructions: "", expectedOutput: "" };
  return {
    turnId: `turn-${input.sessionId}`,
    runId: "run-1",
    instanceId: "instance-1",
    nodeId: input.card.id,
    sessionId: input.sessionId,
    purpose: input.purpose,
    status: "idle",
    dispatchStatus: input.dispatchStatus,
    details: { card, dispatches: [] },
  };
}

describe("taskSessionWorkspaceItems", () => {
  it("keeps Task-scoped cards visible but only opens materialized Agent Sessions", () => {
    const run = {
      turns: [
        turn({ sessionId: "searcher", purpose: "session_agent", dispatchStatus: "not_dispatched", card: { id: "searcher", name: "Searcher", kind: "researcher", model: "gpt" } }),
        turn({ sessionId: "conductor", purpose: "conductor", card: { id: "conductor", name: "Conductor", kind: "conductor", model: "gpt" } }),
        turn({ sessionId: "reviewer", purpose: "session_agent", dispatchStatus: "result_available", card: { id: "reviewer", name: "Reviewer", kind: "reviewer", model: "gpt" } }),
      ],
    } as NativeAgentLoopRunDetail;

    expect(taskSessionWorkspaceItems(run)).toEqual([
      expect.objectContaining({ sessionId: "conductor", canOpen: true }),
      expect.objectContaining({ sessionId: "searcher", canOpen: false, dispatchStatus: "not_dispatched" }),
      expect.objectContaining({ sessionId: "reviewer", canOpen: true, dispatchStatus: "result_available" }),
    ]);
  });

  it("bounds persisted widths and retains safe defaults", () => {
    expect(normalizeTaskSessionPaneLayout()).toEqual(defaultTaskSessionPaneLayout);
    expect(normalizeTaskSessionPaneLayout({ taskListWidth: 90, inspectorWidth: 900 })).toEqual({ taskListWidth: 196, inspectorWidth: 420 });
  });

  it("only treats a live Task/Run pair as an interactive official Session page", () => {
    expect(isTaskRunPresentationInteractive("running", "running")).toBe(true);
    expect(isTaskRunPresentationInteractive("delivery_ready", "running")).toBe(true);
    expect(isTaskRunPresentationInteractive("achieved", "achieved")).toBe(false);
    expect(isTaskRunPresentationInteractive("archived", "achieved")).toBe(false);
    expect(isTaskRunPresentationInteractive("stopped", "stopped")).toBe(false);
  });
});

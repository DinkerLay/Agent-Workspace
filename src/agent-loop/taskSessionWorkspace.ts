import type { NativeAgentLoopRunDetail } from "../runtime/nativeBridge";

export type TaskSessionWorkspaceItem = {
  sessionId: string;
  purpose: "conductor" | "session_agent";
  cardId: string;
  name: string;
  kind: string;
  model: string;
  dispatchStatus: string;
  canOpen: boolean;
};

export type TaskSessionPaneLayout = {
  taskListWidth: number;
  inspectorWidth: number;
};

export const defaultTaskSessionPaneLayout: TaskSessionPaneLayout = {
  taskListWidth: 258,
  inspectorWidth: 290,
};

/**
 * An official OpenCode page is a short-lived interactive capability. Historical
 * Task/Run records remain inspectable in the Workbench, but only a live Run may
 * mount a writable Provider page.
 */
export function isTaskRunPresentationInteractive(taskStatus?: string, runStatus?: string): boolean {
  return ["running", "delivery_ready"].includes(String(taskStatus))
    && String(runStatus) === "running";
}

export function taskSessionWorkspaceItems(run?: NativeAgentLoopRunDetail): TaskSessionWorkspaceItem[] {
  const seen = new Set<string>();
  return (run?.turns ?? [])
    .filter((turn) => turn.purpose === "conductor" || turn.purpose === "session_agent")
    .filter((turn) => {
      if (seen.has(turn.sessionId)) return false;
      seen.add(turn.sessionId);
      return true;
    })
    .map((turn) => {
      const dispatchStatus = String(turn.dispatchStatus ?? (turn.purpose === "conductor" ? "ready" : "not_dispatched"));
      return {
        sessionId: turn.sessionId,
        purpose: turn.purpose,
        cardId: turn.details.card.id,
        name: turn.details.card.name,
        kind: turn.details.card.kind,
        model: turn.details.card.model,
        dispatchStatus,
        // The selected Session page is an exact Provider binding. An uncalled
        // card is visible as Task Architecture but must not imitate a Session.
        canOpen: turn.purpose === "conductor" || dispatchStatus !== "not_dispatched",
      };
    })
    .sort((left, right) => Number(right.purpose === "conductor") - Number(left.purpose === "conductor"));
}

export function normalizeTaskSessionPaneLayout(value?: Partial<TaskSessionPaneLayout>): TaskSessionPaneLayout {
  return {
    taskListWidth: boundedWidth(value?.taskListWidth, defaultTaskSessionPaneLayout.taskListWidth),
    inspectorWidth: boundedWidth(value?.inspectorWidth, defaultTaskSessionPaneLayout.inspectorWidth),
  };
}

function boundedWidth(value: unknown, fallback: number) {
  const width = Number(value);
  return Number.isFinite(width) ? Math.round(Math.min(420, Math.max(196, width))) : fallback;
}

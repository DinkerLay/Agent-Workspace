import { hashDefinition, type FileStateAnchor, type WorkspaceFileObservationRecord } from "../../runtime-contracts/src";
import { invariant } from "./errors";

export function createWorkspaceFileObservation(input: Readonly<{
  workspaceFileObservationId: string;
  taskId: string;
  runId?: string;
  workspaceRelativePath: string;
  content?: string;
  state?: WorkspaceFileObservationRecord["state"];
  source: WorkspaceFileObservationRecord["source"];
  now: string;
}>): WorkspaceFileObservationRecord {
  const path = normalizeWorkspaceRelativePath(input.workspaceRelativePath);
  const contentDigest = input.content === undefined ? undefined : hashDefinition(input.content);
  return Object.freeze({
    workspaceFileObservationId: input.workspaceFileObservationId,
    taskId: input.taskId,
    ...(input.runId ? { runId: input.runId } : {}),
    workspaceRelativePath: path,
    ...(contentDigest ? { contentDigest, byteLength: new TextEncoder().encode(input.content).byteLength } : {}),
    state: input.state ?? (input.content === undefined ? "missing" : "available"),
    source: input.source,
    observedAt: input.now,
  });
}
export function createFileStateAnchor(
  observation: WorkspaceFileObservationRecord,
  label?: string,
): FileStateAnchor {
  invariant(observation.state === "available" && Boolean(observation.contentDigest), "file_state_anchor_observation_unavailable");
  return Object.freeze({
    workspaceRelativePath: observation.workspaceRelativePath,
    observedDigest: observation.contentDigest!,
    ...(label ? { label } : {}),
  });
}

function normalizeWorkspaceRelativePath(value: string): string {
  const path = value.trim().normalize("NFC").replaceAll("\\", "/").replace(/^\.\//, "");
  const segments = path.split("/");
  invariant(Boolean(path), "workspace_observation_path_required");
  invariant(!path.startsWith("/") && !/^[a-zA-Z]:\//.test(path), "workspace_observation_path_absolute");
  invariant(segments.every((segment) => Boolean(segment) && segment !== "." && segment !== ".."), "workspace_observation_path_invalid");
  return path;
}

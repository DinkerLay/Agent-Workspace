import type { Project, Task } from "../../types";
import type { OpencodeSessionKeyInput } from "./types";

export function createOpencodeSessionKey(input: OpencodeSessionKeyInput) {
  return `opencode:${safeSegment(input.projectId)}:${safeSegment(input.taskId)}:${safeSegment(input.agentId)}`;
}

export function createOpencodeTaskClusterId(projectId: string, taskId: string) {
  return `cluster-${safeSegment(projectId)}:${safeSegment(taskId)}`;
}

export function safeSegment(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return "empty";

  return Array.from(trimmed)
    .map((char) => (/^[a-zA-Z0-9._-]$/.test(char) ? char : `~${char.codePointAt(0)?.toString(16) ?? "0"}~`))
    .join("");
}

export function createRuntimeProjectId(projectPath: string) {
  return `project-${shortHash(normalizeProjectPath(projectPath))}`;
}

export function createRuntimeTaskId() {
  return `task-${shortHash(`${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`)}`;
}

export function getProjectRuntimeId(project: Pick<Project, "id" | "runtimeProjectId">) {
  return project.runtimeProjectId?.trim() || project.id;
}

export function getTaskRuntimeId(task: Pick<Task, "id" | "runtimeTaskId">) {
  return task.runtimeTaskId?.trim() || task.id;
}

function normalizeProjectPath(projectPath: string) {
  const normalized = projectPath.trim().replace(/\\/g, "/").replace(/\/+$/g, "");
  return normalized || "empty";
}

function shortHash(value: string) {
  let hash = 0x811c9dc5;
  for (const char of value) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193);
  }

  return (hash >>> 0).toString(36).padStart(6, "0").slice(0, 6);
}

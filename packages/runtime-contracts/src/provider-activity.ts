import { cloneJson, type JsonValue } from "./json";

const PROVIDER_ACTIVITY_ID = /^provider_activity_[A-Za-z0-9_-]{1,238}$/u;

export type ProviderActivityStatus = "pending" | "in_progress" | "completed" | "failed";

/**
 * Human-only, rebuildable Provider activity. It is never a collaboration
 * Message and deliberately carries no ACP session, request, tool-call or
 * Binding identity.
 */
export type ProviderActivityReadModel =
  | Readonly<{
      activityId: string;
      kind: "assistant_progress";
      contentKind: "reasoning" | "response";
      content: string;
      observedAt: string;
    }>
  | Readonly<{
      activityId: string;
      kind: "tool";
      title: string;
      status: ProviderActivityStatus;
      /** Owner-approved, human-readable input; never raw ACP/MCP arguments. */
      inputSummary?: string;
      /** Owner-approved, human-readable result; never a raw Provider result. */
      outputSummary?: string;
      observedAt: string;
    }>;

export function validateProviderActivityReadModel(value: unknown): ProviderActivityReadModel {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("provider_activity_read_model_invalid");
  }
  const root = value as Record<string, unknown>;
  const kind = root.kind;
  const required = kind === "assistant_progress"
    ? ["activityId", "content", "contentKind", "kind", "observedAt"]
    : kind === "tool"
      ? ["activityId", "kind", "observedAt", "status", "title"]
      : undefined;
  const optional = kind === "tool" ? ["inputSummary", "outputSummary"] : [];
  if (!required
    || !required.every((key) => Object.hasOwn(root, key))
    || !Object.keys(root).every((key) => required.includes(key) || optional.includes(key))) {
    throw new Error("provider_activity_read_model_invalid");
  }
  requiredText(root.activityId, 256);
  if (!PROVIDER_ACTIVITY_ID.test(root.activityId as string)) {
    throw new Error("provider_activity_read_model_invalid");
  }
  requiredTimestamp(root.observedAt);
  if (kind === "assistant_progress") {
    if (root.contentKind !== "reasoning" && root.contentKind !== "response") {
      throw new Error("provider_activity_read_model_invalid");
    }
    requiredText(root.content, 128 * 1024, true);
  } else {
    requiredText(root.title, 512);
    if (!(["pending", "in_progress", "completed", "failed"] as const).includes(
      root.status as ProviderActivityStatus,
    )) throw new Error("provider_activity_read_model_invalid");
    if (root.inputSummary !== undefined) requiredText(root.inputSummary, 16 * 1024, true);
    if (root.outputSummary !== undefined) requiredText(root.outputSummary, 16 * 1024, true);
  }
  return cloneJson(value as JsonValue) as unknown as ProviderActivityReadModel;
}

function requiredText(value: unknown, max: number, allowNewlines = false): string {
  if (typeof value !== "string" || !value.trim() || value.length > max
    || value.includes("\0") || (!allowNewlines && /[\r\n]/u.test(value))) {
    throw new Error("provider_activity_read_model_invalid");
  }
  return value;
}

function requiredTimestamp(value: unknown): string {
  const text = requiredText(value, 64);
  if (Number.isNaN(Date.parse(text))) throw new Error("provider_activity_read_model_invalid");
  return text;
}

import { createHash } from "node:crypto";
import { failAcp } from "./errors.js";
import { GenerationPrivateIdentityMap } from "./private-identity-map.js";
import { asRecord } from "./qualification.js";
import type {
  AcpPermissionChoiceKind,
  AcpSessionObservation,
  AcpStopReason,
} from "./types.js";

const STOP_REASONS = new Set<AcpStopReason>([
  "end_turn",
  "max_tokens",
  "max_turn_requests",
  "refusal",
  "cancelled",
]);
const TOOL_STATUSES = new Set(["pending", "in_progress", "completed", "failed"] as const);
const PERMISSION_KINDS = new Set<AcpPermissionChoiceKind>([
  "allow_once",
  "allow_always",
  "reject_once",
  "reject_always",
]);
const MAX_SAFE_MESSAGE_CHUNK_LENGTH = 256 * 1024;
const MAX_SAFE_TITLE_LENGTH = 4 * 1024;
const MAX_SAFE_CHOICE_LABEL_LENGTH = 4 * 1024;
const MAX_PERMISSION_OPTIONS = 64;
const FORBIDDEN_OBSERVATION_CONTROL_CHARACTERS =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/u;

export function rawSessionIdFromBindingResponse(response: unknown): string {
  const record = asRecord(response, "acp_binding_response_invalid");
  if (typeof record.sessionId !== "string" || !record.sessionId) {
    failAcp("acp_binding_session_id_invalid");
  }
  return record.sessionId;
}

export function stopReasonFromPromptResponse(response: unknown): AcpStopReason {
  const record = asRecord(response, "acp_prompt_response_invalid");
  if (typeof record.stopReason !== "string" || !STOP_REASONS.has(record.stopReason as AcpStopReason)) {
    failAcp("acp_prompt_stop_reason_invalid");
  }
  return record.stopReason as AcpStopReason;
}

/** Raw message correlation stays inside the managed client generation. */
export function rawMessageIdFromSessionNotification(
  notificationValue: unknown,
): string | undefined {
  const notification = asRecord(notificationValue, "acp_session_update_invalid");
  const update = asRecord(notification.update, "acp_session_update_payload_invalid");
  if (update.sessionUpdate !== "agent_message_chunk") {
    failAcp("acp_agent_message_update_invalid");
  }
  if (update.messageId === undefined || update.messageId === null) return undefined;
  if (typeof update.messageId !== "string" || !update.messageId) {
    failAcp("acp_agent_message_id_invalid");
  }
  return update.messageId;
}

export function normalizeSessionNotification(input: {
  readonly notification: unknown;
  readonly identities: GenerationPrivateIdentityMap;
  readonly bindingHandle: string;
  readonly attemptId: string;
  readonly privateDirectories: readonly string[];
}): AcpSessionObservation | undefined {
  const notification = asRecord(input.notification, "acp_session_update_invalid");
  if (typeof notification.sessionId !== "string") failAcp("acp_session_update_id_invalid");
  const expectedBinding = input.identities.bindingForRawSession(notification.sessionId);
  if (expectedBinding !== input.bindingHandle) failAcp("acp_session_update_fence_mismatch");
  const update = asRecord(notification.update, "acp_session_update_payload_invalid");
  const kind = update.sessionUpdate;
  if (kind === "agent_message_chunk") {
    const content = asRecord(update.content, "acp_agent_message_content_invalid");
    input.identities.rememberPrivateValue(
      rawMessageIdFromSessionNotification(input.notification),
    );
    if (content.type !== "text") return undefined;
    const text = redactSafeObservationText({
      value: content.text,
      identities: input.identities,
      privateDirectories: input.privateDirectories,
      maxLength: MAX_SAFE_MESSAGE_CHUNK_LENGTH,
      code: "acp_agent_message_text_invalid",
      allowEmpty: true,
    });
    return {
      kind: "agent_message_chunk",
      bindingHandle: input.bindingHandle,
      attemptId: input.attemptId,
      text,
    };
  }
  if (kind === "tool_call" || kind === "tool_call_update") {
    if (typeof update.toolCallId !== "string" || !update.toolCallId) {
      failAcp("acp_tool_call_id_invalid");
    }
    const status = TOOL_STATUSES.has(update.status as never)
      ? update.status as "pending" | "in_progress" | "completed" | "failed"
      : undefined;
    const toolCallHandle = input.identities.toolHandleFor({
      bindingHandle: input.bindingHandle,
      attemptId: input.attemptId,
      rawToolCallId: update.toolCallId,
      create: kind === "tool_call",
    });
    const title = optionalRedactedSafeObservationText({
      value: update.title,
      identities: input.identities,
      privateDirectories: input.privateDirectories,
      maxLength: MAX_SAFE_TITLE_LENGTH,
      code: "acp_tool_title_invalid",
    });
    return {
      kind: "tool_status",
      bindingHandle: input.bindingHandle,
      attemptId: input.attemptId,
      toolCallHandle,
      ...(title ? { title } : {}),
      ...(status ? { status } : {}),
    };
  }
  return undefined;
}

export function normalizePermissionRequest(input: {
  readonly request: unknown;
  readonly identities: GenerationPrivateIdentityMap;
  readonly bindingHandle: string;
  readonly attemptId: string;
  readonly privateDirectories: readonly string[];
}): Extract<AcpSessionObservation, { kind: "interaction_requested" }> {
  const request = asRecord(input.request, "acp_permission_request_invalid");
  if (typeof request.sessionId !== "string") failAcp("acp_permission_session_id_invalid");
  if (input.identities.bindingForRawSession(request.sessionId) !== input.bindingHandle) {
    failAcp("acp_permission_binding_fence_mismatch");
  }
  const toolCall = asRecord(request.toolCall, "acp_permission_tool_call_invalid");
  if (typeof toolCall.toolCallId !== "string" || !toolCall.toolCallId) {
    failAcp("acp_permission_tool_call_id_invalid");
  }
  if (!Array.isArray(request.options)) failAcp("acp_permission_options_invalid");
  if (request.options.length > MAX_PERMISSION_OPTIONS) {
    failAcp("acp_permission_options_invalid");
  }
  const rawOptions = request.options.map((value) => {
    const option = asRecord(value, "acp_permission_option_invalid");
    if (typeof option.optionId !== "string" || !option.optionId) {
      failAcp("acp_permission_option_id_invalid");
    }
    if (typeof option.name !== "string" || !option.name) {
      failAcp("acp_permission_option_name_invalid");
    }
    if (typeof option.kind !== "string" || !PERMISSION_KINDS.has(option.kind as AcpPermissionChoiceKind)) {
      failAcp("acp_permission_option_kind_invalid");
    }
    return {
      rawOptionId: option.optionId,
      name: option.name,
      kind: option.kind as AcpPermissionChoiceKind,
    };
  });
  // The complete raw identity set must be private before any Agent-controlled
  // title or label is projected. Otherwise one option can echo another raw ID.
  input.identities.rememberPrivateValue(request.sessionId);
  input.identities.rememberPrivateValue(toolCall.toolCallId);
  for (const option of rawOptions) {
    input.identities.rememberPrivateValue(option.rawOptionId);
  }
  const options = rawOptions.map((option) => ({
    ...option,
    name: redactSafeObservationText({
      value: option.name,
      identities: input.identities,
      privateDirectories: input.privateDirectories,
      maxLength: MAX_SAFE_CHOICE_LABEL_LENGTH,
      code: "acp_permission_option_name_invalid",
      allowEmpty: false,
    }),
  }));
  const permission = input.identities.createPermission({
    bindingHandle: input.bindingHandle,
    attemptId: input.attemptId,
    rawToolCallId: toolCall.toolCallId,
    options,
  });
  const safeTitle = optionalRedactedSafeObservationText({
    value: toolCall.title,
    identities: input.identities,
    privateDirectories: input.privateDirectories,
    maxLength: MAX_SAFE_TITLE_LENGTH,
    code: "acp_tool_title_invalid",
  });
  const safeStatus = TOOL_STATUSES.has(toolCall.status as never)
    ? toolCall.status as "pending" | "in_progress" | "completed" | "failed"
    : undefined;
  const promptDigest = `sha256:${createHash("sha256").update(stableJson({
    ...(safeTitle ? { title: safeTitle } : {}),
    ...(safeStatus ? { status: safeStatus } : {}),
    choices: options.map(({ name, kind }) => ({ name, kind })),
  })).digest("hex")}`;
  return {
    kind: "interaction_requested",
    bindingHandle: input.bindingHandle,
    attemptId: input.attemptId,
    promptDigest,
    ...permission,
  };
}

function optionalRedactedSafeObservationText(input: {
  readonly value: unknown;
  readonly identities: GenerationPrivateIdentityMap;
  readonly privateDirectories: readonly string[];
  readonly maxLength: number;
  readonly code: string;
}): string | undefined {
  if (input.value === undefined || input.value === null || input.value === "") {
    return undefined;
  }
  return redactSafeObservationText({ ...input, allowEmpty: false });
}

function redactSafeObservationText(input: {
  readonly value: unknown;
  readonly identities: GenerationPrivateIdentityMap;
  readonly privateDirectories: readonly string[];
  readonly maxLength: number;
  readonly code: string;
  readonly allowEmpty: boolean;
}): string {
  const raw = requireSafeObservationText(
    input.value,
    input.maxLength,
    input.code,
    input.allowEmpty,
  );
  return requireSafeObservationText(
    input.identities.redact(raw, input.privateDirectories),
    input.maxLength,
    input.code,
    input.allowEmpty,
  );
}

function requireSafeObservationText(
  value: unknown,
  maxLength: number,
  code: string,
  allowEmpty: boolean,
): string {
  if (
    typeof value !== "string"
    || (!allowEmpty && value.length === 0)
    || value.length > maxLength
    || FORBIDDEN_OBSERVATION_CONTROL_CHARACTERS.test(value)
  ) failAcp(code);
  return value;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

import {
  hashDefinition,
  type InputSubmissionRecord,
  type RelayBlockRecord,
  type RelayBlockSourceRange,
  type SessionInboxItemRecord,
  type SessionMessageKind,
  type SessionMessageRecord,
} from "../../runtime-contracts/src";
import { invariant } from "./errors";

/** Bump only when the grammar or its semantic interpretation deliberately changes. */
export const RELAY_PARSER_VERSION = 1;
export const MAX_RELAY_BLOCKS_PER_MESSAGE = 32;
export const MAX_RELAY_BLOCK_CHARACTERS = 16_384;

export type CreateSessionMessageInput = Readonly<{
  messageId: string;
  taskId: string;
  runId: string;
  kind: SessionMessageKind;
  content: string;
  createdAt: string;
  sourceLogicalSessionId?: string;
  sourceSessionTurnId?: string;
  sourceHumanInterventionId?: string;
  invocationId?: string;
  taskGoalCompilerVersion?: "task-goal/v1";
}>;

/**
 * Creates the sole immutable record that contains collaboration text.  Do not
 * trim or normalize content: a forwarded complete Message must retain its raw
 * body byte-for-byte (within JavaScript string semantics).
 */
export function createSessionMessage(input: CreateSessionMessageInput): SessionMessageRecord {
  invariant(input.messageId.startsWith("message_"), "session_message_id_invalid");
  invariant(input.taskId.startsWith("task_"), "session_message_task_id_invalid");
  invariant(input.runId.startsWith("run_"), "session_message_run_id_invalid");
  invariant(Boolean(input.content.trim()), "session_message_content_required");
  if (input.sourceLogicalSessionId) invariant(input.sourceLogicalSessionId.startsWith("logical_session_"), "session_message_source_session_invalid");
  if (input.sourceSessionTurnId) invariant(input.sourceSessionTurnId.startsWith("session_turn_"), "session_message_source_turn_invalid");
  if (input.sourceHumanInterventionId) invariant(input.sourceHumanInterventionId.startsWith("human_intervention_"), "session_message_human_intervention_invalid");
  if (input.invocationId) invariant(input.invocationId.startsWith("invocation_"), "session_message_invocation_invalid");
  if (input.kind === "agent_final") {
    invariant(Boolean(input.sourceLogicalSessionId), "agent_final_source_session_required");
    invariant(Boolean(input.sourceSessionTurnId), "agent_final_source_turn_required");
  }
  if (input.kind === "task_goal") {
    invariant(input.taskGoalCompilerVersion === "task-goal/v1", "task_goal_compiler_version_required");
  } else {
    invariant(input.taskGoalCompilerVersion === undefined, "task_goal_compiler_version_not_allowed");
  }
  return {
    messageId: input.messageId,
    taskId: input.taskId,
    runId: input.runId,
    ...(input.sourceLogicalSessionId ? { sourceLogicalSessionId: input.sourceLogicalSessionId } : {}),
    ...(input.sourceSessionTurnId ? { sourceSessionTurnId: input.sourceSessionTurnId } : {}),
    ...(input.sourceHumanInterventionId ? { sourceHumanInterventionId: input.sourceHumanInterventionId } : {}),
    ...(input.invocationId ? { invocationId: input.invocationId } : {}),
    kind: input.kind,
    content: input.content,
    contentDigest: hashDefinition(input.content),
    ...(input.taskGoalCompilerVersion ? { taskGoalCompilerVersion: input.taskGoalCompilerVersion } : {}),
    createdAt: input.createdAt,
  };
}

/**
 * Extracts only the canonical fenced relay grammar.  Malformed blocks are
 * deliberately ignored here and remain ordinary text in the source Message.
 */
export function extractRelayBlocks(input: Readonly<{
  message: SessionMessageRecord;
}>): readonly RelayBlockRecord[] {
  const content = input.message.content;
  const blocks: RelayBlockRecord[] = [];
  const opening = /^```relay[\t ]*\r?\n/gm;
  let match: RegExpExecArray | null;
  while ((match = opening.exec(content)) !== null && blocks.length < MAX_RELAY_BLOCKS_PER_MESSAGE) {
    const start = match.index;
    const bodyStart = opening.lastIndex;
    const closing = findClosingFence(content, bodyStart);
    if (!closing) continue;
    // Advance the opening scan beyond this fenced region.  This prevents a
    // nested opener from being independently treated as a valid second block.
    opening.lastIndex = closing.end;
    const rawBody = content.slice(bodyStart, closing.start);
    const parsed = parseRelayBody(rawBody);
    if (!parsed) continue;
    const sourceRange: RelayBlockSourceRange = { start, end: closing.end };
    const ordinal = blocks.length;
    const contentDigest = hashDefinition(parsed.content);
    const relayBlockId = deterministicRelayBlockId({
      sourceMessageId: input.message.messageId,
      ordinal,
      sourceRange,
      contentDigest,
      parserVersion: RELAY_PARSER_VERSION,
    });
    blocks.push({
      relayBlockId,
      sourceMessageId: input.message.messageId,
      ordinal,
      suggestedTargetAgentCardIds: parsed.suggestedTargetAgentCardIds,
      ...(parsed.suggestedAudience ? { suggestedAudience: parsed.suggestedAudience } : {}),
      ...(parsed.topic ? { topic: parsed.topic } : {}),
      format: parsed.format,
      content: parsed.content,
      contentDigest,
      parserVersion: RELAY_PARSER_VERSION,
      sourceRange,
      createdAt: input.message.createdAt,
    });
  }
  return Object.freeze(blocks);
}

export type CreateSessionInboxItemInput = Readonly<{
  inboxItemId: string;
  taskId: string;
  runId: string;
  targetLogicalSessionId: string;
  renderedMessageId: string;
  forwardId?: string;
  humanInterventionId?: string;
  replyToLogicalSessionId?: string;
  createdAt: string;
}>;

export function createSessionInboxItem(input: CreateSessionInboxItemInput): SessionInboxItemRecord {
  invariant(input.inboxItemId.startsWith("inbox_"), "session_inbox_id_invalid");
  invariant(input.taskId.startsWith("task_"), "session_inbox_task_id_invalid");
  invariant(input.runId.startsWith("run_"), "session_inbox_run_id_invalid");
  invariant(input.targetLogicalSessionId.startsWith("logical_session_"), "session_inbox_target_invalid");
  invariant(input.renderedMessageId.startsWith("message_"), "session_inbox_rendered_message_invalid");
  if (input.forwardId) invariant(input.forwardId.startsWith("message_forward_"), "session_inbox_forward_invalid");
  if (input.humanInterventionId) invariant(input.humanInterventionId.startsWith("human_intervention_"), "session_inbox_human_intervention_invalid");
  if (input.replyToLogicalSessionId) invariant(input.replyToLogicalSessionId.startsWith("logical_session_"), "session_inbox_reply_target_invalid");
  return {
    inboxItemId: input.inboxItemId,
    taskId: input.taskId,
    runId: input.runId,
    targetLogicalSessionId: input.targetLogicalSessionId,
    renderedMessageId: input.renderedMessageId,
    ...(input.forwardId ? { forwardId: input.forwardId } : {}),
    ...(input.humanInterventionId ? { humanInterventionId: input.humanInterventionId } : {}),
    ...(input.replyToLogicalSessionId ? { replyToLogicalSessionId: input.replyToLogicalSessionId } : {}),
    state: "pending",
    revision: 1,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  };
}

/** A crashed lease is recoverable; an ambiguous Provider delivery is not. */
export function recoverExpiredInboxLease(item: SessionInboxItemRecord, now: string): SessionInboxItemRecord {
  if (item.state !== "leased" || !item.leaseExpiresAt || Date.parse(item.leaseExpiresAt) > Date.parse(now)) return item;
  return {
    ...item,
    state: "pending",
    leaseId: undefined,
    leaseExpiresAt: undefined,
    revision: item.revision + 1,
    updatedAt: now,
  };
}

export function claimSessionInboxItem(item: SessionInboxItemRecord, input: Readonly<{
  leaseId: string;
  leaseExpiresAt: string;
  now: string;
}>): SessionInboxItemRecord {
  invariant(item.state === "pending", "session_inbox_not_claimable");
  invariant(input.leaseId.length > 0, "session_inbox_lease_id_required");
  invariant(Date.parse(input.leaseExpiresAt) > Date.parse(input.now), "session_inbox_lease_expiry_invalid");
  return {
    ...item,
    state: "leased",
    leaseId: input.leaseId,
    leaseExpiresAt: input.leaseExpiresAt,
    revision: item.revision + 1,
    updatedAt: input.now,
  };
}

export function stageSessionInboxDelivery(item: SessionInboxItemRecord, input: Readonly<{
  leaseId: string;
  inputSubmissionId: string;
  now: string;
}>): SessionInboxItemRecord {
  invariant(item.state === "leased", "session_inbox_not_leased");
  invariant(item.leaseId === input.leaseId, "session_inbox_lease_mismatch");
  invariant(input.inputSubmissionId.startsWith("input_"), "session_inbox_input_id_invalid");
  return {
    ...item,
    state: "delivery_staged",
    leaseId: undefined,
    leaseExpiresAt: undefined,
    deliveryInputSubmissionId: input.inputSubmissionId,
    revision: item.revision + 1,
    updatedAt: input.now,
  };
}

/** Maps a durable Input state back to the Inbox state without reinterpreting provider text. */
export function settleSessionInboxFromInput(item: SessionInboxItemRecord, input: InputSubmissionRecord, now: string): SessionInboxItemRecord {
  if (input.sourceInboxItemId !== item.inboxItemId || item.deliveryInputSubmissionId !== input.inputSubmissionId) return item;
  if (item.state !== "delivery_staged") return item;
  if (input.status === "provider_received" || input.status === "turn_active" || input.status === "completed" || input.status === "failed" || input.status === "cancelled") {
    return { ...item, state: "delivered", revision: item.revision + 1, updatedAt: now };
  }
  if (input.status === "ambiguous") return { ...item, state: "ambiguous", revision: item.revision + 1, updatedAt: now };
  if (input.status === "provider_rejected") return { ...item, state: "suppressed", revision: item.revision + 1, updatedAt: now };
  return item;
}

export type ResolvedMessageSelection =
  | Readonly<{ kind: "full_message"; message: SessionMessageRecord }>
  | Readonly<{ kind: "relay_block"; relayBlock: RelayBlockRecord }>;

/** Validates routing semantics after Storage has resolved typed IDs. */
export function assertRelaySelectionsAllowed(input: Readonly<{
  selections: readonly ResolvedMessageSelection[];
}>): void {
  invariant(input.selections.length > 0, "message_selection_required");
  const identities = input.selections.map((selection) => selection.kind === "full_message"
    ? `message:${selection.message.messageId}`
    : `relay:${selection.relayBlock.relayBlockId}`);
  invariant(new Set(identities).size === identities.length, "message_selection_duplicate");
}

/**
 * The rendered body remains ordinary Message text. Headers make the explicit
 * disclosure auditable while the original full Message / Relay body remains
 * intact and no Artifact or provider transcript is resolved.
 */
export function renderMessageSelections(selections: readonly ResolvedMessageSelection[]): string {
  invariant(selections.length > 0, "message_selection_required");
  return selections.map((selection) => {
    if (selection.kind === "full_message") {
      return `[完整转递消息 ${selection.message.messageId}]\n${selection.message.content}\n[完整转递消息结束 ${selection.message.messageId}]`;
    }
    const relay = selection.relayBlock;
    const details = [
      `转递块 ${relay.relayBlockId}`,
      `来源 ${relay.sourceMessageId}`,
      ...(relay.topic ? [`主题 ${relay.topic}`] : []),
      `格式 ${relay.format}`,
    ].join("；");
    return `[${details}]\n${relay.content}\n[转递块结束 ${relay.relayBlockId}]`;
  }).join("\n\n");
}

export function renderAgentAssignment(input: Readonly<{
  instruction: string;
  acceptanceCriteria: readonly string[];
  requestedArtifacts?: readonly string[];
  selections: readonly ResolvedMessageSelection[];
}>): string {
  invariant(Boolean(input.instruction.trim()), "invocation_instruction_required");
  invariant(input.acceptanceCriteria.length > 0, "invocation_acceptance_criteria_required");
  const criteria = input.acceptanceCriteria.map((criterion) => {
    invariant(Boolean(criterion.trim()), "invocation_acceptance_criterion_required");
    return `- ${criterion}`;
  }).join("\n");
  const requestedArtifacts = normalizeRequestedArtifactPaths(input.requestedArtifacts ?? []);
  const artifacts = requestedArtifacts.length > 0
    ? `\n\n## 请求产物\n${requestedArtifacts.map((artifact) => `- ${artifact}`).join("\n")}\n\n请在完整 final 中为每个产物单独写一行 \`Artifact: <项目相对路径>\`；不要添加链接、代码引号或路径后缀。`
    : "";
  const relays = input.selections.length > 0 ? `\n\n## 已选择的消息\n${renderMessageSelections(input.selections)}` : "";
  return `# 本次任务\n${input.instruction}\n\n## 验收标准\n${criteria}${artifacts}${relays}`;
}

export function normalizeRequestedArtifactPaths(paths: readonly string[]): readonly string[] {
  if (!Array.isArray(paths) || paths.length > 32) {
    throw new Error("invocation_requested_artifact_count_invalid");
  }
  const normalized = paths.map((value) => {
    if (typeof value !== "string") throw new Error("invocation_requested_artifact_path_invalid");
    const candidate = value.trim().normalize("NFC").replaceAll("\\", "/").replace(/^\.\//, "");
    const segments = candidate.split("/");
    if (
      !candidate
      || candidate.length > 512
      || candidate.startsWith("/")
      || /^[a-zA-Z]:\//.test(candidate)
      || candidate.startsWith("//")
      || /[\u0000-\u001f\u007f]/.test(candidate)
      || segments.some((segment) => !segment || segment === "." || segment === "..")
    ) {
      throw new Error("invocation_requested_artifact_path_invalid");
    }
    return candidate;
  });
  if (new Set(normalized).size !== normalized.length) {
    throw new Error("invocation_requested_artifact_duplicate");
  }
  if (normalized.reduce((total, candidate) => total + candidate.length, 0) > 8_192) {
    throw new Error("invocation_requested_artifact_total_length_exceeded");
  }
  return Object.freeze(normalized);
}

export function renderRelayForward(selections: readonly ResolvedMessageSelection[]): string {
  return `# 转递消息\n${renderMessageSelections(selections)}`;
}

/**
 * An Inbox always delivers Message-derived content, never Provider state. A
 * relay Inbox is deliberately rendered from its selected block IDs, never the
 * raw source Message, so a precise block relay cannot disclose private text.
 */
export function renderInboxDelivery(
  item: SessionInboxItemRecord,
  message: SessionMessageRecord,
  relayBlocks: readonly RelayBlockRecord[] = [],
): string {
  invariant(item.renderedMessageId === message.messageId, "session_inbox_message_mismatch");
  invariant(item.taskId === message.taskId && item.runId === message.runId, "session_inbox_message_scope_mismatch");
  invariant(relayBlocks.length === 0, "session_inbox_rendered_message_only");
  return message.content;
}

function findClosingFence(source: string, from: number): { readonly start: number; readonly end: number } | undefined {
  const closing = /^```[\t ]*(?:\r?\n|$)/gm;
  closing.lastIndex = from;
  const match = closing.exec(source);
  if (!match) return undefined;
  return { start: match.index, end: closing.lastIndex };
}

function parseRelayBody(rawBody: string): {
  readonly suggestedTargetAgentCardIds: readonly string[];
  readonly suggestedAudience?: "one" | "publish";
  readonly topic?: string;
  readonly format: RelayBlockRecord["format"];
  readonly content: string;
} | undefined {
  if (rawBody.length > MAX_RELAY_BLOCK_CHARACTERS || /^```relay[\t ]*$/m.test(rawBody)) return undefined;
  const divider = /^---[\t ]*\r?$/m.exec(rawBody);
  if (!divider || divider.index === undefined) return undefined;
  const dividerEnd = divider.index + divider[0].length;
  const headers = rawBody.slice(0, divider.index).replace(/\r\n/g, "\n");
  const content = rawBody.slice(dividerEnd).replace(/^\r?\n/, "");
  if (!content.trim()) return undefined;
  const values = new Map<string, string>();
  for (const line of headers.split("\n")) {
    if (!line) continue;
    const match = /^([a-z]+):[\t ]*(.*)$/.exec(line);
    if (!match) return undefined;
    const key = match[1]!;
    const value = match[2]!.trim();
    if (!RELAY_HEADER_KEYS.has(key) || !value || values.has(key)) return undefined;
    values.set(key, value);
  }
  const formatValue = values.get("format") ?? "text/markdown";
  if (formatValue !== "text/markdown" && formatValue !== "application/json") return undefined;
  const topic = values.get("topic");
  if (topic && topic.length > 160) return undefined;
  const targetText = values.get("to");
  const suggestedTargetAgentCardIds = targetText
    ? targetText.split(",").map((value) => value.trim()).filter(Boolean)
    : [];
  if (new Set(suggestedTargetAgentCardIds).size !== suggestedTargetAgentCardIds.length) return undefined;
  if (suggestedTargetAgentCardIds.some((id) => !id.startsWith("agent_card_"))) return undefined;
  const audience = values.get("audience");
  if (audience !== undefined && audience !== "one" && audience !== "publish") return undefined;
  return {
    suggestedTargetAgentCardIds,
    ...(audience ? { suggestedAudience: audience } : {}),
    ...(topic ? { topic } : {}),
    format: formatValue,
    content,
  };
}

function deterministicRelayBlockId(input: Readonly<{
  sourceMessageId: string;
  ordinal: number;
  sourceRange: RelayBlockSourceRange;
  contentDigest: string;
  parserVersion: number;
}>): string {
  const digest = hashDefinition({
    sourceMessageId: input.sourceMessageId,
    ordinal: input.ordinal,
    sourceRange: { start: input.sourceRange.start, end: input.sourceRange.end },
    contentDigest: input.contentDigest,
    parserVersion: input.parserVersion,
  }).replace(/[^a-zA-Z0-9-]/g, "");
  return `relay_block_${digest}`;
}

const RELAY_HEADER_KEYS = new Set(["to", "audience", "topic", "format"]);

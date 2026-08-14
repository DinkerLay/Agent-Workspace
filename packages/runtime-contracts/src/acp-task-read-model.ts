import type { AcpProfileReadinessObservation } from "./acp-profile-readiness";
import { validateAcpProfileReadinessObservation } from "./acp-profile-readiness";
import { assertJsonValue, cloneJson, type JsonValue } from "./json";
import { assertSessionExecutionSafeValue } from "./session-execution-runtime";
import type {
  ACPAgentKind,
  AgentCardKind,
  ProviderCapability,
  ProviderFamily,
} from "./templates";
import {
  type ProviderActivityReadModel,
  validateProviderActivityReadModel,
} from "./provider-activity";

export type SessionIdAcpTaskDirectoryState =
  | "no_session"
  | "available"
  | "busy"
  | "human_blocked"
  | "interaction_required"
  | "reconciling"
  | "closed"
  | "faulted";

export type SessionIdAcpTaskProfileReadModel = Readonly<{
  schemaVersion: 3;
  executionProfileId: string;
  profileRevisionId: string;
  providerFamily: ProviderFamily;
  acpAgentKind: ACPAgentKind;
  model: string;
  role: AgentCardKind;
  permissionMode: "ask" | "preapproved" | "deny";
  allowedTools: readonly string[];
  requiredCapabilities: readonly ProviderCapability[];
  requiredExtensions: readonly string[];
  readiness: AcpProfileReadinessObservation;
  mutableDuringRun: false;
}>;

/** Current routing Binding only; its identity/handle and Host-private recovery data are absent. */
export type SessionIdAcpTaskBindingReadModel = Readonly<{
  label: string;
  status: "active" | "recovering";
  recoverable: boolean;
}>;

export type SessionIdAcpTaskInboxDeliveryReadModel = Readonly<{
  inboxItemId: string;
  targetLogicalSessionId: string;
  route: "message" | "forward" | "human";
  forwardId?: string;
  humanInterventionId?: string;
  state: "pending" | "leased" | "delivery_staged" | "delivered" | "ambiguous" | "suppressed";
  deliveryInputSubmissionId?: string;
  createdAt: string;
  updatedAt: string;
}>;

export type SessionIdAcpTaskRelayBlockReadModel = Readonly<{
  relayBlockId: string;
  ordinal: number;
  suggestedTargetAgentCardIds: readonly string[];
  suggestedAudience?: "one" | "publish";
  topic?: string;
  format: "text/markdown" | "application/json";
  content: string;
  contentDigest: string;
  createdAt: string;
}>;

export type SessionIdAcpTaskMessageReadModel = Readonly<{
  messageId: string;
  kind: "task_goal" | "user_input" | "conductor_forward" | "agent_final" | "runtime_notice";
  content: string;
  contentDigest: string;
  sourceLogicalSessionId?: string;
  sourceSessionTurnId?: string;
  sourceHumanInterventionId?: string;
  sourceLabel?: string;
  runtimeNoticeKind?:
    | "delivery_unknown"
    | "delivery_rejected"
    | "session_failed"
    | "human_interrupt_confirmed"
    | "conductor_interrupt_confirmed"
    | "interrupt_unknown"
    | "late_final"
    | "human_input_suppressed";
  referencedMessageIds?: readonly string[];
  createdAt: string;
  relayBlocks: readonly SessionIdAcpTaskRelayBlockReadModel[];
  inboxDeliveries: readonly SessionIdAcpTaskInboxDeliveryReadModel[];
}>;

/** Collaboration execution plus a separate human-only Provider activity projection. */
export type SessionIdAcpTaskExecutionGroupReadModel = Readonly<{
  executionGroupId: string;
  logicalSessionId: string;
  providerFamily: ProviderFamily;
  sessionTurnId?: string;
  inputSubmissionId?: string;
  finalMessageId?: string;
  status:
    | "pending"
    | "running"
    | "waiting_for_interaction"
    | "awaiting_final"
    | "ambiguous"
    | "completed"
    | "failed"
    | "cancelled";
  startedAt: string;
  updatedAt: string;
  activities: readonly ProviderActivityReadModel[];
}>;

export type SessionIdAcpTaskInteractionReadModel = Readonly<{
  interactionId: string;
  interactionRevision: number;
  choices: readonly Readonly<{ choiceId: string; label: string }>[];
}>;

export type SessionIdAcpTaskControlReadModel = Readonly<{
  sessionControlAuditId: string;
  kind: "conductor_interrupt" | "human_interrupt" | "task_stop" | "close";
  state: "requested" | "accepted" | "confirmed" | "unknown" | "rejected" | "closed";
  requestedAt: string;
  settledAt?: string;
  reason?: string;
}>;

export type SessionIdAcpTaskHumanDeliveryReadModel = Readonly<{
  humanInterventionId: string;
  mode: "direct_message" | "interrupt_then_send";
  content: string;
  conductorMirrorMessageId: string;
  conductorMirrorSequence: number;
  cardMessageId: string;
  cardSequence: number;
  cardState: "pending" | "held" | "delivered" | "suppressed";
  deliverySessionTurnId?: string;
  createdAt: string;
}>;

export type SessionIdAcpTaskSessionReadModel = Readonly<{
  logicalSessionId: string;
  agentCardId: string;
  title: string;
  kind: "conductor" | "card";
  generation: number;
  lifecycle: "current" | "closed" | "faulted";
  state: SessionIdAcpTaskDirectoryState;
  hasReceivedFirstInstruction: boolean;
  profile: SessionIdAcpTaskProfileReadModel;
  binding?: SessionIdAcpTaskBindingReadModel;
  messages: readonly SessionIdAcpTaskMessageReadModel[];
  executionGroups: readonly SessionIdAcpTaskExecutionGroupReadModel[];
  interactions: readonly SessionIdAcpTaskInteractionReadModel[];
  controls: readonly SessionIdAcpTaskControlReadModel[];
  humanDeliveries: readonly SessionIdAcpTaskHumanDeliveryReadModel[];
}>;

export type SessionIdAcpTaskTimelineKind =
  | "task_created"
  | "run_started"
  | "run_stopped"
  | "session_generation_created"
  | "session_generation_closed"
  | "message_created"
  | "input_state"
  | "turn_state"
  | "control_state"
  | "interaction_state"
  | "human_intervention_state"
  | "workspace_observed"
  | "achievement_recorded"
  | "stop_requested";

export type SessionIdAcpTaskTimelineItemReadModel = Readonly<{
  timelineItemId: string;
  kind: SessionIdAcpTaskTimelineKind;
  occurredAt: string;
  title: string;
  status?: string;
  detail?: string;
  logicalSessionId?: string;
  generation?: number;
  messageId?: string;
  inputSubmissionId?: string;
  sessionTurnId?: string;
  sessionControlAuditId?: string;
  interactionId?: string;
  humanInterventionId?: string;
  observationId?: string;
}>;

export type SessionIdAcpTaskFileObservationReadModel = Readonly<{
  observationId: string;
  workspaceRelativePath: string;
  observedAt: string;
  contentDigest?: string;
  currentState: "available" | "missing" | "changed" | "too_large" | "unsupported";
  source: "verified_tool" | "unverified";
}>;

export type SessionIdAcpTaskReadModel = Readonly<{
  taskId: string;
  title: string;
  goal: string;
  revision: number;
  runId: string;
  runStatus: "starting" | "running" | "waiting_attention" | "stopping" | "stopped" | "failed" | "cancellation_unknown";
  conductorLogicalSessionId: string;
  planningFence?: Readonly<{
    planningFenceId: string;
    revision: number;
    currentConductorSessionTurnId: string;
    advancedAt: string;
  }>;
  directory: readonly Readonly<{
    agentCardId: string;
    title: string;
    state: SessionIdAcpTaskDirectoryState;
    currentLogicalSessionId?: string;
    currentGeneration?: number;
    detail?: string;
  }>[];
  sessions: readonly SessionIdAcpTaskSessionReadModel[];
  timeline: readonly SessionIdAcpTaskTimelineItemReadModel[];
  files: readonly SessionIdAcpTaskFileObservationReadModel[];
}>;

const ROOT_REQUIRED_KEYS = new Set([
  "taskId", "title", "goal", "revision", "runId", "runStatus", "conductorLogicalSessionId",
  "directory", "sessions", "timeline", "files",
]);
const ROOT_OPTIONAL_KEYS = new Set(["planningFence"]);

const ALLOWED_KEYS = new Set([
  ...ROOT_REQUIRED_KEYS,
  ...ROOT_OPTIONAL_KEYS,
  "planningFenceId", "currentConductorSessionTurnId", "advancedAt",
  "agentCardId", "state", "currentLogicalSessionId", "currentGeneration", "detail",
  "logicalSessionId", "kind", "generation", "lifecycle", "hasReceivedFirstInstruction", "profile",
  "binding", "messages", "executionGroups", "interactions", "controls", "humanDeliveries",
  "schemaVersion", "executionProfileId", "profileRevisionId", "providerFamily", "acpAgentKind", "model",
  "role", "permissionMode", "allowedTools", "requiredCapabilities", "requiredExtensions", "readiness",
  "mutableDuringRun", "status", "recoverable", "label",
  "messageId", "content", "contentDigest", "sourceLogicalSessionId", "sourceSessionTurnId",
  "sourceHumanInterventionId", "sourceLabel", "runtimeNoticeKind", "referencedMessageIds", "createdAt",
  "relayBlocks", "inboxDeliveries", "relayBlockId", "ordinal", "suggestedTargetAgentCardIds",
  "suggestedAudience", "topic", "format", "inboxItemId", "targetLogicalSessionId", "route", "forwardId",
  "humanInterventionId", "deliveryInputSubmissionId", "updatedAt",
  "executionGroupId", "sessionTurnId", "inputSubmissionId", "finalMessageId", "startedAt", "activities",
  "activityId", "contentKind", "observedAt",
  "interactionId", "interactionRevision", "choices", "choiceId",
  "sessionControlAuditId", "requestedAt", "settledAt", "reason",
  "mode", "conductorMirrorMessageId", "conductorMirrorSequence", "cardMessageId", "cardSequence",
  "cardState", "deliverySessionTurnId",
  "timelineItemId", "occurredAt", "inputSubmissionId", "observationId",
  "workspaceRelativePath", "observedAt", "currentState", "source",
  "reasons", "missingCapabilities", "missingExtensions", "observedProtocolMajor", "observedAgent",
  "observedArtifactVersion", "observedUpstreamVersion", "observedCapabilities", "observedExtensions",
  "name", "version",
]);

const FORBIDDEN_LEGACY_KEYS = new Set([
  "attention", "attentions", "attentionid", "providerfact", "providerfacts", "bindingid", "bindinghandle",
  "sessionexecutionattemptid", "activeattemptid", "prompt", "promptdigest", "receiptdigest",
]);

/**
 * Validates the public Task read boundary, including rejection of every known
 * direct-Provider/Attention/private identity key. Domain-specific projectors
 * remain responsible for constructing semantically correlated owner facts.
 */
export function validateSessionIdAcpTaskReadModel(value: unknown): SessionIdAcpTaskReadModel {
  assertSessionExecutionSafeValue(value, "ACP Task read model");
  assertJsonValue(value, "ACP Task read model");
  const root = exactObject(value, ROOT_REQUIRED_KEYS, ROOT_OPTIONAL_KEYS, "acp_task_read_model_shape_invalid");
  assertAllowedKeys(root, "ACP Task read model");
  requiredString(root.taskId, "task", "acp_task_read_model_task_invalid");
  requiredString(root.runId, "run", "acp_task_read_model_run_invalid");
  requiredString(root.conductorLogicalSessionId, "logical_session", "acp_task_read_model_conductor_invalid");
  displayText(root.title, "acp_task_read_model_title_invalid");
  displayText(root.goal, "acp_task_read_model_goal_invalid", 50_000);
  enumValue(root.runStatus, [
    "starting", "running", "waiting_attention", "stopping", "stopped", "failed", "cancellation_unknown",
  ], "acp_task_read_model_run_status_invalid");
  if (!Number.isSafeInteger(root.revision) || Number(root.revision) < 1) {
    throw new Error("acp_task_read_model_revision_invalid");
  }
  if (!Array.isArray(root.directory) || !Array.isArray(root.sessions)
    || !Array.isArray(root.timeline) || !Array.isArray(root.files)) {
    throw new Error("acp_task_read_model_collections_invalid");
  }
  for (const session of root.sessions) validateSession(session);
  for (const entry of root.directory) validateDirectory(entry);
  for (const entry of root.timeline) validateTimeline(entry);
  for (const entry of root.files) validateFile(entry);
  if (root.planningFence !== undefined) {
    const fence = shape(
      root.planningFence,
      ["planningFenceId", "revision", "currentConductorSessionTurnId", "advancedAt"],
      [],
      "acp_task_read_model_planning_fence_invalid",
    );
    requiredString(fence.planningFenceId, "planning_fence", "acp_task_read_model_planning_fence_invalid");
    requiredString(fence.currentConductorSessionTurnId, "session_turn", "acp_task_read_model_planning_fence_invalid");
    positiveInteger(fence.revision, "acp_task_read_model_planning_fence_invalid");
    isoTimestamp(fence.advancedAt, "acp_task_read_model_planning_fence_invalid");
  }
  return cloneJson(value as JsonValue) as unknown as SessionIdAcpTaskReadModel;
}

function validateSession(value: unknown): void {
  const session = shape(value, [
    "logicalSessionId", "agentCardId", "title", "kind", "generation", "lifecycle", "state",
    "hasReceivedFirstInstruction", "profile", "messages", "executionGroups", "interactions", "controls",
    "humanDeliveries",
  ], ["binding"], "acp_task_read_model_session_invalid");
  requiredString(session.logicalSessionId, "logical_session", "acp_task_read_model_session_invalid");
  requiredString(session.agentCardId, "agent_card", "acp_task_read_model_session_invalid");
  displayText(session.title, "acp_task_read_model_session_invalid");
  enumValue(session.kind, ["conductor", "card"], "acp_task_read_model_session_invalid");
  positiveInteger(session.generation, "acp_task_read_model_session_invalid");
  enumValue(session.lifecycle, ["current", "closed", "faulted"], "acp_task_read_model_session_invalid");
  enumValue(session.state, [
    "no_session", "available", "busy", "human_blocked", "interaction_required", "reconciling", "closed", "faulted",
  ], "acp_task_read_model_session_invalid");
  if (typeof session.hasReceivedFirstInstruction !== "boolean") throw new Error("acp_task_read_model_session_invalid");
  const profile = shape(session.profile, [
    "schemaVersion", "executionProfileId", "profileRevisionId", "providerFamily", "acpAgentKind", "model", "role",
    "permissionMode", "allowedTools", "requiredCapabilities", "requiredExtensions", "readiness", "mutableDuringRun",
  ], [], "acp_task_read_model_profile_invalid");
  if (profile.schemaVersion !== 3 || profile.mutableDuringRun !== false) {
    throw new Error("acp_task_read_model_profile_invalid");
  }
  requiredString(profile.executionProfileId, "profile", "acp_task_read_model_profile_invalid");
  requiredString(profile.profileRevisionId, "profile_revision", "acp_task_read_model_profile_invalid");
  enumValue(profile.providerFamily, ["opencode", "codex", "claude-code"], "acp_task_read_model_profile_invalid");
  enumValue(profile.acpAgentKind, ["native_acp", "codex_acp", "claude_agent_acp"], "acp_task_read_model_profile_invalid");
  enumValue(profile.role, [
    "conductor", "general", "researcher", "implementer", "reviewer", "publisher",
  ], "acp_task_read_model_profile_invalid");
  enumValue(profile.permissionMode, ["ask", "preapproved", "deny"], "acp_task_read_model_profile_invalid");
  displayText(profile.model, "acp_task_read_model_profile_invalid");
  stringArray(profile.allowedTools, "acp_task_read_model_profile_invalid");
  stringArray(profile.requiredCapabilities, "acp_task_read_model_profile_invalid");
  stringArray(profile.requiredExtensions, "acp_task_read_model_profile_invalid");
  const readiness = validateAcpProfileReadinessObservation(profile.readiness);
  if (readiness.profileRevisionId !== profile.profileRevisionId
    || readiness.providerFamily !== profile.providerFamily
    || readiness.acpAgentKind !== profile.acpAgentKind
    || readiness.role !== profile.role
    || readiness.model !== profile.model) {
    throw new Error("acp_task_read_model_readiness_scope_mismatch");
  }
  if (!Array.isArray(session.messages) || !Array.isArray(session.executionGroups)
    || !Array.isArray(session.interactions) || !Array.isArray(session.controls)
    || !Array.isArray(session.humanDeliveries)) {
    throw new Error("acp_task_read_model_session_collections_invalid");
  }
  if (session.binding !== undefined) validateBinding(session.binding);
  for (const message of session.messages) validateMessage(message);
  for (const execution of session.executionGroups) validateExecution(execution);
  for (const interaction of session.interactions) {
    const item = shape(interaction, ["interactionId", "interactionRevision", "choices"], [],
      "acp_task_read_model_interaction_invalid");
    requiredString(item.interactionId, "interaction", "acp_task_read_model_interaction_invalid");
    if (!Number.isSafeInteger(item.interactionRevision) || Number(item.interactionRevision) < 1
      || !Array.isArray(item.choices) || item.choices.length < 1) {
      throw new Error("acp_task_read_model_interaction_invalid");
    }
    for (const choice of item.choices) {
      const projected = shape(choice, ["choiceId", "label"], [], "acp_task_read_model_choice_invalid");
      requiredString(projected.choiceId, "choice", "acp_task_read_model_choice_invalid");
      if (typeof projected.label !== "string" || !projected.label.trim()) {
        throw new Error("acp_task_read_model_choice_invalid");
      }
    }
  }
  for (const control of session.controls) validateControl(control);
  for (const delivery of session.humanDeliveries) validateHumanDelivery(delivery);
}

function validateDirectory(value: unknown): void {
  const entry = shape(value, ["agentCardId", "title", "state", "detail"],
    ["currentLogicalSessionId", "currentGeneration"], "acp_task_read_model_directory_invalid");
  requiredString(entry.agentCardId, "agent_card", "acp_task_read_model_directory_invalid");
  displayText(entry.title, "acp_task_read_model_directory_invalid");
  enumValue(entry.state, [
    "no_session", "available", "busy", "human_blocked", "interaction_required", "reconciling", "closed", "faulted",
  ], "acp_task_read_model_directory_invalid");
  displayText(entry.detail, "acp_task_read_model_directory_invalid");
  if (entry.currentLogicalSessionId !== undefined) {
    requiredString(entry.currentLogicalSessionId, "logical_session", "acp_task_read_model_directory_invalid");
    positiveInteger(entry.currentGeneration, "acp_task_read_model_directory_invalid");
  } else if (entry.currentGeneration !== undefined) {
    throw new Error("acp_task_read_model_directory_invalid");
  }
}

function validateTimeline(value: unknown): void {
  const item = shape(value, ["timelineItemId", "kind", "occurredAt", "title"], [
    "status", "detail", "logicalSessionId", "generation", "messageId", "inputSubmissionId", "sessionTurnId",
    "sessionControlAuditId", "interactionId", "humanInterventionId", "observationId",
  ], "acp_task_read_model_timeline_invalid");
  requiredString(item.timelineItemId, "timeline", "acp_task_read_model_timeline_invalid");
  enumValue(item.kind, [
    "task_created", "run_started", "run_stopped", "session_generation_created", "session_generation_closed",
    "message_created", "input_state", "turn_state", "control_state", "interaction_state",
    "human_intervention_state", "workspace_observed", "achievement_recorded", "stop_requested",
  ], "acp_task_read_model_timeline_invalid");
  isoTimestamp(item.occurredAt, "acp_task_read_model_timeline_invalid");
  displayText(item.title, "acp_task_read_model_timeline_invalid");
  if (item.status !== undefined) displayText(item.status, "acp_task_read_model_timeline_invalid");
  if (item.detail !== undefined) displayText(item.detail, "acp_task_read_model_timeline_invalid", 2_000);
  if (item.logicalSessionId !== undefined) {
    requiredString(item.logicalSessionId, "logical_session", "acp_task_read_model_timeline_invalid");
  }
  if (item.generation !== undefined) positiveInteger(item.generation, "acp_task_read_model_timeline_invalid");
}

function validateFile(value: unknown): void {
  const file = shape(value, ["observationId", "workspaceRelativePath", "observedAt", "currentState", "source"],
    ["contentDigest"], "acp_task_read_model_file_invalid");
  requiredString(file.observationId, "workspace_file_observation", "acp_task_read_model_file_invalid");
  if (typeof file.workspaceRelativePath !== "string" || !file.workspaceRelativePath
    || file.workspaceRelativePath.startsWith("/") || file.workspaceRelativePath.includes("\\")
    || file.workspaceRelativePath.split("/").some((part) => part === ".." || !part)) {
    throw new Error("acp_task_read_model_workspace_path_invalid");
  }
  isoTimestamp(file.observedAt, "acp_task_read_model_file_invalid");
  enumValue(file.currentState, ["available", "missing", "changed", "too_large", "unsupported"],
    "acp_task_read_model_file_invalid");
  enumValue(file.source, ["verified_tool", "unverified"], "acp_task_read_model_file_invalid");
  if (file.contentDigest !== undefined) displayText(file.contentDigest, "acp_task_read_model_file_invalid");
}

function validateBinding(value: unknown): void {
  const binding = shape(value, ["label", "status", "recoverable"], [], "acp_task_read_model_binding_invalid");
  displayText(binding.label, "acp_task_read_model_binding_invalid");
  enumValue(binding.status, ["active", "recovering"], "acp_task_read_model_binding_invalid");
  if (typeof binding.recoverable !== "boolean") throw new Error("acp_task_read_model_binding_invalid");
}

function validateMessage(value: unknown): void {
  const message = shape(value, [
    "messageId", "kind", "content", "contentDigest", "createdAt", "relayBlocks", "inboxDeliveries",
  ], [
    "sourceLogicalSessionId", "sourceSessionTurnId", "sourceHumanInterventionId", "sourceLabel", "runtimeNoticeKind",
    "referencedMessageIds",
  ], "acp_task_read_model_message_invalid");
  requiredString(message.messageId, "message", "acp_task_read_model_message_invalid");
  enumValue(message.kind, ["task_goal", "user_input", "conductor_forward", "agent_final", "runtime_notice"],
    "acp_task_read_model_message_invalid");
  displayText(message.content, "acp_task_read_model_message_invalid", 50_000);
  displayText(message.contentDigest, "acp_task_read_model_message_invalid");
  isoTimestamp(message.createdAt, "acp_task_read_model_message_invalid");
  if (message.sourceLogicalSessionId !== undefined) {
    requiredString(message.sourceLogicalSessionId, "logical_session", "acp_task_read_model_message_invalid");
  }
  if (message.runtimeNoticeKind !== undefined) enumValue(message.runtimeNoticeKind, [
    "delivery_unknown", "delivery_rejected", "session_failed", "human_interrupt_confirmed",
    "conductor_interrupt_confirmed", "interrupt_unknown", "late_final", "human_input_suppressed",
  ], "acp_task_read_model_message_invalid");
  if (message.referencedMessageIds !== undefined) stringArray(message.referencedMessageIds,
    "acp_task_read_model_message_invalid");
  if (!Array.isArray(message.relayBlocks) || !Array.isArray(message.inboxDeliveries)) {
    throw new Error("acp_task_read_model_message_invalid");
  }
  for (const relay of message.relayBlocks) validateRelay(relay);
  for (const delivery of message.inboxDeliveries) validateInboxDelivery(delivery);
}

function validateRelay(value: unknown): void {
  const relay = shape(value, [
    "relayBlockId", "ordinal", "suggestedTargetAgentCardIds", "format", "content", "contentDigest", "createdAt",
  ], ["suggestedAudience", "topic"], "acp_task_read_model_relay_invalid");
  requiredString(relay.relayBlockId, "relay", "acp_task_read_model_relay_invalid");
  nonNegativeInteger(relay.ordinal, "acp_task_read_model_relay_invalid");
  stringArray(relay.suggestedTargetAgentCardIds, "acp_task_read_model_relay_invalid");
  enumValue(relay.format, ["text/markdown", "application/json"], "acp_task_read_model_relay_invalid");
  displayText(relay.content, "acp_task_read_model_relay_invalid", 50_000);
  displayText(relay.contentDigest, "acp_task_read_model_relay_invalid");
  isoTimestamp(relay.createdAt, "acp_task_read_model_relay_invalid");
}

function validateInboxDelivery(value: unknown): void {
  const delivery = shape(value, [
    "inboxItemId", "targetLogicalSessionId", "route", "state", "createdAt", "updatedAt",
  ], ["forwardId", "humanInterventionId", "deliveryInputSubmissionId"], "acp_task_read_model_delivery_invalid");
  requiredString(delivery.inboxItemId, "inbox", "acp_task_read_model_delivery_invalid");
  requiredString(delivery.targetLogicalSessionId, "logical_session", "acp_task_read_model_delivery_invalid");
  enumValue(delivery.route, ["message", "forward", "human"], "acp_task_read_model_delivery_invalid");
  enumValue(delivery.state, ["pending", "leased", "delivery_staged", "delivered", "ambiguous", "suppressed"],
    "acp_task_read_model_delivery_invalid");
  isoTimestamp(delivery.createdAt, "acp_task_read_model_delivery_invalid");
  isoTimestamp(delivery.updatedAt, "acp_task_read_model_delivery_invalid");
}

function validateExecution(value: unknown): void {
  const execution = shape(value, [
    "executionGroupId", "logicalSessionId", "providerFamily", "status", "startedAt", "updatedAt", "activities",
  ], ["sessionTurnId", "inputSubmissionId", "finalMessageId"], "acp_task_read_model_execution_invalid");
  requiredString(execution.executionGroupId, "execution_group", "acp_task_read_model_execution_invalid");
  requiredString(execution.logicalSessionId, "logical_session", "acp_task_read_model_execution_invalid");
  enumValue(execution.providerFamily, ["opencode", "codex", "claude-code"], "acp_task_read_model_execution_invalid");
  enumValue(execution.status, [
    "pending", "running", "waiting_for_interaction", "awaiting_final", "ambiguous", "completed", "failed", "cancelled",
  ], "acp_task_read_model_execution_invalid");
  isoTimestamp(execution.startedAt, "acp_task_read_model_execution_invalid");
  isoTimestamp(execution.updatedAt, "acp_task_read_model_execution_invalid");
  if (!Array.isArray(execution.activities) || execution.activities.length > 256) {
    throw new Error("acp_task_read_model_execution_activity_invalid");
  }
  for (const activity of execution.activities) validateProviderActivityReadModel(activity);
}

function validateControl(value: unknown): void {
  const control = shape(value, ["sessionControlAuditId", "kind", "state", "requestedAt"],
    ["settledAt", "reason"], "acp_task_read_model_control_invalid");
  requiredString(control.sessionControlAuditId, "session_control", "acp_task_read_model_control_invalid");
  enumValue(control.kind, ["conductor_interrupt", "human_interrupt", "task_stop", "close"],
    "acp_task_read_model_control_invalid");
  enumValue(control.state, ["requested", "accepted", "confirmed", "unknown", "rejected", "closed"],
    "acp_task_read_model_control_invalid");
  isoTimestamp(control.requestedAt, "acp_task_read_model_control_invalid");
  if (control.settledAt !== undefined) isoTimestamp(control.settledAt, "acp_task_read_model_control_invalid");
}

function validateHumanDelivery(value: unknown): void {
  const delivery = shape(value, [
    "humanInterventionId", "mode", "content", "conductorMirrorMessageId", "conductorMirrorSequence", "cardMessageId",
    "cardSequence", "cardState", "createdAt",
  ], ["deliverySessionTurnId"], "acp_task_read_model_human_delivery_invalid");
  requiredString(delivery.humanInterventionId, "human_intervention", "acp_task_read_model_human_delivery_invalid");
  enumValue(delivery.mode, ["direct_message", "interrupt_then_send"], "acp_task_read_model_human_delivery_invalid");
  displayText(delivery.content, "acp_task_read_model_human_delivery_invalid", 50_000);
  requiredString(delivery.conductorMirrorMessageId, "message", "acp_task_read_model_human_delivery_invalid");
  requiredString(delivery.cardMessageId, "message", "acp_task_read_model_human_delivery_invalid");
  positiveInteger(delivery.conductorMirrorSequence, "acp_task_read_model_human_delivery_invalid");
  positiveInteger(delivery.cardSequence, "acp_task_read_model_human_delivery_invalid");
  enumValue(delivery.cardState, ["pending", "held", "delivered", "suppressed"],
    "acp_task_read_model_human_delivery_invalid");
  isoTimestamp(delivery.createdAt, "acp_task_read_model_human_delivery_invalid");
}

function assertAllowedKeys(value: unknown, path: string): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertAllowedKeys(entry, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const normalized = key.toLowerCase().replace(/[_-]/gu, "");
    if (!ALLOWED_KEYS.has(key) || FORBIDDEN_LEGACY_KEYS.has(normalized)) {
      throw new Error(`acp_task_read_model_field_forbidden:${path}.${key}`);
    }
    assertAllowedKeys(entry, `${path}.${key}`);
  }
}

function exactObject(
  value: unknown,
  required: ReadonlySet<string>,
  optional: ReadonlySet<string>,
  code: string,
): Record<string, unknown> {
  const root = object(value, code);
  const keys = Object.keys(root);
  if ([...required].some((key) => !Object.hasOwn(root, key))
    || keys.some((key) => !required.has(key) && !optional.has(key))) throw new Error(code);
  return root;
}

function shape(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
  code: string,
): Record<string, unknown> {
  return exactObject(value, new Set(required), new Set(optional), code);
}

function object(value: unknown, code: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(code);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error(code);
  return value as Record<string, unknown>;
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[], code: string): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) throw new Error(code);
  return value as T;
}

function displayText(value: unknown, code: string, maximum = 500): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum
    || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(value)) throw new Error(code);
  return value;
}

function isoTimestamp(value: unknown, code: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))
    || new Date(value).toISOString() !== value) throw new Error(code);
  return value;
}

function nonNegativeInteger(value: unknown, code: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(code);
  return Number(value);
}

function positiveInteger(value: unknown, code: string): number {
  const result = nonNegativeInteger(value, code);
  if (result < 1) throw new Error(code);
  return result;
}

function stringArray(value: unknown, code: string): readonly string[] {
  if (!Array.isArray(value) || value.length > 256
    || value.some((entry) => typeof entry !== "string" || !entry.trim() || entry.length > 500)) {
    throw new Error(code);
  }
  return value as readonly string[];
}

function requiredString(value: unknown, prefix: string, code: string): string {
  if (typeof value !== "string" || value.length > 256
    || !new RegExp(`^${prefix}_[A-Za-z0-9_-]+$`, "u").test(value)) throw new Error(code);
  return value;
}

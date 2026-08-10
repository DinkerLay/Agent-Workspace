export type TemplateId = string;
export type TemplateVersionId = string;
export type TemplateDraftId = string;
export type TaskId = string;
export type TaskRunId = string;
export type LogicalSessionId = string;
export type ArchitectureSnapshotId = string;
export type ProviderHostId = string;
export type ProviderSessionBindingId = string;
export type SessionMessageId = string;
export type RelayBlockId = string;
export type MessageForwardBatchId = string;
export type MessageForwardId = string;
export type ForwardSelectionId = string;
export type HumanInterventionId = string;
export type SessionInboxItemId = string;
export type InputSubmissionId = string;
export type SessionTurnId = string;
export type InvocationId = string;
export type ProviderFactId = string;
export type AttentionId = string;
export type ArtifactId = string;
export type PresentationLeaseId = string;
export type AsyncOperationId = string;
export type RuntimeCommandId = string;
export type ExecutionProfileId = string;
export type AgentCardId = string;
export type WorkspaceId = string;
export type EvidenceReferenceId = string;
export type TaskSetupDraftId = string;
export type MetaSessionId = string;
export type MetaTurnId = string;
export type MetaPatchProposalId = string;
export type MetaProfileId = string;
export type MetaProfileOptionId = string;
export type MetaMessageId = string;

export type IdPrefix =
  | "template"
  | "template_version"
  | "template_draft"
  | "task"
  | "run"
  | "logical_session"
  | "architecture"
  | "provider_host"
  | "binding"
  | "message"
  | "relay_block"
  | "message_forward_batch"
  | "message_forward"
  | "forward_selection"
  | "human_intervention"
  | "inbox"
  | "input"
  | "session_turn"
  | "invocation"
  | "provider_fact"
  | "attention"
  | "artifact"
  | "presentation"
  | "async_operation"
  | "command"
  | "profile"
  | "agent_card"
  | "workspace"
  | "evidence"
  | "task_setup_draft"
  | "meta_session"
  | "meta_turn"
  | "meta_patch_proposal"
  | "meta_profile"
  | "meta_profile_option"
  | "meta_message";

const ID_PATTERN = /^[a-z][a-z0-9_]*_[a-zA-Z0-9-]+$/;

/** Creates opaque, JSON-safe local IDs. The ID has no provider/session meaning. */
export function createId(prefix: IdPrefix, entropy = randomEntropy()): string {
  const safeEntropy = entropy.replace(/[^a-zA-Z0-9-]/g, "");
  if (!safeEntropy) throw new Error("runtime_id_entropy_required");
  return `${prefix}_${safeEntropy}`;
}

export function isRuntimeId(value: unknown, prefix?: IdPrefix): value is string {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) return false;
  return prefix === undefined || value.startsWith(`${prefix}_`);
}

export function assertRuntimeId(value: unknown, prefix?: IdPrefix, field = "id"): asserts value is string {
  if (!isRuntimeId(value, prefix)) {
    const requiredPrefix = prefix ? `${prefix}_` : "runtime ID";
    throw new Error(`${field} must be a ${requiredPrefix} identifier`);
  }
}

function randomEntropy(): string {
  const cryptoApi = typeof globalThis.crypto === "object" ? globalThis.crypto : undefined;
  if (cryptoApi?.randomUUID) return cryptoApi.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`;
}

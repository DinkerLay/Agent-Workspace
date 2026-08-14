import type {
  AcpProfileReadinessObservation,
  JsonValue,
  MetaMessageId,
  MetaProfileDefinition,
  MetaProfileDefinitionV3,
  MetaProfileOptionId,
  MetaSessionId,
  MetaSessionMode,
  MetaTurnId,
  ProviderKind,
} from "@agent-workspace/runtime-contracts";
import {
  assertJsonValue,
  cloneJson,
  isRuntimeId,
  validateAcpProfileReadinessObservation,
  validateMetaProfileDefinitionV3,
  type ProviderCapability,
} from "@agent-workspace/runtime-contracts";
import type { ProviderScopedToolTurnContext } from "./scoped-tools.js";

/** A provider-neutral transcript entry. It carries configuration chat only. */
export interface MetaAgentTranscriptEntry {
  readonly metaMessageId: MetaMessageId;
  readonly role: "user" | "assistant";
  readonly content: string;
}

/**
 * Frozen, configuration-only input. Deliberately absent are every Task,
 * Binding, workspace, filesystem, routing, tool and credential capability.
 */
export interface MetaAgentTurnRequest {
  readonly metaSessionId: MetaSessionId;
  readonly metaTurnId: MetaTurnId;
  readonly userMetaMessageId: MetaMessageId;
  readonly idempotencyKey: string;
  readonly mode: MetaSessionMode;
  readonly profile: MetaProfileDefinition;
  readonly targetRevision: number;
  readonly systemInstructions: string;
  readonly outputSchema: JsonValue;
  readonly context: JsonValue;
  readonly transcript: readonly MetaAgentTranscriptEntry[];
  readonly content: string;
}

/** ACP-only configuration request. Legacy direct Meta profiles are rejected. */
export interface AcpMetaAgentTurnRequest extends Omit<MetaAgentTurnRequest, "profile"> {
  readonly profile: MetaProfileDefinitionV3;
}

const REQUEST_KEYS = [
  "metaSessionId",
  "metaTurnId",
  "userMetaMessageId",
  "idempotencyKey",
  "mode",
  "profile",
  "targetRevision",
  "systemInstructions",
  "outputSchema",
  "context",
  "transcript",
  "content",
] as const;
const PROFILE_KEYS = [
  "metaProfileId",
  "provider",
  "model",
  "providerVersion",
  "protocolFingerprint",
  "capabilityPolicy",
] as const;
const POLICY_KEYS = [
  "requiredCapabilities",
  "allowedTools",
  "permissionMode",
  "maxConcurrentTurns",
  "maxNativeChildren",
] as const;
const TRANSCRIPT_KEYS = ["metaMessageId", "role", "content"] as const;
const PROVIDER_CAPABILITIES = new Set<ProviderCapability>([
  "create_binding",
  "resume_binding",
  "input_correlation",
  "provider_receipt",
  "reconcile",
  "interrupt",
  "attention_reply",
  "native_child",
  "presentation",
]);
const FORBIDDEN_CONTEXT_KEYS = new Set([
  "taskid",
  "taskrunid",
  "tasktranscript",
  "runid",
  "logicalsessionid",
  "bindingid",
  "nativebindingref",
  "providersessionbindingid",
  "routingscope",
  "sessionid",
  "workspace",
  "workspaceid",
  "workspacepath",
  "cwd",
  "tool",
  "tools",
  "toolid",
  "toolcallid",
  "credential",
  "credentials",
  "token",
  "accesstoken",
  "apikey",
  "secret",
  "providersessionid",
  "acpsessionid",
  "nativesessionid",
  "nativeturnid",
  "nativerequestid",
  "providerrequestid",
  "acprequestid",
  "rawsessionid",
  "rawturnid",
  "rawrequestid",
  "rawid",
  "nativeid",
  "providerid",
  "acpid",
  "turnid",
  "requestid",
]);
const CONTROL_CHARACTER = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;

/**
 * Exact configuration-only snapshot shared by all Meta adapters. Adapter
 * implementations may add correlation state privately, never authority fields.
 */
export function validateMetaAgentTurnRequest(value: unknown): MetaAgentTurnRequest {
  const envelope = validateMetaTurnEnvelope(value);
  return deepFreeze({
    ...envelope.value,
    profile: validateLegacyMetaProfile(envelope.profile),
  });
}

/**
 * Strict v3 request validator used by the ACP Meta owner. It never accepts a
 * v2 Provider-brand snapshot or silently upgrades it.
 */
export function validateAcpMetaAgentTurnRequest(value: unknown): AcpMetaAgentTurnRequest {
  const envelope = validateMetaTurnEnvelope(value);
  const profileRoot = envelope.profile;
  if (!profileRoot || typeof profileRoot !== "object" || Array.isArray(profileRoot)
    || !("profileRevisionId" in profileRoot)) {
    throw new Error("meta_agent_turn_request_profile_v3_required");
  }
  let profile: MetaProfileDefinitionV3;
  try {
    profile = validateMetaProfileDefinitionV3(profileRoot);
  } catch {
    throw new Error("meta_agent_turn_request_profile_v3_invalid");
  }
  return deepFreeze({
    ...envelope.value,
    profile,
  });
}

function validateMetaTurnEnvelope(value: unknown): Readonly<{
  profile: unknown;
  value: Omit<MetaAgentTurnRequest, "profile">;
}> {
  const root = exactRecord(value, REQUEST_KEYS, "meta_agent_turn_request_fields_invalid");
  if (!isRuntimeId(root.metaSessionId, "meta_session")) throw new Error("meta_agent_turn_request_meta_session_id_invalid");
  if (!isRuntimeId(root.metaTurnId, "meta_turn")) throw new Error("meta_agent_turn_request_meta_turn_id_invalid");
  if (!isRuntimeId(root.userMetaMessageId, "meta_message")) {
    throw new Error("meta_agent_turn_request_user_message_id_invalid");
  }
  const idempotencyKey = boundedText(root.idempotencyKey, 512, "meta_agent_turn_request_idempotency_key_invalid");
  if (root.mode !== "template_design" && root.mode !== "task_setup") {
    throw new Error("meta_agent_turn_request_mode_invalid");
  }
  if (!Number.isSafeInteger(root.targetRevision) || (root.targetRevision as number) < 0) {
    throw new Error("meta_agent_turn_request_target_revision_invalid");
  }
  assertJsonValue(root.outputSchema, "MetaAgentTurnRequest.outputSchema");
  assertJsonValue(root.context, "MetaAgentTurnRequest.context");
  rejectAuthority(root.outputSchema, "MetaAgentTurnRequest.outputSchema");
  rejectAuthority(root.context, "MetaAgentTurnRequest.context");
  boundedJson(root.outputSchema, 512 * 1024, "meta_agent_turn_request_output_schema_too_large");
  boundedJson(root.context, 1024 * 1024, "meta_agent_turn_request_context_too_large");
  if (!Array.isArray(root.transcript) || root.transcript.length > 512) {
    throw new Error("meta_agent_turn_request_transcript_invalid");
  }
  const transcript = Object.freeze(Array.from(
    root.transcript,
    (entry, index) => validateTranscriptEntry(entry, index),
  ));
  return {
    profile: root.profile,
    value: deepFreeze({
      metaSessionId: root.metaSessionId,
      metaTurnId: root.metaTurnId,
      userMetaMessageId: root.userMetaMessageId,
      idempotencyKey,
      mode: root.mode,
      targetRevision: root.targetRevision as number,
      systemInstructions: boundedText(
        root.systemInstructions,
        100_000,
        "meta_agent_turn_request_system_instructions_invalid",
      ),
      outputSchema: cloneJson(root.outputSchema),
      context: cloneJson(root.context),
      transcript,
      content: boundedText(root.content, 256 * 1024, "meta_agent_turn_request_content_invalid"),
    }),
  };
}

function validateLegacyMetaProfile(value: unknown): MetaProfileDefinition {
  const root = exactRecord(value, PROFILE_KEYS, "meta_agent_turn_request_profile_fields_invalid");
  if (!isRuntimeId(root.metaProfileId, "meta_profile")) throw new Error("meta_agent_turn_request_profile_id_invalid");
  if (root.provider !== "opencode" && root.provider !== "codex" && root.provider !== "claude-code") {
    throw new Error("meta_agent_turn_request_profile_provider_invalid");
  }
  const policy = exactRecord(root.capabilityPolicy, POLICY_KEYS, "meta_agent_turn_request_policy_fields_invalid");
  if (!Array.isArray(policy.requiredCapabilities)
    || policy.requiredCapabilities.some((entry) => typeof entry !== "string" || !PROVIDER_CAPABILITIES.has(entry as ProviderCapability))) {
    throw new Error("meta_agent_turn_request_required_capabilities_invalid");
  }
  if (policy.requiredCapabilities.length !== 0) {
    throw new Error("meta_agent_turn_request_task_capabilities_forbidden");
  }
  if (!Array.isArray(policy.allowedTools) || policy.allowedTools.length !== 0) {
    throw new Error("meta_agent_turn_request_tools_forbidden");
  }
  if (policy.permissionMode !== "deny") throw new Error("meta_agent_turn_request_permission_mode_invalid");
  if (policy.maxConcurrentTurns !== 1) throw new Error("meta_agent_turn_request_concurrency_invalid");
  if (policy.maxNativeChildren !== 0) throw new Error("meta_agent_turn_request_native_children_forbidden");
  return deepFreeze({
    metaProfileId: root.metaProfileId,
    provider: root.provider,
    model: boundedPortableIdentifier(root.model, 500, "meta_agent_turn_request_model_invalid"),
    providerVersion: boundedSafeObservation(root.providerVersion, 300, "meta_agent_turn_request_provider_version_invalid"),
    protocolFingerprint: boundedSafeObservation(
      root.protocolFingerprint,
      300,
      "meta_agent_turn_request_protocol_fingerprint_invalid",
    ),
    capabilityPolicy: {
      requiredCapabilities: Object.freeze([]),
      allowedTools: Object.freeze([]),
      permissionMode: "deny",
      maxConcurrentTurns: 1,
      maxNativeChildren: 0,
    },
  });
}

function validateTranscriptEntry(value: unknown, index: number): MetaAgentTranscriptEntry {
  const root = exactRecord(value, TRANSCRIPT_KEYS, `meta_agent_turn_request_transcript_${index}_fields_invalid`);
  if (!isRuntimeId(root.metaMessageId, "meta_message")) {
    throw new Error(`meta_agent_turn_request_transcript_${index}_id_invalid`);
  }
  if (root.role !== "user" && root.role !== "assistant") {
    throw new Error(`meta_agent_turn_request_transcript_${index}_role_invalid`);
  }
  return Object.freeze({
    metaMessageId: root.metaMessageId,
    role: root.role,
    content: boundedText(root.content, 256 * 1024, `meta_agent_turn_request_transcript_${index}_content_invalid`),
  });
}

function exactRecord(value: unknown, keys: readonly string[], code: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(code);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error(code);
  const root = value as Record<string, unknown>;
  const allowed = new Set(keys);
  if (Object.keys(root).some((key) => !allowed.has(key)) || keys.some((key) => !(key in root))) {
    throw new Error(code);
  }
  return root;
}

function rejectAuthority(value: unknown, path: string): void {
  if (typeof value === "string") {
    if (value.startsWith("/") || value.startsWith("file://") || value.startsWith("~/") || /^[A-Za-z]:[\\/]/u.test(value)) {
      throw new Error(`meta_agent_turn_request_authority_forbidden:${path}`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => rejectAuthority(entry, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const normalized = key.toLowerCase().replace(/[^a-z0-9]/gu, "");
    if (FORBIDDEN_CONTEXT_KEYS.has(normalized)) {
      throw new Error(`meta_agent_turn_request_authority_forbidden:${path}.${key}`);
    }
    rejectAuthority(entry, `${path}.${key}`);
  }
}

function boundedText(value: unknown, maximum: number, code: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum || CONTROL_CHARACTER.test(value)) {
    throw new Error(code);
  }
  return value;
}

function boundedPortableIdentifier(value: unknown, maximum: number, code: string): string {
  const text = boundedText(value, maximum, code).trim();
  if (text.startsWith("/") || text.startsWith("file://") || text.startsWith("~/") || text.includes("\\")) {
    throw new Error(code);
  }
  return text;
}

function boundedSafeObservation(value: unknown, maximum: number, code: string): string {
  const text = boundedText(value, maximum, code).trim();
  if (text.startsWith("/") || text.startsWith("file://") || text.startsWith("~/") || text.includes("\\")) {
    throw new Error(code);
  }
  return text;
}

function boundedJson(value: JsonValue, maximum: number, code: string): void {
  if (JSON.stringify(value).length > maximum) throw new Error(code);
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const entry of Object.values(value as Record<string, unknown>)) deepFreeze(entry);
  return value;
}

export interface MetaAgentCapabilityReport {
  readonly provider: ProviderKind;
  readonly available: boolean;
  readonly providerVersion?: string;
  readonly protocolFingerprint?: string;
  readonly unavailableReasons: readonly string[];
}

export type MetaAgentTurnAcceptance = "accepted" | "rejected" | "unknown";

export type MetaAgentTurnReconciliation =
  | Readonly<{ state: "absent" }>
  | Readonly<{ state: "running" }>
  | Readonly<{ state: "returned"; finalText: string; observedAt: string }>
  | Readonly<{ state: "failed"; failureCode: string; observedAt: string }>
  | Readonly<{ state: "unknown" }>;

/** Sibling to the Task ProviderPort. It never accepts a Task-shaped request. */
export interface MetaAgentPort {
  readonly provider: ProviderKind;
  describeMetaCapabilities(profile: MetaProfileDefinition): Promise<MetaAgentCapabilityReport>;
  startMetaTurn(request: MetaAgentTurnRequest): Promise<MetaAgentTurnAcceptance>;
  reconcileMetaTurn(request: MetaAgentTurnRequest): Promise<MetaAgentTurnReconciliation>;
  close?(): Promise<void>;
}

export type AcpMetaSessionOpenResult =
  | Readonly<{
      available: true;
      readiness: AcpProfileReadinessObservation;
    }>
  | Readonly<{
      available: false;
      readiness: AcpProfileReadinessObservation;
    }>;

/**
 * ACP Meta is option-scoped rather than Provider-brand scoped. The Port owns
 * native session/process identity; callers receive only safe readiness.
 */
export interface AcpMetaAgentPort {
  checkMetaProfileReadiness(
    metaProfileOptionId: MetaProfileOptionId,
  ): Promise<AcpProfileReadinessObservation>;
  openMetaSession(input: Readonly<{
    metaSessionId: MetaSessionId;
    metaProfileOptionId: MetaProfileOptionId;
    sessionMode: MetaSessionMode;
    /** Recovery may load/resume the one existing native session, never create another. */
    disposition: "create" | "resume";
  }>): Promise<AcpMetaSessionOpenResult>;
  startMetaTurn(
    request: AcpMetaAgentTurnRequest,
    scopedToolTurnContext?: ProviderScopedToolTurnContext,
  ): Promise<MetaAgentTurnAcceptance>;
  reconcileMetaTurn(request: AcpMetaAgentTurnRequest): Promise<MetaAgentTurnReconciliation>;
  closeMetaSession?(input: Readonly<{ metaSessionId: MetaSessionId }>): Promise<void>;
  close?(): Promise<void>;
}

/** Rejects unsafe/ad-hoc readiness before it can enter an application cache. */
export function validateAcpMetaProfileReadiness(
  value: unknown,
): AcpProfileReadinessObservation {
  return validateAcpProfileReadinessObservation(value);
}

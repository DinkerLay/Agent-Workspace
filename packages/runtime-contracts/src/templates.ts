import {
  type AgentCardId,
  type ExecutionProfileId,
  type ExecutionProfileRevisionId,
  type MetaProfileId,
  type MetaProfileOptionId,
  type TemplateId,
  type TemplateVersionId,
} from "./ids";
import { assertJsonValue, cloneJson, type JsonObject, type JsonValue } from "./json";
import {
  validateAcpProfileReadinessObservation,
  type AcpProfileReadinessObservation,
} from "./acp-profile-readiness";

/** Published v2 bytes remain readable during the ACP migration. */
export const TEMPLATE_PACKAGE_SCHEMA_VERSION_V2 = 2 as const;
/**
 * Compatibility name for current v2 callers. New ACP code must use the
 * explicit v3 constant and validator; this alias is removed only after the
 * persisted v2 migration in Phase 6.
 */
export const TEMPLATE_PACKAGE_SCHEMA_VERSION = TEMPLATE_PACKAGE_SCHEMA_VERSION_V2;
/** Portable ACP Profile schema. It contains requirements, never Host resolution. */
export const TEMPLATE_PACKAGE_SCHEMA_VERSION_V3 = 3 as const;
export const CURRENT_TEMPLATE_PACKAGE_SCHEMA_VERSION = TEMPLATE_PACKAGE_SCHEMA_VERSION_V3;
export const TEMPLATE_PACKAGE_KIND = "agent-workspace/template" as const;
/**
 * Schema-v2 keeps providerVersion/protocolFingerprint on the wire, but new
 * Drafts use this marker because live Host readiness is the only authority.
 */
export const HOST_OBSERVED_EVIDENCE_MARKER = "host-observed" as const;

const MAX_ACP_EXTENSION_REQUIREMENTS = 64;
const ACP_CUSTOM_EXTENSION_NAME = /^[a-z0-9][a-z0-9._-]{0,63}(?:\/[a-z0-9][a-z0-9._-]{0,63})+$/u;
const PORTABLE_PROFILE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]*(?:\/[A-Za-z0-9][A-Za-z0-9._:@+-]*)?$/u;
// ACP model option ids are provider-owned portable values. Claude Code uses
// bracketed context hints such as `claude-opus-5[1M]`; brackets are data here,
// not a shell glob or filesystem path.
const PORTABLE_PROFILE_MODEL_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+\[\]-]*(?:\/[A-Za-z0-9][A-Za-z0-9._:@+\[\]-]*)?$/u;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;
const LOCAL_ARTIFACT_SUFFIX = /\.(?:app|bat|bin|cmd|com|dll|dylib|exe|gguf|json|mjs|cjs|js|py|sh|so|toml|ts|yaml|yml)$/iu;
const ACP_STANDARD_EXTENSION_NAMES = new Set([
  "auth/logout",
  "mcp/acp",
  "mcp/http",
  "mcp/sse",
  "nes",
  "prompt/audio",
  "prompt/embedded-context",
  "prompt/image",
  "providers",
  "position-encoding/utf-16",
  "position-encoding/utf-32",
  "position-encoding/utf-8",
  "session/additional-directories",
  "session/close",
  "session/delete",
  "session/fork",
  "session/list",
  "session/load",
  "session/resume",
]);

export type ProviderFamily = "opencode" | "codex" | "claude-code";
/** Compatibility name for direct-v2 callers. */
export type ProviderKind = ProviderFamily;
export type AgentCardKind = "conductor" | "general" | "researcher" | "implementer" | "reviewer" | "publisher";
export type ProviderCapability =
  | "create_binding"
  | "resume_binding"
  | "input_correlation"
  | "provider_receipt"
  | "reconcile"
  | "interrupt"
  | "attention_reply"
  | "native_child"
  | "presentation";

/**
 * Every published Template is a managed Task contract, not an ad-hoc prompt.
 * These capabilities are therefore mandatory for every execution profile.
 * Optional capabilities remain profile-specific above this baseline.
 */
export const MANAGED_EXECUTION_CAPABILITIES: readonly ProviderCapability[] = Object.freeze([
  "create_binding",
  "resume_binding",
  "input_correlation",
  "provider_receipt",
  "reconcile",
  "interrupt",
]);

export interface CapabilityPolicy {
  readonly requiredCapabilities: readonly ProviderCapability[];
  readonly allowedTools: readonly string[];
  readonly permissionMode: "ask" | "preapproved" | "deny";
  readonly maxConcurrentTurns: number;
  readonly maxNativeChildren: number;
}

/**
 * A frozen provider/model/capability choice. It deliberately contains no
 * credentials. `providerVersion` and `protocolFingerprint` remain required
 * only for schema-v2 byte compatibility; they are non-authoritative metadata,
 * never a Provider allowlist or an availability gate. The Host projects its
 * independently observed values through readiness.
 */
export interface ExecutionProfileDefinition {
  readonly executionProfileId: ExecutionProfileId;
  readonly provider: ProviderKind;
  readonly model: string;
  readonly providerVersion: string;
  readonly protocolFingerprint: string;
  readonly capabilityPolicy: CapabilityPolicy;
}

/** Explicit name for the immutable, already-published v2 wire shape. */
export type ExecutionProfileDefinitionV2 = ExecutionProfileDefinition;

export type ACPAgentKind = "native_acp" | "codex_acp" | "claude_agent_acp";
export type ACPProtocolMajor = 1;

/**
 * Portable ACP requirement. Host paths, artifact/upstream versions, digests,
 * credentials, qualification IDs and raw ACP identities are intentionally
 * absent; the Host resolves and qualifies the current installation.
 */
export interface ExecutionProfileDefinitionV3 {
  readonly executionProfileId: ExecutionProfileId;
  readonly profileRevisionId: ExecutionProfileRevisionId;
  readonly providerFamily: ProviderFamily;
  readonly acpAgentKind: ACPAgentKind;
  readonly protocolMajor: ACPProtocolMajor;
  readonly model: string;
  readonly configIntent: JsonObject;
  readonly requiredExtensions: readonly string[];
  readonly capabilityPolicy: CapabilityPolicy;
}

/** Host-configured profile for the configuration-only Meta Agent. */
export interface MetaProfileDefinition extends Omit<ExecutionProfileDefinition, "executionProfileId"> {
  readonly metaProfileId: MetaProfileId;
}

/** Immutable direct-Provider history. New Meta effects must never write it. */
export type MetaProfileDefinitionV2 = MetaProfileDefinition;

export interface MetaProfileDefinitionV3 extends Omit<ExecutionProfileDefinitionV3, "executionProfileId"> {
  readonly metaProfileId: MetaProfileId;
  readonly role: "meta";
}

/** Schema-dispatched durable read shape; it is not an implicit migration. */
export type MetaProfileSnapshot = MetaProfileDefinitionV2 | MetaProfileDefinitionV3;

/** Host-owned readiness entry. Renderer selects only this opaque option ID. */
export interface MetaProfileOptionDefinition {
  readonly metaProfileOptionId: MetaProfileOptionId;
  readonly title: string;
  readonly availability: "available" | "unavailable";
  readonly unavailableReason?: string;
  readonly profile: MetaProfileDefinition;
}

export interface MetaProfileOptionDefinitionV3 {
  readonly metaProfileOptionId: MetaProfileOptionId;
  readonly title: string;
  readonly profile: MetaProfileDefinitionV3;
  readonly readiness: AcpProfileReadinessObservation;
}

export type MetaProfileOptionDefinitionV2 = MetaProfileOptionDefinition;
export type MetaProfileOptionSnapshot = MetaProfileOptionDefinitionV2 | MetaProfileOptionDefinitionV3;

/** A card-scoped capability label; it is not a Provider-native credential. */
export type AgentCapabilityRefKind = "mcp" | "skill";

export interface AgentCapabilityRef {
  readonly kind: AgentCapabilityRefKind;
  readonly id: string;
}

/**
 * Conductor-facing routing context.  This is intentionally distinct from a
 * Worker system prompt: it describes when the Conductor should call a card.
 */
export interface AgentDispatchProfile {
  readonly title: string;
  readonly description: string;
}

/**
 * Frozen instructions compiled from one Task Architecture snapshot for a
 * single logical Session. Provider adapters may render it for their native
 * protocol, but cannot add sibling Card prompts or mutate it.
 */
export type ProviderSessionPurpose = "task_conductor" | "task_worker" | "template_design";

export interface ProviderSessionDispatchCard {
  readonly agentCardId: AgentCardId;
  readonly kind: Exclude<AgentCardKind, "conductor">;
  readonly title: string;
  readonly description: string;
}

export interface ProviderSessionBootstrap {
  readonly purpose: ProviderSessionPurpose;
  readonly agentCardId: AgentCardId;
  /** Stable identity shown to the Agent; execution configuration remains separate. */
  readonly kind: AgentCardKind | "meta";
  readonly title: string;
  readonly role?: string;
  readonly systemPrompt: string;
  readonly capabilityRefs: readonly AgentCapabilityRef[];
  /** Present only for a Conductor; never includes Worker system prompts. */
  readonly dispatchRegistry?: readonly ProviderSessionDispatchCard[];
}

export interface AgentCardDefinition {
  readonly agentCardId: AgentCardId;
  readonly kind: AgentCardKind;
  readonly title: string;
  readonly role?: string;
  readonly executionProfileId: ExecutionProfileId;
  readonly systemPrompt: string;
  /** Capability scope owned by this Card, never copied from a sibling. */
  readonly capabilityRefs: readonly AgentCapabilityRef[];
  /** Required for Worker cards and forbidden for the Conductor. */
  readonly dispatchProfile?: AgentDispatchProfile;
}

export interface AgentLoopRoutingPolicy {
  readonly mode: "agent_loop";
  readonly maxConcurrentInvocations: number;
  readonly maxDispatchesPerDecision: number;
}

export interface DeliverableDefinition {
  readonly artifactPath: string;
  readonly ownerAgentCardId: AgentCardId;
  readonly description?: string;
}

export interface TaskInputChoiceOption {
  readonly optionId: string;
  readonly label: string;
}

export type TaskInputFieldDefinition = Readonly<{
  fieldId: string;
  label: string;
  required: boolean;
  description?: string;
}> & (
  | Readonly<{ kind: "short_text" | "long_text" }>
  | Readonly<{ kind: "choice"; options: readonly TaskInputChoiceOption[] }>
);

/** Field order is part of the immutable Template Version contract. */
export interface TaskInputSchema {
  readonly fields: readonly TaskInputFieldDefinition[];
}

/** Values remain ordered by the selected immutable TaskInputSchema. */
export interface TaskInputValue {
  readonly fieldId: string;
  readonly value: string;
}

/**
 * The immutable content that a Template Version carries. Template identity,
 * version number, Draft state, cwd and provider-native identities are outside
 * this object by design.
 */
export interface TemplateDefinition {
  readonly schemaVersion: typeof TEMPLATE_PACKAGE_SCHEMA_VERSION;
  readonly taskInputSchema?: TaskInputSchema;
  readonly conductor: AgentCardDefinition;
  readonly agentCards: readonly AgentCardDefinition[];
  readonly executionProfiles: readonly ExecutionProfileDefinition[];
  readonly routingPolicy: AgentLoopRoutingPolicy;
  readonly deliverables: readonly DeliverableDefinition[];
}

/** Explicit name for the immutable, already-published v2 definition. */
export type TemplateDefinitionV2 = TemplateDefinition;

export interface TemplateDefinitionV3 {
  readonly schemaVersion: typeof TEMPLATE_PACKAGE_SCHEMA_VERSION_V3;
  readonly taskInputSchema?: TaskInputSchema;
  readonly conductor: AgentCardDefinition;
  readonly agentCards: readonly AgentCardDefinition[];
  readonly executionProfiles: readonly ExecutionProfileDefinitionV3[];
  readonly routingPolicy: AgentLoopRoutingPolicy;
  readonly deliverables: readonly DeliverableDefinition[];
}

/** Durable read/write union. Callers must dispatch by the exact schemaVersion. */
export type TemplateDefinitionSnapshot = TemplateDefinitionV2 | TemplateDefinitionV3;

export interface TemplatePackageMetadata {
  readonly templateId: TemplateId;
  readonly version: number;
  readonly slug: string;
  readonly title: string;
  readonly description?: string;
  readonly definitionHash?: string;
  /** Present when a portable package has immutable binary assets. */
  readonly assetManifestHash?: string;
}

/** The portable, Git-friendly template exchange payload. */
export interface TemplatePackage {
  readonly schemaVersion: typeof TEMPLATE_PACKAGE_SCHEMA_VERSION;
  readonly kind: typeof TEMPLATE_PACKAGE_KIND;
  readonly template: TemplatePackageMetadata;
  readonly definition: TemplateDefinition;
}

/** Explicit name for the immutable, already-published v2 package. */
export type TemplatePackageV2 = TemplatePackage;

export interface TemplatePackageV3 {
  readonly schemaVersion: typeof TEMPLATE_PACKAGE_SCHEMA_VERSION_V3;
  readonly kind: typeof TEMPLATE_PACKAGE_KIND;
  readonly template: TemplatePackageMetadata;
  readonly definition: TemplateDefinitionV3;
}

/** Durable/import-export union; no schema is upgraded implicitly. */
export type TemplatePackageSnapshot = TemplatePackageV2 | TemplatePackageV3;

/** JSON-only transport for binary Template assets across Runtime Bridge calls. */
export interface TemplateAssetTransport {
  readonly path: string;
  readonly contentType?: string;
  readonly base64: string;
}

export class TemplateValidationError extends Error {
  readonly code = "template_validation_failed";

  constructor(message: string) {
    super(message);
    this.name = "TemplateValidationError";
  }
}

export class TemplateYamlParseError extends Error {
  readonly code = "template_yaml_parse_failed";

  constructor(message: string) {
    super(message);
    this.name = "TemplateYamlParseError";
  }
}

/**
 * Validates an import before any store write. It does not add defaults or
 * silently upgrade a package: import has to be explicit and reproducible.
 */
export function validateTemplatePackage(value: unknown): TemplatePackage {
  const root = record(value, "template package");
  rejectForbiddenTemplateFields(root);
  assertExactKeys(root, ["schemaVersion", "kind", "template", "definition"], "template package");
  if (root.schemaVersion !== TEMPLATE_PACKAGE_SCHEMA_VERSION) {
    throw new TemplateValidationError(`unsupported template schema version: ${String(root.schemaVersion)}`);
  }
  if (root.kind !== TEMPLATE_PACKAGE_KIND) {
    throw new TemplateValidationError(`unsupported template package kind: ${String(root.kind)}`);
  }
  const metadata = validateMetadata(root.template);
  const definition = validateTemplateDefinition(root.definition);
  const result: TemplatePackage = {
    schemaVersion: TEMPLATE_PACKAGE_SCHEMA_VERSION,
    kind: TEMPLATE_PACKAGE_KIND,
    template: metadata,
    definition,
  };
  assertJsonValue(result as unknown as JsonValue);
  return cloneJson(result as unknown as JsonValue) as unknown as TemplatePackage;
}

export function validateTemplateDefinition(value: unknown): TemplateDefinition {
  const root = record(value, "template definition");
  assertExactKeys(
    root,
    ["schemaVersion", "taskInputSchema", "conductor", "agentCards", "executionProfiles", "routingPolicy", "deliverables"],
    "template definition",
    ["taskInputSchema"],
  );
  if (root.schemaVersion !== TEMPLATE_PACKAGE_SCHEMA_VERSION) {
    throw new TemplateValidationError(`unsupported template definition schema: ${String(root.schemaVersion)}`);
  }

  const profiles = array(root.executionProfiles, "executionProfiles").map((profile, index) =>
    validateExecutionProfile(profile, `executionProfiles[${index}]`),
  );
  if (profiles.length === 0) throw new TemplateValidationError("executionProfiles must not be empty");
  assertUnique(profiles.map((profile) => profile.executionProfileId), "executionProfileId");
  const profileIds = new Set(profiles.map((profile) => profile.executionProfileId));

  const conductor = validateAgentCard(root.conductor, "conductor", profileIds);
  if (conductor.kind !== "conductor") throw new TemplateValidationError("conductor.kind must be conductor");
  if (conductor.dispatchProfile) throw new TemplateValidationError("conductor.dispatchProfile is not allowed");
  const agentCards = array(root.agentCards, "agentCards").map((card, index) =>
    validateAgentCard(card, `agentCards[${index}]`, profileIds),
  );
  if (agentCards.length === 0) throw new TemplateValidationError("agentCards must not be empty");
  if (agentCards.some((card) => card.kind === "conductor")) {
    throw new TemplateValidationError("agentCards must not contain another conductor");
  }
  if (agentCards.some((card) => !card.dispatchProfile)) {
    throw new TemplateValidationError("agentCards[].dispatchProfile is required");
  }
  assertUnique([conductor.agentCardId, ...agentCards.map((card) => card.agentCardId)], "agentCardId");

  const routingPolicy = validateRoutingPolicy(root.routingPolicy);
  const deliverables = array(root.deliverables, "deliverables").map((deliverable, index) =>
    validateDeliverable(deliverable, `deliverables[${index}]`, new Set(agentCards.map((card) => card.agentCardId))),
  );
  assertUnique(deliverables.map((deliverable) => deliverable.artifactPath), "deliverable artifactPath");

  return {
    schemaVersion: TEMPLATE_PACKAGE_SCHEMA_VERSION,
    ...(root.taskInputSchema === undefined ? {} : { taskInputSchema: validateTaskInputSchema(root.taskInputSchema) }),
    conductor,
    agentCards,
    executionProfiles: profiles,
    routingPolicy,
    deliverables,
  };
}

/**
 * Validates the ACP-only v3 package without accepting or upgrading v2. The
 * caller must perform an explicit Draft migration before publishing v3 bytes.
 */
export function validateTemplatePackageV3(value: unknown): TemplatePackageV3 {
  const root = record(value, "template package");
  rejectForbiddenTemplateFields(root);
  assertExactKeys(root, ["schemaVersion", "kind", "template", "definition"], "template package");
  if (root.schemaVersion !== TEMPLATE_PACKAGE_SCHEMA_VERSION_V3) {
    throw new TemplateValidationError(`unsupported template schema version: ${String(root.schemaVersion)}`);
  }
  if (root.kind !== TEMPLATE_PACKAGE_KIND) {
    throw new TemplateValidationError(`unsupported template package kind: ${String(root.kind)}`);
  }
  const result: TemplatePackageV3 = {
    schemaVersion: TEMPLATE_PACKAGE_SCHEMA_VERSION_V3,
    kind: TEMPLATE_PACKAGE_KIND,
    template: validateMetadata(root.template),
    definition: validateTemplateDefinitionV3(root.definition),
  };
  assertJsonValue(result as unknown as JsonValue);
  return cloneJson(result as unknown as JsonValue) as unknown as TemplatePackageV3;
}

export function validateTemplateDefinitionV3(value: unknown): TemplateDefinitionV3 {
  const root = record(value, "template definition");
  rejectForbiddenTemplateFields(root, "template definition");
  assertExactKeys(
    root,
    ["schemaVersion", "taskInputSchema", "conductor", "agentCards", "executionProfiles", "routingPolicy", "deliverables"],
    "template definition",
    ["taskInputSchema"],
  );
  if (root.schemaVersion !== TEMPLATE_PACKAGE_SCHEMA_VERSION_V3) {
    throw new TemplateValidationError(`unsupported template definition schema: ${String(root.schemaVersion)}`);
  }

  const profiles = array(root.executionProfiles, "executionProfiles").map((profile, index) =>
    validateExecutionProfileV3(profile, `executionProfiles[${index}]`),
  );
  if (profiles.length === 0) throw new TemplateValidationError("executionProfiles must not be empty");
  assertUnique(profiles.map((profile) => profile.executionProfileId), "executionProfileId");
  assertUnique(profiles.map((profile) => profile.profileRevisionId), "profileRevisionId");
  const profileIds = new Set(profiles.map((profile) => profile.executionProfileId));

  const conductor = validateAgentCard(root.conductor, "conductor", profileIds);
  if (conductor.kind !== "conductor") throw new TemplateValidationError("conductor.kind must be conductor");
  if (conductor.dispatchProfile) throw new TemplateValidationError("conductor.dispatchProfile is not allowed");
  const agentCards = array(root.agentCards, "agentCards").map((card, index) =>
    validateAgentCard(card, `agentCards[${index}]`, profileIds),
  );
  if (agentCards.length === 0) throw new TemplateValidationError("agentCards must not be empty");
  if (agentCards.some((card) => card.kind === "conductor")) {
    throw new TemplateValidationError("agentCards must not contain another conductor");
  }
  if (agentCards.some((card) => !card.dispatchProfile)) {
    throw new TemplateValidationError("agentCards[].dispatchProfile is required");
  }
  assertUnique([conductor.agentCardId, ...agentCards.map((card) => card.agentCardId)], "agentCardId");

  const deliverables = array(root.deliverables, "deliverables").map((deliverable, index) =>
    validateDeliverable(deliverable, `deliverables[${index}]`, new Set(agentCards.map((card) => card.agentCardId))),
  );
  assertUnique(deliverables.map((deliverable) => deliverable.artifactPath), "deliverable artifactPath");

  return {
    schemaVersion: TEMPLATE_PACKAGE_SCHEMA_VERSION_V3,
    ...(root.taskInputSchema === undefined ? {} : { taskInputSchema: validateTaskInputSchema(root.taskInputSchema) }),
    conductor,
    agentCards,
    executionProfiles: profiles,
    routingPolicy: validateRoutingPolicy(root.routingPolicy),
    deliverables,
  };
}

/** Strict schema dispatch for durable Template definitions. */
export function validateTemplateDefinitionSnapshot(value: unknown): TemplateDefinitionSnapshot {
  const root = record(value, "template definition");
  if (root.schemaVersion === TEMPLATE_PACKAGE_SCHEMA_VERSION_V2) {
    return validateTemplateDefinition(root);
  }
  if (root.schemaVersion === TEMPLATE_PACKAGE_SCHEMA_VERSION_V3) {
    return validateTemplateDefinitionV3(root);
  }
  throw new TemplateValidationError(`unsupported template definition schema: ${String(root.schemaVersion)}`);
}

export function isTemplateDefinitionV3(
  value: TemplateDefinitionSnapshot,
): value is TemplateDefinitionV3 {
  return value.schemaVersion === TEMPLATE_PACKAGE_SCHEMA_VERSION_V3;
}

/** Strict schema dispatch for immutable package reads; never migrates v2 bytes. */
export function validateTemplatePackageSnapshot(value: unknown): TemplatePackageSnapshot {
  const root = record(value, "template package");
  if (root.schemaVersion === TEMPLATE_PACKAGE_SCHEMA_VERSION_V2) {
    return validateTemplatePackage(root);
  }
  if (root.schemaVersion === TEMPLATE_PACKAGE_SCHEMA_VERSION_V3) {
    return validateTemplatePackageV3(root);
  }
  throw new TemplateValidationError(`unsupported template schema version: ${String(root.schemaVersion)}`);
}

/** Strict portable Meta Profile validation; no Host observation grants authority here. */
export function validateMetaProfileDefinitionV3(value: unknown): MetaProfileDefinitionV3 {
  const root = record(value, "Meta Profile v3");
  assertExactKeys(
    root,
    [
      "metaProfileId",
      "profileRevisionId",
      "providerFamily",
      "acpAgentKind",
      "protocolMajor",
      "role",
      "model",
      "configIntent",
      "requiredExtensions",
      "capabilityPolicy",
    ],
    "Meta Profile v3",
  );
  if (root.role !== "meta") throw new TemplateValidationError("Meta Profile v3.role must be meta");
  const portable = validateExecutionProfileV3({
    executionProfileId: "profile_meta-validation",
    profileRevisionId: root.profileRevisionId,
    providerFamily: root.providerFamily,
    acpAgentKind: root.acpAgentKind,
    protocolMajor: root.protocolMajor,
    model: root.model,
    configIntent: root.configIntent,
    requiredExtensions: root.requiredExtensions,
    capabilityPolicy: root.capabilityPolicy,
  }, "Meta Profile v3", false);
  if (portable.capabilityPolicy.allowedTools.length !== 0) {
    throw new TemplateValidationError("Meta Profile v3.capabilityPolicy.allowedTools must be empty");
  }
  if (portable.capabilityPolicy.permissionMode !== "deny") {
    throw new TemplateValidationError("Meta Profile v3.capabilityPolicy.permissionMode must be deny");
  }
  if (portable.capabilityPolicy.maxConcurrentTurns !== 1) {
    throw new TemplateValidationError("Meta Profile v3.capabilityPolicy.maxConcurrentTurns must be 1");
  }
  if (portable.capabilityPolicy.maxNativeChildren !== 0) {
    throw new TemplateValidationError("Meta Profile v3.capabilityPolicy.maxNativeChildren must be 0");
  }
  if (portable.capabilityPolicy.requiredCapabilities.some((capability) =>
    capability === "native_child" || capability === "attention_reply" || capability === "presentation")) {
    throw new TemplateValidationError("Meta Profile v3.capabilityPolicy requires forbidden Meta authority");
  }
  return {
    metaProfileId: requiredId(root.metaProfileId, "Meta Profile v3.metaProfileId", "meta_profile"),
    profileRevisionId: portable.profileRevisionId,
    providerFamily: portable.providerFamily,
    acpAgentKind: portable.acpAgentKind,
    protocolMajor: portable.protocolMajor,
    role: "meta",
    model: portable.model,
    configIntent: portable.configIntent,
    requiredExtensions: portable.requiredExtensions,
    capabilityPolicy: portable.capabilityPolicy,
  };
}

/** Strict reader for historical direct Meta snapshots. It never grants ACP authority. */
export function validateMetaProfileDefinitionV2(value: unknown): MetaProfileDefinitionV2 {
  const root = record(value, "Meta Profile v2");
  assertExactKeys(
    root,
    [
      "metaProfileId",
      "provider",
      "model",
      "providerVersion",
      "protocolFingerprint",
      "capabilityPolicy",
    ],
    "Meta Profile v2",
  );
  const capabilityPolicy = validateCapabilityPolicy(root.capabilityPolicy, "Meta Profile v2.capabilityPolicy");
  if (capabilityPolicy.requiredCapabilities.length !== 0) {
    throw new TemplateValidationError("Meta Profile v2 cannot require Task capabilities");
  }
  if (capabilityPolicy.allowedTools.length !== 0) {
    throw new TemplateValidationError("Meta Profile v2.capabilityPolicy.allowedTools must be empty");
  }
  if (capabilityPolicy.permissionMode !== "deny") {
    throw new TemplateValidationError("Meta Profile v2.capabilityPolicy.permissionMode must be deny");
  }
  if (capabilityPolicy.maxConcurrentTurns !== 1) {
    throw new TemplateValidationError("Meta Profile v2.capabilityPolicy.maxConcurrentTurns must be 1");
  }
  if (capabilityPolicy.maxNativeChildren !== 0) {
    throw new TemplateValidationError("Meta Profile v2.capabilityPolicy.maxNativeChildren must be 0");
  }
  return {
    metaProfileId: requiredLegacyId(root.metaProfileId, "Meta Profile v2.metaProfileId", "meta_profile"),
    provider: enumValue(root.provider, ["opencode", "codex", "claude-code"] as const, "Meta Profile v2.provider"),
    model: requiredText(root.model, "Meta Profile v2.model", 300),
    providerVersion: requiredText(root.providerVersion, "Meta Profile v2.providerVersion", 300),
    protocolFingerprint: requiredText(root.protocolFingerprint, "Meta Profile v2.protocolFingerprint", 300),
    capabilityPolicy,
  };
}

/**
 * Durable profile decoder. A mixed v2/v3 object is corruption, not a request
 * to translate historical direct identity into an ACP revision.
 */
export function validateMetaProfileSnapshot(value: unknown): MetaProfileSnapshot {
  const root = record(value, "Meta Profile snapshot");
  const hasV2Identity = ["provider", "providerVersion", "protocolFingerprint"]
    .some((field) => Object.prototype.hasOwnProperty.call(root, field));
  const hasV3Identity = ["profileRevisionId", "providerFamily", "acpAgentKind", "protocolMajor", "role"]
    .some((field) => Object.prototype.hasOwnProperty.call(root, field));
  if (hasV2Identity && hasV3Identity) {
    throw new TemplateValidationError("meta_profile_snapshot_schema_ambiguous");
  }
  if (hasV3Identity) return validateMetaProfileDefinitionV3(root);
  if (hasV2Identity) return validateMetaProfileDefinitionV2(root);
  throw new TemplateValidationError("meta_profile_snapshot_schema_unsupported");
}

export function isMetaProfileDefinitionV3(
  value: MetaProfileSnapshot | unknown,
): value is MetaProfileDefinitionV3 {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && Object.prototype.hasOwnProperty.call(value, "profileRevisionId")
    && Object.prototype.hasOwnProperty.call(value, "providerFamily")
    && !Object.prototype.hasOwnProperty.call(value, "provider"));
}

/** Host-owned option: portable Profile plus the one shared safe readiness shape. */
export function validateMetaProfileOptionDefinitionV3(value: unknown): MetaProfileOptionDefinitionV3 {
  const root = record(value, "Meta Profile option v3");
  assertExactKeys(root, ["metaProfileOptionId", "title", "profile", "readiness"], "Meta Profile option v3");
  const profile = validateMetaProfileDefinitionV3(root.profile);
  const readiness = validateAcpProfileReadinessObservation(root.readiness);
  if (readiness.profileRevisionId !== profile.profileRevisionId
    || readiness.providerFamily !== profile.providerFamily
    || readiness.acpAgentKind !== profile.acpAgentKind
    || readiness.role !== profile.role
    || readiness.model !== profile.model) {
    throw new TemplateValidationError("Meta Profile option v3 profile and readiness identity do not match");
  }
  return {
    metaProfileOptionId: requiredId(
      root.metaProfileOptionId,
      "Meta Profile option v3.metaProfileOptionId",
      "meta_profile_option",
    ),
    title: requiredText(root.title, "Meta Profile option v3.title", 160),
    profile,
    readiness,
  };
}

export function validateTaskInputSchema(value: unknown): TaskInputSchema {
  const root = record(value, "taskInputSchema");
  assertExactKeys(root, ["fields"], "taskInputSchema");
  const rawFields = array(root.fields, "taskInputSchema.fields");
  if (rawFields.length > 64) throw new TemplateValidationError("taskInputSchema.fields exceeds 64 entries");
  const fields = rawFields.map((field, index) => validateTaskInputField(field, `taskInputSchema.fields[${index}]`));
  assertUnique(fields.map((field) => field.fieldId), "taskInputSchema fieldId");
  return { fields };
}

function validateTaskInputField(value: unknown, path: string): TaskInputFieldDefinition {
  const root = record(value, path);
  assertExactKeys(root, ["fieldId", "label", "kind", "required", "description", "options"], path, ["description", "options"]);
  const fieldId = requiredText(root.fieldId, `${path}.fieldId`, 64);
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(fieldId)) throw new TemplateValidationError(`${path}.fieldId is invalid`);
  const label = requiredText(root.label, `${path}.label`, 160);
  if (/\r|\n/.test(label)) throw new TemplateValidationError(`${path}.label must be one line`);
  if (typeof root.required !== "boolean") throw new TemplateValidationError(`${path}.required must be boolean`);
  const common = {
    fieldId,
    label,
    required: root.required,
    ...(root.description === undefined ? {} : { description: optionalText(root.description, `${path}.description`, 1_000) }),
  };
  if (root.kind === "choice") {
    const rawOptions = array(root.options, `${path}.options`);
    if (rawOptions.length === 0 || rawOptions.length > 64) throw new TemplateValidationError(`${path}.options must contain 1-64 entries`);
    const options = rawOptions.map((option, index) => {
      const candidate = record(option, `${path}.options[${index}]`);
      assertExactKeys(candidate, ["optionId", "label"], `${path}.options[${index}]`);
      const optionId = requiredText(candidate.optionId, `${path}.options[${index}].optionId`, 64);
      if (!/^[a-z][a-z0-9_-]{0,63}$/.test(optionId)) {
        throw new TemplateValidationError(`${path}.options[${index}].optionId is invalid`);
      }
      const optionLabel = requiredText(candidate.label, `${path}.options[${index}].label`, 160);
      if (/\r|\n/.test(optionLabel)) throw new TemplateValidationError(`${path}.options[${index}].label must be one line`);
      return {
        optionId,
        label: optionLabel,
      };
    });
    assertUnique(options.map((option) => option.optionId), `${path} optionId`);
    return { ...common, kind: "choice", options };
  }
  if (root.kind !== "short_text" && root.kind !== "long_text") {
    throw new TemplateValidationError(`${path}.kind is invalid`);
  }
  if (root.options !== undefined) throw new TemplateValidationError(`${path}.options is allowed only for choice`);
  return { ...common, kind: root.kind };
}

/**
 * YAML v1 intentionally uses only mapping, sequence and JSON-compatible
 * scalars. The serializer's output is portable YAML; the parser accepts that
 * subset so importing does not depend on a provider SDK or a hidden parser.
 */
export function serializeTemplatePackageYaml(value: TemplatePackage): string {
  const valid = validateTemplatePackage(value);
  return serializeYamlDocument(valid as unknown as JsonValue);
}

export function parseTemplatePackageYaml(source: string): TemplatePackage {
  return validateTemplatePackage(parseYamlDocument(source));
}

export function serializeTemplatePackageYamlV3(value: TemplatePackageV3): string {
  const valid = validateTemplatePackageV3(value);
  return serializeYamlDocument(valid as unknown as JsonValue);
}

export function parseTemplatePackageYamlV3(source: string): TemplatePackageV3 {
  return validateTemplatePackageV3(parseYamlDocument(source));
}

/** A deliberately small, JSON-compatible YAML subset for safe package manifests. */
export function serializeYamlDocument(value: JsonValue): string {
  assertJsonValue(value);
  return `${renderYaml(value, 0).join("\n")}\n`;
}

/**
 * Rejects YAML tags, aliases, block execution features and implicit coercions.
 * JSON is accepted because it is a YAML 1.2 subset.
 */
export function parseYamlDocument(source: string): JsonValue {
  if (typeof source !== "string" || !source.trim()) {
    throw new TemplateYamlParseError("template YAML is empty");
  }
  // JSON is a YAML 1.2 subset and makes programmatic export/import convenient.
  try {
    const parsed: unknown = JSON.parse(source);
    assertJsonValue(parsed);
    return parsed;
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
  }
  return parseRestrictedYaml(source);
}

function validateMetadata(value: unknown): TemplatePackageMetadata {
  const root = record(value, "template metadata");
  assertExactKeys(
    root,
    ["templateId", "version", "slug", "title", "description", "definitionHash", "assetManifestHash"],
    "template metadata",
    ["description", "definitionHash", "assetManifestHash"],
  );
  return {
    templateId: requiredId(root.templateId, "template.templateId", "template"),
    version: positiveInteger(root.version, "template.version"),
    slug: slug(root.slug, "template.slug"),
    title: requiredText(root.title, "template.title", 160),
    ...(root.description === undefined ? {} : { description: optionalText(root.description, "template.description", 2_000) }),
    ...(root.definitionHash === undefined ? {} : { definitionHash: requiredText(root.definitionHash, "template.definitionHash", 200) }),
    ...(root.assetManifestHash === undefined ? {} : { assetManifestHash: requiredText(root.assetManifestHash, "template.assetManifestHash", 200) }),
  };
}

function validateExecutionProfile(value: unknown, path: string): ExecutionProfileDefinition {
  const root = record(value, path);
  assertExactKeys(root, ["executionProfileId", "provider", "model", "providerVersion", "protocolFingerprint", "capabilityPolicy"], path);
  const provider = enumValue(root.provider, ["opencode", "codex", "claude-code"] as const, `${path}.provider`);
  const capabilityPolicy = validateCapabilityPolicy(root.capabilityPolicy, `${path}.capabilityPolicy`);
  for (const capability of MANAGED_EXECUTION_CAPABILITIES) {
    if (!capabilityPolicy.requiredCapabilities.includes(capability)) {
      throw new TemplateValidationError(
        `${path}.capabilityPolicy.requiredCapabilities must include managed capability: ${capability}`,
      );
    }
  }
  return {
    executionProfileId: requiredId(root.executionProfileId, `${path}.executionProfileId`, "profile"),
    provider,
    model: requiredText(root.model, `${path}.model`, 300),
    // Preserve the v2 wire values exactly. Runtime readiness must never compare
    // them with live transport observations; new Drafts use the neutral marker.
    providerVersion: requiredText(root.providerVersion, `${path}.providerVersion`, 300),
    protocolFingerprint: requiredText(root.protocolFingerprint, `${path}.protocolFingerprint`, 300),
    capabilityPolicy,
  };
}

function validateExecutionProfileV3(
  value: unknown,
  path: string,
  requireManagedTaskCapabilities = true,
): ExecutionProfileDefinitionV3 {
  const root = record(value, path);
  assertExactKeys(
    root,
    [
      "executionProfileId",
      "profileRevisionId",
      "providerFamily",
      "acpAgentKind",
      "protocolMajor",
      "model",
      "configIntent",
      "requiredExtensions",
      "capabilityPolicy",
    ],
    path,
  );
  const providerFamily = enumValue(root.providerFamily, ["opencode", "codex", "claude-code"] as const, `${path}.providerFamily`);
  const acpAgentKind = enumValue(root.acpAgentKind, ["native_acp", "codex_acp", "claude_agent_acp"] as const, `${path}.acpAgentKind`);
  const expectedAgentKind: Readonly<Record<ProviderKind, ACPAgentKind>> = {
    opencode: "native_acp",
    codex: "codex_acp",
    "claude-code": "claude_agent_acp",
  };
  if (acpAgentKind !== expectedAgentKind[providerFamily]) {
    throw new TemplateValidationError(`${path}.acpAgentKind does not match providerFamily`);
  }
  if (root.protocolMajor !== 1) {
    throw new TemplateValidationError(`${path}.protocolMajor must be 1`);
  }
  const capabilityPolicy = validateCapabilityPolicyV3(root.capabilityPolicy, `${path}.capabilityPolicy`);
  for (const capability of MANAGED_EXECUTION_CAPABILITIES) {
    if (requireManagedTaskCapabilities && !capabilityPolicy.requiredCapabilities.includes(capability)) {
      throw new TemplateValidationError(
        `${path}.capabilityPolicy.requiredCapabilities must include managed capability: ${capability}`,
      );
    }
  }
  const configIntent = record(root.configIntent, `${path}.configIntent`);
  rejectHostResolutionFields(configIntent, `${path}.configIntent`);
  assertJsonValue(configIntent);
  const rawRequiredExtensions = array(root.requiredExtensions, `${path}.requiredExtensions`);
  if (rawRequiredExtensions.length > MAX_ACP_EXTENSION_REQUIREMENTS) {
    throw new TemplateValidationError(`${path}.requiredExtensions exceeds ${MAX_ACP_EXTENSION_REQUIREMENTS} entries`);
  }
  const requiredExtensions = rawRequiredExtensions.map((extension, index) =>
    validateAcpExtensionRequirement(extension, `${path}.requiredExtensions[${index}]`),
  );
  assertUnique(requiredExtensions, `${path}.requiredExtensions`);
  return {
    executionProfileId: requiredId(root.executionProfileId, `${path}.executionProfileId`, "profile"),
    profileRevisionId: requiredId(root.profileRevisionId, `${path}.profileRevisionId`, "profile_revision"),
    providerFamily,
    acpAgentKind,
    protocolMajor: 1,
    model: validatePortableProfileModelIdentifier(root.model, `${path}.model`, 300),
    configIntent: cloneJson(configIntent as JsonObject),
    requiredExtensions,
    capabilityPolicy,
  };
}

function validateCapabilityPolicy(value: unknown, path: string): CapabilityPolicy {
  const root = record(value, path);
  assertExactKeys(root, ["requiredCapabilities", "allowedTools", "permissionMode", "maxConcurrentTurns", "maxNativeChildren"], path);
  const capabilities = array(root.requiredCapabilities, `${path}.requiredCapabilities`).map((capability, index) =>
    enumValue(
      capability,
      ["create_binding", "resume_binding", "input_correlation", "provider_receipt", "reconcile", "interrupt", "attention_reply", "native_child", "presentation"] as const,
      `${path}.requiredCapabilities[${index}]`,
    ),
  );
  assertUnique(capabilities, `${path}.requiredCapabilities`);
  const allowedTools = array(root.allowedTools, `${path}.allowedTools`).map((tool, index) =>
    requiredText(tool, `${path}.allowedTools[${index}]`, 240),
  );
  assertUnique(allowedTools, `${path}.allowedTools`);
  return {
    requiredCapabilities: capabilities,
    allowedTools,
    permissionMode: enumValue(root.permissionMode, ["ask", "preapproved", "deny"] as const, `${path}.permissionMode`),
    maxConcurrentTurns: boundedInteger(root.maxConcurrentTurns, `${path}.maxConcurrentTurns`, 1, 32),
    maxNativeChildren: boundedInteger(root.maxNativeChildren, `${path}.maxNativeChildren`, 0, 64),
  };
}

function validateCapabilityPolicyV3(value: unknown, path: string): CapabilityPolicy {
  const root = record(value, path);
  const capabilityPolicy = validateCapabilityPolicy(value, path);
  const allowedTools = array(root.allowedTools, `${path}.allowedTools`).map((tool, index) =>
    validatePortableProfileIdentifier(tool, `${path}.allowedTools[${index}]`, 240),
  );
  return { ...capabilityPolicy, allowedTools };
}

function validatePortableProfileIdentifier(value: unknown, path: string, maxLength: number): string {
  if (typeof value === "string" && CONTROL_CHARACTER.test(value)) {
    throw new TemplateValidationError(`${path} must not contain control characters`);
  }
  const identifier = requiredText(value, path, maxLength);
  if (isPathLikeProfileIdentifier(identifier)) {
    throw new TemplateValidationError(`${path} must be a portable identifier, not a path`);
  }
  if (!PORTABLE_PROFILE_IDENTIFIER.test(identifier)) {
    throw new TemplateValidationError(`${path} must be a portable identifier`);
  }
  return identifier;
}

function validatePortableProfileModelIdentifier(value: unknown, path: string, maxLength: number): string {
  if (typeof value === "string" && CONTROL_CHARACTER.test(value)) {
    throw new TemplateValidationError(`${path} must not contain control characters`);
  }
  const identifier = requiredText(value, path, maxLength);
  if (isPathLikeProfileIdentifier(identifier)) {
    throw new TemplateValidationError(`${path} must be a portable identifier, not a path`);
  }
  if (!PORTABLE_PROFILE_MODEL_IDENTIFIER.test(identifier)) {
    throw new TemplateValidationError(`${path} must be a portable identifier`);
  }
  return identifier;
}

function isPathLikeProfileIdentifier(value: string): boolean {
  const normalized = value.toLowerCase();
  return value.startsWith("/")
    || normalized.startsWith("file://")
    || value.startsWith("./")
    || value.startsWith("../")
    || value.startsWith("~/")
    || value.includes("\\")
    || /^[A-Za-z]:[\\/]/u.test(value)
    || value.split("/").length > 2
    || LOCAL_ARTIFACT_SUFFIX.test(value);
}

function validateAcpExtensionRequirement(value: unknown, path: string): string {
  const extension = requiredText(value, path, 128);
  if (extension.startsWith("/")
    || extension.startsWith("./")
    || extension.startsWith("../")
    || extension.includes("\\")
    || /^[A-Za-z]:/u.test(extension)) {
    throw new TemplateValidationError(`${path} is a path, not an ACP extension name`);
  }
  if (!ACP_STANDARD_EXTENSION_NAMES.has(extension) && !ACP_CUSTOM_EXTENSION_NAME.test(extension)) {
    throw new TemplateValidationError(`${path} is not a valid ACP extension name`);
  }
  if (!ACP_STANDARD_EXTENSION_NAMES.has(extension) && isVersionPinnedExtensionName(extension)) {
    throw new TemplateValidationError(`${path} must not contain a version pin`);
  }
  return extension;
}

function isVersionPinnedExtensionName(value: string): boolean {
  return /(?:^|[._/-])v\d+(?:[._-]\d+)*(?:$|[._/-])/iu.test(value)
    || /(?:^|[._/-])\d+[._-]\d+(?:[._-]\d+)*(?:$|[._/-])/u.test(value)
    || /(?:^|[._/-])(?:version|ver|revision|rev|commit|pin|sha1|sha256|sha512)[._-][a-z0-9]+(?:$|[._/-])/iu.test(value)
    || /(?:^|[._/-])[a-f0-9]{32,}(?:$|[._/-])/iu.test(value);
}

function validateAgentCard(value: unknown, path: string, profileIds: ReadonlySet<string>): AgentCardDefinition {
  const root = record(value, path);
  assertExactKeys(
    root,
    ["agentCardId", "kind", "title", "role", "executionProfileId", "systemPrompt", "capabilityRefs", "dispatchProfile"],
    path,
    ["role", "dispatchProfile"],
  );
  const executionProfileId = requiredId(root.executionProfileId, `${path}.executionProfileId`, "profile");
  if (!profileIds.has(executionProfileId)) {
    throw new TemplateValidationError(`${path}.executionProfileId must reference an execution profile`);
  }
  const capabilityRefs = array(root.capabilityRefs, `${path}.capabilityRefs`).map((capability, index) =>
    validateAgentCapabilityRef(capability, `${path}.capabilityRefs[${index}]`),
  );
  assertUnique(capabilityRefs.map((capability) => `${capability.kind}:${capability.id}`), `${path}.capabilityRefs`);
  return {
    agentCardId: requiredId(root.agentCardId, `${path}.agentCardId`, "agent_card"),
    kind: enumValue(root.kind, ["conductor", "general", "researcher", "implementer", "reviewer", "publisher"] as const, `${path}.kind`),
    title: requiredText(root.title, `${path}.title`, 160),
    ...(root.role === undefined ? {} : { role: optionalText(root.role, `${path}.role`, 500) }),
    executionProfileId,
    systemPrompt: requiredText(root.systemPrompt, `${path}.systemPrompt`, 50_000),
    capabilityRefs,
    ...(root.dispatchProfile === undefined ? {} : { dispatchProfile: validateDispatchProfile(root.dispatchProfile, `${path}.dispatchProfile`) }),
  };
}

function validateAgentCapabilityRef(value: unknown, path: string): AgentCapabilityRef {
  const root = record(value, path);
  assertExactKeys(root, ["kind", "id"], path);
  return {
    kind: enumValue(root.kind, ["mcp", "skill"] as const, `${path}.kind`),
    id: requiredText(root.id, `${path}.id`, 240),
  };
}

function validateDispatchProfile(value: unknown, path: string): AgentDispatchProfile {
  const root = record(value, path);
  assertExactKeys(root, ["title", "description"], path);
  return {
    title: requiredText(root.title, `${path}.title`, 160),
    description: requiredText(root.description, `${path}.description`, 4_000),
  };
}

function validateRoutingPolicy(value: unknown): AgentLoopRoutingPolicy {
  const root = record(value, "routingPolicy");
  assertExactKeys(root, ["mode", "maxConcurrentInvocations", "maxDispatchesPerDecision"], "routingPolicy");
  return {
    mode: enumValue(root.mode, ["agent_loop"] as const, "routingPolicy.mode"),
    maxConcurrentInvocations: boundedInteger(root.maxConcurrentInvocations, "routingPolicy.maxConcurrentInvocations", 1, 32),
    maxDispatchesPerDecision: boundedInteger(root.maxDispatchesPerDecision, "routingPolicy.maxDispatchesPerDecision", 1, 32),
  };
}

function validateDeliverable(value: unknown, path: string, agentCardIds: ReadonlySet<string>): DeliverableDefinition {
  const root = record(value, path);
  assertExactKeys(root, ["artifactPath", "ownerAgentCardId", "description"], path, ["description"]);
  const ownerAgentCardId = requiredId(root.ownerAgentCardId, `${path}.ownerAgentCardId`, "agent_card");
  if (!agentCardIds.has(ownerAgentCardId)) {
    throw new TemplateValidationError(`${path}.ownerAgentCardId must reference an agent card`);
  }
  const artifactPath = requiredText(root.artifactPath, `${path}.artifactPath`, 1_000);
  if (artifactPath.startsWith("/") || artifactPath.split("/").includes("..")) {
    throw new TemplateValidationError(`${path}.artifactPath must be a workspace-relative path`);
  }
  return {
    artifactPath,
    ownerAgentCardId,
    ...(root.description === undefined ? {} : { description: optionalText(root.description, `${path}.description`, 2_000) }),
  };
}

function renderYaml(value: JsonValue, indent: number): string[] {
  const prefix = " ".repeat(indent);
  if (Array.isArray(value)) {
    if (value.length === 0) return [`${prefix}[]`];
    return value.flatMap((entry) => {
      if (isScalar(entry)) return [`${prefix}- ${renderScalar(entry)}`];
      if (Array.isArray(entry) && entry.length === 0) return [`${prefix}- []`];
      if (isJsonObject(entry) && Object.keys(entry).length === 0) return [`${prefix}- {}`];
      return [`${prefix}-`, ...renderYaml(entry, indent + 2)];
    });
  }
  if (isJsonObject(value)) {
    const keys = Object.keys(value).sort();
    if (keys.length === 0) return [`${prefix}{}`];
    return keys.flatMap((key) => {
      const entry = value[key];
      const renderedKey = /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ? key : JSON.stringify(key);
      if (isScalar(entry)) return [`${prefix}${renderedKey}: ${renderScalar(entry)}`];
      if (Array.isArray(entry) && entry.length === 0) return [`${prefix}${renderedKey}: []`];
      if (isJsonObject(entry) && Object.keys(entry).length === 0) return [`${prefix}${renderedKey}: {}`];
      return [`${prefix}${renderedKey}:`, ...renderYaml(entry, indent + 2)];
    });
  }
  if (isScalar(value)) return [`${prefix}${renderScalar(value)}`];
  throw new TemplateYamlParseError("unsupported YAML value");
}

function renderScalar(value: null | boolean | number | string): string {
  return typeof value === "string" ? JSON.stringify(value) : String(value);
}

interface YamlLine {
  readonly indent: number;
  readonly content: string;
  readonly lineNumber: number;
}

function parseRestrictedYaml(source: string): JsonValue {
  const lines = source
    .replace(/^\uFEFF/, "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((raw, index): YamlLine | undefined => {
      if (raw.includes("\t")) throw new TemplateYamlParseError(`tabs are not supported (line ${index + 1})`);
      if (!raw.trim() || raw.trimStart().startsWith("#")) return undefined;
      const indent = raw.length - raw.trimStart().length;
      return { indent, content: raw.trim(), lineNumber: index + 1 };
    })
    .filter((line): line is YamlLine => line !== undefined);
  if (lines.length === 0) throw new TemplateYamlParseError("template YAML has no document");
  const parsed = parseYamlBlock(lines, 0, lines[0].indent);
  if (parsed.next !== lines.length) {
    throw new TemplateYamlParseError(`unexpected YAML content at line ${lines[parsed.next].lineNumber}`);
  }
  return parsed.value;
}

function parseYamlBlock(lines: readonly YamlLine[], start: number, indent: number): { value: JsonValue; next: number } {
  const current = lines[start];
  if (!current || current.indent !== indent) throw new TemplateYamlParseError("invalid YAML indentation");
  return current.content === "-" || current.content.startsWith("- ")
    ? parseYamlArray(lines, start, indent)
    : parseYamlObject(lines, start, indent);
}

function parseYamlArray(lines: readonly YamlLine[], start: number, indent: number): { value: JsonValue; next: number } {
  const values: JsonValue[] = [];
  let index = start;
  while (index < lines.length && lines[index].indent === indent && (lines[index].content === "-" || lines[index].content.startsWith("- "))) {
    const line = lines[index];
    const rest = line.content.slice(1).trim();
    index += 1;
    if (rest) {
      values.push(parseYamlScalar(rest, line.lineNumber));
      continue;
    }
    const child = lines[index];
    if (!child || child.indent <= indent) {
      throw new TemplateYamlParseError(`array item at line ${line.lineNumber} needs an indented value`);
    }
    const parsed = parseYamlBlock(lines, index, child.indent);
    values.push(parsed.value);
    index = parsed.next;
  }
  return { value: values, next: index };
}

function parseYamlObject(lines: readonly YamlLine[], start: number, indent: number): { value: JsonValue; next: number } {
  const value: Record<string, JsonValue> = {};
  let index = start;
  while (index < lines.length && lines[index].indent === indent && lines[index].content !== "-" && !lines[index].content.startsWith("- ")) {
    const line = lines[index];
    const separator = yamlKeySeparator(line.content);
    if (separator < 1) throw new TemplateYamlParseError(`expected key:value at line ${line.lineNumber}`);
    const keyText = line.content.slice(0, separator).trim();
    const key = keyText.startsWith("\"") ? parseYamlScalar(keyText, line.lineNumber) : keyText;
    if (typeof key !== "string" || !key) throw new TemplateYamlParseError(`invalid key at line ${line.lineNumber}`);
    if (Object.prototype.hasOwnProperty.call(value, key)) throw new TemplateYamlParseError(`duplicate key ${key} at line ${line.lineNumber}`);
    const rest = line.content.slice(separator + 1).trim();
    index += 1;
    if (rest) {
      value[key] = parseYamlScalar(rest, line.lineNumber);
      continue;
    }
    const child = lines[index];
    if (!child || child.indent <= indent) {
      throw new TemplateYamlParseError(`key ${key} at line ${line.lineNumber} needs an indented value`);
    }
    const parsed = parseYamlBlock(lines, index, child.indent);
    value[key] = parsed.value;
    index = parsed.next;
  }
  return { value, next: index };
}

function parseYamlScalar(source: string, lineNumber: number): JsonValue {
  if (source === "null" || source === "true" || source === "false") return JSON.parse(source) as JsonValue;
  if (/^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/.test(source)) return Number(source);
  if (source.startsWith("\"") || source.startsWith("[") || source.startsWith("{")) {
    try {
      const parsed: unknown = JSON.parse(source);
      assertJsonValue(parsed, `YAML line ${lineNumber}`);
      return parsed;
    } catch (error) {
      const message = error instanceof Error ? error.message : "invalid JSON scalar";
      throw new TemplateYamlParseError(`invalid JSON-compatible scalar at line ${lineNumber}: ${message}`);
    }
  }
  return source;
}

function yamlKeySeparator(value: string): number {
  let inString = false;
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (inString && escaped) {
      escaped = false;
      continue;
    }
    if (inString && character === "\\") {
      escaped = true;
      continue;
    }
    if (character === "\"") inString = !inString;
    if (!inString && character === ":") return index;
  }
  return -1;
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TemplateValidationError(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function array(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new TemplateValidationError(`${path} must be an array`);
  return value;
}

function assertExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  path: string,
  optional: readonly string[] = [],
): void {
  const allowed = new Set(keys);
  const required = new Set(keys.filter((key) => !optional.includes(key)));
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new TemplateValidationError(`${path}.${key} is not supported by this schema`);
  }
  for (const key of required) {
    if (!(key in value)) throw new TemplateValidationError(`${path}.${key} is required`);
  }
}

function rejectForbiddenTemplateFields(value: unknown, path = "template package"): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => rejectForbiddenTemplateFields(entry, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const normalized = key.toLowerCase().replace(/[_-]/g, "");
    if (FORBIDDEN_TEMPLATE_FIELDS.has(normalized)) {
      throw new TemplateValidationError(`${path}.${key} is not portable template content`);
    }
    rejectForbiddenTemplateFields(entry, `${path}.${key}`);
  }
}

const FORBIDDEN_TEMPLATE_FIELDS = new Set([
  "apikey",
  "token",
  "accesstoken",
  "credential",
  "credentials",
  "secret",
  "cwd",
  "providersessionid",
  "nativesessionid",
  "nativethreadid",
  "threadid",
  "taskid",
  "runid",
]);

/** v3 config intent is portable behavior intent, never a local resolution pin. */
function rejectHostResolutionFields(value: unknown, path: string): void {
  if (typeof value === "string" && isAbsoluteMachinePath(value)) {
    throw new TemplateValidationError(`${path} is Host-private resolution content`);
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => rejectHostResolutionFields(entry, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const normalized = key.toLowerCase().replace(/[_-]/g, "");
    if (HOST_RESOLUTION_FIELDS.has(normalized)) {
      throw new TemplateValidationError(`${path}.${key} is Host-private resolution content`);
    }
    rejectHostResolutionFields(entry, `${path}.${key}`);
  }
}

const HOST_RESOLUTION_FIELDS = new Set([
  "path",
  "artifactpath",
  "artifactdigest",
  "launcher",
  "launcherpath",
  "command",
  "commandref",
  "executable",
  "binary",
  "version",
  "providerversion",
  "wrapperversion",
  "upstreamversion",
  "hash",
  "digest",
  "checksum",
  "fingerprint",
  "protocolfingerprint",
  "signature",
  "sessionid",
  "rawsessionid",
  "providersessionid",
  "nativebindingref",
  "request",
  "requestid",
  "rawrequest",
  "rawrequestid",
  "option",
  "optionid",
  "rawoption",
  "rawoptionid",
  "tool",
  "toolid",
  "toolcall",
  "toolcallid",
  "rawtool",
  "rawtoolcall",
  "jsonrpc",
  "jsonrpcid",
  "acpsessionid",
  "nativesessionid",
  "rawmessage",
  "rawmessageid",
  "wirepayload",
  "rawpayload",
]);

function isAbsoluteMachinePath(value: string): boolean {
  return value.startsWith("/") || value.startsWith("file://") || /^[A-Za-z]:[\\/]/.test(value);
}

function requiredText(value: unknown, path: string, maxLength: number): string {
  if (typeof value !== "string" || !value.trim()) throw new TemplateValidationError(`${path} must be a non-empty string`);
  const result = value.trim();
  if (result.length > maxLength) throw new TemplateValidationError(`${path} exceeds ${maxLength} characters`);
  return result;
}

function optionalText(value: unknown, path: string, maxLength: number): string {
  return requiredText(value, path, maxLength);
}

function requiredId(value: unknown, path: string, prefix: string): string {
  const result = requiredText(value, path, 300);
  if (!new RegExp(`^${prefix}_[A-Za-z0-9-]+$`).test(result)) {
    throw new TemplateValidationError(`${path} must use the ${prefix}_ ID prefix`);
  }
  return result;
}

/** Historical runtime IDs allowed underscores inside their opaque suffix. */
function requiredLegacyId(value: unknown, path: string, prefix: string): string {
  const result = requiredText(value, path, 300);
  if (!new RegExp(`^${prefix}_[A-Za-z0-9][A-Za-z0-9_-]*$`).test(result)) {
    throw new TemplateValidationError(`${path} must use the ${prefix}_ ID prefix`);
  }
  return result;
}

function slug(value: unknown, path: string): string {
  const result = requiredText(value, path, 160);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(result)) {
    throw new TemplateValidationError(`${path} must be a lowercase kebab-case slug`);
  }
  return result;
}

function positiveInteger(value: unknown, path: string): number {
  return boundedInteger(value, path, 1, Number.MAX_SAFE_INTEGER);
}

function boundedInteger(value: unknown, path: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
    throw new TemplateValidationError(`${path} must be an integer between ${min} and ${max}`);
  }
  return value as number;
}

function enumValue<const T extends readonly string[]>(value: unknown, choices: T, path: string): T[number] {
  if (typeof value !== "string" || !choices.includes(value)) {
    throw new TemplateValidationError(`${path} must be one of ${choices.join(", ")}`);
  }
  return value as T[number];
}

function assertUnique(values: readonly string[], path: string): void {
  if (new Set(values).size !== values.length) throw new TemplateValidationError(`${path} values must be unique`);
}

function isScalar(value: JsonValue): value is null | boolean | number | string {
  return value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string";
}

function isJsonObject(value: JsonValue): value is JsonObject {
  return !Array.isArray(value) && typeof value === "object" && value !== null;
}

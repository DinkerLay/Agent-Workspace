import { createHash } from "node:crypto";
import path from "node:path";
import type {
  AgentCardKind,
  ExecutionProfileDefinitionV3,
} from "@agent-workspace/runtime-contracts";
import { assertSessionExecutionSafeValue } from "@agent-workspace/runtime-contracts";
import type {
  AcpQualificationObservation,
  AcpV1Capability,
} from "@agent-workspace/provider-acp";
import type {
  AcpPortableProfileDefinitionV3,
  LocalProfileResolution,
} from "./acp-profile-resolution.js";

const SAFE_CODE = /^[a-z0-9][a-z0-9:_-]{0,159}$/u;
const SAFE_BEHAVIOR = /^[a-z][a-z0-9_.-]{0,127}$/u;
const SAFE_OBSERVATION_KEY = /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/u;
const SAFE_EXTENSION = /^[A-Za-z][A-Za-z0-9._/-]{0,127}$/u;

type AcpInitializeObservation = AcpQualificationObservation;

export type AcpQualificationRole = AgentCardKind | "worker" | "meta";

/** Object identity, rather than a serializable id, fences one Host process generation. */
export interface AcpHostGenerationFence {
  isActive(): boolean;
}

export type AcpRoleBehaviorProbe = Readonly<{
  readonly role: AcpQualificationRole;
  readonly requiredBehaviors: readonly string[];
  readonly passedBehaviors: readonly string[];
  readonly safeObservations?: Readonly<Record<string, string | number | boolean | null>>;
}>;

export type AcpQualificationSafeReport = Readonly<{
  readonly profileRevisionId: string;
  readonly providerFamily: ExecutionProfileDefinitionV3["providerFamily"];
  readonly acpAgentKind: ExecutionProfileDefinitionV3["acpAgentKind"];
  readonly role: AcpQualificationRole;
  readonly available: boolean;
  readonly protocolMajor: number | null;
  readonly agent?: Readonly<{
    readonly name: string;
    readonly title?: string;
    readonly version?: string;
  }>;
  readonly capabilities: AcpQualificationObservation["capabilities"];
  readonly extensions: readonly string[];
  readonly capabilityFingerprint: string;
  readonly probeFingerprint: string;
  readonly unavailableReasons: readonly string[];
  readonly observedArtifactVersion: string;
  readonly observedUpstreamVersion?: string;
}>;

declare const qualificationBrand: unique symbol;
export type AcpQualification = Readonly<{ readonly [qualificationBrand]: true }>;

export type AcpQualificationIssueResult =
  | Readonly<{
      readonly available: true;
      readonly qualification: AcpQualification;
      readonly report: AcpQualificationSafeReport;
    }>
  | Readonly<{
      readonly available: false;
      readonly report: AcpQualificationSafeReport;
    }>;

export class AcpQualificationError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "AcpQualificationError";
    this.code = code;
  }
}

export function projectSafeAcpAgentObservation(
  value: unknown,
): AcpQualificationObservation["agent"] | undefined {
  if (value === undefined) return undefined;
  try {
    return normalizeSafeAgent(value);
  } catch {
    return undefined;
  }
}

type QualificationFacts = Readonly<{
  readonly profileFingerprint: string;
  readonly resolution: LocalProfileResolution;
  readonly generation: AcpHostGenerationFence;
  readonly actualModel: string;
  readonly rolePolicyDigest: string;
  readonly capabilityFingerprint: string;
  readonly probeFingerprint: string;
}>;

export type AcpQualificationAuthority = Readonly<{
  issue(input: Readonly<{
    profile: AcpPortableProfileDefinitionV3;
    resolution: LocalProfileResolution;
    generation: AcpHostGenerationFence;
    actualModel: string;
    rolePolicyDigest: string;
    requiredAcpCapabilities: readonly AcpV1Capability[];
    requiredAnyAcpCapabilities?: readonly AcpV1Capability[];
    initializeObservation: AcpInitializeObservation;
    probe: AcpRoleBehaviorProbe;
  }>): Promise<AcpQualificationIssueResult>;
  assertUsable(
    qualification: unknown,
    expected: Readonly<{
      profile: AcpPortableProfileDefinitionV3;
      resolution: LocalProfileResolution;
      generation: AcpHostGenerationFence;
      actualModel: string;
      rolePolicyDigest: string;
      initializeFingerprint: string;
    }>,
  ): Promise<void>;
}>;

/**
 * Qualification is an in-memory Host capability. The returned token has no
 * enumerable state; only this authority's WeakMap can recognize it.
 */
export function createAcpQualificationAuthority(): AcpQualificationAuthority {
  const issued = new WeakMap<object, QualificationFacts>();

  return Object.freeze({
    async issue(input): Promise<AcpQualificationIssueResult> {
      assertExactKeys(input, [
        "profile",
        "resolution",
        "generation",
        "actualModel",
        "rolePolicyDigest",
        "requiredAcpCapabilities",
        "requiredAnyAcpCapabilities",
        "initializeObservation",
        "probe",
      ], "acp_qualification_input_invalid");
      validateIssueInput(input);
      await input.resolution.assertCurrent();
      const probe = normalizeProbe(input.probe);
      const initialize = normalizeInitializeObservation(input.initializeObservation);
      const unavailableReasons = [...initialize.unavailableReasons];
      if ("role" in input.profile && input.profile.role !== probe.role) {
        unavailableReasons.push("acp_role_mismatch");
      }
      if (!initialize.available && unavailableReasons.length === 0) {
        unavailableReasons.push("acp_initialize_unavailable");
      }
      if (initialize.protocolMajor !== input.profile.protocolMajor) {
        unavailableReasons.push("acp_protocol_major_mismatch");
      }
      const requiredAcpCapabilities = normalizeRequiredCapabilities(input.requiredAcpCapabilities);
      for (const capability of requiredAcpCapabilities) {
        if (!initialize.capabilities.includes(capability)) {
          unavailableReasons.push(`acp_capability_missing:${capability}`);
        }
      }
      const requiredAnyAcpCapabilities = input.requiredAnyAcpCapabilities === undefined
        ? Object.freeze([])
        : normalizeRequiredCapabilities(input.requiredAnyAcpCapabilities);
      if (requiredAnyAcpCapabilities.length > 0
        && !requiredAnyAcpCapabilities.some((capability) => (
          initialize.capabilities.includes(capability)
        ))) {
        unavailableReasons.push("acp_capability_one_of_missing");
      }
      for (const extension of normalizeRequiredExtensions(input.profile.requiredExtensions)) {
        if (!initialize.extensions.includes(extension)) {
          unavailableReasons.push(`acp_extension_missing:${extension}`);
        }
      }
      if (input.resolution.safeObservation().trust !== "trusted") {
        unavailableReasons.push("acp_resolution_untrusted");
      }
      if (!input.generation.isActive()) unavailableReasons.push("acp_generation_inactive");
      if (input.actualModel !== input.profile.model) unavailableReasons.push("acp_model_mismatch");
      for (const behavior of probe.requiredBehaviors) {
        if (!probe.passedBehaviors.includes(behavior)) {
          unavailableReasons.push(`acp_behavior_missing:${behavior}`);
        }
      }
      const dedupedReasons = Object.freeze([...new Set(unavailableReasons)]);
      const probeFingerprint = digest({
        role: probe.role,
        requiredBehaviors: probe.requiredBehaviors,
        passedBehaviors: probe.passedBehaviors,
        safeObservations: probe.safeObservations ?? {},
      });
      const resolutionObservation = input.resolution.safeObservation();
      const report: AcpQualificationSafeReport = Object.freeze({
        profileRevisionId: input.profile.profileRevisionId,
        providerFamily: input.profile.providerFamily,
        acpAgentKind: input.profile.acpAgentKind,
        role: probe.role,
        available: dedupedReasons.length === 0,
        protocolMajor: initialize.protocolMajor,
        ...(initialize.agent ? { agent: initialize.agent } : {}),
        capabilities: initialize.capabilities,
        extensions: initialize.extensions,
        capabilityFingerprint: initialize.capabilityFingerprint,
        probeFingerprint,
        unavailableReasons: dedupedReasons,
        observedArtifactVersion: resolutionObservation.observedArtifactVersion,
        ...(resolutionObservation.observedUpstreamVersion
          ? { observedUpstreamVersion: resolutionObservation.observedUpstreamVersion }
          : {}),
      });
      if (!report.available) return Object.freeze({ available: false, report });

      const qualification = Object.freeze(Object.create(null)) as AcpQualification;
      issued.set(qualification, Object.freeze({
        profileFingerprint: profileFingerprint(input.profile),
        resolution: input.resolution,
        generation: input.generation,
        actualModel: input.actualModel,
        rolePolicyDigest: input.rolePolicyDigest,
        capabilityFingerprint: initialize.capabilityFingerprint,
        probeFingerprint,
      }));
      return Object.freeze({ available: true, qualification, report });
    },

    async assertUsable(qualification, expected): Promise<void> {
      if (!qualification || typeof qualification !== "object") {
        throw safeError("acp_qualification_unrecognized");
      }
      const facts = issued.get(qualification as object);
      if (!facts) throw safeError("acp_qualification_unrecognized");
      assertExactKeys(expected, [
        "profile",
        "resolution",
        "generation",
        "actualModel",
        "rolePolicyDigest",
        "initializeFingerprint",
      ], "acp_qualification_input_invalid");
      validateExpected(expected);
      if (facts.profileFingerprint !== profileFingerprint(expected.profile)) {
        throw safeError("acp_qualification_profile_mismatch");
      }
      if (facts.resolution !== expected.resolution) {
        throw safeError("acp_qualification_resolution_mismatch");
      }
      if (facts.generation !== expected.generation) {
        throw safeError("acp_qualification_generation_mismatch");
      }
      if (!facts.generation.isActive()) {
        throw safeError("acp_qualification_generation_inactive");
      }
      if (facts.actualModel !== expected.actualModel) {
        throw safeError("acp_qualification_model_mismatch");
      }
      if (facts.rolePolicyDigest !== expected.rolePolicyDigest) {
        throw safeError("acp_qualification_role_policy_mismatch");
      }
      if (facts.capabilityFingerprint !== safeDigest(expected.initializeFingerprint)) {
        throw safeError("acp_qualification_initialize_fingerprint_mismatch");
      }
      if (!expected.resolution.matchesProfile(expected.profile)) {
        throw safeError("acp_qualification_resolution_profile_mismatch");
      }
      await expected.resolution.assertCurrent();
    },
  });
}

function validateIssueInput(input: Readonly<{
  profile: AcpPortableProfileDefinitionV3;
  resolution: LocalProfileResolution;
  generation: AcpHostGenerationFence;
  actualModel: string;
  rolePolicyDigest: string;
  requiredAcpCapabilities: readonly AcpV1Capability[];
  requiredAnyAcpCapabilities?: readonly AcpV1Capability[];
}>): void {
  validateExpectedBase(input);
  if (!input.resolution.matchesProfile(input.profile)) {
    throw safeError("acp_qualification_resolution_profile_mismatch");
  }
  normalizeRequiredCapabilities(input.requiredAcpCapabilities);
  if (input.requiredAnyAcpCapabilities !== undefined
    && normalizeRequiredCapabilities(input.requiredAnyAcpCapabilities).length === 0) {
    throw safeError("acp_required_capabilities_invalid");
  }
}

function validateExpected(input: Readonly<{
  profile: AcpPortableProfileDefinitionV3;
  resolution: LocalProfileResolution;
  generation: AcpHostGenerationFence;
  actualModel: string;
  rolePolicyDigest: string;
  initializeFingerprint: string;
}>): void {
  validateExpectedBase(input);
  safeDigest(input.initializeFingerprint);
}

function validateExpectedBase(input: Readonly<{
  profile: AcpPortableProfileDefinitionV3;
  resolution: LocalProfileResolution;
  generation: AcpHostGenerationFence;
  actualModel: string;
  rolePolicyDigest: string;
}>): void {
  if (!input?.profile || !input.resolution || typeof input.resolution.assertCurrent !== "function") {
    throw safeError("acp_qualification_input_invalid");
  }
  if (!input.generation || typeof input.generation.isActive !== "function") {
    throw safeError("acp_qualification_generation_invalid");
  }
  requiredText(input.actualModel, "acp_qualification_model_invalid");
  requiredText(input.rolePolicyDigest, "acp_qualification_role_policy_invalid");
}

function normalizeInitializeObservation(
  value: AcpInitializeObservation,
): AcpInitializeObservation & Readonly<{ readonly extensions: readonly string[] }> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw safeError("acp_initialize_observation_invalid");
  }
  assertExactKeys(value, [
    "available",
    "protocolMajor",
    "agent",
    "capabilities",
    "extensions",
    "capabilityFingerprint",
    "unavailableReasons",
  ], "acp_initialize_observation_invalid");
  if (value.protocolMajor !== null && !Number.isSafeInteger(value.protocolMajor)) {
    throw safeError("acp_initialize_observation_invalid");
  }
  const capabilities = Object.freeze([...new Set(value.capabilities)].sort());
  const extensions = Object.freeze([...new Set(value.extensions.map((extension) => {
    if (typeof extension !== "string" || !SAFE_EXTENSION.test(extension)) {
      throw safeError("acp_initialize_extension_invalid");
    }
    return extension;
  }))].sort());
  const unavailableReasons = Object.freeze(value.unavailableReasons.map((reason) => safeCode(reason)));
  const agent = value.agent ? normalizeSafeAgent(value.agent) : undefined;
  return Object.freeze({
    available: value.available,
    protocolMajor: value.protocolMajor,
    ...(agent ? { agent } : {}),
    capabilities,
    extensions,
    capabilityFingerprint: safeDigest(value.capabilityFingerprint),
    unavailableReasons,
  });
}

function normalizeSafeAgent(value: unknown): NonNullable<AcpQualificationObservation["agent"]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw safeError("acp_initialize_agent_invalid");
  }
  assertExactKeys(
    value,
    ["name", "title", "version"],
    "acp_initialize_agent_invalid",
  );
  const name = Reflect.get(value, "name");
  const title = Reflect.get(value, "title");
  const version = Reflect.get(value, "version");
  return Object.freeze({
    name: safeDisplayText(name, "acp_initialize_agent_invalid"),
    ...(title
      ? { title: safeDisplayText(title, "acp_initialize_agent_invalid") }
      : {}),
    ...(version
      ? { version: safeVersion(version, "acp_initialize_agent_version_invalid") }
      : {}),
  });
}

function normalizeRequiredExtensions(value: readonly string[]): readonly string[] {
  if (!Array.isArray(value) || value.length > 64) {
    throw safeError("acp_required_extensions_invalid");
  }
  const extensions = value.map((extension) => {
    if (typeof extension !== "string" || !SAFE_EXTENSION.test(extension)) {
      throw safeError("acp_required_extensions_invalid");
    }
    return extension;
  });
  if (new Set(extensions).size !== extensions.length) {
    throw safeError("acp_required_extensions_invalid");
  }
  return Object.freeze([...extensions].sort());
}

function normalizeProbe(probe: AcpRoleBehaviorProbe): AcpRoleBehaviorProbe {
  if (!probe || typeof probe !== "object" || Array.isArray(probe)) {
    throw safeError("acp_behavior_probe_invalid");
  }
  assertExactKeys(probe, [
    "role",
    "requiredBehaviors",
    "passedBehaviors",
    "safeObservations",
  ], "acp_behavior_probe_invalid");
  if (![
    "conductor",
    "general",
    "researcher",
    "implementer",
    "reviewer",
    "publisher",
    "worker",
    "meta",
  ].includes(probe.role)) {
    throw safeError("acp_behavior_probe_role_invalid");
  }
  const requiredBehaviors = normalizeBehaviors(probe.requiredBehaviors);
  const passedBehaviors = normalizeBehaviors(probe.passedBehaviors);
  if (passedBehaviors.some((behavior) => !requiredBehaviors.includes(behavior))) {
    throw safeError("acp_behavior_probe_unrequired_pass");
  }
  let safeObservations: Readonly<Record<string, string | number | boolean | null>> | undefined;
  if (probe.safeObservations !== undefined) {
    assertSessionExecutionSafeValue(probe.safeObservations, "acp qualification probe");
    const copy: Record<string, string | number | boolean | null> = {};
    for (const [key, entry] of Object.entries(probe.safeObservations)) {
      if (!SAFE_OBSERVATION_KEY.test(key) || !isSafeObservationPrimitive(entry)) {
        throw safeError("acp_behavior_probe_observation_invalid");
      }
      if (typeof entry === "string" && (path.isAbsolute(entry) || entry.includes("\0"))) {
        throw safeError("acp_behavior_probe_observation_private");
      }
      copy[key] = entry;
    }
    safeObservations = Object.freeze(copy);
  }
  return Object.freeze({
    role: probe.role,
    requiredBehaviors,
    passedBehaviors,
    ...(safeObservations ? { safeObservations } : {}),
  });
}

function normalizeBehaviors(value: readonly string[]): readonly string[] {
  if (!Array.isArray(value) || value.length > 64) throw safeError("acp_behavior_probe_invalid");
  const normalized = value.map((entry) => {
    if (typeof entry !== "string" || !SAFE_BEHAVIOR.test(entry)) {
      throw safeError("acp_behavior_probe_invalid");
    }
    return entry;
  });
  return Object.freeze([...new Set(normalized)].sort());
}

function normalizeRequiredCapabilities(
  value: readonly AcpV1Capability[],
): readonly AcpV1Capability[] {
  if (!Array.isArray(value) || value.length > 32) {
    throw safeError("acp_required_capabilities_invalid");
  }
  const allowed = new Set<AcpV1Capability>([
    "session_new",
    "session_prompt",
    "session_cancel",
    "session_update",
    "session_load",
    "session_resume",
    "session_close",
    "mcp_stdio",
    "mcp_http",
    "mcp_sse",
    "permission",
  ]);
  for (const capability of value) {
    if (!allowed.has(capability)) throw safeError("acp_required_capabilities_invalid");
  }
  return Object.freeze([...new Set(value)].sort());
}

function isSafeObservationPrimitive(value: unknown): value is string | number | boolean | null {
  return value === null
    || typeof value === "string"
    || typeof value === "boolean"
    || (typeof value === "number" && Number.isFinite(value));
}

function profileFingerprint(profile: AcpPortableProfileDefinitionV3): string {
  return digest(profile);
}

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(stableJson(value)).digest("hex")}`;
}

function safeDigest(value: unknown): string {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/iu.test(value)) {
    throw safeError("acp_qualification_digest_invalid");
  }
  return value;
}

function safeCode(value: unknown): string {
  if (typeof value === "string") {
    if (SAFE_CODE.test(value)) return value;
    const extensionPrefix = "acp_extension_missing:";
    if (value.startsWith(extensionPrefix)
      && SAFE_EXTENSION.test(value.slice(extensionPrefix.length))) {
      return value;
    }
  }
  throw safeError("acp_qualification_reason_invalid");
}

function safeDisplayText(value: unknown, code: string): string {
  const text = requiredText(value, code);
  if (text.length > 160 || path.isAbsolute(text) || containsEmbeddedPrivatePath(text)) {
    throw safeError(code);
  }
  return text;
}

function containsEmbeddedPrivatePath(value: string): boolean {
  return /[\u0000-\u001f\u007f]/u.test(value)
    || /file:\/\//iu.test(value)
    || /(^|[\s("'`])~[\\/]/u.test(value)
    || /(^|[\s("'`])[A-Za-z]:[\\/][^\s]/u.test(value)
    || /(^|[\s("'`])\\\\[^\\\s]+\\/u.test(value)
    || /(^|[\s("'`])\/(?!\/)[^\s]/u.test(value);
}

function safeVersion(value: unknown, code: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._+~-]{0,127}$/u.test(value)) {
    throw safeError(code);
  }
  return value;
}

function requiredText(value: unknown, code: string): string {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) throw safeError(code);
  return value;
}

function assertExactKeys(
  value: object,
  allowedKeys: readonly string[],
  code: string,
): void {
  const allowed = new Set(allowedKeys);
  if (Object.keys(value).some((key) => !allowed.has(key))) throw safeError(code);
}

function safeError(code: string): AcpQualificationError {
  return new AcpQualificationError(code);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import {
  validateMetaProfileDefinitionV3,
  type ExecutionProfileDefinitionV3,
  type MetaProfileDefinitionV3,
} from "@agent-workspace/runtime-contracts";
import type { AcpExtensionPredicate } from "@agent-workspace/provider-acp";

const SHA256 = /^sha256:[a-f0-9]{64}$/iu;
const SAFE_VERSION = /^[A-Za-z0-9][A-Za-z0-9._+:@-]{0,159}$/u;
const ENVIRONMENT_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u;
const FORBIDDEN_PORTABLE_KEYS = new Set([
  "artifactDigest",
  "canonicalLauncherPath",
  "credential",
  "credentials",
  "cwd",
  "environment",
  "launcherPath",
  "localResolutionSeal",
  "protocolFingerprint",
  "providerVersion",
  "resolutionId",
  "upstreamVersion",
  "workspacePath",
  "wrapperVersion",
]);

export type AcpResolutionTrustState = "trusted" | "untrusted";
export type AcpPortableProfileDefinitionV3 =
  | ExecutionProfileDefinitionV3
  | MetaProfileDefinitionV3;

/**
 * Host-private result of inspecting the installed entry. A provider-specific
 * descriptor may start from a symlink, but must return its canonical regular
 * executable identity and content digest here.
 */
export type AcpDiscoveredArtifact = Readonly<{
  readonly canonicalLauncherPath: string;
  readonly launchArguments: readonly string[];
  readonly observedArtifactVersion: string;
  readonly observedUpstreamVersion?: string;
  readonly artifactDigest: string;
  readonly trustState: AcpResolutionTrustState;
  readonly executionConfigDigest: string;
  /** Explicit non-ambient launch environment. Credentials are leased later. */
  readonly environment: Readonly<Record<string, string>>;
  /** Host-private runtime directory for Profiles that intentionally have no Workspace cwd. */
  readonly defaultWorkingDirectory?: string;
}>;

export type AcpCurrentInstallDescriptor<
  TProfile extends AcpPortableProfileDefinitionV3 = ExecutionProfileDefinitionV3,
> = Readonly<{
  readonly descriptorId: string;
  /** Host-private exact proofs for namespaced initialize `_meta` extensions. */
  readonly extensionPredicates?: Readonly<Record<string, AcpExtensionPredicate>>;
  discoverCurrent(profile: TProfile): Promise<AcpDiscoveredArtifact>;
}>;

export type AcpResolutionSafeObservation = Readonly<{
  readonly profileRevisionId: string;
  readonly providerFamily: ExecutionProfileDefinitionV3["providerFamily"];
  readonly acpAgentKind: ExecutionProfileDefinitionV3["acpAgentKind"];
  readonly protocolMajor: 1;
  readonly trust: AcpResolutionTrustState;
  readonly observedArtifactVersion: string;
  readonly observedUpstreamVersion?: string;
}>;

export type AcpHostPrivateLaunchMaterial = Readonly<{
  readonly hostPrivateResolutionId: string;
  readonly descriptorId: string;
  readonly canonicalLauncherPath: string;
  readonly launchArguments: readonly string[];
  readonly observedArtifactVersion: string;
  readonly observedUpstreamVersion?: string;
  readonly artifactDigest: string;
  readonly trustState: AcpResolutionTrustState;
  readonly executionConfigDigest: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly defaultWorkingDirectory?: string;
  readonly observedAt: string;
  readonly sealFingerprint: string;
}>;

export class AcpProfileResolutionError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "AcpProfileResolutionError";
    this.code = code;
  }
}

/**
 * Exact current-install seal. Raw local material lives in private fields and
 * `toJSON` deliberately projects only the Renderer-safe observation.
 */
export class LocalProfileResolution {
  readonly profileRevisionId: string;
  readonly providerFamily: ExecutionProfileDefinitionV3["providerFamily"];
  readonly acpAgentKind: ExecutionProfileDefinitionV3["acpAgentKind"];
  readonly protocolMajor = 1 as const;

  readonly #profileFingerprint: string;
  readonly #discoverCurrent: () => Promise<AcpDiscoveredArtifact>;
  readonly #material: AcpHostPrivateLaunchMaterial;
  #invalidated = false;

  constructor(input: Readonly<{
    profile: AcpPortableProfileDefinitionV3;
    profileFingerprint: string;
    discoverCurrent: () => Promise<AcpDiscoveredArtifact>;
    material: AcpHostPrivateLaunchMaterial;
  }>) {
    this.profileRevisionId = input.profile.profileRevisionId;
    this.providerFamily = input.profile.providerFamily;
    this.acpAgentKind = input.profile.acpAgentKind;
    this.#profileFingerprint = input.profileFingerprint;
    this.#discoverCurrent = input.discoverCurrent;
    this.#material = input.material;
    Object.freeze(this);
  }

  safeObservation(): AcpResolutionSafeObservation {
    return Object.freeze({
      profileRevisionId: this.profileRevisionId,
      providerFamily: this.providerFamily,
      acpAgentKind: this.acpAgentKind,
      protocolMajor: this.protocolMajor,
      trust: this.#material.trustState,
      observedArtifactVersion: this.#material.observedArtifactVersion,
      ...(this.#material.observedUpstreamVersion
        ? { observedUpstreamVersion: this.#material.observedUpstreamVersion }
        : {}),
    });
  }

  toJSON(): AcpResolutionSafeObservation {
    return this.safeObservation();
  }

  /** Host-only process launch material. Never persist or project this value. */
  hostPrivateLaunchMaterial(): AcpHostPrivateLaunchMaterial {
    if (this.#invalidated) throw safeError("acp_current_artifact_drift");
    return this.#material;
  }

  matchesProfile(profile: AcpPortableProfileDefinitionV3): boolean {
    assertPortableProfile(profile);
    return portableProfileFingerprint(profile) === this.#profileFingerprint;
  }

  /** Re-resolves the selected entry and seals entry->canonical target drift. */
  async assertCurrent(): Promise<void> {
    if (this.#invalidated) throw safeError("acp_current_artifact_drift");
    let current: AcpDiscoveredArtifact;
    try {
      current = normalizeArtifact(await this.#discoverCurrent());
    } catch (error) {
      this.#invalidated = true;
      if (error instanceof AcpProfileResolutionError) throw error;
      throw safeError("acp_current_artifact_unavailable");
    }
    if (artifactFingerprint(current) !== this.#material.sealFingerprint) {
      this.#invalidated = true;
      throw safeError("acp_current_artifact_drift");
    }
  }
}

export type AcpProfileResolutionRegistry = Readonly<{
  resolve<TProfile extends AcpPortableProfileDefinitionV3>(
    profile: TProfile,
    descriptor: AcpCurrentInstallDescriptor<TProfile>,
  ): Promise<LocalProfileResolution>;
}>;

export function createAcpProfileResolutionRegistry(options: Readonly<{
  readonly now?: () => string;
  readonly createOpaqueId?: () => string;
}> = {}): AcpProfileResolutionRegistry {
  const now = options.now ?? (() => new Date().toISOString());
  const createOpaqueId = options.createOpaqueId ?? (() => `acp_resolution_${randomUUID()}`);
  const inFlight = new Map<string, Promise<LocalProfileResolution>>();
  const descriptorIdentities = new WeakMap<object, number>();
  let nextDescriptorIdentity = 1;

  const descriptorIdentity = (descriptor: object): number => {
    const existing = descriptorIdentities.get(descriptor);
    if (existing !== undefined) return existing;
    const identity = nextDescriptorIdentity;
    nextDescriptorIdentity += 1;
    descriptorIdentities.set(descriptor, identity);
    return identity;
  };

  return Object.freeze({
    async resolve(profile, descriptor) {
      assertPortableProfile(profile);
      const validatedProfile = snapshotPortableProfile(profile);
      const descriptorId = requiredText(descriptor?.descriptorId, "acp_resolution_descriptor_id_required");
      if (typeof descriptor?.discoverCurrent !== "function") {
        return Promise.reject(safeError("acp_resolution_descriptor_invalid"));
      }
      const profileFingerprint = portableProfileFingerprint(validatedProfile);
      const key = `${descriptorIdentity(descriptor)}\0${descriptorId}\0${profileFingerprint}`;
      const existing = inFlight.get(key);
      if (existing) return existing;
      const pending = (async () => {
        let artifact: AcpDiscoveredArtifact;
        try {
          artifact = normalizeArtifact(await descriptor.discoverCurrent(validatedProfile));
        } catch (error) {
          if (error instanceof AcpProfileResolutionError) throw error;
          throw safeError("acp_current_artifact_unavailable");
        }
        const sealFingerprint = artifactFingerprint(artifact);
        const material: AcpHostPrivateLaunchMaterial = Object.freeze({
          hostPrivateResolutionId: requiredOpaqueId(
            createOpaqueId(),
            "acp_private_resolution_id_invalid",
          ),
          descriptorId,
          canonicalLauncherPath: artifact.canonicalLauncherPath,
          launchArguments: artifact.launchArguments,
          observedArtifactVersion: artifact.observedArtifactVersion,
          ...(artifact.observedUpstreamVersion
            ? { observedUpstreamVersion: artifact.observedUpstreamVersion }
            : {}),
          artifactDigest: artifact.artifactDigest,
          trustState: artifact.trustState,
          executionConfigDigest: artifact.executionConfigDigest,
          environment: artifact.environment,
          ...(artifact.defaultWorkingDirectory
            ? { defaultWorkingDirectory: artifact.defaultWorkingDirectory }
            : {}),
          observedAt: requiredIsoDate(now()),
          sealFingerprint,
        });
        return new LocalProfileResolution({
          profile: validatedProfile,
          profileFingerprint,
          discoverCurrent: () => descriptor.discoverCurrent(validatedProfile),
          material,
        });
      })().finally(() => {
        inFlight.delete(key);
      });
      inFlight.set(key, pending);
      return pending;
    },
  });
}

function assertPortableProfile(
  profile: AcpPortableProfileDefinitionV3,
): void {
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) {
    throw safeError("acp_portable_profile_invalid");
  }
  if (containsForbiddenPortableKey(profile)) {
    throw safeError("acp_portable_profile_contains_host_fields");
  }
  if ("metaProfileId" in profile || "role" in profile) {
    try {
      validateMetaProfileDefinitionV3(profile);
      return;
    } catch {
      throw safeError("acp_meta_portable_profile_invalid");
    }
  }
  requiredOpaqueId(
    profile.executionProfileId,
    "acp_execution_profile_id_required",
  );
  requiredOpaqueId(profile.profileRevisionId, "acp_profile_revision_id_required");
  requiredText(profile.providerFamily, "acp_provider_family_required");
  requiredText(profile.acpAgentKind, "acp_agent_kind_required");
  if (profile.protocolMajor !== 1) throw safeError("acp_protocol_major_unsupported");
  requiredText(profile.model, "acp_profile_model_required");
  if (!profile.configIntent || typeof profile.configIntent !== "object" || Array.isArray(profile.configIntent)) {
    throw safeError("acp_profile_config_intent_invalid");
  }
}

function normalizeArtifact(value: AcpDiscoveredArtifact): AcpDiscoveredArtifact {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw safeError("acp_current_artifact_invalid");
  }
  if (typeof value.canonicalLauncherPath !== "string" || !path.isAbsolute(value.canonicalLauncherPath)) {
    throw safeError("acp_current_artifact_canonical_path_invalid");
  }
  if (!Array.isArray(value.launchArguments) || value.launchArguments.length > 64) {
    throw safeError("acp_current_artifact_arguments_invalid");
  }
  const launchArguments = value.launchArguments.map((argument) => {
    if (typeof argument !== "string" || argument.includes("\0") || Buffer.byteLength(argument, "utf8") > 16_384) {
      throw safeError("acp_current_artifact_arguments_invalid");
    }
    return argument;
  });
  const observedArtifactVersion = safeVersion(
    value.observedArtifactVersion,
    "acp_current_artifact_version_missing",
  );
  const observedUpstreamVersion = value.observedUpstreamVersion === undefined
    ? undefined
    : safeVersion(value.observedUpstreamVersion, "acp_current_artifact_upstream_version_invalid");
  if (!SHA256.test(value.artifactDigest)) throw safeError("acp_current_artifact_digest_invalid");
  if (!SHA256.test(value.executionConfigDigest)) throw safeError("acp_execution_config_digest_invalid");
  if (value.trustState !== "trusted" && value.trustState !== "untrusted") {
    throw safeError("acp_current_artifact_trust_invalid");
  }
  if (!value.environment || typeof value.environment !== "object" || Array.isArray(value.environment)) {
    throw safeError("acp_current_artifact_environment_invalid");
  }
  const environment: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value.environment)) {
    if (!ENVIRONMENT_KEY.test(key) || typeof entry !== "string" || entry.includes("\0")) {
      throw safeError("acp_current_artifact_environment_invalid");
    }
    environment[key] = entry;
  }
  if (value.defaultWorkingDirectory !== undefined && !path.isAbsolute(value.defaultWorkingDirectory)) {
    throw safeError("acp_current_artifact_working_directory_invalid");
  }
  return Object.freeze({
    canonicalLauncherPath: value.canonicalLauncherPath,
    launchArguments: Object.freeze(launchArguments),
    observedArtifactVersion,
    ...(observedUpstreamVersion ? { observedUpstreamVersion } : {}),
    artifactDigest: value.artifactDigest.toLowerCase(),
    trustState: value.trustState,
    executionConfigDigest: value.executionConfigDigest.toLowerCase(),
    environment: Object.freeze(environment),
    ...(value.defaultWorkingDirectory
      ? { defaultWorkingDirectory: value.defaultWorkingDirectory }
      : {}),
  });
}

function artifactFingerprint(artifact: AcpDiscoveredArtifact): string {
  return `sha256:${createHash("sha256").update(stableJson({
    canonicalLauncherPath: artifact.canonicalLauncherPath,
    launchArguments: artifact.launchArguments,
    observedArtifactVersion: artifact.observedArtifactVersion,
    observedUpstreamVersion: artifact.observedUpstreamVersion ?? null,
    artifactDigest: artifact.artifactDigest.toLowerCase(),
    trustState: artifact.trustState,
    executionConfigDigest: artifact.executionConfigDigest.toLowerCase(),
    environment: artifact.environment,
    defaultWorkingDirectory: artifact.defaultWorkingDirectory ?? null,
  })).digest("hex")}`;
}

function portableProfileFingerprint(profile: AcpPortableProfileDefinitionV3): string {
  return `sha256:${createHash("sha256").update(stableJson(profile)).digest("hex")}`;
}

function snapshotPortableProfile<TProfile extends AcpPortableProfileDefinitionV3>(
  profile: TProfile,
): TProfile {
  return deepFreeze(structuredClone(profile));
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const entry of Object.values(value as Record<string, unknown>)) deepFreeze(entry);
  return Object.freeze(value);
}

function containsForbiddenPortableKey(value: unknown, seen = new Set<object>()): boolean {
  if (!value || typeof value !== "object") return false;
  if (seen.has(value as object)) return false;
  seen.add(value as object);
  if (Array.isArray(value)) return value.some((entry) => containsForbiddenPortableKey(entry, seen));
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_PORTABLE_KEYS.has(key) || containsForbiddenPortableKey(entry, seen)) return true;
  }
  return false;
}

function requiredText(value: unknown, code: string): string {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) throw safeError(code);
  return value;
}

function safeVersion(value: unknown, code: string): string {
  const text = requiredText(value, code);
  if (!SAFE_VERSION.test(text)) throw safeError(code);
  return text;
}

function requiredOpaqueId(value: unknown, code: string): string {
  const text = requiredText(value, code);
  if (text.length > 256 || /[\\/\s]/u.test(text)) throw safeError(code);
  return text;
}

function requiredIsoDate(value: unknown): string {
  const text = requiredText(value, "acp_resolution_observed_at_invalid");
  if (!Number.isFinite(Date.parse(text))) throw safeError("acp_resolution_observed_at_invalid");
  return text;
}

function safeError(code: string): AcpProfileResolutionError {
  return new AcpProfileResolutionError(code);
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

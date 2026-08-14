import {
  canonicalJson,
  validateAcpProfileReadinessObservation,
  isMetaProfileDefinitionV3,
  validateMetaProfileDefinitionV3,
  validateMetaProfileOptionDefinitionV3,
  type AcpProfileReadinessObservation,
  type JsonObject,
  type MetaProfileDefinition,
  type MetaProfileDefinitionV3,
  type MetaProfileOptionDefinitionV3,
  type MetaProfileOptionId,
  type MetaProfileSnapshot,
  type MetaSessionId,
  type ProviderKind,
} from "@agent-workspace/runtime-contracts";
import type { AcpMetaAgentPort, MetaAgentPort } from "@agent-workspace/provider-port";

export type { AcpMetaAgentPort, MetaAgentPort } from "@agent-workspace/provider-port";

export type AcpMetaAgentRegistration = Readonly<{
  option: MetaProfileOptionDefinitionV3;
  port: AcpMetaAgentPort;
}>;

export type AcpMetaSessionEnsureInput = Readonly<{
  metaSessionId: MetaSessionId;
  metaProfileOptionId: MetaProfileOptionId;
  profile: MetaProfileDefinitionV3;
  sessionMode: "template_design" | "task_setup";
  /** Recovery must open/load and reconcile without running a fresh behavior probe. */
  mode: "first_submit" | "recovery";
}>;

export interface AcpMetaAgentRegistry {
  readonly register: (registrations: readonly AcpMetaAgentRegistration[]) => void;
  readonly readiness: (
    metaProfileOptionId: MetaProfileOptionId,
    profile: MetaProfileDefinitionV3,
  ) => AcpProfileReadinessObservation;
  readonly probe: (
    metaProfileOptionId: MetaProfileOptionId,
    profile: MetaProfileDefinitionV3,
    options?: Readonly<{ force?: boolean }>,
  ) => Promise<AcpProfileReadinessObservation>;
  readonly ensureSession: (input: AcpMetaSessionEnsureInput) => Promise<AcpMetaAgentPort>;
}

type ExactAcpMetaRegistration = Readonly<{
  option: MetaProfileOptionDefinitionV3;
  port: AcpMetaAgentPort;
  identity: string;
}>;

/**
 * Runtime routing for ACP Meta. Registration and lookup are fenced by the
 * opaque option plus the complete frozen portable profile, never by brand.
 */
export function createAcpMetaAgentRegistry(
  registrations: readonly AcpMetaAgentRegistration[],
  options: MetaAgentRegistryOptions = {},
): AcpMetaAgentRegistry {
  const now = options.now ?? Date.now;
  const freshnessMs = options.freshnessMs ?? DEFAULT_META_READINESS_FRESHNESS_MS;
  const probeTimeoutMs = options.probeTimeoutMs ?? DEFAULT_META_READINESS_PROBE_TIMEOUT_MS;
  if (!Number.isFinite(freshnessMs) || freshnessMs < 0) {
    throw new Error("meta_agent_readiness_freshness_invalid");
  }
  if (!Number.isFinite(probeTimeoutMs) || probeTimeoutMs < 1) {
    throw new Error("meta_agent_readiness_probe_timeout_invalid");
  }
  const byOption = new Map<MetaProfileOptionId, ExactAcpMetaRegistration>();
  const readinessByIdentity = new Map<string, Readonly<{
    readiness: AcpProfileReadinessObservation;
    observedAtMs: number;
    verified: boolean;
  }>>();
  const probeByIdentity = new Map<string, Promise<AcpProfileReadinessObservation>>();
  const sessionBindings = new Map<MetaSessionId, {
    identity: string;
    sessionMode: "template_design" | "task_setup";
    port: Promise<AcpMetaAgentPort>;
    initializing: boolean;
  }>();

  const register = (nextRegistrations: readonly AcpMetaAgentRegistration[]): void => {
    if (!Array.isArray(nextRegistrations)) throw new Error("meta_agent_registration_invalid");
    for (const registration of nextRegistrations) {
      if (!registration || typeof registration !== "object" || !registration.port) {
        throw new Error("meta_agent_registration_invalid");
      }
      const option = validateMetaProfileOptionDefinitionV3(registration.option);
      const identity = acpMetaIdentity(option.metaProfileOptionId, option.profile);
      const existing = byOption.get(option.metaProfileOptionId);
      if (existing) {
        if (existing.identity !== identity || existing.port !== registration.port) {
          throw new Error("meta_profile_option_duplicate");
        }
        continue;
      }
      byOption.set(option.metaProfileOptionId, Object.freeze({
        option,
        port: registration.port,
        identity,
      }));
      readinessByIdentity.set(identity, {
        readiness: option.readiness,
        observedAtMs: now(),
        verified: false,
      });
    }
  };

  register(registrations);

  const requiredRegistration = (
    metaProfileOptionId: MetaProfileOptionId,
    profile: MetaProfileDefinitionV3,
  ): ExactAcpMetaRegistration => {
    const registration = byOption.get(metaProfileOptionId);
    if (!registration) throw new Error("meta_profile_option_not_found");
    const validated = validateMetaProfileDefinitionV3(profile);
    if (acpMetaIdentity(metaProfileOptionId, validated) !== registration.identity) {
      throw new Error("meta_profile_option_snapshot_mismatch");
    }
    return registration;
  };

  const readiness = (
    metaProfileOptionId: MetaProfileOptionId,
    profile: MetaProfileDefinitionV3,
  ): AcpProfileReadinessObservation => {
    const registration = requiredRegistration(metaProfileOptionId, profile);
    return readinessByIdentity.get(registration.identity)?.readiness
      ?? registration.option.readiness;
  };

  const probe = (
    metaProfileOptionId: MetaProfileOptionId,
    profile: MetaProfileDefinitionV3,
    probeOptions: Readonly<{ force?: boolean }> = {},
  ): Promise<AcpProfileReadinessObservation> => {
    const registration = requiredRegistration(metaProfileOptionId, profile);
    const inFlight = probeByIdentity.get(registration.identity);
    if (inFlight) return inFlight;
    const cached = readinessByIdentity.get(registration.identity);
    const elapsedMs = cached ? now() - cached.observedAtMs : undefined;
    if (cached?.verified && !probeOptions.force && elapsedMs !== undefined
      && elapsedMs >= 0 && elapsedMs < freshnessMs) {
      return Promise.resolve(cached.readiness);
    }
    const pending = boundedMetaProbe(
      () => registration.port.checkMetaProfileReadiness(metaProfileOptionId),
      probeTimeoutMs,
    ).then((value) => {
      const observed = validateAcpProfileReadinessObservation(value);
      assertAcpReadinessMatchesProfile(observed, registration.option.profile);
      readinessByIdentity.set(registration.identity, {
        readiness: observed,
        observedAtMs: now(),
        verified: true,
      });
      return observed;
    }).finally(() => {
      probeByIdentity.delete(registration.identity);
    });
    probeByIdentity.set(registration.identity, pending);
    return pending;
  };

  const ensureSession = async (input: AcpMetaSessionEnsureInput): Promise<AcpMetaAgentPort> => {
    if (typeof input.metaSessionId !== "string" || !input.metaSessionId.startsWith("meta_session_")) {
      throw new Error("meta_session_id_invalid");
    }
    if (input.mode !== "first_submit" && input.mode !== "recovery") {
      throw new Error("meta_session_ensure_mode_invalid");
    }
    if (input.sessionMode !== "template_design" && input.sessionMode !== "task_setup") {
      throw new Error("meta_session_mode_invalid");
    }
    const registration = requiredRegistration(input.metaProfileOptionId, input.profile);
    const existing = sessionBindings.get(input.metaSessionId);
    if (existing) {
      if (existing.identity !== registration.identity || existing.sessionMode !== input.sessionMode) {
        throw new Error("meta_session_profile_binding_conflict");
      }
      return await existing.port;
    }
    const pending = (async (): Promise<AcpMetaAgentPort> => {
      if (input.mode === "first_submit") {
        assertAcpMetaAvailable(await probe(input.metaProfileOptionId, input.profile));
      }
      const opened = await registration.port.openMetaSession({
        metaSessionId: input.metaSessionId,
        metaProfileOptionId: input.metaProfileOptionId,
        sessionMode: input.sessionMode,
        disposition: input.mode === "first_submit" ? "create" : "resume",
      });
      const observed = validateAcpProfileReadinessObservation(opened.readiness);
      assertAcpReadinessMatchesProfile(observed, registration.option.profile);
      readinessByIdentity.set(registration.identity, {
        readiness: observed,
        observedAtMs: now(),
        verified: true,
      });
      if (!opened.available || observed.status !== "available") {
        throw new Error(`meta_agent_profile_unavailable:${safeReadinessReason(observed)}`);
      }
      return registration.port;
    })();
    const binding = { identity: registration.identity, sessionMode: input.sessionMode, port: pending, initializing: true };
    sessionBindings.set(input.metaSessionId, binding);
    void pending.then(
      () => { binding.initializing = false; },
      () => {
        if (sessionBindings.get(input.metaSessionId) === binding) {
          sessionBindings.delete(input.metaSessionId);
        }
      },
    );
    return await pending;
  };

  return Object.freeze({ register, readiness, probe, ensureSession });
}

function acpMetaIdentity(
  metaProfileOptionId: MetaProfileOptionId,
  profile: MetaProfileDefinitionV3,
): string {
  const identity: JsonObject = {
    metaProfileOptionId,
    profile: acpMetaProfileIdentityValue(validateMetaProfileDefinitionV3(profile)),
  };
  return canonicalJson(identity);
}

/** Canonical frozen portable identity used by every Meta application seam. */
export function acpMetaProfileIdentity(profile: MetaProfileDefinitionV3): string {
  return canonicalJson(acpMetaProfileIdentityValue(validateMetaProfileDefinitionV3(profile)));
}

function acpMetaProfileIdentityValue(profile: MetaProfileDefinitionV3): JsonObject {
  return {
    metaProfileId: profile.metaProfileId,
    profileRevisionId: profile.profileRevisionId,
    providerFamily: profile.providerFamily,
    acpAgentKind: profile.acpAgentKind,
    protocolMajor: profile.protocolMajor,
    role: profile.role,
    model: profile.model,
    configIntent: profile.configIntent,
    requiredExtensions: [...profile.requiredExtensions],
    capabilityPolicy: {
      requiredCapabilities: [...profile.capabilityPolicy.requiredCapabilities],
      allowedTools: [...profile.capabilityPolicy.allowedTools],
      permissionMode: profile.capabilityPolicy.permissionMode,
      maxConcurrentTurns: profile.capabilityPolicy.maxConcurrentTurns,
      maxNativeChildren: profile.capabilityPolicy.maxNativeChildren,
    },
  };
}

function assertAcpReadinessMatchesProfile(
  readiness: AcpProfileReadinessObservation,
  profile: MetaProfileDefinitionV3,
): void {
  if (readiness.profileRevisionId !== profile.profileRevisionId
    || readiness.providerFamily !== profile.providerFamily
    || readiness.acpAgentKind !== profile.acpAgentKind
    || readiness.role !== "meta"
    || readiness.model !== profile.model) {
    throw new Error("meta_agent_readiness_profile_mismatch");
  }
}

function safeReadinessReason(readiness: AcpProfileReadinessObservation): string {
  return readiness.reasons[0] ?? (readiness.status === "capability_missing"
    ? "capability_missing"
    : readiness.status);
}

function assertAcpMetaAvailable(readiness: AcpProfileReadinessObservation): void {
  if (readiness.status !== "available") {
    throw new Error(`meta_agent_profile_unavailable:${safeReadinessReason(readiness)}`);
  }
}

type MetaAgentProtocolObservation = Readonly<{
  observedProviderVersion?: string;
  observedProtocolFingerprint?: string;
}>;

export type MetaAgentProfileReadiness =
  | (Readonly<{ state: "pending" }> & MetaAgentProtocolObservation)
  | (Readonly<{ state: "available" }> & MetaAgentProtocolObservation)
  | (Readonly<{ state: "unavailable"; reason: string }> & MetaAgentProtocolObservation);

/** @deprecated Direct-v2 readiness cache retained only until Host cutover. */
export interface MetaAgentRegistry {
  readonly get: (provider: ProviderKind) => MetaAgentPort | undefined;
  /** Synchronous, Renderer-safe view of the latest Host-owned probe. */
  readonly readiness: (profile: MetaProfileDefinition) => MetaAgentProfileReadiness;
  /** At most one native capability probe runs for a frozen functional profile. */
  readonly probe: (
    profile: MetaProfileDefinition,
    options?: Readonly<{ force?: boolean }>,
  ) => Promise<MetaAgentProfileReadiness>;
}

export type MetaAgentRegistryOptions = Readonly<{
  readonly now?: () => number;
  readonly freshnessMs?: number;
  readonly probeTimeoutMs?: number;
}>;

const DEFAULT_META_READINESS_FRESHNESS_MS = 60_000;
const DEFAULT_META_READINESS_PROBE_TIMEOUT_MS = 15_000;
const SAFE_META_UNAVAILABLE_REASONS = new Set([
  "codex_meta_adapter_closed",
  "codex_meta_builtin_tools_not_structurally_disableable",
]);

/** @deprecated Direct-v2 Host migration surface; ACP owners cannot consume it. */
export function createMetaAgentRegistry(
  ports: readonly MetaAgentPort[],
  options: MetaAgentRegistryOptions = {},
): MetaAgentRegistry {
  const byProvider = new Map<ProviderKind, MetaAgentPort>();
  const readinessByProfile = new Map<string, Readonly<{
    readonly readiness: MetaAgentProfileReadiness;
    readonly observedAtMs: number;
  }>>();
  const probeByProfile = new Map<string, Promise<MetaAgentProfileReadiness>>();
  const now = options.now ?? Date.now;
  const freshnessMs = options.freshnessMs ?? DEFAULT_META_READINESS_FRESHNESS_MS;
  const probeTimeoutMs = options.probeTimeoutMs ?? DEFAULT_META_READINESS_PROBE_TIMEOUT_MS;
  if (!Number.isFinite(freshnessMs) || freshnessMs < 0) throw new Error("meta_agent_readiness_freshness_invalid");
  if (!Number.isFinite(probeTimeoutMs) || probeTimeoutMs < 1) throw new Error("meta_agent_readiness_probe_timeout_invalid");
  for (const port of ports) {
    if (byProvider.has(port.provider)) throw new Error("meta_agent_provider_duplicate");
    byProvider.set(port.provider, port);
  }

  const readiness = (profile: MetaProfileDefinition): MetaAgentProfileReadiness => {
    if (!byProvider.has(profile.provider)) {
      return Object.freeze({ state: "unavailable", reason: "meta_agent_provider_not_composed" });
    }
    return readinessByProfile.get(profileKey(profile))?.readiness ?? Object.freeze({ state: "pending" });
  };

  const probe = (
    profile: MetaProfileDefinition,
    probeOptions: Readonly<{ force?: boolean }> = {},
  ): Promise<MetaAgentProfileReadiness> => {
    const key = profileKey(profile);
    const existing = probeByProfile.get(key);
    if (existing) return existing;
    const cached = readinessByProfile.get(key);
    const elapsedMs = cached ? now() - cached.observedAtMs : undefined;
    if (cached && !probeOptions.force && elapsedMs !== undefined && elapsedMs >= 0 && elapsedMs < freshnessMs) {
      return Promise.resolve(cached.readiness);
    }
    const port = byProvider.get(profile.provider);
    if (!port) {
      const unavailable = Object.freeze({
        state: "unavailable" as const,
        reason: "meta_agent_provider_not_composed",
      });
      readinessByProfile.set(key, { readiness: unavailable, observedAtMs: now() });
      return Promise.resolve(unavailable);
    }
    const pending = boundedMetaProbe(() => port.describeMetaCapabilities(profile), probeTimeoutMs)
      .then((report): MetaAgentProfileReadiness => {
        const observation = metaProtocolObservation(report);
        const providerMismatch = report.provider !== profile.provider;
        if (providerMismatch) {
          return metaUnavailable("meta_profile_provider_mismatch", observation);
        }
        if (report.available
          && (!observation.observedProviderVersion || !observation.observedProtocolFingerprint)) {
          return metaUnavailable("meta_agent_capability_observation_missing", observation);
        }
        if (report.available) return Object.freeze({ state: "available", ...observation });
        const reason = safeUnavailableReason(report.unavailableReasons) ?? "meta_agent_capability_unavailable";
        return metaUnavailable(reason, observation);
      })
      .catch((): MetaAgentProfileReadiness => Object.freeze({
        state: "unavailable",
        reason: "meta_agent_capability_probe_failed",
      }))
      .then((result) => {
        readinessByProfile.set(key, { readiness: result, observedAtMs: now() });
        probeByProfile.delete(key);
        return result;
      });
    probeByProfile.set(key, pending);
    return pending;
  };

  return Object.freeze({
    get: (provider: ProviderKind) => byProvider.get(provider),
    readiness,
    probe,
  });
}

export async function assertMetaAgentProfileAvailable(
  registry: MetaAgentRegistry,
  profile: MetaProfileSnapshot,
): Promise<MetaAgentPort> {
  if (isMetaProfileDefinitionV3(profile)) throw new Error("meta_agent_acp_registry_required");
  const port = registry.get(profile.provider);
  if (!port) throw new Error(`meta_agent_unavailable:${profile.provider}`);
  const readiness = await registry.probe(profile, { force: true });
  if (readiness.state !== "available") {
    const reason = readiness.state === "unavailable" ? readiness.reason : "meta_agent_profile_probe_pending";
    throw new Error(`meta_agent_profile_unavailable:${profile.metaProfileId}:${reason}`);
  }
  return port;
}

function profileKey(profile: MetaProfileDefinition): string {
  // providerVersion/protocolFingerprint are retained on legacy Profiles for
  // display/migration only. Runtime readiness is based on the Host-observed
  // process baseline, so those fields neither gate nor fragment its cache.
  const identity: JsonObject = {
    metaProfileId: profile.metaProfileId,
    provider: profile.provider,
    model: profile.model,
    capabilityPolicy: {
      requiredCapabilities: [...profile.capabilityPolicy.requiredCapabilities],
      allowedTools: [...profile.capabilityPolicy.allowedTools],
      permissionMode: profile.capabilityPolicy.permissionMode,
      maxConcurrentTurns: profile.capabilityPolicy.maxConcurrentTurns,
      maxNativeChildren: profile.capabilityPolicy.maxNativeChildren,
    },
  };
  return canonicalJson(identity);
}

function boundedMetaProbe<T>(probe: () => Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("meta_agent_probe_timeout")), timeoutMs);
    timeout.unref();
    Promise.resolve()
      .then(probe)
      .then(
        (result) => {
          clearTimeout(timeout);
          resolve(result);
        },
        (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      );
  });
}

function safeUnavailableReason(reasons: readonly string[]): string | undefined {
  return reasons.find((reason) => SAFE_META_UNAVAILABLE_REASONS.has(reason));
}

function metaProtocolObservation(report: Readonly<{
  providerVersion?: string;
  protocolFingerprint?: string;
}>): MetaAgentProtocolObservation {
  const providerVersion = nonEmptyString(report.providerVersion);
  const protocolFingerprint = nonEmptyString(report.protocolFingerprint);
  return Object.freeze({
    ...(providerVersion ? { observedProviderVersion: providerVersion } : {}),
    ...(protocolFingerprint ? { observedProtocolFingerprint: protocolFingerprint } : {}),
  });
}

function metaUnavailable(
  reason: string,
  observation: MetaAgentProtocolObservation = {},
): MetaAgentProfileReadiness {
  return Object.freeze({ state: "unavailable", reason, ...observation });
}

function nonEmptyString(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

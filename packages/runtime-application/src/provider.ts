import {
  canonicalJson,
  type ExecutionProfileReadinessReason,
  type ExecutionProfileDefinition,
  type JsonValue,
  type ProviderCapability,
  type ProviderKind,
} from "@agent-workspace/runtime-contracts";
import type { ProviderPort as ProviderPortContract } from "@agent-workspace/provider-port";

/** Runtime application depends only on the stable ProviderPort contract. */
export type ProviderPort = ProviderPortContract;

export type ProviderProfileReadiness = Readonly<{
  state: "checking" | "available" | "unavailable" | "version_mismatch" | "capability_missing";
  unavailableReasons: readonly ExecutionProfileReadinessReason[];
  missingCapabilities: readonly ProviderCapability[];
  observedProviderVersion?: string;
  observedProtocolFingerprint?: string;
}>;

export interface ProviderRegistry {
  get(provider: ProviderKind): ProviderPort | undefined;
  readiness(profile: ExecutionProfileDefinition): ProviderProfileReadiness;
  probe(profile: ExecutionProfileDefinition, options?: Readonly<{ force?: boolean }>): Promise<ProviderProfileReadiness>;
}

export type ProviderRegistryOptions = Readonly<{
  readonly now?: () => number;
  readonly freshnessMs?: number;
  readonly probeTimeoutMs?: number;
}>;

const DEFAULT_READINESS_FRESHNESS_MS = 60_000;
const DEFAULT_READINESS_PROBE_TIMEOUT_MS = 15_000;

export function createProviderRegistry(
  ports: readonly ProviderPort[],
  options: ProviderRegistryOptions = {},
): ProviderRegistry {
  const byProvider = new Map<ProviderKind, ProviderPort>();
  const readinessByProfile = new Map<string, Readonly<{
    readonly readiness: ProviderProfileReadiness;
    readonly observedAtMs: number;
  }>>();
  const probeByProfile = new Map<string, Promise<ProviderProfileReadiness>>();
  const now = options.now ?? Date.now;
  const freshnessMs = options.freshnessMs ?? DEFAULT_READINESS_FRESHNESS_MS;
  const probeTimeoutMs = options.probeTimeoutMs ?? DEFAULT_READINESS_PROBE_TIMEOUT_MS;
  if (!Number.isFinite(freshnessMs) || freshnessMs < 0) throw new Error("provider_readiness_freshness_invalid");
  if (!Number.isFinite(probeTimeoutMs) || probeTimeoutMs < 1) throw new Error("provider_readiness_probe_timeout_invalid");
  for (const port of ports) {
    if (byProvider.has(port.provider)) throw new Error("provider_duplicate");
    byProvider.set(port.provider, port);
  }
  const readiness = (profile: ExecutionProfileDefinition): ProviderProfileReadiness => {
    if (!byProvider.has(profile.provider)) return unavailable("unavailable", ["provider_not_composed"]);
    return readinessByProfile.get(executionProfileFingerprint(profile))?.readiness
      ?? unavailable("checking", ["provider_probe_pending"]);
  };
  const probe = (
    profile: ExecutionProfileDefinition,
    options: Readonly<{ force?: boolean }> = {},
  ): Promise<ProviderProfileReadiness> => {
    const key = executionProfileFingerprint(profile);
    const existing = probeByProfile.get(key);
    if (existing) return existing;
    const cached = readinessByProfile.get(key);
    const elapsedMs = cached ? now() - cached.observedAtMs : undefined;
    if (cached && !options.force && elapsedMs !== undefined && elapsedMs >= 0 && elapsedMs < freshnessMs) {
      return Promise.resolve(cached.readiness);
    }
    const port = byProvider.get(profile.provider);
    if (!port) {
      const result = unavailable("unavailable", ["provider_not_composed"]);
      readinessByProfile.set(key, { readiness: result, observedAtMs: now() });
      return Promise.resolve(result);
    }
    const pending = boundedProbe(() => port.describeCapabilities(profile), probeTimeoutMs)
      .then((report): ProviderProfileReadiness => {
        const observation = providerProtocolObservation(report);
        const missing = profile.capabilityPolicy.requiredCapabilities.filter((capability) => !report.capabilities.includes(capability));
        if (report.provider !== profile.provider) {
          return unavailable("unavailable", ["provider_mismatch"], [], observation);
        }
        if (!observation.observedProviderVersion || !observation.observedProtocolFingerprint) {
          return unavailable("unavailable", ["provider_unavailable"], [], observation);
        }
        if (missing.length > 0) {
          return unavailable(
            "capability_missing",
            missing.map((capability) => `capability_${capability}_unavailable` as const),
            missing,
            observation,
          );
        }
        if (!report.available) {
          return unavailable("unavailable", ["provider_unavailable"], [], observation);
        }
        return unavailable("available", [], [], observation);
      })
      .catch(() => unavailable("unavailable", ["provider_probe_failed"]))
      .then((result) => {
        readinessByProfile.set(key, { readiness: result, observedAtMs: now() });
        probeByProfile.delete(key);
        return result;
      });
    probeByProfile.set(key, pending);
    return pending;
  };
  return Object.freeze({ get: (provider: ProviderKind) => byProvider.get(provider), readiness, probe });
}

function boundedProbe<T>(probe: () => Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("provider_probe_timeout")), timeoutMs);
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

export async function assertProviderProfileAvailable(
  registry: ProviderRegistry,
  profile: ExecutionProfileDefinition,
): Promise<ProviderPort> {
  const port = registry.get(profile.provider);
  if (!port) throw new Error(`provider_unavailable:${profile.provider}`);
  const readiness = await registry.probe(profile, { force: true });
  if (readiness.state !== "available") {
    throw new Error(`execution_profile_unavailable:${profile.executionProfileId}:${readiness.unavailableReasons.join(",") || "unknown"}`);
  }
  return port;
}

export function executionProfileFingerprint(profile: ExecutionProfileDefinition): string {
  return canonicalJson(profile as unknown as JsonValue);
}

function unavailable(
  state: ProviderProfileReadiness["state"],
  reasons: readonly ExecutionProfileReadinessReason[],
  missingCapabilities: readonly ProviderCapability[] = [],
  observation: Readonly<{
    observedProviderVersion?: string;
    observedProtocolFingerprint?: string;
  }> = {},
): ProviderProfileReadiness {
  return Object.freeze({
    state,
    unavailableReasons: Object.freeze([...reasons]),
    missingCapabilities: Object.freeze([...missingCapabilities]),
    ...observation,
  });
}

function providerProtocolObservation(report: Readonly<{
  providerVersion?: string;
  protocolFingerprint?: string;
}>): Readonly<{
  observedProviderVersion?: string;
  observedProtocolFingerprint?: string;
}> {
  const providerVersion = nonEmptyString(report.providerVersion);
  const protocolFingerprint = nonEmptyString(report.protocolFingerprint);
  return Object.freeze({
    ...(providerVersion ? { observedProviderVersion: providerVersion } : {}),
    ...(protocolFingerprint ? { observedProtocolFingerprint: protocolFingerprint } : {}),
  });
}

function nonEmptyString(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

import {
  canonicalJson,
  type JsonValue,
  type MetaProfileDefinition,
  type ProviderKind,
} from "@agent-workspace/runtime-contracts";
import type { MetaAgentPort } from "@agent-workspace/provider-port";

export type { MetaAgentPort } from "@agent-workspace/provider-port";

export type MetaAgentProfileReadiness =
  | Readonly<{ state: "pending" }>
  | Readonly<{ state: "available" }>
  | Readonly<{ state: "unavailable"; reason: string }>;

export interface MetaAgentRegistry {
  readonly get: (provider: ProviderKind) => MetaAgentPort | undefined;
  /** Synchronous, Renderer-safe view of the latest Host-owned probe. */
  readonly readiness: (profile: MetaProfileDefinition) => MetaAgentProfileReadiness;
  /** At most one native capability probe runs for a frozen profile pin. */
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
const SAFE_META_UNAVAILABLE_REASONS = new Set(["codex_meta_adapter_closed"]);

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
        const pinMismatch = report.provider !== profile.provider
          || report.providerVersion !== profile.providerVersion
          || report.protocolFingerprint !== profile.protocolFingerprint;
        if (report.available && !pinMismatch) return Object.freeze({ state: "available" });
        const reason = pinMismatch
          ? "meta_profile_protocol_mismatch"
          : safeUnavailableReason(report.unavailableReasons) ?? "meta_agent_capability_unavailable";
        return Object.freeze({ state: "unavailable", reason });
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
  profile: MetaProfileDefinition,
): Promise<MetaAgentPort> {
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
  return canonicalJson(profile as unknown as JsonValue);
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

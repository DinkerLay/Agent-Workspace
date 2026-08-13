import type {
  ExecutionProfileDefinition,
  ProviderCapabilities,
  ProviderEffect,
  ProviderFact,
} from "@agent-workspace/runtime-contracts";
import type { ProviderPort } from "@agent-workspace/provider-port";
import { describe, expect, it } from "vitest";
import {
  assertProviderProfileAvailable,
  createProviderRegistry,
} from "./provider.js";

describe("Provider profile readiness registry", () => {
  it("deduplicates a checking probe and publishes only normalized readiness", async () => {
    const provider = new ReadinessProvider();
    const registry = createProviderRegistry([provider]);

    expect(registry.readiness(profile)).toMatchObject({
      state: "checking",
      unavailableReasons: ["provider_probe_pending"],
    });
    await Promise.all([registry.probe(profile), registry.probe(profile)]);

    expect(provider.probes).toBe(1);
    expect(registry.readiness(profile)).toEqual({
      state: "available",
      unavailableReasons: [],
      missingCapabilities: [],
      observedProviderVersion: profile.providerVersion,
      observedProtocolFingerprint: profile.protocolFingerprint,
    });
  });

  it("keeps a profile available across version changes and projects only observed protocol evidence", async () => {
    const provider = new ReadinessProvider();
    provider.report = {
      ...matchingReport(),
      available: true,
      providerVersion: "1.18.15",
      protocolFingerprint: "sha256:runtime-discovered-1.18.15",
      unavailableReasons: ["token=must-not-cross-the-host"],
    };
    const registry = createProviderRegistry([provider]);

    await registry.probe(profile);

    expect(registry.readiness(profile)).toEqual({
      state: "available",
      unavailableReasons: [],
      missingCapabilities: [],
      observedProviderVersion: "1.18.15",
      observedProtocolFingerprint: "sha256:runtime-discovered-1.18.15",
    });
    expect(JSON.stringify(registry.readiness(profile))).not.toContain("must-not-cross-the-host");
  });

  it("fails closed on provider identity mismatch or incomplete observed protocol evidence", async () => {
    const provider = new ReadinessProvider();
    const registry = createProviderRegistry([provider]);

    provider.report = { ...matchingReport(), provider: "codex" };
    await expect(registry.probe(profile, { force: true })).resolves.toEqual({
      state: "unavailable",
      unavailableReasons: ["provider_mismatch"],
      missingCapabilities: [],
      observedProviderVersion: profile.providerVersion,
      observedProtocolFingerprint: profile.protocolFingerprint,
    });

    provider.report = { ...matchingReport(), protocolFingerprint: undefined };
    await expect(registry.probe(profile, { force: true })).resolves.toEqual({
      state: "unavailable",
      unavailableReasons: ["provider_unavailable"],
      missingCapabilities: [],
      observedProviderVersion: profile.providerVersion,
    });
  });

  it("forces the owner command gate to revalidate a previously available profile", async () => {
    const provider = new ReadinessProvider();
    const registry = createProviderRegistry([provider]);
    await registry.probe(profile);
    provider.report = { ...matchingReport(), available: false, unavailableReasons: ["native detail"] };

    await expect(assertProviderProfileAvailable(registry, profile)).rejects.toThrow("provider_unavailable");
    expect(provider.probes).toBe(2);
    expect(registry.readiness(profile)).toMatchObject({ state: "unavailable" });
  });

  it("recovers a transient synchronous probe failure without exposing native diagnostics", async () => {
    const provider = new ReadinessProvider();
    provider.syncFailure = new Error("token:supersecret");
    const registry = createProviderRegistry([provider]);

    await expect(registry.probe(profile, { force: true })).resolves.toEqual({
      state: "unavailable",
      unavailableReasons: ["provider_probe_failed"],
      missingCapabilities: [],
    });
    expect(JSON.stringify(registry.readiness(profile))).not.toContain("supersecret");

    provider.syncFailure = undefined;
    await expect(registry.probe(profile, { force: true })).resolves.toMatchObject({ state: "available" });
    expect(provider.probes).toBe(2);
  });

  it("keeps a cached result only for a bounded freshness window and then observes change", async () => {
    let nowMs = 10_000;
    const provider = new ReadinessProvider();
    const registry = createProviderRegistry([provider], { now: () => nowMs, freshnessMs: 100 });
    await registry.probe(profile);
    provider.report = { ...matchingReport(), available: false, unavailableReasons: ["native changed"] };

    nowMs += 99;
    await expect(registry.probe(profile)).resolves.toMatchObject({ state: "available" });
    expect(provider.probes).toBe(1);

    nowMs += 1;
    await expect(registry.probe(profile)).resolves.toMatchObject({
      state: "unavailable",
      unavailableReasons: ["provider_unavailable"],
    });
    expect(provider.probes).toBe(2);
  });

  it("keys readiness by the complete canonical frozen profile", async () => {
    const provider = new ReadinessProvider();
    const registry = createProviderRegistry([provider]);
    const changedModel = { ...profile, model: `${profile.model}-changed` };

    await registry.probe(profile);
    provider.report = { ...matchingReport(), available: false, unavailableReasons: ["model unavailable"] };
    await registry.probe(changedModel);

    expect(registry.readiness(profile)).toMatchObject({ state: "available" });
    expect(registry.readiness(changedModel)).toMatchObject({ state: "unavailable" });
    expect(provider.probes).toBe(2);
  });
});

const profile: ExecutionProfileDefinition = {
  executionProfileId: "profile_opencode",
  provider: "opencode",
  model: "opencode/deepseek-v4-flash-free",
  providerVersion: "1.18.13",
  protocolFingerprint: "sha256:opencode-1.18.13",
  capabilityPolicy: {
    requiredCapabilities: ["create_binding", "reconcile", "interrupt"],
    allowedTools: [],
    permissionMode: "ask",
    maxConcurrentTurns: 1,
    maxNativeChildren: 0,
  },
};

function matchingReport(): ProviderCapabilities {
  return {
    provider: "opencode",
    available: true,
    providerVersion: profile.providerVersion,
    protocolFingerprint: profile.protocolFingerprint,
    capabilities: [...profile.capabilityPolicy.requiredCapabilities],
    unavailableReasons: [],
  };
}

class ReadinessProvider implements ProviderPort {
  readonly provider = "opencode" as const;
  probes = 0;
  report: ProviderCapabilities = matchingReport();
  syncFailure: Error | undefined;

  describeCapabilities(): Promise<ProviderCapabilities> {
    this.probes += 1;
    if (this.syncFailure) throw this.syncFailure;
    return Promise.resolve({
      ...this.report,
      capabilities: [...this.report.capabilities],
      unavailableReasons: [...this.report.unavailableReasons],
    });
  }

  async ensureBinding(_request: Parameters<ProviderPort["ensureBinding"]>[0]): Promise<ProviderEffect> {
    throw new Error("not_used");
  }

  async submitDelivery(_request: Parameters<ProviderPort["submitDelivery"]>[0]): Promise<ProviderEffect> {
    throw new Error("not_used");
  }

  async *observeBinding(_request: Parameters<ProviderPort["observeBinding"]>[0]): AsyncIterable<ProviderFact> {}

  async reconcileBinding(_request: Parameters<ProviderPort["reconcileBinding"]>[0]): Promise<readonly ProviderFact[]> {
    return [];
  }

  async requestInterrupt(_request: Parameters<ProviderPort["requestInterrupt"]>[0]): Promise<ProviderEffect> {
    throw new Error("not_used");
  }

  async releaseBinding(_request: Parameters<ProviderPort["releaseBinding"]>[0]): Promise<void> {}
}

import type {
  MetaProfileDefinition,
  ProviderKind,
} from "@agent-workspace/runtime-contracts";
import type {
  MetaAgentCapabilityReport,
  MetaAgentPort,
  MetaAgentTurnRequest,
} from "@agent-workspace/provider-port";
import { describe, expect, it } from "vitest";
import {
  assertMetaAgentProfileAvailable,
  createMetaAgentRegistry,
} from "./meta-agent.js";

describe("Meta Agent readiness registry", () => {
  it("catches synchronous probes, publishes one typed reason, and can recover on force", async () => {
    const port = new ReadinessMetaAgent();
    port.syncFailure = new Error("token:supersecret");
    const registry = createMetaAgentRegistry([port]);

    await expect(registry.probe(profile, { force: true })).resolves.toEqual({
      state: "unavailable",
      reason: "meta_agent_capability_probe_failed",
    });
    expect(JSON.stringify(registry.readiness(profile))).not.toContain("supersecret");

    port.syncFailure = undefined;
    await expect(registry.probe(profile, { force: true })).resolves.toEqual({ state: "available" });
    expect(port.probes).toBe(2);
  });

  it("never forwards a native unavailable reason into the Renderer-safe cache", async () => {
    const port = new ReadinessMetaAgent();
    port.report = {
      ...matchingMetaReport(),
      available: false,
      unavailableReasons: ["token:supersecret"],
    };
    const registry = createMetaAgentRegistry([port]);

    await registry.probe(profile);

    expect(registry.readiness(profile)).toEqual({
      state: "unavailable",
      reason: "meta_agent_capability_unavailable",
    });
    expect(JSON.stringify(registry.readiness(profile))).not.toContain("supersecret");
  });

  it("bounds a hung probe and permits a later forced recovery", async () => {
    const port = new ReadinessMetaAgent();
    port.hang = true;
    const registry = createMetaAgentRegistry([port], { probeTimeoutMs: 10 });

    await expect(registry.probe(profile, { force: true })).resolves.toEqual({
      state: "unavailable",
      reason: "meta_agent_capability_probe_failed",
    });
    port.hang = false;
    await expect(registry.probe(profile, { force: true })).resolves.toEqual({ state: "available" });
    expect(port.probes).toBe(2);
  });

  it("keeps cache freshness bounded, revalidates owner gates, and isolates complete profiles", async () => {
    let nowMs = 2_000;
    const port = new ReadinessMetaAgent();
    const registry = createMetaAgentRegistry([port], { now: () => nowMs, freshnessMs: 100 });
    await registry.probe(profile);
    port.report = { ...matchingMetaReport(), available: false, unavailableReasons: ["changed"] };

    nowMs += 99;
    await expect(registry.probe(profile)).resolves.toEqual({ state: "available" });
    nowMs += 1;
    await expect(registry.probe(profile)).resolves.toEqual({
      state: "unavailable",
      reason: "meta_agent_capability_unavailable",
    });

    port.report = matchingMetaReport();
    await expect(assertMetaAgentProfileAvailable(registry, profile)).resolves.toBe(port);
    const changedModel = { ...profile, model: `${profile.model}-changed` };
    port.report = { ...matchingMetaReport(), available: false, unavailableReasons: [] };
    await registry.probe(changedModel, { force: true });
    expect(registry.readiness(profile)).toEqual({ state: "available" });
    expect(registry.readiness(changedModel)).toEqual({
      state: "unavailable",
      reason: "meta_agent_capability_unavailable",
    });
  });
});

const profile: MetaProfileDefinition = {
  metaProfileId: "meta_profile_readiness",
  provider: "codex",
  model: "gpt-5.6",
  providerVersion: "0.146.0",
  protocolFingerprint: "sha256:meta-readiness",
  capabilityPolicy: {
    requiredCapabilities: [],
    allowedTools: [],
    permissionMode: "deny",
    maxConcurrentTurns: 1,
    maxNativeChildren: 0,
  },
};

function matchingMetaReport(): MetaAgentCapabilityReport {
  return {
    provider: "codex",
    available: true,
    providerVersion: profile.providerVersion,
    protocolFingerprint: profile.protocolFingerprint,
    unavailableReasons: [],
  };
}

class ReadinessMetaAgent implements MetaAgentPort {
  readonly provider: ProviderKind = "codex";
  probes = 0;
  syncFailure: Error | undefined;
  hang = false;
  report = matchingMetaReport();

  describeMetaCapabilities(): Promise<MetaAgentCapabilityReport> {
    this.probes += 1;
    if (this.syncFailure) throw this.syncFailure;
    if (this.hang) return new Promise(() => undefined);
    return Promise.resolve({ ...this.report, unavailableReasons: [...this.report.unavailableReasons] });
  }

  async startMetaTurn(_request: MetaAgentTurnRequest) {
    return "accepted" as const;
  }

  async reconcileMetaTurn(_request: MetaAgentTurnRequest) {
    return { state: "absent" as const };
  }
}

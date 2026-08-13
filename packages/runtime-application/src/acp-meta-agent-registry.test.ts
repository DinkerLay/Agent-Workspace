import type {
  AcpMetaAgentPort,
  AcpMetaAgentTurnRequest,
  MetaAgentTurnReconciliation,
} from "@agent-workspace/provider-port";
import {
  type AcpProfileReadinessObservation,
  type MetaProfileDefinitionV3,
  type MetaProfileOptionDefinitionV3,
} from "@agent-workspace/runtime-contracts";
import { describe, expect, it } from "vitest";
import {
  createAcpMetaAgentRegistry,
} from "./meta-agent.js";

describe("exact ACP Meta registry", () => {
  it("routes by option plus the complete frozen v3 profile, never Provider brand", async () => {
    const first = new ControlledAcpMetaPort(option("one", "profile_revision_meta-one", "medium"));
    const second = new ControlledAcpMetaPort(option("two", "profile_revision_meta-two", "high"));
    const registry = createAcpMetaAgentRegistry([
      { option: first.option, port: first },
      { option: second.option, port: second },
    ]);

    await registry.ensureSession({
      metaSessionId: "meta_session_exact-one",
      metaProfileOptionId: first.option.metaProfileOptionId,
      profile: first.option.profile,
      mode: "first_submit",
    });
    await registry.ensureSession({
      metaSessionId: "meta_session_exact-two",
      metaProfileOptionId: second.option.metaProfileOptionId,
      profile: second.option.profile,
      mode: "first_submit",
    });
    expect(first.probes).toBe(1);
    expect(first.opens).toBe(1);
    expect(first.dispositions).toEqual(["create"]);
    expect(second.probes).toBe(1);
    expect(second.opens).toBe(1);
    expect(second.dispositions).toEqual(["create"]);

    await expect(registry.ensureSession({
      metaSessionId: "meta_session_cross-option",
      metaProfileOptionId: first.option.metaProfileOptionId,
      profile: second.option.profile,
      mode: "first_submit",
    })).rejects.toThrow("meta_profile_option_snapshot_mismatch");
    await expect(registry.ensureSession({
      metaSessionId: "meta_session_exact-one",
      metaProfileOptionId: second.option.metaProfileOptionId,
      profile: second.option.profile,
      mode: "recovery",
    })).rejects.toThrow("meta_session_profile_binding_conflict");
    expect(first.opens).toBe(1);
    expect(second.opens).toBe(1);
  });

  it("single-flights one MetaSession, forces a fresh first-send probe, and skips probing on recovery", async () => {
    const port = new ControlledAcpMetaPort(option("single", "profile_revision_meta-single", "medium"));
    const registry = createAcpMetaAgentRegistry([{ option: port.option, port }]);
    const input = {
      metaSessionId: "meta_session_single-flight",
      metaProfileOptionId: port.option.metaProfileOptionId,
      profile: port.option.profile,
      mode: "first_submit" as const,
    };
    const [left, right] = await Promise.all([
      registry.ensureSession(input),
      registry.ensureSession(input),
    ]);
    expect(left).toBe(port);
    expect(right).toBe(port);
    expect(port.probes).toBe(1);
    expect(port.opens).toBe(1);

    await registry.ensureSession(input);
    expect(port.probes).toBe(2);
    expect(port.opens).toBe(1);

    const recoveredPort = new ControlledAcpMetaPort(port.option);
    const recoveredRegistry = createAcpMetaAgentRegistry([{ option: recoveredPort.option, port: recoveredPort }]);
    await recoveredRegistry.ensureSession({ ...input, mode: "recovery" });
    expect(recoveredPort.probes).toBe(0);
    expect(recoveredPort.opens).toBe(1);
    expect(recoveredPort.dispositions).toEqual(["resume"]);
  });

  it("registers newly enabled Chat profiles without retargeting an existing MetaSession", async () => {
    const original = new ControlledAcpMetaPort(option("original", "profile_revision_meta-original", "medium"));
    const added = new ControlledAcpMetaPort(option("added", "profile_revision_meta-added", "high"));
    const registry = createAcpMetaAgentRegistry([{ option: original.option, port: original }]);

    await registry.ensureSession({
      metaSessionId: "meta_session_existing",
      metaProfileOptionId: original.option.metaProfileOptionId,
      profile: original.option.profile,
      mode: "first_submit",
    });
    registry.register([{ option: added.option, port: added }]);
    registry.register([{ option: added.option, port: added }]);

    await registry.ensureSession({
      metaSessionId: "meta_session_new",
      metaProfileOptionId: added.option.metaProfileOptionId,
      profile: added.option.profile,
      mode: "first_submit",
    });
    expect(added.opens).toBe(1);
    await expect(registry.ensureSession({
      metaSessionId: "meta_session_existing",
      metaProfileOptionId: added.option.metaProfileOptionId,
      profile: added.option.profile,
      mode: "recovery",
    })).rejects.toThrow("meta_session_profile_binding_conflict");

    const conflicting = new ControlledAcpMetaPort(added.option);
    expect(() => registry.register([{ option: added.option, port: conflicting }]))
      .toThrow("meta_profile_option_duplicate");
  });
});

class ControlledAcpMetaPort implements AcpMetaAgentPort {
  probes = 0;
  opens = 0;
  readonly dispositions: string[] = [];

  constructor(readonly option: MetaProfileOptionDefinitionV3) {}

  async checkMetaProfileReadiness(): Promise<AcpProfileReadinessObservation> {
    this.probes += 1;
    return this.option.readiness;
  }

  async openMetaSession(input: Readonly<{ disposition: "create" | "resume" }>) {
    this.opens += 1;
    this.dispositions.push(input.disposition);
    return { available: true as const, readiness: this.option.readiness };
  }

  async startMetaTurn(_request: AcpMetaAgentTurnRequest) {
    return "accepted" as const;
  }

  async reconcileMetaTurn(_request: AcpMetaAgentTurnRequest): Promise<MetaAgentTurnReconciliation> {
    return { state: "absent" };
  }
}

function option(
  suffix: string,
  profileRevisionId: string,
  reasoningEffort: string,
): MetaProfileOptionDefinitionV3 {
  const profile: MetaProfileDefinitionV3 = {
    metaProfileId: `meta_profile_${suffix}`,
    profileRevisionId,
    providerFamily: "codex",
    acpAgentKind: "codex_acp",
    protocolMajor: 1,
    role: "meta",
    model: "gpt-5.6-terra",
    configIntent: { reasoningEffort },
    requiredExtensions: [],
    capabilityPolicy: {
      requiredCapabilities: [],
      allowedTools: [],
      permissionMode: "deny",
      maxConcurrentTurns: 1,
      maxNativeChildren: 0,
    },
  };
  return {
    metaProfileOptionId: `meta_profile_option_${suffix}`,
    title: `Meta ${suffix}`,
    profile,
    readiness: {
      profileRevisionId,
      providerFamily: "codex",
      acpAgentKind: "codex_acp",
      role: "meta",
      status: "available",
      reasons: [],
      missingCapabilities: [],
      missingExtensions: [],
      model: profile.model,
      observedProtocolMajor: 1,
      observedAgent: { name: "codex-acp", version: "current" },
    },
  };
}

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ExecutionProfileDefinition, ProviderCapability, ProviderKind } from "@agent-workspace/runtime-contracts";
import {
  RUNTIME_PROVIDER_CONFIGURATION_ENV,
  loadRuntimeProviderPortsFromEnvironment,
  parseRuntimeProviderConfiguration,
} from "../../apps/runtime-host/src/provider-composition.js";

const configuration = process.env[RUNTIME_PROVIDER_CONFIGURATION_ENV];
const selectedProvider = process.env.AGENT_WORKSPACE_PROVIDER_SPIKE_PROVIDER as ProviderKind | undefined;
const runProbe = configuration && selectedProvider ? it : it.skip;

const REQUIRED_SPIKE_CAPABILITIES: readonly ProviderCapability[] = [
  "create_binding",
  "resume_binding",
  "input_correlation",
  "provider_receipt",
  "reconcile",
  "interrupt",
];

describe("real Provider protocol spike (explicit opt-in)", () => {
  runProbe("records a version-pinned, capability-gated protocol observation", async () => {
    const parsed = parseRuntimeProviderConfiguration(configuration!);
    const entry = parsed.providers.find((candidate) => candidate.provider === selectedProvider);
    expect(entry, "selected Provider must be present in AGENT_WORKSPACE_PROVIDER_CONFIG").toBeDefined();

    const ports = loadRuntimeProviderPortsFromEnvironment();
    const port = ports.find((candidate) => candidate.provider === selectedProvider);
    expect(port, "selected Provider must be registered by Runtime Host composition").toBeDefined();

    const capabilities = await port!.describeCapabilities(profileFor(entry!.provider, entry!.protocol));
    const observed = {
      available: capabilities.available,
      providerVersion: capabilities.providerVersion,
      protocolFingerprint: capabilities.protocolFingerprint,
      capabilities: [...capabilities.capabilities].sort(),
      unavailableReasons: [...capabilities.unavailableReasons],
    };
    writeEvidence({ provider: entry!.provider, declared: entry!.protocol, observed });

    expect(capabilities.available, JSON.stringify(observed)).toBe(true);
    expect(capabilities.providerVersion).toBe(entry!.protocol.providerVersion);
    expect(capabilities.protocolFingerprint).toBe(entry!.protocol.protocolFingerprint);
    for (const capability of REQUIRED_SPIKE_CAPABILITIES) {
      expect(capabilities.capabilities).toContain(capability);
    }
  });
});

function profileFor(
  provider: ProviderKind,
  protocol: { readonly providerVersion: string; readonly protocolFingerprint: string },
): ExecutionProfileDefinition {
  return {
    executionProfileId: `profile_spike_${provider.replace("-", "_")}`,
    provider,
    model: process.env.AGENT_WORKSPACE_PROVIDER_SPIKE_MODEL ?? "protocol-spike",
    providerVersion: protocol.providerVersion,
    protocolFingerprint: protocol.protocolFingerprint,
    capabilityPolicy: {
      requiredCapabilities: REQUIRED_SPIKE_CAPABILITIES,
      allowedTools: [],
      permissionMode: "ask",
      maxConcurrentTurns: 1,
      maxNativeChildren: 0,
    },
  };
}

/**
 * This is deliberately opt-in: an evidence path is supplied by the operator,
 * usually under the ignored Runtime data directory. It contains no endpoint,
 * header, command, secret, cwd, native id, or raw Provider payload.
 */
function writeEvidence(value: Readonly<Record<string, unknown>>): void {
  const evidencePath = process.env.AGENT_WORKSPACE_PROVIDER_SPIKE_EVIDENCE_PATH;
  if (!evidencePath) return;
  mkdirSync(path.dirname(evidencePath), { recursive: true });
  writeFileSync(evidencePath, `${JSON.stringify({
    schemaVersion: 1,
    kind: "agent-workspace-provider-protocol-spike",
    test: "tests/integration/provider-protocol-spike.test.ts",
    observedAt: new Date().toISOString(),
    ...value,
    residualRisk: "Protocol/capability pin only; no create/resume/input/interrupt lifecycle was exercised by this safe probe.",
  }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

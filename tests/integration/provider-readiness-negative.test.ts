import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ExecutionProfileDefinition } from "@agent-workspace/runtime-contracts";
import { createProviderRegistry } from "@agent-workspace/runtime-application";
import { inspectOpenCodeServerProtocol } from "@agent-workspace/provider-opencode";
import { describe, expect, it } from "vitest";
import {
  createRuntimeProviderPorts,
  parseRuntimeProviderConfiguration,
} from "../../apps/runtime-host/src/provider-composition.js";

const baseUrl = process.env.AGENT_WORKSPACE_OPENCODE_READINESS_URL;
const runProbe = baseUrl ? it : it.skip;

describe("real OpenCode Task Profile readiness negative (explicit opt-in)", () => {
  runProbe("keeps a 1.18.13 frozen profile unavailable against the observed local version", async () => {
    const observed = await inspectOpenCodeServerProtocol({ baseUrl: baseUrl! });
    const inspectedPaths: string[] = [];
    const declared = {
      providerVersion: "1.18.13",
      // Hold the schema dimension constant so this probe isolates the version fence.
      protocolFingerprint: observed.protocolFingerprint,
    };
    const ports = createRuntimeProviderPorts(parseRuntimeProviderConfiguration(JSON.stringify({
      schemaVersion: 1,
      providers: [{
        provider: "opencode",
        protocol: declared,
        transport: { kind: "opencode-server", baseUrl: baseUrl! },
      }],
    })), {
      fetchFn: async (input, init) => {
        inspectedPaths.push(new URL(String(input)).pathname);
        return fetch(input, init);
      },
    });
    const registry = createProviderRegistry(ports);
    const readiness = await registry.probe(profile(declared));

    expect(observed.providerVersion).not.toBe(declared.providerVersion);
    expect(readiness).toEqual({
      state: "version_mismatch",
      unavailableReasons: ["provider_version_mismatch"],
      missingCapabilities: [],
    });
    expect([...new Set(inspectedPaths)].sort()).toEqual(["/doc", "/global/health"]);
    writeEvidence({
      declaredProviderVersion: declared.providerVersion,
      observedProviderVersion: observed.providerVersion,
      observedProtocolFingerprint: observed.protocolFingerprint,
      readiness,
      nativeSessionEffects: 0,
    });
  });
});

function profile(pin: Readonly<{ providerVersion: string; protocolFingerprint: string }>): ExecutionProfileDefinition {
  return {
    executionProfileId: "profile_opencode_managed",
    provider: "opencode",
    model: "opencode/deepseek-v4-flash-free",
    ...pin,
    capabilityPolicy: {
      requiredCapabilities: ["create_binding", "resume_binding", "input_correlation", "provider_receipt", "reconcile", "interrupt"],
      allowedTools: [],
      permissionMode: "ask",
      maxConcurrentTurns: 1,
      maxNativeChildren: 0,
    },
  };
}

function writeEvidence(value: Readonly<Record<string, unknown>>): void {
  const evidencePath = process.env.AGENT_WORKSPACE_OPENCODE_READINESS_EVIDENCE_PATH;
  if (!evidencePath) return;
  mkdirSync(path.dirname(evidencePath), { recursive: true });
  writeFileSync(evidencePath, `${JSON.stringify({
    schemaVersion: 1,
    kind: "agent-workspace-opencode-readiness-negative",
    test: "tests/integration/provider-readiness-negative.test.ts",
    observedAt: new Date().toISOString(),
    outcome: "passed",
    ...value,
    residualRisk: "Readiness/version negative only; no managed create, resume, receipt, interrupt, Browser, or Electron lifecycle was exercised.",
  }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

import assert from "node:assert/strict";
import { registerProviderAdapterContractSuite } from "../../provider-port/test/support/provider-adapter-contract-suite.mjs";
import {
  CODEX_CAPABILITIES,
  CODEX_FIXTURE_PROTOCOL,
  createCodexFixtureProfile,
  createCodexFixtureTransport,
  createCodexProviderAdapter,
} from "../src/index.mjs";

const isVitest = process.env.VITEST === "true" || process.env.VITEST_WORKER_ID !== undefined;
const testApi = isVitest ? await import("vitest") : await import("node:test");

registerProviderAdapterContractSuite({
  ...testApi,
  assert,
  providerName: "Codex",
  createFixture,
});

function createFixture({ capabilities = CODEX_CAPABILITIES } = {}) {
  const transport = createCodexFixtureTransport();
  const profile = createCodexFixtureProfile();
  const adapter = createCodexProviderAdapter({
    transport,
    protocol: CODEX_FIXTURE_PROTOCOL,
    capabilities,
    now: () => "2026-08-06T00:00:00.000Z",
  });
  return {
    adapter,
    transport,
    profile,
    bindingRequest(extra = {}) {
      return { bindingId: "binding-1", bindingRevision: 1, executionProfile: profile, workspace: { workspaceId: "workspace-fixture", cwd: "/tmp/provider-fixture" }, bootstrap: { purpose: "task_conductor", agentCardId: "agent_card_conductor", systemPrompt: "Coordinate bounded work.", capabilityRefs: [], dispatchRegistry: [] }, ...extra };
    },
    inputRequest(extra = {}) {
      return {
        bindingId: "binding-1",
        bindingRevision: 1,
        executionProfile: profile,
        workspace: { workspaceId: "workspace-fixture", cwd: "/tmp/provider-fixture" },
        bootstrap: { purpose: "task_conductor", agentCardId: "agent_card_conductor", systemPrompt: "Coordinate bounded work.", capabilityRefs: [], dispatchRegistry: [] },
        inputSubmissionId: "input-1",
        idempotencyKey: "input:binding-1:1",
        content: "fixture input",
        ...extra,
      };
    },
    nativeFact(scenario, extra = {}) {
      return {
        method: CODEX_FIXTURE_TYPES[scenario],
        sourceInstanceId: "codex-fixture-host-1",
        ...extra,
      };
    },
  };
}

const CODEX_FIXTURE_TYPES = Object.freeze({
  receipt: "codex.delivery.receipt",
  unprovenReceipt: "codex.delivery.receipt",
  attention: "codex.attention.requested",
  interruptUnknown: "codex.interrupt.unknown",
  backgroundChild: "codex.child.started",
});

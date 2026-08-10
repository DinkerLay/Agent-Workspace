import assert from "node:assert/strict";
import { registerProviderAdapterContractSuite } from "../../provider-port/test/support/provider-adapter-contract-suite.mjs";
import {
  OPENCODE_CAPABILITIES,
  OPENCODE_FIXTURE_PROTOCOL,
  createOpenCodeFixtureProfile,
  createOpenCodeFixtureTransport,
  createOpenCodeProviderAdapter,
} from "../src/index.mjs";

const isVitest = process.env.VITEST === "true" || process.env.VITEST_WORKER_ID !== undefined;
const testApi = isVitest ? await import("vitest") : await import("node:test");

registerProviderAdapterContractSuite({
  ...testApi,
  assert,
  providerName: "OpenCode",
  createFixture,
});

function createFixture({ capabilities = OPENCODE_CAPABILITIES } = {}) {
  const transport = createOpenCodeFixtureTransport();
  const profile = createOpenCodeFixtureProfile();
  const adapter = createOpenCodeProviderAdapter({
    transport,
    protocol: OPENCODE_FIXTURE_PROTOCOL,
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
        type: OPEN_CODE_FIXTURE_TYPES[scenario],
        sourceInstanceId: "opencode-fixture-host-1",
        ...extra,
      };
    },
  };
}

const OPEN_CODE_FIXTURE_TYPES = Object.freeze({
  receipt: "opencode.delivery.receipt",
  unprovenReceipt: "opencode.delivery.receipt",
  attention: "opencode.attention.requested",
  interruptUnknown: "opencode.interrupt.unknown",
  backgroundChild: "opencode.child.started",
});

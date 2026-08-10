import assert from "node:assert/strict";
import { registerProviderAdapterContractSuite } from "../../provider-port/test/support/provider-adapter-contract-suite.mjs";
import {
  CLAUDE_CODE_CAPABILITIES,
  CLAUDE_CODE_FIXTURE_PROTOCOL,
  createClaudeCodeFixtureProfile,
  createClaudeCodeFixtureTransport,
  createClaudeCodeProviderAdapter,
} from "../src/index.mjs";

const isVitest = process.env.VITEST === "true" || process.env.VITEST_WORKER_ID !== undefined;
const testApi = isVitest ? await import("vitest") : await import("node:test");

registerProviderAdapterContractSuite({
  ...testApi,
  assert,
  providerName: "Claude Code",
  createFixture,
});

testApi.describe("Claude Code final-message mapping", () => {
  testApi.it("normalizes an observed native final into assistant_final without using turn completion as text", async () => {
    const fixture = createFixture();
    fixture.transport.setStream("binding-1", [{
      type: "claude-code.assistant.final",
      providerEventId: "claude-final-1",
      sourceInstanceId: "claude-code-fixture-host-1",
      invocationId: "invocation-1",
      nativeMessageId: "native-message-1",
      payload: { content: "Worker final reply" },
    }]);

    const facts = [];
    for await (const fact of fixture.adapter.observeBinding(fixture.bindingRequest())) facts.push(fact);

    assert.equal(facts.length, 1);
    assert.equal(facts[0].kind, "assistant_final");
    assert.equal(facts[0].correlation.invocationId, "invocation-1");
    assert.equal(facts[0].payload.content, "Worker final reply");
  });
});

function createFixture({ capabilities = CLAUDE_CODE_CAPABILITIES } = {}) {
  const transport = createClaudeCodeFixtureTransport();
  const profile = createClaudeCodeFixtureProfile();
  const adapter = createClaudeCodeProviderAdapter({
    transport,
    protocol: CLAUDE_CODE_FIXTURE_PROTOCOL,
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
        type: CLAUDE_CODE_FIXTURE_TYPES[scenario],
        sourceInstanceId: "claude-code-fixture-host-1",
        ...extra,
      };
    },
  };
}

const CLAUDE_CODE_FIXTURE_TYPES = Object.freeze({
  receipt: "claude-code.delivery.receipt",
  unprovenReceipt: "claude-code.delivery.receipt",
  attention: "claude-code.attention.requested",
  interruptUnknown: "claude-code.interrupt.unknown",
  backgroundChild: "claude-code.child.started",
});

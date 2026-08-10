import {
  type ProviderFact,
  type TemplateDefinition,
  type TemplatePackage,
} from "../../runtime-contracts/src";

export function templateDefinitionFixture(): TemplateDefinition {
  return {
    schemaVersion: 2,
    conductor: {
      agentCardId: "agent_card_conductor",
      kind: "conductor",
      title: "Conductor",
      executionProfileId: "profile_conductor",
      systemPrompt: "Decide bounded work from durable evidence.",
      capabilityRefs: [],
    },
    agentCards: [{
      agentCardId: "agent_card_researcher",
      kind: "researcher",
      title: "Researcher",
      executionProfileId: "profile_worker",
      systemPrompt: "Research only the supplied objective and return evidence.",
      capabilityRefs: [],
      dispatchProfile: {
        title: "Evidence research",
        description: "Use for a bounded evidence-gathering assignment and return verifiable findings.",
      },
    }],
    executionProfiles: [{
      executionProfileId: "profile_conductor",
      provider: "opencode",
      model: "test-conductor",
      providerVersion: "fake-provider/1",
      protocolFingerprint: "fake-provider-contract/v1",
      capabilityPolicy: {
        requiredCapabilities: ["create_binding", "resume_binding", "input_correlation", "provider_receipt", "reconcile", "interrupt"],
        allowedTools: [],
        permissionMode: "ask",
        maxConcurrentTurns: 1,
        maxNativeChildren: 0,
      },
    }, {
      executionProfileId: "profile_worker",
      provider: "opencode",
      model: "test-worker",
      providerVersion: "fake-provider/1",
      protocolFingerprint: "fake-provider-contract/v1",
      capabilityPolicy: {
        requiredCapabilities: ["create_binding", "resume_binding", "input_correlation", "provider_receipt", "reconcile", "interrupt"],
        allowedTools: [],
        permissionMode: "ask",
        maxConcurrentTurns: 1,
        maxNativeChildren: 0,
      },
    }],
    routingPolicy: { mode: "agent_loop", maxConcurrentInvocations: 2, maxDispatchesPerDecision: 2 },
    deliverables: [{ artifactPath: "reports/result.md", ownerAgentCardId: "agent_card_researcher" }],
  };
}

export function templatePackageFixture(): TemplatePackage {
  return {
    schemaVersion: 2,
    kind: "agent-workspace/template",
    template: {
      templateId: "template_research-team",
      version: 1,
      slug: "research-team",
      title: "Research Team",
    },
    definition: templateDefinitionFixture(),
  };
}

export function providerFactFixture(overrides: Partial<ProviderFact> = {}): ProviderFact {
  return {
    providerFactId: "provider_fact_001",
    provider: "opencode",
    bindingId: "binding_001",
    bindingRevision: 1,
    kind: "binding_observed",
    deduplication: { providerEventId: "event-001" },
    correlation: {},
    payload: { nativeBindingRef: "native-session-001" },
    observedAt: "2026-08-06T00:00:00.000Z",
    ...overrides,
  };
}

import assert from "node:assert/strict";
import {
  createProtocolGatedProviderAdapter,
  createProviderEffect,
  deriveProviderCapabilitiesFromTransport,
  normalizeProviderFact,
  providerFactDedupKey,
  renderProviderSessionBootstrap,
} from "../src/index.mjs";

const isVitest = process.env.VITEST === "true" || process.env.VITEST_WORKER_ID !== undefined;
const testApi = isVitest ? await import("vitest") : await import("node:test");
const { describe, it } = testApi;

describe("ProviderPort primitives", () => {
  it("uses event identity before cursor and watermark when deriving a dedup key", () => {
    const fact = normalizeProviderFact({
      provider: "opencode",
      bindingId: "binding-a",
      bindingRevision: 1,
      nativeFact: {
        kind: "native_terminal",
        eventId: "event-a",
        sourceInstanceId: "instance-a",
        cursor: "42",
        reconciliationWatermark: "watermark-a",
      },
      now: () => "2026-08-06T00:00:00.000Z",
    });
    assert.equal(providerFactDedupKey(fact), "opencode:binding-a:event:event-a");
  });

  it("downgrades an unproven input receipt to transport_unknown", () => {
    const fact = normalizeProviderFact({
      provider: "opencode",
      bindingId: "binding-a",
      bindingRevision: 1,
      nativeFact: {
        kind: "input_received",
        eventId: "event-unproven",
        payload: { locallyAccepted: true },
      },
      now: () => "2026-08-06T00:00:00.000Z",
    });
    assert.equal(fact.kind, "transport_unknown");
    assert.equal(fact.payload.reason, "native_receipt_evidence_missing");
  });

  it("accepts an evidence-backed native history marker as receipt proof", () => {
    const fact = normalizeProviderFact({
      provider: "opencode",
      bindingId: "binding-a",
      bindingRevision: 1,
      nativeFact: {
        kind: "input_received",
        eventId: "event-history-marker",
        historyMarker: "native-history:message-77",
        evidenceReferenceId: "evidence_history_77",
      },
      now: () => "2026-08-06T00:00:00.000Z",
    });
    assert.equal(fact.kind, "input_received");
    assert.equal(fact.evidenceReferenceId, "evidence_history_77");
  });

  it("accepts assistant_final with managed input correlation and native text", () => {
    const fact = normalizeProviderFact({
      provider: "claude-code",
      bindingId: "binding-a",
      bindingRevision: 1,
      nativeFact: {
        kind: "assistant_final",
        providerEventId: "event-final",
        inputSubmissionId: "input-a",
        payload: { content: "Worker reply" },
      },
    });
    assert.equal(fact.kind, "assistant_final");
    assert.equal(fact.correlation.inputSubmissionId, "input-a");
    assert.equal(fact.payload.content, "Worker reply");
    const relayFact = normalizeProviderFact({
      provider: "claude-code",
      bindingId: "binding-a",
      bindingRevision: 1,
      nativeFact: {
        kind: "assistant_final",
        providerEventId: "event-relay-final",
        inputSubmissionId: "input-relay-a",
        payload: { content: "Relay turn reply" },
      },
    });
    assert.equal(relayFact.correlation.inputSubmissionId, "input-relay-a");
  });

  it("rejects assistant_final without managed-turn correlation or text", () => {
    assert.throws(() => normalizeProviderFact({
      provider: "claude-code",
      bindingId: "binding-a",
      bindingRevision: 1,
      nativeFact: {
        kind: "assistant_final",
        providerEventId: "event-final-no-input",
        payload: { content: "Worker reply" },
      },
    }), /assistant_final\.inputSubmissionId_required/);
    assert.throws(() => normalizeProviderFact({
      provider: "claude-code",
      bindingId: "binding-a",
      bindingRevision: 1,
      nativeFact: {
        kind: "assistant_final",
        providerEventId: "event-final-no-content",
        inputSubmissionId: "input-a",
        payload: {},
      },
    }), /assistant_final\.payload\.content/);
  });

  it("accepts only the bounded provider-neutral activity presentation schema", () => {
    const fact = normalizeProviderFact({
      provider: "codex",
      bindingId: "binding-a",
      bindingRevision: 1,
      nativeFact: {
        kind: "activity_observed",
        providerEventId: "event-activity",
        inputSubmissionId: "input-a",
        nativeMessageId: "native-message-private",
        payload: {
          schemaVersion: 1,
          activityId: "activity_0123456789abcdef",
          category: "tool",
          phase: "progress",
          title: "运行命令",
          detail: "npm test",
          content: "Tests are running",
          updateMode: "append",
          sequence: 3,
          cwd: "/private/workspace",
          rawArguments: { token: "secret" },
        },
      },
    });

    assert.equal(fact.kind, "activity_observed");
    assert.equal(fact.correlation.inputSubmissionId, "input-a");
    assert.deepEqual(fact.payload, {
      schemaVersion: 1,
      activityId: "activity_0123456789abcdef",
      category: "tool",
      phase: "progress",
      title: "运行命令",
      detail: "npm test",
      content: "Tests are running",
      updateMode: "append",
      sequence: 3,
    });
    assert.ok(!JSON.stringify(fact.payload).includes("private"));
    assert.throws(() => normalizeProviderFact({
      provider: "codex",
      bindingId: "binding-a",
      bindingRevision: 1,
      nativeFact: {
        kind: "activity_observed",
        providerEventId: "event-activity-invalid",
        inputSubmissionId: "input-a",
        payload: { schemaVersion: 1, activityId: "native-id", category: "tool", phase: "progress", title: "Tool", sequence: 0 },
      },
    }), /activity identity is invalid/);
  });

  it("fails closed when a direct transport does not declare a required operation", async () => {
    const observation = { providerVersion: "fixture-1", protocolFingerprint: "sha256:fixture" };
    const transport = {
      supportedOperations: ["inspect_protocol"],
      inspectProtocol: async () => observation,
      request: async () => ({ accepted: true }),
    };
    const adapter = createProtocolGatedProviderAdapter({
      provider: "opencode",
      startupProtocolObservation: observation,
      capabilities: ["create_binding", "resume_binding"],
      transport,
    });
    const profile = {
      executionProfileId: "profile_fixture",
      provider: "opencode",
      model: "fixture",
      providerVersion: observation.providerVersion,
      protocolFingerprint: observation.protocolFingerprint,
      capabilityPolicy: {
        requiredCapabilities: ["create_binding"],
        allowedTools: [],
        permissionMode: "ask",
        maxConcurrentTurns: 1,
        maxNativeChildren: 0,
      },
    };

    assert.deepEqual(deriveProviderCapabilitiesFromTransport(transport), []);
    const report = await adapter.describeCapabilities(profile);
    assert.equal(report.available, false);
    assert.ok(report.unavailableReasons.includes("capability_create_binding_unavailable"));
  });

  it("lets a native transport cap operation-derived capabilities to live-proven semantics", async () => {
    const observation = { providerVersion: "native-1", protocolFingerprint: "sha256:native" };
    const transport = {
      supportedOperations: ["inspect_protocol", "ensure_binding", "submit_delivery", "reconcile_binding", "request_interrupt"],
      verifiedCapabilities: ["create_binding", "resume_binding", "input_correlation", "provider_receipt", "reconcile", "interrupt"],
      inspectProtocol: async () => observation,
      request: async () => ({ accepted: true }),
      reconcile: async () => [],
    };
    const adapter = createProtocolGatedProviderAdapter({
      provider: "opencode",
      startupProtocolObservation: observation,
      capabilities: ["create_binding", "resume_binding", "input_correlation", "provider_receipt", "reconcile", "interrupt", "native_child"],
      transport,
    });
    const report = await adapter.describeCapabilities({
      executionProfileId: "profile_native",
      provider: "opencode",
      model: "native",
      providerVersion: observation.providerVersion,
      protocolFingerprint: observation.protocolFingerprint,
      capabilityPolicy: {
        requiredCapabilities: ["create_binding"],
        allowedTools: [],
        permissionMode: "ask",
        maxConcurrentTurns: 1,
        maxNativeChildren: 0,
      },
    });
    assert.equal(report.available, true);
    assert.ok(!report.capabilities.includes("native_child"));
  });

  it("retains the Host-startup protocol observation and fails closed on later transport drift", async () => {
    const startupObservation = { providerVersion: "runtime-1", protocolFingerprint: "sha256:runtime-1" };
    let liveProtocol = { providerVersion: "runtime-1", protocolFingerprint: "sha256:runtime-1" };
    const transport = {
      supportedOperations: ["inspect_protocol", "ensure_binding"],
      inspectProtocol: async () => liveProtocol,
      request: async () => ({ acceptance: "accepted" }),
    };
    const adapter = createProtocolGatedProviderAdapter({
      provider: "opencode",
      startupProtocolObservation: startupObservation,
      capabilities: ["create_binding"],
      transport,
    });
    const profile = {
      executionProfileId: "profile_runtime_discovery",
      provider: "opencode",
      model: "fixture",
      providerVersion: "profile-1",
      protocolFingerprint: "sha256:profile-1",
      capabilityPolicy: {
        requiredCapabilities: ["create_binding"],
        allowedTools: [],
        permissionMode: "ask",
        maxConcurrentTurns: 1,
        maxNativeChildren: 0,
      },
    };

    const first = await adapter.describeCapabilities(profile);
    assert.equal(first.available, true);
    assert.equal(first.providerVersion, "runtime-1");
    assert.equal(first.protocolFingerprint, "sha256:runtime-1");

    liveProtocol = { providerVersion: "runtime-2", protocolFingerprint: "sha256:runtime-2" };
    const drifted = await adapter.describeCapabilities(profile);
    assert.equal(drifted.available, false);
    assert.equal(drifted.providerVersion, "runtime-2");
    assert.equal(drifted.protocolFingerprint, "sha256:runtime-2");
    assert.ok(drifted.unavailableReasons.includes("transport_protocol_observation_drift"));
    await assert.rejects(
      adapter.ensureBinding({
        bindingId: "binding-runtime-discovery",
        bindingRevision: 1,
        executionProfile: profile,
        workspace: { workspaceId: "workspace-runtime-discovery", cwd: "/tmp/runtime-discovery" },
        bootstrap: {
          purpose: "task_conductor",
          agentCardId: "agent-card-runtime-discovery",
          systemPrompt: "Observe the live protocol.",
          capabilityRefs: [],
          dispatchRegistry: [],
        },
      }),
      (error) => error?.code === "provider_unavailable"
        && error?.report?.unavailableReasons?.includes("transport_protocol_observation_drift"),
    );
  });

  it("reports an incomplete live protocol observation as unavailable evidence", async () => {
    const transport = {
      supportedOperations: ["inspect_protocol", "ensure_binding"],
      inspectProtocol: async () => ({ providerVersion: "runtime-1" }),
      request: async () => ({ acceptance: "accepted" }),
    };
    const adapter = createProtocolGatedProviderAdapter({
      provider: "opencode",
      startupProtocolObservation: { providerVersion: "configured-1", protocolFingerprint: "sha256:configured" },
      capabilities: ["create_binding"],
      transport,
    });
    const report = await adapter.describeCapabilities({
      executionProfileId: "profile_incomplete_observation",
      provider: "opencode",
      model: "fixture",
      providerVersion: "profile-1",
      protocolFingerprint: "sha256:profile-1",
      capabilityPolicy: {
        requiredCapabilities: ["create_binding"],
        allowedTools: [],
        permissionMode: "ask",
        maxConcurrentTurns: 1,
        maxNativeChildren: 0,
      },
    });

    assert.equal(report.available, false);
    assert.equal(report.providerVersion, "runtime-1");
    assert.equal(report.protocolFingerprint, undefined);
    assert.ok(report.unavailableReasons.includes("observed_protocolFingerprint_missing"));
  });

  it("rejects legacy adapter/profile aliases instead of silently translating them", async () => {
    const observation = { providerVersion: "strict-1", protocolFingerprint: "sha256:strict" };
    const transport = {
      supportedOperations: ["inspect_protocol", "ensure_binding", "submit_delivery", "reconcile_binding", "request_interrupt"],
      inspectProtocol: async () => observation,
      request: async () => ({ accepted: true }),
      reconcile: async () => [],
    };

    assert.throws(() => createProtocolGatedProviderAdapter({
      providerId: "opencode",
      startupProtocolObservation: observation,
      capabilities: [],
      transport,
    }), /provider must be a non-empty string/);

    const adapter = createProtocolGatedProviderAdapter({
      provider: "opencode",
      startupProtocolObservation: observation,
      capabilities: ["create_binding", "resume_binding", "input_correlation", "provider_receipt", "reconcile", "interrupt"],
      transport,
    });
    await assert.rejects(
      adapter.describeCapabilities({
        providerId: "opencode",
        protocol: { providerVersion: observation.providerVersion, schemaFingerprint: observation.protocolFingerprint },
        requiredCapabilities: ["createResume"],
      }),
      /Execution profile capabilityPolicy is missing/,
    );
    assert.throws(() => createProtocolGatedProviderAdapter({
      provider: "opencode",
      startupProtocolObservation: observation,
      capabilities: { createResume: true },
      transport,
    }), /Provider capabilities must be an array/);
  });

  it("does not turn legacy inputId fields into runtime correlation", () => {
    const effect = createProviderEffect({
      provider: "opencode",
      operation: "submit_delivery",
      request: { bindingId: "binding-a", inputId: "legacy-input" },
      response: { acceptance: "accepted" },
      acceptedAt: "2026-08-06T00:00:00.000Z",
    });
    assert.equal(effect.inputSubmissionId, undefined);

    const fact = normalizeProviderFact({
      provider: "opencode",
      bindingId: "binding-a",
      bindingRevision: 1,
      nativeFact: {
        kind: "turn_started",
        providerEventId: "event-strict-input",
        inputId: "legacy-input",
      },
    });
    assert.equal(fact.correlation.inputSubmissionId, undefined);
  });

  it("renders a Conductor bootstrap from card metadata without a Worker prompt", () => {
    const rendered = renderProviderSessionBootstrap({
      purpose: "task_conductor",
      agentCardId: "agent_card_conductor",
      systemPrompt: "Coordinate the Task.",
      capabilityRefs: [{ kind: "mcp", id: "agent_workspace_conductor" }],
      dispatchRegistry: [{
        agentCardId: "agent_card_worker",
        kind: "researcher",
        title: "Evidence research",
        description: "Gather bounded evidence for the Conductor.",
      }],
    });
    assert.match(rendered, /Coordinate the Task/);
    assert.match(rendered, /Evidence research/);
    assert.match(rendered, /mcp:agent_workspace_conductor/);
    assert.doesNotMatch(rendered, /Worker system prompt: never expose this/);
  });
});

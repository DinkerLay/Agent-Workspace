import { describe, expect, it, vi } from "vitest";
import type {
  ProviderScopedToolCall,
  ProviderScopedToolTurnContext,
} from "@agent-workspace/provider-port";
import type {
  AcpSessionObservation,
  ManagedAcpV1Client,
} from "@agent-workspace/provider-acp";
import {
  CONDUCTOR_ORCHESTRATION_TOOL_DEFINITIONS,
  type ExecutionProfileDefinitionV3,
} from "@agent-workspace/runtime-contracts";
import type { AcpProviderAvailabilityReport } from "./acp-provider-composition.js";
import { LocalProfileResolution } from "./acp-profile-resolution.js";
import type { AcpReverseRpcLease } from "./acp-reverse-rpc-broker.js";
import type { AcpTaskScopedMcpRole } from "./acp-task-scoped-mcp.js";
import {
  createAcpTaskBindingRuntime,
  runAcpTaskQualificationProbe,
  type AcpTaskPromptResult,
} from "./acp-task-profile-runtime.js";

const BINDING_HANDLE = "binding_handle_common_task_profile";
const PROFILE = Object.freeze({
  executionProfileId: "profile_common_task_profile",
  profileRevisionId: "profile_revision_common_task_profile_v1",
});
const REPORT: AcpProviderAvailabilityReport = Object.freeze({
  profileRevisionId: PROFILE.profileRevisionId,
  providerFamily: "opencode",
  acpAgentKind: "native_acp",
  role: "worker",
  available: true,
  protocolMajor: 1,
  capabilities: Object.freeze([]),
  extensions: Object.freeze([]),
  unavailableReasons: Object.freeze([]),
  qualificationClass: "binding_behavior",
  evidenceClass: "injected_host_qualification",
});

describe("provider-neutral ACP Task Binding runtime", () => {
  it("settles and replays one Attempt without a second Provider prompt", async () => {
    const settlement = Object.freeze({
      bindingHandle: BINDING_HANDLE,
      attemptId: "session_execution_attempt_common_a",
      stopReason: "end_turn" as const,
      receiptDigest: `sha256:${"a".repeat(64)}`,
      finalCandidateGroupCount: 1,
      finalCandidate: "done",
    });
    const fixture = runtimeFixture(vi.fn(async () => settlement));

    const first = await fixture.runtime.submitPrompt({
      attemptId: settlement.attemptId,
      content: "work",
    });
    const replay = await fixture.runtime.submitPrompt({
      attemptId: settlement.attemptId,
      content: "ignored replay content",
    });

    expect(first).toEqual({ state: "settled", settlement, observations: [] });
    expect(replay).toBe(first);
    expect(fixture.submitPrompt).toHaveBeenCalledTimes(1);
    expect(fixture.runtime.safeObservation()).toMatchObject({
      providerFamily: "opencode",
      acpAgentKind: "native_acp",
      role: "worker",
      available: true,
    });

    await fixture.runtime.releaseBinding();
    expect(fixture.releaseBinding).toHaveBeenCalledTimes(1);
    expect(fixture.close).toHaveBeenCalledTimes(1);
    expect(fixture.releasePrivateWorkingDirectory).toHaveBeenCalledTimes(1);
  });

  it("blocks new delivery until an ambiguous Attempt is durably reconciled", async () => {
    const submitPrompt = vi.fn()
      .mockRejectedValueOnce(new Error("transport_lost"))
      .mockResolvedValueOnce(Object.freeze({
        bindingHandle: BINDING_HANDLE,
        attemptId: "session_execution_attempt_common_b",
        stopReason: "end_turn" as const,
        receiptDigest: `sha256:${"b".repeat(64)}`,
        finalCandidateGroupCount: 1,
      }));
    const reconciled: AcpTaskPromptResult = Object.freeze({
      state: "settled",
      settlement: Object.freeze({
        bindingHandle: BINDING_HANDLE,
        attemptId: "session_execution_attempt_common_a",
        stopReason: "end_turn",
        receiptDigest: `sha256:${"c".repeat(64)}`,
        finalCandidateGroupCount: 1,
      }),
      observations: Object.freeze([]),
    });
    const reconcile = vi.fn(async () => reconciled);
    const fixture = runtimeFixture(submitPrompt, reconcile);

    await expect(fixture.runtime.submitPrompt({
      attemptId: "session_execution_attempt_common_a",
      content: "first",
    })).resolves.toMatchObject({ state: "reconciling", resendAllowed: false });
    expect(fixture.onDiagnostic).toHaveBeenCalledWith({
      code: "transport_lost",
      stage: "prompt",
    });
    await expect(fixture.runtime.submitPrompt({
      attemptId: "session_execution_attempt_common_b",
      content: "second",
    })).rejects.toThrow("test_acp_task_reconciliation_required");

    await expect(fixture.runtime.reconcilePrompt({
      attemptId: "session_execution_attempt_common_a",
    })).resolves.toEqual(reconciled);
    await expect(fixture.runtime.submitPrompt({
      attemptId: "session_execution_attempt_common_b",
      content: "second",
    })).resolves.toMatchObject({ state: "settled" });
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(submitPrompt).toHaveBeenCalledTimes(2);

    await fixture.runtime.close();
  });

  it("records tool calls delegated through a provider-specific qualification context", async () => {
    const bindingHandle = "binding_handle_common_custom_probe";
    const toolNames = CONDUCTOR_ORCHESTRATION_TOOL_DEFINITIONS.map(({ name }) => name);
    const attemptIds = toolNames.map((_, index) => `session_execution_attempt_common_custom_probe_${index}`);
    const expectedFinals = toolNames.map((_, index) => `CUSTOM_QUALIFICATION_OK_${index}`);
    const delegatedCalls: string[] = [];
    const qualificationOrder: string[] = [];
    const lease = Object.freeze({ qualification: "provider-specific" });
    const customContext: ProviderScopedToolTurnContext = Object.freeze({
      capabilityClass: "runtime_orchestration",
      lease,
      async handleCall(call: ProviderScopedToolCall) {
        delegatedCalls.push(call.name);
        return Object.freeze({ providerCallId: call.providerCallId, result: { accepted: true } });
      },
    });
    let activeContext: ProviderScopedToolTurnContext | undefined;
    const scopedBinding = Object.freeze({
      mcpServers: Object.freeze([]),
      async waitForToolDiscovery() {
        qualificationOrder.push("tools_discovered");
      },
      async activateAttempt(input: Readonly<{ turnContext: ProviderScopedToolTurnContext }>) {
        qualificationOrder.push("attempt_activated");
        activeContext = input.turnContext;
      },
      observedToolCalls: () => delegatedCalls.length,
      observedToolNames: () => Object.freeze([...delegatedCalls]),
      observedToolAttemptNames: () => Object.freeze([...delegatedCalls]),
      revokeAttempt: async () => undefined,
      close: async () => undefined,
    });
    const scope: AcpTaskScopedMcpRole = Object.freeze({
      role: "conductor",
      registration: Object.freeze({
        capabilityClass: "runtime_orchestration" as const,
        tools: CONDUCTOR_ORCHESTRATION_TOOL_DEFINITIONS,
      }),
      createReverseRpcRegistration: () => undefined,
      openBindingRoute: async () => scopedBinding,
      safeObservation: () => Object.freeze({
        role: "conductor" as const,
        scopedTools: true,
        toolCount: toolNames.length,
      }),
      close: async () => undefined,
    });
    const observations: AcpSessionObservation[] = [];
    const client: ManagedAcpV1Client = {
      initialize: vi.fn(),
      inspectModelCatalog: vi.fn(),
      ensureBinding: vi.fn(async (command) => {
        qualificationOrder.push("binding_ready");
        return Object.freeze({
          kind: "binding_ready" as const,
          bindingHandle: command.bindingHandle,
          disposition: command.disposition,
          recoverable: true,
          model: "provider/model-common-probe",
          modelCatalog: Object.freeze([{
            modelId: "provider/model-common-probe",
            label: "Common probe model",
          }]),
          configurationFingerprint: `sha256:${"e".repeat(64)}`,
        });
      }),
      submitPrompt: vi.fn(async (command) => {
        qualificationOrder.push("prompt_submitted");
        if (!activeContext) throw new Error("qualification_context_not_active");
        const index = attemptIds.indexOf(command.attemptId);
        if (index < 0) throw new Error("qualification_attempt_unknown");
        await activeContext.handleCall({
          providerCallId: `provider_call_common_probe_${index}`,
          name: toolNames[index]!,
          arguments: Object.freeze({ index }),
          lease: activeContext.lease,
        });
        const receiptDigest = `sha256:${String(index + 1).repeat(64)}`;
        observations.push(
          Object.freeze({ kind: "delivery_receipt", bindingHandle, attemptId: command.attemptId, receiptDigest }),
          Object.freeze({ kind: "final_candidate", bindingHandle, attemptId: command.attemptId, text: expectedFinals[index]! }),
          Object.freeze({ kind: "prompt_terminal", bindingHandle, attemptId: command.attemptId, stopReason: "end_turn", receiptDigest }),
        );
        return Object.freeze({
          bindingHandle,
          attemptId: command.attemptId,
          stopReason: "end_turn" as const,
          receiptDigest,
          finalCandidateGroupCount: 1,
          finalCandidate: expectedFinals[index]!,
        });
      }),
      requestInterrupt: vi.fn(),
      respondToInteraction: vi.fn(),
      releaseBinding: vi.fn(),
      invalidateGeneration: vi.fn(),
    };
    const result = await runAcpTaskQualificationProbe({
      context: Object.freeze({
        profile: qualificationProfile,
        bindingHandle,
        client,
        resolution: qualificationResolution,
        reverseRpcLease: qualificationReverseRpcLease(bindingHandle),
      }),
      probeScope: scope,
      providerWorkingDirectory: "/private/common-qualification",
      requiredBehaviors: Object.freeze(["common.custom_probe"]),
      sessionConfiguration: Object.freeze({
        model: qualificationProfile.model,
        options: Object.freeze([]),
      }),
      expectedModel: qualificationProfile.model,
      createQualificationAttemptId: () => "session_execution_attempt_unused_default",
      createQualificationProbe: () => Object.freeze({
        attemptId: attemptIds[0]!,
        content: "Run provider-specific qualification step 0.",
        interactionRevision: 1,
        turnContext: customContext,
        expectedFinalCandidate: expectedFinals[0]!,
        additionalSteps: Object.freeze(attemptIds.slice(1).map((attemptId, index) => Object.freeze({
          attemptId,
          content: `Run provider-specific qualification step ${index + 1}.`,
          interactionRevision: 1,
          turnContext: customContext,
          expectedFinalCandidate: expectedFinals[index + 1]!,
        }))),
      }),
      probeObservations: observations,
      qualificationAttemptIds: new Set<string>(),
      toolMatch: "ordered",
      createError: (suffix) => new Error(`test_acp_${suffix}`),
      setScopeBinding: vi.fn(),
      recordQualificationPromptEffect: vi.fn(),
    });

    expect(result).toMatchObject({
      passedBehaviors: ["common.custom_probe"],
      bindingEstablished: true,
      safeObservations: { scopedToolCallCount: 4 },
    });
    expect(delegatedCalls).toEqual(toolNames);
    expect(client.submitPrompt).toHaveBeenCalledTimes(4);
    expect(qualificationOrder.slice(0, 4)).toEqual([
      "binding_ready",
      "tools_discovered",
      "attempt_activated",
      "prompt_submitted",
    ]);
  });
});

const qualificationProfile: ExecutionProfileDefinitionV3 = Object.freeze({
  executionProfileId: "execution_profile_common_qualification",
  profileRevisionId: "profile_revision_common_qualification",
  providerFamily: "codex",
  acpAgentKind: "codex_acp",
  protocolMajor: 1,
  model: "provider/model-common-probe",
  configIntent: Object.freeze({}),
  requiredExtensions: Object.freeze([]),
  capabilityPolicy: Object.freeze({
    requiredCapabilities: Object.freeze([]),
    allowedTools: Object.freeze(CONDUCTOR_ORCHESTRATION_TOOL_DEFINITIONS.map(({ name }) => name)),
    permissionMode: "ask",
    maxConcurrentTurns: 1,
    maxNativeChildren: 0,
  }),
});

const qualificationResolution = new LocalProfileResolution({
  profile: qualificationProfile,
  profileFingerprint: `sha256:${"f".repeat(64)}`,
  discoverCurrent: async () => Object.freeze({
    canonicalLauncherPath: "/private/common-probe",
    launchArguments: Object.freeze([]),
    observedArtifactVersion: "test",
    artifactDigest: `sha256:${"1".repeat(64)}`,
    trustState: "trusted" as const,
    executionConfigDigest: `sha256:${"2".repeat(64)}`,
    environment: Object.freeze({}),
  }),
  material: Object.freeze({
    hostPrivateResolutionId: "host_private_resolution_common_probe",
    descriptorId: "descriptor_common_probe",
    canonicalLauncherPath: "/private/common-probe",
    launchArguments: Object.freeze([]),
    observedArtifactVersion: "test",
    artifactDigest: `sha256:${"1".repeat(64)}`,
    trustState: "trusted" as const,
    executionConfigDigest: `sha256:${"2".repeat(64)}`,
    environment: Object.freeze({}),
    observedAt: "2026-08-12T00:00:00.000Z",
    sealFingerprint: `sha256:${"3".repeat(64)}`,
  }),
});

function qualificationReverseRpcLease(bindingHandle: string): AcpReverseRpcLease {
  return Object.freeze({
    bindingHandle,
    activateAttempt: vi.fn(),
    deactivateAttempt: vi.fn(async () => undefined),
    reverseRpcHandlers: () => Object.freeze({}),
    dispatchMcp: vi.fn(),
    registerInteraction: vi.fn(),
    consumeInteraction: vi.fn(),
    safeObservation: () => Object.freeze({
      bindingHandle,
      availability: "active" as const,
      capabilities: Object.freeze({
        filesystem: false,
        mcp: true,
        terminal: false,
        interaction: true as const,
      }),
    }),
    close: vi.fn(async () => undefined),
  });
}

function runtimeFixture(
  submitPrompt: ManagedAcpV1Client["submitPrompt"],
  reconcile?: (input: Readonly<{
    bindingHandle: string;
    attemptId: string;
    knownObservations: readonly AcpSessionObservation[];
  }>) => Promise<AcpTaskPromptResult>,
) {
  const releaseBinding = vi.fn(async () => undefined);
  const close = vi.fn(async () => undefined);
  const releasePrivateWorkingDirectory = vi.fn(async () => undefined);
  const onDiagnostic = vi.fn();
  const client: ManagedAcpV1Client = {
    initialize: vi.fn(),
    inspectModelCatalog: vi.fn(),
    ensureBinding: vi.fn(),
    submitPrompt,
    requestInterrupt: vi.fn(async (input) => Object.freeze({
      kind: "interrupt_requested" as const,
      bindingHandle: input.bindingHandle,
      ...(input.attemptId ? { attemptId: input.attemptId } : {}),
      acceptance: "accepted" as const,
    })),
    respondToInteraction: vi.fn(),
    releaseBinding: vi.fn(),
    invalidateGeneration: vi.fn(),
  };
  const runtime = createAcpTaskBindingRuntime({
    profile: PROFILE,
    role: "worker",
    providerFamily: "opencode",
    acpAgentKind: "native_acp",
    generic: Object.freeze({
      bindingHandle: BINDING_HANDLE,
      client,
      report: REPORT,
      releaseBinding,
      close,
    }),
    getScopeBinding: () => undefined,
    turnObservations: new Map(),
    qualificationAttemptIds: new Set(),
    ...(reconcile ? { reconciler: Object.freeze({ reconcile }) } : {}),
    createError: (suffix) => new Error(`test_acp_${suffix}`),
    recordBusinessPromptEffect: vi.fn(),
    preparePrivateWorkingDirectory: vi.fn(async () => undefined),
    releasePrivateWorkingDirectory,
    onDiagnostic,
  });
  return {
    runtime,
    submitPrompt,
    releaseBinding,
    close,
    releasePrivateWorkingDirectory,
    onDiagnostic,
  };
}

import { describe, expect, it, vi } from "vitest";
import {
  hashDefinition,
  type ProviderSessionBootstrap,
} from "@agent-workspace/runtime-contracts";
import type {
  ProviderScopedToolCall,
  ProviderScopedToolTurnContext,
} from "@agent-workspace/provider-port";
import type { AcpV3FrozenProfileTuple } from "@agent-workspace/runtime-store";
import {
  createAcpTaskSessionRuntimeNativeBinding,
  OPENCODE_ACP_TASK_NATIVE_DRIVER,
} from "./acp-task-session-runtime-native.js";
import type {
  OpenCodeAcpTaskBindingRuntime,
  OpenCodeAcpTaskProfileAdapter,
} from "./acp-opencode-task-profile.js";
import type { AcpTaskPromptResult } from "./acp-task-profile-runtime.js";

const PROFILE: AcpV3FrozenProfileTuple = Object.freeze({
  schemaVersion: 3,
  executionProfileId: "profile_opencode_worker",
  profileRevisionId: "profile_revision_opencode_worker",
  providerFamily: "opencode",
});
const BINDING_HANDLE = "binding_handle_opencode_task_native";
const ATTEMPT_ID = "session_execution_attempt_opencode_task_native";
const RECEIPT = `sha256:${"a".repeat(64)}`;

const createOpenCodeAcpTaskSessionRuntimeNativeBinding = (options: Readonly<{
  adapter: OpenCodeAcpTaskProfileAdapter;
  runtime: OpenCodeAcpTaskBindingRuntime;
  profile: AcpV3FrozenProfileTuple;
  resolveTurnContext?: (input: Readonly<{
    sessionExecutionAttemptId: string;
  }>) => ProviderScopedToolTurnContext | undefined;
  resolvePromptBootstrap?: (input: Readonly<{
    sessionExecutionAttemptId: string;
  }>) => ProviderSessionBootstrap | undefined;
}>) => createAcpTaskSessionRuntimeNativeBinding({
  driver: OPENCODE_ACP_TASK_NATIVE_DRIVER,
  ...options,
});

describe("ACP provider-neutral Task/SR native Binding", () => {
  it("fences the exact frozen OpenCode Profile against the qualified runtime observation", () => {
    const fixture = nativeFixture({ executionProfileId: "profile_opencode_other" });

    expect(() => createOpenCodeAcpTaskSessionRuntimeNativeBinding({
      adapter: fixture.adapter,
      runtime: fixture.runtime,
      profile: PROFILE,
    })).toThrowError(expect.objectContaining({
      code: "opencode_acp_task_runtime_profile_mismatch",
    }));
    expect(fixture.runtime.submitPrompt).not.toHaveBeenCalled();
  });

  it("maps one exact Attempt and its scoped turn context to safe receipt/final/terminal observations", async () => {
    const finalContent = "One controlled OpenCode final.";
    const fixture = nativeFixture({}, settledPrompt(finalContent));
    const turnContext: ProviderScopedToolTurnContext = Object.freeze({
      capabilityClass: "runtime_orchestration",
      lease: Object.freeze({ attempt: ATTEMPT_ID }),
      async handleCall(call: ProviderScopedToolCall) {
        return Object.freeze({ providerCallId: call.providerCallId, result: { accepted: true } });
      },
    });
    const resolveTurnContext = vi.fn(() => turnContext);
    const native = createOpenCodeAcpTaskSessionRuntimeNativeBinding({
      adapter: fixture.adapter,
      runtime: fixture.runtime,
      profile: PROFILE,
      resolveTurnContext,
    });
    const signal = new AbortController().signal;

    const first = await native.submitDelivery({
      bindingHandle: BINDING_HANDLE,
      sessionExecutionAttemptId: ATTEMPT_ID,
      content: "Produce one final.",
      signal,
    });
    expect(first).toMatchObject({
      status: "settled",
      bindingHandle: BINDING_HANDLE,
      sessionExecutionAttemptId: ATTEMPT_ID,
      receiptDigest: RECEIPT,
      finalCandidate: {
        content: finalContent,
        contentDigest: hashDefinition(finalContent),
      },
      terminal: { outcome: "completed", receiptDigest: RECEIPT },
    });
    expect(first.status === "settled" && first.finalCandidate?.candidateObservationId)
      .toMatch(/^provider_fact_opencode_candidate_[a-f0-9]{64}$/u);
    expect(first.status === "settled" && first.terminal.terminalObservationId)
      .toMatch(/^provider_fact_opencode_terminal_[a-f0-9]{64}$/u);
    expect(fixture.runtime.submitPrompt).toHaveBeenCalledWith({
      attemptId: ATTEMPT_ID,
      content: "Produce one final.",
      interactionRevision: 1,
      turnContext,
    });
    expect(resolveTurnContext).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(first)).not.toMatch(/raw-session|requestId|optionId|credential|absoluteCwd/u);

    await native.reconcileAttempt({
      bindingHandle: BINDING_HANDLE,
      sessionExecutionAttemptId: ATTEMPT_ID,
      signal,
    });
    expect(resolveTurnContext).toHaveBeenCalledTimes(1);
    expect(fixture.runtime.reconcilePrompt).toHaveBeenCalledWith({ attemptId: ATTEMPT_ID });
  });

  it("renders the frozen identity bootstrap only when the durable attempt resolver admits it", async () => {
    const fixture = nativeFixture();
    const resolvePromptBootstrap = vi.fn()
      .mockReturnValueOnce(Object.freeze({
        purpose: "task_worker" as const,
        agentCardId: "agent_card_researcher",
        kind: "researcher" as const,
        title: "Evidence Researcher",
        role: "Investigate only the assigned evidence branch.",
        systemPrompt: "Return concise, sourced findings.",
        capabilityRefs: Object.freeze([]),
      }))
      .mockReturnValueOnce(undefined);
    const native = createOpenCodeAcpTaskSessionRuntimeNativeBinding({
      adapter: fixture.adapter,
      runtime: fixture.runtime,
      profile: PROFILE,
      resolvePromptBootstrap,
    });
    const signal = new AbortController().signal;

    await native.submitDelivery({
      bindingHandle: BINDING_HANDLE,
      sessionExecutionAttemptId: ATTEMPT_ID,
      content: "Check source A.",
      signal,
    });
    await native.submitDelivery({
      bindingHandle: BINDING_HANDLE,
      sessionExecutionAttemptId: "session_execution_attempt_opencode_task_native_2",
      content: "Check source B.",
      signal,
    });

    expect(fixture.runtime.submitPrompt).toHaveBeenNthCalledWith(1, expect.objectContaining({
      content: expect.stringMatching(/Evidence Researcher[\s\S]*Return concise, sourced findings\.[\s\S]*Current assignment:\nCheck source A\./u),
    }));
    expect(fixture.runtime.submitPrompt).toHaveBeenNthCalledWith(2, expect.objectContaining({
      content: "Check source B.",
    }));
    expect(resolvePromptBootstrap).toHaveBeenCalledTimes(2);
  });

  it("maps interrupt/cancel/retire/close without inventing interaction support", async () => {
    const fixture = nativeFixture();
    const native = createOpenCodeAcpTaskSessionRuntimeNativeBinding({
      adapter: fixture.adapter,
      runtime: fixture.runtime,
      profile: PROFILE,
    });
    const signal = new AbortController().signal;

    await expect(native.requestInterrupt?.({
      bindingHandle: BINDING_HANDLE,
      sessionExecutionAttemptId: ATTEMPT_ID,
      sessionControlAuditId: "session_control_opencode_task_native",
      signal,
    })).resolves.toEqual({
      status: "reconciling",
      bindingHandle: BINDING_HANDLE,
      sessionExecutionAttemptId: ATTEMPT_ID,
      reason: "provider_outcome_unknown",
    });
    await native.cancelTimedOutEffect?.({
      bindingHandle: BINDING_HANDLE,
      sessionExecutionAttemptId: ATTEMPT_ID,
      signal,
    });
    expect(fixture.runtime.requestInterrupt).toHaveBeenCalledTimes(2);
    expect(native.respondInteraction).toBeUndefined();

    await native.retire({ signal });
    await native.close({ signal });
    expect(fixture.runtime.releaseBinding).toHaveBeenCalledTimes(1);
    expect(fixture.adapter.close).toHaveBeenCalledTimes(1);
  });

  it("cancels the exact active Attempt when the common deadline aborts submit", async () => {
    const fixture = nativeFixture();
    let settlePrompt!: (value: AcpTaskPromptResult) => void;
    const pendingPrompt = new Promise<AcpTaskPromptResult>((resolve) => {
      settlePrompt = resolve;
    });
    vi.mocked(fixture.runtime.submitPrompt).mockImplementation(async () => pendingPrompt);
    vi.mocked(fixture.runtime.requestInterrupt).mockImplementation(async ({ attemptId }) => {
      expect(attemptId).toBe(ATTEMPT_ID);
      settlePrompt(Object.freeze({
        state: "reconciling",
        reason: "provider_outcome_unknown",
        resendAllowed: false,
        observations: Object.freeze([]),
      }));
      return Object.freeze({ acceptance: "accepted", completion: "unknown" });
    });
    const native = createOpenCodeAcpTaskSessionRuntimeNativeBinding({
      adapter: fixture.adapter,
      runtime: fixture.runtime,
      profile: PROFILE,
    });
    const controller = new AbortController();

    const pending = native.submitDelivery({
      bindingHandle: BINDING_HANDLE,
      sessionExecutionAttemptId: ATTEMPT_ID,
      content: "Wait for the controlled deadline.",
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(fixture.runtime.submitPrompt).toHaveBeenCalledTimes(1));
    controller.abort();

    await expect(pending).resolves.toMatchObject({
      status: "reconciling",
      sessionExecutionAttemptId: ATTEMPT_ID,
    });
    expect(fixture.runtime.requestInterrupt).toHaveBeenCalledTimes(1);
  });

  it("rejects a final candidate whose safe candidate-group count is zero", async () => {
    const valid = settledPrompt("invalid-count");
    if (valid.state !== "settled") throw new Error("controlled_settlement_missing");
    const invalid: AcpTaskPromptResult = Object.freeze({
      ...valid,
      settlement: Object.freeze({
        ...valid.settlement,
        finalCandidateGroupCount: 0,
      }),
    });
    const fixture = nativeFixture({}, invalid);
    const native = createOpenCodeAcpTaskSessionRuntimeNativeBinding({
      adapter: fixture.adapter,
      runtime: fixture.runtime,
      profile: PROFILE,
    });

    await expect(native.submitDelivery({
      bindingHandle: BINDING_HANDLE,
      sessionExecutionAttemptId: ATTEMPT_ID,
      content: "Reject malformed settlement.",
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: "opencode_acp_task_runtime_settlement_invalid" });
  });
});

function nativeFixture(
  observationOverrides: Partial<ReturnType<OpenCodeAcpTaskBindingRuntime["safeObservation"]>> = {},
  promptResult: AcpTaskPromptResult = Object.freeze({
    state: "reconciling",
    reason: "provider_outcome_unknown",
    resendAllowed: false,
    observations: Object.freeze([]),
  }),
) {
  const runtime: OpenCodeAcpTaskBindingRuntime = Object.freeze({
    bindingHandle: BINDING_HANDLE,
    role: "worker",
    report: Object.freeze({
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
    }),
    submitPrompt: vi.fn(async () => promptResult),
    reconcilePrompt: vi.fn(async () => promptResult),
    requestInterrupt: vi.fn(async () => Object.freeze({
      acceptance: "accepted" as const,
      completion: "unknown" as const,
    })),
    releaseBinding: vi.fn(async () => undefined),
    safeObservation: () => Object.freeze({
      providerFamily: "opencode" as const,
      acpAgentKind: "native_acp" as const,
      executionProfileId: PROFILE.executionProfileId,
      profileRevisionId: PROFILE.profileRevisionId,
      role: "worker" as const,
      available: true as const,
      qualificationClass: "binding_behavior" as const,
      evidenceClass: "injected_host_qualification" as const,
      ...observationOverrides,
    }),
    close: vi.fn(async () => undefined),
  });
  const adapter: OpenCodeAcpTaskProfileAdapter = Object.freeze({
    role: "worker",
    openBinding: vi.fn(),
    safeObservation: () => Object.freeze({
      role: "worker" as const,
      processOpenEffectCount: 1,
      qualificationPromptEffectCount: 1,
      businessPromptEffectCount: 0,
      readinessReused: false,
    }),
    close: vi.fn(async () => undefined),
  });
  return { adapter, runtime };
}

function settledPrompt(finalCandidate: string): AcpTaskPromptResult {
  return Object.freeze({
    state: "settled",
    settlement: Object.freeze({
      bindingHandle: BINDING_HANDLE,
      attemptId: ATTEMPT_ID,
      stopReason: "end_turn",
      receiptDigest: RECEIPT,
      finalCandidateGroupCount: 1,
      finalCandidate,
    }),
    observations: Object.freeze([]),
  });
}

import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { AcpSessionObservation } from "@agent-workspace/provider-acp";
import type { ProviderScopedToolCall } from "@agent-workspace/provider-port";
import {
  CONDUCTOR_ORCHESTRATION_TOOL_NAMES,
  hashDefinition,
  type AcpSafeSessionBindingRecordV3,
  type ExecutionProfileDefinitionV3,
  type SessionExecutionAttemptRecord,
  type SessionExecutionRuntimeRecord,
} from "@agent-workspace/runtime-contracts";
import type { AcpV3FrozenProfileTuple } from "@agent-workspace/runtime-store";
import type {
  FinalCandidateObservationInput,
  InteractionRequestedObservationInput,
  SessionExecutionMutationResult,
} from "@agent-workspace/runtime-application";
import type {
  SessionIdAcpProductionExecutionObservation,
  SessionIdAcpProductionFinalCandidateObservation,
  SessionIdAcpProductionTaskFactoryContext,
  SessionIdAcpTaskRole,
} from "./session-id-acp-production-composition.js";
import {
  createSessionIdAcpProductionPolicyOwner,
  createSessionIdAcpProductionTaskProbePolicy,
  type SessionIdAcpProductionHumanOnlyDiagnostic,
  type SessionIdAcpProductionRuntimeInvalidation,
} from "./session-id-acp-production-policy.js";

const NOW = "2026-08-12T00:00:00.000Z";
const RECEIPT = `sha256:${"1".repeat(64)}`;
const PROMPT_DIGEST = `sha256:${"2".repeat(64)}`;

const ROLE_TOOLS = Object.freeze({
  conductor: CONDUCTOR_ORCHESTRATION_TOOL_NAMES,
  publisher: Object.freeze([]),
  worker: Object.freeze([]),
  reviewer: Object.freeze([]),
} satisfies Readonly<Record<SessionIdAcpTaskRole, readonly string[]>>);

const QUALIFICATION_CALLS = Object.freeze({
  conductor: Object.freeze([
    Object.freeze({ name: "invoke_agent", arguments: Object.freeze({ agentCardId: "agent_card_qualification" }) }),
    Object.freeze({
      name: "send_to_session",
      arguments: Object.freeze({
        sessionId: "logical_session_qualification",
        payload: Object.freeze({ content: "qualification" }),
      }),
    }),
    Object.freeze({ name: "interrupt_session", arguments: Object.freeze({ sessionId: "logical_session_qualification" }) }),
    Object.freeze({ name: "close_session", arguments: Object.freeze({ sessionId: "logical_session_qualification" }) }),
  ]),
  publisher: Object.freeze([]),
  worker: Object.freeze([]),
  reviewer: Object.freeze([]),
} satisfies Readonly<Record<SessionIdAcpTaskRole, readonly Readonly<{
  name: string;
  arguments: Readonly<Record<string, unknown>>;
}>[]>>);

describe("session-id ACP production policy", () => {
  it("exports the same repository-free Codex probe policy used by the production owner", async () => {
    const direct = createSessionIdAcpProductionTaskProbePolicy();
    const owned = policyOwnerWithoutCurrentExecution().codex;
    for (const role of ["conductor", "publisher", "worker", "reviewer"] as const) {
      const profile = profileFor("codex", role);
      const directReadiness = direct.createReadinessProbe({ profile, role });
      const ownedReadiness = owned.createReadinessProbe({ profile, role });
      expect(normalizeQualificationToken(directReadiness.content))
        .toBe(normalizeQualificationToken(ownedReadiness.content));
      expect(Boolean(directReadiness.turnContext)).toBe(Boolean(ownedReadiness.turnContext));
      expect(directReadiness.additionalSteps?.length ?? 0)
        .toBe(ownedReadiness.additionalSteps?.length ?? 0);

      const directQualification = direct.createQualificationProbe(
        factoryContext("codex", role, "create"),
      );
      const ownedQualification = owned.createQualificationProbe(
        factoryContext("codex", role, "create"),
      );
      expect(normalizeQualificationToken(directQualification.content))
        .toBe(normalizeQualificationToken(ownedQualification.content));
      expect(Boolean(directQualification.turnContext)).toBe(Boolean(ownedQualification.turnContext));
      expect(directQualification.additionalSteps?.length ?? 0)
        .toBe(ownedQualification.additionalSteps?.length ?? 0);
    }
    expect(Object.keys(direct).sort()).toEqual([
      "createQualificationProbe",
      "createReadinessProbe",
    ]);
    expect(JSON.stringify(direct)).not.toContain("repository");
  });

  it("builds role-exact Codex readiness and qualification probes with simulation-only tool contexts", async () => {
    const policy = policyOwnerWithoutCurrentExecution().codex;

    for (const role of ["conductor", "publisher", "worker", "reviewer"] as const) {
      const profile = profileFor("codex", role);
      const readiness = await policy.createReadinessProbe({ profile, role });
      const qualification = await policy.createQualificationProbe(factoryContext("codex", role, "create"));

      for (const probe of [readiness, qualification]) {
        expect(probe.attemptId).toMatch(/^session_execution_attempt_codex_(readiness|qualification)_[a-f0-9]{32}$/u);
        expect(probe.interactionRevision).toBe(1);
        expect(probe.content).not.toContain("/Users/");

        if (role !== "conductor") {
          expect(probe.turnContext).toBeUndefined();
          expect(probe.content).not.toContain("workspace.write_text");
          expect(probe.content).not.toContain("invoke_agent");
          continue;
        }

        const context = probe.turnContext;
        expect(context?.capabilityClass).toBe("runtime_orchestration");
        expect(probe.content).toContain("Call invoke_agent exactly once");
        expect(probe.content).toContain("Do not simulate or describe the call");
        expect(probe.content).toContain("After it returns, reply exactly CODEX_QUALIFICATION_");
        expect(probe.content).not.toContain("agent_workspace_");
        const steps = [Object.freeze({
          attemptId: probe.attemptId,
          content: probe.content,
          interactionRevision: probe.interactionRevision,
          turnContext: probe.turnContext,
          expectedFinalCandidate: probe.qualificationExpectedFinalCandidate,
        }), ...(probe.additionalSteps ?? [])];
        expect(steps).toHaveLength(QUALIFICATION_CALLS[role].length);
        for (const [index, step] of steps.entries()) {
          expect(step.attemptId).toMatch(/^session_execution_attempt_codex_(readiness|qualification)_[a-f0-9]{32}$/u);
          expect(step.content).toContain(`Call ${QUALIFICATION_CALLS[role][index]!.name} exactly once`);
          expect(step.expectedFinalCandidate).toMatch(/^CODEX_QUALIFICATION_[a-f0-9]{32}$/u);
          expect(step.content).toContain(step.expectedFinalCandidate!);
          expect(step.turnContext).toBe(context);
        }
        expect(new Set(steps.map(({ attemptId }) => attemptId)).size).toBe(steps.length);
        expect(new Set(steps.map(({ expectedFinalCandidate }) => expectedFinalCandidate)).size)
          .toBe(steps.length);
        expect(probe.qualificationExpectedFinalCandidate).toBe(steps[0]!.expectedFinalCandidate);
        expect(Object.isFrozen(context)).toBe(true);
        expect(Object.isFrozen(context?.lease)).toBe(true);
        const first = QUALIFICATION_CALLS[role][0];
        await expect(context!.handleCall(Object.freeze({
          providerCallId: "provider_call_wrong_lease",
          name: first.name,
          arguments: first.arguments,
          lease: Object.freeze({ kind: "wrong" }),
        }))).rejects.toThrow("acp_production_qualification_lease_stale");

        for (const [index, call] of QUALIFICATION_CALLS[role].entries()) {
          const providerCallId = `provider_call_${role}_${index}`;
          const result = await context!.handleCall(Object.freeze({
            providerCallId,
            name: call.name,
            arguments: call.arguments,
            lease: context!.lease,
          } satisfies ProviderScopedToolCall));
          expect(result).toEqual(Object.freeze({
            providerCallId,
            result: Object.freeze({
              kind: "session_id_acp_qualification_simulated",
              toolName: call.name,
              qualificationToken: steps[index]!.expectedFinalCandidate,
            }),
          }));
          expect(JSON.stringify(result)).not.toContain("qualification.txt");
        }
      }
    }

    const mismatched = profileFor("codex", "worker", ["workspace.write_text"]);
    expect(() => policy.createReadinessProbe({ profile: mismatched, role: "worker" }))
      .toThrow("acp_production_codex_probe_role_policy_mismatch");
  });

  it("provides load/resume-only conservative OpenCode and Codex reconcilers that never resend", async () => {
    const policy = policyOwnerWithoutCurrentExecution();
    const { openCode, codex } = policy;
    expect(openCode.resolveReconciler(factoryContext("opencode", "worker", "create"))).toBeUndefined();
    expect(codex.resolveReconciler(factoryContext("codex", "worker", "create"))).toBeUndefined();

    const openCodeContext = factoryContext("opencode", "worker", "load");
    const openCodeReconciler = openCode.resolveReconciler(openCodeContext);
    expect(openCodeReconciler).toBeDefined();
    const observation = Object.freeze({
      kind: "delivery_receipt" as const,
      bindingHandle: openCodeContext.binding.bindingHandle,
      attemptId: "session_execution_attempt_recovery",
      receiptDigest: RECEIPT,
    });
    const openCodeResult = await openCodeReconciler!.reconcile(Object.freeze({
      bindingHandle: openCodeContext.binding.bindingHandle,
      attemptId: observation.attemptId,
      knownObservations: Object.freeze([observation]),
    }));
    expect(openCodeResult).toEqual(Object.freeze({
      state: "reconciling",
      reason: "provider_outcome_unknown",
      resendAllowed: false,
      observations: Object.freeze([observation]),
    }));
    expect(Object.isFrozen(openCodeResult)).toBe(true);
    expect(Object.isFrozen(openCodeResult.observations)).toBe(true);
    expect(Object.isFrozen(openCodeResult.observations[0])).toBe(true);
    await expect(openCodeReconciler!.reconcile(Object.freeze({
      bindingHandle: "binding_handle_other",
      attemptId: observation.attemptId,
      knownObservations: Object.freeze([]),
    }))).rejects.toThrow("acp_production_reconciler_scope_mismatch");

    const codexContext = factoryContext("codex", "reviewer", "resume");
    const codexReconciler = codex.resolveReconciler(codexContext);
    expect(codexReconciler).toBeDefined();
    const attemptId = "session_execution_attempt_recovery";
    const codexResult = await codexReconciler!.reconcile(Object.freeze({
      bindingHandle: codexContext.binding.bindingHandle,
      attemptId,
      knownObservations: Object.freeze([]),
    }));
    expect(codexResult).toEqual({
      state: "reconciling",
      reason: "provider_outcome_unknown",
      resendAllowed: false,
      observations: [],
    });
    expect(Object.isFrozen(codexResult)).toBe(true);
    await expect(codexReconciler!.reconcile(Object.freeze({
      bindingHandle: "binding_handle_other",
      attemptId: "session_execution_attempt_other",
      knownObservations: Object.freeze([]),
    }))).rejects.toThrow("acp_production_reconciler_scope_mismatch");
  });

  it("routes interaction_requested through only the named SR owner handler after every current fence", async () => {
    const fixture = observationFixture();
    await fixture.policy.observeExecution(fixture.observation(Object.freeze({
      kind: "interaction_requested",
      bindingHandle: fixture.binding.bindingHandle,
      attemptId: fixture.attempt.sessionExecutionAttemptId,
      interactionId: "interaction_permission",
      toolCallHandle: "tool_handle_private_mapping",
      promptDigest: PROMPT_DIGEST,
      choices: Object.freeze([
        Object.freeze({ choiceId: "choice_allow", name: "Allow once", kind: "allow_once" }),
        Object.freeze({ choiceId: "choice_reject", name: "Reject", kind: "reject_once" }),
      ]),
    })));

    expect(fixture.handleInteractionRequested).toHaveBeenCalledTimes(1);
    expect(fixture.handleInteractionRequested).toHaveBeenCalledWith(Object.freeze({
      sessionExecutionAttemptId: fixture.attempt.sessionExecutionAttemptId,
      expectedAttemptRevision: fixture.attempt.revision,
      logicalSessionId: fixture.binding.logicalSessionId,
      bindingId: fixture.binding.bindingId,
      bindingRevision: fixture.binding.revision,
      executionProfileId: fixture.binding.executionProfileId,
      profileRevisionId: fixture.binding.profileRevisionId,
      interactionId: "interaction_permission",
      promptDigest: PROMPT_DIGEST,
      choices: Object.freeze([
        Object.freeze({ choiceId: "choice_allow", label: "Allow once" }),
        Object.freeze({ choiceId: "choice_reject", label: "Reject" }),
      ]),
    }));
    expect(JSON.stringify(fixture.handleInteractionRequested.mock.calls[0]?.[0]))
      .not.toContain("tool_handle_private_mapping");
    expect(fixture.onHumanOnlyDiagnostic).not.toHaveBeenCalled();
    expect(fixture.onRuntimeInvalidation).toHaveBeenCalledWith(Object.freeze({
      reason: "session_execution_changed",
      taskId: fixture.binding.taskId,
      runId: fixture.binding.runId,
      logicalSessionId: fixture.binding.logicalSessionId,
    }));
  });

  it("rejects Binding, Attempt, active-runtime, and frozen-Profile drift before any owner or projection effect", async () => {
    const cases = [
      Object.freeze({
        label: "current Binding",
        overrides: Object.freeze({
          currentBinding: Object.freeze({ ...bindingRecord(), revision: 2 }),
        }),
      }),
      Object.freeze({
        label: "Attempt Profile",
        overrides: Object.freeze({
          attempt: Object.freeze({ ...attemptRecord(), profileRevisionId: "profile_revision_drift" }),
        }),
      }),
      Object.freeze({
        label: "active runtime Attempt",
        overrides: Object.freeze({
          runtime: Object.freeze({
            ...runtimeRecord(),
            activeAttemptId: "session_execution_attempt_other",
          }),
        }),
      }),
      Object.freeze({
        label: "frozen Profile",
        overrides: Object.freeze({
          frozenProfile: Object.freeze({
            ...frozenProfileTuple(),
            profileRevisionId: "profile_revision_drift",
          }),
        }),
      }),
    ];

    for (const testCase of cases) {
      const fixture = observationFixture(testCase.overrides);
      await expect(fixture.policy.observeExecution(fixture.observation(Object.freeze({
        kind: "interaction_requested",
        bindingHandle: fixture.binding.bindingHandle,
        attemptId: fixture.attempt.sessionExecutionAttemptId,
        interactionId: "interaction_permission",
        toolCallHandle: "tool_handle_private_mapping",
        promptDigest: PROMPT_DIGEST,
        choices: Object.freeze([
          Object.freeze({ choiceId: "choice_allow", name: "Allow", kind: "allow_once" }),
        ]),
      })))).rejects.toThrow("acp_production_execution_observation_fence_stale");
      expect(fixture.handleInteractionRequested, testCase.label).not.toHaveBeenCalled();
      expect(fixture.onHumanOnlyDiagnostic, testCase.label).not.toHaveBeenCalled();
      expect(fixture.onRuntimeInvalidation, testCase.label).not.toHaveBeenCalled();
    }
  });

  it("projects only bounded human diagnostics for chunks/tool status and excludes raw correlation handles", async () => {
    const fixture = observationFixture();
    await fixture.policy.observeExecution(fixture.observation(Object.freeze({
      kind: "agent_message_chunk",
      bindingHandle: fixture.binding.bindingHandle,
      attemptId: fixture.attempt.sessionExecutionAttemptId,
      text: "Safe progress",
    })));
    await fixture.policy.observeExecution(fixture.observation(Object.freeze({
      kind: "agent_thought_chunk",
      bindingHandle: fixture.binding.bindingHandle,
      attemptId: fixture.attempt.sessionExecutionAttemptId,
      text: "Compare the persisted evidence before answering.",
    })));
    await fixture.policy.observeExecution(fixture.observation(Object.freeze({
      kind: "tool_status",
      bindingHandle: fixture.binding.bindingHandle,
      attemptId: fixture.attempt.sessionExecutionAttemptId,
      toolCallHandle: "tool_handle_host_private_correlation",
      title: "Reading repository",
      status: "in_progress",
    })));

    expect(fixture.onHumanOnlyDiagnostic.mock.calls.map(([value]) => value)).toEqual([
      Object.freeze({
        kind: "agent_message_chunk",
        taskId: fixture.binding.taskId,
        runId: fixture.binding.runId,
        logicalSessionId: fixture.binding.logicalSessionId,
        sessionExecutionAttemptId: fixture.attempt.sessionExecutionAttemptId,
        role: "worker",
        text: "Safe progress",
      }),
      Object.freeze({
        kind: "agent_thought_chunk",
        taskId: fixture.binding.taskId,
        runId: fixture.binding.runId,
        logicalSessionId: fixture.binding.logicalSessionId,
        sessionExecutionAttemptId: fixture.attempt.sessionExecutionAttemptId,
        role: "worker",
        text: "Compare the persisted evidence before answering.",
      }),
      Object.freeze({
        kind: "tool_status",
        taskId: fixture.binding.taskId,
        runId: fixture.binding.runId,
        logicalSessionId: fixture.binding.logicalSessionId,
        sessionExecutionAttemptId: fixture.attempt.sessionExecutionAttemptId,
        activityKey: "activity_key_1a015522f2ef0348629c18bbe65cd4440b3145b53650a51b7551078fd1466db5",
        role: "worker",
        title: "Reading repository",
        status: "in_progress",
      }),
    ]);
    const projected = JSON.stringify(fixture.onHumanOnlyDiagnostic.mock.calls);
    expect(projected).not.toContain(fixture.binding.bindingHandle);
    expect(projected).not.toContain("tool_handle_host_private_correlation");
    expect(projected).not.toContain("workspacePath");
    expect(fixture.handleInteractionRequested).not.toHaveBeenCalled();
    expect(fixture.onRuntimeInvalidation).toHaveBeenCalledTimes(3);
  });

  it("does not double-write receipt, final candidate, or terminal observations", async () => {
    const fixture = observationFixture();
    const commonOwned: readonly AcpSessionObservation[] = Object.freeze([
      Object.freeze({
        kind: "delivery_receipt",
        bindingHandle: fixture.binding.bindingHandle,
        attemptId: fixture.attempt.sessionExecutionAttemptId,
        receiptDigest: RECEIPT,
      }),
      Object.freeze({
        kind: "final_candidate",
        bindingHandle: fixture.binding.bindingHandle,
        attemptId: fixture.attempt.sessionExecutionAttemptId,
        text: "Final candidate",
      }),
      Object.freeze({
        kind: "prompt_terminal",
        bindingHandle: fixture.binding.bindingHandle,
        attemptId: fixture.attempt.sessionExecutionAttemptId,
        stopReason: "end_turn",
        receiptDigest: RECEIPT,
      }),
    ]);

    for (const observation of commonOwned) {
      await expect(fixture.policy.observeExecution(fixture.observation(observation)))
        .resolves.toBeUndefined();
    }
    expect(fixture.handleInteractionRequested).not.toHaveBeenCalled();
    expect(fixture.onHumanOnlyDiagnostic).not.toHaveBeenCalled();
    expect(fixture.onRuntimeInvalidation).not.toHaveBeenCalled();
  });

  it("durably records an exact current final candidate with the native provider-fact identity", async () => {
    for (const providerFamily of ["opencode", "codex"] as const) {
      const fixture = observationFixture({ providerFamily });
      const text = `Canonical ${providerFamily} candidate`;
      await expect(fixture.policy.observeFinalCandidate(fixture.finalObservation(Object.freeze({
        kind: "final_candidate" as const,
        bindingHandle: fixture.binding.bindingHandle,
        attemptId: fixture.attempt.sessionExecutionAttemptId,
        text,
      })))).resolves.toBeUndefined();

      expect(fixture.handleFinalCandidate).toHaveBeenCalledWith(Object.freeze({
        sessionExecutionAttemptId: fixture.attempt.sessionExecutionAttemptId,
        expectedAttemptRevision: fixture.attempt.revision,
        logicalSessionId: fixture.binding.logicalSessionId,
        bindingId: fixture.binding.bindingId,
        bindingRevision: fixture.binding.revision,
        executionProfileId: fixture.binding.executionProfileId,
        profileRevisionId: fixture.binding.profileRevisionId,
        candidateObservationId: nativeCandidateObservationId(
          providerFamily,
          fixture.attempt.sessionExecutionAttemptId,
        ),
        content: text,
        contentDigest: hashDefinition(text),
      }));
      expect(fixture.onRuntimeInvalidation).toHaveBeenCalledWith(Object.freeze({
        reason: "session_execution_changed",
        taskId: fixture.binding.taskId,
        runId: fixture.binding.runId,
        logicalSessionId: fixture.binding.logicalSessionId,
      }));
      expect(fixture.onHumanOnlyDiagnostic).not.toHaveBeenCalled();
    }
  });

  it("rejects stale and cross-attempt final candidates before the canonical writer", async () => {
    const fixture = observationFixture({
      currentBinding: Object.freeze({ ...bindingRecord(), revision: 2 }),
    });
    await expect(fixture.policy.observeFinalCandidate(fixture.finalObservation(Object.freeze({
      kind: "final_candidate" as const,
      bindingHandle: fixture.binding.bindingHandle,
      attemptId: fixture.attempt.sessionExecutionAttemptId,
      text: "Must not persist",
    })))).rejects.toThrow("acp_production_execution_observation_fence_stale");
    expect(fixture.handleFinalCandidate).not.toHaveBeenCalled();
    expect(fixture.onRuntimeInvalidation).not.toHaveBeenCalled();
  });
});

function normalizeQualificationToken(value: string): string {
  return value.replace(/CODEX_QUALIFICATION_[a-f0-9]{32}/gu, "CODEX_QUALIFICATION_TOKEN");
}

function profileFor(
  family: "opencode" | "codex",
  role: SessionIdAcpTaskRole,
  allowedTools: readonly string[] = ROLE_TOOLS[role],
): ExecutionProfileDefinitionV3 {
  return Object.freeze({
    executionProfileId: "profile_primary",
    profileRevisionId: "profile_revision_primary",
    providerFamily: family,
    acpAgentKind: family === "opencode" ? "native_acp" : "codex_acp",
    protocolMajor: 1,
    model: "model-primary",
    configIntent: Object.freeze({}),
    requiredExtensions: Object.freeze([]),
    capabilityPolicy: Object.freeze({
      requiredCapabilities: Object.freeze([
        "create_binding",
        "resume_binding",
        "input_correlation",
        "provider_receipt",
        "reconcile",
        "interrupt",
      ] as const),
      allowedTools: Object.freeze([...allowedTools]),
      permissionMode: "ask",
      maxConcurrentTurns: 1,
      maxNativeChildren: role === "conductor" ? 4 : 0,
    }),
  });
}

function factoryContext(
  family: "opencode" | "codex",
  role: SessionIdAcpTaskRole,
  bindingDisposition: "create" | "load" | "resume",
): SessionIdAcpProductionTaskFactoryContext {
  const profile = profileFor(family, role);
  const binding = bindingRecord(family);
  return Object.freeze({
    binding,
    frozenProfile: Object.freeze({
      schemaVersion: 3,
      executionProfileId: profile.executionProfileId,
      profileRevisionId: profile.profileRevisionId,
      providerFamily: profile.providerFamily,
    }),
    profile,
    role,
    bindingDisposition,
    hostScope: Object.freeze({
      authorizedWorkspaceDirectory: "/host-only/not-used-by-policy",
      privateRootAuthority: Object.freeze({
        toJSON: () => Object.freeze({ kind: "acp_task_private_root_authority" as const }),
      }),
    }),
  });
}

type ObservationFixtureOverrides = Readonly<{
  providerFamily?: "opencode" | "codex";
  currentBinding?: AcpSafeSessionBindingRecordV3;
  attempt?: SessionExecutionAttemptRecord;
  runtime?: SessionExecutionRuntimeRecord;
  frozenProfile?: AcpV3FrozenProfileTuple;
}>;

function observationFixture(overrides: ObservationFixtureOverrides = {}) {
  const providerFamily = overrides.providerFamily ?? "opencode";
  const binding = bindingRecord(providerFamily);
  const currentBinding = overrides.currentBinding ?? binding;
  const attempt = overrides.attempt ?? attemptRecord();
  const runtime = overrides.runtime ?? runtimeRecord();
  const frozenProfile = overrides.frozenProfile ?? frozenProfileTuple(providerFamily);
  const handleInteractionRequested = vi.fn((
    _input: InteractionRequestedObservationInput,
  ): SessionExecutionMutationResult => Object.freeze({ attempt }));
  const handleFinalCandidate = vi.fn((
    _input: FinalCandidateObservationInput,
  ): SessionExecutionMutationResult => Object.freeze({ attempt }));
  const onHumanOnlyDiagnostic = vi.fn(async (
    _value: SessionIdAcpProductionHumanOnlyDiagnostic,
  ) => undefined);
  const onRuntimeInvalidation = vi.fn(async (
    _value: SessionIdAcpProductionRuntimeInvalidation,
  ) => undefined);
  const policy = createSessionIdAcpProductionPolicyOwner(Object.freeze({
    bindings: Object.freeze({
      getBinding: (bindingId: string) => bindingId === binding.bindingId ? binding : undefined,
      getCurrentBinding: (logicalSessionId: string) => (
        logicalSessionId === binding.logicalSessionId ? currentBinding : undefined
      ),
    }),
    sessionRuntime: Object.freeze({
      getRuntime: (runtimeId: string) => (
        runtimeId === runtime.sessionExecutionRuntimeId ? runtime : undefined
      ),
      getRuntimeForSession: (logicalSessionId: string) => (
        logicalSessionId === binding.logicalSessionId ? runtime : undefined
      ),
      getAttempt: (attemptId: string) => (
        attemptId === attempt.sessionExecutionAttemptId ? attempt : undefined
      ),
    }),
    resolveFrozenProfile: () => frozenProfile,
    sessionRuntimeOwner: Object.freeze({ handleInteractionRequested, handleFinalCandidate }),
    onHumanOnlyDiagnostic,
    onRuntimeInvalidation,
  }));
  return Object.freeze({
    binding,
    attempt,
    runtime,
    frozenProfile,
    policy,
    handleInteractionRequested,
    handleFinalCandidate,
    onHumanOnlyDiagnostic,
    onRuntimeInvalidation,
    observation(observation: AcpSessionObservation): SessionIdAcpProductionExecutionObservation {
      return Object.freeze({
        bindingId: binding.bindingId,
        bindingHandle: binding.bindingHandle,
        logicalSessionId: binding.logicalSessionId,
        executionProfileId: binding.executionProfileId,
        profileRevisionId: binding.profileRevisionId,
        providerFamily,
        role: "worker",
        observation,
      });
    },
    finalObservation(
      observation: Extract<AcpSessionObservation, { readonly kind: "final_candidate" }>,
    ): SessionIdAcpProductionFinalCandidateObservation {
      return Object.freeze({
        bindingId: binding.bindingId,
        bindingHandle: binding.bindingHandle,
        logicalSessionId: binding.logicalSessionId,
        executionProfileId: binding.executionProfileId,
        profileRevisionId: binding.profileRevisionId,
        providerFamily,
        role: "worker",
        observation,
      });
    },
  });
}

function policyOwnerWithoutCurrentExecution() {
  return createSessionIdAcpProductionPolicyOwner(Object.freeze({
    bindings: Object.freeze({
      getBinding: () => undefined,
      getCurrentBinding: () => undefined,
    }),
    sessionRuntime: Object.freeze({
      getRuntime: () => undefined,
      getRuntimeForSession: () => undefined,
      getAttempt: () => undefined,
    }),
    resolveFrozenProfile: () => undefined,
    sessionRuntimeOwner: Object.freeze({
      handleInteractionRequested: (_input: InteractionRequestedObservationInput): SessionExecutionMutationResult => {
        throw new Error("unexpected_interaction");
      },
      handleFinalCandidate: (_input: FinalCandidateObservationInput): SessionExecutionMutationResult => {
        throw new Error("unexpected_final_candidate");
      },
    }),
    onHumanOnlyDiagnostic: async () => undefined,
    onRuntimeInvalidation: async () => undefined,
  }));
}

function nativeCandidateObservationId(
  providerFamily: "opencode" | "codex",
  attemptId: string,
): string {
  const digest = createHash("sha256")
    .update(`agent-workspace:${providerFamily}-provider-fact\0`, "utf8")
    .update("candidate", "utf8")
    .update("\0", "utf8")
    .update(attemptId, "utf8")
    .digest("hex");
  return `provider_fact_${providerFamily}_candidate_${digest}`;
}

function bindingRecord(
  providerFamily: "opencode" | "codex" = "opencode",
): AcpSafeSessionBindingRecordV3 {
  return Object.freeze({
    schemaVersion: 3,
    bindingId: "binding_primary",
    taskId: "task_primary",
    runId: "run_primary",
    logicalSessionId: "logical_session_primary",
    agentCardId: "agent_card_worker",
    executionProfileId: "profile_primary",
    profileRevisionId: "profile_revision_primary",
    providerFamily,
    bindingHandle: "binding_handle_primary",
    status: "active",
    recoverable: true,
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
  });
}

function runtimeRecord(): SessionExecutionRuntimeRecord {
  return Object.freeze({
    sessionExecutionRuntimeId: "session_execution_runtime_primary",
    taskId: "task_primary",
    runId: "run_primary",
    logicalSessionId: "logical_session_primary",
    state: "executing",
    activeAttemptId: "session_execution_attempt_primary",
    revision: 2,
    createdAt: NOW,
    updatedAt: NOW,
  });
}

function attemptRecord(): SessionExecutionAttemptRecord {
  return Object.freeze({
    sessionExecutionAttemptId: "session_execution_attempt_primary",
    sessionExecutionRuntimeId: "session_execution_runtime_primary",
    taskId: "task_primary",
    runId: "run_primary",
    logicalSessionId: "logical_session_primary",
    bindingId: "binding_primary",
    bindingRevision: 1,
    executionProfileId: "profile_primary",
    profileRevisionId: "profile_revision_primary",
    inputSubmissionId: "input_primary",
    orchestrationSessionTurnId: "session_turn_primary",
    state: "active",
    interactions: Object.freeze([]),
    revision: 3,
    createdAt: NOW,
    updatedAt: NOW,
  });
}

function frozenProfileTuple(
  providerFamily: "opencode" | "codex" = "opencode",
): AcpV3FrozenProfileTuple {
  return Object.freeze({
    schemaVersion: 3,
    executionProfileId: "profile_primary",
    profileRevisionId: "profile_revision_primary",
    providerFamily,
  });
}

import { generateKeyPairSync } from "node:crypto";
import { chmodSync, lstatSync, mkdtempSync, rmSync } from "node:fs";
import { chmod, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AcpSessionObservation } from "@agent-workspace/provider-acp";
import type { ProviderScopedToolTurnContext } from "@agent-workspace/provider-port";
import type {
  AcpSafeSessionBindingRecordV3,
  ExecutionProfileDefinitionV3,
  MetaProfileDefinitionV3,
} from "@agent-workspace/runtime-contracts";
import type { SessionExecutionRuntimeOwner } from "@agent-workspace/runtime-application";
import type {
  AcpSessionRuntimeRepositories,
  AcpV3FrozenProfileTuple,
} from "@agent-workspace/runtime-store";
import {
  createAcpRuntimeHostPrivateAuthority,
  type AcpRuntimeHostPrivateAuthority,
} from "./acp-runtime-host-private-authority.js";
import { claimAcpPrivateBindingPresenceAuthority } from "./acp-private-binding-map.js";
import type { AcpTaskSessionRuntimeNativeBinding } from "./acp-task-session-runtime-provider.js";
import type {
  AcpProviderAvailabilityReport,
  AcpProviderComposition,
  AcpQualifiedBindingRuntime,
} from "./acp-provider-composition.js";
import {
  createAcpProductionHostInputs,
  parseAcpProductionConfiguration,
} from "./acp-production-configuration.js";
import {
  SessionIdAcpProductionCompositionError,
  createCodexAcpProductionTaskNativeFactory,
  createOpenCodeAcpProductionTaskNativeFactory,
  createSessionIdAcpTaskBindingDispositionAuthority,
  createSessionIdAcpProductionComposition,
  type SessionIdAcpProductionCodexFactoryOptions,
  type SessionIdAcpProductionExecutionObservation,
  type SessionIdAcpProductionOpenCodeFactoryOptions,
  type SessionIdAcpTaskBindingDisposition,
  type SessionIdAcpTaskHostExecutionScope,
  type SessionIdAcpProductionTaskNativeFactory,
} from "./session-id-acp-production-composition.js";
import type {
  OpenCodeAcpTaskBindingRuntime,
  OpenCodeAcpTaskProfileAdapter,
} from "./acp-opencode-task-profile.js";
import type {
  CodexAcpTaskBindingRuntime,
  CodexAcpTaskProfileAdapter,
} from "./acp-codex-task-profile.js";

const NOW = "2026-08-12T00:00:00.000Z";
const authorityRoots: string[] = [];
let authorityEpoch = 0;

afterEach(() => {
  for (const root of authorityRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});
const REQUIRED_CAPABILITIES = Object.freeze([
  "create_binding",
  "resume_binding",
  "input_correlation",
  "provider_receipt",
  "reconcile",
  "interrupt",
] as const);

type OpenCodeAdapterConstruction = Parameters<
  NonNullable<SessionIdAcpProductionOpenCodeFactoryOptions["controlledCreateAdapter"]>
>[0];
type CodexControlled = NonNullable<SessionIdAcpProductionCodexFactoryOptions["controlled"]>;
type CodexAdapterConstruction = Parameters<NonNullable<CodexControlled["createAdapter"]>>[0];

const OPENCODE_PROFILE: ExecutionProfileDefinitionV3 = Object.freeze({
  executionProfileId: "profile_opencode-worker",
  profileRevisionId: "profile_revision_opencode-worker-v1",
  providerFamily: "opencode",
  acpAgentKind: "native_acp",
  protocolMajor: 1,
  model: "opencode/current-worker",
  configIntent: Object.freeze({}),
  requiredExtensions: Object.freeze([]),
  capabilityPolicy: Object.freeze({
    requiredCapabilities: REQUIRED_CAPABILITIES,
    allowedTools: Object.freeze([]),
    permissionMode: "deny",
    maxConcurrentTurns: 1,
    maxNativeChildren: 0,
  }),
});

const CODEX_PROFILE: ExecutionProfileDefinitionV3 = Object.freeze({
  executionProfileId: "profile_codex-conductor",
  profileRevisionId: "profile_revision_codex-conductor-v1",
  providerFamily: "codex",
  acpAgentKind: "codex_acp",
  protocolMajor: 1,
  model: "openai/current-conductor",
  configIntent: Object.freeze({ reasoningEffort: "high" }),
  requiredExtensions: Object.freeze([]),
  capabilityPolicy: Object.freeze({
    requiredCapabilities: REQUIRED_CAPABILITIES,
    allowedTools: Object.freeze([
      "invoke_agent",
      "send_to_session",
      "interrupt_session",
      "close_session",
    ]),
    permissionMode: "deny",
    maxConcurrentTurns: 1,
    maxNativeChildren: 0,
  }),
});

const META_PROFILE: MetaProfileDefinitionV3 = Object.freeze({
  metaProfileId: "meta_profile_codex-production",
  profileRevisionId: "profile_revision_meta-codex-production-v1",
  providerFamily: "codex",
  acpAgentKind: "codex_acp",
  protocolMajor: 1,
  role: "meta",
  model: "openai/current-meta",
  configIntent: Object.freeze({ reasoningEffort: "high" }),
  requiredExtensions: Object.freeze([]),
  capabilityPolicy: Object.freeze({
    requiredCapabilities: REQUIRED_CAPABILITIES,
    allowedTools: Object.freeze([]),
    permissionMode: "deny",
    maxConcurrentTurns: 1,
    maxNativeChildren: 0,
  }),
});

describe("Session-ID ACP production composition", () => {
  it("does not register custom authorities and rejects reconstructed release capabilities", async () => {
    const fixture = compositionFixture({
      factories: {
        opencode: factory("opencode", async () => ({
          available: true,
          nativeBinding: inertNative("binding_handle_custom_release_forbidden"),
        })),
      },
      createMetaOwner: () => ({
        status: "configured",
        owner: Object.freeze({ async close() {} }),
      }),
    });

    const summaries = fixture.composition.nativeReleaseObservations.list();
    expect(summaries).toEqual([]);
    expect(fixture.composition.nativeReleaseObservations.listCheckpointFacts()).toEqual([]);
    expect(Object.isFrozen(summaries)).toBe(true);
    expect(JSON.stringify(fixture.composition)).not.toContain("nativeReleaseObservations");
    expect(() => fixture.composition.nativeReleaseObservations.claim({
      capability: Object.freeze({}) as never,
      expectedScope: Object.freeze({}) as never,
    })).toThrowError(expect.objectContaining({
      code: "acp_production_native_release_capability_unrecognized",
    }));
    expect(() => fixture.composition.nativeReleaseObservations.claimCheckpointFact({
      capability: Object.freeze({}) as never,
      expectedScope: Object.freeze({}) as never,
    })).toThrowError(expect.objectContaining({
      code: "acp_production_native_checkpoint_capability_unrecognized",
    }));
    await fixture.composition.close();
  });

  it("requires Host-owned task-stop, close, and confirmed-dead retirement authorities", () => {
    expect(() => compositionFixture({ omitRetirementAuthorities: true }))
      .toThrowError("acp_production_composition_options_invalid");
  });

  it("routes exact v3 Profile + role + current Binding without a provider fallback", async () => {
    const opened: string[] = [];
    const observations: unknown[] = [];
    const receiptOrder: string[] = [];
    const bindingReadyEvents: string[] = [];
    const diagnostics: Array<Readonly<{ code: string; role?: string; stage: string }>> = [];
    let openCodeInput: Parameters<SessionIdAcpProductionTaskNativeFactory["open"]>[0] | undefined;
    let codexInput: Parameters<SessionIdAcpProductionTaskNativeFactory["open"]>[0] | undefined;
    const openCode = factory("opencode", async (input) => {
      opened.push("opencode");
      openCodeInput = input;
      return {
        available: true,
        nativeBinding: observationNative(input.onObservation, input.binding.bindingHandle),
      };
    });
    const codex = factory("codex", async (input) => {
      opened.push("codex");
      codexInput = input;
      return {
        available: true,
        nativeBinding: observationNative(input.onObservation, input.binding.bindingHandle),
      };
    });
    const fixture = compositionFixture({
      factories: { opencode: openCode, codex },
      observeExecution: async (observation) => {
        receiptOrder.push("host-observation");
        observations.push(observation);
      },
      onBindingReady: async (event) => {
        bindingReadyEvents.push(`${event.bindingHandle}:ready`);
      },
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });
    expect(fixture.composition.nativeReleaseObservations.list()).toEqual([]);

    expect(fixture.composition.inspectTaskProfile(OPENCODE_PROFILE, "worker")).toEqual({
      status: "configured",
      providerFamily: "opencode",
      executionProfileId: OPENCODE_PROFILE.executionProfileId,
      profileRevisionId: OPENCODE_PROFILE.profileRevisionId,
      role: "worker",
    });
    expect(fixture.composition.inspectTaskProfile(CODEX_PROFILE, "conductor")).toEqual({
      status: "configured",
      providerFamily: "codex",
      executionProfileId: CODEX_PROFILE.executionProfileId,
      profileRevisionId: CODEX_PROFILE.profileRevisionId,
      role: "conductor",
    });

    const openCodeBinding = binding(OPENCODE_PROFILE, "binding_handle_opencode_worker");
    const codexBinding = binding(CODEX_PROFILE, "binding_handle_codex_conductor");
    const openedOpenCode = await fixture.composition.taskNativeBindings.open({
      binding: openCodeBinding,
      frozenProfile: frozen(OPENCODE_PROFILE),
      profile: OPENCODE_PROFILE,
      role: "worker",
      hostScope: hostScope(OPENCODE_PROFILE, openCodeBinding, fixture.authority),
      signal: new AbortController().signal,
      observeDeliveryReceipt: async () => { receiptOrder.push("sr-or-receipt"); },
    });
    const openedCodex = await fixture.composition.taskNativeBindings.open({
      binding: codexBinding,
      frozenProfile: frozen(CODEX_PROFILE),
      profile: CODEX_PROFILE,
      role: "conductor",
      hostScope: hostScope(CODEX_PROFILE, codexBinding, fixture.authority),
      signal: new AbortController().signal,
      observeDeliveryReceipt: async () => undefined,
    });

    expect(openedOpenCode.available).toBe(true);
    expect(openedCodex.available).toBe(true);
    expect(bindingReadyEvents).toEqual([
      "binding_handle_opencode_worker:ready",
      "binding_handle_codex_conductor:ready",
    ]);
    expect(diagnostics).toEqual(expect.arrayContaining([
      {
        code: "acp_task_native_readiness_started",
        role: "worker",
        stage: "native_readiness",
      },
      {
        code: "acp_task_native_factory_open_available",
        role: "conductor",
        stage: "native_factory_open",
      },
      {
        code: "acp_task_binding_ready_published",
        role: "conductor",
        stage: "binding_ready",
      },
    ]));
    expect(opened).toEqual(["opencode", "codex"]);
    expect(openCodeInput?.hostInputs).toEqual({
      commandReference: "/private/install/opencode",
      executableSearchPath: "/private/bin:/usr/bin:/bin",
      authFile: "/private/auth/opencode.json",
    });
    expect(codexInput?.hostInputs).toEqual({
      wrapperCommandReference: "/private/install/codex-acp",
      codexCommandReference: "/private/install/codex",
      nodeCommandReference: "/private/install/node",
      executableSearchPath: "/private/bin:/usr/bin:/bin",
      authFile: "/private/auth/codex.json",
    });
    expect(openCodeInput?.identityVaultResolver).toBe(fixture.authority.taskIdentityVaults);
    expect(codexInput?.identityVaultResolver).toBe(fixture.authority.taskIdentityVaults);
    expect(openCodeInput?.identityVaultResolver).not.toBe(fixture.authority.metaIdentityVaults);

    if (!openedOpenCode.available) throw new Error("expected OpenCode native Binding");
    await openedOpenCode.nativeBinding.submitDelivery({
      bindingHandle: openCodeBinding.bindingHandle,
      sessionExecutionAttemptId: "session_execution_attempt_observation_1",
      content: "controlled",
      signal: new AbortController().signal,
    });
    expect(observations).toEqual([{
      bindingId: openCodeBinding.bindingId,
      bindingHandle: openCodeBinding.bindingHandle,
      logicalSessionId: openCodeBinding.logicalSessionId,
      executionProfileId: OPENCODE_PROFILE.executionProfileId,
      profileRevisionId: OPENCODE_PROFILE.profileRevisionId,
      providerFamily: "opencode",
      role: "worker",
      observation: {
        kind: "delivery_receipt",
        bindingHandle: openCodeBinding.bindingHandle,
        attemptId: "session_execution_attempt_observation_1",
        receiptDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
    }]);
    expect(receiptOrder).toEqual(["sr-or-receipt", "host-observation"]);
    expect(JSON.stringify(fixture.composition)).toBe(
      '{"kind":"session_id_acp_production_composition","taskProviders":["codex","opencode"],"meta":"configured"}',
    );
    expect(JSON.stringify(fixture.composition)).not.toContain("/private/");

    await fixture.composition.close();
  });

  it("awaits the required durable final-candidate owner before forwarding the observation", async () => {
    const effects: string[] = [];
    const currentBinding = binding(
      OPENCODE_PROFILE,
      "binding_handle_durable_final_candidate",
    );
    const fixture = compositionFixture({
      factories: {
        opencode: factory("opencode", async (input) => ({
          available: true,
          nativeBinding: Object.freeze({
            bindingHandle: currentBinding.bindingHandle,
            async submitDelivery(delivery: Parameters<
              AcpTaskSessionRuntimeNativeBinding["submitDelivery"]
            >[0]) {
              await input.onObservation({
                kind: "final_candidate",
                bindingHandle: delivery.bindingHandle,
                attemptId: delivery.sessionExecutionAttemptId,
                text: "candidate persisted only by the SR owner",
              });
              effects.push("native:after-observer");
              return Object.freeze({
                status: "reconciling" as const,
                bindingHandle: delivery.bindingHandle,
                sessionExecutionAttemptId: delivery.sessionExecutionAttemptId,
                reason: "provider_outcome_unknown" as const,
              });
            },
            async reconcileAttempt(delivery: Parameters<
              AcpTaskSessionRuntimeNativeBinding["reconcileAttempt"]
            >[0]) {
              return Object.freeze({
                status: "reconciling" as const,
                bindingHandle: delivery.bindingHandle,
                sessionExecutionAttemptId: delivery.sessionExecutionAttemptId,
                reason: "provider_outcome_unknown" as const,
              });
            },
            async retire() {},
            async close() {},
          }),
        })),
      },
      async observeFinalCandidate(observation) {
        effects.push("sr-final:start");
        await Promise.resolve();
        expect(observation.observation.text).toBe(
          "candidate persisted only by the SR owner",
        );
        effects.push("sr-final:committed");
      },
      observeExecution(observation) {
        effects.push(`host:${observation.observation.kind}`);
      },
    });
    const opened = await fixture.composition.taskNativeBindings.open({
      binding: currentBinding,
      frozenProfile: frozen(OPENCODE_PROFILE),
      profile: OPENCODE_PROFILE,
      role: "worker",
      hostScope: hostScope(OPENCODE_PROFILE, currentBinding, fixture.authority),
      signal: new AbortController().signal,
      observeDeliveryReceipt: async () => undefined,
    });
    if (!opened.available) throw new Error(opened.code);
    await opened.nativeBinding.submitDelivery({
      bindingHandle: currentBinding.bindingHandle,
      sessionExecutionAttemptId: "session_execution_attempt_durable_final",
      content: "private prompt",
      signal: new AbortController().signal,
    });
    expect(effects).toEqual([
      "sr-final:start",
      "sr-final:committed",
      "host:final_candidate",
      "native:after-observer",
    ]);
    expect(fixture.composition.nativeReleaseObservations.list()).toEqual([]);
    await fixture.composition.close();
  });

  it("fails a target final closed when the durable final-candidate owner rejects", async () => {
    let observe: ((observation: AcpSessionObservation) => void | Promise<void>) | undefined;
    const forwarded = vi.fn();
    const currentBinding = binding(
      OPENCODE_PROFILE,
      "binding_handle_rejected_final_candidate",
    );
    const fixture = compositionFixture({
      factories: {
        opencode: factory("opencode", async (input) => {
          observe = input.onObservation;
          return {
            available: true,
            nativeBinding: inertNative(currentBinding.bindingHandle),
          };
        }),
      },
      observeFinalCandidate() {
        throw new Error("durable SR final commit failed");
      },
      observeExecution: forwarded,
    });
    const opened = await fixture.composition.taskNativeBindings.open({
      binding: currentBinding,
      frozenProfile: frozen(OPENCODE_PROFILE),
      profile: OPENCODE_PROFILE,
      role: "worker",
      hostScope: hostScope(OPENCODE_PROFILE, currentBinding, fixture.authority),
      signal: new AbortController().signal,
      observeDeliveryReceipt: async () => undefined,
    });
    expect(opened).toMatchObject({ available: true });
    if (!observe) throw new Error("expected production observation callback");
    await expect(observe({
      kind: "final_candidate",
      bindingHandle: currentBinding.bindingHandle,
      attemptId: "session_execution_attempt_rejected_final",
      text: "must not be forwarded",
    })).rejects.toThrow("durable SR final commit failed");
    expect(forwarded).not.toHaveBeenCalled();
    expect(fixture.composition.nativeReleaseObservations.list()).toEqual([]);
    await fixture.composition.close();
  });

  it("keeps Task readiness reads pure and requires a fresh force probe before open", async () => {
    const readinessEffects: string[] = [];
    const open = vi.fn(async () => ({
      available: true as const,
      nativeBinding: inertNative("binding_handle_readiness_force_open"),
    }));
    let available = false;
    const checkReadiness = vi.fn(async (input: Parameters<
      SessionIdAcpProductionTaskNativeFactory["checkReadiness"]
    >[0]) => {
      readinessEffects.push(`${input.profile.profileRevisionId}:${input.role}`);
      const report = availableReport(input.profile, input.role);
      return available ? report : Object.freeze({
        ...report,
        available: false,
        protocolMajor: null,
        capabilities: Object.freeze([]),
        extensions: Object.freeze([]),
        unavailableReasons: Object.freeze(["acp_controlled_probe_unavailable"]),
      });
    });
    const fixture = compositionFixture({
      factories: {
        opencode: factory(
          "opencode",
          open,
          async () => undefined,
          checkReadiness,
        ),
      },
    });

    const initial = fixture.composition.readTaskProfileReadiness(OPENCODE_PROFILE, "worker");
    expect(initial).toMatchObject({ status: "checking", reasons: ["probe_pending"] });
    expect(checkReadiness).not.toHaveBeenCalled();
    await expect(fixture.composition.checkTaskProfileReadiness(
      OPENCODE_PROFILE,
      "worker",
      { force: false },
    )).resolves.toEqual(initial);
    expect(checkReadiness).not.toHaveBeenCalled();

    const unavailable = await fixture.composition.checkTaskProfileReadiness(
      OPENCODE_PROFILE,
      "worker",
      { force: true },
    );
    expect(unavailable).toMatchObject({
      status: "unavailable",
      reasons: ["acp_controlled_probe_unavailable"],
    });
    expect(fixture.composition.inspectTaskProfile(OPENCODE_PROFILE, "worker").status)
      .toBe("configured");
    expect(open).not.toHaveBeenCalled();

    available = true;
    const checked = await fixture.composition.checkTaskProfileReadiness(
      OPENCODE_PROFILE,
      "worker",
      { force: true },
    );
    expect(checked.status).toBe("available");
    expect(fixture.composition.readTaskProfileReadiness(OPENCODE_PROFILE, "worker"))
      .toEqual(checked);
    expect(checkReadiness).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(checked)).not.toContain("/private/");
    expect(JSON.stringify(checked)).not.toContain("sha256:");
    expect(JSON.stringify(checked)).not.toContain("raw-session");

    const changedIntent = Object.freeze({
      ...OPENCODE_PROFILE,
      configIntent: Object.freeze({ mode: "strict" }),
    });
    expect(fixture.composition.readTaskProfileReadiness(changedIntent, "worker"))
      .toMatchObject({
        status: "unavailable",
        reasons: ["acp_task_config_intent_unsupported"],
      });
    await expect(fixture.composition.checkTaskProfileReadiness(
      changedIntent,
      "worker",
      { force: true },
    )).resolves.toMatchObject({
      status: "unavailable",
      reasons: ["acp_task_config_intent_unsupported"],
    });
    const unsupportedBinding = binding(
      changedIntent,
      "binding_handle_readiness_unsupported_config",
    );
    await expect(fixture.composition.taskNativeBindings.open({
      binding: unsupportedBinding,
      frozenProfile: frozen(changedIntent),
      profile: changedIntent,
      role: "worker",
      hostScope: hostScope(changedIntent, unsupportedBinding, fixture.authority),
      signal: new AbortController().signal,
      observeDeliveryReceipt: async () => undefined,
    })).resolves.toMatchObject({
      available: false,
      code: "acp_task_config_intent_unsupported",
    });
    expect(checkReadiness).toHaveBeenCalledTimes(2);
    expect(open).not.toHaveBeenCalled();

    const current = binding(OPENCODE_PROFILE, "binding_handle_readiness_force_open");
    await expect(fixture.composition.taskNativeBindings.open({
      binding: current,
      frozenProfile: frozen(OPENCODE_PROFILE),
      profile: OPENCODE_PROFILE,
      role: "worker",
      hostScope: hostScope(OPENCODE_PROFILE, current, fixture.authority),
      signal: new AbortController().signal,
      observeDeliveryReceipt: async () => undefined,
    })).resolves.toMatchObject({ available: true });
    expect(checkReadiness).toHaveBeenCalledTimes(3);
    expect(open).toHaveBeenCalledTimes(1);
    expect(readinessEffects).toEqual([
      `${OPENCODE_PROFILE.profileRevisionId}:worker`,
      `${OPENCODE_PROFILE.profileRevisionId}:worker`,
      `${OPENCODE_PROFILE.profileRevisionId}:worker`,
    ]);
    await fixture.composition.close();
  });

  it("awaits Binding-ready ownership after native open and cleans up before any submit on rejection", async () => {
    const effects: string[] = [];
    const current = binding(OPENCODE_PROFILE, "binding_handle_ready_rejected");
    const native: AcpTaskSessionRuntimeNativeBinding = Object.freeze({
      bindingHandle: current.bindingHandle,
      async submitDelivery(input: Parameters<
        AcpTaskSessionRuntimeNativeBinding["submitDelivery"]
      >[0]) {
        effects.push("submit");
        return {
          status: "reconciling" as const,
          bindingHandle: current.bindingHandle,
          sessionExecutionAttemptId: input.sessionExecutionAttemptId,
          reason: "provider_outcome_unknown" as const,
        };
      },
      async reconcileAttempt(input: Parameters<
        AcpTaskSessionRuntimeNativeBinding["reconcileAttempt"]
      >[0]) {
        return {
          status: "reconciling" as const,
          bindingHandle: current.bindingHandle,
          sessionExecutionAttemptId: input.sessionExecutionAttemptId,
          reason: "provider_outcome_unknown" as const,
        };
      },
      async retire() { effects.push("retire"); },
      async close() { effects.push("close"); },
    });
    const fixture = compositionFixture({
      factories: {
        opencode: factory("opencode", async () => ({ available: true, nativeBinding: native })),
      },
      async onBindingReady(event) {
        effects.push(`ready:${event.sessionExecutionRuntimeId}`);
        throw new Error("controlled lifecycle activation rejection");
      },
    });

    await expect(fixture.composition.taskNativeBindings.open({
      binding: current,
      frozenProfile: frozen(OPENCODE_PROFILE),
      profile: OPENCODE_PROFILE,
      role: "worker",
      hostScope: hostScope(OPENCODE_PROFILE, current, fixture.authority),
      signal: new AbortController().signal,
      observeDeliveryReceipt: async () => undefined,
    })).resolves.toMatchObject({
      available: false,
      code: "acp_task_binding_ready_observer_failed",
    });
    expect(effects).toEqual([
      `ready:session_execution_runtime_${current.logicalSessionId}`,
      "retire",
      "close",
    ]);
    expect(effects).not.toContain("submit");
    await fixture.composition.close();
  });

  it("returns typed unavailable for missing configuration or factory and never falls back", async () => {
    const configuredFactory = factory("opencode", vi.fn(async () => ({
      available: true as const,
      nativeBinding: inertNative("binding_handle_opencode_worker"),
    })));
    const fixture = compositionFixture({
      configuration: configuration({ includeOpenCode: false, includeCodex: true }),
      factories: { opencode: configuredFactory },
    });

    expect(fixture.composition.inspectTaskProfile(OPENCODE_PROFILE, "worker")).toEqual({
      status: "unavailable",
      providerFamily: "opencode",
      executionProfileId: OPENCODE_PROFILE.executionProfileId,
      profileRevisionId: OPENCODE_PROFILE.profileRevisionId,
      role: "worker",
      code: "acp_task_provider_not_configured",
    });
    expect(fixture.composition.inspectTaskProfile(CODEX_PROFILE, "conductor")).toEqual({
      status: "unavailable",
      providerFamily: "codex",
      executionProfileId: CODEX_PROFILE.executionProfileId,
      profileRevisionId: CODEX_PROFILE.profileRevisionId,
      role: "conductor",
      code: "acp_task_provider_factory_not_registered",
    });
    const missingBinding = binding(OPENCODE_PROFILE, "binding_handle_missing_opencode");
    await expect(fixture.composition.taskNativeBindings.open({
      binding: missingBinding,
      frozenProfile: frozen(OPENCODE_PROFILE),
      profile: OPENCODE_PROFILE,
      role: "worker",
      hostScope: hostScope(OPENCODE_PROFILE, missingBinding, fixture.authority),
      signal: new AbortController().signal,
      observeDeliveryReceipt: async () => undefined,
    })).resolves.toEqual({
      available: false,
      code: "acp_task_provider_not_configured",
      providerFamily: "opencode",
      executionProfileId: OPENCODE_PROFILE.executionProfileId,
      profileRevisionId: OPENCODE_PROFILE.profileRevisionId,
      role: "worker",
    });
    expect(configuredFactory.open).not.toHaveBeenCalled();
    await fixture.composition.close();
  });

  it("rejects stale Profile, Binding and role policy fences before any native effect", async () => {
    const open = vi.fn(async () => ({
      available: true as const,
      nativeBinding: inertNative("binding_handle_opencode_worker"),
    }));
    const fixture = compositionFixture({ factories: { opencode: factory("opencode", open) } });
    const current = binding(OPENCODE_PROFILE, "binding_handle_opencode_worker");
    const signal = new AbortController().signal;

    const invalidInputs = [
      {
        binding: current,
        frozenProfile: { ...frozen(OPENCODE_PROFILE), profileRevisionId: "profile_revision_stale" },
        profile: OPENCODE_PROFILE,
        role: "worker" as const,
        hostScope: hostScope(OPENCODE_PROFILE, current, fixture.authority),
        signal,
        observeDeliveryReceipt: async () => undefined,
      },
      {
        binding: { ...current, providerFamily: "codex" as const },
        frozenProfile: frozen(OPENCODE_PROFILE),
        profile: OPENCODE_PROFILE,
        role: "worker" as const,
        hostScope: hostScope(OPENCODE_PROFILE, current, fixture.authority),
        signal,
        observeDeliveryReceipt: async () => undefined,
      },
      {
        binding: current,
        frozenProfile: frozen(OPENCODE_PROFILE),
        profile: {
          ...OPENCODE_PROFILE,
          capabilityPolicy: {
            ...OPENCODE_PROFILE.capabilityPolicy,
            allowedTools: ["invoke_agent"],
          },
        },
        role: "worker" as const,
        hostScope: hostScope(OPENCODE_PROFILE, current, fixture.authority),
        signal,
        observeDeliveryReceipt: async () => undefined,
      },
      {
        binding: current,
        frozenProfile: frozen(OPENCODE_PROFILE),
        profile: OPENCODE_PROFILE,
        role: "worker" as const,
        hostScope: {
          ...hostScope(OPENCODE_PROFILE, current, fixture.authority),
          sessionConfiguration: { model: OPENCODE_PROFILE.model, options: [] },
        } as never,
        signal,
        observeDeliveryReceipt: async () => undefined,
      },
    ];
    for (const input of invalidInputs) {
      await expect(fixture.composition.taskNativeBindings.open(input))
        .rejects.toBeInstanceOf(SessionIdAcpProductionCompositionError);
    }
    expect(open).not.toHaveBeenCalled();
    await fixture.composition.close();
  });

  it("fails closed on foreign/forged authority or current-resolution drift before effects", async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "acp-production-authority-")));
    const workspace = path.join(root, "workspace");
    const runtimeDataRoot = path.join(root, "runtime-data");
    await Promise.all([
      mkdir(workspace, { mode: 0o700 }),
      mkdir(runtimeDataRoot, { mode: 0o700 }),
    ]);
    await chmod(runtimeDataRoot, 0o700);
    const authority = privateAuthority(undefined, runtimeDataRoot);
    const foreignAuthority = privateAuthority();
    const createAdapter = vi.fn((options: OpenCodeAdapterConstruction) => (
      controlledOpenCodeAdapter(options)
    ));
    const nativeFactory = createOpenCodeAcpProductionTaskNativeFactory({
      controlledResolveCurrent: ({ profile }) => controlledCurrentResolution(profile),
      resolveReconciler: () => Object.freeze({
        async reconcile(input) {
          return Object.freeze({
            state: "reconciling" as const,
            reason: "provider_outcome_unknown" as const,
            resendAllowed: false as const,
            observations: input.knownObservations,
          });
        },
      }),
      controlledCreateAdapter: createAdapter,
    });
    const current = binding(OPENCODE_PROFILE, "binding_handle_authority_drift");
    const hostInputs = {
      commandReference: "/private/install/opencode",
      executableSearchPath: "/private/bin:/usr/bin:/bin",
      authFile: "/private/auth/opencode.json",
    } as const;

    try {
      const correct = hostScope(OPENCODE_PROFILE, current, authority, {
        authorizedWorkspaceDirectory: workspace,
      });
      const foreignRootScope: SessionIdAcpTaskHostExecutionScope = Object.freeze({
        ...correct,
        privateRootAuthority: foreignAuthority.taskPrivateRootAuthority,
      });
      await expect(nativeFactory.open({
        binding: current,
        frozenProfile: frozen(OPENCODE_PROFILE),
        profile: OPENCODE_PROFILE,
        role: "worker",
        hostScope: foreignRootScope,
        hostInputs,
        identityVaultResolver: authority.taskIdentityVaults,
        signal: new AbortController().signal,
        onObservation: async () => undefined,
      })).resolves.toEqual({
        available: false,
        code: "acp_opencode_host_authority_unavailable",
      });
      expect(() => createSessionIdAcpTaskBindingDispositionAuthority({
        identityVaultResolver: authority.taskIdentityVaults,
        binding: current,
        presenceAuthority: authority.taskIdentityVaults.observeBindingPresence({
          bindingHandle: current.bindingHandle,
          profileRevisionId: current.profileRevisionId,
          profileResolutionFingerprint: resolutionFingerprint(OPENCODE_PROFILE),
          providerFamily: current.providerFamily,
        }),
        profileResolutionFingerprint: `sha256:${"f".repeat(64)}`,
      })).toThrowError("acp_private_binding_presence_authority_scope_mismatch");
      const absentBinding = binding(
        OPENCODE_PROFILE,
        "binding_handle_authority_absent_create",
      );
      const createAuthority = createSessionIdAcpTaskBindingDispositionAuthority({
        identityVaultResolver: authority.taskIdentityVaults,
        binding: absentBinding,
        presenceAuthority: authority.taskIdentityVaults.observeBindingPresence({
          bindingHandle: absentBinding.bindingHandle,
          profileRevisionId: absentBinding.profileRevisionId,
          profileResolutionFingerprint: resolutionFingerprint(OPENCODE_PROFILE),
          providerFamily: absentBinding.providerFamily,
        }),
        profileResolutionFingerprint: resolutionFingerprint(OPENCODE_PROFILE),
      });
      expect(JSON.stringify(createAuthority)).toBe(
        '{"kind":"session_id_acp_task_binding_disposition_authority"}',
      );
      expect(JSON.stringify(createAuthority)).not.toContain("create");
      expect(() => createSessionIdAcpTaskBindingDispositionAuthority({
        identityVaultResolver: authority.taskIdentityVaults,
        binding: absentBinding,
        presenceAuthority: {
          toJSON: () => ({ kind: "host_private_acp_binding_presence_authority" }),
        },
        profileResolutionFingerprint: resolutionFingerprint(OPENCODE_PROFILE),
      } as never)).toThrowError("acp_private_binding_presence_authority_invalid");

      let postResolutionFenceEffectCount = 0;
      const driftFactory = createOpenCodeAcpProductionTaskNativeFactory({
        controlledResolveCurrent: ({ profile }) => controlledCurrentResolution(profile),
        controlledCreateAdapter(options) {
          options.identityVaultResolver?.({
            profileRevisionId: current.profileRevisionId,
            profileResolutionFingerprint: `sha256:${"f".repeat(64)}`,
          });
          postResolutionFenceEffectCount += 1;
          return controlledOpenCodeAdapter(options);
        },
      });
      const driftBinding = binding(OPENCODE_PROFILE, "binding_handle_resolution_drift");
      await expect(driftFactory.checkReadiness({
        profile: OPENCODE_PROFILE,
        role: "worker",
        hostInputs,
        privateRootAuthority: authority.taskPrivateRootAuthority,
        identityVaultResolver: authority.taskIdentityVaults,
        signal: new AbortController().signal,
      })).resolves.toMatchObject({
        available: false,
        unavailableReasons: ["acp_task_current_resolution_vault_scope_mismatch"],
      });
      expect(postResolutionFenceEffectCount).toBe(0);
      await expect(driftFactory.open({
        binding: driftBinding,
        frozenProfile: frozen(OPENCODE_PROFILE),
        profile: OPENCODE_PROFILE,
        role: "worker",
        hostScope: hostScope(OPENCODE_PROFILE, driftBinding, authority, {
          authorizedWorkspaceDirectory: workspace,
        }),
        hostInputs,
        identityVaultResolver: authority.taskIdentityVaults,
        signal: new AbortController().signal,
        onObservation: async () => undefined,
      })).resolves.toEqual({
        available: false,
        code: "acp_opencode_current_install_unavailable",
      });
      expect(postResolutionFenceEffectCount).toBe(0);
      await driftFactory.close();
      expect(createAdapter).not.toHaveBeenCalled();
      expect(JSON.stringify(correct)).not.toContain(runtimeDataRoot);
      expect(JSON.stringify(correct)).not.toContain('"create"');
    } finally {
      await nativeFactory.close();
      authority.close();
      foreignAuthority.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("derives create/load/resume only after current resolution across fresh Host epochs", async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "acp-production-host-epoch-")));
    const workspace = path.join(root, "workspace");
    const runtimeDataDirectory = path.join(root, "runtime-data");
    await Promise.all([
      mkdir(workspace, { mode: 0o700 }),
      mkdir(runtimeDataDirectory, { mode: 0o700 }),
    ]);
    const current = binding(OPENCODE_PROFILE, "binding_handle_cross_host_epoch");
    const profileResolutionFingerprint = resolutionFingerprint(OPENCODE_PROFILE);
    const presenceScope = Object.freeze({
      bindingHandle: current.bindingHandle,
      profileRevisionId: current.profileRevisionId,
      profileResolutionFingerprint,
      providerFamily: current.providerFamily,
    });
    const hostInputs = {
      commandReference: "/private/install/opencode",
      executableSearchPath: "/private/bin:/usr/bin:/bin",
      authFile: "/private/auth/opencode.json",
    } as const;
    const hostA = privateAuthority(undefined, runtimeDataDirectory);
    let hostB: AcpRuntimeHostPrivateAuthority | undefined;

    try {
      const absent = hostA.taskIdentityVaults.observeBindingPresence(presenceScope);
      const createAuthority = createSessionIdAcpTaskBindingDispositionAuthority({
        identityVaultResolver: hostA.taskIdentityVaults,
        binding: current,
        presenceAuthority: absent,
        profileResolutionFingerprint,
      });
      expect(JSON.stringify(createAuthority)).not.toContain("create");
      const generationId = "acp_generation_cross_host_a";
      const hostAVault = hostA.taskIdentityVaults({
        profileRevisionId: current.profileRevisionId,
        profileResolutionFingerprint,
      });
      hostAVault.bindNew({
        bindingHandle: current.bindingHandle,
        generationId,
        rawSessionId: "raw-session-cross-host-a",
      });
      hostAVault.detachBinding({ bindingHandle: current.bindingHandle, generationId });
      hostA.close();

      hostB = privateAuthority(undefined, runtimeDataDirectory);
      const present = hostB.taskIdentityVaults.observeBindingPresence(presenceScope);
      expect(claimAcpPrivateBindingPresenceAuthority({
        authority: present,
        resolver: hostB.taskIdentityVaults,
        bindingHandle: current.bindingHandle,
        profileRevisionId: current.profileRevisionId,
        providerFamily: current.providerFamily,
      })).toBe("present");

      const active = binding(OPENCODE_PROFILE, "binding_handle_current_host_resume");
      const hostBVault = hostB.taskIdentityVaults({
        profileRevisionId: active.profileRevisionId,
        profileResolutionFingerprint,
      });
      hostBVault.bindNew({
        bindingHandle: active.bindingHandle,
        generationId: "acp_generation_current_host_resume",
        rawSessionId: "raw-session-current-host-resume",
      });
      const observedDispositions: SessionIdAcpTaskBindingDisposition[] = [];
      const nativeFactory = createOpenCodeAcpProductionTaskNativeFactory({
        controlledResolveCurrent: ({ profile }) => controlledCurrentResolution(profile),
        resolveReconciler(context) {
          observedDispositions.push(context.bindingDisposition);
          return Object.freeze({
            async reconcile(input) {
              return Object.freeze({
                state: "reconciling" as const,
                reason: "provider_outcome_unknown" as const,
                resendAllowed: false as const,
                observations: input.knownObservations,
              });
            },
          });
        },
        controlledCreateAdapter(options) {
          options.identityVaultResolver?.({
            profileRevisionId: current.profileRevisionId,
            profileResolutionFingerprint,
          });
          return controlledOpenCodeAdapter(options);
        },
      });
      for (const target of [current, active]) {
        const opened = await nativeFactory.open({
          binding: target,
          frozenProfile: frozen(OPENCODE_PROFILE),
          profile: OPENCODE_PROFILE,
          role: "worker",
          hostScope: hostScope(OPENCODE_PROFILE, target, hostB, {
            authorizedWorkspaceDirectory: workspace,
          }),
          hostInputs,
          identityVaultResolver: hostB.taskIdentityVaults,
          signal: new AbortController().signal,
          onObservation: async () => undefined,
        });
        expect(opened).toMatchObject({ available: true });
        if (opened.available) {
          await opened.nativeBinding.close({ signal: new AbortController().signal });
        }
      }
      expect(observedDispositions).toEqual(["load", "resume"]);
      await nativeFactory.close();
      hostB.close();
      expect(() => lstatSync(path.join(runtimeDataDirectory, ".acp-host-epoch.lease"))).toThrow();
    } finally {
      try { hostA.close(); } catch { /* assertion reports primary failure */ }
      try { hostB?.close(); } catch { /* assertion reports primary failure */ }
      await rm(root, { force: true, recursive: true });
    }
  });

  it("builds concrete no-live OpenCode/Codex owners and keeps Host paths off wire projections", async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "acp-production-composition-")));
    const workspace = path.join(root, "workspace");
    const runtimePrivateRoot = path.join(root, "runtime-private");
    await Promise.all([
      mkdir(workspace, { mode: 0o700 }),
      mkdir(runtimePrivateRoot, { mode: 0o700 }),
    ]);
    await chmod(runtimePrivateRoot, 0o700);

    const observed: string[] = [];
    let openCodeOptions: OpenCodeAdapterConstruction | undefined;
    let codexOptions: CodexAdapterConstruction | undefined;
    let codexVault: CodexAdapterConstruction["identityVaultResolver"];
    let observedBusinessTurnContext: ProviderScopedToolTurnContext | undefined;
    const businessTurnContext = qualificationTurnContext();
    const openCode = createOpenCodeAcpProductionTaskNativeFactory({
      controlledResolveCurrent: ({ profile }) => controlledCurrentResolution(profile),
      resolveReconciler(context) {
        expect(context.hostScope.authorizedWorkspaceDirectory).toBe(workspace);
        expect(context.bindingDisposition).toBe("create");
        return undefined;
      },
      controlledCreateAdapter(options) {
        openCodeOptions = options;
        return controlledOpenCodeAdapter(options);
      },
    });
    const codex = createCodexAcpProductionTaskNativeFactory({
      createReadinessProbe({ role }) {
        return {
          attemptId: "session_execution_attempt_codex_production_readiness",
          content: "Exercise only the exact scoped Codex readiness lease.",
          interactionRevision: 1,
          ...(role === "conductor" || role === "publisher"
            ? { turnContext: qualificationTurnContext() }
            : {}),
        };
      },
      createQualificationProbe(context) {
        expect(context.hostScope.authorizedWorkspaceDirectory).toBe(workspace);
        expect(context.bindingDisposition).toBe("create");
        return {
          attemptId: "session_execution_attempt_codex_production_qualification",
          content: "Exercise only the exact scoped Conductor qualification lease.",
          interactionRevision: 1,
          turnContext: qualificationTurnContext(),
        };
      },
      controlled: {
        resolveCurrent: ({ profile }) => controlledCurrentResolution(profile),
        createAdapter(options) {
          codexOptions = options;
          codexVault = options.identityVaultResolver;
          return controlledCodexAdapter(options, (attempt) => {
            observedBusinessTurnContext = attempt.turnContext;
          });
        },
      },
    });
    const fixture = compositionFixture({
      runtimeDataDirectory: runtimePrivateRoot,
      factories: { opencode: openCode, codex },
      observeExecution: (value) => {
        const observation = value as SessionIdAcpProductionExecutionObservation;
        observed.push(`${observation.providerFamily}:host`);
      },
    });
    expect(fixture.composition.nativeReleaseObservations.list()).toEqual([]);
    const openCodeBinding = binding(OPENCODE_PROFILE, "binding_handle_thin_opencode");
    const codexBinding = binding(CODEX_PROFILE, "binding_handle_thin_codex");
    const concreteOpenCodeScope = hostScope(
      OPENCODE_PROFILE,
      openCodeBinding,
      fixture.authority,
      {
      authorizedWorkspaceDirectory: workspace,
      },
    );
    const concreteCodexScope = hostScope(
      CODEX_PROFILE,
      codexBinding,
      fixture.authority,
      {
      authorizedWorkspaceDirectory: workspace,
      },
    );

    try {
      const openedOpenCode = await fixture.composition.taskNativeBindings.open({
        binding: openCodeBinding,
        frozenProfile: frozen(OPENCODE_PROFILE),
        profile: OPENCODE_PROFILE,
        role: "worker",
        hostScope: concreteOpenCodeScope,
        signal: new AbortController().signal,
        observeDeliveryReceipt: async () => { observed.push("opencode:receipt"); },
      });
      const openedCodex = await fixture.composition.taskNativeBindings.open({
        binding: codexBinding,
        frozenProfile: frozen(CODEX_PROFILE),
        profile: CODEX_PROFILE,
        role: "conductor",
        hostScope: concreteCodexScope,
        signal: new AbortController().signal,
        observeDeliveryReceipt: async () => { observed.push("codex:receipt"); },
        resolveTurnContext: () => businessTurnContext,
      });
      expect(openedOpenCode).toMatchObject({ available: true });
      expect(openedCodex).toMatchObject({ available: true });
      expect(openCodeOptions?.workspaceDirectory).toBe(workspace);
      expect(openCodeOptions?.bindingDisposition).toBe("create");
      expect(openCodeOptions?.sessionConfiguration).toEqual({
        model: OPENCODE_PROFILE.model,
        options: [],
      });
      expect(openCodeOptions?.credentialAcquisition.privateRootParent)
        .toBe(path.join(
          runtimePrivateRoot,
          "acp-task-provider-runtime",
          "task-acp-opencode",
        ));
      expect(Object.values(openCodeOptions?.currentInstall.inspectionEnvironment ?? {})
        .every((directory) => typeof directory === "string"
          && directory.startsWith(`${runtimePrivateRoot}${path.sep}`))).toBe(true);
      expect(codexOptions?.credentialAcquisition.runtimePrivateRoot).not.toBe(workspace);
      expect(typeof codexOptions?.credentialAcquisition.runtimePrivateRoot === "string"
        && codexOptions.credentialAcquisition.runtimePrivateRoot.startsWith(
          `${runtimePrivateRoot}${path.sep}`,
        )).toBe(true);
      expect(codexOptions?.bindingDisposition).toBe("create");
      expect(codexOptions?.sessionConfiguration).toEqual({
        model: CODEX_PROFILE.model,
        options: [{
          configId: "reasoning_effort",
          category: "thought_level",
          type: "select",
          value: "high",
        }],
      });
      expect(codexVault).not.toBe(fixture.authority.taskIdentityVaults);
      expect(codexVault).not.toBe(fixture.authority.metaIdentityVaults);
      expect(codexVault?.({
        profileRevisionId: CODEX_PROFILE.profileRevisionId,
        profileResolutionFingerprint: resolutionFingerprint(CODEX_PROFILE),
      })).toBe(fixture.authority.taskIdentityVaults({
        profileRevisionId: CODEX_PROFILE.profileRevisionId,
        profileResolutionFingerprint: resolutionFingerprint(CODEX_PROFILE),
      }));
      if (!openedCodex.available) throw new Error("expected controlled Codex native Binding");
      await openedCodex.nativeBinding.submitDelivery({
        bindingHandle: codexBinding.bindingHandle,
        sessionExecutionAttemptId: "session_execution_attempt_codex_business_context",
        content: "controlled business turn",
        signal: new AbortController().signal,
      });
      expect(observedBusinessTurnContext).toBe(businessTurnContext);
      if (!openCodeOptions?.onObservation || !codexOptions?.onObservation) {
        throw new Error("expected real-time observation handlers");
      }

      await openCodeOptions.onObservation({
        kind: "delivery_receipt",
        bindingHandle: openCodeBinding.bindingHandle,
        attemptId: "session_execution_attempt_thin_opencode",
        receiptDigest: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      });
      await codexOptions.onObservation({
        kind: "delivery_receipt",
        bindingHandle: codexBinding.bindingHandle,
        attemptId: "session_execution_attempt_thin_codex",
        receiptDigest: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      });
      expect(observed).toEqual([
        "opencode:receipt",
        "opencode:host",
        "codex:receipt",
        "codex:host",
      ]);
      const safeProjection = JSON.stringify({
        composition: fixture.composition,
        openedOpenCode,
        openedCodex,
      });
      expect(safeProjection).not.toContain(workspace);
      expect(safeProjection).not.toContain(runtimePrivateRoot);
      expect(safeProjection).not.toContain("/private/auth/");
    } finally {
      await fixture.composition.close();
      expect(fixture.composition.nativeReleaseObservations.list()).toEqual([]);
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps Meta on its own vault and makes cleanup failure sticky without releasing Host authority", async () => {
    const events: string[] = [];
    const failingFactory = factory("opencode", async () => ({
      available: false,
      code: "acp_task_profile_current_install_unavailable",
    }), async () => {
      events.push("task-factory-close");
      throw new Error("child cleanup failed");
    });
    const fixture = compositionFixture({
      factories: { opencode: failingFactory },
      authorityEvents: events,
      createMetaOwner: (input) => {
        expect(input.identityVaultResolver).toBe(fixtureAuthorityMetaVault);
        expect(input.identityVaultResolver).not.toBe(fixtureAuthorityTaskVault);
        return {
          status: "configured",
          owner: Object.freeze({
            async close() { events.push("meta-close"); },
          }),
        };
      },
    });
    fixtureAuthorityTaskVault = fixture.authority.taskIdentityVaults;
    fixtureAuthorityMetaVault = fixture.authority.metaIdentityVaults;

    const first = fixture.composition.close();
    const second = fixture.composition.close();
    expect(second).toBe(first);
    await expect(first).rejects.toMatchObject({
      code: "acp_production_child_cleanup_unconfirmed",
    });
    expect(events).toEqual(["task-factory-close", "meta-close"]);
    await expect(fixture.composition.close()).rejects.toMatchObject({
      code: "acp_production_child_cleanup_unconfirmed",
    });
  });

  it("closes Task owners, Meta, then the private Host authority when cleanup is confirmed", async () => {
    const events: string[] = [];
    const fixture = compositionFixture({
      authorityEvents: events,
      factories: {
        opencode: factory("opencode", async () => ({
          available: false,
          code: "acp_task_profile_current_install_unavailable",
        }), async () => { events.push("opencode-close"); }),
        codex: factory("codex", async () => ({
          available: false,
          code: "acp_task_profile_current_install_unavailable",
        }), async () => { events.push("codex-close"); }),
      },
      createMetaOwner: () => ({
        status: "configured",
        owner: Object.freeze({ async close() { events.push("meta-close"); } }),
      }),
    });

    await fixture.composition.close();
    await fixture.composition.close();
    expect(events).toEqual([
      "opencode-close",
      "codex-close",
      "meta-close",
      "authority-close",
    ]);
  });
});

let fixtureAuthorityTaskVault: AcpRuntimeHostPrivateAuthority["taskIdentityVaults"];
let fixtureAuthorityMetaVault: AcpRuntimeHostPrivateAuthority["metaIdentityVaults"];

function compositionFixture(input: Readonly<{
  configuration?: ReturnType<typeof configuration>;
  factories?: Readonly<{
    opencode?: SessionIdAcpProductionTaskNativeFactory;
    codex?: SessionIdAcpProductionTaskNativeFactory;
  }>;
  observeExecution?: (
    value: SessionIdAcpProductionExecutionObservation,
  ) => void | Promise<void>;
  observeFinalCandidate?: Parameters<
    typeof createSessionIdAcpProductionComposition
  >[0]["observeFinalCandidate"];
  createMetaOwner?: Parameters<typeof createSessionIdAcpProductionComposition>[0]["createMetaOwner"];
  onBindingReady?: Parameters<
    typeof createSessionIdAcpProductionComposition
  >[0]["onBindingReady"];
  onDiagnostic?: Parameters<
    typeof createSessionIdAcpProductionComposition
  >[0]["onDiagnostic"];
  authorityEvents?: string[];
  runtimeDataDirectory?: string;
  omitRetirementAuthorities?: boolean;
}> = {}) {
  const config = input.configuration ?? configuration({ includeOpenCode: true, includeCodex: true });
  const hostInputs = createAcpProductionHostInputs(config, hostEnvironment());
  const authority = privateAuthority(input.authorityEvents, input.runtimeDataDirectory);
  fixtureAuthorityTaskVault = authority.taskIdentityVaults;
  fixtureAuthorityMetaVault = authority.metaIdentityVaults;
  const composition = createSessionIdAcpProductionComposition({
    configuration: config,
    hostInputs,
    privateAuthority: authority,
    repositories: {
      sessionRuntime: {
        getRuntimeForSession(logicalSessionId: string) {
          return Object.freeze({
            sessionExecutionRuntimeId: `session_execution_runtime_${logicalSessionId}`,
            taskId: "task_acp_production",
            runId: "run_acp_production",
            logicalSessionId,
            state: "idle" as const,
            revision: 1,
            createdAt: NOW,
            updatedAt: NOW,
          });
        },
      },
    } as AcpSessionRuntimeRepositories,
    sessionRuntimeOwner: {
      bindingReadyEvent(value: Parameters<
        SessionExecutionRuntimeOwner["bindingReadyEvent"]
      >[0]) {
        return Object.freeze({
          type: "session_runtime.binding_ready" as const,
          ...value,
          observedAt: NOW,
        });
      },
    } as SessionExecutionRuntimeOwner,
    resolveFrozenProfileTuple: () => undefined,
    resolveInterruptCorrelation: () => undefined,
    resolveTaskStopControl: input.omitRetirementAuthorities
      ? undefined as never
      : () => ({ kind: "task_stop", state: "requested" }),
    resolveCloseControl: input.omitRetirementAuthorities
      ? undefined as never
      : () => ({ kind: "close", state: "requested" }),
    authorizeRetiringBindingRecovery: input.omitRetirementAuthorities
      ? undefined as never
      : () => false,
    resolveTaskBindingContext: ({ binding: currentBinding, frozenProfile }) => {
      const profile = frozenProfile.providerFamily === "opencode"
        ? OPENCODE_PROFILE
        : CODEX_PROFILE;
      return {
        profile,
        role: frozenProfile.providerFamily === "opencode" ? "worker" : "conductor",
        hostScope: hostScope(profile, currentBinding, authority),
      };
    },
    observeExecution: input.observeExecution ?? (() => undefined),
    observeFinalCandidate: input.observeFinalCandidate ?? (() => undefined),
    onDeliveryReceipt: () => undefined,
    onBindingReady: input.onBindingReady ?? (() => undefined),
    ...(input.onDiagnostic ? { onDiagnostic: input.onDiagnostic } : {}),
    taskNativeFactories: input.factories ?? {},
    createMetaOwner: input.createMetaOwner ?? (() => ({
      status: "configured" as const,
      owner: Object.freeze({ async close() {} }),
    })),
    effectDeadlineMs: 1_000,
  });
  return { authority, composition };
}

function factory(
  providerFamily: "opencode" | "codex",
  open: SessionIdAcpProductionTaskNativeFactory["open"],
  close: SessionIdAcpProductionTaskNativeFactory["close"] = async () => undefined,
  checkReadiness: SessionIdAcpProductionTaskNativeFactory["checkReadiness"] = async (input) => (
    availableReport(input.profile, input.role)
  ),
): SessionIdAcpProductionTaskNativeFactory {
  return Object.freeze({
    providerFamily,
    readModelCatalog: vi.fn(async () => Object.freeze({
      available: true,
      modelCatalog: Object.freeze([]),
      unavailableReasons: Object.freeze([]),
    })),
    checkReadiness: vi.fn(checkReadiness),
    open: vi.fn(open),
    close: vi.fn(close),
  });
}

function privateAuthority(
  events?: string[],
  suppliedRuntimeDataDirectory?: string,
): AcpRuntimeHostPrivateAuthority {
  const runtimeDataDirectory = suppliedRuntimeDataDirectory
    ?? mkdtempSync(path.join(tmpdir(), "acp-production-private-authority-"));
  chmodSync(runtimeDataDirectory, 0o700);
  if (!suppliedRuntimeDataDirectory) authorityRoots.push(runtimeDataDirectory);
  const { publicKey } = generateKeyPairSync("ed25519");
  const owned = createAcpRuntimeHostPrivateAuthority({
    runtimeDataDirectory,
    environment: {
      AGENT_WORKSPACE_ACP_HOST_EPOCH: `host_epoch_production_composition_${++authorityEpoch}`,
      AGENT_WORKSPACE_ACP_HOST_EPOCH_PUBLIC_KEY: publicKey.export({
        format: "der",
        type: "spki",
      }).toString("base64url"),
    },
  });
  return Object.freeze({
    taskIdentityVaults: owned.taskIdentityVaults,
    metaIdentityVaults: owned.metaIdentityVaults,
    taskPrivateRootAuthority: owned.taskPrivateRootAuthority,
    metaPrivateRootAuthority: owned.metaPrivateRootAuthority,
    recoveryObservation: owned.recoveryObservation,
    authorizeRetiringBindingRecovery: owned.authorizeRetiringBindingRecovery,
    close: vi.fn(() => {
      owned.close();
      events?.push("authority-close");
    }),
    toJSON: owned.toJSON,
  });
}

function observationNative(
  observe: (observation: AcpSessionObservation) => void | Promise<void>,
  bindingHandle = "binding_handle_opencode_worker",
): AcpTaskSessionRuntimeNativeBinding {
  const native: AcpTaskSessionRuntimeNativeBinding = {
    bindingHandle,
    async submitDelivery(input) {
      await observe({
        kind: "delivery_receipt",
        bindingHandle: input.bindingHandle,
        attemptId: input.sessionExecutionAttemptId,
        receiptDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      });
      return {
        status: "reconciling" as const,
        bindingHandle,
        sessionExecutionAttemptId: input.sessionExecutionAttemptId,
        reason: "provider_outcome_unknown" as const,
      };
    },
    async reconcileAttempt(input) {
      return {
        status: "reconciling" as const,
        bindingHandle,
        sessionExecutionAttemptId: input.sessionExecutionAttemptId,
        reason: "provider_outcome_unknown" as const,
      };
    },
    async retire() {},
    async close() {},
  };
  return Object.freeze(native);
}

function inertNative(bindingHandle: string): AcpTaskSessionRuntimeNativeBinding {
  const native: AcpTaskSessionRuntimeNativeBinding = {
    bindingHandle,
    async submitDelivery(input) {
      return {
        status: "reconciling" as const,
        bindingHandle,
        sessionExecutionAttemptId: input.sessionExecutionAttemptId,
        reason: "provider_outcome_unknown" as const,
      };
    },
    async reconcileAttempt(input) {
      return {
        status: "reconciling" as const,
        bindingHandle,
        sessionExecutionAttemptId: input.sessionExecutionAttemptId,
        reason: "provider_outcome_unknown" as const,
      };
    },
    async retire() {},
    async close() {},
  };
  return Object.freeze(native);
}

function controlledOpenCodeAdapter(
  options: OpenCodeAdapterConstruction,
): OpenCodeAcpTaskProfileAdapter {
  const report = availableReport(options.profile, options.role);
  let runtime: OpenCodeAcpTaskBindingRuntime | undefined;
  let closePromise: Promise<void> | undefined;
  return Object.freeze({
    role: options.role,
    async openBinding({ bindingHandle }) {
      runtime = Object.freeze({
        bindingHandle,
        role: options.role,
        report,
        async submitPrompt(input) {
          return Object.freeze({
            state: "reconciling" as const,
            reason: "provider_outcome_unknown" as const,
            resendAllowed: false as const,
            observations: Object.freeze([]),
          });
        },
        async reconcilePrompt(input) {
          return Object.freeze({
            state: "reconciling" as const,
            reason: "provider_outcome_unknown" as const,
            resendAllowed: false as const,
            observations: Object.freeze([]),
          });
        },
        async requestInterrupt() {
          return Object.freeze({ acceptance: "accepted" as const, completion: "unknown" as const });
        },
        async releaseBinding() {},
        safeObservation: () => Object.freeze({
          providerFamily: "opencode" as const,
          acpAgentKind: "native_acp" as const,
          executionProfileId: options.profile.executionProfileId,
          profileRevisionId: options.profile.profileRevisionId,
          role: options.role,
          available: true as const,
          qualificationClass: "binding_behavior" as const,
          evidenceClass: "injected_host_qualification" as const,
        }),
        async close() {},
      });
      return Object.freeze({ available: true as const, runtime, report });
    },
    safeObservation: () => Object.freeze({
      role: options.role,
      processOpenEffectCount: 0,
      qualificationPromptEffectCount: 0,
      businessPromptEffectCount: 0,
      readinessReused: false,
    }),
    close() {
      closePromise ??= (async () => {
        await runtime?.close();
        await options.scopedMcpRoles?.target.close();
        await options.scopedMcpRoles?.readiness.close();
      })();
      return closePromise;
    },
  });
}

function controlledCodexAdapter(
  options: CodexAdapterConstruction,
  onAttempt?: (
    input: Parameters<CodexAcpTaskBindingRuntime["submitPrompt"]>[0],
  ) => void,
): CodexAcpTaskProfileAdapter {
  const report = availableReport(options.profile, options.role);
  let runtime: CodexAcpTaskBindingRuntime | undefined;
  let closePromise: Promise<void> | undefined;
  return Object.freeze({
    role: options.role,
    async openBinding({ bindingHandle }) {
      runtime = Object.freeze({
        bindingHandle,
        role: options.role,
        report,
        async submitPrompt(input) {
          onAttempt?.(input);
          return Object.freeze({
            state: "reconciling" as const,
            reason: "provider_outcome_unknown" as const,
            resendAllowed: false as const,
            observations: Object.freeze([]),
          });
        },
        async reconcilePrompt() {
          return Object.freeze({
            state: "reconciling" as const,
            reason: "provider_outcome_unknown" as const,
            resendAllowed: false as const,
            observations: Object.freeze([]),
          });
        },
        async requestInterrupt() {
          return Object.freeze({
            acceptance: "accepted" as const,
            completion: "unknown" as const,
          });
        },
        async releaseBinding() {},
        safeObservation: () => Object.freeze({
          providerFamily: "codex" as const,
          acpAgentKind: "codex_acp" as const,
          executionProfileId: options.profile.executionProfileId,
          profileRevisionId: options.profile.profileRevisionId,
          role: options.role,
          available: true as const,
          qualificationClass: "binding_behavior" as const,
          evidenceClass: "injected_host_qualification" as const,
        }),
        async close() {},
      });
      return Object.freeze({ available: true as const, runtime, report });
    },
    safeObservation: () => Object.freeze({
      role: options.role,
      processOpenEffectCount: 0,
      qualificationPromptEffectCount: 0,
      businessPromptEffectCount: 0,
      readinessReused: false,
    }),
    close() {
      closePromise ??= (async () => {
        await runtime?.close();
        await options.scopedMcpRoles?.target.close();
        await options.scopedMcpRoles?.readiness.close();
      })();
      return closePromise;
    },
  });
}

function controlledQualifiedRuntime(
  bindingHandle: string,
  report: AcpProviderAvailabilityReport,
): AcpQualifiedBindingRuntime {
  return Object.freeze({
    bindingHandle,
    client: Object.freeze({}),
    qualification: Object.freeze({}),
    report,
    async assertQualified() {},
    async releaseBinding() {},
    async close() {},
  }) as unknown as AcpQualifiedBindingRuntime;
}

function availableReport(
  profile: ExecutionProfileDefinitionV3,
  role: "conductor" | "publisher" | "worker" | "reviewer",
): AcpProviderAvailabilityReport {
  return Object.freeze({
    profileRevisionId: profile.profileRevisionId,
    providerFamily: profile.providerFamily,
    acpAgentKind: profile.acpAgentKind,
    role,
    available: true,
    protocolMajor: 1,
    capabilities: Object.freeze([]),
    extensions: Object.freeze([]),
    unavailableReasons: Object.freeze([]),
    qualificationClass: "binding_behavior",
    evidenceClass: "injected_host_qualification",
  });
}

function qualificationTurnContext(): ProviderScopedToolTurnContext {
  return Object.freeze({
    capabilityClass: "runtime_orchestration" as const,
    lease: Object.freeze({ kind: "controlled_qualification_lease" }),
    async handleCall(call: Parameters<ProviderScopedToolTurnContext["handleCall"]>[0]) {
      return Object.freeze({ providerCallId: call.providerCallId, result: { status: "accepted" } });
    },
  });
}

function hostScope(
  _profile: ExecutionProfileDefinitionV3,
  _currentBinding: AcpSafeSessionBindingRecordV3,
  authority: AcpRuntimeHostPrivateAuthority,
  overrides: Readonly<{
    authorizedWorkspaceDirectory?: string;
  }> = {},
): SessionIdAcpTaskHostExecutionScope {
  return Object.freeze({
    authorizedWorkspaceDirectory: overrides.authorizedWorkspaceDirectory
      ?? "/private/agent-workspace-authorized",
    privateRootAuthority: authority.taskPrivateRootAuthority,
  });
}

function controlledCurrentResolution(
  profile: ExecutionProfileDefinitionV3,
): Readonly<{
  readonly profileRevisionId: string;
  readonly providerFamily: ExecutionProfileDefinitionV3["providerFamily"];
  readonly profileResolutionFingerprint: string;
}> {
  return Object.freeze({
    profileRevisionId: profile.profileRevisionId,
    providerFamily: profile.providerFamily,
    profileResolutionFingerprint: resolutionFingerprint(profile),
  });
}

function resolutionFingerprint(profile: ExecutionProfileDefinitionV3): string {
  return `sha256:${profile.providerFamily === "opencode" ? "a" : "b"}`.padEnd(71, profile.providerFamily === "opencode" ? "a" : "b");
}

function binding(
  profile: ExecutionProfileDefinitionV3,
  bindingHandle: string,
): AcpSafeSessionBindingRecordV3 {
  return Object.freeze({
    schemaVersion: 3,
    bindingId: `binding_${profile.providerFamily.replace("-", "_")}_production`,
    taskId: "task_acp_production",
    runId: "run_acp_production",
    logicalSessionId: `logical_session_${profile.providerFamily.replace("-", "_")}_production`,
    agentCardId: `agent_card_${profile.providerFamily.replace("-", "_")}_production`,
    executionProfileId: profile.executionProfileId,
    profileRevisionId: profile.profileRevisionId,
    providerFamily: profile.providerFamily,
    bindingHandle,
    status: "active",
    recoverable: true,
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
  });
}

function frozen(profile: ExecutionProfileDefinitionV3): AcpV3FrozenProfileTuple {
  return Object.freeze({
    schemaVersion: 3,
    executionProfileId: profile.executionProfileId,
    profileRevisionId: profile.profileRevisionId,
    providerFamily: profile.providerFamily,
  });
}

function configuration(input: Readonly<{
  includeOpenCode: boolean;
  includeCodex: boolean;
}>) {
  return parseAcpProductionConfiguration(JSON.stringify({
    schemaVersion: 1,
    agents: {
      ...(input.includeOpenCode ? {
        opencode: {
          kind: "opencode-acp-current-install",
          command: { env: "TEST_OPENCODE_COMMAND" },
          executableSearchPath: { env: "TEST_ACP_SEARCH_PATH" },
          authFile: { env: "TEST_OPENCODE_AUTH" },
        },
      } : {}),
      ...(input.includeCodex ? {
        codex: {
          kind: "codex-acp-current-install",
          wrapperCommand: { env: "TEST_CODEX_WRAPPER" },
          codexCommand: { env: "TEST_CODEX_COMMAND" },
          nodeCommand: { env: "TEST_NODE_COMMAND" },
          executableSearchPath: { env: "TEST_ACP_SEARCH_PATH" },
          authFile: { env: "TEST_CODEX_AUTH" },
        },
      } : {}),
    },
    metaProfiles: input.includeCodex ? [{
      metaProfileOptionId: "meta_profile_option_codex-production",
      title: "Codex ACP Meta",
      profile: META_PROFILE,
    }] : [],
  }));
}

function hostEnvironment() {
  return {
    TEST_OPENCODE_COMMAND: "/private/install/opencode",
    TEST_OPENCODE_AUTH: "/private/auth/opencode.json",
    TEST_CODEX_WRAPPER: "/private/install/codex-acp",
    TEST_CODEX_COMMAND: "/private/install/codex",
    TEST_NODE_COMMAND: "/private/install/node",
    TEST_CODEX_AUTH: "/private/auth/codex.json",
    TEST_ACP_SEARCH_PATH: "/private/bin:/usr/bin:/bin",
  };
}

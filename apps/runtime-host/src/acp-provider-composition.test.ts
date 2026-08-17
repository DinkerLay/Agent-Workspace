import { EventEmitter } from "node:events";
import { PassThrough, type Readable, type Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import type { ExecutionProfileDefinitionV3 } from "@agent-workspace/runtime-contracts";
import type {
  AcpV1ClientHandlers,
  AcpV1ConnectionFactory,
  InjectedAcpV1Connection,
} from "@agent-workspace/provider-acp";
import {
  createAcpAgentProcessFactory,
  type AcpAgentChildProcess,
  type AcpAgentProcessFactory,
  type AcpAgentProcessLease,
} from "./acp-agent-process.js";
import {
  createAcpProfileResolutionRegistry,
  type AcpCurrentInstallDescriptor,
  type AcpDiscoveredArtifact,
} from "./acp-profile-resolution.js";
import { createAcpQualificationAuthority } from "./acp-qualification.js";
import { createAcpReverseRpcBroker, type AcpReverseRpcLease } from "./acp-reverse-rpc-broker.js";
import {
  claimAcpTargetCheckpointFactObservation,
  claimAcpTargetLifecycleObservation,
  createAcpProviderComposition,
  type AcpTargetCheckpointFactCapability,
  type AcpTargetCheckpointObserver,
  type AcpTargetLifecycleCapability,
  type AcpProviderQualificationRequest,
  type AcpQualificationEffectBudget,
} from "./acp-provider-composition.js";

function profile(requiredExtensions: readonly string[] = ["session/load"]): ExecutionProfileDefinitionV3 {
  return {
    executionProfileId: "execution_profile_composition" as ExecutionProfileDefinitionV3["executionProfileId"],
    profileRevisionId: "profile_revision_composition",
    providerFamily: "opencode",
    acpAgentKind: "native_acp",
    protocolMajor: 1,
    model: "model-current",
    configIntent: {},
    requiredExtensions,
    capabilityPolicy: {
      requiredCapabilities: [
        "create_binding",
        "resume_binding",
        "input_correlation",
        "provider_receipt",
        "reconcile",
        "interrupt",
      ],
      allowedTools: [],
      permissionMode: "ask",
      maxConcurrentTurns: 1,
      maxNativeChildren: 0,
    },
  };
}

function artifact(label: "a" | "b"): AcpDiscoveredArtifact {
  return {
    canonicalLauncherPath: `/private/current/${label}/opencode`,
    launchArguments: ["acp"],
    observedArtifactVersion: `future-${label}`,
    observedUpstreamVersion: `upstream-${label}`,
    artifactDigest: `sha256:${label.repeat(64)}`,
    trustState: "trusted",
    executionConfigDigest: `sha256:${label.repeat(64)}`,
    environment: {},
  };
}

class FakeChild extends EventEmitter implements AcpAgentChildProcess {
  readonly pid = 51_515;
  readonly stdin: Writable = new PassThrough();
  readonly stdout: Readable = new PassThrough();
  readonly stderr: Readable = new PassThrough();
  confirmClose = true;

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    if (this.confirmClose) queueMicrotask(() => this.emit("close", null, signal));
    return true;
  }
}

function connectionFactory(initializeResponse: unknown): AcpV1ConnectionFactory {
  const bindingResponse = () => ({
    sessionId: "raw-session-private",
    configOptions: [{
      id: "config-model",
      category: "model",
      type: "select",
      currentValue: "model-current",
      options: [{ value: "model-current", name: "Current" }],
    }],
  });
  return (_handlers: AcpV1ClientHandlers): InjectedAcpV1Connection => ({
    initialize: async () => initializeResponse,
    newSession: async () => bindingResponse(),
    loadSession: async () => bindingResponse(),
    resumeSession: async () => bindingResponse(),
    prompt: async () => ({ stopReason: "end_turn" }),
    cancel: async () => undefined,
    closeSession: async () => ({}),
  });
}

function initializeResponse(extra: Record<string, unknown> = {}) {
  return {
    protocolVersion: 1,
    agentInfo: { name: "future-agent", version: "999.0.0-next" },
    agentCapabilities: {
      loadSession: true,
      sessionCapabilities: { resume: {}, close: {} },
    },
    ...extra,
  };
}

function createHarness(options: Readonly<{
  readonly confirmChildClose?: boolean;
  readonly operationTimeoutMs?: number;
}> = {}) {
  const children: FakeChild[] = [];
  const processes = createAcpAgentProcessFactory({
    spawn: () => {
      const child = new FakeChild();
      child.confirmClose = options.confirmChildClose ?? true;
      children.push(child);
      return child;
    },
    signalChild: (child, signal) => child.kill(signal),
    terminationGraceMs: 20,
    killConfirmationMs: 20,
  });
  const broker = createAcpReverseRpcBroker();
  const composition = createAcpProviderComposition({
    resolutions: createAcpProfileResolutionRegistry(),
    processes,
    qualifications: createAcpQualificationAuthority(),
    reverseRpcBroker: broker,
    readinessTtlMs: 10_000,
    operationTimeoutMs: options.operationTimeoutMs ?? 100,
    now: () => 1_000,
  });
  return { children, processes, broker, composition };
}

describe("opt-in ACP Provider composition", () => {
  it("treats reordered ACP model catalogs as the same recovery observation", async () => {
    const { composition } = createHarness();
    const catalogs = [
      [
        { value: "model-current", name: "Current" },
        { value: "model-other", name: "Other" },
      ],
      [
        { value: "model-other", name: "Other" },
        { value: "model-current", name: "Current" },
      ],
    ];
    let generation = 0;
    const createConnection = () => {
      const options = catalogs[generation++] ?? catalogs.at(-1)!;
      const bindingResponse = () => ({
        sessionId: "raw-session-private",
        configOptions: [{
          id: "config-model",
          category: "model",
          type: "select",
          currentValue: "model-current",
          options,
        }],
      });
      return (_handlers: AcpV1ClientHandlers): InjectedAcpV1Connection => ({
        initialize: async () => initializeResponse(),
        newSession: async () => bindingResponse(),
        loadSession: async () => bindingResponse(),
        resumeSession: async () => bindingResponse(),
        prompt: async () => ({ stopReason: "end_turn" }),
        cancel: async () => undefined,
        closeSession: async () => ({}),
      });
    };
    const request: AcpProviderQualificationRequest = {
      profile: profile(),
      descriptor: {
        descriptorId: "stable-model-catalog",
        discoverCurrent: async () => artifact("a"),
      },
      role: "worker",
      requiredAcpCapabilities: ["session_new", "session_load"],
      requiredAnyAcpCapabilities: ["session_load"],
      requiredBehaviors: ["initial", "recovery"],
      createConnection,
      async runProbe({ client, bindingHandle }) {
        const binding = await client.ensureBinding({
          bindingHandle,
          disposition: "create",
          workspaceDirectory: "/private/catalog-order",
          mcpServers: [],
          configuration: { model: "model-current", options: [] },
        });
        return {
          passedBehaviors: ["initial"],
          modelCatalog: binding.modelCatalog,
          bindingEstablished: true,
        };
      },
      async runRecoveryProbe({ client, bindingHandle }) {
        const binding = await client.ensureBinding({
          bindingHandle,
          disposition: "load",
          workspaceDirectory: "/private/catalog-order",
          mcpServers: [],
          configuration: { model: "model-current", options: [] },
        });
        return {
          passedBehaviors: ["recovery"],
          modelCatalog: binding.modelCatalog,
          bindingEstablished: true,
        };
      },
    };

    await expect(composition.checkReadiness(request)).resolves.toMatchObject({
      available: true,
      modelCatalog: [
        { modelId: "model-current", label: "Current" },
        { modelId: "model-other", label: "Other" },
      ],
    });
    await composition.close();
  });

  it("uses the recovered ACP catalog when unrelated choices change after the selected model rebinds", async () => {
    const { composition } = createHarness();
    const catalogs = [
      [
        { value: "model-current", name: "Current" },
        { value: "model-retiring", name: "Retiring" },
      ],
      [
        { value: "model-current", name: "Current" },
        { value: "model-new", name: "New" },
      ],
    ];
    let generation = 0;
    const createConnection = () => {
      const options = catalogs[generation++] ?? catalogs.at(-1)!;
      const bindingResponse = () => ({
        sessionId: "raw-session-private",
        configOptions: [{
          id: "config-model",
          category: "model",
          type: "select",
          currentValue: "model-current",
          options,
        }],
      });
      return (_handlers: AcpV1ClientHandlers): InjectedAcpV1Connection => ({
        initialize: async () => initializeResponse(),
        newSession: async () => bindingResponse(),
        loadSession: async () => bindingResponse(),
        resumeSession: async () => bindingResponse(),
        prompt: async () => ({ stopReason: "end_turn" }),
        cancel: async () => undefined,
        closeSession: async () => ({}),
      });
    };
    const request: AcpProviderQualificationRequest = {
      profile: profile(),
      descriptor: {
        descriptorId: "changing-model-catalog",
        discoverCurrent: async () => artifact("a"),
      },
      role: "worker",
      requiredAcpCapabilities: ["session_new", "session_load"],
      requiredAnyAcpCapabilities: ["session_load"],
      requiredBehaviors: ["initial", "recovery"],
      createConnection,
      async runProbe({ client, bindingHandle }) {
        const binding = await client.ensureBinding({
          bindingHandle,
          disposition: "create",
          workspaceDirectory: "/private/catalog-change",
          mcpServers: [],
          configuration: { model: "model-current", options: [] },
        });
        return {
          passedBehaviors: ["initial"],
          modelCatalog: binding.modelCatalog,
          bindingEstablished: true,
        };
      },
      async runRecoveryProbe({ client, bindingHandle }) {
        const binding = await client.ensureBinding({
          bindingHandle,
          disposition: "load",
          workspaceDirectory: "/private/catalog-change",
          mcpServers: [],
          configuration: { model: "model-current", options: [] },
        });
        return {
          passedBehaviors: ["recovery"],
          modelCatalog: binding.modelCatalog,
          bindingEstablished: true,
        };
      },
    };

    await expect(composition.checkReadiness(request)).resolves.toMatchObject({
      available: true,
      modelCatalog: [
        { modelId: "model-current", label: "Current" },
        { modelId: "model-new", label: "New" },
      ],
    });
    await composition.close();
  });

  it("inspects a real ACP session model catalog without issuing a behavior qualification", async () => {
    const { composition, children } = createHarness();

    await expect(composition.inspectModelCatalog({
      profile: profile([]),
      descriptor: {
        descriptorId: "settings-model-catalog",
        discoverCurrent: async () => artifact("a"),
      },
      role: "worker",
      requiredAcpCapabilities: ["session_new", "session_close"],
      workspaceDirectory: "/private/settings-model-catalog",
      createConnection: () => connectionFactory(initializeResponse()),
    })).resolves.toEqual({
      available: true,
      modelCatalog: [{ modelId: "model-current", label: "Current" }],
      unavailableReasons: [],
    });
    expect(children).toHaveLength(1);
    await composition.close();
  });

  it("preserves a safe diagnostic from actual target Binding establishment", async () => {
    const { composition } = createHarness();
    const request: AcpProviderQualificationRequest = {
      profile: profile([]),
      descriptor: {
        descriptorId: "target-binding-safe-diagnostic",
        discoverCurrent: async () => artifact("a"),
      },
      role: "worker",
      requiredAcpCapabilities: ["session_new", "session_prompt", "session_cancel", "session_update"],
      requiredBehaviors: ["managed_session_core"],
      createConnection: () => connectionFactory(initializeResponse()),
      runProbe: async ({ client, bindingHandle }) => {
        await client.ensureBinding({
          bindingHandle,
          disposition: "create",
          workspaceDirectory: "/private/qualification-target-diagnostic",
          mcpServers: [],
          configuration: { model: "model-current", options: [] },
        });
        return { passedBehaviors: ["managed_session_core"], bindingEstablished: true };
      },
      establishTargetBinding: async () => {
        throw Object.assign(new Error("unsafe /private/provider diagnostic"), {
          code: "acp_binding_effect_failed",
          diagnosticCode: "acp_binding_session_configuration_failed",
        });
      },
    };

    const opened = await composition.openBinding({
      ...request,
      bindingHandle: "binding_handle_target-safe-diagnostic",
    });

    expect(opened).toMatchObject({
      available: false,
      report: {
        unavailableReasons: [
          "acp_binding_effect_failed",
          "acp_binding_session_configuration_failed",
        ],
      },
    });
    expect(JSON.stringify(opened)).not.toContain("/private/provider");
    await composition.close();
  });

  it("reserves credential, process, and prompt budgets at the real effect boundaries", async () => {
    const effects: string[] = [];
    let promptWireEffects = 0;
    const processes = createAcpAgentProcessFactory({
      spawn: () => new FakeChild(),
      signalChild: (child, signal) => child.kill(signal),
      terminationGraceMs: 20,
      killConfirmationMs: 20,
    });
    const composition = createAcpProviderComposition({
      processes,
      operationTimeoutMs: 100,
      beforeQualificationEffect(effect) {
        expect(Object.keys(effect).sort()).toEqual(["kind", "profileRevisionId", "role"]);
        effects.push(effect.kind);
        if (effect.kind === "model_prompt_submission") {
          throw new Error("qualification_budget_exhausted");
        }
        return undefined;
      },
    });
    const connect: AcpV1ConnectionFactory = () => ({
      initialize: async () => initializeResponse(),
      newSession: async () => ({
        sessionId: "raw-session-budget-private",
        configOptions: [{
          id: "raw-model-option-budget-private",
          category: "model",
          type: "select",
          currentValue: "model-current",
          options: [{ value: "model-current", name: "Current" }],
        }],
      }),
      loadSession: async () => { throw new Error("unexpected_load"); },
      resumeSession: async () => { throw new Error("unexpected_resume"); },
      prompt: async () => {
        promptWireEffects += 1;
        return { stopReason: "end_turn" };
      },
      cancel: async () => undefined,
      closeSession: async () => ({}),
    });
    const report = await composition.checkReadiness({
      profile: profile([]),
      descriptor: {
        descriptorId: "qualification-budget-current",
        discoverCurrent: async () => artifact("a"),
      },
      role: "worker",
      requiredAcpCapabilities: ["session_new", "session_prompt", "session_cancel", "session_update"],
      requiredBehaviors: ["managed_session_core"],
      createConnection: () => connect,
      beginCredentialAcquisition: () => ({
        lease: Promise.resolve(Object.freeze({
          environment: Object.freeze({}),
          revoke: async () => undefined,
        })),
        cancelAndWait: async () => Object.freeze({ credentialCleanupConfirmed: true }),
      }),
      runProbe: async ({ client, bindingHandle }) => {
        await client.ensureBinding({
          bindingHandle,
          disposition: "create",
          workspaceDirectory: "/private/qualification-budget",
          mcpServers: [],
          configuration: { model: "model-current", options: [] },
        });
        await client.submitPrompt({
          bindingHandle,
          attemptId: "session_execution_attempt_qualification_budget",
          content: "private qualification prompt",
        });
        return { passedBehaviors: ["managed_session_core"], bindingEstablished: true };
      },
    });

    expect(report.available).toBe(false);
    expect(effects).toEqual([
      "credential_lease_acquisition",
      "process_generation_start",
      "model_prompt_submission",
    ]);
    expect(promptWireEffects).toBe(0);
    expect(JSON.stringify(effects)).not.toContain("/private/");
    await composition.close();
  });

  it("rejects async budget hooks synchronously before each corresponding external effect", async () => {
    for (const blockedKind of [
      "credential_lease_acquisition",
      "process_generation_start",
      "model_prompt_submission",
    ] as const) {
      let acquisitionEffects = 0;
      let promptWireEffects = 0;
      let credentialCleanupEffects = 0;
      const unhandled: unknown[] = [];
      const onUnhandled = (error: unknown) => { unhandled.push(error); };
      process.on("unhandledRejection", onUnhandled);
      const children: FakeChild[] = [];
      const processes = createAcpAgentProcessFactory({
        spawn: () => {
          const child = new FakeChild();
          children.push(child);
          return child;
        },
        signalChild: (child, signal) => child.kill(signal),
        terminationGraceMs: 20,
        killConfirmationMs: 20,
      });
      const asyncBudget = ((effect: Parameters<AcpQualificationEffectBudget>[0]) => {
        if (effect.kind !== blockedKind) return undefined;
        return Promise.reject(new Error("async_budget_forbidden"));
      }) as unknown as AcpQualificationEffectBudget;
      const composition = createAcpProviderComposition({
        processes,
        operationTimeoutMs: 100,
        beforeQualificationEffect: asyncBudget,
      });
      const connect: AcpV1ConnectionFactory = () => ({
        initialize: async () => initializeResponse(),
        newSession: async () => ({
          sessionId: "raw-session-async-budget-private",
          configOptions: [{
            id: "raw-model-option-async-budget-private",
            category: "model",
            type: "select",
            currentValue: "model-current",
            options: [{ value: "model-current", name: "Current" }],
          }],
        }),
        loadSession: async () => { throw new Error("unexpected_load"); },
        resumeSession: async () => { throw new Error("unexpected_resume"); },
        prompt: async () => {
          promptWireEffects += 1;
          return { stopReason: "end_turn" };
        },
        cancel: async () => undefined,
        closeSession: async () => ({}),
      });
      try {
        const report = await composition.checkReadiness({
          profile: profile([]),
          descriptor: {
            descriptorId: `async-budget-${blockedKind}`,
            discoverCurrent: async () => artifact("a"),
          },
          role: "worker",
          requiredAcpCapabilities: ["session_new", "session_prompt", "session_cancel", "session_update"],
          requiredBehaviors: ["managed_session_core"],
          createConnection: () => connect,
          beginCredentialAcquisition: () => {
            acquisitionEffects += 1;
            return {
              lease: Promise.resolve(Object.freeze({
                environment: Object.freeze({}),
                revoke: async () => { credentialCleanupEffects += 1; },
              })),
              cancelAndWait: async () => {
                credentialCleanupEffects += 1;
                return Object.freeze({ credentialCleanupConfirmed: true });
              },
            };
          },
          runProbe: async ({ client, bindingHandle }) => {
            await client.ensureBinding({
              bindingHandle,
              disposition: "create",
              workspaceDirectory: "/private/async-budget",
              mcpServers: [],
              configuration: { model: "model-current", options: [] },
            });
            await client.submitPrompt({
              bindingHandle,
              attemptId: "session_execution_attempt_async_budget",
              content: "private qualification prompt",
            });
            return { passedBehaviors: ["managed_session_core"], bindingEstablished: true };
          },
        });
        expect(report.available, blockedKind).toBe(false);
        expect(acquisitionEffects, blockedKind).toBe(
          blockedKind === "credential_lease_acquisition" ? 0 : 1,
        );
        expect(children, blockedKind).toHaveLength(
          blockedKind === "model_prompt_submission" ? 1 : 0,
        );
        expect(promptWireEffects, blockedKind).toBe(0);
        if (blockedKind !== "credential_lease_acquisition") {
          expect(credentialCleanupEffects, blockedKind).toBeGreaterThan(0);
        }
        await composition.close();
        await Promise.resolve();
        expect(unhandled, blockedKind).toEqual([]);
      } finally {
        process.off("unhandledRejection", onUnhandled);
      }
    }
  });

  it("mints safe checkpoint facts only from exact target events after confirmed cleanup", async () => {
    const factCapabilities: AcpTargetCheckpointFactCapability[] = [];
    let checkpointObserver: AcpTargetCheckpointObserver | undefined;
    const processes = createAcpAgentProcessFactory({
      spawn: () => new FakeChild(),
      signalChild: (child, signal) => child.kill(signal),
      terminationGraceMs: 20,
      killConfirmationMs: 20,
    });
    const composition = createAcpProviderComposition({
      processes,
      operationTimeoutMs: 100,
      onTargetLifecycleCapability() {},
      onTargetCheckpointFactCapability(notice) {
        expect(notice.bindingHandle).toBe("binding_handle_checkpoint_target");
        factCapabilities.push(notice.capability);
      },
    });
    const connect: AcpV1ConnectionFactory = (handlers) => {
      const bindingResponse = () => ({
        sessionId: "raw-session-checkpoint-private",
        configOptions: [{
          id: "raw-config-checkpoint-private",
          category: "model",
          type: "select",
          currentValue: "model-current",
          options: [{ value: "model-current", name: "Current" }],
        }],
      });
      return {
        initialize: async () => initializeResponse(),
        newSession: async () => bindingResponse(),
        loadSession: async () => bindingResponse(),
        resumeSession: async () => bindingResponse(),
        prompt: async (value: unknown) => {
          const raw = value as { sessionId: string };
          await handlers.sessionUpdate({
            sessionId: raw.sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "private checkpoint final" },
            },
          });
          return { stopReason: "end_turn" };
        },
        cancel: async () => undefined,
        closeSession: async () => ({}),
      };
    };
    const request: AcpProviderQualificationRequest = {
      profile: profile([]),
      descriptor: {
        descriptorId: "target-checkpoint-current",
        discoverCurrent: async () => artifact("a"),
      },
      role: "conductor",
      requiredAcpCapabilities: ["session_new", "session_prompt", "session_cancel", "session_update"],
      requiredBehaviors: ["managed_session_core"],
      createConnection: () => connect,
      runProbe: async ({ client, bindingHandle }) => {
        await client.ensureBinding({
          bindingHandle,
          disposition: "create",
          workspaceDirectory: "/private/checkpoint-probe",
          mcpServers: [],
          configuration: { model: "model-current", options: [] },
        });
        return { passedBehaviors: ["managed_session_core"], bindingEstablished: true };
      },
      establishTargetBinding: async (context) => {
        checkpointObserver = context.checkpointObserver;
        await context.client.ensureBinding({
          bindingHandle: context.bindingHandle,
          disposition: "create",
          workspaceDirectory: "/private/checkpoint-target",
          mcpServers: [],
          configuration: { model: "model-current", options: [] },
        });
        return { bindingEstablished: true };
      },
    };
    const opened = await composition.openBinding({
      ...request,
      bindingHandle: "binding_handle_checkpoint_target",
    });
    if (!opened.available || !checkpointObserver) throw new Error(`expected checkpoint observer:${JSON.stringify(opened)}`);
    const observer = checkpointObserver;
    const attemptId = "session_execution_attempt_checkpoint_target";
    await opened.runtime.client.submitPrompt({
      bindingHandle: opened.runtime.bindingHandle,
      attemptId,
      content: "target content remains private",
    });
    expect(() => observer.observe({
      kind: "task_cancel_accepted",
      bindingHandle: "binding_handle_checkpoint_other",
      attemptId,
      role: "conductor",
    })).toThrow("acp_target_checkpoint_event_scope_mismatch");
    expect(() => observer.observe({
      kind: "task_cancel_accepted",
      bindingHandle: opened.runtime.bindingHandle,
      attemptId,
      role: "publisher",
    })).toThrow("acp_target_checkpoint_event_scope_mismatch");
    observer.observe({
      kind: "task_scoped_mcp_call",
      bindingHandle: opened.runtime.bindingHandle,
      attemptId,
      role: "conductor",
      toolName: "send_to_session",
    });
    observer.observe({
      kind: "task_cancel_accepted",
      bindingHandle: opened.runtime.bindingHandle,
      attemptId,
      role: "conductor",
    });
    observer.observe({
      kind: "task_reconcile_settled",
      bindingHandle: opened.runtime.bindingHandle,
      attemptId,
      role: "conductor",
    });
    expect(factCapabilities).toEqual([]);
    await opened.runtime.releaseBinding();
    await opened.runtime.close();

    const facts = factCapabilities.map(claimAcpTargetCheckpointFactObservation);
    expect(facts.map(({ kind }) => kind).sort()).toEqual([
      "actual_binding_generation",
      "cancel_reconcile",
      "latest_final_terminal_pair",
      "prompt_receipt",
      "scoped_mcp_call",
    ]);
    expect(facts.every((fact) => fact.role === "conductor"
      && fact.processGenerationDigest.startsWith("sha256:")
      && fact.observationDigest.startsWith("sha256:"))).toBe(true);
    expect(() => claimAcpTargetCheckpointFactObservation(factCapabilities[0]))
      .toThrow("acp_target_checkpoint_fact_capability_already_claimed");
    const serialized = JSON.stringify(facts);
    for (const forbidden of [
      "/private/checkpoint-probe",
      "/private/checkpoint-target",
      "binding_handle_checkpoint_target",
      "raw-session-checkpoint-private",
      "raw-config-checkpoint-private",
      "private checkpoint final",
      attemptId,
      "target content remains private",
    ]) expect(serialized).not.toContain(forbidden);
    await composition.close();
  });

  it("mints an exact-once safe target lifecycle capability only after actual prompt and confirmed cleanup", async () => {
    const children: FakeChild[] = [];
    const capabilities: AcpTargetLifecycleCapability[] = [];
    const processes = createAcpAgentProcessFactory({
      spawn: () => {
        const child = new FakeChild();
        children.push(child);
        return child;
      },
      signalChild: (child, signal) => child.kill(signal),
      terminationGraceMs: 20,
      killConfirmationMs: 20,
    });
    const composition = createAcpProviderComposition({
      processes,
      operationTimeoutMs: 100,
      onTargetLifecycleCapability(notice) {
        expect(notice.bindingHandle).toBe("binding_handle_actual_target_lifecycle");
        capabilities.push(notice.capability);
      },
    });
    const descriptor: AcpCurrentInstallDescriptor = {
      descriptorId: "target-lifecycle-current",
      discoverCurrent: async () => artifact("a"),
    };
    const connect: AcpV1ConnectionFactory = (handlers) => {
      const bindingResponse = () => ({
        sessionId: "raw-session-target-lifecycle-private",
        configOptions: [{
          id: "raw-config-model-private",
          category: "model",
          type: "select",
          currentValue: "model-current",
          options: [{ value: "model-current", name: "Current" }],
        }],
      });
      return {
        initialize: async () => initializeResponse(),
        newSession: async () => bindingResponse(),
        loadSession: async () => bindingResponse(),
        resumeSession: async () => bindingResponse(),
        prompt: async (request: unknown) => {
          const raw = request as { sessionId: string };
          await handlers.sessionUpdate({
            sessionId: raw.sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              messageId: "raw-message-target-lifecycle-private",
              content: { type: "text", text: "private final body must never enter lifecycle evidence" },
            },
          });
          return { stopReason: "end_turn" };
        },
        cancel: async () => undefined,
        closeSession: async () => ({}),
      };
    };
    const request: AcpProviderQualificationRequest = {
      profile: profile([]),
      descriptor,
      role: "worker",
      requiredAcpCapabilities: ["session_new", "session_prompt", "session_cancel", "session_update"],
      requiredBehaviors: ["managed_session_core"],
      createConnection: () => connect,
      runProbe: async ({ client, bindingHandle }) => {
        await client.ensureBinding({
          bindingHandle,
          disposition: "create",
          workspaceDirectory: "/private/qualification-only",
          mcpServers: [],
          configuration: { model: "model-current", options: [] },
        });
        return { passedBehaviors: ["managed_session_core"], bindingEstablished: true };
      },
      establishTargetBinding: async ({ client, bindingHandle }) => {
        await client.ensureBinding({
          bindingHandle,
          disposition: "create",
          workspaceDirectory: "/private/actual-target",
          mcpServers: [],
          configuration: { model: "model-current", options: [] },
        });
        return Object.freeze({ bindingEstablished: true as const });
      },
    };

    await expect(composition.checkReadiness(request)).resolves.toMatchObject({ available: true });
    expect(capabilities).toHaveLength(0);

    const opened = await composition.openBinding({
      ...request,
      bindingHandle: "binding_handle_actual_target_lifecycle",
    });
    if (!opened.available) throw new Error(JSON.stringify(opened.report));
    expect(capabilities).toHaveLength(0);
    await opened.runtime.client.submitPrompt({
      bindingHandle: opened.runtime.bindingHandle,
      attemptId: "session_execution_attempt_actual_target_lifecycle",
      content: "private prompt body must never enter lifecycle evidence",
    });
    expect(capabilities).toHaveLength(0);
    await opened.runtime.releaseBinding();
    expect(capabilities).toHaveLength(0);
    await opened.runtime.close();
    expect(capabilities).toHaveLength(1);

    const observation = claimAcpTargetLifecycleObservation(capabilities[0]);
    expect(observation).toMatchObject({
      schemaVersion: 1,
      evidenceClass: "host_target_lifecycle_observation",
      profileRevisionId: "profile_revision_composition",
      providerFamily: "opencode",
      acpAgentKind: "native_acp",
      role: "worker",
      model: "model-current",
      initialize: {
        protocolMajor: 1,
        capabilities: expect.arrayContaining(["session_new", "session_prompt"]),
      },
      actualPrompt: {
        receiptObserved: true,
        finalObserved: true,
        terminalObserved: true,
      },
      cleanup: {
        bindingReleaseConfirmed: true,
        processExitConfirmed: true,
        credentialCleanupConfirmed: true,
        capabilityCleanupConfirmed: true,
      },
    });
    expect(observation.profileConfigurationDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(observation.resolutionSealDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(observation.processGenerationDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(observation.qualificationProbeDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(observation.actualPrompt.attemptCorrelationDigest)
      .toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(observation.cleanup.receiptDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(() => claimAcpTargetLifecycleObservation(capabilities[0])).toThrow(
      "acp_target_lifecycle_capability_already_claimed",
    );
    const serialized = JSON.stringify(observation);
    for (const forbidden of [
      "/private/qualification-only",
      "/private/actual-target",
      "raw-session-target-lifecycle-private",
      "raw-config-model-private",
      "raw-message-target-lifecycle-private",
      "session_execution_attempt_actual_target_lifecycle",
      "private final body",
      "private prompt body",
    ]) expect(serialized).not.toContain(forbidden);
    expect(children).toHaveLength(2);
    await composition.close();
  });

  it("single-flights and caches only a safe readiness report, then requalifies current artifact drift", async () => {
    const harness = createHarness();
    let current = artifact("a");
    const descriptor: AcpCurrentInstallDescriptor = {
      descriptorId: "opencode-current",
      discoverCurrent: async () => current,
    };
    let releaseProbe!: () => void;
    const probeGate = new Promise<void>((resolve) => { releaseProbe = resolve; });
    let probes = 0;
    const request: AcpProviderQualificationRequest = {
      profile: profile(),
      descriptor,
      role: "worker",
      requiredAcpCapabilities: ["session_new", "session_prompt", "session_cancel", "session_update", "session_load"],
      requiredBehaviors: ["managed_session_core"],
      createConnection: () => connectionFactory(initializeResponse()),
      runProbe: async ({ client, bindingHandle }) => {
        probes += 1;
        if (probes === 1) await probeGate;
        await client.ensureBinding({
          bindingHandle,
          disposition: "create",
          workspaceDirectory: "/private/workspaces/readiness",
          mcpServers: [],
          configuration: { model: "model-current", options: [] },
        });
        return {
          passedBehaviors: ["managed_session_core"],
          safeObservations: { managedCore: true },
          bindingEstablished: true,
        };
      },
    };

    const first = harness.composition.checkReadiness(request);
    const replay = harness.composition.checkReadiness(request);
    releaseProbe();
    const [report, replayReport] = await Promise.all([first, replay]);
    expect(replayReport).toEqual(report);
    expect(report).toMatchObject({
      available: true,
      observedArtifactVersion: "future-a",
      observedUpstreamVersion: "upstream-a",
      extensions: expect.arrayContaining(["session/load"]),
      agent: { name: "future-agent", version: "999.0.0-next" },
    });
    expect(harness.children).toHaveLength(1);
    await expect(harness.composition.checkReadiness(request)).resolves.toEqual(report);
    expect(harness.children).toHaveLength(1);

    current = artifact("b");
    await expect(harness.composition.checkReadiness(request)).resolves.toMatchObject({
      available: true,
      observedArtifactVersion: "future-b",
      observedUpstreamVersion: "upstream-b",
    });
    expect(harness.children).toHaveLength(2);
    expect(probes).toBe(2);
    const serialized = JSON.stringify(report);
    for (const secret of [
      "/private/current/a/opencode",
      current.artifactDigest,
      "raw-session-private",
    ]) expect(serialized).not.toContain(secret);
    await harness.composition.close();
  });

  it("grants a custom _meta extension only through the descriptor's exact predicate", async () => {
    const withPredicate = createHarness();
    let probes = 0;
    const descriptor: AcpCurrentInstallDescriptor = {
      descriptorId: "opencode-custom-extension",
      discoverCurrent: async () => artifact("a"),
      extensionPredicates: {
        "vendor/session-tools": (response) => (
          Boolean((response as { _meta?: { vendorTools?: boolean } })._meta?.vendorTools)
        ),
      },
    };
    const request: AcpProviderQualificationRequest = {
      profile: profile(["vendor/session-tools"]),
      descriptor,
      role: "worker",
      requiredAcpCapabilities: ["session_new"],
      requiredBehaviors: [],
      createConnection: () => connectionFactory(initializeResponse({
        _meta: { vendorTools: true, unknownSecret: "/private/must-not-project" },
      })),
      runProbe: async () => {
        probes += 1;
        return { passedBehaviors: [], bindingEstablished: false };
      },
    };
    await expect(withPredicate.composition.checkReadiness(request)).resolves.toMatchObject({
      available: false,
      extensions: expect.arrayContaining(["vendor/session-tools"]),
      qualificationClass: "structural",
      unavailableReasons: ["acp_behavior_baseline_unproven"],
    });
    expect(probes).toBe(1);

    const withoutPredicate = createHarness();
    await expect(withoutPredicate.composition.checkReadiness({
      ...request,
      descriptor: {
        descriptorId: "opencode-custom-extension-unproven",
        discoverCurrent: async () => artifact("a"),
      },
    })).resolves.toMatchObject({
      available: false,
      extensions: expect.arrayContaining(["session/load"]),
      unavailableReasons: ["acp_extension_missing:vendor/session-tools"],
    });
    expect(probes).toBe(1);
    await withPredicate.composition.close();
    await withoutPredicate.composition.close();
  });

  it("does not reuse readiness across same-id descriptor and qualification-plan objects", async () => {
    const harness = createHarness();
    let probes = 0;
    const makeRequest = (
      descriptor: AcpCurrentInstallDescriptor,
    ): AcpProviderQualificationRequest => ({
      profile: profile([]),
      descriptor,
      role: "worker",
      requiredAcpCapabilities: ["session_new"],
      requiredBehaviors: [],
      createConnection: () => connectionFactory(initializeResponse()),
      runProbe: async () => {
        probes += 1;
        return { passedBehaviors: [], bindingEstablished: false };
      },
    });
    const firstRequest = makeRequest({
      descriptorId: "same-public-descriptor-id",
      discoverCurrent: async () => artifact("a"),
    });
    const secondRequest = makeRequest({
      descriptorId: "same-public-descriptor-id",
      discoverCurrent: async () => artifact("b"),
    });

    const [first, second] = await Promise.all([
      harness.composition.checkReadiness(firstRequest),
      harness.composition.checkReadiness(secondRequest),
    ]);

    expect(first.observedArtifactVersion).toBe("future-a");
    expect(second.observedArtifactVersion).toBe("future-b");
    expect(harness.children).toHaveLength(2);
    expect(probes).toBe(2);
    await harness.composition.close();
  });

  it("requires an established Binding for every non-empty behavior qualification", async () => {
    const harness = createHarness();
    const report = await harness.composition.checkReadiness({
      profile: profile([]),
      descriptor: {
        descriptorId: "structural-only-probe",
        discoverCurrent: async () => artifact("a"),
      },
      role: "worker",
      requiredAcpCapabilities: ["session_new"],
      requiredBehaviors: ["managed_session_core"],
      createConnection: () => connectionFactory(initializeResponse()),
      runProbe: async () => ({
        passedBehaviors: ["managed_session_core"],
        bindingEstablished: false,
      }),
    });

    expect(report).toMatchObject({
      available: false,
      unavailableReasons: ["acp_behavior_binding_unproven"],
    });
    await harness.composition.close();
  });

  it("releases an exact Binding when a probe throws after establishment", async () => {
    const harness = createHarness();
    let attempts = 0;
    const request: AcpProviderQualificationRequest = {
      profile: profile([]),
      descriptor: {
        descriptorId: "probe-cleanup-current",
        discoverCurrent: async () => artifact("a"),
      },
      role: "worker",
      requiredAcpCapabilities: ["session_new"],
      requiredBehaviors: ["managed_session_core"],
      createConnection: () => connectionFactory(initializeResponse()),
      runProbe: async ({ client, bindingHandle }) => {
        attempts += 1;
        await client.ensureBinding({
          bindingHandle,
          disposition: "create",
          workspaceDirectory: "/private/workspaces/retry",
          mcpServers: [],
          configuration: { model: "model-current", options: [] },
        });
        if (attempts === 1) throw new Error("probe failed after private Binding allocation");
        return {
          passedBehaviors: ["managed_session_core"],
          bindingEstablished: true,
        };
      },
    };

    await expect(harness.composition.openBinding({
      ...request,
      bindingHandle: "binding_handle_probe_retry",
    })).resolves.toMatchObject({
      available: false,
      report: { unavailableReasons: ["acp_behavior_probe_failed"] },
    });
    const retry = await harness.composition.openBinding({
      ...request,
      bindingHandle: "binding_handle_probe_retry",
    });
    expect(retry.available).toBe(true);
    if (retry.available) await retry.runtime.close();
    expect(attempts).toBe(2);
    await harness.composition.close();
  });

  it("opens one qualified Binding runtime with generation-scoped reverse RPC and invalidates it on drift", async () => {
    const harness = createHarness();
    let current = artifact("a");
    let observedLease: AcpReverseRpcLease | undefined;
    const request: AcpProviderQualificationRequest = {
      profile: profile(),
      descriptor: {
        descriptorId: "opencode-current",
        discoverCurrent: async () => current,
      },
      role: "publisher",
      requiredAcpCapabilities: ["session_new", "session_load"],
      requiredBehaviors: ["publisher_workspace"],
      workspaceDirectory: "/private/workspaces/task",
      createConnection: () => connectionFactory(initializeResponse()),
      createReverseRpcRegistration: () => ({
        workspace: {
          workspaceId: "workspace_task",
          workspaceRoot: "/private/workspaces/task",
          readTextFile: async () => ({ content: "ok" }),
          writeTextFile: async () => ({}),
        },
      }),
      runProbe: async ({ client, bindingHandle, reverseRpcLease }) => {
        observedLease = reverseRpcLease;
        await client.ensureBinding({
          bindingHandle,
          disposition: "create",
          workspaceDirectory: "/private/workspaces/task",
          mcpServers: [],
          configuration: { model: "model-current", options: [] },
        });
        return {
          passedBehaviors: ["publisher_workspace"],
          safeObservations: { pathCrossingRejected: true },
          bindingEstablished: true,
        };
      },
    };

    const opened = await harness.composition.openBinding({
      ...request,
      bindingHandle: "binding_handle_task",
    });
    expect(opened.available).toBe(true);
    if (!opened.available) throw new Error("expected runtime");
    await expect(opened.runtime.assertQualified()).resolves.toBeUndefined();
    expect(observedLease?.safeObservation()).toMatchObject({ availability: "active" });

    current = artifact("b");
    await expect(opened.runtime.assertQualified()).rejects.toMatchObject({
      code: "acp_current_artifact_drift",
    });
    await opened.runtime.close();
    expect(observedLease?.safeObservation()).toMatchObject({ availability: "closed" });
    await harness.composition.close();
  });

  it("rebinds reverse RPC from the temporary probe to the exact target Binding", async () => {
    const harness = createHarness();
    const targetBindingHandle = "binding_handle_target_rebind";
    let probeLease: AcpReverseRpcLease | undefined;
    let targetLease: AcpReverseRpcLease | undefined;
    let dispatched = 0;
    const registration = () => ({
      mcp: {
        leaseId: "mcp_lease_target_rebind",
        allowedServerNames: ["scoped-runtime"],
        async dispatch() {
          dispatched += 1;
          return Object.freeze({ accepted: true });
        },
      },
    });

    const opened = await harness.composition.openBinding({
      bindingHandle: targetBindingHandle,
      profile: profile(),
      descriptor: {
        descriptorId: "target-rebind-current",
        discoverCurrent: async () => artifact("a"),
      },
      role: "conductor",
      requiredAcpCapabilities: ["session_new", "session_load"],
      requiredBehaviors: ["conductor_scoped_runtime"],
      workspaceDirectory: "/private/workspaces/target-rebind",
      createConnection: () => connectionFactory(initializeResponse()),
      createReverseRpcRegistration: registration,
      runProbe: async ({ client, bindingHandle, reverseRpcLease }) => {
        expect(bindingHandle).not.toBe(targetBindingHandle);
        expect(reverseRpcLease?.bindingHandle).toBe(bindingHandle);
        probeLease = reverseRpcLease;
        await client.ensureBinding({
          bindingHandle,
          disposition: "create",
          workspaceDirectory: "/private/workspaces/target-rebind-probe",
          mcpServers: [],
          configuration: { model: "model-current", options: [] },
        });
        return {
          passedBehaviors: ["conductor_scoped_runtime"],
          bindingEstablished: true,
        };
      },
      establishTargetBinding: async ({ client, bindingHandle, reverseRpcLease }) => {
        expect(bindingHandle).toBe(targetBindingHandle);
        expect(reverseRpcLease?.bindingHandle).toBe(targetBindingHandle);
        targetLease = reverseRpcLease;
        await client.ensureBinding({
          bindingHandle,
          disposition: "create",
          workspaceDirectory: "/private/workspaces/target-rebind",
          mcpServers: [],
          configuration: { model: "model-current", options: [] },
        });
        reverseRpcLease?.activateAttempt({
          attemptId: "attempt_target_rebind_runtime",
          mcpLeaseId: "mcp_lease_target_rebind",
          interactionRevision: 1,
        });
        await reverseRpcLease?.dispatchMcp({
          attemptId: "attempt_target_rebind_runtime",
          leaseId: "mcp_lease_target_rebind",
          serverName: "scoped-runtime",
          method: "tools/call",
          params: {},
        });
        await reverseRpcLease?.deactivateAttempt();
        return Object.freeze({ bindingEstablished: true as const });
      },
    });

    if (!opened.available) throw new Error(JSON.stringify(opened.report));
    expect(opened.available).toBe(true);
    expect(probeLease).not.toBe(targetLease);
    expect(probeLease?.safeObservation()).toMatchObject({ availability: "closed" });
    expect(opened.runtime.reverseRpcLease).toBe(targetLease);
    expect(dispatched).toBe(1);
    await opened.runtime.releaseBinding();
    await opened.runtime.close();
    await harness.composition.close();
  });

  it("turns raw probe failures into a bounded safe unavailable report", async () => {
    const harness = createHarness();
    const report = await harness.composition.checkReadiness({
      profile: profile(),
      descriptor: {
        descriptorId: "opencode-current",
        discoverCurrent: async () => artifact("a"),
      },
      role: "worker",
      requiredAcpCapabilities: ["session_new", "session_load"],
      requiredBehaviors: ["managed_session_core"],
      createConnection: () => connectionFactory(initializeResponse()),
      runProbe: async () => { throw new Error("raw failure at /private/workspaces/secret"); },
    });
    expect(report).toMatchObject({
      available: false,
      unavailableReasons: ["acp_behavior_probe_failed"],
    });
    expect(JSON.stringify(report)).not.toContain("/private/workspaces/secret");
    await harness.composition.close();
  });

  it("preserves a typed safe probe failure code without exposing its message", async () => {
    const harness = createHarness();
    const failure = Object.assign(
      new Error("typed failure at /private/workspaces/secret"),
      { code: "codex_acp_scoped_tool_behavior_unproven" },
    );
    const report = await harness.composition.checkReadiness({
      profile: profile(),
      descriptor: {
        descriptorId: "opencode-current",
        discoverCurrent: async () => artifact("a"),
      },
      role: "worker",
      requiredAcpCapabilities: ["session_new", "session_load"],
      requiredBehaviors: ["managed_session_core"],
      createConnection: () => connectionFactory(initializeResponse()),
      runProbe: async () => { throw failure; },
    });
    expect(report).toMatchObject({
      available: false,
      unavailableReasons: [
        "acp_behavior_probe_failed",
        "codex_acp_scoped_tool_behavior_unproven",
      ],
    });
    expect(JSON.stringify(report)).not.toContain("/private/workspaces/secret");
    await harness.composition.close();
  });

  it("preserves a safe nested prompt diagnostic while keeping terminal ambiguity primary", async () => {
    const harness = createHarness();
    const failure = Object.assign(
      new Error("acp_prompt_terminal_ambiguous"),
      {
        code: "acp_prompt_terminal_ambiguous",
        diagnosticCode: "acp_stdio_prompt_auth_required",
      },
    );
    const report = await harness.composition.checkReadiness({
      profile: profile(),
      descriptor: {
        descriptorId: "opencode-current",
        discoverCurrent: async () => artifact("a"),
      },
      role: "worker",
      requiredAcpCapabilities: ["session_new", "session_load"],
      requiredBehaviors: ["managed_session_core"],
      createConnection: () => connectionFactory(initializeResponse()),
      runProbe: async () => { throw failure; },
    });
    expect(report).toMatchObject({
      available: false,
      unavailableReasons: [
        "acp_behavior_probe_failed",
        "acp_prompt_terminal_ambiguous",
        "acp_stdio_prompt_auth_required",
      ],
    });
    expect(JSON.stringify(report)).not.toContain("/private/agent-secret");
    await harness.composition.close();
  });

  it("omits unsafe embedded agent paths from unavailable SafeReports", async () => {
    const harness = createHarness();
    const report = await harness.composition.checkReadiness({
      profile: profile([]),
      descriptor: {
        descriptorId: "unsafe-agent-safe-report",
        discoverCurrent: async () => artifact("a"),
      },
      role: "worker",
      requiredAcpCapabilities: ["session_new"],
      requiredBehaviors: ["managed_session_core"],
      createConnection: () => connectionFactory(initializeResponse({
        agentInfo: {
          name: "agent at /private/raw-launcher",
          title: "file:///Users/alice/private-token",
          version: "999.0.0",
        },
      })),
      runProbe: async () => ({
        passedBehaviors: ["managed_session_core"],
        bindingEstablished: false,
      }),
    });

    expect(report.available).toBe(false);
    expect(report.agent).toBeUndefined();
    expect(JSON.stringify(report)).not.toContain("/private/raw-launcher");
    expect(JSON.stringify(report)).not.toContain("file://");
    await harness.composition.close();
  });

  it("waits for owned credential cancellation before reporting an acquisition timeout", async () => {
    let cancellations = 0;
    const composition = createAcpProviderComposition({ operationTimeoutMs: 5 });
    const neverLease = new Promise<never>(() => undefined);
    const request: AcpProviderQualificationRequest = {
      profile: profile(),
      descriptor: {
        descriptorId: "credential-acquisition-timeout",
        discoverCurrent: async () => artifact("a"),
      },
      role: "worker",
      requiredAcpCapabilities: ["session_new"],
      requiredBehaviors: ["managed_session_core"],
      beginCredentialAcquisition: () => ({
        lease: neverLease,
        cancelAndWait: async () => {
          cancellations += 1;
          return { credentialCleanupConfirmed: true };
        },
      }),
      createConnection: () => connectionFactory(initializeResponse()),
      runProbe: async () => ({
        passedBehaviors: ["managed_session_core"],
        bindingEstablished: true,
      }),
    };

    await expect(composition.checkReadiness(request)).resolves.toMatchObject({
      available: false,
      unavailableReasons: ["acp_credential_acquisition_timeout"],
    });
    expect(cancellations).toBe(1);
    await composition.close();
  });

  it("poisons the composition when credential acquisition cleanup cannot be confirmed", async () => {
    let beginCalls = 0;
    const composition = createAcpProviderComposition({
      operationTimeoutMs: 5,
      readinessTtlMs: 0,
    });
    const never = new Promise<never>(() => undefined);
    const request: AcpProviderQualificationRequest = {
      profile: profile(),
      descriptor: {
        descriptorId: "credential-cleanup-unconfirmed",
        discoverCurrent: async () => artifact("a"),
      },
      role: "worker",
      requiredAcpCapabilities: ["session_new"],
      requiredBehaviors: ["managed_session_core"],
      beginCredentialAcquisition: () => {
        beginCalls += 1;
        return { lease: never, cancelAndWait: () => never };
      },
      createConnection: () => connectionFactory(initializeResponse()),
      runProbe: async () => ({
        passedBehaviors: ["managed_session_core"],
        bindingEstablished: true,
      }),
    };

    await expect(composition.checkReadiness(request)).resolves.toMatchObject({
      available: false,
      unavailableReasons: ["acp_credential_cleanup_unconfirmed"],
    });
    await expect(composition.checkReadiness(request)).resolves.toMatchObject({
      available: false,
      unavailableReasons: ["acp_credential_cleanup_unconfirmed"],
    });
    expect(beginCalls).toBe(1);
    await expect(composition.close()).rejects.toMatchObject({
      code: "acp_credential_cleanup_unconfirmed",
    });
  });

  it("does not close while an owned credential acquisition is still cleaning up", async () => {
    let acquisitionStarted = false;
    let finishCancellation!: () => void;
    let rejectLease!: (error: Error) => void;
    const cancellationGate = new Promise<void>((resolve) => { finishCancellation = resolve; });
    const pendingLease = new Promise<never>((_resolve, reject) => { rejectLease = reject; });
    const composition = createAcpProviderComposition({ operationTimeoutMs: 50 });
    const request: AcpProviderQualificationRequest = {
      profile: profile(),
      descriptor: {
        descriptorId: "credential-close-cleanup",
        discoverCurrent: async () => artifact("a"),
      },
      role: "worker",
      requiredAcpCapabilities: ["session_new"],
      requiredBehaviors: ["managed_session_core"],
      beginCredentialAcquisition: () => {
        acquisitionStarted = true;
        return {
          lease: pendingLease,
          cancelAndWait: async () => {
            await cancellationGate;
            rejectLease(new Error("cancelled before credential ownership transfer"));
            return { credentialCleanupConfirmed: true };
          },
        };
      },
      createConnection: () => connectionFactory(initializeResponse()),
      runProbe: async () => ({
        passedBehaviors: ["managed_session_core"],
        bindingEstablished: true,
      }),
    };
    const readiness = composition.checkReadiness(request);
    while (!acquisitionStarted) await Promise.resolve();
    let closeSettled = false;
    const closing = composition.close().finally(() => { closeSettled = true; });
    await Promise.resolve();
    expect(closeSettled).toBe(false);

    finishCancellation();
    await expect(closing).resolves.toBeUndefined();
    await expect(readiness).resolves.toMatchObject({ available: false });
  });

  it("poisons the composition when a timed-out process open cannot confirm cancellation", async () => {
    let beginCalls = 0;
    const neverLease = new Promise<AcpAgentProcessLease>(() => undefined);
    const processes: AcpAgentProcessFactory = {
      beginOpen: () => {
        beginCalls += 1;
        return {
          lease: neverLease,
          cancelAndWait: () => new Promise(() => undefined),
        };
      },
      open: () => neverLease,
      close: async () => undefined,
    };
    const composition = createAcpProviderComposition({
      processes,
      operationTimeoutMs: 5,
      readinessTtlMs: 0,
    });
    const request: AcpProviderQualificationRequest = {
      profile: profile(),
      descriptor: {
        descriptorId: "unconfirmed-process-open",
        discoverCurrent: async () => artifact("a"),
      },
      role: "worker",
      requiredAcpCapabilities: ["session_new"],
      requiredBehaviors: ["managed_session_core"],
      createConnection: () => connectionFactory(initializeResponse()),
      runProbe: async () => ({
        passedBehaviors: ["managed_session_core"],
        bindingEstablished: true,
      }),
    };

    await expect(composition.checkReadiness(request)).resolves.toMatchObject({
      available: false,
      unavailableReasons: ["acp_process_open_cleanup_unconfirmed"],
    });
    await expect(composition.checkReadiness(request)).resolves.toMatchObject({
      available: false,
      unavailableReasons: ["acp_process_open_cleanup_unconfirmed"],
    });
    expect(beginCalls).toBe(1);
    await composition.close();
  });

  it("poisons after rejected-probe cleanup cannot confirm process exit", async () => {
    const harness = createHarness({ confirmChildClose: false, operationTimeoutMs: 60 });
    let probeCalls = 0;
    const request: AcpProviderQualificationRequest = {
      profile: profile([]),
      descriptor: {
        descriptorId: "rejected-probe-cleanup-unconfirmed",
        discoverCurrent: async () => artifact("a"),
      },
      role: "worker",
      requiredAcpCapabilities: ["session_new"],
      requiredBehaviors: ["managed_session_core"],
      createConnection: () => connectionFactory(initializeResponse()),
      runProbe: async ({ client, bindingHandle }) => {
        probeCalls += 1;
        await client.ensureBinding({
          bindingHandle,
          disposition: "create",
          workspaceDirectory: "/private/workspaces/cleanup",
          mcpServers: [],
          configuration: { model: "model-current", options: [] },
        });
        throw new Error("force rejected cleanup");
      },
    };

    const first = await harness.composition.checkReadiness(request);
    expect(first.available).toBe(false);
    expect(first.unavailableReasons).toContain("acp_agent_process_exit_unconfirmed");
    await expect(harness.composition.checkReadiness(request)).resolves.toMatchObject({
      available: false,
      unavailableReasons: ["acp_agent_process_exit_unconfirmed"],
    });
    expect(probeCalls).toBe(1);
    expect(harness.children).toHaveLength(1);
    await harness.composition.close().catch(() => undefined);
  });

  it("memoizes a rejected runtime close without restoring generation authority", async () => {
    const harness = createHarness({ confirmChildClose: false, operationTimeoutMs: 60 });
    const opened = await harness.composition.openBinding({
      bindingHandle: "binding_handle_sticky_close",
      profile: profile([]),
      descriptor: {
        descriptorId: "runtime-close-sticky",
        discoverCurrent: async () => artifact("a"),
      },
      role: "worker",
      requiredAcpCapabilities: ["session_new"],
      requiredBehaviors: ["managed_session_core"],
      createConnection: () => connectionFactory(initializeResponse()),
      runProbe: async ({ client, bindingHandle }) => {
        await client.ensureBinding({
          bindingHandle,
          disposition: "create",
          workspaceDirectory: "/private/workspaces/sticky-close",
          mcpServers: [],
          configuration: { model: "model-current", options: [] },
        });
        return {
          passedBehaviors: ["managed_session_core"],
          bindingEstablished: true,
        };
      },
    });
    expect(opened.available).toBe(true);
    if (!opened.available) throw new Error("expected runtime");

    const firstClose = opened.runtime.close();
    const replayClose = opened.runtime.close();
    expect(replayClose).toBe(firstClose);
    await expect(firstClose).rejects.toMatchObject({
      code: "acp_agent_process_exit_unconfirmed",
    });
    await expect(opened.runtime.close()).rejects.toMatchObject({
      code: "acp_agent_process_exit_unconfirmed",
    });
    await expect(opened.runtime.assertQualified()).rejects.toMatchObject({
      code: "acp_qualified_runtime_closed",
    });
    await harness.composition.close().catch(() => undefined);
  });

  it("rejects one credential lease reused across Task and Meta composition owners", async () => {
    const task = createHarness();
    const meta = createHarness();
    let acquisitions = 0;
    let cancellations = 0;
    const sharedCredential = Object.freeze({
      environment: Object.freeze({ ACP_TOKEN: "same-private-material" }),
      revoke: async () => undefined,
    });
    const beginCredentialAcquisition = () => {
      acquisitions += 1;
      return Object.freeze({
        lease: Promise.resolve(sharedCredential),
        cancelAndWait: async () => {
          cancellations += 1;
          return Object.freeze({ credentialCleanupConfirmed: true });
        },
      });
    };
    const common = {
      profile: profile([]),
      descriptor: {
        descriptorId: "credential-owner-provenance",
        discoverCurrent: async () => artifact("a"),
      },
      requiredAcpCapabilities: ["session_new"] as const,
      requiredBehaviors: ["managed_session_core"] as const,
      beginCredentialAcquisition,
      createConnection: () => connectionFactory(initializeResponse()),
      runProbe: async ({ client, bindingHandle }: Parameters<
        AcpProviderQualificationRequest["runProbe"]
      >[0]) => {
        await client.ensureBinding({
          bindingHandle,
          disposition: "create",
          workspaceDirectory: "/private/workspaces/credential-owner",
          mcpServers: [],
          configuration: { model: "model-current", options: [] },
        });
        return {
          passedBehaviors: ["managed_session_core"],
          bindingEstablished: true,
        };
      },
    };
    const opened = await task.composition.openBinding({
      ...common,
      role: "worker",
      bindingHandle: "binding_handle_task_credential_owner",
    });
    expect(opened.available).toBe(true);
    await expect(meta.composition.checkReadiness({
      ...common,
      role: "meta",
    })).resolves.toMatchObject({
      available: false,
      unavailableReasons: ["acp_credential_provenance_mismatch"],
    });
    expect(task.children).toHaveLength(1);
    expect(meta.children).toHaveLength(0);
    expect(acquisitions).toBe(2);
    expect(cancellations).toBe(1);
    if (opened.available) await opened.runtime.close();
    await Promise.all([task.composition.close(), meta.composition.close()]);
  });
});

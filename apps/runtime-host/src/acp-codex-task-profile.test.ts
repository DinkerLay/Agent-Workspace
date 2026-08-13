import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AcpSessionObservation,
  ManagedAcpV1Client,
} from "@agent-workspace/provider-acp";
import type {
  ProviderScopedToolCall,
  ProviderScopedToolTurnContext,
} from "@agent-workspace/provider-port";
import type {
  ExecutionProfileDefinitionV3,
  ProviderCapability,
} from "@agent-workspace/runtime-contracts";
import { CONDUCTOR_ORCHESTRATION_TOOL_DEFINITIONS } from "@agent-workspace/runtime-contracts";
import type { AcpBindingPrivateStorageRegistry } from "./acp-binding-private-storage.js";
import type {
  AcpProviderComposition,
  AcpProviderQualificationRequest,
  AcpQualifiedBindingRuntime,
} from "./acp-provider-composition.js";
import { LocalProfileResolution } from "./acp-profile-resolution.js";
import type { AcpReverseRpcLease } from "./acp-reverse-rpc-broker.js";
import type {
  CodexAcpScopedMcpRole,
} from "./acp-codex-scoped-mcp.js";
import { createCodexAcpTaskProfileAdapter } from "./acp-codex-task-profile.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => (
    rm(root, { recursive: true, force: true })
  )));
});

const profile: ExecutionProfileDefinitionV3 = Object.freeze({
  executionProfileId: "execution_profile_codex_task",
  profileRevisionId: "profile_revision_codex_task",
  providerFamily: "codex",
  acpAgentKind: "codex_acp",
  protocolMajor: 1,
  model: "provider/model-current",
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
    ] as const satisfies readonly ProviderCapability[]),
    allowedTools: Object.freeze([]),
    permissionMode: "ask",
    maxConcurrentTurns: 1,
    maxNativeChildren: 0,
  }),
});

describe("Codex ACP Task Profile driver", () => {
  it("rejects role/tool drift before constructing a process factory", () => {
    const createProcessFactory = vi.fn(() => {
      throw new Error("process_factory_must_not_run");
    });

    expect(() => createCodexAcpTaskProfileAdapter({
      profile: Object.freeze({
        ...profile,
        capabilityPolicy: Object.freeze({
          ...profile.capabilityPolicy,
          allowedTools: Object.freeze(["workspace.write_text"]),
        }),
      }),
      role: "worker",
      workspaceDirectory: "/private/workspace",
      bindingDisposition: "create",
      currentInstall: currentInstall(),
      credentialAcquisition: credentialAcquisition(),
      createProcessFactory,
    })).toThrowError(expect.objectContaining({
      code: "codex_acp_profile_role_tools_mismatch",
    }));
    expect(createProcessFactory).not.toHaveBeenCalled();
  });

  it("uses the shared workspace fence before any Codex ACP process effect", async () => {
    let providerEffects = 0;
    const composition: AcpProviderComposition = Object.freeze({
      async inspectModelCatalog() {
        throw new Error("model_catalog_must_not_run");
      },
      async checkReadiness() {
        providerEffects += 1;
        throw new Error("readiness_must_not_run");
      },
      async openBinding() {
        providerEffects += 1;
        throw new Error("binding_must_not_open");
      },
      close: vi.fn(async () => undefined),
    });
    const adapter = createCodexAcpTaskProfileAdapter({
      profile,
      role: "worker",
      workspaceDirectory: "relative/workspace",
      bindingDisposition: "create",
      currentInstall: currentInstall(),
      credentialAcquisition: credentialAcquisition(),
      composition,
    });

    await expect(adapter.openBinding({ bindingHandle: "binding_handle_codex_task" }))
      .rejects.toMatchObject({ code: "codex_acp_workspace_directory_invalid" });
    expect(providerEffects).toBe(0);
    expect(composition.close).toHaveBeenCalledTimes(0);
  });

  it("auto-selects allow_once only for qualification and surfaces business permissions", async () => {
    const fixture = await privateFixture();
    const bindingHandle = "binding_handle_codex_permission_scope";
    const qualificationAttemptId = "session_execution_attempt_codex_permission_probe";
    const businessAttemptId = "session_execution_attempt_codex_business_permission";
    const respondToInteraction = vi.fn(async () => undefined);
    const businessObservations: AcpSessionObservation[] = [];
    const scopes = fakeConductorScopes();
    const composition = permissionComposition({
      profile: conductorProfile(),
      respondToInteraction,
      qualificationAttemptId,
      businessAttemptId,
      activeContext: scopes.activeContext,
    });
    const adapter = createCodexAcpTaskProfileAdapter({
      profile: conductorProfile(),
      role: "conductor",
      workspaceDirectory: fixture.workspace,
      bindingDisposition: "create",
      currentInstall: currentInstall(),
      credentialAcquisition: Object.freeze({
        runtimePrivateRoot: fixture.privateRoot,
        authSourcePath: fixture.authSource,
      }),
      composition: composition.composition,
      scopedMcpRoles: scopes.roles,
      bindingPrivateStorageRegistry: fixture.storage,
      createQualificationProbe: () => Object.freeze({
        attemptId: qualificationAttemptId,
        content: "Run the exact Codex qualification calls.",
        interactionRevision: 1,
        turnContext: qualificationTurnContext(),
        expectedFinalCandidate: "CODEX_QUALIFICATION_OK",
      }),
      onObservation: (observation) => {
        businessObservations.push(observation);
      },
    });

    const opened = await adapter.openBinding({ bindingHandle });
    expect(opened.available).toBe(true);
    expect(respondToInteraction).toHaveBeenCalledTimes(1);
    expect(respondToInteraction).toHaveBeenCalledWith({
      bindingHandle: "binding_handle_codex_permission_probe",
      attemptId: qualificationAttemptId,
      interactionId: "interaction_codex_qualification",
      choiceId: "choice_codex_allow_once",
    });
    expect(composition.checkReadinessCount()).toBe(0);

    if (!opened.available) throw new Error("codex_profile_unavailable");
    await opened.runtime.submitPrompt({
      attemptId: businessAttemptId,
      content: "Business turn requiring permission.",
      interactionRevision: 1,
      turnContext: qualificationTurnContext(),
    });
    expect(respondToInteraction).toHaveBeenCalledTimes(1);
    expect(businessObservations).toContainEqual(expect.objectContaining({
      kind: "interaction_requested",
      attemptId: businessAttemptId,
      interactionId: "interaction_codex_business",
    }));

    await opened.runtime.releaseBinding();
    await adapter.close();
  });
});

function currentInstall() {
  return Object.freeze({
    wrapperCommandReference: "/private/bin/codex-acp",
    codexCommandReference: "/private/bin/codex",
    nodeCommandReference: "/private/bin/node",
    executableSearchPath: "/private/bin",
  });
}

function credentialAcquisition() {
  return Object.freeze({
    runtimePrivateRoot: "/private/runtime",
    authSourcePath: "/private/auth.json",
  });
}

function conductorProfile(): ExecutionProfileDefinitionV3 {
  return Object.freeze({
    ...profile,
    executionProfileId: "execution_profile_codex_conductor",
    profileRevisionId: "profile_revision_codex_conductor",
    capabilityPolicy: Object.freeze({
      ...profile.capabilityPolicy,
      allowedTools: Object.freeze(
        CONDUCTOR_ORCHESTRATION_TOOL_DEFINITIONS.map(({ name }) => name),
      ),
    }),
  });
}

async function privateFixture() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "codex-acp-profile-")));
  temporaryRoots.push(root);
  const workspace = path.join(root, "workspace");
  const privateRoot = path.join(root, "private");
  const processWorkingDirectory = path.join(root, "process");
  const providerDataDirectory = path.join(root, "provider-data");
  await Promise.all([
    mkdir(workspace, { mode: 0o700 }),
    mkdir(privateRoot, { mode: 0o700 }),
    mkdir(processWorkingDirectory, { mode: 0o700 }),
    mkdir(providerDataDirectory, { mode: 0o700 }),
  ]);
  const storage: AcpBindingPrivateStorageRegistry = Object.freeze({
    acquire: vi.fn(async () => Object.freeze({
      processWorkingDirectory,
      providerDataDirectory,
      assertProcessWorkingDirectoryEmpty: async () => true as const,
      prepareForRestart: async () => undefined,
      releaseBinding: async () => undefined,
    })),
    safeObservation: () => Object.freeze({
      availability: "active" as const,
      bindingCount: 1,
    }),
  });
  return Object.freeze({
    workspace,
    privateRoot,
    authSource: path.join(root, "auth.json"),
    storage,
  });
}

function fakeConductorScopes(): Readonly<{
  roles: Readonly<{
    target: CodexAcpScopedMcpRole;
    readiness: CodexAcpScopedMcpRole;
  }>;
  activeContext(): ProviderScopedToolTurnContext | undefined;
}> {
  let activeContext: ProviderScopedToolTurnContext | undefined;
  const create = () => fakeConductorScope((context) => { activeContext = context; });
  return Object.freeze({
    roles: Object.freeze({ target: create(), readiness: create() }),
    activeContext: () => activeContext,
  });
}

function fakeConductorScope(
  setActiveContext: (context: ProviderScopedToolTurnContext | undefined) => void,
): CodexAcpScopedMcpRole {
  return Object.freeze({
    role: "conductor" as const,
    registration: Object.freeze({
      capabilityClass: "runtime_orchestration" as const,
      tools: CONDUCTOR_ORCHESTRATION_TOOL_DEFINITIONS,
    }),
    createReverseRpcRegistration: () => undefined,
    async openBindingRoute() {
      return Object.freeze({
        mcpServers: Object.freeze([]),
        waitForToolDiscovery: async () => undefined,
        async activateAttempt(input: Readonly<{ turnContext: ProviderScopedToolTurnContext }>) {
          setActiveContext(input.turnContext);
        },
        observedToolCalls: () => 0,
        observedToolNames: () => Object.freeze([]),
        observedToolAttemptNames: () => Object.freeze([]),
        revokeAttempt: async () => { setActiveContext(undefined); },
        close: async () => { setActiveContext(undefined); },
      });
    },
    safeObservation: () => Object.freeze({
      role: "conductor" as const,
      scopedTools: true,
      toolCount: CONDUCTOR_ORCHESTRATION_TOOL_DEFINITIONS.length,
    }),
    close: async () => { setActiveContext(undefined); },
  });
}

function permissionComposition(input: Readonly<{
  profile: ExecutionProfileDefinitionV3;
  respondToInteraction: ManagedAcpV1Client["respondToInteraction"];
  qualificationAttemptId: string;
  businessAttemptId: string;
  activeContext(): ProviderScopedToolTurnContext | undefined;
}>) {
  let checkReadinessCount = 0;
  const report = Object.freeze({
    profileRevisionId: input.profile.profileRevisionId,
    providerFamily: "codex" as const,
    acpAgentKind: "codex_acp" as const,
    role: "conductor" as const,
    available: true as const,
    protocolMajor: 1,
    capabilities: Object.freeze([]),
    extensions: Object.freeze([]),
    unavailableReasons: Object.freeze([]),
    qualificationClass: "binding_behavior" as const,
    evidenceClass: "injected_host_qualification" as const,
  });
  const composition = Object.freeze({
    async inspectModelCatalog() {
      throw new Error("unexpected_model_catalog_inspection");
    },
    async checkReadiness() {
      checkReadinessCount += 1;
      return report;
    },
    async openBinding(request: AcpProviderQualificationRequest & Readonly<{
      bindingHandle: string;
    }>) {
      const emit = async (observation: AcpSessionObservation) => {
        await request.managedClientOptions?.onObservation?.(observation);
      };
      const qualificationClient = managedClient({
        profile: input.profile,
        respondToInteraction: input.respondToInteraction,
        submitPrompt: async (command) => {
          const qualificationContext = requiredActiveContext(input.activeContext());
          for (const [index, definition] of CONDUCTOR_ORCHESTRATION_TOOL_DEFINITIONS.entries()) {
            await qualificationContext.handleCall({
              providerCallId: `provider_call_codex_qualification_${index}`,
              name: definition.name,
              arguments: Object.freeze({ index }),
              lease: qualificationContext.lease,
            });
          }
          await emit(permissionObservation({
            bindingHandle: command.bindingHandle,
            attemptId: input.qualificationAttemptId,
            interactionId: "interaction_codex_qualification",
          }));
          await emitPromptFacts(command.bindingHandle, input.qualificationAttemptId, "CODEX_QUALIFICATION_OK", emit);
          return settlement(command.bindingHandle, input.qualificationAttemptId, "CODEX_QUALIFICATION_OK");
        },
      });
      const probeBindingHandle = "binding_handle_codex_permission_probe";
      await request.runProbe(Object.freeze({
        profile: request.profile,
        bindingHandle: probeBindingHandle,
        client: qualificationClient,
        resolution: controlledResolution(input.profile),
        reverseRpcLease: reverseRpcLease(probeBindingHandle),
      }));
      const targetClient = managedClient({
        profile: input.profile,
        respondToInteraction: input.respondToInteraction,
        submitPrompt: async (command) => {
          requiredActiveContext(input.activeContext());
          await emit(permissionObservation({
            bindingHandle: command.bindingHandle,
            attemptId: input.businessAttemptId,
            interactionId: "interaction_codex_business",
          }));
          await emitPromptFacts(command.bindingHandle, input.businessAttemptId, "BUSINESS_OK", emit);
          return settlement(command.bindingHandle, input.businessAttemptId, "BUSINESS_OK");
        },
      });
      await request.establishTargetBinding?.(Object.freeze({
        profile: request.profile,
        bindingHandle: request.bindingHandle,
        client: targetClient,
        resolution: controlledResolution(input.profile),
        reverseRpcLease: reverseRpcLease(request.bindingHandle),
      }));
      const runtime: AcpQualifiedBindingRuntime = Object.freeze({
        bindingHandle: request.bindingHandle,
        client: targetClient,
        qualification: Object.freeze({}) as AcpQualifiedBindingRuntime["qualification"],
        report,
        assertQualified: async () => undefined,
        releaseBinding: async () => undefined,
        close: async () => undefined,
      });
      return Object.freeze({ available: true as const, runtime, report });
    },
    close: vi.fn(async () => undefined),
  }) as AcpProviderComposition;
  return Object.freeze({ composition, checkReadinessCount: () => checkReadinessCount });
}

function managedClient(input: Readonly<{
  profile: ExecutionProfileDefinitionV3;
  respondToInteraction: ManagedAcpV1Client["respondToInteraction"];
  submitPrompt: ManagedAcpV1Client["submitPrompt"];
}>): ManagedAcpV1Client {
  return Object.freeze({
    initialize: vi.fn(),
    inspectModelCatalog: vi.fn(),
    ensureBinding: vi.fn(async (command) => Object.freeze({
      kind: "binding_ready" as const,
      bindingHandle: command.bindingHandle,
      disposition: command.disposition,
      recoverable: true,
      model: input.profile.model,
      modelCatalog: Object.freeze([{ modelId: input.profile.model, label: input.profile.model }]),
      configurationFingerprint: `sha256:${"a".repeat(64)}`,
    })),
    submitPrompt: input.submitPrompt,
    requestInterrupt: vi.fn(),
    respondToInteraction: input.respondToInteraction,
    releaseBinding: vi.fn(async () => undefined),
    invalidateGeneration: vi.fn(),
  });
}

function permissionObservation(input: Readonly<{
  bindingHandle: string;
  attemptId: string;
  interactionId: string;
}>): Extract<AcpSessionObservation, { kind: "interaction_requested" }> {
  return Object.freeze({
    kind: "interaction_requested" as const,
    bindingHandle: input.bindingHandle,
    attemptId: input.attemptId,
    interactionId: input.interactionId,
    toolCallHandle: `tool_handle_${input.interactionId}`,
    promptDigest: `sha256:${"b".repeat(64)}`,
    choices: Object.freeze([
      Object.freeze({
        choiceId: "choice_codex_allow_always",
        name: "Allow always",
        kind: "allow_always" as const,
      }),
      Object.freeze({
        choiceId: "choice_codex_allow_once",
        name: "Allow once",
        kind: "allow_once" as const,
      }),
      Object.freeze({
        choiceId: "choice_codex_reject_once",
        name: "Reject once",
        kind: "reject_once" as const,
      }),
    ]),
  });
}

async function emitPromptFacts(
  bindingHandle: string,
  attemptId: string,
  finalCandidate: string,
  emit: (observation: AcpSessionObservation) => Promise<void>,
): Promise<void> {
  const receiptDigest = `sha256:${"c".repeat(64)}`;
  await emit(Object.freeze({
    kind: "delivery_receipt" as const,
    bindingHandle,
    attemptId,
    receiptDigest,
  }));
  await emit(Object.freeze({
    kind: "final_candidate" as const,
    bindingHandle,
    attemptId,
    text: finalCandidate,
  }));
  await emit(Object.freeze({
    kind: "prompt_terminal" as const,
    bindingHandle,
    attemptId,
    stopReason: "end_turn" as const,
    receiptDigest,
  }));
}

function settlement(bindingHandle: string, attemptId: string, finalCandidate: string) {
  return Object.freeze({
    bindingHandle,
    attemptId,
    stopReason: "end_turn" as const,
    receiptDigest: `sha256:${"c".repeat(64)}`,
    finalCandidateGroupCount: 1,
    finalCandidate,
  });
}

function qualificationTurnContext(): ProviderScopedToolTurnContext {
  const lease = Object.freeze({ kind: "codex_qualification_test" });
  return Object.freeze({
    capabilityClass: "runtime_orchestration" as const,
    lease,
    async handleCall(call: ProviderScopedToolCall) {
      return Object.freeze({
        providerCallId: call.providerCallId,
        result: Object.freeze({ accepted: true }),
      });
    },
  });
}

function requiredActiveContext(
  context: ProviderScopedToolTurnContext | undefined,
): ProviderScopedToolTurnContext {
  if (!context) throw new Error("codex_qualification_context_missing");
  return context;
}

function controlledResolution(profileValue: ExecutionProfileDefinitionV3): LocalProfileResolution {
  return new LocalProfileResolution({
    profile: profileValue,
    profileFingerprint: `sha256:${"d".repeat(64)}`,
    discoverCurrent: async () => Object.freeze({
      canonicalLauncherPath: "/private/codex-acp",
      launchArguments: Object.freeze([]),
      observedArtifactVersion: "test",
      artifactDigest: `sha256:${"e".repeat(64)}`,
      trustState: "trusted" as const,
      executionConfigDigest: `sha256:${"f".repeat(64)}`,
      environment: Object.freeze({}),
    }),
    material: Object.freeze({
      hostPrivateResolutionId: "host_private_resolution_codex_test",
      descriptorId: "descriptor_codex_test",
      canonicalLauncherPath: "/private/codex-acp",
      launchArguments: Object.freeze([]),
      observedArtifactVersion: "test",
      artifactDigest: `sha256:${"e".repeat(64)}`,
      trustState: "trusted" as const,
      executionConfigDigest: `sha256:${"f".repeat(64)}`,
      environment: Object.freeze({}),
      observedAt: "2026-08-12T00:00:00.000Z",
      sealFingerprint: `sha256:${"1".repeat(64)}`,
    }),
  });
}

function reverseRpcLease(bindingHandle: string): AcpReverseRpcLease {
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

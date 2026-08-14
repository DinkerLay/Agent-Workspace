import { describe, expect, it, vi } from "vitest";
import type {
  SessionExecutionRuntimeOwner,
} from "@agent-workspace/runtime-application";
import type {
  AcpSessionRuntimeRepositories,
} from "@agent-workspace/runtime-store";
import {
  createAcpProductionHostInputs,
  loadAcpProductionConfigurationFromEnvironment,
} from "./acp-production-configuration.js";
import { BUILT_IN_ACP_STARTER_PACKAGES } from "@agent-workspace/runtime-application";
import type {
  AcpRuntimeHostPrivateAuthority,
} from "./acp-runtime-host-private-authority.js";
import {
  createSessionIdAcpProductionProviderOwner,
} from "./session-id-acp-production-provider-owner.js";
import type {
  SessionIdUnifiedAcpProviderFactoryInput,
} from "./session-id-unified-runtime-host.js";
import type { SessionIdAcpProviderSettingsHost } from "./session-id-acp-provider-settings-host.js";

describe("Session-ID ACP production provider owner", () => {
  it("exposes only the concrete composition release owner and launches no provider", async () => {
    const fixture = createFixture();

    const owner = await createSessionIdAcpProductionProviderOwner({
      input: fixture.providerFactoryInput,
      privateAuthority: fixture.privateAuthority,
      configuration: fixture.configuration,
      hostInputs: fixture.hostInputs,
      providerSettings: fixture.providerSettings,
      retainPrivateAuthority: vi.fn(),
      onHumanOnlyDiagnostic: vi.fn(),
    });

    expect(Object.isFrozen(owner)).toBe(true);
    const summaries = owner.nativeReleaseObservations.list();
    expect(summaries).toEqual([]);
    expect(Object.isFrozen(summaries)).toBe(true);
    expect(owner.nativeReleaseObservations.listCheckpointFacts()).toEqual([]);
    expect(Object.keys(owner.nativeReleaseObservations).sort()).toEqual([
      "claim",
      "claimCheckpointFact",
      "list",
      "listCheckpointFacts",
    ]);
    expect(owner.metaAgentRegistrations).toEqual([]);
    expect(Object.keys(owner).sort()).toEqual([
      "attachRuntime",
      "checkProfileReadiness",
      "close",
      "configureProviderChatModels",
      "configureProviderInstallation",
      "configuredProviderFamilies",
      "discoverProviderInstallation",
      "inspectProviderModelCatalog",
      "metaAgentRegistrations",
      "nativeReleaseObservations",
      "provider",
      "readActiveMetaAgentRegistrations",
      "readCachedProfileReadiness",
      "readProviderSetup",
      "recordProviderModelCatalog",
      "syncMetaAgentRegistrations",
    ]);
    const workerProfile = BUILT_IN_ACP_STARTER_PACKAGES[0]!.package.definition.executionProfiles[1]!;
    expect(owner.readCachedProfileReadiness({ profile: workerProfile, role: "general" })).toMatchObject({
      profileRevisionId: workerProfile.profileRevisionId,
      role: "general",
      status: "unavailable",
    });

    await owner.close();
    expect(owner.nativeReleaseObservations.listCheckpointFacts()).toEqual([]);
    await owner.close();
    expect(fixture.closePrivateAuthority).toHaveBeenCalledTimes(1);
  });

  it("rejects extra owner keys and nested input scope drift", async () => {
    const fixture = createFixture();
    const base = {
      input: fixture.providerFactoryInput,
      privateAuthority: fixture.privateAuthority,
      configuration: fixture.configuration,
      hostInputs: fixture.hostInputs,
      providerSettings: fixture.providerSettings,
      retainPrivateAuthority: vi.fn(),
    };

    await expect(createSessionIdAcpProductionProviderOwner({
      ...base,
      unexpected: "scope_drift",
    } as never)).rejects.toThrow("session_id_acp_production_provider_owner_options_invalid");
    await expect(createSessionIdAcpProductionProviderOwner({
      ...base,
      input: {
        ...fixture.providerFactoryInput,
        taskBindingContext: {
          ...fixture.providerFactoryInput.taskBindingContext,
          unexpectedScope: "scope_drift",
        },
      },
    } as never)).rejects.toThrow("session_id_acp_production_provider_owner_options_invalid");
  });

  it("accepts the assembly-fenced recovery callback instead of requiring the raw authority identity", async () => {
    const fixture = createFixture();
    const owner = await createSessionIdAcpProductionProviderOwner({
      input: Object.freeze({
        ...fixture.providerFactoryInput,
        authorizeRetiringBindingRecovery: vi.fn(() => false),
      }),
      privateAuthority: fixture.privateAuthority,
      configuration: fixture.configuration,
      hostInputs: fixture.hostInputs,
      providerSettings: fixture.providerSettings,
      retainPrivateAuthority: vi.fn(),
    });

    await owner.close();
  });

  it("drops human-only diagnostics by default without writing model content or paths to stderr", async () => {
    const fixture = createFixture();
    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const owner = await createSessionIdAcpProductionProviderOwner({
      input: fixture.providerFactoryInput,
      privateAuthority: fixture.privateAuthority,
      configuration: fixture.configuration,
      hostInputs: fixture.hostInputs,
      providerSettings: fixture.providerSettings,
      retainPrivateAuthority: vi.fn(),
    });

    await owner.close();

    expect(stderrWrite).not.toHaveBeenCalled();
    expect(JSON.stringify(stderrWrite.mock.calls)).not.toContain("secret model content");
    expect(JSON.stringify(stderrWrite.mock.calls)).not.toContain("/private/runtime/path");
    stderrWrite.mockRestore();
  });
});

function createFixture(): Readonly<{
  configuration: ReturnType<typeof loadAcpProductionConfigurationFromEnvironment>;
  hostInputs: ReturnType<typeof createAcpProductionHostInputs>;
  privateAuthority: AcpRuntimeHostPrivateAuthority;
  providerFactoryInput: SessionIdUnifiedAcpProviderFactoryInput;
  providerSettings: SessionIdAcpProviderSettingsHost;
  closePrivateAuthority: ReturnType<typeof vi.fn>;
}> {
  const configuration = loadAcpProductionConfigurationFromEnvironment({});
  const hostInputs = createAcpProductionHostInputs(configuration, {});
  const closePrivateAuthority = vi.fn();
  const authorizeRetiringBindingRecovery = vi.fn(() => false);
  const privateAuthority = Object.freeze({
    taskIdentityVaults: vi.fn(),
    metaIdentityVaults: vi.fn(),
    taskPrivateRootAuthority: Object.freeze({ toJSON: vi.fn() }),
    metaPrivateRootAuthority: Object.freeze({ toJSON: vi.fn() }),
    recoveryObservation: vi.fn(() => Object.freeze({ state: "fresh" as const })),
    authorizeRetiringBindingRecovery,
    close: closePrivateAuthority,
    toJSON: vi.fn(() => Object.freeze({ kind: "acp_runtime_host_private_authority" as const })),
  }) as unknown as AcpRuntimeHostPrivateAuthority;
  const repositories = Object.freeze({
    binding: Object.freeze({
      getBinding: vi.fn(() => undefined),
      getCurrentBinding: vi.fn(() => undefined),
    }),
    sessionRuntime: Object.freeze({
      getRuntime: vi.fn(() => undefined),
      getRuntimeForSession: vi.fn(() => undefined),
      getAttempt: vi.fn(() => undefined),
    }),
  }) as unknown as AcpSessionRuntimeRepositories;
  const sessionRuntimeOwner = Object.freeze({
    handleInteractionRequested: vi.fn(),
    handleFinalCandidate: vi.fn(),
  }) as unknown as SessionExecutionRuntimeOwner;
  const providerFactoryInput = Object.freeze({
    runtimeInstanceId: "runtime_instance_production_owner_test",
    repositories,
    sessionRuntimeOwner,
    resolveFrozenProfileTuple: vi.fn(() => undefined),
    resolveInterruptCorrelation: vi.fn(() => undefined),
    resolveTaskStopControl: vi.fn(() => undefined),
    resolveCloseControl: vi.fn(() => undefined),
    authorizeRetiringBindingRecovery,
    onDeliveryReceipt: vi.fn(),
    onHumanOnlyActivity: vi.fn(),
    now: () => "2026-08-12T00:00:00.000Z",
    createId: (kind: string) => `${kind}_production_owner_test`,
    taskBindingContext: Object.freeze({
      repositories: Object.freeze({}),
      workspaceDirectoryResolver: Object.freeze({}),
    }),
  }) as unknown as SessionIdUnifiedAcpProviderFactoryInput;
  const providerSetup = () => Object.freeze({
    configurationSource: "none" as const,
    installation: Object.freeze({ status: "not_scanned" as const, components: Object.freeze([]) }),
    modelCatalog: Object.freeze([]),
    enabledChatModelIds: Object.freeze([]),
  });
  const providerSettings: SessionIdAcpProviderSettingsHost = Object.freeze({
    effectiveEnvironment: () => Object.freeze({}),
    read: providerSetup,
    discover: providerSetup,
    configure: providerSetup,
    recordModelCatalog: providerSetup,
    configureChatModels: providerSetup,
    toJSON: () => Object.freeze({ kind: "session_id_acp_provider_settings_host" as const }),
  });
  return Object.freeze({
    configuration,
    hostInputs,
    privateAuthority,
    providerFactoryInput,
    providerSettings,
    closePrivateAuthority,
  });
}

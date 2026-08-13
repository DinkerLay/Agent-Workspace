import type {
  AcpSessionConfigurationIntent,
  AcpSessionObservation,
  AcpV1Capability,
} from "@agent-workspace/provider-acp";
import type { ExecutionProfileDefinitionV3 } from "@agent-workspace/runtime-contracts";
import { createOfficialAcpV1StdioConnection } from "./acp-sdk-stdio-connection.js";
import type {
  AcpProviderComposition,
  AcpQualificationEffectBudget,
} from "./acp-provider-composition.js";
import type { AcpBindingPrivateStorageRegistry } from "./acp-binding-private-storage.js";
import {
  beginOpenCodeAcpCredentialAcquisition,
  createOpenCodeAcpCurrentInstallDescriptor,
  type BeginOpenCodeAcpCredentialAcquisitionOptions,
  type OpenCodeAcpCurrentInstallOptions,
  type OpenCodeAcpTaskRole,
} from "./acp-opencode-resolution.js";
import {
  createOpenCodeAcpScopedMcpRole,
  type OpenCodeAcpScopedMcpRole,
} from "./acp-opencode-scoped-mcp.js";
import type { ProviderScopedMcpBridge } from "./provider-scoped-mcp-bridge.js";
import type {
  AcpAgentIdentityVaultResolver,
  AcpAgentProcessFactory,
} from "./acp-agent-process.js";
import {
  createAcpTaskProfileAdapter,
  type AcpTaskProfileAdapter,
  type AcpTaskProfileDriver,
} from "./acp-task-profile-adapter.js";
import {
  createAcpTaskReadinessRegistry,
  type AcpTaskBindingRuntime,
  type AcpTaskPromptReconciler,
  type AcpTaskReadinessRegistry,
  type AcpTaskRuntimeDiagnostic,
} from "./acp-task-profile-runtime.js";

export type OpenCodeAcpBindingDisposition = "create" | "load" | "resume";
export type OpenCodeAcpTaskBindingRuntime = AcpTaskBindingRuntime<"opencode", "native_acp">;
export type OpenCodeAcpTaskProfileAdapter = AcpTaskProfileAdapter<
  "opencode",
  "native_acp"
>;
export type OpenCodeAcpTaskReadinessRegistry = AcpTaskReadinessRegistry;

export function createOpenCodeAcpTaskReadinessRegistry(options: Readonly<{
  readonly ttlMs?: number;
  readonly now?: () => number;
}> = {}): OpenCodeAcpTaskReadinessRegistry {
  return createAcpTaskReadinessRegistry(options, createProfileError);
}

export class OpenCodeAcpTaskProfileError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "OpenCodeAcpTaskProfileError";
    this.code = code;
  }
}

type OpenCodeAcpTaskProfileOptions = Readonly<{
  readonly profile: ExecutionProfileDefinitionV3;
  readonly role: OpenCodeAcpTaskRole;
  readonly workspaceDirectory: string;
  readonly bindingDisposition: OpenCodeAcpBindingDisposition;
  readonly currentInstall: Omit<OpenCodeAcpCurrentInstallOptions, "executionPolicy">;
  readonly credentialAcquisition: BeginOpenCodeAcpCredentialAcquisitionOptions;
  readonly sessionConfiguration?: AcpSessionConfigurationIntent;
  readonly requiredCapabilities?: readonly AcpV1Capability[];
  readonly bridge?: ProviderScopedMcpBridge;
  readonly scopedMcpRoles?: Readonly<{
    readonly target: OpenCodeAcpScopedMcpRole;
    readonly readiness: OpenCodeAcpScopedMcpRole;
  }>;
  readonly composition?: AcpProviderComposition;
  readonly identityVaultResolver?: AcpAgentIdentityVaultResolver;
  readonly createProcessFactory?: (
    identityVaultResolver: AcpAgentIdentityVaultResolver | undefined,
  ) => AcpAgentProcessFactory;
  readonly bindingPrivateStorageRegistry?: AcpBindingPrivateStorageRegistry;
  readonly readinessRegistry?: OpenCodeAcpTaskReadinessRegistry;
  readonly createQualificationAttemptId?: () => string;
  readonly reconciler?: AcpTaskPromptReconciler;
  readonly onObservation?: (observation: AcpSessionObservation) => void | Promise<void>;
  readonly onDiagnostic?: (diagnostic: AcpTaskRuntimeDiagnostic) => void;
  readonly beforeQualificationEffect?: AcpQualificationEffectBudget;
}>;

/**
 * Thin OpenCode driver. Shared ACP profile lifecycle lives in
 * createAcpTaskProfileAdapter.
 */
export function createOpenCodeAcpTaskProfileAdapter(
  options: OpenCodeAcpTaskProfileOptions,
): OpenCodeAcpTaskProfileAdapter {
  return createAcpTaskProfileAdapter(OPENCODE_TASK_PROFILE_DRIVER, options);
}

const OPENCODE_TASK_PROFILE_DRIVER = Object.freeze({
  providerFamily: "opencode",
  acpAgentKind: "native_acp",
  errorPrefix: "opencode_acp",
  toolMatch: "ordered",
  qualificationFlow: "readiness_then_target",
  qualificationDirectoryPrefix: "agent-workspace-opencode-qualification-",
  defaultQualificationAttemptId: "session_execution_attempt_opencode_qualification",
  createError: createProfileError,
  isTaskProfileError: (error: unknown) => error instanceof OpenCodeAcpTaskProfileError,
  createScopedMcpRole: createOpenCodeAcpScopedMcpRole,
  createDescriptor(currentInstall, scope) {
    return createOpenCodeAcpCurrentInstallDescriptor({
      ...currentInstall,
      executionPolicy: scope.executionPolicy,
    });
  },
  createConnection: () => createOfficialAcpV1StdioConnection,
  beginCredentialAcquisition(options, providerDataDirectory) {
    return beginOpenCodeAcpCredentialAcquisition(
      providerDataDirectory
        ? Object.freeze({ ...options, persistentDataHome: providerDataDirectory })
        : options,
    );
  },
  privateRootParent: (options) => options.privateRootParent,
  readinessKey: openCodeReadinessKey,
} satisfies AcpTaskProfileDriver<
  Omit<OpenCodeAcpCurrentInstallOptions, "executionPolicy">,
  BeginOpenCodeAcpCredentialAcquisitionOptions,
  OpenCodeAcpScopedMcpRole,
  "opencode",
  "native_acp"
>);

function openCodeReadinessKey(input: Readonly<{
  profile: ExecutionProfileDefinitionV3;
  role: OpenCodeAcpTaskRole;
  currentInstall: Omit<OpenCodeAcpCurrentInstallOptions, "executionPolicy">;
  credentialAcquisition: BeginOpenCodeAcpCredentialAcquisitionOptions;
  requiredCapabilities: readonly AcpV1Capability[];
}>): string {
  return JSON.stringify({
    profileRevisionId: input.profile.profileRevisionId,
    providerFamily: input.profile.providerFamily,
    model: input.profile.model,
    role: input.role,
    requiredCapabilities: input.requiredCapabilities,
    commandReference: input.currentInstall.commandReference ?? null,
    executableSearchPath: input.currentInstall.executableSearchPath,
    inspectionEnvironment: input.currentInstall.inspectionEnvironment,
    sourceAuthFile: input.credentialAcquisition.sourceAuthFile ?? null,
  });
}

function createProfileError(suffix: string): OpenCodeAcpTaskProfileError {
  return new OpenCodeAcpTaskProfileError(`opencode_acp_${suffix}`);
}

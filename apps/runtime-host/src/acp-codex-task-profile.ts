import type {
  AcpSessionConfigurationIntent,
  AcpSessionObservation,
  AcpV1Capability,
} from "@agent-workspace/provider-acp";
import type { ExecutionProfileDefinitionV3 } from "@agent-workspace/runtime-contracts";
import type { ProviderScopedToolTurnContext } from "@agent-workspace/provider-port";
import { createOfficialAcpV1StdioConnection } from "./acp-sdk-stdio-connection.js";
import type {
  AcpProviderComposition,
  AcpQualificationEffectBudget,
} from "./acp-provider-composition.js";
import type { AcpBindingPrivateStorageRegistry } from "./acp-binding-private-storage.js";
import {
  beginCodexAcpCredentialAcquisition,
  createCodexAcpCurrentInstallDescriptor,
  type CodexAcpCredentialAcquisitionOptions,
  type CodexAcpCurrentInstallOptions,
} from "./acp-codex-resolution.js";
import {
  createCodexAcpScopedMcpRole,
  type CodexAcpScopedMcpRole,
  type CodexAcpTaskRole,
} from "./acp-codex-scoped-mcp.js";
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
  type AcpTaskBindingRuntime,
  type AcpTaskPromptReconciler,
  type AcpTaskQualificationProbe,
  type AcpTaskQualificationProbeStep,
  type AcpTaskReadinessRegistry,
  type AcpTaskRuntimeDiagnostic,
} from "./acp-task-profile-runtime.js";

export type CodexAcpBindingDisposition = "create" | "load" | "resume";
export type CodexAcpNativeAttemptInput = Readonly<{
  readonly attemptId: string;
  readonly content: string;
  readonly interactionRevision: number;
  readonly turnContext?: ProviderScopedToolTurnContext;
  readonly qualificationExpectedFinalCandidate?: string;
  readonly additionalSteps?: readonly AcpTaskQualificationProbeStep[];
}>;
export type CodexAcpTaskBindingRuntime = AcpTaskBindingRuntime<"codex", "codex_acp">;
export type CodexAcpTaskProfileAdapter = AcpTaskProfileAdapter<"codex", "codex_acp">;

export class CodexAcpTaskProfileError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "CodexAcpTaskProfileError";
    this.code = code;
  }
}

export type CodexAcpTaskProfileOptions = Readonly<{
  readonly profile: ExecutionProfileDefinitionV3;
  readonly role: CodexAcpTaskRole;
  readonly workspaceDirectory: string;
  readonly bindingDisposition: CodexAcpBindingDisposition;
  readonly currentInstall: CodexAcpCurrentInstallOptions;
  readonly credentialAcquisition: CodexAcpCredentialAcquisitionOptions;
  readonly sessionConfiguration?: AcpSessionConfigurationIntent;
  readonly requiredCapabilities?: readonly AcpV1Capability[];
  readonly bridge?: ProviderScopedMcpBridge;
  readonly scopedMcpRoles?: Readonly<{
    readonly target: CodexAcpScopedMcpRole;
    readonly readiness: CodexAcpScopedMcpRole;
  }>;
  readonly composition?: AcpProviderComposition;
  readonly identityVaultResolver?: AcpAgentIdentityVaultResolver;
  readonly createProcessFactory?: (
    identityVaultResolver: AcpAgentIdentityVaultResolver | undefined,
  ) => AcpAgentProcessFactory;
  readonly bindingPrivateStorageRegistry?: AcpBindingPrivateStorageRegistry;
  readonly readinessRegistry?: AcpTaskReadinessRegistry;
  readonly createQualificationAttemptId?: () => string;
  readonly createQualificationProbe?: () => AcpTaskQualificationProbe;
  readonly reconciler?: AcpTaskPromptReconciler;
  readonly onObservation?: (observation: AcpSessionObservation) => void | Promise<void>;
  readonly onDiagnostic?: (diagnostic: AcpTaskRuntimeDiagnostic) => void;
  readonly beforeQualificationEffect?: AcpQualificationEffectBudget;
}>;

/** Thin codex-acp driver over the shared ACP Task Profile lifecycle. */
export function createCodexAcpTaskProfileAdapter(
  options: CodexAcpTaskProfileOptions,
): CodexAcpTaskProfileAdapter {
  return createAcpTaskProfileAdapter(CODEX_TASK_PROFILE_DRIVER, options);
}

const CODEX_TASK_PROFILE_DRIVER = Object.freeze({
  providerFamily: "codex",
  acpAgentKind: "codex_acp",
  errorPrefix: "codex_acp",
  toolMatch: "ordered",
  qualificationFlow: "target_only",
  qualificationPermissionChoiceKind: "allow_once",
  qualificationDirectoryPrefix: "agent-workspace-codex-qualification-",
  defaultQualificationAttemptId: "session_execution_attempt_codex_qualification",
  createError: createProfileError,
  isTaskProfileError: (error: unknown) => error instanceof CodexAcpTaskProfileError,
  createScopedMcpRole: createCodexAcpScopedMcpRole,
  createDescriptor: (currentInstall) => createCodexAcpCurrentInstallDescriptor(currentInstall),
  createConnection: () => createOfficialAcpV1StdioConnection,
  beginCredentialAcquisition(options, providerDataDirectory) {
    return beginCodexAcpCredentialAcquisition(
      providerDataDirectory
        ? Object.freeze({ ...options, persistentCodexHome: providerDataDirectory })
        : options,
    );
  },
  privateRootParent: (options) => options.runtimePrivateRoot,
  readinessKey: codexReadinessKey,
} satisfies AcpTaskProfileDriver<
  CodexAcpCurrentInstallOptions,
  CodexAcpCredentialAcquisitionOptions,
  CodexAcpScopedMcpRole,
  "codex",
  "codex_acp"
>);

function codexReadinessKey(input: Readonly<{
  profile: ExecutionProfileDefinitionV3;
  role: CodexAcpTaskRole;
  currentInstall: CodexAcpCurrentInstallOptions;
  credentialAcquisition: CodexAcpCredentialAcquisitionOptions;
  requiredCapabilities: readonly AcpV1Capability[];
}>): string {
  return JSON.stringify({
    profileRevisionId: input.profile.profileRevisionId,
    providerFamily: input.profile.providerFamily,
    model: input.profile.model,
    role: input.role,
    requiredCapabilities: input.requiredCapabilities,
    wrapperCommandReference: input.currentInstall.wrapperCommandReference,
    codexCommandReference: input.currentInstall.codexCommandReference,
    nodeCommandReference: input.currentInstall.nodeCommandReference,
    executableSearchPath: input.currentInstall.executableSearchPath,
    authSourcePath: input.credentialAcquisition.authSourcePath,
  });
}

function createProfileError(suffix: string): CodexAcpTaskProfileError {
  return new CodexAcpTaskProfileError(`codex_acp_${suffix}`);
}

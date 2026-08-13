import type {
  AcpSessionConfigurationIntent,
  AcpSessionObservation,
  AcpV1Capability,
} from "@agent-workspace/provider-acp";
import type { ExecutionProfileDefinitionV3 } from "@agent-workspace/runtime-contracts";
import { createClaudeCodeAcpV1StdioConnection } from "./acp-claude-code-stdio-connection.js";
import type {
  AcpProviderComposition,
  AcpQualificationEffectBudget,
} from "./acp-provider-composition.js";
import type { AcpBindingPrivateStorageRegistry } from "./acp-binding-private-storage.js";
import {
  beginClaudeCodeAcpCredentialAcquisition,
  createClaudeCodeAcpCurrentInstallDescriptor,
  type BeginClaudeCodeAcpCredentialAcquisitionOptions,
  type ClaudeCodeAcpCurrentInstallOptions,
} from "./acp-claude-code-resolution.js";
import {
  createClaudeCodeAcpScopedMcpRole,
  type ClaudeCodeAcpScopedMcpRole,
  type ClaudeCodeAcpTaskRole,
} from "./acp-claude-code-scoped-mcp.js";
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
  type AcpTaskReadinessRegistry,
  type AcpTaskRuntimeDiagnostic,
} from "./acp-task-profile-runtime.js";

export type ClaudeCodeAcpBindingDisposition = "create" | "load" | "resume";
export type ClaudeCodeAcpTaskBindingRuntime = AcpTaskBindingRuntime<
  "claude-code",
  "claude_agent_acp"
>;
export type ClaudeCodeAcpTaskProfileAdapter = AcpTaskProfileAdapter<
  "claude-code",
  "claude_agent_acp"
>;

export class ClaudeCodeAcpTaskProfileError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "ClaudeCodeAcpTaskProfileError";
    this.code = code;
  }
}

type ClaudeCodeAcpTaskProfileOptions = Readonly<{
  readonly profile: ExecutionProfileDefinitionV3;
  readonly role: ClaudeCodeAcpTaskRole;
  readonly workspaceDirectory: string;
  readonly bindingDisposition: ClaudeCodeAcpBindingDisposition;
  readonly currentInstall: ClaudeCodeAcpCurrentInstallOptions;
  readonly credentialAcquisition: BeginClaudeCodeAcpCredentialAcquisitionOptions;
  readonly sessionConfiguration?: AcpSessionConfigurationIntent;
  readonly requiredCapabilities?: readonly AcpV1Capability[];
  readonly bridge?: ProviderScopedMcpBridge;
  readonly scopedMcpRoles?: Readonly<{
    readonly target: ClaudeCodeAcpScopedMcpRole;
    readonly readiness: ClaudeCodeAcpScopedMcpRole;
  }>;
  readonly composition?: AcpProviderComposition;
  readonly identityVaultResolver?: AcpAgentIdentityVaultResolver;
  readonly createProcessFactory?: (
    identityVaultResolver: AcpAgentIdentityVaultResolver | undefined,
  ) => AcpAgentProcessFactory;
  readonly bindingPrivateStorageRegistry?: AcpBindingPrivateStorageRegistry;
  readonly readinessRegistry?: AcpTaskReadinessRegistry;
  readonly createQualificationAttemptId?: () => string;
  readonly reconciler?: AcpTaskPromptReconciler;
  readonly onObservation?: (observation: AcpSessionObservation) => void | Promise<void>;
  readonly onDiagnostic?: (diagnostic: AcpTaskRuntimeDiagnostic) => void;
  readonly beforeQualificationEffect?: AcpQualificationEffectBudget;
}>;

/**
 * Thin Claude Code driver. Shared ACP profile lifecycle lives in
 * createAcpTaskProfileAdapter.
 */
export function createClaudeCodeAcpTaskProfileAdapter(
  options: ClaudeCodeAcpTaskProfileOptions,
): ClaudeCodeAcpTaskProfileAdapter {
  return createAcpTaskProfileAdapter(CLAUDE_CODE_TASK_PROFILE_DRIVER, options);
}

const CLAUDE_CODE_TASK_PROFILE_DRIVER = Object.freeze({
  providerFamily: "claude-code",
  acpAgentKind: "claude_agent_acp",
  errorPrefix: "claude_code_acp",
  toolMatch: "exact_set",
  qualificationFlow: "readiness_then_target",
  qualificationDirectoryPrefix: "agent-workspace-claude_code-qualification-",
  defaultQualificationAttemptId: "session_execution_attempt_claude_code_qualification",
  createError: createProfileError,
  isTaskProfileError: (error: unknown) => error instanceof ClaudeCodeAcpTaskProfileError,
  createScopedMcpRole: createClaudeCodeAcpScopedMcpRole,
  createDescriptor(currentInstall) {
    return createClaudeCodeAcpCurrentInstallDescriptor(currentInstall);
  },
  createConnection: () => createClaudeCodeAcpV1StdioConnection({
    nativeTools: "provider_default",
  }),
  beginCredentialAcquisition(options, providerDataDirectory) {
    return beginClaudeCodeAcpCredentialAcquisition(
      providerDataDirectory
        ? Object.freeze({ ...options, persistentConfigDirectory: providerDataDirectory })
        : options,
    );
  },
  privateRootParent: (options) => options.privateRootParent,
  readinessKey: claudeCodeReadinessKey,
} satisfies AcpTaskProfileDriver<
  ClaudeCodeAcpCurrentInstallOptions,
  BeginClaudeCodeAcpCredentialAcquisitionOptions,
  ClaudeCodeAcpScopedMcpRole,
  "claude-code",
  "claude_agent_acp"
>);

function claudeCodeReadinessKey(input: Readonly<{
  profile: ExecutionProfileDefinitionV3;
  role: ClaudeCodeAcpTaskRole;
  currentInstall: ClaudeCodeAcpCurrentInstallOptions;
  credentialAcquisition: BeginClaudeCodeAcpCredentialAcquisitionOptions;
  requiredCapabilities: readonly AcpV1Capability[];
}>): string {
  return JSON.stringify({
    profileRevisionId: input.profile.profileRevisionId,
    providerFamily: input.profile.providerFamily,
    model: input.profile.model,
    role: input.role,
    requiredCapabilities: input.requiredCapabilities,
    wrapperCommandReference: input.currentInstall.wrapperCommandReference,
    claudeCommandReference: input.currentInstall.claudeCommandReference,
    nodeCommandReference: input.currentInstall.nodeCommandReference,
    executableSearchPath: input.currentInstall.executableSearchPath,
    settingsSourcePath: input.currentInstall.settingsSourcePath,
    sourceSettingsFile: input.credentialAcquisition.sourceSettingsFile,
  });
}

function createProfileError(suffix: string): ClaudeCodeAcpTaskProfileError {
  return new ClaudeCodeAcpTaskProfileError(`claude_code_acp_${suffix}`);
}

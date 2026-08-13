import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { constants, createReadStream, type Stats } from "node:fs";
import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  realpath,
  rm,
  stat,
} from "node:fs/promises";
import path from "node:path";
import type { AcpTaskRole } from "./acp-task-role.js";
import type {
  ExecutionProfileDefinitionV3,
  MetaProfileDefinitionV3,
} from "@agent-workspace/runtime-contracts";
import type { AcpCredentialLease } from "./acp-agent-process.js";
import type { AcpCredentialAcquisitionOperation } from "./acp-provider-composition.js";
import type {
  AcpCurrentInstallDescriptor,
  AcpDiscoveredArtifact,
  AcpPortableProfileDefinitionV3,
} from "./acp-profile-resolution.js";

const SAFE_COMMAND = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/u;
const SAFE_VERSION = /^[A-Za-z0-9][A-Za-z0-9._+:@-]{0,159}$/u;
const ENVIRONMENT_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u;
const SAFE_SCOPED_MCP_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const MAX_AUTH_FILE_BYTES = 1024 * 1024;
const CONDUCTOR_TOOL_NAMES = Object.freeze([
  "invoke_agent",
  "send_to_session",
  "interrupt_session",
  "close_session",
] as const);
const OPEN_CODE_ACP_ARGUMENTS = Object.freeze([
  "acp",
  "--pure",
  "--hostname=127.0.0.1",
  "--port=0",
  "--no-mdns",
] as const);
const HOST_OWNED_ENVIRONMENT = new Set([
  "HOME",
  "LANG",
  "LC_ALL",
  "PATH",
  "TMPDIR",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
]);

export type OpenCodeAcpTaskRole = AcpTaskRole;

export type OpenCodeAcpTaskExecutionPolicy = Readonly<{
  readonly role: OpenCodeAcpTaskRole;
  readonly nativeTools: "provider_default" | "disabled";
  readonly scopedMcpServerName?: string;
  readonly scopedToolNames: readonly string[];
  readonly configContent: string;
  readonly policyDigest: string;
}>;

export type OpenCodeAcpInspectionEnvironment = Readonly<{
  readonly homeDirectory: string;
  readonly configHome: string;
  readonly dataHome: string;
  readonly cacheHome: string;
  readonly stateHome: string;
  readonly temporaryDirectory: string;
}>;

export type OpenCodeAcpVersionInspection = Readonly<{
  readonly canonicalLauncherPath: string;
  readonly environment: Readonly<Record<string, string>>;
}>;

export type OpenCodeAcpCurrentInstallOptions = Readonly<{
  /** Bare `opencode` is resolved only through this explicit, snapshotted PATH. */
  readonly executableSearchPath: string;
  readonly inspectionEnvironment: OpenCodeAcpInspectionEnvironment;
  /** Host-owned role policy; credential material may never override it. */
  readonly executionPolicy: OpenCodeAcpTaskExecutionPolicy;
  readonly commandReference?: string;
  readonly locale?: string;
  readonly inspectVersion?: (input: OpenCodeAcpVersionInspection) => Promise<string>;
  readonly trustArtifact?: (input: Readonly<{
    readonly canonicalLauncherPath: string;
    readonly metadata: Stats;
  }>) => boolean | Promise<boolean>;
}>;

export type OpenCodeAcpMetaCurrentInstallOptions = Omit<
  OpenCodeAcpCurrentInstallOptions,
  "executionPolicy"
>;

export type OpenCodeAcpCredentialLeaseInput = OpenCodeAcpInspectionEnvironment & Readonly<{
  /** Provider API tokens only; Host-owned PATH/XDG/OpenCode policy keys cannot be overridden. */
  readonly credentialEnvironment?: Readonly<Record<string, string>>;
  /** Must remove/cut access to every private directory and credential above. */
  revoke(): Promise<void>;
}>;

export type BeginOpenCodeAcpCredentialAcquisitionOptions = Readonly<{
  /** Existing absolute directory beneath which one generation-private root is created. */
  readonly privateRootParent: string;
  /** Optional current OpenCode auth file, copied opaquely into the private XDG data tree. */
  readonly sourceAuthFile?: string;
  /** Binding-private OpenCode session storage retained until Binding retirement. */
  readonly persistentDataHome?: string;
  /** Explicit provider credentials only; ambient process environment is never inherited. */
  readonly credentialEnvironment?: Readonly<Record<string, string>>;
}>;

export class OpenCodeAcpResolutionError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "OpenCodeAcpResolutionError";
    this.code = code;
  }
}

/**
 * Produces the complete per-process OpenCode permission configuration. OpenCode
 * resolves permissions with `findLast`, so insertion order is security
 * significant: the wildcard deny is always written before exact scoped allows.
 */
export function createOpenCodeAcpTaskExecutionPolicy(
  input: Readonly<{
    readonly role: OpenCodeAcpTaskRole;
    readonly scopedMcpServerName?: string;
    readonly scopedToolNames?: readonly string[];
  }>,
): OpenCodeAcpTaskExecutionPolicy {
  return createOpenCodeAcpExecutionPolicy({ ...input, nativeTools: "provider_default" });
}

/** Meta never receives provider-native tools or a scoped Task MCP surface. */
export function createOpenCodeAcpMetaExecutionPolicy(): OpenCodeAcpTaskExecutionPolicy {
  return createOpenCodeAcpExecutionPolicy({ role: "worker", nativeTools: "disabled" });
}

function createOpenCodeAcpExecutionPolicy(
  input: Readonly<{
    readonly role: OpenCodeAcpTaskRole;
    readonly nativeTools: "provider_default" | "disabled";
    readonly scopedMcpServerName?: string;
    readonly scopedToolNames?: readonly string[];
  }>,
): OpenCodeAcpTaskExecutionPolicy {
  if (!input || !["conductor", "publisher", "worker", "reviewer"].includes(input.role)) {
    throw safeError("opencode_acp_role_policy_invalid");
  }
  const suppliedTools = [...(input.scopedToolNames ?? [])];
  let expectedTools: readonly string[];
  if (input.nativeTools === "disabled") expectedTools = [];
  else if (input.role === "conductor") expectedTools = CONDUCTOR_TOOL_NAMES;
  else expectedTools = [];

  if (expectedTools.length === 0) {
    if (input.scopedMcpServerName !== undefined || suppliedTools.length !== 0) {
      throw safeError("opencode_acp_role_tools_forbidden");
    }
  } else {
    if (
      typeof input.scopedMcpServerName !== "string"
      || !SAFE_SCOPED_MCP_NAME.test(input.scopedMcpServerName)
    ) {
      throw safeError("opencode_acp_scoped_mcp_server_invalid");
    }
    if (!sameStringList(suppliedTools, expectedTools)) {
      throw safeError("opencode_acp_role_tools_invalid");
    }
  }

  const scopedMcpServerName = input.scopedMcpServerName;
  const scopedToolIds = scopedMcpServerName === undefined
    ? []
    : suppliedTools.map((toolName) => openCodeToolId(scopedMcpServerName, toolName));
  if (new Set(scopedToolIds).size !== scopedToolIds.length) {
    throw safeError("opencode_acp_role_tool_collision");
  }
  // Task sessions retain OpenCode's native defaults. Meta is the only
  // deny-all surface and has no Task MCP registration.
  const configContent = input.nativeTools === "disabled"
    ? JSON.stringify({ permission: { "*": "deny" } })
    : JSON.stringify({});
  const policyDigest = digest({
    role: input.role,
    nativeTools: input.nativeTools,
    scopedMcpServerName: scopedMcpServerName ?? null,
    scopedToolNames: suppliedTools,
    configContent,
  });
  return Object.freeze({
    role: input.role,
    nativeTools: input.nativeTools,
    ...(scopedMcpServerName === undefined ? {} : { scopedMcpServerName }),
    scopedToolNames: Object.freeze(suppliedTools),
    configContent,
    policyDigest,
  });
}

/**
 * Discovers the current OpenCode executable on every invocation. Version and
 * digest are observations for the Host seal, never an admission allowlist.
 */
export function createOpenCodeAcpCurrentInstallDescriptor(
  options: OpenCodeAcpCurrentInstallOptions,
): AcpCurrentInstallDescriptor<ExecutionProfileDefinitionV3> {
  return createOpenCodeAcpInstallDescriptor(options, assertOpenCodeProfile);
}

/**
 * Independent Meta descriptor over the same current OpenCode installation.
 * Its process policy is permanently deny-all; callers cannot inject a Task
 * role policy or scoped MCP allow into the Meta resolution seal.
 */
export function createOpenCodeAcpMetaCurrentInstallDescriptor(
  options: OpenCodeAcpMetaCurrentInstallOptions,
): AcpCurrentInstallDescriptor<MetaProfileDefinitionV3> {
  return createOpenCodeAcpInstallDescriptor({
    ...options,
    executionPolicy: createOpenCodeAcpMetaExecutionPolicy(),
  }, assertOpenCodeMetaProfile);
}

function createOpenCodeAcpInstallDescriptor<
  TProfile extends AcpPortableProfileDefinitionV3,
>(
  options: OpenCodeAcpCurrentInstallOptions,
  assertProfile: (profile: AcpPortableProfileDefinitionV3) => void,
): AcpCurrentInstallDescriptor<TProfile> {
  const commandReference = options?.commandReference ?? "opencode";
  const inspectVersion = options?.inspectVersion ?? inspectInstalledVersion;
  const trustArtifact = options?.trustArtifact ?? defaultArtifactTrust;
  const executionPolicy = normalizeExecutionPolicy(options?.executionPolicy);

  return Object.freeze({
    descriptorId: "opencode-acp-current-install-v1",
    async discoverCurrent(profile): Promise<AcpDiscoveredArtifact> {
      assertProfile(profile);
      const searchPath = normalizeSearchPath(options?.executableSearchPath);
      const inspection = normalizePrivateDirectories(options?.inspectionEnvironment);
      const locale = safeLocale(options?.locale ?? "C.UTF-8");
      const baseEnvironment = Object.freeze({
        PATH: searchPath.join(path.delimiter),
        LANG: locale,
        OPENCODE_DISABLE_AUTOUPDATE: "1",
        OPENCODE_DISABLE_PROJECT_CONFIG: "1",
        OPENCODE_DISABLE_PRUNE: "1",
        OPENCODE_DISABLE_TERMINAL_TITLE: "1",
        OPENCODE_CONFIG_CONTENT: executionPolicy.configContent,
        OPENCODE_PURE: "1",
      });
      const versionEnvironment = Object.freeze({
        ...baseEnvironment,
        HOME: inspection.homeDirectory,
        XDG_CONFIG_HOME: inspection.configHome,
        XDG_DATA_HOME: inspection.dataHome,
        XDG_CACHE_HOME: inspection.cacheHome,
        XDG_STATE_HOME: inspection.stateHome,
        TMPDIR: inspection.temporaryDirectory,
      });
      const canonicalLauncherPath = await resolveCurrentExecutable(
        commandReference,
        searchPath,
      );
      const before = await safeStat(canonicalLauncherPath);
      if (!before.isFile() || (process.platform !== "win32" && (before.mode & 0o111) === 0)) {
        throw safeError("opencode_acp_artifact_not_executable");
      }
      const [artifactDigest, observedArtifactVersion, trusted] = await Promise.all([
        hashArtifact(canonicalLauncherPath),
        Promise.resolve(inspectVersion(Object.freeze({
          canonicalLauncherPath,
          environment: versionEnvironment,
        }))).then(normalizeVersion).catch((error) => {
          if (error instanceof OpenCodeAcpResolutionError) throw error;
          throw safeError("opencode_acp_version_observation_failed");
        }),
        Promise.resolve(trustArtifact(Object.freeze({
          canonicalLauncherPath,
          metadata: before,
        }))).catch(() => false),
      ]);
      const after = await safeStat(canonicalLauncherPath);
      if (!sameArtifactSnapshot(before, after)) {
        throw safeError("opencode_acp_artifact_drift_during_discovery");
      }
      const executionConfigDigest = digest({
        protocolMajor: profile.protocolMajor,
        launchArguments: OPEN_CODE_ACP_ARGUMENTS,
        environment: baseEnvironment,
        rolePolicyDigest: executionPolicy.policyDigest,
      });
      return Object.freeze({
        canonicalLauncherPath,
        launchArguments: OPEN_CODE_ACP_ARGUMENTS,
        observedArtifactVersion,
        artifactDigest,
        trustState: trusted ? "trusted" : "untrusted",
        executionConfigDigest,
        environment: baseEnvironment,
      });
    },
  });
}

/**
 * Normalizes the per-process private auth/XDG lease consumed by the generic
 * ACP process factory. Workspace cwd is intentionally absent: it is supplied
 * separately through the exact Binding's authorized workspace lease.
 */
export function createOpenCodeAcpCredentialLease(
  input: OpenCodeAcpCredentialLeaseInput,
): AcpCredentialLease {
  if (!input || typeof input !== "object" || typeof input.revoke !== "function") {
    throw safeError("opencode_acp_credential_lease_invalid");
  }
  const directories = normalizePrivateDirectories(input);
  const environment: Record<string, string> = {
    HOME: directories.homeDirectory,
    XDG_CONFIG_HOME: directories.configHome,
    XDG_DATA_HOME: directories.dataHome,
    XDG_CACHE_HOME: directories.cacheHome,
    XDG_STATE_HOME: directories.stateHome,
    TMPDIR: directories.temporaryDirectory,
  };
  Object.assign(environment, normalizeCredentialEnvironment(input.credentialEnvironment));
  let revokePromise: Promise<void> | undefined;
  return Object.freeze({
    environment: Object.freeze(environment),
    revoke() {
      revokePromise ??= Promise.resolve().then(() => input.revoke());
      return revokePromise;
    },
  });
}

/**
 * Begins acquisition immediately and retains cancellation ownership until the
 * generic process factory accepts the lease. Every directory and copied auth
 * byte is generation-private and cleanup is explicitly confirmed.
 */
export function beginOpenCodeAcpCredentialAcquisition(
  options: BeginOpenCodeAcpCredentialAcquisitionOptions,
): AcpCredentialAcquisitionOperation {
  if (!options || typeof options !== "object") {
    throw safeError("opencode_acp_credential_acquisition_invalid");
  }
  const privateRootParent = privateDirectory(options.privateRootParent);
  const sourceAuthFile = options.sourceAuthFile === undefined
    ? undefined
    : privateFile(options.sourceAuthFile);
  const persistentDataHome = options.persistentDataHome === undefined
    ? undefined
    : privateDirectory(options.persistentDataHome);
  const credentialEnvironment = normalizeCredentialEnvironment(options.credentialEnvironment);
  let cancelled = false;
  let privateRoot: string | undefined;
  let cleanupPromise: Promise<boolean> | undefined;

  const cleanup = (): Promise<boolean> => {
    if (privateRoot === undefined) return Promise.resolve(true);
    cleanupPromise ??= (async () => {
      const target = privateRoot!;
      try {
        await rm(target, { recursive: true, force: true });
        await lstat(target);
        return false;
      } catch (error) {
        return isMissingFile(error);
      }
    })();
    return cleanupPromise;
  };
  const assertNotCancelled = () => {
    if (cancelled) throw safeError("opencode_acp_credential_acquisition_cancelled");
  };

  const lease = (async (): Promise<AcpCredentialLease> => {
    try {
      assertNotCancelled();
      const canonicalParent = await realpath(privateRootParent).catch(() => {
        throw safeError("opencode_acp_private_root_parent_invalid");
      });
      const parentMetadata = await stat(canonicalParent).catch(() => {
        throw safeError("opencode_acp_private_root_parent_invalid");
      });
      if (!parentMetadata.isDirectory()) {
        throw safeError("opencode_acp_private_root_parent_invalid");
      }
      assertNotCancelled();
      const retainedDataHome = persistentDataHome === undefined
        ? undefined
        : await existingPrivateDirectory(persistentDataHome);
      privateRoot = await mkdtemp(path.join(canonicalParent, "agent-workspace-opencode-acp-"));
      await chmod(privateRoot, 0o700);
      assertNotCancelled();

      const directories = Object.freeze({
        homeDirectory: path.join(privateRoot, "home"),
        configHome: path.join(privateRoot, "config"),
        dataHome: retainedDataHome ?? path.join(privateRoot, "data"),
        cacheHome: path.join(privateRoot, "cache"),
        stateHome: path.join(privateRoot, "state"),
        temporaryDirectory: path.join(privateRoot, "tmp"),
      });
      for (const directory of Object.values(directories)) {
        if (retainedDataHome !== undefined && directory === retainedDataHome) {
          assertNotCancelled();
          continue;
        }
        await mkdir(directory, { mode: 0o700 });
        await chmod(directory, 0o700);
        assertNotCancelled();
      }
      if (sourceAuthFile !== undefined) {
        const authDirectory = path.join(directories.dataHome, "opencode");
        await mkdir(authDirectory, { mode: 0o700, recursive: true });
        await chmod(authDirectory, 0o700);
        await ensureOpaqueAuthFile(sourceAuthFile, path.join(authDirectory, "auth.json"));
        assertNotCancelled();
      }

      return createOpenCodeAcpCredentialLease({
        ...directories,
        credentialEnvironment,
        async revoke() {
          if (!await cleanup()) {
            throw safeError("opencode_acp_credential_cleanup_unconfirmed");
          }
        },
      });
    } catch (error) {
      const cleanupConfirmed = await cleanup();
      if (!cleanupConfirmed) throw safeError("opencode_acp_credential_cleanup_unconfirmed");
      if (error instanceof OpenCodeAcpResolutionError) throw error;
      throw safeError("opencode_acp_credential_acquisition_failed");
    }
  })();

  let cancellationPromise: Promise<Readonly<{ credentialCleanupConfirmed: boolean }>> | undefined;
  return Object.freeze({
    lease,
    cancelAndWait() {
      cancelled = true;
      cancellationPromise ??= (async () => {
        const resolvedLease = await lease.catch(() => undefined);
        if (resolvedLease !== undefined) await resolvedLease.revoke().catch(() => undefined);
        const credentialCleanupConfirmed = await cleanup();
        if (!credentialCleanupConfirmed) {
          throw safeError("opencode_acp_credential_cleanup_unconfirmed");
        }
        return Object.freeze({ credentialCleanupConfirmed });
      })();
      return cancellationPromise;
    },
  });
}

function assertOpenCodeProfile(
  profile: AcpPortableProfileDefinitionV3,
): asserts profile is ExecutionProfileDefinitionV3 {
  if (
    !profile
    || !("executionProfileId" in profile)
    || profile.providerFamily !== "opencode"
    || profile.acpAgentKind !== "native_acp"
    || profile.protocolMajor !== 1
  ) {
    throw safeError("opencode_acp_profile_mismatch");
  }
}

function assertOpenCodeMetaProfile(
  profile: AcpPortableProfileDefinitionV3,
): asserts profile is MetaProfileDefinitionV3 {
  if (
    !profile
    || !("metaProfileId" in profile)
    || profile.role !== "meta"
    || profile.providerFamily !== "opencode"
    || profile.acpAgentKind !== "native_acp"
    || profile.protocolMajor !== 1
  ) {
    throw safeError("opencode_acp_meta_profile_mismatch");
  }
}

function normalizeSearchPath(value: unknown): readonly string[] {
  if (typeof value !== "string" || !value || value.includes("\0")) {
    throw safeError("opencode_acp_search_path_invalid");
  }
  const entries = value.split(path.delimiter);
  if (entries.length === 0 || entries.some((entry) => !entry || !path.isAbsolute(entry))) {
    throw safeError("opencode_acp_search_path_invalid");
  }
  return Object.freeze([...entries]);
}

function normalizePrivateDirectories(value: unknown): OpenCodeAcpInspectionEnvironment {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw safeError("opencode_acp_private_directory_invalid");
  }
  const input = value as Partial<OpenCodeAcpInspectionEnvironment>;
  return Object.freeze({
    homeDirectory: privateDirectory(input.homeDirectory),
    configHome: privateDirectory(input.configHome),
    dataHome: privateDirectory(input.dataHome),
    cacheHome: privateDirectory(input.cacheHome),
    stateHome: privateDirectory(input.stateHome),
    temporaryDirectory: privateDirectory(input.temporaryDirectory),
  });
}

function privateDirectory(value: unknown): string {
  if (typeof value !== "string" || !path.isAbsolute(value) || value.includes("\0")) {
    throw safeError("opencode_acp_private_directory_invalid");
  }
  return path.normalize(value);
}

function privateFile(value: unknown): string {
  if (typeof value !== "string" || !path.isAbsolute(value) || value.includes("\0")) {
    throw safeError("opencode_acp_auth_source_unsafe");
  }
  return path.normalize(value);
}

function normalizeExecutionPolicy(value: unknown): OpenCodeAcpTaskExecutionPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw safeError("opencode_acp_role_policy_invalid");
  }
  const input = value as Partial<OpenCodeAcpTaskExecutionPolicy>;
  const normalized = {
    role: input.role as OpenCodeAcpTaskRole,
    ...(input.scopedMcpServerName === undefined
      ? {}
      : { scopedMcpServerName: input.scopedMcpServerName }),
    scopedToolNames: input.scopedToolNames,
  };
  return input.nativeTools === "disabled"
    ? createOpenCodeAcpMetaExecutionPolicy()
    : createOpenCodeAcpTaskExecutionPolicy(normalized);
}

function normalizeCredentialEnvironment(
  value: unknown,
): Readonly<Record<string, string>> {
  if (value === undefined) return Object.freeze({});
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw safeError("opencode_acp_credential_environment_invalid");
  }
  const environment: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!ENVIRONMENT_KEY.test(key) || typeof entry !== "string" || entry.includes("\0")) {
      throw safeError("opencode_acp_credential_environment_invalid");
    }
    if (HOST_OWNED_ENVIRONMENT.has(key) || key.startsWith("OPENCODE_")) {
      throw safeError("opencode_acp_credential_environment_conflict");
    }
    environment[key] = entry;
  }
  return Object.freeze(environment);
}

function sameStringList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

function openCodeToolId(serverName: string, toolName: string): string {
  const sanitize = (value: string) => value.replace(/[^a-zA-Z0-9_-]/gu, "_");
  return `${sanitize(serverName)}_${sanitize(toolName)}`;
}

async function copyOpaqueAuthFile(source: string, destination: string): Promise<void> {
  let before: Stats;
  try {
    before = await lstat(source);
  } catch {
    throw safeError("opencode_acp_auth_source_unsafe");
  }
  if (before.isSymbolicLink() || !before.isFile()) {
    throw safeError("opencode_acp_auth_source_unsafe");
  }
  if ((before.mode & 0o777) !== 0o600) {
    throw safeError("opencode_acp_auth_permissions_invalid");
  }
  if (before.size > MAX_AUTH_FILE_BYTES) {
    throw safeError("opencode_acp_auth_source_unsafe");
  }

  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  let sourceHandle;
  try {
    sourceHandle = await open(source, constants.O_RDONLY | noFollow);
  } catch {
    throw safeError("opencode_acp_auth_source_unsafe");
  }
  let bytes: Buffer;
  try {
    const opened = await sourceHandle.stat();
    if (!opened.isFile() || !sameArtifactSnapshot(before, opened)) {
      throw safeError("opencode_acp_auth_source_unsafe");
    }
    bytes = await sourceHandle.readFile();
    const afterRead = await sourceHandle.stat();
    if (
      bytes.byteLength > MAX_AUTH_FILE_BYTES
      || !sameArtifactSnapshot(opened, afterRead)
      || bytes.byteLength !== opened.size
    ) {
      throw safeError("opencode_acp_auth_source_unsafe");
    }
  } finally {
    await sourceHandle.close().catch(() => undefined);
  }

  let destinationHandle;
  try {
    destinationHandle = await open(
      destination,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow,
      0o600,
    );
    await destinationHandle.writeFile(bytes);
    await destinationHandle.sync();
  } catch (error) {
    if (error instanceof OpenCodeAcpResolutionError) throw error;
    throw safeError("opencode_acp_auth_copy_failed");
  } finally {
    await destinationHandle?.close().catch(() => undefined);
  }
  await chmod(destination, 0o600).catch(() => {
    throw safeError("opencode_acp_auth_copy_failed");
  });
  const copied = await lstat(destination).catch(() => {
    throw safeError("opencode_acp_auth_copy_failed");
  });
  if (copied.isSymbolicLink() || !copied.isFile() || (copied.mode & 0o777) !== 0o600) {
    throw safeError("opencode_acp_auth_copy_failed");
  }
}

async function ensureOpaqueAuthFile(source: string, destination: string): Promise<void> {
  try {
    const existing = await lstat(destination);
    const currentUid = typeof process.getuid === "function" ? process.getuid() : undefined;
    if (existing.isSymbolicLink() || !existing.isFile() || existing.nlink !== 1
      || (existing.mode & 0o777) !== 0o600
      || (currentUid !== undefined && existing.uid !== currentUid)) {
      throw safeError("opencode_acp_auth_copy_failed");
    }
    return;
  } catch (error) {
    if (!isMissingFile(error)) {
      if (error instanceof OpenCodeAcpResolutionError) throw error;
      throw safeError("opencode_acp_auth_copy_failed");
    }
  }
  await copyOpaqueAuthFile(source, destination);
}

async function existingPrivateDirectory(directory: string): Promise<string> {
  try {
    const [metadata, canonical] = await Promise.all([lstat(directory), realpath(directory)]);
    const currentUid = typeof process.getuid === "function" ? process.getuid() : undefined;
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || canonical !== directory
      || (metadata.mode & 0o777) !== 0o700
      || (currentUid !== undefined && metadata.uid !== currentUid)) {
      throw new Error("unsafe_private_directory");
    }
    return canonical;
  } catch (error) {
    if (error instanceof OpenCodeAcpResolutionError) throw error;
    throw safeError("opencode_acp_private_directory_invalid");
  }
}

function isMissingFile(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as NodeJS.ErrnoException).code === "ENOENT");
}

function safeLocale(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._@-]{0,63}$/u.test(value)) {
    throw safeError("opencode_acp_locale_invalid");
  }
  return value;
}

async function resolveCurrentExecutable(
  commandReference: string,
  searchPath: readonly string[],
): Promise<string> {
  let candidates: readonly string[];
  if (path.isAbsolute(commandReference)) candidates = [commandReference];
  else {
    if (!SAFE_COMMAND.test(commandReference) || commandReference.includes(path.sep)) {
      throw safeError("opencode_acp_command_reference_invalid");
    }
    candidates = searchPath.map((directory) => path.join(directory, commandReference));
  }
  for (const candidate of candidates) {
    try {
      await access(candidate, process.platform === "win32" ? constants.F_OK : constants.X_OK);
      const canonical = await realpath(candidate);
      if (!path.isAbsolute(canonical)) continue;
      const metadata = await stat(canonical);
      if (metadata.isFile()) return canonical;
    } catch {
      // Continue through the explicit PATH snapshot without exposing candidates.
    }
  }
  throw safeError("opencode_acp_current_install_not_found");
}

async function safeStat(file: string): Promise<Stats> {
  try {
    return await stat(file);
  } catch {
    throw safeError("opencode_acp_current_install_not_found");
  }
}

async function hashArtifact(file: string): Promise<string> {
  const hash = createHash("sha256");
  try {
    for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  } catch {
    throw safeError("opencode_acp_artifact_unreadable");
  }
  return `sha256:${hash.digest("hex")}`;
}

function inspectInstalledVersion(input: OpenCodeAcpVersionInspection): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      input.canonicalLauncherPath,
      ["--version"],
      {
        env: { ...input.environment },
        encoding: "utf8",
        maxBuffer: 64 * 1024,
        timeout: 5_000,
        windowsHide: true,
      },
      (error, stdout) => {
        if (error) reject(safeError("opencode_acp_version_observation_failed"));
        else resolve(stdout);
      },
    );
  });
}

function normalizeVersion(value: unknown): string {
  if (typeof value !== "string") throw safeError("opencode_acp_version_observation_invalid");
  const lines = value.trim().split(/\r?\n/u).filter(Boolean);
  if (lines.length !== 1) throw safeError("opencode_acp_version_observation_invalid");
  const candidate = lines[0]!.trim().replace(/^opencode\s+/iu, "");
  if (!SAFE_VERSION.test(candidate)) throw safeError("opencode_acp_version_observation_invalid");
  return candidate;
}

function defaultArtifactTrust(input: Readonly<{ metadata: Stats }>): boolean {
  if (!input.metadata.isFile()) return false;
  if (process.platform === "win32") return true;
  const currentUid = typeof process.getuid === "function" ? process.getuid() : undefined;
  const ownerTrusted = input.metadata.uid === 0
    || (currentUid !== undefined && input.metadata.uid === currentUid);
  return ownerTrusted && (input.metadata.mode & 0o022) === 0;
}

function sameArtifactSnapshot(left: Stats, right: Stats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mode === right.mode
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(stableJson(value)).digest("hex")}`;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function safeError(code: string): OpenCodeAcpResolutionError {
  return new OpenCodeAcpResolutionError(code);
}

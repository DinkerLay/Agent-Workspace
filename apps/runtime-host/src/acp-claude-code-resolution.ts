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
const EXACT_NODE_SHEBANG = "#!/usr/bin/env node";
const MAX_SHEBANG_BYTES = 256;
const MAX_SETTINGS_BYTES = 1024 * 1024;
const VERSION_TIMEOUT_MS = 5_000;
const VERSION_MAX_BUFFER_BYTES = 64 * 1024;
const SAFE_CLAUDE_SETTING_ENV = new Set([
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_MODEL",
  "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
  "CLAUDE_CODE_SUBAGENT_MODEL",
  "DISABLE_BUG_COMMAND",
  "DISABLE_ERROR_REPORTING",
  "DISABLE_TELEMETRY",
  "ENABLE_TOOL_SEARCH",
]);
const CREDENTIAL_POLICY_OVERRIDE_KEYS = new Set([
  "CLAUDE_CODE_EXECUTABLE",
  "CLAUDE_CONFIG_DIR",
  "HOME",
  "LANG",
  "LC_ALL",
  "NO_BROWSER",
  "PATH",
  "TMPDIR",
  "environment",
  "locale",
  "policyEnvironment",
]);

export type ClaudeCodeAcpArtifactKind = "wrapper" | "claude" | "node";

export type ClaudeCodeAcpVersionInspection = Readonly<{
  readonly canonicalCommandPath: string;
  readonly environment: Readonly<Record<string, string>>;
}>;

export type ClaudeCodeAcpTrustInspection = Readonly<{
  readonly kind: ClaudeCodeAcpArtifactKind;
  readonly canonicalCommandPath: string;
  readonly metadata: Stats;
}>;

export type ClaudeCodeAcpCurrentInstallOptions = Readonly<{
  /** Explicit selected wrapper entry; no repository or bundled fallback exists. */
  readonly wrapperCommandReference: string;
  /** Explicit current upstream Claude Code entry assigned to `CLAUDE_CODE_EXECUTABLE`. */
  readonly claudeCommandReference: string;
  /** Explicit Node identity that the wrapper's `/usr/bin/env node` must resolve. */
  readonly nodeCommandReference: string;
  /** Snapshotted, non-ambient PATH used both for shebang resolution and launch. */
  readonly executableSearchPath: string;
  /** Exact Claude/CCSwitch source whose sanitized routing state is resolution-fenced. */
  readonly settingsSourcePath: string;
  readonly locale?: string;
  readonly inspectWrapperVersion?: (input: ClaudeCodeAcpVersionInspection) => Promise<string>;
  readonly inspectClaudeCodeVersion?: (input: ClaudeCodeAcpVersionInspection) => Promise<string>;
  readonly inspectNodeVersion?: (input: ClaudeCodeAcpVersionInspection) => Promise<string>;
  readonly trustArtifact?: (
    input: ClaudeCodeAcpTrustInspection,
  ) => boolean | Promise<boolean>;
}>;

export type BeginClaudeCodeAcpCredentialAcquisitionOptions = Readonly<{
  /** Existing or creatable Host-private parent; it must resolve to a 0700 directory. */
  readonly privateRootParent: string;
  /** Explicit owner-controlled Claude/CCSwitch settings source. */
  readonly sourceSettingsFile: string;
  /**
   * Optional Binding-owned CLAUDE_CONFIG_DIR. Only provider session data
   * survives a process generation; sanitized settings are removed before
   * credential cleanup is confirmed.
   */
  readonly persistentConfigDirectory?: string;
  /** Injectable exact-tree cleanup used by deterministic failure tests. */
  readonly removePrivateTree?: (privateGenerationRoot: string) => Promise<void>;
}>;

export class ClaudeCodeAcpResolutionError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "ClaudeCodeAcpResolutionError";
    this.code = code;
  }
}

type ResolvedExecutable = Readonly<{
  readonly selectedEntryPath: string;
  readonly canonicalCommandPath: string;
  readonly metadata: Stats;
  readonly digest: string;
}>;

type SanitizedClaudeSettings = Readonly<{
  readonly contents: Buffer;
  readonly environment: Readonly<Record<string, string>>;
}>;

/**
 * Discovers the wrapper, its exact shebang runtime, and current ClaudeCode upstream
 * on every call. Observed versions are evidence, never an admission allowlist.
 */
export function createClaudeCodeAcpCurrentInstallDescriptor(
  options: ClaudeCodeAcpCurrentInstallOptions,
): AcpCurrentInstallDescriptor<ExecutionProfileDefinitionV3> {
  return createClaudeCodeAcpInstallDescriptor(options, assertClaudeCodeProfile);
}

/** Independent Meta descriptor; Task/Profile role admission remains separate. */
export function createClaudeCodeAcpMetaCurrentInstallDescriptor(
  options: ClaudeCodeAcpCurrentInstallOptions,
): AcpCurrentInstallDescriptor<MetaProfileDefinitionV3> {
  return createClaudeCodeAcpInstallDescriptor(options, assertClaudeCodeMetaProfile);
}

function createClaudeCodeAcpInstallDescriptor<
  TProfile extends AcpPortableProfileDefinitionV3,
>(
  options: ClaudeCodeAcpCurrentInstallOptions,
  assertProfile: (profile: AcpPortableProfileDefinitionV3) => void,
): AcpCurrentInstallDescriptor<TProfile> {
  const inspectWrapperVersion = options?.inspectWrapperVersion
    ?? ((input) => inspectInstalledVersion(input, ["--version"]));
  const inspectClaudeCodeVersion = options?.inspectClaudeCodeVersion
    ?? ((input) => inspectInstalledVersion(input, ["--version"], "first"));
  const inspectNodeVersion = options?.inspectNodeVersion
    ?? ((input) => inspectInstalledVersion(input, ["--version"]));
  const trustArtifact = options?.trustArtifact ?? defaultArtifactTrust;

  return Object.freeze({
    descriptorId: "claude-acp-current-install-v1",
    async discoverCurrent(profile): Promise<AcpDiscoveredArtifact> {
      assertProfile(profile);
      const searchPath = normalizeSearchPath(options?.executableSearchPath);
      const locale = safeLocale(options?.locale ?? "C.UTF-8");
      const wrapperReference = commandReference(
        options?.wrapperCommandReference,
        "claude_code_acp_wrapper_reference_invalid",
      );
      const claudeReference = commandReference(
        options?.claudeCommandReference,
        "claude_code_acp_upstream_reference_invalid",
      );
      const nodeReference = commandReference(
        options?.nodeCommandReference,
        "claude_code_acp_node_reference_invalid",
      );
      const settingsSourcePath = absolutePath(
        options?.settingsSourcePath,
        "claude_code_acp_settings_source_path_invalid",
      );

      const wrapper = await resolveExecutable(
        wrapperReference,
        searchPath,
        "claude_code_acp_wrapper_not_found",
        "claude_code_acp_wrapper_not_executable",
      );
      const shebang = await readNodeShebang(wrapper.canonicalCommandPath);
      const claude = await resolveExecutable(
        claudeReference,
        searchPath,
        "claude_code_acp_upstream_not_found",
        "claude_code_acp_upstream_not_executable",
      );
      const explicitNode = await resolveExecutable(
        nodeReference,
        searchPath,
        "claude_code_acp_node_not_found",
        "claude_code_acp_node_not_executable",
      );
      const pathNode = await resolveExecutable(
        "node",
        searchPath,
        "claude_code_acp_node_not_found",
        "claude_code_acp_node_not_executable",
      );
      if (explicitNode.canonicalCommandPath !== pathNode.canonicalCommandPath
        || !sameArtifactSnapshot(explicitNode.metadata, pathNode.metadata)
        || explicitNode.digest !== pathNode.digest) {
        throw safeError("claude_code_acp_node_path_mismatch");
      }

      const environment = Object.freeze({
        PATH: searchPath.join(path.delimiter),
        CLAUDE_CODE_EXECUTABLE: claude.canonicalCommandPath,
        NO_BROWSER: "1",
        LANG: locale,
        LC_ALL: locale,
      });
      const [wrapperTrusted, claudeTrusted, nodeTrusted] = await Promise.all([
        observeTrust(trustArtifact, "wrapper", wrapper),
        observeTrust(trustArtifact, "claude", claude),
        observeTrust(trustArtifact, "node", explicitNode),
      ]);
      if (!wrapperTrusted) throw safeError("claude_code_acp_wrapper_untrusted");
      if (!claudeTrusted) throw safeError("claude_code_acp_upstream_untrusted");
      if (!nodeTrusted) throw safeError("claude_code_acp_node_untrusted");

      const [wrapperVersion, claudeVersion, nodeVersion, settingsDigest] = await Promise.all([
        observeVersion(
          inspectWrapperVersion,
          wrapper.canonicalCommandPath,
          environment,
          "claude_code_acp_wrapper_version_observation_failed",
        ),
        observeVersion(
          inspectClaudeCodeVersion,
          claude.canonicalCommandPath,
          environment,
          "claude_code_acp_upstream_version_observation_failed",
        ),
        observeVersion(
          inspectNodeVersion,
          explicitNode.canonicalCommandPath,
          environment,
          "claude_code_acp_node_version_observation_failed",
        ),
        readSanitizedSettingsSource(settingsSourcePath).then((settings) => {
          try {
            return digest({ sanitizedSettings: settings.contents.toString("utf8") });
          } finally {
            settings.contents.fill(0);
          }
        }),
      ]);

      await assertDiscoverySnapshotCurrent({
        reference: wrapperReference,
        searchPath,
        expected: wrapper,
        notFoundCode: "claude_code_acp_wrapper_not_found",
        notExecutableCode: "claude_code_acp_wrapper_not_executable",
      });
      if (await readNodeShebang(wrapper.canonicalCommandPath) !== shebang) {
        throw safeError("claude_code_acp_wrapper_drift_during_discovery");
      }
      await assertDiscoverySnapshotCurrent({
        reference: claudeReference,
        searchPath,
        expected: claude,
        notFoundCode: "claude_code_acp_upstream_not_found",
        notExecutableCode: "claude_code_acp_upstream_not_executable",
      });
      await assertDiscoverySnapshotCurrent({
        reference: nodeReference,
        searchPath,
        expected: explicitNode,
        notFoundCode: "claude_code_acp_node_not_found",
        notExecutableCode: "claude_code_acp_node_not_executable",
      });
      const currentPathNode = await resolveExecutable(
        "node",
        searchPath,
        "claude_code_acp_node_not_found",
        "claude_code_acp_node_not_executable",
      );
      if (currentPathNode.canonicalCommandPath !== explicitNode.canonicalCommandPath
        || !sameArtifactSnapshot(currentPathNode.metadata, explicitNode.metadata)
        || currentPathNode.digest !== explicitNode.digest) {
        throw safeError("claude_code_acp_node_drift_during_discovery");
      }

      const launchArguments = Object.freeze([] as string[]);
      const executionConfigDigest = digest({
        protocolMajor: profile.protocolMajor,
        wrapper: artifactIdentity(wrapper, wrapperVersion),
        upstream: artifactIdentity(claude, claudeVersion),
        runtime: artifactIdentity(explicitNode, nodeVersion),
        shebang,
        launchArguments,
        environment,
        settingsDigest,
        ambientClaudeConfiguration: false,
        bundledFallback: false,
      });
      return Object.freeze({
        canonicalLauncherPath: wrapper.canonicalCommandPath,
        launchArguments,
        observedArtifactVersion: wrapperVersion,
        observedUpstreamVersion: claudeVersion,
        artifactDigest: wrapper.digest,
        trustState: "trusted",
        executionConfigDigest,
        environment,
      });
    },
  });
}

/**
 * Begins an owned credential acquisition suitable for Phase 2's
 * `beginCredentialAcquisition` seam. Cancellation never reports confirmed
 * until every generation-local byte has been removed and absence rechecked.
 */
export function beginClaudeCodeAcpCredentialAcquisition(
  options: BeginClaudeCodeAcpCredentialAcquisitionOptions,
): AcpCredentialAcquisitionOperation {
  let cancelled = false;
  let privateGenerationRoot: string | undefined;
  let cleanupPromise: Promise<void> | undefined;
  let credential: AcpCredentialLease | undefined;
  let retainedClaudeConfigDirectory: string | undefined;
  const removePrivateTree = options?.removePrivateTree
    ?? ((target: string) => rm(target, { recursive: true, force: true }));

  const cleanup = (): Promise<void> => {
    if (!privateGenerationRoot) return Promise.resolve();
    if (cleanupPromise) return cleanupPromise;
    const target = privateGenerationRoot;
    cleanupPromise = (async () => {
      try {
        await removePrivateTree(target);
        if (await pathExists(target)) {
          throw safeError("claude_code_acp_credential_cleanup_unconfirmed");
        }
        if (retainedClaudeConfigDirectory) {
          const settingsCopy = path.join(retainedClaudeConfigDirectory, "settings.json");
          await rm(settingsCopy, { force: true });
          if (await pathExists(settingsCopy)) {
            throw safeError("claude_code_acp_credential_cleanup_unconfirmed");
          }
        }
      } catch {
        throw safeError("claude_code_acp_credential_cleanup_unconfirmed");
      }
    })();
    cleanupPromise.catch(() => undefined);
    return cleanupPromise;
  };

  const lease = (async (): Promise<AcpCredentialLease> => {
    let sanitizedSettings: SanitizedClaudeSettings | undefined;
    try {
      assertNoCredentialPolicyOverride(options);
      const runtimePrivateRoot = absolutePath(
        options?.privateRootParent,
        "claude_code_acp_runtime_private_root_invalid",
      );
      const settingsSourcePath = absolutePath(
        options?.sourceSettingsFile,
        "claude_code_acp_settings_source_path_invalid",
      );
      await ensurePrivateParent(runtimePrivateRoot);
      sanitizedSettings = await readSanitizedSettingsSource(settingsSourcePath);
      if (cancelled) throw safeError("claude_code_acp_credential_acquisition_cancelled");

      privateGenerationRoot = await mkdtemp(path.join(runtimePrivateRoot, "claude-acp-"));
      await chmod(privateGenerationRoot, 0o700);
      const claudeConfigDirectory = options.persistentConfigDirectory === undefined
        ? path.join(privateGenerationRoot, "claude-config")
        : absolutePath(
            options.persistentConfigDirectory,
            "claude_code_acp_persistent_config_invalid",
          );
      const homeDirectory = path.join(privateGenerationRoot, "home");
      const temporaryDirectory = path.join(privateGenerationRoot, "tmp");
      if (options.persistentConfigDirectory === undefined) {
        await mkdir(claudeConfigDirectory, { mode: 0o700 });
      } else {
        await assertPrivateDirectory(claudeConfigDirectory).catch(() => {
          throw safeError("claude_code_acp_persistent_config_invalid");
        });
        retainedClaudeConfigDirectory = claudeConfigDirectory;
      }
      await mkdir(homeDirectory, { mode: 0o700 });
      await mkdir(temporaryDirectory, { mode: 0o700 });
      await assertPrivateDirectory(privateGenerationRoot);
      await assertPrivateDirectory(claudeConfigDirectory);
      await assertPrivateDirectory(homeDirectory);
      await assertPrivateDirectory(temporaryDirectory);
      await writePrivateFile(
        path.join(claudeConfigDirectory, "settings.json"),
        sanitizedSettings.contents,
        "claude_code_acp_settings_copy_invalid",
      );
      if (cancelled) {
        await cleanup();
        throw safeError("claude_code_acp_credential_acquisition_cancelled");
      }

      credential = Object.freeze({
        environment: Object.freeze({
          HOME: homeDirectory,
          CLAUDE_CONFIG_DIR: claudeConfigDirectory,
          TMPDIR: temporaryDirectory,
          ...sanitizedSettings.environment,
        }),
        revoke: cleanup,
      });
      return credential;
    } catch (error) {
      if (privateGenerationRoot) {
        try {
          await cleanup();
        } catch {
          throw safeError("claude_code_acp_credential_cleanup_unconfirmed");
        }
      }
      if (error instanceof ClaudeCodeAcpResolutionError) throw error;
      throw safeError("claude_code_acp_credential_acquisition_failed");
    } finally {
      sanitizedSettings?.contents.fill(0);
    }
  })();
  lease.catch(() => undefined);

  let cancellationPromise: Promise<Readonly<{ readonly credentialCleanupConfirmed: boolean }>> | undefined;
  return Object.freeze({
    lease,
    cancelAndWait() {
      cancelled = true;
      cancellationPromise ??= (async () => {
        try {
          const acquired = credential ?? await lease;
          await acquired.revoke();
        } catch {
          if (privateGenerationRoot) await cleanup();
        }
        if (privateGenerationRoot && await pathExists(privateGenerationRoot)) {
          throw safeError("claude_code_acp_credential_cleanup_unconfirmed");
        }
        return Object.freeze({ credentialCleanupConfirmed: true });
      })();
      cancellationPromise.catch(() => undefined);
      return cancellationPromise;
    },
  });
}

function assertClaudeCodeProfile(
  profile: AcpPortableProfileDefinitionV3,
): asserts profile is ExecutionProfileDefinitionV3 {
  if (!profile
    || !("executionProfileId" in profile)
    || profile.providerFamily !== "claude-code"
    || profile.acpAgentKind !== "claude_agent_acp"
    || profile.protocolMajor !== 1) {
    throw safeError("claude_code_acp_profile_mismatch");
  }
}

function assertClaudeCodeMetaProfile(
  profile: AcpPortableProfileDefinitionV3,
): asserts profile is MetaProfileDefinitionV3 {
  if (!profile
    || !("metaProfileId" in profile)
    || profile.role !== "meta"
    || profile.providerFamily !== "claude-code"
    || profile.acpAgentKind !== "claude_agent_acp"
    || profile.protocolMajor !== 1) {
    throw safeError("claude_code_acp_meta_profile_mismatch");
  }
}

function commandReference(value: unknown, code: string): string {
  if (typeof value !== "string" || !value || value.includes("\0")) throw safeError(code);
  if (path.isAbsolute(value)) return path.normalize(value);
  if (!SAFE_COMMAND.test(value)) throw safeError(code);
  return value;
}

function normalizeSearchPath(value: unknown): readonly string[] {
  if (typeof value !== "string" || !value || value.includes("\0")) {
    throw safeError("claude_code_acp_search_path_invalid");
  }
  const entries = value.split(path.delimiter);
  if (entries.length === 0 || entries.some((entry) => !entry || !path.isAbsolute(entry))) {
    throw safeError("claude_code_acp_search_path_invalid");
  }
  return Object.freeze(entries.map((entry) => path.normalize(entry)));
}

async function resolveExecutable(
  reference: string,
  searchPath: readonly string[],
  notFoundCode: string,
  notExecutableCode: string,
): Promise<ResolvedExecutable> {
  const selectedEntryPath = path.isAbsolute(reference)
    ? reference
    : await firstExecutableEntry(reference, searchPath, notFoundCode);
  let canonicalCommandPath: string;
  let metadata: Stats;
  try {
    canonicalCommandPath = await realpath(selectedEntryPath);
    metadata = await stat(canonicalCommandPath);
    await access(selectedEntryPath, constants.X_OK);
  } catch {
    throw safeError(notFoundCode);
  }
  if (!metadata.isFile()
    || (process.platform !== "win32" && (metadata.mode & 0o111) === 0)) {
    throw safeError(notExecutableCode);
  }
  return Object.freeze({
    selectedEntryPath,
    canonicalCommandPath,
    metadata,
    digest: await hashArtifact(canonicalCommandPath),
  });
}

async function firstExecutableEntry(
  command: string,
  searchPath: readonly string[],
  notFoundCode: string,
): Promise<string> {
  for (const directory of searchPath) {
    const candidate = path.join(directory, command);
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Continue only within the caller-supplied exact search path.
    }
  }
  throw safeError(notFoundCode);
}

async function readNodeShebang(canonicalWrapperPath: string): Promise<string> {
  const handle = await open(canonicalWrapperPath, constants.O_RDONLY);
  try {
    const buffer = Buffer.alloc(MAX_SHEBANG_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, 0);
    const firstLine = buffer.subarray(0, bytesRead).toString("utf8").split(/\r?\n/u, 1)[0];
    if (firstLine !== EXACT_NODE_SHEBANG) {
      throw safeError("claude_code_acp_wrapper_shebang_unsupported");
    }
    return firstLine;
  } finally {
    await handle.close();
  }
}

async function observeVersion(
  inspect: (input: ClaudeCodeAcpVersionInspection) => Promise<string>,
  canonicalCommandPath: string,
  environment: Readonly<Record<string, string>>,
  code: string,
): Promise<string> {
  try {
    return normalizeVersion(await inspect(Object.freeze({ canonicalCommandPath, environment })), code);
  } catch (error) {
    if (error instanceof ClaudeCodeAcpResolutionError) throw error;
    throw safeError(code);
  }
}

async function inspectInstalledVersion(
  input: ClaudeCodeAcpVersionInspection,
  arguments_: readonly string[],
  tokenPosition: "first" | "last" = "last",
): Promise<string> {
  const output = await new Promise<string>((resolve, reject) => {
    execFile(input.canonicalCommandPath, [...arguments_], {
      encoding: "utf8",
      env: { ...input.environment },
      maxBuffer: VERSION_MAX_BUFFER_BYTES,
      timeout: VERSION_TIMEOUT_MS,
      windowsHide: true,
    }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
  const tokens = output.trim().split(/\s+/u);
  const token = tokenPosition === "first" ? tokens.at(0) : tokens.at(-1);
  if (!token) throw safeError("claude_code_acp_version_output_invalid");
  return token;
}

function normalizeVersion(value: unknown, code: string): string {
  if (typeof value !== "string" || !SAFE_VERSION.test(value)) throw safeError(code);
  return value;
}

async function observeTrust(
  trust: (input: ClaudeCodeAcpTrustInspection) => boolean | Promise<boolean>,
  kind: ClaudeCodeAcpArtifactKind,
  executable: ResolvedExecutable,
): Promise<boolean> {
  try {
    return await trust(Object.freeze({
      kind,
      canonicalCommandPath: executable.canonicalCommandPath,
      metadata: executable.metadata,
    })) === true;
  } catch {
    return false;
  }
}

function defaultArtifactTrust(input: ClaudeCodeAcpTrustInspection): boolean {
  const owner = typeof process.getuid === "function" ? process.getuid() : undefined;
  const ownerTrusted = owner === undefined || input.metadata.uid === owner || input.metadata.uid === 0;
  return input.metadata.isFile()
    && (process.platform === "win32" || (input.metadata.mode & 0o111) !== 0)
    && (input.metadata.mode & 0o022) === 0
    && ownerTrusted;
}

async function assertDiscoverySnapshotCurrent(input: Readonly<{
  readonly reference: string;
  readonly searchPath: readonly string[];
  readonly expected: ResolvedExecutable;
  readonly notFoundCode: string;
  readonly notExecutableCode: string;
}>): Promise<void> {
  const current = await resolveExecutable(
    input.reference,
    input.searchPath,
    input.notFoundCode,
    input.notExecutableCode,
  );
  if (current.canonicalCommandPath !== input.expected.canonicalCommandPath
    || !sameArtifactSnapshot(current.metadata, input.expected.metadata)
    || current.digest !== input.expected.digest) {
    throw safeError(`${input.notFoundCode.replace(/_not_found$/u, "")}_drift_during_discovery`);
  }
}

function sameArtifactSnapshot(left: Stats, right: Stats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

function artifactIdentity(executable: ResolvedExecutable, version: string): unknown {
  return Object.freeze({
    canonicalCommandPath: executable.canonicalCommandPath,
    metadata: Object.freeze({
      dev: executable.metadata.dev,
      ino: executable.metadata.ino,
      mode: executable.metadata.mode,
      size: executable.metadata.size,
      mtimeMs: executable.metadata.mtimeMs,
      ctimeMs: executable.metadata.ctimeMs,
    }),
    digest: executable.digest,
    version,
  });
}

async function hashArtifact(artifactPath: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(artifactPath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", reject);
    stream.once("end", resolve);
  });
  return `sha256:${hash.digest("hex")}`;
}

function safeLocale(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._@-]{0,63}$/u.test(value)) {
    throw safeError("claude_code_acp_locale_invalid");
  }
  return value;
}

function assertNoCredentialPolicyOverride(value: unknown): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw safeError("claude_code_acp_credential_acquisition_invalid");
  }
  for (const key of Object.keys(value)) {
    if (CREDENTIAL_POLICY_OVERRIDE_KEYS.has(key)) {
      throw safeError("claude_code_acp_credential_policy_override");
    }
  }
}

function absolutePath(value: unknown, code: string): string {
  if (typeof value !== "string" || !path.isAbsolute(value) || value.includes("\0")) {
    throw safeError(code);
  }
  return path.normalize(value);
}

async function ensurePrivateParent(runtimePrivateRoot: string): Promise<void> {
  try {
    await mkdir(runtimePrivateRoot, { recursive: true, mode: 0o700 });
  } catch {
    throw safeError("claude_code_acp_runtime_private_root_invalid");
  }
  await assertPrivateDirectory(runtimePrivateRoot, "claude_code_acp_runtime_private_root_invalid");
}

async function assertPrivateDirectory(
  directory: string,
  code = "claude_code_acp_private_directory_invalid",
): Promise<void> {
  let metadata: Stats;
  try {
    metadata = await lstat(directory);
  } catch {
    throw safeError(code);
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory() || (metadata.mode & 0o777) !== 0o700) {
    throw safeError(code);
  }
}

async function readSanitizedSettingsSource(
  settingsSourcePath: string,
): Promise<SanitizedClaudeSettings> {
  let selected: Stats;
  try {
    selected = await lstat(settingsSourcePath);
  } catch {
    throw safeError("claude_code_acp_settings_source_not_found");
  }
  const currentUid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (selected.isSymbolicLink()) throw safeError("claude_code_acp_settings_source_symlink_forbidden");
  if (!selected.isFile()) throw safeError("claude_code_acp_settings_source_not_regular");
  if ((selected.mode & 0o022) !== 0
    || (currentUid !== undefined && selected.uid !== currentUid)) {
    throw safeError("claude_code_acp_settings_source_permissions_invalid");
  }
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  let handle;
  try {
    handle = await open(settingsSourcePath, constants.O_RDONLY | noFollow);
  } catch {
    throw safeError("claude_code_acp_settings_source_open_failed");
  }
  try {
    const before = await handle.stat();
    if (!before.isFile()
      || (before.mode & 0o022) !== 0
      || (currentUid !== undefined && before.uid !== currentUid)
      || before.dev !== selected.dev
      || before.ino !== selected.ino
      || before.size <= 0
      || before.size > MAX_SETTINGS_BYTES) {
      throw safeError("claude_code_acp_settings_source_invalid");
    }
    const contents = await handle.readFile();
    const after = await handle.stat();
    if (!sameArtifactSnapshot(before, after) || contents.byteLength !== before.size) {
      contents.fill(0);
      throw safeError("claude_code_acp_settings_source_drift");
    }
    try {
      return sanitizeClaudeSettings(contents);
    } finally {
      contents.fill(0);
    }
  } finally {
    await handle.close();
  }
}

function sanitizeClaudeSettings(contents: Buffer): SanitizedClaudeSettings {
  let value: unknown;
  try {
    value = JSON.parse(contents.toString("utf8"));
  } catch {
    throw safeError("claude_code_acp_settings_source_invalid");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw safeError("claude_code_acp_settings_source_invalid");
  }
  const source = value as Record<string, unknown>;
  const sourceEnvironment = source.env === undefined
    ? {}
    : source.env;
  if (!sourceEnvironment || typeof sourceEnvironment !== "object"
    || Array.isArray(sourceEnvironment)) {
    throw safeError("claude_code_acp_settings_environment_invalid");
  }
  const environment: Record<string, string> = {};
  for (const [key, entry] of Object.entries(sourceEnvironment as Record<string, unknown>)) {
    if (!SAFE_CLAUDE_SETTING_ENV.has(key)) continue;
    if (typeof entry !== "string" || entry.length > 32_768 || /[\0\r\n]/u.test(entry)) {
      throw safeError("claude_code_acp_settings_environment_invalid");
    }
    environment[key] = entry;
  }
  const model = source.model;
  if (model !== undefined
    && (typeof model !== "string" || !SAFE_VERSION.test(model))) {
    throw safeError("claude_code_acp_settings_model_invalid");
  }
  if (typeof model === "string" && environment.ANTHROPIC_MODEL === undefined) {
    environment.ANTHROPIC_MODEL = model;
  }
  return Object.freeze({
    contents: Buffer.from(JSON.stringify({
      env: environment,
      ...(typeof model === "string" ? { model } : {}),
    }), "utf8"),
    environment: Object.freeze({ ...environment }),
  });
}

async function writePrivateFile(destination: string, contents: Buffer, code: string): Promise<void> {
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  const handle = await open(
    destination,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow,
    0o600,
  );
  try {
    await handle.writeFile(contents);
    await handle.chmod(0o600);
    await handle.sync();
  } finally {
    await handle.close();
  }
  const copied = await lstat(destination);
  if (copied.isSymbolicLink() || !copied.isFile() || (copied.mode & 0o777) !== 0o600) {
    throw safeError(code);
  }
}

async function pathExists(value: string): Promise<boolean> {
  try {
    await lstat(value);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
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

function safeError(code: string): ClaudeCodeAcpResolutionError {
  return new ClaudeCodeAcpResolutionError(code);
}

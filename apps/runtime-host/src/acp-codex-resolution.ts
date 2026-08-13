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
const MAX_AUTH_BYTES = 4 * 1024 * 1024;
const VERSION_TIMEOUT_MS = 5_000;
const VERSION_MAX_BUFFER_BYTES = 64 * 1024;
const CODEX_HOME_POLICY = "check_for_update_on_startup = false\n";
const CREDENTIAL_POLICY_OVERRIDE_KEYS = new Set([
  "CODEX_DISABLE_UPDATE_CHECK",
  "CODEX_HOME",
  "CODEX_PATH",
  "LANG",
  "LC_ALL",
  "NO_BROWSER",
  "PATH",
  "TMPDIR",
  "credentialEnvironment",
  "environment",
  "locale",
  "policyEnvironment",
]);

export type CodexAcpArtifactKind = "wrapper" | "codex" | "node";

export type CodexAcpVersionInspection = Readonly<{
  readonly canonicalCommandPath: string;
  readonly environment: Readonly<Record<string, string>>;
}>;

export type CodexAcpTrustInspection = Readonly<{
  readonly kind: CodexAcpArtifactKind;
  readonly canonicalCommandPath: string;
  readonly metadata: Stats;
}>;

export type CodexAcpCurrentInstallOptions = Readonly<{
  /** Explicit selected wrapper entry; no repository or bundled fallback exists. */
  readonly wrapperCommandReference: string;
  /** Explicit current upstream Codex entry assigned to exact `CODEX_PATH`. */
  readonly codexCommandReference: string;
  /** Explicit Node identity that the wrapper's `/usr/bin/env node` must resolve. */
  readonly nodeCommandReference: string;
  /** Snapshotted, non-ambient PATH used both for shebang resolution and launch. */
  readonly executableSearchPath: string;
  readonly locale?: string;
  readonly inspectWrapperVersion?: (input: CodexAcpVersionInspection) => Promise<string>;
  readonly inspectCodexVersion?: (input: CodexAcpVersionInspection) => Promise<string>;
  readonly inspectNodeVersion?: (input: CodexAcpVersionInspection) => Promise<string>;
  readonly trustArtifact?: (
    input: CodexAcpTrustInspection,
  ) => boolean | Promise<boolean>;
}>;

export type CodexAcpCredentialAcquisitionOptions = Readonly<{
  /** Existing or creatable Host-private parent; it must resolve to a 0700 directory. */
  readonly runtimePrivateRoot: string;
  /** Absolute, regular, non-symlink 0600 Codex `auth.json` source. */
  readonly authSourcePath: string;
  /**
   * Optional Binding-owned CODEX_HOME. Only provider session data survives a
   * process generation; auth.json/config.toml are still generation leases and
   * are removed before credential cleanup is confirmed.
   */
  readonly persistentCodexHome?: string;
  /** Injectable exact-tree cleanup used by deterministic failure tests. */
  readonly removePrivateTree?: (privateGenerationRoot: string) => Promise<void>;
}>;

export class CodexAcpResolutionError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "CodexAcpResolutionError";
    this.code = code;
  }
}

type ResolvedExecutable = Readonly<{
  readonly selectedEntryPath: string;
  readonly canonicalCommandPath: string;
  readonly metadata: Stats;
  readonly digest: string;
}>;

/**
 * Discovers the wrapper, its exact shebang runtime, and current Codex upstream
 * on every call. Observed versions are evidence, never an admission allowlist.
 */
export function createCodexAcpCurrentInstallDescriptor(
  options: CodexAcpCurrentInstallOptions,
): AcpCurrentInstallDescriptor<ExecutionProfileDefinitionV3> {
  return createCodexAcpInstallDescriptor(options, assertCodexProfile);
}

/** Independent Meta descriptor; Task/Profile role admission remains separate. */
export function createCodexAcpMetaCurrentInstallDescriptor(
  options: CodexAcpCurrentInstallOptions,
): AcpCurrentInstallDescriptor<MetaProfileDefinitionV3> {
  return createCodexAcpInstallDescriptor(options, assertCodexMetaProfile);
}

function createCodexAcpInstallDescriptor<
  TProfile extends AcpPortableProfileDefinitionV3,
>(
  options: CodexAcpCurrentInstallOptions,
  assertProfile: (profile: AcpPortableProfileDefinitionV3) => void,
): AcpCurrentInstallDescriptor<TProfile> {
  const inspectWrapperVersion = options?.inspectWrapperVersion
    ?? ((input) => inspectInstalledVersion(input, ["--version"]));
  const inspectCodexVersion = options?.inspectCodexVersion
    ?? ((input) => inspectInstalledVersion(input, ["--version"]));
  const inspectNodeVersion = options?.inspectNodeVersion
    ?? ((input) => inspectInstalledVersion(input, ["--version"]));
  const trustArtifact = options?.trustArtifact ?? defaultArtifactTrust;

  return Object.freeze({
    descriptorId: "codex-acp-current-install-v1",
    async discoverCurrent(profile): Promise<AcpDiscoveredArtifact> {
      assertProfile(profile);
      const searchPath = normalizeSearchPath(options?.executableSearchPath);
      const locale = safeLocale(options?.locale ?? "C.UTF-8");
      const wrapperReference = commandReference(
        options?.wrapperCommandReference,
        "codex_acp_wrapper_reference_invalid",
      );
      const codexReference = commandReference(
        options?.codexCommandReference,
        "codex_acp_upstream_reference_invalid",
      );
      const nodeReference = commandReference(
        options?.nodeCommandReference,
        "codex_acp_node_reference_invalid",
      );

      const wrapper = await resolveExecutable(
        wrapperReference,
        searchPath,
        "codex_acp_wrapper_not_found",
        "codex_acp_wrapper_not_executable",
      );
      const shebang = await readNodeShebang(wrapper.canonicalCommandPath);
      const codex = await resolveExecutable(
        codexReference,
        searchPath,
        "codex_acp_upstream_not_found",
        "codex_acp_upstream_not_executable",
      );
      const explicitNode = await resolveExecutable(
        nodeReference,
        searchPath,
        "codex_acp_node_not_found",
        "codex_acp_node_not_executable",
      );
      const pathNode = await resolveExecutable(
        "node",
        searchPath,
        "codex_acp_node_not_found",
        "codex_acp_node_not_executable",
      );
      if (explicitNode.canonicalCommandPath !== pathNode.canonicalCommandPath
        || !sameArtifactSnapshot(explicitNode.metadata, pathNode.metadata)
        || explicitNode.digest !== pathNode.digest) {
        throw safeError("codex_acp_node_path_mismatch");
      }

      const environment = Object.freeze({
        PATH: searchPath.join(path.delimiter),
        CODEX_PATH: codex.canonicalCommandPath,
        CODEX_DISABLE_UPDATE_CHECK: "1",
        NO_BROWSER: "1",
        LANG: locale,
        LC_ALL: locale,
      });
      const [wrapperTrusted, codexTrusted, nodeTrusted] = await Promise.all([
        observeTrust(trustArtifact, "wrapper", wrapper),
        observeTrust(trustArtifact, "codex", codex),
        observeTrust(trustArtifact, "node", explicitNode),
      ]);
      if (!wrapperTrusted) throw safeError("codex_acp_wrapper_untrusted");
      if (!codexTrusted) throw safeError("codex_acp_upstream_untrusted");
      if (!nodeTrusted) throw safeError("codex_acp_node_untrusted");

      const [wrapperVersion, codexVersion, nodeVersion] = await Promise.all([
        observeVersion(
          inspectWrapperVersion,
          wrapper.canonicalCommandPath,
          environment,
          "codex_acp_wrapper_version_observation_failed",
        ),
        observeVersion(
          inspectCodexVersion,
          codex.canonicalCommandPath,
          environment,
          "codex_acp_upstream_version_observation_failed",
        ),
        observeVersion(
          inspectNodeVersion,
          explicitNode.canonicalCommandPath,
          environment,
          "codex_acp_node_version_observation_failed",
        ),
      ]);

      await assertDiscoverySnapshotCurrent({
        reference: wrapperReference,
        searchPath,
        expected: wrapper,
        notFoundCode: "codex_acp_wrapper_not_found",
        notExecutableCode: "codex_acp_wrapper_not_executable",
      });
      if (await readNodeShebang(wrapper.canonicalCommandPath) !== shebang) {
        throw safeError("codex_acp_wrapper_drift_during_discovery");
      }
      await assertDiscoverySnapshotCurrent({
        reference: codexReference,
        searchPath,
        expected: codex,
        notFoundCode: "codex_acp_upstream_not_found",
        notExecutableCode: "codex_acp_upstream_not_executable",
      });
      await assertDiscoverySnapshotCurrent({
        reference: nodeReference,
        searchPath,
        expected: explicitNode,
        notFoundCode: "codex_acp_node_not_found",
        notExecutableCode: "codex_acp_node_not_executable",
      });
      const currentPathNode = await resolveExecutable(
        "node",
        searchPath,
        "codex_acp_node_not_found",
        "codex_acp_node_not_executable",
      );
      if (currentPathNode.canonicalCommandPath !== explicitNode.canonicalCommandPath
        || !sameArtifactSnapshot(currentPathNode.metadata, explicitNode.metadata)
        || currentPathNode.digest !== explicitNode.digest) {
        throw safeError("codex_acp_node_drift_during_discovery");
      }

      const launchArguments = Object.freeze([] as string[]);
      const executionConfigDigest = digest({
        protocolMajor: profile.protocolMajor,
        wrapper: artifactIdentity(wrapper, wrapperVersion),
        upstream: artifactIdentity(codex, codexVersion),
        runtime: artifactIdentity(explicitNode, nodeVersion),
        shebang,
        launchArguments,
        environment,
        codexHomePolicy: Object.freeze({ checkForUpdateOnStartup: false }),
        bundledFallback: false,
      });
      return Object.freeze({
        canonicalLauncherPath: wrapper.canonicalCommandPath,
        launchArguments,
        observedArtifactVersion: wrapperVersion,
        observedUpstreamVersion: codexVersion,
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
export function beginCodexAcpCredentialAcquisition(
  options: CodexAcpCredentialAcquisitionOptions,
): AcpCredentialAcquisitionOperation {
  let cancelled = false;
  let privateGenerationRoot: string | undefined;
  let cleanupPromise: Promise<void> | undefined;
  let credential: AcpCredentialLease | undefined;
  let retainedCodexHome: string | undefined;
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
          throw safeError("codex_acp_credential_cleanup_unconfirmed");
        }
        if (retainedCodexHome) {
          const authCopy = path.join(retainedCodexHome, "auth.json");
          const policyCopy = path.join(retainedCodexHome, "config.toml");
          await Promise.all([
            rm(authCopy, { force: true }),
            rm(policyCopy, { force: true }),
          ]);
          if (await pathExists(authCopy) || await pathExists(policyCopy)) {
            throw safeError("codex_acp_credential_cleanup_unconfirmed");
          }
        }
      } catch {
        throw safeError("codex_acp_credential_cleanup_unconfirmed");
      }
    })();
    cleanupPromise.catch(() => undefined);
    return cleanupPromise;
  };

  const lease = (async (): Promise<AcpCredentialLease> => {
    let authBytes: Buffer | undefined;
    try {
      assertNoCredentialPolicyOverride(options);
      const runtimePrivateRoot = absolutePath(
        options?.runtimePrivateRoot,
        "codex_acp_runtime_private_root_invalid",
      );
      const authSourcePath = absolutePath(
        options?.authSourcePath,
        "codex_acp_auth_source_path_invalid",
      );
      await ensurePrivateParent(runtimePrivateRoot);
      authBytes = await readSecureAuthSource(authSourcePath);
      if (cancelled) throw safeError("codex_acp_credential_acquisition_cancelled");

      privateGenerationRoot = await mkdtemp(path.join(runtimePrivateRoot, "codex-acp-"));
      await chmod(privateGenerationRoot, 0o700);
      const codexHome = options.persistentCodexHome === undefined
        ? path.join(privateGenerationRoot, "codex-home")
        : absolutePath(
            options.persistentCodexHome,
            "codex_acp_persistent_home_invalid",
          );
      const temporaryDirectory = path.join(privateGenerationRoot, "tmp");
      if (options.persistentCodexHome === undefined) {
        await mkdir(codexHome, { mode: 0o700 });
      } else {
        await assertPrivateDirectory(codexHome).catch(() => {
          throw safeError("codex_acp_persistent_home_invalid");
        });
        retainedCodexHome = codexHome;
      }
      await mkdir(temporaryDirectory, { mode: 0o700 });
      await assertPrivateDirectory(privateGenerationRoot);
      await assertPrivateDirectory(codexHome);
      await assertPrivateDirectory(temporaryDirectory);
      await writePrivateFile(path.join(codexHome, "auth.json"), authBytes, "codex_acp_auth_copy_invalid");
      await writePrivateFile(
        path.join(codexHome, "config.toml"),
        Buffer.from(CODEX_HOME_POLICY, "utf8"),
        "codex_acp_policy_copy_invalid",
      );
      if (cancelled) {
        await cleanup();
        throw safeError("codex_acp_credential_acquisition_cancelled");
      }

      credential = Object.freeze({
        environment: Object.freeze({
          CODEX_HOME: codexHome,
          TMPDIR: temporaryDirectory,
        }),
        revoke: cleanup,
      });
      return credential;
    } catch (error) {
      if (privateGenerationRoot) {
        try {
          await cleanup();
        } catch {
          throw safeError("codex_acp_credential_cleanup_unconfirmed");
        }
      }
      if (error instanceof CodexAcpResolutionError) throw error;
      throw safeError("codex_acp_credential_acquisition_failed");
    } finally {
      authBytes?.fill(0);
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
          throw safeError("codex_acp_credential_cleanup_unconfirmed");
        }
        return Object.freeze({ credentialCleanupConfirmed: true });
      })();
      cancellationPromise.catch(() => undefined);
      return cancellationPromise;
    },
  });
}

function assertCodexProfile(
  profile: AcpPortableProfileDefinitionV3,
): asserts profile is ExecutionProfileDefinitionV3 {
  if (!profile
    || !("executionProfileId" in profile)
    || profile.providerFamily !== "codex"
    || profile.acpAgentKind !== "codex_acp"
    || profile.protocolMajor !== 1) {
    throw safeError("codex_acp_profile_mismatch");
  }
}

function assertCodexMetaProfile(
  profile: AcpPortableProfileDefinitionV3,
): asserts profile is MetaProfileDefinitionV3 {
  if (!profile
    || !("metaProfileId" in profile)
    || profile.role !== "meta"
    || profile.providerFamily !== "codex"
    || profile.acpAgentKind !== "codex_acp"
    || profile.protocolMajor !== 1) {
    throw safeError("codex_acp_meta_profile_mismatch");
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
    throw safeError("codex_acp_search_path_invalid");
  }
  const entries = value.split(path.delimiter);
  if (entries.length === 0 || entries.some((entry) => !entry || !path.isAbsolute(entry))) {
    throw safeError("codex_acp_search_path_invalid");
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
      throw safeError("codex_acp_wrapper_shebang_unsupported");
    }
    return firstLine;
  } finally {
    await handle.close();
  }
}

async function observeVersion(
  inspect: (input: CodexAcpVersionInspection) => Promise<string>,
  canonicalCommandPath: string,
  environment: Readonly<Record<string, string>>,
  code: string,
): Promise<string> {
  try {
    return normalizeVersion(await inspect(Object.freeze({ canonicalCommandPath, environment })), code);
  } catch (error) {
    if (error instanceof CodexAcpResolutionError) throw error;
    throw safeError(code);
  }
}

async function inspectInstalledVersion(
  input: CodexAcpVersionInspection,
  arguments_: readonly string[],
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
  const token = output.trim().split(/\s+/u).at(-1);
  if (!token) throw safeError("codex_acp_version_output_invalid");
  return token;
}

function normalizeVersion(value: unknown, code: string): string {
  if (typeof value !== "string" || !SAFE_VERSION.test(value)) throw safeError(code);
  return value;
}

async function observeTrust(
  trust: (input: CodexAcpTrustInspection) => boolean | Promise<boolean>,
  kind: CodexAcpArtifactKind,
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

function defaultArtifactTrust(input: CodexAcpTrustInspection): boolean {
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
    throw safeError("codex_acp_locale_invalid");
  }
  return value;
}

function assertNoCredentialPolicyOverride(value: unknown): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw safeError("codex_acp_credential_acquisition_invalid");
  }
  for (const key of Object.keys(value)) {
    if (CREDENTIAL_POLICY_OVERRIDE_KEYS.has(key)) {
      throw safeError("codex_acp_credential_policy_override");
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
    throw safeError("codex_acp_runtime_private_root_invalid");
  }
  await assertPrivateDirectory(runtimePrivateRoot, "codex_acp_runtime_private_root_invalid");
}

async function assertPrivateDirectory(
  directory: string,
  code = "codex_acp_private_directory_invalid",
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

async function readSecureAuthSource(authSourcePath: string): Promise<Buffer> {
  let selected: Stats;
  try {
    selected = await lstat(authSourcePath);
  } catch {
    throw safeError("codex_acp_auth_source_not_found");
  }
  if (selected.isSymbolicLink()) throw safeError("codex_acp_auth_source_symlink_forbidden");
  if (!selected.isFile()) throw safeError("codex_acp_auth_source_not_regular");
  if ((selected.mode & 0o777) !== 0o600) {
    throw safeError("codex_acp_auth_source_permissions_invalid");
  }
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  let handle;
  try {
    handle = await open(authSourcePath, constants.O_RDONLY | noFollow);
  } catch {
    throw safeError("codex_acp_auth_source_open_failed");
  }
  try {
    const before = await handle.stat();
    if (!before.isFile()
      || (before.mode & 0o777) !== 0o600
      || before.dev !== selected.dev
      || before.ino !== selected.ino
      || before.size <= 0
      || before.size > MAX_AUTH_BYTES) {
      throw safeError("codex_acp_auth_source_invalid");
    }
    const contents = await handle.readFile();
    const after = await handle.stat();
    if (!sameArtifactSnapshot(before, after) || contents.byteLength !== before.size) {
      contents.fill(0);
      throw safeError("codex_acp_auth_source_drift");
    }
    return contents;
  } finally {
    await handle.close();
  }
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

function safeError(code: string): CodexAcpResolutionError {
  return new CodexAcpResolutionError(code);
}

import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import type { HostPrivateBindingIdentityVault } from "@agent-workspace/provider-acp/host-private";
import {
  assertAcpHostEpochLeaseActive,
  type AcpHostEpochLease,
} from "./acp-host-epoch-lease.js";

const MAP_SCHEMA_VERSION = 1 as const;
const MAP_DIRECTORY_NAME = "acp-private";
const MAP_FILE_NAME = "binding-map.v1.json";
const MAP_LOCK_NAME = "binding-map.v1.lock";
const MAX_MAP_BYTES = 1024 * 1024;
const MAX_MAP_ENTRIES = 4096;
const SHA256 = /^sha256:[a-f0-9]{64}$/u;
const SAFE_OPAQUE = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,511}$/u;
const RAW_ID_CONTROL = /[\u0000-\u001f\u007f]/u;

type PersistedBindingEntry = {
  readonly bindingHandle: string;
  readonly profileRevisionId: string;
  readonly profileResolutionFingerprint: string;
  readonly rawSessionId: string;
  activeGenerationId: string | null;
  activeHostEpoch: string | null;
};

type PersistedBindingMap = {
  readonly schemaVersion: 1;
  revision: number;
  entries: PersistedBindingEntry[];
};

export class AcpPrivateBindingMapError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "AcpPrivateBindingMapError";
    this.code = code;
  }
}

export type AcpPrivateBindingMap = HostPrivateBindingIdentityVault & Readonly<{
  observeBindingPresence(bindingHandle: string): AcpPrivateBindingPresence;
  observeBindingDisposition(bindingHandle: string): AcpPrivateBindingDisposition;
  toJSON(): Readonly<{ readonly kind: "host_private_acp_binding_map" }>;
}>;

export type AcpPrivateBindingPresence = "absent" | "present";
export type AcpPrivateBindingDisposition = "create" | "load" | "resume";
export type AcpPrivateBindingProviderFamily = "opencode" | "codex" | "claude-code";

export type AcpPrivateBindingPresenceScope = Readonly<{
  readonly bindingHandle: string;
  readonly profileRevisionId: string;
  readonly profileResolutionFingerprint: string;
  readonly providerFamily: AcpPrivateBindingProviderFamily;
}>;

export type AcpPrivateBindingPresenceAuthority = Readonly<{
  toJSON(): Readonly<{
    readonly kind: "host_private_acp_binding_presence_authority";
  }>;
}>;

type AcpPrivateBindingVaultResolverFunction = (
  scope: Readonly<{
    profileRevisionId: string;
    profileResolutionFingerprint: string;
  }>,
) => HostPrivateBindingIdentityVault;

export type AcpPrivateBindingVaultResolver = AcpPrivateBindingVaultResolverFunction & Readonly<{
  observeBindingPresence(
    scope: AcpPrivateBindingPresenceScope,
  ): AcpPrivateBindingPresenceAuthority;
}>;

type PresenceAuthorityState = AcpPrivateBindingPresenceScope & Readonly<{
  readonly resolver: AcpPrivateBindingVaultResolver;
  readonly presence: AcpPrivateBindingPresence;
  readonly disposition: AcpPrivateBindingDisposition;
}>;

const presenceAuthorityStates = new WeakMap<object, PresenceAuthorityState>();

/** Creates profile/resolution-scoped capabilities over one namespace-private durable map. */
export function createAcpPrivateBindingVaultResolver(options: Readonly<{
  readonly runtimeDataDirectory: string;
  readonly authorityNamespace: "task" | "meta";
  readonly hostEpochLease: AcpHostEpochLease;
}>): AcpPrivateBindingVaultResolver {
  const cache = new Map<string, AcpPrivateBindingMap>();
  const resolveVault: AcpPrivateBindingVaultResolverFunction = (scope) => {
    const profileRevisionId = requireOpaque(
      scope?.profileRevisionId,
      "acp_private_binding_profile_revision_invalid",
    );
    const profileResolutionFingerprint = requireResolutionFingerprint(
      scope?.profileResolutionFingerprint,
    );
    const key = `${profileRevisionId}\0${profileResolutionFingerprint}`;
    let vault = cache.get(key);
    if (!vault) {
      vault = createAcpPrivateBindingMap({
        runtimeDataDirectory: options.runtimeDataDirectory,
        authorityNamespace: options.authorityNamespace,
        hostEpochLease: options.hostEpochLease,
        profileRevisionId,
        profileResolutionFingerprint,
      });
      cache.set(key, vault);
    }
    return vault;
  };
  const resolver = Object.assign(resolveVault, {
    observeBindingPresence(scope: AcpPrivateBindingPresenceScope) {
      const normalized = normalizePresenceScope(scope);
      const vault = resolveVault({
        profileRevisionId: normalized.profileRevisionId,
        profileResolutionFingerprint: normalized.profileResolutionFingerprint,
      }) as AcpPrivateBindingMap;
      const disposition = vault.observeBindingDisposition(normalized.bindingHandle);
      const presence = disposition === "create" ? "absent" : "present";
      const authority: AcpPrivateBindingPresenceAuthority = Object.freeze({
        toJSON: () => Object.freeze({
          kind: "host_private_acp_binding_presence_authority" as const,
        }),
      });
      presenceAuthorityStates.set(authority, Object.freeze({
        ...normalized,
        resolver: resolver as AcpPrivateBindingVaultResolver,
        presence,
        disposition,
      }));
      return authority;
    },
  }) as AcpPrivateBindingVaultResolver;
  return Object.freeze(resolver);
}

/**
 * Consumes only the opaque absent/present fact. The resolution fingerprint
 * remains inside the WeakMap brand and is checked separately at process-open.
 */
export function claimAcpPrivateBindingPresenceAuthority(options: Readonly<{
  readonly authority: AcpPrivateBindingPresenceAuthority;
  readonly resolver: AcpPrivateBindingVaultResolver;
  readonly bindingHandle: string;
  readonly profileRevisionId: string;
  readonly providerFamily: AcpPrivateBindingProviderFamily;
}>): AcpPrivateBindingPresence {
  const state = presenceAuthorityState(options?.authority);
  const bindingHandle = requireOpaque(
    options?.bindingHandle,
    "acp_private_binding_handle_invalid",
  );
  const profileRevisionId = requireOpaque(
    options?.profileRevisionId,
    "acp_private_binding_profile_revision_invalid",
  );
  const providerFamily = requireProviderFamily(options?.providerFamily);
  if (state.resolver !== options?.resolver
    || state.bindingHandle !== bindingHandle
    || state.profileRevisionId !== profileRevisionId
    || state.providerFamily !== providerFamily) {
    fail("acp_private_binding_presence_authority_scope_mismatch");
  }
  return state.presence;
}

/** Exact current-resolution fence used before an ACP process may spawn. */
export function assertAcpPrivateBindingPresenceAuthorityScope(
  options: Readonly<{
    readonly authority: AcpPrivateBindingPresenceAuthority;
    readonly resolver: AcpPrivateBindingVaultResolver;
    readonly bindingHandle: string;
    readonly profileRevisionId: string;
    readonly profileResolutionFingerprint: string;
    readonly providerFamily: AcpPrivateBindingProviderFamily;
  }>,
): void {
  const state = presenceAuthorityState(options?.authority);
  const normalized = normalizePresenceScope({
    bindingHandle: options?.bindingHandle,
    profileRevisionId: options?.profileRevisionId,
    profileResolutionFingerprint: options?.profileResolutionFingerprint,
    providerFamily: options?.providerFamily,
  });
  if (state.resolver !== options?.resolver
    || state.bindingHandle !== normalized.bindingHandle
    || state.profileRevisionId !== normalized.profileRevisionId
    || state.profileResolutionFingerprint !== normalized.profileResolutionFingerprint
    || state.providerFamily !== normalized.providerFamily) {
    fail("acp_private_binding_presence_authority_scope_mismatch");
  }
}

/**
 * Exact Host-private create/load/resume decision. Callers must supply the
 * fingerprint obtained from the concrete factory's current resolution, never
 * from portable configuration.
 */
export function claimAcpPrivateBindingDispositionAuthority(
  options: Readonly<{
    readonly authority: AcpPrivateBindingPresenceAuthority;
    readonly resolver: AcpPrivateBindingVaultResolver;
    readonly bindingHandle: string;
    readonly profileRevisionId: string;
    readonly profileResolutionFingerprint: string;
    readonly providerFamily: AcpPrivateBindingProviderFamily;
  }>,
): AcpPrivateBindingDisposition {
  assertAcpPrivateBindingPresenceAuthorityScope(options);
  return presenceAuthorityState(options.authority).disposition;
}

/**
 * Host-only durable recovery seam. The raw session id is written only to the
 * mode-0600 Runtime data map and never appears in this object's projection.
 *
 * Every operation takes a same-directory exclusive writer lock and reloads the
 * current bytes before mutation. A stale lock may be reclaimed only by a new
 * Host lease carrying the supervisor's exact confirmed-dead epoch authority.
 */
export function createAcpPrivateBindingMap(options: Readonly<{
  readonly runtimeDataDirectory: string;
  readonly authorityNamespace: "task" | "meta";
  readonly profileRevisionId: string;
  readonly profileResolutionFingerprint: string;
  readonly hostEpochLease: AcpHostEpochLease;
}>): AcpPrivateBindingMap {
  const runtimeDataDirectory = requireAbsoluteDirectory(options?.runtimeDataDirectory);
  const authorityNamespace = requireNamespace(options?.authorityNamespace);
  const hostEpochLease = requireHostEpochLease(options?.hostEpochLease, runtimeDataDirectory);
  const profileRevisionId = requireOpaque(
    options?.profileRevisionId,
    "acp_private_binding_profile_revision_invalid",
  );
  const profileResolutionFingerprint = requireResolutionFingerprint(
    options?.profileResolutionFingerprint,
  );
  const directory = ensurePrivateDirectory(runtimeDataDirectory, authorityNamespace);
  const file = path.join(directory, MAP_FILE_NAME);
  const lock = path.join(directory, MAP_LOCK_NAME);

  const withDocument = <T>(operation: (document: PersistedBindingMap) => T): T => {
    assertAcpHostEpochLeaseActive(hostEpochLease, runtimeDataDirectory);
    return withWriterLock(lock, directory, hostEpochLease, () => operation(readDocument(file)));
  };
  const mutate = <T>(operation: (document: PersistedBindingMap) => T): T =>
    withDocument((document) => {
      const result = operation(document);
      document.revision += 1;
      persistDocument(directory, file, document);
      return result;
    });
  const assertOwnedEntry = (
    document: PersistedBindingMap,
    bindingHandle: string,
  ): PersistedBindingEntry => {
    const entry = document.entries.find((candidate) => candidate.bindingHandle === bindingHandle);
    if (!entry) fail("acp_private_binding_not_found");
    if (
      entry.profileRevisionId !== profileRevisionId
      || entry.profileResolutionFingerprint !== profileResolutionFingerprint
    ) {
      fail("acp_private_binding_profile_mismatch");
    }
    return entry;
  };

  // Validate any existing bytes and mode before returning a usable capability.
  withDocument(() => undefined);

  return Object.freeze({
    observeBindingPresence(bindingHandle: string) {
      return this.observeBindingDisposition(bindingHandle) === "create"
        ? "absent" as const
        : "present" as const;
    },

    observeBindingDisposition(bindingHandle: string) {
      const checkedBindingHandle = requireOpaque(
        bindingHandle,
        "acp_private_binding_handle_invalid",
      );
      assertAcpHostEpochLeaseActive(hostEpochLease, runtimeDataDirectory);
      const document = readDocument(file);
      const entry = document.entries.find(
        (candidate) => candidate.bindingHandle === checkedBindingHandle,
      );
      if (!entry) return "create" as const;
      if (entry.profileRevisionId !== profileRevisionId
        || entry.profileResolutionFingerprint !== profileResolutionFingerprint) {
        fail("acp_private_binding_profile_mismatch");
      }
      if (entry.activeGenerationId === null) return "load" as const;
      if (entry.activeHostEpoch === hostEpochLease.hostEpoch
        || (entry.activeHostEpoch
          && hostEpochLease.canReclaimHostEpoch(entry.activeHostEpoch))) {
        return "resume" as const;
      }
      fail("acp_private_binding_generation_conflict");
    },

    bindNew(input: Readonly<{
      readonly bindingHandle: string;
      readonly generationId: string;
      readonly rawSessionId: string;
    }>) {
      const bindingHandle = requireOpaque(
        input?.bindingHandle,
        "acp_private_binding_handle_invalid",
      );
      const generationId = requireOpaque(
        input?.generationId,
        "acp_private_binding_generation_invalid",
      );
      const rawSessionId = requireRawSessionId(
        input?.rawSessionId,
      );
      if (bindingHandle === rawSessionId) fail("acp_private_raw_session_invalid");
      mutate((document) => {
        if (document.entries.some((entry) => entry.bindingHandle === bindingHandle)) {
          fail("acp_private_binding_already_exists");
        }
        if (document.entries.some((entry) => entry.rawSessionId === rawSessionId)) {
          fail("acp_private_raw_session_duplicate");
        }
        if (document.entries.length >= MAX_MAP_ENTRIES) fail("acp_private_binding_map_limit");
        document.entries.push({
          bindingHandle,
          profileRevisionId,
          profileResolutionFingerprint,
          rawSessionId,
          activeGenerationId: generationId,
          activeHostEpoch: hostEpochLease.hostEpoch,
        });
      });
    },

    checkout(input: Readonly<{
      readonly bindingHandle: string;
      readonly generationId: string;
    }>) {
      const bindingHandle = requireOpaque(
        input?.bindingHandle,
        "acp_private_binding_handle_invalid",
      );
      const generationId = requireOpaque(
        input?.generationId,
        "acp_private_binding_generation_invalid",
      );
      return mutate((document) => {
        const entry = assertOwnedEntry(document, bindingHandle);
        if (entry.activeGenerationId && (
          entry.activeGenerationId !== generationId
          || entry.activeHostEpoch !== hostEpochLease.hostEpoch
        )) {
          if (!entry.activeHostEpoch || !hostEpochLease.canReclaimHostEpoch(entry.activeHostEpoch)) {
            fail("acp_private_binding_generation_conflict");
          }
        }
        entry.activeGenerationId = generationId;
        entry.activeHostEpoch = hostEpochLease.hostEpoch;
        return entry.rawSessionId;
      });
    },

    detachGeneration(generationId: string) {
      const checkedGenerationId = requireOpaque(
        generationId,
        "acp_private_binding_generation_invalid",
      );
      mutate((document) => {
        for (const entry of document.entries) {
          if (
            entry.profileRevisionId === profileRevisionId
            && entry.profileResolutionFingerprint === profileResolutionFingerprint
            && entry.activeHostEpoch === hostEpochLease.hostEpoch
            && entry.activeGenerationId === checkedGenerationId
          ) {
            entry.activeGenerationId = null;
            entry.activeHostEpoch = null;
          }
        }
      });
    },

    detachBinding(input: Readonly<{
      readonly bindingHandle: string;
      readonly generationId: string;
    }>) {
      const bindingHandle = requireOpaque(
        input?.bindingHandle,
        "acp_private_binding_handle_invalid",
      );
      const generationId = requireOpaque(
        input?.generationId,
        "acp_private_binding_generation_invalid",
      );
      mutate((document) => {
        const entry = assertOwnedEntry(document, bindingHandle);
        if (entry.activeGenerationId !== generationId
          || entry.activeHostEpoch !== hostEpochLease.hostEpoch) {
          fail("acp_private_binding_generation_conflict");
        }
        entry.activeGenerationId = null;
        entry.activeHostEpoch = null;
      });
    },

    delete(input: Readonly<{
      readonly bindingHandle: string;
      readonly generationId: string;
    }>) {
      const bindingHandle = requireOpaque(
        input?.bindingHandle,
        "acp_private_binding_handle_invalid",
      );
      const generationId = requireOpaque(
        input?.generationId,
        "acp_private_binding_generation_invalid",
      );
      mutate((document) => {
        const entry = assertOwnedEntry(document, bindingHandle);
        if (entry.activeGenerationId !== generationId
          || entry.activeHostEpoch !== hostEpochLease.hostEpoch) {
          fail("acp_private_binding_generation_conflict");
        }
        document.entries = document.entries.filter(
          (candidate) => candidate.bindingHandle !== bindingHandle,
        );
      });
    },

    toJSON() {
      return Object.freeze({ kind: "host_private_acp_binding_map" as const });
    },
  });
}

function normalizePresenceScope(value: unknown): AcpPrivateBindingPresenceScope {
  if (!isRecord(value) || !hasExactKeys(value, [
    "bindingHandle",
    "profileResolutionFingerprint",
    "profileRevisionId",
    "providerFamily",
  ])) {
    fail("acp_private_binding_presence_scope_invalid");
  }
  return Object.freeze({
    bindingHandle: requireOpaque(
      value.bindingHandle,
      "acp_private_binding_handle_invalid",
    ),
    profileRevisionId: requireOpaque(
      value.profileRevisionId,
      "acp_private_binding_profile_revision_invalid",
    ),
    profileResolutionFingerprint: requireResolutionFingerprint(
      value.profileResolutionFingerprint,
    ),
    providerFamily: requireProviderFamily(value.providerFamily),
  });
}

function requireProviderFamily(value: unknown): AcpPrivateBindingProviderFamily {
  if (value !== "opencode" && value !== "codex" && value !== "claude-code") {
    fail("acp_private_binding_provider_family_invalid");
  }
  return value;
}

function presenceAuthorityState(value: unknown): PresenceAuthorityState {
  if (!value || typeof value !== "object") {
    fail("acp_private_binding_presence_authority_invalid");
  }
  const state = presenceAuthorityStates.get(value as object);
  if (!state) fail("acp_private_binding_presence_authority_invalid");
  return state;
}

function requireAbsoluteDirectory(value: unknown): string {
  if (typeof value !== "string" || !path.isAbsolute(value) || value.includes("\0")) {
    fail("acp_private_binding_runtime_directory_invalid");
  }
  let stat;
  try {
    stat = lstatSync(value);
  } catch {
    fail("acp_private_binding_runtime_directory_invalid");
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    fail("acp_private_binding_runtime_directory_invalid");
  }
  return realpathSync(value);
}

function ensurePrivateDirectory(
  runtimeDataDirectory: string,
  authorityNamespace: "task" | "meta",
): string {
  const parent = ensureExactPrivateDirectory(runtimeDataDirectory, MAP_DIRECTORY_NAME);
  return ensureExactPrivateDirectory(parent, authorityNamespace);
}

function ensureExactPrivateDirectory(parent: string, name: string): string {
  const directory = path.join(parent, name);
  let created = false;
  try {
    mkdirSync(directory, { mode: 0o700 });
    created = true;
  } catch (error) {
    if (!isNodeError(error, "EEXIST")) fail("acp_private_binding_map_unsafe");
  }
  let stat;
  try {
    stat = lstatSync(directory);
  } catch {
    fail("acp_private_binding_map_unsafe");
  }
  if (
    !stat.isDirectory()
    || stat.isSymbolicLink()
    || (stat.mode & 0o777) !== 0o700
  ) {
    fail("acp_private_binding_map_unsafe");
  }
  if (created) syncDirectory(parent);
  return directory;
}

function withWriterLock<T>(
  lock: string,
  directory: string,
  hostEpochLease: AcpHostEpochLease,
  operation: () => T,
): T {
  let retriedAfterRecovery = false;
  for (;;) {
    try {
      return withAcquiredWriterLock(lock, directory, hostEpochLease, operation);
    } catch (error) {
      if (retriedAfterRecovery
        || !(error instanceof AcpPrivateBindingMapError)
        || error.code !== "acp_private_binding_map_locked") throw error;
      reclaimStaleWriterLock(lock, directory, hostEpochLease);
      retriedAfterRecovery = true;
    }
  }
}

function withAcquiredWriterLock<T>(
  lock: string,
  directory: string,
  hostEpochLease: AcpHostEpochLease,
  operation: () => T,
): T {
  let descriptor: number | undefined;
  let openedIdentity: Readonly<{ dev: bigint | number; ino: bigint | number }> | undefined;
  try {
    descriptor = openSync(
      lock,
      fsConstants.O_CREAT
        | fsConstants.O_EXCL
        | fsConstants.O_WRONLY
        | noFollowFlag(),
      0o600,
    );
    fchmodSync(descriptor, 0o600);
    const opened = fstatSync(descriptor);
    openedIdentity = { dev: opened.dev, ino: opened.ino };
    if (!opened.isFile() || (opened.mode & 0o777) !== 0o600) {
      fail("acp_private_binding_map_unsafe");
    }
    writeFileSync(descriptor, `${JSON.stringify({ schemaVersion: 1, hostEpoch: hostEpochLease.hostEpoch })}\n`, "utf8");
    fsyncSync(descriptor);
    syncDirectory(directory);
  } catch (error) {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch { /* exact lock cleanup continues */ }
      if (openedIdentity) tryUnlinkExact(lock, openedIdentity.dev, openedIdentity.ino);
    }
    if (isNodeError(error, "EEXIST")) fail("acp_private_binding_map_locked");
    fail("acp_private_binding_map_unsafe");
  }

  let primaryError: unknown;
  let result: T | undefined;
  try {
    result = operation();
  } catch (error) {
    primaryError = error;
  }
  try {
    closeSync(descriptor);
    unlinkExact(lock, openedIdentity!.dev, openedIdentity!.ino, "acp_private_binding_map_lock_cleanup_unconfirmed");
    syncDirectory(directory);
  } catch {
    fail("acp_private_binding_map_lock_cleanup_unconfirmed");
  }
  if (primaryError) throw primaryError;
  return result as T;
}

function unlinkExact(
  file: string,
  dev: bigint | number,
  ino: bigint | number,
  code: string,
): void {
  const current = safeLstat(file, code);
  if (!current.isFile() || current.isSymbolicLink() || current.dev !== dev || current.ino !== ino) {
    fail(code);
  }
  try { unlinkSync(file); } catch { fail(code); }
}

function tryUnlinkExact(file: string, dev: bigint | number, ino: bigint | number): void {
  try {
    const current = lstatSync(file);
    if (!current.isSymbolicLink() && current.dev === dev && current.ino === ino) unlinkSync(file);
  } catch { /* missing or replaced path remains a safe failure */ }
}

function reclaimStaleWriterLock(
  lock: string,
  directory: string,
  hostEpochLease: AcpHostEpochLease,
): void {
  const before = safeLstat(lock, "acp_private_binding_map_locked");
  if (!before.isFile() || before.isSymbolicLink() || (before.mode & 0o777) !== 0o600) {
    fail("acp_private_binding_map_unsafe");
  }
  let descriptor: number | undefined;
  try {
    descriptor = openSync(lock, fsConstants.O_RDONLY | noFollowFlag());
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
      fail("acp_private_binding_map_unsafe");
    }
    const parsed = JSON.parse(readFileSync(descriptor, "utf8")) as unknown;
    if (!isRecord(parsed)
      || !hasExactKeys(parsed, ["hostEpoch", "schemaVersion"])
      || parsed.schemaVersion !== 1
      || typeof parsed.hostEpoch !== "string"
      || !hostEpochLease.canReclaimHostEpoch(parsed.hostEpoch)) {
      fail("acp_private_binding_map_locked");
    }
  } catch (error) {
    if (error instanceof AcpPrivateBindingMapError) throw error;
    fail("acp_private_binding_map_locked");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  const current = safeLstat(lock, "acp_private_binding_map_locked");
  if (current.dev !== before.dev || current.ino !== before.ino) fail("acp_private_binding_map_locked");
  try { unlinkSync(lock); } catch { fail("acp_private_binding_map_locked"); }
  syncDirectory(directory);
}

function readDocument(file: string): PersistedBindingMap {
  let lstat;
  try {
    lstat = lstatSync(file);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return { schemaVersion: MAP_SCHEMA_VERSION, revision: 0, entries: [] };
    }
    fail("acp_private_binding_map_unsafe");
  }
  if (
    !lstat.isFile()
    || lstat.isSymbolicLink()
    || (lstat.mode & 0o777) !== 0o600
    || lstat.size < 1
    || lstat.size > MAX_MAP_BYTES
  ) {
    fail("acp_private_binding_map_unsafe");
  }

  let descriptor: number | undefined;
  try {
    descriptor = openSync(file, fsConstants.O_RDONLY | noFollowFlag());
    const opened = fstatSync(descriptor);
    if (
      !opened.isFile()
      || (opened.mode & 0o777) !== 0o600
      || opened.dev !== lstat.dev
      || opened.ino !== lstat.ino
      || opened.size !== lstat.size
    ) {
      fail("acp_private_binding_map_unsafe");
    }
    return parseDocument(readFileSync(descriptor, "utf8"));
  } catch (error) {
    if (error instanceof AcpPrivateBindingMapError) throw error;
    fail("acp_private_binding_map_corrupt");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  return fail("acp_private_binding_map_corrupt");
}

function parseDocument(bytes: string): PersistedBindingMap {
  let value: unknown;
  try {
    value = JSON.parse(bytes);
  } catch {
    fail("acp_private_binding_map_corrupt");
  }
  if (!isRecord(value) || !hasExactKeys(value, ["entries", "revision", "schemaVersion"])) {
    fail("acp_private_binding_map_corrupt");
  }
  if (
    value.schemaVersion !== MAP_SCHEMA_VERSION
    || !Number.isSafeInteger(value.revision)
    || (value.revision as number) < 0
    || !Array.isArray(value.entries)
    || value.entries.length > MAX_MAP_ENTRIES
  ) {
    fail("acp_private_binding_map_corrupt");
  }

  const bindings = new Set<string>();
  const rawSessions = new Set<string>();
  const entries = value.entries.map((candidate): PersistedBindingEntry => {
    if (!isRecord(candidate) || !hasExactKeys(candidate, [
      "activeGenerationId",
      "activeHostEpoch",
      "bindingHandle",
      "profileResolutionFingerprint",
      "profileRevisionId",
      "rawSessionId",
    ])) {
      fail("acp_private_binding_map_corrupt");
    }
    const bindingHandle = parseOpaque(candidate.bindingHandle);
    const profileRevisionId = parseOpaque(candidate.profileRevisionId);
    const profileResolutionFingerprint = typeof candidate.profileResolutionFingerprint === "string"
      && SHA256.test(candidate.profileResolutionFingerprint)
      ? candidate.profileResolutionFingerprint
      : undefined;
    const rawSessionId = parseRawSessionId(candidate.rawSessionId);
    const activeGenerationId = candidate.activeGenerationId === null
      ? null
      : parseOpaque(candidate.activeGenerationId);
    const activeHostEpoch = candidate.activeHostEpoch === null
      ? null
      : parseHostEpoch(candidate.activeHostEpoch);
    if (
      !bindingHandle
      || !profileRevisionId
      || !profileResolutionFingerprint
      || !rawSessionId
      || (candidate.activeGenerationId !== null && !activeGenerationId)
      || (candidate.activeHostEpoch !== null && !activeHostEpoch)
      || ((activeGenerationId === null) !== (activeHostEpoch === null))
      || bindingHandle === rawSessionId
      || bindings.has(bindingHandle)
      || rawSessions.has(rawSessionId)
    ) {
      fail("acp_private_binding_map_corrupt");
    }
    bindings.add(bindingHandle);
    rawSessions.add(rawSessionId);
    return {
      bindingHandle,
      profileRevisionId,
      profileResolutionFingerprint,
      rawSessionId,
      activeGenerationId: activeGenerationId ?? null,
      activeHostEpoch: activeHostEpoch ?? null,
    };
  });

  return {
    schemaVersion: MAP_SCHEMA_VERSION,
    revision: value.revision as number,
    entries,
  };
}

function persistDocument(
  directory: string,
  file: string,
  document: PersistedBindingMap,
): void {
  if (document.entries.length === 0) {
    try {
      unlinkSync(file);
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) fail("acp_private_binding_map_write_failed");
    }
    syncDirectory(directory);
    return;
  }

  const bytes = `${JSON.stringify(document)}\n`;
  if (Buffer.byteLength(bytes, "utf8") > MAX_MAP_BYTES) {
    fail("acp_private_binding_map_limit");
  }
  const temporary = path.join(directory, `.binding-map.${randomUUID()}.tmp`);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      temporary,
      fsConstants.O_CREAT
        | fsConstants.O_EXCL
        | fsConstants.O_WRONLY
        | noFollowFlag(),
      0o600,
    );
    fchmodSync(descriptor, 0o600);
    writeFileSync(descriptor, bytes, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, file);
    const installed = lstatSync(file);
    if (
      !installed.isFile()
      || installed.isSymbolicLink()
      || (installed.mode & 0o777) !== 0o600
    ) {
      fail("acp_private_binding_map_write_failed");
    }
    syncDirectory(directory);
  } catch (error) {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch { /* cleanup best effort before safe failure */ }
    }
    try { unlinkSync(temporary); } catch { /* exact temp may already be renamed */ }
    if (error instanceof AcpPrivateBindingMapError) throw error;
    fail("acp_private_binding_map_write_failed");
  }
}

function syncDirectory(directory: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(directory, fsConstants.O_RDONLY | noFollowFlag());
    fsyncSync(descriptor);
  } catch {
    fail("acp_private_binding_map_write_failed");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function requireResolutionFingerprint(value: unknown): string {
  if (typeof value !== "string" || !SHA256.test(value)) {
    fail("acp_private_binding_resolution_invalid");
  }
  return value;
}

function requireNamespace(value: unknown): "task" | "meta" {
  if (value !== "task" && value !== "meta") fail("acp_private_binding_namespace_invalid");
  return value;
}

function requireHostEpochLease(
  value: unknown,
  runtimeDataDirectory: string,
): AcpHostEpochLease {
  try {
    assertAcpHostEpochLeaseActive(value, runtimeDataDirectory);
  } catch {
    fail("acp_private_binding_host_lease_invalid");
  }
  return value;
}

function requireOpaque(value: unknown, code: string): string {
  const parsed = parseOpaque(value);
  if (!parsed) fail(code);
  return parsed;
}

function requireRawSessionId(value: unknown): string {
  const parsed = parseRawSessionId(value);
  if (!parsed) fail("acp_private_raw_session_invalid");
  return parsed;
}

function parseOpaque(value: unknown): string | undefined {
  return typeof value === "string" && SAFE_OPAQUE.test(value) ? value : undefined;
}

function parseRawSessionId(value: unknown): string | undefined {
  return typeof value === "string"
    && value.length >= 1
    && value.length <= 4096
    && value.trim() === value
    && !RAW_ID_CONTROL.test(value)
    ? value
    : undefined;
}

function parseHostEpoch(value: unknown): string | undefined {
  return typeof value === "string" && /^host_epoch_[A-Za-z0-9_-]{8,256}$/u.test(value)
    ? value
    : undefined;
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function noFollowFlag(): number {
  if (typeof fsConstants.O_NOFOLLOW !== "number") fail("acp_private_binding_no_follow_unavailable");
  return fsConstants.O_NOFOLLOW;
}

function safeLstat(file: string, code: string) {
  try { return lstatSync(file); } catch { return fail(code); }
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function fail(code: string): never {
  throw new AcpPrivateBindingMapError(code);
}

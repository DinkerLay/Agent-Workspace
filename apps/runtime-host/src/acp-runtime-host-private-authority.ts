import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import path from "node:path";
import {
  validateAcpV3BindingRetirementIntentRecord,
  type AcpV3BindingRetirementIntentRecord,
} from "@agent-workspace/runtime-contracts";
import type { AcpHostEpochSupervisorEnvironment } from "./acp-host-epoch-lease.js";
import {
  acquireAcpHostEpochLeaseFromSupervisorEnvironment,
  assertAcpHostEpochLeaseActive,
  type AcpHostEpochLease,
} from "./acp-host-epoch-lease.js";
import {
  createAcpPrivateBindingVaultResolver,
  type AcpPrivateBindingVaultResolver,
} from "./acp-private-binding-map.js";

export type AcpRuntimeHostPrivateRecoveryObservation =
  | Readonly<{ state: "fresh" }>
  | Readonly<{ state: "reclaimed"; receiptDigest: string }>;

export class AcpRuntimeHostPrivateAuthorityError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "AcpRuntimeHostPrivateAuthorityError";
    this.code = code;
  }
}

export type AcpTaskPrivateRootAuthority = Readonly<{
  toJSON(): Readonly<{ readonly kind: "acp_task_private_root_authority" }>;
}>;

export type AcpMetaPrivateRootAuthority = Readonly<{
  toJSON(): Readonly<{ readonly kind: "acp_meta_private_root_authority" }>;
}>;

type TaskPrivateRootAuthorityState = Readonly<{
  readonly canonicalRuntimeRoot: string;
  readonly hostEpochLease: AcpHostEpochLease;
  readonly identityVaultResolver: AcpPrivateBindingVaultResolver;
  readonly directoryName: "acp-task-provider-runtime" | "acp-meta-provider-runtime";
  readonly isClosed: () => boolean;
}>;

const taskPrivateRootAuthorityStates = new WeakMap<object, TaskPrivateRootAuthorityState>();

/**
 * One Runtime Host process owns exactly one supervisor-issued epoch and two
 * namespace-separated durable raw-session vault resolvers. This capability is
 * Host-private and deliberately has no serializable path, epoch or raw-ID
 * projection.
 */
export type AcpRuntimeHostPrivateAuthority = Readonly<{
  taskIdentityVaults: AcpPrivateBindingVaultResolver;
  metaIdentityVaults: AcpPrivateBindingVaultResolver;
  taskPrivateRootAuthority: AcpTaskPrivateRootAuthority;
  metaPrivateRootAuthority: AcpMetaPrivateRootAuthority;
  recoveryObservation(): AcpRuntimeHostPrivateRecoveryObservation;
  /**
   * One-shot supervisor capability. The application assembly must additionally
   * fence the supplied record against its pre-provider startup snapshot.
   */
  authorizeRetiringBindingRecovery(intent: AcpV3BindingRetirementIntentRecord): boolean;
  close(): void;
  toJSON(): Readonly<{ kind: "acp_runtime_host_private_authority" }>;
}>;

export function createAcpRuntimeHostPrivateAuthority(options: Readonly<{
  runtimeDataDirectory: string;
  environment: AcpHostEpochSupervisorEnvironment;
}>): AcpRuntimeHostPrivateAuthority {
  assertExactOptions(options);
  const lease = acquireAcpHostEpochLeaseFromSupervisorEnvironment({
    runtimeDataDirectory: options.runtimeDataDirectory,
    environment: options.environment,
  });
  const taskIdentityVaults = createAcpPrivateBindingVaultResolver({
    runtimeDataDirectory: lease.canonicalRuntimeRoot,
    authorityNamespace: "task",
    hostEpochLease: lease,
  });
  const metaIdentityVaults = createAcpPrivateBindingVaultResolver({
    runtimeDataDirectory: lease.canonicalRuntimeRoot,
    authorityNamespace: "meta",
    hostEpochLease: lease,
  });
  const receipt = lease.recoveryReceipt();
  const observation: AcpRuntimeHostPrivateRecoveryObservation = receipt
    ? Object.freeze({ state: "reclaimed" as const, receiptDigest: receipt.receiptDigest })
    : Object.freeze({ state: "fresh" as const });
  const consumedRetirementRecoveries = new Set<string>();
  let closed = false;
  let closeError: unknown;
  const taskPrivateRootAuthority: AcpTaskPrivateRootAuthority = Object.freeze({
    toJSON: () => Object.freeze({ kind: "acp_task_private_root_authority" as const }),
  });
  taskPrivateRootAuthorityStates.set(taskPrivateRootAuthority, Object.freeze({
    canonicalRuntimeRoot: lease.canonicalRuntimeRoot,
    hostEpochLease: lease,
    identityVaultResolver: taskIdentityVaults,
    directoryName: "acp-task-provider-runtime",
    isClosed: () => closed || closeError !== undefined,
  }));
  const metaPrivateRootAuthority: AcpMetaPrivateRootAuthority = Object.freeze({
    toJSON: () => Object.freeze({ kind: "acp_meta_private_root_authority" as const }),
  });
  taskPrivateRootAuthorityStates.set(metaPrivateRootAuthority, Object.freeze({
    canonicalRuntimeRoot: lease.canonicalRuntimeRoot,
    hostEpochLease: lease,
    identityVaultResolver: metaIdentityVaults,
    directoryName: "acp-meta-provider-runtime",
    isClosed: () => closed || closeError !== undefined,
  }));

  return Object.freeze({
    taskIdentityVaults,
    metaIdentityVaults,
    taskPrivateRootAuthority,
    metaPrivateRootAuthority,
    recoveryObservation() {
      return observation;
    },
    authorizeRetiringBindingRecovery(value) {
      assertAcpHostEpochLeaseActive(lease, lease.canonicalRuntimeRoot);
      const intent = validateAcpV3BindingRetirementIntentRecord(value);
      if (!receipt || intent.state !== "retiring") return false;
      const scope = [
        intent.bindingRetirementIntentId,
        intent.revision,
        intent.bindingId,
        intent.bindingRevision,
        intent.bindingHandle,
        intent.profileRevisionId,
        intent.updatedAt,
      ].join("\0");
      if (consumedRetirementRecoveries.has(scope)) return false;
      consumedRetirementRecoveries.add(scope);
      return true;
    },
    close() {
      if (closeError) throw closeError;
      if (closed) return;
      try {
        lease.close();
        closed = true;
      } catch (error) {
        closeError = error;
        throw error;
      }
    },
    toJSON() {
      return Object.freeze({ kind: "acp_runtime_host_private_authority" as const });
    },
  });
}

/**
 * Host-internal consumer for the opaque Task-root authority. Production
 * assembly passes only the token; no portable Profile/Task value can select a
 * filesystem root.
 */
export function claimAcpTaskPrivateRootAuthority(options: Readonly<{
  readonly authority: AcpTaskPrivateRootAuthority;
  readonly identityVaultResolver: AcpPrivateBindingVaultResolver;
}>): string {
  if (!options || typeof options !== "object" || Array.isArray(options)
    || Object.keys(options).sort().join(",") !== "authority,identityVaultResolver"
    || !options.authority || typeof options.authority !== "object") {
    throw authorityError("acp_task_private_root_authority_invalid");
  }
  const state = privateRootAuthorityState(
    options.authority,
    options.identityVaultResolver,
    "acp-task-provider-runtime",
  );
  return materializePrivateRoot(state);
}

export function claimAcpMetaPrivateRootAuthority(options: Readonly<{
  readonly authority: AcpMetaPrivateRootAuthority;
  readonly identityVaultResolver: AcpPrivateBindingVaultResolver;
}>): string {
  if (!options || typeof options !== "object" || Array.isArray(options)
    || Object.keys(options).sort().join(",") !== "authority,identityVaultResolver") {
    throw authorityError("acp_meta_private_root_authority_invalid");
  }
  const state = privateRootAuthorityState(
    options.authority,
    options.identityVaultResolver,
    "acp-meta-provider-runtime",
    "acp_meta_private_root_authority_invalid",
  );
  return materializePrivateRoot(state, "acp_meta_private_root_authority_invalid");
}

function privateRootAuthorityState(
  authority: unknown,
  identityVaultResolver: AcpPrivateBindingVaultResolver,
  directoryName: TaskPrivateRootAuthorityState["directoryName"],
  code = "acp_task_private_root_authority_invalid",
): TaskPrivateRootAuthorityState {
  if (!authority || typeof authority !== "object") throw authorityError(code);
  const state = taskPrivateRootAuthorityStates.get(authority as object);
  if (!state || state.isClosed()
    || state.identityVaultResolver !== identityVaultResolver
    || state.directoryName !== directoryName) {
    throw authorityError(code);
  }
  return state;
}

function materializePrivateRoot(
  state: TaskPrivateRootAuthorityState,
  code = "acp_task_private_root_authority_invalid",
): string {
  try {
    assertAcpHostEpochLeaseActive(state.hostEpochLease, state.canonicalRuntimeRoot);
    const taskRoot = path.join(state.canonicalRuntimeRoot, state.directoryName);
    try {
      mkdirSync(taskRoot, { mode: 0o700 });
    } catch (error) {
      if (!isNodeError(error, "EEXIST")) {
        throw authorityError(code);
      }
    }
    const metadata = lstatSync(taskRoot);
    const currentUid = typeof process.getuid === "function" ? process.getuid() : undefined;
    if (!metadata.isDirectory() || metadata.isSymbolicLink()
      || (process.platform !== "win32" && (metadata.mode & 0o777) !== 0o700)
      || (currentUid !== undefined && metadata.uid !== currentUid)
      || realpathSync(taskRoot) !== taskRoot
      || path.dirname(taskRoot) !== state.canonicalRuntimeRoot) {
      throw authorityError(code);
    }
    return taskRoot;
  } catch (error) {
    if (error instanceof AcpRuntimeHostPrivateAuthorityError) throw error;
    throw authorityError(code);
  }
}

function assertExactOptions(value: unknown): asserts value is Readonly<{
  runtimeDataDirectory: string;
  environment: AcpHostEpochSupervisorEnvironment;
}> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("acp_runtime_host_private_authority_options_invalid");
  }
  const keys = Object.keys(value).sort();
  if (keys.length !== 2 || keys[0] !== "environment" || keys[1] !== "runtimeDataDirectory") {
    throw new Error("acp_runtime_host_private_authority_options_invalid");
  }
  const options = value as Record<string, unknown>;
  if (typeof options.runtimeDataDirectory !== "string"
    || !options.environment
    || typeof options.environment !== "object"
    || Array.isArray(options.environment)) {
    throw new Error("acp_runtime_host_private_authority_options_invalid");
  }
}

function authorityError(code: string): AcpRuntimeHostPrivateAuthorityError {
  return new AcpRuntimeHostPrivateAuthorityError(code);
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

import { createHash, createPublicKey, randomUUID, verify } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

const HOST_LEASE_FILE = ".acp-host-epoch.lease";
const SAFE_EPOCH = /^host_epoch_[A-Za-z0-9_-]{8,256}$/u;
const BASE64URL = /^[A-Za-z0-9_-]+$/u;
const SHA256_HEX = /^[a-f0-9]{64}$/u;
const RECOVERY_NONCE = /^[A-Za-z0-9_-]{16,256}$/u;
const tokenDetails = new WeakMap<object, RecoveryTokenDetails>();
const consumedTokens = new WeakSet<object>();
type LeaseState = {
  canonicalRuntimeRoot: string;
  hostEpoch: string;
  descriptor: number;
  closed: boolean;
};
const leaseStates = new WeakMap<object, LeaseState>();
const inProcessLeases = new Map<string, object>();

type RecoveryTokenDetails = Readonly<{
  canonicalRuntimeRoot: string;
  deadHostEpoch: string;
  newHostEpoch: string;
}>;

export type ConfirmedDeadHostEpochToken = Readonly<{
  readonly kind: "confirmed_dead_host_epoch";
}>;

export type AcpHostEpochLease = Readonly<{
  readonly hostEpoch: string;
  readonly canonicalRuntimeRoot: string;
  canReclaimHostEpoch(hostEpoch: string): boolean;
  recoveryReceipt(): Readonly<{
    kind: "acp_host_epoch_reclaimed";
    receiptDigest: string;
  }> | undefined;
  close(): void;
  toJSON(): Readonly<{ readonly kind: "acp_host_epoch_lease" }>;
}>;

export type AcpHostEpochLeaseFactory = Readonly<{
  acquire(input: Readonly<{
    runtimeDataDirectory: string;
    newHostEpoch?: string;
    confirmedDeadToken?: ConfirmedDeadHostEpochToken;
  }>): AcpHostEpochLease;
}>;

export type AcpHostEpochRecoveryIssuer = Readonly<{
  issueAfterConfirmedExit(input: Readonly<{
    runtimeDataDirectory: string;
    deadHostEpoch: string;
    newHostEpoch: string;
    /** Supervisor-owned wait; Host and ordinary callers never receive this issuer capability. */
    awaitConfirmedExit: () => Promise<void>;
  }>): Promise<ConfirmedDeadHostEpochToken>;
}>;

export type AcpHostEpochSupervisorEnvironment = Readonly<Record<string, string | undefined>>;

/**
 * Pure launch preflight used before a Runtime data directory is created. Full
 * recovery-proof signature/root verification still occurs while acquiring the
 * lease against the canonical Runtime root.
 */
export function assertAcpHostEpochSupervisorEnvironmentConfigured(
  environment: AcpHostEpochSupervisorEnvironment,
): void {
  if (!environment || typeof environment !== "object" || Array.isArray(environment)) {
    fail("acp_host_epoch_launch_environment_invalid");
  }
  requireEpoch(environment.AGENT_WORKSPACE_ACP_HOST_EPOCH, "acp_new_host_epoch_invalid");
  parseSupervisorPublicKey(environment.AGENT_WORKSPACE_ACP_HOST_EPOCH_PUBLIC_KEY);
  const proof = environment.AGENT_WORKSPACE_ACP_HOST_EPOCH_RECOVERY_PROOF;
  if (proof !== undefined
    && (typeof proof !== "string" || proof.length < 32 || proof.length > 8_192 || !BASE64URL.test(proof))) {
    fail("acp_host_epoch_recovery_proof_invalid");
  }
}

/**
 * Child-process entry point. The Desktop supervisor retains the signing key;
 * the Runtime Host receives only the next epoch, public verifier and an
 * optional proof scoped to one already-confirmed dead predecessor.
 */
export function acquireAcpHostEpochLeaseFromSupervisorEnvironment(options: Readonly<{
  runtimeDataDirectory: string;
  environment: AcpHostEpochSupervisorEnvironment;
}>): AcpHostEpochLease {
  const canonicalRuntimeRoot = requireRuntimeRoot(options?.runtimeDataDirectory);
  const environment = options?.environment;
  assertAcpHostEpochSupervisorEnvironmentConfigured(environment);
  const newHostEpoch = requireEpoch(
    environment.AGENT_WORKSPACE_ACP_HOST_EPOCH,
    "acp_new_host_epoch_invalid",
  );
  const publicKey = parseSupervisorPublicKey(
    environment.AGENT_WORKSPACE_ACP_HOST_EPOCH_PUBLIC_KEY,
  );
  const serializedProof = environment.AGENT_WORKSPACE_ACP_HOST_EPOCH_RECOVERY_PROOF;
  let confirmedDeadToken: ConfirmedDeadHostEpochToken | undefined;
  if (serializedProof !== undefined) {
    const details = verifySupervisorRecoveryProof({
      serializedProof,
      publicKey,
      canonicalRuntimeRoot,
      newHostEpoch,
    });
    confirmedDeadToken = Object.freeze({ kind: "confirmed_dead_host_epoch" as const });
    tokenDetails.set(confirmedDeadToken, details);
  }
  return createAcpHostEpochRecoveryAuthority().hostLeaseFactory.acquire({
    runtimeDataDirectory: canonicalRuntimeRoot,
    newHostEpoch,
    ...(confirmedDeadToken ? { confirmedDeadToken } : {}),
  });
}

/**
 * Embedded/controlled composition seam: the launcher retains
 * `supervisorIssuer` and passes only `hostLeaseFactory` to the Host. A real
 * child-process Host instead uses the signed environment entry point above;
 * JavaScript capabilities are never serialized across the process boundary.
 */
export function createAcpHostEpochRecoveryAuthority(): Readonly<{
  supervisorIssuer: AcpHostEpochRecoveryIssuer;
  hostLeaseFactory: AcpHostEpochLeaseFactory;
}> {
  const supervisorIssuer: AcpHostEpochRecoveryIssuer = Object.freeze({
    async issueAfterConfirmedExit(input) {
      if (typeof input?.awaitConfirmedExit !== "function") fail("acp_host_exit_confirmation_required");
      const canonicalRuntimeRoot = requireRuntimeRoot(input.runtimeDataDirectory);
      const deadHostEpoch = requireEpoch(input.deadHostEpoch, "acp_dead_host_epoch_invalid");
      const newHostEpoch = requireEpoch(input.newHostEpoch, "acp_new_host_epoch_invalid");
      if (deadHostEpoch === newHostEpoch) fail("acp_host_epoch_reuse_forbidden");
      await input.awaitConfirmedExit();
      const token = Object.freeze({ kind: "confirmed_dead_host_epoch" as const });
      tokenDetails.set(token, Object.freeze({ canonicalRuntimeRoot, deadHostEpoch, newHostEpoch }));
      return token;
    },
  });

  const hostLeaseFactory: AcpHostEpochLeaseFactory = Object.freeze({
    acquire(input) {
      const canonicalRuntimeRoot = requireRuntimeRoot(input?.runtimeDataDirectory);
      const newHostEpoch = requireEpoch(
        input?.newHostEpoch ?? `host_epoch_${randomUUID().replace(/-/gu, "")}`,
        "acp_new_host_epoch_invalid",
      );
      const leaseFile = path.join(canonicalRuntimeRoot, HOST_LEASE_FILE);
      let recoveredDeadHostEpoch: string | undefined;
      let descriptor = tryCreateLeaseFile(leaseFile, newHostEpoch);
      if (descriptor !== undefined && input?.confirmedDeadToken) {
        const opened = fstatSync(descriptor);
        closeSync(descriptor);
        unlinkExact(leaseFile, opened.dev, opened.ino, "acp_host_epoch_lease_cleanup_unconfirmed");
        syncDirectory(canonicalRuntimeRoot);
        fail("acp_host_recovery_token_not_required");
      }
      if (descriptor === undefined) {
        const token = input?.confirmedDeadToken;
        const details = token && tokenDetails.get(token);
        if (!token || !details || consumedTokens.has(token)) fail("acp_host_epoch_lease_held");
        if (details.canonicalRuntimeRoot !== canonicalRuntimeRoot
          || details.newHostEpoch !== newHostEpoch) {
          fail("acp_host_recovery_token_scope_mismatch");
        }
        consumedTokens.add(token);
        const stale = readExactLeaseFile(leaseFile);
        if (stale.hostEpoch !== details.deadHostEpoch) fail("acp_host_recovery_dead_epoch_mismatch");
        invalidateConfirmedDeadInProcessLease(canonicalRuntimeRoot, details.deadHostEpoch);
        unlinkExact(leaseFile, stale.dev, stale.ino, "acp_host_epoch_lease_recovery_failed");
        syncDirectory(canonicalRuntimeRoot);
        descriptor = tryCreateLeaseFile(leaseFile, newHostEpoch);
        if (descriptor === undefined) fail("acp_host_epoch_lease_held");
        recoveredDeadHostEpoch = details.deadHostEpoch;
      }

      const opened = fstatSync(descriptor);
      const recoveryReceipt = recoveredDeadHostEpoch
        ? Object.freeze({
            kind: "acp_host_epoch_reclaimed" as const,
            receiptDigest: `sha256:${createHash("sha256").update(JSON.stringify({
              canonicalRuntimeRoot,
              deadHostEpoch: recoveredDeadHostEpoch,
              newHostEpoch,
            })).digest("hex")}`,
          })
        : undefined;
      const state: LeaseState = {
        canonicalRuntimeRoot,
        hostEpoch: newHostEpoch,
        descriptor,
        closed: false,
      };
      const lease: AcpHostEpochLease = Object.freeze({
        hostEpoch: newHostEpoch,
        canonicalRuntimeRoot,
        canReclaimHostEpoch(hostEpoch) {
          return hostEpoch === recoveredDeadHostEpoch;
        },
        recoveryReceipt() {
          return recoveryReceipt;
        },
        close() {
          if (state.closed) return;
          state.closed = true;
          inProcessLeases.delete(leaseKey(canonicalRuntimeRoot, newHostEpoch));
          closeSync(state.descriptor);
          unlinkExact(leaseFile, opened.dev, opened.ino, "acp_host_epoch_lease_cleanup_unconfirmed");
          syncDirectory(canonicalRuntimeRoot);
        },
        toJSON() {
          return Object.freeze({ kind: "acp_host_epoch_lease" as const });
        },
      });
      leaseStates.set(lease, state);
      inProcessLeases.set(leaseKey(canonicalRuntimeRoot, newHostEpoch), lease);
      return lease;
    },
  });

  return Object.freeze({ supervisorIssuer, hostLeaseFactory });
}

function invalidateConfirmedDeadInProcessLease(canonicalRuntimeRoot: string, hostEpoch: string): void {
  const lease = inProcessLeases.get(leaseKey(canonicalRuntimeRoot, hostEpoch));
  if (!lease) return;
  const state = leaseStates.get(lease);
  if (!state || state.closed) return;
  state.closed = true;
  inProcessLeases.delete(leaseKey(canonicalRuntimeRoot, hostEpoch));
  try { closeSync(state.descriptor); } catch { fail("acp_host_epoch_lease_recovery_failed"); }
}

function leaseKey(canonicalRuntimeRoot: string, hostEpoch: string): string {
  return `${canonicalRuntimeRoot}\0${hostEpoch}`;
}

function tryCreateLeaseFile(file: string, hostEpoch: string): number | undefined {
  let descriptor: number | undefined;
  let openedIdentity: Readonly<{ dev: bigint | number; ino: bigint | number }> | undefined;
  try {
    descriptor = openSync(
      file,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_RDWR | noFollowFlag(),
      0o600,
    );
    fchmodSync(descriptor, 0o600);
    const opened = fstatSync(descriptor);
    openedIdentity = { dev: opened.dev, ino: opened.ino };
    if (!opened.isFile() || (opened.mode & 0o777) !== 0o600) fail("acp_host_epoch_lease_unsafe");
    writeFileSync(descriptor, `${JSON.stringify({ schemaVersion: 1, hostEpoch })}\n`, "utf8");
    fsyncSync(descriptor);
    syncDirectory(path.dirname(file));
    return descriptor;
  } catch (error) {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch { /* exact failed create cleanup below */ }
      if (openedIdentity) {
        try {
          const current = lstatSync(file);
          if (!current.isSymbolicLink()
            && current.dev === openedIdentity.dev
            && current.ino === openedIdentity.ino) unlinkSync(file);
        } catch { /* absent or externally replaced remains a safe failure */ }
      }
    }
    if (isNodeError(error, "EEXIST")) return undefined;
    if (error instanceof AcpHostEpochLeaseError) throw error;
    fail("acp_host_epoch_lease_unsafe");
  }
}

/** Runtime check for the unforgeable, still-active Host lease capability. */
export function assertAcpHostEpochLeaseActive(
  value: unknown,
  canonicalRuntimeRoot: string,
): asserts value is AcpHostEpochLease {
  if (!value || typeof value !== "object") fail("acp_host_epoch_lease_capability_invalid");
  const state = leaseStates.get(value);
  if (!state || state.closed || state.canonicalRuntimeRoot !== canonicalRuntimeRoot) {
    fail("acp_host_epoch_lease_capability_invalid");
  }
}

function readExactLeaseFile(file: string): Readonly<{ hostEpoch: string; dev: bigint | number; ino: bigint | number }> {
  const before = safeLstat(file, "acp_host_epoch_lease_unsafe");
  if (!before.isFile() || before.isSymbolicLink() || (before.mode & 0o777) !== 0o600) {
    fail("acp_host_epoch_lease_unsafe");
  }
  let descriptor: number | undefined;
  try {
    descriptor = openSync(file, fsConstants.O_RDONLY | noFollowFlag());
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
      fail("acp_host_epoch_lease_unsafe");
    }
    const parsed = JSON.parse(readFileSync(descriptor, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) fail("acp_host_epoch_lease_corrupt");
    const record = parsed as Record<string, unknown>;
    if (Object.keys(record).sort().join(",") !== "hostEpoch,schemaVersion"
      || record.schemaVersion !== 1) fail("acp_host_epoch_lease_corrupt");
    return { hostEpoch: requireEpoch(record.hostEpoch, "acp_host_epoch_lease_corrupt"), dev: opened.dev, ino: opened.ino };
  } catch (error) {
    if (error instanceof AcpHostEpochLeaseError) throw error;
    fail("acp_host_epoch_lease_corrupt");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  throw new AcpHostEpochLeaseError("acp_host_epoch_lease_corrupt");
}

function unlinkExact(file: string, dev: bigint | number, ino: bigint | number, code: string): void {
  const current = safeLstat(file, code);
  if (!current.isFile() || current.isSymbolicLink() || current.dev !== dev || current.ino !== ino) fail(code);
  try { unlinkSync(file); } catch { fail(code); }
}

function requireRuntimeRoot(value: unknown): string {
  if (typeof value !== "string" || !path.isAbsolute(value) || value.includes("\0")) {
    fail("acp_host_runtime_root_invalid");
  }
  const stat = safeLstat(value, "acp_host_runtime_root_invalid");
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o700) {
    fail("acp_host_runtime_root_invalid");
  }
  return realpathSync(value);
}

function requireEpoch(value: unknown, code: string): string {
  if (typeof value !== "string" || !SAFE_EPOCH.test(value)) fail(code);
  return value;
}

function parseSupervisorPublicKey(value: unknown) {
  if (typeof value !== "string" || value.length < 32 || value.length > 1_024 || !BASE64URL.test(value)) {
    fail("acp_host_epoch_recovery_public_key_invalid");
  }
  try {
    const key = createPublicKey({ key: Buffer.from(value, "base64url"), format: "der", type: "spki" });
    if (key.asymmetricKeyType !== "ed25519") fail("acp_host_epoch_recovery_public_key_invalid");
    return key;
  } catch (error) {
    if (error instanceof AcpHostEpochLeaseError) throw error;
    return fail("acp_host_epoch_recovery_public_key_invalid");
  }
}

function verifySupervisorRecoveryProof(input: Readonly<{
  serializedProof: unknown;
  publicKey: ReturnType<typeof createPublicKey>;
  canonicalRuntimeRoot: string;
  newHostEpoch: string;
}>): RecoveryTokenDetails {
  if (typeof input.serializedProof !== "string"
    || input.serializedProof.length < 32
    || input.serializedProof.length > 8_192
    || !BASE64URL.test(input.serializedProof)) {
    fail("acp_host_epoch_recovery_proof_invalid");
  }
  try {
    const envelope = exactObject(
      JSON.parse(Buffer.from(input.serializedProof, "base64url").toString("utf8")),
      ["payload", "signature"],
    );
    const payloadText = boundedBase64Url(envelope.payload, 32, 4_096);
    const signatureText = boundedBase64Url(envelope.signature, 32, 1_024);
    const payloadBytes = Buffer.from(payloadText, "base64url");
    if (!verify(null, payloadBytes, input.publicKey, Buffer.from(signatureText, "base64url"))) {
      fail("acp_host_epoch_recovery_proof_invalid");
    }
    const payload = exactObject(JSON.parse(payloadBytes.toString("utf8")), [
      "deadHostEpoch",
      "newHostEpoch",
      "nonce",
      "runtimeRootDigest",
      "schemaVersion",
    ]);
    if (payload.schemaVersion !== 1
      || typeof payload.runtimeRootDigest !== "string"
      || !SHA256_HEX.test(payload.runtimeRootDigest)
      || payload.runtimeRootDigest !== createHash("sha256").update(input.canonicalRuntimeRoot).digest("hex")
      || payload.newHostEpoch !== input.newHostEpoch
      || typeof payload.nonce !== "string"
      || !RECOVERY_NONCE.test(payload.nonce)) {
      fail("acp_host_epoch_recovery_proof_invalid");
    }
    return Object.freeze({
      canonicalRuntimeRoot: input.canonicalRuntimeRoot,
      deadHostEpoch: requireEpoch(payload.deadHostEpoch, "acp_host_epoch_recovery_proof_invalid"),
      newHostEpoch: input.newHostEpoch,
    });
  } catch (error) {
    if (error instanceof AcpHostEpochLeaseError) throw error;
    return fail("acp_host_epoch_recovery_proof_invalid");
  }
}

function exactObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("acp_host_epoch_recovery_proof_invalid");
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !== [...keys].sort().join(",")) {
    fail("acp_host_epoch_recovery_proof_invalid");
  }
  return record;
}

function boundedBase64Url(value: unknown, minimum: number, maximum: number): string {
  if (typeof value !== "string" || value.length < minimum || value.length > maximum || !BASE64URL.test(value)) {
    fail("acp_host_epoch_recovery_proof_invalid");
  }
  return value;
}

function safeLstat(file: string, code: string) {
  try { return lstatSync(file); } catch { return fail(code); }
}

function syncDirectory(directory: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(directory, fsConstants.O_RDONLY | noFollowFlag());
    fsyncSync(descriptor);
  } catch {
    fail("acp_host_epoch_lease_sync_failed");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function noFollowFlag(): number {
  if (typeof fsConstants.O_NOFOLLOW !== "number") fail("acp_host_no_follow_unavailable");
  return fsConstants.O_NOFOLLOW;
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

export class AcpHostEpochLeaseError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = "AcpHostEpochLeaseError";
    this.code = code;
  }
}

function fail(code: string): never {
  throw new AcpHostEpochLeaseError(code);
}

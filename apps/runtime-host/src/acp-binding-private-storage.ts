import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readdir, realpath, rm } from "node:fs/promises";
import path from "node:path";

const OPAQUE_BINDING = /^[A-Za-z][A-Za-z0-9_-]{1,255}$/u;

export type AcpBindingPrivateStorageLease = Readonly<{
  /** Empty Host-private cwd for the provider process; never the Task workspace. */
  readonly processWorkingDirectory: string;
  /** Provider-owned state that survives process generations for this Binding. */
  readonly providerDataDirectory: string;
  assertProcessWorkingDirectoryEmpty(): Promise<true>;
  /** Called only after the generation's child exit is confirmed. */
  prepareForRestart(): Promise<void>;
  /** Final deletion belongs to Binding release/retirement, never generation close. */
  releaseBinding(): Promise<void>;
}>;

export type AcpBindingPrivateStorageRegistry = Readonly<{
  acquire(bindingHandle: string): Promise<AcpBindingPrivateStorageLease>;
  safeObservation(): Readonly<{
    readonly availability: "active";
    readonly bindingCount: number;
  }>;
}>;

export class AcpBindingPrivateStorageError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "AcpBindingPrivateStorageError";
    this.code = code;
  }
}

/**
 * Maps an opaque Binding handle to stable Host-private process and provider
 * state directories. The Task workspace is deliberately outside this owner.
 */
export function createAcpBindingPrivateStorageRegistry(options: Readonly<{
  readonly parentDirectory: string;
}>): AcpBindingPrivateStorageRegistry {
  let parentPromise: Promise<string> | undefined;
  const resolveParent = () => (
    parentPromise ??= canonicalPrivateParent(options?.parentDirectory).catch((error) => {
      parentPromise = undefined;
      throw error;
    })
  );
  const leases = new Map<string, Promise<AcpBindingPrivateStorageLease>>();

  return Object.freeze({
    acquire(bindingHandleValue) {
      const bindingHandle = opaqueBinding(bindingHandleValue);
      const current = leases.get(bindingHandle);
      if (current) return current;
      const pending = resolveParent().then(async (parent) => {
        const processWorkingDirectory = path.join(parent, privateDirectoryName(bindingHandle));
        const providerDataDirectory = path.join(parent, `${privateDirectoryName(bindingHandle)}-data`);
        for (const privateDirectory of [processWorkingDirectory, providerDataDirectory]) {
          await mkdir(privateDirectory, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== "EEXIST") throw safeError("acp_binding_private_storage_create_failed");
          });
          const beforeChmod = await lstat(privateDirectory).catch(() => {
            throw safeError("acp_binding_private_storage_invalid");
          });
          const currentUid = typeof process.getuid === "function" ? process.getuid() : undefined;
          if (!beforeChmod.isDirectory()
            || beforeChmod.isSymbolicLink()
            || (currentUid !== undefined && beforeChmod.uid !== currentUid)) {
            throw safeError("acp_binding_private_storage_invalid");
          }
          await chmod(privateDirectory, 0o700).catch(() => {
            throw safeError("acp_binding_private_storage_permissions_invalid");
          });
        }
        await validatePrivateDirectory(processWorkingDirectory, true);
        await validatePrivateDirectory(providerDataDirectory, false);
        let released = false;
        let cleanupPoisoned = false;
        let preparePromise: Promise<void> | undefined;
        let releasePromise: Promise<void> | undefined;
        const lease: AcpBindingPrivateStorageLease = Object.freeze({
          processWorkingDirectory,
          providerDataDirectory,
          async assertProcessWorkingDirectoryEmpty() {
            if (released) throw safeError("acp_binding_private_storage_released");
            await validatePrivateDirectory(processWorkingDirectory, true);
            return true as const;
          },
          prepareForRestart() {
            if (released) return Promise.reject(safeError("acp_binding_private_storage_released"));
            preparePromise ??= (async () => {
              try {
                await validatePrivateDirectory(processWorkingDirectory, false);
                for (const entry of await readdir(processWorkingDirectory)) {
                  await rm(path.join(processWorkingDirectory, entry), { recursive: true, force: true });
                }
                await chmod(processWorkingDirectory, 0o700);
                await validatePrivateDirectory(processWorkingDirectory, true);
              } catch (error) {
                cleanupPoisoned = true;
                throw error;
              }
            })().finally(() => { preparePromise = undefined; });
            return preparePromise;
          },
          releaseBinding() {
            releasePromise ??= (async () => {
              released = true;
              try {
                await preparePromise;
              } catch {
                cleanupPoisoned = true;
              }
              try {
                await Promise.all([
                  rm(processWorkingDirectory, { recursive: true, force: true }),
                  rm(providerDataDirectory, { recursive: true, force: true }),
                ]);
              } catch {
                cleanupPoisoned = true;
              }
              const removalConfirmed = (await Promise.all(
                [processWorkingDirectory, providerDataDirectory].map(async (privateDirectory) => {
                  try {
                    await lstat(privateDirectory);
                    return false;
                  } catch (error) {
                    return isMissingFile(error);
                  }
                }),
              )).every(Boolean);
              if (removalConfirmed && leases.get(bindingHandle) === pending) leases.delete(bindingHandle);
              if (cleanupPoisoned || !removalConfirmed) {
                throw safeError("acp_binding_private_storage_cleanup_unconfirmed");
              }
            })();
            return releasePromise;
          },
        });
        return lease;
      }).catch((error) => {
        if (leases.get(bindingHandle) === pending) leases.delete(bindingHandle);
        if (error instanceof AcpBindingPrivateStorageError) throw error;
        throw safeError("acp_binding_private_storage_acquire_failed");
      });
      leases.set(bindingHandle, pending);
      return pending;
    },
    safeObservation: () => Object.freeze({
      availability: "active" as const,
      bindingCount: leases.size,
    }),
  });
}

async function canonicalPrivateParent(value: unknown): Promise<string> {
  if (typeof value !== "string" || !path.isAbsolute(value) || value.includes("\0")) {
    throw safeError("acp_binding_private_storage_parent_invalid");
  }
  try {
    const canonical = await realpath(path.normalize(value));
    const metadata = await lstat(canonical);
    const currentUid = typeof process.getuid === "function" ? process.getuid() : undefined;
    if (!metadata.isDirectory()
      || metadata.isSymbolicLink()
      || (metadata.mode & 0o077) !== 0
      || (currentUid !== undefined && metadata.uid !== currentUid)) {
      throw new Error("unsafe_parent");
    }
    return canonical;
  } catch (error) {
    if (error instanceof AcpBindingPrivateStorageError) throw error;
    throw safeError("acp_binding_private_storage_parent_invalid");
  }
}

async function validatePrivateDirectory(directory: string, requireEmpty: boolean): Promise<void> {
  let metadata;
  let canonical;
  let entries;
  try {
    [metadata, canonical, entries] = await Promise.all([
      lstat(directory),
      realpath(directory),
      readdir(directory),
    ]);
  } catch {
    throw safeError("acp_binding_private_storage_invalid");
  }
  const currentUid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (!metadata.isDirectory()
    || metadata.isSymbolicLink()
    || canonical !== directory
    || (metadata.mode & 0o777) !== 0o700
    || (currentUid !== undefined && metadata.uid !== currentUid)) {
    throw safeError("acp_binding_private_storage_invalid");
  }
  if (requireEmpty && entries.length !== 0) {
    throw safeError("acp_binding_private_storage_not_empty");
  }
}

function privateDirectoryName(bindingHandle: string): string {
  const digest = createHash("sha256").update(bindingHandle).digest("hex");
  return `binding-${digest.slice(0, 48)}`;
}

function opaqueBinding(value: unknown): string {
  if (typeof value !== "string" || !OPAQUE_BINDING.test(value)) {
    throw safeError("acp_binding_private_storage_handle_invalid");
  }
  return value;
}

function isMissingFile(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as NodeJS.ErrnoException).code === "ENOENT");
}

function safeError(code: string): AcpBindingPrivateStorageError {
  return new AcpBindingPrivateStorageError(code);
}

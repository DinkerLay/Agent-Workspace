import { randomUUID } from "node:crypto";
import { spawn as nodeSpawn } from "node:child_process";
import path from "node:path";
import { Transform, type Readable, type TransformCallback, type Writable } from "node:stream";
import {
  type AcpV1ReverseRpcHandlers,
  type AcpV1ConnectionFactory,
  type CreateManagedAcpV1ClientOptions,
  type ManagedAcpV1Client,
} from "@agent-workspace/provider-acp";
import {
  createHostPrivateBindingIdentityVault,
  createManagedAcpV1ClientWithHostPrivateIdentity,
  type HostPrivateBindingIdentityVault,
} from "@agent-workspace/provider-acp/host-private";
import type { AcpHostGenerationFence } from "./acp-qualification.js";
import type { LocalProfileResolution } from "./acp-profile-resolution.js";

const ENVIRONMENT_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u;
const DEFAULT_TERMINATION_GRACE_MS = 1_000;
const DEFAULT_KILL_CONFIRMATION_MS = 1_000;
const DEFAULT_MAX_NDJSON_FRAME_BYTES = 1024 * 1024;
const DEFAULT_MAX_STDERR_BYTES = 64 * 1024;
// Real ACP wrappers may populate hundreds of generation-private cache files.
// Keep cleanup bounded, but allow enough time to remove that exact owned tree
// before declaring the Host poisoned.
const DEFAULT_CREDENTIAL_CLEANUP_TIMEOUT_MS = 10_000;

export type AcpAgentSpawnOptions = Readonly<{
  readonly cwd?: string;
  readonly env: NodeJS.ProcessEnv;
  readonly detached: true;
  readonly shell: false;
  readonly windowsHide: true;
  readonly stdio: readonly ["pipe", "pipe", "pipe"];
}>;

export interface AcpAgentChildProcess {
  readonly pid?: number;
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  once(event: "error", listener: (error: Error) => void): unknown;
  once(
    event: "close",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown;
  kill(signal?: NodeJS.Signals): boolean;
}

export type AcpAgentSpawn = (
  command: string,
  arguments_: readonly string[],
  options: AcpAgentSpawnOptions,
) => AcpAgentChildProcess;

export type AcpCredentialLease = Readonly<{
  readonly environment: Readonly<Record<string, string>>;
  /** Resolves only after all generation-scoped credential material is removed. */
  revoke(): Promise<void>;
}>;

export type AcpStdioConnectionInput = Readonly<{
  readonly input: Writable;
  readonly output: Readable;
  readonly signal: AbortSignal;
}>;

/** Provider-neutral adapter seam; Phase 3+ may implement it with the official ACP SDK. */
export type AcpStdioConnectionFactory = (
  streams: AcpStdioConnectionInput,
) => AcpV1ConnectionFactory;

export type AcpPreparedReverseRpc = Readonly<{
  readonly handlers: AcpV1ReverseRpcHandlers;
  close(): Promise<void>;
}>;

export interface AcpProcessGeneration extends AcpHostGenerationFence {
  assertActive(): void;
  toJSON(): Readonly<{ readonly active: boolean }>;
}

export type AcpAgentProcessSafeObservation = Readonly<{
  readonly profileRevisionId: string;
  readonly providerFamily: string;
  readonly acpAgentKind: string;
  readonly bindingHandle: string;
  readonly availability: "available" | "unavailable" | "closed";
  readonly reason?: string;
}>;

export type AcpAgentProcessCloseObservation = Readonly<{
  readonly exitConfirmed: boolean;
  readonly credentialCleanupConfirmed: boolean;
  readonly capabilityCleanupConfirmed: boolean;
  readonly observation: AcpAgentProcessSafeObservation;
}>;

export type AcpAgentProcessLease = Readonly<{
  readonly bindingHandle: string;
  readonly generation: AcpProcessGeneration;
  readonly client: ManagedAcpV1Client;
  readonly closed: Promise<AcpAgentProcessCloseObservation>;
  safeObservation(): AcpAgentProcessSafeObservation;
  close(): Promise<void>;
}>;

export type AcpAgentProcessOpenCleanupObservation = Readonly<{
  readonly processCleanupConfirmed: boolean;
  readonly credentialCleanupConfirmed: boolean;
  readonly capabilityCleanupConfirmed: boolean;
}>;

export type AcpAgentProcessOpenOperation = Readonly<{
  readonly lease: Promise<AcpAgentProcessLease>;
  cancelAndWait(): Promise<AcpAgentProcessOpenCleanupObservation>;
}>;

export type AcpAgentProcessOpenInput = Readonly<{
  readonly bindingHandle: string;
  readonly resolution: LocalProfileResolution;
  readonly workspaceDirectory?: string;
  readonly credentialLease?: AcpCredentialLease;
  readonly createConnection: AcpStdioConnectionFactory;
  readonly managedClientOptions?: Omit<CreateManagedAcpV1ClientOptions, "connect" | "generationId">;
  readonly prepareReverseRpc?: (generation: AcpProcessGeneration) => AcpPreparedReverseRpc;
}>;

export type AcpAgentProcessFactory = Readonly<{
  beginOpen(input: AcpAgentProcessOpenInput): AcpAgentProcessOpenOperation;
  open(input: AcpAgentProcessOpenInput): Promise<AcpAgentProcessLease>;
  close(): Promise<void>;
}>;

export type AcpAgentIdentityVaultResolver = (
  scope: Readonly<{
    profileRevisionId: string;
    profileResolutionFingerprint: string;
  }>,
) => HostPrivateBindingIdentityVault;

export class AcpAgentProcessError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "AcpAgentProcessError";
    this.code = code;
  }
}

export function createAcpAgentProcessFactory(options: Readonly<{
  readonly spawn?: AcpAgentSpawn;
  readonly signalChild?: (child: AcpAgentChildProcess, signal: NodeJS.Signals) => boolean;
  readonly terminationGraceMs?: number;
  readonly killConfirmationMs?: number;
  readonly maxNdjsonFrameBytes?: number;
  readonly maxStderrBytes?: number;
  readonly credentialCleanupTimeoutMs?: number;
  readonly createOpaqueId?: () => string;
  readonly identityVault?: HostPrivateBindingIdentityVault;
  readonly identityVaultResolver?: AcpAgentIdentityVaultResolver;
}> = {}): AcpAgentProcessFactory {
  if (options.identityVault && options.identityVaultResolver) {
    throw safeError("acp_agent_identity_vault_options_conflict");
  }
  const spawn = options.spawn ?? spawnNodeChild;
  const signalChild = options.signalChild ?? signalProcessTree;
  const terminationGraceMs = boundedInteger(
    options.terminationGraceMs ?? DEFAULT_TERMINATION_GRACE_MS,
    1,
    120_000,
    "acp_agent_termination_grace_invalid",
  );
  const killConfirmationMs = boundedInteger(
    options.killConfirmationMs ?? DEFAULT_KILL_CONFIRMATION_MS,
    1,
    120_000,
    "acp_agent_kill_confirmation_invalid",
  );
  const maxNdjsonFrameBytes = boundedInteger(
    options.maxNdjsonFrameBytes ?? DEFAULT_MAX_NDJSON_FRAME_BYTES,
    16,
    16 * 1024 * 1024,
    "acp_agent_ndjson_limit_invalid",
  );
  const maxStderrBytes = boundedInteger(
    options.maxStderrBytes ?? DEFAULT_MAX_STDERR_BYTES,
    1,
    1024 * 1024,
    "acp_agent_stderr_limit_invalid",
  );
  const credentialCleanupTimeoutMs = boundedInteger(
    options.credentialCleanupTimeoutMs ?? DEFAULT_CREDENTIAL_CLEANUP_TIMEOUT_MS,
    1,
    120_000,
    "acp_agent_credential_cleanup_timeout_invalid",
  );
  const createOpaqueId = options.createOpaqueId ?? (() => `acp_generation_${randomUUID()}`);
  const identityVault = options.identityVault ?? createHostPrivateBindingIdentityVault();
  const resolveIdentityVault: AcpAgentIdentityVaultResolver = options.identityVaultResolver
    ?? (() => identityVault);
  const slots = new Map<string, ProcessSlot>();
  let factoryClosed = false;
  let factoryClosePromise: Promise<void> | undefined;

  const factory: AcpAgentProcessFactory = Object.freeze({
    beginOpen(input) {
      const cleanupCredential = cleanupLeaseFor(input?.credentialLease);
      if (factoryClosed) {
        return rejectedOpenOperation(
          cleanupCredential,
          safeError("acp_agent_process_factory_closed"),
          credentialCleanupTimeoutMs,
        );
      }
      let bindingHandle: string;
      try {
        bindingHandle = requiredOpaqueId(input?.bindingHandle, "acp_agent_binding_handle_invalid");
      } catch (error) {
        return rejectedOpenOperation(cleanupCredential, error, credentialCleanupTimeoutMs);
      }
      const existing = slots.get(bindingHandle);
      if (existing) {
        if (existing.poisonedCode) {
          if (existing.request.credentialLease !== input.credentialLease) {
            return rejectedOpenOperation(
              cleanupCredential,
              safeError(existing.poisonedCode),
              credentialCleanupTimeoutMs,
            );
          }
          return rejectedOpenAlias(
            safeError(existing.poisonedCode),
            existing.operation.cancelAndWait,
          );
        }
        if (existing.request !== input) {
          if (existing.request.credentialLease === input.credentialLease) {
            return rejectedOpenAlias(
              safeError("acp_agent_binding_process_request_conflict"),
              existing.operation.cancelAndWait,
            );
          }
          return rejectedOpenOperation(
            cleanupCredential,
            safeError("acp_agent_binding_process_request_conflict"),
            credentialCleanupTimeoutMs,
          );
        }
        return existing.operation;
      }
      let generationId: string;
      let processIdentityVault: HostPrivateBindingIdentityVault;
      try {
        generationId = requiredOpaqueId(createOpaqueId(), "acp_agent_generation_id_invalid");
        const material = input.resolution.hostPrivateLaunchMaterial();
        processIdentityVault = resolveIdentityVault({
          profileRevisionId: input.resolution.profileRevisionId,
          profileResolutionFingerprint: material.sealFingerprint,
        });
        if (!processIdentityVault || typeof processIdentityVault.checkout !== "function") {
          throw safeError("acp_agent_identity_vault_invalid");
        }
      } catch (error) {
        return rejectedOpenOperation(cleanupCredential, error, credentialCleanupTimeoutMs);
      }
      const slot = {
        request: input,
        cleanupCredential,
        cancelled: false,
      } as ProcessSlot;
      slot.opened = startProcess({
        input: { ...input, bindingHandle },
        cleanupCredential,
        spawn,
        signalChild,
        terminationGraceMs,
        killConfirmationMs,
        maxNdjsonFrameBytes,
        maxStderrBytes,
        credentialCleanupTimeoutMs,
        generationId,
        identityVault: processIdentityVault,
        onReleasable: () => {
          if (slots.get(bindingHandle) === slot) slots.delete(bindingHandle);
        },
        setLifecycle: (lifecycle) => {
          slot.lifecycle = lifecycle;
        },
        setEarlyProcessCleanup: (cleanup) => {
          slot.earlyProcessCleanup = cleanup;
        },
        assertOpen: () => {
          if (slot.cancelled) throw safeError("acp_agent_process_open_cancelled");
        },
        poisonSlot: (code) => {
          slot.poisonedCode = code;
        },
      }).catch((error) => {
        if (!slot.poisonedCode && (!slot.lifecycle || slot.lifecycle.isReleasable())) {
          slots.delete(bindingHandle);
        }
        throw error;
      });
      slot.operation = Object.freeze({
        lease: slot.opened,
        cancelAndWait: () => cancelProcessSlot({
          slot,
          bindingHandle,
          slots,
          credentialCleanupTimeoutMs,
        }),
      });
      slots.set(bindingHandle, slot);
      return slot.operation;
    },

    open(input) {
      return factory.beginOpen(input).lease;
    },

    close() {
      if (factoryClosePromise) return factoryClosePromise;
      factoryClosed = true;
      factoryClosePromise = Promise.allSettled([...slots.values()].map((slot) => (
        slot.operation.cancelAndWait()
      ))).then((results) => {
        const failure = results.find(
          (result): result is PromiseRejectedResult => result.status === "rejected",
        );
        if (failure) throw failure.reason;
      });
      return factoryClosePromise;
    },
  });
  return factory;
}

type ProcessSlot = {
  readonly request: AcpAgentProcessOpenInput;
  readonly cleanupCredential: AcpCredentialLease;
  opened: Promise<AcpAgentProcessLease>;
  operation: AcpAgentProcessOpenOperation;
  lifecycle?: ProcessLifecycle;
  earlyProcessCleanup?: Promise<boolean>;
  cancelled: boolean;
  cancellationPromise?: Promise<AcpAgentProcessOpenCleanupObservation>;
  poisonedCode?: string;
};

type StartOptions = Readonly<{
  input: AcpAgentProcessOpenInput;
  cleanupCredential: AcpCredentialLease;
  spawn: AcpAgentSpawn;
  signalChild: (child: AcpAgentChildProcess, signal: NodeJS.Signals) => boolean;
  terminationGraceMs: number;
  killConfirmationMs: number;
  maxNdjsonFrameBytes: number;
  maxStderrBytes: number;
  credentialCleanupTimeoutMs: number;
  generationId: string;
  identityVault: HostPrivateBindingIdentityVault;
  onReleasable(): void;
  setLifecycle(lifecycle: ProcessLifecycle): void;
  setEarlyProcessCleanup(cleanup: Promise<boolean>): void;
  assertOpen(): void;
  poisonSlot(code: string): void;
}>;

type ProcessLifecycle = {
  readonly child: AcpAgentChildProcess;
  readonly generation: MutableProcessGeneration;
  readonly abort: AbortController;
  readonly frameGuard: NdjsonFrameGuard;
  readonly credential: AcpCredentialLease;
  client?: ManagedAcpV1Client;
  exitConfirmed: boolean;
  availability: "available" | "unavailable" | "closed";
  reason?: string;
  finalizePromise?: Promise<void>;
  credentialCleanupConfirmed: boolean;
  capabilityCleanupConfirmed: boolean;
  preparedReverseRpc?: AcpPreparedReverseRpc;
  isReleasable(): boolean;
  finalize(requestTermination: boolean, reason?: string): Promise<void>;
  waitClosed(timeoutMs: number): Promise<boolean>;
  closeObservation(): AcpAgentProcessCloseObservation;
};

function cancelProcessSlot(input: Readonly<{
  slot: ProcessSlot;
  bindingHandle: string;
  slots: Map<string, ProcessSlot>;
  credentialCleanupTimeoutMs: number;
}>): Promise<AcpAgentProcessOpenCleanupObservation> {
  if (input.slot.cancellationPromise) return input.slot.cancellationPromise;
  input.slot.cancelled = true;
  input.slot.cancellationPromise = (async () => {
    try {
      if (input.slot.lifecycle) {
        await input.slot.lifecycle.finalize(true, "acp_agent_process_open_cancelled");
        const observation = input.slot.lifecycle.closeObservation();
        const cleanup = Object.freeze({
          processCleanupConfirmed: observation.exitConfirmed,
          credentialCleanupConfirmed: observation.credentialCleanupConfirmed,
          capabilityCleanupConfirmed: observation.capabilityCleanupConfirmed,
        });
        if (!cleanup.processCleanupConfirmed
          || !cleanup.credentialCleanupConfirmed
          || !cleanup.capabilityCleanupConfirmed) {
          throw safeError("acp_agent_process_open_cleanup_unconfirmed");
        }
        return cleanup;
      }
      const processCleanupConfirmed = input.slot.earlyProcessCleanup
        ? await input.slot.earlyProcessCleanup
        : true;
      await revokeCredential(input.slot.cleanupCredential, input.credentialCleanupTimeoutMs);
      if (!processCleanupConfirmed) {
        throw safeError("acp_agent_process_open_cleanup_unconfirmed");
      }
      if (input.slots.get(input.bindingHandle) === input.slot) {
        input.slots.delete(input.bindingHandle);
      }
      return Object.freeze({
        processCleanupConfirmed,
        credentialCleanupConfirmed: true,
        capabilityCleanupConfirmed: true,
      });
    } catch {
      input.slot.poisonedCode = "acp_agent_process_open_cleanup_unconfirmed";
      throw safeError("acp_agent_process_open_cleanup_unconfirmed");
    }
  })();
  input.slot.cancellationPromise.catch(() => undefined);
  return input.slot.cancellationPromise;
}

function rejectedOpenOperation(
  cleanupCredential: AcpCredentialLease,
  error: unknown,
  timeoutMs: number,
): AcpAgentProcessOpenOperation {
  const cleanup = revokeCredential(cleanupCredential, timeoutMs);
  cleanup.catch(() => undefined);
  const lease = cleanup.then<never>(() => {
    if (error instanceof Error && "code" in error) throw error;
    throw safeError("acp_agent_process_start_failed");
  });
  lease.catch(() => undefined);
  return Object.freeze({
    lease,
    async cancelAndWait() {
      await cleanup;
      return Object.freeze({
        processCleanupConfirmed: true,
        credentialCleanupConfirmed: true,
        capabilityCleanupConfirmed: true,
      });
    },
  });
}

function rejectedOpenAlias(
  error: Error,
  cancelAndWait: () => Promise<AcpAgentProcessOpenCleanupObservation>,
): AcpAgentProcessOpenOperation {
  const lease = Promise.reject<AcpAgentProcessLease>(error);
  lease.catch(() => undefined);
  return Object.freeze({ lease, cancelAndWait });
}

async function startProcess(options: StartOptions): Promise<AcpAgentProcessLease> {
  const { input } = options;
  let credential = options.cleanupCredential;
  let child: AcpAgentChildProcess | undefined;
  let lifecycle: ProcessLifecycle | undefined;
  try {
    options.assertOpen();
    if (!input.resolution || typeof input.resolution.assertCurrent !== "function") {
      throw safeError("acp_agent_resolution_invalid");
    }
    if (typeof input.createConnection !== "function") {
      throw safeError("acp_agent_connection_factory_invalid");
    }
    credential = normalizeCredentialLease(input.credentialLease, options.cleanupCredential);
    const workspaceDirectory = normalizeWorkingDirectory(input.workspaceDirectory);
    await input.resolution.assertCurrent();
    options.assertOpen();
    const material = input.resolution.hostPrivateLaunchMaterial();
    if (material.trustState !== "trusted") throw safeError("acp_agent_resolution_untrusted");
    const environment = mergeEnvironment(material.environment, credential.environment);
    const cwd = workspaceDirectory ?? material.defaultWorkingDirectory;
    child = options.spawn(material.canonicalLauncherPath, material.launchArguments, Object.freeze({
      ...(cwd ? { cwd } : {}),
      env: environment,
      detached: true,
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"] as const,
    }));
    if (!isValidChild(child)) {
      const earlyProcessCleanup = terminateMalformedChild(
        child,
        options.signalChild,
        options.terminationGraceMs,
        options.killConfirmationMs,
      );
      options.setEarlyProcessCleanup(earlyProcessCleanup);
      const exitConfirmed = await earlyProcessCleanup;
      if (!exitConfirmed) {
        options.poisonSlot("acp_agent_process_exit_unconfirmed");
        throw safeError("acp_agent_process_exit_unconfirmed");
      }
      throw safeError("acp_agent_child_invalid");
    }
    const generation = new MutableProcessGeneration();
    const abort = new AbortController();
    const frameGuard = new NdjsonFrameGuard(options.maxNdjsonFrameBytes);
    child.stdout.pipe(frameGuard);
    lifecycle = createLifecycle({
      child,
      generation,
      abort,
      frameGuard,
      credential,
      signalChild: options.signalChild,
      terminationGraceMs: options.terminationGraceMs,
      killConfirmationMs: options.killConfirmationMs,
      credentialCleanupTimeoutMs: options.credentialCleanupTimeoutMs,
      safeBase: Object.freeze({
        profileRevisionId: input.resolution.profileRevisionId,
        providerFamily: input.resolution.providerFamily,
        acpAgentKind: input.resolution.acpAgentKind,
        bindingHandle: input.bindingHandle,
      }),
      onReleasable: options.onReleasable,
      onPoisoned: options.poisonSlot,
    });
    options.setLifecycle(lifecycle);
    options.assertOpen();
    guardStderr(child.stderr, options.maxStderrBytes, () => {
      void lifecycle!.finalize(true, "acp_agent_stderr_limit_exceeded").catch(() => undefined);
    });
    frameGuard.once("error", () => {
      void lifecycle!.finalize(true, "acp_agent_ndjson_frame_too_large").catch(() => undefined);
    });
    child.once("error", () => {
      void lifecycle!.finalize(true, "acp_agent_process_error").catch(() => undefined);
    });
    child.once("close", () => {
      lifecycle!.exitConfirmed = true;
      lifecycle!.generation.deactivate();
      lifecycle!.client?.invalidateGeneration();
      if (!lifecycle!.finalizePromise) {
        void lifecycle!.finalize(false, "acp_agent_process_exited").catch(() => undefined);
      }
    });

    const managedOptions = input.managedClientOptions ?? {};
    if (input.prepareReverseRpc && managedOptions.reverseRpcHandlers) {
      throw safeError("acp_agent_reverse_rpc_configuration_conflict");
    }
    if (input.prepareReverseRpc) {
      const prepared = input.prepareReverseRpc(generation);
      if (!prepared || !prepared.handlers || typeof prepared.close !== "function") {
        throw safeError("acp_agent_reverse_rpc_preparation_invalid");
      }
      lifecycle.preparedReverseRpc = prepared;
      lifecycle.capabilityCleanupConfirmed = false;
    }
    const rawConnect = input.createConnection({
      input: child.stdin,
      output: frameGuard,
      signal: abort.signal,
    });
    if (typeof rawConnect !== "function") throw safeError("acp_agent_connection_factory_invalid");
    const connect: AcpV1ConnectionFactory = (handlers) => {
      const connection = rawConnect(handlers);
      if (connection?.closed) {
        void connection.closed.then(
          () => lifecycle!.finalize(true, "acp_agent_connection_closed"),
          () => lifecycle!.finalize(true, "acp_agent_connection_closed"),
        ).catch(() => undefined);
      }
      return connection;
    };
    const client = createManagedAcpV1ClientWithHostPrivateIdentity({
      ...managedOptions,
      ...(lifecycle.preparedReverseRpc
        ? { reverseRpcHandlers: lifecycle.preparedReverseRpc.handlers }
        : {}),
      connect,
      generationId: options.generationId,
      identityVault: options.identityVault,
    });
    lifecycle.client = client;

    // Detect selected-entry and canonical artifact changes during spawn itself.
    await input.resolution.assertCurrent();
    options.assertOpen();
    generation.assertActive();

    const closed = lifecycleClosedPromise(lifecycle);
    const lease: AcpAgentProcessLease = Object.freeze({
      bindingHandle: input.bindingHandle,
      generation,
      client,
      closed,
      safeObservation: () => safeObservation(lifecycle!),
      async close() {
        await lifecycle!.finalize(true);
      },
    });
    return lease;
  } catch (error) {
    if (lifecycle) {
      await lifecycle.finalize(true, safeCodeFrom(error)).catch((cleanupError) => {
        throw cleanupError;
      });
    } else {
      await revokeCredential(credential, options.credentialCleanupTimeoutMs);
    }
    if (error instanceof Error && "code" in error) throw error;
    throw safeError("acp_agent_process_start_failed");
  }
}

function createLifecycle(input: Readonly<{
  child: AcpAgentChildProcess;
  generation: MutableProcessGeneration;
  abort: AbortController;
  frameGuard: NdjsonFrameGuard;
  credential: AcpCredentialLease;
  signalChild: (child: AcpAgentChildProcess, signal: NodeJS.Signals) => boolean;
  terminationGraceMs: number;
  killConfirmationMs: number;
  credentialCleanupTimeoutMs: number;
  safeBase: Omit<AcpAgentProcessSafeObservation, "availability" | "reason">;
  onReleasable(): void;
  onPoisoned(code: string): void;
}>): ProcessLifecycle {
  const exitWaiters = new Set<() => void>();
  let resolveClosed!: (value: AcpAgentProcessCloseObservation) => void;
  const closedObservation = new Promise<AcpAgentProcessCloseObservation>((resolve) => {
    resolveClosed = resolve;
  });
  let credentialCleanup: Promise<void> | undefined;
  const lifecycle = {
    child: input.child,
    generation: input.generation,
    abort: input.abort,
    frameGuard: input.frameGuard,
    credential: input.credential,
    exitConfirmed: false,
    availability: "available" as const,
    credentialCleanupConfirmed: false,
    capabilityCleanupConfirmed: true,
    isReleasable() {
      return lifecycle.exitConfirmed
        && lifecycle.credentialCleanupConfirmed
        && lifecycle.capabilityCleanupConfirmed;
    },
    waitClosed(timeoutMs: number) {
      if (lifecycle.exitConfirmed) return Promise.resolve(true);
      return new Promise<boolean>((resolve) => {
        let settled = false;
        const onClosed = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          exitWaiters.delete(onClosed);
          resolve(true);
        };
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          exitWaiters.delete(onClosed);
          resolve(lifecycle.exitConfirmed);
        }, timeoutMs);
        exitWaiters.add(onClosed);
      });
    },
    closeObservation(): AcpAgentProcessCloseObservation {
      return Object.freeze({
        exitConfirmed: lifecycle.exitConfirmed,
        credentialCleanupConfirmed: lifecycle.credentialCleanupConfirmed,
        capabilityCleanupConfirmed: lifecycle.capabilityCleanupConfirmed,
        observation: safeObservation(lifecycle),
      });
    },
    finalize(requestTermination: boolean, reason?: string) {
      if (reason && !lifecycle.reason) lifecycle.reason = safeCodeFrom(reason);
      if (lifecycle.finalizePromise) return lifecycle.finalizePromise;
      lifecycle.finalizePromise = (async () => {
        lifecycle.generation.deactivate();
        lifecycle.client?.invalidateGeneration();
        lifecycle.abort.abort();
        let capabilityCleanupFailed = false;
        if (lifecycle.preparedReverseRpc && !lifecycle.capabilityCleanupConfirmed) {
          try {
            await runBoundedCleanup(
              () => lifecycle.preparedReverseRpc!.close(),
              input.credentialCleanupTimeoutMs,
            );
            lifecycle.capabilityCleanupConfirmed = true;
          } catch {
            capabilityCleanupFailed = true;
            lifecycle.availability = "unavailable";
            lifecycle.reason = "acp_agent_reverse_rpc_cleanup_unconfirmed";
            input.onPoisoned(lifecycle.reason);
          }
        }
        if (requestTermination && !lifecycle.exitConfirmed) {
          safelySignal(input.signalChild, lifecycle.child, "SIGTERM");
          if (!await lifecycle.waitClosed(input.terminationGraceMs)) {
            safelySignal(input.signalChild, lifecycle.child, "SIGKILL");
            await lifecycle.waitClosed(input.killConfirmationMs);
          }
        }
        lifecycle.frameGuard.destroy();
        if (!credentialCleanup) {
          credentialCleanup = revokeCredential(
            input.credential,
            input.credentialCleanupTimeoutMs,
          );
        }
        try {
          await credentialCleanup;
          lifecycle.credentialCleanupConfirmed = true;
        } catch {
          lifecycle.availability = "unavailable";
          lifecycle.reason = "acp_agent_credential_cleanup_unconfirmed";
          input.onPoisoned(lifecycle.reason);
          resolveClosed(lifecycle.closeObservation());
          throw safeError("acp_agent_credential_cleanup_unconfirmed");
        }
        if (!lifecycle.exitConfirmed) {
          lifecycle.availability = "unavailable";
          lifecycle.reason = "acp_agent_process_exit_unconfirmed";
          input.onPoisoned(lifecycle.reason);
          resolveClosed(lifecycle.closeObservation());
          throw safeError("acp_agent_process_exit_unconfirmed");
        }
        if (capabilityCleanupFailed) {
          resolveClosed(lifecycle.closeObservation());
          throw safeError("acp_agent_reverse_rpc_cleanup_unconfirmed");
        }
        lifecycle.availability = lifecycle.reason ? "unavailable" : "closed";
        const observation = lifecycle.closeObservation();
        resolveClosed(observation);
        input.onReleasable();
      })();
      lifecycle.finalizePromise.catch(() => undefined);
      return lifecycle.finalizePromise;
    },
  } as ProcessLifecycle & { readonly closedObservation?: Promise<AcpAgentProcessCloseObservation> };

  input.child.once("close", () => {
    lifecycle.exitConfirmed = true;
    for (const waiter of exitWaiters) waiter();
    exitWaiters.clear();
  });
  Object.defineProperty(lifecycle, "closedObservation", {
    value: closedObservation,
    enumerable: false,
  });
  Object.defineProperty(lifecycle, "safeBase", {
    value: input.safeBase,
    enumerable: false,
  });
  return lifecycle;
}

function lifecycleClosedPromise(lifecycle: ProcessLifecycle): Promise<AcpAgentProcessCloseObservation> {
  return (lifecycle as ProcessLifecycle & {
    readonly closedObservation: Promise<AcpAgentProcessCloseObservation>;
  }).closedObservation;
}

class MutableProcessGeneration implements AcpProcessGeneration {
  #active = true;

  isActive(): boolean {
    return this.#active;
  }

  assertActive(): void {
    if (!this.#active) throw safeError("acp_agent_generation_inactive");
  }

  deactivate(): void {
    this.#active = false;
  }

  toJSON(): Readonly<{ active: boolean }> {
    return Object.freeze({ active: this.#active });
  }
}

class NdjsonFrameGuard extends Transform {
  readonly #maximum: number;
  #frameBytes = 0;

  constructor(maximum: number) {
    super({ readableHighWaterMark: Math.min(maximum, 64 * 1024) });
    this.#maximum = maximum;
  }

  override _transform(chunk: Buffer | string, encoding: BufferEncoding, callback: TransformCallback): void {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
    for (const byte of bytes) {
      if (byte === 0x0a) this.#frameBytes = 0;
      else {
        this.#frameBytes += 1;
        if (this.#frameBytes > this.#maximum) {
          callback(safeError("acp_agent_ndjson_frame_too_large"));
          return;
        }
      }
    }
    callback(null, bytes);
  }
}

function safeObservation(lifecycle: ProcessLifecycle): AcpAgentProcessSafeObservation {
  const safeBase = (lifecycle as ProcessLifecycle & {
    readonly safeBase?: Omit<AcpAgentProcessSafeObservation, "availability" | "reason">;
  }).safeBase;
  if (!safeBase) throw safeError("acp_agent_process_observation_unavailable");
  return Object.freeze({
    ...safeBase,
    availability: lifecycle.availability,
    ...(lifecycle.reason ? { reason: lifecycle.reason } : {}),
  });
}

function normalizeCredentialLease(
  value: AcpCredentialLease | undefined,
  cleanupCredential: AcpCredentialLease,
): AcpCredentialLease {
  if (!value) return Object.freeze({ environment: Object.freeze({}), revoke: cleanupCredential.revoke });
  if (!value.environment || typeof value.environment !== "object" || Array.isArray(value.environment)) {
    throw safeError("acp_agent_credential_environment_invalid");
  }
  if (typeof value.revoke !== "function") throw safeError("acp_agent_credential_revoke_invalid");
  const environment: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value.environment)) {
    if (!ENVIRONMENT_KEY.test(key) || typeof entry !== "string" || entry.includes("\0")) {
      throw safeError("acp_agent_credential_environment_invalid");
    }
    environment[key] = entry;
  }
  return Object.freeze({ environment: Object.freeze(environment), revoke: cleanupCredential.revoke });
}

function mergeEnvironment(
  base: Readonly<Record<string, string>>,
  credential: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(base)) result[key] = entry;
  for (const [key, entry] of Object.entries(credential)) {
    if (Object.hasOwn(result, key)) throw safeError("acp_agent_credential_environment_conflict");
    result[key] = entry;
  }
  return Object.freeze(result);
}

function normalizeWorkingDirectory(value?: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !path.isAbsolute(value) || value.includes("\0")) {
    throw safeError("acp_agent_working_directory_invalid");
  }
  return value;
}

function isValidChild(child: AcpAgentChildProcess): boolean {
  return Boolean(child && child.stdin && child.stdout && child.stderr
    && typeof child.once === "function" && typeof child.kill === "function");
}

function guardStderr(stream: Readable, maximum: number, onExceeded: () => void): void {
  let observed = 0;
  let exceeded = false;
  stream.on("data", (chunk: Buffer | string) => {
    if (exceeded) return;
    const bytes = Buffer.isBuffer(chunk) ? chunk.byteLength : Buffer.byteLength(chunk);
    observed += bytes;
    if (observed > maximum) {
      exceeded = true;
      stream.pause();
      onExceeded();
    }
  });
  stream.resume();
}

function cleanupLeaseFor(value?: AcpCredentialLease): AcpCredentialLease {
  if (!value) return Object.freeze({ environment: Object.freeze({}), revoke: async () => undefined });
  let revokePromise: Promise<void> | undefined;
  return Object.freeze({
    environment: Object.freeze({}),
    revoke() {
      revokePromise ??= typeof value.revoke === "function"
        ? Promise.resolve().then(() => value.revoke())
        : Promise.reject(safeError("acp_agent_credential_cleanup_unconfirmed"));
      revokePromise.catch(() => undefined);
      return revokePromise;
    },
  });
}

async function revokeCredential(credential: AcpCredentialLease, timeoutMs: number): Promise<void> {
  try {
    await runBoundedCleanup(() => credential.revoke(), timeoutMs);
  } catch {
    throw safeError("acp_agent_credential_cleanup_unconfirmed");
  }
}

async function runBoundedCleanup(action: () => Promise<void>, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cleanup = Promise.resolve().then(action);
  cleanup.catch(() => undefined);
  try {
    await Promise.race([
      cleanup,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(safeError("acp_agent_cleanup_timeout")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function terminateMalformedChild(
  value: unknown,
  signalChild: (child: AcpAgentChildProcess, signal: NodeJS.Signals) => boolean,
  terminationGraceMs: number,
  killConfirmationMs: number,
): Promise<boolean> {
  if (!value || typeof value !== "object") return false;
  const child = value as Partial<AcpAgentChildProcess>;
  if (typeof child.once !== "function" || typeof child.kill !== "function") return false;
  let closed = false;
  child.once("close", () => { closed = true; });
  safelySignal(signalChild, child as AcpAgentChildProcess, "SIGTERM");
  if (await waitFor(() => closed, terminationGraceMs)) return true;
  safelySignal(signalChild, child as AcpAgentChildProcess, "SIGKILL");
  return waitFor(() => closed, killConfirmationMs);
}

function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  if (predicate()) return Promise.resolve(true);
  return new Promise((resolve) => {
    const started = Date.now();
    const poll = () => {
      if (predicate()) resolve(true);
      else if (Date.now() - started >= timeoutMs) resolve(predicate());
      else setTimeout(poll, Math.min(5, timeoutMs));
    };
    setTimeout(poll, Math.min(5, timeoutMs));
  });
}

function safelySignal(
  signalChild: (child: AcpAgentChildProcess, signal: NodeJS.Signals) => boolean,
  child: AcpAgentChildProcess,
  signal: NodeJS.Signals,
): void {
  try {
    signalChild(child, signal);
  } catch {
    // The bounded exit wait determines the safe result.
  }
}

function signalProcessTree(child: AcpAgentChildProcess, signal: NodeJS.Signals): boolean {
  if (process.platform !== "win32" && Number.isSafeInteger(child.pid) && (child.pid ?? 0) > 1) {
    try {
      process.kill(-(child.pid!), signal);
      return true;
    } catch {
      // Fall back to the exact process if the process group is already gone.
    }
  }
  return child.kill(signal);
}

function spawnNodeChild(
  command: string,
  arguments_: readonly string[],
  options: AcpAgentSpawnOptions,
): AcpAgentChildProcess {
  const child = nodeSpawn(command, [...arguments_], {
    ...(options.cwd ? { cwd: options.cwd } : {}),
    env: { ...options.env },
    detached: true,
    shell: false,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (!child.stdin || !child.stdout || !child.stderr) throw safeError("acp_agent_child_stdio_missing");
  return child as unknown as AcpAgentChildProcess;
}

function boundedInteger(value: number, minimum: number, maximum: number, code: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw safeError(code);
  return value;
}

function requiredOpaqueId(value: unknown, code: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 256 || /[\\/\s\0]/u.test(value)) {
    throw safeError(code);
  }
  return value;
}

function safeCodeFrom(value: unknown): string {
  if (typeof value === "string" && /^[a-z][a-z0-9_-]{0,159}$/u.test(value)) return value;
  if (value instanceof Error && "code" in value
    && typeof (value as { code?: unknown }).code === "string"
    && /^[a-z][a-z0-9_-]{0,159}$/u.test((value as { code: string }).code)) {
    return (value as { code: string }).code;
  }
  return "acp_agent_process_failed";
}

function safeError(code: string): AcpAgentProcessError {
  return new AcpAgentProcessError(code);
}

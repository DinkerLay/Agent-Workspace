import { randomUUID } from "node:crypto";
import path from "node:path";
import type { AcpV1ReverseRpcHandlers } from "@agent-workspace/provider-acp";

const OPAQUE_ID = /^[A-Za-z][A-Za-z0-9_-]{1,255}$/u;
const ENVIRONMENT_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u;
const MAX_TEXT_BYTES = 1024 * 1024;

export interface AcpReverseRpcGenerationFence {
  isActive(): boolean;
}

export type AcpWorkspaceReverseRpcCapability = Readonly<{
  readonly workspaceId: string;
  readonly workspaceRoot: string;
  readTextFile(input: Readonly<{
    readonly attemptId: string;
    readonly workspaceId: string;
    readonly workspaceRelativePath: string;
    readonly line?: number;
    readonly limit?: number;
  }>): Promise<unknown>;
  writeTextFile(input: Readonly<{
    readonly attemptId: string;
    readonly workspaceId: string;
    readonly workspaceRelativePath: string;
    readonly content: string;
  }>): Promise<unknown>;
}>;

export type AcpMcpReverseRpcCapability = Readonly<{
  readonly leaseId: string;
  readonly allowedServerNames: readonly string[];
  dispatch(input: Readonly<{
    readonly attemptId: string;
    readonly serverName: string;
    readonly method: string;
    readonly params: unknown;
  }>): Promise<unknown>;
}>;

export type AcpTerminalReverseRpcCapability = Readonly<{
  readonly leaseId: string;
  create(input: Readonly<{
    readonly attemptId: string;
    readonly command: string;
    readonly args: readonly string[];
    readonly cwdRelativePath?: string;
    readonly environment: Readonly<Record<string, string>>;
  }>): Promise<Readonly<{ readonly terminalHandle: string }>>;
  output(input: Readonly<{
    readonly attemptId: string;
    readonly terminalHandle: string;
  }>): Promise<unknown>;
  waitForExit(input: Readonly<{
    readonly attemptId: string;
    readonly terminalHandle: string;
  }>): Promise<unknown>;
  kill(input: Readonly<{
    readonly attemptId: string;
    readonly terminalHandle: string;
  }>): Promise<void>;
  release(input: Readonly<{
    readonly attemptId: string;
    readonly terminalHandle: string;
  }>): Promise<void>;
}>;

export type AcpReverseRpcRegistration = Readonly<{
  readonly bindingHandle: string;
  readonly generation: AcpReverseRpcGenerationFence;
  readonly workspace?: AcpWorkspaceReverseRpcCapability;
  readonly mcp?: AcpMcpReverseRpcCapability;
  readonly terminal?: AcpTerminalReverseRpcCapability;
}>;

export type AcpReverseRpcSafeObservation = Readonly<{
  readonly bindingHandle: string;
  readonly availability: "active" | "unavailable" | "closed";
  readonly capabilities: Readonly<{
    readonly filesystem: boolean;
    readonly mcp: boolean;
    readonly terminal: boolean;
    readonly interaction: true;
  }>;
}>;

export type AcpReverseRpcLease = Readonly<{
  readonly bindingHandle: string;
  activateAttempt(input: Readonly<{
    readonly attemptId: string;
    readonly mcpLeaseId?: string;
    readonly terminalLeaseId?: string;
    readonly interactionRevision: number;
  }>): void;
  deactivateAttempt(): Promise<void>;
  reverseRpcHandlers(): AcpV1ReverseRpcHandlers;
  dispatchMcp(input: Readonly<{
    readonly attemptId: string;
    readonly leaseId: string;
    readonly serverName: string;
    readonly method: string;
    readonly params: unknown;
  }>): Promise<unknown>;
  registerInteraction(input: Readonly<{
    readonly attemptId: string;
    readonly interactionId: string;
    readonly choiceIds: readonly string[];
    readonly revision: number;
  }>): void;
  consumeInteraction(input: Readonly<{
    readonly attemptId: string;
    readonly interactionId: string;
    readonly choiceId: string;
    readonly revision: number;
  }>): Readonly<{ readonly interactionId: string; readonly choiceId: string }>;
  safeObservation(): AcpReverseRpcSafeObservation;
  close(): Promise<void>;
}>;

export type AcpReverseRpcBroker = Readonly<{
  register(input: AcpReverseRpcRegistration): AcpReverseRpcLease;
  close(): Promise<void>;
}>;

export class AcpReverseRpcError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "AcpReverseRpcError";
    this.code = code;
  }
}

type ActiveAttempt = Readonly<{
  attemptId: string;
  mcpLeaseId?: string;
  terminalLeaseId?: string;
  interactionRevision: number;
}>;

type PendingInteraction = Readonly<{
  attemptId: string;
  choiceIds: ReadonlySet<string>;
  revision: number;
}>;

type PrivateTerminal = {
  readonly attemptId: string;
  readonly terminalHandle: string;
  terminalId?: string;
  releasePromise?: Promise<void>;
};

type BrokerState = {
  readonly registration: AcpReverseRpcRegistration;
  readonly workspaceRoot?: string;
  readonly interactions: Map<string, PendingInteraction>;
  readonly terminals: Map<string, PrivateTerminal>;
  readonly trackedTerminals: Set<PrivateTerminal>;
  readonly terminalCreates: Set<Promise<void>>;
  readonly releasingTerminals: Set<string>;
  handlers: AcpV1ReverseRpcHandlers;
  readonly cleanupTimeoutMs: number;
  activeAttempt?: ActiveAttempt;
  cleanupUnconfirmed: boolean;
  terminalCleanupUnrecoverable: boolean;
  closed: boolean;
  closePromise?: Promise<void>;
};

export function createAcpReverseRpcBroker(options: Readonly<{
  readonly createPrivateId?: () => string;
  readonly cleanupTimeoutMs?: number;
}> = {}): AcpReverseRpcBroker {
  const createPrivateId = options.createPrivateId ?? (() => `acp_terminal_${randomUUID()}`);
  const cleanupTimeoutMs = boundedInteger(
    options.cleanupTimeoutMs ?? 1_000,
    1,
    120_000,
    "acp_reverse_rpc_cleanup_timeout_invalid",
  );
  const byBinding = new Map<string, BrokerState>();
  const byGeneration = new WeakMap<object, BrokerState>();
  let brokerClosed = false;
  let brokerClosePromise: Promise<void> | undefined;

  return Object.freeze({
    register(registration): AcpReverseRpcLease {
      if (brokerClosed) throw safeError("acp_reverse_rpc_broker_closed");
      validateRegistration(registration);
      if (!registration.generation.isActive()) {
        throw safeError("acp_reverse_rpc_generation_inactive");
      }
      if (byBinding.has(registration.bindingHandle)) {
        throw safeError("acp_reverse_rpc_binding_already_leased");
      }
      if (byGeneration.has(registration.generation as object)) {
        throw safeError("acp_reverse_rpc_generation_already_leased");
      }
      const state = {
        registration,
        ...(registration.workspace
          ? { workspaceRoot: normalizedRoot(registration.workspace.workspaceRoot) }
          : {}),
        interactions: new Map(),
        terminals: new Map(),
        trackedTerminals: new Set(),
        terminalCreates: new Set(),
        releasingTerminals: new Set(),
        handlers: Object.freeze({}),
        cleanupTimeoutMs,
        cleanupUnconfirmed: false,
        terminalCleanupUnrecoverable: false,
        closed: false,
      } as BrokerState;
      state.handlers = createHandlers(state, createPrivateId);
      byBinding.set(registration.bindingHandle, state);
      byGeneration.set(registration.generation as object, state);

      return Object.freeze({
        bindingHandle: registration.bindingHandle,
        activateAttempt(input) {
          assertStateActive(state);
          const next = normalizeAttempt(input);
          if (registration.mcp && next.mcpLeaseId !== registration.mcp.leaseId) {
            throw safeError("acp_reverse_rpc_mcp_lease_mismatch");
          }
          if (!registration.mcp && next.mcpLeaseId !== undefined) {
            throw safeError("acp_reverse_rpc_mcp_unavailable");
          }
          if (registration.terminal && next.terminalLeaseId !== registration.terminal.leaseId) {
            throw safeError("acp_reverse_rpc_terminal_lease_mismatch");
          }
          if (!registration.terminal && next.terminalLeaseId !== undefined) {
            throw safeError("acp_reverse_rpc_terminal_unavailable");
          }
          if (state.activeAttempt && !sameAttempt(state.activeAttempt, next)) {
            throw safeError("acp_reverse_rpc_attempt_already_active");
          }
          if (state.activeAttempt) return;
          state.activeAttempt = next;
        },
        async deactivateAttempt() {
          assertStateActive(state);
          state.activeAttempt = undefined;
          state.interactions.clear();
          try {
            await waitForTerminalCreates(state);
            await releaseTrackedTerminals(state);
            if (state.cleanupUnconfirmed) {
              throw safeError("acp_reverse_rpc_terminal_cleanup_unconfirmed");
            }
          } catch {
            poisonTerminalCleanup(state);
            throw safeError("acp_reverse_rpc_terminal_cleanup_unconfirmed");
          }
        },
        reverseRpcHandlers: () => state.handlers,
        dispatchMcp: (input) => dispatchMcp(state, input),
        registerInteraction(input) {
          const active = assertAttempt(state, input.attemptId);
          requiredOpaqueId(input.interactionId, "acp_reverse_rpc_interaction_id_invalid");
          if (!Array.isArray(input.choiceIds) || input.choiceIds.length === 0) {
            throw safeError("acp_reverse_rpc_interaction_choices_invalid");
          }
          const choiceIds = new Set(input.choiceIds.map((choiceId) => (
            requiredOpaqueId(choiceId, "acp_reverse_rpc_interaction_choice_invalid")
          )));
          if (choiceIds.size !== input.choiceIds.length) {
            throw safeError("acp_reverse_rpc_interaction_choices_invalid");
          }
          if (input.revision !== active.interactionRevision) {
            throw safeError("acp_reverse_rpc_interaction_revision_mismatch");
          }
          if (state.interactions.has(input.interactionId)) {
            throw safeError("acp_reverse_rpc_interaction_already_pending");
          }
          state.interactions.set(input.interactionId, Object.freeze({
            attemptId: active.attemptId,
            choiceIds,
            revision: input.revision,
          }));
        },
        consumeInteraction(input) {
          assertAttempt(state, input.attemptId);
          const pending = state.interactions.get(input.interactionId);
          if (!pending) throw safeError("acp_reverse_rpc_interaction_not_pending");
          if (pending.attemptId !== input.attemptId) throw safeError("acp_reverse_rpc_attempt_mismatch");
          if (pending.revision !== input.revision) {
            throw safeError("acp_reverse_rpc_interaction_revision_mismatch");
          }
          if (!pending.choiceIds.has(input.choiceId)) {
            throw safeError("acp_reverse_rpc_interaction_choice_mismatch");
          }
          state.interactions.delete(input.interactionId);
          return Object.freeze({
            interactionId: input.interactionId,
            choiceId: input.choiceId,
          });
        },
        safeObservation: () => safeObservation(state),
        close: () => closeState(state, byBinding, byGeneration),
      });
    },

    close() {
      if (brokerClosePromise) return brokerClosePromise;
      brokerClosed = true;
      brokerClosePromise = Promise.allSettled([...byBinding.values()].map((state) => (
        closeState(state, byBinding, byGeneration)
      ))).then((results) => {
        const failure = results.find(
          (result): result is PromiseRejectedResult => result.status === "rejected",
        );
        if (failure) throw failure.reason;
      }).catch((error) => {
        brokerClosePromise = undefined;
        throw error;
      });
      return brokerClosePromise;
    },
  });
}

function createHandlers(
  state: BrokerState,
  createPrivateId: () => string,
): AcpV1ReverseRpcHandlers {
  const workspace = state.registration.workspace;
  const terminal = state.registration.terminal;
  return Object.freeze({
    ...(workspace ? {
      readTextFile: async (params: unknown) => {
        const active = assertAttempt(state);
        const request = record(params, "acp_reverse_rpc_filesystem_request_invalid");
        const workspaceRelativePath = relativeWorkspacePath(state, request.path);
        const line = optionalNonNegativeInteger(request.line, "acp_reverse_rpc_filesystem_range_invalid");
        const limit = optionalNonNegativeInteger(request.limit, "acp_reverse_rpc_filesystem_range_invalid");
        return workspace.readTextFile({
          attemptId: active.attemptId,
          workspaceId: workspace.workspaceId,
          workspaceRelativePath,
          ...(line === undefined ? {} : { line }),
          ...(limit === undefined ? {} : { limit }),
        });
      },
      writeTextFile: async (params: unknown) => {
        const active = assertAttempt(state);
        const request = record(params, "acp_reverse_rpc_filesystem_request_invalid");
        const workspaceRelativePath = relativeWorkspacePath(state, request.path);
        if (typeof request.content !== "string" || Buffer.byteLength(request.content, "utf8") > MAX_TEXT_BYTES) {
          throw safeError("acp_reverse_rpc_filesystem_content_invalid");
        }
        return workspace.writeTextFile({
          attemptId: active.attemptId,
          workspaceId: workspace.workspaceId,
          workspaceRelativePath,
          content: request.content,
        });
      },
    } : {}),
    ...(terminal ? {
      createTerminal: (params: unknown) => trackTerminalCreate(
        state,
        createTerminal(state, terminal, createPrivateId, params),
      ),
      terminalOutput: async (params: unknown) => {
        const active = assertAttempt(state);
        const privateTerminal = terminalFor(state, params, active);
        return terminal.output({ attemptId: active.attemptId, terminalHandle: privateTerminal.terminalHandle });
      },
      waitForTerminalExit: async (params: unknown) => {
        const active = assertAttempt(state);
        const privateTerminal = terminalFor(state, params, active);
        return terminal.waitForExit({ attemptId: active.attemptId, terminalHandle: privateTerminal.terminalHandle });
      },
      killTerminal: async (params: unknown) => {
        const active = assertAttempt(state);
        const privateTerminal = terminalFor(state, params, active);
        await terminal.kill({ attemptId: active.attemptId, terminalHandle: privateTerminal.terminalHandle });
        return Object.freeze({});
      },
      releaseTerminal: async (params: unknown) => {
        const active = assertAttempt(state);
        const request = record(params, "acp_reverse_rpc_terminal_request_invalid");
        const terminalId = requiredOpaqueId(
          request.terminalId,
          "acp_reverse_rpc_private_terminal_id_invalid",
        );
        const privateTerminal = terminalForId(state, terminalId, active);
        if (state.releasingTerminals.has(terminalId)) {
          throw safeError("acp_reverse_rpc_terminal_release_in_progress");
        }
        state.releasingTerminals.add(terminalId);
        try {
          try {
            await releaseTrackedTerminal(state, privateTerminal);
          } catch {
            poisonTerminalCleanup(state);
            throw safeError("acp_reverse_rpc_terminal_release_failed");
          }
        } finally {
          state.releasingTerminals.delete(terminalId);
        }
        return Object.freeze({});
      },
    } : {}),
  });
}

function trackTerminalCreate<T>(state: BrokerState, creation: Promise<T>): Promise<T> {
  const completion = creation.then(() => undefined, () => undefined);
  state.terminalCreates.add(completion);
  completion.finally(() => state.terminalCreates.delete(completion)).catch(() => undefined);
  return creation;
}

async function createTerminal(
  state: BrokerState,
  terminal: AcpTerminalReverseRpcCapability,
  createPrivateId: () => string,
  params: unknown,
): Promise<Readonly<{ readonly terminalId: string }>> {
  const active = assertAttempt(state);
  assertTerminalLease(state, active);
  const request = record(params, "acp_reverse_rpc_terminal_request_invalid");
  const command = requiredText(request.command, "acp_reverse_rpc_terminal_command_invalid");
  const args = stringArray(request.args ?? [], "acp_reverse_rpc_terminal_arguments_invalid");
  const cwdRelativePath = request.cwd === undefined
    ? undefined
    : relativeWorkspacePath(state, request.cwd, true);
  const environment = environmentRecord(request.env ?? {});
  const created = await terminal.create({
    attemptId: active.attemptId,
    command,
    args,
    ...(cwdRelativePath === undefined ? {} : { cwdRelativePath }),
    environment,
  });
  const rawTerminalHandle = created?.terminalHandle;
  if (typeof rawTerminalHandle !== "string") {
    state.terminalCleanupUnrecoverable = true;
    poisonTerminalCleanup(state);
    throw safeError("acp_reverse_rpc_terminal_cleanup_unconfirmed");
  }
  const privateTerminal: PrivateTerminal = {
    attemptId: active.attemptId,
    terminalHandle: rawTerminalHandle,
  };
  // A Host-created terminal is cleanup-owned before any later validation can fail.
  state.trackedTerminals.add(privateTerminal);

  try {
    requiredOpaqueId(rawTerminalHandle, "acp_reverse_rpc_terminal_handle_invalid");
  } catch (error) {
    await releaseAfterCreateFailure(state, privateTerminal);
    throw error;
  }
  if (state.closed
    || state.cleanupUnconfirmed
    || !state.registration.generation.isActive()
    || state.activeAttempt !== active) {
    await releaseAfterCreateFailure(state, privateTerminal);
    throw safeError(state.closed
      ? "acp_reverse_rpc_lease_closed"
      : "acp_reverse_rpc_attempt_inactive");
  }
  let terminalId: string;
  try {
    terminalId = requiredOpaqueId(
      createPrivateId(),
      "acp_reverse_rpc_private_terminal_id_invalid",
    );
    if (state.terminals.has(terminalId)) {
      throw safeError("acp_reverse_rpc_private_terminal_id_duplicate");
    }
  } catch (error) {
    await releaseAfterCreateFailure(state, privateTerminal);
    if (error instanceof AcpReverseRpcError) throw error;
    throw safeError("acp_reverse_rpc_private_terminal_id_invalid");
  }
  privateTerminal.terminalId = terminalId;
  state.terminals.set(terminalId, privateTerminal);
  return Object.freeze({ terminalId });
}

async function releaseAfterCreateFailure(
  state: BrokerState,
  privateTerminal: PrivateTerminal,
): Promise<void> {
  try {
    await releaseTrackedTerminal(state, privateTerminal);
  } catch {
    poisonTerminalCleanup(state);
    throw safeError("acp_reverse_rpc_terminal_cleanup_unconfirmed");
  }
}

async function dispatchMcp(
  state: BrokerState,
  input: Readonly<{
    attemptId: string;
    leaseId: string;
    serverName: string;
    method: string;
    params: unknown;
  }>,
): Promise<unknown> {
  const active = assertAttempt(state, input.attemptId);
  const mcp = state.registration.mcp;
  if (!mcp) throw safeError("acp_reverse_rpc_mcp_unavailable");
  if (input.leaseId !== active.mcpLeaseId || input.leaseId !== mcp.leaseId) {
    throw safeError("acp_reverse_rpc_mcp_lease_mismatch");
  }
  if (!mcp.allowedServerNames.includes(input.serverName)) {
    throw safeError("acp_reverse_rpc_mcp_server_forbidden");
  }
  const method = requiredText(input.method, "acp_reverse_rpc_mcp_method_invalid");
  return mcp.dispatch({
    attemptId: active.attemptId,
    serverName: input.serverName,
    method,
    params: input.params,
  });
}

function validateRegistration(registration: AcpReverseRpcRegistration): void {
  requiredOpaqueId(registration?.bindingHandle, "acp_reverse_rpc_binding_handle_invalid");
  if (!registration.generation || typeof registration.generation.isActive !== "function") {
    throw safeError("acp_reverse_rpc_generation_invalid");
  }
  if (registration.workspace) {
    requiredOpaqueId(registration.workspace.workspaceId, "acp_reverse_rpc_workspace_id_invalid");
    normalizedRoot(registration.workspace.workspaceRoot);
    if (typeof registration.workspace.readTextFile !== "function"
      || typeof registration.workspace.writeTextFile !== "function") {
      throw safeError("acp_reverse_rpc_workspace_capability_invalid");
    }
  }
  if (registration.mcp) {
    requiredOpaqueId(registration.mcp.leaseId, "acp_reverse_rpc_mcp_lease_invalid");
    if (!Array.isArray(registration.mcp.allowedServerNames)
      || registration.mcp.allowedServerNames.length === 0
      || new Set(registration.mcp.allowedServerNames).size !== registration.mcp.allowedServerNames.length
      || registration.mcp.allowedServerNames.some((name) => !OPAQUE_ID.test(name))) {
      throw safeError("acp_reverse_rpc_mcp_servers_invalid");
    }
    if (typeof registration.mcp.dispatch !== "function") {
      throw safeError("acp_reverse_rpc_mcp_capability_invalid");
    }
  }
  if (registration.terminal) {
    requiredOpaqueId(registration.terminal.leaseId, "acp_reverse_rpc_terminal_lease_invalid");
    if ([
      registration.terminal.create,
      registration.terminal.output,
      registration.terminal.waitForExit,
      registration.terminal.kill,
      registration.terminal.release,
    ].some((handler) => typeof handler !== "function")) {
      throw safeError("acp_reverse_rpc_terminal_capability_invalid");
    }
  }
}

function normalizeAttempt(input: Readonly<{
  attemptId: string;
  mcpLeaseId?: string;
  terminalLeaseId?: string;
  interactionRevision: number;
}>): ActiveAttempt {
  const attemptId = requiredOpaqueId(input?.attemptId, "acp_reverse_rpc_attempt_id_invalid");
  if (!Number.isSafeInteger(input.interactionRevision) || input.interactionRevision < 1) {
    throw safeError("acp_reverse_rpc_interaction_revision_invalid");
  }
  return Object.freeze({
    attemptId,
    ...(input.mcpLeaseId
      ? { mcpLeaseId: requiredOpaqueId(input.mcpLeaseId, "acp_reverse_rpc_mcp_lease_invalid") }
      : {}),
    ...(input.terminalLeaseId
      ? { terminalLeaseId: requiredOpaqueId(input.terminalLeaseId, "acp_reverse_rpc_terminal_lease_invalid") }
      : {}),
    interactionRevision: input.interactionRevision,
  });
}

function assertStateActive(state: BrokerState): void {
  if (state.closed) throw safeError("acp_reverse_rpc_lease_closed");
  if (state.cleanupUnconfirmed) {
    throw safeError("acp_reverse_rpc_terminal_cleanup_unconfirmed");
  }
  if (!state.registration.generation.isActive()) {
    throw safeError("acp_reverse_rpc_generation_inactive");
  }
}

function assertAttempt(state: BrokerState, attemptId?: string): ActiveAttempt {
  assertStateActive(state);
  const active = state.activeAttempt;
  if (!active) throw safeError("acp_reverse_rpc_attempt_inactive");
  if (attemptId !== undefined && active.attemptId !== attemptId) {
    throw safeError("acp_reverse_rpc_attempt_mismatch");
  }
  return active;
}

function assertTerminalLease(state: BrokerState, active: ActiveAttempt): void {
  if (!state.registration.terminal) throw safeError("acp_reverse_rpc_terminal_unavailable");
  if (active.terminalLeaseId !== state.registration.terminal.leaseId) {
    throw safeError("acp_reverse_rpc_terminal_lease_mismatch");
  }
}

function terminalFor(
  state: BrokerState,
  params: unknown,
  active: ActiveAttempt,
): PrivateTerminal {
  const request = record(params, "acp_reverse_rpc_terminal_request_invalid");
  const terminalId = requiredOpaqueId(
    request.terminalId,
    "acp_reverse_rpc_private_terminal_id_invalid",
  );
  return terminalForId(state, terminalId, active);
}

function terminalForId(
  state: BrokerState,
  terminalId: string,
  active: ActiveAttempt,
): PrivateTerminal {
  assertTerminalLease(state, active);
  const privateTerminal = state.terminals.get(terminalId);
  if (!privateTerminal) throw safeError("acp_reverse_rpc_terminal_not_found");
  if (privateTerminal.attemptId !== active.attemptId) {
    throw safeError("acp_reverse_rpc_attempt_mismatch");
  }
  return privateTerminal;
}

function relativeWorkspacePath(state: BrokerState, value: unknown, allowRoot = false): string {
  const workspaceRoot = state.workspaceRoot;
  if (!workspaceRoot || !state.registration.workspace) {
    throw safeError("acp_reverse_rpc_workspace_unavailable");
  }
  if (typeof value !== "string" || !path.isAbsolute(value) || value.includes("\0")) {
    throw safeError("acp_reverse_rpc_workspace_path_invalid");
  }
  const normalized = path.resolve(value);
  const relative = path.relative(workspaceRoot, normalized);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw safeError("acp_reverse_rpc_workspace_crossing");
  }
  if (!allowRoot && (!relative || relative === ".")) {
    throw safeError("acp_reverse_rpc_workspace_path_invalid");
  }
  return relative && relative !== "." ? relative.split(path.sep).join("/") : ".";
}

function normalizedRoot(value: unknown): string {
  if (typeof value !== "string" || !path.isAbsolute(value) || value.includes("\0")) {
    throw safeError("acp_reverse_rpc_workspace_root_invalid");
  }
  return path.resolve(value);
}

async function waitForTerminalCreates(state: BrokerState): Promise<void> {
  while (state.terminalCreates.size > 0) {
    await Promise.all([...state.terminalCreates]);
  }
}

async function releaseTrackedTerminal(
  state: BrokerState,
  entry: PrivateTerminal,
): Promise<void> {
  const terminal = state.registration.terminal;
  if (!terminal) throw safeError("acp_reverse_rpc_terminal_cleanup_unconfirmed");
  if (!state.trackedTerminals.has(entry)) return;
  if (entry.releasePromise) return entry.releasePromise;
  const release = withTimeout(
    Promise.resolve().then(() => terminal.release({
      attemptId: entry.attemptId,
      terminalHandle: entry.terminalHandle,
    })),
    state.cleanupTimeoutMs,
  ).then(() => {
    state.trackedTerminals.delete(entry);
    if (entry.terminalId && state.terminals.get(entry.terminalId) === entry) {
      state.terminals.delete(entry.terminalId);
      state.releasingTerminals.delete(entry.terminalId);
    }
  }).catch(() => {
    entry.releasePromise = undefined;
    throw safeError("acp_reverse_rpc_terminal_cleanup_unconfirmed");
  });
  entry.releasePromise = release;
  release.catch(() => undefined);
  return release;
}

async function releaseTrackedTerminals(state: BrokerState): Promise<void> {
  const entries = [...state.trackedTerminals];
  if (entries.length > 0) {
    const results = await Promise.allSettled(entries.map((entry) => (
      releaseTrackedTerminal(state, entry)
    )));
    if (results.some((result) => result.status === "rejected")) {
      throw safeError("acp_reverse_rpc_terminal_cleanup_unconfirmed");
    }
  }
  if (state.terminalCleanupUnrecoverable) {
    throw safeError("acp_reverse_rpc_terminal_cleanup_unconfirmed");
  }
}

function poisonTerminalCleanup(state: BrokerState): void {
  state.activeAttempt = undefined;
  state.interactions.clear();
  state.cleanupUnconfirmed = true;
}

function closeState(
  state: BrokerState,
  byBinding: Map<string, BrokerState>,
  byGeneration: WeakMap<object, BrokerState>,
): Promise<void> {
  if (state.closePromise) return state.closePromise;
  state.closePromise = (async () => {
    state.closed = true;
    state.activeAttempt = undefined;
    state.interactions.clear();
    await waitForTerminalCreates(state);
    await releaseTrackedTerminals(state);
    state.cleanupUnconfirmed = false;
    byBinding.delete(state.registration.bindingHandle);
    byGeneration.delete(state.registration.generation as object);
  })().catch((error) => {
    state.cleanupUnconfirmed = true;
    state.closePromise = undefined;
    throw error;
  });
  return state.closePromise;
}

function safeObservation(state: BrokerState): AcpReverseRpcSafeObservation {
  return Object.freeze({
    bindingHandle: state.registration.bindingHandle,
    availability: state.cleanupUnconfirmed
      ? "unavailable"
      : state.closed
        ? "closed"
        : "active",
    capabilities: Object.freeze({
      filesystem: Boolean(state.registration.workspace),
      mcp: Boolean(state.registration.mcp),
      terminal: Boolean(state.registration.terminal),
      interaction: true,
    }),
  });
}

function sameAttempt(left: ActiveAttempt, right: ActiveAttempt): boolean {
  return left.attemptId === right.attemptId
    && left.mcpLeaseId === right.mcpLeaseId
    && left.terminalLeaseId === right.terminalLeaseId
    && left.interactionRevision === right.interactionRevision;
}

function record(value: unknown, code: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw safeError(code);
  return value as Record<string, unknown>;
}

function requiredText(value: unknown, code: string): string {
  if (typeof value !== "string" || !value.trim() || value.includes("\0") || value.length > 4096) {
    throw safeError(code);
  }
  return value;
}

function requiredOpaqueId(value: unknown, code: string): string {
  const text = requiredText(value, code);
  if (!OPAQUE_ID.test(text)) throw safeError(code);
  return text;
}

function stringArray(value: unknown, code: string): readonly string[] {
  if (!Array.isArray(value) || value.length > 64) throw safeError(code);
  return Object.freeze(value.map((entry) => requiredText(entry, code)));
}

function environmentRecord(value: unknown): Readonly<Record<string, string>> {
  const input = record(value, "acp_reverse_rpc_terminal_environment_invalid");
  const environment: Record<string, string> = {};
  for (const [key, entry] of Object.entries(input)) {
    if (!ENVIRONMENT_KEY.test(key) || typeof entry !== "string" || entry.includes("\0")) {
      throw safeError("acp_reverse_rpc_terminal_environment_invalid");
    }
    environment[key] = entry;
  }
  return Object.freeze(environment);
}

function optionalNonNegativeInteger(value: unknown, code: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw safeError(code);
  return value as number;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  promise.catch(() => undefined);
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(safeError("acp_reverse_rpc_terminal_cleanup_unconfirmed")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function boundedInteger(value: number, minimum: number, maximum: number, code: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw safeError(code);
  return value;
}

function safeError(code: string): AcpReverseRpcError {
  return new AcpReverseRpcError(code);
}

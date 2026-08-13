import { randomUUID } from "node:crypto";
import type { McpServer } from "@agentclientprotocol/sdk";
import {
  dispatchProviderScopedToolCall,
  normalizeProviderScopedToolRegistration,
  type ProviderNativeScopedToolCall,
  type ProviderScopedToolCall,
  type ProviderScopedToolCallResult,
  type ProviderScopedToolRegistration,
  type ProviderScopedToolTurnContext,
} from "@agent-workspace/provider-port";
import { CONDUCTOR_ORCHESTRATION_TOOL_DEFINITIONS } from "@agent-workspace/runtime-contracts";
import type {
  AcpReverseRpcLease,
  AcpReverseRpcRegistration,
} from "./acp-reverse-rpc-broker.js";
import {
  createProviderScopedMcpBridge,
  type ProviderScopedMcpBridge,
  type ProviderScopedMcpRoute,
} from "./provider-scoped-mcp-bridge.js";
import type { AcpTargetCheckpointObserver } from "./acp-provider-composition.js";
import { isAcpTaskRole, type AcpTaskRole } from "./acp-task-role.js";

const OPAQUE_ID = /^[A-Za-z][A-Za-z0-9_-]{1,255}$/u;

export type AcpTaskScopedMcpSafeObservation = Readonly<{
  readonly role: AcpTaskRole;
  readonly scopedTools: boolean;
  readonly toolCount: number;
}>;

export type AcpTaskScopedMcpBinding = Readonly<{
  readonly mcpServers: readonly McpServer[];
  waitForToolDiscovery(): Promise<void>;
  activateAttempt(input: Readonly<{
    readonly attemptId: string;
    readonly interactionRevision: number;
    readonly turnContext: ProviderScopedToolTurnContext;
    readonly checkpointObserver?: AcpTargetCheckpointObserver;
  }>): Promise<void>;
  observedToolCalls(): number;
  observedToolNames(): readonly string[];
  observedToolAttemptNames(): readonly string[];
  /** Revokes local HTTP authority synchronously before broker cleanup starts. */
  revokeAttempt(): Promise<void>;
  close(): Promise<void>;
}>;

export type AcpTaskScopedMcpRole = Readonly<{
  readonly role: AcpTaskRole;
  readonly registration?: ProviderScopedToolRegistration;
  createReverseRpcRegistration(): Omit<
    AcpReverseRpcRegistration,
    "bindingHandle" | "generation"
  > | undefined;
  openBindingRoute(input: Readonly<{
    readonly bindingHandle: string;
    readonly reverseRpcLease: AcpReverseRpcLease;
  }>): Promise<AcpTaskScopedMcpBinding>;
  safeObservation(): AcpTaskScopedMcpSafeObservation;
  close(): Promise<void>;
}>;

/** Shared Conductor-only MCP lifecycle used by ACP Agent integrations. */
export function createAcpTaskScopedMcpRole(options: Readonly<{
  readonly role: AcpTaskRole;
  readonly errorPrefix: "opencode_acp" | "codex_acp" | "claude_code_acp";
  readonly createError: (code: string) => Error;
  readonly ignoreRevokeError?: (error: unknown) => boolean;
  readonly bridge?: ProviderScopedMcpBridge;
  readonly serverName?: string;
  readonly mcpLeaseId?: string;
}>): AcpTaskScopedMcpRole {
  const safeError = (suffix: string): Error => options.createError(`${options.errorPrefix}_${suffix}`);
  if (!options || !isAcpTaskRole(options.role)) throw safeError("scoped_mcp_role_invalid");
  if (options.role !== "conductor") {
    if (options.serverName !== undefined || options.mcpLeaseId !== undefined) {
      throw safeError("role_tools_forbidden");
    }
    return Object.freeze({
      role: options.role,
      createReverseRpcRegistration: () => undefined,
      async openBindingRoute() {
        throw safeError("scoped_mcp_unavailable");
      },
      safeObservation: () => Object.freeze({
        role: options.role,
        scopedTools: false,
        toolCount: 0,
      }),
      close: async () => undefined,
    });
  }

  const role = options.role;
  const registration = canonicalRegistration();
  const serverName = opaqueId(
    options.serverName ?? `agent_workspace_${role}_${randomUUID().replaceAll("-", "")}`,
    () => safeError("scoped_mcp_server_invalid"),
  );
  const mcpLeaseId = opaqueId(
    options.mcpLeaseId ?? `mcp_lease_${randomUUID().replaceAll("-", "")}`,
    () => safeError("scoped_mcp_lease_invalid"),
  );
  const suppliedBridge = options.bridge;
  const bridge = suppliedBridge ?? createProviderScopedMcpBridge();
  let activeTurn: Readonly<{
    attemptId: string;
    bindingHandle: string;
    context: ProviderScopedToolTurnContext;
    checkpointObserver?: AcpTargetCheckpointObserver;
  }> | undefined;
  const observedToolNames: string[] = [];
  const observedToolAttemptNames: string[] = [];
  let binding: AcpTaskScopedMcpBinding | undefined;
  let closed = false;
  let closePromise: Promise<void> | undefined;

  const reverseRegistration = Object.freeze({
    mcp: Object.freeze({
      leaseId: mcpLeaseId,
      allowedServerNames: Object.freeze([serverName]),
      async dispatch(input: Readonly<{
        attemptId: string;
        serverName: string;
        method: string;
        params: unknown;
      }>): Promise<ProviderScopedToolCallResult> {
        if (input.method !== "tools/call") throw safeError("scoped_mcp_method_forbidden");
        const active = activeTurn;
        if (!active || active.attemptId !== input.attemptId) {
          throw safeError("scoped_mcp_attempt_inactive");
        }
        if (input.serverName !== serverName) throw safeError("scoped_mcp_server_forbidden");
        const call = nativeCall(input.params, safeError);
        const result = await dispatchProviderScopedToolCall({
          registration,
          turnContext: active.context,
          nativeCall: call,
        });
        observedToolNames.push(call.name);
        active.checkpointObserver?.observe({
          kind: "task_scoped_mcp_call",
          bindingHandle: active.bindingHandle,
          attemptId: active.attemptId,
          role,
          toolName: call.name,
        });
        return result;
      },
    }),
  });

  return Object.freeze({
    role,
    registration,
    createReverseRpcRegistration() {
      ensureOpen(closed, safeError);
      return reverseRegistration;
    },
    async openBindingRoute(input) {
      ensureOpen(closed, safeError);
      if (binding) throw safeError("scoped_mcp_route_already_open");
      if (!input?.reverseRpcLease || input.reverseRpcLease.bindingHandle !== input.bindingHandle) {
        throw safeError("scoped_mcp_binding_mismatch");
      }
      await bridge.listen();
      ensureOpen(closed, safeError);
      const route = bridge.registerRoute({ bindingId: input.bindingHandle, registration });
      const openedBinding = createBinding({
        route,
        reverseRpcLease: input.reverseRpcLease,
        registration,
        serverName,
        mcpLeaseId,
        safeError,
        ...(options.ignoreRevokeError ? { ignoreRevokeError: options.ignoreRevokeError } : {}),
        getActiveTurn: () => activeTurn,
        setActiveTurn: (next) => { activeTurn = next; },
        getObservedToolNames: () => Object.freeze([...observedToolNames]),
        getObservedToolAttemptNames: () => Object.freeze([...observedToolAttemptNames]),
        recordObservedToolAttempt: (name) => { observedToolAttemptNames.push(name); },
        onClosed: () => {
          if (binding === openedBinding) binding = undefined;
        },
      });
      binding = openedBinding;
      return openedBinding;
    },
    safeObservation: () => Object.freeze({
      role,
      scopedTools: true,
      toolCount: registration.tools.length,
    }),
    close() {
      closePromise ??= (async () => {
        closed = true;
        await binding?.close();
        if (!suppliedBridge) await bridge.close();
      })();
      return closePromise;
    },
  });
}

function createBinding(input: Readonly<{
  route: ProviderScopedMcpRoute;
  reverseRpcLease: AcpReverseRpcLease;
  registration: ProviderScopedToolRegistration;
  serverName: string;
  mcpLeaseId: string;
  safeError(suffix: string): Error;
  ignoreRevokeError?: (error: unknown) => boolean;
  getActiveTurn(): Readonly<{
    attemptId: string;
    bindingHandle: string;
    context: ProviderScopedToolTurnContext;
    checkpointObserver?: AcpTargetCheckpointObserver;
  }> | undefined;
  setActiveTurn(value: Readonly<{
    attemptId: string;
    bindingHandle: string;
    context: ProviderScopedToolTurnContext;
    checkpointObserver?: AcpTargetCheckpointObserver;
  }> | undefined): void;
  getObservedToolNames(): readonly string[];
  getObservedToolAttemptNames(): readonly string[];
  recordObservedToolAttempt(name: string): void;
  onClosed(): void;
}>): AcpTaskScopedMcpBinding {
  let closed = false;
  let revokePromise: Promise<void> | undefined;
  let closePromise: Promise<void> | undefined;
  const mcpServer = Object.freeze({
    type: "http" as const,
    name: input.serverName,
    url: input.route.url,
    headers: Object.freeze([]),
  }) as unknown as McpServer;

  const revoke = (): Promise<void> => {
    if (revokePromise) return revokePromise;
    input.setActiveTurn(undefined);
    try {
      input.route.deactivate();
    } catch (error) {
      if (!closed) throw error;
    }
    revokePromise = input.reverseRpcLease.deactivateAttempt()
      .catch((error) => {
        if (!input.ignoreRevokeError?.(error)) throw error;
      })
      .finally(() => {
        revokePromise = undefined;
      });
    return revokePromise;
  };

  return Object.freeze({
    mcpServers: Object.freeze([mcpServer]),
    waitForToolDiscovery: () => input.route.waitForToolDiscovery(),
    async activateAttempt(attempt) {
      if (closed) throw input.safeError("scoped_mcp_route_closed");
      if (revokePromise) throw input.safeError("scoped_mcp_revoke_in_progress");
      if (input.getActiveTurn()) throw input.safeError("scoped_mcp_attempt_already_active");
      if (!attempt?.turnContext || attempt.turnContext.capabilityClass !== input.registration.capabilityClass) {
        throw input.safeError("scoped_mcp_capability_mismatch");
      }
      if (typeof attempt.turnContext.handleCall !== "function") {
        throw input.safeError("scoped_mcp_turn_context_invalid");
      }
      input.reverseRpcLease.activateAttempt({
        attemptId: attempt.attemptId,
        mcpLeaseId: input.mcpLeaseId,
        interactionRevision: attempt.interactionRevision,
      });
      input.setActiveTurn(Object.freeze({
        attemptId: attempt.attemptId,
        bindingHandle: input.reverseRpcLease.bindingHandle,
        context: attempt.turnContext,
        ...(attempt.checkpointObserver
          ? { checkpointObserver: attempt.checkpointObserver }
          : {}),
      }));
      try {
        input.route.activate(Object.freeze({
          capabilityClass: input.registration.capabilityClass,
          lease: null,
          handleCall: async (call: ProviderScopedToolCall) => {
            input.recordObservedToolAttempt(call.name);
            const result = await input.reverseRpcLease.dispatchMcp({
              attemptId: attempt.attemptId,
              leaseId: input.mcpLeaseId,
              serverName: input.serverName,
              method: "tools/call",
              params: Object.freeze({
                providerCallId: call.providerCallId,
                name: call.name,
                arguments: call.arguments,
              }),
            });
            return scopedToolResult(result, call.providerCallId, input.safeError);
          },
        }));
      } catch (error) {
        input.setActiveTurn(undefined);
        await input.reverseRpcLease.deactivateAttempt();
        throw error;
      }
    },
    observedToolCalls: () => input.getObservedToolNames().length,
    observedToolNames: input.getObservedToolNames,
    observedToolAttemptNames: input.getObservedToolAttemptNames,
    revokeAttempt: revoke,
    close() {
      closePromise ??= (async () => {
        if (closed) return;
        try {
          if (input.getActiveTurn()) await revoke();
        } finally {
          closed = true;
          input.setActiveTurn(undefined);
          input.route.close();
          input.onClosed();
        }
      })();
      return closePromise;
    },
  });
}

function canonicalRegistration(): ProviderScopedToolRegistration {
  return normalizeProviderScopedToolRegistration(Object.freeze({
    capabilityClass: "runtime_orchestration",
    tools: CONDUCTOR_ORCHESTRATION_TOOL_DEFINITIONS,
  }));
}

function nativeCall(
  value: unknown,
  safeError: (suffix: string) => Error,
): ProviderNativeScopedToolCall {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw safeError("scoped_mcp_call_invalid");
  }
  const record = value as Record<string, unknown>;
  return Object.freeze({
    providerCallId: requiredText(record.providerCallId, () => safeError("scoped_mcp_call_id_invalid")),
    name: requiredText(record.name, () => safeError("scoped_mcp_tool_invalid")),
    arguments: record.arguments,
  });
}

function scopedToolResult(
  value: unknown,
  providerCallId: string,
  safeError: (suffix: string) => Error,
): ProviderScopedToolCallResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw safeError("scoped_mcp_result_invalid");
  }
  const result = value as Partial<ProviderScopedToolCallResult>;
  if (result.providerCallId !== providerCallId) {
    throw safeError("scoped_mcp_result_correlation_invalid");
  }
  return Object.freeze({ providerCallId, result: result.result });
}

function opaqueId(value: unknown, error: () => Error): string {
  if (typeof value !== "string" || !OPAQUE_ID.test(value)) throw error();
  return value;
}

function requiredText(value: unknown, error: () => Error): string {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) throw error();
  return value;
}

function ensureOpen(closed: boolean, safeError: (suffix: string) => Error): void {
  if (closed) throw safeError("scoped_mcp_closed");
}

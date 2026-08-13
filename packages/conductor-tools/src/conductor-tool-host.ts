import {
  CONDUCTOR_ORCHESTRATION_TOOL_DEFINITIONS,
  hashDefinition,
  parseConductorOrchestrationToolCall,
  type ConductorOrchestrationToolCall,
  type ConductorOrchestrationToolResult,
} from "../../runtime-contracts/src/index";

export type ConductorToolLeaseRole = "conductor" | "worker" | "meta" | "renderer";

/**
 * Trusted claims returned by the Host-owned lease verifier. The Provider only
 * carries the opaque lease value; it never gets to choose these scope fields.
 */
export interface VerifiedConductorToolLease {
  readonly role: ConductorToolLeaseRole;
  readonly taskId: string;
  readonly runId: string;
  readonly conductorSessionId: string;
  readonly conductorSessionTurnId: string;
  readonly taskRevision: number;
  readonly bindingRevision: number;
}

export type ConductorToolDefinition = typeof CONDUCTOR_ORCHESTRATION_TOOL_DEFINITIONS[number];

export interface ProviderConductorToolCall {
  readonly providerCallId: string;
  readonly name: ConductorOrchestrationToolCall["name"];
  readonly arguments: unknown;
  /** Opaque, short-lived Host capability carried through the Provider. */
  readonly lease: unknown;
}

export interface ProviderConductorToolResult {
  readonly providerCallId: string;
  readonly result: ConductorOrchestrationToolResult;
}

export interface ConductorToolDispatchScope {
  readonly taskId: string;
  readonly runId: string;
  readonly conductorSessionId: string;
  readonly conductorSessionTurnId: string;
  readonly taskRevision: number;
  readonly bindingRevision: number;
}

export type ConductorToolDispatchRequest = ConductorOrchestrationToolCall & Readonly<{
  readonly providerCallId: string;
  readonly commandId: string;
  readonly idempotencyKey: string;
  readonly scope: ConductorToolDispatchScope;
}>;

export interface ConductorToolHostOptions {
  /**
   * Verifies authenticity, expiry, Binding revision, active Run, and that the
   * bound Conductor Turn is still allowed to submit orchestration commands.
   */
  readonly verifyLease: (lease: unknown) => VerifiedConductorToolLease | Promise<VerifiedConductorToolLease>;
  /** The only business-command boundary reachable from this tool host. */
  readonly dispatch: (request: ConductorToolDispatchRequest) => ConductorOrchestrationToolResult | Promise<ConductorOrchestrationToolResult>;
}

export interface ConductorToolHost {
  listTools(): readonly ConductorToolDefinition[];
  handleProviderToolCall(call: ProviderConductorToolCall): Promise<ProviderConductorToolResult>;
}

type InFlightCall = Readonly<{
  fingerprint: string;
  result: Promise<ProviderConductorToolResult>;
}>;

/**
 * Creates the Host-side endpoint for the four Conductor orchestration tools.
 * Worker, Meta, Renderer, and generic RuntimeClient routes receive no lease and
 * cannot use this endpoint.
 */
export function createConductorToolHost(options: ConductorToolHostOptions): ConductorToolHost {
  if (!options || typeof options.verifyLease !== "function" || typeof options.dispatch !== "function") {
    throw new TypeError("conductor_tool_host_options_invalid");
  }

  const inFlight = new Map<string, InFlightCall>();

  return Object.freeze({
    listTools: () => CONDUCTOR_ORCHESTRATION_TOOL_DEFINITIONS,
    handleProviderToolCall: async (input: ProviderConductorToolCall): Promise<ProviderConductorToolResult> => {
      const providerCallId = requiredText(input?.providerCallId, "conductor_tool_provider_call_id_required");
      const verified = normalizeVerifiedLease(await options.verifyLease(input?.lease));
      if (verified.role !== "conductor") throw new Error("conductor_tool_role_forbidden");

      const parsed = parseConductorOrchestrationToolCall({
        name: input?.name,
        arguments: input?.arguments,
      });
      const scope = Object.freeze({
        taskId: verified.taskId,
        runId: verified.runId,
        conductorSessionId: verified.conductorSessionId,
        conductorSessionTurnId: verified.conductorSessionTurnId,
        taskRevision: verified.taskRevision,
        bindingRevision: verified.bindingRevision,
      });
      const correlationKey = [
        verified.conductorSessionId,
        verified.conductorSessionTurnId,
        providerCallId,
      ].join(":");
      const fingerprint = stableJson({ name: parsed.name, arguments: parsed.arguments });
      const existing = inFlight.get(correlationKey);
      if (existing) {
        if (existing.fingerprint !== fingerprint) throw new Error("conductor_tool_call_payload_conflict");
        return existing.result;
      }

      const internalIdentity = `command_conductor_tool_${hashDefinition(correlationKey).slice("fnv1a64:".length)}`;
      const request = Object.freeze({
        providerCallId,
        commandId: internalIdentity,
        idempotencyKey: internalIdentity,
        name: parsed.name,
        arguments: parsed.arguments,
        scope,
      }) as ConductorToolDispatchRequest;
      const result = Promise.resolve(options.dispatch(request)).then((dispatchResult) => Object.freeze({
        providerCallId,
        result: dispatchResult,
      }));
      inFlight.set(correlationKey, Object.freeze({ fingerprint, result }));
      try {
        return await result;
      } catch (error) {
        // A retry after an ambiguous Host failure must re-enter the durable
        // application idempotency boundary using the same internal identity.
        inFlight.delete(correlationKey);
        throw error;
      }
    },
  });
}

function normalizeVerifiedLease(value: VerifiedConductorToolLease): VerifiedConductorToolLease {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("conductor_tool_lease_invalid");
  const role = requiredText(value.role, "conductor_tool_lease_invalid");
  if (!(["conductor", "worker", "meta", "renderer"] as const).includes(role as ConductorToolLeaseRole)) {
    throw new Error("conductor_tool_role_forbidden");
  }
  const bindingRevision = value.bindingRevision;
  if (!Number.isSafeInteger(bindingRevision) || bindingRevision < 1) throw new Error("conductor_tool_lease_invalid");
  const taskRevision = value.taskRevision;
  if (!Number.isSafeInteger(taskRevision) || taskRevision < 1) throw new Error("conductor_tool_lease_invalid");
  return Object.freeze({
    role: role as ConductorToolLeaseRole,
    taskId: requiredText(value.taskId, "conductor_tool_lease_invalid"),
    runId: requiredText(value.runId, "conductor_tool_lease_invalid"),
    conductorSessionId: requiredText(value.conductorSessionId, "conductor_tool_lease_invalid"),
    conductorSessionTurnId: requiredText(value.conductorSessionTurnId, "conductor_tool_lease_invalid"),
    taskRevision,
    bindingRevision,
  });
}

function requiredText(value: unknown, code: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(code);
  return value;
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

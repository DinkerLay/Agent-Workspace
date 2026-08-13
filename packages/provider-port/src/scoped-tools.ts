export type ProviderScopedToolCapabilityClass = "runtime_orchestration";

/** Provider-neutral schema carried to a native dynamic-tool registration. */
export interface ProviderScopedToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
}

export interface ProviderScopedToolRegistration {
  readonly capabilityClass: ProviderScopedToolCapabilityClass;
  readonly tools: readonly ProviderScopedToolDefinition[];
}

/**
 * Turn-local Host endpoint. The lease is opaque to the adapter and model; the
 * adapter only reattaches it to a native call correlated with this Turn.
 */
export interface ProviderScopedToolTurnContext {
  readonly capabilityClass: ProviderScopedToolCapabilityClass;
  readonly lease: unknown;
  readonly handleCall: (call: ProviderScopedToolCall) => Promise<ProviderScopedToolCallResult>;
}

export interface ProviderNativeScopedToolCall {
  readonly providerCallId: string;
  readonly name: string;
  readonly arguments: unknown;
}

export interface ProviderScopedToolCall extends ProviderNativeScopedToolCall {
  readonly lease: unknown;
}

export interface ProviderScopedToolCallResult {
  readonly providerCallId: string;
  readonly result: unknown;
}

/**
 * Validates the adapter-facing boundary without interpreting tool arguments or
 * the Host lease. Business validation remains in the role-specific tool host.
 */
export function createProviderScopedToolCall(input: {
  readonly registration: ProviderScopedToolRegistration;
  readonly turnContext: ProviderScopedToolTurnContext;
  readonly nativeCall: ProviderNativeScopedToolCall;
}): ProviderScopedToolCall {
  const registration = normalizeProviderScopedToolRegistration(input.registration);
  if (registration.capabilityClass !== input.turnContext.capabilityClass) {
    throw new Error("provider_scoped_tool_capability_mismatch");
  }
  const providerCallId = requiredText(input.nativeCall?.providerCallId, "provider_scoped_tool_call_id_required");
  const name = requiredText(input.nativeCall?.name, "provider_scoped_tool_name_required");
  if (!registration.tools.some((tool) => tool.name === name)) throw new Error("provider_scoped_tool_not_registered");
  return Object.freeze({ providerCallId, name, arguments: input.nativeCall.arguments, lease: input.turnContext.lease });
}

export function normalizeProviderScopedToolRegistration(
  value: ProviderScopedToolRegistration,
): ProviderScopedToolRegistration {
  if (!value || value.capabilityClass !== "runtime_orchestration") {
    throw new Error("provider_scoped_tool_capability_invalid");
  }
  if (!Array.isArray(value.tools) || value.tools.length === 0) throw new Error("provider_scoped_tools_required");
  const names = new Set<string>();
  const tools = value.tools.map((tool) => {
    const name = requiredText(tool?.name, "provider_scoped_tool_name_required");
    if (names.has(name)) throw new Error("provider_scoped_tool_name_duplicate");
    names.add(name);
    if (!tool.inputSchema || typeof tool.inputSchema !== "object" || Array.isArray(tool.inputSchema)) {
      throw new Error("provider_scoped_tool_schema_invalid");
    }
    return Object.freeze({
      name,
      description: requiredText(tool.description, "provider_scoped_tool_description_required"),
      inputSchema: tool.inputSchema,
    });
  });
  return Object.freeze({ capabilityClass: value.capabilityClass, tools: Object.freeze(tools) });
}

export async function dispatchProviderScopedToolCall(input: {
  readonly registration: ProviderScopedToolRegistration;
  readonly turnContext: ProviderScopedToolTurnContext;
  readonly nativeCall: ProviderNativeScopedToolCall;
}): Promise<ProviderScopedToolCallResult> {
  const call = createProviderScopedToolCall(input);
  const result = await input.turnContext.handleCall(call);
  if (!result || result.providerCallId !== call.providerCallId) {
    throw new Error("provider_scoped_tool_result_correlation_invalid");
  }
  return Object.freeze({ providerCallId: result.providerCallId, result: result.result });
}

function requiredText(value: unknown, code: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(code);
  return value;
}

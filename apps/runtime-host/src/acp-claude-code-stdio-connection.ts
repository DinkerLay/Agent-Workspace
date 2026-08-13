import type {
  AcpV1ClientHandlers,
  AcpV1ConnectionFactory,
  InjectedAcpV1Connection,
} from "@agent-workspace/provider-acp";
import type { AcpStdioConnectionFactory } from "./acp-agent-process.js";
import { createOfficialAcpV1StdioConnection } from "./acp-sdk-stdio-connection.js";

export type ClaudeCodeAcpNativeToolsPolicy = "provider_default" | "disabled";

export class ClaudeCodeAcpStdioConnectionError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "ClaudeCodeAcpStdioConnectionError";
    this.code = code;
  }
}

/**
 * The official Claude ACP wrapper forwards `_meta.claudeCode.options` to the
 * Claude Agent SDK. Task sessions retain the provider's native Claude Code
 * tools; Meta explicitly disables them. Both modes disable ambient user/project
 * settings sources. Agent Workspace orchestration tools remain a separate,
 * role-scoped MCP registration in the ACP session request.
 */
export function createClaudeCodeAcpV1StdioConnection(
  options: Readonly<{ readonly nativeTools: ClaudeCodeAcpNativeToolsPolicy }>,
): AcpStdioConnectionFactory {
  const nativeTools = normalizeNativeToolsPolicy(options?.nativeTools);
  return (streams) => {
    const createOfficial = createOfficialAcpV1StdioConnection(streams);
    return (handlers: AcpV1ClientHandlers): InjectedAcpV1Connection => (
      wrapConnection(createOfficial(handlers), nativeTools)
    );
  };
}

function wrapConnection(
  connection: InjectedAcpV1Connection,
  nativeTools: ClaudeCodeAcpNativeToolsPolicy,
): InjectedAcpV1Connection {
  const sessionRequest = (params: unknown): unknown => (
    injectClaudeCodeAcpSessionOptions(params, nativeTools)
  );
  return Object.freeze({
    initialize: connection.initialize.bind(connection),
    newSession: (params: unknown) => connection.newSession(sessionRequest(params)),
    ...(connection.loadSession
      ? { loadSession: (params: unknown) => connection.loadSession!(sessionRequest(params)) }
      : {}),
    ...(connection.resumeSession
      ? { resumeSession: (params: unknown) => connection.resumeSession!(sessionRequest(params)) }
      : {}),
    ...(connection.setSessionConfigOption
      ? { setSessionConfigOption: connection.setSessionConfigOption.bind(connection) }
      : {}),
    ...(connection.setSessionMode
      ? { setSessionMode: connection.setSessionMode.bind(connection) }
      : {}),
    prompt: connection.prompt.bind(connection),
    cancel: connection.cancel.bind(connection),
    ...(connection.closeSession
      ? { closeSession: connection.closeSession.bind(connection) }
      : {}),
    ...(connection.closed ? { closed: connection.closed } : {}),
  });
}

export function injectClaudeCodeAcpSessionOptions(
  params: unknown,
  nativeToolsValue: ClaudeCodeAcpNativeToolsPolicy,
): Readonly<Record<string, unknown>> {
  const record = plainRecord(params, "claude_code_acp_session_request_invalid");
  if (Object.hasOwn(record, "_meta")) {
    throw safeError("claude_code_acp_session_meta_conflict");
  }
  const nativeTools = normalizeNativeToolsPolicy(nativeToolsValue);
  const claudeCodeOptions = Object.freeze({
    settingSources: Object.freeze([]),
    ...(nativeTools === "disabled" ? { tools: Object.freeze([]) } : {}),
  });
  return Object.freeze({
    ...record,
    _meta: Object.freeze({
      claudeCode: Object.freeze({
        options: claudeCodeOptions,
      }),
    }),
  });
}

function normalizeNativeToolsPolicy(value: unknown): ClaudeCodeAcpNativeToolsPolicy {
  if (value !== "provider_default" && value !== "disabled") {
    throw safeError("claude_code_acp_native_tools_policy_invalid");
  }
  return value;
}

function plainRecord(value: unknown, code: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) {
    throw safeError(code);
  }
  return value as Record<string, unknown>;
}

function safeError(code: string): ClaudeCodeAcpStdioConnectionError {
  return new ClaudeCodeAcpStdioConnectionError(code);
}

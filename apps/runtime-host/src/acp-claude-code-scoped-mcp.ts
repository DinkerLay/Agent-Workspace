import type { ProviderScopedMcpBridge } from "./provider-scoped-mcp-bridge.js";
import type { AcpTaskRole } from "./acp-task-role.js";
import {
  createAcpTaskScopedMcpRole,
  type AcpTaskScopedMcpBinding,
  type AcpTaskScopedMcpRole,
  type AcpTaskScopedMcpSafeObservation,
} from "./acp-task-scoped-mcp.js";

export type ClaudeCodeAcpTaskRole = AcpTaskRole;
export type ClaudeCodeAcpScopedMcpSafeObservation = AcpTaskScopedMcpSafeObservation;
export type ClaudeCodeAcpScopedMcpBinding = AcpTaskScopedMcpBinding;
export type ClaudeCodeAcpScopedMcpRole = AcpTaskScopedMcpRole;

export class ClaudeCodeAcpScopedMcpError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "ClaudeCodeAcpScopedMcpError";
    this.code = code;
  }
}

export function createClaudeCodeAcpScopedMcpRole(options: Readonly<{
  readonly role: ClaudeCodeAcpTaskRole;
  readonly bridge?: ProviderScopedMcpBridge;
  readonly serverName?: string;
  readonly mcpLeaseId?: string;
}>): ClaudeCodeAcpScopedMcpRole {
  if (!options) throw new ClaudeCodeAcpScopedMcpError("claude_code_acp_scoped_mcp_role_invalid");
  return createAcpTaskScopedMcpRole({
    ...options,
    errorPrefix: "claude_code_acp",
    createError: (code) => new ClaudeCodeAcpScopedMcpError(code),
  });
}

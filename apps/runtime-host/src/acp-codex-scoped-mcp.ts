import type { ProviderScopedMcpBridge } from "./provider-scoped-mcp-bridge.js";
import type { AcpTaskRole } from "./acp-task-role.js";
import {
  createAcpTaskScopedMcpRole,
  type AcpTaskScopedMcpBinding,
  type AcpTaskScopedMcpRole,
  type AcpTaskScopedMcpSafeObservation,
} from "./acp-task-scoped-mcp.js";

export type CodexAcpTaskRole = AcpTaskRole;
export type CodexAcpScopedMcpSafeObservation = AcpTaskScopedMcpSafeObservation;
export type CodexAcpScopedMcpBinding = AcpTaskScopedMcpBinding;
export type CodexAcpScopedMcpRole = AcpTaskScopedMcpRole;

export class CodexAcpScopedMcpError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "CodexAcpScopedMcpError";
    this.code = code;
  }
}

export function createCodexAcpScopedMcpRole(options: Readonly<{
  readonly role: CodexAcpTaskRole;
  readonly bridge?: ProviderScopedMcpBridge;
  readonly serverName?: string;
  readonly mcpLeaseId?: string;
}>): CodexAcpScopedMcpRole {
  if (!options) throw new CodexAcpScopedMcpError("codex_acp_scoped_mcp_role_invalid");
  return createAcpTaskScopedMcpRole({
    ...options,
    errorPrefix: "codex_acp",
    createError: (code) => new CodexAcpScopedMcpError(code),
  });
}

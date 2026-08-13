import { randomUUID } from "node:crypto";
import type { ProviderScopedMcpBridge } from "./provider-scoped-mcp-bridge.js";
import {
  createOpenCodeAcpTaskExecutionPolicy,
  type OpenCodeAcpTaskExecutionPolicy,
} from "./acp-opencode-resolution.js";
import type { AcpTaskRole } from "./acp-task-role.js";
import {
  createAcpTaskScopedMcpRole,
  type AcpTaskScopedMcpBinding,
  type AcpTaskScopedMcpRole,
  type AcpTaskScopedMcpSafeObservation,
} from "./acp-task-scoped-mcp.js";

export type OpenCodeAcpTaskRole = AcpTaskRole;
export type OpenCodeAcpScopedMcpSafeObservation = AcpTaskScopedMcpSafeObservation;
export type OpenCodeAcpScopedMcpBinding = AcpTaskScopedMcpBinding;
export type OpenCodeAcpScopedMcpRole = AcpTaskScopedMcpRole & Readonly<{
  readonly executionPolicy: OpenCodeAcpTaskExecutionPolicy;
}>;

export class OpenCodeAcpScopedMcpError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "OpenCodeAcpScopedMcpError";
    this.code = code;
  }
}

export function createOpenCodeAcpScopedMcpRole(options: Readonly<{
  readonly role: OpenCodeAcpTaskRole;
  readonly bridge?: ProviderScopedMcpBridge;
  readonly serverName?: string;
  readonly mcpLeaseId?: string;
}>): OpenCodeAcpScopedMcpRole {
  if (!options) throw new OpenCodeAcpScopedMcpError("opencode_acp_scoped_mcp_role_invalid");
  const serverName = options.role === "conductor"
    ? options.serverName ?? `agent_workspace_conductor_${randomUUID().replaceAll("-", "")}`
    : options.serverName;
  const core = createAcpTaskScopedMcpRole({
    ...options,
    ...(serverName ? { serverName } : {}),
    errorPrefix: "opencode_acp",
    createError: (code) => new OpenCodeAcpScopedMcpError(code),
    ignoreRevokeError(error) {
      const code = error && typeof error === "object" && "code" in error
        ? error.code
        : undefined;
      return code === "acp_reverse_rpc_lease_closed"
        || code === "acp_reverse_rpc_generation_inactive";
    },
  });
  let executionPolicy: OpenCodeAcpTaskExecutionPolicy;
  if (options.role === "conductor") {
    if (!serverName || !core.registration) {
      throw new OpenCodeAcpScopedMcpError("opencode_acp_scoped_mcp_registration_missing");
    }
    executionPolicy = createOpenCodeAcpTaskExecutionPolicy({
      role: options.role,
      scopedMcpServerName: serverName,
      scopedToolNames: core.registration.tools.map(({ name }) => name),
    });
  } else {
    executionPolicy = createOpenCodeAcpTaskExecutionPolicy({ role: options.role });
  }
  return Object.freeze({ ...core, executionPolicy });
}

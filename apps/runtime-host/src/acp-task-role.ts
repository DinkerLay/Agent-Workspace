export const ACP_TASK_ROLES = Object.freeze([
  "conductor",
  "publisher",
  "worker",
  "reviewer",
] as const);

export type AcpTaskRole = (typeof ACP_TASK_ROLES)[number];

export const ACP_CONDUCTOR_TOOL_NAMES = Object.freeze([
  "invoke_agent",
  "send_to_session",
  "interrupt_session",
  "close_session",
] as const);

export function isAcpTaskRole(value: unknown): value is AcpTaskRole {
  return typeof value === "string" && (ACP_TASK_ROLES as readonly string[]).includes(value);
}

export function acpTaskRoleToolNames(role: AcpTaskRole): readonly string[] {
  return role === "conductor" ? ACP_CONDUCTOR_TOOL_NAMES : Object.freeze([]);
}

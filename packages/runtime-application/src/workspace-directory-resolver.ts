import type { WorkspaceAuthorizationRecord, WorkspaceReference } from "@agent-workspace/runtime-contracts";

/**
 * Host-owned filesystem boundary. The application can ask for canonical
 * directory facts, but it never imports Node filesystem APIs itself.
 */
export interface WorkspaceDirectoryResolver {
  readonly canonicalizeDirectory: (directory: string) => Promise<CanonicalWorkspaceDirectory>;
}

export interface CanonicalWorkspaceDirectory {
  readonly canonicalDirectory: string;
  readonly defaultDisplayName: string;
}

/**
 * Re-resolve the persisted directory immediately before freezing a Task
 * snapshot. A changed symlink or missing directory must not silently become a
 * different workspace.
 */
export async function resolveAuthorizedWorkspace(
  resolver: WorkspaceDirectoryResolver,
  authorization: WorkspaceAuthorizationRecord,
): Promise<WorkspaceReference> {
  const resolved = await resolver.canonicalizeDirectory(authorization.canonicalDirectory);
  if (resolved.canonicalDirectory !== authorization.canonicalDirectory) {
    throw new Error("workspace_authorization_stale");
  }
  return {
    workspaceId: authorization.workspaceId,
    cwd: authorization.canonicalDirectory,
    displayName: authorization.displayName,
  };
}

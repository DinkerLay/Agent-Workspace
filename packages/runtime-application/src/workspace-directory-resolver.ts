import {
  type WorkspaceAuthorizationRecord,
  type WorkspaceReference,
  type WorkspaceReferenceV3,
} from "@agent-workspace/runtime-contracts";

/**
 * Host-owned filesystem boundary. The application can ask for canonical
 * directory facts, but it never imports Node filesystem APIs itself.
 */
export interface WorkspaceDirectoryResolver {
  readonly canonicalizeDirectory: (directory: string) => Promise<CanonicalWorkspaceDirectory>;
  readonly digestGrant: (grant: WorkspaceGrantSealInput) => string;
}

export interface WorkspaceGrantSealInput {
  readonly schemaVersion: 1;
  readonly workspaceId: WorkspaceAuthorizationRecord["workspaceId"];
  readonly canonicalDirectory: string;
  readonly authorizedAt: WorkspaceAuthorizationRecord["authorizedAt"];
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

/**
 * ACP-era Task snapshots retain only an opaque grant digest. The Host still
 * revalidates the canonical directory immediately before freezing the
 * snapshot, but the absolute directory never crosses this return boundary.
 */
export async function resolveAuthorizedWorkspaceV3(
  resolver: WorkspaceDirectoryResolver,
  authorization: WorkspaceAuthorizationRecord,
): Promise<WorkspaceReferenceV3> {
  const resolved = await resolver.canonicalizeDirectory(authorization.canonicalDirectory);
  if (resolved.canonicalDirectory !== authorization.canonicalDirectory) {
    throw new Error("workspace_authorization_stale");
  }
  const grantDigest = resolver.digestGrant(Object.freeze({
    schemaVersion: 1,
    workspaceId: authorization.workspaceId,
    canonicalDirectory: authorization.canonicalDirectory,
    authorizedAt: authorization.authorizedAt,
  }));
  if (!/^sha256:[a-f0-9]{64}$/u.test(grantDigest)) {
    throw new Error("workspace_grant_digest_invalid");
  }
  return Object.freeze({
    workspaceId: authorization.workspaceId,
    grantDigest,
  });
}

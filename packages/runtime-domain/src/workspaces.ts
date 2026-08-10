import type { WorkspaceAuthorizationRecord, WorkspaceId } from "@agent-workspace/runtime-contracts";
import { invariant } from "./errors";

/** Creates the durable Host-private authority record after native resolution. */
export function createWorkspaceAuthorization(input: {
  readonly workspaceId: WorkspaceId;
  readonly canonicalDirectory: string;
  readonly displayName: string;
  readonly now: string;
}): WorkspaceAuthorizationRecord {
  invariant(input.workspaceId.startsWith("workspace_"), "workspace_id_invalid");
  invariant(Boolean(input.canonicalDirectory.trim()), "workspace_canonical_directory_required");
  invariant(Boolean(input.displayName.trim()), "workspace_display_name_required");
  return {
    workspaceId: input.workspaceId,
    canonicalDirectory: input.canonicalDirectory,
    displayName: input.displayName.trim(),
    authorizedAt: input.now,
  };
}

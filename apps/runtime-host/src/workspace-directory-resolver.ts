import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { WorkspaceDirectoryResolver } from "@agent-workspace/runtime-application";

/**
 * The only local-filesystem implementation used by Runtime Host composition.
 * A Renderer may nominate a directory only through `workspace.authorize`; it
 * cannot turn that string into a Task cwd itself.
 */
export function createNodeWorkspaceDirectoryResolver(): WorkspaceDirectoryResolver {
  return {
    digestGrant(grant) {
      return `sha256:${createHash("sha256").update(JSON.stringify(grant)).digest("hex")}`;
    },
    async canonicalizeDirectory(directory) {
      if (typeof directory !== "string" || !directory.trim()) {
        throw new Error("workspace_directory_required");
      }
      if (!path.isAbsolute(directory)) throw new Error("workspace_directory_absolute_required");
      let canonicalDirectory: string;
      try {
        canonicalDirectory = await realpath(directory);
      } catch {
        throw new Error("workspace_directory_not_found");
      }
      let metadata: Awaited<ReturnType<typeof stat>>;
      try {
        metadata = await stat(canonicalDirectory);
      } catch {
        throw new Error("workspace_directory_not_found");
      }
      if (!metadata.isDirectory()) throw new Error("workspace_directory_not_directory");
      return {
        canonicalDirectory,
        defaultDisplayName: path.basename(canonicalDirectory) || canonicalDirectory,
      };
    },
  };
}

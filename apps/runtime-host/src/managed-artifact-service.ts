import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import type {
  ArtifactPreviewReadModel,
  ArtifactReference,
  TaskArchitectureSnapshot,
  TaskPermanentDeletePreview,
} from "@agent-workspace/runtime-contracts";
import type { ManagedArtifactDeleteOutcome, ManagedArtifactPort } from "@agent-workspace/runtime-application";

/** Bounded renderer payload; larger valid files remain registered but are not read into the bridge. */
export const MAX_ARTIFACT_PREVIEW_BYTES = 1_024 * 1_024;

/**
 * Node does not expose a portable dirfd + unlinkat primitive. Path-based
 * unlink would leave a parent-directory symlink race after verification, so
 * production deletion remains explicitly unavailable until Host composition
 * supplies an atomic beneath-directory implementation.
 */
export const MANAGED_ARTIFACT_PHYSICAL_DELETE_AVAILABLE = false;

/**
 * The only Node filesystem implementation of the managed Artifact port.
 * All callers supply durable Artifact records from the Store, never paths
 * received from a renderer. Each access re-resolves a canonical file below the
 * frozen Task workspace and verifies its recorded digest.
 */
export class NodeManagedArtifactService implements ManagedArtifactPort {
  async verifyArtifact(input: Parameters<ManagedArtifactPort["verifyArtifact"]>[0]): Promise<ArtifactReference> {
    const workspaceRelativePath = normalizeWorkspaceRelativePath(input.workspaceRelativePath);
    const resolved = await resolveWorkspaceArtifact(input.architecture.workspace.cwd, workspaceRelativePath);
    return {
      artifactId: input.artifactId,
      taskId: input.architecture.taskId,
      runId: input.runId,
      workspaceRelativePath,
      contentDigest: await digestWorkspaceFile(resolved.canonicalPath),
      sourceInvocationId: input.sourceInvocationId,
      sourceMessageId: input.sourceMessageId,
      ...(input.sourceProviderFactId ? { sourceProviderFactId: input.sourceProviderFactId } : {}),
      evidenceReferenceIds: [...input.evidenceReferenceIds],
      verifiedAt: input.verifiedAt,
    };
  }

  async previewArtifact(input: {
    readonly architecture: TaskArchitectureSnapshot;
    readonly artifact: ArtifactReference;
  }): Promise<ArtifactPreviewReadModel> {
    const inspection = await inspectArtifact(input.architecture.workspace.cwd, input.artifact);
    const base = {
      artifactId: input.artifact.artifactId,
      taskId: input.artifact.taskId,
      displayName: artifactDisplayName(input.artifact.workspaceRelativePath),
      ...(inspection.byteLength === undefined ? {} : { byteLength: inspection.byteLength }),
    };
    if (inspection.state !== "available" && inspection.state !== "too_large") {
      return { ...base, state: inspection.state };
    }
    if (inspection.state === "too_large") return { ...base, state: "too_large" };
    if (!inspection.canonicalPath) return { ...base, state: "unsupported" };
    try {
      const bytes = await readFile(inspection.canonicalPath);
      // A change after the streaming digest is a distinct safe fact; do not
      // leak the replacement content into a preview.
      if (digestBytes(bytes) !== input.artifact.contentDigest) return { ...base, state: "changed" };
      if (isBinary(bytes)) return { ...base, state: "unsupported" };
      return {
        ...base,
        state: "available",
        contentType: artifactContentType(input.artifact.workspaceRelativePath),
        content: bytes.toString("utf8"),
      };
    } catch (error) {
      return { ...base, state: mapFileError(error) };
    }
  }

  async previewPermanentDelete(input: {
    readonly architecture: TaskArchitectureSnapshot;
    readonly taskId: string;
    readonly expectedRevision: number;
    readonly artifacts: readonly ArtifactReference[];
  }): Promise<TaskPermanentDeletePreview> {
    const artifacts = input.artifacts.map((artifact) => ({
      artifactId: artifact.artifactId,
      displayName: artifactDisplayName(artifact.workspaceRelativePath),
      state: "unsupported" as const,
    }));
    return { taskId: input.taskId, expectedRevision: input.expectedRevision, artifacts };
  }

  async deleteArtifacts(input: {
    readonly commandId: string;
    readonly architecture: TaskArchitectureSnapshot;
    readonly artifacts: readonly ArtifactReference[];
  }): Promise<ManagedArtifactDeleteOutcome> {
    return {
      deletedArtifactIds: [],
      skippedArtifacts: input.artifacts.map((artifact) => ({ artifactId: artifact.artifactId, reason: "unsupported" as const })),
    };
  }
}

type ArtifactInspection = {
  readonly state: "available" | "missing" | "changed" | "too_large" | "unsupported";
  readonly canonicalPath?: string;
  readonly byteLength?: number;
};

/** Also used by verification so symlinked paths cannot enter the managed registry. */
export async function resolveWorkspaceArtifact(cwd: string, workspaceRelativePath: string): Promise<{
  readonly canonicalPath: string;
  readonly byteLength: number;
}> {
  const normalized = normalizeWorkspaceRelativePath(workspaceRelativePath);
  const canonicalRoot = await realpath(cwd);
  const candidate = path.resolve(canonicalRoot, normalized);
  if (!isInside(canonicalRoot, candidate)) throw new Error("artifact_path_escapes_workspace");
  const metadata = await lstat(candidate);
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error("artifact_target_not_regular_file");
  const canonicalPath = await realpath(candidate);
  if (!isInside(canonicalRoot, canonicalPath)) throw new Error("artifact_path_escapes_workspace");
  const finalMetadata = await lstat(canonicalPath);
  if (!finalMetadata.isFile() || finalMetadata.isSymbolicLink()) throw new Error("artifact_target_not_regular_file");
  return { canonicalPath, byteLength: finalMetadata.size };
}

export function normalizeWorkspaceRelativePath(value: string): string {
  const normalized = String(value ?? "").replaceAll("\\", "/").replace(/^\.\//, "");
  if (!normalized || path.posix.isAbsolute(normalized) || normalized.split("/").includes("..")) {
    throw new Error("artifact_workspace_relative_path_invalid");
  }
  return normalized;
}

export async function digestWorkspaceFile(canonicalPath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(canonicalPath)) hash.update(chunk as Uint8Array);
  return `sha256:${hash.digest("hex")}`;
}

async function inspectArtifact(cwd: string, artifact: ArtifactReference): Promise<ArtifactInspection> {
  let resolved: { canonicalPath: string; byteLength: number };
  try {
    resolved = await resolveWorkspaceArtifact(cwd, artifact.workspaceRelativePath);
  } catch (error) {
    return { state: mapFileError(error) };
  }
  try {
    if (await digestWorkspaceFile(resolved.canonicalPath) !== artifact.contentDigest) {
      return { state: "changed", byteLength: resolved.byteLength };
    }
    return {
      state: resolved.byteLength > MAX_ARTIFACT_PREVIEW_BYTES ? "too_large" : "available",
      canonicalPath: resolved.canonicalPath,
      byteLength: resolved.byteLength,
    };
  } catch (error) {
    return { state: mapFileError(error), byteLength: resolved.byteLength };
  }
}

function isInside(root: string, target: string): boolean {
  return target !== root && target.startsWith(`${root}${path.sep}`);
}

function artifactDisplayName(workspaceRelativePath: string): string {
  return workspaceRelativePath.replaceAll("\\", "/").split("/").filter(Boolean).at(-1) ?? "artifact";
}

function digestBytes(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function artifactContentType(workspaceRelativePath: string): "text/plain" | "text/markdown" | "text/html" {
  if (/\.(html?|xhtml)$/i.test(workspaceRelativePath)) return "text/html";
  return /\.(md|mdx|markdown)$/i.test(workspaceRelativePath) ? "text/markdown" : "text/plain";
}

function isBinary(bytes: Uint8Array): boolean {
  const sample = bytes.subarray(0, Math.min(bytes.byteLength, 8_192));
  return sample.some((byte) => byte === 0);
}

function mapFileError(error: unknown): "missing" | "unsupported" {
  return isNodeError(error, "ENOENT") ? "missing" : "unsupported";
}

function isNodeError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code;
}

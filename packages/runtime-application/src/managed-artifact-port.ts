import type {
  ArtifactId,
  ArtifactPreviewReadModel,
  ArtifactReference,
  EvidenceReferenceId,
  InvocationId,
  ProviderFactId,
  SessionMessageId,
  TaskArchitectureSnapshot,
  TaskPermanentDeletePreview,
  TaskPermanentDeleteSkipReason,
} from "@agent-workspace/runtime-contracts";

/**
 * Host-only filesystem boundary for Artifact verification and access.
 *
 * Runtime Application supplies an immutable Task architecture and provenance
 * already authorized from durable Invocation/final Message records. The port
 * never receives a cwd, URL, renderer file handle, or Provider-native identity.
 */
export interface ManagedArtifactPort {
  readonly verifyArtifact: (input: {
    readonly artifactId: ArtifactId;
    readonly architecture: TaskArchitectureSnapshot;
    readonly runId: string;
    readonly workspaceRelativePath: string;
    readonly sourceInvocationId: InvocationId;
    readonly sourceMessageId: SessionMessageId;
    readonly sourceProviderFactId?: ProviderFactId;
    readonly evidenceReferenceIds: readonly EvidenceReferenceId[];
    readonly verifiedAt: string;
  }) => Promise<ArtifactReference>;
  readonly previewArtifact: (input: {
    readonly architecture: TaskArchitectureSnapshot;
    readonly artifact: ArtifactReference;
  }) => Promise<ArtifactPreviewReadModel>;
  readonly previewPermanentDelete: (input: {
    readonly architecture: TaskArchitectureSnapshot;
    readonly taskId: string;
    readonly expectedRevision: number;
    readonly artifacts: readonly ArtifactReference[];
  }) => Promise<TaskPermanentDeletePreview>;
  readonly deleteArtifacts: (input: {
    readonly commandId: string;
    readonly architecture: TaskArchitectureSnapshot;
    readonly artifacts: readonly ArtifactReference[];
  }) => Promise<ManagedArtifactDeleteOutcome>;
}

export type ManagedArtifactDeleteOutcome = {
  readonly deletedArtifactIds: readonly ArtifactId[];
  readonly skippedArtifacts: readonly {
    readonly artifactId: ArtifactId;
    readonly reason: TaskPermanentDeleteSkipReason;
  }[];
};

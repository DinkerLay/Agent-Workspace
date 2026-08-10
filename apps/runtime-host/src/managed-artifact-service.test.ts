import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ArtifactReference, TaskArchitectureSnapshot } from "@agent-workspace/runtime-contracts";
import { templateDefinitionFixture } from "@agent-workspace/test-kit";
import { afterEach, describe, expect, it } from "vitest";
import {
  MANAGED_ARTIFACT_PHYSICAL_DELETE_AVAILABLE,
  NodeManagedArtifactService,
  digestWorkspaceFile,
} from "./managed-artifact-service.js";

const paths: string[] = [];

afterEach(() => {
  for (const directory of paths.splice(0)) rmSync(directory, { force: true, recursive: true });
});

describe("NodeManagedArtifactService", () => {
  it("verifies a requested project-relative file into an ArtifactReference with durable provenance", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "agent-workspace-managed-artifact-"));
    paths.push(root);
    const workspace = path.join(root, "workspace");
    const file = path.join(workspace, "reports", "NVDA-deepsearch.html");
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, "<!doctype html><h1>NVDA DeepSearch</h1>", "utf8");
    const service = new NodeManagedArtifactService();

    const artifact = await service.verifyArtifact({
      artifactId: "artifact_nvda_report",
      architecture: architectureFor(workspace),
      runId: "run_result",
      workspaceRelativePath: "./reports/NVDA-deepsearch.html",
      sourceInvocationId: "invocation_writer",
      sourceMessageId: "message_writer_final",
      evidenceReferenceIds: [],
      verifiedAt: "2026-08-09T00:00:00.000Z",
    });

    expect(artifact).toEqual({
      artifactId: "artifact_nvda_report",
      taskId: "task_result",
      runId: "run_result",
      workspaceRelativePath: "reports/NVDA-deepsearch.html",
      contentDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      sourceInvocationId: "invocation_writer",
      sourceMessageId: "message_writer_final",
      evidenceReferenceIds: [],
      verifiedAt: "2026-08-09T00:00:00.000Z",
    });
    await expect(service.verifyArtifact({
      artifactId: "artifact_escape",
      architecture: architectureFor(workspace),
      runId: "run_result",
      workspaceRelativePath: "../outside.html",
      sourceInvocationId: "invocation_writer",
      sourceMessageId: "message_writer_final",
      evidenceReferenceIds: [],
      verifiedAt: "2026-08-09T00:00:00.000Z",
    })).rejects.toThrow("artifact_workspace_relative_path_invalid");
  });

  it("recognizes a digest-matching HTML deliverable without treating it as executable Host content", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "agent-workspace-managed-artifact-"));
    paths.push(root);
    const workspace = path.join(root, "workspace");
    const file = path.join(workspace, "reports", "NVDA-deepsearch.html");
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, "<!doctype html><html><body><h1>NVDA DeepSearch</h1><script>globalThis.leak = true</script></body></html>", "utf8");
    const artifact = await artifactFor(workspace, "reports/NVDA-deepsearch.html");

    const preview = await new NodeManagedArtifactService().previewArtifact({
      architecture: architectureFor(workspace),
      artifact,
    });

    expect(preview).toMatchObject({
      artifactId: artifact.artifactId,
      displayName: "NVDA-deepsearch.html",
      state: "available",
      contentType: "text/html",
    });
    expect(preview.content).toContain("<h1>NVDA DeepSearch</h1>");
    expect(JSON.stringify(preview)).not.toContain(workspace);
    expect(JSON.stringify(preview)).not.toContain("reports/NVDA-deepsearch.html");
  });

  it("previews a digest-matching Artifact but fails closed while atomic physical delete is unavailable", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "agent-workspace-managed-artifact-"));
    paths.push(root);
    const workspace = path.join(root, "workspace");
    const file = path.join(workspace, "reports", "result.md");
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, "# Verified result\n", "utf8");
    const artifact = await artifactFor(workspace, "reports/result.md");
    const service = new NodeManagedArtifactService();
    const architecture = architectureFor(workspace);

    const preview = await service.previewArtifact({ architecture, artifact });
    expect(preview).toMatchObject({
      artifactId: artifact.artifactId,
      taskId: artifact.taskId,
      displayName: "result.md",
      state: "available",
      contentType: "text/markdown",
      content: "# Verified result\n",
    });
    expect(JSON.stringify(preview)).not.toContain("reports/result.md");
    expect(JSON.stringify(preview)).not.toContain(workspace);

    const deletePreview = await service.previewPermanentDelete({
      architecture,
      taskId: artifact.taskId,
      expectedRevision: 3,
      artifacts: [artifact],
    });
    expect(MANAGED_ARTIFACT_PHYSICAL_DELETE_AVAILABLE).toBe(false);
    expect(deletePreview.artifacts).toEqual([expect.objectContaining({ artifactId: artifact.artifactId, state: "unsupported" })]);

    const deleted = await service.deleteArtifacts({ commandId: "command_delete_artifact", architecture, artifacts: [artifact] });
    expect(deleted).toEqual({
      deletedArtifactIds: [],
      skippedArtifacts: [{ artifactId: artifact.artifactId, reason: "unsupported" }],
    });
    expect(existsSync(file)).toBe(true);
  });

  it("never removes a changed or path-escaping Artifact even when its managed ID is selected", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "agent-workspace-managed-artifact-"));
    paths.push(root);
    const workspace = path.join(root, "workspace");
    const file = path.join(workspace, "reports", "result.txt");
    const outside = path.join(root, "outside.txt");
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, "verified", "utf8");
    writeFileSync(outside, "must survive", "utf8");
    const changedArtifact = await artifactFor(workspace, "reports/result.txt");
    writeFileSync(file, "replaced after verification", "utf8");
    const escapedArtifact: ArtifactReference = {
      ...changedArtifact,
      artifactId: "artifact_escape",
      workspaceRelativePath: "../outside.txt",
    };
    const service = new NodeManagedArtifactService();
    const deleted = await service.deleteArtifacts({
      commandId: "command_delete_changed",
      architecture: architectureFor(workspace),
      artifacts: [changedArtifact, escapedArtifact],
    });

    expect(deleted).toEqual({
      deletedArtifactIds: [],
      skippedArtifacts: [
        { artifactId: changedArtifact.artifactId, reason: "unsupported" },
        { artifactId: escapedArtifact.artifactId, reason: "unsupported" },
      ],
    });
    expect(existsSync(file)).toBe(true);
    expect(existsSync(outside)).toBe(true);
  });

  it("keeps external bytes when a verified parent directory is replaced by a symlink before delete", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "agent-workspace-managed-artifact-"));
    paths.push(root);
    const workspace = path.join(root, "workspace");
    const reports = path.join(workspace, "reports");
    const originalReports = path.join(workspace, "reports-original");
    const outsideReports = path.join(root, "outside-reports");
    const workspaceFile = path.join(reports, "result.html");
    const outsideFile = path.join(outsideReports, "result.html");
    mkdirSync(reports, { recursive: true });
    mkdirSync(outsideReports, { recursive: true });
    writeFileSync(workspaceFile, "verified workspace bytes", "utf8");
    writeFileSync(outsideFile, "external bytes must survive", "utf8");
    const artifact = await artifactFor(workspace, "reports/result.html");

    renameSync(reports, originalReports);
    symlinkSync(outsideReports, reports, "dir");
    const deleted = await new NodeManagedArtifactService().deleteArtifacts({
      commandId: "command_delete_symlink_race",
      architecture: architectureFor(workspace),
      artifacts: [artifact],
    });

    expect(deleted).toEqual({
      deletedArtifactIds: [],
      skippedArtifacts: [{ artifactId: artifact.artifactId, reason: "unsupported" }],
    });
    expect(existsSync(path.join(originalReports, "result.html"))).toBe(true);
    expect(existsSync(outsideFile)).toBe(true);
  });
});

async function artifactFor(workspace: string, workspaceRelativePath: string): Promise<ArtifactReference> {
  const file = path.join(workspace, workspaceRelativePath);
  return {
    artifactId: "artifact_result",
    taskId: "task_result",
    runId: "run_result",
    workspaceRelativePath,
    contentDigest: await digestWorkspaceFile(file),
    evidenceReferenceIds: [],
    verifiedAt: "2026-08-06T00:00:00.000Z",
  };
}

function architectureFor(workspace: string): TaskArchitectureSnapshot {
  return {
    architectureSnapshotId: "architecture_result",
    taskId: "task_result",
    templateId: "template_result",
    templateVersionId: "template_version_result",
    templateDefinitionHash: "fnv1a64:result",
    definition: templateDefinitionFixture(),
    taskInputValues: [],
    taskGoalContent: "Task title: Result\nTask goal:\nProduce a verified result.\nTask inputs:\n(none)\n",
    taskGoalContentDigest: "sha256:task-goal-result",
    taskGoalCompilerVersion: "task-goal/v1",
    workspace: { workspaceId: "workspace_result", cwd: workspace },
    createdAt: "2026-08-06T00:00:00.000Z",
  };
}

import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { WorkspaceAuthorizationRecord, WorkspaceReferenceV3 } from "@agent-workspace/runtime-contracts";
import { createNodeWorkspaceDirectoryResolver } from "./workspace-directory-resolver.js";
import { createNodeSessionIdAcpWorkspacePreviewPort } from "./session-id-acp-workspace-preview-port.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Node Session-ID ACP Workspace Preview port", () => {
  it("re-realpaths the sealed authorization and reads a bounded regular UTF-8 file", async () => {
    const fixture = createWorkspace();
    mkdirSync(path.join(fixture.root, "reports"));
    writeFileSync(path.join(fixture.root, "reports", "result.md"), "hello\n", "utf8");
    const port = createNodeSessionIdAcpWorkspacePreviewPort();

    await expect(port.revalidate({
      workspace: fixture.workspace,
      authorization: fixture.authorization,
      workspaceRelativePath: "reports/result.md",
    })).resolves.toEqual({
      state: "available",
      contentDigest: digest("hello\n"),
      byteLength: 6,
      content: "hello\n",
    });
  });

  it("rejects traversal, absolute paths, a final symlink, and an intermediate symlink", async () => {
    const fixture = createWorkspace();
    const outside = temporaryRoot();
    mkdirSync(path.join(fixture.root, "real"));
    writeFileSync(path.join(fixture.root, "real", "inside.md"), "inside", "utf8");
    writeFileSync(path.join(outside, "secret.md"), "secret", "utf8");
    symlinkSync(path.join(outside, "secret.md"), path.join(fixture.root, "linked.md"));
    symlinkSync(path.join(fixture.root, "real"), path.join(fixture.root, "linked-directory"));
    const port = createNodeSessionIdAcpWorkspacePreviewPort();
    const request = (workspaceRelativePath: string) => port.revalidate({
      workspace: fixture.workspace,
      authorization: fixture.authorization,
      workspaceRelativePath,
    });

    await expect(request("../secret.md")).rejects.toThrow("acp_workspace_preview_path_invalid");
    await expect(request("/etc/passwd")).rejects.toThrow("acp_workspace_preview_path_invalid");
    await expect(request("linked.md")).rejects.toThrow("acp_workspace_preview_symlink_forbidden");
    await expect(request("linked-directory/inside.md")).rejects.toThrow("acp_workspace_preview_symlink_forbidden");
  });

  it("rejects a stale canonical authorization and a mismatched v3 grant digest", async () => {
    const fixture = createWorkspace();
    const aliasParent = temporaryRoot();
    const alias = path.join(aliasParent, "alias");
    symlinkSync(fixture.root, alias);
    const port = createNodeSessionIdAcpWorkspacePreviewPort();

    await expect(port.revalidate({
      workspace: fixture.workspace,
      authorization: { ...fixture.authorization, canonicalDirectory: alias },
      workspaceRelativePath: "missing.md",
    })).rejects.toThrow("acp_workspace_preview_authorization_stale");

    await expect(port.revalidate({
      workspace: { ...fixture.workspace, grantDigest: `sha256:${"f".repeat(64)}` },
      authorization: fixture.authorization,
      workspaceRelativePath: "missing.md",
    })).rejects.toThrow("acp_workspace_preview_grant_mismatch");
  });

  it("returns safe missing, unsupported, and too-large states without file content", async () => {
    const fixture = createWorkspace();
    writeFileSync(path.join(fixture.root, "binary.md"), Buffer.from([0xff, 0xfe]));
    writeFileSync(path.join(fixture.root, "image.png"), "not-an-image", "utf8");
    writeFileSync(path.join(fixture.root, "large.txt"), "12345", "utf8");
    const port = createNodeSessionIdAcpWorkspacePreviewPort({ maxBytes: 4 });
    const request = (workspaceRelativePath: string) => port.revalidate({
      workspace: fixture.workspace,
      authorization: fixture.authorization,
      workspaceRelativePath,
    });

    await expect(request("missing.md")).resolves.toEqual({ state: "missing" });
    await expect(request("image.png")).resolves.toEqual({ state: "unsupported", byteLength: 12 });
    await expect(request("binary.md")).resolves.toEqual({ state: "unsupported", byteLength: 2 });
    await expect(request("large.txt")).resolves.toEqual({ state: "too_large", byteLength: 5 });
  });
});

function createWorkspace(): Readonly<{
  root: string;
  authorization: WorkspaceAuthorizationRecord;
  workspace: WorkspaceReferenceV3;
}> {
  const root = temporaryRoot();
  const authorization: WorkspaceAuthorizationRecord = {
    workspaceId: "workspace_preview_port",
    canonicalDirectory: root,
    displayName: "Preview",
    authorizedAt: "2026-08-12T20:00:00.000Z",
  };
  const resolver = createNodeWorkspaceDirectoryResolver();
  const workspace: WorkspaceReferenceV3 = {
    workspaceId: authorization.workspaceId,
    grantDigest: resolver.digestGrant({
      schemaVersion: 1,
      workspaceId: authorization.workspaceId,
      canonicalDirectory: authorization.canonicalDirectory,
      authorizedAt: authorization.authorizedAt,
    }),
  };
  return { root, authorization, workspace };
}

function temporaryRoot(): string {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "agent-workspace-acp-preview-")));
  roots.push(root);
  return root;
}

function digest(content: string): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

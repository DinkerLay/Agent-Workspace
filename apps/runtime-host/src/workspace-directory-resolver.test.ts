import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createNodeWorkspaceDirectoryResolver } from "./workspace-directory-resolver.js";

const paths: string[] = [];

afterEach(() => {
  for (const directory of paths.splice(0)) rmSync(directory, { force: true, recursive: true });
});

describe("Node workspace directory resolver", () => {
  it("canonicalizes an existing directory and rejects a relative path or regular file", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "agent-workspace-directory-"));
    paths.push(directory);
    const file = path.join(directory, "not-a-directory.txt");
    writeFileSync(file, "not a directory");
    const resolver = createNodeWorkspaceDirectoryResolver();

    await expect(resolver.canonicalizeDirectory(directory)).resolves.toEqual({
      canonicalDirectory: await realpath(directory),
      defaultDisplayName: path.basename(directory),
    });
    await expect(resolver.canonicalizeDirectory("relative/project")).rejects.toThrow("workspace_directory_absolute_required");
    await expect(resolver.canonicalizeDirectory(file)).rejects.toThrow("workspace_directory_not_directory");
  });

  it("issues a stable SHA-256 grant seal without returning the sealed directory", () => {
    const resolver = createNodeWorkspaceDirectoryResolver();
    const grant = Object.freeze({
      schemaVersion: 1 as const,
      workspaceId: "workspace_resolver_grant",
      canonicalDirectory: "/host/private/workspace",
      authorizedAt: "2026-08-12T00:00:00.000Z",
    });

    const digest = resolver.digestGrant(grant);

    expect(digest).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(digest).toBe(resolver.digestGrant(grant));
    expect(digest).not.toContain(grant.canonicalDirectory);
    expect(resolver.digestGrant({
      ...grant,
      authorizedAt: "2026-08-12T00:00:01.000Z",
    })).not.toBe(digest);
  });
});

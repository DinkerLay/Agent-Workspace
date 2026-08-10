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
});

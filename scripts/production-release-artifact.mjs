import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";

const BUILT_TREE = "dist/workbench";
const LAUNCH_ARTIFACTS = Object.freeze([
  "apps/desktop/main.cjs",
  "apps/desktop/preload.cjs",
  "apps/runtime-host/src/index.ts",
  "tests/journeys/support/controlled-unified-host-service-cli.ts",
  "tests/journeys/support/native-unified-host-service-cli.ts",
]);

/**
 * Canonical bytes for the exact production renderer and process entrypoints
 * executed by a release cell. Paths and byte lengths make the stream
 * unambiguous; filesystem metadata and build timestamps are deliberately not
 * included.
 */
export async function productionArtifactIdentityBytes(repositoryRoot) {
  const root = path.resolve(requiredText(repositoryRoot));
  const files = [
    ...await listBuiltFiles(root, BUILT_TREE),
    ...LAUNCH_ARTIFACTS,
  ].sort();
  const chunks = [];
  for (const relative of files) {
    const absolute = path.join(root, relative);
    const status = await lstat(absolute).catch((error) => {
      if (error && typeof error === "object" && error.code === "ENOENT") {
        throw new Error(`production_release_artifact_missing:${relative}`);
      }
      throw error;
    });
    if (status.isSymbolicLink()) throw new Error(`production_release_artifact_symlink_forbidden:${relative}`);
    if (!status.isFile()) throw new Error(`production_release_artifact_file_invalid:${relative}`);
    const bytes = await readFile(absolute);
    chunks.push(
      Buffer.from(`${Buffer.byteLength(relative, "utf8")}:`, "utf8"),
      Buffer.from(relative, "utf8"),
      Buffer.from(`:${bytes.byteLength}:`, "utf8"),
      bytes,
    );
  }
  return Buffer.concat(chunks);
}

export async function productionArtifactDigest(repositoryRoot) {
  const bytes = await productionArtifactIdentityBytes(repositoryRoot);
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

async function listBuiltFiles(root, relativeDirectory) {
  const result = [];
  await walk(relativeDirectory);
  if (result.length === 0) throw new Error("production_release_artifact_tree_empty");
  return result.sort();

  async function walk(relative) {
    const absolute = path.join(root, relative);
    const status = await lstat(absolute).catch((error) => {
      if (error && typeof error === "object" && error.code === "ENOENT") {
        throw new Error(`production_release_artifact_missing:${relative}`);
      }
      throw error;
    });
    if (status.isSymbolicLink()) throw new Error(`production_release_artifact_symlink_forbidden:${relative}`);
    if (!status.isDirectory()) throw new Error(`production_release_artifact_directory_invalid:${relative}`);
    for (const entry of await readdir(absolute, { withFileTypes: true })) {
      const child = path.posix.join(relative.replaceAll(path.sep, "/"), entry.name);
      if (entry.isSymbolicLink()) throw new Error(`production_release_artifact_symlink_forbidden:${child}`);
      if (entry.isDirectory()) await walk(child);
      else if (entry.isFile()) result.push(child);
      else throw new Error(`production_release_artifact_entry_invalid:${child}`);
    }
  }
}

function requiredText(value) {
  if (typeof value !== "string" || !value.trim()) throw new Error("production_release_repository_root_required");
  return value;
}

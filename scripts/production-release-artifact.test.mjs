import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { productionArtifactDigest } from "./production-release-artifact.mjs";

const roots = [];

test.afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("production artifact digest binds the built tree and launch bytes", async () => {
  const root = await fixture();
  const first = await productionArtifactDigest(root);
  assert.match(first, /^sha256:[a-f0-9]{64}$/u);

  for (const [relative, original] of [
    ["dist/workbench/assets/app.js", "first-build"],
    ["apps/desktop/main.cjs", "main"],
    ["apps/desktop/preload.cjs", "preload"],
    ["apps/runtime-host/src/index.ts", "host"],
    ["tests/journeys/support/controlled-unified-host-service-cli.ts", "controlled-host-cli"],
    ["tests/journeys/support/native-unified-host-service-cli.ts", "native-host-cli"],
  ]) {
    await writeFile(path.join(root, relative), `changed:${relative}`, "utf8");
    assert.notEqual(await productionArtifactDigest(root), first, relative);
    await writeFile(path.join(root, relative), original, "utf8");
    assert.equal(await productionArtifactDigest(root), first, relative);
  }
});

test("production artifact digest rejects a symlink in the built tree", async () => {
  const root = await fixture();
  await symlink(path.join(root, "apps/desktop/main.cjs"), path.join(root, "dist/workbench/assets/link.js"));
  await assert.rejects(() => productionArtifactDigest(root), /production_release_artifact_symlink_forbidden/u);
});

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "agent-workspace-production-artifact-"));
  roots.push(root);
  await Promise.all([
    mkdir(path.join(root, "dist/workbench/assets"), { recursive: true }),
    mkdir(path.join(root, "apps/desktop"), { recursive: true }),
    mkdir(path.join(root, "apps/runtime-host/src"), { recursive: true }),
    mkdir(path.join(root, "tests/journeys/support"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(path.join(root, "dist/workbench/index.html"), "<main />", "utf8"),
    writeFile(path.join(root, "dist/workbench/assets/app.js"), "first-build", "utf8"),
    writeFile(path.join(root, "apps/desktop/main.cjs"), "main", "utf8"),
    writeFile(path.join(root, "apps/desktop/preload.cjs"), "preload", "utf8"),
    writeFile(path.join(root, "apps/runtime-host/src/index.ts"), "host", "utf8"),
    writeFile(path.join(root, "tests/journeys/support/controlled-unified-host-service-cli.ts"), "controlled-host-cli", "utf8"),
    writeFile(path.join(root, "tests/journeys/support/native-unified-host-service-cli.ts"), "native-host-cli", "utf8"),
  ]);
  return root;
}

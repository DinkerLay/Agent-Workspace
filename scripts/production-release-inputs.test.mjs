import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import {
  assertProductionReleaseDigests,
  productionReleaseIdentityInputBytes,
} from "./production-release-inputs.mjs";

const run = promisify(execFile);
const roots = [];
const runnerSha256 = `sha256:${"a".repeat(64)}`;
const workerSha256 = `sha256:${"b".repeat(64)}`;

test.afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("release seal detects schema, provider policy, policy, source and build drift by canonical class", async () => {
  const root = await fixture();
  const bytes = await productionReleaseIdentityInputBytes(root, { runnerSha256, workerSha256 });
  const expected = Object.freeze({
    sourceDigest: digest(bytes.source),
    buildDigest: digest(bytes.build),
    schemaDigest: digest(bytes.schema),
    providerPolicyDigest: digest(bytes.providerPolicy),
    policyDigest: digest(bytes.policy),
  });
  await assert.doesNotReject(() => assertProductionReleaseDigests({ repositoryRoot: root, expected, runnerSha256, workerSha256 }));

  for (const [relative, code] of [
    ["packages/runtime-contracts/schema.ts", "journey_release_schema_drift"],
    ["apps/runtime-host/PROVIDER_CONFIGURATION.md", "journey_release_provider_policy_drift"],
    ["docs/architecture.md", "journey_release_policy_drift"],
    ["unrelated.ts", "journey_release_source_drift"],
    ["dist/workbench/assets/app.js", "journey_release_build_drift"],
  ]) {
    const file = path.join(root, relative);
    const original = relative;
    await writeFile(file, `${relative}:changed`, "utf8");
    await assert.rejects(
      () => assertProductionReleaseDigests({ repositoryRoot: root, expected, runnerSha256, workerSha256 }),
      new RegExp(code, "u"),
    );
    await writeFile(file, original, "utf8");
  }
});

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "agent-workspace-release-inputs-"));
  roots.push(root);
  for (const directory of [
    "apps/desktop", "apps/runtime-host/src", "dist/workbench/assets", "docs",
    "packages/runtime-contracts", "packages/runtime-store", "scripts", "tests/e2e", "tests/journeys/support",
  ]) await mkdir(path.join(root, directory), { recursive: true });
  const files = [
    ".gitignore", "AGENTS.md", "apps/desktop/main.cjs", "apps/desktop/preload.cjs",
    "apps/runtime-host/PROVIDER_CONFIGURATION.md", "apps/runtime-host/src/index.ts",
    "dist/workbench/index.html", "dist/workbench/assets/app.js", "docs/architecture.md",
    "docs/implementation-plan.md", "packages/runtime-contracts/schema.ts",
    "packages/runtime-store/store.ts", "scripts/run-journey-suite.mjs",
    "tests/journeys/support/controlled-unified-host-service-cli.ts",
    "tests/journeys/support/native-unified-host-service-cli.ts",
    "tests/e2e/journey-evidence.ts", "unrelated.ts",
  ];
  await Promise.all(files.map((file) => writeFile(path.join(root, file), file === ".gitignore" ? "dist/\n" : file, "utf8")));
  await run("git", ["init", "-q"], { cwd: root });
  await run("git", ["add", "--", ...files.filter((file) => !file.startsWith("dist/"))], { cwd: root });
  return root;
}

function digest(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

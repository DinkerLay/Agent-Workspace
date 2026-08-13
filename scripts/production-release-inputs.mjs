import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { productionArtifactIdentityBytes } from "./production-release-artifact.mjs";

const SCHEMA_ENTRIES = Object.freeze([
  "packages/runtime-contracts",
  "packages/runtime-store",
  "tests/e2e/journey-evidence.ts",
]);
const PROVIDER_POLICY_FILES = Object.freeze([
  "apps/runtime-host/PROVIDER_CONFIGURATION.md",
  "scripts/run-journey-suite.mjs",
]);
const POLICY_FILES = Object.freeze([
  "AGENTS.md",
  "docs/architecture.md",
  "docs/implementation-plan.md",
]);

export async function productionReleaseIdentityInputBytes(repositoryRoot, runnerDigests) {
  const root = path.resolve(requiredText(repositoryRoot, "production_release_repository_root_required"));
  const nonBuild = await productionReleaseNonBuildIdentityInputBytes(root, runnerDigests);
  return Object.freeze({
    ...nonBuild,
    build: await productionArtifactIdentityBytes(root),
  });
}

export async function productionReleaseNonBuildIdentityInputBytes(repositoryRoot, runnerDigests) {
  const root = path.resolve(requiredText(repositoryRoot, "production_release_repository_root_required"));
  const runnerSha256 = requiredDigest(runnerDigests?.runnerSha256, "production_release_runner_digest_invalid");
  const workerSha256 = runnerDigests?.workerSha256 === undefined
    ? undefined
    : requiredDigest(runnerDigests.workerSha256, "production_release_worker_digest_invalid");
  return Object.freeze({
    source: await combineFiles(root, gitFiles(root, []), true),
    schema: await combineFiles(root, gitFiles(root, SCHEMA_ENTRIES), true),
    providerPolicy: await combineFiles(root, PROVIDER_POLICY_FILES),
    policy: Buffer.concat([
      await combineFiles(root, POLICY_FILES),
      Buffer.from([runnerSha256, workerSha256].filter(Boolean).join("\n"), "utf8"),
    ]),
  });
}

export async function assertProductionReleaseDigests(input) {
  const bytes = await productionReleaseIdentityInputBytes(input.repositoryRoot, input);
  assertDigest(input.expected.schemaDigest, bytes.schema, "schema");
  assertDigest(input.expected.providerPolicyDigest, bytes.providerPolicy, "provider_policy");
  assertDigest(input.expected.policyDigest, bytes.policy, "policy");
  assertDigest(input.expected.sourceDigest, bytes.source, "source");
  assertDigest(input.expected.buildDigest, bytes.build, "build");
}

export async function assertProductionReleaseNonBuildDigests(input) {
  const bytes = await productionReleaseNonBuildIdentityInputBytes(input.repositoryRoot, input);
  assertDigest(input.expected.schemaDigest, bytes.schema, "schema");
  assertDigest(input.expected.providerPolicyDigest, bytes.providerPolicy, "provider_policy");
  assertDigest(input.expected.policyDigest, bytes.policy, "policy");
  assertDigest(input.expected.sourceDigest, bytes.source, "source");
}

function gitFiles(root, pathspecs) {
  return execFileSync("git", [
    "ls-files", "--cached", "--others", "--exclude-standard", "-z",
    ...(pathspecs.length > 0 ? ["--", ...pathspecs] : []),
  ], {
    cwd: root,
    encoding: "buffer",
    maxBuffer: pathspecs.length > 0 ? 8 * 1024 * 1024 : 32 * 1024 * 1024,
  }).toString("utf8").split("\0").filter(Boolean).sort();
}

async function combineFiles(root, files, includeDeletionTombstones = false) {
  const chunks = [];
  for (const file of files) {
    let bytes;
    try {
      bytes = await readFile(path.join(root, file));
    } catch (error) {
      if (!includeDeletionTombstones || !(error && typeof error === "object" && error.code === "ENOENT")) throw error;
      bytes = Buffer.from("<deleted-from-working-tree>", "utf8");
    }
    chunks.push(Buffer.from(`${file}\0`, "utf8"), bytes, Buffer.from("\0", "utf8"));
  }
  return Buffer.concat(chunks);
}

function assertDigest(expected, bytes, label) {
  const actual = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  if (actual !== expected) throw new Error(`journey_release_${label}_drift:${actual}`);
}

function requiredDigest(value, code) {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(value)) throw new Error(code);
  return value;
}

function requiredText(value, code) {
  if (typeof value !== "string" || !value.trim()) throw new Error(code);
  return value;
}

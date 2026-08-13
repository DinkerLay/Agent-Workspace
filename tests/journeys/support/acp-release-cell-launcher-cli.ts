import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  AcpReleaseCellLauncherBlockedError,
  launcherDescriptor,
  startAcpReleaseCellLauncher,
} from "./acp-release-cell-launcher.js";
import {
  consumeAcpReleaseLaneInputSealBeforeFirstEffect,
  createAcpReleaseLaneInputSeal,
} from "../acp-release-parent-preflight.js";
import type { NativeReleaseIdentity } from "./native-unified-host-service.js";

export async function runAcpReleaseCellLauncherCli(
  argv: readonly string[] = process.argv.slice(2),
  environment: NodeJS.ProcessEnv = process.env,
): Promise<Readonly<{ close(): Promise<void> }>> {
  const input = parseArguments(argv);
  const identity = normalizeIdentity(await readPrivateJson(
    input.identityFile,
    "acp_release_launcher_identity_file_invalid",
  ));
  const descriptor = launcherDescriptor(identity.bundleCellId, identity.scenarioId);
  if (descriptor.issuer !== identity.issuer) throw blocked("acp_release_launcher_identity_mismatch");
  const hostInputSeal = await createAcpReleaseLaneInputSeal({
    envelopeFile: input.hostEnvironmentFile,
    issuer: identity.issuer,
  });
  const hostEnvironment = hostInputSeal.hostEnvironment();
  const launched = await startAcpReleaseCellLauncher({
    stateRoot: input.stateRoot,
    manifestPath: input.manifestPath,
    releaseIdentity: identity,
    hostEnvironment,
    expectedBuildDigest: input.buildDigest,
    consumeHostInputSealBeforeFirstEffect: () => (
      consumeAcpReleaseLaneInputSealBeforeFirstEffect(hostInputSeal)
    ),
    environment,
  });
  process.stdout.write(`${JSON.stringify({
    type: "acp_release_cell_ready",
    manifestPath: input.manifestPath,
    browserUrl: launched.manifest.browserUrl,
    healthUrl: launched.manifest.healthUrl,
    runtimeInstanceId: launched.manifest.runtimeInstanceId,
    issuer: launched.manifest.issuer,
  })}\n`);
  return Object.freeze({ close: launched.close });
}

function parseArguments(argv: readonly string[]): Readonly<{
  manifestPath: string;
  stateRoot: string;
  identityFile: string;
  hostEnvironmentFile: string;
  buildDigest: string;
}> {
  const flags = ["--manifest", "--state-root", "--identity", "--host-environment", "--build-digest"] as const;
  if (argv.length !== flags.length * 2 || flags.some((flag, index) => argv[index * 2] !== flag)) {
    throw blocked("acp_release_launcher_arguments_invalid");
  }
  return Object.freeze({
    manifestPath: absolute(argv[1]!, "acp_release_manifest_path_invalid"),
    stateRoot: absolute(argv[3]!, "acp_release_state_root_invalid"),
    identityFile: absolute(argv[5]!, "acp_release_launcher_identity_file_invalid"),
    hostEnvironmentFile: absolute(argv[7]!, "acp_release_host_environment_file_invalid"),
    buildDigest: sha256(argv[9]!),
  });
}

function normalizeIdentity(value: unknown): NativeReleaseIdentity {
  const keys = ["releaseRunId", "nonce", "bundleCellId", "scenarioId", "runtimeInstanceId", "issuer"];
  if (!isRecord(value) || Object.keys(value).length !== keys.length
    || Object.keys(value).some((key) => !keys.includes(key))) {
    throw blocked("acp_release_launcher_identity_file_invalid");
  }
  for (const field of ["releaseRunId", "nonce", "bundleCellId", "scenarioId", "runtimeInstanceId"] as const) {
    if (typeof value[field] !== "string" || !value[field].trim() || value[field].length > 256 || /[\r\n\0]/u.test(value[field])) {
      throw blocked("acp_release_launcher_identity_file_invalid");
    }
  }
  if (value.issuer !== "opencode_acp_task_attestor"
    && value.issuer !== "codex_acp_task_attestor"
    && value.issuer !== "acp_meta_attestor") {
    throw blocked("acp_release_launcher_identity_file_invalid");
  }
  return Object.freeze(value) as NativeReleaseIdentity;
}

async function readPrivateJson(file: string, code: string): Promise<unknown> {
  const metadata = await lstat(file).catch(() => undefined);
  if (!metadata?.isFile() || metadata.isSymbolicLink() || metadata.size < 1 || metadata.size > 64 * 1024
    || (process.platform !== "win32" && (metadata.mode & 0o077) !== 0)) {
    throw blocked(code);
  }
  try {
    return JSON.parse(await readFile(file, "utf8")) as unknown;
  } catch {
    throw blocked(code);
  }
}

function absolute(value: string, code: string): string {
  if (!path.isAbsolute(value)) throw blocked(code);
  return path.resolve(value);
}

function sha256(value: string): string {
  if (!/^sha256:[a-f0-9]{64}$/u.test(value)) throw blocked("acp_release_build_digest_invalid");
  return value;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function blocked(code: string): AcpReleaseCellLauncherBlockedError {
  return new AcpReleaseCellLauncherBlockedError(code);
}

function safeCode(error: unknown, fallback: string): string {
  const source = error instanceof Error ? error.message : "";
  return /^(?:acp|native_host)_[a-z0-9_]{2,128}$/u.test(source) ? source : fallback;
}

function isEntryModule(): boolean {
  return typeof process.argv[1] === "string" && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isEntryModule()) {
  void runAcpReleaseCellLauncherCli().then(async (launcher) => {
    let closing: Promise<void> | undefined;
    const close = () => {
      closing ??= launcher.close();
      void closing.then(
        () => { process.exitCode = 0; },
        () => { process.exitCode = 1; },
      );
    };
    process.once("SIGINT", close);
    process.once("SIGTERM", close);
    await new Promise(() => undefined);
  }).catch((error: unknown) => {
    const blockedFailure = error instanceof AcpReleaseCellLauncherBlockedError;
    process.stderr.write(`${JSON.stringify(blockedFailure
      ? { outcome: "BLOCKED_CAPABILITY", reason: safeCode(error, "acp_release_launcher_blocked") }
      : { outcome: "FAIL", code: safeCode(error, "acp_release_launcher_failed") })}\n`);
    process.exitCode = blockedFailure ? 2 : 1;
  });
}

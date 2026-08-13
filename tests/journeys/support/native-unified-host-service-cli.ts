import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  NATIVE_UNIFIED_HOST_RESTART_EXIT_CODE,
  startNativeUnifiedHostService,
  type NativeReleaseIdentity,
  type NativeUnifiedHostControlExit,
} from "./native-unified-host-service.js";
import type { AcpReleaseAttestorIssuer } from "../acp-release-attestation.js";

const CANONICAL_AUTHENTICATED_USER_ID = "user_local";
const TASK_WORKSPACE_DIRECTORY_ENV = "AGENT_WORKSPACE_RELEASE_TASK_WORKSPACE_DIRECTORY";

export type NativeUnifiedHostStartupFailureEnvelope = Readonly<{
  type: "native_unified_host_failure";
  outcome: "FAIL";
  stage: "service_start";
  code: string;
}>;

export type NativeUnifiedHostCli = Readonly<{
  close(): Promise<void>;
  waitForControlExit(): Promise<NativeUnifiedHostControlExit>;
}>;

export async function runNativeUnifiedHostServiceCli(
  argv = process.argv.slice(2),
  environment: NodeJS.ProcessEnv = process.env,
): Promise<NativeUnifiedHostCli> {
  const input = parseArguments(argv);
  const identity = normalizeIdentityDocument(
    await readPrivateJson(input.identityFile, "native_host_identity_file_invalid"),
  );
  if (environment.AGENT_WORKSPACE_OWNER_ID !== undefined
    && environment.AGENT_WORKSPACE_OWNER_ID !== CANONICAL_AUTHENTICATED_USER_ID) {
    throw new Error("native_host_authenticated_user_invalid");
  }
  const taskWorkspaceDirectory = identity.issuer === "acp_meta_attestor"
    ? forbidMetaWorkspace(environment)
    : requiredAbsoluteEnvironment(environment, TASK_WORKSPACE_DIRECTORY_ENV);
  const service = await startNativeUnifiedHostService({
    stateRoot: input.stateRoot,
    runtimeDataDirectory: input.runtimeDataDirectory,
    bridgePort: input.bridgePort,
    servicePort: input.servicePort,
    generation: input.generation,
    allowedOrigins: input.allowedOrigins,
    releaseIdentity: identity,
    authenticatedUserId: CANONICAL_AUTHENTICATED_USER_ID,
    rendererToken: requiredEnvironment(environment, "AGENT_WORKSPACE_NATIVE_RENDERER_TOKEN"),
    desktopRendererToken: requiredEnvironment(environment, "AGENT_WORKSPACE_NATIVE_DESKTOP_RENDERER_TOKEN"),
    evidenceToken: requiredEnvironment(environment, "AGENT_WORKSPACE_NATIVE_EVIDENCE_TOKEN"),
    controlToken: requiredEnvironment(environment, "AGENT_WORKSPACE_NATIVE_CONTROL_TOKEN"),
    ...(taskWorkspaceDirectory ? { taskWorkspaceDirectory } : {}),
    environment,
  });
  process.stdout.write(`${JSON.stringify({
    type: "native_unified_host_ready",
    runtimeUrl: service.runtimeUrl,
    serviceUrl: service.serviceUrl,
    healthUrl: service.healthUrl,
    hostLedgerUrl: service.hostLedgerUrl,
    operationLedgerUrl: service.operationLedgerUrl,
    observedLineageUrl: service.observedLineageUrl,
    nativeProviderLedgerUrl: service.nativeProviderLedgerUrl,
    nativeMetaLedgerUrl: service.nativeMetaLedgerUrl,
    runtimeInstanceId: service.runtimeInstanceId,
    lineageId: service.lineageId,
    generation: service.generation,
    issuer: identity.issuer,
  })}\n`);
  return Object.freeze({
    close: service.close,
    waitForControlExit: service.waitForControlExit,
  });
}

export function nativeUnifiedHostStartupFailureEnvelope(
  error: unknown,
): NativeUnifiedHostStartupFailureEnvelope {
  return Object.freeze({
    type: "native_unified_host_failure",
    outcome: "FAIL",
    stage: "service_start",
    code: safeCode(error, "native_host_start_failed"),
  });
}

function parseArguments(argv: readonly string[]): Readonly<{
  stateRoot: string;
  runtimeDataDirectory: string;
  bridgePort: number;
  servicePort: number;
  generation: number;
  allowedOrigins: readonly string[];
  identityFile: string;
}> {
  const values = new Map<string, string[]>();
  if (argv.length % 2 !== 0) throw new Error("native_host_service_cli_usage");
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith("--") || value === undefined) throw new Error("native_host_service_cli_usage");
    values.set(name, [...values.get(name) ?? [], value]);
  }
  const allowedKeys = [
    "--allowed-origin",
    "--bridge-port",
    "--generation",
    "--identity",
    "--runtime-data",
    "--service-port",
    "--state-root",
  ];
  if ([...values.keys()].some((key) => !allowedKeys.includes(key))) {
    throw new Error("native_host_service_cli_usage");
  }
  const allowedOrigins = values.get("--allowed-origin") ?? [];
  if (allowedOrigins.length === 0) throw new Error("native_host_allowed_origin_required");
  const generation = Number(one(values, "--generation"));
  if (!Number.isSafeInteger(generation) || generation < 1 || generation > 1_000_000) {
    throw new Error("native_host_generation_invalid");
  }
  return Object.freeze({
    stateRoot: absolute(one(values, "--state-root"), "native_host_state_root_invalid"),
    runtimeDataDirectory: absolute(one(values, "--runtime-data"), "native_host_runtime_data_invalid"),
    bridgePort: fixedPort(one(values, "--bridge-port")),
    servicePort: fixedPort(one(values, "--service-port")),
    generation,
    allowedOrigins: Object.freeze([...allowedOrigins]),
    identityFile: absolute(one(values, "--identity"), "native_host_identity_file_invalid"),
  });
}

function normalizeIdentityDocument(value: unknown): NativeReleaseIdentity {
  if (!isRecord(value)) throw new Error("native_host_identity_file_invalid");
  const keys = [
    "bundleCellId",
    "issuer",
    "nonce",
    "releaseRunId",
    "runtimeInstanceId",
    "scenarioId",
  ];
  if (Object.keys(value).sort().join(",") !== keys.sort().join(",")) {
    throw new Error("native_host_identity_file_invalid");
  }
  const issuer = acpIssuer(value.issuer);
  return Object.freeze({
    releaseRunId: text(value.releaseRunId),
    nonce: text(value.nonce),
    bundleCellId: text(value.bundleCellId),
    scenarioId: text(value.scenarioId),
    runtimeInstanceId: text(value.runtimeInstanceId),
    issuer,
  });
}

function acpIssuer(value: unknown): AcpReleaseAttestorIssuer {
  if (value !== "opencode_acp_task_attestor"
    && value !== "codex_acp_task_attestor"
    && value !== "acp_meta_attestor") {
    throw new Error("native_host_identity_file_invalid");
  }
  return value;
}

async function readPrivateJson(file: string, code: string): Promise<unknown> {
  const metadata = await lstat(file);
  if (!metadata.isFile() || metadata.isSymbolicLink()
    || metadata.size < 1 || metadata.size > 64 * 1024
    || (process.platform !== "win32" && (metadata.mode & 0o077) !== 0)) {
    throw new Error(code);
  }
  try {
    return JSON.parse(await readFile(file, "utf8")) as unknown;
  } catch {
    throw new Error(code);
  }
}

function one(values: ReadonlyMap<string, readonly string[]>, name: string): string {
  const entries = values.get(name);
  if (!entries || entries.length !== 1 || !entries[0]?.trim()) {
    throw new Error("native_host_service_cli_usage");
  }
  return entries[0];
}

function absolute(value: string, code: string): string {
  if (!path.isAbsolute(value)) throw new Error(code);
  return path.resolve(value);
}

function fixedPort(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error("native_host_service_cli_port_invalid");
  }
  return parsed;
}

function text(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 256 || value.includes("\0")) {
    throw new Error("native_host_identity_file_invalid");
  }
  return value.trim();
}

function requiredEnvironment(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name];
  if (typeof value !== "string" || !value.trim() || value.length > 4_096 || /[\r\n\0]/u.test(value)) {
    throw new Error(`native_host_service_${name.toLowerCase()}_required`);
  }
  return value.trim();
}

function requiredAbsoluteEnvironment(environment: NodeJS.ProcessEnv, name: string): string {
  const value = requiredEnvironment(environment, name);
  if (!path.isAbsolute(value) || path.normalize(value) !== value) {
    throw new Error("native_host_task_workspace_invalid");
  }
  return value;
}

function forbidMetaWorkspace(environment: NodeJS.ProcessEnv): undefined {
  if (environment[TASK_WORKSPACE_DIRECTORY_ENV] !== undefined) {
    throw new Error("native_host_meta_workspace_forbidden");
  }
  return undefined;
}

function safeCode(error: unknown, fallback: string): string {
  const source = error instanceof Error ? error.message : "";
  return /^native_host_[a-z0-9_]{2,128}$/u.test(source) ? source : fallback;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isEntryModule(): boolean {
  return typeof process.argv[1] === "string" && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isEntryModule()) {
  void runNativeUnifiedHostServiceCli().then(async (runtime) => {
    let signalClose: Promise<void> | undefined;
    const stop = () => {
      signalClose ??= runtime.close();
      void signalClose.then(
        () => { process.exitCode = 0; },
        () => { process.exitCode = 1; },
      );
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    try {
      const reason = await runtime.waitForControlExit();
      process.exitCode = reason === "restart" ? NATIVE_UNIFIED_HOST_RESTART_EXIT_CODE : 0;
    } catch {
      process.exitCode = 1;
    }
  }).catch((error: unknown) => {
    process.stderr.write(`${JSON.stringify(nativeUnifiedHostStartupFailureEnvelope(error))}\n`);
    process.exitCode = 1;
  });
}

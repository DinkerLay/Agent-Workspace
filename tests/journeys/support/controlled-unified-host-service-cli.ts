import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { readFile, stat } from "node:fs/promises";
import {
  normalizeControlledExpectedLineage,
  startControlledUnifiedHostService,
} from "./controlled-unified-host-service.js";
import { normalizeControlledJourneyCellMode } from "./controlled-session-id-acp-owner.js";

export async function runControlledUnifiedHostServiceCli(
  argv = process.argv.slice(2),
  environment: NodeJS.ProcessEnv = process.env,
): Promise<Readonly<{ close(): Promise<void> }>> {
  const input = parseArguments(argv);
  const expectedLineage = input.lineageFile
    ? await readPrivateExpectedLineage(input.lineageFile)
    : undefined;
  const service = await startControlledUnifiedHostService({
    stateRoot: input.stateRoot,
    bridgePort: input.bridgePort,
    servicePort: input.servicePort,
    allowedOrigins: Object.freeze(input.allowedOrigins),
    cellMode: input.cellMode,
    ...(expectedLineage ? { expectedLineage } : {}),
    authenticatedUserId: environment.AGENT_WORKSPACE_OWNER_ID ?? "user_local",
    rendererToken: requiredEnvironment(environment, "AGENT_WORKSPACE_CONTROLLED_RENDERER_TOKEN"),
    desktopRendererToken: requiredEnvironment(environment, "AGENT_WORKSPACE_CONTROLLED_DESKTOP_RENDERER_TOKEN"),
    evidenceToken: requiredEnvironment(environment, "AGENT_WORKSPACE_CONTROLLED_EVIDENCE_TOKEN"),
    controlToken: requiredEnvironment(environment, "AGENT_WORKSPACE_CONTROLLED_CONTROL_TOKEN"),
  });
  process.stdout.write(`${JSON.stringify({
    type: "controlled_unified_host_ready",
    runtimeUrl: service.runtimeUrl,
    serviceUrl: service.serviceUrl,
    healthUrl: service.healthUrl,
    hostLedgerUrl: service.hostLedgerUrl,
    operationLedgerUrl: service.operationLedgerUrl,
    observedLineageUrl: service.observedLineageUrl,
    runtimeInstanceId: service.runtimeInstanceId,
    lineageId: service.lineageId,
    generation: service.generation,
  })}\n`);
  return Object.freeze({ close: service.close });
}

function parseArguments(argv: readonly string[]): Readonly<{
  stateRoot: string;
  bridgePort: number;
  servicePort: number;
  allowedOrigins: readonly string[];
  cellMode: ReturnType<typeof normalizeControlledJourneyCellMode>;
  lineageFile?: string;
}> {
  const values = new Map<string, string[]>();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith("--") || value === undefined) throw new Error("controlled_host_service_cli_usage");
    const current = values.get(name) ?? [];
    current.push(value);
    values.set(name, current);
  }
  const stateRoot = one(values, "--state-root");
  if (!path.isAbsolute(stateRoot)) throw new Error("controlled_host_state_root_absolute_required");
  const allowedOrigins = values.get("--allowed-origin") ?? [];
  if (allowedOrigins.length === 0) throw new Error("controlled_host_allowed_origin_required");
  for (const key of values.keys()) {
    if (!["--state-root", "--bridge-port", "--service-port", "--allowed-origin", "--lineage", "--cell-mode"].includes(key)) {
      throw new Error("controlled_host_service_cli_usage");
    }
  }
  return Object.freeze({
    stateRoot: path.resolve(stateRoot),
    bridgePort: port(one(values, "--bridge-port")),
    servicePort: port(one(values, "--service-port")),
    allowedOrigins: Object.freeze([...allowedOrigins]),
    cellMode: normalizeControlledJourneyCellMode(oneOr(values, "--cell-mode", "main")),
    ...(values.has("--lineage")
      ? { lineageFile: absoluteFile(one(values, "--lineage")) }
      : {}),
  });
}

function oneOr(values: ReadonlyMap<string, readonly string[]>, name: string, fallback: string): string {
  const entries = values.get(name);
  if (!entries) return fallback;
  if (entries.length !== 1 || !entries[0]?.trim()) throw new Error("controlled_host_service_cli_usage");
  return entries[0];
}

async function readPrivateExpectedLineage(file: string) {
  const metadata = await stat(file);
  if (!metadata.isFile() || (process.platform !== "win32" && (metadata.mode & 0o077) !== 0)) {
    throw new Error("controlled_host_lineage_file_invalid");
  }
  try {
    return normalizeControlledExpectedLineage(JSON.parse(await readFile(file, "utf8")));
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("controlled_host_expected_lineage")) throw error;
    throw new Error("controlled_host_lineage_file_invalid");
  }
}

function absoluteFile(value: string): string {
  if (!path.isAbsolute(value)) throw new Error("controlled_host_lineage_file_absolute_required");
  return path.resolve(value);
}

function one(values: ReadonlyMap<string, readonly string[]>, name: string): string {
  const entries = values.get(name);
  if (!entries || entries.length !== 1 || !entries[0]?.trim()) throw new Error("controlled_host_service_cli_usage");
  return entries[0];
}

function port(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 65_535) throw new Error("controlled_host_service_cli_port_invalid");
  return parsed;
}

function requiredEnvironment(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name];
  if (typeof value !== "string" || !value.trim()) throw new Error(`controlled_host_service_${name.toLowerCase()}_required`);
  return value.trim();
}

function isEntryModule(): boolean {
  return typeof process.argv[1] === "string"
    && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isEntryModule()) {
  void runControlledUnifiedHostServiceCli().then(({ close }) => {
    let stopping = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      void close().finally(() => { process.exitCode = 0; });
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  }).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertAcpHostEpochSupervisorEnvironmentConfigured } from "./acp-host-epoch-lease.js";
import {
  createAcpProductionHostInputs,
  loadAcpProductionConfigurationFromEnvironment,
} from "./acp-production-configuration.js";
import { createAcpRuntimeHostPrivateAuthority } from "./acp-runtime-host-private-authority.js";
import {
  createSessionIdAcpProductionProviderOwner,
} from "./session-id-acp-production-provider-owner.js";
import { createSessionIdAcpProviderSettingsHost } from "./session-id-acp-provider-settings-host.js";
import type {
  SessionIdAcpProductionHumanOnlyDiagnostic,
} from "./session-id-acp-production-policy.js";
import { createSessionIdUnifiedRuntimeBridgeServer } from "./session-id-unified-runtime-bridge.js";
import {
  createSessionIdUnifiedRuntimeHost,
} from "./session-id-unified-runtime-host.js";

export * from "./session-id-unified-runtime-bridge.js";
export * from "./session-id-unified-runtime-host.js";

const DEFAULT_OWNER_ID = "user_local";
const DEFAULT_META_READINESS_PROBE_TIMEOUT_MS = 120_000;
const OWNER_ID = /^user_[A-Za-z0-9_-]{1,251}$/u;

export type SessionIdProductionWorkspaceGrant = Readonly<{
  commandId: string;
  workspaceId: string;
  directory: string;
  displayName?: string;
}>;

export type SessionIdProductionRuntimeEnvironment = Readonly<{
  runtimeDataPath: string;
  authenticatedUserId: string;
  rendererToken: string;
  desktopRendererToken?: string;
  evidenceToken: string;
  allowedOrigins: readonly string[];
  workspaceBootstrapGrants: readonly SessionIdProductionWorkspaceGrant[];
  port: number;
}>;

export type SessionIdProductionRuntimeHostHooks = Readonly<{
  /** Host-process-only activity sink; never crosses the Runtime Bridge. */
  onHumanOnlyDiagnostic?: (
    value: SessionIdAcpProductionHumanOnlyDiagnostic,
  ) => void | Promise<void>;
  /** Host-process-only safe lifecycle/stage diagnostics; never crosses the Bridge. */
  onDiagnostic?: (diagnostic: Readonly<{
    code: string;
    error?: string;
    role?: string;
    stage?: string;
  }>) => void;
}>;

/**
 * Parses only Host-owned launch configuration. Missing Provider and Meta
 * configuration remains an honest unavailable state; no fixture is installed.
 */
export function loadSessionIdProductionRuntimeEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): SessionIdProductionRuntimeEnvironment {
  const runtimeDataPath = runtimeDirectory(environment.AGENT_WORKSPACE_RUNTIME_DATA_DIR);
  const authenticatedUserId = ownerId(environment.AGENT_WORKSPACE_OWNER_ID);
  const rendererToken = requiredSecret(
    environment.AGENT_WORKSPACE_RUNTIME_TOKEN,
    "AGENT_WORKSPACE_RUNTIME_TOKEN is required for standalone Runtime Host.",
  );
  const desktopRendererToken = optionalSecret(
    environment.AGENT_WORKSPACE_RUNTIME_DESKTOP_TOKEN,
    "AGENT_WORKSPACE_RUNTIME_DESKTOP_TOKEN is invalid.",
  );
  const evidenceToken = optionalSecret(
    environment.AGENT_WORKSPACE_RUNTIME_EVIDENCE_TOKEN,
    "AGENT_WORKSPACE_RUNTIME_EVIDENCE_TOKEN is invalid.",
  ) ?? randomBytes(32).toString("base64url");
  if (new Set([rendererToken, evidenceToken, ...(desktopRendererToken ? [desktopRendererToken] : [])]).size
    !== (desktopRendererToken ? 3 : 2)) {
    throw new Error("AGENT_WORKSPACE_RUNTIME bridge tokens must be distinct.");
  }
  return Object.freeze({
    runtimeDataPath,
    authenticatedUserId,
    rendererToken,
    ...(desktopRendererToken ? { desktopRendererToken } : {}),
    evidenceToken,
    allowedOrigins: parseAllowedOrigins(environment.AGENT_WORKSPACE_RUNTIME_ALLOWED_ORIGINS),
    workspaceBootstrapGrants: parseWorkspaceBootstrapGrants(environment.AGENT_WORKSPACE_WORKSPACE_CONFIG),
    port: runtimePort(environment.AGENT_WORKSPACE_RUNTIME_PORT),
  });
}

export async function startSessionIdProductionRuntimeHost(
  environment: NodeJS.ProcessEnv = process.env,
  hooks: SessionIdProductionRuntimeHostHooks = Object.freeze({}),
): Promise<Readonly<{ close(): Promise<void>; url: string; port: number }>> {
  const configuration = loadSessionIdProductionRuntimeEnvironment(environment);
  assertAcpHostEpochSupervisorEnvironmentConfigured(environment);
  const runtimeDataPath = ensureOwnedRuntimeDataDirectory(configuration.runtimeDataPath);
  const providerSettings = createSessionIdAcpProviderSettingsHost({
    runtimeDataDirectory: runtimeDataPath,
    environment,
  });
  const effectiveEnvironment = providerSettings.effectiveEnvironment();
  const acpConfiguration = loadAcpProductionConfigurationFromEnvironment(effectiveEnvironment);
  const acpHostInputs = Object.freeze({
    openCode: () => currentProviderHostInputs().openCode(),
    codex: () => currentProviderHostInputs().codex(),
    claudeCode: () => currentProviderHostInputs().claudeCode(),
    toJSON: () => Object.freeze({ kind: "acp_production_host_inputs" as const }),
  });
  const privateAuthority = createAcpRuntimeHostPrivateAuthority({
    runtimeDataDirectory: runtimeDataPath,
    environment: effectiveEnvironment,
  });
  let privateAuthorityTransferred = false;
  let host: Awaited<ReturnType<typeof createSessionIdUnifiedRuntimeHost>>;
  try {
    host = await createSessionIdUnifiedRuntimeHost({
      databasePath: path.join(runtimeDataPath, "runtime.sqlite"),
      authenticatedUserId: configuration.authenticatedUserId,
      workspaceBootstrapGrants: configuration.workspaceBootstrapGrants,
      metaReadinessProbeTimeoutMs: DEFAULT_META_READINESS_PROBE_TIMEOUT_MS,
      authorizeRetiringBindingRecovery: privateAuthority.authorizeRetiringBindingRecovery,
      ...(hooks.onDiagnostic ? { onDiagnostic: hooks.onDiagnostic } : {}),
      createProviderOwner: async (input) => {
        const owner = await createSessionIdAcpProductionProviderOwner({
          input,
          privateAuthority,
          configuration: acpConfiguration,
          hostInputs: acpHostInputs,
          providerSettings,
          retainPrivateAuthority: () => { privateAuthorityTransferred = true; },
          ...(hooks.onHumanOnlyDiagnostic
            ? { onHumanOnlyDiagnostic: hooks.onHumanOnlyDiagnostic }
            : {}),
          ...(hooks.onDiagnostic ? { onDiagnostic: hooks.onDiagnostic } : {}),
        });
        privateAuthorityTransferred = true;
        return owner;
      },
    });
  } catch (error) {
    if (!privateAuthorityTransferred) privateAuthority.close();
    throw error;
  }
  const bridge = createSessionIdUnifiedRuntimeBridgeServer({
    host,
    rendererToken: configuration.rendererToken,
    ...(configuration.desktopRendererToken
      ? { desktopRendererToken: configuration.desktopRendererToken }
      : {}),
    evidenceToken: configuration.evidenceToken,
    allowedOrigins: configuration.allowedOrigins,
    authorizeTask: (taskId, authenticatedUserId) => authenticatedUserId === host.authenticatedUserId
      && host.readWorkspace().tasks.some((task) => task.taskId === taskId),
    authorizeCommand: (_command, authenticatedUserId) => authenticatedUserId === host.authenticatedUserId,
  });
  try {
    const address = await bridge.listen(configuration.port, "127.0.0.1");
    let closePromise: Promise<void> | undefined;
  return Object.freeze({
      ...address,
      close(): Promise<void> {
        return closePromise ??= closeOwnedRuntime();
      },
    });

    async function closeOwnedRuntime(): Promise<void> {
        let bridgeFailure: unknown;
        try {
          await bridge.close();
        } catch (error) {
          bridgeFailure = error;
        }
        try {
          await host.close();
        } catch (error) {
          throw error;
        }
        if (bridgeFailure) throw bridgeFailure;
    }
  } catch (error) {
    try {
      await host.close();
    } catch (cleanupError) {
      throw cleanupError;
    }
    throw error;
  }

  function currentProviderHostInputs() {
    const currentEnvironment = providerSettings.effectiveEnvironment();
    const currentConfiguration = loadAcpProductionConfigurationFromEnvironment(currentEnvironment);
    return createAcpProductionHostInputs(currentConfiguration, currentEnvironment);
  }
}

async function main(): Promise<void> {
  const runtime = await startSessionIdProductionRuntimeHost();
  process.stdout.write(`${JSON.stringify({ type: "runtime_host_ready", url: runtime.url, port: runtime.port })}\n`);
  let closing: Promise<void> | undefined;
  const close = () => closing ??= runtime.close();
  const terminate = () => {
    void close().then(
      () => process.exit(0),
      (error: unknown) => {
        process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
        process.exit(1);
      },
    );
  };
  process.once("SIGINT", terminate);
  process.once("SIGTERM", terminate);
}

function runtimeDirectory(value: string | undefined): string {
  if (value !== undefined && value.trim()) {
    const configured = value.trim();
    if (!path.isAbsolute(configured)) throw new Error("AGENT_WORKSPACE_RUNTIME_DATA_DIR must be absolute.");
    return path.resolve(configured);
  }
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", ".agent-workspace-v2", "runtime");
}

function ensureOwnedRuntimeDataDirectory(directory: string): string {
  const requested = path.resolve(directory);
  try {
    mkdirSync(requested, { recursive: true, mode: 0o700 });
    const before = lstatSync(requested);
    if (!before.isDirectory() || before.isSymbolicLink()
      || (typeof process.getuid === "function" && before.uid !== process.getuid())) {
      throw new Error("unsafe");
    }
    if ((before.mode & 0o777) !== 0o700) chmodSync(requested, 0o700);
    const after = lstatSync(requested);
    if (!after.isDirectory() || after.isSymbolicLink() || (after.mode & 0o777) !== 0o700
      || after.dev !== before.dev || after.ino !== before.ino) {
      throw new Error("unsafe");
    }
    return realpathSync(requested);
  } catch {
    throw new Error("AGENT_WORKSPACE_RUNTIME_DATA_DIR is unsafe.");
  }
}

function ownerId(value: string | undefined): string {
  const normalized = value?.trim() || DEFAULT_OWNER_ID;
  if (!OWNER_ID.test(normalized)) throw new Error("AGENT_WORKSPACE_OWNER_ID is invalid.");
  return normalized;
}

function runtimePort(value: string | undefined): number {
  if (value === undefined || !value.trim()) return 0;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 65_535) {
    throw new Error("AGENT_WORKSPACE_RUNTIME_PORT is invalid.");
  }
  return parsed;
}

function requiredSecret(value: string | undefined, message: string): string {
  const secret = optionalSecret(value, message);
  if (!secret) throw new Error(message);
  return secret;
}

function optionalSecret(value: string | undefined, message: string): string | undefined {
  if (value === undefined || !value.trim()) return undefined;
  const secret = value.trim();
  if (secret.length < 16 || /\s/u.test(secret)) throw new Error(message);
  return secret;
}

function parseAllowedOrigins(serialized: string | undefined): readonly string[] {
  if (serialized === undefined || !serialized.trim()) return Object.freeze([]);
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw new Error("AGENT_WORKSPACE_RUNTIME_ALLOWED_ORIGINS is invalid JSON.");
  }
  if (!Array.isArray(value)) throw new Error("AGENT_WORKSPACE_RUNTIME_ALLOWED_ORIGINS must be a JSON array.");
  const origins = value.map((candidate) => {
    if (typeof candidate !== "string" || !candidate.trim()) {
      throw new Error("AGENT_WORKSPACE_RUNTIME_ALLOWED_ORIGINS contains an invalid origin.");
    }
    const url = new URL(candidate.trim());
    if ((url.protocol !== "http:" && url.protocol !== "https:")
      || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
      throw new Error("AGENT_WORKSPACE_RUNTIME_ALLOWED_ORIGINS contains an invalid origin.");
    }
    return url.origin;
  });
  if (new Set(origins).size !== origins.length) {
    throw new Error("AGENT_WORKSPACE_RUNTIME_ALLOWED_ORIGINS contains duplicates.");
  }
  return Object.freeze(origins);
}

function parseWorkspaceBootstrapGrants(serialized: string | undefined): readonly SessionIdProductionWorkspaceGrant[] {
  if (serialized === undefined || !serialized.trim()) return Object.freeze([]);
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw new Error("AGENT_WORKSPACE_WORKSPACE_CONFIG is invalid JSON.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("AGENT_WORKSPACE_WORKSPACE_CONFIG is invalid.");
  }
  const root = value as Record<string, unknown>;
  if (Object.keys(root).length !== 2 || root.schemaVersion !== 1 || !Array.isArray(root.grants)) {
    throw new Error("AGENT_WORKSPACE_WORKSPACE_CONFIG is invalid.");
  }
  const seen = new Set<string>();
  const grants = root.grants.map((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new Error("AGENT_WORKSPACE_WORKSPACE_CONFIG contains an invalid grant.");
    }
    const grant = candidate as Record<string, unknown>;
    const allowedKeys = new Set(["workspaceId", "directory", "displayName"]);
    if (Object.keys(grant).some((key) => !allowedKeys.has(key))) {
      throw new Error("AGENT_WORKSPACE_WORKSPACE_CONFIG contains an invalid grant.");
    }
    const workspaceId = requiredText(grant.workspaceId, "workspaceId");
    const directory = requiredText(grant.directory, "directory");
    if (!path.isAbsolute(directory) || seen.has(workspaceId)) {
      throw new Error("AGENT_WORKSPACE_WORKSPACE_CONFIG contains an invalid grant.");
    }
    seen.add(workspaceId);
    const displayName = grant.displayName === undefined ? undefined : requiredText(grant.displayName, "displayName");
    const identity = createHash("sha256").update(JSON.stringify({ workspaceId, directory, displayName })).digest("hex").slice(0, 24);
    return Object.freeze({
      commandId: `command_workspace_bootstrap_${identity}`,
      workspaceId,
      directory: path.resolve(directory),
      ...(displayName ? { displayName } : {}),
    });
  });
  return Object.freeze(grants);
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 1_024) {
    throw new Error(`AGENT_WORKSPACE_WORKSPACE_CONFIG ${field} is invalid.`);
  }
  return value.trim();
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  void main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

import { spawn as nodeSpawn } from "node:child_process";
import { constants as fsConstants, createReadStream } from "node:fs";
import { access, chmod, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { isAbsolute, join } from "node:path";
import type { Readable, Writable } from "node:stream";
import type { ProtocolPin } from "@agent-workspace/provider-port";
import {
  CODEX_META_APP_SERVER_PROTOCOL_0_146,
  CODEX_META_BINARY_SHA256_0_146,
  CODEX_META_LAUNCH_ARGUMENTS_0_146,
  CODEX_META_NO_TOOL_ATTESTATION_0_146,
  type CodexAppServerConnection,
  type CodexAppServerInboundMessage,
  type CodexAppServerJsonRpcId,
  type CodexMetaAppServerConnectionFactory,
  type CodexMetaAppServerConnectionInput,
  type CodexMetaNoToolProcessAttestation,
} from "@agent-workspace/provider-codex";
import {
  createCodexAppServerProtocolProbe,
  type CodexAppServerProtocolProbe,
} from "./codex-app-server-bridge.js";

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const MAX_JSON_LINE_BYTES = 4 * 1024 * 1024;
const CHILD_TERMINATION_GRACE_MS = 1_000;
const CHILD_KILL_CONFIRMATION_MS = 1_000;

const CONFIGURABLE_ENVIRONMENT_KEYS = new Set([
  "ALL_PROXY",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "LANG",
  "LC_ALL",
  "NO_PROXY",
  "OPENAI_API_KEY",
  "SSL_CERT_DIR",
  "SSL_CERT_FILE",
]);

const GENERATED_ENVIRONMENT_KEYS = new Set(["CODEX_HOME", "HOME", "TMPDIR"]);

export type CodexMetaAppServerClientInfo = Readonly<{
  readonly name: string;
  readonly title?: string;
  readonly version: string;
}>;

export type CodexMetaAppServerSpawnOptions = Readonly<{
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly shell: false;
  readonly windowsHide: true;
  readonly stdio: readonly ["pipe", "pipe", "pipe"];
}>;

export interface CodexMetaAppServerChild {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  once(event: "error", listener: (error: Error) => void): unknown;
  once(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
}

export type CodexMetaAppServerSpawn = (
  command: string,
  args: readonly string[],
  options: CodexMetaAppServerSpawnOptions,
) => CodexMetaAppServerChild;

export interface CodexMetaBinaryInspector {
  inspect(command: string): Promise<Readonly<{ readonly sha256: string }>>;
}

export type CodexMetaAppServerBridgeOptions = Readonly<{
  /** Absolute path to the exact attested 0.146.0 executable. */
  readonly command: string;
  /** Host-owned private root. No Task/workspace path is accepted. */
  readonly runtimeDataDirectory: string;
  /** Explicit, small allowlist. process.env is never merged into a child. */
  readonly environment?: Readonly<Record<string, string>>;
  readonly requestTimeoutMs?: number;
  readonly clientInfo?: CodexMetaAppServerClientInfo;
  readonly spawn?: CodexMetaAppServerSpawn;
  readonly protocolProbe?: CodexAppServerProtocolProbe;
  /** Test seam; production always hashes and checks executable permission. */
  readonly binaryInspector?: CodexMetaBinaryInspector;
}>;

/** Safe code only; native stderr, paths, credentials and provider text are never embedded. */
export class CodexMetaAppServerBridgeError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "CodexMetaAppServerBridgeError";
    this.code = code;
  }
}

/**
 * Dedicated no-tool Codex 0.146 Meta connection factory. Every inspection and
 * every turn receives a new private process directory beneath Runtime data.
 * Nothing from a Task, workspace, user HOME, or process.env reaches Codex.
 */
export function createCodexMetaAppServerConnectionFactory(
  options: CodexMetaAppServerBridgeOptions,
): CodexMetaAppServerConnectionFactory {
  const config = normalizeOptions(options);
  let protocolInspection: Promise<ProtocolPin> | undefined;

  return Object.freeze({
    inspectProtocol(): Promise<ProtocolPin> {
      protocolInspection ??= inspectProtocol(config);
      return protocolInspection;
    },
    async inspectNoToolConfiguration(): Promise<CodexMetaNoToolProcessAttestation> {
      await verifyBinary(config);
      return CODEX_META_NO_TOOL_ATTESTATION_0_146;
    },
    async create(input: CodexMetaAppServerConnectionInput): Promise<CodexAppServerConnection> {
      // All caller-controlled identity and policy checks precede directory or
      // child-process effects. A Task-shaped payload is rejected as unknown data.
      assertConnectionInput(input);
      await (protocolInspection ??= inspectProtocol(config));
      // Re-hash immediately before this process is created; a prior capability
      // inspection is not authority to run a subsequently replaced executable.
      await verifyBinary(config);

      const isolated = await createIsolatedProcessEnvironment(config);
      let connection: CodexMetaProcessConnection | undefined;
      try {
        const child = spawnMetaChild(config, isolated);
        connection = new CodexMetaProcessConnection(child, config.requestTimeoutMs, isolated.cleanup);
        await initialize(connection, config.clientInfo, isolated.codexHome);
        return connection;
      } catch (error) {
        if (connection) await cleanupOrThrow(() => connection!.close());
        else await cleanupOrThrow(isolated.cleanup);
        if (error instanceof CodexMetaAppServerBridgeError) throw error;
        throw new CodexMetaAppServerBridgeError("codex_meta_app_server_spawn_failed");
      }
    },
  });
}

export function createCodexMetaBinaryInspector(): CodexMetaBinaryInspector {
  return Object.freeze({
    async inspect(command: string): Promise<Readonly<{ readonly sha256: string }>> {
      try {
        await access(command, fsConstants.X_OK);
        const metadata = await stat(command);
        if (!metadata.isFile()) throw new Error("not_file");
        const hash = createHash("sha256");
        for await (const chunk of createReadStream(command)) hash.update(chunk as Buffer);
        return Object.freeze({ sha256: hash.digest("hex") });
      } catch {
        throw new CodexMetaAppServerBridgeError("codex_meta_binary_unavailable");
      }
    },
  });
}

type NormalizedOptions = Readonly<{
  readonly command: string;
  readonly runtimeDataDirectory: string;
  readonly processDirectory: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly requestTimeoutMs: number;
  readonly clientInfo: CodexMetaAppServerClientInfo;
  readonly spawn: CodexMetaAppServerSpawn;
  readonly protocolProbe: CodexAppServerProtocolProbe;
  readonly binaryInspector: CodexMetaBinaryInspector;
}>;

type IsolatedProcessEnvironment = Readonly<{
  readonly root: string;
  readonly cwd: string;
  readonly codexHome: string;
  readonly protocolDirectory: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly cleanup: () => Promise<void>;
}>;

function normalizeOptions(options: CodexMetaAppServerBridgeOptions): NormalizedOptions {
  assertAbsolutePath(options?.command, "codex_meta_command_must_be_absolute");
  assertAbsolutePath(options?.runtimeDataDirectory, "codex_meta_runtime_data_directory_invalid");
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > 120_000) {
    throw new CodexMetaAppServerBridgeError("codex_meta_request_timeout_invalid");
  }
  const environment = normalizeEnvironment(options.environment ?? {});
  const clientInfo = Object.freeze({
    name: requiredText(options.clientInfo?.name ?? "agent-workspace-meta", "codex_meta_client_name_invalid"),
    title: requiredText(options.clientInfo?.title ?? "Agent Workspace Meta", "codex_meta_client_title_invalid"),
    version: requiredText(options.clientInfo?.version ?? "1", "codex_meta_client_version_invalid"),
  });
  return Object.freeze({
    command: options.command,
    runtimeDataDirectory: options.runtimeDataDirectory,
    processDirectory: join(options.runtimeDataDirectory, "meta-provider", "codex", "processes"),
    environment,
    requestTimeoutMs,
    clientInfo,
    spawn: options.spawn ?? defaultSpawn,
    protocolProbe: options.protocolProbe ?? createCodexAppServerProtocolProbe(),
    binaryInspector: options.binaryInspector ?? createCodexMetaBinaryInspector(),
  });
}

function normalizeEnvironment(value: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CodexMetaAppServerBridgeError("codex_meta_environment_invalid");
  }
  const copied: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [key, candidate] of Object.entries(value)) {
    if (!CONFIGURABLE_ENVIRONMENT_KEYS.has(key)
      || GENERATED_ENVIRONMENT_KEYS.has(key)
      || typeof candidate !== "string"
      || candidate.length === 0
      || candidate.includes("\0")) {
      throw new CodexMetaAppServerBridgeError("codex_meta_environment_invalid");
    }
    copied[key] = candidate;
  }
  return Object.freeze(copied);
}

async function inspectProtocol(config: NormalizedOptions): Promise<ProtocolPin> {
  await verifyBinary(config);
  const isolated = await createIsolatedProcessEnvironment(config);
  try {
    const observed = await config.protocolProbe.inspect({
      command: config.command,
      cwd: isolated.cwd,
      environment: isolated.environment,
      protocolDirectory: isolated.protocolDirectory,
      expectedProtocol: CODEX_META_APP_SERVER_PROTOCOL_0_146,
      timeoutMs: config.requestTimeoutMs,
    });
    if (!sameProtocol(observed, CODEX_META_APP_SERVER_PROTOCOL_0_146)) {
      throw new CodexMetaAppServerBridgeError("codex_meta_protocol_pin_mismatch");
    }
    return CODEX_META_APP_SERVER_PROTOCOL_0_146;
  } catch (error) {
    if (error instanceof CodexMetaAppServerBridgeError) throw error;
    throw new CodexMetaAppServerBridgeError("codex_meta_protocol_unavailable");
  } finally {
    await cleanupOrThrow(isolated.cleanup);
  }
}

async function verifyBinary(config: NormalizedOptions): Promise<void> {
  let observed: Readonly<{ readonly sha256: string }>;
  try {
    observed = await config.binaryInspector.inspect(config.command);
  } catch (error) {
    if (error instanceof CodexMetaAppServerBridgeError) throw error;
    throw new CodexMetaAppServerBridgeError("codex_meta_binary_unavailable");
  }
  if (observed.sha256.toLowerCase() !== CODEX_META_BINARY_SHA256_0_146) {
    throw new CodexMetaAppServerBridgeError("codex_meta_binary_sha256_mismatch");
  }
}

async function createIsolatedProcessEnvironment(config: NormalizedOptions): Promise<IsolatedProcessEnvironment> {
  let root: string | undefined;
  try {
    await mkdir(config.processDirectory, { recursive: true, mode: 0o700 });
    await chmod(config.processDirectory, 0o700);
    root = await mkdtemp(join(config.processDirectory, "codex-meta-"));
    await chmod(root, 0o700);
    const cwd = join(root, "cwd");
    const codexHome = join(root, "codex-home");
    const tmp = join(root, "tmp");
    const protocolDirectory = join(root, "protocol");
    await Promise.all([
      mkdir(cwd, { mode: 0o700 }),
      mkdir(codexHome, { mode: 0o700 }),
      mkdir(tmp, { mode: 0o700 }),
      mkdir(protocolDirectory, { mode: 0o700 }),
    ]);
    const environment = Object.freeze({
      ...config.environment,
      CODEX_HOME: codexHome,
      HOME: codexHome,
      TMPDIR: tmp,
    });
    let cleaned = false;
    const cleanup = async (): Promise<void> => {
      if (cleaned) return;
      cleaned = true;
      try {
        await rm(root!, { recursive: true, force: true, maxRetries: 2 });
      } catch {
        throw new CodexMetaAppServerBridgeError("codex_meta_process_directory_cleanup_failed");
      }
    };
    return Object.freeze({ root, cwd, codexHome, protocolDirectory, environment, cleanup });
  } catch (error) {
    if (root) {
      try { await rm(root, { recursive: true, force: true, maxRetries: 2 }); } catch { /* normalized below */ }
    }
    if (error instanceof CodexMetaAppServerBridgeError) throw error;
    throw new CodexMetaAppServerBridgeError("codex_meta_process_directory_create_failed");
  }
}

function spawnMetaChild(config: NormalizedOptions, isolated: IsolatedProcessEnvironment): CodexMetaAppServerChild {
  try {
    return config.spawn(config.command, CODEX_META_LAUNCH_ARGUMENTS_0_146, {
      cwd: isolated.cwd,
      env: isolated.environment,
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch {
    throw new CodexMetaAppServerBridgeError("codex_meta_app_server_spawn_failed");
  }
}

async function initialize(
  connection: CodexMetaProcessConnection,
  clientInfo: CodexMetaAppServerClientInfo,
  expectedCodexHome: string,
): Promise<void> {
  const result = await connection.request<unknown>("initialize", {
    clientInfo: {
      name: clientInfo.name,
      title: clientInfo.title ?? null,
      version: clientInfo.version,
    },
    capabilities: {
      experimentalApi: true,
      requestAttestation: false,
    },
  });
  const record = asRecord(result);
  requiredText(record?.userAgent, "codex_meta_initialize_invalid");
  if (record?.codexHome !== expectedCodexHome) {
    throw new CodexMetaAppServerBridgeError("codex_meta_initialize_codex_home_mismatch");
  }
  requiredText(record?.platformFamily, "codex_meta_initialize_invalid");
  requiredText(record?.platformOs, "codex_meta_initialize_invalid");
}

function assertConnectionInput(value: CodexMetaAppServerConnectionInput): void {
  const root = exactRecord(value, ["metaTurnId", "noToolAttestation", "profile", "protocol"], "codex_meta_connection_input_invalid");
  requiredText(root.metaTurnId, "codex_meta_turn_id_invalid");
  if (!sameProtocol(root.protocol, CODEX_META_APP_SERVER_PROTOCOL_0_146)) {
    throw new CodexMetaAppServerBridgeError("codex_meta_protocol_pin_mismatch");
  }
  if (!sameAttestation(root.noToolAttestation)) {
    throw new CodexMetaAppServerBridgeError("codex_meta_no_tool_attestation_mismatch");
  }
  const profile = exactRecord(root.profile, [
    "capabilityPolicy",
    "metaProfileId",
    "model",
    "protocolFingerprint",
    "provider",
    "providerVersion",
  ], "codex_meta_profile_invalid");
  requiredText(profile.metaProfileId, "codex_meta_profile_invalid");
  requiredText(profile.model, "codex_meta_profile_invalid");
  if (profile.provider !== "codex"
    || profile.providerVersion !== CODEX_META_APP_SERVER_PROTOCOL_0_146.providerVersion
    || profile.protocolFingerprint !== CODEX_META_APP_SERVER_PROTOCOL_0_146.protocolFingerprint) {
    throw new CodexMetaAppServerBridgeError("codex_meta_profile_pin_mismatch");
  }
  const policy = exactRecord(profile.capabilityPolicy, [
    "allowedTools",
    "maxConcurrentTurns",
    "maxNativeChildren",
    "permissionMode",
    "requiredCapabilities",
  ], "codex_meta_profile_policy_invalid");
  if (!Array.isArray(policy.requiredCapabilities)
    || policy.requiredCapabilities.length !== 0
    || !Array.isArray(policy.allowedTools)
    || policy.allowedTools.length !== 0
    || policy.permissionMode !== "deny"
    || policy.maxConcurrentTurns !== 1
    || policy.maxNativeChildren !== 0) {
    throw new CodexMetaAppServerBridgeError("codex_meta_profile_policy_invalid");
  }
}

function sameAttestation(value: unknown): boolean {
  const root = asRecord(value);
  const initialization = asRecord(root?.initializationCapabilities);
  const protocol = asRecord(root?.protocol);
  const launchArguments = root?.launchArguments;
  return hasExactKeys(root, [
    "binarySha256",
    "hostPrivateCwd",
    "inheritedEnvironment",
    "initializationCapabilities",
    "isolatedCodexHome",
    "launchArguments",
    "protocol",
  ])
    && hasExactKeys(protocol, ["protocolFingerprint", "providerVersion"])
    && hasExactKeys(initialization, ["experimentalApi", "requestAttestation"])
    && root?.binarySha256 === CODEX_META_BINARY_SHA256_0_146
    && sameProtocol(protocol, CODEX_META_APP_SERVER_PROTOCOL_0_146)
    && Array.isArray(launchArguments)
    && launchArguments.length === CODEX_META_LAUNCH_ARGUMENTS_0_146.length
    && launchArguments.every((entry, index) => entry === CODEX_META_LAUNCH_ARGUMENTS_0_146[index])
    && initialization?.experimentalApi === true
    && initialization.requestAttestation === false
    && root.inheritedEnvironment === false
    && root.isolatedCodexHome === true
    && root.hostPrivateCwd === true;
}

function sameProtocol(value: unknown, expected: ProtocolPin): boolean {
  const record = asRecord(value);
  return hasExactKeys(record, ["protocolFingerprint", "providerVersion"])
    && record?.providerVersion === expected.providerVersion
    && record.protocolFingerprint === expected.protocolFingerprint;
}

function hasExactKeys(record: Record<string, unknown> | undefined, keys: readonly string[]): boolean {
  return record !== undefined
    && Object.keys(record).length === keys.length
    && Object.keys(record).every((key) => keys.includes(key));
}

const defaultSpawn: CodexMetaAppServerSpawn = (command, args, options) => nodeSpawn(command, [...args], {
  cwd: options.cwd,
  env: options.env,
  shell: false,
  windowsHide: true,
  stdio: ["pipe", "pipe", "pipe"],
}) as unknown as CodexMetaAppServerChild;

class CodexMetaProcessConnection implements CodexAppServerConnection {
  readonly instanceId = `codex_meta_app_server_${randomUUID()}`;
  readonly #child: CodexMetaAppServerChild;
  readonly #requestTimeoutMs: number;
  readonly #cleanup: () => Promise<void>;
  readonly #events = new InboundQueue();
  readonly #pending = new Map<string, PendingRequest>();
  readonly #declinedServerRequests = new Set<string>();
  readonly #childClosePromise: Promise<void>;
  #nextId = 0;
  #buffer = "";
  #closed = false;
  #childClosed = false;
  #resolveChildClose: (() => void) | undefined;
  #cleanupPromise: Promise<void> | undefined;
  #closePromise: Promise<void> | undefined;

  constructor(child: CodexMetaAppServerChild, requestTimeoutMs: number, cleanup: () => Promise<void>) {
    this.#child = child;
    this.#requestTimeoutMs = requestTimeoutMs;
    this.#cleanup = cleanup;
    this.#childClosePromise = new Promise((resolve) => {
      this.#resolveChildClose = resolve;
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string | Buffer) => this.#onData(typeof chunk === "string" ? chunk : chunk.toString("utf8")));
    // Native diagnostics may contain account or installation data. Drain only.
    child.stderr.resume();
    child.once("error", () => this.#fail("codex_meta_app_server_spawn_failed"));
    child.once("close", () => {
      this.#childClosed = true;
      this.#resolveChildClose?.();
      this.#resolveChildClose = undefined;
      this.#fail("codex_meta_app_server_connection_closed");
      void this.#cleanupOnce().catch(() => undefined);
    });
  }

  async request<T = unknown>(method: string, params: unknown): Promise<T> {
    if (this.#closed) throw new CodexMetaAppServerBridgeError("codex_meta_app_server_connection_closed");
    const id = ++this.#nextId;
    const key = requestKey(id);
    const result = new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(key);
        reject(new CodexMetaAppServerBridgeError("codex_meta_app_server_request_timeout"));
      }, this.#requestTimeoutMs);
      timeout.unref();
      this.#pending.set(key, { resolve: resolve as (value: unknown) => void, reject, timeout });
    });
    try {
      await this.#write({ jsonrpc: "2.0", id, method: requiredText(method, "codex_meta_app_server_method_invalid"), params });
    } catch {
      const pending = this.#pending.get(key);
      this.#pending.delete(key);
      if (pending) {
        clearTimeout(pending.timeout);
        pending.reject(new CodexMetaAppServerBridgeError("codex_meta_app_server_stdin_failed"));
      }
    }
    return result;
  }

  events(): AsyncIterable<CodexAppServerInboundMessage> {
    return this.#events.subscribe();
  }

  respond(id: CodexAppServerJsonRpcId, result: unknown): Promise<void> {
    if (!isJsonRpcId(id)) return Promise.reject(new CodexMetaAppServerBridgeError("codex_meta_app_server_response_id_invalid"));
    // The bridge has already declined every server request before exposing it.
    if (this.#declinedServerRequests.has(requestKey(id))) return Promise.resolve();
    return this.#write({ jsonrpc: "2.0", id, result });
  }

  async close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#closePromise = (async () => {
      this.#fail("codex_meta_app_server_connection_closed");
      await this.#terminateChild();
      await this.#cleanupOnce();
    })();
    return this.#closePromise;
  }

  async #terminateChild(): Promise<void> {
    if (this.#childClosed) return;
    try { this.#child.kill("SIGTERM"); } catch { /* escalate after the bounded grace period */ }
    if (await this.#waitForChildClose(CHILD_TERMINATION_GRACE_MS)) return;
    try { this.#child.kill("SIGKILL"); } catch { /* cleanup follows the bounded kill confirmation period */ }
    await this.#waitForChildClose(CHILD_KILL_CONFIRMATION_MS);
  }

  async #waitForChildClose(timeoutMs: number): Promise<boolean> {
    if (this.#childClosed) return true;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timedOut = await Promise.race([
      this.#childClosePromise.then(() => false),
      new Promise<true>((resolve) => {
        timeout = setTimeout(() => resolve(true), timeoutMs);
        timeout.unref();
      }),
    ]);
    if (timeout) clearTimeout(timeout);
    return !timedOut || this.#childClosed;
  }

  async #cleanupOnce(): Promise<void> {
    this.#cleanupPromise ??= this.#cleanup();
    return this.#cleanupPromise;
  }

  async #write(value: unknown): Promise<void> {
    let line: string;
    try {
      line = `${JSON.stringify(value)}\n`;
    } catch {
      throw new CodexMetaAppServerBridgeError("codex_meta_app_server_message_not_json");
    }
    await new Promise<void>((resolve, reject) => {
      this.#child.stdin.write(line, (error?: Error | null) => {
        if (error) reject(new CodexMetaAppServerBridgeError("codex_meta_app_server_stdin_failed"));
        else resolve();
      });
    });
  }

  #onData(chunk: string): void {
    if (this.#closed) return;
    this.#buffer += chunk;
    if (Buffer.byteLength(this.#buffer, "utf8") > MAX_JSON_LINE_BYTES) {
      this.#fail("codex_meta_app_server_message_too_large");
      return;
    }
    while (true) {
      const newline = this.#buffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.#buffer.slice(0, newline).replace(/\r$/, "");
      this.#buffer = this.#buffer.slice(newline + 1);
      if (!line.trim()) continue;
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        this.#fail("codex_meta_app_server_invalid_json");
        return;
      }
      this.#handleMessage(message);
      if (this.#closed) return;
    }
  }

  #handleMessage(value: unknown): void {
    const record = asRecord(value);
    if (!record) return this.#fail("codex_meta_app_server_message_invalid");
    const id = record.id;
    const method = typeof record.method === "string" ? record.method : undefined;
    if (isJsonRpcId(id) && ("result" in record || "error" in record)) {
      const key = requestKey(id);
      const pending = this.#pending.get(key);
      if (!pending) return;
      this.#pending.delete(key);
      clearTimeout(pending.timeout);
      if ("error" in record && record.error !== undefined && record.error !== null) {
        pending.reject(new CodexMetaAppServerBridgeError(jsonRpcErrorCode(record.error)));
      } else {
        pending.resolve(record.result);
      }
      return;
    }
    if (!method) return this.#fail("codex_meta_app_server_message_invalid");
    const emittedAtMs = typeof record.emittedAtMs === "number" && Number.isFinite(record.emittedAtMs)
      ? record.emittedAtMs
      : undefined;
    if (isJsonRpcId(id)) {
      const key = requestKey(id);
      this.#declinedServerRequests.add(key);
      // Decline before the adapter can observe the unexpected request. It will
      // then fail the Meta turn; its second decline is an idempotent no-op here.
      void this.#write({ jsonrpc: "2.0", id, result: { decision: "decline" } })
        .catch(() => this.#fail("codex_meta_app_server_stdin_failed"));
      this.#events.push({
        kind: "server_request",
        method,
        params: record.params,
        id,
        ...(emittedAtMs === undefined ? {} : { emittedAtMs }),
      });
      return;
    }
    this.#events.push({
      kind: "notification",
      method,
      params: record.params,
      ...(emittedAtMs === undefined ? {} : { emittedAtMs }),
    });
  }

  #fail(code: string): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new CodexMetaAppServerBridgeError(code));
    }
    this.#pending.clear();
    this.#events.close();
  }
}

type PendingRequest = Readonly<{
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timeout: ReturnType<typeof setTimeout>;
}>;

function requestKey(value: CodexAppServerJsonRpcId): string {
  return `${typeof value}:${String(value)}`;
}

function isJsonRpcId(value: unknown): value is CodexAppServerJsonRpcId {
  return (typeof value === "string" && value.length > 0)
    || (typeof value === "number" && Number.isFinite(value));
}

function jsonRpcErrorCode(value: unknown): string {
  const code = asRecord(value)?.code;
  return typeof code === "number" && Number.isSafeInteger(code)
    ? `codex_meta_app_server_rpc_${code}`
    : "codex_meta_app_server_rpc_error";
}

function exactRecord(value: unknown, keys: readonly string[], code: string): Record<string, unknown> {
  const record = asRecord(value);
  if (!record || Object.keys(record).some((key) => !keys.includes(key))) {
    throw new CodexMetaAppServerBridgeError(code);
  }
  return record;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function assertAbsolutePath(value: unknown, code: string): asserts value is string {
  if (typeof value !== "string" || !isAbsolute(value)) throw new CodexMetaAppServerBridgeError(code);
}

function requiredText(value: unknown, code: string): string {
  if (typeof value !== "string" || !value.trim()) throw new CodexMetaAppServerBridgeError(code);
  return value;
}

async function cleanupOrThrow(cleanup: () => Promise<void>): Promise<void> {
  try {
    await cleanup();
  } catch (error) {
    if (error instanceof CodexMetaAppServerBridgeError) throw error;
    throw new CodexMetaAppServerBridgeError("codex_meta_process_directory_cleanup_failed");
  }
}

class InboundQueue {
  readonly #items: CodexAppServerInboundMessage[] = [];
  #waiter: ((result: IteratorResult<CodexAppServerInboundMessage>) => void) | undefined;
  #active = false;
  #closed = false;

  push(value: CodexAppServerInboundMessage): void {
    if (this.#closed) return;
    const waiter = this.#waiter;
    if (waiter) {
      this.#waiter = undefined;
      waiter({ done: false, value });
      return;
    }
    this.#items.push(value);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    const waiter = this.#waiter;
    this.#waiter = undefined;
    waiter?.({ done: true, value: undefined });
  }

  subscribe(): AsyncIterable<CodexAppServerInboundMessage> {
    if (this.#active) throw new CodexMetaAppServerBridgeError("codex_meta_app_server_observer_already_active");
    this.#active = true;
    const queue = this;
    return {
      [Symbol.asyncIterator](): AsyncIterator<CodexAppServerInboundMessage> {
        return {
          next: () => queue.#next(),
          return: async () => {
            queue.#active = false;
            const waiter = queue.#waiter;
            queue.#waiter = undefined;
            waiter?.({ done: true, value: undefined });
            return { done: true, value: undefined };
          },
        };
      },
    };
  }

  #next(): Promise<IteratorResult<CodexAppServerInboundMessage>> {
    const value = this.#items.shift();
    if (value) return Promise.resolve({ done: false, value });
    if (this.#closed) return Promise.resolve({ done: true, value: undefined });
    return new Promise((resolve) => { this.#waiter = resolve; });
  }
}
